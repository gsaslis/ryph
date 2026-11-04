// The service's wiring, one instance per process: the stored recipes on one side, the mounted
// @ryph/webhooks mailroom and the orchestrator-facing sink on the other. `setup()` builds
// the seam and starts nothing — the composition root owns every timer, exactly as the
// mailroom's contract has it.
//
// One mailbox per enabled automation, both trigger kinds. A schedule has no sender, so its
// mailbox is registered LOCKED — a verification secret minted and immediately forgotten, so
// the ingestion door answers 401 to everything — purely to give its fires the same queue,
// retries and consumer as a webhook's. The registry is synced from the table at boot and on
// every change; the registry itself stays the mailroom's in-memory concern.

import type { DeliveryPolicy, VerificationConfig, WebhooksSetup } from "@ryph/webhooks";
import type {
  Automation,
  AutomationEvent,
  FireOutcome,
  TriggerVerification,
} from "./core/types.ts";
import { readSignal, unknownSignal } from "./core/formats.ts";
import type { AutomationStore } from "./ports/automation_store.ts";
import type { EventSink } from "./ports/event_sink.ts";
import type { Diagnostics } from "./ports/diagnostics.ts";
import { nextOccurrence } from "./helpers/cron.ts";
import { mintFireId, mintSecret } from "./helpers/ids.ts";

export interface AutomationsSetupDeps {
  store: AutomationStore;
  webhooks: WebhooksSetup;
  sink: EventSink;
  diag: Diagnostics;
  now(): Date;
}

export interface AutomationsSetup {
  /** Registers every enabled automation's mailbox — the boot-time half of the sync. */
  syncRegistry(): Promise<void>;
  /** Re-seats one automation's mailbox after a change (or removal). Idempotent. */
  applyRegistration(automation: Automation | null, id: string): void;
  /** One pass over due schedules: enqueue each as a fire, advance its clock. Returns how
   * many fired. The host owns the interval, the lock, and the in-flight guard. */
  schedulerTick(): Promise<number>;
  /** One pass of the keep-warm access check: asks the door about each enabled automation's
   * owner and target, so a fire during a forge outage has a recent answer to fall back on.
   * Returns how many it asked about. The host owns the interval and the lock. */
  accessTick(): Promise<number>;
  /** Records the fire the ingestion door dropped — wire it as the mailroom's `onRateLimited`. */
  recordRateLimited(automationId: string): void;
  /** Removes an automation's mailbox AND its queued hooks — the delete path's half, where
   * `applyRegistration(null, …)` alone would leave the mail orphaned forever. */
  purgeMailbox(automationId: string): Promise<void>;
}

/**
 * How a fire is retried when the door cannot decide yet — a forge outage with no recent access
 * on record, the forge unreadable for services.yml. The mailroom's default doubles up to 15
 * minutes, so a fire that kept failing through a five-minute outage next tried five minutes
 * after it ended; an alert's run should start within a minute of the forge coming back. The
 * cap keeps roughly the default's hour of trying, and the lease outlasts the sink's 90 s.
 */
export const AUTOMATION_DELIVERY_POLICY: DeliveryPolicy = {
  leaseMs: 120_000,
  baseBackoffMs: 10_000,
  maxBackoffMs: 60_000,
  maxAttempts: 60,
};

/** The mailroom's half of a stored verification: what the door checks, without the bookkeeping
 * (`secretSource`) that is this service's alone. */
function mailboxVerification(v: TriggerVerification): VerificationConfig {
  switch (v.kind) {
    case "hmac-sha256":
      return { kind: v.kind, header: v.header, prefix: v.prefix, secret: v.secret };
    case "secret-header":
      return { kind: v.kind, header: v.header, prefix: v.prefix, secret: v.secret };
    case "standard-webhooks":
      return { kind: v.kind, secret: v.secret };
  }
}

/** How often a tripped rate limit may write a history row per automation. */
const RATE_LIMIT_RECORD_GAP_MS = 60_000;

export function setupAutomations(deps: AutomationsSetupDeps): AutomationsSetup {
  const { store, webhooks, sink, diag } = deps;
  const nowIso = () => deps.now().toISOString();
  const lastRateLimitRecord = new Map<string, number>();

  /** The consumer behind every mailbox. It loads the automation FRESH per delivery — the
   * recipe in force when the fire is handed over, not when it arrived — reads the fire with the
   * trigger's format, composes the event, and returns the sink's verdict unchanged to the
   * queue's retry clock. Reading here, not at the door, means a format revised while fires
   * wait in the queue reads them the new way, exactly as the rest of the recipe does. */
  const consumer = (automationId: string) =>
  async (
    hook: { id: string; body: string; headers: Record<string, string>; receivedAt: string },
  ) => {
    const automation = await store.getAutomation(automationId);
    if (automation === null) {
      return { kind: "failed" as const, message: "automation no longer exists", terminal: true };
    }
    if (!automation.enabled) {
      // The freshness check the registry cannot give: a pause lands in the table instantly,
      // but this replica's mailbox may still be seated. Non-terminal on purpose — a paused
      // automation's queued fires wait for the resume, exactly as the pause promises.
      return { kind: "failed" as const, message: "automation is paused", terminal: false };
    }
    const event: AutomationEvent = {
      eventId: hook.id,
      automationId: automation.id,
      name: automation.name,
      ownerUserId: automation.ownerUserId,
      agentId: automation.agentId,
      target: automation.target,
      instructions: automation.instructions,
      payload: hook.body,
      // A schedule's body is our own `{firedAt, cron}`, not a sender's report: nothing to read.
      signal: automation.trigger.kind === "webhook"
        ? readSignal(automation.trigger.format, hook.body, hook.headers)
        : unknownSignal(),
      response: automation.response,
      firedAt: hook.receivedAt,
    };
    const result = await sink.deliver(event);
    if (result.kind === "ok") {
      // The door's verdict, folded onto the fire vocabulary; anything it may grow that this
      // version does not know lands as "refused" rather than a crash. A "deduped" answer means
      // a redelivered hook — `recordFire` ignores the duplicate id, so the original verdict
      // stands either way.
      const known: readonly FireOutcome[] = [
        "started",
        "joined",
        "resolved",
        "ignored",
        "refused",
        "denied",
        "no-such-agent",
        "no-such-repo",
        "no-such-workspace",
        "no-linked-identity",
      ];
      const outcome = result.outcome === "deduped"
        ? "started"
        : (known as readonly string[]).includes(result.outcome)
        ? result.outcome as FireOutcome
        : "refused";
      await store.recordFire({
        id: hook.id,
        automationId: automation.id,
        outcome,
        taskId: result.taskId,
        runId: result.runId,
        detail: result.detail ?? null,
        firedAt: hook.receivedAt,
      });
      return { kind: "ok" as const };
    }
    if (result.terminal) {
      await store.recordFire({
        id: hook.id,
        automationId: automation.id,
        outcome: "undeliverable",
        taskId: null,
        runId: null,
        detail: result.message,
        firedAt: hook.receivedAt,
      });
    }
    return { kind: "failed" as const, message: result.message, terminal: result.terminal };
  };

  const applyRegistration = (automation: Automation | null, id: string): void => {
    webhooks.unregister(id);
    if (automation === null || !automation.enabled) return;
    const { trigger } = automation;
    webhooks.register({
      id: automation.id,
      verification: trigger.kind === "webhook"
        ? mailboxVerification(trigger.verification)
        // The locked door: a secret nobody is ever shown. The mailbox exists for the queue.
        : { kind: "secret-header", header: "authorization", secret: mintSecret() },
      rateLimit: trigger.kind === "webhook" ? trigger.rateLimit : undefined,
      policy: AUTOMATION_DELIVERY_POLICY,
      consumer: consumer(automation.id),
    });
  };

  return {
    async syncRegistry() {
      const enabled = await store.listEnabledAutomations();
      for (const automation of enabled) {
        applyRegistration(automation, automation.id);
      }
      diag.debug("automations.registry_synced", { count: enabled.length });
    },
    applyRegistration,
    async schedulerTick() {
      const now = deps.now();
      const due = await store.listDueSchedules(now.toISOString());
      for (const automation of due) {
        if (automation.trigger.kind !== "schedule") continue;
        const { cron, timezone } = automation.trigger;
        // One failed row must never dam the ones behind it — the table is the truth here, so
        // an id the registry does not know is re-seated from the fresh row and tried again
        // (self-healing after any registry drift), and anything still failing is logged and
        // skipped until the next tick.
        try {
          let hook;
          const body = JSON.stringify({ firedAt: now.toISOString(), cron });
          try {
            hook = await webhooks.enqueue(automation.id, body);
          } catch {
            applyRegistration(automation, automation.id);
            hook = await webhooks.enqueue(automation.id, body);
          }
          // The clock advances from NOW, never from the missed slot: a slot nothing was
          // ticking for is skipped, and `lastFiredAt` keeps the gap visible. Only the clock
          // columns are written — a PATCH landing mid-fire keeps its revision.
          const next = nextOccurrence(cron, timezone, now);
          await store.advanceScheduleClock(automation.id, {
            nextDueAt: next === null ? null : next.toISOString(),
            lastFiredAt: now.toISOString(),
            updatedAt: now.toISOString(),
          });
          diag.debug("automations.schedule_fired", {
            automationId: automation.id,
            hookId: hook.id,
          });
        } catch (err) {
          diag.warn("automations.schedule_fire_failed", {
            automationId: automation.id,
            err: String(err),
          });
        }
      }
      return due.length;
    },
    async accessTick() {
      // One question per distinct (owner, target): two automations on the same repo for the
      // same owner ask once. Sequential, so a pass never fans out against the forge's quota.
      const probes = new Map<string, { ownerUserId: string; target: Automation["target"] }>();
      for (const automation of await store.listEnabledAutomations()) {
        const { ownerUserId, target } = automation;
        probes.set(JSON.stringify([ownerUserId, target]), { ownerUserId, target });
      }
      for (const probe of probes.values()) await sink.refreshAccess(probe);
      return probes.size;
    },
    purgeMailbox(automationId) {
      return webhooks.purge(automationId);
    },
    recordRateLimited(automationId) {
      // One row per automation per window, not one per refused request: the history needs
      // "the limit tripped here", and a secret-holder hammering the door must not turn every
      // 429 into a write. In memory like the door's own counters — a restart forgets, which
      // errs on recording one extra row.
      const nowMs = deps.now().getTime();
      const last = lastRateLimitRecord.get(automationId);
      if (last !== undefined && nowMs - last < RATE_LIMIT_RECORD_GAP_MS) return;
      lastRateLimitRecord.set(automationId, nowMs);
      store.recordFire({
        id: mintFireId(),
        automationId,
        outcome: "rate-limited",
        taskId: null,
        runId: null,
        detail: null,
        firedAt: nowIso(),
      }).catch((err) => diag.warn("automations.fire_record_failed", { err: String(err) }));
    },
  };
}

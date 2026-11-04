// The startup contract for a mounting host: build the stores yourself, call `setup()`, spread
// `routes` into your handler, call `register()` for each mailbox — at boot, and again whenever
// the registrant's own records change — and drive `tick()` from your own timer and from
// `onIngested` (with your own in-flight guard and, multi-replica, your own `leader`).
//
// The registry is in-memory on purpose — no registrations table, no secrets at rest. A
// registrant that keeps its endpoints in storage of its own seals them its own way and
// re-registers them here on boot and on change; that is its concern, exactly as payload schemas
// are. Hooks persisted under an id nothing is registered for simply wait — the sweep drains
// bound registrations only — so a config change never loses what already arrived.

import {
  DEFAULT_DELIVERY_POLICY,
  type Hook,
  type WebhookRegistration,
  type WebhookRegistrationInput,
} from "./core/types.ts";
import { openHook } from "./core/hook_lifecycle.ts";
import { deadlineStore, drains, pruneTerminalHooks, STORE_DEADLINE_MS } from "./core/sweeper.ts";
import type { HookStore } from "./ports/hook_store.ts";
import type { Diagnostics } from "./ports/diagnostics.ts";
import { mintHookId, REGISTRATION_ID_PATTERN } from "./helpers/ids.ts";
import { ingestRoutes } from "./http/ingest.ts";
import type { Route } from "@ryph/shared/http";

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** How long one `tick()` may run before it is abandoned. A tick is a leadership check, a scan and
 * a prune, each call bounded (LEADER_CHECK_TIMEOUT_MS, STORE_DEADLINE_MS) and the prune ending at
 * its first failure, so even a database that stops answering ends a tick well inside this. One
 * still running is wedged on something nothing else times out, or so slow it may as well be: the
 * host's timer coalesces behind it, and no mailbox is scanned until it ends. */
export const TICK_STALL_MS = 60_000;

/** How many ticks in a row may be abandoned (TICK_STALL_MS) before the mailroom calls itself
 * stalled (`stalled`). Abandoning one is the remedy, and works in every deployment mode; this many
 * means it is not working, and only a restart is left. */
export const MAX_ABANDONED_TICKS = 3;

export interface WebhooksSetupDeps {
  store: HookStore;
  diag: Diagnostics;
  now(): Date;
  /** A hook was queued (ingested, or `enqueue`d) and its mailbox has no pass running to take
   * it: the host's kick — run `tick()` now, so it is delivered in milliseconds rather than a tick
   * later. One that a running pass took is not announced: it is in that pass's line already.
   * Must not throw. */
  onIngested?: () => void;
  /** Whether this process is the one that delivers (`SweeperDeps.leader`) — for a host with
   * several replicas, a lock held from scan to scan. Absent, it always is. */
  leader?: () => Promise<boolean>;
  /** Overrides LEADER_CHECK_TIMEOUT_MS (`SweeperDeps.leaderTimeoutMs`) — for tests. */
  leaderTimeoutMs?: number;
  /** Overrides STORE_DEADLINE_MS — for tests. */
  storeDeadlineMs?: number;
  /** Overrides TICK_STALL_MS — for tests. */
  tickStallMs?: number;
  /** See `IngestDeps.onRateLimited`. */
  onRateLimited?: (registrationId: string) => void;
}

export interface WebhooksSetup {
  /** The ingestion endpoints, mountable into the host's router. */
  routes: Route[];
  /** Rents a mailbox. A duplicate id is a programming error and throws. */
  register(input: WebhookRegistrationInput): void;
  /** Hands a mailbox back. Takes effect at the door immediately — new requests answer the
   * same 404 as an id never rented — while hooks already persisted stay put until the id is
   * registered again. A no-op for an id not currently registered. */
  unregister(id: string): void;
  /** Unregisters AND burns the mail: every persisted hook under the id is deleted, whatever
   * its state. The exit for a registration removed for good — `unregister` alone keeps the
   * hooks waiting for a re-registration that never comes. */
  purge(id: string): Promise<void>;
  /** Persists a hook directly, skipping the HTTP door and its verification — for fires the
   * registrant mints itself (a schedule coming due) rather than receives. The hook is queued,
   * swept and delivered exactly like an ingested one. Throws for an unregistered id. */
  enqueue(registrationId: string, body: string): Promise<Hook>;
  /** One scan: every due queue handed to its mailbox's drain, which delivers on after this
   * returns — each mailbox in passes of its own, so no mailbox waits for another's. Then a
   * bounded prune of the terminal hooks past each registration's `retainTerminalMs`. What the
   * host's timer and kick run; it never waits for a delivery, and never runs past TICK_STALL_MS:
   * one still running then is abandoned with a `webhooks.tick_abandoned` warning and left to end
   * on its own, so the host's next tick scans afresh. */
  tick(): Promise<void>;
  /** `tick()`, then waits until no mailbox has a pass running — everything due now handed over.
   * For tests and one-shot callers; a host's timer must not wait on deliveries, or one slow
   * mailbox would hold every other's next scan. */
  sweep(): Promise<void>;
  /** Why the mailroom is wedged — the last MAX_ABANDONED_TICKS ticks all abandoned, none ending
   * since — or null. For the host's liveness probe, as the last resort: abandoning a tick mends
   * what a slow or stuck call broke, in every deployment mode; this is for when it does not. A
   * database outage never trips it, since every call a tick makes ends at its deadline. */
  stalled(): string | null;
}

export function setup(deps: WebhooksSetupDeps): WebhooksSetup {
  const registry = new Map<string, WebhookRegistration>();
  const sweeperDeps = {
    // Bounded, so a database that stops answering ends ticks and passes rather than wedging
    // them (`deadlineStore`). The door keeps the raw store: a request has its own deadline.
    store: deadlineStore(deps.store, deps.storeDeadlineMs ?? STORE_DEADLINE_MS),
    diag: deps.diag,
    now: deps.now,
    leader: deps.leader,
    leaderTimeoutMs: deps.leaderTimeoutMs,
  };
  const drain = drains(sweeperDeps, registry);
  // Durable first, then handed on: straight into its mailbox's running pass, or — none running —
  // the host's kick, which scans.
  const arrived = (hook: Hook) => {
    if (!drain.arrived(hook.registrationId, hook.scope)) deps.onIngested?.();
  };
  // Ticks abandoned in a row (TICK_STALL_MS); any tick that ends on its own clears it.
  let abandoned = 0;
  const tickStallMs = deps.tickStallMs ?? TICK_STALL_MS;
  const tick = async () => {
    const work = (async () => {
      await drain.scan();
      await pruneTerminalHooks(sweeperDeps, registry);
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ended = await Promise.race([
      work.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), tickStallMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if (ended) {
      abandoned = 0;
      return;
    }
    // Stop waiting on it: the host's next tick scans afresh. It ends when its call does, and
    // what it finds then is offered like any scan's — claims are conditional, so a late offer
    // delivers nothing twice. Its failure, if it fails, goes nowhere: the next tick's is reported.
    abandoned++;
    work.catch(() => {});
    deps.diag.warn("webhooks.tick_abandoned", { afterMs: tickStallMs, inARow: abandoned });
  };

  return {
    routes: ingestRoutes({ ...deps, registry, onIngested: arrived }),
    register(input) {
      if (!REGISTRATION_ID_PATTERN.test(input.id)) {
        throw new Error(
          `webhook registration id ${JSON.stringify(input.id)} is not slug-shaped ` +
            `(${REGISTRATION_ID_PATTERN})`,
        );
      }
      if (registry.has(input.id)) {
        throw new Error(`webhook registration ${JSON.stringify(input.id)} already exists`);
      }
      registry.set(input.id, {
        id: input.id,
        verification: input.verification,
        maxBodyBytes: input.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
        rateLimit: input.rateLimit,
        onOverLimit: input.onOverLimit,
        admitScope: input.admitScope,
        retainTerminalMs: input.retainTerminalMs,
        dedupeKey: input.dedupeKey,
        admitDelivery: input.admitDelivery,
        policy: { ...DEFAULT_DELIVERY_POLICY, ...input.policy },
        consumer: input.consumer,
      });
    },
    unregister(id) {
      registry.delete(id);
    },
    async purge(id) {
      registry.delete(id);
      await deps.store.deleteHooksForRegistration(id);
    },
    async enqueue(registrationId, body) {
      const registration = registry.get(registrationId);
      if (registration === undefined) {
        throw new Error(`webhook registration ${JSON.stringify(registrationId)} does not exist`);
      }
      const hook = await deps.store.recordHook(openHook({
        id: mintHookId(),
        registrationId: registration.id,
        headers: {},
        body,
      }, deps.now().toISOString()));
      // Durable first, kick second — the same order the ingestion door keeps.
      arrived(hook);
      return hook;
    },
    tick,
    async sweep() {
      await tick();
      await drain.settled();
    },
    stalled() {
      return abandoned >= MAX_ABANDONED_TICKS
        ? `the last ${abandoned} webhook ticks were all abandoned after ${tickStallMs} ms`
        : null;
    },
  };
}

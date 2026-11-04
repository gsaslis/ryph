// The CRUD surface: /v1/automations, authenticated as a user against the shared JWKS. Every
// row is owned, and ownership is the only scope: a foreign or unknown id answers the same
// 404, so an id enumerates nothing.
//
// A minted secret crosses this surface exactly twice, outward only — the create and rotate
// responses — and is otherwise stripped from every serialization. A pasted secret crosses it
// once, inward (the same two verbs), and is never echoed back at all.

import { can, type Claims, forbidden } from "@ryph/auth";
import type { Automation, ResponsePolicy, TriggerVerification } from "../core/types.ts";
import { DEFAULT_RATE_LIMIT } from "../core/types.ts";
import { defaultCorrelation, presetOf, type SecretSource } from "../core/formats.ts";
import type { AutomationStore } from "../ports/automation_store.ts";
import {
  type ChatroomDirectory,
  type ChatroomPlatform,
  isOneConversation,
} from "../ports/chatroom_directory.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import type { AutomationsSetup } from "../setup.ts";
import { nextOccurrence, validateSchedule } from "../helpers/cron.ts";
import { mintAutomationId, mintSecret } from "../helpers/ids.ts";
import {
  CreateAutomationSchema,
  type ResponseInput,
  RotateSecretSchema,
  UpdateAutomationSchema,
} from "../schema.ts";
import { json, parseBody, type Route, route } from "@ryph/shared/http";

export interface RoutesDeps {
  store: AutomationStore;
  setup: AutomationsSetup;
  authenticate(req: Request): Promise<Claims | Response>;
  /**
   * The chat service, asked which platform a response's chatroom is on and, for a room with
   * channels, which ones it lists (ports/chatroom_directory.ts). Null: this deployment has no
   * chat, and a response may not name a chatroom at all.
   */
  chatrooms: ChatroomDirectory | null;
  diag: Diagnostics;
  now(): Date;
}

const FIRES_LIMIT = 50;

/** A platform named as its own users name it, for a refusal about a room's shape. */
const PLATFORM_LABELS: Record<ChatroomPlatform, string> = {
  telegram: "Telegram",
  zulip: "Zulip",
  slack: "Slack",
  discord: "Discord",
};

/** A verification as a caller may see it: everything but the secret, plus where it came from. */
function publicVerification(v: TriggerVerification): Record<string, unknown> {
  switch (v.kind) {
    case "hmac-sha256":
    case "secret-header":
      return { kind: v.kind, header: v.header, prefix: v.prefix, secretSource: v.secretSource };
    case "standard-webhooks":
      return { kind: v.kind, secretSource: v.secretSource };
  }
}

/** An automation as a caller may see it: the secret stripped, the ingestion path spelled out. */
function toPublic(a: Automation): Record<string, unknown> {
  const trigger = a.trigger.kind === "webhook"
    ? {
      kind: "webhook",
      format: a.trigger.format,
      verification: publicVerification(a.trigger.verification),
      rateLimit: a.trigger.rateLimit,
      path: `/v1/hooks/${a.id}`,
    }
    : {
      kind: "schedule",
      cron: a.trigger.cron,
      timezone: a.trigger.timezone,
      nextDueAt: a.trigger.nextDueAt,
      lastFiredAt: a.trigger.lastFiredAt,
    };
  return {
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    trigger,
    agentId: a.agentId,
    target: a.target,
    instructions: a.instructions,
    response: a.response,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/** A Standard Webhooks secret as senders show it: `whsec_` and base64, or the bare base64. The
 * mailroom decodes it into the HMAC key, so anything else could never verify a request. */
function isStandardWebhooksSecret(secret: string): boolean {
  const body = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return body.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(body);
}

const STANDARD_WEBHOOKS_SECRET_ERROR =
  "secret: a standard-webhooks secret is the sender's whsec_… value (base64)";

/**
 * The stored response policy for a caller's input, against the trigger it will fire with: the
 * correlation defaulted by trigger when the caller named none (core/formats.ts
 * `defaultCorrelation`), and `key` refused on a schedule — a schedule's fires carry no payload a
 * key could be read from. In a room that is one conversation — or a `shared` conversation in a
 * channel — the default is `automation`: only one response can be open there (`chatroomRefusal`
 * refuses any other). A string is the refusal.
 */
function resolveResponse(
  input: ResponseInput | null | undefined,
  trigger: Automation["trigger"],
  oneConversation = false,
): ResponsePolicy | null | undefined | string {
  if (input === null || input === undefined) return input;
  if (input.correlation === "key" && trigger.kind !== "webhook") {
    return 'response.correlation: "key" joins fires by a key read from a webhook\'s payload — ' +
      'a schedule has none; use "fire" or "automation"';
  }
  const fallback = oneConversation ? "automation" : defaultCorrelation(trigger);
  return { ...input, correlation: input.correlation ?? fallback };
}

export function automationRoutes(deps: RoutesDeps): Route[] {
  const { store, setup } = deps;
  const nowIso = () => deps.now().toISOString();

  /** Whether the caller may act on everyone's automations, not only their own. */
  const managesAll = (claims: Claims) => can(claims, "automations:manage-all");

  /** Loads the caller's automation — a foreign or unknown id is the same 404, unless the caller
   * manages everyone's. */
  const owned = async (claims: Claims, id: string): Promise<Automation | null> => {
    const automation = await store.getAutomation(id);
    if (automation === null) return null;
    if (automation.ownerUserId !== claims.sub && !managesAll(claims)) return null;
    return automation;
  };
  const notFound = () => json(404, { error: "not found" });

  /**
   * Why a response policy's room binding cannot be saved, or null when it can. Checked on every
   * save that NAMES a room — a create, or a PATCH carrying one — because a response binds its
   * run to one conversation, and which one depends on the platform. A Telegram room IS one,
   * so `channelId` stays null; a Zulip organization, a Slack workspace and a Discord server are
   * channels, so
   * `channelId` must name one the chat service lists for the room. It asks as the caller, because
   * that list names private channels and the chat service lets only the room's creator or an
   * admin read it.
   *
   * Each response opens a conversation of its own in that channel, and the channel must be
   * PRIVATE: its members are the allowlist for steering the run and the audience for everything
   * the agent posts there — the opening line, its replies, the closing line's patch and issue
   * links and summary — for an automation whose targets may be private repos, and only a private
   * channel is a closed room. A public or web-public one is refused here, at save time, because
   * the audience is a property of the policy, not of one run. The orchestrator's door separately
   * refuses steering from a non-private channel, which covers a conversation that went public
   * later. A room archived (or a channel gone) later is the fire's problem, as it always was:
   * the binding is refused and the run goes on without it.
   *
   * A room that IS one conversation (Telegram) holds one bound run at a time, so only one
   * response may be open in it: a correlation that opens several at once — `fire`, `key` — would
   * have every response but the first refused its binding and run unheard. Such a correlation
   * is refused there, and an unnamed one defaults to `automation` (`oneConversation`). A
   * `shared` conversation in a channel is one conversation by choice, and takes the same rule.
   * `shared` means nothing without a channel — no room has no conversation to share, and a
   * Telegram room's is already the only one — so it is refused there rather than kept as a
   * setting that does nothing.
   */
  const chatroomRefusal = async (
    req: Request,
    response:
      | {
        chatroomId: string | null;
        channelId: string | null;
        correlation?: string;
        conversation: string;
      }
      | null
      | undefined,
  ): Promise<Response | { oneConversation: boolean }> => {
    const free = { oneConversation: false };
    if (response === null || response === undefined) return free;
    const { chatroomId, channelId } = response;
    const shared = response.conversation === "shared";
    const oneOpen = response.correlation === "fire" || response.correlation === "key";
    if (chatroomId === null) {
      if (channelId !== null) {
        return json(422, {
          error: "response.channelId: a channel belongs to a chatroom — name one, or leave " +
            "channelId null",
        });
      }
      return shared
        ? json(422, {
          error: 'response.conversation: "shared" is one conversation in a chatroom\'s ' +
            'channel — name a chatroom and a channel, or use "per-response"',
        })
        : free;
    }
    if (deps.chatrooms === null) {
      return json(422, {
        error: "response.chatroomId: chat is not configured on this deployment",
      });
    }
    const authorization = req.headers.get("authorization");
    let platform;
    try {
      platform = await deps.chatrooms.platformOf(chatroomId, authorization);
    } catch (err) {
      deps.diag.warn("automations.chatroom_lookup_failed", { chatroomId, err: String(err) });
      return json(502, {
        error: "response.chatroomId: the chat service did not answer — try again",
      });
    }
    if (platform === null) {
      return json(422, { error: `response.chatroomId: no chatroom ${chatroomId}` });
    }
    if (isOneConversation(platform)) {
      if (channelId !== null) {
        return json(422, {
          error: `response.channelId: a ${PLATFORM_LABELS[platform]} room has one conversation — ` +
            "leave channelId null",
        });
      }
      if (shared) {
        return json(422, {
          error: `response.conversation: a ${PLATFORM_LABELS[platform]} room is one ` +
            'conversation already — use "per-response"',
        });
      }
      if (oneOpen) {
        return json(422, {
          error: `response.correlation: a ${PLATFORM_LABELS[platform]} room has one ` +
            'conversation, so only one response can be open in it — use "automation"',
        });
      }
      return { oneConversation: true };
    }
    if (channelId === null) {
      return json(422, {
        error: `response.channelId: a ${PLATFORM_LABELS[platform]} room needs a channel to open ` +
          "each response's conversation in",
      });
    }
    if (shared && oneOpen) {
      return json(422, {
        error: 'response.correlation: a "shared" conversation holds one response at a time, ' +
          'so only one can be open — use "automation"',
      });
    }
    let listed;
    try {
      listed = await deps.chatrooms.channelsOf(chatroomId, authorization);
    } catch (err) {
      deps.diag.warn("automations.chatroom_lookup_failed", { chatroomId, err: String(err) });
      return json(502, {
        error: "response.channelId: the chat service did not answer — try again",
      });
    }
    if (listed.kind === "none") {
      return json(422, { error: `response.chatroomId: no chatroom ${chatroomId}` });
    }
    if (listed.kind === "forbidden") {
      return json(403, {
        error: "response.chatroomId: only the room's creator or an admin may bind responses to " +
          "a room's channels",
      });
    }
    const channel = listed.channels.find((c) => c.id === channelId);
    if (channel === undefined) {
      // A truncated list is not a verdict: the channel may be perfectly real and simply past the
      // part of the workspace the chat service read, so the refusal says which case this is.
      return json(422, {
        error: listed.truncated
          ? `response.channelId: the bot is in more channels than one read of the room lists, ` +
            `and ${channelId} was not among them, so this save cannot be checked — remove the ` +
            "bot from channels it no longer serves, or name one the list reaches"
          : `response.channelId: the room does not list channel ${channelId} (the bot must ` +
            "be subscribed to a private channel)",
      });
    }
    if (channel.visibility !== "private") {
      return json(422, {
        error: `response.channelId: a response opens in a private channel only — ` +
          `${channel.name} is ${channel.visibility}`,
      });
    }
    return { oneConversation: shared };
  };

  /** Every verb here takes `automations:manage`; ownership narrows it further below. */
  const authenticate = async (req: Request): Promise<Claims | Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    return can(caller, "automations:manage") ? caller : json(403, forbidden("automations:manage"));
  };

  /**
   * An automation fires as its owner, so every verb that leaves one able to fire as the caller —
   * create, edit, re-enable, a fresh secret — is a standing delegation of `tasks:create`, and
   * takes it too: a credential that cannot start a task itself must not leave behind one that
   * does. The write is logged with the credential behind it, a session or an API token.
   */
  const delegates = async (req: Request, what: string): Promise<Claims | Response> => {
    const caller = await authenticate(req);
    if (caller instanceof Response) return caller;
    if (!can(caller, "tasks:create")) return json(403, forbidden("tasks:create", what));
    return caller;
  };
  const provenance = (event: string, automationId: string, caller: Claims) =>
    deps.diag.debug(event, { automationId, via: caller.via, sid: caller.sid });

  return [
    route("GET", "/v1/automations", async (req) => {
      const caller = await authenticate(req);
      if (caller instanceof Response) return caller;
      const automations = managesAll(caller)
        ? await store.listAutomations()
        : await store.listAutomationsByOwner(caller.sub);
      return json(200, { automations: automations.map(toPublic) });
    }),

    route("POST", "/v1/automations", async (req) => {
      const caller = await delegates(req, "creating an automation");
      if (caller instanceof Response) return caller;
      const body = await parseBody(req, CreateAutomationSchema);
      if (!body.ok) return body.res;
      const input = body.data;
      const room = await chatroomRefusal(req, input.response);
      if (room instanceof Response) return room;
      const at = nowIso();

      // The secret the response shows — only ever a minted one the owner must paste somewhere.
      let shown: string | null = null;
      let trigger: Automation["trigger"];
      if (input.trigger.kind === "webhook") {
        const { format, verification: chosen } = input.trigger;
        if (
          chosen.kind === "standard-webhooks" && chosen.secret !== undefined &&
          !isStandardWebhooksSecret(chosen.secret)
        ) {
          return json(422, { error: STANDARD_WEBHOOKS_SECRET_ERROR });
        }
        let secret: string;
        let secretSource: SecretSource;
        if (chosen.secret !== undefined) {
          secret = chosen.secret;
          secretSource = "pasted";
        } else {
          secret = mintSecret();
          secretSource = "minted";
          // A sender that generates its own secret will never take ours, so a minted one is a
          // PLACEHOLDER: it keeps the door shut (401) until the real secret is pasted through
          // rotate, and showing it would only invite pasting it somewhere it cannot go. That is
          // standard-webhooks always, and a preset whose secret is the vendor's when the owner
          // kept its verification kind; anyone who swapped in a kind they can mint for (say a
          // secret header PagerDuty sends as a custom header) gets theirs shown as usual.
          const preset = format.kind === "custom" ? null : presetOf(format.kind);
          const placeholder = chosen.kind === "standard-webhooks" ||
            (preset?.secret === "pasted" && preset.verification?.kind === chosen.kind);
          if (!placeholder) shown = secret;
        }
        const verification: TriggerVerification = chosen.kind === "standard-webhooks"
          ? { kind: "standard-webhooks", secret, secretSource }
          : {
            kind: chosen.kind,
            header: chosen.header,
            prefix: chosen.prefix,
            secret,
            secretSource,
          };
        trigger = {
          kind: "webhook",
          format,
          verification,
          rateLimit: input.trigger.rateLimit ?? DEFAULT_RATE_LIMIT,
        };
      } else {
        const problem = validateSchedule(input.trigger.cron, input.trigger.timezone);
        if (problem !== null) return json(422, { error: problem });
        const next = nextOccurrence(input.trigger.cron, input.trigger.timezone, deps.now());
        trigger = {
          kind: "schedule",
          cron: input.trigger.cron,
          timezone: input.trigger.timezone,
          nextDueAt: next === null ? null : next.toISOString(),
          lastFiredAt: null,
        };
      }
      const response = resolveResponse(input.response, trigger, room.oneConversation);
      if (typeof response === "string") return json(422, { error: response });

      const automation: Automation = {
        id: mintAutomationId(),
        ownerUserId: caller.sub,
        name: input.name,
        enabled: true,
        trigger,
        agentId: input.agentId,
        target: input.target,
        instructions: input.instructions,
        response: response ?? null,
        createdAt: at,
        updatedAt: at,
      };
      await store.createAutomation(automation);
      setup.applyRegistration(automation, automation.id);
      provenance("automations.created", automation.id, caller);
      // The one time a minted secret is ever shown — paste it into the sender now. Absent for a
      // pasted secret (the owner already has it), a placeholder, and a schedule.
      return json(201, {
        automation: toPublic(automation),
        ...(shown === null ? {} : { secret: shown }),
      });
    }),

    route("GET", "/v1/automations/:id", async (req, params) => {
      const caller = await authenticate(req);
      if (caller instanceof Response) return caller;
      const automation = await owned(caller, params.id);
      if (automation === null) return notFound();
      return json(200, { automation: toPublic(automation) });
    }),

    route("PATCH", "/v1/automations/:id", async (req, params) => {
      const caller = await delegates(req, "editing an automation");
      if (caller instanceof Response) return caller;
      const automation = await owned(caller, params.id);
      if (automation === null) return notFound();
      const body = await parseBody(req, UpdateAutomationSchema);
      if (!body.ok) return body.res;
      const patch = body.data;
      const room = await chatroomRefusal(req, patch.response);
      if (room instanceof Response) return room;

      let trigger = automation.trigger;
      if (patch.rateLimit !== undefined) {
        if (trigger.kind !== "webhook") {
          return json(422, { error: "a schedule automation has no rate limit" });
        }
        trigger = { ...trigger, rateLimit: patch.rateLimit };
      }
      if (patch.format !== undefined) {
        if (trigger.kind !== "webhook") {
          return json(422, { error: "a schedule automation has no payload format" });
        }
        // What fires MEAN, never whether they get in: verification is untouched, so the
        // re-seat below changes nothing at the door.
        trigger = { ...trigger, format: patch.format };
      }
      if (patch.cron !== undefined || patch.timezone !== undefined) {
        if (trigger.kind !== "schedule") {
          return json(422, { error: "a webhook automation has no schedule" });
        }
        const cron = patch.cron ?? trigger.cron;
        const timezone = patch.timezone ?? trigger.timezone;
        const problem = validateSchedule(cron, timezone);
        if (problem !== null) return json(422, { error: problem });
        const next = nextOccurrence(cron, timezone, deps.now());
        trigger = {
          ...trigger,
          cron,
          timezone,
          nextDueAt: next === null ? null : next.toISOString(),
        };
      }

      // A policy in the patch is defaulted against the trigger as revised — a format changed in
      // the same PATCH decides a correlation left unnamed.
      const response = resolveResponse(patch.response, trigger, room.oneConversation);
      if (typeof response === "string") return json(422, { error: response });

      const revised: Automation = {
        ...automation,
        // An edit by someone other than the owner — reachable only through `manage-all` —
        // takes over ownership, the way `putRoom` does for command rooms: a fire runs as
        // the OWNER's forge identity (automations_api.ts), so whoever last set the
        // instructions, the target or the agent is who must answer for what they do, not
        // whoever happened to hold the row first. An operator who only flips a schedule
        // or a response policy without touching those three still moves the row to
        // themselves, for the same reason `putRoom` always does: a partial rule ("only an
        // identity-bearing edit transfers it") is one more thing to get right under review.
        ownerUserId: caller.sub,
        name: patch.name ?? automation.name,
        agentId: patch.agentId ?? automation.agentId,
        target: patch.target ?? automation.target,
        instructions: patch.instructions ?? automation.instructions,
        // `null` clears the policy back to a run per fire; absent leaves it alone.
        response: response === undefined ? automation.response : response,
        trigger,
        updatedAt: nowIso(),
      };
      await store.saveAutomation(revised);
      setup.applyRegistration(revised, revised.id);
      provenance("automations.updated", revised.id, caller);
      return json(200, { automation: toPublic(revised) });
    }),

    route("DELETE", "/v1/automations/:id", async (req, params) => {
      const caller = await authenticate(req);
      if (caller instanceof Response) return caller;
      const automation = await owned(caller, params.id);
      if (automation === null) return notFound();
      await store.deleteAutomation(automation.id);
      // The mailbox and its queued mail both go: a deleted automation's hooks have no future
      // consumer, and "removed for good" is the promise the confirm dialog makes.
      await setup.purgeMailbox(automation.id);
      deps.diag.debug("automations.deleted", { automationId: automation.id });
      return new Response(null, { status: 204 });
    }),

    route("POST", "/v1/automations/:id/enable", async (req, params) => {
      const caller = await delegates(req, "enabling an automation");
      if (caller instanceof Response) return caller;
      const automation = await owned(caller, params.id);
      if (automation === null) return notFound();
      // Re-enabling a schedule restarts its clock from NOW — slots missed while paused are
      // skipped, exactly as slots missed in an outage are.
      const trigger = automation.trigger.kind === "schedule"
        ? {
          ...automation.trigger,
          nextDueAt: (() => {
            const next = nextOccurrence(
              automation.trigger.cron,
              automation.trigger.timezone,
              deps.now(),
            );
            return next === null ? null : next.toISOString();
          })(),
        }
        : automation.trigger;
      const revised = { ...automation, enabled: true, trigger, updatedAt: nowIso() };
      await store.saveAutomation(revised);
      setup.applyRegistration(revised, revised.id);
      provenance("automations.enabled", revised.id, caller);
      return json(200, { automation: toPublic(revised) });
    }),

    route("POST", "/v1/automations/:id/disable", async (req, params) => {
      const caller = await authenticate(req);
      if (caller instanceof Response) return caller;
      const automation = await owned(caller, params.id);
      if (automation === null) return notFound();
      const revised = { ...automation, enabled: false, updatedAt: nowIso() };
      await store.saveAutomation(revised);
      setup.applyRegistration(revised, revised.id);
      return json(200, { automation: toPublic(revised) });
    }),

    route("POST", "/v1/automations/:id/rotate-secret", async (req, params) => {
      const caller = await delegates(req, "rotating an automation's secret");
      if (caller instanceof Response) return caller;
      const automation = await owned(caller, params.id);
      if (automation === null) return notFound();
      if (automation.trigger.kind !== "webhook") {
        return json(422, { error: "a schedule automation has no secret" });
      }
      const body = await parseBody(req, RotateSecretSchema, { emptyIs: {} });
      if (!body.ok) return body.res;
      const pasted = body.data.secret;
      const { verification } = automation.trigger;
      if (verification.kind === "standard-webhooks") {
        // A minted secret could never be the sender's, so rotating one in is refused outright.
        if (pasted === undefined) {
          return json(422, {
            error: "a standard-webhooks secret is the sender's — paste it as {secret}",
          });
        }
        if (!isStandardWebhooksSecret(pasted)) {
          return json(422, { error: STANDARD_WEBHOOKS_SECRET_ERROR });
        }
      }
      const secret = pasted ?? mintSecret();
      const secretSource: SecretSource = pasted === undefined ? "minted" : "pasted";
      const revised: Automation = {
        ...automation,
        // As on PATCH: whoever now holds the fresh secret is who fires the webhook, and a
        // fire runs as the OWNER's forge identity, so rotating under `manage-all` takes
        // over ownership too — otherwise an operator could mint a secret that fires work
        // under a login that never chose to hand it out.
        ownerUserId: caller.sub,
        trigger: {
          ...automation.trigger,
          verification: { ...verification, secret, secretSource },
        },
        updatedAt: nowIso(),
      };
      await store.saveAutomation(revised);
      // Re-seating the mailbox is what makes the old secret stop verifying immediately.
      setup.applyRegistration(revised, revised.id);
      deps.diag.debug("automations.secret_rotated", {
        automationId: automation.id,
        secretSource,
        via: caller.via,
        sid: caller.sid,
      });
      // A minted secret is shown this once; a pasted one is the owner's already.
      return json(200, pasted === undefined ? { secret } : {});
    }),

    route("GET", "/v1/automations/:id/fires", async (req, params) => {
      const caller = await authenticate(req);
      if (caller instanceof Response) return caller;
      const automation = await owned(caller, params.id);
      if (automation === null) return notFound();
      const fires = await store.listFires(automation.id, FIRES_LIMIT);
      return json(200, { fires });
    }),
  ];
}

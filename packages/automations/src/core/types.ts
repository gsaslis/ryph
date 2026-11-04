// The automations domain: an automation (a user's stored recipe plus the trigger that fires
// it) and a fire (one triggering, with how it ended). Ingestion, queueing and delivery of
// webhook traffic belong to the mounted @ryph/webhooks mailroom; starting the actual run
// belongs to the orchestrator behind the events door. This package owns the recipes, the
// triggers, and the record of every fire.

import type { FireSignal, SecretSource, WebhookFormat } from "./formats.ts";

/** How a webhook trigger's requests prove their sender — the mailroom's verification kinds,
 * each with the secret stored verbatim because verification needs it. The secret is either
 * minted server-side and shown once (at creation or rotation), or pasted by the owner from a
 * sender that generates its own and never lets anyone choose (PagerDuty, Sentry, incident.io);
 * `secretSource` records which, so the app can tell "paste this into the sender" from "paste
 * the sender's into us". A pasted secret is never shown back. */
export type TriggerVerification =
  | {
    kind: "hmac-sha256";
    header: string;
    prefix: string;
    secret: string;
    secretSource: SecretSource;
  }
  | {
    kind: "secret-header";
    header: string;
    /** Compared as `prefix + secret` — `"Bearer "` for Alertmanager's `authorization`. */
    prefix: string;
    secret: string;
    secretSource: SecretSource;
  }
  /** Svix-style signing (incident.io): fixed headers, a `whsec_` secret that is always the
   * sender's — one created without it holds a minted placeholder until it is pasted. */
  | { kind: "standard-webhooks"; secret: string; secretSource: SecretSource };

/** A ceiling on accepted fires per rolling window — the guard between a runaway sender and a
 * runaway bill, since every accepted fire is an agent run. */
export interface TriggerRateLimit {
  maxPerWindow: number;
  windowMs: number;
}

export const DEFAULT_RATE_LIMIT: TriggerRateLimit = { maxPerWindow: 1, windowMs: 60_000 };

/** An inbound URL the owner pastes into the sending service. The automation's id is the URL
 * segment, and the mailroom enforces verification and the rate limit at the door. */
export interface WebhookTrigger {
  kind: "webhook";
  /** How a fire's body is read into a signal (core/formats.ts). Revisable; it changes what
   * fires mean, never whether the door lets them in. */
  format: WebhookFormat;
  verification: TriggerVerification;
  rateLimit: TriggerRateLimit;
}

/** A clock instead of a sender: a five-field cron expression evaluated in an IANA timezone.
 * `nextDueAt` is precomputed so the scheduler tick is one indexed query; a slot nothing was
 * ticking for is skipped, never made up — `lastFiredAt` makes the gap visible. */
export interface ScheduleTrigger {
  kind: "schedule";
  cron: string;
  timezone: string;
  nextDueAt: string | null;
  lastFiredAt: string | null;
}

export type AutomationTrigger = WebhookTrigger | ScheduleTrigger;

/**
 * Which open response a fire joins:
 * - `fire`: none — every fire opens a response of its own;
 * - `automation`: the automation's one open response, whatever the fire is about;
 * - `key`: the open response for the fire's `signal.key` — one per alert group, incident, issue.
 *   A fire whose format read no key falls back to the automation-wide slot.
 *
 * Defaults: a schedule → `fire`; a webhook whose format reads keys → `key`; otherwise
 * `automation`. `key` is refused on a schedule, which has no payload to read one from.
 */
export type ResponseCorrelation = "fire" | "automation" | "key";

/**
 * Where an automation's responses talk, on a platform with channels (Zulip, Slack, Discord):
 * - `per-response`: each opens a conversation of its own — a Zulip topic named for the fire, a
 *   Slack thread under its own opening line, a Discord thread named for the fire started from
 *   it;
 * - `shared`: every response continues the conversation the automation's last one was in, keyed
 *   by the post that opened the first — one topic (named for the automation alone) or one thread
 *   for a daily schedule, not one a day. When that conversation is gone (its opening post
 *   deleted, moved out of the channel) the next response opens a new one, and later ones continue
 *   that.
 *
 * A conversation holds one run at a time, so `shared` takes correlation `automation`: a `fire`
 * or `key` correlation would have a second response open while the first still holds the
 * conversation, and that one would run unheard. It needs a channel (`channelId`): a Telegram
 * room IS one conversation already, and a policy with no room has none.
 */
export type ResponseConversation = "per-response" | "shared";

/**
 * How an automation's fires become RESPONSES rather than a run each: a fire opens a run that
 * stays alive to be talked to, later fires join it as messages (which one, `correlation` says),
 * and the run ends when the agent says it is done or nobody has said anything for a while.
 * `chatroomId` names the chatroom the run is bound to (null: the run page is the only room). `channelId` is the other
 * half of that binding on a platform with channels: a Telegram room IS one conversation, but a
 * Zulip organization, a Slack workspace and a Discord server are channels, so each response
 * opens a conversation of its own in the channel this names (the platform id as a string —
 * Zulip's stream_id, Slack's `C…`, Discord's snowflake) and binds to the post that starts it.
 * Null on a Telegram room and when no chatroom is named. The idle clocks are the run's: `idleMs`
 * while nobody has spoken to it, `attendedIdleMs` once a person has. `postAlert` puts the fire that
 * opened the response — its title and payload — into the conversation's opening line, so the room
 * sees what fired without opening the run. `conversation` says whether each response gets that
 * channel conversation of its own, or all of them share one (`ResponseConversation`).
 */
export interface ResponsePolicy {
  chatroomId: string | null;
  channelId: string | null;
  idleMs: number;
  attendedIdleMs: number;
  correlation: ResponseCorrelation;
  postAlert: boolean;
  conversation: ResponseConversation;
}

/** Thirty minutes unattended, an hour once a person has joined: an alert's agent is often still
 * investigating, or waiting on the next fire, well past five quiet minutes. */
export const DEFAULT_IDLE_MS = 30 * 60_000;
export const DEFAULT_ATTENDED_IDLE_MS = 60 * 60_000;

/** Schedules may not fire closer together than this. A validation constant, checked at
 * creation — the service controls the cadence, so there is nothing to police at fire time. */
export const MIN_SCHEDULE_GAP_MS = 5 * 60_000;

/**
 * One stored recipe, owned by one user. Every run it starts acts for that owner: the
 * orchestrator records `requestedByUserId` = the owner and re-checks the owner's repo access
 * live on every fire. The recipe is fixed — a payload can add context to a run, never change
 * what the run is asked to do.
 */
export interface Automation {
  /** Random slug; for webhook triggers it is also the ingestion URL segment. */
  id: string;
  ownerUserId: string;
  name: string;
  /** A pause switch, not a delete: off refuses new fires and freezes queued ones; on
   * resumes both. */
  enabled: boolean;
  trigger: AutomationTrigger;
  agentId: string;
  /** What the run checks out: one connected repo (at a ref, or its default branch) or a
   * workspace — connected only, because the live permission gate needs repos to check the
   * owner against. The orchestrator resolves a workspace's list at fire time. */
  target: AutomationTarget;
  instructions: string;
  /** Set: fires open or join a response instead of starting a run each. Null: a run per fire. */
  response: ResponsePolicy | null;
  createdAt: string;
  updatedAt: string;
}

/** The repo or workspace an automation's runs check out. Mirrors the orchestrator's. */
export type AutomationTarget =
  | { kind: "repo"; connectedRepoId: string; ref: string | null }
  | { kind: "workspace"; workspaceId: string };

/** Where one fire's handling ended. The orchestrator's verdicts land here verbatim, plus the
 * two ends only this service can see: a fire dropped at the door by the rate limit, and one
 * whose automation vanished before delivery. */
export type FireOutcome =
  | "started"
  /** The fire joined a response already open for its slot — no run started. */
  | "joined"
  /** The fire reported its thing resolved with no response open — nothing to respond to. */
  | "resolved"
  /** The fire was a lifecycle update (acknowledged, assigned…) with no response open to tell —
   * an update never starts a run. */
  | "ignored"
  | "refused"
  | "denied"
  | "no-such-agent"
  | "no-such-repo"
  | "no-such-workspace"
  | "no-linked-identity"
  | "rate-limited"
  | "undeliverable";

/** One triggering of one automation — the fire history a UI lists. `id` is the hook id for
 * fires that entered the queue, and a minted id for rate-limited drops that never did. */
export interface Fire {
  id: string;
  automationId: string;
  outcome: FireOutcome;
  taskId: string | null;
  runId: string | null;
  /** The refusal's reason, when one was given. */
  detail: string | null;
  firedAt: string;
}

/** The typed event delivered to the orchestrator's events door — the recipe resolved at fire
 * time, the payload verbatim, and the payload as the trigger's format read it. Mirrors the
 * orchestrator's `InboundAutomationEvent`, with every field present: the in-process host sink
 * hands this object over without the door's zod defaults. */
export interface AutomationEvent {
  eventId: string;
  automationId: string;
  name: string;
  ownerUserId: string;
  agentId: string;
  target: AutomationTarget;
  instructions: string;
  payload: string;
  /** The fire, read by the webhook trigger's format at delivery; a schedule's is unknown. The
   * orchestrator decides from it whether the fire opens, joins, or is dropped. */
  signal: FireSignal;
  /** The automation's response policy, verbatim; null for a run per fire. */
  response: ResponsePolicy | null;
  firedAt: string;
}

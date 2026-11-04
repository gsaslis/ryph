// The webhook module's domain: registrations (a mailbox someone rented) and hooks (the
// packages that arrive in it). This module ONLY ingests, verifies transport authenticity,
// persists, and forwards — payload schemas and every action a hook triggers belong to the
// module that registered the endpoint, never here. See docs/architecture.md.

import { hmacSha256Hex } from "@ryph/sealed";

/** How an ingestion endpoint proves a request really came from the configured sender.
 * Transport authenticity only — nothing here reads or understands the payload. */
export type VerificationConfig =
  | HmacSha256Verification
  | SecretHeaderVerification
  | DerivedSecretHeaderVerification
  | StandardWebhooksVerification;

/** A signature over the raw body bytes: proves the sender holds the secret AND that the body
 * arrived untampered. The strongest kind — prefer it for any sender that can sign. */
export interface HmacSha256Verification {
  kind: "hmac-sha256";
  /** The request header carrying the signature, e.g. "x-hub-signature-256" for GitHub. */
  header: string;
  /** A fixed prefix before the hex digest, e.g. "sha256=". Empty when the header is bare hex.
   * The header may carry SEVERAL signatures separated by commas or whitespace — PagerDuty sends
   * `v1=<a>,v1=<b>` while it rotates a secret — and the request passes when any one of them is
   * `prefix + hex`. */
  prefix: string;
  /** The shared secret. Held in memory only — this module persists no secrets; a registrant
   * that stores endpoint configs seals them on its own side. */
  secret: string;
}

/** The secret itself, sent verbatim in a header. A password rather than a signature: it proves
 * the sender holds the secret but says nothing about the body's integrity. It exists for
 * senders that can set a header but cannot sign. */
export interface SecretHeaderVerification {
  kind: "secret-header";
  /** The request header carrying the secret, e.g. "authorization". */
  header: string;
  /** A fixed scheme before the secret, compared as `prefix + secret` — `"Bearer "` for a sender
   * that can only fill the `authorization` header the standard way (Alertmanager's
   * `http_config.authorization`). Absent means `""`: the header is the secret verbatim. */
  prefix?: string;
  /** The shared secret, held in memory only — as for `HmacSha256Verification`. */
  secret: string;
}

/**
 * A secret header whose expected value is DERIVED per scope rather than shared: the request names
 * its scope in a query parameter (digits only — GitLab's numeric project id), and the header must
 * equal `hex(HMAC-SHA256(master, label + scope))`. GitLab sets `X-Gitlab-Token` per hook, so a
 * token pasted into one project can only ever vouch for that project: a leaked one forges
 * deliveries for the scope it was derived for and no other.
 *
 * With `generationParam` set the token also names a GENERATION, so a scope's token can be
 * rotated without rotating the master (which would re-key every scope at once): the request must
 * carry the generation in that query parameter too, and the header must equal
 * `hex(HMAC-SHA256(master, label + scope + ":" + generation))`. The generation rides in the URL
 * rather than in anything this module stores so the door stays stateless — it holds no table of
 * scopes and no counters, only the master, exactly as without generations. Which generation is
 * CURRENT is therefore not the door's to know: the HMAC only proves that the token was minted for
 * this (scope, generation) pair, and a hook pasted before a rotation still verifies here. Judging
 * it stale is the registrant's job — the consumer reads the verified generation off the row and
 * refuses one older than the generation it last handed out for that scope.
 *
 * Checked before the body is read as anything, like every kind here. A verified request's scope
 * is written into the stored row twice — as `Hook.scope`, which is what the queue orders by, and
 * as the `VERIFIED_SCOPE_HEADER` header — and its generation, when the registration uses them, as
 * `VERIFIED_GENERATION_HEADER`, so the consumer can refuse a payload that names another scope than
 * the one the credential was derived for, or a credential from a generation it has retired.
 */
export interface DerivedSecretHeaderVerification {
  kind: "derived-secret-header";
  /** The request header carrying the derived secret, e.g. "x-gitlab-token". */
  header: string;
  /** The master secret every scope's secret is derived from — held in memory only. */
  master: string;
  /** What is prepended to the scope before it is MACed, e.g. "gitlab-hook:" — so the same
   * master can never vouch for a value derived for another purpose. */
  label: string;
  /** The query parameter naming the scope, e.g. "project". Digits only, 1–20 of them. */
  scopeParam: string;
  /** The query parameter naming the token's generation, e.g. "generation". When set, a request
   * must carry exactly one, of 1–10 digits, and the token must have been derived for it; when
   * absent, tokens carry no generation and derive from `label + scope` alone. Compared as the
   * string sent, so `01` and `1` are different generations with different tokens. */
  generationParam?: string;
}

/** The header a `derived-secret-header` row carries its VERIFIED scope in. Written by the door,
 * never taken from the sender: one the sender sent is dropped before the row is written. */
export const VERIFIED_SCOPE_HEADER = "x-ryph-verified-scope";

/** The header a `derived-secret-header` row carries its VERIFIED generation in, for a
 * registration with a `generationParam`. Door-written like `VERIFIED_SCOPE_HEADER`, and a
 * sender-sent one is dropped the same way. It says which generation the token was minted for —
 * whether that generation is still current is for the consumer to decide. */
export const VERIFIED_GENERATION_HEADER = "x-ryph-verified-generation";

/** The secret a `derived-secret-header` registration expects for `scope` (and `generation`, for
 * a registration with a `generationParam`) — exported so whoever shows a sender its secret (the
 * connect flow) derives it exactly as the door checks it. */
export async function deriveScopedSecret(
  master: string,
  label: string,
  scope: string,
  generation?: string,
): Promise<string> {
  // Unambiguous because the scope is digits only: no generation-less input has a ":" after the
  // label, so a (scope, generation) input can never equal another scope's plain one.
  return await hmacSha256Hex(
    master,
    generation === undefined ? label + scope : label + scope + ":" + generation,
  );
}

/**
 * The Standard Webhooks scheme (https://www.standardwebhooks.com), as Svix and every sender
 * built on it sign — incident.io among them. Three fixed headers instead of a configurable one:
 * `webhook-id`, `webhook-timestamp` (unix seconds) and `webhook-signature`, which holds one or
 * more space-separated `v1,<base64>` signatures. Each is HMAC-SHA256 over
 * `${id}.${timestamp}.${rawBody}`, keyed with the BASE64-DECODED secret (after an optional
 * `whsec_` prefix), so it binds the body, the delivery id and the moment together.
 *
 * The timestamp is the replay guard the other kinds lack: a request more than five minutes
 * away from the door's clock, in either direction, is refused however good its signature.
 * The secret is always the sender's — nobody mints a `whsec_` for a vendor.
 */
export interface StandardWebhooksVerification {
  kind: "standard-webhooks";
  /** The sender's signing secret as it shows it, `whsec_<base64>` or the bare base64. */
  secret: string;
}

/** The fixed headers a `standard-webhooks` request carries — exported so the header filter
 * and the door agree on the spelling. */
export const STANDARD_WEBHOOKS_HEADERS = {
  id: "webhook-id",
  timestamp: "webhook-timestamp",
  signature: "webhook-signature",
} as const;

/** How far a `standard-webhooks` timestamp may sit from the door's clock, either way. Five
 * minutes, as the Svix libraries default to. */
export const STANDARD_WEBHOOKS_TOLERANCE_MS = 5 * 60_000;

/** A ceiling on accepted requests per rolling window, enforced at the ingestion door after
 * verification — only a holder of the secret can spend the budget. Requests over it are never
 * persisted, and answered 429 — or, with `over: "drop"`, 202. */
export interface IngestRateLimit {
  maxPerWindow: number;
  windowMs: number;
  /** Whose budget a request spends: the registration's one (the default), or — for a
   * `derived-secret-header` mailbox — its verified scope's own, so one scope's token holder
   * floods only their own scope's queue and never another's budget. */
  per?: "registration" | "scope";
  /**
   * Which LANE of that budget a request spends, read from the headers it came with: each lane
   * is a budget of its own (`maxPerWindow` apiece), so a flood of one kind of delivery — a busy
   * merge request's labels and approvals — never drops another kind, a comment that carries a
   * command. The sender wrote those headers, so this must map them to a small fixed set: every
   * name it returns is a budget, and a sender who could mint names would mint budgets. Absent,
   * one lane.
   */
  lane?: (headers: Headers) => string;
  /**
   * What a request over the budget is answered: `refuse` (the default) is 429, `drop` is a 202
   * that stores nothing. For a sender that counts a 4xx toward switching the hook off and never
   * retries anyway — GitLab disables a hook after enough failures, and then every later delivery
   * of the project is lost, the ones under budget too. The registrant hears of each drop through
   * `onOverLimit` and is the one to say so.
   */
  over?: "refuse" | "drop";
}

/** Per-registration delivery behavior: how long one attempt may run before a dead consumer's
 * claim is reclaimed, and how retries back off before the queue steps over the hook. */
export interface DeliveryPolicy {
  /** How long a delivery may hold a hook before the sweep reclaims it. */
  leaseMs: number;
  /** First retry delay; doubles per attempt. */
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** After this many attempts the hook is exhausted and the queue steps over it. */
  maxAttempts: number;
}

export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = {
  leaseMs: 60_000,
  baseBackoffMs: 10_000,
  maxBackoffMs: 15 * 60_000,
  maxAttempts: 10,
};

/** The consumer's verdict on one hook. `terminal: true` means retrying can never help — a
 * payload that does not parse, a receiver that refused it outright — and exhausts the hook
 * immediately rather than burning the retry budget on a foregone conclusion.
 *
 * An ok may name what the hook was CONFIRMED to be about (`dedupeKey`, in the registration's
 * `dedupeKey` vocabulary): the one thing the sweep writes down as taken. The consumer names it
 * only once it checked, somewhere the sender cannot write, that the thing exists — never from
 * the body alone, or a sender could take a name before the real thing is ever delivered. */
export type ConsumeOutcome =
  | { kind: "ok"; dedupeKey?: string }
  | { kind: "failed"; message: string; terminal: boolean };

/** What a registration's `admitDelivery` hands the delivery it let through: whatever it set aside
 * for it, given back by the sweep (`release`) once the delivery is over — the consumer answered,
 * or the claim was lost before it was asked. Released exactly once. */
export interface DeliveryTicket {
  release(): void;
}

/** A registration's word on a due queue head, before the sweep claims it: `go` (with what was set
 * aside for it, if anything), or `wait` — not now, and no attempt spent. */
export type DeliveryAdmission =
  | { kind: "go"; ticket?: DeliveryTicket }
  | { kind: "wait"; reason: string };

/**
 * One rented mailbox: an ingestion endpoint plus the callback that receives its hooks.
 *
 * The consumer is an in-process function on purpose — the registrant mounts this module in
 * its own process, so delivery needs no loopback hop and no second auth surface. Forwarding
 * to an HTTP endpoint, when a registrant ever wants it, is an adapter implementing this same
 * function type, not a change here.
 */
export interface WebhookRegistration {
  /** Stable, caller-chosen, slug-shaped — it is part of the ingestion URL. */
  id: string;
  verification: VerificationConfig;
  /** Hard cap on an inbound body. Oversize is refused before verification. */
  maxBodyBytes: number;
  /** When set, the door enforces it; when absent, ingestion is unthrottled. */
  rateLimit?: IngestRateLimit;
  /** Fires for each verified request over `rateLimit` — refused or dropped — with the verified
   * scope and generation (null where the mailbox has none) and the lane it spent
   * (`IngestRateLimit.lane`, null without lanes): a dropped one leaves no row, so this is the
   * only trace of it. Must not throw, and must be cheap: a flood calls it once per request. */
  onOverLimit?: (scope: string | null, generation: string | null, lane: string | null) => void;
  /**
   * The registrant's say, at the door, over a VERIFIED scope (and generation) of a
   * `derived-secret-header` mailbox: false is answered 403 and nothing is stored. A credential
   * proves who minted it, not that the registrant still wants it — a scope it stopped serving,
   * a generation it rotated away — and this is how such a delivery costs no row. Asked after
   * verification, so only a holder of a credential reaches it; it should answer fast (the
   * sender is waiting) and may cache. A throw is answered 503, and nothing is stored.
   */
  admitScope?: (scope: string, generation: string | undefined) => Promise<boolean>;
  /** How long a terminal (`delivered` or `exhausted`) hook is kept after its last update before
   * the sweep deletes it. Absent: kept for good. */
  retainTerminalMs?: number;
  /**
   * The registrant's name for WHAT a hook is about, where many hooks can name the same thing and
   * one taken is all of them taken — a GitLab note, which any token holder can ring for again.
   * Asked of a hook once the sweep has claimed it, before the consumer: a hook whose key an
   * earlier hook of the same queue was DELIVERED under is delivered on the spot and the consumer
   * never sees it, so a replay costs one indexed read instead of whatever the consumer spends.
   * Null means the hook has no such name and is always consumed. Must be pure and cheap: it
   * reads the raw, untrusted body.
   *
   * This only ever LOOKS a key up. What a delivered hook is written down under is the consumer's
   * word (`ConsumeOutcome`'s `dedupeKey`), given once it confirmed the thing exists — never this
   * function's reading of the body, or a sender could ring first with the name of something not
   * yet written and have the real one dropped when it came. A failed or exhausted hook writes
   * nothing, nor does one dropped as a duplicate, and a key counts only while its hook is
   * retained (`retainTerminalMs`).
   */
  dedupeKey?: (hook: Hook) => string | null;
  /**
   * Asked of a due queue head BEFORE the sweep claims it: whether the registrant can afford to
   * deliver it now — a budget of calls the consumer makes that every queue of the mailbox shares.
   * `wait` leaves the head exactly as it is, `pending`, its attempts untouched, and its queue
   * stopped for the rest of the pass; the next pass asks again. That is the difference from a
   * consumer's retryable failure: a delivery the registrant is not ready for has not failed, and
   * a flood of other queues must not burn a hook's retry budget away while it waits its turn.
   * Nothing is written, so no fencing is needed either. A `go` may carry a `DeliveryTicket`: it
   * is handed to the consumer and released once the delivery is over, whatever became of it.
   * Must be cheap and must not throw (a throw is a `wait`).
   */
  admitDelivery?: (hook: Hook) => DeliveryAdmission;
  policy: DeliveryPolicy;
  /** Receives a hook, and the ticket `admitDelivery` let it through with, if any. */
  consumer: (hook: Hook, ticket?: DeliveryTicket) => Promise<ConsumeOutcome>;
}

/** As `WebhookRegistration`, with the knobs a registrant rarely cares about defaulted. */
export interface WebhookRegistrationInput {
  id: string;
  verification: VerificationConfig;
  maxBodyBytes?: number;
  rateLimit?: IngestRateLimit;
  onOverLimit?: WebhookRegistration["onOverLimit"];
  admitScope?: WebhookRegistration["admitScope"];
  retainTerminalMs?: number;
  dedupeKey?: WebhookRegistration["dedupeKey"];
  admitDelivery?: WebhookRegistration["admitDelivery"];
  policy?: Partial<DeliveryPolicy>;
  consumer: WebhookRegistration["consumer"];
}

/**
 * - `pending`     waiting its turn (a set `nextAttemptAt` is a retry clock still running)
 * - `delivering`  a sweep holds the lease and is calling the consumer
 * - `delivered`   the consumer reported success — terminal
 * - `exhausted`   the retry budget is spent, or the consumer said the failure is permanent.
 *                 Terminal, and STEPPED OVER: unlike everything before it, it no longer gates
 *                 the hooks behind it. The row stays for audit, and `retryHook` re-queues it —
 *                 until a registration's `retainTerminalMs` passes, as for `delivered`.
 */
export type HookState = "pending" | "delivering" | "delivered" | "exhausted";

export const TERMINAL_HOOK_STATES: ReadonlySet<HookState> = new Set(["delivered", "exhausted"]);

/** One ingested webhook, as received: raw body bytes-as-text plus the headers that came with
 * it, minus the ones a credential rides on — the verification header itself is never written
 * down, nor `authorization`, a cookie or a signature (see `helpers/headers.ts`).
 * `seq` is the FIFO key — assigned by the store at insert, monotonic per table. */
export interface Hook {
  id: string;
  registrationId: string;
  /**
   * The scope the door VERIFIED the credential for — set only for a `derived-secret-header`
   * registration, null for every other kind and for a hook minted with `enqueue()`. It splits a
   * mailbox's queue: FIFO holds per (registration, scope), so one GitLab project's hook waiting
   * out a retry clock holds up that project's later hooks and nobody else's. A null scope is one
   * queue per registration, exactly as for a mailbox that has no scopes at all.
   */
  scope: string | null;
  seq: number;
  headers: Record<string, string>;
  /** The RAW request body, byte-faithful — what the signature was verified over. */
  body: string;
  state: HookState;
  attempts: number;
  nextAttemptAt: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  receivedAt: string;
  deliveredAt: string | null;
  updatedAt: string;
  /** What the consumer confirmed a DELIVERED hook was about (`ConsumeOutcome`'s `dedupeKey`),
   * looked up by the registration's `dedupeKey`; null on every other row. */
  dedupeKey: string | null;
}

/** A hook before the store assigned its `seq`. */
export type NewHook = Omit<Hook, "seq">;

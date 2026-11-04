// The ingestion door: `POST /v1/hooks/:registrationId`. The whole contract in one line —
// verify transport authenticity, persist the raw request, answer 202 (between the two, a scoped
// mailbox's registrant may refuse the verified scope, and a rate limit may refuse or drop it). Nothing here reads the
// payload; the sender gets its answer before any consumer runs, which is what keeps a slow
// consumer from ever costing a delivery (GitHub does not retry a timeout).
//
// "Raw" stops at the credential: the body is stored byte-faithful, and the headers are stored
// minus the ones a secret rides on (`helpers/headers.ts`) — a verified request has already
// spent its credential by the time the row is written.
//
// Verification lives in this layer, not in core: checking a request header against request
// bytes is boundary work, and it keeps the core platform-pure.

import type { Diagnostics } from "../ports/diagnostics.ts";
import type { HookStore } from "../ports/hook_store.ts";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import {
  deriveScopedSecret,
  type Hook,
  STANDARD_WEBHOOKS_HEADERS,
  STANDARD_WEBHOOKS_TOLERANCE_MS,
  VERIFIED_GENERATION_HEADER,
  VERIFIED_SCOPE_HEADER,
  type WebhookRegistration,
} from "../core/types.ts";
import { openHook } from "../core/hook_lifecycle.ts";
import { mintHookId } from "../helpers/ids.ts";
import { storableHeaders } from "../helpers/headers.ts";
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from "@ryph/sealed";
import { json, readCappedBytes, type Route, route } from "@ryph/shared/http";

export interface IngestDeps {
  registry: ReadonlyMap<string, WebhookRegistration>;
  store: HookStore;
  diag: Diagnostics;
  now(): Date;
  /** Told of each hook stored, once it is durable — the mailroom hands it to its mailbox's
   * drain (`setup`). Must not throw. */
  onIngested?: (hook: Hook) => void;
  /** Fires when a verified request is refused by a registration's rate limit — the one refusal
   * the registrant may want to record, since it never leaves a row behind. Must not throw. */
  onRateLimited?: (registrationId: string) => void;
}

/** Checks the request against the registration's verification config. Every kind collapses a
 * missing and a mismatched credential into one answer on purpose — a prober learns nothing
 * but "no". */
async function verifyRequest(
  verification: WebhookRegistration["verification"],
  req: Request,
  body: Uint8Array,
  now: Date,
): Promise<
  {
    verified: boolean;
    presented: "missing" | "mismatch" | "stale";
    scope?: string;
    generation?: string;
  }
> {
  if (verification.kind === "standard-webhooks") {
    return verifyStandardWebhooks(verification.secret, req, body, now);
  }
  const presented = req.headers.get(verification.header);
  if (presented === null) return { verified: false, presented: "missing" };
  if (verification.kind === "derived-secret-header") {
    // The scope is read off the URL, never the body: nothing is parsed before the credential
    // holds. Digits only and bounded, so the value MACed is exactly the id it names — a scope
    // with a separator in it could be made to collide with another's derivation input.
    const query = new URL(req.url).searchParams;
    const scope = query.getAll(verification.scopeParam);
    if (scope.length !== 1 || !/^\d{1,20}$/.test(scope[0]!)) {
      return { verified: false, presented: "mismatch" };
    }
    // The generation, when the registration uses them, is read the same way and held to the same
    // shape: exactly one, digits only, bounded. A request without one is refused rather than
    // checked against the generation-less derivation — that would let a token minted before
    // generations existed outlive every rotation.
    let generation: string | undefined;
    if (verification.generationParam !== undefined) {
      const sent = query.getAll(verification.generationParam);
      if (sent.length !== 1 || !/^\d{1,10}$/.test(sent[0]!)) {
        return { verified: false, presented: "mismatch" };
      }
      generation = sent[0]!;
    }
    if (verification.master === "") return { verified: false, presented: "mismatch" };
    const wanted = await deriveScopedSecret(
      verification.master,
      verification.label,
      scope[0]!,
      generation,
    );
    const [a, b] = [await sha256Hex(presented), await sha256Hex(wanted)];
    return { verified: timingSafeEqual(a, b), presented: "mismatch", scope: scope[0]!, generation };
  }
  // An empty secret is a door anyone can open — an HMAC under an empty key is computable by
  // all, and an empty secret header matches an empty value. Registrants never register one; a
  // registration that somehow does fails closed here rather than open.
  if (verification.secret === "") return { verified: false, presented: "mismatch" };
  switch (verification.kind) {
    case "hmac-sha256": {
      // HMAC over the RAW bytes, compared in constant time. Both sides are lowercased so a
      // prefix configured as "SHA256=" still matches — the compare is case-insensitive by
      // contract, and lowercasing only the presented side would 401 every delivery forever.
      //
      // The header may carry several signatures — PagerDuty sends `v1=<a>,v1=<b>` while a
      // secret rotates — so it is split on commas and whitespace and passes when ANY part
      // matches. Every part is compared, matched or not, so the time taken says nothing about
      // which one did. A single-signature header is just the one-part case.
      const expected = (verification.prefix + await hmacSha256Hex(verification.secret, body))
        .toLowerCase();
      const verified = anyPartMatches(presented.toLowerCase().split(/[\s,]+/), expected);
      return { verified, presented: "mismatch" };
    }
    case "secret-header": {
      // The secret verbatim, behind the configured scheme (`Bearer `) when there is one; both
      // sides are hashed first so the compare is constant-time without leaking the secret's
      // length through an early length check.
      const wanted = (verification.prefix ?? "") + verification.secret;
      const [a, b] = [await sha256Hex(presented), await sha256Hex(wanted)];
      return { verified: timingSafeEqual(a, b), presented: "mismatch" };
    }
  }
}

/** Whether any of `parts` equals `expected`, comparing every part in constant time and never
 * stopping early. Empty parts (a trailing comma) are skipped — they can never match. */
function anyPartMatches(parts: readonly string[], expected: string): boolean {
  let matched = false;
  for (const part of parts) {
    if (part === "") continue;
    if (timingSafeEqual(part, expected)) matched = true;
  }
  return matched;
}

/**
 * The Standard Webhooks check (Svix, incident.io): HMAC-SHA256 over
 * `${webhook-id}.${webhook-timestamp}.${rawBody}`, keyed with the base64-decoded secret, sent
 * base64 as one or more space-separated `v1,<sig>` parts — any one matching passes. The
 * timestamp must sit within five minutes of the door's clock either way: the signature binds
 * it, so a captured request cannot be replayed later with a fresh one.
 *
 * The body joins the signed content as its raw BYTES, not re-encoded text, for the same reason
 * the hmac kind signs bytes: what the sender signed is what arrived.
 */
function verifyStandardWebhooks(
  secret: string,
  req: Request,
  body: Uint8Array,
  now: Date,
): { verified: boolean; presented: "missing" | "mismatch" | "stale" } {
  const id = req.headers.get(STANDARD_WEBHOOKS_HEADERS.id);
  const timestamp = req.headers.get(STANDARD_WEBHOOKS_HEADERS.timestamp);
  const signature = req.headers.get(STANDARD_WEBHOOKS_HEADERS.signature);
  if (id === null || timestamp === null || signature === null) {
    return { verified: false, presented: "missing" };
  }
  // Unix seconds, digits only — anything else is not a timestamp this scheme sends.
  if (!/^\d{1,12}$/.test(timestamp.trim())) return { verified: false, presented: "mismatch" };
  const sentMs = Number(timestamp.trim()) * 1000;
  if (Math.abs(now.getTime() - sentMs) > STANDARD_WEBHOOKS_TOLERANCE_MS) {
    return { verified: false, presented: "stale" };
  }
  // Node's base64 decoder skips what it cannot read, so a secret that is not base64 (or is
  // empty after `whsec_`) decodes to an EMPTY key — an HMAC anyone can compute. That fails
  // closed: no request verifies against a key with nothing in it.
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  if (key.length === 0) return { verified: false, presented: "mismatch" };
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest("base64");
  // Each part is `<version>,<signature>`; only `v1` is a version this door speaks. A part of
  // another version is skipped rather than refused — a sender may add one alongside.
  const candidates = signature.split(/\s+/)
    .map((part) => part.startsWith("v1,") ? part.slice(3) : "")
    .filter((sig) => sig !== "");
  // Base64 is case-sensitive, so unlike the hex kind nothing is lowercased here.
  return { verified: anyPartMatches(candidates, expected), presented: "mismatch" };
}

/** How many rate-limit windows are kept before the idle ones are swept out. */
const MAX_IDLE_WINDOWS = 1_000;

export function ingestRoutes(deps: IngestDeps): Route[] {
  const { registry, store, diag } = deps;
  // Sliding-window request timestamps per registration (or per registration and scope), and per
  // lane where the mailbox has lanes, pruned on use. In memory like the registry itself: a restart forgets the counts, which errs on
  // accepting — the limit guards cost, not correctness.
  const recentAccepts = new Map<string, number[]>();
  // Per-scope windows are one per verified scope, so the map is swept of idle ones once it
  // grows: a window whose last accept is older than every registration's window is empty.
  const forgetIdleWindows = (nowMs: number) => {
    if (recentAccepts.size <= MAX_IDLE_WINDOWS) return;
    const longest = Math.max(
      0,
      ...[...registry.values()].map((r) => r.rateLimit?.windowMs ?? 0),
    );
    for (const [key, accepts] of recentAccepts) {
      if ((accepts.at(-1) ?? 0) <= nowMs - longest) recentAccepts.delete(key);
    }
  };

  return [
    route("POST", "/v1/hooks/:registrationId", async (req, params) => {
      const registration = registry.get(params.registrationId);
      if (registration === undefined) {
        // Uniform with an unknown path: an unbound id is not a probe-worthy difference.
        return json(404, { error: "not found" });
      }

      // The cap guards memory on an unauthenticated, internet-facing route, so it is
      // enforced WHILE reading: a declared Content-Length over the cap is refused before a
      // byte is buffered, and the stream itself is cut the moment it crosses the cap —
      // Content-Length is a claim, and a body sent without one gets no free pass.
      const read = await readCappedBytes(req, registration.maxBodyBytes);
      if (!read.ok) return json(413, { error: "body exceeds the registration's size cap" });
      const body = read.bytes;

      const verdict = await verifyRequest(registration.verification, req, body, deps.now());
      if (!verdict.verified) {
        // The registration id is safe to log; the body is not ours to leak, even to a log.
        diag.warn("webhooks.verify_failed", {
          registrationId: registration.id,
          signature: verdict.presented,
        });
        return json(401, { error: "signature verification failed" });
      }

      // The registrant's say over the verified scope, before anything is stored: a credential it
      // minted once for a scope it no longer serves, or a generation it has since rotated away,
      // still verifies above — and must cost no row. After verification, so only a holder of a
      // credential ever makes the registrant answer.
      if (registration.admitScope !== undefined && verdict.scope !== undefined) {
        let admitted: boolean;
        try {
          admitted = await registration.admitScope(verdict.scope, verdict.generation);
        } catch (err) {
          diag.warn("webhooks.admit_unanswered", {
            registrationId: registration.id,
            err: String(err),
          });
          return json(503, { error: "the registrant could not be asked" });
        }
        if (!admitted) {
          diag.warn("webhooks.scope_refused", {
            registrationId: registration.id,
            scope: verdict.scope,
          });
          return json(403, { error: "not accepted for this scope" });
        }
      }

      // The rate limit sits AFTER verification so only a holder of the secret can spend the
      // budget — a stranger hammering the URL collects 401s and consumes nothing. A refused
      // request leaves no row, so the kicks below are how a registrant hears about it at all.
      // Per scope, each verified scope spends a budget of its own: one scope's token is one
      // sender, and its flood must not starve another's deliveries. Over it, a mailbox whose
      // sender switches a hook off on 4xx answers 202 and drops (`over: "drop"`): the delivery is
      // lost either way, and a 429 would cost every later one too. And a mailbox may split each
      // budget into lanes by the kind of delivery (`IngestRateLimit.lane`), so one kind's flood —
      // a busy merge request's churn — never drops another's, a comment carrying a command.
      const limit = registration.rateLimit;
      if (limit !== undefined) {
        const nowMs = deps.now().getTime();
        const scoped = limit.per === "scope" && verdict.scope !== undefined;
        const lane = limit.lane?.(req.headers) ?? null;
        const key = JSON.stringify([registration.id, scoped ? verdict.scope : null, lane]);
        const accepts = (recentAccepts.get(key) ?? []).filter((at) => at > nowMs - limit.windowMs);
        if (accepts.length >= limit.maxPerWindow) {
          recentAccepts.set(key, accepts);
          diag.warn("webhooks.rate_limited", {
            registrationId: registration.id,
            ...(scoped ? { scope: verdict.scope } : {}),
            ...(lane === null ? {} : { lane }),
          });
          deps.onRateLimited?.(registration.id);
          registration.onOverLimit?.(verdict.scope ?? null, verdict.generation ?? null, lane);
          if (limit.over === "drop") return json(202, { dropped: true });
          return json(429, { error: "rate limit exceeded" });
        }
        accepts.push(nowMs);
        recentAccepts.set(key, accepts);
        forgetIdleWindows(nowMs);
      }

      const hook = await store.recordHook(openHook({
        id: mintHookId(),
        registrationId: registration.id,
        // The verified scope picks the queue the hook waits in (see `Hook.scope`): taken from
        // the verdict, never from anything the sender could set without the credential.
        scope: verdict.scope ?? null,
        // Every header the sender sent EXCEPT the ones carrying a credential — see
        // `helpers/headers.ts`. The row is the one thing here that outlives the request.
        headers: {
          ...storableHeaders(req.headers, registration.verification),
          // The scope (and generation) the credential was derived for, as the door verified them
          // — the only headers in the row the sender did not write (sent ones were dropped
          // above).
          ...(verdict.scope === undefined ? {} : { [VERIFIED_SCOPE_HEADER]: verdict.scope }),
          ...(verdict.generation === undefined
            ? {}
            : { [VERIFIED_GENERATION_HEADER]: verdict.generation }),
        },
        // Decoded once, stored as text: webhook bodies are UTF-8 JSON by every contract this
        // module accepts, and the signature was already checked over the true bytes above.
        body: new TextDecoder().decode(body),
      }, deps.now().toISOString()));

      diag.debug("webhooks.ingested", { registrationId: registration.id, hookId: hook.id });
      // Durable first, kick second: the 202 below is true whether or not anyone is listening.
      deps.onIngested?.(hook);

      return json(202, { id: hook.id });
    }),
  ];
}

// The data plane: one pure-ish `Request → Response` handler that authenticates a virtual key,
// enforces its frozen scope, and forwards the request to the real provider with the real key.
//
// The hot path is deliberately dumb — hash the presented token, one row lookup, one row read,
// a pure `decide()`, then a streamed passthrough. Everything stateful (keys, scopes, usage)
// lives in the shared store, so a proxy restart mid-run is a non-event.
//
// Invariants:
// - the REAL key exists in plaintext only inside this handler's forward call, never in a
//   response, a log, or an error message
// - every provider serves a run only the routes core/endpoints.ts lists (its model calls and its
//   models list); a BUILT-IN also only an allowlist of headers each way. The real key reaches
//   far more than model calls, and nothing else it reaches can be held to an allowlist or a cap
// - the model allowlist is enforced HERE, server-side — the harness's --model flag is a
//   preference, this is the policy — and against the request whatever its content-type claims
// - the model a usage row is PRICED on comes off the response, not off the request: the caller's
//   payload may name an alias, which resolves upstream to a dated snapshot
// - responses stream through untouched: buffering an SSE completion would stall every token
// - usage recording is fire-and-forget: metering must never fail or slow a model call
// - the provider is resolved PER REQUEST through the store (built-ins ∪ custom rows), so
//   registering or archiving an endpoint takes effect on the next request with no restart and
//   no cache to go stale — the same stance the live provider-key liveness check takes
// - the caps are the ONE stateful thing in this process (see spend_meter.ts): what a run has
//   spent is seeded from the store the first time the process sees the run and then counted here
//   as each row is priced, so the cap is judged from a map lookup rather than an aggregate per
//   call. The price list the caps count with is re-read once a minute, not per request: a
//   declared rate an admin edits is a minute late for the cap and exactly on time for the report
// - a CHATGPT PLAN key is the one provider whose request is rewritten (core/chatgpt_plan.ts): two
//   routes only, `store: false` and `stream: true` forced, refused fields stripped, what the plan
//   wants in another shape reshaped (and its tool calls shaped back on the way out, streamed or
//   assembled), refused features answered with a 400 that names them. Its body has its own,
//   smaller cap (it is parsed, not scanned), only an allowlist of headers and no query string
//   go up with it, and its credential is an access token refreshed on the way
//   (core/plan_keys.ts), never a sealed key read straight out of the row. A refusal from it is
//   never answered by trying another key

import {
  CHATGPT_PLAN,
  errorCodeOf,
  makePlanStreamRestorer,
  MAX_PLAN_BODY_BYTES,
  PLAN_LOCAL_ONLY,
  PLAN_LOCAL_ONLY_CODE,
  type PlanRoute,
  planRoute,
  restorePlanPayload,
  rewritePlanRequest,
  USAGE_LIMIT_CODE,
} from "../core/chatgpt_plan.ts";
import {
  forwardedRequestHeaders,
  keepCustomQuery,
  type ProviderRoute,
  providerRoute,
  providerRouteLabels,
  returnedResponseHeaders,
} from "../core/endpoints.ts";
import { authenticates, decide, type ProxiedRequest, type SpendState } from "../core/enforce.ts";
import { makeUsageMeter, type UsageMeter } from "../core/metering.ts";
import {
  askForStreamUsage,
  DRAIN_MS,
  estimatedInputTokens,
  estimatedTokens,
  FALLBACK_OUTPUT_TOKENS,
  MAX_DRAIN_BYTES,
  MAX_OUTPUT_FIELDS,
  requestedMaxOutput,
} from "../core/usage_fallback.ts";
import { REFUSED_TOP_LEVEL_FIELDS, refusedInBody } from "../core/body_policy.ts";
import { modelOf, rawValue, topLevelMembers, type ValueSpan } from "../core/model_field.ts";
import type { PlanKeys } from "../core/plan_keys.ts";
import { included, priceFor, type PriceOverlay, priceOverlayOf } from "../core/pricing.ts";
import { makeResponsesStreamReader } from "../core/responses_stream.ts";
import type { ProviderSpec } from "../core/registry.ts";
import { resolveProvider } from "../core/service.ts";
import { CREDENTIAL_VALUE_PATTERN, refusedExtraHeader, sendableHeaders } from "../core/registry.ts";
import { SECRET_REQUIRED } from "./routes.ts";
import {
  endpointAddressProblem,
  privateModelEndpointsAllowed,
  type ResolveHost,
  systemResolveHost,
} from "../schema.ts";
import { priceRecord, refreshGauge, spendOfRun } from "../core/spend.ts";
import type { DeploymentGauge, SpendMeter } from "../core/spend_meter.ts";
import { NO_SECRET, type ProviderKey, type UsageRecord } from "../core/types.ts";
import type { KeyStore } from "../ports/key_store.ts";
import { bearerToken, type SealBinding, sha256Hex } from "@ryph/sealed";
import { json } from "@ryph/shared/http";
import { providerKeyBinding } from "../core/sealing.ts";

export interface ProxyDiag {
  debug(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
}

export interface ProxyHandlerDeps {
  store: KeyStore;
  /** Unseals a provider key row, bound to it (`providerKeyBinding`) — built by the composition
   * root from the master key. */
  decrypt(sealed: string, binding: SealBinding): Promise<string>;
  now(): Date;
  diag: ProxyDiag;
  /** The per-run spend bookkeeping, and the deployment's ceiling when one is set. */
  limits: { meter: SpendMeter; gauge: DeploymentGauge | null };
  /** Where each provider's real API lives; overridden in tests to point at a fake upstream. */
  baseUrlFor?: (provider: ProviderSpec) => string;
  /** The outbound fetch; injectable for tests. */
  upstreamFetch?: (url: URL, init: RequestInit) => Promise<Response>;
  /** The request-body cap; MAX_REQUEST_BODY_BYTES unless a test lowers it. */
  maxRequestBodyBytes?: number;
  /** How long a billed call is read on after its caller hung up; DRAIN_MS unless a test
   * shortens it. */
  drainMs?: number;
  /** Resolves a custom endpoint's host before a forward (`endpointAddressProblem`); the
   * platform's DNS unless a test fakes it. */
  resolveHost?: ResolveHost;
  /** A ChatGPT plan key's tokens and state. Absent — a deployment that is not local — plan keys
   * are refused with a 403. */
  plan?: Pick<PlanKeys, "accessToken" | "markLimited" | "clearLimited">;
}

/** How much of a plan's error body is read to find its code and relayed. Error bodies are
 * small; one past this is cut off unread and answered with a short error of the proxy's own. */
const MAX_PLAN_ERROR_BYTES = 1024 * 1024;

/** What a plan call carries from its preparation to its forward. */
interface PlanCall {
  key: ProviderKey;
  route: PlanRoute;
  /** Whether the caller asked for a stream; upstream always streams. */
  clientStreams: boolean;
  token: string;
  /** The tools the rewrite grouped under a namespace, whose calls are shaped back; null when
   * it grouped none and the answer passes through untouched. */
  groupedTools: ReadonlySet<string> | null;
}

/**
 * The largest request body the proxy reads: 64 MiB. A request is buffered whole (the model it
 * names is read out of it before anything is forwarded), so without a cap one caller holding a
 * credential could make the proxy hold any amount. A run's images extension holds every request
 * pi builds to at most 16 MiB of image base64 plus the conversation's text; 64 MiB is headroom
 * above that and above Anthropic's own 32 MB request limit (the providers refuse past their own
 * limits anyway), so it only has to sit above every request a provider would take.
 */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

/**
 * The body's bytes, or null once more than `max` arrived or were announced — the rest cancelled
 * unread. Counted as it streams: a chunked body announces no length, and buffering first to
 * measure after is the unbounded read the cap exists to prevent.
 *
 * Held ONCE: with images a turn can be tens of megabytes, so the bytes go straight into one
 * buffer as they arrive — sized by the Content-Length a client's SDK sends, grown by doubling
 * when it sent none (or under-announced) — never kept as chunks and then copied, never decoded
 * into a string. The same bytes are what is forwarded and what the model is read from
 * (`modelNamedIn`, core/model_field.ts, which walks them without parsing them into objects).
 * That single buffer is why this is not @ryph/shared/http's `readCappedBytes`, which keeps the
 * chunks and copies them once at the end: twice the peak for a body this size.
 */
async function readRequestBytes(
  req: Request,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) {
    await req.body?.cancel().catch(() => {});
    return null;
  }
  if (req.body === null) return new Uint8Array();
  const reader = req.body.getReader();
  let buf: Uint8Array<ArrayBuffer> = new Uint8Array(
    Number.isInteger(declared) && declared > 0 ? declared : 64 * 1024,
  );
  let seen = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const next = seen + value.byteLength;
    if (next > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    if (next > buf.length) {
      const grown = new Uint8Array(Math.min(max, Math.max(buf.length * 2, next)));
      grown.set(buf.subarray(0, seen));
      buf = grown;
    }
    buf.set(value, seen);
    seen = next;
  }
  // A view, not a copy: exact when the length was announced, at most twice the body when not.
  // (An announced length is allocated up front, but only from an authenticated caller, and
  // under the cap; the pages of a fresh buffer cost nothing until bytes land in them.)
  return seen === buf.length ? buf : buf.subarray(0, seen);
}

/** An upstream's error answer, which is small and whose length nothing announces reliably: its
 * bytes, or null past MAX_PLAN_ERROR_BYTES, the rest cancelled unread. Not `readCappedBytes`,
 * which throws on a reset: one broken off mid-read is relayed as far as it came, so a usage
 * limit cut off after its first chunk still carries its code. */
async function errorAnswerBytes(
  body: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > MAX_PLAN_ERROR_BYTES) {
        reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    // Broken off: relayed as far as it came.
  }
  const bytes = new Uint8Array(seen);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** How long a custom endpoint's host is trusted to resolve outside the network once it has. */
const ADDRESS_TTL_MS = 30_000;

/** How long the caps trust one reading of the custom endpoints' declared rates. */
const OVERLAY_TTL_MS = 60_000;

/** `{"detail": {"code": …}}`, the other shape OpenAI's backend answers a refusal in. */
function detailCodeOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const detail = (payload as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const code = (detail as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** The code in a parsed refusal, wherever OpenAI put it. */
function refusalCodeOf(payload: unknown): string | null {
  return errorCodeOf(payload) ?? detailCodeOf(payload);
}

/**
 * The code in a plan refusal's `x-error-json` header: base64-encoded JSON shaped like an error
 * body. The ChatGPT backend sends it on a 401 whose body says only `{"detail":"Unauthorized"}`.
 */
function headerRefusalCodeOf(headers: Headers): string | null {
  const encoded = headers.get("x-error-json");
  if (encoded === null || encoded.length > MAX_PLAN_ERROR_BYTES) return null;
  try {
    const binary = atob(encoded.trim().replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return refusalCodeOf(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

/**
 * A refusal no retry of the same request can change — a secret to enter again, an endpoint to
 * fix, a provider this deployment does not know. `x-should-retry: false` is what Anthropic's and
 * OpenAI's SDKs read before their own backoff, which would otherwise retry a 409 or a 5xx several
 * times over before the harness ever saw the code.
 */
function final(status: number, body: unknown): Response {
  const response = json(status, body);
  response.headers.set("x-should-retry", "false");
  return response;
}

/**
 * Where a request is forwarded, or null when it may not be. The provider's `clientBasePath` —
 * the segment the CLIENT already had in its base URL — is stripped off the incoming path, and
 * what is left is appended to the upstream's base URL **including its own path**. That last part
 * is the whole point: an admin's endpoint is
 * `https://api.cloudflare.com/client/v4/accounts/X/ai/v1`, and replacing the target's pathname
 * (as this used to do) would throw all of that away and POST to `/chat/completions` at the
 * domain root.
 *
 * | baseUrl | clientBasePath | incoming | → |
 * | `https://api.anthropic.com` | `""` | `/v1/messages` | `…/v1/messages` |
 * | `https://api.openai.com/v1` | `/v1` | `/v1/chat/completions` | `…/v1/chat/completions` |
 * | `https://host/a/v1` | `/v1` | `/v1/chat/completions` | `https://host/a/v1/chat/completions` |
 *
 * When `clientBasePath` is non-empty, a path that does not carry it is REFUSED (null) rather
 * than appended whole. It used to be appended, and that was a hole: the credential issuer hands
 * the client a base URL ending in the prefix, so nothing correctly configured can ever omit it —
 * while forwarding it anyway gave every upstream endpoint two spellings on this listener, and
 * the path-based rules only ever policed the prefixed one. `POST /chat/completions` bought
 * tokens with the real key under an allowlist that never got to look. One spelling, or none.
 * Anthropic's empty prefix is unaffected: there is no segment to be missing.
 *
 * Pure, so the table above and the refusal are unit tests.
 */
export function forwardTarget(baseUrl: string, clientBasePath: string, url: URL): URL | null {
  const incoming = url.pathname;
  let rest = incoming;
  if (clientBasePath !== "") {
    if (incoming !== clientBasePath && !incoming.startsWith(`${clientBasePath}/`)) return null;
    rest = incoming.slice(clientBasePath.length);
  }
  const target = new URL(baseUrl);
  const base = target.pathname.replace(/\/+$/, "");
  target.pathname = `${base}${rest}` || "/";
  target.search = url.search;
  return target;
}

/** The credential however the provider's SDK sent it: Anthropic's x-api-key, or a bearer. */
function presentedToken(req: Request): string | null {
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) return apiKey;
  return bearerToken(req);
}

/**
 * Whether a request is about to buy tokens — the input `decide()` fails closed on: what its
 * route says (core/endpoints.ts). Every route that takes a body is policed, the models lists
 * are not, and a route that is not listed never gets this far (a plan's is refused by its own
 * table, after `decide`, so it is waved through here).
 */
function spendsTokens(
  provider: ProviderSpec | null,
  route: ProviderRoute | null,
  hasBody: boolean,
): boolean {
  // An unresolvable provider is about to 502 anyway; saying "spends" keeps the fail-closed end.
  if (provider === null) return hasBody;
  return route?.spends ?? false;
}

/**
 * The 404 for a route a provider does not serve to a run: batches, files, fine-tuning, stored
 * responses, the organization's admin API, a gateway's key-info route. Named, with what IS
 * served, so an agent that tried one reads why instead of retrying.
 */
function routeRefusal(provider: ProviderSpec, method: string, pathname: string): Response {
  return json(404, {
    error: `${method} ${pathname} is not available through the model proxy; ` +
      `${provider.label} serves ${providerRouteLabels(provider).join(", ")}`,
    code: "endpoint_not_allowed",
  });
}

/** Whether a Responses body asks to run in the background: anything but absent, `false` or
 * `null`. A background response answers its POST before any token is spent and is collected
 * later, so no usage ever passes through here to be counted. */
function asksForBackground(body: Uint8Array, members: Map<string, ValueSpan>): boolean {
  const span = members.get("background");
  if (span === undefined) return false;
  if (span.end - span.start > 5) return true;
  const value = rawValue(body, span);
  return value !== "false" && value !== "null";
}

/** The 400 for a body that asks for what core/body_policy.ts refuses, each thing named. */
function bodyRefusal(refused: string[]): Response {
  return json(400, {
    error: `the model proxy does not forward ${refused.join("; ")}. Tools must be client-side ` +
      "(function) tools, and images and files must be sent inline",
    code: "body_not_allowed",
    refused,
  });
}

/** The top-level members of a request body the proxy reads, in the one walk over it: the model,
 * `background`, what says whether and how long it streams, and the fields core/body_policy.ts
 * refuses. */
const READ_MEMBERS: ReadonlySet<string> = new Set([
  "model",
  "background",
  "stream",
  "stream_options",
  ...MAX_OUTPUT_FIELDS,
  ...REFUSED_TOP_LEVEL_FIELDS,
]);

/** The members read that carry something other than `null`. */
function presentMembers(body: Uint8Array, members: Map<string, ValueSpan>): Set<string> {
  const present = new Set<string>();
  for (const [name, span] of members) {
    if (span.end - span.start !== 4 || rawValue(body, span) !== "null") present.add(name);
  }
  return present;
}

/** The marker on a custom endpoint whose stored headers cannot be sent (see
 * `endpointHeadersProblem`). */
export const ENDPOINT_MISCONFIGURED = "endpoint_misconfigured";

/** The marker on a ChatGPT plan whose access token cannot ride a header (not visible ASCII). */
export const CREDENTIAL_HEADER_REFUSED = "credential_header_refused";

// Hop-by-hop and connection-managed headers that must not be forwarded either way.
const STRIP_REQUEST = ["host", "authorization", "x-api-key", "content-length", "connection"];
// The body fetch hands over is decoded, so its encoding and length go too.
const STRIP_RESPONSE = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
];

/** An upstream's headers for a body read here and answered whole: hop-by-hop ones dropped. */
function relayedHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  for (const name of STRIP_RESPONSE) headers.delete(name);
  return headers;
}

/**
 * The status a row carries when the response STREAM did not finish: the upstream opened with a
 * 200 and the body then failed, or the caller hung up on it. Recording the 200 would count a
 * truncated completion as a success — "none failed" on a run whose answers were cut off, with
 * whatever tokens arrived before the cut. 499 is the caller-went-away code, and like any 4xx a
 * report counts it among the failures.
 */
const STREAM_CUT_STATUS = 499;

export function makeProxyHandler(deps: ProxyHandlerDeps): (req: Request) => Promise<Response> {
  const upstreamFetch = deps.upstreamFetch ?? fetch;
  const baseUrlFor = deps.baseUrlFor ?? ((p: ProviderSpec) => p.baseUrl);
  const { meter, gauge } = deps.limits;

  // Hostname → until when it is known to resolve outside the network. Only a pass is kept: a
  // refusal is asked again, so a fixed record serves on the next request.
  const addressesOk = new Map<string, number>();
  /** Why a custom endpoint's host may not be dialled, or null (`endpointAddressProblem`). */
  const dialProblem = async (target: URL, nowMs: number): Promise<string | null> => {
    const host = target.hostname;
    if ((addressesOk.get(host) ?? 0) > nowMs) return null;
    const problem = await endpointAddressProblem(
      target.href,
      privateModelEndpointsAllowed(),
      deps.resolveHost ?? systemResolveHost,
    );
    // One that does not resolve is fetch's to fail on, as it will.
    if (problem === null || problem.kind === "unresolvable") {
      if (addressesOk.size > 1024) addressesOk.clear();
      if (problem === null) addressesOk.set(host, nowMs + ADDRESS_TTL_MS);
      return null;
    }
    return problem.detail;
  };

  let overlayCache: { overlay: PriceOverlay; freshUntilMs: number } | null = null;
  const overlayAt = async (nowMs: number): Promise<PriceOverlay> => {
    if (overlayCache === null || nowMs >= overlayCache.freshUntilMs) {
      overlayCache = {
        overlay: priceOverlayOf(await deps.store.listCustomProviders()),
        freshUntilMs: nowMs + OVERLAY_TTL_MS,
      };
    }
    return overlayCache.overlay;
  };

  /** What the meter says about this run's spend, seeding it from the store on first sight. */
  const spendState = async (
    runId: string,
    spendUsd: number | null,
    nowMs: number,
  ): Promise<SpendState> => {
    if (gauge !== null) await refreshGauge(gauge, deps.store, nowMs);
    if (gauge?.reached()) {
      return { capped: true, verdict: { kind: "over", limit: "deployment-spend" } };
    }
    if (spendUsd === null) return { capped: gauge !== null, verdict: { kind: "ok" } };
    if (!meter.has(runId)) {
      meter.seed(runId, (await spendOfRun(deps.store, runId)).spentUsd, spendUsd, nowMs);
    }
    return {
      capped: true,
      verdict: meter.verdict(runId, { spendUsd, callsInFlight: null }, nowMs),
    };
  };

  // ── ChatGPT plan keys ─────────────────────────────────────────────────────────────────────

  /** The refusal for a plan key with no usable token: re-sign-in, or try again later. */
  const planTokenRefusal = (
    refused: { reason: "needs_reauth" | "unavailable"; error: string },
  ): Response =>
    refused.reason === "needs_reauth"
      ? final(403, { error: refused.error, code: "needs_reauth" })
      : json(503, { error: refused.error, code: "plan_unavailable" });

  /** The route, the rewritten body and a fresh access token — or the refusal to send. */
  const preparePlanCall = async (
    key: ProviderKey,
    pathname: string,
    method: string,
    body: Uint8Array<ArrayBuffer> | null,
    members: Map<string, ValueSpan> | null,
  ): Promise<{ call: PlanCall; body: Uint8Array<ArrayBuffer> | null } | Response> => {
    if (!deps.plan) return json(403, { error: PLAN_LOCAL_ONLY, code: PLAN_LOCAL_ONLY_CODE });
    const route = planRoute(method, pathname);
    if (route === null) {
      return json(404, {
        error: "a ChatGPT plan serves only POST /v1/responses and GET /v1/models",
        code: "plan_route_not_supported",
      });
    }
    let clientStreams = true;
    let groupedTools: ReadonlySet<string> | null = null;
    if (route === "responses") {
      if (body === null) return json(400, { error: "the request has no body" });
      const rewritten = rewritePlanRequest(body, key.plan?.models ?? []);
      if (!rewritten.ok) {
        deps.diag.debug("proxy.plan_refused", { keyId: key.id, refused: rewritten.refused });
        return json(rewritten.status, {
          error: rewritten.error,
          ...(rewritten.status === 413 ? {} : { code: "plan_unsupported" }),
          ...(rewritten.refused.length === 0 ? {} : { refused: rewritten.refused }),
        });
      }
      // The plan's own refusals first, with its own code; then the rule every OpenAI body is
      // held to, on what the caller sent.
      const refused = members === null
        ? []
        : refusedInBody(body, "openai-responses", presentMembers(body, members));
      if (refused.length > 0) {
        deps.diag.debug("proxy.body_refused", { keyId: key.id, refused });
        return bodyRefusal(refused);
      }
      if (rewritten.stripped.length > 0) {
        deps.diag.debug("proxy.plan_stripped", { keyId: key.id, fields: rewritten.stripped });
      }
      if (rewritten.rewritten.length > 0) {
        deps.diag.debug("proxy.plan_rewritten", { keyId: key.id, changes: rewritten.rewritten });
      }
      body = rewritten.body;
      clientStreams = rewritten.clientStreams;
      groupedTools = rewritten.groupedTools === null ? null : new Set(rewritten.groupedTools);
    }
    const token = await deps.plan.accessToken(key);
    if (!token.ok) return planTokenRefusal(token);
    return { call: { key, route, clientStreams, token: token.token, groupedTools }, body };
  };

  /** Notes what a plan's call ended with, fire-and-forget like the usage row. */
  const settlePlan = (
    call: PlanCall,
    ended: { ending: string | null; errorCode: string | null },
  ) => {
    if (!deps.plan) return;
    // Only a completed response says the plan is serving again. An incomplete one may have been
    // cut short for any reason, the limit among them.
    const write = ended.errorCode === USAGE_LIMIT_CODE
      ? deps.plan.markLimited(call.key)
      : ended.ending === "completed"
      ? deps.plan.clearLimited(call.key)
      : null;
    write?.catch((err) => deps.diag.warn("proxy.plan_state_failed", { err: String(err) }));
  };

  /** A plan's 401, read for its code (from the body, else its `x-error-json` header) and
   * rebuilt to be relayed as it came when it is not retried. A body past the cap carries no code
   * anyone acts on. */
  const planRefusalRead = async (
    upstream: Response,
  ): Promise<{ code: string | null; response: Response }> => {
    const bytes = await errorAnswerBytes(upstream.body);
    let code: string | null = null;
    if (bytes !== null) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        code = refusalCodeOf(parsed);
      } catch {
        // Not JSON: no code.
      }
    }
    code ??= headerRefusalCodeOf(upstream.headers);
    const response = new Response(
      bytes ??
        JSON.stringify({ error: { message: "the plan's error answer was too long to relay" } }),
      { status: upstream.status, headers: relayedHeaders(upstream.headers) },
    );
    return { code, response };
  };

  /** A plan's error answer, read for its code (the usage limit marks the key) and relayed as
   * it came. */
  const planErrorRead = async (call: PlanCall, upstream: Response): Promise<Response> => {
    const bytes = await errorAnswerBytes(upstream.body);
    if (bytes === null) {
      const headers = relayedHeaders(upstream.headers);
      headers.set("content-type", "application/json");
      return new Response(
        JSON.stringify({ error: { message: "the plan's error answer was too long to relay" } }),
        { status: upstream.status, headers },
      );
    }
    let code: string | null = null;
    try {
      code = errorCodeOf(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      // `{"detail": …}` or not JSON at all: nothing to act on, still relayed.
    }
    if (upstream.status === 429 && code === USAGE_LIMIT_CODE) {
      settlePlan(call, { ending: "failed", errorCode: code });
    }
    return new Response(bytes, {
      status: upstream.status,
      headers: relayedHeaders(upstream.headers),
    });
  };

  /**
   * A plan's stream read to its end and answered as JSON: the terminal event's response, its
   * output filled in from the stream. A failed response becomes the error a non-streaming call
   * would have got — 429 for the usage limit — and a stream that ended without a terminal
   * event, or ran past the size cap, a 502.
   */
  const assemblePlanResponse = async (
    call: PlanCall,
    stream: ReadableStream<Uint8Array>,
    usage: ReturnType<typeof makeUsageMeter>,
    hungUp: AbortSignal,
  ): Promise<{ status: number; body: unknown; cut: boolean }> => {
    const assembler = makeResponsesStreamReader(true);
    const max = deps.maxRequestBodyBytes ?? MAX_REQUEST_BODY_BYTES;
    let seen = 0;
    const reader = stream.getReader();
    // A caller that hangs up stops the read: the plan's usage is not spent on nobody.
    const stop = () => void reader.cancel().catch(() => {});
    hungUp.addEventListener("abort", stop, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        seen += value.byteLength;
        if (seen > max) {
          await reader.cancel().catch(() => {});
          return {
            status: 502,
            body: { error: { message: "the plan's response is over the proxy's size limit" } },
            cut: true,
          };
        }
        usage.push(value);
        assembler.push(value);
      }
    } catch {
      return {
        status: 502,
        body: { error: { message: "the plan's stream broke off before the response completed" } },
        cut: true,
      };
    } finally {
      hungUp.removeEventListener("abort", stop);
    }
    if (hungUp.aborted) {
      return { status: STREAM_CUT_STATUS, body: null, cut: true };
    }
    const result = assembler.finish();
    settlePlan(call, result);
    if (result.ending === "completed" || result.ending === "incomplete") {
      if (call.groupedTools !== null) restorePlanPayload(result.response, call.groupedTools);
      return { status: 200, body: result.response, cut: false };
    }
    if (result.ending === "failed" || result.ending === "error") {
      const error = result.ending === "error"
        ? result.response
        : (result.response as { error?: unknown } | null)?.error ?? null;
      return {
        status: result.errorCode === USAGE_LIMIT_CODE ? 429 : 502,
        body: { error: error ?? { message: "the plan's response failed" } },
        cut: false,
      };
    }
    return {
      status: 502,
      body: { error: { message: "the plan's stream ended before the response completed" } },
      cut: false,
    };
  };

  return async (req) => {
    const token = presentedToken(req);
    if (token === null) return json(401, { error: "unauthorized" });

    const virtualKey = await deps.store.getVirtualKeyByTokenHash(await sha256Hex(token));
    // No live credential, no body read: `decide` would refuse this caller anyway, and reading
    // first would let anyone who can reach the proxy make it buffer a request.
    if (!authenticates(virtualKey, deps.now().toISOString())) {
      await req.body?.cancel().catch(() => {});
      return json(401, { error: "unauthorized" });
    }
    const providerKey = virtualKey === null
      ? null
      : await deps.store.getProviderKey(virtualKey.providerKeyId);

    const url = new URL(req.url);
    // Resolved BEFORE the body is read and before the decision: whether the provider serves this
    // route at all is the first thing asked of an authenticated caller, and whether a request
    // spends is what its route says (see `spendsTokens`). The refusals that follow from a
    // provider that does not resolve, or that is archived, still come after `decide`.
    const provider = providerKey === null
      ? null
      : await resolveProvider(deps.store, providerKey.provider);
    const route = provider === null ? null : providerRoute(provider, req.method, url.pathname);
    // A route the provider does not serve to a run is refused here, unread: batches, files,
    // fine-tuning, stored responses, an organization's admin API and a gateway's key-info route
    // all answer to the real key, and none of them is a model call this proxy can police. A
    // plan's own table refuses its routes further down, with its own code.
    if (provider !== null && route === null && provider.id !== CHATGPT_PLAN) {
      await req.body?.cancel().catch(() => {});
      deps.diag.debug("proxy.route_refused", {
        runId: virtualKey?.runId,
        provider: provider.id,
        method: req.method,
        path: url.pathname,
      });
      return routeRefusal(provider, req.method, url.pathname);
    }

    // The model the request names, when the payload carries one. Reading the body buffers the
    // REQUEST, under MAX_REQUEST_BODY_BYTES; the response still streams. 413, as the providers
    // answer a body past their own limits.
    let body: Uint8Array<ArrayBuffer> | null = null;
    let named: string | null = null;
    /** The body's top-level members the proxy reads, or null for a body that is no JSON object
     * (or no body). */
    let members: Map<string, ValueSpan> | null = null;
    if (req.body !== null) {
      // A plan's body is parsed and rebuilt, so it gets a cap of its own (MAX_PLAN_BODY_BYTES).
      const configured = deps.maxRequestBodyBytes ?? MAX_REQUEST_BODY_BYTES;
      const max = providerKey?.provider === CHATGPT_PLAN
        ? Math.min(configured, MAX_PLAN_BODY_BYTES)
        : configured;
      body = await readRequestBytes(req, max);
      if (body === null) {
        deps.diag.debug("proxy.denied", { runId: virtualKey?.runId, status: 413 });
        return json(413, { error: `the request body is over the proxy's ${max}-byte limit` });
      }
      members = topLevelMembers(body, READ_MEMBERS);
      named = members === null ? null : modelOf(body, members);
    }

    const now = deps.now();
    const nowMs = now.getTime();
    const spends = spendsTokens(provider, route, body !== null);
    // The caps are asked only of an authenticated purchase: an unknown token learns nothing
    // about the deployment's ceiling from a 401, and a models list is never counted.
    const judged = spends && virtualKey !== null && providerKey !== null && provider !== null;
    const overlay = judged ? await overlayAt(nowMs) : undefined;
    const request: ProxiedRequest = {
      model: named,
      spends,
      priced: judged && named !== null && overlay !== undefined
        ? priceFor(provider.id, named, overlay) !== null
        : null,
      included: provider !== null && included(provider.id),
    };
    const spend = judged
      ? await spendState(virtualKey.runId, virtualKey.spendUsd, nowMs)
      : undefined;
    const decision = decide(virtualKey, providerKey, request, now.toISOString(), spend);
    if (!decision.allow) {
      if (decision.code === "limit_reached") {
        deps.diag.warn("proxy.limit_reached", { runId: virtualKey?.runId, limit: decision.limit });
      } else {
        deps.diag.debug("proxy.denied", {
          runId: virtualKey?.runId,
          status: decision.status,
          model: named,
        });
      }
      return json(decision.status, {
        error: decision.error,
        ...(decision.code === undefined ? {} : { code: decision.code }),
        ...(decision.limit === undefined ? {} : { limit: decision.limit }),
      });
    }

    if (!provider) {
      // A row for a provider this deployment no longer knows — config drift, not a caller
      // problem. An ARCHIVED endpoint is not this: it resolves, and is refused just below.
      deps.diag.warn("proxy.unknown_provider", { provider: decision.providerKey.provider });
      return final(502, { error: "unknown upstream provider" });
    }
    if (provider.archivedAt !== null) {
      // The endpoint was withdrawn while the run held a live credential. Same shape as an
      // archived provider key: the caller IS who it claims to be, it just may no longer spend.
      deps.diag.debug("proxy.denied", { runId: decision.virtualKey.runId, status: 403 });
      return final(403, { error: "the model endpoint backing this run was archived" });
    }

    // A model call carries a JSON object, and only a body this proxy has read can be
    // held to anything: one it cannot walk (not JSON, not an object, not UTF-8) would be judged
    // on nothing while the provider's parser made what it liked of it.
    if (route !== null && route.spends && provider.id !== CHATGPT_PLAN) {
      if (body === null || members === null) {
        deps.diag.debug("proxy.denied", { runId: decision.virtualKey.runId, status: 400 });
        return json(400, {
          error: "a model call through the proxy must carry a JSON object body",
          code: "body_not_json",
        });
      }
      if (route.responses && asksForBackground(body, members)) {
        deps.diag.debug("proxy.denied", { runId: decision.virtualKey.runId, status: 400 });
        return json(400, {
          error: "background responses are not available through the model proxy: their " +
            "usage never passes through it to be counted. Send the request without " +
            '"background", streaming if it is long',
          code: "background_not_supported",
        });
      }
    }

    // What the body asks the provider to do beyond one metered completion: a tool it runs on
    // its own side, an image or file it fetches by URL or reads from storage, a stored response.
    // A plan's body is held to the same rule after its own refusals (`preparePlanCall`).
    if (route?.shape && body !== null && members !== null && provider.id !== CHATGPT_PLAN) {
      const refused = refusedInBody(body, route.shape, presentMembers(body, members));
      if (refused.length > 0) {
        deps.diag.debug("proxy.body_refused", { runId: decision.virtualKey.runId, refused });
        return bodyRefusal(refused);
      }
    }

    // The most output the request allowed, for the estimate a call that never reports its usage
    // is charged. Read before the body is spliced below, while the walk's spans still fit it.
    const requestedOutput = body === null ? null : requestedMaxOutput(body, members);
    // A streamed Chat Completions call reports its usage only when it asks to: made to ask, so a
    // run cannot opt out of being priced by leaving the option off. A custom endpoint's model
    // declared not to take the option (pi's `supportsUsageInStreaming: false`) is sent as it
    // came, and charged the estimate.
    if (route?.shape === "openai-chat" && body !== null && members !== null) {
      const declared = provider.models.find((m) => m.id === named);
      if (declared?.compat?.supportsUsageInStreaming !== false) {
        body = askForStreamUsage(body, members) ?? body;
      }
    }

    const target = forwardTarget(baseUrlFor(provider), provider.clientBasePath, url);
    if (target === null) {
      // The client leg's base URL ends in `clientBasePath`, so a request without it is not one
      // any correctly-configured client sent. Refused rather than forwarded under the upstream's
      // root: a second spelling for every endpoint is a second way past the path-based rules.
      deps.diag.debug("proxy.unroutable_path", {
        runId: decision.virtualKey.runId,
        provider: provider.id,
      });
      return json(404, {
        error: `this endpoint's paths live under "${provider.clientBasePath}"`,
      });
    }

    // A custom endpoint's name is resolved again before the key goes to it: one that points
    // inside the network now (a record changed since registration, a row written straight into
    // the database) is the coded 502 an admin fixes, never a dial with the sealed key on it.
    if (!provider.builtin) {
      const problem = await dialProblem(target, nowMs);
      if (problem !== null) {
        deps.diag.warn("proxy.endpoint_refused", { provider: provider.id, problem });
        return final(502, {
          error: `the model endpoint backing this run is misconfigured: ${problem}`,
          code: ENDPOINT_MISCONFIGURED,
        });
      }
    }

    // A ChatGPT plan: the route, the body and the credential are all decided here, before any
    // slot is taken — every refusal below returns without anything to release.
    let plan: PlanCall | null = null;
    if (provider.id === CHATGPT_PLAN) {
      const prepared = await preparePlanCall(
        decision.providerKey,
        url.pathname,
        req.method,
        body,
        members,
      );
      if (prepared instanceof Response) return prepared;
      plan = prepared.call;
      body = prepared.body;
      // The two routes take no query; whatever a caller put there stays here.
      target.search = "";
    } else if (!provider.builtin) {
      keepCustomQuery(target);
    }

    // A built-in forwards an allowlist of the caller's headers (core/endpoints.ts): never the
    // organization or project a key is billed under, and only the vetted `anthropic-beta` flags.
    // A custom endpoint forwards all but the hop-by-hop ones and the caller's own credential.
    const vetted = forwardedRequestHeaders(provider.id, req.headers);
    if (vetted !== null && vetted.droppedBetas.length > 0) {
      deps.diag.debug("proxy.betas_dropped", {
        runId: decision.virtualKey.runId,
        betas: vetted.droppedBetas,
      });
    }
    // What is sent is exactly what the key was sealed for (`endpointShape`): the scheme and the
    // static headers in their canonical spelling, never the stored one — a scheme with a stray
    // full-width space trimmed off is "Bearer" to the binding, and must be "Bearer" on the wire.
    // A custom endpoint's are held to the registration rule again here, so a row written
    // straight into the database cannot set `Host` (Bun's fetch sends it as given), stand in for
    // the key's own header, or carry a name or value `Headers` would throw on — each is this
    // coded 502, never a bare 500 and never a thrown message with the header in it.
    const sendable = sendableHeaders(provider);
    if (!sendable.ok) {
      deps.diag.warn("proxy.endpoint_refused", {
        provider: provider.id,
        problem: sendable.problem,
      });
      return final(502, {
        error: `the model endpoint backing this run is misconfigured: ${sendable.problem}`,
        code: ENDPOINT_MISCONFIGURED,
      });
    }
    const { scheme, extraHeaders } = sendable;
    const headers = vetted?.headers ?? new Headers(req.headers);
    for (const name of STRIP_REQUEST) headers.delete(name);
    // A custom endpoint forwards the run's own headers, but never one that says where the
    // request goes, who sent it or how it is framed: the same set its static headers may not set.
    if (!provider.builtin) {
      for (const name of [...headers.keys()]) if (refusedExtraHeader(name)) headers.delete(name);
    }
    // The endpoint's static headers first, the credential after: `extraHeaders` is operator
    // input, and an `authorization` typed in there must not be able to displace the real key.
    // Every value was held to `HEADER_VALUE_PATTERN` above, so none of these throws; were one to,
    // the answer is the coded 502 and the error — whose message quotes the value — goes nowhere.
    try {
      for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
    } catch {
      deps.diag.warn("proxy.endpoint_refused", { provider: provider.id, problem: "header set" });
      return final(502, {
        error: "the model endpoint backing this run is misconfigured: a static header could " +
          "not be sent",
        code: ENDPOINT_MISCONFIGURED,
      });
    }
    /**
     * The credential onto the request, or false when it cannot ride a header: not visible ASCII,
     * or refused by `Headers`. Never throws, and never lets the thrown error out — its message
     * carries the whole header value, the credential in it.
     */
    const credential = (value: string): boolean => {
      if (!CREDENTIAL_VALUE_PATTERN.test(value)) return false;
      try {
        headers.set(provider.auth.header, scheme === null ? value : `${scheme} ${value}`);
        return true;
      } catch {
        return false;
      }
    };
    if (plan !== null) {
      if (!credential(plan.token)) {
        deps.diag.warn("proxy.credential_header_refused", { keyId: plan.key.id });
        return final(502, {
          error: "the ChatGPT plan's access token cannot be sent in a header: sign in again",
          code: CREDENTIAL_HEADER_REFUSED,
        });
      }
    } else {
      // Bound to the spec this request is about to be sent to: a key whose provider, or whose
      // endpoint's shape, is not the one it was sealed for opens nothing. No secret, and a secret
      // that does not open, are one answer: an admin enters it again. A refusal here takes no
      // slot, like every refusal above.
      const { providerKey } = decision;
      let secret: string | null = null;
      if (providerKey.encryptedSecret !== NO_SECRET) {
        try {
          secret = await deps.decrypt(
            providerKey.encryptedSecret,
            providerKeyBinding(providerKey, provider),
          );
        } catch (err) {
          deps.diag.warn("proxy.unseal_failed", {
            providerKeyId: providerKey.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      } else deps.diag.warn("proxy.secret_missing", { providerKeyId: providerKey.id });
      // A secret that opens but cannot ride a header (one stored before the API held secrets to
      // visible ASCII, or written straight into the database) is the same answer as one that
      // does not open: an admin enters it again.
      if (secret !== null && !credential(secret)) {
        deps.diag.warn("proxy.credential_header_refused", { providerKeyId: providerKey.id });
        secret = null;
      }
      if (secret === null) {
        return final(409, {
          error: "the provider key backing this run has no usable secret: an admin must enter " +
            "it again under Model keys",
          code: SECRET_REQUIRED,
        });
      }
    }

    // The run's concurrency slot, taken as the last thing before the upstream call and freed
    // however its body ends — the gateway's idempotent release, carried over. Last, because
    // nothing between here and the fetch may throw: a slot taken before a step that can fail
    // is a slot no path releases. 429 rather than 403: this is the one cap a caller's backoff
    // is the right answer to.
    let release = () => {};
    if (spends) {
      const slot = meter.take(decision.virtualKey.runId, decision.virtualKey.callsInFlight, nowMs);
      if (slot === null) {
        deps.diag.warn("proxy.limit_reached", {
          runId: decision.virtualKey.runId,
          limit: "calls-in-flight",
        });
        return json(429, {
          error: "too many model calls in flight for this run",
          code: "limit_reached",
          limit: "calls-in-flight",
        });
      }
      release = slot;
    }

    const startedAt = deps.now();

    // ONE row per forwarded request, written when the response body ends — read to the end,
    // failed mid-stream, or abandoned by the caller — because only then is a stream's usage known.
    let usage: UsageMeter | null = null;
    /** The upstream's status; null while no answer has come. */
    let upstreamStatus: number | null = null;
    let recorded = false;
    /** The status the CALLER got, when that is not the upstream's: an assembled response. */
    let answeredStatus: number | null = null;
    /** Whether the provider bills this call in tokens, so a call that never said what it spent
     * is charged an estimate (core/usage_fallback.ts). A plan's usage is the plan's. */
    const billed = route?.billed === true && plan === null;
    const estimate = () => ({
      input: estimatedInputTokens(body ?? new Uint8Array()),
      output: requestedOutput ??
        provider.models.find((m) => m.id === named)?.maxOutputTokens ??
        FALLBACK_OUTPUT_TOKENS,
    });

    // The upstream call is the proxy's, not the caller's: a caller that hangs up on a billed call
    // does not end it, because the usage is in what it has not read yet. It is read on in the
    // background (`drain`) for at most DRAIN_MS from the hang-up, then cut and estimated. Any
    // other call — a models list, a plan's — ends with its caller, as it always did.
    const upstreamAbort = new AbortController();
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    let draining = false;
    /** What `drain` is reading, cancelled at the deadline along with the call. */
    let drained: { cancel(): Promise<void> } | null = null;
    const onHangUp = () => {
      if (draining) return;
      if (!billed) {
        upstreamAbort.abort(req.signal.reason);
        return;
      }
      draining = true;
      drainTimer = setTimeout(() => {
        upstreamAbort.abort();
        drained?.cancel().catch(() => {});
      }, deps.drainMs ?? DRAIN_MS);
    };
    if (req.signal.aborted) onHangUp();
    else req.signal.addEventListener("abort", onHangUp, { once: true });

    const record = (outcome: "ended" | "cut") => {
      if (recorded) return;
      recorded = true;
      release();
      if (drainTimer !== null) clearTimeout(drainTimer);
      req.signal.removeEventListener("abort", onHangUp);
      const metered = usage?.finish() ?? { tokens: null, model: null, final: false };
      const status = answeredStatus ??
        (upstreamStatus === null || (outcome === "cut" && upstreamStatus < 400)
          ? STREAM_CUT_STATUS
          : upstreamStatus);
      // A billed call the provider took (2xx), or one the caller left before any answer, that
      // did not report all it spent: charged the estimate, never nothing.
      const estimated = billed && !metered.final &&
        (upstreamStatus === null || (upstreamStatus >= 200 && upstreamStatus < 300));
      const tokens = estimated ? estimatedTokens(metered.tokens, estimate()) : metered.tokens;
      const row: UsageRecord = {
        runId: decision.virtualKey.runId,
        agentId: decision.virtualKey.agentId,
        taskId: decision.virtualKey.taskId,
        providerKeyId: decision.providerKey.id,
        provider: provider.id,
        // What the provider says it served; the request's own name only when it said nothing
        // (an error, a body that carried no usage at all).
        model: metered.model ?? named,
        status,
        inputTokens: tokens?.input ?? null,
        outputTokens: tokens?.output ?? null,
        cacheReadTokens: tokens?.cacheRead ?? null,
        cacheWriteTokens: tokens?.cacheWrite ?? null,
        cacheWrite1hTokens: tokens?.cacheWrite1h ?? null,
        reasoningTokens: tokens?.reasoning ?? null,
        estimated,
        durationMs: Math.max(0, deps.now().getTime() - startedAt.getTime()),
        at: startedAt.toISOString(),
      };
      if (estimated) {
        deps.diag.warn("proxy.usage_estimated", {
          runId: row.runId,
          provider: provider.id,
          model: row.model,
          status,
        });
      }
      // Counted before it is written, and whether or not the write lands: a cap that only saw
      // the rows that made it to the store would be a cap a database blip switches off.
      if (overlay !== undefined) {
        const usd = priceRecord(row, overlay);
        if (usd !== null) {
          meter.add(row.runId, usd, decision.virtualKey.spendUsd, deps.now().getTime());
          gauge?.add(usd);
        }
      }
      deps.store.recordUsage(row)
        .catch((err) => deps.diag.warn("proxy.usage_write_failed", { err: String(err) }));
    };

    /** The rest of a body nobody is reading any more, read for its usage: to its end, past
     * MAX_DRAIN_BYTES, or until DRAIN_MS from the hang-up aborts it. Then the row. */
    const drain = async (reader: {
      read(): Promise<{ done: true; value?: undefined } | { done: false; value: Uint8Array }>;
      cancel(): Promise<void>;
    }) => {
      drained = reader;
      let seen = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          usage?.push(value);
          seen += value.byteLength;
          if (seen > MAX_DRAIN_BYTES) break;
        }
      } catch {
        // Aborted at the deadline, or broken off: what arrived is what is known.
      }
      reader.cancel().catch(() => {});
      record("cut");
    };

    let upstream: Response;
    const send = () =>
      upstreamFetch(target, {
        method: req.method,
        headers,
        body,
        // NEVER follow a redirect: the real key is on this request. fetch strips `authorization`
        // across origins but keeps `x-api-key` and `api-key` — measured — and those are exactly
        // the two the `anthropic` built-in and an Azure-style endpoint use. A run picks the
        // route and (on a built-in) the query, so any open redirect on a registered upstream
        // would have handed it the unsealed provider key, which is the one thing this package
        // exists to prevent. It also makes the registration-time address check bite everywhere
        // rather than only under the cluster's NetworkPolicy: a 302 to 169.254.169.254 goes
        // nowhere.
        //
        // The 3xx is handed straight back to the caller, headers and all, exactly as the
        // streaming passthrough below hands back everything else — this proxy relays an
        // upstream's answer, it does not interpret it. Neither api.anthropic.com nor
        // api.openai.com redirects, so nothing legitimate changes; a custom endpoint that does
        // gets its Location read by the harness's own SDK, which holds only a virtual key.
        redirect: "manual",
        // A reasoning model can think for minutes before its first byte, and a non-streamed
        // answer arrives only whole. Bun's fetch gives up on a response that long silent (its
        // idle timeout: 300 s, fired on a coarse tick), which Deno's never did. The call ends
        // when `upstreamAbort` says (see `onHangUp`), never on a timer of fetch's own.
        signal: upstreamAbort.signal,
        timeout: false,
      } as RequestInit);
    try {
      upstream = await send();
      // A plan's access token refused: refreshed once — only if that is a different token now —
      // and the request sent once more. Never another key. The refusal's code is read first:
      // `token_expired` is OpenAI saying the token is dead (it ends tokens early, on a plan
      // change for one), and that refresh is not throttled.
      if (plan !== null && upstream.status === 401 && deps.plan) {
        const refusal = await planRefusalRead(upstream);
        upstream = refusal.response;
        const next = await deps.plan.accessToken(plan.key, {
          token: plan.token,
          code: refusal.code,
        });
        if (next.ok && next.token !== plan.token) {
          deps.diag.debug("proxy.plan_retry", { keyId: plan.key.id, code: refusal.code });
          await upstream.body?.cancel().catch(() => {});
          plan.token = next.token;
          if (!credential(next.token)) {
            release();
            deps.diag.warn("proxy.credential_header_refused", { keyId: plan.key.id });
            return final(502, {
              error: "the ChatGPT plan's access token cannot be sent in a header: sign in again",
              code: CREDENTIAL_HEADER_REFUSED,
            });
          }
          upstream = await send();
        } else if (!next.ok) {
          await upstream.body?.cancel().catch(() => {});
          release();
          return planTokenRefusal(next);
        } else {
          deps.diag.warn("proxy.plan_unauthorized_relayed", {
            keyId: plan.key.id,
            code: refusal.code,
          });
        }
      }
    } catch (err) {
      // A billed call its caller left, that never answered within the drain's deadline: the
      // provider may still have spent on it, so it is estimated like any unreported one.
      if (draining) record("cut");
      else release();
      // The credential is on this request: a fetch error that quotes a header (Bun quotes one it
      // refuses whole) must not carry it into a log line.
      const sent = headers.get(provider.auth.header) ?? "";
      const secrets = [sent, sent.slice(sent.indexOf(" ") + 1)].filter((v) => v !== "");
      deps.diag.warn("proxy.upstream_unreachable", {
        provider: provider.id,
        err: secrets.reduce((text, secret) => text.split(secret).join("***"), String(err)),
      });
      return json(502, { error: "upstream unreachable" });
    }

    // A plan's refusal is read for its code before it is relayed: the usage limit marks the key.
    if (plan !== null && upstream.status >= 400) {
      upstream = await planErrorRead(plan, upstream);
    }

    upstreamStatus = upstream.status;
    usage = makeUsageMeter(provider.dialect, upstream.headers.get("content-type"));

    // The upstream refused the credential the PROXY sent. A custom endpoint's or a plan's
    // refusal is answered with a fixed body, never relayed: what an arbitrary gateway writes into
    // one (the key it was handed, masked or not; the account behind it) is not the run's to read,
    // and a run can steer an endpoint into refusing. The built-ins' refusals are relayed — their
    // shapes are known, and their headers are already an allowlist.
    if (
      (!provider.builtin || plan !== null) && (upstream.status === 401 || upstream.status === 403)
    ) {
      await upstream.body?.cancel().catch(() => {});
      record("ended");
      deps.diag.warn("proxy.upstream_refused_credential", {
        provider: provider.id,
        status: upstream.status,
      });
      return final(upstream.status, {
        error: {
          message: `${provider.label} refused the credential behind this run's model endpoint: ` +
            "an admin must check the key under Model keys",
          type: "upstream_credential_refused",
        },
        code: "upstream_credential_refused",
      });
    }

    // Anthropic's and OpenAI's headers come back by allowlist, so the organization behind the
    // key stays here; every other provider's as they came, less the hop-by-hop ones.
    const responseHeaders = returnedResponseHeaders(provider.id, upstream.headers) ??
      new Headers(upstream.headers);
    for (const name of STRIP_RESPONSE) responseHeaders.delete(name);
    if (upstream.body === null) {
      record("ended");
      return new Response(null, { status: upstream.status, headers: responseHeaders });
    }
    // The caller left while the call was still on its way: nobody will read the answer, so it is
    // read here for its usage.
    if (draining) {
      void drain(upstream.body.getReader());
      return new Response(null, { status: STREAM_CUT_STATUS });
    }

    // A plan answering a caller that did not ask for a stream: the stream is read here, whole,
    // and answered as the one JSON response that caller expects.
    if (plan !== null && plan.route === "responses" && !plan.clientStreams && upstream.ok) {
      const assembled = await assemblePlanResponse(plan, upstream.body, usage, req.signal);
      answeredStatus = assembled.status;
      record(assembled.cut ? "cut" : "ended");
      responseHeaders.set("content-type", "application/json");
      return new Response(JSON.stringify(assembled.body), {
        status: assembled.status,
        headers: responseHeaders,
      });
    }

    // How a plan's stream ENDED: a mid-stream usage limit marks the key, a completion clears it.
    const watch = plan !== null && plan.route === "responses" && upstream.ok
      ? makeResponsesStreamReader(false)
      : null;
    let settled = false;
    const planEnded = () => {
      if (plan === null || watch === null || settled) return;
      settled = true;
      settlePlan(plan, watch.finish());
    };
    // A plan's tool calls shaped back to how the caller declared the tools. Metering and the
    // watch above read the upstream's own bytes; only what the caller is handed is rewritten.
    const restorer = plan !== null && plan.groupedTools !== null && upstream.ok
      ? makePlanStreamRestorer(plan.groupedTools)
      : null;

    // A pull-through stream rather than a TransformStream: its `cancel` is how a caller that hangs
    // up mid-completion still gets its row, and each chunk is handed on the moment it arrives.
    const reader = upstream.body.getReader();
    let cancelled = false;
    const metered = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          // Each pull hands on something or ends the stream: a chunk the restorer holds whole
          // (a line still waiting for its newline) is followed by the next one at once.
          for (;;) {
            const { done, value } = await reader.read();
            // The caller hung up while this read was out: `drain` has the stream now, and what
            // this read brought is counted like what it reads.
            if (cancelled) {
              if (!done) {
                usage?.push(value);
                watch?.push(value);
              }
              return;
            }
            if (done) {
              record("ended");
              planEnded();
              const rest = restorer?.finish();
              if (rest !== undefined && rest.byteLength > 0) controller.enqueue(rest);
              controller.close();
              return;
            }
            usage?.push(value);
            watch?.push(value);
            const handed = restorer === null ? value : restorer.push(value);
            if (handed.byteLength > 0) {
              controller.enqueue(handed);
              return;
            }
          }
        } catch (err) {
          if (cancelled) return;
          // The upstream died mid-body: what the caller got is a truncated completion — after a
          // `response.failed` for the usage limit, perhaps, which still marks the key.
          record("cut");
          planEnded();
          controller.error(err);
        }
      },
      cancel(reason) {
        cancelled = true;
        // The caller is gone, whether or not its request's signal has said so yet: a billed call
        // is read on for its usage, under the deadline `onHangUp` starts.
        if (billed) {
          onHangUp();
          void drain(reader);
          return;
        }
        record("cut");
        planEnded();
        return reader.cancel(reason);
      },
    }, { highWaterMark: 0 }); // read the upstream only as fast as the caller does
    return new Response(metered, {
      status: upstream.status,
      headers: responseHeaders,
    });
  };
}

// What OpenAI's "ChatGPT plan usage for open-source apps" asks of a client, as constants and pure
// functions: the sign-in's authorization request, PKCE, reading the callback, and what a
// forwarded request may and may not carry. The network half (token exchange, refresh, ID token
// verification) is the `OpenAiAccounts` port's; the decisions about rows are plan_keys.ts's.
//
// Source of truth: https://developers.openai.com/siwc/token-sharing-open-source and the pages it
// links (sign-in, accounts and sessions, models and inference, errors, preview limitations),
// read 2026-10-07.
//
// Invariants:
// - a plan key reaches exactly two upstream routes, `POST /v1/responses` and `GET /v1/models`;
//   everything else is refused here, never forwarded to find out
// - a Responses request goes upstream with `store: false` and `stream: true` whatever the caller
//   sent, and without the fields the plan refuses — STRIPPED, because pi sends several of them on
//   every call and they change nothing a run relies on
// - what the plan wants in another SHAPE is REWRITTEN, not refused: a `system` item becomes a
//   `developer` one, function and custom tools travel grouped in a namespace inside an
//   `additional_tools` input item ("Supported tools"), and a reasoning effort the model does not
//   list becomes the nearest one it does. The caller asked for a plain OpenAI Responses call and
//   gets its answer in that shape: a tool call comes back without the namespace added here
// - what cannot be rewritten without changing the conversation (`previous_response_id`, a hosted
//   tool the plan does not run) is REFUSED with a 400 that names it: a silently different
//   request is worse than an error a person can read
// - a body is measured (bytes, values, depth) BEFORE it is parsed, and refused with a 413 past
//   any of them: it is the one body this proxy takes apart, so it is the one a caller could
//   make expensive
// - only the request headers a Responses client needs go upstream (`PLAN_FORWARDED_HEADERS`),
//   and no query string: the account's session is spent on exactly what the proxy built

import type { DeclaredModel } from "./registry.ts";

/** The built-in provider id a ChatGPT plan key carries. */
export const CHATGPT_PLAN = "chatgpt-plan";

export const OPENAI_ISSUER = "https://auth.openai.com";
export const OPENAI_AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const OPENAI_TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
/** The discovery document's `revocation_endpoint`, as published on 2026-10-07. */
export const OPENAI_REVOKE_URL = "https://auth.openai.com/api/accounts/oauth/revoke";
export const OPENAI_JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
/** The `resource` every authorization, exchange and refresh names. */
export const PLAN_RESOURCE = "https://api.openai.com/v1";
/** The first-registration entry point. Never stored: the callback hands back the real client. */
export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
/** What OpenAI shows the person as the agent's name; they can edit it before approving. */
export const AGENT_NAME_HINT = "Ryph";
/** The scope without which a valid sign-in still may not spend the plan. */
export const PLAN_USE_SCOPE = "chatgpt.tokens.use.direct";
export const PLAN_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  PLAN_USE_SCOPE,
] as const;

/** The loopback callback. Only the port may ever vary, and this one is the documented one. */
export const CALLBACK_HOST = "127.0.0.1";
export const CALLBACK_PORT = 1455;
export const CALLBACK_PATH = "/auth/callback";
export const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;

/** How long a sign-in waits for its callback. */
export const SIGN_IN_TTL_MS = 10 * 60 * 1000;
/** How close to expiry an access token is refreshed before it is used. */
export const REFRESH_MARGIN_MS = 2 * 60 * 1000;

/**
 * Why a plan key does nothing here: OpenAI offers plan usage to apps run locally, and a remotely
 * hosted one needs its approval first. Every surface that refuses a plan key off a local
 * deployment says this.
 */
export const PLAN_LOCAL_ONLY =
  "ChatGPT plan keys work only when ryph runs on your own machine, not on a hosted deployment";
/** The `code` beside PLAN_LOCAL_ONLY on an HTTP refusal. */
export const PLAN_LOCAL_ONLY_CODE = "chatgpt_plan_local_only";

/**
 * Whether a deployment whose app a browser reaches at `appUrl` is local to the person's machine:
 * a loopback host (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`). Unset or unparseable is
 * not local: the deployment cannot say where its browser is.
 */
export function isLocalAppUrl(appUrl: string | null): boolean {
  if (appUrl === null) return false;
  const url = URL.parse(appUrl);
  if (url === null) return false;
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** The Responses error codes a plan answers with when its usage limit is reached. */
export const USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";

/**
 * Refresh errors after which the refresh token is unusable and only a new sign-in helps
 * ("Refresh errors"). `invalid_client` is listed apart there as "fix the client configuration",
 * which for a dynamically registered client is the same answer: sign in again.
 */
const UNUSABLE_REFRESH_CODES = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "invalid_client",
]);

export function refreshTokenUnusable(code: string | null): boolean {
  return code !== null && UNUSABLE_REFRESH_CODES.has(code);
}

/** The sealed secret of a plan key: one JSON document, replaced whole after every refresh. */
export interface PlanTokenSet {
  v: 1;
  /** The issued client these tokens belong to (also in the registration, beside the row). */
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** Retained for `id_token_hint` on a later sign-in. */
  idToken: string | null;
  accessExpiresAt: string;
  /** The token response's `earliest_refresh_at`, when it sent one. */
  earliestRefreshAt: string | null;
  scopes: string[];
  savedAt: string;
}

export function sealableTokens(tokens: PlanTokenSet): string {
  return JSON.stringify(tokens);
}

/** The token set out of an unsealed secret; throws on anything else. */
export function parseTokenSet(plaintext: string): PlanTokenSet {
  const parsed = JSON.parse(plaintext) as Partial<PlanTokenSet> | null;
  if (
    parsed === null || typeof parsed !== "object" || parsed.v !== 1 ||
    typeof parsed.accessToken !== "string" || typeof parsed.refreshToken !== "string" ||
    typeof parsed.clientId !== "string" || typeof parsed.accessExpiresAt !== "string"
  ) {
    throw new Error("not a ChatGPT plan token set");
  }
  return parsed as PlanTokenSet;
}

/** An access token's lifetime when nothing in the token response says (the docs: 1h). */
export const DEFAULT_ACCESS_TTL_S = 3600;
/** The upstream error code for an access token past its life, or ended early by OpenAI. */
export const TOKEN_EXPIRED_CODE = "token_expired";

/**
 * The `exp` of a JWT, in ms, when the token is one; null for anything else. NOT verified: it is
 * only a timing hint, read so a stored expiry can never outlive what the token itself says.
 */
export function jwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isObject(payload)) return null;
    const exp = payload.exp;
    return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * When a freshly issued access token stops working: the earliest of what the token response
 * said (`expires_in` from `atMs`, or `expires_at`) and the token's own `exp`. The default
 * lifetime only when none of them is there.
 */
export function accessExpiryOf(
  grant: { accessToken: string; expiresIn: number | null; expiresAt: string | null },
  atMs: number,
): string {
  const candidates = [
    grant.expiresIn === null ? null : atMs + grant.expiresIn * 1000,
    grant.expiresAt === null ? null : Date.parse(grant.expiresAt),
    jwtExpiryMs(grant.accessToken),
  ].filter((ms): ms is number => ms !== null && Number.isFinite(ms));
  const ms = candidates.length === 0 ? atMs + DEFAULT_ACCESS_TTL_S * 1000 : Math.min(...candidates);
  return new Date(ms).toISOString();
}

/** When the stored access token stops working: the stored expiry, or the token's own `exp` when
 * that is sooner (a set stored before the `exp` was read, or a response that overstated it). */
export function accessExpiryMs(tokens: PlanTokenSet): number {
  const stored = Date.parse(tokens.accessExpiresAt);
  const exp = jwtExpiryMs(tokens.accessToken);
  return exp === null || !(exp < stored) ? stored : exp;
}

/** Whether an access token should be refreshed before it is used. */
export function refreshDue(tokens: PlanTokenSet, nowMs: number): boolean {
  return accessExpiryMs(tokens) - nowMs <= REFRESH_MARGIN_MS;
}

/** Whether the access token is past its life, by our own reckoning. */
export function accessExpired(tokens: PlanTokenSet, nowMs: number): boolean {
  return accessExpiryMs(tokens) <= nowMs;
}

/** Whether OpenAI said not to refresh yet. A throttled refresh waits for this; one for a token
 * that is definitely dead (expired, or refused as `token_expired`) does not. */
export function refreshTooEarly(tokens: PlanTokenSet, nowMs: number): boolean {
  return tokens.earliestRefreshAt !== null && Date.parse(tokens.earliestRefreshAt) > nowMs;
}

/** `earliest_refresh_at` as an instant: Unix seconds, milliseconds, or a date string. */
export function instantOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  if (typeof value === "string" && value !== "") {
    const ms = Number.isNaN(Number(value)) ? Date.parse(value) : Number(value);
    if (Number.isFinite(ms)) return instantOf(ms);
  }
  return null;
}

// ── sign-in ─────────────────────────────────────────────────────────────────────────────────

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh random value for `state`, `nonce` or a PKCE verifier: 32 bytes, base64url. */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The PKCE `S256` challenge: base64url SHA-256 of the verifier, no padding. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** A UUIDv4 host id in the documented `urn:uuid:` form. */
export function mintAgentHostId(): string {
  return `urn:uuid:${crypto.randomUUID()}`;
}

export interface AuthorizeParams {
  /** The issued client for a re-sign-in; null registers a new one. */
  clientId: string | null;
  agentHostId: string;
  state: string;
  nonce: string;
  challenge: string;
  redirectUri: string;
  /** Re-sign-in only: the retained ID token, so OpenAI skips the account picker. */
  idTokenHint?: string | null;
  loginHint?: string | null;
}

/**
 * The authorization URL. A first registration names `dynamic_agent_client` and the agent name
 * hint; a re-sign-in names the issued client and the hints instead, and never the name hint.
 * The URL can carry an ID token, so it is never logged.
 */
export function authorizeUrl(params: AuthorizeParams): string {
  const url = new URL(OPENAI_AUTHORIZE_URL);
  const q = url.searchParams;
  q.set("client_id", params.clientId ?? DYNAMIC_CLIENT_ID);
  if (params.clientId === null) q.set("agent_name_hint", AGENT_NAME_HINT);
  q.set("ext_agent_host_id", params.agentHostId);
  if (params.clientId !== null && params.idTokenHint) q.set("id_token_hint", params.idTokenHint);
  if (params.clientId !== null && params.loginHint) q.set("login_hint", params.loginHint);
  q.set("response_type", "code");
  q.set("redirect_uri", params.redirectUri);
  q.set("scope", PLAN_SCOPES.join(" "));
  q.set("resource", PLAN_RESOURCE);
  q.set("state", params.state);
  q.set("nonce", params.nonce);
  q.set("code_challenge_method", "S256");
  q.set("code_challenge", params.challenge);
  return url.href;
}

/** What the browser landed on, read. */
export interface CallbackParams {
  code: string | null;
  state: string | null;
  clientId: string | null;
  error: string | null;
  errorDescription: string | null;
}

export function callbackParams(query: URLSearchParams): CallbackParams {
  const get = (name: string) => {
    const value = query.get(name);
    return value === null || value === "" ? null : value;
  };
  return {
    code: get("code"),
    state: get("state"),
    clientId: get("client_id"),
    error: get("error"),
    errorDescription: get("error_description"),
  };
}

/** The granted scopes, off a space-separated `scope`. */
export function scopesOf(scope: string | null): string[] {
  return scope === null ? [] : scope.split(/\s+/).filter((s) => s !== "");
}

// ── models ──────────────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One model a plan serves, as the key caches it: a `DeclaredModel`, plus the reasoning efforts
 * the account's model list says it takes. Those stay on the proxy's side of the wire — the
 * request rewrite reads them — and the runner's blob ignores them.
 */
export interface PlanModel extends DeclaredModel {
  /** `supported_reasoning_levels`, as the effort values the Responses API takes; absent when
   * the list did not say. */
  reasoningEfforts?: string[];
}

/** The effort values off `supported_reasoning_levels`: plain strings or `{effort}` presets. */
function effortsOf(levels: unknown[]): string[] {
  const efforts: string[] = [];
  for (const level of levels) {
    const effort = typeof level === "string"
      ? level
      : isObject(level) && typeof level.effort === "string"
      ? level.effort
      : null;
    if (effort !== null && effort !== "" && !efforts.includes(effort)) efforts.push(effort);
  }
  return efforts;
}

/**
 * The account's models off `GET /v1/models`, in the order the server sent them. The documented
 * shape is `{models: [{slug, display_name, visibility}]}`, and only `visibility: "list"` is meant
 * for a picker; a plain `{data: [{id}]}` list is read too.
 *
 * `reasoning` says only what the list says: a model with reasoning levels reasons, one with an
 * empty list does not, and one the list says nothing about is left unset — which pi reads as
 * not reasoning (`definition.reasoning ?? false` in its models.json loader), so it runs with
 * thinking off and the app's pickers offer it `off` alone. Nothing else
 * hangs on it: pi's `system` item (what it sends for a model it does not take for a reasoning
 * one) is rewritten to `developer` on the way, and its reasoning effort is fitted to what the
 * model lists (`rewritePlanRequest`).
 */
export function planModelsOf(body: unknown): PlanModel[] {
  if (!isObject(body)) return [];
  const models: PlanModel[] = [];
  const seen = new Set<string>();
  const add = (model: PlanModel) => {
    if (seen.has(model.id)) return;
    seen.add(model.id);
    models.push(model);
  };
  if (Array.isArray(body.models)) {
    for (const entry of body.models) {
      if (!isObject(entry) || typeof entry.slug !== "string" || entry.slug === "") continue;
      if (entry.visibility !== undefined && entry.visibility !== "list") continue;
      const levels = Array.isArray(entry.supported_reasoning_levels)
        ? effortsOf(entry.supported_reasoning_levels)
        : null;
      const modalities = entry.input_modalities;
      add({
        id: entry.slug,
        ...(typeof entry.display_name === "string" && entry.display_name !== ""
          ? { label: entry.display_name }
          : {}),
        ...(typeof entry.context_window === "number" && entry.context_window > 0
          ? { contextWindow: Math.round(entry.context_window) }
          : {}),
        ...(levels === null ? {} : { reasoning: levels.length > 0 }),
        ...(Array.isArray(modalities) ? { vision: modalities.includes("image") } : {}),
        ...(levels === null || levels.length === 0 ? {} : { reasoningEfforts: levels }),
      });
    }
  } else if (Array.isArray(body.data)) {
    for (const entry of body.data) {
      if (isObject(entry) && typeof entry.id === "string" && entry.id !== "") {
        add({ id: entry.id });
      }
    }
  }
  return models;
}

// ── forwarding ──────────────────────────────────────────────────────────────────────────────

/** The two routes a plan serves, by method and the path the client sent. */
export type PlanRoute = "responses" | "models";

export function planRoute(method: string, pathname: string): PlanRoute | null {
  if (method === "POST" && pathname === "/v1/responses") return "responses";
  if (method === "GET" && pathname === "/v1/models") return "models";
  return null;
}

/**
 * The caller's headers a plan call forwards; every other one is dropped. What pi's Responses
 * client sends that the route reads (pi-ai's openai-responses `createClient`): the body's type,
 * what it accepts back, who it is, and its session affinity (`session_id`,
 * `x-client-request-id`, `x-session-affinity`), which keeps a conversation on a warm cache.
 * `openai-beta` is the API's own opt-in header. Anything else — an `openai-organization`, an
 * `openai-project`, a header a run made up — has no business on a person's ChatGPT session.
 */
export const PLAN_FORWARDED_HEADERS = [
  "content-type",
  "accept",
  "user-agent",
  "openai-beta",
  "session_id",
  "x-client-request-id",
  "x-session-affinity",
] as const;

/** Request fields the plan refuses ("Preview limitations → Unsupported fields"). Stripped. */
export const PLAN_STRIPPED_FIELDS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
] as const;

/**
 * Tool types the plan does not run ("Unsupported tools"): image generation, file search, Code
 * Interpreter, native computer use, hosted MCP and connectors, `tool_search`, and
 * `programmatic_tool_calling` in top-level `tools`. Refused, never stripped: a run that declared
 * a tool and silently lost it would only find out from the model's confusion.
 */
const REFUSED_TOOL_TYPES = new Set([
  "image_generation",
  "file_search",
  "code_interpreter",
  "computer",
  "computer_use",
  "computer_use_preview",
  "mcp",
  "connector",
  "tool_search",
  "programmatic_tool_calling",
]);

/** Input items that only exist for a refused tool. */
const REFUSED_ITEM_TYPES = new Set(["tool_search_call", "tool_search_output"]);

/**
 * The namespace a request's top-level function and custom tools are grouped under. "functions"
 * is the name OpenAI's own client (Codex) gives the namespace its top-level tools live in, and
 * groups them under on this same route, with an empty description.
 */
export const PLAN_TOOL_NAMESPACE = "functions";

/** Tool types that are grouped into the namespace: the ones the docs say must be. */
const GROUPED_TOOL_TYPES = new Set(["function", "custom"]);

/**
 * The largest request body a plan call may carry: 24 MiB, where every other provider gets the
 * proxy's 64 MiB. A plan's body is PARSED and rebuilt here (every other one is only scanned for
 * its model), so this bounds what one call can make the proxy build in memory. What pi sends is
 * the measure: its images extension (packages/pi-mcp/images.ts, `IMAGE_BUDGET`) holds a
 * request's images to 16 MiB of base64, and the rest is the conversation as text, which the
 * plan's models take at most a few hundred thousand tokens of — a few MiB of JSON with
 * reasoning blobs and tool output in it. 8 MiB above the images covers that with room.
 */
export const MAX_PLAN_BODY_BYTES = 24 * 1024 * 1024;

/**
 * How many JSON values, roughly, a plan body may hold: every `{`, `[`, `,` and `:` outside a
 * string counts one. A body under the byte cap can still be millions of tiny objects (`{},{},…`),
 * each far bigger parsed than its three bytes. A request a model can take has well under one
 * value per token of context, and no plan model takes more than about a million tokens; images
 * and reasoning blobs are one string each however long. So a million is above anything a model
 * could be sent, and bounds the parse to tens of MB.
 */
export const MAX_PLAN_JSON_TOKENS = 1_000_000;

/** How deep a plan body's JSON may nest. A conversation is a handful of levels and a tool's JSON
 * Schema rarely twenty; nothing legitimate comes near this. */
export const MAX_PLAN_JSON_DEPTH = 128;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;

/**
 * Why a body is too big to parse, or null when it is not: past the byte cap, the value count or
 * the nesting depth. One pass over the bytes, before anything parses them; a string is skipped
 * whole with `indexOf`, so a long base64 image costs a native search. Malformed JSON is not its
 * business — the parse after it says so.
 */
export function planBodyTooBig(bytes: Uint8Array): string | null {
  if (bytes.byteLength > MAX_PLAN_BODY_BYTES) {
    return `a ChatGPT plan request may be at most ${MAX_PLAN_BODY_BYTES} bytes`;
  }
  let depth = 0;
  let tokens = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === QUOTE) {
      // To the closing quote: the next one not escaped by an odd run of backslashes.
      let end = i;
      for (;;) {
        end = bytes.indexOf(QUOTE, end + 1);
        if (end === -1) return null;
        let backslashes = 0;
        while (bytes[end - 1 - backslashes] === BACKSLASH) backslashes++;
        if (backslashes % 2 === 0) break;
      }
      i = end;
      continue;
    }
    if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) {
      depth++;
      tokens++;
      if (depth > MAX_PLAN_JSON_DEPTH) {
        return `a ChatGPT plan request may nest at most ${MAX_PLAN_JSON_DEPTH} levels deep`;
      }
    } else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
      depth--;
    } else if (byte === COMMA || byte === COLON) {
      tokens++;
    } else continue;
    if (tokens > MAX_PLAN_JSON_TOKENS) {
      return `a ChatGPT plan request may hold at most ${MAX_PLAN_JSON_TOKENS} JSON values`;
    }
  }
  return null;
}

/** pi's thinking levels and the Responses API's effort values, least to most. */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export type PlanRequestRewrite =
  | {
    ok: true;
    body: Uint8Array<ArrayBuffer>;
    /** Whether the CALLER asked for a stream. Upstream always streams; a caller that did not
     * ask gets the stream assembled back into one JSON response. */
    clientStreams: boolean;
    /** The fields taken out, for the debug log. */
    stripped: string[];
    /** What was reshaped rather than taken out, for the debug log. */
    rewritten: string[];
    /** The tools grouped under `PLAN_TOOL_NAMESPACE`, whose calls come back with that namespace
     * taken off again (`restorePlanToolCall`); null when none were. */
    groupedTools: string[] | null;
  }
  | {
    ok: false;
    error: string;
    refused: string[];
    /** 413 for a body too big to take apart; 400 otherwise. */
    status: 400 | 413;
  };

/**
 * A tool list with its top-level function and custom tools grouped into one namespace, at the
 * place the first of them stood; every other tool (a web search, a namespace the caller already
 * made) stays as it was. `grouped` collects the names moved.
 */
function groupTools(tools: unknown[], grouped: Set<string>): unknown[] {
  const members: unknown[] = [];
  const out: unknown[] = [];
  let at = -1;
  for (const tool of tools) {
    if (isObject(tool) && typeof tool.type === "string" && GROUPED_TOOL_TYPES.has(tool.type)) {
      if (at === -1) at = out.length;
      members.push(tool);
      if (typeof tool.name === "string") grouped.add(tool.name);
    } else {
      out.push(tool);
    }
  }
  if (at !== -1) {
    out.splice(at, 0, {
      type: "namespace",
      name: PLAN_TOOL_NAMESPACE,
      description: "",
      tools: members,
    });
  }
  return out;
}

/**
 * The effort a model lists that is nearest to the one asked for: the strongest it lists at or
 * below the request, else the weakest above it. `none` on a model that cannot switch reasoning
 * off is its lightest effort. Null when nothing can be said: the effort is not one this knows,
 * or the model lists none this knows.
 */
export function nearestEffort(asked: string, efforts: readonly string[]): string | null {
  const rank = EFFORT_ORDER.indexOf(asked);
  if (rank === -1) return null;
  const known = efforts
    .map((effort) => ({ effort, rank: EFFORT_ORDER.indexOf(effort) }))
    .filter((e) => e.rank !== -1)
    .sort((x, y) => x.rank - y.rank);
  if (known.length === 0) return null;
  const below = known.filter((e) => e.rank <= rank);
  return (below.length > 0 ? below[below.length - 1] : known[0]).effort;
}

/**
 * A `POST /v1/responses` body as the plan accepts it, or the refusal naming what it cannot.
 * Pure: bytes in, bytes out. `models` is the key's cached model list, read for the efforts a
 * model takes; a model not in it keeps whatever effort it was sent.
 */
export function rewritePlanRequest(
  bytes: Uint8Array,
  models: readonly PlanModel[] = [],
): PlanRequestRewrite {
  const tooBig = planBodyTooBig(bytes);
  if (tooBig !== null) return { ok: false, error: tooBig, refused: [], status: 413 };
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, error: "the request body is not JSON", refused: [], status: 400 };
  }
  if (!isObject(body)) {
    return { ok: false, error: "the request body is not a JSON object", refused: [], status: 400 };
  }

  const refused: string[] = [];
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    refused.push("previous_response_id");
  }
  const refuseTools = (tools: unknown[], where: string) =>
    tools.forEach((tool, i) => {
      if (isObject(tool) && typeof tool.type === "string" && REFUSED_TOOL_TYPES.has(tool.type)) {
        refused.push(`${where}[${i}] (${tool.type})`);
      }
    });
  if (Array.isArray(body.input)) {
    body.input.forEach((item, i) => {
      if (!isObject(item)) return;
      const type = typeof item.type === "string" ? item.type : "message";
      if (REFUSED_ITEM_TYPES.has(type)) refused.push(`input[${i}] (${type})`);
      if (type === "additional_tools" && Array.isArray(item.tools)) {
        refuseTools(item.tools, `input[${i}].tools`);
      }
    });
  }
  if (Array.isArray(body.tools)) refuseTools(body.tools, "tools");
  if (refused.length > 0) {
    return {
      ok: false,
      error: `a ChatGPT plan does not accept ${refused.join(", ")}: send the history in ` +
        "`input` and use function tools only",
      refused,
      status: 400,
    };
  }

  const stripped = PLAN_STRIPPED_FIELDS.filter((field) => Object.hasOwn(body, field));
  for (const field of stripped) delete (body as Json)[field];
  const rewritten: string[] = [];
  const grouped = new Set<string>();

  // "Use instructions or developer messages; explicit {type: "message", role: "system"} items
  // are rejected." A developer item in the same place says the same thing.
  if (Array.isArray(body.input)) {
    body.input.forEach((item, i) => {
      if (!isObject(item) || item.role !== "system") return;
      if (item.type !== undefined && item.type !== "message") return;
      item.role = "developer";
      rewritten.push(`input[${i}] role system → developer`);
    });
  }

  // The plan's route takes `input` only as a list ("Input must be a list"), where the public API
  // also takes a bare string: a caller with no tools (the memory service, the title writer) sends
  // one, and it becomes the single user message it means.
  if (typeof body.input === "string") {
    body.input = [{ role: "user", content: body.input }];
    rewritten.push("input string → user message");
  }

  // "Group function/custom tools in namespaces or supply them through `additional_tools` input
  // items." Both, as Codex does on this route: the request's tools become one `additional_tools`
  // developer item at the head of `input`, its function and custom tools in one namespace. Tools
  // already in an `additional_tools` item are grouped where they stand.
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (isObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
        item.tools = groupTools(item.tools, grouped);
      }
    }
  }
  if (Array.isArray(body.tools)) {
    const tools = groupTools(body.tools, grouped);
    delete (body as Json).tools;
    if (tools.length > 0) {
      const input = Array.isArray(body.input) ? body.input : [];
      body.input = [{ type: "additional_tools", role: "developer", tools }, ...input];
      rewritten.push("tools → additional_tools");
    }
  }

  // An effort the model does not list, fitted to the nearest one it does: pi asks for `none`
  // whenever no thinking level is set.
  const model = typeof body.model === "string"
    ? models.find((candidate) => candidate.id === body.model)
    : undefined;
  const reasoning = isObject(body.reasoning) ? body.reasoning : null;
  const efforts = model?.reasoningEfforts ?? [];
  if (reasoning !== null && typeof reasoning.effort === "string" && efforts.length > 0) {
    const asked = reasoning.effort;
    if (!efforts.includes(asked)) {
      const fitted = nearestEffort(asked, efforts);
      if (fitted === null) delete reasoning.effort;
      else reasoning.effort = fitted;
      rewritten.push(`reasoning.effort ${asked} → ${fitted ?? "(model default)"}`);
    }
  }

  // `store: false` means a reasoning item can only be sent back with its encrypted content, so
  // a model that reasons is always asked for it — also when the caller did not set an effort
  // and the model reasons anyway.
  const reasons = model?.reasoning === true ||
    (reasoning !== null && typeof reasoning.effort === "string" && reasoning.effort !== "none");
  const include = Array.isArray(body.include) ? body.include : [];
  if (reasons && !include.includes("reasoning.encrypted_content")) {
    body.include = [...include, "reasoning.encrypted_content"];
    rewritten.push("include + reasoning.encrypted_content");
  }

  const clientStreams = body.stream === true;
  body.store = false;
  body.stream = true;
  return {
    ok: true,
    body: new TextEncoder().encode(JSON.stringify(body)),
    clientStreams,
    stripped,
    rewritten,
    groupedTools: grouped.size > 0 ? [...grouped] : null,
  };
}

// ── answers ─────────────────────────────────────────────────────────────────────────────────

const CALL_ITEM_TYPES = new Set(["function_call", "custom_tool_call"]);

/**
 * A tool call as the caller declared the tool: the namespace this proxy grouped it under taken
 * off, so a call to a top-level tool comes back looking like one. A name that arrives prefixed
 * with the namespace is unprefixed too. Mutates and returns whether anything changed; a call to
 * a tool this proxy did not group is left exactly as it came.
 */
export function restorePlanToolCall(item: unknown, grouped: ReadonlySet<string>): boolean {
  if (!isObject(item) || typeof item.type !== "string" || !CALL_ITEM_TYPES.has(item.type)) {
    return false;
  }
  let changed = false;
  const prefix = `${PLAN_TOOL_NAMESPACE}.`;
  if (
    typeof item.name === "string" && item.name.startsWith(prefix) && !grouped.has(item.name) &&
    grouped.has(item.name.slice(prefix.length))
  ) {
    item.name = item.name.slice(prefix.length);
    changed = true;
  }
  if (
    item.namespace === PLAN_TOOL_NAMESPACE && typeof item.name === "string" &&
    grouped.has(item.name)
  ) {
    delete item.namespace;
    changed = true;
  }
  return changed;
}

/** Every tool call in a Responses payload — a response, or a stream event — restored. */
export function restorePlanPayload(payload: unknown, grouped: ReadonlySet<string>): boolean {
  if (!isObject(payload)) return false;
  let changed = false;
  const output = (holder: unknown) => {
    if (isObject(holder) && Array.isArray(holder.output)) {
      for (const item of holder.output) changed = restorePlanToolCall(item, grouped) || changed;
    }
  };
  output(payload);
  output(payload.response);
  if (restorePlanToolCall(payload.item, grouped)) changed = true;
  // `response.function_call_arguments.done` and its kin can name the tool beside the item id.
  if (
    typeof payload.type === "string" && payload.type.startsWith("response.") &&
    typeof payload.name === "string" && payload.name.startsWith(`${PLAN_TOOL_NAMESPACE}.`) &&
    grouped.has(payload.name.slice(PLAN_TOOL_NAMESPACE.length + 1))
  ) {
    payload.name = payload.name.slice(PLAN_TOOL_NAMESPACE.length + 1);
    changed = true;
  }
  return changed;
}

/** One SSE line over this is passed on unread. */
const MAX_RESTORE_LINE_CHARS = 64 * 1024 * 1024;

export interface PlanStreamRestorer {
  /** The bytes to hand the caller for this chunk: every whole line, restored. */
  push(chunk: Uint8Array): Uint8Array;
  /** Whatever was held back at the end. */
  finish(): Uint8Array;
}

/**
 * A Responses event stream with its tool calls restored, line by line. Only a `data:` line that
 * could hold a grouped call is parsed — one naming the namespace — and every other line goes on
 * byte for byte; a line is held only until its newline arrives.
 */
export function makePlanStreamRestorer(grouped: ReadonlySet<string>): PlanStreamRestorer {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let passing = false;
  const marker = `"${PLAN_TOOL_NAMESPACE}`;

  const line = (raw: string): string => {
    const cr = raw.endsWith("\r");
    const text = cr ? raw.slice(0, -1) : raw;
    if (!text.startsWith("data:") || !text.includes(marker)) return raw;
    let payload: unknown;
    try {
      payload = JSON.parse(text.slice("data:".length));
    } catch {
      return raw;
    }
    if (!restorePlanPayload(payload, grouped)) return raw;
    return `data: ${JSON.stringify(payload)}${cr ? "\r" : ""}`;
  };

  return {
    push(chunk) {
      const text = decoder.decode(chunk, { stream: true });
      let out = "";
      let start = 0;
      for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", start)) {
        const piece = text.slice(start, nl);
        out += passing ? `${piece}\n` : `${line(pending + piece)}\n`;
        pending = "";
        passing = false;
        start = nl + 1;
      }
      const rest = text.slice(start);
      if (passing) {
        out += rest;
      } else {
        pending += rest;
        if (pending.length > MAX_RESTORE_LINE_CHARS) {
          // Too long to hold: handed on as it came, the rest of the line too.
          out += pending;
          pending = "";
          passing = true;
        }
      }
      return encoder.encode(out);
    },
    finish() {
      const rest = pending + decoder.decode();
      pending = "";
      return encoder.encode(rest === "" || passing ? rest : line(rest));
    },
  };
}

/** The Responses error code in an error body or a failed response, when there is one. */
export function errorCodeOf(payload: unknown): string | null {
  if (!isObject(payload)) return null;
  const error = isObject(payload.error)
    ? payload.error
    : isObject(payload.response) && isObject(payload.response.error)
    ? payload.response.error
    : payload.type === "error"
    ? payload
    : null;
  return error !== null && typeof error.code === "string" ? error.code : null;
}

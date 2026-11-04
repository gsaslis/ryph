// What of a provider's API a run may reach through the proxy, and which headers go up and come
// back with it.
//
// The proxy holds the real provider key, and an OpenAI or Anthropic key buys far more than model
// calls: batches and fine-tuning jobs that spend outside any request this proxy sees, files and
// stored responses that other runs left behind, the organization's own admin endpoints. A run's
// credential is held by an agent that reads untrusted text all day, so what it can reach with
// the real key is an allowlist of the calls the harnesses actually make, and nothing else.
//
// Invariants:
// - DEFAULT DENY: a built-in route is forwarded only when its method and exact path are listed
//   here. A built-in this file does not list serves nothing
// - every listed route that takes a body is held to the allowlist and the caps (`spends`). The
//   only ones that are not are the models lists, which take no body and buy nothing
// - the request headers that go up are an allowlist too. The organization and project headers
//   in particular never do: they pick which of the key's organizations is billed
// - the response headers that come back are an allowlist, so the organization a key belongs to
//   and whatever else the provider says about the account stay here
// - a CUSTOM endpoint is held to a route table too, one per dialect: its model call and its
//   models list. The real key behind an OpenAI-compatible gateway reaches files, batches,
//   fine-tuning and the account's own key-info endpoints (OpenRouter's `/api/v1/auth/key`,
//   LiteLLM's `/key/info`) just as OpenAI's does, so a run gets the same default deny
// - a ChatGPT plan keeps its own route table and header list (core/chatgpt_plan.ts)
//
// Where the list comes from (re-check it whenever a harness version moves):
// - pi (images/harness, pi-coding-agent 1.5.0): `POST /v1/messages` for Anthropic, and for
//   OpenAI `POST /v1/responses` (the `openai-responses` dialect, `store: false`)
// - memory's and the orchestrator's platform-scoped calls: the same two, plus
//   `POST /v1/chat/completions` for the completions dialect
// - Claude Code: `POST /v1/messages` and `POST /v1/messages/count_tokens`, both with
//   `?beta=true`
// - Codex, through its own `ryph` provider (`wire_api = "responses"`): `POST /v1/responses`
// - the models lists are what an SDK or a CLI asks when it checks a model id; they buy nothing
//   and expose nothing a run does not already know

import { CHATGPT_PLAN, PLAN_FORWARDED_HEADERS, planRoute } from "./chatgpt_plan.ts";
import type { Dialect, ProviderSpec } from "./registry.ts";

/** The request shape a model call's body has, which is what its vetting reads
 * (core/body_policy.ts). */
export type BodyShape = "anthropic-messages" | "openai-responses" | "openai-chat";

/** One route a provider serves to a run. */
export interface ProviderRoute {
  /** Held to the model allowlist and the caps, like a purchase. */
  spends: boolean;
  /** The Responses API's create call, whose body is read for `background` (see the proxy). */
  responses: boolean;
  /** The shape of the body a spending route takes; null on a route that takes none. */
  shape: BodyShape | null;
  /** Whether the provider bills the call in tokens, so a call that never reported its usage is
   * charged an estimate (core/usage_fallback.ts). False for a free one: counting tokens. */
  billed: boolean;
}

interface RouteEntry extends ProviderRoute {
  method: string;
  /** The exact path, or a pattern for a path that carries an id. */
  path: string | RegExp;
  /** How the route is named in a refusal. */
  label: string;
}

const MODEL_ID_PATH = /^\/v1\/models\/[A-Za-z0-9._:@-]+$/;

const MODELS: RouteEntry[] = [
  {
    method: "GET",
    path: "/v1/models",
    label: "GET /v1/models",
    spends: false,
    responses: false,
    shape: null,
    billed: false,
  },
  {
    method: "GET",
    path: MODEL_ID_PATH,
    label: "GET /v1/models/{id}",
    spends: false,
    responses: false,
    shape: null,
    billed: false,
  },
];

const MESSAGES: RouteEntry = {
  method: "POST",
  path: "/v1/messages",
  label: "POST /v1/messages",
  spends: true,
  responses: false,
  shape: "anthropic-messages",
  billed: true,
};

const RESPONSES: RouteEntry = {
  method: "POST",
  path: "/v1/responses",
  label: "POST /v1/responses",
  spends: true,
  responses: true,
  shape: "openai-responses",
  billed: true,
};

const CHAT_COMPLETIONS: RouteEntry = {
  method: "POST",
  path: "/v1/chat/completions",
  label: "POST /v1/chat/completions",
  spends: true,
  responses: false,
  shape: "openai-chat",
  billed: true,
};

const ROUTES: Record<string, RouteEntry[]> = {
  anthropic: [
    MESSAGES,
    // Free on Anthropic's side, but it names a model, so it is held to the allowlist all the
    // same: the run's credential asks only about the models it may use.
    {
      method: "POST",
      path: "/v1/messages/count_tokens",
      label: "POST /v1/messages/count_tokens",
      spends: true,
      responses: false,
      shape: "anthropic-messages",
      billed: false,
    },
    ...MODELS,
  ],
  openai: [RESPONSES, CHAT_COMPLETIONS, ...MODELS],
};

/**
 * What a CUSTOM endpoint serves, by the dialect it speaks: its one model call and its models
 * list, relative to the base URL the run was handed (`clientBasePath` included, so the paths
 * read as the client sends them). Everything else — files, batches, fine-tuning, an account's
 * key-info route, a deployment path that names its own model — is refused unread.
 *
 * Every custom endpoint is `openai-completions` today (`customProviderSpec`); the other two are
 * listed so a dialect column cannot arrive without its routes.
 */
const CUSTOM_ROUTES: Record<Dialect, RouteEntry[]> = {
  "openai-completions": [CHAT_COMPLETIONS, ...MODELS],
  "openai-responses": [RESPONSES, ...MODELS],
  "anthropic-messages": [MESSAGES, ...MODELS],
};

function routesOf(provider: Pick<ProviderSpec, "id" | "builtin" | "dialect">): RouteEntry[] {
  return provider.builtin ? ROUTES[provider.id] ?? [] : CUSTOM_ROUTES[provider.dialect] ?? [];
}

/**
 * The route a request to a provider is, or null when the run may not make it. The path is the
 * INCOMING one, exactly: `URL` has already resolved any dot segments, and nothing else (a
 * trailing slash, an encoded slash) is the same route.
 */
export function providerRoute(
  provider: Pick<ProviderSpec, "id" | "builtin" | "dialect">,
  method: string,
  pathname: string,
): ProviderRoute | null {
  if (provider.id === CHATGPT_PLAN && provider.builtin) {
    const route = planRoute(method, pathname);
    return route === null ? null : {
      spends: route === "responses",
      responses: route === "responses",
      shape: route === "responses" ? "openai-responses" : null,
      billed: route === "responses",
    };
  }
  const entry = routesOf(provider).find((r) =>
    r.method === method &&
    (typeof r.path === "string" ? r.path === pathname : r.path.test(pathname))
  );
  return entry === undefined ? null : {
    spends: entry.spends,
    responses: entry.responses,
    shape: entry.shape,
    billed: entry.billed,
  };
}

/** What a provider serves, for the refusal a run reads. */
export function providerRouteLabels(
  provider: Pick<ProviderSpec, "id" | "builtin" | "dialect">,
): string[] {
  return routesOf(provider).map((r) => r.label);
}

/** The query parameters a custom endpoint's request keeps: Azure OpenAI's `api-version`, which
 * its `/openai/v1` API still reads. Every other one is dropped: a run has no business steering
 * an upstream's behaviour through parameters nothing here reads. */
const CUSTOM_QUERY_PARAMS = new Set(["api-version"]);

/** A custom endpoint's forward target with every query parameter but the kept ones removed. */
export function keepCustomQuery(target: URL): void {
  for (const name of [...new Set(target.searchParams.keys())]) {
    if (!CUSTOM_QUERY_PARAMS.has(name)) target.searchParams.delete(name);
  }
  if ([...target.searchParams.keys()].length === 0) target.search = "";
}

/** The headers every built-in's request keeps: what the body is, what is accepted back, and
 * which client sent it. */
const COMMON_REQUEST_HEADERS = ["content-type", "accept", "user-agent"];

/** The caller's headers a built-in request forwards, by provider. */
const FORWARDED_REQUEST_HEADERS: Record<string, readonly string[]> = {
  anthropic: [...COMMON_REQUEST_HEADERS, "anthropic-version", "anthropic-beta"],
  // The Responses client's own set, the one a plan already forwards: `openai-beta` and the
  // session affinity that keeps a conversation on a warm cache. Never `openai-organization` or
  // `openai-project`.
  openai: [...PLAN_FORWARDED_HEADERS],
  [CHATGPT_PLAN]: PLAN_FORWARDED_HEADERS,
};

/**
 * The `anthropic-beta` features a run may switch on, by family (the flag without its date, so
 * `context-management-2025-06-27` is `context-management` and a re-dated flag still passes).
 * Every one of them changes how ONE messages call behaves and is paid for in its tokens: the
 * flags pi 1.5.0 sends, and those Claude Code 2.1.294 carries that are about the model call
 * itself.
 *
 * Left out on purpose, because each reaches past a single metered completion: `files-api`
 * (a message can name any file the organization stored), `message-batches`, `skills` and
 * `code-execution` (containers billed by the hour, not the token), `mcp-client`, `mcp-servers`,
 * `mcp-tunnels`, `web-search` and `web-fetch` (the provider dials an address the run chose, or
 * searches for what it chose, from outside its network, billed per call; the body rule in
 * core/body_policy.ts refuses the server tools themselves), `advisor-tool` (a second model behind the first), `fast-mode` (billed at a premium
 * the price list does not know), and Claude Code's account features (`oauth`, `managed-agents`,
 * `environments`, `ccr-*`, `agent-memory`, `user-profiles`). An unknown flag is dropped: the
 * call then fails loudly on the field it needed, and the flag is a line here once vetted.
 */
const ANTHROPIC_BETA_FAMILIES = new Set([
  "advanced-tool-use",
  "context-1m",
  "context-hint",
  "context-management",
  "effort",
  "extended-cache-ttl",
  "fine-grained-tool-streaming",
  "inline-tools",
  "interleaved-thinking",
  "mid-conversation-output-config",
  "mid-conversation-system",
  "mid-conversation-system-clear-at",
  "mid-conversation-tool-changes",
  "output-128k",
  "per-turn-control",
  "prompt-caching-evict",
  "prompt-caching-scope",
  "redact-thinking",
  "server-side-fallback",
  "structured-outputs",
  "task-budgets",
  "thinking-binding-controls",
  "thinking-display-updates",
  "thinking-resumption",
  "thinking-token-count",
  "token-counting",
  "token-efficient-tools",
  "tool-search-tool",
]);

const BETA_DATE = /-\d{4}-\d{2}-\d{2}$/;

/** An `anthropic-beta` value split into the flags kept and the flags dropped. */
export function vetAnthropicBeta(value: string): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const raw of value.split(",")) {
    const flag = raw.trim();
    if (flag === "") continue;
    (ANTHROPIC_BETA_FAMILIES.has(flag.replace(BETA_DATE, "")) ? kept : dropped).push(flag);
  }
  return { kept, dropped };
}

/**
 * The headers a request to a built-in goes up with, out of the caller's: the provider's
 * allowlist, with `anthropic-beta` cut down to its vetted flags. The flags dropped are returned
 * so the proxy can say so. Null for a provider that is not a built-in: a custom endpoint
 * forwards as it always has.
 */
export function forwardedRequestHeaders(
  providerId: string,
  incoming: Headers,
): { headers: Headers; droppedBetas: string[] } | null {
  const names = FORWARDED_REQUEST_HEADERS[providerId];
  if (names === undefined) return null;
  const headers = new Headers();
  let droppedBetas: string[] = [];
  for (const name of names) {
    const value = incoming.get(name);
    if (value === null) continue;
    if (name === "anthropic-beta") {
      const vetted = vetAnthropicBeta(value);
      droppedBetas = vetted.dropped;
      if (vetted.kept.length > 0) headers.set(name, vetted.kept.join(","));
      continue;
    }
    headers.set(name, value);
  }
  return { headers, droppedBetas };
}

/** The upstream's response headers a run sees from Anthropic or OpenAI, exactly. */
const RETURNED_RESPONSE_HEADERS = new Set([
  "content-type",
  "cache-control",
  "date",
  // The ids a provider's support asks for, and the SDKs log.
  "request-id",
  "x-request-id",
  // What the SDKs' retry logic reads.
  "retry-after",
  "retry-after-ms",
  "x-should-retry",
  "openai-processing-ms",
  "openai-version",
]);

/** Rate-limit headers, which the SDKs back off on. They describe the key's limits, not whose
 * key it is. */
const RETURNED_RESPONSE_PREFIXES = ["anthropic-ratelimit-", "x-ratelimit-"];

/**
 * The response headers handed back to a run from Anthropic or OpenAI: an allowlist, so the
 * `openai-organization`, `openai-project` and `anthropic-organization-id` a provider answers
 * with (and anything it adds later) stay here. Null for every other provider, whose headers
 * are relayed as before.
 */
export function returnedResponseHeaders(providerId: string, upstream: Headers): Headers | null {
  if (providerId !== "anthropic" && providerId !== "openai") return null;
  const headers = new Headers();
  upstream.forEach((value, name) => {
    if (
      RETURNED_RESPONSE_HEADERS.has(name) ||
      RETURNED_RESPONSE_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      headers.set(name, value);
    }
  });
  return headers;
}

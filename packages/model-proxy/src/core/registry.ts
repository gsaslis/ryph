// The static knowledge about providers and harnesses — plus the projection that lets a ROW say
// the same things a compile-time constant does.
//
// Three providers ship as code (`BUILTIN_PROVIDERS`); the rest are however many `custom_providers`
// rows an admin registered, projected into the very same `ProviderSpec` by `customProviderSpec`
// so that nothing downstream — the proxy's forward path, the issuer's env map, the metering
// switch — ever asks which kind it got. "Where do providers come from" has exactly one answer
// again: built-ins ∪ rows (see `resolveProvider` in service.ts, which is the only place that
// joins the two).
//
// Model CATALOGUES are not stored for the BUILT-INS: Anthropic and OpenAI ship new model ids
// monthly, pi carries its own catalogue for both, and the price list covers them — so the public
// projection lists a built-in's models straight from the price list, for the app's model pickers
// to offer, and a model the list does not know is still a typed-in id away. A CUSTOM endpoint is
// the exact opposite case and therefore does declare its models (`DeclaredModel[]`): pi has no
// built-in catalogue for a provider it has never heard of and would write an empty `models`
// array into its config, and the hand-kept price list cannot know what a self-hosted vLLM
// charges. The declaration is the only source there is, which is why it is required rather than
// decorative.

import { CHATGPT_PLAN, PLAN_RESOURCE, type PlanModel } from "./chatgpt_plan.ts";
import { catalogueModels } from "./pricing.ts";
import { planThinkingLevels, type ThinkingLevel } from "./thinking.ts";
import type { CustomProvider } from "./types.ts";

/**
 * The wire dialect an upstream speaks — the ONE value a provider carries that anything switching
 * on "which API shape is this" may read. These strings are deliberately pi's own `api` names
 * (pi's docs/models.md), so the runner writes the value straight into models.json and no
 * translation table exists in any package.
 *
 * - `anthropic-messages` — Anthropic's `/v1/messages`.
 * - `openai-responses` — OpenAI's Responses API (`/v1/responses`), the built-in `openai`
 *   provider's. It is what pi itself speaks to OpenAI, it carries reasoning across turns
 *   (encrypted reasoning items with `store: false`), and it is the only shape a ChatGPT plan
 *   accepts — so it is the default for OpenAI, API-key providers included.
 * - `openai-completions` — Chat Completions (`/v1/chat/completions`), what nearly every
 *   OpenAI-COMPATIBLE endpoint implements, and therefore every custom endpoint's.
 *
 * For a custom endpoint the dialect is also the fence around what the proxy forwards: its route
 * table (core/endpoints.ts) is the dialect's model call and models list. The built-in `openai`
 * provider lists both of OpenAI's (`/v1/chat/completions` for a caller that only knows that one),
 * and metering reads either usage shape under either OpenAI dialect — `openAiCounts` tells them
 * apart by their field names.
 */
export type Dialect = "anthropic-messages" | "openai-responses" | "openai-completions";

/**
 * One model a custom endpoint declares it serves. Required, not decorative: pi cannot enumerate
 * models for a provider it has no built-in catalogue for, and the price list cannot know them.
 */
export interface DeclaredModel {
  id: string;
  label?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  vision?: boolean;
  /** The thinking levels the model takes, in pi's order. A custom endpoint's admin declares
   *  them; the runner hands them to pi as its `thinkingLevelMap`, so pi clamps a level to one of
   *  these. Left undeclared, the model has none here: it is stored, listed and handed to a run
   *  as declared, and the levels pi then gives it (`off` alone, or `off` through `high` for one
   *  that reasons) are what the app's pickers work out from `reasoning`. */
  thinkingLevels?: ThinkingLevel[];
  /** pi's OpenAI-compatibility overrides, passed through verbatim (supportsDeveloperRole,
   *  supportsReasoningEffort, maxTokensField, supportsUsageInStreaming, thinkingFormat, …).
   *  Opaque here on purpose: the harness adapter is the pi-specific place, not this file. */
  compat?: Record<string, unknown>;
  /** USD per million tokens. Absent ⇒ reported as unpriced, never as free. */
  price?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * How one upstream is reached and how its credential travels. Built-ins are compile-time
 * constants; custom endpoints are rows projected into this same shape.
 */
export interface ProviderSpec {
  id: string;
  label: string;
  dialect: Dialect;
  /** Where the real API lives, PATH INCLUDED
   *  (`https://api.cloudflare.com/client/v4/accounts/X/ai/v1`). */
  baseUrl: string;
  /** The env var the harness reads the (virtual) key from. */
  keyEnv: string;
  /** The env var the harness reads the base-URL override from. */
  baseUrlEnv: string;
  /**
   * The path segment the CLIENT expects to already sit in its base URL — appended to the proxy
   * address when a credential is issued, and stripped from the incoming path when forwarding.
   * OpenAI's SDK appends only the endpoint to a base URL that carries `/v1`; Anthropic's appends
   * the whole `/v1/…` path itself, so its is empty. It says nothing about the upstream's own
   * path, which `baseUrl` carries — see the forwarding rule in http/proxy.ts.
   */
  clientBasePath: string;
  /** How the credential rides the proxy→upstream request. `scheme: null` sends the bare value,
   *  which is what Anthropic's `x-api-key` and Azure's `api-key` want. */
  auth: { header: string; scheme: string | null };
  /** Static, NON-SECRET headers added to every forwarded request. The credential is the provider
   *  key and rides `auth`; nothing sealed ever lives here. */
  extraHeaders: Record<string, string>;
  /** Declared models. Empty for built-ins — pi has its own catalogue and the price list covers
   *  them; `toPublicProviderSpec` lists the price list's. See this file's opening. The one
   *  exception is `chatgpt-plan` in the provider LIST, which carries the union of its live keys'
   *  model lists (`listProviderSpecs`). */
  models: DeclaredModel[];
  builtin: boolean;
  /** Archiving a custom endpoint is a kill switch, exactly like archiving a provider key: the
   *  row still resolves forever, but nothing may be forwarded or issued for it again. Always
   *  null for a built-in, which cannot be archived. */
  archivedAt: string | null;
}

/** What a custom endpoint's virtual key rides in. One pair of names for every custom provider:
 * the harness learns WHICH provider it is from the config blob below, not from the variable. */
export const CUSTOM_KEY_ENV = "RYPH_MODEL_API_KEY";
export const CUSTOM_BASE_URL_ENV = "RYPH_MODEL_BASE_URL";

/**
 * The env var carrying a custom endpoint's id, dialect and declared models as one JSON blob.
 * It rides the env map — rather than a new field on the credentials response — precisely so the
 * orchestrator→runner wire shape does not change: the env map flows through both untouched, and
 * only the harness adapter at the far end has to know this name.
 */
export const MODEL_PROVIDER_CONFIG_ENV = "RYPH_MODEL_PROVIDER_CONFIG";

export const BUILTIN_PROVIDERS: Record<string, ProviderSpec> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    dialect: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    keyEnv: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    clientBasePath: "",
    auth: { header: "x-api-key", scheme: null },
    extraHeaders: {},
    models: [],
    builtin: true,
    archivedAt: null,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    dialect: "openai-responses",
    // With `/v1`, because the forwarding rule appends to the base URL's PATH rather than
    // replacing it: the client's `/v1` is stripped off the incoming path and this one takes
    // its place. Every provider's real path now lives in exactly one field.
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    clientBasePath: "/v1",
    auth: { header: "authorization", scheme: "Bearer" },
    extraHeaders: {},
    models: [],
    builtin: true,
    archivedAt: null,
  },
  // A ChatGPT plan: the same API as `openai`, spent on the usage a person's ChatGPT plan includes
  // rather than at API prices. Its credential is an OAuth token set this proxy refreshes, not a
  // pasted key — see core/chatgpt_plan.ts and core/plan_keys.ts. To a harness it is a provider
  // pi has no catalogue for (pi's own `openai` entry would send the fields the plan refuses and
  // know none of the account's models), so a run gets it the way it gets a custom endpoint:
  // ryph's own two variables plus the config blob, its models the key's own list.
  [CHATGPT_PLAN]: {
    id: CHATGPT_PLAN,
    label: "ChatGPT plan",
    dialect: "openai-responses",
    baseUrl: PLAN_RESOURCE,
    keyEnv: CUSTOM_KEY_ENV,
    baseUrlEnv: CUSTOM_BASE_URL_ENV,
    clientBasePath: "/v1",
    auth: { header: "authorization", scheme: "Bearer" },
    extraHeaders: {},
    models: [],
    builtin: true,
    archivedAt: null,
  },
};

/** The `/v1` every OpenAI-compatible client appends its endpoint to. */
const CUSTOM_CLIENT_BASE_PATH = "/v1";

/**
 * A `custom_providers` row as a ProviderSpec — pure, total, and the only place the two kinds of
 * provider are told apart. Everything a row does not carry is fixed: a custom endpoint is
 * OpenAI-compatible by definition (that is the whole scope of the feature — no OAuth, no
 * service-account refresh, no Vertex), so its dialect, its two env var names and its client base
 * path are constants rather than columns nobody would ever set differently. The dialect is Chat
 * Completions and not Responses because that is the one OpenAI-compatible servers (vLLM, Groq,
 * Cloudflare, Ollama, …) actually implement; a row that wants Responses needs a column first.
 */
export function customProviderSpec(row: CustomProvider): ProviderSpec {
  return {
    id: row.id,
    label: row.label,
    dialect: "openai-completions",
    baseUrl: row.baseUrl,
    keyEnv: CUSTOM_KEY_ENV,
    baseUrlEnv: CUSTOM_BASE_URL_ENV,
    clientBasePath: CUSTOM_CLIENT_BASE_PATH,
    auth: { header: row.authHeader, scheme: row.authScheme },
    extraHeaders: row.extraHeaders,
    models: row.models,
    builtin: false,
    archivedAt: row.archivedAt,
  };
}

/**
 * Header names a custom endpoint may never set, lower-cased — neither as a static header nor as
 * the header its key rides in — and that a run's own request never carries through to one: the
 * ones that say where a request goes or who it comes from (Bun's fetch sends a caller-set `Host`
 * as given, so one typed here would send the key to a host the base URL never named), and the
 * ones that say how it is framed, and every `proxy-*` name (`refusedExtraHeader`). The same set
 * the MCP gateway holds a server credential's headers to
 * (packages/mcp-gateway/src/core/credential_headers.ts), which adds only its guard's token. Checked beside them by `endpointHeadersProblem`: the endpoint's own
 * credential header as a static one.
 */
export const REFUSED_EXTRA_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  "content-length",
  "transfer-encoding",
  "connection",
  "te",
  "upgrade",
  "keep-alive",
]);

/** The prefix of the names a proxy reads for itself (`proxy-authorization`, `proxy-connection`). */
export const REFUSED_EXTRA_HEADER_PREFIX = "proxy-";

/** Whether a custom endpoint may never set (or forward) this header name. */
export function refusedExtraHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return REFUSED_EXTRA_HEADERS.has(lower) || lower.startsWith(REFUSED_EXTRA_HEADER_PREFIX);
}

/** The refused names as one line, for an error message. */
export const REFUSED_EXTRA_HEADERS_TEXT = `${
  [...REFUSED_EXTRA_HEADERS].join(", ")
}, ${REFUSED_EXTRA_HEADER_PREFIX}*`;

/** An RFC 9110 header name (a token). Anything else makes `Headers.set` throw. */
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * A header value this proxy sends: visible ASCII (0x21–0x7E), with single spaces between
 * words. Narrower than HTTP allows on purpose: `Headers.set` throws on anything past Latin-1
 * with the whole value in its message — the credential beside it included — and a value with
 * a zero-width or full-width space in it is a paste accident nobody can see in the form.
 */
export const HEADER_VALUE_PATTERN = /^[\x21-\x7E]+(?: [\x21-\x7E]+)*$/;

/** An auth scheme (`Bearer`): one RFC 9110 token. */
export const AUTH_SCHEME_PATTERN = HEADER_NAME_PATTERN;

/** A credential as it rides a header: visible ASCII, no whitespace at all. */
export const CREDENTIAL_VALUE_PATTERN = /^[\x21-\x7E]+$/;

/** A header value that can ride a request as given (`HEADER_VALUE_PATTERN`). */
function headerValueOk(value: string): boolean {
  return HEADER_VALUE_PATTERN.test(value);
}

/**
 * Why a custom endpoint's headers cannot ride a request, or null: a name that is not a header
 * name, a value that would split the request, a name that says where the request goes (as the
 * auth header or a static one), or a static header standing in for the key's own. Asked at
 * registration AND at every forward, so a row written straight into the database is held to it
 * too.
 */
export function endpointHeadersProblem(
  extraHeaders: Record<string, string>,
  authHeader: string,
  authScheme: string | null = null,
): string | null {
  return endpointHeadersProblems(extraHeaders, authHeader, authScheme)[0] ?? null;
}

/** Every reason `endpointHeadersProblem` has, one per header at most. */
export function endpointHeadersProblems(
  extraHeaders: Record<string, string>,
  authHeader: string,
  authScheme: string | null = null,
): string[] {
  const problems: string[] = [];
  if (!HEADER_NAME_PATTERN.test(authHeader)) {
    problems.push(`auth header ${JSON.stringify(authHeader)} is not a header name`);
  } else if (refusedExtraHeader(authHeader)) {
    problems.push(
      `auth header "${authHeader}" is not allowed: it would change where or how the ` +
        "request goes",
    );
  }
  if (authScheme !== null && !AUTH_SCHEME_PATTERN.test(authScheme)) {
    problems.push("the auth scheme must be one word of visible ASCII");
  }
  for (const [name, value] of Object.entries(extraHeaders)) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME_PATTERN.test(name)) {
      problems.push(`extra header ${JSON.stringify(name)} is not a header name`);
    } else if (!headerValueOk(value)) {
      problems.push(
        `extra header "${name}" must be visible ASCII, words separated by single spaces`,
      );
    } else if (refusedExtraHeader(lower)) {
      problems.push(
        `extra header "${name}" is not allowed: it would change where or how the request goes`,
      );
    } else if (lower === authHeader.toLowerCase()) {
      problems.push(
        `extra header "${name}" is not allowed: it is the header the key itself rides in`,
      );
    }
  }
  return problems;
}

/**
 * The static headers as stored: names lower-cased (header names are case-insensitive, so the
 * case an admin or an API caller typed is not part of the endpoint) and values trimmed (HTTP
 * drops surrounding whitespace on the wire anyway). Null when two names are one name.
 */
export function canonicalExtraHeaders(
  headers: Record<string, string>,
): Record<string, string> | null {
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (out.has(lower)) return null;
    out.set(lower, value.trim());
  }
  return Object.fromEntries(out);
}

/** An auth scheme as stored and compared: trimmed, and blank is none. */
export function canonicalAuthScheme(scheme: string | null): string | null {
  const trimmed = scheme?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** What a provider's headers are sent as, or why they cannot be (`endpointHeadersProblem`). */
export type SendableHeaders =
  | { ok: true; scheme: string | null; extraHeaders: Record<string, string> }
  | { ok: false; problem: string };

/**
 * The scheme and static headers exactly as they go on the wire — their canonical spelling, the
 * one a key is sealed for (`endpointShape`), never the stored one — or why they cannot. The
 * proxy's rule at every forward.
 */
export function sendableHeaders(
  spec: Pick<ProviderSpec, "auth" | "extraHeaders">,
): SendableHeaders {
  const scheme = canonicalAuthScheme(spec.auth.scheme);
  const extraHeaders = canonicalExtraHeaders(spec.extraHeaders);
  if (extraHeaders === null) return { ok: false, problem: "a static header is set twice" };
  const problem = endpointHeadersProblem(extraHeaders, spec.auth.header, scheme);
  return problem === null ? { ok: true, scheme, extraHeaders } : { ok: false, problem };
}

/**
 * A custom endpoint's request shape as one string, for the sealed binding and for telling
 * whether an edit moved it: where the key goes (`baseUrl`), the header and scheme it rides in,
 * and the static headers beside it. Canonical, so re-saving the same endpoint never reads as a
 * move: header names lower-cased, values and the base URL and scheme trimmed, names sorted (the
 * order a jsonb column hands them back in does not matter). Rows written before names were
 * stored lower-cased compare equal to their re-save.
 */
export function endpointShape(
  spec: Pick<ProviderSpec, "baseUrl" | "auth" | "extraHeaders">,
): string {
  const extra = Object.entries(spec.extraHeaders)
    .map(([name, value]) => [name.toLowerCase(), value.trim()] as const)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return JSON.stringify([
    spec.baseUrl.trim(),
    spec.auth.header.toLowerCase(),
    canonicalAuthScheme(spec.auth.scheme),
    extra,
  ]);
}

/** A ProviderSpec as the outside may see it. `extraHeaders` is deliberately absent: it is not a
 * secret — the credential is the provider key and is sealed — but it is the one field an admin
 * might have put something regrettable in, and the provider LIST is readable by any signed-in
 * user. The credential header and its scheme carry no such risk: they are two words out of the
 * upstream's own documentation, and the edit dialog has to be able to show what is stored. */
export interface PublicProviderSpec {
  id: string;
  label: string;
  dialect: Dialect;
  builtin: boolean;
  baseUrl: string;
  /** The header the provider key rides upstream in — `authorization`, or e.g. `api-key`. */
  authHeader: string;
  /** The scheme in front of it; null means the header carries the bare value. */
  authScheme: string | null;
  /** A custom endpoint's declared models, exactly as stored — every response that carries one
   * (the list, the admin read, a create, an edit, an archive) — so one saved back is the
   * declaration unchanged. A built-in's are the price list's, priced alike, with the levels
   * pi's catalogue gives each; a ChatGPT plan's are its signed-in accounts' own lists, each
   * `pricing: "included"`, with the levels those lists name. */
  models: PublicModel[];
  archivedAt: string | null;
}

/** A model as the provider list offers it. `pricing: "included"` marks one a plan's usage pays
 * for: metered, never charged, never refused under a spend cap. */
export type PublicModel = DeclaredModel & { pricing?: "included" };

/**
 * A ChatGPT plan model as it leaves the proxy — for the provider list and for a run's config
 * blob alike: what the account's model list says of it, its efforts
 * (`PlanModel.reasoningEfforts`, which only the proxy's request rewrite reads) as the thinking
 * levels they are, the efforts themselves held back. Nothing is added that the list did not
 * say: a model it gave no levels has none here, and what pi does with such a model is for the
 * runner and the pickers to know (the runner's models.json, the app's `thinkingLevelsFor`).
 */
export function planModelForRun(model: PlanModel): DeclaredModel {
  const { reasoningEfforts, ...declared } = model;
  if (reasoningEfforts === undefined) return declared;
  const levels = planThinkingLevels(reasoningEfforts);
  return levels.length === 0 ? declared : { ...declared, thinkingLevels: levels };
}

/** The one projection point for the provider list, on both the user and internal surfaces —
 * and, by way of `toAdminProviderSpec`, for the single-provider read too, so that everything
 * leaving this service is redacted in exactly one place. */
export function toPublicProviderSpec(spec: ProviderSpec): PublicProviderSpec {
  return {
    id: spec.id,
    label: spec.label,
    dialect: spec.dialect,
    builtin: spec.builtin,
    baseUrl: spec.baseUrl,
    authHeader: spec.auth.header,
    authScheme: spec.auth.scheme,
    models: spec.id === CHATGPT_PLAN
      ? spec.models.map((model) => ({ ...planModelForRun(model), pricing: "included" as const }))
      : spec.builtin
      ? catalogueModels(spec.id)
      : spec.models,
    archivedAt: spec.archivedAt,
  };
}

/** The public shape plus the one field held back from it. Admin-only, and exactly what the edit
 * dialog needs to prefill the form it will PATCH back. */
export interface AdminProviderSpec extends PublicProviderSpec {
  /** Static, NON-SECRET headers added to every forwarded request. Always `{}` for a built-in. */
  extraHeaders: Record<string, string>;
}

/**
 * One provider in full, for a reader already known to be an admin. It is built ON the public
 * projection rather than beside it so that a field added to a ProviderSpec cannot leak out here
 * by default: `toPublicProviderSpec` stays the sieve, and this adds back the single field that
 * is held from the list only because the list has a wider audience.
 */
export function toAdminProviderSpec(spec: ProviderSpec): AdminProviderSpec {
  return { ...toPublicProviderSpec(spec), extraHeaders: spec.extraHeaders };
}

/**
 * Which DIALECTS each harness kind can drive — the capability half of "which models can this
 * agent use". Keyed on the dialect rather than on a provider id, because a provider id is now
 * whatever an admin typed: a harness cannot enumerate the endpoints that will exist, but it can
 * say which wire shapes it speaks. pi speaks all three; echo fakes an agent and never dials a
 * model.
 */
export const HARNESS_DIALECTS: Record<string, readonly Dialect[]> = {
  pi: ["anthropic-messages", "openai-responses", "openai-completions"],
  echo: [],
};

/** Dialects a harness kind supports; unknown kinds support none (fail closed). */
export function supportedDialects(harnessKind: string): readonly Dialect[] {
  return HARNESS_DIALECTS[harnessKind] ?? [];
}

// The Custom endpoints dialog as pure functions: the form state, the state an existing endpoint
// loads into, and the create/patch bodies composed out of it. The model proxy checks all of this
// again — the slug shape, the base URL, the collision with a built-in — and these exist only so
// the operator hears "that base URL has a query string" before a round trip rather than after,
// the same bargain the hosted-server form makes.
//
// An edit prefills from `GET /v1/providers/:id` — the admin-only read that returns the credential
// header, its scheme and the static headers as well. That is why `endpointFormFor` takes a
// ProviderDetail and not the listed Provider: the form holds everything that is stored, so the
// patch it composes sends everything, and there is no field whose absence has to mean "keep".
// The models are the same in either read — the proxy answers with them exactly as stored,
// nothing filled in — so what an admin left unsaid (a model's thinking levels) loads unsaid and
// saves back unsaid, rather than as the levels pi happens to give it today.

import type { CreateProviderInput, UpdateProviderInput } from "$lib/api/providers";
import {
  type DeclaredModel,
  type Provider,
  type ProviderDetail,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "$lib/api/types";

/** One declared model as the operator types it — every number and price is a string until it
 * composes, so a half-typed "12" never reads as a context window of twelve. */
export type ModelRow = {
  id: string;
  label: string;
  contextWindow: string;
  maxOutputTokens: string;
  reasoning: boolean;
  vision: boolean;
  /** The levels it takes; empty declares none, so it takes pi's default for it: `off` alone,
   * or `off` through `high` for a reasoning model. Only a reasoning model's are sent beyond
   * `off` — the proxy refuses more for one that does not reason. */
  thinkingLevels: ThinkingLevel[];
  /** USD per million tokens, all four or none. */
  inputPrice: string;
  outputPrice: string;
  cacheReadPrice: string;
  cacheWritePrice: string;
  /** pi's per-model compat overrides (`thinkingFormat` and the like), as stored. The form has
   * no field for them — they are declared over the API — so the row only carries them through
   * an edit untouched: the patch replaces the whole model list, and a row that dropped them
   * would take the model's thinking with them. */
  compat?: Record<string, unknown>;
};

/** One static, non-secret header. */
export type HeaderRow = { name: string; value: string };

export type EndpointFormState = {
  id: string;
  label: string;
  baseUrl: string;
  /** The header the credential rides upstream in — `authorization`, or e.g. `api-key`. */
  authHeader: string;
  /** The scheme in front of it; "" means the header carries the bare value. */
  authScheme: string;
  headers: HeaderRow[];
  models: ModelRow[];
};

export function emptyModelRow(): ModelRow {
  return {
    id: "",
    label: "",
    contextWindow: "",
    maxOutputTokens: "",
    reasoning: false,
    vision: false,
    thinkingLevels: [],
    inputPrice: "",
    outputPrice: "",
    cacheReadPrice: "",
    cacheWritePrice: "",
  };
}

/** A fresh registration: the defaults that serve an OpenAI-compatible endpoint, and one model
 * row to fill in — an endpoint that declares none is useless, so the form never starts empty. */
export function newEndpointForm(): EndpointFormState {
  return {
    id: "",
    label: "",
    baseUrl: "",
    authHeader: "authorization",
    authScheme: "Bearer",
    headers: [],
    models: [emptyModelRow()],
  };
}

const priceText = (n: number | undefined) => (n === undefined ? "" : String(n));

/** An existing endpoint loaded for editing, in full: the detail read returns the credential
 * header, its scheme and the static headers, so every field shows what is actually stored.
 * A null scheme is the empty string here — the form's way of saying "the bare value". */
export function endpointFormFor(provider: ProviderDetail): EndpointFormState {
  return {
    id: provider.id,
    label: provider.label,
    baseUrl: provider.baseUrl,
    authHeader: provider.authHeader,
    authScheme: provider.authScheme ?? "",
    headers: Object.entries(provider.extraHeaders).map(([name, value]) => ({ name, value })),
    models: provider.models.length === 0 ? [emptyModelRow()] : provider.models.map((model) => ({
      id: model.id,
      label: model.label ?? "",
      contextWindow: model.contextWindow === undefined ? "" : String(model.contextWindow),
      maxOutputTokens: model.maxOutputTokens === undefined ? "" : String(model.maxOutputTokens),
      // Left unsaid (a model declared over the API), levels beyond off say it reasons: loading
      // it as not reasoning would hide those levels and the save would drop them.
      reasoning: model.reasoning ?? (model.thinkingLevels ?? []).some((level) => level !== "off"),
      vision: model.vision ?? false,
      thinkingLevels: [...(model.thinkingLevels ?? [])],
      inputPrice: priceText(model.price?.input),
      outputPrice: priceText(model.price?.output),
      cacheReadPrice: priceText(model.price?.cacheRead),
      cacheWritePrice: priceText(model.price?.cacheWrite),
      ...(model.compat === undefined ? {} : { compat: structuredClone(model.compat) }),
    })),
  };
}

/** The row with "Reasons" switched. Switched off, its levels go too, so a pick the form no
 * longer shows can never decide what is sent. Switched on, a lone `off` goes as well: it is all
 * a model that does not reason takes, and kept, it would pin the reasoning model to never
 * thinking. */
export function withReasoning(row: ModelRow, reasoning: boolean): ModelRow {
  const offOnly = row.thinkingLevels.length === 1 && row.thinkingLevels[0] === "off";
  return {
    ...row,
    reasoning,
    thinkingLevels: reasoning && !offOnly ? row.thinkingLevels : [],
  };
}

type Problem = { ok: false; error: string };

/** A base URL the proxy will accept: an absolute http(s) URL with a path and nothing else. A
 * query string, a fragment or embedded credentials are refused because the proxy appends the
 * request's own path to this one, and anything after it would be silently dropped or, worse,
 * carry a secret into every forwarded request. */
export function baseUrlProblem(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return "Paste the endpoint's base URL";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return `"${text}" is not a URL`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "The base URL must be http(s)";
  if (url.search !== "") return "The base URL cannot carry a query string";
  if (url.hash !== "") return "The base URL cannot carry a fragment";
  if (url.username !== "" || url.password !== "") {
    return "The base URL cannot carry credentials — the provider key is the credential";
  }
  return null;
}

/** The parts of an endpoint a key's secret is sealed for: where it goes and how it rides. */
export type EndpointShapeParts = {
  baseUrl: string;
  authHeader: string;
  authScheme: string | null;
  extraHeaders: Record<string, string>;
};

/**
 * An endpoint's request shape as one string, by the model proxy's own rule (`endpointShape` in
 * @ryph/model-proxy): the base URL trimmed, header names lower-cased, the scheme and header
 * values trimmed, an empty scheme as none, and the static headers sorted by name. Keep the two
 * in step: a save the proxy sees as a move clears every key's secret, and this is how the dialog
 * warns about that before it happens.
 */
export function endpointShape(parts: EndpointShapeParts): string {
  const scheme = parts.authScheme?.trim() ?? "";
  const extra = Object.entries(parts.extraHeaders)
    .map(([name, value]) => [name.trim().toLowerCase(), value.trim()] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([
    parts.baseUrl.trim(),
    parts.authHeader.trim().toLowerCase(),
    scheme === "" ? null : scheme,
    extra,
  ]);
}

/** The shape the form would save. Blank header rows are skipped, as composing skips them. */
export function formEndpointShape(form: EndpointFormState): string {
  const extraHeaders: Record<string, string> = {};
  for (const row of form.headers) {
    if (row.name.trim() === "" && row.value.trim() === "") continue;
    extraHeaders[row.name.trim().toLowerCase()] = row.value;
  }
  return endpointShape({
    baseUrl: form.baseUrl,
    authHeader: form.authHeader,
    authScheme: form.authScheme,
    extraHeaders,
  });
}

/** Whether saving the form moves the endpoint: a new address, credential header, scheme or
 * static headers. A key's secret is sealed for exactly those, so saving such an edit clears the
 * secret of every key registered against it. Case, order and padding alone move nothing. */
export function endpointShapeChanged(stored: EndpointShapeParts, form: EndpointFormState): boolean {
  return endpointShape(stored) !== formEndpointShape(form);
}

/** The slug, which rides the harness's argv and names the provider a key is registered against.
 * Shape only: whether the name is already spoken for — by a built-in or by another row — is a
 * question about the provider list, and `composeCreateBody` asks it there. */
export function slugProblem(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return "Give the endpoint a slug";
  if (text.length > 64) return "The slug is at most 64 characters";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(text)) {
    return `"${text}" must be lowercase letters, digits and dashes, starting with a letter or digit`;
  }
  return null;
}

function count(raw: string, what: string, modelId: string): number | undefined | Problem {
  const text = raw.trim();
  if (text === "") return undefined;
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, error: `${what} for "${modelId}" must be a whole number above zero` };
  }
  return n;
}

function price(raw: string, what: string, modelId: string): number | undefined | Problem {
  const text = raw.trim();
  if (text === "") return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, error: `The ${what} price for "${modelId}" must be a number, 0 or above` };
  }
  return n;
}

const isProblem = (v: unknown): v is Problem =>
  typeof v === "object" && v !== null && "ok" in v && (v as Problem).ok === false;

/** True for a row the operator added and left alone, which composes to nothing rather than to an
 * error — the dialog offers a spare row, and an untouched spare is not a mistake. */
function isBlankRow(row: ModelRow): boolean {
  return [
    row.id,
    row.label,
    row.contextWindow,
    row.maxOutputTokens,
    row.inputPrice,
    row.outputPrice,
    row.cacheReadPrice,
    row.cacheWritePrice,
  ].every((v) => v.trim() === "") && !row.reasoning && !row.vision &&
    row.thinkingLevels.length === 0 && row.compat === undefined;
}

/**
 * The declared models, or the first thing wrong with them. At least one is required: nothing on
 * this side of the wire can enumerate the models of an endpoint it has no catalogue for.
 *
 * Prices are all four or none. Three of four is very likely a half-finished row, and the wrong
 * half of it would price a run: better to be told now than to find a cache-write rate of zero in
 * next month's usage report.
 */
export function composeModels(
  rows: ModelRow[],
): { ok: true; models: DeclaredModel[] } | Problem {
  const models: DeclaredModel[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (isBlankRow(row)) continue;
    const id = row.id.trim();
    if (id === "") return { ok: false, error: "Every model needs an id" };
    if (seen.has(id)) return { ok: false, error: `"${id}" is declared twice` };
    seen.add(id);

    const contextWindow = count(row.contextWindow, "The context window", id);
    if (isProblem(contextWindow)) return contextWindow;
    const maxOutputTokens = count(row.maxOutputTokens, "The max output tokens", id);
    if (isProblem(maxOutputTokens)) return maxOutputTokens;

    const parts = [
      price(row.inputPrice, "input", id),
      price(row.outputPrice, "output", id),
      price(row.cacheReadPrice, "cache-read", id),
      price(row.cacheWritePrice, "cache-write", id),
    ];
    const bad = parts.find(isProblem);
    if (isProblem(bad)) return bad;
    const given = parts.filter((p) => p !== undefined) as number[];
    if (given.length !== 0 && given.length !== 4) {
      return {
        ok: false,
        error: `Give "${id}" all four prices or none — a partly priced model prices runs wrongly`,
      };
    }

    const label = row.label.trim();
    // Levels in pi's order, once each. A model that does not reason keeps only `off`, which is
    // what an edit of one declared that way loads back.
    const thinkingLevels = THINKING_LEVELS.filter((level) =>
      row.thinkingLevels.includes(level) && (row.reasoning || level === "off")
    );
    models.push({
      id,
      ...(label === "" ? {} : { label }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      // Said either way: left unsaid, pi takes the model for one that does not reason, and the
      // stored row should say what the admin meant rather than lean on that default.
      reasoning: row.reasoning,
      ...(row.vision ? { vision: true } : {}),
      ...(thinkingLevels.length === 0 ? {} : { thinkingLevels }),
      ...(given.length === 4
        ? {
          price: { input: given[0], output: given[1], cacheRead: given[2], cacheWrite: given[3] },
        }
        : {}),
      ...(row.compat === undefined ? {} : { compat: row.compat }),
    });
  }
  if (models.length === 0) {
    return { ok: false, error: "Declare at least one model — nothing else can enumerate them" };
  }
  return { ok: true, models };
}

/**
 * The static headers as a map. Blank rows are skipped; a half-filled one is the operator's
 * mistake and says so.
 *
 * Accumulated in a Map rather than an object because an RFC 9110 header name is a token, and
 * several legal tokens are also names every object already answers to: `constructor` and
 * `toString` would report a collision against a map holding nothing, and `__proto__` would be
 * swallowed by the prototype setter instead of stored. `Object.fromEntries` then defines each
 * key as an own property, so the composed map says exactly what was typed — which is what the
 * proxy's own header handling assumes.
 */
export function composeExtraHeaders(
  rows: HeaderRow[],
): { ok: true; headers: Record<string, string> } | Problem {
  const headers = new Map<string, string>();
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (name === "" && value === "") continue;
    if (name === "") return { ok: false, error: `The header carrying "${value}" has no name` };
    if (value === "") return { ok: false, error: `Header "${name}" has no value` };
    if (headers.has(name.toLowerCase())) return { ok: false, error: `"${name}" is set twice` };
    headers.set(name.toLowerCase(), value);
  }
  return { ok: true, headers: Object.fromEntries(headers) };
}

/** The credential header and the static headers, shared by both bodies. */
function composeAuth(
  form: EndpointFormState,
):
  | { ok: true; auth: Pick<CreateProviderInput, "authHeader" | "authScheme" | "extraHeaders"> }
  | Problem {
  const authHeader = form.authHeader.trim().toLowerCase();
  if (authHeader === "") return { ok: false, error: "Name the header the credential rides in" };
  const extra = composeExtraHeaders(form.headers);
  if (!extra.ok) return extra;
  if (Object.hasOwn(extra.headers, authHeader)) {
    return {
      ok: false,
      error: `"${authHeader}" carries the credential — it cannot also be a static header`,
    };
  }
  const scheme = form.authScheme.trim();
  return {
    ok: true,
    auth: { authHeader, authScheme: scheme === "" ? null : scheme, extraHeaders: extra.headers },
  };
}

function composeCommon(
  form: EndpointFormState,
): { ok: true; label: string; baseUrl: string; models: DeclaredModel[] } | Problem {
  const label = form.label.trim();
  if (label === "") return { ok: false, error: "Give the endpoint a label" };
  const urlProblem = baseUrlProblem(form.baseUrl);
  if (urlProblem !== null) return { ok: false, error: urlProblem };
  const models = composeModels(form.models);
  if (!models.ok) return models;
  return { ok: true, label, baseUrl: form.baseUrl.trim(), models: models.models };
}

/**
 * The registration body, or the first thing missing in the operator's words. `taken` is the
 * provider list as the wire gave it — every id already spoken for, built-ins included, since
 * that list is the one answer to where providers come from. The proxy refuses a collision
 * anyway, but not before the operator has retyped ten model rows.
 *
 * A built-in's name is refused with its own words rather than "already registered": the row
 * would not merely clash, it would be dead weight, because the compiled-in provider wins the
 * lookup and nothing would ever reach the endpoint.
 */
export function composeCreateBody(
  form: EndpointFormState,
  taken: readonly Pick<Provider, "id" | "builtin">[],
): { ok: true; body: CreateProviderInput } | Problem {
  const id = form.id.trim();
  const problem = slugProblem(id);
  if (problem !== null) return { ok: false, error: problem };
  const clash = taken.find((provider) => provider.id === id);
  if (clash !== undefined) {
    return {
      ok: false,
      error: clash.builtin ? `"${id}" is a built-in provider` : `"${id}" is already registered`,
    };
  }
  const common = composeCommon(form);
  if (!common.ok) return common;
  const auth = composeAuth(form);
  if (!auth.ok) return auth;
  return {
    ok: true,
    body: { id, label: common.label, baseUrl: common.baseUrl, models: common.models, ...auth.auth },
  };
}

/** The edit body: everything the form holds, because the form was filled from what is stored.
 * A patch omitting a field would keep it, but nothing here needs that — the operator sees the
 * headers they are replacing, and clearing the last one clears the map, as they would expect. */
export function composeUpdateBody(
  form: EndpointFormState,
): { ok: true; body: UpdateProviderInput } | Problem {
  const common = composeCommon(form);
  if (!common.ok) return common;
  const auth = composeAuth(form);
  if (!auth.ok) return auth;
  return {
    ok: true,
    body: { label: common.label, baseUrl: common.baseUrl, models: common.models, ...auth.auth },
  };
}

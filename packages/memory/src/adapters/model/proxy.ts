// `ModelClient` over the model proxy's data plane with a PLATFORM credential — the first user of
// the reusable pattern the memory proposal's decision 4 names: an off-run model call mints a
// platform-scoped virtual key from the proxy, dials the proxy exactly as an agent container
// would, and is metered under `platform:memory`. This process never sees a provider key.
//
// Three wire dialects, because the proxy forwards verbatim and the provider's own API answers:
// Anthropic's messages endpoint, OpenAI's Responses API (the built-in `openai` provider's) and
// Chat Completions (every custom OpenAI-compatible endpoint's). The credential says which one it
// speaks, so the table below is keyed on THE DIALECT and not on the provider — an
// admin-registered OpenAI-compatible endpoint is a provider this package has never heard of and
// still needs no entry of its own. Anything else the proxy learns to forward needs a dialect
// here before the platform can spend it.
//
// The credential is cached until shortly before it expires and re-minted on a 401 once — the
// policy may have been re-set, the key rotated, the proxy restarted with a fresh store. Mints are
// single-flight, because each one revokes the consumer's previous key.

import type {
  CompletionRequest,
  ModelClient,
  PlatformCredential,
  PlatformCredentialSource,
} from "../../ports/model.ts";

export interface ProxyModelClientOptions {
  /** The proxy's DATA plane, as this process dials it; a trailing slash is tolerated. */
  proxyUrl: string;
  credentials: PlatformCredentialSource;
  /** Overrides the policy's default model; must sit inside its allowlist. */
  model?: string;
  fetch?: typeof fetch;
  /** Per-request deadline. Judging one proposal is a short completion. */
  requestTimeoutMs?: number;
  diag: { warn(event: string, fields?: Record<string, unknown>): void };
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** Re-mint this long before the credential's own expiry, so a call never lands on a dead key. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const ANTHROPIC_VERSION = "2023-06-01";

interface Dialect {
  path: string;
  headers(token: string): Record<string, string>;
  body(model: string, req: CompletionRequest): unknown;
  text(answer: unknown): string | null;
}

const DIALECTS: Record<PlatformCredential["dialect"], Dialect> = {
  "anthropic-messages": {
    path: "/v1/messages",
    headers: (token) => ({ "x-api-key": token, "anthropic-version": ANTHROPIC_VERSION }),
    body: (model, req) => ({
      model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
    }),
    text: (answer) => {
      const content = (answer as { content?: unknown }).content;
      if (!Array.isArray(content)) return null;
      const parts = content
        .filter((c): c is { type: "text"; text: string } =>
          typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text" &&
          typeof (c as { text?: unknown }).text === "string"
        )
        .map((c) => c.text);
      return parts.length === 0 ? null : parts.join("");
    },
  },
  // Non-streaming, unstored, one instruction and one user turn: the smallest Responses call
  // there is. The text is gathered off the `output` items, because `output_text` is a
  // convenience the SDKs compute and not a field of the wire response.
  "openai-responses": {
    path: "/responses",
    headers: (token) => ({ authorization: `Bearer ${token}` }),
    body: (model, req) => ({
      model,
      instructions: req.system,
      input: req.prompt,
      max_output_tokens: req.maxTokens,
      store: false,
    }),
    text: (answer) => {
      const output = (answer as { output?: unknown }).output;
      if (!Array.isArray(output)) return null;
      const parts: string[] = [];
      for (const item of output) {
        if (typeof item !== "object" || item === null) continue;
        const { type, content } = item as { type?: unknown; content?: unknown };
        if (type !== "message" || !Array.isArray(content)) continue;
        for (const c of content) {
          if (
            typeof c === "object" && c !== null &&
            (c as { type?: unknown }).type === "output_text" &&
            typeof (c as { text?: unknown }).text === "string"
          ) {
            parts.push((c as { text: string }).text);
          }
        }
      }
      return parts.length === 0 ? null : parts.join("");
    },
  },
  "openai-completions": {
    path: "/chat/completions",
    headers: (token) => ({ authorization: `Bearer ${token}` }),
    body: (model, req) => ({
      model,
      max_completion_tokens: req.maxTokens,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
    }),
    text: (answer) => {
      const choices = (answer as { choices?: unknown }).choices;
      if (!Array.isArray(choices) || choices.length === 0) return null;
      const content = (choices[0] as { message?: { content?: unknown } }).message?.content;
      return typeof content === "string" ? content : null;
    },
  },
};

export function proxyModelClient(opts: ProxyModelClientOptions): ModelClient {
  const base = opts.proxyUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  let cached: PlatformCredential | null = null;
  // One mint at a time: the proxy keeps a single live credential per consumer, so a second mint
  // revokes the first, and concurrent cold calls that each minted would 401 one another.
  let minting: Promise<PlatformCredential> | null = null;

  const mint = (): Promise<PlatformCredential> => {
    if (minting === null) {
      minting = opts.credentials()
        .then((cred) => {
          cached = cred;
          return cred;
        })
        .finally(() => {
          minting = null;
        });
    }
    return minting;
  };

  /** The cached credential while it is live, else one shared mint. With `stale`, the credential a
   * call was just refused on: it is replaced unless another call already replaced it. */
  const credential = (stale?: PlatformCredential): Promise<PlatformCredential> => {
    if (minting !== null) return minting;
    const live = cached !== null && Date.parse(cached.expiresAt) - EXPIRY_MARGIN_MS > Date.now();
    if (live && (stale === undefined || cached !== stale)) return Promise.resolve(cached!);
    return mint();
  };

  const call = async (cred: PlatformCredential, req: CompletionRequest): Promise<Response> => {
    const dialect = DIALECTS[cred.dialect];
    if (!dialect) throw new Error(`no dialect "${cred.dialect}"`);
    const model = opts.model ?? cred.model;
    if (cred.allowedModels !== "*" && !cred.allowedModels.includes(model)) {
      throw new Error(`model "${model}" is outside the platform policy's allowlist`);
    }
    return await doFetch(`${base}${cred.basePath}${dialect.path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...dialect.headers(cred.token) },
      body: JSON.stringify(dialect.body(model, req)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  };

  return {
    async complete(req) {
      let cred = await credential();
      let res = await call(cred, req);
      if (res.status === 401) {
        // The key lapsed, was revoked, or the proxy forgot it: one re-mint, then it is real.
        await res.body?.cancel();
        cred = await credential(cred);
        res = await call(cred, req);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        opts.diag.warn("model.refused", { status: res.status, body: body.slice(0, 200) });
        throw new Error(`the model proxy answered ${res.status}`);
      }
      const text = DIALECTS[cred.dialect].text(await res.json());
      if (text === null) throw new Error("the model answered no text");
      return text;
    },
  };
}

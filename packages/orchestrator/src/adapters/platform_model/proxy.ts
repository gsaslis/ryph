// `PlatformModel` over the model proxy with a PLATFORM credential — memory's pattern
// (@ryph/memory adapters/model/proxy.ts and platform_http.ts), restated for the control plane
// rather than imported, because this package depends on the proxy's WIRE contract and not on
// memory's code. An off-run model call mints a platform-scoped virtual key from the proxy's
// platform policy (the background model an admin set under Instance → Platform), dials the
// proxy's data plane exactly as an agent container would, and is metered under
// `platform:<consumer>`. This process never sees a provider key.
//
// Three wire dialects, keyed on what the credential says it speaks, never on the provider: an
// admin-registered OpenAI-compatible endpoint is a provider nobody here has heard of and still
// needs no entry of its own.
//
// The credential is cached until shortly before it expires and re-minted on a 401 once — the
// policy may have been re-set, the key rotated, the proxy restarted with a fresh store. Mints are
// single-flight, because each one revokes the consumer's previous key.

import type { PlatformCompletion, PlatformModel } from "../../ports/platform_model.ts";

/**
 * A platform credential as the model proxy issues it — the shape @ryph/model-proxy's
 * `PlatformCredential` has. The fields this side reads are checked on arrival (`isCredential`).
 */
export interface PlatformCredential {
  token: string;
  provider: string;
  dialect: "anthropic-messages" | "openai-responses" | "openai-completions";
  model: string;
  allowedModels: string[] | "*";
  expiresAt: string;
  /** The provider SDK's base path on the proxy: "/v1" for an OpenAI-compatible endpoint, "" for
   * Anthropic. */
  basePath: string;
}

/** Where a platform credential comes from: the proxy's issuer in-process, or its internal route
 * over HTTP. Called lazily, and again whenever the one it gave has lapsed. */
export type PlatformCredentialSource = () => Promise<PlatformCredential>;

export interface HttpPlatformCredentialsOptions {
  /** The proxy's CONTROL listener, where the internal surface lives; trailing slash tolerated. */
  controlUrl: string;
  /** RYPH_PLATFORM_TOKEN: holding it lets this process mint platform credentials, nothing else. */
  token: string;
  /** Who is asking, for the metering trail. */
  consumer: string;
  requestTimeoutMs?: number;
}

function isCredential(body: unknown): body is PlatformCredential {
  if (typeof body !== "object" || body === null) return false;
  const c = body as Record<string, unknown>;
  return typeof c.token === "string" && typeof c.provider === "string" &&
    (c.dialect === "anthropic-messages" || c.dialect === "openai-responses" ||
      c.dialect === "openai-completions") &&
    typeof c.model === "string" && typeof c.expiresAt === "string" &&
    typeof c.basePath === "string" &&
    (c.allowedModels === "*" ||
      (Array.isArray(c.allowedModels) && c.allowedModels.every((m) => typeof m === "string")));
}

/** Credentials from the proxy's internal platform route — the networked control plane's way. A
 * definitive refusal (no background model set, an archived key) throws with the proxy's reason. */
export function httpPlatformCredentials(
  opts: HttpPlatformCredentialsOptions,
): PlatformCredentialSource {
  const url = `${opts.controlUrl.replace(/\/+$/, "")}/internal/v1/platform/credentials`;
  return async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
      body: JSON.stringify({ consumer: opts.consumer }),
      signal: AbortSignal.timeout(opts.requestTimeoutMs ?? 10_000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const reason = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
      throw new Error(`the model proxy refused a platform credential: ${reason}`);
    }
    if (!isCredential(body)) throw new Error("the model proxy answered a malformed credential");
    return body;
  };
}

export interface ProxyPlatformModelOptions {
  /** The proxy's DATA plane, as this process dials it; a trailing slash is tolerated. */
  proxyUrl: string;
  credentials: PlatformCredentialSource;
  fetch?: typeof fetch;
  diag: { warn(event: string, fields?: Record<string, unknown>): void };
}

/** Re-mint this long before the credential's own expiry, so a call never lands on a dead key. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const ANTHROPIC_VERSION = "2023-06-01";

interface Dialect {
  path: string;
  headers(token: string): Record<string, string>;
  body(model: string, req: PlatformCompletion): unknown;
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
      const parts = content.flatMap((c) =>
        typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text" &&
          typeof (c as { text?: unknown }).text === "string"
          ? [(c as { text: string }).text]
          : []
      );
      return parts.length === 0 ? null : parts.join("");
    },
  },
  // Non-streaming, unstored, one instruction and one user turn. The text is gathered off the
  // `output` items, because `output_text` is a convenience the SDKs compute and not a field of the
  // wire response.
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

export function proxyPlatformModel(opts: ProxyPlatformModelOptions): PlatformModel {
  const base = opts.proxyUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
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

  const call = async (cred: PlatformCredential, req: PlatformCompletion): Promise<Response> => {
    const dialect = DIALECTS[cred.dialect];
    if (!dialect) throw new Error(`no dialect "${cred.dialect}"`);
    return await doFetch(`${base}${cred.basePath}${dialect.path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...dialect.headers(cred.token) },
      body: JSON.stringify(dialect.body(cred.model, req)),
      ...(req.signal === undefined ? {} : { signal: req.signal }),
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
        opts.diag.warn("platform_model.refused", { status: res.status, body: body.slice(0, 200) });
        throw new Error(`the model proxy answered ${res.status}`);
      }
      const text = DIALECTS[cred.dialect].text(await res.json());
      if (text === null) throw new Error("the model answered no text");
      return text;
    },
  };
}

// A `PlatformCredentialSource` over the model proxy's internal platform route — what the
// STANDALONE memory service uses. The single process hands the proxy's issuer in directly.
//
// Service-authed with RYPH_PLATFORM_TOKEN, a credential of its own: holding it lets this
// process mint platform credentials and nothing else. A definitive refusal (no policy set, an
// archived key) throws with the proxy's reason so the log says what to fix.

import type { PlatformCredential, PlatformCredentialSource } from "../../ports/model.ts";

export interface HttpPlatformCredentialsOptions {
  /** The proxy's CONTROL listener, where the internal surface lives; trailing slash tolerated. */
  controlUrl: string;
  token: string;
  /** Who is asking, for the metering trail: "memory". */
  consumer: string;
  requestTimeoutMs?: number;
}

function isCredential(body: unknown): body is PlatformCredential {
  if (typeof body !== "object" || body === null) return false;
  const c = body as Record<string, unknown>;
  return typeof c.token === "string" && typeof c.provider === "string" &&
    // The dialect is what the client switches on, so a credential missing it is malformed here
    // rather than a mystery "no dialect undefined" on the first completion.
    (c.dialect === "anthropic-messages" || c.dialect === "openai-responses" ||
      c.dialect === "openai-completions") &&
    typeof c.model === "string" && typeof c.expiresAt === "string" &&
    typeof c.basePath === "string" &&
    (c.allowedModels === "*" ||
      (Array.isArray(c.allowedModels) && c.allowedModels.every((m) => typeof m === "string")));
}

export function httpPlatformCredentials(
  opts: HttpPlatformCredentialsOptions,
): PlatformCredentialSource {
  const url = `${opts.controlUrl.replace(/\/+$/, "")}/internal/v1/platform/credentials`;
  return async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.token}`,
        "content-type": "application/json",
      },
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

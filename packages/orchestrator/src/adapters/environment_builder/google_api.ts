// What the builders that talk to Google's APIs share: the pod's Google identity, as the GKE
// metadata server hands it out (Workload Identity), one way to make a request with it, and the
// error a Google API answers with. Cloud Build starts and watches builds with them; both
// registry-backed builders remove images from Artifact Registry with them (artifact_registry.ts).

/**
 * A Google API that answered with an error: its HTTP status, and its canonical status name
 * (`FAILED_PRECONDITION`, `NOT_FOUND`) when the body was Google's JSON error. Undefined for any
 * other body — an HTML 404 from a front end that never reached the API is no answer about the
 * thing asked for.
 */
export class GoogleApiError extends Error {
  constructor(readonly status: number, message: string, readonly reason?: string) {
    super(message);
  }
}

export interface GoogleRequestDeps {
  fetch: typeof fetch;
  token: () => Promise<string>;
  /** A cap on the request, so a connection that hangs fails the call. */
  timeoutMs: number;
}

/**
 * One request to a Google API, as the identity `token` gives: the parsed JSON body (null for an
 * empty one), or a `GoogleApiError` carrying the status and, from Google's own error shape, its
 * reason.
 */
export async function googleRequest(
  deps: GoogleRequestDeps,
  method: string,
  url: string,
  body?: unknown,
): Promise<unknown> {
  const res = await deps.fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${await deps.token()}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(deps.timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    let reason: string | undefined;
    try {
      const status = (JSON.parse(text) as { error?: { status?: unknown } }).error?.status;
      if (typeof status === "string") reason = status;
    } catch {
      // Not Google's error shape, and so no reason: only the status is known.
    }
    throw new GoogleApiError(
      res.status,
      `${method} ${url}: ${res.status} ${text.slice(0, 500)}`,
      reason,
    );
  }
  return text === "" ? null : JSON.parse(text);
}

/** The metadata server's token for this pod's Google identity, kept until shortly before expiry. */
export function metadataToken(fetchImpl: typeof fetch): () => Promise<string> {
  let cached: { token: string; until: number } | null = null;
  return async () => {
    if (cached !== null && Date.now() < cached.until) return cached.token;
    const res = await fetchImpl(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      throw new Error(`the metadata server gave no token (${res.status}: ${await res.text()})`);
    }
    const body = await res.json() as { access_token: string; expires_in: number };
    cached = { token: body.access_token, until: Date.now() + (body.expires_in - 60) * 1000 };
    return body.access_token;
  };
}

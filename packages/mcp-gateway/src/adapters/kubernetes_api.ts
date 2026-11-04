// The API server's REST surface as the Kubernetes adapters in this package speak it — the tool
// host and the hosting lease — with nothing but fetch. The handful of calls they make does not
// justify a client library, and a hand-held request is one whose every header can be read here.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { type CaFetch, caFetch } from "@ryph/service";

export interface KubernetesApiOptions {
  /** The API server's origin, e.g. `https://10.0.0.1:443`, or a `kubectl proxy` address. */
  apiUrl: string;
  /**
   * A bearer token file, re-read on every request because a projected token rotates underneath
   * the process. Null when the API is reached through something that authenticates for us.
   */
  tokenFile: string | null;
  /**
   * The PEM bundle the API server's certificate chains to; when set, it is the ONLY trust anchor.
   * Null means the system roots.
   */
  caFile: string | null;
}

/** A non-2xx answer, carrying the status a caller branches on (404 gone, 409 conflict). */
export class KubeError extends Error {
  override readonly name = "KubeError";
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface KubernetesApi {
  /** A JSON request, its answer parsed. A failure throws a KubeError with the API server's reason. */
  call(method: string, path: string, body?: unknown, contentType?: string): Promise<unknown>;
  /** A GET answered in text rather than JSON — the log subresource. */
  callText(path: string): Promise<string>;
}

export function kubernetesApi(
  opts: KubernetesApiOptions,
  doFetch?: typeof fetch,
  limits: { timeoutMs?: number } = {},
): KubernetesApi {
  const apiUrl = opts.apiUrl.replace(/\/+$/, "");
  // Read once, at construction: a CA the process cannot read is a boot failure, not a first-launch
  // one — and hosting reads unavailable with the reason rather than failing the gateway.
  const ca = opts.caFile === null ? null : readFileSync(opts.caFile, "utf8");
  const send: CaFetch = doFetch ?? (ca === null ? globalThis.fetch : caFetch(ca));

  const authorization = async (): Promise<Record<string, string>> =>
    opts.tokenFile === null
      ? {}
      : { authorization: `Bearer ${(await readFile(opts.tokenFile, "utf8")).trim()}` };

  /**
   * One request and its whole answer, abandoned after `limits.timeoutMs` when that is set. Unset,
   * it waits as long as the connection does.
   */
  const fetchText = async (
    method: string,
    path: string,
    init: Pick<RequestInit, "headers" | "body">,
  ): Promise<{ res: Response; text: string }> => {
    const abort = limits.timeoutMs === undefined ? null : new AbortController();
    const timer = abort && setTimeout(() => abort.abort(), limits.timeoutMs);
    try {
      const res = await send(`${apiUrl}${path}`, {
        ...init,
        method,
        ...(abort ? { signal: abort.signal } : {}),
      });
      return { res, text: await res.text() };
    } catch (err) {
      if (abort?.signal.aborted) {
        throw new Error(`kubernetes ${method} ${path}: no answer in ${limits.timeoutMs} ms`);
      }
      throw err;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  return {
    async call(method, path, body, contentType = "application/json") {
      const headers: Record<string, string> = {
        accept: "application/json",
        ...(await authorization()),
      };
      if (body !== undefined) headers["content-type"] = contentType;
      const { res, text } = await fetchText(method, path, {
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let parsed: unknown = undefined;
      try {
        parsed = text === "" ? undefined : JSON.parse(text);
      } catch {
        // Not JSON — a proxy's error page, say. The status is what matters; the text rides the error.
      }
      if (!res.ok) {
        // The API server answers failures with a Status object whose `message` names the cause.
        const message = (parsed as { message?: string } | undefined)?.message ?? text.slice(0, 200);
        throw new KubeError(res.status, `kubernetes ${method} ${path} → ${res.status}: ${message}`);
      }
      return parsed;
    },

    async callText(path) {
      // What kubectl sends. The log subresource answers text/plain, but GKE's API server (1.35) 406s
      // an Accept that names it — it negotiates against JSON, YAML and protobuf only.
      const headers: Record<string, string> = {
        accept: "application/json, */*",
        ...(await authorization()),
      };
      const { res, text } = await fetchText("GET", path, { headers });
      if (!res.ok) {
        throw new KubeError(
          res.status,
          `kubernetes GET ${path} → ${res.status}: ${text.slice(0, 200)}`,
        );
      }
      return text;
    },
  };
}

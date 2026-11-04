// The one place the `ryph` CLI talks HTTP to a ryph deployment somewhere else, for `ryph checks`
// and `ryph mcp` alike. Everything goes through the app's same-origin proxy
// (`<RYPH_URL>/api/v1/...`), the only door a deployment behind a load balancer makes public: the
// proxy forwards a caller's own bearer on the routes it allowlists for one
// (packages/app/src/routes/api/[...path]/path.ts `BEARER_DOORS`), so the client exchanges its API
// token for an access token once and sends that.
//
// Invariants:
// - the API token never leaves this module except in the exchange's body; every other request
//   carries the short-lived access token, renewed ahead of its expiry and re-exchanged once on a
//   401 (it expires in minutes)
// - a body factory is called once per attempt: a retried upload needs its stream from the start
// - every failure is an `ApiError` with the status and the server's own words, so a command
//   decides the exit code and the MCP server the tool error, from one shape
// - no redirect is followed (a 307 would carry the exchange's body, the API token, elsewhere),
//   and no answer is read past `MAX_BODY_BYTES`

import { isLoopbackHost } from "@ryph/shared/net";
import { readConfig } from "../config_file.ts";

export class ApiError extends Error {
  constructor(
    /** The HTTP status; 0 when the server could not be reached at all. */
    readonly status: number,
    message: string,
    /** The server's machine-readable reason, when its answer carried one (`not-branch-head`). */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The API token itself was refused at the exchange (unknown, revoked or expired). Kept apart from
 * a 401 on a later request, which with a freshly exchanged token means something else.
 */
export class TokenRefusedError extends ApiError {
  constructor(status: number, message: string) {
    super(status, message, "token-refused");
    this.name = "TokenRefusedError";
  }
}

/** A mistake in how a command was called or configured: exit 3, not a verdict. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface ClientOptions {
  /** The app's address, e.g. https://ryph.example.com, or one under a path (https://h/ryph). */
  url: string;
  /** `ryph_pat_…`. */
  token: string;
  fetch?: typeof globalThis.fetch;
  /** Where the warning about a token sent unencrypted goes; stderr by default. */
  warn?: (message: string) => void;
}

/** A request body, made fresh for each attempt. */
export type BodyFactory = () => Promise<{ body: BodyInit; headers: Record<string, string> }>;

/** What the access token says about its holder, read off its payload (the server verified it). */
export interface AccessClaims {
  sub: string;
  email: string;
  name: string;
  caps: string[];
  via: string;
}

/**
 * A path segment from an id. `.` and `..` survive encoding and a URL parser resolves them, so
 * `GET /v1/tasks/..` would reach `GET /v1/`: no id is either, and none is empty.
 */
export function seg(id: string): string {
  if (id === "" || id === "." || id === "..") {
    throw new UsageError(`${JSON.stringify(id)} is not an id`);
  }
  return encodeURIComponent(id);
}

/** The most of an answer's body the client reads: past it, the answer is refused. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** How long the token exchange may take before it is given up on. */
const EXCHANGE_TIMEOUT_MS = 30_000;

/**
 * `RYPH_URL` parsed: an http(s) address, with no query, fragment or credentials (each would be
 * mangled or leaked by joining paths onto it). A path is kept, so a deployment served under one
 * (`https://h/ryph`) works; trailing slashes are dropped where paths are joined.
 */
export function parseBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`RYPH_URL must be an http(s) address, got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UsageError(`RYPH_URL must be an http(s) address, got ${JSON.stringify(raw)}`);
  }
  const extra = [
    url.username !== "" && "a user name",
    url.password !== "" && "a password",
    url.search !== "" && "a query",
    url.hash !== "" && "a fragment",
  ].filter(Boolean);
  if (extra.length > 0) {
    throw new UsageError(
      `RYPH_URL must be the app's address alone, without ${extra.join(" or ")}: ` +
        "the API token is the only credential",
    );
  }
  return url;
}

/** `RYPH_URL` and `RYPH_TOKEN`, from the environment, else the settings file. */
export async function resolveClientConfig(
  env: (name: string) => string | undefined = (name) => process.env[name],
  file?: Map<string, string>,
  /** What the token should hold, for the message when it is missing. */
  holding = "what you mean to do with it",
): Promise<{ url: string; token: string }> {
  const values = file ?? (await readConfig().catch(() => ({ values: new Map() }))).values;
  const pick = (name: string) => env(name) || values.get(name) || "";
  const url = pick("RYPH_URL");
  const token = pick("RYPH_TOKEN");
  const missing = [!url && "RYPH_URL", !token && "RYPH_TOKEN"].filter(Boolean);
  if (missing.length > 0) {
    throw new UsageError(
      `set ${missing.join(" and ")}: the ryph web app's address, and an API token ` +
        `(ryph_pat_…, minted on your account page) holding ${holding}`,
    );
  }
  return { url: baseString(parseBaseUrl(url)), token };
}

/** The address's path without a trailing slash: "" at the root. */
const basePath = (url: URL) => url.pathname.replace(/\/+$/, "");

/** The address without a trailing slash, path included. */
const baseString = (url: URL) => `${url.origin}${basePath(url)}`;

/** What one client and the views of it made by `withSignal` share: the access token. */
interface TokenState {
  accessToken: string | null;
  /** When the access token stops being worth sending (a little early), in epoch ms. */
  expiresAt: number;
  /** The exchange in flight, which concurrent first calls share rather than each making one. */
  exchanging: Promise<string> | null;
}

export class RyphClient {
  /** The app's address as configured, path included, without a trailing slash. */
  readonly origin: string;
  readonly #base: URL;
  readonly #options: ClientOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #state: TokenState;
  /** Ends every request this view makes, beside each request's own. */
  readonly #signal: AbortSignal | undefined;

  constructor(options: ClientOptions, shared?: { state: TokenState; signal: AbortSignal }) {
    this.#base = parseBaseUrl(options.url);
    this.origin = baseString(this.#base);
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#state = shared?.state ?? { accessToken: null, expiresAt: 0, exchanging: null };
    this.#signal = shared?.signal;
    if (
      shared === undefined && this.#base.protocol === "http:" &&
      !isLoopbackHost(this.#base.hostname)
    ) {
      // Warned, not refused: a homelab install on a LAN address is a real deployment. Never on
      // stdout, which `ryph mcp` keeps for protocol frames.
      (options.warn ?? ((m: string) => console.error(m)))(
        `ryph: warning: RYPH_URL is http:// to ${this.#base.host}, so the API token and every ` +
          "answer travel unencrypted; use https:// unless this network is yours alone",
      );
    }
  }

  /**
   * The same client, sharing its access token, whose every request also ends when `signal`
   * does: a cancelled tool call stops its reads, whichever deadlines they carry of their own.
   */
  withSignal(signal: AbortSignal): RyphClient {
    return new RyphClient(this.#options, {
      state: this.#state,
      signal: anySignal(this.#signal, signal)!,
    });
  }

  /** A page of the app, for a link a person can open. */
  appUrl(path: string): string {
    return this.#join(path);
  }

  /**
   * The address of `path` under the configured one. Built on the parsed address, so the host
   * is always the configured one, whatever the path holds.
   */
  #join(path: string): string {
    const url = new URL(`${basePath(this.#base)}${path}`, this.#base.origin);
    if (url.origin !== this.#base.origin) throw new UsageError(`${path} is not a path`);
    return url.href;
  }

  /** Who the token speaks for and what it may do, from the access token itself. */
  async claims(): Promise<AccessClaims> {
    // The token in hand, or the one this exchange minted: re-reading the shared slot after the
    // await could find it cleared by a concurrent call's 401.
    const token = this.#state.accessToken !== null && Date.now() < this.#state.expiresAt
      ? this.#state.accessToken
      : await untilAborted(this.#exchange(), this.#signal);
    const payload = token.split(".")[1] ?? "";
    try {
      // base64url of UTF-8 JSON: `atob` alone gives Latin-1, which mangles a name like "Zoë".
      const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      return {
        sub: String(raw.sub ?? ""),
        email: String(raw.email ?? ""),
        name: String(raw.name ?? ""),
        caps: Array.isArray(raw.caps) ? raw.caps.map(String) : [],
        via: String(raw.via ?? ""),
      };
    } catch {
      throw new ApiError(0, "the access token the server minted could not be read");
    }
  }

  /** A JSON request; the parsed answer, or an `ApiError`. A 204 is null. `signal` ends it,
   * the answer's body included. */
  async json<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.send(
      method,
      path,
      body === undefined ? undefined : () =>
        Promise.resolve({
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
      signal,
    );
    if (!res.ok) throw await this.error(res);
    if (res.status === 204) return null as T;
    return await this.parseJson<T>(res, `${method} ${path}`);
  }

  /** A 2xx answer's body as JSON, or an `ApiError` saying what came back instead. */
  async parseJson<T = unknown>(res: Response, what: string): Promise<T> {
    const text = await readBody(res);
    if (text === "") return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // A 2xx that is not JSON is something in front of the app answering (a captive portal,
      // a proxy's page, an app too old to know the route), not the API.
      throw new ApiError(
        res.status,
        `${what} answered ${res.status} with something that is not JSON ` +
          `(${
            JSON.stringify(text.trim().split("\n")[0].slice(0, 120))
          }): is RYPH_URL the ryph app?`,
      );
    }
  }

  /** A text answer (a log); null on a 404. */
  async text(path: string, signal?: AbortSignal): Promise<string | null> {
    const res = await this.send("GET", path, undefined, signal);
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) throw await this.error(res);
    return await readBody(res);
  }

  /** One request with the access token, exchanging the API token first and again on a 401. */
  async send(method: string, path: string, body?: BodyFactory, callSignal?: AbortSignal) {
    const signal = anySignal(this.#signal, callSignal);
    for (let attempt = 0;; attempt++) {
      // Renewed ahead of expiry rather than on the 401 alone: an upload refused at the end
      // would have to be sent again.
      const state = this.#state;
      if (state.accessToken !== null && Date.now() >= state.expiresAt) state.accessToken = null;
      const fresh = state.accessToken === null;
      // The exchange is shared with concurrent calls, so this one stops waiting on it rather
      // than ending it.
      const accessToken = state.accessToken ?? await untilAborted(this.#exchange(), signal);
      const payload = body ? await body() : null;
      const res = await this.#fetchOrThrow(`${method} ${path}`, this.#join(`/api${path}`), {
        method,
        headers: { ...payload?.headers, authorization: `Bearer ${accessToken}` },
        body: payload?.body,
        signal,
        // An upload is answered only once the far side has taken it in (a check bundle: once the
        // forge has staged it, up to 10 minutes), and Bun's fetch gives up on a response silent
        // for its idle timeout (300 s) however much goes up. That deadline upstream is the bound.
        ...(payload?.body instanceof ReadableStream ? { duplex: "half", timeout: false } : {}),
      } as RequestInit, () => payload?.body instanceof ReadableStream ? payload.body : null);
      // Expired since it was minted: once more with a new one. A token minted just now that is
      // refused is not going to be accepted by minting another.
      if (res.status === 401 && attempt === 0 && !fresh) {
        await res.body?.cancel();
        if (payload?.body instanceof ReadableStream) await payload.body.cancel().catch(() => {});
        if (state.accessToken === accessToken) state.accessToken = null;
        continue;
      }
      return res;
    }
  }

  #exchange(): Promise<string> {
    const state = this.#state;
    state.exchanging ??= this.#doExchange().finally(() => {
      state.exchanging = null;
    });
    return state.exchanging;
  }

  async #doExchange(): Promise<string> {
    // Its own deadline, not a caller's: the exchange is shared, and one caller giving up must not
    // end it for the rest. A server that never answers must not hold every call forever either.
    const deadline = AbortSignal.timeout(EXCHANGE_TIMEOUT_MS);
    try {
      const res = await this.#fetchOrThrow("the token exchange", this.#join("/api/v1/auth/token"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: this.#options.token }),
        signal: deadline,
      });
      if (!res.ok) {
        const err = await this.error(res);
        if (res.status === 401 || res.status === 400) {
          throw new TokenRefusedError(
            res.status,
            "RYPH_TOKEN was refused: it is unknown, revoked or expired",
          );
        }
        throw err;
      }
      const answer = await this.parseJson<{ accessToken?: unknown; expiresIn?: unknown }>(
        res,
        "the token exchange",
      );
      if (typeof answer?.accessToken !== "string") {
        throw new ApiError(res.status, "the token exchange answered without an access token");
      }
      const life = typeof answer.expiresIn === "number" && answer.expiresIn > 0
        ? answer.expiresIn
        : 300;
      // Renewed a minute early, but never sooner than halfway nor than 10 s: a short-lived token
      // would otherwise be exchanged again on every request. Never kept past its own life, so a
      // token living under 10 s is not used after it expired.
      this.#state.accessToken = answer.accessToken;
      this.#state.expiresAt = Date.now() +
        Math.min(Math.max(life - 60, life / 2, 10), life) * 1000;
      return answer.accessToken;
    } catch (err) {
      if (deadline.aborted && !(err instanceof ApiError)) {
        throw new ApiError(
          0,
          `${this.origin} did not answer the token exchange within ${EXCHANGE_TIMEOUT_MS / 1000}s`,
        );
      }
      throw err;
    }
  }

  /**
   * One fetch, never following a redirect: a 307 or 308 would send the body (the exchange's,
   * which is the API token) to wherever the `Location` says. A redirect is an `ApiError` naming
   * it, for the person to decide whether RYPH_URL should be that address.
   */
  async #fetchOrThrow(
    what: string,
    url: string,
    init: RequestInit,
    upload: () => ReadableStream | null = () => null,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.#fetch(url, { ...init, redirect: "manual" });
    } catch (err) {
      if (init.signal?.aborted) throw err;
      throw new ApiError(
        0,
        `could not reach ${this.origin}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      await upload()?.cancel().catch(() => {});
      const location = res.headers.get("location");
      const target = location === null ? null : URL.parse(location, url)?.href ?? location;
      throw new ApiError(
        res.status,
        target === null
          ? `${what}: the server answered ${res.status}, a redirect with no address; is RYPH_URL the ryph app?`
          : `${what}: the server redirected to ${target}, which was not followed; set RYPH_URL ` +
            "to that address if it is correct",
        "redirect",
      );
    }
    return res;
  }

  /** A refusal as an `ApiError`, in the server's own words. */
  async error(res: Response): Promise<ApiError> {
    const text = await readBody(res).catch(() => "");
    let message = text.trim();
    let code: string | null = null;
    try {
      const parsed = JSON.parse(text) as { error?: unknown; code?: unknown; capability?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
      if (typeof parsed.code === "string") code = parsed.code;
    } catch {
      // Not JSON: a proxy's page, or plain text. Its first line is enough.
      message = message.split("\n")[0].slice(0, 200);
    }
    return new ApiError(res.status, `${res.status}: ${message || res.statusText}`, code);
  }
}

/**
 * An answer's body as text, read with a count: past `MAX_BODY_BYTES` the read stops and the
 * answer is refused, so a server cannot fill this process's memory.
 */
export async function readBody(res: Response, max = MAX_BODY_BYTES): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new ApiError(
          res.status,
          `the answer was larger than ${Math.round(max / 1024 / 1024)} MiB, and was not read`,
          "too-large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Both signals as one, either one alone, or none. */
function anySignal(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (a === undefined) return b;
  if (b === undefined || a === b) return a;
  return AbortSignal.any([a, b]);
}

/** The promise, or a rejection with the signal's reason once it aborts, whichever is first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

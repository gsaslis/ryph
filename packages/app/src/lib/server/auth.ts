import { dev } from "$app/environment";
import { env } from "$env/dynamic/private";
import type { Cookies } from "@sveltejs/kit";
import { z } from "zod";
import { userSchema } from "$lib/api/types";

// 127.0.0.1, not localhost: the host binds IPv4 loopback only, and macOS resolves localhost to
// ::1 first.
export const RYPH_API_URL = env.RYPH_API_URL ?? "http://127.0.0.1:7411";
/**
 * Where history reads (the transcript GET and the SSE tail) are proxied. Defaults to the
 * orchestrator origin, so a single-process deployment is a no-op; point it at a standalone
 * historian to route the transcript-read firehose there instead of through the control plane.
 */
export const RYPH_HISTORY_URL = env.RYPH_HISTORY_URL ?? RYPH_API_URL;
/**
 * Where provider-key management is proxied — the model-proxy's CONTROL listener, not the data
 * plane agent containers dial. Defaults to the orchestrator origin, so a single-process
 * deployment (which mounts the same routes into its own router) is a no-op; point it at a
 * standalone model-proxy to reach the service that actually holds the master key.
 */
export const RYPH_MODEL_PROXY_CONTROL_URL = env.RYPH_MODEL_PROXY_CONTROL_URL ?? RYPH_API_URL;
/**
 * Where MCP-server management, the probe and a run's tool-call trail are proxied — the
 * mcp-gateway's CONTROL listener, never the data plane agent containers dial. Same rule as the
 * model-proxy's: defaults to the orchestrator origin for the single-process deployment; point it
 * at a standalone gateway to reach the service that actually holds the MCP master key.
 */
export const RYPH_MCP_GATEWAY_CONTROL_URL = env.RYPH_MCP_GATEWAY_CONTROL_URL ?? RYPH_API_URL;
/**
 * Where automation CRUD is proxied — the automations service, which owns the recipes and their
 * fire history. Defaults to the orchestrator origin, so a single-process deployment (which
 * mounts the same routes into its own router) is a no-op.
 */
export const RYPH_AUTOMATIONS_URL = env.RYPH_AUTOMATIONS_URL ?? RYPH_API_URL;
/**
 * Where the memory manager is proxied — the memory service's management surface, never its
 * internal surface (the control plane's) or its MCP route (the gateway's). Same rule as the
 * others: defaults to the orchestrator origin for the single-process deployment, which mounts the
 * routes into its own router; point it at a standalone memory service otherwise.
 */
export const RYPH_MEMORY_URL = env.RYPH_MEMORY_URL ?? RYPH_API_URL;
/**
 * Where chatroom management is proxied — the chat service's management surface, never its
 * internal surface (the control plane's bindings) or its MCP route (the gateway's). Defaults to
 * the orchestrator origin for the single-process deployment, which mounts the routes into its
 * own router; point it at a standalone chat service otherwise.
 */
export const RYPH_CHAT_URL = env.RYPH_CHAT_URL ?? RYPH_API_URL;

/**
 * The session cookies' names on this origin. Over HTTPS they carry the `__Host-` prefix, which a
 * browser only accepts on a cookie set Secure, for Path=/ and with no Domain: no sibling subdomain
 * can then plant or shadow one (a same-site page could otherwise log a person in as someone else
 * by setting `ryph_access_token` for the parent domain). A plain-HTTP origin — the local binary on
 * http://localhost or a LAN address — cannot have a Secure cookie, so it keeps the plain names.
 */
export function authCookieNames(url: URL): { access: string; refresh: string } {
  return url.protocol === "https:"
    ? { access: "__Host-ryph_access_token", refresh: "__Host-ryph_refresh_token" }
    : { access: "ryph_access_token", refresh: "ryph_refresh_token" };
}

// Matches the auth service's default refresh token TTL.
const REFRESH_TOKEN_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export const tokenPairSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
  refreshToken: z.string(),
  user: userSchema,
});
export type TokenPair = z.infer<typeof tokenPairSchema>;

export const COMMON_COOKIE_OPTIONS = {
  path: "/",
  sameSite: "lax",
  httpOnly: true,
  secure: !dev,
} as const;

/** What a session cookie is set and cleared with: always Secure over HTTPS, which `__Host-`
 * requires even under `vite dev`. */
function authCookieOptions(url: URL) {
  return {
    ...COMMON_COOKIE_OPTIONS,
    secure: COMMON_COOKIE_OPTIONS.secure || url.protocol === "https:",
  };
}

/** The part of a request event the session cookies are read and written through. */
export type CookieEvent = { cookies: Cookies; url: URL };

/** The session cookies as this request carries them. */
export function readAuthCookies(event: CookieEvent): { access?: string; refresh?: string } {
  const names = authCookieNames(event.url);
  return { access: event.cookies.get(names.access), refresh: event.cookies.get(names.refresh) };
}

export function setAuthCookies(event: CookieEvent, pair: TokenPair) {
  const names = authCookieNames(event.url);
  const options = authCookieOptions(event.url);
  event.cookies.set(names.access, pair.accessToken, { ...options, maxAge: pair.expiresIn });
  event.cookies.set(names.refresh, pair.refreshToken, {
    ...options,
    maxAge: REFRESH_TOKEN_MAX_AGE_SECONDS,
  });
}

export function clearAuthCookies(event: CookieEvent) {
  const names = authCookieNames(event.url);
  const options = authCookieOptions(event.url);
  event.cookies.delete(names.access, options);
  event.cookies.delete(names.refresh, options);
}

export class UpstreamAuthError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type ClientEvent = { request: Request; getClientAddress(): string };

/**
 * The browser behind a request, as this server saw it: its user agent, and its address on a
 * header of its own, since the upstream trusts this server and not any forwarding chain. On its
 * own it proves nothing; see `sessionHeaders`.
 */
export function clientHeaders(event: ClientEvent): Record<string, string> {
  const headers: Record<string, string> = {};
  const userAgent = event.request.headers.get("user-agent");
  if (userAgent) headers["x-client-user-agent"] = userAgent;
  try {
    headers["x-client-ip"] = event.getClientAddress();
  } catch {
    // Not every adapter can name the peer; the session then simply records no address.
  }
  return headers;
}

/**
 * The header the proxy secret rides on: @ryph/auth's PROXY_SECRET_HEADER, which this package
 * does not import (it builds on Node, through Vite). Tests on each side hold it to this literal.
 */
export const PROXY_SECRET_HEADER = "x-ryph-proxy-secret";

/**
 * RYPH_PROXY_SECRET, which tells the control plane that the client facts beside it come from
 * this server. It goes to the control plane (RYPH_API_URL) only: every other upstream would
 * just be one more place holding it.
 */
export function proxySecretHeaders(): Record<string, string> {
  return env.RYPH_PROXY_SECRET ? { [PROXY_SECRET_HEADER]: env.RYPH_PROXY_SECRET } : {};
}

/**
 * The boot check on RYPH_PROXY_SECRET, run from the server's `init` hook. Without it the control
 * plane trusts no address this server forwards, so every visitor shares one anonymous budget on
 * the sign-in flows: a built server refuses to start that way. Every deployment sets it — compose,
 * both k8s overlays, and the binary, which mints one per launch for its embedded app. `vite dev`
 * only warns: `./dev` runs a single-user host that sets none either, and a fixed dev value is one
 * the services' public-placeholder check would refuse.
 */
export function checkProxySecret(
  isDev: boolean = dev,
  secret: string | undefined = env.RYPH_PROXY_SECRET,
): void {
  if (secret) return;
  const why = "RYPH_PROXY_SECRET is unset. Set it to the control plane's value, " +
    "or every visitor shares one sign-in rate limit.";
  if (!isDev) throw new Error(why);
  console.warn(`[ryph] ${why} Fine for ./dev; required anywhere else.`);
}

/**
 * What a control-plane call carries about the browser behind it: what a session records for the
 * user's own sessions list, and what the anonymous budgets are keyed on. Vouched for with the
 * proxy secret, so a caller that dials the control plane directly cannot claim an address of its
 * own choosing.
 */
export function sessionHeaders(event: ClientEvent): Record<string, string> {
  return { ...clientHeaders(event), ...proxySecretHeaders() };
}

async function authApi(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${RYPH_API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    throw new UpstreamAuthError(
      res.status,
      typeof errorBody?.error === "string"
        ? errorBody.error
        : `auth request failed (${res.status})`,
    );
  }

  return res.json();
}

export async function loginWithPassword(
  email: string,
  password: string,
  headers: Record<string, string> = {},
): Promise<TokenPair> {
  return tokenPairSchema.parse(await authApi("/v1/auth/login", { email, password }, headers));
}

/**
 * Whether the session behind an access token still exists upstream. True on anything but a
 * clear "no": an unreachable control plane is not a sign-out.
 */
export async function sessionAlive(accessToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${RYPH_API_URL}/v1/auth/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return res.status !== 401;
  } catch {
    return true;
  }
}

export async function refreshTokenPair(
  refreshToken: string,
  headers: Record<string, string> = {},
): Promise<TokenPair> {
  return tokenPairSchema.parse(await authApi("/v1/auth/refresh", { refreshToken }, headers));
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  await authApi("/v1/auth/logout", { refreshToken });
}

/**
 * Registers. Returns the new user in setup mode; under open registration the answer carries no
 * user at all, taken or not, so nothing here can tell which. Name and password are the first
 * admin's only: everyone else gives theirs on the mailed link. The client headers matter here:
 * without them every sign-up shares one budget upstream, and a stranger could spend it to keep
 * the operator's claim answering 429.
 */
export async function createUser(
  input: { email: string; name?: string; password?: string; setupToken?: string },
  headers: Record<string, string> = {},
) {
  const body = await authApi("/v1/auth/users", input, headers);
  return z.object({ id: z.string() }).safeParse(body).success ? userSchema.parse(body) : null;
}

/** Spends a mailed verification link: the address is proven, its name and password set, and a
 * session comes back. */
export async function verifyEmail(
  token: string,
  input: { name: string; password: string },
  headers: Record<string, string> = {},
): Promise<TokenPair> {
  return tokenPairSchema.parse(
    await authApi(`/v1/auth/verify/${encodeURIComponent(token)}`, input, headers),
  );
}

/** Spends a single-user login link — what `ryph up` and `ryph login` open — for a session. */
export async function redeemLoginLink(
  token: string,
  headers: Record<string, string> = {},
): Promise<TokenPair> {
  return tokenPairSchema.parse(await authApi("/v1/auth/login-link", { token }, headers));
}

/** Pins a sign-in challenge upstream; the browser answers it with an authenticator. */
export async function passkeyLoginOptions(): Promise<unknown> {
  return await authApi("/v1/auth/passkeys/login/options", {});
}

/** Trades an authenticator's answer for a session. */
export async function loginWithPasskey(
  input: { challengeId: string; response: unknown },
  headers: Record<string, string> = {},
): Promise<TokenPair> {
  return tokenPairSchema.parse(await authApi("/v1/auth/passkeys/login/verify", input, headers));
}

/**
 * Redeems an invite. A bound one answers with a session; an open one answers with nothing, since
 * the account waits for its mailed link like an open registration does.
 */
export async function acceptInvite(
  token: string,
  input: { name?: string; email: string | null; password?: string },
  headers: Record<string, string> = {},
): Promise<TokenPair | null> {
  const body = await authApi(
    `/v1/auth/invites/${encodeURIComponent(token)}/accept`,
    input,
    headers,
  );
  const pair = tokenPairSchema.safeParse(body);
  return pair.success ? pair.data : null;
}

// What the one secret signs. RYPH_PREVIEWS_TOKEN is both the control plane's bearer and the HMAC
// key, so every use of it as a key carries its own label ("shard:", "id:", "view:", "enter:",
// "peer", "forward"): a value signed for one purpose never verifies as another, and nothing signed
// here is ever the control plane's bearer. Each label is a word no other one starts with, followed
// by a colon or by nothing at all, so no two purposes can ever sign the same string.
import { mintToken, sha256Hex, timingSafeEqual } from "@ryph/sealed";

/** The viewer cookie over https. `__Host-` makes browsers refuse it with a `Domain`, and from a
 * sibling. */
export const COOKIE = "__Host-ryph-preview";
/** The viewer cookie over http (compose, on `*.localhost`), where Safari refuses `Secure` and so
 * `__Host-`. It stays host-only by carrying no `Domain`. */
export const HTTP_COOKIE = "ryph-preview";
/** Both names: a dev server may never set either, nor be sent one, whatever the scheme. */
export const COOKIES: readonly string[] = [COOKIE, HTTP_COOKIE];

/** The viewer cookie's name on a preview served over `scheme`. */
export const cookieName = (scheme: "http" | "https"): string =>
  scheme === "https" ? COOKIE : HTTP_COOKIE;
/** How long a viewer stays in once they have entered. */
export const COOKIE_TTL_S = 8 * 60 * 60;
/** How long a runner has to dial its tunnel after registering. */
export const TUNNEL_TICKET_MS = 10_000;
/** How long a viewer has to follow the link the control plane handed them. */
export const VIEWER_TICKET_MS = 60_000;

export interface Keys {
  /** Lowercase hex HMAC-SHA256 of `label`. */
  sign(label: string): Promise<string>;
  /** Constant-time check of a presented bearer against the token. */
  bearer(presented: string | null): Promise<boolean>;
}

export async function keys(secret: string): Promise<Keys> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = await sha256Hex(secret);
  return {
    async sign(label) {
      const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(label));
      return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
    },
    // Hashed first, so the comparison is over equal lengths whatever was presented.
    async bearer(presented) {
      return presented !== null && timingSafeEqual(await sha256Hex(presented), expected);
    },
  };
}

/** Hex digits of a preview id that name its run's shard. */
export const SHARD_HEX = 8;

/** Which shard a run's previews live in: every pod derives the same one from the run alone, and
 * the pod that owns it from that (cluster.ts). Keyed, so it says nothing about the run id. */
export async function shardOf(k: Keys, runId: string): Promise<string> {
  return (await k.sign(`shard:${runId}`)).slice(0, SHARD_HEX);
}

/** Stable for a (run, port): a runner that reconnects, or a restarted service, gets the same
 * origin back, so links and viewer cookies survive both. It starts with the run's shard, so any
 * pod tells the owner from the Host alone; two previews of one run share that prefix, and the
 * other 24 hex (96 bits) stay unguessable without the key. */
export async function previewId(k: Keys, runId: string, port: number): Promise<string> {
  const own = (await k.sign(`id:${runId}:${port}`)).slice(0, 32 - SHARD_HEX);
  return `${await shardOf(k, runId)}${own}`;
}

/** The shard a preview id starts with. */
export const shardOfId = (id: string): string => id.slice(0, SHARD_HEX);

/** What one previews pod presents to another's peer listener. Derived, so the pods share no
 * credential beyond the token, and only they hold it: it never leaves a request between pods. */
export const peerCredential = (k: Keys): Promise<string> => k.sign("peer");

/** What one previews pod presents to another's API listener in place of the control plane's
 * bearer, on a call it forwards. Derived and one-way, so the token itself never crosses between
 * pods, and apart from the peer credential, so neither listener takes the other's. */
export const forwardCredential = (k: Keys): Promise<string> => k.sign("forward");

/** A single-use ticket: random, never derived. */
export const ticket = (): string => mintToken();

/**
 * A viewer ticket for preview `id`: `<exp>.<nonce>.<mac>`, `exp` in Unix seconds, the MAC over the
 * preview, the expiry and the nonce. The pod that owns the preview mints it and keeps it until it
 * is spent (it is single-use there); any other pod tells a real one from a forgery by its MAC, so
 * only a ticket the control plane asked for is ever sent on to the owner.
 */
export async function viewerTicket(k: Keys, id: string, nowMs: number): Promise<string> {
  const exp = Math.ceil((nowMs + VIEWER_TICKET_MS) / 1000);
  const nonce = mintToken().slice(0, 32);
  return `${exp}.${nonce}.${await k.sign(`enter:${id}:${exp}:${nonce}`)}`;
}

/** True when `value` is a viewer ticket minted for preview `id` that has not expired. Says
 * nothing of whether it was spent: only the owner knows that. */
export async function viewerTicketValid(
  k: Keys,
  id: string,
  value: string,
  nowMs: number,
): Promise<boolean> {
  const match = /^(\d{1,12})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(value);
  if (!match) return false;
  const exp = Number(match[1]) * 1000;
  // Never longer than we mint for, with a second's rounding and a few between pods' clocks.
  if (exp <= nowMs || exp > nowMs + VIEWER_TICKET_MS + 5_000) return false;
  return timingSafeEqual(match[3], await k.sign(`enter:${id}:${match[1]}:${match[2]}`));
}

/** The cookie's value for preview `id`: `<exp>.<mac>`, `exp` in Unix seconds. */
export async function viewerCookie(k: Keys, id: string, nowMs: number): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + COOKIE_TTL_S;
  return `${exp}.${await k.sign(`view:${id}:${exp}`)}`;
}

const VIEWER_COOKIE = /^(\d{1,12})\.([a-f0-9]{64})$/;

/** Whether `value` could be a viewer cookie now: well-formed, and neither expired nor from past
 * when one minted now would expire. Costs no HMAC. */
export function viewerCookieShaped(value: string, nowMs: number): boolean {
  const match = VIEWER_COOKIE.exec(value);
  if (!match) return false;
  const exp = Number(match[1]);
  const now = nowMs / 1000;
  // Never longer than we mint for: a value from the future was not minted by this key's clock.
  return exp > now && exp <= now + COOKIE_TTL_S + 60;
}

/** True when `value` was minted for preview `id` and has not expired. */
export async function viewerCookieValid(
  k: Keys,
  id: string,
  value: string,
  nowMs: number,
): Promise<boolean> {
  if (!viewerCookieShaped(value, nowMs)) return false;
  const [exp, mac] = value.split(".");
  return timingSafeEqual(mac, await k.sign(`view:${id}:${exp}`));
}

/** The `Set-Cookie` that lets a viewer in. Host-only, so no sibling preview can read or set it. */
export const setViewerCookie = (value: string, scheme: "http" | "https"): string =>
  scheme === "https"
    ? `${COOKIE}=${value}; Max-Age=${COOKIE_TTL_S}; Path=/; Secure; HttpOnly; SameSite=Lax`
    : `${HTTP_COOKIE}=${value}; Max-Age=${COOKIE_TTL_S}; Path=/; HttpOnly; SameSite=Lax`;

/** Every value a `Cookie` header gives `name`; a browser may send one name more than once. */
export function cookieValues(header: string | undefined, name: string): string[] {
  if (!header) return [];
  return header.split(";").flatMap((pair) => {
    const eq = pair.indexOf("=");
    if (eq < 0 || pair.slice(0, eq).trim() !== name) return [];
    return [pair.slice(eq + 1).trim()];
  });
}

/** The `Cookie` header without `names`, or undefined when nothing else is left. */
export function withoutCookies(
  header: string | undefined,
  names: readonly string[],
): string | undefined {
  if (!header) return undefined;
  const kept = header.split(";").map((pair) => pair.trim()).filter((pair) => {
    if (pair === "") return false;
    const eq = pair.indexOf("=");
    return !names.includes((eq < 0 ? pair : pair.slice(0, eq)).trim());
  });
  return kept.length ? kept.join("; ") : undefined;
}

import { z } from "zod";

const accessClaimJwtSchema = z.object({
  sub: z.string(),
  email: z.string(),
  name: z.string(),
  caps: z.array(z.string()),
  email_verified: z.boolean().optional(),
  exp: z.number(),
});

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  /** Every capability the user holds, or `["*"]` for an owner. */
  caps: string[];
  emailVerified: boolean;
};

// Consider the token expired slightly early so requests made with it
// don't die mid-flight.
const EXPIRY_BUFFER_SECONDS = 30;

function decodeJwtPayload(jwt: string): unknown {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;

  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Decodes an access token JWT and returns the logged-in user, or null if the
 * token is malformed or expires within the buffer window (meaning it should
 * be refreshed, not trusted).
 */
export function getUserData(jwt: string | null | undefined): SessionUser | null {
  if (!jwt) return null;

  const parsed = accessClaimJwtSchema.safeParse(decodeJwtPayload(jwt));
  if (!parsed.success) return null;

  const now = Math.floor(Date.now() / 1000);
  if (parsed.data.exp < now + EXPIRY_BUFFER_SECONDS) return null;

  return {
    id: parsed.data.sub,
    email: parsed.data.email,
    name: parsed.data.name,
    caps: parsed.data.caps,
    emailVerified: parsed.data.email_verified ?? false,
  };
}

/**
 * Whether an access token was minted for a browser session (`via: "session"`), read off its
 * payload without checking the signature: every service checks that, so a forged claim gets no
 * further than the first one. Only such a token may ride the session cookie. A token holder could
 * otherwise put the access token their API token exchanged for into that cookie, and the proxy
 * would forward it on every route, past the bearer doors that hold an API token to its own.
 */
export function isSessionToken(jwt: string | null | undefined): jwt is string {
  if (!jwt) return false;
  const payload = decodeJwtPayload(jwt);
  return payload !== null && typeof payload === "object" &&
    (payload as { via?: unknown }).via === "session";
}

/**
 * How many more seconds `getUserData` will accept this access token, or null when it already
 * would not. The browser cannot read the token (its cookie is httpOnly), so the server tells it
 * this instead, and the browser counts it down on its own clock: a frame that loads the token
 * later (an artifact's content route, which never refreshes) is placed only after a refresh once
 * this runs low.
 */
export function sessionSecondsLeft(jwt: string | null | undefined): number | null {
  if (!jwt) return null;
  const parsed = accessClaimJwtSchema.safeParse(decodeJwtPayload(jwt));
  if (!parsed.success) return null;
  const left = parsed.data.exp - EXPIRY_BUFFER_SECONDS - Math.floor(Date.now() / 1000);
  return left > 0 ? left : null;
}

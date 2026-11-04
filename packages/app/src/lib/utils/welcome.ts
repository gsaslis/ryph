// Whether a signed-in person is sent through the welcome flow, and the flag that stops it.

import { can } from "$lib/utils/auth/capabilities";

/** Set once the welcome flow is finished or skipped, in this browser. */
export const WELCOME_COOKIE = "ryph_welcome";

/** A year: the flag outlives any session, and losing it costs one trip back through the flow. */
const WELCOME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Whether a `Cookie` header (or `document.cookie`) carries the flag. */
export function welcomeFlagIn(cookies: string): boolean {
  return cookies.split(";").some((part) => part.trim().startsWith(`${WELCOME_COOKIE}=`));
}

/** Sets the flag in this browser. Harmless on the server, where there is no document. */
export function markWelcomeDone(): void {
  if (typeof document === "undefined") return;
  document.cookie =
    `${WELCOME_COOKIE}=done; path=/; max-age=${WELCOME_COOKIE_MAX_AGE}; samesite=lax`;
}

/** Only someone who can register a model key and make an agent is welcomed: an admin. */
export function mayBeWelcomed(user: { caps: readonly string[] } | null | undefined): boolean {
  return can(user, "models:manage") && can(user, "agents:write");
}

/**
 * Whether the instance is fresh: no model key and no agent, archived or not. Anything at all
 * means someone has set it up already, and the welcome would only be in the way.
 */
export function isFreshInstance(state: { keys: number; agents: number }): boolean {
  return state.keys === 0 && state.agents === 0;
}

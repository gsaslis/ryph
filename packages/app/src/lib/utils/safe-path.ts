/**
 * Validates a `backTo` query param so it can only point within the app —
 * prevents open redirects via absolute or protocol-relative URLs. Parsed the way a browser
 * would, which drops tabs and newlines and reads `\` as `/`: `/\t/evil.com` is `//evil.com`.
 * What comes back is the path the browser would land on, never the raw value.
 */
export function safeBackTo(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/")) return null;
  const base = "http://in.app";
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  if (url.origin !== base) return null;
  // Resolving dot segments can leave a path that is itself protocol-relative: `/..//evil.com` is
  // `//evil.com` once normalised, which would leave the app when used as a link.
  if (url.pathname.startsWith("//")) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * A link within a flow that was entered from elsewhere, carrying that page along as `backTo` so
 * every step of the flow can still return there. Without one, the link is left as it is.
 */
export function withBackTo(path: string, backTo: string | null | undefined): string {
  const safe = safeBackTo(backTo);
  if (safe === null) return path;
  const [base, hash] = path.split("#", 2);
  const joined = `${base}${base.includes("?") ? "&" : "?"}backTo=${encodeURIComponent(safe)}`;
  return hash === undefined ? joined : `${joined}#${hash}`;
}

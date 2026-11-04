// The page may reach what its run could reach and no more. The control plane hands over the run's
// egress allowlist (`null` when the run's network is open), and each preview's responses carry a
// CSP built from it, beside whatever CSP the dev server sends: browsers enforce both.

/** A hostname an allowlist may name: a DNS name, optionally with a leading `*.`, as the
 * orchestrator's `hostRefusal` admits. Anything else could smuggle a directive into the CSP. */
export function validHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const body = host.startsWith("*.") ? host.slice(2) : host;
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(body);
}

/** `null` is open mode: only framing is held, since a page that may fetch anywhere gains nothing
 * from a held form or `<base>`. Framing is held to the page's own origin, not refused: Storybook
 * and the Vitest UI frame their own pages, and a sibling preview or the app is still another
 * origin. A CSP `*.example.com` matches one label or more and never the bare domain, the same as
 * the egress proxy's wildcard. Fetches and WebSockets fall back to `default-src`, which also
 * admits `data:` and `blob:`: those carry nothing off the page, and one list keeps fetches and
 * subresources alike. Forms are held to the allowlist too (`form-action` does not fall back), over
 * https only since a form never posts to a WebSocket, and `<base>` to the page's own origin. */
export function contentSecurityPolicy(hosts: readonly string[] | null): string {
  if (hosts === null) return "frame-ancestors 'self'";
  const sources = hosts.flatMap((host) => [` https://${host}`, ` wss://${host}`]).join("");
  const forms = hosts.map((host) => ` https://${host}`).join("");
  return `default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:${sources}; ` +
    `form-action 'self'${forms}; base-uri 'self'; frame-ancestors 'self'`;
}

// Which browser requests reach a dev server, for both preview hosts: the local binary
// (packages/host) and the hosted service (packages/previews). Each checks first that the request
// names its preview's exact host and an origin-form path; this decides whether the page asking is
// the preview's own.
import type { IncomingHttpHeaders } from "node:http";

export interface GateOptions {
  /** Let an upgrade with no `Origin` through. Browsers always send one, so only another client
   * comes without: the local binary's loopback listener lets such tools in, the hosted service
   * does not. */
  originlessUpgrade?: boolean;
}

/**
 * May this request reach the dev server of the preview at `own` (its origin)? `Origin` must be
 * the preview's own when present, and on an upgrade it must be present. A request from anywhere
 * but the preview itself is refused unless it is a top-level navigation: opening the link from
 * ryph is one, a sibling preview (same-site on a hosted domain) or a foreign page silently
 * fetching or framing this one is not, and a form it posts carries its Origin and fails the check
 * above.
 */
export function permitted(
  headers: IncomingHttpHeaders,
  own: string,
  upgrade: boolean,
  options: GateOptions = {},
): boolean {
  if (headers.origin === undefined) {
    if (upgrade && !options.originlessUpgrade) return false;
  } else if (headers.origin !== own) return false;
  const site = headers["sec-fetch-site"];
  if (site === undefined || site === "same-origin" || site === "none") return true;
  const dest = headers["sec-fetch-dest"];
  return !upgrade && headers["sec-fetch-mode"] === "navigate" &&
    (dest === undefined || dest === "document");
}

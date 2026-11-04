// What crosses the proxy, rewritten both ways. Upstream, the dev server sees itself addressed as
// `localhost:<port>` (Vite and its kind refuse hosts they do not know) and never sees our cookie.
// Downstream, nothing it says may reach past its own origin: no cookie for a parent domain, no
// cookie of ours, and a CSP the run's allowlist decides.
import type { IncomingHttpHeaders } from "node:http";
import { CONNECTION_HEADER, HOP_HEADER, PEER_HEADER, WAIT_HEADER } from "./cluster.ts";
import { COOKIES, withoutCookies } from "./keys.ts";

export interface Target {
  /** The dev server's port inside the run. */
  port: number;
  /** The preview's origin, e.g. `https://<id>.preview.ryph-previews.example`. */
  origin: string;
  /** This preview's CSP (see csp.ts). */
  csp: string;
}

// What the Gateway and the browser say about where a request came from: the viewer's address is
// not the agent's to know, and a chain the browser forged is not ours to vouch for. And what one
// previews pod says to another: the peer listener takes its credential off first, and this holds
// whatever path a request took.
const FORWARDING = new Set([
  "forwarded",
  "via",
  "x-real-ip",
  PEER_HEADER,
  HOP_HEADER,
  WAIT_HEADER,
  CONNECTION_HEADER,
]);

export function upstreamHeaders(headers: IncomingHttpHeaders, to: Target): IncomingHttpHeaders {
  const local = `localhost:${to.port}`;
  const out: IncomingHttpHeaders = Object.fromEntries(
    Object.entries(headers).filter(([name]) =>
      !FORWARDING.has(name) && !name.startsWith("x-forwarded-")
    ),
  );
  out.host = local;
  // `permitted` has already held Origin to the preview's own; anything else passes as it is.
  if (headers.origin === to.origin) out.origin = `http://${local}`;
  const cookie = withoutCookies(headers.cookie, COOKIES);
  if (cookie === undefined) delete out.cookie;
  else out.cookie = cookie;
  const url = new URL(to.origin);
  out["x-forwarded-host"] = url.host;
  out["x-forwarded-proto"] = url.protocol.slice(0, -1);
  return out;
}

/** A `Set-Cookie` the dev server may send: host-only, and never ours under either name. Null
 * drops it. */
export function containCookie(line: string): string | null {
  const [pair, ...attributes] = line.split(";");
  const eq = pair.indexOf("=");
  const name = (eq < 0 ? pair : pair.slice(0, eq)).trim().toLowerCase();
  const value = pair.slice(eq + 1).trim().toLowerCase();
  // Browsers match the `__Host-` prefix in any case, so ours are matched that way too. A cookie
  // with no name is sent back as its bare value, so `=__Host-ryph-preview=x` would pose as ours.
  for (const ours of COOKIES.map((cookie) => cookie.toLowerCase())) {
    if (name === ours || (name === "" && value.startsWith(ours))) return null;
  }
  const kept = attributes.filter((attribute) =>
    attribute.split("=", 1)[0].trim().toLowerCase() !== "domain"
  );
  return [pair, ...kept].join(";");
}

// CSP directives that send reports wherever they name, past the allowlist.
const REPORTING_DIRECTIVES = new Set(["report-uri", "report-to"]);

/** The dev server's CSP header value without its reporting directives, or null when nothing is
 * left. Split as browsers split it: policies at commas (a repeated header arrives comma-joined),
 * directives at semicolons, a directive's name before its first whitespace, in any case. */
export function withoutReporting(value: string): string | null {
  const policies = value.split(",").map((policy) =>
    policy.split(";").filter((directive) => {
      const name = directive.trim().split(/[\t\n\f\r ]/, 1)[0].toLowerCase();
      return name !== "" && !REPORTING_DIRECTIVES.has(name);
    }).join(";").trim()
  ).filter((policy) => policy !== "");
  return policies.length ? policies.join(", ") : null;
}

const REPORTING = ["nel", "report-to", "reporting-endpoints"];

export function downstreamHeaders(headers: IncomingHttpHeaders, to: Target): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = { ...headers };
  const cookies = (headers["set-cookie"] ?? []).flatMap((line) => containCookie(line) ?? []);
  if (cookies.length) out["set-cookie"] = cookies;
  else delete out["set-cookie"];
  // Clearing "cookies" reaches the whole registrable domain: every viewer of every preview.
  delete out["clear-site-data"];
  // Reports go wherever these name, past the allowlist the CSP holds the page to. A report-only
  // policy blocks nothing, so all it could do is report.
  for (const name of REPORTING) delete out[name];
  delete out["content-security-policy-report-only"];
  const location = headers.location;
  if (location !== undefined) {
    for (const own of [`http://localhost:${to.port}`, `http://127.0.0.1:${to.port}`]) {
      const rest = location.slice(own.length);
      if (location.startsWith(own) && (rest === "" || /^[/?#]/.test(rest))) {
        out.location = to.origin + rest;
        break;
      }
    }
  }
  const theirs = [headers["content-security-policy"] ?? []].flat()
    .flatMap((value) => withoutReporting(value) ?? []);
  // Browsers enforce every policy they are sent, so ours never replaces the dev server's.
  out["content-security-policy"] = theirs.length ? [...theirs, to.csp] : to.csp;
  return out;
}

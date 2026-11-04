// Where a preview lives and which requests are its own. Previews are same-site with each other
// (they share `preview.ryph-previews.example`), so the cookie alone does not tell a viewer's own page
// from a sibling preview riding it: the gate both preview hosts share (`permitted` in
// @ryph/tunnel) applies to every request that carries it.
import type { IncomingHttpHeaders } from "node:http";

/** Where a preview lives, as the browser sees it. */
export interface Place {
  /** `http` only on `*.localhost`. */
  scheme: "http" | "https";
  domain: string;
  /** Only for `http` on `*.localhost`; the Gateway serves on the scheme's own port. */
  publicPort?: number;
}

/** `<id>.<domain>` plus the public port when there is one. */
export const authority = (place: Place, id: string): string =>
  `${id}.${place.domain}${place.publicPort === undefined ? "" : `:${place.publicPort}`}`;

export const origin = (place: Place, id: string): string =>
  `${place.scheme}://${authority(place, id)}`;

/** The preview id a `Host` header names, or null for anything but exactly a preview's own. */
export function previewOf(place: Place, host: string | undefined): string | null {
  if (host === undefined) return null;
  const id = host.slice(0, 32);
  return /^[a-f0-9]{32}$/.test(id) && host === authority(place, id) ? id : null;
}

/** Whether a `Host` header names the preview domain or any name under it, port aside: such a
 * request is a browser's, never a probe's (the kubelet and the load balancer ask by address). */
export function underDomain(place: Place, host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.toLowerCase().replace(/:[0-9]*$/, "").replace(/\.$/, "");
  return name === place.domain || name.endsWith(`.${place.domain}`);
}

/** The path a request target names, or null for anything but an origin-form `/…`. */
export function pathOf(url: string | undefined): string | null {
  if (!url?.startsWith("/") || url.startsWith("//")) return null;
  return url.split(/[?#]/, 1)[0];
}

/** Paths under here are the service's own and never forwarded. */
export const RESERVED = "/__ryph/";

/** A service worker would outlive the run, serving its pages from the browser's cache. */
export const serviceWorker = (headers: IncomingHttpHeaders): boolean =>
  headers["service-worker"] === "script";

/** The longest path a viewer ticket carries to `/__ryph/enter`. */
export const MAX_LANDING = 2048;

/**
 * Where `/__ryph/enter` sends a viewer: the path they asked for when it is a plain same-origin
 * one, `/` for anything else. Printable ASCII only (a browser's request target is already
 * percent-encoded), never `//` or a backslash a browser could read as another host, no fragment,
 * no dot segments (`%2e` ones included), and nothing of ours.
 */
export function landing(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_LANDING) return "/";
  if (!/^\/(?![/\\])[\x21-\x7e]*$/.test(value) || /[\\#]/.test(value)) return "/";
  // A dot segment would let the browser normalise `/./__ryph/…` onto a path of ours, and it reads
  // `%2e` (either case) as a dot there.
  const path = value.split("?")[0].replace(/%2e/gi, ".");
  if (/(^|\/)\.{1,2}(\/|$)/.test(path)) return "/";
  return value.startsWith(RESERVED) ? "/" : value;
}

/** RYPH_PREVIEWS_APP_URL as an origin, or null when it is not exactly an http(s) origin. */
export function appOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return null;
  }
  // `https://app.example` and `https://app.example/` alike, but no path.
  if (url.pathname !== "/" || !/^https?:\/\/[^/?#\\]+\/?$/i.test(value)) return null;
  return url.origin;
}

/**
 * Multi-label public suffixes common enough to know, so a domain under one is not read as the
 * suffix itself. The Helm chart's `ryph.registrableDomain` keeps the same list.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "co.kr",
  "com.br",
  "com.cn",
  "com.hk",
  "com.sg",
  "com.tw",
  "co.in",
  "co.za",
  "com.mx",
  "com.tr",
  "co.il",
]);

/**
 * A hostname's registrable domain, near enough to refuse a preview domain on the app's site: the
 * last two labels, or three under a suffix `MULTI_LABEL_SUFFIXES` knows. Two hosts on one
 * registrable domain always share their last two labels, so this never reads the same site as two;
 * under a public suffix it does not know, it can read two sites as one, which only refuses.
 */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  const take = labels.length > 2 && MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/**
 * Whether the preview domain shares the app's registrable domain: a page an agent wrote would then
 * be same-site to the app, and could set cookies for the domain the app reads.
 */
export function onAppSite(domain: string, appUrl: string): boolean {
  return registrableDomain(domain) === registrableDomain(new URL(appUrl).hostname);
}

/**
 * Serving a chunk this build does not have.
 *
 * Vite names every file under `/_app/immutable/` after its content, and a pod serves only the
 * build baked into its image. A rolling update deliberately keeps two builds in the load
 * balancer at once, so a page rendered by a new pod can ask an old pod for a chunk that pod has
 * never heard of — a 404 mid-navigation, which SvelteKit reports as a failed dynamic import.
 *
 * A deployment that publishes every build's chunks to one bucket makes sure the chunk the page
 * wants exists somewhere. This is the lookup: adapter-node's static handler answers for the chunks this
 * image has before the hook ever runs, so anything that reaches here is, by construction, from
 * another build. It reaches here only because `reroute` (src/hooks.ts) moves it off `/_app/`,
 * past the 404 SvelteKit would otherwise answer with before calling any hook. We proxy rather than redirect, because a module script that redirects
 * cross-origin needs CORS on the far end, and proxying keeps the whole thing same-origin.
 */

import { type GetSigningCredentials, signGet } from "./sigv4-get";

/** Only ever used for paths under here, which is what makes the pass-through safe. */
const PREFIX = "/_app/immutable/";

/** A chunk is content-addressed, so it can never change under its name. */
const IMMUTABLE = "public, max-age=31536000, immutable";

/** Long enough for a cold object, short enough that a page does not hang on a broken bucket. */
const TIMEOUT_MS = 5_000;

export function isImmutableAsset(pathname: string): boolean {
  return pathname.startsWith(PREFIX);
}

/**
 * Whether `pathname` is safe to append to the bucket URL.
 *
 * `URL` has already resolved `.` and `..` by the time a pathname reaches us, so this is a second
 * line rather than the first — but the cost of being wrong is reading an arbitrary object out of
 * the bucket, so it checks the encoded forms too rather than trusting that normalisation ran.
 */
export function isSafeAssetPath(pathname: string): boolean {
  if (!isImmutableAsset(pathname)) return false;
  if (pathname.includes("..") || pathname.includes("//")) return false;
  if (/%2e|%2f|%5c/i.test(pathname)) return false;
  return !pathname.includes("\\");
}

export interface AssetFallbackOptions {
  /** The bucket's public base, e.g. `https://storage.googleapis.com/acme-assets`. Empty disables. */
  baseUrl: string | undefined;
  /** The request's, so a client that takes brotli is not sent thirteen megabytes of plain JS. */
  acceptEncoding?: string | null;
  /**
   * How to read the bucket. Absent means read it anonymously, which is what a public bucket or a
   * laptop wants; the deployment's is private, so there it is always set.
   */
  credentials?: GetSigningCredentials;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests, so a signature can be pinned. */
  now?: () => Date;
}

/**
 * The compressed sibling to ask for first, if any.
 *
 * The build writes `x.js`, `x.js.br` and `x.js.gz` next to each other and adapter-node picks
 * between them by Accept-Encoding; a bucket does no such negotiation, so we do it here. Bare
 * substring matching is enough: these are our own three values, not a q-weighted ranking.
 */
function preferredEncoding(
  acceptEncoding: string | null | undefined,
): { suffix: string; encoding: string } | null {
  const accepted = acceptEncoding?.toLowerCase() ?? "";
  if (accepted.includes("br")) return { suffix: ".br", encoding: "br" };
  if (accepted.includes("gzip")) return { suffix: ".gz", encoding: "gzip" };
  return null;
}

/**
 * Answer for a chunk from another build, or 404 as we would have anyway.
 *
 * Never throws: a fallback that fails is exactly as bad as the 404 it replaces, and turning a
 * missing chunk into a 500 would take the page down harder than leaving it alone.
 */
export async function serveAssetFromFallback(
  pathname: string,
  { baseUrl, acceptEncoding, credentials, fetchImpl = fetch, now = () => new Date() }:
    AssetFallbackOptions,
): Promise<Response> {
  const missing = () => new Response("Not found", { status: 404 });

  if (!baseUrl || !isSafeAssetPath(pathname)) return missing();
  const base = `${baseUrl.replace(/\/$/, "")}${pathname}`;

  const get = async (url: string): Promise<Response | null> => {
    try {
      const headers = credentials ? await signGet(new URL(url), credentials, now()) : {};
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return res.ok && res.body ? res : null;
    } catch {
      return null;
    }
  };

  // The compressed sibling first, the plain object if the bucket holds no such sibling — a build
  // old enough to predate precompression still answers, one extra round trip on a path that only
  // runs mid-rollout anyway.
  const preferred = preferredEncoding(acceptEncoding);
  const compressed = preferred ? await get(`${base}${preferred.suffix}`) : null;
  const upstream = compressed ?? await get(base);
  if (!upstream) return missing();

  const headers = new Headers({
    "cache-control": IMMUTABLE,
    // The chunk's bytes differ by Accept-Encoding, and something downstream will cache this.
    "vary": "accept-encoding",
  });

  // The sibling's own content type describes the container (`application/gzip` and such), not the
  // chunk, so name the chunk's type from its real extension and let content-encoding say how it
  // is wrapped. A module served as anything but JavaScript is refused by the browser outright.
  if (compressed && preferred) {
    headers.set("content-encoding", preferred.encoding);
    headers.set("content-type", contentTypeFor(pathname));
  } else {
    const type = upstream.headers.get("content-type");
    headers.set("content-type", type ?? contentTypeFor(pathname));
  }

  return new Response(upstream.body, { status: 200, headers });
}

/** What the build actually emits under _app/immutable; anything else is served as bytes. */
function contentTypeFor(pathname: string): string {
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".woff2")) return "font/woff2";
  if (pathname.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

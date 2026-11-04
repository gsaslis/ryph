import type { Reroute } from "@sveltejs/kit";

const IMMUTABLE = "/_app/immutable/";

/**
 * Where a request for a missing build chunk is sent, so the server hook ever gets to see it.
 *
 * SvelteKit answers any unmatched path under `/_app/` with a bare 404 before a single hook runs
 * (`respond.js`, "Ensure that 404'd static assets are not cached") — so a `handle` that means to
 * serve a chunk from another build never sees the request at all. That check tests the path
 * `reroute` returns, not the one the browser asked for, and runs after this. Answering here with
 * any path outside `/_app/` is what lets the request through to `handle`, which serves it from
 * the assets bucket.
 *
 * Only a chunk this image does not have can arrive here: adapter-node's static handler answers
 * for the ones it does before SvelteKit is involved. And the rewrite is invisible to the code that
 * serves it — `event.url` keeps the path the browser asked for, which is what `handle` reads.
 *
 * This file runs in the browser too, where it is harmless: chunks load through `import()`, never
 * through the router, so no navigation ever resolves a path under `/_app/immutable/`.
 */
export const reroute: Reroute = ({ url }) => {
  if (url.pathname.startsWith(IMMUTABLE)) {
    return `/__asset-fallback/${url.pathname.slice(IMMUTABLE.length)}`;
  }
};

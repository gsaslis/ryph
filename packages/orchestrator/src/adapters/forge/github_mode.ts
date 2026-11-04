// How this deployment acts on GitHub — an App, or one person's token — as the control plane
// learns it: from the forge, which is the side holding the credential (`Forge.providers`).
//
// Asked, not configured, and asked LAZILY: a networked control plane boots beside a forge that
// may not be up yet, and a boot that waited on it would tie the two services' start order. The
// answer cannot change while the forge process lives, so once known it is kept, re-read on a
// slow clock in case the forge restarted with another configuration, and served stale when a
// re-read fails — a blip must not flip a user-mode deployment back to App-mode semantics.
//
// So a NETWORKED forge restarted into the other mode is believed in its old one for up to a
// TTL (60 s): the login permission checks ask about, and the sign-in offer, lag it that long
// (the connect routes ask the forge live, never through this). An embedded forge
// (the binary) only changes mode with the host restarting around it, which starts this cache
// over, so there it never lags.

import type { Forge, GithubMode, GithubModeSource } from "../../ports/forge.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";

export type { GithubModeSource };

/** How long one answer is kept before it is re-read. */
const DEFAULT_TTL_MS = 60_000;

export function githubModeSource(
  deps: { forge: Pick<Forge, "providers">; diag: Diagnostics; now?: () => number; ttlMs?: number },
): GithubModeSource {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  let known: { at: number; mode: GithubMode | null } | null = null;
  let inflight: Promise<GithubMode | null> | null = null;

  const refresh = (): Promise<GithubMode | null> => {
    // Single-flight: a burst of permission checks asks the forge once.
    inflight ??= deps.forge.providers()
      .then(({ github }) => {
        known = { at: now(), mode: github };
        return github;
      })
      .catch((err) => {
        if (known === null) throw err;
        deps.diag.warn("forge.github_mode_stale", { err: String(err) });
        // Keep the answer, and wait out another TTL before asking again.
        known = { at: now(), mode: known.mode };
        return known.mode;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  const due = () => known === null || now() - known.at >= ttlMs;

  return {
    current() {
      if (due()) refresh().catch(() => {});
      return known === null ? undefined : known.mode;
    },
    async get() {
      if (!due()) return known!.mode;
      return await refresh();
    },
  };
}

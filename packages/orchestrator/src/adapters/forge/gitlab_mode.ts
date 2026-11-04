// How this deployment acts on GitLab — a bot user, or one person's token — as the control plane
// learns it from the forge (`Forge.providers`), cached exactly as GitHub's mode is
// (adapters/forge/github_mode.ts): asked lazily, kept once known, re-read on a slow clock, and
// served stale when a re-read fails, so a blip never flips a user-mode deployment to bot-mode
// semantics. The sign-in offer and every login lookup read it; the connect routes ask the forge
// live, never through this.

import type { Forge, GitlabMode } from "../../ports/forge.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";

/** The cached GitLab mode — `GithubModeSource`'s twin. */
export interface GitlabModeSource {
  /** The last answer, without waiting: `undefined` while the forge has never answered, null when
   * it runs no GitLab. Starts a re-read in the background when one is due. */
  current(): GitlabMode | null | undefined;
  /** The mode, asked of the forge when not known or due a re-read. Throws only when the forge
   * has never answered at all. */
  get(): Promise<GitlabMode | null>;
}

/** How long one answer is kept before it is re-read. */
const DEFAULT_TTL_MS = 60_000;

export function gitlabModeSource(
  deps: { forge: Pick<Forge, "providers">; diag: Diagnostics; now?: () => number; ttlMs?: number },
): GitlabModeSource {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  let known: { at: number; mode: GitlabMode | null } | null = null;
  let inflight: Promise<GitlabMode | null> | null = null;

  const refresh = (): Promise<GitlabMode | null> => {
    // Single-flight: a burst of lookups asks the forge once.
    inflight ??= deps.forge.providers()
      .then(({ gitlab }) => {
        known = { at: now(), mode: gitlab };
        return gitlab;
      })
      .catch((err) => {
        if (known === null) throw err;
        deps.diag.warn("forge.gitlab_mode_stale", { err: String(err) });
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

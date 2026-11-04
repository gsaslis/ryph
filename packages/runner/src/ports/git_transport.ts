import type { RepoEntry } from "../core/types.ts";

/**
 * Whether the base a checkout starts from is the upstream's as of the read that produced it, or
 * an older copy the origin held because every attempt to refresh it since `since` (an ISO
 * instant) has failed. Only an origin with a cache between the run and the upstream (the forge
 * gateway) can answer `stale`; a plain origin serves what it holds and is always `fresh`.
 */
export type BaseFreshness = { kind: "fresh" } | { kind: "stale"; since: string };

/** One local clone the run operates in — the on-disk home for that repo's local git work.
 * Its `dir` is the `intoDir` that `clone` was given: `<checkout root>/<entry.path>`. */
export interface Checkout {
  dir: string;
  /** How the base came in: read from the upstream, or served from a copy the origin could not
   * refresh. Settled by the clone or adopt that produced the checkout. */
  freshness: BaseFreshness;
}

/**
 * Git's transport seam: the git operations that cross the local↔origin boundary,
 * and thus the only git that is a port.
 * "Transport" is git's own name for this object-moving layer;
 * an alternate backend (e.g. Radicle) slots in behind this interface.
 *
 * Invariants:
 * - Only remote-crossing operations live here (clone or adopt in, push out).
 *   Every local operation — branching, staging, committing, inspecting — is an owned helper, never a port.
 * - Remote access is the sole part of git with external variance (a path, ssh, or https origin),
 *   which is the entire reason it is a port;
 *   behavior is identical whichever origin is used, and callers never branch on which.
 * - One call per repo of the checkout, in both directions: the run holds a list, and each
 *   entry is cloned and shipped on its own. The entry is the argument, so an adapter that
 *   needs to know WHICH repo it is moving objects for (the gateway names the member in its
 *   URL) reads it from the same record the core does.
 */
export interface GitTransport {
  /**
   * Reads one repo *in*: clone `repo.url` into `intoDir` — recording it as `origin` —
   * and check out `repo.ref` as the starting point.
   * Returns the local checkout to operate in, with `freshness` saying whether its base is the
   * upstream's or a copy the origin could not refresh: the run goes on either way, and tells
   * the agent which.
   */
  clone(repo: RepoEntry, intoDir: string): Promise<Checkout>;
  /**
   * Reads one repo *in* over a checkout that is already there: the one an environment image
   * baked at `dir`, warm from its build. Fetches `repo.ref` from `repo.url` — which becomes
   * `origin` — and moves the tree to it in place (helpers/adopt.ts), leaving the checkout as a
   * `clone` would have: `origin` is the run's, and the run's ref is the only ref. Throws on any
   * failure; the caller then clones fresh into the same directory. Answers `freshness` as
   * `clone` does.
   */
  adopt(repo: RepoEntry, dir: string): Promise<Checkout>;
  /**
   * Sends one repo's work *out* as `branch.name` — the one moment a run's work leaves the
   * box. HOW it leaves is the adapter's business: the CLI transport pushes the commits to
   * `origin`; the gateway transport emits a `git bundle` of `branch.baseSha..branch.name` and
   * hands it to the forge gateway's intake for that repo (the run's credential is read-only
   * there — a push has nothing to reach). Either way the returned ref means the work durably
   * left the box under that name. `from` is the source (the local clone), not the target.
   *
   * The branch is an argument rather than read off the entry because a run ships several and
   * each moves: a line's branch is `<repo.branchNamespace>/<line>` at first and `…-<n>` once a
   * patch of it landed and the next generation started on the merged tip, with a new base to
   * bundle from (@ryph/shared/lines). `refs/heads/<name>` is the ref pushed or bundled: the caller
   * makes sure it exists.
   */
  push(
    from: Checkout,
    repo: RepoEntry,
    branch: { name: string; baseSha: string },
  ): Promise<{ remoteRef: string }>;
  /**
   * Reads the repo's base ref (`repo.ref`) *in* again, as it stands at the origin now, and
   * answers its tip — what the next generation of the run's branch starts on after a patch
   * landed. Through the gateway the advertisement refreshes the cache from the upstream, so
   * the tip is the merged one; against a plain origin it is a plain fetch.
   *
   * `ref` reads another branch of the same origin instead — the repo's `targetRef`, which the
   * run merges to catch up. The fetch also moves `origin/<ref>`, so the agent sees what came in.
   *
   * Throws when the origin could serve the branch only from a copy it could not refresh, with a
   * reason written for the agent ("`<ref>` could not be refreshed from upstream: every attempt
   * since <since> has failed, and ryph only holds an older copy"): a tip that may be behind the
   * upstream is no answer to "what is the base now", and a caller that merged it would report
   * the branch as caught up when it is not. Throws too when the origin's copy of the branch
   * kept moving under the fetch ("`<ref>` moved at the origin while it was being read; try
   * again"): the tip the fetch landed on is not the one the origin holds, so it is no answer
   * either.
   */
  fetchBase(from: Checkout, repo: RepoEntry, ref?: string): Promise<{ sha: string }>;
  /**
   * Reads a change request's head *in* and answers which ref it is under: the agent asked to
   * work on an existing pull request (or patch) of this repo, and its head is not something the
   * run was granted — the base ref is. The adapter has the platform tell it which ref carries
   * the head and make it reachable, then fetches it, so the objects are in the clone when the
   * caller moves the run's branch there.
   *
   * `changeRequest` is the forge's own thread ref (a pull request number, a patch id) and is
   * agent input: nothing here interpolates it into a git argument. The answered `headSha` is
   * what the fetch actually landed on — an adapter that fetched something else throws rather
   * than answering a head the clone does not hold.
   *
   * Throws when the change request cannot be served (not one, closed, from a fork, moved
   * mid-fetch), with a reason written for the agent; a transport with no platform behind it
   * throws saying so.
   */
  fetchChangeRequest(
    from: Checkout,
    repo: RepoEntry,
    changeRequest: string,
  ): Promise<{ ref: string; headSha: string; url: string }>;
}

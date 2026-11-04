// A local cache, one entry per connected repo. It is disposable: losing it costs a re-fetch,
// not data. The durable artifact is the patch bundle; this cache never holds anything that
// cannot be rebuilt from upstream.

import type { ForgeProvider, RepoCoords } from "../core/types.ts";

/**
 * A credential for reaching a private upstream, scoped to ONE origin. Lives on the port because
 * both the caller (which resolves a run's credential per fetch) and the adapter (which injects
 * it into the git subprocess) need the shape; neither owns it.
 */
export interface FetchAuth {
  /** The origin the credential is offered to, e.g. "https://github.com" — and no other. */
  origin: string;
  /** The credential itself. How it is presented is `scheme`'s business. */
  token: string;
  /**
   * How the token is framed in the `Authorization` header. "basic" (the default) sends
   * `Basic base64(basicUser + ":" + token)` — GitHub PAT semantics, which a GitHub App
   * installation token also satisfies. "bearer" sends `Bearer <token>`, which is what a
   * service whose door is a shared bearer wants; the Radicle bridge's git door is one, and
   * Basic-framing its token there is simply a 401.
   */
  scheme?: "basic" | "bearer";
  /**
   * The Basic username the token is framed with. Absent: "x-access-token", GitHub's. GitLab
   * takes "oauth2", which it requires for an OAuth token and accepts for a personal access token
   * (any non-empty username does there). Ignored for "bearer".
   */
  basicUser?: string;
  /**
   * Only on a credential that can be renewed — a GitHub user token from a command. Asked once
   * when git says the upstream rejected this credential (a 401): a different one to retry the
   * same command with, or null when there is none and the rejection stands. The answer carries
   * no `refresh` of its own, so one git command is retried at most once.
   */
  refresh?: () => Promise<FetchAuth | null>;
}

/**
 * Resolves the credential for one upstream contact at the moment the cache makes it, so a
 * credential that cannot be obtained is a failed refresh like any other rather than a failure
 * before the cache is asked. Null means "fetch as nobody" (the adapter's deployment-level
 * credential then applies, if it has one). Memoized by whoever builds it, so a request that
 * refreshes twice mints once. Rejects with `UpstreamRefused` when the upstream answered no,
 * and with anything else when it could not be asked.
 *
 * @example
 * const credential: Credential = () => api.fetchAuth(repo, url);
 * await cache.refreshBase({ url }, "main", credential);
 */
export type Credential = () => Promise<FetchAuth | null>;

/** The cache coordinates of a repo fetched from `url`: keyed by its forge id where it has one. */
export function repoCacheCoords(
  url: string,
  repo: { provider: ForgeProvider; forgeId?: string },
): RepoCoords {
  return repo.forgeId === undefined ? { url } : { url, key: `${repo.provider}:${repo.forgeId}` };
}

/** The credential of a fetch made as nobody: a path upstream, or a repo nobody granted us. */
export const anonymous: Credential = () => Promise.resolve(null);

/**
 * What a refusal is about, because the cache acts on the two differently. `missing-ref` is
 * about one branch, deleted or renamed upstream: the entry drops its copy, so the next
 * advertisement no longer lists a tip the upstream does not have. `repo` is about the whole
 * repo for this caller (a credential the forge will not mint, a 401, a 403, a 404): the entry
 * keeps every branch, since an installation can be restored and the branches still exist
 * upstream. `missing-commit` is `ensureCommit`'s alone: the upstream answered and holds no
 * commit by that id (git's "not our ref") — about one object, so the entry is left as it was.
 */
export type RefusalReason = "missing-ref" | "missing-commit" | "repo";

/**
 * The upstream answered, and the answer was no: an installation that will not mint (suspended,
 * removed, missing a permission), or a git transport that got a definitive no (a branch deleted
 * upstream, a repo deleted, gone private, or removed from the grant, a credential rejected).
 * Never served from the cache: this is a decision by the repo's owner, not an outage, and a copy
 * the cache holds is one that owner no longer grants. `reason` says which of the two it was;
 * the message is the refuser's own wording, with the underlying error as `cause`.
 */
export class UpstreamRefused extends Error {
  readonly reason: RefusalReason;
  constructor(reason: RefusalReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UpstreamRefused";
    this.reason = reason;
  }
}

/**
 * Whether a served branch is the upstream's as of the refresh that just ran, or the entry's last
 * good copy because every refresh since `since` (an ISO instant) has failed.
 */
export type Freshness = { kind: "fresh" } | { kind: "stale"; since: string };

/** A base branch THIS call refreshed from the upstream. No freshness field: it can only be fresh. */
export interface CachedRepo {
  /** The bare repo on local disk, ready for `git upload-pack` and `git bundle verify`. */
  dir: string;
  /** The branch (under refs/heads/) the requested base ref was normalized to. */
  localBranch: string;
}

/** A base branch the entry can serve now, and how it came to be served. */
export interface ServedBase extends CachedRepo {
  freshness: Freshness;
  /** The commit `refs/heads/<localBranch>` resolves to as of this answer. A reader that fetched
   * first compares it with what it landed on: the entry is shared, and can move between the two. */
  commit: string;
}

/** The entry inside `RepoCache.withHeld`. */
export interface HeldEntry {
  /** The bare repo on local disk. It may not exist yet: only `hold` creates it. */
  dir: string;
  /**
   * Makes each of `commits` readable from `dir`, fetching every one the entry does not hold in
   * ONE fetch by id where the upstream allows it (the entry created on first sight). Answers
   * the ones the upstream definitively holds nothing by (`absent`), and the ones the entry or
   * the upstream holds as some other object than a commit (`notCommits`).
   *
   * A fetch it started runs to its end even when the hold's signal aborts first, so a repo too
   * big to fetch within one budget is held by the next ask instead of never. Once the signal
   * has aborted it starts no further fetch (another try of the batch, or one id at a time), and
   * a hold asked after that starts none at all.
   *
   * @throws when the upstream cannot be reached, the credential rejects, or the hold's signal
   * aborts (once the fetch in flight is done); `UpstreamRefused` (`repo`) when it answered no about the
   * whole repo.
   */
  hold(commits: readonly string[]): Promise<{ absent: Set<string>; notCommits: Set<string> }>;
}

export interface RepoCache {
  /**
   * Refreshes `ref` from the upstream into the repo's cache entry as a normalized local branch
   * (creating the entry on first sight), and answers where it lives. Fresh or it throws: for
   * reads whose answer must be the upstream's as of now (a tree id to build from, a default
   * branch's head, a change request's head). Clears the branch's stale mark on success.
   *
   * `credential` is the CALLER's, for this one fetch: a live token minted for whoever granted
   * us the repo, which is why it arrives per call rather than at construction (it expires, and
   * it differs per tenant), and resolved only once the fetch is about to happen, so a mint that
   * fails is this call's failure. A cache entry is shared across runs either way, because what
   * a fetch is allowed to see does not depend on which run asked for it.
   *
   * @example
   * const { dir, localBranch } = await cache.refreshBase({ url }, "main", credential);
   * @throws when the upstream cannot be reached, refuses the ref, or the credential rejects.
   */
  refreshBase(coords: RepoCoords, ref: string, credential: Credential): Promise<CachedRepo>;
  /**
   * Makes `ref` servable to a run: refreshes it like `refreshBase`, and when the refresh fails
   * for any reason but `UpstreamRefused` and the entry already resolves the branch, serves that
   * branch marked stale. The mark is `since` on the answer: the first failure after the last
   * success, kept in the entry until a refresh succeeds.
   *
   * @example
   * const served = await cache.serveBase({ url }, "main", credential);
   * if (served.freshness.kind === "stale") warn(served.freshness.since);
   * @throws when the entry never held the branch, when the upstream refused (`UpstreamRefused`),
   * or when the entry was created by this call and its first fetch failed.
   */
  serveBase(coords: RepoCoords, ref: string, credential: Credential): Promise<ServedBase>;
  /**
   * The entry as it currently stands IF it can already serve `ref`, with no upstream contact,
   * carrying the branch's freshness so a reader with no refresh of its own learns whether the
   * last one failed. Bundle intake tries this FIRST, because creating a patch must not depend
   * on the forge being reachable, and for a cache that holds the base it does not.
   *
   * `null` means only "not servable from here, as things stand": never cached, wiped, warmed
   * for some other base, or an entry left half-made by a killed process. The ref is what
   * separates those from a hit: a bare directory is not a base, and a caller that took one
   * for one would skip the fetch and then verify against nothing. A caller that needs the base
   * answers a `null` with `serveBase`; one that only wants a local object source can do
   * without.
   *
   * @example
   * const held = await cache.find({ url }, "main");
   * const dir = held?.dir ?? (await cache.serveBase({ url }, "main", credential)).dir;
   */
  find(coords: RepoCoords, ref: string): Promise<ServedBase | null>;
  /**
   * Makes one COMMIT readable from the entry, fetching it by id when the entry does not hold it
   * yet (creating the entry on first sight), and answers where it lives. No ref is written for
   * it: a commit is not a base, and the entry keeps serving only the branches runs asked for.
   *
   * `fallbackRef` is for an upstream that will not serve the commit by id: a ref that should
   * lead to it (a pull request's `refs/pull/<n>/head`), fetched the same way — objects only,
   * no ref written, the entry's HEAD untouched — when the fetch by id fails.
   *
   * @throws when the upstream cannot be reached or the credential rejects, and
   * `UpstreamRefused` when it answered no: `missing-commit` when it holds no commit by that id
   * (nor, when one was named, under `fallbackRef`), `repo` when the repo is gone or ungranted.
   */
  ensureCommit(
    coords: RepoCoords,
    commit: string,
    credential: Credential,
    opts?: { fallbackRef?: string },
  ): Promise<{ dir: string }>;
  /**
   * Runs `read` against the repo's entry with the entry HELD: under the per-repo serialization
   * every fetch into it takes, so nothing fetches into the entry, or removes it, until `read`
   * settles. For a read that asks several questions and must get one consistent answer.
   *
   * `read` gets the entry's directory and `hold`, which makes commits readable the way
   * `ensureCommit` does. Nothing is pinned: no `git gc` can run on the entry while it is held,
   * since gc only ever runs after a fetch into it, every such fetch waits for the hold, and the
   * hold's own fetches run none. Once the hold ends, what nothing reaches (a squash-merged head,
   * a push since force-pushed away) is the entry's to prune as git always would, so content a
   * person removed upstream does not stay fetchable from here for good. `ensureCommit` must not
   * be called from inside `read`: it waits for the hold to end.
   *
   * `signal` bounds the whole of it, the wait for the entry included: once it aborts, a hold
   * not yet begun never begins, a running git command is killed, and the call rejects with the
   * abort at once, so the entry is never held past the caller's budget.
   *
   * @throws whatever `read` throws; the signal's reason once it aborts.
   */
  withHeld<T>(
    coords: RepoCoords,
    credential: Credential,
    read: (entry: HeldEntry) => Promise<T>,
    opts?: { signal?: AbortSignal },
  ): Promise<T>;
  /**
   * The branch the upstream's HEAD names: its default branch, as the upstream says it NOW.
   * Asked of the git remote itself (`ls-remote --symref`), not of a forge API, so it is exactly
   * as available as the fetch that follows it.
   *
   * @throws when the upstream cannot be reached or names no branch, or the credential rejects;
   * `UpstreamRefused` when it answered no.
   */
  remoteDefaultBranch(coords: RepoCoords, credential: Credential): Promise<string>;
  /**
   * The commit `refs/heads/<branch>` names upstream NOW, or null when the upstream has no such
   * branch. Asked of the git remote itself (`ls-remote`), like `remoteDefaultBranch`, and it
   * writes nothing: the entry neither gains the branch nor fetches a byte.
   *
   * `signal` stops the ask: git is killed, and the answer stops waiting.
   *
   * @throws when the upstream cannot be reached or the credential rejects, or `signal` aborted;
   * `UpstreamRefused` when it answered no about the repo.
   */
  remoteBranchHead(
    coords: RepoCoords,
    branch: string,
    credential: Credential,
    opts?: { signal?: AbortSignal },
  ): Promise<string | null>;
}

// The per-connected-repo cache on local disk: one bare repo per upstream URL, base refs
// fetched in as normalized local branches. DISPOSABLE by doctrine — deleting the root loses
// nothing but a re-fetch; the durable artifact is the patch bundle, never this cache.
//
// Private upstreams are the reason a fetch credential exists here. It is injected as
// `http.<origin>.extraheader` config on the fetch subprocess: the caller's per-fetch token, a
// live one minted for whoever granted us the repo and resolved right before the fetch that
// spends it. git itself scopes the header to URLs under that origin, so the credential is never
// offered to any other host. A call with no credential (a provider that needs none, like a
// local repository) fetches anonymously.
//
// Every upstream contact is bounded: a transfer under a byte per second for `stallSeconds`
// (`http.lowSpeedLimit` / `http.lowSpeedTime`, which git applies while it is still waiting for
// the first byte) fails the fetch. An upstream that hangs rather than refuses then fails into
// `serveBase`'s seam like one that refuses, instead of holding the repo's whole operation chain.
//
// Invariants:
// - the cache serves only what it was asked to hold: each refresh fetches exactly the one
//   requested ref (no mirror, no --prune, no refs/*:refs/*) — a repo's cache entry accretes
//   the branches runs actually used, nothing more; ensureCommit fetches one commit by id and
//   writes no ref at all, and neither does `withHeld`'s hold: nothing is pinned, so a commit
//   nothing reaches is pruned by git's own gc in time, like any other
// - fetches are serialized per repo (in-process): git's own locking makes concurrent fetches
//   safe, but serializing keeps "clone during fetch = consistent slightly-stale snapshot"
//   (measured in the spikes) the only concurrency story to reason about. It is also why a held
//   entry is never pruned under its reader: gc runs only after a fetch into the entry, and the
//   hold's own fetches pass `--no-auto-gc`
// - a failed refresh through `serveBase` serves the held branch, marked stale in the entry's
//   config (`ryph.<branch>.staleSince`, the first failure since the last success), unless the
//   upstream refused; `refreshBase` never serves stale. Pinned by tests/repo_cache_test.ts
// - a branch the upstream says is gone (`UpstreamRefused` with reason `missing-ref`) leaves
//   the entry on either call, mark and all; a refusal about the repo (`repo`) keeps every
//   branch. Pinned by the same tests and by tests/gateway_e2e_test.ts (a deleted target)
// - a failed refresh is logged once, named for its outcome: `cache.served_stale` when the held
//   branch was served, `cache.fetch_failed` when nothing was. Pinned by the same tests

import { mkdir, rm, stat } from "node:fs/promises";
import type { RepoCoords } from "../../core/types.ts";
import { sha256Hex } from "@ryph/sealed";
import { normalizeBaseRef } from "@ryph/shared/refs";
import {
  type CachedRepo,
  type Credential,
  type FetchAuth,
  type Freshness,
  type HeldEntry,
  type RefusalReason,
  type RepoCache,
  type ServedBase,
  UpstreamRefused,
} from "../../ports/repo_cache.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import {
  type Git,
  makeGit,
  makeGitInput,
  objectTypes,
  renewingGit,
} from "../../helpers/git_exec.ts";

export type { FetchAuth };

export interface LocalFsRepoCacheOptions {
  /** Directory the bare repos live under; created on demand. */
  root: string;
  diag: Diagnostics;
  /** The clock a stale mark is stamped with; wall-clock by default. */
  now?: () => Date;
  /** How long an upstream may go without sending a byte before the fetch counts as failed;
   * 30 seconds by default. */
  stallSeconds?: number;
}

export function localFsRepoCache(opts: LocalFsRepoCacheOptions): RepoCache {
  const { root, diag } = opts;
  const now = opts.now ?? (() => new Date());
  const stallSeconds = opts.stallSeconds ?? 30;
  const plainGit = makeGit(diag);
  const anonymousGit = makeGit(diag, fetchEnv(null, stallSeconds));
  /** The executor for one upstream contact: the call's own credential, else none. Resolving the credential is the first step of the contact, so its failure is
   * the contact's failure, and git's answer is classified the way the mint's is: a definitive
   * no is `UpstreamRefused`, anything else an outage. A credential that can be renewed (a
   * GitHub user token) is renewed once on a 401 and the command retried, before anything is
   * classified: a token rotated under us is not the owner's answer. */
  const fetchGitFor = async (credential: Credential, signal?: AbortSignal): Promise<Git> => {
    const auth = await credential();
    const fetchGit = auth
      ? renewingGit(auth, (renewed) => makeGit(diag, fetchEnv(renewed, stallSeconds), signal))
      : signal === undefined
      ? anonymousGit
      : makeGit(diag, fetchEnv(null, stallSeconds), signal);
    return async (cwd, ...args) => {
      try {
        return await fetchGit(cwd, ...args);
      } catch (err) {
        throw refusedOrOutage(err);
      }
    };
  };

  /** `git ls-remote <args>` as one upstream contact, classified like a fetch. Run from the
   * cache root: ls-remote needs no repository, only a directory to stand in. */
  const lsRemote = async (
    credential: Credential,
    signal: AbortSignal | undefined,
    ...args: string[]
  ) => {
    await mkdir(root, { recursive: true });
    signal?.throwIfAborted();
    const fetchGit = await fetchGitFor(credential, signal);
    return await fetchGit(root, "ls-remote", ...args);
  };

  // Per-repo serialization: each entry is the tail of that repo's operation chain.
  const chains = new Map<string, Promise<unknown>>();
  function serialized<T>(key: string, op: () => Promise<T>): Promise<T> {
    const next = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(op);
    chains.set(key, next);
    return next;
  }

  async function repoDir(coords: RepoCoords): Promise<string> {
    return `${root}/${await cacheKey(coords.key ?? coords.url)}`;
  }

  async function initEntry(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await plainGit(dir, "init", "--bare", "--quiet");
    // Off by default, and its absence SILENTLY degrades --filter clones to full ones
    // (measured in the spikes) — set it while the repo is fresh so partial clones are real.
    await plainGit(dir, "config", "uploadpack.allowFilter", "true");
  }

  async function hasCommit(dir: string, commit: string): Promise<boolean> {
    try {
      await plainGit(dir, "cat-file", "-e", `${commit}^{commit}`);
      return true;
    } catch {
      return false;
    }
  }

  /** The commit a branch of the entry resolves to; throws when the entry does not hold it. */
  const branchTip = (dir: string, localBranch: string): Promise<string> =>
    plainGit(dir, "rev-parse", "--verify", "--quiet", `refs/heads/${localBranch}`);

  /** The same, or null for a branch the entry does not hold. */
  const heldTip = (dir: string, localBranch: string): Promise<string | null> =>
    branchTip(dir, localBranch).catch(() => null);

  /** The stale mark: git config in subsection form, so any branch name is a valid key. */
  const markKey = (localBranch: string) => `ryph.${localBranch}.staleSince`;

  async function readMark(dir: string, localBranch: string): Promise<string | null> {
    try {
      return await plainGit(dir, "config", "--get", markKey(localBranch));
    } catch {
      return null;
    }
  }

  async function freshnessOf(dir: string, localBranch: string): Promise<Freshness> {
    const since = await readMark(dir, localBranch);
    return since === null ? { kind: "fresh" } : { kind: "stale", since };
  }

  /** Marks the branch stale unless it already is, and answers when it first became so. */
  async function markStale(dir: string, localBranch: string): Promise<string> {
    const already = await readMark(dir, localBranch);
    if (already !== null) return already;
    const since = now().toISOString();
    await plainGit(dir, "config", markKey(localBranch), since);
    return since;
  }

  async function unmark(dir: string, localBranch: string): Promise<void> {
    if (await readMark(dir, localBranch) !== null) {
      await plainGit(dir, "config", "--unset", markKey(localBranch));
    }
  }

  /**
   * Takes a branch the upstream no longer has out of the entry, mark and all. Kept, the
   * advertisement would go on listing a tip the upstream deleted, `find` would call it fresh,
   * and a run merging its target would merge a dead branch and report itself caught up.
   */
  async function dropBranch(dir: string, localBranch: string): Promise<void> {
    await plainGit(dir, "update-ref", "-d", `refs/heads/${localBranch}`);
    await unmark(dir, localBranch);
  }

  /**
   * One refresh of a branch into the entry, the step both public calls share. Under the
   * caller's serialization. Creation and the first fetch share one try: `git init` writes HEAD,
   * so ANY step after it that fails (the config, the credential, the fetch) leaves behind a
   * directory `find` must not be fooled by. The cleanup is what makes the block all-or-nothing.
   * It logs no failure of its own: the caller knows how the failure ended (served stale, or
   * refused) and warns once for that outcome. Answers the commit the branch now resolves to.
   */
  async function refresh(
    dir: string,
    fresh: boolean,
    coords: RepoCoords,
    ref: string,
    { localBranch, remoteRef }: ReturnType<typeof normalizeBaseRef>,
    credential: Credential,
  ): Promise<string> {
    try {
      if (fresh) await initEntry(dir);
      const fetchGit = await fetchGitFor(credential);
      await fetchGit(
        dir,
        "fetch",
        "--quiet",
        "--no-write-fetch-head",
        "--",
        coords.url,
        `+${remoteRef}:refs/heads/${localBranch}`,
      );
    } catch (err) {
      // Leave the cache as this call found it, with two exceptions. An entry THIS call created
      // is removed: it holds HEAD and nothing else, and the next caller must not skip the
      // fetch on account of it. A branch the upstream says is gone is dropped from an entry
      // that holds it; a refusal about the repo keeps every branch, since an installation can
      // be restored and the branches still exist upstream. A failed refresh never removes a
      // base that still works, which is what `serveBase` goes on to serve.
      if (fresh) await rm(dir, { recursive: true }).catch(() => {});
      else if (err instanceof UpstreamRefused && err.reason === "missing-ref") {
        await dropBranch(dir, localBranch);
      }
      throw err;
    }
    await unmark(dir, localBranch);
    // Point HEAD at the branch so a plain clone of a single-base repo checks out sanely.
    // Shared cache, many runs: last-writer-wins here, and that is fine, since correctness
    // rides the runner's explicit checkout of WorkItem.repo.ref, never HEAD.
    await plainGit(dir, "symbolic-ref", "HEAD", `refs/heads/${localBranch}`);
    const commit = await branchTip(dir, localBranch);
    diag.debug("cache.base_ready", {
      url: redactUrl(coords.url),
      ref,
      branch: localBranch,
      commit,
    });
    return commit;
  }

  /**
   * Makes one commit readable from the entry: `ensureCommit`'s step, under the caller's
   * serialization. Fetched by id when the entry does not hold it (or by `fallbackRef`, when one
   * is named and the id is refused), creating the entry on first sight.
   */
  async function fetchCommit(
    dir: string,
    coords: RepoCoords,
    commit: string,
    credential: Credential,
    fallbackRef: string | undefined,
  ): Promise<void> {
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) {
      throw new Error(`${JSON.stringify(commit)} is not a commit id`);
    }
    const fresh = !(await isRepo(dir));
    // Objects are immutable: a commit the entry already holds is the answer, with no
    // upstream contact at all.
    if (!fresh && await hasCommit(dir, commit)) return;
    // By id or by ref, with no destination: the objects land, no ref is written (HEAD
    // included), and the entry goes on advertising only the branches runs asked for.
    // Protocol v2 upload-pack serves any object it holds (measured against git 2.52 and
    // GitHub), so no tip has to name it.
    const fetchObjects = async (fetchGit: Git, what: string) =>
      await fetchGit(dir, "fetch", "--quiet", "--no-write-fetch-head", "--", coords.url, what);
    try {
      if (fresh) await initEntry(dir);
      const fetchGit = await fetchGitFor(credential);
      try {
        await fetchObjects(fetchGit, commit);
      } catch (byId) {
        if (fallbackRef === undefined) throw missingCommitOr(byId);
        const idErr = missingCommitOr(byId);
        try {
          await fetchObjects(fetchGit, fallbackRef);
        } catch (byRef) {
          // Both asked and both answered no: the upstream does not have it. Otherwise the
          // failure that was NOT an answer is the one to report, so a caller retries it.
          const definitive = (e: unknown) =>
            e instanceof UpstreamRefused &&
            (e.reason === "missing-commit" || e.reason === "missing-ref");
          if (definitive(idErr) && definitive(byRef)) {
            throw new UpstreamRefused(
              "missing-commit",
              `${commit} is not in ${redactUrl(coords.url)}, nor under ${fallbackRef}`,
              { cause: byRef },
            );
          }
          throw definitive(idErr) ? byRef : idErr;
        }
        // The ref was fetched and the commit may still not be under it (pushed over
        // since): judged by the check below, unless the fetch by id failed for a reason
        // that was not an answer — then that is the failure to report.
        if (!(idErr instanceof UpstreamRefused) && !(await hasCommit(dir, commit))) {
          throw idErr;
        }
      }
    } catch (err) {
      // As in `refresh`: only an entry THIS call created is removed.
      if (fresh) await rm(dir, { recursive: true }).catch(() => {});
      diag.warn("cache.commit_fetch_failed", {
        url: redactUrl(coords.url),
        commit,
        err: String(err),
      });
      throw err;
    }
    if (!(await hasCommit(dir, commit))) {
      // The upstream sent what it holds under that id (or that ref), and it is not this
      // commit: an answer.
      throw new UpstreamRefused(
        "missing-commit",
        `${commit} is not a commit in ${redactUrl(coords.url)}`,
      );
    }
  }

  /**
   * `HeldEntry.hold`, under the caller's serialization: every commit of `commits` the entry does
   * not hold, fetched in one fetch by id. One the upstream does not have fails the whole fetch,
   * naming it (`not our ref <id>`): it is set aside as absent and the rest asked again, and when
   * the refusal names nothing it can be matched to, each is asked alone. The fetches run no
   * `gc --auto`, so nothing the entry holds is pruned while it is held (see `withHeld`).
   *
   * A fetch does not stop with `signal`: git cannot resume a fetch it was killed in, so a cold
   * entry of a repo too big to clone within one read's budget would start over on every ask and
   * never be answered. The one in flight runs to its end (the stall bound still ends one that
   * hangs) with the entry held, while the read that ran out has already answered; the next ask
   * finds what it fetched. A hold asked once `signal` has aborted throws at once, and one asked
   * before starts no further fetch (another try of the batch, or one id at a time) after it
   * aborts: the hold then throws its reason. Only a fetch that FAILED, or an abort before
   * anything landed, removes an entry this call created.
   */
  async function holdCommits(
    dir: string,
    coords: RepoCoords,
    commits: readonly string[],
    credential: Credential,
    signal: AbortSignal | undefined,
  ): Promise<{ absent: Set<string>; notCommits: Set<string> }> {
    signal?.throwIfAborted();
    for (const commit of commits) {
      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) {
        throw new Error(`${JSON.stringify(commit)} is not a commit id`);
      }
    }
    const absent = new Set<string>();
    const notCommits = new Set<string>();
    const gitInput = makeGitInput(diag, signal);
    const fresh = !(await isRepo(dir));
    const before = fresh
      ? new Map<string, string>()
      : await objectTypes(gitInput, dir, [...new Set(commits)]);
    let wanted: string[] = [];
    for (const commit of new Set(commits)) {
      const type = before.get(commit) ?? "missing";
      if (type === "missing") wanted.push(commit);
      else if (type !== "commit") notCommits.add(commit);
    }
    if (wanted.length === 0) return { absent, notCommits };
    let landed = false;
    try {
      if (fresh) await initEntry(dir);
      const fetchGit = await fetchGitFor(credential);
      const fetchIds = (ids: readonly string[]) =>
        fetchGit(
          dir,
          "fetch",
          "--quiet",
          "--no-auto-gc",
          "--no-write-fetch-head",
          "--",
          coords.url,
          ...ids,
        );
      let alone = false;
      let tries = 0;
      while (wanted.length > 0) {
        // The budget ran out: the fetch in flight finished, and nothing more starts with the
        // entry held.
        if (tries++ > 0 && signal?.aborted) break;
        const batch = alone ? wanted.slice(0, 1) : wanted;
        try {
          await fetchIds(batch);
          landed = true;
          wanted = wanted.filter((id) => !batch.includes(id));
        } catch (err) {
          const refusal = missingCommitOr(err);
          if (!(refusal instanceof UpstreamRefused) || refusal.reason !== "missing-commit") {
            throw refusal;
          }
          const named = NAMED_COMMIT.exec(refusal.message)?.[1];
          const gone = batch.length === 1 ? batch[0] : batch.find((id) => id === named);
          if (gone === undefined) {
            alone = true;
            continue;
          }
          absent.add(gone);
          wanted = wanted.filter((id) => id !== gone);
        }
      }
    } catch (err) {
      // As in `refresh`: only an entry THIS call created is removed.
      if (fresh) await rm(dir, { recursive: true }).catch(() => {});
      diag.warn("cache.commit_fetch_failed", {
        url: redactUrl(coords.url),
        commits: commits.length,
        err: String(err),
      });
      throw err;
    }
    if (fresh && !landed) {
      // Nothing came of it: an entry that holds nothing is not one to keep.
      await rm(dir, { recursive: true }).catch(() => {});
      signal?.throwIfAborted();
      return { absent, notCommits };
    }
    // Ids never asked for are not known absent: the read that ran out has no answer to take.
    signal?.throwIfAborted();
    // The upstream sent what it holds under each id; one that is not a commit is an answer.
    const after = await objectTypes(gitInput, dir, commits.filter((c) => !absent.has(c)));
    for (const commit of new Set(commits)) {
      if (absent.has(commit)) continue;
      const type = after.get(commit) ?? "missing";
      if (type === "missing") absent.add(commit);
      else if (type !== "commit") notCommits.add(commit);
    }
    return { absent, notCommits };
  }

  return {
    refreshBase(coords: RepoCoords, ref: string, credential: Credential): Promise<CachedRepo> {
      const normalized = normalizeBaseRef(ref);
      return serialized(coords.key ?? coords.url, async () => {
        const dir = await repoDir(coords);
        const fresh = !(await isRepo(dir));
        try {
          await refresh(dir, fresh, coords, ref, normalized, credential);
        } catch (err) {
          diag.warn("cache.fetch_failed", { url: redactUrl(coords.url), ref, err: String(err) });
          throw err;
        }
        return { dir, localBranch: normalized.localBranch };
      });
    },

    serveBase(coords: RepoCoords, ref: string, credential: Credential): Promise<ServedBase> {
      const normalized = normalizeBaseRef(ref);
      const { localBranch } = normalized;
      return serialized(coords.key ?? coords.url, async () => {
        const dir = await repoDir(coords);
        const fresh = !(await isRepo(dir));
        try {
          const commit = await refresh(dir, fresh, coords, ref, normalized, credential);
          return { dir, localBranch, commit, freshness: { kind: "fresh" } };
        } catch (err) {
          // A fresh entry has nothing to serve, and a refusal is the owner's answer, not an
          // outage. Anything else is served from the copy the entry holds, if it holds one.
          // One warn either way, named for how it ended, so a handled outage never reads like
          // an unhandled failure.
          const failure = { url: redactUrl(coords.url), ref, err: String(err) };
          const held = fresh || err instanceof UpstreamRefused
            ? null
            : await heldTip(dir, localBranch);
          if (held === null) {
            diag.warn("cache.fetch_failed", failure);
            throw err;
          }
          const since = await markStale(dir, localBranch);
          diag.warn("cache.served_stale", { ...failure, branch: localBranch, since });
          return { dir, localBranch, commit: held, freshness: { kind: "stale", since } };
        }
      });
    },

    ensureCommit(
      coords: RepoCoords,
      commit: string,
      credential: Credential,
      opts: { fallbackRef?: string } = {},
    ) {
      const fallbackRef = opts.fallbackRef;
      if (fallbackRef !== undefined && !/^refs\/[^\s:^~?*[\\]+$/.test(fallbackRef)) {
        return Promise.reject(new Error(`${JSON.stringify(fallbackRef)} is not a ref to fetch`));
      }
      return serialized(coords.key ?? coords.url, async () => {
        const dir = await repoDir(coords);
        await fetchCommit(dir, coords, commit, credential, fallbackRef);
        return { dir };
      });
    },

    withHeld<T>(
      coords: RepoCoords,
      credential: Credential,
      read: (entry: HeldEntry) => Promise<T>,
      opts: { signal?: AbortSignal } = {},
    ): Promise<T> {
      const { signal } = opts;
      const held = serialized(coords.key ?? coords.url, async () => {
        // A hold whose budget ran out while it waited for the entry never takes it.
        signal?.throwIfAborted();
        const dir = await repoDir(coords);
        const hold = (commits: readonly string[]) =>
          holdCommits(dir, coords, commits, credential, signal);
        return await read({ dir, hold });
      });
      if (signal === undefined) return held;
      return Promise.race([held, aborted(signal)]);
    },

    async remoteDefaultBranch(coords: RepoCoords, credential: Credential): Promise<string> {
      const out = await lsRemote(credential, undefined, "--symref", "--", coords.url, "HEAD");
      // `ref: refs/heads/main<TAB>HEAD` — the one line that names the branch.
      const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out);
      if (match === null) {
        throw new Error(`${redactUrl(coords.url)} names no default branch`);
      }
      // Held to the cache's own ref rules before anyone fetches by it.
      return normalizeBaseRef(match[1]).localBranch;
    },

    async remoteBranchHead(
      coords: RepoCoords,
      branch: string,
      credential: Credential,
      opts: { signal?: AbortSignal } = {},
    ): Promise<string | null> {
      const ref = `refs/heads/${branch}`;
      const { signal } = opts;
      // A pattern matches any ref ENDING in it (`refs/heads/x/refs/heads/<branch>` too), so the
      // answer is the one line naming exactly this ref.
      const asking = lsRemote(credential, signal, "--", coords.url, ref);
      // The signal kills git, but a transport helper it started can hold the pipes open until
      // its own stall timeout: the answer stops waiting with the signal regardless.
      asking.catch(() => {});
      const out = signal === undefined
        ? await asking
        : await Promise.race([asking, aborted(signal)]);
      for (const line of out.split("\n")) {
        const [sha, name] = line.split("\t");
        if (name === ref && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return sha;
      }
      return null;
    },

    async find(coords: RepoCoords, ref: string): Promise<ServedBase | null> {
      const dir = await repoDir(coords);
      if (!(await isRepo(dir))) return null;
      // A directory is not a base. The entry can exist and still hold nothing for THIS ref:
      // debris no cleanup could reach (a process killed mid-creation, an older build), or an
      // entry warmed for a different base, since the cache only ever fetches the ref it was
      // asked for. Resolving the branch is what separates a hit from a shape.
      let localBranch: string;
      try {
        localBranch = normalizeBaseRef(ref).localBranch;
      } catch {
        return null;
      }
      // The mark before the tip, because `refresh` writes them the other way round (the branch
      // moves, then the mark goes) and this read is not serialized against it: a mark read as
      // clear was cleared after the branch moved, so the tip read next is at least the
      // refreshed one, and a fetch that landed on the old tip can never be answered fresh at
      // the old tip. The other order could.
      const freshness = await freshnessOf(dir, localBranch);
      const commit = await heldTip(dir, localBranch);
      if (commit === null) return null;
      return { dir, localBranch, commit, freshness };
    },
  };
}

/**
 * git's definitive answers, as it words them, each with what it is about. The ref is gone
 * (deleted or renamed upstream); or the repository is not there for this caller: a 404, which
 * GitHub also spells `remote: Repository not found`, the credential rejected (a 401, with or
 * without one presented), or the status says so outright. Any other failure, a 5xx or a 429
 * included, is an outage like a host that cannot be reached at all.
 */
const DEFINITIVE_ANSWERS: ReadonlyArray<[RefusalReason, RegExp]> = [
  ["missing-ref", /couldn't find remote ref/],
  [
    "repo",
    new RegExp([
      "repository '[^']*' not found",
      "Repository not found",
      "Authentication failed",
      "could not read Username",
      "The requested URL returned error: 40[134]\\b",
    ].join("|")),
  ],
];

/**
 * How git words "I have no such object" to a fetch BY ID: upload-pack's `not our ref` (protocol
 * v2, and v0 for an id it does not hold), v0's refusal of an id no tip advertises, and the
 * client's own `couldn't find remote ref <id>` for an id it cannot take as one (a 64-digit id
 * asked of a SHA-1 repository): no ref is named that, and no object either. Read for
 * `ensureCommit` and holds only — a branch refresh never wants an id, and its "gone" is
 * `missing-ref`. `NAMED_COMMIT` reads the id each names: what a hold sets aside.
 */
const NO_SUCH_COMMIT =
  /not our ref|unadvertised object|couldn't find remote ref [0-9a-f]{40}(?:[0-9a-f]{24})?\b/;
const NAMED_COMMIT =
  /(?:not our ref|unadvertised object|couldn't find remote ref) ([0-9a-f]{40}(?:[0-9a-f]{24})?)\b/;

/** A fetch-by-id failure, with the upstream's "no such commit" made a refusal: a `missing-ref`
 * refusal that names an id included, since asked by id nothing else was asked for. Anything
 * else already classified, and every outage, passes through unchanged. */
function missingCommitOr(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  if (err instanceof UpstreamRefused && err.reason !== "missing-ref") return err;
  if (!NO_SUCH_COMMIT.test(err.message)) return err;
  return new UpstreamRefused("missing-commit", err.message, { cause: err });
}

/** Whether git said no or could not ask: the fetch-side twin of the mint's classification. */
function refusedOrOutage(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const answer = DEFINITIVE_ANSWERS.find(([, said]) => said.test(err.message));
  if (answer === undefined) return err;
  return new UpstreamRefused(answer[0], err.message, { cause: err });
}

/** The fetch subprocess's config, at command-line precedence: the stall bound always, and
 * the credential seam when there is a credential. Never URL munging: a credentialed URL
 * would land in the cache repo's config on disk. */
function fetchEnv(auth: FetchAuth | null, stallSeconds: number): Record<string, string> {
  const entries: Array<[string, string]> = [
    ["http.lowSpeedLimit", "1"],
    ["http.lowSpeedTime", String(stallSeconds)],
  ];
  if (auth !== null) {
    const origin = auth.origin.replace(/\/+$/, "");
    entries.push([`http.${origin}/.extraheader`, `Authorization: ${authorizationValue(auth)}`]);
  }
  // The C locale, because every failure of these fetches is CLASSIFIED by git's wording
  // (`DEFINITIVE_ANSWERS`, `NO_SUCH_COMMIT`): a translated "couldn't find remote ref" would turn
  // the upstream's answer into an outage.
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(entries.length),
    LC_ALL: "C",
    LANG: "C",
  };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** The header value one credential is presented with — the only place the framings live. */
export function authorizationValue(auth: FetchAuth): string {
  return auth.scheme === "bearer"
    ? `Bearer ${auth.token}`
    : `Basic ${btoa(`${auth.basicUser ?? "x-access-token"}:${auth.token}`)}`;
}

/** One directory per upstream URL: a short slug for humans, a hash for uniqueness. */
async function cacheKey(url: string): Promise<string> {
  const hash = (await sha256Hex(url)).slice(0, 16);
  const slug = url.replace(/\.git$/, "").split("/").filter(Boolean).slice(-2).join("-")
    .toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "repo";
  return `${slug}-${hash}`;
}

/** Rejects with the signal's reason once it aborts (at once, if it already has). */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function isRepo(dir: string): Promise<boolean> {
  try {
    return (await stat(`${dir}/HEAD`)).isFile();
  } catch {
    return false;
  }
}

/** URLs in logs: strip any user:pass@ (they should never carry one — belt and braces). */
function redactUrl(url: string): string {
  return url.replace(/(\w+:\/\/)[^/\s]*@/g, "$1***@");
}

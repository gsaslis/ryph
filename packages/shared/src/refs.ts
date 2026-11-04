// Base-ref normalization and the ref-name rule, pure. A base ref as a person (or a forge webhook)
// names it — "main", "refs/heads/main", "refs/pull/42/head" — becomes the single local branch
// the forge's per-connected-repo cache serves. `git clone` does not fetch `refs/pull/*`, so every
// base, whatever its upstream name, must live under `refs/heads/*` in the cache; the WorkItem's
// `repo.ref` names the normalized branch and the runner never learns the difference.
//
// One copy for both sides of that contract: the orchestrator computes the branch when it composes
// a WorkItem, the forge serves it. They used to carry a copy each, kept "in lockstep" by a test —
// a divergence means the runner checks out a branch the cache never created.
//
// Invariants:
// - deterministic and total over accepted input; anything refused throws with the reason, so a
//   bad ref dies at the first boundary it crosses
// - only commit-pointing refs are accepted: `refs/tags/*` is refused rather than normalized,
//   because an annotated tag object written under `refs/heads/*` is not a branch

export interface NormalizedRef {
  /** The ref to fetch from upstream, fully qualified. */
  remoteRef: string;
  /** The branch name the cache serves it as (under `refs/heads/`). */
  localBranch: string;
}

/**
 * Where each forge keeps its change requests' heads, under `refs/`: GitHub's pull requests and
 * GitLab's merge requests. The cache serves `refs/<prefix><n>/head` as the branch `<prefix><n>/head`,
 * so a branch named with one of these prefixes is refused and a bare one is read as that head.
 */
export const CHANGE_REQUEST_HEAD_PREFIXES = ["pull/", "merge-requests/"] as const;

/** Whether a bare name sits where change request heads are served (`pull/…`, `merge-requests/…`). */
export function isChangeRequestHeadName(name: string): boolean {
  return CHANGE_REQUEST_HEAD_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The fully qualified ref a change request's head is fetched through in the BASE repository —
 * `refs/pull/<n>/head` for a GitHub pull request ("12"), `refs/merge-requests/<iid>/head` for a
 * GitLab merge request ("mr-7") — or null where the forge has no such ref (Radicle, local) or the
 * thread ref is not a change request's spelling on it.
 */
export function changeRequestHeadRef(provider: string, ref: string): string | null {
  if (provider === "github") return /^[1-9]\d{0,19}$/.test(ref) ? `refs/pull/${ref}/head` : null;
  if (provider === "gitlab") {
    const iid = /^mr-([1-9]\d{0,19})$/.exec(ref)?.[1];
    return iid === undefined ? null : `refs/merge-requests/${iid}/head`;
  }
  return null;
}

export function normalizeBaseRef(ref: string): NormalizedRef {
  if (ref.startsWith("refs/heads/")) {
    const branch = ref.slice("refs/heads/".length);
    if (branch === "") throw new Error(`"${ref}" names no branch`);
    // `pull/…` and `merge-requests/…` are where change request heads are served (below): a
    // branch of that name would be the same local branch, and a run on one would check out
    // whichever the cache fetched last.
    if (branch.startsWith("pull/")) {
      throw new Error(`a branch named "${branch}" collides with pull request heads`);
    }
    if (branch.startsWith("merge-requests/")) {
      throw new Error(`a branch named "${branch}" collides with merge request heads`);
    }
    return { remoteRef: ref, localBranch: branch };
  }
  if (ref.startsWith("refs/tags/")) {
    throw new Error(`tag refs are not supported as a base ("${ref}") — name a branch or a PR head`);
  }
  if (ref.startsWith("refs/")) {
    // e.g. refs/pull/42/head → served as branch "pull/42/head", and
    // refs/merge-requests/7/head → "merge-requests/7/head".
    return { remoteRef: ref, localBranch: ref.slice("refs/".length) };
  }
  // `pull/…` and `merge-requests/…` bare are the local spellings of a change request's head,
  // read back as that: never a branch of the name (refused above), so the two can never be one
  // cache branch.
  if (isChangeRequestHeadName(ref)) return { remoteRef: `refs/${ref}`, localBranch: ref };
  // A bare name is taken to be a branch. If it is actually a tag, the upstream fetch of
  // refs/heads/<name> fails loudly at clone time — honest, and better than guessing.
  return { remoteRef: `refs/heads/${ref}`, localBranch: ref };
}

/** Whether `ref` names a branch of the repository itself — a bare name or `refs/heads/<name>`
 * that normalizes — rather than anything else the forge serves under `refs/` (a pull request's
 * head, which is whoever opened it's code). */
export function isBranchRef(ref: string): boolean {
  try {
    return normalizeBaseRef(ref).remoteRef.startsWith("refs/heads/");
  } catch {
    return false;
  }
}

/**
 * The characters and patterns git always refuses in a ref name: whitespace, `~^:?*[\`, control
 * characters and DEL, `..` and `@{`. Not a full check-ref-format — the pragmatic subset that makes
 * the common invalid names die at ingest. For a form that judges a ref as it is typed.
 */
// oxlint-disable-next-line no-control-regex -- control characters and DEL are refused, as git does
export const REF_REFUSED = /[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{/;

/** The longest ref name accepted. Far past anything git or a forge takes; a bound, not a rule. */
export const MAX_REF_NAME = 10_000;

/**
 * Whether `name` is a ref name git and every hop after it would carry: non-empty, not
 * option-shaped (it rides an argv), within `MAX_REF_NAME`, free of `REF_REFUSED`, and not ending
 * in `/` or `.lock`. Not trimmed: a name is judged exactly as it will be stored and used.
 */
export function isGitRefName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_REF_NAME && !name.startsWith("-") &&
    !REF_REFUSED.test(name) &&
    !name.endsWith("/") &&
    !name.endsWith(".lock");
}

/**
 * A branch name a forge reported, as the bare name a checkout can stand on and a push can name —
 * or null for one the ref contract refuses, one spelled as a ref (`refs/…`, which qualifying again
 * would turn into a branch of that name), `HEAD` (whatever is checked out, never a branch), or one
 * no checkout can be anchored on (`pull/…`, `merge-requests/…`). One rule for the orchestrator's
 * early answer to a fork pull request's commenter and the forge's push-time verdict.
 */
export function checkoutBranchOf(name: string): string | null {
  if (!isGitRefName(name) || /^refs\//i.test(name) || name.toLowerCase() === "head") return null;
  try {
    return normalizeBaseRef(`refs/heads/${name}`).localBranch;
  } catch {
    return null;
  }
}

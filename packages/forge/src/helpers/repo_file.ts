// Reading ONE file out of a repo's cache entry, with `git cat-file` against the bare repo that
// `upload-pack` serves the clone from. The same objects, the same disk, no second dependency.
//
// This exists because the control plane must know what a repo declares BEFORE the run's
// container starts — and the launch path is the one path that must not acquire an availability
// dependency the clone does not already have. A forge API call would be exactly that: reachable
// on a different schedule, rate-limited on a different budget, down at different times. Reading
// the cache instead means the services read and the clone succeed and fail together, and when
// the upstream is away both are served from the copy the cache holds.
//
// Invariants:
// - the path is a FIXED string at every call site (helpers/repo_file.ts is not a file-read API):
//   nothing a caller supplies reaches the revision argument except the ref, which is already
//   normalized and validated at ingest
// - bounded before it is read: `-s` asks the size first, so an enormous blob is refused rather
//   than decoded — this content crosses into the control plane's own process, which is the first
//   time repo-authored bytes do
// - every read names ONE immutable commit, resolved once by `resolveBranch`. The branch is
//   mutable and the cache's fetch lock is released by the time we read: a fetch landing between
//   the size check and the content read would otherwise swap in a blob the check never saw, and
//   the bound above would be a bound on some other file
// - the content is the blob's bytes, never trimmed: the caller parses it as YAML, where leading
//   lines and trailing newlines are part of the document
// - "the tree has no such file" is a VALUE, never a throw. It is the overwhelmingly common
//   answer and the caller's normal path; only a broken cache entry is exceptional

import type { CappedGit, Git } from "./git_exec.ts";

export type RepoFileRead =
  | { kind: "file"; text: string }
  | { kind: "absent" }
  /** Present, but larger than the caller's ceiling. Refused rather than truncated: half a
   * YAML document is not a smaller YAML document. */
  | { kind: "too-large"; bytes: number };

export interface ReadRepoFileOpts {
  /** The bare cache entry, as `RepoCache.find`/`serveBase` located it. */
  dir: string;
  /** The commit to read from, as `resolveBranch` answered it. Never a ref name. */
  commit: string;
  /** A fixed path inside the tree, e.g. `.ryph/services.yml`. Never caller input. */
  path: string;
  maxBytes: number;
  /**
   * An UNTRIMMED executor (`makeGitRaw`). The content goes on as committed: trimmed, a file loses
   * its leading lines and the trailing newlines a `|+` block scalar keeps, and the control plane
   * parses a file nobody wrote.
   */
  git: Git;
}

/**
 * Git's word for "this tree has no such path". Deliberately NOT matching its word for an
 * unresolvable ref ("invalid object name"): the branch is verified first, and folding a missing
 * ref into "the repo declares nothing" would turn a broken cache entry into a silently
 * service-free run — the exact failure this feature exists to prevent.
 */
const NO_SUCH_PATH = /does not exist|exists on disk, but not in/i;

/**
 * The commit `localBranch` names in the entry right now — the one every read of a request uses.
 *
 * Resolved on its own, first, so "this entry has never held that ref" is distinguishable from
 * "that ref has no such file": the first throws (a cache miss to go fix, or a broken repo — the
 * caller's cue to `serveBase` and ask again, or to report that it could not ask at all), the
 * second is `readRepoFile`'s normal answer.
 */
export async function resolveBranch(dir: string, localBranch: string, git: Git): Promise<string> {
  return await git(
    dir,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `refs/heads/${localBranch}^{commit}`,
  );
}

/**
 * The file at `path` in `commit`, or the reason there is none. Throws only when the entry
 * cannot answer at all.
 */
export async function readRepoFile(opts: ReadRepoFileOpts): Promise<RepoFileRead> {
  const { dir, git } = opts;
  // A commit id, not the branch: type, size and content below all read the same blob however
  // the branch moves meanwhile. The object cannot vanish either — a fetch only adds objects.
  const rev = `${opts.commit}:${opts.path}`;

  // `git` is raw (see ReadRepoFileOpts), so the one-line answers are trimmed here, by hand.
  let type: string;
  try {
    type = (await git(dir, "cat-file", "-t", "--", rev)).trim();
  } catch (err) {
    if (NO_SUCH_PATH.test(String(err))) return { kind: "absent" };
    throw err;
  }
  // A directory where a file was expected is "no such file", not an error:
  // `.ryph/services.yml/` is a tree the caller has no use for, and refusing loudly would be
  // refusing the repo's typo in the control plane rather than where the author can see it.
  if (type !== "blob") return { kind: "absent" };

  const bytes = Number((await git(dir, "cat-file", "-s", "--", rev)).trim());
  if (!Number.isFinite(bytes)) throw new Error(`git could not size ${opts.path}`);
  if (bytes > opts.maxBytes) return { kind: "too-large", bytes };

  // As committed, never trimmed: this text is parsed, and in YAML the whitespace is data.
  return { kind: "file", text: await git(dir, "cat-file", "-p", "--", rev) };
}

/**
 * The object id of the TREE at `path` in `commit`, or null when the commit has no directory
 * there. An id and never content: what a caller learns is "the same as before, or not", which
 * is all an environment's cache key needs — so the one-fixed-path rule above costs nothing here.
 * A blob where a directory was expected is null, as a directory is for `readRepoFile`. Throws
 * only when the entry cannot answer at all.
 */
export async function readTreeId(
  opts: { dir: string; commit: string; path: string; git: Git },
): Promise<string | null> {
  const { dir, git } = opts;
  const rev = `${opts.commit}:${opts.path}`;
  let type: string;
  try {
    type = (await git(dir, "cat-file", "-t", "--", rev)).trim();
  } catch (err) {
    if (NO_SUCH_PATH.test(String(err))) return null;
    throw err;
  }
  if (type !== "tree") return null;
  return (await git(dir, "rev-parse", "--verify", "--end-of-options", rev)).trim();
}

/** Bounds the listing of one directory: far past any real `.ryph/`. */
const MAX_TREE_LISTING_BYTES = 4 * 1024 * 1024;

/**
 * `readTreeId`, for the tree `path` would be without its direct entries named in `omit`: the id
 * git would give that smaller tree, computed here from `ls-tree`'s names and ids and never
 * written to the entry. The tree's own id when it holds none of them, so a directory with
 * nothing to leave out answers what `readTreeId` does. Null when the commit has no directory
 * there, even if every entry in it is left out (that is the empty tree's id). An id and never
 * content, like `readTreeId`.
 *
 * The listing is read as bytes, never decoded: a name that is not UTF-8 is hashed exactly as
 * git stores it.
 */
export async function readTreeIdWithout(
  opts: {
    dir: string;
    commit: string;
    path: string;
    omit: ReadonlySet<string>;
    git: Git;
    capped: CappedGit;
  },
): Promise<string | null> {
  const tree = await readTreeId(opts);
  if (tree === null) return null;
  // `-z`: one `<mode> <type> <id>\t<name>` per entry, NUL-ended, names verbatim.
  const { out, truncated } = await opts.capped(
    opts.dir,
    MAX_TREE_LISTING_BYTES,
    "ls-tree",
    "-z",
    "--end-of-options",
    tree,
  );
  if (truncated) {
    throw new Error(`the listing of ${opts.path} is over ${MAX_TREE_LISTING_BYTES} bytes`);
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const omitted = [...opts.omit].map((name) => encoder.encode(name));
  const same = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);
  const entries: Array<{ mode: string; id: string; name: Uint8Array }> = [];
  for (let at = 0; at < out.length;) {
    const end = out.indexOf(0, at);
    const entry = out.subarray(at, end === -1 ? out.length : end);
    at = end === -1 ? out.length : end + 1;
    const tab = entry.indexOf(0x09);
    // The header is ASCII: mode, type and id.
    const [mode, , id] = decoder.decode(entry.subarray(0, tab)).split(" ");
    entries.push({ mode, id, name: entry.subarray(tab + 1) });
  }
  const kept = entries.filter((entry) => !omitted.some((name) => same(name, entry.name)));
  if (kept.length === entries.length) return tree;
  // A tree object: `<mode> <name>\0<raw id>` per entry, in git's order, which `ls-tree` already
  // listed them in; the mode without `ls-tree`'s leading zero (`040000` is written `40000`).
  const parts = kept.flatMap((entry) => [
    encoder.encode(`${entry.mode.replace(/^0+/, "")} `),
    entry.name,
    Uint8Array.of(0),
    Uint8Array.from(entry.id.match(/../g)!, (byte) => parseInt(byte, 16)),
  ]);
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const header = encoder.encode(`tree ${size}\0`);
  const object = new Uint8Array(header.length + size);
  let at = 0;
  for (const part of [header, ...parts]) {
    object.set(part, at);
    at += part.length;
  }
  const digest = await crypto.subtle.digest(tree.length === 64 ? "SHA-256" : "SHA-1", object);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether `path` in `commit` is a FILE — `.ryph/Dockerfile`, which decides whether a repo's
 * environment has a machine of its own or runs on the universal image. A yes or a no and never
 * content, like `readTreeId`; a directory there is a no. Throws only when the entry cannot
 * answer at all.
 */
export async function hasBlob(
  opts: { dir: string; commit: string; path: string; git: Git },
): Promise<boolean> {
  const { dir, git } = opts;
  try {
    return (await git(dir, "cat-file", "-t", "--", `${opts.commit}:${opts.path}`)).trim() ===
      "blob";
  } catch (err) {
    if (NO_SUCH_PATH.test(String(err))) return false;
    throw err;
  }
}

/**
 * The object id of the BLOB at `path` in `commit`, or null when the commit has no file there. An
 * id and never content, like `readTreeId`: what a check suite records as "the definition it ran",
 * so a report can name exactly which `checks.yml` judged the commit. A directory there is null,
 * as it is for `readRepoFile`. Throws only when the entry cannot answer at all.
 */
export async function readBlobId(
  opts: { dir: string; commit: string; path: string; git: Git },
): Promise<string | null> {
  const { dir, git } = opts;
  const rev = `${opts.commit}:${opts.path}`;
  let type: string;
  try {
    type = (await git(dir, "cat-file", "-t", "--", rev)).trim();
  } catch (err) {
    if (NO_SUCH_PATH.test(String(err))) return null;
    throw err;
  }
  if (type !== "blob") return null;
  return (await git(dir, "rev-parse", "--verify", "--end-of-options", rev)).trim();
}

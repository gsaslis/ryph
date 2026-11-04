// Reading a repo's `.agents/skills/` out of its cache entry, for the org skills repo's sync.
// The control plane decides what a skill IS; this only hands it the bytes and modes under one
// directory, at one commit.
//
// It extends helpers/repo_file.ts's invariant rather than breaking it: that file reads ONE fixed
// path per call site, this reads one fixed PREFIX. Every path read is one `git ls-tree` returned
// for that prefix's tree at the pinned commit, so nothing a caller supplies reaches a revision
// argument, and a general file-read API over every connected repo is still not on offer.
//
// Invariants:
// - every read names ONE immutable commit, resolved once by the caller (`resolveBranch`), and
//   the listing is of the tree id read at that commit, so the sizes checked and the bytes read
//   are the same objects however the branch moves meanwhile
// - bounded before a byte of content is read: the listing itself (git is killed past
//   `MAX_SKILLS_LISTING_BYTES`), then the entry count and the summed blob sizes from it; over any
//   of them the answer is `invalid`, never a truncated tree
// - one `git cat-file --batch` for every blob, never a process per file, and binary-safe: an
//   `assets/` image comes back as the bytes the repo holds, which the control plane hashes
// - symlinks and submodules are listed with their mode and no content: they are never followed,
//   and the control plane warns about them where the author can see it
// - the directory being absent is a VALUE, as a missing file is for `readRepoFile`
// - a submodule AT `.agents/skills` is `invalid`, saying so: its commit is not in the cache entry,
//   and the admin's fix is to the repo's layout, not to the forge

import type { CatFileBatch, Git, GitBounded } from "./git_exec.ts";

/** The one directory this reads under — a constant, for repo_file.ts's reason. */
export const SKILLS_DIR = ".agents/skills";

/** The most entries the listing may hold. Past it the tree is refused before any content is read:
 * 100 skills of a few files each is far below it. */
export const MAX_SKILLS_TREE_ENTRIES = 2_000;

/** The most blob bytes the listing may sum to, for the same reason. The answer crosses into the
 * control plane's process as base64 JSON. */
export const MAX_SKILLS_TREE_BYTES = 8 * 1024 * 1024;

/**
 * The most the `ls-tree -r` listing may print before the tree is refused unread: the entry cap at
 * the longest line a path a skill may hold can make (mode, type, a sha256 id, a padded size, and a
 * skill's name with a path eight segments of 128 deep). A push of a million entries otherwise lands
 * whole in this process, which every repo shares, on every sync.
 */
export const MAX_SKILLS_LISTING_BYTES = MAX_SKILLS_TREE_ENTRIES * 1_280;

/** The modes git records for what a tree can hold under `-r`; directories are walked. */
export type SkillsTreeMode = "100644" | "100755" | "120000" | "160000";

export interface SkillsTreeFile {
  /** Relative to `.agents/skills/`, "/"-separated, as git stores it. */
  path: string;
  mode: SkillsTreeMode;
  /** The blob's bytes; null for a symlink or a submodule, which are never read. */
  content: Uint8Array | null;
}

export type SkillsTreeRead =
  | { kind: "absent"; commit: string }
  /** The tree id the caller already holds: nothing more was read. */
  | { kind: "unchanged"; commit: string; tree: string }
  /** Over a bound; the detail is written for the repo's author. */
  | { kind: "invalid"; commit: string; detail: string }
  | { kind: "tree"; commit: string; tree: string; files: SkillsTreeFile[] };

const MODES = new Set<string>(["100644", "100755", "120000", "160000"]);

/**
 * `.agents/skills/` at `commit`, or why there is nothing to read. Throws only when the entry
 * cannot answer at all.
 */
export async function readSkillsTree(opts: {
  /** The bare cache entry. */
  dir: string;
  /** The commit to read from, as `resolveBranch` answered it. Never a ref name. */
  commit: string;
  /** The tree id the caller's current version was read from; equal, nothing more is read. */
  knownTree: string | null;
  /** A trimmed executor, for the one-line answers. */
  git: Git;
  /** An untrimmed, bounded executor: the listing is NUL-separated, a path may end in whitespace,
   * and its size is the repo's to decide. */
  gitBounded: GitBounded;
  catFile: CatFileBatch;
}): Promise<SkillsTreeRead> {
  const { dir, commit } = opts;
  const entry = await readSkillsEntry(dir, commit, opts.git);
  if (entry === null) return { kind: "absent", commit };
  if (entry.mode === "160000") {
    // The superproject never holds a submodule's commit, so there is nothing here to read; said
    // to the admin as the layout it is, rather than failing as an unreadable cache entry.
    return {
      kind: "invalid",
      commit,
      detail: `${SKILLS_DIR} is a git submodule, and a submodule is never read; commit the ` +
        `skills to the repo itself`,
    };
  }
  if (entry.mode !== "040000") return { kind: "absent", commit };
  const tree = entry.id;
  if (tree === opts.knownTree) return { kind: "unchanged", commit, tree };

  // The tree id, not `<commit> -- <path>`: the paths come back relative to the directory, and
  // the listing is of exactly the object whose id the caller will be told.
  const listing = await opts.gitBounded(
    dir,
    MAX_SKILLS_LISTING_BYTES,
    "ls-tree",
    "-r",
    "-l",
    "-z",
    "--end-of-options",
    tree,
  );
  if (listing === null) {
    return {
      kind: "invalid",
      commit,
      detail: `${SKILLS_DIR}'s listing is over ${MAX_SKILLS_LISTING_BYTES} bytes, far past the ` +
        `limit of ${MAX_SKILLS_TREE_ENTRIES} entries`,
    };
  }
  const entries = listing.split("\0").filter((line) => line !== "");
  if (entries.length > MAX_SKILLS_TREE_ENTRIES) {
    return {
      kind: "invalid",
      commit,
      detail: `${SKILLS_DIR} holds ${entries.length} entries, over the limit of ` +
        `${MAX_SKILLS_TREE_ENTRIES}`,
    };
  }

  const listed: Array<{ path: string; mode: SkillsTreeMode; id: string; size: number }> = [];
  let bytes = 0;
  for (const entry of entries) {
    // `<mode> SP <type> SP <object> SP+ <size>\t<path>`; the size is padded, and "-" for a
    // submodule.
    const tab = entry.indexOf("\t");
    const [mode, , id, size] = entry.slice(0, tab).split(/ +/);
    const path = entry.slice(tab + 1);
    if (tab < 0 || !MODES.has(mode)) {
      throw new Error(`git ls-tree answered an entry this does not read: ${entry.slice(0, 80)}`);
    }
    const regular = mode === "100644" || mode === "100755";
    const length = regular ? Number(size) : 0;
    if (!Number.isSafeInteger(length)) throw new Error(`git ls-tree could not size ${path}`);
    bytes += length;
    listed.push({ path, mode: mode as SkillsTreeMode, id, size: length });
  }
  if (bytes > MAX_SKILLS_TREE_BYTES) {
    return {
      kind: "invalid",
      commit,
      detail: `${SKILLS_DIR} holds ${bytes} bytes, over the limit of ${MAX_SKILLS_TREE_BYTES}`,
    };
  }

  const blobs = listed.filter((e) => e.mode === "100644" || e.mode === "100755");
  // A blob shared by two paths is asked for once.
  const content = await opts.catFile(
    dir,
    [...new Set(blobs.map((e) => e.id))],
    MAX_SKILLS_TREE_BYTES,
  );
  const files = listed.map((e): SkillsTreeFile => {
    if (e.mode === "120000" || e.mode === "160000") {
      return { path: e.path, mode: e.mode, content: null };
    }
    const read = content.get(e.id);
    // Asked for a moment ago at this very commit: a gap is a broken entry, not a missing file.
    if (read === undefined) throw new Error(`${e.path} vanished from ${commit}`);
    return { path: e.path, mode: e.mode, content: read };
  });
  return { kind: "tree", commit, tree, files };
}

/**
 * The entry `.agents/skills` itself is at `commit`, by its mode, or null when there is none.
 * `ls-tree` and not `cat-file -t`: a submodule's commit is not in the superproject, and asking for
 * its type fails the way a broken cache entry does, where its mode in the parent tree is plain.
 */
async function readSkillsEntry(
  dir: string,
  commit: string,
  git: Git,
): Promise<{ mode: string; id: string } | null> {
  // `<mode> SP <type> SP <object>\t<path>`, one line, or none when nothing is there (an absent
  // `.agents`, or a file where it should be a directory).
  const line = (await git(dir, "ls-tree", "--end-of-options", commit, "--", SKILLS_DIR)).trim();
  if (line === "") return null;
  const [mode, , id] = line.slice(0, line.indexOf("\t")).split(" ");
  return { mode, id };
}

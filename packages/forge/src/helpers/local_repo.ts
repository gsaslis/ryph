// The filesystem half of core/local_repo.ts: resolving a path on this machine against the
// allowed root, and asking git what kind of repository is there.
//
// Two entry points, for two moments:
// - `describeLocalRepo`, at connect time: every rule, plus the branch HEAD points at, which git
//   has to answer (a subprocess, so async)
// - `recheckLocalRepo`, every time a connected repo is USED — its upstream resolved for a
//   fetch, a delivery pushed into it. Synchronous, because `ForgeApi.upstreamUrl` is, and it
//   needs no git: it re-asks the structural questions (still the real path it was connected
//   as, still inside the root, still a repository with a `.git` directory whose store is its
//   own) a swap on disk could change. A readdir and a few stat calls, cheap enough for every
//   advertisement.
//
// "Inside the root" is about every byte git touches, not only the path: a `.git` directory can
// send git somewhere else entirely — `commondir` and `gitdir` name another repository's store,
// `objects`/`refs` (or a directory under them) can be symlinks out, and
// `objects/info/alternates` lends a whole other repository's objects to every fetch. Each is
// refused, here without git, and at connect time again by asking git where it would read.
//
// git runs with `--git-dir` pinned at the `.git` directory this module already checked, so it
// never walks up from a path to whatever repository happens to enclose it, and through the
// package's hermetic executor, so the user's global config adds nothing.

import { lstatSync, readdirSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import {
  type DescribedLocalRepo,
  isCanonicalAbsolute,
  isContainedIn,
  isLocalRepoRef,
  LOCAL_REPO_REFUSALS,
  type LocalRepoCheck,
  localRepoSummary,
  normalizeAbsolute,
} from "../core/local_repo.ts";
import type { Git } from "./git_exec.ts";

type Refusal = Extract<LocalRepoCheck, { ok: false }>;

const refuse = (reason: Refusal["reason"], message: string, root?: string): Refusal => ({
  ok: false,
  reason,
  message,
  summary: localRepoSummary(reason),
  ...(root === undefined ? {} : { root }),
});

function realPathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Where `path` leads on this disk, as far as the disk can say: its real path when it exists, and
 * otherwise the real path of the deepest part of it that does, with the rest appended — following
 * a symlink that dangles by reading it, as the kernel would on the way to creating its target.
 * Null when following it takes more links than the kernel itself would follow (a loop).
 *
 * What a containment test runs on for a path that does NOT exist: `root/up/etc/nope`, with
 * `root/up -> /`, leads to `/etc/nope`, outside the root — the same answer `root/up/etc/passwd`
 * gets — so whether a file exists outside the root cannot be read off which refusal comes back.
 * `path` must be absolute.
 */
export function realLocationOf(path: string): string | null {
  let at = normalizeAbsolute(path);
  for (let hop = 0; hop < 40; hop++) {
    const real = realPathOrNull(at);
    if (real !== null) return real;
    const segs = at.split("/").slice(1);
    // The deepest prefix that is there at all — lstat, so a dangling link counts. `/` always is.
    let found = segs.length;
    while (found > 0 && lstatOrNull(`/${segs.slice(0, found).join("/")}`) === null) found--;
    const rest = segs.slice(found);
    const tail = rest.length === 0 ? "" : `/${rest.join("/")}`;
    const prefixReal = realPathOrNull(`/${segs.slice(0, found).join("/")}`);
    if (prefixReal !== null) return normalizeAbsolute(`${prefixReal}${tail}`);
    // There, but it does not resolve: the prefix's last component is a link that dangles. Its
    // parent resolves (everything above something lstat reached is a directory it walked).
    let target: string;
    try {
      target = readlinkSync(`/${segs.slice(0, found).join("/")}`);
    } catch {
      return null;
    }
    const parent = realPathOrNull(`/${segs.slice(0, found - 1).join("/")}`);
    if (parent === null) return null;
    at = normalizeAbsolute(`${target.startsWith("/") ? target : `${parent}/${target}`}${tail}`);
  }
  return null;
}

/**
 * Whether `dir` is laid out like a bare repository: HEAD, objects/ and refs/ at its top. Only to
 * NAME the refusal — a directory without `.git` is refused either way, and saying "bare" rather
 * than "not a repository" tells the person what they are looking at.
 */
function looksBare(dir: string): boolean {
  return lstatOrNull(`${dir}/HEAD`)?.isFile() === true &&
    lstatOrNull(`${dir}/objects`)?.isDirectory() === true &&
    lstatOrNull(`${dir}/refs`)?.isDirectory() === true;
}

/**
 * The first symlink anywhere under `dir` — `dir` itself included — as a path relative to `dir`
 * ("" for `dir` itself), or null when there is none. A missing `dir` holds none. A directory that
 * cannot be read counts as holding one: what cannot be looked at is not known to stay inside.
 *
 * Every level, not only the first: git reads a loose object at `objects/ab/cdef…`, a pack under
 * `objects/pack/`, a branch at `refs/heads/ryph/ada/r-1` and writes its reflog under
 * `logs/refs/heads/…`, and a symlink at any of those depths is a read or a write of whatever it
 * points at — another repository's objects and refs served through the gateway, or a reflog
 * written outside the root. Cheap enough for every use: one readdir per directory, and the
 * entry's own type comes with it (no stat per file).
 */
export function firstSymlinkUnder(dir: string): string | null {
  const top = lstatOrNull(dir);
  if (top === null) return null;
  if (top.isSymbolicLink()) return "";
  if (!top.isDirectory()) return null;
  const pending = [""];
  while (pending.length > 0) {
    const rel = pending.pop() as string;
    try {
      for (
        const entry of readdirSync(rel === "" ? dir : `${dir}/${rel}`, { withFileTypes: true })
      ) {
        const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isSymbolicLink()) return child;
        if (entry.isDirectory()) pending.push(child);
      }
    } catch {
      return rel;
    }
  }
  return null;
}

/**
 * The `.git` directory's own layout: everything git reads or writes for a fetch or a push is
 * a real file or directory under it, so containing the path contains git too. Without git, so
 * it can run on every use:
 * - no `commondir` or `gitdir` file — either sends git to another repository's store, and a
 *   `.git` DIRECTORY with one is a hand-made redirect, never something `git init` or `git clone`
 *   writes into a main repository
 * - `HEAD` a plain file; `objects` and `refs` plain directories; `packed-refs`, when present, not
 *   a symlink; and no symlink ANYWHERE under `objects`, `refs`, `logs` or `reftable` — a loose
 *   object or a branch file symlinked into another repository is that repository's content
 *   served as this one's, and a symlinked `logs/refs` carries every reflog write out of the root
 * - no non-empty `objects/info/alternates` or `http-alternates`: they lend another repository's
 *   objects to everything this one serves, so a fetch through the gateway could read a
 *   repository outside the root by id
 */
function checkGitDir(real: string, path: string): Refusal | null {
  const gitDir = `${real}/.git`;
  for (const file of ["commondir", "gitdir"]) {
    if (lstatOrNull(`${gitDir}/${file}`) !== null) {
      return refuse("not_a_repository", LOCAL_REPO_REFUSALS.borrowedStore(path, file));
    }
  }
  if (lstatOrNull(`${gitDir}/HEAD`)?.isFile() !== true) {
    return refuse("not_a_repository", LOCAL_REPO_REFUSALS.linkedStore(path, "HEAD"));
  }
  for (const dir of ["objects", "refs"]) {
    if (lstatOrNull(`${gitDir}/${dir}`)?.isDirectory() !== true) {
      return refuse("not_a_repository", LOCAL_REPO_REFUSALS.linkedStore(path, dir));
    }
  }
  if (lstatOrNull(`${gitDir}/packed-refs`)?.isSymbolicLink() === true) {
    return refuse("not_a_repository", LOCAL_REPO_REFUSALS.linkedStore(path, "packed-refs"));
  }
  // `logs` whole, so `logs/refs` with it: the one directory every delivery writes through (the
  // reflog), and the one a one-level look missed.
  for (const dir of ["objects", "refs", "logs", "reftable"]) {
    const link = firstSymlinkUnder(`${gitDir}/${dir}`);
    if (link !== null) {
      const entry = link === "" ? dir : `${dir}/${link}`;
      return refuse("not_a_repository", LOCAL_REPO_REFUSALS.linkedStore(path, entry));
    }
  }
  for (const file of ["alternates", "http-alternates"]) {
    const info = lstatOrNull(`${gitDir}/objects/info/${file}`);
    // Empty is what `git repack -a -d` and deleting the lines leave; anything else — a symlink
    // included, whose own size is its target's length — lends objects.
    if (info !== null && !(info.isFile() && info.size === 0)) {
      return refuse("not_a_repository", LOCAL_REPO_REFUSALS.alternates(path, file));
    }
  }
  return null;
}

/**
 * Every structural rule, without git: absolute, inside the real root (textually first, then
 * really), a usable real path, a directory, a `.git` that is a DIRECTORY (not a file — a linked
 * worktree or a submodule checkout, whose objects live somewhere else — and not a symlink, which
 * could point anywhere at all), whose store is its own.
 */
function checkStructure(path: string, root: string): LocalRepoCheck {
  // Canonical only: a `.`/`..` segment is resolved by the kernel through whatever symlink comes
  // before it, so it is refused here rather than resolved textually one way and on disk another.
  if (!isCanonicalAbsolute(path)) {
    return refuse("not_absolute", LOCAL_REPO_REFUSALS.notAbsolute(path));
  }
  const realRoot = realPathOrNull(root);
  if (realRoot === null) {
    return refuse("outside_root", LOCAL_REPO_REFUSALS.rootMissing(root), root);
  }
  // Textually first, before the disk is asked anything about `path`: a path outside the root is
  // refused the same way whether or not it exists, so this route answers nothing about the rest
  // of the disk. Against the root as configured AND as resolved, because a root reached through
  // a symlink (macOS's /var → /private/var) is spelled both ways by the people typing paths.
  const lexical = normalizeAbsolute(path);
  if (!isContainedIn(lexical, realRoot) && !isContainedIn(lexical, normalizeAbsolute(root))) {
    return refuse("outside_root", LOCAL_REPO_REFUSALS.outsideRoot(path, root), realRoot);
  }
  const real = realPathOrNull(path);
  if (real === null) {
    // Not there — but "not found" is only the answer for a path that would be INSIDE the root if
    // it were. One that leads out through a symlink is outside the root whether or not it
    // exists, or the two answers together would say which files exist out there.
    const leads = realLocationOf(path);
    if (leads === null || !isContainedIn(leads, realRoot)) {
      return refuse("outside_root", LOCAL_REPO_REFUSALS.outsideRoot(path, root), realRoot);
    }
    return refuse("not_found", LOCAL_REPO_REFUSALS.notFound(path));
  }
  // Again after realPath on both sides, so a symlink cannot smuggle a path out of the root.
  if (!isContainedIn(real, realRoot)) {
    return refuse("outside_root", LOCAL_REPO_REFUSALS.outsideRoot(path, root), realRoot);
  }
  // The real path becomes the row's repoRef, and the wire refuses a ref with a control character
  // or edge whitespace: connecting one would store a repo no later request could name.
  if (!isLocalRepoRef(real)) {
    return refuse("not_a_repository", LOCAL_REPO_REFUSALS.unusablePath(path));
  }
  // `real` has no symlink left in it, so lstat and stat agree here.
  if (lstatOrNull(real)?.isDirectory() !== true) {
    return refuse("not_directory", LOCAL_REPO_REFUSALS.notADirectory(path));
  }
  // lstat, not stat: a `.git` symlink resolves to wherever it points, and git follows it.
  const dotGit = lstatOrNull(`${real}/.git`);
  if (dotGit === null) {
    return looksBare(real)
      ? refuse("bare_repository", LOCAL_REPO_REFUSALS.bare(path))
      : refuse("not_a_repository", LOCAL_REPO_REFUSALS.notARepo(path));
  }
  if (dotGit.isSymbolicLink()) {
    return refuse("not_a_repository", LOCAL_REPO_REFUSALS.gitIsSymlink(path));
  }
  if (!dotGit.isDirectory()) {
    return refuse("linked_worktree", LOCAL_REPO_REFUSALS.linkedWorktree(path));
  }
  const store = checkGitDir(real, path);
  if (store !== null) return store;
  return { ok: true, repo: { path: real } };
}

/**
 * A connected repo, checked again where it is used. `ref` is the row's `repoRef` — the real path
 * it resolved to when it was connected — and it must STILL be its own real path: a directory on
 * the way to it swapped for a symlink makes the same string name a different place, and that is
 * refused even when the new place is inside the root and is a repository, because it is not the
 * repository anybody connected.
 */
export function recheckLocalRepo(ref: string, root: string): LocalRepoCheck {
  const checked = checkStructure(ref, root);
  if (!checked.ok) return checked;
  if (checked.repo.path !== ref) {
    return refuse("not_found", LOCAL_REPO_REFUSALS.moved(ref, checked.repo.path));
  }
  return checked;
}

/**
 * Everything about a path a person typed to connect it: every structural rule, then git's own
 * word on whether it is bare (a `.git` directory can still be configured `core.bare`), and the
 * branch HEAD points at — which must be a real branch with a commit, because it becomes the
 * repo's default branch and every run's base.
 */
export async function describeLocalRepo(
  path: string,
  root: string,
  git: Git,
): Promise<LocalRepoCheck<DescribedLocalRepo>> {
  const checked = checkStructure(path, root);
  if (!checked.ok) return checked;
  const real = checked.repo.path;
  const gitDir = `--git-dir=${real}/.git`;

  // git's own word on where it would read and write, against the same fence: the layout check
  // above knows the redirects git has today, and this catches one it learns tomorrow.
  let paths: string[];
  try {
    paths = (await git(
      real,
      gitDir,
      "rev-parse",
      "--git-common-dir",
      "--git-path",
      "objects",
      "--git-path",
      "refs",
      "--git-path",
      "HEAD",
    )).split("\n");
  } catch {
    return refuse("not_a_repository", LOCAL_REPO_REFUSALS.notARepo(path));
  }
  for (const [i, entry] of ["commondir", "objects", "refs", "HEAD"].entries()) {
    const raw = paths[i];
    const resolved = raw === undefined
      ? null
      : realPathOrNull(raw.startsWith("/") ? raw : `${real}/${raw}`);
    if (resolved === null || !isContainedIn(resolved, `${real}/.git`)) {
      return refuse("not_a_repository", LOCAL_REPO_REFUSALS.linkedStore(path, entry));
    }
  }

  let bare: string;
  try {
    bare = await git(real, gitDir, "rev-parse", "--is-bare-repository");
  } catch {
    // A `.git` directory git will not open: corrupt, or not a repository at all.
    return refuse("not_a_repository", LOCAL_REPO_REFUSALS.notARepo(path));
  }
  if (bare === "true") return refuse("bare_repository", LOCAL_REPO_REFUSALS.bare(path));

  let branch: string;
  try {
    branch = await git(real, gitDir, "symbolic-ref", "--quiet", "--short", "HEAD");
  } catch {
    // Detached: HEAD names a commit, not a branch.
    return refuse("no_default_branch", LOCAL_REPO_REFUSALS.noDefaultBranch(path));
  }
  try {
    // Unborn: HEAD names a branch nothing has been committed to yet.
    await git(real, gitDir, "rev-parse", "--quiet", "--verify", `refs/heads/${branch}^{commit}`);
  } catch {
    return refuse("no_default_branch", LOCAL_REPO_REFUSALS.noDefaultBranch(path));
  }
  return { ok: true, repo: { path: real, defaultBranch: branch } };
}

/**
 * Whether every path a write of `refs/heads/<branch>` passes through — the loose ref and its
 * reflog, from `.git` down — is a real directory (or file) or not there yet. EVERY component,
 * not only those under `refs/heads`: lstat does not look at a path's parents, so a symlinked
 * `.git/logs/refs` makes `logs/refs/heads/ryph` look plain while the reflog lands wherever the
 * link points. A branch named `ryph/ada/r-1` is written three levels below `refs/heads`, and a
 * symlinked `refs/heads/ryph` would carry the write (and the reflog's) out the same way.
 *
 * Called right before the push, after the re-check walked the whole store: what this closes is
 * the window between the two.
 */
export function refPathIsPlain(real: string, branch: string): boolean {
  for (const base of [["refs", "heads"], ["logs", "refs", "heads"]]) {
    let at = `${real}/.git`;
    for (const seg of ["", ...base, ...branch.split("/")]) {
      if (seg !== "") at = `${at}/${seg}`;
      const info = lstatOrNull(at);
      // Not there yet: git makes it, as a real directory, under a parent just shown to be one.
      if (info === null) break;
      if (info.isSymbolicLink()) return false;
    }
  }
  return true;
}

/**
 * The branches checked out in the repository at `real` — its main worktree's HEAD and every
 * linked worktree's. Read straight off the files git keeps them in rather than through git, so
 * nothing the repository's own config says is consulted to answer it. A detached HEAD checks no
 * branch out and adds nothing.
 */
export async function checkedOutBranches(real: string): Promise<Set<string>> {
  const heads = [`${real}/.git/HEAD`];
  try {
    for (const entry of await readdir(`${real}/.git/worktrees`, { withFileTypes: true })) {
      if (entry.isDirectory()) heads.push(`${real}/.git/worktrees/${entry.name}/HEAD`);
    }
  } catch {
    // No linked worktrees.
  }
  const branches = new Set<string>();
  for (const head of heads) {
    const text = await readFile(head, "utf8").catch(() => "");
    const ref = /^ref: refs\/heads\/(.+)$/m.exec(text)?.[1]?.trim();
    if (ref !== undefined) branches.add(ref);
  }
  return branches;
}

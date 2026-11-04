// The `local` provider's rules: which paths on this machine are repositories the forge may read
// and deliver into. Pure — the filesystem half is helpers/local_repo.ts, which asks the
// questions these rules turn on.
//
// ── Why this is gated, and gated hard ─────────────────────────────────────────────────────────
//
// A local repo's address is a path on the forge's own disk, and every path the forge acts on is
// one the gateway FETCHES FROM (door ①'s cache) and one a delivery PUSHES INTO. Either is a read
// or a write outside any sandbox. So the forge names a root — RYPH_LOCAL_REPO_ROOT — and every
// path must resolve inside it, with symlinks resolved on BOTH sides first: a textual prefix test
// is not a boundary, because a symlink inside the root pointing at `/` passes it.
//
// The rules are applied when a repo is connected (the describe route) AND every time the forge
// resolves the repo's upstream or delivers into it. The row holds the path as it resolved at
// connect time; what sits at that path can change since — a directory swapped for a symlink to
// somewhere else is the same row naming a different place. Re-checking where the path is used
// is what keeps the connect-time answer from being a check against a past state of the disk.

/** Why a path is not a local repo the forge will act on — the codes the describe route answers
 * with, and the control plane shows a person in words of its own. */
export type LocalRepoRefusalReason =
  | "not_absolute"
  | "outside_root"
  | "not_found"
  | "not_directory"
  | "not_a_repository"
  | "linked_worktree"
  | "bare_repository"
  | "no_default_branch";

/** A local repo as it resolved: its real path (the `repoRef` and `url` of a connected row) and,
 * where it was asked for, the branch its HEAD points at. */
export interface LocalRepo {
  path: string;
}

export interface DescribedLocalRepo extends LocalRepo {
  defaultBranch: string;
}

/**
 * A refusal carries two wordings, for two audiences. `message` is the admin's, at connect time:
 * it names the path they typed and says what to change. `summary` is for everyone else — a run
 * whose fetch or delivery was refused, and the control plane that stores the reason and hands it
 * on to an agent: no host path, nothing git printed, because neither is the agent's to see and
 * neither helps it. `root` rides an `outside_root` refusal: the allowed root, so the person
 * connecting is told where repositories CAN be.
 */
export type LocalRepoCheck<T extends LocalRepo = LocalRepo> =
  | { ok: true; repo: T }
  | {
    ok: false;
    reason: LocalRepoRefusalReason;
    message: string;
    summary: string;
    root?: string;
  };

/**
 * Whether `path` is spelled the one way a local repo's address may be: absolute, and nothing a
 * second spelling of the same place could hide behind. Relative paths would resolve against the
 * forge's working directory, which nobody typing one can see, and `~` would need a shell.
 */
export function isAbsolutePath(path: string): boolean {
  // NUL ends a path in every syscall underneath, so a path carrying one is two paths.
  return path.startsWith("/") && !path.includes("\0");
}

/**
 * Whether `path` is absolute AND spelled canonically: no `.` or `..` segment, no `//`, no
 * trailing `/` (`/` itself is canonical). A `..` cannot be resolved without the disk — after a
 * symlink, `link/..` is the parent of wherever the link points, not the folder holding it — so a
 * path carrying one is refused before the disk is asked anything, rather than resolved one way
 * for the containment test and another by the kernel.
 */
export function isCanonicalAbsolute(path: string): boolean {
  if (!isAbsolutePath(path)) return false;
  if (path === "/") return true;
  return path.slice(1).split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * `path` with `.`, `..` and repeated slashes resolved TEXTUALLY — no filesystem call, no
 * symlink followed. What the containment test runs on first, before the disk is asked anything:
 * a path outside the root is then refused as outside the root whether or not it exists, so the
 * describe route cannot be used to probe the rest of the disk. `..` above `/` stays at `/`, as
 * the kernel resolves it. `path` must be absolute.
 */
export function normalizeAbsolute(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

/**
 * Whether `realPath` is inside `realRoot`. Both must already be resolved — symlinks included —
 * which is why this takes real paths rather than resolving them: a symlink inside the root
 * pointing at `/` would otherwise pass a textual check.
 */
export function isContainedIn(realPath: string, realRoot: string): boolean {
  const root = realRoot.replace(/\/+$/, "");
  // "/" as a root would allow the whole disk; the composition root refuses it at boot, and it is
  // refused here too so no other caller can make it mean "everything".
  if (root === "") return false;
  // The separator matters: without it, root "/srv/repos" would accept "/srv/repos-evil".
  return realPath === root || realPath.startsWith(`${root}/`);
}

/**
 * A `local` repoRef as the wire may carry it: absolute, no trailing slash, no `.`/`..` or empty
 * segment, no control character, no whitespace at either end. Exactly the shapes a real path
 * takes — so a ref that is not one cannot be the real path of anything, and is refused before the
 * disk is asked. The edge whitespace is refused rather than trimmed: `/srv/app ` is a real
 * directory's name, and trimming it would quietly name a different one. A real path that fails
 * this is refused at connect time instead, so no row is ever stored that the wire cannot carry.
 */
export function isLocalRepoRef(ref: string): boolean {
  if (!isAbsolutePath(ref) || ref.length > LOCAL_REPO_REF_MAX) return false;
  if (ref === "/") return false;
  // oxlint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(ref)) return false;
  if (/^\s|\s$/u.test(ref)) return false;
  return ref.slice(1).split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** The longest local repoRef carried — PATH_MAX on Linux, and far past any real repo. */
export const LOCAL_REPO_REF_MAX = 4096;

/**
 * The refusal messages, in one place so they stay consistent between the checks and their
 * tests. Each says what to change: a repo refused with "not allowed" and no reason is a
 * support ticket.
 */
export const LOCAL_REPO_REFUSALS = {
  notAbsolute: (path: string) =>
    `${JSON.stringify(path)} is not a plain absolute path. Give the repository's full path, ` +
    "starting with /, with no . or .. parts and no trailing /.",
  outsideRoot: (path: string, root: string) =>
    `${path} is outside the allowed root (${root}). Only repositories under that directory ` +
    "can be connected — RYPH_LOCAL_REPO_ROOT sets it.",
  rootMissing: (root: string) =>
    `the allowed root (${root}) does not exist on this machine, so no repository is under it.`,
  notFound: (path: string) => `${path} does not exist on this machine.`,
  notADirectory: (path: string) => `${path} is not a directory.`,
  notARepo: (path: string) =>
    `${path} has no .git directory — it does not look like a git repository. ` +
    "Point at the repository's root, not a subdirectory.",
  gitIsSymlink: (path: string) =>
    `${path}/.git is a symbolic link. Point at the directory it links to instead.`,
  linkedWorktree: (path: string) =>
    `${path}/.git is a file, not a directory, which makes it a linked worktree or a submodule ` +
    "checkout. Use the main repository's directory instead.",
  bare: (path: string) =>
    `${path} is a bare repository. Connect a repository with a working tree — the one you ` +
    "check branches out in.",
  noDefaultBranch: (path: string) =>
    `${path} has no branch checked out (its HEAD is detached, or the branch has no commits ` +
    "yet). Check out the branch work should start from, then try again.",
  moved: (ref: string, now: string) =>
    `${ref} now resolves to ${now} — something at that path changed since it was connected. ` +
    "Reconnect the repository if the move was intended.",
  unusablePath: (path: string) =>
    `${JSON.stringify(path)} resolves to a path ryph cannot use: one containing control ` +
    "characters or edge whitespace. Rename the directory, then try again.",
  borrowedStore: (path: string, file: string) =>
    `${path}/.git/${file} points git at another repository's store, so the repository there is ` +
    "not the one at this path. Connect the repository that holds the objects instead.",
  linkedStore: (path: string, entry: string) =>
    `${path}/.git/${entry} is a symbolic link or not where git keeps it, so what git reads ` +
    "and writes there could be anywhere on this machine. Replace it with the real directory.",
  alternates: (path: string, file: string) =>
    `${path}/.git/objects/info/${file} borrows objects from another repository, which would ` +
    "let a run read that repository too. Run `git repack -a -d` and remove the file, then " +
    "try again.",
} as const;

/**
 * A refusal in words a RUN may read: what kind of trouble, never where. Used wherever the
 * re-check refuses a connected repo under a run (the gateway's fetch, a delivery), because that
 * answer is stored by the control plane and handed on to the agent — and a host path is neither
 * the agent's business nor any help to it. The admin's full wording stays in the log.
 */
export function localRepoSummary(reason: LocalRepoRefusalReason): string {
  switch (reason) {
    case "outside_root":
      return "the repository on this machine is no longer inside the allowed root";
    case "not_absolute":
    case "not_found":
    case "not_directory":
      return "the repository on this machine is no longer where it was connected";
    case "no_default_branch":
      return "the repository on this machine has no branch checked out to start from";
    case "not_a_repository":
    case "linked_worktree":
    case "bare_repository":
      return "the repository on this machine is no longer a plain git repository ryph can use";
  }
}

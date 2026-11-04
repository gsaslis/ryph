// Local git operations on the checkout:
// plain git on a local directory, with no external variance.
// A helper rather than a port for that reason.
//
// Each helper takes the git executor so its commands trace through the caller's diagnostics:
// pass a traced executor (makeGit(diag)) to see every local step, the plain `git` to stay silent.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CODENAME, RUN_TRAILER } from "../core/brand.ts";
import type { AgentIdentity, CommitInfo } from "../core/types.ts";
import { errorMessage } from "./errors.ts";
import { type Git, gitHooksDir } from "./git_exec.ts";

/**
 * `name` is caller input.
 * It is safe in the `-b` argument slot without `--end-of-options`:
 * git consumes the token after `-b` as the branch name (never re-parsed as a flag)
 * and refuses a leading-dash name via check-ref-format —
 * and `--end-of-options` would disable the `-b` we want.
 * The schema's gitName guard (schema.ts) is belt-and-suspenders here, not the sole defense.
 */
export async function createBranch(
  git: Git,
  dir: string,
  name: string,
): Promise<void> {
  await git(dir, "checkout", "-b", name);
}

/**
 * Moves `name` to `sha` and checks it out — `git checkout -B`, which creates or RESETS the
 * branch in one step. Whatever the branch pointed at is left behind, so the caller owns the
 * question of whether anything there still mattered.
 *
 * Safe in the `-B` argument slot without `--end-of-options` for the same reason `-b` is above:
 * git consumes the token after it as a branch name. `sha` is a commit the caller already
 * resolved, never agent text.
 */
export async function resetBranch(
  git: Git,
  dir: string,
  name: string,
  sha: string,
): Promise<void> {
  await git(dir, "checkout", "-B", name, sha);
}

export async function headSha(git: Git, dir: string): Promise<string> {
  return await git(dir, "rev-parse", "HEAD");
}

/**
 * `git status` as a cleanliness check. Untracked files are always listed: a setup step runs repo
 * code that can write `.git/config`, and `status.showUntrackedFiles=no` would otherwise hide a
 * file from the check while `add -A` still ships it. A submodule's `ignore` setting is honoured
 * for what is INSIDE it (dirt, untracked files): no change `add -A` could stage, and overriding
 * it would read a repo that keeps build output in a submodule as changed forever — `commitAll`
 * then finding nothing to commit. What it says about the submodule's commit is not: see
 * `MOVED_GITLINKS`, the listing `changedPaths` and `hasChanges` read beside this one.
 */
export const STATUS_PORCELAIN = [
  "status",
  "--porcelain",
  "--untracked-files=normal",
] as const;

/**
 * Gitlinks whose submodule moved to another commit, whatever its `ignore` setting says:
 * `ignore = all` hides a submodule whose HEAD moved from `git status`, yet `add -A` stages the
 * new gitlink, so the bump would ship unseen. A second listing, not a flag on the first:
 * `--ignore-submodules=dirty` overrides the setting of EVERY submodule, hiding the dirt inside
 * them even where the repo shows it (measured, git 2.52).
 */
const MOVED_GITLINKS = [
  "status",
  "--porcelain",
  "--untracked-files=no",
  "--ignore-submodules=dirty",
] as const;

export async function hasChanges(git: Git, dir: string): Promise<boolean> {
  return (await changedPaths(git, dir)).length > 0;
}

/** Paths `git status` reports as modified or untracked (gitignored files never appear), whatever
 * the repo's config says to hide (`STATUS_PORCELAIN`), and gitlinks that moved (`MOVED_GITLINKS`). */
export async function changedPaths(git: Git, dir: string): Promise<string[]> {
  const paths = porcelainPaths(await git(dir, ...STATUS_PORCELAIN));
  for (const path of porcelainPaths(await git(dir, ...MOVED_GITLINKS))) {
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

function porcelainPaths(out: string): string[] {
  if (out === "") return [];
  // Each line is `XY path`. The executor trims its output, which takes the leading space off
  // the first line when X is blank (` M a` arrives as `M a`): then the path starts a column
  // early. Only then is the second column a space and the third not — an untrimmed `X ` status
  // is followed by the separating space.
  return out.split("\n").map((line, i) =>
    i === 0 && line[1] === " " && line[2] !== " " ? line.slice(2) : line.slice(3)
  );
}

/** Where git finds a repository, as real paths: its work tree, its git dir, and the git dir its
 * objects and refs live in (the same one, but in a linked worktree). */
interface RepoPlace {
  top: string;
  gitDir: string;
  commonDir: string;
}

/**
 * A submodule of the start commit — any gitlink it (or the index) records, whether `.gitmodules`
 * names it or not — as it stood at the start. `where` is null when it was not checked out then —
 * no `.git` in its directory, which is how every clone the runner makes leaves one (it never
 * initialises submodules) — and only then do `name` and `moduleDir` matter: `name` says where git
 * keeps its clone (`modules/<name>` in the git dir around it; null when `.gitmodules` names none
 * git would use, or none at all), `moduleDir` whether that clone already existed.
 */
export interface SubmoduleStart {
  path: string;
  sha: string;
  name: string | null;
  moduleDir: boolean;
  where: RepoPlace | null;
  /** Its filter drivers and attributes at the start (`DriverStart`); null when it was not
   * checked out. */
  drivers: DriverStart | null;
  submodules: readonly SubmoduleStart[];
}

/**
 * What decides which filter driver commands git runs in a repository, as it stood at the start —
 * what put-back of a FAILED repository returns it to before any git command that could run one
 * (`restoreDrivers`):
 *
 * - `config`: the keys of its config file (`<common dir>/config`, includes not followed) that
 *   define drivers or bring definitions and attributes in — `filter.*`, `include.*`,
 *   `includeIf.*`, `core.attributesFile`, `extensions.worktreeConfig` (`DRIVER_KEYS`) — as
 *   `git config -z` lists them;
 * - `effective`: `filter.*` and `core.attributesFile` as git reads them there, includes followed
 *   (`EFFECTIVE_KEYS`): what the restored config is checked against;
 * - `attributes`: its `info/attributes` (`AttributesStart`).
 */
export interface DriverStart {
  config: string;
  effective: string;
  attributes: AttributesStart;
}

/**
 * A repository's `info/attributes` at the start: absent, its bytes (up to `ATTRIBUTES_MAX`), or —
 * larger, or not a plain file — only a signature, which put-back can compare against but not
 * restore from.
 */
export type AttributesStart =
  | { kind: "absent" }
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "opaque"; signature: string };

/**
 * Where a checkout stood before anything ran in it, and what `putBack` returns it to — never
 * wherever HEAD has moved since, because a setup step can commit, switch branch, or stop
 * mid-rebase. The commit and the branch HEAD named (null for a detached HEAD); the replace refs
 * it already held (no departure: the runner's git ignores them everywhere, git_exec.ts — only
 * ones written since are); where git found the repository; what decides its filter drivers
 * (`DriverStart`); and the start commit's submodules, each with whether it was checked out (and
 * its drivers).
 */
export interface CheckoutStart {
  sha: string;
  branch: string | null;
  replaceRefs: readonly string[];
  where: RepoPlace;
  drivers: DriverStart;
  submodules: readonly SubmoduleStart[];
}

/** How deep the snapshot follows submodules inside submodules. Deeper ones are taken as never
 * checked out: what a step leaves there is removed, never put back. */
const SUBMODULE_DEPTH = 8;

/** Where a checkout stands now — or at the `sha` and `branch` the caller already resolved — as
 * `putBack` will take it back. `dir` must be the top of its own repository. */
export async function checkoutStart(
  git: Git,
  dir: string,
  at?: { sha: string; branch: string | null },
): Promise<CheckoutStart> {
  const where = await placeOf(git, dir);
  if (where === null || where.top !== await realpath(dir)) {
    throw new Error(`${dir} is not the top of a repository of its own`);
  }
  const sha = at?.sha ?? await headSha(git, dir);
  return {
    sha,
    branch: at === undefined ? await currentBranch(git, dir) : at.branch,
    replaceRefs: await replaceRefs(git, dir),
    where,
    drivers: await driverStart(git, dir, where),
    submodules: await submodulesAt(git, dir, sha, where.gitDir, 0),
  };
}

async function placeOf(git: Git, dir: string): Promise<RepoPlace | null> {
  try {
    const top = await git(dir, "rev-parse", "--show-toplevel");
    const gitDir = await git(dir, "rev-parse", "--absolute-git-dir");
    const common = await git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
    return {
      top: await realpath(top),
      gitDir: await realpath(gitDir),
      commonDir: await realpath(common),
    };
  } catch {
    return null;
  }
}

/**
 * Refuses to go on unless git still finds, at `dir`, the repository it found at the start. A
 * step can point the checkout at another directory — `core.worktree`, a `.git` file or link to
 * another git dir, a `commondir` — and every checkout, reset and clean after would act there
 * while the checkout itself kept what the step left.
 */
async function assertPlace(git: Git, dir: string, start: RepoPlace, what: string): Promise<void> {
  const now = await placeOf(git, dir);
  if (
    now !== null && now.top === start.top && now.gitDir === start.gitDir &&
    now.commonDir === start.commonDir
  ) return;
  const found = now === null
    ? "git finds no repository there"
    : `git reads ${now.top} through ${now.gitDir}`;
  throw new Error(
    `${what} is no longer the repository it started as (${found}, not ${start.top} through ` +
      `${start.gitDir}): a setup step pointed it elsewhere (core.worktree, a .git file or link), ` +
      "and nothing is put back through it",
  );
}

/**
 * Every gitlink of the start commit (and of the index, which a clean start agrees with) in the
 * repository at `dir`, as it stands: whether `.gitmodules` at `sha` names it or not. A nested
 * repository committed as a bare gitlink, checked out when the run starts (a warm image's), is
 * as much the start as a declared submodule: put-back restores it, never empties it. Only a
 * gitlink with no checkout at the start is one a step can have brought in.
 */
async function submodulesAt(
  git: Git,
  dir: string,
  sha: string,
  gitDir: string,
  depth: number,
): Promise<SubmoduleStart[]> {
  const links = await gitlinks(git, dir, sha);
  if (links.size === 0) return [];
  const names = await submoduleNames(git, dir, sha);
  const subs: SubmoduleStart[] = [];
  for (const [path, id] of links) {
    const name = names.get(path) ?? null;
    const subDir = join(dir, path);
    // A `.git` that does not make the directory its own repository is no checkout of it, and
    // nor is one reached through a link.
    const found = await noLinkTo(dir, path) && await exists(join(subDir, ".git"))
      ? await placeOf(git, subDir)
      : null;
    const where = found !== null && found.top === await realpath(subDir) ? found : null;
    subs.push({
      path,
      sha: id,
      name,
      moduleDir: name !== null && await exists(join(gitDir, "modules", name)),
      where,
      drivers: where !== null ? await driverStart(git, subDir, where) : null,
      submodules: where !== null && depth + 1 < SUBMODULE_DEPTH
        ? await submodulesAt(git, subDir, id, where.gitDir, depth + 1)
        : [],
    });
  }
  return subs;
}

/** Path → name for every submodule `.gitmodules` at `sha` declares, read from the commit (never
 * the work tree a step can rewrite). A name with a `..` (or empty, or absolute) part maps to null:
 * git refuses it too, and a path built from it could leave the git dir. */
async function submoduleNames(
  git: Git,
  dir: string,
  sha: string,
): Promise<Map<string, string | null>> {
  const out = await git(
    dir,
    "config",
    "-z",
    "--no-includes",
    "--blob",
    `${sha}:.gitmodules`,
    "--get-regexp",
    "^submodule\\..*\\.path$",
  ).catch(() => "");
  const names = new Map<string, string | null>();
  for (const entry of out.split("\0")) {
    const newline = entry.indexOf("\n");
    if (newline < 0) continue;
    const name = entry.slice("submodule.".length, newline - ".path".length);
    const path = entry.slice(newline + 1).replace(/\/+$/, "");
    if (path === "" || names.has(path)) continue;
    const usable = name !== "" && !name.startsWith("/") && !name.includes("\\") &&
      !name.split("/").some((part) => part === "" || part === "." || part === "..");
    names.set(path, usable ? name : null);
  }
  return names;
}

/** The state git keeps for an operation that stopped half-way, and what to call each. */
const IN_PROGRESS: ReadonlyArray<readonly [string, string]> = [
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase or am"],
  ["MERGE_HEAD", "a merge"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
  ["sequencer", "a cherry-pick or revert sequence"],
];
/** Every file of that state, the messages beside the markers included — removing them is what
 * `git rebase --quit` (and its kin) does: HEAD and the tree are left to the reset that follows —
 * and the locks a step killed mid-command leaves. Every setup step has finished when a tree is
 * put back, so no lock is anyone's any more, and a stale one would make the checkout refuse. */
const STOPPED_STATE = [
  ...IN_PROGRESS.map(([name]) => name),
  "MERGE_MSG",
  "MERGE_MODE",
  "AUTO_MERGE",
  "index.lock",
  "HEAD.lock",
];

async function clearStopped(gitDir: string): Promise<void> {
  for (const name of STOPPED_STATE) await rm(join(gitDir, name), { recursive: true, force: true });
}

/**
 * How a checkout departs from `start`, in plain words; empty when it does not. Uncommitted or
 * untracked changes (what `changedPaths` reports — never ignored files — submodules that moved
 * or that the repo's config shows dirty among them), a HEAD that moved, a branch switched or
 * left, an operation stopped half-way, an object substitute. Throws when git no longer finds the
 * checkout's own repository there (`assertPlace`). Its `git status` is the plain one, as every
 * dirty check is: it runs the `clean` filters the config there names, as on any status. Turning
 * drivers off here would misread a repository that uses them — a file stored through a clean
 * filter reads as modified once its stat info changes, git-lfs's pointers as changed content —
 * and put back a tree nothing changed. For a failed repository, `putBack` has already returned
 * that config to the start (`restoreDrivers`) when this runs, so only the repository's own
 * drivers are left to run.
 */
export async function departures(git: Git, dir: string, start: CheckoutStart): Promise<string[]> {
  await assertPlace(git, dir, start.where, "the checkout");
  const found: string[] = [];
  const dirt = await changedPaths(git, dir);
  if (dirt.length > 0) {
    found.push(`changes to ${dirt.slice(0, 5).join(", ")}${dirt.length > 5 ? ", …" : ""}`);
  }
  const sha = await headSha(git, dir).catch(() => null);
  if (sha !== start.sha) {
    found.push(
      `HEAD at ${sha === null ? "no commit" : sha.slice(0, 10)}, not ${start.sha.slice(0, 10)}`,
    );
  }
  const branch = await currentBranch(git, dir);
  if (branch !== start.branch) {
    found.push(branch === null ? "a detached HEAD" : `branch ${branch} checked out`);
  }
  for (const [name, what] of IN_PROGRESS) {
    if (await exists(join(start.where.gitDir, name))) found.push(`${what} in progress`);
  }
  // Object substitutes: a replace ref (or a graft) makes git read one commit as another, so a
  // `checkout` of the start commit would check out content nobody committed. The runner's own git
  // ignores replace refs (git_exec.ts), but the agent's plain git does not; none written since
  // the start stays.
  if ((await newReplaceRefs(git, dir, start)).length > 0) {
    found.push("replace refs under refs/replace/");
  }
  if (await exists(await graftsFile(git, dir))) found.push("a grafts file");
  return found;
}

/** Every ref under `refs/replace/`. */
async function replaceRefs(git: Git, dir: string): Promise<string[]> {
  const out = await git(dir, "for-each-ref", "--format=%(refname)", "refs/replace/");
  return out === "" ? [] : out.split("\n").filter((ref) => ref !== "");
}

/** The replace refs written since `start`. */
async function newReplaceRefs(git: Git, dir: string, start: CheckoutStart): Promise<string[]> {
  const before = new Set(start.replaceRefs);
  return (await replaceRefs(git, dir)).filter((ref) => !before.has(ref));
}

/** Where git reads grafts from for this clone (`info/grafts` in its common git dir). */
async function graftsFile(git: Git, dir: string): Promise<string> {
  return await git(dir, "rev-parse", "--path-format=absolute", "--git-path", "info/grafts");
}

/**
 * Puts a checkout back to `start`. In order: git must still find the checkout's own repository
 * there (`assertPlace`); any operation a step stopped half-way is abandoned (its state removed,
 * as `--quit` would) and the locks a killed one left are removed; replace refs written since the
 * start and a grafts file go, so the commit checked out is the one the repository holds; the
 * branch (or a detached HEAD) is checked out at the start commit — so a commit a step made, or a
 * branch it switched to, is not taken for the agent's work — tracked changes reverted, index too,
 * and untracked files and directories removed, nested repositories included (`clean -ffd`).
 * Never ignored ones (no `-x`): whatever setup built into gitignored paths (node_modules/,
 * target/) stays. Submodules last, by `restoreSubmodules`.
 *
 * Local git alone, and only on the checkout's own repositories: nothing is fetched (lazy fetches
 * included, `GIT_NO_LAZY_FETCH` in git_exec.ts and `refuseLazyFetch`). Of the commands the
 * checkout's config can name, what these git commands would run is turned off: hooks and
 * `core.fsmonitor` for every git call (git_exec.ts), and recursion into submodules for the
 * checkouts and resets that rewrite the tree (`--no-recurse-submodules`, whatever
 * `submodule.recurse` a step set). Filter drivers are not: every command here is plain, and runs
 * the drivers the config names, as main does — so the content put back, and the status that
 * checks it, agree with that config. Which drivers that is, `putBack` settles before anything
 * here runs: for a failed repository, the ones it started with (`restoreDrivers`); otherwise the
 * ones its (successful) setup left. Not anything else in that config: none of these commands
 * reads a `diff` or `merge` driver, a credential helper, an `sshCommand` or a `uploadpack`.
 * Before each `clean`, what it removes is made removable (`unlockUntracked`): a
 * read-only directory a step left (`go mod download` into the checkout) would refuse it. Returns
 * what it could not put back, in plain words. The caller checks `departures` again after either
 * way: a tree this could not put back must not be shipped.
 *
 * `start.branch` is safe in `-B`'s argument slot for the reason `resetBranch` gives; `start.sha`
 * is a commit the caller resolved.
 */
async function restoreCheckout(git: Git, dir: string, start: CheckoutStart): Promise<string[]> {
  await assertPlace(git, dir, start.where, "the checkout");
  await refuseLazyFetch(git, dir, "the checkout");
  await clearStopped(start.where.gitDir);
  for (const ref of await newReplaceRefs(git, dir, start)) await git(dir, "update-ref", "-d", ref);
  await rm(await graftsFile(git, dir), { force: true });
  const checkout = ["checkout", "-q", "-f", "--no-recurse-submodules"];
  if (start.branch === null) await git(dir, ...checkout, "--detach", start.sha);
  else await git(dir, ...checkout, "-B", start.branch, start.sha);
  await git(dir, "reset", "-q", "--hard", "--no-recurse-submodules", start.sha);
  await unlockUntracked(git, dir);
  await git(dir, "clean", "-q", "-ffd");
  return await restoreSubmodules(git, dir, start.submodules, start.where.gitDir, "");
}

/**
 * Puts back the submodules of the repository at `dir` that its own status reports changed
 * (`changedSubmodules`), each by what it was at the start:
 *
 * - checked out then: back on the commit the start commit records for it (`restoreSubmodule`);
 * - not checked out then (or a gitlink the start did not record): not checked out again —
 *   its directory emptied and kept, the clone a step made for it (`modules/<name>`) removed.
 *   Nothing in it is read: a `git submodule update` that cloned it and could not check its commit
 *   out (never pushed, a shallow remote, a flaky network) leaves a clone on the wrong commit, and
 *   that is setup's leftover like any other.
 *
 * A submodule a step checked out cleanly on its recorded commit is not reported changed, and
 * stays: setup initialising submodules is preparation, not work. Only what status reports moves,
 * so output a submodule's `ignore = untracked` (or `dirty`) hides stays too, as `commitAll` would
 * leave it: git reads it as no change.
 *
 * Never `git submodule update` or `foreach`: `update` clones a submodule registered but never
 * checked out — even with `--no-fetch`, and for as long as an unreachable remote takes to answer
 * — and runs the `submodule.<name>.update = !command` a step may have configured; `foreach`
 * cleans inside every submodule whatever the repo says to ignore.
 */
async function restoreSubmodules(
  git: Git,
  dir: string,
  subs: readonly SubmoduleStart[],
  gitDir: string,
  prefix: string,
): Promise<string[]> {
  const left: string[] = [];
  for (const path of await changedSubmodules(git, dir)) {
    const name = `${prefix}${path}`;
    const start = subs.find((sub) => sub.path === path);
    try {
      if (start?.where) left.push(...await restoreSubmodule(git, dir, start, start.where, name));
      else await uncheckout(dir, path, gitDir, start ?? null);
    } catch (err) {
      left.push(`submodule ${name}: ${errorMessage(err)}`);
    }
  }
  return left;
}

/**
 * A submodule checked out at the start, back on the commit the start commit records for it: any
 * operation stopped half-way in it abandoned, checked out detached at that commit, its own
 * submodules put back the same way, and only while the status still names it reset and cleaned
 * (no `-x`). A commit its clone does not hold is never fetched: it is named in what this returns,
 * and the check after refuses the tree.
 */
async function restoreSubmodule(
  git: Git,
  dir: string,
  start: SubmoduleStart,
  where: RepoPlace,
  name: string,
): Promise<string[]> {
  const sub = join(dir, start.path);
  await assertNoLinkTo(dir, start.path);
  await assertPlace(git, sub, where, `submodule ${name}`);
  await refuseLazyFetch(git, sub, `submodule ${name}`);
  await clearStopped(where.gitDir);
  const held = await git(sub, "cat-file", "-e", `${start.sha}^{commit}`).then(
    () => true,
    () => false,
  );
  if (!held) {
    return [
      `submodule ${name} records commit ${start.sha.slice(0, 10)}, which its clone does not ` +
      "hold (it is never fetched)",
    ];
  }
  await git(sub, "checkout", "-q", "-f", "--no-recurse-submodules", "--detach", start.sha);
  const left = await restoreSubmodules(git, sub, start.submodules, where.gitDir, `${name}/`);
  if ((await changedSubmodules(git, dir)).includes(start.path)) {
    await git(sub, "reset", "-q", "--hard", "--no-recurse-submodules");
    await unlockUntracked(git, sub);
    await git(sub, "clean", "-q", "-ffd");
  }
  return left;
}

/**
 * A submodule that was not checked out at the start, not checked out again: everything in its
 * directory removed, its `.git` included, and the directory kept — an empty one is how git leaves
 * a submodule it has not checked out, and status reads it as unchanged. The clone git made for it
 * in `modules/<name>` goes too when it did not exist at the start: left, it would be baked into an
 * image, and a later `git submodule update` would take it up as it stands — on whatever commit,
 * with whatever config a step wrote into it. Plain file removal, never a git command in it.
 */
async function uncheckout(
  dir: string,
  path: string,
  gitDir: string,
  start: SubmoduleStart | null,
): Promise<void> {
  await assertNoLinkTo(dir, path);
  const target = join(dir, path);
  const found = await lstat(target).catch(() => null);
  if (found?.isDirectory()) {
    await makeRemovable(target);
    for (const entry of await readdir(target)) {
      await rm(join(target, entry), { recursive: true, force: true });
    }
  } else {
    // A link or a file in its place: removed itself, never followed.
    if (found !== null) await rm(target, { force: true });
    await mkdir(target);
  }
  if (start === null || start.name === null || start.moduleDir) return;
  const moduleDir = join("modules", start.name);
  if (await noLinkTo(gitDir, moduleDir)) {
    await ownerWritable(dirname(join(gitDir, moduleDir)));
    await makeRemovable(join(gitDir, moduleDir));
    await rm(join(gitDir, moduleDir), { recursive: true, force: true });
  }
}

/**
 * Makes what `clean -ffd` is about to remove in the repository at `dir` removable: each untracked,
 * not ignored path git lists (a whole untracked directory, a nested repository, as one entry) has
 * every directory on its way and every directory inside it made owner-writable and searchable. A
 * step can leave read-only directories behind — `GOMODCACHE=$PWD/.gomodcache go mod download`
 * leaves 0555 ones — and `clean` cannot empty those, which would make the put-back fail. Never
 * through a link: an entry reached through one is skipped (`noLinkTo`), links found inside are not
 * followed (`lstat`), so nothing outside the checkout changes mode. A mode that cannot be changed
 * (another owner's) is left for `clean` to report.
 */
async function unlockUntracked(git: Git, dir: string): Promise<void> {
  const top = await realpath(dir);
  const listed = await git(dir, "ls-files", "-z", "--others", "--exclude-standard", "--directory");
  for (const entry of listed.split("\0")) {
    const rel = entry.replace(/\/+$/, "");
    if (rel === "" || !(await noLinkTo(top, rel))) continue;
    // The directories on its way, the checkout's top included: removing an entry writes its parent.
    const parts = rel.split("/");
    for (let i = 0; i < parts.length; i++) await ownerWritable(join(top, ...parts.slice(0, i)));
    await makeRemovable(join(top, rel));
  }
}

/** `path`, when it is a directory and not a link, made owner-readable, -writable and -searchable. */
async function ownerWritable(path: string): Promise<boolean> {
  const found = await lstat(path).catch(() => null);
  if (found === null || !found.isDirectory()) return false;
  if ((found.mode & 0o700) !== 0o700) {
    await chmod(path, (found.mode & 0o7777) | 0o700).catch(() => {});
  }
  return true;
}

/** `ownerWritable` for `path` and every directory below it; links are never followed. */
async function makeRemovable(path: string): Promise<void> {
  if (!(await ownerWritable(path))) return;
  for (const entry of await readdir(path).catch(() => [])) await makeRemovable(join(path, entry));
}

/**
 * The config keys `DriverStart.config` keeps: those that define filter drivers, or bring
 * definitions (an include) or attributes (`core.attributesFile`, a config file
 * `extensions.worktreeConfig` turns on) in from elsewhere. A POSIX extended regex, as git reads
 * it; keys are listed with their section and variable lower-cased.
 */
const DRIVER_KEYS =
  "^(filter|include|includeif)\\.|^core\\.attributesfile$|^extensions\\.worktreeconfig$";
/** The keys `DriverStart.effective` keeps: what the drivers and the attributes file come to. */
const EFFECTIVE_KEYS = "^filter\\.|^core\\.attributesfile$";
/** The largest `info/attributes` whose bytes the snapshot keeps (`AttributesStart`). */
const ATTRIBUTES_MAX = 1024 * 1024;

/** What decides a repository's filter drivers now (`DriverStart`). `git config` runs nothing. */
async function driverStart(git: Git, dir: string, where: RepoPlace): Promise<DriverStart> {
  return {
    config: await driverConfig(git, dir, join(where.commonDir, "config")),
    effective: await effectiveDrivers(git, dir),
    attributes: await attributesAt(join(where.commonDir, "info", "attributes")),
  };
}

/** The `DRIVER_KEYS` entries of the config file `file`, includes not followed, as `-z` lists
 * them; empty when there are none (or the file cannot be read). */
async function driverConfig(git: Git, dir: string, file: string): Promise<string> {
  return await git(
    dir,
    "config",
    "-z",
    "--no-includes",
    "--file",
    file,
    "--get-regexp",
    DRIVER_KEYS,
  )
    .catch(() => "");
}

/** The `EFFECTIVE_KEYS` entries git reads in the repository at `dir`, includes followed. */
async function effectiveDrivers(git: Git, dir: string): Promise<string> {
  return await git(dir, "config", "-z", "--includes", "--get-regexp", EFFECTIVE_KEYS)
    .catch(() => "");
}

/** `git config -z` output as `[key, value]` pairs; a key with no `=` has a null value. */
function configEntries(out: string): Array<[string, string | null]> {
  return out.split("\0").filter((entry) => entry !== "").map((entry) => {
    const newline = entry.indexOf("\n");
    return newline < 0 ? [entry, null] : [entry.slice(0, newline), entry.slice(newline + 1)];
  });
}

/** `path` as `AttributesStart` describes it, never through a link. */
async function attributesAt(path: string): Promise<AttributesStart> {
  const found = await lstat(path).catch(() => null);
  if (found === null) return { kind: "absent" };
  if (found.isFile() && found.size <= ATTRIBUTES_MAX) {
    return { kind: "bytes", bytes: new Uint8Array(await readFile(path)) };
  }
  let signature = `mode ${found.mode}`;
  if (found.isSymbolicLink()) signature = `link ${await readlink(path)}`;
  else if (found.isFile()) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    signature = `file ${hash.digest("hex")}`;
  }
  return { kind: "opaque", signature };
}

function sameAttributes(a: AttributesStart, b: AttributesStart): boolean {
  if (a.kind === "absent" || b.kind === "absent") return a.kind === b.kind;
  if (a.kind === "opaque" || b.kind === "opaque") {
    return a.kind === "opaque" && b.kind === "opaque" && a.signature === b.signature;
  }
  return a.bytes.length === b.bytes.length && a.bytes.every((byte, i) => byte === b.bytes[i]);
}

/**
 * Returns a FAILED repository's filter drivers, and every submodule's below it, to the start —
 * before any git command that could run one: a step can write `filter.<name>.smudge = <command>`
 * (or a changed command for the repository's own driver) into `.git/config` and
 * `x filter=<name>` into `.git/info/attributes`, and the status, checkout and reset that put a
 * tree back would run it — git-lfs's would dial out, with no timeout. A non-idempotent one a
 * step added (`git-crypt unlock`) would also leave a tree put back with it off reading as
 * modified to a status with it on. Once this has run, no driver a failed step authored is left
 * to run, and put-back's plain git commands run exactly the drivers the repository started with,
 * as main does, so the content they write and the status that checks it agree.
 *
 * Only `git config` and plain file operations, which run no driver, in every repository a
 * status would read: the checkout and each submodule checked out at the start, back to the
 * snapshot (`restoreDriverState`); and each repository checked out now at a gitlink of the index
 * or of the start commit that was not checked out then — a step's `git submodule update --init`
 * — back to no drivers at all, as it had none at the start: a superproject's status reads it
 * through its own config. That clone stays (and, checked out cleanly, so does its tree, as
 * `restoreSubmodules` says) when it is where git puts one, its git dir under the superproject's
 * `modules/` or its own `.git`; anywhere else its config is no file put-back writes, and the
 * checkout is removed outright instead (`uncheckout`). Throws when a submodule checked out at the
 * start is no longer the repository it was (`assertPlace`), or when a repository's drivers do not
 * come back.
 */
async function restoreDrivers(git: Git, dir: string, start: CheckoutStart): Promise<boolean> {
  return await restoreDriversIn(git, dir, start, start.drivers, "the checkout", "");
}

async function restoreDriversIn(
  git: Git,
  dir: string,
  start: { sha: string; where: RepoPlace; submodules: readonly SubmoduleStart[] },
  drivers: DriverStart,
  what: string,
  prefix: string,
): Promise<boolean> {
  let changed = await restoreDriverState(git, dir, start.where, drivers, what);
  const paths = new Set([
    ...start.submodules.map((sub) => sub.path),
    ...(await gitlinks(git, dir, start.sha)).keys(),
  ]);
  for (const path of paths) {
    // What git would not take for a submodule checkout (one reached through a link, a directory
    // with no `.git`) is read by no status as one.
    if (!(await noLinkTo(dir, path)) || !(await exists(join(dir, path, ".git")))) continue;
    const sub = start.submodules.find((s) => s.path === path);
    const name = `${prefix}${path}`;
    const subDir = join(dir, path);
    if (sub?.where && sub.drivers) {
      await assertPlace(git, subDir, sub.where, `submodule ${name}`);
      const own = await restoreDriversIn(
        git,
        subDir,
        { sha: sub.sha, where: sub.where, submodules: sub.submodules },
        sub.drivers,
        `submodule ${name}`,
        `${name}/`,
      );
      changed = own || changed;
      continue;
    }
    const place = await placeOf(git, subDir);
    const top = await realpath(subDir);
    if (
      place !== null && place.top === top &&
      (place.commonDir.startsWith(`${join(start.where.gitDir, "modules")}/`) ||
        place.commonDir === join(top, ".git"))
    ) {
      const own = await restoreDriversIn(
        git,
        subDir,
        // Its own submodules were not checked out at the start either.
        { sha: sub?.sha ?? "HEAD", where: place, submodules: [] },
        NO_DRIVERS,
        `submodule ${name}`,
        `${name}/`,
      );
      changed = own || changed;
    } else {
      await uncheckout(dir, path, start.where.gitDir, sub ?? null);
      changed = true;
    }
  }
  return changed;
}

/** What a repository not checked out at the start goes back to: no drivers, no attributes. */
const NO_DRIVERS: DriverStart = { config: "", effective: "", attributes: { kind: "absent" } };

/**
 * One repository's driver config (`DriverStart.config`, in its config file) and
 * `info/attributes` back to the start, written only where they changed; then the drivers git
 * reads there checked against the start (`DriverStart.effective`), so a driver a step defined
 * somewhere this does not restore (a config file an `onbranch` include picks by the branch a step
 * left) is never run: that is an error instead. Where anything changed, the index's stat info is
 * no longer trusted (`distrustIndex`).
 *
 * Key by key: only a key whose values differ from the start is touched — every value unset, the
 * start's added back in order (`-z` reads, `--add` writes, `--end-of-options` before each key).
 * Every other key stays where it is in the file, which matters: config is read top to bottom, so
 * an `[include]` moved below the settings after it would change what they come to. A step that
 * only added a driver has that driver's keys removed and nothing else written. A key the step
 * changed comes back at the end of its section (a new one at the end of the file, when git
 * dropped the section it emptied) — for an include, a place that can change precedence; the
 * effective check after still holds for the drivers. A key the start had with no value at all
 * (`required` alone, which git reads as true) cannot be written so: untouched, it stays as it
 * was; rewritten, it comes back as `true`, which the effective check reads as the same.
 */
async function restoreDriverState(
  git: Git,
  dir: string,
  where: RepoPlace,
  start: DriverStart,
  what: string,
): Promise<boolean> {
  const file = join(where.commonDir, "config");
  let changed = false;
  const now = await driverConfig(git, dir, file);
  if (now !== start.config) {
    // git writes a config through a link, to wherever it points.
    if ((await lstat(file).catch(() => null))?.isSymbolicLink()) {
      throw new Error(`${what}: its config file is a link, and nothing is written through it`);
    }
    const want = valuesByKey(start.config);
    const have = valuesByKey(now);
    for (const key of new Set([...have.keys(), ...want.keys()])) {
      const values = want.get(key) ?? [];
      const found = have.get(key) ?? [];
      if (values.length === found.length && values.every((value, i) => value === found[i])) {
        continue;
      }
      if (found.length > 0) {
        await git(dir, "config", "--file", file, "--unset-all", "--end-of-options", key);
      }
      for (const value of values) {
        await git(dir, "config", "--file", file, "--add", "--end-of-options", key, value ?? "true");
      }
      changed = true;
    }
  }
  changed = (await restoreAttributes(where.commonDir, start.attributes, what)) || changed;
  if (changed) await distrustIndex(where.gitDir);
  if (!sameDrivers(await effectiveDrivers(git, dir), start.effective)) {
    throw new Error(
      `${what}: its filter drivers could not be put back to how they started (a setup step ` +
        "defined them where put-back does not restore), and a failed step's driver never runs",
    );
  }
  return changed;
}

/** `git config -z` output as key → its values in order (null for a key with no value). */
function valuesByKey(out: string): Map<string, Array<string | null>> {
  const keys = new Map<string, Array<string | null>>();
  for (const [key, value] of configEntries(out)) {
    const values = keys.get(key);
    if (values === undefined) keys.set(key, [value]);
    else values.push(value);
  }
  return keys;
}

/** Whether two `effectiveDrivers` listings say the same: each key's values in order, a key with
 * no value read as `true` (what git makes of it, and what `restoreDriverState` writes back for
 * one). Not the order of different keys, which tells git nothing here and moves when a key is
 * rewritten. */
function sameDrivers(a: string, b: string): boolean {
  const flat = (out: string) =>
    [...valuesByKey(out)].map(([key, values]) =>
      [key, ...values.map((value) => value ?? "true")].join("\n")
    ).sort().join("\0");
  return flat(a) === flat(b);
}

/**
 * Makes git compare the content of every file the index at `gitDir` tracks on its next read,
 * rather than trusting stat info: the index's own time is set back to the first second of 1970,
 * so every entry is racily clean to git — as one written in the same second as the index is —
 * and checked through the drivers configured now. A step's driver wrote some files (`git-crypt
 * unlock` checks out plaintext) and the index took their stat info then; with the driver gone,
 * the status would read them as unchanged, and they would stay holding what no driver now makes
 * of the stored blob. Not the epoch itself: git reads a zero index time as no time at all.
 */
async function distrustIndex(gitDir: string): Promise<void> {
  const index = join(gitDir, "index");
  if (!(await lstat(index).catch(() => null))?.isFile()) return;
  const longAgo = new Date(1000);
  await utimes(index, longAgo, longAgo);
}

/** `info/attributes` in the git dir `commonDir` back to `start`; whether it changed. Throws when
 * it changed and the start kept only a signature, or `info` is no longer a directory. */
async function restoreAttributes(
  commonDir: string,
  start: AttributesStart,
  what: string,
): Promise<boolean> {
  const info = join(commonDir, "info");
  const path = join(info, "attributes");
  if (sameAttributes(await attributesAt(path), start)) return false;
  if (start.kind === "opaque") {
    throw new Error(
      `${what}: its info/attributes changed, and was too large (or not a file) to keep a copy ` +
        "of at the start, so it cannot be put back",
    );
  }
  const found = await lstat(info).catch(() => null);
  if (found !== null && !found.isDirectory()) {
    throw new Error(`${what}: its info/ is no longer a directory, and nothing is written there`);
  }
  if (found !== null) await ownerWritable(info);
  // A link is removed itself, never followed.
  await rm(path, { recursive: true, force: true });
  if (start.kind === "bytes") {
    await mkdir(info, { recursive: true });
    await writeFile(path, start.bytes, { flag: "wx" });
  }
  return true;
}

/** Path → recorded commit for every gitlink of the commit `sha` in the repository at `dir`, and
 * of its index (a step can drop one from the index that a checkout of `sha` brings back, or add
 * one); the commit's record wins. Runs no driver. */
async function gitlinks(git: Git, dir: string, sha: string): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  const tree = await git(dir, "ls-tree", "-r", "-z", sha).catch(() => "");
  const index = await git(dir, "ls-files", "-z", "--stage").catch(() => "");
  // `<mode> commit <id>\t<path>` from ls-tree; `<mode> <id> <stage>\t<path>` from ls-files.
  for (const [out, field] of [[tree, 2], [index, 1]] as const) {
    for (const entry of out.split("\0")) {
      if (!entry.startsWith("160000 ")) continue;
      const tab = entry.indexOf("\t");
      const path = entry.slice(tab + 1);
      if (!links.has(path)) links.set(path, entry.slice(0, tab).split(" ")[field]);
    }
  }
  return links;
}

/** Whether `rel` under the directory `root` is reached without a link on the way (the last part
 * itself may be one: removing it removes the link). False when the way there does not exist. */
async function noLinkTo(root: string, rel: string): Promise<boolean> {
  const parent = await realpath(dirname(join(root, rel))).catch(() => null);
  return parent !== null && parent === join(await realpath(root), dirname(rel));
}

async function assertNoLinkTo(root: string, rel: string): Promise<void> {
  if (!(await noLinkTo(root, rel))) {
    throw new Error(`${rel} is reached through a link, and nothing is removed through it`);
  }
}

/**
 * Where the git here would lazily fetch, refuses: a step can make a repository a partial clone
 * (`extensions.partialClone`, `remote.<name>.promisor`), and then any object it lacks is fetched
 * the moment a command reads it — dialing out, or running a `remote.<name>.uploadpack` the step
 * configured, with no timeout. `GIT_NO_LAZY_FETCH` (git_exec.ts) turns that off from git 2.44; an
 * older git ignores it, so there a partial clone is not put back at all.
 */
async function refuseLazyFetch(git: Git, dir: string, what: string): Promise<void> {
  if (await lazyFetchOff(git)) return;
  const partial = await git(dir, "config", "--get", "extensions.partialclone").catch(() => "");
  const promisor = await git(
    dir,
    "config",
    "--type=bool",
    "--get-regexp",
    "^remote\\..*\\.promisor$",
  ).catch(() => "");
  if (partial !== "" || promisor.split("\n").some((line) => line.endsWith(" true"))) {
    throw new Error(
      `${what} is a partial clone, and the git here is older than 2.44, which would fetch what ` +
        "it lacks; nothing is fetched",
    );
  }
}

/** Whether the git here honours `GIT_NO_LAZY_FETCH` (2.44 and later). */
function lazyFetchOff(git: Git): Promise<boolean> {
  return gitAtLeast(git, 2, 44);
}

const gitVersions = new WeakMap<Git, Promise<readonly [number, number] | null>>();
/** Whether the git `git` runs is at least `major.minor`; false when its version cannot be read.
 * Asked once per executor (`git version`). */
async function gitAtLeast(git: Git, major: number, minor: number): Promise<boolean> {
  let version = gitVersions.get(git);
  if (version === undefined) {
    version = git(tmpdir(), "version").then((out) => {
      const m = /version (\d+)\.(\d+)/.exec(out);
      return m === null ? null : [Number(m[1]), Number(m[2])] as const;
    }, () => null);
    gitVersions.set(git, version);
  }
  const found = await version;
  return found !== null && (found[0] > major || (found[0] === major && found[1] >= minor));
}

/**
 * The submodule paths `git status` reports as changed in the repository at `dir`, in porcelain
 * v2 (which marks a submodule entry `S…`): what the repo's `ignore` settings show
 * (`STATUS_PORCELAIN`), and every one whose commit moved (`MOVED_GITLINKS`).
 */
async function changedSubmodules(git: Git, dir: string): Promise<string[]> {
  const paths: string[] = [];
  for (const listing of [STATUS_PORCELAIN, MOVED_GITLINKS]) {
    const entries = (await git(dir, ...listing, "--porcelain=v2", "-z")).split("\0");
    for (let i = 0; i < entries.length; i++) {
      const fields = entries[i].split(" ");
      // `1 XY sub mH mI mW hH hI path`; `2 …` has a score before the path and the original path
      // in the entry after it; `u XY sub m1 m2 m3 mW h1 h2 h3 path`.
      const before = fields[0] === "1" ? 8 : fields[0] === "2" ? 9 : fields[0] === "u" ? 10 : null;
      if (fields[0] === "2") i++;
      if (before === null || !fields[2]?.startsWith("S")) continue;
      const path = fields.slice(before).join(" ");
      if (!paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

/**
 * How `putBack` treats a checkout's filter drivers. `failed`: a setup step failed, in this
 * checkout or in any other repository of the run (a failed step may have written another
 * repository's config as well as its tree), so nothing it configured may run — the drivers and
 * attributes go back to the start first (`restoreDrivers`), before any git command that could
 * run one, and the tree is put back with the drivers it started with. Otherwise (no step failed
 * anywhere, and a successful setup left the tree changed): the config stays as setup left it — a
 * successful `git-crypt unlock` stays unlocked — and the tree is put back with it, as main's
 * dirty check reads it.
 */
export interface PutBackOptions {
  failed: boolean;
}

/**
 * `restoreCheckout` when the checkout departs from `start`, then the check that it worked — for a
 * `failed` checkout after its drivers are back to the start (`PutBackOptions`). Returns whether
 * anything was put back (drivers included); throws, naming what is left, when the tree still
 * departs — a setup failure is a warning only while the run (or the image) starts from a clean
 * tree — or when git no longer finds the checkout's own repository there.
 */
export async function putBack(
  git: Git,
  dir: string,
  start: CheckoutStart,
  opts: PutBackOptions,
): Promise<boolean> {
  let drivers = false;
  if (opts.failed) {
    await assertPlace(git, dir, start.where, "the checkout");
    try {
      drivers = await restoreDrivers(git, dir, start);
    } catch (err) {
      throw new Error(
        `what setup left could not be discarded (${errorMessage(err)}), and a tree in that ` +
          "state must not ship as a run's work",
      );
    }
  }
  const found = await departures(git, dir, start);
  if (found.length === 0) return drivers;
  let unrestored: string[];
  try {
    unrestored = await restoreCheckout(git, dir, start);
  } catch (err) {
    // git refusing (a ref lock a killed step left, say) names neither what was left nor why it
    // matters: say both, and git's own reason.
    throw new Error(
      `what setup left could not be discarded (${found.join("; ")}): ${errorMessage(err)}; a ` +
        "tree in that state must not ship as a run's work",
    );
  }
  const left = await departures(git, dir, start);
  if (left.length > 0) {
    throw new Error(
      `what setup left could not be discarded (${[...left, ...unrestored].join("; ")}), and a ` +
        "tree in that state must not ship as a run's work",
    );
  }
  return true;
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false);
}

/**
 * The mechanical staleness check behind a memory's evidence: which of `paths` changed between
 * the commit a claim was observed at and this checkout's HEAD. `null` when the commit is not
 * in this clone — a rewritten history, a different fork, a shallow fetch — which is "cannot
 * tell", never "stale". Paths are handed to git as pathspecs after `--`, so a path can never
 * read as an option — and with `--literal-pathspecs` they cannot read as pathspec MAGIC either:
 * without it, `:/` alone means "the whole repository" and `:(exclude)x` means "not x", so one
 * crafted path in a memory's evidence could make every run on the repo look stale (or look
 * clean). The flag makes every pathspec a plain path, whatever it starts with. The spec schema
 * refuses ':' and '-' as well; this is the half that holds inside the process.
 */
export async function changedSince(
  git: Git,
  dir: string,
  sha: string,
  paths: string[],
): Promise<string[] | null> {
  try {
    await git(dir, "cat-file", "-e", `${sha}^{commit}`);
  } catch {
    return null;
  }
  const out = await git(
    dir,
    "--literal-pathspecs",
    "diff",
    "--name-only",
    `${sha}..HEAD`,
    "--",
    ...paths,
  );
  return out === "" ? [] : out.split("\n").filter((line) => line !== "");
}

/** Commits in this checkout are authored as the agent, by the harness and by finalize alike. */
export async function configureIdentity(
  git: Git,
  dir: string,
  agent: AgentIdentity,
): Promise<void> {
  await git(dir, "config", "user.name", agent.name);
  await git(dir, "config", "user.email", agent.email);
}

/**
 * Installs a commit-msg hook so EVERY commit made in this checkout carries the run-traceability trailer —
 * the harness's own commits (some CLIs commit as they work) as well as the core's leftover commit.
 * The id is written to a sidecar file the hook reads,
 * so no caller-supplied value is interpolated into the script.
 * Idempotent per commit: the trailer is added only if absent.
 *
 * Installed in TWO directories, because the two processes that commit in this checkout read
 * different ones. The runner's own git runs with `core.hooksPath` pointed at a directory outside
 * the checkout (helpers/git_exec.ts), so that a hook the repo's setup steps or the agent wrote in
 * `.git/hooks` cannot stop finalize's commit — the trailer has to live there to reach it. The
 * harness commits with plain git, which reads `.git/hooks`, git's default and always present in
 * a standard clone. The agent can of course delete its copy — it writes its own commit messages
 * either way.
 */
export async function installRunTrailer(
  dir: string,
  runId: string,
): Promise<void> {
  const idFile = `${CODENAME}-run-id`;
  const script = "#!/bin/sh\n" +
    `id=$(cat "$(dirname "$0")/${idFile}")\n` +
    `git interpret-trailers --if-exists doNothing --trailer "${RUN_TRAILER}: $id" --in-place "$1"\n`;
  for (const hooks of [gitHooksDir(), `${dir}/.git/hooks`]) {
    await writeFile(`${hooks}/${idFile}`, runId);
    await writeFile(`${hooks}/commit-msg`, script, { mode: 0o755 });
  }
}

/** Stages and commits everything.
 * The run-traceability trailer is added by the commit-msg hook (see `installRunTrailer`),
 * so it lands on this commit and on any the harness made. */
export async function commitAll(
  git: Git,
  dir: string,
  subject: string,
): Promise<void> {
  await git(dir, "add", "-A");
  await git(dir, "commit", "-m", subject);
}

/**
 * New commits on `ref` (HEAD by default) since `baseSha`, oldest first. First-parent only: a
 * merge of the target (`update_from_base`) is ONE commit of the run's, and what it brought in
 * from the target is not — listing it would credit the run with every commit it caught up on.
 */
export async function commitsSince(
  git: Git,
  dir: string,
  baseSha: string,
  ref = "HEAD",
): Promise<CommitInfo[]> {
  const out = await git(
    dir,
    "log",
    "--first-parent",
    "--reverse",
    "--format=%H%x09%s",
    "--end-of-options",
    `${baseSha}..${ref}`,
  );
  if (out === "") return [];
  return out.split("\n").map((line) => {
    const [sha, ...subject] = line.split("\t");
    return { sha, subject: subject.join("\t") };
  });
}

/** The tip of a local branch. */
export async function branchSha(git: Git, dir: string, branch: string): Promise<string> {
  return await git(dir, "rev-parse", `refs/heads/${branch}`);
}

/**
 * Whether `ancestor` is contained in `ref`'s history. `git merge-base --is-ancestor` says so by
 * its exit status alone.
 */
export async function isAncestor(
  git: Git,
  dir: string,
  ancestor: string,
  ref: string,
): Promise<boolean> {
  try {
    await git(dir, "merge-base", "--is-ancestor", "--end-of-options", ancestor, ref);
    return true;
  } catch {
    return false;
  }
}

/**
 * The slice of the `Diagnostics` port the merge-tree reads warn through, declared here so
 * helpers stay inside the dependency fence. Structural: any real `Diagnostics` satisfies it.
 */
export interface GitWarnings {
  warn(event: string, fields?: Record<string, unknown>): void;
}

/**
 * A merge-tree that exits 1 answered: the two sides conflict. So did one that refused two
 * histories with nothing in common (exit 128, git's own words): they share no change to hold.
 * Anything else is git failing to answer — a git older than 2.40, which has no `merge-tree
 * --merge-base` (exit 129), a missing object — which the callers read as a no too, but never
 * silently.
 */
function warnUnanswered(diag: GitWarnings | undefined, err: unknown): void {
  const said = String(err);
  if (/ failed \(exit 1\):/.test(said)) return;
  if (/ failed \(exit 128\):.*refusing to merge unrelated histories/.test(said)) return;
  diag?.warn("git.merge_tree_unanswered", { err: String(err) });
}

/**
 * Whether `ref` already holds the changes `other` brings: `other` is in its history, or merging
 * `other` into it (in memory, `git merge-tree`: no ref, index or file is touched) is clean and
 * changes nothing. The second is how a squash or a rebase merge, which leaves the merged commits
 * out of the history, is seen to have landed. Merged from `opts.from` when given, else from
 * where the two meet. A conflict, or a git that cannot say (warned through `opts.diag`), is a
 * no.
 */
async function holdsChanges(
  git: Git,
  dir: string,
  ref: string,
  other: string,
  opts: { from?: string; diag?: GitWarnings } = {},
): Promise<boolean> {
  if (await isAncestor(git, dir, other, ref)) return true;
  const from = opts.from === undefined ? [] : [`--merge-base=${opts.from}`];
  try {
    const merged = await git(
      dir,
      "merge-tree",
      "--write-tree",
      "--no-messages",
      ...from,
      ref,
      other,
    );
    return merged.split("\n")[0] === await git(dir, "rev-parse", `${ref}^{tree}`);
  } catch (err) {
    warnUnanswered(opts.diag, err);
    return false;
  }
}

/**
 * Whether merging `commit`'s own change (against `parent`) into `ref` is clean and changes
 * nothing: the change is in `ref` already, wherever it sits in its history. A conflict, or a
 * git that cannot say, is a no.
 */
async function changeIn(
  git: Git,
  dir: string,
  ref: string,
  commit: string,
  parent: string,
  diag: GitWarnings | undefined,
): Promise<boolean> {
  try {
    const merged = await git(
      dir,
      "merge-tree",
      "--write-tree",
      "--no-messages",
      `--merge-base=${parent}`,
      ref,
      commit,
    );
    return merged.split("\n")[0] === await git(dir, "rev-parse", `${ref}^{tree}`);
  } catch (err) {
    warnUnanswered(diag, err);
    return false;
  }
}

/**
 * Whether the patch (`patch.head`, built on `patch.base`) carries ALL of `earlier`'s own work:
 * its commits past every commit in `earlier.past` (its base, then the head that landed of its
 * generation, oldest first), past `patch.base`, which already holds whatever of it is there, and past
 * `upstream` (the target as the clone knows it), so what a merge of the target brought in is not
 * counted as the agent's. Every parent is followed: a side branch of the agent's own, merged into
 * `earlier`, is its work too. An `earlier` with no commit of its own carries nothing to anyone:
 * false.
 *
 * Carried when either holds:
 * - the whole head: merging `earlier` into the patch is clean and changes nothing
 *   (`holdsChanges`), measured from the newest of `earlier.past` (what landed, else its base)
 *   unless the two heads meet later than that, then from where they meet. Measured from
 *   anywhere older, a later commit of `earlier` that undid some of its own work (a debug line
 *   dropped) would read as nothing to carry, though the patch still holds that work, as a
 *   squash of only the landed head leaves it. This is what sees an agent that squashed its own
 *   commits between submits,
 *   and the only rule for an `earlier` with a merge commit of its own that holds a change of its
 *   own (a conflict resolved in a merge of the target): a merge has no single parent to measure
 *   its change from.
 * - commit by commit: each own commit is in the patch's history, or its change (against its
 *   parent) merges into the patch's head to nothing, or it is a merge that is git's own clean
 *   merge of its parents, which brings nothing of its own. A commit the agent dropped, or
 *   amended to hold more, is none of these.
 *
 * Never by who wrote a commit, when, or what its message says: an amend keeps all three. What
 * it cannot see: a revert inside the patch's range of a change the patch's history holds still
 * counts as carried by that history, and so does an earlier head's removal a later patch undid:
 * both rules are one-way on purpose, since a later patch that edits the same
 * files further still carries the earlier work, and a carry only credits memory claims, never
 * decides what ships or is skipped. And a rebase whose conflict the agent resolved by
 * rewriting the earlier head's own lines is not carried: the patch holds the new version, not
 * the old one, so a claim bound to the earlier patch waits for that patch's own fate.
 *
 * Both rules are git's answers in the agent's own checkout, which the runner shares with the
 * agent: its config and attributes (a merge driver, say) can shape what the merge-trees find. A
 * carry is the runner's attestation, not the forge's, and an agent that games it can only credit
 * claims of its own run.
 */
export async function carriesWork(
  git: Git,
  dir: string,
  earlier: { head: string; past: string[] },
  patch: { head: string; base: string },
  upstream: string[] = [],
  diag?: GitWarnings,
): Promise<boolean> {
  const not = ["--not", ...earlier.past, patch.base, ...upstream, "--"];
  // Each own commit with its parents: `<sha> <parent>...`.
  const own = (await git(dir, "rev-list", "--parents", earlier.head, ...not))
    .split("\n").filter((l) => l !== "").map((l) => l.split(" "));
  if (own.length === 0) return false;
  const from = await wholeHeadBase(git, dir, patch.head, earlier.head, earlier.past.at(-1), diag);
  if (await holdsChanges(git, dir, patch.head, earlier.head, { from, diag })) return true;
  for (const [commit, ...parents] of own) {
    if (await isAncestor(git, dir, commit, patch.head)) continue;
    if (parents.length === 1) {
      if (!await changeIn(git, dir, patch.head, commit, parents[0], diag)) return false;
      continue;
    }
    // A merge that is git's own clean merge of its parents brings no change of its own (a merge
    // of the target, say): nothing to carry. One with a resolution or edits in it, or a root
    // with no parent to measure from, is the whole-head rule's alone, and it said no.
    if (
      parents.length !== 2 || !await cleanMerge(git, dir, commit, parents[0], parents[1], diag)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Where the whole-head rule measures `earlier` from: `bound` when it is past where `earlier`
 * and `patch` meet, else where they meet (undefined: git's own, which combines several meeting
 * points itself): whichever is later, so what is measured is only what `earlier` did past
 * both.
 */
async function wholeHeadBase(
  git: Git,
  dir: string,
  patch: string,
  earlier: string,
  bound: string | undefined,
  diag: GitWarnings | undefined,
): Promise<string | undefined> {
  if (bound === undefined) return undefined;
  let meets: string[];
  try {
    meets = (await git(dir, "merge-base", "--all", patch, earlier))
      .split("\n").filter((l) => l !== "");
  } catch (err) {
    // Nothing in common (exit 1): only the bound can measure it. Anything else
    // is git failing to answer, measured the same way, but never silently.
    if (!/ failed \(exit 1\):/.test(String(err))) {
      diag?.warn("git.merge_base_unanswered", { err: String(err) });
    }
    return bound;
  }
  for (const meet of meets) {
    if (!await isAncestor(git, dir, bound, meet)) return bound;
  }
  return undefined;
}

/** Whether `commit`'s tree is git's clean merge of `ours` and `theirs`: a merge that holds
 * nothing of its own. A conflict, or a git that cannot say, is a no. */
async function cleanMerge(
  git: Git,
  dir: string,
  commit: string,
  ours: string,
  theirs: string,
  diag: GitWarnings | undefined,
): Promise<boolean> {
  try {
    const merged = await git(dir, "merge-tree", "--write-tree", "--no-messages", ours, theirs);
    return merged.split("\n")[0] === await git(dir, "rev-parse", `${commit}^{tree}`);
  } catch (err) {
    warnUnanswered(diag, err);
    return false;
  }
}

/** What a clone is stopped in the middle of, if anything: a rebase or `git am`, a merge, a
 * cherry-pick or revert (one step or a sequence), a bisect, an index still holding unmerged
 * entries, or a HEAD that is not on the run's branch. */
export type StoppedStep =
  | "rebase"
  | "am"
  | "merge"
  | "cherry-pick"
  | "revert"
  | "bisect"
  | "conflict"
  | "off-branch";

/**
 * Whether the clone holds a stopped operation — git's own markers, unmerged index entries (a
 * `stash pop` that conflicted leaves no other mark), or a HEAD off `branch` (detached, or on
 * another branch: a commit there would never reach the branch that ships). Reads only.
 *
 * Off the run's branch nothing is concludable: whatever is in progress there is answered as a
 * stop (labelled with the operation, or `off-branch`), a resolved merge included — concluding it
 * would commit where nothing ships. On the branch, `concludable` marks a single-step
 * cherry-pick or revert with nothing conflicted, no sequence behind it and something staged —
 * what git's own commit concludes; a resolved merge there answers null (it is concluded like any
 * staged work).
 */
export async function stoppedStep(
  git: Git,
  dir: string,
  branch: string,
): Promise<{ step: StoppedStep; conflicts: string[]; concludable: boolean } | null> {
  const conflicts = await conflictedPaths(git, dir);
  const marked = async (file: string) =>
    await stat(`${dir}/.git/${file}`).then(() => true, () => false);
  const onBranch = await currentBranch(git, dir) === branch;
  const staged = async () =>
    (await git(dir, "diff", "--cached", "--name-only").catch(() => "")) !== "";
  let step: StoppedStep | null = null;
  let concludable = false;
  if (await marked("rebase-apply/applying")) step = "am";
  else if (await rebaseInProgress(dir)) step = "rebase";
  else if (await marked("sequencer")) {
    // A sequence of picks (or reverts) the agent started: stopped, whatever the step in hand.
    const todo = await readFile(`${dir}/.git/sequencer/todo`, "utf8").catch(() => "");
    step = /^\s*revert\b/m.test(todo) && !/^\s*pick\b/m.test(todo) ? "revert" : "cherry-pick";
  } else if (await marked("CHERRY_PICK_HEAD")) {
    step = "cherry-pick";
    concludable = conflicts.length === 0 && await staged();
  } else if (await marked("REVERT_HEAD")) {
    step = "revert";
    concludable = conflicts.length === 0 && await staged();
  } else if (await mergeInProgress(dir)) {
    if (conflicts.length > 0 || !onBranch) step = "merge";
  } else if (await marked("BISECT_LOG")) step = "bisect";
  else if (conflicts.length > 0) step = "conflict";
  if (!onBranch) return { step: step ?? "off-branch", conflicts, concludable: false };
  return step === null ? null : { step, conflicts, concludable };
}

/** Concludes a resolved cherry-pick or revert with git's own commit and message. */
export async function concludePick(git: Git, dir: string): Promise<void> {
  await git(dir, "-c", "core.editor=true", "commit", "--no-edit");
}

/**
 * Whether a rebase is in progress in this clone — git's own marker directories, one per rebase
 * backend. The agent's own, which a submit refuses to cut a bundle over.
 */
export async function rebaseInProgress(dir: string): Promise<boolean> {
  for (const marker of [`${dir}/.git/rebase-merge`, `${dir}/.git/rebase-apply`]) {
    try {
      if ((await stat(marker)).isDirectory()) return true;
    } catch {
      // absent
    }
  }
  return false;
}

/** Whether a merge stopped here and is waiting to be concluded — `MERGE_HEAD` is git's marker. */
export async function mergeInProgress(dir: string): Promise<boolean> {
  try {
    return (await stat(`${dir}/.git/MERGE_HEAD`)).isFile();
  } catch {
    return false;
  }
}

/**
 * Merges `sha` into the checked-out branch, with `message` as the merge commit's. Answers the
 * conflicting paths when the merge stops, leaving it in progress for whoever will resolve it;
 * `[]` when it went through. Always a merge commit (`--no-ff`): on a change request's branch
 * a fast-forward would silently turn it into its target. `--no-edit` and the editor both,
 * since nobody is at a terminal.
 */
export async function mergeCommit(
  git: Git,
  dir: string,
  sha: string,
  message: string,
): Promise<string[]> {
  try {
    await git(dir, "-c", "core.editor=true", "merge", "--no-ff", "--no-edit", "-m", message, sha);
    return [];
  } catch (err) {
    const conflicts = await conflictedPaths(git, dir);
    if (conflicts.length > 0) return conflicts;
    // Stopped for a reason that is not a conflict (an untracked file in the way, say): nothing
    // to hand the agent, so the merge is undone and the machinery's failure named.
    if (await mergeInProgress(dir)) await git(dir, "merge", "--abort").catch(() => {});
    throw err;
  }
}

/** Concludes a stopped merge whose conflicts are resolved and staged, with the message git
 * prepared for it. */
export async function concludeMerge(git: Git, dir: string): Promise<void> {
  await git(dir, "-c", "core.editor=true", "commit", "--no-edit");
}

/** The paths still carrying conflict markers in the index — what the agent has to resolve.
 * NUL-separated, so a name outside ASCII comes back as itself rather than C-quoted. */
export async function conflictedPaths(git: Git, dir: string): Promise<string[]> {
  const out = await git(dir, "diff", "--name-only", "-z", "--diff-filter=U");
  return out.split("\0").filter((path) => path !== "");
}

/** The branch HEAD is on, bare — null for a detached HEAD. */
export async function currentBranch(git: Git, dir: string): Promise<string | null> {
  try {
    return (await git(dir, "symbolic-ref", "--quiet", "HEAD")).replace(/^refs\/heads\//, "");
  } catch {
    return null;
  }
}

/**
 * The branch the checkout is working on: the one HEAD is on, or — while a rebase has HEAD
 * detached — the one that rebase is rewriting, as git's own state names it. Null for a HEAD
 * detached by anything else. As git names it, which can be any name a ref may have: a caller
 * that acts on it holds it to `isBranchName` first (`resolveLine`); comparing it is safe.
 */
export async function checkedOutBranch(git: Git, dir: string): Promise<string | null> {
  const on = await currentBranch(git, dir);
  if (on !== null) return on;
  for (const state of ["rebase-merge", "rebase-apply"]) {
    const name = await readFile(`${dir}/.git/${state}/head-name`, "utf8").catch(() => null);
    if (name !== null && name.trim().startsWith("refs/heads/")) {
      return name.trim().slice("refs/heads/".length);
    }
  }
  return null;
}

/**
 * Whether `name` is a name git would give a branch (`check-ref-format --branch`, which it
 * answers back unchanged): never one with a leading dash, which a bare argument would read as an
 * option, nor `@{-1}` and its like, which git expands to another name. A ref under `refs/heads/`
 * can be made with any name a ref may have (`update-ref refs/heads/--strategy=x`), so a local
 * branch the agent names, or the one HEAD is on, is held to this before it is acted on. `name` is
 * never handed to git when it starts with a dash.
 */
export async function isBranchName(git: Git, dir: string, name: string): Promise<boolean> {
  if (name === "" || name.startsWith("-")) return false;
  try {
    return await git(dir, "check-ref-format", "--branch", name) === name;
  } catch {
    return false;
  }
}

/**
 * Whether `name` is a local branch, exactly: a valid branch name (`isBranchName`) and
 * `refs/heads/<name>` itself, never a revision that merely resolves (`x@{1}`, `x~2`). `name` is
 * agent input; in a full ref name behind `refs/heads/` it can never read as an option.
 */
export async function localBranchExists(git: Git, dir: string, name: string): Promise<boolean> {
  try {
    if (!await isBranchName(git, dir, name)) return false;
    await git(dir, "show-ref", "--verify", "--quiet", `refs/heads/${name}`);
    return true;
  } catch {
    return false;
  }
}

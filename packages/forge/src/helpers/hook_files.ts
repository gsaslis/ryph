// The filesystem and git half of core/hook_files.ts: what the TARGET repository configures about
// its hooks, and which paths a staged patch touched. Both questions are answered without running
// anything the repository configures:
// - the config is read FILE BY FILE with `git config --file <f> --no-includes --list`, through
//   the hermetic executor, which parses and executes nothing. Every file git would read for a
//   command in this repository is read: the repository's `.git/config`, every worktree's
//   `config.worktree`, the owner's global config (`$GIT_CONFIG_GLOBAL`,
//   `$XDG_CONFIG_HOME/git/config`, `~/.gitconfig`) and the system config (`$GIT_CONFIG_SYSTEM`,
//   wherever the installed git keeps it, `/etc/gitconfig`) — reading one file too many only adds
//   hook folders — and every file any of them includes, followed here by hand, the
//   CONDITIONAL ones (`includeIf`) included whether or not their condition holds today: an
//   `onbranch:ryph/**` include holds the moment the owner checks the delivered branch out
// - the touched paths, and the trees symlinks are resolved in, are read in the STAGED scratch
//   repository (helpers/submit.ts), whose objects are the verified bundle's and the base's —
//   never the run's word for what it changed

import { type Dirent, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { command } from "@ryph/process";
import {
  expandHooksPath,
  foldName,
  hookFilesAmong,
  hookPackageKeys,
  hookRoots,
  isRootPackageJson,
  normalizeRelative,
  prefixesBeforeDotDot,
  withHuskyParent,
  workingTreePath,
} from "../core/hook_files.ts";
import { normalizeAbsolute } from "../core/local_repo.ts";
import { type Git, type GitBounded, isExitOne } from "./git_exec.ts";
import { realLocationOf } from "./local_repo.ts";

/** The most bytes of path names one listing is held to — tens of thousands of paths past any
 * real patch. Past it the check cannot be made, and says so rather than guessing. */
const TOUCHED_LISTING_MAX_BYTES = 32 * 1024 * 1024;

/** The most config files one check follows (includes of includes), the most bytes one may hold,
 * the most trees a symlink walk reads, symlinks inside hook folders followed, and versions of
 * `package.json` compared — each far past a real repository, and each a refusal past it. */
const CONFIG_FILES_MAX = 64;
const CONFIG_FILE_MAX_BYTES = 4 * 1024 * 1024;
const TREE_READS_MAX = 400;
const HOOK_LINKS_MAX = 500;
const PACKAGE_VERSIONS_MAX = 200;
const PACKAGE_JSON_MAX_BYTES = 4 * 1024 * 1024;
/** As many links as the kernel follows on the way to one path. */
const LINK_HOPS_MAX = 40;
/** The most `..` segments one check resolves through symlinks, over every value it reads. */
const DOT_DOTS_MAX = 1000;

/** The patch (or the repository) is past what a check reads: no answer, and no retry changes
 * that. */
export class HookCheckTooLargeError extends Error {
  constructor(what = "the patch touches too many paths to check it for git hooks") {
    super(what);
    this.name = "HookCheckTooLargeError";
  }
}

/** Where the owner's own config lives — the forge runs as the owner, so its own environment.
 * `home: null` reads no `~`-based global config (tests); `globalConfig` is `$GIT_CONFIG_GLOBAL`,
 * read as well as the `~`-based ones; `systemConfigs` are every candidate system config. */
export interface HookEnv {
  home: string | null;
  xdgConfigHome?: string | null;
  globalConfig?: string | null;
  systemConfigs?: readonly string[];
}

/**
 * The owner's config locations. The system config is wherever the installed git keeps it
 * (Homebrew's is under its prefix, not `/etc`), asked of git itself — AND `/etc/gitconfig`, which
 * another git on the machine reads, AND `$GIT_CONFIG_SYSTEM` when set. Over-reading only adds
 * hook folders; the owner's shell may run any of those gits.
 */
export async function ownerHookEnv(): Promise<HookEnv> {
  const systemConfigs = new Set(["/etc/gitconfig"]);
  const named = process.env.GIT_CONFIG_SYSTEM;
  if (named?.startsWith("/")) systemConfigs.add(named);
  const installed = await installedSystemConfig();
  if (installed !== null) systemConfigs.add(installed);
  const global = process.env.GIT_CONFIG_GLOBAL;
  return {
    home: process.env.HOME ?? null,
    xdgConfigHome: process.env.XDG_CONFIG_HOME ?? null,
    globalConfig: global?.startsWith("/") ? global : null,
    systemConfigs: [...systemConfigs],
  };
}

/**
 * Where the installed git reads its system config: `git var GIT_CONFIG_SYSTEM` (git 2.42+), else
 * the origin `git config --system --show-origin --list` names. NOT the hermetic executor, whose
 * env points the system config at /dev/null — a bare env instead (PATH and HOME only, no
 * `GIT_*`), in `/` so no repository is found. Neither command runs anything: `git var` of this
 * variable prints a path, and a config read parses files. Null when git cannot say.
 */
async function installedSystemConfig(): Promise<string | null> {
  const run = async (...args: string[]): Promise<string | null> => {
    try {
      const env: Record<string, string> = {};
      for (const key of ["PATH", "HOME"]) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
      const out = await command("git", {
        args,
        cwd: "/",
        clearEnv: true,
        env,
        stdin: "null",
        stdout: "piped",
        stderr: "null",
      }).output();
      return out.code === 0 ? new TextDecoder().decode(out.stdout) : null;
    } catch {
      return null;
    }
  };
  const viaVar = (await run("var", "GIT_CONFIG_SYSTEM"))?.trim();
  if (viaVar?.startsWith("/")) return viaVar;
  const listing = await run("config", "--system", "--show-origin", "--list", "-z");
  const origin = listing?.split("\0").find((part) => part.startsWith("file:"));
  const file = origin?.slice("file:".length);
  return file?.startsWith("/") ? file : null;
}

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }
    throw err;
  }
}

/** The working trees of the repository at `real`: its own, then each linked worktree's, read
 * off `.git/worktrees/<name>/gitdir` (which names that worktree's `.git` file). */
function worktreeRoots(real: string): { roots: string[]; configs: string[] } {
  const roots = [real];
  const configs = [`${real}/.git/config.worktree`];
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(`${real}/.git/worktrees`, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  for (const entry of entries) {
    const dir = `${real}/.git/worktrees/${entry.name}`;
    configs.push(`${dir}/config.worktree`);
    let gitdir: string;
    try {
      gitdir = readFileSync(`${dir}/gitdir`, "utf8").trim();
    } catch {
      continue;
    }
    if (!gitdir.startsWith("/")) continue;
    const root = normalizeAbsolute(gitdir.replace(/\/\.git$/, ""));
    roots.push(root);
    const resolved = realLocationOf(root);
    if (resolved !== null && resolved !== root) roots.push(resolved);
  }
  return { roots, configs };
}

/** `location` repo-relative in ANY of the repository's working trees, or null. */
const inAnyTree = (location: string, roots: readonly string[]): string | null => {
  for (const root of roots) {
    const rel = workingTreePath(location, root);
    if (rel !== null) return rel;
  }
  return null;
};

/** `location` repo-relative as written and as the disk resolves it — through a symlink, a
 * dangling one included — each that is inside a working tree. */
function treePathsOf(location: string, roots: readonly string[]): string[] {
  const out: string[] = [];
  const asWritten = inAnyTree(location, roots);
  if (asWritten !== null) out.push(asWritten);
  const leads = realLocationOf(location);
  const asResolved = leads === null ? null : inAnyTree(leads, roots);
  if (asResolved !== null) out.push(asResolved);
  return out;
}

/**
 * Where the absolute, unnormalized `expanded` leads on the disk, as the kernel walks it: every
 * symlink up to a `..` is followed BEFORE the `..` steps up (`scripts/../.hk` with `scripts -> a/b`
 * is `a/.hk`), and what follows the last `..` is kept as written. Also every place a `..` stepped
 * up from, as written, and the count of `..` spent from `budget`. A link loop is no answer.
 */
function dotDotsOnDisk(
  expanded: string,
  budget: { dotDots: number },
): { location: string; prefixes: string[] } {
  let at: string[] = [];
  const prefixes: string[] = [];
  for (const seg of expanded.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg !== "..") {
      at.push(seg);
      continue;
    }
    if (++budget.dotDots > DOT_DOTS_MAX) {
      throw new HookCheckTooLargeError("the repository's git config climbs too many `..` to check");
    }
    const here = `/${at.join("/")}`;
    prefixes.push(here);
    const real = realLocationOf(here);
    if (real === null) {
      throw new HookCheckTooLargeError(
        "a path the repository's git config names loops through links",
      );
    }
    at = real.split("/").filter((s) => s !== "");
    at.pop();
  }
  return { location: `/${at.join("/")}`, prefixes };
}

/** The segments of the absolute `expanded` after the working tree it starts in, as written — when
 * it starts in one and holds a `..` that a symlink a commit's tree holds can move. */
function relativeDotDots(expanded: string, roots: readonly string[]): string[] | null {
  const segs = expanded.split("/").filter((s) => s !== "" && s !== ".");
  if (!segs.includes("..")) return null;
  for (const root of roots) {
    const rootSegs = root.split("/").filter((s) => s !== "");
    if (rootSegs.length > segs.length) continue;
    if (rootSegs.every((seg, i) => foldName(seg) === foldName(segs[i]))) {
      const rest = segs.slice(rootSegs.length);
      // `..` only before the root: the disk alone answers where it leads.
      return rest.includes("..") ? rest : null;
    }
  }
  return null;
}

/** Every `key\nvalue` entry of ONE config file, includes not followed. */
async function configEntries(git: Git, real: string, file: string): Promise<[string, string][]> {
  const listing = await git(real, "config", "--file", file, "--no-includes", "--list", "-z");
  return listing.split("\0").filter((entry) => entry !== "").map((entry) => {
    const nl = entry.indexOf("\n");
    return nl === -1 ? [entry, ""] : [entry.slice(0, nl), entry.slice(nl + 1)];
  });
}

/**
 * The hook folders of the repository at `real` (its real path), repo-relative, and the config
 * files git reads for it that live in its working tree. A `core.hooksPath` from ANY level counts
 * when it leads INSIDE a working tree — read as written (`.husky`, `./hooks/../.husky`) and as
 * the disk resolves it (through a symlink, or a `~/…` that is this repository) — because the
 * level that wins differs per worktree and per owner, and either way a file a patch puts there
 * is a hook the owner's next checkout runs. One that leads anywhere else is not this patch's to
 * change. A symlink at the top of a hook folder ON DISK (untracked, the owner's) leads the folder
 * to its target too. `env` says where the owner's global config is.
 */
export async function hookSetup(
  real: string,
  git: Git,
  given?: HookEnv,
): Promise<{
  roots: string[];
  configFiles: string[];
  ancestors: string[];
  worktrees: string[];
  dotDots: DotDotValues;
}> {
  const env = given ?? await ownerHookEnv();
  const { roots: trees, configs } = worktreeRoots(real);
  const home = env.home !== null && env.home.startsWith("/") ? env.home : null;
  const start = [`${real}/.git/config`, ...configs, ...(env.systemConfigs ?? [])];
  if (env.globalConfig?.startsWith("/")) start.push(env.globalConfig);
  if (home !== null) {
    const xdg = env.xdgConfigHome?.startsWith("/") ? env.xdgConfigHome : `${home}/.config`;
    start.push(`${xdg}/git/config`, `${home}/.gitconfig`);
  }

  const configured: string[] = [];
  const configFiles: string[] = [];
  // Paths a value names right before a `..` (`scripts` of `scripts/../.hk`): a symlink there
  // moves what the value leads to, so each is held like an ancestor of a hook folder.
  const ancestors: string[] = [];
  const dotDotPrefixes = (expanded: string) => {
    for (const prefix of prefixesBeforeDotDot(expanded)) {
      // The root itself is no patch's to replace.
      ancestors.push(...treePathsOf(prefix, trees).filter((rel) => rel !== ""));
    }
  };
  // A value with a `..` leads where the symlinks before it say — on the disk here, and in each
  // commit's tree (`rootsInTrees`), which may hold a link the disk does not have.
  const budget = { dotDots: 0 };
  const dotDots: DotDotValues = { hooksPaths: [], includes: [] };
  const onDisk = (expanded: string, kind: keyof DotDotValues): string => {
    const { location, prefixes } = dotDotsOnDisk(expanded, budget);
    for (const prefix of prefixes) {
      ancestors.push(...treePathsOf(prefix, trees).filter((rel) => rel !== ""));
    }
    const rel = relativeDotDots(expanded, trees);
    if (rel !== null) dotDots[kind].push(rel);
    return location;
  };
  const seen = new Set<string>();
  const queue = start.map((file) => normalizeAbsolute(file));
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (seen.size > CONFIG_FILES_MAX) {
      throw new HookCheckTooLargeError("the repository's git config includes too many files");
    }
    // A file in the working tree is a hook file whether or not it is there yet: an include of a
    // missing `.gitconfig.local` is read the moment a patch adds one.
    configFiles.push(...treePathsOf(file, trees));
    const info = statOrNull(file);
    // Only a regular file is read; git would fail on anything else, and a FIFO would never end.
    if (info === null || !info.isFile()) continue;
    if (info.size > CONFIG_FILE_MAX_BYTES) {
      throw new HookCheckTooLargeError("a git config file of the repository is too large to read");
    }
    const dir = file.slice(0, file.lastIndexOf("/")) || "/";
    let entries: [string, string][];
    try {
      entries = await configEntries(git, real, file);
    } catch (err) {
      // A file git cannot parse sets nothing: were it read for a command, that command would
      // die on it before running any hook. Anything else is a check that was not made.
      if (/bad config/.test(String(err))) continue;
      throw err;
    }
    for (const [key, value] of entries) {
      const k = key.toLowerCase();
      if (k === "core.hookspath") {
        for (const tree of trees) {
          const expanded = expandHooksPath(value, tree, home);
          if (expanded === null) continue;
          configured.push(...treePathsOf(onDisk(expanded, "hooksPaths"), trees));
          dotDotPrefixes(expanded);
        }
      } else if (k === "include.path" || (k.startsWith("includeif.") && k.endsWith(".path"))) {
        let target: string | null;
        if (value === "") target = null;
        else if (value === "~" || value.startsWith("~/")) {
          target = home === null ? null : `${home}${value.slice(1)}`;
        } else if (value.startsWith("~")) target = null;
        else target = value.startsWith("/") ? value : `${dir}/${value}`;
        if (target !== null) {
          queue.push(onDisk(target, "includes"));
          dotDotPrefixes(target);
        }
      }
    }
  }

  // The owner's own symlinks at the top of a hook folder (git runs `<folder>/<hook>`): where
  // each leads is where that hook's code is.
  const roots = hookRoots(configured);
  for (const root of [...roots]) {
    if (root === "") continue;
    for (const tree of trees) {
      let entries: Dirent[];
      try {
        entries = readdirSync(`${tree}/${root}`, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isSymbolicLink()) continue;
        const leads = realLocationOf(`${tree}/${root}/${entry.name}`);
        const rel = leads === null ? null : inAnyTree(leads, trees);
        if (rel !== null) roots.push(rel);
      }
    }
  }
  return {
    roots: dedupeFolded(roots),
    configFiles: [...new Set(configFiles)],
    ancestors: dedupeFolded(ancestors),
    worktrees: trees,
    dotDots,
  };
}

/** Configured values holding a `..`, as segments after the working tree they start in. */
interface DotDotValues {
  hooksPaths: string[][];
  includes: string[][];
}

/** NUL-separated names, as `-z` lists them. */
const namesOf = (listing: string) => listing.split("\0").filter((name) => name !== "");

/** What `touchedPaths` reads, and the merge base it read from (null: none). */
async function touchedRange(
  dir: string,
  baseTip: string,
  head: string,
  git: Git,
  bounded: GitBounded,
): Promise<{ paths: string[]; mergeBase: string | null }> {
  let mergeBase: string | null;
  try {
    mergeBase = await git(dir, "merge-base", baseTip, head);
  } catch (err) {
    if (!isExitOne(err)) throw err;
    mergeBase = null;
  }
  const from = mergeBase ?? await git(dir, "hash-object", "-t", "tree", "/dev/null");
  const diff = await bounded(
    dir,
    TOUCHED_LISTING_MAX_BYTES,
    "diff-tree",
    "-r",
    "-z",
    "--name-only",
    "--no-renames",
    from,
    head,
  );
  const log = await bounded(
    dir,
    TOUCHED_LISTING_MAX_BYTES,
    "log",
    "-z",
    "--name-only",
    "--no-renames",
    "--cc",
    "--format=",
    mergeBase === null ? head : `${mergeBase}..${head}`,
    "--",
  );
  if (diff === null || log === null) throw new HookCheckTooLargeError();
  return { paths: [...new Set([...namesOf(diff), ...namesOf(log)])], mergeBase };
}

/**
 * Every path the patch `head` touches against `baseTip`, in the staged repository `dir`: what
 * the change does from where it forks off the base (the diff from the merge base to the head),
 * AND every path any commit in that range touched — so a hook added in one commit and reverted
 * in the next is still a hook the owner gets in the branch's history, and runs by checking out
 * the commit between. Merges are read as combined diffs, which name exactly the paths a merge
 * changes against every parent (what a merge brings in from the base is the base's own). Renames
 * are two paths. With no merge base, everything the head holds.
 */
export async function touchedPaths(
  dir: string,
  baseTip: string,
  head: string,
  git: Git,
  bounded: GitBounded,
): Promise<string[]> {
  return (await touchedRange(dir, baseTip, head, git, bounded)).paths;
}

interface TreeEntry {
  mode: string;
  sha: string;
  name: string;
}

/** One `ls-tree -z` line: `<mode> <type> <sha>\t<name>`. */
function parseTreeEntry(line: string): TreeEntry {
  const tab = line.indexOf("\t");
  const [mode, , sha] = line.slice(0, tab).split(" ");
  return { mode, sha, name: line.slice(tab + 1) };
}

/**
 * Reads trees and symlinks of the staged repository `dir`, each once, and resolves repo-relative
 * paths through the symlinks a commit's tree holds — as the disk will once that commit is checked
 * out. Names fold (`foldName`) as the disk compares them, so a tree holding `Tools` (a link) is
 * walked through for `tools/hooks`; where two entries fold alike, both are followed.
 */
function treeReader(dir: string, bounded: GitBounded, trees: readonly string[]) {
  const listings = new Map<string, TreeEntry[]>();
  let reads = 0;
  const read = async (...args: string[]): Promise<string> => {
    if (++reads > TREE_READS_MAX) {
      throw new HookCheckTooLargeError("the patch's tree is too deep to check it for git hooks");
    }
    const out = await bounded(dir, TOUCHED_LISTING_MAX_BYTES, ...args);
    if (out === null) throw new HookCheckTooLargeError();
    return out;
  };
  const entriesOf = async (tree: string, recursive = false): Promise<TreeEntry[]> => {
    const key = `${recursive ? "r" : "-"}${tree}`;
    const known = listings.get(key);
    if (known !== undefined) return known;
    const listing = await read("ls-tree", "-z", ...(recursive ? ["-r"] : []), tree);
    const entries = namesOf(listing).map(parseTreeEntry);
    listings.set(key, entries);
    return entries;
  };
  /** A symlink's target, repo-relative from the folder `at` it sits in; null when it leads out. */
  const targetOf = async (sha: string, at: string): Promise<string | null> => {
    const target = await read("cat-file", "blob", sha);
    if (target.startsWith("/")) return inAnyTree(normalizeAbsolute(target), trees);
    return normalizeRelative(at === "" ? target : `${at}/${target}`);
  };

  /** Where `path` leads in the tree `rootTree`, each way it can (a folded name may match more
   * than one entry), with the tree it lands on when it is a folder there. */
  const resolve = async (
    rootTree: string,
    path: string,
  ): Promise<{ path: string; tree: string | null }[]> => {
    const out: { path: string; tree: string | null }[] = [];
    const walk = async (segs: string[], hops: number): Promise<void> => {
      if (hops > LINK_HOPS_MAX) return;
      let tree = rootTree;
      const done: string[] = [];
      for (let i = 0; i < segs.length; i++) {
        const want = foldName(segs[i]);
        const matches = (await entriesOf(tree)).filter((e) => foldName(e.name) === want);
        const rest = segs.slice(i + 1);
        if (matches.length === 0) {
          out.push({ path: [...done, ...segs.slice(i)].join("/"), tree: null });
          return;
        }
        const folders = matches.filter((e) => e.mode === "040000");
        for (const entry of matches) {
          if (entry.mode === "120000") {
            const target = await targetOf(entry.sha, done.join("/"));
            if (target === null) continue;
            const next = normalizeRelative([target, ...rest].join("/"));
            if (next !== null) await walk(next === "" ? [] : next.split("/"), hops + 1);
          } else if (entry.mode !== "040000") {
            out.push({ path: [...done, entry.name, ...rest].join("/"), tree: null });
          }
        }
        if (folders.length === 0) return;
        // More than one folder folding alike: the others are walked on their own.
        for (const other of folders.slice(1)) {
          const sub = await resolveFrom(other.sha, rest);
          for (const r of sub) {
            out.push({
              path: [...done, other.name, ...(r.path === "" ? [] : [r.path])].join("/"),
              tree: r.tree,
            });
          }
        }
        done.push(folders[0].name);
        tree = folders[0].sha;
      }
      out.push({ path: done.join("/"), tree });
    };
    // A folder's subtree, with no links followed out of it (a rare second spelling).
    const resolveFrom = async (
      tree: string,
      segs: string[],
    ): Promise<{ path: string; tree: string | null }[]> => {
      let at = tree;
      const done: string[] = [];
      for (const seg of segs) {
        const entry = (await entriesOf(at)).find((e) =>
          foldName(e.name) === foldName(seg) && e.mode === "040000"
        );
        if (entry === undefined) return [{ path: segs.join("/"), tree: null }];
        done.push(entry.name);
        at = entry.sha;
      }
      return [{ path: done.join("/"), tree: at }];
    };
    await walk(path === "" ? [] : path.split("/"), 0);
    return out;
  };

  /** The symlinks anywhere under the folder `tree` (at repo path `at`), and where each leads. */
  const linksUnder = async (tree: string, at: string): Promise<string[]> => {
    const links = (await entriesOf(tree, true)).filter((e) => e.mode === "120000");
    if (links.length > HOOK_LINKS_MAX) {
      throw new HookCheckTooLargeError("a hook folder holds too many symlinks to check");
    }
    const out: string[] = [];
    for (const link of links) {
      const parent = link.name.includes("/") ? link.name.slice(0, link.name.lastIndexOf("/")) : "";
      const from = [at, parent].filter((p) => p !== "").join("/");
      const target = await targetOf(link.sha, from);
      if (target !== null) out.push(target);
    }
    return out;
  };

  return { resolve, linksUnder, read };
}

/**
 * The hook folders as the commits `revs` lay them out: each root resolved through the symlinks
 * those trees hold (a tracked `tools -> vendor/tools` puts `tools/hooks` at `vendor/tools/hooks`),
 * and every place a symlink INSIDE a hook folder leads (`.husky/post-checkout ->
 * ../scripts/pc.sh` makes `scripts/pc.sh` the hook's code), resolved the same way.
 */
async function rootsInTrees(
  dir: string,
  revs: readonly string[],
  roots: readonly string[],
  trees: readonly string[],
  bounded: GitBounded,
  git: Git,
  dotDots: DotDotValues = { hooksPaths: [], includes: [] },
): Promise<
  { roots: string[]; packageLinkTargets: string[]; ancestors: string[]; configFiles: string[] }
> {
  const reader = treeReader(dir, bounded, trees);
  const out: string[] = [];
  const packageLinkTargets: string[] = [];
  const ancestors: string[] = [];
  const configFiles: string[] = [];
  /** Where the segments `segs` lead in `rootTree`: each `..` steps up from where the links
   * before it lead, as the kernel will once that tree is checked out. Every place stepped up
   * from — as written and as led — is an ancestor: a link a later commit puts there moves it. */
  const viaTree = async (rootTree: string, segs: readonly string[]): Promise<string[]> => {
    let current = [""];
    for (const seg of segs) {
      if (seg !== "..") {
        current = current.map((p) => p === "" ? seg : `${p}/${seg}`);
        continue;
      }
      const next: string[] = [];
      for (const path of current) {
        if (path !== "") ancestors.push(path);
        for (const resolved of await reader.resolve(rootTree, path)) {
          // Stepping up out of the working tree leads somewhere no patch path is.
          if (resolved.path === "") continue;
          ancestors.push(resolved.path);
          const slash = resolved.path.lastIndexOf("/");
          next.push(slash === -1 ? "" : resolved.path.slice(0, slash));
        }
      }
      current = dedupeFolded(next);
      if (current.length > HOOK_LINKS_MAX) {
        throw new HookCheckTooLargeError(
          "a path the repository's git config names leads too many ways",
        );
      }
    }
    return current;
  };
  for (const rev of new Set(revs)) {
    const rootTree = await git(dir, "rev-parse", "--verify", `${rev}^{tree}`);
    const extra: string[] = [];
    for (const segs of dotDots.hooksPaths) {
      for (const path of await viaTree(rootTree, segs)) extra.push(...withHuskyParent(path));
    }
    // An included file leads through a link at its own name too, as the disk would read it.
    for (const segs of dotDots.includes) {
      for (const path of await viaTree(rootTree, segs)) {
        configFiles.push(path);
        for (const resolved of await reader.resolve(rootTree, path)) {
          if (resolved.path !== "") configFiles.push(resolved.path);
        }
      }
    }
    // A root `package.json` that is a symlink in this tree: what it leads to IS the root
    // `package.json` npm reads, and is held whole — its keys are not compared through a link.
    for (const resolved of await reader.resolve(rootTree, "package.json")) {
      if (!isRootPackageJson(resolved.path)) packageLinkTargets.push(resolved.path);
    }
    const pending = [...roots, ...extra];
    const done = new Set<string>();
    while (pending.length > 0) {
      const root = pending.shift()!;
      if (done.has(foldName(root))) continue;
      done.add(foldName(root));
      if (done.size > HOOK_LINKS_MAX) {
        throw new HookCheckTooLargeError("a hook folder holds too many symlinks to check");
      }
      out.push(root);
      if (root === "") continue;
      for (const resolved of await reader.resolve(rootTree, root)) {
        out.push(resolved.path);
        // A link that leads husky's `_` elsewhere leads its hooks' folder — the parent — too.
        for (const parent of withHuskyParent(resolved.path).slice(1)) pending.push(parent);
        if (resolved.tree !== null && resolved.path !== "") {
          pending.push(...await reader.linksUnder(resolved.tree, resolved.path));
        }
      }
    }
  }
  return {
    roots: dedupeFolded(out),
    packageLinkTargets: dedupeFolded(packageLinkTargets),
    ancestors: dedupeFolded(ancestors),
    configFiles: dedupeFolded(configFiles),
  };
}

/** `paths` without a second spelling of one the disk takes as the same, first spelling kept. */
function dedupeFolded(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const folded = foldName(path);
    if (seen.has(folded)) return false;
    seen.add(folded);
    return true;
  });
}

/**
 * Whether the patch changes a hook-wiring key (core/hook_files.ts `HOOK_PACKAGE_KEYS`) of the
 * root `package.json` spelled `path`: any version of it in the range — the head's, and every
 * commit's that touched it — against the one it forked from. A version too large to read, or
 * not JSON, counts as changed: a check that cannot be made is not one that passed — and so does
 * a version that is a symlink (or anything but a file), whose keys live somewhere else.
 */
async function packageKeysChanged(
  dir: string,
  path: string,
  mergeBase: string | null,
  head: string,
  bounded: GitBounded,
): Promise<boolean> {
  const listing = await bounded(
    dir,
    TOUCHED_LISTING_MAX_BYTES,
    "log",
    "-z",
    "--format=%H",
    "--full-history",
    mergeBase === null ? head : `${mergeBase}..${head}`,
    "--",
    path,
  );
  if (listing === null) return true;
  const commits = [...new Set([head, ...namesOf(listing).map((c) => c.trim())])];
  if (commits.length > PACKAGE_VERSIONS_MAX) return true;
  const keysAt = async (commit: string): Promise<string | null | "absent"> => {
    // The commit's root entry by exactly this name — its mode as well as its blob: a version
    // that is a symlink (or anything but a file) is one whose keys live elsewhere, so it is
    // read as changed. A root listing, not `<commit>:<path>`, which would follow nothing but
    // also says nothing of the mode.
    const listing = await bounded(dir, TOUCHED_LISTING_MAX_BYTES, "ls-tree", "-z", commit);
    if (listing === null) return null;
    const entry = namesOf(listing).map(parseTreeEntry).find((e) => e.name === path);
    if (entry === undefined) return "absent";
    if (!["100644", "100755", "100664"].includes(entry.mode)) return null;
    const text = await bounded(dir, PACKAGE_JSON_MAX_BYTES, "cat-file", "blob", entry.sha);
    return text === null ? null : hookPackageKeys(text);
  };
  const before = mergeBase === null ? "absent" : await keysAt(mergeBase);
  if (before === null) return true;
  for (const commit of commits) {
    const after = await keysAt(commit);
    if (after === null) return true;
    // Present on one side only: the keys of a file that is not there are none.
    const a = before === "absent" ? "{}" : before;
    const b = after === "absent" ? "{}" : after;
    if (a !== b) return true;
  }
  return false;
}

/**
 * The hook files a staged patch touches in the repository it would land in, sorted, and the
 * hook folders that were looked at. `target` is the repository's real path, re-checked by the
 * caller; `scratch` the staged repository holding `baseTip` and `head`.
 */
export async function hookFilesOfPatch(args: {
  target: string;
  scratch: string;
  baseTip: string;
  head: string;
  git: Git;
  bounded: GitBounded;
  env?: HookEnv;
}): Promise<{ hookFiles: string[]; roots: string[] }> {
  const setup = await hookSetup(args.target, args.git, args.env);
  const { paths, mergeBase } = await touchedRange(
    args.scratch,
    args.baseTip,
    args.head,
    args.git,
    args.bounded,
  );
  const { roots, packageLinkTargets, ancestors, configFiles } = await rootsInTrees(
    args.scratch,
    [args.baseTip, args.head, ...(mergeBase === null ? [] : [mergeBase])],
    setup.roots,
    setup.worktrees,
    args.bounded,
    args.git,
    setup.dotDots,
  );
  const hookFiles = new Set(
    hookFilesAmong(
      paths,
      [...roots, ...setup.configFiles, ...configFiles, ...packageLinkTargets],
      [...setup.ancestors, ...ancestors],
    ),
  );
  for (const path of paths) {
    if (
      isRootPackageJson(path) && !hookFiles.has(path) &&
      await packageKeysChanged(args.scratch, path, mergeBase, args.head, args.bounded)
    ) {
      hookFiles.add(path);
    }
  }
  return { hookFiles: [...hookFiles].sort(), roots };
}

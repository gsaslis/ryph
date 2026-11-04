// Which files of a patch are git hooks — or decide which hooks run — in the repository a `local`
// delivery lands in. Pure: what the target repository configures, and which paths the patch
// touched, are read by helpers/hook_files.ts and handed in.
//
// ── Why a hook file needs a human ─────────────────────────────────────────────────────────────
//
// An approved `local` patch lands as a branch in a repository the owner works in, and the owner
// will check it out. A repository that runs its hooks from a TRACKED folder — husky's
// `core.hooksPath=.husky`, a `.githooks/` the README says to point git at — runs whatever that
// folder holds on the next `git checkout`, as the owner, outside any sandbox. A patch that adds
// `.husky/post-checkout` is therefore code the owner runs by looking at the patch. The delivery
// itself runs no hooks (adapters/change_transport/local.ts); this is about the checkout after.
//
// So such a patch is held for a person, whatever the submission policy says, and passes only
// with the hook files that person was shown (`approvedHookPaths`). The paths here are the one
// thing about the repository a run may see: repo-relative, and the point of the question.

// ── What the gate covers, and what it does not ──────────────────────────────────────────────
//
// It covers the files that DECIDE what runs on checkout, commit or status: the hook folders
// (the conventional two, the repository's `core.hooksPath` at every config level, and wherever a
// symlink in the tree or on disk leads them), the files a symlink inside a hook folder points at,
// hook managers' config files, any config file git reads for this repository that lives in the
// working tree (an `include.path`/`includeIf` target — it can set `core.hooksPath` or
// `core.fsmonitor`), and the root `package.json` when a patch changes one of the keys that wire
// hooks or install-time scripts (`HOOK_PACKAGE_KEYS`), and any change to a root `package.yaml` /
// `package.yml` (lint-staged and commitlint read their config from one; it is not parsed here, so
// every change is held). It does NOT cover, by design:
// - arbitrary code that an existing hook or tool goes on to run — an eslint or prettier config
//   lint-staged runs, a test a pre-push hook runs, a Makefile target a hook calls
// - install-time tool config — `.yarnrc.yml`'s `yarnPath`, `.pnpmfile.cjs`, `.npmrc`'s
//   `node-options` — which runs on the owner's next install, not on a checkout, commit or status
// Those are the repository's code like any other, and the owner runs them by choice, not by
// checking the branch out.
//
// ── Names fold the way the disk does ──────────────────────────────────────────────────────────
//
// Every name is compared FOLDED (`foldName`), whatever `core.ignorecase` says: a macOS volume is
// case- and normalization-insensitive whether or not the repository's config knows it, and APFS
// treats `.huſky` (U+017F), `.HUSKY` and `.husky` as one folder, `.lintﬆagedrc` (U+FB06) as
// `.lintstagedrc`, a Kelvin sign as `k`, NFD as NFC. NFKC + a full case fold matches every one of
// those, and a few more APFS keeps apart (fullwidth `．ｈｕｓｋｙ`): over-matching only asks a
// person to approve, under-matching runs agent code. Before any of it, the code points HFS+
// ignores in a name are dropped (`.hu\u200Csky` IS `.husky` there, as git's own `is_hfs_dotgit`
// knows), and with them every other default-ignorable one.

import { normalizeAbsolute } from "./local_repo.ts";

/** Hook folders checked whatever the repository's config says: the two conventions a repository
 * is set up to point `core.hooksPath` at, often by a script that has not run yet, husky's
 * per-user `.config/husky`, and the folders lefthook runs hook scripts from. */
export const ALWAYS_HOOK_ROOTS = [
  ".husky",
  ".githooks",
  ".config/husky",
  ".lefthook",
  ".lefthook-local",
] as const;

/** Hook folders matched by name at ANY depth — a monorepo's `frontend/.husky`, set up by a
 * script that has not run yet — each a run of segments. */
const HOOK_FOLDERS_ANY_DEPTH: readonly (readonly string[])[] = [
  [".husky"],
  [".githooks"],
  [".config", "husky"],
  [".lefthook"],
  [".lefthook-local"],
];

/** Config names a hook manager also reads from a `.config/` folder (cosmiconfig's search
 * places): the name, or the name and any extension. */
const HOOK_CONFIG_IN_DOT_CONFIG = ["commitlintrc", "lintstagedrc", "huskyrc"];

/** Hook managers' config files, matched by name at any depth: each decides which commands the
 * manager's hooks run, so editing one is editing a hook. */
const HOOK_CONFIG_NAMES = [
  "lefthook.yml",
  "lefthook.yaml",
  "lefthook.toml",
  "lefthook.json",
  ".lefthook.yml",
  ".lefthook.yaml",
  ".lefthook.toml",
  ".lefthook.json",
  "lefthook-local.yml",
  "lefthook-local.yaml",
  "lefthook-local.toml",
  "lefthook-local.json",
  ".lefthook-local.yml",
  ".lefthook-local.yaml",
  ".lefthook-local.toml",
  ".lefthook-local.json",
  ".pre-commit-config.yaml",
  ".pre-commit-config.yml",
  ".pre-commit-hooks.yaml",
  ".overcommit.yml",
  ".lintstagedrc",
  ".huskyrc",
  ".commitlintrc",
  ".simple-git-hooks",
];

/** The same, for names that take any extension (`.lintstagedrc.json`, `lint-staged.config.mjs`). */
const HOOK_CONFIG_PREFIXES = [
  ".lintstagedrc.",
  "lint-staged.config.",
  ".huskyrc.",
  "husky.config.",
  ".simple-git-hooks.",
  "simple-git-hooks.",
  ".commitlintrc.",
  "commitlint.config.",
];

/**
 * The keys of the repository's root `package.json` that wire git hooks (husky, simple-git-hooks,
 * lint-staged, pre-commit, yorkie's `gitHooks`, ghooks, commitlint) or run code on the owner's
 * next `npm install` (the lifecycle scripts, which is where hook managers install themselves).
 * A patch that changes any of them is held like a hook file; one that changes the rest of the
 * file is not. Dotted: `scripts.prepare` is the `prepare` key of `scripts`.
 */
export const HOOK_PACKAGE_KEYS = [
  "husky",
  "simple-git-hooks",
  "lint-staged",
  "pre-commit",
  "gitHooks",
  "ghooks",
  "commitlint",
  "config.ghooks",
  "scripts.prepare",
  "scripts.preinstall",
  "scripts.install",
  "scripts.postinstall",
  // husky before v1 read hooks from npm scripts named after them.
  "scripts.precommit",
  "scripts.prepush",
  "scripts.postcheckout",
  "scripts.postmerge",
  "scripts.commitmsg",
] as const;

/** How the repository's root is spelled on the wire and to a person: `"."`, never `""`. */
export const ROOT_ON_WIRE = ".";

/**
 * A name as the disk compares it — or a little more: NFKC, then a full case fold (upper, then
 * lower, so `ß` and `ss`, `ς` and `σ`, `ǅ` and `ǆ` meet), then NFKC again for what the fold
 * decomposed, all of it twice. Applied to whole paths; `/` folds to itself.
 */
export function foldName(s: string): string {
  // Twice: one round takes `ẞ` (U+1E9E) only to `ß`, which APFS — like the second round — takes
  // on to `ss`. Measured against every code point on APFS: these two rounds match each one the
  // disk takes to a hook name's letters. Ignorable code points are dropped before each round
  // and after the last, so none a normalization brings back survives.
  const once = (t: string) =>
    stripIgnorable(t).normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
  return stripIgnorable(once(once(s)));
}

/**
 * The code points HFS+ drops from a name before comparing it — the set git's `is_hfs_dotgit`
 * skips (U+200C–U+200F, U+202A–U+202E, U+206A–U+206F, U+FEFF) — and, past what HFS+ is known to
 * do, every other `Default_Ignorable_Code_Point`: dropping one more only folds two names
 * together, which asks a person; keeping one HFS+ drops lets `.hu\u200Csky` past as a new name.
 */
const IGNORABLE =
  /[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF\p{Default_Ignorable_Code_Point}]/gu;
const stripIgnorable = (s: string) => s.replace(IGNORABLE, "");

const FOLDED_NAMES = new Set(HOOK_CONFIG_NAMES.map(foldName));
const FOLDED_PREFIXES = HOOK_CONFIG_PREFIXES.map(foldName);

/** The most hook files one answer names; past it, `more` says the list was cut. */
export const HOOK_FILES_SHOWN_MAX = 50;

/** What a check of a patch's hook files found. `touched` is sorted, deduped and capped at
 * `HOOK_FILES_SHOWN_MAX` (`more` set when cut); `hooksPaths` are the hook folders that applied,
 * repo-relative, `"."` being the repository's root (`ROOT_ON_WIRE`). The wire shape of both the
 * pre-check route and the delivery's `needs_approval` refusal. */
export interface HookFilesReport {
  touched: string[];
  hooksPaths: string[];
  more: boolean;
}

/**
 * Where a `core.hooksPath` value points, spelled as git resolves it for a hook run in the
 * working tree at `repoRoot`: relative to that root, `~/…` under `home`, an absolute path as
 * itself — then `.`/`..` resolved textually. Null when it cannot be resolved here: empty, or
 * `~user/…` (another account's home), which is outside this repository either way.
 */
export function hooksPathLocation(
  raw: string,
  repoRoot: string,
  home: string | null,
): string | null {
  const expanded = expandHooksPath(raw, repoRoot, home);
  return expanded === null ? null : normalizeAbsolute(expanded);
}

/** `hooksPathLocation` before its `.`/`..` are resolved: absolute, spelled as written. */
export function expandHooksPath(raw: string, repoRoot: string, home: string | null): string | null {
  if (raw === "") return null;
  let expanded: string;
  if (raw === "~" || raw.startsWith("~/")) {
    if (home === null || !home.startsWith("/")) return null;
    expanded = `${home}${raw.slice(1)}`;
  } else if (raw.startsWith("~")) {
    return null;
  } else if (raw.startsWith("/")) {
    expanded = raw;
  } else {
    expanded = `${repoRoot}/${raw}`;
  }
  return expanded;
}

const segmentsOf = (path: string) => path.split("/").filter((seg) => seg !== "");

/**
 * `location` relative to the working tree at `repoRoot` when it is inside it — `""` for the root
 * itself — and null otherwise. Inside `.git` is not the working tree: no patch path can be there.
 * Both must be absolute and normalized. Segment-wise and FOLDED (`foldName`), as the disk
 * underneath compares names; the answer keeps `location`'s own spelling.
 */
export function workingTreePath(location: string, repoRoot: string): string | null {
  const loc = segmentsOf(location);
  const root = segmentsOf(repoRoot);
  if (loc.length < root.length) return null;
  for (let i = 0; i < root.length; i++) {
    if (foldName(loc[i]) !== foldName(root[i])) return null;
  }
  const rel = loc.slice(root.length);
  if (rel.length > 0 && foldName(rel[0]) === ".git") return null;
  return rel.join("/");
}

/**
 * A repo-relative path with `.`/`..` and empty segments resolved — what a relative symlink target
 * names, read from the folder the link sits in. Null when it climbs out of the repository.
 */
export function normalizeRelative(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

/**
 * The hook folders a check applies: the conventional ones, then the repository's own, deduped —
 * each with its PARENT when its last segment is `_`. That is husky v9's layout: `core.hooksPath`
 * names `<dir>/_`, whose stubs run `<dir>/<hook>`, so `<dir>` holds the hooks' code.
 */
export function hookRoots(configured: readonly string[]): string[] {
  return [...new Set([...ALWAYS_HOOK_ROOTS, ...configured.flatMap(withHuskyParent)])];
}

/** `root`, and its parent when its last segment folds to `_` (husky v9's stub folder). */
export function withHuskyParent(root: string): string[] {
  const segs = root.split("/").filter((seg) => seg !== "");
  if (segs.length === 0 || foldName(segs[segs.length - 1]) !== "_") return [root];
  return [root, segs.slice(0, -1).join("/")];
}

/**
 * Every path a `core.hooksPath` or include value names immediately before a `..` segment: the
 * kernel resolves such a prefix through any symlink BEFORE stepping up, so a patch that turns
 * `scripts` into a link moves `scripts/../.hk` wherever the link's parent is. Absolute,
 * unnormalized input (`~/` already expanded); the prefixes come back normalized.
 */
export function prefixesBeforeDotDot(expanded: string): string[] {
  const segs = expanded.split("/");
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) {
    if (segs[i] === "..") out.push(normalizeAbsolute(segs.slice(0, i).join("/") || "/"));
  }
  return out;
}

/** Whether `path` is the repository's root `package.json`, as the disk would spell it. */
export function isRootPackageJson(path: string): boolean {
  return foldName(path) === "package.json";
}

/** Whether `path` is a root `package.yaml`/`package.yml` — read for lint-staged and commitlint
 * config, and not parsed here, so any change to one is a hook file. */
export function isRootPackageYaml(path: string): boolean {
  const p = foldName(path);
  return p === "package.yaml" || p === "package.yml";
}

/**
 * The part of a `package.json` text that `HOOK_PACKAGE_KEYS` names, as one canonical string two
 * versions can be compared by — or null when the text is not a JSON object, which a check
 * cannot read and so treats as changed.
 */
export function hookPackageKeys(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const picked: Record<string, unknown> = {};
  for (const key of HOOK_PACKAGE_KEYS) {
    let at: unknown = parsed;
    for (const part of key.split(".")) {
      at = typeof at === "object" && at !== null && !Array.isArray(at)
        ? Object.hasOwn(at, part) ? (at as Record<string, unknown>)[part] : undefined
        : undefined;
    }
    if (at !== undefined) picked[key] = at;
  }
  return canonicalJson(picked);
}

/** JSON with every object's keys sorted, so two equal values print equal. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The paths among `paths` that are hook files: under one of `roots` (`""` matches everything —
 * a repository whose hooks live at its root), AN ANCESTOR of one (a patch that puts a symlink at
 * `tools` moves `tools/hooks` wherever it points), one of `ancestorsOf` or an ancestor of one
 * (but nothing under it), inside a conventional hook folder at any depth
 * (`HOOK_FOLDERS_ANY_DEPTH`), a root `package.yaml`, or named like a hook manager's config at any
 * depth. `roots` may name files as well as folders (a config file git includes). Segment-wise,
 * every name folded (`foldName`). Sorted and deduped.
 */
export function hookFilesAmong(
  paths: Iterable<string>,
  roots: readonly string[],
  ancestorsOf: readonly string[] = [],
): string[] {
  const folded = [...new Set(roots.map(foldName))];
  const foldedAncestors = [...new Set(ancestorsOf.map(foldName))];
  const found = new Set<string>();
  for (const path of paths) {
    const p = foldName(path);
    const segs = p.split("/");
    const base = segs[segs.length - 1];
    const related = folded.some((root) =>
      root === "" || p === root || p.startsWith(`${root}/`) || root.startsWith(`${p}/`)
    ) || foldedAncestors.some((at) =>
      p === at || at.startsWith(`${p}/`)
    );
    if (
      related || FOLDED_NAMES.has(base) ||
      FOLDED_PREFIXES.some((prefix) => base.startsWith(prefix)) ||
      inHookFolderAnyDepth(segs) || isRootPackageYaml(path) ||
      (segs.length >= 2 && segs[segs.length - 2] === ".config" &&
        FOLDED_DOT_CONFIG.some((name) => base === name || base.startsWith(`${name}.`)))
    ) {
      found.add(path);
    }
  }
  return [...found].sort();
}

const FOLDED_FOLDERS_ANY_DEPTH = HOOK_FOLDERS_ANY_DEPTH.map((run) => run.map(foldName));
const FOLDED_DOT_CONFIG = HOOK_CONFIG_IN_DOT_CONFIG.map(foldName);

/** Whether folded segments `segs` hold one of `HOOK_FOLDERS_ANY_DEPTH` anywhere — the folder
 * itself (a link or a gitlink there) or anything under it. */
function inHookFolderAnyDepth(segs: readonly string[]): boolean {
  return FOLDED_FOLDERS_ANY_DEPTH.some((run) => {
    for (let i = 0; i + run.length <= segs.length; i++) {
      if (run.every((name, j) => segs[i + j] === name)) return true;
    }
    return false;
  });
}

/** The hook files as an answer names them: the first `HOOK_FILES_SHOWN_MAX` of the sorted list. */
export function reportHookFiles(hookFiles: readonly string[], roots: readonly string[]) {
  const sorted = [...new Set(hookFiles)].sort();
  return {
    touched: sorted.slice(0, HOOK_FILES_SHOWN_MAX),
    hooksPaths: wireRoots(roots),
    more: sorted.length > HOOK_FILES_SHOWN_MAX,
  } satisfies HookFilesReport;
}

/** Hook folders as the wire and a person read them: the root as `"."`, deduped, in order. */
export function wireRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map((root) => root === "" ? ROOT_ON_WIRE : root))];
}

/** The hook files a person has NOT been shown: every one not named, exactly, in `approved`. */
export function unapprovedHookFiles(
  hookFiles: readonly string[],
  approved: readonly string[],
): string[] {
  const seen = new Set(approved);
  return hookFiles.filter((path) => !seen.has(path));
}

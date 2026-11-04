// The check pod's entrypoints, run for real: bash, git and a temp-dir repository standing in
// for the forge's candidate repo. What is pinned is what the verdict rests on — the clone lands on
// exactly the recorded commit or fails, the credential is never written down, the changed-paths
// list says where it ends, a check's exit code passes through, 124 means the timeout, 125 the
// platform and 122 the memory pool's stop and nothing else, the pool watcher stops only the check
// furthest over its share, and no stage runs twice.

import { setDefaultTimeout, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { command } from "@ryph/process";
import {
  bakedCheckScript,
  CHECK_ENV,
  checkScript,
  cloneScript,
  poolWatch,
  type ScriptDirs,
  setupScript,
} from "../src/adapters/check_launcher/scripts.ts";
import { cloneEnv } from "../src/adapters/check_launcher/shared.ts";
import { DEFAULT_KEEP } from "../src/core/check_types.ts";
import { changedPathsFromLog } from "../src/helpers/checks.ts";
import { shellBody } from "../src/helpers/shell.ts";

// Real git and filesystem work: a slow check pod takes some tests here past 25 s, so the cap holds
// with room to spare there, and when this file runs without the package's --timeout.
setDefaultTimeout(120_000);

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; out: string }> {
  const { code, stdout, stderr } = await command(cmd, {
    args,
    cwd: opts.cwd,
    env: { ...GIT_ENV, ...opts.env },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return { code, out: decoder.decode(stdout) + decoder.decode(stderr) };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { code, out } = await run("git", args, { cwd });
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${out}`);
  return out.trim();
}

/**
 * A source repo shaped like the forge's candidate repository (forge `stageBundle`): the head on
 * `refs/heads/ryph/r-1` (HEAD), the base branch as `refs/heads/main` — moved on past the fork
 * point, as a base does, so the checks' commit (`base`) is reachable through that ref alone. With
 * `seeded`, the base is kept only as `refs/remotes/origin/main`, as a repository seeded from a
 * clone keeps it; the clone fetches both.
 */
async function sourceRepo(
  root: string,
  layout: "candidate" | "seeded" = "candidate",
  history = 0,
) {
  const src = `${root}/src`;
  await mkdir(src);
  await git(src, "init", "-q", "-b", "main");
  for (let i = 0; i < history; i++) {
    await writeFile(`${src}/h${i}.txt`, `history ${i}\n`);
    await git(src, "add", `h${i}.txt`);
    await git(src, "commit", "-q", "-m", `history ${i}`);
  }
  await writeFile(`${src}/a.txt`, "a\n");
  await writeFile(`${src}/keep.txt`, "k\n");
  await git(src, "add", ".");
  await git(src, "commit", "-q", "-m", "base");
  const base = await git(src, "rev-parse", "HEAD");
  await git(src, "checkout", "-q", "-b", "ryph/r-1");
  await writeFile(`${src}/a.txt`, "changed\n");
  await mkdir(`${src}/dir with space`);
  await writeFile(`${src}/dir with space/new.txt`, "n\n");
  await git(src, "add", ".");
  await git(src, "commit", "-q", "-m", "head");
  const head = await git(src, "rev-parse", "HEAD");
  await git(src, "checkout", "-q", "main");
  await writeFile(`${src}/later.txt`, "on the base after the fork\n");
  await git(src, "add", ".");
  await git(src, "commit", "-q", "-m", "base moves on");
  const moved = await git(src, "rev-parse", "HEAD");
  await git(src, "checkout", "-q", "ryph/r-1");
  if (layout === "seeded") {
    await git(src, "update-ref", "refs/remotes/origin/main", moved);
    await git(src, "branch", "-q", "-D", "main");
  }
  return { src, base: moved, fork: base, head };
}

async function world(layout: "candidate" | "seeded" = "candidate", history = 0) {
  const root = await mkdtemp(join(tmpdir(), "ryph-check-scripts-"));
  const dirs: ScriptDirs = {
    pristine: `${root}/pristine`,
    work: `${root}/work`,
    cgroup: `${root}/cgroup`,
    control: `${root}/control`,
  };
  await mkdir(dirs.pristine);
  await mkdir(dirs.work);
  // The container's own /tmp, where the pool watcher makes its directory.
  await mkdir(dirs.control);
  return { root, dirs, ...(await sourceRepo(root, layout, history)) };
}

const setup = (dirs: ScriptDirs, step: string, index = 0) =>
  run("bash", ["-c", setupScript(dirs)], {
    env: { RYPH_CHECK_STEP: step, RYPH_CHECK_STEP_INDEX: String(index) },
  });

/** A fresh work volume for one more check against the same pristine tree. */
async function workDir(w: Awaited<ReturnType<typeof world>>, name: string): Promise<ScriptDirs> {
  const dirs = { ...w.dirs, work: `${w.root}/${name}`, control: `${w.root}/${name}-control` };
  await mkdir(dirs.work);
  await mkdir(dirs.control);
  return dirs;
}

const clone = (w: Awaited<ReturnType<typeof world>>, env: Record<string, string> = {}) =>
  run("bash", ["-c", cloneScript(w.dirs)], {
    env: {
      RYPH_CHECK_URL: w.src,
      RYPH_CHECK_HEAD: w.head,
      RYPH_CHECK_BASE: w.base,
      GIT_TERMINAL_PROMPT: "0",
      ...env,
    },
  });

const check = (
  dirs: ScriptDirs,
  runCmd: string,
  env: Record<string, string> = {},
) =>
  run("bash", ["-c", checkScript(dirs)], {
    env: { RYPH_CHECK_RUN: runCmd, RYPH_CHECK_TIMEOUT: "60", ...env },
  });

for (const layout of ["candidate", "seeded"] as const) {
  test(`the clone lands on the recorded head and lists what the change touched (${layout})`, async () => {
    const w = await world(layout);
    try {
      const result = await clone(w);
      assertEquals(result.code, 0, result.out);
      assertEquals(await git(`${w.dirs.pristine}/repo`, "rev-parse", "HEAD"), w.head);
      // What the change touched (a.txt, the new file); what the base gained after the head
      // branched (later.txt) is not the change's.
      assertStringIncludes(result.out, "@@ryph-changed-end 2");
      assertEquals(changedPathsFromLog(result.out), {
        paths: ["a.txt", "dir with space/new.txt"],
        complete: true,
      });
    } finally {
      await rm(w.root, { recursive: true });
    }
  });
}

test("a diff that fails makes the changed paths unknown, never an empty list", async () => {
  const w = await world();
  try {
    // A `git` that fails `diff` and nothing else, first on the PATH.
    const bin = `${w.root}/bin`;
    await mkdir(bin);
    const real = (await run("sh", ["-c", "command -v git"])).out.trim();
    await writeFile(
      `${bin}/git`,
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = diff ] && exit 1; done\nexec ${real} "$@"\n`,
    );
    await chmod(`${bin}/git`, 0o755);
    const result = await clone(w, { PATH: `${bin}:${process.env.PATH}` });
    assertEquals(result.code, 0, result.out);
    assertStringIncludes(result.out, "@@ryph-changed-unknown git diff failed");
    assert(!result.out.includes("@@ryph-changed-end"), result.out);
    assertEquals(changedPathsFromLog(result.out), null);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("the checks' commit at the fork point lists the same change", async () => {
  const w = await world();
  try {
    const result = await clone(w, { RYPH_CHECK_BASE: w.fork });
    assertEquals(result.code, 0, result.out);
    assertEquals(changedPathsFromLog(result.out), {
      paths: ["a.txt", "dir with space/new.txt"],
      complete: true,
    });
    // HOME and the lists live beside the tree, never in it.
    assertEquals(await git(`${w.dirs.pristine}/repo`, "status", "--porcelain"), "");
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("the clone asks git-lfs to leave its objects alone", () => {
  const env = cloneEnv(
    {
      clone: { url: "u", env: {}, commit: "a".repeat(40), baseCommit: "b".repeat(40) },
    } as Parameters<typeof cloneEnv>[0],
  );
  assertEquals(env.GIT_LFS_SKIP_SMUDGE, "1");
});

test("a head the repository does not have fails the clone", async () => {
  const w = await world();
  try {
    const result = await clone(w, { RYPH_CHECK_HEAD: "f".repeat(40) });
    assert(result.code !== 0, result.out);
    // No end line: whatever it printed says nothing about what changed.
    assertEquals(changedPathsFromLog(result.out), null);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("a base outside the fetched history makes the changed paths unknown, not empty", async () => {
  const w = await world();
  try {
    const result = await clone(w, { RYPH_CHECK_BASE: "e".repeat(40) });
    assertEquals(result.code, 0, result.out);
    assertStringIncludes(result.out, "@@ryph-changed-unknown");
    assertEquals(changedPathsFromLog(result.out), null);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("the clone's credential rides git's env and is written nowhere in the tree", async () => {
  const w = await world();
  try {
    const result = await clone(w, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://gateway.test/.extraheader",
      GIT_CONFIG_VALUE_0: "Authorization: Basic c2VjcmV0LXRva2Vu",
    });
    assertEquals(result.code, 0, result.out);
    const grep = await run("grep", ["-r", "c2VjcmV0LXRva2Vu", w.dirs.pristine]);
    assertEquals(grep.code, 1, `the credential was written: ${grep.out}`);
    assert(!result.out.includes("c2VjcmV0LXRva2Vu"));
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("a setup step runs in the pristine tree, and what it builds every check copies", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    const built = await setup(w.dirs, "echo built > built.txt && echo 'to stderr' >&2");
    assertEquals(built.code, 0, built.out);
    // One stream: stderr is folded into stdout, so a log keeps its order.
    assertStringIncludes(built.out, "to stderr");
    const result = await check(w.dirs, "cat built.txt && git rev-parse HEAD");
    assertEquals(result.code, 0, result.out);
    assertStringIncludes(result.out, "built");
    assertStringIncludes(result.out, w.head);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("a failing setup step fails with its own exit code, except the platform's", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    assertEquals((await setup(w.dirs, "exit 9", 0)).code, 9);
    const own125 = await setup(w.dirs, "exit 125", 1);
    assertEquals(own125.code, 1, own125.out);
    assertStringIncludes(own125.out, "exited 125 by itself");
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("no stage runs twice: a second start answers the platform's code and changes nothing", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    const again = await clone(w);
    assertEquals(again.code, 125, again.out);
    assertStringIncludes(again.out, "started a second time");
    assertEquals(await git(`${w.dirs.pristine}/repo`, "rev-parse", "HEAD"), w.head);

    assertEquals((await setup(w.dirs, "echo x >> once.txt", 0)).code, 0);
    assertEquals((await setup(w.dirs, "echo x >> once.txt", 0)).code, 125);
    // Another step's index is another stage.
    assertEquals((await setup(w.dirs, "true", 1)).code, 0);
    assertEquals(await readFile(`${w.dirs.pristine}/repo/once.txt`, "utf8"), "x\n");

    assertEquals((await check(w.dirs, "echo run >> ran.txt")).code, 0);
    assertEquals((await check(w.dirs, "echo run >> ran.txt")).code, 125);
    // The copy did not nest a second tree inside the first.
    assertEquals(await readFile(`${w.dirs.work}/repo/ran.txt`, "utf8"), "run\n");
    assertEquals(await stat(`${w.dirs.work}/repo/repo`).then(() => true, () => false), false);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("a check's exit code is the container's, and the run string is one sh -c argument", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    assertEquals((await check(w.dirs, "exit 0")).code, 0);
    assertEquals((await check(await workDir(w, "w2"), "exit 3")).code, 3);
    // Quotes, semicolons and expansions mean what sh says they mean, and nothing more: the
    // entrypoint never splices the string into its own text.
    const quoted = await check(
      await workDir(w, "w3"),
      `printf '%s|' "a b" '$HOME' ; echo "; exit 7"`,
    );
    assertEquals(quoted.code, 0, quoted.out);
    assertStringIncludes(quoted.out, "a b|$HOME|; exit 7");
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("checks copy the tree: one check's writes are not the pristine tree's", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    const result = await check(w.dirs, "echo scratch > a.txt");
    assertEquals(result.code, 0, result.out);
    assertEquals(await readFile(`${w.dirs.work}/repo/a.txt`, "utf8"), "scratch\n");
    assertEquals(await readFile(`${w.dirs.pristine}/repo/a.txt`, "utf8"), "changed\n");
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("124 means the timeout: a slow check is 124, a check that says 124 or 125 itself is 1", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    const started = Date.now();
    // The grandchild matters: killing only `sh` would leave `sleep` holding the container open.
    const slow = await check(await workDir(w, "slow"), "sleep 30 & sleep 30; wait", {
      RYPH_CHECK_TIMEOUT: "1",
    });
    assertEquals(slow.code, 124, slow.out);
    assert(Date.now() - started < 15_000, "the timeout did not stop the check");
    assertStringIncludes(slow.out, "timed out after 1s");

    for (const code of [122, 124, 125]) {
      const self = await check(await workDir(w, `self-${code}`), `exit ${code}`);
      assertEquals(self.code, 1, self.out);
      assertStringIncludes(self.out, `exited ${code} by itself`);
    }
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("the timeout is the watchdog's mark, not the clock: a failure before the mark is its own", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    // The watchdog's clock is held back instead of raced: a `sleep` first on PATH turns its 1 s
    // into 30, while the command's own fractional sleep is the real one. The command fails 1.5 s
    // into a 1 s budget, so any clock would call it a timeout; the watchdog has not marked, so it
    // is the command's own 3, however loaded the machine is.
    const real = (await run("sh", ["-c", "command -v sleep"])).out.trim();
    const shims = `${w.root}/shims`;
    await mkdir(shims);
    await writeFile(
      `${shims}/sleep`,
      `#!/bin/sh\nif [ "$1" = 1 ]; then exec ${real} 30; fi\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    const early = await check(await workDir(w, "early"), "sleep 1.5; exit 3", {
      RYPH_CHECK_TIMEOUT: "1",
      PATH: `${shims}:${process.env.PATH}`,
    });
    assertEquals(early.code, 3, early.out);
    // Catches the TERM and exits 0: it still ran out of time.
    const caught = await check(
      await workDir(w, "caught"),
      "trap 'exit 0' TERM; sleep 30 & wait",
      { RYPH_CHECK_TIMEOUT: "1" },
    );
    assertEquals(caught.code, 124, caught.out);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("a check waits for its services to accept connections before it runs", async () => {
  const w = await world();
  const listener = createServer((conn) => conn.destroy());
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  try {
    assertEquals((await clone(w)).code, 0);
    const port = (listener.address() as AddressInfo).port;
    const result = await check(w.dirs, "echo ran", { RYPH_CHECK_SERVICES: `127.0.0.1:${port}` });
    assertEquals(result.code, 0, result.out);
    assertStringIncludes(result.out, "ran");
  } finally {
    listener.close();
    await rm(w.root, { recursive: true });
  }
});

test("the scripts are constants: no value of a suite is ever part of one", () => {
  // Every value reaches a container as an env var; the script text is the same for every suite.
  assertEquals(cloneScript(), cloneScript());
  assert(!checkScript().includes("RYPH_CHECK_RUN=") && checkScript().includes('"$RYPH_CHECK_RUN"'));
  assert(setupScript().includes('sh -c "$RYPH_CHECK_STEP"'));
  const baked = bakedCheckScript();
  assert(baked.includes('"$RYPH_CHECK_RUN"') && baked.includes('tree="$RYPH_CHECK_BAKED"'));
  assert(baked.includes('sh -c "${!step}"'));
  // The keep patterns reach the clean as values too.
  assert(baked.includes('-e "${!pattern-}"'));
});

test("the .sh files read only CHECK_ENV's vars and the header's constants, and all of CHECK_ENV", async () => {
  const dir = new URL("../src/adapters/check_launcher/sh/", import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sh"));
  assert(files.length >= 7, files.join(" "));
  // The code only: what a comment names is not read.
  const code = (await Promise.all(files.map((name) => readFile(new URL(name, dir), "utf8"))))
    .map(shellBody).join("\n");
  const names = new Set([...code.matchAll(/\bRYPH_[A-Z0-9_]*/g)].map(([name]) => name));
  const env: string[] = Object.values(CHECK_ENV);
  const read = [...names].filter((name) => name.startsWith("RYPH_CHECK_"));
  assertEquals(read.filter((name) => !env.includes(name)), [], "read but not in CHECK_ENV");
  assertEquals(env.filter((name) => !read.includes(name)), [], "in CHECK_ENV but never read");
  // Every other RYPH_ name is one of the header's, and no header name is an env var's.
  const header = [...cloneScript().matchAll(/^readonly (RYPH_[A-Z0-9_]+)=/gm)].map(([, n]) => n);
  assertEquals([...names].filter((n) => !n.startsWith("RYPH_CHECK_") && !header.includes(n)), []);
  assertEquals(header.filter((name) => name.startsWith("RYPH_CHECK_")), []);
  // Upper-case variables otherwise are only the shell's own.
  const others = [...code.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)].map(([, name]) => name)
    .filter((name) => !name.startsWith("RYPH_"));
  assertEquals(
    [...new Set(others)].filter((n) => !["BASHPID", "HOME", "PATH", "PPID", "RANDOM"].includes(n)),
    [],
  );
});

test("a header constant reaches no command the script starts, whatever the env held", async () => {
  const header = cloneScript().slice(0, cloneScript().indexOf("\nstarted_twice()"));
  const result = await run("bash", [
    "-c",
    `${header}\necho "$RYPH_WORK"; env | grep ^RYPH_WORK= || :`,
  ], {
    env: { RYPH_WORK: "/elsewhere" },
  });
  assertEquals(result.out.trim(), "/work");
});

test("every entrypoint parses as bash, with the header in front", async () => {
  for (const script of [cloneScript(), setupScript(), checkScript(), bakedCheckScript()]) {
    const result = await run("bash", ["-n", "-c", script]);
    assertEquals(result.code, 0, result.out);
  }
});

// ---- the suite's memory pool --------------------------------------------------------------------

const MI = 2 ** 20;

/**
 * The suite's memory pool around one check: 1000 MiB, a 250 MiB share for each check. The check's
 * container reads `used` MiB (plus 100 MiB of page cache it can drop, which is not use) in the
 * cgroup layout given, or nothing at all when `used` is null. Every check has a directory of its
 * own under the pool's (`<pool>/<name>`, as the launchers mount them); a sibling's holds its
 * `use` file, `age` seconds old: a watcher alive keeps its own fresh, and these do not move, so a
 * test is over well inside POOL_STALE_SECONDS.
 */
async function poolWorld(
  w: Awaited<ReturnType<typeof world>>,
  used: number | null,
  siblings: Record<string, { use: number; age?: number }> = {},
  layout: "v2" | "v1" = "v2",
  others: string[] = Object.keys(siblings),
) {
  const dir = `${w.root}/pool`;
  await mkdir(dir, { recursive: true });
  const cg = w.dirs.cgroup;
  await mkdir(`${cg}/memory`, { recursive: true });
  if (used !== null) {
    const bytes = String((used + 100) * MI);
    if (layout === "v2") {
      await writeFile(`${cg}/memory.current`, `${bytes}\n`);
      await writeFile(`${cg}/memory.stat`, `anon 1\ninactive_file ${100 * MI}\nfile 2\n`);
    } else {
      await writeFile(`${cg}/memory/memory.usage_in_bytes`, `${bytes}\n`);
      await writeFile(`${cg}/memory/memory.stat`, `cache 1\ntotal_inactive_file ${100 * MI}\n`);
    }
  }
  for (const name of others) await mkdir(`${dir}/${name}`, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  for (const [name, { use, age = 0 }] of Object.entries(siblings)) {
    await mkdir(`${dir}/${name}`, { recursive: true });
    await writeFile(`${dir}/${name}/use`, `${now - age} ${use * MI}\n`);
  }
  return {
    dir,
    /** The env of the check `name`, whose own directory is made here. */
    env: (name: string) => {
      mkdirSync(`${dir}/${name}`, { recursive: true });
      return {
        RYPH_CHECK_NAME: name,
        RYPH_CHECK_POOL: dir,
        RYPH_CHECK_NAMES: [name, ...others.filter((o) => o !== name)].join(" "),
        RYPH_CHECK_POOL_BYTES: String(1000 * MI),
        RYPH_CHECK_SHARE_BYTES: String(250 * MI),
      };
    },
  };
}

/** A check that would run for half a minute: one the watcher stops ends in seconds. */
const LONG = "sleep 30 & sleep 30; wait";

for (const layout of ["v2", "v1"] as const) {
  test(`the pool watcher publishes what the check uses (cgroup ${layout}) and removes it at the end`, async () => {
    const w = await world();
    try {
      assertEquals((await clone(w)).code, 0);
      const pool = await poolWorld(w, 300, {}, layout);
      // The command reads the pool as any check could: its own line, published by now.
      const result = await check(
        w.dirs,
        'sleep 1.5; cat "$RYPH_CHECK_POOL/lint/use"',
        pool.env("lint"),
      );
      assertEquals(result.code, 0, result.out);
      assertStringIncludes(result.out, ` ${300 * MI}\n`);
      // Gone with the check, and nothing of its own left for the others to sum.
      assertEquals(await readdir(`${pool.dir}/lint`), []);
    } finally {
      await rm(w.root, { recursive: true });
    }
  });
}

test("the check furthest over its share is stopped with 122 when the pool runs short", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    // 600 + 300 is 90% of the pool: short. This check is 350 over its share, the other 50.
    const pool = await poolWorld(w, 600, { test: { use: 300 } });
    const started = Date.now();
    const result = await check(w.dirs, LONG, pool.env("lint"));
    assertEquals(result.code, 122, result.out);
    assert(Date.now() - started < 15_000, "the watcher did not stop the check");
    assertStringIncludes(
      result.out,
      "ryph: stopped: the suite's checks were using 900MiB of their 1000MiB of memory, and this " +
        "check was the furthest over its share, using 600MiB against a share of 250MiB",
    );
    assertEquals(await readdir(`${pool.dir}/lint`), []);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("a check within its share is never stopped, and a stale file is no part of the pool", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    // Short (200 + 900), but this check is under its share: the other is the one over.
    const under = await poolWorld(w, 200, { test: { use: 900 } });
    const quiet = await check(w.dirs, "sleep 2.5; echo ran", under.env("lint"));
    assertEquals(quiet.code, 0, quiet.out);
    assertStringIncludes(quiet.out, "ran");
    assert(!quiet.out.includes("ryph: stopped"), quiet.out);
    // Over its share, but the pool is not short: 400 + 300. The 240 is a container that died a
    // minute ago, and counts for nothing: counted, the pool would be short (940) and this check
    // the furthest over, the dead one within its share.
    await rm(under.dir, { recursive: true });
    const roomy = await poolWorld(w, 400, { test: { use: 300 }, gone: { use: 240, age: 60 } });
    const borrowed = await check(await workDir(w, "w2"), "sleep 2.5; echo ran", roomy.env("lint"));
    assertEquals(borrowed.code, 0, borrowed.out);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("checks equally far over their shares: the first name is the one stopped", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    const second = await poolWorld(w, 500, { alpha: { use: 500 } });
    const spared = await check(w.dirs, "sleep 2.5; echo ran", second.env("beta"));
    assertEquals(spared.code, 0, spared.out);
    await rm(second.dir, { recursive: true });
    const first = await poolWorld(w, 500, { beta: { use: 500 } });
    const stopped = await check(await workDir(w, "w2"), LONG, first.env("alpha"));
    assertEquals(stopped.code, 122, stopped.out);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("a container whose memory cannot be read runs unwatched, and says so once", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    const pool = await poolWorld(w, null, { test: { use: 950 } });
    const result = await check(w.dirs, "sleep 1.5; echo ran", pool.env("lint"));
    assertEquals(result.code, 0, result.out);
    assertEquals(result.out.split("memory use cannot be read").length, 2, result.out);
    assertEquals(await readdir(`${pool.dir}/lint`), []);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("a pool without the suite's list of checks, or without this check's directory, is not set up", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    // Short and this check the furthest over, but no list to judge by: unwatched, never judged on
    // its own use alone.
    const pool = await poolWorld(w, 600, { test: { use: 300 } });
    for (const names of [{ RYPH_CHECK_NAMES: "" }, { RYPH_CHECK_NAMES: "test" }]) {
      const dirs = await workDir(w, `w${names.RYPH_CHECK_NAMES.length}`);
      const result = await check(dirs, "sleep 2.5; echo ran", { ...pool.env("lint"), ...names });
      assertEquals(result.code, 0, result.out);
      assertStringIncludes(result.out, "ran");
      assertEquals(result.out.split("pool is not set up").length, 2, result.out);
    }
    // No directory of its own mounted: the same.
    const env = pool.env("lint");
    await rm(`${pool.dir}/lint`, { recursive: true });
    const result = await check(await workDir(w, "w9"), "echo ran", env);
    assertEquals(result.code, 0, result.out);
    assertStringIncludes(result.out, "pool is not set up");
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("a suite of one check is watched: its own name is the whole list", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    // Short at 950 of 1000, and nobody else to be the one over its share.
    const pool = await poolWorld(w, 950);
    const result = await check(w.dirs, LONG, pool.env("lint"));
    assertEquals(result.code, 122, result.out);
    assertStringIncludes(result.out, "were using 950MiB of their 1000MiB");
  } finally {
    await rm(w.root, { recursive: true });
  }
});

/** A PATH whose `cp` sleeps half a minute before it copies: a copy stage long enough to stop. */
async function slowCopy(w: Awaited<ReturnType<typeof world>>): Promise<Record<string, string>> {
  const bin = `${w.root}/slow-bin`;
  await mkdir(bin, { recursive: true });
  const real = (await run("sh", ["-c", "command -v cp"])).out.trim();
  await writeFile(`${bin}/cp`, `#!/bin/sh\nsleep 30\nexec ${real} "$@"\n`);
  await chmod(`${bin}/cp`, 0o755);
  return { PATH: `${bin}:${process.env.PATH}` };
}

test("a stop that reached nothing marks nothing: the pool recovers and the check passes", async () => {
  // The reported failure: the check was the victim while nothing of it ran (it waited for its
  // services outside any group), the watcher marked it anyway, the pool recovered, the command
  // passed, and the next look at the mark failed it with 122. Every stage is a group now, so this
  // is the watcher alone around a wait that is none, as a moment between two stages is.
  const w = await world();
  try {
    const pool = await poolWorld(w, 600, { test: { use: 300 } });
    const script = [
      "exec 2>&1",
      poolWatch(w.dirs),
      "sleep 3",
      "pool_stopped",
      '[ ! -e "$pool_stop" ] || echo marked',
      "echo passed",
    ].join("\n");
    const running = run("bash", ["-c", script], { env: pool.env("lint") });
    // Short for its first ticks, then the other check is gone and the pool has room.
    await new Promise((r) => setTimeout(r, 1500));
    await rm(`${pool.dir}/test/use`);
    const result = await running;
    assertEquals(result.code, 0, result.out);
    assertStringIncludes(result.out, "passed");
    assert(!result.out.includes("ryph: stopped"), result.out);
    assert(!result.out.includes("marked"), result.out);
    // The watcher's own directory goes with it.
    assertEquals(await readdir(w.dirs.control), []);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("the copy and the wait for the services are stages the pool watcher stops", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    // The tree's copy, stopped part-way: 122, and the check never runs.
    const pool = await poolWorld(w, 600, { test: { use: 300 } });
    const started = Date.now();
    const copying = await check(w.dirs, "echo ran", {
      ...pool.env("lint"),
      ...(await slowCopy(w)),
    });
    assertEquals(copying.code, 122, copying.out);
    assert(Date.now() - started < 15_000, "the watcher did not stop the copy");
    assertStringIncludes(copying.out, "this check was the furthest over its share");
    assert(!copying.out.includes("ran"), copying.out);
    // Waiting for a service that never answers: stopped there too, long before the wait's end.
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    const waiting = await check(await workDir(w, "w2"), "echo ran", {
      ...pool.env("lint"),
      RYPH_CHECK_SERVICES: `127.0.0.1:${port}`,
    });
    assertEquals(waiting.code, 122, waiting.out);
    assertStringIncludes(waiting.out, "this check was the furthest over its share");
    assert(!waiting.out.includes("ran"), waiting.out);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("a check's verdict on itself is its own: what its file says never stops it", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    // The pool is short with the others alone (500 + 450), and the one over is not this check.
    const pool = await poolWorld(w, 100, { test: { use: 500 }, other: { use: 450 } });
    // Once it runs, its own file says it uses 900 of its 250, and keeps saying it.
    const running = check(w.dirs, "sleep 3; echo ran", pool.env("lint"));
    const forging = (async () => {
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 200));
        await writeFile(`${pool.dir}/lint/use`, `${Math.floor(Date.now() / 1000)} ${900 * MI}\n`)
          .catch(() => {});
      }
    })();
    const result = await running;
    await forging;
    assertEquals(result.code, 0, result.out);
    assertStringIncludes(result.out, "ran");
    assert(!result.out.includes("ryph: stopped"), result.out);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("a sibling's huge claim makes itself the furthest over: no other check is stopped for it", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    // This check borrows 150 above its share; the pool is short only with the claim counted.
    const pool = await poolWorld(w, 400, { liar: { use: 9_000_000 } });
    const result = await check(w.dirs, "sleep 2.5; echo ran", pool.env("lint"));
    assertEquals(result.code, 0, result.out);
    assertStringIncludes(result.out, "ran");
    assert(!result.out.includes("ryph: stopped"), result.out);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

/** The start of a `watched` body that drives the watcher's functions itself: its own loop, which
 * shares their files, is stopped first. */
const QUIET = ['kill -- "-$pool_dog"', 'wait "$pool_dog" 2>/dev/null'];

/** The watcher alone, around `body`: a script of its functions, run as a check container would. */
const watched = (dirs: ScriptDirs, body: string[], env: Record<string, string>) =>
  run("bash", ["-c", ["exec 2>&1", poolWatch(dirs), ...body].join("\n")], { env });

/** Whether a process lives: signal 0 throws once it is gone. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// `BASHPID` unset is bash 3.2's case (macOS), where the script's own pid comes from a `sh`.
for (const pids of ["BASHPID", "the fallback"] as const) {
  test(`the EXIT trap run in a child the script forked ends nothing of the script's (${pids})`, async () => {
    // A TERM that lands in a child the moment after its fork, before bash resets the
    // child's signals, runs the script's EXIT trap in the child. It killed the watcher and
    // removed the stop mark, and the check the watcher stopped failed with 143 instead of 122.
    const w = await world();
    try {
      const pool = await poolWorld(w, 100);
      const result = await watched(w.dirs, [
        ...(pids === "BASHPID" ? [] : ["unset BASHPID"]),
        'echo "watcher $pool_dog"',
        "( pool_end )",
        'kill -0 "$pool_dog" 2>/dev/null && echo "watcher alive"',
        '[ -d "$pool_ctl" ] && echo "control kept"',
        '[ -f "$pool_own/use" ] && echo "use kept"',
      ], pool.env("lint"));
      assertEquals(result.code, 0, result.out);
      for (const kept of ["watcher alive", "control kept", "use kept"]) {
        assertStringIncludes(result.out, kept);
      }
      // The script's own exit still ends them.
      assert(!alive(Number(/watcher (\d+)/.exec(result.out)?.[1])), result.out);
      assertEquals(await readdir(w.dirs.control), []);
      assertEquals(await readdir(`${pool.dir}/lint`), []);
    } finally {
      await rm(w.root, { recursive: true });
    }
  });
}

test("a watcher whose group is missing is ended by its pid", async () => {
  // Under gVisor the group can be missing the moment after the fork: a `kill` that finds no
  // group stands in for that here, and the watcher it would have left looping must still end.
  const w = await world();
  try {
    const pool = await poolWorld(w, 100);
    const result = await watched(w.dirs, [
      'echo "watcher $pool_dog"',
      'kill() { case "$*" in --\\ -[0-9]*) return 1 ;; esac; builtin kill "$@"; }',
    ], pool.env("lint"));
    assertEquals(result.code, 0, result.out);
    assert(!alive(Number(/watcher (\d+)/.exec(result.out)?.[1])), result.out);
    assertEquals(await readdir(w.dirs.control), []);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("a sibling's file is opened read-only and read only as a regular file: links swapped in do nothing", async () => {
  const w = await world();
  try {
    const pool = await poolWorld(w, 100, {}, "v2", ["test", "other", "zero"]);
    const timedOut = `${w.dirs.work}/.ryph-timed-out`;
    // What a sibling can put in its own directory after the reader's look at the path: links to
    // this container's own marks, which a read-write open would create, and to a device.
    await symlink(timedOut, `${pool.dir}/other/use`);
    await symlink("/dev/zero", `${pool.dir}/zero/use`);
    const result = await watched(w.dirs, [
      ...QUIET,
      'echo "control: $pool_ctl"',
      'ln -s "$pool_ctl/stop" "$RYPH_CHECK_POOL/test/use"',
      ': >"$pool_ctl/seen"',
      // Straight at the open, as if each were swapped in after the reader's test.
      'pool_read_one test "$RYPH_CHECK_POOL/test/use"',
      'pool_read_one other "$RYPH_CHECK_POOL/other/use"',
      'pool_read_one zero "$RYPH_CHECK_POOL/zero/use"',
      '[ ! -e "$pool_ctl/stop" ] || echo "created the stop mark"',
      `[ ! -e "${timedOut}" ] || echo "created the timeout mark"`,
      '[ ! -s "$pool_ctl/seen" ] || { echo "read:"; cat "$pool_ctl/seen"; }',
    ], pool.env("lint"));
    assertEquals(result.code, 0, result.out);
    assert(!result.out.includes("created"), result.out);
    assert(!result.out.includes("read:"), result.out);
    // Its directory is its own, made fresh.
    assert(
      new RegExp(`control: ${w.dirs.control}/\\.ryph-pool-\\d+-\\d+\\n`).test(result.out),
      result.out,
    );
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("one reader a tick, killed within the second: a FIFO costs only the files after it, that tick", async () => {
  const w = await world();
  try {
    const pool = await poolWorld(w, 100, { test: { use: 300 } }, "v2", ["fifo", "test"]);
    assertEquals((await run("mkfifo", [`${pool.dir}/fifo/use`])).code, 0);
    const result = await watched(w.dirs, [
      ...QUIET,
      'exec 7<>"$pool_ctl/done"',
      // Read without the loop's look at the path, as if the FIFO were swapped in after it.
      'pool_read_all() { local n; for n in "$@"; do pool_read_one "$n" "$pool/$n/use"; done; echo "$pool_tick" >&7; }',
      "for tick in 1 2; do",
      "  start=$(date +%s)",
      "  pool_gather",
      '  echo "tick $pool_tick took $(($(date +%s) - start))s, read: $(cut -d" " -f1 "$pool_ctl/seen" | tr "\\n" " ")"',
      "done",
    ], pool.env("lint"));
    assertEquals(result.code, 0, result.out);
    // `fifo test` rotated by one: tick 1 starts at `test` and reads it before the FIFO holds the
    // reader; tick 2 starts at the FIFO, and `test` behind it is lost, that tick only.
    const ticks = [...result.out.matchAll(/tick (\d) took (\d+)s, read: (.*)/g)];
    assertEquals(ticks.length, 2, result.out);
    assertEquals(ticks[0]![3]!.trim(), "test", result.out);
    assertEquals(ticks[1]![3]!.trim(), "", result.out);
    for (const t of ticks) assert(Number(t[2]) <= 2, result.out);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("a sibling's sparse file of NULs is 80 bytes to the reader, not a second of its CPU", async () => {
  const w = await world();
  try {
    const pool = await poolWorld(w, 100, { test: { use: 300 } }, "v2", ["sparse", "test"]);
    // 4 GiB with no blocks: past any size limit on the directory, and nothing but NULs, which
    // bash's `read -n` drops without counting.
    const twoTicks = async () => {
      const started = Date.now();
      const result = await watched(w.dirs, [
        ...QUIET,
        'exec 7<>"$pool_ctl/done"',
        "for tick in 1 2; do",
        "  pool_gather",
        '  echo "tick $pool_tick read: $(cut -d" " -f1 "$pool_ctl/seen" | tr "\\n" " ")"',
        "done",
      ], pool.env("lint"));
      return { result, took: Date.now() - started };
    };
    // The same two ticks over a small file first, as the measure of this machine: a loaded check
    // pod takes seconds over what a laptop does, so only the sparse file's own cost is judged.
    await writeFile(`${pool.dir}/sparse/use`, "x\n");
    const baseline = await twoTicks();
    assertEquals(baseline.result.code, 0, baseline.result.out);
    await writeFile(`${pool.dir}/sparse/use`, "");
    await truncate(`${pool.dir}/sparse/use`, 4 * 2 ** 30);
    const { result, took } = await twoTicks();
    assertEquals(result.code, 0, result.out);
    // Both orders, `test sparse` and `sparse test`: the reader is never held up past the sparse
    // file, never killed, and reads `test` behind it; the sparse file counts for nothing.
    const ticks = [...result.out.matchAll(/tick (\d) read: (.*)/g)];
    assertEquals(ticks.length, 2, result.out);
    for (const t of ticks) assertEquals(t[2]!.trim(), "test", result.out);
    // A reader held up would be killed at the second, in the tick that reads `test` first.
    const cost = took - baseline.took;
    assert(cost < 800, `the sparse file cost ${cost}ms over ${baseline.took}ms: ${result.out}`);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("only the suite's checks count: directories under any other name are no part of the pool", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    // This check borrows 150 above its share; the suite's other check has no file. Counted, the
    // forged files would make the pool short (400 + 600) and this check the one over.
    const pool = await poolWorld(w, 400, {}, "v2", ["test"]);
    const now = Math.floor(Date.now() / 1000);
    for (const name of ["a", "b", "c"]) {
      await mkdir(`${pool.dir}/${name}`);
      await writeFile(`${pool.dir}/${name}/use`, `${now} ${200 * MI}\n`);
    }
    // And at the pool's top, where a single shared directory once kept them.
    for (const name of ["d", "e", "f"]) {
      await writeFile(`${pool.dir}/${name}`, `${now} ${200 * MI}\n`);
    }
    const result = await check(w.dirs, "sleep 2.5; echo ran", pool.env("lint"));
    assertEquals(result.code, 0, result.out);
    assertStringIncludes(result.out, "ran");
    assert(!result.out.includes("ryph: stopped"), result.out);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("the watcher's directory is always made fresh: one already there is never used", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    const pool = await poolWorld(w, 100);
    // What an image could leave in the container's /tmp: marks that would fail or hold a stage.
    for (const mark of ["stop", "stopping", "target"]) {
      await mkdir(`${w.dirs.control}/${mark}`);
      await mkdir(`${w.dirs.control}/.ryph-pool/${mark}`, { recursive: true });
    }
    const started = Date.now();
    const result = await check(w.dirs, "echo ran", pool.env("lint"));
    assertEquals(result.code, 0, result.out);
    assertStringIncludes(result.out, "ran");
    assert(Date.now() - started < 4_000, "a stage waited on a stop that was not under way");
    // A /tmp that is a link (an image could point it anywhere): unwatched.
    const dirs = await workDir(w, "w2");
    const elsewhere = `${w.root}/elsewhere`;
    await mkdir(elsewhere);
    await rm(dirs.control, { recursive: true });
    await symlink(elsewhere, dirs.control);
    const linked = await check(dirs, "echo ran", pool.env("lint"));
    assertEquals(linked.code, 0, linked.out);
    assertStringIncludes(linked.out, "no directory of this container's own can be made");
    assertEquals(await readdir(elsewhere), []);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("a stop that lands on what a finished stage left running fails no later stage", async () => {
  const w = await world();
  try {
    // Short, and this check the furthest over, for the whole test.
    const pool = await poolWorld(w, 600, { test: { use: 300 } });
    const result = await watched(w.dirs, [
      // A stage that passes and leaves a child running in its group.
      "pool_stage sh -c 'sleep 30 >/dev/null 2>&1 & exit 0'",
      'echo "first $pool_last"',
      // Its own look comes late: the watcher has stopped what it left by then.
      "sleep 2.5",
      '[ ! -f "$pool_stop" ] || echo "a mark for $(head -n 1 "$pool_stop")"',
      "pool_stage true",
      "pool_stopped",
      // A target that names a group long gone: the TERM reaches nothing, and nothing is marked.
      "sh -c true & dead=$!",
      'wait "$dead"',
      'echo "$dead" >"$pool_target"',
      "pool_last=$dead",
      "sleep 4",
      '[ -e "$pool_stop" ] || [ -e "$pool_stopping" ] || echo clean',
      "pool_stopped",
      "echo passed",
    ], pool.env("lint"));
    assertEquals(result.code, 0, result.out);
    const first = /first (\d+)/.exec(result.out)?.[1];
    assertStringIncludes(result.out, `a mark for ${first}\n`);
    assertStringIncludes(result.out, "clean\n");
    assertStringIncludes(result.out, "passed");
    assert(!result.out.includes("ryph: stopped"), result.out);
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("a watcher's directory the head removed costs it its watching, and says nothing in the log", async () => {
  const w = await world();
  try {
    const pool = await poolWorld(w, 100);
    const result = await watched(w.dirs, [
      'rm -rf "$pool_ctl"',
      "pool_stage true",
      "pool_stopped",
      "pool_stage true",
      "pool_stopped",
      "echo done",
    ], pool.env("lint"));
    assertEquals(result.code, 0, result.out);
    assertEquals(result.out, "done\n");
  } finally {
    await rm(w.root, { recursive: true });
  }
});

test("a sibling's file that is not two plain numbers counts for nothing and stops no watcher", async () => {
  const w = await world();
  try {
    assertEquals((await clone(w)).code, 0);
    // Short and this check the furthest over (600 + 300), whatever else is in the pool. Every
    // name below is one of the suite's, so each is read.
    const names = ["test", "octal", "huge", "extra", "long", "big", "fifo", "link", "zero", "dir"];
    const pool = await poolWorld(w, 600, { test: { use: 300 } }, "v2", names);
    const now = Math.floor(Date.now() / 1000);
    // A leading zero (bash reads it as octal, and `08` aborts arithmetic), a count past 64 bits,
    // a third field (the format is two), a line far past any real one, a file of 8 MiB, a FIFO
    // nobody writes, a link to a file that would make it the furthest over, a link to a device,
    // and a directory where the file goes.
    await writeFile(`${pool.dir}/octal/use`, "08 1\n");
    await writeFile(`${pool.dir}/huge/use`, `${now} 9999999999999999999\n`);
    await writeFile(`${pool.dir}/extra/use`, `${now} ${5000 * MI} 1\n`);
    await writeFile(`${pool.dir}/long/use`, `${now} ${"9".repeat(200)}\n`);
    await writeFile(`${pool.dir}/big/use`, `${now} ${5000 * MI}`.padEnd(8 * MI, "7"));
    assertEquals((await run("mkfifo", [`${pool.dir}/fifo/use`])).code, 0);
    await writeFile(`${w.root}/elsewhere`, `${now} ${5000 * MI}\n`);
    await symlink(`${w.root}/elsewhere`, `${pool.dir}/link/use`);
    await symlink("/dev/zero", `${pool.dir}/zero/use`);
    await mkdir(`${pool.dir}/dir/use`);
    const started = Date.now();
    const result = await check(w.dirs, LONG, pool.env("lint"));
    assertEquals(result.code, 122, result.out);
    assert(Date.now() - started < 15_000, "the watcher did not stop the check");
    assertStringIncludes(result.out, "were using 900MiB of their 1000MiB");
  } finally {
    await rm(w.root, { recursive: true });
  }
});

// ---- a check in the checkout the image baked ---------------------------------------------------

/**
 * A world whose "image" baked a checkout of the repo at the fork point, as the environment build
 * leaves one: cloned (so it has the build's own branch and remote), with ignored build output, a
 * file the bake left untracked, and a tracked file someone touched. The pristine tree is cloned
 * and then made read-only, as the check containers mount it.
 */
async function bakedWorld(
  opts: { onHead?: (src: string) => Promise<void>; history?: number } = {},
) {
  const w = await world("candidate", opts.history);
  if (opts.onHead !== undefined) {
    // One more commit on the head branch: the head the clone and the move go to.
    // What it stages itself (a gitlink) stays staged; the files it wrote are added.
    await opts.onHead(w.src);
    await git(w.src, "add", "--ignore-removal", ".");
    await git(w.src, "commit", "-q", "-m", "more of the head");
    w.head = await git(w.src, "rev-parse", "HEAD");
  }
  const result = await clone(w);
  assertEquals(result.code, 0, result.out);
  const baked = `${w.root}/image/ryph/work/repo`;
  await mkdir(`${w.root}/image/ryph/work`, { recursive: true });
  await git(w.root, "clone", "-q", w.src, baked);
  await git(baked, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", w.fork);
  await writeFile(`${baked}/.git/info/exclude`, "target/\n");
  await mkdir(`${baked}/target`);
  await writeFile(`${baked}/target/out.bin`, "built by the image\n");
  await writeFile(`${baked}/stray.txt`, "left by the bake\n");
  await writeFile(`${baked}/a.txt`, "touched\n");
  // Old mtimes, so a file the move rewrote is told from one it left alone.
  const old = new Date("2020-01-01T00:00:00Z");
  for (const f of ["keep.txt", "target/out.bin"]) await utimes(`${baked}/${f}`, old, old);
  await writable(w.dirs.pristine, false);
  return { ...w, baked, old };
}

/** `chmod -R a-w` (or `u+w`), as a read-only mount stands in for one. */
async function writable(path: string, on: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  const mode = info.mode & 0o777;
  await chmod(path, on ? mode | 0o200 : mode & ~0o222);
  if (info.isDirectory()) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      await writable(`${path}/${entry.name}`, on);
    }
  }
}

async function dropBaked(w: Awaited<ReturnType<typeof bakedWorld>>) {
  await writable(w.dirs.pristine, true);
  // A fallback's copy keeps the modes `writable` took from the pristine tree to fake its mount.
  await writable(w.baked, true).catch(() => {});
  await rm(w.root, { recursive: true });
}

const bakedCheck = (
  w: Awaited<ReturnType<typeof bakedWorld>>,
  runCmd: string,
  env: Record<string, string> = {},
  setupSteps: string[] = [],
  keep: readonly string[] = DEFAULT_KEEP,
) =>
  run("bash", ["-c", bakedCheckScript(w.dirs)], {
    env: {
      RYPH_CHECK_RUN: runCmd,
      RYPH_CHECK_TIMEOUT: "60",
      RYPH_CHECK_BAKED: w.baked,
      RYPH_CHECK_HEAD: w.head,
      RYPH_CHECK_SETUP_COUNT: String(setupSteps.length),
      ...Object.fromEntries(setupSteps.map((step, i) => [`RYPH_CHECK_SETUP_${i}`, step])),
      RYPH_CHECK_KEEP_COUNT: String(keep.length),
      ...Object.fromEntries(keep.map((pattern, i) => [`RYPH_CHECK_KEEP_${i}`, pattern])),
      ...env,
    },
  });

/** A move that failed and fell back: the check ran, cold, in a copy of the clone where the baked
 * checkout was, with none of the image's build output. */
async function assertFellBack(
  w: Awaited<ReturnType<typeof bakedWorld>>,
  result: { code: number; out: string },
) {
  assertEquals(result.code, 0, result.out);
  assertStringIncludes(result.out, "checking a copy of the clone instead");
  assertEquals(await readFile(`${w.baked}/ran.txt`, "utf8"), "ran\n");
  assertEquals(await git(w.baked, "rev-parse", "HEAD"), w.head);
  assertEquals(await stat(`${w.baked}/target`).then(() => true, () => false), false);
}

test("a baked check moves the image's checkout to the head in place, keeping the kept output", async () => {
  const w = await bakedWorld();
  try {
    const result = await bakedCheck(w, "git rev-parse HEAD && cat a.txt && pwd");
    assertEquals(result.code, 0, result.out);
    assertStringIncludes(result.out, `moved the baked checkout at ${w.baked} to ${w.head}`);
    assertStringIncludes(result.out, w.head);
    assertStringIncludes(result.out, "changed");
    assertStringIncludes(result.out, w.baked);
    // The head's files, its new directory included; the touched file is the head's again.
    assertEquals(await readFile(`${w.baked}/a.txt`, "utf8"), "changed\n");
    assertEquals(await readFile(`${w.baked}/dir with space/new.txt`, "utf8"), "n\n");
    // Untracked and not ignored: gone. Ignored build output a keep pattern names: kept, mtime
    // and all.
    assertEquals(await stat(`${w.baked}/stray.txt`).then(() => true, () => false), false);
    assertEquals(await readFile(`${w.baked}/target/out.bin`, "utf8"), "built by the image\n");
    assertEquals((await stat(`${w.baked}/target/out.bin`)).mtime, w.old);
    // A file the two commits share is not rewritten, so its build stays fresh.
    assertEquals((await stat(`${w.baked}/keep.txt`)).mtime, w.old);
    // Its git sees what a copy of the clone would: the clone's branches, none of the image's.
    const refs = (await git(w.baked, "for-each-ref", "--format=%(refname)")).split("\n");
    assertEquals(refs.sort(), ["refs/remotes/src/main", "refs/remotes/src/ryph/r-1"]);
    assertEquals(await git(w.baked, "status", "--porcelain", "--untracked-files=all"), "");
  } finally {
    await dropBaked(w);
  }
});

test("a baked check says which lockfiles the head changes from the image's commit", async () => {
  const w = await bakedWorld({
    onHead: async (src) => {
      await mkdir(`${src}/crates/a`, { recursive: true });
      await writeFile(`${src}/crates/a/Cargo.lock`, "# new\n");
      await writeFile(`${src}/requirements-dev.txt`, "pytest\n");
      // Named like one, but not a lockfile: not listed.
      await writeFile(`${src}/Cargo.lock.md`, "notes\n");
    },
  });
  try {
    const result = await bakedCheck(w, "true");
    assertEquals(result.code, 0, result.out);
    assertStringIncludes(result.out, "the head changes lockfiles from the image's commit");
    assertStringIncludes(result.out, "\n  crates/a/Cargo.lock\n");
    assertStringIncludes(result.out, "\n  requirements-dev.txt\n");
    assertEquals(result.out.includes("Cargo.lock.md"), false, result.out);
  } finally {
    await dropBaked(w);
  }
  // A head that changes none says nothing about them.
  const plain = await bakedWorld();
  try {
    const result = await bakedCheck(plain, "true");
    assertEquals(result.code, 0, result.out);
    assertEquals(result.out.includes("lockfiles"), false, result.out);
  } finally {
    await dropBaked(plain);
  }
});

test("a baked check runs every setup step in its tree, in order, before the check", async () => {
  const w = await bakedWorld();
  try {
    const result = await bakedCheck(w, "cat steps.txt", {}, [
      "echo one >> steps.txt && echo 'to stderr' >&2",
      `printf '%s\\n' "two words" >> steps.txt`,
    ]);
    assertEquals(result.code, 0, result.out);
    assertStringIncludes(result.out, "to stderr");
    assertStringIncludes(result.out, "one\ntwo words\n");
    assertStringIncludes(result.out, "setup step 2 of 2");
  } finally {
    await dropBaked(w);
  }
});

test("a baked check's failing setup step is its failure, and the check never runs", async () => {
  for (const [code, expected] of [[9, 9], [122, 1], [124, 1], [125, 1]]) {
    const w = await bakedWorld();
    try {
      const result = await bakedCheck(w, "echo ran > ran.txt", {}, ["true", `exit ${code}`]);
      assertEquals(result.code, expected, result.out);
      assertStringIncludes(result.out, `setup step 2 exited ${code}`);
      assertEquals(await stat(`${w.baked}/ran.txt`).then(() => true, () => false), false);
    } finally {
      await dropBaked(w);
    }
  }
});

test("a baked check's setup is watched too: a step the pool stops fails the check with 122", async () => {
  const w = await bakedWorld();
  try {
    const pool = await poolWorld(w, 600, { test: { use: 300 } });
    const started = Date.now();
    const result = await bakedCheck(w, "echo ran > ran.txt", pool.env("lint"), [LONG]);
    assertEquals(result.code, 122, result.out);
    assert(Date.now() - started < 15_000, "the watcher did not stop the setup step");
    assertStringIncludes(result.out, "this check was the furthest over its share");
    assertEquals(await stat(`${w.baked}/ran.txt`).then(() => true, () => false), false);
  } finally {
    await dropBaked(w);
  }
});

test("a baked check keeps the verdict rules: its code, 124 for the timeout, 1 for its own 124", async () => {
  const w = await bakedWorld();
  try {
    assertEquals((await bakedCheck(w, "exit 3")).code, 3);
  } finally {
    await dropBaked(w);
  }
  const slow = await bakedWorld();
  try {
    const result = await bakedCheck(slow, "sleep 30 & sleep 30; wait", { RYPH_CHECK_TIMEOUT: "1" });
    assertEquals(result.code, 124, result.out);
    assertStringIncludes(result.out, "timed out after 1s");
    // The mark lives outside the tree the check works in.
    assertEquals(await git(slow.baked, "status", "--porcelain"), "");
  } finally {
    await dropBaked(slow);
  }
  const own = await bakedWorld();
  try {
    const result = await bakedCheck(own, "exit 124");
    assertEquals(result.code, 1, result.out);
  } finally {
    await dropBaked(own);
  }
});

test("a baked check never runs twice, and a missing or unmovable checkout is the platform's", async () => {
  const w = await bakedWorld();
  try {
    assertEquals((await bakedCheck(w, "echo run >> ran.txt")).code, 0);
    const again = await bakedCheck(w, "echo run >> ran.txt");
    assertEquals(again.code, 125, again.out);
    assertStringIncludes(again.out, "started a second time");
    assertEquals(await readFile(`${w.baked}/ran.txt`, "utf8"), "run\n");

    const missing = await bakedCheck(w, "true", { RYPH_CHECK_BAKED: `${w.root}/nowhere` });
    assertEquals(missing.code, 125, missing.out);
    assertStringIncludes(missing.out, "the image has no checkout");
  } finally {
    await dropBaked(w);
  }
  const wrong = await bakedWorld();
  try {
    // A head the clone does not hold: the move fails, and nothing of the head's runs.
    const result = await bakedCheck(wrong, "echo ran > ran.txt", {
      RYPH_CHECK_HEAD: "f".repeat(40),
    });
    // The copy of the clone is not at that head either: that is the platform's.
    assertEquals(result.code, 125, result.out);
    assertStringIncludes(result.out, "could not move the baked checkout");
    assertStringIncludes(result.out, "into");
    assertEquals(await stat(`${wrong.baked}/ran.txt`).then(() => true, () => false), false);
  } finally {
    await dropBaked(wrong);
  }
});

test("the move runs none of the checkout's hooks or fsmonitor, even where the head plants them", async () => {
  // Husky, installed by the image's setup, points the checkout's hooks into the tree; the head
  // adds a hook there that would fail the checkout.
  const w = await bakedWorld({
    onHead: async (src) => {
      await mkdir(`${src}/.husky`);
      await writeFile(`${src}/.husky/post-checkout`, "#!/bin/sh\necho hooked\nexit 3\n");
      await chmod(`${src}/.husky/post-checkout`, 0o755);
    },
  });
  try {
    const touched = `${w.root}/fsmonitor-ran`;
    const monitor = `${w.root}/fsmonitor.sh`;
    await writeFile(monitor, `#!/bin/sh\ntouch '${touched}'\nexit 1\n`);
    await chmod(monitor, 0o755);
    await git(w.baked, "config", "core.hooksPath", ".husky");
    await git(w.baked, "config", "core.fsmonitor", monitor);
    const result = await bakedCheck(w, "git rev-parse HEAD");
    assertEquals(result.code, 0, result.out);
    assert(!result.out.includes("hooked"), result.out);
    assertEquals(await stat(touched).then(() => true, () => false), false);
  } finally {
    await dropBaked(w);
  }
});

test("the move reads none of the image's global git config: an LFS filter there fetches nothing", async () => {
  const w = await bakedWorld({
    onHead: async (src) => {
      await writeFile(`${src}/.gitattributes`, "big.bin filter=lfs\n");
      await writeFile(`${src}/big.bin`, "a pointer, or the object\n");
    },
  });
  try {
    // The image's global config: a required filter whose smudge cannot reach anything.
    const global = `${w.root}/image-gitconfig`;
    await writeFile(
      global,
      '[filter "lfs"]\n\tsmudge = false\n\tprocess = false\n\trequired = true\n',
    );
    const result = await bakedCheck(w, "cat big.bin", { GIT_CONFIG_GLOBAL: global });
    assertEquals(result.code, 0, result.out);
    assertStringIncludes(result.out, "a pointer, or the object");
  } finally {
    await dropBaked(w);
  }
});

test("the image's replace refs go before the checkout: the tree is the head's", async () => {
  const w = await bakedWorld();
  try {
    // Without its refs going first, the checkout of the head would write the fork's tree and
    // HEAD would still say the head.
    await git(w.baked, "replace", w.head, w.fork);
    const result = await bakedCheck(w, "cat a.txt");
    assertEquals(result.code, 0, result.out);
    assertEquals(await readFile(`${w.baked}/a.txt`, "utf8"), "changed\n");
    // No remote and no reflog of the image's: what a run's adoption leaves too.
    assertEquals(await git(w.baked, "remote"), "");
    assertEquals(await git(w.baked, "reflog", "show", "--all"), "");
  } finally {
    await dropBaked(w);
  }
});

test("a tree the move cannot make the head's falls back to a copy: flagged index entries, a sparse checkout", async () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const w = await bakedWorld();
    try {
      // The two commits share keep.txt, so the checkout leaves it, and the flag hides the edit.
      await git(w.baked, "update-index", flag, "keep.txt");
      await writeFile(`${w.baked}/keep.txt`, "stale\n");
      const result = await bakedCheck(w, "echo ran > ran.txt");
      assertStringIncludes(result.out, "skip-worktree or assume-unchanged");
      assertStringIncludes(result.out, "keep.txt");
      await assertFellBack(w, result);
      // The copy has the head's file, not the hidden edit.
      assertEquals(await readFile(`${w.baked}/keep.txt`, "utf8") !== "stale\n", true);
    } finally {
      await dropBaked(w);
    }
  }
  // A sparse checkout leaves the files outside it flagged skip-worktree, and a file the head did
  // not change keeps its flag through the checkout: the flag fails the move.
  const sparse = await bakedWorld();
  try {
    // The fixture's old mtime on keep.txt reads as an edit until the index is refreshed.
    await git(sparse.baked, "update-index", "-q", "--refresh").catch(() => "");
    await git(sparse.baked, "sparse-checkout", "set", "--no-cone", "/a.txt");
    assertEquals(await stat(`${sparse.baked}/keep.txt`).then(() => true, () => false), false);
    const result = await bakedCheck(sparse, "echo ran > ran.txt");
    assertStringIncludes(result.out, "skip-worktree or assume-unchanged");
    await assertFellBack(sparse, result);
    assertEquals(await stat(`${sparse.baked}/keep.txt`).then(() => true, () => false), true);
  } finally {
    await dropBaked(sparse);
  }
});

test("a submodule the image left at another commit than the head's falls back to a copy", async () => {
  let s1 = "";
  const w = await bakedWorld({
    onHead: async (src) => {
      const sub = `${src}/../sub`;
      await mkdir(sub);
      await git(sub, "init", "-q", "-b", "main");
      await writeFile(`${sub}/s.txt`, "one\n");
      await git(sub, "add", ".");
      await git(sub, "commit", "-q", "-m", "s1");
      s1 = await git(sub, "rev-parse", "HEAD");
      await writeFile(`${sub}/s.txt`, "two\n");
      await git(sub, "commit", "-q", "-am", "s2");
      const s2 = await git(sub, "rev-parse", "HEAD");
      await writeFile(
        `${src}/.gitmodules`,
        '[submodule "sub"]\n\tpath = sub\n\turl = ../sub\n',
      );
      await git(src, "update-index", "--add", "--cacheinfo", `160000,${s2},sub`);
    },
  });
  try {
    // The image initialised it, at the older commit.
    await git(w.root, "clone", "-q", `${w.root}/sub`, `${w.baked}/sub`);
    await git(w.baked, "config", "submodule.sub.url", "../sub");
    await git(`${w.baked}/sub`, "-c", "advice.detachedHead=false", "checkout", "-q", s1);
    const result = await bakedCheck(w, "echo ran > ran.txt");
    assertStringIncludes(result.out, "submodules that are not at the head's commits");
    await assertFellBack(w, result);
  } finally {
    await dropBaked(w);
  }
});

test("a baked check removes the image's ignored files except what keep names", async () => {
  const stale = async (w: Awaited<ReturnType<typeof bakedWorld>>) => {
    // Output of a generator the head no longer has, ignored like the build cache.
    await writeFile(`${w.baked}/.git/info/exclude`, "target/\ngen/\nnode_modules/\n");
    await mkdir(`${w.baked}/gen`);
    await writeFile(`${w.baked}/gen/types.ts`, "stale\n");
    await mkdir(`${w.baked}/dir with space/node_modules/dep`, { recursive: true });
    await writeFile(`${w.baked}/dir with space/node_modules/dep/i.js`, "dep\n");
  };
  const exists = (path: string) => stat(path).then(() => true, () => false);
  const w = await bakedWorld();
  try {
    await stale(w);
    const result = await bakedCheck(w, "test ! -e gen/types.ts");
    assertEquals(result.code, 0, result.out);
    // The default keeps the caches, at any depth, and nothing else ignored.
    assert(await exists(`${w.baked}/target/out.bin`));
    assert(await exists(`${w.baked}/dir with space/node_modules/dep/i.js`));
    assertEquals(await exists(`${w.baked}/gen`), false);
  } finally {
    await dropBaked(w);
  }
  const kept = await bakedWorld();
  try {
    await stale(kept);
    // Declared, it replaces the default; patterns with spaces and anchors are one value each.
    const result = await bakedCheck(kept, "cat gen/types.ts", {}, [], ["/gen", "no such *"]);
    assertEquals(result.code, 0, result.out);
    assertStringIncludes(result.out, "stale");
    assertEquals(await exists(`${kept.baked}/target`), false);
    assertEquals(await exists(`${kept.baked}/dir with space/node_modules`), false);
  } finally {
    await dropBaked(kept);
  }
});

test("the move fetches only what the head adds to the image's commit, and leaves no ref of its own", async () => {
  // History under the image's commit, so a fetch that sends all of it is told from one that
  // sends the head's commits alone.
  const w = await bakedWorld({ history: 40 });
  try {
    // The image has no object of the head: none of the clone's branches, and its own gone.
    for (const ref of (await git(w.baked, "for-each-ref", "--format=%(refname)")).split("\n")) {
      await git(w.baked, "update-ref", "-d", ref);
    }
    await git(w.baked, "reflog", "expire", "--expire=now", "--all");
    await git(w.baked, "gc", "-q", "--prune=now");
    const has = (sha: string) => run("git", ["-C", w.baked, "cat-file", "-e", sha]);
    assert((await has(w.head)).code !== 0);
    // Loose and packed alike: the move's git reads none of the checkout's own config, so how the
    // fetch stores what it was sent is git's default.
    const inPack = async () => {
      const lines = (await git(w.baked, "count-objects", "-v")).split("\n");
      const field = (name: string) =>
        Number(lines.find((l) => l.startsWith(`${name}: `))!.slice(name.length + 2));
      return field("count") + field("in-pack");
    };
    const before = await inPack();
    assert(before > 120, `${before}`);
    const result = await bakedCheck(w, "git rev-parse HEAD");
    assertEquals(result.code, 0, result.out);
    const sent = (await inPack()) - before;
    assert(sent > 0 && sent < 20, `the fetch sent ${sent} objects`);
    assertEquals(await git(w.baked, "for-each-ref", "--format=%(refname)", "refs/ryph"), "");
    const refs = (await git(w.baked, "for-each-ref", "--format=%(refname)")).split("\n");
    assertEquals(refs.sort(), ["refs/remotes/src/main", "refs/remotes/src/ryph/r-1"]);
  } finally {
    await dropBaked(w);
  }
});

test("a fallback removes a baked tree with read-only directories in it", async () => {
  const w = await bakedWorld();
  try {
    // A module cache, as Go writes it: directories without write permission.
    await mkdir(`${w.baked}/target/mod/pkg`, { recursive: true });
    await writeFile(`${w.baked}/target/mod/pkg/f.go`, "package pkg\n");
    await chmod(`${w.baked}/target/mod/pkg`, 0o555);
    await chmod(`${w.baked}/target/mod`, 0o555);
    await git(w.baked, "update-index", "--skip-worktree", "keep.txt");
    const result = await bakedCheck(w, "echo ran > ran.txt");
    await assertFellBack(w, result);
  } finally {
    await dropBaked(w);
  }
});

test("no git config or attributes the image left, from any source, applies to the move", async () => {
  // A filter the head's attributes name, and line endings the head's do not ask for. Each source
  // below defines one or the other; the move stays warm, the smudge never runs, and the files are
  // the head's bytes.
  const crlfTree = async (w: Awaited<ReturnType<typeof bakedWorld>>) => {
    const dir = `${w.root}/attrsrc`;
    await mkdir(dir);
    await git(dir, "init", "-q", "-b", "main");
    await writeFile(`${dir}/.gitattributes`, "* text eol=crlf\n");
    await git(dir, "add", ".");
    await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a");
    await git(w.baked, "fetch", "-q", dir, "main:refs/attrsrc");
    return await git(w.baked, "rev-parse", "refs/attrsrc^{tree}");
  };
  const cases: Array<
    [
      string,
      (w: Awaited<ReturnType<typeof bakedWorld>>, mark: string) => Promise<Record<string, string>>,
    ]
  > = [
    ["a local filter", async (w, mark) => {
      await git(w.baked, "config", "filter.evil.smudge", `touch ${mark}; cat`);
      return {};
    }],
    ["a worktree config's filter", async (w, mark) => {
      await git(w.baked, "config", "extensions.worktreeConfig", "true");
      await git(w.baked, "config", "--worktree", "filter.evil.smudge", `touch ${mark}; cat`);
      return {};
    }],
    ["an include", async (w, mark) => {
      await writeFile(`${w.root}/inc`, `[filter "evil"]\n\tsmudge = touch ${mark}; cat\n`);
      await git(w.baked, "config", "include.path", `${w.root}/inc`);
      return {};
    }],
    ["GIT_CONFIG_COUNT in the env", (_w, mark) =>
      Promise.resolve({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "filter.evil.smudge",
        GIT_CONFIG_VALUE_0: `touch ${mark}; cat`,
      })],
    ["GIT_CONFIG in the env", async (w, mark) => {
      await writeFile(`${w.root}/cfg`, `[filter "evil"]\n\tsmudge = touch ${mark}; cat\n`);
      return { GIT_CONFIG: `${w.root}/cfg` };
    }],
    ["a URL rewrite to a command transport", async (w, mark) => {
      await git(w.baked, "config", "protocol.ext.allow", "always");
      await git(w.baked, "config", `url.ext::sh -c touch% ${mark}.insteadOf`, w.dirs.pristine);
      return {};
    }],
    ["core.autocrlf", async (w) => {
      await git(w.baked, "config", "core.autocrlf", "true");
      return {};
    }],
    [".git/info/attributes", async (w) => {
      await writeFile(`${w.baked}/.git/info/attributes`, "* text eol=crlf\n");
      return {};
    }],
    ["attr.tree", async (w) => {
      await git(w.baked, "config", "attr.tree", await crlfTree(w));
      return {};
    }],
    ["GIT_ATTR_SOURCE in the env", async (w) => ({ GIT_ATTR_SOURCE: await crlfTree(w) })],
    ["a sparse checkout's config", async (w) => {
      await git(w.baked, "config", "core.sparseCheckout", "true");
      await writeFile(`${w.baked}/.git/info/sparse-checkout`, "/keep.txt\n");
      return {};
    }],
  ];
  for (const [what, plant] of cases) {
    const w = await bakedWorld({
      onHead: async (src) => {
        await writeFile(`${src}/.gitattributes`, "*.txt filter=evil\n");
      },
    });
    const mark = `${w.root}/smudged`;
    try {
      const env = await plant(w, mark);
      const result = await bakedCheck(w, "echo ran > ran.txt", env);
      assertEquals(result.code, 0, `${what}: ${result.out}`);
      assertStringIncludes(result.out, "moved the baked checkout", what);
      assertEquals(await stat(mark).then(() => true, () => false), false, what);
      assertEquals(await readFile(`${w.baked}/a.txt`, "utf8"), "changed\n", what);
      assertEquals(await git(w.baked, "rev-parse", "HEAD"), w.head, what);
    } finally {
      await dropBaked(w);
    }
  }
});

test("a repository the move cannot vouch for falls back: kept elsewhere, an unknown extension", async () => {
  // `.git/commondir`: git would read config and objects from there, past the rewrite.
  const common = await bakedWorld({
    onHead: async (src) => {
      await writeFile(`${src}/.gitattributes`, "*.txt filter=evil\n");
    },
  });
  const mark = `${common.root}/smudged`;
  try {
    const elsewhere = `${common.root}/elsewhere`;
    await mkdir(elsewhere);
    for (const part of ["objects", "refs", "config", "packed-refs"]) {
      await rename(`${common.baked}/.git/${part}`, `${elsewhere}/${part}`).catch(() => {});
    }
    await writeFile(`${common.baked}/.git/commondir`, `${elsewhere}\n`);
    await git(common.baked, "config", "filter.evil.smudge", `touch ${mark}; cat`);
    const result = await bakedCheck(common, "echo ran > ran.txt");
    assertStringIncludes(result.out, ".git/commondir");
    await assertFellBack(common, result);
    assertEquals(await stat(mark).then(() => true, () => false), false);
  } finally {
    await dropBaked(common);
  }
  const ext = await bakedWorld();
  try {
    await git(ext.baked, "config", "core.repositoryformatversion", "1");
    await git(ext.baked, "config", "extensions.frobnicate", "true");
    const result = await bakedCheck(ext, "echo ran > ran.txt");
    assertStringIncludes(result.out, "extensions.frobnicate");
    await assertFellBack(ext, result);
  } finally {
    await dropBaked(ext);
  }
});

test("a broken .git never leads the move to a repository above the tree", async () => {
  const w = await bakedWorld({
    onHead: async (src) => {
      await writeFile(`${src}/.gitattributes`, "*.txt filter=evil\n");
    },
  });
  const mark = `${w.root}/parent-smudged`;
  try {
    // A repository just above the checkout, with a filter its attributes would run.
    const parent = `${w.root}/image/ryph/work`;
    await git(parent, "init", "-q", "-b", "main");
    await git(parent, "config", "filter.evil.smudge", `touch ${mark}; cat`);
    await rm(`${w.baked}/.git/HEAD`);
    const result = await bakedCheck(w, "echo ran > ran.txt");
    assertEquals(await stat(mark).then(() => true, () => false), false, result.out);
    await assertFellBack(w, result);
  } finally {
    await dropBaked(w);
  }
});

test("files the image left where the head has a submodule fail the move", async () => {
  let sub = "";
  const w = await bakedWorld({
    onHead: async (src) => {
      const repo = `${src}/../libsub`;
      await mkdir(repo);
      await git(repo, "init", "-q", "-b", "main");
      await writeFile(`${repo}/s.txt`, "s\n");
      await git(repo, "add", ".");
      await git(repo, "commit", "-q", "-m", "s");
      sub = await git(repo, "rev-parse", "HEAD");
      await git(src, "update-index", "--add", "--cacheinfo", `160000,${sub},lib`);
    },
  });
  try {
    // The image had plain files at `lib`; `git clean` does not go into a gitlink's directory.
    await mkdir(`${w.baked}/lib/target`, { recursive: true });
    await writeFile(`${w.baked}/lib/u.txt`, "stale\n");
    await writeFile(`${w.baked}/lib/target/o`, "stale\n");
    const result = await bakedCheck(w, "echo ran > ran.txt");
    assertStringIncludes(result.out, "submodules that are not at the head's commits");
    await assertFellBack(w, result);
    assertEquals(await stat(`${w.baked}/lib/u.txt`).then(() => true, () => false), false);
  } finally {
    await dropBaked(w);
  }
});

test("an index the move cannot list falls back to a copy, not a tree with nothing flagged", async () => {
  const w = await bakedWorld();
  try {
    const real = (await run("sh", ["-c", "command -v git"])).out.trim();
    const shim = `${w.root}/shim`;
    await mkdir(shim);
    await writeFile(
      `${shim}/git`,
      `#!/bin/sh\nfor a; do [ "$a" = ls-files ] && exit 128; done\nexec '${real}' "$@"\n`,
    );
    await chmod(`${shim}/git`, 0o755);
    const result = await bakedCheck(w, "echo ran > ran.txt", {
      PATH: `${shim}:${process.env.PATH}`,
    });
    await assertFellBack(w, result);
  } finally {
    await dropBaked(w);
  }
});

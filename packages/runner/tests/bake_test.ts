// ryph-bake, the image-time half of setup: the same executor as a run, pointed at a root of
// checkouts — member order, the image phase, the clean-tree rule, the toolchain record, and the
// setup warnings a failing step or an invalid setup.yml leaves instead of a failed build.

import { test } from "bun:test";
import { command } from "@ryph/process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  bake,
  manifestShape,
  MAX_SETUP_WARNINGS_BYTES,
  MAX_VERSION_LEN,
  memberOrder,
  serializeWarnings,
  type SetupWarning,
  versionOf,
  wholeSecondFiles,
} from "../src/bake.ts";
import { REPO_CONFIG_DIR } from "../src/core/brand.ts";
import { runSetup, SETUP_PHASE_ENV } from "../src/helpers/environment.ts";
import { git } from "../src/helpers/git_exec.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";
import { removeTree } from "./fixtures/remove_tree.ts";

/** A committed checkout at `root/path` holding `files`. The commit runs no auto maintenance:
 * git starts it detached, so it can outlive the commit holding `.git/objects/maintenance.lock`,
 * and when that lock vanishes under a test's recursive `rm` (one that tears the tree down right
 * after, like the refused uid below), bun reports it as `ENOENT` on the root and leaves the tree. */
async function checkout(root: string, path: string, files: Record<string, string>) {
  const dir = `${root}/${path}`;
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  for (const [name, content] of Object.entries(files)) {
    const parent = name.includes("/") ? `${dir}/${name.slice(0, name.lastIndexOf("/"))}` : dir;
    await mkdir(parent, { recursive: true });
    await writeFile(`${dir}/${name}`, content);
  }
  await git(dir, "add", "-A");
  await git(
    dir,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "maintenance.auto=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
}

/** A setup.yml appending `<path> <phase>` to a shared log outside every checkout. */
function logStep(log: string, path: string): string {
  return `steps:\n  - run: echo "${path} $${SETUP_PHASE_ENV}" >> ${log}\n`;
}

test("bake: runs every checkout's steps in .order, in the image phase, and records toolchains", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  const log = `${root}.log`;
  try {
    await checkout(root, "alpha", { [`${REPO_CONFIG_DIR}/setup.yml`]: logStep(log, "alpha") });
    await checkout(root, "beta", { [`${REPO_CONFIG_DIR}/setup.yml`]: logStep(log, "beta") });
    // not a checkout: skipped by discovery
    await mkdir(`${root}/stray`);
    await writeFile(`${root}/.order`, "beta\nalpha\n");

    const out = `${root}-env/toolchains.json`;
    const result = await bake({
      root,
      phase: "image",
      toolchainsOut: out,
      diag: noopDiagnostics(),
    });
    assertEquals(result.repos, ["beta", "alpha"]);
    assertEquals(await readFile(log, "utf8"), "beta image\nalpha image\n");
    // the record is written where asked, and at least the runtime running this test is in it
    const recorded = JSON.parse(await readFile(out, "utf8"));
    assertEquals(recorded, result.toolchains);
    assert(typeof recorded.bun === "string", `toolchains: ${JSON.stringify(recorded)}`);
    assertEquals(recorded.bun, process.versions.bun);
  } finally {
    await rm(root, { recursive: true });
    await rm(`${root}-env`, { recursive: true }).catch(() => {});
    await rm(log).catch(() => {});
  }
});

test("bake: reads only setup.yml, so a broken services.yml or environment.md fails no build", async () => {
  // Neither is part of a build's key (the forge's .ryph tree id leaves them out), so neither may
  // decide whether a build succeeds.
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  const log = `${root}.log`;
  try {
    await checkout(root, "alpha", {
      [`${REPO_CONFIG_DIR}/setup.yml`]: logStep(log, "alpha"),
      [`${REPO_CONFIG_DIR}/services.yml`]: "services: [unclosed\n",
      [`${REPO_CONFIG_DIR}/environment.md`]: "x".repeat(40_000),
    });
    const result = await bake({
      root,
      phase: "image",
      toolchainsOut: `${root}-env/toolchains.json`,
      diag: noopDiagnostics(),
    });
    assertEquals(result.repos, ["alpha"]);
    assertEquals(await readFile(log, "utf8"), "alpha image\n");
  } finally {
    await rm(root, { recursive: true });
    await rm(`${root}-env`, { recursive: true }).catch(() => {});
    await rm(log).catch(() => {});
  }
});

test("bake: with no .order the checkouts run sorted by name", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  try {
    await checkout(root, "zeta", {});
    await checkout(root, "alpha", {});
    await mkdir(`${root}/not-a-repo`);
    assertEquals(await memberOrder(root), ["alpha", "zeta"]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("bake: an .order naming something that is not a checkout is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  try {
    await checkout(root, "alpha", {});
    await writeFile(`${root}/.order`, "alpha\nghost\n");
    await assertRejects(() => memberOrder(root), Error, `"ghost" is not a checkout`);
    await writeFile(`${root}/.order`, "../alpha\n");
    await assertRejects(() => memberOrder(root), Error, "not a directory name");
    await writeFile(`${root}/.order`, "alpha\nalpha\n");
    await assertRejects(() => memberOrder(root), Error, "listed twice");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("bake: a failing step is a warning — the rest of that repo is skipped, the image finished", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  const out = `${root}-env/toolchains.json`;
  const warningsOut = `${root}-env/setup-warnings.json`;
  const log = `${root}.log`;
  try {
    await checkout(root, "alpha", {
      [`${REPO_CONFIG_DIR}/setup.yml`]: "steps:\n" +
        "  - name: boom\n    run: echo kaput >&2; exit 3\n" +
        `  - run: echo never >> ${log}\n`,
    });
    await checkout(root, "beta", { [`${REPO_CONFIG_DIR}/setup.yml`]: logStep(log, "beta") });
    await writeFile(`${root}/.order`, "alpha\nbeta\n");
    const result = await bake({
      root,
      phase: "image",
      toolchainsOut: out,
      warningsOut,
      diag: noopDiagnostics(),
    });
    // the next repo still baked; nothing after the failing step did
    assertEquals(await readFile(log, "utf8"), "beta image\n");
    const warning: SetupWarning = {
      kind: "step",
      path: "alpha",
      step: "boom",
      index: 1,
      total: 2,
      code: 3,
      output: "kaput",
      discarded: false,
    };
    assertEquals(result.warnings, [warning]);
    // the toolchain record is written as for any bake, and the warnings beside it
    assertEquals(JSON.parse(await readFile(out, "utf8")), result.toolchains);
    assertEquals(JSON.parse(await readFile(warningsOut, "utf8")), [warning]);
  } finally {
    await rm(root, { recursive: true });
    await rm(`${root}-env`, { recursive: true }).catch(() => {});
    await rm(log).catch(() => {});
  }
});

test("bake: an invalid setup.yml is a warning too, and a clean bake writes an empty list", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  const warningsOut = `${root}-env/setup-warnings.json`;
  try {
    await checkout(root, "alpha", { [`${REPO_CONFIG_DIR}/setup.yml`]: "steps: [\n" });
    const result = await bake({
      root,
      phase: "image",
      toolchainsOut: `${root}-env/toolchains.json`,
      warningsOut,
      diag: noopDiagnostics(),
    });
    assertEquals(result.warnings.length, 1);
    const [warning] = result.warnings;
    assert(warning.kind === "invalid");
    assertEquals(warning.path, "alpha");
    assertStringIncludes(warning.error, "setup.yml: not valid YAML");

    // a later bake of a fixed tree (a warm build on that image) replaces the file with nothing
    await writeFile(`${root}/alpha/${REPO_CONFIG_DIR}/setup.yml`, 'steps:\n  - run: "true"\n');
    await git(
      `${root}/alpha`,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qam",
      "fix",
    );
    await bake({
      root,
      phase: "image",
      toolchainsOut: `${root}-env/toolchains.json`,
      warningsOut,
      diag: noopDiagnostics(),
    });
    assertEquals(JSON.parse(await readFile(warningsOut, "utf8")), []);
  } finally {
    await rm(root, { recursive: true });
    await rm(`${root}-env`, { recursive: true }).catch(() => {});
  }
});

test("bake: a failed step's dirt is discarded; a successful repo's dirt still fails the build", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  try {
    await checkout(root, "alpha", {
      "lock.json": "{}\n",
      [`${REPO_CONFIG_DIR}/setup.yml`]:
        "steps:\n  - run: echo changed > lock.json; echo x > yarn-error.log; exit 1\n",
    });
    const result = await bake({
      root,
      phase: "image",
      toolchainsOut: `${root}-env/toolchains.json`,
      diag: noopDiagnostics(),
    });
    assertEquals(await readFile(`${root}/alpha/lock.json`, "utf8"), "{}\n");
    assertEquals(
      await stat(`${root}/alpha/yarn-error.log`).then(() => "present", (e) => e.code),
      "ENOENT",
    );
    assert(result.warnings[0]?.kind === "step" && result.warnings[0].discarded);

    // beta's setup SUCCEEDED and left a file — fatal when every setup succeeded (below), but
    // alpha's failing step ran too and could have written it: discarded, a warning naming both
    await checkout(root, "beta", {
      [`${REPO_CONFIG_DIR}/setup.yml`]: "steps:\n  - run: echo built > artifact.txt\n",
    });
    await writeFile(`${root}/.order`, "beta\nalpha\n");
    const warningsOut = `${root}-env/setup-warnings.json`;
    const again = await bake({
      root,
      phase: "image",
      toolchainsOut: `${root}-env/toolchains.json`,
      warningsOut,
      diag: noopDiagnostics(),
    });
    await assertRejects(() => stat(`${root}/beta/artifact.txt`));
    assertEquals(again.warnings.map((w) => [w.kind, w.path]), [
      ["discarded", "beta"],
      ["step", "alpha"],
    ]);
    // the file carries the discard as its own entry, naming the repo whose step failed
    const file = JSON.parse(await readFile(warningsOut, "utf8")) as SetupWarning[];
    assertEquals(file.map((w) => [w.kind, w.path]), [["discarded", "beta"], ["step", "alpha"]]);
    assertEquals(file[0], { kind: "discarded", path: "beta", after: ["alpha"] });
  } finally {
    await rm(root, { recursive: true });
    await rm(`${root}-env`, { recursive: true }).catch(() => {});
  }
});

test("bake: a failed step that committed, switched branch or stopped a rebase is put back to the start", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  try {
    await checkout(root, "alpha", {
      [`${REPO_CONFIG_DIR}/setup.yml`]: "steps:\n  - run: |\n" +
        "      echo s > setup.txt && git add setup.txt &&\n" +
        "        git -c user.name=s -c user.email=s@s commit -qm 'setup commit'\n" +
        "      git checkout -q --detach && mkdir -p .git/rebase-merge\n" +
        "      exit 1\n",
    });
    const before = await git(`${root}/alpha`, "rev-parse", "HEAD");
    const result = await bake({
      root,
      phase: "image",
      toolchainsOut: `${root}-env/toolchains.json`,
      diag: noopDiagnostics(),
    });
    assert(result.warnings[0]?.kind === "step" && result.warnings[0].discarded);
    assertEquals(await git(`${root}/alpha`, "rev-parse", "HEAD"), before);
    assertEquals(await git(`${root}/alpha`, "symbolic-ref", "--short", "HEAD"), "main");
    await assertRejects(() => stat(`${root}/alpha/setup.txt`));
    await assertRejects(() => stat(`${root}/alpha/.git/rebase-merge`));
  } finally {
    await rm(root, { recursive: true });
    await rm(`${root}-env`, { recursive: true }).catch(() => {});
  }
});

test("bake: once a step failed, every repo's filter drivers go back with its tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  // What `git-crypt unlock` does, rot13 for the cipher: a driver, the file checked out through it.
  const unlock = (tail: string) =>
    "steps:\n  - run: |\n" +
    "      git config filter.rot.smudge 'tr A-Za-z N-ZA-Mn-za-m'\n" +
    "      git config filter.rot.clean 'tr A-Za-z N-ZA-Mn-za-m'\n" +
    "      rm r.txt && git checkout -- r.txt\n" +
    `      echo v2 > lock.json${tail}\n`;
  const files = { ".gitattributes": "r.txt filter=rot\n", "r.txt": "uryyb\n", "lock.json": "v1\n" };
  try {
    await checkout(root, "alpha", {
      ...files,
      [`${REPO_CONFIG_DIR}/setup.yml`]: unlock(" && exit 1"),
    });
    await checkout(root, "beta", { ...files, [`${REPO_CONFIG_DIR}/setup.yml`]: unlock("") });
    await writeFile(`${root}/.order`, "alpha\nbeta\n");
    const result = await bake({
      root,
      phase: "image",
      toolchainsOut: `${root}-env/toolchains.json`,
      diag: noopDiagnostics(),
    });
    assertEquals(result.warnings.map((w) => [w.kind, w.path]), [
      ["step", "alpha"],
      ["discarded", "beta"],
    ]);
    const driver = (repo: string) =>
      git(`${root}/${repo}`, "config", "--get-regexp", "^filter\\.").catch(() => "");
    // alpha: the step failed, so its driver is gone and its file is the stored blob.
    assertEquals(await driver("alpha"), "");
    assertEquals(await readFile(`${root}/alpha/r.txt`, "utf8"), "uryyb\n");
    // beta: its own setup succeeded, but alpha's failed step could have written beta's config
    // as well as its tree, so both go back to the start: no driver, the stored blob.
    assertEquals(await driver("beta"), "");
    assertEquals(await readFile(`${root}/beta/r.txt`, "utf8"), "uryyb\n");
    for (const repo of ["alpha", "beta"]) {
      assertEquals(await readFile(`${root}/${repo}/lock.json`, "utf8"), "v1\n");
      assertEquals(await git(`${root}/${repo}`, "status", "--porcelain"), "");
    }
  } finally {
    await rm(root, { recursive: true });
    await rm(`${root}-env`, { recursive: true }).catch(() => {});
  }
});

test("bake: a driver a failed step plants in a sibling never runs when the sibling is put back", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  const marker = `${root}-marker`;
  try {
    await checkout(root, "alpha", {
      [`${REPO_CONFIG_DIR}/setup.yml`]: "steps:\n  - run: |\n" +
        `      git -C ../beta config filter.evil.smudge 'touch ${marker}; cat'\n` +
        `      git -C ../beta config filter.evil.clean 'touch ${marker}; cat'\n` +
        "      echo '* filter=evil' > ../beta/.git/info/attributes\n" +
        "      echo changed > ../beta/f.txt\n" +
        "      exit 1\n",
    });
    await checkout(root, "beta", { "f.txt": "start\n" });
    await writeFile(`${root}/.order`, "alpha\nbeta\n");
    const result = await bake({
      root,
      phase: "image",
      toolchainsOut: `${root}-env/toolchains.json`,
      diag: noopDiagnostics(),
    });
    assertEquals(result.warnings.map((w) => [w.kind, w.path]), [
      ["step", "alpha"],
      ["discarded", "beta"],
    ]);
    await assertRejects(() => stat(marker));
    assertEquals(
      await git(`${root}/beta`, "config", "--get-regexp", "^filter\\.").catch(() => ""),
      "",
    );
    await assertRejects(() => stat(`${root}/beta/.git/info/attributes`));
    assertEquals(await readFile(`${root}/beta/f.txt`, "utf8"), "start\n");
  } finally {
    await rm(root, { recursive: true });
    await rm(`${root}-env`, { recursive: true }).catch(() => {});
    await rm(marker, { force: true });
  }
});

test("serializeWarnings: bounded — tails cut, then shared, then labels shortened, then entries", () => {
  const step = (path: string, output: string, label = "npm ci"): SetupWarning => ({
    kind: "step",
    path,
    step: label,
    index: 1,
    total: 1,
    code: 1,
    output,
    discarded: false,
  });
  const one = JSON.parse(serializeWarnings([step("a", "HEAD" + "x".repeat(5_000))]));
  assert(!one[0].output.includes("HEAD"), "the tail is kept, not the head");
  assert(one[0].output.length <= 601);

  // too many full tails: every repo stays named, each keeping an even share of its tail
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  const several = Array.from({ length: 8 }, (_, i) => step(`repo-${i}`, "y".repeat(500) + "END"));
  let text = serializeWarnings(several);
  assert(bytes(text) <= MAX_SETUP_WARNINGS_BYTES);
  let parsed = JSON.parse(text) as SetupWarning[];
  assertEquals(parsed.map((w) => w.path), several.map((w) => w.path));
  for (const w of parsed) {
    assert(w.kind === "step" && w.output.endsWith("END") && w.output.length < 300, w.path);
  }

  // long labels and errors shorten to a first line before any repo goes unnamed
  const long = Array.from(
    { length: 12 },
    (_, i): SetupWarning =>
      i % 2 === 0
        ? step(`repo-${i}`, "z".repeat(600), "l".repeat(200))
        : { kind: "invalid", path: `repo-${i}`, error: `setup.yml: bad\n${"e".repeat(590)}` },
  );
  text = serializeWarnings(long);
  assert(bytes(text) <= MAX_SETUP_WARNINGS_BYTES);
  parsed = JSON.parse(text) as SetupWarning[];
  assertEquals(parsed.map((w) => w.path), long.map((w) => w.path));
  for (const w of parsed) {
    if (w.kind === "invalid") assertEquals(w.error, "setup.yml: bad");
    else if (w.kind === "step") assert(w.step.length <= 101 && w.output === "", w.path);
  }

  // past even that, the last entries go — never the bound
  const many = Array.from({ length: 40 }, (_, i) => step(`repo-${i}`, "y".repeat(500)));
  text = serializeWarnings(many);
  assert(bytes(text) <= MAX_SETUP_WARNINGS_BYTES);
  parsed = JSON.parse(text) as SetupWarning[];
  assert(parsed.length > 0 && parsed.length < 40, `${parsed.length}`);
  assertEquals(parsed[0].path, "repo-0");
});

test("bake: a step that leaves the tree dirty is put back and warned about, as in a run", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  try {
    await checkout(root, "alpha", {
      "Cargo.lock": "v1\n",
      [`${REPO_CONFIG_DIR}/setup.yml`]:
        "steps:\n  - run: echo built > artifact.txt && echo v2 > Cargo.lock\n",
    });
    const result = await bake({
      root,
      phase: "image",
      toolchainsOut: `${root}/../unused.json`,
      diag: noopDiagnostics(),
    });
    assertEquals(result.warnings, [
      { kind: "dirty", path: "alpha", files: ["Cargo.lock", "artifact.txt"] },
    ]);
    assertEquals(await readFile(`${root}/alpha/Cargo.lock`, "utf8"), "v1\n");
    await assertRejects(() => readFile(`${root}/alpha/artifact.txt`, "utf8"));
    // The file the put-back rewrote is pinned to whole seconds again, and the tree stays clean.
    assertEquals((await lstat(`${root}/alpha/Cargo.lock`)).mtime.getTime() % 1000, 0);
    assertEquals(await git(`${root}/alpha`, "status", "--porcelain"), "");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("bake: a repo whose own step failed gets no `dirty` warning when a later repo dirties it", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  try {
    await checkout(root, "alpha", {
      [`${REPO_CONFIG_DIR}/setup.yml`]: "steps:\n  - run: exit 1\n",
    });
    await checkout(root, "beta", {
      [`${REPO_CONFIG_DIR}/setup.yml`]: "steps:\n  - run: echo oops > ../alpha/leak.txt\n",
    });
    await writeFile(`${root}/.order`, "alpha\nbeta\n");
    const result = await bake({
      root,
      phase: "image",
      toolchainsOut: `${root}-env/toolchains.json`,
      diag: noopDiagnostics(),
    });
    assertEquals(result.warnings.map((w) => [w.kind, w.path]), [["step", "alpha"]]);
    await assertRejects(() => stat(`${root}/alpha/leak.txt`));
  } finally {
    await rm(root, { recursive: true });
    await rm(`${root}-env`, { recursive: true }).catch(() => {});
  }
});

test("bake: an ignored artifact is exactly what a bake is for", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  const out = `${root}-toolchains.json`;
  try {
    await checkout(root, "alpha", {
      ".gitignore": "target/\n",
      [`${REPO_CONFIG_DIR}/setup.yml`]:
        "steps:\n  - run: mkdir -p target && echo warm > target/x\n",
    });
    await bake({ root, phase: "image", toolchainsOut: out, diag: noopDiagnostics() });
    assertEquals(await readFile(`${root}/alpha/target/x`, "utf8"), "warm\n");
  } finally {
    await rm(root, { recursive: true });
    await rm(out).catch(() => {});
  }
});

test("bake: a checkout another uid owns is refused before any step runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  const log = `${root}.log`;
  try {
    await checkout(root, "alpha", { [`${REPO_CONFIG_DIR}/setup.yml`]: logStep(log, "alpha") });
    const owner = (await stat(`${root}/alpha`)).uid;
    await assertRejects(
      () =>
        bake({
          root,
          phase: "image",
          toolchainsOut: `${root}-toolchains.json`,
          diag: noopDiagnostics(),
          uid: (owner ?? 0) + 1,
        }),
      Error,
      `alpha: the checkout is owned by uid ${owner}`,
    );
    // Nothing ran: a root-owned target/ is the thing this refuses to make.
    assertEquals(await stat(log).then(() => "present", (e) => e.code), "ENOENT");
  } finally {
    await removeTree(root);
  }
});

/** An mtime with a fraction of a second, as a fresh clone or a checkout leaves one. */
const FRACTIONAL = 1791193785.912;

/** Whether this machine has GNU `stat`. Without it the bake sets every tracked file's time, so a
 * whole-second file counts as moved too. */
const GNU_STAT = await wholeSecondFiles("/", ["."]) !== null;

/** The mtime of `path` in milliseconds. */
async function mtimeMs(path: string): Promise<number> {
  return (await lstat(path)).mtime!.getTime();
}

/** A setup step that writes `file`'s mtime, in milliseconds, to `out`, as the step sees it. */
function witnessStep(file: string, out: string): string {
  const bun = process.execPath;
  return `steps:\n  - run: '"${bun}" --no-env-file -e "console.log(require(\\"node:fs\\").statSync(\\"${file}\\").mtime.getTime())" > ${out}'\n`;
}

test("bake: in the image phase tracked files are whole seconds before the first step runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  const witness = `${root}.witness`;
  try {
    await checkout(root, "alpha", {
      ".gitignore": "target/\nignored.txt\n",
      "src/lib.rs": "pub fn f() {}\n",
      [`${REPO_CONFIG_DIR}/setup.yml`]: witnessStep("src/lib.rs", witness),
    });
    const dir = `${root}/alpha`;
    // What a clone leaves: fractions on every file, tracked or not.
    for (const name of ["src/lib.rs", ".gitignore", `${REPO_CONFIG_DIR}/setup.yml`]) {
      await utimes(`${dir}/${name}`, FRACTIONAL, FRACTIONAL);
    }
    await writeFile(`${dir}/ignored.txt`, "x\n");
    await utimes(`${dir}/ignored.txt`, FRACTIONAL, FRACTIONAL);
    await mkdir(`${dir}/target`);
    await writeFile(`${dir}/target/out`, "x\n");
    await utimes(`${dir}/target/out`, FRACTIONAL, FRACTIONAL);
    await symlink("src/lib.rs", `${dir}/link`);
    await git(dir, "add", "link");
    await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "link");

    const result = await bake({
      root,
      phase: "image",
      toolchainsOut: `${root}-toolchains.json`,
      diag: noopDiagnostics(),
    });
    // The step saw the rounded-down second, not the fraction and not the commit time.
    assertEquals(Number((await readFile(witness, "utf8")).trim()), 1791193785000);
    assertEquals(await mtimeMs(`${dir}/src/lib.rs`), 1791193785000);
    // Every tracked regular file is whole seconds; the symlink is not one of them.
    for (const name of [".gitignore", `${REPO_CONFIG_DIR}/setup.yml`]) {
      assertEquals(await mtimeMs(`${dir}/${name}`), 1791193785000, name);
    }
    assertEquals(result.pinned.alpha, { files: 3, moved: 3, manifests: 0 });
    // Untracked and ignored files keep their fractions.
    assertEquals(await mtimeMs(`${dir}/ignored.txt`), FRACTIONAL * 1000);
    assertEquals(await mtimeMs(`${dir}/target/out`), FRACTIONAL * 1000);
    // And the tree is still clean, as a run will check before adopting it.
    assertEquals(await git(dir, "status", "--porcelain"), "");
  } finally {
    await rm(root, { recursive: true });
    await rm(`${root}-toolchains.json`).catch(() => {});
    await rm(witness).catch(() => {});
  }
});

test("bake: a tracked file already in whole seconds keeps its time (a warm tree's untouched files)", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  try {
    await checkout(root, "alpha", { "old.rs": "old\n", "new.rs": "new\n" });
    const dir = `${root}/alpha`;
    // An earlier layer's file, and one the warm build's checkout just rewrote.
    await utimes(`${dir}/old.rs`, 1700000000, 1700000000);
    await utimes(`${dir}/new.rs`, FRACTIONAL, FRACTIONAL);
    const result = await bake({
      root,
      phase: "image",
      toolchainsOut: `${root}-toolchains.json`,
      diag: noopDiagnostics(),
    });
    assertEquals(await mtimeMs(`${dir}/old.rs`), 1700000000_000);
    // Rounded down, never back to its commit time: it stays ahead of outputs built before it.
    assertEquals(await mtimeMs(`${dir}/new.rs`), 1791193785000);
    assertEquals(result.pinned.alpha, { files: 2, moved: GNU_STAT ? 1 : 2, manifests: 0 });
  } finally {
    await rm(root, { recursive: true });
    await rm(`${root}-toolchains.json`).catch(() => {});
  }
});

test("bake: a package whose newest second is tied gets one newest file: its Cargo.toml", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  try {
    await checkout(root, "alpha", {
      "Cargo.toml": "[workspace]\n",
      "README.md": "r\n",
      "crates/a/Cargo.toml": "[package]\n",
      "crates/a/build.rs": "fn main() {}\n",
      "crates/a/src/lib.rs": "\n",
      "crates/b/Cargo.toml": "[package]\n",
      "crates/b/src/lib.rs": "\n",
    });
    const dir = `${root}/alpha`;
    // A clone writes a small package within one second: after rounding, every file ties.
    for (const name of ["Cargo.toml", "README.md", "crates/a/Cargo.toml", "crates/a/build.rs"]) {
      await utimes(`${dir}/${name}`, FRACTIONAL, FRACTIONAL);
    }
    await utimes(`${dir}/crates/a/src/lib.rs`, FRACTIONAL, FRACTIONAL);
    // b's manifest was rewritten after its sources: already its one newest file, it keeps its time.
    await utimes(`${dir}/crates/b/src/lib.rs`, 1700000000, 1700000000);
    await utimes(`${dir}/crates/b/Cargo.toml`, 1700000005, 1700000005);
    const bakeOnce = () =>
      bake({
        root,
        phase: "image",
        toolchainsOut: `${root}-toolchains.json`,
        diag: noopDiagnostics(),
      });

    const first = await bakeOnce();
    const s = 1791193785;
    assertEquals(await mtimeMs(`${dir}/crates/a/build.rs`), s * 1000);
    assertEquals(await mtimeMs(`${dir}/crates/a/Cargo.toml`), (s + 1) * 1000);
    assertEquals(await mtimeMs(`${dir}/crates/b/Cargo.toml`), 1700000005_000);
    // The virtual root ties with README.md, but no package lists it: clippy names it in every
    // crate's dep-info, and moving it would rebuild them all.
    assertEquals(await mtimeMs(`${dir}/Cargo.toml`), s * 1000);
    assertEquals(first.pinned.alpha.manifests, 1);
    assertEquals(await git(dir, "status", "--porcelain"), "");

    // A warm build over the same tree: nothing moves, so cargo's record still matches.
    const second = await bakeOnce();
    // With GNU stat nothing is set at all: a lower layer's file set again is copied up whole.
    assertEquals(second.pinned.alpha, { files: 7, moved: GNU_STAT ? 0 : 7, manifests: 0 });
    assertEquals(await mtimeMs(`${dir}/crates/a/Cargo.toml`), (s + 1) * 1000);
    assertEquals(await mtimeMs(`${dir}/Cargo.toml`), s * 1000);

    // A warm build of a commit that changed one source: that file is a's one newest, so no
    // manifest moves, and nothing outside a has a reason to rebuild.
    await writeFile(`${dir}/crates/a/src/lib.rs`, "pub fn changed() {}\n");
    await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "change a");
    await utimes(`${dir}/crates/a/src/lib.rs`, FRACTIONAL + 100, FRACTIONAL + 100);
    const third = await bakeOnce();
    assertEquals(third.pinned.alpha.manifests, 0);
    assertEquals(await mtimeMs(`${dir}/crates/a/src/lib.rs`), (s + 100) * 1000);
    assertEquals(await mtimeMs(`${dir}/crates/a/Cargo.toml`), (s + 1) * 1000);
    assertEquals(await mtimeMs(`${dir}/Cargo.toml`), s * 1000);
  } finally {
    await rm(root, { recursive: true });
    await rm(`${root}-toolchains.json`).catch(() => {});
  }
});

test.skipIf(!GNU_STAT)(
  "wholeSecondFiles: GNU stat tells a whole second from a fraction a Date cannot see",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "bake-test-"));
    try {
      for (const name of ["whole", "nanos", "with space\nand newline"]) {
        await writeFile(`${dir}/${name}`, "x\n");
      }
      await utimes(`${dir}/whole`, 1700000000, 1700000000);
      await utimes(`${dir}/with space\nand newline`, 1700000000, 1700000000);
      // A few hundred nanoseconds past the second: a Date reads it as whole.
      await command("touch", { args: ["-d", "@1700000000.0000005", `${dir}/nanos`] })
        .output();
      assertEquals((await stat(`${dir}/nanos`)).mtime!.getTime() % 1000, 0);
      assertEquals(
        await wholeSecondFiles(dir, ["whole", "nanos", "with space\nand newline"]),
        new Set(["whole", "with space\nand newline"]),
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  },
);

test.skipIf(!GNU_STAT)(
  "wholeSecondFiles: a repo of tens of thousands of files does not fill the pipe and hang",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "bake-test-"));
    try {
      // Written before read, 10,000 names of this length already hung: stat filled its pipe.
      const names = Array.from({ length: 20000 }, (_, i) => `file-with-a-longish-name-${i}.txt`);
      for (const name of names) await writeFile(`${dir}/${name}`, "");
      const whole = await wholeSecondFiles(dir, names);
      assert(whole !== null);
    } finally {
      await rm(dir, { recursive: true });
    }
  },
);

test("bake: a workspace root that is a package breaks its tie with a file cargo lists, never its manifest", async () => {
  for (const lock of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), "bake-test-"));
    try {
      const files: Record<string, string> = {
        "Cargo.toml": '[package]\nname = "root"\n\n[workspace]\nmembers = ["a"]\n',
        ".gitignore": "target/\n",
        "README.md": "r\n",
        "build.rs": "fn main() {}\n",
        "src/lib.rs": "\n",
        "a/Cargo.toml": "[package]\n",
        "a/src/lib.rs": "\n",
      };
      if (lock) files["Cargo.lock"] = "version = 4\n";
      await checkout(root, "alpha", files);
      const dir = `${root}/alpha`;
      for (const name of Object.keys(files)) {
        if (!name.startsWith("a/")) await utimes(`${dir}/${name}`, FRACTIONAL, FRACTIONAL);
      }
      await utimes(`${dir}/a/Cargo.toml`, 1700000005, 1700000005);
      await utimes(`${dir}/a/src/lib.rs`, 1700000000, 1700000000);
      const result = await bake({
        root,
        phase: "image",
        toolchainsOut: `${root}-toolchains.json`,
        diag: noopDiagnostics(),
      });
      const s = 1791193785;
      // Clippy names the workspace's manifest in every member's dep-info: it stays where it was.
      assertEquals(await mtimeMs(`${dir}/Cargo.toml`), s * 1000);
      // The tie goes to a file cargo always lists: the lock, else the build script. Never a file
      // a package's `include`/`exclude` could leave out, like the first in path order would be.
      const moved = lock ? "Cargo.lock" : "build.rs";
      assertEquals(await mtimeMs(`${dir}/${moved}`), (s + 1) * 1000, `lock: ${lock}`);
      for (const other of [".gitignore", "README.md", "src/lib.rs"]) {
        assertEquals(await mtimeMs(`${dir}/${other}`), s * 1000, other);
      }
      // `a` has one newest file already (its manifest): nothing of its moves.
      assertEquals(result.pinned.alpha.manifests, 1);
      assertEquals(await git(dir, "status", "--porcelain"), "");
    } finally {
      await rm(root, { recursive: true });
      await rm(`${root}-toolchains.json`).catch(() => {});
    }
  }
});

test("manifestShape: reads package, workspace and package.build from their own tables only", () => {
  assertEquals(manifestShape("[package]\nname = \"a\"\nbuild = 'gen.rs'\n"), {
    isPackage: true,
    isWorkspace: false,
    build: "gen.rs",
  });
  assertEquals(manifestShape('[package]\nbuild = "./b/build.rs" # here\n').build, "b/build.rs");
  assertEquals(manifestShape("[package]\nbuild = false\n").build, false);
  // A `build` in another table is not the package's build script.
  assertEquals(
    manifestShape('[package]\nname = "a"\n[package.metadata.x]\nbuild = "nope.rs"\n').build,
    undefined,
  );
  assertEquals(manifestShape('package.name = "a"\npackage.build = "g.rs"\n'), {
    isPackage: true,
    isWorkspace: false,
    build: "g.rs",
  });
  // A virtual manifest, and a member that names its workspace.
  assertEquals(manifestShape('[workspace]\nmembers = ["a"]\n[workspace.dependencies]\nx = "1"\n'), {
    isPackage: false,
    isWorkspace: true,
    build: undefined,
  });
  assertEquals(manifestShape('[package]\nworkspace = ".."\n').isWorkspace, false);
  assertEquals(manifestShape('[ "package" ]\nname = "a"\n').isPackage, true);
});

test("bake: a tie in a package without a build script is broken too (rustdoc names the newest file)", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  try {
    await checkout(root, "alpha", {
      "Cargo.toml": '[package]\nname = "lib"\nbuild = false\n',
      "src/lib.rs": "\n",
      "README.md": "r\n",
    });
    const dir = `${root}/alpha`;
    for (const name of ["Cargo.toml", "src/lib.rs", "README.md"]) {
      await utimes(`${dir}/${name}`, FRACTIONAL, FRACTIONAL);
    }
    const result = await bake({
      root,
      phase: "image",
      toolchainsOut: `${root}-toolchains.json`,
      diag: noopDiagnostics(),
    });
    assertEquals(await mtimeMs(`${dir}/Cargo.toml`), 1791193786000);
    assertEquals(await mtimeMs(`${dir}/src/lib.rs`), 1791193785000);
    assertEquals(result.pinned.alpha.manifests, 1);
  } finally {
    await rm(root, { recursive: true });
    await rm(`${root}-toolchains.json`).catch(() => {});
  }
});

test("bake: a library workspace's docs-only tie moves no source, which would recompile it", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  try {
    await checkout(root, "alpha", {
      "Cargo.toml": '[package]\nname = "root"\n\n[workspace]\nmembers = ["b"]\n',
      "README.md": "r\n",
      "CHANGELOG.md": "c\n",
      "src/lib.rs": "\n",
      "b/Cargo.toml": "[package]\n",
      "b/src/lib.rs": "\n",
    });
    const dir = `${root}/alpha`;
    // A warm commit touched the two docs; the sources are an earlier layer's.
    for (const name of ["README.md", "CHANGELOG.md"]) {
      await utimes(`${dir}/${name}`, FRACTIONAL, FRACTIONAL);
    }
    for (const name of ["Cargo.toml", "src/lib.rs", "b/src/lib.rs"]) {
      await utimes(`${dir}/${name}`, 1700000000, 1700000000);
    }
    await utimes(`${dir}/b/Cargo.toml`, 1700000001, 1700000001);
    const result = await bake({
      root,
      phase: "image",
      toolchainsOut: `${root}-toolchains.json`,
      diag: noopDiagnostics(),
    });
    assertEquals(await mtimeMs(`${dir}/src/lib.rs`), 1700000000_000);
    assertEquals(await mtimeMs(`${dir}/Cargo.toml`), 1700000000_000);
    assertEquals(result.pinned.alpha.manifests, 0);
  } finally {
    await rm(root, { recursive: true });
    await rm(`${root}-toolchains.json`).catch(() => {});
  }
});

test("bake: an aborted bake stops pinning, and runs no step", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  const log = `${root}.log`;
  try {
    await checkout(root, "alpha", {
      "a.rs": "a\n",
      [`${REPO_CONFIG_DIR}/setup.yml`]: logStep(log, "alpha"),
    });
    await utimes(`${root}/alpha/a.rs`, FRACTIONAL, FRACTIONAL);
    const controller = new AbortController();
    controller.abort("the build was called off");
    const err = await assertRejects(() =>
      bake({
        root,
        phase: "image",
        toolchainsOut: `${root}-toolchains.json`,
        diag: noopDiagnostics(),
        signal: controller.signal,
      })
    );
    assertStringIncludes(String(err), "the build was called off");
    assertEquals(await mtimeMs(`${root}/alpha/a.rs`), FRACTIONAL * 1000);
    assertEquals(await stat(log).catch(() => null), null);
  } finally {
    await rm(root, { recursive: true });
    await rm(`${root}-toolchains.json`).catch(() => {});
    await rm(log).catch(() => {});
  }
});

test("bake: the run phase leaves mtimes alone, and so does a run's own setup", async () => {
  const root = await mkdtemp(join(tmpdir(), "bake-test-"));
  const witness = `${root}.witness`;
  try {
    await checkout(root, "alpha", {
      "src/lib.rs": "pub fn f() {}\n",
      [`${REPO_CONFIG_DIR}/setup.yml`]: witnessStep("src/lib.rs", witness),
    });
    const dir = `${root}/alpha`;
    await utimes(`${dir}/src/lib.rs`, FRACTIONAL, FRACTIONAL);
    const result = await bake({
      root,
      phase: "run",
      toolchainsOut: `${root}-toolchains.json`,
      diag: noopDiagnostics(),
    });
    assertEquals(result.pinned, {});
    assertEquals(Number((await readFile(witness, "utf8")).trim()), FRACTIONAL * 1000);
    assertEquals(await mtimeMs(`${dir}/src/lib.rs`), FRACTIONAL * 1000);

    // The runner's run-phase path is runSetup itself, which never pins.
    await runSetup([{ run: "true" }], {
      cwd: dir,
      phase: "run",
      signal: new AbortController().signal,
      diag: noopDiagnostics(),
    });
    assertEquals(await mtimeMs(`${dir}/src/lib.rs`), FRACTIONAL * 1000);
  } finally {
    await rm(root, { recursive: true });
    await rm(`${root}-toolchains.json`).catch(() => {});
    await rm(witness).catch(() => {});
  }
});

test("versionOf: pulls the version token out of each toolchain's own phrasing", () => {
  assertEquals(versionOf("rustc 1.98.1 (48a229cea 2026-09-01)"), "1.98.1");
  assertEquals(versionOf("v24.21.0"), "24.21.0");
  assertEquals(versionOf("deno 2.9.7 (stable, release, x86_64-unknown-linux-gnu)"), "2.9.7");
  assertEquals(versionOf("go version go1.27.1 linux/amd64"), "1.27.1");
  assertEquals(versionOf("Python 3.12.14"), "3.12.14");
  assertEquals(versionOf("uv 0.12.17 (x86_64-unknown-linux-gnu)"), "0.12.17");
  assertEquals(versionOf("1.4.2"), "1.4.2");
  assertEquals(versionOf("something odd"), "something odd");
  // bounded, whatever a tool prints: the record shares the build's 4 KiB of result output
  assertEquals(versionOf("v1.2.3-" + "a".repeat(500)).length, MAX_VERSION_LEN);
  assertEquals(versionOf('odd "quoted" \\ \u0007' + "q".repeat(500)).length, MAX_VERSION_LEN);
  assertEquals(versionOf('odd "quoted" \\ \u0007'), "odd quoted");
  // the budget the bound holds: every toolchain at its longest, beside the warnings at theirs
  // and ~450 bytes of digest, baked, machine and warm lines, inside 4096
  const record = JSON.stringify(
    Object.fromEntries(
      ["rustc", "cargo", "node", "deno", "bun", "python3", "go", "uv"].map((n) => [
        n,
        "9".repeat(MAX_VERSION_LEN),
      ]),
    ),
    null,
    2,
  ).replace(/\n/g, "");
  const toolchainsLine = `@@ryph-result toolchains ${record}\n`.length;
  const warningsLine = `@@ryph-result setup-warnings \n`.length + MAX_SETUP_WARNINGS_BYTES;
  assert(450 + toolchainsLine + warningsLine < 4096, `${450 + toolchainsLine + warningsLine}`);
});

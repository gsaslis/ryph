// The binary's packed files: packed once at build, unpacked once per build into a directory of
// its own, and nothing outside that directory reachable through it.

import { test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { ARTIFACT_SANITIZER_SUBCOMMAND } from "@ryph/orchestrator/artifact-sanitizer";
import {
  fileUrlIn,
  openUnpacked,
  packResources,
  removeTree,
  resourcesRootOrExit,
  runtimeBase,
  SANITIZER_SUBCOMMAND,
  unpackResources,
} from "../src/resources.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

async function packed(dir: string, files: Record<string, string>): Promise<string> {
  const path = join(dir, "archive");
  await writeFile(
    path,
    packResources(Object.entries(files).map(([p, s]) => ({ path: p, bytes: bytes(s) }))),
  );
  return path;
}

test("unpacked once, into a directory named by the contents, and reused while whole", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const archive = await packed(dir, {
      "packages/a/drizzle/0000.sql": "select 1;",
      "packages/app/build/handler.js": "export {};",
    });
    const base = join(dir, "runtime");
    const root = unpackResources(archive, base);
    assertEquals(await readFile(join(root, "packages/a/drizzle/0000.sql"), "utf8"), "select 1;");
    const before = (await stat(join(root, "packages/app/build/handler.js"))).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(unpackResources(archive, base), root);
    assertEquals((await stat(join(root, "packages/app/build/handler.js"))).mtimeMs, before);
    // Read-only once unpacked: files 0444, directories 0555.
    assertEquals((await stat(join(root, "packages/a/drizzle/0000.sql"))).mode & 0o777, 0o444);
    assertEquals((await stat(join(root, "packages/a/drizzle"))).mode & 0o777, 0o555);
    assertEquals((await stat(root)).mode & 0o777, 0o555);
    // A copy cut short, or changed at the same size, is unpacked again.
    for (const changed of ["", "select 2;"]) {
      await chmod(join(root, "packages/a/drizzle"), 0o755);
      await chmod(join(root, "packages/a/drizzle/0000.sql"), 0o644);
      await writeFile(join(root, "packages/a/drizzle/0000.sql"), changed);
      assertEquals(unpackResources(archive, base), root);
      assertEquals(
        await readFile(join(root, "packages/a/drizzle/0000.sql"), "utf8"),
        "select 1;",
      );
    }
    // Another build's contents go elsewhere; the older copy stays while this process uses it.
    const next = unpackResources(await packed(dir, { "x.txt": "two" }), base);
    assertEquals(
      (await readdir(base)).sort(),
      [".in-use", root.split("/").pop(), next.split("/").pop()].sort(),
    );
  } finally {
    removeTree(dir);
  }
});

test("a runtime directory another user could write, or a link, is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const archive = await packed(dir, { "x.txt": "one" });
    const open = join(dir, "open");
    await mkdir(open, { mode: 0o777 });
    await chmod(open, 0o777);
    assertThrows(() => unpackResources(archive, open), Error, "writable by others");
    const real = join(dir, "real");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, join(dir, "link"));
    assertThrows(() => unpackResources(archive, join(dir, "link")), Error, "not a directory");
    assertEquals((await readdir(real)).length, 0);
  } finally {
    removeTree(dir);
  }
});

test("nothing outside the unpacked directory is named through it", () => {
  for (const path of ["../x", "/etc/passwd", "a/../../x", "a//b", "a\\b", ""]) {
    assertThrows(() => packResources([{ path, bytes: bytes("") }]), Error, "not a relative path");
  }
  assertEquals(fileUrlIn("/r/abc", "packages/a/src/m.ts"), "file:///r/abc/packages/a/src/m.ts");
  assertThrows(() => fileUrlIn("/r/abc", "../../etc/passwd"), Error, "outside");
});

test("the runtime copies live under RYPH_HOME, then HOME, then the temp dir, never elsewhere", () => {
  assertEquals(runtimeBase({ RYPH_HOME: "/h/r", HOME: "/h" }), "/h/r/runtime");
  assertEquals(runtimeBase({ HOME: "/h" }), "/h/.ryph/runtime");
  // An empty environment (the artifact sanitizer's) never finds the account's home on its own.
  assert(runtimeBase({}).startsWith(join(tmpdir(), "ryph-runtime-")), runtimeBase({}));
});

const RESOURCES = new URL("../src/resources.ts", import.meta.url).pathname;

/** Another ryph process, of another build: unpacks `archive` under `base`, then waits. */
async function otherProcess(dir: string, archive: string, base: string) {
  const script = join(dir, `other-${crypto.randomUUID()}.ts`);
  await writeFile(
    script,
    `import { unpackResources } from ${JSON.stringify(RESOURCES)};\n` +
      `unpackResources(${JSON.stringify(archive)}, ${JSON.stringify(base)});\n` +
      `console.log("ready");\nawait Bun.stdin.text();\n`,
  );
  const child = Bun.spawn([process.execPath, "--no-env-file", script], {
    cwd: dir,
    env: { HOME: join(dir, "home"), RYPH_HOME: join(dir, "ryph-home"), PATH: "" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  assertEquals(new TextDecoder().decode(value).trim(), "ready");
  return child;
}

test("another build's copy stays while a live process uses it, and goes once that process has", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const base = join(dir, "runtime");
    const older = await packed(dir, { "x.txt": "one" });
    const olderId = basename(unpackResources(older, join(dir, "elsewhere")));
    await mkdir(join(dir, "newer"));
    const newer = await packed(join(dir, "newer"), { "x.txt": "two" });

    // Exits cleanly: its registration goes with it.
    const polite = await otherProcess(dir, older, base);
    unpackResources(newer, base);
    assertEquals(await readFile(join(base, olderId, "x.txt"), "utf8"), "one");
    polite.stdin.end();
    await polite.exited;
    unpackResources(newer, base);
    assertEquals((await readdir(base)).includes(olderId), false);

    // Killed: its registration stays behind, names a dead process, and is cleared with the copy.
    const killed = await otherProcess(dir, older, base);
    unpackResources(newer, base);
    assertEquals(await readFile(join(base, olderId, "x.txt"), "utf8"), "one");
    killed.kill("SIGKILL");
    await killed.exited;
    assertEquals((await readdir(join(base, ".in-use"))).some((f) => f.startsWith(olderId)), true);
    unpackResources(newer, base);
    assertEquals((await readdir(base)).includes(olderId), false);
    assertEquals((await readdir(join(base, ".in-use"))).some((f) => f.startsWith(olderId)), false);
  } finally {
    removeTree(dir);
  }
});

test("another build's unpacking in progress stays while its process lives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const base = join(dir, "runtime");
    const archive = await packed(dir, { "x.txt": "one" });
    const gone = Bun.spawn([process.execPath, "-e", ""], { env: {} });
    await gone.exited;
    const live = `.0123456789abcdef.${process.pid}.x`;
    const dead = `.0123456789abcdef.${gone.pid}.x`;
    await mkdir(join(base, live), { recursive: true });
    await mkdir(join(base, dead), { recursive: true });
    unpackResources(archive, base);
    const left = await readdir(base);
    assertEquals(left.includes(live), true);
    assertEquals(left.includes(dead), false);
  } finally {
    removeTree(dir);
  }
});

test("the sanitizer opens the copy its parent names, and never unpacks or looks elsewhere", async () => {
  assertEquals(SANITIZER_SUBCOMMAND, ARTIFACT_SANITIZER_SUBCOMMAND);
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const archive = await packed(dir, { "x.txt": "one" });
    const root = unpackResources(archive, join(dir, "runtime"));
    const home = join(dir, "home");
    const env = { HOME: home, RYPH_HOME: join(home, ".ryph") };
    assertEquals(resourcesRootOrExit(archive, [SANITIZER_SUBCOMMAND, root, "1", "1"], env), root);
    assertEquals(existsSync(home), false);
    // Not a copy of this build, or not whole: refused, and nothing is written.
    await mkdir(join(dir, "other"));
    const other = unpackResources(
      await packed(join(dir, "other"), { "y.txt": "two" }),
      join(dir, "other", "runtime"),
    );
    for (const named of ["", "relative/path", other, join(dir, "runtime", "0123456789abcdef")]) {
      assertThrows(() => openUnpacked(archive, named), Error);
    }
    await chmod(root, 0o755);
    await chmod(join(root, "x.txt"), 0o644);
    await writeFile(join(root, "x.txt"), "two");
    assertThrows(() => openUnpacked(archive, root), Error, "not a complete copy");
    assertEquals(await readFile(join(root, "x.txt"), "utf8"), "two");
    assertEquals(existsSync(home), false);
  } finally {
    removeTree(dir);
  }
});

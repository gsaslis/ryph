// The two pieces of plumbing every other test stands on: the per-repository mutex, and the
// subprocess runner's handling of a child that will not read what it is given.
//
// Neither needs `rad` — the exec tests drive `git`, which is a hard requirement of the package
// anyway — so these run on a machine with no Radicle installed.

import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals } from "@std/assert";
import { cliRadExec } from "../src/adapters/rad/cli.ts";
import { heldRepoLocks, withRepoLock } from "../src/helpers/repo_lock.ts";

test("one key at a time, in the order it was asked for", async () => {
  const order: string[] = [];
  const started: string[] = [];
  const work = (name: string, ms: number) => async () => {
    started.push(name);
    await new Promise((r) => setTimeout(r, ms));
    order.push(name);
    return name;
  };
  // Queued back to back, longest first: without the lock `b` and `c` would finish before `a`.
  const all = Promise.all([
    withRepoLock("rad:one", work("a", 30)),
    withRepoLock("rad:one", work("b", 1)),
    withRepoLock("rad:one", work("c", 1)),
  ]);
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(started, ["a"], "only the head of the queue runs");
  assertEquals(await all, ["a", "b", "c"]);
  assertEquals(order, ["a", "b", "c"]);
});

test("a different key is a different queue", async () => {
  const order: string[] = [];
  await Promise.all([
    withRepoLock("rad:left", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("left");
    }),
    withRepoLock("rad:right", () => {
      order.push("right");
      return Promise.resolve();
    }),
  ]);
  assertEquals(order, ["right", "left"], "the second key never waited for the first");
});

test("a thrown operation releases the lock instead of wedging the repository", async () => {
  let thrown: unknown = null;
  const failing = withRepoLock("rad:wedge", () => Promise.reject(new Error("the push failed")));
  await failing.catch((err) => {
    thrown = err;
  });
  assertEquals(String(thrown), "Error: the push failed");
  // The next caller runs, and does NOT inherit the rejection.
  assertEquals(await withRepoLock("rad:wedge", () => Promise.resolve("after")), "after");
  // And the queue does not grow a permanent entry per repository ever written to.
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(heldRepoLocks(), 0);
});

test("a child that exits without reading its stdin is not a leaked process", async () => {
  const home = await mkdtemp(join(tmpdir(), "ryph-exec-"));
  try {
    const exec = cliRadExec({ home, passphrase: "", binDir: null, socket: "/dev/null" });
    // `git --version` answers and exits without touching stdin. A megabyte is far more than a
    // pipe will buffer, so the write blocks and then fails with EPIPE — which used to escape
    // before the timeout was armed, leaving the child unawaited and its pipes open. Only the
    // result is asserted: no resource sanitizer watches the pipes under bun.
    const out = await exec.git(home, ["--version"], { stdin: "x".repeat(1024 * 1024) });
    assertEquals(out.code, 0, out.stderr);
    assertEquals(out.timedOut, false);
    assertEquals(out.stdout.startsWith("git version"), true, out.stdout);
  } finally {
    await rm(home, { recursive: true });
  }
});

test("a stdin-reading child still gets what it was given", async () => {
  const home = await mkdtemp(join(tmpdir(), "ryph-exec-"));
  try {
    const exec = cliRadExec({ home, passphrase: "", binDir: null, socket: "/dev/null" });
    const out = await exec.git(home, ["hash-object", "--stdin"], { stdin: "hello\n" });
    assertEquals(out.code, 0, out.stderr);
    assertEquals(out.stdout.trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
  } finally {
    await rm(home, { recursive: true });
  }
});

test("a binary read comes back as the bytes it was, and is not decoded as text", async () => {
  const home = await mkdtemp(join(tmpdir(), "ryph-exec-"));
  try {
    const exec = cliRadExec({ home, passphrase: "", binDir: null, socket: "/dev/null" });
    assertEquals((await exec.git(home, ["init", "--quiet", "--bare", "."])).code, 0);
    // Not UTF-8: a decode would turn these into U+FFFD and lose them.
    const blob = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);
    const file = `${home}/blob.bin`;
    await writeFile(file, blob);
    const oid = (await exec.git(home, ["hash-object", "-w", file])).stdout.trim();

    const read = await exec.git(home, ["cat-file", "blob", oid], { binary: true });
    assertEquals(read.code, 0, read.stderr);
    assertEquals(read.bytes, blob);
    assertEquals(read.stdout, "", "a binary read is never decoded");
    // And a text read carries no second copy of its output.
    const text = await exec.git(home, ["cat-file", "-t", oid]);
    assertEquals(text.stdout.trim(), "blob");
    assertEquals(text.bytes, undefined);
  } finally {
    await rm(home, { recursive: true });
  }
});

test("git reads no config at all: not the user's, not the system's, not one built into the binary", async () => {
  const home = await mkdtemp(join(tmpdir(), "ryph-exec-"));
  try {
    const exec = cliRadExec({ home, passphrase: "", binDir: null, socket: "/dev/null" });
    // Apple's git carries a config compiled into the binary (`credential.helper=osxkeychain`,
    // at scope `unknown`) that only GIT_CONFIG_NOSYSTEM skips. Outside a repository, a hermetic
    // git lists nothing.
    const out = await exec.git(home, ["config", "--list", "--show-scope"]);
    assertEquals(out.code, 0, out.stderr);
    assertEquals(out.stdout.trim(), "");
  } finally {
    await rm(home, { recursive: true });
  }
});

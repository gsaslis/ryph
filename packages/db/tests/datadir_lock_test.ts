// The data directory lock: a second opener of a live PGlite directory is refused, a dead
// holder's lock is taken over, and a closed handle gives the lock back.

import { test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals, assertRejects } from "@std/assert";
import { DataDirLockedError, guardPath, lockDataDir } from "../src/datadir_lock.ts";
import { openDb } from "../src/open.ts";

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ryph-lock-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const exists = (path: string) => stat(path).then(() => true, () => false);

function writeHolder(lockPath: string, pid: number, token = "someone-else"): Promise<void> {
  return writeFile(
    lockPath,
    JSON.stringify({ pid, host: hostname(), startedAt: "2026-10-12T00:00:00.000Z", token }),
  );
}

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn("true");
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid!;
}

test("a held directory is refused, and released on close", async () => {
  await withRoot(async (root) => {
    const dataDir = join(root, "ryph");
    const first = await openDb(`pglite:${dataDir}`, {});
    try {
      assertEquals(await exists(`${dataDir}.lock`), true);
      const error = await assertRejects(
        () => openDb(`pglite:${dataDir}/`, {}),
        DataDirLockedError,
      );
      assertEquals(error.holder.pid, process.pid);
    } finally {
      await first.close();
    }
    assertEquals(await exists(`${dataDir}.lock`), false);
    const second = await openDb(`pglite:${dataDir}`, {});
    await second.close();
  });
});

test("a live process's lock is refused, naming its pid and the lock file", async () => {
  await withRoot(async (root) => {
    const dataDir = join(root, "ryph");
    const child = spawn("sleep", ["30"]);
    try {
      await writeHolder(`${dataDir}.lock`, child.pid!);
      const error = await assertRejects(() => lockDataDir(dataDir), DataDirLockedError);
      assertEquals(error.message.includes(`pid ${child.pid}`), true, error.message);
      assertEquals(error.message.includes(`${dataDir}.lock`), true, error.message);
      // Refusing leaves the holder's lock in place.
      assertEquals(JSON.parse(await readFile(`${dataDir}.lock`, "utf8")).pid, child.pid);
    } finally {
      child.kill();
    }
  });
});

test("a dead process's lock is taken over", async () => {
  await withRoot(async (root) => {
    const dataDir = join(root, "ryph");
    await writeHolder(`${dataDir}.lock`, await deadPid());
    const lock = await lockDataDir(dataDir);
    assertEquals(JSON.parse(await readFile(lock.lockPath, "utf8")).pid, process.pid);
    await lock.release();
    await lock.release();
    assertEquals(await exists(lock.lockPath), false);
  });
});

test("our own pid under a token we never took is a previous incarnation's, and stale", async () => {
  // A container restarted on the same volume gets the same small pid back.
  await withRoot(async (root) => {
    const dataDir = join(root, "ryph");
    await writeHolder(`${dataDir}.lock`, process.pid, "before-the-restart");
    const lock = await lockDataDir(dataDir);
    await lock.release();
  });
});

test("an unreadable lock is replaced", async () => {
  await withRoot(async (root) => {
    const dataDir = join(root, "ryph");
    await writeFile(`${dataDir}.lock`, "");
    const lock = await lockDataDir(dataDir);
    await lock.release();
  });
});

/** Takeover guards left in `root`. */
const guards = async (root: string) =>
  (await readdir(root)).filter((name) => name.includes(".takeover"));

test("a takeover guard left by a dead process is stepped over, and cleared", async () => {
  await withRoot(async (root) => {
    const dataDir = join(root, "ryph");
    const lockPath = `${dataDir}.lock`;
    const dead = await deadPid();
    await writeHolder(lockPath, dead);
    const seen = await readFile(lockPath, "utf8");
    // Two openers died mid-takeover, one after the other.
    const first = guardPath(lockPath, [seen]);
    await writeHolder(first, dead, "first-guard");
    const second = guardPath(lockPath, [seen, await readFile(first, "utf8")]);
    await writeHolder(second, dead, "second-guard");
    const lock = await lockDataDir(dataDir);
    assertEquals(JSON.parse(await readFile(lockPath, "utf8")).pid, process.pid);
    assertEquals(await guards(root), []);
    await lock.release();
  });
});

test("a live opener's takeover guard is never removed", async () => {
  // Clearing a guard judged dead used to be a check-then-remove: an opener could delete the live
  // guard another opener created since, and two openers would then both take the lock over.
  await withRoot(async (root) => {
    const dataDir = join(root, "ryph");
    const lockPath = `${dataDir}.lock`;
    await writeHolder(lockPath, await deadPid());
    const guard = guardPath(lockPath, [await readFile(lockPath, "utf8")]);
    const child = spawn("sleep", ["30"]);
    try {
      await writeHolder(guard, child.pid!, "live-guard");
      await assertRejects(() => lockDataDir(dataDir), Error, "kept racing");
      assertEquals(JSON.parse(await readFile(guard, "utf8")).token, "live-guard");
    } finally {
      child.kill();
    }
  });
});

test("racing openers over a stale lock: exactly one wins", async () => {
  // Enough of them that a gap between judging the lock stale and removing it shows up: at 64,
  // a takeover that moved the lock aside and put it back lost it in every round.
  await withRoot(async (root) => {
    const dataDir = join(root, "ryph");
    await writeHolder(`${dataDir}.lock`, await deadPid());
    const results = await Promise.allSettled(
      Array.from({ length: 64 }, () => lockDataDir(dataDir)),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    assertEquals(won.length, 1);
    for (const r of results) {
      if (r.status === "rejected") assertEquals(r.reason instanceof DataDirLockedError, true);
    }
    assertEquals(await guards(root), []);
    await (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof lockDataDir>>>).value
      .release();
  });
});

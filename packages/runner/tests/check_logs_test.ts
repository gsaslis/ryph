// The check logs a run saves for its agent (core/check_logs.ts): a fresh name each time, only
// from names the platform mints, counted lines, and nothing saved once the directory is gone.

import { test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { lineCount, runCheckLogs, SUITE_ID } from "../src/core/check_logs.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

test("check logs: each save is a new file, and none is saved after the directory is gone", async () => {
  const logs = runCheckLogs();
  const log = { suiteId: "cs-0123456789", check: "test", generation: 1, bytes: bytes("a\nb\n") };
  const first = await logs.save(log);
  const second = await logs.save(log);
  assert(first.path !== second.path);
  assertEquals(first.lines, 2);
  assertEquals(await readFile(first.path, "utf8"), "a\nb\n");
  const sortable = await logs.save({ ...log, suiteId: "cs-01jb7k3m9x4q8zt2vw6hn5c0fe" });
  assert(sortable.path.includes("cs-01jb7k3m9x4q8zt2vw6hn5c0fe"), sortable.path);
  await assertRejects(() => logs.save({ ...log, suiteId: "../x" }), Error, "not a check log");
  await assertRejects(() => logs.save({ ...log, check: "a/b" }), Error, "not a check log");
  await logs.remove();
  assertEquals(await stat(first.path).then(() => "present", (e) => e.code), "ENOENT");
  await assertRejects(() => logs.save(log), Error, "finalizing");
  await logs.remove();
});

test("check logs: a suite id is checked for a safe name, not for the platform's id format", () => {
  // The runner can be older than the orchestrator minting the ids (the harness layer reaches an
  // environment only when it is re-layered), so every shape the platform has minted or might
  // mint is taken: 10-hex, UUIDv7 base32, and a longer or other-case body.
  for (
    const id of [
      "cs-0123456789",
      "cs-01m4r5dasvernbfp25a77wb8f4",
      "cs-01jb7k3m9x4q8zt2vw6hn5c0fe",
      "cs-0123456789abcdef0123456789abcdef",
      "cs-01JB7K3M9X4Q8ZT2VW6HN5C0FE",
    ]
  ) assert(SUITE_ID.test(id), id);
  // Nothing that could name another path, or another kind of id.
  for (
    const id of [
      "cs-",
      "../x",
      "cs-../x",
      "cs-a/b",
      "cs-a.b",
      "cs-a b",
      "r-0123456789",
      "cs-" +
      "a".repeat(65),
      "cs-0123456789\n",
    ]
  ) assert(!SUITE_ID.test(id), id);
});

test("check logs: a save that waited on the directory while it was removed writes nothing", async () => {
  let made: (dir: string) => void = () => {};
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  const logs = runCheckLogs({ makeDir: () => new Promise((done) => (made = done)) });
  const saving = logs.save({
    suiteId: "cs-0123456789",
    check: "lint",
    generation: 1,
    bytes: bytes("x"),
  });
  const removing = logs.remove();
  made(dir);
  await assertRejects(() => saving, Error, "finalizing");
  await removing;
  assertEquals(await stat(dir).then(() => "present", (e) => e.code), "ENOENT");
});

test("check logs: lines as wc -l counts them, plus a last one with no newline", () => {
  assertEquals(lineCount(bytes("")), 0);
  assertEquals(lineCount(bytes("a")), 1);
  assertEquals(lineCount(bytes("a\n")), 1);
  assertEquals(lineCount(bytes("a\nb")), 2);
});

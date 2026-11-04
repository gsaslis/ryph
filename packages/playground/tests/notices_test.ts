import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "@std/path";
import { backdate } from "../src/backdate.ts";
import { FIXTURES } from "../src/fixtures.ts";
import { noticeCatalogue } from "../src/notices.ts";
import { resolve } from "../src/resolve.ts";

const at = "2026-10-13T12:00:00.000Z";
const catalogue = () => noticeCatalogue("person-owner", "patch-reviewable", "a".repeat(40), at);

test("notice catalogue covers every payload state, fallbacks and human attribution", () => {
  const { inbox } = catalogue();
  const payloads = inbox.flatMap((n) => n.payload ? [n.payload] : []);
  assertEquals(payloads.filter((p) => p.kind === "patch").map((p) => p.state).sort(), [
    "approved",
    "closed",
    "failed",
    "held",
    "merged",
    "missed",
    "rejected",
    "submitted",
    "superseded",
  ]);
  assertEquals(payloads.filter((p) => p.kind === "environment").map((p) => p.status).sort(), [
    "failed",
    "ready",
    "skipped",
    "superseded",
  ]);
  assertEquals(payloads.filter((p) => p.kind === "checks" && !p.partial).map((p) => p.state), [
    "passed",
    "failed",
    "error",
    "cancelled",
  ]);
  assert(payloads.some((p) => p.kind === "checks" && p.partial));
  assert(payloads.some((p) => p.kind === "released"));
  assert(payloads.some((p) => p.kind === "future-platform-notice"));
  assert(
    inbox.some((n) =>
      n.payload === null && n.kind === "system" && n.text.startsWith("A platform update")
    ),
  );
  assert(inbox.some((n) => n.kind === "user" && n.sender.kind === "user"));
  assertEquals(inbox.find((n) => n.payload?.kind === "finish")?.sender, {
    kind: "user",
    userId: "person-owner",
  });
  const held = inbox.find((n) => n.payload?.state === "held")!;
  assertEquals(held.payload?.patchId, "patch-reviewable");
  assert(held.text.includes("/patches/patch-reviewable"));
  assert(held.text.includes("Do not try to get around it"));
});

test("runner-local notices have no inbox cursor and retain original verbose details", () => {
  const { runner } = catalogue();
  assertEquals(runner.length, 8);
  assertEquals(runner.filter((n) => n.background).map((n) => n.background!.reason), [
    "ready",
    "exited",
    "timeout",
  ]);
  assertEquals(runner.filter((n) => n.subagent).map((n) => n.subagent!.reason), [
    "answered",
    "failed",
    "timeout",
  ]);
  assert(runner.some((n) => n.wake));
  assert(runner.some((n) => n.checksLate));
  for (const n of runner) {
    assert(!("seq" in n));
    assertEquals(n.payload, null);
    assertEquals(n.sender, { kind: "platform" });
    assert(n.text.length > 100, "keep the original explanation, not just the compact summary");
  }
});

test("notice fixture is default, separately selectable and removable", () => {
  for (const preset of ["ui", "full"]) {
    assert(resolve(FIXTURES, preset, [], []).some((f) => f.name === "platform-notices"));
    assert(
      !resolve(FIXTURES, preset, [], ["platform-notices"]).some((f) =>
        f.name === "platform-notices"
      ),
    );
  }
  assertEquals(resolve(FIXTURES, "empty", ["platform-notices"], []).map((f) => f.name), [
    "owner",
    "model",
    "repos",
    "agents",
    "platform-notices",
  ]);
});

test("offline seeding appends inbox notices after existing rows, preserving payloads and details", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-notices-"));
  const dir = join(root, "db");
  let db = new PGlite(dir);
  try {
    await db.exec(`create table run_messages (
      id text primary key, run_id text, seq integer, kind text, sender jsonb, text text,
      payload jsonb, attachments jsonb, created_at text, delivered_at text,
      unique (run_id, seq));
      create table patches (run_id text, landed jsonb);
      insert into run_messages values ('existing', 'run-example', 0, 'system', '{}', 'existing', null, '[]', '${at}', null);`);
    await db.close();
    const { inbox } = catalogue();
    await backdate(dir, [{
      runId: "run-example",
      taskId: "task-example",
      realStart: at,
      realEnd: "2026-10-13T12:00:01.000Z",
      ageMs: 60_000,
      durationMs: 30_000,
      notices: inbox,
    }], Date.parse(at));
    db = new PGlite(dir);
    const { rows } = await db.query<
      { seq: number; text: string; payload: unknown; sender: unknown; created_at: string }
    >("select * from run_messages order by seq");
    assertEquals(rows.length, inbox.length + 1);
    for (const [i, notice] of inbox.entries()) {
      assertEquals(rows[i + 1].seq, i + 1);
      assertEquals(rows[i + 1].text, notice.text);
      assertEquals(rows[i + 1].payload, notice.payload);
      assertEquals(rows[i + 1].sender, notice.sender);
      assertEquals(rows[i + 1].created_at, "2026-10-13T11:59:00.000Z");
    }
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

// The committed migration files, applied in order to a database whose tables already hold rows
// — the shape of every deployment after the first — and then compared with the schema: what
// the files build must be what the code expects, or the migrate job wedges the deploy.

import { test } from "bun:test";
import { readFile } from "node:fs/promises";
import { assertEquals } from "@std/assert";
import { sql } from "drizzle-orm";
import { pushSchema } from "drizzle-kit/api";
import { makeMemoryDb } from "../src/adapters/store/db/db.ts";
import * as schema from "../src/adapters/store/db/schema.ts";

const DIR = new URL("../drizzle/", import.meta.url);

async function migrations(): Promise<Array<{ tag: string; statements: string[] }>> {
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", DIR), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  return Promise.all(journal.entries.map(async ({ tag }) => ({
    tag,
    statements: (await readFile(new URL(`${tag}.sql`, DIR), "utf8"))
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  })));
}

/** One row per table, in the columns the FIRST migration made — what a later migration must
 * cope with. */
const SEED = [
  `INSERT INTO "memories" ("id","tenant_id","text","normalized_text","kind","subject_kind","audience_kind","status","trust","provenance","created_at","updated_at")
   VALUES ('mem-1','default','x','x','fact','org','all','canon','human','{"kind":"human","userId":"u"}','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`,
  `INSERT INTO "memory_proposals" ("id","tenant_id","text","origin","status","flags","created_at")
   VALUES ('prop-1','default','x','{"kind":"human","userId":"u"}','pending','[]','2026-09-01T00:00:00.000Z')`,
  `INSERT INTO "memory_runs" ("run_id","tenant_id","agent_id","briefed","created_at")
   VALUES ('r-1','default','a-1','["mem-1"]','2026-09-01T00:00:00.000Z')`,
  `INSERT INTO "memory_sources" ("id","tenant_id","kind","status","title","content_hash","text","default_subject_kind","ingested_by","ingested_at")
   VALUES ('src-1','default','paste','ready','t','h','x','org','u','2026-09-01T00:00:00.000Z')`,
  `INSERT INTO "memory_feedback" ("tenant_id","kind","memory_id","detail","at")
   VALUES ('default','confirm','mem-1','{}','2026-09-01T00:00:00.000Z')`,
];

test("every migration applies over tables that already hold rows, and they build the schema", async () => {
  const handle = await makeMemoryDb("pglite:memory://");
  try {
    const all = await migrations();
    assertEquals(all.length >= 10, true);
    for (const [i, migration] of all.entries()) {
      for (const statement of migration.statements) {
        await handle.db.execute(sql.raw(statement));
      }
      if (i === 0) { for (const seed of SEED) await handle.db.execute(sql.raw(seed)); }
      // A run of the shape the last single-fate migration left — two repos, one fate — for the
      // per-repo migration to carry across.
      if (migration.tag === "0005_graceful_speed") {
        await handle.db.execute(sql.raw(
          `INSERT INTO "memory_runs" ("run_id","task_id","tenant_id","agent_id","repos","briefed","change","created_at")
           VALUES ('r-2','t-2','default','a-1','["github.com/acme/api","github.com/acme/web"]','[]','landed','2026-09-02T00:00:00.000Z')`,
        ));
      }
      // Rows of the shape the per-repo migration left — one fate per repo on the run, and the
      // run's introduced claims bound to nothing — for the per-patch migration to carry: a
      // synthetic patch per repo whose fate was reported, and the claims bound to the last one.
      if (migration.tag === "0007_last_squadron_supreme") {
        for (
          const seed of [
            `INSERT INTO "memory_runs" ("run_id","task_id","tenant_id","agent_id","repos","briefed","changes","created_at")
             VALUES ('r-3','t-3','default','a-1','["github.com/acme/api","github.com/acme/web","github.com/acme/docs"]','[]','{"github.com/acme/api":"pending","github.com/acme/web":"none","github.com/acme/docs":"dropped"}','2026-09-03T00:00:00.000Z')`,
            `INSERT INTO "memory_proposals" ("id","tenant_id","text","origin","basis","status","flags","created_at")
             VALUES ('prop-r3','default','x','{"kind":"run","runId":"r-3","taskId":"t-3"}','introduced','pending','[]','2026-09-03T00:00:00.000Z')`,
            `INSERT INTO "memory_proposals" ("id","tenant_id","text","origin","basis","status","flags","created_at")
             VALUES ('prop-r3-done','default','x','{"kind":"run","runId":"r-3","taskId":"t-3"}','introduced','promoted','[]','2026-09-03T00:00:00.000Z')`,
            `INSERT INTO "memory_proposals" ("id","tenant_id","text","origin","basis","status","flags","created_at")
             VALUES ('prop-r3-obs','default','x','{"kind":"run","runId":"r-3","taskId":"t-3"}','observed','pending','[]','2026-09-03T00:00:00.000Z')`,
          ]
        ) await handle.db.execute(sql.raw(seed));
      }
    }
    // The rows survived every ALTER, and the final shape is the schema drizzle-kit would push.
    const runs = await handle.db.execute(
      sql`select "run_id", "task_id", "outcome" from "memory_runs" order by "run_id"`,
    ) as unknown as { rows: unknown[] };
    assertEquals(runs.rows, [
      { run_id: "r-1", task_id: "", outcome: null },
      { run_id: "r-2", task_id: "t-2", outcome: null },
      { run_id: "r-3", task_id: "t-3", outcome: null },
    ]);
    // Every reported fate became a patch row (a repo the run made no change in did not), in
    // the order the fates were keyed, and the still-pending claim bound to the run's last one.
    const changes = await handle.db.execute(
      sql`select "patch_id", "run_id", "repo", "generation", "seq", "head_sha", "fate" from "memory_changes" order by "run_id", "seq"`,
    ) as unknown as { rows: unknown[] };
    assertEquals(changes.rows, [
      {
        patch_id: "legacy:r-2:github.com/acme/api",
        run_id: "r-2",
        repo: "github.com/acme/api",
        generation: 1,
        seq: 0,
        head_sha: null,
        fate: "landed",
      },
      {
        patch_id: "legacy:r-2:github.com/acme/web",
        run_id: "r-2",
        repo: "github.com/acme/web",
        generation: 1,
        seq: 1,
        head_sha: null,
        fate: "landed",
      },
      {
        patch_id: "legacy:r-3:github.com/acme/api",
        run_id: "r-3",
        repo: "github.com/acme/api",
        generation: 1,
        seq: 0,
        head_sha: null,
        fate: "pending",
      },
      {
        patch_id: "legacy:r-3:github.com/acme/docs",
        run_id: "r-3",
        repo: "github.com/acme/docs",
        generation: 1,
        seq: 1,
        head_sha: null,
        fate: "dropped",
      },
    ]);
    const proposals = await handle.db.execute(
      sql`select "id", "change_id" from "memory_proposals" order by "id"`,
    ) as unknown as { rows: unknown[] };
    assertEquals(proposals.rows, [
      { id: "prop-1", change_id: null },
      { id: "prop-r3", change_id: "legacy:r-3:github.com/acme/docs" },
      { id: "prop-r3-done", change_id: null },
      { id: "prop-r3-obs", change_id: null },
    ]);
    // drizzle-kit reads a `jsonb_path_ops` index back in a spelling it does not recognise as
    // its own and offers to drop and recreate it identically; that is not drift. Anything
    // touching a table or a column is.
    const { statementsToExecute } = await pushSchema(schema, handle.db as never);
    const drift = statementsToExecute.filter((st) =>
      !/^(DROP|CREATE) INDEX .*(memories_by_provenance|memory_proposals_by_origin|memory_runs_by_briefed)/
        .test(st)
    );
    assertEquals(drift, []);
  } finally {
    await handle.close();
  }
});

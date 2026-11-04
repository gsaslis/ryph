// The committed migration files, applied in order to a database whose tables already hold rows
// — the shape of every deployment after the first — and then checked against what the schema
// declares: the key, the lane column and the lane listing's index, read back from the catalog.
//
// Not a pushSchema drift check, as other packages have: drizzle-kit 0.31's introspection of an
// existing composite primary key sends PGlite a bind message it refuses (08P01) and exits the
// process. That the files and db/schema.ts agree is `bun run db:generate` answering "No schema
// changes".

import { test } from "bun:test";
import { readFile } from "node:fs/promises";
import { assertEquals, assertRejects } from "@std/assert";
import { sql } from "drizzle-orm";
import { makeHistorianDb } from "../src/adapters/store/db/db.ts";

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

test("every migration applies over tables that already hold rows, and keys history by lane", async () => {
  const handle = await makeHistorianDb("pglite:memory://");
  try {
    for (const [i, migration] of (await migrations()).entries()) {
      for (const statement of migration.statements) {
        await handle.db.execute(sql.raw(statement));
      }
      // A run recorded before lanes existed, in the columns the first migration made.
      if (i === 0) {
        await handle.db.execute(sql.raw(
          `INSERT INTO "history_events" ("run_id","seq","at","voice","kind")
           VALUES ('r-1',0,'2026-09-01T00:00:00.000Z','transcript','assistant'),
                  ('r-1',1,'2026-09-01T00:00:00.000Z','diag','pi.spawn')`,
        ));
      }
    }
    // Every row from before is the run's own transcript...
    const rows = await handle.db.execute(
      sql`select "run_id", "lane", "seq" from "history_events" order by "seq"`,
    ) as unknown as { rows: unknown[] };
    assertEquals(rows.rows, [
      { run_id: "r-1", lane: "", seq: 0 },
      { run_id: "r-1", lane: "", seq: 1 },
    ]);
    // ...the key is per lane: the same seq lands in a subagent's lane, and not twice in the main.
    await handle.db.execute(sql.raw(
      `INSERT INTO "history_events" ("run_id","lane","seq","at","voice","kind")
       VALUES ('r-1','sa-1',0,'2026-09-01T00:00:00.000Z','transcript','subagent.start')`,
    ));
    await assertRejects(() =>
      handle.db.execute(sql.raw(
        `INSERT INTO "history_events" ("run_id","seq","at","voice","kind")
         VALUES ('r-1',0,'2026-09-01T00:00:00.000Z','transcript','assistant')`,
      ))
    );
    const key = await handle.db.execute(sql.raw(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'history_events'::regclass and contype = 'p'`,
    )) as unknown as { rows: unknown[] };
    assertEquals(key.rows, [
      { conname: "history_events_run_id_lane_seq_pk", def: "PRIMARY KEY (run_id, lane, seq)" },
    ]);
    // The lane listing's index: a lane's transcript starts, resumes and ends, by kind and seq.
    const lifecycle = await handle.db.execute(sql.raw(
      `select indexdef from pg_indexes
       where tablename = 'history_events' and indexname = 'history_events_lane_lifecycle'`,
    )) as unknown as { rows: { indexdef: string }[] };
    assertEquals(lifecycle.rows.map((r) => r.indexdef), [
      "CREATE INDEX history_events_lane_lifecycle ON public.history_events USING btree " +
      "(run_id, lane, kind, seq) WHERE ((voice = 'transcript'::text) AND " +
      "(kind = ANY (ARRAY['subagent.start'::text, 'subagent.resume'::text, 'subagent.end'::text])))",
    ]);
  } finally {
    await handle.close();
  }
});

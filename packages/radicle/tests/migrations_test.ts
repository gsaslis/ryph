// The committed migration files, applied in order, then compared with the schema: what the
// files build must be what the code expects, or the migrate job wedges the deploy.

import { test } from "bun:test";
import { readFile } from "node:fs/promises";
import { assertEquals } from "@std/assert";
import { sql } from "drizzle-orm";
import { pushSchema } from "drizzle-kit/api";
import { makeRadicleDb } from "../src/adapters/cursor_store/db/db.ts";
import * as schema from "../src/adapters/cursor_store/db/schema.ts";

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

/** One row in the columns the FIRST migration made, so a later one has to migrate real data. */
const SEED = [
  `INSERT INTO "radicle_cursors" ("rid","ref","oid","updated_at")
   VALUES ('rad:z4V14vdenmiCJQPkp9347PXnNUahZ','refs/namespaces/z6Mk/refs/cobs/t/o','abc','2026-09-01T00:00:00.000Z')`,
];

test("every migration applies over tables that already hold rows, and they build the schema", async () => {
  const handle = await makeRadicleDb("pglite:memory://");
  try {
    const all = await migrations();
    assertEquals(all.length >= 1, true);
    for (const [i, migration] of all.entries()) {
      for (const statement of migration.statements) {
        await handle.db.execute(sql.raw(statement));
      }
      if (i === 0) { for (const seed of SEED) await handle.db.execute(sql.raw(seed)); }
    }
    const rows = await handle.db.execute(sql`select "oid" from "radicle_cursors"`) as unknown as {
      rows: unknown[];
    };
    assertEquals(rows.rows, [{ oid: "abc" }]);
    // No drift: the committed files and the schema describe the same database.
    const { statementsToExecute } = await pushSchema(schema, handle.db as never);
    assertEquals(statementsToExecute, []);
  } finally {
    await handle.close();
  }
});

// The committed migration files, applied in order, then compared with the schema: what the
// files build must be what the code expects, or the migrate job wedges the deploy.

import { test } from "bun:test";
import { readFile } from "node:fs/promises";
import { assertEquals } from "@std/assert";
import { sql } from "drizzle-orm";
import { pushSchema } from "drizzle-kit/api";
import { makeChatDb } from "../src/adapters/store/db/db.ts";
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

/** One row per table, in the columns the FIRST migration made. */
const SEED = [
  `INSERT INTO "chatrooms" ("id","name","kind","bot_username","bot_id","sealed_bot_token","owner_user_id","created_at","updated_at")
   VALUES ('chr-1','acme','telegram','ryph_bot','1','sealed','u-1','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`,
  `INSERT INTO "chat_bindings" ("id","chatroom_id","run_id","agent_name","task_title","state","created_at")
   VALUES ('cb-1','chr-1','r-1','Ada','t','active','2026-09-01T00:00:00.000Z')`,
  `INSERT INTO "chat_poll_cursors" ("chatroom_id","offset","updated_at")
   VALUES ('chr-1',3,'2026-09-01T00:00:00.000Z')`,
];

test("every migration applies over tables that already hold rows, and they build the schema", async () => {
  const handle = await makeChatDb("pglite:memory://");
  try {
    const all = await migrations();
    assertEquals(all.length >= 1, true);
    for (const [i, migration] of all.entries()) {
      for (const statement of migration.statements) {
        await handle.db.execute(sql.raw(statement));
      }
      if (i === 0) { for (const seed of SEED) await handle.db.execute(sql.raw(seed)); }
    }
    const rooms = await handle.db.execute(sql`select "id" from "chatrooms"`) as unknown as {
      rows: unknown[];
    };
    assertEquals(rooms.rows, [{ id: "chr-1" }]);
    // A binding from before conversations existed is Telegram's one conversation.
    const bindings = await handle.db.execute(
      sql`select "thread_key" from "chat_bindings"`,
    ) as unknown as { rows: unknown[] };
    assertEquals(bindings.rows, [{ thread_key: "" }]);
    const { statementsToExecute } = await pushSchema(schema, handle.db as never);
    assertEquals(statementsToExecute, []);
  } finally {
    await handle.close();
  }
});

// The suite wrapper over bun:test: cases run in order on one database, each starting from empty
// tables, and the database is opened only by a case that asks for it.

import { expect } from "bun:test";
import { assertEquals, assertThrows } from "@std/assert";
import { sql } from "drizzle-orm";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { openDb, rowsOf } from "../src/mod.ts";
import { reusableDbSuite } from "../src/testing.ts";

const rows = pgTable("rows", { id: serial("id").primaryKey(), value: text("value") });
const schema = { rows };
let opened = 0;

const { test, makeTestDb } = reusableDbSuite("reusable suite", {
  schema,
  open: async () => {
    opened++;
    const handle = await openDb("pglite:memory://", schema);
    await handle.db.execute(sql`CREATE TABLE rows (id serial PRIMARY KEY, value text)`);
    return handle;
  },
});

test("a case that never asks opens nothing", () => {
  assertEquals(opened, 0);
  return Promise.resolve();
});

test("a case writes a row", async () => {
  const handle = await makeTestDb();
  await handle.db.insert(rows).values({ value: "first" });
  const [row] = rowsOf<{ id: number }>(await handle.db.execute(sql`SELECT id FROM rows`));
  assertEquals(row.id, 1);
});

test("the next case starts from empty tables and a reset sequence, on the same database", async () => {
  const handle = await makeTestDb();
  assertEquals(rowsOf(await handle.db.execute(sql`SELECT * FROM rows`)).length, 0);
  await handle.db.insert(rows).values({ value: "second" });
  const [row] = rowsOf<{ id: number }>(await handle.db.execute(sql`SELECT id FROM rows`));
  assertEquals(row.id, 1);
  expect(opened).toBe(1);
});

test("the lease refuses what needs a fresh database", async () => {
  const handle = await makeTestDb();
  assertThrows(() => handle.migrate("nowhere"), Error, "makeTestDb()");
});

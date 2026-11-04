import { test } from "bun:test";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { sql } from "drizzle-orm";
import { pgSchema, serial, text } from "drizzle-orm/pg-core";
import { openDb, rowsOf } from "../src/mod.ts";
import { ReusableTestDb } from "../src/testing.ts";

test("shared fixture resets schema-qualified tables, quoted names and aliases", async () => {
  const first = pgSchema("first").table('row"data', {
    id: serial("id").primaryKey(),
    value: text("value"),
  });
  const second = pgSchema('sec"ond').table('row"data', {
    id: serial("id").primaryKey(),
    value: text("value"),
  });
  const schema = { first, second, alias: first };
  let opened = 0;
  let closed = 0;
  const fixture = new ReusableTestDb({
    schema,
    open: async () => {
      opened++;
      const handle = await openDb("pglite:memory://", schema);
      for (
        const statement of [
          "CREATE SCHEMA first",
          'CREATE SCHEMA "sec""ond"',
          'CREATE TABLE first."row""data" (id serial PRIMARY KEY, value text)',
          'CREATE TABLE "sec""ond"."row""data" (id serial PRIMARY KEY, value text)',
        ]
      ) {
        await handle.db.execute(sql.raw(statement));
      }
      return {
        ...handle,
        close: async () => {
          closed++;
          await handle.close();
        },
      };
    },
  });
  try {
    await assertRejects(
      () =>
        fixture.run(async (getDb) => {
          const { db } = await getDb();
          // The query builder does not escape embedded identifier quotes. Raw SQL lets us
          // exercise the fixture's schema-derived reset statement independently of that.
          await db.execute(sql.raw(`INSERT INTO first."row""data" (value) VALUES ('one')`));
          await db.execute(sql.raw(`INSERT INTO "sec""ond"."row""data" (value) VALUES ('two')`));
          throw new Error("failed case");
        }),
      Error,
      "failed case",
    );
    await fixture.run(async (getDb) => {
      const { db } = await getDb();
      for (const table of ['first."row""data"', '"sec""ond"."row""data"']) {
        assertEquals(rowsOf(await db.execute(sql.raw(`SELECT * FROM ${table}`))), []);
        const rows = rowsOf<{ id: number }>(
          await db.execute(
            sql.raw(`INSERT INTO ${table} (value) VALUES ('new') RETURNING id`),
          ),
        );
        assertEquals(rows[0].id, 1);
      }
    });
    assertEquals(opened, 1);
  } finally {
    await fixture.close();
  }
  assertEquals(closed, 1);
});

test("shared fixture rejects a schema with no tables before opening a database", () => {
  assertThrows(
    () =>
      new ReusableTestDb({
        schema: {},
        open: () => {
          throw new Error("must not open");
        },
      }),
    Error,
    "must contain tables",
  );
});

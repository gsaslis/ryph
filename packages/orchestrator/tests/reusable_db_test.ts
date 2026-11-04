import { test } from "bun:test";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { rowsOf } from "@ryph/db";
import { sql } from "drizzle-orm";
import type { OrchestratorDbHandle } from "../src/adapters/store/db/db.ts";
import { makeTestDb } from "./db.ts";
import { ReusableTestDb } from "./reusable_db.ts";

test("reusable database resets rows and sequences after failure and closes once", async () => {
  let opened = 0;
  let closed = 0;
  const fixture = new ReusableTestDb(async () => {
    opened++;
    const handle = await makeTestDb();
    return {
      ...handle,
      close: async () => {
        closed++;
        await handle.close();
      },
    };
  }, true);
  let expired: (() => Promise<OrchestratorDbHandle>) | undefined;
  try {
    await assertRejects(
      () =>
        fixture.run(async (getDb) => {
          expired = getDb;
          const [first, second] = await Promise.all([getDb(), getDb()]);
          assertEquals(first === second, true);
          await first.db.execute(sql`INSERT INTO reserved_capacity (id, slots, updated_at)
          VALUES ('singleton', '{}', 'now')`);
          const result = await first.db.execute(sql`SELECT nextval('run_events_seq_seq') AS seq`);
          assertEquals(Number(rowsOf<{ seq: number | string }>(result)[0].seq), 1);
          assertThrows(() => first.listen("test", () => {}), Error, "Use makeTestDb");
          await first.close();
          assertEquals(closed, 0);
          throw new Error("intentional test failure");
        }),
      Error,
      "intentional test failure",
    );
    await assertRejects(() => expired!(), Error, "expired");
    await fixture.run(async (getDb) => {
      const handle = await getDb();
      const rows = await handle.db.execute(sql`SELECT * FROM reserved_capacity`);
      assertEquals(rowsOf(rows).length, 0);
      const result = await handle.db.execute(sql`SELECT nextval('run_events_seq_seq') AS seq`);
      assertEquals(Number(rowsOf<{ seq: number | string }>(result)[0].seq), 1);
    });
    assertEquals(opened, 1);
  } finally {
    await fixture.close();
  }
  await fixture.close();
  assertEquals(closed, 1);
  await assertRejects(() => fixture.run(async () => {}), Error, "closed");
});

test("reusable database rejects overlap and stays lazy for memory-only tests", async () => {
  let opened = 0;
  const fixture = new ReusableTestDb(() => {
    opened++;
    throw new Error("must not open");
  });
  try {
    await fixture.run(async () => {
      await assertRejects(() => fixture.run(async () => {}), Error, "must not overlap");
      await assertRejects(() => fixture.close(), Error, "active");
    });
    assertEquals(opened, 0);
  } finally {
    await fixture.close();
  }
});

test("non-reusing fixture closes each database before the next test", async () => {
  let opened = 0;
  let closed = 0;
  const fixture = new ReusableTestDb(async () => {
    opened++;
    const handle = await makeTestDb();
    return {
      ...handle,
      close: async () => {
        closed++;
        await handle.close();
      },
    };
  }, false);
  try {
    for (let i = 1; i <= 2; i++) {
      await fixture.run(async (getDb) => {
        await getDb();
      });
      assertEquals(opened, i);
      assertEquals(closed, i);
    }
  } finally {
    await fixture.close();
  }
  assertEquals(closed, 2);
});

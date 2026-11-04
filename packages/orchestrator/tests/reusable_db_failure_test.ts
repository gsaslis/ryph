import { test } from "bun:test";
import { assertEquals, assertRejects } from "@std/assert";
import type { OrchestratorDbHandle } from "../src/adapters/store/db/db.ts";
import { makeTestDb } from "./db.ts";
import { ReusableTestDb } from "./reusable_db.ts";

test("a failed reset discards the database rather than lending dirty state", async () => {
  let opened = 0;
  let closed = 0;
  const fixture = new ReusableTestDb(async () => {
    opened++;
    const handle = await makeTestDb();
    const failReset = opened === 1;
    return {
      ...handle,
      db: new Proxy(handle.db, {
        get(target, key, receiver) {
          if (failReset && key === "execute") {
            return () => Promise.reject(new Error("reset failed"));
          }
          return Reflect.get(target, key, receiver);
        },
      }),
      close: async () => {
        closed++;
        await handle.close();
      },
    };
  }, true);
  try {
    await assertRejects(
      () =>
        fixture.run(async (getDb) => {
          await getDb();
        }),
      Error,
      "reset failed",
    );
    assertEquals(closed, 1);
    await fixture.run(async (getDb) => {
      await getDb();
    });
    assertEquals(opened, 2);
  } finally {
    await fixture.close();
  }
  assertEquals(closed, 2);
});

test("fixture preserves body and cleanup errors, including reset disposal failures", async () => {
  for (const phase of ["reset", "close", "reset and close"] as const) {
    const bodyError = new Error("body failed");
    const resetError = new Error("reset failed");
    const closeError = new Error("close failed");
    let closed = 0;
    const fixture = new ReusableTestDb(() =>
      Promise.resolve({
        db: {
          execute: () => Promise.reject(resetError),
        } as unknown as OrchestratorDbHandle["db"],
        description: "fake failure-only handle",
        migrate: () => Promise.resolve(),
        notify: () => Promise.resolve(),
        listen: () => Promise.resolve(() => Promise.resolve()),
        lockSession: () => Promise.reject(new Error("not used")),
        close: () => {
          closed++;
          return phase === "reset" ? Promise.resolve() : Promise.reject(closeError);
        },
      }), phase !== "close");
    try {
      const error = await assertRejects(
        () =>
          fixture.run(async (getDb) => {
            await getDb();
            throw bodyError;
          }),
        AggregateError,
        "Test body and database cleanup failed",
      );
      assertEquals(error.errors[0], bodyError);
      if (phase === "reset and close") {
        assertEquals((error.errors[1] as AggregateError).errors, [resetError, closeError]);
      } else {
        assertEquals(error.errors[1], phase === "reset" ? resetError : closeError);
      }
      assertEquals(closed, 1);
      // Failure clears the active flag; disposal removed the poisoned handle.
      await fixture.run(async () => {});
    } finally {
      await fixture.close();
    }
    assertEquals(closed, 1);
  }
});

test("fixture preserves an assertion after open fails without duplicating a propagated error", async () => {
  const openError = new Error("open failed");
  const bodyError = new Error("assertion after failed open");
  const fixture = new ReusableTestDb(() => Promise.reject(openError));
  try {
    const combined = await assertRejects(() =>
      fixture.run(async (getDb) => {
        await assertRejects(getDb, Error, "open failed");
        throw bodyError;
      }), AggregateError);
    assertEquals(combined.errors, [bodyError, openError]);
    const propagated = await assertRejects(
      () =>
        fixture.run(async (getDb) => {
          await getDb();
        }),
      Error,
      "open failed",
    );
    assertEquals(propagated, openError);
    // A handled open failure must still fail cleanup, even when the body succeeds.
    const cleanupOnly = await assertRejects(
      () =>
        fixture.run(async (getDb) => {
          await assertRejects(getDb, Error, "open failed");
        }),
      Error,
      "open failed",
    );
    assertEquals(cleanupOnly, openError);
  } finally {
    await fixture.close();
  }
});

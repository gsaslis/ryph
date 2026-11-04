// Both cursor stores through ONE suite. The in-memory one is what a database-less deployment
// gets and what most tests use; the drizzle one is what production runs. They are only
// interchangeable if they behave identically, so they are asserted identically.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import type { CursorStore } from "../src/ports/cursor_store.ts";
import { memoryCursorStore } from "../src/adapters/cursor_store/memory.ts";
import { drizzleCursorStore } from "../src/adapters/cursor_store/drizzle.ts";
import { makeTestDb } from "./db.ts";

const RID_A = "rad:z4V14vdenmiCJQPkp9347PXnNUahZ";
const RID_B = "rad:z2MZ4tdv3bSDLFmhCfAWpN4Kd5qRC";
const REF_1 = "refs/namespaces/z6Mk1/refs/cobs/xyz.radicle.patch/" + "a".repeat(40);
const REF_2 = "refs/namespaces/z6Mk2/refs/cobs/xyz.radicle.issue/" + "b".repeat(40);

async function suite(name: string, open: () => Promise<CursorStore>) {
  await test(`${name}: an unknown cursor is null, not an error`, async () => {
    const store = await open();
    try {
      assertEquals(await store.get(RID_A, REF_1), null);
      assertEquals(await store.listByRepo(RID_A), []);
    } finally {
      await store.close();
    }
  });

  await test(`${name}: set then get, and set again overwrites`, async () => {
    const store = await open();
    try {
      await store.set(RID_A, REF_1, "1".repeat(40));
      assertEquals(await store.get(RID_A, REF_1), "1".repeat(40));
      await store.set(RID_A, REF_1, "2".repeat(40));
      assertEquals(await store.get(RID_A, REF_1), "2".repeat(40));
      assertEquals((await store.listByRepo(RID_A)).length, 1);
    } finally {
      await store.close();
    }
  });

  await test(`${name}: cursors are scoped to their repository`, async () => {
    const store = await open();
    try {
      await store.set(RID_A, REF_1, "1".repeat(40));
      await store.set(RID_A, REF_2, "2".repeat(40));
      await store.set(RID_B, REF_1, "3".repeat(40));
      const a = (await store.listByRepo(RID_A)).map((c) => c.ref).sort();
      assertEquals(a, [REF_1, REF_2].sort());
      assertEquals((await store.listByRepo(RID_B)).map((c) => c.oid), ["3".repeat(40)]);
      // The pair is the key: the same ref name under two repos is two cursors.
      assertEquals(await store.get(RID_B, REF_1), "3".repeat(40));
    } finally {
      await store.close();
    }
  });

  await test(`${name}: clearing a repo forgets only that repo`, async () => {
    const store = await open();
    try {
      await store.set(RID_A, REF_1, "1".repeat(40));
      await store.set(RID_B, REF_1, "3".repeat(40));
      await store.clearRepo(RID_A);
      assertEquals(await store.listByRepo(RID_A), []);
      assertEquals((await store.listByRepo(RID_B)).length, 1);
    } finally {
      await store.close();
    }
  });
}

await suite("memory", () => Promise.resolve(memoryCursorStore()));
await suite("drizzle", async () => drizzleCursorStore(await makeTestDb()));

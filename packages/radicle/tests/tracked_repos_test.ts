// Both tracked-repository stores through ONE suite, as the cursor stores are: the in-memory one
// is what the tests drive the service with, the drizzle one is what a user-mode bridge runs on.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import type { TrackedRepoStore } from "../src/ports/tracked_repos.ts";
import { memoryTrackedRepos } from "../src/adapters/tracked_repos/memory.ts";
import { drizzleTrackedRepos } from "../src/adapters/tracked_repos/drizzle.ts";
import { makeTestDb } from "./db.ts";

const RID_A = "rad:z4V14vdenmiCJQPkp9347PXnNUahZ";
const RID_B = "rad:z2MZ4tdv3bSDLFmhCfAWpN4Kd5qRC";

async function suite(name: string, open: () => Promise<[TrackedRepoStore, () => Promise<void>]>) {
  await test(`${name}: nothing is tracked until something is`, async () => {
    const [store, close] = await open();
    try {
      assertEquals(await store.list(), []);
      assertEquals(await store.get(RID_A), null);
      assertEquals(await store.untrack(RID_A), null);
    } finally {
      await close();
    }
  });

  await test(`${name}: track, list in RID order, untrack answers the row`, async () => {
    const [store, close] = await open();
    try {
      await store.track(RID_A, false);
      await store.track(RID_B, true);
      assertEquals((await store.list()).map((r) => [r.rid, r.createdPolicy]), [
        [RID_B, true],
        [RID_A, false],
      ]);
      const gone = await store.untrack(RID_B);
      assertEquals(gone?.rid, RID_B);
      assertEquals(gone?.createdPolicy, true);
      assertEquals((await store.list()).map((r) => r.rid), [RID_A]);
    } finally {
      await close();
    }
  });

  await test(`${name}: tracking again never rewrites who wrote the policy`, async () => {
    const [store, close] = await open();
    try {
      await store.track(RID_A, true);
      const first = (await store.get(RID_A))!.trackedAt;
      await new Promise((r) => setTimeout(r, 5));
      // The second connect finds the policy the first one wrote, and must not forget that.
      await store.track(RID_A, false);
      assertEquals((await store.get(RID_A))?.createdPolicy, true);
      // …and is when it was last tracked: what tells a connect in flight from a stale row.
      assert((await store.get(RID_A))!.trackedAt > first);
      assertEquals((await store.list()).length, 1);
      // …while a leftover "not ours" is corrected the moment ryph does write one.
      await store.track(RID_B, false);
      await store.track(RID_B, true);
      assertEquals((await store.get(RID_B))?.createdPolicy, true);
    } finally {
      await close();
    }
  });

  await test(`${name}: a pending unseed is out of scope, and tracking again calls it off`, async () => {
    const [store, close] = await open();
    try {
      await store.track(RID_A, true);
      await store.markUnseedPending(RID_A);
      assertEquals(await store.list(), []);
      assertEquals((await store.get(RID_A))?.unseedPending, true);
      assertEquals((await store.pendingUnseeds()).map((r) => r.rid), [RID_A]);
      await store.track(RID_A, false);
      assertEquals((await store.get(RID_A))?.unseedPending, false);
      assertEquals((await store.get(RID_A))?.createdPolicy, true);
      assertEquals(await store.pendingUnseeds(), []);
      assertEquals((await store.list()).map((r) => r.rid), [RID_A]);
    } finally {
      await close();
    }
  });
}

await suite("memory", () => {
  const store = memoryTrackedRepos();
  return Promise.resolve([store, () => Promise.resolve()]);
});
await suite("drizzle", async () => {
  const db = await makeTestDb();
  return [drizzleTrackedRepos(db), () => db.close()];
});

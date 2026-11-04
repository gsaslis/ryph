// The store's SQL against real PostgreSQL (PGlite in memory): seq assignment, head
// ordering, and the conditional write that is the concurrency control.

import { assert, assertEquals } from "@std/assert";
import { sql } from "drizzle-orm";
import { rowsOf } from "@ryph/db";
import { drizzleHookStore, dueQueuesQuery, headHookQuery } from "../src/adapters/store/drizzle.ts";
import { openHook } from "../src/core/hook_lifecycle.ts";
import type { HookStore } from "../src/ports/hook_store.ts";
import { reusableDbSuite } from "./reusable_db.ts";

const { test, makeTestDb } = reusableDbSuite("webhooks store");

const T0 = "2026-01-01T00:00:00.000Z";

function record(
  store: HookStore,
  id: string,
  registrationId = "github",
  scope: string | null = null,
) {
  return store.recordHook(openHook({ id, registrationId, scope, headers: {}, body: "{}" }, T0));
}

test("recordHook assigns monotonically increasing seq in arrival order", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    const first = await record(store, "wh-0000000001");
    const second = await record(store, "wh-0000000002");
    const third = await record(store, "wh-0000000003");
    assert(first.seq < second.seq && second.seq < third.seq);
  } finally {
    await handle.close();
  }
});

test("the head is the oldest live hook, and terminal rows never surface", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    const first = await record(store, "wh-0000000001");
    const second = await record(store, "wh-0000000002");
    await record(store, "wh-0000000003");

    assertEquals((await store.getHeadHook("github"))?.id, first.id);

    // The oldest goes terminal → the head steps forward.
    await store.saveHook({ ...first, state: "delivered" });
    assertEquals((await store.getHeadHook("github"))?.id, second.id);

    // Exhausted is equally invisible — this is the step-over.
    await store.saveHook({ ...second, state: "exhausted" });
    assertEquals((await store.getHeadHook("github"))?.id, "wh-0000000003");
  } finally {
    await handle.close();
  }
});

test("queues are per registration — one mailbox's head is not another's", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    await record(store, "wh-0000000001", "github");
    await record(store, "wh-0000000002", "gitlab");
    assertEquals((await store.getHeadHook("github"))?.id, "wh-0000000001");
    assertEquals((await store.getHeadHook("gitlab"))?.id, "wh-0000000002");
    assertEquals(await store.getHeadHook("unbound"), null);
  } finally {
    await handle.close();
  }
});

test("queues are per (registration, scope) — and every unscoped hook is one queue", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    await record(store, "wh-0000000001", "gitlab", "1");
    await record(store, "wh-0000000002", "gitlab", "2");
    await record(store, "wh-0000000003", "gitlab", "1");
    await record(store, "wh-0000000004", "gitlab", null);
    await record(store, "wh-0000000005", "gitlab", null);
    await record(store, "wh-0000000006", "github", null);

    assertEquals((await store.getHeadHook("gitlab", "1"))?.id, "wh-0000000001");
    assertEquals((await store.getHeadHook("gitlab", "2"))?.id, "wh-0000000002");
    assertEquals((await store.getHeadHook("gitlab", null))?.id, "wh-0000000004");
    // An absent scope is the unscoped queue, not "any scope".
    assertEquals((await store.getHeadHook("gitlab"))?.id, "wh-0000000004");
    assertEquals(await store.getHeadHook("gitlab", "3"), null);

    // One entry per queue: two NULL-scope rows group together rather than surfacing twice.
    const queues = await store.getDueQueues(["gitlab", "github"], T0);
    assertEquals(
      await Promise.all(queues.map(async (q) => [
        q.registrationId,
        q.scope,
        (await store.getHeadHook(q.registrationId, q.scope))?.id,
      ])).then((xs) => xs.sort()),
      [
        ["github", null, "wh-0000000006"],
        ["gitlab", "1", "wh-0000000001"],
        ["gitlab", "2", "wh-0000000002"],
        ["gitlab", null, "wh-0000000004"],
      ].sort(),
    );

    // A scope's head stepping forward moves that queue only.
    const first = await store.getHook("wh-0000000001");
    await store.saveHook({ ...first!, state: "delivered" });
    assertEquals((await store.getHeadHook("gitlab", "1"))?.id, "wh-0000000003");
    assertEquals((await store.getHeadHook("gitlab", "2"))?.id, "wh-0000000002");
  } finally {
    await handle.close();
  }
});

test("the conditional write is the claim — of two racing sweeps, exactly one wins", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    const hook = await record(store, "wh-0000000001");

    const claim = { ...hook, state: "delivering" as const, attempts: 1 };
    const winner = await store.saveHookIfState(claim, ["pending"]);
    const loser = await store.saveHookIfState(claim, ["pending"]);
    assertEquals(winner, true);
    assertEquals(loser, false);
    assertEquals((await store.getHook(hook.id))?.state, "delivering");
  } finally {
    await handle.close();
  }
});

test("a hook round-trips byte-for-byte: headers, body, every column", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    const recorded = await store.recordHook(openHook({
      id: "wh-0000000001",
      registrationId: "github",
      headers: { "x-github-event": "issue_comment", "x-github-delivery": "d-1" },
      body: '{"action":"created","zeros":"\\u0000 stays escaped"}',
    }, T0));
    const read = await store.getHook("wh-0000000001");
    assertEquals(read, recorded);
  } finally {
    await handle.close();
  }
});

test("the attempt count fences completions — a stale deliverer cannot overwrite a re-claim", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    const hook = await record(store, "wh-0000000001");

    // Deliverer A claims (attempt 1), stalls past its lease; a sweep reclaims, and deliverer
    // B re-claims (attempt 2).
    assert(await store.saveHookIfState({ ...hook, state: "delivering", attempts: 1 }, ["pending"]));
    await store.saveHook({ ...hook, state: "pending", attempts: 1 }); // the reclaim
    assert(await store.saveHookIfState({ ...hook, state: "delivering", attempts: 2 }, ["pending"]));

    // A wakes with its verdict. State alone would match — the attempt fence must not.
    const stale = await store.saveHookIfState(
      { ...hook, state: "delivered", attempts: 1 },
      ["delivering"],
      1,
    );
    assertEquals(stale, false);
    assertEquals((await store.getHook(hook.id))?.attempts, 2);

    // B's own completion, fenced with ITS attempt count, lands.
    const fresh = await store.saveHookIfState(
      { ...hook, state: "delivered", attempts: 2 },
      ["delivering"],
      2,
    );
    assertEquals(fresh, true);
  } finally {
    await handle.close();
  }
});

test("a queue's head is read off an index of its live rows, never by sorting its delivered past", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    // A busy project's queue: thousands of delivered rows, one live one at the end.
    await handle.db.execute(sql`
      insert into webhooks (id, registration_id, scope, headers, body, state, attempts,
        received_at, updated_at)
      select 'wh-old-' || n, 'gitlab', '7', '{}'::jsonb, '{}', 'delivered', 1, ${T0}, ${T0}
      from generate_series(1, 5000) n`);
    const live = await record(store, "wh-0000000001", "gitlab", "7");
    await handle.db.execute(sql`analyze webhooks`);
    assertEquals((await store.getHeadHook("gitlab", "7"))?.id, live.id);

    const explained = await handle.db.execute(
      sql`explain ${headHookQuery(handle.db, "gitlab", "7")}`,
    );
    // oxlint-disable-next-line no-explicit-any
    const rows: any[] = Array.isArray(explained) ? explained : (explained as any).rows;
    const plan = rows.map((r) => Object.values(r)[0]).join("\n");
    assert(plan.includes("webhooks_live_by_queue"), plan);
    assert(!/\bSort\b/.test(plan), plan);
  } finally {
    await handle.close();
  }
});

test("only due queues are read: a retry clock or a live lease holds its queue out of the sweep", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    const later = "2026-01-01T00:05:00.000Z";
    const earlier = "2025-12-31T23:55:00.000Z";
    const clocked = await record(store, "wh-0000000001", "gitlab", "1");
    await store.saveHook({ ...clocked, attempts: 1, nextAttemptAt: later });
    await record(store, "wh-0000000002", "gitlab", "1"); // behind the clock: not a head
    const leased = await record(store, "wh-0000000003", "gitlab", "2");
    await store.saveHook({ ...leased, state: "delivering", attempts: 1, leaseExpiresAt: later });
    const lapsed = await record(store, "wh-0000000004", "gitlab", "3");
    await store.saveHook({ ...lapsed, state: "delivering", attempts: 1, leaseExpiresAt: earlier });
    const ripe = await record(store, "wh-0000000005", "gitlab", "4");
    await store.saveHook({ ...ripe, attempts: 1, nextAttemptAt: earlier });
    await record(store, "wh-0000000006", "gitlab", null);

    const queues = await store.getDueQueues(["gitlab"], T0);
    assertEquals(queues.map((q) => q.scope), ["3", "4", null]);
    // Once the clock and the lease run out, their queues are back.
    assertEquals(
      (await store.getDueQueues(["gitlab"], later)).map((q) => q.scope),
      ["1", "2", "3", "4", null],
    );
  } finally {
    await handle.close();
  }
});

test("reading which queues are due costs a few probes per queue, never a walk over the backlog", async () => {
  const handle = await makeTestDb();
  try {
    // A consumer outage: 100 projects, 200 live hooks waiting in each — 20 000 rows.
    await handle.db.execute(sql`
      insert into webhooks (id, registration_id, scope, headers, body, state, attempts,
        received_at, updated_at)
      select 'wh-' || q || '-' || n, 'gitlab', q::text, '{}'::jsonb, '{}', 'pending', 0, ${T0},
        ${T0}
      from generate_series(1, 100) q, generate_series(1, 200) n`);
    await handle.db.execute(sql`analyze webhooks`);
    const store = drizzleHookStore(handle.db);
    assertEquals((await store.getDueQueues(["gitlab", "github"], T0)).length, 100);

    const explained = rowsOf<Record<string, unknown>>(
      await handle.db.execute(
        sql`explain (analyze, format json) ${dueQueuesQuery(["gitlab", "github"], T0)}`,
      ),
    );
    // Every row any node read off the table or its indexes, over all of its loops.
    let read = 0;
    // oxlint-disable-next-line no-explicit-any
    const walk = (node: any) => {
      if (node["Relation Name"] === "webhooks" || node["Index Name"] !== undefined) {
        read += node["Actual Rows"] * node["Actual Loops"];
      }
      for (const child of node.Plans ?? []) walk(child);
    };
    // oxlint-disable-next-line no-explicit-any
    const plan = Object.values(explained[0])[0] as any;
    walk((typeof plan === "string" ? JSON.parse(plan) : plan)[0].Plan);
    assert(read > 0 && read < 1_000, `read ${read} rows for 100 queues`);
  } finally {
    await handle.close();
  }
});

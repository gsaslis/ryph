// The delivering replica's lock connection dies mid-run, against a REAL Postgres — wired as the
// forge and automations wire it (`held || tryLock` on a held session, `tick` on a timer and on
// arrivals), on a self-healing session of its own. The hooks stay on PGlite; only the lock needs the wire, since only a real connection
// can die. Skipped unless RYPH_TEST_POSTGRES_URL names a server this test may take advisory locks
// and terminate its own backends on.
//
// Before the fix, the next leadership check hung for good on the dead connection, the tick
// coalesced behind it, and every hook ingested afterwards waited forever — accepted at the door,
// never delivered, nothing logged.

import { expect, test } from "bun:test";
import postgres from "postgres";
import { openDbCluster } from "@ryph/db";
import { setup, type WebhooksSetup } from "../src/setup.ts";
import { drizzleHookStore } from "../src/adapters/store/drizzle.ts";
import { coalescingTick } from "../src/helpers/tick.ts";
import { LEADER_CHECK_TIMEOUT_MS } from "../src/core/sweeper.ts";
import { makeTestDb } from "./db.ts";

const url = process.env.RYPH_TEST_POSTGRES_URL;
const KEY = 3_100_101;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.skipIf(!url)("a hook ingested after the lock connection dies is still delivered", async () => {
  const handle = await makeTestDb();
  const cluster = await openDbCluster(url!);
  const admin = postgres(url!, { max: 1, onnotice: () => {} });
  const lock = await cluster.lockSession({ selfHealing: true });
  const delivered: string[] = [];
  let kick: () => void = () => {};
  const webhooks: WebhooksSetup = setup({
    store: drizzleHookStore(handle.db),
    diag: { debug: () => {}, warn: () => {} },
    now: () => new Date(),
    onIngested: () => kick(),
    leader: async () => await lock.held(KEY) || await lock.tryLock(KEY),
  });
  kick = coalescingTick(() => webhooks.tick(), () => {});
  const timer = setInterval(kick, 200);
  try {
    webhooks.register({
      id: "github",
      verification: { kind: "hmac-sha256", header: "x", prefix: "", secret: "s" },
      consumer: (hook) => {
        delivered.push(hook.body);
        return Promise.resolve({ kind: "ok" });
      },
    });
    await webhooks.enqueue("github", "before");
    for (let i = 0; i < 50 && delivered.length < 1; i++) await sleep(50);
    expect(delivered).toEqual(["before"]);

    // A restart, a failover or an operator: the lock session's backend is gone.
    await admin`SELECT pg_terminate_backend(pid) FROM pg_locks
      WHERE locktype = 'advisory' AND objid = ${KEY} AND pid <> pg_backend_pid()`;
    await sleep(500); // a scan or two run on the dead connection
    await webhooks.enqueue("github", "after");

    const bound = performance.now() + LEADER_CHECK_TIMEOUT_MS + 3_000;
    while (delivered.length < 2 && performance.now() < bound) await sleep(50);
    expect(delivered).toEqual(["before", "after"]);
    expect(webhooks.stalled()).toBeNull();
  } finally {
    clearInterval(timer);
    await webhooks.sweep();
    await lock.close();
    await admin.end();
    await cluster.close();
    await handle.close();
  }
});

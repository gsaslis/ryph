// Mailboxes drain apart: whatever one mailbox's consumer does, another's hooks are delivered as
// they arrive — wired as a host wires the mailroom (`tick` on a timer and on `onIngested`, through
// `coalescingTick`), with arrivals through the real `enqueue` door while passes run. And a long
// pass re-reads the line by keys, never by rows.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { setup, type WebhooksSetup, type WebhooksSetupDeps } from "../src/setup.ts";
import { drizzleHookStore } from "../src/adapters/store/drizzle.ts";
import { openHook } from "../src/core/hook_lifecycle.ts";
import { coalescingTick } from "../src/helpers/tick.ts";
import type { HookStore } from "../src/ports/hook_store.ts";
import { LEADER_FRESH_MS, REFUSAL_REST_MS } from "../src/core/sweeper.ts";
import { MAX_ABANDONED_TICKS, TICK_STALL_MS } from "../src/setup.ts";
import { livenessRoutes } from "../src/http/liveness.ts";
import { makeRouter } from "@ryph/shared/http";
import { makeTestDb } from "./db.ts";

const silent = { debug: () => {}, warn: () => {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const verification = { kind: "hmac-sha256" as const, header: "x", prefix: "", secret: "s" };

/** The mailroom as a host mounts it: `tick` on a timer, and kicked by `onIngested`. */
function hosted(deps: Omit<WebhooksSetupDeps, "onIngested">, periodMs = 200) {
  let kick: () => void = () => {};
  const webhooks: WebhooksSetup = setup({ ...deps, onIngested: () => kick() });
  kick = coalescingTick(() => webhooks.tick(), (err) => {
    throw err;
  });
  const timer = setInterval(kick, periodMs);
  return { webhooks, kick, stop: () => clearInterval(timer) };
}

test("a GitHub hook is delivered as it arrives while GitLab's slow queues hold a long pass", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    const { webhooks, kick, stop } = hosted({ store, diag: silent, now: () => new Date() });
    // Seventy projects whose every delivery runs to a timeout: GitLab's pass lasts seconds.
    let gitlabPassOver = false;
    webhooks.register({
      id: "gitlab",
      verification,
      consumer: async () => {
        await sleep(300);
        return { kind: "failed", message: "timeout", terminal: false };
      },
    });
    const arrived = new Map<string, number>();
    const waited: number[] = [];
    webhooks.register({
      id: "github",
      verification,
      consumer: (hook) => {
        waited.push(Date.now() - arrived.get(hook.body)!);
        return Promise.resolve({ kind: "ok" });
      },
    });
    for (let p = 0; p < 70; p++) {
      await store.recordHook(openHook(
        { id: `wh-gl-${p}`, registrationId: "gitlab", scope: String(p), headers: {}, body: "x" },
        new Date().toISOString(),
      ));
    }
    const started = Date.now();
    kick();
    // GitHub rings every 10 ms for as long as GitLab's pass runs.
    let n = 0;
    while (!gitlabPassOver) {
      const body = String(n++);
      arrived.set(body, Date.now());
      await webhooks.enqueue("github", body);
      await sleep(10);
      const gl = await store.getDueQueues(["gitlab"], new Date().toISOString());
      gitlabPassOver = gl.length === 0;
    }
    const passMs = Date.now() - started;
    stop();
    await webhooks.sweep();
    assert(passMs > 2_000, `GitLab's pass lasted ${passMs} ms — too short to prove anything`);
    assertEquals(waited.length, n, "every GitHub hook was delivered");
    // Each one within a scan of its arrival — never behind GitLab's pass.
    const worst = Math.max(...waited);
    assert(worst < 300, `a GitHub hook waited ${worst} ms while GitLab's pass ran ${passMs} ms`);
  } finally {
    await handle.close();
  }
});

test("re-reading the line costs keys, not rows: a refused head's row is read once a rest, however often the mailbox is scanned", async () => {
  const handle = await makeTestDb();
  try {
    const base = drizzleHookStore(handle.db);
    // Every Hook row the store hands the sweep, counted.
    let fullRows = 0;
    const count = (v: unknown) => {
      for (const x of Array.isArray(v) ? v : [v]) {
        if (x !== null && typeof x === "object" && "body" in x) fullRows++;
      }
      return v;
    };
    const store = new Proxy(base, {
      get(target, prop: keyof HookStore) {
        const f = target[prop];
        if (typeof f !== "function" || prop === "recordHook" || prop === "getHook") return f;
        return async (...args: unknown[]) =>
          count(await (f as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      },
    });
    const { webhooks, kick, stop } = hosted({ store, diag: silent, now: () => new Date() }, 5);
    // 200 projects over the budget, asked at every scan; one slow project keeps the pass going.
    webhooks.register({
      id: "gitlab",
      verification,
      admitDelivery: (hook) =>
        hook.scope === "slow" ? { kind: "go" } : { kind: "wait", reason: "budget" },
      consumer: async () => {
        await sleep(20);
        return { kind: "ok" };
      },
    });
    webhooks.register({
      id: "github",
      verification,
      consumer: () => Promise.resolve({ kind: "ok" }),
    });
    const Q = 200;
    for (let p = 0; p < Q; p++) {
      await base.recordHook(openHook(
        { id: `wh-gl-${p}`, registrationId: "gitlab", scope: String(p), headers: {}, body: "x" },
        new Date().toISOString(),
      ));
    }
    const SLOW = 100;
    for (let i = 0; i < SLOW; i++) {
      await base.recordHook(openHook(
        { id: `wh-sl-${i}`, registrationId: "gitlab", scope: "slow", headers: {}, body: "x" },
        new Date().toISOString(),
      ));
    }
    const started = Date.now();
    kick();
    // Arrivals beside it, in another mailbox, each kicking a scan — and the timer's every 5 ms.
    const GH = 100;
    for (let i = 0; i < GH; i++) {
      await webhooks.enqueue("github", String(i));
      await sleep(5);
    }
    stop();
    await webhooks.sweep();
    const elapsed = Date.now() - started;
    // Each refused head's row is read at most once a rest, however many scans ran (hundreds
    // here); every other row read is a delivery's.
    const rests = Math.ceil(elapsed / REFUSAL_REST_MS) + 1;
    const bound = rests * Q + SLOW + GH;
    assert(fullRows <= bound, `fetched ${fullRows} full rows in ${elapsed} ms (bound ${bound})`);
  } finally {
    await handle.close();
  }
});

test("only the leader delivers: another replica's scans read nothing and its arrivals wait for the leader", async () => {
  const handle = await makeTestDb();
  try {
    const base = drizzleHookStore(handle.db);
    const delivered: string[] = [];
    // Two replicas over one table; the lock is the leader's.
    const replica = (name: string, leads: () => boolean) => {
      let scans = 0;
      let kicks = 0;
      const store: HookStore = {
        ...base,
        getDueQueues(ids, dueAt) {
          scans++;
          return base.getDueQueues(ids, dueAt);
        },
      };
      const webhooks = setup({
        store,
        diag: silent,
        now: () => new Date(),
        onIngested: () => kicks++,
        leader: () => Promise.resolve(leads()),
      });
      webhooks.register({
        id: "gitlab",
        verification,
        consumer: (hook) => {
          delivered.push(`${name}:${hook.body}`);
          return Promise.resolve({ kind: "ok" });
        },
      });
      return { webhooks, scans: () => scans, kicks: () => kicks };
    };
    const a = replica("a", () => true);
    const b = replica("b", () => false);

    // B takes a delivery in at its door: its kick scans, finds it does not lead, reads nothing.
    await b.webhooks.enqueue("gitlab", "1");
    assertEquals(b.kicks(), 1);
    await b.webhooks.sweep();
    assertEquals(b.scans(), 0);
    assertEquals(delivered, []);
    // The leader's next scan delivers it.
    await a.webhooks.sweep();
    assertEquals(delivered, ["a:1"]);
  } finally {
    await handle.close();
  }
});

test("a replica that loses the lock stops before its next delivery", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    let leads = true;
    const delivered: string[] = [];
    const webhooks: WebhooksSetup = setup({
      store,
      diag: silent,
      now: () => new Date(),
      leader: () => Promise.resolve(leads),
    });
    webhooks.register({
      id: "gitlab",
      verification,
      consumer: async (hook) => {
        delivered.push(hook.body);
        if (hook.body === "1") {
          // Its database session dropped; the timer's next scan finds the lock gone.
          leads = false;
          await webhooks.tick();
        }
        return { kind: "ok" };
      },
    });
    for (let i = 1; i <= 5; i++) {
      await store.recordHook(openHook(
        { id: `wh-${i}`, registrationId: "gitlab", scope: "7", headers: {}, body: String(i) },
        new Date().toISOString(),
      ));
    }
    leads = true;
    await webhooks.sweep();
    assertEquals(delivered, ["1"], "the delivery in flight finished, and no other began");
    assertEquals((await store.getHook("wh-2"))?.state, "pending");
  } finally {
    await handle.close();
  }
});

test("a demoted replica starts no delivery once a leadership answer is LEADER_FRESH_MS old", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    let leads = true;
    let demotedAt = Infinity;
    const started: number[] = [];
    const webhooks: WebhooksSetup = setup({
      store,
      diag: silent,
      now: () => new Date(),
      leader: () => Promise.resolve(leads),
    });
    webhooks.register({
      id: "gitlab",
      verification,
      consumer: async () => {
        started.push(performance.now());
        if (started.length === 3) {
          // Its lock is gone — and no scan comes to say so: the pass must find out itself.
          leads = false;
          demotedAt = performance.now();
        }
        await sleep(20);
        return { kind: "ok" };
      },
    });
    for (let i = 1; i <= 100; i++) {
      await store.recordHook(openHook(
        { id: `wh-${i}`, registrationId: "gitlab", scope: "7", headers: {}, body: String(i) },
        new Date().toISOString(),
      ));
    }
    await webhooks.sweep();
    const late = started.filter((at) => at > demotedAt + LEADER_FRESH_MS + 50);
    assertEquals(late.length, 0, `${late.length} deliveries started after the demotion's bound`);
    assert(started.length < 100, "the demoted replica drained the whole queue");
  } finally {
    await handle.close();
  }
});

test("a leader check that never answers does not stop the mailroom", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    // The lock session's connection dies: a check asked then never settles. The session heals
    // (a fresh connection) and later checks answer again.
    let dropped = false;
    let hung = 0;
    const warned: string[] = [];
    const delivered: string[] = [];
    const { webhooks, stop } = hosted({
      store,
      diag: { debug: () => {}, warn: (event) => warned.push(event) },
      now: () => new Date(),
      leader: () => {
        if (dropped && hung++ === 0) return new Promise<boolean>(() => {});
        return Promise.resolve(true);
      },
      leaderTimeoutMs: 200,
    }, 100);
    try {
      webhooks.register({
        id: "github",
        verification,
        consumer: (hook) => {
          delivered.push(hook.body);
          return Promise.resolve({ kind: "ok" });
        },
      });
      await webhooks.enqueue("github", "before");
      for (let i = 0; i < 50 && delivered.length < 1; i++) await sleep(20);
      assertEquals(delivered, ["before"]);

      dropped = true;
      await sleep(300); // the next scan's check hangs
      await webhooks.enqueue("github", "after");
      for (let i = 0; i < 100 && delivered.length < 2; i++) await sleep(20);
      assertEquals(delivered, ["before", "after"]);
      assert(warned.includes("webhooks.leader_check_timed_out"), warned.join(", "));
    } finally {
      stop();
    }
  } finally {
    await handle.close();
  }
});

test("a database that stops answering never fails liveness: every tick ends on its own", async () => {
  // A partition drops packets and closes nothing, so no store call errors by itself. Ticks must
  // still end — a probe that restarts every replica into the outage takes the forge's git
  // transport, which needs no database, down with it.
  const handle = await makeTestDb();
  try {
    const base = drizzleHookStore(handle.db);
    let dark = false;
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const hang = <T>(answer: () => Promise<T>) => dark ? new Promise<T>(() => {}) : answer();
    const store: HookStore = {
      ...base,
      getDueQueues: (ids, dueAt) => hang(() => base.getDueQueues(ids, dueAt)),
      deleteTerminalHooks: (id, before, limit) =>
        hang(() => base.deleteTerminalHooks(id, before, limit)),
    };
    const warned: string[] = [];
    const webhooks = setup({
      store,
      diag: { debug: () => {}, warn: (event) => warned.push(event) },
      now: () => new Date(now),
      storeDeadlineMs: 50,
    });
    for (const id of ["github", "gitlab", "radicle"]) {
      webhooks.register({
        id,
        verification,
        retainTerminalMs: 1_000,
        consumer: () => Promise.resolve({ kind: "ok" }),
      });
    }
    await webhooks.tick();

    dark = true;
    const ticked = webhooks.tick().then(() => "ended");
    now += TICK_STALL_MS + 1;
    assertEquals(await Promise.race([ticked, sleep(2_000).then(() => "hung")]), "ended");
    assertEquals(webhooks.stalled(), null);
    const probe = makeRouter(livenessRoutes(webhooks, silent));
    assertEquals((await probe(new Request("http://forge/healthz"))).status, 200);
    assert(warned.includes("webhooks.sweep_failed"), warned.join(", "));
    // One prune that timed out ends the tick's pruning: the rest is the next tick's, not a wait
    // per mailbox.
    assertEquals(warned.filter((event) => event === "webhooks.prune_failed").length, 1);
  } finally {
    await handle.close();
  }
});

test("a tick still running past TICK_STALL_MS is abandoned, and the next one runs", async () => {
  const handle = await makeTestDb();
  try {
    const base = drizzleHookStore(handle.db);
    // Slow, never failing: each call answers just inside its deadline, so only the tick's own
    // bound can end the tick.
    let slow = false;
    const store: HookStore = {
      ...base,
      async getDueQueues(ids, dueAt) {
        if (slow) await sleep(80);
        return await base.getDueQueues(ids, dueAt);
      },
    };
    const warned: string[] = [];
    const delivered: string[] = [];
    const webhooks = setup({
      store,
      diag: { debug: () => {}, warn: (event) => warned.push(event) },
      now: () => new Date(),
      storeDeadlineMs: 100,
      tickStallMs: 30,
    });
    webhooks.register({
      id: "github",
      verification,
      consumer: (hook) => {
        delivered.push(hook.body);
        return Promise.resolve({ kind: "ok" });
      },
    });
    const probe = makeRouter(livenessRoutes(webhooks, silent));
    const healthz = async () => (await probe(new Request("http://forge/healthz"))).status;

    slow = true;
    for (let i = 1; i < MAX_ABANDONED_TICKS; i++) {
      await webhooks.tick(); // ends at the bound, not when the scan does
      assertEquals(webhooks.stalled(), null, "abandoned and moved on: nothing to restart");
      assertEquals(await healthz(), 200);
    }
    assertEquals(warned.filter((event) => event === "webhooks.tick_abandoned").length, 2);
    // Every tick in a row abandoned: the in-process remedy is not working, and a restart is left.
    await webhooks.tick();
    assert(webhooks.stalled() !== null);
    assertEquals(await healthz(), 503);

    // A tick that ends on its own clears it, and the hook the slow ones never reached arrives.
    slow = false;
    await webhooks.enqueue("github", "late");
    await webhooks.sweep();
    assertEquals(webhooks.stalled(), null);
    assertEquals(delivered, ["late"]);
  } finally {
    await handle.close();
  }
});

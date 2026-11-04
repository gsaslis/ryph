// The drain against a real store and a fake clock: FIFO order, head-of-line blocking (within
// one (registration, scope) queue and no further), step-over after exhaustion, and reclaiming a
// dead deliverer's lease.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { setup, type WebhooksSetup } from "../src/setup.ts";
import { drizzleHookStore } from "../src/adapters/store/drizzle.ts";
import { openHook } from "../src/core/hook_lifecycle.ts";
import {
  drains,
  MAX_DELIVERIES_PER_PASS,
  REFUSAL_REST_MS,
  SWEEP_TURN,
  type SweeperDeps,
} from "../src/core/sweeper.ts";
import {
  type ConsumeOutcome,
  DEFAULT_DELIVERY_POLICY,
  type Hook,
  type WebhookRegistration,
} from "../src/core/types.ts";
import type { HookStore } from "../src/ports/hook_store.ts";
import type { WebhooksDbHandle } from "../src/adapters/store/db/db.ts";
import { makeTestDb } from "./db.ts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const silent = { debug: () => {}, warn: () => {} };

/** One scan over `registrations`, then every pass it started, to the end. */
async function sweepOnce(
  deps: SweeperDeps,
  registrations: ReadonlyMap<string, WebhookRegistration>,
): Promise<void> {
  const d = drains(deps, registrations);
  await d.scan();
  await d.settled();
}

function fakeClock(startMs = T0) {
  let now = startMs;
  return { now: () => new Date(now), advance: (ms: number) => now += ms };
}

interface SweepWorld {
  handle: WebhooksDbHandle;
  store: HookStore;
  webhooks: WebhooksSetup;
  clock: ReturnType<typeof fakeClock>;
  /** Bodies handed to the consumer, in delivery order. */
  seen: string[];
  /** The consumer's next answers; empty means ok. */
  verdicts: ConsumeOutcome[];
  /** Bodies the consumer fails retryably for as long as they are in here — for tests whose
   * queues drain concurrently, where `verdicts`' call order would be a race. */
  failing: Set<string>;
  ingest: (id: string, body: string, scope?: string | null) => Promise<Hook>;
}

async function makeWorld(): Promise<SweepWorld> {
  const handle = await makeTestDb();
  const store = drizzleHookStore(handle.db);
  const clock = fakeClock();
  const seen: string[] = [];
  const verdicts: ConsumeOutcome[] = [];
  const failing = new Set<string>();
  const webhooks = setup({ store, diag: silent, now: clock.now });
  webhooks.register({
    id: "github",
    verification: { kind: "hmac-sha256", header: "x", prefix: "", secret: "s" },
    policy: { leaseMs: 60_000, baseBackoffMs: 10_000, maxBackoffMs: 60_000, maxAttempts: 3 },
    consumer: (hook) => {
      seen.push(hook.body);
      if (failing.has(hook.body)) {
        return Promise.resolve({ kind: "failed", message: "503", terminal: false });
      }
      return Promise.resolve(verdicts.shift() ?? { kind: "ok" });
    },
  });
  const ingest = (id: string, body: string, scope: string | null = null) =>
    store.recordHook(
      openHook(
        { id, registrationId: "github", scope, headers: {}, body },
        clock.now().toISOString(),
      ),
    );
  return { handle, store, webhooks, clock, seen, verdicts, failing, ingest };
}

test("a backlog drains strictly oldest-first, and in a single sweep pass", async () => {
  const world = await makeWorld();
  try {
    await world.ingest("wh-0000000001", "first");
    await world.ingest("wh-0000000002", "second");
    await world.ingest("wh-0000000003", "third");

    await world.webhooks.sweep();

    assertEquals(world.seen, ["first", "second", "third"]);
    assertEquals(await world.store.getHeadHook("github"), null);
  } finally {
    await world.handle.close();
  }
});

test("a retrying head blocks everything behind it until its clock expires — FIFO's price", async () => {
  const world = await makeWorld();
  try {
    await world.ingest("wh-0000000001", "first");
    await world.ingest("wh-0000000002", "second");

    world.verdicts.push({ kind: "failed", message: "orchestrator unreachable", terminal: false });
    await world.webhooks.sweep();
    assertEquals(world.seen, ["first"]); // the failure stopped the drain; "second" never moved

    // Still inside the backoff window: the whole queue waits.
    await world.webhooks.sweep();
    assertEquals(world.seen, ["first"]);

    // The clock expires: the head retries, succeeds, and the queue flows again — in order.
    world.clock.advance(10_000);
    await world.webhooks.sweep();
    assertEquals(world.seen, ["first", "first", "second"]);
  } finally {
    await world.handle.close();
  }
});

test("a retrying head holds only its own scope — another scope of the same mailbox drains past it", async () => {
  const world = await makeWorld();
  try {
    // Two GitLab projects behind one mailbox, interleaved as they arrived.
    await world.ingest("wh-0000000001", "p1-first", "1");
    await world.ingest("wh-0000000002", "p2-first", "2");
    await world.ingest("wh-0000000003", "p1-second", "1");
    await world.ingest("wh-0000000004", "p2-second", "2");
    const ofScope = (prefix: string) => world.seen.filter((body) => body.startsWith(prefix));

    world.failing.add("p1-first");
    await world.webhooks.sweep();
    // Project 1 is stuck at its head; project 2 drained in full, in its own order.
    assertEquals(ofScope("p1-"), ["p1-first"]);
    assertEquals(ofScope("p2-"), ["p2-first", "p2-second"]);
    assertEquals((await world.store.getHeadHook("github", "1"))?.id, "wh-0000000001");
    assertEquals(await world.store.getHeadHook("github", "2"), null);

    // Inside the backoff window project 1 still waits — FIFO within the scope holds.
    await world.webhooks.sweep();
    assertEquals(ofScope("p1-"), ["p1-first"]);

    // The clock expires: the head retries, succeeds, and project 1 flows again — in order.
    world.failing.delete("p1-first");
    world.clock.advance(10_000);
    await world.webhooks.sweep();
    assertEquals(ofScope("p1-"), ["p1-first", "p1-first", "p1-second"]);
    assertEquals(ofScope("p2-"), ["p2-first", "p2-second"]);
  } finally {
    await world.handle.close();
  }
});

test("unscoped hooks are one FIFO queue per mailbox, apart from its scoped ones", async () => {
  const world = await makeWorld();
  try {
    await world.ingest("wh-0000000001", "plain-first");
    await world.ingest("wh-0000000002", "scoped", "7");
    await world.ingest("wh-0000000003", "plain-second");

    world.failing.add("plain-first");
    await world.webhooks.sweep();
    // Every null-scope hook queues behind the retrying one, as a mailbox without scopes always
    // did; the scoped hook is another queue and is not held.
    assertEquals(world.seen.filter((body) => body.startsWith("plain-")), ["plain-first"]);
    assertEquals(world.seen.filter((body) => body === "scoped"), ["scoped"]);
    assertEquals((await world.store.getHeadHook("github", null))?.id, "wh-0000000001");

    world.failing.delete("plain-first");
    world.clock.advance(10_000);
    await world.webhooks.sweep();
    assertEquals(
      world.seen.filter((body) => body.startsWith("plain-")),
      ["plain-first", "plain-first", "plain-second"],
    );
  } finally {
    await world.handle.close();
  }
});

test("a terminal failure exhausts the head and the same sweep steps over it", async () => {
  const world = await makeWorld();
  try {
    const poisoned = await world.ingest("wh-0000000001", "cursed");
    await world.ingest("wh-0000000002", "fine");

    world.verdicts.push({ kind: "failed", message: "does not parse", terminal: true });
    await world.webhooks.sweep();

    assertEquals(world.seen, ["cursed", "fine"]);
    assertEquals((await world.store.getHook(poisoned.id))?.state, "exhausted");
    assertEquals((await world.store.getHook("wh-0000000002"))?.state, "delivered");
  } finally {
    await world.handle.close();
  }
});

test("the retry budget spends down to exhausted, then the queue moves on without a human", async () => {
  const world = await makeWorld();
  try {
    await world.ingest("wh-0000000001", "flaky");
    await world.ingest("wh-0000000002", "fine");

    // maxAttempts is 3; fail them all, advancing past each backoff (10s, 20s, 40s > cap? no, cap 60s).
    for (let attempt = 0; attempt < 3; attempt++) {
      world.verdicts.push({ kind: "failed", message: "503", terminal: false });
      await world.webhooks.sweep();
      world.clock.advance(60_000);
    }
    // Attempt 3 exhausted the hook mid-sweep and the drain continued to "fine" already.
    assertEquals(world.seen, ["flaky", "flaky", "flaky", "fine"]);
    assertEquals((await world.store.getHook("wh-0000000001"))?.state, "exhausted");
  } finally {
    await world.handle.close();
  }
});

test("the sweep reclaims an expired lease — a dead deliverer never strands the queue", async () => {
  const world = await makeWorld();
  try {
    const hook = await world.ingest("wh-0000000001", "orphaned");
    // A deliverer took the lease and died: delivering, lease already expired.
    await world.store.saveHook({
      ...hook,
      state: "delivering",
      attempts: 1,
      leaseExpiresAt: new Date(T0 - 1).toISOString(),
    });

    await world.webhooks.sweep();

    assertEquals(world.seen, ["orphaned"]);
    assertEquals((await world.store.getHook(hook.id))?.state, "delivered");
  } finally {
    await world.handle.close();
  }
});

test("a consumer that throws is a retryable failure, not a crash and not exhaustion", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    const clock = fakeClock();
    const webhooks = setup({ store, diag: silent, now: clock.now });
    webhooks.register({
      id: "github",
      verification: { kind: "hmac-sha256", header: "x", prefix: "", secret: "s" },
      consumer: () => Promise.reject(new Error("boom")),
    });
    const hook = await store.recordHook(
      openHook(
        { id: "wh-0000000001", registrationId: "github", headers: {}, body: "{}" },
        clock.now().toISOString(),
      ),
    );

    await webhooks.sweep();

    const after = await store.getHook(hook.id);
    assert(after !== null);
    assertEquals(after.state, "pending");
    assertEquals(after.attempts, 1);
    assert(after.lastError?.includes("boom"));
    assert(after.nextAttemptAt !== null);
  } finally {
    await handle.close();
  }
});

test("an unbound registration's hooks wait instead of being dropped", async () => {
  const world = await makeWorld();
  try {
    await world.store.recordHook(
      openHook(
        { id: "wh-0000000009", registrationId: "not-bound-yet", headers: {}, body: "later" },
        world.clock.now().toISOString(),
      ),
    );
    await world.webhooks.sweep();
    assertEquals(world.seen, []);
    assertEquals((await world.store.getHook("wh-0000000009"))?.state, "pending");
  } finally {
    await world.handle.close();
  }
});

test("a lost reclaim never undoes another replica's progress — no resurrection, no duplicate", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    const clock = fakeClock();
    const seen: string[] = [];
    const webhooks = setup({ store, diag: silent, now: clock.now });
    webhooks.register({
      id: "github",
      verification: { kind: "hmac-sha256", header: "x", prefix: "", secret: "s" },
      consumer: (hook) => {
        seen.push(hook.body);
        return Promise.resolve({ kind: "ok" });
      },
    });
    const hook = await store.recordHook(
      openHook(
        { id: "wh-0000000001", registrationId: "github", headers: {}, body: "contested" },
        clock.now().toISOString(),
      ),
    );
    // Replica A took the lease (attempt 1) and stalled past it.
    await store.saveHook({
      ...hook,
      state: "delivering",
      attempts: 1,
      leaseExpiresAt: new Date(T0 - 1).toISOString(),
    });

    // This sweep reads that stale head — and between its read and its reclaim write, replica B
    // already reclaimed, re-claimed (attempt 2), and DELIVERED the hook.
    const racingStore: HookStore = {
      ...store,
      async getHeadHook(registrationId, scope) {
        const head = await store.getHeadHook(registrationId, scope);
        if (head !== null) {
          await store.saveHook({ ...head, state: "delivered", attempts: 2, leaseExpiresAt: null });
        }
        return head;
      },
    };
    await sweepOnce(
      { store: racingStore, diag: silent, now: clock.now },
      new Map([["github", {
        id: "github",
        verification: { kind: "hmac-sha256", header: "x", prefix: "", secret: "s" },
        maxBodyBytes: 1024,
        policy: DEFAULT_DELIVERY_POLICY,
        consumer: (h) => {
          seen.push(h.body);
          return Promise.resolve({ kind: "ok" as const });
        },
      }]]),
    );

    // The delivered row survived untouched, and nothing was delivered a second time.
    assertEquals((await store.getHook(hook.id))?.state, "delivered");
    assertEquals((await store.getHook(hook.id))?.attempts, 2);
    assertEquals(seen, []);
  } finally {
    await handle.close();
  }
});

test("a stale claim cannot land on a hook that already cycled — the clock survives", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    const clock = fakeClock();
    const seen: string[] = [];
    const hook = await store.recordHook(
      openHook(
        { id: "wh-0000000002", registrationId: "github", headers: {}, body: "cycled" },
        clock.now().toISOString(),
      ),
    );
    const backoffUntil = new Date(T0 + 60_000).toISOString();

    // Between this sweep's read of the head and its claim write, another replica claims the same
    // hook, fails it, and hands it back — so the row is `pending` again, at a higher attempt.
    const racingStore: HookStore = {
      ...store,
      async getHeadHook(registrationId, scope) {
        const head = await store.getHeadHook(registrationId, scope);
        if (head !== null && head.attempts === 0) {
          await store.saveHook({
            ...head,
            state: "pending",
            attempts: 1,
            nextAttemptAt: backoffUntil,
            leaseExpiresAt: null,
          });
        }
        return head;
      },
    };
    await sweepOnce(
      { store: racingStore, diag: silent, now: clock.now },
      new Map([["github", {
        id: "github",
        verification: { kind: "hmac-sha256", header: "x", prefix: "", secret: "s" },
        maxBodyBytes: 1024,
        policy: DEFAULT_DELIVERY_POLICY,
        consumer: (h) => {
          seen.push(h.body);
          return Promise.resolve({ kind: "ok" as const });
        },
      }]]),
    );

    // The state alone would have matched. The attempt count is what refuses the stale claim, so
    // the other replica's backoff clock is still standing and nothing was delivered early.
    const row = await store.getHook(hook.id);
    assertEquals(row?.state, "pending");
    assertEquals(row?.attempts, 1);
    assertEquals(row?.nextAttemptAt, backoffUntil);
    assertEquals(seen, []);
  } finally {
    await handle.close();
  }
});

test("a consumer that hangs holds only its own mailbox — the others drain beside it", async () => {
  const world = await makeWorld();
  try {
    // A second mailbox whose consumer does not answer until released — named to sort first,
    // because a sweep takes its heads in registration order.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    world.webhooks.register({
      id: "a-slow",
      verification: { kind: "hmac-sha256", header: "x", prefix: "", secret: "s" },
      consumer: async () => {
        await held;
        return { kind: "ok" };
      },
    });
    await world.store.recordHook(
      openHook(
        { id: "wh-0000000009", registrationId: "a-slow", headers: {}, body: "slow" },
        world.clock.now().toISOString(),
      ),
    );
    await world.ingest("wh-0000000001", "first");

    const sweep = world.webhooks.sweep();
    // The github mailbox delivers while the slow one is still waiting on its consumer.
    for (let i = 0; i < 100 && world.seen.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(world.seen, ["first"]);
    release();
    await sweep;
    assertEquals(await world.store.getHeadHook("a-slow"), null);
  } finally {
    await world.handle.close();
  }
});

test("a mailbox with a retention drops its terminal rows once they are older than it; live rows and other mailboxes keep theirs", async () => {
  const world = await makeWorld();
  try {
    const day = 24 * 60 * 60_000;
    world.webhooks.register({
      id: "gitlab",
      verification: { kind: "hmac-sha256", header: "x", prefix: "", secret: "s" },
      retainTerminalMs: day,
      consumer: (hook) =>
        Promise.resolve(
          hook.body === "poison"
            ? { kind: "failed", message: "never parses", terminal: true }
            : { kind: "ok" },
        ),
    });
    const into = (id: string, registrationId: string, body: string) =>
      world.store.recordHook(
        openHook({ id, registrationId, headers: {}, body }, world.clock.now().toISOString()),
      );
    await into("wh-0000000001", "gitlab", "delivered");
    await into("wh-0000000002", "gitlab", "poison");
    await into("wh-0000000003", "github", "github's");
    await world.webhooks.sweep();
    assertEquals((await world.store.getHook("wh-0000000001"))?.state, "delivered");
    assertEquals((await world.store.getHook("wh-0000000002"))?.state, "exhausted");

    // Inside the retention: kept, for audit and `retryHook`.
    world.clock.advance(day - 1);
    await into("wh-0000000004", "gitlab", "late");
    await world.webhooks.sweep();
    assert((await world.store.getHook("wh-0000000001")) !== null);

    // Past it: the old terminal rows go; github's (no retention) stays, and so does the one
    // delivered inside the window.
    world.clock.advance(2);
    await world.webhooks.sweep();
    assertEquals(await world.store.getHook("wh-0000000001"), null);
    assertEquals(await world.store.getHook("wh-0000000002"), null);
    assertEquals((await world.store.getHook("wh-0000000003"))?.state, "delivered");
    assertEquals((await world.store.getHook("wh-0000000004"))?.state, "delivered");
  } finally {
    await world.handle.close();
  }
});

test("a refilling scope cannot hold another scope's new head for more than one turn", async () => {
  const world = await makeWorld();
  try {
    // Project 1 refills as fast as it drains — a flood its token holder keeps up — and project
    // 2's one delivery lands just after the pass began, found by the next scan.
    const order: string[] = [];
    let refills = 0;
    world.webhooks.register({
      id: "gitlab",
      verification: { kind: "hmac-sha256", header: "x", prefix: "", secret: "s" },
      consumer: async (hook) => {
        order.push(hook.body);
        if (hook.scope === "1" && refills < 300) {
          refills++;
          await world.store.recordHook(openHook({
            id: `wh-p1-${String(refills).padStart(6, "0")}`,
            registrationId: "gitlab",
            scope: "1",
            headers: {},
            body: `p1-${refills}`,
          }, world.clock.now().toISOString()));
          if (refills === 1) {
            await world.store.recordHook(openHook({
              id: "wh-p2-000001",
              registrationId: "gitlab",
              scope: "2",
              headers: {},
              body: "p2",
            }, world.clock.now().toISOString()));
            // Another replica took it, so no arrival is heard: the host's timer scans.
            await world.webhooks.tick();
          }
        }
        return { kind: "ok" };
      },
    });
    await world.store.recordHook(openHook({
      id: "wh-p1-000000",
      registrationId: "gitlab",
      scope: "1",
      headers: {},
      body: "p1-0",
    }, world.clock.now().toISOString()));

    await world.webhooks.sweep();

    // Delivered in this pass, after at most one turn of project 1.
    const at = order.indexOf("p2");
    assert(at !== -1, "project 2's delivery waited for another pass");
    assert(at <= 1 + SWEEP_TURN, `project 2's delivery came ${at + 1}th`);
  } finally {
    await world.handle.close();
  }
});

test("a pass ends however fast a queue refills — the cap is the pass's, not each queue's", async () => {
  const world = await makeWorld();
  try {
    let n = 0;
    world.webhooks.register({
      id: "gitlab",
      verification: { kind: "hmac-sha256", header: "x", prefix: "", secret: "s" },
      consumer: async (hook) => {
        n++;
        await world.store.recordHook(openHook({
          id: `wh-r-${String(n).padStart(8, "0")}`,
          registrationId: "gitlab",
          scope: hook.scope,
          headers: {},
          body: "again",
        }, world.clock.now().toISOString()));
        return { kind: "ok" };
      },
    });
    await world.store.recordHook(openHook({
      id: "wh-r-00000000",
      registrationId: "gitlab",
      scope: "1",
      headers: {},
      body: "again",
    }, world.clock.now().toISOString()));
    await world.webhooks.sweep();
    assert(n > SWEEP_TURN && n <= MAX_DELIVERIES_PER_PASS, `delivered ${n}`);
  } finally {
    await world.handle.close();
  }
});

test("a hook whose dedupe key a delivered hook of its queue carries is delivered without the consumer", async () => {
  const world = await makeWorld();
  try {
    const consumed: string[] = [];
    world.webhooks.register({
      id: "gitlab",
      verification: { kind: "hmac-sha256", header: "x", prefix: "", secret: "s" },
      dedupeKey: (hook) => hook.body.startsWith("note:") ? hook.body : null,
      consumer: (hook) => {
        consumed.push(`${hook.scope}/${hook.body}`);
        return Promise.resolve(
          hook.body === "note:2" && !consumed.includes("1/retried")
            ? { kind: "failed", message: "GitLab is down", terminal: true }
            : hook.body.startsWith("note:")
            ? { kind: "ok", dedupeKey: hook.body }
            : { kind: "ok" },
        );
      },
    });
    const into = (id: string, scope: string, body: string) =>
      world.store.recordHook(openHook(
        { id, registrationId: "gitlab", scope, headers: {}, body },
        world.clock.now().toISOString(),
      ));
    await into("wh-0000000001", "1", "note:1");
    await into("wh-0000000002", "1", "note:1"); // a replay: dropped without a read
    await into("wh-0000000003", "2", "note:1"); // another project's note 1: its own
    await into("wh-0000000004", "1", "note:2"); // exhausted, proves nothing
    await into("wh-0000000005", "1", "retried");
    await into("wh-0000000006", "1", "note:2"); // so this one is consumed
    await into("wh-0000000007", "1", "other"); // no key: always consumed
    await into("wh-0000000008", "1", "other");
    await world.webhooks.sweep();

    assertEquals(consumed.filter((c) => c.startsWith("1/")), [
      "1/note:1",
      "1/note:2",
      "1/retried",
      "1/note:2",
      "1/other",
      "1/other",
    ]);
    assertEquals(consumed.filter((c) => c.startsWith("2/")), ["2/note:1"]);
    assertEquals((await world.store.getHook("wh-0000000001"))?.dedupeKey, "note:1");
    const replay = await world.store.getHook("wh-0000000002");
    assertEquals(replay?.state, "delivered");
    assertEquals(replay?.dedupeKey, null); // a duplicate writes nothing down
    assertEquals((await world.store.getHook("wh-0000000004"))?.dedupeKey, null);
  } finally {
    await world.handle.close();
  }
});

test("only a key the consumer confirmed is written down: a body's claim never drops a later hook", async () => {
  const world = await makeWorld();
  try {
    const consumed: string[] = [];
    world.webhooks.register({
      id: "gitlab",
      verification: { kind: "hmac-sha256", header: "x", prefix: "", secret: "s" },
      dedupeKey: (hook) => hook.body.split("|")[0],
      // A forged ring names note 5 but nothing the consumer could confirm: ok, with no key.
      consumer: (hook) => {
        consumed.push(hook.body);
        return Promise.resolve(
          hook.body.endsWith("|real") ? { kind: "ok", dedupeKey: "note:5" } : { kind: "ok" },
        );
      },
    });
    const into = (id: string, body: string) =>
      world.store.recordHook(openHook(
        { id, registrationId: "gitlab", scope: "1", headers: {}, body },
        world.clock.now().toISOString(),
      ));
    await into("wh-0000000001", "note:5|forged");
    await into("wh-0000000002", "note:5|real"); // the genuine one, later: consumed
    await into("wh-0000000003", "note:5|real"); // and its resend: dropped
    await world.webhooks.sweep();

    assertEquals(consumed, ["note:5|forged", "note:5|real"]);
    assertEquals((await world.store.getHook("wh-0000000001"))?.dedupeKey, null);
    assertEquals((await world.store.getHook("wh-0000000002"))?.dedupeKey, "note:5");
    assertEquals((await world.store.getHook("wh-0000000003"))?.state, "delivered");
  } finally {
    await world.handle.close();
  }
});

test("a consumer outage over many queues costs a pass one keys read and one head row per queue", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleHookStore(handle.db);
    const clock = fakeClock();
    // 300 projects with a backlog each, and a consumer that is down.
    for (let q = 1; q <= 300; q++) {
      for (let n = 0; n < 3; n++) {
        await store.recordHook(openHook({
          id: `wh-${q}-${n}`,
          registrationId: "gitlab",
          scope: String(q),
          headers: {},
          body: `${q}/${n}`,
        }, clock.now().toISOString()));
      }
    }
    let scans = 0;
    let rows = 0;
    const counting: HookStore = {
      ...store,
      getDueQueues(registrationIds, dueAt) {
        scans++;
        return store.getDueQueues(registrationIds, dueAt);
      },
      async getHeadHook(registrationId, scope) {
        const head = await store.getHeadHook(registrationId, scope);
        if (head !== null) rows++;
        return head;
      },
    };
    let consumed = 0;
    const registrations = new Map([["gitlab", {
      id: "gitlab",
      verification: { kind: "hmac-sha256" as const, header: "x", prefix: "", secret: "s" },
      maxBodyBytes: 1024,
      policy: DEFAULT_DELIVERY_POLICY,
      consumer: () => {
        consumed++;
        return Promise.resolve({ kind: "failed" as const, message: "503", terminal: false });
      },
    }]]);
    const deps = { store: counting, diag: silent, now: clock.now };

    // Every queue's head fails once and starts its clock: one turn each, one keys read in all,
    // and each head's row read once, by its turn.
    await sweepOnce(deps, registrations);
    assertEquals(consumed, 300);
    assertEquals(scans, 1);
    assertEquals(rows, 300);

    // The clocks are running: the next pass has nothing due — one keys read, no rows.
    scans = 0;
    rows = 0;
    await sweepOnce(deps, registrations);
    assertEquals(consumed, 300);
    assertEquals(scans, 1);
    assertEquals(rows, 0);
  } finally {
    await handle.close();
  }
});

test("a hook arriving mid-pass joins its mailbox's line without a read", async () => {
  const world = await makeWorld();
  try {
    const order: string[] = [];
    let scans = 0;
    const store: HookStore = {
      ...world.store,
      getDueQueues(registrationIds, dueAt) {
        scans++;
        return world.store.getDueQueues(registrationIds, dueAt);
      },
    };
    const registrations = new Map([["gitlab", {
      id: "gitlab",
      verification: { kind: "hmac-sha256" as const, header: "x", prefix: "", secret: "s" },
      maxBodyBytes: 1024,
      policy: DEFAULT_DELIVERY_POLICY,
      consumer: async (hook: Hook) => {
        order.push(hook.body);
        if (hook.body === "p1") {
          await world.store.recordHook(openHook({
            id: "wh-p2-000001",
            registrationId: "gitlab",
            scope: "2",
            headers: {},
            body: "p2",
          }, world.clock.now().toISOString()));
          assert(d.arrived("gitlab", "2"), "the running pass takes the arrival");
        }
        return { kind: "ok" as const };
      },
    }]]);
    await world.store.recordHook(openHook({
      id: "wh-p1-000001",
      registrationId: "gitlab",
      scope: "1",
      headers: {},
      body: "p1",
    }, world.clock.now().toISOString()));
    // The consumer reaches it only once the pass runs.
    const d = drains({ store, diag: silent, now: world.clock.now }, registrations);
    // Nothing running: an arrival is the host's to kick.
    assertEquals(d.arrived("gitlab", "1"), false);
    await d.scan();
    await d.settled();
    assertEquals(order, ["p1", "p2"]);
    assertEquals(scans, 1, "the arrival joined without a read");
  } finally {
    await world.handle.close();
  }
});

/** A mailbox for the fairness tests: `slow` hooks block in the consumer until released, every
 * other body is delivered at once, and `order` records each delivery. */
function fairnessMailbox(id: string, held: Promise<void>, order: string[]) {
  return {
    id,
    verification: { kind: "hmac-sha256" as const, header: "x", prefix: "", secret: "s" },
    maxBodyBytes: 1024,
    policy: DEFAULT_DELIVERY_POLICY,
    consumer: async (hook: Hook) => {
      if (hook.body.startsWith("slow")) await held;
      order.push(`${id}/${hook.body}`);
      return { kind: "ok" as const };
    },
  };
}

test("one mailbox's stalled queues never take every drain: every other mailbox's due head is delivered beside them", async () => {
  const world = await makeWorld();
  try {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    // GitLab first in line (heads are read in registration id order), with more stalled project
    // queues than there are drains, and two mailboxes behind it.
    const registrations = new Map([
      ["gitlab", fairnessMailbox("gitlab", held, order)],
      ["radicle", fairnessMailbox("radicle", held, order)],
      ["zulip", fairnessMailbox("zulip", held, order)],
    ]);
    const into = (id: string, registrationId: string, scope: string | null, body: string) =>
      world.store.recordHook(openHook(
        { id, registrationId, scope, headers: {}, body },
        world.clock.now().toISOString(),
      ));
    for (let p = 1; p <= 12; p++) await into(`wh-gl-${p}`, "gitlab", String(p), "slow");
    await into("wh-rad-1", "radicle", null, "patch");
    await into("wh-zu-1", "zulip", null, "message");

    const sweep = sweepOnce(
      { store: world.store, diag: silent, now: world.clock.now },
      registrations,
    );
    for (let i = 0; i < 100 && order.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(order.toSorted(), ["radicle/patch", "zulip/message"]);
    release();
    await sweep;
    assertEquals(order.filter((o) => o.startsWith("gitlab/")).length, 12);
  } finally {
    await world.handle.close();
  }
});

test("a hook arriving while one mailbox's stalled queues hold its pass is delivered without waiting for them", async () => {
  const world = await makeWorld();
  try {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    const registrations = new Map([
      ["gitlab", fairnessMailbox("gitlab", held, order)],
      ["github", fairnessMailbox("github", held, order)],
    ]);
    for (let p = 1; p <= 12; p++) {
      await world.store.recordHook(openHook(
        { id: `wh-gl-${p}`, registrationId: "gitlab", scope: String(p), headers: {}, body: "slow" },
        world.clock.now().toISOString(),
      ));
    }
    const d = drains({ store: world.store, diag: silent, now: world.clock.now }, registrations);
    await d.scan();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(order, []); // every GitLab drain is stalled

    // GitHub rings now, mid-pass: its mailbox has no pass running, so the host's kick scans.
    await world.store.recordHook(openHook(
      { id: "wh-gh-1", registrationId: "github", scope: null, headers: {}, body: "push" },
      world.clock.now().toISOString(),
    ));
    assertEquals(d.arrived("github", null), false);
    await d.scan();
    for (let i = 0; i < 100 && order.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(order, ["github/push"]);
    release();
    await d.settled();
    assertEquals(order.length, 13);
  } finally {
    await world.handle.close();
  }
});

test("a head its registrant cannot afford yet waits untouched: no claim, no attempt, its queue stopped, others delivered", async () => {
  const world = await makeWorld();
  try {
    let afford = false;
    const consumed: string[] = [];
    const released: string[] = [];
    const asked: string[] = [];
    world.webhooks.register({
      id: "gitlab",
      verification: { kind: "hmac-sha256", header: "x", prefix: "", secret: "s" },
      admitDelivery: (hook) => {
        asked.push(hook.body);
        if (hook.scope === "1" && !afford) return { kind: "wait", reason: "over budget" };
        return { kind: "go", ticket: { release: () => released.push(hook.body) } };
      },
      consumer: (hook, ticket) => {
        consumed.push(hook.body);
        assert(ticket !== undefined, "the consumer is handed its ticket");
        if (hook.body === "b3") throw new Error("crash");
        return Promise.resolve(
          hook.body === "b2"
            ? { kind: "failed", message: "boom", terminal: false }
            : { kind: "ok" },
        );
      },
    });
    const into = (id: string, scope: string, body: string) =>
      world.store.recordHook(openHook(
        { id, registrationId: "gitlab", scope, headers: {}, body },
        world.clock.now().toISOString(),
      ));
    await into("wh-0000000001", "1", "a1");
    await into("wh-0000000002", "1", "a2");
    await into("wh-0000000003", "2", "b1");

    // Many passes of "not now": the head is never claimed and never spends an attempt, and
    // nothing behind it moves; the other project's queue is delivered beside it.
    for (let i = 0; i < 20; i++) {
      await world.webhooks.sweep();
      world.clock.advance(60_000);
    }
    const waiting = await world.store.getHook("wh-0000000001");
    assertEquals(waiting?.state, "pending");
    assertEquals(waiting?.attempts, 0);
    assertEquals(waiting?.nextAttemptAt, null);
    assertEquals(waiting?.lastError, null);
    assertEquals(consumed, ["b1"]);
    assertEquals(asked.filter((b) => b === "a1").length, 20, "asked again every pass");

    // Affordable now: delivered in order, on its first attempt.
    afford = true;
    await world.webhooks.sweep();
    assertEquals(consumed, ["b1", "a1", "a2"]);
    assertEquals((await world.store.getHook("wh-0000000001"))?.attempts, 1);

    // Every ticket handed out is released once, whatever the verdict — a failure, a crash.
    await into("wh-0000000004", "2", "b2");
    await world.webhooks.sweep();
    await into("wh-0000000005", "3", "b3");
    await world.webhooks.sweep();
    assertEquals(released, ["b1", "a1", "a2", "b2", "b3"]);
  } finally {
    await world.handle.close();
  }
});

test("a ticket is released when the claim is lost, and a throwing admission is a wait", async () => {
  const world = await makeWorld();
  try {
    const released: string[] = [];
    const consumed: string[] = [];
    let throwing = true;
    world.webhooks.register({
      id: "gitlab",
      verification: { kind: "hmac-sha256", header: "x", prefix: "", secret: "s" },
      admitDelivery: (hook) => {
        if (throwing) throw new Error("budget broken");
        // Another replica claims the head between this sweep's read and its claim.
        void world.store.saveHook({ ...hook, state: "delivering", attempts: hook.attempts + 1 });
        return { kind: "go", ticket: { release: () => released.push(hook.id) } };
      },
      consumer: (hook) => (consumed.push(hook.id), Promise.resolve({ kind: "ok" })),
    });
    await world.store.recordHook(openHook(
      { id: "wh-0000000001", registrationId: "gitlab", scope: "1", headers: {}, body: "x" },
      world.clock.now().toISOString(),
    ));
    await world.webhooks.sweep();
    assertEquals((await world.store.getHook("wh-0000000001"))?.attempts, 0);
    throwing = false;
    world.clock.advance(REFUSAL_REST_MS); // a refused queue rests before it is asked again
    await world.webhooks.sweep();
    assertEquals(released, ["wh-0000000001"]);
    assertEquals(consumed, [], "the claim was the other replica's");
  } finally {
    await world.handle.close();
  }
});

test("a head its registrant cannot afford spends nothing of the pass: every due queue is asked, and the other mailboxes are delivered", async () => {
  const world = await makeWorld();
  try {
    // More projects than a pass delivers, every one of them over the budget: refusals are not
    // deliveries, so none of them stands in for a queue further down the line.
    const asked = new Set<string>();
    world.webhooks.register({
      id: "gitlab",
      verification: { kind: "hmac-sha256", header: "x", prefix: "", secret: "s" },
      admitDelivery: (hook) => {
        asked.add(hook.scope!);
        return { kind: "wait", reason: "over budget" };
      },
      consumer: () => Promise.resolve({ kind: "ok" }),
    });
    const scopes = MAX_DELIVERIES_PER_PASS + 100;
    for (let i = 0; i < scopes; i++) {
      await world.store.recordHook(openHook({
        id: `wh-g${String(i).padStart(10, "0")}`,
        registrationId: "gitlab",
        scope: String(100_000 + i),
        headers: {},
        body: `g${i}`,
      }, world.clock.now().toISOString()));
    }
    // "radicle" sorts after "gitlab": its queue comes last in line.
    world.webhooks.register({
      id: "radicle",
      verification: { kind: "hmac-sha256", header: "x", prefix: "", secret: "s" },
      consumer: (hook) => (world.seen.push(hook.body), Promise.resolve({ kind: "ok" })),
    });
    await world.store.recordHook(openHook(
      { id: "wh-r0000000001", registrationId: "radicle", scope: null, headers: {}, body: "merge" },
      world.clock.now().toISOString(),
    ));

    await world.webhooks.sweep();

    assertEquals(asked.size, scopes, "every project's head was asked in the one pass");
    assertEquals(world.seen, ["merge"]);
  } finally {
    await world.handle.close();
  }
});

test("a pass that runs out picks up where it stopped: a queue past the cap is reached on the next pass", async () => {
  const world = await makeWorld();
  try {
    // Seventy projects whose queues refill as fast as they drain: their turns fill a pass on their
    // own. One more, sorting after them all, holds a single delivery.
    const busy = 70;
    const delivered: string[] = [];
    let n = 0;
    world.webhooks.register({
      id: "gitlab",
      verification: { kind: "hmac-sha256", header: "x", prefix: "", secret: "s" },
      consumer: async (hook) => {
        delivered.push(hook.body);
        if (hook.scope !== "zz") {
          await world.store.recordHook(openHook({
            id: `wh-a${String(++n).padStart(10, "0")}`,
            registrationId: "gitlab",
            scope: hook.scope,
            headers: {},
            body: "again",
          }, world.clock.now().toISOString()));
        }
        return { kind: "ok" };
      },
    });
    for (let i = 0; i < busy; i++) {
      await world.store.recordHook(openHook({
        id: `wh-b${String(i).padStart(10, "0")}`,
        registrationId: "gitlab",
        scope: `a${String(i).padStart(2, "0")}`,
        headers: {},
        body: "again",
      }, world.clock.now().toISOString()));
    }
    await world.store.recordHook(openHook(
      { id: "wh-z0000000001", registrationId: "gitlab", scope: "zz", headers: {}, body: "late" },
      world.clock.now().toISOString(),
    ));
    assert(busy * SWEEP_TURN > MAX_DELIVERIES_PER_PASS, "the busy queues fill a pass");

    await world.webhooks.sweep();
    assertEquals(delivered.includes("late"), false, "the first pass ran out before it");
    await world.webhooks.sweep();
    assert(delivered.includes("late"), "the next pass started where the first stopped");
  } finally {
    await world.handle.close();
  }
});

// A lock session whose connection dies, against a REAL Postgres: the failure only exists on the
// wire, so PGlite (one in-process session that cannot drop) cannot show it. Skipped unless
// RYPH_TEST_POSTGRES_URL names a server this test may take advisory locks and terminate its own
// backends on, e.g. `postgres://postgres@127.0.0.1:5432/postgres`.
//
// What it pins: a self-healing session (`LockSessionOptions.selfHealing`) whose connection was
// killed (a restart, a failover, `pg_terminate_backend`) or silently black-holed answers within a
// bound — `held` false, the rest rejecting — the next call works on a fresh connection, and the
// backend a partition left holding the lock is ended once the network is back. Before, every call
// on a dead session hung for good, and the driver threw an uncaught TypeError at the dead socket.
// And what only that session does: a plain one never gives its connection up, so a slow answer
// about one key costs no other key on it.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server, Socket } from "node:net";
import postgres from "postgres";
import {
  LOCK_QUERY_DEADLINE_MS,
  LOCK_SESSION_KEEPALIVE,
  type LockSession,
  openDbCluster,
  selfHealingLockSession,
} from "../src/open.ts";
import { sessionPooler } from "./session_pooler.ts";
import { startupGate } from "./startup_gate.ts";

const url = process.env.RYPH_TEST_POSTGRES_URL;
const KEY = 3_100_001;

/** Settles `p` or answers "hung" after `ms`, so a regression fails instead of stalling. */
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p.then((value) => ({ value }), (err: unknown) => ({ err: String(err) })),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms)),
  ]);

const uncaught: unknown[] = [];
const onUncaught = (err: unknown) => uncaught.push(err);
beforeAll(() => {
  process.on("uncaughtException", onUncaught);
});
afterAll(() => {
  process.off("uncaughtException", onUncaught);
});

test.skipIf(!url)(
  "a terminated lock connection answers, and the next call reconnects",
  async () => {
    const cluster = await openDbCluster(url!);
    const admin = postgres(url!, { max: 1, onnotice: () => {} });
    const session: LockSession = await cluster.lockSession({ selfHealing: true });
    try {
      expect(await session.tryLock(KEY)).toBe(true);
      // What a restart or failover does to this session's backend.
      await admin`SELECT pg_terminate_backend(pid) FROM pg_locks
      WHERE locktype = 'advisory' AND objid = ${KEY} AND pid <> pg_backend_pid()`;
      await new Promise((resolve) => setTimeout(resolve, 200));

      const bound = LOCK_QUERY_DEADLINE_MS + 2_000;
      // The lock went with the backend: not held, and answered rather than hung.
      expect(await within(session.held(KEY), bound)).toEqual({ value: false });
      // And the session is usable again — a fresh connection takes the free key.
      const retaken = await within(
        session.held(KEY).then(async (held) => held || await session.tryLock(KEY)),
        bound,
      );
      expect(retaken).toEqual({ value: true });
      expect(await within(session.held(KEY), bound)).toEqual({ value: true });
      expect(uncaught).toEqual([]);
    } finally {
      await session.close();
      await admin.end();
      await cluster.close();
    }
  },
);

test.skipIf(!url)("a black-holed lock connection answers within the deadline", async () => {
  const target = new URL(url!);
  const proxy = await blackHoleProxy(target.hostname, Number(target.port || 5432));
  const viaProxy = new URL(url!);
  viaProxy.hostname = "127.0.0.1";
  viaProxy.port = String(proxy.port);
  const cluster = await openDbCluster(viaProxy.href);
  const session = await cluster.lockSession({ selfHealing: true });
  try {
    expect(await session.tryLock(KEY + 1)).toBe(true);
    // A network partition: packets stop, nothing closes. No error ever comes on its own.
    proxy.freeze();
    const started = performance.now();
    expect(await within(session.held(KEY + 1), LOCK_QUERY_DEADLINE_MS + 2_000)).toEqual({
      value: false,
    });
    expect(performance.now() - started).toBeLessThan(LOCK_QUERY_DEADLINE_MS + 1_000);
    expect(await within(session.tryLock(KEY + 1), LOCK_QUERY_DEADLINE_MS + 2_000)).toHaveProperty(
      "err",
    );

    // The network comes back: the next call answers on a connection of its own. The partitioned
    // one was given up, which ends its backend — and with it the lock — so the key is free again.
    proxy.thaw();
    let taken = false;
    for (let i = 0; i < 20 && !taken; i++) {
      const answer = await within(session.tryLock(KEY + 1), LOCK_QUERY_DEADLINE_MS + 2_000);
      taken = typeof answer === "object" && "value" in answer && answer.value === true;
      if (!taken) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(taken).toBe(true);
    expect(uncaught).toEqual([]);
  } finally {
    await session.close();
    await cluster.close();
    proxy.close();
  }
});

/** Holds the event loop for `ms` — a big JSON parse, a GC pause — with a reply on the wire. */
const block = (ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* busy */ }
};

test.skipIf(!url)(
  "a plain session keeps every key while another key's answer is slow",
  async () => {
    // Every session but the webhook leader's: the orchestrator's reaper holding one key while a
    // per-chatroom poll asks about another on the same session. A slow answer to the second must
    // not cost the first — that work runs on without asking `held` again.
    const cluster = await openDbCluster(url!);
    const a = await cluster.lockSession();
    const b = await cluster.lockSession();
    try {
      expect(await a.tryLock(KEY + 10)).toBe(true);
      const second = a.tryLock(KEY + 11);
      block(LOCK_QUERY_DEADLINE_MS + 500);
      expect(await within(second, LOCK_QUERY_DEADLINE_MS + 2_000)).toEqual({ value: true });
      expect(await a.held(KEY + 10)).toBe(true);
      expect(await b.tryLock(KEY + 10)).toBe(false);
    } finally {
      await a.close();
      await b.close();
      await cluster.close();
    }
  },
);

test.skipIf(!url)(
  "a self-healing session takes a reply that arrived while the event loop was held",
  async () => {
    const cluster = await openDbCluster(url!);
    const a = await cluster.lockSession({ selfHealing: true });
    const b = await cluster.lockSession();
    try {
      expect(await a.tryLock(KEY + 20)).toBe(true);
      // The answer is back long before the deadline; only the loop that would read it is late.
      const asked = a.held(KEY + 20);
      block(LOCK_QUERY_DEADLINE_MS + 500);
      expect(await within(asked, LOCK_QUERY_DEADLINE_MS + 2_000)).toEqual({ value: true });
      expect(await b.tryLock(KEY + 20)).toBe(false);
    } finally {
      await a.close();
      await b.close();
      await cluster.close();
    }
  },
);

test.skipIf(!url)(
  "a lock held across a partition passes on within seconds of the network healing",
  async () => {
    // A partition carries no close across: the client gives its socket up, but the backend on
    // the far side sits idle with the lock until something tells it the peer is gone. Server TCP
    // keepalive does that in a real partition (this proxy ACKs for the client, so it cannot show
    // it); the session's own reconnect is what ends the old backend once the network is back.
    const target = new URL(url!);
    const proxy = await blackHoleProxy(target.hostname, Number(target.port || 5432), {
      sever: true,
    });
    const viaProxy = new URL(url!);
    viaProxy.hostname = "127.0.0.1";
    viaProxy.port = String(proxy.port);
    const leaderCluster = await openDbCluster(viaProxy.href);
    const otherCluster = await openDbCluster(url!);
    const a = await leaderCluster.lockSession({ selfHealing: true });
    const b = await otherCluster.lockSession({ selfHealing: true });
    const leader = async (s: LockSession) => await s.held(KEY + 30) || await s.tryLock(KEY + 30);
    try {
      expect(await leader(a)).toBe(true);
      proxy.freeze();
      expect(await within(a.held(KEY + 30), LOCK_QUERY_DEADLINE_MS + 2_000)).toEqual({
        value: false,
      });
      expect(await leader(b)).toBe(false); // the old backend still holds it
      proxy.thaw();
      // Both replicas keep asking, as their scans do; one of them must have it soon.
      const healed = performance.now();
      let holder: "a" | "b" | null = null;
      while (holder === null && performance.now() - healed < 15_000) {
        if (await leader(a).catch(() => false)) holder = "a";
        else if (await leader(b).catch(() => false)) holder = "b";
        else await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(holder).not.toBeNull();
      // And never both.
      const other = holder === "a" ? b : a;
      expect(await other.tryLock(KEY + 30).catch(() => false)).toBe(false);
      expect(uncaught).toEqual([]);
    } finally {
      await a.close();
      await b.close();
      await leaderCluster.close();
      await otherCluster.close();
      proxy.close();
    }
  },
);

test.skipIf(!url)(
  "a self-healing session works behind a session-mode pooler, with its keepalive set",
  async () => {
    // PgBouncer refuses a startup parameter it does not know, so the keepalive is set once
    // connected instead — and must still be in force on the session that holds the lock.
    const target = new URL(url!);
    const gate = await startupGate({ host: target.hostname, port: Number(target.port || 5432) });
    const viaGate = new URL(url!);
    viaGate.hostname = "127.0.0.1";
    viaGate.port = String(gate.port);
    // The driver, with each client it opens kept, to ask the session's own connection.
    const clients: ReturnType<typeof postgres>[] = [];
    const driver = Object.assign(
      (u: string, o: postgres.Options<Record<string, never>>) => {
        const sql = postgres(u, o);
        clients.push(sql);
        return sql;
      },
      postgres,
    ) as unknown as typeof postgres;
    const session = selfHealingLockSession(driver, viaGate.href);
    try {
      expect(await within(session.tryLock(KEY + 40), LOCK_QUERY_DEADLINE_MS + 2_000)).toEqual({
        value: true,
      });
      const [settings] = await clients[0]!<Record<string, string>[]>`
        SELECT current_setting('tcp_keepalives_idle') AS tcp_keepalives_idle,
          current_setting('tcp_keepalives_interval') AS tcp_keepalives_interval,
          current_setting('tcp_keepalives_count') AS tcp_keepalives_count`;
      expect(settings).toEqual({
        tcp_keepalives_idle: LOCK_SESSION_KEEPALIVE.tcp_keepalives_idle,
        tcp_keepalives_interval: LOCK_SESSION_KEEPALIVE.tcp_keepalives_interval,
        tcp_keepalives_count: LOCK_SESSION_KEEPALIVE.tcp_keepalives_count,
      });
    } finally {
      await session.close();
      gate.close();
    }
  },
);

test.skipIf(!url)(
  "a connection the server closed while idle is replaced, keepalive and all",
  async () => {
    // The server ends an idle backend (a restart, an idle timeout, an admin) and the driver
    // reconnects on the next query by itself. That backend must be introduced like any new one:
    // its keepalive set, and its name taken, so a later give-up ends IT and not the dead one.
    const target = new URL(url!);
    const proxy = await blackHoleProxy(target.hostname, Number(target.port || 5432), {
      sever: true,
    });
    const viaProxy = new URL(url!);
    viaProxy.hostname = "127.0.0.1";
    viaProxy.port = String(proxy.port);
    const clients: ReturnType<typeof postgres>[] = [];
    const driver = Object.assign(
      (u: string, o: postgres.Options<Record<string, never>>) => {
        const sql = postgres(u, o);
        clients.push(sql);
        return sql;
      },
      postgres,
    ) as unknown as typeof postgres;
    const session = selfHealingLockSession(driver, viaProxy.href);
    const admin = postgres(url!, { max: 1, onnotice: () => {} });
    /** The session's current connection, asked on that connection. */
    const current = async () =>
      (await clients.at(-1)!<{ pid: number; idle: string }[]>`
        SELECT pg_backend_pid() AS pid, current_setting('tcp_keepalives_idle') AS idle`)[0]!;
    const holder = async () =>
      (await admin<{ pid: number }[]>`SELECT pid FROM pg_locks
        WHERE locktype = 'advisory' AND objid = ${KEY + 50} AND objsubid = 1`).map((r) => r.pid);
    try {
      expect(await session.tryLock(KEY + 50)).toBe(true);
      const first = await current();
      expect(first.idle).toBe(LOCK_SESSION_KEEPALIVE.tcp_keepalives_idle);

      await admin`SELECT pg_terminate_backend(${first.pid})`;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await session.held(KEY + 50)).toBe(false);
      expect(await session.tryLock(KEY + 50)).toBe(true);
      const second = await current();
      expect(second.pid).not.toBe(first.pid);
      expect(second.idle).toBe(LOCK_SESSION_KEEPALIVE.tcp_keepalives_idle);
      expect(await holder()).toEqual([second.pid]);

      // A partition now: the session gives that connection up with its backend still holding
      // the lock, and the next connection must end that backend — not the one already dead.
      proxy.freeze();
      expect(await within(session.held(KEY + 50), LOCK_QUERY_DEADLINE_MS + 2_000)).toEqual({
        value: false,
      });
      proxy.thaw();
      expect(await within(session.tryLock(KEY + 50), LOCK_QUERY_DEADLINE_MS + 2_000)).toEqual({
        value: true,
      });
      const third = await current();
      expect(await holder()).toEqual([third.pid]);
      const [{ alive }] = await admin<{ alive: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = ${second.pid}) AS alive`;
      expect(alive).toBe(false);
      expect(uncaught).toEqual([]);
    } finally {
      await session.close();
      await admin.end();
      proxy.close();
    }
  },
);

test.skipIf(!url)(
  "a connection that closes under concurrent calls leaves no backend behind",
  async () => {
    // A leader asks `tryLock` and `held` at once. Calls the driver could not yet send wait in its
    // pool queue, and a close with that queue non-empty made it dial again in the same tick, before
    // the give-up's `end()` had begun: a backend nobody asked for, in a client already ended, that
    // nothing would ever close. The calls run one at a time now, so the queue is always empty.
    const target = new URL(url!);
    const proxy = await blackHoleProxy(target.hostname, Number(target.port || 5432));
    const viaProxy = new URL(url!);
    viaProxy.hostname = "127.0.0.1";
    viaProxy.port = String(proxy.port);
    const name = `ryph-lock-leak-${process.pid}`;
    // Every connection starts under `name`; the session renames each it introduces, so one still
    // under it is one the driver opened behind the session's back.
    const clients: ReturnType<typeof postgres>[] = [];
    const driver = Object.assign(
      (u: string, o: postgres.Options<Record<string, never>>) => {
        const sql = postgres(u, { ...o, connection: { ...o.connection, application_name: name } });
        clients.push(sql);
        return sql;
      },
      postgres,
    ) as unknown as typeof postgres;
    const session = selfHealingLockSession(driver, viaProxy.href);
    const admin = postgres(url!, { max: 1, onnotice: () => {} });
    const backends = async () =>
      (await admin<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity WHERE application_name = ${name}`).map((r) => r.pid);
    try {
      expect(await session.held(KEY + 60)).toBe(false);
      const [{ pid }] = await clients[0]!<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      // The first `tryLock` on a connection describes its statement before anything else may be
      // sent, so the two `held` behind it queue — and the describe is lost on the dark wire, which
      // keeps them queued until the backend dies.
      proxy.freeze();
      const calls = Promise.all([
        session.tryLock(KEY + 60).catch(() => false),
        session.held(KEY + 60),
        session.held(KEY + 60),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      proxy.thaw();
      await admin`SELECT pg_terminate_backend(${pid})`;
      expect(await within(calls, LOCK_QUERY_DEADLINE_MS + 2_000)).toHaveProperty("value");
      await session.close();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await backends()).toEqual([]);
      expect(uncaught).toEqual([]);
    } finally {
      await session.close();
      await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE application_name = ${name}`;
      await admin.end();
      proxy.close();
    }
  },
);

test.skipIf(!url)(
  "behind a session-mode pooler, a given-up backend lent to another client is left alone",
  async () => {
    // The pooler resets a server connection the session gave up (DISCARD ALL drops its locks) and
    // lends it, same pid and start, to the next client. Ending "the orphan" then would end that
    // client's session — another service's, another replica's lock session, or this one's own.
    const target = new URL(url!);
    const pooler = await sessionPooler(target.hostname, Number(target.port || 5432));
    const viaPooler = new URL(url!);
    viaPooler.hostname = "127.0.0.1";
    viaPooler.port = String(pooler.port);
    viaPooler.searchParams.set("sslmode", "disable");
    const session = selfHealingLockSession(postgres, viaPooler.href, 300);
    const admin = postgres(url!, { max: 1, onnotice: () => {} });
    let innocent: ReturnType<typeof postgres> | null = null;
    try {
      expect(await session.tryLock(KEY + 70)).toBe(true);
      const [{ pid: given }] = await admin<{ pid: number }[]>`SELECT pid FROM pg_locks
        WHERE locktype = 'advisory' AND objid = ${KEY + 70} AND objsubid = 1`;
      // Slow enough to miss the deadline: the session gives that connection up, and the pooler
      // takes the server connection back.
      pooler.freeze();
      expect(await session.held(KEY + 70)).toBe(false);
      pooler.thaw();
      await new Promise((resolve) => setTimeout(resolve, 300));

      innocent = postgres(viaPooler.href, { max: 1, idle_timeout: 0, onnotice: () => {} });
      const [{ pid: lent }] = await innocent<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      expect(lent).toBe(given);

      // The session's next call opens a fresh connection, which ends the backends given up.
      expect(await session.tryLock(KEY + 70)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      // Still the same backend: the driver would quietly reconnect over a terminated one.
      const [{ alive }] = await admin<{ alive: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = ${lent}) AS alive`;
      expect(alive).toBe(true);
      const [{ pid: still }] = await innocent<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      expect(still).toBe(lent);
      expect(uncaught).toEqual([]);
    } finally {
      await session.close();
      await innocent?.end({ timeout: 0 });
      await admin.end();
      pooler.close();
    }
  },
);

/** A TCP proxy to `host:port` that can stop forwarding bytes without closing anything — what a
 * partition looks like to both ends. A socket either end closes closes its partner. */
async function blackHoleProxy(host: string, port: number, opts: { sever?: boolean } = {}): Promise<{
  port: number;
  freeze(): void;
  thaw(): void;
  close(): void;
}> {
  let frozen = false;
  const pairs = new Set<[Socket, Socket]>();
  // With `sever`, a pair alive at the freeze stays dark for good — its closes never cross either
  // — while connections made after the thaw pass: a partition that healed.
  const severed = new WeakSet<Socket>();
  const server: Server = createServer((client) => {
    const upstream = new Socket();
    const pair: [Socket, Socket] = [client, upstream];
    pairs.add(pair);
    upstream.connect(port, host);
    const forward = (from: Socket, to: Socket) =>
      from.on("data", (chunk) => {
        if (!frozen && !severed.has(from)) to.write(chunk);
      });
    forward(client, upstream);
    forward(upstream, client);
    const drop = () => {
      if (severed.has(client)) return;
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on("close", drop).on("error", drop);
    upstream.on("close", drop).on("error", drop);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("proxy has no port");
  return {
    port: address.port,
    freeze() {
      frozen = true;
      if (opts.sever) {
        for (const [a, b] of pairs) {
          severed.add(a);
          severed.add(b);
        }
      }
    },
    thaw() {
      frozen = false;
    },
    close() {
      for (const [a, b] of pairs) {
        a.destroy();
        b.destroy();
      }
      server.close();
    },
  };
}

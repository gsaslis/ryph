// The self-healing lock session's own logic, against a fake driver — no database, so CI runs it.
// lock_session_postgres_test.ts shows the same on a real server.

import { expect, jest, test } from "bun:test";
import { connect, type Socket } from "node:net";
import postgres from "postgres";
import { LOCK_QUERY_GRACE_MS, selfHealingLockSession } from "../src/open.ts";
import { PGBOUNCER_STARTUP_PARAMETERS, startupGate } from "./startup_gate.ts";

type Answer = (text: string, values: unknown[]) => Promise<unknown[]>;

/** A stand-in for the `postgres` constructor: every connection it opens answers through
 * `answer`, and records what it was asked. */
function fakeDriver(answer: (conn: number, text: string, values: unknown[]) => Promise<unknown[]>) {
  const asked: Array<{ conn: number; text: string; values: unknown[] }> = [];
  const ended: number[] = [];
  /** Each connection's `onclose`, by number: what the driver calls when its socket closes. */
  const closes: Array<() => void> = [];
  let opened = 0;
  class PostgresError extends Error {}
  const postgres = (_url: string, options: { onclose?: () => void }) => {
    const conn = ++opened;
    closes[conn] = () => options.onclose?.();
    const respond: Answer = (text, values) => {
      asked.push({ conn, text, values });
      return answer(conn, text, values);
    };
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) =>
      respond(strings.join("?").replace(/\s+/g, " ").trim(), values);
    sql.end = () => {
      ended.push(conn);
      return Promise.resolve();
    };
    return sql;
  };
  postgres.PostgresError = PostgresError;
  return {
    postgres: postgres as never,
    asked,
    ended,
    closes,
    opened: () => opened,
    PostgresError,
  };
}

/** The tag connection `conn` gave its backend while introducing itself. */
const tagOf = (asked: ReturnType<typeof fakeDriver>["asked"], conn: number) =>
  asked.find((q) => q.conn === conn && q.text.includes("set_config('application_name'"))
    ?.values[0];

/** What a healthy backend `pid` answers. */
const healthy = (pid: number) => (text: string): Promise<unknown[]> => {
  if (text.includes("FROM pg_stat_activity WHERE pid = pg_backend_pid()")) {
    return Promise.resolve([{ pid, started: `${pid}000` }]);
  }
  if (text.includes("pg_terminate_backend")) return Promise.resolve([{ t: true }]);
  if (text.includes("pg_try_advisory_lock")) return Promise.resolve([{ locked: true }]);
  if (text.includes("EXISTS")) return Promise.resolve([{ held: true }]);
  return Promise.resolve([]);
};

test("a call that misses the deadline gives the connection up, and the next ends its backend", async () => {
  const driver = fakeDriver((conn, text) =>
    // The first connection goes dark after introducing itself and taking the lock.
    conn === 1 && text.includes("EXISTS") ? new Promise(() => {}) : healthy(100 + conn)(text)
  );
  const session = selfHealingLockSession(driver.postgres, "postgres://x", 50);
  expect(await session.tryLock(7)).toBe(true);
  expect(await session.held(7)).toBe(false); // the deadline's "no"
  expect(driver.ended).toEqual([1]);

  expect(await session.held(7)).toBe(true); // a fresh connection
  expect(driver.opened()).toBe(2);
  const reaped = driver.asked.filter((q) => q.text.includes("pg_terminate_backend"));
  // The old backend, named by pid AND start, so a pid the OS reused is never the one ended, and
  // by its tag, so one a pooler lent to another client is not either.
  expect(tagOf(driver.asked, 1)).toMatch(/^ryph-lock-[0-9a-f-]{36}$/);
  expect(tagOf(driver.asked, 2)).not.toBe(tagOf(driver.asked, 1));
  expect(reaped).toEqual([
    expect.objectContaining({ conn: 2, values: [101, "101000", tagOf(driver.asked, 1)] }),
  ]);

  // Ended once: a third connection has nothing left to end.
  await session.held(7);
  expect(driver.asked.filter((q) => q.text.includes("pg_terminate_backend"))).toHaveLength(1);
  await session.close();
});

test("calls on a connection go one at a time, each within its deadline from the call", async () => {
  // Two at once on the driver's one connection would queue the second in its pool, where a close
  // makes it dial a connection nobody ends. A call waiting its turn still answers in time, and
  // one whose connection was given up before its turn fails there, never sent.
  let release: () => void = () => {};
  const driver = fakeDriver((conn, text) =>
    conn === 1 && text.includes("pg_try_advisory_lock")
      ? new Promise((resolve) => (release = () => resolve([{ locked: true }])))
      : healthy(100 + conn)(text)
  );
  // On a fake clock: a wall-clock bound flaked on loaded CI runners, where the test process can
  // be starved for longer than any margin that would still tell "from the call" from "from its
  // turn".
  const session = selfHealingLockSession(driver.postgres, "postgres://x", 200);
  jest.useFakeTimers();
  try {
    const settledAt: Record<string, number> = {};
    let now = 0;
    const first = session.tryLock(7).catch((err: unknown) => String(err))
      .finally(() => (settledAt.first = now));
    const second = session.held(7).finally(() => (settledAt.second = now));
    const advance = async (ms: number) => {
      now += ms;
      jest.advanceTimersByTime(ms);
      for (let i = 0; i < 50; i++) await Promise.resolve();
    };
    await advance(20);
    // Only the first was sent; the introduction ran once.
    expect(driver.asked.filter((q) => q.text.includes("EXISTS"))).toEqual([]);
    expect(driver.asked.filter((q) => q.text.includes("set_config('tcp_keepalives_idle'")))
      .toHaveLength(1);
    // Neither answers before the deadline and its grace, both as soon as they have passed: the
    // second's deadline ran from its call, not from the turn the first held up.
    await advance(200 + LOCK_QUERY_GRACE_MS - 20 - 1);
    expect(settledAt).toEqual({});
    await advance(1);
    expect(settledAt).toEqual({
      first: 200 + LOCK_QUERY_GRACE_MS,
      second: 200 + LOCK_QUERY_GRACE_MS,
    });
    expect(await first).toContain("timed out");
    expect(await second).toBe(false);
    expect(driver.asked.filter((q) => q.text.includes("EXISTS"))).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
  release();

  // A healthy connection answers the next calls in order.
  expect(await Promise.all([session.tryLock(7), session.held(7), session.held(7)])).toEqual([
    true,
    true,
    true,
  ]);
  expect(driver.opened()).toBe(2);
  await session.close();
});

test("a connection that closes while idle is replaced, not reconnected behind the session", async () => {
  // postgres-js reconnects on the next query by itself; that backend would have no keepalive,
  // and the session would still name the one that went.
  const driver = fakeDriver((conn, text) => healthy(100 + conn)(text));
  const session = selfHealingLockSession(driver.postgres, "postgres://x", 50);
  expect(await session.tryLock(7)).toBe(true);
  driver.closes[1]!();
  expect(driver.ended).toEqual([1]);

  expect(await session.held(7)).toBe(true);
  expect(driver.opened()).toBe(2);
  const on2 = driver.asked.filter((q) => q.conn === 2).map((q) => q.text);
  expect(on2[0]).toContain("set_config('tcp_keepalives_idle'");
  // Its backend is ended if it still lives — the server may only have lost the client.
  const reaped = driver.asked.filter((q) => q.text.includes("pg_terminate_backend"));
  expect(reaped).toEqual([
    expect.objectContaining({ conn: 2, values: [101, "101000", tagOf(driver.asked, 1)] }),
  ]);
  await session.close();
});

test("a connection that closes mid-call fails that call, whatever answer follows", async () => {
  // The driver errors what was on the wire and runs what it still had queued on a connection it
  // opens itself: an answer from there is from a backend the session never introduced.
  let closing = true;
  const driver = fakeDriver((conn, text) => {
    if (conn === 1 && closing && text.includes("pg_try_advisory_lock")) {
      closing = false;
      driver.closes[1]!();
    }
    return healthy(100 + conn)(text);
  });
  const session = selfHealingLockSession(driver.postgres, "postgres://x", 50);
  expect(await session.held(7)).toBe(true);
  await expect(session.tryLock(7)).rejects.toThrow("lock connection closed");
  expect(driver.ended).toEqual([1]);
  expect(await session.tryLock(7)).toBe(true);
  expect(driver.opened()).toBe(2);
  await session.close();
});

test("a connection that closes while introducing itself keeps the backends still to end", async () => {
  let closing = true;
  const driver = fakeDriver((conn, text) => {
    if (conn === 1 && text.includes("EXISTS")) return new Promise(() => {});
    if (conn === 2 && closing && text.includes("pg_terminate_backend")) {
      closing = false;
      driver.closes[2]!();
    }
    return healthy(100 + conn)(text);
  });
  const session = selfHealingLockSession(driver.postgres, "postgres://x", 50);
  await session.tryLock(7);
  expect(await session.held(7)).toBe(false); // conn 1 goes dark and is given up
  expect(await session.held(7)).toBe(false); // conn 2 closes while ending conn 1's backend
  expect(await session.held(7)).toBe(true);
  // The third connection still ends the first one's backend.
  const reaped = driver.asked.filter((q) =>
    q.conn === 3 && q.text.includes("pg_terminate_backend")
  );
  expect(reaped).toEqual([
    expect.objectContaining({ values: [101, "101000", tagOf(driver.asked, 1)] }),
  ]);
  await session.close();
});

test("a backend the server will not end does not cost the new connection", async () => {
  let dark = true;
  const driver = fakeDriver((conn, text) => {
    if (conn === 1 && dark && text.includes("EXISTS")) return new Promise(() => {});
    if (text.includes("pg_terminate_backend")) {
      return Promise.reject(new driver.PostgresError("must be a member of the role"));
    }
    return healthy(100 + conn)(text);
  });
  const session = selfHealingLockSession(driver.postgres, "postgres://x", 50);
  await session.tryLock(7);
  expect(await session.held(7)).toBe(false);
  dark = false;
  expect(await session.held(7)).toBe(true);
  expect(driver.ended).toEqual([1]);
  await session.close();
});

test("an answer that arrived while the event loop was held is taken, not timed out", async () => {
  // The answer comes over a real socket from another process, as a database's does: here only
  // the loop that would read it is late.
  const echo = Bun.spawn([
    "bun",
    "-e",
    `
    const s = Bun.listen({ hostname: "127.0.0.1", port: 0,
      socket: { data(sock, d) { sock.write(d); } } });
    console.log(s.port);
  `,
  ], { stdout: "pipe" });
  const port = await readPort(echo);
  const socket: Socket = connect(port, "127.0.0.1");
  await new Promise((resolve) => socket.once("connect", resolve));
  try {
    const driver = fakeDriver((_conn, text) => {
      if (!text.includes("EXISTS")) return healthy(1)(text);
      socket.write("x");
      return new Promise((resolve) => socket.once("data", () => resolve([{ held: true }])));
    });
    const session = selfHealingLockSession(driver.postgres, "postgres://x", 50);
    await session.tryLock(7);
    const asked = session.held(7);
    const until = performance.now() + 300;
    while (performance.now() < until) { /* a GC pause, a big parse */ }
    expect(await asked).toBe(true);
    expect(driver.ended).toEqual([]);
    await session.close();
  } finally {
    socket.destroy();
    echo.kill();
  }
});

async function readPort(proc: { stdout: ReadableStream<Uint8Array> }): Promise<number> {
  const reader = proc.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return Number(text.trim());
}

test("a self-healing session opens with nothing PgBouncer refuses in its startup packet", async () => {
  // A session-mode pooler is a supported front for the database, and PgBouncer closes a
  // connection whose startup packet names a parameter it does not know. The webhook leader's
  // session never connecting there means no replica is ever the leader, and no hook is delivered.
  const gate = await startupGate();
  const session = selfHealingLockSession(
    postgres,
    `postgres://ryph@127.0.0.1:${gate.port}/ryph`,
    500,
  );
  try {
    await session.tryLock(1).catch(() => {});
    expect(gate.seen.length).toBeGreaterThan(0);
    for (const names of gate.seen) {
      expect(names.filter((name) => !PGBOUNCER_STARTUP_PARAMETERS.has(name))).toEqual([]);
    }
  } finally {
    await session.close();
    gate.close();
  }
});

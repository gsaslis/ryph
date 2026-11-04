// The boot-time wait for a platform MCP server row: the race it exists for is the gateway
// seeding its rows while this process is already asking for them.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { awaitPlatformServer } from "../src/helpers/platform_server.ts";

/** A clock and a sleep that move together, so a 60s wait costs a test nothing. */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => (now += ms),
  };
}

test("a row that is already there is answered on the first attempt", async () => {
  const clock = fakeClock();
  const verdict = await awaitPlatformServer({
    lookup: { getServer: () => Promise.resolve({ archivedAt: null }) },
    id: "ms-platform-web",
    now: clock.now,
    sleep: clock.sleep,
  });
  assert(verdict.served);
  assertEquals(verdict.attempts, 1);
  assertEquals(verdict.waitedMs, 0, "nothing was waited for");
});

test("a row that appears late is waited for, not given up on", async () => {
  const clock = fakeClock();
  let calls = 0;
  const verdict = await awaitPlatformServer({
    lookup: {
      getServer: () => Promise.resolve(++calls < 4 ? null : { archivedAt: null }),
    },
    id: "ms-platform-web",
    now: clock.now,
    sleep: clock.sleep,
  });
  assert(verdict.served, "the seed landed while we were asking");
  assertEquals(verdict.attempts, 4);
  assert(verdict.waitedMs > 0);
});

test("a gateway that is not listening yet is a retry, not a verdict", async () => {
  const clock = fakeClock();
  let calls = 0;
  const verdict = await awaitPlatformServer({
    lookup: {
      getServer: () =>
        ++calls < 3
          ? Promise.reject(new Error("connection refused"))
          : Promise.resolve({ archivedAt: null }),
    },
    id: "ms-platform-forge",
    now: clock.now,
    sleep: clock.sleep,
  });
  assert(verdict.served);
  assertEquals(verdict.attempts, 3);
});

test("the wait is bounded, and the last reason is what it reports", async () => {
  const clock = fakeClock();
  let calls = 0;
  const verdict = await awaitPlatformServer({
    lookup: {
      getServer: () => {
        calls++;
        return Promise.reject(new Error("connection refused"));
      },
    },
    id: "ms-platform-web",
    timeoutMs: 60_000,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert(!verdict.served);
  assertEquals(verdict.reason, "connection refused");
  assert(verdict.waitedMs >= 60_000, `waited ${verdict.waitedMs}ms`);
  // Backoff, not a hot loop: 60s of doubling from 250ms up to a 5s cap is tens of attempts.
  assert(calls > 5 && calls < 40, `${calls} attempts in a minute`);
});

test("an archived row is an answer, and is not waited on", async () => {
  const clock = fakeClock();
  let calls = 0;
  const verdict = await awaitPlatformServer({
    lookup: {
      getServer: () => {
        calls++;
        return Promise.resolve({ archivedAt: "2026-01-01T00:00:00.000Z" });
      },
    },
    id: "ms-platform-web",
    now: clock.now,
    sleep: clock.sleep,
  });
  assert(!verdict.served);
  assertEquals(verdict.reason, "archived");
  assertEquals(calls, 1, "somebody archived it; waiting would be waiting for a person");
});

test("timeoutMs 0 is exactly one attempt", async () => {
  const clock = fakeClock();
  let calls = 0;
  const verdict = await awaitPlatformServer({
    lookup: {
      getServer: () => {
        calls++;
        return Promise.resolve(null);
      },
    },
    id: "ms-platform-web",
    timeoutMs: 0,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert(!verdict.served);
  assertEquals(verdict.reason, "absent");
  assertEquals(calls, 1);
});

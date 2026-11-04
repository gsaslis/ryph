// The pure state machine against a fake clock — no store, no HTTP, no consumer.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  markDelivered,
  markDelivering,
  markFailed,
  openHook,
  planHookSweep,
  retryHook,
} from "../src/core/hook_lifecycle.ts";
import { DEFAULT_DELIVERY_POLICY, type DeliveryPolicy, type Hook } from "../src/core/types.ts";

const POLICY: DeliveryPolicy = {
  leaseMs: 60_000,
  baseBackoffMs: 10_000,
  maxBackoffMs: 15 * 60_000,
  maxAttempts: 3,
};

const T0 = "2026-01-01T00:00:00.000Z";
const at = (offsetMs: number) => new Date(Date.parse(T0) + offsetMs).toISOString();

function freshHook(overrides: Partial<Hook> = {}): Hook {
  return {
    ...openHook(
      { id: "wh-0000000001", registrationId: "github", headers: {}, body: "{}" },
      T0,
    ),
    seq: 1,
    ...overrides,
  };
}

test("a hook is born pending with no clock and no lease", () => {
  const hook = freshHook();
  assertEquals(hook.state, "pending");
  assertEquals(hook.attempts, 0);
  assertEquals(hook.nextAttemptAt, null);
  assertEquals(hook.leaseExpiresAt, null);
});

test("taking the lease counts the attempt and sets its expiry", () => {
  const taken = markDelivering(freshHook(), T0, POLICY);
  assert(taken.kind === "applied");
  assertEquals(taken.hook.state, "delivering");
  assertEquals(taken.hook.attempts, 1);
  assertEquals(taken.hook.leaseExpiresAt, at(POLICY.leaseMs));
});

test("a running backoff clock refuses the lease — a sweep racing the clock cannot burn attempts early", () => {
  const waiting = freshHook({ nextAttemptAt: at(10_000) });
  const refused = markDelivering(waiting, at(5_000), POLICY);
  assertEquals(refused.kind, "refused");
  const due = markDelivering(waiting, at(10_000), POLICY);
  assertEquals(due.kind, "applied");
});

test("success clears the clock, the lease and the error, and stamps deliveredAt", () => {
  const taken = markDelivering(freshHook({ lastError: "old news" }), T0, POLICY);
  assert(taken.kind === "applied");
  const done = markDelivered(taken.hook, at(1_000));
  assert(done.kind === "applied");
  assertEquals(done.hook.state, "delivered");
  assertEquals(done.hook.nextAttemptAt, null);
  assertEquals(done.hook.leaseExpiresAt, null);
  assertEquals(done.hook.lastError, null);
  assertEquals(done.hook.deliveredAt, at(1_000));
});

test("a retryable failure goes back to pending with an exponential clock", () => {
  const taken = markDelivering(freshHook(), T0, POLICY);
  assert(taken.kind === "applied");
  const failed = markFailed(taken.hook, { message: "503", terminal: false }, at(1_000), POLICY);
  assert(failed.kind === "applied");
  assertEquals(failed.hook.state, "pending");
  assertEquals(failed.hook.nextAttemptAt, at(1_000 + POLICY.baseBackoffMs));
  assertEquals(failed.hook.lastError, "503");
  assertEquals(failed.hook.leaseExpiresAt, null);
});

test("the backoff doubles per attempt and respects the cap", () => {
  // Attempt 2: base * 2^(2-1).
  const second = markFailed(
    freshHook({ state: "delivering", attempts: 2 }),
    { message: "503", terminal: false },
    T0,
    { ...POLICY, maxAttempts: 10 },
  );
  assert(second.kind === "applied");
  assertEquals(second.hook.nextAttemptAt, at(POLICY.baseBackoffMs * 2));

  const capped = markFailed(
    freshHook({ state: "delivering", attempts: 9 }),
    { message: "503", terminal: false },
    T0,
    { ...POLICY, maxAttempts: 10 },
  );
  assert(capped.kind === "applied");
  assertEquals(capped.hook.nextAttemptAt, at(POLICY.maxBackoffMs));
});

test("a terminal failure exhausts immediately — retrying a foregone conclusion burns nothing", () => {
  const taken = markDelivering(freshHook(), T0, POLICY);
  assert(taken.kind === "applied");
  const failed = markFailed(
    taken.hook,
    { message: "payload does not parse", terminal: true },
    at(1_000),
    POLICY,
  );
  assert(failed.kind === "applied");
  assertEquals(failed.hook.state, "exhausted");
  assertEquals(failed.hook.nextAttemptAt, null);
});

test("spending the retry budget exhausts the hook", () => {
  const lastTry = markFailed(
    freshHook({ state: "delivering", attempts: POLICY.maxAttempts }),
    { message: "503", terminal: false },
    T0,
    POLICY,
  );
  assert(lastTry.kind === "applied");
  assertEquals(lastTry.hook.state, "exhausted");
});

test("an operator retry re-queues an exhausted hook with a fresh budget", () => {
  const retried = retryHook(
    freshHook({ state: "exhausted", attempts: 3, lastError: "503" }),
    at(1_000),
  );
  assert(retried.kind === "applied");
  assertEquals(retried.hook.state, "pending");
  assertEquals(retried.hook.attempts, 0);
  assertEquals(retried.hook.nextAttemptAt, null);
});

test("the sweep plan: a due head delivers, a waiting head blocks, an expired lease reclaims", () => {
  assertEquals(planHookSweep(freshHook(), Date.parse(T0), T0).kind, "deliver");
  assertEquals(
    planHookSweep(freshHook({ nextAttemptAt: at(10_000) }), Date.parse(T0), T0).kind,
    "wait",
  );

  const inFlight = freshHook({ state: "delivering", leaseExpiresAt: at(60_000) });
  assertEquals(planHookSweep(inFlight, Date.parse(at(30_000)), at(30_000)).kind, "wait");

  const reclaimed = planHookSweep(inFlight, Date.parse(at(60_000)), at(60_000));
  assert(reclaimed.kind === "reclaim");
  assertEquals(reclaimed.hook.state, "pending");
  assertEquals(reclaimed.hook.leaseExpiresAt, null);
});

test("the default policy steps over a hook after ten attempts", () => {
  assertEquals(DEFAULT_DELIVERY_POLICY.maxAttempts, 10);
});

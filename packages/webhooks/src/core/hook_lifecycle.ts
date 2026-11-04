// The hook state machine, as pure functions — the same contract as the orchestrator's
// patch lifecycle: every transition takes the current Hook and returns the next Hook,
// persistence is the caller's job, and the store stays a dumb row-holder.
//
// Invariants:
// - a hook is durable the instant ingestion answers 202: verification happens before the row,
//   everything else after it
// - a retryable failure is not a separate state — it is `pending`, with a clock and a reason,
//   which is exactly what the sweep already knows how to wait on
// - `markDelivering` records intent (and takes the lease); the consumer call that follows is
//   the caller's delivery, free to fail, because the sweep always fires again
// - the lease guards a deliverer that DIED; one running CONCURRENTLY is stopped one layer out,
//   by `saveHookIfState` — this transition is pure and judges the copy it was handed
// - `exhausted` is terminal and stepped over. The patch queue's "wait for a human" stance is
//   wrong here: one poisoned delivery must not silence every subsequent webhook forever

import type { DeliveryPolicy, Hook, NewHook } from "./types.ts";
import { TERMINAL_HOOK_STATES } from "./types.ts";

export function isHookTerminal(hook: Hook): boolean {
  return TERMINAL_HOOK_STATES.has(hook.state);
}

/** Birth: everything a hook knows arrives with the request. The store assigns `seq`. An absent
 * `scope` is null — the registration's single queue (see `Hook.scope`). */
export function openHook(
  args: {
    id: string;
    registrationId: string;
    scope?: string | null;
    headers: Record<string, string>;
    body: string;
  },
  at: string,
): NewHook {
  return {
    id: args.id,
    registrationId: args.registrationId,
    scope: args.scope ?? null,
    headers: args.headers,
    body: args.body,
    state: "pending",
    attempts: 0,
    nextAttemptAt: null,
    leaseExpiresAt: null,
    lastError: null,
    receivedAt: at,
    deliveredAt: null,
    updatedAt: at,
    dedupeKey: null,
  };
}

export type HookTransitionOutcome =
  | { kind: "refused"; why: string }
  | { kind: "applied"; hook: Hook };

/**
 * A sweep takes the lease: pending → delivering. Records INTENT — the consumer call that
 * follows is delivery, and is free to fail. Refuses while a backoff clock is still running,
 * so a sweep racing the clock cannot burn attempts early.
 */
export function markDelivering(
  hook: Hook,
  at: string,
  policy: DeliveryPolicy,
): HookTransitionOutcome {
  if (hook.state !== "pending") {
    return { kind: "refused", why: `hook is ${hook.state}, not pending` };
  }
  if (hook.nextAttemptAt !== null && Date.parse(hook.nextAttemptAt) > Date.parse(at)) {
    return { kind: "refused", why: `next attempt is not due until ${hook.nextAttemptAt}` };
  }
  return {
    kind: "applied",
    hook: {
      ...hook,
      state: "delivering",
      attempts: hook.attempts + 1,
      leaseExpiresAt: new Date(Date.parse(at) + policy.leaseMs).toISOString(),
      updatedAt: at,
    },
  };
}

/** The consumer said ok: delivering → delivered. Terminal. `dedupeKey` is what the consumer
 * confirmed the hook was about (`ConsumeOutcome`), written down so a later hook with the same key
 * is known as already taken. */
export function markDelivered(
  hook: Hook,
  at: string,
  dedupeKey: string | null = null,
): HookTransitionOutcome {
  if (hook.state !== "delivering") {
    return { kind: "refused", why: `hook is ${hook.state}, not delivering` };
  }
  return {
    kind: "applied",
    hook: {
      ...hook,
      state: "delivered",
      leaseExpiresAt: null,
      nextAttemptAt: null,
      lastError: null,
      deliveredAt: at,
      updatedAt: at,
      dedupeKey,
    },
  };
}

/**
 * Delivery failed. Retryable with budget left: back to `pending` with an exponential-backoff
 * clock — the hook keeps its place in line, and everything behind it waits (FIFO is the
 * guarantee, head-of-line blocking is its price). Terminal, or budget spent: `exhausted`,
 * and the queue steps over it.
 */
export function markFailed(
  hook: Hook,
  error: { message: string; terminal: boolean },
  at: string,
  policy: DeliveryPolicy,
): HookTransitionOutcome {
  if (hook.state !== "delivering") {
    return { kind: "refused", why: `hook is ${hook.state}, not delivering` };
  }
  const retryable = !error.terminal && hook.attempts < policy.maxAttempts;
  return {
    kind: "applied",
    hook: {
      ...hook,
      state: retryable ? "pending" : "exhausted",
      nextAttemptAt: retryable
        ? new Date(
          Date.parse(at) +
            Math.min(policy.baseBackoffMs * 2 ** (hook.attempts - 1), policy.maxBackoffMs),
        ).toISOString()
        : null,
      leaseExpiresAt: null,
      lastError: error.message,
      updatedAt: at,
    },
  };
}

/** An operator re-queues an exhausted hook: exhausted → pending, keeping its seq — it goes
 * back to its ORIGINAL place in line, ahead of everything that arrived after it. */
export function retryHook(hook: Hook, at: string): HookTransitionOutcome {
  if (hook.state !== "exhausted") {
    return { kind: "refused", why: `hook is ${hook.state}, not exhausted` };
  }
  return {
    kind: "applied",
    hook: { ...hook, state: "pending", attempts: 0, nextAttemptAt: null, updatedAt: at },
  };
}

export type HookSweepAction =
  /** The head is due: take the lease (markDelivering) and deliver. */
  | { kind: "deliver" }
  /** A deliverer died mid-flight: its lease expired, hand the hook back to the queue. */
  | { kind: "reclaim"; hook: Hook }
  /** The head is in flight or waiting out a clock — nothing behind it may move. */
  | { kind: "wait" };

/**
 * The sweep's decision for a queue's HEAD hook (the lowest-seq non-terminal row of one
 * (registration, scope) —
 * the store's `getHeadHook` never surfaces `delivered` or `exhausted`, which is what makes
 * "step over the exhausted" fall out of the query instead of out of logic here).
 * Pure, so it is tested against a fake clock.
 */
export function planHookSweep(head: Hook, nowMs: number, at: string): HookSweepAction {
  switch (head.state) {
    case "pending":
      if (head.nextAttemptAt === null || Date.parse(head.nextAttemptAt) <= nowMs) {
        return { kind: "deliver" };
      }
      return { kind: "wait" };
    case "delivering":
      if (head.leaseExpiresAt !== null && Date.parse(head.leaseExpiresAt) <= nowMs) {
        return {
          kind: "reclaim",
          hook: { ...head, state: "pending", leaseExpiresAt: null, updatedAt: at },
        };
      }
      return { kind: "wait" };
    default:
      // Terminal states never come back from getHeadHook; refusing to act is still safer
      // than assuming the store's query.
      return { kind: "wait" };
  }
}

// The row-holder for ingested hooks. Dumb on purpose: every decision lives in the pure
// lifecycle; the one clever thing here is `saveHookIfState`, whose conditional write IS the
// concurrency control between sweeps.

import type { Hook, HookState, NewHook } from "../core/types.ts";

export interface HookStore {
  /** Persists a newly ingested hook and returns it with its store-assigned `seq`. */
  recordHook(hook: NewHook): Promise<Hook>;
  getHook(id: string): Promise<Hook | null>;
  /**
   * The head of one queue — a registration's hooks of one `scope` (see `Hook.scope`): the
   * lowest-seq hook still in `pending` or `delivering`. Terminal rows (`delivered`,
   * `exhausted`) never surface — which is what makes the queue step over an exhausted hook
   * without any logic asking it to. An absent `scope` means null: the registration's unscoped
   * queue, which for a mailbox without scopes is its only one.
   */
  getHeadHook(registrationId: string, scope?: string | null): Promise<Hook | null>;
  /**
   * Every queue under many registrations whose head is DUE at `dueAt` — one entry per
   * (registration, scope), same head as `getHeadHook`, null scopes grouping as one queue —
   * skipping each queue whose head waits: a `pending` one whose retry clock runs past `dueAt`, a
   * `delivering` one whose lease does. Such a head blocks its queue anyway, so a sweep has nothing
   * to do there. KEYS only, never the rows: a sweep reads them often (every scan, during a long
   * pass too) and needs a head's body only when its turn comes. Costs a few index probes per
   * queue, never a walk over the live rows: a scan over N idle mailboxes is one statement, and a
   * backlog does not make it slower.
   */
  getDueQueues(
    registrationIds: readonly string[],
    dueAt: string,
  ): Promise<Array<{ registrationId: string; scope: string | null }>>;
  saveHook(hook: Hook): Promise<void>;
  /** Whether a DELIVERED hook of the queue (registration, `scope`; null is the unscoped one)
   * carries `dedupeKey` — `WebhookRegistration.dedupeKey`'s question. */
  hasDeliveredKey(
    registrationId: string,
    scope: string | null,
    dedupeKey: string,
  ): Promise<boolean>;
  /**
   * Writes `hook` only if the stored row is still in one of `expected` states — one
   * statement, so the read and the write cannot be separated by a concurrent sweep: the
   * WHERE is the claim. Returns whether this caller won it.
   *
   * `expectedAttempts` is the fencing token for COMPLETION writes: a deliverer that
   * outlived its lease finds the row reclaimed and re-claimed under a higher attempt
   * count, and must not overwrite the replica now holding it. States alone cannot tell
   * "my delivery" from "someone else's re-delivery"; the attempt counter can.
   */
  saveHookIfState(hook: Hook, expected: HookState[], expectedAttempts?: number): Promise<boolean>;
  /** Deletes up to `limit` terminal hooks (`delivered`, `exhausted`) of a registration last
   * updated before `before`, oldest first. Answers how many. */
  deleteTerminalHooks(registrationId: string, before: string, limit: number): Promise<number>;
  /** Deletes every hook under a registration id, whatever its state — for a registrant that
   * is removing the registration for good, not merely handing the mailbox back. */
  deleteHooksForRegistration(registrationId: string): Promise<void>;
}

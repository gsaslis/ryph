// The drain: hands each queue's hooks to its consumer, strictly oldest-first.
//
// A queue is one (registration, scope): a mailbox's hooks of one verified scope (`Hook.scope`),
// and for every mailbox without scopes simply all of its hooks. FIFO per queue is the
// documented guarantee, and this loop is where it lives: only the queue HEAD is ever considered,
// one delivery is in flight per queue, and a head that is retrying blocks everything behind it
// in its own queue — delivering hook N+1 before hook N would reorder, which is the one thing this
// module promised not to do. The two escapes are in the lifecycle: terminal failures exhaust
// immediately, and `getHeadHook` steps over `exhausted`.
//
// Why the scope splits the queue: one `derived-secret-header` mailbox serves every GitLab project
// that was connected, and a single shared queue let one project's retrying hook hold every other
// project's behind it for the whole backoff ladder (the best part of an hour). Order matters
// within a project — its events carry state — and means nothing across projects, so the queue is
// cut exactly where the promise ends. The scope is the one the DOOR verified, so a sender cannot
// pick a queue it holds no credential for.
//
// Every mailbox drains on its own (`Lane`): its own passes, its own line, its own drains. Nothing
// a mailbox's consumer does — GitLab hanging, each of hundreds of projects' reads running to its
// timeout — reaches another mailbox's hooks, because no slot, pass or read is shared with them.
// Shared passes were tried first and drew a finding every round: a slot kept per mailbox, then a
// pass woken by arrivals, then a cap on that waking — and still a GitHub push waited out GitLab's
// pass the moment the cap was reached. So the isolation is structural now, not a rule a shared
// pass keeps.
//
// One read finds the work for every mailbox (`scan`): the keys of the DUE queues, never their
// rows — an idle scan over N mailboxes is one statement, and a re-read during a long pass costs
// a key per queue, not a body of up to 2 MB. A queue's head row is read when its turn starts.
// The scan hands each mailbox its queues: an idle one starts a pass, a running one takes those
// it does not hold yet into its line. A hook this process queues goes straight into its
// mailbox's running line (`arrived`) — no read, no cap; a mailbox with no pass running says so,
// and the host's kick scans.
//
// Within a mailbox the queues take TURNS: one drains at most SWEEP_TURN hooks before it goes to
// the back of the line, so a scope whose token holder keeps it full holds a new head for one turn
// of each queue ahead of it, never for the pass. Up to MAX_CONCURRENT_DRAINS queues drain side by
// side. A pass ends when its line is empty, or at MAX_DELIVERIES_PER_PASS; the next starts after
// the last queue this one reached (`Lane.cursor`), so a pass that runs out before the end of a
// long line leaves the rest first in line next time.
//
// A due head is delivered only once its registrant says it can afford to
// (`WebhookRegistration.admitDelivery`) — GitLab's mailbox spends one budget of API calls across
// every project. That is asked before the claim, so a "not now" writes nothing and costs the hook
// no attempt: the queue stops until the next scan, which asks again. A refusal counted as a failed
// delivery let a flood of other queues, each within its own rate limit, keep the budget empty until
// a waiting command's retries ran out. Nor is a refusal one of the pass's deliveries: counted, a
// thousand refused projects held every queue behind them out of every pass.
//
// Multi-replica: the claim is `saveHookIfState`, a conditional UPDATE, so two drains can never
// take the same hook. Where the host names a leader (`SweeperDeps.leader`) only the leader scans,
// and no delivery starts on an answer older than LEADER_FRESH_MS: a drain asks again before its
// next delivery once the last answer is that old, so a replica that lost the lock starts nothing
// new past that bound and only the deliveries it already had in flight (at most
// MAX_CONCURRENT_DRAINS per mailbox) finish beside the new leader's. The registrant's budgets,
// held per process, then hold across replicas. Every check is raced against a timeout: one that
// never answers (a lock session whose connection died) is "not leading" and a warning, never a
// scan that waits for good. The sweep never throws: the next scan sees the same evidence and tries
// again.

import type {
  ConsumeOutcome,
  DeliveryAdmission,
  DeliveryTicket,
  Hook,
  WebhookRegistration,
} from "./types.ts";
import { markDelivered, markDelivering, markFailed, planHookSweep } from "./hook_lifecycle.ts";
import type { HookStore } from "../ports/hook_store.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import { withDeadline } from "../helpers/deadline.ts";

/** How many hooks one queue delivers before it yields to the next queue in line. */
export const SWEEP_TURN = 16;

/** Where one mailbox's pass stops however much is left — a queue refilled as fast as it drains
 * would otherwise keep it going for good. Counts what a pass DID: a delivery (its claim) or a
 * reclaim — never a head that waits or that its registrant refused. The next pass carries on. */
export const MAX_DELIVERIES_PER_PASS = 1_000;

/** How many queues of one mailbox drain at once. Each mailbox has as many of its own. */
export const MAX_CONCURRENT_DRAINS = 8;

/** How old a "this process leads" answer may be when a delivery starts. Older, and the drain
 * asks again first — once per interval however many queues are draining, so the price is a
 * query every quarter-second while there is work, and nothing while idle. */
export const LEADER_FRESH_MS = 250;

/** How long a leadership check may take. One that has not answered by then is "not leading":
 * the scan carries on to its end and the next asks again, where waiting for an answer that never
 * comes would end every delivery in the process for good. */
export const LEADER_CHECK_TIMEOUT_MS = 5_000;

/** How long one store call of the sweep may take (`deadlineStore`): well inside TICK_STALL_MS,
 * with the leadership check and the prune's first call besides, so a database that stops
 * answering ends ticks with warnings rather than wedging them. Its queries are index probes and
 * single-row writes, and the prune a bounded batch; one this slow is not coming back. */
export const STORE_DEADLINE_MS = 10_000;

/** How long a queue whose head its registrant refused (`admitDelivery`) rests before it is asked
 * again, however often its mailbox is scanned: a scan follows every arrival into an idle mailbox,
 * and each refused head asked costs its row read. */
export const REFUSAL_REST_MS = 1_000;

export interface SweeperDeps {
  store: HookStore;
  diag: Diagnostics;
  now(): Date;
  /** Whether this process is the one that delivers, asked at each scan and again before any
   * delivery once the last answer is LEADER_FRESH_MS old: false, and it scans nothing, starts no
   * pass, and every running pass stops before its next delivery. For a host with several replicas
   * (a lock held across scans); absent, this process always delivers. */
  leader?: () => Promise<boolean>;
  /** Overrides LEADER_CHECK_TIMEOUT_MS — for tests. */
  leaderTimeoutMs?: number;
}

/** The drains of every mailbox in a process. */
export interface Drains {
  /** Reads which queues are due (keys only) and hands each to its mailbox's drain — starting a
   * pass, or joining the line of the one running. Does not wait for any delivery. */
  scan(): Promise<void>;
  /** A hook of (`registrationId`, `scope`) was just queued by this process. True when its
   * mailbox's running pass took it (or will run again for it); false when no pass is running —
   * the caller then scans (the host's kick). */
  arrived(registrationId: string, scope: string | null): boolean;
  /** Resolves once no mailbox has a pass running. */
  settled(): Promise<void>;
}

type Scope = string | null;

/** Scope order: by text, the unscoped queue last — the order a pass's line starts in. */
const byScope = (a: Scope, b: Scope) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0;

/** One pass of one mailbox. `queued` holds the queues in the line, `turning` those in a turn;
 * `stopped` the queues whose head waits (a retry clock, another replica's lease, a refusal),
 * which only a scan offers again; `nudged` the queues something arrived in during their
 * turn, which go back in line if the turn found them empty. */
interface Pass {
  line: Scope[];
  queued: Set<Scope>;
  turning: Set<Scope>;
  stopped: Set<Scope>;
  nudged: Set<Scope>;
  /** Each first-offered queue's position in this pass's line; the cursor moves to the furthest
   * one reached. A queue offered later joins at the back and leaves the cursor alone. */
  place: Map<Scope, number>;
  furthest: number;
  spent: number;
  truncated: boolean;
  active: number;
  workers: Promise<void>[];
}

/** One mailbox's drain. */
interface Lane {
  running: boolean;
  offer(scopes: readonly Scope[], from: "scan" | "arrival"): boolean;
  idle(): Promise<void>;
}

/** This process's leadership as the drains see it: the last answer, and the way to ask. */
interface Leadership {
  /** The last answer, however old. */
  readonly leading: boolean;
  /** Asks now — one question at a time, whoever asks meanwhile shares it. */
  ask(): Promise<boolean>;
  /** The last answer if it is under LEADER_FRESH_MS old, else `ask()`. */
  fresh(): Promise<boolean>;
}

function leadership(deps: SweeperDeps): Leadership {
  const leader = deps.leader;
  if (leader === undefined) {
    return { leading: true, ask: () => Promise.resolve(true), fresh: () => Promise.resolve(true) };
  }
  const timeoutMs = deps.leaderTimeoutMs ?? LEADER_CHECK_TIMEOUT_MS;
  let leading = false;
  // When the question behind `leading` was ASKED, not answered: the lock may have gone the moment
  // after, so an answer is only as fresh as its question.
  let askedAt = -Infinity;
  let asking: Promise<boolean> | null = null;
  const check = async (): Promise<boolean> => {
    const at = deps.now().getTime();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let answer: boolean;
    try {
      answer = await Promise.race([
        leader(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      ]).then((verdict) => {
        if (verdict !== "timeout") return verdict;
        deps.diag.warn("webhooks.leader_check_timed_out", { timeoutMs });
        return false;
      });
    } catch (err) {
      deps.diag.warn("webhooks.leader_check_failed", { err: String(err) });
      answer = false;
    } finally {
      clearTimeout(timer);
    }
    leading = answer;
    askedAt = at;
    return answer;
  };
  const ask = () => {
    asking ??= check().finally(() => {
      asking = null;
    });
    return asking;
  };
  return {
    get leading() {
      return leading;
    },
    ask,
    fresh: () =>
      deps.now().getTime() - askedAt < LEADER_FRESH_MS ? Promise.resolve(leading) : ask(),
  };
}

export function drains(
  deps: SweeperDeps,
  registrations: ReadonlyMap<string, WebhookRegistration>,
): Drains {
  const lanes = new Map<string, Lane>();
  const lead = leadership(deps);
  const laneOf = (id: string) => {
    let lane = lanes.get(id);
    if (lane === undefined) {
      lane = makeLane(deps, id, registrations, lead);
      lanes.set(id, lane);
    }
    return lane;
  };

  return {
    async scan() {
      // Asked afresh at every scan, the cached answer's age notwithstanding: the scan is what
      // lets a replica that lost the lock take it back.
      if (deps.leader !== undefined && !await lead.ask()) return;
      // A mailbox handed back keeps no drain once its pass is over.
      for (const [id, lane] of lanes) if (!registrations.has(id) && !lane.running) lanes.delete(id);
      if (registrations.size === 0) return;
      let due: Array<{ registrationId: string; scope: Scope }>;
      try {
        due = await deps.store.getDueQueues([...registrations.keys()], deps.now().toISOString());
      } catch (err) {
        deps.diag.warn("webhooks.sweep_failed", { err: String(err) });
        return;
      }
      const byLane = new Map<string, Scope[]>();
      for (const q of due) {
        const scopes = byLane.get(q.registrationId) ?? [];
        scopes.push(q.scope);
        byLane.set(q.registrationId, scopes);
      }
      for (const [id, scopes] of byLane) {
        // Unregistered between query and drain — waits.
        if (registrations.has(id)) laneOf(id).offer(scopes, "scan");
      }
    },
    arrived(registrationId, scope) {
      if (!lead.leading || !registrations.has(registrationId)) return false;
      return laneOf(registrationId).offer([scope], "arrival");
    },
    async settled() {
      while (true) {
        const busy = [...lanes.values()].filter((lane) => lane.running);
        if (busy.length === 0) return;
        await Promise.all(busy.map((lane) => lane.idle()));
      }
    },
  };
}

function makeLane(
  deps: SweeperDeps,
  id: string,
  registrations: ReadonlyMap<string, WebhookRegistration>,
  lead: Leadership,
): Lane {
  // Where the previous pass got to in its line, kept from pass to pass: the next starts after
  // it, wrapping round. Started from the top every time, the queues sorting first took every
  // pass for good while those sorting last were never reached.
  let cursor: { reached: Scope } | null = null;
  // When each queue its registrant last refused was refused: offered again once it has rested
  // REFUSAL_REST_MS, by whichever scan comes next. Kept across passes, since a mailbox whose every
  // head was refused ends its pass at once and the next scan starts another.
  const refused = new Map<Scope, number>();
  const resting = (scope: Scope, now: number) =>
    (refused.get(scope) ?? -Infinity) > now - REFUSAL_REST_MS;
  let pass: Pass | null = null;
  let running = false;
  // A pass was asked for while the running one was ending: one more runs after it, reading the
  // mailbox's due queues itself.
  let again = false;
  let waiters: Array<() => void> = [];

  const push = (p: Pass, scope: Scope) => {
    p.queued.add(scope);
    p.line.push(scope);
  };
  const spawn = (p: Pass) => {
    // A worker per queue waiting, up to the bound — one already running takes the next turn
    // when its own ends. Counted first: a worker takes its queue off the line before `push`
    // returns.
    for (let n = Math.min(MAX_CONCURRENT_DRAINS - p.active, p.line.length); n > 0; n--) {
      p.active++;
      p.workers.push(worker(p));
    }
  };
  const budget = (p: Pass) => ({
    // Before every claim: the pass's cap, then leadership no older than LEADER_FRESH_MS.
    async more() {
      if (p.spent < MAX_DELIVERIES_PER_PASS && await lead.fresh()) return true;
      p.truncated = true;
      return false;
    },
    spend() {
      p.spent++;
    },
  });

  const worker = async (p: Pass) => {
    try {
      while (p.line.length > 0) {
        const spend = budget(p);
        // Out of deliveries, or no longer the leader: the queue stays unreached, first in line
        // for the next pass.
        if (!await spend.more()) return;
        // Another worker may have emptied the line while this one asked.
        if (p.line.length === 0) return;
        const scope = p.line.shift()!;
        p.queued.delete(scope);
        p.turning.add(scope);
        const at = p.place.get(scope);
        if (at !== undefined && at > p.furthest) {
          p.furthest = at;
          cursor = { reached: scope };
        }
        let end: TurnEnd = "stopped";
        // Looked up per turn: a mailbox re-registered meanwhile drains with its new consumer, and
        // one handed back waits.
        const registration = registrations.get(id);
        if (registration !== undefined) {
          try {
            end = await takeTurn(deps, registration, scope, spend);
          } catch (err) {
            // A store outage mid-turn lands here; per-delivery failures never do.
            deps.diag.warn("webhooks.sweep_failed", {
              registrationId: id,
              scope,
              err: String(err),
            });
          }
        }
        p.turning.delete(scope);
        const nudged = p.nudged.delete(scope);
        if (end === "more" || (end === "empty" && nudged)) push(p, scope);
        else if (end === "stopped" || end === "refused") p.stopped.add(scope);
        if (end === "refused") refused.set(scope, deps.now().getTime());
        else refused.delete(scope);
      }
    } finally {
      p.active--;
    }
  };

  const drainPass = async (scopes: readonly Scope[]) => {
    const p: Pass = {
      line: [],
      queued: new Set(),
      turning: new Set(),
      stopped: new Set(),
      nudged: new Set(),
      place: new Map(),
      furthest: -1,
      spent: 0,
      truncated: false,
      active: 0,
      workers: [],
    };
    const now = deps.now().getTime();
    let ordered = [...new Set(scopes)].filter((scope) => !resting(scope, now)).sort(byScope);
    if (cursor !== null) {
      const after = cursor.reached;
      const from = ordered.findIndex((scope) => byScope(scope, after) > 0);
      if (from > 0) ordered = [...ordered.slice(from), ...ordered.slice(0, from)];
    }
    ordered.forEach((scope, i) => {
      p.place.set(scope, i);
      push(p, scope);
    });
    pass = p;
    spawn(p);
    // The list grows while it is awaited: a scan or an arrival may spawn.
    for (let i = 0; i < p.workers.length; i++) {
      await p.workers[i].catch((err) =>
        deps.diag.warn("webhooks.sweep_failed", { registrationId: id, err: String(err) })
      );
    }
    pass = null;
    if (p.truncated && p.spent >= MAX_DELIVERIES_PER_PASS) {
      deps.diag.warn("webhooks.sweep_truncated", {
        registrationId: id,
        cap: MAX_DELIVERIES_PER_PASS,
      });
    }
  };

  const run = async (first: readonly Scope[]) => {
    let scopes: readonly Scope[] | null = first;
    try {
      do {
        again = false;
        if (scopes === null) {
          try {
            scopes = (await deps.store.getDueQueues([id], deps.now().toISOString()))
              .map((q) => q.scope);
          } catch (err) {
            deps.diag.warn("webhooks.sweep_failed", { registrationId: id, err: String(err) });
            return;
          }
        }
        await drainPass(scopes);
        scopes = null;
      } while (again && lead.leading);
    } finally {
      running = false;
      again = false;
      const woken = waiters;
      waiters = [];
      for (const wake of woken) wake();
    }
  };

  return {
    get running() {
      return running;
    },
    offer(scopes, from) {
      if (from === "scan") {
        const now = deps.now().getTime();
        for (const [scope, at] of refused) if (at <= now - REFUSAL_REST_MS) refused.delete(scope);
      }
      if (!running) {
        // Only a scan starts a pass: a hook queued with none running is the host's to kick.
        if (from === "arrival") return false;
        running = true;
        void run(scopes);
        return true;
      }
      const p = pass;
      if (p === null || p.truncated) {
        again = true; // ending: the next pass reads what this one will not reach
        return true;
      }
      // A scan is a new round: a queue that stopped is offered again — once it is due (the scan
      // only names those) and, if refused, once it has rested.
      if (from === "scan") p.stopped.clear();
      const now = deps.now().getTime();
      for (const scope of scopes) {
        if (p.turning.has(scope)) p.nudged.add(scope);
        else if (!p.queued.has(scope) && !p.stopped.has(scope) && !resting(scope, now)) {
          push(p, scope);
        }
      }
      spawn(p);
      return true;
    },
    idle() {
      if (!running) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/** How a turn ended: the queue still has hooks to take (`more`), it is empty (`empty`), its
 * head waits — a retry clock, another replica's lease or claim — for the rest of the pass
 * (`stopped`), or its registrant cannot afford the head yet (`refused`). */
type TurnEnd = "more" | "empty" | "stopped" | "refused";

/** One turn of one queue — its registration's hooks of `scope` — of up to SWEEP_TURN hooks,
 * each claim and reclaim spent from the pass's budget (`pass`). */
async function takeTurn(
  deps: SweeperDeps,
  registration: WebhookRegistration,
  scope: string | null,
  pass: { more(): Promise<boolean>; spend(): void },
): Promise<TurnEnd> {
  const { store, diag } = deps;

  for (let taken = 0; taken < SWEEP_TURN; taken++) {
    if (!await pass.more()) return "more";
    // Read here, as the turn takes it, and again for each hook after: the scan only said the
    // queue was due, and a delivery may have consumed or re-clocked the head since.
    const head = await store.getHeadHook(registration.id, scope);
    if (head === null) return "empty"; // all that remains, if anything, is terminal

    const at = deps.now().toISOString();
    const action = planHookSweep(head, deps.now().getTime(), at);

    if (action.kind === "wait") return "stopped"; // in flight elsewhere, or a clock running

    if (action.kind === "reclaim") { // a deliverer died mid-flight; back to the queue
      pass.spend();
      // Conditional like every other contested write, fenced by the attempt count: between
      // reading the head and writing it back, another replica may have reclaimed, re-claimed
      // (attempts+1), or even delivered this hook — an unconditional write here would undo
      // that replica's progress, up to resurrecting a delivered hook into a duplicate
      // delivery. A lost reclaim means the row is someone else's now: leave the queue alone.
      if (!await store.saveHookIfState(action.hook, ["delivering"], head.attempts)) {
        diag.debug("webhooks.hook_reclaim_lost", { hookId: head.id });
        return "stopped";
      }
      diag.debug("webhooks.hook_reclaimed", { hookId: head.id });
      continue;
    }

    // Deliver — once the registrant says it can afford to (`admitDelivery`). Asked BEFORE the
    // claim, so a "not now" writes nothing: the head stays `pending` with the attempts it had,
    // and the queue rests until a scan after REFUSAL_REST_MS. Waiting on the budget is not a
    // failed delivery, and must not spend the retry budget a flood of other queues could
    // otherwise burn away — nor roll attempts back afterwards, which would undo the very fence
    // the claim below writes.
    const claim = markDelivering(head, at, registration.policy);
    if (claim.kind === "refused") return "stopped"; // e.g. a clock started since the plan
    let admission: DeliveryAdmission;
    try {
      admission = registration.admitDelivery?.(head) ?? { kind: "go" };
    } catch (err) {
      admission = { kind: "wait", reason: String(err) };
    }
    if (admission.kind === "wait") {
      diag.debug("webhooks.hook_admission_wait", { hookId: head.id, reason: admission.reason });
      return "refused";
    }
    pass.spend();
    const ticket = admission.ticket;
    let step: "next" | "stopped";
    try {
      step = await deliverClaimed(deps, registration, head, claim.hook, ticket);
    } finally {
      ticket?.release();
    }
    if (step === "stopped") return "stopped";
  }
  return "more"; // the turn is up; the queue goes to the back of the line
}

/**
 * One admitted head of `registration`'s queue, delivered: the claim (`claimed`, markDelivering's
 * copy) written, then the duplicate check or the consumer, then the verdict. `next` the queue may
 * go on to the hook behind it; `stopped` it may not, for this pass.
 */
async function deliverClaimed(
  deps: SweeperDeps,
  registration: WebhookRegistration,
  head: Hook,
  claimed: Hook,
  ticket: DeliveryTicket | undefined,
): Promise<"next" | "stopped"> {
  const { store, diag } = deps;
  // The lease only becomes real at the conditional write: `markDelivering` is pure and judged a
  // copy, so a concurrent sweep holding the same copy also got "applied" — the write decides
  // which of them delivers, and the loser leaves the head alone.
  //
  // Fenced by the attempt count like every other contested write. The state alone would not do
  // it: between this sweep's read and its write, another replica can claim the hook, fail it,
  // and hand it back — leaving the row `pending` again, so a stale claim would still match and
  // would silently clear the backoff clock the failure just set.
  if (!await store.saveHookIfState(claimed, [head.state], head.attempts)) {
    diag.debug("webhooks.hook_claim_lost", { hookId: head.id });
    return "stopped";
  }

  // Already taken under another hook (`WebhookRegistration.dedupeKey`): delivered as it stands,
  // and the consumer spends nothing on it. Asked under the claim, so the queue's order holds —
  // the earlier hook with this key was delivered before this one was reached, or it was not.
  // A key that cannot be computed is no key: the consumer judges the hook. The key read here
  // is the body's and only LOOKS UP; the duplicate writes none down, and the stored one it
  // matched was the consumer's confirmed word.
  let dedupeKey: string | null = null;
  try {
    dedupeKey = registration.dedupeKey?.(claimed) ?? null;
  } catch {
    dedupeKey = null;
  }
  if (
    dedupeKey !== null &&
    await store.hasDeliveredKey(registration.id, claimed.scope, dedupeKey)
  ) {
    const done = markDelivered(claimed, deps.now().toISOString());
    if (
      done.kind === "applied" &&
      !await store.saveHookIfState(done.hook, ["delivering"], claimed.attempts)
    ) {
      diag.debug("webhooks.hook_completion_lost", { hookId: head.id });
      return "stopped";
    }
    diag.debug("webhooks.hook_duplicate", { hookId: head.id, dedupeKey });
    return "next";
  }

  let outcome: ConsumeOutcome;
  try {
    outcome = await registration.consumer(claimed, ticket);
  } catch (err) {
    // A consumer that throws gets the retryable treatment: a crash says nothing about
    // whether the hook itself is deliverable.
    outcome = { kind: "failed", message: String(err), terminal: false };
  }

  // Completion writes are conditional too, fenced by THE ATTEMPT COUNT: a delivery that
  // outlived its lease finds the row reclaimed (and possibly re-claimed at attempts+1) by
  // another sweep, and its stale verdict must not overwrite the replica that owns it now.
  // A lost completion simply stops this drain — the row belongs to someone else.
  const doneAt = deps.now().toISOString();
  if (outcome.kind === "ok") {
    // Written down under what the consumer CONFIRMED the hook was about, never the body's key:
    // a sender who rang first with the name of something not yet there must not have the real
    // one dropped when it comes.
    const done = markDelivered(claimed, doneAt, outcome.dedupeKey ?? null);
    if (
      done.kind === "applied" &&
      !await store.saveHookIfState(done.hook, ["delivering"], claimed.attempts)
    ) {
      diag.debug("webhooks.hook_completion_lost", { hookId: head.id });
      return "stopped";
    }
    diag.debug("webhooks.hook_delivered", { hookId: head.id, attempts: claimed.attempts });
    return "next";
  }

  const failed = markFailed(claimed, outcome, doneAt, registration.policy);
  if (
    failed.kind === "applied" &&
    !await store.saveHookIfState(failed.hook, ["delivering"], claimed.attempts)
  ) {
    diag.debug("webhooks.hook_completion_lost", { hookId: head.id });
    return "stopped";
  }
  diag.warn("webhooks.hook_delivery_failed", {
    hookId: head.id,
    attempts: claimed.attempts,
    terminal: outcome.terminal,
    exhausted: failed.kind === "applied" && failed.hook.state === "exhausted",
    message: outcome.message.slice(0, 500),
  });

  // An exhausted head no longer gates the queue — keep draining past it. A retrying one
  // does: FIFO means everything behind it in THIS queue waits for its clock. Other scopes of
  // the same registration are other queues, drained by other workers, and do not wait.
  return failed.kind === "applied" && failed.hook.state === "exhausted" ? "next" : "stopped";
}

/** How many terminal hooks one sweep deletes per registration at most: a backlog of old rows
 * clears over a few ticks rather than in one long statement. */
const PRUNE_BATCH = 500;

/**
 * Retention: deletes the terminal hooks of every registration with a `retainTerminalMs` once
 * they are older than it — a mailbox anyone holding a credential can fill must not grow
 * forever. Bounded per registration and per sweep, and never throws: a failed prune is the
 * next sweep's — and so is every registration after it, since the database that failed one is
 * the one the rest would wait on, each to its deadline.
 */
export async function pruneTerminalHooks(
  deps: SweeperDeps,
  registrations: ReadonlyMap<string, WebhookRegistration>,
): Promise<void> {
  for (const registration of registrations.values()) {
    if (registration.retainTerminalMs === undefined) continue;
    const before = new Date(deps.now().getTime() - registration.retainTerminalMs).toISOString();
    try {
      const pruned = await deps.store.deleteTerminalHooks(registration.id, before, PRUNE_BATCH);
      if (pruned > 0) {
        deps.diag.debug("webhooks.pruned", { registrationId: registration.id, pruned });
      }
    } catch (err) {
      deps.diag.warn("webhooks.prune_failed", {
        registrationId: registration.id,
        err: String(err),
      });
      return;
    }
  }
}

/** `store` with every call bounded by `ms` (`withDeadline`) — what the sweep runs on. A partition
 * drops packets and closes nothing, so a query on a dead connection neither answers nor fails
 * until the kernel gives the socket up, a quarter of an hour of TCP retransmissions later; a tick
 * stuck that long holds every scan behind it, and a pass every delivery of its mailbox.
 *
 * A write that times out may still land. Every write the sweep makes is a conditional one fenced
 * by the attempt count, so a late claim is a lease that runs out and is reclaimed, and a late
 * completion one that a reclaim already overtook does nothing — the same as a deliverer that died
 * mid-flight, which the lifecycle already answers with at-least-once delivery. */
export function deadlineStore(store: HookStore, ms: number): HookStore {
  const bound =
    <A extends unknown[], R>(name: string, call: (...args: A) => Promise<R>) => (...args: A) =>
      withDeadline(call(...args), ms, `hook store ${name}`);
  return {
    recordHook: bound("recordHook", (hook) => store.recordHook(hook)),
    getHook: bound("getHook", (id) => store.getHook(id)),
    getHeadHook: bound("getHeadHook", (id, scope) => store.getHeadHook(id, scope)),
    getDueQueues: bound("getDueQueues", (ids, dueAt) => store.getDueQueues(ids, dueAt)),
    saveHook: bound("saveHook", (hook) => store.saveHook(hook)),
    hasDeliveredKey: bound(
      "hasDeliveredKey",
      (id, scope, key) => store.hasDeliveredKey(id, scope, key),
    ),
    saveHookIfState: bound(
      "saveHookIfState",
      (hook, expected, attempts) => store.saveHookIfState(hook, expected, attempts),
    ),
    deleteTerminalHooks: bound(
      "deleteTerminalHooks",
      (id, before, limit) => store.deleteTerminalHooks(id, before, limit),
    ),
    deleteHooksForRegistration: bound(
      "deleteHooksForRegistration",
      (id) => store.deleteHooksForRegistration(id),
    ),
  };
}

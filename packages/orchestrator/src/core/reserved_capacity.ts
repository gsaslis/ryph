// Reserved capacity: warm room on the cluster for each size class, so a run or a check pod lands
// on a node that already exists instead of waiting minutes for one to be made.
//
// An admin saves a number of SLOTS per class; this module turns the saved row into a plan and
// hands it to the provisioner's optional `capacity` (ports/provisioner.ts), which holds that many
// evictable placeholders per class. Only kubernetes has the capability; a deployment without it
// has no reconciler at all, and the API says so.
//
// Invariants:
// - the setting is a NUMBER per class, never a shape. The shape is the class's, from
//   `RYPH_RUN_SIZES`, plus room for the most services the deployment lets a run add
//   (`ServiceRoom`), so a placeholder cannot drift from the runs it reserves for and is never too
//   small to be evicted for one of them
// - one replica applies: the one holding the backend's lease (`CapacityReserver.lease`), under
//   @ryph/service's `makeLease` and renewed on every pass it makes. In a rollout the old
//   configuration and the new one would otherwise take turns undoing each other, restarting every
//   placeholder each time. Whoever holds it keeps it until it exits; then another takes it over at
//   its next pass, or, if the exit was not clean, once it has seen the lease unchanged for the
//   hold by its OWN monotonic clock. No replica compares its clock with another's, so skew between
//   them cannot make two holders, and no wall clock times anything, so neither can an NTP step
// - a holder writes only while the lease says it holds (`held`), which stops at its renew
//   deadline, a third of the hold before anyone else may take over: the margin a write already
//   sent has to land in
// - every pass states the whole desired state, every configured class included at 0, so a pass
//   run twice, or by a new holder over an old one's work, converges on the same thing
// - a save reaches the holder whichever replica served it: the holder reads the row on every
//   tick, and a row that moved since its last pass is owed one
// - a failed pass is a log line and a retry at the next interval. The run path never notices:
//   at worst a run waits for a node the way it did before this existed
// - a class the configuration no longer defines is ignored here and dropped on the next save

import { type LeaseTimings, makeLease } from "@ryph/service";
import type { Diagnostics } from "../ports/diagnostics.ts";
import type { CapacityReserver, Reservation, ReservationStatus } from "../ports/provisioner.ts";
import type { RunSize, RunSizes } from "./run_sizes.ts";
import type { ServiceRoom } from "./services.ts";

/** Per class. Twenty idle machines of the largest class is already a judgement call. */
export const MAX_RESERVED_SLOTS = 20;

/** The saved setting: one row, read whole. A class missing from `slots` is 0. */
export interface ReservedCapacity {
  slots: Record<string, number>;
  updatedAt: string;
  /** The admin who last moved it; null for break-glass, which has no identity to record. */
  updatedBy: string | null;
}

/**
 * Whether a placeholder of this class would fit the pods it reserves for. Only a class that sets
 * cpu, memory and ephemeral storage does: where it leaves one unset, the cluster (Autopilot, or a
 * LimitRange) gives each container its default for it, and the placeholder is one container while
 * a run or check pod of the class is several, so the pod would outgrow its slot and evicting the
 * placeholder would not make room for it.
 */
export function reservable(size: RunSize): boolean {
  return size.cpu !== null && size.memory !== null && size.ephemeralStorage !== null;
}

/**
 * The slots one class holds in a map, or 0. Own keys only: a class may be named `constructor`, and
 * a plain lookup would hand back Object.prototype's function for it.
 */
export function slotsOf(slots: Record<string, number>, sizeClass: string): number {
  return Object.hasOwn(slots, sizeClass) ? slots[sizeClass] : 0;
}

/** Every configured class, in configured order, with what the row says (or 0). */
export function planReservations(
  sizes: RunSizes,
  saved: ReservedCapacity | null,
): Reservation[] {
  return sizes.classes.map((size) => ({
    size,
    slots: reservable(size) && saved !== null ? slotsOf(saved.slots, size.name) : 0,
  }));
}

/**
 * Why these slots may not be saved, or null when they may. The schema has already bounded each
 * number; what is left is what only the configuration knows.
 */
export function reservedCapacityRefusal(
  sizes: RunSizes,
  slots: Record<string, number>,
): string | null {
  for (const [name, count] of Object.entries(slots)) {
    const size = sizes.classes.find((c) => c.name === name);
    if (size === undefined) return `RYPH_RUN_SIZES defines no class "${name}"`;
    if (count > 0 && !reservable(size)) {
      return `size class "${name}" leaves cpu, memory or ephemeral-storage unset, so its pods ` +
        "can outgrow a slot; set all three in RYPH_RUN_SIZES to reserve it";
    }
  }
  return null;
}

export interface CapacityReconciler {
  /** One pass when owed or due; otherwise nothing. Never throws. */
  tick(): Promise<void>;
  /**
   * Stops passing and gives the lease up, so another replica takes over at its next pass rather
   * than when the lease expires. Bounded, and never throws: it runs during shutdown.
   */
  stop(): Promise<void>;
  /** What the backend holds now. Throws when the backend cannot be asked. */
  status(): Promise<ReservationStatus[]>;
  /** How many services one slot of this class holds room for, on top of the class. */
  servicesHeld(size: RunSize): number;
}

/** The shortest hold, whatever the interval: well past a reaper tick or two of slack. */
const MIN_HOLD_SECONDS = 60;

/** How long `stop` waits for a pass in flight and the release before it gives up on both. */
const STOP_TIMEOUT_MS = 5_000;

/**
 * How long a hold lasts, from the cadence passes really run at: three of them, and at least
 * MIN_HOLD_SECONDS. A pass runs only on a tick, so that cadence is the reconcile interval or the
 * tick's own, whichever is longer; a hold sized from the interval alone lapses between renewals
 * once the tick is the slower.
 */
export function holdSeconds(intervalMs: number, tickMs: number): number {
  return Math.max(MIN_HOLD_SECONDS, Math.ceil((3 * Math.max(intervalMs, tickMs)) / 1000));
}

/**
 * The lease's timings from the cadence. The hold is the duration another replica waits, by its
 * own clock, after it last saw the lease change. The holder stops writing at two thirds of it
 * since its last renewal began, so it keeps the lease through one failed renewal, and the last
 * third (20 s at the least) is the margin for a write sent just before that: twice the capacity
 * client's request timeout (adapters/provisioner/kubernetes.ts). A holder that dies without
 * `stop` is taken over within the hold plus a cadence or two.
 */
export function leaseTimings(intervalMs: number, tickMs: number): LeaseTimings {
  const durationMs = holdSeconds(intervalMs, tickMs) * 1000;
  return {
    durationMs,
    renewDeadlineMs: Math.floor((durationMs * 2) / 3),
    // Unused here (passes drive the lease, not its own loop), but it orders the other two.
    retryMs: Math.max(intervalMs, tickMs),
  };
}

export function makeCapacityReconciler(deps: {
  store: { getReservedCapacity(): Promise<ReservedCapacity | null> };
  reserver: CapacityReserver;
  runSizes: RunSizes;
  /** The agent image (RYPH_AGENT_IMAGE): what a placeholder runs, and so pre-pulls. */
  image: string;
  /** The service policy's room (`serviceRoom`): what each slot holds beyond its class. */
  services: ServiceRoom;
  diag: Diagnostics;
  /** The wall clock: only for the renewal time the lease records for an operator. */
  now(): Date;
  /**
   * What the lease and the cadence are timed on, in ms. Monotonic, so an NTP step cannot move a
   * holder's deadline; defaults to `performance.now()`.
   */
  monotonicMs?: () => number;
  /**
   * How often a pass runs with nothing owed: how often the holder renews, how often another
   * replica asks whether it may take over, and the backstop for a placeholder deleted by hand.
   */
  intervalMs: number;
  /**
   * How often `tick` is called (the reaper's interval): no pass runs more often, so the lease is
   * timed from it too.
   */
  tickMs: number;
}): CapacityReconciler {
  const elapsed = deps.monotonicMs ?? (() => performance.now());
  const lease = makeLease({
    store: deps.reserver.lease,
    identity: deps.reserver.identity,
    now: deps.now,
    monotonicMs: deps.monotonicMs,
    timings: leaseTimings(deps.intervalMs, deps.tickMs),
    // The lease logs a failed attempt or release at debug, which is right for a loop that retries
    // every two seconds; here an attempt is a pass, so it is what a down API server looks like.
    diag: {
      debug: (event, data) => {
        if (event === "lease.attempt_failed") deps.diag.warn("capacity.lease_failed", data);
        else if (event === "lease.release_failed") deps.diag.warn("capacity.release_failed", data);
        else deps.diag.debug(`capacity.${event}`, data);
      },
      warn: (event, data) => deps.diag.warn(`capacity.${event}`, data),
    },
  });
  let lastAttempt: number | null = null;
  // The row as the last pass read it, whole: `updatedAt` alone would miss two saves landing in
  // one millisecond. Undefined until a pass has read it.
  let seen: string | undefined = undefined;
  const key = (row: ReservedCapacity | null) => JSON.stringify(row);
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const pass = async (row: ReservedCapacity | null | undefined): Promise<void> => {
    try {
      // `stop` may have released while this tick read the row; taking the lease now would keep it
      // for an exiting process until it expires. (A released lease is never retaken anyway.)
      if (stopped) return;
      // Takes the lease, renews it, or watches someone else's; never throws.
      await lease.tick();
      if (!lease.held() || stopped) return;
      // On a due pass the row is read here, after the lease is had; on a holder's save-triggered
      // pass the tick read it just before. Either way `seen` is what this pass applies, and a
      // save landing after that read moves the row again and is owed the next tick.
      const saved = row === undefined ? await deps.store.getReservedCapacity() : row;
      seen = key(saved);
      await deps.reserver.apply({
        image: deps.image,
        services: deps.services,
        reservations: planReservations(deps.runSizes, saved),
        held: lease.held,
      });
    } catch (err) {
      // The API server down, a 403, a timeout: the next interval tries again.
      deps.diag.warn("capacity.reconcile_failed", { err: String(err) });
    }
  };

  const tickBody = async (): Promise<void> => {
    const now = elapsed();
    // Due from boot: a deploy that moves RYPH_AGENT_IMAGE, RYPH_RUN_SIZES or the service
    // policy moves the placeholders with it on the first pass it holds, not an interval later.
    const due = lastAttempt === null || now - lastAttempt >= deps.intervalMs;
    let row: ReservedCapacity | null | undefined = undefined;
    if (!due) {
      // Only the holder reads a moved row every tick; every other replica asks the backend once
      // an interval, and that is all.
      if (!lease.held()) return;
      try {
        row = await deps.store.getReservedCapacity();
      } catch {
        // Quietly: a store that stays down fails the next due pass, which logs it.
        return;
      }
      if (key(row) === seen) return;
    }
    lastAttempt = now;
    await pass(row);
  };

  return {
    tick() {
      if (stopped) return Promise.resolve();
      // The whole tick is in flight, the row read included, so `stop` waits for all of it before
      // it releases; a tick already running is joined, not doubled.
      if (inFlight === null) inFlight = tickBody().finally(() => (inFlight = null));
      return inFlight;
    },

    async stop() {
      stopped = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A tick in flight may be renewing the lease right now; give it up after that. A release
        // that fails is logged by the lease, and the lease then expires on its own.
        await Promise.race([
          inFlight?.then(lease.release) ?? lease.release(),
          new Promise<void>((resolve) => (timer = setTimeout(resolve, STOP_TIMEOUT_MS))),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },

    status: () => deps.reserver.status(),

    servicesHeld: (size) => deps.reserver.servicesHeld(size, deps.services),
  };
}

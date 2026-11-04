// A hosting lease with no clock and no store: one slot that one gateway holds at a time, handed to
// the next waiter when released, and losable on cue. What hosting is tested against — the rules of
// taking, renewing and expiring a real lease are @ryph/service's, pinned in its lease_test.ts.

import type { HostingLease } from "../src/core/lease.ts";

export interface FakeLease extends HostingLease {
  /** The lease goes to nobody behind this process's back, as an expiry would. */
  lose(): void;
}

export interface LeaseSlot {
  /** Who holds it now. */
  holder(): string | null;
  leaseFor(identity: string): FakeLease;
}

export function leaseSlot(): LeaseSlot {
  let holder: string | null = null;
  const waiters = new Set<() => void>();
  const handOver = () => {
    for (const wake of [...waiters]) wake();
  };

  return {
    holder: () => holder,
    leaseFor(identity) {
      let lost: (() => void) | null = null;
      return {
        identity,
        held: () => holder === identity,
        acquire(signal) {
          return new Promise<void>((resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            const wake = () => {
              if (holder !== null) return;
              holder = identity;
              waiters.delete(wake);
              resolve();
            };
            waiters.add(wake);
            signal.addEventListener("abort", () => {
              if (waiters.delete(wake)) reject(signal.reason);
            }, { once: true });
            wake();
          });
        },
        keep(signal) {
          return new Promise<"lost" | "stopped">((resolve) => {
            if (signal.aborted) {
              resolve("stopped");
              return;
            }
            lost = () => resolve("lost");
            signal.addEventListener("abort", () => resolve("stopped"), { once: true });
          });
        },
        release() {
          if (holder === identity) {
            holder = null;
            handOver();
          }
          return Promise.resolve();
        },
        lose() {
          if (holder === identity) {
            holder = null;
            handOver();
          }
          lost?.();
        },
      };
    },
  };
}

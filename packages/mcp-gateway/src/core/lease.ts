// Who may launch and stop hosted servers: the one gateway process holding the hosting lease.
//
// WHY IT EXISTS. Hosting acts on stable names — `ryph-tool-<launch key>`, the guard's
// `ryph-tool-guard` — so that a restarted gateway finds what it launched: a launch replaces
// whatever holds the name, and a shutdown removes by it. That is sound for one process at a time,
// and Kubernetes does not give one. A rolling update starts the new pod before it stops the old,
// and an eviction (a node upgrade, which Autopilot schedules on its own) creates the replacement
// the moment the old pod starts terminating. In one such rollout the departing gateway's
// shutdown deleted the Grafana Deployment and the guard the arriving one had launched nine seconds
// earlier — the audit log's caller IPs say which pod — and the row sat in `starting` until its
// startup window closed.
//
// The rules — taking, renewing, expiring by this process's own clock, releasing — are
// @ryph/service's `makeLease`, shared with the control plane's reserved capacity. What is here is
// the gateway's name for it and the lease of a gateway that is alone by construction.
//
// What a lease cannot do is fence the API server: a request the old holder sent just before its
// deadline can still land after the new holder's first. The margin makes that unlikely rather than
// impossible, and the Kubernetes tool host deletes by uid for the case that would hurt — a stop
// removing a successor's server of the same name.

import type { LeaseHolder } from "@ryph/service";

/** The hosting lease: whether this gateway may launch or stop anything right now. */
export type HostingLease = LeaseHolder;

/**
 * The lease of a process that is the only gateway by construction — compose, the single binary,
 * anything on a local container runtime. Always held; nothing to wait for and nothing to give up.
 */
export const SOLE_GATEWAY: HostingLease = {
  identity: "sole",
  held: () => true,
  acquire: () => Promise.resolve(),
  keep: (signal) =>
    new Promise<"lost" | "stopped">((resolve) => {
      if (signal.aborted) {
        resolve("stopped");
        return;
      }
      signal.addEventListener("abort", () => resolve("stopped"), { once: true });
    }),
  release: () => Promise.resolve(),
};

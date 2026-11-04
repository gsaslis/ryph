// The no-op stand-ins for a run with no control plane — the CLI contract (`--work-item`).
// Nothing is reported upstream: progress is dropped and every result is confirmed delivered
// (the gateway is report-only); the inbox is empty forever, so the run ends when the agent
// finishes or its clock runs out; a patch ships unreported, and the result names its branch;
// and nothing builds a patch's environment.

import type { OrchestratorGateway } from "../../ports/orchestrator_gateway.ts";
import type { Inbox } from "../../ports/inbox.ts";
import { ChangeRequestRefused, type PatchReporter } from "../../ports/patch_reporter.ts";
import type { EnvironmentStatus } from "../../ports/environment_status.ts";

export function noopOrchestratorGateway(): OrchestratorGateway {
  return {
    reportProgress(): void {},
    reportStaleMemories(): void {},
    reportStaleBases(): void {},
    reportSetupFailures(): Promise<void> {
      return Promise.resolve();
    },
    reportSkills(): void {},
    reportResult(): Promise<void> {
      return Promise.resolve();
    },
  };
}

/** An inbox nobody writes to: every poll waits out its window (or the signal) and answers
 * nothing — the long-poll shape, so the core's loop behaves as it would against a quiet run. */
export function noopInbox(): Inbox {
  return {
    poll(_after, { waitMs, signal }) {
      return new Promise((resolve) => {
        if (signal.aborted) return resolve([]);
        const timer = setTimeout(done, waitMs);
        signal.addEventListener("abort", done, { once: true });
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve([]);
        }
      });
    },
  };
}

/** A reporter with nobody to report to: the patch is "local", and the agent is told so. */
export function noopPatchReporter(): PatchReporter {
  return {
    reportPatch() {
      return Promise.resolve({ patchId: "local", state: "unreported", url: null });
    },
    claimChangeRequest() {
      // Nothing holds the task this run came from, so nothing can re-target it — and a swap
      // that moved the checkout anyway would ship the next patch as a brand new pull request.
      return Promise.reject(new ChangeRequestRefused("this run has no platform behind it"));
    },
  };
}

/** Nobody builds anything for a run with no control plane, and the agent is told so. */
export function noopEnvironmentStatus(): EnvironmentStatus {
  return {
    read() {
      return Promise.resolve(
        "This run has no platform behind it, so nothing builds its patches' environments.",
      );
    },
  };
}

// The HTTP `RunnerControl`: POSTs a cancel to the runner's inbound endpoint.
// Strictly best-effort — a timeout or refusal returns false and the reaper escalates later.
//
// The address is the provisioner's, never the run's: the run is untrusted, and this request
// leaves the control plane with the run's control token on it. A redirect is not followed for
// the same reason — the runner's endpoint answers 202 and has nothing to redirect to, so a 3xx
// is something else answering, and following it would let that something send the control
// plane anywhere.

import type { Provisioner } from "../../ports/provisioner.ts";
import type { RunnerControl } from "../../ports/runner_control.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";

export function httpRunnerControl(
  provisioner: Pick<Provisioner, "controlUrl">,
  diag: Diagnostics,
  timeoutMs = 5_000,
): RunnerControl {
  return {
    async requestCancel(run) {
      if (run.handle === null || provisioner.controlUrl === undefined) return false;
      const cancelUrl = provisioner.controlUrl({ id: run.id, handle: run.handle });
      if (cancelUrl === null) return false;
      try {
        const res = await fetch(cancelUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${run.controlToken}` },
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        await res.body?.cancel();
        // `redirect: "manual"` hands back the 3xx itself, which `ok` already counts as a refusal.
        if (!res.ok) diag.warn("runner_control.cancel_refused", { cancelUrl, status: res.status });
        return res.ok;
      } catch (err) {
        diag.warn("runner_control.cancel_unreachable", { cancelUrl, err: String(err) });
        return false;
      }
    },
  };
}

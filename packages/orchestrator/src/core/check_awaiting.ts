// Which check verdicts a run is still owed: what a run's runner reads to know whether to hold
// the agent's stop for a message (`GET /v1/runs/:id/checks?awaiting=1`).
//
// A verdict is owed for every suite the run's own requests (its `ryph__run_checks`, and the
// patches it submitted) will be told about and have not been yet: a request still being read,
// a suite still going, or a settled generation whose message is not in the inbox yet. The list
// empties only once every such message is in (core/checks.ts marks a request told after the
// post), so a runner that reads it empty and then drains its inbox has seen them all.
//
// Suites, not requests: a tool request and a patch request of one run on one head are told in
// one message, so they are owed once. Each is named, not counted: a runner that stopped waiting
// for a suite that never reported keeps waiting for the ones asked for after it, and only those
// (packages/runner/src/core/conversation.ts).

import type { CheckStore } from "../ports/check_store.ts";
import { TERMINAL_SUITE_STATES } from "./check_types.ts";

/** One verdict a run is still owed. */
export interface OwedVerdict {
  /** Which: `<suite id>@<generation>` for a suite's generation, the request's own id while it
   * is still being read. Opaque to the runner, which only compares it. */
  id: string;
  /** The run's requests that are owed it: a pending request's own id, or every request of the
   * run on the suite. A request keeps its id from pending to active, and across a re-run. */
  requests: string[];
}

export async function checksAwaiting(
  store: Pick<CheckStore, "listRequestsForRun" | "listSuitesByIds">,
  runId: string,
): Promise<OwedVerdict[]> {
  const requests = (await store.listRequestsForRun(runId)).filter((r) =>
    r.kind === "tool" || r.kind === "patch"
  );
  const owed: OwedVerdict[] = [];
  const bySuite = new Map<string, { told: number; requests: string[] }>();
  for (const request of requests) {
    if (request.state === "pending") owed.push({ id: request.id, requests: [request.id] });
    else if (request.state === "active" && request.suiteId !== null) {
      const told = request.reportedGeneration ?? 0;
      const seen = bySuite.get(request.suiteId);
      if (seen === undefined) bySuite.set(request.suiteId, { told, requests: [request.id] });
      else {
        seen.told = Math.max(seen.told, told);
        seen.requests.push(request.id);
      }
    }
  }
  if (bySuite.size === 0) return owed;
  for (const suite of await store.listSuitesByIds([...bySuite.keys()])) {
    const asked = bySuite.get(suite.id)!;
    if (!TERMINAL_SUITE_STATES.has(suite.state) || asked.told < suite.generation) {
      owed.push({ id: `${suite.id}@${suite.generation}`, requests: asked.requests });
    }
  }
  return owed;
}

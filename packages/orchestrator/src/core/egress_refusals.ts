// What the control plane does with a host the egress proxy refused.
//
// The proxy is the only process that sees a refusal, and until this existed it was also the only
// one that heard about it: `egress: refused {"runId":…,"host":"dl.deno.land"}` in a pod's stderr,
// in a namespace most of the people this platform is for cannot reach. The run learned nothing —
// a `mise` that cannot fetch a Deno release says `tunnel error: unsuccessful` and stops — and a
// BUILD learned less than nothing, because a build that is refused a host still settles `ready`
// and ships an image missing whatever that host was for.
//
// So a refusal now travels, and this is where it lands. One report is one host and one port,
// because that is all a CONNECT line gives the proxy and all anybody needs: the bundle that
// would cover it is a lookup in the catalogue (core/egress.ts), done wherever the fact is READ
// rather than stored beside it, so a catalogue that grows a bundle re-explains yesterday's
// refusals too.
//
// Invariants:
// - a claim names ONE subject — a run or a build — and which it is, is a lookup, never a prefix
//   read off the id. The run is tried first because that is the common case
// - the trail and the record are written together or not at all: `recorded` is the only outcome
//   that appends an event, so a retried report cannot fill a run's trail with one host
// - a subject that has ended is dropped, and the caller is told so. That answer is what stops a
//   loop reporting at a run nobody can act on any more
// - NO INBOX MESSAGE. A refusal is not worth interrupting a working agent with mid-thought;
//   the run's events and its failure summary are where a person and an agent both find it

import type { EnvironmentStore } from "../ports/environment_store.ts";
import type { TaskStore } from "../ports/task_store.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import { type EgressRefusal, egressRefusalDetail, type EgressRefusalOutcome } from "./egress.ts";

/** One refusal as the proxy reports it. Host and port, and deliberately nothing else. */
export interface EgressRefusalReport {
  host: string;
  port: number;
}

export interface EgressRefusalRecorder {
  /** `subjectId` is the id inside the claim the proxy verified — never a body field. */
  record(subjectId: string, report: EgressRefusalReport): Promise<EgressRefusalOutcome>;
}

export function makeEgressRefusalRecorder(deps: {
  store: TaskStore;
  /** Null where environment builds are off: no build can be a subject, so a report that is not
   * a run's is simply over. */
  environments: EnvironmentStore | null;
  diag: Diagnostics;
  now(): Date;
}): EgressRefusalRecorder {
  const { store, environments, diag } = deps;
  return {
    async record(subjectId, report) {
      const at = deps.now().toISOString();
      const refusal: EgressRefusal = { host: report.host, port: report.port, at };
      const run = await store.recordRunEgressRefusal(subjectId, refusal);
      if (run === "recorded") {
        // The event AFTER the record, and only on `recorded`: the store's append is what
        // decides a report is new, so a retry that lost the race writes no second line.
        await store.appendEvent({
          runId: subjectId,
          at,
          kind: "egress.refused",
          detail: egressRefusalDetail(refusal),
        });
        diag.debug("egress.refusal_recorded", { runId: subjectId, host: refusal.host });
        return "recorded";
      }
      if (run === "duplicate") return "duplicate";
      // `ended` from the run store covers both "terminal" and "no such run", and a build's id
      // is the second. One extra read on a path that runs a handful of times per build is the
      // whole cost of not reading a subject's kind off the shape of its id.
      if (environments === null) return "ended";
      const build = await environments.recordEnvironmentEgressRefusal(subjectId, refusal);
      if (build === "recorded") {
        diag.debug("egress.refusal_recorded", { environmentId: subjectId, host: refusal.host });
      }
      return build;
    },
  };
}

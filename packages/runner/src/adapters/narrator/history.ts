// The narrator leg of the history emitter: every transcript chunk becomes a history event.
// The Narrator port does not change — this is purely an adapter over the shared emitter,
// which owns batching, seq, and delivery (see adapters/history/emitter.ts).

import type { Narrator } from "../../ports/narrator.ts";
import type { HistoryEmitter } from "../history/emitter.ts";

/** A subagent lane's opening and the close of each stretch: what makes a lane listable and says
 * whether it is still running (core/subagents.ts). */
const LANE_LIFECYCLE: ReadonlySet<string> = new Set([
  "subagent.start",
  "subagent.resume",
  "subagent.end",
]);

export function historyNarrator(emitter: HistoryEmitter): Narrator {
  return {
    emit(_runId, chunk, lane) {
      // The emitter is bound to its run; the runner narrates no other.
      return emitter.emit({
        voice: "transcript",
        kind: chunk.kind,
        text: chunk.text,
        payload: chunk.raw,
        ...(lane === undefined || lane === "" ? {} : { lane }),
        // A `final` mark is a claim about another event, and the core may narrate a second one
        // that takes the first back (see core/run.ts). Dropped on overflow, the retraction never
        // arrives and a reader folds away a message on the strength of a mark that was meant to
        // be withdrawn — so a mark is queued past the cap. One tiny row, at most twice a run.
        // A lane's start, resume and end are kept for the same reason: a lane whose end was
        // dropped reads as running for good, and one whose start was dropped is never listed.
        keep: chunk.kind === "final" || LANE_LIFECYCLE.has(chunk.kind),
      });
    },
  };
}

/** Fans one narration out to several narrators, each leg guarded — one broken leg mutes only itself. */
export function teeNarrator(...narrators: Narrator[]): Narrator {
  return {
    emit(runId, chunk, lane) {
      // The first leg that kept a seq owns the answer: in practice exactly one leg records a
      // durable history, and a second one would be a second writer's seq space anyway.
      let seq: number | undefined;
      for (const narrator of narrators) {
        try {
          const recorded = narrator.emit(runId, chunk, lane);
          if (seq === undefined) seq = recorded;
        } catch {
          // The core wraps narration too, but a tee must not let one leg silence the others.
        }
      }
      return seq;
    },
  };
}

// Narrator test doubles. Collecting retains narration for assertion; Throwing always fails,
// standing in for a narrator that misbehaves without gating the run.

import type { TranscriptChunk } from "../../src/core/types.ts";
import type { Narrator } from "../../src/ports/narrator.ts";

/**
 * The seq the first narrated chunk lands at. Not zero on purpose: a seq is what a back-reference
 * between two events is made of, and a base of zero would let a chunk INDEX pass for one
 * undetected in any test that joins them.
 */
export const NARRATOR_SEQ_BASE = 1_000;

export interface CollectingNarrator extends Narrator {
  /** Each narration with the seq it was recorded at — what a real history narrator hands back. */
  readonly chunks: Array<{ runId: string; chunk: TranscriptChunk; seq: number }>;
}

export function collectingNarrator(): CollectingNarrator {
  const chunks: Array<{ runId: string; chunk: TranscriptChunk; seq: number }> = [];
  return {
    chunks,
    emit(runId, chunk) {
      // Monotonic, like the emitter's: the ONLY ordering a reader has between two events is
      // their seqs, so a double that answers undefined (or the same number twice) would let a
      // test pass while the property the app depends on — a later event wins — went untested.
      const seq = NARRATOR_SEQ_BASE + chunks.length;
      chunks.push({ runId, chunk, seq });
      return seq;
    },
  };
}

export function throwingNarrator(): Narrator {
  return {
    emit(): number | undefined {
      throw new Error("narrator is down");
    },
  };
}

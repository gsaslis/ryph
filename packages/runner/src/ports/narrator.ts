import type { TranscriptChunk } from "../core/types.ts";

/**
 * Live narration out.
 *
 * Invariants:
 * - Strictly best-effort and off the critical path:
 *   the core wraps every call so a throwing or hanging narrator can neither fail nor slow a run.
 */
export interface Narrator {
  /**
   * Returns the history seq the chunk was recorded at, for a narrator that keeps a durable,
   * seq-ordered record — the handle a later event needs to refer back to this one. Undefined
   * from one that only prints, and from one that recorded nothing.
   *
   * `lane` names the transcript the chunk belongs to: absent or `""` for the run's own, a
   * subagent's id (`sa-<n>`) for that subagent's (core/subagents.ts). A seq is per lane, so a
   * seq handed back for one lane names nothing in another.
   */
  emit(runId: string, chunk: TranscriptChunk, lane?: string): number | undefined;
}

// What a merge contained, as pure decisions over a change request's merge record
// (`ChangeRequestMerge`). The forge's merge event names what merged by commit; the forge's repo
// cache answers which of ryph's pushed heads are inside it (`Forge.mergeContainment`); this file
// decides what each patch is told from that answer, or from the lack of one. core/merge_settle.ts
// applies it. docs/patch-lifecycle.md "Landing" has the story.
//
// The rule is git's, never inference: a patch merged when ANY head a merge of its change request
// named holds its head — as an ancestor, or its change is exactly a merged head's, both ways
// (ports/forge.ts `MergeContainmentOutcome`). Push order, timestamps, authorship and which patch
// carried which are never consulted.
//
// When the forge cannot answer, nothing is guessed. The question is asked again with a backoff,
// and the patches wait unsettled: nothing is pushed onto their change request meanwhile
// (core/reaper.ts holds back a push onto it). Only once the asks run out does every patch not
// proven merged settle `missed`, `unproven`. That direction loses nothing while its run is live: a
// missed patch's commits are moved onto what merged by the run's agent, and a later one that had
// merged after all meets an ordinary conflict in that rebase. A finished run's missed patch is
// flagged, not shipped. Settling unproven patches `merged` would skip their commits for good,
// which is the loss this file exists to prevent.

import type { MergeContainmentOutcome } from "../ports/forge.ts";
import type { ChangeRequestMerge, Patch } from "./types.ts";

/** Asks in all, the latest bringing no answer (the forge unreachable, failing, malformed, or
 * naming no merged head where the merge named none either), before the patches still waiting
 * settle `missed`: with `mergeAskBackoffMs`, about five hours. */
export const MERGE_ASKS_UNAVAILABLE = 16;
/** Asks in all, the latest refused, before the same: the forge says asking again changes nothing (the
 * upstream has none of the merged heads), so only a redelivery naming a head could still help,
 * and a few minutes is how long one takes. */
export const MERGE_ASKS_REFUSED = 3;

/** The most merged heads one containment question names, and the most heads it asks about: the
 * forge refuses a bigger one outright. */
export const MERGE_ASK_MERGED_HEADS = 20;
export const MERGE_ASK_HEADS = 500;

/**
 * What one containment question asks about a merge record: its newest merged heads, and the
 * patches owing a verdict whose heads fit — the never-judged first, each oldest first, so a
 * record with more owing settles over several sweeps and never asks the same ones twice. Pure.
 */
export function mergeAsk(
  merge: Pick<ChangeRequestMerge, "heads">,
  owing: readonly Patch[],
): { mergedHeads: string[]; asked: Patch[] } {
  const heads = new Set<string>();
  const asked: Patch[] = [];
  for (
    const p of [
      ...owing.filter((p) => p.landed === null),
      ...owing.filter((p) => p.landed !== null),
    ]
  ) {
    if (!heads.has(p.headSha)) {
      if (heads.size === MERGE_ASK_HEADS) continue;
      heads.add(p.headSha);
    }
    asked.push(p);
  }
  // The record keeps its heads newest first (`ChangeRequestMerge.heads`), so the bound drops only
  // the oldest: a record that named more than the forge reads is judged against its newest.
  return { mergedHeads: merge.heads.slice(0, MERGE_ASK_MERGED_HEADS), asked };
}

/** How long an ask holds its record before another sweep may ask again: a little past the forge
 * adapter's own timeout, so only a hung ask (or a process gone) is asked twice. */
export const MERGE_ASK_DEADLINE_MS = 150_000;

/** How long after the `attempts`-th ask that brought no answer the next one is made: 30 s,
 * doubling, at most 30 minutes. */
export function mergeAskBackoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, Math.min(attempts - 1, 20)), 30 * 60_000);
}

/** `heads` grown by `more`, each once, newest first: a delivery names its heads newest first (a
 * Radicle merge's newest merge first; GitHub names one), and one heard later names merges newer
 * than those recorded, so its new heads go before them. Answers null when nothing new was named. */
export function grownHeads(heads: readonly string[], more: readonly string[]): string[] | null {
  const added = [...new Set(more)].filter((h) => !heads.includes(h));
  return added.length === 0 ? null : [...added, ...heads];
}

/**
 * Whether the merge still owes `patch` a verdict: a submitted patch with none yet, always; and
 * while the record is unsettled (a merge heard, or its heads grown, since the last settle), one
 * closed before the change request was reopened and merged, or one judged `missed` against fewer
 * heads than the merge names now. A merged patch never owes one: merged is final.
 */
export function owesMergeVerdict(
  patch: Patch,
  merge: Pick<ChangeRequestMerge, "settledAt">,
): boolean {
  if (patch.state !== "submitted") return false;
  if (patch.landed === null) return true;
  return merge.settledAt === null && patch.landed.kind !== "merged";
}

/** Whether anything on the change request still waits on its merge's verdict. */
export function mergeVerdictPending(
  merge: Pick<ChangeRequestMerge, "settledAt">,
  patches: readonly Patch[],
): boolean {
  return merge.settledAt === null || patches.some((p) => owesMergeVerdict(p, merge));
}

/** One patch's verdict from its merge. */
export interface MergeVerdict {
  fate: "merged" | "missed";
  /** Settled `missed` because nobody could answer, not because git said so. */
  unproven: boolean;
}

export type MergeJudgement =
  /** Every asked patch has its verdict, by id. */
  | { kind: "judged"; verdicts: Map<string, MergeVerdict> }
  /** No answer this time, and asks remain: nothing is settled, and the record waits until
   * `nextAskAt`. */
  | { kind: "retry"; attempts: number; nextAskAt: string; lastError: string };

/**
 * What the patches owing a verdict are told, from what the forge answered (`outcome`) and the
 * asks before this one that brought none (`attempts`). An answer judges each by its head; a
 * refusal or no answer is asked again until the asks so far reach the limit of this one's kind,
 * and then every one of them is `missed`, unproven. Pure.
 */
export function judgeMerge(
  owing: readonly Patch[],
  outcome: MergeContainmentOutcome,
  attempts: number,
  at: string,
): MergeJudgement {
  if (outcome.kind === "answered") {
    const contained = new Set(outcome.contained);
    return {
      kind: "judged",
      verdicts: new Map(owing.map((p) => [p.id, {
        fate: contained.has(p.headSha) ? "merged" : "missed",
        unproven: false,
      }])),
    };
  }
  // One count for every ask, whatever it brought, so a forge that alternates between refusing
  // and failing still runs out: the limit is the one of the latest ask's kind.
  const asked = Math.max(0, attempts) + 1;
  const limit = outcome.kind === "refused" ? MERGE_ASKS_REFUSED : MERGE_ASKS_UNAVAILABLE;
  if (asked < limit) {
    return {
      kind: "retry",
      attempts: asked,
      nextAskAt: new Date(Date.parse(at) + mergeAskBackoffMs(asked)).toISOString(),
      lastError: outcome.message,
    };
  }
  return {
    kind: "judged",
    verdicts: new Map(
      owing.map((p) => [p.id, { fate: "missed", unproven: true }]),
    ),
  };
}

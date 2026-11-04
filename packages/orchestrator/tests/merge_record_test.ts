// What a merge contained, as pure decisions (core/merge_record.ts) and the verdicts they write
// (core/patch_lifecycle.ts `settlePatch`): git's answer judges each patch, no answer is asked
// again on a backoff and never guessed, and a verdict only ever moves toward more of the work
// having landed.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  grownHeads,
  judgeMerge,
  MERGE_ASK_HEADS,
  MERGE_ASK_MERGED_HEADS,
  MERGE_ASKS_REFUSED,
  MERGE_ASKS_UNAVAILABLE,
  mergeAsk,
  mergeAskBackoffMs,
  mergeVerdictPending,
  owesMergeVerdict,
} from "../src/core/merge_record.ts";
import {
  landedSiblingOf,
  landedVerdict,
  markSubmitted,
  markSubmitting,
  openPatch,
  patchFateForMemory,
  settlePatch,
} from "../src/core/patch_lifecycle.ts";
import type { Patch } from "../src/core/types.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";

function submitted(id: string, headSha: string, createdAt = T0): Patch {
  const born = openPatch(
    {
      id,
      connectedRepoId: "cr-1",
      runId: "r-1",
      taskId: "t-1",
      setId: `s-${id}`,
      path: "app",
      line: "work",
      branchName: "ryph/ada/r-1",
      headSha,
      bundleKey: `${id}.bundle`,
      baseSha: null,
      generation: 1,
      title: null,
      description: null,
      commits: [],
      carries: [],
      heldReason: null,
    },
    "auto",
    true,
    createdAt,
  ).patch;
  const taken = markSubmitting(born, createdAt);
  assert(taken.kind === "applied");
  const sent = markSubmitted(taken.patch, {
    ref: "7",
    url: "https://x/7",
    branch: "b",
    diffRef: "main",
  }, createdAt);
  assert(sent.kind === "applied");
  return sent.patch;
}

function settled(patch: Patch, fate: "merged" | "missed" | "closed", at = T1): Patch {
  const out = settlePatch(patch, fate, at, { mergedInto: "main" });
  assert(out.kind === "applied", out.kind === "refused" ? out.why : "");
  return out.patch;
}

test("an answer judges each patch by its head, and only an answer does", () => {
  const [a, b, c] = [
    submitted("p-a", "a".repeat(40)),
    submitted("p-b", "b".repeat(40)),
    submitted("p-c", "c".repeat(40)),
  ];
  const judged = judgeMerge(
    [a, b, c],
    {
      kind: "answered",
      contained: [a.headSha, c.headSha],
      missed: [b.headSha],
    },
    0,
    T0,
  );
  assert(judged.kind === "judged");
  assertEquals(judged.verdicts.get("p-a"), { fate: "merged", unproven: false });
  assertEquals(judged.verdicts.get("p-b"), { fate: "missed", unproven: false });
  assertEquals(judged.verdicts.get("p-c"), { fate: "merged", unproven: false });
  const merged = settlePatch(c, "merged", T1, { mergedInto: "main" });
  assert(merged.kind === "applied");
  assertEquals(merged.patch.landed, { kind: "merged", at: T1, mergedInto: "main" });

  // No answer: asked again later, nothing judged.
  const later = judgeMerge([a, b], { kind: "unavailable", message: "down" }, 0, T0);
  assertEquals(later, {
    kind: "retry",
    attempts: 1,
    nextAskAt: new Date(Date.parse(T0) + 30_000).toISOString(),
    lastError: "down",
  });
  // Until the asks run out: then every patch is missed, unproven — never merged.
  const spent = judgeMerge(
    [a, b],
    { kind: "unavailable", message: "down" },
    MERGE_ASKS_UNAVAILABLE - 1,
    T0,
  );
  assert(spent.kind === "judged");
  assertEquals([...spent.verdicts.values()], [
    { fate: "missed", unproven: true },
    { fate: "missed", unproven: true },
  ]);
  // A refusal says asking again changes nothing: it runs out sooner.
  assertEquals(
    judgeMerge([a], { kind: "refused", message: "no" }, MERGE_ASKS_REFUSED - 2, T0).kind,
    "retry",
  );
  assertEquals(
    judgeMerge([a], { kind: "refused", message: "no" }, MERGE_ASKS_REFUSED - 1, T0).kind,
    "judged",
  );
  // Every ask counts, whatever it brought; the latest one's kind picks the limit.
  const refusedAfterTimeouts = judgeMerge([a], { kind: "refused", message: "no" }, 5, T0);
  assert(refusedAfterTimeouts.kind === "judged");
  const downAfterRefusals = judgeMerge(
    [a],
    { kind: "unavailable", message: "down" },
    MERGE_ASKS_REFUSED - 1,
    T0,
  );
  assert(downAfterRefusals.kind === "retry");
  assertEquals(downAfterRefusals.attempts, MERGE_ASKS_REFUSED);
});

test("a forge alternating between refusing and failing still settles", () => {
  // Asks made, feeding each judgement's count to the next, until the patch is judged.
  const asksUntilJudged = (kinds: ("refused" | "unavailable")[]): number => {
    let attempts = 0;
    let at = T0;
    for (let asks = 1; asks <= 100; asks++) {
      const kind = kinds[(asks - 1) % kinds.length];
      const judged = judgeMerge([submitted("pa", "a")], { kind, message: kind }, attempts, at);
      if (judged.kind === "judged") {
        assertEquals([...judged.verdicts.values()], [
          { fate: "missed", unproven: true },
        ]);
        return asks;
      }
      attempts = judged.attempts;
      at = judged.nextAskAt;
    }
    throw new Error("never judged");
  };
  assertEquals(asksUntilJudged(["refused"]), MERGE_ASKS_REFUSED);
  assertEquals(asksUntilJudged(["unavailable"]), MERGE_ASKS_UNAVAILABLE);
  assertEquals(asksUntilJudged(["refused", "unavailable"]), MERGE_ASKS_REFUSED);
  assertEquals(asksUntilJudged(["unavailable", "unavailable", "refused"]), MERGE_ASKS_REFUSED);
  // The review's case: refused, refused, unavailable, over and over.
  assertEquals(asksUntilJudged(["refused", "refused", "unavailable"]), 4);
});

test("the asks back off from 30 s, doubling, to half an hour", () => {
  assertEquals([1, 2, 3, 7, 8, 30].map(mergeAskBackoffMs), [
    30_000,
    60_000,
    120_000,
    1_800_000,
    1_800_000,
    1_800_000,
  ]);
});

test("one question names the newest merged heads, and the never-judged patches first", () => {
  const sha = (n: number) => n.toString(16).padStart(40, "0");
  const merge = { heads: Array.from({ length: 25 }, (_, i) => sha(10_000 + i)) };
  const judgedBefore = settled(submitted("p-old", sha(1)), "closed");
  const fresh = Array.from(
    { length: MERGE_ASK_HEADS + 1 },
    (_, i) => submitted(`p-${i}`, sha(2 + i)),
  );
  // Two patches of one head take one place.
  const twin = submitted("p-twin", sha(2));
  const ask = mergeAsk(merge, [judgedBefore, ...fresh, twin]);
  assertEquals(ask.mergedHeads, merge.heads.slice(0, MERGE_ASK_MERGED_HEADS));
  assertEquals(ask.asked.length, MERGE_ASK_HEADS + 1);
  assertEquals(ask.asked.at(-1)!.id, "p-twin");
  assertEquals(new Set(ask.asked.map((p) => p.headSha)).size, MERGE_ASK_HEADS);
  // The newest never-judged one and the one judged before wait for the next question.
  assert(!ask.asked.some((p) => p.id === `p-${MERGE_ASK_HEADS}` || p.id === "p-old"));
  assertEquals(mergeAsk(merge, [judgedBefore, twin]).asked.map((p) => p.id), ["p-twin", "p-old"]);
});

test("a merge record's heads only grow, each once", () => {
  assertEquals(grownHeads(["a"], ["a"]), null);
  // Newest first: a later delivery's new heads go before the recorded ones, in its own order.
  assertEquals(grownHeads(["a"], ["c", "b", "a", "b"]), ["c", "b", "a"]);
});

test("what still owes a merge its verdict", () => {
  const open = submitted("p-a", "a".repeat(40));
  const unsettled = { settledAt: null };
  const done = { settledAt: T2 };
  assert(owesMergeVerdict(open, done));
  // A close (before a reopen) and a missed verdict are judged again while the record is open.
  assert(owesMergeVerdict(settled(open, "closed"), unsettled));
  assert(owesMergeVerdict(settled(open, "missed"), unsettled));
  assert(!owesMergeVerdict(settled(open, "missed"), done));
  assert(!owesMergeVerdict(settled(open, "merged"), unsettled));
  assert(mergeVerdictPending(unsettled, []));
  assert(!mergeVerdictPending(done, [settled(open, "merged")]));
  assert(mergeVerdictPending(done, [open]));
});

test("settle: a verdict moves only toward more of the work having landed", () => {
  const open = submitted("p-a", "a".repeat(40));
  const missed = settled(open, "missed");
  assertEquals(missed.landed, { kind: "missed", at: T1, mergedInto: "main" });
  // A missed patch owes its landing like a merged one: the change request merged.
  assertEquals(missed.landingAskedAt, null);
  assertEquals(patchFateForMemory(missed), "dropped");
  const unproven = settlePatch(open, "missed", T1, { mergedInto: "main", unproven: true });
  assert(unproven.kind === "applied");
  assertEquals(unproven.patch.landed?.unproven, true);
  assertEquals(unproven.events[0].detail, "missed");

  // A later merge that holds it: merged, its memory report and its cue owed again.
  const cued = { ...missed, memoryFateReportedAt: T1, mergedCuedAt: T1, mergedCueClaimedAt: T1 };
  const merged = settled(cued, "merged", T2);
  assertEquals(
    [merged.landed?.kind, merged.memoryFateReportedAt, merged.mergedCuedAt],
    ["merged", null, null],
  );
  assertEquals(merged.mergedCueClaimedAt, null);
  // Closed then merged without it: missed. Nothing goes back from merged, nor to closed.
  assertEquals(settled(settled(open, "closed"), "missed").landed?.kind, "missed");
  for (const [from, to] of [["merged", "missed"], ["merged", "closed"], ["missed", "closed"]]) {
    const at = settled(open, from as "merged" | "missed");
    assertEquals(settlePatch(at, to as "missed" | "closed", T2).kind, "refused");
  }
  assertEquals(settlePatch(missed, "missed", T2).kind, "refused");
});

test("a missed sibling ends the generation for the landing rule, a merged one first", () => {
  const first = settled(submitted("p-a", "a".repeat(40), T0), "missed");
  const waiting: Patch = { ...submitted("p-w", "c".repeat(40), T2), state: "queued" };
  assertEquals(landedSiblingOf([first, waiting], waiting)?.id, "p-a");
  assertEquals(landedVerdict(waiting, [first, waiting]), { kind: "held" });
  const second = settled(submitted("p-b", "b".repeat(40), T1), "merged");
  assertEquals(landedSiblingOf([first, second, waiting], waiting)?.id, "p-b");
});

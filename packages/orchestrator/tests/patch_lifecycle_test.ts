// The patch state machine, pure — every transition against a fake clock, no store, no forge.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  approvePatch,
  DEFAULT_PATCH_SUBMIT_CONFIG,
  forgeBranchOf,
  HELD_REASON,
  HELD_REASON_ENDED,
  heldDestination,
  isLandingHold,
  isPatchTerminal,
  landedSiblingOf,
  landedVerdict,
  markFailed,
  markSubmitted,
  markSubmitting,
  openPatch,
  overlapReason,
  planPatchSweep,
  rejectPatch,
  retireLanded,
  retryPatch,
  settlePatch,
  submissionTarget,
  supersedePatch,
  UNCONFIRMED_REASON,
  unrebasedReason,
} from "../src/core/patch_lifecycle.ts";
import { lineBase } from "../src/core/landing.ts";
import type { Patch, RunEvent } from "../src/core/types.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";

const ARGS = {
  id: "p-1",
  connectedRepoId: "cr-1",
  runId: "r-1",
  taskId: "t-1",
  setId: "ps-1",
  path: "app",
  line: "work",
  branchName: "ryph/ada/r-1/work",
  headSha: "abc123",
  bundleKey: "r-1/cr-1/abc123.bundle",
  baseSha: null,
  generation: 1,
  title: null,
  description: null,
  commits: [],
  carries: [],
  heldReason: null,
};

const applied = (o: ReturnType<typeof approvePatch>): { patch: Patch; events: RunEvent[] } => {
  assert(o.kind === "applied", o.kind === "refused" ? o.why : o.kind);
  return o;
};

test("birth: the policy decides only the born state, and both states are durable", () => {
  const gated = openPatch(ARGS, "require-approval", true, T0);
  assertEquals(gated.patch.state, "pending_approval");
  assertEquals(gated.events, [
    { runId: "r-1", at: T0, kind: "patch-opened", detail: "pending_approval" },
  ]);

  const auto = openPatch(ARGS, "auto", true, T0);
  assertEquals(auto.patch.state, "queued");
  assert(!isPatchTerminal(gated.patch) && !isPatchTerminal(auto.patch));
});

test("birth: auto skips the gate only when admission allows it — leftovers wait", () => {
  const broken = openPatch(ARGS, "auto", false, T0);
  assertEquals(broken.patch.state, "pending_approval");
  assertEquals(broken.events, [
    { runId: "r-1", at: T0, kind: "patch-opened", detail: "pending_approval" },
  ]);
  // Held, not lost: the work is as durable as any other patch, it just waits on a human.
  assert(!isPatchTerminal(broken.patch));

  assertEquals(openPatch(ARGS, "require-approval", false, T0).patch.state, "pending_approval");
});

test("approve: pending_approval → queued, the approver recorded — break-glass positively", () => {
  const { patch } = openPatch(ARGS, "require-approval", true, T0);
  const byUser = applied(approvePatch(patch, { kind: "user", userId: "u-1" }, T1));
  assertEquals(byUser.patch.state, "queued");
  assertEquals(byUser.patch.approvedBy, { kind: "user", userId: "u-1" });

  const byGlass = approvePatch(patch, { kind: "break-glass" }, T1);
  assert(byGlass.kind === "applied");
  assertEquals(byGlass.events[0].detail, "break-glass");

  // Only a waiting patch approves; a queued one is already past the gate.
  assertEquals(approvePatch(byUser.patch, { kind: "user", userId: "u-2" }, T2).kind, "refused");
});

test("reject: a human read it and declined — terminal, and distinct from a lost run", () => {
  const { patch } = openPatch(ARGS, "require-approval", true, T0);
  const rejected = applied(rejectPatch(patch, { kind: "user", userId: "u-1" }, T1));
  assertEquals(rejected.patch.state, "rejected");
  assert(isPatchTerminal(rejected.patch));
  assertEquals(rejectPatch(rejected.patch, { kind: "break-glass" }, T2).kind, "refused");
});

test("supersede: only waiting patches; the replacement is recorded", () => {
  const { patch } = openPatch(ARGS, "auto", true, T0);
  const superseded = applied(supersedePatch(patch, "p-2", T1));
  assertEquals(superseded.patch.state, "superseded");
  assertEquals(superseded.patch.supersededByPatchId, "p-2");

  const submitting = applied(markSubmitting(openPatch(ARGS, "auto", true, T0).patch, T1)).patch;
  assertEquals(supersedePatch(submitting, "p-2", T2).kind, "refused");
});

test("submit happy path: queued → submitting (lease, attempt) → submitted (terminal)", () => {
  const { patch } = openPatch(ARGS, "auto", true, T0);
  const submitting = applied(markSubmitting(patch, T1)).patch;
  assertEquals(submitting.state, "submitting");
  assertEquals(submitting.attempts, 1);
  assert(submitting.leaseExpiresAt !== null);

  const done = applied(
    markSubmitted(submitting, {
      ref: "42",
      url: "https://x/pull/42",
      branch: "ryph/ada/r-1",
      diffRef: "main",
    }, T2),
  );
  assertEquals(done.patch.state, "submitted");
  assertEquals(done.patch.forgeRef, "42");
  assertEquals(done.patch.leaseExpiresAt, null);
  assert(isPatchTerminal(done.patch));
  assertEquals(done.events[0].kind, "patch-submitted");
});

test("a retryable failure sets the backoff clock; the sweep requeues when it expires", () => {
  const { patch } = openPatch(ARGS, "auto", true, T0);
  const submitting = applied(markSubmitting(patch, T0)).patch;
  const failed =
    applied(markFailed(submitting, { message: "502 from GitHub", terminal: false }, T1))
      .patch;
  assertEquals(failed.state, "failed");
  assert(failed.nextAttemptAt !== null, "a retryable failure gets a clock");
  assertEquals(
    Date.parse(failed.nextAttemptAt!),
    Date.parse(T1) + DEFAULT_PATCH_SUBMIT_CONFIG.baseBackoffMs,
  );

  // Before the clock: nothing to do. After: back to the queue.
  assertEquals(planPatchSweep(failed, Date.parse(T1), T1).kind, "none");
  const dueMs = Date.parse(failed.nextAttemptAt!);
  const requeued = planPatchSweep(failed, dueMs, new Date(dueMs).toISOString());
  assert(requeued.kind === "requeue");
  assertEquals(requeued.patch.state, "queued");
  assertEquals(requeued.patch.nextAttemptAt, null);
});

test("markSubmitting refuses while a clock is running — a racing sweep cannot burn attempts", () => {
  const { patch } = openPatch(ARGS, "auto", true, T0);
  const failed = applied(
    markFailed(applied(markSubmitting(patch, T0)).patch, { message: "x", terminal: false }, T0),
  ).patch;
  assertEquals(markSubmitting(failed, T0).kind, "refused");
  // Once due, failed → submitting directly is allowed (the md's contract).
  const due = new Date(Date.parse(failed.nextAttemptAt!) + 1).toISOString();
  assertEquals(markSubmitting(failed, due).kind, "applied");
});

test("a terminal failure sets no clock; a human retry requeues it anyway", () => {
  const { patch } = openPatch(ARGS, "auto", true, T0);
  const failed = applied(markFailed(
    applied(markSubmitting(patch, T0)).patch,
    { message: "403: no access to the repo", terminal: true },
    T1,
  )).patch;
  assertEquals(failed.nextAttemptAt, null);
  assertEquals(planPatchSweep(failed, Date.parse(T1) + 10 ** 9, T2).kind, "none");
  assert(!isPatchTerminal(failed), "failed is never terminal — a human can always retry");

  const retried = applied(retryPatch(failed, T2)).patch;
  assertEquals(retried.state, "queued");
});

test("attempts exhaust: past maxAttempts even a retryable failure waits for a human", () => {
  let patch = openPatch(ARGS, "auto", true, T0).patch;
  const err = { message: "timeout", terminal: false };
  for (let i = 0; i < DEFAULT_PATCH_SUBMIT_CONFIG.maxAttempts; i++) {
    const due = patch.nextAttemptAt ?? T0;
    patch = applied(markFailed(applied(markSubmitting(patch, due)).patch, err, due)).patch;
  }
  assertEquals(patch.attempts, DEFAULT_PATCH_SUBMIT_CONFIG.maxAttempts);
  assertEquals(patch.nextAttemptAt, null, "exhausted attempts stop setting a clock");
});

test("backoff doubles per attempt and is capped", () => {
  const cfg = { ...DEFAULT_PATCH_SUBMIT_CONFIG, baseBackoffMs: 1_000, maxBackoffMs: 3_000 };
  let patch = openPatch(ARGS, "auto", true, T0).patch;
  const delays: number[] = [];
  for (let i = 0; i < 4; i++) {
    const due = patch.nextAttemptAt ?? T0;
    patch = applied(markSubmitting(patch, due, cfg)).patch;
    patch = applied(markFailed(patch, { message: "x", terminal: false }, due, cfg)).patch;
    delays.push(Date.parse(patch.nextAttemptAt!) - Date.parse(due));
  }
  assertEquals(delays, [1_000, 2_000, 3_000, 3_000]);
});

test("the sweep reclaims an expired lease — a dead submitter never strands a patch", () => {
  const { patch } = openPatch(ARGS, "auto", true, T0);
  const submitting = applied(markSubmitting(patch, T0)).patch;
  const leaseEnd = Date.parse(submitting.leaseExpiresAt!);

  assertEquals(planPatchSweep(submitting, leaseEnd - 1, T1).kind, "none");
  const reclaimed = planPatchSweep(submitting, leaseEnd, new Date(leaseEnd).toISOString());
  assert(reclaimed.kind === "reclaim");
  assertEquals(reclaimed.patch.state, "queued");
  assertEquals(reclaimed.patch.leaseExpiresAt, null);
  // The attempt already counted — a crashy submitter still marches toward maxAttempts.
  assertEquals(reclaimed.patch.attempts, 1);
});

test("the sweep submits queued patches and leaves terminal ones alone", () => {
  const { patch } = openPatch(ARGS, "auto", true, T0);
  assertEquals(planPatchSweep(patch, Date.parse(T0), T0).kind, "submit");

  const submitted = applied(
    markSubmitted(
      applied(markSubmitting(patch, T0)).patch,
      { ref: "1", url: "u", branch: "b", diffRef: "main" },
      T1,
    ),
  ).patch;
  assertEquals(planPatchSweep(submitted, Date.parse(T2), T2).kind, "none");

  const pending = openPatch(ARGS, "require-approval", true, T0).patch;
  assertEquals(planPatchSweep(pending, Date.parse(T2), T2).kind, "none");
});

test("settle: a submitted patch learns its PR's fate once; anything else refuses", () => {
  const born = openPatch(ARGS, "auto", true, T0).patch;
  assertEquals(born.landed, null);
  assert(settlePatch(born, "merged", T1).kind === "refused"); // never reached the forge
  const submitted = applied(
    markSubmitted(applied(markSubmitting(born, T1)).patch, {
      ref: "42",
      url: "https://x/42",
      branch: "b",
      diffRef: "main",
    }, T2),
  ).patch;
  const merged = applied(settlePatch(submitted, "merged", T2));
  assertEquals(merged.patch.state, "submitted"); // the submission machine is untouched
  assertEquals(merged.patch.landed, { kind: "merged", at: T2 });
  assertEquals(merged.events, [{ runId: "r-1", at: T2, kind: "patch-settled", detail: "merged" }]);
  const again = settlePatch(merged.patch, "closed", T2);
  assert(again.kind === "refused" && again.why.includes("already merged"));
  assertEquals(applied(settlePatch(submitted, "closed", T2)).patch.landed, {
    kind: "closed",
    at: T2,
  });
  // A redelivery of the verdict already recorded is still a duplicate, merged or closed.
  assert(settlePatch(merged.patch, "merged", T2).kind === "refused");
});

test("settle: the forge's merge keeps where it merged and owes a landing", () => {
  const born = openPatch(ARGS, "auto", true, T0).patch;
  const submitted = applied(
    markSubmitted(applied(markSubmitting(born, T1)).patch, {
      ref: "42",
      url: "https://x/42",
      branch: "b",
      diffRef: "main",
    }, T2),
  ).patch;
  const heard = applied(settlePatch(submitted, "merged", T2, { mergedInto: "release" })).patch;
  assertEquals(heard.landed, { kind: "merged", at: T2, mergedInto: "release" });
  assertEquals(heard.landingAskedAt, null);
  // The forge said nothing: still owed, inferred when it is landed.
  const silent = applied(settlePatch(submitted, "merged", T2, { mergedInto: undefined })).patch;
  assertEquals([silent.landed, silent.landingAskedAt], [{ kind: "merged", at: T2 }, null]);
  // A close owes nothing, and a merge that revises it is owed its landing.
  const closed = applied(settlePatch(submitted, "closed", T2, { mergedInto: "main" })).patch;
  assertEquals([closed.landed, closed.landingAskedAt], [{ kind: "closed", at: T2 }, null]);
  const revised = applied(settlePatch(closed, "merged", T2, { mergedInto: "main" })).patch;
  assertEquals(revised.landed, { kind: "merged", at: T2, mergedInto: "main" });
});

test("settle: a reopened pull request may still merge — the one verdict worth revising", () => {
  const born = openPatch(ARGS, "auto", true, T0).patch;
  const submitted = applied(
    markSubmitted(applied(markSubmitting(born, T0)).patch, {
      ref: "42",
      url: "https://x/42",
      branch: "b",
      diffRef: "main",
    }, T1),
  ).patch;
  // Closed, and memory told so — the run's claims were dropped.
  const closed = applied(settlePatch(submitted, "closed", T1)).patch;
  const acknowledged = { ...closed, memoryFateReportedAt: T1 };

  // Someone reopens it and merges it. The code IS on the default branch now, and refusing this
  // verdict would leave the patch reading "closed" and the claims dropped for work that landed.
  const merged = applied(settlePatch(acknowledged, "merged", T2));
  assertEquals(merged.patch.landed, { kind: "merged", at: T2 });
  assertEquals(merged.events, [{ runId: "r-1", at: T2, kind: "patch-settled", detail: "merged" }]);
  // The acknowledgement is cleared with it: memory heard "dropped" and now owes a "landed",
  // which is exactly what the reconciliation sweep looks for.
  assertEquals(merged.patch.memoryFateReportedAt, null);

  // The reverse is not information, it is noise: a merged pull request is closed by definition.
  const back = settlePatch(merged.patch, "closed", T2);
  assert(back.kind === "refused" && back.why.includes("already merged"));
});

test("where a submission lands a patch: a fresh change request, an earlier one's, the task's", () => {
  const first: Patch = {
    ...openPatch({ ...ARGS, id: "p-1" }, "require-approval", true, T0).patch,
    state: "submitted",
    forgeRef: "7",
  };
  const later =
    openPatch({ ...ARGS, id: "p-2", headSha: "def456" }, "require-approval", true, T1).patch;
  const noTarget = { targetChangeRequest: null };

  // Alone, against the task's base.
  assertEquals(submissionTarget(noTarget, [later], later, "main", "github"), {
    branch: "main",
    diffRef: "main",
    changeRequest: null,
    earlier: undefined,
  });
  // After an earlier patch of the branch opened a change request: onto it, on its branch.
  assertEquals(submissionTarget(noTarget, [first, later], later, "main", "github"), {
    branch: first.branchName,
    diffRef: first.branchName,
    changeRequest: "7",
    earlier: first,
  });
  // On Radicle the earlier one's head is a patch the forge serves only as `patches/<id>`: the
  // revision is staged on the task's base, and measured against that patch's head.
  assertEquals(submissionTarget(noTarget, [first, later], later, "main", "radicle"), {
    branch: "main",
    diffRef: "patches/7",
    changeRequest: "7",
    earlier: first,
  });
  // A landed one no longer takes more: a fresh change request.
  const landed = { ...first, landed: { kind: "merged" as const, at: T1 } };
  assertEquals(
    submissionTarget(noTarget, [landed, later], later, "main", "github").changeRequest,
    null,
  );
  // A task working on a pull request: onto it, on its head branch (the task's ref), whichever
  // patch of the run pushes — never the run's own branch, which the pull request does not have.
  const onPr = { targetChangeRequest: { connectedRepoId: "cr-1", thread: "7" } };
  assertEquals(submissionTarget(onPr, [first, later], later, "feature-x", "github"), {
    branch: "feature-x",
    diffRef: "feature-x",
    changeRequest: "7",
    earlier: first,
  });

  // Another LINE of the same repo is its own change request: it never stacks on the first line's
  // open one, and the task's change request binds the default line only.
  const otherLine = openPatch(
    { ...ARGS, id: "p-3", headSha: "fed789", line: "fix-a", branchName: "ryph/ada/r-1/fix-a" },
    "require-approval",
    true,
    T1,
  ).patch;
  assertEquals(submissionTarget(noTarget, [first, otherLine], otherLine, "main", "github"), {
    branch: "main",
    diffRef: "main",
    changeRequest: null,
    earlier: undefined,
  });
  assertEquals(
    submissionTarget(onPr, [first, otherLine], otherLine, "feature-x", "github").changeRequest,
    null,
  );
});

test("a new line's fresh change request opens against its own base, never the target's head", () => {
  // A task working pull request #7, whose head is `feature-x` and whose base is `main`: the
  // repo's entry stands on the head, and names the base as its target.
  const entry = { connectedRepoId: "cr-1", path: "app", ref: "feature-x", targetRef: "main" };
  const onPr = { targetChangeRequest: { connectedRepoId: "cr-1", thread: "7" } };
  const line = openPatch(
    { ...ARGS, id: "p-2", headSha: "fed789", line: "fix-a", branchName: "ryph/ada/r-1/fix-a" },
    "require-approval",
    true,
    T0,
  ).patch;
  const work = openPatch(ARGS, "require-approval", true, T0).patch;
  // The default line pushes onto the pull request, on its head branch.
  assertEquals(lineBase(entry, {}, "work", "r-1"), "feature-x");
  assertEquals(
    submissionTarget(onPr, [work], work, lineBase(entry, {}, "work", "r-1"), "github").branch,
    "feature-x",
  );
  // Another line is a pull request of its own against where #7 merges — where the runner built
  // it (`origin/<targetRef>`) — never against #7's head, which would stack it on #7.
  assertEquals(
    submissionTarget(onPr, [work, line], line, lineBase(entry, {}, "fix-a", "r-1"), "github"),
    { branch: "main", diffRef: "main", changeRequest: null, earlier: undefined },
  );
  // Once that line merged somewhere of its own, its next generation opens against there.
  const landings = {
    app: {
      "r-1/fix-a": {
        connectedRepoId: "cr-1",
        thread: "8",
        onto: "release",
        generation: 1,
        moved: true,
        at: T1,
        runId: "r-1",
      },
    },
  };
  const next = { ...line, id: "p-3", generation: 2, branchName: "ryph/ada/r-1/fix-a-2" };
  assertEquals(
    submissionTarget(onPr, [work, next], next, lineBase(entry, landings, "fix-a", "r-1"), "github")
      .branch,
    "release",
  );
  // A landing of another repo at the same path is not this one's.
  assertEquals(
    lineBase({ ...entry, connectedRepoId: "cr-2" }, landings, "fix-a", "r-1"),
    "main",
  );
  // A line of the same name in a later run is other work: it opens against the line's own base,
  // never where the earlier run's line merged.
  assertEquals(lineBase(entry, landings, "fix-a", "r-2"), "main");
  // And a landing kept under the bare line name (no run's key) counts for none.
  const { runId: _, ...unnamed } = landings.app["r-1/fix-a"];
  assertEquals(lineBase(entry, { app: { "fix-a": unnamed } }, "fix-a", "r-1"), "main");
  // And a task on its own base: every line opens against it.
  assertEquals(lineBase({ ...entry, targetRef: undefined }, {}, "fix-a", "r-1"), "feature-x");
});

test("a landed line holds or replaces only its own patches, never another line's", () => {
  const at = (id: string, over: Partial<Patch>): Patch => ({
    ...openPatch({ ...ARGS, id, headSha: `sha-${id}` }, "require-approval", true, T0).patch,
    ...over,
  });
  const landed = at("p-a", {
    state: "submitted",
    forgeRef: "7",
    landed: { kind: "merged", at: T1 },
  });
  const sibling = at("p-b", { state: "queued", createdAt: T1 });
  const otherLine = at("p-c", { state: "queued", createdAt: T1, line: "fix-a" });
  const newerOtherLine = at("p-d", {
    state: "queued",
    createdAt: T2,
    line: "fix-a",
    generation: 2,
  });
  const all = [landed, sibling, otherLine, newerOtherLine];
  assertEquals(landedSiblingOf(all, otherLine), undefined);
  assertEquals(landedVerdict(otherLine, all), { kind: "none" });
  // Nor is the default line's waiting patch replaced by a newer generation of another line.
  assertEquals(landedVerdict(sibling, all), { kind: "held" });
  // A landing recorded for one line ends nothing of another.
  const landings = {
    app: {
      work: {
        connectedRepoId: "cr-1",
        thread: "7",
        onto: "main",
        generation: 1,
        moved: false,
        at: T1,
      },
    },
  };
  assertEquals(landedVerdict(otherLine, [otherLine], landings), { kind: "none" });
  assertEquals(landedVerdict(sibling, [sibling], landings), { kind: "held" });
});

test("where the forge holds a submitted patch: the branch it was pushed to, never re-derived", () => {
  const patch = openPatch(ARGS, "auto", true, T0).patch;
  const fresh = { branch: "main", changeRequest: null };
  const ontoPr = { branch: "feature-x", changeRequest: "7" };
  // A fresh pull request is opened FROM the patch's own branch; `branch` is its base then.
  assertEquals(forgeBranchOf("github", fresh, patch, "8"), "ryph/ada/r-1/work");
  // Pushed onto a pull request: its head, which the target names.
  assertEquals(forgeBranchOf("github", ontoPr, patch, "7"), "feature-x");
  // Radicle serves every patch as `patches/<id>`, opened or added to.
  assertEquals(forgeBranchOf("radicle", fresh, patch, "c".repeat(40)), `patches/${"c".repeat(40)}`);
  assertEquals(forgeBranchOf("radicle", ontoPr, patch, "7"), "patches/7");
  // And the submission records it, so it outlives whatever the task targets later.
  const submitting = applied(markSubmitting(patch, T1)).patch;
  const done = applied(
    markSubmitted(submitting, { ref: "7", url: null, branch: "feature-x", diffRef: "main" }, T2),
  );
  assertEquals(done.patch.forgeBranch, "feature-x");
  assertEquals(patch.forgeBranch, null);
});

test("a landed generation: replaced by the newest patch of its branch, else held, its approval reset", () => {
  const at = (id: string, over: Partial<Patch>): Patch => ({
    ...openPatch({ ...ARGS, id, headSha: `sha-${id}` }, "require-approval", true, T0).patch,
    ...over,
  });
  const landed = at("p-a", {
    state: "submitted",
    forgeRef: "7",
    landed: { kind: "merged", at: T1 },
  });
  const waiting = at("p-b", { state: "queued", approvedAt: T1, createdAt: T1 });
  const newer = at("p-c", { state: "failed", nextAttemptAt: T2, createdAt: T2 });
  const otherRun = at("p-r", { runId: "r-2" });
  const otherPath = at("p-p", { path: "web" });

  assertEquals(landedSiblingOf([landed, waiting], waiting)?.id, "p-a");
  for (const p of [otherRun, otherPath]) {
    assertEquals(landedVerdict(p, [landed, p]), { kind: "none" });
  }
  assertEquals(landedVerdict(waiting, [waiting]), { kind: "none" });
  // The newest of the generation is held; an older one is replaced by it, never held beside it.
  assertEquals(landedVerdict(waiting, [landed, waiting]), { kind: "held" });
  assertEquals(landedVerdict(waiting, [landed, waiting, newer]), { kind: "superseded", by: newer });
  assertEquals(landedVerdict(newer, [landed, waiting, newer]), { kind: "held" });
  // A failure with no clock left is not the rule's: it waits on a person's retry.
  const stopped = { ...newer, nextAttemptAt: null };
  assertEquals(landedVerdict(stopped, [landed, waiting, stopped]), { kind: "none" });
  // A rejected or replaced newer patch replaces nothing: the older one is held, not superseded.
  const goneNowhere: Partial<Patch>[] = [
    { state: "rejected" },
    { state: "superseded" },
    { state: "submitted", forgeRef: "8", landed: { kind: "closed", at: T2 } },
    { state: "failed", nextAttemptAt: null },
  ];
  for (const over of goneNowhere) {
    const declined = at("p-g", { ...over, generation: 2, createdAt: T2 });
    assertEquals(
      landedVerdict(waiting, [landed, waiting, declined]),
      { kind: "held" },
      JSON.stringify(over),
    );
  }
  // A failure still on its clock does replace it.
  const retrying = at("p-h", { state: "failed", nextAttemptAt: T2, generation: 2, createdAt: T2 });
  assertEquals(landedVerdict(waiting, [landed, waiting, retrying]), {
    kind: "superseded",
    by: retrying,
  });
  // A later generation replaces it too.
  const later = at("p-d", { generation: 2, createdAt: T2 });
  assertEquals(landedVerdict(waiting, [landed, waiting, later]), { kind: "superseded", by: later });

  // Held: back at a person's door whatever the repo's policy, its approval gone, where approving
  // would send it said.
  const reason = HELD_REASON;
  assertStringIncludes(
    heldDestination({ branch: "main", changeRequest: null }),
    "opens a new change request against main",
  );
  assertStringIncludes(
    heldDestination({ branch: "feat/x", changeRequest: "7" }),
    "onto the open change request #7",
  );
  const held = applied(retireLanded(waiting, { kind: "held" }, T2, reason)).patch;
  assertEquals(
    [held.state, held.approvedAt, held.approvedBy, held.heldReason],
    ["pending_approval", null, null, reason],
  );
  // Once a person has it, the rule leaves it to them.
  assertEquals(landedVerdict(held, [landed, held]), { kind: "none" });
  const claimed = applied(markSubmitting(waiting, T1)).patch;
  const replaced = applied(retireLanded(claimed, { kind: "superseded", by: later }, T2, reason))
    .patch;
  assertEquals([replaced.state, replaced.supersededByPatchId, replaced.leaseExpiresAt], [
    "superseded",
    "p-d",
    null,
  ]);
  assertEquals(retireLanded(landed, { kind: "held" }, T2, reason).kind, "refused");
  // A hold at the sweep's claim hands back the attempt the claim took, as the hook hold does:
  // nothing failed. One from the queue keeps what it had.
  const atClaim = applied(markSubmitting({ ...waiting, attempts: 2 }, T1)).patch;
  assertEquals(atClaim.attempts, 3);
  assertEquals(applied(retireLanded(atClaim, { kind: "held" }, T2, reason)).patch.attempts, 2);
  assertEquals(
    applied(retireLanded({ ...waiting, attempts: 2 }, { kind: "held" }, T2, reason)).patch.attempts,
    2,
  );
  // A failed patch is replaced only where a landed generation's work is carried.
  assertEquals(supersedePatch(newer, "p-d", T2).kind, "refused");
  assertEquals(
    applied(supersedePatch(newer, "p-d", T2, { failed: true })).patch.state,
    "superseded",
  );
});

test("a patch is born with no held reason, but one born with a reason is held with it", () => {
  const auto = openPatch(ARGS, "auto", true, T0);
  assertEquals([auto.patch.state, auto.patch.heldReason], ["queued", null]);
  assertEquals(auto.events.map((e) => e.kind), ["patch-opened"]);
  const finalized = openPatch(ARGS, "auto", false, T0).patch;
  assertEquals([finalized.state, finalized.heldReason], ["pending_approval", null]);
  assert(!isLandingHold(finalized));
  // Born with a reason: held whatever the policy, its reason on it, never a landing hold.
  const unrebased = openPatch({ ...ARGS, heldReason: unrebasedReason("rel`x") }, "auto", true, T0);
  assertEquals(unrebased.patch.state, "pending_approval");
  assertEquals(
    unrebased.patch.heldReason,
    "Not rebased onto `rel'x` after its change request merged there; its diff may repeat merged " +
      "work.",
  );
  assertEquals(unrebased.events.map((e) => e.kind), ["patch-opened", "patch-held"]);
  assert(!isLandingHold(unrebased.patch));
  const overlap = openPatch({ ...ARGS, heldReason: overlapReason(["x"]) }, "auto", true, T0);
  assertEquals(
    [overlap.patch.state, overlap.patch.heldReason],
    ["pending_approval", "Holds commits of line `x`, which ships as its own change request."],
  );
});

test("a landing hold is one of the landing rule's own reasons; any other is a review hold", () => {
  assert(!isLandingHold({ heldReason: null }));
  assert(isLandingHold({ heldReason: HELD_REASON }));
  assert(isLandingHold({ heldReason: HELD_REASON_ENDED }));
  for (const reason of [unrebasedReason("main"), overlapReason(["a", "b"]), UNCONFIRMED_REASON]) {
    assert(!isLandingHold({ heldReason: reason }), reason);
  }
  // A reason worded otherwise is a review hold: approvable with its diff in view.
  assert(!isLandingHold({ heldReason: "A patch of the same branch merged first." }));
});

test("an unrebased hold gives way to a landing hold, which waits for the run", () => {
  const landed = {
    ...openPatch({ ...ARGS, id: "p-a", headSha: "sha-a" }, "auto", true, T0).patch,
    state: "submitted" as const,
    forgeRef: "7",
    landed: { kind: "merged" as const, at: T1 },
  };
  const unrebased = {
    ...openPatch(
      { ...ARGS, id: "p-b", headSha: "sha-b", heldReason: unrebasedReason("main") },
      "auto",
      true,
      T0,
    ).patch,
    createdAt: T1,
  };
  assertEquals(landedVerdict(unrebased, [landed, unrebased]), { kind: "held" });
  const retired = applied(retireLanded(unrebased, { kind: "held" }, T2, HELD_REASON)).patch;
  assert(isLandingHold(retired));
  assertEquals(landedVerdict(retired, [landed, retired]), { kind: "none" });
});

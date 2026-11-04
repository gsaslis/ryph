// A change request's fate reaching the patches that went into it, in the order
// docs/patch-lifecycle.md "Landing" names. A merge is first RECORDED (`ChangeRequestMerge`: where
// it merged and which heads, as the forge said), then every patch on the change request is
// JUDGED against that record — `merged` when git says the merge contains its head, `missed` when
// it does not (core/merge_record.ts) — and then, in order, each is LANDED (core/landing.ts), the
// RULE is applied to the run's waiting siblings (core/landing_rule.ts), and the run is CUED.
//
// Three doors record, one place settles. The forge's merge event, the merge poll's read made
// into that event (core/merge_poll.ts), and a push the forge refused because its change request
// merged (core/merge_poll.ts `recordRefusedMerge`) only write the record
// (`settleChangeRequestEnd`) and return: containment may need the forge to fetch, and nothing
// that answers a webhook waits on it. The submit sweep's settle reconcile (`reconcileMergeSettles`) does the rest from the
// record, one ask of the forge per record at a time (the record's own clock says so), waiting on
// them a bounded time per sweep. It also judges
// a push that reached the change request after its merge was recorded, whatever task it belongs
// to, against the same record: the record is the forge's own word, so a late patch is landed
// where the forge said, never where another task inferred. Its landing reconcile
// (`reconcileMergedLandings`) writes a landing a settle left owed (the landing failed after the
// settle), onto the branch the settle kept; letting go of a task the merge left nothing of its
// current run on is core/merge_release.ts's.
//
// The cue has an outbox: tried once here, and marked only once it was posted. One that could not
// be posted — or whose landing is not recorded yet — is left for the submit sweep
// (`sweepMergedCues`), so a cue is never lost to a post that failed, nor sent without the `onto`
// the landing names. A cue whose run is over is marked without a post — a terminal run never
// comes back to hear it — here, or by the sweep for a run that ended after the merge. So the
// outbox holds the cues live runs are owed — a few waiting on their landing among them — and
// nothing a run that is over could hear.

import type { MergeContainmentOutcome } from "../ports/forge.ts";
import type { Forge } from "../ports/forge.ts";
import type { TaskStore } from "../ports/task_store.ts";
import { reportPatchFate } from "./conclude_run.ts";
import { forgeRepoRef } from "./forge_repo.ts";
import { notifyPatch, notifyText } from "./inbox.ts";
import { isTerminal } from "./lifecycle.ts";
import { cueOnto, hasLanding } from "./landing.ts";
import { type LandingRuleDeps, releasedNote, settleLandedSiblings } from "./landing_rule.ts";
import { judgeMerge, MERGE_ASK_DEADLINE_MS, mergeAsk, owesMergeVerdict } from "./merge_record.ts";
import { isMergeVerdict, patchFateForMemory, settlePatch } from "./patch_lifecycle.ts";
import type { ChecksService } from "./checks.ts";
import type {
  ChangeRequestMerge,
  ConnectedRepo,
  InboundForgeEvent,
  Patch,
  PatchFate,
} from "./types.ts";

/** How many times a verdict that lost its write to another is read again and retried. */
const SETTLE_RETRIES = 5;

/**
 * Writes the forge's verdict on one patch, conditioned on the verdict this caller read, with its
 * event. Losing the write means another settle (or a close's delivery) wrote first — perhaps a verdict this one may
 * still revise — so the row is read again and the verdict asked again, until it applies or is
 * refused. Answers the patch as settled by THIS call, or null when it settled nothing.
 */
export async function settleOnce(
  store: Pick<TaskStore, "settlePatchIf" | "getPatch">,
  read: Patch,
  fate: PatchFate["kind"],
  at: string,
  merge?: { mergedInto: string | undefined; unproven?: boolean },
  /** A close's: written only while no merge of the change request is recorded (`settlePatchIf`). */
  opts?: { unlessMergeRecorded?: boolean },
): Promise<Patch | null> {
  let patch: Patch | null = read;
  for (let attempt = 0; patch !== null && attempt < SETTLE_RETRIES; attempt++) {
    const settled = settlePatch(patch, fate, at, merge);
    if (settled.kind === "refused") return null;
    const from = patch.landed?.kind ?? null;
    if (await store.settlePatchIf(settled.patch, from, settled.events, opts)) {
      return settled.patch;
    }
    patch = await store.getPatch(patch.id);
    // The verdict it read still stands, so what refused the write was a merge recorded since
    // (or the patch left `submitted`): nothing to retry.
    if (opts?.unlessMergeRecorded === true && (patch?.landed?.kind ?? null) === from) return null;
  }
  return null;
}

/** How long a claim to post a merge's cue holds before another poster may take it over. */
export const MERGED_CUE_LEASE_MS = 60_000;

/** Newer by creation, the id breaking a tie: the order a branch's patches were sent in. */
const isNewer = (a: Patch, b: Patch) =>
  a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);

/**
 * The cue a merge owes the run for one patch, if it is owed: claimed first, so of several
 * deliveries racing to tell the run only one posts; posted with where the repo's landing put it;
 * and marked only once it was (or once nobody is left to tell). A merged patch's cue is the
 * runner's signal to fetch where it merged and the agent's to rebase; a missed one's tells the
 * run its commits are not in the merge. Only
 * the NEWEST patch of each verdict per run, path, line and generation is ever posted — an older one is
 * marked without a post — so a run hears of a merged or a missed branch once. The merged cue
 * names the runner's landed head (`PatchPayload.landedHead`): its own head, since only the newest
 * of the generation's that merged is posted. A merged head is in what merged, or its change is
 * exactly what merged, both ways (forge helpers/containment.ts), so the agent's rebase may start
 * past it. A missed cue carries `onto` only when no patch of its generation merged: then
 * it is the cue that the generation is over, and it waits
 * while another patch of the generation is still being delivered, or waits for its verdict on
 * the same change request, which may yet be `merged`. A cue that could not be posted keeps its
 * claim until the lease lapses, and the submit sweep posts it then. A crash between the post and
 * the mark can still post it twice; the runner takes a repeat as no news. Answers whether it is
 * still owed.
 *
 * Never before the landing: a merge's cue always carries the `onto` the forge's merge recorded
 * (core/landing.ts). One whose task holds no landing for the path at the patch's generation yet
 * — the settle was written, the landing not (yet) — waits, unclaimed, for a later tick; marked
 * now, the cue would go out without `onto` and no corrected one would ever follow. A run that is
 * over is marked at once, landing or not: nothing would ever be posted to it. `snapshot`:
 * the task's patches as the caller already read them, saving the read.
 */
export async function cueMerged(
  deps: LandingRuleDeps,
  patchId: string,
  at: string,
  snapshot?: readonly Patch[],
) {
  const patch = await deps.store.getPatch(patchId);
  const kind = patch?.landed?.kind;
  if (patch === null || (kind !== "merged" && kind !== "missed") || patch.mergedCuedAt !== null) {
    return false;
  }
  const siblings = (snapshot ?? await deps.store.patchesForTask(patch.taskId)).filter((p) =>
    p.id !== patch.id && p.runId === patch.runId && p.connectedRepoId === patch.connectedRepoId &&
    p.path === patch.path && p.line === patch.line && p.generation === patch.generation
  );
  // Every mark is over the verdict cued here: a revision since (missed → merged) owes its own.
  if (siblings.some((p) => p.landed?.kind === kind && isNewer(p, patch))) {
    await deps.store.markPatchMergedCued(patch.id, at, { kind });
    return false;
  }
  const task = await deps.store.getTask(patch.taskId);
  if (task === null) {
    await deps.store.markPatchMergedCued(patch.id, at, { kind });
    return false;
  }
  // Nobody left to tell, landing or not: marked now, or the outbox would keep it forever.
  const run = await deps.store.getRun(patch.runId);
  if (run === null || isTerminal(run)) {
    await deps.store.markPatchMergedCued(patch.id, at, { kind });
    return false;
  }
  if (!hasLanding(task.landings, patch)) return true;
  // A missed patch ends its generation only where nothing of it merged, and a sibling still on
  // its way to a change request, or waiting for its verdict on THIS one, may yet be the one that
  // did. One waiting on another change request (a reopened pull request merged, while the run's
  // newer patch is open on a fresh one) is judged by that one's merge, never by this.
  const ends = kind === "missed" && !siblings.some((p) => p.landed?.kind === "merged");
  // One that does not end it says its commits go out on top of what merged: never before the
  // runner holds the merged cue that says what that is.
  if (
    kind === "missed" && !ends &&
    siblings.some((p) => p.landed?.kind === "merged" && p.mergedCuedAt === null)
  ) return true;
  if (
    ends &&
    siblings.some((p) =>
      p.state === "submitting" ||
      (p.state === "submitted" && p.landed === null && p.forgeRef === patch.forgeRef)
    )
  ) return true;
  const staleBefore = new Date(Date.parse(at) - MERGED_CUE_LEASE_MS).toISOString();
  if (!await deps.store.claimMergedCue(patch.id, at, staleBefore)) return true;
  const onto = kind === "merged" || ends ? cueOnto(task.landings, patch) : undefined;
  const told = await notifyPatch(
    deps,
    patch,
    kind,
    null,
    onto,
    kind === "merged" ? { landedHead: patch.headSha } : {},
  );
  if (told === "failed") return true;
  // Over the claim too: a revision cleared it, and the cue it owes is not this one.
  await deps.store.markPatchMergedCued(patch.id, at, { kind, claimedAt: at });
  return false;
}

/** Oldest first, by creation and then id. */
const oldestFirst = (patches: readonly Patch[]) =>
  patches.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

/**
 * After a merge's verdicts: every patch of the change request the merge settled (merged or
 * missed) whose landing is still owed (`landingAskedAt` null) is landed — the merged ones first,
 * so a generation's landing is recorded off a patch that merged where one did — then the waiting
 * siblings each one caught are ruled on, then the run is cued, newest head first. Every step is a
 * conditional write, so a repeat repeats nothing; and every owed one is landed, settled by this
 * call or not, since one a racing settle wrote may still owe its landing. One whose landing was
 * answered is never landed, ruled or cued again here (a revision clears the answer). Memory is
 * told of the patches this call settled (`settled`) only after the cues, so a slow memory service
 * does not keep a cue waiting on it.
 *
 * A missed patch is landed too: its change request merged, so the repo moves onto where it
 * merged and a change request the task worked is let go, whether or not the merge holds any of
 * the run's commits. Where none of a generation's patches merged, that landing is what its
 * missed cue carries, and the agent moves the whole generation's work onto it.
 */
async function landRuleAndCue(
  deps: LandingRuleDeps,
  patches: readonly Patch[],
  settled: ReadonlyMap<string, Patch>,
  merge: { mergedInto: string | undefined; defaultBranch: string; intoTip?: string },
  at: string,
): Promise<void> {
  // Only the patches whose landing is still owed: one already answered was landed, ruled and
  // cued (or left in the cue outbox) then, and asking again would land it a second time — for a
  // merge from before the landings, say, whose task never recorded one. An owed one a failure
  // left behind is the landing reconcile's as well as this call's: a second landing of a
  // generation is kept, not written.
  const judged = oldestFirst(
    patches.filter((p) => isMergeVerdict(p.landed) && p.landingAskedAt === null),
  );
  const ordered = [
    ...judged.filter((p) => p.landed?.kind === "merged"),
    ...judged.filter((p) => p.landed?.kind !== "merged"),
  ];
  // A landing that throws is left owed, to the landing reconcile and its cooldown, and the rest
  // go on: it never makes the whole step throw, which would push the record back for nothing.
  for (const read of ordered) {
    await landOne(deps, read, patches, merge, at).catch((err) =>
      deps.diag.warn("patch.merge_landing_failed", { patchId: read.id, err: String(err) })
    );
  }
  // One read of each task's patches for everything below, read again only after a write the
  // rule made (or lost) changed it.
  const snapshots = new Map<string, readonly Patch[]>();
  const snapshotOf = async (taskId: string) => {
    let read = snapshots.get(taskId);
    if (read === undefined) {
      read = await deps.store.patchesForTask(taskId);
      snapshots.set(taskId, read);
    }
    return read;
  };
  // What the merge caught, before the run is told: a cue that arrived first could have the
  // runner submit a patch the rule then has to hold.
  for (const read of judged) {
    if (await settleLandedSiblings(deps, read, at, await snapshotOf(read.taskId))) {
      snapshots.delete(read.taskId);
    }
  }
  // The merged cues first, newest first, then the missed ones, read again: a missed note that
  // says its commits go out on top of what merged waits for the merged cue (`cueMerged`).
  const newestFirst = judged.toReversed();
  for (const read of newestFirst.filter((p) => p.landed?.kind === "merged")) {
    await cueMerged(deps, read.id, deps.now().toISOString(), await snapshotOf(read.taskId));
  }
  snapshots.clear();
  for (const read of newestFirst.filter((p) => p.landed?.kind !== "merged")) {
    await cueMerged(deps, read.id, deps.now().toISOString(), await snapshotOf(read.taskId));
  }
  // Memory last, so a slow memory service never holds a cue back: a report lost to a crash
  // before it is the memory-fate sweep's (core/reaper.ts `sweepMemoryFates`).
  for (const read of ordered) {
    const now = settled.get(read.id);
    const fate = now === undefined ? null : patchFateForMemory(now);
    if (now !== undefined && fate !== null) await reportPatchFate(deps, now, fate);
  }
}

/**
 * One merged (or missed) patch's landing (core/landing.ts), written by the store with the patch's
 * `landingAskedAt` in the same transaction; a change request let go but not landed tells the
 * task's live runs in words. `patches`: the change request's patches as the caller read them.
 */
async function landOne(
  deps: LandingRuleDeps,
  read: Patch,
  patches: readonly Patch[],
  merge: { mergedInto: string | undefined; defaultBranch: string; intoTip?: string },
  at: string,
): Promise<void> {
  const { outcome } = await deps.store.landMerge({
    patch: read,
    mergedInto: merge.mergedInto,
    defaultBranch: merge.defaultBranch,
    ...(merge.intoTip === undefined ? {} : { intoTip: merge.intoTip }),
    at,
  });
  if (outcome.kind === "released") {
    // Let go, but not landed: no cue will come. The task's live runs are told in words, once
    // (the task no longer targets the change request, so a repeat lands nothing and says
    // nothing): its current run, and every run with a patch on this change request.
    // `notifyText` skips a run that is over.
    const runs = new Set(
      patches.filter((p) => p.taskId === read.taskId).map((p) => p.runId),
    );
    const current = (await deps.store.runsForTask(read.taskId)).at(-1);
    if (current !== undefined) runs.add(current.id);
    for (const runId of runs) await notifyText(deps, runId, releasedNote(read.path));
  }
  if (outcome.kind === "landed") {
    deps.diag.debug("patch.merge_landed", {
      taskId: read.taskId,
      thread: read.forgeRef,
      onto: outcome.landing.onto,
    });
  }
}

/**
 * The branch a merged change request merged into, as the forge named it: GitHub says, in the
 * event; Radicle's patches always merge into the repo's default branch, which its connected row
 * holds. Undefined when it did not say. Held to the checkout rules where it is used
 * (core/landing.ts), never here: a name the rules refuse must not cost the merge itself.
 */
export function mergedBranchOf(
  event: Pick<InboundForgeEvent, "merged">,
  repo: Pick<ConnectedRepo, "provider" | "defaultBranch">,
): string | undefined {
  return event.merged?.baseRef ?? (repo.provider === "radicle" ? repo.defaultBranch : undefined);
}

/** A change request's end as a `change_request.merged`/`.closed` event says it: its ref, and for
 * a merge what merged and the branch it merged into when the forge said. */
export interface ChangeRequestEnd extends Pick<InboundForgeEvent, "merged"> {
  kind: "change_request.merged" | "change_request.closed";
  ref: string;
}

export interface MergeSettleDeps extends LandingRuleDeps {
  forge: Pick<Forge, "mergeContainment" | "fetchChangeRequestHead">;
}

export interface ChangeRequestEndDeps extends LandingRuleDeps {
  checks?: Pick<ChecksService, "changeRequestEnded"> | null;
}

/**
 * A change request merged or closed, by whichever door said so: the forge's event
 * (http/forge_api.ts) or, where the forge delivers none, the merge poll (core/merge_poll.ts),
 * which builds the same event from the forge's own read. Its push requests are withdrawn; then
 * a merge is RECORDED and nothing more — recorded also where no patch reached it yet but a live
 * run works it, or a task targets it, since their push may be on its way and the record is what
 * lets such a task go. Judging, landing, cueing and releasing are the submit sweep's
 * (`reconcileMergeSettles`, core/merge_release.ts `reconcileMergeReleases`), from the record,
 * so the forge's delivery is answered in the time a row takes to write, and a slow forge never
 * holds the mailroom. A close settles each patch, tells memory it was dropped and its run that
 * it closed. Every step is a conditional write, so a repeat repeats nothing.
 */
export async function settleChangeRequestEnd(
  deps: ChangeRequestEndDeps,
  repo: ConnectedRepo,
  event: ChangeRequestEnd,
): Promise<"no-such-patch" | "patch-settled"> {
  await deps.checks?.changeRequestEnded({ connectedRepoId: repo.id, ref: event.ref });
  // Oldest first, so a run hears of its patches in the order it sent them.
  const patches = oldestFirst(await deps.store.patchesByRepoAndForgeRef(repo.id, event.ref));
  const at = deps.now().toISOString();
  if (event.kind === "change_request.merged") {
    if (
      patches.length === 0 &&
      await deps.store.findLiveRunOnChangeRequest(repo.id, event.ref) === null &&
      (await deps.store.listTasksTargetingChangeRequest(repo.id, event.ref)).length === 0
    ) return "no-such-patch";
    await deps.store.recordChangeRequestMerge({
      connectedRepoId: repo.id,
      forgeRef: event.ref,
      mergedInto: mergedBranchOf(event, repo),
      heads: event.merged?.heads ?? [],
      at,
    });
    return patches.length === 0 ? "no-such-patch" : "patch-settled";
  }
  if (patches.length === 0) return "no-such-patch";
  // A change request that merged is its merge record's to judge: a close heard after (or
  // alongside) it leaves every patch that record still owes a verdict alone, or a late push the
  // merge contains would be settled `closed` and never judged. The close is written only while
  // no merge is recorded at the write itself: a merge recorded after this read, and settled
  // before the write, would otherwise leave a late push closed for good.
  const merge = await deps.store.getChangeRequestMerge(repo.id, event.ref);
  // Every patch behind the change request is settled, but its run hears of the close once per
  // line: from the newest patch that settled (later in `patches`), as a merge's cue is posted
  // only for the newest. A branch submitted twice is two patches on one change request.
  const toTell = new Map<string, Patch>();
  for (const read of patches) {
    if (merge !== null && owesMergeVerdict(read, merge)) continue;
    const settled = await settleOnce(deps.store, read, "closed", at, undefined, {
      unlessMergeRecorded: true,
    });
    if (settled === null) continue;
    await reportPatchFate(deps, settled, "dropped");
    toTell.set(JSON.stringify([settled.runId, settled.path, settled.line]), settled);
    deps.diag.debug("forge_event.patch_settled", { patchId: read.id, fate: "closed" });
  }
  for (const settled of toTell.values()) await notifyPatch(deps, settled, "closed");
  return "patch-settled";
}

/** What one ask of the forge came back with: git's containment answer (or why there is none),
 * or — for a merge that named no head — the heads the forge's read of the change request says
 * merged, which grow the record before containment is asked. */
type MergeAnswer =
  | { kind: "containment"; outcome: MergeContainmentOutcome }
  | { kind: "heads"; heads: string[] };

/**
 * The forge's answer to which of `asked`'s heads the merge contains, in one question, each head
 * with the base its patch was built on when the patch records one (the forge judges the head's
 * own work from it); for a merge that named no head, the forge's read of what merged instead.
 * Never throws: a throw is no answer.
 */
async function askForge(
  deps: MergeSettleDeps,
  repo: ConnectedRepo,
  merge: ChangeRequestMerge,
  ask: { mergedHeads: string[]; asked: readonly Pick<Patch, "headSha" | "baseSha">[] },
): Promise<MergeAnswer> {
  const { mergedHeads, asked } = ask;
  try {
    if (merge.heads.length === 0) {
      const read = await deps.forge.fetchChangeRequestHead(forgeRepoRef(repo), merge.forgeRef);
      if (read.kind === "head" && read.head.merged && read.head.mergedHeads.length > 0) {
        return { kind: "heads", heads: read.head.mergedHeads };
      }
      return {
        kind: "containment",
        outcome: {
          kind: "unavailable",
          message: read.kind === "unavailable"
            ? "the forge could not read the change request"
            : "the forge named no merged head",
        },
      };
    }
    const heads = [...new Set(asked.map((p) => p.headSha))];
    const bases: Record<string, string> = {};
    for (const p of asked) if (p.baseSha !== null) bases[p.headSha] = p.baseSha;
    const outcome = await deps.forge.mergeContainment(
      forgeRepoRef(repo),
      repo.url,
      mergedHeads,
      heads,
      bases,
      merge.mergedInto ?? undefined,
    );
    return { kind: "containment", outcome };
  } catch (err) {
    return { kind: "containment", outcome: { kind: "unavailable", message: String(err) } };
  }
}

/** Where the patches of a merge are landed: the forge's word, and the repo's default. */
const mergeTarget = (merge: ChangeRequestMerge, repo: ConnectedRepo) => ({
  mergedInto: merge.mergedInto ?? undefined,
  defaultBranch: repo.defaultBranch,
});

/**
 * THE settle of a merged change request against its merge record — only ever from the settle
 * reconcile. Every patch on it that owes a verdict (core/merge_record.ts `owesMergeVerdict`) is
 * judged by git's containment, asked of the forge in one question: `merged` when the merge holds
 * its head, `missed` when it does not. Then every judged patch is landed, ruled and cued
 * (`landRuleAndCue`).
 *
 * One ask across processes at a time: the ask's deadline is stamped on the record first, over
 * the version this call read, and the version moves on with it, so a sweep elsewhere that read
 * the same record loses the write and asks nothing. An ask that outlives its deadline (a hung
 * forge, a process gone) is simply asked again by the next sweep. Every later stamp is over the
 * record as this ask left it, so a merge that named a new head meanwhile (which moves the version
 * on and makes the record due again) is never marked settled by an answer about fewer heads; the
 * verdicts that answer gave stand, and the record is asked again — landed, ruled and cued only by
 * the settle that judges every head.
 *
 * No answer settles nothing: the record asks again on a backoff (`judgeMerge`), and only once its
 * asks run out does every patch still owing settle `missed`, unproven — never `merged`, which
 * would skip commits nobody saw merge. A merge that named no head first has the forge read what
 * merged off the change request, which grows the record; a read that names none is no answer.
 */
async function settleMerge(
  deps: MergeSettleDeps,
  repo: ConnectedRepo,
  merge: ChangeRequestMerge,
): Promise<void> {
  const { store } = deps;
  const at = deps.now().toISOString();
  // A clock ahead is an ask under way (or a backoff): it is that ask's, never a second one's.
  if (merge.nextAskAt !== null && merge.nextAskAt > at) return;
  const patches = oldestFirst(await store.patchesByRepoAndForgeRef(repo.id, merge.forgeRef));
  const owing = patches.filter((p) => owesMergeVerdict(p, merge));
  if (owing.length === 0) {
    // Nothing waits on the forge: the record is settled, with no ask clock.
    // A stamp that lost means another sweep moved the record on meanwhile (or it grew): that
    // settle lands, rules and cues what is owed, never this one.
    if (
      (merge.settledAt === null || merge.nextAskAt !== null) &&
      !await store.stampChangeRequestMerge(repo.id, merge.forgeRef, merge, {
        settledAt: merge.settledAt ?? at,
        attempts: 0,
        nextAskAt: null,
      })
    ) return;
    await landRuleAndCue(deps, patches, new Map(), mergeTarget(merge, repo), at);
    return;
  }
  const deadline = new Date(deps.now().getTime() + MERGE_ASK_DEADLINE_MS).toISOString();
  const claim = { settledAt: merge.settledAt, attempts: merge.attempts, nextAskAt: deadline };
  if (
    !await store.stampChangeRequestMerge(repo.id, merge.forgeRef, merge, { ...claim, asking: true })
  ) {
    return;
  }
  const asked = { version: merge.version + 1, ...claim };
  // At most what one question may hold (`mergeAsk`). The record is settled after the answer all
  // the same: a never-judged patch left over owes its verdict anyway (a later sweep asks it), and
  // one judged before keeps its verdict — missed or closed, which loses nothing.
  const question = mergeAsk(merge, owing);
  const answer = await askForge(deps, repo, merge, question);
  if (answer.kind === "heads") {
    // The record grows, which makes it due again: the next sweep asks containment against them.
    deps.diag.debug("patch.merge_heads_read", { thread: merge.forgeRef });
    await store.recordChangeRequestMerge({
      connectedRepoId: repo.id,
      forgeRef: merge.forgeRef,
      mergedInto: undefined,
      heads: answer.heads,
      at,
    });
    return;
  }
  // The verdicts' time is the answer's, never the ask's: the landing reconcile leaves a verdict
  // to its settle for `LANDING_GRACE_MS` from it, and an ask may have taken most of that.
  const judgedAt = deps.now().toISOString();
  const judged = judgeMerge(question.asked, answer.outcome, merge.attempts, judgedAt);
  if (judged.kind === "retry") {
    deps.diag.warn("patch.merge_containment_unanswered", {
      thread: merge.forgeRef,
      attempts: judged.attempts,
      why: judged.lastError,
    });
    await store.stampChangeRequestMerge(repo.id, merge.forgeRef, asked, {
      settledAt: merge.settledAt,
      attempts: judged.attempts,
      nextAskAt: judged.nextAskAt,
    });
    return;
  }
  const settled = new Map<string, Patch>();
  for (const patch of question.asked) {
    const verdict = judged.verdicts.get(patch.id);
    if (verdict === undefined) continue;
    if (patch.landed?.kind === verdict.fate) {
      // The same fate again: nothing to settle, but a miss nobody could prove is proven now.
      if (verdict.fate === "missed" && !verdict.unproven && patch.landed.unproven === true) {
        await store.markMissedProven(patch.id, judgedAt);
      }
      continue;
    }
    const now = await settleOnce(store, patch, verdict.fate, judgedAt, {
      mergedInto: merge.mergedInto ?? undefined,
      unproven: verdict.unproven,
    });
    if (now === null) continue;
    settled.set(patch.id, now);
    deps.diag.debug("patch.merge_judged", {
      patchId: patch.id,
      thread: merge.forgeRef,
      fate: verdict.fate,
      unproven: verdict.unproven,
    });
  }
  // A stamp that lost means the record grew meanwhile: the settle it is due for judges against
  // every head and lands, rules and cues what is owed then. Cued now, a missed patch would be
  // told so against fewer heads.
  if (
    !await store.stampChangeRequestMerge(repo.id, merge.forgeRef, asked, {
      settledAt: judgedAt,
      attempts: 0,
      nextAskAt: null,
    })
  ) return;
  // Read again whatever this call settled: a verdict another ask wrote since `patches` was read
  // is landed, ruled and cued here too, never left to the landing reconcile.
  // With the tip the forge read of where it merged, which the landing records (`RepoLanding.tip`).
  const intoTip = answer.outcome.kind === "answered" ? answer.outcome.intoTip : undefined;
  await landRuleAndCue(
    deps,
    oldestFirst(await store.patchesByRepoAndForgeRef(repo.id, merge.forgeRef)),
    settled,
    { ...mergeTarget(merge, repo), ...(intoTip === undefined ? {} : { intoTip }) },
    judgedAt,
  );
}

/** How many due merge records the settle reconcile takes up in one sweep. */
const MERGE_SETTLE_BATCH = 10;
/** How long a merge record whose settle threw waits before it is due again. */
export const MERGE_SETTLE_RETRY_MS = 5 * 60_000;
/** How long one sweep waits, in all, on the settles it started: one still asking the forge then
 * finishes on its own, and the record's deadline keeps every other sweep off it meanwhile. */
const SETTLE_SWEEP_WAIT_MS = 2_000;

/**
 * The only place a merge is settled, on every submit sweep: every record due
 * (`listChangeRequestMergesDue`) — a merge recorded and not yet settled, one whose ask ran past its
 * deadline or whose backoff is over, and a settled one that a push reached after its merge was
 * recorded (the push was in flight when the merge was heard), whatever task the push belongs to —
 * is settled (`settleMerge`). So a late patch the merge contains is settled, landed onto the
 * record's branch — the forge's word, never another task's inference — ruled and cued, and one it
 * does not is `missed`. The records are settled side by side, and the sweep waits on them
 * `waitMs` in all: a slow forge costs the submit sweep that much a tick at most. A record whose
 * settle threw is due again only `MERGE_SETTLE_RETRY_MS` later, so it never holds the rest out of
 * the batch. Never throws.
 */
export async function reconcileMergeSettles(
  deps: MergeSettleDeps,
  opts: { waitMs?: number } = {},
): Promise<void> {
  const due = await deps.store.listChangeRequestMergesDue(
    deps.now().toISOString(),
    MERGE_SETTLE_BATCH,
  ).catch((err) => {
    deps.diag.warn("reaper.merge_settles_unlisted", { err: String(err) });
    return [];
  });
  const settles = due.map(async (merge) => {
    try {
      const repo = await deps.store.getConnectedRepo(merge.connectedRepoId);
      if (repo !== null) await settleMerge(deps, repo, merge);
    } catch (err) {
      deps.diag.warn("reaper.merge_settle_failed", { thread: merge.forgeRef, err: String(err) });
      // Its clock moves on, over the record as it stands now (the settle may have stamped it
      // before it threw). One whose clock lies ahead (an ask under way elsewhere, a backoff) is
      // left to it.
      const now = deps.now();
      try {
        const fresh = await deps.store.getChangeRequestMerge(merge.connectedRepoId, merge.forgeRef);
        if (fresh !== null && (fresh.nextAskAt === null || fresh.nextAskAt <= now.toISOString())) {
          await deps.store.stampChangeRequestMerge(merge.connectedRepoId, merge.forgeRef, fresh, {
            settledAt: fresh.settledAt,
            attempts: fresh.attempts,
            nextAskAt: new Date(now.getTime() + MERGE_SETTLE_RETRY_MS).toISOString(),
          });
        }
      } catch {
        // the next sweep meets it again
      }
    }
  });
  if (settles.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(settles),
    new Promise<void>((
      resolve,
    ) => (timer = setTimeout(resolve, opts.waitMs ?? SETTLE_SWEEP_WAIT_MS))),
  ]);
  clearTimeout(timer);
}

/** How many owed landings one sweep writes at most. */
const LANDING_BATCH = 20;
/** How long after its settle a merge's landing is left to the settle that wrote it: that one
 * lands it in the same step, so the reconcile only takes what it left behind. */
export const LANDING_GRACE_MS = 60_000;
/** How long a landing that threw is left alone before the reconcile asks it again. */
export const LANDING_COOLDOWN_MS = 5 * 60_000;
/** How many landings that threw are skipped over at most, so the listing stays bounded. */
const LANDING_COOLDOWN_CAP = 200;
/** This process's landings that threw, by patch id: when each may be asked again. Per process
 * and lost with a restart, which only asks one again sooner. */
const landingCooldown = new Map<string, number>();

/**
 * The landing's backstop, on every submit sweep: a merged (or missed) patch whose landing is
 * still owed (`landingAskedAt` null) — its settle was written, and the landing after it failed: a
 * database error, deadlock retries spent, a restart in between — is landed now, onto the branch
 * its settle kept (`PatchFate.mergedInto`), then the rule asked of its run's waiting siblings,
 * then its cue tried; the outbox takes a cue that could not be posted. The settle reconcile steps
 * a settled record again only for a late push, so it may never come back for one. A patch whose
 * merge record is unsettled is left alone: its verdict may have been written against fewer heads
 * than the record names now, and the settle that judges every head lands it.
 *
 * Bounded: `LANDING_BATCH` a sweep, oldest first (the merged ones landed before the missed), over
 * a partial index of the owed ones; and
 * only one settled `LANDING_GRACE_MS` ago or earlier, so a settle still on its way from verdict
 * to landing is not raced. Every answer of the store stamps the patch — landed, kept, released, or
 * none for a repo the task no longer holds — so nothing is asked twice but a landing that threw,
 * which this process asks again only
 * `LANDING_COOLDOWN_MS` later: one that always throws never keeps a newer owed landing
 * out of the batch. A settle racing it is safe: the landing is
 * written under the run's and the task's row locks, and a second one of the same generation is
 * kept, not written. Never throws.
 */
export async function reconcileMergedLandings(deps: LandingRuleDeps): Promise<void> {
  const nowMs = deps.now().getTime();
  for (const [id, until] of landingCooldown) if (until <= nowMs) landingCooldown.delete(id);
  const settledBefore = new Date(nowMs - LANDING_GRACE_MS).toISOString();
  const skipped = Math.min(landingCooldown.size, LANDING_COOLDOWN_CAP);
  const listed = await deps.store.listPatchesAwaitingLanding(LANDING_BATCH + skipped, settledBefore)
    .catch((err) => {
      deps.diag.warn("reaper.merged_landings_unlisted", { err: String(err) });
      return [];
    });
  const due = listed.filter((p) => !landingCooldown.has(p.id)).slice(0, LANDING_BATCH);
  // The merged ones first, as the settle lands them, so a generation's landing is recorded off a
  // patch that merged where one did.
  for (
    const read of [
      ...due.filter((p) => p.landed?.kind === "merged"),
      ...due.filter((p) => p.landed?.kind !== "merged"),
    ]
  ) {
    try {
      if (read.landed === null || !isMergeVerdict(read.landed)) continue;
      const repo = await deps.store.getConnectedRepo(read.connectedRepoId);
      const at = deps.now().toISOString();
      // A merge's patch always reached its forge; one that somehow did not is still answered
      // (nothing to land), so it never stays listed.
      const siblings = read.forgeRef === null
        ? [read]
        : await deps.store.patchesByRepoAndForgeRef(read.connectedRepoId, read.forgeRef);
      await landOne(deps, read, siblings, {
        mergedInto: read.landed.mergedInto,
        // A repo gone since: no default branch to fall back on, so only the forge's word or the
        // task's recorded base can land it.
        defaultBranch: repo?.defaultBranch ?? "",
      }, at);
      deps.diag.debug("patch.merge_landed_late", { patchId: read.id, thread: read.forgeRef });
      // Settle → land → rule → cue, as the settle does it.
      await settleLandedSiblings(deps, read, at);
      await cueMerged(deps, read.id, deps.now().toISOString());
    } catch (err) {
      landingCooldown.set(read.id, deps.now().getTime() + LANDING_COOLDOWN_MS);
      deps.diag.warn("reaper.merged_landing_failed", { patchId: read.id, err: String(err) });
    }
  }
}

/** How many owed cues one sweep posts at most. */
const CUE_BATCH = 50;
/** How many cues of ended runs one sweep marks at most. */
const ENDED_BATCH = 100;

/**
 * The cue outbox's drain, on the submit sweep's tick: the cues of runs that ended since their
 * merge are marked, then every merged or missed patch whose live run was never told is cued —
 * the merged ones first, then the missed, each newest head first, as the settle cues them. A cue
 * still waiting (on a sibling, or a post that failed) is simply asked again on a later tick. A
 * patch whose merge record is unsettled is the settle's to cue, once it judged every head.
 * Never throws.
 */
export async function sweepMergedCues(deps: LandingRuleDeps): Promise<void> {
  await deps.store.markMergedCuesOfEndedRuns(ENDED_BATCH, deps.now().toISOString()).catch(
    (err) => deps.diag.warn("reaper.merged_cues_unmarked", { err: String(err) }),
  );
  const staleBefore = new Date(deps.now().getTime() - MERGED_CUE_LEASE_MS).toISOString();
  const owed = await deps.store.listPatchesAwaitingMergedCue(CUE_BATCH, staleBefore)
    .catch((err) => {
      deps.diag.warn("reaper.merged_cues_unlisted", { err: String(err) });
      return [];
    });
  const newestFirst = owed.toReversed();
  for (
    const patch of [
      ...newestFirst.filter((p) => p.landed?.kind === "merged"),
      ...newestFirst.filter((p) => p.landed?.kind !== "merged"),
    ]
  ) {
    await cueMerged(deps, patch.id, deps.now().toISOString()).catch((err) =>
      deps.diag.warn("reaper.merged_cue_failed", { patchId: patch.id, err: String(err) })
    );
  }
}

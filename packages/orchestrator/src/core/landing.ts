// Landing a merge: a change request a run's patch went into MERGED, and from here that repo's
// work belongs on the branch it merged into. Every merge does this, whoever opened the change
// request: a run's own pull request that merged into its base leaves the repo where it was; a
// change request the task was working (a `/ryph` on a pull request, the app's "work on #N" door,
// a mid-run checkout — core/retarget.ts is how it got there) moves the repo off its head branch,
// which the forge may have deleted on merge; and a stacked pull request that GitHub retargeted
// when its base merged follows to where it really went.
//
// Pure. The store applies it under the run's and the task's row locks and writes everything it
// decides in one transaction (`TaskStore.landMerge`); the forge event decides WHEN. This decides
// WHAT MOVES:
//
// - for the default line, `task.repos[i].ref` becomes the branch it merged into, and its
//   `targetRef` goes: the submit sweep anchors the next pull request on `ref` (core/reaper.ts
//   `baseBranch`), and the gateway serves `ref` before it answers any fetch of the run's clone,
//   so a grant still naming a deleted head fails EVERY fetch until this lands;
// - `task.targetChangeRequest` is cleared when it names this change request — it is done with,
//   and the forge refuses a push onto a merged one for good;
// - `run.workItem.repos[i]` moves the same way while the run is live, so the frozen spec and the
//   task agree about where the repo stands;
// - `task.landings[path][<line key>]` records it (`landingKey`: the default line by its name,
//   any other by `<runId>/<line>`, since a line's name is its run's): the change request, the branch, the generation. Every
//   merged cue's `onto` is read from this record, never from whether its delivery was the one that
//   moved anything, so redeliveries, concurrent deliveries and a crash before the cue all say the
//   same.
//
// PER LINE vs PER PATH. A repo of a run may ship several independent LINES (@ryph/shared/lines),
// each its own branch, generations and change request. What a merge records is the LINE's: its
// landing (where that line's next generation starts, and the generation that ended), and with it
// every rule that reads one — the merged cue, the landing rule, the release cue. A sibling
// line's record, generation and waiting patches are never touched by it. Only the DEFAULT line's
// merge (and so the merge of the change request the task worked, which only the default line
// ever pushes onto — core/patch_lifecycle.ts `submissionTarget`) moves the PATH: `task.repos[i]`
// and the run's spec entry, which the default line is based on and the gateway serves. Any other
// line's merge moves that line alone: its next base is its own landing's `onto` (`lineBase`), the
// same branch its merged cue names and its runner fetches for its agent to rebase onto. Moving
// the path for it would open every other line's next change request against a branch only that
// one line went to, and, in a task working a change request, drop the target base while the task
// still targets it.
//
// WHERE is the forge's word at the merge (GitHub's base; Radicle's patches always merge into the
// default branch). Only when the forge did not say, or named a branch the rules refuse, is it
// inferred: the base the task recorded for the change request it worked, else the repo's own
// base for a pull request the run opened against it, else the repo's default branch. Every one
// of them, the forge's word included, must be a branch a checkout can stand on and must not be
// one the run itself writes (its output branches) or a forge's change-request heads.
//
// WHEN NOT: a merge of an older generation of a line than the one its record holds (a late or
// re-sent event) never moves the repo back; and the first merge of a line's generation is the one
// recorded.
//
// Each list keeps its OWN spelling: a task entry may be qualified (`refs/heads/x`) or bare,
// while a work item's is always bare (core/start_task.ts). Each is written in the spelling its own
// `ref` already had (core/repo_entries.ts).
//
// What deliberately does NOT move is `run.forgeScope.origin`, and the run's origin columns: they
// say where the run may write and was commanded from, and the merged pull request is still a
// thread the run may answer in. Who holds the change request afterwards:
// `findLiveRunOnChangeRequest` reads it off the patches once the task no longer targets it — a
// merge only ever follows a patch of the run that went into it, whose `forgeRef` names it.

import { movedAt, rebased } from "./repo_entries.ts";
import { checkoutBranchOf, normalizeBaseRef } from "@ryph/shared/refs";
import { DEFAULT_LINE, MAX_LINES_PER_REPO } from "@ryph/shared/lines";
import type { Patch, RepoLanding, Run, RunEvent, Task } from "./types.ts";

/**
 * Where a line's landing is kept under its path in `task.landings`: the default line's under its
 * name, the task's whichever run landed it; any other line's under `<runId>/<line>`, its run's
 * alone. A line's name is the run's own — another run's `fix` is unrelated work that merely shares
 * the word — so one run's landing of it never overwrites, or is read as, another's. Unambiguous:
 * a line name holds no `/` (@ryph/shared/lines). SQL twin: `landingKeySql` (adapters/store/drizzle.ts).
 */
export function landingKey(line: string, runId: string): string {
  return line === DEFAULT_LINE ? line : `${runId}/${line}`;
}

/** The landing recorded for one line of the repo at `path`, if any, as run `runId` sees it: the
 * default line's whoever landed it, any other line's only when that run landed it
 * (`landingKey`). */
export function landingOf(
  landings: Task["landings"],
  path: string,
  line: string,
  runId: string,
): RepoLanding | undefined {
  return landings[path]?.[landingKey(line, runId)];
}

/** `landings` with `landing` recorded for one line of run `runId` in the repo at `path`
 * (`landingKey`), every other line's (and every other run's, and every other path's) as it was. */
export function withLanding(
  landings: Task["landings"],
  path: string,
  line: string,
  runId: string,
  landing: RepoLanding,
): Task["landings"] {
  return { ...landings, [path]: { ...landings[path], [landingKey(line, runId)]: landing } };
}

/**
 * The branch a FRESH change request of `line` is opened against in the repo `entry` checks out:
 * where that line's work is based. One answer for the submission, the diff a reviewer reads and
 * the held destination (core/patch_lifecycle.ts `submissionTarget`'s `baseBranch`), so none of
 * them can disagree with the runner about it.
 *
 * - The default line: the task's `ref`, which its landings move (`landMerge`). In a task that
 *   works a change request that is the change request's head, which `submissionTarget` pushes
 *   onto rather than opening anything against.
 * - Any other line: where its own last landing in run `runId` put it (another run's line of the
 *   same name is unrelated work, `landingOf`), else the branch the repo's work merges
 *   into — `targetRef` when the task works a change request (never that change request's head:
 *   the line is not it), else `ref`. The runner starts such a line there too
 *   (`git switch -c <name> origin/<targetRef ?? ref>`), and after a merge its agent rebases it
 *   onto its merged cue's `onto`, which is that landing's.
 * - Every line of a fork pull request's head (`forkHead`): its `ref`, `pull/<n>/head`. Only the
 *   default line ever ships there (core/open_patch.ts, core/reaper.ts), and should another line
 *   ever get as far as the forge, its base is still the fork's head, which the forge refuses for
 *   anything but that pull request — the backstop holds for every line, not just the default.
 *
 * As the entry spells it: qualified or bare, as `ref` is; a landing's `onto` is always bare.
 */
export function lineBase(
  entry: Pick<
    Task["repos"][number],
    "connectedRepoId" | "path" | "ref" | "targetRef" | "forkHead"
  >,
  landings: Task["landings"],
  line: string,
  runId: string,
): string {
  if (line === DEFAULT_LINE || entry.forkHead === true) return entry.ref;
  const landing = landingOf(landings, entry.path, line, runId);
  if (landing !== undefined && landing.connectedRepoId === entry.connectedRepoId) {
    return landing.onto;
  }
  return entry.targetRef ?? entry.ref;
}

/**
 * The branches lines of the repo `entry` checks out stand on after their own merges, other than
 * its `ref` and `targetRef`: what the gateway refreshes beside those two (the forge's
 * `RunGrantRepo.lineBases`), so a line's landing fetch of one sees it as it stands upstream. As
 * a spread: empty when there is none. Only lines other than the default — its landing moves
 * `ref` — and only run `runId`'s, the only ones its runner fetches (`landingOf`).
 */
export function lineBasesOf(
  entry: Pick<Task["repos"][number], "connectedRepoId" | "path" | "ref" | "targetRef">,
  landings: Task["landings"],
  runId: string,
): { lineBases?: string[] } {
  const known = [entry.ref, entry.targetRef].flatMap((ref) => {
    const local = localBranch(ref);
    return local === null ? [] : [local];
  });
  const bases = new Set<string>();
  // `landingKey`: every line of this run's other than the default is kept under `<runId>/<line>`.
  const own = `${runId}/`;
  for (const [key, landing] of Object.entries(landings[entry.path] ?? {})) {
    if (!key.startsWith(own) || landing.connectedRepoId !== entry.connectedRepoId) continue;
    if (!known.includes(landing.onto)) bases.add(landing.onto);
  }
  return bases.size === 0 ? {} : { lineBases: [...bases].slice(0, MAX_LINES_PER_REPO) };
}

export interface LandArgs {
  task: Task;
  /** The patch's run while it is live, else null: a terminal run's frozen spec is history. */
  run: Run | null;
  /** The patch that merged. Its repo, path, line, change request and generation decide what moves
   * and which line's landing is recorded. */
  patch: Pick<Patch, "connectedRepoId" | "path" | "line" | "forgeRef" | "runId" | "generation">;
  /** The branch the forge says it merged into, as the forge named it, or undefined when it said
   * nothing. Held to the checkout rules here. */
  mergedInto: string | undefined;
  /** The connected repo's default branch: where a Radicle patch, or a change request the task
   * worked that recorded no base, merged. */
  defaultBranch: string;
  /** The tip of `mergedInto` the forge read when it settled the merge, when it read one. */
  intoTip?: string;
  at: string;
  /** The branch namespace of the patch's run (`Run.branchNamespace`), live or not: a branch under
   * it is never one to land on. The task's entry names only its first run's. */
  runNamespace?: string;
}

export type LandOutcome =
  /** The repo is not in the task's checkout at that path, or the patch never reached the forge:
   * nothing to move and nothing to record. */
  | { kind: "none" }
  /** Recorded already, for this generation or a later one: nothing moves. */
  | { kind: "kept"; landing: RepoLanding }
  /** No branch passes the rules at all, not even the one the repo stands on: no landing is
   * recorded, but the change request the task worked is let go (`targetChangeRequest` null),
   * written with the event in one transaction. */
  | { kind: "released"; task: Task; event: RunEvent }
  | {
    kind: "landed";
    task: Task;
    /** The run's moved spec, or null when it was not given or nothing about its entry changes. */
    run: Run | null;
    landing: RepoLanding;
    /** Written in the same transaction, when the repo or the task's target moved. */
    event: RunEvent | null;
  };

const localBranch = (ref: string | undefined): string | null => {
  if (ref === undefined) return null;
  try {
    return normalizeBaseRef(ref).localBranch;
  } catch {
    return null;
  }
};

/**
 * `name` as a landing branch, or null when the rules refuse it. Every candidate, the forge's word
 * and each fallback alike, is held to the same rules: a name a checkout can stand on, and never
 * one under the run's own branch namespace (any line of it, or the namespace itself; the entry's,
 * which is the task's first run's, and the merged patch's run's) or a forge's
 * change-request head namespace (`pull/…`, `patches/…`) — the next patch is opened against it, and a base the run writes itself would let
 * it choose what its next change request is compared with, and GitHub adopt a change request it
 * never opened. Compared as git hosts on case-insensitive filesystems may store them: in any case.
 */
/** Any run's namespace, by its shape (`branchNameFor`: `ryph/<slug>/r-<id>`), or a branch under
 * one. The two namespaces named above are the ones in hand; this refuses the rest — another run
 * of the task, live while this one's merge lands, writes its own namespace as freely. */
const RUN_NAMESPACE_SHAPE = /^ryph\/[^/]+\/r-[0-9a-z]+(\/|$)/;

function usableBranch(
  entry: Task["repos"][number],
  name: string | null | undefined,
  runNamespace?: string,
): string | null {
  if (name === null || name === undefined) return null;
  const branch = checkoutBranchOf(name);
  if (branch === null) return null;
  const local = normalizeBaseRef(`refs/heads/${branch}`).localBranch;
  const folded = local.toLowerCase();
  // `HEAD` names whatever is checked out, never a branch to stand on.
  if (folded === "head") return null;
  const runs = [entry.branchNamespace as string | undefined, runNamespace].flatMap((n) =>
    n === undefined ? [] : [n.toLowerCase()]
  );
  if (
    runs.some((namespace) => folded === namespace || folded.startsWith(`${namespace}/`)) ||
    RUN_NAMESPACE_SHAPE.test(folded) ||
    /^(pull|patches|refs)\//.test(folded)
  ) {
    return null;
  }
  return local;
}

/** The landing's `tip`, when the forge read one of the very branch it lands onto. */
const tipOf = (args: LandArgs, onto: string): { tip?: string } =>
  args.intoTip !== undefined && localBranch(args.mergedInto) === onto ? { tip: args.intoTip } : {};

export function landMerge(args: LandArgs): LandOutcome {
  const { task, run, patch, mergedInto, defaultBranch, at } = args;
  if (patch.forgeRef === null) return { kind: "none" };
  const entry = task.repos.find((r) =>
    r.path === patch.path && r.connectedRepoId === patch.connectedRepoId
  );
  if (entry === undefined) return { kind: "none" };
  const recordedLanding = landingOf(task.landings, patch.path, patch.line, patch.runId);
  if (recordedLanding !== undefined && recordedLanding.generation >= patch.generation) {
    return { kind: "kept", landing: recordedLanding };
  }

  const target = task.targetChangeRequest;
  const worked = target !== null && target.connectedRepoId === patch.connectedRepoId &&
    target.thread === patch.forgeRef;
  const usable = (name: string | null | undefined) =>
    usableBranch(entry, name, args.runNamespace ?? run?.branchNamespace);
  // Another line's merge moves that line alone (the header's PER LINE vs PER PATH).
  if (patch.line !== DEFAULT_LINE && !worked) {
    return landLine(args, entry, usable);
  }
  const recorded = localBranch(entry.targetRef);
  const onto = usable(mergedInto) ?? usable(recorded) ??
    (worked ? null : usable(localBranch(entry.ref))) ?? usable(defaultBranch);
  // Nothing usable among the candidates (only possible when the default branch itself fails the
  // rules — the forge's word and the recorded base fall back to it): the repo stays where it is,
  // and the landing records the branch it stands on, held to the same rules, so the merge is
  // still recorded and the run still cued. A branch that fails them too records no landing; a
  // change request the task worked is still let go, with the event saying so, so the next patch
  // cannot be pushed onto the merged one.
  if (onto === null) {
    const stays = usable(localBranch(entry.ref));
    if (stays === null) {
      if (!worked) return { kind: "none" };
      return {
        kind: "released",
        task: { ...task, targetChangeRequest: null },
        event: {
          runId: patch.runId,
          at,
          kind: "merge-landed",
          detail: `#${patch.forgeRef} merged; ${patch.path} stays as it was, and the task no ` +
            "longer targets it",
        },
      };
    }
    const landing: RepoLanding = {
      connectedRepoId: patch.connectedRepoId,
      thread: patch.forgeRef,
      onto: stays,
      generation: patch.generation,
      moved: false,
      at,
      ...(patch.line === DEFAULT_LINE ? {} : { runId: patch.runId }),
      ...tipOf(args, stays),
    };
    return {
      kind: "landed",
      // A change request the task worked is done with, wherever the repo stands.
      task: {
        ...task,
        targetChangeRequest: worked ? null : target,
        landings: withLanding(task.landings, patch.path, patch.line, patch.runId, landing),
      },
      run: null,
      landing,
      // The task no longer targets the change request it worked: the trail says so.
      event: worked
        ? {
          runId: patch.runId,
          at,
          kind: "merge-landed",
          detail: `#${patch.forgeRef} merged; ${patch.path} stays on ${stays}, and the task no ` +
            "longer targets it",
        }
        : null,
    };
  }
  const ref = entry.ref.startsWith("refs/heads/") ? `refs/heads/${onto}` : onto;
  const moves = ref !== entry.ref || entry.targetRef !== undefined;
  const landing: RepoLanding = {
    connectedRepoId: patch.connectedRepoId,
    thread: patch.forgeRef,
    onto,
    generation: patch.generation,
    moved: moves || worked,
    at,
    ...(patch.line === DEFAULT_LINE ? {} : { runId: patch.runId }),
    ...tipOf(args, onto),
  };
  const specEntry = run?.workItem.repos.find((e) => e.path === patch.path);
  const specMoves = specEntry !== undefined &&
    (specEntry.ref !== onto || specEntry.targetRef !== undefined);
  const event: RunEvent | null = moves || worked
    ? {
      runId: patch.runId,
      at,
      kind: "merge-landed",
      detail: `#${patch.forgeRef} merged into ${onto}; ${patch.path} now on ${onto}` +
        (recorded !== null && recorded !== onto ? ` (the task had ${recorded})` : ""),
    }
    : null;
  return {
    kind: "landed",
    task: {
      ...task,
      repos: moves
        ? movedAt(task.repos, patch.path, (e) => rebased(e, ref, undefined))
        : task.repos,
      targetChangeRequest: worked ? null : target,
      landings: withLanding(task.landings, patch.path, patch.line, patch.runId, landing),
    },
    run: run === null || !specMoves ? null : {
      ...run,
      workItem: {
        ...run.workItem,
        repos: movedAt(run.workItem.repos, patch.path, (e) => rebased(e, onto, undefined)),
      },
      updatedAt: at,
    },
    landing,
    event,
  };
}

/**
 * `landMerge` for a line other than the default: the landing is recorded for the line, onto the
 * forge's word, else the line's own base (`lineBase`), else the default branch, by the same rules
 * — and nothing else moves. `moved` says whether the line's base changed.
 */
function landLine(
  args: LandArgs,
  entry: Task["repos"][number],
  usable: (name: string | null | undefined) => string | null,
): LandOutcome {
  const { task, patch, mergedInto, defaultBranch, at } = args;
  if (patch.forgeRef === null) return { kind: "none" };
  const base = localBranch(lineBase(entry, task.landings, patch.line, patch.runId));
  const onto = usable(mergedInto) ?? usable(base) ?? usable(defaultBranch);
  if (onto === null) return { kind: "none" };
  const moved = onto !== base;
  const landing: RepoLanding = {
    connectedRepoId: patch.connectedRepoId,
    thread: patch.forgeRef,
    onto,
    generation: patch.generation,
    moved,
    at,
    runId: patch.runId,
    ...tipOf(args, onto),
  };
  return {
    kind: "landed",
    task: {
      ...task,
      landings: withLanding(task.landings, patch.path, patch.line, patch.runId, landing),
    },
    run: null,
    landing,
    event: moved
      ? {
        runId: patch.runId,
        at,
        kind: "merge-landed",
        detail: `#${patch.forgeRef} merged into ${onto}; the ${patch.line} line of ${patch.path} ` +
          `now on ${onto}` + (base !== null ? ` (it was on ${base})` : ""),
      }
      : null,
  };
}

export interface ReleaseArgs {
  task: Task;
  /** The task's current run while it is live, else null; `runId` is that run's id either way,
   * the one the trail's event is written on. */
  run: Run | null;
  runId: string;
  /** Whether that run has a patch on the change request: then its landing lets the task go and
   * cues the run, and the release does nothing. */
  hasPatch: boolean;
  /** That run's patches of the repo, in any state: the release ends the run's current generation
   * of the default line at the path it moves (`releaseGeneration`). */
  runPatches: ReadonlyArray<{ path: string; line: string; generation: number }>;
  connectedRepoId: string;
  /** The change request that merged, `targetChangeRequest.thread`'s spelling. */
  thread: string;
  /** As `LandArgs`. */
  mergedInto: string | undefined;
  defaultBranch: string;
  at: string;
}

export type ReleaseOutcome =
  /** The task does not target that change request (any more), or its current run has a patch on
   * it: nothing to do. */
  | { kind: "none" }
  /** No branch passes the rules: the target is let go and the repo stays where it is. */
  | { kind: "released"; task: Task; event: RunEvent }
  /** The target is let go, the repo at `path` moved onto `onto`, and the run's `generation` of
   * the default line there recorded as ended (`RepoLanding.releasedRun`). */
  | {
    kind: "moved";
    task: Task;
    run: Run | null;
    path: string;
    onto: string;
    generation: number;
    event: RunEvent;
  };

/**
 * The run's current generation of the DEFAULT line at `path`, as its runner counts it: the newest
 * of its patches of that line there, in any state, else the first. The release cue names it, and
 * the runner takes the cue only in it. The default line, because only it works the task's change
 * request (core/patch_lifecycle.ts `submissionTarget`): a release ends nothing of any other.
 *
 * No landing of the run's own can be recorded there before it. The task targets the change
 * request, so every patch of the run's on that repo went onto it (`submissionTarget`), and the run
 * has none there; a target is only set at the task's start or by a re-target, which is refused
 * once the run has a patch on the repo, and which drops a release landing of the run's
 * (core/retarget.ts) since its runner starts the generation it then works afresh.
 */
export function releaseGeneration(
  path: string,
  runPatches: ReadonlyArray<{ path: string; line: string; generation: number }>,
): number {
  return Math.max(
    1,
    ...runPatches.filter((p) => p.path === path && p.line === DEFAULT_LINE).map((p) =>
      p.generation
    ),
  );
}

/**
 * A change request the task WORKS merged with nothing of its current run on it — a `/ryph` on a
 * pull request whose run had pushed nothing yet, or one checked out mid-run — so no landing of
 * that run's will ever let it go (`landMerge` follows a patch). Its merge record does instead
 * (core/merge_release.ts): the task stops targeting it, so its next patch opens a fresh change
 * request rather than being refused for good, and the repo that worked it moves onto where it
 * merged by the same rules and candidates as a landing — the forge's word, the base the task
 * recorded, the default branch — never the head branch it stood on, which the forge may have
 * deleted. Nothing of the run's merged, but its generation at the path is over all the same: a
 * landing is recorded marked as the run's release (`RepoLanding.releasedRun`), so the landing
 * rule holds or replaces the run's waiting patches of that generation, which were built on the
 * merged change request's head, as for any landed generation. The store appends the release cue
 * to a live run in the same transaction (`moved`): its agent moves the run's own commits onto
 * `onto`, and the next submit ships them as a new generation, so the fresh change request
 * carries nothing that merged.
 *
 * The entry moved is the one the targeting recorded a base on, else the first of that repo. Pure.
 */
export function releaseMergedTarget(args: ReleaseArgs): ReleaseOutcome {
  const { task, run, runId, connectedRepoId, thread, mergedInto, defaultBranch, at } = args;
  const target = task.targetChangeRequest;
  if (
    args.hasPatch || target === null || target.connectedRepoId !== connectedRepoId ||
    target.thread !== thread
  ) {
    return { kind: "none" };
  }
  const entries = task.repos.filter((r) => r.connectedRepoId === connectedRepoId);
  const entry = entries.find((r) => r.targetRef !== undefined) ?? entries[0];
  const released = (detail: string): ReleaseOutcome => ({
    kind: "released",
    task: { ...task, targetChangeRequest: null },
    event: { runId, at, kind: "merge-landed", detail },
  });
  if (entry === undefined) return released(`#${thread} merged; the task no longer targets it`);
  const usable = (name: string | null | undefined) =>
    usableBranch(entry, name, run?.branchNamespace);
  const onto = usable(mergedInto) ?? usable(localBranch(entry.targetRef)) ??
    usable(defaultBranch);
  if (onto === null) {
    return released(
      `#${thread} merged with nothing of this run on it; ${entry.path} stays as it was, ` +
        "and the task no longer targets it",
    );
  }
  const ref = entry.ref.startsWith("refs/heads/") ? `refs/heads/${onto}` : onto;
  const specEntry = run?.workItem.repos.find((r) => r.path === entry.path);
  const specMoves = specEntry !== undefined &&
    (specEntry.ref !== onto || specEntry.targetRef !== undefined);
  // The run's current generation at the path. The release ends it, so the landing rule keeps a
  // waiting patch of it from going out to a fresh change request on its own, and the agent
  // rebases it from its base.
  const generation = releaseGeneration(entry.path, args.runPatches);
  const landing: RepoLanding = {
    connectedRepoId,
    thread,
    onto,
    generation,
    moved: true,
    at,
    releasedRun: runId,
  };
  return {
    kind: "moved",
    task: {
      ...task,
      repos: movedAt(task.repos, entry.path, (e) => rebased(e, ref, undefined)),
      targetChangeRequest: null,
      landings: withLanding(task.landings, entry.path, DEFAULT_LINE, runId, landing),
    },
    run: run === null || !specMoves ? null : {
      ...run,
      workItem: {
        ...run.workItem,
        repos: movedAt(run.workItem.repos, entry.path, (e) => rebased(e, onto, undefined)),
      },
      updatedAt: at,
    },
    path: entry.path,
    onto,
    generation,
    event: {
      runId,
      at,
      kind: "merge-landed",
      detail: `#${thread} merged into ${onto} with nothing of this run on it; ` +
        `${entry.path} now on ${onto}, and the task no longer targets it`,
    },
  };
}

/** Whether the task holds a landing for the patch's repo, path and line at its generation or
 * later: what a merged cue carries, and waits for. The outbox's SQL twin:
 * `listPatchesAwaitingMergedCue`. */
export function hasLanding(
  landings: Task["landings"],
  patch: Pick<Patch, "runId" | "connectedRepoId" | "path" | "line" | "generation">,
): boolean {
  const landing = landingOf(landings, patch.path, patch.line, patch.runId);
  return landing !== undefined && landing.connectedRepoId === patch.connectedRepoId &&
    landing.generation >= patch.generation;
}

/**
 * The merged cue's `onto` for `patch`, read off the task's landings: the branch its line stands
 * on after the merge. Undefined only when nothing is recorded for its line of the repo there.
 */
export function cueOnto(
  landings: Task["landings"],
  patch: Pick<Patch, "runId" | "connectedRepoId" | "path" | "line">,
): string | undefined {
  const landing = landingOf(landings, patch.path, patch.line, patch.runId);
  return landing !== undefined && landing.connectedRepoId === patch.connectedRepoId
    ? landing.onto
    : undefined;
}

// What a merge owes a task that WORKS the merged change request (`targetChangeRequest`) whose
// current run has no patch on it — a `/ryph` on a pull request whose run had pushed nothing yet
// when it merged (docs/patch-lifecycle.md "Landing"). No landing of that run's would ever let the
// task go, so without this every later submit of the task meets a merged change request and fails
// for good. The merge record lets it go (core/landing.ts `releaseMergedTarget`): the repo and the
// live run's spec move onto where it merged, and the live run is sent the RELEASE CUE
// (`ReleasedPayload`) in the same transaction, so a crash after the release never loses it — a run
// still awaiting its prompt, which takes no message before it, is owed it on the landing and gets
// it right after the prompt (`owedReleaseCues`). Its runner fetches that branch, the agent moves
// the run's own commits onto it, and the fresh change request carries nothing that already merged.
// Made by the submit sweep's release reconcile (`reconcileMergeReleases`), from every merge record
// whose releases are not made yet — the record is the outbox, written before anything else of the
// merge, so a release is owed until it is made — and by the sweep's gate when a patch reaches it
// first (core/reaper.ts).

import { mintId } from "@ryph/sealed";
import { inCode, notifyText, RUNNER_NOTE } from "./inbox.ts";
import type { LandingRuleDeps } from "./landing_rule.ts";
import { DEFAULT_LINE } from "@ryph/shared/lines";
import type { ChangeRequestMerge, ConnectedRepo, RunMessage, Task } from "./types.ts";

/**
 * The release cues a run awaiting its prompt was owed (`RepoLanding.releaseCueOwed`), for the
 * prompt's transaction to append after the prompt, and the task's landings with them cleared.
 * Null when it owes none.
 */
export function owedReleaseCues(
  landings: Task["landings"],
  runId: string,
  at: string,
): { cues: Array<Omit<RunMessage, "seq">>; landings: Task["landings"] } | null {
  // Only the default line's: a release ends the line that worked the change request, and only
  // the default line ever does (core/landing.ts `releaseMergedTarget`).
  const owed = Object.entries(landings).flatMap(([path, lines]) => {
    const l = lines[DEFAULT_LINE];
    return l !== undefined && l.releaseCueOwed === true && l.releasedRun === runId
      ? [[path, l] as const]
      : [];
  });
  if (owed.length === 0) return null;
  const cleared = { ...landings };
  for (const [path, { releaseCueOwed: _owed, ...landing }] of owed) {
    cleared[path] = { ...cleared[path], [DEFAULT_LINE]: landing };
  }
  return {
    cues: owed.map(([path, l]) =>
      releaseCueMessage({
        runId,
        path,
        onto: l.onto,
        thread: l.thread,
        generation: l.generation,
        at,
      })
    ),
    landings: cleared,
  };
}

/** What a run whose task worked a change request that merged with nothing of the run on it is
 * told, once its task was let go of it. `onto`: where the repo moved, when it could. The rebase
 * itself is the runner's to spell out, in the note it adds to the cue: only the runner knows the
 * line's local branch and the commit its work starts past. */
export function releasedCueNote(thread: string, path: string, onto: string | null): string {
  const cr = `The change request ${inCode(`#${thread}`)}`;
  if (onto === null) {
    return `${cr} merged with nothing of this run on it, so this task no longer works on it. ` +
      `ryph could not tell which branch it merged into: your next submit_patch for ` +
      `${inCode(path)} opens a new change request from where it stands now.`;
  }
  return `${cr} merged into ${inCode(onto)} with nothing of this run on it, so this task no ` +
    `longer works on it. Rebase your commits in ${inCode(path)} onto ` +
    `${inCode(`origin/${onto}`)} (${RUNNER_NOTE}), and your next submit_patch opens a new ` +
    "change request.";
}

/**
 * The release cue a live run is owed, as the store appends it in the release's own transaction:
 * the note for the agent, and the payload the runner acts on (`ReleasedPayload`).
 */
export function releaseCueMessage(
  args: {
    runId: string;
    path: string;
    onto: string;
    thread: string;
    /** The release landing's generation (`RepoLanding.generation`). */
    generation: number;
    at: string;
  },
): Omit<RunMessage, "seq"> {
  return {
    id: mintId("rm"),
    runId: args.runId,
    kind: "system",
    sender: { kind: "platform" },
    text: releasedCueNote(args.thread, args.path, args.onto),
    payload: {
      kind: "released",
      path: args.path,
      // A release only ever ends the default line: the one bound to the task's change request.
      line: DEFAULT_LINE,
      onto: args.onto,
      forgeRef: args.thread,
      generation: args.generation,
    },
    attachments: [],
    createdAt: args.at,
    deliveredAt: null,
  };
}

/**
 * Lets the task go of the merged change request it targets, from the merge record — the forge's
 * branch, else the task's recorded base, else the repo's default — unless its current run has a
 * patch on it (that patch's landing does it). A live current run gets the release cue in the
 * same write when the repo moved (after its prompt, if it awaits one), and words alone when it
 * could not; here it is only woken.
 * Answers what the store decided: `none` when the task no longer targets it, or its current run
 * has a patch there.
 */
export async function releaseTarget(
  deps: LandingRuleDeps,
  repo: Pick<ConnectedRepo, "id" | "defaultBranch">,
  merge: Pick<ChangeRequestMerge, "forgeRef" | "mergedInto">,
  taskId: string,
): Promise<"none" | "released" | "moved"> {
  const { outcome, cuedRunId } = await deps.store.releaseMergedTarget({
    taskId,
    connectedRepoId: repo.id,
    thread: merge.forgeRef,
    mergedInto: merge.mergedInto ?? undefined,
    defaultBranch: repo.defaultBranch,
    at: deps.now().toISOString(),
  });
  if (outcome.kind === "none") return "none";
  deps.diag.debug("patch.merge_released_target", { taskId, thread: merge.forgeRef });
  if (cuedRunId !== null) deps.inbox?.notify(cuedRunId);
  if (outcome.kind === "released") {
    // Nowhere to move to, so no cue: words alone, best-effort (`notifyText` skips a run that is
    // over), and the run's later patches open a fresh change request from where it stands.
    const path = outcome.task.repos.find((r) => r.connectedRepoId === repo.id)?.path ?? ".";
    await notifyText(deps, outcome.event.runId, releasedCueNote(merge.forgeRef, path, null));
  }
  return outcome.kind;
}

/** How many merge records' releases one sweep makes at most. */
const RELEASE_BATCH = 20;
/** How long a merge record whose release threw waits before it is asked again. */
export const RELEASE_RETRY_MS = 5 * 60_000;

/**
 * The release reconcile, on every submit sweep: for each merge record whose releases are not
 * made yet (`listMergesOwingRelease`), every task that targets its change request is let go
 * (`releaseTarget`) — one whose current run has a patch on it is that landing's, and stands
 * aside — and then the record is marked released. Derived from the rows alone, so a release owed
 * by a merge the process recorded and then died on is still made. A record whose release threw
 * stays owed. A task that starts working the change request after
 * that is the submit sweep's gate's to let go (core/reaper.ts). Bounded, oldest merge first; a
 * record whose release threw is asked again only `RELEASE_RETRY_MS` later, behind the rest.
 * Never throws.
 */
export async function reconcileMergeReleases(deps: LandingRuleDeps): Promise<void> {
  const owing = await deps.store.listMergesOwingRelease(deps.now().toISOString(), RELEASE_BATCH)
    .catch((err) => {
      deps.diag.warn("reaper.merge_releases_unlisted", { err: String(err) });
      return [];
    });
  for (const merge of owing) {
    try {
      const repo = await deps.store.getConnectedRepo(merge.connectedRepoId);
      // A repo gone since: no default branch to fall back on, so only the forge's word or the
      // task's recorded base can move it.
      const where = { id: merge.connectedRepoId, defaultBranch: repo?.defaultBranch ?? "" };
      const tasks = await deps.store.listTasksTargetingChangeRequest(
        merge.connectedRepoId,
        merge.forgeRef,
      );
      for (const task of tasks) await releaseTarget(deps, where, merge, task.id);
      await deps.store.markMergeReleased(
        merge.connectedRepoId,
        merge.forgeRef,
        deps.now().toISOString(),
      );
    } catch (err) {
      deps.diag.warn("patch.merge_release_failed", { thread: merge.forgeRef, err: String(err) });
      // Asked again later, behind the rest: one that keeps throwing never holds them back.
      const until = new Date(deps.now().getTime() + RELEASE_RETRY_MS).toISOString();
      await deps.store.deferMergeRelease(merge.connectedRepoId, merge.forgeRef, until).catch(
        (err) => deps.diag.warn("patch.merge_release_undeferred", { err: String(err) }),
      );
    }
  }
}

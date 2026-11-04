// The merge poll: where the forge delivers no events — GitHub's and GitLab's user modes, which
// have no webhooks —
// the change requests ryph's patches reached are asked about on a clock, and a merge or a close
// is fed through the very path the forge's event takes (core/merge_settle.ts
// `settleChangeRequestEnd`), built as that event would be: the same kind, and for a merge the
// branch it merged into (the base at the merge) and what merged (the head the forge's read
// names as merged, never its latest head). So every guarantee of
// docs/patch-lifecycle.md "Landing" holds unchanged, and a poll that repeats a settle repeats
// nothing.
//
// The forge's own authenticated read decides, never a caller: nothing here is reachable from
// outside, and the read is the forge service route every push event already asks
// (`fetchChangeRequestHead`). Only the state as it stands is acted on: an open change request —
// one closed and reopened since, too — is left alone.
//
// Closed is not final: a person can reopen a pull request and merge it, and that merge is the one
// verdict a settled patch may still be told (`closed → merged`, docs/patch-lifecycle.md "The fate
// memory is owed"). So a change request whose patches closed stays asked about, slowly
// (`closedIntervalMs`), for `closedWindowMs` after the close.
//
// GitLab's bot mode has webhooks, but only once a Maintainer pasted one, and only while GitLab
// keeps it enabled — a hook never pasted, deleted, or auto-disabled after failures tells
// nothing, and a merge would then never settle its patches. Nor does a hook saved without "Merge
// request events" ticked: it rings for pushes and notes, and a merge only ever arrives as a Merge
// Request Hook. So a bot-mode GitLab repo whose hook has not delivered a MERGE REQUEST event for
// `unheardAfterMs` (none ever, after a rotation, the box unticked, or silence while its patches
// are open) is polled too, slowly (`unheardIntervalMs`), until one is heard again
// (`GitlabProject.lastMergeRequestHookAt`; any other delivery says nothing about merges).
//
// And a repo whose hook IS heard can still lose one merge's event: GitLab never retries, so a
// delivery the door refused (429 past a project's budget, a control plane that did not answer)
// is gone, and one the consumer gave up on (a merge request `locked` past the retry ladder, a 403
// GitLab answered for a moment) is too. Hearing other merge requests says nothing about this one,
// so every change request of a heard repo is asked about as well, at the slowest cadence
// (`heardIntervalMs`), first an interval after the poll first lists it — never at once, since a
// merge request event will most likely say it first. A lost event is then at most that late.
//
// Bounded: the pass runs only while the forge says a provider is in user mode (`polledProviders`)
// — or GitLab is in bot mode — and asks only about those repos; it asks at most
// `perTick` change requests per tick, each at most once per `intervalMs`, never-asked first and
// then the one asked longest ago; a failed ask backs that change request off, doubling up to
// `maxBackoffMs`, and an unanswered one ends the pass (a token or rate-limit failure is the
// forge's, not the change request's). One found gone on `GONE_LIMIT` reads in a row (any other
// outcome resets the count) is parked: asked once every `parkedIntervalMs` until a read finds it
// again, its patches left as they are meanwhile. A GitLab row connected on another instance, or
// any with no GitLab here at all, is never listed: the forge refuses every question about it, and
// a row that is never asked, listed, would hold the head of the queue every tick ahead of every
// change request that can be. One the listing held anyway (archived or moved since) is parked
// the same way rather than skipped with its clock unmoved.

import type { Forge, GithubMode, GithubModeSource, GitlabMode } from "../ports/forge.ts";
import type { MergePollClock, PolledProvider, TaskStore } from "../ports/task_store.ts";
import { fitsForge, forgeRepoRef, githubModeOf, gitlabModeOf } from "./forge_repo.ts";
import type { ConnectedRepo } from "./types.ts";
import { type ChangeRequestEndDeps, settleChangeRequestEnd } from "./merge_settle.ts";

export interface MergePollConfig {
  /** How long after an answer a change request is asked again. */
  intervalMs: number;
  /** How many change requests one tick asks about at most. */
  perTick: number;
  /** The longest a failing change request waits between asks. */
  maxBackoffMs: number;
  /** How long after its patches closed a change request is still asked about. */
  closedWindowMs: number;
  /** How often it is asked then. */
  closedIntervalMs: number;
  /** How often a parked one (found gone `GONE_LIMIT` times in a row) is asked. */
  parkedIntervalMs: number;
  /** How long a bot-mode GitLab repo's webhook may go without a merge request event before its
   * merges are polled. */
  unheardAfterMs: number;
  /** How often an open change request of such a repo is asked then. */
  unheardIntervalMs: number;
  /** How often a change request of a bot-mode GitLab repo whose hook IS heard is asked: what one
   * lost merge request event can delay its patches by. */
  heardIntervalMs: number;
}

/** A minute between asks, two asks a tick: with the reaper's 10 s tick at most 720 reads an hour
 * of the token's 5,000, and up to a dozen open change requests each asked once a minute. A closed
 * one is asked every ten minutes for a week, a parked one once a day. */
export const DEFAULT_MERGE_POLL_CONFIG: MergePollConfig = {
  intervalMs: 60_000,
  perTick: 2,
  maxBackoffMs: 60 * 60_000,
  closedWindowMs: 7 * 24 * 60 * 60_000,
  closedIntervalMs: 10 * 60_000,
  parkedIntervalMs: 24 * 60 * 60_000,
  unheardAfterMs: 30 * 60_000,
  unheardIntervalMs: 10 * 60_000,
  heardIntervalMs: 60 * 60_000,
};

/** How many reads in a row may find a change request gone before it is parked. */
export const GONE_LIMIT = 5;

/** How many stale poll clocks one tick removes at most. */
const PRUNE_BATCH = 100;

export interface MergePollDeps extends ChangeRequestEndDeps {
  store: ChangeRequestEndDeps["store"] & Pick<TaskStore, "getGitlabProject">;
  /** `providers` says how the forge acts on GitLab; absent, no GitLab repo is polled. */
  forge: Pick<Forge, "fetchChangeRequestHead"> & Partial<Pick<Forge, "providers">>;
  /** How the forge acts on GitHub. Absent, or not answered yet: no GitHub repo is polled. */
  githubMode?: GithubModeSource | null;
}

/**
 * The providers whose change requests the poll asks about: those the forge runs and hears no
 * events for (core/forge_repo.ts `providerHasEvents`) — GitHub and GitLab in user mode. Both
 * modes ride along for `fitsForge`. In GitLab's bot mode, `gitlabUnheardSince` is the
 * moment a repo's webhook must have been heard since to go unpolled; null otherwise.
 */
export async function polledProviders(
  deps: {
    githubMode?: GithubModeSource | null;
    forge?: Partial<Pick<Forge, "providers">>;
    now(): Date;
  },
  cfg: Pick<MergePollConfig, "unheardAfterMs"> = DEFAULT_MERGE_POLL_CONFIG,
): Promise<{
  polled: PolledProvider[];
  github: GithubMode | null | undefined;
  gitlab: GitlabMode | null | undefined;
  gitlabUnheardSince: string | null;
}> {
  const github = await githubModeOf(deps.githubMode);
  const gitlab = await gitlabModeOf(deps.forge, deps.now().getTime());
  const polled: PolledProvider[] = [];
  if (github?.mode === "user") polled.push("github");
  if (gitlab?.mode === "user") polled.push("gitlab");
  const gitlabUnheardSince = gitlab?.mode === "bot"
    ? new Date(deps.now().getTime() - cfg.unheardAfterMs).toISOString()
    : null;
  return { polled, github, gitlab, gitlabUnheardSince };
}

/** When a change request that failed `failures` times in a row is next asked. */
export function mergePollBackoffMs(failures: number, cfg: MergePollConfig): number {
  return Math.min(cfg.intervalMs * 2 ** Math.min(failures, 20), cfg.maxBackoffMs);
}

/**
 * The forge refused a delivery because this change request ended, which the poll may not have
 * heard yet: it is asked on the next tick. Only where nothing else would tell: a user mode, or
 * GitLab's bot mode while some repo's webhook goes unheard.
 * Never throws.
 */
export async function pollChangeRequestSoon(
  deps: {
    store: Pick<TaskStore, "stampMergePoll">;
    githubMode?: GithubModeSource | null;
    forge?: Partial<Pick<Forge, "providers">>;
    diag: MergePollDeps["diag"];
    now(): Date;
  },
  connectedRepoId: string,
  forgeRef: string,
): Promise<void> {
  // Stamped whenever anything is polled: the listing reads only the polled providers' repos, so
  // a clock on any other is never asked about, and pruned.
  const { polled, gitlabUnheardSince } = await polledProviders(deps);
  if (polled.length === 0 && gitlabUnheardSince === null) return;
  await deps.store.stampMergePoll(connectedRepoId, forgeRef, {
    dueAt: deps.now().toISOString(),
    failures: 0,
    gone: 0,
  }).catch((err) =>
    deps.diag.warn("reaper.merge_poll_unstamped", { thread: forgeRef, err: String(err) })
  );
}

/**
 * The forge refused a push because the change request it was to go onto MERGED, and no merge of
 * it is recorded: recorded now from the forge's own read of it (what merged and where), through
 * the very path a merge event takes (`settleChangeRequestEnd`), in every mode. A merge whose
 * event was lost (a webhook never delivered), or one the poll no longer asks about (the run that
 * pushed is over and its clock was pruned), would otherwise leave the patch refused on every
 * retry until its attempts run out; with the record, the settle judges what is on it and the
 * landing rule or the release rules the patch. Answers whether a merge is recorded now. Never
 * throws: a read that does not say merged records nothing, and the next refusal asks again.
 */
export async function recordRefusedMerge(
  deps: ChangeRequestEndDeps & { forge: Pick<Forge, "fetchChangeRequestHead"> },
  repo: ConnectedRepo,
  forgeRef: string,
): Promise<boolean> {
  try {
    if (await deps.store.getChangeRequestMerge(repo.id, forgeRef) !== null) return true;
    const read = await deps.forge.fetchChangeRequestHead(forgeRepoRef(repo), forgeRef);
    if (read.kind !== "head" || !read.head.merged) return false;
    await settleChangeRequestEnd(deps, repo, {
      kind: "change_request.merged",
      ref: forgeRef,
      merged: { baseRef: read.head.baseRef, heads: read.head.mergedHeads },
    });
    return await deps.store.getChangeRequestMerge(repo.id, forgeRef) !== null;
  } catch (err) {
    deps.diag.warn("reaper.refused_merge_unrecorded", { thread: forgeRef, err: String(err) });
    return false;
  }
}

/** One pass of the poll, on the submit sweep's tick. Never throws. */
export async function pollChangeRequestEnds(
  deps: MergePollDeps,
  cfg: MergePollConfig = DEFAULT_MERGE_POLL_CONFIG,
): Promise<void> {
  if (cfg.perTick < 1) return;
  const { polled, github, gitlab, gitlabUnheardSince } = await polledProviders(deps, cfg);
  if (polled.length === 0 && gitlabUnheardSince === null) return;
  const { store, diag } = deps;
  const closedSince = new Date(deps.now().getTime() - cfg.closedWindowMs).toISOString();
  await store.pruneMergePolls(closedSince, PRUNE_BATCH).catch((err) =>
    diag.warn("reaper.merge_polls_unpruned", { err: String(err) })
  );
  const due = await store.listChangeRequestsDueMergePoll(
    deps.now().toISOString(),
    closedSince,
    cfg.perTick,
    polled,
    // GitLab's rows only on the instance it runs now: one stranded on another is never asked.
    gitlab ? { instance: gitlab.url, bot: gitlab.mode === "bot" } : null,
  ).catch((err) => {
    diag.warn("reaper.merge_polls_unlisted", { err: String(err) });
    return [];
  });
  for (const { connectedRepoId, forgeRef, failures, gone, open, asked } of due) {
    const stamp = (clock: MergePollClock) => store.stampMergePoll(connectedRepoId, forgeRef, clock);
    const after = (ms: number) => new Date(deps.now().getTime() + ms).toISOString();
    const answered = (ms: number) => stamp({ dueAt: after(ms), failures: 0, gone: 0 });
    // `gone` counts gone reads in a row: any other failure starts it again.
    const backOff = (wasGone: boolean) =>
      stamp({
        dueAt: after(mergePollBackoffMs(failures + 1, cfg)),
        failures: failures + 1,
        gone: wasGone ? gone + 1 : 0,
      });
    // Not asked: parked like one found gone, so a row the listing should not have held (one
    // archived, or moved off its instance, since) can never keep the head of the queue from
    // every change request behind it.
    const skip = () => stamp({ dueAt: after(cfg.parkedIntervalMs), failures, gone });
    try {
      const repo = await store.getConnectedRepo(connectedRepoId);
      // The listing asked for a live repo of a polled provider (a GitHub one with a user-mode
      // tenant), or a bot-mode GitLab one, on the instance the forge runs now; this is that rule
      // asked of the row read — a GitLab row connected on another instance is nobody's here
      // (`fitsForge`).
      if (repo === null || repo.archivedAt !== null || !fitsForge(repo, github, gitlab)) {
        await skip();
        continue;
      }
      // Slowly where a webhook may yet say it first: at the minute in a user mode, every ten
      // minutes for a bot-mode repo whose hook went unheard, every hour for one that is heard.
      let openInterval = cfg.intervalMs;
      let closedInterval = cfg.closedIntervalMs;
      if (!polled.includes(repo.provider as PolledProvider)) {
        if (repo.provider !== "gitlab" || gitlabUnheardSince === null) {
          await skip();
          continue;
        }
        // Merges arrive as Merge Request Hooks only: a hook heard for pushes and notes alone may
        // have "Merge request events" unticked, and says nothing about them.
        const heard = (await store.getGitlabProject(repo.id))?.lastMergeRequestHookAt ?? null;
        if (heard !== null && heard >= gitlabUnheardSince) {
          openInterval = cfg.heardIntervalMs;
          closedInterval = Math.max(cfg.closedIntervalMs, cfg.heardIntervalMs);
          // First listed: its clock starts here, unread — the event will most likely come.
          if (!asked) {
            await stamp({ dueAt: after(cfg.heardIntervalMs), failures: 0, gone: 0 });
            continue;
          }
        } else {
          openInterval = cfg.unheardIntervalMs;
        }
      }
      const read = await deps.forge.fetchChangeRequestHead(forgeRepoRef(repo), forgeRef);
      if (read.kind === "gone" && gone + 1 >= GONE_LIMIT) {
        // Deleted, or out of the token's reach: parked, asked once a day in case access comes
        // back, and nothing settled — the forge never said how it ended.
        if (gone + 1 === GONE_LIMIT) {
          diag.warn("reaper.merge_poll_parked", { connectedRepoId, thread: forgeRef });
        }
        await stamp({
          dueAt: after(cfg.parkedIntervalMs),
          failures: failures + 1,
          gone: gone + 1,
        });
        continue;
      }
      if (read.kind !== "head") {
        diag.warn("reaper.merge_poll_unanswered", {
          connectedRepoId,
          thread: forgeRef,
          why: read.kind,
          failures: failures + 1,
        });
        await backOff(read.kind === "gone");
        // The forge did not answer: the next ask would most likely fail the same way.
        if (read.kind === "unavailable") break;
        continue;
      }
      const head = read.head;
      if (head.state === "open") {
        await answered(openInterval);
        continue;
      }
      if (!head.merged) {
        // Asked again slowly from here, for a reopen and merge to revise it.
        await answered(closedInterval);
        // Nothing left to settle when all it has is the close already heard.
        if (!open) continue;
      } else {
        // Stamped first. A record that failed to write leaves the change request listed, so it
        // is asked again; once written, the change request is no longer listed, and the settle
        // reconcile takes it from the record (core/merge_settle.ts `reconcileMergeSettles`).
        await answered(cfg.intervalMs);
      }
      const outcome = await settleChangeRequestEnd(
        deps,
        repo,
        head.merged
          ? {
            kind: "change_request.merged",
            ref: forgeRef,
            // What merged as the read names it — never `headSha`, which on Radicle is the
            // latest revision whether or not it is the one that merged.
            merged: { baseRef: head.baseRef, heads: head.mergedHeads },
          }
          : { kind: "change_request.closed", ref: forgeRef },
      );
      diag.debug("reaper.merge_polled", {
        connectedRepoId,
        thread: forgeRef,
        fate: head.merged ? "merged" : "closed",
        outcome,
      });
    } catch (err) {
      diag.warn("reaper.merge_poll_failed", {
        connectedRepoId,
        thread: forgeRef,
        err: String(err),
      });
      await backOff(false).catch(() => {});
    }
  }
}

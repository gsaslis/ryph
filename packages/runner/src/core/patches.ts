// Shipping a repo's work as a patch — the one move finalize makes per clone, now also made
// mid-run on the agent's say-so (the loopback `submit_patch` tool), with GENERATIONS: once a
// patch of a branch merges, the next submit ships under a new remote name, on the merged tip.
// This file holds that state per clone and the submit itself; run.ts calls it from finalize, the
// RunActions implementation calls it from the tool.
//
// The agent moves its own work. After a change request merges the runner rewrites nothing: it
// fetches the branch it merged into as `origin/<onto>` and tells the agent, which rebases (or
// merges, or starts afresh) with plain git. The runner shares the agent's uid and is a helper,
// not a guard: what it checks here is a courtesy that gives the agent a clear message early.
//
// Invariants:
// - a generation ends only because its change request MERGED: a merged cue from the inbox,
//   whose head the merge contains (the landed head), or — when the merge contained none of the
//   generation's patches — the missed cue that says so, which lands the generation at its base
//   (`missedCue`), as does the release of a change request that merged before any of the run's
//   work reached it (`releasedCue`); a closed or rejected pull request stays in its generation,
//   and the branch is still valid
// - a landing cue is a fetch, not an advance: the runner records the landed head and where it
//   merged (`landing.onto`), fetches `onto` into `refs/remotes/origin/<onto>` (`fetchLanding`),
//   records the fetched tip (`landedTip`) and adds what it found to the cue's text. No branch,
//   tree or stopped operation moves
// - one submit rule after a landing: a line whose generation landed ships only once its branch
//   holds `landedTip` (`git merge-base --is-ancestor`): rebased, merged, reset and re-picked
//   branches all pass, and nothing is replayed, measured or carried. On a pass the branch ships
//   as the next generation, from where it meets `onto` as fetched now; the line moves to that
//   generation only once the push went out (`nextGeneration`), so a refusal, a failed push or
//   nothing to ship leaves the landing, and the rule, standing. A branch with nothing past the
//   landed head has nothing to ship, nor one whose tree is `onto`'s or its base's (a merge of
//   `onto` after a squash, nothing new). A later fetch of `onto` that no longer holds `landedTip` (a
//   force push, a rewind) replaces it (`takeTip`). Submit and checks ask the same question
//   (`landedAt`). The rule is asked before leftovers are committed, so a refused submit commits
//   nothing of the tree (a merge `update` left, resolved, is concluded before it: the rule reads
//   the branch that merge makes)
// - an `onto` gone from the origin (a stacked base deleted on merge) cannot satisfy the rule,
//   whatever tip an earlier fetch took: the agent is told so plainly, the line ships no more
//   mid-run, and finalize sends it held
// - a landed branch renamed or branched off, never rebased, is a new line like any other, and
//   ships as it stands: the runner does not enforce what an agent can bypass, and the person
//   reviewing its change request sees what it repeats
// - generations are remote names only: the runner never renames, copies or rewrites a local
//   branch, and ships the line's branch under the generation's name (`shipAs`, `shipRef`)
// - at finalize nobody is left to rebase: a landed line with nothing past what landed ships
//   nothing; one that holds `landedTip` ships as a submit would; any other ships as it stands,
//   as the next generation, held for a person like every finalize patch (the control plane finds
//   it does not hold what merged, and says so), and the run's summary says it was not rebased
//   (`unrebased`). A person discards a duplicate. A stopped operation is never aborted, reset,
//   staged, unstaged, continued or concluded: the branch ref ships as it stands, by the same
//   rules, and uncommitted work does not ship. Two exceptions are concluded with git's own
//   commit, as mid-run: a merge, and a single-step cherry-pick or revert, whose conflicts were
//   all resolved and staged
// - where a generation lands, and from which head, only ever moves forward: the first merged
//   cue of a generation names the branch, and a later cue moves the landed head only to a head
//   that holds it
// - submits on one clone are serialized: two bundles of one repo cannot be cut at once
// - catching up with the target (`update`) MERGES, never rebases: the branch may be somebody's
//   change request, and rewriting it would need a force-push onto their work. After a landing it
//   merges `onto`, which satisfies the submit rule as a rebase does. A stopped merge is left for
//   the agent, and the next submit concludes it; a rebase the agent started is its own to finish
// - the latest branch shipped per path and line is what the run's result reports; a branch
//   reported here that could not be REPORTED (the control plane did not answer) still shipped —
//   the bundle is durable, and the result opens the patch at the latest
//
// LINES (@ryph/shared/lines). Everything above is about ONE line: one independent stream of work
// in a clone, with its own branch, generations and change request. A clone holds a map of them, the
// default line `work` from the start, and another for each branch the agent submitted
// (`resolveLine`). What a line knows (`LineState`) is everything a clone knew of its one branch
// before; the clone keeps only the checkout, the entry it was given, and the lock:
// - a cue is routed to (path, line), never to a path alone, and one for a line the clone does not
//   hold changes nothing: a merge of line A never moves line B
// - a line ships its local branch under `<namespace>/<line>` (`-<n>` from the second
//   generation). A branch is never renamed: where the branch's name is not the shipped one, the
//   shipped name is a ref made for the push alone (`shipRef`)
// - the working tree is one per clone, so only the line the checkout is on (`holderOf`) has its
//   leftovers committed or a stopped step concluded; any other line ships its committed branch
//   as it stands
// - a line exists once a submit of it shipped: one that refused, or found nothing, leaves no
//   line behind, so a slot is never spent on nothing (`MAX_LINES_PER_REPO`). Only lines that
//   shipped count toward it, as the control plane counts them: `work` takes a slot once it ships
// - lines are unrelated: a line whose commits include another line's own is refused at submit
//   (stacked lines are a later feature). At finalize one whose head is, or holds, another line's
//   own head is not shipped, nor one that holds another line's own commits short of its head (a
//   merge of that line, no submit after), and the run's summary says so (`withheld`): it would
//   ship that line's work twice, as two change requests, and one on the very same head the
//   control plane refuses at birth (orchestrator core/open_patch.ts), with nobody left to
//   answer. Two that hold each other's go first come, first shipped (`stackedAtFinalize`). What a
//   line's target already holds, or what merged of the other line, is nobody's own: a line that
//   caught up with its target after another line merged there is no stack (`stackedOn`)
// - a line keeps the branch it first shipped from: one whose branch is gone at finalize (deleted
//   or renamed) ships nothing more, its last patch standing, and the summary says so (`gone`);
//   a renamed one submitted under its new name is refused, naming the name to put back
//   (`renamedFrom`)
// - a local branch is acted on only under a name git would give a branch (`isBranchName`): a
//   ref the agent made under `refs/heads/` can be named anything a ref may be, `--strategy=<x>`
//   included, and every git argument that names a branch is a full `refs/heads/` name or sits
//   past `--end-of-options`

import { DEFAULT_LINE, lineBranch, lineOfBranch, MAX_LINES_PER_REPO } from "@ryph/shared/lines";
import type {
  BranchOutcome,
  CueTaken,
  PatchCue,
  PatchPayload,
  ReleasedPayload,
  RepoEntry,
} from "./types.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import type { Checkout, GitTransport } from "../ports/git_transport.ts";
import type { PatchReporter } from "../ports/patch_reporter.ts";
import type {
  PatchStatus,
  SubmitPatchOutcome,
  UpdateFromBaseOutcome,
} from "../ports/run_actions.ts";
import { briefError, type Git } from "../helpers/git_exec.ts";
import {
  branchSha,
  carriesWork,
  checkedOutBranch,
  commitAll,
  commitsSince,
  concludeMerge,
  concludePick,
  conflictedPaths,
  currentBranch,
  hasChanges,
  isAncestor,
  isBranchName,
  localBranchExists,
  mergeCommit,
  mergeInProgress,
  rebaseInProgress,
  resetBranch,
  type StoppedStep,
  stoppedStep,
} from "../helpers/checkout.ts";
import { refExists } from "../helpers/adopt.ts";
import { inCode, isPlainRef } from "../helpers/commands.ts";
import { errorMessage } from "../helpers/errors.ts";

/** One clone as the shipping side holds it: its checkout, the entry it was given, and its
 * lines — `work` from the start, and each other line once a submit of it shipped. */
export interface CloneState {
  /** The entry as the run was given it: its path, its repo, its branch namespace. What a new
   * line starts from (`resolveLine`); each line's own entry moves with its generations. */
  repo: RepoEntry;
  checkout: Checkout;
  /** The commit the checkout started on. */
  baseSha: string;
  lines: Map<string, LineState>;
  /** Submits on this clone run one at a time, whichever line: one working tree. */
  lock: Promise<unknown>;
}

/** One line of a clone as the shipping side holds it: where its branch is, and whether a patch
 * of it merged. */
export interface LineState {
  /** The clone the line lives in. */
  owner: CloneState;
  /** The line's name (@ryph/shared/lines). */
  line: string;
  /** The entry as this line builds on it: its base, and its target, which a merge of the line
   * moves (`nextGeneration`) and a change request replaces (`retargetClone`). */
  repo: RepoEntry;
  checkout: Checkout;
  /** The commit the current generation's bundle is cut from. */
  baseSha: string;
  /** The local branch the line's work is on: the runner's own `<namespace>/<line>`, or the
   * agent's own branch. Never renamed. */
  branch: string;
  /** What the current generation ships as: `<namespace>/<line>`, then `…/<line>-<n>`. */
  shipAs: string;
  generation: number;
  /** The head of a landed patch of THIS generation, or the generation's base when a missed or
   * released cue ended it with nothing merged: what the agent's rebase starts past
   * (`git rebase --onto origin/<onto> <landedHead>`). Only ever moves forward: a cue for an
   * earlier head of the generation leaves it. */
  landedHead: string | null;
  /** Where the next generation starts, set with `landedHead` from the first merged cue of the
   * generation (`PatchPayload.onto`), and never replaced within it. */
  landing: Landing | null;
  /** The tip of `onto` the runner fetched after the landing (`refs/remotes/origin/<onto>`): what
   * the branch must hold before the next generation ships. Null until a fetch answered; a later
   * fetch that no longer holds it (`onto` force-pushed or rewound) replaces it (`takeTip`). */
  landedTip: string | null;
  /** Finalize shipped the branch as the next generation without it holding `landedTip`: for
   * the run's notes (finalize only). */
  unrebased: { onto: string } | null;
  /** The branch tip as last shipped; a submit at the same tip has nothing new to ship. */
  shippedHead: string | null;
  /** Every head this clone shipped, oldest first: what a later patch may carry (`carriedHeads`). */
  heads: ShippedHead[];
  /** The change request the clone's entry targets as this run moved it there (the forge's
   * thread ref from a swap, `retargetClone`), or null when the run did not: one it started on,
   * which the runner is never told the name of, or none. What a release cue is held to. */
  changeRequest: string | null;
}

/**
 * What finalize made of a line: a submit's outcome, the stopped operation it left as it stood
 * (`abandoned`), and why the line was not shipped at all (`withheld`, with `nothing-to-submit`):
 * its head is, or holds, another line's own (`shadowedBy`), or the repo ships as many lines as it
 * may; or that its branch was gone (`gone`). All are for the run's summary, a person's to read.
 */
export type FinalizeOutcome = SubmitPatchOutcome & {
  abandoned?: LeftStopped;
  withheld?: string;
  /** The line's local branch was gone when finalize came to it (the agent deleted or renamed
   * it): nothing of it shipped now, and `shipped` says whether a patch of it went out before. */
  gone?: { shipped: boolean };
};

/** A head the clone shipped, and what its own work is measured past. */
export interface ShippedHead {
  sha: string;
  generation: number;
  /** The generation's base when it shipped. */
  base: string;
  /** The head its generation landed through, once the next generation began: everything up to
   * it merged. Null while its generation has not ended. */
  landed: string | null;
}

/** The most earlier heads one patch names as carried: the control plane's bound on the list. */
export const MAX_CARRIES = 500;

/** A merge of this generation, as its cue said: where the repo moved, and when it was heard. */
export interface Landing {
  /** The branch the repo moved onto, bare: where the change request merged. */
  onto: string;
  /** When the cue was taken (monotonic ms): the gateway may serve the old base a moment after. */
  at: number;
  /** The cue named no branch, and the branch's own target stands in — until a cue that does. */
  inferred: boolean;
}

/**
 * How long after a merge moves the repo the gateway may still serve the run its old base.
 * COUPLED to the forge's grant cache TTL (`DEFAULT_CACHE_TTL_MS`, 10 s, in
 * packages/forge/src/adapters/key_store/http.ts): raise this when that is raised.
 * The gateway caches a run's grant for 10 s (forge adapters/key_store/http.ts), and the grant
 * names the base it serves before it answers any fetch — so for up to that long after the
 * control plane moved the repo, a fetch can still be refused for a head branch the forge deleted
 * on merge. The cue is posted after the move, so measuring from the cue covers the window, with
 * a margin for the grant read that was already in flight.
 */
export const GRANT_SETTLE_MS = 12_000;

/** Something finalize found stopped and left exactly as it stood (helpers/checkout.ts
 * `stoppedStep`): what it was, where it conflicted, and what became of the branch around it —
 * its committed work shipped, or it had none new. The run's summary says it. */
export interface LeftStopped {
  /** What was left stopped. */
  step: StoppedStep;
  /** For a merge, of what (the branch `update_from_base` merged); null otherwise. */
  target: string | null;
  conflicts: string[];
  /** HEAD held commits whose change the branch does not carry (an edited pick, commits on a
   * detached HEAD or another branch): they did not ship either. A pick that only replays a
   * branch commit is not one. */
  headCommits: boolean;
  branch: "shipped" | "nothing-new";
}

/** How the run's notes name a stopped operation. */
export function stoppedLabel(step: StoppedStep, target: string | null): string {
  switch (step) {
    case "merge":
      return target === null ? "merge" : `merge of ${inCode(target)}`;
    case "am":
      return "`git am`";
    case "conflict":
      return "conflict resolution";
    case "off-branch":
      return "checkout off the run's branch";
    default:
      return step;
  }
}

/** The branch `update` merges: the repo's target when it has one, else its own base. */
export function targetOf(repo: RepoEntry): string {
  return repo.targetRef ?? repo.ref;
}

/**
 * A clone as the run checked it out: on `<namespace>/work`, the default line's branch, which the
 * caller has created and checked out at `baseSha`.
 */
export function cloneState(repo: RepoEntry, checkout: Checkout, baseSha: string): CloneState {
  const clone: CloneState = {
    repo,
    checkout,
    baseSha,
    lines: new Map(),
    lock: Promise.resolve(),
  };
  const work = lineBranch(repo.branchNamespace, DEFAULT_LINE, 1);
  clone.lines.set(DEFAULT_LINE, newLine(clone, DEFAULT_LINE, { repo, baseSha, branch: work }));
  return clone;
}

/** A line's first generation, with nothing shipped. */
function newLine(
  owner: CloneState,
  line: string,
  at: { repo: RepoEntry; baseSha: string; branch: string },
): LineState {
  return {
    owner,
    line,
    repo: at.repo,
    checkout: owner.checkout,
    baseSha: at.baseSha,
    branch: at.branch,
    shipAs: lineBranch(owner.repo.branchNamespace, line, 1),
    generation: 1,
    landedHead: null,
    landing: null,
    landedTip: null,
    unrebased: null,
    shippedHead: null,
    heads: [],
    changeRequest: null,
  };
}

/** The clone's default line, `work`: always there. */
export function defaultLine(clone: CloneState): LineState {
  const line = clone.lines.get(DEFAULT_LINE);
  if (line === undefined) throw new Error(`${clone.repo.path}: no default line`);
  return line;
}

/**
 * The line the checkout is on (`checkedOutBranch`: HEAD's branch, or the one a rebase in
 * progress rewrites), or undefined when it is on none the clone holds. Only that line's tree is
 * the one on disk: its leftovers, its stopped steps and its rebase are the ones there.
 */
/**
 * The local branches of `clone` finalize will not ship: on no line (never submitted), and
 * holding commits that no line's branch, no remote-tracking branch and not the base hold. A
 * branch checked out from the remote to read is not one; a branch the agent committed to and
 * never submitted is. Said to the agent at finish, while it can still submit them, and to the
 * person in the run's summary: finalize ships lines, never every local branch.
 */
export async function unsubmittedBranches(
  git: Git,
  clone: CloneState,
): Promise<Array<{ branch: string; commits: number }>> {
  const dir = clone.checkout.dir;
  const lines = new Set([defaultLine(clone), ...clone.lines.values()].map((l) => l.branch));
  const held = [defaultLine(clone).baseSha];
  for (const branch of lines) {
    if (await localBranchExists(git, dir, branch)) held.push(`refs/heads/${branch}`);
  }
  const refs = (await git(dir, "for-each-ref", "--format=%(refname)", "refs/heads/"))
    .split("\n")
    .filter((ref) => ref !== "");
  const found: Array<{ branch: string; commits: number }> = [];
  for (const ref of refs) {
    const branch = ref.slice("refs/heads/".length);
    if (lines.has(branch)) continue;
    // Full refnames only, never a bare name an agent chose: none of them reads as an option.
    const commits = Number(
      await git(dir, "rev-list", "--count", ref, "--not", "--remotes", ...held),
    );
    if (commits > 0) found.push({ branch, commits });
  }
  return found;
}

/** `unsubmittedBranches` in words: each branch and how many commits it holds, the first ten. */
export function unsubmittedList(found: ReadonlyArray<{ branch: string; commits: number }>): string {
  const named = found.slice(0, 10).map((f) =>
    `${inCode(f.branch)} (${f.commits} commit${f.commits === 1 ? "" : "s"})`
  ).join(", ");
  return found.length > 10 ? `${named} and ${found.length - 10} more` : named;
}

export async function holderOf(git: Git, clone: CloneState): Promise<LineState | undefined> {
  const on = await checkedOutBranch(git, clone.checkout.dir);
  if (on === null) return undefined;
  return [...clone.lines.values()].find((line) => line.branch === on);
}

/**
 * The line a submit (or a check, or a catch-up) of `branch` acts on — the branch the checkout is
 * on when none is named — in words for the agent when there is none. A branch a line already
 * works on is that line, whatever generation renamed it to. Any other branch is a NEW line
 * (`created`), named by `lineOfBranch`, starting where the branch left the line's base: the
 * repo's target as the clone last fetched it (`origin/<ref>`), else the commit the checkout
 * started on. A new line is not the clone's yet: a submit that ships it enlists it (`submit`),
 * and nothing else ever does, so a check or a refused submit spends no slot.
 */
export async function resolveLine(
  git: Git,
  clone: CloneState,
  branch?: string,
): Promise<{ line: LineState; created: boolean } | { refused: string }> {
  const { path, branchNamespace: namespace } = clone.repo;
  const dir = clone.checkout.dir;
  const local = branch ?? await checkedOutBranch(git, dir);
  if (local === null) {
    return {
      refused: `${path} is on no branch (HEAD is detached), so there is nothing to ship: ` +
        "switch to the branch you mean (`git switch <name>`), or name it with `branch`",
    };
  }
  // Before anything else reads it: a name git would not give a branch (a ref made by hand under
  // `refs/heads/`, a leading dash) is never acted on, whether the agent named it or HEAD is on it.
  if (!await isBranchName(git, dir, local)) {
    return {
      refused: `${path}: ${inCode(local)} is not a name git accepts for a branch ` +
        "(`git check-ref-format --branch`); move the work to a branch with a plain name, " +
        "such as `fix-login`, and submit that",
    };
  }
  const held = [...clone.lines.values()].find((line) => line.branch === local);
  if (held !== undefined) return { line: held, created: false };
  if (!await localBranchExists(git, dir, local)) {
    return { refused: `${path} has no local branch ${inCode(local)}` };
  }
  // A line's branch renamed (`git branch -m`), or deleted and made again under another name: the
  // branch is that line's work, which a new line would ship a second time and the stack check
  // refuses as stacked on its old self. The line keeps its name: back under it, it is the line
  // again. Only work the target does not hold yet counts — a line that merged is in the target,
  // and a branch started from it after holds that line's heads with none of its work.
  const renamed = await renamedFrom(git, clone, local);
  if (renamed !== null) {
    const rename = isPlainRef(local) && isPlainRef(renamed.branch)
      ? ` (\`git branch -m ${local} ${renamed.branch}\`)`
      : "";
    return {
      refused: `${path}: ${inCode(local)} continues ${inCode(renamed.branch)}, which already ` +
        `shipped and is no longer a local branch. Put it back under its own name${rename} ` +
        "and submit that: a line keeps the branch it first shipped from",
    };
  }
  const mapped = lineOfBranch(namespace, local);
  if ("refused" in mapped) return { refused: `${path}: ${mapped.refused}` };
  const taken = clone.lines.get(mapped.line);
  const shipAs = lineBranch(namespace, mapped.line, 1);
  // The branch it would ship as, already a local branch of its own (the agent made both `fix`
  // and `<namespace>/fix`): two branches, one line.
  const other = taken?.branch ??
    (local !== shipAs && await localBranchExists(git, dir, shipAs) ? shipAs : null);
  // A line that shipped and whose branch the agent then deleted keeps its name: a new branch
  // that maps to it is not a twin of a branch still there, and renaming "one of them" names a
  // branch that is gone.
  if (taken !== undefined && !await localBranchExists(git, dir, taken.branch)) {
    return {
      refused:
        `${path}: ${inCode(local)} would ship as the branch line ${
          inCode(mapped.line)
        }, the name ` +
        `of a line this run already shipped from ${inCode(taken.branch)}, which has since been ` +
        `deleted. A line's name is kept once it shipped: rename ${inCode(local)} ` +
        "(`git branch -m`) and submit again",
    };
  }
  if (other !== null) return { refused: collision(path, mapped.line, local, other) };
  // Off the default line's base as it stands now, not the entry the run started with: a merge
  // or a `checkout_change_request` moves that line's entry, and the control plane opens a new
  // line's change request against the same `targetRef ?? ref` of the task's (moved) entry. The
  // control plane moves the task's entry when the default line's change request merges or is
  // released (`landMerge`), and the line's own entry follows only at its next submit
  // (`nextGeneration`): a landing heard names where it went already.
  const work = defaultLine(clone);
  const { targetRef: _target, ...entry } = work.repo;
  const repo: RepoEntry = { ...entry, ref: work.landing?.onto ?? targetOf(work.repo) };
  const tracked = `refs/remotes/origin/${repo.ref}`;
  const from = await refExists(git, dir, tracked) ? tracked : clone.baseSha;
  let baseSha: string;
  try {
    baseSha = await git(dir, "merge-base", `refs/heads/${local}`, from);
  } catch {
    return {
      refused:
        `${path}: ${inCode(local)} shares no history with ${inCode(repo.ref)}; start it from ` +
        `the base (${startFrom(repo.ref)})`,
    };
  }
  return { line: newLine(clone, mapped.line, { repo, baseSha, branch: local }), created: true };
}

/**
 * The line a check (`run_checks`) or a catch-up (`update_from_base`) acts on: the one the
 * checkout is on (`resolveLine`), or, on a detached HEAD, the default line, as before there were
 * lines. A submit has nothing to ship from a detached HEAD and is refused; a check uploads the
 * default line's committed tip, the commit its answer names, and a catch-up is refused by
 * `update` itself, which merges only into the line's branch checked out.
 */
export async function lineAtHead(
  git: Git,
  clone: CloneState,
): Promise<{ line: LineState; created: boolean } | { refused: string }> {
  if (await checkedOutBranch(git, clone.checkout.dir) === null) {
    return { line: defaultLine(clone), created: false };
  }
  return await resolveLine(git, clone);
}

/**
 * The line `branch` continues when that line's own branch is gone: a line that shipped, whose
 * local branch no longer exists, and whose shipped head `branch` holds — a head its target, as
 * the clone last fetched it, does not hold already (merged work is anyone's to build on). Null
 * when there is none.
 */
async function renamedFrom(git: Git, clone: CloneState, branch: string): Promise<LineState | null> {
  const dir = clone.checkout.dir;
  for (const line of clone.lines.values()) {
    if (line.heads.length === 0 || await localBranchExists(git, dir, line.branch)) continue;
    const target = `refs/remotes/origin/${targetOf(line.repo)}`;
    const tracked = await refExists(git, dir, target);
    for (const head of line.heads) {
      if (!await isAncestor(git, dir, head.sha, `refs/heads/${branch}`)) continue;
      if (tracked && await isAncestor(git, dir, head.sha, target)) continue;
      const merged = [head.landed, line.landedHead].filter((m): m is string => m !== null);
      if (await someAncestor(git, dir, head.sha, merged)) continue;
      return line;
    }
  }
  return null;
}

/** Whether `ref`'s tree is that of any of `others` (null ones skipped). */
async function sameTree(
  git: Git,
  dir: string,
  ref: string,
  others: Array<string | null>,
): Promise<boolean> {
  const tree = async (at: string) => await git(dir, "rev-parse", `${at}^{tree}`);
  const own = await tree(ref);
  for (const other of others) {
    if (other !== null && await tree(other) === own) return true;
  }
  return false;
}

/** Whether any of `refs` holds `sha`. */
async function someAncestor(git: Git, dir: string, sha: string, refs: string[]): Promise<boolean> {
  for (const ref of refs) {
    if (await isAncestor(git, dir, sha, ref)) return true;
  }
  return false;
}

/** A new branch from `origin/<ref>`: the command, or the same in words where `ref` is not plain
 * (helpers/commands.ts). */
function startFrom(ref: string): string {
  return isPlainRef(ref)
    ? `\`git switch -c <name> origin/${ref}\``
    : `a new branch from ${
      inCode(`origin/${ref}`)
    }; its name holds characters a shell reads, so quote it`;
}

/**
 * How the agent puts `branch` on `origin/<onto>` after a landing: the exact rebase, past the
 * runner's own landed head and naming the branch, so it rebases that branch whatever HEAD is on.
 * In words where a name is not plain (helpers/commands.ts). Reads after "To go on, ". A dirty
 * tree stops the rebase, so it says to commit or stash first; and the rebase leaves HEAD on
 * `branch`, so where the checkout is on another branch (`current`) it says so, and how back.
 */
function rebaseStep(
  onto: string,
  landedHead: string,
  branch: string,
  current: string | null,
): string {
  const x = landedHead.slice(0, 12);
  const back = current === null || current === branch
    ? ""
    : isPlainRef(current)
    ? `; it checks out ${inCode(branch)}, so run \`git switch ${current}\` after it to go back ` +
      `to ${inCode(current)}`
    : `; it checks out ${inCode(branch)}, so switch back to ${inCode(current)} after it`;
  return isPlainRef(onto) && isPlainRef(branch)
    ? `rebase it onto ${inCode(`origin/${onto}`)}: ` +
      `\`git rebase --onto origin/${onto} ${x} ${branch}\` (commit or stash uncommitted ` +
      `changes first${back})`
    : `rebase the commits of ${inCode(branch)} past ${inCode(x)} onto ${
      inCode(`origin/${onto}`)
    } ` +
      "(no command is spelled out here: a branch name holds characters a shell reads, so " +
      `quote it; commit or stash uncommitted changes first${back})`;
}

/** The merge after a landing (`update_from_base`, which merges into the branch checked out):
 * reads after "or ". Where the checkout is on another branch (`current`), switching first. */
function mergeStep(branch: string, current: string | null): string {
  const merge = "merge it with ryph__update_from_base";
  if (current === branch) return merge;
  return isPlainRef(branch)
    ? `\`git switch ${branch}\` and ${merge}`
    : `switch to ${inCode(branch)} and ${merge}`;
}

/** The other way on after a landing: a new branch, submitted, and the old one deleted only once
 * that submit was accepted, so finalize does not ship that work a second time from the old
 * branch. Deleted before, a run that ends in between loses the moved commits: finalize ships
 * lines, never a branch nobody submitted. */
function freshStart(onto: string, branch: string): string {
  const del = isPlainRef(branch) ? ` (\`git branch -D ${branch}\`)` : "";
  return `To start fresh instead, make a new branch from ${inCode(`origin/${onto}`)}, move ` +
    "your later commits onto it and submit it with ryph__submit_patch; only once that submit " +
    `is accepted, delete ${inCode(branch)}${del} so its work does not ship twice.`;
}

/**
 * Whether a fetch failed because the ref is not at the origin at all — git's own words, through
 * the plain remote and through the gateway alike (forge adapters/repo_cache/local_fs.ts reads
 * them the same way) — rather than for a reason another try may clear.
 */
function refGone(err: unknown): boolean {
  return /couldn't find remote ref/.test(errorMessage(err));
}

/**
 * What the agent is told when `onto` is gone from the origin (a stacked base deleted on merge):
 * nothing can satisfy the submit rule, so the line ships no more in this run, and finalize sends
 * what it holds to a person.
 */
function goneText(onto: string, branch: string): string {
  return `${inCode(onto)}, where your change request merged, could not be found at the origin, ` +
    `so ${inCode(branch)} can't ship again in this run; its work goes to a person when the run ` +
    "ends.";
}

/** Two local branches that would ship as one line, named both. */
function collision(path: string, line: string, a: string, b: string): string {
  return `${path}: ${inCode(a)} and ${inCode(b)} would both ship as the branch line ${
    inCode(line)
  }; ` +
    "rename one of them (`git branch -m`) and submit again";
}

/**
 * Runs `turn` with the clone's lock held. Submits on one clone are serialized — two bundles of
 * one repo cannot be cut at once — and so is anything else that reads and MOVES the same branch,
 * like a swap onto a change request. One lock for every line: they share a working tree.
 */
export function underLock<T>(clone: CloneState, turn: () => Promise<T>): Promise<T> {
  const next = clone.lock.then(turn);
  // The chain must survive a throw, or every later turn on the clone would be stuck behind a
  // rejected promise; the throw itself still reaches this caller.
  clone.lock = next.catch(() => {});
  return next;
}

/**
 * Whether this clone has already put work out in this run — a patch shipped, or a generation
 * past the first. What the swap onto a change request asks before it
 * replaces the branch: once a patch of this repo exists, the run's work is attached to it, and
 * moving the checkout elsewhere would orphan it.
 *
 * A landed head alone is not: a merged cue only ever arrives for a patch this run shipped, and a
 * landing set by a release (`releasedCue`) with nothing shipped leaves the clone free to move
 * onto a change request, which drops that landing (`retargetClone`).
 */
export function hasShipped(clone: LineState): boolean {
  return clone.generation > 1 || clone.shippedHead !== null;
}

/**
 * Moves a clone onto a change request's head: the run's branch is RESET to it (the swap
 * replaces the branch — the caller has already established there was nothing on it), and the
 * entry's ref becomes the branch that head sits on, so `fetchBase` and `update` read THAT and
 * not the default branch this run started from. A later generation does not start there: once a
 * patch on the change request merges, the next generation moves the entry onto the branch the
 * merge cue names (`Landing.onto`), which is the one the change request merged into.
 *
 * Caller-held invariant: the clone has shipped nothing (`hasShipped`), the tree is clean and the
 * lock is held. Sets no `shippedHead`, because from here the branch is new work again, and drops
 * a landing a release left pending, whose generation was the old target's.
 */
export async function retargetClone(
  git: Git,
  clone: LineState,
  to: { ref: string; targetRef?: string; headSha: string; changeRequest: string },
): Promise<void> {
  await resetBranch(git, clone.checkout.dir, clone.branch, to.headSha);
  // The target moves with it: what this repo merged to catch up was the base it started from,
  // and the change request merges into its own.
  const { targetRef: _old, ...repo } = clone.repo;
  clone.repo = {
    ...repo,
    ref: to.ref,
    ...(to.targetRef === undefined ? {} : { targetRef: to.targetRef }),
  };
  clone.baseSha = to.headSha;
  clone.shippedHead = null;
  clone.changeRequest = to.changeRequest;
  // A landing pending (a release of the change request the clone stood on) is the old
  // target's: the branch now builds on this one, and nothing of it merged.
  clone.landedHead = null;
  clone.landing = null;
  clone.landedTip = null;
}

export interface ShipperDeps {
  git: GitTransport;
  gitExec: Git;
  diag: Diagnostics;
  /** Absent: nothing to report to — a CLI run; the bundle still ships. */
  patchReporter?: PatchReporter;
  runId: string;
  /** The commit subject for leftovers the harness did not commit itself — asked when a commit
   * is cut, because a run awaiting its prompt learns its subject only once the prompt arrives. */
  subject: () => string;
  /** The clock and the wait, for the window after a merge moves the repo. Real by default, and
   * MONOTONIC: a wall clock stepped back while the wait is computed would stretch it. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The run's cancel: a wait in the window ends with it. */
  signal?: AbortSignal;
}

export interface Shipper {
  /**
   * Ships one line's work, serialized per clone. After a landing it is refused until the branch
   * holds the tip fetched from where the change request merged (`landedTip`), with what to run
   * to get there. A transport that cannot fetch the merged base or cannot take the bundle is a
   * `refused` outcome with the reason and where the commits still are, for the agent to retry;
   * only mechanical breakage throws. A line new to the clone
   * (`resolveLine`'s `created`) is enlisted for the turn, refused when another branch already
   * ships as it or the clone holds `MAX_LINES_PER_REPO`, and kept only once it shipped; a line
   * whose commits include another line's own is refused (stacked lines are not supported).
   */
  submit(
    clone: LineState,
    opts?: { title?: string; description?: string },
  ): Promise<SubmitPatchOutcome>;
  /**
   * The last ship of a clone, at finalize: as `submit`, except that anything stopped
   * (`stoppedStep`: a rebase, a conflicted merge, a cherry-pick or revert sequence, a bisect,
   * unmerged entries, a HEAD off the branch) is LEFT ALONE rather than reported — nobody is left
   * to resolve it. The branch ref ships as it stands — what was committed to it so far (`git am`
   * and a pick or revert sequence commit onto it as they go; a rebase or a stopped merge never
   * moves it); nothing in the tree is committed, so uncommitted work does not ship, and
   * `abandoned` says what was left. A landed line that does not hold `landedTip` ships as the
   * next generation all the same, held for a person, and `unrebased` says so.
   * Nothing on disk is touched to get there. Two exceptions are concluded with git's own commit,
   * then shipped like any leftovers: a merge, and a single-step cherry-pick or revert, whose
   * conflicts were all resolved and staged. A transport failure THROWS here, unlike `submit`:
   * nobody is left to retry, and the run's result has to name the repo whose work did not leave
   * the box. New work is reported immediately with `requiresApproval`, and retained in
   * `shipped()` as a fallback if reporting fails. Already submitted tips stay as they were.
   * A line the checkout is not on (`holderOf`) ships its committed branch as it stands; nothing
   * stopped is its, and the tree is not its to commit.
   */
  finalize(clone: LineState): Promise<FinalizeOutcome>;
  /** Merges the clone's target as it stands now into its branch — after a landing, the branch
   * the change request merged into — serialized with submits. */
  update(clone: LineState): Promise<UpdateFromBaseOutcome>;
  /**
   * Uploads the clone's committed tip as a check candidate — the bundle a submit would cut, for
   * the platform to run checks on — serialized with submits. Nothing is committed and nothing is
   * recorded as shipped: the next submit still ships (and reports) the same tip. After a landing
   * a branch that holds `landedTip` is filed under the next generation's name, as its submit
   * will ship it. Refused, with a reason for the agent, while a rebase or merge is in progress,
   * after a landing while the branch is not on what merged, or with nothing committed since the
   * base. `dirty` says whether the tree
   * held uncommitted changes, which the candidate does not carry.
   */
  pushCandidate(clone: LineState): Promise<CheckCandidate | { refused: string }>;
  /** The latest branch shipped per path and line, in shipping order — the result's
   * `branches`. */
  shipped(): BranchOutcome[];
  /** Every patch reported so far, as last heard of. */
  patches(): PatchStatus[];
  /** Resolves once every patch cue taken so far has been applied. */
  settled(): Promise<unknown>;
  /** A patch cue from the inbox: updates what is known, and marks a landed generation, fetching
   * where it merged; or a release, which ends the generation as a merge that missed all of it
   * does (`releasedCue`). False when it is a merge or a release already taken — the control
   * plane re-sends one on every delivery of it — which changes nothing and is not news for the
   * agent; a note when the cue landed a generation, saying what the fetch found. */
  onPatchCue(clones: CloneState[], payload: PatchCue): Promise<CueTaken>;
}

/** A committed tip uploaded for checks: what the platform finds the bundle by. */
export interface CheckCandidate {
  headSha: string;
  branch: string;
  baseSha: string;
  dirty: boolean;
}

/**
 * Where a ship cuts its bundle and what it ships as: the line's current generation, or — after a
 * landing — the next one, which the line takes only once the push went out (`next`).
 */
interface ShipAt {
  base: string;
  shipAs: string;
  /** The branch the work merges into from `base`: what the stack checks count as nobody's. */
  target: string;
  /** Set for a landed line's next generation: whether it ships without holding `landedTip`. */
  next: { unrebased: boolean } | null;
}

/** A line's current generation as a ship cuts it. */
function currentAt(line: LineState): ShipAt {
  return { base: line.baseSha, shipAs: line.shipAs, target: targetOf(line.repo), next: null };
}

/** Whether a line shipped in this run: a head of it went out, or a generation of it moved on. */
function everShipped(line: LineState): boolean {
  return line.heads.length > 0 || hasShipped(line);
}

/** Whether any line of the repo shipped in this run — what the control plane's re-target asks
 * (a patch of the run for the path, of any line): a change request is only checked out before
 * a repository's first patch. */
export function anyLineShipped(clone: CloneState): boolean {
  return [...clone.lines.values()].some(everShipped);
}

/** How many other lines of `line`'s clone shipped: the slots taken (`MAX_LINES_PER_REPO`). */
function shippedBeside(line: LineState): number {
  return [...line.owner.lines.values()].filter((l) => l !== line && everShipped(l)).length;
}

/** A line as the shipped list and the candidates are keyed: its clone's path, and its name. */
function lineKey(line: LineState): string {
  return `${line.owner.repo.path}\0${line.line}`;
}

export function makeShipper(deps: ShipperDeps): Shipper {
  const { gitExec, diag } = deps;
  const now = deps.now ?? (() => performance.now());
  /** The merge cues taken, by verdict and patch: a repeat of one is no news. */
  const taken = new Set<string>();
  const sleep = deps.sleep ??
    ((ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener("abort", done, { once: true });
      }));
  // Keyed by path and line (`lineKey`): a repo ships one branch per line.
  const shippedByLine = new Map<string, BranchOutcome>();
  const order: string[] = [];
  const patches: PatchStatus[] = [];

  /** The line a cue is about, or undefined — said, with why — when the run holds none: a repo
   * it does not check out, or a line of it no submit of this run shipped (`unknownLine`). */
  const lineOf = (clones: CloneState[], payload: PatchCue): LineState | undefined => {
    const clone = clones.find((c) => c.repo.path === payload.path);
    const line = clone?.lines.get(payload.line);
    if (line === undefined) {
      diag.debug("patch.cue_unrouted", {
        runId: deps.runId,
        repo: payload.path,
        line: payload.line,
        why: clone === undefined ? "no such repo" : "no such line",
      });
    }
    return line;
  };

  /** Patch cues are taken one at a time, in order (`onPatchCue`). */
  let cues: Promise<unknown> = Promise.resolve();
  const takeCue = async (clones: CloneState[], payload: PatchCue): Promise<CueTaken> => {
    if (payload.kind === "released") {
      const key =
        `released:${payload.path}:${payload.line}:${payload.forgeRef}:${payload.generation}`;
      if (taken.has(key)) return false;
      taken.add(key);
      return await releasedCue(clones, payload);
    }
    // A merge heard before is no news, and changes nothing — not even what is known of the
    // patch. A patch missed by one merge may still be merged by a later one: each verdict once.
    if (payload.state === "merged" || payload.state === "missed") {
      const key = `${payload.state}:${payload.patchId}`;
      if (taken.has(key)) return false;
      taken.add(key);
    }
    const known = patches.find((p) => p.patchId === payload.patchId);
    if (known !== undefined) {
      // A hold is a patch back to waiting for a person, and the patches tool says so in
      // those words rather than as a state the platform's queue never shows.
      known.state = payload.state === "held"
        ? "pending_approval (held: it changes git hook files)"
        : payload.state;
      known.forgeUrl = payload.forgeUrl;
    }
    if (payload.state === "missed") return await missedCue(clones, payload);
    if (payload.state !== "merged") return true;
    const clone = lineOf(clones, payload);
    if (clone === undefined) return { note: unknownLine(payload) };
    // Only a landing in the CURRENT generation counts: an older generation's late merge changed
    // nothing the branch now builds on, and its cue's text asks for nothing more.
    if (clone.generation !== payload.generation) return { note: otherGeneration(clone, payload) };
    const inferred = payload.onto === undefined;
    // A control plane that names no branch is a version behind: the branch's own target stands
    // in, until a cue of the generation that does name one.
    const onto = payload.onto ?? targetOf(clone.repo);
    if (inferred) {
      diag.warn("patch.landed_without_onto", {
        runId: deps.runId,
        repo: payload.path,
        line: payload.line,
        onto,
      });
    }
    // What merged, as the control plane read it (`PatchPayload.landedHead`): what the agent's
    // rebase starts past. The schema holds a merged cue to naming one.
    const landed = payload.landedHead!;
    if (clone.landedHead === null || clone.landing === null) {
      clone.landedHead = landed;
      clone.landing = { onto, at: now(), inferred };
    } else {
      // Forward only: a cue for a head that holds the landed one is newer work of the branch;
      // any other (an earlier patch of the generation cued after a later one, or a head the
      // agent rewrote away between submits) leaves it where it is.
      const was = clone.landedHead;
      const ahead = landed !== was && await isAncestor(gitExec, clone.checkout.dir, was, landed);
      // The question took a moment: the generation may have moved on since.
      if (ahead && clone.generation === payload.generation && clone.landedHead === was) {
        clone.landedHead = landed;
      }
      if (clone.landing !== null && onto !== clone.landing.onto) {
        if (clone.landing.inferred && !inferred) {
          clone.landing = { onto, at: now(), inferred: false };
        } else {
          // Where the generation lands is said once: a second cue naming another branch is a
          // disagreement to log, never a reason to fetch somewhere else.
          diag.warn("patch.landed_onto_disagrees", {
            runId: deps.runId,
            repo: payload.path,
            line: payload.line,
            kept: clone.landing.onto,
            said: onto,
          });
        }
      }
    }
    diag.debug("patch.landed", {
      runId: deps.runId,
      repo: payload.path,
      line: payload.line,
      headSha: payload.headSha,
      said: payload.landedHead,
      landedHead: clone.landedHead,
      generation: payload.generation,
      onto: clone.landing?.onto,
    });
    return await fetchLanded(clone);
  };

  /**
   * A patch whose change request merged without it. Nothing changes unless the cue ends its
   * generation (`onto`: no patch of the generation merged at all): then the change request is
   * done, the repo has moved onto `onto`, and the whole generation's work goes there — the
   * landed head is the generation's base, so the agent's rebase moves every commit of it. A merge
   * of the generation already heard decides instead (its head is past the base), and a later
   * merged cue moves the landed head on from the base as from any older head.
   */
  const missedCue = async (clones: CloneState[], payload: PatchPayload): Promise<CueTaken> => {
    if (payload.onto === undefined) return true;
    const clone = lineOf(clones, payload);
    if (clone === undefined) return { note: unknownLine(payload) };
    if (clone.generation !== payload.generation) return { note: otherGeneration(clone, payload) };
    // A landing already heard decides; the cue's text still asks for the rebase.
    if (clone.landedHead !== null) return await pending(clone);
    endGeneration(clone, payload.onto);
    diag.debug("patch.landed_without_work", {
      runId: deps.runId,
      repo: payload.path,
      line: payload.line,
      generation: payload.generation,
      onto: payload.onto,
    });
    return await fetchLanded(clone);
  };

  /** Ends the clone's generation with none of it merged: the landed head is its base, so the
   * whole of its work moves onto `onto`, under the next generation's name. */
  const endGeneration = (clone: LineState, onto: string): void => {
    clone.landedHead = clone.baseSha;
    clone.landing = { onto, at: now(), inferred: false };
  };

  /**
   * Why a release is not about the clone's current generation and target, or null when it is.
   * It must end the generation the clone is in: one cued before the next generation began, and
   * heard after it, is the generation that already moved on. And a clone the run moved onto a
   * change request (`changeRequest`) targets that one alone: a release cued before the move is
   * the old target's. A clone that shipped in its generation may still take it: the control
   * plane releases only a run none of whose patches reached the change request, so the patches
   * it shipped are held, and the generation's work moves like any other.
   */
  const notTargeted = (clone: LineState, payload: ReleasedPayload): string | null => {
    if (payload.generation !== clone.generation) {
      return `the clone is in generation ${clone.generation}`;
    }
    if (clone.changeRequest !== null && clone.changeRequest !== payload.forgeRef) {
      return `the clone targets ${clone.changeRequest}`;
    }
    return null;
  };

  /**
   * The change request the clone worked merged with nothing of this run on it, and the control
   * plane let the task go of it (`ReleasedPayload`). The generation ends as a missed cue ends it
   * (`missedCue`): the agent moves the run's own commits (`baseSha..branch`) onto `onto`, and
   * the next generation's entry drops the change request's branches for `onto`
   * (`nextGeneration`), as the control plane's task did, so that submit opens a fresh change
   * request. A clone whose generation already landed has its landing to follow already: the
   * release changes nothing there.
   */
  const releasedCue = async (clones: CloneState[], payload: ReleasedPayload): Promise<CueTaken> => {
    const clone = lineOf(clones, payload);
    const why = clone === undefined
      ? "no such line"
      : clone.landedHead !== null
      ? "a landing is already under way"
      : notTargeted(clone, payload);
    if (clone === undefined || why !== null) {
      diag.debug("patch.release_ignored", {
        runId: deps.runId,
        repo: payload.path,
        line: payload.line,
        forgeRef: payload.forgeRef,
        generation: payload.generation,
        why,
      });
      if (clone === undefined) return { note: unknownLine(payload) };
      if (clone.generation !== payload.generation) {
        return { note: otherGeneration(clone, payload) };
      }
      if (clone.landedHead !== null) return await pending(clone);
      return {
        note: `ryph: nothing to do for this one: ${inCode(clone.branch)} in ` +
          `${inCode(clone.owner.repo.path)} now works on change request ` +
          `${inCode(`#${clone.changeRequest}`)}; leave it as it is.`,
      };
    }
    endGeneration(clone, payload.onto);
    diag.debug("patch.released", {
      runId: deps.runId,
      repo: payload.path,
      line: payload.line,
      forgeRef: payload.forgeRef,
      generation: clone.generation,
      onto: payload.onto,
    });
    return await fetchLanded(clone);
  };

  /**
   * The landing cue's fetch: `onto` into `refs/remotes/origin/<onto>`, taken as `landedTip`
   * (`takeTip`), and the line the cue's text gains for the agent — the fetched commit and the
   * exact rebase, or that the fetch failed and how to get it, or that `onto` is gone and the line
   * ships no more. Authoritative over the control plane's text, which defers to it: only the
   * runner knows the line's local branch and its forward-only landed head. Never a throw, and
   * nothing but that ref moves. Not under the clone's lock (finalize waits on the cues under it):
   * a submit that moved the line to its next generation meanwhile keeps its own state, and the
   * note says the line already ships as its next change request.
   */
  const fetchLanded = async (clone: LineState): Promise<CueTaken> => {
    const { landing, landedHead, generation } = clone;
    if (landing === null || landedHead === null) return true;
    const { onto } = landing;
    const movedOn = () => clone.generation !== generation || clone.landing === null;
    try {
      const tip = await fetchLanding(clone);
      if (movedOn()) return { note: otherGeneration(clone, { generation }) };
      await takeTip(clone, tip);
      return {
        note: `ryph fetched ${inCode(`origin/${onto}`)} at \`${tip.slice(0, 12)}\`. ` +
          `To go on with ${inCode(clone.branch)}, ${await goOn(clone, onto, landedHead)}. ` +
          freshStart(onto, clone.branch),
      };
    } catch (err) {
      diag.warn("patch.landing_unfetched", { runId: deps.runId, repo: clone.repo.path, err });
      if (movedOn()) return { note: otherGeneration(clone, { generation }) };
      if (refGone(err)) return { note: `ryph: ${goneText(onto, clone.branch)}` };
      return {
        note: `ryph could not fetch ${inCode(`origin/${onto}`)} (${briefError(err, 300)}); ` +
          "call ryph__update_from_base to fetch and merge it.",
      };
    }
  };

  /** The ways on after a landing, for the line as the checkout stands now: the rebase
   * (`rebaseStep`), or the merge (`mergeStep`). Reads after "To go on, ". */
  const goOn = async (clone: LineState, onto: string, landedHead: string): Promise<string> => {
    const current = await currentBranch(gitExec, clone.checkout.dir);
    return `${rebaseStep(onto, landedHead, clone.branch, current)}, or ` +
      mergeStep(clone.branch, current);
  };

  /** A cue for a generation whose landing was heard already: nothing changes, and the note
   * repeats what the agent runs, since the cue's own text defers to it. */
  const pending = async (clone: LineState): Promise<CueTaken> => {
    const { landing, landedHead } = clone;
    if (landing === null || landedHead === null) return true;
    return {
      note: `ryph: the change request of ${inCode(clone.branch)} already merged into ` +
        `${inCode(landing.onto)}. To go on with ${inCode(clone.branch)}, ` +
        `${await goOn(clone, landing.onto, landedHead)}. ${freshStart(landing.onto, clone.branch)}`,
    };
  };

  /** A cue for a generation the line is not in: one it has left (its next change request shipped
   * already), or, should one ever come, one it has not reached. */
  const otherGeneration = (
    clone: LineState,
    payload: { generation: number },
  ): string =>
    clone.generation > payload.generation
      ? `ryph: nothing to do for this one: ${inCode(clone.branch)} already ships as ` +
        `${inCode(clone.shipAs)}, its next change request; leave it as it is.`
      : `ryph: nothing to do for this one: ${inCode(clone.branch)} is in generation ` +
        `${clone.generation}, not ${payload.generation}; leave it as it is.`;

  /** A cue for a line the run does not hold: nothing of this run's to move. */
  const unknownLine = (payload: { path: string; line: string }): string =>
    `ryph: nothing to do for this one: ryph does not know the line ${inCode(payload.line)} of ` +
    `${inCode(payload.path)} in this run; leave your branches as they are.`;

  const ship = async (
    clone: LineState,
    opts: { title?: string; description?: string; finalizing?: boolean },
  ): Promise<FinalizeOutcome> => {
    const { repo, checkout } = clone;
    const dir = checkout.dir;

    // The tree on disk is the line the checkout is on. Any other line ships its committed branch
    // as it stands: what is uncommitted, conflicted or stopped there is the other line's. At
    // finalize, a checkout on no line of the clone (a detached HEAD, a branch never submitted)
    // is the default line's to answer for, as it always was (`off-branch`).
    const holder = await holderOf(gitExec, clone.owner) ??
      (opts.finalizing === true ? clone.owner.lines.get(DEFAULT_LINE) : undefined);
    if (holder !== clone) return await shipTree(clone, { ...opts, leaveTree: true });

    // At finalize a stopped operation (`stoppedStep`) is never touched: not aborted, reset,
    // staged, unstaged, continued or concluded. The branch ref ships as it stands, and nothing
    // uncommitted ships; the run's summary says so (`abandoned`), whatever the ship came to.
    // Two exceptions are concluded with git's own commit, as mid-run: a single-step cherry-pick
    // or revert resolved and staged (here), and a resolved merge (below).
    if (opts.finalizing === true) {
      const stopped = await stoppedStep(gitExec, dir, clone.branch);
      if (stopped !== null && stopped.concludable) {
        // git's own commit; should it refuse, the pick is left as it stands like any other stop.
        try {
          await concludePick(gitExec, dir);
        } catch (err) {
          diag.warn("patch.pick_not_concluded", { runId: deps.runId, repo: repo.path, err });
          return await shipLeftStopped(clone, stopped, opts);
        }
      } else if (stopped !== null) {
        return await shipLeftStopped(clone, stopped, opts);
      }
    } else if (await rebaseInProgress(dir)) {
      // The agent's own rebase: its to finish. A `git add -A; git commit` in the middle of it
      // would commit the wrong thing, and the branch ref is not where the rebase is going yet.
      return {
        kind: "refused",
        reason:
          `${inCode(repo.path)} has a rebase in progress: finish it (\`git rebase --continue\`) ` +
          "or abort it, then submit",
      };
    }
    // A merge `update` left for the agent: concluded once nothing is conflicted any more, with
    // whatever the agent staged — the rest of the tree is committed below like any leftover.
    if (await mergeInProgress(dir)) {
      const conflicts = await conflictedPaths(gitExec, dir);
      if (conflicts.length > 0) {
        return { kind: "conflict", step: "merge", path: repo.path, files: conflicts };
      }
      try {
        await concludeMerge(gitExec, dir);
      } catch (err) {
        if (opts.finalizing !== true) throw err;
        // As a pick above: should git refuse at finalize, the merge (MERGE_HEAD and all) is
        // left as it stands and the branch ships without it.
        diag.warn("patch.merge_not_concluded", { runId: deps.runId, repo: repo.path, err });
        return await shipLeftStopped(clone, { step: "merge", conflicts: [] }, opts);
      }
    }
    return await shipTree(clone, opts);
  };

  /** Finalize over a stopped operation: see `ship`. */
  const shipLeftStopped = async (
    clone: LineState,
    stopped: { step: StoppedStep; conflicts: string[] },
    opts: { title?: string; description?: string; finalizing?: boolean },
  ): Promise<FinalizeOutcome & { abandoned: LeftStopped }> => {
    const { repo, checkout } = clone;
    const target = stopped.step === "merge" ? targetOf(repo) : null;
    // Commits HEAD holds that neither the branch nor any remote does: work of the agent's that
    // stays in the box with the rest. A stopped rebase holds copies of the branch's own commits
    // under new SHAs, so a commit counts only if no branch commit carries the same patch. That
    // is a second walk: `--not --remotes` on the symmetric range would hide branch commits a
    // remote also holds from the comparison.
    const shas = (out: string) => out.split("\n").filter((l) => l !== "");
    const off = shas(
      await gitExec(
        checkout.dir,
        "rev-list",
        "HEAD",
        "--not",
        `refs/heads/${clone.branch}`,
        "--remotes",
      ).catch(() => ""),
    );
    const headCommits = off.length > 0 &&
      await gitExec(
        checkout.dir,
        "rev-list",
        "--right-only",
        "--cherry-pick",
        `refs/heads/${clone.branch}...HEAD`,
      ).then((out) => {
        const unshipped = new Set(shas(out));
        return off.some((sha) => unshipped.has(sha));
      }, () => true);
    diag.warn("patch.left_stopped", {
      runId: deps.runId,
      repo: repo.path,
      step: stopped.step,
      conflicts: stopped.conflicts,
      landed: clone.landedHead !== null,
    });
    const outcome = await shipTree(clone, { ...opts, leaveTree: true });
    // `refused` at this point is the report failing after the bundle left: it shipped.
    const branch = outcome.kind === "nothing-to-submit" ? "nothing-new" : "shipped";
    return {
      ...outcome,
      abandoned: {
        step: stopped.step,
        target,
        conflicts: stopped.conflicts,
        headCommits,
        branch,
      },
    };
  };

  /**
   * Starts the line's next generation once its landed one is done with and the push of the next
   * went out (`shipTree`): the branch ships from `base` under the next generation's name — a
   * suffix, because a ref cannot be both a branch and a directory. No branch is renamed or
   * moved: only what the line ships as changes.
   */
  const nextGeneration = (clone: LineState, base: string): void => {
    const { landing } = clone;
    if (landing === null) throw new Error(`${clone.repo.path}: a generation with no landing`);
    const next = lineBranch(clone.repo.branchNamespace, clone.line, clone.generation + 1);
    // Everything of this generation up to the landed head merged; what a head of it holds beyond
    // that is what the next generation carries (`carriedHeads`).
    for (const head of clone.heads) {
      if (head.generation === clone.generation) head.landed = clone.landedHead;
    }
    clone.shipAs = next;
    clone.baseSha = base;
    clone.generation += 1;
    // And the entry follows the control plane: where the change request merged is its base from
    // here, with no target beyond it, so `fetchBase`, `update` and `targetOf` agree with the task
    // — the same move as `retargetClone`, in the other direction. For a pull request the run
    // opened against its own base this is usually the base it already had.
    const { targetRef: _merged, ...rest } = clone.repo;
    clone.repo = { ...rest, ref: landing.onto };
    // The next generation's patch opens a change request of its own.
    clone.changeRequest = null;
    clone.landedHead = null;
    clone.landing = null;
    clone.landedTip = null;
    // Nothing of THIS generation has shipped: what `shippedHead` named was the last one's.
    clone.shippedHead = null;
    diag.debug("patch.next_generation", {
      runId: deps.runId,
      repo: clone.repo.path,
      line: clone.line,
      shipAs: next,
      generation: clone.generation,
    });
  };

  /**
   * The tip of the branch the landing moved the repo onto (the cue's `onto`), fetched through the
   * transport into `refs/remotes/origin/<onto>`. Right after a merge moves the repo, the gateway
   * can still be serving the old head branch (`GRANT_SETTLE_MS`), and a deleted one fails the
   * fetch. Waiting out the rest of that window and asking once more turns a failure the agent
   * could do nothing about but repeat into the fetch it needs. Clamped to the window whatever the
   * clock says (never longer, never negative), and cut short by a cancel; any other failed fetch
   * throws at once, as ever.
   */
  const fetchLanding = async (clone: LineState): Promise<string> => {
    const { repo, checkout } = clone;
    if (clone.landing === null) throw new Error(`${repo.path}: a landed head with no landing`);
    const { onto, at } = clone.landing;
    const fetchOnto = async () => (await deps.git.fetchBase(checkout, repo, onto)).sha;
    try {
      return await fetchOnto();
    } catch (err) {
      const left = Math.min(GRANT_SETTLE_MS, at + GRANT_SETTLE_MS - now());
      if (left <= 0) throw err;
      diag.debug("patch.landing_fetch_waits", {
        runId: deps.runId,
        repo: repo.path,
        onto,
        ms: left,
      });
      await sleep(left, deps.signal);
      return await fetchOnto();
    }
  };

  /**
   * The heads this clone shipped before `head` whose work `head` carries in full (helpers/
   * checkout.ts `carriesWork`), for memory: a claim bound to one of their patches follows the
   * carry, and holds once a patch that carries it lands — by content, never by position. A head
   * the landed head of its generation holds merged itself and needs no carrying; one its
   * generation passed over (shipped after the head that merged, or set aside by a rewrite) is
   * measured past what did land.
   *
   * Every carried head, newest first, at most `MAX_CARRIES`: memory unions what it hears, so the
   * whole list each time costs nothing it did not already hold. Never a throw: a git failure
   * answers none, so a claim may wait or drop for want of an edge, but is never credited for
   * work nobody checked.
   */
  const carriedHeads = async (clone: LineState, head: string): Promise<string[]> => {
    const dir = clone.checkout.dir;
    const carried: string[] = [];
    const read = new Set<string>();
    try {
      // What a merge of the target brought in is not the agent's work, wherever it sits.
      const target = `refs/remotes/origin/${targetOf(clone.repo)}`;
      const upstream = await refExists(gitExec, dir, target) ? [target] : [];
      for (const earlier of [...clone.heads].reverse()) {
        if (carried.length >= MAX_CARRIES) {
          diag.warn("patch.carries_capped", {
            runId: deps.runId,
            repo: clone.repo.path,
            kept: MAX_CARRIES,
          });
          break;
        }
        if (read.has(earlier.sha)) continue;
        read.add(earlier.sha);
        // The same head shipped again in this generation is this patch itself. Shipped in an
        // earlier one, it is that generation's patch, carried whole: a merge that fast-forwarded
        // to the landed head leaves the passed-over head's commits as they were, so the next
        // generation's head can be that very commit.
        if (earlier.sha === head) {
          if (earlier.generation !== clone.generation) carried.push(earlier.sha);
          continue;
        }
        const { landed } = earlier;
        if (landed !== null && await isAncestor(gitExec, dir, earlier.sha, landed)) continue;
        const past = landed === null ? [earlier.base] : [earlier.base, landed];
        if (
          await carriesWork(
            gitExec,
            dir,
            { head: earlier.sha, past },
            { head, base: clone.baseSha },
            upstream,
            diag,
          )
        ) {
          carried.push(earlier.sha);
        }
      }
    } catch (err) {
      diag.warn("patch.carries_unread", { runId: deps.runId, repo: clone.repo.path, err });
      return [];
    }
    return carried;
  };

  /**
   * Takes a tip of `onto` fetched after the landing as the one the submit rule asks for: the
   * first one fetched, or a later one that no longer holds the tip asked for so far (`onto` was
   * force-pushed or rewound since), which nothing could satisfy any more. A later tip that holds
   * it changes nothing.
   */
  const takeTip = async (clone: LineState, fresh: string): Promise<void> => {
    const was = clone.landedTip;
    if (was === fresh) return;
    if (was !== null && await isAncestor(gitExec, clone.checkout.dir, was, fresh)) return;
    clone.landedTip = fresh;
  };

  /**
   * The submit rule after a landing, asked alike by a submit and a check: where a ship of the
   * line cuts its bundle and what it ships as, or why it cannot. Without a landing, the current
   * generation. With one: a branch with nothing past the landed head has nothing to ship (`dirty`:
   * leftovers the ship is about to commit, which are something); else `onto` is fetched again and
   * taken (`takeTip`), and a branch that holds `landedTip` ships as the next generation, from
   * where it meets `onto` as fetched now — unless its tree is that tip's or that base's, which
   * is nothing to ship either. Nothing of the line's state moves until the push went
   * out (`nextGeneration`, in `shipTree`). Mid-run, a branch not on it, or an `onto` gone from the
   * origin, is a refusal in the agent's words, ending in `then`. At finalize nobody is left to
   * rebase: a branch not on it ships all the same, as the next generation, marked `unrebased` —
   * withholding it would lose the commits with the throwaway checkout.
   */
  const landedAt = async (
    clone: LineState,
    opts: { finalizing: boolean; dirty: boolean; then: string },
  ): Promise<ShipAt | { refused: string } | { nothing: true }> => {
    const { repo, landing, landedHead } = clone;
    if (landing === null || landedHead === null) return currentAt(clone);
    const dir = clone.checkout.dir;
    const branchRef = `refs/heads/${clone.branch}`;
    const { onto } = landing;
    // Nothing past what merged (a merge-commit landing leaves the branch at the landed head):
    // nothing to ship and no next generation, so the base is not read — a branch deleted
    // upstream on merge must not fail a finalize over work that already shipped.
    if (!opts.dirty && (await commitsSince(gitExec, dir, landedHead, branchRef)).length === 0) {
      return { nothing: true };
    }
    let fresh: string | null = null;
    try {
      fresh = await fetchLanding(clone);
      await takeTip(clone, fresh);
    } catch (err) {
      diag.warn("patch.landing_refetch_failed", { runId: deps.runId, repo: repo.path, err });
      // Gone is gone, whatever tip an earlier fetch took: a branch on it would ship against a
      // base the origin no longer has.
      if (!opts.finalizing && refGone(err)) {
        return { refused: `${inCode(repo.path)}: ${goneText(onto, clone.branch)}` };
      }
      if (!opts.finalizing && clone.landedTip === null) {
        return {
          refused: `${inCode(repo.path)}: ${inCode(`origin/${onto}`)} could not be fetched (${
            briefError(err, 300)
          }); try again`,
        };
      }
    }
    const tip = clone.landedTip;
    const onTip = tip !== null && await isAncestor(gitExec, dir, tip, branchRef);
    if (!onTip && !opts.finalizing) {
      return {
        refused: `${inCode(repo.path)}: your change request merged into ${inCode(onto)}, and ` +
          `${inCode(clone.branch)} is not on it yet: it does not hold ${
            inCode(`origin/${onto}`)
          } at \`${tip!.slice(0, 12)}\`. To go on, ${await goOn(clone, onto, landedHead)}, ` +
          `then ${opts.then}`,
      };
    }
    const against = fresh ?? tip;
    const base = against === null
      ? clone.baseSha
      : await gitExec(dir, "merge-base", branchRef, against).catch(() => clone.baseSha);
    // Nothing past what merged in what the tree holds: the branch's tree is `onto`'s, or, on the
    // tip, the base's (a merge of `onto` after a squash, with nothing new). Its next change request
    // would change nothing. Off the tip the base is the old generation's, and a branch back at
    // its tree undid what merged: that ships, held.
    if (
      !opts.dirty && await sameTree(gitExec, dir, branchRef, onTip ? [against, base] : [against])
    ) {
      return { nothing: true };
    }
    return {
      base,
      shipAs: lineBranch(clone.repo.branchNamespace, clone.line, clone.generation + 1),
      target: onto,
      next: { unrebased: !onTip },
    };
  };

  const shipTree = async (
    clone: LineState,
    opts: {
      title?: string;
      description?: string;
      /** Ship the committed branch as it stands: nothing in the tree is committed. */
      leaveTree?: boolean;
      finalizing?: boolean;
    },
  ): Promise<FinalizeOutcome> => {
    const { repo, checkout } = clone;
    const dir = checkout.dir;
    const finalizing = opts.finalizing === true;
    // A transport failure mid-run is the agent's to retry, worded for it. At finalize it stays
    // a throw: the final result must name the repo whose bundle never left.
    const transportRefused = (
      err: unknown,
      reason: (message: string) => string,
    ): SubmitPatchOutcome => {
      if (finalizing) throw err;
      return { kind: "refused", reason: `${repo.path}: ${reason(errorMessage(err))}; try again` };
    };

    // The generation. A patch of this branch merged, and pushing more onto its merged change
    // request is a refusal the forge already makes: the branch ships as the next generation,
    // once it is on what merged (`landedAt`). Mid-run asked first, so a refusal leaves the tree
    // uncommitted; at finalize after the leftovers are committed, which count toward what ships.
    const dirty = opts.leaveTree !== true && await hasChanges(gitExec, dir);
    const landed = async (dirty: boolean): Promise<ShipAt | FinalizeOutcome> => {
      const at = await landedAt(clone, { finalizing, dirty, then: "submit again" });
      if ("refused" in at) return { kind: "refused", reason: at.refused };
      if ("nothing" in at) return { kind: "nothing-to-submit", path: repo.path };
      return at;
    };
    let at = finalizing ? null : await landed(dirty);
    if (at !== null && "kind" in at) return at;
    if (dirty) await commitAll(gitExec, dir, opts.title ?? deps.subject());
    at ??= await landed(false);
    if ("kind" in at) return at;

    const commits = await commitsSince(gitExec, dir, at.base, `refs/heads/${clone.branch}`);
    if (commits.length === 0) return { kind: "nothing-to-submit", path: repo.path };
    // Nothing new since the last submit: the bundle is already out there, and finalize after
    // a mid-run submit must not cut it — or report it — a second time. What the landed
    // generation shipped is not the next one's: the same head ships again under its new name.
    const headSha = await branchSha(gitExec, dir, clone.branch);
    if (at.next === null && headSha === clone.shippedHead) {
      return { kind: "nothing-to-submit", path: repo.path };
    }
    // Lines are unrelated: one that holds another's own commits would ship them twice, as two
    // change requests. Refused mid-run, for the agent to start the branch from the base. At
    // finalize nobody is left to: a line whose head is, or holds, another's own head is not
    // shipped — on the very same head the control plane would refuse its patch at birth
    // (core/open_patch.ts), and holding it would put that line's work up for review twice —
    // and the run's summary says so. Nor is a line past the repo's last slot.
    if (finalizing) {
      const shadow = await shadowedBy(clone, headSha, at);
      if (shadow !== null) {
        const how = shadow.tip === headSha ? "is the same commit as" : "holds";
        return {
          kind: "nothing-to-submit",
          path: repo.path,
          withheld: `its head ${how} ${inCode(shadow.line.branch)}'s ` +
            `(${shadow.tip.slice(0, 10)}), which ships as its own change request, and ` +
            "branches stacked on each other are not supported yet",
        };
      }
      const under = await stackedAtFinalize(clone, headSha, at);
      if (under !== null) {
        return {
          kind: "nothing-to-submit",
          path: repo.path,
          withheld: `it holds commits of ${inCode(under.branch)}, which ships as its own change ` +
            "request, and branches stacked on each other are not supported yet",
        };
      }
      if (!everShipped(clone) && shippedBeside(clone) >= MAX_LINES_PER_REPO) {
        return {
          kind: "nothing-to-submit",
          path: repo.path,
          withheld: `${repo.path} already ships ${MAX_LINES_PER_REPO} branches in this run, ` +
            "the most one repository may",
        };
      }
    } else {
      const under = await stackedOn(clone, headSha, at);
      if (under !== null) {
        return {
          kind: "refused",
          reason:
            `${repo.path}: ${inCode(clone.branch)} holds commits of ${inCode(under.branch)}, ` +
            "which ships as its own change request, and branches stacked on each other are " +
            "not supported yet. Start this branch from the base instead " +
            `(${startFrom(at.next === null ? clone.repo.ref : at.target)}, then cherry-pick ` +
            "its own commits) and submit that",
        };
      }
    }

    const { base, shipAs } = at;
    try {
      await shipRef(
        clone,
        shipAs,
        headSha,
        () => deps.git.push(checkout, clone.repo, { name: shipAs, baseSha: base }),
      );
    } catch (err) {
      return transportRefused(
        err,
        (m) =>
          `the commits could not be shipped (${m}); your commits are still on ${
            inCode(clone.branch)
          }`,
      );
    }
    // The bundle left: only now does a landed line move to its next generation. A refusal, a
    // failed push or nothing to ship above leaves the landing standing, so the submit rule still
    // holds the next try. A report that fails below does not undo it: the work shipped, and the
    // run's result opens its patch.
    if (at.next !== null) {
      if (at.next.unrebased) {
        clone.unrebased = { onto: at.target };
        diag.warn("patch.shipped_unrebased", {
          runId: deps.runId,
          repo: repo.path,
          onto: at.target,
        });
      }
      nextGeneration(clone, base);
    }
    clone.shippedHead = headSha;
    const carries = await carriedHeads(clone, headSha);
    clone.heads.push({
      sha: headSha,
      generation: clone.generation,
      base: clone.baseSha,
      landed: null,
    });
    const branch: BranchOutcome = {
      connectedRepoId: repo.connectedRepoId,
      path: repo.path,
      line: clone.line,
      name: clone.shipAs,
      headSha,
      baseSha: clone.baseSha,
      commits,
      generation: clone.generation,
      carries,
    };
    const key = lineKey(clone);
    if (!shippedByLine.has(key)) order.push(key);
    shippedByLine.set(key, branch);

    // Report finalization work immediately too, but never authorize it automatically.
    if (deps.patchReporter === undefined) {
      return {
        kind: "submitted",
        patchId: "local",
        state: "unreported",
        path: repo.path,
        branch: branch.name,
        headSha: branch.headSha,
        generation: branch.generation,
        url: null,
      };
    }
    try {
      const { patchId, state, url, forgeUrl, forgeRef } = await deps.patchReporter.reportPatch({
        branch,
        baseSha: clone.baseSha,
        ...(opts.finalizing === true ? { requiresApproval: true } : {}),
        ...(opts.title === undefined ? {} : { title: opts.title }),
        ...(opts.description === undefined ? {} : { description: opts.description }),
      });
      patches.push({
        patchId,
        path: repo.path,
        branch: branch.name,
        generation: branch.generation,
        headSha: branch.headSha,
        state,
        forgeUrl: forgeUrl ?? null,
        url: url ?? null,
      });
      diag.debug("patch.reported", {
        runId: deps.runId,
        repo: repo.path,
        line: clone.line,
        patchId,
        state,
      });
      return {
        kind: "submitted",
        patchId,
        state,
        path: repo.path,
        branch: branch.name,
        headSha: branch.headSha,
        generation: branch.generation,
        url: url ?? null,
        forgeUrl: forgeUrl ?? null,
        forgeRef: forgeRef ?? null,
      };
    } catch (err) {
      // The work left the box; only the word about it did not. The result names the branch
      // again, and the control plane opens the patch then.
      const reason = errorMessage(err);
      diag.warn("patch.report_failed", { runId: deps.runId, repo: repo.path, err: reason });
      return {
        kind: "refused",
        reason: `${repo.path}: the commits were shipped, but the patch could not be recorded ` +
          `(${reason}); when the run ends, any patch not already recorded will be opened awaiting approval`,
      };
    }
  };

  /**
   * Runs `push` with `refs/heads/<shipAs>` at `head`: the runner's own branch already is that
   * ref; a branch the agent named gets one made for the push alone — the bundle declares the
   * ref it is cut from, and the intake takes only the line's own name — and removed after. Made
   * only where no ref of that name exists, so a branch of the agent's is never moved or deleted.
   */
  const shipRef = async <T>(
    clone: LineState,
    shipAs: string,
    head: string,
    push: () => Promise<T>,
  ) => {
    if (clone.branch === shipAs) return await push();
    const dir = clone.checkout.dir;
    const ref = `refs/heads/${shipAs}`;
    try {
      // The empty old value: create, never overwrite.
      await gitExec(dir, "update-ref", ref, head, "");
    } catch (err) {
      throw new Error(
        `a local branch ${inCode(shipAs)} is in the way of shipping ${inCode(clone.branch)} ` +
          `(${errorMessage(err)}); delete or rename it`,
      );
    }
    try {
      return await push();
    } finally {
      await gitExec(dir, "update-ref", "-d", ref, head).catch((err) =>
        diag.warn("patch.ship_ref_left", { runId: deps.runId, repo: clone.repo.path, ref, err })
      );
    }
  };

  /**
   * What a line's target already holds, as the clone last fetched it (`origin/<target>`), or
   * nothing when the clone has no such ref: the commits no line owns. A merged line's commits are
   * there once the target is fetched (an `update_from_base`, a landing's fetch), and a line
   * that merged the target in (`update`) reaches them through that merge's second parent — they
   * are the target's from then on, not the merged line's, and counting them made a catch-up read
   * as a stack.
   */
  const heldByTarget = async (
    line: LineState,
    target = targetOf(line.repo),
  ): Promise<string[]> => {
    const ref = `refs/remotes/origin/${target}`;
    return await refExists(gitExec, line.checkout.dir, ref) ? [ref] : [];
  };

  /**
   * What of `other`'s line is no longer its own: its target as fetched (`heldByTarget`) and,
   * once a patch of it merged, the head that landed (`landedHead`) — merged work, whatever the
   * target as the clone last fetched it says.
   */
  const settledOf = async (other: LineState): Promise<string[]> => [
    ...await heldByTarget(other),
    ...(other.landedHead === null ? [] : [other.landedHead]),
  ];

  /**
   * Another line of the clone whose own commits `head` holds, or null: its first-parent commits
   * past its base, on its branch as it stands and as it last shipped. First-parent, so what a
   * merge of the target brought into it — which a line started from that target holds too —
   * is not counted as the line's. Neither line's own work counts what its target already holds
   * (`heldByTarget`), nor the other's what merged of it (`settledOf`): a line that merged its
   * target after another line's patch merged there holds that line's commits through the merge,
   * and is no stack. A branch git cannot read counts nothing.
   */
  const stackedOn = async (
    clone: LineState,
    head: string,
    at: ShipAt,
  ): Promise<LineState | null> => {
    const own = await ownCommits(clone, head, at);
    if (own.size === 0) return null;
    for (const other of clone.owner.lines.values()) {
      if (other === clone || other.line === clone.line) continue;
      if (await holdsOwnOf(own, other)) return other;
    }
    return null;
  };

  /** What `head` holds past `clone`'s base that its target does not (`stackedOn`), the base and
   * target as the ship cuts them (`at`): a landed line's next generation's. */
  const ownCommits = async (
    clone: LineState,
    head: string,
    at: ShipAt = currentAt(clone),
  ): Promise<Set<string>> => {
    const out = await gitExec(
      clone.checkout.dir,
      "rev-list",
      "--end-of-options",
      head,
      `^${at.base}`,
      ...(await heldByTarget(clone, at.target)).map((ref) => `^${ref}`),
    );
    return new Set(out.split("\n").filter((sha) => sha !== ""));
  };

  /** Whether `own` holds any of `other`'s own first-parent commits, on its branch as it stands or
   * as it last shipped, less what merged of it (`stackedOn`). */
  const holdsOwnOf = async (own: Set<string>, other: LineState): Promise<boolean> => {
    const settled = (await settledOf(other)).map((ref) => `^${ref}`);
    const tips = [
      `refs/heads/${other.branch}`,
      ...(other.shippedHead === null ? [] : [other.shippedHead]),
    ];
    for (const tip of tips) {
      const theirs = await gitExec(
        other.checkout.dir,
        "rev-list",
        "--first-parent",
        "--end-of-options",
        tip,
        `^${other.baseSha}`,
        ...settled,
      ).then((out) => out.split("\n").filter((sha) => sha !== ""), () => []);
      if (theirs.some((sha) => own.has(sha))) return true;
    }
    return false;
  };

  /**
   * `stackedOn`, at finalize: another line whose own commits `head` holds although it holds
   * none of `clone`'s, or one that already shipped. A line that merged another in (`git merge
   * <ns>/work`, no submit after) holds that line's commits without its head, and shipping both
   * would put them up for review twice. Two lines that each hold the other's (the same work
   * on both, or work both share) are not told apart by which is stacked: whichever finalize
   * reaches first ships, as for the same head (`shadowedBy`), and the other then finds it
   * shipped.
   */
  const stackedAtFinalize = async (
    clone: LineState,
    head: string,
    at: ShipAt,
  ): Promise<LineState | null> => {
    const own = await ownCommits(clone, head, at);
    if (own.size === 0) return null;
    for (const other of clone.owner.lines.values()) {
      if (other === clone || other.line === clone.line) continue;
      if (!await holdsOwnOf(own, other)) continue;
      if (other.shippedHead !== null) return other;
      const theirHead = await branchSha(gitExec, other.checkout.dir, other.branch).catch(() =>
        null
      );
      const mutual = theirHead !== null &&
        await holdsOwnOf(await ownCommits(other, theirHead).catch(() => new Set<string>()), clone);
      if (!mutual) return other;
    }
    return null;
  };

  /**
   * Another line of the clone whose own head `head` is or holds, at finalize: the head it shipped,
   * or its branch tip, which it ships at finalize too. A head of a line's own is past that line's
   * base, and counts only past `clone`'s base too: what both started from is the target's, not
   * either line's. Nor does a head either line's target already holds, or one the other line's
   * landed head does (`settledOf`): merged work, which a line that caught up with its target
   * holds through that merge (`stackedOn`). The same head as a line that has not shipped it does
   * not count — whichever finalize reaches first ships it, and the other line then finds it
   * shipped. A branch git cannot read counts nothing.
   */
  const shadowedBy = async (
    clone: LineState,
    head: string,
    at: ShipAt,
  ): Promise<{ line: LineState; tip: string } | null> => {
    const dir = clone.checkout.dir;
    const ours = [at.base, ...await heldByTarget(clone, at.target)];
    for (const other of clone.owner.lines.values()) {
      if (other === clone) continue;
      const tip = await branchSha(gitExec, dir, other.branch).catch(() => null);
      const tips = new Set([other.shippedHead, tip].filter((t): t is string => t !== null));
      const settled = [other.baseSha, ...ours, ...await settledOf(other)];
      for (const t of tips) {
        if (t === head && other.shippedHead !== head) continue;
        if (!await isAncestor(gitExec, dir, t, head)) continue;
        if (await someAncestor(gitExec, dir, t, settled)) continue;
        return { line: other, tip: t };
      }
    }
    return null;
  };

  const update = async (clone: LineState): Promise<UpdateFromBaseOutcome> => {
    const { repo, checkout } = clone;
    const dir = checkout.dir;
    const path = repo.path;
    const refused = (reason: string): UpdateFromBaseOutcome => ({ kind: "refused", reason });
    if (await mergeInProgress(dir)) {
      return refused(
        `${
          inCode(path)
        } already has a merge in progress: resolve the conflicts, stage them and call ` +
          "submit_patch (or `git commit --no-edit`), or `git merge --abort`, first",
      );
    }
    if (await rebaseInProgress(dir)) {
      return refused(
        `${
          inCode(path)
        } has a rebase in progress: finish it (\`git rebase --continue\`) or abort it, first`,
      );
    }
    // The merge lands on whatever is checked out, and what ships is the run's branch: an agent
    // that switched away would see the merge go somewhere nothing ships from.
    const on = await currentBranch(gitExec, dir);
    if (on !== clone.branch) {
      return refused(
        `${inCode(path)} is not on ${inCode(clone.branch)} (${
          on === null ? "HEAD is detached" : `it is on ${inCode(on)}`
        }); check it out first`,
      );
    }
    if (await hasChanges(gitExec, dir)) {
      return refused(
        `${
          inCode(path)
        } has uncommitted changes: commit them first, so the merge cannot mix with them`,
      );
    }

    // After a landing, the branch the change request merged into: the merge is one way to put
    // the branch on what merged, which the next submit asks for (`landedAt`).
    const target = clone.landing?.onto ?? targetOf(repo);
    let tip: string;
    try {
      tip = clone.landing === null
        ? (await deps.git.fetchBase(checkout, repo, target)).sha
        : await fetchLanding(clone);
    } catch (err) {
      if (clone.landing !== null && refGone(err)) {
        return refused(`${inCode(path)}: ${goneText(target, clone.branch)}`);
      }
      return refused(
        `${inCode(path)}: ${inCode(target)} could not be fetched (${
          briefError(err, 300)
        }); try again`,
      );
    }
    // The cue's own fetch failed: this one stands in for it. Or `onto` moved under the tip the
    // submit rule asked for: the rule asks for this one from here.
    if (clone.landing !== null) await takeTip(clone, tip);
    const branchRef = `refs/heads/${clone.branch}`;
    if (await isAncestor(gitExec, dir, tip, branchRef)) {
      return { kind: "up-to-date", path, target, tip };
    }
    // After a landing, a branch with nothing past what `onto` holds (rebased, nothing new yet)
    // catches up by fast-forward: a merge would be the next change request's only commit, a
    // patch that changes nothing. The base is the next submit's to work out.
    if (clone.landing !== null && await isAncestor(gitExec, dir, branchRef, tip)) {
      await resetBranch(gitExec, dir, clone.branch, tip);
      diag.debug("patch.base_moved", { runId: deps.runId, repo: path, target, tip });
      return { kind: "moved", path, target, tip };
    }
    // Nothing of the run's own on its own base: moving the base IS catching up, and a merge
    // commit would be the run's only commit, shipping a patch that changes nothing. Only where
    // the branch is the run's — a change request's branch always takes the merge, so what
    // lands on it is a commit its reviewers can see.
    const own = await commitsSince(gitExec, dir, clone.baseSha, branchRef);
    if (
      repo.targetRef === undefined && own.length === 0 && clone.shippedHead === null &&
      await isAncestor(gitExec, dir, clone.baseSha, tip)
    ) {
      await resetBranch(gitExec, dir, clone.branch, tip);
      clone.baseSha = tip;
      diag.debug("patch.base_moved", { runId: deps.runId, repo: path, target, tip });
      return { kind: "moved", path, target, tip };
    }
    const conflicts = await mergeCommit(gitExec, dir, tip, `Merge branch '${target}'`);
    diag.debug("patch.target_merged", {
      runId: deps.runId,
      repo: path,
      target,
      tip,
      conflicts: conflicts.length,
    });
    if (conflicts.length > 0) {
      return { kind: "conflict", path, target, files: conflicts };
    }
    return {
      kind: "merged",
      path,
      target,
      tip,
      headSha: await branchSha(gitExec, dir, clone.branch),
    };
  };

  // The last candidate each line uploaded, as its branch, base and head. The intake files a
  // bundle under its line and head (`<run>/<line>[-<n>]/<repo>/<head>.bundle`), so the same three again would upload
  // the same thing: a run_checks on an unchanged tip sends nothing. Any submit or merge of the
  // line forgets it, since through a plain origin a submit moves the branch the candidate named.
  const uploaded = new Map<string, string>();
  const pushCandidate = async (
    clone: LineState,
  ): Promise<CheckCandidate | { refused: string }> => {
    const { repo, checkout } = clone;
    const dir = checkout.dir;
    const path = repo.path;
    const stopped = await rebaseInProgress(dir)
      ? "rebase"
      : await mergeInProgress(dir)
      ? "merge"
      : null;
    if (stopped !== null) {
      // The agent's own rebase is its to finish; a merge `update` left is concluded by a submit.
      return {
        refused: stopped === "rebase"
          ? `${
            inCode(path)
          } has a rebase in progress: finish it (\`git rebase --continue\`) or abort ` +
            "it, before running checks"
          : `${
            inCode(path)
          } has a merge in progress: finish it (resolve, stage, and submit_patch or ` +
            "`git commit --no-edit`) or abort it, before running checks",
      };
    }
    const branchRef = `refs/heads/${clone.branch}`;
    // A patch of the branch merged: a candidate of the branch on what merged is filed under the
    // next generation's name, from where it meets the tip, as its submit will ship it — the line
    // itself moves only once that submit ships. The same question a submit asks (`landedAt`).
    const at = await landedAt(clone, { finalizing: false, dirty: false, then: "run the checks" });
    if ("refused" in at) return at;
    if ("nothing" in at) {
      return {
        refused:
          `${inCode(path)}: ${inCode(clone.branch)} has nothing committed past what merged; ` +
          "commit your work first",
      };
    }
    const commits = await commitsSince(gitExec, dir, at.base, branchRef);
    if (commits.length === 0) {
      // Live, an agent sent its `git commit` and this call in the same turn, and this one ran
      // first: say so, or a refusal that is right a moment early reads as a wrong base.
      return {
        refused:
          `${inCode(path)} has nothing committed since its base on ${
            inCode(clone.branch)
          }; commit ` +
          "your work first. If a commit was sent in the same turn as this call, it had not " +
          "finished yet: call this again on its own once it has.",
      };
    }
    const headSha = await branchSha(gitExec, dir, clone.branch);
    const dirty = await hasChanges(gitExec, dir);
    // What the platform finds the candidate by is the branch it ships as, the line's own name.
    const { base, shipAs } = at;
    const key = [shipAs, base, headSha].join("\0");
    const again = uploaded.get(lineKey(clone)) === key;
    if (!again) {
      await shipRef(
        clone,
        shipAs,
        headSha,
        () => deps.git.push(checkout, repo, { name: shipAs, baseSha: base }),
      );
      uploaded.set(lineKey(clone), key);
    }
    diag.debug("checks.candidate_pushed", {
      runId: deps.runId,
      repo: path,
      headSha,
      branch: shipAs,
      dirty,
      again,
    });
    return { headSha, branch: shipAs, baseSha: base, dirty };
  };

  /**
   * Makes `line` the clone's for a submit's turn, or says why it cannot be: a line the clone
   * holds already is it; a new one (`resolveLine`) is refused when another branch ships as the
   * same line or the clone holds `MAX_LINES_PER_REPO` already, and is otherwise added. Answers
   * the line to ship and whether it was added here, which `unenlist` undoes when nothing shipped.
   * Under the lock, so two submits of one new branch enlist one line.
   */
  const enlist = (line: LineState): { line: LineState; added: boolean } | { refused: string } => {
    const { lines, repo } = line.owner;
    const held = lines.get(line.line);
    if (held !== undefined && held !== line && held.branch !== line.branch) {
      return { refused: collision(repo.path, line.line, line.branch, held.branch) };
    }
    const ships = held ?? line;
    // Only lines that shipped take a slot, as the control plane counts them: the default line
    // is the clone's from the start, and spends one only once it ships.
    if (!everShipped(ships) && shippedBeside(ships) >= MAX_LINES_PER_REPO) {
      const names = [...lines.values()].filter((l) => l !== ships && everShipped(l))
        .map((l) => inCode(l.branch)).join(", ");
      return {
        refused: `${repo.path} already ships ${MAX_LINES_PER_REPO} branches in this run, the ` +
          `most one repository may (${names}); put this change on one of them`,
      };
    }
    if (held !== undefined) return { line: held, added: false };
    lines.set(line.line, line);
    return { line, added: true };
  };

  /** A line enlisted for a submit that shipped nothing leaves the clone again. */
  const unenlist = (line: LineState): void => {
    if (line.heads.length > 0 || line.generation > 1) return;
    if (line.owner.lines.get(line.line) === line) line.owner.lines.delete(line.line);
  };

  return {
    submit(line, opts = {}) {
      return underLock(line.owner, async () => {
        const enlisted = enlist(line);
        if ("refused" in enlisted) return { kind: "refused", reason: enlisted.refused };
        const clone = enlisted.line;
        uploaded.delete(lineKey(clone));
        try {
          return await ship(clone, opts);
        } finally {
          if (enlisted.added) unenlist(clone);
        }
      });
    },
    finalize(clone) {
      return underLock(clone.owner, async () => {
        uploaded.delete(lineKey(clone));
        // Every cue taken before finalize is in the clone's state before it ships.
        await cues;
        // A line whose branch the agent deleted or renamed is its housekeeping, not a failure of
        // the run: what shipped of it stands as it last went out, and nothing more of it is
        // read. Every step past here names the branch, and git cannot resolve a branch that is
        // not there. A rename submitted under the new name was refused (`resolveLine`), so its
        // work is not silently another line's.
        if (!await localBranchExists(gitExec, clone.checkout.dir, clone.branch)) {
          diag.warn("patch.line_branch_gone", {
            runId: deps.runId,
            repo: clone.repo.path,
            line: clone.line,
            branch: clone.branch,
          });
          return {
            kind: "nothing-to-submit",
            path: clone.repo.path,
            gone: { shipped: everShipped(clone) },
          };
        }
        return await ship(clone, { finalizing: true });
      });
    },
    update(clone) {
      return underLock(clone.owner, () => {
        uploaded.delete(lineKey(clone));
        return update(clone);
      });
    },
    pushCandidate(clone) {
      return underLock(clone.owner, () => pushCandidate(clone));
    },
    shipped: () => order.map((key) => shippedByLine.get(key)!),
    patches: () => patches.map((p) => ({ ...p })),
    onPatchCue(clones, payload) {
      // One at a time, in arrival order: two cues of one generation must not interleave around
      // the git question below. Finalize and the drain wait on the chain (`settled`).
      const next = cues.then(() => takeCue(clones, payload));
      cues = next.catch(() => {});
      return next;
    },
    settled() {
      return cues;
    },
  };
}

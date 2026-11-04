// A patch's diff, as a reviewer reads it before approving: plain `git diff` of what the bundle
// changes against the branch it lands on, out of a repo `stageBundle` already verified.
//
// Invariants:
// - a patch not yet published (`live`) is measured as the submission will publish it: from the
//   merge base of its head and the tip it lands on — a pull request's base branch, or the head of
//   the existing change request it is pushed onto (on Radicle `patches/<id>`), so the diff is
//   what the push adds to it — as the upstream has that tip now. Nothing the run reports picks the base, so nothing it reports can hide a change
//   from the reviewer. With that branch gone there is nothing to publish to, and no diff;
//   with its tip unknown just now (no answer, or only a copy kept through an outage) there is no
//   diff yet, and asking again may give one
// - a patch already settled (`record`) publishes nothing more, and is shown from where it started:
//   the base the run reported when that is in its history, else the commit its bundle requires,
//   else the merge base with the branch's tip — a view of what it was, not a decision
// - git's own output, untouched by local configuration: no colour, no external diff driver, no
//   textconv filter — the staged repo is the forge's, but the diff must not depend on what any
//   config could make git run or print. A binary file is git's one "Binary files … differ" line
// - bounded: at most `maxBytes` of output is ever held (`CappedGit`), and a cut diff is cut at a
//   FILE boundary, so every file it carries is whole and parses; `truncated` says files are missing
// - reads only what the bundle touches: the paths come from the diff itself, never a request

import type { CappedGit, Git } from "./git_exec.ts";

export interface PatchDiff {
  diff: string;
  /** The commit the diff is measured from. */
  baseSha: string;
  headSha: string;
  truncated: boolean;
  /** When `truncated`, the files the diff leaves out, by their new paths: at most MAX_OMITTED. */
  omitted: string[];
  /** More files are left out than `omitted` lists. */
  moreOmitted: boolean;
}

/** Where each file's section of a unified diff begins — the line `git diff` opens it with. */
const FILE_HEADER = "\ndiff --git ";

/**
 * A diff cut short by the cap, trimmed back to the last whole file. One whose very first file is
 * over the cap carries nothing: half a file's hunks would not parse, and the reader is told it
 * was cut either way.
 */
export function cutAtFileBoundary(text: string): string {
  const last = text.lastIndexOf(FILE_HEADER);
  return last === -1 ? "" : text.slice(0, last + 1);
}

/** Where a branch left its base, from what its bundle requires: the one prerequisite, or of
 * several (a branch that merged its base in requires each side's roots), the one on the head's
 * first-parent line, which is the branch's own history. Null when the bundle requires nothing.
 * The walk stops at the prerequisites, so it reads the bundle's own commits, never the
 * repository's whole history: that line leaves the bundle at a boundary commit, which is one. */
export async function forkPoint(
  git: Git,
  dir: string,
  headSha: string,
  prerequisites: readonly string[],
): Promise<string | null> {
  if (prerequisites.length <= 1) return prerequisites[0] ?? null;
  const wanted = new Set(prerequisites);
  const walk = await git(
    dir,
    "rev-list",
    "--first-parent",
    "--boundary",
    headSha,
    "--not",
    ...prerequisites,
  );
  return walk.split("\n").filter((line) => line.startsWith("-")).map((line) => line.slice(1))
    .find((sha) => wanted.has(sha)) ?? null;
}

export async function isAncestor(
  git: Git,
  dir: string,
  commit: string,
  of: string,
): Promise<boolean> {
  return await git(dir, "merge-base", "--is-ancestor", commit, of).then(() => true, () => false);
}

/** A diff with no base it can be measured from: refused, as asking again changes nothing. */
export class UnanchoredDiffError extends Error {}

/** The tip of the branch the patch lands on could not be read as the upstream has it now (no
 * answer, or only an old copy): asking again may answer, so it is never a refusal. */
export class TipUnavailableError extends Error {}

/** What a diff is measured against: see the file's invariants. */
export type DiffMode = "live" | "record";

/** Where the patch's diff runs from: see the file's invariants. */
async function diffBase(args: {
  dir: string;
  headSha: string;
  mode: DiffMode;
  baseSha: string | null;
  prerequisites: readonly string[];
  tip: () => Promise<string | null>;
  git: Git;
}): Promise<string> {
  const { dir, headSha, git } = args;
  if (args.mode === "live") {
    const tip = await args.tip();
    if (tip === null) {
      throw new UnanchoredDiffError("the branch this patch would land on is gone from the repo");
    }
    return await git(dir, "merge-base", headSha, tip);
  }
  for (const candidate of [args.baseSha, await forkPoint(git, dir, headSha, args.prerequisites)]) {
    if (candidate !== null && await isAncestor(git, dir, candidate, headSha)) return candidate;
  }
  const tip = await args.tip();
  if (tip !== null) return await git(dir, "merge-base", headSha, tip);
  throw new UnanchoredDiffError("this patch's base is not in its history");
}

/** Paths as they are, not C-quoted: a name with an accent reaches the reader as itself. */
const DIFF_ARGS = ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff"];
const DIFF_OPTS = ["--no-textconv", "--find-renames"];

/** The list of omitted files is the same diff's name list, which is small; capped all the same. */
const MAX_NAME_LIST_BYTES = 1024 * 1024;
/** The most omitted files named; past it, `moreOmitted`. */
const MAX_OMITTED = 5_000;

/** The patch's diff, measured as the file's invariants say. */
export async function patchDiff(args: {
  dir: string;
  headSha: string;
  mode: DiffMode;
  baseSha: string | null;
  prerequisites: readonly string[];
  /** The tip of the branch the patch lands on, as the upstream has it now; null when the
   * upstream says the branch is gone. Throws `TipUnavailableError` when that cannot be known now.
   * Asked for once, and only where it is needed. */
  tip: () => Promise<string | null>;
  maxBytes: number;
  /** The omitted files' name list's own cap, and how many of them are named. */
  maxNameListBytes?: number;
  maxOmitted?: number;
  git: Git;
  capped: CappedGit;
}): Promise<PatchDiff> {
  const { dir, headSha } = args;
  const baseSha = await diffBase(args);
  const { out, truncated } = await args.capped(
    dir,
    args.maxBytes,
    ...DIFF_ARGS,
    ...DIFF_OPTS,
    baseSha,
    headSha,
    "--",
  );
  const text = new TextDecoder().decode(out);
  if (!truncated) {
    return { diff: text, baseSha, headSha, truncated, omitted: [], moreOmitted: false };
  }
  const diff = cutAtFileBoundary(text);
  // The files the cut left out, so the reader knows what is missing: the name list comes out of
  // the same diff in the same order, so the files past the ones kept are the ones omitted.
  const kept = diff === "" ? 0 : diff.split("\ndiff --git ").length;
  const names = await args.capped(
    dir,
    args.maxNameListBytes ?? MAX_NAME_LIST_BYTES,
    ...DIFF_ARGS,
    "--name-only",
    "-z",
    ...DIFF_OPTS,
    baseSha,
    headSha,
    "--",
  );
  const paths = new TextDecoder().decode(names.out).split("\0");
  // What follows the last NUL is a name cut short (or nothing): a cut list ends mid-name.
  paths.pop();
  const omitted = paths.slice(kept);
  const most = args.maxOmitted ?? MAX_OMITTED;
  return {
    diff,
    baseSha,
    headSha,
    truncated,
    omitted: omitted.slice(0, most),
    moreOmitted: names.truncated || omitted.length > most,
  };
}

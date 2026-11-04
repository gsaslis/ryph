// Which pushed heads a merge contained — git's answer, asked of a cache entry that holds every
// merged head.
//
// A head is contained in a merged head M when either holds:
// - By HISTORY: the head is an ancestor of, or equal to, M. The caller has fetched each merged
//   head into `dir`, and a fetch brings a commit's whole history (the cache is never shallow,
//   never a partial clone), so a head the entry does not hold is in no merged head's history.
// - By EXACT CONTENT: the head's change is M's change, both ways. A person who rebases the
//   change request's branch before merging it ("Update branch" with a rebase, a local rebase and
//   a force-push) leaves no pushed head in M's history although the change merged. Each side is
//   measured from where it forked: the head from X, where it meets M (or its base, when the
//   caller names one past that point), and M from F, where it left the target (`forkOnTarget`).
//   Contained when the head's change replayed onto F is M's tree, AND M's change replayed onto
//   X is the head's tree. One direction alone is blind to a head that REMOVES something M has:
//   a later push that drops a debug line an earlier, merged push added reads as "already in M"
//   forwards, and would be labelled merged with its removal lost. A head in the history of one
//   that merged this way merged with it, as a head in M's own history does.
//
// Where M left the target is git's to say only when the caller names the branch it merged into
// (`target`, its tip as the upstream has it now): M's merge base with it, for an M the target's
// history does not hold (a squash, or a rebase merge, of it); for one it holds, M's merge base
// with the target as it stood just before the commit that took M into its first-parent line (a
// merge commit). An M that IS on that line (a person rebased or squashed the revision onto a
// target that moved, and fast-forwarded the target to it, as a Radicle delegate does) names no
// one point: its own commits and the target's are one line. Then every commit under M on its
// first-parent line, newest first, back to where it meets the head (X, kept when it is on the
// line), is a candidate F, at most `LINE_FORKS_MAX` of them (200: the right one lies as many
// commits under M as the revision has, so only a revision of more than 200 commits reads
// missed), and the head is contained when both directions hold at any one. That is sound
// because each candidate is a commit the target's line went through: both directions holding at
// F say the target went from F to M by exactly the head's change, so the target holds F plus
// exactly the head's work, which is what "merged" means wherever the person put it. A candidate
// too close to M (part of the change under it) or too far (other target commits over it) fails
// a direction.
//
// With no F known (no target named, or none it can say, or a merge base that is not one
// commit), the rule reads "the two trees are the same", which is enough on its own wherever
// either forked. With one known, the same tree is not enough: an M that forked from a target
// commit already holding part of the head's change, merged after the target took that part back
// out, has the head's tree and leaves the target without the part. Missed is the safe direction
// of any doubt: the agent rebases a missed head's commits, and the control plane's label and
// memory's credit wait for a merge that holds them.
//
// Nothing here reads who wrote a commit, when, or what its message says: an amend keeps all
// three and changes the work.
//
// The bases are the runner's word, not git's: the runner reports the base it built each patch
// on, and the agent shares the runner's container. A base the upstream does not have (one git
// cannot even ask for by id included), that names no commit, or that is no STRICT ancestor of
// its head is as good as none. The route drops a malformed entry the same way, before any of
// this (schema.ts `basesOf`). A base set past some of the head's own work changes where X is,
// and so what both directions compare; M's change must still be exactly the rest, so what that
// can reach is the run's own patch read as merged when the merge took only part of what the
// base hid. That is the run's own work in its own run: another run's patches, and what the
// forge merged, are untouched.
//
// A head that is not an ancestor has to be held to be asked about its content, so it is fetched
// by id (`hold`), with every base and the target's tip, all in one call; one the upstream no
// longer has is missed, since nothing can show its changes merged.
//
// Anything git cannot answer is thrown, never guessed: the merge that reads this settles
// patches on it, and "contained" on a failed git would credit commits that never landed. That
// includes a git too old for `merge-tree --merge-base` (2.40 and later have it): its usage
// error is a failure, not a no, so the settle waits rather than reading every head missed.

import { type Git, type GitInput, isExitOne, objectTypes } from "./git_exec.ts";

export interface Containment {
  /** Each asked head the merge contained, by history or by exact content. */
  contained: string[];
  /** Each asked head the merge did not contain. */
  missed: string[];
}

/**
 * Makes heads readable from the entry, all in one call where it can, and answers the ones the
 * upstream definitively holds nothing by (`absent`) and the ones it holds as some other object
 * than a commit (`notCommits`). Throws when it could not be asked.
 */
export type HoldHeads = (heads: readonly string[]) => Promise<Held>;

/** What a hold could not make readable as a commit, and why. */
export interface Held {
  absent: ReadonlySet<string>;
  notCommits: ReadonlySet<string>;
}

/**
 * Asked about ids that name something other than a commit (a tree, a blob, a tag): a question
 * no answer of git's will ever make sense of, so asking again changes nothing.
 */
export class NotACommit extends Error {
  readonly ids: string[];
  constructor(ids: readonly string[]) {
    super(`not a commit: ${ids.join(", ")}`);
    this.name = "NotACommit";
    this.ids = [...ids];
  }
}

/** The git this read runs, both ways it needs it. */
export interface ContainmentGit {
  git: Git;
  gitInput: GitInput;
}

/**
 * Sorts `heads` into contained and missed against `mergedHeads`, each head once, in the order
 * asked. `bases` names the base each head was built on, where the caller knows it; `target` the
 * tip of the branch the merge went into, where the caller could read it. Every merged head must
 * be held in `dir` (and stay held: the caller holds the entry). Throws when git fails in any way
 * other than its "no", and when a merged head turns out not to be held: a "missed" judged
 * against a merged head that is not there is a guess.
 */
export async function containedIn(
  { git, gitInput }: ContainmentGit,
  dir: string,
  mergedHeads: readonly string[],
  heads: readonly string[],
  hold: HoldHeads,
  bases: Readonly<Record<string, string>> = {},
  target?: string,
): Promise<Containment> {
  const asked = [...new Set(heads)];
  const named = [...new Set(asked.flatMap((h) => bases[h] ?? []))];
  const extra = target === undefined ? [] : [target];
  const out: Containment = { contained: [], missed: [] };
  const all = [...new Set([...asked, ...named, ...extra])];
  const types = await objectTypes(gitInput, dir, all);
  const isHeld = (id: string) => types.get(id) === "commit";
  const held = new Set(asked.filter(isHeld));
  const wrong = asked.filter((head) => !held.has(head) && types.get(head) !== "missing");
  if (wrong.length > 0) throw new NotACommit(wrong);
  const fetched = await hold(all.filter((id) => types.get(id) === "missing"));
  const notCommits = asked.filter((head) => fetched.notCommits.has(head));
  if (notCommits.length > 0) throw new NotACommit(notCommits);
  const usable = (id: string) =>
    (isHeld(id) || types.get(id) === "missing") && !fetched.absent.has(id) &&
    !fetched.notCommits.has(id);
  const ask: Asking = {
    git,
    dir,
    target: target !== undefined && usable(target) ? target : undefined,
    trees: new Map(),
    forks: new Map(),
    lines: new Map(),
  };
  const exact = new Set<string>();
  for (const head of asked) {
    // Not held before the fetch, so in no merged head's history; and not held after it, so
    // nothing more can be asked of it.
    if (fetched.absent.has(head)) {
      out.missed.push(head);
      continue;
    }
    if (
      held.has(head) &&
      await anyAsync(mergedHeads, (m) => isAncestorOrEqual(git, dir, head, m))
    ) continue;
    const given = bases[head];
    const base = given !== undefined && given !== head && usable(given) &&
        await isAncestorOrEqual(git, dir, given, head)
      ? given
      : undefined;
    if (await anyAsync(mergedHeads, (m) => sameChange(ask, m, head, base))) {
      exact.add(head);
      continue;
    }
    out.missed.push(head);
  }
  // A head in the history of one whose change merged exactly merged with it, as a head in a
  // merged head's history does: what it holds is what that head built on.
  const missed = out.missed;
  out.missed = [];
  for (const head of missed) {
    const under = !fetched.absent.has(head) &&
      await anyAsync([...exact], (e) => isAncestorOrEqual(git, dir, head, e));
    if (!under) out.missed.push(head);
  }
  out.contained = asked.filter((head) => !out.missed.includes(head));
  if (out.missed.length > 0) {
    const stillHeld = await objectTypes(gitInput, dir, mergedHeads);
    for (const merged of mergedHeads) {
      if (stillHeld.get(merged) !== "commit") {
        throw new Error(`merged head ${merged} is no longer in the cache`);
      }
    }
  }
  return out;
}

async function anyAsync<T>(
  items: readonly T[],
  test: (item: T) => Promise<boolean>,
): Promise<boolean> {
  for (const item of items) if (await test(item)) return true;
  return false;
}

/** `merge-base --is-ancestor` answers no by exiting 1; anything else is a failure to answer. */
async function isAncestorOrEqual(git: Git, dir: string, commit: string, of: string) {
  try {
    await git(dir, "merge-base", "--is-ancestor", "--end-of-options", commit, of);
    return true;
  } catch (err) {
    if (isExitOne(err)) return false;
    throw err;
  }
}

/** Every merge base of two commits; none for histories with nothing in common, which is a
 * no, not a failure. */
async function mergeBases(git: Git, dir: string, a: string, b: string): Promise<string[]> {
  try {
    return (await git(dir, "merge-base", "--all", "--end-of-options", a, b))
      .split("\n").filter((l) => l !== "");
  } catch (err) {
    if (isExitOne(err)) return [];
    throw err;
  }
}

/** The one merge base of two commits, or undefined when there is none or several. */
async function onlyMergeBase(git: Git, dir: string, a: string, b: string) {
  const bases = await mergeBases(git, dir, a, b);
  return bases.length === 1 ? bases[0] : undefined;
}

/** One read's git, the target's tip it may measure merged heads against, and what it already
 * learned: commits' trees, where each merged head left the target, and the fork points a merged
 * head on the target's own line offers, per point it is measured to. */
interface Asking {
  git: Git;
  dir: string;
  target: string | undefined;
  trees: Map<string, string>;
  forks: Map<string, Fork | undefined>;
  lines: Map<string, string[]>;
}

/** Where a merged head left the target: one commit, or, for a head on the target's own
 * first-parent line, any of the commits under it on that line (`lineForks`). */
type Fork = { at: string } | { onLine: true };

/**
 * How many of a merged head's own first-parent commits are tried as the point it left the
 * target, when it is on the target's line. The walk stops where it meets the head anyway; this
 * bounds a head built on a base far behind, whose missed answer would otherwise try every
 * target commit since (each try is up to two `merge-tree`s). The right point lies as many
 * commits under the merged head as the revision has, newest first, so only a revision of more
 * commits than this reads missed: the safe direction.
 */
const LINE_FORKS_MAX = 200;

async function treeOf({ git, dir, trees }: Asking, commit: string): Promise<string> {
  const known = trees.get(commit);
  if (known !== undefined) return known;
  const tree = await git(dir, "rev-parse", "--verify", "--end-of-options", `${commit}^{tree}`);
  trees.set(commit, tree);
  return tree;
}

/**
 * Whether replaying `from`'s change since `base` onto `onto` (`merge-tree --merge-base`) is clean
 * and makes exactly `want`'s tree. `merge-tree --write-tree` exits 1 on a conflict (a no: the
 * two disagree), and prints the merged tree first; anything else is a failure to answer.
 */
async function replaysTo(
  ask: Asking,
  { base, onto, from, want }: { base: string; onto: string; from: string; want: string },
): Promise<boolean> {
  let result: string;
  try {
    result = await ask.git(
      ask.dir,
      "merge-tree",
      "--write-tree",
      "--no-messages",
      `--merge-base=${base}`,
      onto,
      from,
    );
  } catch (err) {
    if (isExitOne(err)) return false;
    throw err;
  }
  return result.split("\n")[0] === await treeOf(ask, want);
}

/**
 * Whether `head`'s change is exactly `merged`'s, both ways (see the file's comment). X, where
 * `head` is measured from, is `base` when it is past where the two meet, else their one meeting
 * point; of several (a criss-cross), the one that is F, else none names a single change to
 * compare, a no. F is where `merged`
 * left the target (`forkOnTarget`): one point, or any of the candidates a head on the target's
 * line offers. With no F known, the trees must be the same, which is the same change from
 * wherever either is measured. With one known, the same tree is not enough on its own: a head
 * that forked from a target commit holding part of `head`'s change, merged after the target took
 * that part back out, has `head`'s tree and leaves the target without the part.
 */
async function sameChange(
  ask: Asking,
  merged: string,
  head: string,
  base: string | undefined,
): Promise<boolean> {
  const fork = await forkOnTarget(ask, merged);
  const sameTree = async () => await treeOf(ask, head) === await treeOf(ask, merged);
  if (fork === undefined) return await sameTree();
  const meets = await mergeBases(ask.git, ask.dir, merged, head);
  if (meets.length === 0) return false;
  let x: string | undefined;
  if (base !== undefined) {
    for (const meet of meets) {
      if (!await isAncestorOrEqual(ask.git, ask.dir, base, meet)) {
        x = base;
        break;
      }
    }
  }
  x ??= meets.length === 1 ? meets[0] : undefined;
  // Of several meeting points, the one the target holds, where `merged` left it: both came off
  // the target there, so `head`'s work past the target is its change from that point.
  if (x === undefined && "at" in fork && meets.includes(fork.at)) x = fork.at;
  if (x === undefined) return false;
  const candidates = "at" in fork ? [fork.at] : await lineForks(ask, merged, x);
  for (const f of candidates) {
    // Measured from X itself, both replays are the trees compared.
    if (f === x) {
      if (await sameTree()) return true;
      continue;
    }
    if (
      await replaysTo(ask, { base: x, onto: f, from: head, want: merged }) &&
      await replaysTo(ask, { base: f, onto: x, from: merged, want: head })
    ) return true;
  }
  return false;
}

/**
 * Where `merged` left the target, or undefined where git cannot say (see the file's comment):
 * for a head the target's history does not hold, their one merge base; for one it holds, the
 * one merge base of it and the first parent of the commit that brought it onto the target's
 * first-parent line, when that commit is a merge of it rather than its own child on the line;
 * and for a head on that line itself, its own commits under it (`lineForks`).
 */
async function forkOnTarget(ask: Asking, merged: string): Promise<Fork | undefined> {
  if (ask.forks.has(merged)) return ask.forks.get(merged);
  const fork = await readFork(ask, merged);
  ask.forks.set(merged, fork);
  return fork;
}

async function readFork(
  { git, dir, target }: Asking,
  merged: string,
): Promise<Fork | undefined> {
  if (target === undefined) return undefined;
  const at = (commit: string | undefined) => commit === undefined ? undefined : { at: commit };
  if (!await isAncestorOrEqual(git, dir, merged, target)) {
    return at(await onlyMergeBase(git, dir, merged, target));
  }
  // The target's tip itself: on the line.
  if (merged === target) return { onLine: true };
  // The target's first-parent line past `merged`, newest first: its oldest commit is where
  // `merged` came onto the line.
  const entered = (await git(
    dir,
    "rev-list",
    "--first-parent",
    "--ancestry-path",
    "--end-of-options",
    `${merged}..${target}`,
  )).split("\n").filter((l) => l !== "").at(-1);
  if (entered === undefined || !await isAncestorOrEqual(git, dir, merged, entered)) {
    return undefined;
  }
  // Never a root: it descends from `merged`.
  const before = await git(dir, "rev-parse", "--verify", "--end-of-options", `${entered}^1`);
  // `merged` on the line itself (a fast-forward): its own commits are the target's.
  if (await isAncestorOrEqual(git, dir, merged, before)) return { onLine: true };
  return at(await onlyMergeBase(git, dir, merged, before));
}

/**
 * The points a merged head on the target's first-parent line may have left it at, measured to
 * X: its own first-parent commits under it, newest first, back to X when X is on that line
 * (included: there the rule is the same tree) or to the first commit X holds otherwise, at most
 * `LINE_FORKS_MAX`. `merged` itself is no candidate (its change from itself is nothing), unless
 * it is X.
 */
async function lineForks(ask: Asking, merged: string, x: string): Promise<string[]> {
  const key = `${merged} ${x}`;
  const known = ask.lines.get(key);
  if (known !== undefined) return known;
  const { git, dir } = ask;
  // X's parents, not X: the walk keeps X itself when it is on the line.
  const parents = (await git(dir, "rev-list", "--parents", "--max-count=1", "--end-of-options", x))
    .split(" ").slice(1).filter((l) => l !== "");
  const walked = (await git(
    dir,
    "rev-list",
    "--first-parent",
    `--max-count=${LINE_FORKS_MAX + 1}`,
    "--end-of-options",
    merged,
    ...parents.map((p) => `^${p}`),
  )).split("\n").filter((l) => l !== "");
  const forks = walked.filter((c) => c !== merged || c === x).slice(0, LINE_FORKS_MAX);
  ask.lines.set(key, forks);
  return forks;
}

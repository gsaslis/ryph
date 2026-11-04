// Whether a branch describes a machine of its OWN, or only carries an older copy of the default
// branch's.
//
// A branch's `.ryph/` tree differing from the default branch head's is not, by itself, a branch
// that changed its machine: the default branch moves on while a run works on an older base, and
// every branch cut before the move then differs without having touched `.ryph/` at all. Such a
// branch merges into the default branch's `.ryph/`, so the default branch's machine is the one it
// will run on — and building it a machine of its own is a build nobody asked for.
//
// So the question is asked against the branch's merge base with the default branch:
//
//   head tree == default tree                → inherited (the same machine)
//   head tree == merge base's tree           → inherited (it fell behind; it changed nothing)
//   anything else                            → its own (it changed `.ryph/` since it forked)
//
// Every tree here is the forge's, which leaves out the files no build reads (checks.yml,
// services.yml, environment.md), so a branch that changed only those is not its own.
//
// Invariants:
// - the merge base is read only when the two trees differ — the common case costs nothing more
// - a merge base the forge could not read is "its own": an extra build is the cheap mistake, a
//   run on a machine its branch does not describe is not
// - a branch with no history in common with the default branch is "its own"

import { forgeRepoRef } from "./forge_repo.ts";
import type { ConnectedRepo } from "./types.ts";
import { EMPTY_TREES, type Forge, type RyphBase } from "../ports/forge.ts";

/** One side of the comparison: the commit that was read and its `.ryph/` tree. */
export interface RyphSide {
  commit: string;
  tree: string | null;
}

/** What the comparison came to, and the sentence that says why. */
export interface RyphBaseline {
  /** True when the branch changed `.ryph/` since it forked from the default branch. */
  own: boolean;
  /** The merge-base read, when one was made and answered. */
  mergeBase: RyphBase | null;
  /** Why, in a sentence naming the refs, commits and trees compared — what a build records. */
  reason: string;
}

/** What a build would use of a `.ryph/` tree: one of only files no build reads (the empty
 * tree) describes the same machine as none at all. */
export const machineTree = (tree: string | null): string | null =>
  tree === null || EMPTY_TREES.has(tree) ? null : tree;

const short = (id: string | null) => id === null ? "none" : id.slice(0, 12);
/** A repo-authored name as one line: a path can hold a newline or a terminal escape, and the
 * reason this builds is quoted to agents. */
// oxlint-disable-next-line no-control-regex
const oneLine = (name: string) => name.replace(/[\u0000-\u001f\u007f]/g, "?");

/**
 * Compares `head` (the branch `ref` at a commit) with the default branch `defaultRef` as read.
 * Never throws: a failed merge-base read answers `own`, saying so.
 */
export async function compareWithBaseline(input: {
  forge: Pick<Forge, "ryphBase">;
  repo: ConnectedRepo;
  ref: string;
  head: RyphSide;
  defaultRef: string;
  onDefault: RyphSide;
  onError?: (err: unknown) => void;
}): Promise<RyphBaseline> {
  const { forge, repo, head, onDefault } = input;
  const [ref, defaultRef] = [oneLine(input.ref), oneLine(input.defaultRef)];
  const compared = `${ref} at ${short(head.commit)} (.ryph/ ${short(head.tree)}) against ` +
    `${defaultRef} at ${short(onDefault.commit)} (.ryph/ ${short(onDefault.tree)})`;
  if (machineTree(head.tree) === machineTree(onDefault.tree)) {
    return { own: false, mergeBase: null, reason: `same .ryph/: ${compared}` };
  }
  let base: RyphBase;
  try {
    base = await forge.ryphBase(forgeRepoRef(repo), repo.url, head.commit, input.defaultRef);
  } catch (err) {
    input.onError?.(err);
    return {
      own: true,
      mergeBase: null,
      reason: `${ref} has its own .ryph/ (the merge base could not be read, so it is taken to ` +
        `have changed it): ${compared}`,
    };
  }
  if (base.mergeBase === null) {
    return {
      own: true,
      mergeBase: base,
      reason: `${ref} has its own .ryph/ (it shares no history with ${defaultRef}): ${compared}`,
    };
  }
  const at = `merge base ${short(base.mergeBase)} (.ryph/ ${short(base.tree)})`;
  if (machineTree(base.tree) === machineTree(head.tree)) {
    return {
      own: false,
      mergeBase: base,
      reason: `${ref} did not change .ryph/ since its ${at}; only ${defaultRef} moved: ${compared}`,
    };
  }
  const paths = base.changed.length === 0 ? "" : ` (${base.changed.map(oneLine).join(", ")})`;
  return {
    own: true,
    mergeBase: base,
    reason: `${ref} changed .ryph/${paths} since its ${at}: ${compared}`,
  };
}

// What a patch's diff is measured from, as its page names it.

import type { Basis } from "$lib/api/patches";
import { branchName } from "./format";

/**
 * The branch a diff's base commit can be named as being on, or null. A live diff runs from where
 * the head meets the tip of the branch it lands on, so its base is on that branch; one counted
 * from an earlier patch is named by that patch instead, and a settled one may run from the run's
 * own base, on no branch the page could name.
 */
export function diffBaseBranch(basis: Basis): string | null {
  return basis.mode === "live" && basis.sincePatchId === null ? branchName(basis.targetRef) : null;
}

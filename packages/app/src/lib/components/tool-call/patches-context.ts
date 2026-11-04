import { getContext, setContext } from "svelte";
import type { Patch } from "$lib/api/types";
import { ID_BODY } from "$lib/utils/ids";

// The patches a page already holds, kept live as they move: a submit_patch call in the transcript
// shows the patch it opened from here, its state as it is now rather than as the reply said. A
// page that holds none sets nothing, and those calls show what the call itself carried.

const KEY = Symbol("patches");
// What re-reads them, for a patch approved or rejected from the transcript.
const REFRESH_KEY = Symbol("patches-refresh");

export function setPatchesContext(held: () => Patch[], refresh: PatchesRefresh): void {
  setContext(KEY, held);
  setContext(REFRESH_KEY, refresh);
}

export function getPatchesContext(): (() => Patch[]) | undefined {
  return getContext<(() => Patch[]) | undefined>(KEY);
}

/**
 * How a page re-reads its patches once one has moved: the dependency its load declares, or a
 * function of its own for a page that schedules its loads itself.
 */
export type PatchesRefresh = string | (() => Promise<unknown>);

/** How to re-read the patches the page holds once one has moved; undefined where it holds none. */
export function getPatchesRefresh(): PatchesRefresh | undefined {
  return getContext<PatchesRefresh | undefined>(REFRESH_KEY);
}

/** What a submit_patch reply says it submitted. */
export interface SubmittedPatch {
  patchId: string;
  headSha: string;
  generation: number;
}

const SUBMITTED = new RegExp(
  `^Submitted patch (p-${ID_BODY}) for .+? at ([0-9a-f]{7,40}) \\(generation (\\d+)\\)`,
);

/** The patch a submit_patch reply names, or null for a reply that submitted nothing. */
export function submittedInReply(reply: string): SubmittedPatch | null {
  const found = SUBMITTED.exec(reply);
  if (found === null) return null;
  return { patchId: found[1], headSha: found[2], generation: Number(found[3]) };
}

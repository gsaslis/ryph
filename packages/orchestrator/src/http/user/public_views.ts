import type { ForgeProvider, Patch, Run, RunEnvironment } from "../../core/types.ts";
import type { CheckSuiteState } from "../../core/check_types.ts";
import { egressRefusalNote } from "../../core/egress.ts";
import { hookCheckErrorOf } from "../../core/patch_lifecycle.ts";
import { idleStateOf } from "../../core/run_activity.ts";

/** How much of a run's inbox a detail view embeds — the newest this many, oldest first. */
export const EMBEDDED_MESSAGES = 200;

/** A `Run` as the outside may see it: everything except the credentials — and its
 * environment narrowed to what a person reads off it (which image, which commits, how old). */
export function toPublicRun(run: Run): PublicRun {
  const { tokenHash: _hash, controlToken: _control, environment, ...rest } = run;
  return {
    ...rest,
    idleState: idleStateOf(run),
    environment: environment === null ? null : {
      id: environment.id,
      image: environment.image,
      ref: environment.ref,
      commits: environment.commits,
      builtAt: environment.builtAt,
    },
    egressNote: egressRefusalNote(run.egressRefusals ?? [], "run"),
    browser: run.workItem.browser !== undefined,
  };
}

export type PublicRun = Omit<Run, "tokenHash" | "controlToken" | "environment"> & {
  environment: Pick<RunEnvironment, "id" | "image" | "ref" | "commits" | "builtAt"> | null;
  /**
   * The refused hosts as a sentence, with the bundle an ADMIN could allow each with — null when
   * nothing was refused.
   *
   * Worded here rather than in the app, for the environment card's reason: the bundle catalogue
   * is `EGRESS_BUNDLES` and it lives in the control plane, so a deployment that grows a bundle
   * re-explains yesterday's refusals without a web build. The raw `egressRefusals` ride along
   * beside it for anything that wants the hosts themselves.
   */
  egressNote: string | null;
  /**
   * Whether the run was granted a browser — its work item's frozen grant (`workItem.browser`),
   * decided once at start. What the run page's "View browser" keys on: the history that would
   * otherwise say so is paged away on a long run. True says the platform launched one, not that
   * it came up; the run's history says that.
   */
  browser: boolean;
};

/** What approving a patch whose hook check found more git hook files than it names answers,
 * beside `code: "too_many_hook_files"` on a 409. */
export const TOO_MANY_HOOK_FILES_ERROR =
  "This change edits more git hook files than Ryph can show. Reject it, or review it outside Ryph.";

/** What a decision on a patch answers, beside `code: "patch_changed"` on a 409, when the patch
 * changed between being read and being written. */
export const PATCH_CHANGED_ERROR = "This patch changed while you were looking. Look at it again.";

/** A Patch as the outside may see it — what the app builds against. No secret columns today;
 * the chokepoint exists so a future one cannot leak by omission. Beside the row:
 * - `hookCheck`: the git hook files a `local` patch changes, as the forge read them —
 *   `{touched, hooksPaths, more}`, or null while unchecked (and always on other forges)
 * - `hooksPending`: a `local` patch still waiting to be delivered that has not been checked yet,
 *   and whose check has not failed either, so an answer is still on its way — an approval now
 *   covers no hook file.
 * - `hookCheckError`: why a waiting `local` patch's check failed (core/patch_lifecycle.ts
 *   `hookCheckErrorOf`), null otherwise. Such a patch is not pending: a queued one fails rather
 *   than wait forever, and a `pending_approval` one may be approved, which asks again at once and
 *   fails it on a terminal answer — never delivered unchecked.
 * `provider` is the patch's repo's forge, null when the repo no longer resolves. */
export type PublicPatch = Omit<Patch, "hookCheck"> & {
  hookCheck: { touched: string[]; hooksPaths: string[]; more: boolean } | null;
  hooksPending: boolean;
  hookCheckError: string | null;
};

export function toPublicPatch(patch: Patch, provider: ForgeProvider | null): PublicPatch {
  const { hookCheck, ...rest } = patch;
  const hookCheckError = provider === "local" ? hookCheckErrorOf(patch) : null;
  return {
    ...rest,
    hookCheck: hookCheck === null
      ? null
      : { touched: hookCheck.touched, hooksPaths: hookCheck.hooksPaths, more: hookCheck.more },
    hooksPending: provider === "local" && hookCheck === null && hookCheckError === null &&
      (patch.state === "pending_approval" || patch.state === "queued"),
    hookCheckError,
  };
}

/** A patch's checks as the approval queue shows them: the latest suite on its head, counted. */
export interface PatchChecksSummary {
  suiteId: string;
  state: CheckSuiteState;
  passed: number;
  failed: number;
  total: number;
}

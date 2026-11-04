import { ApiError } from "$lib/api/call";
import type { Patch, SystemPayload } from "$lib/api/types";

// A patch to a repo on this machine lands as a branch its owner checks out, and git hook files in
// it run on their computer then. The control plane holds such a patch for a person, whatever the
// repo's approval setting, until they approve it having seen the files: these are the words and
// the tests every surface that shows one shares.

/** The hook warning's heading. */
export const HOOK_WARNING_TITLE = "This change edits git hooks";

/** When hook files run, said the same way by the warning and the approve confirmation. */
const HOOKS_RUN =
  "These files run on your computer the next time you check out, commit or switch branches.";

/** What the hook warning asks of the reader. */
export const HOOK_WARNING_BODY = `${HOOKS_RUN} Read them before you approve.`;

/** How far the check goes. */
export const HOOK_WARNING_SCOPE =
  "Ryph only checks hook files and hook settings, not other code your hooks run.";

/** Said when the check found more hook files than it names: such a patch cannot be approved. */
export const HOOK_TOO_MANY =
  "This change edits more git hook files than Ryph can show, so it can't be approved here. Reject it or review it outside Ryph.";

/** A held patch's row, shut: the transcript's call row and the patches list. */
export const HOOK_HELD_LABEL = "Needs your approval";

/** The patches list's badge for a held patch. */
export const HOOK_BADGE_LABEL = "Edits git hooks";

/** While a repo-on-this-machine patch's files are still being checked. */
export const HOOK_CHECKING_LABEL = "Checking for git hooks…";

/** Said when a repo-on-this-machine patch's files could not be checked. Approving it checks them
 * again, and the patch fails if that check does too. */
export const HOOK_CHECK_FAILED_LABEL = "Couldn't check for git hooks";

/** The full line, with the reason the check gave. */
export function hookCheckFailedLine(reason: string): string {
  const said = reason.trim();
  if (said === "") return "Ryph couldn't check this change for git hooks.";
  return `Ryph couldn't check this change for git hooks: ${said}${/[.!?]$/.test(said) ? "" : "."}`;
}

/** The line to show for a patch whose files could not be checked, while it waits; null otherwise. */
export function hookCheckNotice(patch: HookFields & PendingFields): string | null {
  const reason = hookCheckError(patch);
  return reason === null ? null : hookCheckFailedLine(reason);
}

/** What the page says when a decision was refused because the patch changed meanwhile. */
export const PATCH_CHANGED_MESSAGE = "This patch changed while you were looking. Look at it again.";

/** The approve confirmation for a held patch. */
export const HOOK_CONFIRM_TITLE = "Approve changes to git hooks?";
export const HOOK_CONFIRM_BODY = `${HOOKS_RUN} Approve only if you trust them.`;

/** The task page's banner while a patch of the task is held. */
export const HOOK_BANNER_TITLE = "A change needs your approval";

type HookFields = Pick<Patch, "state" | "hookCheck">;

/** Held for a person because it edits git hook files: waiting on approval, with hook files found. */
export function isHeld(patch: HookFields): boolean {
  return patch.state === "pending_approval" && (patch.hookCheck?.touched.length ?? 0) > 0;
}

type PendingFields = Pick<Patch, "hooksPending" | "hookCheckError">;

/** Its files are still being checked, and nothing has held it yet. A check that failed is not
 * still running. */
export function isCheckingHooks(patch: HookFields & PendingFields): boolean {
  return patch.hooksPending && patch.hookCheckError === null && !isHeld(patch);
}

/** Why its files could not be checked, while it waits; null otherwise. */
export function hookCheckError(patch: HookFields & PendingFields): string | null {
  if (isHeld(patch)) return null;
  if (patch.state !== "pending_approval" && patch.state !== "queued") return null;
  return patch.hookCheckError;
}

/** It edits more hook files than the check names, which no approval from here can cover. */
export function hasHiddenHooks(patch: HookFields): boolean {
  return isHeld(patch) && patch.hookCheck?.more === true;
}

/** The hook files to name, and whether there are more than that. */
export function heldFiles(patch: HookFields): { files: string[]; more: boolean } {
  if (!isHeld(patch)) return { files: [], more: false };
  return { files: patch.hookCheck?.touched ?? [], more: patch.hookCheck?.more ?? false };
}

/**
 * Whether Approve can be pressed for a patch, and if not, why. Readiness on the page's side (a
 * diff still loading) is the caller's; this is what the hook check says.
 */
export function approveBlock(
  patch: HookFields & PendingFields,
): { reason: "checking" | "hidden"; label: string } | null {
  if (isCheckingHooks(patch)) return { reason: "checking", label: HOOK_CHECKING_LABEL };
  if (hasHiddenHooks(patch)) return { reason: "hidden", label: HOOK_TOO_MANY };
  return null;
}

/** A patch to a repo on this machine. Its provider is null when its repo is gone, and a hook
 * check, or one under way, says so all the same. */
export function isLocalPatch(
  patch: HookFields & Pick<Patch, "hooksPending" | "provider">,
): boolean {
  return patch.provider === "local" || patch.hookCheck !== null || patch.hooksPending;
}

/**
 * The hook files an approval names. A held patch's are exactly the ones the dialog showed when it
 * opened (`shown`), never re-read: a file that turned up since is not approved unseen. Any other
 * patch to a repo on this machine names none, and other repos send nothing.
 */
export function approvalHookPaths(
  patch: HookFields & Pick<Patch, "hooksPending" | "provider">,
  shown: readonly string[] | null,
): string[] | undefined {
  if (shown !== null) return [...shown];
  return isLocalPatch(patch) ? [] : undefined;
}

/** The files a held patch's approve dialog shows, copied when it opens. Null for any other. */
export function snapshotHookFiles(patch: HookFields): string[] | null {
  return isHeld(patch) ? [...heldFiles(patch).files] : null;
}

/** Why the server refused an approval or a retry, when it said in a way the page acts on. Each
 * means the page's picture of the patch is out of date, so the page reads it again. */
export type ApprovalRefusal =
  | "diff_basis_moved"
  | "too_many_hook_files"
  | "patch_changed"
  | "held"
  | "superseded"
  | "held_run_live"
  | "held_needs_diff";

const REFUSALS: readonly ApprovalRefusal[] = [
  "diff_basis_moved",
  "too_many_hook_files",
  "patch_changed",
  "held",
  "superseded",
  "held_run_live",
  "held_needs_diff",
];

export function approvalRefusal(e: unknown): ApprovalRefusal | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const code = (e.body as { code?: unknown } | null)?.code;
  return REFUSALS.find((refusal) => refusal === code) ?? null;
}

/** What to tell the reader about a refused approval. */
export function approvalRefusalMessage(refusal: ApprovalRefusal): string {
  switch (refusal) {
    case "diff_basis_moved":
      return "This patch would now publish something else. Look at its diff again.";
    case "too_many_hook_files":
      return HOOK_TOO_MANY;
    case "patch_changed":
      return PATCH_CHANGED_MESSAGE;
    case "held":
      return "This patch is now on hold. Open it to see why.";
    case "superseded":
      return "A newer patch replaced this one.";
    case "held_run_live":
      return "This patch is on hold while its run is still going. The run will usually send a newer one.";
    case "held_needs_diff":
      return "This patch is on hold. Review its diff before you decide.";
  }
}

/** A refusal that asks for the patch's own page, where its diff is. */
export function refusalNeedsReview(refusal: ApprovalRefusal): boolean {
  return refusal === "held_needs_diff";
}

/** A platform message saying a patch was held for its hook files. */
export function isHeldNotice(
  payload: SystemPayload | null,
): payload is Extract<SystemPayload, { kind: "patch" }> {
  return payload !== null && payload.kind === "patch" && payload.state === "held";
}

/** The badge on a held notice whose patch has moved on. */
export const HOOK_NOTICE_PAST_LABEL = "edits git hooks";

/** What a held notice says once its patch is no longer held, for whoever reads the run later. */
export function heldNoticeLine(patch: Pick<Patch, "state" | "approvedAt"> | null): string {
  if (patch === null) return "This change edited git hooks and waited for approval.";
  if (patch.state === "rejected") return "This change edited git hooks. It was rejected.";
  if (patch.state === "superseded") {
    return "This change edited git hooks. A newer version replaced it.";
  }
  if (patch.approvedAt !== null) return "This change edited git hooks. It was approved.";
  return "This change edited git hooks and waited for approval.";
}

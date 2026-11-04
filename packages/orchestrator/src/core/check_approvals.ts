// Outside contributions' checks: a push to a change request
// whose author may not make this deployment run code — a fork's pull request, a non-delegate's
// Radicle patch — runs nothing by itself. Instead the change request gets ONE comment linking an
// approval page in the app; someone who may command agents on the repo approves there, the head
// is asked for checks exactly as a trusted push's is, and the comment is edited to say who
// approved. The approval page then sends them back to the change request.
//
// Invariants:
// - an approval is of ONE head: a new push of the author's needs approving again, since what was
//   reviewed is what runs. A head approved once stays approved, so a redelivery, a reopen or a
//   retarget of it asks for its checks as a trusted push would
// - the change request's head is read live at approval, as the forge door reads it on a push: a
//   closed change request, or one that moved on to another head, approves nothing
// - who may approve is the HTTP layer's question (http/checks_api.ts), asked live; nothing here
//   takes an approver's word for their access
// - one comment per change request: a new head edits the comment the last head's approval posted,
//   rather than adding one per push; and a new comment is posted only by the delivery holding
//   the head's comment claim (`claimApprovalComment`), so two deliveries of one head racing — a
//   redelivery overlapping a slow first try — post one comment between them, not two
// - without an app address there is no page to link, and nothing is filed: the push is refused
//   exactly as before (`off`)

import { mintId } from "@ryph/sealed";
import type { ChangeRequestPush, ChecksService } from "./checks.ts";
import type { CheckApproval } from "./check_types.ts";
import type { ConnectedRepo, ForgeProvider } from "./types.ts";
import { forgeRepoRef } from "./forge_repo.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import type { Forge } from "../ports/forge.ts";

export interface CheckApprovalDeps {
  checks: Pick<ChecksService, "approvals" | "changeRequestPushed">;
  forge: Pick<Forge, "postComment" | "updateComment" | "fetchChangeRequestHead">;
  /** RYPH_APP_URL: where the approval page lives. Null: no page, so no approvals. */
  appUrl: string | null;
  diag: Diagnostics;
  now(): Date;
}

/** The approval page's address. */
export function approvalUrlOf(appUrl: string, id: string): string {
  return `${appUrl.replace(/\/+$/, "")}/checks/approvals/${encodeURIComponent(id)}`;
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * How long a delivery's claim on posting a head's comment holds before another may take it over:
 * the right a handler that died between claiming and saving the comment's id leaves behind. Well
 * past the event sink's 60 s for a whole delivery, well inside the mailroom's retry span.
 */
export const COMMENT_CLAIM_STALE_MS = 2 * 60_000;

/** Who may approve, as the comment says it to the forge's own people. */
function approverPhrase(provider: ForgeProvider): string {
  return provider === "radicle"
    ? "A delegate of this repository"
    : "Anyone with write access to this repository";
}

/** A person as the forge spells a mention of them: a GitHub login or GitLab username pings
 * (meant to), a DID is quoted. */
function named(provider: ForgeProvider, login: string | null): string {
  if (login === null) return "a ryph administrator";
  return provider === "github" || provider === "gitlab" ? `@${login}` : `\`${login}\``;
}

/** The comment while a head waits for someone to approve it. */
export function pendingCommentBody(
  provider: ForgeProvider,
  approval: CheckApproval,
  link: string,
  previous: CheckApproval | null,
): string {
  const lines = [
    "### ⏸️ Checks are waiting for approval",
    "",
    "This change request comes from a contributor who can't start checks on this repository, " +
    `so ryph hasn't run its checks on \`${short(approval.headSha)}\`.`,
    "",
    `${approverPhrase(provider)} can **[approve checks for this commit](${link})**. ` +
    "They run once; a new push needs approving again.",
  ];
  if (previous !== null && previous.state === "approved") {
    lines.push(
      "",
      `<sub>Checks on \`${short(previous.headSha)}\` were approved by ` +
        `${named(provider, previous.approvedByLogin)}.</sub>`,
    );
  }
  return lines.join("\n");
}

/** The comment once a head is approved. */
export function approvedCommentBody(provider: ForgeProvider, approval: CheckApproval): string {
  return [
    "### ✅ Checks approved",
    "",
    `${named(provider, approval.approvedByLogin)} approved checks on ` +
    `\`${short(approval.headSha)}\`. ryph is running them now, and reports their results on ` +
    "this change request.",
    "",
    "A new push needs approving again.",
  ].join("\n");
}

/**
 * What the forge door does with a push the command gate refused:
 * - `approved`: this very head was approved before — ask its checks as a trusted push's
 * - `awaiting`: the comment linking its approval page is on the change request
 * - `unavailable`: the comment could not be posted; a retry of the delivery posts it
 * - `posting`: another delivery of this head is posting its comment right now; a retry finds it
 * - `off`: no app to link to; refuse the push as before
 */
export async function requestApproval(
  deps: CheckApprovalDeps,
  repo: ConnectedRepo,
  push: ChangeRequestPush & { author: string },
): Promise<"approved" | "awaiting" | "unavailable" | "posting" | "off"> {
  if (deps.appUrl === null) return "off";
  const { approvals } = deps.checks;
  const nowIso = deps.now().toISOString();
  const claimed = await approvals.claimApproval({
    id: mintId("ca"),
    connectedRepoId: repo.id,
    changeRequest: push.ref,
    headSha: push.headSha,
    fetchRef: push.fetchRef,
    url: push.url,
    author: push.author,
    state: "pending",
    commentId: null,
    commentClaimedAt: null,
    approvedByUserId: null,
    approvedByLogin: null,
    approvedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  let approval = claimed.approval;
  if (approval.state === "approved") return "approved";
  // Pushed back to a head that waited before (A → B → A): it waits again, and the comment, which
  // shows B by now, is pointed back at it.
  let fresh = claimed.created;
  if (approval.state !== "pending") {
    const reopened: CheckApproval = {
      ...approval,
      state: "pending",
      commentClaimedAt: null,
      updatedAt: nowIso,
    };
    if (!await approvals.saveApprovalIf(reopened, ["superseded", "closed"])) {
      const now = await approvals.getApproval(approval.id);
      return now?.state === "approved" ? "approved" : "awaiting";
    }
    approval = reopened;
    fresh = true;
  }
  // A redelivery of a head whose comment is up: nothing to do.
  if (!fresh && approval.commentId !== null) return "awaiting";

  // Any other head of the change request still waiting will never be the one that runs.
  const all = await approvals.listApprovals(repo.id, push.ref);
  for (const other of all) {
    if (other.id === approval.id || other.state !== "pending") continue;
    await approvals.saveApprovalIf(
      { ...other, state: "superseded", updatedAt: nowIso },
      ["pending"],
    );
  }
  const previous = all.find((a) => a.id !== approval.id && a.state === "approved") ?? null;
  const body = pendingCommentBody(
    repo.provider,
    approval,
    approvalUrlOf(deps.appUrl, approval.id),
    previous,
  );
  const ref = forgeRepoRef(repo);
  // The change request's one comment, as the newest head that had one left it.
  const existing = approval.commentId ??
    all.find((a) => a.id !== approval.id && a.commentId !== null)?.commentId ?? null;
  let commentId: string | null = null;
  if (existing !== null) {
    try {
      await deps.forge.updateComment(ref, existing, body);
      commentId = existing;
    } catch (err) {
      // Deleted, most likely: a new one is posted below.
      deps.diag.warn("check_approvals.comment_update_failed", {
        approvalId: approval.id,
        err: String(err),
      });
    }
  }
  if (commentId === null) {
    // Only one delivery of this head posts: whoever claims it. Another one posting right now is
    // a retry for this one, which then finds the comment's id saved — or, if that delivery died
    // half way, finds its claim stale and posts in its place.
    const claimedAt = deps.now().toISOString();
    const staleBefore = new Date(deps.now().getTime() - COMMENT_CLAIM_STALE_MS).toISOString();
    const claimed = await approvals.claimApprovalComment(approval.id, {
      at: claimedAt,
      staleBefore,
      seen: approval.commentId,
    });
    if (!claimed) {
      const now = await approvals.getApproval(approval.id);
      if (now?.state === "approved") return "approved";
      if (now === null || now.state !== "pending" || now.commentId !== approval.commentId) {
        return "awaiting";
      }
      return "posting";
    }
    try {
      commentId = (await deps.forge.postComment(
        ref,
        { kind: "change_request", ref: push.ref },
        body,
      )).commentId;
    } catch (err) {
      deps.diag.warn("check_approvals.comment_failed", {
        approvalId: approval.id,
        err: String(err),
      });
      await approvals.releaseApprovalComment(approval.id, claimedAt);
      return "unavailable";
    }
  }
  if (commentId !== approval.commentId) {
    await approvals.saveApprovalIf(
      { ...approval, commentId, commentClaimedAt: null, updatedAt: deps.now().toISOString() },
      ["pending"],
    );
  }
  deps.diag.debug("check_approvals.requested", {
    approvalId: approval.id,
    changeRequest: push.ref,
    headSha: push.headSha,
  });
  return "awaiting";
}

export type ApproveOutcome =
  | { kind: "approved"; approval: CheckApproval }
  | { kind: "refused"; status: 409 | 503; why: string };

/**
 * Someone the HTTP layer found may command agents on the repo approves one head: read live, asked
 * for checks as a trusted push is, and the comment edited to name them. Approving a head already
 * approved answers it as it stands.
 */
export async function approveChecks(
  deps: CheckApprovalDeps,
  repo: ConnectedRepo,
  approval: CheckApproval,
  by: { userId: string; login: string | null },
): Promise<ApproveOutcome> {
  const { approvals } = deps.checks;
  if (approval.state === "approved") return { kind: "approved", approval };
  if (approval.state === "superseded") {
    return {
      kind: "refused",
      status: 409,
      why: "the change request has a newer commit since; approve that one from its comment",
    };
  }
  if (approval.state === "closed") {
    return { kind: "refused", status: 409, why: "the change request was merged or closed" };
  }
  const ref = forgeRepoRef(repo);
  const setAside = async (state: "superseded" | "closed") => {
    await approvals.saveApprovalIf(
      { ...approval, state, updatedAt: deps.now().toISOString() },
      ["pending"],
    );
  };
  const read = await deps.forge.fetchChangeRequestHead(ref, approval.changeRequest);
  if (read.kind === "unavailable") {
    return { kind: "refused", status: 503, why: "could not read the change request — try again" };
  }
  if (read.kind === "gone" || read.head.state !== "open") {
    await setAside("closed");
    return { kind: "refused", status: 409, why: "the change request was merged or closed" };
  }
  if (read.head.authorHeadSha !== approval.headSha) {
    await setAside("superseded");
    return {
      kind: "refused",
      status: 409,
      why: "the change request has a newer commit since; approve that one from its comment",
    };
  }
  const outcome = await deps.checks.changeRequestPushed({
    connectedRepoId: repo.id,
    ref: approval.changeRequest,
    headSha: approval.headSha,
    baseRef: read.head.baseRef,
    fetchRef: approval.fetchRef,
    url: approval.url,
  }, async () => {
    const again = await deps.forge.fetchChangeRequestHead(ref, approval.changeRequest);
    if (again.kind === "unavailable") return "unknown";
    return again.kind === "head" && again.head.state === "open" &&
        again.head.authorHeadSha === approval.headSha
      ? { live: again.head.baseRef }
      : "stale";
  });
  if (outcome === "off") {
    return { kind: "refused", status: 409, why: "checks on change requests are off here" };
  }
  if (outcome === "unknown") {
    return { kind: "refused", status: 503, why: "could not read the change request — try again" };
  }
  if (outcome === "stale") {
    return {
      kind: "refused",
      status: 409,
      why: "the change request moved on while its checks were being asked; try again",
    };
  }
  const nowIso = deps.now().toISOString();
  const approved: CheckApproval = {
    ...approval,
    state: "approved",
    approvedByUserId: by.userId,
    approvedByLogin: by.login,
    approvedAt: nowIso,
    updatedAt: nowIso,
  };
  if (!await approvals.saveApprovalIf(approved, ["pending"])) {
    // Someone else approved it a moment before — their name stands — or a newer push set it
    // aside, after this call had already asked for the checks it approved.
    const standing = await approvals.getApproval(approval.id);
    if (standing?.state === "approved") return { kind: "approved", approval: standing };
    return {
      kind: "refused",
      status: 409,
      why: "the change request has a newer commit since; approve that one from its comment",
    };
  }
  if (approved.commentId !== null) {
    try {
      await deps.forge.updateComment(
        ref,
        approved.commentId,
        approvedCommentBody(repo.provider, approved),
      );
    } catch (err) {
      deps.diag.warn("check_approvals.comment_update_failed", {
        approvalId: approved.id,
        err: String(err),
      });
    }
  }
  deps.diag.debug("check_approvals.approved", {
    approvalId: approved.id,
    changeRequest: approved.changeRequest,
    by: by.userId,
  });
  return { kind: "approved", approval: approved };
}

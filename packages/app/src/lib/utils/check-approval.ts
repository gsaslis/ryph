import type { CheckApproval } from "$lib/api/types";

/**
 * Where approving sends the approver back to: the change request on its forge, which is where
 * they followed the link from. Only a web address — whatever else came back stays on the page.
 */
export function approvalReturnTo(returnTo: string | null): string | null {
  if (returnTo === null) return null;
  try {
    const url = new URL(returnTo);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** One line on where an approval stands, for the page's description. */
export function approvalStateLabel(approval: Pick<CheckApproval, "state">): string {
  switch (approval.state) {
    case "pending":
      return "Waiting for approval";
    case "approved":
      return "Approved";
    case "superseded":
      return "Replaced by a newer commit";
    case "closed":
      return "Change request closed";
  }
}

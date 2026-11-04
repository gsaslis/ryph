import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { ApiError } from "$lib/api/call";
import { getCheckApproval } from "$lib/api/checks";

/**
 * An outside contribution waiting for someone to approve its checks: where the comment on its
 * change request links. Signed out, the layout sends the reader to sign in and back here.
 */
export const load: PageLoad = async ({ fetch, params }) => {
  try {
    const approval = await getCheckApproval(fetch, params.id);
    return { approval, breadcrumb: "Approve checks" };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) error(404, "no such check approval");
    throw e;
  }
};

import { redirect } from "@sveltejs/kit";
import type { Actions } from "./$types";
import {
  redeemLoginLink,
  sessionHeaders,
  setAuthCookies,
  UpstreamAuthError,
} from "$lib/server/auth";
import type { LinkProblem } from "$lib/utils/auth/link-problems";

// A single-user login link, as `ryph up` and `ryph login` open it. Opening it only shows a button:
// a link preview, a mail scanner or a prefetch would otherwise spend the single-use token before
// the person does. The GET reads nothing upstream, so it says nothing about whether the token is
// live; only the POST below spends it.
export const actions: Actions = {
  default: async (event) => {
    let to = "/agents";
    try {
      const pair = await redeemLoginLink(event.params.token ?? "", sessionHeaders(event));
      setAuthCookies(event, pair);
    } catch (e) {
      if (!(e instanceof UpstreamAuthError)) throw e;
      to = `/login?link=${linkProblem(e.status)}`;
    }
    redirect(303, to);
  },
};

// Only a refused token is an expired link: anything else says nothing about the link, so it
// should not send the person off for a new one. A multi-user instance refuses every link (409),
// so a new one would not help either.
function linkProblem(status: number): LinkProblem {
  if (status === 409) return "multi-user";
  if (status === 400 || status === 410) return "expired";
  return "failed";
}

import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { safeBackTo } from "$lib/utils/safe-path";

/**
 * GitHub's post-install redirect lands here with `?installation_id=` (plus a
 * `setup_action` we don't need). The registration itself happens in the page —
 * a POST inside a load would re-fire on every invalidation.
 */
export const load: PageLoad = async ({ parent, url }) => {
  const { user } = await parent();
  if (!user) redirect(302, `/login?backTo=${encodeURIComponent(url.pathname + url.search)}`);

  const installationId = url.searchParams.get("installation_id");
  if (!installationId) redirect(302, "/repos/connect");

  // The page the flow was entered from, if the install link carried one (`state`).
  return { installationId, backTo: safeBackTo(url.searchParams.get("state")) };
};

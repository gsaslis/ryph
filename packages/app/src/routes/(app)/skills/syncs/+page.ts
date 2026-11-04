import { redirect } from "@sveltejs/kit";
import { can } from "$lib/utils/auth/capabilities";
import type { PageLoad } from "./$types";
import { getConnectedRepos } from "$lib/api/repos";
import { getSkillSyncs } from "$lib/api/skills";

/** Every read of the org skills repo that changed something, newest first, a page at a time. */
export const load: PageLoad = async ({ fetch, parent }) => {
  const { user } = await parent();
  if (!can(user, "skills:read")) redirect(302, "/agents");
  const [page, repos] = await Promise.all([
    getSkillSyncs(fetch),
    // Only to link a commit to its forge: a row names its repo by id, and an unreadable list
    // costs the links, not the page.
    getConnectedRepos(fetch).catch(() => []),
  ]);
  return { ...page, repos, breadcrumb: "Sync history" };
};

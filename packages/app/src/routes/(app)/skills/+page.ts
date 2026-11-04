import { redirect } from "@sveltejs/kit";
import { can } from "$lib/utils/auth/capabilities";
import type { PageLoad } from "./$types";
import { getConnectedRepos } from "$lib/api/repos";
import { getSkills } from "$lib/api/skills";

// Every member reads what skills the deployment's runs get; only an admin changes it, and only an
// admin needs the connected repos, to pick the org skills repo from.
export const load: PageLoad = async ({ fetch, depends, parent }) => {
  const { user } = await parent();
  if (!can(user, "skills:read")) redirect(302, "/agents");
  depends("app:skills");
  const [overview, connectedRepos] = await Promise.all([
    getSkills(fetch),
    can(user, "skills:manage") ? getConnectedRepos(fetch) : Promise.resolve([]),
  ]);
  return { overview, connectedRepos };
};

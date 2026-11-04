import { error, redirect } from "@sveltejs/kit";
import { can } from "$lib/utils/auth/capabilities";
import type { PageLoad } from "./$types";
import { ApiError } from "$lib/api/call";
import { getCatalogueSkill } from "$lib/api/skills";

/** One of ryph's own skills: what it says, and its files. */
export const load: PageLoad = async ({ fetch, params, parent }) => {
  const { user } = await parent();
  if (!can(user, "skills:read")) redirect(302, "/agents");
  try {
    const detail = await getCatalogueSkill(fetch, params.name);
    return { ...detail, breadcrumb: detail.skill.name };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) error(404, "no such Ryph skill");
    throw e;
  }
};

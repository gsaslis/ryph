import { redirect } from "@sveltejs/kit";
import { can } from "$lib/utils/auth/capabilities";
import { getArtifacts } from "$lib/api/artifacts";
import type { PageLoad } from "./$types";

/** Every artifact on the instance, the most recently updated first. */
export const load: PageLoad = async ({ fetch, depends, parent }) => {
  // The nav hides the page from anyone without `artifacts:read`; a typed URL is sent home rather
  // than shown a 403.
  const { user } = await parent();
  if (!can(user, "artifacts:read")) redirect(302, "/agents");
  depends("app:artifacts");
  const page = await getArtifacts(fetch);
  return { artifacts: page.artifacts, nextBefore: page.nextBefore };
};

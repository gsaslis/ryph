import { can } from "$lib/utils/auth/capabilities";
import { redirect } from "@sveltejs/kit";
import type { LayoutLoad } from "./$types";

/** The instance area: whoever holds none of its pages' capabilities is sent home rather than
 * shown pages that only answer 403. Each page checks its own. */
export const load: LayoutLoad = async ({ parent }) => {
  const { user } = await parent();
  if (!INSTANCE_CAPABILITIES.some((capability) => can(user, capability))) redirect(302, "/agents");
  return {};
};

const INSTANCE_CAPABILITIES = ["users:manage", "settings:manage", "egress:manage"] as const;

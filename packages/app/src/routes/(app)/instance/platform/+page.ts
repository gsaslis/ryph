import { redirect } from "@sveltejs/kit";
import { can } from "$lib/utils/auth/capabilities";
import type { PageLoad } from "./$types";
import { getEgress } from "$lib/api/egress";
import { getModelAccess, getPlatformModelPolicyOrNull } from "$lib/api/provider-keys";
import { getProvidersOrEmpty } from "$lib/api/providers";
import { getReservedCapacityOrNull } from "$lib/api/reserved-capacity";

// How the platform itself behaves, for everyone on the instance: the model its background work
// uses, what runs may reach on the internet, and the room held for runs of each size. That last
// one is only read for those who may change it.
export const load: PageLoad = async ({ fetch, depends, parent }) => {
  const { user } = await parent();
  if (!can(user, "egress:manage")) redirect(302, "/instance/members");
  depends("app:platform");
  const [modelAccess, platformPolicy, egress, providers, reservedCapacity] = await Promise.all([
    getModelAccess(fetch),
    getPlatformModelPolicyOrNull(fetch),
    getEgress(fetch),
    getProvidersOrEmpty(fetch),
    can(user, "resources:manage") ? getReservedCapacityOrNull(fetch) : null,
  ]);
  return { ...modelAccess, platformPolicy, ...egress, providers, reservedCapacity };
};

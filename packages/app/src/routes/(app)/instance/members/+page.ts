import { redirect } from "@sveltejs/kit";
import { can } from "$lib/utils/auth/capabilities";
import type { PageLoad } from "./$types";
import { listInvites, listUsers } from "$lib/api/admin";
import { getAuthSettings } from "$lib/api/auth";
import { listProviders } from "$lib/api/identities";

// Everyone on the instance and everyone invited to it: a pending invite is a member who has not
// joined yet, so the two are one page.
export const load: PageLoad = async ({ fetch, depends, parent }) => {
  const { user } = await parent();
  if (!can(user, "users:manage")) redirect(302, "/instance/platform");
  depends("app:admin-users");
  depends("app:admin-invites");
  const [users, invites, providers, settings] = await Promise.all([
    listUsers(fetch),
    listInvites(fetch),
    listProviders(fetch).catch(() => []),
    getAuthSettings(fetch).catch(() => null),
  ]);
  return { users, invites, providers, multiUser: settings?.multiUser ?? true };
};

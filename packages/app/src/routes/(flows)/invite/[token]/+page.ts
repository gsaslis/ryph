import type { PageLoad } from "./$types";
import { getAuthSettings, previewInvite } from "$lib/api/auth";
import { listProviders } from "$lib/api/identities";

export const load: PageLoad = async ({ parent, params, fetch }) => {
  const { user } = await parent();
  const [preview, providers, settings] = await Promise.all([
    previewInvite(fetch, params.token),
    listProviders(fetch).catch(() => []),
    getAuthSettings(fetch).catch(() => null),
  ]);
  return {
    user,
    preview,
    providers,
    token: params.token,
    mailerConfigured: settings?.mailerConfigured ?? false,
  };
};

import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { getForgeProviders } from "$lib/api/forge";
import { safeBackTo } from "$lib/utils/safe-path";

export const load: PageLoad = async ({ parent, url, fetch }) => {
  const { user } = await parent();
  if (!user) redirect(302, `/login?backTo=${encodeURIComponent(url.pathname + url.search)}`);

  // The providers decide where "Back" goes: to the choice where there is one, out of the flow
  // where this is the only way in and /repos/connect would send us straight back here.
  // An unreachable forge answers 502; the page offers a retry instead of the generic error page.
  const providers = await getForgeProviders(fetch).catch(() => null);
  // Where the flow returns to when another flow (the welcome) opened it.
  const backTo = safeBackTo(url.searchParams.get("backTo"));
  if (providers === null) return { multiForge: false, unavailable: true, backTo };
  return { multiForge: providers.length > 1, unavailable: false, backTo };
};

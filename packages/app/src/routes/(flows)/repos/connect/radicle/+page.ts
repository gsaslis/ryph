import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { getForges, getRadicleIdentity, radicleUserMode } from "$lib/api/forge";
import { safeBackTo } from "$lib/utils/safe-path";

export const load: PageLoad = async ({ parent, url, fetch }) => {
  const { user } = await parent();
  if (!user) redirect(302, `/login?backTo=${encodeURIComponent(url.pathname + url.search)}`);

  // Who ryph is on the network, shown before anything is connected: the node has to exist for
  // this flow to work at all, and its alias and DID are what a maintainer will be asked to trust.
  // The providers decide where "Back" goes: to the forge choice where there is one, out of the
  // flow where Radicle is the only forge and /repos/connect would send us straight back here.
  // They also say whether the node is the person's own (user mode), which the page words itself for.
  const [identity, forges] = await Promise.all([
    getRadicleIdentity(fetch),
    // An unreachable forge answers 502; the page offers a retry instead of the generic error page.
    getForges(fetch).catch(() => null),
  ]);
  // Where the flow returns to when another flow (the welcome) opened it.
  const backTo = safeBackTo(url.searchParams.get("backTo"));
  if (forges === null) {
    return { identity, multiForge: false, mine: false, unavailable: true, backTo };
  }
  return {
    identity,
    multiForge: forges.providers.length > 1,
    mine: radicleUserMode(forges),
    unavailable: false,
    backTo,
  };
};

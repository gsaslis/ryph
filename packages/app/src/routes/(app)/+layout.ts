import { browser } from "$app/environment";
import { redirect } from "@sveltejs/kit";
import type { LayoutLoad } from "./$types";
import { getAgents } from "$lib/api/agents";
import { getModelAccess } from "$lib/api/provider-keys";
import { refreshSession } from "$lib/utils/auth/auth";
import { isFreshInstance, markWelcomeDone, mayBeWelcomed, welcomeFlagIn } from "$lib/utils/welcome";

export const load: LayoutLoad = async ({ parent, url, fetch }) => {
  const parentData = await parent();
  let user = parentData.user;

  // On client-side navigation the server load may be stale (access token
  // expired mid-session). Try a cookie refresh before bouncing to login.
  if (!user && browser) {
    user = await refreshSession();
  }

  if (!user) {
    const backTo = encodeURIComponent(url.pathname + url.search);
    redirect(302, `/login?backTo=${backTo}`);
  }

  // A fresh instance's admin starts in the welcome flow. Asked only while this browser has no
  // flag: the server's answer is from the request, and in the browser the cookie is read again,
  // since finishing the flow sets it there and the server load does not run again for that.
  const flagged = browser ? welcomeFlagIn(document.cookie) : parentData.welcomeDone;
  if (!flagged && mayBeWelcomed(user) && await freshInstance(fetch)) redirect(302, "/welcome");

  return { user };
};

/**
 * Whether nothing is set up yet. Once something is, the flag is set so the question is not asked
 * again in this browser. A read that fails says nothing either way, and the app opens as usual.
 */
async function freshInstance(f: typeof fetch): Promise<boolean> {
  try {
    const [{ providerKeys }, agents] = await Promise.all([getModelAccess(f), getAgents(f)]);
    const fresh = isFreshInstance({ keys: providerKeys.length, agents: agents.length });
    if (!fresh) markWelcomeDone();
    return fresh;
  } catch {
    return false;
  }
}

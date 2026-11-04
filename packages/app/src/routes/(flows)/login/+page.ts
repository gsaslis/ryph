import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { safeBackTo } from "$lib/utils/safe-path";
import { getAuthSettings, needsBootstrap } from "$lib/api/auth";
import { listProviders } from "$lib/api/identities";
import { linkProblemOf } from "$lib/utils/auth/link-problems";

export const load: PageLoad = async ({ parent, url, fetch }) => {
  const { user } = await parent();
  const backTo = safeBackTo(url.searchParams.get("backTo"));

  if (user) redirect(302, backTo ?? "/agents");

  // Whether to offer a way to register: the first-run link on a fresh instance, the sign-up
  // link while open registration is on. A control plane that cannot answer is treated as
  // closed: the cost of hiding a link is one manual trip to /register, and the cost of showing
  // one wrongly is a form that always fails.
  const [bootstrap, settings, providers] = await Promise.all([
    needsBootstrap(fetch).catch(() => false),
    getAuthSettings(fetch).catch(() => null),
    listProviders(fetch).catch(() => []),
  ]);

  return {
    backTo,
    needsBootstrap: bootstrap,
    openRegistration: settings?.allowOpenRegistration ?? false,
    multiUser: settings?.multiUser ?? true,
    // Set by the login-link route when the link it was handed did not sign anyone in.
    linkProblem: linkProblemOf(url.searchParams.get("link")),
    providers,
  };
};

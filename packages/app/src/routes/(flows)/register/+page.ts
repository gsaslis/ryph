import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { getAuthSettings, needsBootstrap } from "$lib/api/auth";

export const load: PageLoad = async ({ parent, fetch, url }) => {
  const { user } = await parent();
  if (user) redirect(302, "/agents");

  // The page works on first run (the admin's bootstrap) and while registration is open; anyone
  // else is sent where they can act. The links here are already hidden elsewhere; this covers a
  // bookmark, a back button, or a typed URL.
  const [bootstrap, settings] = await Promise.all([
    needsBootstrap(fetch).catch(() => false),
    getAuthSettings(fetch).catch(() => null),
  ]);
  // A single-user instance's owner exists from its first boot, and nobody else registers.
  if (settings?.multiUser === false) redirect(302, "/login");
  if (!bootstrap && !settings?.allowOpenRegistration) redirect(302, "/login");

  return {
    bootstrap,
    mailerConfigured: settings?.mailerConfigured ?? false,
    // The claim link the server log prints carries the setup token; typed by hand otherwise.
    setupToken: url.searchParams.get("setup") ?? "",
  };
};

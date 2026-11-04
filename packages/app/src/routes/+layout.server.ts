import type { LayoutServerLoad } from "./$types";
import { env } from "$env/dynamic/public";
import { RYPH_AUTOMATIONS_URL } from "$lib/server/auth";
import { getUserData, sessionSecondsLeft } from "$lib/utils/auth/jwt";
import { SIDEBAR_COOKIE_NAME } from "$lib/components/ui/sidebar/constants";
import {
  DETAILS_PANE_OPEN_COOKIE,
  DETAILS_PANE_WIDTH_COOKIE,
} from "$lib/components/details-pane/details-pane.svelte";
import { WELCOME_COOKIE } from "$lib/utils/welcome";

// The one place the webhook ingestion origin is resolved, server-side: the deploy's explicit
// browser-facing override first, else the automations backend itself — which in the
// single-process host is the API origin, where the ingestion door actually listens.
const automationsOrigin = (env.PUBLIC_AUTOMATIONS_ORIGIN ?? RYPH_AUTOMATIONS_URL)
  .replace(/\/+$/, "");

export const load: LayoutServerLoad = ({ locals, depends, cookies }) => {
  depends("app:user");
  // Whether the sidebar was left folded, so the server renders it that way and the page does not
  // open wide and then snap shut once it hydrates.
  const sidebarOpen = cookies.get(SIDEBAR_COOKIE_NAME) !== "false";
  // The same for the details pane beside a task: whether it was left open, and how wide.
  const detailsPaneOpen = cookies.get(DETAILS_PANE_OPEN_COOKIE) !== "false";
  const width = Number(cookies.get(DETAILS_PANE_WIDTH_COOKIE));
  const detailsPaneWidth = Number.isFinite(width) && width > 0 ? width : null;
  // Whether the welcome flow was finished or skipped in this browser, for the app's first render.
  // The browser reads its own cookie after that (see the app layout).
  const welcomeDone = cookies.get(WELCOME_COOKIE) !== undefined;
  return {
    user: getUserData(locals.accessToken),
    // How long the server still accepts that token, for the browser's session clock
    // (`noteSessionExpiry`): an artifact frame is placed after a refresh once it runs low.
    sessionExpiresIn: sessionSecondsLeft(locals.accessToken),
    automationsOrigin,
    sidebarOpen,
    detailsPaneOpen,
    detailsPaneWidth,
    welcomeDone,
  };
};

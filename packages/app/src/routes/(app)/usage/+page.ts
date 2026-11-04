import { redirect } from "@sveltejs/kit";
import { can } from "$lib/utils/auth/capabilities";
import type { PageLoad } from "./$types";
import { getAgents } from "$lib/api/agents";
import { getUsageReportOrOff } from "$lib/api/model-usage";
import { getModelAccess } from "$lib/api/provider-keys";
import { getTasksByIds } from "$lib/api/tasks";

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = [7, 30, 90];

export const load: PageLoad = async ({ fetch, url, depends, parent }) => {
  // The report rolls everyone's spend up, which takes `usage:read-all`; the nav hides the page
  // from everyone else, and a typed URL is sent home rather than shown a 403.
  const { user } = await parent();
  if (!can(user, "usage:read-all")) redirect(302, "/agents");
  depends("app:usage");
  const asked = Number(url.searchParams.get("days"));
  const days = WINDOW_DAYS.includes(asked) ? asked : 30;
  // Whole UTC days, today included: the window closes at the end of today, so every column of the
  // chart is one full day and the last one is still filling up.
  const to = new Date();
  to.setUTCHours(24, 0, 0, 0);
  const from = new Date(to.getTime() - days * DAY_MS);

  // Agents, keys and tasks only turn the report's ids into names; the report is the page.
  const [report, agents, modelAccess] = await Promise.all([
    getUsageReportOrOff(fetch, { from: from.toISOString(), to: to.toISOString() }),
    getAgents(fetch),
    getModelAccess(fetch),
  ]);
  // Only the tasks the report actually named — at most a screenful — and so a second hop rather
  // than a fourth parallel one. Reading every task in the deployment to title twenty rows grew
  // with the task table instead of with the report, on every window switch.
  // Under its own name: `tasks` in `page.data` is the tasks section's page, which the app shell
  // seeds its live list from, and this is a handful of titles, not a page.
  const namedTasks = await getTasksByIds(
    fetch,
    report === null ? [] : report.topTasks.map((t) => t.taskId),
  );
  return { days, report, agents, providerKeys: modelAccess.providerKeys, namedTasks };
};

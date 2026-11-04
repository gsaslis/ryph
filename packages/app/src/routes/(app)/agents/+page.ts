import type { PageLoad } from "./$types";
import { getAgents } from "$lib/api/agents";

export const load: PageLoad = async ({ fetch, depends }) => {
  depends("app:agents");
  const agents = await getAgents(fetch);
  // Read by the layout before the page's own effect hands the header its switch: a header
  // that is to carry it must not render folded first.
  return { agents, headerControls: agents.some((a) => a.archivedAt !== null) };
};

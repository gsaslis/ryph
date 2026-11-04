import type { PageLoad } from "./$types";
import { getAgents } from "$lib/api/agents";
import { getMemory, getMemorySubjects } from "$lib/api/memory";

export const load: PageLoad = async ({ fetch, params, depends }) => {
  depends("app:memory");
  // The subject index and the agents feed the edit dialog's completions; neither is the page.
  const [detail, subjects, agents] = await Promise.all([
    getMemory(fetch, params.id),
    getMemorySubjects(fetch).catch(() => []),
    getAgents(fetch).catch(() => []),
  ]);
  return {
    detail,
    subjects,
    agents,
    breadcrumb: `${detail.memory.text.slice(0, 48)}${detail.memory.text.length > 48 ? "…" : ""}`,
  };
};

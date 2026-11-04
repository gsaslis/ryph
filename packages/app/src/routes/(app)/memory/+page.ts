import type { PageLoad } from "./$types";
import { getAgents } from "$lib/api/agents";
import { getForges } from "$lib/api/forge";
import { getMemoryAccess, getMemoryProposals, getMemorySubjects } from "$lib/api/memory";
import { parseFilters, splitPage, toApiFilters } from "./filters";
import { gitlabHostOf } from "./labels";

export const load: PageLoad = async ({ fetch, url, depends }) => {
  depends("app:memory");
  const filters = parseFilters(url.searchParams);
  // Always the first page: changing the filters starts the list over, and the offset of any
  // page read after is the page's own state, never the URL's.
  const access = await getMemoryAccess(fetch, toApiFilters(filters));
  const { memories, hasMore } = splitPage(access.memories);
  // The subject index and the inbox only when the surface answered: with it off or unreachable
  // both would fail the same way, and the page already knows what to say.
  const [subjects, proposals, agents, forges] = access.memoryAccessEnabled
    ? await Promise.all([
      getMemorySubjects(fetch).catch(() => []),
      getMemoryProposals(fetch, "pending").catch(() => []),
      // Only to name the agent a memory is for; without it the row falls back to the id.
      getAgents(fetch).catch(() => []),
      // Only to know a self-managed GitLab's host when a subject names it.
      getForges(fetch).catch(() => null),
    ])
    : [[], [], [], null];
  const gitlabHost = gitlabHostOf(forges?.gitlab?.url);
  return { filters, ...access, memories, hasMore, subjects, proposals, agents, gitlabHost };
};

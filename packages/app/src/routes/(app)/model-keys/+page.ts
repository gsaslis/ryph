import type { PageLoad } from "./$types";
import { getAgents } from "$lib/api/agents";
import { getHarnesses } from "$lib/api/harnesses";
import { getModelAccess } from "$lib/api/provider-keys";
import { getProvidersOrEmpty } from "$lib/api/providers";

export const load: PageLoad = async ({ fetch, depends }) => {
  depends("app:model-keys");
  const [modelAccess, harnesses, providers, agents] = await Promise.all([
    getModelAccess(fetch),
    getHarnesses(fetch),
    getProvidersOrEmpty(fetch),
    // Only to say which agents use each key; a list that will not load costs the cards that line.
    getAgents(fetch).catch(() => []),
  ]);
  // Read by the layout before the page's own effect hands the header its switch: a header
  // that is to carry it must not render folded first.
  return {
    ...modelAccess,
    harnesses,
    providers,
    agents,
    headerControls: modelAccess.providerKeys.some((k) => k.archivedAt !== null),
  };
};

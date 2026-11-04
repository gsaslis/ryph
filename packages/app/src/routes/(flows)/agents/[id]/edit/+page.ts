import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { getAgent } from "$lib/api/agents";
import { getEgress } from "$lib/api/egress";
import { getForgeProviders } from "$lib/api/forge";
import { getHarnesses } from "$lib/api/harnesses";
import { getLimitsOrNull } from "$lib/api/limits";
import { getMcpCatalogue, getToolAccess } from "$lib/api/mcp-servers";
import { getModelAccess } from "$lib/api/provider-keys";
import { getProvidersOrEmpty } from "$lib/api/providers";
import { getConnectedRepos } from "$lib/api/repos";
import { getSkillsOrNull } from "$lib/api/skills";

export const load: PageLoad = async ({ parent, url, params, fetch }) => {
  const { user } = await parent();
  if (!user) redirect(302, `/login?backTo=${encodeURIComponent(url.pathname)}`);

  const [
    agent,
    harnesses,
    modelAccess,
    providers,
    toolAccess,
    connectedRepos,
    forgeProviders,
    egress,
    limits,
    skills,
    mcpCatalogue,
  ] = await Promise.all([
    getAgent(fetch, params.id),
    getHarnesses(fetch),
    getModelAccess(fetch),
    getProvidersOrEmpty(fetch),
    getToolAccess(fetch),
    getConnectedRepos(fetch),
    // Which ways in exist, for whether issue and change request tools mean anything; null when
    // the list could not be read, which leaves them offered.
    getForgeProviders(fetch).catch(() => null),
    getEgress(fetch),
    getLimitsOrNull(fetch),
    getSkillsOrNull(fetch),
    // Brand marks and the tools an entry leaves off by default. Only a nicety for the Tools
    // section, so a catalogue that cannot be read is an empty one, never an error page.
    getMcpCatalogue(fetch).catch(() => null),
  ]);
  return {
    agent,
    harnesses,
    ...modelAccess,
    providers,
    ...toolAccess,
    connectedRepos,
    forgeProviders,
    ...egress,
    limits,
    skills,
    catalogueEntries: mcpCatalogue?.entries ?? [],
  };
};

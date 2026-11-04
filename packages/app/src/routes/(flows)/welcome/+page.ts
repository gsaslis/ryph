import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { getAgents } from "$lib/api/agents";
import { getForges } from "$lib/api/forge";
import { getHarnesses } from "$lib/api/harnesses";
import { getModelAccess, getPlatformModelPolicyOrNull } from "$lib/api/provider-keys";
import { getProvidersOrEmpty } from "$lib/api/providers";
import { getConnectedRepos } from "$lib/api/repos";
import { mayBeWelcomed } from "$lib/utils/welcome";

export const load: PageLoad = async ({ parent, url, fetch, depends }) => {
  const { user } = await parent();
  if (!user) redirect(302, `/login?backTo=${encodeURIComponent(url.pathname + url.search)}`);
  // Every step registers or creates something only an admin may; anyone else has nothing to do here.
  if (!mayBeWelcomed(user)) redirect(302, "/agents");
  depends("app:welcome");

  // Every read degrades on its own: a step whose read failed says so, and the rest of the flow
  // still works. A load that threw would strand an admin here, since (app) sends them back until
  // the flow is finished or skipped.
  const [modelAccess, providers, harnesses, agents, connectedRepos, forges, background] =
    await Promise.all([
      getModelAccess(fetch).catch(() => null),
      getProvidersOrEmpty(fetch).catch(() => []),
      // Without the list the quick agent gets pi, as the full flow sends.
      getHarnesses(fetch).catch(() => []),
      getAgents(fetch).catch(() => null),
      getConnectedRepos(fetch).catch(() => null),
      // Which ways in a repository has; null when they could not be read, which leaves the step
      // pointing at the full connect flow.
      getForges(fetch).catch(() => null),
      getPlatformModelPolicyOrNull(fetch).then((policy) => ({ policy })).catch(() => null),
    ]);
  return {
    modelAccessEnabled: modelAccess?.modelAccessEnabled ?? true,
    providerKeys: modelAccess?.providerKeys ?? [],
    providers,
    harnesses,
    agents: (agents ?? []).filter((agent) => agent.archivedAt === null),
    connectedRepos: (connectedRepos ?? []).filter((repo) => repo.archivedAt === null),
    forges,
    platformPolicy: background?.policy ?? null,
    /** The reads that failed, so their step says it could not show what is there. */
    unread: {
      keys: modelAccess === null,
      agents: agents === null,
      repos: connectedRepos === null,
      background: background === null,
    },
  };
};

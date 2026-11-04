import type { PageLoad } from "./$types";
import { getMcpCatalogue, getToolAccess } from "$lib/api/mcp-servers";

export const load: PageLoad = async ({ fetch, depends }) => {
  depends("app:tool-servers");
  // Both folded: a deployment without tool access answers an empty list AND an empty catalogue,
  // and the page says "tool access is off" rather than rendering a 500 for either.
  const [access, catalogue] = await Promise.all([getToolAccess(fetch), getMcpCatalogue(fetch)]);
  // Read by the layout before the page's own effect hands the header its switch: a header
  // that is to carry it must not render folded first.
  return {
    ...access,
    catalogue,
    headerControls: access.mcpServers.some((s) => s.archivedAt !== null),
  };
};

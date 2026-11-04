// Which deployment, which person, and what the token may do there: the first thing to ask when
// a tool is refused.

import { lines } from "../format.ts";
import { object, READ, type Tool } from "../tool.ts";

/** Whether a capability list lets a tool do anything at all. */
export function usable(tool: Pick<Tool, "needs" | "needsAll">, caps: readonly string[]): boolean {
  if (caps.includes("*") || tool.needs.length === 0) return true;
  const held = (need: string) => caps.includes(need);
  return tool.needsAll ? tool.needs.every(held) : tool.needs.some(held);
}

const needsText = (t: Tool) => t.needs.join(t.needsAll ? " and " : " or ");

/** `served` is the list this server serves, so a read-only server names only what it serves. */
export function whoamiTool(
  served: () => readonly Tool[],
  opts: { readOnly?: boolean } = {},
): Tool {
  return {
    name: "whoami",
    description: "Which ryph deployment this server talks to, as whom, and which of these tools " +
      "the API token's capabilities allow.",
    inputSchema: object({}),
    annotations: READ,
    needs: [],
    routes: [["GET", "/v1/auth/me"]],
    run: async (_args, ctx) => {
      const api = await ctx.api();
      const claims = await api.claims();
      const me = await api.json<{ email: string; name: string; role?: string }>(
        "GET",
        "/v1/auth/me",
      ).catch(() => null);
      const tools = served().filter((t) => t.name !== "whoami");
      const can = tools.filter((t) => usable(t, claims.caps)).map((t) => t.name);
      const cannot = tools.filter((t) => !usable(t, claims.caps));
      // A tool some of whose actions need no capability is partly usable, not unusable.
      const partly = cannot.filter((t) => (t.openActions ?? []).length > 0);
      const none = cannot.filter((t) => !partly.includes(t));
      return lines(
        `Deployment: ${api.origin}`,
        `Signed in as: ${me?.name ?? claims.name} <${me?.email ?? claims.email}>${
          me?.role ? `, role ${me.role}` : ""
        } (via an API token)`,
        `Token capabilities: ${claims.caps.join(", ") || "none"}`,
        opts.readOnly &&
          "This server is read-only (ryph mcp --read-only): it serves only the tools that read, " +
            "whatever the token holds.",
        `Tools it can use: ${
          [
            ...can,
            ...partly.map((t) =>
              `${t.name} (only ${t.openActions!.join(", ")}; the rest needs ${needsText(t)})`
            ),
          ].join(", ") || "none"
        }`,
        none.length > 0 &&
          `Tools it cannot: ${none.map((t) => `${t.name} (needs ${needsText(t)})`).join(", ")}`,
        "Some tools need more for some actions; a refusal names the capability.",
      );
    },
  };
}

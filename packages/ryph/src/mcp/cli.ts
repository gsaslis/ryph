// `ryph mcp` — a ryph deployment, wherever it runs, as tools for an agent on this machine:
// `claude mcp add ryph -- ryph mcp`. A client of that deployment through its public app, with an
// API token; it reads no database and starts nothing.
//
// The configuration is read on the first tool call, not at start: a missing RYPH_TOKEN is a tool
// error the agent can relay, not a server that never came up.

import { resolveClientConfig, RyphClient } from "../api/client.ts";
import { ryphServer } from "./server.ts";
import { serveStdio } from "./stdio.ts";

export const MCP_HELP = `ryph mcp — a ryph deployment as MCP tools, over stdio

USAGE
  ryph mcp                         serve until stdin closes
  ryph mcp --read-only             serve only the tools that read: nothing the agent calls
                                   starts, steers, approves or configures anything

  With Claude Code:
    claude mcp add ryph -e RYPH_URL=https://ryph.example.com -e RYPH_TOKEN=ryph_pat_… -- ryph mcp
  or, with both in ~/.ryph/config.env:
    claude mcp add ryph -- ryph mcp

ENVIRONMENT
  RYPH_URL                         the ryph web app, e.g. https://ryph.example.com
  RYPH_TOKEN                       an API token (ryph_pat_…), minted on your account page. Its
                                   capabilities decide which tools work: the whoami tool lists them.
                                   A token for an agent should not hold patches:review or
                                   agents:policy unless the agent is meant to approve patches or
                                   set an agent's policies.
  Both may also live in ~/.ryph/config.env. The environment wins.
`;

/** Entry point from main.ts; returns the exit code. */
export async function mcp(argv: string[], version?: string): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    console.log(MCP_HELP);
    return 0;
  }
  const readOnly = argv.includes("--read-only");
  const unexpected = argv.find((a) => a !== "--read-only");
  if (unexpected !== undefined) {
    console.error(`error: unexpected ${JSON.stringify(unexpected)}\n\n${MCP_HELP}`);
    return 3;
  }
  let client: Promise<RyphClient> | null = null;
  await serveStdio(ryphServer(version, { readOnly }), {
    api: () => {
      // One client for the session, so the access token is exchanged once; a failed read of the
      // configuration is tried again on the next call, after the person fixed it.
      client ??= resolveClientConfig().then((config) => new RyphClient(config));
      return client.catch((err) => {
        client = null;
        throw err;
      });
    },
    cwd: process.cwd(),
    intervalMs: 3000,
  });
  return 0;
}

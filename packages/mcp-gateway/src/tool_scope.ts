// The tool-scope grammar, on its own — the `@ryph/mcp-gateway/tool-scope` entry point.
//
// A leaf by design, and the design is the point: the control plane validates an agent's
// `toolPolicy` against this union, and importing it from the package barrel would drag the whole
// gateway in behind it — the data-plane handler, the drizzle store, the pglite/postgres db
// factory, the DNS resolver. Every process that mounts the orchestrator would then LOAD all of
// that: the control-plane image, and the compiled `ryph` binary the repo already watches for
// workspace bloat. None of it would ever run there.
//
// So: zod and nothing else. Whatever else this package grows, this file must stay importable by
// a process that holds no RYPH_MCP_KEY and never speaks to a database.

import { z } from "@zod/zod";

const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/, {
  error: "tool names are 1–128 letters, digits, '_', '.' or '-'",
});

/** `"*"` allows every tool the server reports; a list is an exact allowlist of tool names. */
export const AllowedToolsSchema = z.union([z.literal("*"), z.array(toolName).max(200)]);

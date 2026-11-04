// What one MCP tool is, independent of the transport that serves it: a name, a JSON Schema for
// its arguments, the capabilities a token needs for it, and a handler over a client. The stdio
// server (stdio.ts) and a later HTTP mount both serve the same list.
//
// Invariants:
// - a handler never prints: it returns text, and throws `UsageError` for arguments it cannot use
//   and `ApiError` for a call the server refused; the transport turns both into a tool error
// - a handler reads its client through `ctx.api()`, so a missing configuration is a tool error
//   the agent can relay, not a server that never came up; that client is bound to the call's
//   signal, so a cancelled call's requests end with it

import type { RyphClient } from "../api/client.ts";

export type JsonSchema = Record<string, unknown>;

/** MCP's behaviour hints: what a client may assume about a call before making it. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolContext {
  /** The client, built on first use; every request it makes ends with `signal`. */
  api(): Promise<RyphClient>;
  /** Aborted when the client cancels the call or goes away. A wait of its own combines it with
   * its deadline, so a cancelled call stops rather than waiting its time out unheard. */
  signal: AbortSignal;
  /** Where the server was started: the repository `checks_run` asks about by default. */
  cwd: string;
  /** Tells the client how a long call is going, when it asked to be told. */
  progress(message: string): void;
  /** Between polls while waiting; tests shorten it. */
  intervalMs: number;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  /** What a token needs for the tool, for the README and `whoami`: any one of these is enough
   * for some of what the tool does, unless `needsAll`; the server is the judge. */
  needs: readonly string[];
  /** The tool does nothing useful without every one of `needs` (checks_run asks, then reads). */
  needsAll?: boolean;
  /** Actions any token may take, whatever `needs` says (deployment's `limits`): `whoami` names
   * the tool as partly usable rather than not at all. */
  openActions?: readonly string[];
  /** Every route the tool may call, as method and path with `{placeholders}`: each must be a
   * door the app forwards a bearer through (tests/mcp_doors_test.ts holds the two together). */
  routes: ReadonlyArray<readonly [string, string]>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/** An object schema; every property optional unless named in `required`. */
export function object(
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
): JsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required: [...required] } : {}),
    additionalProperties: false,
  };
}

export const str = (description: string): JsonSchema => ({ type: "string", description });
export const int = (description: string, min?: number, max?: number): JsonSchema => ({
  type: "integer",
  description,
  ...(min === undefined ? {} : { minimum: min }),
  ...(max === undefined ? {} : { maximum: max }),
});
export const bool = (description: string): JsonSchema => ({ type: "boolean", description });
export const oneOf = (values: readonly string[], description: string): JsonSchema => ({
  type: "string",
  enum: [...values],
  description,
});
export const strings = (description: string): JsonSchema => ({
  type: "array",
  items: { type: "string" },
  description,
});
/** A JSON body passed through to the API as it is; the server validates it. */
export const body = (description: string): JsonSchema => ({
  type: "object",
  description,
  additionalProperties: true,
});

export const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
};

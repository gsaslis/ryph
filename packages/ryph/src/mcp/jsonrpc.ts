// `ryph mcp`'s tools as a @ryph/shared/mcp tool server, which owns the protocol. What is the
// CLI's own: an unknown tool or argument is answered in words, so the model reads it and picks
// another, and a refusal the client can explain (a usage error, a refused token, a missing
// capability) is a tool error saying what to do about it. stdio.ts carries the frames over a pipe
// and keeps the framing, cancellation and in-flight ids to itself.
//
// Invariants:
// - never throws: a malformed message is a JSON-RPC error, a refused call a tool error
//   (`isError`), and only a bug in a handler is an internal error
// - a tool's verdict is a successful call even when the verdict is bad news (a failed suite, a
//   refused patch): `isError` is for calls that could not be made

import * as mcp from "@ryph/shared/mcp";
import { ApiError, TokenRefusedError, UsageError } from "../api/client.ts";
import { GitError } from "../checks/git.ts";
import type { Tool, ToolContext } from "./tool.ts";

export interface ToolServer {
  info: { name: string; version: string };
  instructions: string;
  tools: readonly Tool[];
}

/** What a call needs beyond the server: its context, minus progress, which is per call. */
export interface CallContext extends Omit<ToolContext, "progress" | "signal"> {
  /** Sends a notification to the client. */
  notify?(frame: mcp.Frame): void;
  /** Ends this message's call: the client cancelled it or went away. A cancelled call is not
   * answered. */
  signal?: AbortSignal;
}

/** One parsed message → the frame to answer it with, or null for a notification. */
export async function handleMessage(
  raw: unknown,
  server: ToolServer,
  ctx: CallContext,
): Promise<mcp.Frame | null> {
  const reply = await mcp.handleMessage(toolServer(server, ctx), raw, {
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.notify ? { notify: ctx.notify } : {}),
  });
  return reply?.body ?? null;
}

function toolServer(server: ToolServer, ctx: CallContext): mcp.ToolServer {
  return {
    info: server.info,
    instructions: server.instructions,
    tools: {
      list: () =>
        server.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        })),
      async call(name, args, { signal, progress }) {
        const tool = server.tools.find((t) => t.name === name);
        if (tool === undefined) {
          return mcp.toolText(
            `Unknown tool: ${name}. The tools here: ${server.tools.map((t) => t.name).join(", ")}`,
            true,
          );
        }
        const unknown = unknownArguments(tool, args);
        if (unknown !== null) return mcp.toolText(unknown, true);
        const call: ToolContext = {
          ...ctx,
          progress,
          signal,
          api: async () => (await ctx.api()).withSignal(signal),
        };
        try {
          return mcp.toolText(await tool.run(args, call));
        } catch (err) {
          const refusal = describeRefusal(err);
          if (refusal !== null) return mcp.toolText(refusal, true);
          throw err;
        }
      },
    },
    failed(name, err) {
      console.error(`ryph mcp: ${name} failed:`, err);
      return `${name} failed: ${String(err)}`;
    },
  };
}

/** A failure worth handing the agent as words, or null for a bug. */
function describeRefusal(err: unknown): string | null {
  if (err instanceof UsageError || err instanceof GitError) return err.message;
  if (!(err instanceof ApiError)) return null;
  // The token itself was refused at the exchange: nothing was passed on or dropped.
  if (err instanceof TokenRefusedError) {
    return `${err.message}. Mint a new one on your account page and set RYPH_TOKEN.`;
  }
  // A 401 after a fresh exchange: the token is good, so the app dropped it on the way, which is
  // what an app that predates this route's bearer door does.
  if (err.status === 401) {
    return `${err.message}. The token was accepted at sign-in, so the app did not pass it on ` +
      "for this route: the deployment may be older than this ryph CLI.";
  }
  if (err.status === 403) {
    return `${err.message}. Mint a token holding that capability on your account page, or ask ` +
      "an admin for the role that has it.";
  }
  return err.message;
}

/**
 * Arguments the tool's schema does not name, refused in words when its schema says it takes no
 * others: a misspelt `taskid` would otherwise be dropped and the call made without it.
 */
function unknownArguments(tool: Tool, args: Record<string, unknown>): string | null {
  const schema = tool.inputSchema as {
    properties?: Record<string, unknown>;
    additionalProperties?: unknown;
  };
  if (schema.additionalProperties !== false) return null;
  const known = Object.keys(schema.properties ?? {});
  const extra = Object.keys(args).filter((k) => !known.includes(k));
  if (extra.length === 0) return null;
  return `${tool.name} takes no ${extra.join(", ")}; its arguments are: ${
    known.join(", ") || "none"
  }`;
}

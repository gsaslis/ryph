// The one tool a run holds, as an MCP server would list and call it: `post`. Bare name — the pi
// extension prefixes it with the platform server's slug, so the agent sees `chat__post`. The
// run is whatever the gateway said it was; nothing in the arguments names a room.

import type { ChatService, PostedImages } from "../core/service.ts";
import { describeIssues } from "@ryph/shared/http";
import { jsonSchemaOf, PostArgsSchema } from "../schema.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** An MCP `tools/call` result: text content, and whether it is an error the model should read. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const failure = (t: string): ToolResult => ({
  content: [{ type: "text", text: t }],
  isError: true,
});

export const TOOLS: ToolDefinition[] = [
  {
    name: "post",
    description: "Post a message into the chat conversation this run is bound to, signed with " +
      "your name. Use it to say what you found, what you are about to do, and when a patch or " +
      "an issue is ready — briefly; people read it on their phones. Whatever people say to " +
      "you there reaches you as a message.",
    inputSchema: jsonSchemaOf(PostArgsSchema),
  },
];

export interface ToolCallContext {
  service: ChatService;
  runId: string;
}

/** One call; null for a tool this server does not have. Throws only on a failure that is
 * nobody's argument. */
export async function callTool(
  ctx: ToolCallContext,
  name: string,
  args: unknown,
): Promise<ToolResult | null> {
  if (name !== "post") return null;
  const parsed = PostArgsSchema.safeParse(args ?? {});
  if (!parsed.success) return failure(describeIssues(parsed.error));
  const outcome = await ctx.service.post(ctx.runId, parsed.data.text);
  if (outcome.kind === "refused") return failure(outcome.reason);
  const posted = outcome.parts === 1 ? "Posted." : `Posted, in ${outcome.parts} messages.`;
  return text(outcome.images === null ? posted : `${posted} ${describeImages(outcome.images)}`);
}

/** What became of a post's images, for the model: the text is out either way, so this is not an
 * error, but an image that did not make it is named so the run can say so or try again. */
export function describeImages(images: PostedImages): string {
  const said: string[] = [];
  if (images.uploaded > 0) {
    said.push(
      images.uploaded === 1 ? "1 image went with it." : `${images.uploaded} images went with it.`,
    );
  }
  if (images.linked.length > 0) {
    said.push(
      `The room cannot take files from ryph, so these went as links to ryph instead: ${
        images.linked.map((label) => JSON.stringify(label)).join(", ")
      }.`,
    );
  }
  if (images.failed.length > 0) {
    said.push(
      `These images did not make it: ${
        images.failed.map((f) => `${f.ref} (${JSON.stringify(f.label)}): ${f.error}`).join("; ")
      }.`,
    );
  }
  return said.join(" ");
}

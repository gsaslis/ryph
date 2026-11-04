import { appendFile, writeFile } from "node:fs/promises";
import { runtimeCredentials } from "../../helpers/runtime_credentials.ts";

// A `Harness` that acts like an agent without a real CLI or a single token spent:
// writes a file into the checkout's first repo, narrates, respects cancellation, ends the run
// through the runner's own `finish` tool the way an agent does once its task is delivered — and
// answers every message that reaches it before the run is over with a line, settling again, so
// the conversation is exercised end-to-end without a CLI. It cannot see, so the images it is
// handed are only counted, and their files named in the note's `saved` form, the way a model
// without vision reads around them.

import type { Harness, HarnessTools } from "../../ports/harness.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import { withImagesNote } from "../../core/images.ts";

const SUMMARY = "Echoed the task into AGENT_NOTES.md";

export function echoHarness(): Harness {
  return {
    async run(input, io) {
      if (io.signal.aborted) {
        return { summary: "stopped before doing any work", interrupted: true };
      }
      io.onTranscript({
        kind: "assistant",
        text: `Starting: ${input.spec.title}`,
      });

      const notes = [
        `# ${input.spec.title}`,
        "",
        input.spec.instructions,
        "",
        `Brief seen: ${input.brief ? "yes" : "no"}`,
        `System prompt seen: ${input.systemPrompt ? "yes" : "no"}`,
        `Environment seen: ${input.environment ? "yes" : "no"}`,
        `Repos in the checkout: ${input.repos.map((r) => r.path).join(", ")}`,
        // echo has no MCP client; it notes the servers it was offered and calls none of them
        `Tool servers offered: ${input.tools?.servers.map((s) => s.slug).join(", ") || "none"}`,
        `Task images: ${input.taskImages?.images.length ?? 0}`,
        ...(input.taskImages === undefined ? [] : [input.taskImages.saved]),
        "",
      ].join("\n");
      // Into the first repo: the root itself is no repository, and a file left there would
      // never be committed — which is exactly what the layout block tells a real agent.
      const notesPath = `${input.checkoutDir}/${input.repos[0].path}/AGENT_NOTES.md`;
      await writeFile(notesPath, notes);
      io.onTranscript({ kind: "tool_use", text: "wrote AGENT_NOTES.md" });

      if (io.signal.aborted) {
        return { summary: "stopped after writing notes", interrupted: true };
      }
      io.onTranscript({ kind: "assistant", text: "Done." });

      // Delivered: the run ends at this settle. Without the runner's tool server to call there
      // is no way to say so, and the run ends on its idle clock instead.
      const loopback = input.tools?.loopback;
      if (loopback !== undefined) await finish(loopback, io.diagnostics);

      // Settled now, and every message from here on is answered with a line — in the notes and
      // in the transcript — followed by another settle. The loop ends when the run does
      // (`done`), or when the run is cancelled.
      const conversation = io.conversation;
      conversation.onSettled();
      for await (const message of conversation.messages) {
        if (io.signal.aborted) break;
        const seen = message.images?.images.length ?? 0;
        const images = seen === 0 ? "" : ` (${seen} image${seen === 1 ? "" : "s"})`;
        const text = withImagesNote(message.text, message.images?.saved ?? "");
        io.onTranscript({ kind: "assistant", text: `Re${images}: ${text}` });
        await appendFile(notesPath, `Reply${images}: ${text}\n`);
        conversation.onSettled();
      }

      if (io.signal.aborted) {
        return { summary: "stopped mid-conversation", interrupted: true };
      }
      return { summary: SUMMARY, interrupted: false };
    },
  };
}

/** Calls the runner's `finish` tool, as an agent's MCP client would. A call that fails costs
 * only the early end: the run then ends on its idle clock. */
async function finish(
  loopback: NonNullable<HarnessTools["loopback"]>,
  diag: Diagnostics,
): Promise<void> {
  try {
    const res = await fetch(loopback.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${runtimeCredentials.get(loopback.tokenEnv) ?? ""}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "finish", arguments: { outcome: "success", summary: SUMMARY } },
      }),
    });
    const body = await res.json() as { error?: unknown; result?: { isError?: boolean } };
    if (!res.ok || body.error !== undefined || body.result?.isError === true) {
      diag.warn("echo.finish_refused", { status: res.status, body });
    }
  } catch (err) {
    diag.warn("echo.finish_failed", { err: String(err) });
  }
}

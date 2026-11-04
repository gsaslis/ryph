// A fake pi CLI speaking the RPC protocol (JSONL commands on stdin, JSONL events on stdout)
// for the pi adapter tests. Emits a canned event script per --scenario and ignores the real
// pi flags the adapter passes. The event shapes mirror pi.dev/docs/latest (docs-derived —
// re-check against a live `pi --mode rpc` transcript if the protocol drifts).
// Deliberately free of package imports: it runs as a plain script from a temp cwd, node: built-ins
// only.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const scenario = process.argv.slice(2)
  .find((a) => a.startsWith("--scenario="))
  ?.slice("--scenario=".length) ?? "happy";

const out = (obj: unknown) => console.log(JSON.stringify(obj));

// The real pi loads each extension the adapter passes with `-e`, and each of ryph's announces
// itself on stderr: the MCP one once its tools are registered, the images one once it has
// hooked pi's requests. Mirrored here — except in the scenario that plays a pi which took the
// flags and ignored them, the failure the adapter's missing-marker warnings exist to catch.
for (const [i, arg] of process.argv.slice(2).entries()) {
  if (arg !== "-e" || scenario === "no-extension") continue;
  console.error(
    process.argv.slice(2)[i + 1]?.endsWith("/images.ts")
      ? "ryph pi-images: ready — at most 20 images per request"
      : "ryph pi-mcp: ready — 2 tool(s) from 2 server(s)",
  );
}

const assistantEnd = (text: string, stopReason: string, extra: Record<string, unknown> = {}) =>
  out({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], stopReason, ...extra },
  });

/** The prompt the adapter sent, kept so the introspect scenario can report it. */
let promptSeen = "";
/** The images the task's prompt carried, as pi's RPC takes them. */
let imagesSeen: unknown[] = [];
/** Conversation scenarios: whether the first (task) prompt has been answered — later prompts
 * are the messages the adapter relays, and are answered as turns of their own. */
let taskAnswered = false;
/** The busy scenario: whether the agent is mid-turn, so a prompt now is a steer. */
let streaming = false;
let preparing = false;

async function delayedPrompt(cmd: Record<string, unknown>) {
  if (preparing) {
    out({
      type: "response",
      command: "prompt",
      id: cmd.id,
      success: false,
      error: "concurrent startup",
    });
    return;
  }
  preparing = true;
  if (scenario === "delayed-cancel") {
    assistantEnd("Preparing", "stop");
    return;
  }
  // Input keeps being read during both asynchronous preflight and the gap before agent_start.
  out({
    type: "response",
    command: "prompt",
    id: "unrelated",
    success: true,
    data: { disposition: "queued" },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  if (scenario === "delayed-reject") {
    out({
      type: "response",
      command: "prompt",
      id: cmd.id,
      success: false,
      error: "startup rejected",
    });
    return;
  }
  if (scenario === "delayed-exit") process.exit(7);
  out({
    type: "response",
    command: "prompt",
    id: cmd.id,
    success: true,
    data: { disposition: "started" },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  preparing = false;
  out({ type: "agent_start" });
  assistantEnd(
    taskAnswered ? `Re(${cmd.streamingBehavior}): ${cmd.message}` : "Initial task started",
    "stop",
  );
  taskAnswered = true;
  out({ type: "agent_end" });
  out({ type: "agent_settled" });
}

/** The images a prompt rode with, by type and size, as a tag; empty for none. */
function imagesTag(images: unknown[]): string {
  const seen = images.map((i) => {
    const image = i as { type?: string; mimeType?: string; data?: string };
    return `${image.type}:${image.mimeType}:${image.data?.length}`;
  });
  return seen.length === 0 ? "" : `[${seen.join(",")}]`;
}

function onPrompt(
  message: string,
  streamingBehavior: string | undefined,
  images: unknown[],
  id: string,
) {
  if (taskAnswered && streaming) {
    // The busy scenario's steer: queued by a working agent, then read at the end of its tool
    // call — answered, and the turn the task started ends.
    out({
      type: "response",
      command: "prompt",
      id,
      success: true,
      data: { disposition: "queued" },
    });
    assistantEnd(`Steered(${streamingBehavior ?? "none"})${imagesTag(images)}: ${message}`, "stop");
    out({ type: "agent_end" });
    out({ type: "agent_settled" });
    streaming = false;
    return;
  }
  if (taskAnswered && scenario.startsWith("conversation")) {
    // A relayed message. The real pi steers a working agent and starts a turn on an idle one;
    // the fake is always idle by now, so every message is a turn: an assistant reply that
    // echoes the message and the streaming flag it rode with, then a settle. The adapter's
    // contract is that the flag is ALWAYS set — a bare prompt would fail on a streaming pi.
    out({
      type: "response",
      command: "prompt",
      id,
      success: true,
      data: { disposition: "started" },
    });
    out({ type: "agent_start" });
    // The images a relayed message rode with, by type and size, when it had any.
    assistantEnd(`Re(${streamingBehavior ?? "none"})${imagesTag(images)}: ${message}`, "stop");
    out({ type: "agent_end" });
    out({ type: "agent_settled" });
    return;
  }
  promptSeen = message;
  imagesSeen = images;
  out({ type: "response", command: "prompt", id, success: true, data: { disposition: "started" } });
  switch (scenario) {
    case "context":
    case "context-unsupported":
      out({ type: "agent_start" });
      // Wait for the adapter's stats request before settling.
      break;
    case "long-assistant":
      out({ type: "agent_start" });
      assistantEnd("Long answer. ".repeat(4_000) + "The end.", "stop");
      out({ type: "agent_end", messages: [] });
      out({ type: "agent_settled" });
      break;
    case "conversation":
      // The task: answered at once, then the fake waits to be spoken to. Stdin closing (the
      // adapter's way of saying the run is over) ends the loop below and the process.
      taskAnswered = true;
      out({ type: "session", version: 3, id: "fake-session" });
      out({ type: "agent_start" });
      assistantEnd("Ready when you are.", "stop");
      out({ type: "agent_end" });
      out({ type: "agent_settled" });
      break;
    case "conversation-exit":
      // The task answered and settled, then pi dies between turns while the run waits to be
      // spoken to: nobody said the run was over.
      out({ type: "agent_start" });
      assistantEnd("Ready when you are.", "stop");
      out({ type: "agent_end" });
      out({ type: "agent_settled" });
      console.error("fake pi crashed between turns");
      process.exit(3);
      break;
    case "conversation-image":
      // The task's turn ends on a tool result with an image, so its settle is read while that
      // image may still be uploading; later messages are answered as turns (above).
      taskAnswered = true;
      out({ type: "agent_start" });
      out({ type: "tool_execution_start", toolCallId: "t1", toolName: "shot", args: {} });
      out({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "shot",
        result: { content: [{ type: "image", data: "iVBORw0KGgoAAAAN", mimeType: "image/png" }] },
        isError: false,
      });
      assistantEnd("Took a look.", "stop");
      out({ type: "agent_end" });
      out({ type: "agent_settled" });
      break;
    case "conversation-busy":
      // The task starts a turn that is still going when the first message arrives: that one is
      // a steer (above), and the turn settles once it is read.
      taskAnswered = true;
      streaming = true;
      out({ type: "agent_start" });
      assistantEnd(`Working on it${imagesTag(images)}.`, "toolUse");
      break;
    case "happy":
    case "no-extension":
      out({ type: "session", version: 3, id: "fake-session" });
      out({ type: "agent_start" });
      out({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should write the file." },
            { type: "text", text: "Writing the file now." },
            { type: "toolCall", id: "t1", name: "write", arguments: { path: "x.txt" } },
          ],
          stopReason: "toolUse",
        },
      });
      out({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "write",
        args: { path: "x.txt" },
      });
      out({ type: "tool_execution_end", toolCallId: "t1", result: "ok", isError: false });
      // toolResult messages must NOT be narrated (they dup tool_execution_end)
      out({
        type: "message_end",
        message: { role: "toolResult", toolCallId: "t1", toolName: "write", content: [] },
      });
      assistantEnd("All done: wrote the file.\n\n<memory>not a protocol any more</memory>", "stop");
      out({ type: "agent_end" });
      out({ type: "agent_settled" });
      break;
    case "abort":
    case "abort-noise":
      out({ type: "session", version: 3, id: "fake-session" });
      out({ type: "agent_start" });
      assistantEnd("working on it", "toolUse");
      break; // now waits for the abort command (handled in the stdin loop)
    case "tool-error":
      out({ type: "agent_start" });
      out({ type: "tool_execution_start", toolCallId: "t1", toolName: "run", args: { cmd: "x" } });
      // a failed tool with NO result field — the adapter must still narrate something
      out({ type: "tool_execution_end", toolCallId: "t1", isError: true });
      assistantEnd("gave up after the tool failed", "stop");
      out({ type: "agent_settled" });
      break;
    case "stderr-spam":
      out({ type: "agent_start" });
      // well past the adapter's stderr cap: draining must neither stall pi nor fail the run
      for (let i = 0; i < 10; i++) console.error("x".repeat(8_192));
      assistantEnd("ok", "stop");
      out({ type: "agent_settled" });
      break;
    case "stop-error":
      out({ type: "agent_start" });
      assistantEnd("", "error", { errorMessage: "provider exploded" });
      out({ type: "agent_settled" });
      break;
    case "stop-auth-error":
      // pi-ai's shape for a provider refusing the key: the status first, then the body.
      out({ type: "agent_start" });
      assistantEnd("", "error", {
        errorMessage:
          '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      });
      out({ type: "agent_settled" });
      break;
    case "image-read":
      // pi's read tool on an image file: the result carries the image itself, base64.
      out({ type: "agent_start" });
      out({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "read",
        args: { path: "/tmp/ryph-images-x/1.png" },
      });
      out({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "read",
        result: {
          content: [
            { type: "text", text: "Read image file [image/png]" },
            { type: "image", data: "QUJD".repeat(5_000), mimeType: "image/png" },
          ],
        },
        isError: false,
      });
      assistantEnd("It is a cat.", "stop");
      out({ type: "agent_settled" });
      break;
    case "tool-images": {
      // Two tools that return images — a browser screenshot (a PNG, and a BMP the control plane
      // would not keep) and pi's read of a file — with an assistant message between them.
      const png = "iVBORw0KGgoAAAAN"; // a PNG's signature and the start of its header
      out({ type: "agent_start" });
      out({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "browser__screenshot",
        args: {},
      });
      out({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "browser__screenshot",
        result: {
          content: [
            { type: "text", text: "Screenshot of the page" },
            { type: "image", data: png, mimeType: "image/png" },
            // The ref line the images extension puts after each image (packages/pi-mcp).
            { type: "text", text: `Image ref: ${REF_PNG}` },
            { type: "image", data: "Qk0AAAAA", mimeType: "image/bmp" },
            { type: "text", text: `Image ref: ${REF_BMP}` },
          ],
        },
        isError: false,
      });
      assistantEnd("Looked at it.", "toolUse");
      out({
        type: "tool_execution_start",
        toolCallId: "t2",
        toolName: "read",
        args: { path: "/tmp/x.png" },
      });
      out({
        type: "tool_execution_end",
        toolCallId: "t2",
        toolName: "read",
        // A line naming other bytes: what pi 1.0.0 prints when it resized the image after the
        // extension named it.
        result: {
          content: [
            { type: "image", data: png, mimeType: "image/png" },
            { type: "text", text: "Image ref: img-000000000000" },
          ],
        },
        isError: false,
      });
      assistantEnd("Done.", "stop");
      out({ type: "agent_settled" });
      break;
    }
    case "tool-image-echo": {
      // pi 1.0.0's shape around one screenshot: the tool result, then the same image again in
      // the toolResult message's start and end, a streaming update, turn_end and agent_end — and
      // an assistant message that (unusually) carries an image block of its own.
      const big = "iVBORw0KGgoAAAAN" + "QUJD".repeat(50_000);
      const image = { type: "image", data: big, mimeType: "image/png" };
      const toolResult = { role: "toolResult", toolCallId: "t1", content: [image] };
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "Seen." }, image],
        stopReason: "stop",
      };
      out({ type: "agent_start" });
      out({ type: "tool_execution_start", toolCallId: "t1", toolName: "shot", args: {} });
      out({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "shot",
        result: { content: [image] },
        isError: false,
      });
      out({ type: "message_start", message: toolResult });
      out({ type: "message_end", message: toolResult });
      out({ type: "message_update", message: assistant });
      out({ type: "message_end", message: assistant });
      out({ type: "turn_end", message: assistant, toolResults: [toolResult] });
      out({ type: "agent_end", messages: [toolResult, assistant] });
      out({ type: "agent_settled" });
      break;
    }
    case "introspect":
      out({ type: "agent_start" });
      // Reports what the adapter handed this process — argv, the env slice it cares about, and
      // the files in the config dir it was pointed at — as the final message, for the tests
      // that pin the spawn contract.
      assistantEnd(JSON.stringify(introspect()), "stop");
      out({ type: "agent_settled" });
      break;
    case "garbage":
      console.log("this is not json");
      process.exit(0);
      break;
    case "early-exit":
      out({ type: "agent_start" });
      console.error("fake pi died");
      process.exit(1);
      break;
    case "done":
      // one message, the run's account
      out({ type: "agent_start" });
      assistantEnd("Did the work.", "stop");
      out({ type: "agent_settled" });
      break;
    case "prose-then-empty":
      // the answer in one message, then a final message with no text
      out({ type: "agent_start" });
      assistantEnd("Here is my full answer.", "toolUse");
      assistantEnd("", "stop");
      out({ type: "agent_settled" });
      break;
    default:
      // "image-burst:<count>:<path>": <count> tool results with an image each, then more output
      // than any pipe holds, then a file written at <path> — which the fake only gets to once
      // the adapter has kept reading its stdout. A test's upload that waits for the file proves
      // the read loop never waited for an upload.
      if (scenario.startsWith("image-burst:")) {
        const [, count, path] = scenario.split(":");
        out({ type: "agent_start" });
        for (let i = 1; i <= Number(count); i++) {
          out({ type: "tool_execution_start", toolCallId: `t${i}`, toolName: "shot", args: {} });
          out({
            type: "tool_execution_end",
            toolCallId: `t${i}`,
            toolName: "shot",
            result: {
              content: [{ type: "image", data: "iVBORw0KGgoAAAAN", mimeType: "image/png" }],
            },
            isError: false,
          });
        }
        // Streaming deltas the adapter reads and does not narrate: 2 MB of them.
        for (let i = 0; i < 2_000; i++) out({ type: "message_update", pad: "x".repeat(1_000) });
        writeFileSync(path, "drained");
        assistantEnd("Done.", "stop");
        out({ type: "agent_settled" });
        break;
      }
      break;
  }
}

function introspect(): Record<string, unknown> {
  const env = { ...process.env } as Record<string, string>;
  const configDir = env.PI_CODING_AGENT_DIR;
  const files: Record<string, string> = {};
  if (configDir) {
    for (const entry of readdirSync(configDir, { withFileTypes: true })) {
      if (entry.isFile()) files[entry.name] = readFileSync(`${configDir}/${entry.name}`, "utf8");
    }
  }
  // The appendix rides a file (the adapter passes its path); reported as its contents, the
  // way pi reads it.
  const at = process.argv.slice(2).indexOf("--append-system-prompt");
  const appendix = at < 0 ? null : readFileSync(process.argv.slice(2)[at + 1], "utf8");
  return {
    args: process.argv.slice(2),
    appendix,
    prompt: promptSeen,
    images: imagesSeen,
    mcpToken: env.MCP_GATEWAY_TOKEN ?? null,
    loopbackToken: env.MCP_LOOPBACK_TOKEN ?? null,
    browserToken: env.MCP_BROWSER_TOKEN ?? null,
    brandVars: Object.keys(env).filter((k) => k.startsWith("RYPH_")),
    files,
  };
}

function onAbort() {
  if (scenario === "abort-noise") {
    // teardown noise instead of a clean settle: a nacked command, then a non-JSON line —
    // the adapter must swallow both and still return { interrupted: true }
    out({ type: "response", command: "abort", success: false, error: "already settling" });
    console.log("flushed mid-teardown: not json");
    process.exit(0);
  }
  out({ type: "response", command: "abort", success: true });
  assistantEnd("stopped where it was coherent", "aborted");
  out({ type: "agent_settled" });
}

// The refs of the tool-images scenario's two images, as the images extension computes them.
const REF_PNG = await refOf("iVBORw0KGgoAAAAN");
const REF_BMP = await refOf("Qk0AAAAA");

const decoder = new TextDecoder();
let buf = "";
for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
  buf += decoder.decode(chunk, { stream: true });
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    if (cmd.type === "prompt" && scenario.startsWith("delayed-")) {
      void delayedPrompt(cmd);
    } else if (cmd.type === "prompt") {
      onPrompt(
        String(cmd.message ?? ""),
        typeof cmd.streamingBehavior === "string" ? cmd.streamingBehavior : undefined,
        Array.isArray(cmd.images) ? cmd.images : [],
        cmd.id,
      );
    } else if (cmd.type === "get_session_stats" && scenario.startsWith("context")) {
      out({
        type: "response",
        command: cmd.type,
        id: cmd.id,
        success: scenario !== "context-unsupported",
        data: { contextUsage: { tokens: 60_000, contextWindow: 200_000, percent: 30 } },
      });
      assistantEnd("Done", "stop");
      out({ type: "agent_settled" });
    } else if (cmd.type === "abort") onAbort();
  }
}

/** An image's ref, as the images extension computes it. */
async function refOf(base64: string): Promise<string> {
  const bytes = Uint8Array.fromBase64(base64);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "img-" + Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

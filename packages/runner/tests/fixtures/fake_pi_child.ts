// A fake pi for the subagent host's tests (adapters/subagents/pi.ts): the RPC protocol's few
// events a subagent's stretch needs, and one thing a real pi does that matters to a stop — its
// bash tool runs a command DETACHED, in a session of its own (measured in ryph-agent:dev), so
// only a kill of the groups below pi reaches it. This fake never kills it itself, even on an
// abort: the stop has to.
//
// A prompt containing "exit" makes it exit before answering; one containing "sleep" starts such
// a command and runs it as a tool call until stopped; any other prompt is answered at once and
// settles. A steer is handed over as a user message and
// answered. What it was started with is written to $FAKE_PI_REPORT; it writes the session file
// pi would, `<timestamp>_<id>.jsonl`. With $FAKE_PI_READY set it prints the ready lines ryph's
// extensions print once loaded. node: built-ins only.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1];
};
const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const report: Record<string, unknown> = {
  argv,
  pid: process.pid,
  cwd: process.cwd(),
  configDir: process.env.PI_CODING_AGENT_DIR ?? null,
  gatewayToken: process.env.MCP_GATEWAY_TOKEN ?? null,
  loopbackToken: process.env.MCP_LOOPBACK_TOKEN ?? null,
};
const configDir = process.env.PI_CODING_AGENT_DIR;
for (const file of ["settings.json", "mcp.json", "appendix.md"]) {
  try {
    report[file] = readFileSync(`${configDir}/${file}`, "utf8");
  } catch {
    report[file] = null;
  }
}
const save = () => {
  if (process.env.FAKE_PI_REPORT) writeFileSync(process.env.FAKE_PI_REPORT, JSON.stringify(report));
};
save();
if (process.env.FAKE_PI_READY) {
  console.error("ryph pi-images: ready — at most 20 images per request");
  if (argv.filter((a) => a === "-e").length > 1) console.error("ryph pi-mcp: ready — 1 tool(s)");
}
const sessionDir = flag("--session-dir");
const sessionId = flag("--session-id");
if (sessionDir && sessionId) writeFileSync(`${sessionDir}/20261012T100000_${sessionId}.jsonl`, "");

const settle = (text: string) => {
  out({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
  });
  out({ type: "agent_end" });
  out({ type: "agent_settled" });
};

let busy = false;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const cmd = JSON.parse(line) as Record<string, unknown>;
  if (cmd.type === "abort") {
    out({ type: "response", command: "abort", id: cmd.id, success: true });
    return; // and does nothing about its tool, on purpose
  }
  if (cmd.type !== "prompt") return;
  const message = String(cmd.message);
  if (cmd.streamingBehavior === "steer" && busy) {
    out({
      type: "response",
      command: "prompt",
      id: cmd.id,
      success: true,
      data: { disposition: "queued" },
    });
    out({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: message }] },
    });
    settle(`steered: ${message}`);
    busy = false;
    return;
  }
  out({
    type: "response",
    command: "prompt",
    id: cmd.id,
    success: true,
    data: { disposition: "started" },
  });
  out({ type: "agent_start" });
  out({
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text: message }] },
  });
  if (message.includes("exit")) process.exit(0);
  if (message.includes("sleep")) {
    busy = true;
    const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    child.unref();
    report.sleepPid = child.pid;
    save();
    out({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "sleep 300" },
    });
    return;
  }
  settle(`answer to: ${message}`);
});
lines.on("close", () => process.exit(0));

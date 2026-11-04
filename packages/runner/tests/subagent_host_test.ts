// The pi subagent host (adapters/subagents/pi.ts) against a fake pi (fixtures/fake_pi_child.ts):
// a session of its own on the checkout root, the team's gateway servers and no loopback, its mode's
// built-ins, a settle as the stretch's end, a steer handed over, and a stop that takes what pi's
// bash started in a session of its own.

import { test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { EXPLORE_TOOLS, piSubagentHost } from "../src/adapters/subagents/pi.ts";
import { DEFAULT_TOOLS } from "../src/adapters/harness/pi.ts";
import { describeMachine } from "../src/helpers/machine.ts";
import { descendantGroups, groupExists } from "../src/adapters/subagents/process_tree.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";
import { runtimeCredentials } from "../src/helpers/runtime_credentials.ts";
import type { SubagentContext, SubagentStretchEvents } from "../src/ports/subagents.ts";
import type { TranscriptChunk } from "../src/core/types.ts";

const FAKE = new URL("./fixtures/fake_pi_child.ts", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "subagent-host-test-"));
  const report = join(dir, "report.json");
  process.env.FAKE_PI_REPORT = report;
  runtimeCredentials.set("RYPH_MCP_TOKEN", "gateway-token-1");
  runtimeCredentials.set("RYPH_LOOPBACK_TOKEN", "loop-token-1");
  const warns: string[] = [];
  const host = piSubagentHost({ kind: "pi" }, {
    diag: { ...noopDiagnostics(), warn: (event) => warns.push(event) },
    command: [process.execPath, "--no-env-file", FAKE],
    makeDir: () => mkdtemp(join(dir, "subagents-")),
    abortWaitMs: 200,
    exitWaitMs: 200,
  });
  const context: SubagentContext = {
    checkoutDir: dir,
    layout: "## The checkout\n\nOne repo.",
    // As the core builds a subagent's: the machine without the run's standing facts.
    machine: describeMachine({
      environment: null,
      checkouts: [],
      probe: { tools: [], egress: false },
      reader: "subagent",
    }),
    serviceHosts: [],
    tools: {
      servers: [
        { slug: "memory", name: "Memory", url: "http://gw.test/v1/mcp/run-1/memory" },
        { slug: "chat", name: "Chat", url: "http://gw.test/v1/mcp/run-1/chat" },
        { slug: "forge", name: "Forge", url: "http://gw.test/v1/mcp/run-1/forge" },
        { slug: "sentry", name: "Sentry", url: "http://gw.test/v1/mcp/run-1/sentry" },
        { slug: "web", name: "Web", url: "http://gw.test/v1/mcp/run-1/web" },
      ],
      tokenEnv: "RYPH_MCP_TOKEN",
    },
  };
  const seen = {
    chunks: [] as TranscriptChunk[],
    delivered: [] as string[],
    settles: 0,
  };
  const events: SubagentStretchEvents = {
    onTranscript: (chunk) => seen.chunks.push(chunk),
    onSteerDelivered: (prompt) => seen.delivered.push(prompt),
    onSettled: () => seen.settles++,
  };
  const readReport = async () => JSON.parse(await readFile(report, "utf8"));
  return {
    warns,
    host,
    context,
    events,
    seen,
    readReport,
    cleanup: async () => {
      await host.close();
      delete process.env.FAKE_PI_REPORT;
      runtimeCredentials.delete("RYPH_MCP_TOKEN");
      runtimeCredentials.delete("RYPH_LOOPBACK_TOKEN");
      await rm(dir, { recursive: true });
    },
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("subagent host: its own session at the checkout root, the gateway's servers only, its mode's built-ins", async () => {
  const { host, context, events, seen, readReport, cleanup } = await setup();
  try {
    assertEquals(await host.hasSession("sa-1"), false);
    const stretch = await host.start(
      { id: "sa-1", mode: "explore", prompt: "where is it?", context },
      events,
    );
    for (let i = 0; i < 200 && seen.settles === 0; i++) await sleep(10);
    assertEquals(seen.settles, 1);
    // A settled stretch is stopped by the core, never left waiting.
    await stretch.stop();
    const end = await stretch.ended;
    assertEquals(end, { answer: "answer to: where is it?", settled: true, error: null });
    assert(seen.chunks.some((c) => c.kind === "assistant"));

    const report = await readReport();
    const argv = report.argv as string[];
    // A session that persists, by id, never --no-session; started where pi looks it up.
    assert(!argv.includes("--no-session"));
    assertEquals(argv[argv.indexOf("--session-id") + 1], "sa-1");
    assert(argv[argv.indexOf("--session-dir") + 1].endsWith("/sessions"));
    assertEquals(report.cwd, await realpath(context.checkoutDir));
    assertEquals(await host.hasSession("sa-1"), true);
    // Depth 1: the team's gateway servers and the platform's web search and fetch, but not chat,
    // forge or memory, which speak for the run; no loopback, no browser, only the gateway token.
    const mcp = JSON.parse(report["mcp.json"]);
    assertEquals(Object.keys(mcp.mcpServers), ["sentry", "web"]);
    assertEquals(report.gatewayToken, "gateway-token-1");
    assertEquals(report.loopbackToken, null);
    // Read-only built-ins, through settings.json and never --tools.
    assertEquals(JSON.parse(report["settings.json"]).defaultTools, [...EXPLORE_TOOLS]);
    assertEquals(JSON.parse(report["settings.json"]).steeringMode, "all");
    assert(!argv.includes("--tools"));
    // The run's layout and machine, and the framing; no identity, no finish.
    const appendix = report["appendix.md"] as string;
    assert(appendix.startsWith("## The checkout"));
    assertStringIncludes(appendix, "## Your machine");
    // Nothing true only of the run: being spoken to, finishing, shipping.
    for (const phrase of ["can be spoken to", "submit a patch", "Before you finish"]) {
      assert(!appendix.includes(phrase), phrase);
    }
    assertStringIncludes(appendix, "## You are a subagent");
    assertStringIncludes(appendix, "your final message is your answer");
    assert(!appendix.includes("ryph__finish"));
    assert(!appendix.includes("an agent run by Ryph"));

    const work = await host.start({ id: "sa-2", mode: "work", prompt: "fix it", context }, events);
    for (let i = 0; i < 200 && seen.settles < 2; i++) await sleep(10);
    await work.stop();
    const worked = await readReport();
    assertEquals(JSON.parse(worked["settings.json"]).defaultTools, [...DEFAULT_TOOLS]);
    assertStringIncludes(worked["appendix.md"], "You share the checkout");
  } finally {
    await cleanup();
  }
});

test("subagent host: a steer is handed over mid-turn; after a settle it is refused", async () => {
  const { host, context, events, seen, cleanup } = await setup();
  try {
    const stretch = await host.start(
      { id: "sa-1", mode: "explore", prompt: "please sleep", context },
      events,
    );
    for (let i = 0; i < 100 && stretch.runningTool() === null; i++) await sleep(10);
    assertEquals(stretch.runningTool(), "bash");
    assert(stretch.steer("look elsewhere"));
    for (let i = 0; i < 100 && seen.settles === 0; i++) await sleep(10);
    assertEquals(seen.delivered, ["look elsewhere"]);
    assertEquals(seen.settles, 1);
    // Settled: what comes now is a continuation's, not this process's.
    assertEquals(stretch.steer("too late"), false);
    await stretch.stop();
    const end = await stretch.ended;
    assertEquals(end.answer, "steered: look elsewhere");
    assert(end.settled);
  } finally {
    await cleanup();
  }
});

test("subagent host: a stop kills what pi's bash started in a session of its own, abort or not", async () => {
  const { host, context, events, readReport, cleanup } = await setup();
  try {
    const stretch = await host.start(
      { id: "sa-1", mode: "work", prompt: "please sleep", context },
      events,
    );
    let pid: number | undefined;
    for (let i = 0; i < 200 && pid === undefined; i++) {
      await sleep(10);
      pid = (await readReport().catch(() => ({}))).sleepPid;
    }
    assert(pid !== undefined, "the fake started its command");
    assert(alive(pid));
    // Its own group, not pi's: a kill of pi's group alone would leave it running.
    const groups = await descendantGroups(process.pid);
    assert(groups.includes(pid), `the command leads a group of its own: ${groups}`);

    await stretch.stop();
    const end = await stretch.ended;
    assertEquals(end.settled, false);
    for (let i = 0; i < 100 && alive(pid); i++) await sleep(10);
    assert(!alive(pid), "the detached command is gone with the stretch");
  } finally {
    await cleanup();
  }
});

test("subagent host: a pi that exited and was reaped is not killed by its group id again", async () => {
  const { host, context, events, readReport, cleanup } = await setup();
  const kills: number[] = [];
  const kill = process.kill;
  process.kill = ((pid: number, signal?: string | number) => {
    if (signal === "SIGKILL") kills.push(pid);
    return kill.call(process, pid, signal);
  }) as typeof process.kill;
  try {
    const stretch = await host.start(
      { id: "sa-1", mode: "explore", prompt: "please exit", context },
      events,
    );
    const end = await stretch.ended;
    assertEquals(end.settled, false);
    const { pid } = await readReport();
    // Its group is empty once it is reaped, and its id free for another process of the run.
    assert(!groupExists(pid));
    assertEquals(kills.filter((k) => k === -pid), []);
  } finally {
    process.kill = kill;
    await cleanup();
  }
});

test("subagent host: a stretch that worked a turn without its extensions' ready lines is warned of", async () => {
  const { host, context, events, seen, warns, cleanup } = await setup();
  try {
    const silent = await host.start({ id: "sa-1", mode: "explore", prompt: "hi", context }, events);
    for (let i = 0; i < 200 && seen.settles < 1; i++) await sleep(10);
    await silent.stop();
    await silent.ended;
    assertEquals(warns.filter((w) => w.endsWith("_extension.silent")).sort(), [
      "subagent.images_extension.silent",
      "subagent.mcp_extension.silent",
    ]);
    // One whose extensions said they were ready: nothing to warn of.
    warns.length = 0;
    process.env.FAKE_PI_READY = "1";
    const ready = await host.start({ id: "sa-2", mode: "explore", prompt: "hi", context }, events);
    for (let i = 0; i < 200 && seen.settles < 2; i++) await sleep(10);
    await ready.stop();
    await ready.ended;
    assertEquals(warns.filter((w) => w.endsWith("_extension.silent")), []);
  } finally {
    delete process.env.FAKE_PI_READY;
    await cleanup();
  }
});

test("process tree: a group is known only while a process of ours is in it", async () => {
  const { command } = await import("@ryph/process");
  const proc = await command("sleep", { args: ["30"], detached: true, stdin: "null" }).spawn();
  assert(groupExists(proc.pid));
  process.kill(-proc.pid, "SIGKILL");
  await proc.status;
  assert(!groupExists(proc.pid), "a group nobody is in any more is never killed");
  assert(!groupExists(1) && !groupExists(0));
});

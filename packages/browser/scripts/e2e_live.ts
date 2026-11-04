// The browser's live path end to end, on this machine, with every seam real:
//
//   page server ("agent" container, owns the netns, serves localhost:5173)
//        ▲ localhost
//   ryph-browser sidecar  ── launched with the docker provisioner's own `browserArgs`
//        │ /configure, /mcp, /live
//   runner bring-up + relay ── `startBrowserSidecar` from @ryph/runner, unmodified
//        │ POST /v1/runs/:id/live (NDJSON, run token)
//   historian live routes  ── `historianRoutes` from @ryph/historian, in this process
//        │ GET /v1/runs/:id/live/stream (SSE)
//   an SSE consumer here, counting what arrives and how late
//
// The only stand-ins are the two gates the host owns (the run-token check accepts one token, the
// read gate lets every reader in) and the agent itself: this script calls the MCP tools the way
// pi would, with the bearer the runner minted.
//
// Run (docker up, `ryph-browser:dev` built from images/browser):
//
//   bun packages/browser/scripts/e2e_live.ts            # scripted pass, prints a report
//   bun packages/browser/scripts/e2e_live.ts --watch    # keeps going until Ctrl-C
//   bun packages/browser/scripts/e2e_live.ts --soak 600 # the loop, flat out, measured
//
// The sidecar listens on loopback only, which the real runner — inside the namespace — dials
// directly. This script is outside it, so the agent container carries a small TCP relay
// (0.0.0.0:7491 → 127.0.0.1:7490) and publishes that to this host's loopback instead.
//
// `--soak <n>` runs the watch loop n times with no pauses and prints, every 50 iterations, the
// tool calls' latency, the browser container's memory and CPU, and its process count: a slow
// leak in a long-lived sidecar shows as a trend there, a stall as an outlier.
//
// The scripted pass restarts the historian halfway (fresh live rooms, every uplink and stream
// cut, as a redeploy does): the relay reconnects, the sidecar replays what it kept, and the
// viewer — reconnected, folding the stream the way the app's pane does — must end with every
// console line and request from before the restart, each once.
//
// `--watch` prints a URL for the app's dev page (/dev/browser?live=…), which then shows the real
// stream in the browser pane; it repeats a short click-and-type loop every few seconds rather than
// animating anything, so it screencasts in bursts and idles in between. Either way the two
// containers are removed on the way out (Ctrl-C included). Flags: --image <ref>, --port <n> for
// the historian (default 7497), --app <origin> for the printed URL (default http://localhost:5174).

import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "@std/cli/parse-args";
import { historianRoutes, makeHistorianService, memoryHistoryBus } from "@ryph/historian";
import type { HistoryStore } from "@ryph/historian";
import { serve } from "@ryph/service";
import { startBrowserSidecar } from "../../runner/src/adapters/browser/sidecar.ts";
import { browserArgs } from "../../orchestrator/src/adapters/provisioner/docker.ts";

const args = parseArgs(process.argv.slice(2), {
  string: ["image", "port", "app", "soak"],
  boolean: ["watch"],
  default: { image: "ryph-browser:dev", port: "7497", app: "http://localhost:5174" },
});
const IMAGE = args.image;
const RUN_ID = `e2e-${crypto.randomUUID().slice(0, 8)}`;
const RUN_TOKEN = crypto.randomUUID();
const SIDECAR_TOKEN = crypto.randomUUID().replaceAll("-", "");
const AGENT = `ryph-e2e-agent-${RUN_ID}`;
const BROWSER_PORT = 7490;
/** The relay in the agent container that stands in for the runner's loopback view. */
const RELAY_PORT = 7491;

// ---- the page the agent's dev server would serve -------------------------------------------

const PAGE_SERVER = `
const PAGE = \`<!doctype html><html><head><title>Greeter</title>
<style>body{font:18px system-ui;margin:40px;background:#fafaf9}h1{color:#15803d}</style></head>
<body><h1 id="out">Hello</h1>
<label>Name <input id="name"></label> <button id="greet" onclick="greet()">Greet</button>
<p><a href="/second">Second page</a></p>
<script>
function greet() {
  const name = document.getElementById('name').value;
  console.log('greeting ' + name);
  fetch('/api/greet?name=' + encodeURIComponent(name)).then(r => r.json())
    .then(j => { document.getElementById('out').textContent = j.message; });
}
console.warn('greeter booted');
</script></body></html>\`;
import { createServer as tcpServer, connect } from "node:net";
import { createServer } from "node:http";
// The host's way in to the sidecar, which listens on the namespace's loopback only.
tcpServer((conn) => {
  const up = connect({ host: "127.0.0.1", port: ${BROWSER_PORT} });
  up.on("error", () => conn.destroy());
  conn.on("error", () => up.destroy());
  conn.pipe(up).pipe(conn);
}).listen(${RELAY_PORT}, "0.0.0.0");
createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/greet") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Hi, " + url.searchParams.get("name") + "!" }));
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  if (url.pathname === "/second") {
    res.end("<title>Second</title><h2>Second page</h2><script>console.error('second page error')</script>");
    return;
  }
  res.end(PAGE);
}).listen(5173, "0.0.0.0");
`;

// ---- docker -----------------------------------------------------------------------------------

async function docker(argv: string[]): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)("docker", argv, { maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err);
    throw new Error(`docker ${argv[0]}: ${stderr.trim()}`);
  }
}

const started: string[] = [];
const pageDir = await mkdtemp(join(tmpdir(), "ryph-e2e-"));
const pageFile = join(pageDir, "page.ts");
async function cleanup() {
  for (const name of started.reverse()) await docker(["rm", "-f", name]).catch(() => {});
  started.length = 0;
  await rm(pageDir, { recursive: true }).catch(() => {});
}

// ---- the historian, in this process -----------------------------------------------------------

// The live routes never touch the store; a store that refuses everything proves it.
const noStore = new Proxy({}, {
  get: () => () => Promise.reject(new Error("the live path reached the history store")),
}) as HistoryStore;
/** One historian process's worth of live state; `restartHistorian` starts a fresh one. */
function historianProcess() {
  return {
    ...historianRoutes({
      service: makeHistorianService({ store: noStore, bus: memoryHistoryBus() }),
      authenticateRun: (req, runId) =>
        Promise.resolve(
          runId === RUN_ID && req.headers.get("authorization") === `Bearer ${RUN_TOKEN}`,
        ),
      authenticateRunRead: () => Promise.resolve(null),
      isRunTerminal: () => Promise.resolve(false),
      diag: { debug: (event, fields) => log("historian", event, fields) },
    }),
    /** Ends every uplink body and stream this process is serving, as its exit would. */
    cuts: new Set<() => void>(),
  };
}
let serving = historianProcess();
const concludeRun = (runId: string) => serving.concludeRun(runId);

/** A body that `cut` ends, as the connection dropping would. */
function cuttable(
  body: ReadableStream<Uint8Array>,
  cuts: Set<() => void>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let cut = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      cut = () => {
        cuts.delete(cut);
        reader.cancel().catch(() => {});
        try {
          controller.close();
        } catch {
          // already ended
        }
      };
      cuts.add(cut);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cuts.delete(cut);
          controller.close();
        } else controller.enqueue(value);
      } catch {
        cuts.delete(cut);
        try {
          controller.close();
        } catch {
          // already ended
        }
      }
    },
    cancel: () => {
      cuts.delete(cut);
      return reader.cancel();
    },
  });
}

function restartHistorian() {
  const old = serving;
  serving = historianProcess();
  for (const cut of [...old.cuts]) cut();
}

const historian = await serve(
  { hostname: "127.0.0.1", port: Number(args.port), onListen: () => {} },
  async (incoming) => {
    const url = new URL(incoming.url);
    const current = serving;
    const req = incoming.body === null ? incoming : new Request(incoming.url, {
      method: incoming.method,
      headers: incoming.headers,
      body: cuttable(incoming.body, current.cuts),
      duplex: "half",
    } as RequestInit);
    // The app's dev page reads the stream straight from here, cross-origin.
    const cors = { "access-control-allow-origin": "*" };
    for (const route of current.routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(url);
      if (!match) continue;
      const res = await route.handler(req, match.pathname.groups as Record<string, string>);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      const body = res.body === null ? null : cuttable(res.body, current.cuts);
      return new Response(body, { status: res.status, headers });
    }
    return new Response("no route", { status: 404, headers: cors });
  },
);
const HISTORY_URL = `http://127.0.0.1:${historian.addr.port}`;
const STREAM_URL = `${HISTORY_URL}/v1/runs/${RUN_ID}/live/stream`;

const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
function log(who: string, event: string, fields?: Record<string, unknown>) {
  console.log(`${String(ms()).padStart(6)} ms  ${who.padEnd(9)} ${event}`, fields ?? "");
}

// ---- the SSE consumer -------------------------------------------------------------------------

interface Tally {
  snapshots: number;
  frames: number;
  frameBytes: number;
  frameLagMs: number[];
  console: string[];
  network: string[];
  actions: Array<{ tool: string; summary: string; receivedAt: number; target: boolean }>;
  status: string[];
  tabs: number;
  uplink: boolean[];
  other: string[];
  lastFrame: Record<string, unknown> | null;
  doneAt: number | null;
  reconnects: number;
}

/** The viewer's lists as the app's pane folds them: a snapshot replaces, a line appends. Keyed
 * with the line's time, so a line shown twice is a duplicate and not a page that logged twice. */
const view = { console: [] as string[], network: [] as string[], uplink: false };
const consoleKey = (d: Record<string, unknown>) => `${d.at} ${d.level}: ${d.text}`;
const networkKey = (d: Record<string, unknown>) =>
  `${d.at} ${d.method} ${d.status ?? d.failure} ${d.url}`;
const tally: Tally = {
  snapshots: 0,
  frames: 0,
  frameBytes: 0,
  frameLagMs: [],
  console: [],
  network: [],
  actions: [],
  status: [],
  tabs: 0,
  uplink: [],
  other: [],
  lastFrame: null,
  doneAt: null,
  reconnects: 0,
};

const viewer = new AbortController();
/** Reads the stream, reopening it (as EventSource does) when it drops before `done`. */
async function consume() {
  while (!viewer.signal.aborted && tally.doneAt === null) {
    try {
      await consumeOnce();
    } catch (err) {
      if (viewer.signal.aborted) return;
      log("viewer", "stream dropped", { err: String(err) });
    }
    if (tally.doneAt !== null || viewer.signal.aborted) return;
    tally.reconnects++;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function consumeOnce() {
  const res = await fetch(STREAM_URL, { signal: viewer.signal });
  if (!res.ok || res.body === null) throw new Error(`stream answered ${res.status}`);
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let name = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) name = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data === "") continue;
      onSse(name, JSON.parse(data), data.length);
    }
  }
}

function onSse(name: string, data: Record<string, unknown>, bytes: number) {
  const now = Date.now();
  switch (name) {
    case "snapshot":
      tally.snapshots++;
      view.console = (data.console as Record<string, unknown>[]).map(consoleKey);
      view.network = (data.network as Record<string, unknown>[]).map(networkKey);
      view.uplink = data.uplink as boolean;
      log("viewer", "snapshot", {
        uplink: data.uplink,
        status: data.status,
        console: view.console.length,
        network: view.network.length,
      });
      break;
    case "frame":
      tally.frames++;
      tally.frameBytes += bytes;
      {
        const { data: _jpeg, ...dims } = data.frame as Record<string, unknown>;
        tally.lastFrame = dims;
      }
      tally.frameLagMs.push(now - (data.at as number));
      break;
    case "console":
      tally.console.push(`${data.level}: ${data.text}`);
      view.console.push(consoleKey(data));
      break;
    case "network":
      tally.network.push(`${data.method} ${data.status ?? data.failure} ${data.url}`);
      view.network.push(networkKey(data));
      break;
    case "action":
      tally.actions.push({
        tool: data.tool as string,
        summary: data.summary as string,
        receivedAt: now,
        target: data.target !== undefined,
      });
      break;
    case "status":
      tally.status.push(data.status as string);
      break;
    case "tabs":
      tally.tabs++;
      break;
    case "uplink":
      tally.uplink.push(data.connected as boolean);
      view.uplink = data.connected as boolean;
      log("viewer", "uplink", data);
      break;
    case "done":
      tally.doneAt = now;
      log("viewer", "done");
      break;
    default:
      tally.other.push(name);
  }
}

// ---- the agent's side: MCP over the runner's bearer -------------------------------------------

let mcpUrl = "";
let rpcId = 0;
const callSentAt: Array<{ tool: string; at: number }> = [];
/** Every call's round trip, for --soak. */
const callMs: Array<{ tool: string; ms: number }> = [];
async function tool(name: string, input: Record<string, unknown> = {}): Promise<string> {
  callSentAt.push({ tool: name, at: Date.now() });
  const sent = performance.now();
  try {
    return await callTool(name, input);
  } finally {
    const ms = Math.round(performance.now() - sent);
    callMs.push({ tool: name, ms });
    if (ms > 3000) log("agent", "slow call", { tool: name, ms });
  }
}

async function callTool(name: string, input: Record<string, unknown>): Promise<string> {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SIDECAR_TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "tools/call",
      params: { name, arguments: input },
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${name}: ${body.error.message}`);
  const text = (body.result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (body.result.isError) throw new Error(`${name}: ${text}`);
  return text;
}

function refOf(report: string, pattern: RegExp): string {
  const line = report.split("\n").find((l) => pattern.test(l));
  const ref = line?.match(/\[ref=([a-z0-9]+)\]/)?.[1];
  if (!ref) throw new Error(`no ref for ${pattern} in:\n${report}`);
  return ref;
}

const NAMES = ["Ada", "Grace", "Alan", "Edsger", "Barbara"];

/** One pass of the watch loop: greet someone, and every third pass visit the second page. */
async function iteration(i: number) {
  await greet(NAMES[i % NAMES.length]);
  if (i % 3 === 2) {
    await tool("navigate", { url: "localhost:5173/second" });
    await tool("console_messages");
  }
}

/** An error in a few lines: the platform's line and the first of the page's, no notice or fence. */
function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")
    .filter((l) => l.trim() !== "" && !l.startsWith("Untrusted page content") && !/^`{3,}$/.test(l))
    .slice(0, 4).join(" | ");
}

async function greet(name: string) {
  const page = await tool("navigate", { url: "localhost:5173" });
  await tool("type", { ref: refOf(page, /textbox "Name"/), element: "Name", text: name });
  await tool("click", { ref: refOf(page, /button "Greet"/), element: "Greet" });
  await tool("wait_for", { text: `Hi, ${name}!` });
}

// ---- the run --------------------------------------------------------------------------------

const pause = (n: number) => new Promise((r) => setTimeout(r, n));
let sidecar: ReturnType<typeof startBrowserSidecar> | null = null;
let stopping = false;
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  concludeRun(RUN_ID);
  await sidecar?.stop();
  viewer.abort();
  await cleanup();
  await historian.shutdown();
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(130));

try {
  // The "agent" container: owns the network namespace, serves the dev page, and publishes the
  // browser's loopback port to this host's loopback (the runner's view of 127.0.0.1:7490).
  await writeFile(pageFile, PAGE_SERVER);
  await chmod(pageFile, 0o644);
  await docker([
    "run",
    "-d",
    "--name",
    AGENT,
    "--user",
    "1994:1994",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-v",
    `${pageFile}:/page.ts:ro`,
    "-p",
    `127.0.0.1::${RELAY_PORT}`,
    "--entrypoint",
    "bun",
    IMAGE,
    "--no-env-file",
    "/page.ts",
  ]);
  started.push(AGENT);
  const published = await docker(["port", AGENT, `${RELAY_PORT}/tcp`]);
  const hostPort = Number(published.split("\n")[0].split(":").pop());
  log("docker", "agent up", { name: AGENT, browserPortOnHost: hostPort });

  // The sidecar, exactly as the docker provisioner launches it.
  const launch = browserArgs(RUN_ID, AGENT, {
    image: IMAGE,
    port: BROWSER_PORT,
    resources: { cpu: "1", memory: "1536Mi" },
  }, {});
  await docker(launch);
  const browserName = launch[launch.indexOf("--name") + 1];
  started.push(browserName);
  log("docker", "browser up", { args: launch.slice(1).join(" ") });

  // The viewer first, so it sees the uplink arrive.
  consume().catch((err) => {
    if (!viewer.signal.aborted) log("viewer", "failed", { err: String(err) });
  });

  // Docker's published port (and the relay behind it) accepts a connection before anything
  // listens behind it, which a runner inside the namespace never sees (it gets a refusal until
  // the sidecar is up). So the runner's own TCP wait would pass at once here; wait for an HTTP
  // answer first instead.
  for (let i = 0;; i++) {
    const up = await fetch(`http://127.0.0.1:${hostPort}/healthz`).then(
      (r) => r.body?.cancel().then(() => r.ok),
      () => false,
    );
    if (up) break;
    if (i > 240) throw new Error("the browser container never answered /healthz");
    await pause(250);
  }
  log("docker", "browser answers /healthz");

  // The runner's bring-up: wait for the port, configure, start the relay.
  sidecar = startBrowserSidecar({
    port: hostPort,
    token: SIDECAR_TOKEN,
    tokenEnv: "RYPH_BROWSER_TOKEN",
    proxy: null,
    live: { historyUrl: HISTORY_URL, runToken: RUN_TOKEN, runId: RUN_ID },
    signal: new AbortController().signal,
    diag: {
      debug: (event, fields) => log("runner", event, fields),
      warn: (event, fields) => log("runner", `WARN ${event}`, fields),
    },
  });
  const state = await sidecar.ready;
  log("runner", "browser state", state);
  if (state.kind !== "ready") throw new Error("the browser never came up");
  mcpUrl = state.tools.url;

  if (args.watch) {
    console.log(
      `\nWatch it in the app's browser pane (dev server, signed in):\n\n  ${args.app}` +
        `/dev/browser?live=${encodeURIComponent(STREAM_URL)}\n\nCtrl-C to stop.\n`,
    );
    for (let i = 0;; i++) {
      // One bad iteration is a finding to read, not a reason to stop watching.
      await iteration(i).catch((err) =>
        log("agent", "iteration failed", { i, err: firstLine(err) })
      );
      await pause(4000);
    }
  }

  if (args.soak !== undefined) {
    const total = Number(args.soak);
    let failures = 0;
    console.log(
      "\n  iter   calls  p50 ms  p99 ms  max ms  failed  memory              cpu     procs",
    );
    let window = 0;
    for (let i = 0; i < total; i++) {
      await iteration(i).catch((err) => {
        failures++;
        log("agent", "iteration failed", { i, err: firstLine(err) });
      });
      if ((i + 1) % 50 === 0 || i === total - 1) {
        const calls = callMs.slice(window).map((c) => c.ms).toSorted((a, b) => a - b);
        window = callMs.length;
        const at = (p: number) => calls[Math.min(calls.length - 1, Math.floor(p * calls.length))];
        const stats = await docker([
          "stats",
          "--no-stream",
          "--format",
          "{{.MemUsage}}\t{{.CPUPerc}}",
          browserName,
        ]);
        const procs = (await docker(["top", browserName])).split("\n").length - 1;
        const [mem, cpu] = stats.split("\t");
        console.log(
          `  ${String(i + 1).padStart(4)}  ${String(calls.length).padStart(6)}  ${
            String(at(0.5)).padStart(6)
          }  ${String(at(0.99)).padStart(6)}  ${String(calls.at(-1)).padStart(6)}  ${
            String(failures).padStart(6)
          }  ${mem.padEnd(18)}  ${cpu.padEnd(6)}  ${procs}`,
        );
      }
    }
    await shutdown(failures === 0 ? 0 : 1);
  }

  const tStart = Date.now();
  await greet("Ada Lovelace");
  await tool("navigate", { url: "localhost:5173/second" });
  await pause(500); // the relay's flush

  // A historian redeploy, mid-run: its rooms are gone and every connection to it drops.
  const before = { console: [...view.console], network: [...view.network] };
  log("e2e", "restarting the historian", {
    console: before.console.length,
    network: before.network.length,
  });
  const snapshotsBefore = tally.snapshots;
  restartHistorian();
  // The viewer reopens on its own; the relay backs off a second before it reconnects.
  for (
    let i = 0;
    // The reopened stream's snapshot (no uplink yet), then the relay's (connected, empty).
    !(tally.snapshots >= snapshotsBefore + 2 && view.uplink &&
      view.console.length >= before.console.length);
    i++
  ) {
    if (i > 100) throw new Error("the relay never came back after the restart");
    await pause(100);
  }
  const restored = { console: [...view.console], network: [...view.network] };
  log("e2e", "relay back", { console: restored.console.length, network: restored.network.length });

  await tool("back");
  await tool("scroll", { deltaY: 300 });
  await tool("console_messages");
  const tEnd = Date.now();
  await pause(1500); // the last burst's trailing frame, and the relay's flush

  // The run concludes: viewers are told `done`, the uplink is hung up, and the relay's next
  // attempt is answered 410 and stops for good.
  const concludedAt = Date.now();
  concludeRun(RUN_ID);
  await pause(2500);

  const lags = tally.frameLagMs.toSorted((a, b) => a - b);
  const pct = (p: number) => lags[Math.min(lags.length - 1, Math.floor(p * lags.length))];
  // Each tool call against the first matching action that arrived after it was sent.
  const used = new Set<number>();
  const actionLag = callSentAt.flatMap((call) => {
    const i = tally.actions.findIndex((a, j) =>
      !used.has(j) && a.tool.endsWith(call.tool) && a.receivedAt >= call.at
    );
    if (i < 0) return [];
    used.add(i);
    return [tally.actions[i].receivedAt - call.at];
  });
  console.log("\n==== what reached the SSE consumer ====");
  console.log({
    toolCalls: callSentAt.length,
    scriptedSeconds: (tEnd - tStart) / 1000,
    snapshots: tally.snapshots,
    frames: tally.frames,
    avgFrameKB: tally.frames ? Math.round(tally.frameBytes / tally.frames / 1024 * 10) / 10 : 0,
    frameLagMs: lags.length ? { p50: pct(0.5), p90: pct(0.9), max: lags.at(-1) } : null,
    actions: tally.actions.map((a) => `${a.tool}: ${a.summary}${a.target ? " [target]" : ""}`),
    actionLagMs: actionLag,
    console: tally.console,
    network: tally.network,
    lastFrame: tally.lastFrame,
    status: tally.status,
    doneAfterConcludeMs: tally.doneAt === null ? null : tally.doneAt - concludedAt,
    tabsEvents: tally.tabs,
    uplink: tally.uplink,
    viewerReconnects: tally.reconnects,
    other: tally.other,
  });
  const once = (list: string[]) => new Set(list).size === list.length;
  const survived = (was: string[], now: string[]) => was.every((key) => now.includes(key));
  const restart = {
    restoredAsBefore: JSON.stringify(restored) === JSON.stringify(before),
    consoleSurvived: survived(before.console, view.console),
    networkSurvived: survived(before.network, view.network),
    noDuplicates: once(view.console) && once(view.network),
    grewAfter: view.console.length > before.console.length,
  };
  console.log("\n==== across the historian restart ====");
  console.log({ before, final: { console: view.console, network: view.network }, ...restart });
  const ok = tally.frames > 0 && tally.actions.length >= callSentAt.length &&
    tally.doneAt !== null &&
    tally.console.length > 0 && tally.network.length > 0 &&
    tally.reconnects > 0 && Object.values(restart).every(Boolean);
  console.log(ok ? "\nPASS" : "\nFAIL: something did not arrive");
  await shutdown(ok ? 0 : 1);
} catch (err) {
  console.error(err);
  await shutdown(1);
}

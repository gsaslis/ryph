// The browser sidecar from the runner's side, against fakes that speak its HTTP surface and the
// historian's live uplink over real sockets: the wait, the one-shot configure, the relay and its
// reconnects, and that none of it can fail or hold up a run.

import { test } from "bun:test";
import { type AddressInfo, createServer } from "node:net";
import { serve } from "@ryph/service";
import { assert, assertEquals } from "@std/assert";
import { startBrowserSidecar } from "../src/adapters/browser/sidecar.ts";
import { startLiveRelay } from "../src/adapters/browser/relay.ts";
import type { Diagnostics } from "../src/ports/diagnostics.ts";

function recordingDiag() {
  const events: Array<{ level: "debug" | "warn"; event: string; fields?: unknown }> = [];
  const diag: Diagnostics = {
    debug: (event, fields) => events.push({ level: "debug", event, fields }),
    warn: (event, fields) => events.push({ level: "warn", event, fields }),
  };
  return { diag, events };
}

/** Polls until `check` holds, or fails the test naming `what`. */
async function until(what: string, check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const encoder = new TextEncoder();

/**
 * A sidecar that speaks the contract: one-shot `/configure`, bearer-gated `/live` that opens with
 * a snapshot line and then sends whatever the test pushes, a new consumer replacing the old.
 */
async function fakeSidecar(opts: { configureStatus?: number } = {}) {
  const configures: unknown[] = [];
  let token: string | null = null;
  let consumer: ReadableStreamDefaultController<Uint8Array> | null = null;
  const liveAuth: Array<string | null> = [];
  let connections = 0;
  let stale503 = 0;
  const server = await serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/configure") {
      const body = await req.json();
      configures.push(body);
      if (opts.configureStatus) return new Response("no", { status: opts.configureStatus });
      if (token !== null) return new Response("configured", { status: 409 });
      token = (body as { token: string }).token;
      return new Response("ok");
    }
    if (url.pathname === "/live") {
      liveAuth.push(req.headers.get("authorization"));
      if (token === null || stale503 > 0) {
        stale503 = Math.max(0, stale503 - 1);
        return new Response("not configured", { status: 503 });
      }
      if (req.headers.get("authorization") !== `Bearer ${token}`) {
        return new Response("no", { status: 401 });
      }
      connections++;
      // A new consumer replaces the old one.
      try {
        consumer?.close();
      } catch { /* already gone */ }
      const n = connections;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          consumer = controller;
          controller.enqueue(
            encoder.encode(JSON.stringify({ type: "snapshot", at: n, status: "idle" }) + "\n"),
          );
        },
        cancel() {
          if (consumer !== null) consumer = null;
        },
      });
      return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
    }
    return new Response("not found", { status: 404 });
  });
  return {
    port: server.addr.port,
    configures,
    liveAuth,
    connections: () => connections,
    push(event: Record<string, unknown>) {
      consumer?.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
    },
    /** A restart (an OOM kill): the stream ends and the new process has forgotten its token,
     * so /live answers 503 until /configure is called again — which, one-shot per process, it
     * takes. */
    restart() {
      token = null;
      try {
        consumer?.close();
      } catch { /* already gone */ }
      consumer = null;
    },
    /** A restart the runner's re-send raced: the stream ends and one /live answers 503, but by
     * the time /configure is re-sent the new process is configured already (409). */
    restartAlreadyReconfigured() {
      stale503 = 1;
      try {
        consumer?.close();
      } catch { /* already gone */ }
      consumer = null;
    },
    /** Ends the current live stream, as a sidecar restart would. */
    endLive() {
      try {
        consumer?.close();
      } catch { /* already gone */ }
      consumer = null;
    },
    shutdown: () => server.shutdown(),
  };
}

/** A historian's live uplink: records every line per uplink, answers when the body ends. */
async function fakeHistorian(opts: { status?: (uplink: number) => number | null } = {}) {
  const uplinks: Array<{ auth: string | null; path: string; lines: string[]; done: boolean }> = [];
  const server = await serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const n = uplinks.length;
    const early = opts.status?.(n) ?? null;
    const uplink = {
      auth: req.headers.get("authorization"),
      path: new URL(req.url).pathname,
      lines: [] as string[],
      done: false,
    };
    uplinks.push(uplink);
    // A refusal answers at once; anything else is read to the end, as the contract has it.
    if (early !== null) {
      await req.body?.cancel();
      return new Response("", { status: early });
    }
    let buffered = "";
    try {
      for await (const chunk of req.body!.pipeThrough(new TextDecoderStream())) {
        buffered += chunk;
        let nl;
        while ((nl = buffered.indexOf("\n")) >= 0) {
          uplink.lines.push(buffered.slice(0, nl));
          buffered = buffered.slice(nl + 1);
        }
      }
    } catch {
      // the runner went away mid-body
    }
    uplink.done = true;
    return Response.json({ accepted: uplink.lines.length, malformed: 0, oversize: 0 });
  });
  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    uplinks,
    shutdown: () => server.shutdown(),
  };
}

const FAST = { backoff: { baseMs: 20, capMs: 80 }, healthyMs: 60_000 };

test("browser: waits for the port, configures once, answers ready, relays live, stops clean", async () => {
  const sidecar = await fakeSidecar();
  const historian = await fakeHistorian();
  const { diag, events } = recordingDiag();
  const cancel = new AbortController();
  const session = startBrowserSidecar({
    port: sidecar.port,
    token: "tok-1",
    tokenEnv: "RYPH_BROWSER_TOKEN",
    proxy: { server: "http://egress:3128", username: "run-1", password: "claim", bypass: "a,b" },
    live: { historyUrl: `${historian.url}/`, runToken: "run-token", runId: "run-1" },
    signal: cancel.signal,
    diag,
    relay: FAST,
  });
  try {
    const state = await session.ready;
    assertEquals(state, {
      kind: "ready",
      tools: { url: `http://127.0.0.1:${sidecar.port}/mcp`, tokenEnv: "RYPH_BROWSER_TOKEN" },
    });
    // What the sidecar was handed: its bearer, the egress pair, and whether the model can see
    // a screenshot (true unless the runner says otherwise) — nothing else.
    assertEquals(sidecar.configures, [{
      token: "tok-1",
      proxy: { server: "http://egress:3128", username: "run-1", password: "claim", bypass: "a,b" },
      vision: true,
    }]);
    // The relay: the sidecar's bearer on the sidecar, the run token on the historian, and the
    // lines carried verbatim, snapshot first.
    await until("the snapshot to land", () => historian.uplinks[0]?.lines.length === 1);
    sidecar.push({ type: "console", at: 2, tabId: "t1", level: "error", text: "boom" });
    await until("the console line to land", () => historian.uplinks[0].lines.length === 2);
    assertEquals(sidecar.liveAuth, ["Bearer tok-1"]);
    assertEquals(historian.uplinks[0].auth, "Bearer run-token");
    assertEquals(historian.uplinks[0].path, "/v1/runs/run-1/live");
    assertEquals(JSON.parse(historian.uplinks[0].lines[1]).text, "boom");
    assert(events.some((e) => e.event === "browser.ready"));
  } finally {
    await session.stop();
    // Stopping ends the uplink's body: the historian sees it finish.
    await until("the uplink to end", () => historian.uplinks.every((u) => u.done));
    await sidecar.shutdown();
    await historian.shutdown();
  }
});

test("browser: a port that opens late is waited for; one that never opens fails in bounded time", async () => {
  // Late: grab a free port, open it only after a beat.
  const port = await freePort();
  const { diag } = recordingDiag();
  const late = startBrowserSidecar({
    port,
    token: "t",
    tokenEnv: "RYPH_BROWSER_TOKEN",
    proxy: null,
    live: null,
    signal: new AbortController().signal,
    diag,
    probeIntervalMs: 20,
    waitMs: 5_000,
  });
  await new Promise((r) => setTimeout(r, 150));
  const server = await serve(
    { hostname: "127.0.0.1", port, onListen() {} },
    () => new Response("ok"),
  );
  try {
    assertEquals((await late.ready).kind, "ready");
  } finally {
    await late.stop();
    await server.shutdown();
  }

  // Never: failed, with the reason, after the wait and not much later.
  const { diag: diag2, events } = recordingDiag();
  const started = Date.now();
  const never = startBrowserSidecar({
    port,
    token: "t",
    tokenEnv: "RYPH_BROWSER_TOKEN",
    proxy: null,
    live: null,
    signal: new AbortController().signal,
    diag: diag2,
    probeIntervalMs: 20,
    waitMs: 300,
  });
  const state = await never.ready;
  assertEquals(state.kind, "failed");
  assert(state.kind === "failed" && state.reason.includes("did not answer"), JSON.stringify(state));
  assert(Date.now() - started < 3_000, "the wait is bounded");
  assert(events.some((e) => e.level === "warn" && e.event === "browser.failed"));
  await never.stop();
});

test("browser: a model that cannot see images configures the sidecar with vision off", async () => {
  const sidecar = await fakeSidecar();
  const cancel = new AbortController();
  const session = startBrowserSidecar({
    port: sidecar.port,
    token: "tok-1",
    tokenEnv: "RYPH_BROWSER_TOKEN",
    proxy: null,
    vision: false,
    live: null,
    signal: cancel.signal,
    diag: recordingDiag().diag,
  });
  try {
    assertEquals((await session.ready).kind, "ready");
    assertEquals(sidecar.configures, [{ token: "tok-1", proxy: null, vision: false }]);
  } finally {
    await session.stop();
    await sidecar.shutdown();
  }
});

test("browser: a refused configure is a run without a browser, never a throw", async () => {
  const sidecar = await fakeSidecar({ configureStatus: 400 });
  const { diag } = recordingDiag();
  const session = startBrowserSidecar({
    port: sidecar.port,
    token: "t",
    tokenEnv: "RYPH_BROWSER_TOKEN",
    proxy: null,
    live: { historyUrl: "http://127.0.0.1:1", runToken: "r", runId: "run-1" },
    signal: new AbortController().signal,
    diag,
  });
  try {
    const state = await session.ready;
    assertEquals(state.kind, "failed");
    assert(state.kind === "failed" && state.reason.includes("400"));
    // And no relay was started for a browser that would not take its configuration.
    assertEquals(sidecar.liveAuth, []);
  } finally {
    await session.stop();
    await sidecar.shutdown();
  }
});

test("browser: a 409 on the FIRST configure is another process's browser — failed, said why", async () => {
  const sidecar = await fakeSidecar({ configureStatus: 409 });
  const { diag, events } = recordingDiag();
  const session = startBrowserSidecar({
    port: sidecar.port,
    token: "t",
    tokenEnv: "RYPH_BROWSER_TOKEN",
    proxy: null,
    live: null,
    signal: new AbortController().signal,
    diag,
  });
  try {
    const state = await session.ready;
    assertEquals(state.kind, "failed");
    assert(state.kind === "failed" && state.reason.includes("409"));
    assert(state.kind === "failed" && state.reason.includes("another process"));
    assert(events.some((e) => e.event === "browser.configure_conflict"));
    // And no relay was started for a browser that is not ours.
    assertEquals(sidecar.liveAuth, []);
  } finally {
    await session.stop();
    await sidecar.shutdown();
  }
});

test("browser: a sidecar that restarts is configured again with the same token and proxy, and the relay resumes", async () => {
  const sidecar = await fakeSidecar();
  const historian = await fakeHistorian();
  const { diag, events } = recordingDiag();
  const infos: string[] = [];
  const proxy = { server: "http://egress:3128", username: "run-1", password: "claim", bypass: "" };
  const session = startBrowserSidecar({
    port: sidecar.port,
    token: "tok-1",
    tokenEnv: "RYPH_BROWSER_TOKEN",
    proxy,
    live: { historyUrl: historian.url, runToken: "run-token", runId: "run-1" },
    signal: new AbortController().signal,
    diag,
    log: { info: (message) => infos.push(message) },
    relay: FAST,
  });
  try {
    assertEquals((await session.ready).kind, "ready");
    await until("the first snapshot", () => historian.uplinks[0]?.lines.length === 1);
    sidecar.restart();
    // Configured again, with exactly what it was told the first time, and streaming again.
    await until("the second configure", () => sidecar.configures.length === 2, 3_000);
    assertEquals(sidecar.configures[1], sidecar.configures[0]);
    assertEquals(sidecar.configures[1], { token: "tok-1", proxy, vision: true });
    await until(
      "a fresh snapshot after the restart",
      () => historian.uplinks.some((u, i) => i > 0 && u.lines.length === 1),
      3_000,
    );
    assertEquals(sidecar.liveAuth.includes("Bearer tok-1"), true);
    assert(events.some((e) => e.event === "browser.reconfigured"));
    // The operator sees both, at info.
    assertEquals(infos, ["browser.ready", "browser.reconfigured"]);
  } finally {
    await session.stop();
    await sidecar.shutdown();
    await historian.shutdown();
  }
});

test("browser: a 409 to the re-send after a restart is already configured — the relay resumes", async () => {
  const sidecar = await fakeSidecar();
  const historian = await fakeHistorian();
  const { diag } = recordingDiag();
  const session = startBrowserSidecar({
    port: sidecar.port,
    token: "tok-1",
    tokenEnv: "RYPH_BROWSER_TOKEN",
    proxy: null,
    live: { historyUrl: historian.url, runToken: "run-token", runId: "run-1" },
    signal: new AbortController().signal,
    diag,
    relay: FAST,
  });
  try {
    assertEquals((await session.ready).kind, "ready");
    await until("the first snapshot", () => historian.uplinks[0]?.lines.length === 1);
    sidecar.restartAlreadyReconfigured();
    await until("the re-send", () => sidecar.configures.length === 2, 3_000);
    await until(
      "a fresh snapshot after the restart",
      () => historian.uplinks.some((u, i) => i > 0 && u.lines.length === 1),
      3_000,
    );
  } finally {
    await session.stop();
    await sidecar.shutdown();
    await historian.shutdown();
  }
});

test("browser: a cancelled run settles the wait at once", async () => {
  const cancel = new AbortController();
  const { diag } = recordingDiag();
  const session = startBrowserSidecar({
    port: 1,
    token: "t",
    tokenEnv: "RYPH_BROWSER_TOKEN",
    proxy: null,
    live: null,
    signal: cancel.signal,
    diag,
    waitMs: 60_000,
    probe: () => Promise.resolve(false),
    probeIntervalMs: 50,
  });
  const started = Date.now();
  setTimeout(() => cancel.abort(), 50);
  const state = await session.ready;
  assertEquals(state.kind, "failed");
  assert(Date.now() - started < 2_000);
  // stop() after the fact is harmless, and idempotent.
  await session.stop();
  await session.stop();
});

test("relay: a sidecar stream that ends is reconnected, and the new session opens with a snapshot", async () => {
  const sidecar = await fakeSidecar();
  const historian = await fakeHistorian();
  const { diag } = recordingDiag();
  // Configure the fake by hand, as the sidecar adapter would.
  await (await fetch(`http://127.0.0.1:${sidecar.port}/configure`, {
    method: "POST",
    body: JSON.stringify({ token: "tok", proxy: null }),
  })).body?.cancel();
  const relay = startLiveRelay({
    source: { url: `http://127.0.0.1:${sidecar.port}/live`, token: "tok" },
    sink: { url: `${historian.url}/v1/runs/r/live`, runToken: "rt" },
    diag,
    ...FAST,
  });
  try {
    await until("the first snapshot", () => historian.uplinks[0]?.lines.length === 1);
    sidecar.endLive();
    await until(
      "a second uplink with its own snapshot",
      () => historian.uplinks[1]?.lines.length === 1,
    );
    assertEquals(historian.uplinks[0].done, true);
    assertEquals(JSON.parse(historian.uplinks[1].lines[0]).type, "snapshot");
    assertEquals(sidecar.connections(), 2);
  } finally {
    await relay.stop();
    await sidecar.shutdown();
    await historian.shutdown();
  }
});

test("relay: 410 from the historian ends it for good; 503 is waited out", async () => {
  const sidecar = await fakeSidecar();
  await (await fetch(`http://127.0.0.1:${sidecar.port}/configure`, {
    method: "POST",
    body: JSON.stringify({ token: "tok", proxy: null }),
  })).body?.cancel();
  // Uplinks 0 and 1 hit the room cap, 2 finds the run concluded.
  const historian = await fakeHistorian({ status: (n) => (n < 2 ? 503 : 410) });
  const { diag, events } = recordingDiag();
  const relay = startLiveRelay({
    source: { url: `http://127.0.0.1:${sidecar.port}/live`, token: "tok" },
    sink: { url: `${historian.url}/v1/runs/r/live`, runToken: "rt" },
    diag,
    ...FAST,
  });
  try {
    await until(
      "the concluded answer",
      () => events.some((e) => e.event === "browser.live.concluded"),
    );
    // Nothing more after the 410, however long we wait.
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(historian.uplinks.length, 3);
  } finally {
    await relay.stop();
    await sidecar.shutdown();
    await historian.shutdown();
  }
});

test("relay: a historian that is down is retried with backoff, never thrown, and stop() returns", async () => {
  const sidecar = await fakeSidecar();
  await (await fetch(`http://127.0.0.1:${sidecar.port}/configure`, {
    method: "POST",
    body: JSON.stringify({ token: "tok", proxy: null }),
  })).body?.cancel();
  // A port nothing listens on.
  const deadPort = await freePort();
  const { diag, events } = recordingDiag();
  const relay = startLiveRelay({
    source: { url: `http://127.0.0.1:${sidecar.port}/live`, token: "tok" },
    sink: { url: `http://127.0.0.1:${deadPort}/v1/runs/r/live`, runToken: "rt" },
    diag,
    ...FAST,
  });
  try {
    await until(
      "a few retries",
      () => events.filter((e) => e.event === "browser.live.dropped").length >= 3,
    );
    assert(events.every((e) => e.level === "debug"), "a down historian is not a warning");
  } finally {
    const started = Date.now();
    await relay.stop();
    assert(Date.now() - started < 1_000, "stop() does not wait out a backoff");
    await sidecar.shutdown();
  }
});

test("relay: a refused run token stops it at once", async () => {
  const sidecar = await fakeSidecar();
  await (await fetch(`http://127.0.0.1:${sidecar.port}/configure`, {
    method: "POST",
    body: JSON.stringify({ token: "tok", proxy: null }),
  })).body?.cancel();
  const historian = await fakeHistorian({ status: () => 401 });
  const { diag, events } = recordingDiag();
  const relay = startLiveRelay({
    source: { url: `http://127.0.0.1:${sidecar.port}/live`, token: "tok" },
    sink: { url: `${historian.url}/v1/runs/r/live`, runToken: "rt" },
    diag,
    ...FAST,
  });
  try {
    await until("the refusal", () => events.some((e) => e.event === "browser.live.refused"));
    await new Promise((r) => setTimeout(r, 200));
    assertEquals(historian.uplinks.length, 1);
  } finally {
    await relay.stop();
    await sidecar.shutdown();
    await historian.shutdown();
  }
});

test("relay: a sidecar that keeps forgetting its configuration is backed off from, not spun on", async () => {
  // Never configured: /live answers 503 every time, however often reconfigure says it worked.
  const sidecar = await fakeSidecar();
  const { diag } = recordingDiag();
  let reconfigures = 0;
  const relay = startLiveRelay({
    source: { url: `http://127.0.0.1:${sidecar.port}/live`, token: "tok" },
    sink: { url: "http://127.0.0.1:1/v1/runs/r/live", runToken: "rt" },
    reconfigure: () => {
      reconfigures++;
      return Promise.resolve(true);
    },
    diag,
    backoff: { baseMs: 100, capMs: 100 },
    healthyMs: 60_000,
  });
  try {
    await new Promise((r) => setTimeout(r, 450));
    // One immediate retry per reconfigure, then the backoff: a handful, not thousands.
    assert(reconfigures >= 2 && reconfigures <= 12, `reconfigured ${reconfigures} times`);
  } finally {
    await relay.stop();
    await sidecar.shutdown();
  }
});

/** A port that was free a moment ago: bound, read and closed again. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

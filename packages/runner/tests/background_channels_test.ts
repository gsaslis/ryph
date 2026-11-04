// Where the background commands are told of, against real HTTP servers: the durable record on
// the control plane's runner routes (each call on the run token, retried while transient, given
// up on a refusal, never thrown), and the live uplink to the historian (one streamed NDJSON
// request opened with the replay, lines after it, a reconnect replaying again, a concluded run
// ending it, and close letting what is queued go).

import { test } from "bun:test";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { serve as listen } from "@ryph/service";
import { assert, assertEquals } from "@std/assert";
import {
  BACKGROUND_LOG_DEADLINE_MS,
  httpBackgroundRecords,
} from "../src/adapters/orchestrator/http.ts";
import { commandsSinkUrl, startCommandsUplink } from "../src/adapters/background/uplink.ts";
import type { CommandLine } from "../src/ports/background.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";
import { recordingDiagnostics } from "./doubles/diagnostics.ts";

const RUN_ID = "wi-bg-0001";
const TOKEN = "run-token-bg";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

interface Seen {
  method: string;
  path: string;
  auth: string | null;
  type: string | null;
  body: string;
}

async function serve(answer: (seen: Seen, index: number) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const server = await listen(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const entry: Seen = {
        method: req.method,
        path: new URL(req.url).pathname,
        auth: req.headers.get("authorization"),
        type: req.headers.get("content-type"),
        body: await req.text(),
      };
      seen.push(entry);
      return answer(entry, seen.length - 1);
    },
  );
  const url = `http://127.0.0.1:${server.addr.port}`;
  return { url, seen, shutdown: () => server.shutdown() };
}

test("background records: started, log and exit each go to their route on the run token", async () => {
  const server = await serve(() => new Response(null, { status: 204 }));
  try {
    const records = httpBackgroundRecords({
      baseUrl: `${server.url}/`,
      runToken: TOKEN,
      runId: RUN_ID,
      diag: noopDiagnostics(),
    });
    await records.started({
      id: "bg-1",
      label: "unit tests",
      command: "deno task test",
      cwd: "/work",
      service: false,
      startedAt: "2026-10-06T10:00:00.000Z",
      timeoutAt: "2026-10-06T10:30:00.000Z",
    });
    await records.log("bg-1", "ok 1\nok 2\n");
    await records.ended("bg-1", {
      endedAt: "2026-10-06T10:04:12.000Z",
      reason: "exited",
      exitCode: 1,
      signal: null,
      logBytes: 10,
      logTruncated: false,
      logTail: "ok 2",
    });
    const route = `/v1/runs/${RUN_ID}/runner/background/bg-1`;
    assertEquals(server.seen.map((s) => `${s.method} ${s.path}`), [
      `PUT ${route}`,
      `PUT ${route}/log`,
      `POST ${route}/exit`,
    ]);
    assert(server.seen.every((s) => s.auth === `Bearer ${TOKEN}`));
    assertEquals(JSON.parse(server.seen[0].body), {
      label: "unit tests",
      command: "deno task test",
      cwd: "/work",
      service: false,
      startedAt: "2026-10-06T10:00:00.000Z",
      timeoutAt: "2026-10-06T10:30:00.000Z",
    });
    assertEquals(server.seen[1].type, "text/plain; charset=utf-8");
    assertEquals(server.seen[1].body, "ok 1\nok 2\n");
    assertEquals(JSON.parse(server.seen[2].body).reason, "exited");
  } finally {
    await server.shutdown();
  }
});

test("background records: a 5xx, 429 or 408 is retried, a 409 is final, and nothing throws", async () => {
  const server = await serve((seen, i) =>
    seen.path.endsWith("/exit")
      ? new Response("concluded", { status: 409 })
      : new Response(null, { status: i === 0 ? 503 : i === 1 ? 429 : i === 2 ? 408 : 204 })
  );
  const { diag, warns } = recordingDiagnostics();
  try {
    const records = httpBackgroundRecords({
      baseUrl: server.url,
      runToken: TOKEN,
      runId: RUN_ID,
      diag,
      retryPauseMs: 1,
    });
    assertEquals(await records.log("bg-2", "x"), true);
    assertEquals(server.seen.length, 4, "three transient answers, then the record");
    const landed = await records.ended("bg-2", {
      endedAt: "2026-10-06T10:04:12.000Z",
      reason: "run_ended",
      exitCode: null,
      signal: "SIGTERM",
      logBytes: 1,
      logTruncated: false,
      logTail: "x",
    });
    assertEquals(landed, false);
    assertEquals(server.seen.length, 5, "a refusal is not retried");
    assert(warns.some((w) => w.event === "orchestrator.background.refused"));
  } finally {
    await server.shutdown();
  }
  // Nobody there at all: tried, given up, not thrown.
  const records = httpBackgroundRecords({
    baseUrl: server.url,
    runToken: TOKEN,
    runId: RUN_ID,
    diag: noopDiagnostics(),
    retryPauseMs: 1,
    logDeadlineMs: 200,
  });
  // Fails, never hangs, should the deadline not hold.
  assertEquals(await bounded(records.log("bg-3", "x"), 3_000), false);
});

/** `promise`, or a failure after `ms`: a test that would otherwise hang fails instead. */
function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

test("background records: a log whose claim another upload holds waits it out, until its deadline", async () => {
  // The control plane lets a claim's holder keep it at most 15 s (its body deadline); the
  // runner's deadline outlasts that with room for a try after it.
  assert(BACKGROUND_LOG_DEADLINE_MS >= 15_000 + 10_000);
  const releasedAt = Date.now() + 300;
  const server = await serve(() =>
    Date.now() < releasedAt
      ? Response.json({ error: "busy", code: "busy" }, { status: 409 })
      : Response.json({ stored: true })
  );
  try {
    const records = httpBackgroundRecords({
      baseUrl: server.url,
      runToken: TOKEN,
      runId: RUN_ID,
      diag: noopDiagnostics(),
      retryPauseMs: 20,
      logDeadlineMs: 2_000,
    });
    assertEquals(await bounded(records.log("bg-1", "x"), 5_000), true);
    assert(server.seen.length > 1, "it was refused busy first");
  } finally {
    await server.shutdown();
  }
});

test("background records: a 409 that is not busy is final, and the deadline counts the wait for a slot", async () => {
  for (const code of ["running", "lost"]) {
    const server = await serve(() => Response.json({ error: code, code }, { status: 409 }));
    try {
      const records = httpBackgroundRecords({
        baseUrl: server.url,
        runToken: TOKEN,
        runId: RUN_ID,
        diag: noopDiagnostics(),
        retryPauseMs: 1,
      });
      assertEquals(await records.log("bg-1", "x"), false);
      assertEquals(server.seen.length, 1, code);
    } finally {
      await server.shutdown();
    }
  }
  // Two uploads hold both slots past the third's deadline: it gives up without a try. The slots
  // are held until let go and the deadlines run on a fake clock, so no wall-clock race decides it
  // (the holders' own deadlines would otherwise end their tries just before the third's).
  let release = () => {};
  const released = new Promise<void>((resolve) => release = resolve);
  const server = await serve(async () => {
    await released;
    return Response.json({ stored: true });
  });
  let clock = 0;
  try {
    const records = httpBackgroundRecords({
      baseUrl: server.url,
      runToken: TOKEN,
      runId: RUN_ID,
      diag: noopDiagnostics(),
      logDeadlineMs: 10_000,
      now: () => clock,
    });
    const all = Promise.all([
      records.log("bg-1", "x"),
      records.log("bg-2", "x"),
      records.log("bg-3", "x"),
    ]);
    await until(() => server.seen.length === 2, "both slots taken");
    clock = 10_000;
    release();
    assertEquals(await bounded(all, 3_000), [true, true, false]);
    assertEquals(server.seen.length, 2);
  } finally {
    release();
    await server.shutdown();
  }
});

test("background records: a start the runner did not create is said to be forged", async () => {
  const server = await serve(() => Response.json({ id: "bg-1", created: false }));
  const { diag, warns } = recordingDiagnostics();
  try {
    const records = httpBackgroundRecords({
      baseUrl: server.url,
      runToken: TOKEN,
      runId: RUN_ID,
      diag,
    });
    assertEquals(
      await records.started({
        id: "bg-1",
        label: "x",
        command: "true",
        cwd: "/",
        service: false,
        startedAt: "2026-10-06T10:00:00.000Z",
        timeoutAt: "2026-10-06T10:30:00.000Z",
      }),
      true,
    );
    assert(warns.some((w) => w.event === "orchestrator.background.start_forged"));
  } finally {
    await server.shutdown();
  }
});

test("background records: logs go up two at a time, and a busy control plane is waited out", async () => {
  let inFlight = 0;
  let most = 0;
  let refused = 0;
  const stored: string[] = [];
  const server = await serve(async (seen) => {
    // The control plane's own cap, as it enforces it.
    if (inFlight >= 2) {
      refused++;
      return new Response(null, { status: 429 });
    }
    inFlight++;
    most = Math.max(most, inFlight);
    await sleep(40);
    inFlight--;
    stored.push(seen.path);
    return Response.json({ stored: true });
  });
  try {
    const records = httpBackgroundRecords({
      baseUrl: server.url,
      runToken: TOKEN,
      runId: RUN_ID,
      diag: noopDiagnostics(),
      retryPauseMs: 5,
    });
    const all = await Promise.all(
      Array.from({ length: 8 }, (_, i) => records.log(`bg-${i + 1}`, "x\n")),
    );
    assertEquals(all, Array(8).fill(true));
    assertEquals(stored.length, 8);
    assertEquals(most, 2);
    assertEquals(refused, 0, "none was refused: the client queued them");
  } finally {
    await server.shutdown();
  }
});

test("background records: a log someone else stored is said so", async () => {
  const server = await serve(() => Response.json({ stored: false }));
  const { diag, warns } = recordingDiagnostics();
  try {
    const records = httpBackgroundRecords({
      baseUrl: server.url,
      runToken: TOKEN,
      runId: RUN_ID,
      diag,
    });
    assertEquals(await records.log("bg-1", "x"), true);
    assert(warns.some((w) => w.event === "orchestrator.background.log_not_stored"));
  } finally {
    await server.shutdown();
  }
});

/** A historian that streams each uplink's lines as they arrive. */
async function historian(answer: (index: number) => number = () => 200) {
  const sessions: Array<{ lines: CommandLine[]; auth: string | null; path: string }> = [];
  const server = await listen(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const index = sessions.length;
      const session = {
        lines: [] as CommandLine[],
        auth: req.headers.get("authorization"),
        path: new URL(req.url).pathname,
      };
      sessions.push(session);
      const status = answer(index);
      if (status !== 200) {
        await req.body?.cancel();
        return new Response(null, { status });
      }
      const reader = req.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;
          let nl;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            session.lines.push(JSON.parse(buffer.slice(0, nl)));
            buffer = buffer.slice(nl + 1);
          }
        }
      } catch {
        // the uplink was cut
      }
      return new Response(null, { status: 200 });
    },
  );
  const base = `http://127.0.0.1:${server.addr.port}`;
  return { base, sessions, shutdown: () => server.shutdown() };
}

const line = (id: string, text: string): CommandLine => ({
  type: "output",
  at: "2026-10-06T10:00:00.000Z",
  id,
  text,
});

test("commands uplink: opens with the replay, carries lines after it, and close sends what is queued", async () => {
  const room = await historian();
  const uplink = startCommandsUplink({
    url: commandsSinkUrl(`${room.base}/`, RUN_ID),
    runToken: TOKEN,
    diag: noopDiagnostics(),
  });
  try {
    // Before it is opened, a line goes nowhere.
    uplink.send(line("bg-1", "lost"));
    let replays = 0;
    uplink.open(() => {
      replays++;
      return [line("bg-1", "replayed")];
    });
    await until(() => room.sessions.length === 1, "the uplink");
    uplink.send(line("bg-1", "live"));
    await until(() => room.sessions[0].lines.length === 2, "both lines");
    uplink.send(line("bg-1", "last"));
    await uplink.close();
    assertEquals(room.sessions[0].path, `/v1/runs/${RUN_ID}/live/commands`);
    assertEquals(room.sessions[0].auth, `Bearer ${TOKEN}`);
    assertEquals(
      room.sessions[0].lines.map((l) => (l as { text: string }).text),
      ["replayed", "live", "last"],
    );
    assertEquals(replays, 1);
    // Closed: nothing more goes, and a second close is a no-op.
    uplink.send(line("bg-1", "after"));
    await uplink.close();
  } finally {
    await uplink.close();
    await room.shutdown();
  }
});

test("commands uplink: a dropped connection is opened again with a fresh replay", async () => {
  const room = await historian((i) => (i === 0 ? 503 : 200));
  const uplink = startCommandsUplink({
    url: commandsSinkUrl(room.base, RUN_ID),
    runToken: TOKEN,
    diag: noopDiagnostics(),
    backoff: { baseMs: 10, capMs: 20 },
  });
  try {
    let replays = 0;
    uplink.open(() => [line("bg-1", `replay ${++replays}`)]);
    await until(() => room.sessions.length === 2, "the second connection");
    await until(() => room.sessions[1].lines.length === 1, "its replay");
    assertEquals((room.sessions[1].lines[0] as { text: string }).text, "replay 2");
  } finally {
    await uplink.close();
    await room.shutdown();
  }
});

test("commands uplink: a connection answered before its body was read is not kept open", async () => {
  // A historian that answers 503 at once, offers to keep the connection and never reads the
  // body: the uplink's next attempt must not leave the last one open with its upload stalled.
  let opened = 0;
  let open = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    opened++;
    open++;
    sockets.add(socket);
    socket.once("data", () =>
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: keep-alive\r\n\r\n",
      ));
    socket.on("error", () => {});
    socket.on("close", () => {
      open--;
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const uplink = startCommandsUplink({
    url: commandsSinkUrl(`http://127.0.0.1:${port}`, RUN_ID),
    runToken: TOKEN,
    diag: noopDiagnostics(),
    backoff: { baseMs: 10, capMs: 20 },
  });
  try {
    uplink.open(() => [line("bg-1", "x")]);
    await until(() => opened >= 4, "four connections");
    await until(() => open <= 1, "every answered connection closed");
  } finally {
    await uplink.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("commands uplink: a concluded run (410) ends it for good", async () => {
  const room = await historian(() => 410);
  const uplink = startCommandsUplink({
    url: commandsSinkUrl(room.base, RUN_ID),
    runToken: TOKEN,
    diag: noopDiagnostics(),
    backoff: { baseMs: 10, capMs: 20 },
  });
  try {
    uplink.open(() => []);
    await until(() => room.sessions.length === 1, "the uplink");
    await sleep(100);
    assertEquals(room.sessions.length, 1);
  } finally {
    await uplink.close();
    await room.shutdown();
  }
});

test("commands uplink: a connection that falls too far behind is cut and replayed", async () => {
  const room = await historian();
  const uplink = startCommandsUplink({
    url: commandsSinkUrl(room.base, RUN_ID),
    runToken: TOKEN,
    diag: noopDiagnostics(),
    backoff: { baseMs: 10, capMs: 20 },
    maxQueuedBytes: 1_000,
  });
  try {
    let replays = 0;
    uplink.open(() => [line("bg-1", `replay ${++replays}`)]);
    await until(() => room.sessions.length === 1, "the uplink");
    // Far more at once than may wait: the connection is given up, and a new one replays.
    for (let i = 0; i < 50; i++) uplink.send(line("bg-1", "x".repeat(100)));
    await until(() => room.sessions.length === 2, "the second connection");
    await until(() => room.sessions[1].lines.length >= 1, "its replay");
    assertEquals((room.sessions[1].lines[0] as { text: string }).text, "replay 2");
  } finally {
    await uplink.close();
    await room.shutdown();
  }
});

test("commands uplink: close is bounded when the historian is slow to answer", async () => {
  // Accepts the request and does not read or answer it for longer than close waits.
  const hung = await listen(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async () => {
      await sleep(1_000);
      return new Response(null);
    },
  );
  const uplink = startCommandsUplink({
    url: commandsSinkUrl(`http://127.0.0.1:${hung.addr.port}`, RUN_ID),
    runToken: TOKEN,
    diag: noopDiagnostics(),
    closeWaitMs: 100,
  });
  try {
    uplink.open(() => [line("bg-1", "x")]);
    await sleep(50);
    const t0 = Date.now();
    await uplink.close();
    assert(Date.now() - t0 < 800, "close did not wait for the answer");
  } finally {
    await hung.shutdown().catch(() => {});
  }
});

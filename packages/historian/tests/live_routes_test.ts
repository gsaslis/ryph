// The live channel's HTTP surface, driven as a pure handler with fakes — no sockets. A streamed
// NDJSON body goes in through POST /v1/runs/:id/live while it is still open, and SSE comes out of
// GET /v1/runs/:id/live/stream: the gates, the line discipline, coalescing for a reader that is
// behind, and the ways an uplink or a stream ends.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { makeHistorianService } from "../src/core/service.ts";
import { memoryHistoryStore } from "./memory_store.ts";
import { memoryHistoryBus } from "../src/adapters/bus/memory.ts";
import { historianRoutes, MAX_LIVE_LINE_BYTES } from "../src/http/routes.ts";

const RUN_TOKEN = "good-token";
const USER = { authorization: "Bearer user-token" };

/** One turn of the timer queue — long enough for a handler to read what was just written. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function makeApp(opts: { terminal?: boolean | (() => boolean); keepaliveMs?: number } = {}) {
  const terminal = opts.terminal;
  const service = makeHistorianService({ store: memoryHistoryStore(), bus: memoryHistoryBus() });
  const { routes, concludeRun } = historianRoutes({
    service,
    authenticateRunRead: (req) =>
      Promise.resolve(
        req.headers.get("authorization") === USER.authorization
          ? null
          : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      ),
    authenticateRun: (req, runId) =>
      Promise.resolve(
        runId === "run-1" && req.headers.get("authorization") === `Bearer ${RUN_TOKEN}`,
      ),
    isRunTerminal: () =>
      Promise.resolve(typeof terminal === "function" ? terminal() : terminal ?? false),
    liveKeepaliveMs: opts.keepaliveMs,
  });
  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(url);
      if (!match) continue;
      return await route.handler(req, match.pathname.groups as Record<string, string>);
    }
    return new Response("no route", { status: 404 });
  };
  return { handle, concludeRun };
}

/** An uplink whose body the test writes to while the handler is reading it. */
function openUplink(
  handle: (req: Request) => Promise<Response>,
  token = RUN_TOKEN,
  runId = "run-1",
): { write: (text: string) => void; end: () => void; response: Promise<Response> } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
  const encoder = new TextEncoder();
  const response = handle(
    new Request(`http://x/v1/runs/${runId}/live`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-ndjson" },
      body,
    }),
  );
  return {
    write: (text) => controller.enqueue(encoder.encode(text)),
    end: () => {
      try {
        controller.close();
      } catch {
        // already cancelled by the handler
      }
    },
    response,
  };
}

const line = (event: unknown) => `${JSON.stringify(event)}\n`;
const frame = (n: number) => ({
  type: "frame",
  at: n,
  frame: {
    mime: "image/jpeg",
    data: `frame${n}`, // base64 charset: the schema checks it
    width: 1280,
    height: 800,
    tabId: "t1",
    viewport: { width: 1280, height: 800 },
  },
});
const consoleLine = (n: number) => ({
  type: "console",
  at: n,
  tabId: "t1",
  level: "error",
  text: `line ${n}`,
});

/** Reads one SSE event at a time (the route writes each as its own chunk); keepalives skipped. */
function sse(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  return {
    async next(): Promise<{ event: string; data: Record<string, unknown> } | null> {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return null;
        const text = decoder.decode(value);
        if (text.startsWith(":")) continue;
        const event = /^event: (.+)$/m.exec(text)![1];
        const data = JSON.parse(/^data: (.+)$/m.exec(text)![1]);
        return { event, data };
      }
    },
    cancel: () => reader.cancel(),
  };
}

const watch = (handle: (req: Request) => Promise<Response>, headers: HeadersInit = USER) =>
  handle(new Request("http://x/v1/runs/run-1/live/stream", { headers }));

test("the uplink needs the run bearer, and the stream the read gate", async () => {
  const { handle } = makeApp();
  const wrongToken = openUplink(handle, "wrong-token");
  assertEquals((await wrongToken.response).status, 401);
  const otherRun = openUplink(handle, RUN_TOKEN, "run-2");
  assertEquals((await otherRun.response).status, 401);

  assertEquals((await watch(handle, {})).status, 401);
  assertEquals((await watch(handle, { authorization: "Bearer someone" })).status, 401);
});

test("a concluded run's uplink is refused as gone", async () => {
  const { handle } = makeApp({ terminal: true });
  const uplink = openUplink(handle);
  assertEquals((await uplink.response).status, 410);
});

test("lines streamed into an open uplink come out of the stream as they arrive", async () => {
  const { handle } = makeApp();
  const uplink = openUplink(handle);
  const viewer = sse(await watch(handle));

  const snapshot = await viewer.next();
  assertEquals(snapshot?.event, "snapshot");
  assertEquals(snapshot?.data.uplink, true);

  uplink.write(line({ type: "status", at: 1, status: "active" }));
  assertEquals(await viewer.next(), {
    event: "status",
    data: { type: "status", at: 1, status: "active" },
  });

  // Split across writes, mid-line: the reader joins it.
  const text = line(consoleLine(2));
  uplink.write(text.slice(0, 10));
  await settle();
  uplink.write(text.slice(10));
  const got = await viewer.next();
  assertEquals(got?.event, "console");
  assertEquals(got?.data.text, "line 2");

  // A field the contract adds later rides through, not stripped.
  uplink.write(line(frame(3)));
  const pictured = await viewer.next();
  assertEquals(pictured?.event, "frame");
  assertEquals(
    (pictured?.data.frame as { viewport: unknown }).viewport,
    { width: 1280, height: 800 },
  );

  uplink.end();
  assertEquals(await viewer.next(), { event: "uplink", data: { connected: false } });
  const res = await uplink.response;
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    accepted: 3,
    malformed: 0,
    oversize: 0,
    refused: 0,
    replaced: false,
  });
  await viewer.cancel();
});

test("malformed and oversize lines are dropped and counted; the rest still land", async () => {
  const { handle } = makeApp();
  const uplink = openUplink(handle);
  uplink.write("not json\n");
  uplink.write(line({ type: "teleport", at: 1 }));
  uplink.write(line({ type: "console", at: 1 })); // missing fields
  uplink.write("\n"); // blank lines are nothing at all
  uplink.write(line({ ...consoleLine(1), text: "x".repeat(MAX_LIVE_LINE_BYTES) }));
  uplink.write(line(consoleLine(2)));
  uplink.end();

  const res = await uplink.response;
  assertEquals(await res.json(), {
    accepted: 1,
    malformed: 3,
    oversize: 1,
    refused: 0,
    replaced: false,
  });

  const viewer = sse(await watch(handle));
  const snapshot = await viewer.next();
  const console = snapshot?.data.console as Array<{ text: string }>;
  assertEquals(console.map((c) => c.text), ["line 2"]);
  await viewer.cancel();
});

test("a viewer that is behind gets the latest frame, not a backlog", async () => {
  const { handle } = makeApp();
  const uplink = openUplink(handle);
  const viewer = sse(await watch(handle));
  assertEquals((await viewer.next())?.event, "snapshot");

  // Thirty frames and a console line while nobody reads.
  for (let n = 1; n <= 30; n++) uplink.write(line(frame(n)));
  uplink.write(line(consoleLine(31)));
  await settle();

  // Read up to the console line, which queued behind every frame.
  const frames: string[] = [];
  for (let event = await viewer.next(); event?.event !== "console"; event = await viewer.next()) {
    assertEquals(event?.event, "frame");
    frames.push((event!.data.frame as { data: string }).data);
  }
  // The stream's own one-slot buffer may already hold the first frame, pulled before the backlog
  // built up; everything behind it collapses to the newest picture.
  assert(frames.length <= 2, `expected the frames coalesced, got ${frames.length}`);
  assertEquals(frames.at(-1), "frame30");

  uplink.end();
  await uplink.response;
  await viewer.cancel();
});

test("a second uplink replaces the first, which is hung up", async () => {
  const { handle } = makeApp();
  const first = openUplink(handle);
  first.write(line(consoleLine(1)));
  await settle();
  const second = openUplink(handle);

  const res = await first.response;
  assertEquals(await res.json(), {
    accepted: 1,
    malformed: 0,
    oversize: 0,
    refused: 0,
    replaced: true,
  });

  second.write(line(consoleLine(2)));
  await settle();
  const viewer = sse(await watch(handle));
  const snapshot = await viewer.next();
  assertEquals(snapshot?.data.uplink, true);
  // The new uplink's lines are the room's history: its sidecar replays what it kept.
  assertEquals((snapshot?.data.console as Array<{ at: number }>).map((c) => c.at), [2]);
  second.end();
  await second.response;
  await viewer.cancel();
});

test("a relay that reconnects and replays: a watching viewer is reset, then refilled, once", async () => {
  const { handle } = makeApp();
  const opening = line({ type: "snapshot", at: 0, status: "active", tabs: [], frame: null });
  const first = openUplink(handle);
  first.write(opening + line(consoleLine(1)) + line(consoleLine(2)));
  await settle();
  const viewer = sse(await watch(handle));
  const before = await viewer.next();
  assertEquals((before?.data.console as unknown[]).length, 2);

  first.end();
  await first.response;
  assertEquals(await viewer.next(), { event: "uplink", data: { connected: false } });

  const second = openUplink(handle);
  second.write(opening + line(consoleLine(1)) + line(consoleLine(2)) + line(consoleLine(3)));
  const reset = await viewer.next();
  assertEquals(reset?.event, "snapshot");
  assertEquals(reset?.data.uplink, true);
  assertEquals(reset?.data.console, []);
  const after: number[] = [];
  while (after.length < 3) {
    const next = await viewer.next();
    if (next?.event === "console") after.push(next.data.at as number);
  }
  assertEquals(after, [1, 2, 3]);
  const late = sse(await watch(handle));
  assertEquals(
    ((await late.next())?.data.console as Array<{ at: number }>).map((c) => c.at),
    [1, 2, 3],
  );
  second.end();
  await second.response;
  await viewer.cancel();
  await late.cancel();
});

test("conclusion hangs up the uplink and ends the stream with done", async () => {
  const { handle, concludeRun } = makeApp();
  const uplink = openUplink(handle);
  const viewer = sse(await watch(handle));
  assertEquals((await viewer.next())?.event, "snapshot");

  concludeRun("run-1");
  assertEquals(await viewer.next(), { event: "uplink", data: { connected: false } });
  assertEquals(await viewer.next(), { event: "done", data: {} });
  assertEquals(await viewer.next(), null, "the stream closes");

  // Hung up by the conclusion: 410, which the relay stops on, not a 200 it would retry.
  const res = await uplink.response;
  assertEquals(res.status, 410);
  assertEquals((await res.json() as { error: string }).error, "run concluded");
  uplink.end();
});

test("a stream on a run already over, with nothing held, says done at once", async () => {
  const { handle } = makeApp({ terminal: true });
  const text = await (await watch(handle)).text();
  assert(text.startsWith(": open\n\nevent: snapshot\n"));
  assert(text.endsWith("event: done\ndata: {}\n\n"));
});

test("the stream keeps alive, and a client hanging up detaches it", async () => {
  const { handle } = makeApp({ keepaliveMs: 5 });
  const res = await watch(handle);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  // The open comment first, sent before the room so the headers leave at once.
  assertEquals(decoder.decode((await reader.read()).value), ": open\n\n");
  assert(decoder.decode((await reader.read()).value).startsWith("event: snapshot"));
  assertEquals(decoder.decode((await reader.read()).value), ": keepalive\n\n");
  // Cancelling clears the interval — the test sanitizer fails the test if it leaked.
  await reader.cancel();
});

test("a line is held only in its known shape, and a small kind gets a small cap", async () => {
  const { handle } = makeApp();
  const uplink = openUplink(handle);
  uplink.write(line({ ...consoleLine(1), junk: "y".repeat(10_000) }));
  uplink.write(line({ ...consoleLine(2), junk: "y".repeat(20_000) })); // over the 16 KB cap
  uplink.write(line(frame(3))); // the frame's `viewport` is the sanctioned extra
  uplink.write(line({ ...frame(4), frame: { ...frame(4).frame, data: '"><script>' } }));
  uplink.end();
  assertEquals(await (await uplink.response).json(), {
    accepted: 2,
    malformed: 1,
    oversize: 1,
    refused: 0,
    replaced: false,
  });

  const viewer = sse(await watch(handle));
  const snapshot = (await viewer.next())!.data;
  assertEquals(snapshot.console, [consoleLine(1)]);
  assertEquals(snapshot.frame, frame(3).frame);
  await viewer.cancel();
});

test("a terminal run whose conclusion never arrived still says done on the keepalive", async () => {
  let over = false;
  const { handle } = makeApp({ terminal: () => over, keepaliveMs: 5 });
  const uplink = openUplink(handle);
  uplink.write(line(consoleLine(1)));
  await settle();
  const viewer = sse(await watch(handle));
  assertEquals((await viewer.next())?.event, "snapshot");

  over = true; // the run ended; the conclude signal was lost
  assertEquals(await viewer.next(), { event: "uplink", data: { connected: false } });
  assertEquals(await viewer.next(), { event: "done", data: {} });
  assertEquals(await viewer.next(), null, "the stream closes");
  // A conclusion found on the keepalive hangs the uplink up as the signal would: 410.
  assertEquals((await uplink.response).status, 410);
  uplink.end();
});

test("a viewer opening on a terminal run gets done even when the room never concluded", async () => {
  let over = false;
  const { handle } = makeApp({ terminal: () => over });
  const uplink = openUplink(handle);
  uplink.write(line(consoleLine(1)));
  uplink.end();
  await uplink.response;

  over = true;
  const text = await (await watch(handle)).text();
  assert(text.startsWith(": open\n\nevent: snapshot\n"));
  assert(text.includes('"line 1"'), "the room's last state is still shown");
  assert(text.endsWith("event: done\ndata: {}\n\n"));
});

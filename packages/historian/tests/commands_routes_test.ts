// The background commands' live HTTP surface, driven as a pure handler with fakes — no sockets.
// NDJSON goes in through POST /v1/runs/:id/live/commands while the body is still open, and SSE
// comes out of GET /v1/runs/:id/live/commands/stream: the gates, the wire's bounds, that the
// channel is apart from the browser's, and conclusion.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { makeHistorianService } from "../src/core/service.ts";
import { memoryHistoryStore } from "./memory_store.ts";
import { memoryHistoryBus } from "../src/adapters/bus/memory.ts";
import { historianRoutes } from "../src/http/routes.ts";
import { MAX_COMMANDS_LINE, parseCommandsLine } from "../src/schema.ts";

const RUN_TOKEN = "good-token";
const USER = { authorization: "Bearer user-token" };

function makeApp(opts: { terminal?: boolean } = {}) {
  const service = makeHistorianService({ store: memoryHistoryStore(), bus: memoryHistoryBus() });
  const { routes, concludeRun } = historianRoutes({
    service,
    authenticateRunRead: (req) =>
      Promise.resolve(
        req.headers.get("authorization") === USER.authorization ||
          req.headers.get("authorization")?.startsWith("Bearer h.")
          ? null
          : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      ),
    authenticateRun: (req, runId) =>
      Promise.resolve(
        runId === "run-1" && req.headers.get("authorization") === `Bearer ${RUN_TOKEN}`,
      ),
    isRunTerminal: () => Promise.resolve(opts.terminal ?? false),
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

function openUplink(
  handle: (req: Request) => Promise<Response>,
  opts: { token?: string; runId?: string; path?: string } = {},
): { write: (text: string) => void; end: () => void; response: Promise<Response> } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
  const encoder = new TextEncoder();
  const response = handle(
    new Request(`http://x/v1/runs/${opts.runId ?? "run-1"}/${opts.path ?? "live/commands"}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.token ?? RUN_TOKEN}`,
        "content-type": "application/x-ndjson",
      },
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

const watch = (
  handle: (req: Request) => Promise<Response>,
  headers: HeadersInit = USER,
  path = "live/commands/stream",
) => handle(new Request(`http://x/v1/runs/run-1/${path}`, { headers }));

const line = (event: unknown) => `${JSON.stringify(event)}\n`;
const started = {
  type: "started",
  at: 1_000,
  id: "bg-1",
  label: "tests",
  command: "deno task test",
  cwd: "/work/repo",
  service: false,
  timeoutAt: 1_000 + 30 * 60_000,
};

test("the commands uplink needs the run bearer, and its stream the read gate", async () => {
  const { handle } = makeApp();
  assertEquals((await openUplink(handle, { token: "wrong" }).response).status, 401);
  assertEquals((await openUplink(handle, { runId: "run-2" }).response).status, 401);
  assertEquals((await watch(handle, {})).status, 401);
  assertEquals((await watch(handle, { authorization: "Bearer someone" })).status, 401);
});

test("a concluded run's commands uplink is refused as gone", async () => {
  const { handle } = makeApp({ terminal: true });
  assertEquals((await openUplink(handle).response).status, 410);
});

test("jobs streamed into the uplink come out of the stream, apart from the browser's", async () => {
  const { handle } = makeApp();
  const uplink = openUplink(handle);
  uplink.write(line(started));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const viewer = sse(await watch(handle));
  const snapshot = await viewer.next();
  assertEquals(snapshot?.event, "snapshot");
  assertEquals((snapshot!.data.jobs as Array<{ id: string }>).map((j) => j.id), ["bg-1"]);
  assertEquals(snapshot!.data.uplink, true);

  // The browser's room heard nothing of it.
  const browser = sse(await watch(handle, USER, "live/stream"));
  const browserSnapshot = await browser.next();
  assertEquals(browserSnapshot?.data.console, []);
  assertEquals(browserSnapshot?.data.uplink, false);
  await browser.cancel();

  uplink.write(line({ type: "output", at: 1_100, id: "bg-1", text: "ok 12 tests\n" }));
  assertEquals(await viewer.next(), {
    event: "output",
    data: { type: "output", at: 1_100, id: "bg-1", text: "ok 12 tests\n" },
  });
  uplink.write(
    line({ type: "exited", at: 1_200, id: "bg-1", reason: "exited", exitCode: 0, signal: null }),
  );
  assertEquals((await viewer.next())?.event, "exited");
  uplink.end();
  assertEquals(await (await uplink.response).json(), {
    accepted: 3,
    malformed: 0,
    oversize: 0,
    refused: 0,
    replaced: false,
  });
  assertEquals(await viewer.next(), { event: "uplink", data: { connected: false } });
  await viewer.cancel();
});

test("bad lines are dropped and counted: malformed, oversize, and refused by the room", async () => {
  const { handle } = makeApp();
  const uplink = openUplink(handle);
  uplink.write("not json\n");
  uplink.write(line({ ...started, id: "../../etc/passwd" })); // not a job id
  uplink.write(line({ ...started, id: "bg-1000" })); // four digits
  uplink.write(line({ ...started, label: "" }));
  uplink.write(line({ type: "output", at: 1, id: "bg-1", text: "x".repeat(MAX_COMMANDS_LINE) }));
  uplink.write(line({ type: "output", at: 1, id: "bg-1", text: "before its start" }));
  uplink.write(line(started));
  uplink.write(line(started)); // a second start
  uplink.end();
  assertEquals(await (await uplink.response).json(), {
    accepted: 1,
    malformed: 4,
    oversize: 1,
    refused: 2,
    replaced: false,
  });
});

test("a commands line is held only in its bounded, known shape", () => {
  const parsed = parseCommandsLine(JSON.stringify({
    ...started,
    label: "l".repeat(200),
    command: "c".repeat(5_000),
    cwd: "d".repeat(2_000),
    junk: "<script>",
  }));
  assert(parsed !== "malformed" && parsed.type === "started");
  assertEquals(parsed.label.length, 80);
  assertEquals(parsed.command.length, 2 * 1024);
  assertEquals(parsed.cwd.length, 1024);
  assert(!("junk" in parsed));

  const output = parseCommandsLine(
    JSON.stringify({ type: "output", at: 1, id: "bg-2", text: "t".repeat(9_000) }),
  );
  assert(output !== "malformed" && output.type === "output");
  assertEquals(output.text.length, 8 * 1024);

  // A clip never leaves half a surrogate pair behind.
  const emoji = parseCommandsLine(JSON.stringify({ ...started, label: "a".repeat(78) + "😀😀" }));
  assert(emoji !== "malformed" && emoji.type === "started");
  assertEquals(emoji.label, "a".repeat(78) + "…");
  assert(emoji.label.isWellFormed());

  // Control and bidi characters never reach a viewer; a line break reads as a space.
  const sneaky = parseCommandsLine(JSON.stringify({
    ...started,
    label: "safe\u202egnp.exe\u0007",
    command: "echo a\r\necho b\u001b[2J\u0085\u2066x\u2069",
    cwd: "/work\u0000/repo\t1",
  }));
  assert(sneaky !== "malformed" && sneaky.type === "started");
  assertEquals(sneaky.label, "safegnp.exe");
  assertEquals(sneaky.command, "echo a echo b[2Jx");
  assertEquals(sneaky.cwd, "/work/repo\t1");
  assertEquals(
    parseCommandsLine(JSON.stringify({ ...started, label: "\u202e\u0007" })),
    "malformed",
  );

  // ISO moments are accepted and held as milliseconds.
  const iso = parseCommandsLine(JSON.stringify({
    ...started,
    at: "2026-10-06T12:00:00.000Z",
    timeoutAt: "2026-10-06T12:30:00.000Z",
  }));
  assert(iso !== "malformed" && iso.type === "started");
  assertEquals(iso.at, Date.parse("2026-10-06T12:00:00.000Z"));
  assertEquals(iso.timeoutAt, Date.parse("2026-10-06T12:30:00.000Z"));

  const exit = (over: Record<string, unknown>) =>
    parseCommandsLine(
      JSON.stringify({ type: "exited", at: 1, id: "bg-1", reason: "exited", ...over }),
    );
  assertEquals(exit({ signal: "SIGTERM", exitCode: null }) === "malformed", false);
  assertEquals(exit({ signal: "kill -9 everything" }), "malformed");
  assertEquals(exit({ reason: "exploded" }), "malformed");
  assertEquals(exit({ exitCode: 1.5 }), "malformed");
  // exitCode and signal may be left out: an exit by signal has no code, and the other way round.
  const bare = exit({});
  assert(bare !== "malformed" && bare.type === "exited");
  assertEquals([bare.exitCode, bare.signal], [null, null]);
  assertEquals(
    parseCommandsLine(JSON.stringify({ type: "skipped", at: 1, id: "bg-1", bytes: -1 })),
    "malformed",
  );
});

test("conclusion ends the commands stream with done and hangs up its uplink", async () => {
  const { handle, concludeRun } = makeApp();
  const uplink = openUplink(handle);
  uplink.write(line(started));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const viewer = sse(await watch(handle));
  assertEquals((await viewer.next())?.event, "snapshot");
  concludeRun("run-1");
  assertEquals((await viewer.next())?.event, "uplink");
  assertEquals((await viewer.next())?.event, "done");
  assertEquals(await viewer.next(), null);
  const hungUp = await uplink.response;
  assertEquals(hungUp.status, 410);
  assertEquals((await hungUp.json() as { accepted: number }).accepted, 1);
  // A late uplink, the run's token still good, is gone.
  assertEquals((await openUplink(handle).response).status, 410);
});

/** A bearer shaped like an access token naming `sub` (the test gate lets these through). */
const asUser = (sub: string) => ({
  authorization: `Bearer h.${btoa(JSON.stringify({ sub })).replace(/=+$/, "")}.s`,
});

test("a run's stream refuses a viewer past the cap with 429", async () => {
  const { handle } = makeApp();
  const open: Array<{ cancel: () => Promise<void> }> = [];
  for (let n = 0; n < 32; n++) {
    const res = await watch(handle, asUser(`u-${n % 8}`));
    assertEquals(res.status, 200);
    const viewer = sse(res);
    await viewer.next();
    open.push(viewer);
  }
  assertEquals((await watch(handle, asUser("u-new"))).status, 429);
  // The browser's channel counts its own.
  const browser = await watch(handle, asUser("u-new"), "live/stream");
  assertEquals(browser.status, 200);
  await browser.body!.cancel();
  await open.pop()!.cancel();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const again = await watch(handle, asUser("u-new"));
  assertEquals(again.status, 200);
  await again.body!.cancel();
  for (const viewer of open) await viewer.cancel();
});

test("one reader holds at most 4 of a run's viewers, and cannot lock the others out", async () => {
  const { handle } = makeApp();
  const open: Array<{ cancel: () => Promise<void> }> = [];
  for (let n = 0; n < 4; n++) {
    const res = await watch(handle, asUser("greedy"));
    assertEquals(res.status, 200);
    open.push(sse(res));
  }
  assertEquals((await watch(handle, asUser("greedy"))).status, 429);
  const other = await watch(handle, asUser("someone-else"));
  assertEquals(other.status, 200);
  await other.body!.cancel();
  // Leaving gives the place back to its holder.
  await open.pop()!.cancel();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const back = await watch(handle, asUser("greedy"));
  assertEquals(back.status, 200);
  await back.body!.cancel();
  for (const viewer of open) await viewer.cancel();
});

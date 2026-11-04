// The streams a drain has to end itself, over a real socket: `serve`'s `shutdown()` is what waits
// on them, so only a real listener shows whether it still does.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { serve } from "../src/serve.ts";
import { DrainingError, quietDrainErrors, trackStreams } from "../src/streams.ts";

const enc = new TextEncoder();

/** An SSE tail that never ends on its own, and says when its cleanup ran. */
function tail(cancelled: { value: boolean }): Response {
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode("event: sync\ndata: {}\n\n"));
      timer = setInterval(() => c.enqueue(enc.encode(": keepalive\n\n")), 50);
    },
    cancel() {
      clearInterval(timer);
      cancelled.value = true;
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** Resolves with how long `p` took, or "timeout" past `ms`. */
async function within(p: Promise<unknown>, ms: number): Promise<number | "timeout"> {
  const t0 = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const out = await Promise.race([
    p.then(() => performance.now() - t0),
    new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), ms))),
  ]);
  clearTimeout(timer);
  return out;
}

test("an open SSE tail no longer holds shutdown once the streams end", async () => {
  const streams = trackStreams();
  const cancelled = { value: false };
  const server = await serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    streams.wrap(() => tail(cancelled)),
  );
  const res = await fetch(`http://127.0.0.1:${server.addr.port}/`);
  const reader = res.body!.getReader();
  assert(!(await reader.read()).done);
  assertEquals(streams.open, 1);

  const shutdown = server.shutdown();
  streams.end();
  const took = await within(shutdown, 2_000);
  assert(took !== "timeout", "shutdown still waited on the tail");

  // The client sees an ordinary end, which an EventSource answers by reconnecting.
  while (!(await reader.read()).done) { /* the frames already in flight */ }
  assert(cancelled.value, "the tail's own cleanup did not run");
  assertEquals(streams.open, 0);
});

test("without end(), the same tail holds shutdown — the hang this exists for", async () => {
  const streams = trackStreams();
  const cancelled = { value: false };
  const server = await serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    streams.wrap(() => tail(cancelled)),
  );
  const res = await fetch(`http://127.0.0.1:${server.addr.port}/`);
  const reader = res.body!.getReader();
  await reader.read();
  const shutdown = server.shutdown();
  assertEquals(await within(shutdown, 300), "timeout");
  await reader.cancel();
  await shutdown;
});

test("an open NDJSON uplink is errored, so its handler answers and shutdown goes on", async () => {
  const streams = trackStreams();
  let seen = "";
  let failed: unknown = null;
  const server = await serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    streams.wrap(async (req) => {
      const reader = req.body!.pipeThrough(new TextDecoderStream()).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          seen += value;
        }
      } catch (err) {
        failed = err;
      }
      return Response.json({ seen });
    }),
  );
  let push: ReadableStreamDefaultController<Uint8Array> | undefined;
  const upload = new ReadableStream<Uint8Array>({ start: (c) => void (push = c) });
  // As the runner's uplinks do: a response ends the session, and the upload with it — the server
  // answering does not by itself close a connection whose body is still coming.
  const answered = fetch(`http://127.0.0.1:${server.addr.port}/`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: upload,
  }).then((r) => r.json()).finally(() => {
    try {
      push!.close();
    } catch {
      // Bun's fetch has already let go of the upload once the response is in; Deno's had not.
    }
  });
  push!.enqueue(enc.encode('{"a":1}\n'));
  for (let i = 0; i < 100 && streams.open === 0; i++) await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 100 && seen === ""; i++) await new Promise((r) => setTimeout(r, 10));
  assertEquals(seen, '{"a":1}\n');

  const shutdown = server.shutdown();
  streams.end();
  assertEquals(await answered, { seen: '{"a":1}\n' });
  assert((await within(shutdown, 2_000)) !== "timeout", "shutdown still waited on the uplink");
  // Errored, never closed: a body cut short must not read as a whole one.
  assert(failed instanceof Error && failed.name === "DrainingError", String(failed));
});

test("ordinary responses pass through untouched, and an SSE opened after end() closes", async () => {
  const streams = trackStreams();
  const cancelled = { value: false };
  const server = await serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    streams.wrap((req) =>
      new URL(req.url).pathname === "/tail" ? tail(cancelled) : Response.json({ ok: true }, {
        status: 201,
      })
    ),
  );
  const base = `http://127.0.0.1:${server.addr.port}`;
  const plain = await fetch(`${base}/plain`);
  assertEquals(plain.status, 201);
  assertEquals(await plain.json(), { ok: true });

  streams.end();
  const late = await fetch(`${base}/tail`);
  assertEquals(late.headers.get("content-type"), "text/event-stream");
  await late.body?.cancel();
  assert((await within(server.shutdown(), 2_000)) !== "timeout");
  assert(cancelled.value);
  assertEquals(streams.open, 0);
});

test("a cut work stream reaches the client as an error, not an ending", async () => {
  const streams = trackStreams({ work: () => true });
  const cancelled = { value: false };
  const server = await serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen: () => {},
      onError: () => new Response(null, { status: 500 }),
    },
    streams.wrap(() => tail(cancelled)),
  );
  const res = await fetch(`http://127.0.0.1:${server.addr.port}/`);
  const reader = res.body!.getReader();
  assert(!(await reader.read()).done);

  const shutdown = server.shutdown();
  streams.end();
  const took = await within(shutdown, 2_000);
  assert(took !== "timeout", "shutdown still waited on the reply");

  // A completion cut this way must not read as a whole one: the client's read fails.
  let failed = false;
  try {
    while (!(await reader.read()).done) { /* the frames already in flight */ }
  } catch {
    failed = true;
  }
  assert(failed, "the client saw a clean end");
  assert(cancelled.value, "the source's own cleanup did not run");
  assertEquals(streams.open, 0);
});

test("endTails() ends the tails and spares work, which end() then errors", async () => {
  const streams = trackStreams({ work: (req) => req.method === "POST" });
  const tailGone = { value: false };
  const workGone = { value: false };
  const server = await serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {}, onError: quietDrainErrors },
    streams.wrap((req) => tail(req.method === "POST" ? workGone : tailGone)),
  );
  const url = `http://127.0.0.1:${server.addr.port}/`;
  const tailReader = (await fetch(url)).body!.getReader();
  const workReader = (await fetch(url, { method: "POST" })).body!.getReader();
  assert(!(await tailReader.read()).done);
  assert(!(await workReader.read()).done);
  assertEquals(streams.open, 2);

  streams.endTails();
  while (!(await tailReader.read()).done) { /* the frames already in flight */ }
  assert(tailGone.value, "the tail was not ended");
  assert(!workGone.value, "the work stream was ended with the tails");
  assertEquals(streams.open, 1);
  // A tail opened now ends at once; work opened now would still run.
  const lateTail = (await fetch(url)).body!.getReader();
  while (!(await lateTail.read()).done) { /* ends */ }
  assertEquals(streams.open, 1);

  streams.end();
  let failed = false;
  try {
    while (!(await workReader.read()).done) { /* the frames already in flight */ }
  } catch {
    failed = true;
  }
  assert(failed, "the work stream ended cleanly");
  assertEquals(streams.open, 0);
  await server.shutdown();
});

test("quietDrainErrors keeps a drain's cuts out of stderr, and only those", () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args[0]);
  try {
    assertEquals(quietDrainErrors(new DrainingError()).status, 500);
    assertEquals(errors.length, 0);
    const other = new Error("something else");
    quietDrainErrors(other);
    assertEquals(errors, [other]);
  } finally {
    console.error = original;
  }
});

test("an NDJSON body the handler answers without reading is no longer tracked", async () => {
  const streams = trackStreams();
  const server = await serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    streams.wrap(() => new Response("refused", { status: 503 })),
  );
  const url = `http://127.0.0.1:${server.addr.port}/`;
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: '{"n":1}\n',
    });
    assertEquals(res.status, 503);
    await res.body?.cancel();
  }
  assertEquals(streams.open, 0);
  await server.shutdown();
});

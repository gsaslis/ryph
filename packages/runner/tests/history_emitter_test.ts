// The history emitter: the outbound channel for the run's permanent record. Pinned against a
// fake historian — emit never throws or blocks, batches land in seq order under the run's
// bearer, transient failures retry the same seqs (dedup upstream makes that safe), definitive
// rejections drop, overflow leaves an honest gap marker, and shutdown drains what it can.

import { test } from "bun:test";
import { serve } from "@ryph/service";
import { assert, assertEquals } from "@std/assert";
import { httpHistoryEmitter, MAX_BATCH_BYTES } from "../src/adapters/history/emitter.ts";
import { historyNarrator, teeNarrator } from "../src/adapters/narrator/history.ts";
import { historyDiagnostics, teeDiagnostics } from "../src/adapters/diagnostics/history.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";
import type { Narrator } from "../src/ports/narrator.ts";

const RUN_ID = "wi-hist-0001";
const TOKEN = "run-token-hist";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

interface WireEvent {
  lane?: string;
  seq: number;
  at: string;
  voice: string;
  kind: string;
  level: string | null;
  text: string | null;
  payload: unknown;
}

interface Recorded {
  path: string;
  auth: string | null;
  events: WireEvent[];
}

/** A fake historian ingest endpoint: records every batch, answers with a swappable responder. */
async function fakeHistorian() {
  const batches: Recorded[] = [];
  let respond: () => Response = () => new Response(JSON.stringify({ accepted: 0 }), key());
  const server = await serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const body = await req.json().catch(() => null);
      batches.push({
        path: new URL(req.url).pathname,
        auth: req.headers.get("authorization"),
        events: body?.events ?? [],
      });
      return respond();
    },
  );
  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    batches,
    setRespond(r: () => Response) {
      respond = r;
    },
    received: () => batches.flatMap((b) => b.events),
    shutdown: () => server.shutdown(),
  };
}

function key() {
  return { headers: { "content-type": "application/json" } };
}

function makeEmitter(
  url: string,
  overrides: Record<string, number> = {},
) {
  return httpHistoryEmitter({
    baseUrl: url,
    runToken: TOKEN,
    runId: RUN_ID,
    diag: noopDiagnostics(),
    flushIntervalMs: 20,
    backoffBaseMs: 30,
    shutdownDeadlineMs: 500,
    ...overrides,
  });
}

test("large history events split by encoded bytes and overflow the byte-bounded queue", async () => {
  const historian = await fakeHistorian();
  const emitter = makeEmitter(historian.url, {
    flushIntervalMs: 100_000,
    shutdownDeadlineMs: 3_000,
  });
  try {
    // Escaped control characters are six JSON bytes each, not one; each row nearly fills a batch.
    const text = "\u0000".repeat(128_000);
    for (let i = 0; i < 30; i++) emitter.emit({ voice: "transcript", kind: "assistant", text });
    // Critical retractions still survive a full byte buffer.
    emitter.emit({ voice: "transcript", kind: "final", payload: { seq: 0 }, keep: true });
    await emitter.shutdown();
    const events = historian.received();
    const prose = events.filter((e) => e.kind === "assistant");
    assert(prose.length > 0 && prose.length < 30);
    assert(prose.every((e) => e.text === text));
    assert(events.some((e) => e.kind === "final"));
    const gaps = events.filter((e) => e.kind === "history.dropped");
    assertEquals(
      gaps.reduce((n, e) => n + (e.payload as { count: number }).count, 0),
      30 - prose.length,
    );
    assertEquals(events.map((e) => e.seq), events.map((_, i) => i));
    for (const batch of historian.batches) {
      assert(
        new TextEncoder().encode(JSON.stringify({ events: batch.events })).byteLength <=
          MAX_BATCH_BYTES,
      );
    }
  } finally {
    await emitter.shutdown();
    await historian.shutdown();
  }
});

test("events batch up and land in seq order under the run's bearer", async () => {
  const historian = await fakeHistorian();
  const emitter = makeEmitter(historian.url);

  emitter.emit({ voice: "diag", kind: "pi.spawn", level: "debug", payload: { pid: 7 } });
  emitter.emit({ voice: "transcript", kind: "assistant", text: "hello", payload: { raw: 1 } });
  await until(() => historian.received().length === 2, "the first flush");
  await emitter.shutdown();

  assertEquals(historian.batches[0].path, `/v1/runs/${RUN_ID}/events`);
  assertEquals(historian.batches[0].auth, `Bearer ${TOKEN}`);
  const events = historian.received();
  assertEquals(events.map((e) => e.seq), [0, 1]);
  assertEquals(events[0], {
    seq: 0,
    at: events[0].at,
    voice: "diag",
    kind: "pi.spawn",
    level: "debug",
    text: null,
    payload: { pid: 7 },
  });
  assertEquals(events[1].voice, "transcript");
  assertEquals(events[1].text, "hello");
  await historian.shutdown();
});

test("a transient failure retries the SAME seqs; nothing is lost or renumbered", async () => {
  const historian = await fakeHistorian();
  let failing = true;
  historian.setRespond(() =>
    failing
      ? new Response("boom", { status: 503 })
      : new Response(JSON.stringify({ accepted: 1 }), key())
  );
  const emitter = makeEmitter(historian.url);

  emitter.emit({ voice: "transcript", kind: "assistant", text: "kept" });
  await until(() => historian.batches.length >= 1, "the failing attempt");
  failing = false;
  await until(
    () => historian.batches.length >= 2,
    "the retry after backoff",
  );
  await emitter.shutdown();

  const last = historian.batches[historian.batches.length - 1];
  assertEquals(last.events.map((e) => e.seq), historian.batches[0].events.map((e) => e.seq));
  assertEquals(last.events[0].text, "kept");
  await historian.shutdown();
});

test("a definitive 4xx drops the batch instead of wedging the queue", async () => {
  const historian = await fakeHistorian();
  let status = 400;
  historian.setRespond(() =>
    status === 400
      ? new Response("no", { status })
      : new Response(JSON.stringify({ accepted: 1 }), key())
  );
  const emitter = makeEmitter(historian.url);

  emitter.emit({ voice: "transcript", kind: "assistant", text: "rejected" });
  await until(() => historian.batches.length >= 1, "the rejected batch");
  status = 200;
  emitter.emit({ voice: "transcript", kind: "assistant", text: "after" });
  await until(
    () => historian.received().some((e) => e.text === "after"),
    "the next batch after the drop",
  );
  await emitter.shutdown();

  // The fake records even the batch it answered 400 to; what matters is that the emitter
  // never re-sent it — every batch after the rejection carries only newer events.
  const afterRejection = historian.batches.slice(1).flatMap((b) => b.events);
  assert(afterRejection.length > 0);
  assert(!afterRejection.some((e) => e.text === "rejected"));
  await historian.shutdown();
});

test("overflow drops incoming events and leaves an honest gap marker", async () => {
  const historian = await fakeHistorian();
  let blocked = true;
  historian.setRespond(() =>
    blocked
      ? new Response("down", { status: 503 })
      : new Response(JSON.stringify({ accepted: 1 }), key())
  );
  // Tiny buffer: 2 slots. Two events fill it; the third drops.
  const emitter = makeEmitter(historian.url, { maxBuffer: 2, maxBatch: 2 });

  emitter.emit({ voice: "transcript", kind: "assistant", text: "one" });
  emitter.emit({ voice: "transcript", kind: "assistant", text: "two" });
  emitter.emit({ voice: "transcript", kind: "assistant", text: "lost" });
  await until(() => historian.batches.length >= 1, "the first (failing) flush");
  blocked = false;
  await emitter.shutdown();

  const events = historian.received();
  assert(events.some((e) => e.text === "one") && events.some((e) => e.text === "two"));
  assert(!events.some((e) => e.text === "lost"));
  const gap = events.find((e) => e.kind === "history.dropped");
  assert(gap !== undefined, "the gap marker must be in the record");
  assertEquals(gap.payload, { count: 1, reason: "overflow" });
  assertEquals(gap.level, "warn");
  await historian.shutdown();
});

// The ingest schema validates a batch all-or-nothing and a 4xx is definitive, so one malformed
// event silently took up to 99 good ones with it. The overflow path has always left a marker; this
// path left only a line on the runner's stderr — nowhere the record's reader would ever see it.
test("a rejected batch leaves a gap marker, not a silent hole", async () => {
  const historian = await fakeHistorian();
  let reject = true;
  historian.setRespond(() =>
    reject
      ? new Response(JSON.stringify({ error: "events.2.text: Too big" }), { status: 400 })
      : new Response(JSON.stringify({ accepted: 1 }), key())
  );
  const emitter = makeEmitter(historian.url, { maxBatch: 3 });

  emitter.emit({ voice: "transcript", kind: "assistant", text: "one" });
  emitter.emit({ voice: "transcript", kind: "assistant", text: "two" });
  emitter.emit({ voice: "transcript", kind: "assistant", text: "three" });
  await until(() => historian.batches.length >= 1, "the rejected flush");
  reject = false;
  await emitter.shutdown();

  const gap = historian.received().find((e) => e.kind === "history.dropped");
  assert(gap !== undefined, "the record must admit the batch it lost");
  assertEquals(gap.payload, { count: 3, reason: "rejected" });
  assertEquals(gap.level, "warn");
  await historian.shutdown();
});

// A sink that refuses everything would otherwise mint a marker for the batch it rejected, then a
// marker for that marker, and never settle.
test("a sink rejecting everything settles instead of minting markers forever", async () => {
  const historian = await fakeHistorian();
  historian.setRespond(() => new Response(JSON.stringify({ error: "nope" }), { status: 401 }));
  const emitter = makeEmitter(historian.url, { maxBatch: 5, flushIntervalMs: 5 });

  emitter.emit({ voice: "transcript", kind: "assistant", text: "one" });
  emitter.emit({ voice: "transcript", kind: "assistant", text: "two" });
  await until(() => historian.batches.length >= 2, "the batch, then its marker");
  const settled = historian.batches.length;
  await new Promise((resolve) => setTimeout(resolve, 60)); // several more flush intervals

  assertEquals(
    historian.batches.length,
    settled,
    "nothing left to send: the marker's rejection must not mint another",
  );
  await emitter.shutdown();
  await historian.shutdown();
});

test("oversize and unserializable payloads are stubbed at the door", async () => {
  const historian = await fakeHistorian();
  const emitter = makeEmitter(historian.url);

  emitter.emit({ voice: "transcript", kind: "assistant", payload: { blob: "x".repeat(40_000) } });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  emitter.emit({ voice: "diag", kind: "cyclic.fields", level: "debug", payload: cyclic });
  emitter.emit({
    voice: "diag",
    kind: "err.fields",
    level: "warn",
    payload: { err: new Error("kaboom") },
  });
  await emitter.shutdown();

  const events = historian.received();
  const stub = events[0].payload as { truncated: boolean; bytes: number };
  assertEquals(stub.truncated, true);
  assert(stub.bytes > 40_000);
  // serializeValue flags the cycle instead of throwing.
  assertEquals((events[1].payload as { self: unknown }).self, "[Circular]");
  const err = (events[2].payload as { err: { message: string } }).err;
  assertEquals(err.message, "kaboom");
  await historian.shutdown();
});

// A truncated payload keeps what identifies it, and the reader depends on that across a package
// boundary: `app/lib/api/tools.ts` folds a tool_result onto its tool_use by `toolCallId`. When an
// oversize payload was replaced wholesale, that key went with the bulk — so a `read` of a large file
// left its row waiting forever on an answer that had already arrived, and rendered the answer again
// as a detached row. The scalars stay; only the bulk goes.
test("assistant prose survives payload truncation up to its own text limit", async () => {
  const historian = await fakeHistorian();
  const emitter = makeEmitter(historian.url);
  for (const length of [2_001, 8_001, 50_000, 128_000]) {
    const text = "x".repeat(length);
    emitter.emit({ voice: "transcript", kind: "assistant", text, payload: { text } });
  }
  await emitter.shutdown();
  const events = historian.received();
  assertEquals(events.map((e) => e.text?.length), [2_001, 8_001, 50_000, 128_000]);
  assertEquals((events[2].payload as { truncated: boolean }).truncated, true);
  await historian.shutdown();
});

test("over-long text is explicitly clipped without splitting Unicode", async () => {
  const historian = await fakeHistorian();
  const emitter = makeEmitter(historian.url);

  const marker = "\n\n[message truncated]";
  for (
    const [voice, kind, max] of [
      ["transcript", "assistant", 128_000],
      ["transcript", "tool_result", 8_000],
      ["diag", "assistant", 8_000],
    ] as const
  ) {
    const prefix = "x".repeat(max - marker.length - 1);
    emitter.emit({ voice, kind, text: prefix + "😀" + "y".repeat(100) });
  }
  await emitter.shutdown();

  const events = historian.received();
  for (const [index, max] of [128_000, 8_000, 8_000].entries()) {
    assertEquals(events[index].text, "x".repeat(max - marker.length - 1) + marker);
  }
  await historian.shutdown();
});

test("an oversize payload keeps the scalars that identify it", async () => {
  const historian = await fakeHistorian();
  const emitter = makeEmitter(historian.url);

  emitter.emit({
    voice: "transcript",
    kind: "tool_result",
    payload: {
      type: "tool_execution_end",
      toolCallId: "call-42",
      isError: false,
      result: { content: [{ type: "text", text: "x".repeat(40_000) }] },
    },
  });
  await emitter.shutdown();

  const payload = historian.received()[0].payload as Record<string, unknown>;
  assertEquals(payload.truncated, true);
  assertEquals(payload.toolCallId, "call-42", "the join key must survive truncation");
  assertEquals(payload.type, "tool_execution_end");
  assertEquals(payload.isError, false);
  // The bulk is what had to go — keeping it would defeat the point of the bound.
  assertEquals(payload.result, undefined);
  assert(JSON.stringify(payload)!.length < 1_000, "the stub must be small");
  await historian.shutdown();
});

test("an oversize tool result keeps the attachments its images name", async () => {
  const historian = await fakeHistorian();
  const emitter = makeEmitter(historian.url);

  emitter.emit({
    voice: "transcript",
    kind: "tool_result",
    payload: {
      type: "tool_execution_end",
      toolCallId: "call-7",
      result: {
        content: [
          { type: "text", text: "x".repeat(40_000) },
          {
            type: "image",
            mimeType: "image/png",
            data: "[16 base64 chars omitted]",
            attachment: { id: "att-1", mime: "image/png" },
          },
          { type: "image", mimeType: "image/bmp", data: "[8 base64 chars omitted]" },
          {
            type: "image",
            mimeType: "image/jpeg",
            data: "[9 base64 chars omitted]",
            attachment: { id: "att-2", mime: "image/jpeg" },
          },
        ],
      },
    },
  });
  // No image named, no `images` at all.
  emitter.emit({
    voice: "transcript",
    kind: "tool_result",
    payload: {
      toolCallId: "call-8",
      result: { content: [{ type: "text", text: "y".repeat(40_000) }] },
    },
  });
  await emitter.shutdown();

  const [kept, plain] = historian.received().map((e) => e.payload as Record<string, unknown>);
  assertEquals(kept.truncated, true);
  assertEquals(kept.toolCallId, "call-7");
  assertEquals(kept.images, [{ id: "att-1", mime: "image/png" }, {
    id: "att-2",
    mime: "image/jpeg",
  }]);
  assertEquals(kept.result, undefined);
  assertEquals("images" in plain, false);
  await historian.shutdown();
});

test("a truncation stub cannot smuggle the bulk back in", async () => {
  const historian = await fakeHistorian();
  const emitter = makeEmitter(historian.url);

  // A long string field is bulk wearing a scalar's clothes, and thousands of small ones rebuild the
  // payload a field at a time. Both must reduce to the bare stub.
  emitter.emit({
    voice: "transcript",
    kind: "assistant",
    payload: { id: "keep-me", blob: "x".repeat(40_000) },
  });
  const manyFields: Record<string, string> = {};
  for (let i = 0; i < 5_000; i++) manyFields[`f${i}`] = "y".repeat(20);
  emitter.emit({ voice: "transcript", kind: "assistant", payload: manyFields });
  await emitter.shutdown();

  const [big, many] = historian.received();
  const bigPayload = big.payload as Record<string, unknown>;
  assertEquals(bigPayload.id, "keep-me", "a short scalar identifies and stays");
  assertEquals(bigPayload.blob, undefined, "a 40k string is bulk, not identity");

  const manyPayload = many.payload as Record<string, unknown>;
  assertEquals(manyPayload.truncated, true);
  assert(
    JSON.stringify(manyPayload)!.length <= 32_000,
    "the stub must stay under the bound it was reduced to satisfy",
  );
  await historian.shutdown();
});

test("emit never throws and never blocks, even with no listener at all", async () => {
  // A port that answers nothing: connection refused on every flush.
  const emitter = httpHistoryEmitter({
    baseUrl: "http://127.0.0.1:9",
    runToken: TOKEN,
    runId: RUN_ID,
    diag: noopDiagnostics(),
    flushIntervalMs: 10,
    backoffBaseMs: 10,
    shutdownDeadlineMs: 100,
  });
  const t0 = Date.now();
  for (let i = 0; i < 500; i++) {
    emitter.emit({ voice: "transcript", kind: "assistant", text: `n${i}` });
  }
  assert(Date.now() - t0 < 500, "emit must be instant");
  await emitter.shutdown(); // must return by its deadline despite the dead sink
});

test("shutdown drains the queue, then further emits are dropped silently", async () => {
  const historian = await fakeHistorian();
  const emitter = makeEmitter(historian.url, { flushIntervalMs: 60_000 }); // timer effectively off

  emitter.emit({ voice: "transcript", kind: "assistant", text: "drained" });
  await emitter.shutdown();
  assertEquals(historian.received().map((e) => e.text), ["drained"]);

  emitter.emit({ voice: "transcript", kind: "assistant", text: "late" });
  await emitter.shutdown(); // idempotent
  await sleep(30);
  assertEquals(historian.received().length, 1);
  await historian.shutdown();
});

test("the tees fan out to both legs and survive a broken one", () => {
  const chunks: string[] = [];
  const events: string[] = [];
  const broken: Narrator = {
    emit() {
      throw new Error("broken leg");
    },
  };
  const collecting: Narrator = {
    emit(_runId, chunk) {
      chunks.push(chunk.kind);
    },
  };
  const narrator = teeNarrator(broken, collecting);
  narrator.emit(RUN_ID, { kind: "assistant", text: "x" });
  assertEquals(chunks, ["assistant"]);

  const collectingDiag = {
    debug: (event: string) => {
      events.push(`debug:${event}`);
    },
    warn: (event: string) => {
      events.push(`warn:${event}`);
    },
  };
  const throwingDiag = {
    debug: () => {
      throw new Error("broken sink");
    },
    warn: () => {
      throw new Error("broken sink");
    },
  };
  const diag = teeDiagnostics(throwingDiag, collectingDiag);
  diag.debug("pi.spawn");
  diag.warn("pi.exit");
  assertEquals(events, ["debug:pi.spawn", "warn:pi.exit"]);
});

// The seq is what a back-reference is made of, so `emit` has to say which one it stamped — and
// say nothing at all when it stamped none, rather than name an event that was never recorded.
test("emit answers with the seq it stamped, and with nothing when it dropped the event", async () => {
  const historian = await fakeHistorian();
  const emitter = makeEmitter(historian.url, {
    maxBuffer: 2,
    maxBatch: 100,
    flushIntervalMs: 50_000,
  });

  assertEquals(emitter.emit({ voice: "transcript", kind: "assistant", text: "one" }), 0);
  assertEquals(emitter.emit({ voice: "transcript", kind: "assistant", text: "two" }), 1);
  // The buffer is full: this one is dropped, so there is no seq to hand back.
  assertEquals(emitter.emit({ voice: "transcript", kind: "assistant", text: "lost" }), undefined);

  await emitter.shutdown();
  // ...and a shut-down emitter records nothing either.
  assertEquals(emitter.emit({ voice: "transcript", kind: "assistant", text: "late" }), undefined);
  await historian.shutdown();
});

// Dropping an ordinary event shortens the record, and the gap marker admits it. Dropping a
// `final` mark's RETRACTION is different: it leaves the mark it was meant to take back standing,
// and a reader acting on it folds a message away with nothing to say anything went missing. A
// run that overflows near its end is exactly when that would happen.
test("a kept event survives a full buffer; an ordinary one still drops", async () => {
  const historian = await fakeHistorian();
  const emitter = makeEmitter(historian.url, {
    maxBuffer: 2,
    maxBatch: 100,
    flushIntervalMs: 50_000,
  });

  emitter.emit({ voice: "transcript", kind: "assistant", text: "one" });
  emitter.emit({ voice: "transcript", kind: "assistant", text: "two" });
  // The buffer is full from here.
  assertEquals(emitter.emit({ voice: "transcript", kind: "assistant", text: "lost" }), undefined);
  const kept = emitter.emit({
    voice: "transcript",
    kind: "final",
    payload: { seq: null },
    keep: true,
  });
  assertEquals(typeof kept, "number");

  await emitter.shutdown();
  const events = historian.received();
  assert(!events.some((e) => e.text === "lost"), "the ordinary event still drops");
  const mark = events.find((e) => e.kind === "final");
  assert(mark !== undefined, "the kept event is in the record");
  assertEquals(mark.payload, { seq: null });
  // ...and `keep` is a queueing instruction, never part of the record.
  assert(!("keep" in mark), "keep must not ride the wire");
  // The drop is still admitted, so the hole the overflow left is not silent.
  assert(events.some((e) => e.kind === "history.dropped"));
  await historian.shutdown();
});

test("the history voice adapters map chunk and diag shapes onto the emitter", async () => {
  const historian = await fakeHistorian();
  const emitter = makeEmitter(historian.url);
  const narrator = historyNarrator(emitter);
  const diag = historyDiagnostics(emitter);

  // The narrator hands the emitter's seq back: it is the only handle a writer keeps on an
  // event it has already let go of (the pi adapter's `final` mark names one).
  assertEquals(narrator.emit(RUN_ID, { kind: "tool_use", text: "$ ls", raw: { tool: "bash" } }), 0);
  diag.warn("credentials.revoke_failed", { attempt: 2 });
  await emitter.shutdown();

  const events = historian.received();
  assertEquals(events[0], {
    seq: 0,
    at: events[0].at,
    voice: "transcript",
    kind: "tool_use",
    level: null,
    text: "$ ls",
    payload: { tool: "bash" },
  });
  assertEquals(events[1], {
    seq: 1,
    at: events[1].at,
    voice: "diag",
    kind: "credentials.revoke_failed",
    level: "warn",
    text: null,
    payload: { attempt: 2 },
  });
  await historian.shutdown();
});

// A subagent writes a lane of its own (core/subagents.ts): one seq counter per lane, so the run's
// own seqs stay contiguous and a gap the main transcript draws is never inflated by a child's.
test("each lane counts its own seqs; the run's own keeps its counter and leaves `lane` off the wire", async () => {
  const historian = await fakeHistorian();
  const emitter = makeEmitter(historian.url);
  const narrator = historyNarrator(emitter);

  assertEquals(narrator.emit(RUN_ID, { kind: "assistant", text: "main 1" }), 0);
  assertEquals(
    narrator.emit(RUN_ID, { kind: "subagent.start", text: "look", raw: { id: "sa-1" } }, "sa-1"),
    1,
  );
  assertEquals(narrator.emit(RUN_ID, { kind: "assistant", text: "child 1" }, "sa-1"), 2);
  assertEquals(narrator.emit(RUN_ID, { kind: "assistant", text: "main 2" }), 1);
  assertEquals(narrator.emit(RUN_ID, { kind: "assistant", text: "other 1" }, "sa-2"), 1);
  assertEquals(narrator.emit(RUN_ID, { kind: "assistant", text: "main 3" }, ""), 2);
  await emitter.shutdown();

  const events = historian.received();
  // Every lane through the one client, in emit order.
  assertEquals(events.map((e) => [e.lane ?? "", e.seq, e.text]), [
    ["", 0, "main 1"],
    ["sa-1", 1, "look"],
    ["sa-1", 2, "child 1"],
    ["", 1, "main 2"],
    ["sa-2", 1, "other 1"],
    ["", 2, "main 3"],
  ]);
  assert(!("lane" in events[0]), "the run's own lane rides the wire as it always has");
  assertEquals(events[1].lane, "sa-1");
  await historian.shutdown();
});

test("a lane's start and end are kept past a full buffer, and its gap marker lands in that lane", async () => {
  const historian = await fakeHistorian();
  const emitter = makeEmitter(historian.url, {
    maxBuffer: 2,
    maxBatch: 100,
    flushIntervalMs: 50_000,
  });
  const narrator = historyNarrator(emitter);

  narrator.emit(RUN_ID, { kind: "assistant", text: "main" });
  narrator.emit(RUN_ID, { kind: "assistant", text: "child" }, "sa-1");
  // Full from here: the lane's ordinary row drops, its lifecycle rows do not.
  assertEquals(narrator.emit(RUN_ID, { kind: "assistant", text: "lost" }, "sa-1"), undefined);
  for (const kind of ["subagent.start", "subagent.resume", "subagent.end"] as const) {
    assertEquals(typeof narrator.emit(RUN_ID, { kind, raw: { id: "sa-1" } }, "sa-1"), "number");
  }
  // The steer a child was handed is ordinary narration.
  assertEquals(
    narrator.emit(RUN_ID, { kind: "subagent.message", text: "x", raw: { id: "sa-1" } }, "sa-1"),
    undefined,
  );
  await emitter.shutdown();

  const events = historian.received();
  assert(!events.some((e) => e.text === "lost"));
  assertEquals(
    events.filter((e) => e.kind.startsWith("subagent.")).map((e) => [e.lane, e.kind]),
    [["sa-1", "subagent.start"], ["sa-1", "subagent.resume"], ["sa-1", "subagent.end"]],
  );
  // The hole is admitted where a reader of that lane looks, and the main lane has none.
  const gaps = events.filter((e) => e.kind === "history.dropped");
  assertEquals(gaps.map((g) => [g.lane, g.payload]), [["sa-1", { count: 2, reason: "overflow" }]]);
  // ...on the lane's own counter, after what it has.
  const laneSeqs = events.filter((e) => e.lane === "sa-1").map((e) => e.seq);
  assertEquals(laneSeqs, [...laneSeqs].sort((a, b) => a - b));
  assertEquals(new Set(laneSeqs).size, laneSeqs.length);
  await historian.shutdown();
});

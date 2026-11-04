// The live hub: the snapshot line first, then the bounded rings of recent console, network and
// action lines replayed, one consumer at a time, and a bounded backlog for a stalled reader.
// Plus the shaping rules: console levels, which requests the stream carries, JPEG sizes.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  CONSOLE_TEXT_CAP,
  consoleLevel,
  FAILURE_CAP,
  type Frame,
  jpegSize,
  jpegSizeOfBase64,
  LiveHub,
  networkWanted,
  REPLAY_RINGS,
  SUMMARY_CAP,
  URL_CAP,
} from "../src/core/live.ts";

const frame = (tabId = "t1"): Frame => ({
  mime: "image/jpeg",
  data: "AAAA",
  width: 1280,
  height: 800,
  tabId,
  viewport: { width: 1280, height: 800 },
});

async function readLines(stream: ReadableStream<Uint8Array>, n: number): Promise<unknown[]> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  const out: unknown[] = [];
  while (out.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      out.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  }
  reader.releaseLock();
  return out;
}

test("a consumer's first line is the snapshot of the state so far", async () => {
  const hub = new LiveHub(() => 42);
  hub.setStatus("active");
  hub.setTabs([{ id: "t1", url: "http://x/", title: "X", active: true }]);
  hub.setFrame(frame());
  const [first] = await readLines(hub.attach(), 1);
  assertEquals(first, {
    type: "snapshot",
    at: 42,
    status: "active",
    tabs: [{ id: "t1", url: "http://x/", title: "X", active: true }],
    frame: frame(),
  });
});

test("events reach the attached consumer in order; unchanged state is not repeated", async () => {
  const hub = new LiveHub(() => 1);
  const stream = hub.attach();
  hub.setStatus("launching");
  hub.setStatus("launching");
  hub.setTabs([]);
  hub.emit({ type: "action", at: 1, tool: "click", summary: "Clicked “Go”" });
  hub.setStatus("active");
  const lines = await readLines(stream, 4) as Array<{ type: string; status?: string }>;
  assertEquals(lines.map((l) => l.type), ["snapshot", "status", "action", "status"]);
  assertEquals(lines[3].status, "active");
});

test("a new consumer replaces the old one, whose stream ends", async () => {
  const hub = new LiveHub();
  const first = hub.attach();
  const second = hub.attach();
  const reader = first.getReader();
  await reader.read(); // its snapshot line
  assertEquals((await reader.read()).done, true);
  hub.setStatus("active");
  const lines = await readLines(second, 2);
  assertEquals(lines.length, 2);
});

test("a new consumer gets the snapshot, then the recent lines in the order they happened, then live", async () => {
  const hub = new LiveHub(() => 7);
  hub.setStatus("active");
  // Before anyone listens: kept.
  hub.emit({ type: "console", at: 1, tabId: "t1", level: "log", text: "one" });
  hub.emit({
    type: "network",
    at: 2,
    tabId: "t1",
    method: "GET",
    url: "http://x/",
    resourceType: "document",
    status: 200,
  });
  const first = hub.attach();
  hub.emit({ type: "action", at: 3, tool: "click", summary: "Clicked “Go”" });
  hub.emit({ type: "console", at: 4, tabId: "t1", level: "warn", text: "two" });
  const seen = await readLines(first, 4) as Array<{ type: string; at: number }>;
  assertEquals(seen.map((l) => `${l.type}@${l.at}`), [
    "snapshot@7",
    "console@1",
    "network@2",
    "action@3",
  ]);

  // A reconnect: the second consumer is replayed everything, both what the first saw and not.
  const second = hub.attach();
  hub.emit({ type: "console", at: 5, tabId: "t1", level: "error", text: "three" });
  const replayed = await readLines(second, 6) as Array<{ type: string; at: number }>;
  assertEquals(replayed.map((l) => `${l.type}@${l.at}`), [
    "snapshot@7",
    "console@1",
    "network@2",
    "action@3",
    "console@4",
    "console@5",
  ]);
});

test("the replay rings are bounded in count and in size, however long the run", async () => {
  const hub = new LiveHub();
  const huge = "x".repeat(100_000);
  for (let i = 0; i < 5_000; i++) {
    hub.emit({
      type: "console",
      at: i,
      tabId: "t1",
      level: "log",
      text: huge,
      source: { url: huge },
    });
    hub.emit({
      type: "network",
      at: i,
      tabId: "t1",
      method: "GET",
      url: huge,
      resourceType: "fetch",
      failure: huge,
    });
    hub.emit({ type: "action", at: i, tool: "click", summary: huge });
  }
  const replay = hub.replay();
  const count = (type: string) => replay.filter((e) => e.type === type).length;
  assertEquals(count("console"), REPLAY_RINGS.console);
  assertEquals(count("network"), REPLAY_RINGS.network);
  assertEquals(count("action"), REPLAY_RINGS.action);
  // The newest kept, oldest first.
  assertEquals(replay[0].at, 5_000 - REPLAY_RINGS.console);
  assertEquals(replay.at(-1)!.at, 4_999);
  for (const e of replay) {
    if (e.type === "console") {
      assert(e.text.length <= CONSOLE_TEXT_CAP && e.source!.url.length <= URL_CAP);
    } else if (e.type === "network") {
      assert(e.url.length <= URL_CAP && e.failure!.length <= FAILURE_CAP);
    } else assert(e.summary.length <= SUMMARY_CAP);
  }
  // What a new consumer is sent: the snapshot and the replay, a few MB at the very most.
  const reader = hub.attach().getReader();
  let bytes = 0;
  for (let i = 0; i < 2; i++) bytes += (await reader.read()).value!.length;
  assert(bytes < 3 * 1024 * 1024, `replay was ${bytes} bytes`);
  reader.releaseLock();
});

test("a frame arriving straight after a long replay still reaches the consumer", async () => {
  const hub = new LiveHub();
  for (let i = 0; i < 900; i++) hub.emit({ type: "action", at: i, tool: "click", summary: "x" });
  const stream = hub.attach();
  hub.setFrame(frame("t2"));
  const lines = await readLines(stream, 2 + REPLAY_RINGS.action) as Array<{ type: string }>;
  assertEquals(lines.at(-1)!.type, "frame");
});

test("a stalled consumer gets no more frames past a small backlog", () => {
  const hub = new LiveHub();
  hub.attach(); // never read
  for (let i = 0; i < 50; i++) hub.setFrame(frame());
  // The hub still knows the latest frame for the next snapshot.
  assert(hub.frame !== null);
  // Other events still queue (up to the larger cap).
  hub.emit({ type: "action", at: 1, tool: "click", summary: "x" });
});

test("clearFrame forgets the frame of a tab no longer shown", () => {
  const hub = new LiveHub();
  hub.setFrame(frame());
  hub.clearFrame();
  assertEquals((hub.snapshot() as { frame: unknown }).frame, null);
});

test("Playwright's console types map onto the five levels", () => {
  assertEquals(consoleLevel("warning"), "warn");
  assertEquals(consoleLevel("error"), "error");
  assertEquals(consoleLevel("assert"), "error");
  assertEquals(consoleLevel("debug"), "debug");
  assertEquals(consoleLevel("table"), "log");
  assertEquals(consoleLevel("dir"), "log");
});

test("documents, fetch/XHR and every failure are carried; the rest is not", () => {
  assert(networkWanted("document", false));
  assert(networkWanted("fetch", false));
  assert(networkWanted("xhr", false));
  assert(!networkWanted("image", false));
  assert(networkWanted("image", true));
});

test("a JPEG's size comes from its SOF marker", () => {
  // SOI, an APP0 segment of length 4, then SOF0 with height 600 and width 800.
  const bytes = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0x02,
    0x58,
    0x03,
    0x20,
    0x03,
    0x01,
    0x22,
    0x00,
  ]);
  assertEquals(jpegSize(bytes), { width: 800, height: 600 });
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  assertEquals(jpegSizeOfBase64(btoa(bin)), { width: 800, height: 600 });
  assertEquals(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
  assertEquals(jpegSizeOfBase64("not base64!"), null);
});

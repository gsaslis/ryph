// What one run's uplink may make the historian hold. The uplink's run token is one the agent can
// read, so every line is the agent's to choose: these pin that the schema keeps known shapes with
// bounded strings, that each kind of line has its cap, and that a room, a viewer and a snapshot
// stay within their byte budgets however the lines are crafted. The first regression is the one
// that was measured: 900 lines with a 500 KB unknown field grew the heap by 349 MB.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  liveLineCap,
  MAX_FRAME_DATA_CHARS,
  MAX_LIVE_EVENT_LINE,
  MAX_LIVE_FRAME_LINE,
  MAX_LIVE_TABS,
  parseLiveLine,
} from "../src/schema.ts";
import { type LiveEvent, type LiveOut, makeLiveRooms, ROOM_BUDGET } from "../src/core/live.ts";

/** A viewer the room took: these tests never reach the viewer cap unless they say so. */
function watching<V>(
  rooms: { watch(runId: string, opts?: { terminal?: boolean; principal?: string }): V | "full" },
  runId: string,
  opts?: { terminal?: boolean; principal?: string },
): V {
  const viewer = rooms.watch(runId, opts);
  if (viewer === "full") throw new Error("the room refused a viewer");
  return viewer;
}

const MB = 1024 * 1024;
const consoleLine = (extra: Record<string, unknown> = {}) => ({
  type: "console",
  at: 1,
  tabId: "t1",
  level: "log",
  text: "hi",
  ...extra,
});
const frameLine = (data: string, extra: Record<string, unknown> = {}) => ({
  type: "frame",
  at: 1,
  frame: { mime: "image/jpeg", data, width: 1280, height: 800, tabId: "t1", ...extra },
});
const parse = (value: unknown) => parseLiveLine(JSON.stringify(value));

test("regression: 900 lines with a 500 KB unknown field are refused, not held", () => {
  const rooms = makeLiveRooms();
  const uplink = rooms.openUplink("r1");
  assert(typeof uplink !== "string");
  let oversize = 0;
  for (let i = 0; i < 900; i++) {
    const event = parse({
      type: i % 2 ? "console" : "action",
      at: i,
      tabId: "t",
      level: "log",
      text: "",
      tool: "x",
      summary: "",
      junk: "y".repeat(500_000) + i,
    });
    if (event === "oversize") oversize++;
    else if (event !== "malformed") uplink.push(event);
  }
  assertEquals(oversize, 900);
  const snapshot = watching(rooms, "r1").take()!;
  assert(JSON.stringify(snapshot.data).length < 1024);
});

test("regression: the largest lines that pass still leave the room within its budget", () => {
  const rooms = makeLiveRooms();
  const uplink = rooms.openUplink("r1");
  assert(typeof uplink !== "string");
  const before = process.memoryUsage().heapUsed;
  // Each just under the 16 KB cap, unknown fields stripped, the text clipped to 8 KB.
  for (let i = 0; i < 900; i++) {
    const kind = i % 3;
    const raw = kind === 0
      ? consoleLine({ at: i, text: "x".repeat(7_000) + i, source: { url: "u".repeat(4_000) } })
      : kind === 1
      ? {
        type: "network",
        at: i,
        tabId: "t1",
        method: "GET",
        url: "u".repeat(4_000) + i,
        resourceType: "fetch",
        failure: "f".repeat(4_000),
      }
      : { type: "action", at: i, tool: "click", summary: "s".repeat(12_000) + i };
    const line = JSON.stringify(raw);
    assert(line.length <= MAX_LIVE_EVENT_LINE);
    const event = parseLiveLine(line);
    assert(typeof event !== "string", `line ${i} is accepted`);
    uplink.push(event);
  }
  // A frame at the decoded cap, which the budget counts too.
  const big = parseLiveLine(JSON.stringify(frameLine("A".repeat(MAX_FRAME_DATA_CHARS))));
  assert(typeof big !== "string");
  uplink.push(big);

  const viewers = Array.from(
    { length: 20 },
    (_, i) => watching(rooms, "r1", { principal: `p-${i}` }),
  );
  const snapshots = viewers.map((viewer) => viewer.take()!);
  const heapMb = (process.memoryUsage().heapUsed - before) / MB;
  const json = JSON.stringify(snapshots[0].data);
  console.log(`heap +${heapMb.toFixed(1)} MB, snapshot ${(json.length / MB).toFixed(2)} MB`);
  assert(json.length <= ROOM_BUDGET * 1.1, `snapshot is ${json.length} bytes`);
  assert(snapshots.every((s) => s.data === snapshots[0].data), "one snapshot, shared");
  assert(heapMb < 64, `heap grew ${heapMb} MB`);
});

test("unknown fields are dropped; a frame's viewport is kept", () => {
  const event = parse(consoleLine({ junk: "x", source: { url: "a", line: 3, more: 1 } }));
  assertEquals(event, {
    type: "console",
    at: 1,
    tabId: "t1",
    level: "log",
    text: "hi",
    source: { url: "a", line: 3 },
  } as LiveEvent);
  const frame = parse(frameLine("QUJD", { viewport: { width: 1, height: 2 }, extra: true }));
  assertEquals(frame, frameLine("QUJD", { viewport: { width: 1, height: 2 } }) as LiveEvent);
});

test("free text is clipped; identifiers over their bound fail the line", () => {
  const event = parse(consoleLine({ text: "x".repeat(9_000) }));
  assert(typeof event !== "string" && event.type === "console");
  assertEquals(event.text.length, 8 * 1024);
  assert(event.text.endsWith("…"));

  const action = parse({ type: "action", at: 1, tool: "click", summary: "s".repeat(2_000) });
  assert(typeof action !== "string" && action.type === "action");
  assertEquals(action.summary.length, 1024);

  assertEquals(parse({ type: "action", at: 1, tool: "t".repeat(65), summary: "" }), "malformed");
  const tab = { id: "t", url: "u", title: "t", active: true };
  assertEquals(
    parse({ type: "tabs", at: 1, tabs: Array(MAX_LIVE_TABS + 1).fill(tab) }),
    "malformed",
  );
  assert(typeof parse({ type: "tabs", at: 1, tabs: Array(MAX_LIVE_TABS).fill(tab) }) !== "string");
});

test("a frame's data must be base64 within the decoded cap", () => {
  assertEquals(parse(frameLine('"><script>')), "malformed");
  assertEquals(parse(frameLine("A".repeat(MAX_FRAME_DATA_CHARS + 4))), "malformed");
  assert(typeof parse(frameLine("A".repeat(MAX_FRAME_DATA_CHARS))) !== "string");
});

test("lines are capped by type", () => {
  assertEquals(liveLineCap("console"), MAX_LIVE_EVENT_LINE);
  assertEquals(liveLineCap("frame"), MAX_LIVE_FRAME_LINE);
  assertEquals(parse(consoleLine({ pad: "x".repeat(MAX_LIVE_EVENT_LINE) })), "oversize");
  // A frame line far over the small cap is fine.
  assert(typeof parse(frameLine("A".repeat(400_000))) !== "string");
});

test("a slow viewer's queue stays within its byte budget", () => {
  const rooms = makeLiveRooms({ viewerBudget: 64 * 1024 });
  const uplink = rooms.openUplink("r1");
  assert(typeof uplink !== "string");
  const viewer = watching(rooms, "r1");
  for (let i = 0; i < 100; i++) {
    uplink.push({ type: "console", at: i, tabId: "t1", level: "log", text: "x".repeat(8_000) });
  }
  const out: LiveOut[] = [];
  for (let item = viewer.take(); item !== null; item = viewer.take()) out.push(item);
  assertEquals(out[0].event, "snapshot");
  assertEquals(out[1].event, "dropped");
  const kept = out.slice(2);
  assert(kept.length > 0 && kept.length <= 8, `kept ${kept.length}`);
  assertEquals((out[1].data as { count: number }).count + kept.length, 100);
  assertEquals((kept.at(-1)!.data as { at: number }).at, 99, "the newest survive");
});

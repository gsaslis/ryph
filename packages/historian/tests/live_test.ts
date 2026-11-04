// The live room registry, driven directly with a fake clock: what a viewer's snapshot holds, that
// frames coalesce and everything else queues with a cap, the rings' bounds, uplink replacement,
// conclusion, expiry, and the cap on rooms held.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  CONSOLE_RING,
  type LiveEvent,
  type LiveFrame,
  type LiveOut,
  type LiveViewer,
  makeLiveRooms,
} from "../src/core/live.ts";

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

const frameOf = (n: number): LiveFrame => ({
  mime: "image/jpeg",
  data: `frame-${n}`,
  width: 1280,
  height: 800,
  tabId: "t1",
});
const frame = (n: number): LiveEvent => ({ type: "frame", at: n, frame: frameOf(n) });
const consoleLine = (n: number): LiveEvent => ({
  type: "console",
  at: n,
  tabId: "t1",
  level: "log",
  text: `line ${n}`,
});

/** Everything waiting for a viewer right now. */
function drain(viewer: LiveViewer): LiveOut[] {
  const out: LiveOut[] = [];
  for (let item = viewer.take(); item !== null; item = viewer.take()) out.push(item);
  return out;
}

function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return { now: () => at, advance: (ms) => (at += ms) };
}

test("a viewer starts with the room's snapshot, then sees each event", () => {
  const rooms = makeLiveRooms();
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  uplink.push({ type: "status", at: 1, status: "active" });
  uplink.push(frame(2));
  uplink.push(consoleLine(3));
  uplink.push({ type: "action", at: 4, tool: "click", summary: "Clicked “Go”" });

  const viewer = watching(rooms, "run-1");
  const [snapshot, ...rest] = drain(viewer);
  assertEquals(rest, []);
  assertEquals(snapshot.event, "snapshot");
  if (snapshot.event !== "snapshot") return;
  assertEquals(snapshot.data.uplink, true);
  assertEquals(snapshot.data.status, "active");
  assertEquals(snapshot.data.frame?.data, "frame-2");
  assertEquals(snapshot.data.console.length, 1);
  assertEquals(snapshot.data.actions.map((a) => a.tool), ["click"]);

  uplink.push(consoleLine(5));
  assertEquals(drain(viewer).map((o) => o.event), ["console"]);
});

test("a viewer can wait on a run whose browser has not started yet", async () => {
  const rooms = makeLiveRooms();
  const viewer = watching(rooms, "run-1");
  const [snapshot] = drain(viewer);
  assertEquals(snapshot, {
    event: "snapshot",
    data: {
      uplink: false,
      status: "idle",
      tabs: [],
      frame: null,
      console: [],
      network: [],
      actions: [],
    },
  });

  const woken = viewer.ready();
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  await woken;
  const [opened, ...rest] = drain(viewer);
  assertEquals(rest, []);
  assertEquals(opened.event, "snapshot", "the uplink opening is a fresh snapshot that says so");
  assertEquals((opened.data as { uplink: boolean }).uplink, true);
});

test("frames coalesce for a viewer that is behind; other events keep their order", () => {
  const rooms = makeLiveRooms();
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  const viewer = watching(rooms, "run-1");
  drain(viewer);

  uplink.push(frame(1));
  uplink.push(consoleLine(2));
  for (let n = 3; n <= 50; n++) uplink.push(frame(n));
  uplink.push(consoleLine(51));

  const out = drain(viewer);
  // One frame, in the slot the first pending one took, holding the newest picture.
  assertEquals(out.map((o) => o.event), ["frame", "console", "console"]);
  assertEquals((out[0].data as { frame: LiveFrame }).frame.data, "frame-50");
});

test("a viewer's queue is capped: the oldest go, and the viewer is told how many", () => {
  const rooms = makeLiveRooms({ viewerQueue: 3 });
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  const viewer = watching(rooms, "run-1");

  for (let n = 0; n < 6; n++) uplink.push(consoleLine(n));
  uplink.push(frame(9));

  const out = drain(viewer);
  // The snapshot is never dropped (but counts toward the cap); four of the six lines are.
  assertEquals(out.map((o) => o.event), ["snapshot", "dropped", "console", "console", "frame"]);
  assertEquals(out[1].data, { count: 4 });
  assertEquals(
    out.filter((o) => o.event === "console").map((o) => (o.data as { text: string }).text),
    ["line 4", "line 5"],
  );
});

test("the rings hold only the newest", () => {
  const rooms = makeLiveRooms();
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  for (let n = 0; n < CONSOLE_RING + 20; n++) uplink.push(consoleLine(n));

  const [snapshot] = drain(watching(rooms, "run-1"));
  if (snapshot.event !== "snapshot") throw new Error("expected a snapshot");
  assertEquals(snapshot.data.console.length, CONSOLE_RING);
  assertEquals(snapshot.data.console[0].text, "line 20");
});

test("the producer's own snapshot updates the room, and a null frame keeps the last picture", () => {
  const rooms = makeLiveRooms();
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  uplink.push(frame(1));
  const viewer = watching(rooms, "run-1");
  drain(viewer);

  const tabs = [{ id: "t1", url: "http://localhost:5173/", title: "App", active: true }];
  uplink.push({ type: "snapshot", at: 2, status: "active", tabs, frame: null });

  assertEquals(drain(viewer).map((o) => o.event), ["status", "tabs"]);
  const [snapshot] = drain(watching(rooms, "run-1"));
  if (snapshot.event !== "snapshot") throw new Error("expected a snapshot");
  assertEquals(snapshot.data.tabs, tabs);
  assertEquals(snapshot.data.frame?.data, "frame-1");
});

test("a new uplink replaces the old, which can no longer write or disconnect the room", () => {
  const rooms = makeLiveRooms();
  const first = rooms.openUplink("run-1");
  assert(typeof first !== "string");
  const viewer = watching(rooms, "run-1");
  drain(viewer);

  const second = rooms.openUplink("run-1");
  assert(typeof second !== "string");
  assert(first.signal.aborted);
  assert(!second.signal.aborted);

  // The viewer is handed the room as the new uplink starts it.
  assertEquals(drain(viewer).map((o) => o.event), ["snapshot"]);
  first.push(consoleLine(1));
  first.close();
  // No uplink flap either: the room was connected throughout.
  assertEquals(drain(viewer), []);

  second.push(consoleLine(2));
  second.close();
  assertEquals(drain(viewer).map((o) => o.event), ["console", "uplink"]);
});

test("conclusion hangs up the uplink, says done, and refuses a new uplink", async () => {
  const rooms = makeLiveRooms();
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  uplink.push(frame(1));
  const viewer = watching(rooms, "run-1");
  drain(viewer);

  rooms.conclude("run-1");
  assert(uplink.signal.aborted);
  assertEquals(drain(viewer), [
    { event: "uplink", data: { connected: false } },
    { event: "done", data: {} },
  ]);
  assert(viewer.finished);
  await viewer.ready(); // a finished viewer never parks its reader

  assertEquals(rooms.openUplink("run-1"), "concluded");
  // A late viewer still gets the last state, and is told at once there is nothing more.
  const late = drain(watching(rooms, "run-1"));
  assertEquals(late.map((o) => o.event), ["snapshot", "done"]);
  if (late[0].event !== "snapshot") return;
  assertEquals(late[0].data.frame?.data, "frame-1");
  assertEquals(late[0].data.uplink, false);
});

test("a run already over with no room left gets an empty snapshot and done", () => {
  const rooms = makeLiveRooms();
  assertEquals(
    drain(watching(rooms, "run-1", { terminal: true })).map((o) => o.event),
    ["snapshot", "done"],
  );
  // ...while one still running waits.
  assertEquals(drain(watching(rooms, "run-2")).map((o) => o.event), ["snapshot"]);
});

test("a terminal run's room that never heard a conclusion is concluded by a viewer opening", () => {
  const rooms = makeLiveRooms();
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  uplink.push(consoleLine(1));
  const waiting = watching(rooms, "run-1");
  drain(waiting);

  // The conclude signal was lost; the host says the run is over as another viewer opens.
  const late = drain(watching(rooms, "run-1", { terminal: true }));
  assertEquals(late.map((o) => o.event), ["snapshot", "uplink", "done"]);
  assert(uplink.signal.aborted, "the room is concluded: its uplink is hung up");
  assertEquals(drain(waiting).map((o) => o.event), ["uplink", "done"], "everyone is told");
  assertEquals(rooms.openUplink("run-1"), "concluded");
});

test("a room past its byte budget drops the oldest ring entries, whichever ring", () => {
  // Each console line here is ~1.1 KB, each action ~0.1 KB, by the estimate.
  const rooms = makeLiveRooms({ roomBudget: 4 * 1024 });
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  uplink.push({ type: "action", at: 0, tool: "click", summary: "first" });
  for (let n = 1; n <= 10; n++) {
    uplink.push({ type: "console", at: n, tabId: "t1", level: "log", text: "x".repeat(1_000) });
  }
  uplink.push({ type: "action", at: 11, tool: "click", summary: "last" });

  const [snapshot] = drain(watching(rooms, "run-1"));
  if (snapshot.event !== "snapshot") throw new Error("no snapshot");
  assertEquals(snapshot.data.actions.map((a) => a.summary), ["last"], "the oldest went first");
  assertEquals(snapshot.data.console.map((c) => c.at), [8, 9, 10]);
});

test("viewers opening on an unchanged room share one snapshot", () => {
  const rooms = makeLiveRooms();
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  uplink.push(consoleLine(1));
  const a = drain(watching(rooms, "run-1"))[0];
  const b = drain(watching(rooms, "run-1"))[0];
  assert(a.data === b.data);
  uplink.push(consoleLine(2));
  const c = drain(watching(rooms, "run-1"))[0];
  assert(c.data !== a.data);
  if (c.event !== "snapshot" || a.event !== "snapshot") return;
  assertEquals(c.data.console.length, 2);
  assertEquals(a.data.console.length, 1, "a snapshot already handed out never changes");
});

test("rooms expire after their uplink closes, and not while it is open", () => {
  const time = clock();
  const rooms = makeLiveRooms({ now: time.now, expiryMs: 60_000 });
  const open = rooms.openUplink("run-open");
  const closed = rooms.openUplink("run-closed");
  assert(typeof open !== "string" && typeof closed !== "string");
  open.push(frame(1));
  closed.push(frame(2));
  closed.close();

  time.advance(59_999);
  rooms.sweep();
  assertEquals(rooms.size(), 2);

  time.advance(1);
  rooms.sweep();
  assertEquals(rooms.size(), 1);
  const [snapshot] = drain(watching(rooms, "run-closed"));
  if (snapshot.event !== "snapshot") throw new Error("expected a snapshot");
  assertEquals(snapshot.data.frame, null, "the expired room's state is gone");

  // A reconnect before expiry stops the clock.
  const again = rooms.openUplink("run-open");
  assert(typeof again !== "string");
  time.advance(10 * 60_000);
  rooms.sweep();
  assertEquals(rooms.size(), 1);
});

test("a concluded room expires on the same clock", () => {
  const time = clock();
  const rooms = makeLiveRooms({ now: time.now, expiryMs: 60_000 });
  assert(typeof rooms.openUplink("run-1") !== "string");
  rooms.conclude("run-1");
  time.advance(60_000);
  rooms.sweep();
  assertEquals(rooms.size(), 0);
});

test("at the cap the idle room nearest expiry is evicted; live rooms never are", () => {
  const time = clock();
  const rooms = makeLiveRooms({ now: time.now, maxRooms: 2 });
  const a = rooms.openUplink("run-a");
  const b = rooms.openUplink("run-b");
  assert(typeof a !== "string" && typeof b !== "string");

  assertEquals(rooms.openUplink("run-c"), "full");

  a.close();
  time.advance(1);
  const c = rooms.openUplink("run-c");
  assert(typeof c !== "string", "run-a's idle room made way");
  assertEquals(rooms.size(), 2);
  // The evicted room's old uplink handle writes nowhere.
  a.push(frame(1));
  const [snapshot] = drain(watching(rooms, "run-a"));
  if (snapshot.event !== "snapshot") throw new Error("expected a snapshot");
  assertEquals(snapshot.data.frame, null);
});

test("a viewer that leaves is woken and gets nothing more", async () => {
  const rooms = makeLiveRooms();
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  const viewer = watching(rooms, "run-1");
  drain(viewer);

  const parked = viewer.ready();
  viewer.leave();
  await parked;
  uplink.push(consoleLine(1));
  assertEquals(viewer.take(), null);
  assert(viewer.finished);
});

/** A sidecar's opening: its snapshot line, then its rings replayed. */
function replayTo(
  uplink: { push(event: LiveEvent): void },
  lines: LiveEvent[],
): void {
  uplink.push({ type: "snapshot", at: 0, status: "active", tabs: [], frame: null });
  for (const line of lines) uplink.push(line);
}

const request = (n: number): LiveEvent => ({
  type: "network",
  at: n,
  tabId: "t1",
  method: "GET",
  url: `http://x/${n}`,
  resourceType: "fetch",
  status: 200,
});

/** A viewer's lists, folded from what it was sent the way the app folds them: a snapshot
 * replaces them, each console/network/action line appends. */
function fold(outs: LiveOut[], start = { console: [] as number[], network: [] as number[] }) {
  let view = start;
  for (const out of outs) {
    if (out.event === "snapshot") {
      view = {
        console: out.data.console.map((c) => c.at),
        network: out.data.network.map((n) => n.at),
      };
    } else if (out.event === "console") view = { ...view, console: [...view.console, out.data.at] };
    else if (out.event === "network") view = { ...view, network: [...view.network, out.data.at] };
  }
  return view;
}

test("a reconnect whose sidecar replays its rings holds each line once, and viewers agree", () => {
  const rooms = makeLiveRooms();
  const first = rooms.openUplink("run-1");
  assert(typeof first !== "string");
  replayTo(first, []);
  first.push(consoleLine(1));
  first.push(request(2));
  first.push(consoleLine(3));
  const early = watching(rooms, "run-1");
  let earlyView = fold(drain(early));
  assertEquals(earlyView, { console: [1, 3], network: [2] });

  // The uplink drops (a historian blip, a relay reconnect); a line arrives in the gap.
  first.close();
  const second = rooms.openUplink("run-1");
  assert(typeof second !== "string");
  // The sidecar replays everything it kept, the gap's line included, then carries on live.
  replayTo(second, [consoleLine(1), request(2), consoleLine(3), consoleLine(4)]);
  second.push(request(5));

  earlyView = fold(drain(early), earlyView);
  assertEquals(earlyView, { console: [1, 3, 4], network: [2, 5] }, "no line twice");
  const late = fold(drain(watching(rooms, "run-1")));
  assertEquals(late, earlyView, "a viewer opening now sees the same lists");
});

test("a replacing uplink (no close in between) also starts the history over", () => {
  const rooms = makeLiveRooms();
  const first = rooms.openUplink("run-1");
  assert(typeof first !== "string");
  replayTo(first, [consoleLine(1), { type: "action", at: 2, tool: "click", summary: "x" }]);
  const viewer = watching(rooms, "run-1");
  drain(viewer);

  const second = rooms.openUplink("run-1");
  assert(typeof second !== "string");
  replayTo(second, [consoleLine(1), { type: "action", at: 2, tool: "click", summary: "x" }]);
  const [snapshot] = drain(watching(rooms, "run-1"));
  if (snapshot.event !== "snapshot") throw new Error("expected a snapshot");
  assertEquals(snapshot.data.console.map((c) => c.at), [1]);
  assertEquals(snapshot.data.actions.map((a) => a.at), [2]);
  assertEquals(snapshot.data.uplink, true);
});

test("an uplink opening keeps the picture until its own snapshot line says otherwise", () => {
  const rooms = makeLiveRooms();
  const first = rooms.openUplink("run-1");
  assert(typeof first !== "string");
  first.push(frame(1));
  first.push({ type: "status", at: 1, status: "active" });
  first.close();
  const viewer = watching(rooms, "run-1");
  drain(viewer);
  assert(typeof rooms.openUplink("run-1") !== "string");
  const [opened] = drain(viewer);
  if (opened.event !== "snapshot") throw new Error("expected a snapshot");
  assertEquals(opened.data.frame?.data, "frame-1");
  assertEquals(opened.data.status, "active");
});

test("reconnects with replays keep the room within its budget, and a stalled viewer holds one snapshot", () => {
  const budget = 64 * 1024;
  const rooms = makeLiveRooms({ roomBudget: budget, viewerBudget: 32 * 1024 });
  const stalled = watching(rooms, "run-1"); // never read
  const lines = Array.from({ length: CONSOLE_RING }, (_, n): LiveEvent => ({
    type: "console",
    at: n,
    tabId: "t1",
    level: "log",
    text: "x".repeat(2_000),
  }));
  for (let round = 0; round < 20; round++) {
    const uplink = rooms.openUplink("run-1");
    assert(typeof uplink !== "string");
    replayTo(uplink, lines);
  }
  const [snapshot] = drain(watching(rooms, "run-1"));
  if (snapshot.event !== "snapshot") throw new Error("expected a snapshot");
  const held = snapshot.data.console.reduce((sum, c) => sum + c.text.length, 0);
  assert(held <= budget, `room holds ${held}`);
  // Only the newest lines, each once.
  const ats = snapshot.data.console.map((c) => c.at);
  assertEquals(new Set(ats).size, ats.length);
  assertEquals(ats.at(-1), CONSOLE_RING - 1);

  const out = drain(stalled);
  assertEquals(out.filter((o) => o.event === "snapshot").length, 1, "earlier snapshots superseded");
  const queued = out.filter((o) => o.event === "console")
    .reduce((sum, o) => sum + (o.data as { text: string }).text.length, 0);
  assert(queued <= 32 * 1024, `viewer queued ${queued}`);
  // A slow viewer loses lines (and is told), never gains a duplicate: what it folds to is the
  // room's newest lines, without repeats.
  const seen = fold(out).console;
  assertEquals(new Set(seen).size, seen.length);
  assert(seen.every((at) => ats.includes(at)));
  assertEquals(seen.at(-1), ats.at(-1));
});

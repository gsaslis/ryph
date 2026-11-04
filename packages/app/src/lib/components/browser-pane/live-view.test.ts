import { describe, expect, it } from "vitest";
import type { LiveFrame, LiveMessage, LiveRoom } from "$lib/api/browser-live";
import {
  applyMessage,
  CAPS,
  chipFor,
  emptyView,
  filterConsole,
  highlightBox,
  isFailedRequest,
  type LiveView,
  mergeActions,
  shortUrl,
  type TranscriptAction,
  viewportOf,
} from "./live-view";

const frame = (tabId = "t1"): LiveFrame => ({
  mime: "image/jpeg",
  data: "AAAA",
  width: 1280,
  height: 800,
  tabId,
});

const room = (over: Partial<LiveRoom> = {}): LiveRoom => ({
  uplink: true,
  status: "active",
  tabs: [{ id: "t1", url: "http://localhost:5173/", title: "App", active: true }],
  frame: frame(),
  console: [],
  network: [],
  actions: [],
  ...over,
});

/** Every message folded in order, the way the pane's state class applies them. */
function fold(messages: LiveMessage[], from: LiveView = emptyView()): LiveView {
  return messages.reduce((view, m) => ({ ...view, ...applyMessage(view, m) }), from);
}

const consoleLine = (text: string, level: "log" | "warn" | "error" = "log", at = 1) => ({
  type: "console" as const,
  at,
  tabId: "t1",
  level,
  text,
});

describe("applyMessage", () => {
  it("takes a room whole, numbering its lists", () => {
    const view = fold([{
      kind: "room",
      room: room({ console: [consoleLine("a"), consoleLine("b")] }),
    }]);
    expect(view.room).toBe(true);
    expect(view.console.map((l) => [l.text, l.id])).toEqual([["a", 1], ["b", 2]]);
    expect(view.nextId).toBe(3);
  });

  it("replaces the lists on a reconnect rather than appending to them", () => {
    const first: LiveMessage = { kind: "room", room: room({ console: [consoleLine("a")] }) };
    const view = fold([first, { kind: "event", event: consoleLine("b") }, first]);
    expect(view.console.map((l) => l.text)).toEqual(["a"]);
    // Ids keep counting, so a keyed list never sees one reused.
    expect(view.console[0].id).toBe(3);
  });

  it("changes only the frame when a frame arrives", () => {
    const view = fold([{ kind: "room", room: room() }]);
    const next = frame("t2");
    expect(applyMessage(view, { kind: "event", event: { type: "frame", at: 2, frame: next } }))
      .toEqual({ frame: next });
  });

  it("caps the console at the historian's ring size", () => {
    const lines = Array.from({ length: CAPS.console + 5 }, (_, i) => ({
      kind: "event" as const,
      event: consoleLine(`l${i}`),
    }));
    const view = fold(lines);
    expect(view.console).toHaveLength(CAPS.console);
    expect(view.console[0].text).toBe("l5");
    expect(view.console.at(-1)!.text).toBe(`l${CAPS.console + 4}`);
  });

  it("rings an action that points at something, and keeps the last ring for one that does not", () => {
    const target = { x: 10, y: 20, width: 30, height: 40 };
    const view = fold([
      {
        kind: "event",
        event: { type: "action", at: 1, tool: "click", summary: "Clicked", target },
      },
      { kind: "event", event: { type: "action", at: 2, tool: "press_key", summary: "Pressed" } },
    ]);
    expect(view.highlight).toEqual({ id: 1, target });
    expect(view.actions).toHaveLength(2);
  });

  it("drops the ring on a room: the last action may be minutes old", () => {
    const target = { x: 1, y: 1, width: 1, height: 1 };
    const view = fold([
      {
        kind: "event",
        event: { type: "action", at: 1, tool: "click", summary: "Clicked", target },
      },
      { kind: "room", room: room() },
    ]);
    expect(view.highlight).toBeNull();
  });

  it("keeps the last frame and drops the uplink when the run is done", () => {
    const view = fold([{ kind: "room", room: room() }, { kind: "done" }]);
    expect(view.done).toBe(true);
    expect(view.uplink).toBe(false);
    expect(view.frame).not.toBeNull();
  });

  it("counts what a slow connection lost", () => {
    const view = fold([{ kind: "dropped", count: 3 }, { kind: "dropped", count: 2 }]);
    expect(view.dropped).toBe(5);
  });

  it("follows the uplink coming and going", () => {
    const view = fold([{ kind: "room", room: room() }, { kind: "uplink", connected: false }]);
    expect(view.uplink).toBe(false);
  });
});

describe("chipFor", () => {
  const base = { room: true, uplink: true, status: "active" as const, done: false };

  it("is ended once the historian says the run is done, whatever the page thinks", () => {
    expect(chipFor({ ...base, done: true }, false)).toBe("ended");
  });

  it("is live while a browser runs and the relay is up", () => {
    expect(chipFor(base, false)).toBe("live");
    expect(chipFor({ ...base, status: "launching" }, false)).toBe("live");
  });

  it("is idle before the browser launches, or while the relay is down on a live run", () => {
    expect(chipFor({ ...base, status: "idle" }, false)).toBe("idle");
    expect(chipFor({ ...base, uplink: false }, false)).toBe("idle");
  });

  it("is ended once the run is over and nothing relays, or the browser closed", () => {
    expect(chipFor({ ...base, uplink: false }, true)).toBe("ended");
    expect(chipFor({ ...base, status: "closed" }, false)).toBe("ended");
  });

  it("is connecting until the first room, unless the run is over", () => {
    expect(chipFor({ ...base, room: false }, false)).toBe("connecting");
    expect(chipFor({ ...base, room: false }, true)).toBe("ended");
  });
});

describe("highlightBox", () => {
  it("scales a target in viewport pixels to percentages of the frame", () => {
    expect(highlightBox({ x: 128, y: 80, width: 256, height: 40 }, { width: 1280, height: 800 }))
      .toEqual({ left: 10, top: 10, width: 20, height: 5 });
  });

  it("is the same box whatever size the frame is drawn at", () => {
    // A 2x device viewport sends a frame twice its CSS size; the target stays in CSS px.
    const viewport = viewportOf({
      ...frame(),
      width: 2560,
      height: 1600,
      viewport: { width: 1280, height: 800 },
    });
    expect(highlightBox({ x: 640, y: 400, width: 128, height: 80 }, viewport)).toEqual({
      left: 50,
      top: 50,
      width: 10,
      height: 10,
    });
  });

  it("clips a target hanging off the edge", () => {
    expect(highlightBox({ x: -100, y: 700, width: 200, height: 200 }, { width: 1000, height: 800 }))
      .toEqual({ left: 0, top: 87.5, width: 10, height: 12.5 });
  });

  it("is nothing for a target scrolled out of view", () => {
    expect(highlightBox({ x: 10, y: 900, width: 10, height: 10 }, { width: 1280, height: 800 }))
      .toBeNull();
    expect(highlightBox({ x: 10, y: 10, width: 0, height: 10 }, { width: 1280, height: 800 }))
      .toBeNull();
  });

  it("falls back on the frame's own size without a viewport", () => {
    expect(viewportOf(frame())).toEqual({ width: 1280, height: 800 });
  });
});

describe("mergeActions", () => {
  const call = (seq: number, at: number, tool: string, label = tool): TranscriptAction => ({
    seq,
    at,
    tool,
    label,
    subject: null,
    done: true,
    isError: false,
  });
  const action = (id: number, at: number, tool: string, summary = `${tool} live`) => ({
    id,
    type: "action" as const,
    at,
    tool,
    summary,
  });

  it("folds an action onto the call that caused it", () => {
    const items = mergeActions([call(5, 1_000, "click", "Clicked “Greet”")], [
      action(1, 1_300, "click"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ seq: 5, label: "Clicked “Greet”" });
  });

  it("lists an action the transcript has not caught up with, newest last", () => {
    const items = mergeActions([call(5, 1_000, "click")], [
      action(1, 1_300, "click"),
      action(2, 4_000, "browser__navigate", "Opened localhost:5173"),
    ]);
    expect(items.map((i) => [i.label, i.seq])).toEqual([
      ["click", 5],
      ["Opened localhost:5173", null],
    ]);
    expect(items[1].tool).toBe("navigate");
  });

  it("pairs in order, so two clicks pair with two calls and not both with the first", () => {
    const items = mergeActions(
      [call(1, 1_000, "click"), call(2, 2_000, "click")],
      [action(1, 1_100, "click"), action(2, 2_100, "click")],
    );
    expect(items.map((i) => i.key)).toEqual(["call-1", "call-2"]);
  });

  it("does not pair an action with a call long before it", () => {
    const items = mergeActions([call(1, 0, "click")], [action(1, 120_000, "click")]);
    expect(items.map((i) => i.seq)).toEqual([1, null]);
  });

  it("lists a paired call in the app's words and never the action's beside it", () => {
    const items = mergeActions(
      [call(1, 1_000, "click", "Clicked “Greet”"), call(2, 5_000, "navigate", "Opened a page")],
      [action(1, 1_050, "click", "Clicked “Greet” (live)"), action(2, 5_100, "browser__navigate")],
    );
    expect(items.map((i) => i.label)).toEqual(["Clicked “Greet”", "Opened a page"]);
    expect(items.every((i) => i.seq !== null)).toBe(true);
  });

  it("does not let an action whose call is not loaded take a later call from its own action", () => {
    // Action 1's call is on a page the transcript dropped; call 7 is action 2's.
    const items = mergeActions([call(7, 1_000, "click", "Clicked “Save”")], [
      action(1, 0, "click", "Clicked “Open”"),
      action(2, 1_100, "click", "Clicked “Save”, live"),
    ]);
    expect(items.map((i) => [i.label, i.seq])).toEqual([
      ["Clicked “Open”", null],
      ["Clicked “Save”", 7],
    ]);
  });

  it("pairs calls that started together with their actions in order", () => {
    // One model turn asking for three clicks: the tool_uses share a time, the actions follow.
    const items = mergeActions(
      [call(1, 1_000, "click"), call(2, 1_000, "click"), call(3, 1_000, "click")],
      [action(1, 1_100, "click"), action(2, 1_600, "click"), action(3, 2_400, "click")],
    );
    expect(items.map((i) => i.key)).toEqual(["call-1", "call-2", "call-3"]);
  });

  it("keeps calls with no live action, such as reads of the page", () => {
    const items = mergeActions([call(1, 0, "snapshot"), call(2, 10, "console_messages")], []);
    expect(items).toHaveLength(2);
  });
});

describe("filterConsole", () => {
  const lines = [
    { ...consoleLine("hello"), id: 1 },
    { ...consoleLine("careful", "warn"), id: 2 },
    { ...consoleLine("boom", "error"), id: 3 },
    { ...consoleLine("source", "log"), id: 4, source: { url: "http://x/app.js" } },
  ];

  it("filters by the lowest level to show", () => {
    expect(filterConsole(lines, "all", "").map((l) => l.id)).toEqual([1, 2, 3, 4]);
    expect(filterConsole(lines, "warn", "").map((l) => l.id)).toEqual([2, 3]);
    expect(filterConsole(lines, "error", "").map((l) => l.id)).toEqual([3]);
  });

  it("matches text in the line or its source, ignoring case", () => {
    expect(filterConsole(lines, "all", "BOOM").map((l) => l.id)).toEqual([3]);
    expect(filterConsole(lines, "all", "app.js").map((l) => l.id)).toEqual([4]);
  });
});

describe("network helpers", () => {
  const req = {
    type: "network" as const,
    at: 1,
    tabId: "t1",
    method: "GET",
    url: "x",
    resourceType: "fetch",
  };

  it("calls a failure or an error status failed", () => {
    expect(isFailedRequest({ ...req, status: 200 })).toBe(false);
    expect(isFailedRequest({ ...req, status: 404 })).toBe(true);
    expect(isFailedRequest({ ...req, failure: "net::ERR_CONNECTION_REFUSED" })).toBe(true);
  });

  it("shortens a URL on the page's own origin to its path", () => {
    expect(shortUrl("http://localhost:5173/api/greet?x=1", "http://localhost:5173/")).toBe(
      "/api/greet?x=1",
    );
    expect(shortUrl("https://cdn.example.com/a.js", "http://localhost:5173/")).toBe(
      "cdn.example.com/a.js",
    );
    expect(shortUrl("not a url", null)).toBe("not a url");
  });
});

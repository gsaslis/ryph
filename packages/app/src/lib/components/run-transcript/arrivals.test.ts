import { describe, expect, it } from "vitest";
import type { TranscriptRow } from "$lib/components/run-history/run-history.svelte";
import { TranscriptArrivals } from "./arrivals";

const at = "2026-10-12T00:00:00Z";
const event = (seq: number): TranscriptRow => ({
  key: `event:${seq}`,
  kind: "event",
  at,
  event: {
    runId: "run",
    lane: "",
    seq,
    at,
    voice: "transcript",
    kind: "assistant",
    level: null,
    text: "Hello",
    payload: null,
  },
});
const tool = (seq: number, done = false): TranscriptRow => ({
  key: `tool:${seq}`,
  kind: "tool",
  at,
  call: {
    seq,
    runId: "run",
    at,
    name: "chat",
    resultText: done ? "Done" : null,
    useText: null,
    isError: false,
    done,
    view: { kind: "chat", text: "Hello" },
    images: { kept: [], notKept: 0 },
  },
});
const message = (seq: number, deliveredAt: string | null = null): TranscriptRow => ({
  key: `message:${seq}`,
  kind: "message",
  at,
  message: {
    id: `message:${seq}`,
    runId: "run",
    seq,
    kind: "user",
    sender: { kind: "platform" },
    text: "Hello",
    payload: null,
    createdAt: at,
    deliveredAt,
    attachments: [],
  },
});
const result: TranscriptRow = {
  key: "result",
  kind: "result",
  result: { status: "success", summary: "Done", branches: [], images: [] },
  egressNote: null,
  limit: null,
};
const background = (seq: number): TranscriptRow => ({
  key: `background:${seq}`,
  kind: "background",
  at,
  seq,
  notice: { id: "job", label: "Job", reason: "exited", exitCode: 0, signal: null, durationMs: 1 },
  event: {
    runId: "run",
    lane: "",
    seq,
    at,
    voice: "transcript",
    kind: "inbound",
    level: null,
    text: "Job exited 0",
    payload: { kind: "system", sender: { kind: "platform" }, text: "Job exited 0" },
  },
});
const subagent = (seq: number): TranscriptRow => ({
  key: `subagent:${seq}`,
  kind: "subagent",
  at,
  seq,
  notice: { id: "agent", label: "Agent", reason: "answered", durationMs: 1 },
  event: {
    runId: "run",
    lane: "",
    seq,
    at,
    voice: "transcript",
    kind: "inbound",
    level: null,
    text: "Agent answered",
    payload: { kind: "system", sender: { kind: "platform" }, text: "Agent answered" },
  },
});

describe("TranscriptArrivals", () => {
  it("takes the initial rows as a baseline, including a completed result", () => {
    const arrivals = new TranscriptArrivals();
    const rows = [event(10), tool(11), background(12), subagent(13), message(4), result];
    expect(arrivals.update(rows, 13)).toEqual(new Set());
    expect(arrivals.update(rows, 13)).toEqual(new Set());
  });

  it("reports new speech and a result once, comparing all rows with the previous high-water mark", () => {
    const arrivals = new TranscriptArrivals();
    arrivals.update([event(10)], 10);
    const rows = [event(10), event(14), tool(11), background(12), subagent(13), result];
    expect(arrivals.update(rows, 14)).toEqual(
      new Set([
        "event:14",
        "tool:11",
        "background:12",
        "subagent:13",
        "result",
      ]),
    );
    expect(arrivals.update(rows, 14)).toEqual(new Set());
  });

  it("uses history's high-water mark rather than the last visible event for backfill", () => {
    const arrivals = new TranscriptArrivals();
    arrivals.update([event(1)], 100);
    expect(arrivals.update([event(1), event(90), tool(95), background(99), subagent(100)], 100))
      .toEqual(new Set());
    expect(arrivals.update([event(101)], 101)).toEqual(new Set(["event:101"]));
  });

  it("does not replay evicted rows or lower its high-water mark", () => {
    const arrivals = new TranscriptArrivals();
    arrivals.update([event(10)], 10);
    expect(arrivals.update([event(11), tool(12)], 12)).toEqual(new Set(["event:11", "tool:12"]));
    arrivals.update([], 0);
    expect(arrivals.update([event(11), tool(12)], 12)).toEqual(new Set());
    // A fresh transcript mounted over existing history also establishes a baseline.
    expect(new TranscriptArrivals().update([event(11), tool(12)], 12)).toEqual(new Set());
  });

  it("ignores in-place updates, including tool completion and result changes", () => {
    const arrivals = new TranscriptArrivals();
    arrivals.update([tool(10), result], 10);
    expect(arrivals.update([tool(10, true), { ...result, egressNote: "Updated" }], 11))
      .toEqual(new Set());
  });

  it("tracks messages separately and ignores delivery updates and restored messages", () => {
    const arrivals = new TranscriptArrivals();
    arrivals.update([message(4)], 100);
    expect(arrivals.update([message(4, at), message(6), message(5)], 100))
      .toEqual(new Set(["message:6", "message:5"]));
    arrivals.update([], 100);
    expect(arrivals.update([message(3), message(6), message(7)], 100))
      .toEqual(new Set(["message:7"]));
  });

  it("can receive its first message and event after an empty baseline", () => {
    const arrivals = new TranscriptArrivals();
    arrivals.update([], -1);
    expect(arrivals.update([event(0), message(0), result], 0))
      .toEqual(new Set(["event:0", "message:0", "result"]));
  });

  it("excludes gaps, live indicators, machine notes and lifecycle notices", () => {
    const arrivals = new TranscriptArrivals();
    arrivals.update([], 0);
    const rows: TranscriptRow[] = [
      { key: "gap", kind: "gap", before: 10, count: 9, loading: false, failed: false },
      { key: "live", kind: "live" },
      { key: "machine", kind: "machine", at, events: [] },
      { key: "limit", kind: "limit", at, detail: "Limit" },
      { key: "stale", kind: "stale", at, detail: "Stale" },
      { key: "skills", kind: "skills", at, detail: "Skills", what: "dropped" },
      { key: "browser", kind: "browser", at, detail: "Browser" },
      { key: "setup", kind: "setup", at, summary: "Setup", output: "", discarded: false },
    ];
    expect(arrivals.update(rows, 10)).toEqual(new Set());
  });
});

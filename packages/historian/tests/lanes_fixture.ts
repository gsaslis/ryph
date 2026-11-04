// The lane cases every HistoryStore must pass, written once and run against both the drizzle
// store (the real SQL, DISTINCT ON included) and the test double, so the two cannot drift apart.

import { assertEquals } from "@std/assert";
import {
  type HistoryEvent,
  LANE_ENDS_SUMMED,
  LANE_SUMMARY_TEXT_MAX,
  type LaneSummary,
  MAX_STRETCH_MS,
  MAX_SUBAGENT_LANES,
} from "../src/core/types.ts";
import type { HistoryStore } from "../src/ports/store.ts";

export function laneEvent(
  runId: string,
  lane: string,
  seq: number,
  overrides: Partial<HistoryEvent> = {},
): HistoryEvent {
  return {
    runId,
    lane,
    seq,
    at: "2026-10-12T12:00:00.000Z",
    voice: "transcript",
    kind: "assistant",
    level: null,
    text: `${lane || "main"} ${seq}`,
    payload: null,
    ...overrides,
  };
}

const opening = (runId: string, lane: string, seq: number) =>
  laneEvent(runId, lane, seq, {
    kind: "subagent.start",
    text: `label ${lane}`,
    payload: { id: lane, label: `label ${lane}`, mode: "explore", task: "look around" },
  });
const resume = (runId: string, lane: string, seq: number) =>
  laneEvent(runId, lane, seq, {
    kind: "subagent.resume",
    text: "and now this",
    payload: { id: lane, message: "and now this" },
  });
const end = (runId: string, lane: string, seq: number) =>
  laneEvent(runId, lane, seq, {
    kind: "subagent.end",
    text: null,
    payload: { id: lane, reason: "answered", answerChars: 10, durationMs: seq },
  });

export async function perLaneSeqs(store: HistoryStore): Promise<void> {
  // The same seq in two lanes of one run is two events.
  const first = await store.append([laneEvent("run-1", "", 1), laneEvent("run-1", "sa-1", 1)]);
  assertEquals(first.map((e) => `${e.lane}:${e.seq}`).sort(), [":1", "sa-1:1"]);

  // A retry dedups within each lane, and only within it.
  const retry = await store.append([
    laneEvent("run-1", "", 1),
    laneEvent("run-1", "sa-1", 1),
    laneEvent("run-1", "sa-1", 2),
    laneEvent("run-1", "sa-2", 1),
  ]);
  assertEquals(retry.map((e) => `${e.lane}:${e.seq}`).sort(), ["sa-1:2", "sa-2:1"]);

  // Each read is one lane, and the main lane reads exactly as it did before lanes.
  assertEquals((await store.listEvents("run-1", "")).map((e) => e.text), ["main 1"]);
  assertEquals((await store.listEvents("run-1", "sa-1")).map((e) => e.seq), [1, 2]);
  assertEquals((await store.listEvents("run-1", "sa-1", { after: 1 })).map((e) => e.seq), [2]);
  assertEquals(
    (await store.listEvents("run-1", "sa-1", { before: 3, limit: 1 })).map((e) => e.seq),
    [2],
  );
  assertEquals(await store.listEvents("run-1", "sa-9"), []);
  // The lane rides back on every event.
  assertEquals((await store.listEvents("run-1", "sa-2"))[0].lane, "sa-2");
}

export async function laneListing(store: HistoryStore): Promise<void> {
  await store.append([
    // The main lane, carrying a start of its own: still never listed.
    laneEvent("run-1", "", 0),
    opening("run-1", "", 1),
    // sa-1 ran once and answered.
    opening("run-1", "sa-1", 1),
    laneEvent("run-1", "sa-1", 2),
    end("run-1", "sa-1", 3),
    // sa-2 was continued twice: its latest resume is after its latest end, so it runs again.
    opening("run-1", "sa-2", 1),
    end("run-1", "sa-2", 2),
    resume("run-1", "sa-2", 3),
    end("run-1", "sa-2", 4),
    resume("run-1", "sa-2", 5),
    laneEvent("run-1", "sa-2", 6),
    // sa-10 is still in its first stretch, and is listed after sa-2, not after sa-1.
    opening("run-1", "sa-10", 1),
    // A diagnostic named like an end is not one: it moves neither `end` nor `ranMs`.
    laneEvent("run-1", "sa-1", 4, {
      voice: "diag",
      kind: "subagent.end",
      level: "debug",
      payload: { durationMs: 1000 },
    }),
    // sa-5's first end carries a duration that is not a number: it counts nothing.
    opening("run-1", "sa-5", 1),
    laneEvent("run-1", "sa-5", 2, { kind: "subagent.end", payload: { durationMs: "12" } }),
    resume("run-1", "sa-5", 3),
    end("run-1", "sa-5", 7),
    // sa-3 wrote without opening: not a lane the listing knows.
    laneEvent("run-1", "sa-3", 1),
    // sa-4's only "start" is a diagnostic, not the transcript event.
    laneEvent("run-1", "sa-4", 1, { voice: "diag", kind: "subagent.start", level: "debug" }),
    // Another run's lane is that run's.
    opening("run-2", "sa-1", 1),
  ]);

  const lanes = await store.listLanes("run-1");
  assertEquals(lanes.map((l) => l.lane), ["sa-1", "sa-2", "sa-5", "sa-10"]);
  const [one, two, five, ten] = lanes as [LaneSummary, LaneSummary, LaneSummary, LaneSummary];

  assertEquals(one.start, opening("run-1", "sa-1", 1));
  assertEquals(one.resume, null);
  assertEquals(one.end, end("run-1", "sa-1", 3));

  assertEquals(two.start.seq, 1);
  assertEquals(two.resume, resume("run-1", "sa-2", 5));
  assertEquals(two.end, end("run-1", "sa-2", 4));

  // Every end's duration, summed: one stretch, two stretches, a non-number skipped, none yet.
  assertEquals(lanes.map((l) => l.ranMs), [3, 2 + 4, 7, 0]);
  assertEquals(five.end?.seq, 7);

  assertEquals(ten.start.seq, 1);
  assertEquals(ten.resume, null);
  assertEquals(ten.end, null);

  // The contract's running rule, read off the listing.
  const running = (l: LaneSummary) =>
    l.end === null || (l.resume !== null && l.resume.seq > l.end.seq);
  assertEquals(lanes.map(running), [false, true, false, true]);

  assertEquals((await store.listLanes("run-2")).map((l) => l.lane), ["sa-1"]);
  assertEquals(await store.listLanes("no-such-run"), []);
}

// What a run whose agent writes its own lanes cannot do to the listing: the run token is readable
// in the run's container, so every lifecycle event here is one an agent could have sent.
export async function hostileLanes(store: HistoryStore): Promise<void> {
  const ended = (lane: string, seq: number, durationMs: unknown) =>
    laneEvent("run-1", lane, seq, {
      kind: "subagent.end",
      text: null,
      payload: { id: lane, reason: "answered", answerChars: 1, durationMs },
    });
  const events: HistoryEvent[] = [
    // Past the ceiling, or not a lane at all: never probed, never listed.
    opening("run-1", `sa-${MAX_SUBAGENT_LANES + 1}`, 1),
    opening("run-1", "sa-9999", 1),
    // sa-1 ended far more often than it was ever continued: only the latest ends count.
    opening("run-1", "sa-1", 1),
  ];
  const ends = LANE_ENDS_SUMMED + 50;
  for (let i = 0; i < ends; i++) events.push(ended("sa-1", 2 + i, 10));
  // sa-2's durations: two that would overflow a float8 sum, one negative, one past a day, a day,
  // a fraction, and some that are not numbers. Only the day and the fraction count.
  events.push(opening("run-1", "sa-2", 1));
  const durations: unknown[] = [1e308, 1e308, -5, MAX_STRETCH_MS + 1, MAX_STRETCH_MS, 1.5];
  durations.push(null, true, { ms: 1 }, [1], "7");
  durations.forEach((ms, i) => events.push(ended("sa-2", 2 + i, ms)));
  // sa-3 opens with a task, a label and fields of its own far bigger than any summary carries.
  const long = "y".repeat(LANE_SUMMARY_TEXT_MAX * 3);
  events.push(laneEvent("run-1", "sa-3", 1, {
    kind: "subagent.start",
    text: long,
    payload: { id: "sa-3", label: long, mode: "work", task: long, extra: long, mode2: [long] },
  }));
  events.push(laneEvent("run-1", "sa-3", 2, {
    kind: "subagent.resume",
    text: long,
    payload: { id: { not: "a string" }, message: long },
  }));
  // sa-4's start payload is not an object at all.
  events.push(laneEvent("run-1", "sa-4", 1, { kind: "subagent.start", payload: [long] }));
  for (let i = 0; i < events.length; i += 200) await store.append(events.slice(i, i + 200));

  const lanes = await store.listLanes("run-1");
  assertEquals(lanes.map((l) => l.lane), ["sa-1", "sa-2", "sa-3", "sa-4"]);
  const [one, two, three, four] = lanes as [LaneSummary, LaneSummary, LaneSummary, LaneSummary];

  assertEquals(one.end?.seq, 1 + ends);
  assertEquals(one.ranMs, LANE_ENDS_SUMMED * 10);
  assertEquals(two.ranMs, MAX_STRETCH_MS + 1.5);
  assertEquals(two.end?.payload, {
    id: "sa-2",
    reason: "answered",
    answerChars: 1,
    durationMs: "7",
  });

  const clipped = `${"y".repeat(LANE_SUMMARY_TEXT_MAX - 1)}…`;
  assertEquals(three.start.text, clipped);
  assertEquals(three.start.payload, { id: "sa-3", label: clipped, mode: "work", task: clipped });
  assertEquals(three.resume?.text, clipped);
  // A field of the wrong type is dropped rather than carried.
  assertEquals(three.resume?.payload, { message: clipped });
  // The lane's own events are untouched.
  assertEquals((await store.listEvents("run-1", "sa-3"))[0].payload, {
    id: "sa-3",
    label: long,
    mode: "work",
    task: long,
    extra: long,
    mode2: [long],
  });

  assertEquals(four.start.payload, null);
}

// The screencast's forward rate: at most one frame per window, and a burst always ends on its
// last frame. Time is driven by hand.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { Throttle, type TimerId, type Timers } from "../src/core/throttle.ts";

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id as unknown as TimerId;
    },
    clearTimeout: (id) => void pending.delete(id as unknown as number),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) =>
        t.at <= until
      ).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) {
        break;
      }
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  return { timers, advance, pending };
}

test("the first frame goes at once", () => {
  const { timers } = fakeTimers();
  const sent: number[] = [];
  const t = new Throttle<number>(100, (v) => sent.push(v), timers);
  t.push(1);
  assertEquals(sent, [1]);
});

test("a 60 fps burst forwards at most one frame per 100 ms, ending on the last", () => {
  const { timers, advance } = fakeTimers();
  const sent: Array<[number, number]> = [];
  const t = new Throttle<number>(100, (v) => sent.push([v, timers.now()]), timers);
  // 30 frames, 16 ms apart, then quiet.
  for (let i = 0; i < 30; i++) {
    t.push(i);
    advance(16);
  }
  advance(200);
  assertEquals(sent.at(-1)![0], 29, "the burst's last frame is forwarded");
  for (let i = 1; i < sent.length; i++) {
    const gap = sent[i][1] - sent[i - 1][1];
    if (gap < 100) {
      throw new Error(`frames ${sent[i - 1][0]} and ${sent[i][0]} only ${gap} ms apart`);
    }
  }
  // ~480 ms of frames at 10 fps: about five, never thirty.
  if (sent.length > 6) throw new Error(`${sent.length} frames forwarded`);
});

test("a frame inside the window is held and sent when it closes", () => {
  const { timers, advance } = fakeTimers();
  const sent: number[] = [];
  const t = new Throttle<number>(100, (v) => sent.push(v), timers);
  t.push(1);
  advance(10);
  t.push(2);
  advance(10);
  t.push(3);
  assertEquals(sent, [1]);
  advance(80);
  assertEquals(sent, [1, 3]);
});

test("reset drops what is held but keeps the window", () => {
  const { timers, advance, pending } = fakeTimers();
  const sent: number[] = [];
  const t = new Throttle<number>(100, (v) => sent.push(v), timers);
  t.push(1);
  advance(10);
  t.push(2);
  t.reset();
  assertEquals(pending.size, 0);
  advance(10);
  t.push(3);
  // Still inside the first frame's window: held, not sent.
  assertEquals(sent, [1]);
  advance(100);
  assertEquals(sent, [1, 3]);
});

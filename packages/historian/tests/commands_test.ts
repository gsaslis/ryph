// The background commands' room registry, driven directly with a fake clock: what a snapshot
// holds per job, that a line only lands on a job the room knows, the job and byte bounds and what
// goes first under them, the reset a new uplink makes, conclusion, and expiry.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  type CommandsEvent,
  type CommandsOut,
  type CommandsViewer,
  makeCommandsRooms,
  ROOM_BUDGET,
} from "../src/core/commands.ts";
import { utf8Length } from "../src/core/rooms.ts";

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

const started = (n: number, over: Partial<CommandsEvent> = {}): CommandsEvent =>
  ({
    type: "started",
    at: 1_000 + n,
    id: `bg-${n}`,
    label: `job ${n}`,
    command: `make ${n}`,
    cwd: "/work/repo",
    service: false,
    timeoutAt: 1_000 + n + 30 * 60_000,
    ...over,
  }) as CommandsEvent;
const output = (n: number, text: string): CommandsEvent => ({
  type: "output",
  at: 2_000,
  id: `bg-${n}`,
  text,
});
const exited = (n: number, exitCode = 0): CommandsEvent => ({
  type: "exited",
  at: 3_000 + n,
  id: `bg-${n}`,
  reason: "exited",
  exitCode,
  signal: null,
});

function drain(viewer: CommandsViewer): CommandsOut[] {
  const out: CommandsOut[] = [];
  for (let item = viewer.take(); item !== null; item = viewer.take()) out.push(item);
  return out;
}

const snapshotOf = (viewer: CommandsViewer) => {
  const [first] = drain(viewer);
  assert(first.event === "snapshot");
  return first.data;
};

test("a viewer starts with each job's fields, status and output, then sees each line", () => {
  const rooms = makeCommandsRooms({ now: () => 5_000 });
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  assert(uplink.push(started(1)));
  assert(uplink.push(output(1, "building\n")));
  assert(uplink.push(output(1, "done\n")));
  assert(uplink.push(exited(1, 2)));
  assert(uplink.push(started(2, { service: true, timeoutAt: null })));

  const viewer = watching(rooms, "run-1");
  assertEquals(snapshotOf(viewer), {
    at: 5_000,
    uplink: true,
    jobs: [
      {
        at: 1_001,
        id: "bg-1",
        label: "job 1",
        command: "make 1",
        cwd: "/work/repo",
        service: false,
        timeoutAt: 1_001 + 30 * 60_000,
        status: "ended",
        reason: "exited",
        exitCode: 2,
        signal: null,
        endedAt: 3_001,
        tail: "building\ndone\n",
      },
      {
        at: 1_002,
        id: "bg-2",
        label: "job 2",
        command: "make 2",
        cwd: "/work/repo",
        service: true,
        timeoutAt: null,
        status: "running",
        tail: "",
      },
    ],
  });

  assert(uplink.push(output(2, "listening\n")));
  assert(uplink.push({ type: "skipped", at: 2_500, id: "bg-2", bytes: 70_000 }));
  assertEquals(drain(viewer), [
    { event: "output", data: output(2, "listening\n") },
    { event: "skipped", data: { type: "skipped", at: 2_500, id: "bg-2", bytes: 70_000 } },
  ]);
});

test("a line for a job the room never heard start, or a second start or exit, is refused", () => {
  const rooms = makeCommandsRooms();
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  const viewer = watching(rooms, "run-1");
  drain(viewer);

  assertEquals(uplink.push(output(1, "orphan")), false);
  assertEquals(uplink.push({ type: "skipped", at: 1, id: "bg-1", bytes: 1 }), false);
  assertEquals(uplink.push(exited(1)), false);
  assert(uplink.push(started(1)));
  assertEquals(uplink.push(started(1, { label: "again" })), false);
  assert(uplink.push(exited(1)));
  assertEquals(uplink.push(exited(1, 9)), false);

  // Only what landed was sent, and the job keeps its first start and first exit.
  assertEquals(drain(viewer).map((o) => o.event), ["started", "exited"]);
  const [job] = snapshotOf(watching(rooms, "run-1")).jobs;
  assertEquals([job.label, job.exitCode], ["job 1", 0]);
});

test("a room holds at most its cap of jobs", () => {
  const rooms = makeCommandsRooms({ maxJobs: 3 });
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  for (let n = 1; n <= 3; n++) assert(uplink.push(started(n)));
  assertEquals(uplink.push(started(4)), false);
  // Ending one does not make room: the jobs of a run are its record, not a window.
  assert(uplink.push(exited(1)));
  assertEquals(uplink.push(started(4)), false);
  assertEquals(snapshotOf(watching(rooms, "run-1")).jobs.map((j) => j.id), [
    "bg-1",
    "bg-2",
    "bg-3",
  ]);
});

test("a job's output is a ring: its oldest output goes first", () => {
  const rooms = makeCommandsRooms({ jobRingBytes: 1_000 });
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  uplink.push(started(1));
  for (let n = 0; n < 10; n++) uplink.push(output(1, `${n}`.repeat(300)));
  const [job] = snapshotOf(watching(rooms, "run-1")).jobs;
  // 300 characters plus the per-chunk overhead: two fit in 1 000.
  assertEquals(job.tail, "8".repeat(300) + "9".repeat(300));
});

test("over the room's budget, the output of the job that ended first goes first", () => {
  const rooms = makeCommandsRooms({ roomBudget: 4_000, jobRingBytes: 100_000 });
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  for (let n = 1; n <= 3; n++) uplink.push(started(n));
  uplink.push(output(1, "a".repeat(800)));
  uplink.push(output(2, "b".repeat(800)));
  uplink.push(output(3, "c".repeat(800)));
  uplink.push(exited(2));
  uplink.push(exited(1));
  // Over budget: bg-2 ended first, so its output goes, and bg-1's next; bg-3 is running.
  uplink.push(output(3, "d".repeat(800)));
  uplink.push(output(3, "e".repeat(800)));
  const jobs = snapshotOf(watching(rooms, "run-1")).jobs;
  assertEquals(jobs.map((j) => j.tail.length), [0, 0, 2_400]);

  // With no ended job left holding output, the running job with the most loses its oldest.
  uplink.push(output(3, "f".repeat(800)));
  uplink.push(output(3, "g".repeat(800)));
  const after = snapshotOf(watching(rooms, "run-1")).jobs;
  assert(after[2].tail.endsWith("g".repeat(800)));
  assert(!after[2].tail.startsWith("c"));
  // Every job is still listed: only output is evicted, never a job.
  assertEquals(after.map((j) => [j.id, j.status]), [
    ["bg-1", "ended"],
    ["bg-2", "ended"],
    ["bg-3", "running"],
  ]);
});

test("a new uplink empties the room and viewers are reset before its replay", () => {
  const rooms = makeCommandsRooms();
  const first = rooms.openUplink("run-1");
  assert(typeof first !== "string");
  first.push(started(1));
  first.push(output(1, "old\n"));
  const viewer = watching(rooms, "run-1");
  drain(viewer);

  const second = rooms.openUplink("run-1");
  assert(typeof second !== "string");
  assert(first.signal.aborted);
  // The replaced uplink can no longer write.
  assertEquals(first.push(started(2)), false);
  second.push(started(1));
  second.push(output(1, "replayed\n"));
  const seen = drain(viewer);
  assertEquals(seen.map((o) => o.event), ["snapshot", "started", "output"]);
  assert(seen[0].event === "snapshot");
  assertEquals(seen[0].data.jobs, []);
  assertEquals(snapshotOf(watching(rooms, "run-1")).jobs[0].tail, "replayed\n");
});

test("conclusion hangs up the uplink and says done; a later uplink is refused", () => {
  const rooms = makeCommandsRooms();
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  uplink.push(started(1));
  const viewer = watching(rooms, "run-1");
  drain(viewer);
  rooms.conclude("run-1");
  assert(uplink.signal.aborted);
  assertEquals(drain(viewer).map((o) => o.event), ["uplink", "done"]);
  assert(viewer.finished);
  assertEquals(rooms.openUplink("run-1"), "concluded");

  // A newcomer still sees what the room held, then done.
  const late = drain(watching(rooms, "run-1"));
  assertEquals(late.map((o) => o.event), ["snapshot", "done"]);
  assert(late[0].event === "snapshot");
  assertEquals(late[0].data.jobs.map((j) => j.id), ["bg-1"]);
});

test("a closed uplink's room expires, and the registry is capped", () => {
  let at = 0;
  const rooms = makeCommandsRooms({ now: () => at, expiryMs: 100, maxRooms: 2 });
  const a = rooms.openUplink("run-a");
  const b = rooms.openUplink("run-b");
  assert(typeof a !== "string" && typeof b !== "string");
  assertEquals(rooms.openUplink("run-c"), "full");
  a.close();
  assert(typeof rooms.openUplink("run-c") !== "string");
  assertEquals(rooms.size(), 2);
  b.close();
  at = 1_000;
  rooms.sweep();
  assertEquals(rooms.size(), 1);
});

test("a slow viewer loses the oldest output and is told how much", () => {
  const rooms = makeCommandsRooms({ viewerQueue: 3 });
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  uplink.push(started(1));
  const viewer = watching(rooms, "run-1");
  for (let n = 0; n < 5; n++) uplink.push(output(1, `${n}`));
  const seen = drain(viewer);
  // The snapshot takes one of the three places, and is never the one dropped.
  assertEquals(seen.map((o) => o.event), ["snapshot", "dropped", "output", "output"]);
  assertEquals(seen[1].data, { count: 3 });
  assertEquals(seen.slice(2).map((o) => (o.data as { text: string }).text), ["3", "4"]);
});

test("a slow viewer never misses a start or an exit, only output", () => {
  const rooms = makeCommandsRooms({ viewerQueue: 3 });
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  const viewer = watching(rooms, "run-1");
  uplink.push(started(1));
  for (let n = 0; n < 5; n++) uplink.push(output(1, `${n}`));
  uplink.push(started(2));
  uplink.push(exited(1));
  for (let n = 5; n < 10; n++) uplink.push(output(2, `${n}`));
  const all = drain(viewer);
  assert(all.some((o) => o.event === "dropped"), "output was dropped");
  const seen = all.filter((o) => o.event !== "dropped").map((o) => o.event);
  assertEquals(seen.filter((e) => e === "started").length, 2);
  assertEquals(seen.filter((e) => e === "exited").length, 1);
  assertEquals(seen[0], "snapshot");
});

test("a room's budget counts UTF-8 bytes, not characters", () => {
  // 1 000 three-byte characters are 3 000 bytes: four such chunks overflow a 10 000-byte room.
  const rooms = makeCommandsRooms({ roomBudget: 10_000, jobRingBytes: 100_000 });
  const uplink = rooms.openUplink("run-1");
  assert(typeof uplink !== "string");
  uplink.push(started(1));
  for (let n = 0; n < 4; n++) uplink.push(output(1, "€".repeat(1_000)));
  const [job] = snapshotOf(watching(rooms, "run-1")).jobs;
  assertEquals(job.tail.length, 3_000);
  assertEquals(ROOM_BUDGET, 2 * 1024 * 1024);
  assertEquals(utf8Length("a€😀"), 1 + 3 + 6); // a surrogate pair is counted as six, over four
});

test("a run takes at most its cap of viewers per channel", () => {
  const rooms = makeCommandsRooms({ maxViewers: 2, maxViewersPerPrincipal: 10 });
  const a = watching(rooms, "run-1");
  watching(rooms, "run-1");
  assertEquals(rooms.watch("run-1"), "full");
  // Another run has its own; one leaving makes room.
  watching(rooms, "run-2");
  a.leave();
  assert(rooms.watch("run-1") !== "full");
});

test("one principal holds at most its sub-cap of a run's viewers", () => {
  const rooms = makeCommandsRooms({ maxViewers: 10, maxViewersPerPrincipal: 2 });
  const a = rooms.watch("run-1", { principal: "user:a" });
  assert(a !== "full");
  assert(rooms.watch("run-1", { principal: "user:a" }) !== "full");
  assertEquals(rooms.watch("run-1", { principal: "user:a" }), "full");
  assert(rooms.watch("run-1", { principal: "user:b" }) !== "full");
  // Per run: the same principal on another run has its own.
  assert(rooms.watch("run-2", { principal: "user:a" }) !== "full");
  a.leave();
  assert(rooms.watch("run-1", { principal: "user:a" }) !== "full");
});

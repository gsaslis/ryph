import { describe, expect, it } from "vitest";
import {
  backgroundLogHref,
  getBackgroundLog,
  getRunBackground,
  parseBackgroundJobs,
  parseCommandsEvent,
  parseCommandsSnapshot,
} from "./background";

// A run's background commands come from two places: the control plane's record (every job and how
// it ended, its log once stored) and the historian's live room. Pinned here: the routes, the
// shapes each side sends, and that a row or a line this viewer cannot read is left out rather
// than failing the rest.

type Seen = { url?: string };

const respond = (status: number, body: unknown, seen?: Seen, type = "application/json") =>
  ((url: string) => {
    if (seen) seen.url = url;
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": type },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

const row = {
  id: "bg-1",
  label: "Test suite",
  command: "deno task test",
  cwd: "/work/repo",
  service: false,
  startedAt: "2026-10-06T12:00:00.000Z",
  timeoutAt: "2026-10-06T12:30:00.000Z",
  endedAt: "2026-10-06T12:04:12.000Z",
  reason: "exited",
  exitCode: 1,
  signal: null,
  logBytes: 2048,
  logTruncated: false,
  logTail: "FAILED 2 tests\n",
  hasLog: true,
};

describe("the durable record", () => {
  it("reads every job of the run", async () => {
    const seen: Seen = {};
    const jobs = await getRunBackground(respond(200, { jobs: [row] }, seen), "run-1");
    expect(seen.url).toBe("/api/v1/runs/run-1/background");
    expect(jobs).toEqual([
      {
        id: "bg-1",
        label: "Test suite",
        command: "deno task test",
        cwd: "/work/repo",
        service: false,
        startedAt: Date.parse("2026-10-06T12:00:00.000Z"),
        timeoutAt: Date.parse("2026-10-06T12:30:00.000Z"),
        endedAt: Date.parse("2026-10-06T12:04:12.000Z"),
        reason: "exited",
        exitCode: 1,
        signal: null,
        hasLog: true,
        logTail: "FAILED 2 tests\n",
        logTruncated: false,
      },
    ]);
  });

  it("reads a running job, its ending null", () => {
    const running = {
      ...row,
      id: "bg-2",
      service: true,
      timeoutAt: null,
      endedAt: null,
      reason: null,
      exitCode: null,
      hasLog: false,
      logTail: null,
    };
    const [job] = parseBackgroundJobs({ jobs: [running] });
    expect(job).toMatchObject({ id: "bg-2", service: true, endedAt: null, reason: null });
  });

  it("leaves out a row it cannot read, and keeps the rest", () => {
    const jobs = parseBackgroundJobs({
      jobs: [row, { label: "no id", command: "x", startedAt: 1 }, {
        ...row,
        id: "bg-3",
        reason: "exploded",
      }],
    });
    expect(jobs.map((j) => j.id)).toEqual(["bg-1"]);
    // A time that is not the control plane's ISO string is not read either.
    expect(parseBackgroundJobs({ jobs: [{ ...row, startedAt: 1_000 }] })).toEqual([]);
    expect(() => parseBackgroundJobs([row])).toThrow();
  });

  it("reads a stored log as text, and a missing one as null", async () => {
    const seen: Seen = {};
    const log = await getBackgroundLog(
      respond(200, "<b>not markup</b>\n", seen, "text/plain"),
      "run-1",
      "bg-1",
    );
    expect(log).toBe("<b>not markup</b>\n");
    expect(seen.url).toBe("/api/v1/runs/run-1/background/bg-1/log");
    expect(await getBackgroundLog(respond(404, { error: "no log" }), "run-1", "bg-1")).toBeNull();
    await expect(getBackgroundLog(respond(403, { error: "nope" }), "run-1", "bg-1")).rejects
      .toThrow("nope");
    expect(backgroundLogHref("run-1", "bg-1")).toBe("/api/v1/runs/run-1/background/bg-1/log");
  });
});

describe("the live room", () => {
  it("reads a snapshot, leaving out a job it cannot read", () => {
    const snapshot = parseCommandsSnapshot({
      at: 5,
      uplink: true,
      jobs: [
        {
          at: 1,
          id: "bg-1",
          label: "Build",
          command: "make",
          cwd: "/w",
          service: false,
          timeoutAt: 1_801_000,
          status: "running",
          tail: "compiling\n",
        },
        {
          at: 2,
          id: "bg-2",
          label: "Lint",
          command: "lint",
          cwd: "/w",
          service: false,
          timeoutAt: null,
          status: "ended",
          reason: "exited",
          exitCode: 0,
          signal: null,
          endedAt: 4,
          tail: "",
        },
        { id: "bg-3", status: "running" },
        // An ended job without its end is not one the room sends.
        {
          at: 2,
          id: "bg-4",
          label: "x",
          command: "x",
          cwd: "/w",
          service: false,
          timeoutAt: null,
          status: "ended",
          tail: "",
        },
      ],
    });
    expect(snapshot?.uplink).toBe(true);
    expect(snapshot?.jobs.map((j) => [j.id, j.status, j.tail])).toEqual([
      ["bg-1", "running", "compiling\n"],
      ["bg-2", "ended", ""],
    ]);
    expect(parseCommandsSnapshot({ at: 1, uplink: true })).toBeNull();
    expect(parseCommandsSnapshot({ at: 1, jobs: [] })).toBeNull();
  });

  it("reads each line type, and refuses what it does not know", () => {
    expect(parseCommandsEvent({ type: "output", at: 1, id: "bg-1", text: "hi\n" })).toEqual({
      type: "output",
      at: 1,
      id: "bg-1",
      text: "hi\n",
    });
    expect(parseCommandsEvent({ type: "output", at: 1, id: "bg-1" })).toBeNull();
    expect(parseCommandsEvent({ type: "skipped", at: 1, id: "bg-1", bytes: 4096 })).toMatchObject({
      type: "skipped",
      bytes: 4096,
    });
    expect(
      parseCommandsEvent({
        type: "exited",
        at: 9,
        id: "bg-1",
        reason: "timeout",
        exitCode: null,
        signal: "SIGTERM",
        extra: "stripped",
      }),
    ).toEqual({
      type: "exited",
      at: 9,
      id: "bg-1",
      reason: "timeout",
      exitCode: null,
      signal: "SIGTERM",
    });
    expect(parseCommandsEvent({ type: "exited", at: 9, id: "bg-1", reason: "melted" })).toBeNull();
    expect(parseCommandsEvent({ type: "frame" })).toBeNull();
    expect(parseCommandsEvent("output")).toBeNull();
  });
});

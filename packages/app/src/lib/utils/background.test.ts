import { describe, expect, it } from "vitest";
import type { ToolCall } from "$lib/api/tools";
import {
  backgroundCallOf,
  backgroundNoticeOf,
  endedPhrase,
  jobStatus,
  noticeFailed,
  noticeSentence,
} from "./background";

// How a background command reads in the transcript and the tab: the runner's notice, the agent's
// calls, and a job's status in words.

function call(tool: string, args: unknown, output: string | null, over: Partial<ToolCall> = {}) {
  return {
    seq: 4,
    runId: "run-1",
    at: "2026-10-06T12:00:00.000Z",
    name: `ryph__${tool}`,
    resultText: output,
    useText: null,
    isError: false,
    done: output !== null,
    view: { kind: "mcp", server: "ryph", tool, args, output },
    images: { kept: [], notKept: 0 },
    ...over,
  } as ToolCall;
}

describe("backgroundNoticeOf", () => {
  const payload = {
    kind: "system",
    sender: { kind: "platform" },
    text: "...",
    payload: null,
    background: {
      id: "bg-1",
      label: "Test suite",
      reason: "exited",
      exitCode: 1,
      signal: null,
      durationMs: 252_000,
    },
  };

  it("reads the notice off an inbound payload", () => {
    const notice = backgroundNoticeOf(payload);
    expect(notice).toEqual({
      id: "bg-1",
      label: "Test suite",
      reason: "exited",
      exitCode: 1,
      signal: null,
      durationMs: 252_000,
    });
    expect(noticeSentence(notice!)).toBe("exited 1 after 4m 12s");
    expect(noticeFailed(notice!)).toBe(true);
  });

  it("reads readiness as ready, not an exit or failure", () => {
    const notice = backgroundNoticeOf({
      ...payload,
      background: {
        id: "bg-3",
        label: "Playground",
        reason: "ready",
        exitCode: null,
        signal: null,
        durationMs: 12_000,
      },
    });
    expect(notice).toEqual({
      id: "bg-3",
      label: "Playground",
      reason: "ready",
      exitCode: null,
      signal: null,
      durationMs: 12_000,
    });
    expect(noticeSentence(notice!)).toBe("ready after 12s");
    expect(noticeFailed(notice!)).toBe(false);
  });

  it("is not fooled by a wake-up, an inbox message, or a notice it cannot read", () => {
    expect(backgroundNoticeOf({ kind: "system", wake: { afterMinutes: 5 } })).toBeNull();
    expect(backgroundNoticeOf({ seq: 3, kind: "chat" })).toBeNull();
    expect(backgroundNoticeOf({ background: { id: "bg-1", reason: "exploded" } })).toBeNull();
    expect(backgroundNoticeOf(null)).toBeNull();
  });

  it("says a timeout and a signal in words", () => {
    const timeout = backgroundNoticeOf({
      background: {
        id: "bg-2",
        label: "Dev server",
        reason: "timeout",
        exitCode: null,
        signal: "SIGTERM",
        durationMs: 1_800_000,
      },
    })!;
    expect(noticeSentence(timeout)).toBe("timed out after 30m");
    expect(noticeFailed(timeout)).toBe(true);
    expect(endedPhrase({ reason: "exited", exitCode: null, signal: "SIGKILL" })).toBe(
      "killed by SIGKILL",
    );
  });

  it("refuses a notice missing a field the runner always sends", () => {
    const { label: _label, ...noLabel } = payload.background;
    const { durationMs: _ms, ...noDuration } = payload.background;
    expect(backgroundNoticeOf({ background: noLabel })).toBeNull();
    expect(backgroundNoticeOf({ background: noDuration })).toBeNull();
    // A stop or the run's end sends no notice, so neither reads as one.
    expect(backgroundNoticeOf({ background: { ...payload.background, reason: "stopped" } }))
      .toBeNull();
  });
});

describe("jobStatus", () => {
  const base = { startedAt: 0, endedAt: null, reason: null, exitCode: null, signal: null };

  it("ticks a running job's clock", () => {
    expect(jobStatus(base, 75_000)).toEqual({
      label: "Running",
      duration: "1m 15s",
      tone: "running",
    });
  });

  it("names each ending, and which are failures", () => {
    const end = (over: object) => jobStatus({ ...base, endedAt: 4_000, ...over }, 99_000);
    expect(end({ reason: "exited", exitCode: 0 })).toEqual({
      label: "Exited 0",
      duration: "4s",
      tone: "ok",
    });
    expect(end({ reason: "exited", exitCode: 2 }).tone).toBe("failed");
    expect(end({ reason: "timeout" })).toMatchObject({ label: "Timed out", tone: "failed" });
    expect(end({ reason: "stopped" })).toMatchObject({ label: "Stopped", tone: "quiet" });
    expect(end({ reason: "run_ended" })).toMatchObject({
      label: "Ended with the run",
      tone: "quiet",
    });
  });
});

describe("backgroundCallOf", () => {
  it("reads a start's label and the id the runner minted", () => {
    const started = call(
      "background_run",
      { command: "deno task test", label: "Test suite" },
      "Started bg-3. Its log is at /run/background/bg-3.log.",
    );
    expect(backgroundCallOf(started)).toEqual({ tool: "run", jobId: "bg-3", label: "Test suite" });
    // Still running, or refused: no id yet.
    expect(backgroundCallOf(call("background_run", { label: "x" }, null))?.jobId).toBeNull();
    expect(
      backgroundCallOf(
        call("background_run", { label: "x" }, "8 running (bg-1…)", { isError: true }),
      )
        ?.jobId,
    ).toBeNull();
  });

  it("reads which job an output read or a stop named", () => {
    expect(backgroundCallOf(call("background_output", { id: "bg-2" }, "running"))).toEqual({
      tool: "output",
      jobId: "bg-2",
      label: null,
    });
    expect(backgroundCallOf(call("background_output", {}, "bg-1 running"))?.jobId).toBeNull();
    expect(backgroundCallOf(call("background_stop", { id: "../x" }, "no")))?.toMatchObject({
      jobId: null,
    });
  });

  it("leaves every other call alone", () => {
    expect(backgroundCallOf(call("wake_me", { afterMinutes: 5 }, "ok"))).toBeNull();
    const elsewhere = call("background_run", { label: "x" }, "bg-1");
    elsewhere.view = {
      kind: "mcp",
      server: "other",
      tool: "background_run",
      args: {},
      output: "bg-1",
    };
    expect(backgroundCallOf(elsewhere)).toBeNull();
  });
});

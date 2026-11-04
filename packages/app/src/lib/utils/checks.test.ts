import { describe, expect, it } from "vitest";
import { checkSuiteViewSchema } from "$lib/api/types";
import { suite as raw } from "$lib/api/checks.test-fixture";
import {
  canRerunSuite,
  checkDurationMs,
  checkStateLabel,
  checkTone,
  countsLabel,
  definedAtLabel,
  isSuiteSettled,
  listedSuiteIds,
  logMatchLines,
  partialLabel,
  ryphChange,
  suiteCounts,
  suiteDurationMs,
  suiteImageLabel,
  suitesForRun,
  timeoutLabel,
  watchedChange,
} from "./checks";

const suite = checkSuiteViewSchema.parse(raw);

describe("check suites in words", () => {
  it("settles on a verdict, and any settled suite runs again", () => {
    expect(isSuiteSettled("running")).toBe(false);
    expect(isSuiteSettled("waiting")).toBe(false);
    expect(isSuiteSettled("passed")).toBe(true);
    expect(canRerunSuite("passed")).toBe(true);
    expect(canRerunSuite("queued")).toBe(false);
    expect(canRerunSuite("waiting")).toBe(false);
    expect(canRerunSuite("running")).toBe(false);
    expect(canRerunSuite("failed")).toBe(true);
    expect(canRerunSuite("error")).toBe(true);
    expect(canRerunSuite("cancelled")).toBe(true);
  });

  it("names states and reads their tone", () => {
    expect(checkStateLabel("timed_out")).toBe("Timed out");
    expect(checkStateLabel("waiting")).toBe("Waiting for build");
    expect(checkTone("setup_failed")).toBe("failed");
    expect(checkTone("running")).toBe("active");
    expect(checkTone("queued")).toBe("idle");
  });

  it("counts a suite and says the count", () => {
    const counts = suiteCounts(suite);
    expect(counts).toEqual({ passed: 1, failed: 1, total: 2 });
    expect(countsLabel(counts)).toBe("1 of 2 failed");
    expect(countsLabel({ passed: 2, failed: 0, total: 2 })).toBe("2 of 2 passed");
    expect(countsLabel({ passed: 0, failed: 0, total: 0 })).toBe("No checks");
  });

  it("ticks running checks and freezes recorded durations", () => {
    const startedAt = "2026-01-01T00:00:00Z";
    const start = Date.parse(startedAt);
    const running = { startedAt, finishedAt: null, state: "running" as const };
    expect(checkDurationMs(running, start + 1_000)).toBe(1_000);
    expect(checkDurationMs(running, start + 2_000)).toBe(2_000);
    expect(checkDurationMs(suite.checks[0], start)).toBe(30_000);
    expect(checkDurationMs({ ...running, startedAt: null }, start)).toBeNull();
    expect(checkDurationMs({ ...running, state: "queued" }, start)).toBeNull();
    expect(checkDurationMs({ ...running, state: "cancelled" }, start)).toBeNull();
    expect(checkDurationMs({ ...running, startedAt: "invalid" }, start)).toBeNull();
    expect(checkDurationMs(running, start - 1)).toBeNull();
  });

  it("ticks only launched running suites and preserves completed durations", () => {
    const launchedAt = "2026-01-01T00:00:00Z";
    const start = Date.parse(launchedAt);
    const running = { ...suite, launchedAt, finishedAt: null, state: "running" as const };
    expect(suiteDurationMs(running, start + 1_000)).toBe(1_000);
    expect(suiteDurationMs(running, start + 2_000)).toBe(2_000);
    expect(suiteDurationMs({ ...running, launchedAt: null }, start)).toBeNull();
    expect(suiteDurationMs({ ...running, state: "queued" }, start)).toBeNull();
    expect(suiteDurationMs({ ...running, state: "cancelled" }, start)).toBeNull();
    const done = { ...running, finishedAt: "2026-01-01T00:00:10Z", state: "passed" as const };
    expect(suiteDurationMs(done, start + 60_000)).toBe(10_000);
  });

  it("says where the checks came from and what they ran on", () => {
    expect(definedAtLabel(suite)).toBe("main@bbbbbbb");
    expect(definedAtLabel({ checksRef: "refs/heads/dev", checksCommit: "1234567890" })).toBe(
      "dev@1234567",
    );
    expect(suiteImageLabel(suite)).toBe("ryph-agent@dddd");
    expect(
      suiteImageLabel({ environment: { key: "tree:abc", image: null, environmentId: "env-1" } }),
    ).toBe("the repository's environment");
    expect(timeoutLabel(900)).toBe("15m");
    expect(timeoutLabel(3600)).toBe("1h");
    expect(timeoutLabel(90)).toBe("90s");
  });
});

describe("which suites belong where", () => {
  const byPatch = {
    ...suite,
    id: "cs-2",
    requestedBy: [{ kind: "patch" as const, runId: null, patchId: "p-1" }],
  };
  const other = {
    ...suite,
    id: "cs-3",
    requestedBy: [{ kind: "tool" as const, runId: "run-9", patchId: null }],
  };

  it("a run's suites are the ones it asked for and the ones on its patches", () => {
    const got = suitesForRun([suite, byPatch, other], "run-1", new Set(["p-1"]));
    expect(got.map((s) => s.id)).toEqual([suite.id, "cs-2"]);
    expect(suitesForRun([suite], null, new Set())).toEqual([]);
  });

  it("lists the newest full suite of each line of work, and any that did not pass", () => {
    const at = (id: string, commit: string, time: string, over: Partial<typeof suite> = {}) => ({
      ...suite,
      id,
      commit,
      state: "passed" as const,
      launchedAt: time,
      requestedBy: [],
      partial: false,
      ...over,
    });
    const patch = (id: string, line: string, headSha: string, checksSuiteId: string | null) => ({
      id,
      connectedRepoId: suite.connectedRepoId,
      path: "app",
      line,
      headSha,
      checksSuiteId,
    });
    const suites = [
      at("cs-w1", "a1", "2026-01-01T00:00:00Z"),
      at("cs-w2", "a2", "2026-01-01T00:02:00Z"),
      // Another line's suite, OLDER than the default line's newest: still its line's verdict.
      at("cs-f1", "b1", "2026-01-01T00:01:00Z", {
        requestedBy: [{ kind: "patch", runId: null, patchId: "p-f1" }],
      }),
      // A run of some checks is never the verdict; a failure is always listed.
      at("cs-f2", "b2", "2026-01-01T00:03:00Z", { partial: true }),
      at("cs-x", "c1", "2026-01-01T00:00:30Z", { state: "failed" }),
    ];
    const patches = [
      patch("p-w1", "work", "a1", "cs-w1"),
      patch("p-w2", "work", "a2", null),
      patch("p-f1", "fix-a", "b1", null),
      patch("p-f2", "fix-a", "b2", null),
    ];
    expect([...listedSuiteIds(suites, patches)].toSorted()).toEqual(["cs-f1", "cs-w2", "cs-x"]);
  });

  it("a run of only some checks says which it ran", () => {
    const partial = { ...suite, id: "cs-5", partial: true, checks: [suite.checks[0]] };
    expect(partialLabel(partial)).toBe(`Only ${suite.checks[0].name}`);
    expect(partialLabel(suite)).toBeNull();
    // a server that predates the field sends none: a full run
    expect(suite.partial).toBe(false);
  });
});

describe("what the change touched", () => {
  it("shows a check's watched files as changed, unknown once it ran, and nothing otherwise", () => {
    expect(watchedChange({ state: "failed", watchedChanged: true })).toBe("changed");
    expect(watchedChange({ state: "passed", watchedChanged: false })).toBeNull();
    expect(watchedChange({ state: "passed", watchedChanged: null })).toBe("unknown");
    expect(watchedChange({ state: "timed_out", watchedChanged: null })).toBe("unknown");
    // never ran: there was nothing to know yet
    expect(watchedChange({ state: "queued", watchedChanged: null })).toBeNull();
    expect(watchedChange({ state: "setup_failed", watchedChanged: null })).toBeNull();
  });

  it("never reads an unknown .ryph/ change as unchanged", () => {
    expect(ryphChange(suite)).toBeNull();
    expect(ryphChange({ ...suite, ryphChanged: true })).toBe("changed");
    expect(ryphChange({ ...suite, ryphChanged: null })).toBe("unknown");
    const queued = suite.checks.map((check) => ({ ...check, state: "queued" as const }));
    expect(ryphChange({ ...suite, ryphChanged: null, checks: queued })).toBeNull();
  });
});

describe("logMatchLines", () => {
  const log = "Check a.ts\nerror: boom\nok\nError again, error twice\n";

  it("finds each line once, ignoring case", () => {
    expect(logMatchLines(log, "error")).toEqual([2, 4]);
  });

  it("counts lines past ones that hold no match", () => {
    expect(logMatchLines(log, "twice")).toEqual([4]);
    expect(logMatchLines("a\n\n\nb", "b")).toEqual([4]);
  });

  it("matches nothing for an empty query, or one not there", () => {
    expect(logMatchLines(log, "")).toEqual([]);
    expect(logMatchLines(log, "nope")).toEqual([]);
  });

  it("finds a match that spans the end of the log", () => {
    expect(logMatchLines("x\nlast", "last")).toEqual([2]);
  });
});

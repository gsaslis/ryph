import { describe, expect, it } from "vitest";
import type { EnvironmentView, SubjectEnvironment } from "$lib/api/types";
import {
  buildDurationMs,
  buildKindLabel,
  buildProgress,
  builtAt,
  builtFromLabel,
  environmentHeadline,
  environmentStatusLabel,
  formatBytes,
  ignoredDockerfiles,
  isReadyWithSetupWarnings,
  latestBuild,
  logTail,
  logTailLines,
  machineLabel,
  patchBuildLabel,
  runEnvironmentLabel,
  setupAction,
  setupWarningLabel,
  shortImage,
  systemPayloadLabel,
  toolchainEntries,
  triggerLabel,
} from "./environments";

// The card leads with one answer, and the order the answers override one another in is the part
// that is easy to get wrong: environments off beats a refusing builder beats a build in flight
// beats a failed one beats the one in use. The wording is the user's — no layer, no digest.

const build = (over: Partial<EnvironmentView> = {}): EnvironmentView => ({
  id: "env-1",
  subjectKind: "repo",
  subjectId: "cr-1",
  ref: "main",
  commits: { heartwood: "0123456789abcdef" },
  definition: "feedface",
  baseDigest: null,
  harnessDigest: null,
  image: "reg/ryph-envs/repo-cr-1@sha256:cccccccccccccccccccc",
  status: "ready",
  toolchains: {},
  sizeBytes: null,
  trigger: "push",
  reason: null,
  startedAt: "2026-09-18T10:00:00.000Z",
  finishedAt: "2026-09-18T10:20:00.000Z",
  createdAt: "2026-09-18T09:59:00.000Z",
  logTail: null,
  machine: false,
  egressNote: null,
  setupWarnings: [],
  kind: "full",
  estimateMs: null,
  ...over,
});

const env = (over: Partial<SubjectEnvironment> = {}): SubjectEnvironment => ({
  enabled: true,
  builder: "docker",
  refusedReason: null,
  current: null,
  latest: null,
  sizeClass: null,
  ...over,
});

/** What the streamed forge read answers, as the card gets it. */
const described = (ryph: boolean, dockerfile = false, ignored: string[] = []) => ({
  definition: { ryph, dockerfile },
  ignoredDockerfiles: ignored,
});

describe("environmentHeadline", () => {
  it("says off first, whatever else is recorded", () => {
    expect(environmentHeadline(env({ enabled: false, refusedReason: "manual", current: build() })))
      .toEqual({ kind: "off" });
  });

  it("says why the builder refuses, before any build", () => {
    expect(environmentHeadline(env({ refusedReason: "This deployment builds nothing." }))).toEqual({
      kind: "refused",
      reason: "This deployment builds nothing.",
    });
  });

  it("is none when nothing was ever built", () => {
    expect(environmentHeadline(env())).toEqual({ kind: "none" });
  });

  it("is ready when the newest build is the one in use", () => {
    const current = build();
    expect(environmentHeadline(env({ current, latest: current }))).toEqual({
      kind: "ready",
      current,
    });
  });

  it("is building while a newer build is queued or running, keeping the one in use", () => {
    const current = build();
    const latest = build({ id: "env-2", status: "queued", image: null });
    expect(environmentHeadline(env({ current, latest }))).toEqual({
      kind: "building",
      build: latest,
      current,
    });
    const first = build({ id: "env-3", status: "building", image: null });
    expect(environmentHeadline(env({ latest: first }))).toEqual({
      kind: "building",
      build: first,
      current: null,
    });
  });

  it("is failed when the newest build failed, and still names what runs use", () => {
    const current = build();
    const latest = build({ id: "env-2", status: "failed", image: null });
    expect(environmentHeadline(env({ current, latest }))).toEqual({
      kind: "failed",
      build: latest,
      current,
    });
  });

  it("does not report a superseded newest build as news", () => {
    const current = build();
    expect(environmentHeadline(env({ current, latest: build({ id: "x", status: "superseded" }) })))
      .toEqual({ kind: "ready", current });
  });
});

describe("latestBuild", () => {
  it("prefers the newest build, then the one in use", () => {
    const current = build();
    const latest = build({ id: "env-2" });
    expect(latestBuild(env({ current, latest }))).toBe(latest);
    expect(latestBuild(env({ current }))).toBe(current);
    expect(latestBuild(env())).toBeNull();
  });
});

describe("wording", () => {
  it("names every status without the machinery", () => {
    for (const status of ["queued", "building", "ready", "failed", "superseded"] as const) {
      expect(environmentStatusLabel(status)).not.toMatch(/layer|digest|context/i);
    }
    expect(environmentStatusLabel("queued")).toBe("Waiting to build");
  });

  it("names a repo's commit bare and a workspace's per member", () => {
    expect(builtFromLabel({ heartwood: "0123456789abcdef" })).toBe("0123456");
    expect(builtFromLabel({ api: "aaaaaaaaaa", web: "bbbbbbbbbb" })).toBe(
      "api@aaaaaaa, web@bbbbbbb",
    );
    expect(builtFromLabel({})).toBe("—");
  });

  it("shortens an image to its name and the start of its pin", () => {
    expect(shortImage("europe-docker.pkg.dev/p/ryph-envs/repo-cr-1@sha256:0123456789abcdef"))
      .toBe("repo-cr-1@0123456789ab");
    expect(shortImage("ryph-agent:abc")).toBe("ryph-agent:abc");
    expect(shortImage("sha256:0123456789abcdef")).toBe("sha256:0123456789abcdef");
  });

  it("says when the machine is the universal image", () => {
    expect(machineLabel({ definition: null })).toMatch(/Universal image/);
    expect(machineLabel({ definition: "feedface" })).toBe("The repository's .ryph/");
    expect(machineLabel({ definition: "sha256:feedface" }, "workspace")).toBe(
      "The members' .ryph/",
    );
    expect(machineLabel({ definition: null }, "workspace")).toMatch(/Universal image/);
  });

  it("formats sizes in decimal units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(850_000_000)).toBe("850 MB");
    expect(formatBytes(3_400_000_000)).toBe("3.4 GB");
  });

  it("sorts toolchains by name", () => {
    expect(toolchainEntries({ rustc: "1.97.1", node: "24.3.0", cargo: "1.97.1" })).toEqual([
      ["cargo", "1.97.1"],
      ["node", "24.3.0"],
      ["rustc", "1.97.1"],
    ]);
  });

  it("names known triggers and passes unknown ones through", () => {
    expect(triggerLabel("manual")).toBe("rebuilt by hand");
    expect(triggerLabel("something-new")).toBe("something-new");
  });

  it("dates a build by when it finished, else started, else was asked for", () => {
    expect(builtAt(build())).toBe("2026-09-18T10:20:00.000Z");
    expect(builtAt(build({ finishedAt: null }))).toBe("2026-09-18T10:00:00.000Z");
    expect(builtAt(build({ finishedAt: null, startedAt: null }))).toBe(
      "2026-09-18T09:59:00.000Z",
    );
  });
});

describe("runEnvironmentLabel", () => {
  it("names the default image", () => {
    expect(
      runEnvironmentLabel({
        id: "default",
        image: "ryph-agent:1",
        ref: null,
        commits: {},
        builtAt: null,
      }),
    ).toBe("Default image");
  });

  it("names the commit an environment was built from", () => {
    expect(
      runEnvironmentLabel({
        id: "env-1",
        image: "x@sha256:1",
        ref: "main",
        commits: { heartwood: "0123456789" },
        builtAt: null,
      }),
    ).toBe("Built from 0123456");
  });
});

describe("setupWarningLabel", () => {
  const of = (...kinds: string[]) =>
    setupWarningLabel(kinds.map((kind) => ({ path: "api", kind, summary: "", detail: "" })));

  it("says setup didn't finish only for a step, an invalid file or a discard", () => {
    expect(of("step")).toBe("Setup didn't finish");
    expect(of("invalid", "unreadable")).toBe("Setup didn't finish");
    expect(of("discarded")).toBe("Setup didn't finish");
  });

  it("says an unreadable record is unknown, not unfinished", () => {
    expect(of("unreadable")).toBe("Setup unknown");
    expect(of("dirty", "unreadable")).toBe("Setup unknown");
    expect(of("dirty")).toBe("Setup changes discarded");
  });
});

describe("isReadyWithSetupWarnings", () => {
  const warning = {
    path: "acme/api",
    kind: "step",
    summary: "setup.yml step 2 exited 1",
    detail: "",
  };

  it("is true only for a ready build with warnings", () => {
    expect(isReadyWithSetupWarnings({ status: "ready", setupWarnings: [warning] })).toBe(true);
    expect(isReadyWithSetupWarnings({ status: "ready", setupWarnings: [] })).toBe(false);
    expect(isReadyWithSetupWarnings({ status: "failed", setupWarnings: [warning] })).toBe(false);
    expect(isReadyWithSetupWarnings({ status: "building", setupWarnings: [warning] })).toBe(false);
  });

  it("does not count a setup that finished and only had its changes discarded", () => {
    const dirty = { ...warning, kind: "dirty" };
    expect(isReadyWithSetupWarnings({ status: "ready", setupWarnings: [dirty] })).toBe(false);
    expect(isReadyWithSetupWarnings({ status: "ready", setupWarnings: [dirty, warning] }))
      .toBe(true);
  });

  it("treats missing warnings as none", () => {
    expect(isReadyWithSetupWarnings({ status: "ready", setupWarnings: null })).toBe(false);
    expect(isReadyWithSetupWarnings({ status: "ready" })).toBe(false);
  });
});

describe("logTail", () => {
  it("keeps the last lines, where a failure is", () => {
    const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n\n";
    const tail = logTail(log, 3);
    expect(tail).toBe("line 97\nline 98\nline 99");
  });

  it("keeps a short log whole", () => {
    expect(logTail("one\ntwo")).toBe("one\ntwo");
  });
});

describe("setupAction", () => {
  it("is prominent exactly when the default branch describes no machine", () => {
    expect(setupAction(env(), described(false))).toEqual({
      state: "offer",
      label: "Set up this repo's environment",
      prominent: true,
    });
    const workspace = setupAction(env(), described(false), "workspace");
    expect(workspace).toEqual({
      state: "offer",
      label: "Set up this workspace's environment",
      prominent: true,
    });
  });

  it("is a quiet Revise once there is a .ryph/, and a quiet Set up when the forge could not say", () => {
    expect(setupAction(env(), described(true))).toEqual({
      state: "offer",
      label: "Revise environment",
      prominent: false,
    });
    // A workspace whose environment repo has no .ryph/ but a member does: the server says
    // `ryph` for any member, so it is a Revise, not a Set up.
    expect(setupAction(env(), described(true, false), "workspace")).toEqual({
      state: "offer",
      label: "Revise environment",
      prominent: false,
    });
    expect(setupAction(env(), { definition: null, ignoredDockerfiles: [] })).toEqual({
      state: "offer",
      label: "Set up this repo's environment",
      prominent: false,
    });
  });

  it("says it is still reading while the forge half is in flight, and offers nothing yet", () => {
    const reading = setupAction(env(), null);
    expect(reading?.state).toBe("reading");
    expect(reading).toMatchObject({ note: "Reading what the repository describes…" });
    expect(setupAction(env(), null, "workspace")).toMatchObject({
      note: "Reading what the workspace's repositories describe…",
    });
  });

  it("degrades quietly when the forge could not be read at all", () => {
    const failed = setupAction(env(), { error: "the forge could not read acme/api — try again" });
    expect(failed?.state).toBe("unreadable");
    expect(failed).toMatchObject({
      note: "We couldn't read the repository just now, so there is nothing to offer here. " +
        "Reloading tries again.",
    });
  });

  it("is not offered where nothing would build it", () => {
    expect(setupAction(env({ enabled: false }), described(false))).toBeNull();
    expect(setupAction(env({ refusedReason: "This deployment builds nothing." }), described(false)))
      .toBeNull();
    expect(setupAction(null, described(false))).toBeNull();
  });
});

describe("ignoredDockerfiles", () => {
  it("names the members whose Dockerfile the workspace passes over", () => {
    expect(ignoredDockerfiles(described(true, true, ["acme/web"]))).toEqual(["acme/web"]);
    expect(ignoredDockerfiles(described(true, true))).toEqual([]);
  });

  it("knows nothing while the forge half is in flight, or when it failed", () => {
    expect(ignoredDockerfiles(null)).toBeNull();
    expect(ignoredDockerfiles({ error: "not just now" })).toBeNull();
  });
});

describe("the run page's build results", () => {
  it("labels a platform message by what it carries", () => {
    const base = { patchId: "p-1", path: "api", headSha: "abc1234" };
    expect(
      systemPayloadLabel({
        ...base,
        kind: "patch",
        generation: 1,
        state: "merged",
        forgeUrl: null,
        reason: null,
        hookPaths: [],
      }),
    ).toBe("patch merged");
    expect(
      systemPayloadLabel({
        ...base,
        kind: "patch",
        generation: 1,
        state: "held",
        forgeUrl: null,
        reason: null,
        hookPaths: [".husky/post-checkout"],
      }),
    ).toBe("patch needs approval");
    expect(
      systemPayloadLabel({
        ...base,
        kind: "patch",
        generation: 1,
        state: "missed",
        forgeUrl: null,
        reason: null,
        hookPaths: [],
      }),
    ).toBe("patch not in merge");
    expect(
      systemPayloadLabel({ ...base, kind: "environment", environmentId: "env-1", status: "ready" }),
    ).toBe("environment built");
    expect(
      systemPayloadLabel({
        ...base,
        kind: "environment",
        environmentId: "env-1",
        status: "failed",
      }),
    ).toBe("environment build failed");
    expect(
      systemPayloadLabel({ ...base, kind: "environment", environmentId: null, status: "skipped" }),
    ).toBe("no environment build");
    expect(systemPayloadLabel({ kind: "finish" })).toBe("finished the run");
  });

  it("says what a patch's build came to, or why there was none", () => {
    const row = {
      patchId: "p-1",
      runId: "r-1",
      environmentId: null,
      branch: "ryph/ada-r1",
      note: "its .ryph/ is the same as main's",
      checkedAt: "2026-09-18T10:00:00.000Z",
      reportedAt: null,
      environment: null,
    };
    expect(patchBuildLabel(row)).toBe("its .ryph/ is the same as main's");
    expect(patchBuildLabel({ ...row, note: null })).toBe(
      "Not checked yet — the platform retries on its own",
    );
    expect(
      patchBuildLabel({ ...row, environmentId: "env-1", note: null, environment: build() }),
    ).toBe("Ready");
    expect(triggerLabel("patch")).toBe("for a patch");
    expect(triggerLabel("check")).toBe("for checks");
  });
});

describe("a build's progress, against how long builds like it take", () => {
  const started = Date.parse("2026-09-29T10:00:00.000Z");
  const running = (estimateMs: number | null) =>
    build({ status: "building", startedAt: "2026-09-29T10:00:00.000Z", estimateMs });

  it("names the kind of build", () => {
    expect(buildKindLabel("full")).toBe("Full build");
    expect(buildKindLabel("incremental")).toBe("Incremental build");
    expect(buildKindLabel("relayer")).toBe("Platform update");
  });

  it("says how far along it is, and how long builds like it usually take", () => {
    expect(buildProgress(running(null), started + 4 * 60_000)).toBe("4 min so far");
    expect(buildProgress(running(6 * 60_000), started + 4 * 60_000)).toBe(
      "4 min so far, usually takes about 6 min",
    );
    expect(buildProgress(running(6 * 60_000), started + 20_000)).toBe(
      "under a minute so far, usually takes about 6 min",
    );
  });

  it("past the estimate it is taking longer than usual, never late", () => {
    expect(buildProgress(running(6 * 60_000), started + 11 * 60_000)).toBe(
      "11 min so far, longer than the usual 6 min",
    );
  });

  it("a queued build waits for a builder; a settled one has no progress", () => {
    expect(buildProgress(build({ status: "queued" }), started)).toBe("Waiting for a free builder");
    expect(buildProgress(build({ status: "ready" }), started)).toBeNull();
  });

  it("a live log is shown by its end", () => {
    const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n";
    expect(logTailLines(log, 2)).toBe("line 98\nline 99");
  });
});

describe("buildDurationMs", () => {
  it("is start to end, and null for a build that has not ended or never started", () => {
    expect(
      buildDurationMs({
        startedAt: "2026-10-01T10:00:00.000Z",
        finishedAt: "2026-10-01T10:25:00.000Z",
      }),
    ).toBe(25 * 60_000);
    expect(buildDurationMs({ startedAt: "2026-10-01T10:00:00.000Z", finishedAt: null })).toBeNull();
    expect(buildDurationMs({ startedAt: null, finishedAt: "2026-10-01T10:00:00.000Z" })).toBeNull();
  });
});

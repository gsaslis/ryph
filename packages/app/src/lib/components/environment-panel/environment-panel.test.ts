import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import type { EnvironmentView, SubjectEnvironment } from "$lib/api/types";
import EnvironmentPanel from "./environment-panel.svelte";

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));

const build: EnvironmentView = {
  id: "env-latest",
  subjectKind: "repo",
  subjectId: "repo-1",
  ref: "main",
  commits: { repo: "0123456789abcdef" },
  definition: "feedface",
  baseDigest: null,
  harnessDigest: null,
  image: "registry/image@sha256:abcdef",
  status: "ready",
  toolchains: {},
  sizeBytes: null,
  trigger: "push",
  reason: null,
  startedAt: "2026-09-18T10:00:00.000Z",
  finishedAt: "2026-09-18T10:20:00.000Z",
  createdAt: "2026-09-18T09:59:00.000Z",
  logTail: "Private build output example",
  machine: false,
  egressNote: null,
  setupWarnings: [],
  kind: "full",
  estimateMs: null,
};

function panel(kind: "repo" | "workspace", latest: EnvironmentView | null) {
  const environment: SubjectEnvironment = {
    enabled: true,
    builder: "docker",
    refusedReason: null,
    current: latest ? { ...build, id: "env-current" } : null,
    latest,
    sizeClass: null,
  };
  return render(EnvironmentPanel, {
    props: {
      subject: { kind, id: "subject-1" },
      environment,
      definition: Promise.resolve(null),
      canManage: true,
    },
  }).body;
}

describe("environment panel build navigation", () => {
  for (const kind of ["repo", "workspace"] as const) {
    for (const status of ["ready", "queued", "building", "failed"] as const) {
      it(`links the ${kind}'s latest ${status} build instead of embedding details`, () => {
        const body = panel(kind, { ...build, status });
        expect(body).toContain('href="/builds/env-latest"');
        expect(body).toContain("View build details");
        expect(body).not.toContain(build.logTail);
        expect(body).not.toContain(build.image);
        expect(body).not.toContain("Full log");
        expect(body).toContain("Rebuild");
      });
    }
    it(`does not link a missing ${kind} build`, () => {
      const body = panel(kind, null);
      expect(body).toContain("Nothing built yet");
      expect(body).not.toContain("View build details");
    });
  }
});

describe("environment panel setup warnings", () => {
  it("says a ready build's setup didn't finish, the repo's words as plain text", () => {
    const body = panel("repo", {
      ...build,
      setupWarnings: [{
        path: "api",
        kind: "step",
        summary: "`api/`: step 1 of 2 (npm ci) exited with code 1, and the build went on.",
        detail: "<b>npm ERR!</b>",
      }],
    });
    expect(body).toContain("Setup didn't finish");
    expect(body).toContain("step 1 of 2 (npm ci) exited with code 1");
    expect(body).toContain("&lt;b>npm ERR!&lt;/b>");
    expect(body).not.toContain("<b>npm ERR!</b>");
  });

  it("says setup changes were discarded when setup finished but left files changed", () => {
    const body = panel("repo", {
      ...build,
      setupWarnings: [{
        path: "api",
        kind: "dirty",
        summary: "`api/`: setup.yml finished but left changes in the tree (`Cargo.lock`).",
        detail: "",
      }],
    });
    expect(body).toContain("Setup changes discarded");
    expect(body).not.toContain("Setup didn");
  });

  it("says an unreadable setup record is unknown, not a setup that didn't finish", () => {
    const body = panel("repo", {
      ...build,
      setupWarnings: [{
        path: "api",
        kind: "unreadable",
        summary: "`api/`: the build's record of its setup could not be read.",
        detail: "",
      }],
    });
    expect(body).toContain("Setup unknown");
    expect(body).toContain("unknown whether every step finished");
    expect(body).not.toContain("Setup didn");
    expect(body).not.toContain("without the rest of these steps");
  });

  it("says nothing when every repo's setup finished", () => {
    expect(panel("repo", build)).not.toContain("Setup didn");
  });
});

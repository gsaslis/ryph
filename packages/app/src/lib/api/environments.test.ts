import { describe, expect, it } from "vitest";
import {
  environmentLogHref,
  getEnvironment,
  getEnvironmentDefinition,
  getEnvironmentDefinitionOrError,
  getEnvironmentLog,
  getEnvironmentOrError,
  rebuildEnvironment,
  setupEnvironment,
} from "./environments";
import { runMessageSchema, taskDetailSchema, taskRunSchema } from "./types";

// The environment card reads two routes per subject — the facts, which the page awaits, and what
// the default branch describes, which it streams because that one makes the forge fetch the
// repository — and a run waiting on a build reads that build's log as plain text. Pinned here:
// which route each read goes to, the shape the card renders, and that a control plane refusing
// either costs the page its card, not the page.

type Seen = { url?: string; init?: RequestInit };

const respond = (status: number, body: unknown, seen?: Seen, type = "application/json") =>
  ((url: string, init?: RequestInit) => {
    if (seen) {
      seen.url = url;
      seen.init = init;
    }
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": type },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

const view = {
  id: "env-1",
  subjectKind: "repo",
  subjectId: "cr-1",
  ref: "main",
  commits: { heartwood: "0123456789abcdef" },
  definition: "feedface",
  baseDigest: "quay.io/ryph/ryph-universal@sha256:aaaa",
  harnessDigest: "ryph-harness@sha256:bbbb",
  image: "europe-docker.pkg.dev/p/ryph-envs/repo-cr-1@sha256:cccc",
  status: "ready",
  toolchains: { rustc: "1.97.1" },
  sizeBytes: 4_200_000_000,
  trigger: "push",
  reason: null,
  startedAt: "2026-09-18T10:00:00.000Z",
  finishedAt: "2026-09-18T10:20:00.000Z",
  createdAt: "2026-09-18T09:59:00.000Z",
  logTail: "#12 DONE 3.1s",
  machine: true,
  egressNote: null,
  setupWarnings: [],
  kind: "full",
  estimateMs: null,
};

const subject = {
  enabled: true,
  builder: "docker",
  refusedReason: null,
  current: view,
  latest: view,
  sizeClass: null,
};

describe("getEnvironment", () => {
  it("reads a repo's environment from its connected-repo route", async () => {
    const seen: Seen = {};
    expect(await getEnvironment(respond(200, subject, seen), { kind: "repo", id: "cr-1" }))
      .toEqual(subject);
    expect(seen.url).toBe("/api/v1/connected-repos/cr-1/environment");
  });

  it("reads a workspace's from its own, with the environment repo it is built from", async () => {
    const seen: Seen = {};
    const body = {
      ...subject,
      current: { ...view, subjectKind: "workspace", subjectId: "ws-1" },
      latest: null,
      environmentRepoId: "cr-2",
    };
    const env = await getEnvironment(respond(200, body, seen), { kind: "workspace", id: "ws-1" });
    expect(seen.url).toBe("/api/v1/workspaces/ws-1/environment");
    expect(env.environmentRepoId).toBe("cr-2");
  });

  it("reads a deployment with environments off, which has nothing built", async () => {
    const off = { ...subject, enabled: false, builder: null, current: null, latest: null };
    expect(await getEnvironment(respond(200, off), { kind: "repo", id: "cr-1" })).toEqual(off);
  });

  it("refuses a build status it does not know rather than rendering it", async () => {
    const odd = { ...subject, latest: { ...view, status: "exploded" } };
    await expect(getEnvironment(respond(200, odd), { kind: "repo", id: "cr-1" })).rejects
      .toThrow();
  });
});

describe("getEnvironmentOrError", () => {
  it("folds a failure into its message, so the page still opens", async () => {
    expect(
      await getEnvironmentOrError(respond(502, { error: "bad gateway" }), {
        kind: "repo",
        id: "cr-1",
      }),
    ).toEqual({ error: "bad gateway" });
  });
});

describe("getEnvironmentDefinition", () => {
  it("is its own route, because it is the one that makes the forge fetch the repo", async () => {
    const seen: Seen = {};
    const read = await getEnvironmentDefinition(
      respond(200, { definition: { ryph: true, dockerfile: true } }, seen),
      { kind: "repo", id: "cr-1" },
    );
    expect(seen.url).toBe("/api/v1/connected-repos/cr-1/environment/definition");
    // Nothing said about other members is no members, not a missing field.
    expect(read).toEqual({ definition: { ryph: true, dockerfile: true }, ignoredDockerfiles: [] });
  });

  it("carries a workspace's passed-over Dockerfiles from its own route", async () => {
    const seen: Seen = {};
    const read = await getEnvironmentDefinition(
      respond(200, {
        definition: { ryph: true, dockerfile: true },
        ignoredDockerfiles: ["radicle-explorer"],
      }, seen),
      { kind: "workspace", id: "ws-1" },
    );
    expect(seen.url).toBe("/api/v1/workspaces/ws-1/environment/definition");
    expect(read.ignoredDockerfiles).toEqual(["radicle-explorer"]);
  });

  it("answers null where there was nothing to ask", async () => {
    const read = await getEnvironmentDefinition(
      respond(200, { definition: null, ignoredDockerfiles: [] }),
      { kind: "repo", id: "cr-1" },
    );
    expect(read.definition).toBeNull();
  });

  it("folds a forge that could not be read into a message, so the card degrades alone", async () => {
    expect(
      await getEnvironmentDefinitionOrError(
        respond(503, { error: "the forge could not read acme/api — try again" }),
        { kind: "repo", id: "cr-1" },
      ),
    ).toEqual({ error: "the forge could not read acme/api — try again" });
  });
});

describe("rebuildEnvironment", () => {
  it("POSTs to the subject's rebuild route and answers with the queued build", async () => {
    const seen: Seen = {};
    const queued = { ...view, id: "env-2", status: "queued", image: null, logTail: null };
    const build = await rebuildEnvironment(respond(200, { environment: queued }, seen), {
      kind: "workspace",
      id: "ws 1",
    });
    expect(seen.url).toBe("/api/v1/workspaces/ws%201/environment/rebuild");
    expect(seen.init?.method).toBe("POST");
    expect(build.status).toBe("queued");
  });

  it("surfaces the refusal a non-admin gets", async () => {
    await expect(
      rebuildEnvironment(respond(403, { error: "admin only" }), { kind: "repo", id: "cr-1" }),
    ).rejects.toThrow("admin only");
  });
});

describe("the build log", () => {
  it("is linked through the app's proxy", () => {
    expect(environmentLogHref("env/1")).toBe("/api/v1/environments/env%2F1/log");
  });

  it("is read as plain text, not JSON", async () => {
    const seen: Seen = {};
    const log = "#1 [machine] FROM universal\n#2 RUN ryph-bake --phase image /ryph/work\n";
    expect(await getEnvironmentLog(respond(200, log, seen, "text/plain"), "env-1")).toBe(log);
    expect(seen.url).toBe("/api/v1/environments/env-1/log");
  });

  it("reads a refusal's JSON error like any other call", async () => {
    await expect(getEnvironmentLog(respond(404, { error: "no such environment" }), "env-9"))
      .rejects.toThrow("no such environment");
  });
});

describe("a run's environment", () => {
  const run = {
    id: "run-1",
    state: "starting",
    phase: null,
    branchNamespace: "ryph/t-1",
    image: null,
    result: null,
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    events: [],
  };

  it("is null on a run that says nothing of it", () => {
    const parsed = taskRunSchema.parse(run);
    expect(parsed.environment).toBeNull();
    expect(parsed.environmentWait).toBeNull();
  });

  it("carries what the run started on, and the build a waiting run waits for", () => {
    const parsed = taskRunSchema.parse({
      ...run,
      environment: {
        id: "env-1",
        image: view.image,
        ref: "main",
        commits: view.commits,
        builtAt: view.finishedAt,
      },
      environmentWait: { environmentId: "env-2", status: "building" },
    });
    expect(parsed.environment?.commits).toEqual(view.commits);
    expect(parsed.environmentWait).toEqual({ environmentId: "env-2", status: "building" });
  });
});

describe("setupEnvironment", () => {
  it("POSTs only the agent to the subject's setup route and answers with the task", async () => {
    const seen: Seen = {};
    const started = await setupEnvironment(
      respond(201, { taskId: "t-1", runId: "r-1", state: "starting" }, seen),
      { kind: "repo", id: "cr 1" },
      { agentId: "a-1" },
    );
    expect(seen.url).toBe("/api/v1/connected-repos/cr%201/environment/setup");
    expect(seen.init?.method).toBe("POST");
    expect(JSON.parse(String(seen.init?.body))).toEqual({ agentId: "a-1" });
    expect(started).toEqual({ taskId: "t-1", runId: "r-1", state: "starting" });
  });

  it("goes to a workspace's own route, and surfaces a refusal", async () => {
    const seen: Seen = {};
    await setupEnvironment(
      respond(201, { taskId: "t-2", runId: "r-2", state: "starting" }, seen),
      { kind: "workspace", id: "ws-1" },
      { agentId: "a-1", model: "claude-sonnet-5" },
    );
    expect(seen.url).toBe("/api/v1/workspaces/ws-1/environment/setup");
    await expect(
      setupEnvironment(
        respond(409, { error: "Echo's harness (echo) cannot use tools" }),
        { kind: "repo", id: "cr-1" },
        { agentId: "a-echo" },
      ),
    ).rejects.toThrow("cannot use tools");
  });
});

describe("build results on the run page", () => {
  it("parses environment metadata and retains unknown notices as generic text", () => {
    const message = {
      id: "rm-1",
      runId: "r-1",
      seq: 3,
      kind: "system",
      sender: { kind: "platform" },
      text: "The platform built the environment for your patch p-1: the build SUCCEEDED.",
      payload: {
        kind: "environment",
        patchId: "p-1",
        path: "api",
        headSha: "abc1234",
        environmentId: "env-1",
        status: "ready",
      },
      createdAt: "2026-09-18T10:00:00.000Z",
    };
    expect(runMessageSchema.parse(message).payload).toEqual(message.payload);
    const unknown = runMessageSchema.parse({ ...message, payload: { kind: "weather" } });
    expect(unknown.payload).toBeNull();
    expect(unknown.text).toBe(message.text);
    expect(runMessageSchema.parse({ ...message, payload: null }).text).toBe(message.text);
    // Legacy or incompatible metadata must not make an otherwise readable run fail to load.
    for (
      const payload of [
        { kind: "environment" },
        { ...message.payload, status: "legacy-status" },
        { kind: "patch", patchId: "old-patch" },
        { kind: "released", path: "api" },
        "legacy metadata",
        [],
        undefined,
      ]
    ) {
      const legacy = runMessageSchema.parse({ ...message, payload });
      expect(legacy.payload).toBeNull();
      expect(legacy.text).toBe(message.text);
      expect(legacy.sender).toEqual(message.sender);
    }
    // Only optional presentation metadata gets this fallback, not the message envelope.
    expect(() => runMessageSchema.parse({ ...message, text: null })).toThrow();
  });

  it("carries the task's purpose and each patch's build", () => {
    const detail = taskDetailSchema.parse({
      task: {
        id: "t-1",
        agentId: "a-1",
        spec: { title: "Set up the ryph environment for acme/api", instructions: "…" },
        repos: [],
        origin: "user",
        purpose: "environment-setup",
        createdAt: "2026-09-18T10:00:00.000Z",
      },
      agent: null,
      runs: [],
      environmentBuilds: [{
        patchId: "p-1",
        runId: "r-1",
        environmentId: "env-1",
        branch: "ryph/ada-r1",
        note: null,
        checkedAt: "2026-09-18T10:00:00.000Z",
        reportedAt: "2026-09-18T10:20:00.000Z",
        environment: view,
      }],
    });
    expect(detail.task.purpose).toBe("environment-setup");
    expect(detail.environmentBuilds[0].environment?.status).toBe("ready");
    // A task the platform did not author, with no patch that asked for a build.
    const plain = taskDetailSchema.parse({
      task: {
        id: "t-2",
        agentId: "a-1",
        spec: { title: "T", instructions: "I" },
        repos: [],
        origin: "user",
        purpose: null,
        createdAt: "2026-09-18T10:00:00.000Z",
      },
      agent: null,
      runs: [],
      environmentBuilds: [],
    });
    expect(plain.task.purpose).toBeNull();
    expect(plain.environmentBuilds).toEqual([]);
  });
});

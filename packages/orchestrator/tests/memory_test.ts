import { test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// Memory, as the orchestrator touches it: the platform server joins a remembering agent's frozen
// tool scope, the brief rides the spec as injected context, a brief that fails leaves the run
// memoryless rather than failed, and the conclusion tells memory how the run ended.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { type Authenticate, makeHandler, type ToolAccess } from "../src/http/app.ts";
import { composeToolScope, freezeBrief } from "../src/core/start_task.ts";
import { PLATFORM_CHAT_SERVER_ID } from "../src/core/harness_tools.ts";
import { PLATFORM_CHAT_SERVER_ID as GATEWAY_PLATFORM_CHAT_SERVER_ID } from "@ryph/mcp-gateway/platform";
import { concludeRun, memoryOutcomeOf, reportPatchFate } from "../src/core/conclude_run.ts";
import { MEMORY_OUTCOME_GRACE_MS, sweepMemoryOutcomes } from "../src/core/reaper.ts";
import { httpMemoryAccess } from "../src/adapters/memory_access/http.ts";
import type { MemoryAccess } from "../src/ports/memory_access.ts";
import type { ConnectedRepo, Patch, Run } from "../src/core/types.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";
import { memoryTaskStore } from "./memory_store.ts";
import {
  fakeClock,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
  TEST_GATEWAY,
} from "./doubles.ts";

const PLATFORM = "ms-platform-memory";

// The core spells the platform chat server's id itself (it may not import the gateway); the
// gateway's platform entry point is the source of truth, and the two must never drift.
test("the core's platform chat server id is the gateway's", () => {
  assertEquals(PLATFORM_CHAT_SERVER_ID, GATEWAY_PLATFORM_CHAT_SERVER_ID);
});

/** A patch as it stands the moment its fate is known: submitted, closed, nothing acknowledged. */
const settledPatch = (id: string): Patch => ({
  id,
  connectedRepoId: "cr-1",
  runId: "r-1",
  taskId: "t-1",
  setId: "ps-1",
  path: "app",
  line: "work",
  branchName: "ryph/ada/r-1",
  headSha: "abc123",
  bundleKey: "r-1/cr-1/abc123.bundle",
  baseSha: null,
  generation: 1,
  title: null,
  description: null,
  commits: [],
  carries: [],
  state: "submitted",
  attempts: 1,
  nextAttemptAt: null,
  leaseExpiresAt: null,
  lastError: null,
  approvedBy: null,
  approvedAt: null,
  forgeRef: "42",
  forgeUrl: "https://gh/acme/app/pull/42",
  forgeBranch: "ryph/ada/r-1",
  diffRef: null,
  landed: { kind: "closed", at: "2026-01-01T00:00:00.000Z" },
  supersededByPatchId: null,
  hookCheck: null,
  approvedHookPaths: [],
  memoryFateReportedAt: null,
  mergedCuedAt: null,
  heldReason: null,
  mergedCueClaimedAt: null,
  landingAskedAt: null,
  version: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const PI_AGENT = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  systemPrompt: "You are Ada.",
  harnessKind: "pi",
};

const TASK_REPO_URL = "https://github.com/Acme/App.git";
/** The repo the tasks here check out, under the spelling its owner connected it with. */
const TASK_REPO: ConnectedRepo = {
  id: "cr-app",
  provider: "github",
  installationId: "12345",
  repoRef: "Acme/App",
  url: TASK_REPO_URL,
  defaultBranch: "main",
  submissionPolicy: "require-approval",
  sizeClass: null,
  allowForkPushes: false,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const TASK = {
  spec: { title: "Fix the flaky test", instructions: "Find and fix the flaky test in CI." },
  connectedRepoId: TASK_REPO.id,
};

// ---- composeToolScope ---------------------------------------------------------

test("the platform memory server joins a remembering agent's scope by default", () => {
  const scope = composeToolScope(
    { toolPolicy: null, memoryPolicy: { budgetTokens: 2000 }, harnessKind: "pi" },
    PLATFORM,
    true,
  );
  assertEquals(scope, { servers: [{ serverId: PLATFORM, allowedTools: "*" }] });
});

test("a policy naming the platform server narrows its tools; nothing else changes", () => {
  const scope = composeToolScope(
    {
      toolPolicy: {
        servers: [
          { serverId: "ms-1", allowedTools: ["search_issues"] },
          { serverId: PLATFORM, allowedTools: ["search", "get"] },
        ],
      },
      memoryPolicy: { budgetTokens: 2000 },
      harnessKind: "pi",
    },
    PLATFORM,
    true,
  );
  assertEquals(scope, {
    servers: [
      { serverId: "ms-1", allowedTools: ["search_issues"] },
      { serverId: PLATFORM, allowedTools: ["search", "get"] },
    ],
  });
});

test("no memory policy, no platform server, or a harness without tools: the entry stays out", () => {
  assertEquals(
    composeToolScope({ toolPolicy: null, memoryPolicy: null, harnessKind: "pi" }, PLATFORM, true),
    null,
  );
  assertEquals(
    composeToolScope(
      { toolPolicy: null, memoryPolicy: { budgetTokens: 1 }, harnessKind: "pi" },
      null,
      true,
    ),
    null,
  );
  assertEquals(
    composeToolScope(
      { toolPolicy: null, memoryPolicy: { budgetTokens: 1 }, harnessKind: "echo" },
      PLATFORM,
      true,
    ),
    null,
  );
  // The brief never landed: memory wrote no scope row for this run, so its tools would fail
  // every call. Out, even though the agent remembers and the deployment serves the server.
  assertEquals(
    composeToolScope(
      { toolPolicy: null, memoryPolicy: { budgetTokens: 1 }, harnessKind: "pi" },
      PLATFORM,
      false,
    ),
    null,
  );
  // The agent's own servers survive memory being off.
  assertEquals(
    composeToolScope(
      {
        toolPolicy: { servers: [{ serverId: "ms-1", allowedTools: "*" }] },
        memoryPolicy: null,
        harnessKind: "pi",
      },
      PLATFORM,
      false,
    ),
    { servers: [{ serverId: "ms-1", allowedTools: "*" }] },
  );
});

// ---- through the handler --------------------------------------------------------

/** The brief as memory composes it: evidence names the REPO the claim is about. */
const COMPOSED = {
  text: "## What previous runs learned\n- [mem-1] x",
  memoryIds: ["mem-1"],
  evidence: [{ memoryId: "mem-1", sha: "abc1234", paths: ["a.ts"], repo: TASK_REPO_URL }],
};
/** The same brief as frozen onto the run: the repo became the checkout PATH the runner checks
 * that evidence in — the connected repo's default directory here. */
const BRIEF = {
  text: COMPOSED.text,
  memoryIds: COMPOSED.memoryIds,
  evidence: [{ memoryId: "mem-1", sha: "abc1234", paths: ["a.ts"], path: "app" }],
};

function fakeMemoryAccess(
  opts: { brief?: typeof COMPOSED | null; fail?: boolean } = {},
) {
  const composed: Array<Record<string, unknown>> = [];
  const outcomes: Array<{ runId: string; status: string }> = [];
  const changes: Array<{ runId: string; patchId: string; fate: string }> = [];
  const patches: Array<{ runId: string; patchId: string; forgeUrl: string | null }> = [];
  const stale: Array<{ runId: string; stale: unknown }> = [];
  const memoryAccess: MemoryAccess = {
    composeBrief(req) {
      composed.push({ ...req });
      if (opts.fail) return Promise.reject(new Error("memory is down"));
      return Promise.resolve(opts.brief === undefined ? COMPOSED : opts.brief);
    },
    reportOutcome(runId, status) {
      outcomes.push({ runId, status });
      return Promise.resolve();
    },
    reportPatch(runId, patch) {
      patches.push({ runId, patchId: patch.patchId, forgeUrl: patch.forgeUrl });
      return Promise.resolve();
    },
    reportChange(runId, patchId, fate) {
      changes.push({ runId, patchId, fate });
      return Promise.resolve();
    },
    reportStale(runId, found) {
      stale.push({ runId, stale: found });
      return Promise.resolve();
    },
  };
  return { memoryAccess, composed, outcomes, changes, patches, stale };
}

function fakeToolAccess() {
  const servers = [
    { id: "ms-1", slug: "linear", name: "Linear", archivedAt: null },
    { id: PLATFORM, slug: "memory", name: "Memory", archivedAt: null },
  ];
  const issued: Array<Record<string, unknown>> = [];
  const toolAccess: ToolAccess = {
    getServer: (id) => Promise.resolve(servers.find((s) => s.id === id) ?? null),
    issueRunCredentials(scope) {
      issued.push(structuredClone(scope));
      return Promise.resolve({
        token: "ryph-mcp-test",
        servers: scope.servers.map((s) => {
          const server = servers.find((known) => known.id === s.serverId)!;
          return { slug: server.slug, name: server.name, url: `http://gw/${server.slug}` };
        }),
      });
    },
    revokeRunCredentials: () => Promise.resolve(),
    archiveServer: () => Promise.reject(new Error("not in these tests")),
  };
  return { toolAccess, issued };
}

function buildApp(opts: {
  memoryAccess?: MemoryAccess | null;
  toolAccess?: ToolAccess | null;
  platformMemoryServerId?: string | null;
}) {
  const store = memoryTaskStore();
  // The memory store writes synchronously, so the seed is in before the first request.
  void store.createConnectedRepo(TASK_REPO);
  const { provisioner, launches } = fakeProvisioner();
  const authenticate: Authenticate = () => Promise.resolve({ kind: "break-glass" });
  const handler = makeHandler({
    store,
    provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate,
    modelAccess: null,
    toolAccess: opts.toolAccess ?? null,
    memoryAccess: opts.memoryAccess ?? null,
    now: fakeClock().now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: TEST_GATEWAY,
      runHistoryUrl: null,
      appUrl: null,
      services: DEFAULT_SERVICE_POLICY,
      egress: {
        policy: { mode: "proxy" as const, bundles: [], hosts: [], proxyUrl: null },
        key: null,
        tokenTtlMs: 0,
      },
      platformMemoryServerId: opts.platformMemoryServerId ?? null,
      platformChatServerId: null,
      platformTools: {
        webServerId: "ms-platform-web",
        web: false,
        forge: null,
        pending: false,
      },
    },
  });
  return { handler, store, launches };
}

type Handler = (req: Request) => Promise<Response>;
const post = (handler: Handler, path: string, body: unknown, token?: string) =>
  handler(
    new Request(`http://orchestrator.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
const patch = (handler: Handler, path: string, body: unknown) =>
  handler(
    new Request(`http://orchestrator.test${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const get = (handler: Handler, path: string, token: string) =>
  handler(
    new Request(`http://orchestrator.test${path}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );

test("agent-only memory policy round-trips and is frozen into the memory brief request", async () => {
  const { memoryAccess, composed } = fakeMemoryAccess();
  const { handler } = buildApp({ memoryAccess });
  const policy = { budgetTokens: 0, agentOnly: true };
  const agent = await (await post(handler, "/v1/agents", {
    ...PI_AGENT,
    memoryPolicy: policy,
  })).json();
  assertEquals(agent.memoryPolicy, policy);
  await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK });
  assertEquals(composed[0].agentOnly, true);
  assertEquals(composed[0].budgetTokens, 0);
  const edited = await (await patch(handler, `/v1/agents/${agent.id}`, {
    memoryPolicy: { budgetTokens: 2000, agentOnly: false },
  })).json();
  assertEquals(edited.memoryPolicy.agentOnly, false);
  assertEquals(composed[0].agentOnly, true);
  assertEquals(
    (await patch(handler, `/v1/agents/${agent.id}`, {
      memoryPolicy: { budgetTokens: 2000, agentOnly: "yes" },
    })).status,
    400,
  );
});

test("an agent remembers by default; the brief rides the spec and the tools ride the credentials", async () => {
  const { memoryAccess, composed, outcomes } = fakeMemoryAccess();
  const { toolAccess, issued } = fakeToolAccess();
  const { handler, store, launches } = buildApp({
    memoryAccess,
    toolAccess,
    platformMemoryServerId: PLATFORM,
  });

  const agent = await (await post(handler, "/v1/agents", PI_AGENT)).json();
  assertEquals(agent.memoryPolicy, { budgetTokens: 2000 });

  const { taskId, runId } = await (await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK }))
    .json();
  // Composed once, keyed on the user-named repo, under the agent's budget.
  assertEquals(composed, [{
    runId,
    taskId,
    agentId: agent.id,
    repos: ["https://github.com/Acme/App.git"],
    task: TASK.spec,
    budgetTokens: 2000,
  }]);
  const run = (await store.getRun(runId))!;
  assertEquals(run.injectedContext, { systemPrompt: "You are Ada.", brief: BRIEF });
  assertEquals(run.toolScope, { servers: [{ serverId: PLATFORM, allowedTools: "*" }] });

  const runnerToken = (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN;
  const spec = await (await get(handler, `/v1/runs/${runId}/spec`, runnerToken)).json();
  assertEquals(spec.injectedContext.brief, BRIEF);
  const creds = await (await get(handler, `/v1/runs/${runId}/credentials`, runnerToken)).json();
  assertEquals(creds.mcp.servers.map((s: { slug: string }) => s.slug), ["memory"]);
  assertEquals(issued, [{ runId, servers: [{ serverId: PLATFORM, allowedTools: "*" }] }]);

  // The conclusion tells memory how it went — the run's terminal state, not the report's word.
  const result = { status: "success", branches: [], summary: "done" };
  assertEquals((await post(handler, `/v1/runs/${runId}/result`, result, runnerToken)).status, 200);
  // Nothing shipped, so memory is not left waiting on a patch: the run's change settles as
  // "none" at once rather than pending forever.
  assertEquals(outcomes, [{ runId, status: "success" }]);
});

test("a brief that cannot be composed leaves the run memoryless, never failed", async () => {
  const { memoryAccess, outcomes } = fakeMemoryAccess({ fail: true });
  const { handler, store } = buildApp({ memoryAccess });
  const agent = await (await post(handler, "/v1/agents", { ...PI_AGENT, harnessKind: "echo" }))
    .json();
  const created = await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK });
  assertEquals(created.status, 201);
  const { runId } = await created.json();
  const run = (await store.getRun(runId))!;
  assertEquals(run.state, "starting");
  assertEquals(run.injectedContext, { systemPrompt: "You are Ada." });
  // Nothing to scope at all here: this deployment serves no platform memory server (and an
  // echo harness could not drive its tools anyway). The run with both is the test below.
  assertEquals(run.toolScope, null, "no platform server configured");
  assertEquals(outcomes, []);
});

test("a failed brief keeps the memory tools out: no scope row was ever written for the run", async () => {
  const { memoryAccess, composed } = fakeMemoryAccess({ fail: true });
  const { toolAccess, issued } = fakeToolAccess();
  const { handler, store, launches } = buildApp({
    memoryAccess,
    toolAccess,
    platformMemoryServerId: PLATFORM,
  });
  const agent = await (await post(handler, "/v1/agents", PI_AGENT)).json();
  const created = await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK });
  assertEquals(created.status, 201, "the run starts regardless — the brief is best-effort");
  const { runId } = await created.json();
  assertEquals(composed.length, 1, "memory was asked");

  const run = (await store.getRun(runId))!;
  assertEquals(run.injectedContext, { systemPrompt: "You are Ada." });
  // The whole point: composeBrief is what opens the run on the memory side, so a throw leaves
  // the platform server with nothing to answer for. Scoping it in would hand the agent tools
  // that fail every call for the whole run.
  assertEquals(run.toolScope, null);
  const runnerToken = (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN;
  const creds = await (await get(handler, `/v1/runs/${runId}/credentials`, runnerToken)).json();
  assertEquals(creds.mcp, undefined, "no scope, so no MCP credentials are minted at all");
  assertEquals(issued, []);
});

test("nothing to say and no system prompt is a null context; memory off skips the call", async () => {
  const { memoryAccess, composed } = fakeMemoryAccess({ brief: null });
  const { handler, store } = buildApp({ memoryAccess });
  const bare = await (await post(handler, "/v1/agents", {
    name: "Bob",
    email: "b@example.com",
    harnessKind: "echo",
  })).json();
  const { runId } = await (await post(handler, "/v1/tasks", { agentId: bare.id, ...TASK })).json();
  assertEquals((await store.getRun(runId))!.injectedContext, null);
  assertEquals(composed.length, 1);

  const off = await (await post(handler, "/v1/agents", {
    ...PI_AGENT,
    harnessKind: "echo",
    forgePolicy: null,
    networkPolicy: null,
    limitPolicy: null,
    memoryPolicy: null,
  })).json();
  assertEquals(off.memoryPolicy, null);
  await post(handler, "/v1/tasks", { agentId: off.id, ...TASK });
  assertEquals(composed.length, 1, "memory off: never asked");

  // The policy is editable: a budget, then cleared.
  const edited =
    await (await patch(handler, `/v1/agents/${off.id}`, { memoryPolicy: { budgetTokens: 500 } }))
      .json();
  assertEquals(edited.memoryPolicy, { budgetTokens: 500 });
  const cleared = await (await patch(handler, `/v1/agents/${off.id}`, { memoryPolicy: null }))
    .json();
  assertEquals(cleared.memoryPolicy, null);
  assertEquals(
    (await post(handler, "/v1/agents", { ...PI_AGENT, memoryPolicy: { budgetTokens: -1 } })).status,
    400,
  );
});

// ---- conclusion -------------------------------------------------------------------

test("the runner's staleness report is relayed for briefed memories only, and recorded on the trail", async () => {
  const { memoryAccess, stale } = fakeMemoryAccess();
  const { toolAccess } = fakeToolAccess();
  const { handler, store, launches } = buildApp({
    memoryAccess,
    toolAccess,
    platformMemoryServerId: PLATFORM,
  });
  const agent = await (await post(handler, "/v1/agents", PI_AGENT)).json();
  const { runId } = await (await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK })).json();
  const runnerToken = (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN;

  assertEquals(
    (await post(handler, `/v1/runs/${runId}/memory/stale`, { stale: [] }, "wrong")).status,
    401,
  );
  const res = await post(handler, `/v1/runs/${runId}/memory/stale`, {
    stale: [
      { memoryId: "mem-1", changedPaths: ["a.ts"], headSha: "abc1234" },
      { memoryId: "mem-forged", changedPaths: ["b.ts"], headSha: "abc1234" },
    ],
  }, runnerToken);
  assertEquals(res.status, 204);
  // The commit the runner diffed to is relayed with the finding: memory re-anchors the claim
  // to it if this run confirms it.
  assertEquals(stale, [{
    runId,
    stale: [{ memoryId: "mem-1", changedPaths: ["a.ts"], headSha: "abc1234" }],
  }]);
  const events = await store.listEvents(runId);
  assertEquals(events.filter((e) => e.kind === "memory-stale").map((e) => e.detail), ["mem-1"]);

  // Nothing briefed among the ids: no relay, no event, still a 204.
  await post(handler, `/v1/runs/${runId}/memory/stale`, {
    stale: [{ memoryId: "mem-forged", changedPaths: [], headSha: null }],
  }, runnerToken);
  assertEquals(stale.length, 1);
  assertEquals(
    (await post(handler, `/v1/runs/${runId}/memory/stale`, { stale: "x" }, runnerToken)).status,
    400,
  );
});

test("every terminal state has an outcome, and a lost run reports it too", async () => {
  assertEquals(
    (["succeeded", "failed", "errored", "cancelled", "lost", "running", "starting"] as const).map(
      memoryOutcomeOf,
    ),
    ["success", "failure", "error", "cancelled", "lost", null, null],
  );
  const { memoryAccess, outcomes } = fakeMemoryAccess();
  const run = { id: "r-lost", state: "lost", modelScope: null, toolScope: null } as Run;
  const concludeStore = {
    revokeGitKeysForRun: () => Promise.resolve(),
    markRunMemoryOutcomeReported: () => Promise.resolve(),
    findResponseByRun: () => Promise.resolve(null),
    closeResponse: () => Promise.resolve(true),
    patchesForTask: () => Promise.resolve([]),
    listForgeToolActions: () => Promise.resolve([]),
  };
  await concludeRun(
    { store: concludeStore, diag: silentDiagnostics(), memoryAccess },
    run,
    "2026-01-01T00:00:00.000Z",
  );
  assertEquals(outcomes, [{ runId: "r-lost", status: "lost" }]);

  // A failing report is a warning, never a throw.
  await concludeRun(
    {
      store: concludeStore,
      diag: silentDiagnostics(),
      memoryAccess: {
        reportOutcome: () => Promise.reject(new Error("down")),
        reportChange: () => Promise.reject(new Error("down")),
      },
    },
    run,
    "2026-01-01T00:00:00.000Z",
  );
  // So is a failing change report — and it leaves the patch UNACKNOWLEDGED, which is what the
  // reaper's reconciliation later reads. A delivered one names the run and the PATCH (memory
  // tracks a change per patch), and records the acknowledgement.
  // The acknowledgement is a narrow write: the patch's id, and the state and verdict the report
  // was about, never the whole row.
  const saved: Array<{ id: string; memoryFateReportedAt: string }> = [];
  const store = {
    markPatchFateReported: (p: Pick<Patch, "id" | "state" | "landed">, at: string) => (
      saved.push({ id: p.id, memoryFateReportedAt: at }), Promise.resolve()
    ),
  };
  const failing = {
    store,
    diag: silentDiagnostics(),
    memoryAccess: {
      reportOutcome: () => Promise.resolve(),
      reportChange: () => Promise.reject(new Error("down")),
    },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  };
  await reportPatchFate(failing, settledPatch("p-1"), "landed");
  assertEquals(saved, [], "a lost report records nothing — the sweep must try again");

  const { memoryAccess: fine, changes } = fakeMemoryAccess();
  const now = () => new Date("2026-01-02T00:00:00.000Z");
  await reportPatchFate(
    { store, diag: silentDiagnostics(), memoryAccess: fine, now },
    settledPatch("p-1"),
    "dropped",
  );
  assertEquals(saved.map((p) => [p.id, p.memoryFateReportedAt]), [[
    "p-1",
    "2026-01-02T00:00:00.000Z",
  ]]);
  await reportPatchFate(
    { store, diag: silentDiagnostics(), memoryAccess: null, now },
    settledPatch("p-1"),
    "landed",
  );
  assertEquals(changes, [{ runId: "r-1", patchId: "p-1", fate: "dropped" }]);
  assertEquals(saved.length, 1, "no memory: nothing reported, nothing recorded");
});

test("freezeBrief maps each evidence entry's repo onto the checkout path the runner checks it in", () => {
  const composed = {
    text: "t",
    memoryIds: ["m-1", "m-2"],
    evidence: [
      {
        memoryId: "m-1",
        sha: "a".repeat(7),
        paths: ["x"],
        repo: "https://github.com/acme/api.git",
      },
      {
        memoryId: "m-2",
        sha: "b".repeat(7),
        paths: ["y"],
        repo: "https://github.com/acme/web.git",
      },
    ],
  };
  assertEquals(freezeBrief(composed, [{ url: "https://github.com/acme/api.git", path: "api" }]), {
    text: "t",
    memoryIds: ["m-1", "m-2"],
    evidence: [
      { memoryId: "m-1", sha: "a".repeat(7), paths: ["x"], path: "api" },
      // A claim about a repo this checkout does not hold: no clone to check it in.
      { memoryId: "m-2", sha: "b".repeat(7), paths: ["y"], path: null },
    ],
  });
});

test("a lost outcome report is redelivered after the grace, and acknowledged once it lands", async () => {
  const run = {
    id: "r-1",
    taskId: "t-1",
    state: "succeeded",
    updatedAt: "2026-01-01T00:00:00.000Z",
    memoryOutcomeReportedAt: null,
    skillsReportedAt: null,
  } as unknown as Run;
  const now = new Date(Date.parse(run.updatedAt) + MEMORY_OUTCOME_GRACE_MS + 1);
  const acked: string[] = [];
  const asked: string[] = [];
  const store = {
    listRunsAwaitingMemoryOutcome: (before: string) => {
      asked.push(before);
      return Promise.resolve(acked.includes(run.id) || run.updatedAt >= before ? [] : [run]);
    },
    markRunMemoryOutcomeReported: (runId: string) => (acked.push(runId), Promise.resolve()),
  };

  // Memory down: reported, not acknowledged — so the next tick asks again.
  await sweepMemoryOutcomes({
    store,
    diag: silentDiagnostics(),
    memoryAccess: {
      reportOutcome: () => Promise.reject(new Error("down")),
      reportChange: () => Promise.resolve(),
    },
    now: () => now,
  });
  assertEquals(acked, []);
  assertEquals(asked, [new Date(now.getTime() - MEMORY_OUTCOME_GRACE_MS).toISOString()]);

  // Memory back: the outcome lands, and the run is acked so it is never reported again.
  const { memoryAccess, outcomes } = fakeMemoryAccess();
  await sweepMemoryOutcomes({ store, diag: silentDiagnostics(), memoryAccess, now: () => now });
  assertEquals(outcomes, [{ runId: "r-1", status: "success" }]);
  assertEquals(acked, ["r-1"]);
  await sweepMemoryOutcomes({ store, diag: silentDiagnostics(), memoryAccess, now: () => now });
  assertEquals(outcomes.length, 1, "an acknowledged run is not reported again");

  // Inside the grace the run is its result handler's, which opens patches before reporting.
  acked.length = 0;
  const { memoryAccess: quiet, outcomes: none } = fakeMemoryAccess();
  await sweepMemoryOutcomes({
    store,
    diag: silentDiagnostics(),
    memoryAccess: quiet,
    now: () => new Date(Date.parse(run.updatedAt) + 1000),
  });
  assertEquals(none, []);
});

// ---- the HTTP adapter --------------------------------------------------------------

interface Call {
  url: string;
  auth: string | null;
  body?: string;
}

async function withFetch(
  reply: (call: Call) => Response,
  fn: (access: MemoryAccess, calls: Call[]) => Promise<void>,
): Promise<void> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return Promise.resolve(reply(call));
  }) as typeof fetch;
  try {
    await fn(
      httpMemoryAccess({
        memoryUrl: "http://memory.test/",
        memoryToken: "memory-token",
        diag: silentDiagnostics(),
      }),
      calls,
    );
  } finally {
    globalThis.fetch = original;
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const REQ = {
  runId: "run-1",
  taskId: "task-1",
  agentId: "a-1",
  repos: ["https://github.com/acme/app"],
  task: { title: "t", instructions: "i" },
  budgetTokens: 2000,
};

test("composeBrief posts the request with the service token and reads the brief back", async () => {
  await withFetch(
    () => json(200, { brief: { text: "hello", memoryIds: ["mem-1"], evidence: [] } }),
    async (access, calls) => {
      assertEquals(await access.composeBrief(REQ), {
        text: "hello",
        memoryIds: ["mem-1"],
        evidence: [],
      });
      assertEquals(calls[0].url, "http://memory.test/internal/v1/runs/run-1/brief");
      assertEquals(calls[0].auth, "Bearer memory-token");
      const { runId: _runId, ...body } = REQ;
      assertEquals(JSON.parse(calls[0].body!), body);
    },
  );
  await withFetch(() => json(200, { brief: null }), async (access) => {
    assertEquals(await access.composeBrief(REQ), null);
  });
});

test("evidence the runner would refuse is dropped entry by entry, never the whole brief", async () => {
  // The stakes: the runner validates the WHOLE spec with one schema, so one unusable entry
  // frozen onto a run is a run that cannot boot — and the same memory keeps being briefed, so
  // it is every run on that repo, forever. Each of these is a path or sha the runner's
  // MemoryBriefSchema rejects; each costs its own entry and nothing else.
  const evidence = [
    { memoryId: "mem-ok", sha: "abc1234", paths: ["src/a.ts", "src/b.ts"], repo: "r" },
    { memoryId: "mem-dash", sha: "abc1234", paths: ["-x"], repo: "r" },
    { memoryId: "mem-magic", sha: "abc1234", paths: [":/"], repo: "r" },
    { memoryId: "mem-magic2", sha: "abc1234", paths: ["ok.ts", ":(exclude)src"], repo: "r" },
    { memoryId: "mem-sha", sha: "not-a-sha", paths: ["a.ts"], repo: "r" },
    { memoryId: "mem-nopaths", sha: "abc1234", paths: [], repo: "r" },
    { memoryId: "mem-toolong", sha: "abc1234", paths: ["x".repeat(1025)], repo: "r" },
    { memoryId: "mem-empty", sha: "abc1234", paths: [""], repo: "r" },
    {
      memoryId: "mem-manypaths",
      sha: "abc1234",
      paths: Array.from({ length: 51 }, () => "a.ts"),
      repo: "r",
    },
  ];
  await withFetch(
    () => json(200, { brief: { text: "hello", memoryIds: ["mem-ok"], evidence } }),
    async (access) => {
      const brief = await access.composeBrief(REQ);
      assertEquals(brief, {
        text: "hello",
        memoryIds: ["mem-ok"],
        evidence: [{
          memoryId: "mem-ok",
          sha: "abc1234",
          paths: ["src/a.ts", "src/b.ts"],
          repo: "r",
        }],
      });
    },
  );
  // A wrongly TYPED entry is still a malformed answer: that is a memory service speaking a
  // different protocol, not a memory with a bad path in it.
  await withFetch(
    () => json(200, { brief: { text: "hello", memoryIds: [], evidence: [{ memoryId: 1 }] } }),
    async (access) => {
      await assertRejects(() => access.composeBrief(REQ), Error, "malformed");
    },
  );
});

test("composeBrief runs on a shorter deadline than the reports it is not on the start path with", async () => {
  // A memory service that accepts the connection and then says nothing is the shape that hurts:
  // the person who asked for the task is waiting on the 201. The brief gives up quickly; the
  // reports, which nobody waits on, keep the long deadline.
  const original = globalThis.fetch;
  globalThis.fetch =
    ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init!.signal!;
        signal.addEventListener("abort", () => reject(signal.reason));
      })) as typeof fetch;
  try {
    const access = httpMemoryAccess({
      memoryUrl: "http://memory.test",
      memoryToken: "memory-token",
      diag: silentDiagnostics(),
      briefTimeoutMs: 40,
      // Far apart, so a loaded machine's late timers cannot blur which deadline was used.
      requestTimeoutMs: 2_000,
    });
    const took = async (fn: () => Promise<unknown>): Promise<number> => {
      const started = performance.now();
      await assertRejects(fn, Error, "unreachable");
      return performance.now() - started;
    };
    const brief = await took(() => access.composeBrief(REQ));
    const outcome = await took(() => access.reportOutcome("run-1", "success"));
    assert(brief < 1_000, `the brief waited ${Math.round(brief)}ms on its 40ms deadline`);
    assert(
      outcome >= 1_900,
      `the outcome gave up in ${Math.round(outcome)}ms, before its 2000ms deadline`,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a refusal, a malformed body, or an unreachable service all throw — the caller degrades", async () => {
  await withFetch(() => json(503, { error: "no schema" }), async (access) => {
    await assertRejects(() => access.composeBrief(REQ), Error, "no schema");
  });
  await withFetch(() => json(200, { brief: { text: 1 } }), async (access) => {
    await assertRejects(() => access.composeBrief(REQ), Error, "malformed");
  });
  await withFetch(() => {
    throw new TypeError("connection refused");
  }, async (access) => {
    await assertRejects(() => access.composeBrief(REQ), Error, "unreachable");
  });
});

test("reportStale posts the findings and accepts a 204", async () => {
  await withFetch(() => new Response(null, { status: 204 }), async (access, calls) => {
    await access.reportStale("run-1", [
      { memoryId: "mem-1", changedPaths: ["a.ts"], headSha: "abc1234" },
    ]);
    assertEquals(calls[0].url, "http://memory.test/internal/v1/runs/run-1/stale");
    assertEquals(JSON.parse(calls[0].body!), {
      stale: [{ memoryId: "mem-1", changedPaths: ["a.ts"], headSha: "abc1234" }],
    });
  });
  await withFetch(() => json(503, { error: "down" }), async (access) => {
    await assertRejects(() => access.reportStale("run-1", []), Error, "503");
  });
});

test("reportOutcome posts the status and accepts a 204", async () => {
  await withFetch(() => new Response(null, { status: 204 }), async (access, calls) => {
    await access.reportOutcome("run-1", "success");
    assertEquals(calls[0].url, "http://memory.test/internal/v1/runs/run-1/outcome");
    assertEquals(JSON.parse(calls[0].body!), { status: "success" });
  });
  await withFetch(() => json(401, { error: "unauthorized" }), async (access) => {
    await assertRejects(() => access.reportOutcome("run-1", "lost"), Error, "401");
  });
  assert(true);
});

test("reportPatch posts the patch's record and accepts a 204", async () => {
  const patch = {
    patchId: "p-1",
    repo: "https://github.com/acme/api.git",
    generation: 2,
    headSha: "abc123",
    forgeUrl: null,
    carries: ["p-0"],
  };
  await withFetch(() => new Response(null, { status: 204 }), async (access, calls) => {
    await access.reportPatch("run-1", patch);
    assertEquals(calls[0].url, "http://memory.test/internal/v1/runs/run-1/patches");
    assertEquals(JSON.parse(calls[0].body!), patch);
  });
  await withFetch(() => json(503, { error: "down" }), async (access) => {
    await assertRejects(() => access.reportPatch("run-1", patch), Error, "503");
  });
});

test("reportChange posts the patch, its fate and what it carries, and accepts a 204", async () => {
  await withFetch(() => new Response(null, { status: 204 }), async (access, calls) => {
    await access.reportChange("run-1", "p-1", "landed", ["p-0"]);
    assertEquals(calls[0].url, "http://memory.test/internal/v1/runs/run-1/change");
    assertEquals(JSON.parse(calls[0].body!), { patchId: "p-1", fate: "landed", carries: ["p-0"] });
  });
  await withFetch(() => json(503, { error: "down" }), async (access) => {
    await assertRejects(() => access.reportChange("run-1", "p-1", "dropped", []), Error, "503");
  });
});

// ---- the platform web server ---------------------------------------------------

const WEB = "ms-platform-web";

test("the platform web server joins every tool-capable agent's scope, memory policy or not", () => {
  assertEquals(
    composeToolScope(
      { toolPolicy: null, memoryPolicy: null, harnessKind: "pi" },
      null,
      false,
      null,
      null,
      { serverId: WEB, served: true },
    ),
    { servers: [{ serverId: WEB, allowedTools: "*" }] },
  );
  // Beside memory's, in the order the scope was built.
  assertEquals(
    composeToolScope(
      { toolPolicy: null, memoryPolicy: { budgetTokens: 2000 }, harnessKind: "pi" },
      PLATFORM,
      true,
      null,
      null,
      { serverId: WEB, served: true },
    ),
    {
      servers: [
        { serverId: PLATFORM, allowedTools: "*" },
        { serverId: WEB, allowedTools: "*" },
      ],
    },
  );
});

test("an EMPTY allowlist on the web row is the per-agent opt-out", () => {
  // The agent form has no field for this (it refuses to save an empty list), but the API takes
  // it, and it is what an agent that must not reach the web carries: the row is in the frozen
  // scope, and the gateway's allowlist then denies every tool on it and hides all of them from
  // `tools/list`. The important half is here: the default entry is NOT added on top.
  const scope = composeToolScope(
    {
      toolPolicy: { servers: [{ serverId: WEB, allowedTools: [] }] },
      memoryPolicy: null,
      harnessKind: "pi",
    },
    null,
    false,
    null,
    null,
    { serverId: WEB, served: true },
  );
  assertEquals(scope, { servers: [{ serverId: WEB, allowedTools: [] }] });
});

test("a tool policy naming the web row narrows it, and nothing is added twice", () => {
  const scope = composeToolScope(
    {
      toolPolicy: { servers: [{ serverId: WEB, allowedTools: ["fetch"] }] },
      memoryPolicy: null,
      harnessKind: "pi",
    },
    null,
    false,
    null,
    null,
    { serverId: WEB, served: true },
  );
  assertEquals(scope, { servers: [{ serverId: WEB, allowedTools: ["fetch"] }] });
});

test("no web service, or a harness without tools: no web entry", () => {
  assertEquals(
    composeToolScope({ toolPolicy: null, memoryPolicy: null, harnessKind: "pi" }, null, false),
    null,
  );
  assertEquals(
    composeToolScope(
      { toolPolicy: null, memoryPolicy: null, harnessKind: "echo" },
      null,
      false,
      null,
      null,
      { serverId: WEB, served: true },
    ),
    null,
  );
});

test("web tools OFF drop the row from a policy that names it, not only the default entry", () => {
  // The switch has to take the capability away, not merely stop granting it: a platform row
  // cannot be archived, so a row seeded while the tools were on is still there for an agent's
  // tool policy to name, and the gateway would still serve it.
  const policied = composeToolScope(
    {
      toolPolicy: {
        servers: [
          { serverId: "ms-1", allowedTools: ["search_issues"] },
          { serverId: WEB, allowedTools: "*" },
        ],
      },
      memoryPolicy: null,
      harnessKind: "pi",
    },
    null,
    false,
    null,
    null,
    { serverId: WEB, served: false },
  );
  assertEquals(policied, { servers: [{ serverId: "ms-1", allowedTools: ["search_issues"] }] });

  // And an agent whose ONLY grant was the web row is left with no tool scope at all, rather than
  // with an empty one.
  assertEquals(
    composeToolScope(
      {
        toolPolicy: { servers: [{ serverId: WEB, allowedTools: ["fetch"] }] },
        memoryPolicy: null,
        harnessKind: "pi",
      },
      null,
      false,
      null,
      null,
      { serverId: WEB, served: false },
    ),
    null,
  );
});

test("while the gateway has not answered yet, no run carries the web row", () => {
  // `served` is false during the window between the listener opening and the lookup returning —
  // the same shape as off, deliberately: a run that starts in that window must not be handed a
  // row nothing has confirmed exists.
  assertEquals(
    composeToolScope(
      { toolPolicy: null, memoryPolicy: null, harnessKind: "pi" },
      null,
      false,
      null,
      null,
      { serverId: WEB, served: false },
    ),
    null,
  );
});

test("a patch's fate repeats what the patch carries", async () => {
  const told: unknown[][] = [];
  const store = { markPatchFateReported: () => Promise.resolve() };
  const memoryAccess = {
    reportChange: (...args: unknown[]) => (told.push(args), Promise.resolve()),
  };
  const now = () => new Date("2026-01-02T00:00:00.000Z");
  const patch = { ...settledPatch("p-1"), carries: ["p-0"] };
  await reportPatchFate({ store, diag: silentDiagnostics(), memoryAccess, now }, patch, "landed");
  assertEquals(told, [["r-1", "p-1", "landed", ["p-0"]]]);
});

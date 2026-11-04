import { test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// The whole loop through the pure HTTP handler — no sockets anywhere:
// create an agent, assign a task, fetch the spec as the runner, heartbeat, cancel, report.

import { capsClaimOf, type Role } from "@ryph/auth";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type Authenticate,
  makeHandler,
  type ModelAccess,
  type ToolAccess,
} from "../src/http/app.ts";
import {
  CHATGPT_PLAN,
  type Dialect,
  THINKING_LEVELS as PROXY_THINKING_LEVELS,
} from "@ryph/model-proxy";
import { THINKING_LEVELS } from "../src/core/types.ts";
import { sameModelPolicy } from "../src/http/user/agent_policies.ts";
import { memoryTaskStore } from "./memory_store.ts";
import {
  fakeClock,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  LOCAL_REPO,
  silentDiagnostics,
  TEST_GATEWAY,
} from "./doubles.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import type { ImagePrefetch } from "../src/ports/image_prefetch.ts";
import { type DeploymentLimits, spendIncluded } from "../src/core/run_limits.ts";

/** The tests' default caller: the total-bypass principal, like RYPH_AUTH=off yields. */
const BREAK_GLASS = { kind: "break-glass" } as const;

const AGENT_BODY = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  systemPrompt: "You are Ada: rigorous, terse, kind.",
  harnessKind: "echo",
};

/** The repo every task here checks out, seeded into each app's store: a task names nothing else. */
const CONNECTED = LOCAL_REPO;

/** Runs clone through it; with none configured no task starts. */
const GATEWAY = TEST_GATEWAY;

const TASK_SPEC = {
  spec: { title: "Fix the flaky test", instructions: "Find and fix the flaky test in CI." },
  connectedRepoId: CONNECTED.id,
};

/**
 * A stand-in for main.ts's real ModelAccess (@ryph/model-proxy over the shared store): one
 * known key, canned credentials, every issue/revoke recorded for assertion. The key carries a
 * DIALECT as the real lookup does — the proxy joins the key's provider to a built-in or to a
 * registered endpoint's row, and it is the dialect, not the id, that a harness is checked
 * against.
 */
function fakeModelAccess(
  key: {
    id: string;
    provider: string;
    dialect: Dialect;
    providerArchivedAt?: string | null;
    archivedAt: string | null;
  } = {
    id: "pk-1",
    provider: "anthropic",
    dialect: "anthropic-messages",
    archivedAt: null,
  },
) {
  const issued: Array<Record<string, unknown>> = [];
  const revoked: string[] = [];
  /** What the proxy would answer the sweep and the door: set by a test, read by the fake. */
  const spend = { byRun: new Map<string, number>(), ceilingReached: false };
  const modelAccess: ModelAccess = {
    getKey: (id) => Promise.resolve(id === key.id ? { providerArchivedAt: null, ...key } : null),
    issueRunCredentials(scope) {
      issued.push({ ...scope });
      return Promise.resolve({
        ANTHROPIC_API_KEY: "ryph-vk-test",
        ANTHROPIC_BASE_URL: "http://model-proxy.test",
      });
    },
    revokeRunCredentials(runId) {
      revoked.push(runId);
      return Promise.resolve();
    },
    spendOf: (runId) => Promise.resolve(spend.byRun.get(runId) ?? 0),
    ceilingReached: () => Promise.resolve(spend.ceilingReached),
  };
  return { modelAccess, issued, revoked, spend };
}

/**
 * The tool-side twin: a stand-in for the @ryph/mcp-gateway issuer behind the ToolAccess port.
 * Two known servers (one archived), canned credentials, every issue/revoke recorded.
 */
function fakeToolAccess() {
  const servers = [
    { id: "ms-1", slug: "linear", name: "Linear", archivedAt: null },
    { id: "ms-old", slug: "old", name: "Old", archivedAt: "2026-06-01T00:00:00.000Z" },
  ];
  const issued: Array<Record<string, unknown>> = [];
  const revoked: string[] = [];
  const toolAccess: ToolAccess = {
    getServer: (id) => Promise.resolve(servers.find((s) => s.id === id) ?? null),
    issueRunCredentials(scope) {
      issued.push(structuredClone(scope));
      return Promise.resolve({
        token: "ryph-mcp-test",
        servers: scope.servers.map((s) => {
          const server = servers.find((known) => known.id === s.serverId)!;
          return {
            slug: server.slug,
            name: server.name,
            url: `http://mcp-gateway.test/v1/mcp/${scope.runId}/${server.slug}`,
          };
        }),
      });
    },
    revokeRunCredentials(runId) {
      revoked.push(runId);
      return Promise.resolve();
    },
    archiveServer: () => Promise.reject(new Error("not in these tests")),
  };
  return { toolAccess, issued, revoked };
}

function buildApp(
  opts: {
    authenticate?: Authenticate;
    harnessKinds?: string[];
    limits?: DeploymentLimits;
    modelAccess?: ModelAccess | null;
    toolAccess?: ToolAccess | null;
    gitGateway?: { url: string; keyTtlMs: number } | null;
    forgeToken?: string | null;
    store?: ReturnType<typeof memoryTaskStore>;
    egress?: { mode: "proxy" | "open"; bundles: string[]; hosts: string[] };
    imagePrefetch?: ImagePrefetch;
    /** The live holder, for the tests about resolution happening behind the listener. */
    platformTools?: {
      webServerId: string;
      web: boolean;
      forge: string | null;
      pending: boolean;
    };
  } = {},
) {
  const store = opts.store ?? memoryTaskStore();
  // The memory store writes synchronously, so the seed is in before the first request.
  void store.createConnectedRepo(CONNECTED);
  const clock = fakeClock();
  const { provisioner, launches } = fakeProvisioner();
  const { control, cancels } = fakeRunnerControl();
  const handler = makeHandler({
    store,
    provisioner,
    runnerControl: control,
    diag: silentDiagnostics(),
    authenticate: opts.authenticate ?? (() => Promise.resolve(BREAK_GLASS)),
    modelAccess: opts.modelAccess ?? null,
    toolAccess: opts.toolAccess ?? null,
    // The recording fake, whose permission checks allow: a signed-in caller's task asks the
    // forge whether it may write the repo.
    forge: noopForge(silentDiagnostics()),
    forgeToken: opts.forgeToken ?? null,
    ...(opts.imagePrefetch === undefined ? {} : { imagePrefetch: opts.imagePrefetch }),
    now: clock.now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig({
        ...(opts.harnessKinds === undefined ? {} : { harnessKinds: opts.harnessKinds }),
        ...(opts.limits === undefined ? {} : { limits: opts.limits }),
      }),
      gitGateway: opts.gitGateway === undefined ? GATEWAY : opts.gitGateway,
      runHistoryUrl: null,
      appUrl: null,
      services: DEFAULT_SERVICE_POLICY,
      egress: {
        policy: {
          ...(opts.egress ?? { mode: "proxy" as const, bundles: [], hosts: [] }),
          proxyUrl: null,
        },
        key: null,
        tokenTtlMs: 0,
      },
      platformMemoryServerId: null,
      platformChatServerId: null,
      platformTools: opts.platformTools ??
        { webServerId: "ms-platform-web", web: false, forge: null, pending: false },
    },
  });
  return { handler, store, clock, launches, cancels };
}

type Handler = (req: Request) => Promise<Response>;

function post(handler: Handler, path: string, body: unknown, token?: string) {
  return handler(
    new Request(`http://orchestrator.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

function patch(handler: Handler, path: string, body: unknown) {
  return handler(
    new Request(`http://orchestrator.test${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function put(handler: Handler, path: string, body: unknown) {
  return handler(
    new Request(`http://orchestrator.test${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function get(handler: Handler, path: string, token?: string) {
  return handler(
    new Request(`http://orchestrator.test${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );
}

async function createAgent(handler: Handler, body: unknown = AGENT_BODY) {
  const res = await post(handler, "/v1/agents", body);
  assertEquals(res.status, 201);
  return await res.json();
}

test("a task flows agent → create → spec → heartbeats → cancel → cancelled result", async () => {
  const { handler, launches } = buildApp();
  const agent = await createAgent(handler);

  // Create: the row lands; the container contract goes out through the provisioner,
  // on the deployment's one agent image, whatever the harness kind, at the default size.
  const created = await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC });
  assertEquals(created.status, 201);
  const { taskId, runId, state } = await created.json();
  assertEquals(state, "starting");
  assertEquals(launches.length, 1);
  assertEquals(launches[0].image, "ryph-agent:test");
  assertEquals(launches[0].size.name, "standard");
  const env = await bootstrapEnv(handler, launches[0].env);
  assertEquals(env.RYPH_RUN_ID, runId);
  assertEquals(env.RYPH_ORCHESTRATOR_URL, "http://orchestrator.test");
  const runnerToken = env.RYPH_RUN_TOKEN;
  assert(runnerToken.length >= 64);
  // No payload rides the env: the work item and context are fetched back on boot.
  assertEquals(env.RYPH_TASK, undefined);
  assertEquals(env.RYPH_CONTEXT, undefined);

  // Fetch-on-boot: the spec endpoint serves the run's complete input, only to the right token.
  const specDenied = await get(handler, `/v1/runs/${runId}/spec`, "not-the-token");
  assertEquals(specDenied.status, 401);
  const spec = await get(handler, `/v1/runs/${runId}/spec`, runnerToken);
  assertEquals(spec.status, 200);
  const { workItem, injectedContext } = await spec.json();
  assertEquals(workItem.id, runId);
  assertEquals(workItem.agent, { name: "Ada Lovelace", email: "ada@example.com" });
  assertEquals(workItem.harness, { kind: "echo" });
  assertEquals(workItem.repos.length, 1);
  assert(workItem.repos[0].branchNamespace.startsWith("ryph/ada-lovelace/"));
  // The agent's system prompt rides the spec as injected context.
  assertEquals(injectedContext, { systemPrompt: AGENT_BODY.systemPrompt });

  // Heartbeats move the gauge; a stale seq is answered but changes nothing.
  const beat = await post(
    handler,
    `/v1/runs/${runId}/heartbeat`,
    { seq: 0, phase: "cloning" },
    runnerToken,
  );
  // The answer carries exactly one thing: whether this run has been asked to stop.
  assertEquals(beat.status, 200);
  assertEquals(await beat.json(), { cancel: false });
  const staleBeat = await post(handler, `/v1/runs/${runId}/heartbeat`, {
    seq: 0,
    phase: "preparing",
  }, runnerToken);
  assertEquals(staleBeat.status, 200);
  // A beat this replica considers stale is still a live runner asking; the flag rides it too.
  assertEquals(await staleBeat.json(), { cancel: false });

  const detail = await get(handler, `/v1/tasks/${taskId}`);
  assertEquals(detail.status, 200);
  const detailBody = await detail.json();
  assertEquals(detailBody.agent.id, agent.id);
  assertEquals(detailBody.runs.length, 1);
  assertEquals(detailBody.runs[0].state, "running");
  assertEquals(detailBody.runs[0].phase, "cloning");
  assertEquals(detailBody.runs[0].image, "ryph-agent:test");
  // The credentials never reach a user-facing response.
  assert(!("tokenHash" in detailBody.runs[0]) && !("controlToken" in detailBody.runs[0]));

  // The task list shows the agent by name.
  const list = await (await get(handler, "/v1/tasks")).json();
  assertEquals(list.tasks[0].agentName, "Ada Lovelace");

  // `?ids=` answers only the tasks named — what the usage page asks for — and skips the rest,
  // an unknown id included. An empty list asks for nothing and gets nothing.
  const picked = await (await get(handler, `/v1/tasks?ids=${taskId},t-missing`)).json();
  assertEquals(picked.tasks.map((t: { id: string }) => t.id), [taskId]);
  assertEquals(picked.tasks[0].agentName, "Ada Lovelace");
  assertEquals((await (await get(handler, "/v1/tasks?ids=")).json()).tasks, []);

  // Cancel: the intent is recorded, and the NEXT BEAT carries it back down. This run's
  // provisioner can place no address to dial, so the push channel has nowhere to go — which is
  // the whole case this exists for, and used to end in the reaper's kill after the full grace.
  const cancelled = await post(handler, `/v1/tasks/${taskId}/cancel`, {});
  assertEquals(cancelled.status, 202);
  const beat2 = await post(
    handler,
    `/v1/runs/${runId}/heartbeat`,
    { seq: 1, phase: "running" },
    runnerToken,
  );
  assertEquals(beat2.status, 200);
  assertEquals(await beat2.json(), { cancel: true });
  // And it keeps saying so: the flag reads durable desired state, not an edge, so a runner that
  // missed one beat learns on the next. Not firing twice is the RUNNER's job.
  const beat3 = await post(
    handler,
    `/v1/runs/${runId}/heartbeat`,
    { seq: 2, phase: "running" },
    runnerToken,
  );
  assertEquals(await beat3.json(), { cancel: true });

  // The runner reports a cancelled result; the report is idempotent under retry.
  const result = { status: "cancelled", branches: [], summary: "stopped at a coherent point" };
  const reported = await post(handler, `/v1/runs/${runId}/result`, result, runnerToken);
  assertEquals(reported.status, 200);
  assertEquals((await reported.json()).ack, "Accepted");
  const reReported = await post(handler, `/v1/runs/${runId}/result`, result, runnerToken);
  assertEquals((await reReported.json()).ack, "Accepted");

  const finalRuns = (await (await get(handler, `/v1/tasks/${taskId}`)).json()).runs;
  assertEquals(finalRuns[0].state, "cancelled");

  // A zombie heartbeat after the verdict is refused and told to stop.
  const zombie = await post(
    handler,
    `/v1/runs/${runId}/heartbeat`,
    { seq: 2, phase: "running" },
    runnerToken,
  );
  assertEquals(zombie.status, 409);
});

test("agents are created, edited, and archived; archived agents take no tasks", async () => {
  const { handler } = buildApp();
  const agent = await createAgent(handler);

  // Edit: patch a field, clear the prompt with null.
  const renamed = await patch(handler, `/v1/agents/${agent.id}`, {
    name: "Ada L.",
    systemPrompt: null,
  });
  assertEquals(renamed.status, 200);
  const renamedBody = await renamed.json();
  assertEquals(renamedBody.name, "Ada L.");
  assertEquals(renamedBody.systemPrompt, null);
  assertEquals(renamedBody.email, "ada@example.com"); // untouched

  const listed = await (await get(handler, "/v1/agents")).json();
  assertEquals(listed.agents.length, 1);

  // Archive is idempotent, and an archived agent refuses new tasks.
  const archived = await post(handler, `/v1/agents/${agent.id}/archive`, {});
  assertEquals(archived.status, 200);
  assert((await archived.json()).archivedAt !== null);
  const again = await post(handler, `/v1/agents/${agent.id}/archive`, {});
  assertEquals(again.status, 200);
  const refused = await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC });
  assertEquals(refused.status, 409);
});

test("editing an agent never changes what an in-flight run was asked to do", async () => {
  const { handler, launches } = buildApp();
  const agent = await createAgent(handler);
  const { runId } = await (await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC }))
    .json();
  const runnerToken = (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN;
  const original = await (await get(handler, `/v1/runs/${runId}/spec`, runnerToken)).json();

  await patch(handler, `/v1/agents/${agent.id}`, { name: "Someone Else" });

  const afterEdit = await (await get(handler, `/v1/runs/${runId}/spec`, runnerToken)).json();
  assertEquals(afterEdit, original); // the snapshot, not a recomposition
  assertEquals(afterEdit.workItem.agent.name, "Ada Lovelace");
});

test("an agent with a harness kind the deployment does not offer is refused, naming the kinds", async () => {
  const { handler } = buildApp({ harnessKinds: ["pi"] });
  const res = await post(handler, "/v1/agents", { ...AGENT_BODY, harnessKind: "claude-code" });
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.knownKinds, ["pi"]);
  assertStringIncludes(body.error, "RYPH_HARNESS_KINDS");
});

test("an agent can be moved only to an offered kind; one it already has stays editable", async () => {
  const offering = buildApp({ harnessKinds: ["pi", "echo"] });
  const agent = await createAgent(offering.handler);
  // The deployment stops offering `echo`, which this agent is on: a rename still goes through,
  // a move to another unoffered kind does not.
  const narrowed = buildApp({ harnessKinds: ["pi"], store: offering.store });
  const renamed = await patch(narrowed.handler, `/v1/agents/${agent.id}`, { name: "Renamed" });
  assertEquals(renamed.status, 200);
  const moved = await patch(narrowed.handler, `/v1/agents/${agent.id}`, {
    harnessKind: "claude-code",
  });
  assertEquals(moved.status, 400);
  assertEquals((await moved.json()).knownKinds, ["pi"]);
});

test("a launch failure still yields the task, recorded as errored", async () => {
  const store = memoryTaskStore();
  await store.createConnectedRepo(CONNECTED);
  const handler = makeHandler({
    store,
    provisioner: {
      launch: () => Promise.reject(new Error("docker daemon unreachable")),
      kill: () => Promise.resolve(),
      inspect: () => Promise.resolve("unknown" as const),
    },
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate: () => Promise.resolve(BREAK_GLASS),
    now: fakeClock().now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: GATEWAY,
      runHistoryUrl: null,
      appUrl: null,
      services: DEFAULT_SERVICE_POLICY,
      egress: {
        policy: { mode: "proxy" as const, bundles: [], hosts: [], proxyUrl: null },
        key: null,
        tokenTtlMs: 0,
      },
      platformMemoryServerId: null,
      platformChatServerId: null,
      platformTools: {
        webServerId: "ms-platform-web",
        web: false,
        forge: null,
        pending: false,
      },
    },
  });
  const agent = await createAgent(handler);
  const created = await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC });
  assertEquals(created.status, 201);
  const { runId, state } = await created.json();
  assertEquals(state, "errored");
  const events = await store.listEvents(runId);
  assertEquals(events.map((e) => e.kind), ["created", "launch-failed"]);
});

test("the user surface is gated by the authenticator; the runner surface stays per-run", async () => {
  // A stand-in for main.ts's real authenticator (@ryph/auth verifier + break-glass token):
  // the http layer only sees the gate, so a static-token gate exercises the same seam.
  const authenticate: Authenticate = (req) => {
    const ok = req.headers.get("authorization") === "Bearer user-secret";
    return Promise.resolve(
      ok
        ? {
          kind: "user",
          userId: "u-1",
          email: "u@example.com",
          name: "U",
          caps: capsClaimOf("member"),
          emailVerified: true,
          sid: "s-1",
          via: "session",
        } as const
        : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );
  };
  const { handler, launches } = buildApp({ authenticate });
  assertEquals((await post(handler, "/v1/agents", AGENT_BODY)).status, 401);
  assertEquals((await get(handler, "/v1/tasks")).status, 401);

  const agentRes = await post(handler, "/v1/agents", AGENT_BODY, "user-secret");
  assertEquals(agentRes.status, 201);
  const agent = await agentRes.json();
  const created = await post(
    handler,
    "/v1/tasks",
    { agentId: agent.id, ...TASK_SPEC },
    "user-secret",
  );
  assertEquals(created.status, 201);
  const { runId } = await created.json();

  // The user token opens the user surface, never the runner surface.
  const wrongSurface = await get(handler, `/v1/runs/${runId}/spec`, "user-secret");
  assertEquals(wrongSurface.status, 401);
  const rightToken = await get(
    handler,
    `/v1/runs/${runId}/spec`,
    (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN,
  );
  assertEquals(rightToken.status, 200);
});

const PI_AGENT = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  harnessKind: "pi",
  modelPolicy: {
    providerKeyId: "pk-1",
    provider: "anthropic",
    allowedModels: ["claude-sonnet-5", "claude-haiku-4-5"],
    defaultModel: "claude-sonnet-5",
    defaultThinking: null,
  },
};

test("an agent's model policy is validated against the harness and the key rows", async () => {
  const { modelAccess } = fakeModelAccess();
  const { handler } = buildApp({ modelAccess });

  // Happy path: known key, provider the harness can drive.
  const created = await post(handler, "/v1/agents", PI_AGENT);
  assertEquals(created.status, 201);
  assertEquals((await created.json()).modelPolicy.defaultModel, "claude-sonnet-5");

  // An unknown key is refused at creation, not at first launch.
  const unknownKey = await post(handler, "/v1/agents", {
    ...PI_AGENT,
    modelPolicy: { ...PI_AGENT.modelPolicy, providerKeyId: "pk-nope" },
  });
  assertEquals(unknownKey.status, 400);
  assert((await unknownKey.json()).error.includes("pk-nope"));

  // A key for another provider than the policy claims is refused.
  const mismatch = await post(handler, "/v1/agents", {
    ...PI_AGENT,
    modelPolicy: { ...PI_AGENT.modelPolicy, provider: "openai" },
  });
  assertEquals(mismatch.status, 400);

  // echo drives no dialects at all.
  const wrongHarness = await post(handler, "/v1/agents", {
    ...PI_AGENT,
    harnessKind: "echo",
  });
  assertEquals(wrongHarness.status, 400);
  const refusal = await wrongHarness.json();
  assert(refusal.error.includes("echo"));
  // The refusal names the DIALECT the key speaks and what the harness can drive — a provider
  // id would say nothing, since it may be a slug this deployment's admin invented.
  assert(refusal.error.includes("anthropic-messages"), refusal.error);
  assertEquals(refusal.supportedDialects, []);

  // defaultModel must sit inside the allowlist — refused by the schema itself.
  const badDefault = await post(handler, "/v1/agents", {
    ...PI_AGENT,
    modelPolicy: { ...PI_AGENT.modelPolicy, defaultModel: "gpt-oops" },
  });
  assertEquals(badDefault.status, 400);
});

test("a model policy is checked against the KEY's dialect, not its provider id", async () => {
  // The two halves of the hard cut, on one deployment: a registered OpenAI-compatible endpoint
  // is an ordinary provider with a slug for a name, and a harness that cannot speak a key's
  // wire shape is refused however familiar the id looks.

  // A custom slug pi has never heard of, whose key speaks a dialect pi does drive: accepted,
  // and nothing about the policy's shape changes to carry it.
  const custom = fakeModelAccess({
    id: "pk-cf",
    provider: "cloudflare-workers-ai",
    dialect: "openai-completions",
    archivedAt: null,
  });
  const customApp = buildApp({ modelAccess: custom.modelAccess });
  const accepted = await post(customApp.handler, "/v1/agents", {
    ...PI_AGENT,
    modelPolicy: {
      ...PI_AGENT.modelPolicy,
      providerKeyId: "pk-cf",
      provider: "cloudflare-workers-ai",
    },
  });
  assertEquals(accepted.status, 201);
  assertEquals((await accepted.json()).modelPolicy.provider, "cloudflare-workers-ai");

  // The same key under a harness that speaks nothing: refused, and the refusal is about the
  // shape rather than about a slug the harness table could never have enumerated.
  const refused = await post(customApp.handler, "/v1/agents", {
    ...PI_AGENT,
    harnessKind: "echo",
    modelPolicy: {
      ...PI_AGENT.modelPolicy,
      providerKeyId: "pk-cf",
      provider: "cloudflare-workers-ai",
    },
  });
  assertEquals(refused.status, 400);
  const body = await refused.json();
  assert(body.error.includes("openai-completions"), body.error);
  assertEquals(body.supportedDialects, []);
});

test("an agent may not be created against an ARCHIVED model endpoint", async () => {
  // Archiving a registered endpoint is a kill switch, and the credential issuer enforces it with
  // a definitive 400 at a run's boot. Without this check the form answered 201 and every run of
  // the agent then boot-failed — the key itself is live, so the key's own archivedAt says
  // nothing. The endpoint's state crosses the ModelAccess port beside it for exactly this.
  const { modelAccess } = fakeModelAccess({
    id: "pk-cf",
    provider: "cloudflare-workers-ai",
    dialect: "openai-completions",
    providerArchivedAt: "2026-07-01T00:00:00.000Z",
    archivedAt: null,
  });
  const { handler } = buildApp({ modelAccess });
  const refused = await post(handler, "/v1/agents", {
    ...PI_AGENT,
    modelPolicy: {
      ...PI_AGENT.modelPolicy,
      providerKeyId: "pk-cf",
      provider: "cloudflare-workers-ai",
    },
  });
  assertEquals(refused.status, 400);
  const body = await refused.json();
  assert(body.error.includes("cloudflare-workers-ai"), body.error);
  assert(body.error.includes("archived"), body.error);
});

test("without model access configured, an agent with a policy is refused", async () => {
  const { handler } = buildApp({ modelAccess: null });
  const refused = await post(handler, "/v1/agents", PI_AGENT);
  assertEquals(refused.status, 400);
  assert((await refused.json()).error.includes("model access is not configured"));
});

test("an edit that leaves the policy and harness alone survives model access going dark", async () => {
  // The agent carries a policy from a deployment that had a master key; this one does not.
  const { handler, store } = buildApp({
    ...imageConfig(),
    modelAccess: null,
  });
  const at = "2026-07-16T12:00:00.000Z";
  await store.saveAgent({
    id: "a-dark",
    ...PI_AGENT,
    handle: null,
    systemPrompt: null,
    toolPolicy: null,
    forgePolicy: null,
    skillPolicy: null,
    networkPolicy: null,
    limitPolicy: null,
    canOpenPatches: true,
    canPublishArtifacts: false,
    browserEnabled: false,
    memoryPolicy: null,
    archivedAt: null,
    createdAt: at,
    updatedAt: at,
  });

  // The edit form resends every field it holds, so the unchanged harness kind rides along with
  // the new name. Neither half of the pair MOVED, so it lands and the policy stays intact.
  const renamed = await patch(handler, "/v1/agents/a-dark", {
    name: "Ada L.",
    email: PI_AGENT.email,
    harnessKind: PI_AGENT.harnessKind,
  });
  assertEquals(renamed.status, 200);
  const body = await renamed.json();
  assertEquals(body.name, "Ada L.");
  assertEquals(body.modelPolicy.providerKeyId, "pk-1");

  // An allowlist is a set: neither a reorder nor a repeat moves it.
  const reordered = await patch(handler, "/v1/agents/a-dark", {
    harnessKind: PI_AGENT.harnessKind,
    modelPolicy: {
      ...PI_AGENT.modelPolicy,
      allowedModels: [...PI_AGENT.modelPolicy.allowedModels].reverse(),
    },
  });
  assertEquals(reordered.status, 200);

  const repeated = await patch(handler, "/v1/agents/a-dark", {
    harnessKind: PI_AGENT.harnessKind,
    modelPolicy: {
      ...PI_AGENT.modelPolicy,
      allowedModels: [...PI_AGENT.modelPolicy.allowedModels, PI_AGENT.modelPolicy.allowedModels[0]],
    },
  });
  assertEquals(repeated.status, 200);

  // Clearing the policy is the way out for an agent stranded by model access going dark: its
  // runs would otherwise be stamped with a scope no one can mint credentials for.
  const cleared = await patch(handler, "/v1/agents/a-dark", {
    harnessKind: PI_AGENT.harnessKind,
    modelPolicy: null,
  });
  assertEquals(cleared.status, 200);
  assertEquals((await cleared.json()).modelPolicy, null);

  // A harness swap can strand the standing policy, so that one is still refused.
  await store.saveAgent({
    ...(await store.getAgent("a-dark"))!,
    modelPolicy: PI_AGENT.modelPolicy,
  });
  const swapped = await patch(handler, "/v1/agents/a-dark", { harnessKind: "echo" });
  assertEquals(swapped.status, 400);
  assert((await swapped.json()).error.includes("model access is not configured"));
});

test("a task's model pick is bounded by the allowlist and frozen onto the run", async () => {
  const { modelAccess } = fakeModelAccess();
  const { handler, launches } = buildApp({
    ...imageConfig(),
    modelAccess,
  });
  const agent = await createAgent(handler, PI_AGENT);

  // A model outside the allowlist dies at creation.
  const refused = await post(handler, "/v1/tasks", {
    agentId: agent.id,
    ...TASK_SPEC,
    model: "claude-instant-1",
  });
  assertEquals(refused.status, 400);
  assertEquals((await refused.json()).allowedModels, PI_AGENT.modelPolicy.allowedModels);

  // A pick inside the allowlist rides the frozen work item; the scope freezes alongside.
  const created = await post(handler, "/v1/tasks", {
    agentId: agent.id,
    ...TASK_SPEC,
    model: "claude-haiku-4-5",
  });
  assertEquals(created.status, 201);
  const { runId } = await created.json();
  const spec = await get(
    handler,
    `/v1/runs/${runId}/spec`,
    (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN,
  );
  const { workItem } = await spec.json();
  assertEquals(workItem.harness, {
    kind: "pi",
    provider: "anthropic",
    model: "claude-haiku-4-5",
  });

  // No pick falls back to the policy default.
  const defaulted = await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC });
  const { runId: runId2 } = await defaulted.json();
  const spec2 = await get(
    handler,
    `/v1/runs/${runId2}/spec`,
    (await bootstrapEnv(handler, launches[1].env)).RYPH_RUN_TOKEN,
  );
  assertEquals((await spec2.json()).workItem.harness.model, "claude-sonnet-5");
});

test("a task's thinking level: its pick, else the policy's default, frozen onto the run", async () => {
  const { modelAccess } = fakeModelAccess();
  const { handler, launches, store } = buildApp({ ...imageConfig(), modelAccess });
  const agent = await createAgent(handler, {
    ...PI_AGENT,
    modelPolicy: { ...PI_AGENT.modelPolicy, defaultThinking: "medium" },
  });
  assertEquals(agent.modelPolicy.defaultThinking, "medium");
  const harnessOf = async (runId: string, launch: number) => {
    const token = (await bootstrapEnv(handler, launches[launch].env)).RYPH_RUN_TOKEN;
    return (await (await get(handler, `/v1/runs/${runId}/spec`, token)).json()).workItem.harness;
  };

  // A pick rides the frozen work item, and the scope records it beside the model. A level the
  // model does not take is not refused: pi clamps it (claude-sonnet-5 takes every level anyway).
  const picked = await post(handler, "/v1/tasks", {
    agentId: agent.id,
    ...TASK_SPEC,
    thinking: "max",
  });
  assertEquals(picked.status, 201);
  const { runId } = await picked.json();
  assertEquals(await harnessOf(runId, 0), {
    kind: "pi",
    provider: "anthropic",
    model: "claude-sonnet-5",
    thinking: "max",
  });
  assertEquals((await store.getRun(runId))?.modelScope?.thinking, "max");

  // No pick: the policy's default.
  const defaulted = await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC });
  const { runId: runId2 } = await defaulted.json();
  assertEquals((await harnessOf(runId2, 1)).thinking, "medium");
  assertEquals((await store.getRun(runId2))?.modelScope?.thinking, "medium");

  // A word that is not one of pi's levels is refused by the schema.
  const typo = await post(handler, "/v1/tasks", {
    agentId: agent.id,
    ...TASK_SPEC,
    thinking: "extreme",
  });
  assertEquals(typo.status, 400);

  // No default and no pick: nothing rides the wire, and pi keeps its own default.
  const plain = await createAgent(handler, PI_AGENT);
  const { runId: runId3 } = await (
    await post(handler, "/v1/tasks", { agentId: plain.id, ...TASK_SPEC })
  ).json();
  assert(!("thinking" in await harnessOf(runId3, 2)));
  assertEquals((await store.getRun(runId3))?.modelScope?.thinking, null);
});

test("the thinking levels are the proxy's own, spelled twice: pinned here", () => {
  assertEquals([...THINKING_LEVELS], [...PROXY_THINKING_LEVELS]);
});

test("an agent's default thinking level is one of pi's, and part of what the policy says", async () => {
  const { modelAccess } = fakeModelAccess();
  const { handler } = buildApp({ modelAccess });
  // Left out, it is null: the harness's own default.
  const { defaultThinking: _, ...policy } = PI_AGENT.modelPolicy;
  const created = await post(handler, "/v1/agents", { ...PI_AGENT, modelPolicy: policy });
  assertEquals(created.status, 201);
  const agent = await created.json();
  assertEquals(agent.modelPolicy.defaultThinking, null);

  const bad = await post(handler, "/v1/agents", {
    ...PI_AGENT,
    modelPolicy: { ...PI_AGENT.modelPolicy, defaultThinking: "none" },
  });
  assertEquals(bad.status, 400);

  // Changing it is changing the policy.
  assert(sameModelPolicy(agent.modelPolicy, { ...PI_AGENT.modelPolicy, defaultThinking: null }));
  assert(
    !sameModelPolicy(agent.modelPolicy, { ...PI_AGENT.modelPolicy, defaultThinking: "high" }),
  );
  const edited = await patch(handler, `/v1/agents/${agent.id}`, {
    harnessKind: PI_AGENT.harnessKind,
    modelPolicy: { ...PI_AGENT.modelPolicy, defaultThinking: "xhigh" },
  });
  assertEquals(edited.status, 200);
  assertEquals((await edited.json()).modelPolicy.defaultThinking, "xhigh");
});

test("a task cannot pick a thinking level for an agent without a policy", async () => {
  const { handler } = buildApp();
  const agent = await createAgent(handler); // echo agent, no policy
  const refused = await post(handler, "/v1/tasks", {
    agentId: agent.id,
    ...TASK_SPEC,
    thinking: "high",
  });
  assertEquals(refused.status, 400);
  assert((await refused.json()).error.includes("thinking level"));
});

test("a task cannot pick a model for an agent without a policy", async () => {
  const { handler } = buildApp();
  const agent = await createAgent(handler); // echo agent, no policy
  const refused = await post(handler, "/v1/tasks", {
    agentId: agent.id,
    ...TASK_SPEC,
    model: "claude-sonnet-5",
  });
  assertEquals(refused.status, 400);
});

test("boot credentials: minted from the frozen scope, empty without one, dead after the verdict", async () => {
  const { modelAccess, issued, revoked } = fakeModelAccess();
  const { handler, launches, store } = buildApp({
    ...imageConfig(),
    modelAccess,
  });
  const agent = await createAgent(handler, PI_AGENT);
  const { runId, taskId } = await (
    await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC })
  ).json();
  const runnerToken = (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN;

  // Only the single-use bootstrap bearer rides the launch environment.
  assertEquals(
    Object.keys(launches[0].env).sort(),
    ["RYPH_BOOTSTRAP_TOKEN", "RYPH_ORCHESTRATOR_URL", "RYPH_RUN_ID"],
  );

  // Wrong bearer: refused exactly like every other runner route.
  assertEquals((await get(handler, `/v1/runs/${runId}/credentials`, "nope")).status, 401);

  const res = await get(handler, `/v1/runs/${runId}/credentials`, runnerToken);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).env.ANTHROPIC_BASE_URL, "http://model-proxy.test");
  // Minted from the run's frozen scope, verbatim — the caps included, uncapped here.
  assertEquals(issued, [{
    runId,
    agentId: agent.id,
    taskId,
    providerKeyId: "pk-1",
    provider: "anthropic",
    allowedModels: ["claude-sonnet-5", "claude-haiku-4-5"],
    spendUsd: null,
    callsInFlight: null,
  }]);
  const events = await store.listEvents(runId);
  assert(events.some((e) => e.kind === "credentials-issued" && e.detail === "pk-1"));

  // The verdict revokes: the runner reports, the credentials die, the endpoint closes.
  const result = { status: "failure", reason: "nothing", summary: "", branches: [] };
  await post(handler, `/v1/runs/${runId}/result`, result, runnerToken);
  assertEquals(revoked, [runId]);
  assertEquals((await get(handler, `/v1/runs/${runId}/credentials`, runnerToken)).status, 409);
});

test("boot credentials: a run without a scope answers an empty env", async () => {
  const { handler, launches } = buildApp(); // echo agent, no policy, no model access at all
  const agent = await createAgent(handler);
  const { runId } = await (await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC }))
    .json();
  const res = await get(
    handler,
    `/v1/runs/${runId}/credentials`,
    (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { env: {} });
});

test("GET /v1/harnesses lists the offered kinds, one image, and each kind's capabilities", async () => {
  const { handler } = buildApp();
  const res = await get(handler, "/v1/harnesses");
  assertEquals(res.status, 200);
  const { harnesses } = await res.json();
  // Every kind launches on the one agent image: the kind picks the harness, never the image.
  assertEquals(
    harnesses.map((h: { kind: string; image: string }) => [h.kind, h.image]),
    [["pi", "ryph-agent:test"], ["echo", "ryph-agent:test"]],
  );
  const byKind = Object.fromEntries(
    harnesses.map((h: { kind: string; dialects: string[]; tools: boolean; skills: boolean }) => [
      h.kind,
      { dialects: h.dialects, tools: h.tools, skills: h.skills },
    ]),
  );
  // Wire dialects, not provider ids: the registered endpoints a form also has to offer live in
  // the model proxy's rows, and this static table could not name one of them.
  assertEquals(byKind.pi, {
    dialects: ["anthropic-messages", "openai-responses", "openai-completions"],
    tools: true,
    skills: true,
  });
  assertEquals(byKind.echo, { dialects: [], tools: false, skills: false });
  assert(!("providers" in harnesses[0]));
});

// ---- tool policies -----------------------------------------------------------

const TOOL_AGENT = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  harnessKind: "pi",
  toolPolicy: {
    servers: [{ serverId: "ms-1", allowedTools: ["search_issues", "create_issue"] }],
  },
};

test("an agent's tool policy is validated against the harness and the server rows", async () => {
  const { toolAccess } = fakeToolAccess();
  const { handler } = buildApp({ toolAccess });

  // Happy path: a known, live server, on a harness that can use tools.
  const created = await post(handler, "/v1/agents", TOOL_AGENT);
  assertEquals(created.status, 201);
  assertEquals((await created.json()).toolPolicy, TOOL_AGENT.toolPolicy);

  // An unknown server is refused at creation, not at first boot.
  const unknown = await post(handler, "/v1/agents", {
    ...TOOL_AGENT,
    toolPolicy: { servers: [{ serverId: "ms-nope", allowedTools: "*" }] },
  });
  assertEquals(unknown.status, 400);
  assert((await unknown.json()).error.includes("ms-nope"));

  // So is an archived one — the kill switch reaches the form too.
  const archived = await post(handler, "/v1/agents", {
    ...TOOL_AGENT,
    toolPolicy: { servers: [{ serverId: "ms-old", allowedTools: "*" }] },
  });
  assertEquals(archived.status, 400);
  assert((await archived.json()).error.includes("archived"));

  // echo cannot use tools at all.
  const wrongHarness = await post(handler, "/v1/agents", { ...TOOL_AGENT, harnessKind: "echo" });
  assertEquals(wrongHarness.status, 400);
  assert((await wrongHarness.json()).error.includes("echo"));

  // The schema's own rules: a server named twice, an empty list, a tool name off the grammar.
  for (
    const servers of [
      [{ serverId: "ms-1", allowedTools: "*" }, { serverId: "ms-1", allowedTools: ["x"] }],
      [],
      [{ serverId: "ms-1", allowedTools: ["has space"] }],
    ]
  ) {
    const bad = await post(handler, "/v1/agents", { ...TOOL_AGENT, toolPolicy: { servers } });
    assertEquals(bad.status, 400);
  }
});

test("a harness kind that is only a prototype key cannot use tools", async () => {
  const { toolAccess } = fakeToolAccess();
  // Offered by the deployment, so the capability table is the ONLY thing refusing one.
  // "constructor" passes the lowercase-slug grammar, and a plain lookup read the Object
  // constructor straight off the prototype — truthy, so the table that exists to refuse every
  // unknown kind admitted exactly that one.
  const { handler } = buildApp({
    harnessKinds: ["constructor", "tostring", "valueof"],
    toolAccess,
  });
  for (const harnessKind of ["constructor", "tostring", "valueof"]) {
    const refused = await post(handler, "/v1/agents", { ...TOOL_AGENT, harnessKind });
    assertEquals(refused.status, 400);
    assert((await refused.json()).error.includes("cannot use tools"));
  }
});

test("a tool policy's server lookups run together, under one budget", async () => {
  // A policy may name 32 servers. Sequentially, each with its own 10s deadline, one
  // authenticated request could pin a handler for five minutes and fire 32 requests at the
  // gateway; together they cost one round trip and are bounded once, for the whole validation.
  let inFlight = 0;
  let peak = 0;
  const toolAccess: ToolAccess = {
    async getServer(id) {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return id === "ms-bad" ? null : { id, slug: id, name: id, archivedAt: null };
    },
    issueRunCredentials: () => Promise.resolve({ token: "t", servers: [] }),
    revokeRunCredentials: () => Promise.resolve(),
    archiveServer: () => Promise.reject(new Error("not in this test")),
  };
  const { handler } = buildApp({ toolAccess });

  const servers = Array.from({ length: 8 }, (_, i) => ({
    serverId: `ms-${i}`,
    allowedTools: "*",
  }));
  const created = await post(handler, "/v1/agents", { ...TOOL_AGENT, toolPolicy: { servers } });
  assertEquals(created.status, 201);
  assertEquals(peak, 8);

  // Concurrent, but still answered in policy order: which bad server is named is deterministic.
  const refused = await post(handler, "/v1/agents", {
    ...TOOL_AGENT,
    toolPolicy: { servers: [...servers, { serverId: "ms-bad", allowedTools: "*" }] },
  });
  assertEquals(refused.status, 400);
  assert((await refused.json()).error.includes("ms-bad"));
});

test("without tool access configured, an agent with a tool policy is refused", async () => {
  const { handler } = buildApp({ toolAccess: null });
  const refused = await post(handler, "/v1/agents", TOOL_AGENT);
  assertEquals(refused.status, 400);
  assert((await refused.json()).error.includes("tool access is not configured"));
});

test("an edit that leaves the tool policy and harness alone survives tool access going dark", async () => {
  const { handler, store } = buildApp({
    ...imageConfig(),
    toolAccess: null,
  });
  const at = "2026-07-16T12:00:00.000Z";
  await store.saveAgent({
    id: "a-dark",
    ...TOOL_AGENT,
    handle: null,
    systemPrompt: null,
    modelPolicy: null,
    forgePolicy: null,
    skillPolicy: null,
    networkPolicy: null,
    limitPolicy: null,
    canOpenPatches: true,
    canPublishArtifacts: false,
    browserEnabled: false,
    memoryPolicy: null,
    archivedAt: null,
    createdAt: at,
    updatedAt: at,
  });

  // A rename with the same policy resent: nothing moved, so nothing is re-decided.
  const renamed = await patch(handler, "/v1/agents/a-dark", {
    name: "Ada L.",
    harnessKind: "pi",
    toolPolicy: TOOL_AGENT.toolPolicy,
  });
  assertEquals(renamed.status, 200);
  assertEquals((await renamed.json()).toolPolicy, TOOL_AGENT.toolPolicy);

  // An allowlist is a set, and so is the server list.
  const reordered = await patch(handler, "/v1/agents/a-dark", {
    toolPolicy: {
      servers: [{ serverId: "ms-1", allowedTools: ["create_issue", "search_issues"] }],
    },
  });
  assertEquals(reordered.status, 200);

  // Changing the tools IS a move, and there is no one to ask.
  const widened = await patch(handler, "/v1/agents/a-dark", {
    toolPolicy: { servers: [{ serverId: "ms-1", allowedTools: "*" }] },
  });
  assertEquals(widened.status, 400);

  // Clearing is always allowed: the way out for an agent stranded by tool access going dark.
  const cleared = await patch(handler, "/v1/agents/a-dark", { toolPolicy: null });
  assertEquals(cleared.status, 200);
  assertEquals((await cleared.json()).toolPolicy, null);

  // A harness swap can strand the standing policy, so it is refused.
  await store.saveAgent({
    ...(await store.getAgent("a-dark"))!,
    toolPolicy: TOOL_AGENT.toolPolicy,
  });
  const swapped = await patch(handler, "/v1/agents/a-dark", { harnessKind: "echo" });
  assertEquals(swapped.status, 400);
});

test("binding a credential to an agent is an admin's call; clearing one is anyone's", async () => {
  // Policies point an agent — which any signed-in user may then launch — at a secret the
  // operator holds: the provider key it spends, the MCP credential the gateway substitutes.
  const asRole = (role: Role): Authenticate => () =>
    Promise.resolve({
      kind: "user",
      userId: "u-1",
      email: "u@example.com",
      name: "U",
      caps: capsClaimOf(role),
      emailVerified: true,
      sid: "s-1",
      via: "session",
    });
  const { modelAccess } = fakeModelAccess();
  const { toolAccess } = fakeToolAccess();
  const store = memoryTaskStore();
  const deps = { modelAccess, toolAccess, store };
  const asUser = buildApp({ ...deps, authenticate: asRole("member") }).handler;
  const asAdmin = buildApp({ ...deps, authenticate: asRole("owner") }).handler;

  // A plain user creates agents freely — just not ones carrying a policy. The refusal names a
  // stable code, and lands BEFORE the lookups, so it cannot enumerate key or server ids.
  for (const body of [PI_AGENT, TOOL_AGENT]) {
    const refused = await post(asUser, "/v1/agents", body);
    assertEquals(refused.status, 403);
    assertEquals((await refused.json()).code, "forbidden");
  }
  const { toolPolicy: _policy, ...NO_POLICY } = TOOL_AGENT;
  assertEquals((await post(asUser, "/v1/agents", NO_POLICY)).status, 201);

  const both = await post(asAdmin, "/v1/agents", {
    ...PI_AGENT,
    toolPolicy: TOOL_AGENT.toolPolicy,
  });
  assertEquals(both.status, 201);
  const agent = await both.json();

  // The user may still edit that agent: a rename, with both standing policies resent verbatim
  // the way a form resends every field it holds. Nothing moved, so nothing needs an admin.
  const renamed = await patch(asUser, `/v1/agents/${agent.id}`, {
    name: "Ada L.",
    modelPolicy: PI_AGENT.modelPolicy,
    toolPolicy: TOOL_AGENT.toolPolicy,
  });
  assertEquals(renamed.status, 200);

  // Moving either one is a change, whichever direction it moves.
  for (
    const move of [
      { toolPolicy: { servers: [{ serverId: "ms-1", allowedTools: "*" }] } },
      { modelPolicy: { ...PI_AGENT.modelPolicy, allowedModels: "*" } },
    ]
  ) {
    const refused = await patch(asUser, `/v1/agents/${agent.id}`, move);
    assertEquals(refused.status, 403);
    assertEquals((await refused.json()).code, "forbidden");
  }

  // Clearing is always open — an agent stranded by a policy must never need an admin to become
  // usable again — and so is archiving it.
  const cleared = await patch(asUser, `/v1/agents/${agent.id}`, {
    modelPolicy: null,
    toolPolicy: null,
  });
  assertEquals(cleared.status, 200);
  assertEquals(await cleared.json(), {
    ...agent,
    name: "Ada L.",
    modelPolicy: null,
    toolPolicy: null,
    updatedAt: (await store.getAgent(agent.id))!.updatedAt,
  });

  // Break-glass passes, like it does at the repo gate: that token is already a total bypass.
  assertEquals((await post(buildApp(deps).handler, "/v1/agents", TOOL_AGENT)).status, 201);
});

test("a member renames an agent whose stored policy predates the thinking default", async () => {
  const asRole = (role: Role): Authenticate => () =>
    Promise.resolve({
      kind: "user",
      userId: "u-1",
      email: "u@example.com",
      name: "U",
      caps: capsClaimOf(role),
      emailVerified: true,
      sid: "s-1",
      via: "session",
    });
  const { modelAccess } = fakeModelAccess();
  const store = memoryTaskStore();
  const deps = { modelAccess, store };
  const asAdmin = buildApp({ ...deps, authenticate: asRole("owner") }).handler;
  const asUser = buildApp({ ...deps, authenticate: asRole("member") }).handler;
  const created = await post(asAdmin, "/v1/agents", PI_AGENT);
  assertEquals(created.status, 201);
  const agent = await created.json();
  // The row as an older build stored it: the policy JSON has no `defaultThinking` key.
  const { defaultThinking: _, ...older } = PI_AGENT.modelPolicy;
  await store.saveAgent({
    ...(await store.getAgent(agent.id))!,
    modelPolicy: older as typeof PI_AGENT.modelPolicy,
  });

  // A form resends the policy it loaded, now with the key spelled null: nothing moved.
  const renamed = await patch(asUser, `/v1/agents/${agent.id}`, {
    name: "Ada L.",
    modelPolicy: PI_AGENT.modelPolicy,
  });
  assertEquals(renamed.status, 200);
  assertEquals((await renamed.json()).name, "Ada L.");
});

test("boot credentials: the mcp half is minted from the frozen tool scope and dies with the run", async () => {
  const { toolAccess, issued, revoked } = fakeToolAccess();
  const { handler, launches, store } = buildApp({
    ...imageConfig(),
    toolAccess,
  });
  const agent = await createAgent(handler, TOOL_AGENT);
  const { runId } = await (await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC }))
    .json();
  const runnerToken = (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN;

  // The scope froze onto the run — a copy, not the agent's object.
  const run = (await store.getRun(runId))!;
  assertEquals(run.toolScope, TOOL_AGENT.toolPolicy);
  assertEquals(run.modelScope, null);
  // Nothing tool-shaped rides the env or the work item: the token travels via the fetch.
  assertEquals(
    Object.keys(launches[0].env).sort(),
    ["RYPH_BOOTSTRAP_TOKEN", "RYPH_ORCHESTRATOR_URL", "RYPH_RUN_ID"],
  );
  assertEquals(run.workItem.harness, { kind: "pi" });

  // Editing the agent's tools afterwards changes nothing for this run.
  await patch(handler, `/v1/agents/${agent.id}`, {
    toolPolicy: { servers: [{ serverId: "ms-1", allowedTools: "*" }] },
  });

  const res = await get(handler, `/v1/runs/${runId}/credentials`, runnerToken);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.env, {}); // no model scope: the env half is the normal empty map
  assertEquals(body.mcp, {
    token: "ryph-mcp-test",
    servers: [{
      slug: "linear",
      name: "Linear",
      url: `http://mcp-gateway.test/v1/mcp/${runId}/linear`,
    }],
  });
  assertEquals(issued, [{ runId, servers: TOOL_AGENT.toolPolicy.servers }]);
  const events = await store.listEvents(runId);
  assert(events.some((e) => e.kind === "credentials-issued" && e.detail === "mcp: linear"));

  // The verdict revokes; the endpoint closes.
  const result = { status: "failure", reason: "nothing", summary: "", branches: [] };
  await post(handler, `/v1/runs/${runId}/result`, result, runnerToken);
  assertEquals(revoked, [runId]);
  assertEquals((await get(handler, `/v1/runs/${runId}/credentials`, runnerToken)).status, 409);
});

test("boot credentials: both halves ride one answer, and a scope with no issuer is a 503", async () => {
  const { modelAccess } = fakeModelAccess();
  const { toolAccess } = fakeToolAccess();
  const both = { ...PI_AGENT, toolPolicy: TOOL_AGENT.toolPolicy };

  const { handler, launches } = buildApp({
    ...imageConfig(),
    modelAccess,
    toolAccess,
  });
  const agent = await createAgent(handler, both);
  const { runId } = await (await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC }))
    .json();
  const res = await get(
    handler,
    `/v1/runs/${runId}/credentials`,
    (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.env.ANTHROPIC_BASE_URL, "http://model-proxy.test");
  assertEquals(body.mcp.token, "ryph-mcp-test");

  // A run frozen with a tool scope on a deployment whose gateway link has since gone dark: the
  // runner is told to retry (a 5xx), never handed a half answer it would boot on.
  const dark = buildApp({
    ...imageConfig(),
    modelAccess,
    toolAccess,
    store: memoryTaskStore(),
  });
  const darkAgent = await createAgent(dark.handler, both);
  const { runId: darkRun } = await (await post(dark.handler, "/v1/tasks", {
    agentId: darkAgent.id,
    ...TASK_SPEC,
  })).json();
  const unplugged = makeHandler({
    store: dark.store,
    provisioner: fakeProvisioner().provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate: () => Promise.resolve(BREAK_GLASS),
    modelAccess,
    toolAccess: null,
    now: dark.clock.now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: GATEWAY,
      runHistoryUrl: null,
      appUrl: null,
      services: DEFAULT_SERVICE_POLICY,
      egress: {
        policy: { mode: "proxy" as const, bundles: [], hosts: [], proxyUrl: null },
        key: null,
        tokenTtlMs: 0,
      },
      platformMemoryServerId: null,
      platformChatServerId: null,
      platformTools: {
        webServerId: "ms-platform-web",
        web: false,
        forge: null,
        pending: false,
      },
    },
  });
  const refused = await get(
    unplugged,
    `/v1/runs/${darkRun}/credentials`,
    (await bootstrapEnv(dark.handler, dark.launches[0].env)).RYPH_RUN_TOKEN,
  );
  assertEquals(refused.status, 503);
  assert((await refused.json()).error.includes("tool access"));
});

test("malformed payloads are refused at the boundary with named paths", async () => {
  const { handler } = buildApp();
  const badAgent = await post(handler, "/v1/agents", { ...AGENT_BODY, email: "not-an-email" });
  assertEquals(badAgent.status, 400);
  assert((await badAgent.json()).error.includes("email"));

  const agent = await createAgent(handler);
  const badTask = await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC, ref: "-rf" });
  assertEquals(badTask.status, 400);
  assert((await badTask.json()).error.includes("ref"));
  // A task names a connected repo or a workspace; a URL is no longer a thing it can check out.
  const rawTask = await post(handler, "/v1/tasks", {
    agentId: agent.id,
    spec: TASK_SPEC.spec,
    repo: { url: "https://example.com/repo.git", ref: "main" },
  });
  assertEquals(rawTask.status, 400);
  assertStringIncludes(
    (await rawTask.json()).error,
    "exactly one of connectedRepoId or workspaceId is required",
  );
});

test("a photo-finish duplicate handle answers 409, not an unhandled 500", async () => {
  // The read-then-write check passed for both callers; the index refuses the loser. Shaped
  // like postgres.js's error, because that shape is what the mapping reads.
  const conflict = Object.assign(
    new Error(`duplicate key value violates unique constraint "agents_by_handle"`),
    { code: "23505", constraint_name: "agents_by_handle" },
  );
  const store = memoryTaskStore();
  const { handler } = buildApp({
    store: { ...store, createAgent: () => Promise.reject(conflict) },
  });

  const res = await post(handler, "/v1/agents", { ...AGENT_BODY, handle: "ada" });
  assertEquals(res.status, 409);
  assert(String((await res.json()).error).includes("ada"));
});

test("a store failure that is not a handle conflict is not swallowed", async () => {
  const store = memoryTaskStore();
  const { handler } = buildApp({
    store: { ...store, createAgent: () => Promise.reject(new Error("connection reset")) },
  });

  await post(handler, "/v1/agents", AGENT_BODY)
    .then(() => {
      throw new Error("expected the store failure to propagate");
    })
    .catch((err) => assertEquals(String(err).includes("connection reset"), true));
});

// ── Internet access, at the form ───────────────────────────────────────────────────────────

const NARROWED_AGENT = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  harnessKind: "pi",
  networkPolicy: { bundles: ["npm"], hosts: [] },
};

test("a network policy is resolved against the ceiling even where the boundary is off", async () => {
  // The mode is a flag an operator flips, and the ceiling's bundles and hosts are configured
  // either way — so "open" means the boundary is not ENFORCED today, never that the narrowing
  // question has no answer. Waving the check through here stored a policy that resolves to a
  // refusal, and the day RYPH_EGRESS went to `proxy` every startTask for that agent 400'd, with
  // a failed task as the only place it surfaced.
  const open = buildApp({ egress: { mode: "open", bundles: ["npm"], hosts: [] } });
  const refused = await post(open.handler, "/v1/agents", {
    ...NARROWED_AGENT,
    networkPolicy: { bundles: ["cargo"], hosts: [] },
  });
  assertEquals(refused.status, 400);
  assertStringIncludes((await refused.json()).error, "cargo");

  // What the ceiling does cover is still saved, and stays saved: it becomes real the day the
  // operator turns the boundary on, which is the whole reason the policy is stored at all.
  const saved = await post(open.handler, "/v1/agents", NARROWED_AGENT);
  assertEquals(saved.status, 201);
  assertEquals((await saved.json()).networkPolicy.bundles, ["npm"]);
});

test("clearing an agent's network policy WIDENS it, so it is an admin's call", async () => {
  // The one gate in this area whose polarity is inverted, and the reason it is worth a test of
  // its own: for every other policy `null` takes access away, so clearing is always open. Here
  // `null` means "the deployment's whole ceiling", so clearing is the widest possible move — a
  // refactor that made this consistent with its siblings would let any signed-in user hand an
  // admin-narrowed agent the entire allowlist, and nothing else would fail.
  const asRole = (role: Role): Authenticate => () =>
    Promise.resolve({
      kind: "user",
      userId: "u-1",
      email: "u@example.com",
      name: "U",
      caps: capsClaimOf(role),
      emailVerified: true,
      sid: "s-1",
      via: "session",
    });
  const store = memoryTaskStore();
  const egress = { mode: "proxy" as const, bundles: ["npm", "pypi"], hosts: [] };
  const asUser = buildApp({ store, egress, authenticate: asRole("member") }).handler;
  const asAdmin = buildApp({ store, egress, authenticate: asRole("owner") }).handler;

  const created = await post(asAdmin, "/v1/agents", NARROWED_AGENT);
  assertEquals(created.status, 201);
  const agent = await created.json();

  const cleared = await patch(asUser, `/v1/agents/${agent.id}`, { networkPolicy: null });
  assertEquals(cleared.status, 403);
  assertEquals((await cleared.json()).code, "forbidden");

  // A resend of the identical policy moved nothing — the form resends every field it holds, and
  // a rename must not need an admin.
  const renamed = await patch(asUser, `/v1/agents/${agent.id}`, {
    name: "Ada L.",
    networkPolicy: NARROWED_AGENT.networkPolicy,
  });
  assertEquals(renamed.status, 200);
  assertEquals((await renamed.json()).name, "Ada L.");

  // And the admin may still clear it.
  const byAdmin = await patch(asAdmin, `/v1/agents/${agent.id}`, { networkPolicy: null });
  assertEquals(byAdmin.status, 200);
  assertEquals((await byAdmin.json()).networkPolicy, null);
});

test("an admin moves the deployment's allowlist, and the environment is only the seed", async () => {
  // The gap this closes: before it, widening the ceiling was a redeploy, and the first person to
  // learn a bundle was missing was a run dying in the middle of `deno install`.
  const asRole = (role: Role): Authenticate => () =>
    Promise.resolve({
      kind: "user",
      userId: "u-1",
      email: "u@example.com",
      name: "U",
      caps: capsClaimOf(role),
      emailVerified: true,
      sid: "s-1",
      via: "session",
    });
  const store = memoryTaskStore();
  const egress = { mode: "proxy" as const, bundles: ["npm"], hosts: [] };
  const asUser = buildApp({ store, egress, authenticate: asRole("member") }).handler;
  const asAdmin = buildApp({ store, egress, authenticate: asRole("owner") }).handler;

  // With nothing saved, the environment's seed IS the ceiling — and the route says so, because
  // the two read identically otherwise and only one of them survives a redeploy.
  const seeded = await (await get(asUser, "/v1/egress")).json();
  assertEquals(seeded.source, "environment");
  assertEquals(seeded.bundles.map((b: { id: string }) => b.id), ["npm"]);
  assertEquals(seeded.updatedAt, null);
  // The catalogue rides along for the admin's form: everything that EXISTS, beside what this
  // deployment vouches for. One route, two audiences.
  assert(seeded.catalogue.some((b: { id: string }) => b.id === "deno"));

  const refused = await put(asUser, "/v1/egress", { bundles: ["npm", "deno"], hosts: [] });
  assertEquals(refused.status, 403);
  assertEquals((await refused.json()).code, "forbidden");

  // A bundle nobody offers is refused HERE rather than stored and then failing every launch
  // with a message about a variable the admin never set.
  const nonsense = await put(asAdmin, "/v1/egress", { bundles: ["nope"], hosts: [] });
  assertEquals(nonsense.status, 400);
  assertStringIncludes((await nonsense.json()).error, "npm");

  const saved = await put(asAdmin, "/v1/egress", {
    bundles: ["npm", "deno"],
    hosts: ["internal.example.com"],
  });
  assertEquals(saved.status, 200);
  assertEquals((await saved.json()).updatedBy, "u-1");

  const now = await (await get(asUser, "/v1/egress")).json();
  assertEquals(now.source, "admin");
  assertEquals(now.bundles.map((b: { id: string }) => b.id), ["npm", "deno"]);
  assertEquals(now.hosts, ["internal.example.com"]);
});

test("a saved allowlist binds the agent form, without a restart", async () => {
  // The ceiling is READ, never cached off the boot config: an admin who widens it must be able
  // to save the agent that needed the widening, in the same sitting and with no redeploy.
  const asAdmin: Authenticate = () =>
    Promise.resolve({
      kind: "user",
      userId: "u-1",
      email: "u@example.com",
      name: "U",
      caps: ["*"],
      emailVerified: true,
      sid: "s-1",
      via: "session",
    });
  const store = memoryTaskStore();
  const egress = { mode: "proxy" as const, bundles: ["npm"], hosts: [] };
  const handler = buildApp({ store, egress, authenticate: asAdmin }).handler;

  const tooSoon = await post(handler, "/v1/agents", {
    ...NARROWED_AGENT,
    networkPolicy: { bundles: ["deno"], hosts: [] },
  });
  assertEquals(tooSoon.status, 400);
  assertStringIncludes((await tooSoon.json()).error, "deno");

  assertEquals(
    (await put(handler, "/v1/egress", { bundles: ["npm", "deno"], hosts: [] })).status,
    200,
  );

  const now = await post(handler, "/v1/agents", {
    ...NARROWED_AGENT,
    networkPolicy: { bundles: ["deno"], hosts: [] },
  });
  assertEquals(now.status, 201);
  assertEquals((await now.json()).networkPolicy.bundles, ["deno"]);
});

test("the API serves while the platform tool lookup is still pending, and picks it up when it lands", async () => {
  // The bug this pins is a boot-order one: the two platform lookups used to run BEFORE
  // serve(), so a gateway that was slow or had a slug conflict left this process answering no
  // probe for up to two minutes — and the liveness probe kills it at one. The listener now comes
  // up first and the holder below is filled in behind it, so everything here must work while it
  // still says `pending`.
  const platformTools = {
    webServerId: "ms-platform-web",
    web: false,
    forge: null as string | null,
    pending: true,
  };
  const { handler, store } = buildApp({ platformTools });
  // A tool-capable harness: the web row joins runs of those, and `echo` (this file's default)
  // drives no tools at all.
  const agent = await createAgent(handler, { ...AGENT_BODY, harnessKind: "pi" });

  // Serving: an ordinary read, and a real task start. (The health routes are main.ts's, mounted
  // beside this handler on the same listener, so they are up exactly when it is.)
  assertEquals((await get(handler, "/v1/tasks")).status, 200);
  const first = await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC });
  assertEquals(first.status, 201, "a task starts while the gateway has not answered yet");
  const pendingRun = (await store.getRun((await first.json()).runId))!;
  assertEquals(
    pendingRun.toolScope?.servers.some((s) => s.serverId === "ms-platform-web") ?? false,
    false,
    "a run started in that window gets no web row",
  );

  // The lookup lands. The holder is READ at every task start rather than closed over, so the
  // next run has the tools without this process restarting.
  platformTools.web = true;
  platformTools.pending = false;
  const second = await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC });
  assertEquals(second.status, 201);
  const laterRun = (await store.getRun((await second.json()).runId))!;
  assertEquals(laterRun.toolScope?.servers, [{ serverId: "ms-platform-web", allowedTools: "*" }]);
});

// ── run limits ─────────────────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;
/** An operator ceiling of an hour, $50 and 8 calls, with room for two live runs. */
const CEILING: DeploymentLimits = {
  ceiling: { wallClockMs: HOUR, spendUsd: 50, callsInFlight: 8 },
  concurrency: 2,
  maxCredentials: 2,
  deadlineGraceMs: 720_000,
  startupGraceMs: 600_000,
};

const roleOf = (role: "admin" | "user"): Authenticate => () =>
  Promise.resolve({
    kind: "user",
    userId: "u-1",
    email: "u@example.com",
    name: "U",
    // "admin" carries `agents:policy` (an operator's); "user" the bare member bundle.
    caps: capsClaimOf(role === "admin" ? "operator" : "member"),
    emailVerified: true,
    sid: "s-1",
    via: "session",
  });

test("GET /v1/limits answers the operator's ceiling and the concurrency cap", async () => {
  const { handler } = buildApp({ limits: CEILING });
  const res = await get(handler, "/v1/limits");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ceiling: CEILING.ceiling, concurrency: 2 });
});

test("an agent's limit policy is an admin's to set, anyone's to clear, and refused above the ceiling", async () => {
  const store = memoryTaskStore();
  const asUser = buildApp({ store, limits: CEILING, authenticate: roleOf("user") }).handler;
  const asAdmin = buildApp({ store, limits: CEILING, authenticate: roleOf("admin") }).handler;
  const policy = { wallClockMs: HOUR / 2, spendUsd: 10, callsInFlight: null };

  const refused = await post(asUser, "/v1/agents", { ...AGENT_BODY, limitPolicy: policy });
  assertEquals(refused.status, 403);
  assertEquals((await refused.json()).code, "forbidden");

  const over = await post(asAdmin, "/v1/agents", {
    ...AGENT_BODY,
    limitPolicy: { ...policy, spendUsd: 51 },
  });
  assertEquals(over.status, 400);
  assertEquals(await over.json(), {
    error: "limitPolicy.spendUsd is above the deployment's ceiling (50)",
    code: "over_ceiling",
    field: "spendUsd",
  });

  const created = await post(asAdmin, "/v1/agents", { ...AGENT_BODY, limitPolicy: policy });
  assertEquals(created.status, 201);
  const agent = await created.json();
  assertEquals(agent.limitPolicy, policy);

  // A plain user may not move it in either direction, since clearing it hands the agent the
  // wider ceiling back, and may resend it unchanged.
  const moved = await patch(asUser, `/v1/agents/${agent.id}`, {
    limitPolicy: { ...policy, spendUsd: 5 },
  });
  assertEquals(moved.status, 403);
  const cleared = await patch(asUser, `/v1/agents/${agent.id}`, { limitPolicy: null });
  assertEquals(cleared.status, 403);
  assertEquals((await cleared.json()).code, "forbidden");
  assertEquals(
    (await patch(asUser, `/v1/agents/${agent.id}`, { limitPolicy: policy })).status,
    200,
  );
  assertEquals((await patch(asAdmin, `/v1/agents/${agent.id}`, { limitPolicy: null })).status, 200);
  // And an admin's move is still held under the ceiling.
  const adminOver = await patch(asAdmin, `/v1/agents/${agent.id}`, {
    limitPolicy: { ...policy, wallClockMs: HOUR * 2 },
  });
  assertEquals(adminOver.status, 400);
  assertEquals((await adminOver.json()).field, "wallClockMs");
});

test("an agent's patches are anyone's to switch off and an admin's to switch back on", async () => {
  const store = memoryTaskStore();
  const asUser = buildApp({ store, authenticate: roleOf("user") }).handler;
  const asAdmin = buildApp({ store, authenticate: roleOf("admin") }).handler;

  const open = await (await post(asUser, "/v1/agents", AGENT_BODY)).json();
  assertEquals(open.canOpenPatches, true);
  const locked = await post(asUser, "/v1/agents", { ...AGENT_BODY, canOpenPatches: false });
  assertEquals(locked.status, 201);
  const agent = await locked.json();
  assertEquals(agent.canOpenPatches, false);

  // Resending the lock, or editing something else, needs nothing.
  assertEquals(
    (await patch(asUser, `/v1/agents/${agent.id}`, { canOpenPatches: false, name: "Eve" }))
      .status,
    200,
  );
  const reopened = await patch(asUser, `/v1/agents/${agent.id}`, { canOpenPatches: true });
  assertEquals(reopened.status, 403);
  assertEquals((await reopened.json()).code, "forbidden");
  assertEquals((await store.getAgent(agent.id))!.canOpenPatches, false);

  const byAdmin = await patch(asAdmin, `/v1/agents/${agent.id}`, { canOpenPatches: true });
  assertEquals(byAdmin.status, 200);
  assertEquals((await byAdmin.json()).canOpenPatches, true);
  assertEquals(
    (await patch(asUser, `/v1/agents/${agent.id}`, { canOpenPatches: false })).status,
    200,
  );
});

test("an agent's browser is anyone's to switch off and an admin's (agents:policy) to switch on", async () => {
  const store = memoryTaskStore();
  const asUser = buildApp({ store, authenticate: roleOf("user") }).handler;
  const asAdmin = buildApp({ store, authenticate: roleOf("admin") }).handler;

  // On create: off (the default, or said) needs nothing; on is an admin's.
  const plain = await post(asUser, "/v1/agents", { ...AGENT_BODY, browserEnabled: false });
  assertEquals(plain.status, 201);
  const agent = await plain.json();
  assertEquals(agent.browserEnabled, false);
  const asked = await post(asUser, "/v1/agents", { ...AGENT_BODY, browserEnabled: true });
  assertEquals(asked.status, 403);
  assertEquals((await asked.json()).code, "forbidden");
  const byAdminCreate = await post(asAdmin, "/v1/agents", { ...AGENT_BODY, browserEnabled: true });
  assertEquals(byAdminCreate.status, 201);
  const browsing = await byAdminCreate.json();
  assertEquals(browsing.browserEnabled, true);

  // On an edit: false → true is an admin's.
  const on = await patch(asUser, `/v1/agents/${agent.id}`, { browserEnabled: true });
  assertEquals(on.status, 403);
  assertEquals((await on.json()).code, "forbidden");
  assertEquals((await store.getAgent(agent.id))!.browserEnabled, false);
  const byAdmin = await patch(asAdmin, `/v1/agents/${agent.id}`, { browserEnabled: true });
  assertEquals(byAdmin.status, 200);
  assertEquals((await byAdmin.json()).browserEnabled, true);

  // Leaving it on (resent, or another field edited) and switching it off need only agents:write.
  assertEquals(
    (await patch(asUser, `/v1/agents/${agent.id}`, { browserEnabled: true, name: "Eve" })).status,
    200,
  );
  const off = await patch(asUser, `/v1/agents/${agent.id}`, { browserEnabled: false });
  assertEquals(off.status, 200);
  assertEquals((await off.json()).browserEnabled, false);
});

test("an edit in flight while an admin locks the agent never puts the lock back", async () => {
  const base = memoryTaskStore();
  const asUser = buildApp({ store: base, authenticate: roleOf("user") }).handler;
  const agent = await (await post(asUser, "/v1/agents", AGENT_BODY)).json();
  // An admin locks the agent between each edit's read and its save.
  const racingStore = () => {
    let reads = 0;
    return {
      ...base,
      async getAgent(id: string) {
        const read = await base.getAgent(id);
        if (++reads === 1 && read !== null) {
          await base.setAgentCanOpenPatches(read.id, true, false);
        }
        return read;
      },
    };
  };

  // A rename saves, and the lock stands: the full-row save never writes the switch.
  const renamed = await patch(
    buildApp({ store: racingStore(), authenticate: roleOf("user") }).handler,
    `/v1/agents/${agent.id}`,
    { name: "Renamed" },
  );
  assertEquals(renamed.status, 200);
  assertEquals(
    [(await base.getAgent(agent.id))!.canOpenPatches, (await base.getAgent(agent.id))!.name],
    [false, "Renamed"],
  );

  // A stale "true" resent unchanged (it read true) writes nothing either.
  await base.setAgentCanOpenPatches(agent.id, false, true);
  const resent = await patch(
    buildApp({ store: racingStore(), authenticate: roleOf("user") }).handler,
    `/v1/agents/${agent.id}`,
    { canOpenPatches: true },
  );
  assertEquals(resent.status, 200);
  assertEquals((await base.getAgent(agent.id))!.canOpenPatches, false);

  // And archiving is a full-row save too: it cannot put the switch back.
  await base.setAgentCanOpenPatches(agent.id, false, true);
  const archiving = buildApp({ store: racingStore(), authenticate: roleOf("user") }).handler;
  const archived = await post(archiving, `/v1/agents/${agent.id}/archive`, {});
  assertEquals(archived.status, 200);
  const after = (await base.getAgent(agent.id))!;
  assertEquals([after.canOpenPatches, after.archivedAt !== null], [false, true]);
});

test("a run carries its resolved limits, frozen: task under agent under ceiling", async () => {
  const store = memoryTaskStore();
  const asAdmin = buildApp({ store, limits: CEILING, authenticate: roleOf("admin") });
  const agent = await createAgent(asAdmin.handler, {
    ...AGENT_BODY,
    limitPolicy: { wallClockMs: HOUR / 2, spendUsd: null, callsInFlight: 4 },
  });
  const res = await post(asAdmin.handler, "/v1/tasks", {
    agentId: agent.id,
    ...TASK_SPEC,
    limits: { spendUsd: 5 },
  });
  assertEquals(res.status, 201);
  const { taskId } = await res.json();
  const detail = await (await get(asAdmin.handler, `/v1/tasks/${taskId}`)).json();
  assertEquals(detail.runs[0].limits, { wallClockMs: HOUR / 2, spendUsd: 5, callsInFlight: 4 });
  // The provisioner got the wall-clock backstop: the limit plus the graces, in seconds.
  assertEquals(asAdmin.launches[0].deadlineSeconds, (HOUR / 2 + 720_000) / 1000);
  // Editing the agent afterwards moves nothing for the run already started.
  await patch(asAdmin.handler, `/v1/agents/${agent.id}`, { limitPolicy: null });
  const again = await (await get(asAdmin.handler, `/v1/tasks/${taskId}`)).json();
  assertEquals(again.runs[0].limits.wallClockMs, HOUR / 2);
});

test("a task may lower its limits; raising above the agent's is an admin's, above the ceiling nobody's", async () => {
  const store = memoryTaskStore();
  const asUser = buildApp({ store, limits: CEILING, authenticate: roleOf("user") }).handler;
  const asAdmin = buildApp({ store, limits: CEILING, authenticate: roleOf("admin") }).handler;
  const agent = await createAgent(asAdmin, {
    ...AGENT_BODY,
    limitPolicy: { wallClockMs: null, spendUsd: 10, callsInFlight: null },
  });
  const start = (handler: Handler, limits: unknown) =>
    post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC, limits });

  assertEquals((await start(asUser, { spendUsd: 5 })).status, 201);
  const raised = await start(asUser, { spendUsd: 20 });
  assertEquals(raised.status, 403);
  assertEquals(await raised.json(), {
    error: "raising a task's spendUsd above the agent's limit requires agents:policy",
    code: "forbidden",
    capability: "agents:policy",
  });
  // A field the agent leaves at the ceiling can be lowered by anyone too.
  assertEquals((await start(asUser, { wallClockMs: HOUR / 4 })).status, 201);
  // An admin raises up to the ceiling, and not past it.
  const store2 = memoryTaskStore();
  const admin2 =
    buildApp({ store: store2, limits: CEILING, authenticate: roleOf("admin") }).handler;
  const agent2 = await createAgent(admin2, {
    ...AGENT_BODY,
    limitPolicy: { wallClockMs: null, spendUsd: 10, callsInFlight: null },
  });
  const up = await post(admin2, "/v1/tasks", {
    agentId: agent2.id,
    ...TASK_SPEC,
    limits: { spendUsd: 50 },
  });
  assertEquals(up.status, 201);
  const past = await post(admin2, "/v1/tasks", {
    agentId: agent2.id,
    ...TASK_SPEC,
    limits: { spendUsd: 51 },
  });
  assertEquals(past.status, 400);
  assertEquals((await past.json()).code, "over_ceiling");
});

test("task creation past RYPH_RUN_CONCURRENCY answers 429 limit_reached with the cap, before the insert", async () => {
  const store = memoryTaskStore();
  let inserts = 0;
  const createTask = store.createTask.bind(store);
  store.createTask = (...args) => {
    inserts += 1;
    return createTask(...args);
  };
  const { handler } = buildApp({ limits: CEILING, store });
  const agent = await createAgent(handler);
  const start = () => post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC });
  assertEquals((await start()).status, 201);
  assertEquals((await start()).status, 201);
  const full = await start();
  assertEquals(full.status, 429);
  const body = await full.json();
  assertEquals([body.code, body.limit, body.max], ["limit_reached", "concurrent-runs", 2]);
  assertEquals(inserts, 2, "a deployment already full is refused at the door");
  // A malformed request is a 400 first: the cap is not what is wrong with it.
  const malformed = await post(handler, "/v1/tasks", {
    agentId: agent.id,
    ...TASK_SPEC,
    ref: "-rf",
  });
  assertEquals(malformed.status, 400);
});

test("a deployment at its spend ceiling refuses task creation, and a proxy that cannot say does not", async () => {
  const { modelAccess, spend } = fakeModelAccess();
  const { handler } = buildApp({ modelAccess, ...imageConfig() });
  const agent = await createAgent(handler, PI_AGENT);
  spend.ceilingReached = true;
  const refused = await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC });
  assertEquals(refused.status, 403);
  assertEquals((await refused.json()).limit, "deployment-spend");

  // An agent with no model policy holds no model credential and cannot spend: the ceiling has
  // nothing to say to its runs.
  const modelless = await createAgent(handler, { ...PI_AGENT, modelPolicy: undefined });
  assertEquals(
    (await post(handler, "/v1/tasks", { agentId: modelless.id, ...TASK_SPEC })).status,
    201,
  );

  const blind = { ...modelAccess, ceilingReached: () => Promise.reject(new Error("down")) };
  const { handler: withBlind } = buildApp({ modelAccess: blind, ...imageConfig() });
  const agent2 = await createAgent(withBlind, PI_AGENT);
  assertEquals(
    (await post(withBlind, "/v1/tasks", { agentId: agent2.id, ...TASK_SPEC })).status,
    201,
  );
});

test("a deployment at its spend ceiling still starts a run on a ChatGPT plan", async () => {
  // The id the door checks is the proxy's own, spelled twice: pinned here.
  assert(spendIncluded(CHATGPT_PLAN));
  assert(!spendIncluded("openai"));
  const { modelAccess, spend } = fakeModelAccess({
    id: "pk-plan",
    provider: CHATGPT_PLAN,
    dialect: "openai-responses",
    archivedAt: null,
  });
  const { handler } = buildApp({ modelAccess, ...imageConfig() });
  const agent = await createAgent(handler, {
    ...PI_AGENT,
    modelPolicy: {
      ...PI_AGENT.modelPolicy,
      providerKeyId: "pk-plan",
      provider: CHATGPT_PLAN,
      defaultModel: null,
    },
  });
  spend.ceilingReached = true;
  const started = await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC });
  assertEquals(started.status, 201);
});

test("boot credentials are capped per run, and the run's caps ride the scope", async () => {
  const { modelAccess, issued } = fakeModelAccess();
  const { handler, launches } = buildApp({
    modelAccess,
    ...imageConfig(),
    limits: CEILING,
    authenticate: roleOf("admin"),
  });
  const agent = await createAgent(handler, {
    ...PI_AGENT,
    limitPolicy: { wallClockMs: null, spendUsd: 20, callsInFlight: 4 },
  });
  const { runId } = await (
    await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC })
  ).json();
  const runnerToken = (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN;
  const fetch = () => get(handler, `/v1/runs/${runId}/credentials`, runnerToken);
  assertEquals((await fetch()).status, 200);
  assertEquals([issued[0].spendUsd, issued[0].callsInFlight], [20, 4]);
  assertEquals((await fetch()).status, 200);
  const third = await fetch();
  assertEquals(third.status, 429);
  const body = await third.json();
  assertEquals([body.code, body.limit, body.max], ["limit_reached", "credentials", 2]);
  assertEquals(issued.length, 2, "the refused fetch minted nothing");
});

test("a credential pair whose tool half failed does not count toward RYPH_RUN_MAX_CREDENTIALS", async () => {
  const { modelAccess, issued } = fakeModelAccess();
  const { toolAccess } = fakeToolAccess();
  let toolFailures = 1;
  const flaky: ToolAccess = {
    ...toolAccess,
    issueRunCredentials(scope) {
      if (toolFailures-- > 0) return Promise.reject(new Error("gateway blink"));
      return toolAccess.issueRunCredentials(scope);
    },
  };
  const { handler, launches } = buildApp({
    modelAccess,
    toolAccess: flaky,
    ...imageConfig(),
    limits: CEILING,
  });
  const agent = await createAgent(handler, { ...PI_AGENT, toolPolicy: TOOL_AGENT.toolPolicy });
  const { runId } = await (
    await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC })
  ).json();
  const runnerToken = (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN;
  const fetch = () => get(handler, `/v1/runs/${runId}/credentials`, runnerToken);
  assertEquals((await fetch()).status, 503, "the pair is retried as a whole");
  assertEquals(issued.length, 0, "a tool half that failed minted no model key");
  assertEquals((await fetch()).status, 200);
  assertEquals((await fetch()).status, 200);
  assertEquals((await fetch()).status, 429);
  assertEquals(issued.length, 2);
});

test("a beat that loses the race to a conclusion hears the 409, not a stale 200", async () => {
  const store = memoryTaskStore();
  const { handler, launches } = buildApp({ store });
  const agent = await createAgent(handler);
  const created = await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC });
  const { runId } = await created.json();
  const token = (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN;
  const first = await post(
    handler,
    `/v1/runs/${runId}/heartbeat`,
    { seq: 0, phase: "cloning" },
    token,
  );
  assertEquals(first.status, 200);

  // The reaper concludes the run while this beat is in flight: the handler reads the live row,
  // and by the time it writes, the stored one is `lost`.
  const live = (await store.getRun(runId))!;
  await store.saveRunTransition({ ...live, state: "lost" }, live);
  const realGetRun = store.getRun;
  let reads = 0;
  store.getRun = (id) => reads++ === 0 ? Promise.resolve(structuredClone(live)) : realGetRun(id);

  const raced = await post(
    handler,
    `/v1/runs/${runId}/heartbeat`,
    { seq: 1, phase: "running" },
    token,
  );
  assertEquals(raced.status, 409);
  assertEquals((await store.getRun(runId))?.state, "lost");
});

test("a stale-base report lands on the trail for the run's own repos only", async () => {
  const { handler, store, launches } = buildApp();
  const agent = await createAgent(handler);
  const { runId } = await (await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC }))
    .json();
  const runnerToken = (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN;
  const served = {
    commit: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
    since: "2026-09-30T14:02:11Z",
  };
  const report = (bases: unknown, token = runnerToken) =>
    post(handler, `/v1/runs/${runId}/base/stale`, { bases }, token);

  assertEquals((await report([{ path: "repo", ...served }], "nope")).status, 401);
  // One event per repo the run was given; a path it never had is a container's word alone.
  const res = await report([{ path: "repo", ...served }, { path: "forged", ...served }]);
  assertEquals(res.status, 204);
  const details = async () =>
    (await store.listEvents(runId)).filter((e) => e.kind === "base-stale").map((e) => e.detail);
  const detail = "`repo/` (/srv/repo) started from `main` at 1a2b3c4, served from the " +
    "forge's cache: every refresh from upstream since 2026-09-30T14:02:11Z has failed, so it " +
    "may be behind upstream.";
  assertEquals(await details(), [detail]);
  assertEquals((await report([{ path: "forged", ...served }])).status, 204);
  assertEquals((await details()).length, 1);
  // The ref is the run's own, never the container's word: a report naming another is accepted
  // like every runner-facing body with a key this version does not know, and still names `main`.
  assertEquals((await report([{ path: "repo", ...served, ref: "hotfix" }])).status, 204);
  assertEquals(await details(), [detail, detail]);

  assertEquals((await report([{ path: "repo", ...served, commit: "1a2b3c4" }])).status, 400);
  assertEquals((await report([])).status, 400);

  const result = { status: "success", branches: [], summary: "done" };
  await post(handler, `/v1/runs/${runId}/result`, result, runnerToken);
  assertEquals((await report([{ path: "repo", ...served }])).status, 409);
});

test("a setup-failure report lands on the trail as a warning, for the run's own repos only", async () => {
  const { handler, store, launches } = buildApp();
  const agent = await createAgent(handler);
  const { runId } = await (await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC }))
    .json();
  const runnerToken = (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN;
  const failed = {
    kind: "step",
    step: "install\ndeps",
    index: 2,
    total: 4,
    code: 1,
    // escapes, a control character and the egress claim in a proxy URL: none of it is stored
    output: "\u001b[31mnpm ERR!\u001b[0m nope\u0007 via http://r-1:secret.claim@egress:3128\n",
    discarded: true,
  };
  const report = (failures: unknown, token = runnerToken) =>
    post(handler, `/v1/runs/${runId}/setup/failed`, { failures }, token);

  assertEquals((await report([{ path: "repo", ...failed }], "nope")).status, 401);
  // An empty report is refused; an entry that is no warning (an empty label) is dropped alone,
  // records nothing, and leaves the run's one report unspent.
  assertEquals((await report([])).status, 400);
  assertEquals((await report([{ path: "repo", ...failed, step: "" }])).status, 204);
  // One event per repo the run was given; a path it never had is a container's word alone.
  const res = await report([
    { path: "repo", ...failed },
    { path: "forged", ...failed },
  ]);
  assertEquals(res.status, 204);
  const details = async () =>
    (await store.listEvents(runId)).filter((e) => e.kind === "setup.failed").map((e) => e.detail);
  const [detail] = await details();
  assertEquals(
    detail,
    "[step] `repo/`: step 2 of 4 (install deps) exited with code 1, so the 2 steps after it were " +
      "skipped, and the run went on. Its tracked and untracked changes were discarded and its " +
      "checkout put back on its base commit; ignored build output may remain.\n" +
      "npm ERR! nope via http://[redacted]@egress:3128",
  );
  assert(!detail!.includes("secret.claim"));

  // One report per run: a second (a retry, or the agent with the run token) is refused whole.
  assertEquals((await report([{ path: "repo", ...failed, index: 4, output: "" }])).status, 409);
  assertEquals((await details()).length, 1);

  const result = { status: "success", branches: [], summary: "done" };
  await post(handler, `/v1/runs/${runId}/result`, result, runnerToken);
  assertEquals((await report([{ path: "repo", ...failed }])).status, 409);
});

test("an oversized setup warning is clipped, and a malformed one costs only itself", async () => {
  const { handler, store, launches } = buildApp();
  const agent = await createAgent(handler);
  const { runId } = await (await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC }))
    .json();
  const runnerToken = (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN;
  const res = await post(handler, `/v1/runs/${runId}/setup/failed`, {
    failures: [
      { kind: "step", path: "repo" },
      { kind: "invalid", path: "repo", error: `setup.yml: unknown key \`${"k".repeat(10_000)}\`` },
    ],
  }, runnerToken);
  assertEquals(res.status, 204);
  const [detail] = (await store.listEvents(runId)).filter((e) => e.kind === "setup.failed")
    .map((e) => e.detail);
  assertStringIncludes(detail!, "setup.yml: unknown key `kkk");
  assert(detail!.length < 5_000, "the error is bounded");
});

test("concurrent runner reports commit one result and conclude once; a late report recovers lost", async () => {
  for (const lost of [false, true]) {
    const { handler, store, launches } = buildApp();
    const agent = await createAgent(handler);
    const { runId } = await (await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC }))
      .json();
    const token = (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN;
    if (lost) {
      const live = (await store.getRun(runId))!;
      assert(await store.saveRunTransition({ ...live, state: "lost" }, live));
    }
    let conclusions = 0;
    const revoke = store.revokeGitKeysForRun;
    store.revokeGitKeysForRun = async (...args) => {
      conclusions++;
      await revoke(...args);
    };
    // Both handlers must reach the commit with the same live (or recoverable lost) snapshot.
    const save = store.saveRunResult;
    let arrivals = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.saveRunResult = async (run) => {
      if (++arrivals === 2) release();
      await bothRead;
      return save(run);
    };
    const before = (await store.listEvents(runId)).length;
    const result = { status: "success" as const, branches: [], summary: "finished once" };
    const replies = await Promise.all([
      post(handler, `/v1/runs/${runId}/result`, result, token),
      post(handler, `/v1/runs/${runId}/result`, result, token),
    ]);
    assertEquals(replies.map((r) => r.status), [200, 200]);
    assertEquals(arrivals, 2);
    assertEquals(conclusions, 1);
    assertEquals((await store.listEvents(runId)).length - before, 1);
    assertEquals((await store.getRun(runId))?.state, "succeeded");
    assertEquals((await store.getRun(runId))?.result, result);
  }
});

test("changes discarded in a repo for another's failed step are their own warning, naming the run's repos only", async () => {
  const { handler, store, launches } = buildApp();
  // Freeze the workspace fixture before the run is created.
  const createTask = store.createTask;
  store.createTask = (task, run) => {
    const repo = run.workItem.repos[0];
    run.workItem = { ...run.workItem, repos: [repo, { ...repo, path: "web" }] };
    return createTask(task, run);
  };
  const agent = await createAgent(handler);
  const { runId } = await (await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC }))
    .json();
  const runnerToken = (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN;
  const res = await post(handler, `/v1/runs/${runId}/setup/failed`, {
    failures: [
      // `forged` is no repo of this run: dropped from the list, which still names `web`
      { kind: "discarded", path: "repo", after: ["web", "forged", "repo"] },
      // a list naming no repo of the run is no warning at all
      { kind: "discarded", path: "web", after: ["forged"] },
      // a second kind for the same repo stands beside the first; a second of a kind does not
      { kind: "invalid", path: "repo", error: "setup.yml: unknown key `step`" },
      { kind: "invalid", path: "repo", error: "setup.yml: again" },
    ],
  }, runnerToken);
  assertEquals(res.status, 204);
  const events = (await store.listEvents(runId)).filter((e) => e.kind === "setup.failed");
  assertEquals(events.map((e) => e.detail), [
    "[discarded] `repo/`: changes left in it after setup failed in `web/` were discarded, since they could " +
    "not be told apart from what the failed step did, and the run went on.",
    "[invalid] `repo/`: `.ryph/setup.yml` is invalid, so none of its steps ran, and the run went on.\n" +
    "setup.yml: unknown key `step`",
  ]);
});

test("what a finished setup left in the tree is reported as discarded, naming the files", async () => {
  const { handler, store, launches } = buildApp();
  const agent = await createAgent(handler);
  const { runId } = await (await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC }))
    .json();
  const runnerToken = (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN;
  const res = await post(handler, `/v1/runs/${runId}/setup/failed`, {
    failures: [
      // A file name past any the runner sends drops that entry, never the report (kept, it
      // would be the repo's one `dirty` warning).
      { kind: "dirty", path: "repo", files: ["x".repeat(513)] },
      { kind: "dirty", path: "repo", files: ["package-lock.json", "gen/\u0007x.ts"] },
    ],
  }, runnerToken);
  assertEquals(res.status, 204);
  const events = (await store.listEvents(runId)).filter((e) => e.kind === "setup.failed");
  assertEquals(events.map((e) => e.detail), [
    "[dirty] `repo/`: setup.yml finished but left changes in the tree (`package-lock.json`, " +
    "`gen/x.ts`), which were discarded so they do not ship as work — add build output to " +
    ".gitignore — and the run went on.",
  ]);
});

test("an invalid setup.yml is reported as its own warning, naming the file's error", async () => {
  const { handler, store, launches } = buildApp();
  const agent = await createAgent(handler);
  const { runId } = await (await post(handler, "/v1/tasks", { agentId: agent.id, ...TASK_SPEC }))
    .json();
  const runnerToken = (await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN;
  const res = await post(handler, `/v1/runs/${runId}/setup/failed`, {
    failures: [{ kind: "invalid", path: "repo", error: "setup.yml: unknown key `step`" }],
  }, runnerToken);
  assertEquals(res.status, 204);
  const events = (await store.listEvents(runId)).filter((e) => e.kind === "setup.failed");
  assertEquals(
    events.map((e) => e.detail),
    [
      "[invalid] `repo/`: `.ryph/setup.yml` is invalid, so none of its steps ran, and the run " +
      "went on.\nsetup.yml: unknown key `step`",
    ],
  );
});

test("the images routes answer a 503 with the reason when the docker launcher does not answer", async () => {
  const lost = () => Promise.reject(new Error("the launcher did not answer /v1/prefetch/status"));
  const { handler } = buildApp({ imagePrefetch: { status: lost, start: lost } });
  for (
    const res of [await get(handler, "/v1/images"), await post(handler, "/v1/images/pull", {})]
  ) {
    assertEquals(res.status, 503);
    assertStringIncludes((await res.json()).error, "did not answer");
  }
});

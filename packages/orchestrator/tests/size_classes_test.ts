// Size classes over HTTP, with no GitHub anywhere: who may set a repo's or a workspace's class,
// what the settings form is offered, and which class a run's LaunchSpec actually carries.

import { test } from "bun:test";
import { capsClaimOf, type Role } from "@ryph/auth";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";
import { parseRunSizes, type RunSizes } from "../src/core/run_sizes.ts";
import {
  fakeClock,
  fakeIdentityDirectory,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";

const USER = {
  kind: "user",
  userId: "u-1",
  email: "ada@example.com",
  name: "Ada",
  emailVerified: true,
  sid: "s-1",
  via: "session",
} as const;
const API = {
  fullName: "acme/api",
  url: "https://github.com/acme/api.git",
  defaultBranch: "main",
  private: true,
};
const WEB = {
  fullName: "acme/web",
  url: "https://github.com/acme/web.git",
  defaultBranch: "main",
  private: true,
};

function sizesOf(spec: string, defaultName?: string): RunSizes {
  const parsed = parseRunSizes(spec, defaultName);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.sizes;
}

const TWO_SIZES = sizesOf(
  "standard:cpu=4,memory=8Gi,ephemeral-storage=10Gi;" +
    "large:cpu=8,memory=16Gi,ephemeral-storage=10Gi,work-volume=50Gi",
);

function buildApp(
  opts: { runSizes?: RunSizes; store?: ReturnType<typeof memoryTaskStore> } = {},
) {
  const store = opts.store ?? memoryTaskStore();
  const { provisioner, launches } = fakeProvisioner();
  const identities = fakeIdentityDirectory();
  // The platform role, switchable mid-test. The forge answers "allowed" throughout, so a user
  // here is a repo ADMIN — which is exactly the caller a size class must still refuse.
  let role: Role = "owner";
  const forge = noopForge(silentDiagnostics(), { permission: "allowed", repos: [API, WEB] });
  const handler = makeHandler({
    store,
    provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate: (() =>
      Promise.resolve({ ...USER, caps: capsClaimOf(role) })) as unknown as Authenticate,
    forgeToken: "forge-service-token",
    forge,
    githubConnect: forge,
    identityDirectory: identities.directory,
    now: fakeClock().now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig({ runSizes: opts.runSizes ?? TWO_SIZES }),
      gitGateway: { url: "http://gateway.test:7412", keyTtlMs: 60 * 60 * 1000 },
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
  identities.link(USER.userId, "noop-ada-lovelace");
  return { handler, store, launches, setRole: (r: Role) => (role = r) };
}

type Handler = (req: Request) => Promise<Response>;
const call = (handler: Handler, method: string, path: string, body?: unknown) =>
  handler(
    new Request(`http://orchestrator.test${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

/** An installation, two connected repos, an echo agent, and a workspace holding both repos. */
async function prepare(app: ReturnType<typeof buildApp>) {
  assertEquals(
    (await call(app.handler, "POST", "/v1/installations", { installationId: "42" })).status,
    201,
  );
  const connect = async (repoRef: string) =>
    await (await call(app.handler, "POST", "/v1/connected-repos", {
      installationId: "42",
      repoRef,
    })).json();
  const api = await connect(API.fullName);
  const web = await connect(WEB.fullName);
  const agent = await (await call(app.handler, "POST", "/v1/agents", {
    name: "Ada",
    email: "ada@example.com",
    harnessKind: "echo",
  })).json();
  const { workspace } = await (await call(app.handler, "POST", "/v1/workspaces", {
    name: "Shop",
  })).json();
  for (const repo of [api, web]) {
    assertEquals(
      (await call(app.handler, "POST", `/v1/workspaces/${workspace.id}/repos`, {
        connectedRepoId: repo.id,
      })).status,
      201,
    );
  }
  return { api, web, agent, workspace };
}

const TASK = { title: "Build it", instructions: "Run the checks." };

test("GET /v1/run-sizes lists the configured classes and marks the default", async () => {
  const app = buildApp({ runSizes: sizesOf("small:cpu=1;large:cpu=8,work-volume=50Gi", "large") });
  app.setRole("member"); // read-anybody: the form needs it before anyone may change a thing
  const res = await call(app.handler, "GET", "/v1/run-sizes");
  assertEquals(res.status, 200);
  assertEquals((await res.json()).sizes, [
    {
      name: "small",
      cpu: "1",
      memory: null,
      ephemeralStorage: null,
      workVolume: null,
      default: false,
    },
    {
      name: "large",
      cpu: "8",
      memory: null,
      ephemeralStorage: null,
      workVolume: "50Gi",
      default: true,
    },
  ]);
});

test("a repo's size class is a platform admin's call, and only to a configured class", async () => {
  const app = buildApp();
  const { api } = await prepare(app);
  assertEquals(api.sizeClass, null, "a freshly connected repo is on the default");

  // A repo admin (the forge says "allowed") is still not the one who pays.
  app.setRole("member");
  const refused = await call(app.handler, "PATCH", `/v1/connected-repos/${api.id}`, {
    sizeClass: "large",
  });
  assertEquals(refused.status, 403);
  assertEquals((await refused.json()).code, "forbidden");
  // …while the submission policy stays theirs, and moving it leaves the class alone.
  const policy = await call(app.handler, "PATCH", `/v1/connected-repos/${api.id}`, {
    submissionPolicy: "auto",
  });
  assertEquals(policy.status, 200);
  assertEquals((await policy.json()).sizeClass, null);

  app.setRole("owner");
  const unknown = await call(app.handler, "PATCH", `/v1/connected-repos/${api.id}`, {
    sizeClass: "huge",
  });
  assertEquals(unknown.status, 400);
  const unknownBody = await unknown.json();
  assertStringIncludes(unknownBody.error, "RYPH_RUN_SIZES");
  assertEquals(unknownBody.knownClasses, ["standard", "large"]);

  const set = await call(app.handler, "PATCH", `/v1/connected-repos/${api.id}`, {
    sizeClass: "large",
  });
  assertEquals(set.status, 200);
  const updated = await set.json();
  assertEquals(updated.sizeClass, "large");
  assertEquals(updated.submissionPolicy, "auto", "the class moved alone");
  assertEquals((await app.store.getConnectedRepo(api.id))!.sizeClass, "large");

  // Null goes back to the default; an empty body is a mistake, not a no-op.
  const cleared = await call(app.handler, "PATCH", `/v1/connected-repos/${api.id}`, {
    sizeClass: null,
  });
  assertEquals((await cleared.json()).sizeClass, null);
  assertEquals((await call(app.handler, "PATCH", `/v1/connected-repos/${api.id}`, {})).status, 400);
});

test("a workspace's size class is gated the same way, on top of managing the workspace", async () => {
  const app = buildApp();
  const { workspace } = await prepare(app);

  // Admin on every member (the forge says so) is enough to rename it, not to size it.
  app.setRole("member");
  const renamed = await call(app.handler, "PATCH", `/v1/workspaces/${workspace.id}`, {
    name: "Storefront",
  });
  assertEquals(renamed.status, 200);
  const refused = await call(app.handler, "PATCH", `/v1/workspaces/${workspace.id}`, {
    name: "Storefront 2",
    sizeClass: "large",
  });
  assertEquals(refused.status, 403);
  assertEquals((await refused.json()).code, "forbidden");
  assertEquals((await app.store.getWorkspace(workspace.id))!.name, "Storefront", "all or nothing");

  app.setRole("owner");
  assertEquals(
    (await call(app.handler, "PATCH", `/v1/workspaces/${workspace.id}`, { sizeClass: "huge" }))
      .status,
    400,
  );
  const set = await call(app.handler, "PATCH", `/v1/workspaces/${workspace.id}`, {
    sizeClass: "large",
  });
  assertEquals(set.status, 200);
  assertEquals((await set.json()).workspace.sizeClass, "large");
  assertEquals((await app.store.getWorkspace(workspace.id))!.name, "Storefront");
});

test("a run carries its subject's class: the repo's alone, the workspace's for a workspace", async () => {
  const app = buildApp();
  const { api, agent, workspace } = await prepare(app);

  // The repo is large, the workspace holding it is not: which one a run gets depends only on
  // what the task checks out.
  await call(app.handler, "PATCH", `/v1/connected-repos/${api.id}`, { sizeClass: "large" });
  const alone = await call(app.handler, "POST", "/v1/tasks", {
    agentId: agent.id,
    spec: TASK,
    connectedRepoId: api.id,
  });
  assertEquals(alone.status, 201);
  assertEquals(app.launches.at(-1)!.size.name, "large");
  assertEquals(app.launches.at(-1)!.size.workVolume, "50Gi");
  const { runId, taskId } = await alone.json();
  const frozenSize = app.launches.at(-1)!.size;
  assertEquals((await app.store.getRun(runId))!.workItem.runSize, frozenSize);
  await call(app.handler, "PATCH", `/v1/connected-repos/${api.id}`, { sizeClass: "standard" });
  const detail = await (await call(app.handler, "GET", `/v1/tasks/${taskId}`)).json();
  assertEquals(
    detail.runs.find((run: { id: string }) => run.id === runId).workItem.runSize,
    frozenSize,
  );

  const together = await call(app.handler, "POST", "/v1/tasks", {
    agentId: agent.id,
    spec: TASK,
    workspaceId: workspace.id,
  });
  assertEquals(together.status, 201);
  assertEquals(app.launches.at(-1)!.size.name, "standard", "the workspace's default, not api's");

  await call(app.handler, "PATCH", `/v1/workspaces/${workspace.id}`, { sizeClass: "large" });
  await call(app.handler, "POST", "/v1/tasks", {
    agentId: agent.id,
    spec: TASK,
    workspaceId: workspace.id,
  });
  assertEquals(app.launches.at(-1)!.size.name, "large");
});

test("a class the operator stopped defining degrades to the default, and the run says so", async () => {
  const before = buildApp();
  const { api, agent } = await prepare(before);
  await call(before.handler, "PATCH", `/v1/connected-repos/${api.id}`, { sizeClass: "large" });

  // Redeployed with `large` renamed away: the stored name is stale.
  const after = buildApp({ runSizes: sizesOf("standard:cpu=4"), store: before.store });
  const created = await call(after.handler, "POST", "/v1/tasks", {
    agentId: agent.id,
    spec: TASK,
    connectedRepoId: api.id,
  });
  assertEquals(created.status, 201, "never refused over a renamed class");
  const { runId } = await created.json();
  assertEquals(after.launches.at(-1)!.size.name, "standard");
  const events = await after.store.listEvents(runId);
  const stale = events.find((e) => e.kind === "size-class-unknown");
  assert(stale !== undefined, "the trail records it");
  assertStringIncludes(stale.detail!, '"large"');
});

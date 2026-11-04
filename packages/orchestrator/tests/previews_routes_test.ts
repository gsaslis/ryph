// Hosted previews, both doors, against a fake previews service on a real loopback socket: the
// runner registers a port with its own run token and is handed the tunnel URL; people who can
// read the run list its previews and open one. A concluded run takes no registration and lists
// nothing; the run's egress decides what the preview's CSP may reach; a run the caller cannot
// read is a 404, exactly as an unknown one.

import { test } from "bun:test";
import { capsClaimOf } from "@ryph/auth";
import { serve } from "@ryph/service";
import { assertEquals } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { httpPreviews } from "../src/adapters/previews/http.ts";
import { concludeOnTerminal } from "../src/conclude_on_terminal.ts";
import { MAX_PREVIEW_BODY_BYTES, MAX_PREVIEW_PATH } from "../src/http/previews_api.ts";
import { bootstrapEnv } from "./bootstrap_helpers.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import { makeInboxSignal } from "../src/core/inbox_signal.ts";
import type { PreviewsService } from "../src/ports/previews.ts";
import {
  fakeClock,
  fakeIdentityDirectory,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";

const MEMBER = {
  kind: "user",
  userId: "u-1",
  email: "ada@example.com",
  name: "Ada",
  caps: capsClaimOf("member"),
  emailVerified: true,
  sid: "s-1",
  via: "session",
} as const;
const STRANGER = {
  ...MEMBER,
  userId: "u-2",
  email: "eve@example.com",
  caps: capsClaimOf("viewer"),
};
const OPERATOR = { ...STRANGER, caps: capsClaimOf("operator") };

const PREVIEW_ID = "0123456789abcdef0123456789abcdef";
const PREVIEW_URL = `https://${PREVIEW_ID}.preview.ryph-previews.example`;

interface Seen {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

/** The previews service's internal surface, as far as the control plane can tell. */
async function fakePreviewsService() {
  const seen: Seen[] = [];
  const answers = {
    register: () =>
      Response.json({ id: PREVIEW_ID, url: PREVIEW_URL, ticket: "tk/1" }, { status: 201 }),
    list: () =>
      Response.json({ previews: [{ id: PREVIEW_ID, port: 5173, label: "App", url: PREVIEW_URL }] }),
    viewer: () => Response.json({ url: `${PREVIEW_URL}/__ryph/enter?ticket=v1` }),
    lookup: () => Response.json({ error: "not found" }, { status: 404 }),
  };
  const server = await serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req) => {
      const { pathname } = new URL(req.url);
      const text = await req.text();
      seen.push({
        method: req.method,
        path: pathname,
        auth: req.headers.get("authorization"),
        body: text === "" ? null : JSON.parse(text),
      });
      if (req.method === "POST" && pathname === "/internal/previews") return answers.register();
      if (req.method === "GET" && pathname.endsWith("/previews")) return answers.list();
      if (req.method === "POST" && pathname.endsWith("/viewer")) return answers.viewer();
      if (req.method === "GET" && pathname.startsWith("/internal/previews/")) {
        return answers.lookup();
      }
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  );
  return { server, seen, answers, url: `http://127.0.0.1:${server.addr.port}` };
}

type ScopeFixture = { mode: "proxy" | "open"; bundles: string[]; hosts: string[] };

function buildApp(previews: PreviewsService | null, scope?: ScopeFixture) {
  const store = memoryTaskStore();
  const createTask = store.createTask;
  store.createTask = (task, run) => {
    if (scope) run.networkScope = scope;
    return createTask(task, run);
  };
  const { provisioner, launches } = fakeProvisioner();
  const identities = fakeIdentityDirectory();
  const { control } = fakeRunnerControl();
  const forge = noopForge(silentDiagnostics(), {
    permission: "allowed",
    repos: [{
      fullName: "acme/app",
      url: "https://github.com/acme/app.git",
      defaultBranch: "main",
      private: true,
    }],
  });
  const caller = {
    principal: MEMBER as typeof MEMBER | typeof STRANGER | typeof OPERATOR,
  };
  const handler = makeHandler({
    store,
    provisioner,
    runnerControl: control,
    diag: silentDiagnostics(),
    authenticate: (() => Promise.resolve(caller.principal)) as unknown as Authenticate,
    forge,
    githubConnect: forge,
    identityDirectory: identities.directory,
    inbox: makeInboxSignal(),
    previews,
    now: fakeClock().now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
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
      platformTools: { webServerId: "ms-platform-web", web: false, forge: null, pending: false },
    },
  });
  return { handler, store, caller, launches, identities };
}

type App = ReturnType<typeof buildApp>;
const BASE = "http://orchestrator.test";

const send = (app: App, method: string, path: string, body: unknown, token = "t") =>
  app.handler(
    new Request(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const made = new WeakMap<App, { repo: { id: string }; agent: { id: string } }>();

/** A live run on a connected repo, and its runner token. */
async function liveRun(app: App) {
  if (made.get(app) === undefined) {
    app.identities.link(MEMBER.userId, "noop-ada-lovelace");
    await send(app, "POST", "/v1/installations", { installationId: "42" });
    const repo = await (await send(app, "POST", "/v1/connected-repos", {
      installationId: "42",
      repoRef: "acme/app",
    })).json();
    const agent = await (await send(app, "POST", "/v1/agents", {
      name: "Ada",
      email: "ada@example.com",
      harnessKind: "echo",
    })).json();
    made.set(app, { repo, agent });
  }
  const { repo, agent } = made.get(app)!;
  const created = await send(app, "POST", "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Build it", instructions: "Serve the app" },
    connectedRepoId: repo.id,
  });
  assertEquals(created.status, 201);
  const { runId } = await created.json();
  const runToken = (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN;
  return { runId, runToken };
}

async function withService(
  fn: (
    app: App,
    service: Awaited<ReturnType<typeof fakePreviewsService>>,
    run: { runId: string; runToken: string },
  ) => Promise<void>,
  scope?: ScopeFixture,
) {
  const service = await fakePreviewsService();
  try {
    const app = buildApp(
      httpPreviews({
        previewsUrl: service.url,
        tunnelUrl: "http://previews-tunnel.test:7491",
        previewsToken: "pv-token",
        diag: silentDiagnostics(),
      }),
      scope,
    );
    await fn(app, service, await liveRun(app));
  } finally {
    await service.server.shutdown();
  }
}

const conclude = async (app: App, runId: string) => {
  const run = (await app.store.getRun(runId))!;
  await app.store.saveRunResult({ ...run, state: "succeeded" });
};

test("the runner probes and registers; it is handed the ws tunnel URL", async () => {
  await withService(async (app, service, { runId, runToken }) => {
    const probe = await send(app, "GET", `/v1/runs/${runId}/runner/previews`, undefined, runToken);
    assertEquals([probe.status, await probe.json()], [200, { enabled: true }]);

    const res = await send(
      app,
      "POST",
      `/v1/runs/${runId}/runner/previews`,
      { port: 5173, label: "  App  " },
      runToken,
    );
    assertEquals(res.status, 201);
    assertEquals(await res.json(), {
      id: PREVIEW_ID,
      port: 5173,
      label: "App",
      url: PREVIEW_URL,
      // On the tunnel listener, never the API one the control plane calls.
      tunnel: "ws://previews-tunnel.test:7491/tunnel/tk%2F1",
      // Whoever can see the run opens it, so the runner says so to the agent.
      audience: "run",
    });
    assertEquals(service.seen, [{
      method: "POST",
      path: "/internal/previews",
      auth: "Bearer pv-token",
      body: { runId, port: 5173, label: "App", hosts: ["registry.npmjs.org", "*.github.com"] },
    }]);
  }, { mode: "proxy", bundles: [], hosts: ["registry.npmjs.org", "*.github.com"] });
});

test("a run whose egress is open registers with hosts null", async () => {
  await withService(async (app, service, { runId, runToken }) => {
    const res = await send(
      app,
      "POST",
      `/v1/runs/${runId}/runner/previews`,
      { port: 3000, label: "Docs" },
      runToken,
    );
    assertEquals(res.status, 201);
    assertEquals((service.seen[0].body as { hosts: unknown }).hosts, null);
  }, { mode: "open", bundles: [], hosts: ["ignored.example"] });
});

test("the runner door takes only the run's own bearer, for the run in the path", async () => {
  await withService(async (app, service, { runId, runToken }) => {
    const other = await liveRun(app);
    const body = { port: 5173, label: "App" };
    for (
      const [path, token] of [
        [`/v1/runs/${runId}/runner/previews`, "wrong"],
        [`/v1/runs/${runId}/runner/previews`, other.runToken],
        [`/v1/runs/r-nope/runner/previews`, runToken],
      ]
    ) {
      assertEquals((await send(app, "GET", path, undefined, token)).status, 401);
      assertEquals((await send(app, "POST", path, body, token)).status, 401);
    }
    assertEquals(service.seen.length, 0);
  });
});

test("a registration is held to its shape before it reaches the service", async () => {
  await withService(async (app, service, { runId, runToken }) => {
    const path = `/v1/runs/${runId}/runner/previews`;
    for (
      const body of [
        { port: 80, label: "App" },
        { port: 70000, label: "App" },
        { port: 5173.5, label: "App" },
        { port: "5173", label: "App" },
        { port: 5173, label: "   " },
        { port: 5173, label: "x".repeat(81) },
        { port: 5173 },
        "not json",
        JSON.stringify({ port: 5173, label: "x".repeat(MAX_PREVIEW_BODY_BYTES) }),
      ]
    ) {
      assertEquals((await send(app, "POST", path, body, runToken)).status, 400);
    }
    assertEquals(service.seen.length, 0);
  });
});

test("the service's 400 and 429 reach the runner as sent; anything else is a 502", async () => {
  await withService(async (app, service, { runId, runToken }) => {
    const path = `/v1/runs/${runId}/runner/previews`;
    const body = { port: 5173, label: "App" };
    service.answers.register = () =>
      Response.json({ error: "preview limit reached" }, { status: 429 });
    const limited = await send(app, "POST", path, body, runToken);
    assertEquals([limited.status, await limited.json()], [429, { error: "preview limit reached" }]);

    service.answers.register = () => Response.json({ error: "bad label" }, { status: 400 });
    const refused = await send(app, "POST", path, body, runToken);
    assertEquals([refused.status, await refused.json()], [400, { error: "bad label" }]);

    service.answers.register = () => Response.json({ error: "boom" }, { status: 500 });
    assertEquals((await send(app, "POST", path, body, runToken)).status, 502);
    service.answers.register = () => Response.json({ id: PREVIEW_ID }, { status: 201 });
    assertEquals((await send(app, "POST", path, body, runToken)).status, 502);
  });
});

test("an unreachable service is a 502 on every door", async () => {
  const app = buildApp(
    httpPreviews({
      // Nothing listens on port 9 of loopback.
      previewsUrl: "http://127.0.0.1:9",
      tunnelUrl: "http://127.0.0.1:9",
      previewsToken: "pv-token",
      diag: silentDiagnostics(),
    }),
  );
  const { runId, runToken } = await liveRun(app);
  const register = await send(
    app,
    "POST",
    `/v1/runs/${runId}/runner/previews`,
    { port: 5173, label: "App" },
    runToken,
  );
  assertEquals(register.status, 502);
  assertEquals((await send(app, "GET", `/v1/runs/${runId}/previews`, undefined)).status, 502);
  assertEquals(
    (await send(app, "POST", `/v1/runs/${runId}/previews/${PREVIEW_ID}/open`, undefined)).status,
    502,
  );
});

test("once the run concluded: the runner gets 410, the list is empty unasked, open is 410", async () => {
  await withService(async (app, service, { runId, runToken }) => {
    await conclude(app, runId);
    const path = `/v1/runs/${runId}/runner/previews`;
    assertEquals((await send(app, "GET", path, undefined, runToken)).status, 410);
    assertEquals(
      (await send(app, "POST", path, { port: 5173, label: "App" }, runToken)).status,
      410,
    );
    const list = await send(app, "GET", `/v1/runs/${runId}/previews`, undefined);
    assertEquals([list.status, await list.json()], [200, { previews: [] }]);
    const open = await send(app, "POST", `/v1/runs/${runId}/previews/${PREVIEW_ID}/open`, {});
    assertEquals(open.status, 410);
    assertEquals(service.seen.length, 0);
  });
});

test("people who can read the run list its previews and open one", async () => {
  await withService(async (app, service, { runId }) => {
    const list = await send(app, "GET", `/v1/runs/${runId}/previews`, undefined);
    assertEquals(list.status, 200);
    assertEquals(await list.json(), {
      previews: [{ id: PREVIEW_ID, port: 5173, label: "App", url: PREVIEW_URL }],
    });
    assertEquals(service.seen.at(-1)!.path, `/internal/runs/${runId}/previews`);

    const open = await send(app, "POST", `/v1/runs/${runId}/previews/${PREVIEW_ID}/open`, {});
    assertEquals(open.status, 200);
    assertEquals(open.headers.get("cache-control"), "no-store");
    assertEquals(await open.json(), { url: `${PREVIEW_URL}/__ryph/enter?ticket=v1` });
    assertEquals(service.seen.at(-1), {
      method: "POST",
      path: `/internal/previews/${PREVIEW_ID}/viewer`,
      auth: "Bearer pv-token",
      body: { runId },
    });

    // Where the link pointed: passed on for the service to judge, or dropped when it cannot be one.
    const opening = `/v1/runs/${runId}/previews/${PREVIEW_ID}/open`;
    const deep = "/nodes/oak.radicle.garden?tab=1";
    const withPath = await send(app, "POST", `${opening}?path=${encodeURIComponent(deep)}`, {});
    assertEquals(withPath.status, 200);
    assertEquals(service.seen.at(-1)!.body, { runId, path: deep });
    for (const query of [`?path=/${"a".repeat(MAX_PREVIEW_PATH)}`, "?path="]) {
      assertEquals((await send(app, "POST", `${opening}${query}`, {})).status, 200);
      assertEquals(service.seen.at(-1)!.body, { runId });
    }
    const longest = `/${"a".repeat(MAX_PREVIEW_PATH - 1)}`;
    await send(app, "POST", `${opening}?path=${longest}`, {});
    assertEquals(service.seen.at(-1)!.body, { runId, path: longest });

    service.answers.viewer = () => Response.json({ error: "not found" }, { status: 404 });
    const missing = await send(app, "POST", `/v1/runs/${runId}/previews/${PREVIEW_ID}/open`, {});
    assertEquals(missing.status, 404);
  });
});

test("the user door is the run's read gate: a run the caller cannot see is a 404", async () => {
  await withService(async (app, service, { runId }) => {
    app.caller.principal = STRANGER;
    assertEquals((await send(app, "GET", `/v1/runs/${runId}/previews`, undefined)).status, 404);
    assertEquals(
      (await send(app, "POST", `/v1/runs/${runId}/previews/${PREVIEW_ID}/open`, {})).status,
      404,
    );
    assertEquals((await send(app, "GET", `/v1/runs/r-nope/previews`, undefined)).status, 404);
    assertEquals(service.seen.length, 0);

    // Reading every run is a capability, and it reads this one.
    app.caller.principal = OPERATOR;
    assertEquals((await send(app, "GET", `/v1/runs/${runId}/previews`, undefined)).status, 200);

    // No `tasks:read` at all is refused outright.
    app.caller.principal = { ...MEMBER, caps: [] } as unknown as typeof MEMBER;
    assertEquals((await send(app, "GET", `/v1/runs/${runId}/previews`, undefined)).status, 403);
  });
});

test("a preview opens by its id alone, through exactly the run's read gate", async () => {
  await withService(async (app, service, { runId }) => {
    const byId = (id = PREVIEW_ID, query = "") =>
      send(app, "POST", `/v1/previews/${id}/open${query}`, undefined);
    // The service knows the preview: the caller may read its run, so in they go, landing where
    // the link pointed. The run's id is not in the answer.
    service.answers.lookup = () => Response.json({ runId });
    const deep = "/nodes/x?y=1";
    const open = await byId(PREVIEW_ID, `?path=${encodeURIComponent(deep)}`);
    assertEquals(open.status, 200);
    assertEquals(open.headers.get("cache-control"), "no-store");
    const answer = await open.json();
    assertEquals(answer, { url: `${PREVIEW_URL}/__ryph/enter?ticket=v1` });
    assertEquals(service.seen.slice(-2), [
      {
        method: "GET",
        path: `/internal/previews/${PREVIEW_ID}`,
        auth: "Bearer pv-token",
        body: null,
      },
      {
        method: "POST",
        path: `/internal/previews/${PREVIEW_ID}/viewer`,
        auth: "Bearer pv-token",
        body: { runId, path: deep },
      },
    ]);

    // A caller who may not read the run learns nothing: a 404 like an unknown preview, and no
    // ticket is asked for.
    app.caller.principal = STRANGER;
    const asked = service.seen.length;
    const hidden = await byId();
    assertEquals(hidden.status, 404);
    assertEquals(await hidden.json(), { error: "no such preview" });
    assertEquals(service.seen.slice(asked).map((s) => s.path), [
      `/internal/previews/${PREVIEW_ID}`,
    ]);
    // Without `tasks:read` at all, refused before the service is asked anything.
    app.caller.principal = { ...MEMBER, caps: [] } as unknown as typeof MEMBER;
    const before = service.seen.length;
    assertEquals((await byId()).status, 403);
    assertEquals(service.seen.length, before);
    app.caller.principal = MEMBER;

    // Not a preview id at all: a 404, the service not asked.
    for (const id of ["nope", PREVIEW_ID.toUpperCase(), `${PREVIEW_ID}0`, "..%2F..%2Fx"]) {
      const count = service.seen.length;
      assertEquals((await byId(id)).status, 404, id);
      assertEquals(service.seen.length, count);
    }
    // One the service does not know, or a service that does not answer.
    service.answers.lookup = () => Response.json({ error: "not found" }, { status: 404 });
    assertEquals((await byId()).status, 404);
    service.answers.lookup = () => Response.json({}, { status: 500 });
    assertEquals((await byId()).status, 502);
    // A run that ended: 410, as by its run.
    service.answers.lookup = () => Response.json({ runId });
    await conclude(app, runId);
    const viewers = service.seen.filter((s) => s.path.endsWith("/viewer")).length;
    assertEquals((await byId()).status, 410);
    assertEquals(service.seen.filter((s) => s.path.endsWith("/viewer")).length, viewers);
  });
});

test("without a previews service nothing is mounted: the runner's probe is a 404", async () => {
  const app = buildApp(null);
  const { runId, runToken } = await liveRun(app);
  assertEquals(
    (await send(app, "GET", `/v1/runs/${runId}/runner/previews`, undefined, runToken)).status,
    404,
  );
  assertEquals((await send(app, "GET", `/v1/runs/${runId}/previews`, undefined)).status, 404);
});

test("a run reaching a terminal state closes its previews through the conclude hook", async () => {
  const service = await fakePreviewsService();
  try {
    const previews = httpPreviews({
      previewsUrl: service.url,
      tunnelUrl: "http://previews-tunnel.test:7491",
      previewsToken: "pv-token",
      diag: silentDiagnostics(),
    });
    const store = concludeOnTerminal(memoryTaskStore(), (runId) => previews.closeRun(runId));
    const inner = buildApp(null);
    const { runId } = await liveRun(inner);
    const run = (await inner.store.getRun(runId))!;
    await store.saveRun({ ...run, state: "running" });
    await store.saveRunResult({ ...run, state: "succeeded" });
    for (let i = 0; i < 100 && service.seen.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(service.seen, [{
      method: "DELETE",
      path: `/internal/runs/${runId}`,
      auth: "Bearer pv-token",
      body: null,
    }]);
  } finally {
    await service.server.shutdown();
  }
});

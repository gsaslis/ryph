import { test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// The browser end to end through the HTTP handler: the agent switch, what the agent form is told
// the deployment can do, and what a run is granted — frozen onto its work item and handed to the
// provisioner — or, where it cannot be, the note the run carries instead.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { makeHandler } from "../src/http/app.ts";
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
import { DEFAULT_SERVICE_POLICY, resolveServices } from "../src/core/services.ts";
import type { Provisioner } from "../src/ports/provisioner.ts";
import {
  BROWSER_PORT,
  type BrowserConfig,
  browserConfigFromEnv,
  browserGrant,
  browserPosture,
} from "../src/core/browser.ts";

const BREAK_GLASS = { kind: "break-glass" } as const;
const BROWSER: BrowserConfig = { image: "ryph-browser:test", cpus: "1", memory: "1536Mi" };
const PI_AGENT = { name: "Ada", email: "ada@example.com", harnessKind: "pi" };
const TASK = {
  spec: { title: "Check the page", instructions: "Open it and look." },
  connectedRepoId: LOCAL_REPO.id,
};

function buildApp(
  opts: {
    browser?: BrowserConfig | null;
    supportsBrowser?: boolean;
    browserRefusal?: Provisioner["browserRefusal"];
    provisionerKind?: string;
  } = {},
) {
  const store = memoryTaskStore();
  // The memory store writes synchronously, so the seed is in before the first request.
  void store.createConnectedRepo(LOCAL_REPO);
  const { provisioner, launches } = fakeProvisioner({
    supportsBrowser: opts.supportsBrowser ?? true,
    browserRefusal: opts.browserRefusal,
  });
  const handler = makeHandler({
    store,
    provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate: () => Promise.resolve(BREAK_GLASS),
    modelAccess: null,
    toolAccess: null,
    forgeToken: null,
    now: fakeClock().now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig({ browser: opts.browser === undefined ? BROWSER : opts.browser }),
      ...(opts.provisionerKind === undefined ? {} : { provisionerKind: opts.provisionerKind }),
      gitGateway: TEST_GATEWAY,
      runHistoryUrl: null,
      appUrl: null,
      services: DEFAULT_SERVICE_POLICY,
      egress: {
        policy: { mode: "proxy", bundles: [], hosts: [], proxyUrl: null },
        key: null,
        tokenTtlMs: 0,
      },
      platformMemoryServerId: null,
      platformChatServerId: null,
      platformTools: { webServerId: "ms-platform-web", web: false, forge: null, pending: false },
    },
  });
  const call = (method: string, path: string, body?: unknown) =>
    handler(
      new Request(`http://orchestrator.test${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return { call, store, launches, handler };
}

test("browserEnabled: off by default, set on create, moved by an edit, kept by one that omits it", async () => {
  const { call } = buildApp();
  const plain = await (await call("POST", "/v1/agents", PI_AGENT)).json();
  assertEquals(plain.browserEnabled, false);

  const res = await call("POST", "/v1/agents", { ...PI_AGENT, browserEnabled: true });
  assertEquals(res.status, 201);
  const agent = await res.json();
  assertEquals(agent.browserEnabled, true);

  // An edit that does not name it leaves it where it was.
  const renamed = await (await call("PATCH", `/v1/agents/${agent.id}`, { name: "Ada L." })).json();
  assertEquals(renamed.browserEnabled, true);
  const off = await (await call("PATCH", `/v1/agents/${agent.id}`, { browserEnabled: false }))
    .json();
  assertEquals(off.browserEnabled, false);
  assertEquals((await (await call("GET", `/v1/agents/${agent.id}`)).json()).browserEnabled, false);

  // Not a boolean: refused like any malformed field.
  assertEquals(
    (await call("POST", "/v1/agents", { ...PI_AGENT, browserEnabled: "yes" })).status,
    400,
  );
});

test("GET /v1/harnesses says, per kind, whether an agent on it can be given a browser here", async () => {
  const byKind = async (app: ReturnType<typeof buildApp>) =>
    Object.fromEntries(
      ((await (await app.call("GET", "/v1/harnesses")).json()).harnesses as Array<
        { kind: string; browser: boolean }
      >).map((h) => [h.kind, h.browser]),
    );
  // On: pi has the MCP client a browser is driven through; echo has none.
  assertEquals(await byKind(buildApp()), { pi: true, echo: false });
  // No image, or a provisioner that cannot launch one: no kind can.
  assertEquals(await byKind(buildApp({ browser: null })), { pi: false, echo: false });
  assertEquals(await byKind(buildApp({ supportsBrowser: false })), { pi: false, echo: false });
});

test("GET /v1/harnesses says why a kind cannot have a browser, so the form can", async () => {
  const reasons = async (app: ReturnType<typeof buildApp>) =>
    Object.fromEntries(
      ((await (await app.call("GET", "/v1/harnesses")).json()).harnesses as Array<
        { kind: string; browserUnavailable: string | null; provisioner: string | null }
      >).map((h) => [h.kind, [h.browserUnavailable, h.provisioner]]),
    );
  assertEquals(await reasons(buildApp({ provisionerKind: "docker" })), {
    pi: [null, "docker"],
    echo: ["harness", "docker"],
  });
  // No image on a backend that could launch one.
  assertEquals((await reasons(buildApp({ browser: null, provisionerKind: "docker" }))).pi, [
    "image",
    "docker",
  ]);
  // A backend that cannot launch one wins over a missing image: an image would not help it.
  assertEquals(
    (await reasons(
      buildApp({ browser: null, supportsBrowser: false, provisionerKind: "manual" }),
    )).pi,
    ["provisioner", "manual"],
  );
  // Unknown where the composition root did not say.
  assertEquals((await reasons(buildApp())).pi, [null, null]);
});

test("a browser agent's run is granted the sidecar: frozen on its work item, handed to the provisioner", async () => {
  const { call, store, launches, handler } = buildApp();
  const agent = await (await call("POST", "/v1/agents", { ...PI_AGENT, browserEnabled: true }))
    .json();
  const { runId } = await (await call("POST", "/v1/tasks", { agentId: agent.id, ...TASK })).json();
  const run = await store.getRun(runId);
  assertEquals(run!.workItem.browser, { port: BROWSER_PORT });
  assertEquals(launches[0].browser, {
    image: "ryph-browser:test",
    port: 7490,
    resources: { cpu: "1", memory: "1536Mi" },
  });
  // The runner fetches the work item back with the grant on it.
  const spec = await (await handler(
    new Request(`http://orchestrator.test/v1/runs/${runId}/spec`, {
      headers: {
        authorization: `Bearer ${(await bootstrapEnv(handler, launches[0].env)).RYPH_RUN_TOKEN}`,
      },
    }),
  )).json();
  assertEquals(spec.workItem.browser, { port: 7490 });
  assertEquals(
    (await store.listEvents(runId)).filter((e) => e.kind === "browser.unavailable"),
    [],
  );
  // The run page reads the grant off the task detail, history or no history.
  const taskOf = async (id: string) =>
    await (await call("GET", `/v1/tasks/${(await store.getRun(id))!.taskId}`)).json();
  assertEquals((await taskOf(runId)).runs[0].browser, true);

  // An agent that did not ask gets nothing, and nothing is said.
  const plain = await (await call("POST", "/v1/agents", PI_AGENT)).json();
  const second = await (await call("POST", "/v1/tasks", { agentId: plain.id, ...TASK })).json();
  assertEquals((await store.getRun(second.runId))!.workItem.browser, undefined);
  assertEquals(launches[1].browser, null);
  assertEquals((await taskOf(second.runId)).runs[0].browser, false);
  assertEquals(
    (await store.listEvents(second.runId)).filter((e) => e.kind === "browser.unavailable"),
    [],
  );
});

test("a deployment that cannot give the run a browser starts it anyway, and says why", async () => {
  const cases: Array<[Parameters<typeof buildApp>[0], string, string]> = [
    [{ browser: null }, "pi", "RYPH_BROWSER_IMAGE"],
    [{ supportsBrowser: false }, "pi", "kubernetes with native sidecars"],
    [{}, "echo", "cannot call MCP tools"],
    // The provisioner's say about this run's own pod: an old cluster, a class with no disk left.
    [
      { browserRefusal: () => Promise.resolve('size class "tiny" has no ephemeral storage') },
      "pi",
      'the agent has a browser, but size class "tiny" has no ephemeral storage, so this run',
    ],
  ];
  for (const [opts, harnessKind, why] of cases) {
    const { call, store, launches } = buildApp(opts);
    const agent = await (await call("POST", "/v1/agents", {
      ...PI_AGENT,
      harnessKind,
      browserEnabled: true,
    })).json();
    const created = await call("POST", "/v1/tasks", { agentId: agent.id, ...TASK });
    assertEquals(created.status, 201, why);
    const { runId } = await created.json();
    assertEquals((await store.getRun(runId))!.workItem.browser, undefined);
    assertEquals(launches[0].browser, null);
    const taskId = (await store.getRun(runId))!.taskId;
    assertEquals((await (await call("GET", `/v1/tasks/${taskId}`)).json()).runs[0].browser, false);
    const notes = (await store.listEvents(runId)).filter((e) => e.kind === "browser.unavailable");
    assertEquals(notes.length, 1, why);
    assertStringIncludes(notes[0].detail!, why);
  }
});

test("RYPH_BROWSER_*: unset or off is off, quantities default, a bad one is fatal naming the variable", () => {
  const fail = (message: string): never => {
    throw new Error(message);
  };
  const envOf = (vars: Record<string, string>) => (name: string) => vars[name];
  assertEquals(browserConfigFromEnv(envOf({}), fail), null);
  assertEquals(browserConfigFromEnv(envOf({ RYPH_BROWSER_IMAGE: "off" }), fail), null);
  assertEquals(browserConfigFromEnv(envOf({ RYPH_BROWSER_IMAGE: " off " }), fail), null);
  assertEquals(browserConfigFromEnv(envOf({ RYPH_BROWSER_IMAGE: "OFF" }), fail), null);
  assertEquals(browserConfigFromEnv(envOf({ RYPH_BROWSER_IMAGE: "img:1" }), fail), {
    image: "img:1",
    cpus: "1",
    memory: "1536Mi",
  });
  assertEquals(
    browserConfigFromEnv(
      envOf({ RYPH_BROWSER_IMAGE: "img:1", RYPH_BROWSER_CPUS: "500m", RYPH_BROWSER_MEMORY: "2Gi" }),
      fail,
    ),
    { image: "img:1", cpus: "500m", memory: "2Gi" },
  );
  for (
    const [vars, named] of [
      [{ RYPH_BROWSER_CPUS: "lots" }, "RYPH_BROWSER_CPUS"],
      [{ RYPH_BROWSER_CPUS: "0" }, "RYPH_BROWSER_CPUS"],
      // docker's spelling is not this variable's: it is a Kubernetes quantity
      [{ RYPH_BROWSER_MEMORY: "1.5gb" }, "RYPH_BROWSER_MEMORY"],
    ] as const
  ) {
    let message = "";
    try {
      browserConfigFromEnv(envOf({ RYPH_BROWSER_IMAGE: "img", ...vars }), fail);
    } catch (err) {
      message = (err as Error).message;
    }
    assertStringIncludes(message, named);
  }
});

test("the boot line: off, on, or set where it cannot run", () => {
  assertEquals(browserPosture(null, {}, "docker").level, "info");
  assertStringIncludes(browserPosture(null, {}, "docker").message, "unset");
  const stranded = browserPosture(BROWSER, {}, "manual");
  assertEquals(stranded.level, "warn");
  assertStringIncludes(stranded.message, "RYPH_PROVISIONER=manual");
  const on = browserPosture(BROWSER, { supportsBrowser: true }, "kubernetes");
  assertEquals(on.level, "info");
  assertStringIncludes(on.message, "ryph-browser:test");
});

test("the grant is pure: asked, offered, and on a harness that can call tools", () => {
  const can = { supportsBrowser: true };
  assertEquals(browserGrant({ browserEnabled: false, harnessKind: "pi" }, BROWSER, can), {
    kind: "none",
  });
  assertEquals(browserGrant({ browserEnabled: true, harnessKind: "pi" }, BROWSER, can), {
    kind: "granted",
    browser: { port: 7490 },
  });
  assert(
    browserGrant({ browserEnabled: true, harnessKind: "pi" }, null, can).kind === "unavailable",
  );
});

test("Docker browser defaults are uncapped and each explicit resource is honored", () => {
  const fail = (message: string): never => {
    throw new Error(message);
  };
  const envOf = (vars: Record<string, string>) => (name: string) => vars[name];
  const vars = { RYPH_PROVISIONER: "docker", RYPH_BROWSER_IMAGE: "img" };
  assertEquals(browserConfigFromEnv(envOf(vars), fail), { image: "img", cpus: null, memory: null });
  assertEquals(browserConfigFromEnv(envOf({ ...vars, RYPH_BROWSER_CPUS: "500m" }), fail), {
    image: "img",
    cpus: "500m",
    memory: null,
  });
  assertEquals(browserConfigFromEnv(envOf({ ...vars, RYPH_BROWSER_MEMORY: "2Gi" }), fail), {
    image: "img",
    cpus: null,
    memory: "2Gi",
  });
  assertEquals(browserConfigFromEnv(envOf({ ...vars, RYPH_PROVISIONER: "kubernetes" }), fail), {
    image: "img",
    cpus: "1",
    memory: "1536Mi",
  });
  assertThrows(() => browserConfigFromEnv(envOf({ ...vars, RYPH_BROWSER_CPUS: "0" }), fail));
  assertThrows(() => browserConfigFromEnv(envOf({ ...vars, RYPH_BROWSER_MEMORY: "bad" }), fail));
});

test("a repo service may not take the browser's name or its port", () => {
  const policy = { ...DEFAULT_SERVICE_POLICY, enabled: true, imageAllowlist: ["docker.io/"] };
  const decl = { name: "web", image: "docker.io/library/nginx:1", env: {}, port: 80 };
  const named = resolveServices([{ ...decl, name: "browser" }], [], policy);
  assertEquals(named.kind, "refused");
  const ported = resolveServices([{ ...decl, port: 7490 }], [], policy);
  assertEquals(ported.kind, "refused");
  assert(ported.kind === "refused" && ported.error.includes("browser"));
});

// Service containers through the whole control plane: connect a repo, declare a database,
// and watch what the provisioner is handed — or what the caller is told instead.
//
// Everything here is about the launch path refusing rather than proceeding. The measured
// failure this feature exists to remove is not a suite that fails, it is one that HANGS, and
// reproducing that ourselves by dropping a service would be the worst possible outcome.

import { test } from "bun:test";
import { capsClaimOf } from "@ryph/auth";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import type { ServicesFile } from "../src/ports/forge.ts";
import {
  DEFAULT_SERVICE_POLICY,
  type ServiceCatalogueEntry,
  type ServicePolicy,
} from "../src/core/services.ts";
import type { ServiceCatalogue } from "../src/ports/service_catalogue.ts";
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
  caps: capsClaimOf("member"),
} as const;

const POSTGRES: ServiceCatalogueEntry = {
  id: "postgres",
  name: "PostgreSQL",
  description: "",
  docs: "https://example.test",
  versions: { "18": `postgres:18@sha256:${"a".repeat(64)}` },
  defaultPort: 5432,
  capabilities: ["CHOWN", "SETGID", "SETUID"],
  memory: "512m",
  env: ["POSTGRES_PASSWORD"],
};
const catalogue: ServiceCatalogue = { list: () => Promise.resolve([POSTGRES]) };

const DECLARED = `services:
  db:
    uses: postgres@18
    env:
      POSTGRES_PASSWORD: password
    port: 5433
`;

function buildApp(opts: { servicesFile?: ServicesFile; services?: ServicePolicy } = {}) {
  const store = memoryTaskStore();
  const { provisioner, launches } = fakeProvisioner();
  const forge = noopForge(silentDiagnostics(), {
    repos: [{
      fullName: "acme/app",
      url: "https://github.com/acme/app.git",
      defaultBranch: "main",
      private: true,
    }],
    servicesFile: opts.servicesFile,
  });
  const identities = fakeIdentityDirectory();
  identities.link(USER.userId, "noop-ada");
  const handler = makeHandler({
    store,
    provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate: (() => Promise.resolve(USER)) as unknown as Authenticate,
    forgeToken: "forge-service-token",
    forge,
    githubConnect: forge,
    serviceCatalogue: catalogue,
    identityDirectory: identities.directory,
    now: fakeClock().now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: { url: "http://gateway.test:7412", keyTtlMs: 3600_000 },
      runHistoryUrl: null,
      appUrl: null,
      services: opts.services ?? { ...DEFAULT_SERVICE_POLICY, enabled: true },
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
  return { handler, store, launches };
}

type App = ReturnType<typeof buildApp>;
const post = (app: App, path: string, body: unknown = {}) =>
  app.handler(
    new Request(`http://orchestrator.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify(body),
    }),
  );

async function connectedTask(app: App): Promise<Response> {
  assertEquals((await post(app, "/v1/installations", { installationId: "42" })).status, 201);
  const repo = await (await post(app, "/v1/connected-repos", {
    installationId: "42",
    repoRef: "acme/app",
  })).json();
  const agent = await (await post(app, "/v1/agents", {
    name: "Ada",
    email: "ada@example.com",
    harnessKind: "echo",
  })).json();
  return await post(app, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Fix the flaky test", instructions: "Fix it." },
    connectedRepoId: repo.id,
  });
}

test("a declared service is resolved, frozen on the run, and handed to the provisioner", async () => {
  const app = buildApp({ servicesFile: { kind: "file", text: DECLARED, stale: false } });
  const created = await connectedTask(app);
  assertEquals(created.status, 201);
  const { runId } = await created.json();

  const launched = app.launches.at(-1)!;
  assertEquals(launched.services?.length, 1);
  // The repo named `postgres@18`; what reaches the provisioner is the catalogue's bytes and
  // the catalogue's confinement.
  assertEquals(launched.services![0].image, POSTGRES.versions["18"]);
  assertEquals(launched.services![0].security.capabilities, ["CHOWN", "SETGID", "SETUID"]);
  assertEquals(launched.services![0].port, 5433);

  // Frozen, like every other snapshot: editing the repo's file mid-run changes nothing.
  const run = await app.store.getRun(runId);
  assertEquals(run!.services!.services[0].name, "db");
  assertEquals(run!.services!.stale, false);
});

test("a stale read still starts the run, and says so on the trail", async () => {
  // The availability trade the cache read exists to make: a declaration one fetch old beats a
  // run that does not start. But it is recorded, because the run will look inexplicable later
  // if the declaration changed in between.
  const app = buildApp({ servicesFile: { kind: "file", text: DECLARED, stale: true } });
  const { runId } = await (await connectedTask(app)).json();
  assertEquals((await app.store.getRun(runId))!.services!.stale, true);
  const events = await app.store.listEvents(runId);
  assert(events.some((e) => e.kind === "services-stale"), "the trail must record it");
});

test('"we could not ask" refuses the task — it is never "no services"', async () => {
  const app = buildApp({
    servicesFile: { kind: "unavailable", detail: "the base repo could not be read" },
  });
  const refused = await connectedTask(app);
  assertEquals(refused.status, 503);
  assertStringIncludes((await refused.json()).error, "hangs rather than fails");
  assertEquals(app.launches.length, 0);
});

test("a declaration this deployment will not run refuses, naming what to change", async () => {
  const app = buildApp({
    servicesFile: {
      kind: "file",
      text: "services:\n  db:\n    uses: elastic@9\n    port: 9200\n",
      stale: false,
    },
  });
  const refused = await connectedTask(app);
  assertEquals(refused.status, 400);
  assertStringIncludes((await refused.json()).error, "this deployment offers: postgres");
  assertEquals(app.launches.length, 0);
});

test("with the feature off the declaration is not read at all", async () => {
  // Deliberate: reading it would put a forge round trip on every task creation in every
  // deployment that will never use this. The runner closes the gap from the other side, by
  // failing loudly when its workspace declares services its spec did not bring.
  const app = buildApp({
    services: DEFAULT_SERVICE_POLICY,
    servicesFile: { kind: "unavailable", detail: "would have refused" },
  });
  assertEquals((await connectedTask(app)).status, 201);
  assertEquals(app.launches.at(-1)!.services, []);
});

test("a repo that declares nothing launches with nothing, and no refusal", async () => {
  const app = buildApp({ servicesFile: { kind: "absent" } });
  const { runId } = await (await connectedTask(app)).json();
  assertEquals(app.launches.at(-1)!.services, []);
  assertEquals((await app.store.getRun(runId))!.services, null);
});

const CHECKS_ONLY = `services:
  db:
    uses: postgres@18
    env:
      POSTGRES_PASSWORD: password
    port: 5433
    checks_only: true
`;

test("a repo whose only service is checks-only launches exactly as one that declares nothing", async () => {
  // Services on: the declaration is read, and the run is handed nothing. Off: not read at all,
  // and the runner leaves a checks-only service out of what it expects (its environment_test),
  // so a task on the repo starts on a deployment that runs no service containers.
  for (const services of [{ ...DEFAULT_SERVICE_POLICY, enabled: true }, DEFAULT_SERVICE_POLICY]) {
    const app = buildApp({
      services,
      servicesFile: { kind: "file", text: CHECKS_ONLY, stale: false },
    });
    const created = await connectedTask(app);
    assertEquals(created.status, 201, `enabled: ${services.enabled}`);
    const { runId } = await created.json();
    assertEquals(app.launches.at(-1)!.services, []);
    assertEquals((await app.store.getRun(runId))!.services, null);
  }
});

test("beside a run's own service, a checks-only one is left out of the launch", async () => {
  const app = buildApp({
    servicesFile: {
      kind: "file",
      text: CHECKS_ONLY + "  cache:\n    uses: postgres@18\n    port: 5434\n",
      stale: false,
    },
  });
  const { runId } = await (await connectedTask(app)).json();
  assertEquals(app.launches.at(-1)!.services?.map((s) => s.name), ["cache"]);
  assertEquals((await app.store.getRun(runId))!.services!.services.map((s) => s.name), ["cache"]);
});

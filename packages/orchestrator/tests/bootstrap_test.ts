import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { sha256Hex } from "@ryph/sealed";
import { sql } from "drizzle-orm";
import { rowsOf } from "@ryph/db";
import { sweep } from "../src/core/reaper.ts";
import type { Provisioner } from "../src/ports/provisioner.ts";
import { makeHandler } from "../src/http/app.ts";
import { drizzleTaskStore } from "../src/adapters/store/drizzle.ts";
import type { TaskStore } from "../src/ports/task_store.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";
import { makeTestDb } from "./db.ts";
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
import { noopForge } from "../src/adapters/forge/noop.ts";

/** The launch's TTL as a run under `imageConfig()` gets it: the startup grace plus the slack
 * start_task.ts allows the provisioner's own call. */
const TTL_MS = 600_000 + 5 * 60_000;

function world(
  store: TaskStore = memoryTaskStore(),
  wrap: (provisioner: Provisioner) => Provisioner = (p) => p,
) {
  const clock = fakeClock();
  const fake = fakeProvisioner();
  const { launches } = fake;
  const provisioner = wrap(fake.provisioner);
  const handler = makeHandler({
    store,
    provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    forge: noopForge(silentDiagnostics()),
    authenticate: () => Promise.resolve({ kind: "break-glass" } as const),
    modelAccess: null,
    toolAccess: null,
    forgeToken: null,
    now: clock.now,
    config: {
      ...imageConfig(),
      publicUrl: "http://orchestrator.test",
      appUrl: null,
      gitGateway: TEST_GATEWAY,
      runHistoryUrl: null,
      services: DEFAULT_SERVICE_POLICY,
      egress: {
        policy: { mode: "proxy", bundles: [], hosts: [], proxyUrl: "http://egress.test" },
        key: new Uint8Array(32).fill(7),
        tokenTtlMs: 3600_000,
      },
      platformMemoryServerId: null,
      platformChatServerId: null,
      platformTools: { webServerId: "ms-platform-web", web: false, forge: null, pending: false },
    },
  });
  const post = (path: string, body: unknown = {}, token = "") =>
    handler(
      new Request(
        `http://orchestrator.test${path}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
    );
  async function launch() {
    if ((await store.getConnectedRepo(LOCAL_REPO.id)) === null) {
      await store.createConnectedRepo(LOCAL_REPO);
    }
    const agent = await (await post("/v1/agents", {
      name: "Ada",
      email: "ada@example.com",
      harnessKind: "echo",
    })).json();
    const response = await post("/v1/tasks", {
      agentId: agent.id,
      spec: { title: "Bootstrap", instructions: "Test the handshake" },
      connectedRepoId: LOCAL_REPO.id,
    });
    assertEquals(response.status, 201, await response.clone().text());
    return launches.at(-1)!;
  }
  return { store, clock, handler, post, launch, provisioner };
}

test("bootstrap: secret-free launch, scoped one-shot exchange, no caching or bearer reuse", async () => {
  const w = world();
  const launch = await w.launch();
  assertEquals(Object.keys(launch.env).sort(), [
    "RYPH_BOOTSTRAP_TOKEN",
    "RYPH_EGRESS_PROXY",
    "RYPH_ORCHESTRATOR_URL",
    "RYPH_RUN_ID",
  ]);

  const path = `/v1/runs/${launch.runId}/bootstrap`;
  const token = launch.env.RYPH_BOOTSTRAP_TOKEN;
  assertEquals((await w.post(path, {}, "wrong")).status, 401);
  const other = await w.launch();
  assertEquals((await w.post(`/v1/runs/${other.runId}/bootstrap`, {}, token)).status, 401);
  const response = await w.post(path, {}, token);
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("cache-control"), "no-store");
  assert(
    (await w.store.listEvents(launch.runId)).some((e) => e.kind === "bootstrap-redeemed"),
    "the exchange leaves a trace an operator can read",
  );
  const { env } = await response.json();
  assert(env.RYPH_GIT_TOKEN);
  assert(!JSON.stringify(launch).includes(env.RYPH_GIT_TOKEN));
  assert(env.RYPH_CONTROL_TOKEN);
  assert(env.RYPH_EGRESS_TOKEN);
  assertEquals(
    (await w.store.getRun(launch.runId))!.tokenHash,
    await sha256Hex(env.RYPH_RUN_TOKEN),
  );
  assertEquals((await w.post(path, {}, token)).status, 401);
  assertEquals((await w.post(path, {}, env.RYPH_RUN_TOKEN)).status, 401);
  for (const [bearer, status] of [[token, 401], [env.RYPH_RUN_TOKEN, 200]] as const) {
    assertEquals(
      (await w.handler(
        new Request(`http://orchestrator.test/v1/runs/${launch.runId}/spec`, {
          headers: { authorization: `Bearer ${bearer}` },
        }),
      )).status,
      status,
    );
  }
});

test("bootstrap: a bundle that cannot be opened is a clean 409, and is not spent", async () => {
  const w = world();
  const launch = await w.launch();
  const token = launch.env.RYPH_BOOTSTRAP_TOKEN;
  const hash = await sha256Hex(token);
  const expiresAt = new Date(Date.parse(w.clock.now().toISOString()) + 60_000).toISOString();
  await w.store.deleteBootstrap(launch.runId);
  await w.store.saveBootstrap(launch.runId, hash, "v2.bm90.YSBidW5kbGU=", expiresAt);
  const res = await w.post(`/v1/runs/${launch.runId}/bootstrap`, {}, token);
  assertEquals(res.status, 409);
  const body = await res.json();
  assertEquals(body.code, "bootstrap_unreadable");
  assert(!JSON.stringify(body).includes("at "), "no stack trace");
  assertEquals(
    await w.store.readBootstrap(launch.runId, hash, w.clock.now().toISOString()),
    "v2.bm90.YSBidW5kbGU=",
    "the row is left as it was",
  );
});

test("bootstrap: expired, cancelled and terminal runs cannot redeem", async () => {
  for (const state of ["expired", "cancelled", "succeeded"] as const) {
    const w = world();
    const launch = await w.launch();
    const run = (await w.store.getRun(launch.runId))!;
    if (state === "expired") w.clock.advance(TTL_MS);
    else if (state === "cancelled") {
      await w.store.requestRunCancel(run.id, w.clock.now().toISOString());
    } else await w.store.saveRunResult({ ...run, state });
    assertEquals(
      (await w.post(`/v1/runs/${run.id}/bootstrap`, {}, launch.env.RYPH_BOOTSTRAP_TOKEN)).status,
      401,
    );
  }
});

test("bootstrap: database consumption has one winner across handler instances", async () => {
  const db = await makeTestDb();
  try {
    const first = world(drizzleTaskStore(db));
    const second = world(drizzleTaskStore(db));
    const launch = await first.launch();
    const replies = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? first : second).post(
          `/v1/runs/${launch.runId}/bootstrap`,
          {},
          launch.env.RYPH_BOOTSTRAP_TOKEN,
        )),
    );
    assertEquals(replies.filter((r) => r.status === 200).length, 1);
    assertEquals(replies.filter((r) => r.status === 401).length, 11);
    const expired = await first.launch();
    first.clock.advance(TTL_MS);
    assertEquals(
      (await first.post(
        `/v1/runs/${expired.runId}/bootstrap`,
        {},
        expired.env.RYPH_BOOTSTRAP_TOKEN,
      )).status,
      401,
      "the database rejects a token at its expiry boundary",
    );
  } finally {
    await db.close();
  }
});

test("bootstrap: the token outlives the startup grace, so a slow boot is the reaper's call", async () => {
  const w = world();
  const launch = await w.launch();
  w.clock.advance(TTL_MS - 1_000);
  assertEquals(
    (await w.post(`/v1/runs/${launch.runId}/bootstrap`, {}, launch.env.RYPH_BOOTSTRAP_TOKEN))
      .status,
    200,
  );
});

for (
  const [name, makeStore] of [
    ["memory", () => Promise.resolve({ store: memoryTaskStore(), close: () => Promise.resolve() })],
    ["drizzle", async () => {
      const db = await makeTestDb();
      return { store: drizzleTaskStore(db), close: () => db.close() };
    }],
  ] as const
) {
  test(`bootstrap (${name}): one bootstrap per run, consumed once`, async () => {
    const { store, close } = await makeStore();
    try {
      const w = world(store);
      const launch = await w.launch();
      const hash = await sha256Hex(launch.env.RYPH_BOOTSTRAP_TOKEN);
      const now = w.clock.now().toISOString();
      assertEquals(typeof await store.consumeBootstrap(launch.runId, hash, now), "string");
      assertEquals(await store.consumeBootstrap(launch.runId, hash, now), null);
      // Once per run: a second launch for the same run is a bug, refused alike by both stores.
      await store.saveBootstrap(launch.runId, hash, "sealed", now);
      await assertRejects(() => store.saveBootstrap(launch.runId, hash, "sealed", now));
    } finally {
      await close();
    }
  });
}

test("bootstrap: a failed launch and an unredeemed expiry leave no sealed credentials", async () => {
  const db = await makeTestDb();
  try {
    const count = async () =>
      rowsOf(await db.db.execute(sql`select run_id from run_bootstraps`)).length;
    let failing = false;
    const w = world(drizzleTaskStore(db), (p) => ({
      ...p,
      launch: (spec) => failing ? Promise.reject(new Error("no capacity")) : p.launch(spec),
    }));
    failing = true;
    const agent = await (await w.post("/v1/agents", {
      name: "Grace",
      email: "grace@example.com",
      harnessKind: "echo",
    })).json();
    await w.post("/v1/tasks", {
      agentId: agent.id,
      spec: { title: "Refused", instructions: "Never launches" },
      repo: { url: "https://github.com/acme/app.git", ref: "main" },
    });
    assertEquals(await count(), 0, "a launch that failed keeps nothing to redeem");

    failing = false;
    await w.launch();
    assertEquals(await count(), 1);
    w.clock.advance(TTL_MS);
    await sweep({
      store: w.store,
      provisioner: w.provisioner,
      diag: silentDiagnostics(),
      now: w.clock.now,
    }, { heartbeatTimeoutMs: 60_000, startupGraceMs: 600_000, cancelGraceMs: 0, idleGraceMs: 0 });
    assertEquals(await count(), 0, "the reaper drops an expired bootstrap");
  } finally {
    await db.close();
  }
});

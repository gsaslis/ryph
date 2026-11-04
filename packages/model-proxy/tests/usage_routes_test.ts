// The usage surface: a run's bill, a window's report whose breakdowns add up to its totals, the
// window's bounds, the user gate, and the disabled stand-ins.

import { test } from "bun:test";
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { usageRoutes } from "../src/http/usage.ts";
import { disabledProviderKeyRoutes } from "../src/http/routes.ts";
import type { Route } from "@ryph/shared/http";
import { unauthorized } from "@ryph/sealed";
import { memoryKeyStore } from "./memory_store.ts";
import { TRAIL, usageRow } from "./usage_fixtures.ts";
import type { KeyStore } from "../src/ports/key_store.ts";
import { makeDeploymentGauge } from "../src/core/spend_meter.ts";

const NOW = new Date("2026-09-03T12:00:00.000Z");

function dispatch(routes: Route[]) {
  return async (path: string, headers: HeadersInit = { authorization: "Bearer user" }) => {
    const req = new Request(`http://control.test${path}`, { headers });
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.pattern.exec(req.url);
      if (!match) continue;
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(match.pathname.groups)) {
        if (value !== undefined) params[key] = value;
      }
      return await r.handler(req, params);
    }
    return new Response("not found", { status: 404 });
  };
}

const gate = (req: Request) =>
  Promise.resolve(req.headers.get("authorization") === "Bearer user" ? null : unauthorized());

async function makeApi() {
  const store = memoryKeyStore();
  for (const record of TRAIL) await store.recordUsage(record);
  return dispatch(
    usageRoutes({
      store,
      authenticateWindow: gate,
      authenticateRunRead: gate,
      now: () => NOW,
      ceiling: null,
    }),
  );
}

test("a run's bill: its requests, tokens and cost, per model", async () => {
  const get = await makeApi();
  const res = await get("/v1/model-usage/runs/r-1");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.runId, "r-1");
  // Three rows in September, one in August, one of them a 429 with no usage.
  assertEquals(body.totals.requests, 4);
  assertEquals(body.totals.failedRequests, 1);
  assertEquals(body.totals.meteredRequests, 3);
  assertEquals(body.totals.tokens.input, 300);
  // claude-sonnet-5 at 2 / 10 / 0.2 per million.
  assertAlmostEquals(body.totals.cost.total, 300 * 2e-6 + 150 * 10e-6 + 1_000 * 0.2e-6);
  assertEquals(body.byModel.map((m: { model: string }) => m.model), ["claude-sonnet-5"]);
  assertEquals(body.pricing.currency, "USD");

  const none = await (await get("/v1/model-usage/runs/r-none")).json();
  assertEquals(none.totals.requests, 0);
  assertEquals(none.byModel, []);
});

test("a window's report: every breakdown sums to the totals", async () => {
  const get = await makeApi();
  const res = await get(
    "/v1/model-usage?from=2026-09-01T00:00:00.000Z&to=2026-09-04T00:00:00.000Z",
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.totals.requests, 6);
  assert(body.totals.cost.total > 2, "the long-context gpt-5.5 request dominates");

  type Totals = { requests: number; cost: { total: number } };
  for (const name of ["byModel", "byAgent", "byProviderKey", "byDay"]) {
    const parts = body[name] as Totals[];
    assertEquals(parts.reduce((n, p) => n + p.requests, 0), body.totals.requests, name);
    assertAlmostEquals(parts.reduce((n, p) => n + p.cost.total, 0), body.totals.cost.total);
  }

  assertEquals(body.byAgent[0].agentId, "a-2", "highest cost first");
  const platform = body.byAgent.find((a: { consumer: string | null }) => a.consumer !== null);
  assertEquals([platform.agentId, platform.consumer], [null, "memory"]);
  assertEquals(body.byDay.map((d: { day: string }) => d.day), [
    "2026-09-01",
    "2026-09-02",
    "2026-09-03",
  ]);
  assertEquals(body.topTasks.map((t: { taskId: string }) => t.taskId), ["t-2", "t-1"]);
});

test("the window defaults to the last 30 days and refuses a nonsense or oversized one", async () => {
  const get = await makeApi();
  const fallback = await (await get("/v1/model-usage")).json();
  assertEquals(fallback.to, NOW.toISOString());
  assertEquals(fallback.from, "2026-08-04T12:00:00.000Z");
  assertEquals(fallback.totals.requests, 6, "the August 1st row is older than 30 days");

  for (
    const query of [
      "from=yesterday",
      "to=2026-09-01T00:00:00Z&from=2026-09-02T00:00:00Z",
      "from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z",
    ]
  ) {
    const res = await get(`/v1/model-usage?${query}`);
    assertEquals(res.status, 400, query);
    await res.body?.cancel();
  }
});

test("both routes sit behind the user gate, and are mounted disabled without model access", async () => {
  const get = await makeApi();
  for (const path of ["/v1/model-usage", "/v1/model-usage/runs/r-1"]) {
    const res = await get(path, {});
    assertEquals(res.status, 401);
    await res.body?.cancel();
  }

  const off = dispatch(disabledProviderKeyRoutes({ authenticate: gate }));
  for (const path of ["/v1/model-usage", "/v1/model-usage/runs/r-1"]) {
    const res = await off(path);
    assertEquals(res.status, 503);
    assertEquals((await res.json()).code, "model_access_disabled");
  }
});

test("a row that lands mid-report belongs to no breakdown of it, so the parts still sum", async () => {
  const store = memoryKeyStore();
  for (const record of TRAIL) await store.recordUsage(record);

  // A ninety-second stream that STARTED inside the window: its `at` is in range, but the row is
  // written only when the response body ends — which here happens while the report is being read.
  const late = usageRow({
    runId: "r-3",
    agentId: "a-3",
    taskId: "t-3",
    providerKeyId: "pk-3",
    at: "2026-09-03T23:58:30.000Z",
  });
  let landed = false;
  const racing: KeyStore = {
    ...store,
    async aggregateUsage(query) {
      const breakdowns = await store.aggregateUsage(query);
      if (!landed) {
        landed = true;
        await store.recordUsage(late);
      }
      return breakdowns;
    },
  };

  const get = dispatch(
    usageRoutes({
      store: racing,
      authenticateWindow: gate,
      authenticateRunRead: gate,
      now: () => NOW,
      ceiling: null,
    }),
  );
  const body = await (await get(
    "/v1/model-usage?from=2026-09-01T00:00:00.000Z&to=2026-09-04T00:00:00.000Z",
  )).json();
  assert(landed, "the row really did land while the report was being read");

  type Totals = { requests: number; cost: { total: number } };
  for (const name of ["byModel", "byAgent", "byProviderKey", "byDay"]) {
    const parts = body[name] as Totals[];
    // Read one dimension at a time, `byAgent` would carry the late row and `byModel` would not,
    // and a share of a total it out-totals renders above 100%.
    assertEquals(parts.reduce((n, p) => n + p.requests, 0), body.totals.requests, name);
    assertAlmostEquals(parts.reduce((n, p) => n + p.cost.total, 0), body.totals.cost.total, 1e-9);
  }
  assertEquals(body.totals.requests, 6, "the report is the trail as it stood when it began");
});

test("a custom endpoint's declared prices reach the report; a priceless model is unpriced", async () => {
  const store = memoryKeyStore();
  await store.createCustomProvider({
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: {},
    models: [
      { id: "llama-4", price: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1.25 } },
      { id: "llama-4-mystery" },
    ],
    archivedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  const spend = (model: string) =>
    usageRow({
      runId: "r-9",
      provider: "groq",
      model,
      inputTokens: 1_000_000,
      outputTokens: 0,
      at: "2026-09-01T10:00:00.000Z",
    });
  for (const record of [spend("llama-4"), spend("llama-4-mystery")]) {
    await store.recordUsage(record);
  }

  const get = dispatch(
    usageRoutes({
      store,
      authenticateWindow: gate,
      authenticateRunRead: gate,
      now: () => NOW,
      ceiling: null,
    }),
  );
  const body = await (await get("/v1/model-usage/runs/r-9")).json();
  assertEquals(body.totals.requests, 2);
  // One priced from the row, one reported unpriced — never as a free two million tokens.
  assertAlmostEquals(body.totals.cost.total, 1);
  assertEquals(body.totals.unpricedRequests, 1);
  assertEquals(body.totals.tokens.input, 2_000_000);
  const priced = body.byModel.find((m: { model: string }) => m.model === "llama-4");
  assertAlmostEquals(priced.cost.input, 1);
  assertEquals(priced.unpricedRequests, 0);
});

test("a window's report carries the deployment's ceiling over ITS window, or null", async () => {
  const store = memoryKeyStore();
  for (const record of TRAIL) await store.recordUsage(record);
  const without = await (await (await makeApi())("/v1/model-usage")).json();
  assertEquals(without.ceiling, null);

  // A two-day ceiling window from NOW (Sept 3rd noon) reaches back to Sept 1st noon: the report
  // is asked for seven days, and the ceiling still measures its own two.
  const get = dispatch(
    usageRoutes({
      store,
      authenticateWindow: gate,
      authenticateRunRead: gate,
      now: () => NOW,
      ceiling: { usd: 5, windowDays: 2 },
    }),
  );
  const body = await (await get("/v1/model-usage?from=2026-08-27T12:00:00.000Z")).json();
  assertEquals([body.ceiling.usd, body.ceiling.windowDays], [5, 2]);
  assert(body.ceiling.spentUsd > 0);
  assert(body.ceiling.spentUsd < body.totals.cost.total, "the ceiling's window is the shorter one");
});

test("a window's report reads the ceiling off a live gauge rather than a fresh aggregate, when one rides beside it", async () => {
  const store = memoryKeyStore();
  for (const record of TRAIL) await store.recordUsage(record);
  // Seeded with a figure the store's own rows could never produce, so the response can only
  // have come from the gauge — proof the route did not fall back to `spendInWindow`.
  const gauge = makeDeploymentGauge({ ceilingUsd: 5, windowDays: 2 });
  gauge.seed(1_234.5, NOW.getTime());
  const get = dispatch(
    usageRoutes({
      store,
      authenticateWindow: gate,
      authenticateRunRead: gate,
      now: () => NOW,
      ceiling: { usd: 5, windowDays: 2 },
      gauge,
    }),
  );
  const body = await (await get("/v1/model-usage")).json();
  assertEquals(body.ceiling, { usd: 5, windowDays: 2, spentUsd: 1_234.5 });

  // No gauge: the same request falls back to a fresh aggregate, as before.
  const withoutGauge = dispatch(
    usageRoutes({
      store,
      authenticateWindow: gate,
      authenticateRunRead: gate,
      now: () => NOW,
      ceiling: { usd: 5, windowDays: 2 },
    }),
  );
  const fallback = await (await withoutGauge("/v1/model-usage")).json();
  assert(fallback.ceiling.spentUsd !== 1_234.5);
});

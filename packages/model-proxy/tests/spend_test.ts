// Spend priced for a decision: a run's total, a window's total, and one record — each agreeing
// with what the report would say for the same rows.

import { test } from "bun:test";
import { assertAlmostEquals, assertEquals } from "@std/assert";
import { priceRecord, refreshGauge, spendInWindow, spendOfRun } from "../src/core/spend.ts";
import { priceOverlayOf } from "../src/core/pricing.ts";
import { makeDeploymentGauge } from "../src/core/spend_meter.ts";
import { memoryKeyStore } from "./memory_store.ts";
import { TRAIL, usageRow } from "./usage_fixtures.ts";
import type { KeyStore } from "../src/ports/key_store.ts";

async function seeded() {
  const store = memoryKeyStore();
  for (const record of TRAIL) await store.recordUsage(record);
  return store;
}

test("spendOfRun prices the run's whole trail, the same figure the usage route reports", async () => {
  const store = await seeded();
  const spend = await spendOfRun(store, "r-1");
  // claude-sonnet-5 at 2 / 10 / 0.2 per million, over three metered rows (the 429 carries none).
  assertAlmostEquals(spend.spentUsd, 300 * 2e-6 + 150 * 10e-6 + 1_000 * 0.2e-6);
  assertEquals(spend.unpricedRequests, 0);
  assertEquals(await spendOfRun(store, "r-none"), { spentUsd: 0, unpricedRequests: 0 });
});

test("an unknown model is unpriced: it adds nothing and is counted, never treated as free", async () => {
  const store = memoryKeyStore();
  await store.recordUsage(usageRow({ model: "claude-imaginary-9" }));
  assertEquals(await spendOfRun(store, "r-1"), { spentUsd: 0, unpricedRequests: 1 });
});

test("spendInWindow sums every run's trail with `at` in [from, to)", async () => {
  const store = await seeded();
  const all = await spendInWindow(store, "2026-09-01T00:00:00.000Z", "2026-09-04T00:00:00.000Z");
  const dayOne = await spendInWindow(
    store,
    "2026-09-01T00:00:00.000Z",
    "2026-09-02T00:00:00.000Z",
  );
  const r1 = (await spendOfRun(store, "r-1")).spentUsd;
  // Day one is r-1's two September-1st rows; the window's total dwarfs it with the long-context
  // gpt-5.5 request on the 2nd.
  assertAlmostEquals(dayOne, 200 * 2e-6 + 100 * 10e-6 + 1_000 * 0.2e-6);
  assertEquals(all > r1, true);
  // The August row sits outside the window and the 10:00 row exactly at `to` is excluded.
  assertAlmostEquals(
    await spendInWindow(store, "2026-09-01T09:00:00.000Z", "2026-09-01T10:00:00.000Z"),
    0,
  );
});

test("refreshGauge runs one aggregate for a burst of concurrent callers, not one each", async () => {
  const store = await seeded();
  let aggregates = 0;
  const counting: KeyStore = {
    ...store,
    aggregateUsage(query) {
      aggregates += 1;
      return store.aggregateUsage(query);
    },
  };
  const gauge = makeDeploymentGauge({ ceilingUsd: 1, windowDays: 30 });
  // A stale gauge, and twenty callers that all see it stale before the first refresh lands.
  await Promise.all(Array.from({ length: 20 }, () => refreshGauge(gauge, counting, 0)));
  assertEquals(aggregates, 1, "one refresh in flight per gauge, the rest await it");
  assertEquals(gauge.stale(0), false, "the gauge is seeded once the shared refresh lands");

  // Once fresh, a further burst does not even start a refresh.
  await Promise.all(Array.from({ length: 5 }, () => refreshGauge(gauge, counting, 1_000)));
  assertEquals(aggregates, 1, "a fresh gauge needs no refresh at all");
});

test("priceRecord prices one row as the report prices it, and says when it cannot", () => {
  const overlay = priceOverlayOf([]);
  assertAlmostEquals(priceRecord(usageRow(), overlay)!, 100 * 2e-6 + 50 * 10e-6);
  assertEquals(priceRecord(usageRow({ model: "claude-imaginary-9" }), overlay), null);
  // A response that carried no usage costs nothing and is not "unpriced".
  assertEquals(
    priceRecord(usageRow({ inputTokens: null, outputTokens: null, status: 429 }), overlay),
    0,
  );
  // A custom endpoint's declared rate reaches a record through the overlay.
  const declared = priceOverlayOf([{
    id: "groq",
    models: [{ id: "llama-4", price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
  }]);
  assertAlmostEquals(
    priceRecord(usageRow({ provider: "groq", model: "llama-4" }), declared)!,
    100 * 1e-6 + 50 * 2e-6,
  );
});

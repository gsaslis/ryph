// The trail's sums in real SQL: grouping per dimension, the tier bucket, the window and run
// filters — and the in-memory double held to the same answers, row for row.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { drizzleKeyStore } from "../src/adapters/store/drizzle.ts";
import { TIER_THRESHOLDS } from "../src/core/pricing.ts";
import type {
  UsageAggregateQuery,
  UsageAggregateRow,
  UsageDimension,
} from "../src/core/usage_report.ts";
import type { KeyStore } from "../src/ports/key_store.ts";
import { makeTestDb } from "./db.ts";
import { memoryKeyStore } from "./memory_store.ts";
import { TRAIL } from "./usage_fixtures.ts";

const WINDOW = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-04T00:00:00.000Z" };
const DIMENSIONS = ["model", "agent", "providerKey", "day", "task"] as const;

const canonical = (rows: UsageAggregateRow[]) =>
  rows.map((r) => JSON.stringify(r)).sort().map((r) => JSON.parse(r));

async function seeded(store: KeyStore): Promise<KeyStore> {
  for (const record of TRAIL) await store.recordUsage(record);
  return store;
}

test("drizzle aggregateUsage: per dimension, tier-bucketed, windowed — and the double agrees", async () => {
  const handle = await makeTestDb();
  const sql = await seeded(drizzleKeyStore(handle));
  const mem = await seeded(memoryKeyStore());
  try {
    const query = (
      by: readonly UsageDimension[],
      extra: Partial<UsageAggregateQuery> = WINDOW,
    ) => ({ by, tierThresholds: TIER_THRESHOLDS, ...extra });
    /** One dimension's rows. */
    const rows = async (
      store: KeyStore,
      by: UsageDimension,
      extra: Partial<UsageAggregateQuery> = WINDOW,
    ) => (await store.aggregateUsage(query([by], extra)))[0];

    for (const by of DIMENSIONS) {
      for (const extra of [WINDOW, {}, { runId: "r-1" }]) {
        assertEquals(
          canonical(await rows(sql, by, extra)),
          canonical(await rows(mem, by, extra)),
          `${by} ${JSON.stringify(extra)}`,
        );
      }
    }

    // All five dimensions in ONE call — one snapshot, one transaction — answer exactly what a
    // call each answers on a trail nobody is writing to. That is the whole point of asking for
    // them together: on a trail somebody IS writing to, only this shape can still add up.
    const together = await sql.aggregateUsage(query(DIMENSIONS));
    const doubled = await mem.aggregateUsage(query(DIMENSIONS));
    assertEquals(together.length, DIMENSIONS.length);
    assertEquals(doubled.length, DIMENSIONS.length);
    for (const [i, by] of DIMENSIONS.entries()) {
      assertEquals(canonical(together[i]), canonical(await rows(sql, by)), `${by} together`);
      assertEquals(canonical(doubled[i]), canonical(together[i]), `${by} double together`);
    }

    const models = await rows(sql, "model");
    const gpt = models.filter((r) => r.model === "gpt-5.5").sort((a, b) =>
      a.tierFloor - b.tierFloor
    );
    assertEquals(gpt.map((r) => [r.tierFloor, r.inputTokens]), [[0, 100], [272_000, 200_000]]);
    const sonnet = models.find((r) => r.model === "claude-sonnet-5")!;
    assertEquals(sonnet.key, null);
    assertEquals(sonnet.requests, 3, "the August row is outside the window");
    assertEquals(sonnet.failedRequests, 1);
    assertEquals(sonnet.meteredRequests, 2);
    assertEquals(sonnet.cacheReadTokens, 1_000);
    assertEquals(typeof sonnet.inputTokens, "number", "sums read as numbers on every driver");

    const agents = await rows(sql, "agent");
    assertEquals(
      [...new Set(agents.map((r) => r.key))].sort(),
      ["a-1", "a-2", "platform:memory"],
      "agent-less spend groups under its platform principal",
    );
    const haiku = agents.find((r) => r.key === "platform:memory")!;
    assertEquals([haiku.cacheWriteTokens, haiku.cacheWrite1hTokens, haiku.reasoningTokens], [
      400,
      100,
      20,
    ]);

    const days = await rows(sql, "day");
    assertEquals([...new Set(days.map((r) => r.key))].sort(), [
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
    ]);
    const tasks = await rows(sql, "task");
    assert(tasks.some((r) => r.key === null), "platform spend has no task");

    const run = await rows(sql, "model", { runId: "r-2" });
    assertEquals(run.reduce((n, r) => n + r.requests, 0), 2);
    assertEquals(await rows(sql, "model", { runId: "r-none" }), []);
  } finally {
    await handle.close();
  }
});

// What a run, a window, or one record cost — the metering trail priced for a decision rather than
// for a report. The same rules as usage_report.ts, applied where a number is compared to a cap.
//
// Invariants:
// - money is never read off a row: every figure here is priced at read time from the catalogue
//   and the custom endpoints' declared rates, exactly as the report prices it
// - an unpriced model counts as nothing here and is reported as such, so a caller comparing to a
//   cap can refuse it instead of waving it through as free

import {
  costOf,
  priceFor,
  type PriceOverlay,
  priceOverlayOf,
  TIER_THRESHOLDS,
  tierFloorOf,
} from "./pricing.ts";
import type { DeploymentGauge } from "./spend_meter.ts";
import type { UsageRecord } from "./types.ts";
import { rollUp } from "./usage_report.ts";
import type { KeyStore } from "../ports/key_store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RunSpend {
  /** USD at list price, over every metered request of the run. */
  spentUsd: number;
  /** Metered requests the catalogue could not price; their tokens are not in `spentUsd`. */
  unpricedRequests: number;
}

/** Prices one run's whole trail. */
export async function spendOfRun(store: KeyStore, runId: string): Promise<RunSpend> {
  const overlay = priceOverlayOf(await store.listCustomProviders());
  const [rows] = await store.aggregateUsage({
    runId,
    by: ["model"],
    tierThresholds: TIER_THRESHOLDS,
  });
  const [all] = rollUp(rows, overlay);
  return {
    spentUsd: all?.totals.cost.total ?? 0,
    unpricedRequests: all?.totals.unpricedRequests ?? 0,
  };
}

/** Prices every run's trail with `at` in `[from, to)`, the platform's included. */
export async function spendInWindow(store: KeyStore, from: string, to: string): Promise<number> {
  const overlay = priceOverlayOf(await store.listCustomProviders());
  const [rows] = await store.aggregateUsage({
    from,
    to,
    by: ["model"],
    tierThresholds: TIER_THRESHOLDS,
  });
  const [all] = rollUp(rows, overlay);
  return all?.totals.cost.total ?? 0;
}

// One refresh in flight per gauge: a busy deployment can have many callers see the gauge as
// stale before the first refresh lands, and each would otherwise start its own full-window
// aggregate. Concurrent callers await the one already running instead.
const refreshesInFlight = new WeakMap<DeploymentGauge, Promise<void>>();

/** Re-reads the deployment gauge's window from the store when its last reading has gone stale. */
export async function refreshGauge(
  gauge: DeploymentGauge,
  store: KeyStore,
  nowMs: number,
): Promise<void> {
  if (!gauge.stale(nowMs)) return;
  const inFlight = refreshesInFlight.get(gauge);
  if (inFlight !== undefined) return inFlight;
  const refresh = (async () => {
    const from = new Date(nowMs - gauge.snapshot().windowDays * DAY_MS).toISOString();
    gauge.seed(await spendInWindow(store, from, new Date(nowMs).toISOString()), nowMs);
  })();
  refreshesInFlight.set(gauge, refresh);
  try {
    await refresh;
  } finally {
    if (refreshesInFlight.get(gauge) === refresh) refreshesInFlight.delete(gauge);
  }
}

/**
 * Prices one record the way the report would price its row: null when the catalogue has no rate
 * for the model, zero when the response carried no usage.
 */
export function priceRecord(record: UsageRecord, overlay: PriceOverlay): number | null {
  if (record.inputTokens === null) return 0;
  const price = priceFor(record.provider, record.model, overlay);
  if (price === null) return null;
  const tokens = {
    input: record.inputTokens,
    output: record.outputTokens ?? 0,
    cacheRead: record.cacheReadTokens ?? 0,
    cacheWrite: record.cacheWriteTokens ?? 0,
    cacheWrite1h: record.cacheWrite1hTokens ?? 0,
    reasoning: record.reasoningTokens ?? 0,
  };
  const totalInput = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return costOf(price, tokens, tierFloorOf(totalInput)).total;
}

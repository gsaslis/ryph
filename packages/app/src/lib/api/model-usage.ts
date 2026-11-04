import { z } from "zod";
import { formatUsd } from "$lib/utils/format";
import { apiCall, ApiError } from "./call";
import { isModelAccessDisabled } from "./provider-keys";
import { includedPricingSchema } from "./types";

// What the model proxy's metering trail cost. Tokens are what each provider reported on the
// response; costs are priced when read, from ryph's own hand-kept price list, in US dollars — an
// estimate at list price, not an invoice.

const tokensSchema = z.object({
  /** Uncached input: cache reads and writes are counted apart. */
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  /** Part of `output`, shown on its own. */
  reasoning: z.number(),
});

const costSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  total: z.number(),
});

const totalsShape = {
  requests: z.number(),
  /** The provider answered 4xx or 5xx. */
  failedRequests: z.number(),
  /** Requests whose response reported usage — the ones the token counts come from. */
  meteredRequests: z.number(),
  /** Metered on a model the price list does not know: tokens counted, cost left out. */
  unpricedRequests: z.number(),
  /** Metered on a model a subscription pays for (a ChatGPT plan's): tokens counted, cost $0 and
   * not spend. Absent from a proxy that predates the included state. */
  includedRequests: z.number().default(0),
  tokens: tokensSchema,
  cost: costSchema,
};

export const usageTotalsSchema = z.object(totalsShape);
export type UsageTotals = z.infer<typeof usageTotalsSchema>;

export const modelUsageSchema = z.object({
  provider: z.string(),
  model: z.string().nullable(),
  /** How this model's calls were costed; "included" when a plan pays for them. */
  pricing: z.enum(["priced", includedPricingSchema.value, "unpriced"]).optional(),
  ...totalsShape,
});
export type ModelUsage = z.infer<typeof modelUsageSchema>;

const pricingSchema = z.object({ currency: z.string(), source: z.string() });

export const runModelUsageSchema = z.object({
  runId: z.string(),
  totals: usageTotalsSchema,
  byModel: z.array(modelUsageSchema),
  pricing: pricingSchema,
});
export type RunModelUsage = z.infer<typeof runModelUsageSchema>;

export const usageReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  totals: usageTotalsSchema,
  byModel: z.array(modelUsageSchema),
  byAgent: z.array(
    z.object({
      agentId: z.string().nullable(),
      /** The platform's own background work ("memory"), when the spend belongs to no agent. */
      consumer: z.string().nullable(),
      ...totalsShape,
    }),
  ),
  byProviderKey: z.array(z.object({ providerKeyId: z.string().nullable(), ...totalsShape })),
  /** `YYYY-MM-DD` in UTC, oldest first; days without a request are absent. */
  byDay: z.array(z.object({ day: z.string(), ...totalsShape })),
  /** The window's most expensive tasks, highest first. */
  topTasks: z.array(z.object({ taskId: z.string(), ...totalsShape })),
  pricing: pricingSchema,
  /** The deployment's spend ceiling over ITS rolling window — not the report's — and what has
   * been spent in it; null when the operator set none. */
  ceiling: z
    .object({ usd: z.number(), windowDays: z.number().int(), spentUsd: z.number() })
    .nullable()
    .default(null),
});
export type UsageReport = z.infer<typeof usageReportSchema>;

/** True when every metered call in these totals was included in a plan, so the $0 is not a cost. */
export function isIncluded(t: UsageTotals & { pricing?: ModelUsage["pricing"] }): boolean {
  if (t.pricing === "included") return true;
  return t.includedRequests > 0 && t.includedRequests >= t.meteredRequests && t.cost.total === 0;
}

/**
 * The cost cell of a usage row: "Included" for calls a plan paid for, "Unpriced" for calls on a
 * model the price list does not know, else the dollar figure. A row mixing included calls with
 * priced ones shows its priced cost, which is all it spent.
 */
export function costLabel(t: UsageTotals & { pricing?: ModelUsage["pricing"] }): string {
  if (isIncluded(t)) return "Included";
  if (t.unpricedRequests > 0 && t.cost.total === 0) return "Unpriced";
  return formatUsd(t.cost.total);
}

export async function getRunModelUsage(
  f = fetch,
  runId: string,
  grant?: string | null,
): Promise<RunModelUsage> {
  const query = grant ? `?grant=${encodeURIComponent(grant)}` : "";
  return runModelUsageSchema.parse(
    await apiCall(f, `/v1/model-usage/runs/${encodeURIComponent(runId)}${query}`),
  );
}

/** A run's bill as a run page reads it. */
export type RunUsageState = {
  usage: RunModelUsage | null;
  /** True when the bill could not be read at all — a note on the page, never an error page. */
  unavailable: boolean;
};

/**
 * A run's bill for a page `load`, never fatal: a deployment without model access has no bill to
 * show, and a proxy that is down costs the page a card, not the run view.
 */
export async function getRunUsageState(
  f = fetch,
  runId: string,
  grant?: string | null,
): Promise<RunUsageState> {
  try {
    return { usage: await getRunModelUsage(f, runId, grant), unavailable: false };
  } catch (e) {
    if (e instanceof ApiError) {
      return { usage: null, unavailable: !isModelAccessDisabled(e) };
    }
    if (e instanceof TypeError) return { usage: null, unavailable: true }; // the fetch itself
    throw e;
  }
}

export type UsageWindow = { from: string; to: string };

export async function getUsageReport(f = fetch, window: UsageWindow): Promise<UsageReport> {
  const query = new URLSearchParams(window);
  return usageReportSchema.parse(await apiCall(f, `/v1/model-usage?${query}`));
}

/** A window's report, or `null` when the deployment runs without model access at all. */
export async function getUsageReportOrOff(
  f = fetch,
  window: UsageWindow,
): Promise<UsageReport | null> {
  try {
    return await getUsageReport(f, window);
  } catch (e) {
    if (e instanceof ApiError && isModelAccessDisabled(e)) return null;
    throw e;
  }
}

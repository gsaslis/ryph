// The usage surface: what the metering trail cost, for one run or for a window of time, priced at
// read time from the hand-kept catalogue. Mounted beside the key CRUD on the control side.
//
// Invariants:
// - READ-ONLY: whoever may see a run may see what its model calls cost, which is what the run
//   grant proves; a window's report rolls everyone's spend up, so it takes `usage:read-all`.
//   A window discloses a key's id beside its spend, never its secret.
// - every number in a response is computed from the same rows at the same moment, so a report's
//   breakdowns always add up to its totals
// - a window is bounded (MAX_WINDOW_DAYS): nobody asks for all of history by accident
// - the price overlay is built ONCE per request, from the custom endpoints' declared models, and
//   handed to every roll-up in it — so a report's breakdowns are priced from one reading of the
//   rows AND one reading of the prices. A declared model with no price contributes nothing to
//   the overlay and is therefore reported as unpriced, never as free.

import { PRICING_SOURCE } from "../core/pricing_catalogue.ts";
import { priceOverlayOf, TIER_THRESHOLDS } from "../core/pricing.ts";
import { PLATFORM_PRINCIPAL_PREFIX } from "../core/types.ts";
import { emptyTotals, rollUp, type UsageDimension } from "../core/usage_report.ts";
import { refreshGauge, spendInWindow } from "../core/spend.ts";
import type { DeploymentGauge } from "../core/spend_meter.ts";
import type { KeyStore } from "../ports/key_store.ts";
import { json, type Route, route } from "@ryph/shared/http";

/** The usage surface's paths, shared by the live routes and their disabled stand-ins. */
export const USAGE_PATHS = {
  window: "/v1/model-usage",
  run: "/v1/model-usage/runs/:runId",
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 366;
/** How many of a window's most expensive tasks a report names: the page shows 5 and opens the rest. */
export const TOP_TASKS = 50;

const PRICING = { currency: "USD", source: PRICING_SOURCE } as const;

/** The breakdowns a window's report carries, in the order it reads them. */
const DIMENSIONS: readonly UsageDimension[] = ["model", "agent", "providerKey", "day", "task"];

export interface UsageRoutesDeps {
  store: KeyStore;
  /** The gate on a window's report, which rolls up everyone's spend: `usage:read-all`. */
  authenticateWindow(req: Request): Promise<Response | null>;
  /** The gate on one run's bill: the run's grant, or a bearer holding `usage:read-all`. */
  authenticateRunRead(req: Request, runId: string): Promise<Response | null>;
  now(): Date;
  /** The deployment's spend ceiling, reported beside every window so the page can show it. */
  ceiling: { usd: number; windowDays: number } | null;
  /**
   * The data plane's own gauge over the ceiling's window, when this route is mounted beside a
   * live proxy handler (see setup.ts). Reused here rather than re-aggregated: the gauge is
   * already re-read from the store on its own cadence (spend_meter.ts), so a usage-page refresh
   * costs one in-memory read instead of a full-window aggregate over every run's trail. Absent
   * in tests and any mount with no data plane beside it, where a fresh aggregate is the only
   * reading there is.
   */
  gauge?: DeploymentGauge | null;
}

/** `from`/`to` off the query string, defaulted and bounded; a string is the 400's reason. */
function parseWindow(url: URL, now: Date): { from: string; to: string } | string {
  const instant = (name: string): Date | null | string => {
    const raw = url.searchParams.get(name);
    if (raw === null) return null;
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? `${name} is not a date` : new Date(ms);
  };
  const to = instant("to");
  const from = instant("from");
  if (typeof to === "string") return to;
  if (typeof from === "string") return from;
  const end = to ?? now;
  const start = from ?? new Date(end.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  if (start.getTime() >= end.getTime()) return "from must be before to";
  if (end.getTime() - start.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    return `a window spans at most ${MAX_WINDOW_DAYS} days`;
  }
  return { from: start.toISOString(), to: end.toISOString() };
}

export function usageRoutes(deps: UsageRoutesDeps): Route[] {
  const { store } = deps;

  const forRun = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticateRunRead(req, params.runId);
    if (denied) return denied;
    const overlay = priceOverlayOf(await store.listCustomProviders());
    const [rows] = await store.aggregateUsage({
      runId: params.runId,
      by: ["model"],
      tierThresholds: TIER_THRESHOLDS,
    });
    const [all] = rollUp(rows, overlay);
    return json(200, {
      runId: params.runId,
      totals: all?.totals ?? emptyTotals(),
      byModel: all?.models ?? [],
      pricing: PRICING,
    });
  };

  const forWindow = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticateWindow(req);
    if (denied) return denied;
    const window = parseWindow(new URL(req.url), deps.now());
    if (typeof window === "string") return json(400, { error: window });

    // ONE read for all five breakdowns, so every number below is summed from the same rows at
    // the same moment. Five separate reads let a row land between two of them — a stream that
    // began inside the window and ended while the report ran — and then `byAgent` totals more
    // requests and more dollars than `totals`, which the page renders as a share above 100%.
    const overlay = priceOverlayOf(await store.listCustomProviders());
    const [models, agents, keys, days, tasks] = (await store.aggregateUsage({
      ...window,
      by: DIMENSIONS,
      tierThresholds: TIER_THRESHOLDS,
    })).map((rows) => rollUp(rows, overlay));
    // The ceiling is measured over ITS window, which is the proxy's rolling one and not the
    // report's — the page asks for seven days and the ceiling still says thirty. Read off the
    // live gauge when one rides beside this route; a fresh aggregate otherwise.
    const ceiling = deps.ceiling === null ? null : {
      ...deps.ceiling,
      spentUsd: await (async () => {
        if (deps.gauge) {
          await refreshGauge(deps.gauge, store, deps.now().getTime());
          return deps.gauge.snapshot().spentUsd;
        }
        return spendInWindow(
          store,
          new Date(deps.now().getTime() - deps.ceiling!.windowDays * DAY_MS).toISOString(),
          deps.now().toISOString(),
        );
      })(),
    };

    return json(200, {
      ...window,
      ceiling,
      totals: models[0]?.totals ?? emptyTotals(),
      byModel: models[0]?.models ?? [],
      byAgent: agents.map(({ key, totals }) => {
        const platform = key?.startsWith(PLATFORM_PRINCIPAL_PREFIX) ?? false;
        return {
          agentId: platform ? null : key,
          // The platform's own background work, named by its consumer ("memory").
          consumer: platform ? key!.slice(PLATFORM_PRINCIPAL_PREFIX.length) : null,
          ...totals,
        };
      }),
      byProviderKey: keys.map(({ key, totals }) => ({ providerKeyId: key, ...totals })),
      byDay: days
        .map(({ key, totals }) => ({ day: key, ...totals }))
        .sort((a, b) => (a.day ?? "").localeCompare(b.day ?? "")),
      topTasks: tasks
        .filter((group) => group.key !== null)
        .slice(0, TOP_TASKS)
        .map(({ key, totals }) => ({ taskId: key, ...totals })),
      pricing: PRICING,
    });
  };

  return [
    route("GET", USAGE_PATHS.window, forWindow),
    route("GET", USAGE_PATHS.run, forRun),
  ];
}

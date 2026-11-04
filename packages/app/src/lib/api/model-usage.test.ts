import { describe, expect, it } from "vitest";
import {
  costLabel,
  getRunUsageState,
  getUsageReportOrOff,
  isIncluded,
  modelUsageSchema,
  usageTotalsSchema,
} from "./model-usage";
import { formatCount, formatUsd } from "$lib/utils/format";

// A run page must open whether or not the deployment meters model calls, and whether or not the
// model proxy is answering right now: the bill is a detail of that page, the run is the page.

const respond = (status: number, body: unknown) => () =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

const totals = {
  requests: 3,
  failedRequests: 1,
  meteredRequests: 2,
  unpricedRequests: 0,
  includedRequests: 0,
  tokens: { input: 300, output: 150, cacheRead: 1000, cacheWrite: 0, reasoning: 0 },
  cost: { input: 0.0006, output: 0.0015, cacheRead: 0.0002, cacheWrite: 0, total: 0.0023 },
};

const disabled = { error: "model access not configured", code: "model_access_disabled" };

describe("getRunUsageState", () => {
  it("reads the bill", async () => {
    const body = {
      runId: "r-1",
      totals,
      byModel: [{ provider: "anthropic", model: "claude-sonnet-5", ...totals }],
      pricing: { currency: "USD", source: "pi-ai 1.0.0 model catalogue, 2026-10-02" },
    };
    const fetch = respond(200, body) as unknown as typeof globalThis.fetch;
    expect(await getRunUsageState(fetch, "r-1")).toEqual({ usage: body, unavailable: false });
  });

  it("folds a deployment without model access into no bill, and says nothing is wrong", async () => {
    const fetch = respond(503, disabled) as unknown as typeof globalThis.fetch;
    expect(await getRunUsageState(fetch, "r-1")).toEqual({ usage: null, unavailable: false });
  });

  it("folds a proxy that is down into an unavailable bill", async () => {
    const fetch = respond(502, { error: "bad gateway" }) as unknown as typeof globalThis.fetch;
    expect(await getRunUsageState(fetch, "r-1")).toEqual({ usage: null, unavailable: true });
  });
});

describe("getUsageReportOrOff", () => {
  it("is null without model access, and still throws on a broken proxy", async () => {
    const off = respond(503, disabled) as unknown as typeof globalThis.fetch;
    expect(await getUsageReportOrOff(off, { from: "a", to: "b" })).toBeNull();
    const broken = respond(503, { error: "upstream unavailable" }) as unknown as typeof fetch;
    await expect(getUsageReportOrOff(broken, { from: "a", to: "b" })).rejects.toThrow(
      "upstream unavailable",
    );
  });
});

describe("formatUsd", () => {
  it("reads to the cent, and never rounds a real spend down to free", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(12.345)).toBe("$12.35");
    expect(formatUsd(0.0812)).toBe("$0.08");
    expect(formatUsd(0.0023)).toBe("<$0.01");
    expect(formatUsd(0.00001)).toBe("<$0.01");
    expect(formatCount(12_900)).toBe("12.9K");
  });
});

describe("included usage", () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

  it("defaults includedRequests to 0 for a proxy that does not send it", () => {
    const { includedRequests: _, ...before } = totals;
    expect(usageTotalsSchema.parse(before).includedRequests).toBe(0);
  });

  it("parses the included marker on a model row", () => {
    const row = modelUsageSchema.parse({
      provider: "chatgpt-plan",
      model: "gpt-5.5",
      pricing: "included",
      ...totals,
      cost: zero,
    });
    expect(row.pricing).toBe("included");
    expect(costLabel(row)).toBe("Included");
  });

  it("reads totals that are all included as Included, never $0.00", () => {
    const t = usageTotalsSchema.parse({ ...totals, includedRequests: 2, cost: zero });
    expect(isIncluded(t)).toBe(true);
    expect(costLabel(t)).toBe("Included");
  });

  it("shows the priced cost of a mix, and the old answers otherwise", () => {
    const mixed = usageTotalsSchema.parse({ ...totals, includedRequests: 1 });
    expect(isIncluded(mixed)).toBe(false);
    expect(costLabel(mixed)).toBe(formatUsd(totals.cost.total));
    const unpriced = usageTotalsSchema.parse({ ...totals, unpricedRequests: 2, cost: zero });
    expect(costLabel(unpriced)).toBe("Unpriced");
  });
});

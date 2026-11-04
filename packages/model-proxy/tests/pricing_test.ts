// The money: catalogue lookup, long-context tiers, 1h cache writes, and the roll-up that prices
// each tier bucket before it sums anything.

import { test } from "bun:test";
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  catalogueModels,
  costOf,
  priceFor,
  priceOverlayOf,
  pricingOf,
  ratesAt,
  TIER_THRESHOLDS,
  tierFloorOf,
  type TokenCounts,
} from "../src/core/pricing.ts";
import { rollUp, type UsageAggregateRow } from "../src/core/usage_report.ts";

const tokens = (over: Partial<TokenCounts>): TokenCounts => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  reasoning: 0,
  ...over,
});

test("priceFor: exact ids, a dated snapshot of a listed alias, and nothing else", () => {
  assertEquals(priceFor("anthropic", "claude-sonnet-5")?.input, 2);
  assertEquals(priceFor("anthropic", "claude-sonnet-5-20260801")?.input, 2);
  assertEquals(priceFor("openai", "gpt-5.5-2026-08-01")?.output, 30);
  assertEquals(priceFor("openai", "claude-sonnet-5"), null, "catalogues are per provider");
  assertEquals(priceFor("anthropic", "claude-mystery-9"), null);
  assertEquals(priceFor("anthropic", null), null);
  assertEquals(priceFor("anthropic", "constructor"), null, "no prototype keys");
  assertEquals(priceFor("nope", "gpt-5"), null);
});

test("tier buckets: the catalogue's thresholds, highest first, and the floor a request lands in", () => {
  assert(TIER_THRESHOLDS.includes(272_000));
  assertEquals([...TIER_THRESHOLDS], [...TIER_THRESHOLDS].sort((a, b) => b - a));
  assertEquals(tierFloorOf(272_000, [272_000]), 0, "the threshold itself is not above it");
  assertEquals(tierFloorOf(272_001), 272_000);
  assertEquals(tierFloorOf(500_000, [400_000, 100_000]), 400_000);
  assertEquals(tierFloorOf(200_000, [400_000, 100_000]), 100_000);

  const price = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
  const tiered = {
    ...price,
    tiers: [
      { inputTokensAbove: 100_000, input: 2, output: 2, cacheRead: 2, cacheWrite: 2 },
      { inputTokensAbove: 400_000, input: 3, output: 3, cacheRead: 3, cacheWrite: 3 },
    ],
  };
  assertEquals(ratesAt(tiered, 0).input, 1);
  assertEquals(ratesAt(tiered, 100_000).input, 2);
  assertEquals(ratesAt(tiered, 400_000).input, 3);
  // A bucket floor from ANOTHER model's threshold still resolves to this model's right tier.
  assertEquals(ratesAt(tiered, 272_000).input, 2);
  assertEquals(ratesAt(price, 400_000).input, 1);
});

test("costOf: per-million rates per token kind, 1h cache writes at twice base input", () => {
  const sonnet = priceFor("anthropic", "claude-sonnet-5")!; // 2 / 10 / 0.2 / 2.5
  const cost = costOf(
    sonnet,
    tokens({
      input: 1_000_000,
      output: 100_000,
      cacheRead: 2_000_000,
      cacheWrite: 400_000,
      cacheWrite1h: 100_000,
      reasoning: 50_000,
    }),
    0,
  );
  assertAlmostEquals(cost.input, 2);
  assertAlmostEquals(cost.output, 1);
  assertAlmostEquals(cost.cacheRead, 0.4);
  assertAlmostEquals(cost.cacheWrite, 300_000 * 2.5e-6 + 100_000 * 4e-6);
  assertAlmostEquals(cost.total, 2 + 1 + 0.4 + 0.75 + 0.4);

  const gpt = priceFor("openai", "gpt-5.5")!; // 5 / 30, above 272k: 10 / 45
  assertAlmostEquals(costOf(gpt, tokens({ input: 1_000_000 }), 0).input, 5);
  assertAlmostEquals(costOf(gpt, tokens({ input: 1_000_000 }), 272_000).input, 10);
});

const row = (over: Partial<UsageAggregateRow>): UsageAggregateRow => ({
  key: null,
  provider: "openai",
  model: "gpt-5.5",
  tierFloor: 0,
  requests: 1,
  failedRequests: 0,
  meteredRequests: 1,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  reasoningTokens: 0,
  ...over,
});

test("rollUp prices each tier bucket apart, counts unpriced and unmetered requests honestly", () => {
  const groups = rollUp([
    row({ key: "a-1", inputTokens: 1_000_000 }), // $5
    row({
      key: "a-1",
      tierFloor: 272_000,
      requests: 2,
      meteredRequests: 2,
      inputTokens: 1_000_000,
    }), // $10
    row({ key: "a-1", provider: "anthropic", model: "claude-mystery-9", inputTokens: 999 }),
    row({ key: "a-1", model: null, requests: 3, failedRequests: 3, meteredRequests: 0 }),
    row({ key: "a-2", provider: "anthropic", model: "claude-sonnet-5", outputTokens: 100_000 }), // $1
  ]);
  assertEquals(groups.map((g) => g.key), ["a-1", "a-2"], "highest cost first");

  const [a1, a2] = groups;
  assertAlmostEquals(a1.totals.cost.total, 15);
  assertEquals(a1.totals.requests, 7);
  assertEquals(a1.totals.failedRequests, 3);
  assertEquals(a1.totals.meteredRequests, 4);
  assertEquals(a1.totals.unpricedRequests, 1);
  assertEquals(a1.totals.tokens.input, 2_000_999, "an unpriced model's tokens still count");
  // Equal cost (none) falls back to the busier model first.
  assertEquals(a1.models.map((m) => m.model), ["gpt-5.5", null, "claude-mystery-9"]);
  assertAlmostEquals(a1.models[0].cost.total, 15);
  assertEquals(a1.models[0].requests, 3);
  assertAlmostEquals(a2.totals.cost.output, 1);
  assertEquals(rollUp([]), []);
});

test("a ChatGPT plan's usage is included: metered, $0, and said so", () => {
  assertEquals(priceFor("chatgpt-plan", "gpt-6.1-sol"), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assertEquals(priceFor("chatgpt-plan", null), null, "no model is still no price");
  assertEquals(pricingOf("chatgpt-plan", "anything"), "included");
  assertEquals(pricingOf("openai", "gpt-5"), "priced");
  assertEquals(pricingOf("openai", "gpt-mystery"), "unpriced");

  const [all] = rollUp([
    row({ key: null, provider: "chatgpt-plan", model: "gpt-6.1-sol", inputTokens: 5_000_000 }),
    row({ key: null, provider: "anthropic", model: "claude-mystery-9", inputTokens: 10 }),
    row({ key: null, outputTokens: 1_000_000 }),
  ]);
  assertEquals(all.totals.includedRequests, 1);
  assertEquals(all.totals.unpricedRequests, 1);
  assertEquals(all.totals.tokens.input, 5_000_010, "included tokens are counted");
  const plan = all.models.find((m) => m.provider === "chatgpt-plan")!;
  assertEquals(plan.pricing, "included");
  assertEquals(plan.cost.total, 0);
  assertEquals(plan.includedRequests, 1);
  assertEquals(all.models.find((m) => m.model === "claude-mystery-9")?.pricing, "unpriced");
  assertEquals(all.models.find((m) => m.provider === "openai")?.pricing, "priced");
});

// ── declared prices ────────────────────────────────────────────────────────────────────────

const RATES = { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1.25 };

const GROQ = {
  id: "groq",
  models: [
    { id: "llama-4", price: RATES },
    // Declared, but with no rates: an admin who did not fill them in gets "unpriced", not "free".
    { id: "llama-4-mystery" },
  ],
};

test("priceOverlayOf: only the declared models that carry rates, keyed by provider id", () => {
  const overlay = priceOverlayOf([GROQ]);
  assertEquals(Object.keys(overlay), ["groq"]);
  assertEquals(Object.keys(overlay.groq), ["llama-4"]);
  assertEquals(overlay.groq["llama-4"], RATES);
  // A provider whose every model is priceless contributes no entry at all.
  assertEquals(priceOverlayOf([{ id: "vllm", models: [{ id: "qwen" }] }]), {});
  assertEquals(priceOverlayOf([]), {});
});

test("priceFor: the overlay is checked first, and only for its own provider id", () => {
  const overlay = priceOverlayOf([GROQ, {
    // A row can never take a built-in's id (the ingest schema refuses it), so this can only
    // happen to a catalogue name that is not a provider — and it still must not leak sideways.
    id: "groq-eu",
    models: [{ id: "claude-sonnet-5", price: { ...RATES, input: 99 } }],
  }]);
  assertEquals(priceFor("groq", "llama-4", overlay)?.output, 3);
  assertEquals(priceFor("groq", "llama-4-mystery", overlay), null, "declared, but unpriced");
  assertEquals(priceFor("groq", "llama-4"), null, "and nothing without the overlay");
  // The static catalogue is untouched by an overlay for another provider.
  assertEquals(priceFor("anthropic", "claude-sonnet-5", overlay)?.input, 2);
  // A dated snapshot of a declared id still resolves to its declaration.
  assertEquals(priceFor("groq", "llama-4-2026-01-01", overlay)?.input, 1);
});

test("rollUp with an overlay prices declared models and counts priceless ones as unpriced", () => {
  const overlay = priceOverlayOf([GROQ]);
  const [group] = rollUp([
    row({ key: "a-1", provider: "groq", model: "llama-4", inputTokens: 1_000_000 }),
    row({ key: "a-1", provider: "groq", model: "llama-4-mystery", outputTokens: 500 }),
  ], overlay);
  assertAlmostEquals(group.totals.cost.total, 1);
  assertEquals(group.totals.unpricedRequests, 1);
  assertEquals(group.totals.tokens.output, 500, "an unpriced model's tokens still count");
  // Without the overlay both are unpriced — the declaration is the only price there is.
  const [bare] = rollUp([row({ key: "a-1", provider: "groq", model: "llama-4" })]);
  assertEquals(bare.totals.unpricedRequests, 1);
  assertEquals(bare.totals.cost.total, 0);
});

test("catalogueModels: the price list's models, dated snapshots folded into their alias", () => {
  const ids = catalogueModels("anthropic").map((m) => m.id);
  assert(ids.includes("claude-haiku-4-5"));
  assert(!ids.includes("claude-haiku-4-5-20251001"), "priced the same as its alias");
  const openai = catalogueModels("openai").map((m) => m.id);
  assert(!openai.includes("gpt-4o-2024-08-06"), "priced the same as gpt-4o");
  assert(openai.includes("gpt-4o-2024-05-13"), "priced on its own, so a choice of its own");
  const gpt54 = catalogueModels("openai").find((m) => m.id === "gpt-5.4");
  assertEquals(gpt54?.price, { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 });
  assertEquals(catalogueModels("groq"), []);
});

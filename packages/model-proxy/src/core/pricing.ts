// Pricing, as pure functions of a model's catalogue entry and a request's tokens — what turns the
// metering trail into money. Applied at READ time: rows hold tokens only, so a price edit in the
// catalogue re-prices everything already recorded, which is what a hand-kept list wants.
//
// Invariants:
// - a price applies PER REQUEST. Long-context tiers switch on one request's input size, so summed
//   tokens can only be priced once it is known which requests crossed a threshold — the store
//   buckets its sums by `tierFloorOf` for exactly that reason.
// - an unknown model is UNPRICED, never free: `priceFor` answers null and the report counts it.
//   That holds for a DECLARED model with no price too — an admin who left the rates off gets a
//   report that says "unpriced", never one that quietly says a self-hosted model was free.
// - every rate is USD per million tokens, the unit providers publish in.
// - an INCLUDED model — one a ChatGPT plan's usage pays for — is the third answer, neither priced
//   nor unpriced: its tokens are metered like any other, it costs $0, and since nothing about it
//   can run a bill up, no spend cap ever refuses it (see enforce.ts).

import { CHATGPT_PLAN } from "./chatgpt_plan.ts";
import { PRICE_CATALOGUE } from "./pricing_catalogue.ts";
import { THINKING_CATALOGUE } from "./thinking_catalogue.ts";
import type { DeclaredModel, ProviderSpec } from "./registry.ts";

export interface PriceRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelPrice extends PriceRates {
  /** Rates for a request whose total input (uncached + cache read + cache write) is above
   * `inputTokensAbove`; the highest threshold crossed wins. */
  tiers?: ReadonlyArray<PriceRates & { inputTokensAbove: number }>;
}

/** One request's tokens, normalized across providers. */
export interface TokenCounts {
  /** Uncached input only: cache reads and writes are never in here, whatever the provider's own
   * input figure included. */
  input: number;
  output: number;
  cacheRead: number;
  /** Every cache write, 1h-retention ones included. */
  cacheWrite: number;
  /** The part of `cacheWrite` written with 1h retention — Anthropic only, billed at twice the
   * base input rate. */
  cacheWrite1h: number;
  /** Reasoning tokens: a part of `output`, shown on its own but never priced separately. */
  reasoning: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export const ZERO_COST: Readonly<CostBreakdown> = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
};

/** A dated snapshot id (`gpt-4o-2024-08-06`, `claude-haiku-4-5-20251001`) falls back to its alias
 * when the catalogue lists only the alias. */
const DATE_SUFFIX = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;

function sameRates(a: ModelPrice, b: ModelPrice): boolean {
  return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite &&
    JSON.stringify(a.tiers ?? []) === JSON.stringify(b.tiers ?? []);
}

/**
 * A built-in provider's models as the price list knows them, for a UI to offer as choices. A
 * dated snapshot is folded into its alias when the two cost the same — choosing either is then
 * the same choice — and kept when it is priced on its own (`gpt-4o-2024-05-13` is not `gpt-4o`).
 * Long-context tiers are not carried: `DeclaredModel.price` holds the base rates only. Each
 * carries the thinking levels pi's catalogue says it takes, where that says (thinking.ts).
 */
export function catalogueModels(provider: string): DeclaredModel[] {
  if (!Object.hasOwn(PRICE_CATALOGUE, provider)) return [];
  const models = PRICE_CATALOGUE[provider];
  const levels = Object.hasOwn(THINKING_CATALOGUE, provider) ? THINKING_CATALOGUE[provider] : {};
  return Object.entries(models)
    .filter(([id, price]) => {
      const alias = id.replace(DATE_SUFFIX, "");
      return alias === id || !Object.hasOwn(models, alias) || !sameRates(price, models[alias]);
    })
    .map(([id, { input, output, cacheRead, cacheWrite }]) => ({
      id,
      ...(Object.hasOwn(levels, id) ? { thinkingLevels: [...levels[id]] } : {}),
      price: { input, output, cacheRead, cacheWrite },
    }));
}

/**
 * Prices a custom endpoint DECLARED for its own models, in the catalogue's shape and keyed the
 * same way. Built from rows at read time rather than merged into the static list, because the
 * static list is a hand-kept artefact of one pi release and an admin's rates are not: keeping
 * them apart means neither can quietly overwrite the other on a deploy.
 */
export type PriceOverlay = Record<string, Record<string, ModelPrice>>;

/**
 * Every declared model with a price, as an overlay. ARCHIVED endpoints belong in here as much as
 * live ones: a report over last month prices rows that were spent while the endpoint still
 * existed, and dropping them would re-price history as unpriced. A model whose admin left the
 * rates off contributes nothing at all — which is what makes it report as unpriced rather than
 * as free.
 */
export function priceOverlayOf(
  providers: ReadonlyArray<Pick<ProviderSpec, "id"> & { models: readonly DeclaredModel[] }>,
): PriceOverlay {
  const overlay: PriceOverlay = Object.create(null);
  for (const provider of providers) {
    const models: Record<string, ModelPrice> = Object.create(null);
    for (const model of provider.models) {
      if (model.price !== undefined) models[model.id] = { ...model.price };
    }
    if (Object.keys(models).length > 0) overlay[provider.id] = models;
  }
  return overlay;
}

/** One catalogue's lookup: the exact id, else the alias a dated snapshot hangs off. */
function lookup(models: Record<string, ModelPrice>, model: string): ModelPrice | null {
  if (Object.hasOwn(models, model)) return models[model];
  const alias = model.replace(DATE_SUFFIX, "");
  return alias !== model && Object.hasOwn(models, alias) ? models[alias] : null;
}

/**
 * The rates for one provider's model: the request's OVERLAY first, then the static catalogue, so
 * a custom endpoint's declared price always wins for its own provider id — and a built-in can
 * never be re-priced by a row, because no custom endpoint may take a built-in's id.
 */
export function priceFor(
  provider: string,
  model: string | null,
  overlay?: PriceOverlay,
): ModelPrice | null {
  if (model === null) return null;
  if (included(provider)) return INCLUDED_PRICE;
  if (overlay !== undefined && Object.hasOwn(overlay, provider)) {
    const declared = lookup(overlay[provider], model);
    if (declared !== null) return declared;
  }
  return Object.hasOwn(PRICE_CATALOGUE, provider) ? lookup(PRICE_CATALOGUE[provider], model) : null;
}

/** The rates of a model a plan's usage pays for: all zero, and known to be. */
export const INCLUDED_PRICE: Readonly<ModelPrice> = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/** Whether a provider's usage is included in a subscription rather than billed per token. */
export function included(provider: string): boolean {
  return provider === CHATGPT_PLAN;
}

/** How a model's usage is reported: at list `priced`, `included` in a plan, or `unpriced`. */
export type PricingKind = "priced" | "included" | "unpriced";

export function pricingOf(
  provider: string,
  model: string | null,
  overlay?: PriceOverlay,
): PricingKind {
  if (included(provider)) return "included";
  return priceFor(provider, model, overlay) === null ? "unpriced" : "priced";
}

/** Every distinct tier threshold in the catalogue, highest first — the buckets the store sums in. */
export const TIER_THRESHOLDS: readonly number[] = [
  ...new Set(
    Object.values(PRICE_CATALOGUE).flatMap((models) =>
      Object.values(models).flatMap((price) =>
        (price.tiers ?? []).map((tier) => tier.inputTokensAbove).filter((t) => t > 0)
      )
    ),
  ),
].sort((a, b) => b - a);

/**
 * The highest threshold a request's total input exceeded, 0 for none. Exact for every model even
 * though it is computed against ALL models' thresholds: a model's own threshold is always one of
 * them, so "exceeded this bucket's floor" and "exceeded that model's threshold" never disagree.
 */
export function tierFloorOf(totalInput: number, thresholds = TIER_THRESHOLDS): number {
  for (const threshold of thresholds) if (totalInput > threshold) return threshold;
  return 0;
}

/** The rates for requests in one tier bucket: the highest tier at or below the floor, else base. */
export function ratesAt(price: ModelPrice, tierFloor: number): PriceRates {
  let rates: PriceRates = price;
  let best = 0;
  for (const tier of price.tiers ?? []) {
    if (tier.inputTokensAbove > best && tier.inputTokensAbove <= tierFloor) {
      rates = tier;
      best = tier.inputTokensAbove;
    }
  }
  return rates;
}

const PER_MILLION = 1 / 1_000_000;

/** What `tokens` cost at `price`, for requests that all fell in the `tierFloor` bucket. */
export function costOf(price: ModelPrice, tokens: TokenCounts, tierFloor: number): CostBreakdown {
  const rates = ratesAt(price, tierFloor);
  const longWrite = Math.min(tokens.cacheWrite1h, tokens.cacheWrite);
  const input = tokens.input * rates.input * PER_MILLION;
  const output = tokens.output * rates.output * PER_MILLION;
  const cacheRead = tokens.cacheRead * rates.cacheRead * PER_MILLION;
  const cacheWrite =
    ((tokens.cacheWrite - longWrite) * rates.cacheWrite + longWrite * rates.input * 2) *
    PER_MILLION;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

// The price list: USD per million tokens, per provider, per model id.
//
// Sourced from the model data bundled with @earendil-works/pi-ai, the pi release the agent image
// installs (`providers/data/{anthropic,openai}.json`; last refreshed from 1.5.0 on 2026-11-04),
// and hand-kept between refreshes: a new model or a price change is a one-line edit, and because
// pricing is applied at read time, an edit re-prices the whole trail, history included.
//
// Only the providers the proxy forwards to are listed. A model missing here is not free — its
// requests are reported as unpriced (see pricing.ts).
//
// `tiers` are long-context rates: they replace the base rates for a request whose total input
// (uncached + cache read + cache write) exceeds `inputTokensAbove`.

import type { ModelPrice } from "./pricing.ts";

/** Where the numbers below came from, as the usage surface reports it. */
export const PRICING_SOURCE = "pi-ai 1.5.0 model catalogue, 2026-11-04";

export const PRICE_CATALOGUE: Readonly<Record<string, Readonly<Record<string, ModelPrice>>>> = {
  anthropic: {
    "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    "claude-haiku-5-5": {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      tiers: [{
        inputTokensAbove: 100000,
        input: 0.5,
        output: 2.5,
        cacheRead: 0.05,
        cacheWrite: 0.625,
      }],
    },
    "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-opus-4-5-20251101": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-sonnet-4-5-20250929": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  },
  openai: {
    "chat-latest": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    "gpt-4": { input: 30, output: 60, cacheRead: 0, cacheWrite: 0 },
    "gpt-4-turbo": { input: 10, output: 30, cacheRead: 0, cacheWrite: 0 },
    "gpt-4.1": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
    "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0 },
    "gpt-4.1-nano": { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0 },
    "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
    "gpt-4o-2024-05-13": { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 },
    "gpt-4o-2024-08-06": { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
    "gpt-4o-2024-11-20": { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
    "gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
    "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
    "gpt-5-chat-latest": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
    "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
    "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 },
    "gpt-5-pro": { input: 15, output: 120, cacheRead: 0, cacheWrite: 0 },
    "gpt-5.1": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
    "gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
    "gpt-5.2-pro": { input: 21, output: 168, cacheRead: 0, cacheWrite: 0 },
    "gpt-5.3-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
    "gpt-5.3-codex-spark": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
    "gpt-5.4": {
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 272000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0 }],
    },
    "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
    "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
    "gpt-5.4-pro": {
      input: 30,
      output: 180,
      cacheRead: 0,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 272000, input: 60, output: 270, cacheRead: 0, cacheWrite: 0 }],
    },
    "gpt-5.5": {
      input: 5,
      output: 30,
      cacheRead: 0.5,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 0 }],
    },
    "gpt-5.5-pro": {
      input: 30,
      output: 180,
      cacheRead: 0,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 272000, input: 60, output: 270, cacheRead: 0, cacheWrite: 0 }],
    },
    "gpt-5.6-luna": {
      input: 0.2,
      output: 1.2,
      cacheRead: 0.02,
      cacheWrite: 0.25,
      tiers: [{
        inputTokensAbove: 272000,
        input: 0.4,
        output: 1.8,
        cacheRead: 0.04,
        cacheWrite: 0.5,
      }],
    },
    "gpt-5.6-sol": {
      input: 4,
      output: 20,
      cacheRead: 0.4,
      cacheWrite: 5,
      tiers: [{ inputTokensAbove: 272000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 }],
    },
    "gpt-5.6-terra": {
      input: 2,
      output: 12,
      cacheRead: 0.2,
      cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 }],
    },
    "gpt-5.6-cyber": { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 15.625 },
    "gpt-6-astra": {
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
      tiers: [{ inputTokensAbove: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
    },
    "gpt-6-luna": {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      tiers: [{
        inputTokensAbove: 272000,
        input: 0.2,
        output: 0.75,
        cacheRead: 0.02,
        cacheWrite: 0.25,
      }],
    },
    "gpt-6-sol": {
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }],
    },
    "gpt-6.1-sol": {
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
    },
    "gpt-6.1-terra": {
      input: 1,
      output: 5,
      cacheRead: 0.05,
      cacheWrite: 1.25,
      tiers: [{ inputTokensAbove: 272000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 }],
    },
    "gpt-daybreak-blue-latest": {
      input: 4,
      output: 20,
      cacheRead: 0.4,
      cacheWrite: 5,
      tiers: [{ inputTokensAbove: 272000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 }],
    },
    "gpt-daybreak-red-latest": { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 15.625 },
    "o1": { input: 15, output: 60, cacheRead: 7.5, cacheWrite: 0 },
    "o1-pro": { input: 150, output: 600, cacheRead: 0, cacheWrite: 0 },
    "o3": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
    "o3-mini": { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 0 },
    "o3-pro": { input: 20, output: 80, cacheRead: 0, cacheWrite: 0 },
    "o4-mini": { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 0 },
  },
};

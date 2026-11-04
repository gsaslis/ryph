// The thinking levels each built-in model takes, per provider, per model id — what the
// pickers offer for it.
//
// Sourced from the model data bundled with @earendil-works/pi-ai, the pi release the agent
// image installs (`providers/data/{anthropic,openai}.json`; last refreshed from 1.5.0 on
// 2026-11-04), and hand-kept between refreshes like the price list (pricing_catalogue.ts),
// refreshed from the same release. A model's levels are pi-ai's `getSupportedThinkingLevels`:
// `off` alone if it does not reason; otherwise every level its `thinkingLevelMap` does not map
// to null, with `xhigh` and `max` only where the map names them. A model missing here has
// levels nobody knows: every level is offered, and pi clamps the one picked to what the model
// takes.

import type { ThinkingLevel } from "./thinking.ts";

export const THINKING_CATALOGUE: Readonly<
  Record<string, Readonly<Record<string, readonly ThinkingLevel[]>>>
> = {
  anthropic: {
    "claude-fable-5": ["minimal", "low", "medium", "high", "xhigh", "max"],
    "claude-fable-5-1": ["minimal", "low", "medium", "high", "xhigh", "max"],
    "claude-haiku-4-5": ["off", "minimal", "low", "medium", "high"],
    "claude-haiku-4-5-20251001": ["off", "minimal", "low", "medium", "high"],
    "claude-haiku-5-5": ["off", "low", "medium", "high", "xhigh", "max"],
    "claude-opus-4-5": ["off", "minimal", "low", "medium", "high"],
    "claude-opus-4-5-20251101": ["off", "minimal", "low", "medium", "high"],
    "claude-opus-4-6": ["off", "minimal", "low", "medium", "high", "max"],
    "claude-opus-4-7": ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    "claude-opus-4-8": ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    "claude-opus-5": ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    "claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
    "claude-sonnet-4-5": ["off", "minimal", "low", "medium", "high"],
    "claude-sonnet-4-5-20250929": ["off", "minimal", "low", "medium", "high"],
    "claude-sonnet-4-6": ["off", "minimal", "low", "medium", "high", "max"],
    "claude-sonnet-5": ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    "claude-sonnet-5-5": ["low", "medium", "high", "xhigh", "max"],
  },
  openai: {
    "chat-latest": ["off", "minimal", "low", "medium", "high"],
    "gpt-4": ["off"],
    "gpt-4-turbo": ["off"],
    "gpt-4.1": ["off"],
    "gpt-4.1-mini": ["off"],
    "gpt-4.1-nano": ["off"],
    "gpt-4o": ["off"],
    "gpt-4o-2024-05-13": ["off"],
    "gpt-4o-2024-08-06": ["off"],
    "gpt-4o-2024-11-20": ["off"],
    "gpt-4o-mini": ["off"],
    "gpt-5": ["minimal", "low", "medium", "high"],
    "gpt-5-chat-latest": ["off"],
    "gpt-5-mini": ["minimal", "low", "medium", "high"],
    "gpt-5-nano": ["minimal", "low", "medium", "high"],
    "gpt-5-pro": ["high"],
    "gpt-5.1": ["off", "low", "medium", "high"],
    "gpt-5.2": ["off", "low", "medium", "high", "xhigh"],
    "gpt-5.2-pro": ["medium", "high", "xhigh"],
    "gpt-5.3-codex": ["off", "low", "medium", "high", "xhigh"],
    "gpt-5.3-codex-spark": ["low", "medium", "high", "xhigh"],
    "gpt-5.4": ["off", "low", "medium", "high", "xhigh"],
    "gpt-5.4-mini": ["off", "low", "medium", "high", "xhigh"],
    "gpt-5.4-nano": ["off", "low", "medium", "high", "xhigh"],
    "gpt-5.4-pro": ["medium", "high", "xhigh"],
    "gpt-5.5": ["off", "low", "medium", "high", "xhigh"],
    "gpt-5.5-pro": ["medium", "high", "xhigh"],
    "gpt-5.6-luna": ["off", "low", "medium", "high", "xhigh", "max"],
    "gpt-5.6-sol": ["off", "low", "medium", "high", "xhigh", "max"],
    "gpt-5.6-terra": ["off", "low", "medium", "high", "xhigh", "max"],
    "gpt-5.6-cyber": ["low", "medium", "high", "xhigh", "max"],
    "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
    "gpt-6-luna": ["off", "low", "medium", "high", "xhigh", "max"],
    "gpt-6-sol": ["off", "low", "medium", "high", "xhigh", "max"],
    "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"],
    "gpt-6.1-terra": ["off", "low", "medium", "high", "xhigh", "max"],
    "gpt-daybreak-blue-latest": ["off", "low", "medium", "high", "xhigh", "max"],
    "gpt-daybreak-red-latest": ["off", "low", "medium", "high", "xhigh", "max"],
    "o1": ["low", "medium", "high"],
    "o1-pro": ["low", "medium", "high"],
    "o3": ["low", "medium", "high"],
    "o3-mini": ["low", "medium", "high"],
    "o3-pro": ["low", "medium", "high"],
    "o4-mini": ["low", "medium", "high"],
  },
};

// Imports nothing through `$lib`, and only the import-free level list: @ryph/host's tests reach
// this file by path to pin the rule below against the models.json the runner really writes.
import { THINKING_LEVELS, type ThinkingLevel } from "../../api/thinking-levels";

export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** What the rule reads of a model on the provider list (`DeclaredModel`). */
export type LevelledModel = {
  id: string;
  reasoning?: boolean;
  thinkingLevels?: readonly ThinkingLevel[];
};

/** The levels pi gives a reasoning model with no levels named (pi-ai's
 * `getSupportedThinkingLevels`): every one but `xhigh` and `max`, which must be named to exist. */
export const PI_DEFAULT_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
];

/**
 * The levels to offer for one model id out of a model list. The proxy lists only what is known —
 * a built-in's levels from pi's catalogue, a plan model's from its account's list, a custom
 * endpoint's as declared — and fills nothing in, so what absent levels mean is decided here, by
 * whose model it is (`declaredToPi`):
 *
 * - pi's own catalogue (a built-in): a model with no levels, or one the list does not name, is
 *   not known. Every level is offered, and pi clamps the pick.
 * - Declared to pi (a custom endpoint, a ChatGPT plan): the runner writes the model into pi's
 *   models.json, and pi's defaults are the truth (pi-coding-agent's `reasoning ?? false`, then
 *   pi-ai's `getSupportedThinkingLevels`): `off` through `high` for a model that reasons, `off`
 *   alone for one that does not or does not say. A model the list does not name (a typed-in id,
 *   a plan key whose model list never came back) reaches pi as its id alone, so `off` alone too.
 *
 * No model at all ("" — the harness picks) is open either way.
 */
export function thinkingLevelsFor(
  models: readonly LevelledModel[],
  modelId: string,
  declaredToPi: boolean,
): readonly ThinkingLevel[] {
  const id = modelId.trim();
  if (id === "") return THINKING_LEVELS;
  const model = models.find((m) => m.id === id);
  if (model?.thinkingLevels !== undefined) return model.thinkingLevels;
  if (declaredToPi) return model?.reasoning === true ? PI_DEFAULT_LEVELS : ["off"];
  return model?.reasoning === false ? ["off"] : THINKING_LEVELS;
}

/** False for a model that takes no level but off: there is nothing to pick, so no control. */
export function offersThinking(levels: readonly ThinkingLevel[]): boolean {
  return levels.some((level) => level !== "off");
}

/** A picked level the model does not list. Kept and flagged, never coerced — pi clamps it. */
export function thinkingInvalid(
  value: ThinkingLevel | null,
  levels: readonly ThinkingLevel[],
): boolean {
  return value !== null && !levels.includes(value);
}

/** What is sent: the pick, or nothing where the model offers no level to pick. */
export function thinkingToSend(
  value: ThinkingLevel | null,
  levels: readonly ThinkingLevel[],
): ThinkingLevel | null {
  return offersThinking(levels) ? value : null;
}

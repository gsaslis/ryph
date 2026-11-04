// Thinking levels: how hard a model is asked to reason, in pi's vocabulary — the one word a
// person picks (an agent's default, a task's override) and the one the runner hands pi as
// `--thinking`. Which levels a model takes is knowledge about the MODEL, so it lives here beside
// the price list: a built-in's come from pi's own catalogue (thinking_catalogue.ts), a custom
// endpoint's from what its admin declared, a ChatGPT plan's from the account's model list.
//
// The proxy says only what is known: a built-in's levels from the table, a plan model's from
// its account's list, a custom model's as stored. It never fills in a default, so what an
// endpoint's admin left unsaid stays unsaid, and an edit loaded from any read saves back what
// was declared. What absent levels then mean depends on whose model it is, and the app's
// pickers apply it (`thinkingLevelsFor`): a built-in pi's catalogue lacks is not known, so every
// level is offered; a custom endpoint's or a plan's is written into pi's models.json by the
// runner, where pi's own defaults decide — `off` alone unless it reasons, `off` through `high`
// if it does. Nothing is refused on these grounds: pi clamps whatever it is handed to the
// nearest level the model takes (pi-ai's `clampThinkingLevel`).

/**
 * pi's thinking levels (pi-ai 1.1.0's `ModelThinkingLevel`), least to most. @ryph/orchestrator,
 * @ryph/runner and the app each spell the same list, and tests pin them to this one.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

/** Levels in pi's order, once each — the canonical spelling of a set of them. */
export function orderedLevels(levels: Iterable<string>): ThinkingLevel[] {
  const given = new Set(levels);
  return THINKING_LEVELS.filter((level) => given.has(level));
}

/**
 * The levels a ChatGPT plan model takes, from the efforts the account's model list says it
 * takes (`PlanModel.reasoningEfforts`). The Responses API's `none` is pi's `off`; every other
 * effort pi names alike, and one it does not know is no level at all. A model that lists no
 * `none` cannot switch reasoning off, so `off` is not among its levels — the proxy fits a
 * request for it to the lightest effort the model lists (`nearestEffort`).
 */
export function planThinkingLevels(efforts: readonly string[]): ThinkingLevel[] {
  return orderedLevels(efforts.map((effort) => effort === "none" ? "off" : effort));
}

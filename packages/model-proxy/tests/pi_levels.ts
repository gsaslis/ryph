// pi-ai's `getSupportedThinkingLevels` (1.1.0 `dist/models.js`), restated for the tests that
// check a table or a models.json against it: pi is not in the workspace, so its rule is not
// importable. Keep it in step with the pi release the agent image installs.

import { THINKING_LEVELS, type ThinkingLevel } from "../src/core/thinking.ts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A model that does not reason takes `off` alone; one that does takes every level but those its
 * `thinkingLevelMap` maps to null, and `xhigh` and `max` only where the map names them at all.
 */
export function supportedLevels(model: Json): ThinkingLevel[] {
  if (model.reasoning !== true) return ["off"];
  const map = isObject(model.thinkingLevelMap) ? model.thinkingLevelMap : {};
  return THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

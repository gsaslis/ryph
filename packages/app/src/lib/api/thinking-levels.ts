/**
 * How hard a model is asked to think, in pi's words, least to most. A wire contract duplicated
 * from @ryph/model-proxy's `THINKING_LEVELS` (the orchestrator and the runner spell it too); the
 * app does not import the server packages. It imports nothing at all, so that @ryph/host's tests
 * can reach it by path and pin it, and the picker rule built on it, to what the runner writes.
 * Which levels one model takes is on the provider list, per model (`DeclaredModel.thinkingLevels`).
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

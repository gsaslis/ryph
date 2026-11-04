/**
 * The runner's own operational voice — the machinery's story, not the run's.
 *
 * This is deliberately NOT the Orchestrator (semantic progress the caller acts on)
 * and NOT the Narrator (the agent's transcript, an inspection artifact).
 * Diagnostics carries what only a developer or operator wants:
 * phase transitions, and the failures the core swallows to stay alive —
 * a broken gateway, a dropped transcript chunk, an unavailable memory snapshot.
 *
 * `event` is a short, stable, dot-namespaced key ("orchestrator.reportProgress.failed"), not prose —
 * so lines stay greppable and aggregatable.
 *
 * `fields` is structured context;
 * an `err` field, if present, is understood to be a caught throwable and rendered losslessly by the adapter.
 *
 * Invariants:
 * - no error level by design: a failure that kills the run is thrown, not logged —
 *   the rejected promise / non-zero exit is the run's outcome.
 *   `warn` is only for failures the core swallows.
 * - adapters MUST be total: every method swallows its own faults and returns promptly,
 *   so the core calls them unwrapped, even from inside catch blocks
 * - a diagnostics sink can neither throw nor block a run — a sink that can fail is a broken sink
 */
export interface Diagnostics {
  /** Routine machinery events: phase entries, best-effort degradations worth a trace. */
  debug(event: string, fields?: Record<string, unknown>): void;
  /** A swallowed failure: the run continues, but a developer would want to see this. */
  warn(event: string, fields?: Record<string, unknown>): void;
}

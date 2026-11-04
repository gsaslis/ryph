/** Structured, side-channel observability — the same two-level shape the mailroom uses, so
 * one logger serves both. */
export interface Diagnostics {
  debug(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

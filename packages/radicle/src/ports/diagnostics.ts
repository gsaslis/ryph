// The machinery's own log, total by contract: a diagnostics call may never throw into a caller.

export interface Diagnostics {
  debug(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
}

/** A sink that says nothing — the default for fixtures and for code paths with no tracer. */
export const SILENT_DIAGNOSTICS: Diagnostics = { debug() {}, warn() {} };

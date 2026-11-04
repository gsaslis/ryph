// The machinery's own log, total by contract: a diagnostics call may never throw into a caller.

export interface Diagnostics {
  debug(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
}

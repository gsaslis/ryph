// The runner's inbound control surface — a DRIVING port. Every other port is driven: the core
// depends on it and reaches out through it. This one is the reverse — the outside drives it. A
// driving adapter (the inbound HTTP API) translates an external request into a call here, and the
// composition root implements it.

/**
 * Inbound control over the in-flight run: the outside calls in through this port to steer a run that
 * is already executing.
 */
export interface RunControl {
  /**
   * Requests a graceful cancel of the in-flight run — an ask, not a command. It returns immediately
   * without waiting for the run to stop, and returns nothing: the acknowledgement is only that the
   * ask landed, never that the run has ended. The run winds down through the same graceful path any
   * cancel takes. Idempotent — asking twice is asking once.
   */
  requestCancel(): void;
}

// The push channel down to a runner's inbound control endpoint.
// Best-effort by design: the reaper's provisioner-level kill is the enforcement backstop,
// so an unreachable runner delays a cancel, never loses it.

export interface RunnerControl {
  /**
   * Asks the run's runner to gracefully cancel, at the address its provisioner placed it
   * (`Provisioner.controlUrl`). Returns false when there is none, or it did not take the cancel.
   */
  requestCancel(run: CancelTarget): Promise<boolean>;
}

/** What a push needs from the run: which one, where it was launched, and the endpoint's token. */
export interface CancelTarget {
  id: string;
  handle: string | null;
  controlToken: string;
}

import type { AutomationEvent, AutomationTarget } from "../core/types.ts";

/**
 * Where a fire's event goes — the orchestrator's events door, however it is reachable. An
 * accepted delivery carries the orchestrator's verdict (started, refused, denied, …) so the
 * caller can record the fire's outcome; a failed one says only whether retrying can help.
 * `failed.terminal` maps straight onto the delivery queue's `ConsumeOutcome`, so a consumer
 * returns the verdict unchanged.
 */
export type DeliverResult =
  | {
    kind: "ok";
    outcome: string;
    taskId: string | null;
    runId: string | null;
    /** The verdict's reason, when the door offered one — a refusal's error, for the history. */
    detail?: string | null;
  }
  | { kind: "failed"; message: string; terminal: boolean };

export interface EventSink {
  /** Never throws: the delivery queue's retry clock needs terminality, not exception shapes. */
  deliver(event: AutomationEvent): Promise<DeliverResult>;
  /** Asks the door to check the owner's access to the target now and keep the answer, so a fire
   * during a forge outage has a recent one to fall back on. Starts nothing; never throws. */
  refreshAccess(probe: AccessProbe): Promise<void>;
}

/** Whose access to what — the keep-warm check's question. */
export interface AccessProbe {
  ownerUserId: string;
  target: AutomationTarget;
}

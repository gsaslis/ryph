// Door ⑤'s line to the control plane: which grant a calling run holds, and the ledger every write
// is reserved in and settled against. The orchestrator decides — the grant, the caps, whether
// the run is still live; this port only asks. Its HTTP adapter is the key store's sibling.

import type { ToolGrant, WriteToolName } from "../core/types.ts";

export type ReserveOutcome =
  | { kind: "reserved"; actionId: string }
  /** A definitive no — over the cap, run concluded, not granted — in the orchestrator's words. */
  | { kind: "refused"; reason: string }
  /** The orchestrator answered and would not take the request as sent (a 400, a 401, …): it was
   * reached, so this is no outage to retry, but no policy said no either. */
  | { kind: "rejected"; reason: string };

/**
 * The control plane answered, and refused the request itself (a 4xx it does not mean as a
 * definitive policy answer). Thrown where "could not ask" would otherwise be thrown, so a caller
 * can tell an outage, worth retrying, from a refusal that will be answered the same way again.
 */
export class ControlPlaneRefusal extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(`the control plane answered ${status}: ${reason}`);
    this.name = "ControlPlaneRefusal";
  }
}

/** The orchestrator's own sentence for a 4xx, where its body carries one. */
export function refusalReason(status: number, body: unknown): string {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" && error.trim() !== ""
    ? error.trim().slice(0, 500)
    : `it answered ${status}`;
}

export type ActionOutcome =
  | { outcome: "done"; url: string; createdThreadRef: string | null }
  | { outcome: "failed"; detail: string };

export interface ToolGrants {
  /**
   * The grant a run holds. Three outcomes, as `KeyStore.resolve`: a grant; null — a definitive
   * no (the run concluded, has no forge scope, or holds no repo any more); or a throw — the
   * orchestrator could not be asked.
   */
  resolve(runId: string): Promise<ToolGrant | null>;
  /** Reserves one write against the run's cap. Throws only when the orchestrator could not be
   * asked (a network failure or a 5xx) — then nothing may be written, because nothing was
   * counted. A request it answered and would not take is `rejected`, never a throw. */
  reserve(req: {
    runId: string;
    tool: WriteToolName;
    connectedRepoId: string;
    /** The thread the write lands on, as its forge spells it; null for create_issue. */
    threadRef: string | null;
  }): Promise<ReserveOutcome>;
  /** Settles a reserved write. Throws when the orchestrator could not be told; the row then
   * stays `reserved`, which the trail shows as an outcome nobody learned. */
  complete(actionId: string, runId: string, outcome: ActionOutcome): Promise<void>;
  /** Drops any cached grant for the run — after a write that changes it (an issue opened). */
  forget(runId: string): void;
}

import type { CheckRequest, CheckResult, CheckSuite } from "../core/check_types.ts";
import type { ConnectedRepo } from "../core/types.ts";

/**
 * What a transport throws. Never reflects an upstream response or fetch exception: either can
 * contain credentials. `status` is the receiver's HTTP status, 0 when there was none (unreachable,
 * an invalid answer); core reads it to tell the run why its checks wait (`remoteChecksNote`).
 */
export class RemoteChecksError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RemoteChecksError";
  }
}

/** Durable address of a delegation. Never contains a credential. */
export interface RemoteCheckReference {
  endpoint: string;
  requestId: string;
  suiteId: string | null;
}

/** B is authoritative for declarations, environment, generations and observed results. */
export interface RemoteCheckSnapshot {
  requestId: string;
  suite: CheckSuite | null;
  results: CheckResult[];
  note?: string;
  refused?: boolean;
}

/** Transport owns authentication and bundle transfer; core never shells out or imports CLI.
 * submit MUST be idempotent by request.id, including retries after an uncertain response.
 * All operations are bounded by a transport timeout. No operation falls back to local checks.
 */
export interface RemoteChecks {
  readonly endpoint: string;
  /** The receiver reads the base; A must not discover declarations through its own forge. */
  readChecksFile(repo: ConnectedRepo, ref: string): Promise<import("./forge.ts").ChecksFile>;
  submit(input: { request: CheckRequest; repo: ConnectedRepo }): Promise<RemoteCheckSnapshot>;
  read(remote: RemoteCheckReference): Promise<RemoteCheckSnapshot>;
  cancel(remote: RemoteCheckReference): Promise<void>;
  log(remote: RemoteCheckReference, generation: number, name: string): Promise<string | null>;
}

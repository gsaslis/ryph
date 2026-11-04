// Where a run's background commands are recorded (core/background.ts): one row per job, in the
// control plane's database beside the run. The log itself is not here — it is a BuildLogStore
// object, and the row only says whether there is one.
//
// Invariants:
// - every write but `markLog` and `releaseLog` takes the run's row lock first, and refuses with
//   "concluded" once the run is terminal: a conclusion (which writes that row) and a late write
//   serialize on it, so nothing lands after the run's record is final. `markLog` follows a claim
//   granted while the run was live, and marks a log already stored: refusing it would leave an
//   object no row points at
// - a log has one writer: `claimLog` takes the claim under the lock, and only `markLog` and
//   `releaseLog` with that same claim can end it
// - `start` counts the run's rows and inserts under that same lock, so `max` is a guarantee and
//   not a hope when two starts race
// - `start` and `end` write once: a second `start` for a job is "exists" and changes nothing, a
//   second `end` is "already"

import type {
  BackgroundCommand,
  BackgroundEnd,
  BackgroundRefusal,
  BackgroundStart,
} from "../core/background.ts";

export interface BackgroundStore {
  start(record: BackgroundStart, max: number): Promise<"created" | "exists" | "full" | "concluded">;
  end(
    runId: string,
    jobId: string,
    record: BackgroundEnd,
  ): Promise<"ended" | "already" | Exclude<BackgroundRefusal, "full">>;
  /**
   * Claims the job's log for one upload, under the run's row lock: "claimed" when the run is
   * live, the job has ended, has no log, and no upload holds it (or the one that does claimed it
   * before `staleBefore`); "running", "stored", "busy", or the refusal otherwise.
   */
  claimLog(
    runId: string,
    jobId: string,
    claim: { claim: string; at: string; staleBefore: string },
  ): Promise<"claimed" | "running" | "stored" | "busy" | Exclude<BackgroundRefusal, "full">>;
  /** Clears a claim that is still `claim`'s; nothing else. */
  releaseLog(runId: string, jobId: string, claim: string): Promise<void>;
  /** Marks the log stored at `key`, `bytes` long (which becomes the row's `logBytes`), and
   * clears the claim, if the claim is still `claim`'s ("lost" if not), whatever the run's state
   * now. */
  markLog(
    runId: string,
    jobId: string,
    claim: string,
    stored: { key: string; bytes: number },
  ): Promise<"ok" | "lost">;
  get(runId: string, jobId: string): Promise<BackgroundCommand | null>;
  /** Every job of the run, in no particular order. */
  list(runId: string): Promise<BackgroundCommand[]>;
}

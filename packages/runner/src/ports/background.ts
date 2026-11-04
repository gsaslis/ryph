// Where the agent's background commands are told of, outside the box — two DRIVEN ports, as the
// narrator is: the durable record of each job (the control plane's
// `run_background_commands`, and its log), and the live channel people watch its output on (the
// historian's commands room). The core shapes and bounds everything it hands either one; neither
// can fail or slow the run, and neither carries anything the agent could not already print.

import type { BackgroundEndReason } from "./run_actions.ts";

/** A job as it started, for the durable record. Times are ISO. */
export interface BackgroundStartedRecord {
  /** `^bg-[0-9]{1,3}$`, minted by the runner. */
  id: string;
  label: string;
  /** Clipped to 4 KiB. */
  command: string;
  cwd: string;
  service: boolean;
  startedAt: string;
  timeoutAt: string;
}

/** How a job ended, for the durable record. */
export interface BackgroundEndedRecord {
  endedAt: string;
  reason: BackgroundEndReason;
  exitCode: number | null;
  signal: string | null;
  /** What the log file holds, and whether it stopped at its cap. */
  logBytes: number;
  logTruncated: boolean;
  /** The last 64 lines of output, at most 16 KiB, ANSI stripped. */
  logTail: string;
}

/**
 * The durable record: `PUT/POST /v1/runs/:id/runner/background/...` on the control plane. Each
 * call is idempotent and retried by the adapter, and answers whether it landed; none throws — a
 * record that could not be made costs the run page that record, nothing else.
 */
export interface BackgroundRecords {
  started(record: BackgroundStartedRecord): Promise<boolean>;
  ended(id: string, record: BackgroundEndedRecord): Promise<boolean>;
  /** The end of the job's log (its last 4 MiB), as text. Taken only once its end has landed. */
  log(id: string, text: string): Promise<boolean>;
}

/** One line of the live uplink (`POST /v1/runs/:id/live/commands`), every field bounded by the
 * core before it gets here. */
export type CommandLine =
  | {
    type: "started";
    at: string;
    id: string;
    label: string;
    command: string;
    cwd: string;
    service: boolean;
    timeoutAt: string;
  }
  | { type: "output"; at: string; id: string; text: string }
  | { type: "skipped"; at: string; id: string; bytes: number }
  | {
    type: "exited";
    at: string;
    id: string;
    reason: BackgroundEndReason;
    exitCode: number | null;
    signal: string | null;
  };

/**
 * The live channel. A new connection resets the room, so each one opens with `replay`: every
 * job's `started`, its output as the core still holds it, and `exited` for each that ended. A
 * line sent while no connection is open is dropped; the next replay covers it.
 */
export interface CommandsUplink {
  /** Starts the channel, on the first job; later calls do nothing. `replay` is asked at the start
   * of every connection, and what it answers goes first. */
  open(replay: () => CommandLine[]): void;
  send(line: CommandLine): void;
  /** Sends what is queued (bounded), then ends the channel. Idempotent. */
  close(): Promise<void>;
}

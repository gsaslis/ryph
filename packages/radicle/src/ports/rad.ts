// The subprocesses this service is allowed to run — `rad`, `rad-job` and `git` — behind one port, so
// the core never spawns anything itself and a test can drive it with a scripted executor.
//
// Why a port and not a helper: every `rad` invocation carries the deployment's IDENTITY
// (RAD_HOME, RAD_PASSPHRASE, the key). That is the one thing this process owns and the one
// thing a test must be able to stand in for. The CLI adapter (adapters/rad/cli.ts) is where
// the environment is assembled; nothing else in the package may name RAD_HOME.
//
// Invariants the adapter keeps and the core relies on:
// - every spawn is bounded by a timeout and never inherits stdin
// - stdout and stderr are both captured; a non-zero exit is a VALUE, not an exception, because
//   `rad` says useful things on the failure path ("not authorized to apply …") that the HTTP
//   layer turns into typed refusals
// - the passphrase is never an argument, only an environment variable, so it cannot reach a
//   process listing

/** What a finished subprocess left behind. `code` is null only if it was killed by a signal. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the command was cut short by its timeout rather than exiting on its own. */
  timedOut: boolean;
  /** stdout as the raw bytes it was — present only for a command run with `binary`, whose
   * `stdout` is then "". */
  bytes?: Uint8Array;
  /** stdout or stderr exceeded maxOutputBytes; the retained prefix is not complete output. */
  truncated?: boolean;
}

export interface ExecOptions {
  /** Overrides the port's default timeout. */
  timeoutMs?: number;
  /** Extra environment for this one command. Never a place for the passphrase. */
  env?: Record<string, string>;
  /** Fed to the child's stdin. Absent: stdin is /dev/null. */
  stdin?: string;
  /** stdout is not text — a blob (`git cat-file blob`, an embedded image): it comes back as
   * `bytes`, never decoded. Decoding five mebibytes of PNG as UTF-8 is a second copy of it, and
   * a lossy one nobody reads. */
  binary?: boolean;
  /** Retain at most this many bytes per output stream, draining the rest without buffering. */
  maxOutputBytes?: number;
}

export interface RadExec {
  /** RAD_HOME — the one directory this process owns. Exposed for storage paths, not for env. */
  readonly home: string;
  /** The node's control socket path, as the adapter resolved it. */
  readonly socket: string;
  /** The bare storage repository for a RID: `<home>/storage/<rid without the rad: prefix>`. */
  storageDir(rid: string): string;
  /** Runs `rad <args>`. `cwd` is irrelevant to `rad` — every call names its repo by RID. */
  rad(args: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** Runs `git <args>` in `cwd`, with `git-remote-rad` on PATH and a hermetic config. */
  git(cwd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  /**
   * Runs `rad-job <args>` — the `radicle-job` crate's own CLI, and the only writer of the job
   * COB that works against rad 1.10.2 (see `adapters/jobs/rad_job.ts`). Same identity, same
   * environment and same bounds as `rad`: it signs with the deployment's key.
   */
  radJob(args: string[], opts?: ExecOptions): Promise<ExecResult>;
}

/** Thrown when a command the core cannot proceed without failed. Carries stderr for the log. */
export class RadCommandError extends Error {
  constructor(
    readonly command: string,
    readonly result: ExecResult,
  ) {
    super(
      `${command} failed (exit ${result.code}${result.timedOut ? ", timed out" : ""}): ` +
        (result.stderr.trim() || result.stdout.trim() || "no output"),
    );
    this.name = "RadCommandError";
  }
}

/** `result` if it succeeded, otherwise a `RadCommandError` naming `command`. */
export function orThrow(command: string, result: ExecResult): ExecResult {
  if (result.code !== 0) throw new RadCommandError(command, result);
  return result;
}

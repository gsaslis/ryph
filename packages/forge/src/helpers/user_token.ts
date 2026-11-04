// The credential a forge acts with when it holds ONE token rather than an App: GitHub user mode
// (one person's token, `gh auth token`), and GitLab in either mode (the bot's or the person's
// token: a personal access token, or glab's login through its credential helper, which renews
// glab's 2-hour OAuth token — `printf 'protocol=https\nhost=<host>\n\n' | glab auth
// git-credential get | sed -n 's/^password=//p'`). From the environment or from a command that
// prints it; which variables and log keys it speaks of is the provider's (`UserTokenNames`).
//
// Invariants:
// - the token never leaves this module except as the return value of `current()`/`refresh()`:
//   no log line, no error message and no diagnostics field carries it, nor the command's
//   stdout (which IS the token). The command's stderr is the one thing said about a failed
//   run, truncated, because "gh: not logged in" is the whole diagnosis
// - the command runs at most once at a time (single flight), and a refresh after a 401 runs it
//   at most once per `minRefreshIntervalMs`: a token GitHub keeps refusing costs one command
//   run per window, never one per request and never a loop
// - a run ends by its deadline, whatever the command started: the deadline kills the command's
//   whole process group and stops reading its pipes (`runBounded`)
// - a static token cannot be refreshed: a 401 is the answer, and `refresh` says so with null
// - whatever the command prints is checked before it is ever put in a header: one line of
//   printable, space-free ASCII, or it is refused (a header built from anything else is a
//   request smuggled into the next line)

import { type Child, command } from "@ryph/process";

/** What this module tells its caller's log — events and fields, never a token. */
export interface UserTokenTracer {
  debug(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

/** The names a token source speaks of — the variables an operator set, and the prefix of every
 * log event — so a GitLab token's failure never says RYPH_GITHUB_TOKEN. */
export interface UserTokenNames {
  /** The variable a static token is read from, e.g. "RYPH_GITHUB_TOKEN". */
  env: string;
  /** The variable the command is read from, e.g. "RYPH_GITHUB_TOKEN_COMMAND". */
  command: string;
  /** The prefix of this source's log events, e.g. "github_user_token". */
  log: string;
}

export const GITHUB_TOKEN_NAMES: UserTokenNames = {
  env: "RYPH_GITHUB_TOKEN",
  command: "RYPH_GITHUB_TOKEN_COMMAND",
  log: "github_user_token",
};

export const GITLAB_TOKEN_NAMES: UserTokenNames = {
  env: "RYPH_GITLAB_TOKEN",
  command: "RYPH_GITLAB_TOKEN_COMMAND",
  log: "gitlab_token",
};

/** A user token could not be had. The message names the source and never the token. */
export class UserTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserTokenError";
  }
}

export interface UserTokenSource {
  /** Where the token comes from, for a boot line: the variable's name, never its value. */
  readonly kind: "static" | "command";
  /** The token to present now. The first call runs the command; later ones answer from memory. */
  current(): Promise<string>;
  /**
   * The forge answered 401 to `stale`. A token different from it to retry with — the command's
   * fresh answer, or the one a concurrent refresh already fetched — or null when there is none:
   * a static token, a command that printed the same token again or failed, or a refresh asked
   * for again inside `minRefreshIntervalMs`. Never throws; a failure is logged and is null.
   */
  refresh(stale: string): Promise<string | null>;
}

/** Longer than any real token (a fine-grained PAT is ~93 characters), short enough that a
 * command printing a whole file is refused rather than sent. */
const TOKEN_MAX = 1_000;
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;

/** Whether `token` can be put in an Authorization header as is. */
export function isUsableToken(token: string): boolean {
  return token.length > 0 && token.length <= TOKEN_MAX && TOKEN_SHAPE.test(token);
}

/** How much of a failed command's stderr a log line or a boot error carries. */
const STDERR_MAX = 300;

export function staticUserToken(
  token: string,
  names: UserTokenNames = GITHUB_TOKEN_NAMES,
): UserTokenSource {
  if (!isUsableToken(token)) {
    throw new UserTokenError(
      `${names.env} is not a usable token (one line of printable characters, no spaces)`,
    );
  }
  return {
    kind: "static",
    current: () => Promise.resolve(token),
    refresh: () => Promise.resolve(null),
  };
}

/** What one run of the command left: its exit, and what it printed (each stream capped). */
interface CommandRun {
  success: boolean;
  code: number;
  signal: NodeJS.Signals | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/** The most of either stream a run keeps: far more than a token or a useful diagnosis, and a
 * command printing without end costs this much, not all of it. */
const STREAM_MAX = 64 * 1024;

/**
 * `sh -c <command>`, bounded by `timeoutMs` for real. An abort signal on the command would kill
 * `sh` alone, and waiting for its output waits for every process still holding the pipes — a
 * `gh` that hangs behind a pipeline, or anything it spawned, held boot and every refresh
 * forever. So the shell is started in a process group of its own (`detached`: a new session, on
 * macOS and Linux alike, which also means no terminal to prompt on), the deadline kills that
 * whole group, and the pipes are abandoned rather than drained: a grandchild that left the group
 * may keep them open, and it is not waited for.
 */
async function runBounded(
  script: string,
  timeoutMs: number,
  variable: string,
): Promise<CommandRun> {
  let child: Child;
  try {
    child = await command("sh", {
      args: ["-c", script],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      detached: true,
    }).spawn();
  } catch (err) {
    // A spawn failure's message holds nothing the command printed.
    throw new UserTokenError(
      `${variable} could not be run: ${err instanceof Error ? err.message : err}`,
    );
  }
  const stdout = drain(child.stdout);
  const stderr = drain(child.stderr);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const finished = await Promise.race([
      Promise.all([child.status, stdout.bytes, stderr.bytes]),
      deadline,
    ]);
    if (finished !== "timeout") {
      const [status, out, err] = finished;
      return { ...status, stdout: out, stderr: err };
    }
  } finally {
    clearTimeout(timer);
  }
  killGroup(child);
  await Promise.all([stdout.abandon(), stderr.abandon()]);
  await child.status;
  throw new UserTokenError(
    `${variable} took longer than ${timeoutMs / 1000}s and was stopped`,
  );
}

/**
 * SIGKILL a detached child's whole process group: the shell, the pipeline, and whatever they
 * started — a negative pid names the group. If the group cannot be signalled, the shell itself
 * is, at least.
 */
function killGroup(child: Child): void {
  try {
    process.kill(-child.pid, "SIGKILL");
    return;
  } catch { /* the group is gone, or not ours to signal: fall through */ }
  try {
    child.kill("SIGKILL");
  } catch { /* already exited */ }
}

/** One of the child's pipes, read up to `STREAM_MAX` — and let go of on demand. */
function drain(stream: ReadableStream<Uint8Array>): {
  bytes: Promise<Uint8Array>;
  abandon(): Promise<void>;
} {
  const reader = stream.getReader();
  const bytes = (async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size < STREAM_MAX) {
        const kept = value.subarray(0, STREAM_MAX - size);
        chunks.push(kept);
        size += kept.length;
      }
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      all.set(chunk, at);
      at += chunk.length;
    }
    return all;
  })();
  // A read cut short by `abandon` is not a failure anyone awaits.
  bytes.catch(() => {});
  return { bytes, abandon: () => reader.cancel().catch(() => {}) };
}

export interface CommandUserTokenOptions {
  /** Run as `sh -c <command>`, with this process's environment. */
  command: string;
  /** Which variables and log keys this source speaks of. Absent: GitHub's. */
  names?: UserTokenNames;
  diag: UserTokenTracer;
  /** How long one run may take before it is killed and counts as failed. */
  timeoutMs?: number;
  /** The least time between two runs a 401 asks for. */
  minRefreshIntervalMs?: number;
  now?: () => number;
}

export function commandUserToken(opts: CommandUserTokenOptions): UserTokenSource {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const minRefreshIntervalMs = opts.minRefreshIntervalMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const names = opts.names ?? GITHUB_TOKEN_NAMES;
  let held: string | null = null;
  let lastRunMs = -Infinity;
  let running: Promise<string> | null = null;

  const run = async (): Promise<string> => {
    lastRunMs = now();
    const output = await runBounded(opts.command, timeoutMs, names.command);
    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr).trim();
      throw new UserTokenError(
        `${names.command} ${
          output.signal === null ? `exited ${output.code}` : `was killed (${output.signal})`
        }${stderr === "" ? "" : `: ${stderr.slice(0, STDERR_MAX)}`}`,
      );
    }
    const token = new TextDecoder().decode(output.stdout).trim();
    // Said without the output: if the command printed something that is not a token, what it
    // printed may still be a secret.
    if (!isUsableToken(token)) {
      throw new UserTokenError(
        token === ""
          ? `${names.command} printed nothing`
          : `${names.command} printed something that is not a token ` +
            "(one line of printable characters, no spaces)",
      );
    }
    return token;
  };

  /** One run at a time: whoever asks while one is going shares its answer. */
  const once = (): Promise<string> => {
    running ??= run().then((token) => {
      held = token;
      return token;
    }).finally(() => {
      running = null;
    });
    return running;
  };

  return {
    kind: "command",
    current() {
      return held !== null ? Promise.resolve(held) : once();
    },
    async refresh(stale) {
      try {
        // A refresh already under way, or one that finished since the caller read its token:
        // its answer is the fresh token, and the command is not run again for it.
        if (running !== null) {
          const fresh = await running;
          return fresh === stale ? null : fresh;
        }
        if (held !== null && held !== stale) return held;
        if (now() - lastRunMs < minRefreshIntervalMs) {
          opts.diag.debug(`${names.log}.refresh_skipped`, {
            reason: "the command ran moments ago",
          });
          return null;
        }
        const fresh = await once();
        if (fresh === stale) {
          opts.diag.warn(`${names.log}.unchanged`, {
            note: "the forge refused the token and the command printed the same one",
          });
          return null;
        }
        opts.diag.debug(`${names.log}.refreshed`);
        return fresh;
      } catch (err) {
        opts.diag.warn(`${names.log}.refresh_failed`, {
          err: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
  };
}

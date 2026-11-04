// The `RadExec` port over the real binaries. This is the ONLY file that names RAD_HOME,
// RAD_PASSPHRASE or the node socket path, and the only place a subprocess environment is built.
//
// The environment, and why each line is there:
// - `clearEnv: true` plus an explicit map: the bridge runs beside a node in a container whose
//   environment carries the platform's own secrets. None of them belong in a `git` child.
// - PATH holds the directory `git-remote-rad` lives in, and nothing else is assumed: `git push
//   rad://…` resolves the helper by PATH lookup, so a bin dir that is not on the parent's PATH
//   would fail with a bare "unable to find remote helper".
// - GIT_CONFIG_GLOBAL/SYSTEM=/dev/null, GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_COUNT=0: hermetic, and
//   an ambient GIT_CONFIG_COUNT cannot inject config at command-line precedence. Same doctrine as
//   @ryph/forge's helpers/git_exec.ts — do not soften it.
// - GIT_TERMINAL_PROMPT=0 and both askpass vars emptied: a would-be credential prompt fails
//   fast instead of hanging a request. (VS Code sets GIT_ASKPASS in every integrated terminal,
//   which is exactly how this was learned in the forge.)
// - RAD_PASSPHRASE is an env var and never an argument, so it cannot reach a process listing.
//   An empty passphrase is a legitimate value and is passed as the empty string, not omitted:
//   omitting it makes `rad` prompt.
// - RAD_SOCKET points the CLI at the node we are paired with. `/dev/null` is the documented way
//   to say "do not contact a node" and is what the hermetic tests use.
// - SSH_AUTH_SOCK only when the caller hands one in, which only user mode does. A person's key
//   is usually encrypted and unlocked in their ssh-agent (`rad auth` puts it there), and `rad`
//   signs through the agent when no passphrase is set — measured against rad 1.10.3, where an
//   EMPTY RAD_PASSPHRASE counts as none, so the empty default below still falls through to it.
//   A deployment's key is unencrypted and its container has no agent, so it gets nothing new.
//   Beside an agent, git may speak only `file` and `rad` (`gitProtocols`), so no child can
//   carry that agent anywhere over ssh.
// - HOME is RAD_HOME, in both modes, and that is harmless against a person's `~/.radicle` too:
//   `rad` finds its profile by RAD_HOME alone, git's global config is /dev/null above, and ssh
//   resolves `~` from the password database rather than from HOME. What it buys is that the
//   rest of a person's home stays out of every child's view.
//
// Timeouts: every spawn is bounded. A `rad` that blocks on a node that is gossiping would
// otherwise hold an HTTP request open forever.

import { command, type CommandOutput } from "@ryph/process";
import type { ExecOptions, ExecResult, RadExec } from "../../ports/rad.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import { SILENT_DIAGNOSTICS } from "../../ports/diagnostics.ts";

export interface CliRadExecOptions {
  /** RAD_HOME — the directory this process owns, exclusively. */
  home: string;
  /** Unlocks the key. The empty string is valid and means "no passphrase". */
  passphrase: string;
  /** Where `rad`, `radicle-node` and `git-remote-rad` live. Null: plain PATH lookup. */
  binDir: string | null;
  /** RAD_SOCKET. Defaults to `<home>/node/control.sock`, the node's own default. */
  socket?: string;
  /** The default bound on a single command. */
  timeoutMs?: number;
  /** SSH_AUTH_SOCK for the children, so `rad` can sign through an ssh-agent. User mode only. */
  agentSocket?: string | null;
  /**
   * GIT_ALLOW_PROTOCOL. Default `file:ssh:https:http:rad`. User mode narrows it to `file:rad`:
   * every git the bridge runs reads a local path (storage, a scratch repo, a bundle on disk) or
   * pushes to `rad://`, and with a person's ssh-agent in the environment no child may reach
   * anything over ssh — or over http, where nothing legitimate goes either.
   */
  gitProtocols?: string;
  diag?: Diagnostics;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** `rad:` is decoration on the wire; storage directories are named by the bare id. */
export function bareRid(rid: string): string {
  return rid.startsWith("rad:") ? rid.slice("rad:".length) : rid;
}

export function cliRadExec(opts: CliRadExecOptions): RadExec {
  const diag = opts.diag ?? SILENT_DIAGNOSTICS;
  const defaultTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socket = opts.socket ?? `${opts.home.replace(/\/+$/, "")}/node/control.sock`;
  const radBin = opts.binDir ? `${opts.binDir.replace(/\/+$/, "")}/rad` : "rad";
  // `rad-job` ships beside `rad` in the image (images/radicle/Dockerfile) and is found the same
  // way: an absolute path when a bin dir is configured, a PATH lookup otherwise.
  const radJobBin = opts.binDir ? `${opts.binDir.replace(/\/+$/, "")}/rad-job` : "rad-job";
  // The helper is found by PATH, never by an argument, so the bin dir has to be ON it.
  const path = opts.binDir
    ? `${opts.binDir.replace(/\/+$/, "")}:${process.env.PATH ?? ""}`
    : (process.env.PATH ?? "");

  const baseEnv = (): Record<string, string> => ({
    PATH: path,
    HOME: opts.home,
    RAD_HOME: opts.home,
    RAD_PASSPHRASE: opts.passphrase,
    RAD_SOCKET: socket,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    // Apple's git also loads a config file compiled into the binary — at scope `unknown`, so
    // GIT_CONFIG_SYSTEM does not reach it — and that file turns on the login keychain
    // (`credential.helper=osxkeychain`). This is the switch that skips it.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
    GIT_ALLOW_PROTOCOL: opts.gitProtocols ?? "file:ssh:https:http:rad",
    // git refuses to write a commit with no identity, and COB writes go through git. The
    // identity is cosmetic — authorship is the Radicle signature — but it must exist.
    GIT_AUTHOR_NAME: "ryph",
    GIT_AUTHOR_EMAIL: "ryph@localhost",
    GIT_COMMITTER_NAME: "ryph",
    GIT_COMMITTER_EMAIL: "ryph@localhost",
    ...(opts.agentSocket ? { SSH_AUTH_SOCK: opts.agentSocket } : {}),
  });

  const run = async (
    bin: string,
    args: string[],
    cwd: string | undefined,
    label: string,
    options: ExecOptions | undefined,
  ): Promise<ExecResult> => {
    const started = performance.now();
    const timeoutMs = options?.timeoutMs ?? defaultTimeout;
    const child = await command(bin, {
      args,
      cwd,
      clearEnv: true,
      env: { ...baseEnv(), ...(options?.env ?? {}) },
      stdin: options?.stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    // The timer is armed BEFORE anything is written, and the child is awaited in a `finally`.
    // Both matter: a child that exits without reading its input (`git --version`, a `rad` that
    // refuses on its first argument) closes the read end, and the write then fails with EPIPE
    // once the pipe buffer is full. Writing first meant that rejection escaped with the child
    // never awaited and no timeout armed — a leaked process and two leaked pipes per call.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone — nothing to cut short
      }
    }, timeoutMs);

    let truncated = false;
    const capped = async (stream: ReadableStream<Uint8Array>, max: number) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of stream) {
        const take = Math.min(chunk.length, max - size);
        if (take < chunk.length) truncated = true;
        if (take > 0) chunks.push(chunk.slice(0, take));
        size += take;
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    };
    // Start draining before writing stdin; neither a full output pipe nor a large diff may
    // block the writer or force us to buffer the entire result.
    const output = options?.maxOutputBytes === undefined ? null : Promise.all([
      child.status,
      capped(child.stdout, options.maxOutputBytes),
      capped(child.stderr, options.maxOutputBytes),
    ]).then(([status, stdout, stderr]) => ({ ...status, stdout, stderr }));
    let out: CommandOutput;
    try {
      if (options?.stdin !== undefined) {
        const writer = child.stdin.getWriter();
        try {
          await writer.write(new TextEncoder().encode(options.stdin));
        } catch (err) {
          // Not an error of ours: the child decided it had heard enough. Its own exit status
          // and stderr, read below, are the answer the caller gets.
          diag.debug("rad.stdin_unread", { bin: label, op: args[0], err: String(err) });
        } finally {
          // A closed-or-errored stdin must not be left holding the pipe open, or `output()`
          // waits for a child that is waiting for EOF.
          await writer.close().catch(() => {});
        }
      }
      out = await (output ?? child.output());
    } finally {
      clearTimeout(timer);
    }

    const decoder = new TextDecoder();
    const result: ExecResult = {
      code: out.code,
      stdout: options?.binary ? "" : decoder.decode(out.stdout),
      stderr: decoder.decode(out.stderr),
      timedOut,
      ...(options?.binary ? { bytes: out.stdout } : {}),
      ...(options?.maxOutputBytes === undefined ? {} : { truncated }),
    };
    diag.debug("rad.exec", {
      bin: label,
      op: args[0],
      code: result.code,
      timedOut,
      ms: Math.round(performance.now() - started),
    });
    return result;
  };

  return {
    home: opts.home,
    socket,
    storageDir: (rid) => `${opts.home.replace(/\/+$/, "")}/storage/${bareRid(rid)}`,
    rad: (args, options) => run(radBin, args, undefined, "rad", options),
    radJob: (args, options) => run(radJobBin, args, undefined, "rad-job", options),
    git: (cwd, args, options) => run("git", args, cwd, "git", options),
  };
}

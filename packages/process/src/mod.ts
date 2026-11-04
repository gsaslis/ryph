// @ryph/process — running a program, on node:child_process, the way `Deno.Command` ran one.
//
// Over a hundred call sites were written against `Deno.Command`: web streams on the child's pipes
// (`pipeTo(child.stdin)`, `new Response(child.stderr).text()`), a status promise, `output()` that
// collects both pipes. Rewriting each against node's EventEmitter child would be a hundred chances
// to get a pipe or an exit code subtly wrong, so this keeps that shape and is the one place that
// talks to node:child_process. Nothing here is a `Bun.*` API: it runs under Node unchanged.
//
// Kept from `Deno.Command`, because callers lean on each:
// - the defaults: `output()` pipes stdout and stderr and inherits stdin; `spawn()` inherits all
//   three.
// - `clearEnv`: the child gets `env` and nothing else, and the program is still looked up on THIS
//   process's PATH (unless `env` names its own), which node would not do with a cleared env.
// - a child killed by a signal reports `code` 128 + its number, `signal` its name.
// - reading a pipe that is not piped, and `kill()` after the child exited, throw TypeError.
//
// What differs: a program that cannot be started REJECTS `spawn()` (now a promise) where
// `Deno.Command.spawn()` threw synchronously, because node only learns of it asynchronously. The
// error carries node's `code` (ENOENT, EACCES), not a `Deno.errors` class.

import { type ChildProcess, spawn as nodeSpawn, type StdioOptions } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

export type Stdio = "piped" | "inherit" | "null";

export interface CommandOptions {
  args?: string[];
  cwd?: string | URL;
  /** Added to this process's environment, or the whole of the child's with `clearEnv`. */
  env?: Record<string, string>;
  clearEnv?: boolean;
  stdin?: Stdio;
  stdout?: Stdio;
  stderr?: Stdio;
  /** Aborting it kills the child (SIGTERM). */
  signal?: AbortSignal;
  uid?: number;
  gid?: number;
  /** Its own process group and session, so a signal to the group reaches it and its children. */
  detached?: boolean;
}

export interface CommandStatus {
  success: boolean;
  /** The exit code, or 128 + the signal's number when a signal ended it. */
  code: number;
  signal: NodeJS.Signals | null;
}

export interface CommandOutput extends CommandStatus {
  /** Throws TypeError unless stdout was piped. */
  readonly stdout: Uint8Array;
  /** Throws TypeError unless stderr was piped. */
  readonly stderr: Uint8Array;
}

export interface Child {
  readonly pid: number;
  /** Throws TypeError unless stdin was piped. */
  readonly stdin: WritableStream<Uint8Array>;
  /** Throws TypeError unless stdout was piped. */
  readonly stdout: ReadableStream<Uint8Array>;
  /** Throws TypeError unless stderr was piped. */
  readonly stderr: ReadableStream<Uint8Array>;
  /** Settles when the child exits; its pipes may still hold output. */
  readonly status: Promise<CommandStatus>;
  /** Waits for the exit and collects whatever of stdout and stderr is piped. */
  output(): Promise<CommandOutput>;
  /** Default SIGTERM. Throws TypeError once the child has exited. */
  kill(signal?: NodeJS.Signals): void;
  /** Keeps this process up until the child exits (the default). */
  ref(): void;
  /** Lets this process exit with the child still running. */
  unref(): void;
}

export interface Command {
  /** Runs it to completion. Rejects when it cannot be started. */
  output(): Promise<CommandOutput>;
  /** Starts it. Rejects when it cannot be started. */
  spawn(): Promise<Child>;
}

/** A program, with its arguments and how its pipes are wired; nothing runs until asked. */
export function command(program: string | URL, opts: CommandOptions = {}): Command {
  return {
    output: async () => {
      const child = await start(program, opts, {
        stdin: opts.stdin ?? "inherit",
        stdout: opts.stdout ?? "piped",
        stderr: opts.stderr ?? "piped",
      });
      return child.output();
    },
    spawn: () =>
      start(program, opts, {
        stdin: opts.stdin ?? "inherit",
        stdout: opts.stdout ?? "inherit",
        stderr: opts.stderr ?? "inherit",
      }),
  };
}

const notPiped = (name: string): never => {
  throw new TypeError(`Cannot get '${name}': '${name}' is not piped`);
};

const node = (s: Stdio): "pipe" | "inherit" | "ignore" =>
  s === "piped" ? "pipe" : s === "inherit" ? "inherit" : "ignore";

/**
 * The program as an absolute path, found on `path` the way a shell would, when it is a bare
 * name; otherwise as given. Null when a bare name is nowhere on the path. A relative entry is
 * skipped: checked here against this process's cwd, it would run from the child's.
 */
function lookup(program: string, path: string | undefined): string | null {
  if (program.includes("/")) return program;
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    const candidate = join(dir, program);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

function statusOf(code: number | null, signal: NodeJS.Signals | null): CommandStatus {
  if (signal !== null) {
    const number = (osConstants.signals as Record<string, number>)[signal] ?? 0;
    return { success: false, code: 128 + number, signal };
  }
  return { success: code === 0, code: code ?? 1, signal: null };
}

/** Everything a stream yields, as one Uint8Array (not a Buffer: callers compare them). */
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * `startNow`, from a macrotask. Bun can see a fast child's exit inside the spawn call itself and,
 * when that call was made from a bare promise job (as `bun test` runs a test body), it also runs
 * the exit handling there, draining the pipes to nobody before any reader can attach. From a
 * macrotask it defers that handling past the spawn call, so `startNow` attaches first.
 */
async function start(
  program: string | URL,
  opts: CommandOptions,
  stdio: { stdin: Stdio; stdout: Stdio; stderr: Stdio },
): Promise<Child> {
  await new Promise((resolve) => setImmediate(resolve));
  return startNow(program, opts, stdio);
}

function startNow(
  program: string | URL,
  opts: CommandOptions,
  stdio: { stdin: Stdio; stdout: Stdio; stderr: Stdio },
): Promise<Child> {
  const name = program instanceof URL ? fileURLToPath(program) : program;
  const env = opts.clearEnv ? { ...opts.env } : { ...process.env, ...opts.env };
  // The child's own PATH when it is given one, else this process's: what Deno.Command did, and
  // not what node does with a cleared environment (it would look in the empty one).
  const resolved = lookup(name, opts.env?.PATH ?? process.env.PATH);
  if (resolved === null) {
    const err = Object.assign(new Error(`spawn ${name} ENOENT`), {
      code: "ENOENT",
      syscall: `spawn ${name}`,
      path: name,
    });
    return Promise.reject(err);
  }
  let child: ChildProcess;
  try {
    child = nodeSpawn(resolved, opts.args ?? [], {
      // The name it was asked for, as argv[0]: a multi-call binary reads it.
      argv0: name,
      cwd: opts.cwd instanceof URL ? fileURLToPath(opts.cwd) : opts.cwd,
      env,
      stdio: [node(stdio.stdin), node(stdio.stdout), node(stdio.stderr)] as StdioOptions,
      signal: opts.signal,
      uid: opts.uid,
      gid: opts.gid,
      detached: opts.detached ?? false,
      windowsHide: true,
    });
  } catch (err) {
    // A refused argument or environment (a NUL in one, say): node's and Bun's errors quote the
    // value, which may be a secret, into whatever logs or answers this error. Only its code.
    const code = (err as NodeJS.ErrnoException).code;
    return Promise.reject(
      Object.assign(
        new Error(`${name} could not be started${code ? ` (${code})` : ""}`),
        code ? { code } : {},
      ),
    );
  }

  // Bun's child_process, unlike node's, resumes a child's piped stdout and stderr when it handles
  // the exit, with or without a listener: whatever is unread then is emitted to nobody. So the
  // output pipes get their reader NOW, in the tick that spawned the child. A reader attached once
  // `spawn()` resolved (an event-loop turn on) came after the exit of a child that wrote and exited
  // fast, and read "" from a child that exited 0: under load, an empty sha from
  // `git rev-parse HEAD`. The web stream buffers up to its high-water mark and then pauses the
  // pipe, so an unread pipe still backs up the child.
  //
  // Bun can also handle the exit before `nodeSpawn` returns (seen under `bun test`): the exit
  // event has fired and the pipes have already been drained to nobody. Nothing can get that output
  // back, so reading it fails loudly rather than handing back "".
  const early = child.exitCode !== null || child.signalCode !== null;
  let exited: CommandStatus | null = early ? statusOf(child.exitCode, child.signalCode) : null;
  const status = new Promise<CommandStatus>((resolve, reject) => {
    if (exited !== null) resolve(exited);
    child.once("exit", (code, signal) => {
      exited = statusOf(code, signal);
      resolve(exited);
    });
    child.once("error", (err) => {
      // An abort's error comes after the exit, which has already said how it ended.
      if (exited === null && child.pid === undefined) reject(err);
    });
  });
  // A failed start rejects `spawn()` instead; a status nobody awaits must not be unhandled.
  status.catch(() => {});

  const reader = (pipe: Readable | null, which: string): ReadableStream<Uint8Array> | undefined => {
    if (pipe === null) return undefined;
    if (early && (pipe.readableEnded || pipe.destroyed)) {
      const lost = new Error(
        `${name} exited before its ${which} could be read, and the runtime discarded it`,
      );
      return new ReadableStream({ start: (controller) => controller.error(lost) });
    }
    return Readable.toWeb(pipe) as ReadableStream<Uint8Array>;
  };
  let stdin: WritableStream<Uint8Array> | undefined;
  const stdout = reader(child.stdout, "stdout");
  const stderr = reader(child.stderr, "stderr");
  const handle: Child = {
    get pid() {
      return child.pid!;
    },
    get stdin() {
      if (child.stdin === null) return notPiped("stdin");
      return stdin ??= Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    },
    get stdout() {
      return stdout ?? notPiped("stdout");
    },
    get stderr() {
      return stderr ?? notPiped("stderr");
    },
    status,
    async output() {
      const [out, err, done] = await Promise.all([
        stdout === undefined ? null : collect(stdout),
        stderr === undefined ? null : collect(stderr),
        status,
      ]);
      return {
        ...done,
        get stdout() {
          return out ?? notPiped("stdout");
        },
        get stderr() {
          return err ?? notPiped("stderr");
        },
      };
    },
    kill(signal: NodeJS.Signals = "SIGTERM") {
      if (exited !== null || child.exitCode !== null || child.signalCode !== null) {
        throw new TypeError("Child process has already terminated");
      }
      child.kill(signal);
    },
    ref() {
      child.ref();
      for (const pipe of [child.stdin, child.stdout, child.stderr]) {
        (pipe as { ref?: () => void } | null)?.ref?.();
      }
    },
    unref() {
      child.unref();
      // An open pipe holds the event loop as surely as the child does.
      for (const pipe of [child.stdin, child.stdout, child.stderr]) {
        (pipe as { unref?: () => void } | null)?.unref?.();
      }
    },
  };

  return new Promise<Child>((resolve, reject) => {
    const failed = (err: Error) => {
      child.off("spawn", spawned);
      reject(err);
    };
    const spawned = () => {
      child.off("error", failed);
      resolve(handle);
    };
    child.once("error", failed);
    child.once("spawn", spawned);
  });
}

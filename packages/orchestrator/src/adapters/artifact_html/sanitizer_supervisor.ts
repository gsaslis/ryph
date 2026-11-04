// The sanitizer supervisor: the process that starts the sanitizer, beside the control plane
// rather than inside it, and holding nothing worth taking: images/control-plane/sanitizer.sh
// runs it in a container of its own, as a uid of its own, with an emptied environment (no
// database URL, no token, no key). The control plane reaches it over a unix socket
// (socket_preparer.ts).
//
// It listens on that socket in a directory only its user can enter (0700, the socket 0600), or,
// with `--group`, one its group may enter too (0750, the socket 0660): the image's control plane
// is a member of the supervisor's group and nothing else is. Nobody else may enter it either way,
// and the group may never write to it. For each connection it reads one request (sanitizer_protocol.ts), starts the sanitizer process on
// it with the same confinement, deadline, kill and heap cap as process_preparer.ts, and answers.
// How that process runs is decided once, at start (`sanitizerRuntime`): under `node
// --permission` where a Node 25 or later is there, which the image should name in
// RYPH_ARTIFACT_SANITIZER_NODE so that nothing less will do; unconfined otherwise, said once on
// stderr. One document at a time: a second connection while one is being made is answered `busy`
// (the control plane already allows one at a time, so that only happens after its own deadline
// gave up on one). A client that hangs up kills the process it was waiting for.
//
// What reaches it is the control plane's: the author's HTML going in, the sanitizer's JSON coming
// back, which it passes on unread; the control plane checks it (socket_preparer.ts). If it dies,
// its container exits and is started again, so publishing is never lost for good.

import { chmodSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import {
  DEFAULT_ARTIFACT_HTML_BUDGET_MS,
  DEFAULT_ARTIFACT_HTML_HEAP_MB,
  sanitizerCommand,
  type SanitizerRun,
  sanitizerRuntime,
  startSanitizer,
  STARTUP_GRACE_MS,
} from "./process_preparer.ts";
import {
  type Conn,
  FrameTooLarge,
  MAX_REQUEST_BYTES,
  readFrame,
  socketConn,
  type SupervisorAnswer,
  writeFrame,
} from "./sanitizer_protocol.ts";

/** How long a client has to send its request once connected. */
const REQUEST_READ_MS = 5_000;

export interface SupervisorOptions {
  budgetMs?: number;
  graceMs?: number;
  heapMb?: number;
  /** The program and its arguments; tests pass one that misbehaves. */
  command?: (budgetMs: number, heapMb: number) => { cmd: string; args: string[] };
  /** Where it says what happened; one line each. */
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

/** Serves `server`, already listening, until it is closed; `stop()` also kills what is
 * running. */
export function serveSanitizer(
  server: Server,
  options: SupervisorOptions = {},
): { done: Promise<void>; stop(): void } {
  const budgetMs = options.budgetMs ?? DEFAULT_ARTIFACT_HTML_BUDGET_MS;
  const graceMs = options.graceMs ?? STARTUP_GRACE_MS;
  const heapMb = options.heapMb ?? DEFAULT_ARTIFACT_HTML_HEAP_MB;
  const command = options.command ?? sanitizerCommand;
  const log = options.log ?? (() => {});
  let running: SanitizerRun | null = null;
  /** A document is being made: from the moment its request is taken, its process starting. */
  let busy = false;
  let stopped = false;

  const answer = async (conn: Conn, body: SupervisorAnswer) => {
    try {
      await writeFrame(conn, new TextEncoder().encode(JSON.stringify(body)));
    } catch {
      // The client is gone; it has its own deadline.
    }
  };

  const handle = async (conn: Conn) => {
    const timer = setTimeout(() => conn.close(), REQUEST_READ_MS);
    let request: Uint8Array | null;
    try {
      request = await readFrame(conn, MAX_REQUEST_BYTES);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof FrameTooLarge) {
        await answer(conn, { kind: "fault", error: err.message });
      }
      return;
    } finally {
      clearTimeout(timer);
    }
    // A connection that ends before its request is a probe (socket_preparer.ts's boot check).
    if (request === null) return;
    if (busy || stopped) return await answer(conn, { kind: "busy" });
    busy = true;
    try {
      let run: SanitizerRun;
      try {
        run = await startSanitizer(new TextDecoder().decode(request), {
          budgetMs,
          graceMs,
          heapMb,
          command,
        });
      } catch (err) {
        log("error", `the artifact sanitizer could not start: ${String(err)}`);
        return await answer(conn, { kind: "fault", error: `could not start: ${String(err)}` });
      }
      running = run;
      // Stopped while it was starting.
      if (stopped) run.kill();
      // The client sends nothing more: anything it does (hanging up, at its deadline or its
      // shutdown) ends the process it was waiting for.
      conn.read(new Uint8Array(1)).then(() => run.kill(), () => run.kill());
      try {
        const { prepared, killed } = await run.done;
        if (killed) log("warn", "the artifact sanitizer was killed at its deadline");
        await answer(conn, { kind: "prepared", prepared, killed });
      } catch (err) {
        log("error", String(err));
        await answer(conn, { kind: "fault", error: String(err) });
      }
    } finally {
      // run.done settles once the process has exited.
      running = null;
      busy = false;
    }
  };

  server.on("connection", (socket) => {
    const conn = socketConn(socket);
    handle(conn).catch(() => {}).finally(() => conn.close());
  });
  // Ends when the server stops listening, as the accept loop it stands for would: connections
  // still being answered finish on their own.
  let finish = () => {};
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    server.once("close", () => resolve());
    server.once("error", (err) => stopped ? resolve() : reject(err));
  });
  return {
    done,
    stop() {
      stopped = true;
      running?.kill();
      // Nothing more is accepted from here; close() itself waits for open connections.
      server.close();
      finish();
    },
  };
}

function line(level: "info" | "warn" | "error", message: string): void {
  try {
    console.error(JSON.stringify({ level, service: "artifact-sanitizer", message }));
  } catch {
    // Nowhere to say it.
  }
}

/** The program: `sanitizer_supervisor.ts <socket path> [--group]`. */
async function main(args: string[]): Promise<void> {
  const [path, flag] = args;
  if (!path || path.startsWith("--") || args.length > 2 || (flag ?? "--group") !== "--group") {
    line("error", "usage: sanitizer_supervisor.ts <socket path> [--group]");
    process.exit(2);
  }
  const group = flag === "--group";
  const runtime = sanitizerRuntime();
  if (runtime.kind === "unavailable") {
    line("error", `the artifact sanitizer cannot start: ${runtime.why}`);
    process.exit(1);
  }
  if (runtime.kind === "unconfined") line("warn", runtime.why);
  else line("info", `the artifact sanitizer runs under ${runtime.node} --permission`);
  // Its directory is the boundary: only this user (and with --group, its group, reading) may
  // enter it.
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  if ((statSync(dir).mode & (group ? 0o027 : 0o077)) !== 0) {
    line(
      "error",
      group
        ? `${dir} must be a directory only its owner and group can enter, and only its owner write (0750)`
        : `${dir} must be a directory only its owner can enter (0700)`,
    );
    process.exit(1);
  }
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(path, group ? 0o660 : 0o600);
  const supervisor = serveSanitizer(server, {
    log: line,
    command: (budgetMs, heapMb) => sanitizerCommand(budgetMs, heapMb, runtime),
  });
  const stop = () => {
    supervisor.stop();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  line("info", `listening on ${path}`);
  await supervisor.done;
  process.exit(0);
}

if (import.meta.main) await main(process.argv.slice(2));

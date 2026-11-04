// The stdio transport: one JSON-RPC frame per line in, one per line out.
//
// Invariants:
// - stdout carries protocol frames and nothing else; anything worth logging goes to stderr
// - requests are answered as they finish, not in arrival order: a checks_run or run_wait that
//   waits takes minutes, and a ping behind it must not
// - a cancelled request is never answered
// - the input's end is a drain, then a cancel: calls in flight get a short grace window to answer
//   (`echo <call> | ryph mcp` prints its answer), and whatever still runs after it is cancelled,
//   so a client that went away leaves no process behind polling for it

import { Readable, Writable } from "node:stream";
import { TextLineStream } from "@std/streams/text-line-stream";
import {
  cancelledRequestId,
  duplicateIdError,
  type Frame,
  type Id,
  parseError,
  requestIdOf,
} from "@ryph/shared/mcp";
import { type CallContext, handleMessage, type ToolServer } from "./jsonrpc.ts";

export interface StdioOptions extends Omit<CallContext, "notify" | "signal"> {
  input?: ReadableStream<Uint8Array>;
  output?: WritableStream<Uint8Array>;
  /** How long calls in flight at the input's end get to answer before they are cancelled. */
  graceMs?: number;
  /** How long cancelled calls then get to unwind before this returns anyway. */
  drainMs?: number;
}

/**
 * Serves until the input ends, then gives the calls still in flight `graceMs` to answer, cancels
 * the rest and returns once they stopped, or after `drainMs` for one that does not. Lines are read as they come and handled
 * concurrently; writes go out one whole frame at a time. A `notifications/cancelled` aborts the
 * call it names, which is then not answered.
 */
export async function serveStdio(server: ToolServer, opts: StdioOptions): Promise<void> {
  const input = opts.input ?? (Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  const writer = (opts.output ?? (Writable.toWeb(process.stdout) as WritableStream<Uint8Array>))
    .getWriter();
  const encoder = new TextEncoder();
  let writing: Promise<void> = Promise.resolve();
  const send = (frame: Frame) => {
    const bytes = encoder.encode(`${JSON.stringify(frame)}\n`);
    writing = writing.then(() => writer.write(bytes)).catch((err) => {
      console.error("ryph mcp: could not write a frame:", err);
    });
  };
  const ctx: CallContext = {
    api: opts.api,
    cwd: opts.cwd,
    intervalMs: opts.intervalMs,
    notify: send,
  };
  const inFlight = new Set<Promise<void>>();
  /** Each request still being served, by id, so a cancellation can end it. */
  const calls = new Map<Id, AbortController>();

  const lines = input.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream());
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      send(parseError());
      continue;
    }
    const cancelled = cancelledRequestId(raw);
    if (cancelled !== null) {
      calls.get(cancelled)?.abort(new DOMException("the client cancelled the call", "AbortError"));
      calls.delete(cancelled);
      continue;
    }
    const id = requestIdOf(raw);
    // A second request under an id still being served would make either answer ambiguous: refuse
    // the newcomer and leave the original alone.
    if (id !== null && calls.has(id)) {
      send(duplicateIdError(id));
      continue;
    }
    const abort = new AbortController();
    if (id !== null) calls.set(id, abort);
    const task = handleMessage(raw, server, { ...ctx, signal: abort.signal }).then((frame) => {
      if (frame !== null && !abort.signal.aborted) send(frame);
    }).finally(() => {
      if (id !== null && calls.get(id) === abort) calls.delete(id);
    });
    inFlight.add(task);
    task.finally(() => inFlight.delete(task));
  }
  // The input ended: a piped `echo <call> | ryph mcp` ends it right after its request, so calls
  // in flight get a grace window to answer. Whatever still runs after it (a run_wait, a checks
  // run) is cancelled: nobody is left to wait for it.
  await settle(inFlight, opts.graceMs ?? 5000);
  for (const abort of calls.values()) {
    abort.abort(new DOMException("the client closed the connection", "AbortError"));
  }
  calls.clear();
  await settle(inFlight, opts.drainMs ?? 1000);
  await writing;
  await writer.close().catch(() => {});
}

/** Resolves once every task settled, or after `ms`, whichever comes first. */
async function settle(tasks: Set<Promise<void>>, ms: number): Promise<void> {
  if (tasks.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...tasks]),
    new Promise<void>((resolve) => timer = setTimeout(resolve, ms)),
  ]);
  clearTimeout(timer);
}

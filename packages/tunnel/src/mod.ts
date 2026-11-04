// Many TCP connections over one WebSocket: the wire a dev-server preview travels. The host end
// opens streams (one per browser request or upgrade) and hands each to node:http as its socket;
// the runner end dials the dev server for each and pipes the bytes. Both ends live here so the
// protocol has one definition.
//
// A binary frame is a 4-byte big-endian stream id and its bytes. A text frame is "ping" (the
// runner's heartbeat) or one of {"open"|"ack"|"end"|"close": id}. Each side keeps ONE frame in
// flight per stream and acks it once its reader has taken it, so a slow browser backpressures
// the dev server, nothing buffers more than a frame per stream, and one slow stream never holds
// up another. How many streams a host's tunnels may hold, and whose, is its budget's (`budget.ts`).
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { type Budget, type Charge, holdsCharge, MAX_STREAMS, sharedBudget } from "./budget.ts";
import { ackCost, type Cancel, RUN_ACK_RATE } from "./pace.ts";

export {
  type Connect,
  DRAIN_LIMIT,
  EARLY_BODY,
  EARLY_LIMIT,
  EarlyBodies,
  type EarlyBody,
  endToEnd,
  eventStream,
  lasting,
  PAUSED_WAITERS,
  POD_EARLY,
  type ProxyHooks,
  proxyHttp,
  proxyUpgrade,
  RECEIVE_BUFFER,
  REFUSE_GRACE_MS,
  refuseUpgrade,
  reset,
  SEND_BUFFER,
  UPGRADE_TIMEOUT_MS,
  withoutHopByHop,
} from "./proxy.ts";
export { type GateOptions, permitted } from "./gate.ts";
export {
  type Acquire,
  Budget,
  type BudgetOptions,
  type Cap,
  type CapName,
  type Charge,
  type GroupUsage,
  holdsCharge,
  type Kind,
  LINE_FLOOR,
  LINE_RESERVE,
  LONG_SHARE,
  MAX_STREAMS,
  PER_RUN,
  POD_STREAMS,
  POD_WAITING,
  type Pressure,
  promote,
  type Refusal,
  type Served,
  SERVED_BYTES,
  serves,
  sharedBudget,
  STALL_MS,
  STREAM_BYTES,
  WAIT_MS,
} from "./budget.ts";
export {
  ACK_COST_BYTES,
  ackCost,
  type Cancel,
  Pacer,
  type PacerOptions,
  POD_ACK_BURST,
  POD_ACK_RATE,
  RUN_ACK_BURST,
  RUN_ACK_RATE,
} from "./pace.ts";

/**
 * The largest frame payload either end sends or accepts; a longer write goes as several. Small,
 * because every stage between the tunnel and a browser that stops reading holds up to a frame:
 * 1 MiB frames had a stalled stream pin some 3 MiB. One frame in flight per
 * stream still moves a stream at 64 KiB a round trip, and the tunnel's round trip is within a
 * cluster or a machine.
 */
export const MAX_FRAME = 64 * 1024;
/**
 * Named by both ends as the WebSocket subprotocol when a tunnel is dialled, and refused without:
 * a runner and a host that disagree on the framing (MAX_FRAME above all) fail at the handshake,
 * where it is logged, rather than on the first frame one of them finds too long. Bump it with
 * any change to the wire.
 */
export const TUNNEL_PROTOCOL = "ryph-tunnel.2";

/** Whether a tunnel dial's `Sec-WebSocket-Protocol` offers TUNNEL_PROTOCOL. Both hosts refuse a
 * dial that does not, before its ticket is spent. */
export function offersTunnelProtocol(header: string | string[] | null | undefined): boolean {
  return [header ?? ""].flat().join(",").split(",").some((name) => name.trim() === TUNNEL_PROTOCOL);
}
/** What a stream buffers for its reader before it stops acking: a runner may send a frame on top
 * of what the reader has not taken yet. A reader that asks for more at once (`read(n)`) raises
 * the stream's mark to fit it, and the check on what the runner sends follows. */
const READ_HIGH_WATER = 16 * 1024;

type Signal = "open" | "ack" | "end" | "close";
const SIGNALS: readonly Signal[] = ["open", "ack", "end", "close"];
const MAX_ID = 0xffffffff;

/** What either end needs of its WebSocket. */
export interface Wire {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(): void;
  /** Destroys the socket at once, whatever it has queued; where there is none, `close`. A close
   * frame would queue behind the backlog that is the reason for closing, and the socket would
   * hold it until the close times out. */
  terminate?(): void;
}

/** The most the host's sends to one runner may queue past what its open streams are owed (each
 * a frame it sent and the runner has not acked: `excess`). What else may be there honestly is
 * frames of streams already closed, at most one each since the runner last read: a reload of a
 * page whose uploads were all in flight while the runner was slow is a tunnel's worth. More is a
 * runner acking what it never read, or one that stopped reading. Past it the tunnel is
 * terminated, whatever queued it. */
export const MAX_BACKLOG = (MAX_STREAMS + 1) * MAX_FRAME;
/** The most the host's sends to one runner may queue at all, owed or not: every open stream's
 * frame and a tunnel's worth of closed ones' (MAX_BACKLOG), and no more. Past it the tunnel is
 * terminated. */
export const MAX_BUFFERED = (2 * MAX_STREAMS + 1) * MAX_FRAME;
/** The most sends the host may have queued to one runner, whatever their size: a signal is a few
 * bytes on the wire but some 600 in memory while ws holds it, so a runner that stops reading and
 * keeps provoking acks would grow the queue by count long before MAX_BACKLOG by bytes. An honest
 * runner that reads nothing for a while has at most a few per stream queued (an open, a frame, an
 * ack, an end and a close): some 320 for a full tunnel. Past it the tunnel is terminated. */
export const MAX_QUEUED_SENDS = 2048;

/** Destroys `wire` at once where it can, or closes it. */
export function terminate(wire: Wire): void {
  if (typeof wire.terminate === "function") wire.terminate();
  else wire.close();
}

/** What a received message did: a heartbeat, an ordinary message, or a broken wire. The caller
 * closes the socket on `invalid`. */
export type Received = "ping" | "ok" | "invalid";

type Message =
  | { kind: "ping" }
  | { kind: "signal"; signal: Signal; id: number }
  | { kind: "data"; id: number; bytes: Uint8Array };

function parse(data: unknown): Message | null {
  if (data === "ping") return { kind: "ping" };
  if (data instanceof ArrayBuffer) {
    // An empty frame carries nothing but a demand for an ack; neither end sends one.
    if (data.byteLength <= 4 || data.byteLength > 4 + MAX_FRAME) return null;
    return { kind: "data", id: new DataView(data).getUint32(0), bytes: new Uint8Array(data, 4) };
  }
  if (typeof data !== "string" || data.length > 64) return null;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (message === null || typeof message !== "object") return null;
  const keys = Object.keys(message);
  const signal = keys[0] as Signal;
  const id = (message as Record<string, unknown>)[signal];
  if (keys.length !== 1 || !SIGNALS.includes(signal)) return null;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id > MAX_ID) return null;
  return { kind: "signal", signal, id };
}

function frame(id: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.byteLength);
  new DataView(out.buffer).setUint32(0, id);
  out.set(bytes, 4);
  return out;
}

const OPEN = 1; // WebSocket.OPEN, without needing the global in the type

function signaller(wire: Wire) {
  return (signal: Signal, id: number) => {
    if (wire.readyState === OPEN) wire.send(JSON.stringify({ [signal]: id }));
  };
}

/** The host's view of its wire: it counts what it sends and where each send ends, so it knows
 * which sends are still queued (ws sends in order: whatever lies before `drained()` has left).
 * Past MAX_BACKLOG bytes queued beyond what its streams are owed (`owed`), MAX_BUFFERED bytes in
 * all, or MAX_QUEUED_SENDS sends, the next send terminates it. */
interface Guarded extends Wire {
  /** Bytes handed to the socket so far: where the next send starts. */
  readonly sent: number;
  /** Bytes of those the socket has passed on; every send that ends at or before it has left the
   * queue. Its frame headers are not counted, so this is a little behind, never ahead. */
  drained(): number;
  /** Whether its queue is past what an honest runner leaves there (`overBacklog`). */
  over(): boolean;
}

/** Whether a socket that has `buffered` bytes queued, `owed` of them frames its open streams wait
 * on an ack for, holds more than an honest runner would leave it. */
export function overBacklog(buffered: number, owed: number): boolean {
  return buffered > MAX_BUFFERED || buffered - owed > MAX_BACKLOG;
}

function guarded(wire: Wire, owed: (drained: number) => number): Guarded {
  let sent = 0;
  // Where each send ends, oldest first, from `first` on; those before it have left the queue.
  let ends: number[] = [];
  let first = 0;
  const drained = () => Math.max(0, sent - wire.bufferedAmount);
  return {
    get readyState() {
      return wire.readyState;
    },
    get bufferedAmount() {
      return wire.bufferedAmount;
    },
    get sent() {
      return sent;
    },
    drained,
    over: () => overBacklog(wire.bufferedAmount, owed(drained())),
    close: () => wire.close(),
    terminate: () => terminate(wire),
    send(data) {
      const left = drained();
      while (first < ends.length && ends[first] <= left) first++;
      if (first > 1024) [ends, first] = [ends.slice(first), 0];
      const buffered = wire.bufferedAmount;
      // What streams are owed is counted only when the bytes alone say it may matter.
      if (
        (buffered > MAX_BACKLOG && overBacklog(buffered, owed(left))) ||
        ends.length - first >= MAX_QUEUED_SENDS
      ) {
        terminate(wire);
        return;
      }
      wire.send(data);
      // Every string this end sends is a signal, ASCII.
      sent += typeof data === "string" ? data.length : data.byteLength;
      ends.push(sent);
    },
  };
}

/** What the runner end says of one open stream. Each is false when it cannot apply in the state
 * the stream is in, which no honest runner does: the tunnel is then broken (`invalid`). */
interface HostStream {
  stream: Duplex;
  /** Bytes of its frame waiting for the runner's ack that are still in the socket's queue: the
   * part of the queue this stream may hold. */
  queued(drained: number): number;
  /** False after the runner's end or close, or before this end acked its last frame. */
  data(bytes: Uint8Array): boolean;
  /** False when nothing was waiting on it: the runner acked a frame it was never sent. */
  ack(): boolean;
  /** False after the runner's end or close. */
  end(): boolean;
  /** False after the runner's close. */
  close(): boolean;
}

function hostStream(
  id: number,
  wire: Guarded,
  charge: Charge,
  pace: (cost: number, ack: () => void) => Cancel,
  unpaid: (cost: number) => void,
  forget: () => void,
): HostStream {
  const signal = signaller(wire);
  // The write waiting on acks, and what is left of it to send, a frame at a time.
  let written: ((error?: Error | null) => void) | null = null;
  let unsent: Uint8Array | null = null;
  // Where in what the wire was sent the frame waiting on its ack lies.
  let frameAt: { start: number; end: number } | null = null;
  let acknowledgeRead = false;
  // What the frame waiting on its ack cost the host (`ackCost`): what its ack spends of the pace.
  let cost = 1;
  // Whether the runner may send its next frame: until its first, and after each this end acked.
  // An honest runner keeps one in flight and waits for the ack.
  let mayReceive = true;
  // The far end may close right after it ends; what it sent before must still reach the reader.
  let remoteEnded = false;
  let remoteClosed = false;
  // What both readers have taken: the browser's side what it read of what the runner sent, the
  // dev server's side every frame it acked. The budget's stall rule watches it move.
  let pushed = 0;
  let acked = 0;
  // Lets the runner send its next frame, when its run's pace allows (`pace`); cancelled if the
  // stream goes first.
  let waiting: Cancel | null = null;
  const acknowledge = () => {
    let sent = false;
    const cancel = pace(cost, () => {
      sent = true;
      waiting = null;
      mayReceive = true;
      signal("ack", id);
    });
    // Sent at once (before `pace` returned): nothing waits.
    if (!sent) waiting = cancel;
  };
  // Settles the write waiting on an ack. Only a dead wire is an error: one the far end closed
  // just drops what it will never read, because erroring a Duplex destroys it, and with it the
  // bytes this end has not read yet.
  const settle = (error?: Error) => {
    const callback = written;
    written = null;
    unsent = null;
    frameAt = null;
    callback?.(error);
  };
  const sendFrame = () => {
    const piece = unsent!.subarray(0, MAX_FRAME);
    unsent = unsent!.byteLength > MAX_FRAME ? unsent!.subarray(MAX_FRAME) : null;
    const start = wire.sent;
    wire.send(frame(id, piece));
    frameAt = { start, end: wire.sent };
  };
  const stream: Duplex = new Duplex({
    readableHighWaterMark: READ_HIGH_WATER,
    read() {
      if (acknowledgeRead) {
        acknowledgeRead = false;
        acknowledge();
      }
    },
    write(chunk: Uint8Array, _encoding, callback) {
      const done = (error?: Error | null) => callback(error);
      if (remoteClosed || chunk.byteLength === 0) done();
      else if (wire.readyState !== OPEN) done(new Error("tunnel stream closed"));
      else {
        written = done;
        unsent = chunk;
        sendFrame();
      }
    },
    final(done) {
      signal("end", id);
      done();
    },
    destroy(_error, done) {
      // A frame taken and never acked was work all the same: its waiting ack, which would pin
      // this stream and what it holds, goes and is charged; one not yet asked for is charged.
      waiting?.();
      waiting = null;
      if (acknowledgeRead) unpaid(cost);
      acknowledgeRead = false;
      forget();
      if (!remoteClosed) signal("close", id);
      settle(new Error("tunnel stream closed"));
      done();
    },
  });
  // A stream may die before node:http has adopted it and listened for errors.
  stream.on("error", () => {});
  charge.buffered = () => stream.readableLength + stream.writableLength;
  charge.taken = () => pushed - stream.readableLength + acked;
  charge.close = () => stream.destroy(new Error("tunnel stream stalled"));
  holdsCharge(stream, charge);
  return {
    stream,
    queued: (drained) =>
      frameAt === null ? 0 : Math.max(0, frameAt.end - Math.max(frameAt.start, drained)),
    data(bytes) {
      // An honest runner sends a frame only once acked, and this acks only below the mark: the
      // stream's own, which a reader's `read(n)` past it raises to fit n.
      if (
        remoteEnded || remoteClosed || !mayReceive ||
        stream.readableLength + bytes.byteLength > stream.readableHighWaterMark + MAX_FRAME
      ) {
        return false;
      }
      mayReceive = false;
      cost = ackCost(bytes.byteLength);
      pushed += bytes.byteLength;
      if (stream.push(bytes.slice())) acknowledge();
      else acknowledgeRead = true;
      return true;
    },
    ack() {
      if (written === null) return false;
      acked++;
      frameAt = null;
      if (unsent === null) settle();
      else if (wire.readyState === OPEN) sendFrame();
      else settle(new Error("tunnel stream closed"));
      return true;
    },
    end() {
      if (remoteEnded || remoteClosed) return false;
      remoteEnded = true;
      stream.push(null);
      return true;
    },
    close() {
      // Once: each close of a draining stream would add a listener of its own.
      if (remoteClosed) return false;
      remoteClosed = true;
      if (!remoteEnded || stream.readableEnded) {
        stream.destroy();
        return true;
      }
      // Nothing more can be written; let the reader drain what is buffered, then let go.
      settle();
      stream.once("end", () => stream.destroy());
      return true;
    },
  };
}

/** The end that opens streams: the preview host. */
export interface HostMux {
  /** A new stream, waiting its turn while a cap is full (the budget's line); rejects when the wire
   * is down, the line is full, none frees within its wait (WAIT_MS, or `waitMs` when less), or
   * `signal` aborts first. `long` for one that may never end (an upgrade, an event stream). */
  stream(signal?: AbortSignal, opts?: { long?: boolean; waitMs?: number }): Promise<Duplex>;
  receive(data: unknown): Received;
  /** Streams now open. */
  readonly size: number;
  /** Bytes its socket has queued past the frames its streams are owed an ack for that are still
   * in the queue: what an honest runner, reading as it should, would not leave there. */
  excess(): number;
  /** Whether its socket's queue is past MAX_BACKLOG of excess or MAX_BUFFERED in all: a runner
   * that does not read. Its own sends check this; a sweep may too. */
  overBacklog(): boolean;
  close(): void;
}

/** What a runner may send for a stream the host already let go of: what was in flight when it
 * did, at most a data frame, an ack, an end and a close. Each stream the host lets go earns the
 * tunnel this much credit for late messages, and each late message spends one. */
export const LATE_PER_STREAM = 4;
/** Late credit a tunnel starts with, and holds past what its streams earned. */
export const LATE_SLACK = 64;
/** The most late credit a tunnel holds: a full tunnel's streams let go at once, and the slack.
 * Credit is earned per stream let go, never per stream opened, so it is never banked past this. */
export const LATE_CREDIT = LATE_PER_STREAM * MAX_STREAMS + LATE_SLACK;
/** Late messages a tunnel may take a second, past LATE_CREDIT at once: as many as its run's acks
 * (RUN_ACK_RATE). An honest runner sends one or two per stream let go, promptly, and its streams
 * end no faster than their frames are acked. What they cost the host is charged to the run's pace
 * as well, as a frame's ack would be, and past RUN_ACK_BURST of debt of their own they are refused
 * (`Pacer.late`). */
export const LATE_RATE = RUN_ACK_RATE;
// The runner's heartbeat is every 15 s; a handful a second is already a flood.
const MAX_PINGS_PER_SECOND = 5;

export interface HostMuxOptions {
  /** What its streams are charged against. Default: the process's own (`sharedBudget()`). */
  budget?: Budget;
  /** Whose caps (PER_RUN) its streams and waiting requests count against: the run, so its
   * previews share them. Default: this tunnel's own. */
  group?: unknown;
  /** Seam for tests: the clock the runner's heartbeat and its late messages are held to. Its
   * acks' pace keeps the budget's (`Budget.pacer`). */
  now?: () => number;
}

export function hostMux(socket: Wire, opts: HostMuxOptions = {}): HostMux {
  const budget = opts.budget ?? sharedBudget();
  const group = opts.group ?? Symbol("tunnel");
  const streams = new Map<number, HostStream>();
  const owed = (drained: number) => {
    let bytes = 0;
    for (const entry of streams.values()) bytes += entry.queued(drained);
    return bytes;
  };
  const wire = guarded(socket, owed);
  const now = opts.now ?? Date.now;
  let next = 0;
  // Late messages it may still take (LATE_PER_STREAM per stream let go, at most LATE_CREDIT), and
  // their own bucket (LATE_CREDIT at once, LATE_RATE a second): past either, the wire is broken.
  let lateCredit = LATE_SLACK;
  const lateBucket = { tokens: LATE_CREDIT, filled: now() };
  let pingSecond = 0;
  let pings = 0;
  // Once the wire is broken, everything after is too, at no cost: the caller is tearing it down.
  let broken = false;
  // Its acks keep its run's pace, shared by the run's every tunnel, and the process's.
  const pace = (cost: number, ack: () => void) => budget.pacer.pace(group, cost, ack);
  // A frame taken whose ack was never asked for is charged to the run's pace all the same.
  const unpaid = (cost: number) => budget.pacer.charge(group, cost);
  const late = (message: Message & { id: number }) => {
    const at = now();
    lateBucket.tokens = Math.min(
      LATE_CREDIT,
      lateBucket.tokens + Math.max(0, at - lateBucket.filled) * LATE_RATE / 1000,
    );
    lateBucket.filled = Math.max(lateBucket.filled, at);
    if (lateCredit < 1 || lateBucket.tokens < 1) return false;
    lateCredit--;
    lateBucket.tokens--;
    return budget.pacer.late(
      group,
      ackCost(message.kind === "data" ? message.bytes.byteLength : 0),
    );
  };
  // Aborted when the tunnel goes: every request of it still in the budget's line leaves.
  const gone = new AbortController();
  const usable = () => wire.readyState === OPEN && next <= MAX_ID;
  // A browser speaking HTTP/2 to the preview (any hosted one, behind a balancer) sends every module
  // request of a page at once, far past the stream cap; they wait for a stream in the budget's
  // line as they would for a connection of their own.
  const room = () => usable() && streams.size < MAX_STREAMS;
  function opened(charge: Charge): Duplex {
    // Never reused, so a late frame for a finished stream cannot land on a new one.
    const id = next++;
    const entry = hostStream(id, wire, charge, pace, unpaid, () => {
      streams.delete(id);
      lateCredit = Math.min(LATE_CREDIT, lateCredit + LATE_PER_STREAM);
      // The budget hands the freed stream to whoever has waited longest and fits.
      charge.release();
      if (!usable()) gone.abort(new Error("preview disconnected"));
    });
    streams.set(id, entry);
    signaller(wire)("open", id);
    return entry.stream;
  }
  /**
   * What `message` does, the runner end untrusted: anything no honest runner sends, in the state
   * its stream is in, is `invalid`. Nothing it accepts is refused for its pace: every such message
   * answers one the host sent (a frame for each ack, an ack for each frame, an end and a close for
   * each open), so what a runner may send is what the host's own sends let it, and one busy honest
   * stream on a fast wire is tens of thousands a second (a cap there broke page loads). The host's
   * work is held to a pace by its acks instead (`pace.ts`), which slows a runner and never breaks
   * it. What answers nothing — messages late for streams this end let go of, and the heartbeat —
   * has budgets of its own: late ones spend credit each stream let go earns (LATE_PER_STREAM, at
   * most LATE_CREDIT held), go through a bucket of their own (LATE_RATE), and are charged to the
   * run's pace, which refuses them past what its run may owe (`Pacer.late`).
   */
  function take(message: Message | null): Received {
    if (message === null) return "invalid";
    if (message.kind === "ping") {
      const second = Math.floor(now() / 1000);
      if (second !== pingSecond) [pingSecond, pings] = [second, 0];
      return ++pings > MAX_PINGS_PER_SECOND ? "invalid" : "ping";
    }
    // Only the host opens streams, and only ids it handed out can be spoken of.
    if (message.kind === "signal" && message.signal === "open") return "invalid";
    if (message.id >= next) return "invalid";
    const entry = streams.get(message.id);
    if (!entry) {
      // Messages for a stream this end already let go of are late, not wrong; within reason.
      return late(message) ? "ok" : "invalid";
    }
    let applies: boolean;
    if (message.kind === "data") applies = entry.data(message.bytes);
    else if (message.signal === "ack") applies = entry.ack();
    else if (message.signal === "end") applies = entry.end();
    else applies = entry.close();
    return applies ? "ok" : "invalid";
  }
  return {
    stream(signal, kind = {}) {
      if (!usable()) return Promise.reject(new Error("preview disconnected"));
      return budget.acquire(group, {
        long: kind.long,
        waitMs: kind.waitMs,
        ready: room,
        signal: signal ? AbortSignal.any([signal, gone.signal]) : gone.signal,
        use: opened,
      });
    },
    receive(data) {
      if (broken) return "invalid";
      const received = take(parse(data));
      if (received === "invalid") broken = true;
      return received;
    },
    get size() {
      return streams.size;
    },
    excess() {
      return Math.max(0, wire.bufferedAmount - owed(wire.drained()));
    },
    overBacklog: () => wire.over(),
    close() {
      gone.abort(new Error("preview disconnected"));
      // Its acks still waiting go, each charged to the run's pace: their frames were taken.
      for (const entry of streams.values()) entry.stream.destroy();
    },
  };
}

/** The end that dials: the runner, beside the dev server. */
export interface RunnerMux {
  receive(data: unknown): Received;
  close(): void;
}

/** How long a dial may take before its stream is refused. */
const DIAL_TIMEOUT_MS = 10_000;

/**
 * `dial` must open its socket with `allowHalfOpen: true`: a dev server that half-closes (sends
 * its whole answer, keeps reading) must still get what the browser sends after.
 */
export function runnerMux(wire: Wire, dial: () => Socket): RunnerMux {
  const signal = signaller(wire);
  interface RunnerStream {
    tcp: Socket;
    hostClosed: boolean;
    /** What is left of the dev server's last chunk, going a frame per ack: a chunk may be
     * longer than a frame. */
    unsent: Uint8Array | null;
    /** A frame of it is on the wire, not yet acked: the next waits for the ack. */
    inFlight: boolean;
    /** The dev server's end and close, held back until the chunk before them is all sent. */
    ended: boolean;
    closed: boolean;
  }
  const streams = new Map<number, RunnerStream>();
  function send(id: number, entry: RunnerStream) {
    const unsent = entry.unsent!;
    entry.unsent = unsent.byteLength > MAX_FRAME ? unsent.subarray(MAX_FRAME) : null;
    entry.inFlight = true;
    wire.send(frame(id, unsent.subarray(0, MAX_FRAME)));
    if (entry.unsent === null) {
      if (entry.ended) signal("end", id);
      if (entry.closed) finish(id, entry);
    }
  }
  function finish(id: number, entry: RunnerStream) {
    // The host's close already freed the id; it must not free a later stream's.
    if (streams.get(id) === entry) streams.delete(id);
    if (!entry.hostClosed) signal("close", id);
  }
  function open(id: number) {
    // Over the cap means the host counted a stream gone before this end did: refuse the one.
    if (streams.size >= MAX_STREAMS) {
      signal("close", id);
      return;
    }
    const tcp = dial();
    const entry: RunnerStream = {
      tcp,
      hostClosed: false,
      unsent: null,
      inFlight: false,
      ended: false,
      closed: false,
    };
    streams.set(id, entry);
    const timer = setTimeout(() => tcp.destroy(), DIAL_TIMEOUT_MS);
    tcp.once("connect", () => clearTimeout(timer));
    tcp.on("data", (chunk: Uint8Array) => {
      tcp.pause();
      if (wire.readyState !== OPEN) {
        tcp.destroy();
        return;
      }
      // A paused socket may still hand over a chunk it already read. It joins what is left
      // rather than replacing it, and waits for the ack of the frame already on the wire: one
      // frame in flight per stream is what the host holds its reader to.
      if (entry.unsent === null) entry.unsent = chunk;
      else {
        const joined = new Uint8Array(entry.unsent.byteLength + chunk.byteLength);
        joined.set(entry.unsent);
        joined.set(chunk, entry.unsent.byteLength);
        entry.unsent = joined;
      }
      if (!entry.inFlight) send(id, entry);
    });
    tcp.on("end", () => {
      entry.ended = true;
      if (entry.unsent === null) signal("end", id);
    });
    tcp.on("error", () => {});
    tcp.on("close", () => {
      clearTimeout(timer);
      entry.closed = true;
      if (entry.unsent === null || wire.readyState !== OPEN) finish(id, entry);
    });
  }
  return {
    receive(data) {
      const message = parse(data);
      if (message === null) return "invalid";
      if (message.kind === "ping") return "ping";
      if (message.kind === "signal" && message.signal === "open") {
        if (streams.has(message.id)) return "invalid";
        open(message.id);
        return "ok";
      }
      const entry = streams.get(message.id);
      if (!entry) return "ok";
      const { tcp } = entry;
      if (message.kind === "data") {
        if (tcp.writableLength + message.bytes.byteLength > MAX_FRAME) tcp.destroy();
        else {
          tcp.write(message.bytes.slice(), (error) => {
            if (!error) signal("ack", message.id);
          });
        }
      } else if (message.signal === "ack") {
        entry.inFlight = false;
        if (entry.unsent !== null) send(message.id, entry);
        else if (!entry.closed) tcp.resume();
      } else if (message.signal === "end") tcp.end();
      else {
        // Freed at once, as the host frees it: both ends count the same streams against the cap.
        entry.hostClosed = true;
        entry.unsent = null;
        streams.delete(message.id);
        tcp.destroy();
      }
      return "ok";
    },
    close() {
      for (const entry of streams.values()) {
        entry.unsent = null;
        entry.tcp.destroy();
      }
    },
  };
}

// How one previews pod reaches another, when there are several (core/cluster.ts says which). Every
// hop is ONE fresh TCP connection to an address from configuration — a peer's ordinal picks it,
// never anything else a request says — used for one request and closed: nothing is pooled, so no
// client's bytes can be read as part of another's request on a shared connection.
import { request } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  type Budget,
  type Cap,
  type Charge,
  type Connect,
  holdsCharge,
  RECEIVE_BUFFER,
  reset,
  SEND_BUFFER,
} from "@ryph/tunnel";
import type { Peer } from "./core/cluster.ts";

/** How long a peer has to accept a connection. Pods share a cluster network; a peer that takes
 * longer is gone (restarting, or not started yet). */
export const PEER_CONNECT_MS = 2_000;
/** How long a forwarded internal call may take: short of every wait of the control plane's (the
 * shortest, a list's and a preview's lookup, is 3 s), so a peer that does not answer is this pod's
 * own 503 rather than the control plane giving up on a call still in flight. */
export const FORWARD_MS = 2_500;
/**
 * What one run's relays may hold on a pod that does not own it: 32 at once, 24 of them long-lived,
 * and small lines. A run's requests reach the pods in front of its owner spread across them, and
 * wait their turn at the owner's tunnel anyway (64 streams), so a pod needs only its share of them
 * in flight: half at two pods. Beside it, every run's relays together have a part of the pod of
 * their own (`relays` in @ryph/tunnel's Budget), which never takes the streams of the runs the pod
 * owns. What a run may make any one pod hold stays the same however many pods there are.
 */
export const PER_RELAY: Cap = {
  name: "relay",
  open: 32,
  long: 24,
  waiting: 128,
  waitingLong: 16,
};

/** A peer that did not take a connection: gone, restarting, or not started yet. */
export class PeerUnreachable extends Error {}
/** The most of an internal answer a forwarding pod reads back; the owner's are a few kB at most. */
const MAX_FORWARD_ANSWER = 64 * 1024;

/** A fresh connection to `port` on `peer`; rejects once `signal` aborts or the peer does not
 * answer in time, and leaves no socket behind either way. `track` hears of it, so a drain can
 * close it. */
export function dialPeer(
  peer: Peer,
  port: number,
  signal: AbortSignal,
  track: (socket: Socket) => void,
): Promise<Socket> {
  if (signal.aborted) return Promise.reject(new Error("request abandoned"));
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: peer.host, port, allowHalfOpen: true });
    track(socket);
    const fail = (error: Error) => {
      settle();
      socket.destroy();
      reject(error);
    };
    const abandoned = () => fail(new Error("request abandoned"));
    const failed = () => fail(new PeerUnreachable("peer unreachable"));
    const timer = setTimeout(
      () => fail(new PeerUnreachable("peer did not answer")),
      PEER_CONNECT_MS,
    );
    function settle() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abandoned);
      socket.off("error", failed);
    }
    signal.addEventListener("abort", abandoned, { once: true });
    socket.once("error", failed);
    socket.once("connect", () => {
      settle();
      // Whoever holds it from here destroys it on their own errors; until then, an error closes it.
      socket.on("error", () => socket.destroy());
      resolve(socket);
    });
  });
}

/**
 * A `Connect` for `proxyHttp`/`proxyUpgrade` that reaches `port` on `peer` instead of a tunnel
 * stream, counted to `group` in `budget` under PER_RELAY and the budget's relays (`long` for an
 * upgrade or an event stream, as a tunnel stream would be), waiting in the budget's line like a
 * tunnel stream.
 *
 * The charge is taken first, so that dials are capped too, and lives exactly as long as the
 * socket: released when it closes, and when the charge is closed (stalled, or shed under memory
 * pressure) a dial still under way is abandoned and the socket reset (what it had not sent would
 * otherwise wait in its kernel for a peer that may not read it), so no socket outlives its charge.
 */
export function relay(
  peer: Peer,
  port: number,
  track: (socket: Socket) => void,
  charged: { budget: Budget; group: unknown; long?: boolean },
): Connect {
  return async (signal): Promise<Duplex> => {
    const dialling = new AbortController();
    let socket: Socket | undefined;
    const charge: Charge = await charged.budget.acquire(charged.group, {
      cap: PER_RELAY,
      long: charged.long,
      relay: true,
      signal,
      use: (charge) => charge,
    });
    charge.close = () => {
      dialling.abort();
      reset(socket);
      charge.release();
    };
    try {
      socket = await dialPeer(peer, port, AbortSignal.any([signal, dialling.signal]), track);
    } catch (error) {
      charge.release();
      throw error;
    }
    const held = socket;
    held.once("close", () => charge.release());
    // An event stream the owner answers is promoted here as there (`proxyHttp`).
    holdsCharge(held, charge);
    // What the owner sent that the browser has not read, and what the browser sent that the
    // owner has not, each with its kernel's buffer while it fills: the send buffer once anything
    // waits past it, the receive buffer while the socket is paused (its reader, the browser's
    // response, backed up behind a browser that stopped reading, as measured). A relay carries one
    // exchange and its pipes flow unless backed up, so it is never paused idle. What the stall
    // rule watches, with what each reader has taken in all.
    charge.buffered = () =>
      held.readableLength + held.writableLength + (held.writableLength > 0 ? SEND_BUFFER : 0) +
      (held.isPaused() ? RECEIVE_BUFFER : 0);
    charge.taken = () =>
      held.bytesRead - held.readableLength + held.bytesWritten - held.writableLength;
    return held;
  };
}

/** An answer to a forwarded internal call, or null when the owner could not be asked. */
export interface Forwarded {
  status: number;
  contentType: string | undefined;
  body: Uint8Array;
}

/**
 * Forwards one internal call to `peer`'s API listener: method, path and the body this pod
 * already read, with `hop` set to the forward credential in place of the control plane's bearer
 * (the token never travels between pods), which also marks it as one the owner never forwards
 * again. Null when the peer cannot be reached, does not answer in time, or answers more than an
 * internal answer ever is.
 */
export function forwardInternal(
  peer: Peer,
  call: { method: string; path: string; body?: Uint8Array },
  hop: { header: string; credential: string },
  track: (socket: Socket) => void,
): Promise<Forwarded | null> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      [hop.header]: hop.credential,
      connection: "close",
    };
    if (call.body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(call.body.byteLength);
    }
    const answered = (answer: Forwarded | null) => {
      clearTimeout(timer);
      resolve(answer);
    };
    const out = request({
      host: peer.host,
      port: peer.apiPort,
      method: call.method,
      path: call.path,
      headers,
      agent: false,
    }, (res) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      res.on("data", (chunk: Uint8Array) => {
        size += chunk.byteLength;
        if (size > MAX_FORWARD_ANSWER) {
          out.destroy();
          answered(null);
        } else chunks.push(chunk);
      });
      res.on("error", () => answered(null));
      res.on("end", () => {
        const body = new Uint8Array(size);
        let at = 0;
        for (const chunk of chunks) {
          body.set(chunk, at);
          at += chunk.byteLength;
        }
        const type = res.headers["content-type"];
        answered({ status: res.statusCode ?? 502, contentType: type, body });
      });
    });
    out.on("socket", (socket: Socket) => track(socket));
    const timer = setTimeout(() => {
      out.destroy();
      resolve(null);
    }, FORWARD_MS);
    out.on("error", () => answered(null));
    out.end(call.body);
  });
}

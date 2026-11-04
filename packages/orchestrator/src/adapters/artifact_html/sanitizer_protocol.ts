// The wire between the control plane and the sanitizer supervisor (sanitizer_supervisor.ts,
// socket_preparer.ts): one request and one answer per connection, each a frame of a 4-byte
// big-endian length and that many bytes. The request is the author's HTML as UTF-8; the answer is
// JSON (`SupervisorAnswer`). Both ends refuse a frame longer than they expect before reading it,
// and both put a deadline on the whole exchange by closing the connection, which ends any read.

import { connect, type NetConnectOpts, type Socket } from "node:net";
import { MAX_SERIALIZED_LENGTH } from "../../helpers/artifact_html.ts";

/** The longest request: the 2 MiB a publish may carry (core/artifacts.ts
 * MAX_ARTIFACT_HTML_BYTES), with room to spare. */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
/** The longest answer: a served document at its cap, every code unit written by JSON as six
 * bytes (`\u0001`), and its refs. */
export const MAX_ANSWER_BYTES = 6 * MAX_SERIALIZED_LENGTH + 1024 * 1024;

export type SupervisorAnswer =
  /** The sanitizer's answer, unchecked (the client checks it); `killed` when the deadline
   * stopped it. */
  | { kind: "prepared"; prepared: unknown; killed: boolean }
  /** It is making another document: one at a time. */
  | { kind: "busy" }
  /** It could not make this one, through no fault of the document's. */
  | { kind: "fault"; error: string };

export class FrameTooLarge extends Error {
  constructor(length: number, max: number) {
    super(`a frame of ${length} bytes, past the ${max} expected`);
  }
}

/** A stream connection as the framing reads and writes it: a unix socket in the image, TCP on
 * loopback in the tests. */
export interface Conn {
  /** Fills some of `buffer`: how many bytes, or null once the peer has ended. Rejects once this
   * side has closed it. */
  read(buffer: Uint8Array): Promise<number | null>;
  /** Writes all of `bytes`. */
  write(bytes: Uint8Array): Promise<number>;
  close(): void;
}

/** How much a connection buffers before it stops reading from the socket. */
const HIGH_WATER = 64 * 1024;

/** `socket` as a `Conn`. Closing it destroys the socket and rejects a read that waits. */
export function socketConn(socket: Socket): Conn {
  const chunks: Uint8Array[] = [];
  let buffered = 0;
  let ended = false;
  let failure: Error | null = null;
  let wake = () => {};
  const woken = () => {
    const w = wake;
    wake = () => {};
    w();
  };
  socket.on("data", (chunk: Buffer) => {
    chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    buffered += chunk.byteLength;
    if (buffered >= HIGH_WATER) socket.pause();
    woken();
  });
  socket.on("end", () => {
    ended = true;
    woken();
  });
  socket.on("error", (err) => {
    failure ??= err;
    woken();
  });
  socket.on("close", () => {
    ended = true;
    woken();
  });
  return {
    async read(buffer) {
      while (chunks.length === 0) {
        if (failure !== null) throw failure;
        if (ended) return null;
        await new Promise<void>((resolve) => wake = resolve);
      }
      const chunk = chunks[0];
      const n = Math.min(chunk.length, buffer.length);
      buffer.set(chunk.subarray(0, n));
      if (n === chunk.length) chunks.shift();
      else chunks[0] = chunk.subarray(n);
      buffered -= n;
      if (buffered < HIGH_WATER && socket.isPaused()) socket.resume();
      return n;
    },
    write(bytes) {
      return new Promise((resolve, reject) => {
        if (failure !== null) return reject(failure);
        socket.write(bytes, (err) => err ? reject(err) : resolve(bytes.length));
      });
    },
    close() {
      failure ??= new Error("the connection was closed");
      socket.destroy();
      woken();
    },
  };
}

/** Connects to a unix socket (`{ path }`) or TCP (`{ host, port }`); rejects if it cannot. */
export function dial(to: NetConnectOpts): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const socket = connect(to);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socketConn(socket));
    });
  });
}

/** Fills `buffer` from `conn`; false if the connection ended before the first byte. */
async function readExactly(conn: Conn, buffer: Uint8Array): Promise<boolean> {
  let at = 0;
  while (at < buffer.length) {
    const n = await conn.read(buffer.subarray(at));
    if (n === null) {
      if (at === 0) return false;
      throw new Error("the connection ended inside a frame");
    }
    at += n;
  }
  return true;
}

/** The next frame, or null when the connection ended cleanly before one began. Throws
 * `FrameTooLarge` past `max`, before reading the body. */
export async function readFrame(conn: Conn, max: number): Promise<Uint8Array | null> {
  const header = new Uint8Array(4);
  if (!await readExactly(conn, header)) return null;
  const length = new DataView(header.buffer).getUint32(0);
  if (length > max) throw new FrameTooLarge(length, max);
  const body = new Uint8Array(length);
  if (length > 0 && !await readExactly(conn, body)) {
    throw new Error("the connection ended inside a frame");
  }
  return body;
}

/** Writes `body` as one frame. */
export async function writeFrame(conn: Conn, body: Uint8Array): Promise<void> {
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length);
  frame.set(body, 4);
  for (let at = 0; at < frame.length;) at += await conn.write(frame.subarray(at));
}

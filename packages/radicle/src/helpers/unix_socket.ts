// A client connection to a UNIX socket, as the node control socket and an ssh-agent are reached.
//
// What the callers lean on: a connect that REJECTS when nothing listens, a write that settles
// once the bytes are handed to the kernel, and a socket whose reads (its async iterator) throw
// once it has been destroyed under them — which is how a deadline or an abort cuts a read short.

import { connect, type Socket } from "node:net";

/** Connects to the socket at `path`, or rejects with node's error (ENOENT, ECONNREFUSED). */
export function connectUnix(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path });
    const failed = (err: Error) => reject(err);
    socket.once("error", failed);
    socket.once("connect", () => {
      socket.off("error", failed);
      // A later error surfaces through the read in progress; without a listener it would be
      // thrown out of the event loop instead.
      socket.on("error", () => {});
      resolve(socket);
    });
  });
}

/** Writes `bytes`, settling once they are flushed or the socket fails. */
export function writeAll(socket: Socket, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(bytes, (err) => (err ? reject(err) : resolve()));
  });
}

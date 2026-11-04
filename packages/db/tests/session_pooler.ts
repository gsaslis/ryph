// A stand-in for PgBouncer in session mode, for the lock-session tests: a client is lent a server
// connection for as long as it stays, and one it leaves is reset with DISCARD ALL and lent to the
// next client, the most recently released first — so the next client gets the same backend, same
// pid and start. Trust auth and no TLS only: the server's greeting is replayed to each new client.

import { createServer, type Server, Socket } from "node:net";

export interface SessionPooler {
  port: number;
  /** Stops passing the server's replies to clients — a slow pooler, or a partition behind it. */
  freeze(): void;
  thaw(): void;
  close(): void;
}

interface Upstream {
  socket: Socket;
  /** The server's answer to the startup packet, through its first ReadyForQuery. */
  greeting: Buffer;
  /** Where the server's replies go now. */
  forward: (chunk: Buffer) => void;
}

const SSL_REQUEST = 80877103;
const READY_FOR_QUERY = 0x5a;

/** Whether `buffer` ends with a whole ReadyForQuery message. */
const endsReady = (buffer: Buffer) =>
  buffer.length >= 6 && buffer[buffer.length - 6] === READY_FOR_QUERY &&
  buffer.readInt32BE(buffer.length - 5) === 5;

export async function sessionPooler(host: string, port: number): Promise<SessionPooler> {
  const idle: Upstream[] = [];
  const sockets = new Set<Socket>();
  let frozen = false;

  const dial = (startup: Buffer) =>
    new Promise<Upstream>((resolve, reject) => {
      const socket = new Socket();
      sockets.add(socket);
      let greeting = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        greeting = Buffer.concat([greeting, chunk]);
        if (!endsReady(greeting)) return;
        socket.off("data", onData);
        resolve({ socket, greeting, forward: () => {} });
      };
      socket.on("data", onData).on("error", reject);
      socket.connect(port, host, () => socket.write(startup));
    });

  // DISCARD ALL, and back to the pool once the server is ready again.
  const release = (upstream: Upstream) => {
    let reply = Buffer.alloc(0);
    upstream.forward = (chunk) => {
      reply = Buffer.concat([reply, chunk]);
      if (reply.includes("DISCARD ALL\0") && endsReady(reply)) {
        upstream.forward = () => {};
        idle.push(upstream);
      }
    };
    const query = Buffer.from("DISCARD ALL\0");
    const header = Buffer.alloc(5);
    header[0] = 0x51; // Query
    header.writeInt32BE(4 + query.length, 1);
    upstream.socket.write(Buffer.concat([header, query]));
  };

  const server: Server = createServer((client) => {
    sockets.add(client);
    let upstream: Upstream | null = null;
    let startup = Buffer.alloc(0);
    client.on("error", () => {});
    client.on("close", () => {
      sockets.delete(client);
      if (upstream !== null && !upstream.socket.destroyed) release(upstream);
    });
    client.on("data", async (chunk: Buffer) => {
      if (upstream !== null) {
        // A Terminate is the client leaving, not the server connection.
        if (
          chunk.length >= 5 && chunk[chunk.length - 5] === 0x58 &&
          chunk.readInt32BE(chunk.length - 4) === 4
        ) {
          chunk = chunk.subarray(0, chunk.length - 5);
        }
        if (chunk.length > 0) upstream.socket.write(chunk);
        return;
      }
      startup = Buffer.concat([startup, chunk]);
      if (startup.length < 8 || startup.length < startup.readInt32BE(0)) return;
      if (startup.readInt32BE(4) === SSL_REQUEST) {
        startup = startup.subarray(8);
        client.write("N");
        return;
      }
      client.pause();
      const lent = idle.pop() ?? await dial(startup);
      upstream = lent;
      lent.forward = (reply) => {
        if (!frozen && client.writable) client.write(reply);
      };
      lent.socket.removeAllListeners("data");
      lent.socket.on("data", (reply: Buffer) => lent.forward(reply));
      lent.socket.on("close", () => client.destroy());
      client.write(lent.greeting);
      client.resume();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("pooler has no port");
  return {
    port: address.port,
    freeze() {
      frozen = true;
    },
    thaw() {
      frozen = false;
    },
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

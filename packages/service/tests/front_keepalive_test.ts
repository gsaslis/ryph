// A paused request whose client leaves with a FIN, over real sockets: a minute long (the client's
// kernel keeps the closed connection that long), so it has a file of its own and runs beside the
// rest. It tests the operating system's keepalive more than this code, so it runs only when asked:
// `RYPH_SLOW_TESTS=1 bun test tests/front_keepalive_test.ts` in packages/service.

import { test } from "bun:test";
import { assert } from "@std/assert";
import { createServer, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { frontHttpServer } from "../src/front.ts";

test.skipIf(!process.env.RYPH_SLOW_TESTS)(
  "front: a paused request whose client closed with a FIN is closed once a keepalive probe is reset",
  async () => {
    let req: IncomingMessage | undefined;
    const server = createServer((r) => {
      req = r;
      r.pause();
    });
    frontHttpServer(server, { tcpKeepAliveMs: 1_000 });
    const accepted: Duplex[] = [];
    server.on("connection", (socket: Duplex) => accepted.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = connect({
      host: "127.0.0.1",
      port: (server.address() as { port: number }).port,
    });
    client.on("error", () => {});
    try {
      // More than the server reads of a paused body, less than its kernel takes: the rest sits
      // unread in its receive buffer, and the client has nothing left to send when it closes.
      client.write(`POST / HTTP/1.1\r\nhost: x\r\ncontent-length: ${2 ** 30}\r\n\r\n`);
      client.write(new Uint8Array(1024 * 1024));
      while (req === undefined || client.writableLength > 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const socket = accepted[0];
      const started = Date.now();
      const closed = new Promise<number>((resolve) =>
        socket.once("close", () => resolve(Date.now() - started))
      );
      client.destroy();
      // A paused socket with bytes unread never sees the FIN: still open a moment later (were it
      // closed, Bun would have fixed that, and the keepalive would matter less).
      const early = await Promise.race([
        closed,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
      ]);
      assert(early === null, `closed after ${early} ms`);
      // Once the client's kernel forgets the connection (FIN_WAIT_2, 60 s), the next probe is reset.
      const took = await closed;
      assert(took < 80_000, `closed after ${took} ms`);
      assert(req.destroyed);
    } finally {
      client.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  100_000,
);

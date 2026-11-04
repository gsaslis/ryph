// A stand-in for PgBouncer's front door, for the lock-session tests: it reads each client's startup
// packet and refuses one carrying a parameter PgBouncer does not accept by default
// (`ignore_startup_parameters` empty), with the error PgBouncer sends; the rest it forwards to
// `upstream`, or, with none, records and hangs up on. Behind a session-mode pooler that is all a
// connection is checked for, so it is all this checks.

import { createServer, type Server, Socket } from "node:net";

/** What PgBouncer takes in a startup packet with no `ignore_startup_parameters`: the two it routes
 * on and the ones it tracks itself. */
export const PGBOUNCER_STARTUP_PARAMETERS = new Set([
  "user",
  "database",
  "client_encoding",
  "datestyle",
  "timezone",
  "standard_conforming_strings",
  "application_name",
]);

export interface StartupGate {
  port: number;
  /** The parameter names of every startup packet seen, in order. */
  seen: string[][];
  close(): void;
}

export async function startupGate(upstream?: { host: string; port: number }): Promise<StartupGate> {
  const seen: string[][] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client)).on("error", () => {});
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4 || buffered.length < buffered.readInt32BE(0)) return;
      client.off("data", onData);
      const length = buffered.readInt32BE(0);
      const fields = buffered.subarray(8, length).toString("utf8").split("\0").filter(Boolean);
      const names = fields.filter((_, i) => i % 2 === 0);
      seen.push(names);
      const refused = names.find((name) => !PGBOUNCER_STARTUP_PARAMETERS.has(name.toLowerCase()));
      if (refused !== undefined || upstream === undefined) {
        client.end(errorResponse(`unsupported startup parameter: ${refused ?? "(none)"}`));
        return;
      }
      const server = new Socket();
      sockets.add(server);
      server.on("close", () => client.destroy()).on("error", () => client.destroy());
      client.on("close", () => server.destroy());
      server.connect(upstream.port, upstream.host, () => {
        server.write(buffered);
        client.pipe(server);
        server.pipe(client);
      });
    };
    client.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("gate has no port");
  return {
    port: address.port,
    seen,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

/** A FATAL ErrorResponse, as PgBouncer sends one before closing. */
function errorResponse(message: string): Buffer {
  const body = Buffer.concat([
    ...[["S", "FATAL"], ["V", "FATAL"], ["C", "08P01"], ["M", message]].map(([k, v]) =>
      Buffer.from(`${k}${v}\0`, "utf8")
    ),
    Buffer.from([0]),
  ]);
  const head = Buffer.alloc(5);
  head.write("E", 0);
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

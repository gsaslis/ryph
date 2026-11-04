// Bind errors that say what happened. Bun's node:http reports every bind failure as EADDRINUSE
// ("Failed to start server. Is port N in use?", errno 0), an address no interface has included,
// so a caller that reads `err.code` would take a docker bridge that is not up yet for a port
// another process holds. Its node:net says what happened (EADDRNOTAVAIL). `serve` corrects its
// own bind errors through `bindError`; `listenNode` does the same for a bare node:http server.

import type { Server } from "node:http";
import { createServer as createNetServer } from "node:net";

/**
 * The real reason a node:http listener could not bind. On Bun's misreported signature (EADDRINUSE
 * with "Failed to start server") the bind is tried once more on node:net and that error is the
 * answer; one that binds there after all leaves the original. Any other error is returned as it
 * is, so under Node, whose node:http reports the real code, this is a no-op.
 */
export async function bindError(err: unknown, hostname: string, port: number): Promise<unknown> {
  const e = err as NodeJS.ErrnoException | null;
  if (e?.code !== "EADDRINUSE" || !/^Failed to start server/.test(e.message ?? "")) return err;
  return await new Promise<unknown>((resolve) => {
    const probe = createNetServer();
    probe.once("error", (real) => resolve(real));
    probe.listen(port, hostname, () => probe.close(() => resolve(err)));
  });
}

/** `server.listen`, resolved once it is listening and rejected with the bind error (`bindError`)
 * instead of leaving it to an unhandled `error` event. */
export function listenNode(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (err: Error) => void bindError(err, host, port).then(reject);
    server.once("error", failed);
    server.listen(port, host, () => {
      server.off("error", failed);
      resolve();
    });
  });
}

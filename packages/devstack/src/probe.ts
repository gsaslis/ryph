/** TCP readiness probing against 127.0.0.1. */

import { connect } from "node:net";

/** Answers whether the port accepts a TCP connection within the timeout. */
export async function probe(port: number, timeoutMs = 1000): Promise<boolean> {
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs));
  const attempt = new Promise<boolean>((resolve) => {
    const conn = connect({ host: "127.0.0.1", port });
    conn.once("connect", () => {
      conn.destroy();
      resolve(true);
    });
    conn.once("error", () => resolve(false));
    // A connection still pending at the timeout must not keep the process alive.
    setTimeout(() => conn.destroy(), timeoutMs).unref();
  });
  return await Promise.race([attempt, timeout]);
}

/** Polls the port until it answers or the deadline passes; reports the wait in seconds. */
export async function waitReady(
  port: number,
  deadlineMs = 10_000,
): Promise<{ ready: boolean; seconds: number }> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (await probe(port, 500)) {
      return { ready: true, seconds: (Date.now() - started) / 1000 };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ready: false, seconds: deadlineMs / 1000 };
}

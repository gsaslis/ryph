// Bind errors carry the real reason, through `serve` and `listenNode` alike: Bun's node:http calls
// every bind failure EADDRINUSE, a missing address included.

import { test } from "bun:test";
import { assertEquals, assertRejects } from "@std/assert";
import { createServer } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { bindError, listenNode, serve } from "../src/mod.ts";

const codeOf = (err: unknown) => (err as NodeJS.ErrnoException)?.code;

// 192.0.2.1 is TEST-NET-1: never one of this machine's addresses.
const MISSING = "192.0.2.1";

test("serve rejects a missing address as EADDRNOTAVAIL, not as a port taken", async () => {
  const err = await assertRejects(() =>
    serve({ hostname: MISSING, port: 0, onListen: () => {} }, () => new Response())
  );
  assertEquals(codeOf(err), "EADDRNOTAVAIL");
});

test("serve rejects a port another listener holds as EADDRINUSE", async () => {
  const taken = await serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    () => new Response(),
  );
  try {
    const err = await assertRejects(() =>
      serve(
        { hostname: "127.0.0.1", port: taken.addr.port, onListen: () => {} },
        () => new Response(),
      )
    );
    assertEquals(codeOf(err), "EADDRINUSE");
  } finally {
    await taken.shutdown();
  }
});

test("listenNode rejects with the bind error instead of throwing it at the process", async () => {
  const taken = createNetServer();
  await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
  const port = (taken.address() as AddressInfo).port;
  const server = createServer();
  try {
    const err = await assertRejects(() => listenNode(server, port, "127.0.0.1"));
    assertEquals(codeOf(err), "EADDRINUSE");
    const missing = await assertRejects(() => listenNode(createServer(), 0, MISSING));
    assertEquals(codeOf(missing), "EADDRNOTAVAIL");
  } finally {
    server.close();
    await new Promise((r) => taken.close(r));
  }
});

test("listenNode resolves once listening", async () => {
  const server = createServer();
  await listenNode(server, 0, "127.0.0.1");
  assertEquals(server.listening, true);
  await new Promise((r) => server.close(r));
});

test("bindError leaves every other error as it is", async () => {
  const other = Object.assign(new Error("listen EACCES: permission denied"), { code: "EACCES" });
  assertEquals(await bindError(other, MISSING, 0), other);
  // A real EADDRINUSE, from node's own wording, is not second-guessed either.
  const inUse = Object.assign(new Error("listen EADDRINUSE: address already in use"), {
    code: "EADDRINUSE",
  });
  assertEquals(await bindError(inUse, MISSING, 0), inUse);
});

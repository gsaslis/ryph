// The run gate (images/run-gate): the one door out of a confined docker run network. Its argv is
// its policy, so the parser is pinned; and the relay is driven over real loopback sockets.

import { test } from "bun:test";
import { assertEquals, assertThrows } from "@std/assert";
import net from "node:net";
import { parseGateArgs, serveGate } from "../../../images/run-gate/main.ts";

test("the gate reads its routes, each to a host and port of its own", () => {
  assertEquals(parseGateArgs(["7411=ryph:7411", "7420=model-proxy:7420", "8000=10.0.0.5:80"]), {
    routes: [
      { listen: 7411, host: "ryph", port: 7411 },
      { listen: 7420, host: "model-proxy", port: 7420 },
      { listen: 8000, host: "10.0.0.5", port: 80 },
    ],
    perSource: 256,
  });
});

test("the short forms relay to --target, each to the same port by default", () => {
  assertEquals(parseGateArgs(["--target", "host.docker.internal", "7411", "7460"]), {
    routes: [
      { listen: 7411, host: "host.docker.internal", port: 7411 },
      { listen: 7460, host: "host.docker.internal", port: 7460 },
    ],
    perSource: 256,
  });
  assertEquals(parseGateArgs(["--target", "h", "--per-source", "8", "7411"]).perSource, 8);
  assertEquals(parseGateArgs(["--target", "h", "8000:7411"]).routes, [{
    listen: 8000,
    host: "h",
    port: 7411,
  }]);
  // `--target` after the route it serves, and beside an explicit route it does not touch.
  assertEquals(parseGateArgs(["7411", "7420=proxy:7420", "--target", "h"]).routes, [
    { listen: 7411, host: "h", port: 7411 },
    { listen: 7420, host: "proxy", port: 7420 },
  ]);
});

test("a gate it cannot read refuses to start rather than guess", () => {
  assertThrows(() => parseGateArgs(["7411"]), Error, "--target");
  assertThrows(() => parseGateArgs(["7411=h:1", "7412"]), Error, "--target");
  assertThrows(() => parseGateArgs(["--target", "h"]), Error, "no routes");
  assertThrows(() => parseGateArgs([]), Error, "no routes");
  assertThrows(() => parseGateArgs(["--target"]), Error, "hostname");
  assertThrows(() => parseGateArgs(["--target", "-x", "1"]), Error, "hostname");
  assertThrows(() => parseGateArgs(["--target", "h", "0"]), Error, "range");
  assertThrows(() => parseGateArgs(["--target", "h", "65536"]), Error, "range");
  assertThrows(() => parseGateArgs(["--target", "h", "http"]), Error, "malformed");
  assertThrows(() => parseGateArgs(["--target", "h", "1:2:3"]), Error, "malformed");
  assertThrows(() => parseGateArgs(["--target", "h", "7411", "7411"]), Error, "twice");
  assertThrows(() => parseGateArgs(["7411=a:1", "--target", "h", "7411"]), Error, "twice");
  assertThrows(() => parseGateArgs(["--target", "h", "--per-source", "0", "1"]), Error, "count");
  assertThrows(() => parseGateArgs(["--target", "h", "--per-source"]), Error, "count");
  // A route's host is held to what --target is: no flag, no empty name, no port riding along.
  for (const bad of ["1=-x:1", "1=:1", "1=h", "1=h:", "1=h:1:2", "1=h/x:1", "=h:1", "1=h:0"]) {
    assertThrows(() => parseGateArgs([bad]), Error, undefined, bad);
  }
});

async function echoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    let got = "";
    socket.on("data", (chunk) => {
      got += chunk.toString();
      if (got.length >= payload.length) {
        socket.end();
        resolve(got);
      }
    });
    socket.on("error", reject);
    socket.write(payload);
  });
}

test("the gate relays bytes both ways to the target port", async () => {
  const upstream = await echoServer();
  const gate = await serveGate(
    { routes: [{ listen: 0, host: "127.0.0.1", port: upstream.port }], perSource: 256 },
    "127.0.0.1",
    () => {},
  );
  try {
    assertEquals(
      await roundTrip(gate.ports[0], "hello through the gate"),
      "hello through the gate",
    );
  } finally {
    await gate.close();
    await upstream.close();
  }
});

test("each route dials its own target", async () => {
  // Two upstreams that answer differently, behind two routes on two hosts: 127.0.0.1, and
  // `localhost` — a name, as a route's host usually is, bound and dialled as the resolver says.
  const tagged = async (tag: string, host: string) => {
    const server = net.createServer((socket) => socket.on("data", () => socket.end(tag)));
    await new Promise<void>((resolve) => server.listen(0, host, () => resolve()));
    return {
      port: (server.address() as net.AddressInfo).port,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  };
  const a = await tagged("a", "127.0.0.1");
  const b = await tagged("b", "localhost");
  const gate = await serveGate(
    {
      routes: [
        { listen: 0, host: "127.0.0.1", port: a.port },
        { listen: 0, host: "localhost", port: b.port },
      ],
      perSource: 256,
    },
    "127.0.0.1",
    () => {},
  );
  try {
    assertEquals(await roundTrip(gate.ports[0], "?"), "a");
    assertEquals(await roundTrip(gate.ports[1], "?"), "b");
  } finally {
    await gate.close();
    await a.close();
    await b.close();
  }
});

test("a target that refuses closes the run's connection rather than holding it", async () => {
  // A port nothing listens on: the gate's dial fails, and the client sees its socket close.
  const dead = await echoServer();
  const port = dead.port;
  await dead.close();
  const gate = await serveGate(
    { routes: [{ listen: 0, host: "127.0.0.1", port }], perSource: 256 },
    "127.0.0.1",
    () => {},
  );
  try {
    const closed = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port: gate.ports[0], host: "127.0.0.1" });
      socket.on("error", () => {});
      socket.on("close", () => resolve(true));
    });
    assertEquals(closed, true);
  } finally {
    await gate.close();
  }
});

/**
 * Whether this machine can be two sources at once: a dual-stack listener reached from 127.0.0.1
 * and from ::1. macOS has no 127.0.0.2, so IPv6 loopback is the second address; a CI container
 * with IPv6 off skips the two-source tests rather than fail them.
 */
const twoSources = await (async () => {
  try {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "::", () => resolve());
    });
    const port = (server.address() as net.AddressInfo).port;
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: "::1" });
      socket.once("connect", () => resolve(true));
      socket.once("error", () => resolve(false));
    });
    await new Promise<void>((r) => server.close(() => r()));
    return ok;
  } catch {
    return false;
  }
})();

/** A socket to the gate, resolved once it is connected; `closed` settles when it closes. */
async function dial(
  port: number,
  host: string,
): Promise<{ socket: net.Socket; closed: Promise<void> }> {
  const socket = net.connect({ port, host });
  socket.on("error", () => {});
  const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  return { socket, closed };
}

/** Resolves true if the socket closes within `ms`, false if it is still open. */
function closesWithin(closed: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolve) => timer = setTimeout(() => resolve(false), ms)),
  ]).finally(() => clearTimeout(timer));
}

test.skipIf(!twoSources)(
  "one source past its cap is refused, and another source is not",
  async () => {
    // A held-open upstream: every relay stays up until the test ends it.
    const held: net.Socket[] = [];
    const upstream = net.createServer((socket) => held.push(socket));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    // Dual-stack, so 127.0.0.1 and ::1 are two different sources to the gate.
    const gate = await serveGate(
      { routes: [{ listen: 0, host: "127.0.0.1", port: upstreamPort }], perSource: 2 },
      "::",
      () => {},
    );
    const sockets: net.Socket[] = [];
    try {
      const a1 = await dial(gate.ports[0], "127.0.0.1");
      const a2 = await dial(gate.ports[0], "127.0.0.1");
      const a3 = await dial(gate.ports[0], "127.0.0.1");
      sockets.push(a1.socket, a2.socket, a3.socket);
      assertEquals(await closesWithin(a3.closed, 2_000), true, "the third from one source is cut");
      assertEquals(await closesWithin(a1.closed, 200), false, "its first two stay up");

      const b1 = await dial(gate.ports[0], "::1");
      sockets.push(b1.socket);
      assertEquals(await closesWithin(b1.closed, 500), false, "another source still gets through");
      b1.socket.write("ping");

      // And a slot freed is a slot back.
      a1.socket.destroy();
      await a1.closed;
      await new Promise((r) => setTimeout(r, 100));
      const a4 = await dial(gate.ports[0], "127.0.0.1");
      sockets.push(a4.socket);
      assertEquals(await closesWithin(a4.closed, 500), false);
    } finally {
      for (const socket of [...sockets, ...held]) socket.destroy();
      await gate.close();
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  },
);

test.skipIf(!twoSources)("the gate-wide cap holds across sources", async () => {
  const held: net.Socket[] = [];
  const upstream = net.createServer((socket) => held.push(socket));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const gate = await serveGate(
    { routes: [{ listen: 0, host: "127.0.0.1", port: upstreamPort }], perSource: 10 },
    "::",
    () => {},
    { maxConnections: 1 },
  );
  const sockets: net.Socket[] = [];
  try {
    const a = await dial(gate.ports[0], "127.0.0.1");
    const b = await dial(gate.ports[0], "::1");
    sockets.push(a.socket, b.socket);
    assertEquals(await closesWithin(b.closed, 2_000), true);
    assertEquals(await closesWithin(a.closed, 200), false);
  } finally {
    for (const socket of [...sockets, ...held]) socket.destroy();
    await gate.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("a relay quiet both ways past the idle timeout is closed, and traffic keeps one open", async () => {
  const upstream = await echoServer();
  const gate = await serveGate(
    { routes: [{ listen: 0, host: "127.0.0.1", port: upstream.port }], perSource: 256 },
    "127.0.0.1",
    () => {},
    { idleMs: 1_000 },
  );
  try {
    const busy = await dial(gate.ports[0], "127.0.0.1");
    const quiet = await dial(gate.ports[0], "127.0.0.1");
    // Busy: a byte every 50 ms for 2.1 s, more than twice the timeout. The gate's timers share
    // this event loop, so a stall on a loaded check machine stretches a gap between writes:
    // the timeout is 20 gaps long so that only a stall near a second reads as silence.
    for (let i = 0; i < 42; i++) {
      busy.socket.write("x");
      await new Promise((r) => setTimeout(r, 50));
    }
    assertEquals(await closesWithin(quiet.closed, 1_000), true, "the quiet relay was closed");
    assertEquals(await closesWithin(busy.closed, 50), false, "the busy one is still up");
    busy.socket.destroy();
    await busy.closed;
  } finally {
    await gate.close();
    await upstream.close();
  }
});

test("a client that half-closes after its request still gets the whole answer", async () => {
  // An upstream that answers only once the request has ENDED, as an HTTP/1.0-style or
  // `nc -N`-style client expects — and keeps talking after that end arrives.
  const upstream = net.createServer({ allowHalfOpen: true }, (socket) => {
    let request = "";
    socket.on("data", (chunk) => request += chunk.toString());
    socket.on("end", () => {
      socket.write(`got ${request};`);
      setTimeout(() => socket.end(" and later"), 100);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const gate = await serveGate(
    { routes: [{ listen: 0, host: "127.0.0.1", port: upstreamPort }], perSource: 256 },
    "127.0.0.1",
    () => {},
  );
  try {
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = net.connect({ port: gate.ports[0], host: "127.0.0.1", allowHalfOpen: true });
      let got = "";
      socket.on("data", (chunk) => got += chunk.toString());
      socket.on("end", () => {
        socket.end();
        resolve(got);
      });
      socket.on("error", reject);
      socket.on("connect", () => socket.end("hello"));
    });
    assertEquals(answer, "got hello; and later");
  } finally {
    await gate.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

// The runner end of previews against a fake control plane and tunnel endpoint: the tunnel URL
// the registration answers with is the one dialled, a dropped tunnel is re-registered and
// carries traffic again, and reconnecting stops for good on a 410 or once nothing listens.

import { test } from "bun:test";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { type HttpServer, serve } from "@ryph/service";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { type HostMux, hostMux, TUNNEL_PROTOCOL } from "@ryph/tunnel";
import { runnerPreviews } from "../src/adapters/orchestrator/previews.ts";

/** `audience` is sent as given; absent sends the hosted control plane's `run`, and `null` none. */
type Answer = { status: number; tunnel?: string; audience?: string | null };

interface Tunnel {
  ticket: string;
  ws: WebSocket;
  mux: HostMux;
  closed: Promise<void>;
}

/** A control plane that answers registrations from `answers` (then 201s), and a tunnel
 * endpoint on a path no runner would derive. */
async function fakeControlPlane(answers: Answer[] = []) {
  const registrations: { port: number; label: string }[] = [];
  const tunnels: Tunnel[] = [];
  const server: HttpServer = await serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen() {},
  }, async (req, info) => {
    const url = new URL(req.url);
    // The ticket in the path is the tunnel's only credential.
    if (
      !url.pathname.startsWith("/elsewhere/") &&
      req.headers.get("authorization") !== "Bearer run-secret"
    ) {
      return new Response("no", { status: 401 });
    }
    if (url.pathname === "/v1/runs/r-1/runner/previews" && req.method === "GET") {
      return Response.json({ enabled: true });
    }
    if (url.pathname === "/v1/runs/r-1/runner/previews" && req.method === "POST") {
      const body = await req.json();
      registrations.push(body);
      const answer = answers.shift() ?? { status: 201 };
      if (answer.status !== 201) return new Response("gone", { status: answer.status });
      const ticket = `t${registrations.length}`;
      return Response.json({
        id: "p1",
        port: body.port,
        label: body.label,
        url: "https://0123456789abcdef0123456789abcdef.preview.cell.example",
        tunnel: answer.tunnel ?? `ws://127.0.0.1:${server.addr.port}/elsewhere/tunnel/${ticket}`,
        ...(answer.audience === null ? {} : { audience: answer.audience ?? "run" }),
      }, { status: 201 });
    }
    const tunnel = url.pathname.match(/^\/elsewhere\/tunnel\/(t\d+)$/);
    if (tunnel) {
      // The runner names the framing it speaks, as every host requires.
      if (req.headers.get("sec-websocket-protocol") !== TUNNEL_PROTOCOL) {
        return new Response("wrong framing", { status: 400 });
      }
      const { socket, response } = info.upgradeWebSocket(req, { protocol: TUNNEL_PROTOCOL });
      socket.binaryType = "arraybuffer";
      const mux = hostMux(socket);
      const closed = new Promise<void>((resolve) =>
        socket.addEventListener("close", () => resolve())
      );
      socket.onmessage = ({ data }: MessageEvent) => {
        if (mux.receive(data) === "invalid") socket.close();
      };
      socket.onclose = () => mux.close();
      socket.onopen = () => tunnels.push({ ticket: tunnel[1], ws: socket, mux, closed });
      return response;
    }
    return new Response("not found", { status: 404 });
  });
  return {
    baseUrl: `http://127.0.0.1:${server.addr.port}`,
    registrations,
    tunnels,
    async shutdown() {
      await Promise.all(tunnels.map((t) => t.closed));
      await server.shutdown();
    },
  };
}

/** A TCP echo server standing in for the dev server. */
async function echoServer() {
  const conns = new Set<Socket>();
  const server = createServer((conn) => {
    conns.add(conn);
    conn.on("error", () => {});
    conn.on("close", () => conns.delete(conn));
    conn.pipe(conn);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let open = true;
  return {
    port: (server.address() as AddressInfo).port,
    async close() {
      if (!open) return;
      open = false;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const conn of conns) conn.destroy();
      await closed;
    },
  };
}

/** Sends `text` down a fresh stream of `tunnel` and resolves with what comes back. */
async function roundTrip(tunnel: Tunnel, text: string): Promise<string> {
  const stream = await tunnel.mux.stream();
  return await new Promise((resolve, reject) => {
    let got = "";
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new Error(`no echo, got "${got}"`));
    }, 5000);
    stream.on("data", (chunk: Uint8Array) => {
      got += new TextDecoder().decode(chunk);
      if (got === text) {
        clearTimeout(timer);
        stream.destroy();
        resolve(got);
      }
    });
    stream.write(new TextEncoder().encode(text));
  });
}

async function until(what: string, check: () => boolean, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("previews: dials the answered tunnel and re-registers when it drops", async () => {
  const plane = await fakeControlPlane();
  const echo = await echoServer();
  const runner = await runnerPreviews({
    baseUrl: plane.baseUrl,
    runId: "r-1",
    runToken: "run-secret",
    reserved: () => [],
  });
  try {
    assert(runner);
    const url = await runner.expose(echo.port, "App");
    assertEquals(url, {
      url: "https://0123456789abcdef0123456789abcdef.preview.cell.example",
      audience: "run",
    });
    await until("first tunnel", () => plane.tunnels.length === 1);
    assertEquals(plane.tunnels[0].ticket, "t1");
    assertEquals(await roundTrip(plane.tunnels[0], "one"), "one");
    assertEquals(await runner.expose(echo.port, "App"), url);
    assertEquals(plane.registrations.length, 1);

    // The control plane drops the socket: the runner registers again on its own and redials.
    plane.tunnels[0].ws.close();
    await until("second tunnel", () => plane.tunnels.length === 2);
    assertEquals(plane.registrations, [
      { port: echo.port, label: "App" },
      { port: echo.port, label: "App" },
    ]);
    assertEquals(plane.tunnels[1].ticket, "t2");
    assertEquals(await roundTrip(plane.tunnels[1], "two"), "two");

    // Exposing while the tunnel is down tries at once, and two calls share one registration.
    plane.tunnels[1].ws.close();
    await plane.tunnels[1].closed;
    const [a, b] = await Promise.all([
      runner.expose(echo.port, "App"),
      runner.expose(echo.port, "App"),
    ]);
    assertEquals([a, b], [url, url]);
    assertEquals(plane.registrations.length, 3);
    await until("third tunnel", () => plane.tunnels.length === 3);
    assertEquals(await roundTrip(plane.tunnels[2], "three"), "three");
    // No background retry is left over to register a fourth time.
    await pause(1300);
    assertEquals(plane.registrations.length, 3);
  } finally {
    runner?.close();
    await echo.close();
    await plane.shutdown();
  }
});

test("previews: a 410 from registration stops reconnecting", async () => {
  const plane = await fakeControlPlane([{ status: 201 }, { status: 410 }]);
  const echo = await echoServer();
  const runner = await runnerPreviews({
    baseUrl: plane.baseUrl,
    runId: "r-1",
    runToken: "run-secret",
    reserved: () => [],
  });
  try {
    assert(runner);
    await runner.expose(echo.port, "App");
    await until("first tunnel", () => plane.tunnels.length === 1);
    plane.tunnels[0].ws.close();
    await until("second registration", () => plane.registrations.length === 2);
    await pause(2500);
    assertEquals(plane.registrations.length, 2);
    assertEquals(plane.tunnels.length, 1);
  } finally {
    runner?.close();
    await echo.close();
    await plane.shutdown();
  }
});

test("previews: reconnecting stops once nothing listens on the port", async () => {
  const plane = await fakeControlPlane();
  const echo = await echoServer();
  const runner = await runnerPreviews({
    baseUrl: plane.baseUrl,
    runId: "r-1",
    runToken: "run-secret",
    reserved: () => [],
  });
  try {
    assert(runner);
    await runner.expose(echo.port, "App");
    await until("first tunnel", () => plane.tunnels.length === 1);
    await echo.close();
    plane.tunnels[0].ws.close();
    await pause(2500);
    assertEquals(plane.registrations.length, 1);
    assertEquals(plane.tunnels.length, 1);
  } finally {
    runner?.close();
    await echo.close();
    await plane.shutdown();
  }
});

test("previews: a tunnel URL that is not ws: or wss: is refused", async () => {
  const plane = await fakeControlPlane([{ status: 201, tunnel: "https://127.0.0.1/tunnel/t1" }]);
  const echo = await echoServer();
  const runner = await runnerPreviews({
    baseUrl: plane.baseUrl,
    runId: "r-1",
    runToken: "run-secret",
    reserved: () => [],
  });
  try {
    assert(runner);
    await assertRejects(() => runner.expose(echo.port, "App"), Error, "not ws: or wss:");
    assertEquals(plane.tunnels.length, 0);
  } finally {
    runner?.close();
    await echo.close();
    await plane.shutdown();
  }
});

test("previews: who can open it is the registration's to say, and `run` unless it says machine", async () => {
  for (
    const [audience, expected] of [
      ["machine", "machine"],
      ["run", "run"],
      ["everyone", "run"],
      [null, "run"],
    ] as const
  ) {
    const plane = await fakeControlPlane([{ status: 201, audience }]);
    const echo = await echoServer();
    const runner = await runnerPreviews({
      baseUrl: plane.baseUrl,
      runId: "r-1",
      runToken: "run-secret",
      reserved: () => [],
    });
    try {
      assert(runner);
      assertEquals((await runner.expose(echo.port, "App")).audience, expected, String(audience));
      // Asked again while its tunnel is up, the answer is the same.
      await until("tunnel", () => plane.tunnels.length === 1);
      assertEquals((await runner.expose(echo.port, "App")).audience, expected, String(audience));
    } finally {
      runner?.close();
      await echo.close();
      await plane.shutdown();
    }
  }
});

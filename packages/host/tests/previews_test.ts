import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { request } from "node:http";
import { type AddressInfo, connect, createServer as createNetServer } from "node:net";
import { type HttpServer, serve } from "@ryph/service";
import { DRAIN_LIMIT, TUNNEL_PROTOCOL } from "@ryph/tunnel";
import { acceptingUpgrades, localPreviews } from "../src/previews.ts";
import { runnerPreviews } from "../../runner/src/adapters/orchestrator/previews.ts";

test("local preview registration is bounded even across concurrent requests", async () => {
  const previews = localPreviews({
    authenticateRunner: () => Promise.resolve(true),
    authenticateReader: () => Promise.resolve(null),
    active: () => Promise.resolve(true),
  });
  try {
    const register = previews.routes.find((route) => route.method === "POST")!;
    const responses = await Promise.all(Array.from({ length: 6 }, () =>
      register.handler(
        new Request("http://127.0.0.1/v1/runs/r-1/runner/previews", {
          method: "POST",
          body: JSON.stringify({ port: 5173, label: "App" }),
        }),
        { runId: "r-1" },
      )));
    assertEquals(responses.filter((r) => r.status === 201).length, 4);
    assertEquals(responses.filter((r) => r.status === 429).length, 2);
    for (const response of responses) await response.body?.cancel();
  } finally {
    previews.close();
  }
});

test("local previews: HTTP bodies, WebSockets, host gate, tickets and cleanup", async () => {
  let active = true;
  let releaseStream: (() => void) | undefined;
  const previews = localPreviews({
    authenticateRunner: (req) =>
      Promise.resolve(req.headers.get("authorization") === "Bearer run-secret"),
    authenticateReader: (req) =>
      Promise.resolve(
        req.headers.get("authorization") === "Bearer user"
          ? null
          : new Response(null, { status: 403 }),
      ),
    active: () => Promise.resolve(active),
  });
  const upstream = await serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req, info) => {
      if (req.headers.get("upgrade") === "websocket") {
        const { response, socket } = info.upgradeWebSocket(req);
        socket.onmessage = ({ data }) => socket.send(data);
        return response;
      }
      if (new URL(req.url).pathname === "/large") {
        return new Response(new Uint8Array(3 * 1024 * 1024).fill(42));
      }
      if (new URL(req.url).pathname === "/stream") {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first"));
              releaseStream = () => {
                controller.enqueue(new TextEncoder().encode("second"));
                controller.close();
              };
            },
          }),
        );
      }
      return new Response(`${req.method} ${new URL(req.url).pathname} ${await req.text()}`, {
        headers: { "x-preview": "yes" },
      });
    },
  );
  const host = await serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    acceptingUpgrades(async (req) => {
      for (const route of previews.routes) {
        const match = route.pattern.exec(req.url);
        if (route.method === req.method && match) {
          return await route.handler(req, match.pathname.groups as Record<string, string>);
        }
      }
      return new Response(null, { status: 404 });
    }),
  );
  const baseUrl = `http://127.0.0.1:${host.addr.port}`;
  const runner = await runnerPreviews({
    baseUrl,
    runId: "r-1",
    runToken: "run-secret",
    reserved: () => [],
  });
  try {
    assert(runner);
    assertEquals(
      await runnerPreviews({ baseUrl, runId: "r-1", runToken: "wrong", reserved: () => [] }),
      undefined,
    );
    const exposed = await runner.expose(upstream.addr.port, "App");
    // A loopback listener: only whoever is at this machine can open it.
    assertEquals(exposed.audience, "machine");
    const url = new URL(exposed.url);
    assertEquals(await runner.expose(upstream.addr.port, "App"), exposed);
    const local = `http://127.0.0.1:${url.port}`;
    await new Promise<void>((resolve, reject) => {
      const req = request(`${local}/hello`, {
        method: "POST",
        headers: { host: url.host },
      }, (response) => {
        if (response.statusCode !== 200 || response.headers["x-preview"] !== "yes") {
          response.destroy();
          reject(new Error(`Unexpected preview response: ${response.statusCode}`));
          return;
        }
        response.on("error", reject);
        let body = "";
        response.on("data", (chunk) => body += chunk);
        response.on("end", () => {
          try {
            assertEquals(body, "POST /hello world");
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on("error", reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error("HTTP timed out"));
      });
      req.end("world");
    });
    await new Promise<void>((resolve, reject) => {
      const req = request(`${local}/stream`, { headers: { host: url.host } }, (res) => {
        let body = "";
        res.on("error", reject);
        res.on("data", (chunk) => {
          body += chunk;
          if (body === "first") releaseStream?.();
        });
        res.on("end", () => {
          try {
            assertEquals(body, "firstsecond");
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on("error", reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error("stream was buffered"));
      });
      req.end();
    });
    await new Promise<void>((resolve, reject) => {
      const req = request(`${local}/large`, { headers: { host: url.host } }, (res) => {
        let bytes = 0;
        res.on("error", reject);
        res.on("data", (chunk) => {
          bytes += chunk.length;
        });
        res.on("end", () => {
          try {
            assertEquals(bytes, 3 * 1024 * 1024);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on("error", reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error("download timed out"));
      });
      req.end();
    });
    await new Promise<void>((resolve, reject) => {
      const req = request(
        local,
        { headers: { host: url.host, origin: "https://foreign.example" } },
        (res) => {
          res.resume();
          res.on("end", () => {
            try {
              assertEquals(res.statusCode, 403);
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
    // The gate the hosted service shares: only a top-level navigation may come from elsewhere.
    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = request(local, { headers: { host: url.host, ...headers } }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        });
        req.on("error", reject);
        req.end();
      });
    assertEquals(
      await status({
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      }),
      200,
    );
    for (
      const headers of [
        {
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "iframe",
        },
        { "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" },
      ] as Record<string, string>[]
    ) {
      assertEquals(await status(headers), 403, JSON.stringify(headers));
    }
    const forbidden = await fetch(local);
    assertEquals(forbidden.status, 403);
    await forbidden.body?.cancel();
    const denied = await fetch(`${baseUrl}/v1/runs/r-1/previews`);
    assertEquals(denied.status, 403);
    await denied.body?.cancel();
    const list = await fetch(`${baseUrl}/v1/runs/r-1/previews`, {
      headers: { authorization: "Bearer user" },
    });
    const body = await list.json();
    assertEquals(body.previews.length, 1);
    assertEquals(body.previews[0].label, "App");
    assertEquals(body.previews[0].ticket, undefined);

    // Upgrade with a Host override, without depending on wildcard-localhost DNS. A masked
    // client text frame containing 'hmr' must come back as an unmasked server text frame.
    await new Promise<void>((resolve, reject) => {
      const req = request(local, {
        headers: {
          host: url.host,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
      req.on("error", reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error("upgrade timed out"));
      });
      req.on("upgrade", (_response, socket) => {
        socket.on("error", reject);
        socket.once("data", (chunk) => {
          socket.destroy();
          try {
            assertEquals([...chunk], [129, 3, 104, 109, 114]);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
        socket.write(new Uint8Array([129, 131, 0, 0, 0, 0, 104, 109, 114]));
      });
      req.end();
    });
    for (const port of [0, 80, 65536, 1.5, "5173"]) {
      const invalid = await fetch(`${baseUrl}/v1/runs/r-1/runner/previews`, {
        method: "POST",
        headers: { authorization: "Bearer run-secret" },
        body: JSON.stringify({ port, label: "Invalid" }),
      });
      assertEquals(invalid.status, 400);
      await invalid.body?.cancel();
    }
    const forged = await fetch(`${baseUrl}/v1/local-previews/tunnel/${"a".repeat(32)}`);
    assertEquals(forged.status, 404);
    await forged.body?.cancel();
    const registration = await fetch(`${baseUrl}/v1/runs/r-1/runner/previews`, {
      method: "POST",
      headers: { authorization: "Bearer run-secret" },
      body: JSON.stringify({ port: upstream.addr.port, label: "Ticket test" }),
    });
    const registered = await registration.json();
    // Without the framing's subprotocol the dial is refused, and the ticket is not spent.
    const unframed = new WebSocket(
      `${baseUrl.replace("http:", "ws:")}/v1/local-previews/tunnel/${registered.ticket}`,
    );
    await new Promise<void>((resolve) => {
      unframed.onopen = () => resolve();
      unframed.onerror = () => resolve();
    });
    assertEquals(unframed.readyState, WebSocket.CLOSED);
    const tunnel = new WebSocket(
      `${baseUrl.replace("http:", "ws:")}/v1/local-previews/tunnel/${registered.ticket}`,
      TUNNEL_PROTOCOL,
    );
    await new Promise<void>((resolve, reject) => {
      tunnel.onopen = () => resolve();
      tunnel.onerror = reject;
    });
    const reused = await fetch(`${baseUrl}/v1/local-previews/tunnel/${registered.ticket}`);
    assertEquals(reused.status, 404);
    await reused.body?.cancel();
    tunnel.close();
    active = false;
    const ended = await fetch(`${baseUrl}/v1/runs/r-1/previews`, {
      headers: { authorization: "Bearer user" },
    });
    assertEquals((await ended.json()).previews, []);
    const terminal = await fetch(`${baseUrl}/v1/runs/r-1/runner/previews`, {
      headers: { authorization: "Bearer run-secret" },
    });
    assertEquals(terminal.status, 410);
    await terminal.body?.cancel();
  } finally {
    runner?.close();
    previews.close();
    await host.shutdown();
    await upstream.shutdown();
  }
});

test("local previews: a page load of many keep-alive requests never runs out of streams", async () => {
  const previews = localPreviews({
    authenticateRunner: () => Promise.resolve(true),
    authenticateReader: () => Promise.resolve(null),
    active: () => Promise.resolve(true),
  });
  // A Node dev server (Vite's kind) holds an idle keep-alive connection open for five seconds.
  const { createServer, Agent } = await import("node:http");
  const upstream = createServer((_req, res) => res.end("module"));
  upstream.keepAliveTimeout = 5000;
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const host = await serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    acceptingUpgrades(async (req) => {
      for (const route of previews.routes) {
        const match = route.pattern.exec(req.url);
        if (route.method === req.method && match) {
          return await route.handler(req, match.pathname.groups as Record<string, string>);
        }
      }
      return new Response(null, { status: 404 });
    }),
  );
  const runner = await runnerPreviews({
    baseUrl: `http://127.0.0.1:${host.addr.port}`,
    runId: "r-1",
    runToken: "run-secret",
    reserved: () => [host.addr.port],
  });
  // A browser's six keep-alive connections per host.
  const agent = new Agent({ keepAlive: true, maxSockets: 6 });
  try {
    assert(runner);
    const reserved = await runner.expose(host.addr.port, "Control plane").catch((e) => e);
    assert(reserved instanceof Error && /ryph's own services/.test(reserved.message));
    const [first, second] = await Promise.all([
      runner.expose(upstreamPort, "App"),
      runner.expose(upstreamPort, "App"),
    ]);
    assertEquals(first, second);
    const url = new URL(first.url);
    const statuses = await Promise.all(
      Array.from({ length: 120 }, (_, i) =>
        new Promise<number>((resolve, reject) => {
          const req = request(`http://127.0.0.1:${url.port}/m${i}.js`, {
            agent,
            headers: { host: url.host },
          }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          });
          req.on("error", reject);
          req.setTimeout(10_000, () => {
            req.destroy();
            reject(new Error("module request timed out"));
          });
          req.end();
        })),
    );
    assertEquals(statuses.filter((status) => status !== 200), []);
  } finally {
    agent.destroy();
    runner?.close();
    previews.close();
    await host.shutdown();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("local previews: IPv6-only servers, chunked DELETE bodies, refused upgrades", async () => {
  const previews = localPreviews({
    authenticateRunner: () => Promise.resolve(true),
    authenticateReader: () => Promise.resolve(null),
    active: () => Promise.resolve(true),
  });
  // A dev server bound to `localhost` that resolved to ::1 alone. Where the machine has no
  // IPv6 loopback, the rest of the test still runs on 127.0.0.1.
  const app = async (req: Request) => {
    if (req.headers.get("upgrade") === "websocket") return new Response(null, { status: 403 });
    return new Response(`${req.method} ${(await req.arrayBuffer()).byteLength}`);
  };
  let upstream: HttpServer;
  try {
    upstream = await serve({ hostname: "::1", port: 0, onListen() {} }, app);
  } catch (e) {
    if (!["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes((e as NodeJS.ErrnoException)?.code ?? "")) {
      throw e;
    }
    console.warn("no IPv6 loopback here; the IPv6 part of this test is skipped");
    upstream = await serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, app);
  }
  const host = await serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    acceptingUpgrades(async (req) => {
      for (const route of previews.routes) {
        const match = route.pattern.exec(req.url);
        if (route.method === req.method && match) {
          return await route.handler(req, match.pathname.groups as Record<string, string>);
        }
      }
      return new Response(null, { status: 404 });
    }),
  );
  const runner = await runnerPreviews({
    baseUrl: `http://127.0.0.1:${host.addr.port}`,
    runId: "r-1",
    runToken: "run-secret",
    reserved: () => [],
  });
  try {
    assert(runner);
    const nothing = await runner.expose(1, "Nothing").catch((e) => e);
    assert(nothing instanceof Error);
    const idle = createNetServer();
    await new Promise<void>((r) => idle.listen(0, "127.0.0.1", r));
    const freePort = (idle.address() as AddressInfo).port;
    await new Promise((r) => idle.close(r));
    const silent = await runner.expose(freePort, "Nothing").catch((e) => e);
    assert(silent instanceof Error && /Nothing is listening/.test(silent.message));

    const url = new URL((await runner.expose(upstream.addr.port, "App")).url);
    const local = `http://127.0.0.1:${url.port}`;
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(`${local}/item`, {
        method: "DELETE",
        headers: { host: url.host, "transfer-encoding": "chunked" },
      }, (res) => {
        let text = "";
        res.on("data", (chunk) => text += chunk);
        res.on("end", () => resolve(text));
      });
      req.on("error", reject);
      req.write(new Uint8Array(100_000));
      req.end(new Uint8Array(100_000));
    });
    assertEquals(body, "DELETE 200000");

    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(local, {
        headers: {
          host: url.host,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("upgrade", () => reject(new Error("upgraded")));
      req.on("error", reject);
      req.end();
    });
    assertEquals(status, 403);
  } finally {
    runner?.close();
    previews.close();
    await host.shutdown();
    await upstream.shutdown();
  }
});

test("local previews: a hostile dev server, early answers and a lost tunnel", async () => {
  const { createServer: createTcpServer } = await import("node:net");
  const { Agent } = await import("node:http");
  // A dev server speaking raw HTTP, so it can say what node:http would never send.
  const devSockets = new Set<import("node:net").Socket>();
  const dev = createTcpServer({ allowHalfOpen: true }, (socket) => {
    devSockets.add(socket);
    socket.on("close", () => devSockets.delete(socket));
    socket.on("error", () => {});
    let head = "";
    const onData = (chunk: Uint8Array) => {
      head += new TextDecoder().decode(chunk);
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      const path = head.split(" ")[1];
      if (path === "/bad-status") socket.end("HTTP/1.1 099 X\r\ncontent-length: 0\r\n\r\n");
      else if (path === "/switch") {
        // Keeps the connection, as a dev server that switched protocols would.
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\n\r\nxx",
        );
      } else if (path === "/early") {
        // Refuses the upload without reading it, and keeps the connection.
        socket.write("HTTP/1.1 413 Too Big\r\ncontent-length: 7\r\n\r\ntoo big");
      } else if (path === "/hmr") {
        // Upgrades, then ignores everything, a FIN included.
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
        );
      } else if (path === "/hang") {
        // Never answers.
      } else socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
    };
    socket.on("data", onData);
  });
  await new Promise<void>((resolve) => dev.listen(0, "127.0.0.1", resolve));
  const devPort = (dev.address() as { port: number }).port;
  const previews = localPreviews({
    authenticateRunner: () => Promise.resolve(true),
    authenticateReader: () => Promise.resolve(null),
    active: () => Promise.resolve(true),
  });
  const host = await serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    acceptingUpgrades(async (req) => {
      for (const route of previews.routes) {
        const match = route.pattern.exec(req.url);
        if (route.method === req.method && match) {
          return await route.handler(req, match.pathname.groups as Record<string, string>);
        }
      }
      return new Response(null, { status: 404 });
    }),
  );
  const baseUrl = `http://127.0.0.1:${host.addr.port}`;
  const runner = await runnerPreviews({
    baseUrl,
    runId: "r-1",
    runToken: "run-secret",
    reserved: () => [],
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    assert(runner);
    const url = new URL((await runner.expose(devPort, "App")).url);
    const local = `http://127.0.0.1:${url.port}`;
    const send = (path: string, method = "GET", body?: Uint8Array) =>
      new Promise<{ status: number; ms: number }>((resolve, reject) => {
        const started = performance.now();
        const req = request(
          `${local}${path}`,
          { method, agent, headers: { host: url.host } },
          (res) => {
            res.resume();
            res.on(
              "end",
              () => resolve({ status: res.statusCode!, ms: performance.now() - started }),
            );
          },
        );
        req.on("error", reject);
        req.setTimeout(5000, () => req.destroy(new Error(`${path} timed out`)));
        req.end(body);
      });

    // A status node:http parses but will not send is a 502, and the host lives on.
    assertEquals((await send("/bad-status")).status, 502);
    // So is a switch of protocols nobody asked for, instead of a browser left waiting.
    assertEquals((await send("/switch")).status, 502);
    assertEquals((await send("/ok")).status, 200);

    // An upload answered before it was read does not hold the browser's connection: what is left
    // of it is drained, and the connection serves the next request.
    assertEquals((await send("/early", "POST", new Uint8Array(DRAIN_LIMIT / 2))).status, 413);
    const next = await send("/ok");
    assertEquals(next.status, 200);
    assert(next.ms < 2000, `the next request waited ${next.ms} ms`);
    // One larger than the drain is still answered, and its connection cut past DRAIN_LIMIT
    // rather than read to its end (Bun 1.4.2 dropped the rest of a body answered early whatever
    // its size, so its connection was kept; 1.4.4 leaves it to the drain).
    const cut = new Promise<{ status: number; reset: boolean }>((resolve, reject) => {
      const req = request(
        `${local}/early`,
        // Its own keep-alive agent: kept, the connection would stay open for a next request.
        { method: "POST", agent: new Agent({ keepAlive: true }), headers: { host: url.host } },
        (res) => {
          res.resume();
          const status = res.statusCode!;
          // Cut by the drain, the socket is reset; kept, it would be read to its end and then
          // closed cleanly by the keep-alive timeout. A deadline alone cannot tell the two apart
          // under gVisor, whose loopback can take seconds over 8 MiB.
          res.socket.once("close", (hadError: boolean) => resolve({ status, reset: hadError }));
        },
      );
      req.on("error", () => {});
      setTimeout(() => reject(new Error("the large early upload never closed")), 20_000);
      req.end(new Uint8Array(8 * DRAIN_LIMIT));
    });
    assertEquals(await cut, { status: 413, reset: true });

    // A browser that closes its HMR socket frees its stream, even from a dev server that
    // ignores FINs: more than the cap of them, opened and closed, leave the preview serving.
    for (let i = 0; i < 34; i++) {
      // Released after a short grace; pace the browser so the cap is never what refuses it.
      if (i === 20) await new Promise((resolve) => setTimeout(resolve, 500));
      await new Promise<void>((resolve, reject) => {
        const req = request(local + "/hmr", {
          headers: {
            host: url.host,
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          },
        });
        req.on("upgrade", (_res, socket) => {
          socket.on("error", () => {});
          socket.end();
          resolve();
        });
        req.on("error", reject);
        req.end();
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    assertEquals((await send("/ok")).status, 200);

    // Losing the runner's socket fails the request in flight and closes the preview.
    const hanging = send("/hang").then(
      ({ status }) => status,
      () => "reset",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    runner.close();
    const outcome = await within(hanging, 3000, "the request in flight");
    assert(outcome === "reset" || outcome === 502, `in-flight request ended as ${outcome}`);
    const listed = await fetch(`${baseUrl}/v1/runs/r-1/previews`);
    assertEquals((await listed.json()).previews, []);
    const refused = await fetch(`${local}/ok`, { headers: { host: url.host } }).then(
      () => "answered",
      () => "refused",
    );
    assertEquals(refused, "refused");
  } finally {
    agent.destroy();
    runner?.close();
    previews.close();
    await host.shutdown();
    for (const socket of devSockets) socket.destroy();
    await new Promise((resolve) => dev.close(resolve));
  }
});

test("local previews: the registration names its tunnel, and open answers the preview's URL", async () => {
  let active = true;
  const previews = localPreviews({
    authenticateRunner: () => Promise.resolve(true),
    authenticateReader: (req) =>
      Promise.resolve(
        req.headers.get("authorization") === "Bearer user"
          ? null
          : new Response(null, { status: 403 }),
      ),
    active: () => Promise.resolve(active),
  });
  const host = await serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    acceptingUpgrades(async (req) => {
      for (const route of previews.routes) {
        const match = route.pattern.exec(req.url);
        if (route.method === req.method && match) {
          return await route.handler(req, match.pathname.groups as Record<string, string>);
        }
      }
      return new Response(null, { status: 404 });
    }),
  );
  const baseUrl = `http://127.0.0.1:${host.addr.port}`;
  let tunnel: WebSocket | undefined;
  try {
    const registration = await fetch(`${baseUrl}/v1/runs/r-1/runner/previews`, {
      method: "POST",
      body: JSON.stringify({ port: 5173, label: "App" }),
    });
    assertEquals(registration.status, 201);
    const registered = await registration.json();
    assertEquals(
      registered.tunnel,
      `ws://127.0.0.1:${host.addr.port}/v1/local-previews/tunnel/${registered.ticket}`,
    );
    assertEquals(registered.audience, "machine");
    const open = (runId: string, previewId: string, user = true) =>
      fetch(`${baseUrl}/v1/runs/${runId}/previews/${previewId}/open`, {
        method: "POST",
        headers: user ? { authorization: "Bearer user" } : {},
      });
    // Registered but not yet connected: nothing to open.
    const early = await open("r-1", registered.id);
    assertEquals(early.status, 404);
    await early.body?.cancel();

    tunnel = new WebSocket(registered.tunnel, TUNNEL_PROTOCOL);
    await new Promise<void>((resolve, reject) => {
      tunnel!.onopen = () => resolve();
      tunnel!.onerror = reject;
    });
    const anonymous = await open("r-1", registered.id, false);
    assertEquals(anonymous.status, 403);
    await anonymous.body?.cancel();
    const opened = await open("r-1", registered.id);
    assertEquals(opened.status, 200);
    assertEquals(await opened.json(), { url: registered.url });
    const otherRun = await open("r-2", registered.id);
    assertEquals(otherRun.status, 404);
    await otherRun.body?.cancel();
    const unknown = await open("r-1", "f".repeat(32));
    assertEquals(unknown.status, 404);
    await unknown.body?.cancel();
    active = false;
    const ended = await open("r-1", registered.id);
    assertEquals(ended.status, 410);
    await ended.body?.cancel();
  } finally {
    tunnel?.close();
    previews.close();
    await host.shutdown();
  }
});

test("local previews: one shared port routes each preview by its host name", async () => {
  const previews = localPreviews({
    authenticateRunner: () => Promise.resolve(true),
    authenticateReader: () => Promise.resolve(null),
    active: () => Promise.resolve(true),
    listener: { port: 0, hostname: "127.0.0.1" },
  });
  const shared = await previews.listening!;
  const upstreams = await Promise.all(["one", "two"].map((name) =>
    serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      () => new Response(name),
    )
  ));
  const host = await serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    acceptingUpgrades(async (req) => {
      for (const route of previews.routes) {
        const match = route.pattern.exec(req.url);
        if (route.method === req.method && match) {
          return await route.handler(req, match.pathname.groups as Record<string, string>);
        }
      }
      return new Response(null, { status: 404 });
    }),
  );
  const baseUrl = `http://127.0.0.1:${host.addr.port}`;
  const get = (hostHeader: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        `http://127.0.0.1:${shared}/`,
        { headers: { host: hostHeader } },
        (res) => {
          let body = "";
          res.on("data", (chunk) => body += chunk);
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    const exposed = [];
    for (const [i, upstream] of upstreams.entries()) {
      const runner = await runnerPreviews({
        baseUrl,
        runId: `r-${i}`,
        runToken: "t",
        reserved: () => [],
      });
      exposed.push(await runner!.expose(upstream.addr.port, "App"));
    }
    // Both on the one port, each answering for its own preview only.
    for (const [i, preview] of exposed.entries()) {
      const url = new URL(preview.url);
      assertEquals(url.port, String(shared));
      assertEquals(await get(url.host), { status: 200, body: i === 0 ? "one" : "two" });
    }
    assertEquals((await get(`${"f".repeat(32)}.localhost:${shared}`)).status, 404);
    assertEquals((await get(`127.0.0.1:${shared}`)).status, 404);
    // The right preview under another port is not its authority.
    const wrongPort = `${new URL(exposed[0]!.url).hostname}:1`;
    assertEquals((await get(wrongPort)).status, 403);
  } finally {
    previews.close();
    await host.shutdown();
    for (const upstream of upstreams) await upstream.shutdown();
  }
});

test("local previews: a published port is the one a preview's URL names", async () => {
  const previews = localPreviews({
    authenticateRunner: () => Promise.resolve(true),
    authenticateReader: () => Promise.resolve(null),
    active: () => Promise.resolve(true),
    listener: { port: 0, hostname: "127.0.0.1", publicPort: 7490 },
  });
  try {
    await previews.listening;
    const register = previews.routes.find((route) => route.method === "POST")!;
    const response = await register.handler(
      new Request("http://127.0.0.1/v1/runs/r-1/runner/previews", {
        method: "POST",
        body: JSON.stringify({ port: 5173, label: "App" }),
      }),
      { runId: "r-1" },
    );
    assertEquals(response.status, 201);
    const { id, url } = await response.json();
    assertEquals(url, `http://${id}.localhost:7490`);
  } finally {
    previews.close();
  }
});

test("local previews: a shared port that is taken says so", async () => {
  const taken = createNetServer();
  await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
  const port = (taken.address() as AddressInfo).port;
  const previews = localPreviews({
    authenticateRunner: () => Promise.resolve(true),
    authenticateReader: () => Promise.resolve(null),
    active: () => Promise.resolve(true),
    listener: { port, hostname: "127.0.0.1" },
  });
  try {
    let failed = false;
    await previews.listening!.catch(() => (failed = true));
    assert(failed);
  } finally {
    previews.close();
    taken.close();
  }
});

test("local previews: a browser's WebSocket upload its runner stops acking is not read past a read or two", async () => {
  // Bun's own upgraded sockets read on past a `pause()` without bound (docs/runtime.md, Bun bugs);
  // the preview listener's front (`frontHttpServer`) is what stops reading the browser.
  const previews = localPreviews({
    authenticateRunner: () => Promise.resolve(true),
    authenticateReader: () => Promise.resolve(null),
    active: () => Promise.resolve(true),
  });
  const host = await serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    acceptingUpgrades(async (req) => {
      for (const route of previews.routes) {
        const match = route.pattern.exec(req.url);
        if (route.method === req.method && match) {
          return await route.handler(req, match.pathname.groups as Record<string, string>);
        }
      }
      return new Response(null, { status: 404 });
    }),
  );
  const browser = new Set<ReturnType<typeof connect>>();
  let ws: WebSocket | undefined;
  try {
    const registered = await (await fetch(
      `http://127.0.0.1:${host.addr.port}/v1/runs/r-1/runner/previews`,
      { method: "POST", body: JSON.stringify({ port: 5173, label: "App" }) },
    )).json();
    // A runner that answers the upgrade and then never acks what the browser sends.
    ws = new WebSocket(registered.tunnel, TUNNEL_PROTOCOL);
    ws.binaryType = "arraybuffer";
    const switching = new TextEncoder().encode(
      "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
    );
    const runner = ws;
    runner.onmessage = ({ data }) => {
      if (typeof data !== "string") return;
      const signal = JSON.parse(data) as Record<string, number>;
      if (signal.open === undefined) return;
      const frame = new Uint8Array(4 + switching.byteLength);
      new DataView(frame.buffer).setUint32(0, signal.open);
      frame.set(switching, 4);
      runner.send(frame);
    };
    await new Promise<void>((resolve, reject) => {
      runner.onopen = () => resolve();
      runner.onerror = () => reject(new Error("tunnel refused"));
    });
    const url = new URL(registered.url);
    const socket = connect({ host: "127.0.0.1", port: Number(url.port) });
    socket.on("error", () => {});
    browser.add(socket);
    const answered = new Promise<string>((resolve) =>
      socket.once("data", (chunk) => resolve(String(chunk).split("\r\n")[0]))
    );
    socket.write(
      `GET /hmr HTTP/1.1\r\nhost: ${url.host}\r\nconnection: Upgrade\r\nupgrade: websocket\r\n` +
        "sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    assert((await answered).startsWith("HTTP/1.1 101"));
    // Uploads as fast as the host takes them, for a second: what it took is what reached the
    // kernel, and past the kernel's buffers that is what the host read.
    const batch = new Uint8Array(1024 * 1024).fill(1);
    let sent = 0;
    const taken = () => sent - socket.writableLength;
    const pump = () => {
      while (!socket.destroyed && sent < 2 ** 32) {
        sent += batch.byteLength;
        if (!socket.write(batch)) return void socket.once("drain", pump);
      }
    };
    pump();
    const until = Date.now() + 1_000;
    while (Date.now() < until && taken() <= 256 * 2 ** 20) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Both ends' kernel buffers and a read or two; read without bound, it is gigabytes.
    assert(taken() <= 32 * 2 ** 20, `${(taken() / 2 ** 20).toFixed(1)} MiB taken`);
  } finally {
    for (const socket of browser) socket.destroy();
    ws?.close();
    previews.close();
    await host.shutdown();
  }
});

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not finish in ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A local previews host with one preview registered, its tunnel dialled by hand over a raw
 * socket: `send` writes WebSocket bytes, `closed` settles once the host cuts it, and `answered`
 * says whether it sent anything back after the handshake. */
async function rawLocalTunnel() {
  const previews = localPreviews({
    authenticateRunner: () => Promise.resolve(true),
    authenticateReader: () => Promise.resolve(null),
    active: () => Promise.resolve(true),
  });
  const host = await serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    acceptingUpgrades(async (req) => {
      for (const route of previews.routes) {
        const match = route.pattern.exec(req.url);
        if (route.method === req.method && match) {
          return await route.handler(req, match.pathname.groups as Record<string, string>);
        }
      }
      return new Response(null, { status: 404 });
    }),
  );
  const registration = await fetch(
    `http://127.0.0.1:${host.addr.port}/v1/runs/r-1/runner/previews`,
    { method: "POST", body: JSON.stringify({ port: 5173, label: "App" }) },
  );
  const registered = await registration.json();
  const raw = connect({ host: "127.0.0.1", port: host.addr.port });
  raw.on("error", () => {});
  await new Promise((resolve) => raw.once("connect", resolve));
  const path = new URL(registered.tunnel).pathname;
  raw.write(
    `GET ${path} HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: Upgrade\r\n` +
      `sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
      `sec-websocket-protocol: ${TUNNEL_PROTOCOL}\r\n\r\n`,
  );
  let answer = "";
  await new Promise<void>((resolve) =>
    raw.on("data", (chunk) => {
      answer += chunk;
      if (answer.includes("\r\n\r\n")) resolve();
    })
  );
  assert(answer.startsWith("HTTP/1.1 101"), answer);
  const after = answer.length;
  const closed = new Promise<void>((resolve) => raw.once("close", () => resolve()));
  return {
    send: (bytes: number[]) => raw.write(new Uint8Array(bytes)),
    closed,
    answered: () => answer.length > after,
    async close() {
      raw.destroy();
      previews.close();
      await host.shutdown();
    },
  };
}

test("local previews: a tunnel that floods pings and reads nothing is cut, never answered", async () => {
  const tunnel = await rawLocalTunnel();
  try {
    // Masked, empty pings, many of them.
    const ping = [0x89, 0x80, 0, 0, 0, 0];
    tunnel.send(Array.from({ length: 10_000 }, () => ping).flat());
    await tunnel.closed;
    assert(!tunnel.answered(), "a pong was sent");
  } finally {
    await tunnel.close();
  }
});

test("local previews: a tunnel that fragments a message is cut at its second frame", async () => {
  // Masked frames, the mask all zeros: a first fragment, then a continuation that is not the
  // last either, or a thousand empty ones.
  const frame = (
    fin: boolean,
    opcode: number,
    payload: number[],
  ) => [(fin ? 0x80 : 0) | opcode, 0x80 | payload.length, 0, 0, 0, 0, ...payload];
  const first = frame(false, 2, [0, 0, 0, 0]);
  for (
    const rest of [
      frame(false, 0, [1]),
      Array.from({ length: 1_000 }, () => frame(false, 0, [])).flat(),
    ]
  ) {
    const tunnel = await rawLocalTunnel();
    try {
      tunnel.send([...first, ...rest]);
      await within(tunnel.closed, 2_000, "cutting the tunnel");
    } finally {
      await tunnel.close();
    }
  }
});

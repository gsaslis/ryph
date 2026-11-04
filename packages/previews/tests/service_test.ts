import { test } from "bun:test";
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { type IncomingHttpHeaders, request } from "node:http";
import { readFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { DEFAULT_KEEP_ALIVE_MS, makeHealth, serve } from "@ryph/service";
import { BASELINE_MS } from "../src/memory.ts";
import {
  MAX_FRAME,
  MAX_STREAMS,
  PER_RUN,
  RECEIVE_BUFFER,
  runnerMux,
  SERVED_BYTES,
  STREAM_BYTES,
  TUNNEL_PROTOCOL,
} from "@ryph/tunnel";
import {
  API_MAX,
  CULPRIT_MIN,
  CULPRIT_RELEASE_MS,
  culpritsOf,
  DRAIN_GRACE_MS,
  EXPLAINED,
  PRESSURE_IDLE_MS,
  previews,
  type PreviewsLog,
  type PreviewsOptions,
  PUBLIC_MAX,
  RETRY_S,
  SHED_HOLD_MS,
  TUNNEL_MAX,
  UNTRUSTED_PER_ADDRESS,
  UNTRUSTED_TOTAL,
} from "../src/service.ts";
import { COOKIE, HTTP_COOKIE, keys, viewerCookie } from "../src/core/keys.ts";

/** Whether this machine's TCP buffers are held to the pod's sysctls (128 KiB each way), which the
 * guard's per-socket count assumes. A Linux without them (a check pod) lets each socket's kernel
 * buffers take megabytes no run's count sees, so a stalled run's bytes explain nothing there. */
const BUFFERS_CAPPED = process.platform !== "linux" || ["tcp_rmem", "tcp_wmem"].every((name) => {
  try {
    return Number(readFileSync(`/proc/sys/net/ipv4/${name}`, "utf8").trim().split(/\s+/)[2]) <=
      128 * 1024;
  } catch {
    return false;
  }
});

const TOKEN = "t".repeat(64);
const DOMAIN = "preview.localhost";
const auth = { authorization: `Bearer ${TOKEN}` };
/** The CSP of a preview whose run may reach api.example.com. */
const CSP =
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https://api.example.com " +
  "wss://api.example.com; form-action 'self' https://api.example.com; base-uri 'self'; " +
  "frame-ancestors 'self'";

/** The agent's dev server: echoes what it was sent, and says what a hostile one would. */
function devServer() {
  return serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req, info) => {
    const url = new URL(req.url);
    if (req.headers.get("upgrade") === "websocket") {
      const { response, socket } = info.upgradeWebSocket(req);
      socket.onmessage = ({ data }) => socket.send(data);
      return response;
    }
    if (url.pathname === "/cookies") {
      const headers = new Headers();
      headers.append("set-cookie", "theirs=1; Domain=preview.localhost; Path=/");
      headers.append("set-cookie", `${COOKIE}=forged; Path=/`);
      headers.append("set-cookie", `${HTTP_COOKIE}=forged; Path=/`);
      return new Response("ok", { headers });
    }
    if (url.pathname === "/redirect") {
      return new Response(null, {
        status: 302,
        headers: { location: `http://localhost:${url.port}/next` },
      });
    }
    if (url.pathname === "/slow") {
      return new Promise((resolve) => setTimeout(() => resolve(new Response("ok")), 100));
    }
    if (url.pathname === "/forever") {
      // An SSE stream: an event at once, then nothing, never ending.
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (url.pathname === "/csp") {
      return new Response("ok", { headers: { "content-security-policy": "img-src 'none'" } });
    }
    if (url.pathname === "/reporting") {
      // Two policies of its own, each naming somewhere to report to, and a report-only one.
      const headers = new Headers();
      headers.append(
        "content-security-policy",
        "img-src 'none'; REPORT-URI https://collect.example/r; report-to grp",
      );
      headers.append("content-security-policy", "report-uri https://collect.example/only");
      headers.append("content-security-policy", "script-src 'self';report-to grp, style-src *");
      headers.append(
        "content-security-policy-report-only",
        "default-src 'none'; report-uri https://collect.example/ro",
      );
      return new Response("ok", { headers });
    }
    return Response.json(Object.fromEntries(req.headers));
  });
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** On `*.localhost` by default (http, a public port in every origin); any other domain is https
 * on the scheme's own port, as behind the Gateway. */
async function setup(
  opts: {
    now?: () => number;
    domain?: string;
    appUrl?: string;
    streams?: number;
    memory?: PreviewsOptions["memory"];
    log?: PreviewsLog;
  } = {},
) {
  const domain = opts.domain ?? DOMAIN;
  const http = domain.endsWith("localhost");
  const scheme = http ? "http" : "https";
  // The public port must be known before the service is, since it is part of every origin.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const publicPort = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const service = await previews({
    token: TOKEN,
    domain,
    publicPort: http ? publicPort : undefined,
    now: opts.now,
    appUrl: opts.appUrl,
    streams: opts.streams,
    memory: opts.memory,
    log: opts.log,
    health: makeHealth().routes,
  });
  await new Promise<void>((resolve) => service.public.listen(publicPort, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => service.tunnel.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => service.api.listen(0, "127.0.0.1", resolve));
  const tunnelPort = (service.tunnel.address() as { port: number }).port;
  const apiPort = (service.api.address() as { port: number }).port;
  const base = `http://127.0.0.1:${apiPort}`;
  const runners: WebSocket[] = [];

  const call = async (method: string, path: string, body?: unknown, headers = auth) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const register = (runId: string, port: number, hosts: string[] | null = []) =>
    call("POST", "/internal/previews", { runId, port, label: "App", hosts });

  /** The runner's end: dials the tunnel and the dev server for each stream. */
  async function dial(ticket: string, devPort: number) {
    const ws = new WebSocket(`ws://127.0.0.1:${tunnelPort}/tunnel/${ticket}`, TUNNEL_PROTOCOL);
    ws.binaryType = "arraybuffer";
    const mux = runnerMux(
      ws,
      () => connect({ host: "127.0.0.1", port: devPort, allowHalfOpen: true }),
    );
    ws.onmessage = ({ data }) => {
      if (mux.receive(data) === "invalid") ws.close();
    };
    const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));
    ws.addEventListener("close", () => mux.close());
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("tunnel refused"));
    });
    runners.push(ws);
    return { ws, closed };
  }

  /** Until the service lists the preview: its end of the socket opens a moment after ours. */
  async function listed(runId: string, count: number) {
    for (let i = 0; i < 100; i++) {
      const { body } = await call("GET", `/internal/runs/${runId}/previews`);
      if (body.previews.length === count) return body.previews;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`run ${runId} never listed ${count} previews`);
  }

  const host = (id: string) => http ? `${id}.${domain}:${publicPort}` : `${id}.${domain}`;
  const hit = (
    path: string,
    headers: Record<string, string>,
    method = "GET",
  ): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: publicPort, path, method, headers },
        (res) => {
          let body = "";
          res.on("data", (chunk) => body += chunk);
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        },
      );
      req.on("error", reject);
      req.setTimeout(5000, () => req.destroy(new Error(`${path} timed out`)));
      req.end();
    });

  /** A viewer's cookie, the way a browser gets one: a ticket from the control plane, entered. */
  async function enter(runId: string, id: string): Promise<string> {
    const { status, body } = await call("POST", `/internal/previews/${id}/viewer`, { runId });
    assertEquals(status, 200);
    const url = new URL(body.url);
    assertEquals(url.origin, `${scheme}://${host(id)}`);
    const entered = await hit(url.pathname + url.search, { host: host(id) });
    assertEquals(entered.status, 303);
    assertEquals(entered.headers.location, "/");
    const cookie = String(entered.headers["set-cookie"]);
    // Over http, Safari refuses `Secure` and so `__Host-`: a plain host-only cookie instead.
    assertMatch(
      cookie,
      http
        ? /^ryph-preview=[^;]+; Max-Age=28800; Path=\/; HttpOnly; SameSite=Lax$/
        : /^__Host-ryph-preview=[^;]+; Max-Age=28800; Path=\/; Secure; HttpOnly; SameSite=Lax$/,
    );
    return cookie.split(";")[0];
  }

  /** A raw WebSocket handshake, so Host and Origin can be anything; resolves the status. */
  const upgrade = (headers: Record<string, string>, echo = false) =>
    new Promise<number>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: publicPort,
        path: "/hmr",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          ...headers,
        },
      });
      req.on("error", reject);
      req.setTimeout(5000, () => req.destroy(new Error("upgrade timed out")));
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("upgrade", (res, socket) => {
        socket.on("error", () => {});
        if (!echo) {
          socket.destroy();
          resolve(res.statusCode!);
          return;
        }
        // A masked client text frame "hmr" comes back as an unmasked server one.
        socket.once("data", (chunk: Uint8Array) => {
          socket.destroy();
          try {
            assertEquals([...chunk], [129, 3, 104, 109, 114]);
            resolve(101);
          } catch (error) {
            reject(error);
          }
        });
        socket.write(new Uint8Array([129, 131, 0, 0, 0, 0, 104, 109, 114]));
      });
      req.end();
    });

  /** A plain request (no upgrade) to the tunnel listener: its status. */
  const plainTunnel = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${tunnelPort}${path}`, { headers: auth });
    await response.body?.cancel();
    return response.status;
  };

  return {
    service,
    base,
    tunnelPort,
    plainTunnel,
    publicPort,
    call,
    register,
    dial,
    listed,
    host,
    hit,
    enter,
    upgrade,
    async stop() {
      for (const ws of runners) ws.close();
      await service.shutdownPublic();
      service.close();
      for (const listener of [service.tunnel, service.api]) {
        await new Promise<void>((resolve) => listener.close(() => resolve()));
      }
    },
  };
}

test("previews: register, dial, enter, and proxy HTTP and a WebSocket", async () => {
  const dev = await devServer();
  const t = await setup();
  try {
    const registered = await t.register("r-1", dev.addr.port, ["api.example.com"]);
    assertEquals(registered.status, 201);
    const { id, url, ticket } = registered.body;
    assertMatch(id, /^[a-f0-9]{32}$/);
    assertEquals(url, `http://${t.host(id)}`);
    // Registered but not connected: not listed, and no viewer may be let in yet.
    assertEquals((await t.call("GET", "/internal/runs/r-1/previews")).body, { previews: [] });
    assertEquals(
      (await t.call("POST", `/internal/previews/${id}/viewer`, { runId: "r-1" })).status,
      404,
    );
    // A plain request for a tunnel is a 404 whether its ticket is pending or not: no oracle.
    assertEquals(await t.plainTunnel(`/tunnel/${ticket}`), 404);
    assertEquals(await t.plainTunnel(`/tunnel/${"a".repeat(64)}`), 404);
    // The tunnel listener serves no call of the control plane's, bearer or not, and the API
    // listener no tunnel.
    assertEquals(await t.plainTunnel("/internal/runs/r-1/previews"), 404);
    const onApi = new WebSocket(
      `${t.base.replace("http", "ws")}/tunnel/${ticket}`,
      TUNNEL_PROTOCOL,
    );
    assertEquals(
      await new Promise((resolve) => {
        onApi.onopen = () => resolve("open");
        onApi.onerror = () => resolve("refused");
      }),
      "refused",
    );
    await t.dial(ticket, dev.addr.port);
    assertEquals(await t.listed("r-1", 1), [{ id, port: dev.addr.port, label: "App", url }]);

    const cookie = await t.enter("r-1", id);
    const echoed = await t.hit("/headers", {
      host: t.host(id),
      cookie: `${cookie}; theirs=1`,
      origin: url,
      "sec-fetch-site": "same-origin",
    });
    assertEquals(echoed.status, 200);
    const seen = JSON.parse(echoed.body);
    assertEquals(seen.host, `localhost:${dev.addr.port}`);
    assertEquals(seen.origin, `http://localhost:${dev.addr.port}`);
    assertEquals(seen.cookie, "theirs=1");
    assertEquals(seen["x-forwarded-host"], t.host(id));
    assertEquals(seen["x-forwarded-proto"], "http");
    assertEquals(
      echoed.headers["content-security-policy"],
      CSP,
    );

    assertEquals(await t.upgrade({ host: t.host(id), cookie, origin: url }, true), 101);
  } finally {
    await t.stop();
    await dev.shutdown();
  }
});

test("previews: a burst past the stream cap waits for streams instead of failing", async () => {
  // Behind the balancer a browser speaks HTTP/2 and asks for every module of a page at once.
  const dev = await devServer();
  const t = await setup();
  try {
    const { id, url, ticket } = (await t.register("r-1", dev.addr.port, [])).body;
    await t.dial(ticket, dev.addr.port);
    await t.listed("r-1", 1);
    const cookie = await t.enter("r-1", id);
    const headers = { host: t.host(id), cookie, origin: url, "sec-fetch-site": "same-origin" };
    const replies = await Promise.all(
      Array.from({ length: MAX_STREAMS * 3 }, () => t.hit("/slow", headers)),
    );
    assertEquals(replies.map((r) => r.status), replies.map(() => 200));
  } finally {
    await t.stop();
    await dev.shutdown();
  }
});

test("previews: the gate refuses all but a viewer's own page, and contains the dev server", async () => {
  const dev = await devServer();
  const t = await setup();
  try {
    const a = (await t.register("r-1", dev.addr.port, ["api.example.com"])).body;
    const b = (await t.register("r-1", 1024)).body;
    const open = (await t.register("r-2", dev.addr.port, null)).body;
    await t.dial(a.ticket, dev.addr.port);
    await t.dial(b.ticket, dev.addr.port);
    await t.dial(open.ticket, dev.addr.port);
    await t.listed("r-1", 2);
    await t.listed("r-2", 1);
    const cookie = await t.enter("r-1", a.id);
    const as = (headers: Record<string, string> = {}, path = "/") =>
      t.hit(path, { host: t.host(a.id), cookie, ...headers });

    assertEquals((await as()).status, 200);
    // No cookie, or another preview's.
    const anonymous = await t.hit("/", { host: t.host(a.id) });
    assertEquals(anonymous.status, 401);
    assertMatch(anonymous.body, /Open this preview from Ryph\./);
    assertEquals(anonymous.headers["referrer-policy"], "no-referrer");
    assertEquals((await t.hit("/", { host: t.host(b.id), cookie })).status, 401);
    // Hosts that are not exactly a preview's own.
    assertEquals((await as({ host: `${a.id}.${DOMAIN}` })).status, 404);
    assertEquals((await as({ host: `127.0.0.1:${t.publicPort}` })).status, 404);
    // A preview nobody holds, without its own cookie, is answered as one somebody does: who has
    // no cookie learns nothing of which ids exist.
    assertEquals((await as({ host: `${"0".repeat(32)}.${DOMAIN}:${t.publicPort}` })).status, 401);
    // Not the preview's own page asking.
    assertEquals((await as({ origin: "http://evil.example" })).status, 403);
    assertEquals((await as({ origin: b.url })).status, 403);
    assertEquals(
      (await as({ "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" })).status,
      403,
    );
    assertEquals(
      (await as({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" })).status,
      403,
    );
    assertEquals(
      (await as({
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      })).status,
      200,
    );
    assertEquals((await as({ "service-worker": "script" }, "/sw.js")).status, 403);
    // Our own paths never reach the dev server.
    assertEquals((await as({}, "/__ryph/anything")).status, 404);
    const spent = await as({}, "/__ryph/enter?ticket=nope");
    assertEquals(spent.status, 403);
    assertMatch(spent.body, /This preview link has expired\. Open it again from Ryph\./);

    // WebSockets need the cookie and the preview's own Origin.
    assertEquals(await t.upgrade({ host: t.host(a.id), cookie, origin: a.url }), 101);
    assertEquals(await t.upgrade({ host: t.host(a.id), origin: a.url }), 401);
    assertEquals(await t.upgrade({ host: t.host(a.id), cookie }), 403);
    assertEquals(await t.upgrade({ host: t.host(a.id), cookie, origin: b.url }), 403);
    assertEquals(
      await t.upgrade({ host: t.host(a.id), cookie, origin: "http://evil.example" }),
      403,
    );

    // What the dev server says stays inside its origin.
    assertEquals((await as({}, "/cookies")).headers["set-cookie"], ["theirs=1; Path=/"]);
    assertEquals((await as({}, "/redirect")).headers.location, `${a.url}/next`);
    // Both policies, one header each; node:http's client joins them, as a comma list of
    // policies means to a browser too.
    assertEquals(
      (await as({}, "/csp")).headers["content-security-policy"],
      [
        "img-src 'none'",
        CSP,
      ].join(", "),
    );
    // Theirs keep every directive but those that report somewhere; a report-only policy goes.
    const reporting = await as({}, "/reporting");
    assertEquals(
      reporting.headers["content-security-policy"],
      ["img-src 'none'", "script-src 'self', style-src *", CSP].join(", "),
    );
    assertEquals(reporting.headers["content-security-policy-report-only"], undefined);
    const openCookie = await t.enter("r-2", open.id);
    const opened = await t.hit("/", { host: t.host(open.id), cookie: openCookie });
    assertEquals(opened.headers["content-security-policy"], "frame-ancestors 'self'");

    // A viewer ticket is for one run's preview, and only once.
    assertEquals(
      (await t.call("POST", `/internal/previews/${open.id}/viewer`, { runId: "r-1" })).status,
      404,
    );
    const { body } = await t.call("POST", `/internal/previews/${a.id}/viewer`, { runId: "r-1" });
    const enter = new URL(body.url);
    // Only a GET spends it: a HEAD or POST ahead of the link (a prefetch, a link preview) is
    // refused and leaves it for the link.
    for (const method of ["HEAD", "POST", "OPTIONS"]) {
      const early = await t.hit(enter.pathname + enter.search, { host: t.host(a.id) }, method);
      assertEquals(early.status, 405, method);
      assertEquals(early.headers["set-cookie"], undefined, method);
    }
    const entered = await t.hit(enter.pathname + enter.search, { host: t.host(a.id) });
    assertEquals(entered.status, 303);
    assertEquals((await t.hit(enter.pathname + enter.search, { host: t.host(b.id) })).status, 403);
    assertEquals((await t.hit(enter.pathname + enter.search, { host: t.host(a.id) })).status, 403);

    // The API listener wants the bearer, on every route.
    for (
      const [method, path] of [
        ["POST", "/internal/previews"],
        ["GET", "/internal/runs/r-1/previews"],
        ["POST", `/internal/previews/${a.id}/viewer`],
        ["DELETE", "/internal/runs/r-1"],
      ]
    ) {
      for (
        const headers of [{}, { authorization: `Bearer ${"x".repeat(64)}` }, {
          authorization: TOKEN,
        }]
      ) {
        const input = method === "GET" ? undefined : { runId: "r-1" };
        const refused = await t.call(method, path, input, headers as typeof auth);
        assertEquals(refused.status, 401, `${method} ${path}`);
      }
    }
    // Health answers on the public listener, where the kubelet and the load balancer probe, but
    // never on a preview's host; the tunnel and API listeners have none.
    assertEquals((await t.hit("/healthz", { host: `127.0.0.1:${t.publicPort}` })).status, 200);
    assertEquals((await t.call("GET", "/readyz")).status, 404);
    assertEquals(await t.plainTunnel("/readyz"), 404);
    assertEquals((await as({}, "/healthz")).status, 200);
    assertEquals(JSON.parse((await as({}, "/healthz")).body).host, `localhost:${dev.addr.port}`);

    // The run ends: its previews go, tunnels and all.
    assertEquals((await t.call("DELETE", "/internal/runs/r-1")).status, 204);
    assertEquals((await t.call("GET", "/internal/runs/r-1/previews")).body, { previews: [] });
    assertEquals((await as()).status, 404);
    assertEquals((await t.call("GET", "/internal/runs/r-2/previews")).body.previews.length, 1);
  } finally {
    await t.stop();
    await dev.shutdown();
  }
});

const manyHosts = (n: number) => Array.from({ length: n }, (_, i) => `h${i}.example.com`);

test("previews: limits, input, re-registration and ticket lifetimes", async () => {
  const dev = await devServer();
  let skew = 0;
  const t = await setup({ now: () => Date.now() + skew });
  try {
    for (
      const input of [
        { runId: "r-1", port: 80, label: "App", hosts: [] },
        { runId: "r-1", port: 5173, label: "", hosts: [] },
        { runId: "r-1", port: 5173, label: "x".repeat(81), hosts: [] },
        { runId: "r:1", port: 5173, label: "App", hosts: [] },
        { runId: "r-1", port: 5173, label: "App", hosts: ["a.b; script-src *"] },
        { runId: "r-1", port: 5173, label: "App" },
        { runId: "r-1", port: 5173, label: "App", hosts: manyHosts(513) },
      ]
    ) {
      assertEquals((await t.call("POST", "/internal/previews", input)).status, 400);
    }
    // 512 hosts at most, past the orchestrator's own ceiling of 200.
    assertEquals(
      (await t.call("POST", "/internal/previews", {
        runId: "r-0",
        port: 5173,
        label: "App",
        hosts: manyHosts(512),
      })).status,
      201,
    );
    assertEquals((await t.call("DELETE", "/internal/runs/r-0")).status, 204);
    const first = await t.register("r-1", dev.addr.port);
    for (const port of [2000, 2001, 2002]) {
      assertEquals((await t.register("r-1", port)).status, 201);
    }
    assertEquals((await t.register("r-1", 2003)).status, 429);
    // The same port again is not another preview: same id, a new ticket.
    const again = await t.register("r-1", dev.addr.port);
    assertEquals(again.status, 201);
    assertEquals(again.body.id, first.body.id);
    assert(again.body.ticket !== first.body.ticket);
    // The replaced ticket no longer dials.
    const stale = new WebSocket(
      `ws://127.0.0.1:${t.tunnelPort}/tunnel/${first.body.ticket}`,
      TUNNEL_PROTOCOL,
    );
    assertEquals(
      await new Promise((resolve) => {
        stale.onopen = () => resolve("open");
        stale.onerror = () => resolve("refused");
      }),
      "refused",
    );
    const old = await t.dial(again.body.ticket, dev.addr.port);
    await t.listed("r-1", 1);
    const cookie = await t.enter("r-1", first.body.id);

    // Re-registered while connected: the old tunnel serves until the new one connects, then goes.
    const third = await t.register("r-1", dev.addr.port);
    assertEquals((await t.hit("/", { host: t.host(first.body.id), cookie })).status, 200);
    await t.dial(third.body.ticket, dev.addr.port);
    await old.closed;
    await t.listed("r-1", 1);
    assertEquals((await t.hit("/", { host: t.host(first.body.id), cookie })).status, 200);

    // Tickets expire: a viewer's after a minute, a tunnel's after ten seconds.
    const viewer = await t.call("POST", `/internal/previews/${first.body.id}/viewer`, {
      runId: "r-1",
    });
    const late = await t.register("r-1", 2000);
    skew = 61_000;
    const enter = new URL(viewer.body.url);
    assertEquals(
      (await t.hit(enter.pathname + enter.search, { host: t.host(first.body.id) })).status,
      403,
    );
    const refused = await t.dial(late.body.ticket, dev.addr.port).then(
      () => "dialled",
      () => "refused",
    );
    assertEquals(refused, "refused");
    skew = 0;

    // 256 in all, whichever runs hold them.
    for (let run = 2; run <= 64; run++) {
      for (const port of [3000, 3001, 3002, 3003]) {
        assertEquals((await t.register(`r-${run}`, port)).status, 201);
      }
    }
    assertEquals((await t.register("r-65", 3000)).status, 429);
  } finally {
    await t.stop();
    await dev.shutdown();
  }
});

test("previews: a drain closes upgraded sockets and tunnels", async () => {
  const dev = await devServer();
  const t = await setup();
  const registered = (await t.register("r-1", dev.addr.port)).body;
  const runner = await t.dial(registered.ticket, dev.addr.port);
  await t.listed("r-1", 1);
  const cookie = await t.enter("r-1", registered.id);
  const browser = await new Promise<import("node:stream").Duplex>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: t.publicPort,
      path: "/hmr",
      headers: {
        host: t.host(registered.id),
        cookie,
        origin: registered.url,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    req.on("upgrade", (_res, socket) => resolve(socket));
    req.on("error", reject);
    req.end();
  });
  browser.on("error", () => {});
  const browserClosed = new Promise<void>((resolve) => browser.on("close", () => resolve()));
  try {
    const started = performance.now();
    await t.service.shutdownPublic();
    await browserClosed;
    t.service.close();
    await runner.closed;
    assert(performance.now() - started < 2000, "the drain waited on a WebSocket");
  } finally {
    await t.stop();
    await dev.shutdown();
  }
});

test("previews: the sweep drops quiet tunnels and registrations never dialled", async () => {
  const dev = await devServer();
  let skew = 0;
  const t = await setup({ now: () => Date.now() + skew });
  try {
    const quiet = (await t.register("r-1", dev.addr.port)).body;
    const runner = await t.dial(quiet.ticket, dev.addr.port);
    await t.register("r-1", 2000);
    await t.listed("r-1", 1);
    skew = 11_000;
    t.service.sweep();
    // Still connected and pinged recently enough; the undialled one is gone, so its slot is free.
    await t.listed("r-1", 1);
    for (const port of [2000, 2001, 2002]) {
      assertEquals((await t.register("r-1", port)).status, 201);
    }
    assertEquals((await t.register("r-1", 2003)).status, 429);
    // The runner pings every 15 s; 45 s of silence and its tunnel is closed.
    skew = 46_000;
    t.service.sweep();
    await runner.closed;
    await t.listed("r-1", 0);
  } finally {
    await t.stop();
    await dev.shutdown();
  }
});

/**
 * Opens a raw tunnel socket, upgrades it, then sends a masked binary frame header announcing
 * `announced` bytes and only `sent` bytes of it. Resolves "closed" when the service drops the socket
 * without waiting for the rest, "still open" when it is still waiting after two seconds.
 */
function oversizedFrame(port: number, ticket: string, announced: number, sent: number) {
  return new Promise<string>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let upgraded = false;
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("still open");
    }, 2000);
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(upgraded ? "closed" : "refused");
    });
    socket.on("data", (chunk: Uint8Array) => {
      if (upgraded || !new TextDecoder().decode(chunk).startsWith("HTTP/1.1 101")) return;
      upgraded = true;
      // A server that buffers a whole message before checking its size waits here for the rest.
      const header = new Uint8Array(14);
      header.set([0x82, 0x80 | 127]);
      new DataView(header.buffer).setBigUint64(2, BigInt(announced));
      socket.write(header);
      socket.write(new Uint8Array(sent));
    });
    socket.write(
      `GET /tunnel/${ticket} HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: Upgrade\r\n` +
        "upgrade: websocket\r\nsec-websocket-version: 13\r\n" +
        `sec-websocket-protocol: ${TUNNEL_PROTOCOL}\r\n` +
        "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
  });
}

test("previews: a tunnel frame past the limit is refused as its header arrives", async () => {
  const t = await setup();
  try {
    const { ticket } = (await t.register("r-1", 5173)).body;
    const port = t.tunnelPort;
    // 8 MiB announced, 64 KiB sent.
    assertEquals(await oversizedFrame(port, ticket, 8 * 1024 * 1024, 64 * 1024), "closed");
  } finally {
    await t.stop();
  }
});

test("previews: one byte past the limit is enough, so the real ws enforces it and not a stand-in", async () => {
  // Bun answers `import "ws"` with a stand-in that ignores `maxPayload` and buffers the frame
  // whole; the service loads the package itself through `realWs()`. Against the stand-in this
  // reads "still open".
  const t = await setup();
  try {
    const { ticket } = (await t.register("r-1", 5173)).body;
    const port = t.tunnelPort;
    assertEquals(await oversizedFrame(port, ticket, MAX_FRAME + 4 + 1, 1024), "closed");
  } finally {
    await t.stop();
  }
});

test("previews: viewer tickets are capped per preview, so one preview cannot crowd out another", async () => {
  const dev = await devServer();
  const t = await setup();
  try {
    const a = (await t.register("r-1", dev.addr.port)).body;
    const b = (await t.register("r-2", dev.addr.port)).body;
    await t.dial(a.ticket, dev.addr.port);
    await t.dial(b.ticket, dev.addr.port);
    await t.listed("r-1", 1);
    await t.listed("r-2", 1);
    const ask = async (runId: string, id: string) => {
      const { status, body } = await t.call("POST", `/internal/previews/${id}/viewer`, { runId });
      assertEquals(status, 200);
      return new URL(body.url);
    };
    const first = await ask("r-1", a.id);
    for (let i = 0; i < 4200; i++) await ask("r-1", a.id);
    const last = await ask("r-1", a.id);
    // The oldest of a flood is gone; the newest, and another preview's, still enter.
    assertEquals((await t.hit(first.pathname + first.search, { host: t.host(a.id) })).status, 403);
    assertEquals((await t.hit(last.pathname + last.search, { host: t.host(a.id) })).status, 303);
    const other = await ask("r-2", b.id);
    assertEquals((await t.hit(other.pathname + other.search, { host: t.host(b.id) })).status, 303);
  } finally {
    await t.stop();
    await dev.shutdown();
  }
});

test("previews: over https the cookie is __Host- and Secure, and neither name gets through", async () => {
  const dev = await devServer();
  const t = await setup({ domain: "preview.cell.example" });
  try {
    const registered = (await t.register("r-1", dev.addr.port, ["api.example.com"])).body;
    assertEquals(registered.url, `https://${t.host(registered.id)}`);
    await t.dial(registered.ticket, dev.addr.port);
    await t.listed("r-1", 1);
    const cookie = await t.enter("r-1", registered.id);
    const as = (headers: Record<string, string> = {}, path = "/") =>
      t.hit(path, { host: t.host(registered.id), ...headers });
    assertEquals((await as({ cookie })).status, 200);
    // The http name is not a viewer's cookie here.
    assertEquals((await as({ cookie: `${HTTP_COOKIE}=${cookie.split("=")[1]}` })).status, 401);
    const seen = JSON.parse(
      (await as({ cookie: `${cookie}; ${HTTP_COOKIE}=x; theirs=1` }, "/headers")).body,
    );
    assertEquals(seen.cookie, "theirs=1");
    assertEquals(seen["x-forwarded-proto"], "https");
    assertEquals((await as({ cookie }, "/cookies")).headers["set-cookie"], ["theirs=1; Path=/"]);
  } finally {
    await t.stop();
    await dev.shutdown();
  }
});

test("previews: over http the cookie is plain ryph-preview, and neither name gets through", async () => {
  const dev = await devServer();
  const t = await setup();
  try {
    const registered = (await t.register("r-1", dev.addr.port)).body;
    await t.dial(registered.ticket, dev.addr.port);
    await t.listed("r-1", 1);
    const cookie = await t.enter("r-1", registered.id);
    const as = (headers: Record<string, string> = {}, path = "/") =>
      t.hit(path, { host: t.host(registered.id), ...headers });
    assertEquals((await as({ cookie })).status, 200);
    assertEquals((await as({ cookie: `${COOKIE}=${cookie.split("=")[1]}` })).status, 401);
    const seen = JSON.parse(
      (await as({ cookie: `${cookie}; ${COOKIE}=x; theirs=1` }, "/headers")).body,
    );
    assertEquals(seen.cookie, "theirs=1");
    assertEquals((await as({ cookie }, "/cookies")).headers["set-cookie"], ["theirs=1; Path=/"]);
    // Decoys a sibling tossed with longer paths come first. Those that could not be one (stale,
    // malformed) cost nothing and never hide the real one; of those that could, a few do not, and
    // past MAX_COOKIES (4) they do, rather than each costing an HMAC.
    const junk = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `${HTTP_COOKIE}=${i % 2 ? "1" : `${i}.${"0".repeat(64)}`}`,
      )
        .join("; ");
    assertEquals((await as({ cookie: `${junk(50)}; ${cookie}` })).status, 200);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const decoys = (n: number) =>
      Array.from({ length: n }, (_, i) => `${HTTP_COOKIE}=${exp + i}.${"0".repeat(64)}`).join("; ");
    assertEquals((await as({ cookie: `${decoys(3)}; ${cookie}` })).status, 200);
    assertEquals((await as({ cookie: `${decoys(4)}; ${cookie}` })).status, 401);
  } finally {
    await t.stop();
    await dev.shutdown();
  }
});

const APP = "https://app.cell.example";
const NAVIGATE = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

test("previews: a link opened without the cookie goes through the app and lands where it pointed", async () => {
  const dev = await devServer();
  const t = await setup({ appUrl: APP });
  try {
    const { id, url, ticket } = (await t.register("r-1", dev.addr.port)).body;
    await t.dial(ticket, dev.addr.port);
    await t.listed("r-1", 1);
    const as = (headers: Record<string, string>, path = "/nodes/x?y=1", method = "GET") =>
      t.hit(path, { host: t.host(id), ...headers }, method);
    // The app's route by the preview alone: the run is never named to whoever holds the link.
    const open = `${APP}/previews/${id}`;

    // A page load, from a link or a pasted URL: to the app's open route, the path along.
    const sent = await as({ ...NAVIGATE, "sec-fetch-site": "none" });
    assertEquals(sent.status, 303);
    assert(!sent.headers.location!.includes("r-1"));
    assertEquals(sent.headers.location, `${open}?path=${encodeURIComponent("/nodes/x?y=1")}`);
    assertEquals(sent.headers["cache-control"], "no-store");
    assertEquals(sent.headers["referrer-policy"], "no-referrer");
    assertEquals((await as(NAVIGATE, "/")).headers.location, open);
    // Safari before 16.4 sends no Sec-Fetch headers at all: a GET for HTML is the page load.
    const safari = await as({ accept: "text/html,application/xhtml+xml,*/*;q=0.8" });
    assertEquals(safari.status, 303);
    assertEquals(safari.headers.location, `${open}?path=${encodeURIComponent("/nodes/x?y=1")}`);
    // A path that could not come back is not carried there.
    assertEquals((await as(NAVIGATE, `/${"a".repeat(3000)}`)).headers.location, open);

    // Anything else without the cookie is still refused, with the page that says what to do.
    for (
      const [headers, method] of [
        [{ "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }, "GET"],
        [{ "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" }, "GET"],
        [{ "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" }, "GET"],
        [{ "sec-fetch-site": "same-origin", accept: "text/html" }, "GET"],
        [{ accept: "application/json" }, "GET"],
        [NAVIGATE, "HEAD"],
        [NAVIGATE, "POST"],
      ] as const
    ) {
      const refused = await as(headers, "/nodes/x", method);
      assertEquals(refused.status, 401, `${method} ${JSON.stringify(headers)}`);
      assertEquals(refused.headers.location, undefined);
      if (method !== "HEAD") assertMatch(refused.body, /Open this preview from Ryph\./);
    }
    assertEquals(await t.upgrade({ host: t.host(id), origin: url }), 401);

    // The app asks for a ticket with the path; entering it lands there, cookie set.
    const viewer = await t.call("POST", `/internal/previews/${id}/viewer`, {
      runId: "r-1",
      path: "/nodes/x?y=1",
    });
    assertEquals(viewer.status, 200);
    const enter = new URL(viewer.body.url);
    assertEquals([...enter.searchParams.keys()], ["ticket"]);
    const entered = await t.hit(enter.pathname + enter.search, { host: t.host(id) });
    assertEquals(entered.status, 303);
    assertEquals(entered.headers.location, "/nodes/x?y=1");
    assertEquals(entered.headers["cache-control"], "no-store");
    assertEquals(entered.headers["referrer-policy"], "no-referrer");
    const cookie = String(entered.headers["set-cookie"]).split(";")[0];
    const landed = await as({ ...NAVIGATE, cookie });
    assertEquals(landed.status, 200);
    assertEquals(JSON.parse(landed.body).host, `localhost:${dev.addr.port}`);
  } finally {
    await t.stop();
    await dev.shutdown();
  }
});

test("previews: a ticket's path only ever lands on this preview's own origin", async () => {
  const dev = await devServer();
  const t = await setup({ appUrl: APP });
  try {
    const { id, ticket } = (await t.register("r-1", dev.addr.port)).body;
    await t.dial(ticket, dev.addr.port);
    await t.listed("r-1", 1);
    const landsOn = async (path: unknown) => {
      const { status, body } = await t.call("POST", `/internal/previews/${id}/viewer`, {
        runId: "r-1",
        path,
      });
      assertEquals(status, 200);
      const enter = new URL(body.url);
      const entered = await t.hit(enter.pathname + enter.search, { host: t.host(id) });
      assertEquals(entered.status, 303);
      return entered.headers.location;
    };
    for (
      const path of [
        "//evil.example",
        "//evil.example/x",
        "/\\evil.example",
        "/a\\b",
        "https://evil.example",
        "evil.example",
        "/a\r\nset-cookie: x=1",
        "/a\u0000",
        "/a b",
        "/é",
        "/a#b",
        "/__ryph/enter?ticket=x",
        `/${"a".repeat(2048)}`,
        "",
        42,
        null,
        ["/a"],
      ]
    ) {
      assertEquals(await landsOn(path), "/", JSON.stringify(path));
    }
    // Escaped, a slash is a path's own character, and stays one on this origin.
    assertEquals(await landsOn("/%2F/evil.example"), "/%2F/evil.example");
    assertEquals(await landsOn(`/${"a".repeat(2047)}`), `/${"a".repeat(2047)}`);
    assertEquals(await landsOn("/a?b=c&d=%2F"), "/a?b=c&d=%2F");
  } finally {
    await t.stop();
    await dev.shutdown();
  }
});

test("previews: without the app's origin, a cookieless page load is the 401 page", async () => {
  const dev = await devServer();
  const t = await setup();
  try {
    const { id, ticket } = (await t.register("r-1", dev.addr.port)).body;
    await t.dial(ticket, dev.addr.port);
    await t.listed("r-1", 1);
    const refused = await t.hit("/nodes/x?y=1", { host: t.host(id), ...NAVIGATE });
    assertEquals(refused.status, 401);
    assertMatch(refused.body, /Open this preview from Ryph\./);
  } finally {
    await t.stop();
    await dev.shutdown();
  }
});

test("previews: a tunnel dialled without the framing's subprotocol is refused, its ticket unspent", async () => {
  let now = Date.now();
  const warned: Record<string, unknown>[] = [];
  const t = await setup({
    now: () => now,
    log: {
      info() {},
      warn: (event, fields) => {
        if (event === "preview.tunnel.protocol") warned.push(fields!);
      },
    },
  });
  try {
    const port = t.tunnelPort;
    const refusedDial = async (ticket: string) => {
      const unframed = new WebSocket(`ws://127.0.0.1:${port}/tunnel/${ticket}`);
      return await new Promise<string>((resolve) => {
        unframed.onopen = () => resolve("open");
        unframed.onerror = () => resolve("refused");
      });
    };
    // A runner that dials again and again, re-registering for a fresh ticket each time, is said
    // once a while, with how many were folded in.
    for (let i = 0; i < 3; i++) {
      const { ticket } = (await t.register("r-1", 5173)).body;
      assertEquals(await refusedDial(ticket), "refused");
    }
    assertEquals(warned.length, 1);
    assertEquals(warned[0].folded, 0);
    now += 10_000;
    const { ticket } = (await t.register("r-1", 5173)).body;
    assertEquals(await refusedDial(ticket), "refused");
    assertEquals(warned.map((fields) => fields.folded), [0, 2]);
    // The ticket still dials once the runner speaks the framing.
    const framed = new WebSocket(`ws://127.0.0.1:${port}/tunnel/${ticket}`, TUNNEL_PROTOCOL);
    await new Promise<void>((resolve, reject) => {
      framed.onopen = () => resolve();
      framed.onerror = () => reject(new Error("refused"));
    });
    assertEquals(framed.protocol, TUNNEL_PROTOCOL);
    framed.close();
  } finally {
    await t.stop();
  }
});

/** Waits until what `sample` measures is all above zero and has stopped changing (the viewers'
 * windows full): the same twice 200 ms apart, at most 10 s. */
async function settled(sample: () => number[]) {
  let last = "";
  for (let i = 0; i < 50; i++) {
    const values = sample();
    const now = JSON.stringify(values);
    if (now === last && values.every((value) => value > 0)) return;
    last = now;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * A hostile run's preview: its runner end answers every stream with an endless body and sends a
 * full frame on every ack, and `viewers` connections ask for it and never read a byte. It is the
 * run's `listed`th preview. With `answering`, only the first that many streams are answered at
 * once; `answer(n)` answers n more of the rest.
 */
async function hostilePreview(
  t: Awaited<ReturnType<typeof setup>>,
  runId: string,
  port: number,
  viewers: number,
  listed: number,
  answering = Infinity,
) {
  const { id, ticket } = (await t.register(runId, port)).body;
  const tunnelPort = t.tunnelPort;
  const ws = new WebSocket(`ws://127.0.0.1:${tunnelPort}/tunnel/${ticket}`, TUNNEL_PROTOCOL);
  ws.binaryType = "arraybuffer";
  const frame = (stream: number, bytes: Uint8Array) => {
    const out = new Uint8Array(4 + bytes.byteLength);
    new DataView(out.buffer).setUint32(0, stream);
    out.set(bytes, 4);
    return out;
  };
  const head = new TextEncoder().encode("HTTP/1.1 200 OK\r\ncontent-length: 100000000000\r\n\r\n");
  const body = new Uint8Array(MAX_FRAME).fill(66);
  const unanswered: number[] = [];
  ws.onmessage = ({ data }) => {
    if (typeof data !== "string") {
      // A stream held back takes its request, so it holds nothing until it is answered.
      const stream = new DataView(data as ArrayBuffer).getUint32(0);
      if (unanswered.includes(stream)) ws.send(JSON.stringify({ ack: stream }));
      return;
    }
    const signal = JSON.parse(data) as Record<string, number>;
    if (signal.open !== undefined) {
      if (answering-- > 0) ws.send(frame(signal.open, head));
      else unanswered.push(signal.open);
    } else if (signal.ack !== undefined) ws.send(frame(signal.ack, body));
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("tunnel refused"));
  });
  await t.listed(runId, listed);
  const cookie = await t.enter(runId, id);
  const sockets: Socket[] = [];
  for (let i = 0; i < viewers; i++) {
    const socket = connect({ host: "127.0.0.1", port: t.publicPort });
    socket.on("error", () => {});
    socket.write(`GET /big${i} HTTP/1.1\r\nhost: ${t.host(id)}\r\ncookie: ${cookie}\r\n\r\n`);
    socket.pause();
    sockets.push(socket);
  }
  return {
    answer(n: number) {
      for (const one of unanswered.splice(0, n)) ws.send(frame(one, head));
    },
    close() {
      for (const socket of sockets) socket.destroy();
      ws.close();
    },
  };
}

test("previews: hostile runs hold their caps and no more, and an honest page still loads", async () => {
  const dev = await devServer();
  // Room for three runs at their caps: two hostile ones, and the honest one's page beside them.
  const streams = 3 * PER_RUN.open;
  const t = await setup({ streams });
  const hostile: { close(): void }[] = [];
  let peak = 0;
  const sampler = setInterval(() => peak = Math.max(peak, t.service.budget.open), 5);
  try {
    // Two runs of two previews, 48 viewers each: half as much again as a run may hold.
    for (const runId of ["bad-1", "bad-2"]) {
      hostile.push(await hostilePreview(t, runId, 5001, 48, 1));
      hostile.push(await hostilePreview(t, runId, 5002, 48, 2));
    }
    const capped = () =>
      ["bad-1", "bad-2"].every((runId) => t.service.budget.openBy(runId) === PER_RUN.open);
    for (let i = 0; i < 200 && !capped(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(capped(), `${t.service.budget.open} of ${streams} open`);

    // A page of 150 modules, all at once, and every one of them served.
    const { id, url, ticket } = (await t.register("good", dev.addr.port, [])).body;
    await t.dial(ticket, dev.addr.port);
    await t.listed("good", 1);
    const cookie = await t.enter("good", id);
    const headers = { host: t.host(id), cookie, origin: url, "sec-fetch-site": "same-origin" };
    const replies = await Promise.all(
      Array.from({ length: 150 }, (_, i) => t.hit(`/module-${i}.js`, headers)),
    );
    assertEquals(replies.map((r) => r.status), replies.map(() => 200));
    // The hostile runs never held more than their caps, nor all of them together the pod's.
    assert(peak <= streams, `${peak} of ${streams} open`);
    for (const runId of ["bad-1", "bad-2"]) {
      assertEquals(t.service.budget.openBy(runId), PER_RUN.open);
    }
  } finally {
    clearInterval(sampler);
    for (const one of hostile) one.close();
    await t.stop();
    await dev.shutdown();
  }
});

test("previews: an upload paused in line is counted to its run as what it holds, read here and the kernel's, while it waits", async () => {
  const dev = await devServer();
  // One stream for the pod: an SSE stream holds it, and the upload waits in line.
  const t = await setup({ streams: 1 });
  const sockets: Socket[] = [];
  try {
    const { id, url, ticket } = (await t.register("r-1", dev.addr.port)).body;
    await t.dial(ticket, dev.addr.port);
    await t.listed("r-1", 1);
    const cookie = await t.enter("r-1", id);
    const headers = `host: ${
      t.host(id)
    }\r\ncookie: ${cookie}\r\norigin: ${url}\r\nsec-fetch-site: same-origin\r\n`;
    const viewer = connect({ host: "127.0.0.1", port: t.publicPort });
    sockets.push(viewer);
    viewer.on("error", () => {});
    const first = new Promise<void>((resolve) => viewer.once("data", () => resolve()));
    viewer.write(`GET /forever HTTP/1.1\r\n${headers}\r\n`);
    await first;
    const length = 4 * 1024 * 1024;
    const upload = connect({ host: "127.0.0.1", port: t.publicPort });
    sockets.push(upload);
    upload.on("error", () => {});
    upload.write(`POST /echo HTTP/1.1\r\n${headers}content-length: ${length}\r\n\r\n`);
    upload.write(new Uint8Array(length));
    const held = () => t.service.early.pausedByGroup().get("r-1") ?? 0;
    for (let i = 0; i < 300 && t.service.budget.waiting < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(t.service.budget.waiting, 1);
    // What came with its headers and the read its paused socket took are counted beside the
    // kernel's buffer (RECEIVE_BUFFER), asked as the guard samples: more than the buffer alone,
    // never the whole upload.
    for (let i = 0; i < 300 && held() <= RECEIVE_BUFFER; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(held() > RECEIVE_BUFFER && held() < length, `${held()} counted`);
    assertEquals(t.service.early.pausedLarge("r-1"), 1);
    // The stream frees and the upload goes on: nothing is counted any more.
    viewer.destroy();
    for (let i = 0; i < 300 && held() > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(t.service.early.pausedByGroup().size, 0);
    assertEquals(t.service.early.pausedLarge("r-1"), 0);
    assertEquals(t.service.budget.waiting, 0);
  } finally {
    for (const one of sockets) one.destroy();
    await t.stop();
    await dev.shutdown();
  }
});

test("previews: a drain cuts a request still in flight after a moment, and the tunnels go", async () => {
  const dev = await devServer();
  const t = await setup();
  try {
    const { id, url, ticket } = (await t.register("r-1", dev.addr.port)).body;
    const runner = await t.dial(ticket, dev.addr.port);
    await t.listed("r-1", 1);
    const cookie = await t.enter("r-1", id);
    // A viewer holding an SSE stream open through the preview.
    const viewer = connect({ host: "127.0.0.1", port: t.publicPort });
    viewer.on("error", () => {});
    const first = new Promise<void>((resolve) => viewer.once("data", () => resolve()));
    const closed = new Promise<void>((resolve) => viewer.on("close", () => resolve()));
    viewer.write(
      `GET /forever HTTP/1.1\r\nhost: ${t.host(id)}\r\ncookie: ${cookie}\r\norigin: ${url}\r\n` +
        "sec-fetch-site: same-origin\r\n\r\n",
    );
    await first;
    // The drain does not wait on it past the grace: the listeners' gap stays a moment long.
    const started = Date.now();
    await t.service.shutdownPublic();
    const took = Date.now() - started;
    // Well short of the drain deadline (25 s), however slow the machine running this is.
    assert(took >= DRAIN_GRACE_MS - 50 && took < 10_000, `took ${took} ms`);
    await closed;
    // And the tunnels close right after, so the runner re-registers at once.
    t.service.close();
    await runner.closed;
  } finally {
    await t.stop();
    await dev.shutdown();
  }
});

test("previews: a preview between tunnels is a moment's 503, an unknown one a 404 that reloads, an ended one a 404 that does not", async () => {
  const dev = await devServer();
  const t = await setup();
  try {
    const { id, url, ticket } = (await t.register("r-1", dev.addr.port)).body;
    const runner = await t.dial(ticket, dev.addr.port);
    await t.listed("r-1", 1);
    const cookie = await t.enter("r-1", id);
    const headers = { host: t.host(id), cookie, origin: url, "sec-fetch-site": "same-origin" };
    // The runner re-registers (its tunnel dropped), and has not dialled yet.
    assertEquals((await t.register("r-1", dev.addr.port)).status, 201);
    runner.ws.close();
    await runner.closed;
    await t.listed("r-1", 0);
    const moving = await t.hit("/", headers);
    assertEquals(moving.status, 503);
    assertMatch(moving.body, /This preview will be back in a moment\./);
    // Only a page load reloads itself; a fetch is the page's own to retry.
    assert(!moving.body.includes("refresh"));
    const reloads = await t.hit("/", { ...headers, ...NAVIGATE, "sec-fetch-site": "none" });
    assertEquals(reloads.status, 503);
    // A whole number of seconds in RETRY_S's range, so tabs sent away do not come back at once.
    const after = Number(/<meta http-equiv="refresh" content="(\d+)">/.exec(reloads.body)?.[1]);
    assert(after >= RETRY_S.min && after <= RETRY_S.max, reloads.body);
    assertEquals(await t.upgrade(headers), 503);
    // A preview nobody holds, to someone holding its cookie: a run that ended, or one not yet
    // re-registered after a restart.
    const gone = "0".repeat(32);
    const unknown = await t.hit("/", {
      host: t.host(gone),
      cookie: `${HTTP_COOKIE}=${await viewerCookie(await keys(TOKEN), gone, Date.now())}`,
      ...NAVIGATE,
    });
    assertEquals(unknown.status, 404);
    assertMatch(unknown.body, /This preview isn't available\. If its run is still going/);
    assertMatch(unknown.body, /http-equiv="refresh"/);
    // A run the control plane said ended: its previews say so, and never reload, page load or not.
    const ended = (await t.register("r-2", dev.addr.port)).body;
    await t.dial(ended.ticket, dev.addr.port);
    await t.listed("r-2", 1);
    const endedCookie = await t.enter("r-2", ended.id);
    assertEquals((await t.call("DELETE", "/internal/runs/r-2")).status, 204);
    for (const extra of [NAVIGATE, {}]) {
      const over = await t.hit("/", { host: t.host(ended.id), cookie: endedCookie, ...extra });
      assertEquals(over.status, 404);
      assertMatch(over.body, /This preview has ended\./);
      assert(!over.body.includes("refresh"));
    }
    // The expired-link page never reloads: the same link would only expire again.
    const expired = await t.hit("/__ryph/enter?ticket=nope", { host: t.host(id), ...NAVIGATE });
    assertEquals(expired.status, 403);
    assert(!expired.body.includes("refresh"));
  } finally {
    await t.stop();
    await dev.shutdown();
  }
});

test("previews: a page's short requests are served while its tunnel holds every socket it may", async () => {
  const dev = await devServer();
  const t = await setup();
  const sockets: Socket[] = [];
  try {
    const { id, url, ticket } = (await t.register("r-1", dev.addr.port)).body;
    await t.dial(ticket, dev.addr.port);
    await t.listed("r-1", 1);
    const cookie = await t.enter("r-1", id);
    /** A WebSocket held open; resolves once the 101 is back, or with what came instead. */
    const socketOpen = () => {
      const socket = connect({ host: "127.0.0.1", port: t.publicPort });
      socket.on("error", () => {});
      sockets.push(socket);
      let answer = "";
      const answered = new Promise<string>((resolve) =>
        socket.on("data", (chunk) => {
          answer += chunk;
          resolve(answer.split("\r\n")[0]);
        })
      );
      socket.write(
        `GET /hmr HTTP/1.1\r\nhost: ${t.host(id)}\r\ncookie: ${cookie}\r\norigin: ${url}\r\n` +
          "connection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\n" +
          "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
      return answered;
    };
    // A Jupyter page in a few tabs: as many sockets as the run lets long-lived streams hold.
    const long = PER_RUN.long;
    const opened = await Promise.all(Array.from({ length: long }, socketOpen));
    assert(opened.every((line) => line.startsWith("HTTP/1.1 101")), opened.join(", "));
    // As many more as would fill the tunnel wait for one of them to go.
    const more: string[] = [];
    const waiting = Array.from(
      { length: PER_RUN.open - long },
      () => socketOpen().then((line) => more.push(line)),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assertEquals(more, []);
    // Meanwhile the page's saves and API calls are served, many at once.
    const headers = { host: t.host(id), cookie, origin: url, "sec-fetch-site": "same-origin" };
    const replies = await Promise.all(
      Array.from({ length: 48 }, (_, i) => t.hit(`/api/${i}`, headers)),
    );
    assertEquals(replies.map((r) => r.status), replies.map(() => 200));
    sockets[0].destroy();
    await Promise.race(waiting);
    assertEquals(more.length, 1);
    assertMatch(more[0], /^HTTP\/1\.1 101/);
  } finally {
    for (const socket of sockets) socket.destroy();
    await t.stop();
    await dev.shutdown();
  }
});

test("previews: a browser's WebSocket upload its runner stops acking holds a read or two, not the upload", async () => {
  // Bun's own upgraded sockets read on past a `pause()` without bound (docs/runtime.md, Bun bugs);
  // the public listener's front (`frontHttpServer`) is what holds this to a read or two.
  const t = await setup();
  const sockets: Socket[] = [];
  try {
    const { id, url, ticket } = (await t.register("r-1", 5001)).body;
    // A runner that answers the upgrade and then never acks what the browser sends.
    const ws = new WebSocket(`ws://127.0.0.1:${t.tunnelPort}/tunnel/${ticket}`, TUNNEL_PROTOCOL);
    ws.binaryType = "arraybuffer";
    const switching = new TextEncoder().encode(
      "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
    );
    ws.onmessage = ({ data }) => {
      if (typeof data !== "string") return;
      const signal = JSON.parse(data) as Record<string, number>;
      if (signal.open === undefined) return;
      const frame = new Uint8Array(4 + switching.byteLength);
      new DataView(frame.buffer).setUint32(0, signal.open);
      frame.set(switching, 4);
      ws.send(frame);
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("tunnel refused"));
    });
    await t.listed("r-1", 1);
    const cookie = await t.enter("r-1", id);
    let upgraded: Socket | undefined;
    t.service.public.on("upgrade", (_req, socket: Socket) => upgraded = socket);
    const browser = connect({ host: "127.0.0.1", port: t.publicPort });
    browser.on("error", () => {});
    sockets.push(browser);
    const answered = new Promise<string>((resolve) =>
      browser.once("data", (chunk) => resolve(String(chunk).split("\r\n")[0]))
    );
    browser.write(
      `GET /hmr HTTP/1.1\r\nhost: ${t.host(id)}\r\ncookie: ${cookie}\r\norigin: ${url}\r\n` +
        "connection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\n" +
        "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    assertMatch(await answered, /^HTTP\/1\.1 101/);
    // Uploads as fast as the pod takes them, for a second.
    const batch = new Uint8Array(1024 * 1024).fill(1);
    let sent = 0;
    const pump = () => {
      while (!browser.destroyed && sent < 2 ** 32) {
        sent += batch.byteLength;
        if (!browser.write(batch)) return void browser.once("drain", pump);
      }
    };
    pump();
    let peak = 0;
    const until = Date.now() + 1_000;
    while (Date.now() < until && peak <= 64 * 2 ** 20) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      peak = Math.max(peak, upgraded?.readableLength ?? 0);
    }
    assert(upgraded !== undefined);
    // The runner has acked nothing: past its window, what the pod holds of the upload is the
    // socket's buffer, one read (512 KiB at most) or two.
    assert(
      peak <= 2 * 2 ** 20,
      `${(peak / 2 ** 20).toFixed(1)} MiB held of ${sent / 2 ** 20} sent`,
    );
    ws.close();
  } finally {
    for (const socket of sockets) socket.destroy();
    await t.stop();
  }
});

test("previews: the public listener keeps an idle connection past the load balancer's reuse", async () => {
  const t = await setup();
  try {
    // A Google Cloud load balancer reuses an idle backend connection for up to 600 s; node's 5 s
    // default would close it first, an empty 502 nobody logs.
    assertEquals(t.service.public.keepAliveTimeout, DEFAULT_KEEP_ALIVE_MS);
    assert(DEFAULT_KEEP_ALIVE_MS > 600_000);
    assertEquals(t.service.peer, null);
    // Each listener has a hard ceiling on its connections, and no request timeout of its own.
    assertEquals(t.service.public.maxConnections, PUBLIC_MAX);
    assertEquals(t.service.tunnel.maxConnections, TUNNEL_MAX);
    assertEquals(t.service.api.maxConnections, API_MAX);
    for (const listener of [t.service.public, t.service.tunnel, t.service.api]) {
      assertEquals(listener.requestTimeout, 0);
    }
  } finally {
    await t.stop();
  }
});

/** A request on a connection of its own: a pooled one may have been closed as idle. */
function fresh(port: number, path: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers, agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A memory reading the test sets, against a limit of 1000 bytes: HIGH at 750, CRITICAL at 900. */
function memory(limit = 1000) {
  const reading = { used: 0 };
  return {
    reading,
    option: {
      source: { kind: "rss" as const, limit, used: () => reading.used },
      gc: null,
    },
  };
}

function logs() {
  const warned: { event: string; fields?: Record<string, unknown> }[] = [];
  const log: PreviewsLog = {
    info() {},
    warn: (event, fields) => warned.push({ event, fields }),
  };
  return { warned, log };
}

test("previews: at CRITICAL the pod lets nothing new in, closes long-idle connections once, and recovers", async () => {
  const dev = await devServer();
  const m = memory();
  const { warned, log } = logs();
  let skew = 0;
  const t = await setup({ memory: m.option, log, now: () => Date.now() + skew });
  /** A keep-alive connection that served one request and now sits idle, as a balancer keeps. */
  const idle = async (headers: Record<string, string>) => {
    const one = connect({ host: "127.0.0.1", port: t.publicPort });
    one.on("error", () => {});
    const closed = new Promise<void>((resolve) => one.once("close", () => resolve()));
    one.write(`GET /x HTTP/1.1\r\nhost: ${headers.host}\r\ncookie: ${headers.cookie}\r\n\r\n`);
    await new Promise((resolve) => one.once("data", resolve));
    let gone = false;
    void closed.then(() => gone = true);
    return { one, closed, gone: () => gone };
  };
  try {
    t.service.guard!.stop();
    const { id, url, ticket } = (await t.register("r-1", dev.addr.port)).body;
    await t.dial(ticket, dev.addr.port);
    await t.listed("r-1", 1);
    const cookie = await t.enter("r-1", id);
    const headers = { host: t.host(id), cookie, origin: url, "sec-fetch-site": "same-origin" };
    assertEquals((await fresh(t.publicPort, "/a", headers)).status, 200);
    const old = await idle(headers);
    skew += PRESSURE_IDLE_MS - 5_000;
    // Idle for less than PRESSURE_IDLE_MS: a balancer may be about to reuse it.
    const recent = await idle(headers);
    skew += 5_000;

    m.reading.used = 950;
    assertEquals(t.service.guard!.check(), "critical");
    await old.closed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(!recent.gone(), "a connection idle for less than PRESSURE_IDLE_MS was closed");
    // Once an episode: idle long enough by now, it is not closed while the episode lasts.
    skew += PRESSURE_IDLE_MS;
    t.service.guard!.check();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(!recent.gone(), "idle connections were closed twice in one episode");
    // Nothing new gets a stream, and nothing waits for one: a page load is told to come back.
    assertEquals((await fresh(t.publicPort, "/b", headers)).status, 503);
    const load = await fresh(t.publicPort, "/", {
      ...headers,
      ...NAVIGATE,
      "sec-fetch-site": "none",
    });
    assertEquals(load.status, 503);
    assertMatch(load.body, /This preview will be back in a moment\./);
    assertMatch(load.body, /http-equiv="refresh"/);
    assert(
      warned.some((w) =>
        w.event === "preview.refused" && w.fields?.cap === "memory-critical" &&
        w.fields?.reason === "memory" && w.fields?.runId === "r-1"
      ),
      JSON.stringify(warned),
    );
    assert(
      warned.some((w) => w.event === "previews.memory.pressure" && w.fields?.level === "critical"),
    );

    m.reading.used = 100;
    assertEquals(t.service.guard!.check(), "normal");
    assertEquals((await fresh(t.publicPort, "/c", headers)).status, 200);
    // The next episode closes it.
    m.reading.used = 950;
    t.service.guard!.check();
    await recent.closed;
    m.reading.used = 100;
    t.service.guard!.check();
    // What the periodic line says, with nothing of a request in it.
    const stats = t.service.stats();
    assertEquals(stats.level, "normal");
    assertEquals(stats.memoryMiB, 0);
    assertEquals(stats.source, "rss");
    assertEquals(stats.previews, 1);
    for (
      const key of [
        "rssMiB",
        "heapMiB",
        "attributedMiB",
        "earlyMiB",
        "open",
        "long",
        "relayed",
        "waiting",
        "publicConnections",
      ]
    ) {
      assertEquals(typeof stats[key], "number", key);
    }
  } finally {
    await t.stop();
    await dev.shutdown();
  }
});

test("previews: near the limit the streams holding the most unread bytes are closed, and said so", async () => {
  const m = memory();
  const { warned, log } = logs();
  const t = await setup({ memory: m.option, log });
  const hostile: { close(): void }[] = [];
  try {
    // Eight viewers that never read endless answers.
    hostile.push(await hostilePreview(t, "bad", 5001, 8, 1));
    for (let i = 0; i < 200 && t.service.budget.openBy("bad") < 8; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(t.service.budget.openBy("bad"), 8);
    m.reading.used = 950;
    // Until their bytes back up into the streams, there is nothing to shed; then the biggest go,
    // a quarter of the open streams at most per sample.
    for (let i = 0; i < 200 && t.service.budget.open === 8; i++) {
      t.service.guard!.check();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(t.service.budget.open < 8, `${t.service.budget.open} open`);
    const shed = warned.filter((w) => w.event === "previews.memory.shed");
    assert(shed.length > 0, JSON.stringify(warned));
    for (const one of shed) {
      // In MiB, as every other memory line says it: 200 bytes is none.
      assertEquals(one.fields!.overMiB, 0);
      // A quarter of the open streams at most, per sample.
      assert((one.fields!.closed as number) <= 2);
    }
    assert(
      warned.some((w) => w.event === "preview.refused" && w.fields?.cap === "memory-critical"),
    );
  } finally {
    for (const one of hostile) one.close();
    await t.stop();
  }
});

test("previews: a preview dropped just before its run ended says it ended", async () => {
  const dev = await devServer();
  const t = await setup();
  try {
    const k = await keys(TOKEN);
    // A runner that went away as its run ended: the tunnel closes first, then the control plane
    // says the run is over.
    const { id, ticket } = (await t.register("r-1", dev.addr.port)).body;
    const runner = await t.dial(ticket, dev.addr.port);
    await t.listed("r-1", 1);
    runner.ws.close();
    await runner.closed;
    await t.listed("r-1", 0);
    assertEquals((await t.call("DELETE", "/internal/runs/r-1")).status, 204);
    const cookie = `${HTTP_COOKIE}=${await viewerCookie(k, id, Date.now())}`;
    const over = await t.hit("/", { host: t.host(id), cookie, ...NAVIGATE });
    assertEquals(over.status, 404);
    assertMatch(over.body, /This preview has ended\./);

    // A registration turned away at the run's limit leaves an ended preview ended.
    const first = (await t.register("r-2", 3001)).body.id;
    for (const port of [3002, 3003, 3004]) {
      assertEquals((await t.register("r-2", port)).status, 201);
    }
    assertEquals((await t.call("DELETE", "/internal/runs/r-2")).status, 204);
    for (const port of [3005, 3006, 3007, 3008]) {
      assertEquals((await t.register("r-2", port)).status, 201);
    }
    assertEquals((await t.register("r-2", 3001)).status, 429);
    const still = await t.hit("/", {
      host: t.host(first),
      cookie: `${HTTP_COOKIE}=${await viewerCookie(k, first, Date.now())}`,
      ...NAVIGATE,
    });
    assertMatch(still.body, /This preview has ended\./);
  } finally {
    await t.stop();
    await dev.shutdown();
  }
});

/** A runner's tunnel dialled by hand on a raw socket: whatever it is sent after the 101 is kept,
 * and it answers nothing (not even a close). */
const closedWithin = (closed: Promise<void>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    closed,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`still open after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

async function rawTunnel(t: Awaited<ReturnType<typeof setup>>, ticket: string) {
  const socket = connect({ host: "127.0.0.1", port: t.tunnelPort });
  socket.on("error", () => {});
  await new Promise((resolve) => socket.once("connect", resolve));
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.write(
    `GET /tunnel/${ticket} HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: Upgrade\r\n` +
      `sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
      `sec-websocket-protocol: ${TUNNEL_PROTOCOL}\r\n\r\n`,
  );
  let head = "";
  const after: number[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.on("data", (chunk: Uint8Array) => {
      if (head.includes("\r\n\r\n")) {
        after.push(...chunk);
        return;
      }
      head += new TextDecoder().decode(chunk);
      if (head.includes("\r\n\r\n")) resolve();
    });
    socket.once("close", () => reject(new Error(`tunnel refused: ${head}`)));
  });
  assertMatch(head, /^HTTP\/1\.1 101 /);
  return { socket, closed, after };
}

test("previews: a tunnel that floods pings is cut at once, and never answered", async () => {
  const t = await setup();
  try {
    const { ticket } = (await t.register("r-1", 3001)).body;
    const raw = await rawTunnel(t, ticket);
    await t.listed("r-1", 1);
    // Masked, empty pings; each would otherwise queue a pong nobody reads.
    const ping = [0x89, 0x80, 0, 0, 0, 0];
    raw.socket.write(new Uint8Array(Array.from({ length: 20_000 }, () => ping).flat()));
    await raw.closed;
    assertEquals(raw.after, [], "nothing was sent back, not even a close frame");
    await t.listed("r-1", 0);
    // A pong nobody asked for is as broken.
    const again = await rawTunnel(t, (await t.register("r-1", 3001)).body.ticket);
    again.socket.write(new Uint8Array([0x8a, 0x80, 0, 0, 0, 0]));
    await again.closed;
  } finally {
    await t.stop();
  }
});

test("previews: a tunnel that fragments a message is cut at its second frame, a flood of empty ones included", async () => {
  const t = await setup();
  try {
    // A masked frame, its mask all zeros.
    const frame = (fin: boolean, opcode: number, payload: number[]) => [
      (fin ? 0x80 : 0) | opcode,
      0x80 | payload.length,
      0,
      0,
      0,
      0,
      ...payload,
    ];
    const first = frame(false, 2, [0, 0, 0, 0]);
    // One continuation: the first fragment alone is held, and the next frame of it ends the
    // tunnel.
    const one = await rawTunnel(t, (await t.register("r-1", 3001)).body.ticket);
    await t.listed("r-1", 1);
    one.socket.write(new Uint8Array(first));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await t.listed("r-1", 1);
    // Not the last of it either: nothing the mux would ever see.
    one.socket.write(new Uint8Array(frame(false, 0, [1])));
    await closedWithin(one.closed, 2_000);
    await t.listed("r-1", 0);
    // A thousand empty continuations in one write, never finished: cut at the first, the rest
    // never parsed.
    const flood = await rawTunnel(t, (await t.register("r-1", 3001)).body.ticket);
    await t.listed("r-1", 1);
    const empty = frame(false, 0, []);
    flood.socket.write(
      new Uint8Array([...first, ...Array.from({ length: 1_000 }, () => empty).flat()]),
    );
    await closedWithin(flood.closed, 2_000);
    await t.listed("r-1", 0);
  } finally {
    await t.stop();
  }
});

test("previews: a runner flooding at line rate is cut off with no more than a read of it taken", async () => {
  // Bun ignores pause() on a node:http-upgraded socket and reads on (measured: 6–8 GB in 1.5 s
  // behind a paused tunnel). The tunnel path never relies on it: each read is parsed whole as it
  // arrives and the first message refused ends the tunnel, so what the runner gets written before
  // it is cut is a read (512 KiB on Bun) and the kernel's buffers, never what a paused socket
  // would have taken.
  const t = await setup();
  try {
    const raw = await rawTunnel(t, (await t.register("r-1", 3001)).body.ticket);
    await t.listed("r-1", 1);
    // A masked binary frame (its mask all zeros) of a full payload, for a stream never opened.
    const length = MAX_FRAME + 4;
    const frame = new Uint8Array(10 + 4 + length);
    frame.set([0x82, 0x80 | 127]);
    new DataView(frame.buffer).setBigUint64(2, BigInt(length));
    const batch = new Uint8Array(16 * frame.byteLength);
    for (let i = 0; i < 16; i++) batch.set(frame, i * frame.byteLength);
    // The runner's heartbeat, which is fine, then the flood.
    const ping = new TextEncoder().encode("ping");
    raw.socket.write(new Uint8Array([0x81, 0x80 | ping.length, 0, 0, 0, 0, ...ping]));
    let written = 0;
    let open = true;
    raw.closed.then(() => open = false);
    const deadline = Date.now() + 3_000;
    while (open && Date.now() < deadline) {
      if (raw.socket.write(batch)) written += batch.byteLength;
      else {
        written += batch.byteLength;
        await new Promise((resolve) => {
          raw.socket.once("drain", resolve);
          raw.socket.once("close", resolve);
        });
      }
    }
    await closedWithin(raw.closed, 2_000);
    assert(written < 64 * 2 ** 20, `${(written / 2 ** 20).toFixed(1)} MiB written before the cut`);
    await t.listed("r-1", 0);
  } finally {
    await t.stop();
  }
});

test("previews: a replaced tunnel is terminated at once, not left closing behind its queue", async () => {
  const dev = await devServer();
  const t = await setup();
  try {
    const { ticket } = (await t.register("r-1", dev.addr.port)).body;
    const old = await rawTunnel(t, ticket);
    await t.listed("r-1", 1);
    const started = Date.now();
    const again = (await t.register("r-1", dev.addr.port)).body;
    await t.dial(again.ticket, dev.addr.port);
    // A graceful close would send a close frame and keep the socket until its peer answered,
    // or for 30 s.
    await old.closed;
    assert(Date.now() - started < 2_000);
    assertEquals(old.after, []);
    await t.listed("r-1", 1);
  } finally {
    await t.stop();
    await dev.shutdown();
  }
});

test("previews: re-registering one port is paced, and a 429 says so", async () => {
  let skew = 0;
  const { warned, log } = logs();
  const t = await setup({ now: () => Date.now() + skew, log });
  try {
    for (let i = 0; i < 4; i++) assertEquals((await t.register("r-1", 3001)).status, 201);
    const paced = await t.register("r-1", 3001);
    assertEquals(paced.status, 429);
    assertEquals(paced.body, { error: "registering too often" });
    assert(warned.some((w) => w.event === "preview.refused" && w.fields?.cap === "register"));
    // Another port of the run, and another run, are not held back by it.
    assertEquals((await t.register("r-1", 3002)).status, 201);
    assertEquals((await t.register("r-2", 3001)).status, 201);
    // One more every couple of seconds.
    skew += 2_000;
    assertEquals((await t.register("r-1", 3001)).status, 201);
    assertEquals((await t.register("r-1", 3001)).status, 429);
  } finally {
    await t.stop();
  }
});

test("previews: a port's refused registrations spend none of its run's", async () => {
  const at = Date.now();
  const t = await setup({ now: () => at });
  try {
    for (let i = 0; i < 4; i++) assertEquals((await t.register("r-1", 3001)).status, 201);
    for (let i = 0; i < 50; i++) assertEquals((await t.register("r-1", 3001)).status, 429);
    // The run's burst (16) less the four its first port took is all there for its other ports.
    for (const port of [3002, 3003, 3004]) {
      for (let i = 0; i < 4; i++) assertEquals((await t.register("r-1", port)).status, 201);
    }
    const spent = await t.register("r-1", 3005);
    assertEquals([spent.status, spent.body], [429, { error: "registering too often" }]);
  } finally {
    await t.stop();
  }
});

test("previews: dials refused with a valid ticket leave no trusted connection behind", async () => {
  const dev = await devServer();
  const t = await setup();
  const dials: Socket[] = [];
  const trusted = () => {
    const stats = t.service.stats();
    return (stats.tunnelConnections as number) - (stats.untrustedConnections as number);
  };
  try {
    const { ticket } = (await t.register("r-1", dev.addr.port)).body;
    const before = trusted();
    // One run, its own ticket, dialling again and again with a subprotocol the service refuses
    // (the ticket stays unspent), never hanging up.
    const tunnelPort = t.tunnelPort;
    for (let i = 0; i < UNTRUSTED_TOTAL + 40; i++) {
      const one = connect({ host: "127.0.0.1", port: tunnelPort });
      one.on("error", () => {});
      dials.push(one);
      await new Promise((resolve) => one.once("connect", resolve));
      one.write(
        `GET /tunnel/${ticket} HTTP/1.1\r\nhost: x\r\nconnection: Upgrade\r\n` +
          "upgrade: websocket\r\nsec-websocket-version: 13\r\n" +
          "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-protocol: other\r\n\r\n",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(trusted(), before);
    assert((t.service.stats().untrustedConnections as number) <= UNTRUSTED_PER_ADDRESS);
    // Each refusal closes its connection after a moment's grace; the control plane and the
    // runner, dialling properly with the same ticket, get through.
    for (let i = 0; i < 300 && (t.service.stats().untrustedConnections as number) > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals((await t.call("GET", "/internal/runs/r-1/previews")).status, 200);
    await t.dial(ticket, dev.addr.port);
    await t.listed("r-1", 1);
    assertEquals(trusted(), before + 1);
  } finally {
    for (const one of dials) one.destroy();
    await t.stop();
    await dev.shutdown();
  }
});

test("previews: a flood of silent connections to the tunnel listener never reaches the control plane's calls", async () => {
  const dev = await devServer();
  const t = await setup();
  const silent: Socket[] = [];
  let flooding = true;
  try {
    // A run opening connections to the tunnel listener as fast as it can and saying nothing, for
    // as long as the control plane works: its calls are on the API listener, which no run reaches,
    // and every one of them is answered.
    let gone = 0;
    let opened = 0;
    const flood = (async () => {
      while (flooding) {
        opened++;
        const one = connect({ host: "127.0.0.1", port: t.tunnelPort });
        one.on("error", () => {});
        one.once("close", () => gone++);
        silent.push(one);
        await new Promise((resolve) => one.once("connect", resolve));
      }
    })();
    const { ticket } = (await t.register("r-1", dev.addr.port)).body;
    for (let calls = 0; calls < 20 || opened < UNTRUSTED_PER_ADDRESS + 40; calls++) {
      assertEquals((await t.call("GET", "/internal/runs/r-1/previews")).status, 200);
    }
    flooding = false;
    await flood;
    // The kernel finishes handshakes before the listener takes them, so the caps close the excess
    // only as it is accepted.
    for (let i = 0; i < 300 && gone === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(gone > 0, "the flood was never held to its caps");
    assert((t.service.stats().untrustedConnections as number) <= UNTRUSTED_PER_ADDRESS);
    // The runner dials once the flood stops (one address here; compose's gate is one too, where a
    // flood can keep the others' dials out while it lasts: memory_test says how).
    await t.dial(ticket, dev.addr.port);
    await t.listed("r-1", 1);
  } finally {
    flooding = false;
    for (const one of silent) one.destroy();
    await t.stop();
    await dev.shutdown();
  }
});

test.skipIf(!BUFFERS_CAPPED)(
  "previews: at HIGH only culprits whose bytes explain the growth since the baseline are named, lose every stream holding bytes, and are released once quiet",
  async () => {
    const dev = await devServer();
    const MiB = 2 ** 20;
    // A pod small enough that what one run holds here is a real part of it.
    const m = memory(32 * MiB);
    const { warned, log } = logs();
    let skew = 0;
    const t = await setup({ memory: m.option, log, now: () => Date.now() + skew });
    const hostile: { close(): void }[] = [];
    try {
      t.service.guard!.stop();
      const { id, url, ticket } = (await t.register("good", dev.addr.port)).body;
      await t.dial(ticket, dev.addr.port);
      await t.listed("good", 1);
      const cookie = await t.enter("good", id);
      const headers = { host: t.host(id), cookie, origin: url, "sec-fetch-site": "same-origin" };
      // Sixteen viewers that never read endless answers: what one run holds, measured.
      hostile.push(await hostilePreview(t, "bad", 5001, 16, 1));
      const holding = () => t.service.budget.usage().get("bad")?.holding ?? 0;
      for (let i = 0; i < 300 && holding() < 16; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Their windows full: what each holds beyond its parser is what the guard weighs.
      await settled(() => [t.service.budget.usage().get("bad")?.buffered ?? 0]);
      assertEquals(holding(), 16);
      const open = t.service.budget.openBy("bad");
      const refusedBad = () => t.service.budget.acquire("bad", { use: (c) => c.release() });
      const culprits = () => warned.filter((w) => w.event === "previews.memory.culprits");
      const unexplained = () => warned.filter((w) => w.event === "previews.memory.unexplained");

      // A pod that starts pressed has no baseline to measure growth against: nobody is named.
      m.reading.used = 25 * MiB;
      assertEquals(t.service.guard!.check(), "high");
      assertEquals(t.service.pressure(), { level: "high", culprits: [] });
      assertEquals(unexplained().at(-1)?.fields?.baselineMiB, null);

      // Back at normal, it learns what the pod holds unpressed. Then 10 MiB past it, a few MiB of
      // it the runs': growth no run's bytes explain. Naming the largest holder would steer the
      // guard onto whoever is busiest; nobody is named.
      m.reading.used = 18 * MiB;
      assertEquals(t.service.guard!.check(), "normal");
      skew += 10_000;
      m.reading.used = 28 * MiB;
      assertEquals(t.service.guard!.check(), "high");
      assertEquals(t.service.pressure(), { level: "high", culprits: [] });
      const said = unexplained().at(-1)?.fields;
      assertEquals([said?.usedMiB, said?.baselineMiB, said?.overMiB], [28, 18, 10]);
      assert((said?.attributedMiB as number) < 5);
      assertEquals(culprits(), []);
      assertEquals(t.service.budget.openBy("bad"), open);

      // Minutes later the pod sat just under the watermark. The baseline is what it held then, but
      // never more than 2 × HYSTERESIS below HIGH: just past the watermark, the growth since is
      // that much at least, and what the run holds explains it: it is named, and said with what it
      // holds.
      m.reading.used = 22 * MiB;
      assertEquals(t.service.guard!.check(), "normal");
      skew += BASELINE_MS + 1_000;
      m.reading.used = 23.9 * MiB;
      assertEquals(t.service.guard!.check(), "normal");
      assertEquals(t.service.guard!.baseline, t.service.guard!.baselineCapBytes);
      assertEquals(t.service.guard!.baselineCapBytes, Math.floor(32 * MiB * 0.65));
      m.reading.used = 24.2 * MiB;
      assertEquals(t.service.guard!.check(), "high");
      assertEquals(t.service.pressure(), { level: "high", culprits: ["bad"] });
      const named = culprits()[0]?.fields;
      assertEquals(named?.runs, ["bad"]);
      assertEquals([named?.overMiB, named?.baselineMiB], [3, 21]);
      const held = named?.held as { runId: string; heldMiB: number }[];
      assertEquals(held.map((one) => one.runId), ["bad"]);
      assert(held[0].heldMiB >= 2, JSON.stringify(held));
      // The culprit gets nothing new, and loses every stream holding bytes at once; everyone else
      // is served as usual.
      await assertRejects(refusedBad, Error, "preview is busy");
      assertEquals(holding(), 0);
      assert(
        t.service.budget.openBy("bad") <= open - 16,
        "a culprit's stream holding bytes stayed",
      );
      assertEquals((await fresh(t.publicPort, "/a", headers)).status, 200);
      assert(
        warned.some((w) => w.event === "preview.refused" && w.fields?.cap === "memory-high"),
      );
      // Quiet now, it stays a culprit for a while...
      for (const one of hostile.splice(0)) one.close();
      for (let i = 0; i < 100 && t.service.budget.openBy("bad") > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      t.service.guard!.check();
      skew += CULPRIT_RELEASE_MS - 1_000;
      t.service.guard!.check();
      assertEquals(t.service.pressure(), { level: "high", culprits: ["bad"] });
      await assertRejects(refusedBad, Error, "preview is busy");
      // ...and is released once it has held less than CULPRIT_MIN for CULPRIT_RELEASE_MS, still at
      // HIGH.
      skew += 1_000;
      t.service.guard!.check();
      assertEquals(t.service.pressure(), { level: "high", culprits: [] });
      assertEquals(culprits().at(-1)?.fields?.released, 1);
      await refusedBad();
      assertEquals((await fresh(t.publicPort, "/b", headers)).status, 200);
      // Under the high exit: nobody.
      m.reading.used = 18 * MiB;
      assertEquals(t.service.guard!.check(), "normal");
      assertEquals(t.service.pressure(), { level: "normal", culprits: [] });
    } finally {
      for (const one of hostile) one.close();
      await t.stop();
      await dev.shutdown();
    }
  },
);

test("previews: at HIGH, growth the runs' bytes explain but no run holds its share of is said, never silent", async () => {
  const MiB = 2 ** 20;
  const m = memory(32 * MiB);
  const { warned, log } = logs();
  const t = await setup({ memory: m.option, log });
  const hostile: { close(): void }[] = [];
  try {
    t.service.guard!.stop();
    // Just under the watermark: the baseline is capped 2 × HYSTERESIS below it.
    m.reading.used = 23.9 * MiB;
    assertEquals(t.service.guard!.check(), "normal");
    // Five runs, each holding less than CULPRIT_MIN, together enough to explain the growth: three
    // stalled downloads each (three paused videos), some 272 KiB per download with its browser's
    // socket (buffers and kernel send buffer) and parser, ~816 KiB per run. Counting the kernel's buffer twice
    // (measured, and again in STREAM_BYTES) would put each run past CULPRIT_MIN and name them all.
    const runs = ["r-a", "r-b", "r-c", "r-d", "r-e"];
    for (const [i, run] of runs.entries()) {
      hostile.push(await hostilePreview(t, run, 5001 + i, 3, 1));
    }
    const usage = () => t.service.budget.usage();
    await settled(() => runs.map((run) => usage().get(run)?.buffered ?? 0));
    for (const run of runs) {
      const use = usage().get(run)!;
      assertEquals([use.holding, use.overhead], [3, 3 * SERVED_BYTES], run);
      assert(use.buffered + use.overhead < CULPRIT_MIN, `${run}: ${use.buffered}`);
      assert(use.buffered + 3 * STREAM_BYTES >= CULPRIT_MIN, `${run}: ${use.buffered}`);
    }
    m.reading.used = 24.2 * MiB;
    assertEquals(t.service.guard!.check(), "high");
    assertEquals(t.service.pressure(), { level: "high", culprits: [] });
    assertEquals(warned.filter((w) => w.event === "previews.memory.unexplained"), []);
    assertEquals(warned.filter((w) => w.event === "previews.memory.culprits"), []);
    const said = warned.find((w) => w.event === "previews.memory.no_culprit")?.fields;
    assert(said !== undefined, "HIGH named nobody and said nothing");
    assertEquals([said.baselineMiB, said.overMiB, said.holders], [21, 3, runs.length]);
    assert((said.attributedMiB as number) * EXPLAINED >= 3, JSON.stringify(said));
    const largest = said.largest as { runId: string; heldMiB: number };
    assert(runs.includes(largest.runId), JSON.stringify(said));
    assert(largest.heldMiB < CULPRIT_MIN / MiB + 1, JSON.stringify(said));
    // Folded: the next sample says nothing new.
    t.service.guard!.check();
    assertEquals(warned.filter((w) => w.event === "previews.memory.no_culprit").length, 1);
  } finally {
    for (const one of hostile) one.close();
    await t.stop();
  }
});

test.skipIf(!BUFFERS_CAPPED)(
  "previews: at HIGH, a run stalling every stream it may hold is named, each counted once",
  async () => {
    const MiB = 2 ** 20;
    const m = memory(32 * MiB);
    const { warned, log } = logs();
    const t = await setup({ memory: m.option, log });
    const hostile: { close(): void }[] = [];
    try {
      t.service.guard!.stop();
      // Just under the watermark: the baseline is capped 2 × HYSTERESIS below it.
      m.reading.used = 23.9 * MiB;
      assertEquals(t.service.guard!.check(), "normal");
      // Sixty-four viewers that never read endless answers: the run's every stream.
      hostile.push(await hostilePreview(t, "bad", 5001, MAX_STREAMS, 1));
      const usage = () => t.service.budget.usage().get("bad");
      await settled(() => [usage()?.holding === MAX_STREAMS ? usage()!.buffered : 0]);
      const use = usage()!;
      assertEquals([use.holding, use.overhead], [MAX_STREAMS, MAX_STREAMS * SERVED_BYTES]);
      m.reading.used = 24.2 * MiB;
      assertEquals(t.service.guard!.check(), "high");
      assertEquals(t.service.pressure(), { level: "high", culprits: ["bad"] });
      const said = warned.find((w) => w.event === "previews.memory.culprits")?.fields;
      const held = said?.held as { runId: string; heldMiB: number }[];
      assertEquals(held.map((one) => one.runId), ["bad"]);
      // Each holds its window, its browser's socket's buffer and kernel send buffer, and its parser:
      // some 272 KiB, 17 MiB in all (counting the kernel's buffer twice made it 24 MiB).
      assert(held[0].heldMiB >= 16 && held[0].heldMiB < 20, JSON.stringify(said));
      // Relieved: every stream it held goes.
      assertEquals(usage()?.holding ?? 0, 0);
    } finally {
      for (const one of hostile) one.close();
      await t.stop();
    }
  },
);

test("previews: below the watermark, on the way down, a run holding a few MiB is never named", async () => {
  const MiB = 2 ** 20;
  const m = memory(1000 * MiB);
  const t = await setup({ memory: m.option });
  const busy: { close(): void }[] = [];
  try {
    t.service.guard!.stop();
    m.reading.used = 740 * MiB;
    assertEquals(t.service.guard!.check(), "normal");
    // A busy run holding a few MiB of what its viewers have not read yet.
    busy.push(await hostilePreview(t, "busy", 5001, 16, 1));
    const holding = () => t.service.budget.usage().get("busy")?.holding ?? 0;
    for (let i = 0; i < 300 && holding() < 16; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Pressed by memory nobody's bytes explain: nobody.
    m.reading.used = 800 * MiB;
    assertEquals(t.service.guard!.check(), "high");
    assertEquals(t.service.pressure(), { level: "high", culprits: [] });
    // On the way down, between HIGH's exit and its watermark: what was closed has yet to show in
    // the counter, and whatever the runs hold could seem to explain what is left. Nobody new is
    // named there.
    for (const used of [745, 720, 705]) {
      m.reading.used = used * MiB;
      assertEquals(t.service.guard!.check(), "high");
      assertEquals(t.service.pressure(), { level: "high", culprits: [] }, `${used} MiB`);
    }
    assertEquals(holding(), 16);
  } finally {
    for (const one of busy) one.close();
    await t.stop();
  }
});

test.skipIf(!BUFFERS_CAPPED)(
  "previews: right after a culprit is relieved, the next-busiest run is not named while the counter catches up",
  async () => {
    const MiB = 2 ** 20;
    const m = memory(32 * MiB);
    let skew = 0;
    const t = await setup({ memory: m.option, now: () => Date.now() + skew });
    const hostile: { close(): void }[] = [];
    try {
      t.service.guard!.stop();
      // Just under the watermark: the baseline is capped 2 × HYSTERESIS below it.
      m.reading.used = 23.9 * MiB;
      assertEquals(t.service.guard!.check(), "normal");
      // One run holding much, and a busy one holding less, past CULPRIT_MIN but under the mean.
      hostile.push(await hostilePreview(t, "bad", 5001, 40, 1));
      hostile.push(await hostilePreview(t, "busy", 5002, 16, 1));
      const holding = (run: string) => t.service.budget.usage().get(run)?.holding ?? 0;
      for (let i = 0; i < 300 && (holding("bad") < 40 || holding("busy") < 16); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await settled(() =>
        ["bad", "busy"].map((run) => t.service.budget.usage().get(run)?.buffered ?? 0)
      );
      m.reading.used = 24.1 * MiB;
      assertEquals(t.service.guard!.check(), "high");
      assertEquals(t.service.pressure(), { level: "high", culprits: ["bad"] });
      assertEquals(holding("bad"), 0);
      // A second later the counter still says what the pod held before the relief, and the busy
      // run is now everything the runs hold: it would be "the mean", and explain the growth. It is
      // not named while what the relief freed has yet to show.
      for (let i = 1; i < SHED_HOLD_MS / 1_000; i++) {
        skew += 1_000;
        assertEquals(t.service.guard!.check(), "high");
        assertEquals(t.service.pressure(), { level: "high", culprits: ["bad"] }, `${i} s`);
      }
      assert(holding("busy") >= 16);
      // Had the counter not moved by then, it would be (this is what held it back).
      skew += 1_000;
      t.service.guard!.check();
      assertEquals(t.service.pressure(), { level: "high", culprits: ["bad", "busy"] });
    } finally {
      for (const one of hostile) one.close();
      await t.stop();
    }
  },
);

test("previews: a pod held just under HIGH for minutes, then a spike just past it, never names a run holding a little", async () => {
  const MiB = 2 ** 20;
  const m = memory(1000 * MiB);
  const { warned, log } = logs();
  let skew = 0;
  const t = await setup({ memory: m.option, log, now: () => Date.now() + skew });
  const busy: { close(): void }[] = [];
  try {
    t.service.guard!.stop();
    // A busy run holding a few MiB its viewers have not read yet.
    busy.push(await hostilePreview(t, "busy", 5001, 16, 1));
    const holding = () => t.service.budget.usage().get("busy")?.holding ?? 0;
    for (let i = 0; i < 300 && holding() < 16; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Minutes just under the watermark, by memory no run's bytes say (or by slow growth): the
    // least of them is 748 MiB, but the baseline is capped at 650.
    for (let i = 0; i <= BASELINE_MS / 60_000; i++) {
      m.reading.used = (748 + (i % 2)) * MiB;
      assertEquals(t.service.guard!.check(), "normal");
      skew += 60_000;
    }
    assertEquals(t.service.guard!.baseline, 650 * MiB);
    // 2 MiB past the watermark. Measured against 748 MiB, a few MiB of the busy run's would have
    // explained it all; against the cap it is 102 MiB, which they do not.
    m.reading.used = 752 * MiB;
    assertEquals(t.service.guard!.check(), "high");
    assertEquals(t.service.pressure(), { level: "high", culprits: [] });
    const said = warned.filter((w) => w.event === "previews.memory.unexplained").at(-1)?.fields;
    assertEquals([said?.baselineMiB, said?.overMiB], [650, 102]);
    assertEquals(holding(), 16);
  } finally {
    for (const one of busy) one.close();
    await t.stop();
  }
});

test.skipIf(!BUFFERS_CAPPED)(
  "previews: a culprit that has a small stream closed every second does not keep the next one from being named",
  async () => {
    const MiB = 2 ** 20;
    const m = memory(32 * MiB);
    let skew = 0;
    const t = await setup({ memory: m.option, now: () => Date.now() + skew });
    const hostile: { answer(n: number): void; close(): void }[] = [];
    try {
      t.service.guard!.stop();
      m.reading.used = 23.9 * MiB;
      assertEquals(t.service.guard!.check(), "normal");
      // A culprit with forty streams open, twenty-four of them holding bytes and the rest held in
      // reserve; and a second run holding less than the mean while the culprit holds its share.
      const bad = await hostilePreview(t, "bad", 5001, 40, 1, 24);
      hostile.push(bad, await hostilePreview(t, "busy", 5002, 16, 1));
      const usage = (run: string) => t.service.budget.usage().get(run);
      for (
        let i = 0;
        i < 300 && ((usage("bad")?.holding ?? 0) < 24 || (usage("busy")?.holding ?? 0) < 16 ||
          (usage("bad")?.open ?? 0) < 40);
        i++
      ) await new Promise((resolve) => setTimeout(resolve, 10));
      await settled(() => ["bad", "busy"].map((run) => usage(run)?.buffered ?? 0));
      m.reading.used = 24.1 * MiB;
      assertEquals(t.service.guard!.check(), "high");
      assertEquals(t.service.pressure(), { level: "high", culprits: ["bad"] });
      assertEquals(usage("bad")?.holding ?? 0, 0);
      // Every second one of its reserve streams starts holding a little, and is closed: far less
      // than CULPRIT_MIN each time, which renews no hold-off.
      for (let i = 1; i < SHED_HOLD_MS / 1_000; i++) {
        bad.answer(1);
        for (let j = 0; j < 100 && (usage("bad")?.holding ?? 0) < 1; j++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        skew += 1_000;
        assertEquals(t.service.guard!.check(), "high");
        assertEquals(usage("bad")?.holding ?? 0, 0, `${i} s`);
        assertEquals(t.service.pressure(), { level: "high", culprits: ["bad"] }, `${i} s`);
      }
      // The hold-off is over: the busy run, now everything the runs hold, is named.
      skew += 1_000;
      t.service.guard!.check();
      assertEquals(t.service.pressure(), { level: "high", culprits: ["bad", "busy"] });
    } finally {
      for (const one of hostile) one.close();
      await t.stop();
    }
  },
);

test("previews: a run holding a sliver of the growth is not named beside the one holding most of it", () => {
  const MiB = 2 ** 20;
  // Many runs hold a little, so the mean is low: one holds most, another just past the mean.
  const held = new Map<unknown, number>([["bad", 5.5 * MiB], ["busy", 1.1 * MiB]]);
  for (let i = 0; i < 8; i++) held.set(`idle-${i}`, 0.425 * MiB);
  // Twice what they all hold is just past what must be explained: each named must hold its
  // share of half of it, split between the two past the mean.
  assertEquals(culpritsOf(held, 20 * MiB), ["bad"]);
  // Less growth to explain, and both hold their share.
  assertEquals(culpritsOf(held, 4 * MiB), ["bad", "busy"]);
  // More than they explain: nobody.
  assertEquals(culpritsOf(held, 20.1 * MiB), []);
  // Nobody under CULPRIT_MIN, however little must be explained.
  assertEquals(culpritsOf(new Map([["small", 0.9 * MiB]]), 0.1 * MiB), []);
});

test("previews: the last line about the memory level always says the level it is at", async () => {
  const m = memory();
  const { warned, log } = logs();
  let skew = 0;
  const t = await setup({ memory: m.option, log, now: () => Date.now() + skew });
  const levels = () =>
    warned.filter((w) => w.event === "previews.memory.pressure").map((w) => [
      w.fields?.level,
      w.fields?.folded,
    ]);
  try {
    t.service.guard!.stop();
    m.reading.used = 800;
    t.service.guard!.check();
    // Flapping within the window: folded, not said...
    m.reading.used = 950;
    t.service.guard!.check();
    m.reading.used = 800;
    t.service.guard!.check();
    assertEquals(levels(), [["high", 0]]);
    m.reading.used = 950;
    t.service.guard!.check();
    // ...until the window is over, when the next sample says where it stands now.
    skew += 10_000;
    t.service.guard!.check();
    assertEquals(levels(), [["high", 0], ["critical", 3]]);
    // Nothing unsaid: nothing more.
    skew += 10_000;
    t.service.guard!.check();
    assertEquals(levels().length, 2);
    // A change after a quiet window is said at once.
    m.reading.used = 100;
    t.service.guard!.check();
    assertEquals(levels().at(-1), ["normal", 0]);
  } finally {
    await t.stop();
  }
});

test("previews: at HIGH with no culprit nobody is refused", async () => {
  const dev = await devServer();
  const m = memory();
  const t = await setup({ memory: m.option });
  try {
    t.service.guard!.stop();
    const { id, url, ticket } = (await t.register("r-1", dev.addr.port)).body;
    await t.dial(ticket, dev.addr.port);
    await t.listed("r-1", 1);
    const cookie = await t.enter("r-1", id);
    const headers = { host: t.host(id), cookie, origin: url, "sec-fetch-site": "same-origin" };
    // Memory nobody's streams hold: nothing to name, and nothing new is done until CRITICAL.
    m.reading.used = 890;
    assertEquals(t.service.guard!.check(), "high");
    assertEquals(t.service.pressure(), { level: "high", culprits: [] });
    assertEquals((await fresh(t.publicPort, "/a", headers)).status, 200);
    m.reading.used = 900;
    assertEquals(t.service.guard!.check(), "critical");
    assertEquals((await fresh(t.publicPort, "/b", headers)).status, 503);
  } finally {
    await t.stop();
    await dev.shutdown();
  }
});

test("previews: at CRITICAL a shed waits out its hold-off, unless the pod is nearly out", async () => {
  const m = memory();
  let skew = 0;
  const t = await setup({ memory: m.option, now: () => Date.now() + skew });
  const hostile: { close(): void }[] = [];
  try {
    t.service.guard!.stop();
    hostile.push(await hostilePreview(t, "bad", 5001, 8, 1));
    for (let i = 0; i < 200 && t.service.budget.openBy("bad") < 8; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    m.reading.used = 920;
    t.service.guard!.check();
    const after = t.service.budget.open;
    assert(after < 8, `${after} open`);
    // A second later the counter has not caught up with what was freed: nothing more goes.
    skew += 1_000;
    t.service.guard!.check();
    assertEquals(t.service.budget.open, after);
    // Past PANIC it does not wait.
    m.reading.used = 960;
    t.service.guard!.check();
    assert(t.service.budget.open < after);
    const fewer = t.service.budget.open;
    m.reading.used = 920;
    skew += 10_000;
    t.service.guard!.check();
    assert(t.service.budget.open < fewer);
  } finally {
    for (const one of hostile) one.close();
    await t.stop();
  }
});

test("previews: at CRITICAL a minute, the latest shed finding nothing to close, fails /healthz, until that stops holding", async () => {
  const m = memory();
  let skew = 0;
  const errors: string[] = [];
  const t = await setup({
    memory: m.option,
    now: () => Date.now() + skew,
    log: { info() {}, warn() {}, error: (event) => errors.push(event) },
  });
  const health = () => fresh(t.publicPort, "/healthz", { host: `127.0.0.1:${t.publicPort}` });
  try {
    t.service.guard!.stop();
    // HIGH, however long, is not stuck.
    m.reading.used = 800;
    t.service.guard!.check();
    skew += 10 * 60_000;
    t.service.guard!.check();
    assertEquals((await health()).status, 200);

    // Critical, nothing open to shed, for a minute.
    m.reading.used = 950;
    t.service.guard!.check();
    skew += 30_000;
    t.service.guard!.check();
    assertEquals((await health()).status, 200);
    skew += 30_000;
    t.service.guard!.check();
    const stuck = await health();
    assertEquals(stuck.status, 503);
    // Nothing of what the pod is going through.
    assertEquals(stuck.body, "not ok");
    assertEquals(errors, ["previews.memory.stuck"]);
    assertEquals(t.service.stats().stuck, true);
    // Back under the critical exit, still raised: the condition no longer holds.
    m.reading.used = 800;
    t.service.guard!.check();
    assertEquals((await health()).status, 200);
    assertEquals(t.service.stats().stuck, false);
  } finally {
    await t.stop();
  }
});

test("previews: health answers only a request by address, and says ok or not ok", async () => {
  const t = await setup();
  try {
    const probe = (path: string, host: string) => fresh(t.publicPort, path, { host });
    for (const path of ["/healthz", "/readyz"]) {
      const ok = await probe(path, `127.0.0.1:${t.publicPort}`);
      assertEquals([ok.status, ok.body], [200, "ok"], path);
      // Any name under the preview domain is a browser's, never a probe's.
      for (const host of [DOMAIN, `${DOMAIN}:${t.publicPort}`, `anything.${DOMAIN}`]) {
        assertEquals((await probe(path, host)).status, 404, `${path} ${host}`);
      }
    }
  } finally {
    await t.stop();
  }
});

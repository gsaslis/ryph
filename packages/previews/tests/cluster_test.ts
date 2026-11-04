// Several replicas in one process, on loopback, each configured with the others as its peers: what
// the Helm chart's Deployment per ordinal runs, without a cluster. Every call and browser request
// below goes to a pod chosen on purpose — the owner, or one that is not — as the shared Service
// would pick any of them; a runner dials the address its registration names, as it would the
// owner's own Service.
import { test } from "bun:test";
import { assert, assertEquals, assertMatch } from "@std/assert";
import { type IncomingHttpHeaders, request } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { makeHealth, serve } from "@ryph/service";
import {
  Budget,
  type Charge,
  PER_RUN,
  REFUSE_GRACE_MS,
  runnerMux,
  SEND_BUFFER,
  TUNNEL_PROTOCOL,
  WAIT_MS,
} from "@ryph/tunnel";
import { DRAIN_GRACE_MS, type Previews, previews } from "../src/service.ts";
import { PER_RELAY, relay } from "../src/peers.ts";
import {
  CONNECTION_HEADER,
  HOP_HEADER,
  ownerOf,
  type Peer,
  PEER_HEADER,
  WAIT_HEADER,
} from "../src/core/cluster.ts";
import {
  forwardCredential,
  keys,
  peerCredential,
  previewId,
  shardOf,
  viewerCookie,
  viewerTicket,
} from "../src/core/keys.ts";

const TOKEN = "t".repeat(64);
const DOMAIN = "preview.cell.example";
const auth = { authorization: `Bearer ${TOKEN}` };
const k = await keys(TOKEN);

/** The agent's dev server: echoes the headers it was sent, and WebSocket messages; `/forever` is
 * an event stream that sends one event and never ends, and `/endless` a download that never
 * ends. */
function devServer() {
  return serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req, info) => {
    if (req.headers.get("upgrade") === "websocket") {
      const { response, socket } = info.upgradeWebSocket(req);
      socket.onmessage = ({ data }) => socket.send(data);
      return response;
    }
    if (new URL(req.url).pathname === "/endless") {
      const chunk = new Uint8Array(64 * 1024);
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(chunk);
          },
        }),
        { headers: { "content-type": "application/octet-stream" } },
      );
    }
    if (new URL(req.url).pathname === "/forever") {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json(Object.fromEntries(req.headers));
  });
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A run id `replicas` pods give to `ordinal`, and (when given) `other` pods to `otherOrdinal`. */
async function runOwnedBy(
  ordinal: number,
  replicas: number,
  prefix: string,
  other?: { replicas: number; ordinal: number },
): Promise<string> {
  for (let i = 0; i < 10_000; i++) {
    const runId = `${prefix}-${i}`;
    const shard = await shardOf(k, runId);
    if (ownerOf(shard, replicas) !== ordinal) continue;
    if (other && ownerOf(shard, other.replicas) !== other.ordinal) continue;
    return runId;
  }
  throw new Error("no such run");
}

/**
 * `views[i]` is how many replicas pod i believes there are (its peers are the first that many
 * pods); by default every pod sees them all.
 */
async function cluster(replicas: number, views?: number[], appUrl?: string) {
  // Every listener binds port 0 and the peers' ports are filled in once bound: each pod reads
  // its peers as requests come, so nothing is probed free and then raced for.
  const peers: Peer[] = Array.from({ length: replicas }, () => ({
    host: "127.0.0.1",
    tunnelPort: 0,
    apiPort: 0,
    peerPort: 0,
  }));
  const ports: { public: number; tunnel: number; api: number; peer: number }[] = [];
  const pods: Previews[] = [];
  const bind = async (server: import("node:http").Server) => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as { port: number }).port;
  };
  for (let i = 0; i < replicas; i++) {
    const view = views?.[i] ?? replicas;
    const pod = await previews({
      token: TOKEN,
      domain: DOMAIN,
      appUrl,
      cluster: { self: i, peers: peers.slice(0, view) },
      health: makeHealth().routes,
    });
    const bound = {
      public: await bind(pod.public),
      tunnel: await bind(pod.tunnel),
      api: await bind(pod.api),
      peer: pod.peer ? await bind(pod.peer) : 0,
    };
    peers[i].tunnelPort = bound.tunnel;
    peers[i].apiPort = bound.api;
    peers[i].peerPort = bound.peer;
    ports.push(bound);
    pods.push(pod);
  }
  const runners: WebSocket[] = [];

  const call = async (
    pod: number,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = auth,
  ) => {
    const response = await fetch(`http://127.0.0.1:${ports[pod].api}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch { /* not JSON */ }
    return { status: response.status, body: parsed };
  };
  const register = (pod: number, runId: string, port: number) =>
    call(pod, "POST", "/internal/previews", { runId, port, label: "App", hosts: [] });

  /** The runner's end, dialling `pod`'s tunnel listener: the owner's own address, as its
   * registration answer names it, or any other pod's. */
  async function dial(pod: number, ticket: string, devPort: number) {
    return await dialUrl(`ws://127.0.0.1:${ports[pod].tunnel}/tunnel/${ticket}`, devPort);
  }
  /** Dialling where a registration said: what the control plane hands the runner. */
  async function dialOwner(registered: { tunnelBase: string; ticket: string }, devPort: number) {
    return await dialUrl(`${registered.tunnelBase}/tunnel/${registered.ticket}`, devPort);
  }
  async function dialUrl(url: string, devPort: number) {
    const ws = new WebSocket(url, TUNNEL_PROTOCOL);
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

  async function listed(pod: number, runId: string, count: number) {
    for (let i = 0; i < 100; i++) {
      const { body } = await call(pod, "GET", `/internal/runs/${runId}/previews`);
      if (body?.previews?.length === count) return body.previews;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`run ${runId} never listed ${count} previews`);
  }

  const host = (id: string) => `${id}.${DOMAIN}`;
  const origin = (id: string) => `https://${host(id)}`;
  /** One request on a fresh connection to `port`. */
  const raw = (port: number, path: string, headers: Record<string, string>, method = "GET") =>
    new Promise<Reply>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path, method, headers, agent: false },
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
  const hit = (pod: number, path: string, headers: Record<string, string>, method = "GET") =>
    raw(ports[pod].public, path, headers, method);

  /** A cookie the way a browser gets one: a ticket asked of `asked`, entered through `entered`. */
  async function enter(asked: number, entered: number, runId: string, id: string) {
    const { status, body } = await call(asked, "POST", `/internal/previews/${id}/viewer`, {
      runId,
    });
    assertEquals(status, 200);
    const url = new URL(body.url);
    assertEquals(url.origin, origin(id));
    const reply = await hit(entered, url.pathname + url.search, { host: host(id) });
    assertEquals(reply.status, 303);
    return String(reply.headers["set-cookie"]).split(";")[0];
  }

  /** A raw WebSocket handshake to `port`; with `echo`, a text frame "hmr" must come back. */
  const upgradeTo = (port: number, headers: Record<string, string>, echo = false) =>
    new Promise<number>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port,
        path: "/hmr",
        agent: false,
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

  /** Until `check` holds, or a second has gone by. */
  async function eventually(check: () => boolean, what: string) {
    for (let i = 0; i < 100 && !check(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(check(), what);
  }

  return {
    pods,
    ports,
    call,
    register,
    dial,
    dialOwner,
    listed,
    host,
    origin,
    raw,
    hit,
    enter,
    upgradeTo,
    eventually,
    async stop() {
      for (const ws of runners) ws.close();
      for (const pod of pods) {
        await pod.shutdownPublic();
        pod.close();
        for (const listener of [pod.tunnel, pod.api]) {
          await new Promise<void>((resolve) => listener.close(() => resolve()));
        }
      }
    },
  };
}

test("cluster: a non-owner's registration, viewer ticket, list and delete land on the owner", async () => {
  const dev = await devServer();
  const c = await cluster(3);
  try {
    const runId = await runOwnedBy(1, 3, "run");
    const registered = await c.register(0, runId, dev.addr.port);
    assertEquals(registered.status, 201);
    const { id, url, ticket, tunnelBase } = registered.body;
    // The id starts with the run's shard; the ticket is plain random, and the answer names the
    // owner's own address for the runner to dial.
    assertMatch(id, /^[a-f0-9]{32}$/);
    assertEquals(id.slice(0, 8), await shardOf(k, runId));
    assertMatch(ticket, /^[a-f0-9]{64}$/);
    assertEquals(tunnelBase, `ws://127.0.0.1:${c.ports[1].tunnel}`);
    assertEquals(url, c.origin(id));
    // A second preview of the run, through another pod, is on the owner too: the cap is its.
    for (const port of [2000, 2001, 2002]) {
      assertEquals((await c.register(2, runId, port)).status, 201);
    }
    assertEquals((await c.register(0, runId, 2003)).status, 429);
    assertEquals((await c.call(2, "DELETE", `/internal/runs/${runId}`)).status, 204);

    const again = (await c.register(2, runId, dev.addr.port)).body;
    assertEquals(again.id, id);
    await c.dialOwner(again, dev.addr.port);
    for (const pod of [0, 1, 2]) {
      assertEquals(await c.listed(pod, runId, 1), [{ id, port: dev.addr.port, label: "App", url }]);
    }
    // A viewer ticket through a non-owner enters, through yet another.
    const cookie = await c.enter(0, 2, runId, id);
    assertEquals((await c.hit(1, "/", { host: c.host(id), cookie })).status, 200);
    // Which run a preview is, for the control plane's open by id: any pod asks its owner.
    for (const pod of [0, 1, 2]) {
      assertEquals(await c.call(pod, "GET", `/internal/previews/${id}`), {
        status: 200,
        body: { runId },
      });
    }
    // An id nobody holds, one that is not an id, and a caller without the bearer.
    const unknown = `${id.slice(0, 8)}${"0".repeat(24)}`;
    assertEquals((await c.call(0, "GET", `/internal/previews/${unknown}`)).status, 404);
    assertEquals((await c.call(0, "GET", `/internal/previews/${id.toUpperCase()}`)).status, 404);
    assertEquals((await c.call(0, "GET", `/internal/previews/${id}x`)).status, 404);
    assertEquals(
      (await c.call(0, "GET", `/internal/previews/${id}`, undefined, {
        authorization: `Bearer ${"x".repeat(64)}`,
      })).status,
      401,
    );
    // The wrong run is still a 404, whichever pod is asked.
    assertEquals(
      (await c.call(2, "POST", `/internal/previews/${id}/viewer`, { runId: "other" })).status,
      404,
    );
    // The bearer is checked before anything is forwarded, and the owner checks its own.
    for (const pod of [0, 2]) {
      const refused = await c.call(pod, "GET", `/internal/runs/${runId}/previews`, undefined, {
        authorization: `Bearer ${"x".repeat(64)}`,
      });
      assertEquals(refused.status, 401);
    }
    // Deleted through a non-owner: gone everywhere.
    assertEquals((await c.call(0, "DELETE", `/internal/runs/${runId}`)).status, 204);
    for (const pod of [0, 1, 2]) await c.listed(pod, runId, 0);
    assertEquals((await c.hit(0, "/", { host: c.host(id), cookie })).status, 404);
    assertEquals((await c.call(2, "GET", `/internal/previews/${id}`)).status, 404);
  } finally {
    await c.stop();
    await dev.shutdown();
  }
});

test("cluster: a forwarded call carries the forward credential, never the token", async () => {
  const c = await cluster(2);
  try {
    const owned = await runOwnedBy(1, 2, "run");
    const seen: Record<string, string | undefined>[] = [];
    c.pods[1].api.on("request", (req: import("node:http").IncomingMessage) => {
      seen.push({
        authorization: req.headers.authorization,
        hop: req.headers[HOP_HEADER] as string,
      });
    });
    assertEquals((await c.register(0, owned, 5173)).status, 201);
    const forward = await forwardCredential(k);
    assertEquals(seen, [{ authorization: undefined, hop: forward }]);
    assert(forward !== TOKEN);
    // The owner takes the forward credential as it takes the bearer, and nothing else in its place.
    const as = (hop: string) => ({ [HOP_HEADER]: hop });
    const path = `/internal/runs/${owned}/previews`;
    assertEquals((await c.call(1, "GET", path, undefined, as(forward))).status, 200);
    for (const hop of ["1", TOKEN, await peerCredential(k), "x".repeat(64)]) {
      assertEquals((await c.call(1, "GET", path, undefined, as(hop))).status, 401, hop);
    }
    // Nor does a bearer beside a bad one get it through: the hop header decides.
    assertEquals(
      (await c.call(1, "GET", path, undefined, { ...auth, [HOP_HEADER]: "1" })).status,
      401,
    );
    // A call that hopped once is never sent on, by a pod that does not own its run.
    const hopped = as(forward);
    assertEquals((await c.call(0, "GET", path, undefined, hopped)).status, 503);
    assertEquals(
      (await c.call(0, "POST", "/internal/previews", {
        runId: owned,
        port: 3000,
        label: "App",
        hosts: [],
      }, hopped)).status,
      503,
    );
    assertEquals(
      (await c.call(0, "DELETE", `/internal/runs/${owned}`, undefined, hopped)).status,
      503,
    );
  } finally {
    await c.stop();
  }
});

test("cluster: the runner dials its owner, a non-owner refuses its ticket, browsers come through any pod", async () => {
  const dev = await devServer();
  const c = await cluster(3);
  try {
    const runId = await runOwnedBy(2, 3, "run");
    const registered = (await c.register(0, runId, dev.addr.port)).body;
    const { id, url } = registered;
    // Another pod holds no such ticket, and never follows it anywhere: refused, ticket unspent.
    const elsewhere = await c.dial(0, registered.ticket, dev.addr.port).then(
      () => "dialled",
      () => "refused",
    );
    assertEquals(elsewhere, "refused");
    const runner = await c.dialOwner(registered, dev.addr.port);
    assertEquals(runner.ws.protocol, TUNNEL_PROTOCOL);
    await c.listed(1, runId, 1);
    // A cookie minted through pod 1 works on every pod, the owner included.
    const cookie = await c.enter(1, 0, runId, id);
    for (const pod of [0, 1, 2]) {
      const reply = await c.hit(pod, "/headers", {
        host: c.host(id),
        cookie,
        origin: url,
        "sec-fetch-site": "same-origin",
      });
      assertEquals(reply.status, 200, `pod ${pod}`);
      const seen = JSON.parse(reply.body);
      assertEquals(seen.host, `localhost:${dev.addr.port}`);
      assertEquals(seen["x-forwarded-host"], c.host(id));
      assertEquals(seen["x-forwarded-proto"], "https");
      assertEquals(seen.cookie, undefined);
      assertEquals(seen[PEER_HEADER], undefined);
      assertEquals(seen[HOP_HEADER], undefined);
      // The owner's response rewriting came back through the hop.
      assertEquals(
        reply.headers["content-security-policy"],
        "default-src 'self' 'unsafe-inline' " +
          "'unsafe-eval' data: blob:; form-action 'self'; base-uri 'self'; frame-ancestors 'self'",
      );
      // And a WebSocket, through every pod.
      assertEquals(
        await c.upgradeTo(c.ports[pod].public, { host: c.host(id), cookie, origin: url }, true),
        101,
        `pod ${pod}`,
      );
    }
    // The gate is the owner's, whichever pod the request came through.
    assertEquals(
      (await c.hit(0, "/", { host: c.host(id), cookie, origin: "https://evil.example" })).status,
      403,
    );
    assertEquals(await c.upgradeTo(c.ports[0].public, { host: c.host(id), cookie }), 403);
    assertEquals((await c.hit(0, "/__ryph/enter?ticket=nope", { host: c.host(id) })).status, 403);
    // Hosts that are not a preview's are answered where they land, never forwarded.
    assertEquals((await c.hit(0, "/", { host: `${id}.evil.example` })).status, 404);
    assertEquals((await c.hit(0, "/healthz", { host: "127.0.0.1" })).status, 200);
  } finally {
    await c.stop();
    await dev.shutdown();
  }
});

test("cluster: nothing reaches another pod without a viewer cookie or a signed ticket", async () => {
  const dev = await devServer();
  const c = await cluster(2, undefined, "https://app.example");
  try {
    const runId = await runOwnedBy(1, 2, "run");
    const registered = (await c.register(1, runId, dev.addr.port)).body;
    await c.dialOwner(registered, dev.addr.port);
    await c.listed(0, runId, 1);
    const { id, url } = registered;
    let relayed = 0;
    c.pods[1].peer!.on("request", () => relayed++);
    c.pods[1].peer!.on("upgrade", () => relayed++);
    // A cookieless request, a forged cookie, a cookie for another preview: answered at the front
    // door, and nothing reaches the owner.
    const forged = `__Host-ryph-preview=${"9".repeat(10)}.${"a".repeat(64)}`;
    for (const cookie of [undefined, forged]) {
      const headers: Record<string, string> = { host: c.host(id), origin: url };
      if (cookie) headers.cookie = cookie;
      assertEquals((await c.hit(0, "/app.js", headers)).status, 401);
      assertEquals(await c.upgradeTo(c.ports[0].public, headers), 401);
    }
    const other = await runOwnedBy(1, 2, "other");
    const b = (await c.register(1, other, dev.addr.port)).body;
    await c.dialOwner(b, dev.addr.port);
    await c.listed(1, other, 1);
    const otherCookie = await c.enter(1, 1, other, b.id);
    assertEquals((await c.hit(0, "/", { host: c.host(id), cookie: otherCookie })).status, 401);
    // A page load without one is sent to the app's open route by preview id, by whichever pod
    // it reached, owner or not, without asking anyone: the run is never named.
    for (const pod of [0, 1]) {
      const navigate = await c.hit(pod, "/nodes/x?y=1", {
        host: c.host(id),
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        "sec-fetch-site": "none",
      });
      assertEquals(navigate.status, 303);
      assertEquals(
        navigate.headers.location,
        `https://app.example/previews/${id}?path=${encodeURIComponent("/nodes/x?y=1")}`,
      );
    }
    // The way in with a ticket that is not one the control plane asked for this preview: forged,
    // expired, another preview's, or no ticket at all. Answered here; and a HEAD spends nothing.
    const asked = (await c.call(0, "POST", `/internal/previews/${id}/viewer`, { runId })).body;
    const real = new URL(asked.url).searchParams.get("ticket")!;
    const [exp, nonce] = real.split(".");
    for (
      const ticket of [
        `${exp}.${nonce}.${"0".repeat(64)}`,
        await viewerTicket(k, id, Date.now() - 2 * 60_000),
        await viewerTicket(k, b.id, Date.now()),
        `${Number(exp) + 3600}.${nonce}.${real.split(".")[2]}`,
        "nope",
        "",
      ]
    ) {
      const refused = await c.hit(0, `/__ryph/enter?ticket=${ticket}`, { host: c.host(id) });
      assertEquals(refused.status, 403, ticket);
      assertMatch(refused.body, /expired/);
    }
    assertEquals(
      (await c.hit(0, `/__ryph/enter?ticket=${real}`, { host: c.host(id) }, "HEAD")).status,
      405,
    );
    assertEquals(relayed, 0);
    // The real one goes on, and the owner spends it; again, its MAC still holds, so it reaches
    // the owner, which knows it is spent.
    const entered = await c.hit(0, `/__ryph/enter?ticket=${real}`, { host: c.host(id) });
    assertEquals(entered.status, 303);
    assertEquals(relayed, 1);
    const cookie = String(entered.headers["set-cookie"]).split(";")[0];
    assertEquals(
      (await c.hit(0, `/__ryph/enter?ticket=${real}`, { host: c.host(id) })).status,
      403,
    );
    assertEquals(relayed, 2);
    assertEquals((await c.hit(0, "/", { host: c.host(id), cookie })).status, 200);
    assertEquals(relayed, 3);
  } finally {
    await c.stop();
    await dev.shutdown();
  }
});

/**
 * One real pod (ordinal 0 of 2) whose peer, ordinal 1, accepts every connection and never answers
 * nor reads: an owner gone quiet, which leaves every request this pod relays to it open.
 */
async function silentOwner(appUrl?: string, streams?: number) {
  const held = new Set<Socket>();
  const silent: Server = createServer({ pauseOnConnect: true }, (socket) => {
    held.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => held.delete(socket));
  });
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const port = (silent.address() as { port: number }).port;
  const pod = await previews({
    token: TOKEN,
    domain: DOMAIN,
    appUrl,
    streams,
    cluster: {
      self: 0,
      peers: [
        { host: "127.0.0.1", tunnelPort: 1, apiPort: 1, peerPort: 1 },
        { host: "127.0.0.1", tunnelPort: port, apiPort: port, peerPort: port },
      ],
    },
  });
  await new Promise<void>((resolve) => pod.public.listen(0, "127.0.0.1", resolve));
  const publicPort = (pod.public.address() as { port: number }).port;
  const runId = await runOwnedBy(1, 2, "quiet");
  const id = await previewId(k, runId, 5173);
  const cookie = `__Host-ryph-preview=${await viewerCookie(k, id, Date.now())}`;
  const browsers: Socket[] = [];
  /** A request on its own connection; the answer's status, or 0 while there is none. */
  const send = (head: string, body?: Uint8Array) => {
    const socket = connect({ host: "127.0.0.1", port: publicPort });
    socket.on("error", () => {});
    browsers.push(socket);
    let answer = "";
    socket.on("data", (chunk) => answer += chunk);
    socket.write(head);
    if (body) socket.write(body);
    return () => Number(/^HTTP\/1\.1 (\d{3})/.exec(answer)?.[1] ?? 0);
  };
  const get = (path: string, headers: string) =>
    send(`GET ${path} HTTP/1.1\r\nhost: ${id}.${DOMAIN}\r\n${headers}\r\n`);
  return {
    pod,
    held,
    cookie,
    id,
    get,
    send,
    async stop() {
      for (const socket of browsers) socket.destroy();
      await pod.shutdownPublic();
      pod.close();
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    },
  };
}

async function until(check: () => boolean, what: string, ms = 2000) {
  for (let waited = 0; waited < ms && !check(); waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(check(), what);
}

test("cluster: a quiet owner holds a run's relays to its caps, and blocks nothing else", async () => {
  const q = await silentOwner("https://app.example");
  try {
    // A viewer's requests are the run's to pay for: as many reach the owner as its caps allow,
    // the rest wait in its line.
    const fits = PER_RELAY.open;
    const viewers = Array.from({ length: fits + 8 }, () => q.get("/", `cookie: ${q.cookie}\r\n`));
    await until(() => q.held.size === fits, `${q.held.size} relays held, ${fits} fit`);
    // Every request is parsed and in line only some time after its bytes were sent.
    await until(() => q.pod.budget.waiting === 8, `${q.pod.budget.waiting} waiting`);
    assertEquals(viewers.filter((status) => status() !== 0), []);
    // Every way in that needs no owner is still answered at once, for this preview and any other
    // the quiet owner holds: page loads without a cookie go to the app from here.
    const navigate = "sec-fetch-mode: navigate\r\nsec-fetch-dest: document\r\n";
    const others = await Promise.all(
      Array.from(
        { length: 8 },
        async (_, i) => previewId(k, await runOwnedBy(1, 2, `o${i}`), 3000),
      ),
    );
    const loads = [q.id, ...others].flatMap((id) =>
      Array.from(
        { length: 10 },
        () => q.send(`GET / HTTP/1.1\r\nhost: ${id}.${DOMAIN}\r\n${navigate}\r\n`),
      )
    );
    await until(() => loads.every((status) => status() === 303), "every page load answered");
    // And another run's ticket is that run's to pay for: it reaches the owner past the first's
    // full caps.
    const another = await runOwnedBy(1, 2, "another");
    const id = await previewId(k, another, 5173);
    q.send(
      `GET /__ryph/enter?ticket=${await viewerTicket(k, id, Date.now())} HTTP/1.1\r\n` +
        `host: ${id}.${DOMAIN}\r\n\r\n`,
    );
    await until(() => q.held.size === fits + 1, `${q.held.size} relays held`);
  } finally {
    await q.stop();
  }
});

test("cluster: a sibling preview's request is refused before it is relayed", async () => {
  const q = await silentOwner();
  try {
    // A viewer's browser, on a page of a sibling preview, fetching this one with its cookie: the
    // owner would refuse it, so this pod does, and no relay is spent on it.
    const sibling = `https://${"b".repeat(32)}.${DOMAIN}`;
    const fetched = q.get(
      "/",
      `cookie: ${q.cookie}\r\norigin: ${sibling}\r\nsec-fetch-site: same-site\r\n` +
        "sec-fetch-mode: cors\r\nsec-fetch-dest: empty\r\n",
    );
    const framed = q.get(
      "/",
      `cookie: ${q.cookie}\r\nsec-fetch-site: same-site\r\nsec-fetch-mode: navigate\r\n` +
        "sec-fetch-dest: iframe\r\n",
    );
    const worker = q.get("/sw.js", `cookie: ${q.cookie}\r\nservice-worker: script\r\n`);
    await until(
      () => [fetched, framed, worker].every((status) => status() === 403),
      "every one refused",
    );
    assertEquals(q.held.size, 0);
    assertEquals(q.pod.budget.open, 0);
    // A WebSocket from the sibling's page the same way.
    const socket = q.send(
      `GET / HTTP/1.1\r\nhost: ${q.id}.${DOMAIN}\r\ncookie: ${q.cookie}\r\norigin: ${sibling}\r\n` +
        "upgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-version: 13\r\n" +
        "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    await until(() => socket() === 403, "the upgrade refused");
    assertEquals(q.held.size, 0);
    // The preview's own page is relayed as before.
    q.get("/", `cookie: ${q.cookie}\r\nsec-fetch-site: same-origin\r\n`);
    await until(() => q.held.size === 1, "its own request relayed");
  } finally {
    await q.stop();
  }
});

test("cluster: a relay's charge closed mid-dial abandons the dial and leaves no socket", async () => {
  // An address that never answers within the dial's time: the dial is still under way when the
  // budget closes the charge.
  let captured: Charge | undefined;
  class Spy extends Budget {
    override acquire<T>(group: unknown, opts: Parameters<Budget["acquire"]>[1]): Promise<T> {
      return super.acquire(group, {
        ...opts,
        use: (charge) => {
          captured = charge;
          return opts.use(charge) as T;
        },
      }) as Promise<T>;
    }
  }
  const budget = new Spy({ relays: 1 });
  const sockets: Socket[] = [];
  const quiet = createServer({ pauseOnConnect: true }, () => {});
  await new Promise<void>((resolve) => quiet.listen(0, "127.0.0.1", resolve));
  const port = (quiet.address() as { port: number }).port;
  const connect = relay(
    { host: "127.0.0.1", tunnelPort: port, apiPort: port, peerPort: port },
    port,
    (socket) => sockets.push(socket),
    { budget, group: "run" },
  );
  const dialled = connect(new AbortController().signal);
  // The charge is taken first; the socket is created in the same turn, not yet connected.
  await Promise.resolve();
  await Promise.resolve();
  assert(captured !== undefined && sockets.length === 1);
  assertEquals(budget.open, 1);
  captured!.close();
  let outcome = "dialled";
  try {
    await dialled;
  } catch {
    outcome = "abandoned";
  }
  assertEquals(outcome, "abandoned");
  assert(sockets[0].destroyed);
  assertEquals(budget.open, 0);
  await new Promise<void>((resolve) => quiet.close(() => resolve()));
});

test("cluster: a refused tunnel dial is closed even when the dialler never hangs up", async () => {
  const c = await cluster(2);
  try {
    const closed = Promise.withResolvers<void>();
    c.pods[0].tunnel.on("upgrade", (_req: unknown, client: Duplex) => {
      client.on("close", () => closed.resolve());
    });
    const socket = connect({ host: "127.0.0.1", port: c.ports[0].tunnel, allowHalfOpen: true });
    socket.on("error", () => {});
    let answer = "";
    socket.on("data", (chunk) => answer += chunk);
    socket.write(
      `GET /tunnel/${"a".repeat(64)} HTTP/1.1\r\nhost: x\r\nconnection: Upgrade\r\n` +
        "upgrade: websocket\r\nsec-websocket-version: 13\r\n" +
        `sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-protocol: ${TUNNEL_PROTOCOL}\r\n\r\n`,
    );
    const outcome = await Promise.race([
      closed.promise.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("open"), REFUSE_GRACE_MS + 3000)),
    ]);
    socket.destroy();
    assertEquals(outcome, "closed");
    assertMatch(answer, /^HTTP\/1\.1 404 /);
  } finally {
    await c.stop();
  }
});

test("cluster: the hop forwards nothing a client forged, and never the peer credential", async () => {
  const dev = await devServer();
  const c = await cluster(2);
  try {
    const runId = await runOwnedBy(1, 2, "run");
    const { id, url, ticket } = (await c.register(1, runId, dev.addr.port)).body;
    await c.dial(1, ticket, dev.addr.port);
    await c.listed(0, runId, 1);
    const cookie = await c.enter(0, 0, runId, id);
    for (const pod of [0, 1]) {
      const reply = await c.hit(pod, "/headers", {
        host: c.host(id),
        cookie: `${cookie}; theirs=1`,
        origin: url,
        [PEER_HEADER]: "forged",
        [HOP_HEADER]: "1",
        [WAIT_HEADER]: "1",
        [CONNECTION_HEADER]: "x-kept",
        "x-forwarded-for": "203.0.113.9",
        forwarded: "for=203.0.113.9",
        "x-named": "1",
        "x-kept": "1",
        connection: `keep-alive, x-named, ${PEER_HEADER}`,
      });
      assertEquals(reply.status, 200, `pod ${pod}`);
      const seen = JSON.parse(reply.body);
      // A header the browser's Connection names is the hop's, dropped before the dev server
      // directly and through a relay alike; a forged word on what it named changes nothing.
      assertEquals(seen["x-named"], undefined, `pod ${pod}`);
      assertEquals(seen["x-kept"], "1", `pod ${pod}`);
      assertEquals(seen[PEER_HEADER], undefined);
      assertEquals(seen[HOP_HEADER], undefined);
      assertEquals(seen["x-forwarded-for"], undefined);
      assertEquals(seen.forwarded, undefined);
      assertEquals(seen.cookie, "theirs=1");
      // What the dev server sees through the hop and directly is one and the same.
      assertEquals(Object.keys(seen).filter((name) => name.startsWith("x-ryph")), []);
    }
  } finally {
    await c.stop();
    await dev.shutdown();
  }
});

test("cluster: the peer listener wants the peer credential, and sends nothing on", async () => {
  const dev = await devServer();
  const c = await cluster(2);
  try {
    const owned = await runOwnedBy(1, 2, "run");
    const other = await runOwnedBy(0, 2, "run");
    const a = (await c.register(0, owned, dev.addr.port)).body;
    const b = (await c.register(0, other, dev.addr.port)).body;
    await c.dialOwner(a, dev.addr.port);
    await c.dialOwner(b, dev.addr.port);
    await c.listed(0, owned, 1);
    await c.listed(0, other, 1);
    const cookie = await c.enter(0, 0, owned, a.id);
    const peerPort = c.ports[1].peer;
    const as = { host: c.host(a.id), cookie, origin: a.url };
    const credential = await peerCredential(k);

    // Without the credential, or with another, the owner's peer port serves nothing.
    assertEquals((await c.raw(peerPort, "/", as)).status, 403);
    assertEquals(
      (await c.raw(peerPort, "/", { ...as, [PEER_HEADER]: "x".repeat(64) })).status,
      403,
    );
    assertEquals((await c.raw(peerPort, "/", { ...as, [PEER_HEADER]: TOKEN })).status, 403);
    assertEquals(await c.upgradeTo(peerPort, as), 403);
    // With it, the request meets the owner's gate as a direct one would.
    assertEquals((await c.raw(peerPort, "/", { ...as, [PEER_HEADER]: credential })).status, 200);
    assertEquals(
      (await c.raw(peerPort, "/", { host: c.host(a.id), [PEER_HEADER]: credential })).status,
      401,
    );
    assertEquals(await c.upgradeTo(peerPort, { ...as, [PEER_HEADER]: credential }, true), 101);
    // A request for a preview this pod does not own is refused, not sent on a second time.
    const misrouted = await c.raw(peerPort, "/", {
      host: c.host(b.id),
      [PEER_HEADER]: credential,
    });
    assertEquals(misrouted.status, 503);
    assertMatch(misrouted.body, /This preview will be back in a moment\./);
    assertEquals(
      await c.upgradeTo(peerPort, { host: c.host(b.id), origin: b.url, [PEER_HEADER]: credential }),
      503,
    );
    // Nor is anything but a preview's host served there, health included.
    assertEquals(
      (await c.raw(peerPort, "/healthz", { host: "127.0.0.1", [PEER_HEADER]: credential })).status,
      404,
    );
  } finally {
    await c.stop();
    await dev.shutdown();
  }
});

test("cluster: pods that disagree on the replica count refuse what they do not own, never forward twice", async () => {
  const dev = await devServer();
  // Mid-rollout from 3 replicas to 2: pod 0 already sees 2, pods 1 and 2 still see 3. (Growing,
  // rendezvous hashing only ever moves a run to the new pod, which no old pod forwards to.)
  const c = await cluster(3, [2, 3, 3]);
  try {
    // Pod 2's under the old view, pod 1's under the new one.
    const moving = await runOwnedBy(2, 3, "run", { replicas: 2, ordinal: 1 });
    // Pod 0 sends it to pod 1, which under its own view does not own it: 503, never a second hop.
    assertEquals((await c.register(0, moving, dev.addr.port)).status, 503);
    assertEquals((await c.call(0, "GET", `/internal/runs/${moving}/previews`)).status, 503);
    // Through an old pod it lands on pod 2, which names its own address to dial.
    const fresh = (await c.register(1, moving, dev.addr.port)).body;
    assertEquals(fresh.tunnelBase, `ws://127.0.0.1:${c.ports[2].tunnel}`);
    // Pod 0 or 1, holding no such ticket, refuses it rather than follow it anywhere.
    for (const pod of [0, 1]) {
      const refused = await c.dial(pod, fresh.ticket, dev.addr.port).then(
        () => "dialled",
        () => "refused",
      );
      assertEquals(refused, "refused");
    }
    await c.dialOwner(fresh, dev.addr.port);
    await c.listed(2, moving, 1);
    const cookie = await c.enter(1, 1, moving, fresh.id);
    assertEquals((await c.hit(1, "/", { host: c.host(fresh.id), cookie })).status, 200);
    // Pod 0 sends the browser to pod 1, which does not own it under its view: a moment's 503,
    // until pod 2 is gone and the runner re-registers through the new view.
    const viewer = await c.hit(0, "/", { host: c.host(fresh.id), cookie });
    assertEquals(viewer.status, 503);
    assertMatch(viewer.body, /This preview will be back in a moment\./);

    // A run both views give the same pod works through every pod.
    const settled = await runOwnedBy(0, 3, "run", { replicas: 2, ordinal: 0 });
    const s = (await c.register(2, settled, dev.addr.port)).body;
    await c.dialOwner(s, dev.addr.port);
    await c.listed(0, settled, 1);
    const sc = await c.enter(2, 1, settled, s.id);
    for (const pod of [0, 1, 2]) {
      assertEquals((await c.hit(pod, "/", { host: c.host(s.id), cookie: sc })).status, 200);
    }
  } finally {
    await c.stop();
    await dev.shutdown();
  }
});

test("cluster: a relay closes both sides together, whichever side goes first", async () => {
  const dev = await devServer();
  const c = await cluster(2);
  try {
    const runId = await runOwnedBy(1, 2, "run");
    // The runner hangs up: the owner loses the preview, and every pod says so.
    const first = (await c.register(0, runId, dev.addr.port)).body;
    const gone = await c.dialOwner(first, dev.addr.port);
    await c.listed(1, runId, 1);
    gone.ws.close();
    await c.listed(1, runId, 0);

    const second = (await c.register(0, runId, dev.addr.port)).body;
    const runner = await c.dialOwner(second, dev.addr.port);
    await c.listed(1, runId, 1);
    const cookie = await c.enter(0, 0, runId, second.id);

    // A browser's WebSocket through pod 0: charged on both pods while it is open.
    const browser = await new Promise<import("node:stream").Duplex>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: c.ports[0].public,
        path: "/hmr",
        agent: false,
        headers: {
          host: c.host(second.id),
          cookie,
          origin: second.url,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
      req.on("upgrade", (_res, socket) => resolve(socket));
      req.on("response", (res) => reject(new Error(`refused: ${res.statusCode}`)));
      req.on("error", reject);
      req.end();
    });
    browser.on("error", () => {});
    await c.eventually(() => c.pods[0].budget.open === 1, "the relay holds a charge");
    await c.eventually(() => c.pods[1].budget.open === 1, "the owner holds a stream");
    // The browser leaves: the relay and the owner's stream both let go.
    browser.destroy();
    await c.eventually(() => c.pods[0].budget.open === 0, "the relay let go");
    await c.eventually(() => c.pods[1].budget.open === 0, "the owner let go");

    // Another, and this time the owner ends the run: the browser's socket closes too.
    const again = await new Promise<import("node:stream").Duplex>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: c.ports[0].public,
        path: "/hmr",
        agent: false,
        headers: {
          host: c.host(second.id),
          cookie,
          origin: second.url,
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
    again.on("error", () => {});
    const browserClosed = new Promise<void>((resolve) => again.on("close", () => resolve()));
    assertEquals((await c.call(1, "DELETE", `/internal/runs/${runId}`)).status, 204);
    await runner.closed;
    await browserClosed;
    await c.eventually(() => c.pods[0].budget.open === 0, "the relay let go");
  } finally {
    await c.stop();
    await dev.shutdown();
  }
});

/** A request on its own connection to `port` that has had its first bytes back: an event stream
 * held open. */
async function streaming(port: number, head: string): Promise<Duplex> {
  const socket = connect({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  const first = new Promise<void>((resolve) => socket.once("data", () => resolve()));
  socket.write(head);
  await first;
  return socket;
}

test("cluster: a drain cuts what a pod relays after a moment, and closes the tunnels it owns", async () => {
  const dev = await devServer();
  const c = await cluster(2);
  try {
    const runId = await runOwnedBy(1, 2, "run");
    const registered = (await c.register(0, runId, dev.addr.port)).body;
    const runner = await c.dialOwner(registered, dev.addr.port);
    await c.listed(0, runId, 1);
    const cookie = await c.enter(0, 0, runId, registered.id);
    // An event stream relayed through pod 0, held open by the owner's dev server.
    const browser = await streaming(
      c.ports[0].public,
      `GET /forever HTTP/1.1\r\nhost: ${c.host(registered.id)}\r\ncookie: ${cookie}\r\n` +
        `origin: ${registered.url}\r\naccept: text/event-stream\r\n\r\n`,
    );
    const browserClosed = new Promise<void>((resolve) => browser.on("close", () => resolve()));
    assertEquals(c.pods[0].budget.open, 1);
    assertEquals(c.pods[1].budget.open, 1);
    // Pod 0 drains: it does not wait on the stream past the grace, and nothing else closes it.
    const started = Date.now();
    const drained = await Promise.race([
      c.pods[0].shutdownPublic().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);
    const took = Date.now() - started;
    // Well short of the drain deadline (25 s), however slow the machine running this is.
    assert(drained, "the drain waited on the stream");
    assert(took >= DRAIN_GRACE_MS - 50, `took ${took} ms`);
    await browserClosed;
    // The cut reached the owner too: its peer connection closed, its stream let go.
    await c.eventually(() => c.pods[0].budget.open === 0, "the relay let go");
    await c.eventually(() => c.pods[1].budget.open === 0, "the owner let go");
    await c.listed(1, runId, 1);
    // The owner drains: its runner hears it at once, and would re-register.
    await c.pods[1].shutdownPublic();
    c.pods[1].close();
    await runner.closed;
  } finally {
    await c.stop();
    await dev.shutdown();
  }
});

test("cluster: the owner judges the headers the browser sent, whatever its Connection names", async () => {
  const dev = await devServer();
  const c = await cluster(2);
  try {
    const runId = await runOwnedBy(1, 2, "run");
    const registered = (await c.register(0, runId, dev.addr.port)).body;
    await c.dialOwner(registered, dev.addr.port);
    await c.listed(0, runId, 1);
    const cookie = await c.enter(0, 0, runId, registered.id);
    const as = { host: c.host(registered.id), cookie };
    for (const pod of [0, 1]) {
      // Each names in Connection the very header that should refuse it: a hop that honoured that
      // would hand the owner a request without it.
      for (
        const headers of [
          { origin: "https://evil.example", connection: "keep-alive, Origin" },
          {
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "cors",
            "sec-fetch-dest": "empty",
            connection: "sec-fetch-site, sec-fetch-mode, sec-fetch-dest",
          },
          { "service-worker": "script", connection: "service-worker" },
        ] as Record<string, string>[]
      ) {
        const reply = await c.hit(pod, "/", { ...as, ...headers });
        assertEquals(reply.status, 403, `pod ${pod}: ${JSON.stringify(headers)}`);
      }
      assertEquals((await c.hit(pod, "/", as)).status, 200);
    }
  } finally {
    await c.stop();
    await dev.shutdown();
  }
});

test("cluster: every charge goes back, on both pods, whatever the traffic did", async () => {
  const dev = await devServer();
  const c = await cluster(2);
  try {
    const runId = await runOwnedBy(1, 2, "run");
    const registered = (await c.register(0, runId, dev.addr.port)).body;
    await c.dialOwner(registered, dev.addr.port);
    await c.listed(0, runId, 1);
    const { id, url } = registered;
    const cookie = await c.enter(0, 0, runId, id);
    const as = { host: c.host(id), cookie, origin: url, "sec-fetch-site": "same-origin" };
    const work: Promise<unknown>[] = [];
    for (const pod of [0, 1]) {
      // Plain requests, answered.
      for (let i = 0; i < 20; i++) work.push(c.hit(pod, `/r${i}`, as));
      // WebSockets, answered and dropped; refused ones, without a cookie and from elsewhere.
      for (let i = 0; i < 4; i++) work.push(c.upgradeTo(c.ports[pod].public, as, true));
      work.push(c.upgradeTo(c.ports[pod].public, { host: c.host(id), origin: url }));
      work.push(c.upgradeTo(c.ports[pod].public, { ...as, origin: "https://evil.example" }));
      // Event streams the browser walks away from.
      for (let i = 0; i < 4; i++) {
        work.push(
          streaming(
            c.ports[pod].public,
            `GET /forever HTTP/1.1\r\nhost: ${c.host(id)}\r\ncookie: ${cookie}\r\n` +
              `origin: ${url}\r\naccept: text/event-stream\r\n\r\n`,
          ).then((socket) => void socket.destroy()),
        );
      }
      // A request abandoned before its answer.
      const early = connect({ host: "127.0.0.1", port: c.ports[pod].public });
      early.on("error", () => {});
      early.write(`GET / HTTP/1.1\r\nhost: ${c.host(id)}\r\ncookie: ${cookie}\r\n\r\n`);
      early.destroy();
    }
    const results = await Promise.all(work);
    const statuses = results.filter((r): r is Reply => typeof r === "object" && r !== null);
    assertEquals(statuses.map((r) => r.status), statuses.map(() => 200));
    assertEquals(results.filter((r) => r === 101).length, 8);
    assertEquals(results.filter((r) => r === 401).length, 2);
    assertEquals(results.filter((r) => r === 403).length, 2);
    for (const pod of [0, 1]) {
      const budget = c.pods[pod].budget;
      await c.eventually(
        () => budget.open === 0 && budget.waiting === 0,
        `pod ${pod} still holds ${budget.open} streams`,
      );
    }
  } finally {
    await c.stop();
    await dev.shutdown();
  }
});

test("cluster: one replica is no cluster: no peer listener, no tunnel address of its own", async () => {
  const pod = await previews({
    token: TOKEN,
    domain: DOMAIN,
    cluster: { self: 0, peers: [{ host: "127.0.0.1", tunnelPort: 1, apiPort: 1, peerPort: 2 }] },
  });
  try {
    assertEquals(pod.peer, null);
    await new Promise<void>((resolve) => pod.api.listen(0, "127.0.0.1", resolve));
    const port = (pod.api.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/internal/previews`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ runId: "r-1", port: 5173, label: "App", hosts: [] }),
    });
    assertEquals(response.status, 201);
    const { id, ticket, tunnelBase } = await response.json();
    assertMatch(ticket, /^[a-f0-9]{64}$/);
    // The control plane's own address for the service applies, as it always has.
    assertEquals(tunnelBase, undefined);
    assertEquals(id.slice(0, 8), await shardOf(k, "r-1"));
  } finally {
    await pod.shutdownPublic();
    pod.close();
    await new Promise<void>((resolve) => pod.api.close(() => resolve()));
  }
  // An ordinal outside the replicas is a configuration error, not a pod that owns nothing.
  let refused = false;
  try {
    await previews({
      token: TOKEN,
      domain: DOMAIN,
      cluster: {
        self: 2,
        peers: [{ host: "a", tunnelPort: 1, apiPort: 1, peerPort: 2 }, {
          host: "b",
          tunnelPort: 1,
          apiPort: 1,
          peerPort: 2,
        }],
      },
    });
  } catch {
    refused = true;
  }
  assert(refused);
});

test("cluster: a refusal is logged once a while per run and reason, and says nothing secret", async () => {
  const warned: { event: string; fields?: Record<string, unknown> }[] = [];
  let clock = Date.now();
  // Ordinal 1 is not there at all: every relay to it fails to connect.
  const pod = await previews({
    token: TOKEN,
    domain: DOMAIN,
    now: () => clock,
    cluster: {
      self: 0,
      peers: [
        { host: "127.0.0.1", tunnelPort: 1, apiPort: 1, peerPort: 1 },
        { host: "127.0.0.1", tunnelPort: 1, apiPort: 1, peerPort: 1 },
      ],
    },
    log: { info() {}, warn: (event, fields) => warned.push({ event, fields }) },
  });
  await new Promise<void>((resolve) => pod.public.listen(0, "127.0.0.1", resolve));
  const port = (pod.public.address() as { port: number }).port;
  try {
    const runId = await runOwnedBy(1, 2, "gone");
    const id = await previewId(k, runId, 5173);
    const cookie = `__Host-ryph-preview=${await viewerCookie(k, id, clock)}`;
    const get = () =>
      new Promise<number>((resolve, reject) => {
        const req = request({
          host: "127.0.0.1",
          port,
          path: "/",
          agent: false,
          headers: { host: `${id}.${DOMAIN}`, cookie },
        }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        });
        req.on("error", reject);
        req.end();
      });
    assertEquals(await get(), 503);
    assertEquals(await get(), 503);
    const shard = await shardOf(k, runId);
    assertEquals(warned, [{
      event: "preview.refused",
      fields: { shard, reason: "peer unreachable", cap: "peer", folded: 0 },
    }]);
    // A while later, the next one says how many were folded in.
    clock += 10_000;
    assertEquals(await get(), 503);
    assertEquals(warned[1], {
      event: "preview.refused",
      fields: { shard, reason: "peer unreachable", cap: "peer", folded: 1 },
    });
  } finally {
    await pod.shutdownPublic();
    pod.close();
  }
});

test("cluster: relays hold at most their share of a pod, whichever runs they are for", async () => {
  // A pod whose relays are two runs' relay caps, and three quiet runs' viewers relayed by it.
  const q = await silentOwner(undefined, 4 * PER_RELAY.open);
  try {
    assertEquals(q.pod.budget.relays, 2 * PER_RELAY.open);
    const fits = PER_RELAY.open;
    const ids = [q.id];
    for (const name of ["quiet-b", "quiet-c"]) {
      ids.push(await previewId(k, await runOwnedBy(1, 2, name), 5173));
    }
    for (const id of ids) {
      const cookie = `__Host-ryph-preview=${await viewerCookie(k, id, Date.now())}`;
      for (let i = 0; i < fits + 4; i++) {
        q.send(`GET / HTTP/1.1\r\nhost: ${id}.${DOMAIN}\r\ncookie: ${cookie}\r\n\r\n`);
      }
    }
    // Two runs' relays reach the owner; the third waits, though the pod has room: the runs it owns
    // keep theirs.
    await until(() => q.held.size === 2 * fits, `${q.held.size} relays held`);
    assertEquals(q.pod.budget.relayed, q.pod.budget.relays);
    // Every request is parsed and in line only some time after its bytes were sent.
    const waiting = 3 * (fits + 4) - 2 * fits;
    await until(() => q.pod.budget.waiting === waiting, `${q.pod.budget.waiting} waiting`);
    assertEquals(q.pod.budget.relaysWaiting, waiting);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(q.held.size, 2 * fits);
  } finally {
    await q.stop();
  }
});

test("cluster: a relayed request carries what is left of its wait, and the owner waits no longer", async () => {
  // The owner's side: an owner whose peer listener records what it is sent.
  const heard: IncomingHttpHeaders[] = [];
  const owner = (await import("node:http")).createServer((req, res) => {
    heard.push(req.headers);
    res.end("ok");
  });
  await new Promise<void>((resolve) => owner.listen(0, "127.0.0.1", resolve));
  const port = (owner.address() as { port: number }).port;
  const pod = await previews({
    token: TOKEN,
    domain: DOMAIN,
    cluster: {
      self: 0,
      peers: [
        { host: "127.0.0.1", tunnelPort: 1, apiPort: 1, peerPort: 1 },
        { host: "127.0.0.1", tunnelPort: port, apiPort: port, peerPort: port },
      ],
    },
  });
  await new Promise<void>((resolve) => pod.public.listen(0, "127.0.0.1", resolve));
  try {
    const id = await previewId(k, await runOwnedBy(1, 2, "waits"), 5173);
    const cookie = `__Host-ryph-preview=${await viewerCookie(k, id, Date.now())}`;
    const reply = await new Promise<number>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: (pod.public.address() as { port: number }).port,
        path: "/",
        agent: false,
        headers: {
          host: `${id}.${DOMAIN}`,
          cookie,
          // A client's own word on it is never passed on.
          [WAIT_HEADER]: "999999",
        },
      }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end();
    });
    assertEquals(reply, 200);
    const left = Number(heard[0][WAIT_HEADER]);
    assert(left <= WAIT_MS && left > WAIT_MS - 5_000, `${left} ms left`);
    assertEquals(heard[0][PEER_HEADER], await peerCredential(k));
  } finally {
    await pod.shutdownPublic();
    pod.close();
    owner.closeAllConnections();
    await new Promise<void>((resolve) => owner.close(() => resolve()));
  }

  // The owner's side: a run at its cap, and a relayed request with little of its wait left.
  const dev = await devServer();
  const c = await cluster(2);
  const streams: Duplex[] = [];
  try {
    const runId = await runOwnedBy(1, 2, "run");
    const registered = (await c.register(1, runId, dev.addr.port)).body;
    await c.dialOwner(registered, dev.addr.port);
    await c.listed(1, runId, 1);
    const cookie = await c.enter(1, 1, runId, registered.id);
    const full = PER_RUN.open;
    for (let i = 0; i < full; i++) {
      streams.push(
        await streaming(
          c.ports[1].public,
          `GET /forever HTTP/1.1\r\nhost: ${c.host(registered.id)}\r\ncookie: ${cookie}\r\n\r\n`,
        ),
      );
    }
    assertEquals(c.pods[1].budget.openBy(runId), full);
    const started = Date.now();
    const relayed = await c.raw(c.ports[1].peer, "/", {
      host: c.host(registered.id),
      cookie,
      [PEER_HEADER]: await peerCredential(k),
      [WAIT_HEADER]: "200",
    });
    assertEquals(relayed.status, 503);
    assert(Date.now() - started < 3_000, `waited ${Date.now() - started} ms`);
  } finally {
    for (const stream of streams) stream.destroy();
    await c.stop();
    await dev.shutdown();
  }
});

test("cluster: only the public listener keeps an idle connection past the balancer's reuse", async () => {
  const c = await cluster(2);
  try {
    for (const pod of c.pods) {
      assert(pod.public.keepAliveTimeout > 600_000);
      // A relay is a connection of its own, closed after its request: nothing to keep.
      assert(pod.peer!.keepAliveTimeout < 600_000);
      // Every listener has a ceiling, and no request timeout of its own.
      for (const listener of [pod.public, pod.peer!, pod.tunnel, pod.api]) {
        assert(listener.maxConnections > 0 && Number.isFinite(listener.maxConnections));
        assertEquals(listener.requestTimeout, 0);
      }
      // At most every other pod's relays at once, and a margin.
      assertEquals(pod.peer!.maxConnections, pod.budget.relays + 64);
    }
  } finally {
    await c.stop();
  }
});

/** A browser that sent `head` and stopped reading once the answer's head came: how its socket
 * ends once it reads again (`reset`, `end`, or `open`). A reset can be lost on the way to a socket
 * whose window it fell outside (seen on macOS), so once what it reads goes quiet it sends a byte
 * (`poke`), which a reset server's kernel answers with another; a graceful close shows as `end`
 * first. */
async function stalledBrowser(
  port: number,
  head: string,
  opts: { body?: Uint8Array; poke?: Uint8Array } = {},
) {
  const socket = connect({ host: "127.0.0.1", port });
  let got = "";
  const headed = Promise.withResolvers<void>();
  const onData = (chunk: Uint8Array) => {
    got += Buffer.from(chunk).toString("latin1");
    if (!got.includes("\r\n\r\n")) return;
    socket.off("data", onData);
    socket.pause();
    headed.resolve();
  };
  socket.on("data", onData);
  const ended = new Promise<string>((resolve) => {
    socket.on(
      "error",
      (error: NodeJS.ErrnoException) =>
        resolve(error.code === "ECONNRESET" ? "reset" : `error ${error.code}`),
    );
    socket.on("end", () => resolve("end"));
  });
  socket.write(head);
  await headed.promise;
  if (opts.body) socket.write(opts.body);
  return {
    head: got,
    outcome: (ms = 3_000) => {
      socket.on("data", () => {});
      socket.resume();
      let read = -1;
      const poke = setInterval(() => {
        if (socket.bytesRead === read && !socket.destroyed) socket.write(opts.poke ?? "x");
        read = socket.bytesRead;
      }, 200);
      const timer = setTimeout(() => clearInterval(poke), ms);
      return Promise.race([
        ended,
        new Promise<string>((resolve) => setTimeout(() => resolve("open"), ms)),
      ]).finally(() => {
        clearInterval(poke);
        clearTimeout(timer);
        socket.destroy();
      });
    },
  };
}

/** What `pod`'s streams hold that their readers have not taken, in all. */
const heldOn = (pod: Previews) =>
  [...pod.budget.usage().values()].reduce((sum, use) => sum + use.buffered, 0);

test("cluster: a relayed download or WebSocket cut under pressure resets the browser, on whichever pod it is cut", async () => {
  const dev = await devServer();
  const c = await cluster(2);
  try {
    const runId = await runOwnedBy(1, 2, "run");
    const registered = (await c.register(0, runId, dev.addr.port)).body;
    await c.dialOwner(registered, dev.addr.port);
    await c.listed(0, runId, 1);
    const cookie = await c.enter(0, 0, runId, registered.id);
    const host = c.host(registered.id);
    const as = `host: ${host}\r\ncookie: ${cookie}\r\norigin: ${registered.url}\r\n`;
    // A download the browser stopped reading, through pod 0 to the owner (pod 1): cut on the pod
    // in front (its relay), then on the owner (its tunnel stream, which resets the relay).
    for (const cutOn of [0, 1]) {
      const browser = await stalledBrowser(
        c.ports[0].public,
        `GET /endless HTTP/1.1\r\n${as}\r\n`,
      );
      assertMatch(browser.head, /^HTTP\/1\.1 200 /);
      await c.eventually(
        () => heldOn(c.pods[cutOn]) > SEND_BUFFER,
        `pod ${cutOn} holds what the browser does not read`,
      );
      assert(c.pods[cutOn].budget.relieve("high", () => true).closed >= 1);
      assertEquals(await browser.outcome(), "reset", `cut on pod ${cutOn}`);
      await c.eventually(() => c.pods[0].budget.open === 0, "the relay let go");
      await c.eventually(() => c.pods[1].budget.open === 0, "the owner let go");
    }
    // A WebSocket whose browser sends and reads nothing back: the echo backs up to it. Cut on the
    // owner, the browser's socket on pod 0 is reset all the same.
    // Binary, masked (with a zero key), 60,000 bytes long.
    const frame = new Uint8Array(8 + 60_000);
    frame[0] = 130;
    frame[1] = 254;
    new DataView(frame.buffer).setUint16(2, 60_000);
    const frames = new Uint8Array(frame.byteLength * 64);
    for (let i = 0; i < 64; i++) frames.set(frame, i * frame.byteLength);
    const ws = await stalledBrowser(
      c.ports[0].public,
      `GET /hmr HTTP/1.1\r\n${as}connection: Upgrade\r\nupgrade: websocket\r\n` +
        "sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      // Its poke a frame of its own: a stray byte would break the WebSocket, and a dev server
      // that closes it for that would end it gracefully.
      { body: frames, poke: new Uint8Array([130, 129, 0, 0, 0, 0, 120]) },
    );
    assertMatch(ws.head, /^HTTP\/1\.1 101 /);
    await c.eventually(() => heldOn(c.pods[1]) > 0, "the owner holds the echo");
    assert(c.pods[1].budget.relieve("high", () => true).closed >= 1);
    // A reset lost on its way to pod 0's relay (its window full) is found by its next probe of
    // the owner, seconds later.
    assertEquals(await ws.outcome(15_000), "reset");
    await c.eventually(() => c.pods[0].budget.open === 0, "the relay let go");
    await c.eventually(() => c.pods[1].budget.open === 0, "the owner let go");
  } finally {
    await c.stop();
    await dev.shutdown();
  }
});

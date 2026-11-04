// The tool guard: the one entry point onto the tools network — the one container of hosted MCP
// servers that is also on an ordinary network, and the only one that is ever published. A
// token-gated, byte-streaming reverse proxy — nothing MCP-aware happens here; Streamable HTTP is
// plain HTTP with SSE responses.
//
//   /<key>/mcp  →  http://ryph-tool-<key>[.…]:<port><path>   (only with the right X-Ryph-Tool-Token)
//   anything else → 401 (no token, wrong token) or 404 (right token, no such route)
//
// Why it exists: the gateway must reach
// hosted servers, which sit on a network that confines them (internal under docker, a namespace
// with NetworkPolicies under Kubernetes), and on docker from a host process that means publishing
// something to the host — and a published port is reachable from run containers through the
// host. So nothing a vendor ships is ever published or on any other network; this is, on loopback
// only where published, and it answers nobody who lacks the token the gateway minted at boot and
// handed over in this container's env. A run holds a virtual MCP token, never this one. It dials
// only the tools network; vendors reach the internet through the egress relay, never through it.
//
// Configuration, all from env (the gateway relaunches the guard when any of it changes):
//   RYPH_TOOL_GUARD_TOKEN    the token; ≥ 32 characters or the guard refuses to start
//   RYPH_TOOL_ROUTES         `key=host:port/path`, comma-separated — possibly empty. The key is a
//                            launch key (32 hex) and the host must be that key's container,
//                            `ryph-tool-<key>`, or a DNS name under it (a Kubernetes Service):
//                            a route to any other host is refused at boot, so a path names one
//                            launch's container and no other
//   RYPH_TOOL_CALLER_TOKENS `key=token`, comma-separated: for a server that authenticates its
//                            callers, the token the guard presents as `Authorization: Bearer`
//   RYPH_TOOL_GUARD_PORT     the listen port, 8080 by default
//
// The header name and route format are the gateway's (packages/mcp-gateway/src/core/
// tool_guard.ts); this program cannot import it, so the two are kept in step by hand — and by
// the gateway's test suite, which drives this file.
//
// Three deliberate rewrites on the way through, and no others:
// - the token header is STRIPPED: the hosted server never sees it
// - a route with a caller token gets `Authorization: Bearer <it>`, replacing whatever came in:
//   that server refuses anyone else, which is what keeps another hosted server on the tools
//   network (or a run, where the network does not isolate: OrbStack) from using it
// - Host is `localhost:<port>`: MCP servers commonly default a DNS-rebinding allowlist to
//   loopback names (mcp-grafana ≥ 1.4 answers 403 to anything else), and the guard — not a Host
//   header — is what gates this hop. Origin is dropped for the same reason. node:http does the
//   dialling because fetch will not send a Host of the caller's choosing.
//
// It imports nothing but node's built-ins, so it builds without the workspace: the listener at
// the bottom is its own small node:http adapter rather than @ryph/service's serve.

import http from "node:http";
import { Readable } from "node:stream";

export const TOKEN_HEADER = "x-ryph-tool-token";

export interface GuardRoute {
  host: string;
  port: number;
  path: string;
  /** Presented as `Authorization: Bearer …` on this route, when the server wants one. */
  callerToken?: string;
}

/** `key=host:port/path,…` → routes by launch key. Throws on anything malformed, and on a host that
 * is not the key's own container: fail at boot, loudly. */
export function parseRoutes(raw: string): Map<string, GuardRoute> {
  const routes = new Map<string, GuardRoute>();
  for (const item of raw.split(",").map((s) => s.trim()).filter((s) => s !== "")) {
    const match = item.match(/^([0-9a-f]{32})=([a-z0-9.-]+):(\d{1,5})(\/[A-Za-z0-9._~/-]*)$/);
    if (match === null) throw new Error(`malformed route ${JSON.stringify(item)}`);
    const [, key, host, port, path] = match;
    const name = `ryph-tool-${key}`;
    if (host !== name && !host.startsWith(`${name}.`)) {
      throw new Error(`the route for ${key} names another container (${host})`);
    }
    if (routes.has(key)) throw new Error(`duplicate route for ${key}`);
    routes.set(key, { host, port: Number(port), path });
  }
  return routes;
}

/** `key=token,…` merged onto routes already parsed. A token for an unknown key is a boot error. */
export function applyCallerTokens(routes: Map<string, GuardRoute>, raw: string): void {
  for (const item of raw.split(",").map((s) => s.trim()).filter((s) => s !== "")) {
    const match = item.match(/^([0-9a-f]{32})=([A-Za-z0-9._~-]{16,512})$/);
    if (match === null) throw new Error("malformed caller token entry");
    const route = routes.get(match[1]);
    if (route === undefined) throw new Error(`caller token for unknown route ${match[1]}`);
    route.callerToken = match[2];
  }
}

/** Headers that describe one hop and must not be copied to the next. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-authenticate",
]);

export type Forward = (
  target: { host: string; port: number; path: string },
  init: {
    method: string;
    headers: Headers;
    body: ReadableStream<Uint8Array> | null;
    signal: AbortSignal;
  },
) => Promise<Response>;

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Compared as digests, so the comparison is constant-time over a fixed length. */
async function sameToken(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function plain(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function makeGuard(
  opts: { token: string; routes: Map<string, GuardRoute>; forward?: Forward },
): (req: Request) => Promise<Response> {
  const forward = opts.forward ?? nodeForward;
  return async (req) => {
    const presented = req.headers.get(TOKEN_HEADER);
    if (presented === null || !(await sameToken(presented, opts.token))) {
      return plain(401, "unauthorized");
    }
    const url = new URL(req.url);
    const key = url.pathname.match(/^\/([0-9a-f]{32})\/mcp$/)?.[1];
    const route = key === undefined ? undefined : opts.routes.get(key);
    if (route === undefined) return plain(404, "no such route");

    const headers = new Headers();
    for (const [name, value] of req.headers) {
      if (HOP_BY_HOP.has(name) || name === TOKEN_HEADER || name === "host" || name === "origin") {
        continue;
      }
      headers.set(name, value);
    }
    headers.set("host", `localhost:${route.port}`);
    if (route.callerToken !== undefined) {
      headers.set("authorization", `Bearer ${route.callerToken}`);
    }
    try {
      const upstream = await forward(
        { host: route.host, port: route.port, path: `${route.path}${url.search}` },
        { method: req.method, headers, body: req.body, signal: req.signal },
      );
      const out = new Headers();
      for (const [name, value] of upstream.headers) {
        if (!HOP_BY_HOP.has(name)) out.set(name, value);
      }
      return new Response(upstream.body, { status: upstream.status, headers: out });
    } catch (err) {
      console.error(`guard: ${key} unreachable: ${err instanceof Error ? err.message : err}`);
      return plain(502, "the hosted server did not answer");
    }
  };
}

/** One request over node:http — the only client here that sends the Host it is given. */
export const nodeForward: Forward = (target, init) =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of init.headers) headers[name] = value;
    const out = http.request({
      host: target.host.replace(/^\[|\]$/g, ""),
      port: target.port,
      path: target.path,
      method: init.method,
      headers,
      setHost: false,
    }, (res) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(name, v);
      }
      const nullBody = res.statusCode === 204 || res.statusCode === 304 || init.method === "HEAD";
      if (nullBody) res.resume();
      resolve(
        new Response(
          nullBody ? null : Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>,
          { status: res.statusCode ?? 502, headers: responseHeaders },
        ),
      );
    });
    out.on("error", reject);
    init.signal.addEventListener("abort", () => out.destroy(new Error("client went away")));
    (async () => {
      if (init.body !== null) {
        for await (const chunk of init.body) out.write(chunk);
      }
      out.end();
    })().catch((err) => out.destroy(err));
  });

/** A request body as a web stream, paused while unread, ERRORED if the client cuts it short. */
function bodyOf(req: http.IncomingMessage): ReadableStream<Uint8Array> {
  let settled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (chunk: Buffer) => {
        if (settled) return;
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if ((controller.desiredSize ?? 0) <= 0) req.pause();
      });
      req.once("end", () => {
        if (settled) return;
        settled = true;
        controller.close();
      });
      const cut = (err?: Error) => {
        if (settled) return;
        settled = true;
        controller.error(err ?? new Error("the request body was cut short"));
      };
      req.once("error", cut);
      req.once("close", () => {
        if (!req.complete) cut();
      });
    },
    pull() {
      req.resume();
    },
    cancel() {
      settled = true;
      req.resume();
    },
  }, { highWaterMark: 64 * 1024, size: (chunk) => chunk?.byteLength ?? 0 });
}

/** Writes `response` out, its headers at once (an SSE client waits on them), then its body. */
async function respond(res: http.ServerResponse, method: string, response: Response) {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") headers[name] = value;
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (response.body === null || method === "HEAD") {
    await response.body?.cancel().catch(() => {});
    res.end();
    return;
  }
  res.flushHeaders();
  const reader = response.body.getReader();
  const gone = () => void reader.cancel().catch(() => {});
  res.once("close", gone);
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      if (res.destroyed) return;
      if (!res.write(chunk.value)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.on("drain", done);
          res.on("close", done);
        });
      }
    }
    res.end();
  } catch (err) {
    // After the headers only a reset can say the body failed: the client reads an error, not
    // a clean end.
    res.destroy(err instanceof Error ? err : new Error(String(err)));
  } finally {
    res.off("close", gone);
  }
}

/**
 * The guard's listener: node:http carrying a fetch Request in and a Response out, both streamed.
 * `req.signal` aborts when the client goes away (or the answer is done), which is what stops the
 * upstream request. Resolves once bound.
 */
export function listen(
  opts: { hostname: string; port: number },
  handler: (req: Request) => Promise<Response>,
): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    const method = req.method ?? "GET";
    let request: Request;
    try {
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      }
      // Concatenated, never resolved: `//elsewhere/x` is a path here, not another origin.
      request = new Request(`http://localhost${req.url ?? "/"}`, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : bodyOf(req),
        signal: abort.signal,
        duplex: "half",
      } as RequestInit);
    } catch {
      res.writeHead(400).end();
      return;
    }
    try {
      await respond(res, method, await handler(request));
    } catch (err) {
      console.error(`guard: ${err instanceof Error ? err.message : err}`);
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.hostname, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

if (import.meta.main) {
  const token = process.env.RYPH_TOOL_GUARD_TOKEN ?? "";
  if (token.length < 32) {
    console.error("guard: RYPH_TOOL_GUARD_TOKEN is missing or too short — refusing to start");
    process.exit(2);
  }
  let routes: Map<string, GuardRoute>;
  try {
    routes = parseRoutes(process.env.RYPH_TOOL_ROUTES ?? "");
    applyCallerTokens(routes, process.env.RYPH_TOOL_CALLER_TOKENS ?? "");
  } catch (err) {
    // Never echoes the value: the caller-token variable is a secret.
    console.error(`guard: bad route table: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
  const port = Number(process.env.RYPH_TOOL_GUARD_PORT ?? "8080");
  await listen({ hostname: "0.0.0.0", port }, makeGuard({ token, routes }));
  console.error(`guard: listening on :${port}, ${routes.size} route(s)`);
  // As PID 1 this process has no default action for a signal it does not handle; without these a
  // stop waits out the grace period and ends in SIGKILL.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => process.exit(0));
  }
}

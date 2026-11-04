// Serving the embedded SvelteKit app.
//
// adapter-node emits `build/handler.js`, whose only export is a polka-style Node middleware
// `(req, res, next)`. The runtime's `node:http` runs that directly, so there is no
// Request↔IncomingMessage bridging to write and nothing to keep in step with SvelteKit's
// internals — the middleware is the whole contract.
//
// Two listeners, one process: the app here, the control plane on `serve()` beside it. That
// mirrors what the networked deployment does, so the app's BFF dials the control plane the same
// way in both and no path→upstream logic differs between them. The one exception is the
// forge's two webhook doors, which this front door hands to the forge itself (`guardApp`), as
// the Helm chart's front door routes them: the GitLab hook URL the repo page shows is on
// RYPH_APP_URL.

import http from "node:http";
import { Readable } from "node:stream";
import {
  allowedHosts,
  bindAddresses,
  bindFailure,
  bindOrder,
  classifyBind,
  hostAllowed,
  isIPv4,
  isWildcard,
  listenNode,
  misdirected,
  urlHost,
} from "@ryph/host";
import { isLoopbackHost } from "@ryph/shared/net";
import { APP_BUILD_DIR, embeddedDirExists } from "./embedded.ts";

export interface AppServer {
  describe: string;
  shutdown: () => Promise<void>;
}

export interface ServeAppOptions {
  port: number;
  /** Where the app's BFF should proxy API calls — this process's own control plane. */
  apiUrl: string;
  /** The origin browsers reach the app on. SvelteKit refuses form POSTs without it. */
  origin: string;
  /** RYPH_APP_BIND: addresses to listen on besides loopback, comma-separated (`appBinds`). */
  hostname?: string;
  /** RYPH_ALLOWED_HOSTS: names beyond loopback's and the origin's that the app answers to. */
  allowedHosts?: string;
  /** Where GitHub's and GitLab's webhook deliveries go (`FORGE_HOOK_PATHS`): the forge's base
   * URL, or null where there is no forge to hand them to. */
  forgeUrl?: string | null;
}

/**
 * adapter-node's request body limit. Its default, 512 KiB, would refuse a check bundle that
 * `ryph checks` uploads through the /api proxy long before the forge's own 100 MiB cap; the
 * margin keeps the forge the one that answers "too large".
 */
export const APP_BODY_SIZE_LIMIT = "110M";

/** How long the embedded app waits for a whole request to arrive. */
export const APP_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The environment adapter-node reads at import: the origin and the control plane this process
 * decided, the body limit unless the operator set one, and GitLab sign-in's app half. Beside the
 * in-process forge that half is derived from the forge's own settings, as compose.yaml derives
 * it, so the app sends people to the instance and OAuth application the forge redeems codes
 * with; without RYPH_GITLAB_CLIENT_ID it is empty and the app offers no GitLab sign-in. Beside a
 * forge elsewhere (RYPH_FORGE_URL) this process cannot see that pair, so PUBLIC_GITLAB_URL and
 * PUBLIC_GITLAB_CLIENT_ID set here are kept, as GitHub's are, and the RYPH_GITLAB_* ones stand in
 * only where they are unset.
 */
export function appEnv(
  opts: Pick<ServeAppOptions, "origin" | "apiUrl">,
  get: (name: string) => string | undefined,
): Record<string, string> {
  const own = get("RYPH_FORGE_URL") !== "embedded";
  return {
    ORIGIN: opts.origin,
    RYPH_API_URL: opts.apiUrl,
    BODY_SIZE_LIMIT: get("BODY_SIZE_LIMIT") || APP_BODY_SIZE_LIMIT,
    PUBLIC_GITLAB_URL: (own && get("PUBLIC_GITLAB_URL")) || get("RYPH_GITLAB_URL") ||
      "https://gitlab.com",
    PUBLIC_GITLAB_CLIENT_ID: (own && get("PUBLIC_GITLAB_CLIENT_ID")) ||
      get("RYPH_GITLAB_CLIENT_ID") || "",
  };
}

/**
 * The addresses the app listens on: loopback and whatever RYPH_APP_BIND lists, as RYPH_BIND reads
 * (`bindAddresses`, which reads `localhost` as 127.0.0.1), and ::1 beside them. Links and RYPH_APP_URL say `localhost`, which a browser
 * tries as ::1 first, so an app on 127.0.0.1 alone would let anything holding [::1] on the same
 * port take the single-use login token. `optional` is ::1 when the list covers no IPv6 loopback
 * (::1 or `::`): a machine with no IPv6 has no ::1 to bind, and nothing can hold one there
 * either. Pure and exported for the test.
 */
export function appBinds(raw: string | undefined): { required: string[]; optional: string[] } {
  const required = bindAddresses(raw);
  const covered = required.some((a) => a.includes(":") && (isLoopbackHost(a) || isWildcard(a)));
  return { required, optional: covered ? [] : ["::1"] };
}

/**
 * Whether a browser can reach the app at RYPH_APP_URL, given the app's binds (`appBinds`): the
 * one link `up` prints and opens is built on it. Host's `remoteRunReach` asks the same of the
 * URLs runs dial. Loopback, a bound address and an address a wildcard covers answer. Any other
 * address literal on the app's own port never can, so it is refused. On another port, or as a
 * name other than localhost, it may be a reverse proxy or a forward on this machine that
 * delivers to loopback, which this process cannot see, so it is only warned of while only
 * loopback is bound. Null when it answers. Pure and exported for the test.
 */
export function appReach(
  appUrl: string,
  binds: { required: string[]; optional: string[] },
  appPort: number,
): { refuse: string } | { warn: string } | null {
  const parsed = URL.parse(appUrl);
  const host = parsed?.hostname.toLowerCase();
  if (parsed === null || host === undefined || isLoopbackHost(host)) return null;
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  const all = [...binds.required, ...binds.optional];
  if (all.map(urlHost).includes(host)) return null;
  const said = `RYPH_APP_URL=${appUrl} names ${host}, but the web UI listens only on ${
    binds.required.join(", ")
  }`;
  const v6 = host.startsWith("[");
  if ((isIPv4(host) || v6) && port === appPort) {
    if (all.includes("::") || (!v6 && all.includes("0.0.0.0"))) return null;
    return {
      refuse: `${said}. Add that address to RYPH_APP_BIND (comma-separated; loopback stays ` +
        "bound either way)",
    };
  }
  if (!binds.required.every(isLoopbackHost)) return null;
  return {
    warn: `${said}. That works only if it delivers to this machine's loopback, as a reverse ` +
      "proxy on it does; if the login link does not load, add the address it reaches to " +
      "RYPH_APP_BIND",
  };
}

/**
 * One listener per address, all serving `listener`, on serveOn's bind policy (`bindOrder`,
 * `classifyBind`) with nothing to wait for. A required address that cannot bind throws
 * bindFailure's message; an optional one is skipped only when the address does not exist (no
 * IPv6) — anything else, another server on [::1] above all, throws too. An IPv4 address `::`
 * already holds is skipped as covered. Once listening, a server's later
 * `error` (EMFILE on accept, say) goes to `onError`: with no listener it would be thrown at the
 * process and take the control plane beside it down. Exported for the test.
 */
export async function listenAll(
  listener: http.RequestListener,
  binds: { required: string[]; optional: string[] },
  port: number,
  serverOptions: http.ServerOptions = {},
  onError: (err: Error) => void = (err) => console.error(`the web UI: ${err.message}`),
): Promise<http.Server[]> {
  const servers: http.Server[] = [];
  const bound: string[] = [];
  const listen = (hostname: string) => {
    const server = http.createServer(serverOptions, listener);
    // listenNode: the bind error's real code, which `classifyBind` reads (Bun's node:http calls
    // a missing ::1 EADDRINUSE).
    return listenNode(server, port, hostname).then(() => {
      server.on("error", onError);
      return server;
    });
  };
  for (const hostname of bindOrder(binds.required, binds.optional)) {
    try {
      servers.push(await listen(hostname));
      bound.push(hostname);
    } catch (err) {
      const optional = !binds.required.includes(hostname);
      if (classifyBind(hostname, err, { bound, optional }) !== "fatal") continue;
      await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
      throw new Error(bindFailure("the web UI", "RYPH_APP_BIND", hostname, port, err));
    }
  }
  return servers;
}

/** A fetch Response, written to a node:http one. */
async function send(res: http.ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(await response.text());
}

/**
 * The forge's webhook doors, exact, that the front door hands to the forge: the URLs a GitHub
 * App and a GitLab project are told to deliver to are on RYPH_APP_URL, as the Helm chart's
 * Ingress routes the same two paths. Nothing else of the forge's is reachable here — the
 * Radicle bridge's mailbox (`/v1/hooks/radicle`) is the forge's internal door, and the
 * automations' `/v1/hooks/<id>` is the control plane's.
 */
export const FORGE_HOOK_PATHS: ReadonlySet<string> = new Set([
  "/v1/hooks/github",
  "/v1/hooks/gitlab",
]);

/**
 * The forge the front door hands webhook deliveries to, as the host wires it from
 * RYPH_FORGE_URL: the in-process forge on 127.0.0.1 at RYPH_FORGE_PORT, a forge elsewhere at its
 * URL, and none for the recording fake or no forge at all. Pure and exported for the test.
 */
export function forgeHooksUrl(
  forgeUrl: string | undefined,
  forgePort: string | undefined,
): string | null {
  const url = forgeUrl?.trim();
  if (!url || url === "noop") return null;
  if (url === "embedded") return `http://127.0.0.1:${forgePort?.trim() || 7412}`;
  return url;
}

/** Headers that describe one hop, not the delivery, and are not passed on. */
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "host",
  "content-length",
]);

/** The origin a request target is resolved against, to tell origin-form from anything else. */
const PLACEHOLDER_ORIGIN = "http://ryph.invalid";

/**
 * A request's target as a URL, when it is origin-form (`/path?query`), and null for anything
 * else: an absolute-form `http://host/…`, a protocol-relative `//host/…` (or `/\host/…`, which
 * the URL parser reads the same), or `*`. Only origin-form names nothing but a path, so only
 * it is served: any other form could name a host of its own for the forge hand-off to reach.
 */
function originFormTarget(target: string | undefined): URL | null {
  if (!target?.startsWith("/") || target.startsWith("//")) return null;
  const url = URL.parse(target, PLACEHOLDER_ORIGIN);
  return url?.origin === PLACEHOLDER_ORIGIN ? url : null;
}

/**
 * Where a delivery to `target` goes on the forge at `forgeUrl`: the forge's own origin with the
 * target's path and query, and nothing else of the target. Throws if that would leave the
 * forge's origin, which `originFormTarget` already rules out.
 */
export function forgeHookTarget(forgeUrl: string, target: URL): URL {
  const forge = new URL(forgeUrl);
  const upstream = new URL(forge.origin);
  upstream.pathname = target.pathname;
  upstream.search = target.search;
  if (upstream.origin !== forge.origin) {
    throw new Error(`a webhook delivery would leave the forge for ${upstream.origin}`);
  }
  return upstream;
}

/** Whether a request is a delivery to one of the forge's webhook doors (`FORGE_HOOK_PATHS`). */
function isForgeHook(req: http.IncomingMessage, target: URL): boolean {
  return req.method === "POST" && FORGE_HOOK_PATHS.has(target.pathname);
}

/**
 * A webhook delivery, passed to the forge at `forgeUrl` with its path, query, headers and body,
 * and the forge's answer passed back. A forge that does not answer is a 502, which GitHub and
 * GitLab both count as a failed delivery and retry.
 */
async function forwardToForge(
  forgeUrl: string,
  target: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const headers = new Headers();
  const named = new Set(
    String(req.headers.connection ?? "").split(",").map((n) => n.trim().toLowerCase()),
  );
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_HEADERS.has(name) || named.has(name)) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  let answer: Response;
  try {
    const response = await fetch(
      forgeHookTarget(forgeUrl, target),
      {
        method: "POST",
        headers,
        body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
        duplex: "half",
        redirect: "manual",
      } as RequestInit & { duplex: "half" },
    );
    const out = new Headers();
    response.headers.forEach((value, name) => {
      if (!HOP_HEADERS.has(name)) out.set(name, value);
    });
    // A 204 (or 304) carries no body, and a Response refuses one, empty or not.
    const body = [204, 205, 304].includes(response.status) ? null : await response.arrayBuffer();
    answer = new Response(body, { status: response.status, headers: out });
  } catch (err) {
    console.error(`the web UI: a webhook delivery found no forge: ${String(err)}`);
    req.resume();
    answer = new Response("the forge did not answer\n", { status: 502 });
  }
  await send(res, answer);
}

/**
 * The app's middleware behind the Host check, refusing any other name with the control plane's
 * own 421 (`misdirected`). A delivery to one of the forge's webhook doors (`FORGE_HOOK_PATHS`)
 * goes to the forge at `forgeUrl` instead, whatever name it arrives under, as the forge and the
 * control plane exempt their own deliveries (`isHookDelivery`): senders deliver through tunnels
 * and proxies this process was never told of, each delivery is verified by its own secret, and
 * no browser credential rides on it. Before either, a request target that is not origin-form
 * (`originFormTarget`) is a 400, so no target can name the host a delivery is handed to.
 * Exported for the test.
 */
export function guardApp(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void,
  hosts: Set<string> | null,
  forgeUrl: string | null = null,
): http.RequestListener {
  return (req, res) => {
    const target = originFormTarget(req.url);
    if (target === null) {
      req.resume();
      res.statusCode = 400;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("the request target must be a path\n");
      return;
    }
    if (forgeUrl !== null && isForgeHook(req, target)) {
      void forwardToForge(forgeUrl, target, req, res);
      return;
    }
    if (!hostAllowed(req.headers.host ?? null, hosts)) {
      void send(res, misdirected(req.headers.host ?? null));
      return;
    }
    handler(req, res, () => {
      res.statusCode = 404;
      res.end("not found");
    });
  };
}

/**
 * Starts the embedded app, or returns null when this build carries no app (running from source
 * before `npm run build`). Throws `bindFailure`'s message when a listener cannot bind, which the
 * caller turns into ending `up`.
 */
export async function serveEmbeddedApp(opts: ServeAppOptions): Promise<AppServer | null> {
  if (!(await embeddedDirExists(APP_BUILD_DIR))) return null;

  // adapter-node reads these at import time, so they must be set BEFORE the dynamic import.
  //
  // ORIGIN in particular cannot be baked in at build time: SvelteKit's CSRF check compares it to
  // the request's Origin header, and the port this process actually bound is only known now. Get
  // it wrong and every form POST — logging in, above all — is rejected as cross-site.
  for (const [name, value] of Object.entries(appEnv(opts, (n) => process.env[n]))) {
    process.env[name] = value;
  }

  const handlerPath = `${APP_BUILD_DIR}/handler.js`;
  const { handler } = await import(`file://${handlerPath}`) as {
    handler: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void;
  };

  // Loopback plus whatever RYPH_APP_BIND lists, and only the names this app is reached by: a
  // page whose own DNS name was pointed at 127.0.0.1 would otherwise be same-origin with it,
  // cookies and all (see @ryph/host's local_surface.ts). The refusal is the control plane's.
  const binds = appBinds(opts.hostname);
  const hosts = allowedHosts({
    binds: binds.required,
    urls: [opts.origin],
    extra: opts.allowedHosts,
  });

  // A request may take half an hour to arrive, not node:http's default five minutes: a check
  // bundle (up to 100 MiB) on a slow uplink takes longer than that, and the app's body limit,
  // not a clock, is what bounds it. Headers keep their own, shorter timeout. node:http enforces
  // this one only on its connection sweep, every 30 s (`connectionsCheckingInterval`): a test
  // with a timeout of a few seconds and a body of a few more sees it ignored, while a 2 s
  // timeout under the default sweep answered a 35 s upload with a 408 at 30 s (measured under
  // Deno 2.9.5's node:http, before the move to Bun; not re-measured since).
  const servers = await listenAll(
    guardApp(handler, hosts, opts.forgeUrl ?? null),
    binds,
    opts.port,
    {
      requestTimeout: APP_REQUEST_TIMEOUT_MS,
    },
  );

  return {
    describe: `${opts.origin} · embedded`,
    shutdown: async () => {
      await Promise.all(
        servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
      );
    },
  };
}

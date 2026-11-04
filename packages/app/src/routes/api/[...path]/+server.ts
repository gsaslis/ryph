import { error, type RequestHandler } from "@sveltejs/kit";
import {
  clientHeaders,
  proxySecretHeaders,
  RYPH_API_URL,
  RYPH_AUTOMATIONS_URL,
  RYPH_CHAT_URL,
  RYPH_HISTORY_URL,
  RYPH_MCP_GATEWAY_CONTROL_URL,
  RYPH_MEMORY_URL,
  RYPH_MODEL_PROXY_CONTROL_URL,
} from "$lib/server/auth";
import {
  forwardedResponseHeaders,
  isAppRoutePath,
  isCrossSiteNavigation,
  isForwardablePath,
  isHistoryReadPath,
  upstreamAuthorization,
} from "./path";

/** Provider-key management, the provider registry and the usage reports, which a standalone
 * model-proxy serves on its control listener: the key collection, one key, its archive action,
 * a ChatGPT plan key's model refresh, the plan sign-ins, the provider collection, one provider and
 * its archive action, the platform policy, and usage for a window or one run. The proxy's INTERNAL surface is never routed here — that one is
 * service-authed and belongs to the control plane, not to a browser. */
const PROVIDER_KEY_PATH =
  /^v1\/(provider-keys(\/[^/]+(\/archive|\/chatgpt-plan\/models)?)?|chatgpt-plan\/sign-ins(\/[^/]+)?|providers(\/[^/]+(\/archive)?)?|platform-model-policy|model-usage(\/runs\/[^/]+)?)$/;

/** MCP-server management — the collection, one server, its probe, restart and logs actions —
 * the hosting catalogue, and a run's tool-call trail, all of which a standalone mcp-gateway
 * serves on its control listener. A server's ARCHIVE is not here: the control plane fronts it
 * (it refuses while an agent still uses the server), so it falls through to RYPH_API_URL. The
 * gateway's INTERNAL surface (minting a run's token, the archive itself) is service-authed and
 * never routed here, and its data plane is what agent containers dial, on a different port
 * again. */
const MCP_CONTROL_PATH =
  /^v1\/(mcp-servers(\/[^/]+(\/(probe|restart|logs))?)?|mcp-catalogue|mcp-usage\/[^/]+)$/;

/** Automation CRUD and fire history, which the automations service serves. This also catches
 * /v1/automations/events — the control plane's service-authed door — which a browser has no
 * business calling: routed here it answers a plain 404. The ingestion URL (/v1/hooks/*) is the
 * sender's door, not a browser's, and is not proxied at all. */
const AUTOMATIONS_PATH = /^v1\/automations(\/[^/]+(\/[a-z-]+)?)?$/;

/** The memory manager — the canon (one memory, its pin, unpin and retire actions), the inbox
 * (one proposal, its accept and reject actions), the subject index and the consolidate action —
 * all of which a standalone memory service serves on its listener. Its INTERNAL surface (a run's
 * brief and outcome) is service-authed and belongs to the control plane, and its MCP route is
 * what the gateway forwards a run's tool calls to; neither is ever routed here. */
const MEMORY_PATH =
  /^v1\/(memories(\/[^/]+(\/(pin|unpin|retire))?)?|memory-proposals(\/[^/]+(\/(accept|reject))?)?|memory\/(subjects|consolidate|health|brief-preview|sources(\/[^/]+(\/(withdraw|move))?)?|embeddings\/backfill))$/;

/** Chatroom management — the collection, one room, its rename and archive, and the channels and
 * groups a command-room form picks from — which the chat service serves. Its INTERNAL surface
 * (bindings, commander checks, thread reads — the control plane's) and its MCP route (what the
 * gateway forwards a run's posts to) are never routed here. A room's command POLICY is the
 * control plane's, and lives at /v1/command-rooms/:id precisely so that it falls through to
 * RYPH_API_URL below instead of matching here. */
const CHAT_PATH = /^v1\/chatrooms(\/[^/]+(\/(archive|channels|groups))?)?$/;

/** Where each path goes, first match wins. `controlPlane` marks the orchestrator's own routes,
 * the only ones the proxy secret goes to: a service beside it is not one, even when its URL falls
 * back to the same origin. */
type Route = { matches: (path: string) => boolean; base: string; controlPlane: boolean };

const ROUTES: Route[] = [
  { matches: isHistoryReadPath, base: RYPH_HISTORY_URL, controlPlane: false },
  {
    matches: (p) => PROVIDER_KEY_PATH.test(p),
    base: RYPH_MODEL_PROXY_CONTROL_URL,
    controlPlane: false,
  },
  {
    matches: (p) => MCP_CONTROL_PATH.test(p),
    base: RYPH_MCP_GATEWAY_CONTROL_URL,
    controlPlane: false,
  },
  { matches: (p) => AUTOMATIONS_PATH.test(p), base: RYPH_AUTOMATIONS_URL, controlPlane: false },
  { matches: (p) => MEMORY_PATH.test(p), base: RYPH_MEMORY_URL, controlPlane: false },
  { matches: (p) => CHAT_PATH.test(p), base: RYPH_CHAT_URL, controlPlane: false },
  { matches: () => true, base: RYPH_API_URL, controlPlane: true },
];

/**
 * Same-origin proxy to the control plane. The browser never talks to the
 * orchestrator directly (no CORS, no client-side tokens) — this route
 * forwards `/api/v1/*` and attaches the bearer token from the httpOnly
 * auth cookies (via locals) — or, with no cookie token and on the CLI's bearer doors only, the
 * caller's own bearer, which is how a token holder outside the browser reaches the API where only
 * this app is public. History reads go to the historian, provider-key management to
 * the model-proxy, MCP-server management to the mcp-gateway, the memory manager to the memory
 * service and chatrooms to the chat service, each of which is the orchestrator origin unless a
 * standalone one is configured — the same user bearer works at all six, because they verify
 * the same JWKS.
 */
const handler: RequestHandler = async (event) => {
  const { request, url, locals } = event;
  const path = url.pathname.replace(/^\/api\//, "");
  if (isCrossSiteNavigation(request.headers)) error(403, "forbidden");
  if (!isForwardablePath(path) || isAppRoutePath(path)) error(404, "not found");

  const { base, controlPlane } = ROUTES.find((r) => r.matches(path))!;
  const target = new URL(`${base}/${path}`);
  target.search = url.search;

  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  // SSE resume: a reconnecting EventSource presents the last event id it saw.
  const lastEventId = request.headers.get("last-event-id");
  if (lastEventId) headers.set("last-event-id", lastEventId);
  // A request body's length, so a service that caps an upload (a check bundle) can refuse an
  // oversized one before reading it. Node's fetch sends it with the streamed body below.
  const contentLength = request.headers.get("content-length");
  if (contentLength) headers.set("content-length", contentLength);
  const authorization = upstreamAuthorization(
    locals.accessToken,
    request.headers.get("authorization"),
    request.method,
    path,
  );
  if (authorization) headers.set("authorization", authorization);
  // Who is calling, as this server saw it — what session rows record and what the anonymous
  // budgets (a link tried too often) are keyed on. The proxy secret that vouches for it goes to
  // the control plane only, never to the services beside it.
  for (const [name, value] of Object.entries(clientHeaders(event))) headers.set(name, value);
  if (controlPlane) {
    for (const [name, value] of Object.entries(proxySecretHeaders())) headers.set(name, value);
  }

  // Streamed, not buffered: a check bundle can be as large as the forge's bundle cap, and this
  // server has no reason to hold one in memory on its way through.
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;

  const res = await fetch(target, {
    method: request.method,
    headers,
    body,
    // Required by fetch for a stream body: the request is sent while it is still being read.
    // An upload is answered only once it has been taken in (a check bundle: once the forge has
    // staged it, up to the control plane's 10-minute deadline), and Bun's fetch, which the
    // embedded app runs on, gives up on a response silent for its idle timeout (300 s, fired on
    // a coarse tick) however much goes up. Node ignores `timeout`. The streams that come DOWN
    // (SSE) carry their own keepalives and keep the default.
    ...(body ? { duplex: "half", timeout: false } : {}),
  } as RequestInit);

  return new Response(res.body, {
    status: res.status,
    headers: forwardedResponseHeaders(res.headers),
  });
};

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;

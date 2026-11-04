// The data plane: one `Request → Response` handler on `/v1/mcp/:runId/:slug` that authenticates
// a run's virtual token, enforces its frozen scope, and forwards the JSON-RPC traffic to the real
// MCP server with the real credential.
//
// The model-proxy's doctrine holds — hash the presented token, one row lookup, one row read, a
// pure `decide()`, then a streamed passthrough — with the minimum of JSON-RPC awareness the tool
// allowlist needs, and no more:
// - the REQUEST body is bounded and parsed (tool arguments, small) to read `method` and, for
//   `tools/call`, the tool's name. A name outside the allowlist answers -32601, indistinguishable
//   from a tool that does not exist. A batch is refused: it would be an allowlist bypass. So is a
//   message another parser could read differently (see core/jsonrpc.ts), and what is forwarded
//   is the judged message re-serialised, never the client's bytes.
// - the METHOD is default-denied to the handful a client needs — initialize, ping, the four
//   client notifications, tools/list, tools/call. resources/*, prompts/*, completion/*, logging/* and
//   every vendor extension answer -32601 and a `denied` usage row WITHOUT dialing upstream: a
//   scope that bounds tools but not capabilities is not a boundary.
// - the `tools/list` RESPONSE is the one thing buffered (capped) and rewritten: tools outside the
//   allowlist are removed, so the model never sees them.
// - everything the method allowlist admits streams: initialize, ping, notifications, client
//   responses to server→client requests, the standalone server→client GET stream,
//   Mcp-Session-Id. Upstream's session id is upstream's and leaks nothing.
// - credentials are substituted AT THE EDGE: the inbound bearer (our virtual token) is never
//   forwarded, the unsealed upstream headers are set on the outbound request only, and headers
//   travel by ALLOWLIST both ways — a credential-substituting proxy must not carry a stray cookie.
//
// Invariants:
// - the REAL credential exists in plaintext only inside this handler's forward call, never in a
//   response, a log, or an error message
// - the allowlists — method and tool — are enforced HERE, server-side: anything the harness does
//   in-container is a courtesy, this is the control
// - caps REJECT WHILE STREAMING, never buffer-then-check: request body, tools/list body and the
//   time to read it, the time to upstream's headers, per-run concurrency, per-run open streams,
//   the run's total request budget, and the response byte count all cut a call off the moment it
//   crosses the line. A tool can return megabytes; amplification is real.
// - metering is taken BEFORE the request is judged: a denied call costs a row and a connection
//   like an allowed one, so it counts like one.
// - usage recording is fire-and-forget: the audit trail must never fail or slow a tool call

import { decide } from "../core/enforce.ts";
import { isMethodAllowed, isToolAllowed } from "../core/enforce.ts";
import {
  filterToolsListResponse,
  parseClientBody,
  refusalMessage,
  rpcError,
  UPSTREAM_REJECTED,
} from "../core/jsonrpc.ts";
import type { McpServer, McpUsageStatus } from "../core/types.ts";
import { checkUpstreamUrl, type UpstreamPolicy } from "../core/upstream_guard.ts";
import { guardHeaders } from "../core/hosting.ts";
import { PLATFORM_RUN_ID_HEADER } from "../core/platform.ts";
import type { ToolGuardAccess } from "../core/tool_guard.ts";
import type { GatewayStore } from "../ports/gateway_store.ts";
import { json, readCappedBytes, readCappedText } from "@ryph/shared/http";
import { INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR } from "@ryph/shared/mcp";
import { bearerToken, type SealBinding, sha256Hex } from "@ryph/sealed";
import {
  hostedDial,
  type HostedRefusal,
  type HostedRouteState,
  mcpCredentialBinding,
  startingRefusal,
} from "../core/sealing.ts";
import type { HostedOutlook } from "../core/hosting.ts";
import {
  CREDENTIAL_HEADER_REFUSED,
  credentialHeadersProblem,
  redactSent,
} from "../core/credential_headers.ts";
import { neverReached } from "@ryph/service";
import { SECRET_REQUIRED } from "../core/types.ts";

export interface GatewayDiag {
  debug(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
}

/** Every line the data plane cuts a call off at, and the defaults a deployment starts with. */
export interface GatewayLimits {
  /** A JSON-RPC request body: tool arguments. */
  requestBodyBytes: number;
  /** A buffered `tools/list` response. */
  toolsListBytes: number;
  /** Any other POST response, counted as it streams. The GET stream is not capped in bytes: it
   *  is a low-volume notification channel that legitimately lives for the whole session, and what
   *  bounds it is `perRunGetStreams` instead. */
  responseBytes: number;
  /** How long upstream may take to answer with HEADERS; the body may then stream for as long as
   *  it likes. */
  upstreamHeadersTimeoutMs: number;
  /** How long the ONE buffered read — `tools/list` — may take in total. A cap bounds how much an
   *  upstream sends, not how long it takes; a stream that never closes needs a deadline. */
  toolsListReadMs: number;
  /** Concurrent POSTs per run, across its servers. */
  perRunInFlight: number;
  /** Concurrent server→client GET streams per run. Each one holds an upstream socket for as long
   *  as it lives, so the number of them is the bound, not their size. */
  perRunGetStreams: number;
  /** Every request a run may make through the gateway, across its whole life — denied ones
   *  included, because a denied call costs a row and a connection like any other. */
  perRunRequests: number;
  /** How long an upstream URL's policy verdict is trusted before the name is resolved again. */
  upstreamCheckTtlMs: number;
}

export const DEFAULT_LIMITS: GatewayLimits = {
  requestBodyBytes: 1 * 1024 * 1024,
  toolsListBytes: 4 * 1024 * 1024,
  responseBytes: 32 * 1024 * 1024,
  upstreamHeadersTimeoutMs: 30_000,
  toolsListReadMs: 30_000,
  perRunInFlight: 16,
  perRunGetStreams: 4,
  perRunRequests: 10_000,
  upstreamCheckTtlMs: 60_000,
};

/**
 * Where a `platform` row's calls go, by slug. The row itself carries only a marker URL; this is
 * the deployment saying "memory is at this address, with this credential" — in-process under the
 * single binary (a `fetch` over the service's handler), a URL and a service token standalone. A
 * platform row with no entry here answers 502: the server exists, the deployment did not wire it.
 */
export type PlatformUpstreams = Record<string, {
  /** The providing service's MCP route. */
  url: string;
  /** The credential the gateway presents to it — a service token only the gateway holds. */
  token: string;
  /** How to dial it; the process-wide upstream fetch when absent. */
  fetch?: typeof fetch;
}>;

export interface GatewayHandlerDeps {
  store: GatewayStore;
  /** Unseals a server's credential — built by the composition root from the master key. */
  decrypt(sealed: string, binding: SealBinding): Promise<string>;
  now(): Date;
  diag: GatewayDiag;
  /** Where the gateway may dial (see core/upstream_guard.ts), with the platform's resolver. */
  upstream: UpstreamPolicy;
  /** The outbound fetch; injectable for tests. */
  upstreamFetch?: typeof fetch;
  /**
   * The tool guard a hosted row is reached through, and its token — the one header the data
   * plane adds beside a server's own credential. Absent where this gateway hosts nothing.
   */
  toolGuard?: () => ToolGuardAccess | null;
  /**
   * The launch key this gateway routes for a hosted row, and whether the guard serves it yet
   * (core/hosting.ts `route`): which refusal a row whose key is not served gets. Where a row is
   * dialled is its own key, computed from the row (core/sealing.ts `hostedDial`). Absent: nothing
   * hosted is dialled.
   */
  hostedRoute?: (serverId: string) => HostedRouteState | null;
  /** For a hosted row with nothing routed: whether a launch is coming here, and why not — what
   * the refusal says (core/sealing.ts `hostedRefusal`). Absent: it hosts nothing. */
  hostedOutlook?: (server: McpServer) => HostedOutlook;
  /**
   * Whether a hosted row's route, or the guard in front of it, is being or was (re)launched moments
   * ago (core/hosting.ts `settling`): a connection the guard refused then is one still coming up,
   * answered `hosted_starting` rather than an uncoded 502. Absent: never.
   */
  hostedSettling?: (serverId: string) => boolean;
  /** The platform servers this deployment wired, by slug. Absent: none are reachable. */
  platform?: PlatformUpstreams;
  limits?: Partial<GatewayLimits>;
}

/**
 * Request headers the data plane forwards. Everything else — above all Authorization — is
 * dropped. `last-event-id` rides a POST only: see the forward below for why a GET may not resume.
 */
export const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
] as const;

/** Response headers the data plane returns. No Set-Cookie, no WWW-Authenticate, no upstream server banners. */
export const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "cache-control",
] as const;

const PATH = new URLPattern({ pathname: "/v1/mcp/:runId/:slug" });

function rpc(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

/**
 * Passes a body through while counting it: past the cap the stream errors (the client sees a
 * truncated response, upstream sees a cancel), and `done` fires exactly once however it ends —
 * drained, cut, cancelled by the client, or failed mid-stream by upstream.
 */
function meterStream(
  source: ReadableStream<Uint8Array>,
  max: number,
  done: (overflow: boolean) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let seen = 0;
  let finished = false;
  const finish = (overflow: boolean) => {
    if (finished) return;
    finished = true;
    done(overflow);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        // Upstream's body broke (a reset). The rejection errors this stream for the client; no
        // cancel will ever come, so the slot is released here or never.
        finish(false);
        throw err;
      }
      if (chunk.done) {
        controller.close();
        finish(false);
        return;
      }
      seen += chunk.value.byteLength;
      if (seen > max) {
        controller.error(new Error("response exceeds the gateway's cap"));
        reader.cancel().catch(() => {});
        finish(true);
        return;
      }
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
      finish(false);
    },
  });
}

/** What one run has spent, and is spending right now, across every server in its scope. */
interface RunMeter {
  /** POSTs in flight. */
  posts: number;
  /** GET streams open. */
  gets: number;
  /** Requests made, ever — the budget. */
  total: number;
  lastMs: number;
}

/** How long an idle run's counters are kept before they are swept, and how often we look. A run
 *  outlives any single request, so the entry cannot be dropped when it reaches zero. */
const METER_IDLE_MS = 24 * 60 * 60 * 1000;
const METER_SWEEP_MS = 60_000;

export function makeGatewayHandler(deps: GatewayHandlerDeps): (req: Request) => Promise<Response> {
  const upstreamFetch = deps.upstreamFetch ?? fetch;
  const limits: GatewayLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const meters = new Map<string, RunMeter>();
  let nextSweepMs = 0;

  /** The run's counters, creating them if this is its first call — and, at most once a minute,
   *  forgetting the runs that have gone quiet, so a long-lived gateway does not accumulate one
   *  entry per run it has ever served. */
  const meterFor = (runId: string, nowMs: number): RunMeter => {
    if (nowMs >= nextSweepMs) {
      nextSweepMs = nowMs + METER_SWEEP_MS;
      for (const [id, m] of meters) {
        if (m.posts === 0 && m.gets === 0 && nowMs - m.lastMs > METER_IDLE_MS) meters.delete(id);
      }
    }
    const found = meters.get(runId);
    if (found !== undefined) {
      found.lastMs = nowMs;
      return found;
    }
    const fresh: RunMeter = { posts: 0, gets: 0, total: 0, lastMs: nowMs };
    meters.set(runId, fresh);
    return fresh;
  };
  // (kind, row, url) → when its verdict expires. Only OK verdicts are cached: a refusal is
  // re-checked every time, so a fixed DNS record recovers on the next call rather than after the
  // TTL. Keyed on the row as well as the url: a verdict is about a row's url, and one row's must
  // never stand in for another's. Hosted rows never come here (see the dial below).
  const upstreamOkUntil = new Map<string, number>();

  const upstreamAllowed = async (server: McpServer): Promise<boolean> => {
    const nowMs = deps.now().getTime();
    const key = JSON.stringify([server.kind, server.id, server.url]);
    const until = upstreamOkUntil.get(key);
    if (until !== undefined && until > nowMs) return true;
    const verdict = await checkUpstreamUrl(server, deps.upstream);
    if (!verdict.ok) {
      deps.diag.warn("gateway.upstream_refused_by_policy", {
        serverId: server.id,
        reason: verdict.reason,
        detail: verdict.detail,
      });
      return false;
    }
    upstreamOkUntil.set(key, nowMs + limits.upstreamCheckTtlMs);
    return true;
  };

  return async (req) => {
    const match = PATH.exec(req.url);
    if (!match) return json(404, { error: "not found" });
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      return json(405, { error: "method not allowed" });
    }
    // A malformed percent-escape throws URIError, which serve turns into a bare 500 and a
    // logged rejection — free log volume and a misleading error rate for any unauthenticated
    // caller that can reach this listener. It is not a path we know, so it is the 404 above.
    let runId: string;
    let slug: string;
    try {
      runId = decodeURIComponent(match.pathname.groups.runId ?? "");
      slug = decodeURIComponent(match.pathname.groups.slug ?? "");
    } catch {
      return json(404, { error: "not found" });
    }

    const token = bearerToken(req);
    if (token === null) return json(401, { error: "unauthorized" });
    const virtualKey = await deps.store.getVirtualKeyByTokenHash(await sha256Hex(token));
    const scoped = virtualKey?.scope.find((s) => s.slug === slug) ?? null;
    const server = scoped === null ? null : await deps.store.getServer(scoped.serverId);

    const decision = decide(virtualKey, { runId, slug }, server, deps.now().toISOString());
    if (!decision.allow) {
      deps.diag.debug("gateway.denied", {
        runId: virtualKey?.runId,
        slug,
        status: decision.status,
      });
      return json(decision.status, {
        error: decision.error,
        ...(decision.code === undefined ? {} : { code: decision.code }),
      });
    }
    const { allowedTools } = decision.scoped;
    const startedMs = deps.now().getTime();

    // ── Metering: the run's budget and its slots, taken BEFORE anything is read or judged ─────
    // A denied call costs a usage row and a database connection exactly like an allowed one, so
    // it must count exactly like one. Taking the slot after the allowlist check left the cheapest
    // path of all — a loop of calls to a tool that does not exist — entirely unmetered.
    const meter = meterFor(runId, startedMs);
    if (meter.total >= limits.perRunRequests) {
      deps.diag.warn("gateway.run_budget_spent", { runId, total: meter.total });
      return json(429, { error: "this run has spent its gateway request budget" });
    }
    meter.total += 1;
    /** Takes one of the run's concurrency slots, or reports that they are all held. */
    const take = (kind: "posts" | "gets", max: number): (() => void) | null => {
      if (meter[kind] >= max) return null;
      meter[kind] += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        meter[kind] -= 1;
      };
    };
    let release = () => {};
    if (req.method === "POST") {
      const slot = take("posts", limits.perRunInFlight);
      if (slot === null) return json(429, { error: "too many concurrent requests for this run" });
      release = slot;
    } else if (req.method === "GET") {
      // A GET holds an upstream socket for as long as the session lives, and nothing bounds how
      // many a run may open — so the count is the bound.
      const slot = take("gets", limits.perRunGetStreams);
      if (slot === null) return json(429, { error: "too many open streams for this run" });
      release = slot;
    }

    const record = (
      method: string,
      tool: string | null,
      status: McpUsageStatus,
      httpStatus: number | null,
    ) => {
      deps.store.recordUsage({
        runId,
        serverId: decision.server.id,
        method,
        tool,
        status,
        httpStatus,
        durationMs: Math.max(0, deps.now().getTime() - startedMs),
        at: deps.now().toISOString(),
      }).catch((err) => deps.diag.warn("gateway.usage_write_failed", { err: String(err) }));
    };

    try {
      // ── The request: bounded, parsed, allowlisted ──────────────────────────────────────────
      let body: string | undefined;
      let method: string | null = null;
      let id: string | number | null = null;
      let tool: string | null = null;
      if (req.method === "POST") {
        const read = await readCappedBytes(req, limits.requestBodyBytes);
        if (!read.ok) return json(413, { error: "request body too large" });
        const parsed = parseClientBody(read.bytes);
        if (!parsed.ok) {
          deps.diag.debug("gateway.message_refused", { runId, slug, reason: parsed.reason });
          // No id is echoed: the message was refused because it could be read more than one way.
          const code = parsed.reason === "invalid_json" || parsed.reason === "invalid_utf8"
            ? PARSE_ERROR
            : INVALID_REQUEST;
          return rpc(400, rpcError(null, code, refusalMessage(parsed.reason)));
        }
        // What upstream gets is what was judged below, re-serialised — never the client's bytes,
        // which a parser that reads JSON differently could take for another method or tool.
        body = parsed.canonical;
        ({ method, id, toolName: tool } = parsed.message);
        // Default-deny on the METHOD, before the tool: the scope bounds what this credential can
        // do, not only which tools it can name. resources/*, prompts/*, completion/*, logging/*
        // and anything vendor-specific are refused here, without dialing upstream.
        if (method !== null && !isMethodAllowed(method)) {
          deps.diag.debug("gateway.method_denied", { runId, slug, method });
          record(method, null, "denied", null);
          return rpc(200, rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`));
        }
        if (method === "tools/call" && (tool === null || !isToolAllowed(allowedTools, tool))) {
          deps.diag.debug("gateway.tool_denied", { runId, slug, tool });
          record(method, tool, "denied", null);
          return rpc(200, rpcError(id, METHOD_NOT_FOUND, `Unknown tool: ${tool ?? ""}`));
        }
      }

      const hostedRefused = (refusal: HostedRefusal): Response => {
        deps.diag.warn("gateway.hosted_refused", {
          serverId: decision.server.id,
          code: refusal.code,
        });
        if (method !== null) record(method, tool, "error", null);
        return json(refusal.status, { error: refusal.error, code: refusal.code });
      };

      // A hosted row is dialled at its own launch key on the guard, computed from the row as read
      // here (core/sealing.ts `hostedDial`), never at its stored url or by its slug: that address
      // reaches the container launched from exactly what the credential below is bound to, or
      // nothing — whatever changes between here and the dial.
      let hostedTarget: string | null = null;
      if (decision.server.kind === "hosted") {
        const routed = await hostedDial({
          route: deps.hostedRoute,
          outlook: deps.hostedOutlook,
          guardOrigin: () => deps.toolGuard?.()?.origin ?? null,
        }, decision.server);
        if (!routed.ok) return hostedRefused(routed.refusal);
        hostedTarget = routed.target;
      } else if (!(await upstreamAllowed(decision.server))) {
        if (method !== null) record(method, tool, "error", null);
        return json(502, { error: "upstream refused by gateway policy" });
      }

      // ── The forward: allowlisted headers, the real credential, a bounded wait for headers ──
      const headers = new Headers();
      for (const name of FORWARDED_REQUEST_HEADERS) {
        // `last-event-id` is refused on the GET stream. The filter only ever runs on the POST
        // that asked for the list, so a resumed stream would be relayed unfiltered — and a
        // resumable upstream replays whatever followed that id, tool list included. The POST
        // that carries one is still filtered on the way back, so it stays allowed there.
        if (name === "last-event-id" && req.method !== "POST") continue;
        const value = req.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      /** Every secret header value this request carries: taken out of any error it throws. */
      const carried: string[] = [];
      if (decision.server.encryptedAuth !== null) {
        // Bound to the row as it stands: a credential sealed for another url (or container)
        // opens nothing, and nothing is sent.
        let real: Record<string, string>;
        try {
          real = JSON.parse(
            await deps.decrypt(
              decision.server.encryptedAuth,
              mcpCredentialBinding(decision.server),
            ),
          ) as Record<string, string>;
        } catch {
          // A fixed line: the error of a parse would quote the plaintext it choked on.
          deps.diag.warn("gateway.unseal_failed", { serverId: decision.server.id });
          if (method !== null) record(method, tool, "error", null);
          return json(409, {
            error: "this server's credential must be entered again by an admin before runs " +
              "can use it",
            code: SECRET_REQUIRED,
          });
        }
        // Held at the API, and again here for a row written straight into the database: a name
        // that steers the request is refused, and one `Headers` would throw on is not a 500.
        const refused = credentialHeadersProblem(real);
        if (refused !== null) {
          deps.diag.warn("gateway.credential_header_refused", { serverId: decision.server.id });
          if (method !== null) record(method, tool, "error", null);
          return json(502, {
            error: `this server's stored credential cannot be sent: ${refused}`,
            code: CREDENTIAL_HEADER_REFUSED,
          });
        }
        carried.push(...Object.values(real));
        try {
          for (const [name, value] of Object.entries(real)) headers.set(name, value);
        } catch {
          // `Headers` quotes the value it refuses — the credential — in its error: never let that
          // reach a log line or a response. Held by the check above; this is its backstop.
          deps.diag.warn("gateway.credential_header_refused", { serverId: decision.server.id });
          if (method !== null) record(method, tool, "error", null);
          return json(502, {
            error: "this server's stored credential cannot be sent as a header",
            code: CREDENTIAL_HEADER_REFUSED,
          });
        }
      }
      // Last, so no sealed header can shadow it. A run never sees this value: it rides only the
      // hop from here to the guard, and the guard strips it before the hosted server does.
      const guard = guardHeaders(decision.server, deps.toolGuard?.() ?? null);
      for (const [name, value] of Object.entries(guard)) headers.set(name, value);
      carried.push(...Object.values(guard));

      // A platform row: the address and credential are the deployment's, not the row's, and the
      // run's id rides a header the inbound allowlist never carries — so the service trusts this
      // gateway for exactly one claim, which run is calling, and derives the rest itself.
      let dial = upstreamFetch;
      let target = decision.server.url;
      if (decision.server.kind === "platform") {
        const platform = deps.platform?.[decision.server.slug];
        if (platform === undefined) {
          deps.diag.warn("gateway.platform_unwired", { slug: decision.server.slug });
          if (method !== null) record(method, tool, "error", null);
          return json(502, { error: "this platform server is not configured on this deployment" });
        }
        headers.set("authorization", `Bearer ${platform.token}`);
        carried.push(platform.token);
        headers.set(PLATFORM_RUN_ID_HEADER, runId);
        dial = platform.fetch ?? upstreamFetch;
        target = platform.url;
      }

      if (hostedTarget !== null) target = hostedTarget;
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(new Error("upstream headers timeout")),
        limits.upstreamHeadersTimeoutMs,
      );
      let upstream: Response;
      try {
        upstream = await dial(target, {
          method: req.method,
          headers,
          body,
          signal: AbortSignal.any([req.signal, timeout.signal]),
          // The guard judged THIS url. Following a redirect would carry the real credential and
          // the body to a target it never judged — a public host bouncing us to a private one.
          redirect: "manual",
          // The GET notification stream is quiet for as long as the server has nothing to say,
          // and a slow tool's streamed answer may send nothing until it is done. Bun's fetch
          // gives up on a response that long silent (its idle timeout: 300 s, fired on a coarse
          // tick), which Deno's never did. Bounded instead by the headers timer above and the
          // caller: `req.signal` ends the call when the client goes.
          timeout: false,
        } as RequestInit);
      } catch (err) {
        deps.diag.warn("gateway.upstream_unreachable", {
          serverId: decision.server.id,
          err: redactSent(String(err), carried),
        });
        if (method !== null) record(method, tool, "error", null);
        // The guard refusing the connection (or its name not resolving) while it is being
        // relaunched, just was, or for a row whose launch has not been seen to answer yet, is a
        // launch still coming up. Only a connection never made: a timeout or a reset mid-call
        // may have reached the server, and stays the 502.
        if (
          decision.server.kind === "hosted" && neverReached(err) &&
          (decision.server.host?.status === "starting" ||
            deps.hostedSettling?.(decision.server.id) === true)
        ) {
          const starting = startingRefusal();
          return json(starting.status, { error: starting.error, code: starting.code });
        }
        return json(502, { error: "upstream unreachable" });
      } finally {
        clearTimeout(timer);
      }

      const responseHeaders = new Headers();
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) responseHeaders.set(name, value);
      }

      // A redirect is refused, not followed and not relayed: the client would have nowhere to go
      // but back through us, and the probe tells the operator which URL to register instead.
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        deps.diag.warn("gateway.upstream_redirected", {
          serverId: decision.server.id,
          status: upstream.status,
        });
        if (method !== null) record(method, tool, "error", upstream.status);
        return json(502, {
          error: "upstream answered a redirect, which the gateway never follows",
        });
      }

      // Upstream refused OUR credential. Never forwarded raw — a 401 would send an SDK client
      // off to negotiate OAuth with us — but answered as a JSON-RPC error the model can read,
      // and flagged in usage so the server page can say "credential rejected".
      if (upstream.status === 401 || upstream.status === 403) {
        await upstream.body?.cancel();
        if (method !== null) record(method, tool, "rejected", upstream.status);
        if (id !== null) {
          return rpc(
            200,
            rpcError(id, UPSTREAM_REJECTED, "the upstream rejected the gateway's credential"),
          );
        }
        return json(502, { error: "the upstream rejected the gateway's credential" });
      }

      const status: McpUsageStatus = upstream.ok ? "ok" : "error";

      // ── tools/list: the one buffered, rewritten response ───────────────────────────────────
      if (method === "tools/list" && upstream.ok) {
        // The one buffered read, and so the one that needs a deadline of its own: the headers
        // timeout is spent, and a body that never ends would hold this handler — and the run's
        // slot — until the client gave up.
        const deadline = new AbortController();
        const deadlineTimer = setTimeout(() => deadline.abort(), limits.toolsListReadMs);
        let read: Awaited<ReturnType<typeof readCappedText>>;
        try {
          read = await readCappedText(upstream, limits.toolsListBytes, deadline.signal);
        } catch (err) {
          deps.diag.warn("gateway.upstream_unreachable", {
            serverId: decision.server.id,
            err: redactSent(String(err), carried),
          });
          record(method, tool, "error", upstream.status);
          return json(502, { error: "upstream unreachable" });
        } finally {
          clearTimeout(deadlineTimer);
        }
        if (!read.ok) {
          const tooLarge = read.reason === "too_large";
          deps.diag.warn(
            tooLarge ? "gateway.tools_list_too_large" : "gateway.tools_list_timeout",
            { serverId: decision.server.id },
          );
          record(method, tool, "error", upstream.status);
          return json(502, {
            error: tooLarge
              ? "upstream tool list exceeds the gateway's cap"
              : "upstream took too long to send its tool list",
          });
        }
        record(method, tool, status, upstream.status);
        // The framing is SNIFFED, not read off `content-type`: a body we cannot read is a body
        // we cannot filter, and this is the one response the allowlist rewrites. Refusing is the
        // only safe answer — passing it on would hand the model every tool name and description
        // the run may not call, which is the tool-poisoning surface the filter exists for.
        const out = filterToolsListResponse(read.text, allowedTools);
        if (out === null) {
          deps.diag.warn("gateway.tools_list_unreadable", { serverId: decision.server.id });
          return json(502, { error: "upstream's tool list could not be read, so not filtered" });
        }
        return new Response(out, { status: upstream.status, headers: responseHeaders });
      }

      // ── Everything else: a streamed passthrough, metered ───────────────────────────────────
      if (method !== null) record(method, tool, status, upstream.status);
      if (upstream.body === null) {
        return new Response(null, { status: upstream.status, headers: responseHeaders });
      }
      const held = release;
      release = () => {}; // the stream owns the slot now, and frees it however the body ends
      // A POST response is counted against the byte cap. The GET notification stream is NOT: it
      // is low-volume and legitimately lives for the whole session, so what bounds it is the
      // number of streams a run may hold open — which is the slot this one keeps until it ends.
      const max = req.method === "POST" ? limits.responseBytes : Number.POSITIVE_INFINITY;
      const metered = meterStream(upstream.body, max, (overflow) => {
        if (overflow) {
          deps.diag.warn("gateway.response_too_large", { serverId: decision.server.id, method });
        }
        held();
      });
      return new Response(metered, { status: upstream.status, headers: responseHeaders });
    } finally {
      release();
    }
  };
}

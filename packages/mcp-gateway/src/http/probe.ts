// The probe: the control side connecting to a registered server with its REAL credential to
// answer two questions the operator has — does the credential work, and which tools does the
// server expose (with the descriptions and annotations the allowlist picker shows). It is the one
// place the control side unseals a credential, and it returns nothing it unsealed.
//
// A hand-rolled MCP client of three requests — initialize, notifications/initialized, tools/list
// (paged) — over plain fetch rather than the SDK: the gateway's runtime stays dependency-free,
// and the SSE-or-JSON framing it has to read is the same one core/jsonrpc.ts already parses for
// the data plane. It ends the session politely (DELETE) when upstream handed one out, and never
// stores anything: the probe is a look, the allowlist is the operator's decision.
//
// Verdicts are structured, not HTTP codes: "the credential is rejected" and "the host is down"
// are answers about UPSTREAM the UI shows the operator, so they ride a 200 with `ok: false`.

import { messagesInResponse } from "../core/jsonrpc.ts";
import { PLATFORM_RUN_ID_HEADER } from "../core/platform.ts";
import { type McpServer, needsSecret } from "../core/types.ts";
import {
  hostedDial,
  type HostedRefusal,
  type HostedRouteState,
  mcpCredentialBinding,
} from "../core/sealing.ts";
import type { HostedOutlook } from "../core/hosting.ts";
import {
  CREDENTIAL_HEADER_REFUSED,
  credentialHeadersProblem,
  redactSent,
} from "../core/credential_headers.ts";
import type { SealBinding } from "@ryph/sealed";
import { checkUpstreamUrl, type UpstreamPolicy } from "../core/upstream_guard.ts";
import { guardHeaders } from "../core/hosting.ts";
import type { ToolGuardAccess } from "../core/tool_guard.ts";
import { readCappedText } from "@ryph/shared/http";
import { PROTOCOL_VERSION } from "@ryph/shared/mcp";
import type { PlatformUpstreams } from "./proxy.ts";

/**
 * The run id a probe of a platform row presents. The platform's services scope a run's CALLS by
 * its id but answer the handshake and `tools/list` for any id — a run they never briefed gets
 * its tools listed and every call refused as the tool's own error — so a probe, which never
 * calls a tool, can list them under an id no run will ever have.
 */
export const PROBE_RUN_ID = "probe";

export interface ProbedTool {
  name: string;
  description: string | null;
  /** The server's own claims (`readOnlyHint`, `destructiveHint`, …): hints for a human, never controls. */
  annotations: Record<string, unknown> | null;
}

export type ProbeResult =
  | {
    ok: true;
    protocolVersion: string | null;
    serverInfo: { name: string | null; version: string | null };
    tools: ProbedTool[];
  }
  | {
    ok: false;
    /** `secret_required`: the stored credential is missing or does not open, and must be entered
     * again (the data plane's `secret_required`). `credential_rejected`: upstream refused it. */
    reason: "policy" | "unreachable" | "credential_rejected" | "secret_required" | "protocol";
    detail: string;
    /** For a hosted row refused for its routing: the data plane's code (`hosted_*`). */
    code?: string;
  };

export interface ProbeDeps {
  /** Unseals a server's credential — built by the composition root from the master key. */
  decrypt(sealed: string, binding: SealBinding): Promise<string>;
  upstream: UpstreamPolicy;
  upstreamFetch?: typeof fetch;
  /** The tool guard a hosted row is reached through, and its token; absent where nothing is hosted. */
  toolGuard?: () => ToolGuardAccess | null;
  /** What this gateway routes for a hosted row, as the data plane reads it (proxy.ts). */
  hostedRoute?: (serverId: string) => HostedRouteState | null;
  /** Whether a launch is coming for a hosted row with nothing routed (see proxy.ts). */
  hostedOutlook?: (server: McpServer) => HostedOutlook;
  /**
   * The platform servers this deployment wired, by slug — the same table the data plane forwards
   * a run's calls through. A platform row is probed where a run's calls go, with the credential
   * the gateway presents there; absent, or missing the row's slug, the row is unreachable.
   */
  platform?: PlatformUpstreams;
  /** Per request, headers to body end. A probe is interactive; it must not hang the operator. */
  timeoutMs?: number;
  /** Bounds a runaway tool list. */
  maxBodyBytes?: number;
  /** Bounds `tools/list` pagination. */
  maxPages?: number;
}

const DEFAULTS = { timeoutMs: 15_000, maxBodyBytes: 4 * 1024 * 1024, maxPages: 10 };

interface RpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

export function makeProbe(deps: ProbeDeps): (server: McpServer) => Promise<ProbeResult> {
  const upstreamFetch = deps.upstreamFetch ?? fetch;
  const { timeoutMs, maxBodyBytes, maxPages } = { ...DEFAULTS, ...deps };

  const enterAgain: ProbeResult = {
    ok: false,
    reason: "secret_required",
    detail: "the stored credential cannot be used — enter it again",
  };

  /** The row's header map, opened and checked for the wire — or the verdict why it cannot be. */
  const openCredential = async (
    server: McpServer,
  ): Promise<
    { ok: true; headers: Record<string, string> } | { ok: false; result: ProbeResult }
  > => {
    if (needsSecret(server)) return { ok: false, result: enterAgain };
    if (server.encryptedAuth === null) return { ok: true, headers: {} };
    let real: Record<string, string>;
    try {
      real = JSON.parse(
        await deps.decrypt(server.encryptedAuth, mcpCredentialBinding(server)),
      ) as Record<string, string>;
    } catch {
      return { ok: false, result: enterAgain };
    }
    const refused = credentialHeadersProblem(real);
    if (refused !== null) {
      return {
        ok: false,
        result: {
          ok: false,
          // Entered again through the API, which refuses such a header, it is fixed.
          reason: "secret_required",
          detail: `the stored credential cannot be sent (${refused}) — enter it again`,
        },
      };
    }
    return { ok: true, headers: real };
  };

  /**
   * Whether the container answers at all, asked with no credential: one `initialize`, any HTTP
   * answer (a 401 included) counting. Null when it answered; the verdict when it did not.
   */
  const reach = async (
    dial: typeof fetch,
    target: URL,
    guard: Record<string, string>,
  ): Promise<ProbeResult | null> => {
    try {
      const res = await dial(target, {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", ...guard },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "ryph-mcp-gateway", version: "probe" },
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      });
      await res.body?.cancel();
      return null;
    } catch (err) {
      return {
        ok: false,
        reason: "unreachable",
        detail: redactSent(describe(err), Object.values(guard)),
      };
    }
  };

  /** A hosted row refused for its routing: the data plane's code, which the supervisor answers
   * with a relaunch from the row as it stands. */
  const refusedRoute = (refusal: HostedRefusal): ProbeResult => ({
    ok: false,
    reason: "unreachable",
    detail: refusal.error,
    code: refusal.code,
  });

  return async (server) => {
    const base = new Headers({
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    });
    let dial = upstreamFetch;
    let target: URL;
    /** Every secret header value the requests carry: taken out of any error they throw, which
     * becomes the row's `lastError` and the API's answer. */
    const carried: string[] = [];
    const said = (err: unknown) => redactSent(describe(err), carried);
    if (server.kind === "platform") {
      // A platform row: its `url` is a marker nobody dials. The address and the credential are
      // the deployment's, as they are for a run's calls, and the run id is the probe's own.
      const platform = deps.platform?.[server.slug];
      if (platform === undefined) {
        return {
          ok: false,
          reason: "unreachable",
          detail: "this platform server is not configured on this deployment",
        };
      }
      try {
        target = new URL(platform.url);
      } catch {
        return { ok: false, reason: "policy", detail: "the platform upstream is not a valid URL" };
      }
      base.set("authorization", `Bearer ${platform.token}`);
      carried.push(platform.token);
      base.set(PLATFORM_RUN_ID_HEADER, PROBE_RUN_ID);
      dial = platform.fetch ?? upstreamFetch;
    } else {
      // The data plane's rule (proxy.ts): a hosted row is dialled at its own launch key, computed
      // from the row; a key not served here is `unreachable` under the data plane's code.
      if (server.kind === "hosted") {
        const routed = await hostedDial({
          route: deps.hostedRoute,
          outlook: deps.hostedOutlook,
          guardOrigin: () => deps.toolGuard?.()?.origin ?? null,
        }, server);
        if (!routed.ok) return refusedRoute(routed.refusal);
        target = new URL(routed.target);
      } else {
        const verdict = await checkUpstreamUrl(server, deps.upstream);
        if (!verdict.ok) return { ok: false, reason: "policy", detail: verdict.detail };
        target = verdict.url;
      }
      const guard = guardHeaders(server, deps.toolGuard?.() ?? null);
      const credential = await openCredential(server);
      if (!credential.ok) {
        // A hosted container is reached first without it: a credential that cannot be used says
        // nothing about the container, and the supervisor reads this verdict as "it answers".
        if (server.kind === "hosted") {
          const unreached = await reach(dial, target, guard);
          if (unreached !== null) return unreached;
        }
        return credential.result;
      }
      carried.push(...Object.values(credential.headers), ...Object.values(guard));
      try {
        for (const [name, value] of Object.entries(credential.headers)) base.set(name, value);
        // Last, so no sealed header can shadow it: the guard answers 401 to anything else.
        for (const [name, value] of Object.entries(guard)) base.set(name, value);
      } catch {
        // `Headers` quotes what it refuses, the credential with it: a fixed verdict, never that.
        return {
          ok: false,
          reason: "secret_required",
          detail: `the stored credential cannot be sent (${CREDENTIAL_HEADER_REFUSED}) — ` +
            "enter it again",
        };
      }
    }

    let sessionId: string | null = null;
    let protocolVersion: string | null = null;
    let nextId = 1;

    type Step =
      | { ok: true; response: RpcResponse | null; status: number }
      | { ok: false; result: ProbeResult };

    const post = async (message: Record<string, unknown>): Promise<Step> => {
      const headers = new Headers(base);
      if (sessionId !== null) headers.set("mcp-session-id", sessionId);
      if (protocolVersion !== null) headers.set("mcp-protocol-version", protocolVersion);
      let res: Response;
      try {
        res = await dial(target, {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", ...message }),
          signal: AbortSignal.timeout(timeoutMs),
          // The guard judged THIS url; a redirect would carry the credential somewhere it never
          // judged. Answered as a verdict below, never followed.
          redirect: "manual",
        });
      } catch (err) {
        return {
          ok: false,
          result: { ok: false, reason: "unreachable", detail: said(err) },
        };
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        return {
          ok: false,
          result: {
            ok: false,
            reason: "protocol",
            detail: `upstream answered a ${res.status} redirect, which the gateway never follows ` +
              "— register the URL it points to instead",
          },
        };
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel();
        return {
          ok: false,
          result: {
            ok: false,
            reason: "credential_rejected",
            detail: `upstream answered ${res.status}`,
          },
        };
      }
      sessionId = res.headers.get("mcp-session-id") ?? sessionId;
      if (!res.ok) {
        await res.body?.cancel();
        return {
          ok: false,
          result: { ok: false, reason: "protocol", detail: `upstream answered ${res.status}` },
        };
      }
      if (message.id === undefined) {
        // a notification: 202 and no body is the expected answer
        await res.body?.cancel();
        return { ok: true, response: null, status: res.status };
      }
      // Counted in bytes as they arrive: a chunked body announces no length to check up front.
      let read: Awaited<ReturnType<typeof readCappedText>>;
      try {
        read = await readCappedText(res, maxBodyBytes);
      } catch (err) {
        return { ok: false, result: { ok: false, reason: "unreachable", detail: said(err) } };
      }
      if (!read.ok) {
        return {
          ok: false,
          result: { ok: false, reason: "protocol", detail: "response exceeds the probe's cap" },
        };
      }
      const response = messagesInResponse(res.headers.get("content-type"), read.text)
        .find((m): m is RpcResponse =>
          m !== null && typeof m === "object" && (m as RpcResponse).id === message.id
        );
      if (response === undefined) {
        return {
          ok: false,
          result: { ok: false, reason: "protocol", detail: "no response to our request" },
        };
      }
      if (response.error !== undefined) {
        const detail = typeof response.error.message === "string"
          ? response.error.message
          : "JSON-RPC error";
        return { ok: false, result: { ok: false, reason: "protocol", detail } };
      }
      return { ok: true, response, status: res.status };
    };

    const init = await post({
      id: nextId++,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "ryph-mcp-gateway", version: "probe" },
      },
    });
    if (!init.ok) return init.result;
    const initResult = (init.response?.result ?? {}) as {
      protocolVersion?: unknown;
      serverInfo?: { name?: unknown; version?: unknown };
    };
    protocolVersion = typeof initResult.protocolVersion === "string"
      ? initResult.protocolVersion
      : null;
    const serverInfo = {
      name: typeof initResult.serverInfo?.name === "string" ? initResult.serverInfo.name : null,
      version: typeof initResult.serverInfo?.version === "string"
        ? initResult.serverInfo.version
        : null,
    };

    const initialized = await post({ method: "notifications/initialized" });
    if (!initialized.ok) return initialized.result;

    const tools: ProbedTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const listed = await post({
        id: nextId++,
        method: "tools/list",
        params: cursor === undefined ? {} : { cursor },
      });
      if (!listed.ok) return listed.result;
      const result = (listed.response?.result ?? {}) as { tools?: unknown; nextCursor?: unknown };
      if (!Array.isArray(result.tools)) {
        return { ok: false, reason: "protocol", detail: "tools/list returned no tools array" };
      }
      for (const raw of result.tools) {
        if (raw === null || typeof raw !== "object") continue;
        const t = raw as { name?: unknown; description?: unknown; annotations?: unknown };
        if (typeof t.name !== "string") continue;
        tools.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description : null,
          annotations: t.annotations !== null && typeof t.annotations === "object"
            ? t.annotations as Record<string, unknown>
            : null,
        });
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor !== ""
        ? result.nextCursor
        : undefined;
      if (cursor === undefined) break;
    }
    if (cursor !== undefined) {
      // A partial inventory reported as the whole one would mislead the operator picking tools.
      return {
        ok: false,
        reason: "protocol",
        detail: `tools/list still had more after ${maxPages} pages, the probe's cap`,
      };
    }

    if (sessionId !== null) {
      // Best effort: a server that hands out sessions appreciates being told we are done.
      const headers = new Headers(base);
      headers.set("mcp-session-id", sessionId);
      if (protocolVersion !== null) headers.set("mcp-protocol-version", protocolVersion);
      try {
        const bye = await dial(target, {
          method: "DELETE",
          headers,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "manual", // it carries the credential too; see the POST
        });
        await bye.body?.cancel();
      } catch {
        // its loss, not ours
      }
    }

    return { ok: true, protocolVersion, serverInfo, tools };
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

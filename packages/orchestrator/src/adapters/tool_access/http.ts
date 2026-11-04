// `ToolAccess` over a standalone mcp-gateway's internal surface — the adapter that replaces
// `toolAccess: null` in the networked deployment. The model_access/http.ts adapter one credential
// class over: the port is the orchestrator's and does not change, the single-process host builds
// the same three methods over an in-process issuer, and the HTTP layer cannot tell which it got.
//
// Service-authed with the shared RYPH_MCP_GATEWAY_TOKEN, both legs. What never crosses: the
// server lookup answers metadata (id, slug, name, archivedAt — not the URL, not the credential),
// and `issueRunCredentials` returns a run-scoped VIRTUAL token minted on the gateway side. The
// real MCP credentials stay sealed in the gateway's database under a master key this process
// does not hold.
//
// Invariants, the same three as the model adapter's — telling a definitive answer from a
// could-not-ask:
// - getServer: 404 is "no such server" → null. Every other failure THROWS, so a gateway that is
//   down surfaces as a 500 on agent creation rather than as "that server does not exist".
// - issueRunCredentials: throws either way (the runner's boot fetch turns any throw into a 503 it
//   retries), but a 400 is logged as definitive — an archived or unknown server means the run can
//   never boot, and the retries are only delaying that verdict.
// - revokeRunCredentials: best-effort by contract; call sites already `.catch()`. A failed revoke
//   leaves the virtual token alive until its TTL lapses, which is the backstop's whole purpose.
// - archiveServer: 404 is "missing", a 409 `platform_managed` is "platform"; every other failure
//   THROWS — a gateway that is down is never reported as an archive that happened.
// - the virtual token is never logged.

import type { McpRunCredentials, ToolAccess } from "../../http/app.ts";

/** The gateway's marker on a platform row it will not archive. Its value is the contract. */
const PLATFORM_MANAGED = "platform_managed";
import type { Diagnostics } from "../../ports/diagnostics.ts";

export interface HttpToolAccessOptions {
  /** The gateway's CONTROL listener, as this process dials it; a trailing slash is tolerated. */
  gatewayControlUrl: string;
  /** The shared service credential this process presents. */
  gatewayToken: string;
  diag: Diagnostics;
  /** Per-request deadline. Default 10s — minting is one insert, but it is on a run's boot path. */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** The gateway's error body, when it sent one. Best-effort: a message, never a control decision. */
async function reason(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
}

/** The credentials body, checked field by field: a malformed answer is refused, never patched. */
function parseCredentials(body: unknown): McpRunCredentials | null {
  if (typeof body !== "object" || body === null) return null;
  const { token, servers } = body as { token?: unknown; servers?: unknown };
  if (typeof token !== "string" || token === "" || !Array.isArray(servers)) return null;
  const parsed: McpRunCredentials["servers"] = [];
  for (const entry of servers) {
    const { slug, name, url } = (entry ?? {}) as { slug?: unknown; name?: unknown; url?: unknown };
    if (typeof slug !== "string" || typeof name !== "string" || typeof url !== "string") {
      return null;
    }
    parsed.push({ slug, name, url });
  }
  return { token, servers: parsed };
}

export function httpToolAccess(opts: HttpToolAccessOptions): ToolAccess {
  const base = opts.gatewayControlUrl.replace(/\/+$/, "");
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const headers = { authorization: `Bearer ${opts.gatewayToken}` };

  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    try {
      return await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Unreachable or timed out. Never a definitive no — the callers below all rethrow.
      throw new Error(`mcp gateway unreachable: ${err instanceof Error ? err.message : err}`);
    }
  };

  return {
    async getServer(id) {
      const res = await call("GET", `/internal/v1/mcp-servers/${encodeURIComponent(id)}`);
      if (res.status === 404) {
        await res.body?.cancel();
        return null; // the ONLY definitive no
      }
      if (!res.ok) {
        const why = await reason(res);
        opts.diag.warn("tool_access.get_server_failed", { id, status: res.status });
        throw new Error(`mcp gateway refused a server lookup: ${why}`);
      }
      const body = await res.json().catch(() => null) as
        | { id?: unknown; slug?: unknown; name?: unknown; archivedAt?: unknown }
        | null;
      if (
        typeof body?.id !== "string" || typeof body.slug !== "string" ||
        typeof body.name !== "string"
      ) {
        throw new Error("mcp gateway answered a malformed server lookup");
      }
      return {
        id: body.id,
        slug: body.slug,
        name: body.name,
        archivedAt: typeof body.archivedAt === "string" ? body.archivedAt : null,
      };
    },

    async issueRunCredentials(scope) {
      const res = await call(
        "POST",
        `/internal/v1/runs/${encodeURIComponent(scope.runId)}/mcp-credentials`,
        { servers: scope.servers },
      );
      if (!res.ok) {
        const why = await reason(res);
        // 400 is the gateway's definitive refusal: unknown or archived server, a malformed
        // scope. Retrying will not change it, so say so plainly in the log — the run boot-fails
        // either way, and this is the line that explains why.
        opts.diag.warn(
          res.status === 400 ? "tool_access.issue_refused" : "tool_access.issue_failed",
          { runId: scope.runId, status: res.status, reason: why },
        );
        throw new Error(`mcp gateway refused to issue credentials: ${why}`);
      }
      const credentials = parseCredentials(await res.json().catch(() => null));
      if (credentials === null) {
        throw new Error("mcp gateway answered a malformed credentials body");
      }
      return credentials;
    },

    async archiveServer(id) {
      const res = await call("POST", `/internal/v1/mcp-servers/${encodeURIComponent(id)}/archive`);
      if (res.status === 404) {
        await res.body?.cancel();
        return { kind: "missing" };
      }
      const body = await res.json().catch(() => null) as Record<string, unknown> | null;
      if (res.status === 409 && body?.code === PLATFORM_MANAGED) return { kind: "platform" };
      if (!res.ok) {
        const why = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
        opts.diag.warn("tool_access.archive_failed", { id, status: res.status, reason: why });
        throw new Error(`mcp gateway refused to archive a server: ${why}`);
      }
      if (body === null || typeof body.id !== "string") {
        throw new Error("mcp gateway answered a malformed archive");
      }
      return { kind: "archived", server: body };
    },

    async revokeRunCredentials(runId) {
      const res = await call(
        "DELETE",
        `/internal/v1/runs/${encodeURIComponent(runId)}/mcp-credentials`,
      );
      await res.body?.cancel();
      if (!res.ok) {
        opts.diag.warn("tool_access.revoke_failed", { runId, status: res.status });
        throw new Error(`mcp gateway refused to revoke run credentials (HTTP ${res.status})`);
      }
    },
  };
}

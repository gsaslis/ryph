// Issuing and revoking a run's MCP credential — the control-plane half of the gateway package,
// called by the orchestrator (never by the data plane).
//
// Invariants:
// - `issue` returns the raw virtual token exactly once, in its result; only its hash is stored.
//   The result also carries, per server, the gateway URL the container should dial — built HERE,
//   because this package is the one that knows how containers reach it.
// - the scope (which servers, which tools) arrives frozen from the run's snapshot; this service
//   never reads live agent policy. It does copy each server's slug and name into the result and
//   the row, so the data plane never has to look a slug up.
// - issuing against an archived or unknown server throws a DEFINITIVE refusal: better a boot
//   failure the runner reports upstream than a run that starts and can never reach a tool

import type { AllowedTools, ScopedServer } from "./types.ts";
import type { GatewayStore } from "../ports/gateway_store.ts";
import { mintId, mintToken, sha256Hex } from "@ryph/sealed";

/**
 * A DEFINITIVE refusal to mint: the scope names a server that can never satisfy it. Distinguished
 * from every other failure (a store that is down) because the two deserve different answers on
 * the wire — the internal surface turns this into a 400 the caller must not retry, and everything
 * else into a retryable 5xx. The model-proxy's CredentialRefusedError, one credential class over.
 */
export class McpCredentialRefusedError extends Error {
  override readonly name = "McpCredentialRefusedError";
}

/** What a run may call: decided at provision time, handed here verbatim at boot. */
export interface McpCredentialScope {
  runId: string;
  servers: Array<{ serverId: string; allowedTools: AllowedTools }>;
}

/** What the container gets: one token, and one gateway URL per server in scope. */
export interface McpCredentials {
  token: string;
  servers: Array<{ slug: string; name: string; url: string }>;
}

export interface McpCredentialIssuer {
  /** Mints the run's virtual key and returns what the harness config needs. */
  issue(scope: McpCredentialScope): Promise<McpCredentials>;
  /** Kills every live credential of a concluded run. Idempotent. */
  revokeForRun(runId: string): Promise<void>;
}

export interface McpCredentialIssuerDeps {
  store: GatewayStore;
  now(): Date;
  /** The data plane's address as seen FROM AN AGENT CONTAINER — a container-network address, usually. */
  gatewayUrl: string;
  /** Backstop lifetime; revocation on run conclusion is the primary cutoff. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

/** The data-plane path for one server of one run — the one place this shape is spelled out. */
export function gatewayPathFor(runId: string, slug: string): string {
  return `/v1/mcp/${encodeURIComponent(runId)}/${encodeURIComponent(slug)}`;
}

export function makeMcpCredentialIssuer(deps: McpCredentialIssuerDeps): McpCredentialIssuer {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const base = deps.gatewayUrl.replace(/\/+$/, "");

  return {
    async issue(scope) {
      if (scope.servers.length === 0) {
        throw new McpCredentialRefusedError("the scope names no servers");
      }
      const seen = new Set<string>();
      const frozen: ScopedServer[] = [];
      const servers: McpCredentials["servers"] = [];
      for (const entry of scope.servers) {
        if (seen.has(entry.serverId)) {
          throw new McpCredentialRefusedError(`server "${entry.serverId}" is named twice`);
        }
        seen.add(entry.serverId);
        const server = await deps.store.getServer(entry.serverId);
        if (!server) {
          throw new McpCredentialRefusedError(`server "${entry.serverId}" does not exist`);
        }
        if (server.archivedAt !== null) {
          throw new McpCredentialRefusedError(`server "${entry.serverId}" is archived`);
        }
        frozen.push({ serverId: server.id, slug: server.slug, allowedTools: entry.allowedTools });
        servers.push({
          slug: server.slug,
          name: server.name,
          url: base + gatewayPathFor(scope.runId, server.slug),
        });
      }

      const at = deps.now();
      // prefixed, so one read as it flashes past in a debug session is recognizably a ryph run
      // credential and not a real upstream token
      const token = `ryph-mcp-${mintToken()}`;
      const created = await deps.store.createVirtualKey({
        id: mintId("mk"),
        runId: scope.runId,
        tokenHash: await sha256Hex(token),
        scope: frozen,
        expiresAt: new Date(at.getTime() + ttlMs).toISOString(),
        revokedAt: null,
        createdAt: at.toISOString(),
      });
      // A concluded run gets no credential. Definitive, and not the only line: a key that slips
      // in beside a concurrent revoke is still dead on arrival (see the store's key lookup).
      if (created === "run_revoked") {
        throw new McpCredentialRefusedError(`run "${scope.runId}" has already concluded`);
      }
      return { token, servers };
    },

    async revokeForRun(runId) {
      await deps.store.revokeVirtualKeysForRun(runId, deps.now().toISOString());
    },
  };
}

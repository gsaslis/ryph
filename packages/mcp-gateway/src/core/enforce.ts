// The gateway's per-request decision, as a pure function — the policy half of the data plane,
// separated from the forwarding machinery so every rule is unit-testable with plain objects.
//
// Invariants:
// - an unknown, revoked, and expired credential, a path naming the wrong run, and a server slug
//   outside the scope all answer IDENTICALLY (401): distinguishing them would confirm to a probing
//   caller which tokens exist(ed) and which servers a run may reach
// - the credential selects the run; the PATH must agree. Belt and braces, the git gateway's rule:
//   a token minted for run A presented on run B's URL is refused even though the token is real
// - the METHOD allowlist is default-deny and fixed (isMethodAllowed): a run's scope bounds what
//   its credential can do, not only which tools it can name, so a method outside the handful a
//   client needs never reaches upstream at all
// - the tool allowlist was frozen onto the virtual key at issue time; this function never consults
//   live policy — except the server row's liveness, which is deliberately live: archiving a
//   server must cut off every in-flight run immediately

import {
  type AllowedTools,
  type McpServer,
  type McpVirtualKey,
  needsSecret,
  type ScopedServer,
  SECRET_REQUIRED,
} from "./types.ts";

export type GatewayDecision =
  | { allow: true; virtualKey: McpVirtualKey; scoped: ScopedServer; server: McpServer }
  | { allow: false; status: 401 | 403 | 409; error: string; code?: string };

export function decide(
  virtualKey: McpVirtualKey | null,
  /** The run id and server slug the request path named. */
  path: { runId: string; slug: string },
  /** The server row the scope entry points at, or null when it is gone. */
  server: McpServer | null,
  nowIso: string,
): GatewayDecision {
  const unauthorized: GatewayDecision = { allow: false, status: 401, error: "unauthorized" };
  if (virtualKey === null) return unauthorized;
  if (virtualKey.revokedAt !== null) return unauthorized;
  if (virtualKey.expiresAt <= nowIso) return unauthorized;
  if (virtualKey.runId !== path.runId) return unauthorized;

  const scoped = virtualKey.scope.find((s) => s.slug === path.slug);
  if (scoped === undefined) return unauthorized;

  // The server vanished or was archived: the run's credential is technically alive but its
  // backing is gone. 403, not 401 — the caller IS who it claims to be, it just may not proceed.
  if (server === null || server.id !== scoped.serverId || server.archivedAt !== null) {
    return { allow: false, status: 403, error: "the server backing this run was archived" };
  }
  // A credentialed server whose credential was never (or no longer) sealed cannot be dialed
  // honestly; refusing beats forwarding unauthenticated and letting upstream say no.
  if (needsSecret(server)) {
    return {
      allow: false,
      status: 409,
      error: "this server's credential must be entered again by an admin before runs can use it",
      code: SECRET_REQUIRED,
    };
  }

  return { allow: true, virtualKey, scoped, server };
}

/**
 * Every JSON-RPC method a run's credential may use AT ALL. The scope is a CAPABILITY boundary,
 * not only a tool list: `resources/*`, `prompts/*`, `completion/*`, `logging/*` and any vendor
 * extension are refused here, before the real credential is ever attached to a request.
 *
 * Why default-deny. A server that exposes the same data as tools AND as MCP resources (GitHub's
 * and Linear's both do) would otherwise hand a run scoped to one read-only tool everything the
 * org credential can reach, by asking for it a different way — and the usage row would say
 * `resources/read` with no tool, which no allowlist ever consulted. The five that remain are
 * what a client needs to be a client: handshake, liveness, notifications, and the two calls the
 * allowlist is about.
 *
 * A message with NO method is a client RESPONSE to a server→client request (sampling, roots).
 * It names no capability and carries no method to deny, so it is not the caller's decision here
 * — but only a well-formed one gets that far (`parseClientMessage` in jsonrpc.ts).
 */
const ALLOWED_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  // The client→server notifications the spec defines (2025-11-25, what the SDK implements), by
  // name: a prefix would admit whatever a vendor hangs under `notifications/`. Left out:
  // `notifications/tasks/status`, which only reports on tasks — and every `tasks/*` method is
  // denied above, so a run has none to report on.
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/progress",
  "notifications/roots/list_changed",
]);

export function isMethodAllowed(method: string): boolean {
  return ALLOWED_METHODS.has(method);
}

/** The allowlist check, shared by `tools/call` refusal and the `tools/list` filter. */
export function isToolAllowed(allowed: AllowedTools, name: string): boolean {
  return allowed === "*" || allowed.includes(name);
}

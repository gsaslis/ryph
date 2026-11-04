// The shared shapes of tool access — the model-proxy's types, one credential class over.
//
// Invariants:
// - a server's CREDENTIAL exists in exactly two forms: sealed at rest (`encryptedAuth`, AES-GCM
//   under a key derived from this package's own master key, RYPH_MCP_KEY, and bound to where it
//   goes — core/sealing.ts) and in the gateway process's memory at
//   forward time. It never appears in an API response — `toPublicMcpServer` is the one redaction
//   point — and never in a log.
// - a VIRTUAL key's raw token is never stored; only its SHA-256 lands in a row, exactly like the
//   orchestrator's per-run bearer. A leaked database leaks no usable credential.
// - rows keep resolving forever: servers are archived, never deleted, so a historical run's
//   scope always answers "which server did this run call?"
// - the scope names TOOLS, and the data plane bounds the CAPABILITY around them: what a run may
//   call is a list of tool names as the server reports them, frozen at issue time, and a tool
//   outside it does not exist from the container's point of view. Every JSON-RPC method beyond
//   the handful a client needs (initialize, ping, four client notifications, tools/list,
//   tools/call) is default-denied, so an empty tool list really is no access to that server —
//   not "no tools, but every resource and prompt the org credential can reach".

/** How the real credential rides an upstream request. `none` is a public server. */
export type McpAuthKind = "none" | "bearer" | "headers";

/**
 * Who runs the server. `remote`: somebody else, at a URL the operator typed — every row that
 * existed before hosting. `hosted`: this gateway, as a container it launched on the tools
 * network, at a URL it minted (see core/hosting.ts). `platform`: the platform itself — a
 * service of ours (memory, first) reached through deployment config rather than the row's URL,
 * seeded at boot, never registered, edited or archived by anyone (see core/platform.ts).
 */
export type McpServerKind = "remote" | "hosted" | "platform";

/**
 * A hosted server's container as the gateway last knew it. `update-available` is never stored:
 * it is `healthy` seen through a catalogue whose pinned digest has moved past the row's.
 */
export type HostStatus = "starting" | "healthy" | "unreachable" | "stopped";
export type PublicHostStatus = HostStatus | "update-available";

export interface HostState {
  /** The ToolHost's handle — the stable container name — or null before the first launch. */
  handle: string | null;
  status: HostStatus;
  /** The digest-pinned image the container was launched from. */
  imageDigest: string | null;
  startedAt: string | null;
  /** Why the last launch or probe failed, in words fit for the row. Never carries a credential. */
  lastError: string | null;
}

/** The advanced path: an HTTP-speaking image the operator names instead of a catalogue entry. */
export interface CustomContainer {
  /** Digest-pinned, exactly like a catalogue entry's. */
  image: string;
  /** The container's argv after the image's entrypoint. */
  command: string[];
  port: number;
  /** The MCP endpoint inside the container, `/mcp` for most servers. */
  path: string;
  /**
   * The env var the image reads its CALLER token from — a per-launch `Authorization: Bearer`
   * only the guard presents, exactly as a catalogue entry's `callerAuth`. Named by the operator
   * and required on every create: the tools network keeps runs out, but not the other hosted
   * servers on it (nor runs under OrbStack, whose networks do not isolate, measured), so an image
   * that authenticates nobody is one they can speak MCP to directly, around every allowlist and
   * the usage trail.
   *
   * Null only on a row written before it was required — which is refused a launch, with why.
   */
  callerAuth: { env: string } | null;
}

/** A hosted server's non-secret configuration, as the catalogue entry's settings name it. */
export type HostSettings = Record<string, string | boolean>;

/** An operator-registered MCP server: one upstream URL, one sealed credential. */
export interface McpServer {
  id: string;
  /** Rides the gateway URL path and the container's config; slug-shaped, unique among live rows. */
  slug: string;
  /** The operator's name for it: "Linear", "GitHub (org token)". */
  name: string;
  description: string | null;
  /** v1 speaks streamable HTTP (and legacy SSE) only; stdio never runs on this side of the wall. */
  transport: "http";
  kind: McpServerKind;
  /**
   * What the gateway forwards to. For a `remote` row, the operator's URL. For a `hosted` row,
   * minted by the gateway at launch — the tool guard's address plus the server's route — and
   * never typed by anyone, which is what exempts it from the public-https rule. For a
   * `platform` row, a `platform://<slug>` marker: the real address is deployment config
   * (proxy.ts's PlatformUpstreams), because the row may live in a database two deployment
   * shapes share and neither's address belongs in it.
   */
  url: string;
  auth: McpAuthKind;
  /**
   * The outbound header map (`{"Authorization":"Bearer …"}`), as JSON, AES-GCM sealed under the
   * master key. Null exactly when `auth` is `none`. Only the gateway ever unseals it. A hosted
   * server's credential lives here too, and nowhere else: its container is launched without it.
   */
  encryptedAuth: string | null;
  /** The last four characters of the credential — the only recoverable trace the API exposes. */
  authLast4: string | null;
  /** Hosted from a catalogue entry: its id (`grafana`). Null for remote rows and custom images. */
  catalogueId: string | null;
  /** Hosted from an operator-named image. Null otherwise. */
  custom: CustomContainer | null;
  /** Hosted: the entry's settings as the operator answered them. Public, editable. */
  settings: HostSettings | null;
  /** Hosted: the container. Null for remote rows. */
  host: HostState | null;
  /** Soft delete only: archiving cuts off every run currently scoped to this server. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An McpServer as the outside may see it: everything except the sealed credential. */
export type PublicMcpServer = Omit<McpServer, "encryptedAuth" | "host"> & {
  host: (Omit<HostState, "status"> & { status: PublicHostStatus }) | null;
};

/**
 * The code on "this server's credential must be entered again", with a 409, wherever it is met:
 * the data plane, the probe, and a management route that has to open the credential (a relaunch
 * re-deriving its headers, logs being redacted). The model-proxy answers the same code for the
 * same condition on a provider key. Distinct from `credential_required` (400), which refuses an
 * EDIT that moves where the credential goes without sending it again.
 */
export const SECRET_REQUIRED = "secret_required";

/**
 * Whether a server's credential must be entered again: it takes one (`auth` is not `none`) and
 * holds none. Its runs are refused with `secret_required` until a rotation seals one again. A
 * stored credential that does not open is the same condition, met at use rather than seen here.
 */
export function needsSecret(server: Pick<McpServer, "auth" | "encryptedAuth">): boolean {
  return server.auth !== "none" && server.encryptedAuth === null;
}

/**
 * The one redaction point — every API response passes through here. `latestDigest` is what the
 * row's catalogue entry pins today, when there is one; a healthy container launched from an
 * older digest is reported as `update-available`, which is all "the catalogue moved" means.
 */
export function toPublicMcpServer(
  server: McpServer,
  latestDigest: string | null = null,
): PublicMcpServer {
  const { encryptedAuth: _sealed, host, ...rest } = server;
  if (host === null) return { ...rest, host: null };
  const stale = host.status === "healthy" && latestDigest !== null &&
    host.imageDigest !== null && host.imageDigest !== latestDigest;
  return { ...rest, host: { ...host, status: stale ? "update-available" : host.status } };
}

/** `"*"` allows every tool the server reports; a list is an exact allowlist of tool names. */
export type AllowedTools = string[] | "*";

/** One server inside a run's frozen scope. The slug is copied so the data plane never looks it up. */
export interface ScopedServer {
  serverId: string;
  slug: string;
  allowedTools: AllowedTools;
}

/**
 * A run-scoped stand-in credential: what an agent container actually holds. One per run, minted
 * at the runner's boot-time credentials fetch, covering every server in the run's scope, dead
 * once the run concludes (revoked) or the TTL lapses.
 */
export interface McpVirtualKey {
  id: string;
  /** The run this credential speaks for — and dies with. */
  runId: string;
  /** SHA-256 hex of the raw token; the raw token exists only inside the container. */
  tokenHash: string;
  /** Frozen from the run's tool scope at issue time — editing the agent mid-run changes nothing. */
  scope: ScopedServer[];
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

/**
 * How one forwarded call ended. `denied` is the allowlist refusing a tool; `rejected` is the
 * upstream refusing OUR credential (its 401/403) — the row the server page turns into
 * "credential rejected"; `error` is everything else that was not a 2xx.
 */
export type McpUsageStatus = "ok" | "error" | "denied" | "rejected";

/** One JSON-RPC request through the data plane, recorded per run — the audit trail. */
export interface McpUsageRecord {
  runId: string;
  serverId: string;
  /** The JSON-RPC method: `tools/call`, `tools/list`, `initialize`, … */
  method: string;
  /** The tool a `tools/call` named; null for every other method. */
  tool: string | null;
  status: McpUsageStatus;
  /** The upstream's HTTP status; null when the call never reached it (denied, unreachable). */
  httpStatus: number | null;
  durationMs: number;
  at: string;
}

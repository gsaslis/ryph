import { z } from "zod";
import { apiCall, ApiError } from "./call";
import {
  type CustomContainer,
  type HostSettings,
  type McpCatalogue,
  mcpCatalogueSchema,
  type McpServer,
  mcpServerSchema,
  type McpUsageRecord,
  mcpUsageRecordSchema,
  type ProbeResult,
  probeResultSchema,
} from "./types";

// The management surface is write-only on credentials: a credential goes up in create/rotate and
// never comes back — every response carries metadata plus a last4 trace only. The paths live on the
// MCP gateway's CONTROL listener, which the app's proxy routes to by path.

/**
 * How a server authenticates upstream, as the API takes it: a bearer token, an arbitrary header
 * map for servers that want an API-key header, or nothing for a public server.
 */
export type McpCredentialInput =
  | { auth: "none" }
  | { auth: "bearer"; secret: string }
  | { auth: "headers"; headers: Record<string, string> };

/** A remote server: the body that existed before hosting, verbatim. */
export type CreateRemoteServerInput = {
  slug: string;
  name: string;
  description?: string;
  url: string;
} & McpCredentialInput;

/**
 * A server from the catalogue: the entry, the settings its card asked for, and its secrets keyed
 * by the header the gateway will send each in. `kind` is the entry's: `hosted` launches a
 * container, `remote` points at the vendor's own endpoint. The slug is derived server-side
 * (`grafana`, `grafana-2`) when absent.
 */
export type CreateCatalogueServerInput = {
  kind: "hosted" | "remote";
  catalogueId: string;
  slug?: string;
  name: string;
  description?: string;
  settings: HostSettings;
  credential: Record<string, string>;
};

/** A server the gateway hosts from an image an admin named, with a remote-shaped credential. */
export type CreateCustomServerInput =
  & {
    kind: "hosted";
    slug: string;
    name: string;
    description?: string;
    custom: CustomContainer;
  }
  & McpCredentialInput;

export type CreateMcpServerInput =
  | CreateRemoteServerInput
  | CreateCatalogueServerInput
  | CreateCustomServerInput;

export type UpdateMcpServerInput = {
  name?: string;
  /** `null` clears the description; absent leaves it alone. */
  description?: string | null;
  /**
   * Remote servers by URL only. A hosted server's URL is minted by the gateway, a remote preset's
   * derived from its settings.
   */
  url?: string;
  /**
   * Rotation in place: same id, new credential — nothing referencing the server moves. For a
   * remote server or a custom container.
   */
  credential?: McpCredentialInput;
  /**
   * A catalogue server's settings, all or some. On a hosted one a change relaunches its
   * container; on a remote preset it re-derives the vendor URL.
   */
  settings?: HostSettings;
  /**
   * A catalogue server's rotation: its secrets by header name. A row write only — the container
   * never held the old one.
   */
  secrets?: Record<string, string>;
};

export async function getMcpServers(f = fetch): Promise<McpServer[]> {
  const res = await apiCall(f, "/v1/mcp-servers");
  return z.object({ mcpServers: z.array(mcpServerSchema) }).parse(res).mcpServers;
}

/**
 * Why the tool surface is not answering, when it is not. Four different sentences to write, and
 * one thing in common: none of them is a reason to replace the page the operator asked for with
 * an error page.
 */
export type ToolAccessState =
  /** The surface answered. */
  | "on"
  /** The gateway runs without a master key: nothing can seal a credential, so nothing exists. */
  | "off"
  /** The surface is there and this user may not read it — tool servers are an admin's business. */
  | "forbidden"
  /** Not mounted (a deployment without the gateway), down, restarting, or unreachable. */
  | "unavailable";

/** The state of the deployment's tool-access surface, shaped to spread into a page's data. */
export type ToolAccess = {
  /** false when the servers could not be read, whatever the reason — see `toolAccessState`. */
  toolAccessEnabled: boolean;
  toolAccessState: ToolAccessState;
  mcpServers: McpServer[];
};

/**
 * What a failure off the tool surface means for a page that wanted it — or null when the failure
 * is not this surface's to fold (a 401 belongs to the session, a 400 to the caller).
 *
 * The three folded cases all reach a page `load` the same way otherwise: as a throw, which
 * SvelteKit turns into the error page. Creating and editing an AGENT must not die because the
 * tool plane is down, absent (a deployment that predates it answers 404), restarting, or not
 * this user's to see — the Tools section is one part of that form, and the rest of the form is
 * still the operator's work. The form leaves a policy it cannot show untouched, so degrading
 * here never silently drops an agent's tools.
 */
function foldToolSurfaceFailure(e: unknown): Exclude<ToolAccessState, "on"> | null {
  if (e instanceof ApiError) {
    if (isMcpDisabled(e)) return "off";
    if (e.status === 403) return "forbidden";
    if (e.status === 404 || e.status >= 500) return "unavailable";
    return null;
  }
  // Never an HTTP answer at all: fetch itself failed, which is a gateway nobody could reach.
  if (e instanceof TypeError) return "unavailable";
  return null;
}

/**
 * Reads the MCP servers for a page `load`, folding every "no servers to show, and it is not your
 * page's fault" answer into an empty result that says which one it was.
 */
export async function getToolAccess(f = fetch): Promise<ToolAccess> {
  try {
    return { toolAccessEnabled: true, toolAccessState: "on", mcpServers: await getMcpServers(f) };
  } catch (e) {
    const state = foldToolSurfaceFailure(e);
    if (state === null) throw e;
    return { toolAccessEnabled: false, toolAccessState: state, mcpServers: [] };
  }
}

/**
 * A wire contract, not a local name: the gateway sends this code on the disabled surface, as
 * `MCP_DISABLED` in @ryph/mcp-gateway. The app does not import the server packages (it builds on
 * Node, through Vite), so the value is duplicated — the MODEL_ACCESS_DISABLED precedent. Change it in both
 * places or the tool pages go back to rendering a 500.
 */
const MCP_DISABLED = "mcp_disabled";

export function isMcpDisabled(e: ApiError): boolean {
  return e.status === 503 && typeof e.body === "object" && e.body !== null &&
    (e.body as { code?: unknown }).code === MCP_DISABLED;
}

/**
 * A wire contract too: `HOSTING_UNAVAILABLE` in @ryph/mcp-gateway, sent when tool access is on
 * but the gateway has no container backend to host a server on. Duplicated for the same reason
 * as MCP_DISABLED; change it in both places.
 */
const HOSTING_UNAVAILABLE = "hosting_unavailable";

export function isHostingUnavailable(e: ApiError): boolean {
  return e.status === 503 && typeof e.body === "object" && e.body !== null &&
    (e.body as { code?: unknown }).code === HOSTING_UNAVAILABLE;
}

/**
 * The hosting catalogue for a page `load`. A deployment without tool access has nothing to host
 * with either, so the disabled surface folds into an empty catalogue that says why — the Add
 * dialog is not even offered then, but the page must not 500 over it.
 */
export async function getMcpCatalogue(f = fetch): Promise<McpCatalogue> {
  try {
    return mcpCatalogueSchema.parse(await apiCall(f, "/v1/mcp-catalogue"));
  } catch (e) {
    if (e instanceof ApiError && isMcpDisabled(e)) {
      return { hostingAvailable: false, reason: "Tool access is off.", entries: [] };
    }
    throw e;
  }
}

export async function createMcpServer(
  f = fetch,
  input: CreateMcpServerInput,
): Promise<McpServer> {
  return mcpServerSchema.parse(
    await apiCall(f, "/v1/mcp-servers", { method: "POST", body: JSON.stringify(input) }),
  );
}

export async function updateMcpServer(
  f = fetch,
  id: string,
  input: UpdateMcpServerInput,
): Promise<McpServer> {
  // The wire shape is flat — the credential's `auth` rides beside `name` and `url` — and a
  // catalogue server's secrets travel as `credential`, the map the gateway re-derives headers from.
  const { credential, secrets, ...rest } = input;
  return mcpServerSchema.parse(
    await apiCall(f, `/v1/mcp-servers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...rest,
        ...(credential ?? {}),
        ...(secrets === undefined ? {} : { credential: secrets }),
      }),
    }),
  );
}

export async function archiveMcpServer(f = fetch, id: string): Promise<McpServer> {
  return mcpServerSchema.parse(
    await apiCall(f, `/v1/mcp-servers/${encodeURIComponent(id)}/archive`, { method: "POST" }),
  );
}

/**
 * Relaunches a hosted server's container and answers the row as `starting`. `updateImage` moves a
 * catalogue server to the image its entry pins today; without it the row keeps the image it was
 * launched from.
 */
export async function restartMcpServer(
  f = fetch,
  id: string,
  opts: { updateImage?: boolean } = {},
): Promise<McpServer> {
  return mcpServerSchema.parse(
    await apiCall(f, `/v1/mcp-servers/${encodeURIComponent(id)}/restart`, {
      method: "POST",
      body: JSON.stringify(opts.updateImage ? { updateImage: true } : {}),
    }),
  );
}

/**
 * The last `tail` lines a hosted server's container wrote — admins only, capped by the gateway
 * at 1 000. Never its env: there is nothing secret in it to show, and the gateway redacts the
 * credential should the image ever log a request header.
 */
export async function getMcpServerLogs(f = fetch, id: string, tail = 200): Promise<string> {
  const res = await apiCall(
    f,
    `/v1/mcp-servers/${encodeURIComponent(id)}/logs?tail=${encodeURIComponent(String(tail))}`,
  );
  return z.object({ logs: z.string() }).parse(res).logs;
}

/**
 * Connects to the server with its real credential — on the gateway, never here — and reports
 * whether the credential was accepted and which tools the server exposes. Stores nothing: the
 * probe is a look, the allowlist is the operator's decision.
 */
export async function probeMcpServer(f = fetch, id: string): Promise<ProbeResult> {
  return probeResultSchema.parse(
    await apiCall(f, `/v1/mcp-servers/${encodeURIComponent(id)}/probe`, { method: "POST" }),
  );
}

/** A failed probe's reason, in the operator's words. */
export const PROBE_FAILURE_LABEL: Record<
  Extract<ProbeResult, { ok: false }>["reason"],
  string
> = {
  credential_rejected: "Credential rejected",
  secret_required: "Credential must be entered again",
  unreachable: "Server unreachable",
  protocol: "Not a usable MCP server",
  policy: "URL refused by the gateway's upstream policy",
};

/**
 * How much of a run's trail any page of this app reads, on the server and in the browser alike.
 * How LONG a trail is, is the agent's decision — a denied `tools/call` is refused inside the
 * gateway, before any upstream dial, and still writes a row — so nothing here ever asks for all
 * of it: a run that called tools in a loop must not decide how much memory an SSR render takes,
 * or how many rows a browser is handed every five seconds.
 */
export const TOOL_CALL_TRAIL_LIMIT = 200;

/** One page of a run's trail, newest-anchored: oldest first WITHIN the page. */
const mcpUsagePageSchema = z.object({
  usage: z.array(mcpUsageRecordSchema),
  // Absent on a gateway from before the trail was paged: one page, and it is the whole trail.
  hasMore: z.boolean().default(false),
  nextCursor: z.string().nullable().default(null),
});

/** A run's tool-call trail, as the gateway's data plane recorded it. */
export async function getMcpUsage(
  f = fetch,
  runId: string,
  opts: { limit?: number; cursor?: string; grant?: string | null } = {},
): Promise<z.infer<typeof mcpUsagePageSchema>> {
  const query = new URLSearchParams({ limit: String(opts.limit ?? TOOL_CALL_TRAIL_LIMIT) });
  if (opts.cursor !== undefined) query.set("cursor", opts.cursor);
  if (opts.grant) query.set("grant", opts.grant);
  const res = await apiCall(f, `/v1/mcp-usage/${encodeURIComponent(runId)}?${query}`);
  return mcpUsagePageSchema.parse(res);
}

/** The newest slice of a run's trail, and whether the run has calls older than it. */
export type ToolCallTrail = {
  /** Oldest first, at most `TOOL_CALL_TRAIL_LIMIT` of them. */
  calls: McpUsageRecord[];
  /** True when the run made calls this window does not hold. */
  hasMore: boolean;
  /** True when the trail could not be read at all — a note on the page, never an error page. */
  unavailable: boolean;
};

/**
 * The trail for a run page `load`: a run whose deployment has since turned tool access off, never
 * had it, or whose gateway is down shows an empty trail rather than taking the run view with it.
 * The tools the run did or did not call are a detail of that page; the run itself is the page.
 */
export async function getToolCallTrail(
  f = fetch,
  runId: string,
  opts: { limit?: number; grant?: string | null } = {},
): Promise<ToolCallTrail> {
  try {
    const page = await getMcpUsage(f, runId, opts);
    return { calls: page.usage, hasMore: page.hasMore, unavailable: false };
  } catch (e) {
    const state = foldToolSurfaceFailure(e);
    if (state === null) throw e;
    // "Off" is not a failure to report: a run that had no tool plane called no tools.
    return { calls: [], hasMore: false, unavailable: state !== "off" };
  }
}

/**
 * The line a remote preset shows under its name: the vendor host, led by the catalogue entry's
 * name unless the server already goes by it (`mcp.sentry.dev`, not `Sentry · mcp.sentry.dev`).
 */
export function presetLine(serverName: string, entryName: string | null, url: string): string {
  const host = hostOfUrl(url);
  if (entryName === null || entryName.trim().toLowerCase() === serverName.trim().toLowerCase()) {
    return host;
  }
  return `${entryName} · ${host}`;
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

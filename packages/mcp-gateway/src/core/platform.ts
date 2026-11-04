// The platform-provided MCP servers: the constants the orchestrator, the data plane and the seed
// agree on, and the rows themselves. In core because the seed and the data plane are core
// concerns; the `@ryph/mcp-gateway/platform` entry point (src/platform.ts) re-exports the
// constants so the orchestrator can import them without pulling the package in.
//
// A `platform` server is one the platform itself provides — memory, the chat service, the
// forge's tool surface, and the web service — not operator-registered, no sealed credential, its
// upstream the providing service's MCP route rather than anything anyone typed.
// The row is seeded at boot so it shows in the agent form's Tools section like every other
// server, and the per-tool allowlist and the opt-out need no special path. A row rather than a
// special case in the scope logic, so the agent form, the issuer, the data plane's `decide()` and
// the usage trail all see an ordinary server — one with `kind: "platform"`, which is the one thing
// that changes how it is dialed and that it can never be archived or edited.

import type { GatewayStore } from "../ports/gateway_store.ts";
import type { McpServer } from "./types.ts";

/** The memory service's row. A FIXED id, so a run's frozen scope and a seed agree forever. */
export const PLATFORM_MEMORY_SERVER_ID = "ms-platform-memory";

/** Its slug — the prefix the agent sees on every tool (`memory__search`). */
export const PLATFORM_MEMORY_SLUG = "memory";

/** The chat service's row — the conversation a run is bound to: a response's chatroom, or the
 * thread a chat mention started the run from.
 * Fixed for the same reason memory's is. */
export const PLATFORM_CHAT_SERVER_ID = "ms-platform-chat";

/** Its slug — the prefix on its one tool (`chat__post`). */
export const PLATFORM_CHAT_SLUG = "chat";

/** The forge's row — issues, comments, labels and review remarks, acting as the forge's App
 * under the run's forge scope. Fixed for the same reason memory's is. */
export const PLATFORM_FORGE_SERVER_ID = "ms-platform-forge";

/** Its slug — the prefix on its tools (`forge__create_issue`). */
export const PLATFORM_FORGE_SLUG = "forge";

/** The web service's row — search and page reads, the one way a run reaches the public internet
 * for anything but its own dependencies. Fixed for the same reason memory's is. */
export const PLATFORM_WEB_SERVER_ID = "ms-platform-web";

/** Its slug — the prefix on its tools (`web__search`, `web__fetch`). */
export const PLATFORM_WEB_SLUG = "web";

/**
 * The header the gateway forwards a run's id in to a platform upstream. Never on the inbound
 * allowlist, so a container cannot set it. Its VALUE is the contract with @ryph/memory, which
 * carries its own copy (http/data.ts) rather than import this package; keep the two in step.
 */
export const PLATFORM_RUN_ID_HEADER = "x-ryph-run-id";

/**
 * What a platform row's `url` column holds: a marker, never a dialable address. Where the
 * gateway actually forwards is deployment config (in-process under the single binary, a URL
 * standalone), so the row — which lives in a database both deployments may share — must not
 * carry either.
 */
export const PLATFORM_URL_SCHEME = "platform:";

/** The memory service's row, as seeded. */
export function platformMemoryRow(nowIso: string): McpServer {
  return {
    id: PLATFORM_MEMORY_SERVER_ID,
    slug: PLATFORM_MEMORY_SLUG,
    name: "Memory",
    description: "What previous runs and people recorded about the org and its repositories. " +
      "Provided by the platform; in every run's scope unless the agent opts out.",
    transport: "http",
    kind: "platform",
    url: `${PLATFORM_URL_SCHEME}//${PLATFORM_MEMORY_SLUG}`,
    auth: "none",
    encryptedAuth: null,
    authLast4: null,
    catalogueId: null,
    custom: null,
    settings: null,
    host: null,
    archivedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/** The chat service's row, as seeded. */
export function platformChatRow(nowIso: string): McpServer {
  return {
    id: PLATFORM_CHAT_SERVER_ID,
    slug: PLATFORM_CHAT_SLUG,
    name: "Chat",
    description: "The chat conversation a run is bound to. Provided by the platform; in a " +
      "run's scope only when a chat mention started the run or a response bound it to a room.",
    transport: "http",
    kind: "platform",
    url: `${PLATFORM_URL_SCHEME}//${PLATFORM_CHAT_SLUG}`,
    auth: "none",
    encryptedAuth: null,
    authLast4: null,
    catalogueId: null,
    custom: null,
    settings: null,
    host: null,
    archivedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/** The forge's tool surface's row, as seeded. */
export function platformForgeRow(nowIso: string): McpServer {
  return {
    id: PLATFORM_FORGE_SERVER_ID,
    slug: PLATFORM_FORGE_SLUG,
    name: "Issues & pull requests",
    description: "Read, open and comment on issues and pull requests as the platform's forge " +
      "App. Provided by the platform; granted through an agent's forge policy, never a tool " +
      "policy.",
    transport: "http",
    kind: "platform",
    url: `${PLATFORM_URL_SCHEME}//${PLATFORM_FORGE_SLUG}`,
    auth: "none",
    encryptedAuth: null,
    authLast4: null,
    catalogueId: null,
    custom: null,
    settings: null,
    host: null,
    archivedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/** The web service's row, as seeded. */
export function platformWebRow(nowIso: string): McpServer {
  return {
    id: PLATFORM_WEB_SERVER_ID,
    slug: PLATFORM_WEB_SLUG,
    name: "Web",
    description: "Search the public web and read pages from it as markdown, so a run can check " +
      "a library's current API, an error nobody here has seen, or what a standard actually " +
      "says instead of guessing. Provided by the platform; read-only, and everything it " +
      "returns is third-party text the agent is told to treat as data. In every run's scope " +
      "where this deployment serves it.",
    transport: "http",
    kind: "platform",
    url: `${PLATFORM_URL_SCHEME}//${PLATFORM_WEB_SLUG}`,
    auth: "none",
    encryptedAuth: null,
    authLast4: null,
    catalogueId: null,
    custom: null,
    settings: null,
    host: null,
    archivedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * What the seed found: the row, or the reason there is none. A REPORT rather than a throw,
 * because the one conflict it can hit — an operator's server already holding the slug — is
 * fixed through the management API THIS PROCESS SERVES. Exiting at boot over it takes the
 * remedy down with the fault: nobody can rename or archive that server on a gateway that will
 * not start. So the caller logs the reason, leaves the platform upstream unwired (a scoped run
 * gets the data plane's 502, which says the same thing) and keeps serving.
 */
export type PlatformSeed =
  | { ok: true; server: McpServer }
  | { ok: false; reason: string };

/** The memory seed's report, under the name it had when memory was the only platform server. */
export type PlatformMemorySeed = PlatformSeed;

/**
 * Ensures a platform row exists. Idempotent: an existing row is left exactly as it stands. A
 * LIVE remote or hosted row already holding the slug is a configuration conflict this refuses
 * to paper over — the operator registered a server called `memory` (or `chat`) before the
 * platform did, and renaming theirs is the fix — but it is reported, never thrown: see
 * PlatformSeed.
 */
export async function ensurePlatformServer(
  store: GatewayStore,
  row: McpServer,
  what: string,
): Promise<PlatformSeed> {
  const existing = await store.getServer(row.id);
  if (existing !== null) return { ok: true, server: existing };
  const outcome = await store.createServer(row);
  if (outcome === "slug_taken") {
    // A concurrent seed from a peer replica lands here too; tell it apart from a real conflict.
    const again = await store.getServer(row.id);
    if (again !== null) return { ok: true, server: again };
    return {
      ok: false,
      reason: `an MCP server already holds the slug "${row.slug}", which the platform's ` +
        `${what} server needs — archive or rename that server, then restart; until then the ` +
        `platform ${what} server is unavailable and runs scoped to it will say so`,
    };
  }
  return { ok: true, server: row };
}

/** Ensures the memory row exists (see ensurePlatformServer). */
export function ensurePlatformMemoryServer(
  store: GatewayStore,
  nowIso: string,
): Promise<PlatformSeed> {
  return ensurePlatformServer(store, platformMemoryRow(nowIso), "memory");
}

/** Ensures the chat row exists (see ensurePlatformServer). */
export function ensurePlatformChatServer(
  store: GatewayStore,
  nowIso: string,
): Promise<PlatformSeed> {
  return ensurePlatformServer(store, platformChatRow(nowIso), "chat");
}

/** Ensures the forge row exists (see ensurePlatformServer). */
export function ensurePlatformForgeServer(
  store: GatewayStore,
  nowIso: string,
): Promise<PlatformSeed> {
  return ensurePlatformServer(store, platformForgeRow(nowIso), "forge");
}

/** Ensures the web row exists (see ensurePlatformServer). */
export function ensurePlatformWebServer(
  store: GatewayStore,
  nowIso: string,
): Promise<PlatformSeed> {
  return ensurePlatformServer(store, platformWebRow(nowIso), "web");
}

/** Whether a row is one the platform manages: never edited or archived through the API (probed, yes). */
export function isPlatformServer(server: Pick<McpServer, "kind">): boolean {
  return server.kind === "platform";
}

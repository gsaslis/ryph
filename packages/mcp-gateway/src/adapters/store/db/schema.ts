// The drizzle schema for the gateway's tables. Same conventions as the model-proxy's schema:
// drizzle-kit applies it (push locally/tests, migrations at deploy time), ISO-8601 text
// timestamps, columns mirror core types field-for-field so rows need no mapping.
//
// The store is the seam between whoever registers servers and mints virtual keys and the data
// plane that reads them per request. In the single process both are one process over one
// database; standalone, the gateway owns these tables and the control plane reaches them over
// the gateway's internal HTTP surface, never by reading the tables.

import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, serial, text, uniqueIndex } from "drizzle-orm/pg-core";
import type {
  CustomContainer,
  HostSettings,
  HostStatus,
  McpAuthKind,
  McpServerKind,
  McpUsageStatus,
  ScopedServer,
} from "../../../core/types.ts";

// The one exception to "columns mirror core types": a hosted server's container state is the
// `host` object on McpServer and five flat `host_*` columns here, because each is a fact the
// supervisor rewrites on its own and a flat column is what a query can read. The store maps
// between the two shapes (adapters/store/drizzle.ts).
export const mcpServers = pgTable("mcp_servers", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  transport: text("transport").$type<"http">().notNull(),
  // Every row that predates hosting is a remote one; the default is what migrates them.
  kind: text("kind").$type<McpServerKind>().notNull().default("remote"),
  url: text("url").notNull(),
  auth: text("auth").$type<McpAuthKind>().notNull(),
  // AES-GCM sealed header map; the plaintext never touches a row. Null when auth is "none".
  encryptedAuth: text("encrypted_auth"),
  authLast4: text("auth_last4"),
  catalogueId: text("catalogue_id"),
  custom: jsonb("custom").$type<CustomContainer>(),
  // Non-secret configuration only: the credential is in encrypted_auth and nowhere else.
  settings: jsonb("settings").$type<HostSettings>(),
  hostHandle: text("host_handle"),
  hostStatus: text("host_status").$type<HostStatus>(),
  hostImageDigest: text("host_image_digest"),
  hostStartedAt: text("host_started_at"),
  hostError: text("host_error"),
  // Soft delete only: historical runs keep resolving which server they called.
  archivedAt: text("archived_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  // A slug is unique among LIVE servers: archiving one frees the name, and a historical run's
  // scope carries the server id, so the reuse cannot be confused with it.
  uniqueIndex("mcp_servers_live_slug").on(t.slug).where(sql`${t.archivedAt} is null`),
]);

export const mcpVirtualKeys = pgTable("mcp_virtual_keys", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  // SHA-256 hex of the raw token — the data plane's per-request lookup column.
  tokenHash: text("token_hash").notNull(),
  // The frozen scope: which servers (by id and slug), which tools. Carried, never queried into.
  scope: jsonb("scope").$type<ScopedServer[]>().notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("mcp_virtual_keys_by_token_hash").on(t.tokenHash),
  index("mcp_virtual_keys_by_run").on(t.runId),
]);

// A run whose credentials are dead, written once when it is revoked. The key lookup joins it, so a
// key minted AFTER the revocation — an issue racing the revoke — is dead the moment it lands,
// whichever of the two writes commits first. Stamping the key rows alone could not promise that.
export const mcpRevokedRuns = pgTable("mcp_revoked_runs", {
  runId: text("run_id").primaryKey(),
  revokedAt: text("revoked_at").notNull(),
});

export const mcpUsage = pgTable("mcp_usage", {
  seq: serial("seq").primaryKey(),
  runId: text("run_id").notNull(),
  serverId: text("server_id").notNull(),
  method: text("method").notNull(),
  tool: text("tool"),
  status: text("status").$type<McpUsageStatus>().notNull(),
  httpStatus: integer("http_status"),
  durationMs: integer("duration_ms").notNull(),
  at: text("at").notNull(),
}, (t) => [
  index("mcp_usage_by_run").on(t.runId, t.seq),
]);

// The drizzle schema for the proxy's tables. Same conventions as the orchestrator's schema:
// drizzle-kit applies it (push locally/tests, migrations at deploy time), ISO-8601 text
// timestamps, columns mirror core types field-for-field so rows need no mapping.
//
// The store is the seam between whoever writes keys and mints virtual keys and the proxy that
// reads them per request. In Mode A both are the same process over one database; in Mode B the
// model-proxy owns these tables in `ryph_keys` and the control plane reaches them over the
// proxy's internal HTTP surface, never by reading the tables.

import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { DeclaredModel } from "../../../core/registry.ts";
import type { AllowedModels, PlanRegistration, PlanStatus } from "../../../core/types.ts";

export const providerKeys = pgTable("provider_keys", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  label: text("label").notNull(),
  last4: text("last4").notNull(),
  // AES-GCM sealed; the plaintext never touches a row.
  encryptedSecret: text("encrypted_secret").notNull(),
  // Soft delete only: historical runs keep resolving whose key they spent.
  archivedAt: text("archived_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  // A ChatGPT plan key's non-secret registration and its state; null on every other key. The
  // state is two columns of its own because the data plane writes it while a token refresh
  // writes the secret, and neither may put back what the other changed.
  plan: jsonb("plan").$type<PlanRegistration>(),
  planStatus: text("plan_status").$type<PlanStatus>(),
  planLimitedAt: text("plan_limited_at"),
}, (t) => [
  index("provider_keys_by_provider").on(t.provider),
]);

// ChatGPT sign-ins in flight: one row per authorization attempt, so the loopback listener's
// callback finishes it and a restart in between loses nothing. Short-lived and pruned.
export const chatgptSignIns = pgTable("chatgpt_sign_ins", {
  id: text("id").primaryKey(),
  state: text("state").notNull(),
  nonce: text("nonce").notNull(),
  // The PKCE verifier, AES-GCM sealed like a provider key.
  encryptedVerifier: text("encrypted_verifier").notNull(),
  clientId: text("client_id"),
  keyId: text("key_id"),
  label: text("label"),
  redirectUri: text("redirect_uri").notNull(),
  status: text("status").$type<"pending" | "exchanging" | "done" | "failed">().notNull(),
  error: text("error"),
  resultKeyId: text("result_key_id"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("chatgpt_sign_ins_by_state").on(t.state),
]);

// This deployment's `ext_agent_host_id`, minted once and never changed: one row (`id =
// "default"`), like the platform policy's.
export const chatgptAgentHost = pgTable("chatgpt_agent_host", {
  id: text("id").primaryKey(),
  extAgentHostId: text("ext_agent_host_id").notNull(),
  createdAt: text("created_at").notNull(),
});

// An OpenAI-compatible endpoint an admin registered. The ONE table here that holds no secret:
// the credential for such an endpoint is an ordinary `provider_keys` row whose `provider` is
// this row's id, sealed like any other. Soft-deleted like the keys, for the same reason — a
// historical usage row must keep resolving what it dialled and what that cost.
export const customProviders = pgTable("custom_providers", {
  // The slug an agent's policy, a provider key and pi's argv all carry.
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  // The upstream, path included; validated at registration, not here.
  baseUrl: text("base_url").notNull(),
  // How the real key rides proxy→upstream: `authorization` + `Bearer`, or a named header
  // (Azure's `api-key`) with a null scheme, which sends the bare value.
  authHeader: text("auth_header").notNull(),
  authScheme: text("auth_scheme"),
  // Non-secret only — the credential is the provider key and never lands here.
  extraHeaders: jsonb("extra_headers").$type<Record<string, string>>().notNull(),
  // What the endpoint serves: pi has no catalogue for it and the price list cannot know it.
  models: jsonb("models").$type<DeclaredModel[]>().notNull(),
  archivedAt: text("archived_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const virtualKeys = pgTable("virtual_keys", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  // Attribution for the usage rows this credential spends; null on a platform credential.
  agentId: text("agent_id"),
  taskId: text("task_id"),
  providerKeyId: text("provider_key_id").notNull().references(() => providerKeys.id),
  // SHA-256 hex of the raw token — the proxy's per-request lookup column.
  tokenHash: text("token_hash").notNull(),
  allowedModels: jsonb("allowed_models").$type<AllowedModels>().notNull(),
  // The run's caps, frozen at issue time like the allowlist; null is uncapped.
  spendUsd: doublePrecision("spend_usd"),
  callsInFlight: integer("calls_in_flight"),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("virtual_keys_by_token_hash").on(t.tokenHash),
  index("virtual_keys_by_run").on(t.runId),
]);

// The platform's own model policy: one row (`id = "default"`), set by an admin. The provider
// key it names is what the memory consolidator and every other off-run model call spend.
export const platformModelPolicy = pgTable("platform_model_policy", {
  id: text("id").primaryKey(),
  providerKeyId: text("provider_key_id").notNull().references(() => providerKeys.id),
  provider: text("provider").notNull(),
  allowedModels: jsonb("allowed_models").$type<AllowedModels>().notNull(),
  model: text("model").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const proxyUsage = pgTable("proxy_usage", {
  // `serial` is Postgres' spelling of the autoincrementing key sqlite expressed as an
  // integer primary key; the column stays a plain integer to every reader.
  seq: serial("seq").primaryKey(),
  runId: text("run_id").notNull(),
  agentId: text("agent_id"),
  taskId: text("task_id"),
  providerKeyId: text("provider_key_id").notNull(),
  provider: text("provider").notNull(),
  model: text("model"),
  status: integer("status").notNull(),
  // The response's usage report, null when it carried none. Tokens only — cost is priced on read.
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  cacheWrite1hTokens: integer("cache_write_1h_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  // The counts are the proxy's estimate: the response never reported its usage.
  estimated: boolean("estimated").notNull().default(false),
  durationMs: integer("duration_ms"),
  at: text("at").notNull(),
}, (t) => [
  index("proxy_usage_by_run").on(t.runId, t.seq),
  // Every windowed report filters on this.
  index("proxy_usage_by_at").on(t.at),
]);

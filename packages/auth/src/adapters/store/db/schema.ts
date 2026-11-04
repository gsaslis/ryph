// The drizzle schema for auth's tables. Same conventions as the orchestrator's schema:
// drizzle-kit applies it (push locally/tests, migrations at deploy time), ISO-8601 text
// timestamps, columns mirror core types field-for-field so rows need no mapping.
//
// Auth is mounted inside the control plane in both modes, so these tables share the control
// plane's database — the host's drizzle.config lists every schema file that does.

import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import type { Capability, Role } from "../../../core/capabilities.ts";
import type { OneTimeTokenKind, UserStatus } from "../../../core/types.ts";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  role: text("role").$type<Role>().notNull(),
  status: text("status").$type<UserStatus>().notNull().default("active"),
  emailVerifiedAt: text("email_verified_at"),
  unprovenEmail: text("unproven_email"),
  resetRequestedAt: text("reset_requested_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("users_by_email").on(t.email),
]);

export const oneTimeTokens = pgTable("one_time_tokens", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<OneTimeTokenKind>().notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("one_time_tokens_by_token_hash").on(t.tokenHash),
  index("one_time_tokens_by_user").on(t.userId, t.kind),
]);

export const authSessions = pgTable("auth_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  userAgent: text("user_agent"),
  ip: text("ip"),
  lastUsedAt: text("last_used_at"),
}, (t) => [
  uniqueIndex("auth_sessions_by_token_hash").on(t.tokenHash),
  index("auth_sessions_by_user").on(t.userId),
]);

// A user's API tokens, by digest: the exchange looks one up by hash, the account page lists
// them by owner. Revoked rows stay, so a list can say when and a replay finds nothing live.
export const apiTokens = pgTable("api_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  caps: jsonb("caps").$type<Capability[]>().notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
  revokedAt: text("revoked_at"),
}, (t) => [
  uniqueIndex("api_tokens_by_token_hash").on(t.tokenHash),
  index("api_tokens_by_user").on(t.userId, t.createdAt),
]);

// Sign-in resolves by the provider's stable account id; inbound forge triggers resolve actors
// by login, so both are indexed. One account links to one user, and a user holds one account
// per provider — the two unique indexes are what keep a login lookup unambiguous.
export const externalIdentities = pgTable("external_identities", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  login: text("login").notNull(),
  email: text("email"),
  emailVerified: boolean("email_verified").notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("external_identities_by_account").on(t.provider, t.providerAccountId),
  uniqueIndex("external_identities_by_user_provider").on(t.userId, t.provider),
  index("external_identities_by_login").on(t.provider, t.login),
]);

// One outstanding "prove you hold this key" challenge, for a provider with no OAuth to borrow.
// A row rather than a process map, so any replica can finish what another started.
export const identityChallenges = pgTable("identity_challenges", {
  nonce: text("nonce").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  /** Set by the one request that spends it — the single-use gate, decided in one statement. */
  usedAt: text("used_at"),
}, (t) => [
  index("identity_challenges_by_user").on(t.userId, t.provider),
  // The sweep of expired rows.
  index("identity_challenges_by_expiry").on(t.expiresAt),
]);

export const passkeys = pgTable("passkeys", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  transports: jsonb("transports").$type<string[]>().notNull(),
  name: text("name").notNull(),
  backedUp: boolean("backed_up").notNull().default(false),
  deviceType: text("device_type"),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
}, (t) => [
  index("passkeys_by_user").on(t.userId),
]);

export const passkeyChallenges = pgTable("passkey_challenges", {
  id: text("id").primaryKey(),
  challengeHash: text("challenge_hash").notNull(),
  userId: text("user_id"),
  expiresAt: text("expires_at").notNull(),
});

export const invites = pgTable("invites", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  email: text("email"),
  role: text("role").$type<Role>().notNull(),
  maxUses: integer("max_uses"),
  uses: integer("uses").notNull().default(0),
  expiresAt: text("expires_at").notNull(),
  createdBy: text("created_by").notNull(),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("invites_by_token_hash").on(t.tokenHash),
]);

// A single row, keyed by a constant: the instance's registration gates.
export const authSettings = pgTable("auth_settings", {
  id: text("id").primaryKey(),
  allowOpenRegistration: boolean("allow_open_registration").notNull().default(false),
  allowForgeOrgJoin: boolean("allow_forge_org_join").notNull().default(false),
  updatedAt: text("updated_at").notNull(),
});

export const authSigningKeys = pgTable("auth_signing_keys", {
  kid: text("kid").primaryKey(),
  privateJwk: jsonb("private_jwk").$type<Record<string, unknown>>().notNull(),
  publicJwk: jsonb("public_jwk").$type<Record<string, unknown>>().notNull(),
  createdAt: text("created_at").notNull(),
});

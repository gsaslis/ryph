// The shared shapes of ryph auth.
//
// This package is a service-shaped library: it has its own storage, routes, and composition
// roots, but its DEFAULT deployment is mounted inside another service's HTTP server (the
// orchestrator today). The boundary other components rely on is the token contract, not the
// process: EdDSA-signed access tokens verified statelessly against the published JWKS.
//
// Invariants:
// - a raw credential never lands in a row: passwords are stored as scrypt hashes,
//   refresh tokens as SHA-256 digests
// - User.passwordHash never leaves this package: everything user-facing is a PublicUser

import type { Capability, CapabilityClaim, Role } from "./capabilities.ts";

/** A deactivated user keeps every row but can neither sign in nor refresh. */
/** The longest any free-text field may be; also what `ensureOwner` cuts a git name to. Here so
 * the core owns it and the HTTP schema reads it from the core, not the other way round. */
export const MAX_LEN = 10_000;

export type UserStatus = "active" | "deactivated";

/**
 * The domain of the stand-in addresses accounts without a proven one hold (`unprovenEmail`).
 * Under `.invalid`, a name reserved never to resolve, so no mail reaches one and no provider can
 * verify one; no form accepts an address there (`isReservedAddress`).
 */
const ADDRESSLESS_DOMAIN = "users.ryph.invalid";

/** The stand-in address of an account registered without a proven one: its own id, so it is
 * as unique as the account and names nothing else. */
export function addresslessEmail(userId: string): string {
  return `${userId.toLowerCase()}@${ADDRESSLESS_DOMAIN}`;
}

/** Whether an address is under a reserved, never-delivered TLD: a stand-in, or one like it that
 * nobody may register, invite or sign in with in its place. */
export function isReservedAddress(email: string): boolean {
  return email.toLowerCase().endsWith(".invalid");
}

export interface User {
  id: string;
  /** The login identifier, stored lowercased. */
  email: string;
  name: string;
  /** Null for an account that signs in only through a linked identity or a passkey. */
  passwordHash: string | null;
  role: Role;
  status: UserStatus;
  /** When the account was proven usable, null until then: its address proven, or (see
   * `unprovenEmail`) a provider that does not prove addresses vouching for the person. */
  emailVerifiedAt: string | null;
  /**
   * The address a provider whose verification is no proof here (GitLab's, see
   * `IdentityProvider.trustsEmails`) gave for the person this account was registered for, kept
   * to be shown — as unproven — and never looked up. Such an account's `email` is not that
   * address but `addresslessEmail`'s stand-in: an address nobody has proven is never the key to
   * an account, so whoever does prove it later gets an account of their own, not this one.
   */
  unprovenEmail: string | null;
  /** A "forgot password" that no mailer could answer, waiting for an admin to hand over a link. */
  resetRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A User as the outside may see it: the hash is replaced by the fact of its existence. */
export type PublicUser = Omit<User, "passwordHash"> & { hasPassword: boolean };

export function toPublicUser(user: User): PublicUser {
  const { passwordHash, ...rest } = user;
  return { ...rest, hasPassword: passwordHash !== null };
}

/**
 * One refresh session. The refresh token itself is opaque and random; only its digest lands
 * here. Rotation deletes the row and mints a fresh one, so a replayed old token dies loudly.
 * The client metadata is what a "your sessions" list shows; it decides nothing.
 */
export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  userAgent: string | null;
  ip: string | null;
  /** The last rotation, null until the first. */
  lastUsedAt: string | null;
}

/** The client-side facts a session is minted with. */
export interface SessionMeta {
  userAgent: string | null;
  ip: string | null;
}

/** A session as its owner may see it: everything but the token digest. */
export type SessionSummary = Omit<Session, "tokenHash">;

/**
 * A user's account on an identity provider — a forge, today. `providerAccountId` is the
 * provider's stable id, the key a sign-in resolves by; the login is what people and permission
 * checks refer to, and providers let it be renamed and reassigned.
 */
export interface ExternalIdentity {
  id: string;
  userId: string;
  provider: string;
  providerAccountId: string;
  login: string;
  /** The provider's primary address for the account, when it shared one. */
  email: string | null;
  /** Whether the provider itself vouched for `email`. */
  emailVerified: boolean;
  createdAt: string;
  updatedAt: string;
}

/** An identity as its owner may see it. */
export interface IdentitySummary {
  provider: string;
  login: string;
  linkedAt: string;
}

/**
 * A passkey: a WebAuthn credential the user's device holds, whose public half lives here. The
 * counter is the replay tripwire — an assertion that does not move it forward is refused.
 */
export interface Passkey {
  /** The credential id, base64url — what the authenticator presents. */
  id: string;
  userId: string;
  /** The COSE public key, base64url. */
  publicKey: string;
  counter: number;
  transports: string[];
  /** What the owner calls it: "MacBook", "YubiKey". */
  name: string;
  backedUp: boolean;
  deviceType: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** A passkey as its owner's list shows it. */
export type PasskeySummary = Omit<Passkey, "publicKey" | "counter">;

/**
 * A WebAuthn challenge in flight, as its digest: minted with the options, spent by the response.
 * A row rather than a process map, so any replica can finish what another started.
 */
export interface PasskeyChallenge {
  id: string;
  challengeHash: string;
  /** The user registering, or null for a sign-in nobody has named yet. */
  userId: string | null;
  expiresAt: string;
}

/**
 * One outstanding "prove you hold this key" challenge: a nonce this deployment minted, who it
 * was minted for, on which provider, and when it stops being spendable. Single-use — see
 * `consumeIdentityChallenge`. Nothing in it is secret: the nonce is public the moment it is
 * shown, and what it protects is freshness, not confidentiality.
 */
export interface IdentityChallenge {
  nonce: string;
  userId: string;
  provider: string;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
}

export type OneTimeTokenKind = "verify-email" | "reset-password" | "login";

/**
 * A link's secret, stored as its digest. Minting a new one of a kind voids the user's older
 * ones, so only the latest link works; using it stamps `usedAt`, so it works once.
 */
export interface OneTimeToken {
  id: string;
  kind: OneTimeTokenKind;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

/**
 * An invitation to create an account. Bound to an address, it is single-use and proves the
 * address on acceptance; open, it is a link anyone may follow, up to `maxUses` times.
 * Only the token's digest is stored; the link itself is shown once, when the invite is made.
 */
export interface Invite {
  id: string;
  tokenHash: string;
  email: string | null;
  role: Role;
  /** Null: unlimited. Bound invites are always 1. */
  maxUses: number | null;
  uses: number;
  expiresAt: string;
  createdBy: string;
  revokedAt: string | null;
  createdAt: string;
}

/** An invite as an admin's list shows it. */
export type InviteSummary = Omit<Invite, "tokenHash">;

/** What the invite page learns before anyone types: whom it is for, and whether it still works. */
export interface InvitePreview {
  email: string | null;
  role: Role;
  valid: boolean;
}

/** The instance-wide gates on who may create an account. Invites are always open. */
export interface AuthSettings {
  /** Anyone with an email address may register. */
  allowOpenRegistration: boolean;
  /** A member of an org the forge App is installed on may register by signing in through it. */
  allowForgeOrgJoin: boolean;
  updatedAt: string;
}

/** The Ed25519 signing keypair, JWK-encoded. Only the auth composition root ever sees it. */
export interface SigningKey {
  kid: string;
  privateJwk: Record<string, unknown>;
  publicJwk: Record<string, unknown>;
  createdAt: string;
}

/**
 * A long-lived credential a user mints for a script or an agent: a subset of their own
 * capabilities, exchanged for an ordinary access token. Only its digest lands here; the secret
 * is shown once, when it is minted. Revoking it, or its owner losing a capability, is felt at
 * the next exchange.
 */
export interface ApiToken {
  id: string;
  userId: string;
  /** What the owner calls it: "deploy script", "my agent". */
  name: string;
  tokenHash: string;
  caps: Capability[];
  expiresAt: string;
  createdAt: string;
  /** The last exchange, null until the first. */
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** An API token as its owner's list shows it. */
export type ApiTokenSummary = Omit<ApiToken, "tokenHash">;

/** What a verified access token asserts. This is the contract every service consumes. */
export interface Claims {
  /** The user id. */
  sub: string;
  email: string;
  name: string;
  /** The user's role, expanded: every capability they hold, or `["*"]` for an owner. */
  caps: readonly CapabilityClaim[];
  emailVerified: boolean;
  /**
   * The credential behind the token: a refresh session's id, or an API token's. Which one
   * `via` says; a service that records who acted records the difference.
   */
  sid: string;
  via: "session" | "token";
}

/** What login and refresh hand back. */
export interface TokenPair {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  refreshToken: string;
  user: PublicUser;
}

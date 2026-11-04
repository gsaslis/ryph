// The auth service: password login, token minting, refresh rotation, user management.
// Every operation returns a discriminated outcome, never throws for a caller mistake —
// the HTTP layer maps outcomes onto status codes.
//
// Invariants:
// - login costs the same time whether the user exists or not (decoy verify), and its
//   failure answer never distinguishes the two
// - refresh tokens rotate on every use: the presented token's session is deleted before a
//   new one is minted, so a replayed token is dead on arrival
// - multi-user, the first user ever created becomes the owner by presenting the setup token the
//   control plane prints at boot (see bootstrap.ts), and the insert that makes them owner is one
//   locked decision; afterwards an account comes from an invite, a provider the gates admit, or
//   open registration
// - single-user (the local binary's default), the owner is made by the composition root at boot
//   and signs in through one-time login links; nothing adds, invites, admits or re-roles anyone
// - an invite's raw token exists only in the response that minted it, and a verification or
//   reset link's only in the mail that carried it or the admin's screen that showed it
// - the last owner cannot be demoted, deactivated, or deleted, so an instance never ends up
//   with nobody able to administer it
// - a user always keeps at least one way to sign in: a password, a linked identity, or a passkey

import { importJWK, SignJWT } from "jose";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  ApiToken,
  ApiTokenSummary,
  AuthSettings,
  Claims,
  ExternalIdentity,
  IdentitySummary,
  Invite,
  InvitePreview,
  InviteSummary,
  OneTimeToken,
  OneTimeTokenKind,
  Passkey,
  PasskeySummary,
  PublicUser,
  SessionMeta,
  SessionSummary,
  SigningKey,
  TokenPair,
  User,
  UserStatus,
} from "./types.ts";
import {
  can,
  type Capability,
  type CapabilityClaim,
  capsClaimOf,
  type Role,
} from "./capabilities.ts";
import { addresslessEmail, isReservedAddress, toPublicUser } from "./types.ts";
import { ensureSigningKey, toJwks } from "./keys.ts";
import type { AuthStore } from "../ports/auth_store.ts";
import {
  type ChallengeProvider,
  type IdentityProof,
  type IdentityProvider,
  NO_CODE_LEG,
  type OAuthCodeLeg,
  type ProviderIdentity,
} from "../ports/identity_provider.ts";
import type { Mailer } from "../ports/mailer.ts";
import { mintId, mintToken, sha256Hex } from "@ryph/sealed";
import { DECOY_HASH, hashPassword, verifyPassword } from "../helpers/password.ts";
import { isSetupToken, setupTokenFor } from "./bootstrap.ts";
import { fromBase64Url, toBase64Url } from "../helpers/base64url.ts";
import { MAX_LEN } from "./types.ts";

export interface AuthConfig {
  /** `iss` and `aud` on every access token; verifiers pin both. */
  issuer?: string;
  audience?: string;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
}

export interface AuthServiceDeps {
  store: AuthStore;
  now(): Date;
  config?: AuthConfig;
  /** Null: no provider is configured, so sign-in and linking through one are refused. */
  identityProvider?: IdentityProvider | null;
  /** Null: no provider proves an identity by signed challenge, so those routes refuse. */
  challengeProvider?: ChallengeProvider | null;
  /** Null: nothing is mailed; every link is handed to an admin instead. */
  mailer?: Mailer | null;
  /**
   * The web app's origin as a browser reaches it — what every mailed link starts with. A path
   * on it is dropped: the app is served at the root (it sets no `paths.base`), and the binary
   * serves the embedded app on the URL's origin alone.
   */
  appUrl?: string | null;
  /** Where a failed send is reported; sends never fail the request that asked for them. */
  onMailError?: (err: unknown) => void;
  /**
   * False: one person uses this instance. Their account is made at boot (`ensureOwner`), and
   * everything that would add or re-role another — registration, invites, a provider's
   * registration gates, user management — is refused here, not just hidden. Default true.
   */
  multiUser?: boolean;
  /**
   * Whether this deployment hands the single-user owner login links: the binary and `bun run
   * up` print one at boot and mint them for `ryph login`. A networked orchestrator run with
   * RYPH_MULTIUSER=off mints none, so there a link is no way in. Default false.
   */
  loginLinks?: boolean;
}

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
/** How long an unproven address may linger before its account is purged. */
const UNVERIFIED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** How long an identity challenge stays spendable. Long enough to switch to a terminal, find
 * the key and paste the line back; short enough that a nonce seen in transit is stale before
 * it is useful. */
const IDENTITY_CHALLENGE_TTL_MS = 10 * 60 * 1000;
/** How long a login link works: long enough to switch to the browser, short enough that one
 * left in a scrollback is dead by the time anyone else reads it. */
const LOGIN_LINK_TTL_MS = 10 * 60 * 1000;
const RP_NAME = "ryph";

/** Where each kind of link lands in the app, and how long it works. */
const LINK_PATHS: Record<OneTimeTokenKind, string> = {
  "verify-email": "verify-email",
  "reset-password": "reset-password",
  login: "auth/login-link",
};
const LINK_TTL_MS: Record<OneTimeTokenKind, number> = {
  "verify-email": VERIFY_TTL_MS,
  "reset-password": RESET_TTL_MS,
  login: LOGIN_LINK_TTL_MS,
};

export type LoginOutcome =
  | { ok: true; tokens: TokenPair }
  | { ok: false; error: "invalid-credentials" };

export type RefreshOutcome =
  | { ok: true; tokens: TokenPair }
  | { ok: false; error: "invalid-refresh-token" };

export type CreateUserOutcome =
  /** `user` is null when the address already had an account: open registration answers the
   * same either way, so a form cannot be used to enumerate addresses. */
  | { ok: true; user: PublicUser | null; bootstrapped: boolean }
  | { ok: false; error: "registration-closed" }
  | { ok: false; error: "incomplete" }
  /** The first registration without the setup token, or with a wrong one. */
  | { ok: false; error: "setup-token" }
  | { ok: false; error: "single-user" };

export type SendMailOutcome = "sent" | "no-mailer";

export type TokenOutcome =
  | { ok: true }
  | { ok: false; error: "invalid-token" };

export type VerifyEmailOutcome =
  | { ok: true; tokens: TokenPair }
  | { ok: false; error: "invalid-token" };

export type PasskeyOptionsOutcome<O> =
  | { ok: true; challengeId: string; options: O }
  | { ok: false; error: "no-app-url" }
  | { ok: false; error: "not-found" }
  | { ok: false; error: "unverified" };

export type RegisterPasskeyOutcome =
  | { ok: true; passkey: PasskeySummary }
  | { ok: false; error: "no-app-url" }
  | { ok: false; error: "invalid" }
  | { ok: false; error: "unverified" };

export type PasskeyLoginOutcome =
  | { ok: true; tokens: TokenPair }
  | { ok: false; error: "no-app-url" }
  | { ok: false; error: "invalid" }
  | { ok: false; error: "deactivated" };

export type DeletePasskeyOutcome =
  | { ok: true }
  | { ok: false; error: "not-found" }
  | { ok: false; error: "last-sign-in-method" };

export type LinkOutcome =
  | { ok: true; link: string }
  | { ok: false; error: "not-found" }
  | { ok: false; error: "no-app-url" };

export type ResetLinkOutcome =
  | LinkOutcome
  /** An owner's password is changed signed in, never through a link. */
  | { ok: false; error: "owner" }
  /** The account holds a stand-in, no address (`User.unprovenEmail`): a password would be one
   * nobody signs in with, and the link one nobody can be sure is theirs. */
  | { ok: false; error: "no-address" };

export type VerificationLinkOutcome =
  | LinkOutcome
  /** The address is proven; a verification link would only set a new password behind it. */
  | { ok: false; error: "already-verified" };

export type LoginLinkOutcome =
  | { ok: true; link: string }
  /** Login links are the single-user way in; with several users, each signs in as themself. */
  | { ok: false; error: "multi-user" }
  /** No owner who can hold a session. */
  | { ok: false; error: "not-found" }
  | { ok: false; error: "no-app-url" };

/** A configuration auth refuses outright, as opposed to a store it cannot read: a root says
 * this one as it is rather than as a schema problem. */
export class AuthConfigError extends Error {
  override name = "AuthConfigError";
}

/**
 * The origin every link and the passkey relying party are built on. RYPH_APP_URL must be an
 * absolute http(s) URL: without a scheme, `localhost:5173` parses with "localhost:" as one and
 * an origin of "null", which would only fail later and look like something else.
 */
export function appOrigin(appUrl: string): string {
  const url = URL.parse(appUrl);
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new AuthConfigError(
      `RYPH_APP_URL must be an absolute http(s) URL, got ${JSON.stringify(appUrl)}`,
    );
  }
  return url.origin;
}

export type UpdateProfileOutcome =
  | { ok: true; user: PublicUser }
  | { ok: false; error: "not-found" }
  | { ok: false; error: "email-taken" }
  /** The address is how other people are told apart; only a single-user instance's owner
   * changes it without proving the new one. */
  | { ok: false; error: "multi-user" }
  /** Single-user, but not the owner: someone left over from multi-user keeps their address. */
  | { ok: false; error: "owner-only" };

export type CreateInviteOutcome =
  | { ok: true; invite: InviteSummary; token: string }
  | { ok: false; error: "email-taken" }
  | { ok: false; error: "single-user" };

export type AcceptInviteOutcome =
  /** `tokens` is null when the account still has to prove its address: no session exists
   * before that, and the mailed link is where the password gets set. */
  | { ok: true; tokens: TokenPair | null }
  | { ok: false; error: "invalid-invite" }
  | { ok: false; error: "email-required" }
  | { ok: false; error: "incomplete" }
  | { ok: false; error: "email-taken" }
  | { ok: false; error: "single-user" };

export type UpdateUserOutcome =
  | { ok: true; user: PublicUser }
  | { ok: false; error: "not-found" }
  | { ok: false; error: "last-owner" }
  | { ok: false; error: "single-user" };

export type DeleteUserOutcome =
  | { ok: true }
  | { ok: false; error: "not-found" }
  | { ok: false; error: "last-owner" }
  | { ok: false; error: "single-user" };

export type MintApiTokenOutcome =
  | { ok: true; token: string; summary: ApiTokenSummary }
  | { ok: false; error: "not-found" }
  /** A capability the owner does not hold themself. */
  | { ok: false; error: "beyond-owner" };

export type ExchangeApiTokenOutcome =
  | { ok: true; accessToken: string; expiresIn: number }
  | { ok: false; error: "invalid-token" };

export type ChangePasswordOutcome =
  | { ok: true }
  | { ok: false; error: "not-found" }
  | { ok: false; error: "invalid-credentials" };

export type UnlinkIdentityOutcome =
  | { ok: true }
  | { ok: false; error: "not-found" }
  | { ok: false; error: "last-sign-in-method" };

export type ProviderLoginOutcome =
  | { ok: true; tokens: TokenPair }
  | { ok: false; error: "no-provider" }
  | { ok: false; error: "code-refused" }
  | { ok: false; error: "deactivated" }
  | { ok: false; error: "no-verified-email" }
  | { ok: false; error: "membership-unknown" }
  | { ok: false; error: "no-organization" }
  | { ok: false; error: "registration-closed" }
  | { ok: false; error: "invalid-invite" }
  | { ok: false; error: "invite-email-mismatch" }
  | { ok: false; error: "linked-before-upgrade" }
  | { ok: false; error: "link-required" };

export type LinkProviderOutcome =
  | { ok: true; identity: IdentitySummary }
  | { ok: false; error: "no-provider" }
  | { ok: false; error: "code-refused" }
  | { ok: false; error: "not-found" }
  | { ok: false; error: "unverified" }
  | { ok: false; error: "linked-elsewhere" };

/** The nonce, when it lapses, and the line that signs it — everything the card shows. */
export interface IdentityChallengeOffer {
  nonce: string;
  expiresAt: string;
  command: string;
}

export type MintChallengeOutcome =
  | { ok: true; challenge: IdentityChallengeOffer }
  | { ok: false; error: "no-provider" }
  | { ok: false; error: "not-found" }
  | { ok: false; error: "unverified" };

export type LinkProofOutcome =
  | { ok: true; identity: IdentitySummary }
  | { ok: false; error: "no-provider" }
  | { ok: false; error: "not-found" }
  | { ok: false; error: "unverified" }
  /** Unparseable, wrong key, wrong namespace, wrong nonce, expired, already spent — one answer
   * for all of them. Saying which would tell a prober where to aim. */
  | { ok: false; error: "bad-proof" }
  | { ok: false; error: "linked-elsewhere" };

const NO_META: SessionMeta = { userAgent: null, ip: null };

export interface AuthService {
  login(email: string, password: string, meta?: SessionMeta): Promise<LoginOutcome>;
  refresh(refreshToken: string, meta?: SessionMeta): Promise<RefreshOutcome>;
  /** Total: an unknown or already-dead token logs out to the same place. */
  logout(refreshToken: string): Promise<void>;
  /**
   * Registers. In setup mode the first owner, named, with a password, verified. Afterwards,
   * while open registration is on, a placeholder for the address alone: no name, no password and
   * no session until the mailed link is opened, so nothing a registrant chose can outlive the
   * proof that the address is theirs. A taken address re-sends the link when it is still
   * unproven, and is otherwise ignored.
   */
  createUser(
    input: { email: string; name?: string; password?: string; setupToken?: string },
  ): Promise<CreateUserOutcome>;
  /**
   * An admin's copy of the verification link, for a deployment that cannot mail it. Only for an
   * unproven address: on a proven one the link would set a password, which is a reset.
   */
  mintVerificationLink(userId: string): Promise<VerificationLinkOutcome>;
  /**
   * Proves the address and gives the account its name and password in one step, then signs in.
   * The account's first proof also strips whatever was attached before it — see `disown`. An
   * account already proven refuses, whenever the link was minted: it would be a reset that
   * signs in, and an owner's would hand over the instance.
   */
  verifyEmail(
    token: string,
    input: { name: string; password: string },
    meta?: SessionMeta,
  ): Promise<VerifyEmailOutcome>;
  /**
   * Total, and uniform: an unknown address, a deactivated user, and a real request all answer
   * the same. With a mailer the link goes out; without one the request waits for an admin. An
   * unproven address gets its verification link instead, which is where its password is set;
   * the admin's copy of "the reset link" is that link too. A proven owner gets nothing (see
   * `resetPassword`), and the answer is the same; an unproven one still gets that link.
   */
  forgotPassword(email: string): Promise<void>;
  /**
   * An admin's copy of a reset link; also settles a pending request. Never a proven owner's; an
   * unproven account, owner or not, gets its verification link.
   */
  mintResetLink(userId: string): Promise<ResetLinkOutcome>;
  /** The users whose "forgot password" nobody could mail, oldest first. */
  listResetRequests(): Promise<PublicUser[]>;
  /**
   * Sets the password behind a reset link, proves the address, and ends every session. Never
   * an owner's, whenever the link was minted: an owner's address may never have been proven (the
   * git config or a single-user profile edit names it), so a mailed reset would hand the instance
   * to whoever holds that mailbox. Owners change their password signed in.
   */
  resetPassword(token: string, password: string): Promise<TokenOutcome>;
  /** Whether links can be mailed at all — what an admin page states next to the gates. */
  mailerConfigured(): boolean;

  /** The options a browser registers a passkey with; the challenge is pinned for five minutes. */
  passkeyRegistrationOptions(
    userId: string,
  ): Promise<PasskeyOptionsOutcome<PublicKeyCredentialCreationOptionsJSON>>;
  registerPasskey(
    userId: string,
    challengeId: string,
    response: RegistrationResponseJSON,
    name: string,
  ): Promise<RegisterPasskeyOutcome>;
  listPasskeys(userId: string): Promise<PasskeySummary[]>;
  renamePasskey(userId: string, id: string, name: string): Promise<PasskeySummary | null>;
  deletePasskey(userId: string, id: string): Promise<DeletePasskeyOutcome>;
  /** The options for a discoverable sign-in: no account named, the authenticator picks one. */
  passkeyLoginOptions(): Promise<PasskeyOptionsOutcome<PublicKeyCredentialRequestOptionsJSON>>;
  loginWithPasskey(
    challengeId: string,
    response: AuthenticationResponseJSON,
    meta?: SessionMeta,
  ): Promise<PasskeyLoginOutcome>;
  /** Housekeeping on a slow tick: purges accounts unproven past their grace, and dead tokens. */
  sweep(): Promise<{ purgedUsers: number }>;
  /** Mints an invite; the raw token comes back once. Refused for an address that has an account. */
  createInvite(
    input: { email: string | null; role: Role; expiresInMs: number; maxUses: number | null },
    createdBy: string,
  ): Promise<CreateInviteOutcome>;
  listInvites(): Promise<InviteSummary[]>;
  /** Total: revoking an unknown or already-revoked invite changes nothing. */
  revokeInvite(id: string): Promise<void>;
  /** What the invite page shows before anyone types; null for a token nobody minted. */
  previewInvite(token: string): Promise<InvitePreview | null>;
  /**
   * Creates the account an invite admits. Bound: the address is the invite's and counts as
   * verified, so name and password are set here and a session comes back. Open: the caller gives
   * an address, and the account is a placeholder like an open registration until the link proves
   * it.
   */
  acceptInvite(
    token: string,
    input: { name?: string; email: string | null; password?: string },
    meta?: SessionMeta,
  ): Promise<AcceptInviteOutcome>;
  getUser(id: string): Promise<PublicUser | null>;
  listUsers(): Promise<PublicUser[]>;
  setRole(userId: string, role: Role): Promise<UpdateUserOutcome>;
  /** Deactivating also ends every session, so the lockout is immediate on the refresh path. */
  setStatus(userId: string, status: UserStatus): Promise<UpdateUserOutcome>;
  deleteUser(userId: string): Promise<DeleteUserOutcome>;
  /**
   * Sets or replaces the password. `current` must match when one exists; an account that has
   * none (linked-identity only) sets its first without one. Ends every other session and voids
   * any login link still unspent.
   */
  changePassword(
    userId: string,
    current: string | null,
    next: string,
  ): Promise<ChangePasswordOutcome>;

  /**
   * Whether the session a token names still exists. An access token outlives a revoked session
   * by up to its own TTL; anything that changes how a person signs in asks this first, so a
   * token minted before a takeover cannot arm the account afterwards.
   */
  sessionAlive(sid: string): Promise<boolean>;
  listSessions(userId: string): Promise<SessionSummary[]>;
  /** Scoped to the owner: a session id from another user is simply not found. */
  revokeSession(userId: string, sessionId: string): Promise<void>;
  /** Signs out everywhere: every session, and any login link still unspent. */
  revokeAllSessions(userId: string): Promise<void>;
  /**
   * Whether the credential behind a token's claims is still live: its refresh session, or the
   * API token it was exchanged from. What every act that must not outlive a revocation asks.
   */
  credentialAlive(claims: Pick<Claims, "sid" | "via">): Promise<boolean>;

  /**
   * Mints an API token for a user: a subset of the capabilities they hold, spelled out. The
   * secret comes back once, here; the store keeps its digest.
   */
  mintApiToken(
    userId: string,
    input: { name: string; caps: readonly Capability[]; expiresInMs: number },
  ): Promise<MintApiTokenOutcome>;
  /** The user's tokens, newest first, revoked ones included so a list can say when. */
  listApiTokens(userId: string): Promise<ApiTokenSummary[]>;
  /** Revokes one; scoped to `ownerUserId` unless null, when any user's token may go. */
  revokeApiToken(id: string, ownerUserId: string | null): Promise<boolean>;
  /**
   * Trades an API token's secret for an access token, good for the access TTL and carrying the
   * token's capabilities narrowed to what its owner holds now. A revoked, expired or unknown
   * secret, and one whose owner is deactivated or unproven, all answer the same.
   */
  exchangeApiToken(secret: string): Promise<ExchangeApiTokenOutcome>;

  /** The providers sign-in may be offered for; empty without an identity provider. */
  providers(): string[];
  /**
   * Signs in through a provider, in this order: the account is already linked; a verified
   * account carries one of the provider-verified addresses (link it, unless it is an owner's,
   * which links only from its own settings); an unverified account does (claim it — the provider
   * proved the address, whoever registered it did not); an invite or a registration gate admits
   * the person (create). The address steps run only for a provider whose verification is proof
   * (`trustsEmails`): another provider's addresses are looked at only once the person is
   * admitted, and then only to refuse one some account holds already; the account it creates
   * holds a stand-in, not them (`User.unprovenEmail`). Anything else refuses.
   */
  loginWithProvider(
    provider: string,
    code: string,
    meta?: SessionMeta,
    invite?: string | null,
    leg?: OAuthCodeLeg,
  ): Promise<ProviderLoginOutcome>;
  /** Links a provider account to the signed-in user; an account linked to someone else stays.
   * `leg` is what the authorize leg pinned (`OAuthCodeLeg`), passed to the provider as it is. */
  linkProvider(
    userId: string,
    provider: string,
    code: string,
    leg?: OAuthCodeLeg,
  ): Promise<LinkProviderOutcome>;
  /** The providers an identity is proved to by signed challenge rather than by OAuth. Never
   * offered as a way IN: there is no account on the other side to sign in to. */
  challengeProviders(): string[];
  /** Mints a single-use nonce for one, and the line that signs it. */
  mintIdentityChallenge(userId: string, provider: string): Promise<MintChallengeOutcome>;
  /** Spends the outstanding challenge the proof verifies against, and links what it proved. */
  linkProviderByProof(
    userId: string,
    provider: string,
    proof: IdentityProof,
  ): Promise<LinkProofOutcome>;
  listIdentities(userId: string): Promise<IdentitySummary[]>;
  unlinkIdentity(userId: string, provider: string): Promise<UnlinkIdentityOutcome>;

  getSettings(): Promise<AuthSettings>;
  updateSettings(patch: Partial<Omit<AuthSettings, "updatedAt">>): Promise<AuthSettings>;

  /** Whether more than one person may use this instance (see `AuthServiceDeps.multiUser`). */
  multiUser(): boolean;
  /**
   * The token the first registration must present, while there is no user to register over;
   * null once there is one, and always null single-user, where nobody registers. What the
   * composition root prints at boot.
   */
  setupToken(): Promise<string | null>;
  /**
   * Single-user: the owner, made now with the given name and address if the instance has
   * nobody yet. Otherwise the oldest owner who can hold a session, or null when there is none.
   */
  ensureOwner(defaults: { email: string; name: string }): Promise<PublicUser | null>;
  /**
   * Single-user: a one-time link that signs the owner in, good for ten minutes. `fallbackAppUrl`
   * builds it when the service has no app URL of its own, and is used for nothing else.
   */
  mintLoginLink(fallbackAppUrl?: string | null): Promise<LoginLinkOutcome>;
  /**
   * Whether anyone can still administer this instance without a login link: true when it has
   * nobody yet (a setup token claims it), or when an active, verified owner has a password, a
   * passkey, or a linked identity for a provider configured now. A passkey is bound to an origin
   * this boot cannot confirm, but sign-in already lets one stand as an owner's only way in, so a
   * boot that refused it would lock out an owner the running instance let through. Multi-user
   * refuses login links, so switching with this false can lock every owner out.
   */
  ownerCanSignIn(): Promise<boolean>;
  /**
   * The addresses of the owners `ownerCanSignIn` counts: active, verified, and holding a
   * password, a passkey, or an identity for a provider configured now. Null when the instance has nobody
   * yet, which `ownerCanSignIn` also counts as a way in. What a root checks for a lockout and a
   * placeholder address before booting multi-user, in one scan.
   */
  ownerSignInEmails(): Promise<string[] | null>;
  /** Spends a login link for a session. */
  redeemLoginLink(token: string, meta?: SessionMeta): Promise<VerifyEmailOutcome>;
  /** The signed-in user's own name, and the single-user owner's address too. */
  updateProfile(
    userId: string,
    input: { name?: string; email?: string },
  ): Promise<UpdateProfileOutcome>;
  /**
   * Whether this deployment still has no users, so the next `createUser` would bootstrap the
   * first admin. Exists for the surface that has to decide whether to OFFER registration: a
   * form that can only ever answer "unauthorized" is worse than no form.
   */
  needsBootstrap(): Promise<boolean>;
  /**
   * Every stored key's public half. Read on each call rather than captured at boot: with
   * replicas the set grows behind this process's back, and a document frozen at startup would
   * omit whichever key a peer minted after it.
   */
  jwks(): Promise<{ keys: Record<string, unknown>[] }>;
}

/**
 * Git's user.name as the account page can save it back: one line, within the schema's bound,
 * never empty. Raw, a newline or an overlong name would make every later profile save fail.
 */
const ownerName = (raw: string): string =>
  raw.replace(/\s+/g, " ").trim().slice(0, MAX_LEN).trim() || "Owner";

export async function makeAuthService(deps: AuthServiceDeps): Promise<AuthService> {
  const { store } = deps;
  const issuer = deps.config?.issuer ?? "ryph";
  const audience = deps.config?.audience ?? "ryph";
  const accessTtl = deps.config?.accessTtlSeconds ?? 600; // 10 minutes
  const refreshTtl = deps.config?.refreshTtlSeconds ?? 30 * 24 * 3600; // 30 days
  const nowIso = () => deps.now().toISOString();
  const multiUser = deps.multiUser ?? true;
  const loginLinks = deps.loginLinks ?? false;
  // Before the store: a bad RYPH_APP_URL is the operator's typo, not an unprovisioned database.
  const appUrl = deps.appUrl == null ? null : appOrigin(deps.appUrl);

  const key: SigningKey = await ensureSigningKey(store, nowIso());
  const privateKey = await importJWK(key.privateJwk as Parameters<typeof importJWK>[0], "EdDSA");

  /**
   * Mints the pair every sign-in path ends in. `lineage` is a rotation's inheritance: the new
   * session keeps the original's start so a sessions list shows one session, not one per refresh.
   */
  const mintPair = async (
    user: User,
    meta: SessionMeta,
    lineage: { createdAt: string } | null = null,
  ): Promise<TokenPair> => {
    if (user.status !== "active" || user.emailVerifiedAt === null) {
      throw new Error("mintPair: only an active, verified user can hold a session");
    }
    const sessionId = mintId("s");
    const accessToken = await signAccess(user, capsClaimOf(user.role), sessionId, "session");

    const refreshToken = mintToken();
    await store.createSession({
      id: sessionId,
      userId: user.id,
      tokenHash: await sha256Hex(refreshToken),
      expiresAt: new Date(deps.now().getTime() + refreshTtl * 1000).toISOString(),
      createdAt: lineage?.createdAt ?? nowIso(),
      userAgent: meta.userAgent,
      ip: meta.ip,
      lastUsedAt: lineage === null ? null : nowIso(),
    });
    return { accessToken, expiresIn: accessTtl, refreshToken, user: toPublicUser(user) };
  };

  /** One access token: the claims every service reads, signed with this deployment's key. */
  const signAccess = async (
    user: User,
    caps: readonly CapabilityClaim[],
    sid: string,
    via: Claims["via"],
  ): Promise<string> => {
    const nowSec = Math.floor(deps.now().getTime() / 1000);
    return await new SignJWT({
      email: user.email,
      name: user.name,
      caps,
      email_verified: user.emailVerifiedAt !== null,
      sid,
      via,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: key.kid })
      .setSubject(user.id)
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + accessTtl)
      .sign(privateKey);
  };

  /** Whether an API token row may still be exchanged. */
  const apiTokenLive = (token: ApiToken): boolean =>
    token.revokedAt === null && token.expiresAt > nowIso();

  /** Whether removing this user's ownership would leave nobody able to act as an owner. */
  const isLastOwner = async (user: User): Promise<boolean> =>
    user.role === "owner" && user.status === "active" && user.emailVerifiedAt !== null &&
    (await store.countActiveOwners()) <= 1;

  /** Hands a message to the mailer without waiting on it: the transport's time is not the
   * caller's, and its failure is the operator's news, never the requester's. */
  const send = (mail: Parameters<Mailer["send"]>[0], onFailure?: () => Promise<void>): void => {
    if (mailer === null) return;
    mailer.send(mail).catch(async (err) => {
      deps.onMailError?.(err);
      await onFailure?.();
    });
  };

  const settingsOrDefault = async (): Promise<AuthSettings> =>
    (await store.getSettings()) ?? {
      allowOpenRegistration: false,
      allowForgeOrgJoin: false,
      updatedAt: nowIso(),
    };

  const summarize = (identity: ExternalIdentity): IdentitySummary => ({
    provider: identity.provider,
    login: identity.login,
    linkedAt: identity.updatedAt,
  });

  const provider = deps.identityProvider ?? null;
  const challenger = deps.challengeProvider ?? null;
  const mailer = deps.mailer ?? null;
  // A passkey is bound to the origin the browser sees: the app's, never the API's.
  const relyingParty = appUrl === null
    ? null
    : { id: new URL(appUrl).hostname, origin: new URL(appUrl).origin };

  const summarizePasskey = (
    { publicKey: _key, counter: _counter, ...rest }: Passkey,
  ): PasskeySummary => rest;

  /** Pins a challenge's digest and returns the id the browser hands back with its response. */
  const pinChallenge = async (challenge: string, userId: string | null): Promise<string> => {
    const id = mintId("ch");
    await store.createChallenge({
      id,
      challengeHash: await sha256Hex(challenge),
      userId,
      expiresAt: new Date(deps.now().getTime() + CHALLENGE_TTL_MS).toISOString(),
    });
    return id;
  };

  /** The pinned challenge behind an id, spent on the way out; null when it never was or is late. */
  const spendChallenge = async (id: string) => {
    const row = await store.takeChallenge(id);
    if (!row || Date.parse(row.expiresAt) <= deps.now().getTime()) return null;
    return row;
  };

  /**
   * Strips an account of everything its registrant could use to get back in. Applied at the
   * moment an unverified account is first proven — by the mailed link or by a provider-verified
   * sign-in: the registrant never proved the address, so nothing they attached to it may survive —
   * the password, every passkey, every linked identity, every session, every API token, and any
   * link token still unspent. Only an account nobody could yet sign into is ever claimed this
   * way, so there is nothing else of theirs to strip: an address only an untrusted provider
   * vouched for never keys an account at all (`User.unprovenEmail`).
   */
  const disown = async (user: User): Promise<void> => {
    for (const token of await store.listApiTokensByUser(user.id)) {
      if (token.revokedAt === null) await store.revokeApiTokenRow(token.id, nowIso());
    }
    for (const passkey of await store.listPasskeysByUser(user.id)) {
      await store.deletePasskey(passkey.id);
    }
    for (const identity of await store.listIdentitiesByUser(user.id)) {
      await store.deleteIdentity(user.id, identity.provider);
    }
    await store.deleteUnusedTokens(user.id, "verify-email");
    await store.deleteUnusedTokens(user.id, "reset-password");
    await store.deleteUnusedTokens(user.id, "login");
    await store.deleteSessionsByUser(user.id);
  };

  /**
   * Signs a user out everywhere: every session, and any login link still unspent, which would
   * otherwise mint a new one for ten minutes after the owner locked things down.
   */
  const lockDown = async (userId: string): Promise<void> => {
    await store.deleteUnusedTokens(userId, "login");
    await store.deleteSessionsByUser(userId);
  };

  /** The owner a single-user instance signs in as: the oldest who can hold a session. */
  const soleOwner = async (): Promise<User | null> =>
    (await store.listUsers()).find((u) =>
      u.role === "owner" && u.status === "active" && u.emailVerifiedAt !== null
    ) ?? null;

  /**
   * How many ways in a user has: the count a removal must leave at one or more. The single-user
   * owner a login link signs in (`soleOwner`, not every owner) has that link as one more, but
   * only where this deployment mints them (`loginLinks`); elsewhere nothing would hand one over.
   */
  const signInMethods = async (user: User): Promise<number> =>
    (!multiUser && loginLinks && (await soleOwner())?.id === user.id ? 1 : 0) +
    (user.passwordHash === null ? 0 : 1) +
    (await store.listIdentitiesByUser(user.id)).length +
    (await store.listPasskeysByUser(user.id)).length;

  /**
   * The owners with a way in of their own, without a login link: active, verified, and holding a
   * password, a passkey (see `ownerCanSignIn`), or an identity for a provider this boot signs in
   * with — not the ones configured when it was linked. Null when there is nobody at all.
   */
  const ownersWhoSignIn = async (): Promise<User[] | null> => {
    const signsIn = provider?.providers() ?? [];
    const users = await store.listUsers();
    if (users.length === 0) return null;
    const owners: User[] = [];
    for (const user of users) {
      if (user.role !== "owner" || user.status !== "active" || user.emailVerifiedAt === null) {
        continue;
      }
      if (
        user.passwordHash !== null ||
        (await store.listIdentitiesByUser(user.id)).some((i) => signsIn.includes(i.provider)) ||
        (await store.listPasskeysByUser(user.id)).length > 0
      ) owners.push(user);
    }
    return owners;
  };

  const ownerSignInEmails = async (): Promise<string[] | null> =>
    (await ownersWhoSignIn())?.map((user) => user.email) ?? null;

  /** Mints a link's secret for the user, voiding older links of the same kind. */
  const mintLinkToken = async (userId: string, kind: OneTimeTokenKind): Promise<string> => {
    const token = mintToken();
    await store.deleteUnusedTokens(userId, kind);
    await store.createToken({
      id: mintId("t"),
      kind,
      userId,
      tokenHash: await sha256Hex(token),
      expiresAt: new Date(deps.now().getTime() + LINK_TTL_MS[kind]).toISOString(),
      usedAt: null,
      createdAt: nowIso(),
    });
    return token;
  };

  const linkFor = (kind: OneTimeTokenKind, token: string): string | null =>
    appUrl === null ? null : `${appUrl}/${LINK_PATHS[kind]}/${token}`;

  /** The live token behind a raw secret, of the expected kind, or null. */
  const liveToken = async (
    token: string,
    kind: OneTimeTokenKind,
  ): Promise<OneTimeToken | null> => {
    const row = await store.getTokenByHash(await sha256Hex(token));
    if (!row || row.kind !== kind || row.usedAt !== null) return null;
    if (Date.parse(row.expiresAt) <= deps.now().getTime()) return null;
    return row;
  };

  const mailVerification = async (user: User): Promise<SendMailOutcome> => {
    if (mailer === null) return "no-mailer";
    const link = linkFor("verify-email", await mintLinkToken(user.id, "verify-email"));
    if (link === null) return "no-mailer";
    send({
      to: user.email,
      subject: "Finish setting up your ryph account",
      // No greeting by name: until the address is proven, the name is whatever the last
      // registrant typed, and this mail must not carry a stranger's words.
      text: `Choose your name and password, and confirm this address for your ryph account, ` +
        `by opening:\n\n` +
        `${link}\n\nThe link works once and expires in 24 hours. If you did not create an ` +
        `account, ignore this message.\n`,
    });
    return "sent";
  };

  /** An admin's copy of a link; minting it settles any request waiting on the admin. */
  const mintAdminLink = async (user: User, kind: OneTimeTokenKind): Promise<LinkOutcome> => {
    const link = linkFor(kind, await mintLinkToken(user.id, kind));
    if (link === null) return { ok: false, error: "no-app-url" };
    if (user.resetRequestedAt !== null) {
      await store.saveUser({ ...user, resetRequestedAt: null, updatedAt: nowIso() });
    }
    return { ok: true, link };
  };

  /** Whether the session a token was minted with still exists — the token's own life aside. */
  const sessionAlive = async (sid: string): Promise<boolean> =>
    (await store.getSessionById(sid)) !== null;

  /** Writes the provider's current view of the account, keeping the link's original date. */
  const saveIdentity = async (
    userId: string,
    name: string,
    identity: ProviderIdentity,
  ): Promise<ExternalIdentity> => {
    const at = nowIso();
    const existing = await store.getIdentity(userId, name);
    const row: ExternalIdentity = {
      id: existing?.id ?? mintId("i"),
      userId,
      provider: name,
      providerAccountId: identity.accountId,
      login: identity.login,
      email: identity.verifiedEmails[0] ?? null,
      emailVerified: identity.verifiedEmails.length > 0,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    await store.saveIdentity(row);
    // A row keyed `login:<login>` was carried over from a time links knew only the login. The
    // provider has now said whose the login is, so such a row on anyone else is stale: a login
    // can be given up and taken by someone new, and a stale row would answer for the wrong user.
    for (const stale of await store.listIdentitiesByLogin(name, identity.login)) {
      if (stale.userId !== userId && stale.providerAccountId === `login:${identity.login}`) {
        await store.deleteIdentity(stale.userId, name);
      }
    }
    return row;
  };

  const summarizeInvite = ({ tokenHash: _hash, ...rest }: Invite): InviteSummary => rest;

  const inviteIsLive = (invite: Invite): boolean =>
    invite.revokedAt === null &&
    Date.parse(invite.expiresAt) > deps.now().getTime() &&
    (invite.maxUses === null || invite.uses < invite.maxUses);

  /** The invite behind a raw token, when it still admits someone. */
  const liveInvite = async (token: string): Promise<Invite | null> => {
    const invite = await store.getInviteByTokenHash(await sha256Hex(token));
    return invite !== null && inviteIsLive(invite) ? invite : null;
  };

  const consumeInvite = (invite: Invite): Promise<boolean> => store.claimInviteUse(invite.id);

  /** Whether a registration gate admits a provider identity that matches no account. */
  const admits = async (
    name: string,
    who: { login: string; accountId: string },
  ): Promise<"yes" | "no" | "unknown" | "no-organization"> => {
    // Whatever the gates were left at: single-user, nobody else gets in through them.
    if (!multiUser) return "no";
    const settings = await settingsOrDefault();
    if (settings.allowOpenRegistration) return "yes";
    if (!settings.allowForgeOrgJoin || provider === null) return "no";
    const membership = await provider.isOrgMember(name, who);
    if (membership === "member") return "yes";
    return membership === "unknown" || membership === "no-organization" ? membership : "no";
  };

  return {
    async login(email, password, meta = NO_META) {
      const user = await store.getUserByEmail(email.toLowerCase());
      // The decoy keeps timing flat when the user does not exist or holds no password; the
      // single error keeps the answer from confirming which half was wrong.
      const valid = await verifyPassword(password, user?.passwordHash ?? DECOY_HASH);
      if (
        !user || user.passwordHash === null || !valid || user.status !== "active" ||
        user.emailVerifiedAt === null
      ) {
        return { ok: false, error: "invalid-credentials" };
      }
      return { ok: true, tokens: await mintPair(user, meta) };
    },

    async refresh(refreshToken, meta = NO_META) {
      const session = await store.getSessionByTokenHash(await sha256Hex(refreshToken));
      if (!session) return { ok: false, error: "invalid-refresh-token" };
      // Rotation: the presented token dies here, success or not.
      await store.deleteSession(session.id);
      if (Date.parse(session.expiresAt) <= deps.now().getTime()) {
        return { ok: false, error: "invalid-refresh-token" };
      }
      const user = await store.getUserById(session.userId);
      if (!user || user.status !== "active" || user.emailVerifiedAt === null) {
        return { ok: false, error: "invalid-refresh-token" };
      }
      const tokens = await mintPair(user, {
        userAgent: meta.userAgent ?? session.userAgent,
        ip: meta.ip ?? session.ip,
      }, { createdAt: session.createdAt });
      return { ok: true, tokens };
    },

    async logout(refreshToken) {
      const session = await store.getSessionByTokenHash(await sha256Hex(refreshToken));
      if (session) await store.deleteSession(session.id);
    },

    async createUser(input) {
      // Single-user, the owner is made at boot and nobody registers, first or otherwise.
      if (!multiUser) return { ok: false, error: "single-user" };
      const bootstrapped = (await store.countUsers()) === 0;
      if (!bootstrapped && !(await settingsOrDefault()).allowOpenRegistration) {
        return { ok: false, error: "registration-closed" };
      }
      if (bootstrapped && !await isSetupToken(input.setupToken, await store.listSigningKeys())) {
        return { ok: false, error: "setup-token" };
      }
      if (bootstrapped && (input.name === undefined || input.password === undefined)) {
        return { ok: false, error: "incomplete" };
      }
      const email = input.email.toLowerCase();
      const existing = await store.getUserByEmail(email);
      if (existing) {
        // The registrant learns nothing; the address's owner gets a fresh link if they still need
        // one, and otherwise nothing at all.
        if (existing.emailVerifiedAt === null && existing.status === "active") {
          await mailVerification(existing);
        }
        return { ok: true, user: null, bootstrapped: false };
      }

      const at = nowIso();
      const role: Role = bootstrapped ? "owner" : "member";
      const user: User = {
        id: mintId("u"),
        email,
        // The first user is the instance's owner and names themself here, password included;
        // anyone else does both on the mailed link, once the address is theirs to speak for.
        name: bootstrapped ? input.name! : "",
        passwordHash: bootstrapped ? await hashPassword(input.password!) : null,
        role,
        status: "active",
        emailVerifiedAt: bootstrapped ? at : null,
        unprovenEmail: null,
        resetRequestedAt: null,
        createdAt: at,
        updatedAt: at,
      };
      if (bootstrapped) {
        // Lost the race to another first registration: that one is the owner, and this is a
        // registration on an instance that has closed it.
        if (!await store.createFirstUser(user)) return { ok: false, error: "registration-closed" };
        return { ok: true, user: toPublicUser(user), bootstrapped };
      }
      await store.createUser(user);
      await mailVerification(user);
      return { ok: true, user: toPublicUser(user), bootstrapped };
    },

    async mintVerificationLink(userId) {
      const user = await store.getUserById(userId);
      if (!user) return { ok: false, error: "not-found" };
      if (user.emailVerifiedAt !== null) return { ok: false, error: "already-verified" };
      return await mintAdminLink(user, "verify-email");
    },

    async verifyEmail(token, input, meta = NO_META) {
      const row = await liveToken(token, "verify-email");
      const user = row === null ? null : await store.getUserById(row.userId);
      // A proven account's name and password are its own: a link minted before the proof (or by
      // an admin, before that was refused) must not set them, nor sign anyone in.
      if (!row || !user || user.status !== "active" || user.emailVerifiedAt !== null) {
        return { ok: false, error: "invalid-token" };
      }
      if (!await store.claimToken(row.id, nowIso())) return { ok: false, error: "invalid-token" };
      await disown(user);
      const verified: User = {
        ...user,
        name: input.name,
        passwordHash: await hashPassword(input.password),
        emailVerifiedAt: nowIso(),
        resetRequestedAt: null,
        updatedAt: nowIso(),
      };
      await store.saveUser(verified);
      return { ok: true, tokens: await mintPair(verified, meta) };
    },

    async forgotPassword(email) {
      const user = await store.getUserByEmail(email.toLowerCase());
      // A stand-in reaches no mailbox, and whoever typed it is nobody an admin could hand a link.
      if (!user || user.status !== "active" || isReservedAddress(user.email)) return;
      // A proven owner changes their password signed in (see `resetPassword`). An unproven one
      // has none yet: the verification link below sets it, as it does for anyone unproven.
      if (user.role === "owner" && user.emailVerifiedAt !== null) return;
      const pend = async () => {
        if (user.resetRequestedAt === null) {
          await store.saveUser({ ...user, resetRequestedAt: nowIso(), updatedAt: nowIso() });
        }
      };
      if (mailer === null || appUrl === null) {
        await pend();
        return;
      }
      // An unproven account has no password to forget; what its owner needs is the link that
      // sets one.
      if (user.emailVerifiedAt === null) {
        await mailVerification(user);
        return;
      }
      const link = linkFor("reset-password", await mintLinkToken(user.id, "reset-password"))!;
      // A send that fails leaves the request where a mailerless instance would: waiting for an
      // admin to hand the link over.
      send({
        to: user.email,
        subject: "Reset your ryph password",
        text: `Hi ${user.name},\n\nSet a new password for your ryph account by opening:\n\n` +
          `${link}\n\nThe link works once and expires in an hour. If you did not ask for this, ` +
          `ignore this message — your password stays as it is.\n`,
      }, async () => {
        const current = await store.getUserById(user.id);
        if (current && current.resetRequestedAt === null) {
          await store.saveUser({ ...current, resetRequestedAt: nowIso(), updatedAt: nowIso() });
        }
      });
    },

    async mintResetLink(userId) {
      const user = await store.getUserById(userId);
      if (!user) return { ok: false, error: "not-found" };
      if (user.role === "owner" && user.emailVerifiedAt !== null) {
        return { ok: false, error: "owner" };
      }
      if (isReservedAddress(user.email)) return { ok: false, error: "no-address" };
      // For an unproven address the link that sets a password is the verification link.
      return await mintAdminLink(
        user,
        user.emailVerifiedAt === null ? "verify-email" : "reset-password",
      );
    },

    async listResetRequests() {
      // A proven owner's request from before owners were refused has no link to settle it.
      return (await store.listResetRequests())
        .filter((u) => u.role !== "owner" || u.emailVerifiedAt === null)
        .map(toPublicUser);
    },

    async resetPassword(token, password) {
      const row = await liveToken(token, "reset-password");
      const user = row === null ? null : await store.getUserById(row.userId);
      if (!row || !user || user.status !== "active" || user.role === "owner") {
        return { ok: false, error: "invalid-token" };
      }
      if (!await store.claimToken(row.id, nowIso())) return { ok: false, error: "invalid-token" };
      await store.saveUser({
        ...user,
        passwordHash: await hashPassword(password),
        // The link reached the address, or an admin handed it over: either proves enough.
        emailVerifiedAt: user.emailVerifiedAt ?? nowIso(),
        resetRequestedAt: null,
        updatedAt: nowIso(),
      });
      await store.deleteSessionsByUser(user.id);
      return { ok: true };
    },

    mailerConfigured() {
      return mailer !== null && appUrl !== null;
    },

    async passkeyRegistrationOptions(userId) {
      const user = await store.getUserById(userId);
      if (!user) return { ok: false, error: "not-found" };
      if (user.emailVerifiedAt === null) return { ok: false, error: "unverified" };
      if (relyingParty === null) return { ok: false, error: "no-app-url" };
      const existing = await store.listPasskeysByUser(userId);
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: relyingParty.id,
        userID: new TextEncoder().encode(user.id),
        userName: user.email,
        userDisplayName: user.name,
        attestationType: "none",
        excludeCredentials: existing.map((p) => ({
          id: p.id,
          transports: p.transports as NonNullable<
            Parameters<typeof generateRegistrationOptions>[0]["excludeCredentials"]
          >[number]["transports"],
        })),
        // Discoverable, so sign-in needs no email typed first.
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      });
      return { ok: true, challengeId: await pinChallenge(options.challenge, userId), options };
    },

    async registerPasskey(userId, challengeId, response, name) {
      const user = await store.getUserById(userId);
      if (!user || user.emailVerifiedAt === null) return { ok: false, error: "unverified" };
      if (relyingParty === null) return { ok: false, error: "no-app-url" };
      const challenge = await spendChallenge(challengeId);
      if (!challenge || challenge.userId !== userId) return { ok: false, error: "invalid" };
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response,
          expectedChallenge: async (c) => (await sha256Hex(c)) === challenge.challengeHash,
          expectedOrigin: relyingParty.origin,
          expectedRPID: relyingParty.id,
          requireUserVerification: false,
        });
      } catch {
        return { ok: false, error: "invalid" };
      }
      if (!verification.verified || !verification.registrationInfo) {
        return { ok: false, error: "invalid" };
      }
      const { credential, credentialDeviceType, credentialBackedUp } =
        verification.registrationInfo;
      const passkey: Passkey = {
        id: credential.id,
        userId,
        publicKey: toBase64Url(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? [],
        name,
        backedUp: credentialBackedUp,
        deviceType: credentialDeviceType,
        createdAt: nowIso(),
        lastUsedAt: null,
      };
      await store.createPasskey(passkey);
      return { ok: true, passkey: summarizePasskey(passkey) };
    },

    async listPasskeys(userId) {
      return (await store.listPasskeysByUser(userId)).map(summarizePasskey);
    },

    async renamePasskey(userId, id, name) {
      const passkey = await store.getPasskeyById(id);
      if (!passkey || passkey.userId !== userId) return null;
      const next = { ...passkey, name };
      await store.savePasskey(next);
      return summarizePasskey(next);
    },

    async deletePasskey(userId, id) {
      const user = await store.getUserById(userId);
      const passkey = await store.getPasskeyById(id);
      if (!user || !passkey || passkey.userId !== userId) return { ok: false, error: "not-found" };
      if ((await signInMethods(user)) <= 1) return { ok: false, error: "last-sign-in-method" };
      await store.deletePasskey(id);
      return { ok: true };
    },

    async passkeyLoginOptions() {
      if (relyingParty === null) return { ok: false, error: "no-app-url" };
      const options = await generateAuthenticationOptions({
        rpID: relyingParty.id,
        userVerification: "preferred",
      });
      return { ok: true, challengeId: await pinChallenge(options.challenge, null), options };
    },

    async loginWithPasskey(challengeId, response, meta = NO_META) {
      if (relyingParty === null) return { ok: false, error: "no-app-url" };
      const challenge = await spendChallenge(challengeId);
      if (!challenge || challenge.userId !== null) return { ok: false, error: "invalid" };
      const passkey = await store.getPasskeyById(response.id);
      const user = passkey === null ? null : await store.getUserById(passkey.userId);
      if (!passkey || !user) return { ok: false, error: "invalid" };
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: async (c) => (await sha256Hex(c)) === challenge.challengeHash,
          expectedOrigin: relyingParty.origin,
          expectedRPID: relyingParty.id,
          requireUserVerification: false,
          credential: {
            id: passkey.id,
            publicKey: fromBase64Url(passkey.publicKey),
            counter: passkey.counter,
            transports: passkey.transports as NonNullable<
              Parameters<typeof verifyAuthenticationResponse>[0]["credential"]["transports"]
            >,
          },
        });
      } catch {
        return { ok: false, error: "invalid" };
      }
      if (!verification.verified) return { ok: false, error: "invalid" };
      await store.savePasskey({
        ...passkey,
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: nowIso(),
      });
      if (user.status !== "active") return { ok: false, error: "deactivated" };
      return { ok: true, tokens: await mintPair(user, meta) };
    },

    async sweep() {
      const before = new Date(deps.now().getTime() - UNVERIFIED_TTL_MS).toISOString();
      let purgedUsers = 0;
      for (const user of await store.listUnverifiedUsersBefore(before)) {
        // A link still in flight keeps its account: whoever asked for it on day six must be able
        // to open it on day seven.
        if (await store.hasLiveToken(user.id, "verify-email", nowIso())) continue;
        await store.deleteUser(user.id);
        purgedUsers += 1;
      }
      await store.deleteTokensExpiredBefore(nowIso());
      await store.deleteChallengesExpiredBefore(nowIso());
      return { purgedUsers };
    },

    async createInvite(input, createdBy) {
      if (!multiUser) return { ok: false, error: "single-user" };
      const email = input.email?.toLowerCase() ?? null;
      if (email !== null && await store.getUserByEmail(email)) {
        return { ok: false, error: "email-taken" };
      }
      const token = mintToken();
      const at = deps.now();
      const invite: Invite = {
        id: mintId("inv"),
        tokenHash: await sha256Hex(token),
        email,
        role: input.role,
        maxUses: email === null ? input.maxUses : 1,
        uses: 0,
        expiresAt: new Date(at.getTime() + input.expiresInMs).toISOString(),
        createdBy,
        revokedAt: null,
        createdAt: at.toISOString(),
      };
      await store.createInvite(invite);
      return { ok: true, invite: summarizeInvite(invite), token };
    },

    async listInvites() {
      return (await store.listInvites()).map(summarizeInvite);
    },

    async revokeInvite(id) {
      const invite = await store.getInviteById(id);
      if (invite && invite.revokedAt === null) {
        await store.saveInvite({ ...invite, revokedAt: nowIso() });
      }
    },

    async previewInvite(token) {
      if (!multiUser) return null;
      const invite = await store.getInviteByTokenHash(await sha256Hex(token));
      if (!invite) return null;
      return { email: invite.email, role: invite.role, valid: inviteIsLive(invite) };
    },

    async acceptInvite(token, input, meta = NO_META) {
      if (!multiUser) return { ok: false, error: "single-user" };
      const invite = await liveInvite(token);
      if (!invite) return { ok: false, error: "invalid-invite" };
      const email = invite.email ?? input.email?.toLowerCase() ?? null;
      if (email === null) return { ok: false, error: "email-required" };
      // A bound invite reached the address it names; an open link proves nothing about one, so
      // name and password wait for the mailed link, as they do for an open registration.
      const bound = invite.email !== null;
      if (bound && (input.name === undefined || input.password === undefined)) {
        return { ok: false, error: "incomplete" };
      }
      const existing = await store.getUserByEmail(email);
      if (existing) {
        // A bound invite's address is the admin's word, so the collision may be named. An open
        // link is held by anyone, and a link that said "taken" would let its holder list the
        // instance's users: the answer is the new-account answer, and the owner gets a fresh
        // link if they still need one. No use is spent.
        if (bound) return { ok: false, error: "email-taken" };
        if (existing.emailVerifiedAt === null && existing.status === "active") {
          await mailVerification(existing);
        }
        return { ok: true, tokens: null };
      }
      if (!await consumeInvite(invite)) return { ok: false, error: "invalid-invite" };

      const at = nowIso();
      const user: User = {
        id: mintId("u"),
        email,
        name: bound ? input.name! : "",
        passwordHash: bound ? await hashPassword(input.password!) : null,
        role: invite.role,
        status: "active",
        emailVerifiedAt: bound ? at : null,
        unprovenEmail: null,
        resetRequestedAt: null,
        createdAt: at,
        updatedAt: at,
      };
      await store.createUser(user);
      if (!bound) {
        await mailVerification(user);
        return { ok: true, tokens: null };
      }
      return { ok: true, tokens: await mintPair(user, meta) };
    },

    async getUser(id) {
      const user = await store.getUserById(id);
      return user ? toPublicUser(user) : null;
    },

    async listUsers() {
      return (await store.listUsers()).map(toPublicUser);
    },

    async setRole(userId, role) {
      if (!multiUser) return { ok: false, error: "single-user" };
      const user = await store.getUserById(userId);
      if (!user) return { ok: false, error: "not-found" };
      if (user.role === role) return { ok: true, user: toPublicUser(user) };
      if (role !== "owner" && await isLastOwner(user)) return { ok: false, error: "last-owner" };
      const next: User = { ...user, role, updatedAt: nowIso() };
      await store.saveUser(next);
      // The role rides the access token, so every live session must re-mint to see it.
      await store.deleteSessionsByUser(userId);
      return { ok: true, user: toPublicUser(next) };
    },

    async setStatus(userId, status) {
      if (!multiUser) return { ok: false, error: "single-user" };
      const user = await store.getUserById(userId);
      if (!user) return { ok: false, error: "not-found" };
      if (user.status === status) return { ok: true, user: toPublicUser(user) };
      if (status !== "active" && await isLastOwner(user)) {
        return { ok: false, error: "last-owner" };
      }
      const next: User = { ...user, status, updatedAt: nowIso() };
      await store.saveUser(next);
      await lockDown(userId);
      return { ok: true, user: toPublicUser(next) };
    },

    async deleteUser(userId) {
      if (!multiUser) return { ok: false, error: "single-user" };
      const user = await store.getUserById(userId);
      if (!user) return { ok: false, error: "not-found" };
      if (await isLastOwner(user)) return { ok: false, error: "last-owner" };
      await store.deleteUser(userId);
      return { ok: true };
    },

    async changePassword(userId, current, next) {
      const user = await store.getUserById(userId);
      if (!user) return { ok: false, error: "not-found" };
      if (user.passwordHash !== null) {
        const valid = await verifyPassword(current ?? "", user.passwordHash);
        if (!valid) return { ok: false, error: "invalid-credentials" };
      }
      const passwordHash = await hashPassword(next);
      await store.saveUser({ ...user, passwordHash, updatedAt: nowIso() });
      await lockDown(userId);
      return { ok: true };
    },

    sessionAlive,

    async listSessions(userId) {
      return (await store.listSessionsByUser(userId)).map(({ tokenHash: _hash, ...rest }) => rest);
    },

    async revokeSession(userId, sessionId) {
      const own = (await store.listSessionsByUser(userId)).some((s) => s.id === sessionId);
      if (own) await store.deleteSession(sessionId);
    },

    async revokeAllSessions(userId) {
      await lockDown(userId);
    },

    async credentialAlive(claims) {
      if (claims.via === "session") return await sessionAlive(claims.sid);
      const token = await store.getApiTokenById(claims.sid);
      if (token === null || !apiTokenLive(token)) return false;
      // A session dies with its owner's deactivation; a token's access token must too.
      const owner = await store.getUserById(token.userId);
      return owner !== null && owner.status === "active";
    },

    async mintApiToken(userId, input) {
      const user = await store.getUserById(userId);
      if (!user) return { ok: false, error: "not-found" };
      const held = { caps: capsClaimOf(user.role) };
      if (!input.caps.every((capability) => can(held, capability))) {
        return { ok: false, error: "beyond-owner" };
      }
      const secret = `ryph_pat_${mintToken()}`;
      const at = nowIso();
      const token: ApiToken = {
        id: mintId("t"),
        userId,
        name: input.name,
        tokenHash: await sha256Hex(secret),
        caps: [...input.caps],
        expiresAt: new Date(deps.now().getTime() + input.expiresInMs).toISOString(),
        createdAt: at,
        lastUsedAt: null,
        revokedAt: null,
      };
      await store.createApiToken(token);
      const { tokenHash: _hash, ...summary } = token;
      return { ok: true, token: secret, summary };
    },

    async listApiTokens(userId) {
      return (await store.listApiTokensByUser(userId)).map(({ tokenHash: _hash, ...rest }) => rest);
    },

    async revokeApiToken(id, ownerUserId) {
      const token = await store.getApiTokenById(id);
      if (token === null || (ownerUserId !== null && token.userId !== ownerUserId)) return false;
      // A column update, not a whole-row save from this read: an exchange racing in the gap
      // between the read above and this write must never be overwritten back to live by it.
      await store.revokeApiTokenRow(id, nowIso());
      return true;
    },

    async exchangeApiToken(secret) {
      const token = await store.getApiTokenByTokenHash(await sha256Hex(secret));
      if (token === null || !apiTokenLive(token)) return { ok: false, error: "invalid-token" };
      const user = await store.getUserById(token.userId);
      if (!user || user.status !== "active" || user.emailVerifiedAt === null) {
        return { ok: false, error: "invalid-token" };
      }
      // The token's list narrowed to what its owner holds NOW: a demotion shrinks every token
      // its owner minted, at their next exchange.
      const held = { caps: capsClaimOf(user.role) };
      const caps = token.caps.filter((capability) => can(held, capability));
      // Only `lastUsedAt` moves here: a whole-row save from the read above would put
      // `revokedAt` back to null if a revocation committed in the gap, keeping a leaked token
      // exchangeable forever — exactly the moment this call is guarding against.
      await store.touchApiToken(token.id, nowIso());
      return {
        ok: true,
        accessToken: await signAccess(user, caps, token.id, "token"),
        expiresIn: accessTtl,
      };
    },

    providers() {
      return provider?.providers() ?? [];
    },

    async loginWithProvider(name, code, meta = NO_META, inviteToken = null, leg = NO_CODE_LEG) {
      if (provider === null || !provider.providers().includes(name)) {
        return { ok: false, error: "no-provider" };
      }
      // Single-user, no invite admits anyone, so none is even looked up.
      const invite = inviteToken === null || !multiUser ? null : await liveInvite(inviteToken);
      if (inviteToken !== null && invite === null) return { ok: false, error: "invalid-invite" };
      let identity: ProviderIdentity;
      try {
        identity = await provider.exchangeCode(name, code, leg);
      } catch {
        return { ok: false, error: "code-refused" };
      }

      const linked = await store.getIdentityByAccount(name, identity.accountId);
      if (linked) {
        const user = await store.getUserById(linked.userId);
        if (!user) return { ok: false, error: "code-refused" };
        if (user.status !== "active") return { ok: false, error: "deactivated" };
        await saveIdentity(user.id, name, identity);
        return { ok: true, tokens: await mintPair(user, meta) };
      }

      // A stand-in (`addresslessEmail`) is nobody's mailbox, whoever says they verified it.
      const emails = identity.verifiedEmails.map((e) => e.toLowerCase())
        .filter((e) => !isReservedAddress(e));
      if (emails.length === 0) return { ok: false, error: "no-verified-email" };
      // Whether the provider's "verified" proves an address here. Only then may an address reach
      // an existing account: an address proven this way is what a reset link to it would prove.
      const trusted = provider.trustsEmails(name);
      for (const email of trusted ? emails : []) {
        const user = await store.getUserByEmail(email);
        if (!user) continue;
        if (user.status !== "active") return { ok: false, error: "deactivated" };
        // An owner's address can be set without proof (single-user takes it from git config),
        // so a match is never enough to reach that account. The owner links from settings.
        if (user.role === "owner" && user.emailVerifiedAt !== null) {
          return { ok: false, error: "link-required" };
        }
        if (user.emailVerifiedAt === null) {
          // The provider proved this address; whoever registered it never did, and never signed
          // in either. The account is theirs now, and nothing the registrant held survives.
          await disown(user);
          await store.saveUser({
            ...user,
            name: user.name || identity.name || identity.login,
            passwordHash: null,
            emailVerifiedAt: nowIso(),
            resetRequestedAt: null,
            updatedAt: nowIso(),
          });
        }
        await saveIdentity(user.id, name, identity);
        return { ok: true, tokens: await mintPair((await store.getUserById(user.id))!, meta) };
      }

      // A row keyed `login:<login>` was carried over from a time links knew only the login. It
      // is never trusted to sign anyone in — a login can change hands — but it does say where
      // the person should go: creating a second, empty account beside it would strand the old
      // one and take its link away.
      if (await store.getIdentityByAccount(name, `login:${identity.login}`)) {
        return { ok: false, error: "linked-before-upgrade" };
      }

      // An invite admits on its own; a bound one only the address it names. Its link is what
      // proves that address — as when it is accepted with a password — so a bound invite needs
      // only the provider to name the same one.
      if (invite !== null) {
        if (invite.email !== null && !emails.includes(invite.email)) {
          return { ok: false, error: "invite-email-mismatch" };
        }
      } else {
        const verdict = await admits(name, {
          login: identity.login,
          accountId: identity.accountId,
        });
        if (verdict !== "yes") {
          return {
            ok: false,
            error: verdict === "unknown"
              ? "membership-unknown"
              : verdict === "no-organization"
              ? "no-organization"
              : "registration-closed",
          };
        }
      }
      // A bound invite's link proved its address; otherwise only a trusted provider does, and an
      // account registered on an untrusted one's word holds a stand-in, with the address it gave
      // kept beside it to be shown as unproven. Nobody who proves that address later finds it
      // taken, so nothing this account gathers can ever pass to them.
      const proven = trusted || (invite?.email ?? null) !== null;
      if (!trusted) {
        // Admitted, and only now is an address looked at. An untrusted provider's addresses
        // reach no account, not even to be handed it: one held already is linked from that
        // account's settings, signed in another way.
        for (const email of emails) {
          if (await store.getUserByEmail(email)) return { ok: false, error: "link-required" };
        }
      }
      const at = nowIso();
      const id = mintId("u");
      const user: User = {
        id,
        email: invite?.email ?? (proven ? emails[0] : addresslessEmail(id)),
        name: identity.name ?? identity.login,
        passwordHash: null,
        role: invite?.role ?? "member",
        status: "active",
        emailVerifiedAt: at,
        unprovenEmail: proven ? null : emails[0],
        resetRequestedAt: null,
        createdAt: at,
        updatedAt: at,
      };
      if (invite !== null && !await consumeInvite(invite)) {
        return { ok: false, error: "invalid-invite" };
      }
      await store.createUser(user);
      await saveIdentity(user.id, name, identity);
      return { ok: true, tokens: await mintPair(user, meta) };
    },

    async linkProvider(userId, name, code, leg = NO_CODE_LEG) {
      if (provider === null || !provider.providers().includes(name)) {
        return { ok: false, error: "no-provider" };
      }
      const user = await store.getUserById(userId);
      if (!user) return { ok: false, error: "not-found" };
      // An unproven account may be someone else's address squatted; nothing durable attaches to it.
      if (user.emailVerifiedAt === null) return { ok: false, error: "unverified" };
      let identity: ProviderIdentity;
      try {
        identity = await provider.exchangeCode(name, code, leg);
      } catch {
        return { ok: false, error: "code-refused" };
      }
      const taken = await store.getIdentityByAccount(name, identity.accountId);
      if (taken && taken.userId !== userId) return { ok: false, error: "linked-elsewhere" };
      const row = await saveIdentity(userId, name, identity);
      return { ok: true, identity: summarize(row) };
    },

    challengeProviders() {
      return challenger?.providers() ?? [];
    },

    async mintIdentityChallenge(userId, name) {
      if (challenger === null || !challenger.providers().includes(name)) {
        return { ok: false, error: "no-provider" };
      }
      const user = await store.getUserById(userId);
      if (!user) return { ok: false, error: "not-found" };
      if (user.emailVerifiedAt === null) return { ok: false, error: "unverified" };
      const at = deps.now();
      // Housekeeping, not correctness — `consumeIdentityChallenge` refuses an expired nonce
      // whether or not this ever ran.
      await store.deleteIdentityChallengesExpiredBefore(
        new Date(at.getTime() - IDENTITY_CHALLENGE_TTL_MS).toISOString(),
      );
      const nonce = `ryph-link-${mintId("rl")}`;
      const expiresAt = new Date(at.getTime() + IDENTITY_CHALLENGE_TTL_MS).toISOString();
      await store.createIdentityChallenge({
        nonce,
        userId,
        provider: name,
        expiresAt,
        createdAt: at.toISOString(),
        usedAt: null,
      });
      return {
        ok: true,
        challenge: { nonce, expiresAt, command: challenger.command(name, nonce) },
      };
    },

    async linkProviderByProof(userId, name, proof) {
      if (challenger === null || !challenger.providers().includes(name)) {
        return { ok: false, error: "no-provider" };
      }
      const user = await store.getUserById(userId);
      if (!user) return { ok: false, error: "not-found" };
      // An unproven account may be someone else's address squatted; nothing durable attaches.
      if (user.emailVerifiedAt === null) return { ok: false, error: "unverified" };

      // A subject held by somebody else is refused before anything is spent: two users holding
      // one identity would make every inbound forge trigger ambiguous, and the command path
      // refuses an ambiguous actor outright.
      const held = await store.listIdentitiesByLogin(name, proof.subject);
      if (held.some((i) => i.userId !== userId)) {
        return { ok: false, error: "linked-elsewhere" };
      }

      // The caller does not name which nonce it signed, because a caller-named one proves
      // nothing about what they actually signed. Every outstanding challenge of this user is
      // tried instead — there is at most a handful — and the one that verifies is the one spent.
      const at = nowIso();
      for (const challenge of await store.listIdentityChallenges(userId, name, at)) {
        const identity = await challenger.verify(name, challenge.nonce, proof);
        if (identity === null) continue;
        // Verified — now spend it, and only now. The conditional UPDATE is the single-use gate:
        // two concurrent requests carrying the same signature cannot both win it.
        const spent = await store.consumeIdentityChallenge(challenge.nonce, at);
        if (spent === null || spent.userId !== userId) break;
        const taken = await store.getIdentityByAccount(name, identity.accountId);
        if (taken && taken.userId !== userId) return { ok: false, error: "linked-elsewhere" };
        return { ok: true, identity: summarize(await saveIdentity(userId, name, identity)) };
      }
      return { ok: false, error: "bad-proof" };
    },

    async listIdentities(userId) {
      return (await store.listIdentitiesByUser(userId)).map(summarize);
    },

    async unlinkIdentity(userId, provider) {
      const user = await store.getUserById(userId);
      const identity = await store.getIdentity(userId, provider);
      if (!user || !identity) return { ok: false, error: "not-found" };
      if ((await signInMethods(user)) <= 1) return { ok: false, error: "last-sign-in-method" };
      await store.deleteIdentity(userId, provider);
      return { ok: true };
    },

    getSettings: settingsOrDefault,

    async updateSettings(patch) {
      const current = await settingsOrDefault();
      const next: AuthSettings = { ...current, ...patch, updatedAt: nowIso() };
      await store.saveSettings(next);
      return next;
    },

    async needsBootstrap() {
      return (await store.countUsers()) === 0;
    },

    multiUser: () => multiUser,

    async setupToken() {
      if (!multiUser || (await store.countUsers()) > 0) return null;
      return await setupTokenFor(key);
    },

    async ensureOwner(defaults) {
      if (!multiUser && (await store.countUsers()) === 0) {
        const at = nowIso();
        // No password: the way in is a login link, and the owner can set one later. A second
        // process booting into the same empty database loses the lock and reads the winner.
        await store.createFirstUser({
          id: mintId("u"),
          email: defaults.email.toLowerCase(),
          name: ownerName(defaults.name),
          passwordHash: null,
          role: "owner",
          status: "active",
          emailVerifiedAt: at,
          unprovenEmail: null,
          resetRequestedAt: null,
          createdAt: at,
          updatedAt: at,
        });
      }
      const owner = await soleOwner();
      return owner === null ? null : toPublicUser(owner);
    },

    async mintLoginLink(fallbackAppUrl) {
      if (multiUser) return { ok: false, error: "multi-user" };
      const owner = await soleOwner();
      if (owner === null) return { ok: false, error: "not-found" };
      const base = appUrl ?? (fallbackAppUrl == null ? null : new URL(fallbackAppUrl).origin);
      if (base === null) return { ok: false, error: "no-app-url" };
      const token = await mintLinkToken(owner.id, "login");
      return { ok: true, link: `${base}/${LINK_PATHS.login}/${token}` };
    },

    // Nobody yet counts as a way in: the setup token claims the instance.
    async ownerCanSignIn() {
      const emails = await ownerSignInEmails();
      return emails === null || emails.length > 0;
    },

    ownerSignInEmails,

    async redeemLoginLink(token, meta = NO_META) {
      // A link is the single-user owner's way in and nothing else's. A restart into multi-user
      // mode, or a demotion, leaves a minted link unspent for up to ten minutes; it must not
      // sign anyone in once the instance or the user is no longer what it was minted for.
      if (multiUser) return { ok: false, error: "invalid-token" };
      const row = await liveToken(token, "login");
      const user = row === null ? null : await store.getUserById(row.userId);
      if (
        !row || !user || user.role !== "owner" || user.status !== "active" ||
        user.emailVerifiedAt === null
      ) {
        return { ok: false, error: "invalid-token" };
      }
      if (!await store.claimToken(row.id, nowIso())) return { ok: false, error: "invalid-token" };
      return { ok: true, tokens: await mintPair(user, meta) };
    },

    async updateProfile(userId, input) {
      const user = await store.getUserById(userId);
      if (!user) return { ok: false, error: "not-found" };
      const email = input.email?.toLowerCase();
      if (email !== undefined && email !== user.email) {
        // Only the single-user owner: the address is theirs to name without proof, the way the
        // owner made at boot named it. Anyone else left over from multi-user keeps theirs.
        if (multiUser) return { ok: false, error: "multi-user" };
        if (user.role !== "owner") return { ok: false, error: "owner-only" };
        if (await store.getUserByEmail(email)) return { ok: false, error: "email-taken" };
      }
      const next: User = {
        ...user,
        name: input.name ?? user.name,
        email: email ?? user.email,
        updatedAt: nowIso(),
      };
      await store.saveUser(next);
      return { ok: true, user: toPublicUser(next) };
    },

    async jwks() {
      return toJwks(await store.listSigningKeys());
    },
  };
}

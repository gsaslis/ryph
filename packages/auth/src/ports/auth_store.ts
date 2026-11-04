// Persistence, as the auth core sees it: users, refresh sessions, linked identities, the
// registration gates, and the signing key. A dumb row-holder — every decision (password
// checks, rotation, bootstrap rules, who may unlink what) lives in the core.

import type {
  ApiToken,
  AuthSettings,
  ExternalIdentity,
  IdentityChallenge,
  Invite,
  OneTimeToken,
  OneTimeTokenKind,
  Passkey,
  PasskeyChallenge,
  Session,
  SigningKey,
  User,
} from "../core/types.ts";

export interface AuthStore {
  createUser(user: User): Promise<void>;
  /**
   * Creates the instance's first user, or answers false because one already exists. ONE
   * decision under a lock, so two bootstraps racing on an empty table cannot both become owner.
   */
  createFirstUser(user: User): Promise<boolean>;
  getUserByEmail(email: string): Promise<User | null>;
  getUserById(id: string): Promise<User | null>;
  /** Full-row write keyed by user.id. */
  saveUser(user: User): Promise<void>;
  /** Oldest first. */
  listUsers(): Promise<User[]>;
  countUsers(): Promise<number>;
  /** Owners who can actually act; deactivated ones and unproven placeholders do not count. */
  countActiveOwners(): Promise<number>;
  /** Removes the user and, through the schema, every row that hangs off it. */
  deleteUser(id: string): Promise<void>;
  /** Every user whose address is still unproven and who was created before `before`. */
  listUnverifiedUsersBefore(before: string): Promise<User[]>;
  /** Every user with a "forgot password" nobody could mail — oldest request first. */
  listResetRequests(): Promise<User[]>;

  createSession(session: Session): Promise<void>;
  getSessionByTokenHash(tokenHash: string): Promise<Session | null>;
  getSessionById(id: string): Promise<Session | null>;
  /** Newest first. */
  listSessionsByUser(userId: string): Promise<Session[]>;
  deleteSession(id: string): Promise<void>;
  deleteSessionsByUser(userId: string): Promise<void>;

  createApiToken(token: ApiToken): Promise<void>;
  getApiTokenById(id: string): Promise<ApiToken | null>;
  getApiTokenByTokenHash(tokenHash: string): Promise<ApiToken | null>;
  /** Newest first, revoked ones included. */
  listApiTokensByUser(userId: string): Promise<ApiToken[]>;
  /** Full-row write keyed by token.id — for MINTING only. An exchange or a revoke that read
   * the row first must write back through `touchApiToken`/`revokeApiTokenRow` instead: a
   * whole-row save from a stale read is a lost update, most dangerously a revocation racing
   * an exchange back to live (see `revokeApiTokenRow`). */
  saveApiToken(token: ApiToken): Promise<void>;
  /** Narrow write: only `lastUsedAt`, keyed by id. What a token exchange stamps — never the
   * whole row, which a revocation could have moved between the read and this write. */
  touchApiToken(id: string, at: string): Promise<void>;
  /** Narrow write: only `revokedAt`, keyed by id, and only while the row is not already
   * revoked (idempotent). Answers whether THIS call is the one that revoked it — not whether
   * the token ends up revoked, which stays true either way. */
  revokeApiTokenRow(id: string, at: string): Promise<boolean>;

  /** Upsert keyed by (userId, provider) — re-linking replaces the account. */
  saveIdentity(identity: ExternalIdentity): Promise<void>;
  getIdentity(userId: string, provider: string): Promise<ExternalIdentity | null>;
  getIdentityByAccount(
    provider: string,
    providerAccountId: string,
  ): Promise<ExternalIdentity | null>;
  /** Every identity of one user, oldest first. */
  listIdentitiesByUser(userId: string): Promise<ExternalIdentity[]>;
  /** The inbound-trigger lookup. Logins are reassignable on a provider, so more than one row
   * is possible — the caller decides what that means. */
  listIdentitiesByLogin(provider: string, login: string): Promise<ExternalIdentity[]>;
  deleteIdentity(userId: string, provider: string): Promise<void>;

  /** Mints an outstanding identity challenge. */
  createIdentityChallenge(challenge: IdentityChallenge): Promise<void>;
  /** This user's unspent, unexpired challenges for one provider at `at`, newest first. The link
   * route tries a signature against each: a caller that named its own nonce would be proving
   * nothing about what it actually signed. */
  listIdentityChallenges(
    userId: string,
    provider: string,
    at: string,
  ): Promise<IdentityChallenge[]>;
  /**
   * Spends a challenge, or answers null: unknown, already spent, or expired at `at`. ONE
   * statement, so two concurrent link attempts cannot both spend the same nonce — a replayed
   * signature must never link an identity twice. The answer is the user it was minted for,
   * which is what stops a signature collected from one person linking onto another's account.
   */
  consumeIdentityChallenge(nonce: string, at: string): Promise<{ userId: string } | null>;
  /** Drops challenges that expired before `before` — housekeeping, never correctness. */
  deleteIdentityChallengesExpiredBefore(before: string): Promise<void>;

  createInvite(invite: Invite): Promise<void>;
  getInviteById(id: string): Promise<Invite | null>;
  getInviteByTokenHash(tokenHash: string): Promise<Invite | null>;
  /** Newest first. */
  listInvites(): Promise<Invite[]>;
  /** Full-row write keyed by invite.id — revocation lands here. */
  saveInvite(invite: Invite): Promise<void>;
  /**
   * Spends one use, in one statement: answers false when the invite is revoked or already at
   * its ceiling, so two acceptances racing for the last use cannot both win.
   */
  claimInviteUse(id: string): Promise<boolean>;

  createPasskey(passkey: Passkey): Promise<void>;
  getPasskeyById(id: string): Promise<Passkey | null>;
  /** Oldest first. */
  listPasskeysByUser(userId: string): Promise<Passkey[]>;
  /** Full-row write keyed by passkey.id — the counter, the name, and last use land here. */
  savePasskey(passkey: Passkey): Promise<void>;
  deletePasskey(id: string): Promise<void>;

  createChallenge(challenge: PasskeyChallenge): Promise<void>;
  /** Reads AND deletes: a challenge answers once, whoever asks first. */
  takeChallenge(id: string): Promise<PasskeyChallenge | null>;
  deleteChallengesExpiredBefore(before: string): Promise<void>;

  createToken(token: OneTimeToken): Promise<void>;
  getTokenByHash(tokenHash: string): Promise<OneTimeToken | null>;
  /**
   * Spends a token, once: true when this call marked it used, false when it already was. Two
   * requests racing on the same link get one true between them.
   */
  claimToken(id: string, usedAt: string): Promise<boolean>;
  /** Whether the user holds an unused token of that kind that outlives `now`. */
  hasLiveToken(userId: string, kind: OneTimeTokenKind, now: string): Promise<boolean>;
  /** Drops a user's unused tokens of one kind: a fresh link makes the older ones dead. */
  deleteUnusedTokens(userId: string, kind: OneTimeTokenKind): Promise<void>;
  /** Drops every token that expired before `before`, used or not. */
  deleteTokensExpiredBefore(before: string): Promise<void>;

  /** Null until the first save — the core supplies the defaults. */
  getSettings(): Promise<AuthSettings | null>;
  saveSettings(settings: AuthSettings): Promise<void>;

  /**
   * The key to SIGN with: the oldest, by a total order so that every replica reading this table
   * picks the same row. Null on an empty table.
   */
  getSigningKey(): Promise<SigningKey | null>;
  /**
   * Every key, for the JWKS. More than one is normal rather than exceptional — two replicas
   * booting into an empty database both mint one — and publishing all of them is what makes
   * either replica able to verify the other's tokens.
   */
  listSigningKeys(): Promise<SigningKey[]>;
  /** Idempotent: an insert that collides on `kid` is a no-op, never an error. */
  saveSigningKey(key: SigningKey): Promise<void>;

  close(): Promise<void>;
}

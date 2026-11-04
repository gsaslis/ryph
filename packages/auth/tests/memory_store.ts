// A test fixture, not a deployment option. It used to be both: `RYPH_DB=memory` ran this as
// a second implementation of every store port, free to drift from the drizzle one without any
// test noticing. `pglite:memory://` replaced that — it is the real driver over real PostgreSQL,
// so throwaway databases now exercise the production path.
//
// What is left here is a fast double for tests that care about behaviour ABOVE the store and
// want no database at all. Anything asserting on SQL belongs on makeTestDb() instead.

import type {
  ApiToken,
  AuthSettings,
  ExternalIdentity,
  IdentityChallenge,
  Invite,
  OneTimeToken,
  Passkey,
  PasskeyChallenge,
  Session,
  SigningKey,
  User,
} from "../src/core/types.ts";
import type { AuthStore } from "../src/ports/auth_store.ts";

export function memoryAuthStore(): AuthStore {
  const users = new Map<string, User>();
  const sessions = new Map<string, Session>();
  const apiTokens = new Map<string, ApiToken>();
  const identities = new Map<string, ExternalIdentity>();
  const identityChallenges = new Map<string, IdentityChallenge>();
  const invites = new Map<string, Invite>();
  const tokens = new Map<string, OneTimeToken>();
  const passkeys = new Map<string, Passkey>();
  const challenges = new Map<string, PasskeyChallenge>();
  let settings: AuthSettings | null = null;
  // A LIST, not a slot: two replicas racing into an empty database is the case this port
  // exists to survive, and a double that can only hold one key cannot express it.
  const signingKeys: SigningKey[] = [];

  const byCreation = <T extends { createdAt: string; id: string }>(a: T, b: T) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt);

  return {
    createUser(user) {
      if ([...users.values()].some((u) => u.email === user.email)) {
        return Promise.reject(new Error("users_by_email: duplicate"));
      }
      users.set(user.id, structuredClone(user));
      return Promise.resolve();
    },
    createFirstUser(user) {
      if (users.size > 0) return Promise.resolve(false);
      users.set(user.id, structuredClone(user));
      return Promise.resolve(true);
    },
    getUserByEmail(email) {
      const user = [...users.values()].find((u) => u.email === email);
      return Promise.resolve(user ? structuredClone(user) : null);
    },
    getUserById(id) {
      const user = users.get(id);
      return Promise.resolve(user ? structuredClone(user) : null);
    },
    saveUser(user) {
      users.set(user.id, structuredClone(user));
      return Promise.resolve();
    },
    listUsers() {
      return Promise.resolve(structuredClone([...users.values()].sort(byCreation)));
    },
    countUsers() {
      return Promise.resolve(users.size);
    },
    countActiveOwners() {
      return Promise.resolve(
        [...users.values()].filter((u) =>
          u.role === "owner" && u.status === "active" && u.emailVerifiedAt !== null
        ).length,
      );
    },
    deleteUser(id) {
      users.delete(id);
      for (const [sid, s] of sessions) if (s.userId === id) sessions.delete(sid);
      for (const [iid, i] of identities) if (i.userId === id) identities.delete(iid);
      for (const [tid, t] of tokens) if (t.userId === id) tokens.delete(tid);
      for (const [pid, p] of passkeys) if (p.userId === id) passkeys.delete(pid);
      return Promise.resolve();
    },
    listUnverifiedUsersBefore(before) {
      const stale = [...users.values()]
        .filter((u) => u.emailVerifiedAt === null && u.createdAt < before)
        .sort(byCreation);
      return Promise.resolve(structuredClone(stale));
    },
    listResetRequests() {
      const pending = [...users.values()]
        .filter((u) => u.resetRequestedAt !== null)
        .sort((a, b) => a.resetRequestedAt!.localeCompare(b.resetRequestedAt!));
      return Promise.resolve(structuredClone(pending));
    },
    createSession(session) {
      sessions.set(session.id, structuredClone(session));
      return Promise.resolve();
    },
    getSessionByTokenHash(tokenHash) {
      const session = [...sessions.values()].find((s) => s.tokenHash === tokenHash);
      return Promise.resolve(session ? structuredClone(session) : null);
    },
    getSessionById(id) {
      const session = sessions.get(id);
      return Promise.resolve(session ? structuredClone(session) : null);
    },
    listSessionsByUser(userId) {
      const own = [...sessions.values()].filter((s) => s.userId === userId)
        .sort((a, b) => -byCreation(a, b));
      return Promise.resolve(structuredClone(own));
    },
    deleteSession(id) {
      sessions.delete(id);
      return Promise.resolve();
    },
    deleteSessionsByUser(userId) {
      for (const [id, s] of sessions) if (s.userId === userId) sessions.delete(id);
      return Promise.resolve();
    },
    createApiToken(token) {
      apiTokens.set(token.id, structuredClone(token));
      return Promise.resolve();
    },
    getApiTokenById(id) {
      const token = apiTokens.get(id);
      return Promise.resolve(token ? structuredClone(token) : null);
    },
    getApiTokenByTokenHash(tokenHash) {
      const token = [...apiTokens.values()].find((t) => t.tokenHash === tokenHash);
      return Promise.resolve(token ? structuredClone(token) : null);
    },
    listApiTokensByUser(userId) {
      const own = [...apiTokens.values()].filter((t) => t.userId === userId)
        .sort((a, b) => -byCreation(a, b));
      return Promise.resolve(structuredClone(own));
    },
    saveApiToken(token) {
      apiTokens.set(token.id, structuredClone(token));
      return Promise.resolve();
    },
    touchApiToken(id, at) {
      const token = apiTokens.get(id);
      if (token) apiTokens.set(id, { ...token, lastUsedAt: at });
      return Promise.resolve();
    },
    revokeApiTokenRow(id, at) {
      const token = apiTokens.get(id);
      if (!token || token.revokedAt !== null) return Promise.resolve(false);
      apiTokens.set(id, { ...token, revokedAt: at });
      return Promise.resolve(true);
    },
    saveIdentity(identity) {
      const taken = [...identities.values()].find((i) =>
        i.provider === identity.provider &&
        i.providerAccountId === identity.providerAccountId &&
        i.userId !== identity.userId
      );
      if (taken) return Promise.reject(new Error("external_identities_by_account: duplicate"));
      const existing = [...identities.values()].find((i) =>
        i.userId === identity.userId && i.provider === identity.provider
      );
      if (existing) identities.delete(existing.id);
      identities.set(identity.id, structuredClone(identity));
      return Promise.resolve();
    },
    getIdentity(userId, provider) {
      const identity = [...identities.values()].find((i) =>
        i.userId === userId && i.provider === provider
      );
      return Promise.resolve(identity ? structuredClone(identity) : null);
    },
    getIdentityByAccount(provider, providerAccountId) {
      const identity = [...identities.values()].find((i) =>
        i.provider === provider && i.providerAccountId === providerAccountId
      );
      return Promise.resolve(identity ? structuredClone(identity) : null);
    },
    listIdentitiesByUser(userId) {
      const own = [...identities.values()].filter((i) => i.userId === userId).sort(byCreation);
      return Promise.resolve(structuredClone(own));
    },
    listIdentitiesByLogin(provider, login) {
      const matches = [...identities.values()].filter((i) =>
        i.provider === provider && i.login === login
      );
      return Promise.resolve(structuredClone(matches));
    },
    deleteIdentity(userId, provider) {
      for (const [id, i] of identities) {
        if (i.userId === userId && i.provider === provider) identities.delete(id);
      }
      return Promise.resolve();
    },
    createIdentityChallenge(challenge) {
      identityChallenges.set(challenge.nonce, structuredClone(challenge));
      return Promise.resolve();
    },
    listIdentityChallenges(userId, provider, at) {
      const live = [...identityChallenges.values()]
        .filter((c) =>
          c.userId === userId && c.provider === provider && c.usedAt === null &&
          c.expiresAt > at
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return Promise.resolve(structuredClone(live));
    },
    consumeIdentityChallenge(nonce, at) {
      const challenge = identityChallenges.get(nonce);
      if (!challenge || challenge.usedAt !== null || challenge.expiresAt <= at) {
        return Promise.resolve(null);
      }
      identityChallenges.set(nonce, { ...challenge, usedAt: at });
      return Promise.resolve({ userId: challenge.userId });
    },
    deleteIdentityChallengesExpiredBefore(before) {
      for (const [nonce, c] of identityChallenges) {
        if (c.expiresAt < before) identityChallenges.delete(nonce);
      }
      return Promise.resolve();
    },
    createInvite(invite) {
      invites.set(invite.id, structuredClone(invite));
      return Promise.resolve();
    },
    getInviteById(id) {
      const invite = invites.get(id);
      return Promise.resolve(invite ? structuredClone(invite) : null);
    },
    getInviteByTokenHash(tokenHash) {
      const invite = [...invites.values()].find((i) => i.tokenHash === tokenHash);
      return Promise.resolve(invite ? structuredClone(invite) : null);
    },
    listInvites() {
      const all = [...invites.values()].sort((a, b) => -byCreation(a, b));
      return Promise.resolve(structuredClone(all));
    },
    saveInvite(invite) {
      invites.set(invite.id, structuredClone(invite));
      return Promise.resolve();
    },
    claimInviteUse(id) {
      const invite = invites.get(id);
      if (!invite || invite.revokedAt !== null) return Promise.resolve(false);
      if (invite.maxUses !== null && invite.uses >= invite.maxUses) return Promise.resolve(false);
      invite.uses += 1;
      return Promise.resolve(true);
    },
    createPasskey(passkey) {
      passkeys.set(passkey.id, structuredClone(passkey));
      return Promise.resolve();
    },
    getPasskeyById(id) {
      const passkey = passkeys.get(id);
      return Promise.resolve(passkey ? structuredClone(passkey) : null);
    },
    listPasskeysByUser(userId) {
      const own = [...passkeys.values()].filter((p) => p.userId === userId).sort(byCreation);
      return Promise.resolve(structuredClone(own));
    },
    savePasskey(passkey) {
      passkeys.set(passkey.id, structuredClone(passkey));
      return Promise.resolve();
    },
    deletePasskey(id) {
      passkeys.delete(id);
      return Promise.resolve();
    },
    createChallenge(challenge) {
      challenges.set(challenge.id, structuredClone(challenge));
      return Promise.resolve();
    },
    takeChallenge(id) {
      const challenge = challenges.get(id);
      challenges.delete(id);
      return Promise.resolve(challenge ? structuredClone(challenge) : null);
    },
    deleteChallengesExpiredBefore(before) {
      for (const [id, c] of challenges) if (c.expiresAt < before) challenges.delete(id);
      return Promise.resolve();
    },
    createToken(token) {
      tokens.set(token.id, structuredClone(token));
      return Promise.resolve();
    },
    getTokenByHash(tokenHash) {
      const token = [...tokens.values()].find((t) => t.tokenHash === tokenHash);
      return Promise.resolve(token ? structuredClone(token) : null);
    },
    claimToken(id, usedAt) {
      const token = tokens.get(id);
      if (!token || token.usedAt !== null) return Promise.resolve(false);
      token.usedAt = usedAt;
      return Promise.resolve(true);
    },
    hasLiveToken(userId, kind, now) {
      return Promise.resolve(
        [...tokens.values()].some((t) =>
          t.userId === userId && t.kind === kind && t.usedAt === null && t.expiresAt > now
        ),
      );
    },
    deleteUnusedTokens(userId, kind) {
      for (const [id, t] of tokens) {
        if (t.userId === userId && t.kind === kind && t.usedAt === null) tokens.delete(id);
      }
      return Promise.resolve();
    },
    deleteTokensExpiredBefore(before) {
      for (const [id, t] of tokens) if (t.expiresAt < before) tokens.delete(id);
      return Promise.resolve();
    },
    getSettings() {
      return Promise.resolve(settings ? structuredClone(settings) : null);
    },
    saveSettings(next) {
      settings = structuredClone(next);
      return Promise.resolve();
    },
    getSigningKey() {
      const sorted = [...signingKeys].sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.kid.localeCompare(b.kid)
          : a.createdAt.localeCompare(b.createdAt)
      );
      return Promise.resolve(sorted[0] ? structuredClone(sorted[0]) : null);
    },
    listSigningKeys() {
      const sorted = [...signingKeys].sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.kid.localeCompare(b.kid)
          : a.createdAt.localeCompare(b.createdAt)
      );
      return Promise.resolve(structuredClone(sorted));
    },
    saveSigningKey(key) {
      // ON CONFLICT DO NOTHING, on kid.
      if (signingKeys.some((k) => k.kid === key.kid)) return Promise.resolve();
      signingKeys.push(structuredClone(key));
      return Promise.resolve();
    },
    async close() {},
  };
}

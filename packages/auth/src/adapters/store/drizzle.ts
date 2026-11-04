// The drizzle `AuthStore` on Postgres — reads via the relational `db.query.*` API, writes via
// the builder, same conventions as the orchestrator's store.

import { and, count, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { AuthStore } from "../../ports/auth_store.ts";
import type { AuthDbHandle } from "./db/db.ts";
import * as schema from "./db/schema.ts";

const SETTINGS_ID = "default";

export function drizzleAuthStore(handle: AuthDbHandle): AuthStore {
  const { db } = handle;

  return {
    async createUser(user) {
      await db.insert(schema.users).values(user);
    },
    async createFirstUser(user) {
      // The table lock, not a conditional insert: under READ COMMITTED two `INSERT … WHERE NOT
      // EXISTS` both see an empty table and both insert. EXCLUSIVE still lets reads through.
      return await db.transaction(async (tx) => {
        await tx.execute(sql`lock table ${schema.users} in exclusive mode`);
        const [row] = await tx.select({ n: count() }).from(schema.users);
        if (row.n > 0) return false;
        await tx.insert(schema.users).values(user);
        return true;
      });
    },
    async getUserByEmail(email) {
      const row = await db.query.users.findFirst({
        where: (u, { eq }) => eq(u.email, email),
      });
      return row ?? null;
    },
    async getUserById(id) {
      const row = await db.query.users.findFirst({
        where: (u, { eq }) => eq(u.id, id),
      });
      return row ?? null;
    },
    async saveUser(user) {
      await db.update(schema.users).set(user).where(eq(schema.users.id, user.id));
    },
    async listUsers() {
      return await db.query.users.findMany({
        orderBy: (u, { asc }) => [asc(u.createdAt), asc(u.id)],
      });
    },
    async countUsers() {
      const [row] = await db.select({ n: count() }).from(schema.users);
      return row.n;
    },
    async countActiveOwners() {
      const [row] = await db.select({ n: count() }).from(schema.users)
        .where(and(
          eq(schema.users.role, "owner"),
          eq(schema.users.status, "active"),
          isNotNull(schema.users.emailVerifiedAt),
        ));
      return row.n;
    },
    async deleteUser(id) {
      await db.delete(schema.users).where(eq(schema.users.id, id));
    },
    async listUnverifiedUsersBefore(before) {
      return await db.query.users.findMany({
        where: (u, { and, isNull, lt }) => and(isNull(u.emailVerifiedAt), lt(u.createdAt, before)),
        orderBy: (u, { asc }) => [asc(u.createdAt), asc(u.id)],
      });
    },
    async listResetRequests() {
      return await db.query.users.findMany({
        where: (u, { isNotNull }) => isNotNull(u.resetRequestedAt),
        orderBy: (u, { asc }) => [asc(u.resetRequestedAt), asc(u.id)],
      });
    },
    async createSession(session) {
      await db.insert(schema.authSessions).values(session);
    },
    async getSessionByTokenHash(tokenHash) {
      const row = await db.query.authSessions.findFirst({
        where: (s, { eq }) => eq(s.tokenHash, tokenHash),
      });
      return row ?? null;
    },
    async getSessionById(id) {
      const row = await db.query.authSessions.findFirst({ where: (s, { eq }) => eq(s.id, id) });
      return row ?? null;
    },
    async listSessionsByUser(userId) {
      return await db.query.authSessions.findMany({
        where: (s, { eq }) => eq(s.userId, userId),
        orderBy: (s, { asc, desc }) => [desc(s.createdAt), asc(s.id)],
      });
    },
    async deleteSession(id) {
      await db.delete(schema.authSessions).where(eq(schema.authSessions.id, id));
    },
    async deleteSessionsByUser(userId) {
      await db.delete(schema.authSessions).where(eq(schema.authSessions.userId, userId));
    },
    async createApiToken(token) {
      await db.insert(schema.apiTokens).values(token);
    },
    async getApiTokenById(id) {
      const row = await db.query.apiTokens.findFirst({ where: (t, { eq }) => eq(t.id, id) });
      return row ?? null;
    },
    async getApiTokenByTokenHash(tokenHash) {
      const row = await db.query.apiTokens.findFirst({
        where: (t, { eq }) => eq(t.tokenHash, tokenHash),
      });
      return row ?? null;
    },
    async listApiTokensByUser(userId) {
      return await db.query.apiTokens.findMany({
        where: (t, { eq }) => eq(t.userId, userId),
        orderBy: (t, { asc, desc }) => [desc(t.createdAt), asc(t.id)],
      });
    },
    async saveApiToken(token) {
      await db.insert(schema.apiTokens).values(token)
        .onConflictDoUpdate({ target: schema.apiTokens.id, set: token });
    },
    async touchApiToken(id, at) {
      await db.update(schema.apiTokens).set({ lastUsedAt: at })
        .where(eq(schema.apiTokens.id, id));
    },
    async revokeApiTokenRow(id, at) {
      const revoked = await db.update(schema.apiTokens).set({ revokedAt: at })
        .where(and(eq(schema.apiTokens.id, id), isNull(schema.apiTokens.revokedAt)))
        .returning({ id: schema.apiTokens.id });
      return revoked.length > 0;
    },
    async saveIdentity(identity) {
      await db.insert(schema.externalIdentities).values(identity)
        .onConflictDoUpdate({
          target: [schema.externalIdentities.userId, schema.externalIdentities.provider],
          set: identity,
        });
    },
    async getIdentity(userId, provider) {
      const row = await db.query.externalIdentities.findFirst({
        where: (i, { and, eq }) => and(eq(i.userId, userId), eq(i.provider, provider)),
      });
      return row ?? null;
    },
    async getIdentityByAccount(provider, providerAccountId) {
      const row = await db.query.externalIdentities.findFirst({
        where: (i, { and, eq }) =>
          and(eq(i.provider, provider), eq(i.providerAccountId, providerAccountId)),
      });
      return row ?? null;
    },
    async listIdentitiesByUser(userId) {
      return await db.query.externalIdentities.findMany({
        where: (i, { eq }) => eq(i.userId, userId),
        orderBy: (i, { asc }) => [asc(i.createdAt), asc(i.id)],
      });
    },
    async listIdentitiesByLogin(provider, login) {
      return await db.query.externalIdentities.findMany({
        where: (i, { and, eq }) => and(eq(i.provider, provider), eq(i.login, login)),
      });
    },
    async deleteIdentity(userId, provider) {
      await db.delete(schema.externalIdentities).where(
        and(
          eq(schema.externalIdentities.userId, userId),
          eq(schema.externalIdentities.provider, provider),
        ),
      );
    },
    async createIdentityChallenge(challenge) {
      await db.insert(schema.identityChallenges).values(challenge);
    },
    async listIdentityChallenges(userId, provider, at) {
      return await db.query.identityChallenges.findMany({
        where: (c, { and, eq, gt, isNull }) =>
          and(
            eq(c.userId, userId),
            eq(c.provider, provider),
            isNull(c.usedAt),
            gt(c.expiresAt, at),
          ),
        orderBy: (c, { desc }) => [desc(c.createdAt)],
        // A handful at most: the challenge route is a button a person presses.
        limit: 20,
      });
    },
    async consumeIdentityChallenge(nonce, at) {
      // One statement: the UPDATE is the gate. Reading the row and then spending it would let
      // two concurrent link attempts both pass the read and both spend the same nonce.
      const [spent] = await db.update(schema.identityChallenges)
        .set({ usedAt: at })
        .where(and(
          eq(schema.identityChallenges.nonce, nonce),
          isNull(schema.identityChallenges.usedAt),
          gt(schema.identityChallenges.expiresAt, at),
        ))
        .returning({ userId: schema.identityChallenges.userId });
      return spent ?? null;
    },
    async deleteIdentityChallengesExpiredBefore(before) {
      await db.delete(schema.identityChallenges)
        .where(lt(schema.identityChallenges.expiresAt, before));
    },
    async createInvite(invite) {
      await db.insert(schema.invites).values(invite);
    },
    async getInviteById(id) {
      const row = await db.query.invites.findFirst({ where: (i, { eq }) => eq(i.id, id) });
      return row ?? null;
    },
    async getInviteByTokenHash(tokenHash) {
      const row = await db.query.invites.findFirst({
        where: (i, { eq }) => eq(i.tokenHash, tokenHash),
      });
      return row ?? null;
    },
    async listInvites() {
      return await db.query.invites.findMany({
        orderBy: (i, { asc, desc }) => [desc(i.createdAt), asc(i.id)],
      });
    },
    async saveInvite(invite) {
      await db.update(schema.invites).set(invite).where(eq(schema.invites.id, invite.id));
    },
    async claimInviteUse(id) {
      const claimed = await db.update(schema.invites)
        .set({ uses: sql`${schema.invites.uses} + 1` })
        .where(
          and(
            eq(schema.invites.id, id),
            isNull(schema.invites.revokedAt),
            or(isNull(schema.invites.maxUses), lt(schema.invites.uses, schema.invites.maxUses)),
          ),
        )
        .returning({ id: schema.invites.id });
      return claimed.length === 1;
    },
    async createPasskey(passkey) {
      await db.insert(schema.passkeys).values(passkey);
    },
    async getPasskeyById(id) {
      const row = await db.query.passkeys.findFirst({ where: (p, { eq }) => eq(p.id, id) });
      return row ?? null;
    },
    async listPasskeysByUser(userId) {
      return await db.query.passkeys.findMany({
        where: (p, { eq }) => eq(p.userId, userId),
        orderBy: (p, { asc }) => [asc(p.createdAt), asc(p.id)],
      });
    },
    async savePasskey(passkey) {
      await db.update(schema.passkeys).set(passkey).where(eq(schema.passkeys.id, passkey.id));
    },
    async deletePasskey(id) {
      await db.delete(schema.passkeys).where(eq(schema.passkeys.id, id));
    },
    async createChallenge(challenge) {
      await db.insert(schema.passkeyChallenges).values(challenge);
    },
    async takeChallenge(id) {
      const [row] = await db.delete(schema.passkeyChallenges)
        .where(eq(schema.passkeyChallenges.id, id))
        .returning();
      return row ?? null;
    },
    async deleteChallengesExpiredBefore(before) {
      await db.delete(schema.passkeyChallenges).where(
        lt(schema.passkeyChallenges.expiresAt, before),
      );
    },
    async createToken(token) {
      await db.insert(schema.oneTimeTokens).values(token);
    },
    async getTokenByHash(tokenHash) {
      const row = await db.query.oneTimeTokens.findFirst({
        where: (t, { eq }) => eq(t.tokenHash, tokenHash),
      });
      return row ?? null;
    },
    async claimToken(id, usedAt) {
      const claimed = await db.update(schema.oneTimeTokens)
        .set({ usedAt })
        .where(and(eq(schema.oneTimeTokens.id, id), isNull(schema.oneTimeTokens.usedAt)))
        .returning({ id: schema.oneTimeTokens.id });
      return claimed.length === 1;
    },
    async hasLiveToken(userId, kind, now) {
      const [row] = await db.select({ n: count() }).from(schema.oneTimeTokens)
        .where(and(
          eq(schema.oneTimeTokens.userId, userId),
          eq(schema.oneTimeTokens.kind, kind),
          isNull(schema.oneTimeTokens.usedAt),
          gt(schema.oneTimeTokens.expiresAt, now),
        ));
      return row.n > 0;
    },
    async deleteUnusedTokens(userId, kind) {
      await db.delete(schema.oneTimeTokens).where(
        and(
          eq(schema.oneTimeTokens.userId, userId),
          eq(schema.oneTimeTokens.kind, kind),
          isNull(schema.oneTimeTokens.usedAt),
        ),
      );
    },
    async deleteTokensExpiredBefore(before) {
      await db.delete(schema.oneTimeTokens).where(lt(schema.oneTimeTokens.expiresAt, before));
    },
    async getSettings() {
      const row = await db.query.authSettings.findFirst({
        where: (s, { eq }) => eq(s.id, SETTINGS_ID),
      });
      if (!row) return null;
      const { id: _id, ...settings } = row;
      return settings;
    },
    async saveSettings(settings) {
      await db.insert(schema.authSettings).values({ id: SETTINGS_ID, ...settings })
        .onConflictDoUpdate({ target: schema.authSettings.id, set: settings });
    },
    async getSigningKey() {
      // `kid` breaks the tie, and the tie is real: two replicas booting into an empty database
      // mint within the same millisecond often enough, and an ordering that leaves them free to
      // disagree is how they end up signing with different keys.
      const row = await db.query.authSigningKeys.findFirst({
        orderBy: (k, { asc }) => [asc(k.createdAt), asc(k.kid)],
      });
      return row ?? null;
    },
    async listSigningKeys() {
      return await db.query.authSigningKeys.findMany({
        orderBy: (k, { asc }) => [asc(k.createdAt), asc(k.kid)],
      });
    },
    async saveSigningKey(key) {
      // The racing replicas mint DIFFERENT kids, so this conflict is not the race — it is a
      // retry, or one process calling ensure twice. Either way it is not news.
      await db.insert(schema.authSigningKeys).values(key).onConflictDoNothing();
    },
    close: handle.close,
  };
}

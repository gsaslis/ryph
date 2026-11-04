// The drizzle AuthStore round-trips users, sessions, identities, settings, and the signing
// key on an in-memory db, and the schema's constraints hold.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { drizzleAuthStore } from "../src/adapters/store/drizzle.ts";
import type { ApiToken, ExternalIdentity, Session, SigningKey, User } from "../src/core/types.ts";
import { reusableDbSuite } from "./reusable_db.ts";

const { test, makeTestDb } = reusableDbSuite("auth store");

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";

const user: User = {
  id: "u-1",
  email: "ada@example.com",
  name: "Ada",
  passwordHash: "scrypt:N=16384:salt:hash",
  role: "owner",
  status: "active",
  emailVerifiedAt: T0,
  unprovenEmail: null,
  resetRequestedAt: null,
  createdAt: T0,
  updatedAt: T0,
};

const session: Session = {
  id: "s-1",
  userId: "u-1",
  tokenHash: "deadbeef",
  expiresAt: "2026-02-01T00:00:00.000Z",
  createdAt: T0,
  userAgent: "Mozilla/5.0",
  ip: "203.0.113.7",
  lastUsedAt: null,
};

const identity: ExternalIdentity = {
  id: "i-1",
  userId: "u-1",
  provider: "github",
  providerAccountId: "12345",
  login: "ada",
  email: "ada@example.com",
  emailVerified: true,
  createdAt: T0,
  updatedAt: T0,
};

const key: SigningKey = {
  kid: "k-1",
  privateJwk: { kty: "OKP", crv: "Ed25519", d: "secret", x: "public" },
  publicJwk: { kty: "OKP", crv: "Ed25519", x: "public", alg: "EdDSA", use: "sig" },
  createdAt: T0,
};

test("drizzle auth store round-trips users, sessions, and the signing key", async () => {
  const store = drizzleAuthStore(await makeTestDb());
  try {
    assertEquals(await store.countUsers(), 0);
    await store.createUser(user);
    assertEquals(await store.countUsers(), 1);
    assertEquals(await store.countActiveOwners(), 1);
    assertEquals(await store.getUserByEmail("ada@example.com"), user);
    assertEquals(await store.getUserById("u-1"), user);
    assertEquals(await store.getUserByEmail("nobody@example.com"), null);

    await store.saveUser({ ...user, status: "deactivated", updatedAt: T1 });
    assertEquals((await store.getUserById("u-1"))!.status, "deactivated");
    await store.createUser({ ...user, id: "u-2", email: "bob@example.com", role: "member" });
    assertEquals((await store.listUsers()).map((u) => u.id), ["u-1", "u-2"]);
    assertEquals(await store.countActiveOwners(), 0);

    await store.createSession(session);
    assertEquals(await store.getSessionByTokenHash("deadbeef"), session);
    await store.createSession({ ...session, id: "s-2", tokenHash: "cafe", createdAt: T1 });
    assertEquals((await store.listSessionsByUser("u-1")).map((s) => s.id), ["s-2", "s-1"]);
    await store.deleteSession("s-1");
    assertEquals(await store.getSessionByTokenHash("deadbeef"), null);
    await store.deleteSessionsByUser("u-1");
    assertEquals(await store.listSessionsByUser("u-1"), []);

    assertEquals(await store.getSigningKey(), null);
    await store.saveSigningKey(key);
    assertEquals(await store.getSigningKey(), key);
  } finally {
    await store.close();
  }
});

test("identities upsert per (user, provider) and resolve by account and login", async () => {
  const store = drizzleAuthStore(await makeTestDb());
  try {
    await store.createUser(user);
    await store.saveIdentity(identity);
    assertEquals(await store.getIdentity("u-1", "github"), identity);
    assertEquals(await store.getIdentityByAccount("github", "12345"), identity);
    assertEquals(await store.listIdentitiesByLogin("github", "ada"), [identity]);
    assertEquals(await store.getIdentity("u-1", "gitlab"), null);

    // Re-linking the same provider replaces the account rather than adding a row.
    await store.saveIdentity({
      ...identity,
      id: "i-2",
      providerAccountId: "67890",
      login: "ada-lovelace",
      updatedAt: T1,
    });
    assertEquals((await store.listIdentitiesByUser("u-1")).length, 1);
    assertEquals((await store.getIdentity("u-1", "github"))!.login, "ada-lovelace");
    assertEquals(await store.getIdentityByAccount("github", "12345"), null);

    await store.deleteIdentity("u-1", "github");
    assertEquals(await store.listIdentitiesByUser("u-1"), []);
  } finally {
    await store.close();
  }
});

test("one provider account belongs to one user", async () => {
  const store = drizzleAuthStore(await makeTestDb());
  try {
    await store.createUser(user);
    await store.createUser({ ...user, id: "u-2", email: "bob@example.com", role: "member" });
    await store.saveIdentity(identity);
    await assertRejects(() => store.saveIdentity({ ...identity, id: "i-2", userId: "u-2" }));
  } finally {
    await store.close();
  }
});

test("deleting a user takes its sessions and identities with it", async () => {
  const store = drizzleAuthStore(await makeTestDb());
  try {
    await store.createUser(user);
    await store.createSession(session);
    await store.saveIdentity(identity);
    await store.deleteUser("u-1");
    assertEquals(await store.getUserById("u-1"), null);
    assertEquals(await store.getSessionByTokenHash("deadbeef"), null);
    assertEquals(await store.getIdentityByAccount("github", "12345"), null);
  } finally {
    await store.close();
  }
});

test("settings are absent until saved, then a single row", async () => {
  const store = drizzleAuthStore(await makeTestDb());
  try {
    assertEquals(await store.getSettings(), null);
    const settings = { allowOpenRegistration: true, allowForgeOrgJoin: false, updatedAt: T0 };
    await store.saveSettings(settings);
    assertEquals(await store.getSettings(), settings);
    await store.saveSettings({ ...settings, allowForgeOrgJoin: true, updatedAt: T1 });
    assertEquals((await store.getSettings())!.allowForgeOrgJoin, true);
  } finally {
    await store.close();
  }
});

test("duplicate emails are refused by the unique index", async () => {
  const store = drizzleAuthStore(await makeTestDb());
  try {
    await store.createUser(user);
    let threw = false;
    try {
      await store.createUser({ ...user, id: "u-2" });
    } catch {
      threw = true;
    }
    assert(threw);
  } finally {
    await store.close();
  }
});

test("touchApiToken and revokeApiTokenRow are column writes: neither undoes the other's", async () => {
  const store = drizzleAuthStore(await makeTestDb());
  try {
    await store.createUser(user);
    const token: ApiToken = {
      id: "t-1",
      userId: "u-1",
      name: "ci",
      tokenHash: "deadbeef",
      caps: ["tasks:read"],
      expiresAt: "2026-02-01T00:00:00.000Z",
      createdAt: T0,
      lastUsedAt: null,
      revokedAt: null,
    };
    await store.createApiToken(token);

    // The lost-update this guards against: an exchange reads the row live, a revocation
    // commits, and the exchange's own write lands AFTER it. A whole-row save from the
    // exchange's stale read would put `revokedAt` back to null here; the column write must
    // not, whichever of the two lands last.
    const revoked = await store.revokeApiTokenRow("t-1", T1);
    assert(revoked, "the first revoke wins");
    await store.touchApiToken("t-1", "2026-01-03T00:00:00.000Z");
    const row = await store.getApiTokenById("t-1");
    assertEquals(row?.revokedAt, T1, "the exchange's touch did not resurrect it");
    assertEquals(row?.lastUsedAt, "2026-01-03T00:00:00.000Z");

    // Idempotent: a second revoke (a racing caller, a retry) reports it did not win the race.
    assertEquals(await store.revokeApiTokenRow("t-1", "2026-01-04T00:00:00.000Z"), false);
    assertEquals((await store.getApiTokenById("t-1"))?.revokedAt, T1, "the first stamp holds");
  } finally {
    await store.close();
  }
});

test("only one first user is ever created, however many race for it", async () => {
  const store = drizzleAuthStore(await makeTestDb());
  try {
    const outcomes = await Promise.all([
      store.createFirstUser(user),
      store.createFirstUser({ ...user, id: "u-2", email: "bob@example.com" }),
      store.createFirstUser({ ...user, id: "u-3", email: "carol@example.com" }),
    ]);
    assertEquals(outcomes.filter(Boolean).length, 1);
    assertEquals(await store.countUsers(), 1);
    // And once anyone exists, never again.
    assertEquals(
      await store.createFirstUser({ ...user, id: "u-4", email: "dan@example.com" }),
      false,
    );
  } finally {
    await store.close();
  }
});

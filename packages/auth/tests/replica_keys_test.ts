// The signing-key race, as two replicas rather than as a description of one.
//
// Two processes booting into an empty database each mint a key. Before this was fixed, each one
// published only its own in its JWKS and held a verifier snapshotted at its own boot — so a user
// who logged in through replica A was rejected by replica B, and the symptom at the browser was
// an intermittent "session expired" that no single service's logs explained.

import { test } from "bun:test";
import { assertEquals, assertNotEquals } from "@std/assert";
import { makeAuthService } from "../src/core/service.ts";
import { verifierFromJwksSource } from "../src/core/verify.ts";
import { memoryAuthStore } from "./memory_store.ts";
import type { AuthStore } from "../src/ports/auth_store.ts";
import type { SigningKey } from "../src/core/types.ts";

// REAL time, not a fixed instant. Tokens carry an `exp`, and jose checks it against the wall
// clock — so a frozen clock mints tokens that verify only while the wall clock happens to be
// inside their ten-minute TTL. This test passed for ten minutes on the day it was written and
// would have failed on every run after.
//
// Key ORDERING still has to be deterministic, so the planted keys below use sentinel timestamps
// far on either side of now rather than values near it.
const now = () => new Date();

/** Sorts before anything this suite mints; and after. */
const EARLIER = "1999-01-01T00:00:00.000Z";
const LATER = "2999-01-01T00:00:00.000Z";

/** A replica: its own service and verifier, over the shared store. */
async function replica(store: AuthStore) {
  const service = await makeAuthService({ store, now });
  return { service, verifier: verifierFromJwksSource(() => service.jwks(), { minReloadMs: 0 }) };
}

/**
 * A key as a PEER would have minted it. The kid lives in three places — the row, and inside each
 * JWK — because the JWKS publishes the JWK and the token header names the JWK's kid; changing
 * only the row produces a key nothing can find.
 */
function peerKey(from: SigningKey, kid: string, createdAt: string): SigningKey {
  return {
    kid,
    createdAt,
    privateJwk: { ...from.privateJwk, kid },
    publicJwk: { ...from.publicJwk, kid },
  };
}

async function user(store: AuthStore, email: string) {
  const created = await store.getUserByEmail(email);
  if (created) return created;
  const service = await makeAuthService({ store, now });
  const outcome = await service.createUser({
    name: "Ada",
    email,
    password: "correct-horse",
    setupToken: (await service.setupToken())!,
  });
  if (!outcome.ok) throw new Error(outcome.error);
  return (await store.getUserByEmail(email))!;
}

test("both replicas mint into one store, and each verifies the other's tokens", async () => {
  const store = memoryAuthStore();
  await user(store, "ada@example.com");

  // Booted together, into a store that already has whatever the user bootstrap minted. To force
  // the actual race, plant a second key as a peer would.
  const alice = await replica(store);
  // A LATER createdAt, so `getSigningKey`'s total order still prefers the original — which is
  // the point: convergence on one signer, both keys published.
  await store.saveSigningKey(
    peerKey((await store.getSigningKey())!, "k-peerplanted", LATER),
  );
  const bob = await replica(store);

  assertEquals((await store.listSigningKeys()).length, 2, "the race should leave two keys");

  const aliceLogin = await alice.service.login("ada@example.com", "correct-horse");
  assertEquals(aliceLogin.ok, true);
  const token = aliceLogin.ok ? aliceLogin.tokens.accessToken : "";

  // The actual defect: Bob rejecting a token Alice minted.
  const onBob = await bob.verifier.verify(token);
  assertEquals(onBob?.email, "ada@example.com");

  // And both replicas publish both keys, so a remote verifier fetching either JWKS is complete.
  const fromAlice = (await alice.service.jwks()).keys.map((k) => k.kid).sort();
  const fromBob = (await bob.service.jwks()).keys.map((k) => k.kid).sort();
  assertEquals(fromAlice, fromBob);
  assertEquals(fromAlice.length, 2);
});

test("a key minted after boot is picked up without a restart", async () => {
  const store = memoryAuthStore();
  await user(store, "grace@example.com");
  const alice = await replica(store);

  // Alice is running. A peer joins and mints — which, before the fix, Alice could never learn.
  const first = (await store.getSigningKey())!;
  await store.saveSigningKey(peerKey(first, "k-mintedlater", LATER));

  const seen = (await alice.service.jwks()).keys.map((k) => k.kid);
  assertEquals(seen.includes("k-mintedlater"), true, "Alice's JWKS is stale");
});

test("ensureSigningKey converges on one signer when it can see both rows", async () => {
  const store = memoryAuthStore();
  const alice = await makeAuthService({ store, now });
  // A peer that minted FIRST — earlier createdAt, so the total order prefers it.
  const mine = (await store.getSigningKey())!;
  await store.saveSigningKey(peerKey(mine, "k-earlier", EARLIER));
  const bob = await makeAuthService({ store, now });

  const [aliceKid, bobKid] = await Promise.all([
    alice.jwks().then((j) => j.keys[0].kid),
    bob.jwks().then((j) => j.keys[0].kid),
  ]);
  // Both list the same set in the same order, so "the first key" means the same thing on both.
  assertEquals(aliceKid, "k-earlier");
  assertEquals(bobKid, "k-earlier");
  assertNotEquals(mine.kid, "k-earlier");
});

test("an unknown kid does not reload more often than the floor allows", async () => {
  const store = memoryAuthStore();
  await user(store, "hopper@example.com");
  let loads = 0;
  const service = await makeAuthService({ store, now });
  const verifier = verifierFromJwksSource(() => {
    loads++;
    return service.jwks();
  }, { minReloadMs: 60_000 });

  // A forged token whose kid this process has never seen: the reload trigger is caller-supplied,
  // so it must not be a free database read per request.
  const forged = "eyJhbGciOiJFZERTQSIsImtpZCI6Imstbm9zdWNoIn0.e30.AAAA";
  assertEquals(await verifier.verify(forged), null);
  assertEquals(await verifier.verify(forged), null);
  assertEquals(await verifier.verify(forged), null);
  assertEquals(loads, 1, "every unknown kid triggered its own read");
});

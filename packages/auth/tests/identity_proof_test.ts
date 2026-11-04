// Linking an identity on a provider with no OAuth to borrow: the challenge/proof pair, over a
// scripted `ChallengeProvider` double.
//
// Radicle is the provider this exists for — an account there IS a key — but nothing here knows
// that: auth mints the nonce, spends it once, and writes the row, and the double stands for
// whatever reads a signature. The real verifier (ssh-keygen, a DID's key, the namespace) is
// tested where it lives, in @ryph/orchestrator's sshsig_test.ts.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { makeAuthService } from "../src/core/service.ts";
import { asOperator } from "./operator.ts";
import { verifierFromJwksSource } from "../src/core/verify.ts";
import { authRoutes } from "../src/http/routes.ts";
import { makeRouter } from "@ryph/shared/http";
import type { ChallengeProvider } from "../src/ports/identity_provider.ts";
import { memoryAuthStore } from "./memory_store.ts";

const DID = "did:key:z6MkireRatUThvd3qzfKht1S44wpm4FEWSSa4PRMTSQZ3voM";
const OTHER = "did:key:z6MktaNvN1tMt1Nkm5gNomgQsjqR3nrPtAVSt58BJgmv5J3z";

/** A "signature" the test can write down: `sig:<subject>:<nonce>`, and nothing else verifies. */
function fakeChallengeProvider(): ChallengeProvider {
  return {
    providers: () => ["radicle"],
    command: (_provider, nonce) => `sign --namespace ryph ${nonce}`,
    verify(_provider, nonce, proof) {
      if (proof.signature !== `sig:${proof.subject}:${nonce}`) return Promise.resolve(null);
      return Promise.resolve({
        accountId: proof.subject,
        login: proof.subject,
        name: null,
        verifiedEmails: [],
      });
    },
  };
}

// Starts at REAL now: jose validates `exp` against the wall clock, so a fake epoch would make
// every bearer here expired (or not yet valid) before the first assertion.
function fakeClock() {
  let ms = Date.now();
  return { now: () => new Date(ms), advance: (by: number) => ms += by };
}
let clock = fakeClock();

async function build() {
  clock = fakeClock();
  const store = memoryAuthStore();
  const service = await makeAuthService({
    store,
    now: clock.now,
    challengeProvider: fakeChallengeProvider(),
    appUrl: "https://ryph.example",
  });
  const verifier = verifierFromJwksSource(() => service.jwks());
  const routes = authRoutes({ service, verifier, now: clock.now });
  const handler = makeRouter(routes);
  return { handler: asOperator(handler, service), service, store };
}

const call = (
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) =>
  handler(
    new Request(`http://auth.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const ADA = { email: "ada@example.com", name: "Ada", password: "correct horse battery" };

async function bootstrapAdmin(handler: (req: Request) => Promise<Response>) {
  await call(handler, "POST", "/v1/auth/users", ADA);
  const login = await call(handler, "POST", "/v1/auth/login", {
    email: ADA.email,
    password: ADA.password,
  });
  return await login.json();
}

const challenge = (handler: (req: Request) => Promise<Response>, token: string) =>
  call(handler, "POST", "/v1/auth/identities/radicle/challenge", {}, token);

const link = (
  handler: (req: Request) => Promise<Response>,
  token: string,
  proof: { subject: string; signature: string },
) => call(handler, "POST", "/v1/auth/identities/radicle/link", proof, token);

test("a signed challenge links the subject as its own login, and a replay links nothing", async () => {
  const { handler, store } = await build();
  const { accessToken, user } = await bootstrapAdmin(handler);

  const minted = await challenge(handler, accessToken);
  assertEquals(minted.status, 201);
  const offer = await minted.json();
  assert(offer.nonce.startsWith("ryph-link-"));
  // Pasteable as it stands, and it carries the nonce the verifier will be given.
  assertEquals(offer.command, `sign --namespace ryph ${offer.nonce}`);

  const signature = `sig:${DID}:${offer.nonce}`;
  const linked = await link(handler, accessToken, { subject: DID, signature });
  assertEquals(linked.status, 200);
  assertEquals(await linked.json(), {
    provider: "radicle",
    login: DID,
    linkedAt: clock.now().toISOString(),
  });
  assertEquals((await store.getIdentity(user.id, "radicle"))?.providerAccountId, DID);

  // Single use: the same signature, replayed, links nothing — and says only that.
  const replayed = await link(handler, accessToken, { subject: DID, signature });
  assertEquals(replayed.status, 400);
  assertEquals((await replayed.json()).error, "bad_signature");

  // So does a signature that verifies against no outstanding challenge at all.
  const second = await (await challenge(handler, accessToken)).json();
  const wrong = await link(handler, accessToken, {
    subject: DID,
    signature: `sig:${DID}:not-${second.nonce}`,
  });
  assertEquals(wrong.status, 400);
});

test("an expired challenge is spent by nobody, and a subject held elsewhere is a conflict", async () => {
  const { handler, store } = await build();
  const { accessToken, user } = await bootstrapAdmin(handler);

  const stale = await (await challenge(handler, accessToken)).json();
  // Eleven minutes on: past the ten-minute window.
  clock.advance(11 * 60_000);
  const late = await link(handler, accessToken, {
    subject: DID,
    signature: `sig:${DID}:${stale.nonce}`,
  });
  assertEquals(late.status, 400);

  // The same subject, already another user's — refused before any nonce is spent.
  await store.createUser({
    id: "u-2",
    email: "grace@example.com",
    name: "Grace",
    passwordHash: null,
    role: "member",
    status: "active",
    emailVerifiedAt: clock.now().toISOString(),
    unprovenEmail: null,
    resetRequestedAt: null,
    createdAt: clock.now().toISOString(),
    updatedAt: clock.now().toISOString(),
  });
  await store.saveIdentity({
    id: "i-2",
    userId: "u-2",
    provider: "radicle",
    providerAccountId: DID,
    login: DID,
    email: null,
    emailVerified: false,
    createdAt: clock.now().toISOString(),
    updatedAt: clock.now().toISOString(),
  });
  const fresh = await (await challenge(handler, accessToken)).json();
  const taken = await link(handler, accessToken, {
    subject: DID,
    signature: `sig:${DID}:${fresh.nonce}`,
  });
  assertEquals(taken.status, 409);
  const live = await store.listIdentityChallenges(user.id, "radicle", clock.now().toISOString());
  assertEquals(live.map((c) => c.nonce).includes(fresh.nonce), true, "the nonce was not spent");
});

test("identities are listed per provider, and unlinking one leaves the rest", async () => {
  const { handler, store } = await build();
  const { accessToken, user } = await bootstrapAdmin(handler);
  // A second identity, of the kind this instance signs people in through.
  await store.saveIdentity({
    id: "i-1",
    userId: user.id,
    provider: "github",
    providerAccountId: "id-ada",
    login: "ada",
    email: null,
    emailVerified: false,
    createdAt: clock.now().toISOString(),
    updatedAt: clock.now().toISOString(),
  });
  const offer = await (await challenge(handler, accessToken)).json();
  assertEquals(
    (await link(handler, accessToken, { subject: OTHER, signature: `sig:${OTHER}:${offer.nonce}` }))
      .status,
    200,
  );

  const listed = await (await call(handler, "GET", "/v1/auth/identities", undefined, accessToken))
    .json();
  assertEquals(listed.identities.map((i: { provider: string }) => i.provider).sort(), [
    "github",
    "radicle",
  ]);
  // Never a credential: the provider, the login, and when the link was made.
  for (const identity of listed.identities) {
    assertEquals(Object.keys(identity).sort(), ["linkedAt", "login", "provider"]);
  }

  const unlinked = await call(
    handler,
    "DELETE",
    "/v1/auth/identities/radicle",
    undefined,
    accessToken,
  );
  assertEquals(unlinked.status, 200);
  assertEquals((await store.listIdentitiesByUser(user.id)).map((i) => i.provider), ["github"]);
  // Unlinking what was never linked is a 404, on any provider name.
  assertEquals(
    (await call(handler, "DELETE", "/v1/auth/identities/gitlab", undefined, accessToken)).status,
    404,
  );
});

test("an instance with no challenge provider offers nothing and refuses both routes", async () => {
  const store = memoryAuthStore();
  const service = await makeAuthService({ store, now: () => new Date(), appUrl: null });
  assertEquals(service.challengeProviders(), []);
  assertEquals(
    await service.mintIdentityChallenge("u-1", "radicle"),
    { ok: false, error: "no-provider" },
  );
  assertEquals(
    await service.linkProviderByProof("u-1", "radicle", { subject: DID, signature: "x" }),
    { ok: false, error: "no-provider" },
  );
});

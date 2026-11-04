// Claiming an instance: the setup token a networked deployment's first registration needs, the
// single-user mode the local binary runs in, and the login links that are its way in.

import { test } from "bun:test";
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { makeAuthService } from "../src/core/service.ts";
import { hmacSha256Hex } from "@ryph/sealed";
import { isSetupToken, setupTokenFor } from "../src/core/bootstrap.ts";
import { verifierFromJwksSource } from "../src/core/verify.ts";
import { authRoutes, PROXY_SECRET_HEADER } from "../src/http/routes.ts";
import { makeRouter } from "@ryph/shared/http";
import { AuthConfigError, multiUserFromEnv, setup, setupTokenNotice } from "../src/setup.ts";
import { UpdateProfileSchema } from "../src/schema.ts";
import type { SigningKey } from "../src/core/types.ts";
import type { IdentityProvider } from "../src/ports/identity_provider.ts";
import { memoryAuthStore } from "./memory_store.ts";

const APP = "http://app.test";
const ADA = { email: "ada@example.com", name: "Ada Lovelace", password: "correct horse battery" };

function makeClock() {
  let nowMs = Date.now();
  return { now: () => new Date(nowMs), advance: (ms: number) => nowMs += ms };
}

async function build(
  opts: {
    multiUser: boolean;
    proxySecret?: string;
    localLoginSecret?: string;
    loginLinks?: boolean;
    appUrl?: string;
    store?: ReturnType<typeof memoryAuthStore>;
    identityProvider?: IdentityProvider;
  },
) {
  const clock = makeClock();
  const store = opts.store ?? memoryAuthStore();
  const service = await makeAuthService({
    store,
    now: clock.now,
    appUrl: opts.appUrl ?? APP,
    multiUser: opts.multiUser,
    loginLinks: opts.loginLinks,
    identityProvider: opts.identityProvider ?? null,
  });
  const verifier = verifierFromJwksSource(() => service.jwks());
  const routes = authRoutes({
    service,
    verifier,
    now: clock.now,
    proxySecret: opts.proxySecret ?? null,
    localLoginSecret: opts.localLoginSecret ?? null,
  });
  const handler = makeRouter(routes);
  return { handler, service, store, clock };
}

function call(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
) {
  return handler(
    new Request(`http://auth.test${path}`, {
      method,
      headers: {
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        ...(opts.token === undefined ? {} : { authorization: `Bearer ${opts.token}` }),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
}

/** The raw token at the end of a login link. */
const tokenOf = (link: string): string => link.slice(link.lastIndexOf("/") + 1);

test("the first registration needs the setup token, and only the first", async () => {
  const { handler, service } = await build({ multiUser: true });
  const token = await service.setupToken();
  assert(token !== null && /^[0-9a-f]{64}$/.test(token));

  // Without it, or with the wrong one, an unclaimed instance stays unclaimed.
  const bare = await call(handler, "POST", "/v1/auth/users", { body: ADA });
  assertEquals(bare.status, 403);
  assertEquals((await bare.json()).code, "setup_token");
  const wrong = await call(handler, "POST", "/v1/auth/users", {
    body: { ...ADA, setupToken: "0".repeat(64) },
  });
  assertEquals(wrong.status, 403);
  assertEquals(await service.needsBootstrap(), true);

  const claimed = await call(handler, "POST", "/v1/auth/users", {
    body: { ...ADA, setupToken: token },
  });
  assertEquals(claimed.status, 201);
  assertEquals((await claimed.json()).role, "owner");

  // Gone once an owner exists: nothing prints it, and presenting it again opens nothing.
  assertEquals(await service.setupToken(), null);
  const again = await call(handler, "POST", "/v1/auth/users", {
    body: { ...ADA, email: "eve@example.com", setupToken: token },
  });
  assertEquals(again.status, 403);
});

test("two first registrations at once make exactly one owner", async () => {
  const { service, store } = await build({ multiUser: true });
  const setupToken = (await service.setupToken())!;
  const outcomes = await Promise.all([
    service.createUser({ ...ADA, setupToken }),
    service.createUser({ ...ADA, email: "eve@example.com", setupToken }),
  ]);
  assertEquals(outcomes.filter((o) => o.ok).length, 1);
  assertEquals((await store.listUsers()).filter((u) => u.role === "owner").length, 1);
});

test("a setup token printed under any stored key is accepted", async () => {
  // Two replicas booting into one empty database can each mint a signing key, and each prints
  // the token under its own; a registration routed to the other must still be admitted.
  const key = (kid: string, d: string): SigningKey => ({
    kid,
    privateJwk: { kty: "OKP", crv: "Ed25519", d, x: "x" },
    publicJwk: { kty: "OKP", crv: "Ed25519", x: "x" },
    createdAt: new Date().toISOString(),
  });
  const a = key("k-a", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
  const b = key("k-b", "HxweHRwbGhkYFxYVFBMSERAPDg0MCwoJCAcGBQQDAgE");
  // Stable for one key, so every replica and every restart prints the same one.
  assertEquals(await setupTokenFor(a), await setupTokenFor(a));
  assertEquals(
    await setupTokenFor(a),
    "4a7871793524c19f0a97e696f126d210dc4cb958db2d0252b4174cb892311eb2",
  );
  assertNotEquals(await setupTokenFor(a), await setupTokenFor(b));
  // Derived through HKDF, not an HMAC keyed directly with the signing key.
  assertNotEquals(
    await setupTokenFor(a),
    await hmacSha256Hex(String(a.privateJwk.d), "ryph setup token v1"),
  );
  assert(await isSetupToken(await setupTokenFor(b), [a, b]));
  assert(!await isSetupToken(await setupTokenFor(b), [a]));
  assert(!await isSetupToken(undefined, [a, b]));
  assert(!await isSetupToken("", [a, b]));
});

test("single-user: the owner is made at boot, and nobody else ever gets in", async () => {
  const { handler, service } = await build({ multiUser: false });
  assertEquals(await service.setupToken(), null);

  // Registration is refused outright, even the first one, even with a token.
  const register = await call(handler, "POST", "/v1/auth/users", { body: ADA });
  assertEquals(register.status, 403);
  assertEquals((await register.json()).code, "single_user");

  const owner = await service.ensureOwner({ email: "Ada@Example.com", name: "Ada" });
  assertEquals(owner?.role, "owner");
  assertEquals(owner?.email, "ada@example.com");
  assert(owner?.emailVerifiedAt !== null);
  // A second boot finds the same owner rather than making another.
  assertEquals((await service.ensureOwner({ email: "x@y.z", name: "X" }))?.id, owner?.id);

  const link = await service.mintLoginLink();
  assert(link.ok);
  const session = await call(handler, "POST", "/v1/auth/login-link", {
    body: { token: tokenOf(link.link) },
  });
  assertEquals(session.status, 200);
  const { accessToken } = await session.json();

  // Everything that would add, admit or re-role someone answers single_user, owner or not.
  const refusals: [string, string, unknown][] = [
    ["POST", "/v1/auth/invites", { email: "bob@example.com", role: "member" }],
    ["PATCH", `/v1/auth/users/${owner!.id}`, { role: "member" }],
    ["PATCH", `/v1/auth/users/${owner!.id}`, { status: "deactivated" }],
    ["DELETE", `/v1/auth/users/${owner!.id}`, undefined],
    ["PATCH", "/v1/auth/settings", { allowOpenRegistration: true }],
    ["PATCH", "/v1/auth/settings", { allowForgeOrgJoin: true }],
  ];
  for (const [method, path, body] of refusals) {
    const res = await call(handler, method, path, { body, token: accessToken });
    assertEquals(res.status, 403, `${method} ${path}`);
    assertEquals((await res.json()).code, "single_user", `${method} ${path}`);
  }
  // Closing a gate is still fine: it lets nobody in.
  const close = await call(handler, "PATCH", "/v1/auth/settings", {
    body: { allowOpenRegistration: false },
    token: accessToken,
  });
  assertEquals(close.status, 200);

  // What the UI reads to grey all of that out, without a token.
  assertEquals((await (await call(handler, "GET", "/v1/auth/settings")).json()).multiUser, false);
  assertEquals((await (await call(handler, "GET", "/v1/auth/bootstrap")).json()).multiUser, false);
});

test("a login link signs in once, and not after ten minutes", async () => {
  const { handler, service, clock } = await build({ multiUser: false });
  await service.ensureOwner({ email: "ada@example.com", name: "Ada" });

  const first = await service.mintLoginLink();
  assert(first.ok);
  assert(first.link.startsWith(`${APP}/auth/login-link/`));
  const token = tokenOf(first.link);
  assertEquals(
    (await call(handler, "POST", "/v1/auth/login-link", { body: { token } })).status,
    200,
  );
  assertEquals(
    (await call(handler, "POST", "/v1/auth/login-link", { body: { token } })).status,
    410,
  );

  const late = await service.mintLoginLink();
  assert(late.ok);
  clock.advance(11 * 60 * 1000);
  assertEquals(
    (await call(handler, "POST", "/v1/auth/login-link", { body: { token: tokenOf(late.link) } }))
      .status,
    410,
  );

  // A fresh link voids the one before it: only the latest works.
  const older = await service.mintLoginLink();
  const newer = await service.mintLoginLink();
  assert(older.ok && newer.ok);
  assertEquals(
    (await call(handler, "POST", "/v1/auth/login-link", { body: { token: tokenOf(older.link) } }))
      .status,
    410,
  );
});

test("login links are single-user only", async () => {
  const { service } = await build({ multiUser: true });
  await service.createUser({ ...ADA, setupToken: (await service.setupToken())! });
  assertEquals(await service.mintLoginLink(), { ok: false, error: "multi-user" });
});

test("signing out everywhere or changing the password voids an unspent login link", async () => {
  const { service } = await build({ multiUser: false });
  const owner = await service.ensureOwner({ email: "ada@example.com", name: "Ada" });

  const beforeSignOut = await service.mintLoginLink();
  assert(beforeSignOut.ok);
  await service.revokeAllSessions(owner!.id);
  assertEquals(await service.redeemLoginLink(tokenOf(beforeSignOut.link)), {
    ok: false,
    error: "invalid-token",
  });

  // Setting the first password locks down the same way.
  const beforePassword = await service.mintLoginLink();
  assert(beforePassword.ok);
  assert((await service.changePassword(owner!.id, null, ADA.password)).ok);
  assertEquals(await service.redeemLoginLink(tokenOf(beforePassword.link)), {
    ok: false,
    error: "invalid-token",
  });

  // A link minted afterwards still works.
  const after = await service.mintLoginLink();
  assert(after.ok);
  assert((await service.redeemLoginLink(tokenOf(after.link))).ok);
});

test("a link minted single-user does not survive a restart into multi-user", async () => {
  const single = await build({ multiUser: false });
  await single.service.ensureOwner({ email: "ada@example.com", name: "Ada" });
  const link = await single.service.mintLoginLink();
  assert(link.ok);
  // Same database, booted again with RYPH_MULTIUSER=on, inside the link's ten minutes.
  const multi = await build({ multiUser: true, store: single.store });
  // Its own answer, not "expired": a fresh link would be refused the same.
  const res = await call(multi.handler, "POST", "/v1/auth/login-link", {
    body: { token: tokenOf(link.link) },
  });
  assertEquals(res.status, 409);
  assertEquals((await res.json()).code, "multi_user");
  // Still unspent, so a restart back into single-user honours it.
  assert((await single.service.redeemLoginLink(tokenOf(link.link))).ok);
});

test("a login link signs in only an owner", async () => {
  const { handler, service, store } = await build({ multiUser: false });
  const owner = await service.ensureOwner({ email: "ada@example.com", name: "Ada" });
  const link = await service.mintLoginLink();
  assert(link.ok);
  const row = await store.getUserById(owner!.id);
  await store.saveUser({ ...row!, role: "member" });
  assertEquals(
    (await call(handler, "POST", "/v1/auth/login-link", { body: { token: tokenOf(link.link) } }))
      .status,
    410,
  );
});

test("ryph login mints a link only with the local secret", async () => {
  const absent = await build({ multiUser: false });
  await absent.service.ensureOwner({ email: "ada@example.com", name: "Ada" });
  // No secret configured: the route is not there at all.
  assertEquals((await call(absent.handler, "POST", "/v1/auth/local/login-link")).status, 404);

  const { handler, service } = await build({ multiUser: false, localLoginSecret: "s3cret" });
  await service.ensureOwner({ email: "ada@example.com", name: "Ada" });
  assertEquals((await call(handler, "POST", "/v1/auth/local/login-link")).status, 401);
  assertEquals(
    (await call(handler, "POST", "/v1/auth/local/login-link", { token: "guess" })).status,
    401,
  );
  const minted = await call(handler, "POST", "/v1/auth/local/login-link", { token: "s3cret" });
  assertEquals(minted.status, 201);
  const { link } = await minted.json();
  assertEquals(
    (await call(handler, "POST", "/v1/auth/login-link", { body: { token: tokenOf(link) } }))
      .status,
    200,
  );
});

test("bad bearers cannot lock ryph login out", async () => {
  const { handler, service } = await build({
    multiUser: false,
    proxySecret: "hop",
    localLoginSecret: "s3cret",
  });
  await service.ensureOwner({ email: "ada@example.com", name: "Ada" });
  // A run reaching the listener directly lands in the same unvouched bucket as `ryph login`.
  for (let i = 0; i < 20; i++) {
    const res = await call(handler, "POST", "/v1/auth/local/login-link", { token: "guess" });
    assertEquals(res.status, 401);
  }
  const minted = await call(handler, "POST", "/v1/auth/local/login-link", { token: "s3cret" });
  assertEquals(minted.status, 201);
});

test("bad and stale links cannot lock login links out", async () => {
  const { handler, service } = await build({ multiUser: false, proxySecret: "hop" });
  await service.ensureOwner({ email: "ada@example.com", name: "Ada" });
  // Vouched as loopback, the owner's own address: what a run reaching the app through
  // host.docker.internal looks like.
  const loopback = { "x-client-ip": "127.0.0.1", [PROXY_SECRET_HEADER]: "hop" };
  const spent = await service.mintLoginLink();
  assert(spent.ok);
  assertEquals(
    (await call(handler, "POST", "/v1/auth/login-link", {
      body: { token: tokenOf(spent.link) },
      headers: loopback,
    })).status,
    200,
  );
  for (let i = 0; i < 20; i++) {
    const token = i % 2 === 0 ? "0".repeat(64) : tokenOf(spent.link);
    const res = await call(handler, "POST", "/v1/auth/login-link", {
      body: { token },
      headers: loopback,
    });
    assertEquals(res.status, 410);
  }
  const fresh = await service.mintLoginLink();
  assert(fresh.ok);
  const res = await call(handler, "POST", "/v1/auth/login-link", {
    body: { token: tokenOf(fresh.link) },
    headers: loopback,
  });
  assertEquals(res.status, 200);
});

test("the client address counts only when the app's server vouches for it", async () => {
  const { handler, service } = await build({ multiUser: false, proxySecret: "hop" });
  await service.ensureOwner({ email: "ada@example.com", name: "Ada" });
  const signIn = async (headers: Record<string, string>) => {
    const link = await service.mintLoginLink();
    assert(link.ok);
    const res = await call(handler, "POST", "/v1/auth/login-link", {
      body: { token: tokenOf(link.link) },
      headers,
    });
    assertEquals(res.status, 200);
    return (await res.json()).accessToken as string;
  };

  // The app's server sends this literal; it cannot import the constant (it builds on Node), so
  // a test on each side holds it here.
  assertEquals(PROXY_SECRET_HEADER, "x-ryph-proxy-secret");
  // Straight to the listener, claiming an address: not recorded.
  const direct = await signIn({ "x-client-ip": "198.51.100.1" });
  // Through the app's server, which proves itself: recorded.
  await signIn({ "x-client-ip": "203.0.113.7", [PROXY_SECRET_HEADER]: "hop" });
  const sessions = await (await call(handler, "GET", "/v1/auth/sessions", { token: direct }))
    .json();
  assertEquals(
    sessions.sessions.map((s: { ip: string | null }) => s.ip).sort(),
    ["203.0.113.7", null].sort(),
  );
});

test("the profile: a name always, an address only single-user", async () => {
  const single = await build({ multiUser: false });
  await single.service.ensureOwner({ email: "owner@localhost", name: "Owner" });
  const link = await single.service.mintLoginLink();
  assert(link.ok);
  const { accessToken } = await (await call(single.handler, "POST", "/v1/auth/login-link", {
    body: { token: tokenOf(link.link) },
  })).json();
  const renamed = await call(single.handler, "PATCH", "/v1/auth/me", {
    body: { name: "Ada", email: "Ada@Example.com" },
    token: accessToken,
  });
  assertEquals(renamed.status, 200);
  const me = await renamed.json();
  assertEquals([me.name, me.email], ["Ada", "ada@example.com"]);

  const multi = await build({ multiUser: true });
  await multi.service.createUser({ ...ADA, setupToken: (await multi.service.setupToken())! });
  const login = await call(multi.handler, "POST", "/v1/auth/login", {
    body: { email: ADA.email, password: ADA.password },
  });
  const token = (await login.json()).accessToken;
  assertEquals(
    (await call(multi.handler, "PATCH", "/v1/auth/me", { body: { name: "A." }, token })).status,
    200,
  );
  assertEquals(
    (await call(multi.handler, "PATCH", "/v1/auth/me", {
      body: { email: "elsewhere@example.com" },
      token,
    })).status,
    403,
  );
});

test("RYPH_MULTIUSER reads on and off, and refuses anything else", () => {
  const env = (value: string | undefined) => (name: string) =>
    name === "RYPH_MULTIUSER" ? value : undefined;
  assertEquals(multiUserFromEnv(env(undefined), false), false);
  assertEquals(multiUserFromEnv(env(undefined), true), true);
  assertEquals(multiUserFromEnv(env("on"), false), true);
  assertEquals(multiUserFromEnv(env("OFF"), true), false);
  assertEquals(multiUserFromEnv(env("1"), false), true);
  let threw = false;
  try {
    multiUserFromEnv(env("sometimes"), false);
  } catch {
    threw = true;
  }
  assert(threw);
});

test("an owner with only login links cannot sign in once links are refused", async () => {
  const single = await build({ multiUser: false });
  // Nobody yet: a setup token claims the instance, so nobody is locked out.
  assertEquals(await single.service.ownerCanSignIn(), true);
  const owner = await single.service.ensureOwner({ email: "ada@example.com", name: "Ada" });
  assertEquals(await single.service.ownerCanSignIn(), false);

  // The same database booted multi-user, with or without GitHub sign-in configured.
  const github: IdentityProvider = {
    providers: () => ["github"],
    exchangeCode: () => Promise.reject(new Error("unused")),
    isOrgMember: () => Promise.resolve("not-member"),
    trustsEmails: () => true,
  };
  const withGithub = await build({
    multiUser: true,
    store: single.store,
    identityProvider: github,
  });
  const without = await build({ multiUser: true, store: single.store });

  // A linked identity counts only while its provider is configured.
  const at = new Date().toISOString();
  await single.store.saveIdentity({
    id: "i-1",
    userId: owner!.id,
    provider: "github",
    providerAccountId: "1",
    login: "ada",
    email: null,
    emailVerified: false,
    createdAt: at,
    updatedAt: at,
  });
  assertEquals(await withGithub.service.ownerCanSignIn(), true);
  assertEquals(await without.service.ownerCanSignIn(), false);
  await single.store.deleteIdentity(owner!.id, "github");
  assertEquals(await withGithub.service.ownerCanSignIn(), false);

  // A passkey does, as it does at sign-in, where it may be an owner's only way in.
  await single.store.savePasskey({
    id: "pk-1",
    userId: owner!.id,
    publicKey: "key",
    counter: 0,
    transports: [],
    name: "MacBook",
    backedUp: false,
    deviceType: null,
    createdAt: at,
    lastUsedAt: null,
  });
  assertEquals(await withGithub.service.ownerCanSignIn(), true);
  assertEquals(await without.service.ownerCanSignIn(), true);
  assertEquals(await without.service.ownerSignInEmails(), ["ada@example.com"]);
  await single.store.deletePasskey("pk-1");
  assertEquals(await without.service.ownerCanSignIn(), false);

  // A password does, but only on an owner who can hold a session.
  assert((await single.service.changePassword(owner!.id, null, ADA.password)).ok);
  assertEquals(await without.service.ownerCanSignIn(), true);
  const row = await single.store.getUserById(owner!.id);
  await single.store.saveUser({ ...row!, status: "deactivated" });
  assertEquals(await without.service.ownerCanSignIn(), false);
});

test("a login link with no app URL configured is built on the fallback, and only then", async () => {
  const service = await makeAuthService({
    store: memoryAuthStore(),
    now: () => new Date(),
    multiUser: false,
  });
  await service.ensureOwner({ email: "ada@example.com", name: "Ada" });
  assertEquals(await service.mintLoginLink(), { ok: false, error: "no-app-url" });
  const link = await service.mintLoginLink("http://localhost:5173/");
  assert(link.ok && link.link.startsWith("http://localhost:5173/auth/login-link/"));
  // A configured app URL wins over the fallback.
  const configured = await build({ multiUser: false });
  await configured.service.ensureOwner({ email: "ada@example.com", name: "Ada" });
  const own = await configured.service.mintLoginLink("http://localhost:5173");
  assert(own.ok && own.link.startsWith(`${APP}/`));
});

test("setup refuses an app URL that is not absolute http(s)", async () => {
  for (const appUrl of ["localhost:5173", "app.test", "ftp://app.test", "/"]) {
    await assertRejects(
      () => setup({ store: memoryAuthStore(), now: () => new Date(), multiUser: false, appUrl }),
      AuthConfigError,
      `RYPH_APP_URL must be an absolute http(s) URL, got ${JSON.stringify(appUrl)}`,
    );
  }
  await setup({
    store: memoryAuthStore(),
    now: () => new Date(),
    multiUser: false,
    appUrl: "http://localhost:5173/ryph/",
  });
});

test("the setup token notice links to the app's origin, not its path", () => {
  assert(
    setupTokenNotice("abc", "https://ryph.example/some/path/").includes(
      "open https://ryph.example/register?setup=abc.",
    ),
  );
  assert(setupTokenNotice("abc", null).includes("/register page"));
});

test("setup refuses multi-user without a proxy secret", async () => {
  await assertRejects(
    () => setup({ store: memoryAuthStore(), now: () => new Date(), multiUser: true }),
    AuthConfigError,
    "RYPH_PROXY_SECRET",
  );
  const ok = await setup({
    store: memoryAuthStore(),
    now: () => new Date(),
    multiUser: true,
    proxySecret: "s",
  });
  assert(ok.setupToken !== null);
  await setup({ store: memoryAuthStore(), now: () => new Date(), multiUser: false });
  // A root whose user surface is open (RYPH_AUTH=off) waives it.
  await setup({
    store: memoryAuthStore(),
    now: () => new Date(),
    multiUser: true,
    requireProxySecret: false,
  });
});

test("a single-user owner's login links count as a way in when unlinking", async () => {
  const single = await build({ multiUser: false, loginLinks: true });
  const multi = await build({ multiUser: true, store: single.store });
  const owner = await single.service.ensureOwner({ email: "ada@example.com", name: "Ada" });
  const at = new Date().toISOString();
  const github = {
    id: "i-1",
    userId: owner!.id,
    provider: "github",
    providerAccountId: "1",
    login: "ada",
    email: null,
    emailVerified: false,
    createdAt: at,
    updatedAt: at,
  };
  await single.store.saveIdentity(github);

  // Multi-user, the identity is the owner's only way in.
  assertEquals(await multi.service.unlinkIdentity(owner!.id, "github"), {
    ok: false,
    error: "last-sign-in-method",
  });
  // Single-user where nothing mints login links (a networked RYPH_MULTIUSER=off), likewise.
  const linkless = await build({ multiUser: false, store: single.store });
  assertEquals(await linkless.service.unlinkIdentity(owner!.id, "github"), {
    ok: false,
    error: "last-sign-in-method",
  });
  // Single-user where login links are minted, they always work, so it can go.
  assertEquals(await single.service.unlinkIdentity(owner!.id, "github"), { ok: true });
});

test("a login link counts as a way in only for the owner it signs in", async () => {
  const single = await build({ multiUser: false, loginLinks: true });
  const ada = await single.service.ensureOwner({ email: "ada@example.com", name: "Ada" });
  // A second owner left over from multi-user, younger than Ada: links sign Ada in, never Bob.
  const later = new Date(Date.now() + 60_000).toISOString();
  await single.store.createUser({
    id: "u-bob",
    email: "bob@example.com",
    name: "Bob",
    passwordHash: null,
    role: "owner",
    status: "active",
    emailVerifiedAt: later,
    unprovenEmail: null,
    resetRequestedAt: null,
    createdAt: later,
    updatedAt: later,
  });
  for (const [userId, login] of [[ada!.id, "ada"], ["u-bob", "bob"]]) {
    await single.store.saveIdentity({
      id: `i-${login}`,
      userId,
      provider: "github",
      providerAccountId: login,
      login,
      email: null,
      emailVerified: false,
      createdAt: later,
      updatedAt: later,
    });
  }
  assertEquals(await single.service.unlinkIdentity("u-bob", "github"), {
    ok: false,
    error: "last-sign-in-method",
  });
  assertEquals(await single.service.unlinkIdentity(ada!.id, "github"), { ok: true });
});

test("the owner made at boot gets a name the account page can save back", async () => {
  const cases: [string, string][] = [
    ["  Ada\r\n  Lovelace \t", "Ada Lovelace"],
    [" \n\t ", "Owner"],
    ["x".repeat(20_000), "x".repeat(10_000)],
  ];
  for (const [raw, name] of cases) {
    const { service } = await build({ multiUser: false });
    const owner = await service.ensureOwner({ email: "ada@example.com", name: raw });
    assertEquals(owner?.name, name);
    // What the account page sends back passes the profile schema.
    assert(UpdateProfileSchema.safeParse({ name: owner!.name }).success);
  }
});

test("only a single-user owner changes their address without proof", async () => {
  const { service, store } = await build({ multiUser: false });
  await service.ensureOwner({ email: "owner@localhost", name: "Owner" });
  // A member left over from when the instance was multi-user.
  const at = new Date().toISOString();
  await store.createUser({
    id: "u-member",
    email: "bob@example.com",
    name: "Bob",
    passwordHash: null,
    role: "member",
    status: "active",
    emailVerifiedAt: at,
    unprovenEmail: null,
    resetRequestedAt: null,
    createdAt: at,
    updatedAt: at,
  });
  assertEquals(await service.updateProfile("u-member", { email: "boss@example.com" }), {
    ok: false,
    error: "owner-only",
  });
  const renamed = await service.updateProfile("u-member", { name: "Robert" });
  assert(renamed.ok && renamed.user.email === "bob@example.com");
  assertEquals((await store.getUserById("u-member"))!.email, "bob@example.com");
  const owner = (await store.listUsers()).find((u) => u.role === "owner")!;
  assert((await service.updateProfile(owner.id, { email: "ada@example.com" })).ok);
});

test("bogus claims for the operator's address cannot keep the real claim out", async () => {
  const { handler, service } = await build({ multiUser: true });
  for (let i = 0; i < 12; i++) {
    const res = await call(handler, "POST", "/v1/auth/users", {
      body: { ...ADA, setupToken: i.toString(16).padStart(64, "0") },
      // Each from its own vouched address, so only the address's budget is shared.
      headers: { "x-client-ip": `198.51.100.${i}` },
    });
    assertEquals(res.status, 403);
  }
  const claimed = await call(handler, "POST", "/v1/auth/users", {
    body: { ...ADA, setupToken: await service.setupToken() },
    headers: { "x-client-ip": "203.0.113.7" },
  });
  assertEquals(claimed.status, 201);
});

test("the owners who can sign in are named by the same rule ownerCanSignIn uses", async () => {
  const github: IdentityProvider = {
    providers: () => ["github"],
    exchangeCode: () => Promise.reject(new Error("unused")),
    isOrgMember: () => Promise.resolve("not-member"),
    trustsEmails: () => true,
  };
  const single = await build({ multiUser: false });
  const owner = await single.service.ensureOwner({ email: "ada@example.com", name: "Ada" });
  const withGithub = await build({
    multiUser: true,
    store: single.store,
    identityProvider: github,
  });
  const without = await build({ multiUser: true, store: single.store });
  // Nobody at all is told apart from nobody who can sign in, in the same scan.
  assertEquals(await (await build({ multiUser: true })).service.ownerSignInEmails(), null);
  assertEquals(await withGithub.service.ownerSignInEmails(), []);

  const at = new Date().toISOString();
  await single.store.saveIdentity({
    id: "i-1",
    userId: owner!.id,
    provider: "github",
    providerAccountId: "1",
    login: "ada",
    email: null,
    emailVerified: false,
    createdAt: at,
    updatedAt: at,
  });
  // An identity counts only for a provider configured now.
  assertEquals(await withGithub.service.ownerSignInEmails(), ["ada@example.com"]);
  assertEquals(await without.service.ownerSignInEmails(), []);
  assert((await single.service.changePassword(owner!.id, null, ADA.password)).ok);
  assertEquals(await without.service.ownerSignInEmails(), ["ada@example.com"]);
});

test("links are built on the app URL's origin, not its path", async () => {
  const { service } = await build({ multiUser: false, appUrl: "http://app.test/some/path/" });
  await service.ensureOwner({ email: "ada@example.com", name: "Ada" });
  const link = await service.mintLoginLink();
  assert(link.ok && link.link.startsWith("http://app.test/auth/login-link/"));
  const fallback = await makeAuthService({
    store: memoryAuthStore(),
    now: () => new Date(),
    multiUser: false,
  });
  await fallback.ensureOwner({ email: "ada@example.com", name: "Ada" });
  const built = await fallback.mintLoginLink("http://localhost:5173/x");
  assert(built.ok && built.link.startsWith("http://localhost:5173/auth/login-link/"));
});

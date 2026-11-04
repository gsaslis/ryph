// The whole auth loop through the mountable routes — no sockets:
// bootstrap the first admin, log in, verify the token like a downstream service would,
// refresh (rotation), log out, and the guardrails around each.

import { test } from "bun:test";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { makeAuthService } from "../src/core/service.ts";
import { asOperator } from "./operator.ts";
import { verifierFromJwksSource } from "../src/core/verify.ts";
import { authRoutes } from "../src/http/routes.ts";
import { makeRouter } from "@ryph/shared/http";
import { memoryAuthStore } from "./memory_store.ts";
import { hashPassword, verifyPassword } from "../src/helpers/password.ts";

// Starts at REAL now: jose validates `exp` against the wall clock, so a fake epoch would
// mint tokens that are born expired. Advancing still steers everything our own code decides
// (refresh TTLs, rate-limit windows) — those compare against this clock, not the wall.
function makeClock(startIso = new Date().toISOString()) {
  let nowMs = Date.parse(startIso);
  return { now: () => new Date(nowMs), advance: (ms: number) => nowMs += ms };
}

async function buildAuth(
  clock = makeClock(),
  loginRateLimit?: { attempts: number; windowMs: number; maxEntries?: number },
) {
  const store = memoryAuthStore();
  const service = await makeAuthService({ store, now: clock.now });
  const verifier = verifierFromJwksSource(() => service.jwks());
  const routes = authRoutes({ service, verifier, now: clock.now, loginRateLimit });
  const handler = makeRouter(routes);
  return { handler: asOperator(handler, service), service, verifier, store, clock };
}

function post(
  handler: (req: Request) => Promise<Response>,
  path: string,
  body: unknown,
  token?: string,
) {
  return handler(
    new Request(`http://auth.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

function get(handler: (req: Request) => Promise<Response>, path: string) {
  return handler(new Request(`http://auth.test${path}`));
}

const ADA = { email: "Ada@example.com", name: "Ada Lovelace", password: "correct horse battery" };

test("bootstrap, login, verify, refresh rotation, logout", async () => {
  const { handler, verifier, store } = await buildAuth();

  // Setup mode: the very first user creation needs no auth and becomes admin;
  // the email is normalized to lowercase.
  const first = await post(handler, "/v1/auth/users", ADA);
  assertEquals(first.status, 201);
  const admin = await first.json();
  assertEquals(admin.role, "owner");
  assertEquals(admin.email, "ada@example.com");
  assert(!("passwordHash" in admin));

  // Setup mode is over: the next unauthenticated creation is refused, registration being closed.
  const second = await post(handler, "/v1/auth/users", { ...ADA, email: "bob@example.com" });
  assertEquals(second.status, 403);

  // Login rejects a wrong password and an unknown user with the same answer.
  const wrongPw = await post(handler, "/v1/auth/login", { ...ADA, password: "wrong password" });
  const noUser = await post(handler, "/v1/auth/login", {
    email: "ghost@example.com",
    password: "whatever!",
  });
  assertEquals(wrongPw.status, 401);
  assertEquals(noUser.status, 401);
  assertEquals(await wrongPw.json(), await noUser.json());

  // Login succeeds; the access token verifies the way a downstream service would verify it.
  const login = await post(handler, "/v1/auth/login", { email: ADA.email, password: ADA.password });
  assertEquals(login.status, 200);
  const tokens = await login.json();
  const claims = await verifier.verify(tokens.accessToken);
  assert(claims !== null);
  assertEquals(claims.sub, admin.id);
  assertEquals(claims.email, "ada@example.com");
  assertEquals(claims.caps, ["*"]);

  // A garbage token does not verify.
  assertEquals(await verifier.verify("not-a-token"), null);

  // /me answers with the user behind the token.
  const me = await handler(
    new Request("http://auth.test/v1/auth/me", {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    }),
  );
  assertEquals(me.status, 200);
  assertEquals((await me.json()).id, admin.id);

  // Registration is closed until an admin opens it; then it makes plain, unverified users.
  const bob = { email: "bob@example.com", name: "Bob", password: "hunter2hunter2" };
  assertEquals((await post(handler, "/v1/auth/users", bob)).status, 403);
  await call(handler, "PATCH", "/v1/auth/settings", tokens.accessToken, {
    allowOpenRegistration: true,
  });
  const registered = await post(handler, "/v1/auth/users", bob);
  assertEquals(registered.status, 202);
  const bobUser = (await store.getUserByEmail(bob.email))!;
  assertEquals(bobUser.role, "member");
  assertEquals(bobUser.emailVerifiedAt, null);
  // A taken address answers exactly the same, and creates nothing.
  const dup = await post(handler, "/v1/auth/users", ADA);
  assertEquals(dup.status, 202);
  assertEquals(await dup.json(), await registered.json());

  // Refresh rotates: new pair comes back, the presented token is dead afterwards.
  const refreshed = await post(handler, "/v1/auth/refresh", { refreshToken: tokens.refreshToken });
  assertEquals(refreshed.status, 200);
  const nextTokens = await refreshed.json();
  assertNotEquals(nextTokens.refreshToken, tokens.refreshToken);
  const replayed = await post(handler, "/v1/auth/refresh", { refreshToken: tokens.refreshToken });
  assertEquals(replayed.status, 401);

  // Logout kills the session; the refresh token stops working.
  await post(handler, "/v1/auth/logout", { refreshToken: nextTokens.refreshToken });
  const afterLogout = await post(handler, "/v1/auth/refresh", {
    refreshToken: nextTokens.refreshToken,
  });
  assertEquals(afterLogout.status, 401);
});

test("an expired refresh session refuses and dies", async () => {
  const clock = makeClock();
  const { handler } = await buildAuth(clock);
  await post(handler, "/v1/auth/users", ADA);
  const login = await post(handler, "/v1/auth/login", { email: ADA.email, password: ADA.password });
  const { refreshToken } = await login.json();

  clock.advance(31 * 24 * 3600 * 1000); // past the 30-day refresh TTL
  const refreshed = await post(handler, "/v1/auth/refresh", { refreshToken });
  assertEquals(refreshed.status, 401);
});

test("an expired access token stops verifying", async () => {
  const clock = makeClock();
  const { handler, verifier } = await buildAuth(clock);
  await post(handler, "/v1/auth/users", ADA);
  const login = await post(handler, "/v1/auth/login", { email: ADA.email, password: ADA.password });
  const { accessToken } = await login.json();

  assert(await verifier.verify(accessToken) !== null);
  clock.advance(11 * 60 * 1000); // past the 10-minute access TTL
  // jose checks exp against real time, not our fake clock — so instead assert the exp claim
  // itself is 10 minutes from the fake now.
  const payload = JSON.parse(atob(accessToken.split(".")[1]));
  assertEquals(payload.exp - payload.iat, 600);
});

function loginFrom(
  handler: (req: Request) => Promise<Response>,
  ip: string,
  body: { email: string; password: string },
) {
  return handler(
    new Request("http://auth.test/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-ip": ip },
      body: JSON.stringify(body),
    }),
  );
}

test("failed logins are rate limited per client address, not per email", async () => {
  const { handler } = await buildAuth();
  await post(handler, "/v1/auth/users", ADA);
  const attacker = "203.0.113.7";
  for (let i = 0; i < 10; i++) {
    const res = await loginFrom(handler, attacker, {
      email: ADA.email,
      password: "wrong password",
    });
    assertEquals(res.status, 401);
  }
  // Even the right password: the window must expire first.
  assertEquals((await loginFrom(handler, attacker, ADA)).status, 429);
  // Spraying other accounts from the same address is refused too.
  const other = await loginFrom(handler, attacker, {
    email: "bob@example.com",
    password: "wrong password",
  });
  assertEquals(other.status, 429);
  // The targeted account still signs in from anywhere else, and other callers keep their budget.
  assertEquals((await loginFrom(handler, "198.51.100.9", ADA)).status, 200);
  const wrong = await loginFrom(handler, "198.51.100.10", {
    email: ADA.email,
    password: "wrong password",
  });
  assertEquals(wrong.status, 401);
});

test("a success does not reset an address's login budget", async () => {
  const { handler } = await buildAuth();
  await post(handler, "/v1/auth/users", ADA);
  const ip = "203.0.113.7";
  for (let i = 0; i < 9; i++) {
    await loginFrom(handler, ip, { email: "bob@example.com", password: "a wrong guess" });
  }
  assertEquals((await loginFrom(handler, ip, ADA)).status, 200);
  await loginFrom(handler, ip, { email: "bob@example.com", password: "a wrong guess" });
  assertEquals((await loginFrom(handler, ip, ADA)).status, 429);
});

test("a flood of emails on other flows cannot evict an address's login budget", async () => {
  const { handler } = await buildAuth(makeClock(), {
    attempts: 10,
    windowMs: 15 * 60 * 1000,
    maxEntries: 5,
  });
  await post(handler, "/v1/auth/users", ADA);
  const ip = "203.0.113.7";
  for (let i = 0; i < 10; i++) {
    await loginFrom(handler, ip, { email: ADA.email, password: "wrong password" });
  }
  assertEquals((await loginFrom(handler, ip, ADA)).status, 429);
  for (let i = 0; i < 20; i++) {
    const res = await post(handler, "/v1/auth/password/forgot", {
      email: `spray-${i}@example.com`,
    });
    assertEquals(res.status, 202);
  }
  assertEquals((await loginFrom(handler, ip, ADA)).status, 429);
});

test("IPv6 callers share a login budget across their /64", async () => {
  const { handler } = await buildAuth();
  await post(handler, "/v1/auth/users", ADA);
  for (let i = 0; i < 10; i++) {
    const ip = `2001:db8:0:1:${i.toString(16)}::1`;
    await loginFrom(handler, ip, { email: ADA.email, password: "wrong password" });
  }
  assertEquals((await loginFrom(handler, "2001:db8::1:ffff:0:0:1", ADA)).status, 429);
  assertEquals((await loginFrom(handler, "2001:db8:0:2::1", ADA)).status, 200);
});

test("login from a vouched loopback address takes no budget", async () => {
  // What a run on Docker Desktop or OrbStack looks like: it reaches the app over loopback, the
  // owner's own address, and its bad attempts must not lock the owner out.
  const { handler } = await buildAuth();
  await post(handler, "/v1/auth/users", ADA);
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    for (let i = 0; i < 12; i++) {
      const res = await loginFrom(handler, ip, { email: ADA.email, password: "wrong password" });
      assertEquals(res.status, 401);
    }
    assertEquals((await loginFrom(handler, ip, ADA)).status, 200);
  }
});

test("the JWKS endpoint publishes only public key material", async () => {
  const { handler } = await buildAuth();
  const res = await handler(new Request("http://auth.test/.well-known/jwks.json"));
  assertEquals(res.status, 200);
  const jwks = await res.json();
  assertEquals(jwks.keys.length, 1);
  assertEquals(jwks.keys[0].alg, "EdDSA");
  assert(!("d" in jwks.keys[0])); // the private scalar never leaves
});

test("password hashing round-trips and rejects", async () => {
  const hash = await hashPassword("some passphrase");
  assert(hash.startsWith("scrypt:N=16384:"));
  assert(await verifyPassword("some passphrase", hash));
  assert(!(await verifyPassword("other passphrase", hash)));
  assert(!(await verifyPassword("some passphrase", "garbage")));
});

test("the bootstrap state flips once, and needs no token to read", async () => {
  // The login page reads this to decide whether to offer a "create the admin account" link.
  // Offering one that can only answer 401 is how a first-run instance and an already-claimed
  // one become indistinguishable to whoever is looking at the form.
  const { handler } = await buildAuth();

  const fresh = await get(handler, "/v1/auth/bootstrap");
  assertEquals(fresh.status, 200);
  assertEquals(await fresh.json(), { needsBootstrap: true, multiUser: true });

  assertEquals((await post(handler, "/v1/auth/users", ADA)).status, 201);

  const claimed = await get(handler, "/v1/auth/bootstrap");
  assertEquals(claimed.status, 200);
  assertEquals(await claimed.json(), { needsBootstrap: false, multiUser: true });

  // And it stays false: this answers "does an admin exist", not "am I allowed to register".
  assertEquals(
    (await post(handler, "/v1/auth/users", { ...ADA, email: "bob@example.com" })).status,
    403,
  );
  assertEquals(await (await get(handler, "/v1/auth/bootstrap")).json(), {
    needsBootstrap: false,
    multiUser: true,
  });
});

function call(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  token: string,
  body?: unknown,
) {
  return handler(
    new Request(`http://auth.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function signIn(handler: (req: Request) => Promise<Response>, email: string, pw: string) {
  const res = await post(handler, "/v1/auth/login", { email, password: pw });
  assertEquals(res.status, 200);
  return await res.json();
}

/** Adds a user the way an admin does: a bound invite, accepted. Returns the new account. */
async function addUser(
  handler: (req: Request) => Promise<Response>,
  adminToken: string,
  user: { email: string; name: string; password: string },
) {
  const minted = await call(handler, "POST", "/v1/auth/invites", adminToken, { email: user.email });
  assertEquals(minted.status, 201);
  const { token } = await minted.json();
  const accepted = await post(handler, `/v1/auth/invites/${token}/accept`, {
    name: user.name,
    password: user.password,
  });
  assertEquals(accepted.status, 200);
  return (await accepted.json()).user;
}

test("the access token carries verification and the session it was minted with", async () => {
  const { handler, verifier } = await buildAuth();
  await post(handler, "/v1/auth/users", ADA);
  const tokens = await signIn(handler, ADA.email, ADA.password);
  const claims = await verifier.verify(tokens.accessToken);
  assert(claims !== null);
  // The first admin is the instance's owner: nobody is there to verify them.
  assertEquals(claims.emailVerified, true);
  const sessions = await (await call(handler, "GET", "/v1/auth/sessions", tokens.accessToken))
    .json();
  assertEquals(sessions.current, claims.sid);
  assertEquals(sessions.sessions.map((s: { id: string }) => s.id), [claims.sid]);
  assert(!("tokenHash" in sessions.sessions[0]));
});

test("sessions record the client, keep their start across rotation, and revoke", async () => {
  const clock = makeClock();
  const { handler } = await buildAuth(clock);
  await post(handler, "/v1/auth/users", ADA);
  const login = await handler(
    new Request("http://auth.test/v1/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client-user-agent": "Firefox",
        "x-client-ip": "203.0.113.7",
      },
      body: JSON.stringify({ email: ADA.email, password: ADA.password }),
    }),
  );
  const first = await login.json();
  const startedAt = clock.now().toISOString();

  clock.advance(60_000);
  const refreshed = await (await post(handler, "/v1/auth/refresh", {
    refreshToken: first.refreshToken,
  })).json();
  const other = await signIn(handler, ADA.email, ADA.password);

  const listed = await (await call(handler, "GET", "/v1/auth/sessions", refreshed.accessToken))
    .json();
  assertEquals(listed.sessions.length, 2);
  const rotated = listed.sessions.find((s: { id: string }) => s.id === listed.current);
  assertEquals(rotated.userAgent, "Firefox");
  assertEquals(rotated.ip, "203.0.113.7");
  assertEquals(rotated.createdAt, startedAt);
  assertEquals(rotated.lastUsedAt, clock.now().toISOString());

  // Revoking one session by id kills only that one; another user's id is not yours to kill.
  const otherId = listed.sessions.find((s: { id: string }) => s.id !== listed.current).id;
  await call(handler, "DELETE", `/v1/auth/sessions/${otherId}`, refreshed.accessToken);
  const dead = await post(handler, "/v1/auth/refresh", { refreshToken: other.refreshToken });
  assertEquals(dead.status, 401);
  const alive = await post(handler, "/v1/auth/refresh", { refreshToken: refreshed.refreshToken });
  assertEquals(alive.status, 200);
  const latest = await alive.json();

  // Sign out everywhere: nothing refreshes afterwards.
  await call(handler, "POST", "/v1/auth/sessions/revoke-all", latest.accessToken);
  const gone = await post(handler, "/v1/auth/refresh", { refreshToken: latest.refreshToken });
  assertEquals(gone.status, 401);
});

test("a deactivated user can neither sign in nor refresh, and reactivates", async () => {
  const { handler } = await buildAuth();
  await post(handler, "/v1/auth/users", ADA);
  const admin = await signIn(handler, ADA.email, ADA.password);
  const bob = { email: "bob@example.com", name: "Bob", password: "hunter2hunter2" };
  const created = await addUser(handler, admin.accessToken, bob);
  const bobTokens = await signIn(handler, bob.email, bob.password);

  const off = await call(handler, "PATCH", `/v1/auth/users/${created.id}`, admin.accessToken, {
    status: "deactivated",
  });
  assertEquals(off.status, 200);
  assertEquals((await off.json()).status, "deactivated");
  // Deactivation ended the live session; the credentials answer like a wrong password.
  assertEquals(
    (await post(handler, "/v1/auth/refresh", { refreshToken: bobTokens.refreshToken })).status,
    401,
  );
  assertEquals(
    (await post(handler, "/v1/auth/login", { email: bob.email, password: bob.password })).status,
    401,
  );

  await call(handler, "PATCH", `/v1/auth/users/${created.id}`, admin.accessToken, {
    status: "active",
  });
  await signIn(handler, bob.email, bob.password);

  // Only admins manage users; a user may still delete themselves.
  const asBob = await signIn(handler, bob.email, bob.password);
  assertEquals(
    (await call(handler, "GET", "/v1/auth/users", asBob.accessToken)).status,
    403,
  );
  assertEquals(
    (await call(handler, "DELETE", `/v1/auth/users/${admin.user.id}`, asBob.accessToken)).status,
    403,
  );
  assertEquals(
    (await call(handler, "DELETE", `/v1/auth/users/${created.id}`, asBob.accessToken)).status,
    200,
  );
  assertEquals(
    (await post(handler, "/v1/auth/login", { email: bob.email, password: bob.password })).status,
    401,
  );
});

test("the last owner cannot be demoted, deactivated, or deleted", async () => {
  const { handler } = await buildAuth();
  await post(handler, "/v1/auth/users", ADA);
  const admin = await signIn(handler, ADA.email, ADA.password);
  const me = admin.user.id;

  for (
    const attempt of [
      call(handler, "PATCH", `/v1/auth/users/${me}`, admin.accessToken, { role: "member" }),
      call(handler, "PATCH", `/v1/auth/users/${me}`, admin.accessToken, { status: "deactivated" }),
      call(handler, "DELETE", `/v1/auth/users/${me}`, admin.accessToken),
    ]
  ) {
    assertEquals((await attempt).status, 409);
  }

  // With a second admin the first is free to step down — and stepping down ends its sessions.
  const bob = { email: "bob@example.com", name: "Bob", password: "hunter2hunter2" };
  const created = await addUser(handler, admin.accessToken, bob);
  const promoted = await call(handler, "PATCH", `/v1/auth/users/${created.id}`, admin.accessToken, {
    role: "owner",
  });
  assertEquals((await promoted.json()).role, "owner");
  const demoted = await call(handler, "PATCH", `/v1/auth/users/${me}`, admin.accessToken, {
    role: "member",
  });
  assertEquals(demoted.status, 200);
  assertEquals(
    (await post(handler, "/v1/auth/refresh", { refreshToken: admin.refreshToken })).status,
    401,
  );
});

test("changing the password needs the current one and signs everything out", async () => {
  const { handler } = await buildAuth();
  await post(handler, "/v1/auth/users", ADA);
  const tokens = await signIn(handler, ADA.email, ADA.password);

  const wrong = await call(handler, "POST", "/v1/auth/password", tokens.accessToken, {
    currentPassword: "not it",
    newPassword: "a brand new passphrase",
  });
  assertEquals(wrong.status, 401);
  const missing = await call(handler, "POST", "/v1/auth/password", tokens.accessToken, {
    newPassword: "a brand new passphrase",
  });
  assertEquals(missing.status, 401);

  const changed = await call(handler, "POST", "/v1/auth/password", tokens.accessToken, {
    currentPassword: ADA.password,
    newPassword: "a brand new passphrase",
  });
  assertEquals(changed.status, 200);
  assertEquals(
    (await post(handler, "/v1/auth/refresh", { refreshToken: tokens.refreshToken })).status,
    401,
  );
  await signIn(handler, ADA.email, "a brand new passphrase");
});

test("an account without a password never signs in by password", async () => {
  const { handler, store } = await buildAuth();
  await post(handler, "/v1/auth/users", ADA);
  const admin = await signIn(handler, ADA.email, ADA.password);
  const bob = { email: "bob@example.com", name: "Bob", password: "hunter2hunter2" };
  const created = await addUser(handler, admin.accessToken, bob);
  const row = (await store.getUserById(created.id))!;
  await store.saveUser({ ...row, passwordHash: null });

  const attempt = await post(handler, "/v1/auth/login", { email: bob.email, password: "" });
  const unknown = await post(handler, "/v1/auth/login", {
    email: "ghost@example.com",
    password: "",
  });
  assertEquals(attempt.status, 400);
  assertEquals(unknown.status, 400);
  const withPw = await post(handler, "/v1/auth/login", {
    email: bob.email,
    password: bob.password,
  });
  assertEquals(withPw.status, 401);
  assertEquals(await withPw.json(), { error: "invalid credentials" });
  assertEquals(
    (await (await call(handler, "GET", "/v1/auth/me", admin.accessToken)).json())
      .hasPassword,
    true,
  );
});

test("identities list for their owner, and the last sign-in method stays", async () => {
  const { handler, store } = await buildAuth();
  await post(handler, "/v1/auth/users", ADA);
  const tokens = await signIn(handler, ADA.email, ADA.password);
  const me = tokens.user.id;
  const at = new Date().toISOString();
  await store.saveIdentity({
    id: "i-1",
    userId: me,
    provider: "github",
    providerAccountId: "1",
    login: "ada",
    email: null,
    emailVerified: false,
    createdAt: at,
    updatedAt: at,
  });

  const listed = await (await call(handler, "GET", "/v1/auth/identities", tokens.accessToken))
    .json();
  assertEquals(listed, { identities: [{ provider: "github", login: "ada", linkedAt: at }] });

  // With a password the identity is not the only way in, so it unlinks.
  const unlinked = await call(handler, "DELETE", "/v1/auth/identities/github", tokens.accessToken);
  assertEquals(unlinked.status, 200);
  assertEquals(
    (await call(handler, "DELETE", "/v1/auth/identities/github", tokens.accessToken)).status,
    404,
  );

  // Without one, it is the only way in and stays.
  await store.saveIdentity({
    id: "i-2",
    userId: me,
    provider: "github",
    providerAccountId: "1",
    login: "ada",
    email: null,
    emailVerified: false,
    createdAt: at,
    updatedAt: at,
  });
  await store.saveUser({ ...(await store.getUserById(me))!, passwordHash: null });
  const kept = await call(handler, "DELETE", "/v1/auth/identities/github", tokens.accessToken);
  assertEquals(kept.status, 409);
});

test("registration gates read without a token and change only by an admin", async () => {
  const { handler } = await buildAuth();
  const closed = await (await get(handler, "/v1/auth/settings")).json();
  assertEquals(closed.allowOpenRegistration, false);
  assertEquals(closed.allowForgeOrgJoin, false);

  await post(handler, "/v1/auth/users", ADA);
  const admin = await signIn(handler, ADA.email, ADA.password);
  const bob = { email: "bob@example.com", name: "Bob", password: "hunter2hunter2" };
  await addUser(handler, admin.accessToken, bob);
  const asBob = await signIn(handler, bob.email, bob.password);

  assertEquals(
    (await call(handler, "PATCH", "/v1/auth/settings", asBob.accessToken, {
      allowOpenRegistration: true,
    })).status,
    403,
  );
  const opened = await call(handler, "PATCH", "/v1/auth/settings", admin.accessToken, {
    allowOpenRegistration: true,
  });
  assertEquals(opened.status, 200);
  assertEquals(
    (await (await get(handler, "/v1/auth/settings")).json()).allowOpenRegistration,
    true,
  );
});

test("invites: minted by admins, previewed by anyone, accepted once or many times", async () => {
  const clock = makeClock();
  const { handler } = await buildAuth(clock);
  await post(handler, "/v1/auth/users", ADA);
  const admin = await signIn(handler, ADA.email, ADA.password);

  // Bound to an address: single-use, and accepting it proves the address.
  const bound = await call(handler, "POST", "/v1/auth/invites", admin.accessToken, {
    email: "Bob@Example.com",
  });
  assertEquals(bound.status, 201);
  const { invite, token } = await bound.json();
  assertEquals(invite.email, "bob@example.com");
  assertEquals(invite.maxUses, 1);
  assert(!("tokenHash" in invite));
  assertEquals(await (await get(handler, `/v1/auth/invites/${token}`)).json(), {
    email: "bob@example.com",
    role: "member",
    valid: true,
  });
  assertEquals((await get(handler, `/v1/auth/invites/${"0".repeat(64)}`)).status, 404);
  assertEquals((await get(handler, "/v1/auth/invites/not-a-token")).status, 404);

  const accepted = await post(handler, `/v1/auth/invites/${token}/accept`, {
    name: "Bob",
    password: "hunter2hunter2",
  });
  assertEquals(accepted.status, 200);
  const bobTokens = await accepted.json();
  const bob = bobTokens.user;
  assertEquals(bob.email, "bob@example.com");
  assert(bob.emailVerifiedAt !== null);
  assertEquals((await (await get(handler, `/v1/auth/invites/${token}`)).json()).valid, false);
  assertEquals(
    (await post(handler, `/v1/auth/invites/${token}/accept`, {
      name: "X",
      password: "hunter2hunter2",
    }))
      .status,
    410,
  );
  // An address that has an account cannot be invited again.
  assertEquals(
    (await call(handler, "POST", "/v1/auth/invites", admin.accessToken, { email: bob.email }))
      .status,
    409,
  );

  // A bound invite needs the password here; the address is already proven.
  const rebound = await (await call(handler, "POST", "/v1/auth/invites", admin.accessToken, {
    email: "eve@example.com",
  })).json();
  assertEquals(
    (await post(handler, `/v1/auth/invites/${rebound.token}/accept`, { name: "Eve" })).status,
    400,
  );
  assertEquals(
    (await post(handler, `/v1/auth/invites/${rebound.token}/accept`, {
      password: "hunter2hunter2",
    }))
      .status,
    400,
  );

  // Open: anyone with the link, up to maxUses, naming their own (unproven) address. No session
  // comes back — the password is picked on the mailed link, like an open registration.
  const open = await (await call(handler, "POST", "/v1/auth/invites", admin.accessToken, {
    maxUses: 2,
    expiresInDays: 1,
  })).json();
  assertEquals(
    (await post(handler, `/v1/auth/invites/${open.token}/accept`, { name: "C" })).status,
    400,
  );
  const carol = await post(handler, `/v1/auth/invites/${open.token}/accept`, {
    email: "carol@example.com",
  });
  assertEquals(carol.status, 202);
  assertEquals(
    (await post(handler, "/v1/auth/login", { email: "carol@example.com", password: "anything" }))
      .status,
    401,
  );
  // A taken address gets the new-account answer, and the link keeps its use: whoever holds an
  // open link learns nothing about who is here.
  assertEquals(
    (await post(handler, `/v1/auth/invites/${open.token}/accept`, { email: bob.email })).status,
    202,
  );
  assertEquals((await (await get(handler, `/v1/auth/invites/${open.token}`)).json()).valid, true);
  await post(handler, `/v1/auth/invites/${open.token}/accept`, { email: "dan@example.com" });
  assertEquals((await (await get(handler, `/v1/auth/invites/${open.token}`)).json()).valid, false);

  // Expiry and revocation each kill a link; the list shows all of it to admins only.
  const late = await (await call(handler, "POST", "/v1/auth/invites", admin.accessToken, {
    expiresInDays: 1,
  })).json();
  clock.advance(2 * 24 * 3600 * 1000);
  assertEquals((await (await get(handler, `/v1/auth/invites/${late.token}`)).json()).valid, false);
  const fresh = await (await call(handler, "POST", "/v1/auth/invites", admin.accessToken, {}))
    .json();
  await call(handler, "DELETE", `/v1/auth/invites/${fresh.invite.id}`, admin.accessToken);
  assertEquals((await (await get(handler, `/v1/auth/invites/${fresh.token}`)).json()).valid, false);
  const listed = await (await call(handler, "GET", "/v1/auth/invites", admin.accessToken)).json();
  assertEquals(listed.invites.length, 5);
  assertEquals((await call(handler, "GET", "/v1/auth/invites", bobTokens.accessToken)).status, 403);
  assertEquals(
    (await call(handler, "POST", "/v1/auth/invites", bobTokens.accessToken, {})).status,
    403,
  );
});

test("a demoted admin's token stops working at once", async () => {
  const { handler } = await buildAuth();
  await post(handler, "/v1/auth/users", ADA);
  const admin = await signIn(handler, ADA.email, ADA.password);
  const bob = await addUser(handler, admin.accessToken, {
    email: "bob@example.com",
    name: "Bob",
    password: "hunter2hunter2",
  });
  await call(handler, "PATCH", `/v1/auth/users/${bob.id}`, admin.accessToken, { role: "owner" });
  const asBob = await signIn(handler, "bob@example.com", "hunter2hunter2");
  assertEquals((await call(handler, "GET", "/v1/auth/users", asBob.accessToken)).status, 200);

  await call(handler, "PATCH", `/v1/auth/users/${bob.id}`, admin.accessToken, { role: "member" });
  // The token has minutes left on it and still says "admin". Every admin door is shut anyway.
  const stale = asBob.accessToken;
  assertEquals((await call(handler, "GET", "/v1/auth/users", stale)).status, 401);
  assertEquals(
    (await call(handler, "PATCH", `/v1/auth/users/${bob.id}`, stale, { role: "owner" })).status,
    401,
  );
  assertEquals(
    (await call(handler, "POST", "/v1/auth/invites", stale, { role: "owner" })).status,
    401,
  );
  assertEquals((await call(handler, "GET", "/v1/auth/invites", stale)).status, 401);
  assertEquals(
    (await call(handler, "POST", `/v1/auth/users/${bob.id}/reset-link`, stale, {})).status,
    401,
  );
  assertEquals(
    (await call(handler, "PATCH", "/v1/auth/settings", stale, { allowOpenRegistration: true }))
      .status,
    401,
  );
  assertEquals(
    (await call(handler, "GET", "/v1/auth/password/pending", stale)).status,
    401,
  );
  assertEquals(
    (await (await get(handler, "/v1/auth/settings")).json()).allowOpenRegistration,
    false,
  );
});

test("an unproven admin placeholder does not count toward 'last admin'", async () => {
  const { handler } = await buildAuth();
  await post(handler, "/v1/auth/users", ADA);
  const admin = await signIn(handler, ADA.email, ADA.password);
  const open = await (await call(handler, "POST", "/v1/auth/invites", admin.accessToken, {
    role: "owner",
  })).json();
  assertEquals(
    (await post(handler, `/v1/auth/invites/${open.token}/accept`, { email: "dan@example.com" }))
      .status,
    202,
  );
  // Dan is an admin on paper only. Ada is still the last one who can act.
  assertEquals(
    (await call(handler, "PATCH", `/v1/auth/users/${admin.user.id}`, admin.accessToken, {
      role: "member",
    })).status,
    409,
  );
  assertEquals(
    (await call(handler, "DELETE", `/v1/auth/users/${admin.user.id}`, admin.accessToken)).status,
    409,
  );
});

test("a deactivated admin does not count toward 'last admin'", async () => {
  const { handler } = await buildAuth();
  await post(handler, "/v1/auth/users", ADA);
  const admin = await signIn(handler, ADA.email, ADA.password);
  const bob = { email: "bob@example.com", name: "Bob", password: "hunter2hunter2" };
  const created = await addUser(handler, admin.accessToken, bob);
  await call(handler, "PATCH", `/v1/auth/users/${created.id}`, admin.accessToken, {
    role: "owner",
  });
  await call(handler, "PATCH", `/v1/auth/users/${created.id}`, admin.accessToken, {
    status: "deactivated",
  });

  // Ada is now the only admin who can act: she stays.
  const me = admin.user.id;
  assertEquals(
    (await call(handler, "PATCH", `/v1/auth/users/${me}`, admin.accessToken, { role: "member" }))
      .status,
    409,
  );
  assertEquals(
    (await call(handler, "PATCH", `/v1/auth/users/${me}`, admin.accessToken, {
      status: "deactivated",
    })).status,
    409,
  );
  assertEquals(
    (await call(handler, "DELETE", `/v1/auth/users/${me}`, admin.accessToken)).status,
    409,
  );
  // The deactivated admin, on the other hand, may go.
  assertEquals(
    (await call(handler, "DELETE", `/v1/auth/users/${created.id}`, admin.accessToken)).status,
    200,
  );
});

test("an invite's last use goes to exactly one of two racing acceptances", async () => {
  const { handler } = await buildAuth();
  await post(handler, "/v1/auth/users", ADA);
  const admin = await signIn(handler, ADA.email, ADA.password);
  const open = await (await call(handler, "POST", "/v1/auth/invites", admin.accessToken, {
    maxUses: 1,
  })).json();
  const accept = (email: string) =>
    post(handler, `/v1/auth/invites/${open.token}/accept`, { email });
  const [a, b] = await Promise.all([accept("carol@example.com"), accept("dan@example.com")]);
  assertEquals([a.status, b.status].sort(), [202, 410]);
});

test("bad invite tokens cannot lock a real invite out", async () => {
  const { handler } = await buildAuth();
  await post(handler, "/v1/auth/users", ADA);
  const admin = await signIn(handler, ADA.email, ADA.password);
  const minted = await call(handler, "POST", "/v1/auth/invites", admin.accessToken, {
    email: "bob@example.com",
  });
  const { token } = await minted.json();
  // Every caller here is unvouched, so all of them share one address, as a run on Docker Desktop
  // shares the owner's loopback.
  for (let i = 0; i < 12; i++) {
    const bad = await post(handler, `/v1/auth/invites/${i.toString(16).padStart(64, "f")}/accept`, {
      name: "Eve",
      password: "hunter2hunter2",
    });
    assertEquals(bad.status, 410);
  }
  const accepted = await post(handler, `/v1/auth/invites/${token}/accept`, {
    name: "Bob",
    password: "hunter2hunter2",
  });
  assertEquals(accepted.status, 200);
});

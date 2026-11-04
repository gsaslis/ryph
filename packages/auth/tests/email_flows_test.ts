// Verification and password reset over a recording mailer, and the same flows with no mailer
// at all — where every link ends up on an admin's screen instead.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { makeAuthService } from "../src/core/service.ts";
import { asOperator } from "./operator.ts";
import { verifierFromJwksSource } from "../src/core/verify.ts";
import { authRoutes } from "../src/http/routes.ts";
import { makeRouter } from "@ryph/shared/http";
import type { Mail, Mailer } from "../src/ports/mailer.ts";
import { memoryAuthStore } from "./memory_store.ts";

function makeClock(startIso = new Date().toISOString()) {
  let nowMs = Date.parse(startIso);
  return { now: () => new Date(nowMs), advance: (ms: number) => nowMs += ms };
}

function recordingMailer() {
  const sent: Mail[] = [];
  const mailer: Mailer = {
    send(mail) {
      sent.push(mail);
      return Promise.resolve();
    },
  };
  return { mailer, sent };
}

/** The secret out of a mailed link: the last path segment. */
const tokenIn = (mail: Mail): string => mail.text.match(/\/([0-9a-f]{64})/)![1];

async function build(opts: { mailer?: Mailer | null; clock?: ReturnType<typeof makeClock> } = {}) {
  const store = memoryAuthStore();
  const clock = opts.clock ?? makeClock();
  const service = await makeAuthService({
    store,
    now: clock.now,
    mailer: opts.mailer ?? null,
    appUrl: "https://ryph.example/",
  });
  const verifier = verifierFromJwksSource(() => service.jwks());
  const routes = authRoutes({ service, verifier, now: clock.now });
  const handler = makeRouter(routes);
  return { handler: asOperator(handler, service), service, store, clock };
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
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

const ADA = { email: "ada@example.com", name: "Ada", password: "correct horse battery" };
const BOB = { email: "bob@example.com", name: "Bob", password: "hunter2hunter2" };

async function admin(handler: (req: Request) => Promise<Response>) {
  await call(handler, "POST", "/v1/auth/users", ADA);
  return await (await call(handler, "POST", "/v1/auth/login", {
    email: ADA.email,
    password: ADA.password,
  })).json();
}

/** Bob, a verified member: open registration and his link. His mail is the next one sent. */
async function member(
  handler: (req: Request) => Promise<Response>,
  service: Awaited<ReturnType<typeof build>>["service"],
  sent: Mail[],
) {
  await service.updateSettings({ allowOpenRegistration: true });
  await call(handler, "POST", "/v1/auth/users", { email: BOB.email });
  return await (await call(handler, "POST", `/v1/auth/verify/${tokenIn(sent.at(-1)!)}`, {
    name: "Bob",
    password: BOB.password,
  })).json();
}

test("open registration mails a link that sets the password once and signs in", async () => {
  const { mailer, sent } = recordingMailer();
  const { handler, service, store } = await build({ mailer });
  await admin(handler);
  await service.updateSettings({ allowOpenRegistration: true });

  // Only the address is taken at sign-up: no name, no password, nothing usable until the link
  // is opened.
  assertEquals((await call(handler, "POST", "/v1/auth/users", { email: BOB.email })).status, 202);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].to, BOB.email);
  assertStringIncludes(sent[0].text, "https://ryph.example/verify-email/");
  const token = tokenIn(sent[0]);
  assertEquals((await store.getUserByEmail(BOB.email))!.passwordHash, null);
  assertEquals((await store.getUserByEmail(BOB.email))!.name, "");
  assertEquals((await call(handler, "POST", "/v1/auth/login", BOB)).status, 401);

  // Registering the same address again re-sends to its owner and says nothing to the caller;
  // a name sent along is not taken, since it is nobody's to set yet.
  assertEquals(
    (await call(handler, "POST", "/v1/auth/users", { email: BOB.email, name: "Robert" })).status,
    202,
  );
  assertEquals(sent.length, 2);
  assertEquals((await store.getUserByEmail(BOB.email))!.name, "");
  assert(!sent[1].text.includes("Robert"));
  // The older link is dead the moment a newer one exists.
  assertEquals(
    (await call(handler, "POST", `/v1/auth/verify/${token}`, {
      name: "Bob",
      password: BOB.password,
    }))
      .status,
    410,
  );
  const fresh = tokenIn(sent[1]);
  assertEquals(
    (await call(handler, "POST", `/v1/auth/verify/${fresh}`, { password: BOB.password })).status,
    400,
  );
  const verified = await call(handler, "POST", `/v1/auth/verify/${fresh}`, {
    name: "Bob",
    password: BOB.password,
  });
  assertEquals(verified.status, 200);
  const bob = await verified.json();
  assert(bob.user.emailVerifiedAt !== null);
  assertEquals(bob.user.name, "Bob");
  assertEquals(
    (await call(handler, "GET", "/v1/auth/me", undefined, bob.accessToken)).status,
    200,
  );
  assertEquals(
    (await call(handler, "POST", `/v1/auth/verify/${fresh}`, {
      name: "Bob",
      password: "x".repeat(12),
    })).status,
    410,
  );
  assertEquals((await call(handler, "POST", "/v1/auth/login", BOB)).status, 200);
  // A verified address gets nothing more.
  assertEquals((await call(handler, "POST", "/v1/auth/users", BOB)).status, 202);
  assertEquals(sent.length, 2);
});

test("forgot-password on an unproven address re-sends its verification link", async () => {
  const { mailer, sent } = recordingMailer();
  const { handler, service, store } = await build({ mailer });
  await admin(handler);
  await service.updateSettings({ allowOpenRegistration: true });
  await call(handler, "POST", "/v1/auth/users", { email: BOB.email });
  assertEquals(
    (await call(handler, "POST", "/v1/auth/password/forgot", { email: BOB.email })).status,
    202,
  );
  assertEquals(sent.length, 2);
  assertStringIncludes(sent[1].text, "/verify-email/");
  assertEquals((await store.getUserByEmail(BOB.email))!.resetRequestedAt, null);
});

test("a link spends once, even under two requests at the same moment", async () => {
  const { mailer, sent } = recordingMailer();
  const { handler, service } = await build({ mailer });
  const ada = await admin(handler);
  await service.updateSettings({ allowOpenRegistration: true });
  await call(handler, "POST", "/v1/auth/users", { email: BOB.email });
  const verify = () =>
    call(handler, "POST", `/v1/auth/verify/${tokenIn(sent[0])}`, {
      name: "Bob",
      password: BOB.password,
    });
  const [a, b] = await Promise.all([verify(), verify()]);
  assertEquals([a.status, b.status].sort(), [200, 410]);

  await call(handler, "POST", "/v1/auth/password/forgot", { email: BOB.email });
  const reset = () =>
    call(handler, "POST", `/v1/auth/password/reset/${tokenIn(sent[1])}`, {
      password: "a brand new passphrase",
    });
  const [c, d] = await Promise.all([reset(), reset()]);
  assertEquals([c.status, d.status].sort(), [200, 410]);
  assert(ada.user);
});

test("forgot-password spends its own budget, not the address's login budget", async () => {
  const { mailer } = recordingMailer();
  const { handler } = await build({ mailer });
  await admin(handler);
  for (let i = 0; i < 12; i++) {
    await call(handler, "POST", "/v1/auth/password/forgot", { email: ADA.email });
  }
  assertEquals(
    (await call(handler, "POST", "/v1/auth/password/forgot", { email: ADA.email })).status,
    429,
  );
  assertEquals(
    (await call(handler, "POST", "/v1/auth/login", { email: ADA.email, password: ADA.password }))
      .status,
    200,
  );
});

test("the address's first proof strips whatever was attached before it", async () => {
  const { mailer, sent } = recordingMailer();
  const { handler, service, store } = await build({ mailer });
  await admin(handler);
  await service.updateSettings({ allowOpenRegistration: true });
  await call(handler, "POST", "/v1/auth/users", { email: BOB.email });
  const squatted = (await store.getUserByEmail(BOB.email))!;
  // Nothing can attach to an unproven account through the service; these rows stand in for any
  // path that ever could.
  await store.createSession({
    id: "s-squat",
    userId: squatted.id,
    tokenHash: "hash",
    expiresAt: "2999-01-01T00:00:00.000Z",
    createdAt: squatted.createdAt,
    userAgent: null,
    ip: null,
    lastUsedAt: null,
  });
  await store.saveIdentity({
    id: "i-squat",
    userId: squatted.id,
    provider: "github",
    providerAccountId: "666",
    login: "squatter",
    email: null,
    emailVerified: false,
    createdAt: squatted.createdAt,
    updatedAt: squatted.createdAt,
  });

  const verified = await call(handler, "POST", `/v1/auth/verify/${tokenIn(sent[0])}`, {
    name: "Bob",
    password: BOB.password,
  });
  assertEquals(verified.status, 200);
  assertEquals(await store.getSessionById("s-squat"), null);
  assertEquals(await store.listIdentitiesByUser(squatted.id), []);
  assertEquals((await store.listSessionsByUser(squatted.id)).length, 1);
});

test("forgot password mails a reset link; resetting signs everything out", async () => {
  const { mailer, sent } = recordingMailer();
  const clock = makeClock();
  const { handler, service } = await build({ mailer, clock });
  await admin(handler);
  const bob = await member(handler, service, sent);

  // Uniform: an unknown address answers exactly like a known one, and mails nothing.
  const ghost = await call(handler, "POST", "/v1/auth/password/forgot", {
    email: "ghost@example.com",
  });
  const real = await call(handler, "POST", "/v1/auth/password/forgot", {
    email: "Bob@Example.com",
  });
  assertEquals(ghost.status, 202);
  assertEquals(real.status, 202);
  assertEquals(await ghost.json(), await real.json());
  assertEquals(sent.length, 2);
  assertStringIncludes(sent[1].text, "https://ryph.example/reset-password/");
  const token = tokenIn(sent[1]);

  assertEquals(
    (await call(handler, "POST", `/v1/auth/password/reset/${token}`, { password: "short" })).status,
    400,
  );
  const reset = await call(handler, "POST", `/v1/auth/password/reset/${token}`, {
    password: "a brand new passphrase",
  });
  assertEquals(reset.status, 200);
  assertEquals(
    (await call(handler, "POST", `/v1/auth/password/reset/${token}`, { password: "again again" }))
      .status,
    410,
  );
  assertEquals(
    (await call(handler, "POST", "/v1/auth/refresh", { refreshToken: bob.refreshToken })).status,
    401,
  );
  assertEquals((await call(handler, "POST", "/v1/auth/login", BOB)).status, 401);
  assertEquals(
    (await call(handler, "POST", "/v1/auth/login", {
      email: BOB.email,
      password: "a brand new passphrase",
    })).status,
    200,
  );

  // A link past its hour is dead.
  await call(handler, "POST", "/v1/auth/password/forgot", { email: BOB.email });
  clock.advance(2 * 60 * 60 * 1000);
  assertEquals(
    (await call(handler, "POST", `/v1/auth/password/reset/${tokenIn(sent[2])}`, {
      password: "yet another passphrase",
    })).status,
    410,
  );
});

test("without a mailer, requests wait for an admin who hands over the link", async () => {
  const { handler, service, store } = await build();
  const ada = await admin(handler);
  await service.updateSettings({ allowOpenRegistration: true });
  await call(handler, "POST", "/v1/auth/users", { email: BOB.email });
  const bobRow = (await store.getUserByEmail(BOB.email))!;

  // Unproven and forgetful: the request lands on the admin's list, and the link the admin mints
  // for it is the one that sets a first password — the verification link.
  assertEquals(
    (await call(handler, "POST", "/v1/auth/password/forgot", { email: BOB.email })).status,
    202,
  );
  assertEquals(
    (await (await call(handler, "GET", "/v1/auth/password/pending", undefined, ada.accessToken))
      .json()).users.map((u: { id: string }) => u.id),
    [bobRow.id],
  );
  const asReset = await (await call(
    handler,
    "POST",
    `/v1/auth/users/${bobRow.id}/reset-link`,
    {},
    ada.accessToken,
  )).json();
  assertStringIncludes(asReset.link, "/verify-email/");
  assertEquals(
    (await (await call(handler, "GET", "/v1/auth/password/pending", undefined, ada.accessToken))
      .json()).users,
    [],
  );

  // Nothing can be sent; the admin mints the link and hands it over.
  const verifyLink = await call(
    handler,
    "POST",
    `/v1/auth/users/${bobRow.id}/verify-link`,
    {},
    ada.accessToken,
  );
  assertEquals(verifyLink.status, 201);
  const { link } = await verifyLink.json();
  const verifyToken = link.match(/\/([0-9a-f]{64})$/)![1];
  const verified = await call(handler, "POST", `/v1/auth/verify/${verifyToken}`, {
    name: BOB.name,
    password: BOB.password,
  });
  assertEquals(verified.status, 200);
  const bob = await verified.json();
  // Not an admin's to mint.
  assertEquals(
    (await call(handler, "POST", `/v1/auth/users/${bobRow.id}/verify-link`, {}, bob.accessToken))
      .status,
    403,
  );

  // A forgotten password becomes a pending request the admin can see and settle.
  assertEquals(
    (await call(handler, "POST", "/v1/auth/password/forgot", { email: BOB.email })).status,
    202,
  );
  const pending =
    await (await call(handler, "GET", "/v1/auth/password/pending", undefined, ada.accessToken))
      .json();
  assertEquals(pending.users.map((u: { id: string }) => u.id), [bobRow.id]);
  const resetLink = await (await call(
    handler,
    "POST",
    `/v1/auth/users/${bobRow.id}/reset-link`,
    {},
    ada.accessToken,
  )).json();
  const resetToken = resetLink.link.match(/\/([0-9a-f]{64})$/)![1];
  assertEquals(
    (await (await call(handler, "GET", "/v1/auth/password/pending", undefined, ada.accessToken))
      .json()).users,
    [],
  );
  assertEquals(
    (await call(handler, "POST", `/v1/auth/password/reset/${resetToken}`, {
      password: "a brand new passphrase",
    })).status,
    200,
  );
});

test("the sweep purges accounts unproven past their grace, unless a link is still live", async () => {
  const clock = makeClock();
  const { mailer } = recordingMailer();
  const { handler, service, store } = await build({ clock, mailer });
  const ada = await admin(handler);
  await service.updateSettings({ allowOpenRegistration: true });
  await call(handler, "POST", "/v1/auth/users", { email: BOB.email });
  await call(handler, "POST", "/v1/auth/users", { email: "carol@example.com" });
  // An admin placeholder from an open admin invite is unproven like any other, and goes too.
  const open = await service.createInvite(
    { email: null, role: "owner", expiresInMs: 7 * 24 * 3600 * 1000, maxUses: null },
    ada.user.id,
  );
  assert(open.ok);
  await service.acceptInvite(open.token, { email: "dan@example.com" });

  const day = 24 * 3600 * 1000;
  clock.advance(6 * day);
  assertEquals(await service.sweep(), { purgedUsers: 0 });
  // Carol asks for a fresh link on day six: her account outlives the grace while it is live.
  clock.advance(0.9 * day);
  await call(handler, "POST", "/v1/auth/users", { email: "carol@example.com" });
  clock.advance(0.2 * day);
  assertEquals(await service.sweep(), { purgedUsers: 2 });
  assertEquals(await store.getUserByEmail(BOB.email), null);
  assertEquals(await store.getUserByEmail("dan@example.com"), null);
  assert(await store.getUserByEmail("carol@example.com"));
  clock.advance(1 * day);
  assertEquals(await service.sweep(), { purgedUsers: 1 });
  assertEquals(await store.getUserByEmail("carol@example.com"), null);
  assert(await store.getUserById(ada.user.id));
});

test("a mailer that fails never fails the request, and a lost reset waits for an admin", async () => {
  const failures: unknown[] = [];
  const broken: Mailer = { send: () => Promise.reject(new Error("smtp down")) };
  const store = memoryAuthStore();
  const service = await makeAuthService({
    store,
    now: () => new Date(),
    mailer: broken,
    appUrl: "https://ryph.example",
    onMailError: (err) => failures.push(err),
  });
  await service.createUser({ ...ADA, setupToken: (await service.setupToken())! });
  await service.updateSettings({ allowOpenRegistration: true });

  // Sign-up: the account exists and the answer is the usual one.
  assertEquals((await service.createUser({ email: BOB.email })).ok, true);
  const bob = (await store.getUserByEmail(BOB.email))!;
  await store.saveUser({ ...bob, emailVerifiedAt: new Date().toISOString() });
  // Forgot: the same answer as for a stranger, and the request lands on the admin's list.
  await service.forgotPassword(BOB.email);
  await service.forgotPassword("ghost@example.com");
  // The sends were not awaited; give the rejections a turn to land.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(failures.length, 2);
  assertEquals((await service.listResetRequests()).map((u) => u.email), [BOB.email]);
});

test("bad links cannot lock real verify and reset links out", async () => {
  const { mailer, sent } = recordingMailer();
  const { handler, service } = await build({ mailer });
  await admin(handler);
  await service.updateSettings({ allowOpenRegistration: true });
  await call(handler, "POST", "/v1/auth/users", { email: BOB.email });
  // Every caller here is unvouched, so all of them share one address, as a run on Docker Desktop
  // shares the owner's loopback.
  const bogus = (i: number) => i.toString(16).padStart(64, "0");
  for (let i = 0; i < 12; i++) {
    const res = await call(handler, "POST", `/v1/auth/verify/${bogus(i)}`, {
      name: "Eve",
      password: BOB.password,
    });
    assertEquals(res.status, 410);
  }
  assertEquals(
    (await call(handler, "POST", `/v1/auth/verify/${tokenIn(sent[0])}`, {
      name: "Bob",
      password: BOB.password,
    })).status,
    200,
  );

  await call(handler, "POST", "/v1/auth/password/forgot", { email: BOB.email });
  for (let i = 0; i < 12; i++) {
    const res = await call(handler, "POST", `/v1/auth/password/reset/${bogus(i)}`, {
      password: "a brand new passphrase",
    });
    assertEquals(res.status, 410);
  }
  assertEquals(
    (await call(handler, "POST", `/v1/auth/password/reset/${tokenIn(sent[1])}`, {
      password: "a brand new passphrase",
    })).status,
    200,
  );
});

test("an owner's password is never reset by link", async () => {
  const { mailer, sent } = recordingMailer();
  const { handler, service, store } = await build({ mailer });
  const ada = await admin(handler);
  await member(handler, service, sent);
  const mailed = sent.length;

  // Forgot-password for an owner mails nothing and answers like an unknown address.
  const ghost = await call(handler, "POST", "/v1/auth/password/forgot", {
    email: "ghost@example.com",
  });
  const owner = await call(handler, "POST", "/v1/auth/password/forgot", { email: ADA.email });
  assertEquals(owner.status, ghost.status);
  assertEquals(await owner.json(), await ghost.json());
  assertEquals(sent.length, mailed);
  assertEquals((await store.getUserByEmail(ADA.email))!.resetRequestedAt, null);

  // Nor does an admin's copy exist for one.
  const adaRow = (await store.getUserByEmail(ADA.email))!;
  const minted = await call(
    handler,
    "POST",
    `/v1/auth/users/${adaRow.id}/reset-link`,
    {},
    ada.accessToken,
  );
  assertEquals(minted.status, 403);

  // A link minted before its holder became an owner does not redeem.
  await call(handler, "POST", "/v1/auth/password/forgot", { email: BOB.email });
  const token = tokenIn(sent.at(-1)!);
  const bobRow = (await store.getUserByEmail(BOB.email))!;
  await store.saveUser({ ...bobRow, role: "owner" });
  assertEquals(
    (await call(handler, "POST", `/v1/auth/password/reset/${token}`, {
      password: "a brand new passphrase",
    })).status,
    410,
  );
  assertEquals((await call(handler, "POST", "/v1/auth/login", BOB)).status, 200);

  // An owner's request from before owners were refused is not on the admin's list.
  await store.saveUser({ ...adaRow, resetRequestedAt: new Date().toISOString() });
  assertEquals(await service.listResetRequests(), []);
});

test("a verification link never takes over a proven account", async () => {
  const { mailer, sent } = recordingMailer();
  const { handler, service, store } = await build({ mailer });
  const ada = await admin(handler);
  await member(handler, service, sent);
  const adaRow = (await store.getUserByEmail(ADA.email))!;

  // An admin cannot mint one for a proven address, an owner's or anyone's.
  const bobRow = (await store.getUserByEmail(BOB.email))!;
  for (const id of [adaRow.id, bobRow.id]) {
    assertEquals(
      (await call(handler, "POST", `/v1/auth/users/${id}/verify-link`, {}, ada.accessToken))
        .status,
      409,
    );
  }

  // One minted while the address was unproven does not redeem once it is proven, and the
  // password stays as it was.
  const carol = { email: "carol@example.com", password: "carol's passphrase" };
  await call(handler, "POST", "/v1/auth/users", { email: carol.email });
  const early = tokenIn(sent.at(-1)!);
  const carolRow = (await store.getUserByEmail(carol.email))!;
  await store.saveUser({
    ...carolRow,
    name: "Carol",
    role: "owner",
    passwordHash: (await store.getUserByEmail(ADA.email))!.passwordHash,
    emailVerifiedAt: new Date().toISOString(),
  });
  assertEquals(
    (await call(handler, "POST", `/v1/auth/verify/${early}`, {
      name: "Mallory",
      password: "mallory's passphrase",
    })).status,
    410,
  );
  const after = (await store.getUserByEmail(carol.email))!;
  assertEquals(after.name, "Carol");
  assertEquals(
    (await call(handler, "POST", "/v1/auth/login", { email: carol.email, password: ADA.password }))
      .status,
    200,
  );
});

test("an unproven owner still gets the link that sets their password", async () => {
  const { mailer, sent } = recordingMailer();
  const { handler, service, store } = await build({ mailer });
  const ada = await admin(handler);
  // An open owner invite: the account waits on the mailed link, unproven.
  const invite = await service.createInvite(
    { email: null, role: "owner", expiresInMs: 3_600_000, maxUses: 1 },
    ada.user.id,
  );
  assert(invite.ok);
  await service.acceptInvite(invite.token, { email: "carol@example.com" });
  const carol = (await store.getUserByEmail("carol@example.com"))!;
  assertEquals(carol.role, "owner");
  assertEquals(carol.emailVerifiedAt, null);
  const mailed = sent.length;

  // Forgot-password re-sends the verification link, which completes the account.
  await call(handler, "POST", "/v1/auth/password/forgot", { email: carol.email });
  assertEquals(sent.length, mailed + 1);
  assertStringIncludes(sent.at(-1)!.text, "/verify-email/");
  // An admin's "reset link" for it is that link too.
  const minted = await (await call(
    handler,
    "POST",
    `/v1/auth/users/${carol.id}/reset-link`,
    {},
    ada.accessToken,
  )).json();
  assertStringIncludes(minted.link, "/verify-email/");
  const verified = await call(handler, "POST", `/v1/auth/verify/${minted.link.split("/").at(-1)}`, {
    name: "Carol",
    password: "carol's passphrase",
  });
  assertEquals(verified.status, 200);
  assert((await verified.json()).user.emailVerifiedAt !== null);
});

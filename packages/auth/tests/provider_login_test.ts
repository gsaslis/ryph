// Sign-in and linking through an identity provider, over a scripted provider double:
// the four sign-in outcomes in order (linked, matched, claimed, admitted), the refusals,
// and what linking does to a foreign account and to an unverified address.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { makeAuthService } from "../src/core/service.ts";
import { asOperator } from "./operator.ts";
import { verifierFromJwksSource } from "../src/core/verify.ts";
import { authRoutes } from "../src/http/routes.ts";
import { makeRouter } from "@ryph/shared/http";
import type {
  IdentityProvider,
  OAuthCodeLeg,
  ProviderIdentity,
  ProviderMembership,
} from "../src/ports/identity_provider.ts";
import type { Mail } from "../src/ports/mailer.ts";
import { memoryAuthStore } from "./memory_store.ts";

/** A provider whose accounts the test declares; the code IS the login. GitHub's verified
 * addresses are proof; GitLab's (when offered) are not. */
function fakeProvider(names: string[]) {
  const accounts = new Map<string, ProviderIdentity>();
  let membership: ProviderMembership = "not-member";
  /** Every leg a code was redeemed with, in order. */
  const legs: OAuthCodeLeg[] = [];
  const provider: IdentityProvider = {
    providers: () => names,
    exchangeCode(name, code, leg) {
      legs.push(leg);
      const account = accounts.get(code);
      if (!names.includes(name) || !account) return Promise.reject(new Error("bad code"));
      return Promise.resolve(structuredClone(account));
    },
    isOrgMember: () => Promise.resolve(membership),
    trustsEmails: (name) => name === "github",
  };
  return {
    provider,
    legs,
    declare(login: string, identity: Partial<ProviderIdentity> = {}) {
      accounts.set(login, {
        accountId: identity.accountId ?? `id-${login}`,
        login,
        name: identity.name ?? null,
        verifiedEmails: identity.verifiedEmails ?? [],
      });
    },
    setMembership(next: ProviderMembership) {
      membership = next;
    },
  };
}

async function build(providers = ["github"]) {
  const store = memoryAuthStore();
  const fake = fakeProvider(providers);
  const sent: Mail[] = [];
  const service = await makeAuthService({
    store,
    now: () => new Date(),
    identityProvider: fake.provider,
    mailer: {
      send(mail) {
        sent.push(mail);
        return Promise.resolve();
      },
    },
    appUrl: "https://ryph.example",
  });
  const verifier = verifierFromJwksSource(() => service.jwks());
  const routes = authRoutes({ service, verifier, now: () => new Date() });
  const handler = makeRouter(routes);
  return { handler: asOperator(handler, service), service, store, fake, verifier, sent };
}

const post = (
  handler: (req: Request) => Promise<Response>,
  path: string,
  body: unknown,
  token?: string,
) =>
  handler(
    new Request(`http://auth.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

const signIn = (handler: (req: Request) => Promise<Response>, code: string, token?: string) =>
  post(handler, "/v1/auth/oauth/github/callback", { code }, token);

const ADA = { email: "ada@example.com", name: "Ada", password: "correct horse battery" };

async function bootstrapAdmin(handler: (req: Request) => Promise<Response>) {
  await post(handler, "/v1/auth/users", ADA);
  const login = await post(handler, "/v1/auth/login", { email: ADA.email, password: ADA.password });
  return await login.json();
}

test("providers are listed, and a closed instance refuses a stranger", async () => {
  const { handler, fake } = await build();
  assertEquals(
    await (await handler(new Request("http://auth.test/v1/auth/providers"))).json(),
    { providers: ["github"] },
  );
  fake.declare("grace", { verifiedEmails: ["grace@example.com"] });
  const refused = await signIn(handler, "grace");
  assertEquals(refused.status, 403);
  assertEquals(
    (await signIn(handler, "nobody")).status,
    502,
  );
  assertEquals((await post(handler, "/v1/auth/oauth/gitlab/callback", { code: "x" })).status, 404);
});

/** A member whose address is proven through their verification link, with a password. */
async function provenMember(
  service: Awaited<ReturnType<typeof build>>["service"],
  handler: (req: Request) => Promise<Response>,
  email: string,
  name: string,
) {
  await service.updateSettings({ allowOpenRegistration: true });
  await post(handler, "/v1/auth/users", { email, name });
  await service.updateSettings({ allowOpenRegistration: false });
  const users = await service.listUsers();
  const id = users.find((u) => u.email === email)!.id;
  const mint = await service.mintVerificationLink(id);
  assert(mint.ok);
  const proven = await service.verifyEmail(mint.link.match(/\/([0-9a-f]{64})$/)![1], {
    name,
    password: "hunter2hunter2",
  });
  assert(proven.ok);
  return proven.tokens;
}

test("a verified account links by its provider-verified address, then signs in by account", async () => {
  const { handler, fake, verifier, store, service } = await build();
  await bootstrapAdmin(handler);
  await provenMember(service, handler, "grace@example.com", "Grace");
  fake.declare("grace", {
    verifiedEmails: ["other@example.com", "Grace@Example.com"],
    name: "Grace H",
  });

  const first = await signIn(handler, "grace");
  assertEquals(first.status, 200);
  const tokens = await first.json();
  const claims = await verifier.verify(tokens.accessToken);
  assertEquals(claims?.email, "grace@example.com");
  assertEquals(tokens.user.role, "member");
  const identity = await store.getIdentityByAccount("github", "id-grace");
  assertEquals(identity?.userId, tokens.user.id);
  assertEquals(identity?.login, "grace");

  // A renamed login still resolves by the stable account id, and the row follows the rename.
  fake.declare("grace-hopper", { accountId: "id-grace", verifiedEmails: [] });
  const again = await signIn(handler, "grace-hopper");
  assertEquals(again.status, 200);
  assertEquals((await store.getIdentityByAccount("github", "id-grace"))?.login, "grace-hopper");
});

test("an owner is never reached by address alone: it signs in once linked from settings", async () => {
  const { handler, fake, verifier, store, service } = await build();
  const admin = await bootstrapAdmin(handler);
  const before = (await store.getUserByEmail(ADA.email))!;
  const usersBefore = (await service.listUsers()).length;
  fake.declare("ada", { verifiedEmails: ["ada@example.com"] });

  const refused = await signIn(handler, "ada");
  assertEquals(refused.status, 409);
  assertEquals((await refused.json()).code, "link_required");
  assertEquals(await service.loginWithProvider("github", "ada"), {
    ok: false,
    error: "link-required",
  });
  // Nothing moved: no identity, no second account, the owner as it was.
  assertEquals(await store.listIdentitiesByUser(before.id), []);
  assertEquals(await store.getIdentityByAccount("github", "id-ada"), null);
  assertEquals((await service.listUsers()).length, usersBefore);
  assertEquals(await store.getUserById(before.id), before);

  // Open registration does not route around it with a second account either.
  await service.updateSettings({ allowOpenRegistration: true });
  assertEquals((await signIn(handler, "ada")).status, 409);
  assertEquals((await service.listUsers()).length, usersBefore);

  // Linked from her own session, the same login signs her in.
  assertEquals((await signIn(handler, "ada", admin.accessToken)).status, 200);
  const signedIn = await signIn(handler, "ada");
  assertEquals(signedIn.status, 200);
  const claims = await verifier.verify((await signedIn.json()).accessToken);
  assertEquals(claims?.sub, before.id);
});

test("a verified provider login claims an unverified account, and its link dies", async () => {
  const { handler, fake, store, service, sent } = await build();
  await bootstrapAdmin(handler);
  const bob = { email: "bob@example.com", name: "Bob" };
  await service.updateSettings({ allowOpenRegistration: true });
  await post(handler, "/v1/auth/users", bob);
  const squat = (await store.getUserByEmail(bob.email))!;
  await service.updateSettings({ allowOpenRegistration: false });
  assertEquals(squat.emailVerifiedAt, null);
  assertEquals(squat.passwordHash, null);
  const link = sent[0].text.match(/\/([0-9a-f]{64})/)![1];

  fake.declare("realbob", { verifiedEmails: ["bob@example.com"] });
  const claimed = await signIn(handler, "realbob");
  assertEquals(claimed.status, 200);
  assertEquals((await claimed.json()).user.id, squat.id);

  const row = (await store.getUserById(squat.id))!;
  assertEquals(row.passwordHash, null);
  assert(row.emailVerifiedAt !== null);
  // The placeholder had no name; the provider's profile fills it in.
  assertEquals(row.name, "realbob");
  // The registrant's link would have set a password on what is now Bob's account.
  assertEquals(
    (await post(handler, `/v1/auth/verify/${link}`, { name: "Bob", password: "hunter2hunter2" }))
      .status,
    410,
  );
  assertEquals(
    (await post(handler, "/v1/auth/login", { email: bob.email, password: "hunter2hunter2" }))
      .status,
    401,
  );
});

test("a link carried over by login never signs anyone in: it points at the account to link again", async () => {
  const { handler, fake, store, service } = await build();
  const admin = await bootstrapAdmin(handler);
  await service.updateSettings({ allowOpenRegistration: true });
  const at = new Date().toISOString();
  await store.saveIdentity({
    id: "i-legacy",
    userId: admin.user.id,
    provider: "github",
    providerAccountId: "login:ada",
    login: "ada",
    email: null,
    emailVerified: false,
    createdAt: at,
    updatedAt: at,
  });

  // Whoever holds the login "ada" on the provider today is not thereby Ada here, and with no
  // address in common they are not admitted as somebody new either: the row says which account
  // to sign into by password and link again.
  fake.declare("ada", { accountId: "id-ada", verifiedEmails: ["other@example.com"] });
  const pointed = await signIn(handler, "ada");
  assertEquals(pointed.status, 409);
  assertStringIncludes((await pointed.json()).error, "before the upgrade");
  assertEquals((await store.getIdentity(admin.user.id, "github"))!.providerAccountId, "login:ada");

  // Ada signs in by password and links from settings: the row learns its account id.
  assertEquals((await signIn(handler, "ada", admin.accessToken)).status, 200);
  assertEquals((await store.getIdentity(admin.user.id, "github"))!.providerAccountId, "id-ada");

  // A carried-over row on someone else, for a login the provider has since given to a newcomer,
  // goes the moment the newcomer links it: one user per login.
  await store.saveIdentity({
    id: "i-legacy-2",
    userId: "u-other",
    provider: "github",
    providerAccountId: "login:ada",
    login: "ada",
    email: null,
    emailVerified: false,
    createdAt: at,
    updatedAt: at,
  });
  fake.declare("ada", { accountId: "id-someone", verifiedEmails: ["someone@example.com"] });
  await post(handler, "/v1/auth/users", { email: "someone@example.com" });
  const someone = (await store.getUserByEmail("someone@example.com"))!;
  const mint = await service.mintVerificationLink(someone.id);
  assert(mint.ok);
  const proven = await service.verifyEmail(mint.link.match(/\/([0-9a-f]{64})$/)![1], {
    name: "Someone",
    password: "hunter2hunter2",
  });
  assert(proven.ok);
  assertEquals((await signIn(handler, "ada", proven.tokens.accessToken)).status, 200);
  assertEquals(await store.getIdentityByAccount("github", "login:ada"), null);
  assertEquals((await store.getIdentity(someone.id, "github"))!.providerAccountId, "id-someone");
});

test("the gates admit: org members when that gate is on, anyone when registration is open", async () => {
  const { handler, fake, service, store } = await build();
  await bootstrapAdmin(handler);
  fake.declare("grace", { verifiedEmails: ["grace@example.com"], name: "Grace" });
  fake.declare("linus", { verifiedEmails: ["linus@example.com"] });
  fake.declare("noemail", { verifiedEmails: [] });

  await service.updateSettings({ allowForgeOrgJoin: true });
  fake.setMembership("unknown");
  assertEquals((await signIn(handler, "grace")).status, 503);
  // Nothing installed yet: not a retry, a thing an admin has to do.
  fake.setMembership("no-organization");
  const bare = await signIn(handler, "grace");
  assertEquals(bare.status, 403);
  assertStringIncludes((await bare.json()).error, "connect the forge app");
  fake.setMembership("not-member");
  assertEquals((await signIn(handler, "grace")).status, 403);
  fake.setMembership("member");
  const joined = await signIn(handler, "grace");
  assertEquals(joined.status, 200);
  const grace = (await joined.json()).user;
  assertEquals(grace.role, "member");
  assertEquals(grace.name, "Grace");
  assertEquals(grace.hasPassword, false);
  assert(grace.emailVerifiedAt !== null);
  assertEquals((await signIn(handler, "noemail")).status, 403);

  fake.setMembership("not-member");
  await service.updateSettings({ allowForgeOrgJoin: false, allowOpenRegistration: true });
  assertEquals((await signIn(handler, "linus")).status, 200);

  // A deactivated user is refused by name, not silently re-created.
  const linus = (await store.getUserByEmail("linus@example.com"))!;
  await service.setStatus(linus.id, "deactivated");
  assertEquals((await signIn(handler, "linus")).status, 403);
});

test("linking attaches to the caller, refuses a foreign or unproven one", async () => {
  const { handler, fake, store, service } = await build();
  const admin = await bootstrapAdmin(handler);
  const bob = { email: "bob@example.com", name: "Bob" };
  await service.updateSettings({ allowOpenRegistration: true });
  await post(handler, "/v1/auth/users", bob);
  await service.updateSettings({ allowOpenRegistration: false });
  fake.declare("ada", { verifiedEmails: ["ada@example.com"] });
  fake.declare("bobby", { verifiedEmails: ["bob@example.com"] });

  const linked = await signIn(handler, "ada", admin.accessToken);
  assertEquals(linked.status, 200);
  assertEquals((await linked.json()).identity.login, "ada");
  // A bad bearer is a bad bearer, not an anonymous sign-in.
  assertEquals((await signIn(handler, "ada", "garbage")).status, 401);
  // Unproven Bob holds no session to link with; below the route, the service refuses him too —
  // even an account that vouches for his address.
  const bobRow = (await store.getUserByEmail(bob.email))!;
  assertEquals(bobRow.emailVerifiedAt, null);
  for (const code of ["ada", "bobby"]) {
    assertEquals(await service.linkProvider(bobRow.id, "github", code), {
      ok: false,
      error: "unverified",
    });
  }
  assertEquals(await store.listIdentitiesByUser(bobRow.id), []);
  assertEquals((await store.getUserByEmail(bob.email))!.emailVerifiedAt, null);

  // Proven through his link: an account that is Ada's still cannot be Bob's too.
  const mint = await service.mintVerificationLink(bobRow.id);
  assert(mint.ok);
  const proven = await service.verifyEmail(mint.link.match(/\/([0-9a-f]{64})$/)![1], {
    name: "Bob",
    password: "hunter2hunter2",
  });
  assert(proven.ok);
  assertEquals((await signIn(handler, "ada", proven.tokens.accessToken)).status, 409);
});

test("without a provider, every provider route is dark", async () => {
  const store = memoryAuthStore();
  const service = await makeAuthService({ store, now: () => new Date() });
  assertEquals(service.providers(), []);
  assertEquals(await service.loginWithProvider("github", "x"), { ok: false, error: "no-provider" });
});

test("an invite admits a provider login: a bound one only the address it names", async () => {
  const { handler, fake, service, store } = await build();
  const admin = await bootstrapAdmin(handler);
  fake.declare("grace", { verifiedEmails: ["grace@example.com"] });
  fake.declare("linus", { verifiedEmails: ["linus@example.com"] });
  const bound = await (await post(handler, "/v1/auth/invites", {
    email: "grace@example.com",
    role: "owner",
  }, admin.accessToken)).json();
  const open = await (await post(handler, "/v1/auth/invites", {}, admin.accessToken)).json();

  // Registration is closed, so the invite is what admits — and it is picky about whom.
  const wrongPerson = await post(handler, "/v1/auth/oauth/github/callback", {
    code: "linus",
    invite: bound.token,
  });
  assertEquals(wrongPerson.status, 403);
  const grace = await post(handler, "/v1/auth/oauth/github/callback", {
    code: "grace",
    invite: bound.token,
  });
  assertEquals(grace.status, 200);
  assertEquals((await grace.json()).user.role, "owner");
  // Consumed: the same link admits nobody else.
  assertEquals(
    (await post(handler, "/v1/auth/oauth/github/callback", { code: "linus", invite: bound.token }))
      .status,
    410,
  );

  const linus = await post(handler, "/v1/auth/oauth/github/callback", {
    code: "linus",
    invite: open.token,
  });
  assertEquals(linus.status, 200);
  assertEquals((await store.getUserByEmail("linus@example.com"))!.role, "member");
  assertEquals((await service.listInvites()).find((i) => i.id === open.invite.id)!.uses, 1);
});

test("a claim strips everything the registrant attached, and an unproven account attaches nothing", async () => {
  const { handler, fake, store, service } = await build();
  await bootstrapAdmin(handler);
  const bob = { email: "bob@example.com", name: "Bob" };
  await service.updateSettings({ allowOpenRegistration: true });
  await post(handler, "/v1/auth/users", bob);
  await service.updateSettings({ allowOpenRegistration: false });
  const squat = (await store.getUserByEmail(bob.email))!;

  // The registrant holds no session, and the service arms an unproven account with nothing…
  assertEquals(await service.registerPasskey(squat.id, "ch-x", { id: "x" } as never, "k"), {
    ok: false,
    error: "unverified",
  });
  fake.declare("mallory", { verifiedEmails: ["mallory@example.com"] });
  assertEquals(await service.linkProvider(squat.id, "github", "mallory"), {
    ok: false,
    error: "unverified",
  });
  assertEquals(await store.listIdentitiesByUser(squat.id), []);

  // …but suppose something did slip in below the service: the claim still removes it.
  const at = new Date().toISOString();
  await store.saveIdentity({
    id: "i-mallory",
    userId: squat.id,
    provider: "gitlab",
    providerAccountId: "m",
    login: "mallory",
    email: null,
    emailVerified: false,
    createdAt: at,
    updatedAt: at,
  });
  await store.createPasskey({
    id: "pk-mallory",
    userId: squat.id,
    publicKey: "AA",
    counter: 0,
    transports: [],
    name: "mallory's key",
    backedUp: false,
    deviceType: null,
    createdAt: at,
    lastUsedAt: null,
  });

  fake.declare("realbob", { verifiedEmails: ["bob@example.com"] });
  assertEquals((await signIn(handler, "realbob")).status, 200);
  assertEquals(await store.listPasskeysByUser(squat.id), []);
  assertEquals(
    (await store.listIdentitiesByUser(squat.id)).map((i) => i.provider),
    ["github"],
  );
  assertEquals((await store.getUserById(squat.id))!.passwordHash, null);
});

test("a token whose session is gone cannot change how one signs in", async () => {
  const { handler, fake, store, service } = await build();
  await bootstrapAdmin(handler);
  await service.updateSettings({ allowOpenRegistration: true });
  fake.declare("realbob", { verifiedEmails: ["bob@example.com"] });
  const owner = await (await signIn(handler, "realbob")).json();
  const claimed = (await store.getUserByEmail("bob@example.com"))!;
  assertEquals(claimed.passwordHash, null);

  // Sign out everywhere, with the token that did the signing out: it has minutes left on it and
  // still says "verified", and it sets nothing.
  await handler(
    new Request("http://auth.test/v1/auth/sessions/revoke-all", {
      method: "POST",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    }),
  );
  const stale = owner.accessToken;
  const withStale = (method: string, path: string, body?: unknown) =>
    handler(
      new Request(`http://auth.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${stale}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  assertEquals(
    (await withStale("POST", "/v1/auth/password", { newPassword: "mine now mine now" })).status,
    401,
  );
  assertEquals((await withStale("POST", "/v1/auth/passkeys/register/options", {})).status, 401);
  assertEquals(
    (await withStale("POST", "/v1/auth/passkeys/register/verify", {
      challengeId: "x",
      response: { id: "x" },
      name: "x",
    })).status,
    401,
  );
  fake.declare("mallory", { verifiedEmails: ["mallory@example.com"] });
  assertEquals((await signIn(handler, "mallory", stale)).status, 401);
  assertEquals((await withStale("DELETE", "/v1/auth/identities/github")).status, 401);
  assertEquals((await withStale("DELETE", `/v1/auth/users/${claimed.id}`)).status, 401);
  assertEquals((await withStale("GET", "/v1/auth/me")).status, 401);
  assertEquals((await store.getUserByEmail("bob@example.com"))!.passwordHash, null);
  assertEquals(await store.listPasskeysByUser(claimed.id), []);
  assertEquals((await store.listIdentitiesByUser(claimed.id)).map((i) => i.login), ["realbob"]);
  assert(await store.getUserById(claimed.id));
});

test("an owner invite's unproven account is still claimed by the provider proving its address", async () => {
  const { handler, fake, store } = await build();
  const admin = await bootstrapAdmin(handler);
  const open = await (await post(handler, "/v1/auth/invites", { role: "owner" }, admin.accessToken))
    .json();
  assertEquals(
    (await post(handler, `/v1/auth/invites/${open.token}/accept`, { email: "grace@example.com" }))
      .status,
    202,
  );
  const placeholder = (await store.getUserByEmail("grace@example.com"))!;
  assertEquals(placeholder.role, "owner");
  assertEquals(placeholder.emailVerifiedAt, null);

  fake.declare("grace", { verifiedEmails: ["grace@example.com"] });
  const claimed = await signIn(handler, "grace");
  assertEquals(claimed.status, 200);
  assertEquals((await claimed.json()).user.id, placeholder.id);
  assert((await store.getUserById(placeholder.id))!.emailVerifiedAt !== null);
  assertEquals((await store.getIdentityByAccount("github", "id-grace"))?.userId, placeholder.id);
});

test("the callback carries the authorize leg's redirect URI and PKCE verifier to the provider", async () => {
  const { handler, fake, service } = await build();
  const admin = await bootstrapAdmin(handler);
  fake.declare("grace", { verifiedEmails: ["grace@example.com"] });
  await service.updateSettings({ allowOpenRegistration: true });
  const verifier = "v".repeat(43);

  // A sign-in and a link each hand the provider exactly what the callback was sent.
  const signedIn = await post(handler, "/v1/auth/oauth/github/callback", {
    code: "grace",
    redirectUri: "https://ryph.example/gitlab/callback",
    codeVerifier: verifier,
  });
  assertEquals(signedIn.status, 200);
  fake.declare("ada", { verifiedEmails: [] });
  const linked = await post(handler, "/v1/auth/oauth/github/callback", {
    code: "ada",
    redirectUri: "https://ryph.example/gitlab/callback",
  }, admin.accessToken);
  assertEquals(linked.status, 200);
  // Without either, the leg is empty — GitHub's.
  await signIn(handler, "grace");
  assertEquals(fake.legs, [
    { redirectUri: "https://ryph.example/gitlab/callback", codeVerifier: verifier },
    { redirectUri: "https://ryph.example/gitlab/callback", codeVerifier: null },
    { redirectUri: null, codeVerifier: null },
  ]);

  // A verifier outside RFC 7636's alphabet or length, or a redirect that is no http(s) URL, is
  // refused before any provider is asked.
  for (
    const bad of [
      { code: "grace", codeVerifier: "short" },
      { code: "grace", codeVerifier: "x".repeat(42) + "!" },
      { code: "grace", redirectUri: "javascript:alert(1)" },
    ]
  ) {
    assertEquals((await post(handler, "/v1/auth/oauth/github/callback", bad)).status, 400);
  }
  assertEquals(fake.legs.length, 3);
});

test("an untrusted provider's addresses reach no account: no link, no claim, no hint before the gate", async () => {
  const { handler, fake, store, service } = await build(["github", "gitlab"]);
  await bootstrapAdmin(handler);
  await provenMember(service, handler, "grace@example.com", "Grace");
  const grace = (await store.getUserByEmail("grace@example.com"))!;
  await service.updateSettings({ allowOpenRegistration: true });
  await post(handler, "/v1/auth/users", { email: "bob@example.com", name: "Bob" });
  await service.updateSettings({ allowOpenRegistration: false });
  const bob = (await store.getUserByEmail("bob@example.com"))!;
  assertEquals(bob.emailVerifiedAt, null);
  // A self-managed GitLab confirms whatever address is typed at its sign-up.
  fake.declare("mallory", { verifiedEmails: ["grace@example.com"] });
  fake.declare("mallory2", { verifiedEmails: ["bob@example.com"] });

  // Not admitted: refused as any stranger is, before an address is so much as looked up.
  for (const code of ["mallory", "mallory2"]) {
    assertEquals(await service.loginWithProvider("gitlab", code), {
      ok: false,
      error: "registration-closed",
    });
  }
  // Admitted, the address still reaches nobody: the account it names links from its settings.
  fake.setMembership("member");
  await service.updateSettings({ allowForgeOrgJoin: true });
  for (const code of ["mallory", "mallory2"]) {
    assertEquals(await service.loginWithProvider("gitlab", code), {
      ok: false,
      error: "link-required",
    });
  }
  assertEquals(await store.listIdentitiesByUser(grace.id), []);
  assertEquals(await store.listIdentitiesByUser(bob.id), []);
  assertEquals(await store.getUserById(bob.id), bob);

  // The same address proven by GitHub is the address's owner, and links as it always did.
  fake.declare("grace-gh", { verifiedEmails: ["grace@example.com"] });
  const signedIn = await service.loginWithProvider("github", "grace-gh");
  assert(signedIn.ok);
  assertEquals(signedIn.tokens.user.id, grace.id);
});

test("an untrusted provider's address never keys an account: the squatter's stays its own", async () => {
  const { handler, fake, store, service, verifier, sent } = await build(["github", "gitlab"]);
  await bootstrapAdmin(handler);
  await service.updateSettings({ allowForgeOrgJoin: true, allowOpenRegistration: true });
  fake.setMembership("member");
  // A self-managed GitLab confirms whatever address is typed at its sign-up.
  fake.declare("mallory", { accountId: "gl-1", verifiedEmails: ["victim@example.com"] });
  fake.declare("eve", { accountId: "gl-2", verifiedEmails: ["other@example.com"] });
  const made = await service.loginWithProvider("gitlab", "mallory");
  const eve = await service.loginWithProvider("gitlab", "eve");
  assert(made.ok && eve.ok);
  // Each squatter mints an API token before anyone else shows up.
  const pats: string[] = [];
  for (const id of [made.tokens.user.id, eve.tokens.user.id]) {
    const minted = await service.mintApiToken(id, {
      name: "keep",
      caps: ["tasks:read"],
      expiresInMs: 86_400_000,
    });
    assert(minted.ok);
    pats.push(minted.token);
  }

  // The owner of victim@ proves it through GitHub; the owner of other@ registers with it and
  // opens the mailed link, or asks for a reset first.
  fake.declare("victim", { accountId: "gh-1", verifiedEmails: ["victim@example.com"] });
  const victim = await service.loginWithProvider("github", "victim");
  assert(victim.ok);
  sent.length = 0;
  await service.forgotPassword("other@example.com");
  assertEquals(sent.length, 0);
  await post(handler, "/v1/auth/users", { email: "other@example.com" });
  const token = sent[0].text.match(/\/([0-9a-f]{64})/)![1];
  const other = await service.verifyEmail(token, { name: "Other", password: "the real owner" });
  assert(other.ok);

  // Each owner holds an account of their own, with nothing a squatter made or linked.
  for (const [owner, squat] of [[victim, made], [other, eve]] as const) {
    assert(owner.tokens.user.id !== squat.tokens.user.id);
    const ownerProviders = (await store.listIdentitiesByUser(owner.tokens.user.id))
      .map((i) => i.provider);
    assertEquals(ownerProviders.includes("gitlab"), false);
    assertEquals(await store.listApiTokensByUser(owner.tokens.user.id), []);
  }
  // A squatter's token, exchanged, is its own account's and never the address's owner's.
  for (const pat of pats) {
    const exchanged = await service.exchangeApiToken(pat);
    if (!exchanged.ok) continue;
    const claims = (await verifier.verify(exchanged.accessToken))!;
    assert(claims.sub !== victim.tokens.user.id && claims.sub !== other.tokens.user.id);
    assert(claims.email !== "victim@example.com" && claims.email !== "other@example.com");
  }
  // Signing in through GitLab again lands each squatter on its own account.
  const again = await service.loginWithProvider("gitlab", "mallory");
  assert(again.ok);
  assertEquals(again.tokens.user.id, made.tokens.user.id);

  // An admin sees the address for what it is: GitLab's word, beside a stand-in nobody can prove.
  const listed = (await service.listUsers()).find((u) => u.id === made.tokens.user.id)!;
  assertEquals(listed.unprovenEmail, "victim@example.com");
  assertEquals(listed.email, made.tokens.user.email);
  assertStringIncludes(listed.email, ".invalid");
  // The stand-in is no way in either: no reset by mail or by admin, no registration, and no
  // provider's word that it is verified.
  sent.length = 0;
  await service.forgotPassword(listed.email);
  assertEquals(sent.length, 0);
  assertEquals(await service.mintResetLink(listed.id), { ok: false, error: "no-address" });
  assertEquals((await post(handler, "/v1/auth/users", { email: listed.email })).status, 400);
  fake.declare("forger", { accountId: "gh-9", verifiedEmails: [listed.email] });
  assertEquals(await service.loginWithProvider("github", "forger"), {
    ok: false,
    error: "no-verified-email",
  });
});

test("a bound invite proves its address for an untrusted provider naming the same one", async () => {
  const { handler, fake, service, store } = await build(["github", "gitlab"]);
  const admin = await bootstrapAdmin(handler);
  const bound = await (await post(handler, "/v1/auth/invites", {
    email: "grace@example.com",
  }, admin.accessToken)).json();
  fake.declare("grace", { verifiedEmails: ["grace@example.com"] });
  const made = await service.loginWithProvider("gitlab", "grace", undefined, bound.token);
  assert(made.ok);
  const user = (await store.getUserById(made.tokens.user.id))!;
  assertEquals([user.email, user.unprovenEmail], ["grace@example.com", null]);
});

test("a claim strips the registrant's API tokens with the rest", async () => {
  const { handler, fake, store, service } = await build();
  await bootstrapAdmin(handler);
  await service.updateSettings({ allowOpenRegistration: true });
  await post(handler, "/v1/auth/users", { email: "victim@example.com" });
  const squat = (await store.getUserByEmail("victim@example.com"))!;
  // Nothing hands an unproven account a token today; the claim must not rely on that.
  const minted = await service.mintApiToken(squat.id, {
    name: "keep",
    caps: ["tasks:read"],
    expiresInMs: 86_400_000,
  });
  assert(minted.ok);
  fake.declare("victim", { verifiedEmails: ["victim@example.com"] });
  const claimed = await service.loginWithProvider("github", "victim");
  assert(claimed.ok);
  assertEquals(claimed.tokens.user.id, squat.id);
  assertEquals(await service.exchangeApiToken(minted.token), { ok: false, error: "invalid-token" });
});

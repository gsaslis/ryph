// ChatGPT plan keys end to end against a fake OpenAI: the sign-in (PKCE, state, the ID token's
// signature, issuer, audience and nonce, the plan scope), signing in again, and the token set's
// life afterwards — one refresh at a time, the rotated refresh token written back, and the
// transitions to `needs_reauth` and `limited` and back.

import { test } from "bun:test";
import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { makePlanKeys, type PlanKeys } from "../src/core/plan_keys.ts";
import {
  parseTokenSet,
  pkceChallenge,
  type PlanTokenSet,
  REDIRECT_URI,
  sealableTokens,
} from "../src/core/chatgpt_plan.ts";
import { type ProviderKey, toPublicProviderKey } from "../src/core/types.ts";
import type { KeyStore } from "../src/ports/key_store.ts";
import { CLIENT_ID, EMAIL, type FakeOpenAi, makeFakeOpenAi, SUBJECT } from "./fake_openai.ts";
import { memoryKeyStore } from "./memory_store.ts";

const T0 = Date.parse("2026-10-07T10:00:00.000Z");

async function makePlan(opts: { store?: KeyStore } = {}) {
  const clock = { ms: T0 };
  const now = () => new Date(clock.ms);
  const fake = await makeFakeOpenAi({ now });
  const store = opts.store ?? memoryKeyStore();
  const events: string[] = [];
  const plan = makePlanKeys({
    store,
    accounts: fake.accounts,
    seal: (plaintext) => Promise.resolve(`v2.sealed:${plaintext}`),
    unseal: (sealed) => Promise.resolve(sealed.replace(/^v2\.sealed:/, "")),
    sealVerifier: (plaintext) => Promise.resolve(`v2.sealed:${plaintext}`),
    unsealVerifier: (sealed) => Promise.resolve(sealed.replace(/^v2\.sealed:/, "")),
    now,
    diag: { debug: (event) => events.push(event), warn: (event) => events.push(event) },
  });
  return { plan, fake, store, clock, events };
}

/** Starts a sign-in, has the fake accept its code, and returns what the browser would land on. */
async function browserLandsOn(
  plan: PlanKeys,
  fake: FakeOpenAi,
  start: { label?: string; keyId?: string } = {},
  extra: Record<string, string> = { client_id: CLIENT_ID },
) {
  const started = await plan.startSignIn(start);
  if (!started.ok) throw new Error(started.error);
  const authorize = new URL(started.authorizeUrl);
  const code = `code-${crypto.randomUUID()}`;
  fake.issueCode(code, authorize.searchParams.get("nonce")!);
  const query = new URLSearchParams({
    code,
    state: authorize.searchParams.get("state")!,
    ...extra,
  });
  return { signIn: started.signIn, authorize, query, code };
}

async function signedIn(ctx: Awaited<ReturnType<typeof makePlan>>): Promise<ProviderKey> {
  const { query } = await browserLandsOn(ctx.plan, ctx.fake);
  const done = await ctx.plan.completeSignIn(query);
  if (!done.ok) throw new Error(done.error);
  return (await ctx.store.getProviderKey(done.keyId))!;
}

/** A 401 for `token` that does not say it expired. */
const refused = (token: string, code: string | null = null) => ({ token, code });

const tokensIn = (key: ProviderKey): PlanTokenSet =>
  parseTokenSet(key.encryptedSecret.replace(/^v2\.sealed:/, ""));

test("a first sign-in registers a client, verifies the ID token and keeps the tokens sealed", async () => {
  const ctx = await makePlan();
  const { plan, fake, store } = ctx;
  const { signIn, authorize, query } = await browserLandsOn(plan, fake, { label: "my plan" });

  // The authorization request, parameter by parameter.
  const q = authorize.searchParams;
  assertEquals(
    `${authorize.origin}${authorize.pathname}`,
    "https://auth.openai.com/api/accounts/authorize",
  );
  assertEquals(q.get("client_id"), "dynamic_agent_client");
  assertEquals(q.get("agent_name_hint"), "Ryph");
  assertMatch(q.get("ext_agent_host_id")!, /^urn:uuid:[0-9a-f-]{36}$/);
  assertEquals(q.get("response_type"), "code");
  assertEquals(q.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
  assertEquals(
    q.get("scope"),
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  );
  assertEquals(q.get("resource"), "https://api.openai.com/v1");
  assertEquals(q.get("code_challenge_method"), "S256");
  assertEquals(q.get("id_token_hint"), null);
  assertEquals(q.get("state"), signIn.state);
  assertEquals(q.get("nonce"), signIn.nonce);
  assert(signIn.encryptedVerifier.startsWith("v2.sealed:"), "the verifier is sealed at rest");

  const done = await plan.completeSignIn(query);
  assert(done.ok);

  // The exchange: the ISSUED client, the verifier whose challenge went out, the same redirect.
  const exchange = fake.forms.find((f) => f.get("grant_type") === "authorization_code")!;
  assertEquals(exchange.get("client_id"), CLIENT_ID);
  assertEquals(exchange.get("redirect_uri"), REDIRECT_URI);
  assertEquals(exchange.get("resource"), "https://api.openai.com/v1");
  assertEquals(await pkceChallenge(exchange.get("code_verifier")!), q.get("code_challenge"));
  assertEquals(exchange.get("client_secret"), null, "a public client sends no secret");

  const key = (await store.getProviderKey(done.keyId))!;
  assertEquals(key.provider, "chatgpt-plan");
  assertEquals(key.label, "my plan");
  assertEquals(key.planStatus, "active");
  assertEquals(key.plan?.clientId, CLIENT_ID);
  assertEquals(key.plan?.subject, SUBJECT);
  assertEquals(key.plan?.email, EMAIL);
  assertEquals(key.plan?.planType, "plus");
  // Only `visibility: "list"` models, in the server's order, with what pi needs to know.
  assertEquals(key.plan?.models, [
    {
      id: "gpt-6.1-sol",
      label: "GPT-6.1 Sol",
      contextWindow: 400000,
      reasoning: true,
      vision: true,
      reasoningEfforts: ["low", "high"],
    },
    // The list says nothing of its reasoning, so neither does the key.
    { id: "gpt-6.1-mini", label: "GPT-6.1 mini" },
  ]);
  const tokens = tokensIn(key);
  assertEquals(tokens.refreshToken, fake.refreshToken());
  assertEquals(tokens.clientId, CLIENT_ID);
  assert(tokens.idToken !== null, "the ID token is retained for id_token_hint");

  // What leaves the service: the plan's public half, no client, no subject, no secret — and the
  // account's email only for an admin.
  const shown = toPublicProviderKey(key, { account: true });
  assertEquals(shown.plan, {
    email: EMAIL,
    planType: "plus",
    status: "active",
    limitedAt: null,
    // This account's own models, its efforts as pi's levels: never the raw efforts.
    models: [
      {
        id: "gpt-6.1-sol",
        label: "GPT-6.1 Sol",
        contextWindow: 400000,
        reasoning: true,
        vision: true,
        thinkingLevels: ["low", "high"],
      },
      { id: "gpt-6.1-mini", label: "GPT-6.1 mini" },
    ],
  });
  assert(!JSON.stringify(shown).includes("reasoningEfforts"), "no raw efforts in the public row");
  assertEquals(toPublicProviderKey(key).plan?.email, null);
  assert(!JSON.stringify(shown).includes("rt-"), "no token in the public row");
  assert(!("encryptedSecret" in shown));
  assertEquals(await plan.signInStatus(signIn.id), { status: "done", keyId: key.id });
});

test("the agent host id is minted once and sent on every sign-in", async () => {
  const { plan, fake } = await makePlan();
  const first = await browserLandsOn(plan, fake);
  const second = await browserLandsOn(plan, fake);
  assertEquals(
    first.authorize.searchParams.get("ext_agent_host_id"),
    second.authorize.searchParams.get("ext_agent_host_id"),
  );
  assertEquals(await plan.agentHostId(), first.authorize.searchParams.get("ext_agent_host_id"));
});

test("a state no sign-in issued leaves the sign-in waiting for its real answer", async () => {
  const { plan, fake } = await makePlan();
  const { signIn, query } = await browserLandsOn(plan, fake);
  const forged = new URLSearchParams(query);
  forged.set("state", "someone-elses");
  const refused = await plan.completeSignIn(forged);
  assertEquals(refused.ok, false);
  assertEquals(!refused.ok && refused.status, 404);
  assertEquals(await plan.signInStatus(signIn.id), { status: "pending" });
  assert((await plan.completeSignIn(query)).ok);
  assertEquals(fake.calls.filter((c) => c === "token:authorization_code").length, 1);
});

test("a declined consent fails the sign-in without exchanging anything", async () => {
  const { plan, fake } = await makePlan();
  const { signIn } = await browserLandsOn(plan, fake);
  const declined = await plan.completeSignIn(
    new URLSearchParams({ error: "access_denied", state: signIn.state }),
  );
  assertEquals(declined.ok, false);
  assertMatch(!declined.ok ? declined.error : "", /declined/);
  assertEquals((await plan.signInStatus(signIn.id))?.status, "failed");
  assert(!fake.calls.includes("token:authorization_code"));
});

test("a sign-in without the plan scope is refused, and its fresh session revoked", async () => {
  const { plan, fake, store } = await makePlan();
  fake.exchange.scope = "openid profile email offline_access";
  const { query } = await browserLandsOn(plan, fake);
  const refused = await plan.completeSignIn(query);
  assertEquals(refused.ok, false);
  assertMatch(!refused.ok ? refused.error : "", /not allowed/);
  // Fire-and-forget: give the revocation a tick to land.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(fake.calls.includes("revoke"));
  assertEquals(await store.listProviderKeys(), []);
});

for (
  const [name, tamper] of [
    ["a nonce from another attempt", { nonce: "not-this-one" }],
    ["another client's audience", { audience: "oaiapp_someone_else" }],
    ["a signature from a key OpenAI does not publish", { signWithOtherKey: true }],
  ] as const
) {
  test(`an ID token with ${name} fails the sign-in`, async () => {
    const { plan, fake, store } = await makePlan();
    fake.exchange = { ...tamper };
    const { query } = await browserLandsOn(plan, fake);
    const refused = await plan.completeSignIn(query);
    assertEquals(refused.ok, false);
    assertMatch(!refused.ok ? refused.error : "", /did not verify/);
    assertEquals(await store.listProviderKeys(), []);
  });
}

test("a first registration whose callback names no issued client fails", async () => {
  const { plan, fake } = await makePlan();
  const { query } = await browserLandsOn(plan, fake, {}, {});
  const refused = await plan.completeSignIn(query);
  assertEquals(refused.ok, false);
  assertMatch(!refused.ok ? refused.error : "", /client id/);
});

test("the listener and a paste racing on one code exchange it once", async () => {
  const { plan, fake } = await makePlan();
  const { query } = await browserLandsOn(plan, fake);
  const [a, b] = await Promise.all([
    plan.completeSignIn(query),
    plan.completeSignIn(query),
  ]);
  assertEquals(fake.calls.filter((c) => c === "token:authorization_code").length, 1);
  // Whichever lost is told the same key once the winner finished, or that it is in progress.
  assert(a.ok || b.ok);
  const again = await plan.completeSignIn(query);
  assert(again.ok);
  assertEquals(again.keyId, a.ok ? a.keyId : b.ok ? b.keyId : "");
});

test("an expired sign-in reads as expired and cannot be completed", async () => {
  const ctx = await makePlan();
  const { signIn, query } = await browserLandsOn(ctx.plan, ctx.fake);
  ctx.clock.ms += 11 * 60 * 1000;
  assertEquals(await ctx.plan.signInStatus(signIn.id), { status: "expired" });
  const late = await ctx.plan.completeSignIn(query);
  assertEquals(late.ok, false);
  assertMatch(!late.ok ? late.error : "", /expired/);
});

test("signing a key in again keeps the key and its client, and must be the same account", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  await ctx.store.updateProviderKey(key.id, {
    planStatus: "needs_reauth",
    updatedAt: new Date(T0).toISOString(),
  });

  const again = await browserLandsOn(ctx.plan, ctx.fake, { keyId: key.id }, {});
  const q = again.authorize.searchParams;
  assertEquals(q.get("client_id"), CLIENT_ID, "the issued client, not the registration entry");
  assertEquals(q.get("agent_name_hint"), null);
  assertEquals(q.get("login_hint"), EMAIL);
  assertEquals(q.get("id_token_hint"), tokensIn(key).idToken);
  const done = await ctx.plan.completeSignIn(again.query);
  assert(done.ok);
  assertEquals(done.keyId, key.id);
  const renewed = (await ctx.store.getProviderKey(key.id))!;
  assertEquals(renewed.planStatus, "active");
  assertNotEquals(tokensIn(renewed).accessToken, tokensIn(key).accessToken);
  assertEquals((await ctx.store.listProviderKeys()).length, 1);

  // Another account into this key is refused, and the key keeps its tokens.
  ctx.fake.exchange.subject = "someone-else";
  const other = await browserLandsOn(ctx.plan, ctx.fake, { keyId: key.id }, {});
  const refused = await ctx.plan.completeSignIn(other.query);
  assertEquals(refused.ok, false);
  assertMatch(!refused.ok ? refused.error : "", /different ChatGPT account/);
  assertEquals(
    tokensIn((await ctx.store.getProviderKey(key.id))!).accessToken,
    tokensIn(renewed).accessToken,
  );

  // And a callback naming another client than the key's.
  ctx.fake.exchange = {};
  const wrongClient = await browserLandsOn(ctx.plan, ctx.fake, { keyId: key.id }, {
    client_id: "oaiapp_other",
  });
  const refusedClient = await ctx.plan.completeSignIn(wrongClient.query);
  assertEquals(refusedClient.ok, false);
});

test("a token far from expiry is used as it is", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  const token = await ctx.plan.accessToken(key);
  assertEquals(token, { ok: true, token: tokensIn(key).accessToken });
  assert(!ctx.fake.calls.includes("token:refresh_token"));
});

test("near expiry, concurrent callers share ONE refresh and the rotated token is written back", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  ctx.clock.ms += 59 * 60 * 1000; // a minute left: inside the two-minute margin
  ctx.fake.refreshDelayMs = 20;
  const tokens = await Promise.all(
    Array.from({ length: 5 }, async () => await ctx.plan.accessToken(key)),
  );
  assertEquals(ctx.fake.calls.filter((c) => c === "token:refresh_token").length, 1);
  const fresh = ctx.fake.accessTokens.at(-1)!;
  for (const token of tokens) assertEquals(token, { ok: true, token: fresh });
  const stored = tokensIn((await ctx.store.getProviderKey(key.id))!);
  assertEquals(stored.accessToken, fresh);
  assertEquals(stored.refreshToken, ctx.fake.refreshToken(), "the ROTATED refresh token");
  assertNotEquals(stored.refreshToken, tokensIn(key).refreshToken);
  const refresh = ctx.fake.forms.find((f) => f.get("grant_type") === "refresh_token")!;
  assertEquals(refresh.get("client_id"), CLIENT_ID);
  assertEquals(refresh.get("resource"), "https://api.openai.com/v1");
  assertEquals(refresh.get("scope"), null, "omitted, to keep the grant");

  // A caller still holding the old row is handed the new token without another refresh.
  const stale = await ctx.plan.accessToken(key, refused(tokensIn(key).accessToken));
  assertEquals(stale, { ok: true, token: fresh });
  assertEquals(ctx.fake.calls.filter((c) => c === "token:refresh_token").length, 1);
});

test("a rejected token is refreshed once even when it is not near expiry", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  ctx.clock.ms += 6 * 60 * 1000; // past the gap after a token is minted
  const rejected = tokensIn(key).accessToken;
  const next = await ctx.plan.accessToken(key, refused(rejected));
  assert(next.ok);
  assertNotEquals(next.token, rejected);
  assertEquals(ctx.fake.calls.filter((c) => c === "token:refresh_token").length, 1);
});

test("a refused refresh token marks the key needs_reauth, and nothing is refreshed after", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  ctx.clock.ms += 3600 * 1000;
  ctx.fake.failRefresh = "invalid_grant";
  const refused = await ctx.plan.accessToken(key);
  assertEquals(refused.ok, false);
  assertEquals(!refused.ok && refused.reason, "needs_reauth");
  const after = (await ctx.store.getProviderKey(key.id))!;
  assertEquals(after.planStatus, "needs_reauth");
  assertEquals(toPublicProviderKey(after).plan?.status, "needs_reauth");
  const again = await ctx.plan.accessToken(after);
  assertEquals(!again.ok && again.reason, "needs_reauth");
  assertEquals(ctx.fake.calls.filter((c) => c === "token:refresh_token").length, 1);
});

for (
  const [shape, code] of [
    ["nested_401", "refresh_token_reused"],
    ["top_level", "refresh_token_expired"],
    ["bare_401", "invalid_grant"],
  ] as const
) {
  test(`a dead refresh token answered as ${shape} marks the key needs_reauth`, async () => {
    const ctx = await makePlan();
    const key = await signedIn(ctx);
    ctx.clock.ms += 3600 * 1000;
    ctx.fake.failRefresh = code;
    ctx.fake.failRefreshShape = shape;
    const refused = await ctx.plan.accessToken(key);
    assertEquals(refused.ok, false);
    assertEquals(!refused.ok && refused.reason, "needs_reauth");
    assertEquals(
      !refused.ok && refused.error,
      "the ChatGPT plan key's session ended; an admin signs it in again under Model keys",
    );
    assertEquals((await ctx.store.getProviderKey(key.id))?.planStatus, "needs_reauth");
  });
}

for (const failure of ["network", "5xx"]) {
  test(`not reaching OpenAI (${failure}) fails the call and leaves the key as it was`, async () => {
    const ctx = await makePlan();
    const key = await signedIn(ctx);
    ctx.clock.ms += 3600 * 1000;
    ctx.fake.failRefresh = failure;
    const failed = await ctx.plan.accessToken(key);
    assertEquals(!failed.ok && failed.reason, "unavailable");
    assertEquals((await ctx.store.getProviderKey(key.id))?.planStatus, "active");
    ctx.fake.failRefresh = null;
    assert((await ctx.plan.accessToken(key)).ok, "and the next call refreshes as usual");
  });
}

test("marking a key that is already limited takes no lock", async () => {
  const inner = memoryKeyStore();
  let locks = 0;
  const store: KeyStore = {
    ...inner,
    withProviderKeyLock: (id, fn) => {
      locks += 1;
      return inner.withProviderKeyLock(id, fn);
    },
  };
  const ctx = await makePlan({ store });
  const key = await signedIn(ctx);
  await ctx.plan.markLimited(key);
  const limited = (await ctx.store.getProviderKey(key.id))!;
  assertEquals(limited.planStatus, "limited");
  const before = locks;
  ctx.clock.ms += 60 * 1000;
  await Promise.all([ctx.plan.markLimited(limited), ctx.plan.markLimited(limited)]);
  assertEquals(locks, before);
  assertEquals((await ctx.store.getProviderKey(key.id))?.planLimitedAt, limited.planLimitedAt);
});

test("limited is set by the usage limit and cleared by the next success", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  await ctx.plan.markLimited(key);
  const limited = (await ctx.store.getProviderKey(key.id))!;
  assertEquals(limited.planStatus, "limited");
  assertEquals(limited.planLimitedAt, new Date(T0).toISOString());
  await ctx.plan.clearLimited(limited);
  const cleared = (await ctx.store.getProviderKey(key.id))!;
  assertEquals(cleared.planStatus, "active");
  assertEquals(cleared.planLimitedAt, null);

  // A key that needs signing in again is not "limited": that would hide the real problem.
  await ctx.store.updateProviderKey(key.id, { planStatus: "needs_reauth", updatedAt: "x" });
  await ctx.plan.markLimited((await ctx.store.getProviderKey(key.id))!);
  assertEquals((await ctx.store.getProviderKey(key.id))?.planStatus, "needs_reauth");
});

test("the model list is fetched again on request", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  await ctx.store.updateProviderKey(key.id, {
    plan: { ...key.plan!, models: [], modelsFetchedAt: null },
    updatedAt: "x",
  });
  const refreshed = await ctx.plan.refreshModels(key.id);
  assertEquals(refreshed, { ok: true, models: ["gpt-6.1-sol", "gpt-6.1-mini"] });
  assertEquals((await ctx.store.getProviderKey(key.id))?.plan?.models.length, 2);
  assertEquals((await ctx.plan.refreshModels("pk-nope")).ok, false);
});

test("archiving revokes the NEWEST refresh token, drops the tokens and archives the key", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  ctx.clock.ms += 59 * 60 * 1000;
  assert((await ctx.plan.accessToken(key)).ok, "refreshed: the stored refresh token rotated");
  const archived = await ctx.plan.archive(key.id);
  assertEquals(archived?.revoked, true);
  const form = ctx.fake.forms.at(-1)!;
  assertEquals(form.get("token"), ctx.fake.refreshToken(), "not the one the caller read first");
  assertNotEquals(form.get("token"), tokensIn(key).refreshToken);
  assertEquals(form.get("token_type_hint"), "refresh_token");
  assertEquals(form.get("client_id"), CLIENT_ID);
  const row = (await ctx.store.getProviderKey(key.id))!;
  assert(row.archivedAt !== null);
  assertEquals(row.encryptedSecret, "", "no token outlives the key");
  // Again: already archived, nothing more to end.
  assertEquals((await ctx.plan.archive(key.id))?.revoked, null);
  assertEquals(ctx.fake.calls.filter((c) => c === "revoke").length, 1);
});

test("archiving says when OpenAI could not confirm the revocation, and archives anyway", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  ctx.fake.failRevoke = true;
  const archived = await ctx.plan.archive(key.id);
  assertEquals(archived?.revoked, false);
  assertEquals(ctx.fake.calls.filter((c) => c === "revoke").length, 2, "tried twice");
  assert((await ctx.store.getProviderKey(key.id))?.archivedAt !== null);
});

test("a token refused again soon after it was minted is not refreshed again", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  const minted = tokensIn(key).accessToken;
  // Minutes old: a refresh would not fix it, and would spend the refresh token.
  const same = await ctx.plan.accessToken(key, refused(minted));
  assertEquals(same, { ok: true, token: minted });
  assert(!ctx.fake.calls.includes("token:refresh_token"));
  ctx.clock.ms += 6 * 60 * 1000;
  const next = await ctx.plan.accessToken(key, refused(minted));
  assert(next.ok && next.token !== minted);
  // And the new one, refused at once, is left alone for the same while.
  const fresh = (await ctx.store.getProviderKey(key.id))!;
  assertEquals(await ctx.plan.accessToken(fresh, refused(next.ok ? next.token : "")), next);
  assertEquals(ctx.fake.calls.filter((c) => c === "token:refresh_token").length, 1);
});

test("a refreshed token set that cannot be written is kept, used, and written by the next lock", async () => {
  const inner = memoryKeyStore();
  let failures = 3; // every attempt of the first write-back
  const store: KeyStore = {
    ...inner,
    replaceProviderKeySecret(...args) {
      if (failures > 0) {
        failures--;
        return Promise.reject(new Error("database away"));
      }
      return inner.replaceProviderKeySecret(...args);
    },
  };
  const ctx = await makePlan({ store });
  const key = await signedIn(ctx);
  ctx.clock.ms += 59 * 60 * 1000;
  const first = await ctx.plan.accessToken(key);
  assert(first.ok);
  assert(ctx.events.includes("chatgpt_plan.write_back_failed"));
  // The row still holds the spent refresh token; the process holds the live one.
  assertEquals(tokensIn((await inner.getProviderKey(key.id))!).refreshToken, "rt-1");
  assertEquals(ctx.fake.refreshToken(), "rt-2");
  // A caller with the stale row is handed the held token, no refresh.
  assertEquals(await ctx.plan.accessToken(key), first);
  // The next refresh writes the held set first, then refreshes FROM it — rt-2, not the spent rt-1.
  ctx.clock.ms += 59 * 60 * 1000;
  const second = await ctx.plan.accessToken((await inner.getProviderKey(key.id))!);
  assert(second.ok);
  assertEquals(ctx.fake.calls.filter((c) => c === "token:refresh_token").length, 2);
  assert(!ctx.events.includes("chatgpt_plan.needs_reauth"), "the live refresh token was used");
  assertEquals(tokensIn((await inner.getProviderKey(key.id))!).refreshToken, "rt-3");
});

test("a write-back over a secret that moved on does not land", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  ctx.clock.ms += 59 * 60 * 1000;
  // Someone else's write lands while the refresh is out at OpenAI.
  ctx.fake.refreshDelayMs = 20;
  const refreshing = ctx.plan.accessToken(key);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await ctx.store.updateProviderKey(key.id, { encryptedSecret: "v2.sealed:other", updatedAt: "x" });
  assert((await refreshing).ok);
  assertEquals((await ctx.store.getProviderKey(key.id))?.encryptedSecret, "v2.sealed:other");
  assert(ctx.events.includes("chatgpt_plan.write_back_superseded"));
});

test("signing in again waits for a refresh in flight, then replaces it, leaving the old session to lapse", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  ctx.clock.ms += 59 * 60 * 1000;
  ctx.fake.refreshDelayMs = 30;
  const again = await browserLandsOn(ctx.plan, ctx.fake, { keyId: key.id }, {});
  const refreshing = ctx.plan.accessToken(key);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const done = await ctx.plan.completeSignIn(again.query);
  assert(done.ok, !done.ok ? done.error : "");
  const refreshed = await refreshing;
  assert(refreshed.ok);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Issued in this order: the sign-in's at-2/rt-2 while the refresh was out, then the
  // refresh's at-3/rt-3. The sign-in's tokens stand, written after the refresh's.
  const row = (await ctx.store.getProviderKey(key.id))!;
  assertEquals(refreshed.token, "at-3");
  assertEquals(tokensIn(row).accessToken, "at-2");
  // Nothing is revoked: a revoke might end the new session along with the old one.
  const revoked = ctx.fake.forms.filter((f) => f.has("token")).map((f) => f.get("token"));
  assertEquals(revoked, []);
});

test("a sign-in that throws after its claim ends failed, and its tokens are revoked", async () => {
  const inner = memoryKeyStore();
  const store: KeyStore = {
    ...inner,
    createProviderKey: () => Promise.reject(new Error("database away")),
  };
  const ctx = await makePlan({ store });
  const { signIn, query } = await browserLandsOn(ctx.plan, ctx.fake);
  const done = await ctx.plan.completeSignIn(query);
  assertEquals(done.ok, false);
  assertEquals(!done.ok && done.status, 502);
  assertEquals((await ctx.plan.signInStatus(signIn.id))?.status, "failed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(ctx.fake.calls.includes("revoke"));
});

test("a re-sign-in that fails revokes nothing, so the working key stays signed in", async () => {
  const inner = memoryKeyStore();
  let failWrite = false;
  const store: KeyStore = {
    ...inner,
    updateProviderKey: (id, patch) =>
      failWrite ? Promise.reject(new Error("database away")) : inner.updateProviderKey(id, patch),
  };
  const ctx = await makePlan({ store });
  const key = await signedIn(ctx);
  const revokes = () => ctx.fake.calls.filter((c) => c === "revoke").length;

  // The wrong account: the grant just issued is under the key's own client.
  ctx.fake.exchange.subject = "someone-else";
  const other = await browserLandsOn(ctx.plan, ctx.fake, { keyId: key.id }, {});
  const wrong = await ctx.plan.completeSignIn(other.query);
  assertMatch(!wrong.ok ? wrong.error : "", /different ChatGPT account/);

  // Without the plan scope.
  ctx.fake.exchange = { scope: "openid email offline_access" };
  const noScope = await browserLandsOn(ctx.plan, ctx.fake, { keyId: key.id }, {});
  assertEquals((await ctx.plan.completeSignIn(noScope.query)).ok, false);

  // And one that throws once its tokens are issued.
  ctx.fake.exchange = {};
  failWrite = true;
  const threw = await browserLandsOn(ctx.plan, ctx.fake, { keyId: key.id }, {});
  const thrown = await ctx.plan.completeSignIn(threw.query);
  assertEquals(!thrown.ok && thrown.status, 502);
  failWrite = false;

  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(revokes(), 0);
  assertEquals((await ctx.store.getProviderKey(key.id))?.planStatus, "active");
  assertEquals(
    tokensIn((await ctx.store.getProviderKey(key.id))!).accessToken,
    tokensIn(key).accessToken,
  );
});

test("a claim left behind by a completion that died reads as failed once it is stale", async () => {
  const ctx = await makePlan();
  const { signIn } = await browserLandsOn(ctx.plan, ctx.fake);
  await ctx.store.claimSignIn(signIn.id, new Date(ctx.clock.ms).toISOString());
  assertEquals(await ctx.plan.signInStatus(signIn.id), { status: "pending" });
  ctx.clock.ms += 3 * 60 * 1000;
  assertEquals((await ctx.plan.signInStatus(signIn.id))?.status, "failed");
});

test("the status marks go by the row as it is, not as the call found it", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  // The call read `active`; a refresh has since found the key needs signing in again.
  await ctx.store.updateProviderKey(key.id, { planStatus: "needs_reauth", updatedAt: "x" });
  await ctx.plan.markLimited(key);
  assertEquals((await ctx.store.getProviderKey(key.id))?.planStatus, "needs_reauth");
  await ctx.plan.clearLimited({ ...key, planStatus: "limited" });
  assertEquals((await ctx.store.getProviderKey(key.id))?.planStatus, "needs_reauth");
});

test("a new key is not labelled with the account's email", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  assertEquals(key.label, "ChatGPT plan");
});

test("an unreadable token set is a failed call, never a thrown one", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  const broken = { ...key, encryptedSecret: `v2.sealed:${sealableTokens(tokensIn(key)).slice(5)}` };
  await ctx.store.replaceProviderKeySecret(
    key.id,
    key.encryptedSecret,
    broken.encryptedSecret,
    "x",
  );
  const failed = await ctx.plan.accessToken(broken);
  // Not a blip to retry: it stays unreadable until someone signs in again.
  assertEquals(!failed.ok && failed.reason, "needs_reauth");
  // And recorded, so the key no longer reads `active` to the people who would sign it in.
  const stored = (await ctx.store.getProviderKey(key.id))!;
  assertEquals(stored.planStatus, "needs_reauth");
  assertEquals(toPublicProviderKey(stored).plan?.status, "needs_reauth");
});

test("an unreadable token set read before a new sign-in landed does not mark the new one", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  // The data plane read a broken value; a sign-in has since written a good one over it.
  const stale = { ...key, encryptedSecret: `v2.sealed:${sealableTokens(tokensIn(key)).slice(5)}` };
  const failed = await ctx.plan.accessToken(stale);
  assertEquals(!failed.ok && failed.reason, "needs_reauth");
  const stored = (await ctx.store.getProviderKey(key.id))!;
  assertEquals(stored.encryptedSecret, key.encryptedSecret);
  assertEquals(stored.planStatus, key.planStatus);
});

test("a plan key holding a token set in another format reads needs_reauth, and is not marked so", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  const foreign = { ...key, encryptedSecret: "v1.aXY=.Y3Q=" };
  // Shown as needing a sign-in…
  assertEquals(toPublicProviderKey(foreign).plan?.status, "needs_reauth");
  const failed = await ctx.plan.accessToken(foreign);
  assertEquals(!failed.ok && failed.reason, "needs_reauth");
  // …but only a `v2` value that does not open is recorded so.
  assertEquals((await ctx.store.getProviderKey(key.id))!.planStatus, "active");
});

test("a plan key's token set opens only on a chatgpt-plan row", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  assert((await ctx.plan.accessToken(key)).ok);
  // The row rewritten to another provider in the database: nothing is opened for it.
  const failed = await ctx.plan.accessToken({ ...key, provider: "openai" });
  assertEquals(!failed.ok && failed.reason, "needs_reauth");
});

// ── expiry and forced refreshes ─────────────────────────────────────────────────────────────

const atSeconds = (ms: number) => Math.floor(ms / 1000);

test("an access token's own exp wins over a longer expires_in", async () => {
  const ctx = await makePlan();
  ctx.fake.accessJwtTtlS = 600; // the token says ten minutes; the response says an hour
  const key = await signedIn(ctx);
  assertEquals(tokensIn(key).accessExpiresAt, new Date(T0 + 600_000).toISOString());
  ctx.clock.ms += 9 * 60 * 1000; // a minute left by the token, 51 by expires_in
  const next = await ctx.plan.accessToken(key);
  assert(next.ok && next.token !== tokensIn(key).accessToken, "refreshed before it died");
  assertEquals(ctx.fake.calls.filter((c) => c === "token:refresh_token").length, 1);
});

test("a stored expiry later than the token's own exp is not trusted", async () => {
  const ctx = await makePlan();
  ctx.fake.accessJwtTtlS = 600;
  const key = await signedIn(ctx);
  // A set stored before the exp was read: an hour, by expires_in alone.
  const overstated = sealableTokens({
    ...tokensIn(key),
    accessExpiresAt: new Date(T0 + 3600_000).toISOString(),
  });
  await ctx.store.updateProviderKey(key.id, {
    encryptedSecret: `v2.sealed:${overstated}`,
    updatedAt: "x",
  });
  ctx.clock.ms += 9 * 60 * 1000;
  const next = await ctx.plan.accessToken((await ctx.store.getProviderKey(key.id))!);
  assert(next.ok && next.token !== tokensIn(key).accessToken);
});

test("expires_at is read when the response sends it instead of expires_in", async () => {
  const ctx = await makePlan();
  ctx.fake.grantExtra = { expires_in: undefined, expires_at: atSeconds(T0) + 900 };
  const key = await signedIn(ctx);
  assertEquals(tokensIn(key).accessExpiresAt, new Date(T0 + 900_000).toISOString());
});

test("the sooner of expires_in and expires_at wins, and a numeric string is seconds", async () => {
  const ctx = await makePlan();
  ctx.fake.grantExtra = { expires_in: "1200", expires_at: atSeconds(T0) + 3600 };
  const key = await signedIn(ctx);
  assertEquals(tokensIn(key).accessExpiresAt, new Date(T0 + 1_200_000).toISOString());
});

test("a token OpenAI ended early (401 token_expired) is refreshed at once, past the gap and earliest_refresh_at", async () => {
  const ctx = await makePlan();
  ctx.fake.grantExtra = { earliest_refresh_at: atSeconds(T0) + 30 * 60 };
  const key = await signedIn(ctx);
  ctx.clock.ms += 2 * 60 * 1000; // inside the gap, before earliest_refresh_at, far from expiry
  const minted = tokensIn(key).accessToken;
  const next = await ctx.plan.accessToken(key, refused(minted, "token_expired"));
  assert(next.ok && next.token !== minted);
  assertEquals(ctx.fake.calls.filter((c) => c === "token:refresh_token").length, 1);
  assert(ctx.events.includes("chatgpt_plan.rejected_refreshing"));
  // Concurrent refusals of the same dead token share the one refresh.
  assertEquals(await ctx.plan.accessToken(key, refused(minted, "token_expired")), next);
  assertEquals(ctx.fake.calls.filter((c) => c === "token:refresh_token").length, 1);
});

test("any other 401 still waits for earliest_refresh_at, and says so", async () => {
  const ctx = await makePlan();
  ctx.fake.grantExtra = { earliest_refresh_at: atSeconds(T0) + 30 * 60 };
  const key = await signedIn(ctx);
  ctx.clock.ms += 6 * 60 * 1000; // past the gap, still before earliest_refresh_at
  const minted = tokensIn(key).accessToken;
  assertEquals(await ctx.plan.accessToken(key, refused(minted)), { ok: true, token: minted });
  assert(!ctx.fake.calls.includes("token:refresh_token"));
  assert(ctx.events.includes("chatgpt_plan.rejected_refresh_denied"));
});

test("a 401 for a token past its expiry is refreshed whatever its code", async () => {
  const ctx = await makePlan();
  ctx.fake.accessJwtTtlS = 240;
  ctx.fake.grantExtra = { earliest_refresh_at: atSeconds(T0) + 30 * 60 };
  const key = await signedIn(ctx);
  ctx.clock.ms += 4 * 60 * 1000 + 1;
  const minted = tokensIn(key).accessToken;
  const next = await ctx.plan.accessToken(key, refused(minted));
  assert(next.ok && next.token !== minted);
});

test("token_expired with the refresh token revoked too: needs_reauth, told to sign in again", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  ctx.clock.ms += 2 * 60 * 1000;
  ctx.fake.failRefresh = "invalid_grant";
  const next = await ctx.plan.accessToken(key, refused(tokensIn(key).accessToken, "token_expired"));
  assertEquals(!next.ok && next.reason, "needs_reauth");
  assertMatch(!next.ok ? next.error : "", /signs it in again/);
  const after = (await ctx.store.getProviderKey(key.id))!;
  assertEquals(toPublicProviderKey(after).plan?.status, "needs_reauth");
});

test("a refresh that cannot reach OpenAI says why, and the next call tries again", async () => {
  const ctx = await makePlan();
  const key = await signedIn(ctx);
  ctx.clock.ms += 2 * 60 * 1000;
  ctx.fake.failRefresh = "5xx";
  const minted = tokensIn(key).accessToken;
  const failed = await ctx.plan.accessToken(key, refused(minted, "token_expired"));
  assertEquals(!failed.ok && failed.reason, "unavailable");
  assertMatch(!failed.ok ? failed.error : "", /503/);
  ctx.fake.failRefresh = null;
  const next = await ctx.plan.accessToken(key, refused(minted, "token_expired"));
  assert(next.ok && next.token !== minted);
});

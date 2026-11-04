// API tokens: minted from what the owner holds, listed and revoked by their owner, exchanged for
// an access token that carries the token's capabilities narrowed to the owner's current ones.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { makeAuthService } from "../src/core/service.ts";
import { asOperator } from "./operator.ts";
import { verifierFromJwksSource } from "../src/core/verify.ts";
import { authRoutes } from "../src/http/routes.ts";
import { makeRouter } from "@ryph/shared/http";
import { memoryAuthStore } from "./memory_store.ts";

function makeClock() {
  let nowMs = Date.now();
  return { now: () => new Date(nowMs), advance: (ms: number) => nowMs += ms };
}

async function buildAuth() {
  const store = memoryAuthStore();
  const clock = makeClock();
  const service = await makeAuthService({ store, now: clock.now });
  const verifier = verifierFromJwksSource(() => service.jwks());
  const routes = authRoutes({ service, verifier, now: clock.now });
  const handler = makeRouter(routes);
  return { handler: asOperator(handler, service), verifier, clock, service };
}

function call(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
) {
  return handler(
    new Request(`http://auth.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? null : JSON.stringify(body),
    }),
  );
}

const ADA = { email: "ada@example.com", name: "Ada", password: "correct horse battery" };
const BOB = { email: "bob@example.com", name: "Bob", password: "hunter2hunter2" };

/** Ada owns the instance; Bob joins as a member. Both signed in. */
async function twoUsers(handler: (req: Request) => Promise<Response>) {
  await call(handler, "POST", "/v1/auth/users", null, ADA);
  const ada = await (await call(handler, "POST", "/v1/auth/login", null, ADA)).json();
  const minted = await call(handler, "POST", "/v1/auth/invites", ada.accessToken, {
    email: BOB.email,
  });
  const { token } = await minted.json();
  await call(handler, "POST", `/v1/auth/invites/${token}/accept`, null, {
    name: BOB.name,
    password: BOB.password,
  });
  const bob = await (await call(handler, "POST", "/v1/auth/login", null, BOB)).json();
  return { ada, bob };
}

test("a token is minted from the owner's capabilities, shown once, and exchanged", async () => {
  const { handler, verifier } = await buildAuth();
  const { bob } = await twoUsers(handler);

  const beyond = await call(handler, "POST", "/v1/auth/tokens", bob.accessToken, {
    name: "too much",
    caps: ["tasks:create", "users:manage"],
  });
  assertEquals(beyond.status, 403);
  assertEquals((await beyond.json()).capability, "users:manage");
  // Bob holds tokens:write, but no token may carry it: auth answers it to a session only.
  const governing = await call(handler, "POST", "/v1/auth/tokens", bob.accessToken, {
    name: "token factory",
    caps: ["tokens:write"],
  });
  assertEquals(governing.status, 400);
  assertEquals((await governing.json()).code, "session_required");

  const minted = await call(handler, "POST", "/v1/auth/tokens", bob.accessToken, {
    name: "deploy script",
    caps: ["tasks:create", "tasks:read"],
  });
  assertEquals(minted.status, 201);
  const { token, summary } = await minted.json();
  assert(token.startsWith("ryph_pat_"));
  assert(!("tokenHash" in summary));
  assertEquals(summary.caps, ["tasks:create", "tasks:read"]);

  const listed = await (await call(handler, "GET", "/v1/auth/tokens", bob.accessToken)).json();
  assertEquals(listed.tokens.map((t: { id: string }) => t.id), [summary.id]);
  assert(!JSON.stringify(listed).includes("ryph_pat_"), "the secret is shown once, at minting");

  const exchanged = await call(handler, "POST", "/v1/auth/token", null, { token });
  assertEquals(exchanged.status, 200);
  const { accessToken, expiresIn } = await exchanged.json();
  assertEquals(expiresIn, 600);
  const claims = await verifier.verify(accessToken);
  assert(claims !== null);
  assertEquals(claims.sub, bob.user.id);
  assertEquals(claims.caps, ["tasks:create", "tasks:read"]);
  assertEquals(claims.via, "token");
  assertEquals(claims.sid, summary.id);

  // The exchanged token works where a session's would, except on the account itself: it mints
  // no token of its own, and it cannot touch the password, the sessions, or the passkeys, so a
  // token minted to read tasks never becomes a way to sign in whole.
  assertEquals((await call(handler, "GET", "/v1/auth/me", accessToken)).status, 200);
  const spawn = await call(handler, "POST", "/v1/auth/tokens", accessToken, {
    name: "copy of myself",
    caps: ["tasks:read"],
  });
  assertEquals(spawn.status, 403);
  const password = await call(handler, "POST", "/v1/auth/password", accessToken, {
    currentPassword: BOB.password,
    newPassword: "a brand new password",
  });
  assertEquals(password.status, 403);
  assertEquals((await password.json()).code, "session_required");
  const sessions = await call(handler, "POST", "/v1/auth/sessions/revoke-all", accessToken);
  assertEquals(sessions.status, 403);
  assertEquals((await call(handler, "GET", "/v1/auth/passkeys", accessToken)).status, 403);
  assertEquals((await call(handler, "GET", "/v1/auth/sessions", accessToken)).status, 403);

  const garbage = await call(handler, "POST", "/v1/auth/token", null, { token: "ryph_pat_nope" });
  assertEquals(garbage.status, 400);
  const unknown = await call(handler, "POST", "/v1/auth/token", null, {
    token: `ryph_pat_${"0".repeat(64)}`,
  });
  assertEquals(unknown.status, 401);
});

test("a token dies with its revocation, its expiry, and its owner's deactivation", async () => {
  const { handler, clock } = await buildAuth();
  const { ada, bob } = await twoUsers(handler);
  const mint = async (name: string, expiresInDays?: number) =>
    (await (await call(handler, "POST", "/v1/auth/tokens", bob.accessToken, {
      name,
      caps: ["tasks:read"],
      ...(expiresInDays === undefined ? {} : { expiresInDays }),
    })).json()) as { token: string; summary: { id: string } };
  const exchange = async (token: string) =>
    (await call(handler, "POST", "/v1/auth/token", null, { token })).status;

  const revoked = await mint("revoked");
  const foreign = await call(
    handler,
    "DELETE",
    `/v1/auth/tokens/${revoked.summary.id}`,
    ada.accessToken,
  );
  assertEquals(foreign.status, 200, "an owner holds tokens:manage-all");
  assertEquals(await exchange(revoked.token), 401);
  const gone = await (await call(handler, "GET", "/v1/auth/tokens", bob.accessToken)).json();
  assert(gone.tokens[0].revokedAt !== null, "a revoked token stays listed, dated");

  const own = await mint("mine");
  const stranger = await call(
    handler,
    "DELETE",
    `/v1/auth/tokens/${own.summary.id}`,
    ada.accessToken,
  );
  assertEquals(stranger.status, 200);

  const shortLived = await mint("short", 1);
  assertEquals(await exchange(shortLived.token), 200);
  clock.advance(2 * 24 * 60 * 60 * 1000);
  assertEquals(await exchange(shortLived.token), 401);

  const longLived = await mint("long", 30);
  const access = (await (await call(handler, "POST", "/v1/auth/token", null, {
    token: longLived.token,
  })).json()).accessToken;
  await call(handler, "PATCH", `/v1/auth/users/${bob.user.id}`, ada.accessToken, {
    status: "deactivated",
  });
  assertEquals(await exchange(longLived.token), 401);
  // An access token already exchanged has minutes left, and every door that checks the
  // credential behind it is shut anyway.
  assertEquals((await call(handler, "GET", "/v1/auth/me", access)).status, 401);
});

test("a demotion shrinks the owner's tokens at their next exchange", async () => {
  const { handler, verifier } = await buildAuth();
  const { ada, bob } = await twoUsers(handler);
  await call(handler, "PATCH", `/v1/auth/users/${bob.user.id}`, ada.accessToken, {
    role: "operator",
  });
  const asOperator = await (await call(handler, "POST", "/v1/auth/login", null, BOB)).json();
  const minted = await (await call(handler, "POST", "/v1/auth/tokens", asOperator.accessToken, {
    name: "ops",
    caps: ["tasks:read-all", "tasks:read"],
  })).json();

  const before = await (await call(handler, "POST", "/v1/auth/token", null, {
    token: minted.token,
  })).json();
  assertEquals((await verifier.verify(before.accessToken))?.caps, ["tasks:read-all", "tasks:read"]);

  await call(handler, "PATCH", `/v1/auth/users/${bob.user.id}`, ada.accessToken, {
    role: "viewer",
  });
  const after = await (await call(handler, "POST", "/v1/auth/token", null, {
    token: minted.token,
  })).json();
  assertEquals((await verifier.verify(after.accessToken))?.caps, ["tasks:read"]);
});

test("a member's token may carry checks:request, so a laptop can ask for checks", async () => {
  const { handler, verifier } = await buildAuth();
  const { bob } = await twoUsers(handler);
  const minted = await call(handler, "POST", "/v1/auth/tokens", bob.accessToken, {
    name: "ryph checks",
    caps: ["checks:request", "repos:read"],
  });
  assertEquals(minted.status, 201);
  const { token } = await minted.json();
  const exchanged = await (await call(handler, "POST", "/v1/auth/token", null, { token })).json();
  assertEquals((await verifier.verify(exchanged.accessToken))?.caps, [
    "checks:request",
    "repos:read",
  ]);
});

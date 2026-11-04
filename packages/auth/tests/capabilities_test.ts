// The catalogue and the roles over it: how they nest, what a token carries, what a refusal says.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  can,
  CAPABILITIES,
  capsClaimOf,
  mayGrant,
  ROLE_CAPABILITIES,
  ROLES,
} from "../src/core/capabilities.ts";
import { makeAuthService } from "../src/core/service.ts";
import { asOperator } from "./operator.ts";
import { verifierFromJwksSource } from "../src/core/verify.ts";
import { authRoutes } from "../src/http/routes.ts";
import { makeRouter } from "@ryph/shared/http";
import { memoryAuthStore } from "./memory_store.ts";

test("each role is a superset of the one before it, and an owner holds everything", () => {
  for (let i = 1; i < ROLES.length; i++) {
    const narrower = ROLE_CAPABILITIES[ROLES[i - 1]];
    const wider = ROLE_CAPABILITIES[ROLES[i]];
    for (const capability of narrower) assert(wider.includes(capability), capability);
    assert(wider.length > narrower.length, `${ROLES[i]} adds nothing over ${ROLES[i - 1]}`);
  }
  assertEquals(ROLE_CAPABILITIES.owner, CAPABILITIES);
  assertEquals(capsClaimOf("owner"), ["*"]);
  assertEquals(capsClaimOf("member"), ROLE_CAPABILITIES.member);
  assertEquals(new Set(CAPABILITIES).size, CAPABILITIES.length);
});

test("can reads the list, and the wildcard answers every capability", () => {
  const viewer = { caps: capsClaimOf("viewer") };
  assert(can(viewer, "tasks:read"));
  assert(!can(viewer, "tasks:create"));
  assert(!can(viewer, "users:manage"));
  // Asking for checks on one's own commit spends the operator's compute: a member's, not a
  // viewer's.
  assert(!can(viewer, "checks:request"));
  assert(can({ caps: capsClaimOf("member") }, "checks:request"));
  assert(can({ caps: capsClaimOf("operator") }, "checks:request"));
  const owner = { caps: capsClaimOf("owner") };
  for (const capability of CAPABILITIES) assert(can(owner, capability), capability);
});

test("a role is grantable only from within the granter's own capabilities", () => {
  const owner = { caps: capsClaimOf("owner") };
  const operator = { caps: capsClaimOf("operator") };
  const viewer = { caps: capsClaimOf("viewer") };
  for (const role of ROLES) assert(mayGrant(owner, role), role);
  assert(mayGrant(operator, "operator"));
  assert(mayGrant(operator, "member"));
  assert(!mayGrant(operator, "owner"));
  assert(mayGrant(viewer, "viewer"));
  assert(!mayGrant(viewer, "member"));
});

async function buildAuth() {
  const store = memoryAuthStore();
  const now = () => new Date();
  const service = await makeAuthService({ store, now });
  const verifier = verifierFromJwksSource(() => service.jwks());
  const routes = authRoutes({ service, verifier, now });
  const handler = makeRouter(routes);
  return { handler: asOperator(handler, service), verifier };
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

test("the token carries the role expanded, and a refusal names the capability", async () => {
  const { handler, verifier } = await buildAuth();
  const ada = { email: "ada@example.com", name: "Ada", password: "correct horse battery" };
  await call(handler, "POST", "/v1/auth/users", null, ada);
  const owner = await (await call(handler, "POST", "/v1/auth/login", null, ada)).json();
  assertEquals((await verifier.verify(owner.accessToken))?.caps, ["*"]);

  const bob = { email: "bob@example.com", name: "Bob", password: "hunter2hunter2" };
  const minted = await call(handler, "POST", "/v1/auth/invites", owner.accessToken, {
    email: bob.email,
    role: "viewer",
  });
  assertEquals(minted.status, 201);
  const { token } = await minted.json();
  await call(handler, "POST", `/v1/auth/invites/${token}/accept`, null, {
    name: bob.name,
    password: bob.password,
  });
  const viewer = await (await call(handler, "POST", "/v1/auth/login", null, bob)).json();
  assertEquals(viewer.user.role, "viewer");
  assertEquals((await verifier.verify(viewer.accessToken))?.caps, ROLE_CAPABILITIES.viewer);

  const refused = await call(handler, "GET", "/v1/auth/users", viewer.accessToken);
  assertEquals(refused.status, 403);
  assertEquals(await refused.json(), {
    error: "requires users:manage",
    code: "forbidden",
    capability: "users:manage",
  });
});

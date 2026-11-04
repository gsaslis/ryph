// The user-surface gates over a scripted verifier: who gets a principal, who gets refused, and
// that an unproven address is refused by every gate rather than left to the web app.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { capsClaimOf } from "../src/core/capabilities.ts";
import type { Claims } from "../src/core/types.ts";
import {
  makeAuthenticate,
  makeCapabilityGate,
  makeGrantBearer,
  refuseUnless,
} from "../src/http/gates.ts";

const claims = (over: Partial<Claims> = {}): Claims => ({
  sub: "u-1",
  email: "ada@example.com",
  name: "Ada",
  caps: capsClaimOf("member"),
  emailVerified: true,
  sid: "s-1",
  via: "session",
  ...over,
});

const bearing = (token: string) =>
  new Request("http://orchestrator.test/v1/tasks", {
    headers: { authorization: `Bearer ${token}` },
  });

test("the gate: verified users pass, unproven ones are refused, off bypasses", async () => {
  const known = new Map([["verified", claims()], ["unproven", claims({ emailVerified: false })]]);
  const verifier = { verify: (token: string) => Promise.resolve(known.get(token) ?? null) };
  const authenticate = makeAuthenticate({ verifier });

  const user = await authenticate(bearing("verified"));
  assert(!(user instanceof Response));
  assertEquals(user.kind === "user" && user.userId, "u-1");

  const refused = await authenticate(bearing("unproven"));
  assert(refused instanceof Response);
  assertEquals(refused.status, 403);

  const stranger = await authenticate(bearing("garbage"));
  assert(stranger instanceof Response);
  assertEquals(stranger.status, 401);

  const glass = await makeAuthenticate({ verifier, disabled: true })(bearing("garbage"));
  assert(!(glass instanceof Response));
  assertEquals(glass.kind, "break-glass");
});

test("refuseUnless: the list decides, and a refusal names the capability", async () => {
  const principal = await makeAuthenticate({
    verifier: { verify: () => Promise.resolve(claims({ caps: capsClaimOf("viewer") })) },
  })(bearing("viewer"));
  assert(!(principal instanceof Response));
  assertEquals(refuseUnless(principal, "tasks:read"), null);
  const refused = refuseUnless(principal, "tasks:create", "starting a run");
  assert(refused instanceof Response);
  assertEquals(refused.status, 403);
  assertEquals(await refused.json(), {
    error: "starting a run requires tasks:create",
    code: "forbidden",
    capability: "tasks:create",
  });
  assertEquals(refuseUnless({ kind: "break-glass" }, "users:manage"), null);
});

test("the capability and grant gates refuse an unproven address too", async () => {
  const known = new Map([["verified", claims()], ["unproven", claims({ emailVerified: false })]]);
  const verifier = { verify: (token: string) => Promise.resolve(known.get(token) ?? null) };

  const gate = makeCapabilityGate({ verifier }, "tasks:read");
  assertEquals(await gate(bearing("verified")), null);
  assertEquals((await gate(bearing("unproven")))?.status, 403);
  assertEquals((await gate(bearing("garbage")))?.status, 401);
  assertEquals((await gate(new Request("http://x.test/")))?.status, 401);
  const denied = await makeCapabilityGate({ verifier }, "users:manage")(bearing("verified"));
  assertEquals(denied?.status, 403);
  assertEquals(
    await makeCapabilityGate({ verifier, disabled: true }, "users:manage")(
      bearing("garbage"),
    ),
    null,
  );

  const bearer = makeGrantBearer({ verifier });
  assertEquals(await bearer(bearing("verified")), { sub: "u-1", caps: capsClaimOf("member") });
  const refused = await bearer(bearing("unproven"));
  assert(refused instanceof Response);
  assertEquals(refused.status, 403);
  assertEquals(await makeGrantBearer({ verifier, disabled: true })(bearing("garbage")), null);
});

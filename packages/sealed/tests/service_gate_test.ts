// The shared-bearer gate: what counts as a bearer, and that only the right one passes.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { bearerToken, makeServiceGate, tokenMatches, unauthorized } from "../src/mod.ts";

const withAuth = (value?: string) =>
  new Request("http://x/", value === undefined ? {} : { headers: { authorization: value } });

test("a bearer is the header after an exact `Bearer `; anything else is none", () => {
  assertEquals(bearerToken(withAuth("Bearer abc")), "abc");
  assertEquals(bearerToken(withAuth("Bearer  abc")), " abc");
  assertEquals(bearerToken(withAuth()), null);
  assertEquals(bearerToken(withAuth("bearer abc")), null);
  assertEquals(bearerToken(withAuth("Basic abc")), null);
  assertEquals(bearerToken(withAuth("Bearer ")), null);
});

test("unauthorized is a 401 with the one JSON body", async () => {
  const res = unauthorized();
  assertEquals(res.status, 401);
  assertEquals(res.headers.get("content-type"), "application/json");
  assertEquals(await res.json(), { error: "unauthorized" });
});

test("tokens match only when equal, whatever their lengths", async () => {
  assert(await tokenMatches("s3cret", "s3cret"));
  assert(!(await tokenMatches("s3cre", "s3cret")));
  assert(!(await tokenMatches("s3cret-and-more", "s3cret")));
  assert(!(await tokenMatches("", "s3cret")));
});

test("the gate passes the right bearer and refuses every other with a 401", async () => {
  const gate = makeServiceGate("t0ken");
  assertEquals(await gate(withAuth("Bearer t0ken")), null);
  for (const value of [undefined, "Bearer t0ke", "Bearer t0ken0", "t0ken", "Bearer "]) {
    const res = await gate(withAuth(value));
    assertEquals(res?.status, 401, String(value));
  }
});

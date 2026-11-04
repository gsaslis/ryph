// Ids, tokens, and the hash-and-compare pair.

import { test } from "bun:test";
import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  hmacSha256Hex,
  ID_BODY,
  mintId,
  mintToken,
  sha256Hex,
  timingSafeEqual,
} from "../src/mod.ts";

test("an id is its prefix plus a UUIDv7 in lowercase Crockford base32 — slug-, path-, and branch-safe", () => {
  assertMatch(mintId("r"), /^r-[0-7][0-9a-hjkmnp-tv-z]{25}$/);
  assertMatch(mintId("pk"), /^pk-[0-7][0-9a-hjkmnp-tv-z]{25}$/);
  assert(mintId("r") !== mintId("r"));
});

test("an id minted in a later millisecond sorts after an earlier one", async () => {
  const earlier = mintId("r");
  await Bun.sleep(2);
  const later = mintId("r");
  assert(earlier < later, `${earlier} should sort before ${later}`);
});

test("an id's body carries the time it was minted", () => {
  const before = Date.now();
  const body = mintId("r").slice(2);
  const after = Date.now();
  let n = 0n;
  for (const c of body) n = (n << 5n) | BigInt("0123456789abcdefghjkmnpqrstvwxyz".indexOf(c));
  const ms = Number(n >> 80n);
  assert(before <= ms && ms <= after, `${ms} not in [${before}, ${after}]`);
});

test("ID_BODY matches a new id and a legacy 10-hex one", () => {
  const id = new RegExp(`^r-${ID_BODY}$`);
  assertMatch(mintId("r"), id);
  assertMatch("r-3f9a0c12e4", id);
});

test("a token is 256 bits of hex", () => {
  assertMatch(mintToken(), /^[0-9a-f]{64}$/);
  assert(mintToken() !== mintToken());
});

test("sha256Hex matches the known vector", async () => {
  assertEquals(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("hmacSha256Hex matches RFC 4231 case 2, as a string and as bytes", async () => {
  const expected = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
  const data = "what do ya want for nothing?";
  assertEquals(await hmacSha256Hex("Jefe", data), expected);
  assertEquals(await hmacSha256Hex("Jefe", new TextEncoder().encode(data)), expected);
});

test("timingSafeEqual: equal, unequal same length, unequal lengths", () => {
  assert(timingSafeEqual("deadbeef", "deadbeef"));
  assert(!timingSafeEqual("deadbeef", "deadbeeg"));
  assert(!timingSafeEqual("deadbeef", "deadbee"));
  assert(timingSafeEqual("", ""));
});

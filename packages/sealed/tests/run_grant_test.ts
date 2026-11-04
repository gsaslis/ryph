// A run grant: minted for one run and one person with one key, good until it expires, and nothing else.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { makeRunReadGate, mintRunGrant, runGrantOf, verifyRunGrant } from "../src/mod.ts";

const KEY = "history-token";
const T0 = new Date("2026-01-01T00:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

test("a grant verifies for its run, with its key, until it expires", async () => {
  const grant = await mintRunGrant(KEY, "r-1", "u-1", later(60_000));
  assert(await verifyRunGrant(KEY, grant, "r-1", "u-1", T0));
  assert(!await verifyRunGrant(KEY, grant, "r-2", "u-1", T0), "another run");
  assert(!await verifyRunGrant(KEY, grant, "r-1", "u-2", T0), "another person");
  assert(!await verifyRunGrant(KEY, grant, "r-1", null, T0), "nobody signed in");
  assert(!await verifyRunGrant("other-key", grant, "r-1", "u-1", T0), "another key");
  assert(!await verifyRunGrant(KEY, grant, "r-1", "u-1", later(60_000)), "expired");
  assert(!await verifyRunGrant(KEY, null, "r-1", "u-1", T0), "no grant");
  assert(!await verifyRunGrant(KEY, "not.a.grant", "r-1", "u-1", T0), "garbage");
  const [payload, signature] = grant.split(".");
  assert(!await verifyRunGrant(KEY, `${payload}x.${signature}`, "r-1", "u-1", T0), "tampered");
  // Auth off: minted for nobody, it verifies only for nobody.
  const open = await mintRunGrant(KEY, "r-1", null, later(60_000));
  assert(await verifyRunGrant(KEY, open, "r-1", null, T0));
  assert(!await verifyRunGrant(KEY, open, "r-1", "u-1", T0), "a null-subject grant names nobody");
});

test("the read gate takes the grant off the query, and falls back otherwise", async () => {
  const refused = new Response(null, { status: 403 });
  const unauthenticated = new Response(null, { status: 401 });
  // A stand-in for "any verified bearer": the bearer token IS the subject here, so
  // `Bearer reader` and `Bearer someone-else` both verify, unlike `fallback`'s capability check
  // below, which passes only for `Bearer reader`.
  // A bearer of the form `Bearer narrow:<sub>` verifies but holds only `checks:request`.
  const bearer = (req: Request) => {
    const header = req.headers.get("authorization");
    if (!header?.startsWith("Bearer ")) return Promise.resolve(unauthenticated);
    const token = header.slice(7);
    return Promise.resolve(
      token.startsWith("narrow:")
        ? { sub: token.slice(7), caps: ["checks:request"] }
        : token.startsWith("owner:")
        ? { sub: token.slice(6), caps: ["*"] }
        : { sub: token, caps: ["tasks:read", "patches:read"] },
    );
  };
  const gate = makeRunReadGate({
    grantKey: KEY,
    bearer,
    fallback: (req) =>
      Promise.resolve(req.headers.get("authorization") === "Bearer reader" ? null : refused),
    now: () => T0,
  });
  const grant = await mintRunGrant(KEY, "r-1", "someone-else", later(60_000));
  const url = `http://historian.test/v1/runs/r-1/events?after=1&grant=${encodeURIComponent(grant)}`;
  const withGrant = (headers?: HeadersInit) => new Request(url, { headers });
  assertEquals(runGrantOf(withGrant()), grant);

  // The grant alone — no bearer at all — is refused: it is scope proof, never identity
  // proof, so a URL holding one (logs, browser history, a copy-paste) opens nothing by itself.
  assertEquals(await gate(withGrant(), "r-1"), unauthenticated, "a grant with no bearer at all");
  // A valid grant PLUS a verified bearer for the person it was minted for passes, even one the
  // fallback capability would refuse.
  assertEquals(
    await gate(withGrant({ authorization: "Bearer someone-else" }), "r-1"),
    null,
    "a grant the fallback's capability check would have refused on its own",
  );
  // The grant's own person, with a token narrowed to something other than reading tasks, does
  // not ride it either: the fallback decides, and refuses.
  assertEquals(
    await gate(withGrant({ authorization: "Bearer narrow:someone-else" }), "r-1"),
    refused,
    "a bearer without tasks:read",
  );
  assertEquals(
    await gate(withGrant({ authorization: "Bearer owner:someone-else" }), "r-1"),
    null,
    "an owner's wildcard holds tasks:read",
  );
  // Another person's bearer does not ride the grant: the fallback decides for them.
  assertEquals(
    await gate(withGrant({ authorization: "Bearer stranger" }), "r-1"),
    refused,
    "the grant was minted for someone else",
  );
  assertEquals(
    await gate(withGrant({ authorization: "Bearer reader" }), "r-1"),
    null,
    "the fallback's capability passes on its own",
  );
  assertEquals(
    await gate(withGrant({ authorization: "Bearer someone-else" }), "r-2"),
    refused,
    "the grant names another run, so the fallback decides — and refuses",
  );
  assertEquals(await gate(new Request("http://historian.test/v1/runs/r-1/events"), "r-1"), refused);
  assertEquals(
    await gate(
      new Request("http://historian.test/v1/runs/r-1/events", {
        headers: { authorization: "Bearer reader" },
      }),
      "r-1",
    ),
    null,
  );
  const keyless = makeRunReadGate({
    grantKey: null,
    bearer,
    fallback: () => Promise.resolve(refused),
  });
  assertEquals(await keyless(withGrant(), "r-1"), refused, "no key, no grants");
});

test("with auth off, a grant minted for nobody passes with no bearer at all", async () => {
  const gate = makeRunReadGate({
    grantKey: KEY,
    bearer: () => Promise.resolve(null),
    fallback: () => Promise.resolve(new Response(null, { status: 403 })),
    now: () => T0,
  });
  const grant = await mintRunGrant(KEY, "r-1", null, later(60_000));
  const req = new Request(
    `http://historian.test/v1/runs/r-1/events?grant=${encodeURIComponent(grant)}`,
  );
  assertEquals(await gate(req, "r-1"), null);
});

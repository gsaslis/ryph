// A stream held open on an API token's bearer ends when the bearer does; a session's does not.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { endAtBearerExpiry, tokenBearerExpiresAt } from "../src/mod.ts";

const b64url = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (claims: Record<string, unknown>) =>
  `${b64url({ alg: "EdDSA" })}.${b64url(claims)}.sig`;
const withBearer = (token: string) =>
  new Request("http://historian.test/v1/runs/r-1/events/stream", {
    headers: { authorization: `Bearer ${token}` },
  });

test("an API token's expiry is read off its JWT, and nothing else has one", () => {
  assertEquals(
    tokenBearerExpiresAt(withBearer(jwt({ sub: "u-1", via: "token", exp: 1_000 }))),
    1_000_000,
  );
  assertEquals(
    tokenBearerExpiresAt(withBearer(jwt({ sub: "u-1", via: "session", exp: 1_000 }))),
    null,
    "a session's bearer is never cut",
  );
  assertEquals(tokenBearerExpiresAt(withBearer(jwt({ sub: "u-1", exp: 1_000 }))), null, "no via");
  assertEquals(tokenBearerExpiresAt(withBearer("opaque-run-token")), null);
  assertEquals(tokenBearerExpiresAt(withBearer(jwt({ sub: "u-1", via: "token" }))), null);
  assertEquals(tokenBearerExpiresAt(new Request("http://historian.test/")), null);
});

test("the stream ends cleanly at the bearer's expiry, and the source is cancelled", async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": open\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const now = Date.now();
  const res = endAtBearerExpiry(
    withBearer(jwt({ sub: "u-1", via: "token", exp: Math.floor((now + 50) / 1000) + 0.05 })),
    new Response(source, { headers: { "content-type": "text/event-stream" } }),
    () => now,
  );
  assertEquals(res.headers.get("content-type"), "text/event-stream");
  const text = await new Response(res.body).text(); // resolves only once the stream closes
  assertEquals(text, ": open\n\n");
  assert(cancelled, "the underlying stream's cleanup ran");
});

test("an already-expired token ends the stream at once; a session or no bearer leaves it alone", async () => {
  const forever = () => new ReadableStream<Uint8Array>({ start() {} });
  const expired = endAtBearerExpiry(
    withBearer(jwt({ sub: "u-1", via: "token", exp: 1 })),
    new Response(forever()),
  );
  assertEquals(await expired.text(), "");
  const untouched = new Response(forever());
  assert(endAtBearerExpiry(new Request("http://historian.test/"), untouched) === untouched);
  // A browser session's EventSource would reconnect with the same expired cookie and be refused
  // for good, so its stream is never cut.
  const session = new Response(forever());
  assert(
    endAtBearerExpiry(withBearer(jwt({ sub: "u-1", via: "session", exp: 1 })), session) ===
      session,
  );
});

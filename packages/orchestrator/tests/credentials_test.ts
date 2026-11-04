// helpers/credentials.ts: what the redaction takes out of a pod's log, and that it stays linear on
// the head's text — every check log goes through it, up to MAX_CHECK_LOG_BYTES each.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { proxyEnv, redactCredentials } from "../src/helpers/credentials.ts";
import { MAX_CHECK_LOG_BYTES } from "../src/core/check_types.ts";

test("check and build proxies bypass both loopbacks, including bracketed IPv6 literals", () => {
  const env = proxyEnv("http://proxy.test:3128", "cs-1", "claim");
  assertEquals(env.NO_PROXY, "localhost,127.0.0.1,::1,[::1]");
  assertEquals(env.no_proxy, env.NO_PROXY);
  assertEquals(env.HTTP_PROXY, "http://cs-1:claim@proxy.test:3128");
  assertEquals(env.HTTPS_PROXY, env.HTTP_PROXY);
  assertEquals(proxyEnv("not a URL", "cs-1", "claim"), {});
});

test("redaction takes out a URL's userinfo, a bare claim and an Authorization value", () => {
  const claim = `v1.${"A".repeat(40)}.${"B".repeat(43)}`;
  assertEquals(
    redactCredentials(`HTTPS_PROXY=http://cs-1:${claim}@proxy.test:3128`),
    "HTTPS_PROXY=http://[redacted]@proxy.test:3128",
  );
  assertEquals(redactCredentials(`git+ssh://user:pw@host/x`), "git+ssh://[redacted]@host/x");
  assertEquals(redactCredentials(`token ${claim} end`), "token [redacted] end");
  assertEquals(
    redactCredentials("Authorization: Basic eC1hY2Nlc3M6c2VjcmV0\nnext"),
    "Authorization: Basic [redacted]\nnext",
  );
  assertEquals(
    redactCredentials("authorization:bearer abc.def"),
    "authorization:bearer [redacted]",
  );
  // A path with an @ is not userinfo: the slash ends the look.
  assertEquals(redactCredentials("https://host/a@b"), "https://host/a@b");
  assertEquals(redactCredentials("plain text, no secrets"), "plain text, no secrets");
});

/** Runs `redactCredentials` on `text` and answers how long it took, in ms. */
const timed = (text: string) => {
  const t = performance.now();
  redactCredentials(text);
  return performance.now() - t;
};

test("redaction is linear on hostile text: a.a.a…, and every other pattern's worst case", () => {
  // A scheme pattern tried from every position took seconds on this (quadratic).
  const small = timed("a.".repeat(100_000));
  assert(small < 250, `200k chars of "a." took ${Math.round(small)} ms`);
  const half = MAX_CHECK_LOG_BYTES / 2;
  for (
    const [what, text] of [
      ["a.", "a.".repeat(half)],
      ["://a", "://a".repeat(MAX_CHECK_LOG_BYTES / 4)],
      ["v1.a-", "v1.a-".repeat(MAX_CHECK_LOG_BYTES / 5)],
      ["one long v1.", `v1.${"a".repeat(MAX_CHECK_LOG_BYTES)}`],
      ["authorization:", "authorization: ".repeat(MAX_CHECK_LOG_BYTES / 15)],
      ["authorization:basic", "authorization:basic ".repeat(MAX_CHECK_LOG_BYTES / 20)],
    ] as const
  ) {
    const ms = timed(text);
    assert(ms < 1_000, `4 MiB of ${what} took ${Math.round(ms)} ms`);
  }
});

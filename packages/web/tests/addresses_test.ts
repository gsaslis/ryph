// The URL guard, rule by rule (the address ranges are @ryph/shared/net's, tested there). Nothing
// here opens a socket: the resolver is a table, which is the whole reason the rules live in a
// pure module.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { checkFetchUrl } from "../src/core/addresses.ts";

const table = (map: Record<string, string[]>) => ({
  allowInsecure: false,
  resolve: (host: string) => Promise.resolve(map[host] ?? []),
});

const PUBLIC = table({ "example.com": ["93.184.216.34"] });

test("only http(s) URLs are fetched, and https unless insecure is allowed", async () => {
  for (const url of ["file:///etc/passwd", "gopher://example.com/", "data:text/html,<b>hi"]) {
    const verdict = await checkFetchUrl(url, PUBLIC);
    assert(!verdict.ok && verdict.reason === "scheme", url);
  }
  const insecure = await checkFetchUrl("http://example.com/", PUBLIC);
  assert(!insecure.ok && insecure.reason === "insecure");
  const opened = await checkFetchUrl("http://example.com/", {
    ...PUBLIC,
    allowInsecure: true,
  });
  assert(opened.ok);
});

test("userinfo in the URL is refused", async () => {
  const verdict = await checkFetchUrl("https://user:secret@example.com/", PUBLIC);
  assert(!verdict.ok && verdict.reason === "credentials_in_url");
  assert(!verdict.detail.includes("secret"), "the refusal must not echo the password");
});

test("a name that resolves into a private range is refused, and says which address", async () => {
  const verdict = await checkFetchUrl(
    "https://inside.example/",
    table({ "inside.example": ["93.184.216.34", "10.1.2.3"] }),
  );
  assert(!verdict.ok && verdict.reason === "blocked");
  assert(verdict.detail.includes("10.1.2.3"));
});

test("localhost, its subdomains and literals are refused without a lookup", async () => {
  for (const url of ["https://localhost/", "https://api.localhost/", "https://127.0.0.1/"]) {
    const verdict = await checkFetchUrl(url, table({}));
    assert(!verdict.ok && verdict.reason === "blocked", url);
  }
  const literalV6 = await checkFetchUrl("https://[::1]/", table({}));
  assert(!literalV6.ok && literalV6.reason === "blocked");
});

test("a name with no addresses is unresolvable, not allowed", async () => {
  const verdict = await checkFetchUrl("https://nowhere.example/", table({}));
  assert(!verdict.ok && verdict.reason === "unresolvable");
});

test("a resolver that throws counts as no addresses", async () => {
  const verdict = await checkFetchUrl("https://nowhere.example/", {
    allowInsecure: false,
    resolve: () => Promise.reject(new Error("dns is down")),
  });
  assert(!verdict.ok && verdict.reason === "unresolvable");
});

test("a public https URL passes, carrying the addresses it resolved to", async () => {
  const verdict = await checkFetchUrl("https://example.com/docs?q=1", PUBLIC);
  assert(verdict.ok);
  assertEquals(verdict.url.pathname, "/docs");
  assertEquals(verdict.addresses, ["93.184.216.34"]);
});

test("only the scheme's own port is fetched", async () => {
  const ok = await checkFetchUrl("https://example.com:443/x", PUBLIC);
  assert(ok.ok, "the default port, spelled out, is the default port");
  for (
    const url of ["https://example.com:8080/", "https://example.com:22/", "https://example.com:80/"]
  ) {
    const verdict = await checkFetchUrl(url, PUBLIC);
    assert(!verdict.ok && verdict.reason === "port", url);
    assert(verdict.detail.includes("443"), verdict.detail);
  }
  // With insecure fetches allowed, http's own port is 80 — and 443 is not http's.
  const insecure = { ...PUBLIC, allowInsecure: true };
  assert((await checkFetchUrl("http://example.com:80/", insecure)).ok);
  const wrong = await checkFetchUrl("http://example.com:8080/", insecure);
  assert(!wrong.ok && wrong.reason === "port");
});

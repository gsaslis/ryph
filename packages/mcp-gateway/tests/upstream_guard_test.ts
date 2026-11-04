// Where the gateway may dial: every range the guard refuses, every flag that widens it, and the
// resolver behind hostnames.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  checkUpstreamUrl as checkTarget,
  type UpstreamPolicy,
} from "../src/core/upstream_guard.ts";

/** The rule as it judges an operator-typed URL — a remote row's. */
const checkUpstreamUrl = (url: string, policy: UpstreamPolicy) =>
  checkTarget({ kind: "remote", slug: "s", url }, policy);

const strict = (resolve: UpstreamPolicy["resolve"]): UpstreamPolicy => ({
  allowInsecure: false,
  allowPrivate: false,
  resolve,
});
const publicDns = (host: string) =>
  Promise.resolve(host === "mcp.example.com" ? ["8.8.8.8", "2606:4700::1111"] : []);

test("a public https host that resolves is allowed", async () => {
  const v = await checkUpstreamUrl("https://mcp.example.com/mcp", strict(publicDns));
  assertEquals(v.ok, true);
});

test("malformed, non-http, plain http, and userinfo URLs are refused by shape", async () => {
  const policy = strict(publicDns);
  const reasons = await Promise.all([
    checkUpstreamUrl("not a url", policy),
    checkUpstreamUrl("ftp://mcp.example.com/", policy),
    checkUpstreamUrl("http://mcp.example.com/mcp", policy),
    checkUpstreamUrl("https://user:pw@mcp.example.com/mcp", policy),
  ]);
  assertEquals(
    reasons.map((r) => r.ok ? "ok" : r.reason),
    ["malformed", "scheme", "insecure", "credentials_in_url"],
  );
});

test("loopback, private, link-local, CGNAT and multicast literals are refused", async () => {
  const policy = strict(publicDns);
  for (
    const host of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.9",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // the cloud metadata address, the classic SSRF target
      "100.64.0.1",
      "224.0.0.1",
      "0.0.0.0",
      "[::1]",
      "[fc00::1]",
      "[fe80::1]",
      "[::ffff:10.0.0.1]",
      "localhost",
      "internal.localhost",
    ]
  ) {
    const v = await checkUpstreamUrl(`https://${host}/mcp`, policy);
    assertEquals(v.ok ? "ok" : v.reason, "private", host);
  }
  // …and their public neighbours are not.
  for (const host of ["172.32.0.1", "8.8.8.8", "[2606:4700::1111]", "100.128.0.1"]) {
    assertEquals((await checkUpstreamUrl(`https://${host}/mcp`, policy)).ok, true, host);
  }
});

test("a name that resolves to ANY private address is refused; one that does not resolve too", async () => {
  const mixed = strict(() => Promise.resolve(["8.8.8.8", "10.0.0.5"]));
  const v = await checkUpstreamUrl("https://sneaky.example/mcp", mixed);
  assertEquals(v.ok ? "ok" : v.reason, "private");

  const none = strict(() => Promise.resolve([]));
  assertEquals(
    (await checkUpstreamUrl("https://nowhere.example/mcp", none)).ok ? "ok" : "unresolvable",
    "unresolvable",
  );
  const throwing = strict(() => Promise.reject(new Error("NXDOMAIN")));
  const t = await checkUpstreamUrl("https://nowhere.example/mcp", throwing);
  assertEquals(t.ok ? "ok" : t.reason, "unresolvable");
});

test("the flags widen exactly what they name", async () => {
  const insecure: UpstreamPolicy = { ...strict(publicDns), allowInsecure: true };
  assertEquals((await checkUpstreamUrl("http://mcp.example.com/mcp", insecure)).ok, true);
  assertEquals((await checkUpstreamUrl("http://10.0.0.1/mcp", insecure)).ok, false);

  const internal: UpstreamPolicy = { ...strict(publicDns), allowPrivate: true };
  assertEquals((await checkUpstreamUrl("https://10.0.0.1/mcp", internal)).ok, true);
  assertEquals((await checkUpstreamUrl("https://localhost/mcp", internal)).ok, true);
  // …but never the shape rules.
  assertEquals((await checkUpstreamUrl("http://10.0.0.1/mcp", internal)).ok, false);
});

test("special-use ranges some networks route internally are refused, not taken for public", async () => {
  const policy = strict(publicDns);
  for (
    const host of [
      "192.0.0.8", // IETF protocol assignments
      "192.0.2.1", // TEST-NET-1
      "192.88.99.1", // 6to4 relay anycast
      "198.18.0.1", // benchmarking — routed internally in some deployments
      "198.19.255.255",
      "198.51.100.7", // TEST-NET-2
      "203.0.113.10", // TEST-NET-3
      "240.0.0.1", // reserved
      "[2001:db8::1]", // documentation
      "[3fff::1]", // documentation
      "[2001::1]", // Teredo
      "[2002:a00:1::]", // 6to4, wrapping 10.0.0.1
      "[64:ff9b::a00:1]", // NAT64, wrapping 10.0.0.1
      "[100::1]", // discard
    ]
  ) {
    const v = await checkUpstreamUrl(`https://${host}/mcp`, policy);
    assertEquals(v.ok ? "ok" : v.reason, "private", host);
  }
  // …and the neighbours just outside each block are public.
  for (
    const host of ["192.0.3.1", "198.17.255.255", "198.20.0.1", "203.0.114.1", "[2001:4860::1]"]
  ) {
    assertEquals((await checkUpstreamUrl(`https://${host}/mcp`, policy)).ok, true, host);
  }
  // A name is judged by what it resolves to, so a record pointing into one refuses the name.
  const benchmark = strict(() => Promise.resolve(["198.18.4.2"]));
  const v = await checkUpstreamUrl("https://looks-public.example/mcp", benchmark);
  assertEquals(v.ok ? "ok" : v.reason, "private");
});

test("a hosted row never passes: it is dialled at its launch key, never at its url", async () => {
  for (
    const url of [
      "http://127.0.0.1:54321/grafana/mcp",
      `http://127.0.0.1:54321/${"a".repeat(32)}/mcp`,
      "https://mcp.example.com/mcp",
      "hosted://grafana",
    ]
  ) {
    const v = await checkTarget(
      { kind: "hosted", slug: "grafana", url },
      { ...strict(publicDns), allowPrivate: true, allowInsecure: true },
    );
    // The flags are about operator-typed URLs; they open nothing for a hosted row.
    assertEquals(v.ok ? "ok" : v.reason, "hosted", url);
  }
});

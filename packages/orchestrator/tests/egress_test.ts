// Egress, end to end as pure functions: a ceiling and a blueprint in, either a frozen allowlist
// or a refusal an operator can act on — and then the token that carries it, verified by the
// PROXY'S OWN CODE.
//
// That last part is the point of this file living here. The control plane mints the claim and
// images/egress-proxy/main.ts verifies it, and the two cannot import each other (the proxy is a
// standalone `deno compile` target with no workspace deps). The tool guard has the same split
// and the same answer: the suite on this side drives both halves, so a change to the format that
// breaks the pair fails here rather than in a run that cannot install anything.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  appendRefusal,
  bundleCovering,
  DEFAULT_EGRESS_BUNDLES,
  DEFAULT_EGRESS_POLICY,
  EGRESS_BUNDLES,
  egressKeyFromEnv,
  type EgressPolicy,
  egressPolicyFromEnv,
  egressRefusalDetail,
  egressRefusalNote,
  expandBundles,
  hostCovered,
  hostRefusal,
  MAX_EGRESS_REFUSALS,
  mintEgressToken,
  resolveNetworkScope,
  verifyEgressToken,
} from "../src/core/egress.ts";
import {
  addressRefused,
  forwardableHeaders,
  hostAllowed,
  inwardRefusal,
  makeProxy,
  makeRefusalReporter,
  parseAuthority,
  parseProxyAuth,
  parseSni,
  refusalFor,
  verifyToken,
} from "../../../images/egress-proxy/main.ts";
import { unwiredEgressWarning } from "../src/core/egress.ts";
import net from "node:net";
import { Buffer } from "node:buffer";

const KEY = new Uint8Array(32).fill(7);
const CEILING: EgressPolicy = {
  mode: "proxy",
  bundles: ["npm", "pypi"],
  hosts: [],
  proxyUrl: "http://egress-proxy.ryph-egress.svc:7460",
};

const failing = (message: string): never => {
  throw new Error(message);
};

test("a null policy gets the deployment's whole ceiling", () => {
  const resolved = resolveNetworkScope(null, CEILING);
  assert(resolved.kind === "ok");
  assertEquals(resolved.scope.mode, "proxy");
  assertEquals(resolved.scope.bundles, ["npm", "pypi"]);
  // Expanded, not the bundle names: the proxy compares hostnames and knows no bundles.
  assert(resolved.scope.hosts.includes("registry.npmjs.org"));
  assert(resolved.scope.hosts.includes("files.pythonhosted.org"));
});

test("an agent narrows the ceiling", () => {
  const resolved = resolveNetworkScope({ bundles: ["npm"], hosts: [] }, CEILING);
  assert(resolved.kind === "ok");
  assertEquals(resolved.scope.bundles, ["npm"]);
  assert(!resolved.scope.hosts.includes("pypi.org"), "pypi survived a narrowing to npm");
});

test("an agent cannot widen past the ceiling, and the refusal names the switch", () => {
  const resolved = resolveNetworkScope({ bundles: ["npm", "cargo"], hosts: [] }, CEILING);
  assert(resolved.kind === "refused");
  assertStringIncludes(resolved.error, "cargo");
  assertStringIncludes(resolved.error, "RYPH_EGRESS_BUNDLES");
});

test("a raw host outside the ceiling is refused too", () => {
  const resolved = resolveNetworkScope({ bundles: [], hosts: ["evil.example.com"] }, CEILING);
  assert(resolved.kind === "refused");
  assertStringIncludes(resolved.error, "evil.example.com");
});

test("a raw host the ceiling already permits is allowed", () => {
  const ceiling: EgressPolicy = { ...CEILING, hosts: ["internal.example.com"] };
  const resolved = resolveNetworkScope({ bundles: [], hosts: ["internal.example.com"] }, ceiling);
  assert(resolved.kind === "ok");
  assertEquals(resolved.scope.hosts, ["internal.example.com"]);
});

test("two empty lists are a real answer: an agent with no internet at all", () => {
  const resolved = resolveNetworkScope({ bundles: [], hosts: [] }, CEILING);
  assert(resolved.kind === "ok");
  assertEquals(resolved.scope.hosts, []);
});

test("an open deployment freezes `open` rather than a null anyone could misread", () => {
  const resolved = resolveNetworkScope({ bundles: ["npm"], hosts: [] }, {
    ...CEILING,
    mode: "open",
  });
  assert(resolved.kind === "ok");
  assertEquals(resolved.scope, { mode: "open", bundles: [], hosts: [] });
});

test("every catalogue bundle expands, and the default set is a subset of it", () => {
  for (const bundle of EGRESS_BUNDLES) {
    const expanded = expandBundles([bundle.id]);
    assert(expanded.kind === "ok", `${bundle.id} did not expand`);
    assert(expanded.hosts.length > 0, `${bundle.id} expands to nothing`);
    for (const host of expanded.hosts) {
      assertEquals(hostRefusal(host), null, `${bundle.id} carries a host the rules refuse`);
    }
  }
  for (const id of DEFAULT_EGRESS_BUNDLES) {
    assert(EGRESS_BUNDLES.some((b) => b.id === id), `the default set names an absent bundle ${id}`);
  }
});

test("a new deployment allows every catalogue bundle", () => {
  // A first run installs whatever its repo pins with no Internet access setup. A bundle kept
  // off would need its reason on DEFAULT_EGRESS_BUNDLES and in its description.
  assertEquals([...DEFAULT_EGRESS_BUNDLES].sort(), EGRESS_BUNDLES.map((b) => b.id).sort());
});

test("the default ceiling covers what a lockfile install of each ecosystem reaches", () => {
  const expanded = expandBundles(DEFAULT_EGRESS_BUNDLES);
  assert(expanded.kind === "ok");
  // One host per ecosystem the default set vouches for, each the one a run actually dials first.
  // `jsr.io` is here because it was NOT: a Deno workspace installing from its own lockfile got a
  // 403 in the middle of `deno install`, which is the failure this whole catalogue exists to
  // prevent and the only kind a test can notice before a run does.
  // `nodejs.org` and `mise-versions.jdx.dev` are here because they were not: the first build of a
  // repo pinning Node through `mise.toml` was refused both before it installed anything.
  for (
    const host of [
      "registry.npmjs.org",
      "jsr.io",
      "pypi.org",
      "deb.debian.org",
      "nodejs.org",
      "mise-versions.jdx.dev",
    ]
  ) {
    assert(hostCovered(host, expanded.hosts), `the default ceiling does not cover ${host}`);
  }
});

test("the version-manager bundles cover what a pinned toolchain install dials", () => {
  // One host per bundle, each the one the universal image's version managers reach first: a
  // `rust-toolchain.toml` pin, a `.nvmrc`, and mise resolving a version before it downloads.
  const cases: Array<[string, string[]]> = [
    ["rustup", ["static.rust-lang.org"]],
    ["node-dist", ["nodejs.org"]],
    // get.helm.sh: aqua's helm package downloads from Helm's own host, not a GitHub release.
    ["mise", [
      "mise.jdx.dev",
      "mise-versions.jdx.dev",
      "api.github.com",
      "github.com",
      "get.helm.sh",
    ]],
  ];
  for (const [id, hosts] of cases) {
    const expanded = expandBundles([id]);
    assert(expanded.kind === "ok", `${id} is not in the catalogue`);
    for (const host of hosts) {
      assert(hostCovered(host, expanded.hosts), `${id} does not cover ${host}`);
    }
  }
  // mise's backends download release assets through the same hosts `github-releases` vouches
  // for; a mise bundle narrower than that would pass `mise ls-remote` and fail the download.
  const mise = expandBundles(["mise"]);
  const releases = expandBundles(["github-releases"]);
  assert(mise.kind === "ok" && releases.kind === "ok");
  for (const host of releases.hosts) {
    assert(mise.hosts.includes(host), `mise is missing the github-releases host ${host}`);
  }
  // Default-on: an environment build installs the toolchain through these same hosts, and so
  // does a run that starts before its environment is ready.
  for (const id of ["rustup", "node-dist", "mise"]) {
    assert(DEFAULT_EGRESS_BUNDLES.includes(id), `${id} is not in the default set`);
  }
});

test("the playwright bundle covers both mirrors `playwright install` walks", () => {
  const expanded = expandBundles(["playwright"]);
  assert(expanded.kind === "ok", "playwright is not in the catalogue");
  // playwright-core's `PLAYWRIGHT_CDN_MIRRORS`, in the order it tries them. The second is only
  // ever dialled when the first fails, so a bundle carrying one of them installs browsers fine
  // until the day it does not, and then fails as if the release were missing.
  for (const host of ["cdn.playwright.dev", "playwright.download.prss.microsoft.com"]) {
    assert(hostCovered(host, expanded.hosts), `playwright does not cover ${host}`);
  }
  // The package comes from the registry and the `--with-deps` libraries from apt: both are other
  // bundles' business, and copying their hosts in here would be a second place to keep current.
  for (const id of ["npm", "debian"]) {
    const other = expandBundles([id]);
    assert(other.kind === "ok");
    for (const host of other.hosts) {
      assert(!expanded.hosts.includes(host), `playwright duplicates the ${id} host ${host}`);
    }
  }
  // Default-on: an `npm` ceiling installs `@playwright/test` and then fails on the very next
  // command, which is the shape of failure the default set exists to keep out.
  assert(DEFAULT_EGRESS_BUNDLES.includes("playwright"), "playwright is not in the default set");
  const ceiling = expandBundles(DEFAULT_EGRESS_BUNDLES);
  assert(ceiling.kind === "ok");
  assert(hostCovered("cdn.playwright.dev", ceiling.hosts));
});

test("an unknown bundle names what this deployment offers", () => {
  const expanded = expandBundles(["nope"]);
  assert(expanded.kind === "refused");
  assertStringIncludes(expanded.error, "npm");
});

test("hostRefusal takes hostnames and nothing that looks like one", () => {
  assertEquals(hostRefusal("registry.npmjs.org"), null);
  assertEquals(hostRefusal("*.githubusercontent.com"), null);
  // A URL, a port and an address are each the IP-layer confusion this design refuses.
  assert(hostRefusal("https://registry.npmjs.org") !== null);
  assert(hostRefusal("registry.npmjs.org:443") !== null);
  assert(hostRefusal("10.0.0.0/8") !== null);
  // A bare label is almost always a mistake for a hostname, and a dangerous one.
  assert(hostRefusal("localhost") !== null);
  assert(hostRefusal("*") !== null);
});

test("RYPH_EGRESS defaults to proxy, and `off` is not a spelling", () => {
  const empty = egressPolicyFromEnv(() => undefined, failing);
  assertEquals(empty.mode, "proxy");
  assertEquals(empty.bundles, [...DEFAULT_EGRESS_BUNDLES]);
  assertEquals(empty.proxyUrl, null);
  assertEquals(DEFAULT_EGRESS_POLICY.mode, "proxy");

  let refused = "";
  try {
    egressPolicyFromEnv((n) => (n === "RYPH_EGRESS" ? "off" : undefined), failing);
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  assertStringIncludes(refused, "RYPH_EGRESS");
});

test("the key must be long enough, and is never echoed", () => {
  assertEquals(egressKeyFromEnv(() => undefined, failing), null);
  const key = egressKeyFromEnv(() => "ab".repeat(32), failing);
  assertEquals(key?.length, 32);
  let refused = "";
  try {
    egressKeyFromEnv(() => "abcd", failing);
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  assertStringIncludes(refused, "RYPH_EGRESS_KEY");
  assert(!refused.includes("abcd"), "the refusal echoed the key");
});

// ── refusals: the bundle hint, the record's caps, and the reporter ────────────────────

test("the bundle hint resolves a known host and degrades on an unknown one", () => {
  // The exact host the live deployment was refused, and the whole reason the hint exists: the
  // Deno bundle carries `dl.deno.land` because a RELEASE comes from there, not just modules.
  assertEquals(bundleCovering("dl.deno.land")?.id, "deno");
  assertEquals(bundleCovering("DL.DENO.LAND.")?.id, "deno", "not normalized before the lookup");
  // Through a wildcard entry, read exactly as the proxy reads it.
  assertEquals(bundleCovering("objects.githubusercontent.com")?.id, "github-releases");
  // No bundle is a real answer, not a failure: it is what sends an admin to the hosts field.
  assertEquals(bundleCovering("nobody.example.test"), null);
  assertEquals(bundleCovering(""), null);
  assertEquals(bundleCovering("   "), null);
});

test("the remedy says ADMIN whichever half of it applies", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const known = egressRefusalDetail({ host: "dl.deno.land", port: 443, at });
  assertStringIncludes(known, "an admin can allow it");
  assertStringIncludes(known, "Deno & JSR");
  const unknown = egressRefusalDetail({ host: "nobody.example.test", port: 80, at });
  assertStringIncludes(unknown, "no bundle in the catalogue covers it");
  assertStringIncludes(unknown, "an admin can add it by name");

  assertEquals(egressRefusalNote([], "run"), null);
  const note = egressRefusalNote([{ host: "dl.deno.land", port: 443, at }], "build")!;
  // A BUILD's wording is the one that has to carry the part nobody expects: it may have
  // succeeded anyway.
  assertStringIncludes(note, "may have finished anyway");
  assertStringIncludes(note, "an admin can allow it");
});

test("appendRefusal dedupes on host AND port, and drops past the cap", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const one = appendRefusal(null, { host: "dl.deno.land", port: 443, at })!;
  assertEquals(one.length, 1);
  // The same name in another spelling is the same grant.
  assertEquals(appendRefusal(one, { host: "DL.DENO.LAND.", port: 443, at }), null);
  // The same name on another port is not.
  assertEquals(appendRefusal(one, { host: "dl.deno.land", port: 80, at })!.length, 2);

  let held = one;
  for (let i = 0; i < MAX_EGRESS_REFUSALS * 3; i++) {
    held = appendRefusal(held, { host: `h${i}.example.test`, port: 443, at }) ?? held;
  }
  assertEquals(held.length, MAX_EGRESS_REFUSALS);
  // Dropped, not evicted: the first hosts are the ones that explain the failure.
  assertEquals(held[0].host, "dl.deno.land");
});

// The reporter is the proxy's half of the cap, and it is the half that matters: the control
// plane's bound is a backstop, while this one is what keeps a loop in one run from being a POST
// per attempt at a process every run in the deployment shares.

/** A `fetch` that records what it was asked and answers whatever the test says. */
function recordingFetch(answer: () => Response) {
  const calls: Array<{ url: string; token: string; body: { host: string; port: number } }> = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      token: String((init?.headers as Record<string, string>)?.authorization ?? ""),
      body: JSON.parse(String(init?.body)),
    });
    return Promise.resolve(answer());
  }) as unknown as typeof globalThis.fetch;
  return { calls, fn };
}

/** The reports are fire-and-forget, so a test has to let the microtasks run before it looks. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("the reporter dedupes per claim, caps the hosts, and caps the claims", async () => {
  const { calls, fn } = recordingFetch(() => new Response(null, { status: 204 }));
  const reporter = makeRefusalReporter("http://control-plane.test:7411/", {
    fetch: fn,
    maxPerSubject: 3,
    maxSubjects: 2,
  });

  for (let i = 0; i < 5; i++) reporter.report("r-1", "tok-1", "dl.deno.land", 443);
  await settled();
  assertEquals(calls.length, 1, "the same host was reported more than once");
  assertEquals(calls[0].url, "http://control-plane.test:7411/v1/egress/refusals");
  // The subject's own claim, not a credential of the proxy's: that is the whole design.
  assertEquals(calls[0].token, "Bearer tok-1");
  assertEquals(calls[0].body, { host: "dl.deno.land", port: 443 });

  // A loop discovering a new name per attempt stops at the cap.
  for (let i = 0; i < 50; i++) reporter.report("r-1", "tok-1", `h${i}.example.test`, 443);
  await settled();
  assertEquals(calls.length, 3);

  // And the table of claims is bounded too, oldest evicted: two more subjects push `r-1` out,
  // which costs one re-report and nothing else.
  reporter.report("r-2", "tok-2", "a.example.test", 443);
  reporter.report("r-3", "tok-3", "b.example.test", 443);
  reporter.report("r-1", "tok-1", "dl.deno.land", 443);
  await settled();
  assertEquals(calls.length, 6);
  assertEquals(calls[5].body.host, "dl.deno.land");
});

test("a subject the control plane calls ended is never reported for again", async () => {
  const { calls, fn } = recordingFetch(() => new Response(null, { status: 410 }));
  const reporter = makeRefusalReporter("http://control-plane.test:7411", { fetch: fn });
  reporter.report("r-1", "tok-1", "a.example.test", 443);
  await settled();
  assertEquals(calls.length, 1);
  for (let i = 0; i < 20; i++) reporter.report("r-1", "tok-1", `h${i}.example.test`, 443);
  await settled();
  assertEquals(calls.length, 1, "a run that has ended kept being reported at");
  // Another subject is unaffected — the write-off is per claim.
  reporter.report("r-2", "tok-2", "a.example.test", 443);
  await settled();
  assertEquals(calls.length, 2);
});

test("a control plane that fails, hangs or answers nonsense never reaches the caller", async () => {
  const { calls, fn } = recordingFetch(() => {
    throw new Error("connection refused");
  });
  const reporter = makeRefusalReporter("http://control-plane.test:7411", { fetch: fn });
  // The point is that this line does not throw and does not need awaiting.
  reporter.report("r-1", "tok-1", "a.example.test", 443);
  await settled();
  assertEquals(calls.length, 1);
  // A failure is not a write-off: the next DISTINCT host is still worth a try.
  reporter.report("r-1", "tok-1", "b.example.test", 443);
  await settled();
  assertEquals(calls.length, 2);
});

// ── the wire contract with images/egress-proxy/main.ts ─────────────────────────────────────────

test("a minted token verifies in the proxy, with its allowlist intact", async () => {
  const hosts = ["registry.npmjs.org", "*.githubusercontent.com"];
  const token = await mintEgressToken(KEY, { runId: "r_1", expiresAt: 4_000, hosts });
  const claim = await verifyToken(token, KEY, 3_999);
  assert(claim !== null, "the proxy rejected a token this control plane minted");
  assertEquals(claim.runId, "r_1");
  assertEquals(claim.hosts, hosts);
});

test("the control plane reads back exactly what the proxy reads", async () => {
  // Both halves verify the same claim, because the refusal REPORT is authenticated with the
  // subject's own token: the proxy presents it, the control plane reads the subject off it.
  const token = await mintEgressToken(KEY, {
    runId: "env-1",
    expiresAt: 4_000,
    hosts: ["registry.npmjs.org"],
  });
  assertEquals(await verifyEgressToken(token, KEY, 3_999), await verifyToken(token, KEY, 3_999));
  assertEquals((await verifyEgressToken(token, KEY, 3_999))?.runId, "env-1");
  // And they refuse the same things, silently and identically.
  assertEquals(await verifyEgressToken(token, KEY, 4_000), null);
  assertEquals(await verifyEgressToken(token, new Uint8Array(32).fill(9), 1), null);
  for (const bad of ["", "v1", "v1.a.b", "v2.a.b", "....", "v1..", "not a token"]) {
    assertEquals(await verifyEgressToken(bad, KEY, 1), null, `threw or accepted ${bad}`);
  }
});

test("an expired token is refused", async () => {
  const token = await mintEgressToken(KEY, { runId: "r_1", expiresAt: 100, hosts: [] });
  assertEquals(await verifyToken(token, KEY, 100), null);
  assertEquals(await verifyToken(token, KEY, 101), null);
});

test("another key's token is refused", async () => {
  const token = await mintEgressToken(KEY, { runId: "r_1", expiresAt: 4_000, hosts: [] });
  assertEquals(await verifyToken(token, new Uint8Array(32).fill(9), 1), null);
});

test("an edited allowlist invalidates the signature", async () => {
  const token = await mintEgressToken(KEY, {
    runId: "r_1",
    expiresAt: 4_000,
    hosts: ["registry.npmjs.org"],
  });
  const [version, _payload, signature] = token.split(".");
  // The run rewrites its own claim to name a host it was never granted. This is the attack the
  // signature exists for: the token STATES the policy, so it must not be able to lie about it.
  const forged = btoa(JSON.stringify({ r: "r_1", e: 4_000, h: ["evil.example.com"] }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  assertEquals(await verifyToken(`${version}.${forged}.${signature}`, KEY, 1), null);
});

test("garbage is refused rather than thrown on", async () => {
  for (const token of ["", "v1", "v1.a.b", "v2.a.b", "....", "v1..", "not a token"]) {
    assertEquals(await verifyToken(token, KEY, 1), null, `threw or accepted ${token}`);
  }
});

test("hostAllowed: exact, case-insensitive, trailing dot, and wildcards", () => {
  const allowed = ["registry.npmjs.org", "*.githubusercontent.com"];
  assert(hostAllowed("registry.npmjs.org", allowed));
  assert(hostAllowed("REGISTRY.NPMJS.ORG", allowed));
  assert(hostAllowed("registry.npmjs.org.", allowed));
  assert(hostAllowed("objects.githubusercontent.com", allowed));
  assert(hostAllowed("a.b.githubusercontent.com", allowed));
  // A wildcard is not a grant of the bare domain — reading it that way would hand out more
  // than the operator ticked.
  assert(!hostAllowed("githubusercontent.com", allowed));
  // And the classic suffix walk-past: `evilnpmjs.org` must not satisfy `npmjs.org`.
  assert(!hostAllowed("evilgithubusercontent.com", allowed));
  assert(!hostAllowed("registry.npmjs.org.evil.example", allowed));
  assert(!hostAllowed("", allowed));
});

test("a refusal names the host and points at the fix", () => {
  const claim = { runId: "r_1", expiresAt: 4_000, hosts: ["registry.npmjs.org"] };
  const refusal = refusalFor("evil.example", 443, claim);
  assert(refusal !== null);
  assertStringIncludes(refusal, "evil.example");
  assertStringIncludes(refusal, "registry.npmjs.org");
  assertEquals(refusalFor("registry.npmjs.org", 443, claim), null);
  // Only 80 and 443: an allowlisted host is not a licence to open any port on it.
  assert(refusalFor("registry.npmjs.org", 22, claim) !== null);
});

test("an empty allowlist says so rather than listing nothing", () => {
  const refusal = refusalFor("registry.npmjs.org", 443, {
    runId: "r_1",
    expiresAt: 4_000,
    hosts: [],
  });
  assert(refusal !== null);
  assertStringIncludes(refusal, "no egress allowlist");
});

test("parseAuthority reads what a CONNECT line carries", () => {
  assertEquals(parseAuthority("registry.npmjs.org:443", 443), {
    host: "registry.npmjs.org",
    port: 443,
  });
  assertEquals(parseAuthority("registry.npmjs.org", 443), {
    host: "registry.npmjs.org",
    port: 443,
  });
  assertEquals(parseAuthority("[::1]:8080", 443), { host: "::1", port: 8080 });
  assertEquals(parseAuthority("bad host:443", 443), null);
  assertEquals(parseAuthority("host:99999", 443), null);
});

test("parseProxyAuth reads the run id and token out of Basic", () => {
  const header = `Basic ${btoa("r_1:v1.payload.sig")}`;
  assertEquals(parseProxyAuth(header), { runId: "r_1", token: "v1.payload.sig" });
  assertEquals(parseProxyAuth(undefined), null);
  assertEquals(parseProxyAuth("Bearer something"), null);
  assertEquals(parseProxyAuth(`Basic ${btoa("nocolon")}`), null);
});

// ── The server, and not only its policy ────────────────────────────────────────────────────
//
// Everything above drives pure functions: that is most of the policy and none of the process.
// These drive `makeProxy` over a real socket, because the failure they exist to catch is not a
// wrong ANSWER — it is the proxy dying while giving the right one. A refused run resets its
// connection, node raises `error` on a socket whose handler had not been attached yet, and an
// unhandled `error` ends the process: on Kubernetes the single replica every run's installs
// cross, and in the single binary the control plane, the model proxy and the MCP gateway with it.

const silent = { refused: () => {}, allowed: () => {} };

/** A live proxy on an ephemeral loopback port, closed however the body ends. */
async function withProxy(
  opts: Partial<Parameters<typeof makeProxy>[0]>,
  body: (port: number) => Promise<void>,
): Promise<void> {
  // A short hello window by default: the tests that never send a ClientHello would otherwise
  // each spend the real ten seconds waiting for one.
  const server = makeProxy({ key: KEY, log: silent, helloTimeoutMs: 250, ...opts });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    await body(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A claim good for ten minutes, carrying whatever hosts the test is about. */
function claimFor(hosts: string[]): Promise<string> {
  return mintEgressToken(KEY, {
    runId: "r_1",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    hosts,
  });
}

/** Writes one request and returns the proxy's answer, up to the end of the headers. */
function ask(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    let text = "";
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error("the proxy never answered"));
    });
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      text += String(chunk);
      if (text.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(text);
      }
    });
    socket.once("connect", () => socket.write(request));
  });
}

const connectLine = (target: string, auth: string) =>
  `CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n` +
  `proxy-authorization: Basic ${btoa(auth)}\r\n\r\n`;

test("a run that resets mid-refusal does not take the proxy with it", async () => {
  await withProxy({}, async (port) => {
    const token = await claimFor(["registry.npmjs.org"]);
    // The window that used to be fatal: CONNECT to a host the claim does not carry, then reset
    // before reading the 403. No error handler was attached to this socket until after a
    // SUCCESSFUL dial, so the reset reached an emitter with none — and in node that is a throw.
    const rude = net.connect({ port, host: "127.0.0.1" });
    rude.on("error", () => {});
    await new Promise<void>((resolve) => rude.once("connect", () => resolve()));
    rude.write(connectLine("evil.example:443", `r_1:${token}`));
    rude.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The assertion is not about that socket: it is that the LISTENER is still here. Before the
    // fix this line never ran, because the test process itself was already gone.
    assertStringIncludes(
      await ask(port, connectLine("evil.example:443", `r_1:${token}`)),
      "403",
    );
  });
});

test("a CONNECT carrying no claim is answered 407", async () => {
  await withProxy({}, async (port) => {
    const answer = await ask(
      port,
      "CONNECT registry.npmjs.org:443 HTTP/1.1\r\nhost: registry.npmjs.org:443\r\n\r\n",
    );
    assertStringIncludes(answer, "407");
    assertStringIncludes(answer, "proxy-authenticate");
  });
});

test("an allowed CONNECT opens the tunnel", async () => {
  // A stand-in for the internet: the dial is injected, so this pins the proxy's own behaviour
  // rather than the network's.
  const upstream = net.createServer((socket) => socket.end("hello"));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamPort = (upstream.address() as { port: number }).port;
  try {
    await withProxy({
      dial: () =>
        new Promise((resolve) => {
          const socket = net.connect({ port: upstreamPort, host: "127.0.0.1" });
          socket.once("connect", () => resolve(socket));
        }),
    }, async (port) => {
      const token = await claimFor(["registry.npmjs.org"]);
      const answer = await ask(port, connectLine("registry.npmjs.org:443", `r_1:${token}`));
      assertStringIncludes(answer, "200 Connection Established");
    });
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("an absolute https: request is refused rather than downgraded", async () => {
  await withProxy({}, async (port) => {
    const token = await claimFor(["registry.npmjs.org"]);
    // Forwarding this would open a PLAINTEXT hop to port 443 carrying the client's own headers,
    // an Authorization among them. Nothing legitimate arrives this way — an https client
    // CONNECTs — so the allowlisted host does not make it safe.
    const answer = await ask(
      port,
      `GET https://registry.npmjs.org/left-pad HTTP/1.1\r\nhost: registry.npmjs.org\r\n` +
        `proxy-authorization: Basic ${btoa(`r_1:${token}`)}\r\n\r\n`,
    );
    assertStringIncludes(answer, "400");
    assertStringIncludes(answer, "CONNECT");
  });
});

test("hop-by-hop headers are stripped, the Connection list included", () => {
  const forwarded = forwardableHeaders({
    "host": "registry.npmjs.org",
    "proxy-authorization": "Basic secret",
    "proxy-connection": "keep-alive",
    "transfer-encoding": "chunked",
    "te": "trailers",
    "upgrade": "websocket",
    "connection": "keep-alive, x-custom-hop",
    "x-custom-hop": "gone",
    "accept": "*/*",
  });
  // RFC 9110 §7.6.1. A client-chosen framing header sitting beside the one node computes for
  // itself is exactly the disagreement between two parsers that smuggling is built out of.
  for (
    const name of [
      "proxy-authorization",
      "proxy-connection",
      "transfer-encoding",
      "te",
      "upgrade",
      "connection",
      "x-custom-hop",
    ]
  ) {
    assertEquals(forwarded[name], undefined, `${name} was forwarded`);
  }
  assertEquals(forwarded.accept, "*/*");
  // `host` goes too, and NOT because it is hop-by-hop. Node only synthesizes a `Host` when the
  // caller passed none, so a forwarded one rides the connection this proxy opened to the URL's
  // hostname: `GET http://deb.debian.org/x` with `Host: evil.example` reaches the allowlisted
  // host's shared CDN address and asks it for the attacker's vhost, past an allowlist that only
  // ever read the URL — and the trail would record the allowlisted name as the destination.
  assertEquals(forwarded.host, undefined);
});

test("an allowed name may not resolve back into the network", () => {
  // The proxy is a way OUT. A hijacked record — or an operator's own typo — pointing at
  // loopback, the LAN or a metadata server is how it would become a way in, and the binary
  // serves this in-process beside a control plane listening on localhost.
  for (
    const address of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "172.16.0.9",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fd00::1",
      "ff02::1",
      "not-an-address", // unreadable is refused, never waved through
    ]
  ) {
    assert(addressRefused(address), `${address} would have been dialled`);
  }
  // Credential vendors, three of which sit at addresses with nothing about them to suggest it.
  // Same prize as the famous one: whatever asks from inside the machine is answered.
  for (
    const address of [
      "169.254.169.254", // AWS, GCP
      "100.100.100.200", // Alibaba
      "168.63.129.16", // Azure's wireserver
      "192.0.0.192", // Oracle
      "fd00:ec2::254", // AWS over IPv6
    ]
  ) {
    assert(addressRefused(address), `the metadata address ${address} would have been dialled`);
  }
  // The same IPv4 destination, written four ways. Each of these IS loopback, and a guard that
  // knew only the mapped spelling would be walked straight past by the other three.
  for (
    const address of [
      "::ffff:127.0.0.1", // IPv4-mapped
      "::127.0.0.1", // IPv4-compatible
      "2002:7f00:1::", // 6to4
      "64:ff9b::7f00:1", // NAT64
      "64:ff9b::169.254.169.254", // NAT64 around the metadata address
      "2002:c0a8:101::", // 6to4 around 192.168.1.1
    ]
  ) {
    assert(addressRefused(address), `${address} is loopback or private, and was dialled`);
  }
  // The spellings a translator on the path turns back into an inside address: SIIT's
  // IPv4-translated form, NAT64's local-use prefix (refused whole: its prefix length, and so
  // where the IPv4 address sits, is the operator's choice), and deprecated site-local.
  for (
    const address of [
      "::ffff:0:127.0.0.1", // SIIT, loopback
      "::ffff:0:a9fe:a9fe", // SIIT, the metadata address
      "64:ff9b:1::7f00:1", // local-use NAT64, /96 layout
      "64:ff9b:1:7f00:0:100::", // local-use NAT64, /48 layout
      "64:ff9b:1::0808:0808", // local-use NAT64 around a PUBLIC address: still a private translator
      "fec0::1",
      "feff:ffff::1",
    ]
  ) {
    assert(addressRefused(address), `${address} was dialled`);
  }
  // And none of that may cost the ordinary internet, 6to4 around a PUBLIC address included.
  for (
    const address of [
      "1.1.1.1",
      "104.16.0.1",
      "2606:4700::1111",
      "2002:6810:1::",
      "::ffff:0:1.1.1.1", // SIIT around a public address
      "64:ff9b::1.1.1.1", // well-known NAT64 around one
      "64:ff9b:2::1", // outside the local-use /48
    ]
  ) {
    assert(!addressRefused(address), `${address} was refused`);
  }
});

test("hostRefusal rejects an address, which its docstring always claimed", () => {
  assert(hostRefusal("127.0.0.1") !== null);
  assert(hostRefusal("169.254.169.254") !== null);
  assertStringIncludes(hostRefusal("10.0.0.1") ?? "", "address");
  assertEquals(hostRefusal("registry.npmjs.org"), null);
  assertEquals(hostRefusal("*.githubusercontent.com"), null);
});

test("a ceiling's wildcard covers the hosts under it", () => {
  const ceiling = ["*.githubusercontent.com", "github.com"];
  assert(hostCovered("objects.githubusercontent.com", ceiling));
  assert(hostCovered("release-assets.githubusercontent.com", ceiling));
  assert(hostCovered("*.githubusercontent.com", ceiling));
  // A narrower wildcard grants nothing the wider one had not already granted.
  assert(hostCovered("*.assets.githubusercontent.com", ceiling));
  assert(hostCovered("github.com", ceiling));
  // Never the bare domain: `*.example.com` is not a grant of `example.com`, and the proxy reads
  // it the same way.
  assert(!hostCovered("githubusercontent.com", ceiling));
  // And never a widening.
  assert(!hostCovered("*.com", ceiling));
  assert(!hostCovered("evil.example", ceiling));
});

test("an agent may narrow to a host its ceiling covers by wildcard", () => {
  // The bug this pins: the check compared hostnames literally, so it could not read the
  // ceiling's OWN entries and refused a narrowing as a widening — then advised the operator to
  // widen the deployment in order to grant an agent less.
  const ceiling: EgressPolicy = {
    mode: "proxy",
    bundles: ["github-releases"],
    hosts: [],
    proxyUrl: "http://egress:7460",
  };
  const resolved = resolveNetworkScope(
    { bundles: [], hosts: ["release-assets.githubusercontent.com"] },
    ceiling,
  );
  assert(resolved.kind === "ok", resolved.kind === "refused" ? resolved.error : "");
  assertEquals(resolved.scope.hosts, ["release-assets.githubusercontent.com"]);
});

// ── The second name ────────────────────────────────────────────────────────────────────────
//
// The CONNECT target is one name the client picked and the proxy checked. The name the client
// then asks the SERVER for is a second, independent choice, and a CDN edge routes by it: an
// allowed `CONNECT registry.npmjs.org:443` whose ClientHello says `exfil.attacker.tld` reaches
// the attacker's origin on the same anycast address. These pin that the two must agree.

/** A ClientHello record naming `name`, or one carrying no server_name extension. */
function clientHello(name: string | null): Buffer {
  const extensions: Buffer[] = [];
  if (name !== null) {
    const host = Buffer.from(name, "latin1");
    const entry = Buffer.concat([
      Buffer.from([0x00]), // host_name
      (() => {
        const b = Buffer.alloc(2);
        b.writeUInt16BE(host.length);
        return b;
      })(),
      host,
    ]);
    const list = Buffer.alloc(2);
    list.writeUInt16BE(entry.length);
    const body = Buffer.concat([list, entry]);
    const header = Buffer.alloc(4);
    header.writeUInt16BE(0x0000, 0);
    header.writeUInt16BE(body.length, 2);
    extensions.push(header, body);
  }
  const ext = Buffer.concat(extensions);
  const extLength = Buffer.alloc(2);
  extLength.writeUInt16BE(ext.length);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), // client_version
    Buffer.alloc(32, 0x11), // random
    Buffer.from([0x00]), // session id length
    Buffer.from([0x00, 0x02, 0x13, 0x01]), // cipher suites
    Buffer.from([0x01, 0x00]), // compression methods
    extLength,
    ext,
  ]);
  const handshake = Buffer.concat([
    Buffer.from([0x01, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]),
    body,
  ]);
  const recordLength = Buffer.alloc(2);
  recordLength.writeUInt16BE(handshake.length);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), recordLength, handshake]);
}

test("parseSni reads the one plaintext name, and says when it cannot yet", () => {
  const hello = clientHello("registry.npmjs.org");
  assertEquals(parseSni(hello), "registry.npmjs.org");
  // A short read is `undefined` — buffer more — and never a refusal, which is the distinction
  // the CONNECT path depends on to handle a hello split across TCP segments.
  assertEquals(parseSni(hello.subarray(0, 4)), undefined);
  assertEquals(parseSni(hello.subarray(0, hello.length - 3)), undefined);
  // A hello with no server_name is `null`: a refusal, because a tunnel whose name cannot be
  // read is a tunnel whose destination was never checked.
  assertEquals(parseSni(clientHello(null)), null);
  // Not a handshake record at all.
  assertEquals(parseSni(Buffer.from([0x17, 0x03, 0x03, 0x00, 0x01, 0x00])), null);
});

/** An upstream stand-in that records every byte it is handed, with a dial that reaches it. */
async function withUpstream(
  body: (
    dial: (host: string, port: number) => Promise<net.Socket>,
    received: () => Buffer,
  ) => Promise<void>,
): Promise<void> {
  let seen = Buffer.alloc(0);
  const upstream = net.createServer((socket) => {
    socket.on("data", (chunk) => seen = Buffer.concat([seen, chunk]));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamPort = (upstream.address() as { port: number }).port;
  try {
    await body(
      () =>
        new Promise((resolve) => {
          const socket = net.connect({ port: upstreamPort, host: "127.0.0.1" });
          socket.on("error", () => {});
          socket.once("connect", () => resolve(socket));
        }),
      () => seen,
    );
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

/** Opens a CONNECT and hands back the socket once the proxy has answered. */
function openTunnel(
  port: number,
  target: string,
  auth: string,
): Promise<{ socket: net.Socket; answer: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    let text = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("the proxy never answered"));
    }, 5_000);
    const onData = (chunk: Buffer) => {
      text += String(chunk);
      if (!text.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      socket.off("data", onData);
      resolve({ socket, answer: text });
    };
    socket.on("error", () => {});
    socket.on("data", onData);
    socket.once("connect", () => socket.write(connectLine(target, auth)));
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test("a tunnel whose ClientHello names another host is cut, and nothing reaches upstream", async () => {
  await withUpstream(async (dial, received) => {
    await withProxy({ dial }, async (port) => {
      const token = await claimFor(["registry.npmjs.org"]);
      const { socket } = await openTunnel(port, "registry.npmjs.org:443", `r_1:${token}`);
      // The CONNECT was in policy and the dial landed on the allowlisted host's edge. This is
      // the second choice: the name the TLS session actually asks that edge for.
      socket.write(clientHello("exfil.attacker.tld"));
      await settle();
      assertEquals(received().length, 0, "the attacker's hello was forwarded");
      assert(socket.destroyed || socket.readyState === "closed", "the tunnel was left open");
      socket.destroy();
    });
  });
});

test("a ClientHello carrying no SNI is refused rather than waved through", async () => {
  await withUpstream(async (dial, received) => {
    await withProxy({ dial }, async (port) => {
      const token = await claimFor(["registry.npmjs.org"]);
      const { socket } = await openTunnel(port, "registry.npmjs.org:443", `r_1:${token}`);
      socket.write(clientHello(null));
      await settle();
      assertEquals(received().length, 0);
      socket.destroy();
    });
  });
});

test("a matching SNI is forwarded, and so is one split across segments", async () => {
  for (const split of [false, true]) {
    await withUpstream(async (dial, received) => {
      await withProxy({ dial }, async (port) => {
        const token = await claimFor(["*.npmjs.org", "registry.npmjs.org"]);
        const { socket } = await openTunnel(port, "registry.npmjs.org:443", `r_1:${token}`);
        const hello = clientHello("registry.npmjs.org");
        if (split) {
          // The failure this half exists to catch: judging a hello on the first segment alone
          // would refuse every client whose record does not fit one packet.
          socket.write(hello.subarray(0, 6));
          await new Promise((resolve) => setTimeout(resolve, 30));
          socket.write(hello.subarray(6));
        } else {
          socket.write(hello);
        }
        await settle();
        assertEquals(received().length, hello.length, `split=${split}: the hello did not arrive`);
        socket.destroy();
      });
    });
  }
});

test("one run cannot hold every tunnel the shared proxy has", async () => {
  await withUpstream(async (dial) => {
    await withProxy({ dial, maxTunnelsPerRun: 1 }, async (port) => {
      const token = await claimFor(["registry.npmjs.org"]);
      const first = await openTunnel(port, "registry.npmjs.org:443", `r_1:${token}`);
      assertStringIncludes(first.answer, "200 Connection Established");
      // Entirely in policy, and that is the point: the allowlist bounds WHERE a run may go and
      // says nothing about how much of a shared listener it may hold. A few thousand of these,
      // opened and left idle for the ten-minute inactivity timer, is every other run's setup
      // failing on a proxy that never broke a rule.
      const second = await openTunnel(port, "registry.npmjs.org:443", `r_1:${token}`);
      assertStringIncludes(second.answer, "429");
      assertStringIncludes(second.answer, "open tunnels");
      // Another run is untouched: the cap is per claim, not a global one.
      const other = await mintEgressToken(KEY, {
        runId: "r_2",
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        hosts: ["registry.npmjs.org"],
      });
      const elsewhere = await openTunnel(port, "registry.npmjs.org:443", `r_2:${other}`);
      assertStringIncludes(elsewhere.answer, "200 Connection Established");
      for (const { socket } of [first, second, elsewhere]) socket.destroy();
      await settle();
    });
  });
});

test("the unwired-boundary warning says the opposite thing on a backend that confines", () => {
  // The sentence an operator reads at boot, and the one finding in this area where being wrong
  // is worse than being silent: on docker and manual a run keeps its default route, so
  // "runs are handed no route to the internet at all" leaves the operator holding exactly the
  // inverted belief — they would read a failed boundary as a working one.
  const confined = unwiredEgressWarning("kubernetes", true, false);
  assertStringIncludes(confined, "RYPH_EGRESS_KEY");
  assertStringIncludes(confined, "no route to the internet at all");
  const cooperative = unwiredEgressWarning("docker", false, true);
  assertStringIncludes(cooperative, "RYPH_EGRESS_PROXY_URL");
  assertStringIncludes(cooperative, "WHOLE internet");
  assertStringIncludes(cooperative, "enforces nothing");
  // docker is on either side of the line depending on the run network, so the caller decides
  // rather than the name.
  assertStringIncludes(unwiredEgressWarning("docker", true, true, true), "no route");
});

test("the bundles cover what the universal image and a pinned toolchain actually fetch", () => {
  // Both measured on a live deployment, as proxy refusals: mise installing a pinned Deno
  // reaches dl.deno.land, not deno.land; and `apt-get update` on our own universal image reads
  // the git-core PPA, because that is where its git comes from.
  const hosts = (id: string) => EGRESS_BUNDLES.find((b) => b.id === id)!.hosts;
  assert(hosts("deno").includes("dl.deno.land"));
  assert(hosts("debian").includes("ppa.launchpadcontent.net"));
});

test("a refusal is reported for a host the claim lacks, and not for an allowed one", async () => {
  const reported: Array<{ subject: string; host: string; port: number }> = [];
  const report = {
    report: (subjectId: string, _token: string, host: string, port: number) => {
      reported.push({ subject: subjectId, host, port });
    },
  };
  await withProxy({ report }, async (port) => {
    const token = await claimFor(["registry.npmjs.org"]);
    await ask(port, connectLine("dl.deno.land:443", `r_1:${token}`));
    // An allowed host on a port the proxy does not forward: refused, and NOT reported. There is
    // no bundle an admin could tick to make :22 work, so a line in the run's trail offering one
    // would be advice that does not exist.
    await ask(port, connectLine("registry.npmjs.org:22", `r_1:${token}`));
    assertEquals(reported, [{ subject: "r_1", host: "dl.deno.land", port: 443 }]);
  });
});

// ── Never a way back in: the host's own names and addresses, even when a claim carries them ───
//
// On a confined docker deployment the run gate's port list is the whole of what a run reaches of
// the host, and this proxy is one of those ports — so the proxy must not dial the host itself,
// or it is a second door with no list.

test("inwardRefusal: the host's names and any inward literal, and nothing else", () => {
  for (
    const host of [
      "host.docker.internal",
      "gateway.docker.internal",
      "HOST.DOCKER.INTERNAL.",
      "kubernetes.docker.internal",
      "host.containers.internal",
      "host.orb.internal",
      "host.lima.internal",
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "10.1.2.3",
      "192.168.65.254",
      "169.254.169.254",
      "[::1]",
      "::ffff:127.0.0.1",
      "fd00::1",
    ]
  ) {
    assert(inwardRefusal(host) !== null, `${host} would have been dialled`);
  }
  for (
    const host of ["registry.npmjs.org", "example.com", "docker.internal.example.com", "8.8.8.8"]
  ) {
    assertEquals(inwardRefusal(host), null, `${host} was refused`);
  }
  // The machine's own public address, which no range catches.
  assert(inwardRefusal("203.0.113.9", new Set(["203.0.113.9"])) !== null);
});

test("a claim that carries the host's name still cannot CONNECT to it, and nothing is dialled", async () => {
  let dialled = 0;
  await withProxy({
    dial: () => {
      dialled++;
      return Promise.reject(new Error("must not be reached"));
    },
  }, async (port) => {
    const token = await claimFor(["host.docker.internal", "127.0.0.1", "localhost"]);
    for (const target of ["host.docker.internal:7411", "127.0.0.1:443", "localhost:443"]) {
      const answer = await ask(port, connectLine(target, `r_1:${token}`));
      assertStringIncludes(answer, "403", target);
    }
  });
  assertEquals(dialled, 0);
});

test("a plain http request for the host's name is refused the same way", async () => {
  await withProxy({}, async (port) => {
    const token = await claimFor(["host.docker.internal"]);
    const answer = await ask(
      port,
      "GET http://host.docker.internal/ HTTP/1.1\r\nhost: host.docker.internal\r\n" +
        `proxy-authorization: Basic ${btoa(`r_1:${token}`)}\r\n\r\n`,
    );
    assertStringIncludes(answer, "403");
  });
});

test("RYPH_EGRESS_ALLOW_PRIVATE is the operator opening the inside on purpose", async () => {
  const upstream = net.createServer((socket) => socket.end("hello"));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamPort = (upstream.address() as { port: number }).port;
  try {
    await withProxy({
      allowPrivate: true,
      dial: () =>
        new Promise((resolve) => {
          const socket = net.connect({ port: upstreamPort, host: "127.0.0.1" });
          socket.once("connect", () => resolve(socket));
        }),
    }, async (port) => {
      const token = await claimFor(["host.docker.internal"]);
      const answer = await ask(port, connectLine("host.docker.internal:443", `r_1:${token}`));
      assertStringIncludes(answer, "200 Connection Established");
    });
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

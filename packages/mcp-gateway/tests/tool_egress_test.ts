// A hosted server's egress claim, end to end: minted here (core/tool_egress.ts) and verified by
// the EGRESS PROXY'S OWN CODE (images/egress-proxy/main.ts), which cannot import this package —
// the orchestrator's egress_test has the same split for a run's claim, and the same answer. What
// it pins is the tool listener's policy: its claims and no run's, any public host on any port,
// nothing private whatever RYPH_EGRESS_ALLOW_PRIVATE says, and no refusal reported anywhere.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import http from "node:http";
import net from "node:net";
import {
  deniedBy,
  makeProxy,
  parseDenyCidrs,
  parseProxyAuth,
  type Resolve,
  toolRefusalFor,
  verifyToken,
  verifyToolToken,
} from "../../../images/egress-proxy/main.ts";
import { mintToolEgressClaim, toolProxyEnv } from "../src/core/tool_egress.ts";
import { mintEgressToken } from "../../orchestrator/src/core/egress.ts";

const TOOL_KEY = new Uint8Array(32).fill(3);
const RUN_KEY = new Uint8Array(32).fill(7);
const silent = { refused: () => {}, allowed: () => {} };
const claim = (subject = "ryph-tool-grafana-ms-1", key = TOOL_KEY) =>
  mintToolEgressClaim(key, { subject, issuedAt: 1_700_000_000 });

test("a tool claim verifies under its key, for its subject, and nowhere else", async () => {
  const token = await claim();
  assertEquals(await verifyToolToken(token, TOOL_KEY), {
    subject: "ryph-tool-grafana-ms-1",
    issuedAt: 1_700_000_000,
  });
  assertEquals(await verifyToolToken(token, RUN_KEY), null);
  // A run's verifier never reads one, under any key: the version is inside the MAC.
  assertEquals(await verifyToken(token, TOOL_KEY, 0), null);
  // And a run's claim is no tool claim, even under the tool key.
  const run = await mintEgressToken(TOOL_KEY, { runId: "r_1", expiresAt: 4_000, hosts: [] });
  assertEquals(await verifyToolToken(run, TOOL_KEY), null);
  // Tampering with the payload is a forgery.
  const [v, , sig] = token.split(".");
  const forged = `${v}.${btoa(JSON.stringify({ s: "other", i: 1 })).replace(/=+$/, "")}.${sig}`;
  assertEquals(await verifyToolToken(forged, TOOL_KEY), null);
});

test("the proxy env carries the claim as a client sends it, and nothing loopback goes through", async () => {
  const token = await claim();
  const env = toolProxyEnv("http://ryph-egress-relay-ryph-tools:7460", token);
  const url = new URL(env.HTTPS_PROXY);
  assertEquals(url.host, "ryph-egress-relay-ryph-tools:7460");
  // What curl, Go and Node put in Proxy-Authorization from that URL, read back as the proxy reads it.
  const header = `Basic ${
    btoa(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`)
  }`;
  assertEquals(parseProxyAuth(header)?.token, token);
  assertEquals(env.NO_PROXY, "localhost,127.0.0.1,::1");
});

/** A live proxy on an ephemeral loopback port, closed however the body ends. */
async function withProxy(
  opts: Partial<Parameters<typeof makeProxy>[0]>,
  body: (port: number) => Promise<void>,
): Promise<void> {
  const server = makeProxy({ key: TOOL_KEY, claims: "tool", log: silent, ...opts });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    await body(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Writes one request and returns everything the proxy sends until `until` appears. */
function ask(port: number, request: string, until = "\r\n\r\n"): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    let text = "";
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error(`the proxy never answered: ${JSON.stringify(text)}`));
    });
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      text += String(chunk);
      if (text.includes(until)) {
        socket.destroy();
        resolve(text);
      }
    });
    socket.on("end", () => resolve(text));
    socket.once("connect", () => socket.write(request));
  });
}

const connectLine = (target: string, token: string) =>
  `CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n` +
  `proxy-authorization: Basic ${btoa(`tool:${token}`)}\r\n\r\n`;

/** A stand-in for the internet, which says hello first — so a tunnel that waits for a TLS hello
 * before relaying anything never hears it. */
async function withUpstream(body: (dial: () => Promise<net.Socket>) => Promise<void>) {
  const upstream = net.createServer((socket) => socket.end("hello from upstream"));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const port = (upstream.address() as { port: number }).port;
  const dialled: number[] = [];
  try {
    await body(() =>
      new Promise((resolve) => {
        dialled.push(port);
        const socket = net.connect({ port, host: "127.0.0.1" });
        socket.once("connect", () => resolve(socket));
      })
    );
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

test("a tool claim opens any public host on any port, with no TLS hello asked of it", async () => {
  await withUpstream(async (dial) => {
    await withProxy({ dial }, async (port) => {
      const token = await claim();
      for (const target of ["api.example.com:443", "db.example.com:5432", "93.184.215.14:8443"]) {
        const answer = await ask(port, connectLine(target, token), "hello from upstream");
        assertStringIncludes(answer, "200 Connection Established", target);
        assertStringIncludes(answer, "hello from upstream", target);
      }
    });
  });
});

test("nothing inside is a tool claim's, RYPH_EGRESS_ALLOW_PRIVATE or not", async () => {
  const reported: string[] = [];
  const report = { report: (_s: string, _t: string, host: string) => void reported.push(host) };
  let dials = 0;
  const dial = () => {
    dials++;
    return Promise.reject(new Error("no dial expected"));
  };
  await withProxy({ allowPrivate: true, report, dial }, async (port) => {
    const token = await claim();
    for (
      const target of [
        "127.0.0.1:443",
        "10.0.0.5:5432",
        "172.17.0.1:7411",
        "192.168.1.1:80",
        "100.64.0.1:443", // CGNAT
        "169.254.169.254:80", // cloud metadata
        "168.63.129.16:80", // Azure's wireserver
        "[::1]:443",
        "[fd00::1]:443",
        "localhost:7430",
        "host.docker.internal:7461",
      ]
    ) {
      assertStringIncludes(await ask(port, connectLine(target, token)), "403", target);
    }
    // Plain http, absolute-form, the same.
    const get = await ask(
      port,
      `GET http://169.254.169.254/latest/meta-data HTTP/1.1\r\nhost: 169.254.169.254\r\n` +
        `proxy-authorization: Basic ${btoa(`tool:${token}`)}\r\n\r\n`,
    );
    assertStringIncludes(get, "403");
  });
  assertEquals(dials, 0);
  // No run to tell and no allowlist to widen: nothing is reported.
  assertEquals(reported, []);
  // The pure half agrees, and lets the public through.
  assert(toolRefusalFor("10.1.2.3") !== null);
  assertEquals(toolRefusalFor("api.github.com"), null);
  assertEquals(toolRefusalFor("140.82.112.3"), null);
});

test("each listener takes its own kind of claim and no other", async () => {
  const toolToken = await claim();
  const runToken = await mintEgressToken(RUN_KEY, {
    runId: "r_1",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    hosts: ["registry.npmjs.org"],
  });
  // A run's claim on the tool listener, under either key: 407.
  await withProxy({}, async (port) => {
    assertStringIncludes(await ask(port, connectLine("registry.npmjs.org:443", runToken)), "407");
    const sameKey = await mintEgressToken(TOOL_KEY, {
      runId: "r_1",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      hosts: ["registry.npmjs.org"],
    });
    assertStringIncludes(await ask(port, connectLine("registry.npmjs.org:443", sameKey)), "407");
    assertStringIncludes(
      await ask(port, "CONNECT api.example.com:443 HTTP/1.1\r\nhost: api.example.com\r\n\r\n"),
      "407",
    );
  });
  // A tool claim on a run listener — its key or the run's: 407.
  for (const key of [RUN_KEY, TOOL_KEY]) {
    await withProxy({ key, claims: "run" }, async (port) => {
      assertStringIncludes(await ask(port, connectLine("api.example.com:443", toolToken)), "407");
    });
  }
});

/** A resolver that answers `names` itself and nothing else: no DNS in a test. */
const resolving = (names: Record<string, string>): Resolve => (hostname, options, callback) => {
  const address = names[hostname];
  if (address === undefined) return callback(new Error(`ENOTFOUND ${hostname}`));
  const family = net.isIP(address);
  return options?.all === true
    ? callback(null, [{ address, family }])
    : callback(null, address, family);
};

/** Listens on loopback; answers the port and a close. */
async function listening(
  server: net.Server,
): Promise<{ port: number; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("a run's pooled socket to the inside is never a hosted server's way in", async () => {
  // A keep-alive upstream on loopback, as an internal mirror a run's allowlist names on purpose.
  const sockets = new Set<net.Socket>();
  const upstream = http.createServer((_req, res) => res.end("inside"));
  upstream.keepAliveTimeout = 30_000;
  upstream.on("connection", (socket) => sockets.add(socket));
  const up = await listening(upstream);
  // Both listeners in ONE process, as the image's main and the binary run them.
  const resolve = resolving({ "mirror.internal.test": "127.0.0.1" });
  const run = makeProxy({
    key: RUN_KEY,
    claims: "run",
    allowPrivate: true,
    resolve,
    ports: new Set([up.port]),
    log: silent,
  });
  const tool = makeProxy({ key: TOOL_KEY, claims: "tool", resolve, log: silent });
  const runAt = await listening(run);
  const toolAt = await listening(tool);
  const get = (token: string) =>
    `GET http://mirror.internal.test:${up.port}/ HTTP/1.1\r\nhost: mirror.internal.test\r\n` +
    `proxy-authorization: Basic ${btoa(`x:${token}`)}\r\n\r\n`;
  try {
    const runToken = await mintEgressToken(RUN_KEY, {
      runId: "r_1",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      hosts: ["mirror.internal.test"],
    });
    // The operator's bargain: the run reaches it. Read to the end, so a pooling agent would
    // have its socket back.
    assertStringIncludes(await ask(runAt.port, get(runToken), "inside"), "200");
    await new Promise((r) => setTimeout(r, 50));
    // The same host:port on a hosted server's claim is refused by the guarded lookup — which a
    // socket kept alive from the run's request would never have asked.
    const answer = await ask(toolAt.port, get(await claim()), "}");
    assertStringIncludes(answer, "502");
    assertStringIncludes(answer, "127.0.0.1");
    assert(!answer.includes("inside"), answer);
    // And every forward was a connection of its own.
    assertEquals(sockets.size, 1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([runAt.close(), toolAt.close(), up.close()]);
  }
});

test("RYPH_EGRESS_DENY_CIDRS parses v4 and v6, and refuses at boot what it cannot read", () => {
  const deny = parseDenyCidrs(" 203.0.113.7, 198.51.100.0/24,2001:db8::/32 ,,2001:db8:1::1");
  assertEquals(deny.map((c) => c.text), [
    "203.0.113.7",
    "198.51.100.0/24",
    "2001:db8::/32",
    "2001:db8:1::1",
  ]);
  assertEquals(parseDenyCidrs(""), []);
  for (
    const bad of [
      "10.0.0.0/33",
      "::/129",
      "vm.example.com",
      "1.2.3",
      "10.0.0.0/8/1",
      "fe80::1%eth0",
      "10.0.0.0/",
    ]
  ) {
    let threw = false;
    try {
      parseDenyCidrs(`203.0.113.7,${bad}`);
    } catch (err) {
      threw = true;
      assertStringIncludes(String(err), JSON.stringify(bad));
    }
    assert(threw, bad);
  }
  const [vm] = parseDenyCidrs("203.0.113.7");
  for (
    const address of [
      "203.0.113.7",
      "::ffff:203.0.113.7",
      "::ffff:cb00:7107",
      "2002:cb00:7107::",
      "64:ff9b::203.0.113.7",
    ]
  ) {
    assertEquals(deniedBy(address, [vm!])?.text, "203.0.113.7", address);
  }
  assertEquals(deniedBy("203.0.113.8", [vm!]), null);
  assertEquals(deniedBy("198.51.100.200", deny)?.text, "198.51.100.0/24");
  assertEquals(deniedBy("198.51.101.1", deny), null);
  assertEquals(deniedBy("2001:db8:ffff::1", deny)?.text, "2001:db8::/32");
  assertEquals(deniedBy("2001:db9::1", deny), null);
  assertEquals(deniedBy("[2001:db8::5]", deny)?.text, "2001:db8::/32");
});

test("the deny list holds on both listeners, by literal and by a name resolving into it", async () => {
  const deny = parseDenyCidrs("203.0.113.7,2001:db8::/32");
  const resolve = resolving({ "vm.example.test": "203.0.113.7" });
  let dials = 0;
  const dial = () => {
    dials++;
    return Promise.reject(new Error("no dial expected"));
  };
  // Literals, which skip the lookup: refused before any dial.
  await withProxy({ deny, dial }, async (port) => {
    const token = await claim();
    for (const target of ["203.0.113.7:22", "[::ffff:cb00:7107]:8080", "[2001:db8::1]:443"]) {
      const answer = await ask(port, connectLine(target, token), "}");
      assertStringIncludes(answer, "403", target);
      assertStringIncludes(answer, "RYPH_EGRESS_DENY_CIDRS", target);
    }
  });
  assertEquals(dials, 0);
  // A name, through the real dial's guarded lookup: the tool listener, and a run's whose operator
  // opened the inside — the deny list is their word as well.
  await withProxy({ deny, resolve }, async (port) => {
    const answer = await ask(port, connectLine("vm.example.test:22", await claim()), "}");
    assertStringIncludes(answer, "502");
    assertStringIncludes(answer, "RYPH_EGRESS_DENY_CIDRS");
  });
  const runToken = await mintEgressToken(RUN_KEY, {
    runId: "r_1",
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    hosts: ["vm.example.test"],
  });
  await withProxy(
    { key: RUN_KEY, claims: "run", allowPrivate: true, deny, resolve },
    async (port) => {
      const answer = await ask(port, connectLine("vm.example.test:443", runToken), "}");
      assertStringIncludes(answer, "502");
      assertStringIncludes(answer, "RYPH_EGRESS_DENY_CIDRS");
    },
  );
});

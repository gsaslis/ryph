// A hosted credential goes only to a container launched from exactly the inputs it is bound to:
// the data plane and the probe dial the launch key computed from the row as it stands, that key
// names the one container launched from those inputs, and nothing else runs under it. Every test
// here is an attack or a race from an earlier review round — a database writer editing, reverting
// or swapping rows, launches failing, superseded or racing — and each one ends in "not found",
// "not ready" or "stale", or in the credential reaching its own launch's container, and never in
// it reaching a container launched from anything else (`assertOnlyOwnLaunch`).

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { makeHosting } from "../src/core/hosting.ts";
import { makeMcpCredentialIssuer } from "../src/core/service.ts";
import { hostedDial, launchKey } from "../src/core/sealing.ts";
import type { McpServer } from "../src/core/types.ts";
import { makeGatewayHandler } from "../src/http/proxy.ts";
import { makeProbe } from "../src/http/probe.ts";
import type { GatewayStore } from "../src/ports/gateway_store.ts";
import { fixedCatalogue } from "./api.ts";
import { type FakeToolHost, fakeToolHost } from "./fake_tool_host.ts";
import { leaseSlot } from "./fake_lease.ts";
import type { HostingLease } from "../src/core/lease.ts";
import type { ToolLaunchSpec } from "../src/ports/tool_host.ts";
import { fakeDecrypt, openPolicy, server, T0 } from "./fixtures.ts";
import { closedAfterEach } from "@ryph/db/testing";
import { makeTestDb as openTestDb } from "./db.ts";
import { drizzleGatewayStore } from "../src/adapters/store/drizzle.ts";
import * as schema from "../src/adapters/store/db/schema.ts";
import type { McpGatewayDbHandle } from "../src/adapters/store/db/db.ts";
import { eq } from "drizzle-orm";

// Its tests leave their handles open.
const makeTestDb = closedAfterEach(openTestDb);

const LEGIT = `r.example.com/tools@sha256:${"a".repeat(64)}`;
const EVIL = `evil.example.com/tools@sha256:${"e".repeat(64)}`;

function customRow(id: string, image: string, overrides: Partial<McpServer> = {}): McpServer {
  return server({
    id,
    slug: "tools",
    name: "Tools",
    kind: "hosted",
    url: "",
    auth: "bearer",
    encryptedAuth: 'sealed:{"Authorization":"Bearer the-real-credential"}',
    authLast4: "tial",
    custom: { image, command: [], port: 9000, path: "/mcp", callerAuth: { env: "TOOLS_TOKEN" } },
    host: { handle: null, status: "starting", imageDigest: null, startedAt: null, lastError: null },
    ...overrides,
  });
}

/** One gateway process over the shared store: hosting, the data plane and the probe, wired as
 * setup.ts wires them. */
function gateway(
  store: GatewayStore,
  opts: {
    host?: FakeToolHost;
    lease?: HostingLease;
    /** What upstream answers; a JSON-RPC result unless a test says otherwise. */
    answer?: () => Promise<Response>;
    warnings?: Array<{ event: string; data?: Record<string, unknown> }>;
    /** Unseals a credential; the fixtures' fake unless a test steps in on the way. */
    decrypt?: typeof fakeDecrypt;
    /** The clock every part reads; fixed at T0 unless a test moves it. */
    now?: () => Date;
    /** Startup probes through the real probe, rather than answered by fiat. */
    realProbe?: boolean;
    /** The wait between startup probes; none unless a test moves its clock with it. */
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const decrypt = opts.decrypt ?? fakeDecrypt;
  const now = opts.now ?? (() => new Date(T0));
  const host = opts.host ?? fakeToolHost();
  const dialled: Array<{ url: string; authorization: string | null }> = [];
  const upstreamFetch = ((input: string | URL | Request, init?: RequestInit) => {
    dialled.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    // By default an answer to whatever was asked: its id echoed, and an empty tool list.
    const id = typeof init?.body === "string" ? JSON.parse(init.body).id ?? null : null;
    return opts.answer?.() ??
      Promise.resolve(Response.json({ jsonrpc: "2.0", id, result: { tools: [] } }));
  }) as typeof fetch;
  const diag = {
    debug() {},
    warn: (event: string, data?: Record<string, unknown>) => opts.warnings?.push({ event, data }),
  };
  let hosting: ReturnType<typeof makeHosting> | null = null;
  const upstream = openPolicy;
  const hostedRoute = (serverId: string) => hosting?.route(serverId) ?? null;
  const probe = makeProbe({
    decrypt,
    upstream,
    upstreamFetch,
    toolGuard: () => hosting?.guard() ?? null,
    hostedRoute,
    hostedOutlook: (s) => hosting!.outlook(s),
  });
  hosting = makeHosting({
    store,
    host,
    catalogue: fixedCatalogue([]),
    // Startup probes answer by fiat unless asked: what is under test is what the data plane sends.
    probe: opts.realProbe ? (s) => probe(s) : () => Promise.resolve({ ok: true }),
    guardImage: "ryph-tool-guard:test",
    now,
    diag,
    sleep: opts.sleep ?? (() => Promise.resolve()),
    ...(opts.lease === undefined ? {} : { lease: opts.lease }),
  });
  const handler = makeGatewayHandler({
    store,
    decrypt,
    now,
    diag,
    upstream,
    upstreamFetch,
    toolGuard: () => hosting?.guard() ?? null,
    hostedRoute,
    hostedOutlook: (s) => hosting!.outlook(s),
    hostedSettling: (id) => hosting!.settling(id),
  });
  return { hosting, handler, probe, dialled, host };
}

/**
 * The property itself, checked over everything a test did: every request that carried the real
 * credential was dialled at a launch key whose container was launched from the legitimate image
 * and only ever from it, and no name ever ran two different launches.
 */
function assertOnlyOwnLaunch(
  gw: { dialled: Array<{ url: string; authorization: string | null }>; host: FakeToolHost },
) {
  const launchesOf = (name: string) => gw.host.launches.filter((l) => l.name === name);
  for (const name of new Set(gw.host.launches.map((l) => l.name))) {
    if (name.startsWith("ryph-tool-guard")) continue;
    const shapes = new Set(
      launchesOf(name).map((l) => JSON.stringify([l.image, l.command, l.env, l.port])),
    );
    assertEquals(shapes.size, 1, `${name} ran one launch's inputs, never another's`);
  }
  for (const d of gw.dialled) {
    if (d.authorization !== "Bearer the-real-credential") continue;
    const key = new URL(d.url).pathname.split("/")[1];
    const at = launchesOf(`ryph-tool-${key}`);
    assert(at.length > 0, `dialled ${d.url}, a key nothing was launched under`);
    assert(at.every((l) => l.image === LEGIT), `the credential reached ${at[0]?.image}`);
  }
}

/** A database writer's edit: straight into the table, past every route's rules. */
async function rewrite(
  handle: McpGatewayDbHandle,
  id: string,
  patch: Partial<Pick<McpServer, "custom" | "archivedAt" | "url">>,
) {
  await handle.db.update(schema.mcpServers).set(patch).where(eq(schema.mcpServers.id, id));
}

async function freshStore() {
  const handle = await makeTestDb();
  return { handle, store: drizzleGatewayStore(handle) };
}

async function runKey(store: GatewayStore, serverId: string) {
  const issuer = makeMcpCredentialIssuer({
    store,
    now: () => new Date(T0),
    gatewayUrl: "http://gw.test",
    ttlMs: 60_000,
  });
  const creds = await issuer.issue({ runId: "r-1", servers: [{ serverId, allowedTools: "*" }] });
  return { token: creds.token, url: creds.servers[0].url };
}

const call = (url: string, token: string) =>
  new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

test("a container launched from the row as it stands gets the credential", async () => {
  const { store } = await freshStore();
  const row = customRow("ms-a", LEGIT);
  await store.createServer(row);
  const gw = gateway(store);
  await gw.hosting.boot();
  await gw.hosting.idle();
  const key = await launchKey(row, `sha256:${"a".repeat(64)}`);
  assertEquals(gw.hosting.route("ms-a"), { key, ready: true });
  const { token, url } = await runKey(store, "ms-a");
  assertEquals((await gw.handler(call(url, token))).status, 200);
  // At the key's route on the guard: neither the slug nor the row's stored url.
  assertEquals(gw.dialled.at(-1), {
    url: `${gw.hosting.guard()!.origin}/${key}/mcp`,
    authorization: "Bearer the-real-credential",
  });
  assertOnlyOwnLaunch(gw);
});

test("a row edited for a restart and reverted after it sends nothing to the container it got", async () => {
  const { handle, store } = await freshStore();
  await store.createServer(customRow("ms-a", LEGIT));
  const before = gateway(store);
  await before.hosting.boot();
  await before.hosting.idle();

  // A database writer points the row at their image and waits for the gateway to restart: the
  // boot relaunches the row from what it says then.
  const row = (await store.getServer("ms-a"))!;
  await rewrite(handle, "ms-a", { custom: { ...row.custom!, image: EVIL } });
  await before.hosting.shutdown();
  const after = gateway(store);
  await after.hosting.boot();
  await after.hosting.idle();
  assertEquals(after.host.launches.find((l) => TOOL.test(l.name))?.image, EVIL);

  // ...then puts the row back, so the credential (sealed for the legitimate image) opens again.
  await rewrite(handle, "ms-a", { custom: row.custom });
  const { token, url } = await runKey(store, "ms-a");
  const res = await after.handler(call(url, token));
  assertEquals(res.status, 503);
  assertEquals((await res.json()).code, "hosted_stale");
  const probed = await after.probe((await store.getServer("ms-a"))!);
  assertEquals(probed.ok, false);
  assertEquals(after.dialled, [], "the credential went nowhere");
  assertOnlyOwnLaunch(after);
});

test("a slug handed to another row for a restart, then handed back, sends nothing", async () => {
  const { handle, store } = await freshStore();
  await store.createServer(customRow("ms-a", LEGIT));
  // A database writer archives the real row and inserts their own under the same slug...
  await rewrite(handle, "ms-a", { archivedAt: T0 });
  await store.createServer(customRow("ms-e", EVIL, { encryptedAuth: null, auth: "none" }));
  const gw = gateway(store);
  await gw.hosting.boot();
  await gw.hosting.idle();
  assert(gw.hosting.route("ms-e")?.ready);

  // ...then swaps the archive flags back: the real row is live, and its slug is the one their
  // image was launched for. A slug is no address: the real row has no launch of its own here.
  await rewrite(handle, "ms-e", { archivedAt: T0 });
  await rewrite(handle, "ms-a", { archivedAt: null });
  const { token, url } = await runKey(store, "ms-a");
  const res = await gw.handler(call(url, token));
  assertEquals(res.status, 503);
  assertEquals((await res.json()).code, "hosted_starting");
  const probed = await gw.probe((await store.getServer("ms-a"))!);
  assert(!probed.ok && probed.reason === "unreachable", JSON.stringify(probed));
  assertEquals(gw.dialled, [], "the credential went nowhere");

  // Relaunched from what the row says now, it is served again — at its own key.
  await gw.hosting.launch((await store.getServer("ms-a"))!);
  await gw.hosting.idle();
  assertEquals((await gw.handler(call(url, token))).status, 200);
  assertEquals(gw.dialled.at(-1)?.authorization, "Bearer the-real-credential");
  assertOnlyOwnLaunch(gw);
});

async function refusal(
  gw: ReturnType<typeof gateway>,
  store: GatewayStore,
  id: string,
): Promise<{ status: number; code: string; error: string; probe: string | undefined }> {
  const { token, url } = await runKey(store, id);
  const res = await gw.handler(call(url, token));
  const body = await res.json();
  const probed = await gw.probe((await store.getServer(id))!);
  return {
    status: res.status,
    code: body.code,
    error: body.error,
    probe: probed.ok ? undefined : probed.code,
  };
}

const withStatus = (status: "starting" | "unreachable" | "stopped" | "healthy") => ({
  host: { handle: null, status, imageDigest: null, startedAt: null, lastError: "x" },
  updatedAt: T0,
});

test("nothing routed with a launch coming is worth asking again: 503 in every transient state", async () => {
  const { store } = await freshStore();
  await store.createServer(customRow("ms-a", LEGIT));

  // Hosting not started yet: the gateway answers before its boot lands.
  const early = gateway(store);
  let seen = await refusal(early, store, "ms-a");
  assertEquals([seen.status, seen.code, seen.probe], [503, "hosted_starting", "hosted_starting"]);

  // Waiting for the lease a departing gateway still holds (a rolling update).
  const slot = leaseSlot();
  const departing = gateway(store, { lease: slot.leaseFor("old") });
  await departing.hosting.boot();
  await departing.hosting.idle();
  const arriving = gateway(store, { lease: slot.leaseFor("new") });
  const booting = arriving.hosting.boot();
  seen = await refusal(arriving, store, "ms-a");
  assertEquals([seen.status, seen.code], [503, "hosted_starting"]);

  // The departing one shutting down: from its first moment nothing is routed, and its successor
  // is about to relaunch.
  const gate = {
    route: departing.hosting.route,
    outlook: departing.hosting.outlook,
    guardOrigin: () => departing.hosting.guard()?.origin ?? null,
  };
  const row = (await store.getServer("ms-a"))!;
  assertEquals((await hostedDial(gate, row)).ok, true);
  const down = departing.hosting.shutdown();
  const mid = await hostedDial(gate, row);
  assertEquals(mid.ok ? null : mid.refusal.code, "hosted_starting");
  await down;
  seen = await refusal(departing, store, "ms-a");
  assertEquals([seen.status, seen.code], [503, "hosted_starting"]);
  await booting;
  await arriving.hosting.idle();

  // Booted, with a row starting or unreachable (a backoff relaunch due) and nothing routed.
  await arriving.hosting.shutdown();
  const fresh = gateway(store);
  await fresh.hosting.boot();
  await fresh.hosting.idle();
  await fresh.hosting.stop((await store.getServer("ms-a"))!);
  for (const status of ["starting", "unreachable", "healthy"] as const) {
    await store.updateServer("ms-a", withStatus(status));
    seen = await refusal(fresh, store, "ms-a");
    assertEquals([status, seen.status, seen.code], [status, 503, "hosted_starting"]);
  }
  assertEquals(early.dialled.length + arriving.dialled.length + fresh.dialled.length, 0);
});

test("a lost lease is a handover: 503, not a dead end", async () => {
  const { store } = await freshStore();
  await store.createServer(customRow("ms-a", LEGIT));
  const slot = leaseSlot();
  const lease = slot.leaseFor("a");
  const gw = gateway(store, { lease });
  await gw.hosting.boot();
  await gw.hosting.idle();
  const { token, url } = await runKey(store, "ms-a");
  assertEquals((await gw.handler(call(url, token))).status, 200);
  (lease as ReturnType<typeof slot.leaseFor>).lose();
  await new Promise((r) => setTimeout(r, 1));
  const res = await gw.handler(call(url, token));
  assertEquals(res.status, 503);
  assertEquals((await res.json()).code, "hosted_starting");
  assertEquals(gw.hosting.outlook((await store.getServer("ms-a"))!), { coming: true });
});

test("nothing routed with nothing coming is a 502 that says why", async () => {
  const { store } = await freshStore();
  await store.createServer(customRow("ms-a", LEGIT));

  // Hosting that will not come up here (no network) is not a wait.
  const host = fakeToolHost();
  host.failNetwork("no daemon");
  const broken = gateway(store, { host });
  await broken.hosting.boot();
  let seen = await refusal(broken, store, "ms-a");
  assertEquals([seen.status, seen.code, seen.probe], [
    502,
    "hosted_not_running",
    "hosted_not_running",
  ]);
  assert(seen.error.includes("no daemon"), seen.error);
  assert(!seen.error.includes("try again"), seen.error);

  // A stopped row: nothing relaunches it but a person.
  const gw = gateway(store);
  await gw.hosting.boot();
  await gw.hosting.idle();
  await gw.hosting.stop((await store.getServer("ms-a"))!);
  seen = await refusal(gw, store, "ms-a");
  assertEquals([seen.status, seen.code], [502, "hosted_not_running"]);
  assert(seen.error.includes("stopped"), seen.error);

  // A row whose launch cannot be derived from it: retried on the backoff, but nothing changes
  // until a person does.
  await store.createServer(
    customRow("ms-b", LEGIT, { slug: "other", encryptedAuth: null, auth: "none" }),
  );
  const b = (await store.getServer("ms-b"))!;
  await store.updateServer("ms-b", {
    ...withStatus("starting"),
    // A row from before the caller-auth var was required.
    ...({ custom: { ...b.custom!, callerAuth: null } } as object),
  } as never);
  await gw.hosting.launch((await store.getServer("ms-b"))!);
  await gw.hosting.idle();
  const outlook = gw.hosting.outlook((await store.getServer("ms-b"))!);
  assert(!outlook.coming && outlook.reason.includes("caller-auth"), JSON.stringify(outlook));
  assertEquals(gw.dialled.length + broken.dialled.length, 0);
});

test("a boot saves every row it relaunches `starting` before it reads available", async () => {
  const { store } = await freshStore();
  await store.createServer(customRow("ms-a", LEGIT));
  await store.updateServer("ms-a", withStatus("unreachable"));
  let gw: ReturnType<typeof gateway> | null = null;
  const seen: Array<{ status: string; available: boolean }> = [];
  const watched: GatewayStore = {
    ...store,
    updateServer: async (id, edit) => {
      if (edit.host && gw !== null) {
        seen.push({ status: edit.host.status, available: gw.hosting.availability().available });
      }
      return await store.updateServer(id, edit);
    },
  };
  gw = gateway(watched);
  await gw.hosting.boot();
  await gw.hosting.idle();
  assertEquals(seen[0], { status: "starting", available: false });
});

for (
  const [what, stored] of [
    ["a header name that steers the request", { Host: "evil.example.com" }],
    ["a malformed header name", { " Host": "evil.example.com" }],
    ["a value on two lines", { "X-Api-Key": "a\r\nHost: evil.example.com" }],
  ] as const
) {
  test(`a stored credential with ${what} is a coded refusal, never sent and never a 500`, async () => {
    const { handle, store } = await freshStore();
    await store.createServer(server({
      id: "ms-r",
      slug: "remote",
      kind: "remote",
      url: "https://mcp.example.com/mcp",
      auth: "headers",
      encryptedAuth: `sealed:${JSON.stringify({ "X-Api-Key": "fine-secret" })}`,
    }));
    // Written straight into the table, past the API's refusal of such a header.
    await handle.db.update(schema.mcpServers)
      .set({ encryptedAuth: `sealed:${JSON.stringify(stored)}` })
      .where(eq(schema.mcpServers.id, "ms-r"));
    const gw = gateway(store);
    const { token, url } = await runKey(store, "ms-r");
    const res = await gw.handler(call(url, token));
    assertEquals(res.status, 502);
    const body = await res.json();
    assertEquals(body.code, "credential_header_refused");
    assert(!JSON.stringify(body).includes("evil"), "no value is quoted");
    const probed = await gw.probe((await store.getServer("ms-r"))!);
    assert(!probed.ok && probed.reason === "secret_required", JSON.stringify(probed));
    assertEquals(gw.dialled, []);
  });
}

test("a fetch error quoting what was sent is redacted from the log and the probe's verdict", async () => {
  const { store } = await freshStore();
  await store.createServer(server({
    id: "ms-r",
    slug: "remote",
    kind: "remote",
    url: "https://mcp.example.com/mcp",
    auth: "headers",
    encryptedAuth: `sealed:${JSON.stringify({ Authorization: "Bearer the-secret-value" })}`,
  }));
  const warnings: Array<{ event: string; data?: Record<string, unknown> }> = [];
  // An error that quotes the request it failed on, headers and all.
  const gw = gateway(store, {
    warnings,
    answer: () =>
      Promise.reject(new Error("socket hang up sending authorization: Bearer the-secret-value")),
  });
  const { token, url } = await runKey(store, "ms-r");
  const res = await gw.handler(call(url, token));
  assertEquals(res.status, 502);
  const probed = await gw.probe((await store.getServer("ms-r"))!);
  assert(!probed.ok && probed.reason === "unreachable", JSON.stringify(probed));
  for (const seen of [JSON.stringify(warnings), probed.detail, await res.text()]) {
    assert(!seen.includes("the-secret-value"), `the value leaked: ${seen}`);
  }
  assert(probed.detail.includes("***"), probed.detail);
});

// ── Launches that fail, are superseded or race ─────────────────────────────────────────────────
//
// A relaunch from other inputs launches under another name, so whatever happens to it — a throw,
// a write that fails, a newer launch overtaking it, the row reverted under it — the container the
// row's own key names is untouched. Each test stops a relaunch at one point and checks where the
// credential can go.

/** A fake host whose launches can be held at the door, or failed, one at a time. */
function heldHost() {
  const inner = fakeToolHost();
  const gates: Array<{ match: RegExp; open: Promise<void>; entered: () => void }> = [];
  const hold = (match: RegExp) => {
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((r) => (entered = r));
    gates.push({ match, open: new Promise<void>((r) => (release = r)), entered });
    return { release, reached };
  };
  const host: FakeToolHost = {
    ...inner,
    async launch(spec: ToolLaunchSpec) {
      const i = gates.findIndex((g) => g.match.test(spec.name));
      if (i !== -1) {
        const [gate] = gates.splice(i, 1);
        gate.entered();
        await gate.open;
      }
      return await inner.launch(spec);
    },
  };
  return { host, inner, hold };
}

/** A vendor container's name. */
const TOOL = /^ryph-tool-[0-9a-f]{32}$/;

async function launchedGateway(store: GatewayStore, host: FakeToolHost) {
  await store.createServer(customRow("ms-a", LEGIT));
  const gw = gateway(store, { host });
  await gw.hosting.boot();
  await gw.hosting.idle();
  const { token, url } = await runKey(store, "ms-a");
  assertEquals((await gw.handler(call(url, token))).status, 200);
  gw.dialled.length = 0;
  return { gw, send: () => gw.handler(call(url, token)) };
}

/** The images running now, one per vendor container. */
const images = (host: FakeToolHost) =>
  [...host.containers.values()].filter((c) => TOOL.test(c.spec.name)).map((c) => c.spec.image)
    .sort();

test("a relaunch whose launch throws leaves the credential at its own launch", async () => {
  const { handle, store } = await freshStore();
  const { host, inner } = heldHost();
  const { gw, send } = await launchedGateway(store, host);
  const row = (await store.getServer("ms-a"))!;
  // A database writer points the row elsewhere; the relaunch from it fails, and they put the
  // row back. The other image's launch had a name of its own, so nothing of the row's was touched.
  await rewrite(handle, "ms-a", { custom: { ...row.custom!, image: EVIL } });
  inner.failLaunch(TOOL, "pull failed half way");
  await gw.hosting.launch((await store.getServer("ms-a"))!);
  await gw.hosting.idle();
  await rewrite(handle, "ms-a", { custom: row.custom });
  // The launch wrote its digest to the row before it went out, so the row, reverted, names a
  // launch nothing ran: stale until the supervisor relaunches it. Never the other container.
  const res = await send();
  assertEquals(res.status, 503);
  assertEquals((await res.json()).code, "hosted_stale");
  // The writer restoring the digest as well brings back the row's own key, and its container.
  await store.updateServer("ms-a", { host: row.host, updatedAt: T0 });
  assertEquals((await send()).status, 200);
  assertOnlyOwnLaunch(gw);
});

test("a relaunch whose row write throws sends nothing to what it launched", async () => {
  const { handle, store } = await freshStore();
  const { host, inner } = heldHost();
  /** Host writes until the one that fails: the restart's `starting`, the digest, then the handle. */
  let failIn = 0;
  const flaky: GatewayStore = {
    ...store,
    updateServer: (id, edit) => {
      if (failIn > 0 && edit.host !== undefined && --failIn === 0) {
        return Promise.reject(new Error("connection reset"));
      }
      return store.updateServer(id, edit);
    },
  };
  const { gw, send } = await launchedGateway(flaky, host);
  const row = (await store.getServer("ms-a"))!;
  await rewrite(handle, "ms-a", { custom: { ...row.custom!, image: EVIL } });
  failIn = 3;
  await gw.hosting.launch((await store.getServer("ms-a"))!);
  await gw.hosting.idle();
  assertEquals(images(inner), [EVIL, LEGIT], "the other image runs, under its own name");
  await rewrite(handle, "ms-a", { custom: row.custom });
  assertEquals((await send()).status, 503, "the row names the other launch's digest: stale");
  await store.updateServer("ms-a", { host: row.host, updatedAt: T0 });
  assertEquals((await send()).status, 200);
  assertOnlyOwnLaunch(gw);
});

test("a superseded relaunch that fails late leaves the newer launch's route alone", async () => {
  const { store } = await freshStore();
  const { host } = heldHost();
  /** Host writes until the one held at the store's door, then failed: the restart's `starting`,
   * the digest, then the handle. */
  let holdIn = 0;
  let entered!: () => void;
  let fail!: () => void;
  const reached = new Promise<void>((r) => (entered = r));
  const failed = new Promise<void>((r) => (fail = r));
  const flaky: GatewayStore = {
    ...store,
    updateServer: async (id, edit) => {
      if (holdIn > 0 && edit.host !== undefined && --holdIn === 0) {
        entered();
        await failed;
        throw new Error("connection reset");
      }
      return await store.updateServer(id, edit);
    },
  };
  const { gw, send } = await launchedGateway(flaky, host);
  // Two restarts from the same row: the same inputs, so the same name. The first launches, and
  // its handle write hangs...
  holdIn = 3;
  await gw.hosting.launch((await store.getServer("ms-a"))!);
  await reached;
  // ...while the second launches under that name again and is routed.
  await gw.hosting.launch((await store.getServer("ms-a"))!);
  while (gw.hosting.route("ms-a")?.ready !== true) await new Promise((r) => setTimeout(r, 1));
  const routed = gw.hosting.route("ms-a");
  // The first fails now. Its name is the second's, but the route is the second's own.
  fail();
  await gw.hosting.idle();
  assertEquals(gw.hosting.route("ms-a"), routed);
  assertEquals((await send()).status, 200);
  assertEquals((await store.getServer("ms-a"))!.host?.status, "healthy");
  assertOnlyOwnLaunch(gw);
});

/** A call refused as a launch still coming up: the row's own container is being replaced. */
async function assertStarting(send: () => Promise<Response>) {
  const res = await send();
  assertEquals(res.status, 503);
  assertEquals((await res.json()).code, "hosted_starting");
}

test("a relaunch superseded after its launch never routes what it launched", async () => {
  const { handle, store } = await freshStore();
  const { host, inner, hold } = heldHost();
  const { gw, send } = await launchedGateway(store, host);
  const row = (await store.getServer("ms-a"))!;
  await rewrite(handle, "ms-a", { custom: { ...row.custom!, image: EVIL } });
  // The relaunch from the edited row is held at the backend's door...
  const first = hold(TOOL);
  await gw.hosting.launch((await store.getServer("ms-a"))!);
  await first.reached;
  // ...the row goes back, and a newer launch (an admin's restart) is queued, held as well.
  await rewrite(handle, "ms-a", { custom: row.custom });
  const second = hold(TOOL);
  await gw.hosting.launch((await store.getServer("ms-a"))!);
  first.release();
  await second.reached;
  // The superseded launch put the other image up, under its own name; the row's key is its own,
  // and is being relaunched under that same name: a starting launch, never the other image.
  assertEquals(images(inner), [EVIL, LEGIT]);
  await assertStarting(send);
  second.release();
  await gw.hosting.idle();
  assertEquals((await send()).status, 200);
  assertEquals(gw.dialled.at(-1)?.authorization, "Bearer the-real-credential");
  assertOnlyOwnLaunch(gw);
});

test("A→B→A by an admin sends nothing to B", async () => {
  const { store } = await freshStore();
  const { host, inner, hold } = heldHost();
  const { gw, send } = await launchedGateway(store, host);
  const a = (await store.getServer("ms-a"))!;
  const setCustom = (custom: McpServer["custom"]) =>
    store.updateServer("ms-a", { ...({ custom } as object), updatedAt: T0 } as never);
  // To B, its launch held at the door; then back to A, that launch queued behind it.
  await setCustom({ ...a.custom!, image: EVIL });
  const toB = hold(TOOL);
  await gw.hosting.launch((await store.getServer("ms-a"))!);
  await toB.reached;
  await setCustom(a.custom);
  const toA = hold(TOOL);
  await gw.hosting.launch((await store.getServer("ms-a"))!);
  toB.release();
  await toA.reached;
  // B runs and the row says A again: A's key names A's container, which B never touched — and
  // which is being replaced under its own name, so a call meanwhile is told it is starting.
  assertEquals(images(inner), [EVIL, LEGIT]);
  await assertStarting(send);
  toA.release();
  await gw.hosting.idle();
  assertEquals((await send()).status, 200);
  assertOnlyOwnLaunch(gw);
});

test("a row reverted in the database while the relaunch writes it sends nothing to it", async () => {
  const { handle, store } = await freshStore();
  const { host, inner } = heldHost();
  let holdIn = 0;
  let release!: () => void;
  let reached!: () => void;
  const writing = new Promise<void>((r) => (reached = r));
  const slow: GatewayStore = {
    ...store,
    updateServer: async (id, edit) => {
      if (holdIn > 0 && edit.host !== undefined && --holdIn === 0) {
        reached();
        await new Promise<void>((r) => (release = r));
      }
      return await store.updateServer(id, edit);
    },
  };
  const { gw, send } = await launchedGateway(slow, host);
  const row = (await store.getServer("ms-a"))!;
  await rewrite(handle, "ms-a", { custom: { ...row.custom!, image: EVIL } });
  holdIn = 3; // the restart's `starting`, the digest, then the handle — after the launch
  await gw.hosting.launch((await store.getServer("ms-a"))!);
  await writing;
  assertEquals(images(inner), [EVIL, LEGIT]);
  await rewrite(handle, "ms-a", { custom: row.custom });
  await store.updateServer("ms-a", { host: row.host, updatedAt: T0 });
  assertEquals((await send()).status, 200, "the row's own launch still serves its key");
  release();
  await gw.hosting.idle();
  // Landed, the route is the edited row's key, which the reverted row is not.
  const res = await send();
  assertEquals(res.status, 503);
  assertEquals((await res.json()).code, "hosted_stale");
  assertOnlyOwnLaunch(gw);
});

test("a row reverted in the database mid-relaunch sends nothing to the container its edit got", async () => {
  const { handle, store } = await freshStore();
  const { host, inner, hold } = heldHost();
  const { gw, send } = await launchedGateway(store, host);
  const row = (await store.getServer("ms-a"))!;
  await rewrite(handle, "ms-a", { custom: { ...row.custom!, image: EVIL } });
  // The vendor container is replaced; the guard's relaunch (its caller table changed) is held,
  // so the route has not been set from this launch yet.
  const guard = hold(/^ryph-tool-guard$/);
  await gw.hosting.launch((await store.getServer("ms-a"))!);
  await guard.reached;
  assertEquals(images(inner), [EVIL, LEGIT]);
  await rewrite(handle, "ms-a", { custom: row.custom });
  let res = await send();
  assertEquals(res.status, 503);
  guard.release();
  await gw.hosting.idle();
  // Landed, it is routed under the edited row's key, which the reverted row is not.
  res = await send();
  assertEquals(res.status, 503);
  assertEquals((await res.json()).code, "hosted_stale");
  assertEquals(gw.dialled, []);
  assertOnlyOwnLaunch(gw);
});

test("a probe of a hosted row whose credential will not open reaches the container without it first", async () => {
  const { store } = await freshStore();
  let answer: () => Promise<Response> = () => Promise.resolve(new Response(null, { status: 401 }));
  await store.createServer(customRow("ms-a", LEGIT));
  const gw = gateway(store, { answer: () => answer() });
  await gw.hosting.boot();
  await gw.hosting.idle();
  await store.updateServer("ms-a", { encryptedAuth: "v2.does-not-open", updatedAt: T0 });
  // It answers (a 401 to a caller with no credential): the credential is the row's to fix.
  let probed = await gw.probe((await store.getServer("ms-a"))!);
  assert(!probed.ok && probed.reason === "secret_required", JSON.stringify(probed));
  assertEquals(gw.dialled.at(-1)?.authorization, null, "asked without any credential");
  // It does not answer: that is the container's, and the supervisor's to relaunch.
  answer = () => Promise.reject(new Error("connection refused"));
  probed = await gw.probe((await store.getServer("ms-a"))!);
  assert(!probed.ok && probed.reason === "unreachable", JSON.stringify(probed));
});

for (
  const [what, value] of [
    ["a zero-width space", "key-​the-secret-value"],
    ["an ideographic space", "Bearer　the-secret-value"],
    ["a non-ASCII letter", "the-secret-välue"],
  ] as const
) {
  test(`a stored credential value with ${what} is refused with a code, and never logged`, async () => {
    const { handle, store } = await freshStore();
    await store.createServer(server({
      id: "ms-r",
      slug: "remote",
      kind: "remote",
      url: "https://mcp.example.com/mcp",
      auth: "headers",
      encryptedAuth: `sealed:${JSON.stringify({ "X-Api-Key": "fine-secret" })}`,
    }));
    await handle.db.update(schema.mcpServers)
      .set({ encryptedAuth: `sealed:${JSON.stringify({ "X-Api-Key": value })}` })
      .where(eq(schema.mcpServers.id, "ms-r"));
    const warnings: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const printed: string[] = [];
    const real = { error: console.error, warn: console.warn, log: console.log };
    console.error = console.warn = console.log = (...args: unknown[]) => {
      printed.push(
        args.map((a) => a instanceof Error ? `${a.message} ${a.stack}` : String(a)).join(" "),
      );
    };
    try {
      const gw = gateway(store, { warnings });
      const { token, url } = await runKey(store, "ms-r");
      const res = await gw.handler(call(url, token));
      assertEquals(res.status, 502);
      const body = await res.text();
      assertEquals(JSON.parse(body).code, "credential_header_refused");
      const probed = await gw.probe((await store.getServer("ms-r"))!);
      assert(!probed.ok && probed.reason === "secret_required", JSON.stringify(probed));
      assertEquals(gw.dialled, []);
      for (const seen of [body, JSON.stringify(probed), JSON.stringify(warnings), ...printed]) {
        assert(!seen.includes("the-secret"), `the value leaked: ${seen}`);
      }
    } finally {
      Object.assign(console, real);
    }
  });
}

// ── The dial target ─────────────────────────────────────────────────────────────────────────────

test("a hosted row is dialled at its own key, whatever its stored url or slug says", async () => {
  const { handle, store } = await freshStore();
  // A database writer's own hosted row, under another slug, holding no credential...
  await store.createServer(
    customRow("ms-e", EVIL, { slug: "alpha", encryptedAuth: null, auth: "none" }),
  );
  // ...and the victim's, holding one.
  await store.createServer(customRow("ms-b", LEGIT));
  const gw = gateway(store);
  await gw.hosting.boot();
  await gw.hosting.idle();
  const origin = gw.hosting.guard()!.origin;
  const evilKey = gw.hosting.route("ms-e")!.key;

  // Their row is called once, so its route is live and dialled...
  const evil = await runKey(store, "ms-e");
  assertEquals((await gw.handler(call(evil.url, evil.token))).status, 200);
  assertEquals(gw.dialled.at(-1)?.url, `${origin}/${evilKey}/mcp`);
  gw.dialled.length = 0;

  // ...then the victim's url is pointed at it, and its slug changed to theirs. Neither is an
  // address: the victim is dialled at its own key.
  await rewrite(handle, "ms-b", { url: `${origin}/${evilKey}/mcp` });
  await handle.db.update(schema.mcpServers).set({ slug: "alpha2" }).where(
    eq(schema.mcpServers.id, "ms-b"),
  );
  const { token, url } = await runKey(store, "ms-b");
  const res = await gw.handler(call(url, token));
  // The slug is part of the launch's inputs, so its key moved: stale until relaunched.
  assertEquals(res.status, 503);
  assertEquals((await res.json()).code, "hosted_stale");
  await gw.hosting.launch((await store.getServer("ms-b"))!);
  await gw.hosting.idle();
  assertEquals((await gw.handler(call(url, token))).status, 200);
  assertEquals(gw.dialled.map((d) => d.url), [`${origin}/${gw.hosting.route("ms-b")!.key}/mcp`]);
  assert(!gw.dialled.some((d) => d.url.includes(evilKey)), "nothing reached their container");
  assertOnlyOwnLaunch(gw);
});

test("a stop landing between the check and the dial still dials only the row's own key", async () => {
  const { store } = await freshStore();
  let onOpen = () => {};
  const gw = gateway(store, {
    decrypt: (sealed) => {
      onOpen();
      return fakeDecrypt(sealed);
    },
  });
  await store.createServer(customRow("ms-a", LEGIT));
  await gw.hosting.boot();
  await gw.hosting.idle();
  const { token, url } = await runKey(store, "ms-a");
  assertEquals((await gw.handler(call(url, token))).status, 200);
  const row = (await store.getServer("ms-a"))!;
  let stopping: Promise<unknown> | null = null;
  onOpen = () => {
    stopping ??= gw.hosting.stop(row);
  };
  // The address is the launch's: at worst it answers nothing, never something else.
  await (await gw.handler(call(url, token))).body?.cancel();
  await stopping;
  assertOnlyOwnLaunch(gw);
});

test("a stop landing between the probe's requests leaves them at the row's own key", async () => {
  const { store } = await freshStore();
  let onDial = () => {};
  const gw = gateway(store, {
    answer: () => {
      onDial();
      return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
    },
  });
  await store.createServer(customRow("ms-a", LEGIT));
  await gw.hosting.boot();
  await gw.hosting.idle();
  const row = (await store.getServer("ms-a"))!;
  let stopping: Promise<unknown> | null = null;
  onDial = () => {
    stopping ??= gw.hosting.stop(row);
  };
  await gw.probe(row);
  await stopping;
  assertEquals(new Set(gw.dialled.map((d) => d.url)).size, 1, "one address throughout");
  assertOnlyOwnLaunch(gw);
});

test("a connection refused just after a launch is `hosted_starting`, not an uncoded 502", async () => {
  const { store } = await freshStore();
  let clock = Date.parse(T0);
  let answer: () => Promise<Response> = () =>
    Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
  const gw = gateway(store, { answer: () => answer(), now: () => new Date(clock) });
  await store.createServer(customRow("ms-a", LEGIT));
  await gw.hosting.boot();
  await gw.hosting.idle();
  assertEquals((await store.getServer("ms-a"))?.host?.status, "healthy");
  const { token, url } = await runKey(store, "ms-a");
  // The guard was replaced a moment ago and does not accept connections yet.
  const refused = Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
  answer = () => Promise.reject(refused);
  let res = await gw.handler(call(url, token));
  assertEquals(res.status, 503);
  assertEquals((await res.json()).code, "hosted_starting");
  // A connection that was made and then failed — a timeout, a reset — may have reached the
  // server: the uncoded 502, settling or not.
  answer = () => Promise.reject(new Error("upstream headers timeout"));
  res = await gw.handler(call(url, token));
  assertEquals(res.status, 502);
  await res.body?.cancel();
  answer = () => Promise.reject(refused);
  // Long after, a refused connection is the container's: the 502 pi-mcp already retries.
  clock += 30_000; // past the settling window, inside the run key's lifetime
  res = await gw.handler(call(url, token));
  assertEquals(res.status, 502);
  assertEquals((await res.json()).error, "upstream unreachable");
  // A row whose launch has not been seen to answer yet is still starting, however long ago.
  await store.updateServer("ms-a", {
    host: { ...(await store.getServer("ms-a"))!.host!, status: "starting" },
    updatedAt: T0,
  });
  res = await gw.handler(call(url, token));
  assertEquals(res.status, 503);
  assertEquals((await res.json()).code, "hosted_starting");
});

test("a row reverted mid-launch is relaunched as soon as its startup probe finds it stale", async () => {
  const { handle, store } = await freshStore();
  const { host, inner } = heldHost();
  let holdIn = 0;
  let release!: () => void;
  let reached!: () => void;
  const writing = new Promise<void>((r) => (reached = r));
  const slow: GatewayStore = {
    ...store,
    updateServer: async (id, edit) => {
      if (holdIn > 0 && edit.host !== undefined && --holdIn === 0) {
        reached();
        await new Promise<void>((r) => (release = r));
      }
      return await store.updateServer(id, edit);
    },
  };
  await slow.createServer(customRow("ms-a", LEGIT));
  const gw = gateway(slow, { host, realProbe: true });
  await gw.hosting.boot();
  await gw.hosting.idle();
  const row = (await store.getServer("ms-a"))!;
  await rewrite(handle, "ms-a", { custom: { ...row.custom!, image: EVIL } });
  holdIn = 3; // the restart's `starting`, the digest, then the handle — after the launch
  await gw.hosting.launch((await store.getServer("ms-a"))!);
  await writing;
  assertEquals(images(inner), [EVIL, LEGIT]);
  await rewrite(handle, "ms-a", { custom: row.custom });
  const launches = inner.launches.length;
  release();
  // No supervisor tick: the startup wait itself relaunches from the reverted row.
  await gw.hosting.idle();
  const relaunched = inner.launches.slice(launches).filter((l) => TOOL.test(l.name));
  assertEquals(relaunched.map((l) => l.image), [LEGIT]);
  assertEquals((await store.getServer("ms-a"))?.host?.status, "healthy");
  const { token, url } = await runKey(store, "ms-a");
  assertEquals((await gw.handler(call(url, token))).status, 200);
  assertEquals(gw.dialled.at(-1)?.authorization, "Bearer the-real-credential");
  assertOnlyOwnLaunch(gw);
});

test("two rows racing at boot each get their own key, and a credential only its own", async () => {
  // Round 5's attack: a row written into the database whose old-style name — `ryph-tool-` + slug
  // + `-` + id — is the victim's (`tools` + `ms-a` read as `tools-ms` + `a`), with their image
  // and no credential, booted beside it. Under launch keys the two share nothing.
  const { store } = await freshStore();
  await store.createServer(customRow("ms-a", LEGIT));
  await store.createServer(
    customRow("a", EVIL, { slug: "tools-ms", encryptedAuth: null, auth: "none" }),
  );
  const gw = gateway(store);
  await gw.hosting.boot();
  await gw.hosting.idle();
  const [mine, theirs] = [gw.hosting.route("ms-a")!, gw.hosting.route("a")!];
  assert(mine.ready && theirs.ready);
  assert(mine.key !== theirs.key);
  assertEquals(gw.host.containers.size, 3, "two servers and the guard");
  const { token, url } = await runKey(store, "ms-a");
  assertEquals((await gw.handler(call(url, token))).status, 200);
  assertOnlyOwnLaunch(gw);
});

test("a database writer toggling a row under a startup wait gets backed-off relaunches", async () => {
  // Every startup probe finds the route stale (the row keeps moving): the wait relaunches at once
  // the first time, and then only as the row's backoff comes due — not once per probe.
  const { handle, store } = await freshStore();
  let clock = Date.parse(T0);
  await store.createServer(customRow("ms-a", LEGIT));
  const host = fakeToolHost();
  const gw = gateway(store, {
    host,
    realProbe: true,
    now: () => new Date(clock),
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  });
  await gw.hosting.boot();
  await gw.hosting.idle();
  const before = host.launches.filter((l) => TOOL.test(l.name)).length;
  let flip = false;
  const realLaunch = host.launch.bind(host);
  host.launch = async (spec) => {
    const out = await realLaunch(spec);
    if (TOOL.test(spec.name)) {
      // Right after each launch, the row moves again, so the launch is stale on arrival.
      flip = !flip;
      const row = (await store.getServer("ms-a"))!;
      await rewrite(handle, "ms-a", {
        custom: { ...row.custom!, command: flip ? ["--flip"] : [] },
      });
    }
    return out;
  };
  await gw.hosting.launch((await store.getServer("ms-a"))!);
  await gw.hosting.idle();
  const relaunches = host.launches.filter((l) => TOOL.test(l.name)).length - before;
  // 60 s of startup window: the launch, the immediate stale relaunch, one at 30 s — not thirty.
  assert(relaunches <= 4, `${relaunches} launches in one startup window`);
  assertEquals((await store.getServer("ms-a"))?.host?.status, "unreachable");
});

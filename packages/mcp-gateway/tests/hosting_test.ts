// A hosted server's life against a fake ToolHost: boot (network, guard, reconcile), launch and
// the wait for a first answer, relaunch and image updates, stop, the supervisor's probes and
// backoff, and the guard's route table and token following all of it.

import { test } from "bun:test";
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { directoryCatalogue } from "../src/adapters/catalogue/directory.ts";
import type { Catalogue } from "../src/ports/catalogue.ts";
import { digestOf, type HostedCatalogueEntry } from "../src/core/catalogue.ts";
import {
  currentContainer,
  GUARD_NAME,
  type HostingLimits,
  makeHosting,
} from "../src/core/hosting.ts";
import type { McpServer } from "../src/core/types.ts";
import type { GatewayStore } from "../src/ports/gateway_store.ts";
import { fixedCatalogue } from "./api.ts";
import { type FakeToolHost, fakeToolHost } from "./fake_tool_host.ts";
import type { HostingLease } from "../src/core/lease.ts";
import { leaseSlot } from "./fake_lease.ts";
import { memoryGatewayStore } from "./memory_store.ts";
import { server, T0 } from "./fixtures.ts";
import { mintToolEgressClaim, TOOL_PROXY_ENV_NAMES } from "../src/core/tool_egress.ts";
import { hostedDial, launchKey } from "../src/core/sealing.ts";
import { TOOL_CONTAINER_NAME } from "../src/core/tool_guard.ts";
import { verifyToken, verifyToolToken } from "../../../images/egress-proxy/main.ts";

const catalogue = await directoryCatalogue();
const grafana = (await catalogue.get("grafana")) as HostedCatalogueEntry;
const TOKEN = "glsa_serviceaccounttoken9876";

function hostedRow(overrides: Partial<McpServer> = {}): McpServer {
  return server({
    id: "ms-g1",
    slug: "grafana",
    name: "Grafana",
    kind: "hosted",
    url: "",
    auth: "headers",
    encryptedAuth: `sealed:${
      JSON.stringify({
        "X-Grafana-URL": "https://grafana.example.com",
        "X-Grafana-Service-Account-Token": TOKEN,
      })
    }`,
    authLast4: "9876",
    catalogueId: "grafana",
    settings: { GRAFANA_URL: "https://grafana.example.com", readOnly: true },
    host: { handle: null, status: "starting", imageDigest: null, startedAt: null, lastError: null },
    ...overrides,
  });
}

interface Harness {
  store: GatewayStore;
  host: FakeToolHost;
  hosting: ReturnType<typeof makeHosting>;
  clock: { now: number };
  /** Per-slug probe answer; true unless a test says otherwise. */
  answers: Map<string, boolean>;
  /** Per-slug failed verdict with a reason, ahead of `answers`. */
  verdicts: Map<string, { ok: false; reason: string; detail: string; code?: string }>;
  probed: McpServer[];
  warnings: Array<{ event: string; data?: Record<string, unknown> }>;
}

function harness(
  opts: {
    reachesGuard?: boolean;
    limits?: Partial<HostingLimits>;
    store?: GatewayStore;
    catalogue?: Catalogue;
    /** Shared by two harnesses standing for two gateway processes on one cluster. */
    host?: FakeToolHost;
    lease?: HostingLease;
    onLeaseLost?: () => void;
    toolEgress?: { mint(subject: string): Promise<string> };
    guardImage?: string | null;
  } = {},
): Harness {
  const store = opts.store ?? memoryGatewayStore();
  const host = opts.host ?? fakeToolHost({ reachesGuard: opts.reachesGuard });
  const clock = { now: Date.parse(T0) };
  const answers = new Map<string, boolean>();
  const verdicts: Harness["verdicts"] = new Map();
  const probed: McpServer[] = [];
  const warnings: Harness["warnings"] = [];
  const hosting = makeHosting({
    store,
    host,
    catalogue: opts.catalogue ?? catalogue,
    probe: (s) => {
      probed.push(s);
      const verdict = verdicts.get(s.slug);
      if (verdict !== undefined) return Promise.resolve(verdict);
      return Promise.resolve(
        answers.get(s.slug) === false ? { ok: false, detail: "connection refused" } : { ok: true },
      );
    },
    ...(opts.guardImage === null ? {} : { guardImage: opts.guardImage ?? "ryph-tool-guard:test" }),
    ...(opts.toolEgress === undefined ? {} : { toolEgress: opts.toolEgress }),
    now: () => new Date(clock.now),
    diag: { debug() {}, warn: (event, data) => warnings.push({ event, data }) },
    limits: opts.limits,
    lease: opts.lease,
    onLeaseLost: opts.onLeaseLost,
    // Every wait advances the clock instead of sleeping, so the startup window closes on cue.
    sleep: (ms) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  return { store, host, hosting, clock, answers, verdicts, probed, warnings };
}

/** The container a row's current launch runs under, from the row as stored. */
async function nameOf(store: GatewayStore, id: string): Promise<string> {
  const name = await currentContainer((await store.getServer(id))!);
  assert(name !== null, `${id} has been launched`);
  return name;
}
const keyOf = (name: string) => name.slice("ryph-tool-".length);
/** A vendor container's name, as the fake host is asked to fail one. */
const VENDOR = /^ryph-tool-[0-9a-f]{32}$/;

async function launched(h: Harness, row = hostedRow()): Promise<McpServer> {
  await h.store.createServer(row);
  await h.hosting.launch(row);
  await h.hosting.idle();
  return (await h.store.getServer(row.id))!;
}

test("boot creates the network and launches the guard with a fresh token, on loopback", async () => {
  const h = harness();
  await h.hosting.boot();
  assert(h.host.networkEnsured);
  assertEquals(h.hosting.availability(), { available: true });

  const guard = h.host.guard()!;
  assertEquals(guard.image, "ryph-tool-guard:test");
  assertEquals(guard.env.RYPH_TOOL_ROUTES, "");
  // The token is a SECRET env: the adapter passes it by name and puts the value on its own
  // process, so it is never a word in a container-runtime argv.
  assertEquals(guard.env.RYPH_TOOL_GUARD_TOKEN, undefined);
  assertEquals(guard.secretEnv!.RYPH_TOOL_GUARD_TOKEN.length, 64);
  // docker: the guard is the one launch that is published, and the adapter binds it to loopback.
  assertEquals(guard.publish, { hostPort: 0 });
  const access = h.hosting.guard()!;
  assertEquals(access.token, guard.secretEnv!.RYPH_TOOL_GUARD_TOKEN);
  assert(access.origin.startsWith("http://127.0.0.1:"));
});

test("under a backend that reaches containers, the guard is not published at all", async () => {
  const h = harness({ reachesGuard: true });
  await h.hosting.boot();
  assertEquals(h.host.guard()!.publish, undefined);
  assert(h.hosting.guard()!.origin.startsWith("http://10.9.0."));
});

test("the guard token rotates on every boot and is never written to a row", async () => {
  const store = memoryGatewayStore();
  const first = harness({ store });
  await first.hosting.boot();
  const row = await launched(first);
  const firstToken = first.hosting.guard()!.token;

  const second = harness({ store });
  await second.hosting.boot();
  assertNotEquals(second.hosting.guard()!.token, firstToken);
  for (const token of [firstToken, second.hosting.guard()!.token]) {
    assert(!JSON.stringify(await store.listServers()).includes(token));
  }
  assertEquals(row.host?.status, "healthy");
});

test("an entry's own sizing wins over the deployment's default, in both directions", async () => {
  // A heavy server can ask for more without every other server paying for it — which is the
  // whole point of the default being low. Memory and CPU travel the same path.
  const heavy: Catalogue = {
    list: () => catalogue.list(),
    get: (id) =>
      catalogue.get(id).then((e) => e === null ? null : { ...e, cpus: "2", memory: "4g" }),
  };
  const h = harness({ catalogue: heavy });
  await h.hosting.boot();
  await launched(h);

  const spec = h.host.launches.find((l) => l.name !== GUARD_NAME)!;
  assertEquals(spec.cpus, "2");
  assertEquals(spec.memory, "4g");
});

test("a guard deleted behind the gateway's back is put back by the supervisor", async () => {
  // The shape of a Kubernetes rolling update: the arriving gateway launches the guard, then the
  // departing one removes it by the same stable name. Nothing is wrong with this process's
  // state — which is exactly why nothing noticed until the supervisor was made to ask.
  const h = harness();
  await h.hosting.boot();
  const before = h.hosting.guard()!.origin;
  h.host.containers.delete(GUARD_NAME);
  assertEquals(await h.host.inspect(GUARD_NAME), "unknown");

  await h.hosting.supervise();

  assertEquals(await h.host.inspect(GUARD_NAME), "running");
  assertEquals(h.hosting.guard()!.origin, before, "same address, so no row needs rewriting");
  // And with no tool servers at all — the case with no row whose relaunch could mask it.
  assertEquals(h.host.guard()!.env.RYPH_TOOL_ROUTES, "");
});

test("a guard that merely died is relaunched too, and its routes survive", async () => {
  const h = harness();
  await h.hosting.boot();
  await launched(h);
  const routes = h.host.guard()!.env.RYPH_TOOL_ROUTES;
  assert(routes.includes(await nameOf(h.store, "ms-g1")));

  h.host.crash(GUARD_NAME);
  await h.hosting.supervise();

  assertEquals(await h.host.inspect(GUARD_NAME), "running");
  // Rebuilt from this process's route map, not from nothing: the hosted server is still there.
  assertEquals(h.host.guard()!.env.RYPH_TOOL_ROUTES, routes);
});

test("a healthy guard is left alone, however often the supervisor runs", async () => {
  // The reconcile must not become a relaunch loop: one backend question per tick, no launch.
  const h = harness();
  await h.hosting.boot();
  await launched(h);
  const launchCount = h.host.launches.length;

  await h.hosting.supervise();
  await h.hosting.supervise();
  await h.hosting.supervise();

  assertEquals(h.host.launches.length, launchCount, "no relaunch while the guard is running");
});

test("a backend that will not answer is not treated as a missing guard", async () => {
  // Relaunching on the strength of an unanswerable question would turn a blip into an outage.
  const h = harness();
  await h.hosting.boot();
  const launchCount = h.host.launches.length;
  h.host.inspect = () => Promise.reject(new Error("api server said 503"));

  await h.hosting.supervise();

  assertEquals(h.host.launches.length, launchCount);
});

test("the guard is sized by the adapter, not by the servers' default", async () => {
  // The guard names no cpus at all, so lowering (or raising) the tool default never moves it.
  // It is our own build with its own profile; coupling the two would be an accident.
  const h = harness({ limits: { cpus: "8" } });
  await h.hosting.boot();
  assertEquals(h.host.guard()!.cpus, undefined);
});

test("launch: starting at once, then the container, its route, the guard, healthy", async () => {
  const h = harness();
  await h.hosting.boot();
  await h.store.createServer(hostedRow());
  const answered = await h.hosting.launch(hostedRow());
  assertEquals(answered.host?.status, "starting");
  await h.hosting.idle();

  const name = await nameOf(h.store, "ms-g1");
  assert(TOOL_CONTAINER_NAME.test(name), name);
  const spec = h.host.launches.find((l) => l.name === name)!;
  assertEquals(spec.image, `grafana/mcp-grafana@${digestOf(grafana.image)}`);
  assertEquals(spec.command, [...grafana.command, "--disable-write"]);
  // Settings, and a caller token the gateway minted — the operator's token is in the sealed
  // header map and nowhere near the container.
  assertEquals(spec.env, { GRAFANA_URL: "https://grafana.example.com" });
  const caller = spec.secretEnv!.MCP_GRAFANA_SERVER_TOKEN;
  assertEquals(Object.keys(spec.secretEnv!), ["MCP_GRAFANA_SERVER_TOKEN"]);
  assertEquals(caller.length, 64);
  assert(!JSON.stringify(spec).includes(TOKEN));
  assertEquals(spec.publish, undefined);
  assertEquals(spec.memory, "512m");
  // A quarter CPU, not a whole one. An MCP server waits between tool calls, and on a
  // per-request-billed platform the floor is paid in full whether a tool is called or not.
  assertEquals(spec.cpus, "0.25");

  // The guard was relaunched routing the launch's key to its container, with the same caller
  // token. The caller token is never on a row.
  const key = keyOf(name);
  assertEquals(h.host.guard()!.env.RYPH_TOOL_ROUTES, `${key}=${name}:8000/mcp`);
  assertEquals(h.host.guard()!.secretEnv!.RYPH_TOOL_CALLER_TOKENS, `${key}=${caller}`);
  assert(!JSON.stringify(await h.store.listServers()).includes(caller));
  const row = (await h.store.getServer("ms-g1"))!;
  assertEquals(row.host?.status, "healthy");
  assertEquals(row.host?.handle, name);
  assertEquals(row.host?.imageDigest, digestOf(grafana.image));
  assertEquals(row.host?.lastError, null);
  // The key is the row's, at the digest it runs, and the guard serves it.
  assertEquals(key, await launchKey(row, digestOf(grafana.image)));
  assertEquals(h.hosting.route("ms-g1"), { key, ready: true });
});

test("a server that never answers is unreachable after the startup window, with why", async () => {
  const h = harness();
  await h.hosting.boot();
  h.answers.set("grafana", false);
  const row = await launched(h);
  assertEquals(row.host?.status, "unreachable");
  assert(row.host?.lastError?.includes("did not answer within 60 s: connection refused"));
  // Probed on the poll interval for the whole window, not once and not forever.
  assertEquals(h.probed.length, 31);
});

test("a launch the backend refuses is unreachable with its error, and nothing secret", async () => {
  const h = harness();
  await h.hosting.boot();
  h.host.failLaunch(VENDOR, "pull access denied for grafana/mcp-grafana");
  const row = await launched(h);
  assertEquals(row.host?.status, "unreachable");
  assertEquals(row.host?.lastError, "pull access denied for grafana/mcp-grafana");
  assertEquals(row.host?.handle, null);
  assert(!JSON.stringify(h.warnings).includes(TOKEN));
});

test("a relaunch keeps the row's digest; updateImage moves it to the catalogue's", async () => {
  const older = `sha256:${"0".repeat(64)}`;
  const h = harness();
  await h.hosting.boot();
  const row = await launched(
    h,
    hostedRow({
      host: {
        handle: null,
        status: "starting",
        imageDigest: older,
        startedAt: null,
        lastError: null,
      },
    }),
  );
  assertEquals(row.host?.imageDigest, older);
  assertEquals(h.host.launches.at(-2)?.image, `grafana/mcp-grafana@${older}`);

  await h.hosting.launch(row);
  await h.hosting.idle();
  assertEquals((await h.store.getServer(row.id))?.host?.imageDigest, older);

  await h.hosting.launch((await h.store.getServer(row.id))!, { updateImage: true });
  await h.hosting.idle();
  assertEquals((await h.store.getServer(row.id))?.host?.imageDigest, digestOf(grafana.image));
  assertEquals(await h.hosting.latestDigest(row), digestOf(grafana.image));
});

test("a row that never got a handle is still stopped, by the name it would have had", async () => {
  // A launch that failed leaves `handle: null`, and an archive is the last time anything names
  // this row's container at all — so the stop is by name rather than skipped.
  const h = harness();
  await h.hosting.boot();
  h.host.failLaunch(VENDOR, "no space left on device");
  const row = await launched(h);
  assertEquals(row.host?.handle, null);
  await h.hosting.stop({ ...row, archivedAt: T0 });
  assertEquals(h.host.stops, [await nameOf(h.store, row.id)]);
});

test("stop removes the container and its route; the guard forgets it", async () => {
  const h = harness();
  await h.hosting.boot();
  const row = await launched(h);
  const archived = { ...row, archivedAt: T0 };
  await h.store.saveServer(archived);
  const stopped = await h.hosting.stop(archived);
  assertEquals(stopped.host?.status, "stopped");
  assertEquals(h.host.stops, [row.host!.handle!]);
  assertEquals(h.host.guard()!.env.RYPH_TOOL_ROUTES, "");
  assertEquals(h.hosting.route(row.id), null);
});

/** A custom-image row. It names a caller-token env var, because every custom row must. */
const customRow = (id: string, slug: string) =>
  hostedRow({
    id,
    slug,
    catalogueId: null,
    settings: null,
    custom: {
      image: `r.example.com/tools@sha256:${"e".repeat(64)}`,
      command: [],
      port: 9000,
      path: "/mcp",
      callerAuth: { env: "TOOLS_SERVER_TOKEN" },
    },
  });

/**
 * The one entry shape whose container holds nothing this process minted — an image that cannot
 * authenticate its callers, opting out with the reason a reviewer weighed. Only such a row can be
 * KEPT across a restart; everything else is relaunched for its token.
 */
const plainEntry: HostedCatalogueEntry = {
  ...grafana,
  id: "plain",
  callerAuth: { none: true, reason: "the demo image serves one public dataset and reads no token" },
};
const plainCatalogue = fixedCatalogue([grafana, plainEntry]);
const plainRow = (id: string, slug: string) => hostedRow({ id, slug, catalogueId: "plain" });

test("boot relaunches every live row under its key, each caller token minted afresh", async () => {
  const store = memoryGatewayStore();
  const first = harness({ store, catalogue: plainCatalogue });
  await first.hosting.boot();
  const noCredential = { auth: "none" as const, encryptedAuth: null, authLast4: null };
  await launched(first, { ...plainRow("ms-a", "tools-a"), ...noCredential });
  await launched(first, plainRow("ms-d", "tools-d"));
  await launched(first, customRow("ms-b", "tools-b"));
  await launched(first, hostedRow({ id: "ms-c", slug: "grafana" }));

  // A gateway restart, with the same containers still on the backend — one of them dead.
  const second = harness({ store, catalogue: plainCatalogue });
  for (const [name, c] of first.host.containers) second.host.containers.set(name, c);
  second.host.crash(await nameOf(store, "ms-d"));
  await second.hosting.boot();
  await second.hosting.idle();

  // Every one: a caller token, an egress claim and a route lived and died with the last process,
  // and the same inputs give the same key, so each comes back under the name it had.
  const ids = ["ms-a", "ms-b", "ms-c", "ms-d"];
  const names = await Promise.all(ids.map((id) => nameOf(store, id)));
  const relaunched = second.host.launches.filter((l) => l.name !== GUARD_NAME).map((l) => l.name);
  assertEquals(relaunched.sort(), [...names].sort());
  assertEquals(second.host.stops, [], "nothing to sweep: every container is a row's current one");
  assertEquals(
    second.host.guard()!.env.RYPH_TOOL_ROUTES.split(",").map((r) => r.split("=")[0]),
    names.map(keyOf).sort(),
  );
  const launchOf = (id: string) =>
    second.host.launches.find((l) => l.name === names[ids.indexOf(id)])!.secretEnv ?? {};
  const grafanaToken = launchOf("ms-c").MCP_GRAFANA_SERVER_TOKEN;
  const customToken = launchOf("ms-b").TOOLS_SERVER_TOKEN;
  assert(customToken !== undefined, "a custom container is launched with a caller token");
  assertEquals(
    second.host.guard()!.secretEnv!.RYPH_TOOL_CALLER_TOKENS,
    [`${keyOf(names[2])}=${grafanaToken}`, `${keyOf(names[1])}=${customToken}`].sort().join(","),
  );
  for (const id of ids) {
    assertEquals((await store.getServer(id))!.host?.status, "healthy", id);
    assertEquals(second.hosting.route(id)?.ready, true, id);
  }
});

test("two rows whose names collided before launch keys get distinct ones", async () => {
  // `ryph-tool-${slug}-${id}` was not injective: slug `s` + id `ms-01jb…` read exactly as slug
  // `s-ms` + id `01jb…`, so a row written into the database could share another's address.
  const a = hostedRow({ id: "ms-01jb7k3m9x", slug: "s" });
  const b = hostedRow({ id: "01jb7k3m9x", slug: "s-ms" });
  assertEquals(`ryph-tool-${a.slug}-${a.id}`, `ryph-tool-${b.slug}-${b.id}`);
  const digest = digestOf(grafana.image);
  const [ka, kb] = [await launchKey(a, digest), await launchKey(b, digest)];
  assertNotEquals(ka, kb);
  // Every launch input moves the key; the same inputs always give the same one.
  assertEquals(await launchKey(a, digest), ka);
  for (
    const other of [
      hostedRow({ ...a, settings: { ...a.settings, GRAFANA_URL: "https://elsewhere.example" } }),
      hostedRow({ ...a, slug: "s2" }),
      hostedRow({ ...a, catalogueId: "plain" }),
    ]
  ) {
    assertNotEquals(await launchKey(other, digest), ka);
  }
  assertNotEquals(await launchKey(a, `sha256:${"1".repeat(64)}`), ka);

  // Launched side by side, each is its own container behind its own route.
  const h = harness();
  await h.hosting.boot();
  await launched(h, a);
  await launched(h, b);
  const names = [await nameOf(h.store, a.id), await nameOf(h.store, b.id)];
  assertNotEquals(names[0], names[1]);
  for (const name of names) assert(TOOL_CONTAINER_NAME.test(name) && name.length <= 63, name);
  assertEquals(h.host.containers.size, 3, "both, and the guard");
});

test("a custom container from before caller auth was required is refused a launch, with why", async () => {
  const h = harness();
  await h.hosting.boot();
  const legacy = customRow("ms-legacy", "tools-legacy");
  // The shape a row written by an older gateway has: no caller-auth env var named at all.
  legacy.custom = { ...legacy.custom!, callerAuth: null };
  await h.store.createServer(legacy);
  await h.hosting.launch(legacy);
  await h.hosting.idle();
  const row = (await h.store.getServer("ms-legacy"))!;
  assertEquals(row.host?.status, "unreachable");
  assert(row.host?.lastError?.includes("caller-auth"), row.host?.lastError ?? "no error");
  assertEquals(h.host.launches.filter((l) => l.name !== GUARD_NAME), []);
});

test("boot removes a container no live row accounts for, and the guard is never one", async () => {
  const store = memoryGatewayStore();
  const first = harness({ store });
  await first.hosting.boot();
  const kept = await launched(first, hostedRow({ id: "ms-keep", slug: "grafana" }));
  const orphaned = await launched(first, customRow("ms-gone", "tools-gone"));

  // Archived while the container is up and hosting cannot stop it — the shape that used to leak:
  // every later reconciliation path walks LIVE rows, so nothing would ever name this again.
  await store.saveServer({ ...orphaned, archivedAt: T0 });

  const second = harness({ store });
  for (const [name, c] of first.host.containers) second.host.containers.set(name, c);
  await second.hosting.boot();
  await second.hosting.idle();

  assertEquals(second.host.stops, [orphaned.host!.handle!]);
  assertEquals(second.host.containers.has(orphaned.host!.handle!), false);
  assert(second.host.containers.has(GUARD_NAME), "the guard is ours, never an orphan");
  assertEquals((await store.getServer(kept.id))!.host?.status, "healthy");
});

test("a backend that will not list is a boot that sweeps nothing, not a boot that fails", async () => {
  const store = memoryGatewayStore();
  const first = harness({ store });
  await first.hosting.boot();
  const row = await launched(first, hostedRow());

  const second = harness({ store });
  for (const [name, c] of first.host.containers) second.host.containers.set(name, c);
  second.host.failList("docker daemon is not responding");
  await second.hosting.boot();
  await second.hosting.idle();
  assert(second.hosting.availability().available);
  assertEquals((await store.getServer(row.id))!.host?.status, "healthy");
});

test("a stopped or archived row is left alone at boot", async () => {
  const store = memoryGatewayStore();
  await store.createServer(hostedRow({
    id: "ms-s",
    host: { handle: "x", status: "stopped", imageDigest: null, startedAt: null, lastError: null },
  }));
  await store.createServer(hostedRow({ id: "ms-z", slug: "gone", archivedAt: T0 }));
  const h = harness({ store });
  await h.hosting.boot();
  await h.hosting.idle();
  assertEquals(h.host.launches.map((l) => l.name), [GUARD_NAME]);
});

test("a settings change moves a row to a new key; the supervisor sweeps what it ran before", async () => {
  const h = harness({ reachesGuard: true });
  await h.hosting.boot();
  const row = await launched(h);
  const before = await nameOf(h.store, row.id);
  // The same inputs relaunch under the same name…
  await h.hosting.launch(row);
  await h.hosting.idle();
  assertEquals(await nameOf(h.store, row.id), before);
  // …and an edit to a bound setting launches under another, leaving the old one behind.
  const edited = { ...row, settings: { ...row.settings, GRAFANA_URL: "https://g2.example.com" } };
  await h.store.saveServer(edited);
  await h.hosting.launch(edited);
  await h.hosting.idle();
  const after = await nameOf(h.store, row.id);
  assertNotEquals(after, before);
  assert(h.host.containers.has(before));
  assertStringIncludes(h.host.guard()!.env.RYPH_TOOL_ROUTES, `${keyOf(after)}=${after}.`);
  assert(!h.host.guard()!.env.RYPH_TOOL_ROUTES.includes(keyOf(before)), "the old key is unrouted");
  // A supervisor tick, not a reboot, removes it.
  await h.hosting.supervise();
  assertEquals(h.host.stops, [before]);
  assert(h.host.containers.has(after));
});

test("containers from before launch keys are swept at boot and their rows relaunched", async () => {
  const store = memoryGatewayStore();
  await store.createServer(hostedRow({
    host: {
      handle: "ryph-tool-grafana-ms-g1",
      status: "healthy",
      imageDigest: digestOf(grafana.image),
      startedAt: T0,
      lastError: null,
    },
  }));
  const h = harness({ store });
  h.host.containers.set("ryph-tool-grafana-ms-g1", {
    spec: { ...h.host.launches[0], name: "ryph-tool-grafana-ms-g1" } as never,
    state: "running",
    address: "ryph-tool-grafana-ms-g1:8000",
  });
  await h.hosting.boot();
  await h.hosting.idle();
  assertEquals(h.host.stops, ["ryph-tool-grafana-ms-g1"]);
  const name = await nameOf(store, "ms-g1");
  assertEquals([...h.host.containers.keys()].sort(), [name, GUARD_NAME].sort());
  assertEquals((await store.getServer("ms-g1"))?.host?.handle, name);
});

test("under docker, a relaunch keeps the name, so the guard is not relaunched", async () => {
  // A row with no caller token, because a token rotates with every launch and is itself part of
  // the guard's table — the test next door is the one that pins that.
  const h = harness({ catalogue: plainCatalogue });
  await h.hosting.boot();
  const row = await launched(h, plainRow("ms-a", "tools-a"));
  const guards = () => h.host.launches.filter((l) => l.name === GUARD_NAME).length;
  const before = guards();
  await h.hosting.launch(row);
  await h.hosting.idle();
  assertEquals(guards(), before);
});

test("a relaunch mints a new caller token, and the guard follows it", async () => {
  const h = harness();
  await h.hosting.boot();
  const row = await launched(h);
  const callerOf = () =>
    h.host.launches.filter((l) => l.name !== GUARD_NAME).at(-1)!
      .secretEnv!.MCP_GRAFANA_SERVER_TOKEN;
  const first = callerOf();
  await h.hosting.launch(row);
  await h.hosting.idle();
  assertNotEquals(callerOf(), first);
  assertEquals(
    h.host.guard()!.secretEnv!.RYPH_TOOL_CALLER_TOKENS,
    `${keyOf(await nameOf(h.store, row.id))}=${callerOf()}`,
  );
});

test("supervisor: three failed probes make a healthy server unreachable", async () => {
  const h = harness();
  await h.hosting.boot();
  await launched(h);
  h.answers.set("grafana", false);
  await h.hosting.supervise();
  await h.hosting.supervise();
  assertEquals((await h.store.getServer("ms-g1"))?.host?.status, "healthy");
  await h.hosting.supervise();
  const row = (await h.store.getServer("ms-g1"))!;
  assertEquals(row.host?.status, "unreachable");
  assertEquals(row.host?.lastError, "connection refused");
});

test("supervisor: a recovered probe resets the count", async () => {
  const h = harness();
  await h.hosting.boot();
  await launched(h);
  h.answers.set("grafana", false);
  await h.hosting.supervise();
  await h.hosting.supervise();
  h.answers.set("grafana", true);
  await h.hosting.supervise();
  h.answers.set("grafana", false);
  await h.hosting.supervise();
  await h.hosting.supervise();
  assertEquals((await h.store.getServer("ms-g1"))?.host?.status, "healthy");
});

test("supervisor: an unreachable server is relaunched on a doubling backoff, capped", async () => {
  const h = harness({ limits: { startupTimeoutMs: 0 } });
  await h.hosting.boot();
  h.answers.set("grafana", false);
  await launched(h);
  const launches = () => h.host.launches.filter((l) => l.name !== GUARD_NAME).length;
  assertEquals(launches(), 1);

  // 30 s, then 60, 120, 240, 480, then 600 (the cap) every time after.
  const waits = [30, 60, 120, 240, 480, 600, 600];
  for (const [i, seconds] of waits.entries()) {
    h.clock.now += seconds * 1000 - 1;
    await h.hosting.supervise();
    await h.hosting.idle();
    assertEquals(launches(), i + 1, `not before ${seconds} s`);
    h.clock.now += 1;
    await h.hosting.supervise();
    await h.hosting.idle();
    assertEquals(launches(), i + 2, `after ${seconds} s`);
  }
});

test("a Restart clears the backoff and relaunches at once", async () => {
  const h = harness({ limits: { startupTimeoutMs: 0 } });
  await h.hosting.boot();
  h.answers.set("grafana", false);
  const row = await launched(h);
  h.answers.set("grafana", true);
  await h.hosting.launch(row);
  await h.hosting.idle();
  assertEquals((await h.store.getServer(row.id))?.host?.status, "healthy");
});

test("no network means no hosting, and the reason says what failed", async () => {
  const h = harness();
  h.host.failNetwork("Cannot connect to the Docker daemon");
  await h.hosting.boot();
  const availability = h.hosting.availability();
  assert(!availability.available);
  assert(availability.reason.includes("tools network"));
  assert(availability.reason.includes("Cannot connect to the Docker daemon"));
  assertEquals(h.hosting.guard(), null);
});

test("a guard that will not start means no hosting, and names the image task", async () => {
  const h = harness();
  h.host.failLaunch(/^ryph-tool-guard$/, "No such image: ryph-tool-guard:test");
  await h.hosting.boot();
  const availability = h.hosting.availability();
  assert(!availability.available);
  assert(availability.reason.includes("No such image"));
  assert(availability.reason.includes("bun run agent-image"));
});

test("a row whose catalogue entry vanished is unreachable, saying so", async () => {
  const store = memoryGatewayStore();
  const h = harness({ store });
  const orphan = makeHosting({
    store,
    host: h.host,
    catalogue: fixedCatalogue([]),
    probe: () => Promise.resolve({ ok: true }),
    guardImage: "g",
    now: () => new Date(T0),
    diag: { debug() {}, warn() {} },
    sleep: () => Promise.resolve(),
  });
  await orphan.boot();
  await store.createServer(hostedRow());
  await orphan.launch(hostedRow());
  await orphan.idle();
  const row = (await store.getServer("ms-g1"))!;
  assertEquals(row.host?.status, "unreachable");
  assert(row.host?.lastError?.includes('no entry "grafana"'));
});

test("shutdown removes every container and the guard, and leaves the rows for the next boot", async () => {
  const store = memoryGatewayStore();
  const h = harness({ store });
  await h.hosting.boot();
  await launched(h, customRow("ms-a", "tools-a"));
  await launched(h, hostedRow({ id: "ms-c", slug: "grafana" }));
  assertEquals((await h.hosting.live()).map((s) => s.id).sort(), ["ms-a", "ms-c"]);
  const names = [await nameOf(store, "ms-a"), await nameOf(store, "ms-c")];

  await h.hosting.shutdown();
  assertEquals(h.host.stops.sort(), [...names, GUARD_NAME].sort());
  assertEquals(h.host.containers.size, 0);
  // The rows still say what should run — shutting down is not the operator stopping a server.
  for (const id of ["ms-a", "ms-c"]) {
    assertEquals((await store.getServer(id))?.host?.status, "healthy", id);
  }
  assert(!h.hosting.availability().available);
  await h.hosting.supervise();
  assertEquals(h.host.containers.size, 0);

  // …and the next process brings both back.
  const next = harness({ store });
  await next.hosting.boot();
  await next.hosting.idle();
  assertEquals(
    next.host.launches.filter((l) => l.name !== GUARD_NAME).map((l) => l.name).sort(),
    names.sort(),
  );
});

test("shutdown supersedes a launch in flight: its container is stopped behind it", async () => {
  const h = harness();
  await h.hosting.boot();
  await h.store.createServer(hostedRow());
  const guardLaunches = h.host.launches.filter((l) => l.name === GUARD_NAME).length;

  // Hold the container's launch open, the way a slow image pull would.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered = false;
  const launch = h.host.launch.bind(h.host);
  h.host.launch = async (spec) => {
    if (spec.name !== GUARD_NAME) {
      entered = true;
      await gate;
    }
    return launch(spec);
  };
  await h.hosting.launch(hostedRow());
  while (!entered) await new Promise((r) => setTimeout(r, 1));
  const done = h.hosting.shutdown();
  release();
  await done;
  await h.hosting.idle();

  const name = await nameOf(h.store, "ms-g1");
  // The launch went through, then the stop queued behind it removed it — nothing left running.
  assert(h.host.stops.includes(name));
  assertEquals(h.host.containers.size, 0);
  // The superseded launch wrote nothing and brought no guard back up.
  assertEquals((await h.store.getServer("ms-g1"))?.host?.status, "starting");
  assertEquals(h.host.launches.filter((l) => l.name === GUARD_NAME).length, guardLaunches);
});

test("a shutdown before the tools network came up stops nothing", async () => {
  const h = harness();
  h.host.failNetwork("Cannot connect to the Docker daemon");
  await h.hosting.boot();
  await h.hosting.shutdown();
  assertEquals(h.host.stops, []);
});

/** Lets everything already queued run, the way the event loop would between two requests. */
const settleEventLoop = () => new Promise((resolve) => setTimeout(resolve, 1));

test("boot waits for the hosting lease: nothing launches, and the reason says why", async () => {
  const slot = leaseSlot();
  const departing = slot.leaseFor("departing");
  await departing.acquire(new AbortController().signal);

  const h = harness({ lease: slot.leaseFor("arriving") });
  const booting = h.hosting.boot();
  await settleEventLoop();
  assert(!h.host.networkEnsured);
  assertEquals(h.host.launches, []);
  const waiting = h.hosting.availability();
  assert(!waiting.available);
  assertStringIncludes(waiting.reason, "hosting lease");

  await departing.release();
  await booting;
  assertEquals(h.hosting.availability(), { available: true });
  assert(h.host.guard() !== undefined);
});

test("a rolling update: the departing gateway sweeps first, and the arriving one launches after", async () => {
  // The rollout in lease.ts, as a test. Without the lease the arriving gateway relaunched Grafana
  // and the guard, and the departing one's shutdown then deleted both by name.
  const store = memoryGatewayStore();
  const host = fakeToolHost({ reachesGuard: true });
  const slot = leaseSlot();
  const departing = harness({ store, host, lease: slot.leaseFor("departing") });
  await departing.hosting.boot();
  const row = await launched(departing);
  assertEquals(row.host?.status, "healthy");

  const events: string[] = [];
  const launch = host.launch.bind(host);
  host.launch = (spec) => {
    events.push(`launch ${spec.name}`);
    return launch(spec);
  };
  const stop = host.stop.bind(host);
  host.stop = (handle) => {
    events.push(`stop ${handle}`);
    return stop(handle);
  };

  // The new pod starts while the old one still serves…
  const arriving = harness({ store, host, lease: slot.leaseFor("arriving") });
  const booting = arriving.hosting.boot();
  await settleEventLoop();
  assertEquals(events, [], "the arriving gateway acts on nothing before it holds the lease");

  // …and then the old one is told to stop.
  await departing.hosting.shutdown();
  await booting;
  await arriving.hosting.idle();

  const lastStop = events.findLastIndex((e) => e.startsWith("stop "));
  const firstLaunch = events.findIndex((e) => e.startsWith("launch "));
  assert(lastStop !== -1 && firstLaunch !== -1, events.join(", "));
  assert(lastStop < firstLaunch, `every stop before every launch: ${events.join(", ")}`);
  // What runs now is the arriving gateway's, and nothing removed it after it launched.
  assert(host.containers.has(await nameOf(store, row.id)));
  assert(host.containers.has(GUARD_NAME));
  assertEquals(host.guard()!.secretEnv!.RYPH_TOOL_GUARD_TOKEN, arriving.hosting.guard()!.token);
  assertEquals((await store.getServer(row.id))?.host?.status, "healthy");
  assertEquals(slot.holder(), "arriving");
});

test("a gateway that loses the lease stops acting, sweeps nothing at shutdown, and asks to restart", async () => {
  const slot = leaseSlot();
  const lease = slot.leaseFor("a");
  let restarts = 0;
  const h = harness({ lease, onLeaseLost: () => restarts++ });
  await h.hosting.boot();
  const row = await launched(h);
  const launches = h.host.launches.length;

  lease.lose();
  await settleEventLoop();
  assertEquals(restarts, 1);
  const lost = h.hosting.availability();
  assert(!lost.available);
  assertStringIncludes(lost.reason, "lost the hosting lease");

  // Nothing it does from here changes what runs: that is the successor's now.
  h.answers.set("grafana", false);
  for (let i = 0; i < 4; i++) await h.hosting.supervise();
  await h.hosting.shutdown();
  assertEquals(h.host.launches.length, launches);
  assertEquals(h.host.stops, []);
  assert(h.host.containers.has(await nameOf(h.store, row.id)));
});

test("a stop refused for want of the lease is finished by the gateway that holds it", async () => {
  const store = memoryGatewayStore();
  const host = fakeToolHost({ reachesGuard: true });
  const slot = leaseSlot();
  const departing = harness({ store, host, lease: slot.leaseFor("departing") });
  await departing.hosting.boot();
  const row = await launched(departing);

  // Archived through the arriving pod's API while it is still waiting for the lease.
  const arriving = harness({ store, host, lease: slot.leaseFor("arriving") });
  const booting = arriving.hosting.boot();
  await settleEventLoop();
  const stopped = await arriving.hosting.stop(row);
  assertEquals(stopped.host?.status, "stopped");
  assertStringIncludes(stopped.host?.lastError ?? "", "does not hold the hosting lease");
  assert(host.containers.has(row.host!.handle!), "the refused stop removed nothing");

  await departing.hosting.shutdown();
  await booting;
  await arriving.hosting.idle();
  // The container is gone, and the holder clears the error that asked for the stop.
  assert(!host.containers.has(row.host!.handle!));
  assertEquals((await store.getServer(row.id))?.host?.lastError, null);
});

// ── egress: a confining tool host's one way out ───────────────────────────────────────────────

const RELAY = "http://ryph-egress-relay-ryph-tools:7460";
const TOOL_KEY = new Uint8Array(32).fill(9);
const minter = {
  mint: (subject: string) => mintToolEgressClaim(TOOL_KEY, { subject, issuedAt: 1_700_000_000 }),
};

test("a vendor's container gets its proxy and a claim of its own; the guard never does", async () => {
  const h = harness({ host: fakeToolHost({ egressProxy: RELAY }), toolEgress: minter });
  await h.hosting.boot();
  await launched(h);
  const vendor = h.host.launches.find((l) => l.name !== GUARD_NAME)!;
  const proxy = new URL(vendor.env.HTTPS_PROXY);
  assertEquals(`${proxy.protocol}//${proxy.host}`, RELAY);
  assertEquals(proxy.username, "tool");
  for (const name of ["https_proxy", "HTTP_PROXY", "http_proxy"]) {
    assertEquals(vendor.env[name], vendor.env.HTTPS_PROXY, name);
  }
  assertEquals(vendor.env.NO_PROXY, "localhost,127.0.0.1,::1");
  assertEquals(vendor.env.NODE_USE_ENV_PROXY, "1");
  // The entry's own settings ride beside it, untouched.
  assertEquals(vendor.env.GRAFANA_URL, "https://grafana.example.com");
  // The proxy's own verifier takes the claim, for this container and no other.
  const claim = await verifyToolToken(decodeURIComponent(proxy.password), TOOL_KEY);
  assertEquals(claim?.subject, vendor.name);
  // And a run's verifier does not.
  assertEquals(await verifyToken(decodeURIComponent(proxy.password), TOOL_KEY, 0), null);
  const guard = h.host.guard()!;
  for (const name of TOOL_PROXY_ENV_NAMES) {
    assertEquals(guard.env[name], undefined, name);
    assertEquals(guard.secretEnv?.[name], undefined, name);
  }
});

test("a tool host that hands out a proxy with no minter here is no hosting, saying why", async () => {
  const h = harness({ host: fakeToolHost({ egressProxy: RELAY }) });
  await h.hosting.boot();
  const availability = h.hosting.availability();
  assert(!availability.available);
  assertStringIncludes(availability.reason, "RYPH_EGRESS_TOOL_KEY");
  assertEquals(h.host.launches, []);
});

test("no guard image anywhere is no hosting; the backend's own wins over the gateway's", async () => {
  const none = harness({ guardImage: null });
  await none.hosting.boot();
  assert(!none.hosting.availability().available);
  const backend = harness({ host: fakeToolHost({ guardImage: "launcher/guard:1" }) });
  await backend.hosting.boot();
  assertEquals(backend.host.guard()!.image, "launcher/guard:1");
});

test("with egress wired, boot relaunches even a container it could have kept", async () => {
  const store = memoryGatewayStore();
  const first = harness({
    store,
    catalogue: plainCatalogue,
    host: fakeToolHost({ egressProxy: RELAY }),
    toolEgress: minter,
  });
  await first.hosting.boot();
  await launched(first, plainRow("ms-a", "tools-a"));
  const second = harness({
    store,
    catalogue: plainCatalogue,
    host: fakeToolHost({ egressProxy: RELAY }),
    toolEgress: minter,
  });
  for (const [name, c] of first.host.containers) second.host.containers.set(name, c);
  await second.hosting.boot();
  await second.hosting.idle();
  // Its claim may be under a key that died with the last process (the binary mints one per boot).
  assertEquals(
    second.host.launches.filter((l) => l.name !== GUARD_NAME).map((l) => l.name),
    [await nameOf(store, "ms-a")],
  );
});

test("supervisor: a credential that will not open is the row's problem, never a relaunch", async () => {
  const h = harness();
  await h.hosting.boot();
  await launched(h);
  const launches = h.host.launches.length;
  const detail = "the stored credential cannot be used — enter it again";
  h.verdicts.set("grafana", { ok: false, reason: "secret_required", detail });
  for (let i = 0; i < 6; i++) {
    h.clock.now += 60 * 60_000;
    await h.hosting.supervise();
    await h.hosting.idle();
  }
  const row = (await h.store.getServer("ms-g1"))!;
  assertEquals(row.host?.status, "healthy");
  assertEquals(row.host?.lastError, detail);
  assertEquals(h.host.launches.length, launches, "nothing was relaunched");
  assertEquals(h.hosting.route("ms-g1")?.ready, true, "the route stays");

  // Entered again, the next look clears what the row said.
  h.verdicts.delete("grafana");
  await h.hosting.supervise();
  assertEquals((await h.store.getServer("ms-g1"))?.host?.lastError, null);
});

test("a fresh launch whose credential upstream refuses is healthy, saying so, not relaunched", async () => {
  const h = harness();
  await h.hosting.boot();
  h.verdicts.set("grafana", {
    ok: false,
    reason: "credential_rejected",
    detail: "upstream answered 401",
  });
  const row = await launched(h);
  assertEquals(row.host?.status, "healthy");
  assertEquals(row.host?.lastError, "upstream answered 401");
  const launches = h.host.launches.length;
  h.clock.now += 60 * 60_000;
  await h.hosting.supervise();
  await h.hosting.idle();
  assertEquals(h.host.launches.length, launches);
});

test("stopping a row leaves the route of another row that took its slug since", async () => {
  const h = harness();
  await h.hosting.boot();
  const old = await launched(h, hostedRow({ id: "ms-old" }));
  await h.store.saveServer({ ...old, archivedAt: T0 });
  await launched(h, hostedRow({ id: "ms-new" }));
  await h.hosting.stop({ ...old, archivedAt: T0 });
  const name = await nameOf(h.store, "ms-new");
  assertEquals(h.hosting.route("ms-new"), { key: keyOf(name), ready: true });
  assertEquals(h.host.guard()!.env.RYPH_TOOL_ROUTES, `${keyOf(name)}=${name}:8000/mcp`);
  assert(h.host.containers.has(name));
});

test("a malformed image digest on the row is refused a launch; the latest image is not", async () => {
  const h = harness();
  await h.hosting.boot();
  const forged = `sha256:${"0".repeat(64)}@evil.example/x`;
  const row = await launched(
    h,
    hostedRow({
      host: {
        handle: null,
        status: "starting",
        imageDigest: forged,
        startedAt: null,
        lastError: null,
      },
    }),
  );
  assertEquals(row.host?.status, "unreachable");
  assertStringIncludes(row.host?.lastError ?? "", "image digest is malformed");
  assert(!h.host.launches.some((l) => l.image.includes("evil")), "nothing launched from it");

  await h.hosting.launch(row, { updateImage: true });
  await h.hosting.idle();
  assertEquals((await h.store.getServer(row.id))?.host?.imageDigest, digestOf(grafana.image));
});

test("a row naming another digest than its route runs is dialled nowhere: stale", async () => {
  const h = harness();
  await h.hosting.boot();
  const row = await launched(h);
  const gate = { route: h.hosting.route, guardOrigin: () => h.hosting.guard()?.origin ?? null };
  const now = await hostedDial(gate, row);
  assert(now.ok, JSON.stringify(now));
  assertEquals(now.target, `${h.hosting.guard()!.origin}/${keyOf(row.host!.handle!)}/mcp`);
  const other = { ...row, host: { ...row.host!, imageDigest: `sha256:${"1".repeat(64)}` } };
  const then = await hostedDial(gate, other);
  assertEquals(then.ok ? null : then.refusal.code, "hosted_stale");
});

test("a guard relaunch in flight reads as settling, for every row it fronts", async () => {
  const h = harness();
  await h.hosting.boot();
  await launched(h);
  h.clock.now += 60_000; // long past any launch
  assertEquals(h.hosting.settling("ms-g1"), false);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const launch = h.host.launch.bind(h.host);
  let entered = false;
  h.host.launch = async (spec) => {
    if (spec.name === GUARD_NAME) {
      entered = true;
      await gate;
    }
    return launch(spec);
  };
  h.host.crash(GUARD_NAME);
  const ticking = h.hosting.supervise();
  while (!entered) await settleEventLoop();
  assertEquals(h.hosting.settling("ms-g1"), true);
  release();
  await ticking;
  h.clock.now += 60_000;
  assertEquals(h.hosting.settling("ms-g1"), false);
});

test("supervisor: upstream refusing a row that holds NO credential is the container's problem", async () => {
  const h = harness({ catalogue: plainCatalogue });
  await h.hosting.boot();
  await launched(h, {
    ...plainRow("ms-p", "plain"),
    auth: "none",
    encryptedAuth: null,
    authLast4: null,
  });
  h.verdicts.set("plain", {
    ok: false,
    reason: "credential_rejected",
    detail: "upstream answered 401",
  });
  for (let i = 0; i < 3; i++) await h.hosting.supervise();
  assertEquals((await h.store.getServer("ms-p"))?.host?.status, "unreachable");
});

test("supervisor: a route found stale is relaunched at once, not after three probes and a backoff", async () => {
  const h = harness();
  await h.hosting.boot();
  await launched(h);
  const launches = h.host.launches.length;
  h.verdicts.set("grafana", {
    ok: false,
    reason: "unreachable",
    detail: "launched from other settings",
    code: "hosted_stale",
  });
  await h.hosting.supervise();
  h.verdicts.delete("grafana");
  await h.hosting.idle();
  assert(h.host.launches.length > launches, "relaunched on the first look");
  assertEquals((await h.store.getServer("ms-g1"))?.host?.status, "healthy");
});

// ── the sweep against edits, removed containers and rows that cannot launch ───────────────────

test("a sweep that read the rows before an edit back keeps the row's fresh current container", async () => {
  const h = harness({ reachesGuard: true });
  await h.hosting.boot();
  const rowA = await launched(h);
  const kA = await nameOf(h.store, rowA.id);
  const rowB = { ...rowA, settings: { ...rowA.settings, GRAFANA_URL: "https://b.example.com" } };
  await h.store.saveServer(rowB);
  await h.hosting.launch(rowB);
  await h.hosting.idle();
  // One more orphan, listed first and slow to remove, holds the sweep after it judged kA stale.
  const slow = `ryph-tool-${"0".repeat(32)}`;
  h.host.containers.set(slow, {
    spec: h.host.containers.get(kA)!.spec,
    state: "running",
    address: `${slow}:8000`,
  });
  const list = h.host.list.bind(h.host);
  h.host.list = async () => [slow, ...(await list()).filter((n) => n !== slow)];
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const atSlow = new Promise<void>((r) => (reached = r));
  const stop = h.host.stop.bind(h.host);
  h.host.stop = async (name) => {
    if (name === slow) {
      reached();
      await gate;
    }
    return stop(name);
  };
  const tick = h.hosting.supervise();
  await atSlow; // listed, rows read (the row is B), kA judged stale
  const rowA2 = { ...rowB, settings: rowA.settings }; // an admin edits back to A
  await h.store.saveServer(rowA2);
  await h.hosting.launch(rowA2);
  await settleEventLoop();
  release();
  await tick;
  await h.hosting.idle();
  assert(h.host.containers.has(kA), "the sweep removed the row's current container");
  assertEquals(h.hosting.route(rowA.id), { key: keyOf(kA), ready: true });
  assert(!h.host.containers.has(slow));
});

test("the sweep lists the containers before it reads the rows", async () => {
  // A row names its new key before its container exists, so a container listed and current is
  // never taken for stale: listing after the read could find a launch the read did not see.
  const h = harness({ reachesGuard: true });
  await h.hosting.boot();
  const row = await launched(h);
  const order: string[] = [];
  const list = h.host.list.bind(h.host);
  h.host.list = () => {
    order.push("list");
    return list();
  };
  const rows = h.store.listServers.bind(h.store);
  h.store.listServers = () => {
    order.push("rows");
    return rows();
  };
  // Between a read and a list, a relaunch under a new key lands: rows first would sweep it.
  const edited = { ...row, settings: { ...row.settings, GRAFANA_URL: "https://n.example.com" } };
  let edit: Promise<void> | null = null;
  h.host.list = async () => {
    order.push("list");
    const found = await list();
    edit ??= (async () => {
      await h.store.saveServer(edited);
      await h.hosting.launch(edited);
      await h.hosting.idle();
    })();
    await edit;
    return found;
  };
  await h.hosting.supervise();
  await h.hosting.idle();
  assertEquals(order[0], "list", order.join(" "));
  const now = await nameOf(h.store, row.id);
  assert(h.host.containers.has(now), "the row's new container survived the sweep");
});

test("a container the sweep removes takes its route with it: the next call is coded", async () => {
  const h = harness({ reachesGuard: true });
  await h.hosting.boot();
  const row = await launched(h);
  const before = await nameOf(h.store, row.id);
  // Edited straight in the database: nothing relaunches until the supervisor's probe says so.
  const edited = { ...row, settings: { ...row.settings, GRAFANA_URL: "https://x.example.com" } };
  await h.store.saveServer(edited);
  h.answers.set("grafana", false); // the probe the tick runs is not what this test is about
  await h.hosting.supervise();
  assertEquals(h.host.stops, [before]);
  assertEquals(h.hosting.route(row.id), null);
  assert(!h.host.guard()!.env.RYPH_TOOL_ROUTES.includes(keyOf(before)), "the guard dropped it");
  const gate = {
    route: h.hosting.route,
    outlook: h.hosting.outlook,
    guardOrigin: () => h.hosting.guard()?.origin ?? null,
  };
  const dial = await hostedDial(gate, (await h.store.getServer(row.id))!);
  assertEquals(dial.ok ? null : dial.refusal.code, "hosted_starting");
});

test("a row archived in the database loses its route at the next sweep", async () => {
  const h = harness({ reachesGuard: true });
  await h.hosting.boot();
  const row = await launched(h);
  await h.store.saveServer({ ...row, archivedAt: T0 });
  await h.hosting.supervise();
  assertEquals(h.hosting.route(row.id), null);
  assertEquals(h.host.guard()!.env.RYPH_TOOL_ROUTES, "");
});

test("a relaunch under the routed name is not ready until the guard routes the new container", async () => {
  const h = harness({ reachesGuard: true });
  await h.hosting.boot();
  const row = await launched(h);
  const name = await nameOf(h.store, row.id);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const launch = h.host.launch.bind(h.host);
  let seen: ReturnType<typeof h.hosting.route> = null;
  h.host.launch = async (spec) => {
    if (spec.name === name) {
      seen = h.hosting.route(row.id);
      await gate;
    }
    return launch(spec);
  };
  await h.hosting.launch(row);
  await settleEventLoop();
  release();
  await h.hosting.idle();
  assertEquals(seen, { key: keyOf(name), ready: false });
  assertEquals(h.hosting.route(row.id), { key: keyOf(name), ready: true });
});

test("a failed relaunch under the routed name drops the route it took down", async () => {
  const h = harness({ reachesGuard: true });
  await h.hosting.boot();
  const row = await launched(h);
  const name = await nameOf(h.store, row.id);
  h.host.containers.delete(name); // the backend removed it before the run that failed
  h.host.failLaunch(VENDOR, "image pull failed");
  await h.hosting.launch(row);
  await h.hosting.idle();
  assertEquals(h.hosting.route(row.id), null);
  assert(!h.host.guard()!.env.RYPH_TOOL_ROUTES.includes(keyOf(name)));
  assertEquals((await h.store.getServer(row.id))?.host?.status, "unreachable");
});

test("a row whose catalogue entry is gone keeps no container, and answers not running", async () => {
  const entries = new Map([["grafana", grafana as HostedCatalogueEntry | null]]);
  const shrinking: Catalogue = {
    list: () => Promise.resolve([]),
    get: (id) => Promise.resolve(structuredClone(entries.get(id) ?? null)),
  };
  const h = harness({ reachesGuard: true, catalogue: shrinking });
  await h.hosting.boot();
  const row = await launched(h);
  const name = await nameOf(h.store, row.id);
  entries.delete("grafana");
  await h.hosting.launch(row);
  await h.hosting.idle();
  assertEquals(h.hosting.outlook(row).coming, false);
  await h.hosting.supervise();
  assert(!h.host.containers.has(name), "a blocked row's old container is swept");
  assertEquals(h.hosting.route(row.id), null);
});

test("a row blocked by a malformed digest answers not running, not stale", async () => {
  const h = harness({ reachesGuard: true });
  await h.hosting.boot();
  const row = await launched(h);
  const forged = { ...row, host: { ...row.host!, imageDigest: "sha256:nope" } };
  await h.store.saveServer(forged);
  await h.hosting.launch(forged);
  await h.hosting.idle();
  const gate = {
    route: h.hosting.route,
    outlook: h.hosting.outlook,
    guardOrigin: () => h.hosting.guard()?.origin ?? null,
  };
  // The old launch is still routed until the sweep; the dial already says nothing is coming.
  assert(h.hosting.route(row.id) !== null);
  const dial = await hostedDial(gate, (await h.store.getServer(row.id))!);
  assertEquals(dial.ok ? null : [dial.refusal.status, dial.refusal.code], [
    502,
    "hosted_not_running",
  ]);
});

test("logs read the row's derived container, never its stored handle", async () => {
  const h = harness({ reachesGuard: true });
  await h.hosting.boot();
  const row = await launched(h);
  const name = await nameOf(h.store, row.id);
  h.host.setLogs(name, "vendor line");
  h.host.setLogs(GUARD_NAME, "guard line");
  const pointed = { ...row, host: { ...row.host!, handle: GUARD_NAME } };
  assertEquals(await h.hosting.logs(pointed, 10), "vendor line");
});

test("the boot's stop retry takes only a vendor name that is no live row's current launch", async () => {
  const store = memoryGatewayStore();
  const first = harness({ store, reachesGuard: true });
  await first.hosting.boot();
  const live = await launched(first, customRow("ms-live", "tools-live"));
  const liveName = await nameOf(store, live.id);
  await first.hosting.shutdown();
  const failed = (id: string, slug: string, handle: string) =>
    store.createServer({
      ...customRow(id, slug),
      host: {
        handle,
        status: "stopped",
        imageDigest: null,
        startedAt: null,
        lastError: "could not stop the container: boom",
      },
    });
  const stray = `ryph-tool-${"a".repeat(32)}`;
  await failed("ms-guard", "tools-guard", GUARD_NAME);
  await failed("ms-steal", "tools-steal", liveName);
  await failed("ms-shape", "tools-shape", "postgres");
  await failed("ms-stray", "tools-stray", stray);
  const h = harness({ store, reachesGuard: true });
  await h.hosting.boot();
  await h.hosting.idle();
  assertEquals(h.host.stops, [stray]);
  assert(h.host.containers.has(GUARD_NAME));
  assert(h.host.containers.has(liveName));
});

test("a custom container's caller-auth env var is part of its launch key", async () => {
  const a = customRow("ms-c", "tools-c");
  const b = { ...a, custom: { ...a.custom!, callerAuth: { env: "OTHER_TOKEN" } } };
  const digest = `sha256:${"e".repeat(64)}`;
  assertNotEquals(await launchKey(a, digest), await launchKey(b, digest));
});

test("a clean exit removes what the backend lists as ours, not only what this process launched", async () => {
  const h = harness({ reachesGuard: true });
  await h.hosting.boot();
  await launched(h);
  const stray = `ryph-tool-${"b".repeat(32)}`;
  h.host.containers.set(stray, {
    spec: h.host.launches[0],
    state: "running",
    address: `${stray}:8000`,
  });
  await h.hosting.shutdown();
  assertEquals([...h.host.containers.keys()], []);
});

test("boot gives hosted rows from before the marker their marker url", async () => {
  const store = memoryGatewayStore();
  await store.createServer(hostedRow({ url: "http://127.0.0.1:41234/grafana/mcp" }));
  const h = harness({ store });
  await h.hosting.boot();
  await h.hosting.idle();
  assertEquals((await store.getServer("ms-g1"))?.url, "hosted://grafana");
});

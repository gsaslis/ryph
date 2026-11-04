// The management surface for hosted servers, over the real hosting service and a fake host:
// the catalogue route and its dark state, create from the catalogue and from a custom image,
// what a PATCH may and may not touch, restart, logs, archive, and "update available".

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { directoryCatalogue } from "../src/adapters/catalogue/directory.ts";
import { digestOf, type HostedCatalogueEntry } from "../src/core/catalogue.ts";
import {
  currentContainer,
  GUARD_NAME,
  type HostingLimits,
  type HostingService,
  makeHosting,
  unavailableHosting,
} from "../src/core/hosting.ts";
import { HOSTING_UNAVAILABLE, LOGS_MAX_TAIL } from "../src/http/routes.ts";
import { ADMIN, makeApi, PLAIN } from "./api.ts";
import { fakeToolHost } from "./fake_tool_host.ts";
import { memoryGatewayStore } from "./memory_store.ts";
import { call, server, T0 } from "./fixtures.ts";

const catalogue = await directoryCatalogue();
const TOKEN = "glsa_serviceaccounttoken9876";
const DIGEST = `sha256:${"c".repeat(64)}`;

const GRAFANA = {
  kind: "hosted",
  catalogueId: "grafana",
  name: "Grafana",
  settings: { GRAFANA_URL: "https://grafana.example.com" },
  credential: { "X-Grafana-Service-Account-Token": TOKEN },
};

async function hostedApi(limits: Partial<HostingLimits> = {}) {
  const store = memoryGatewayStore();
  const host = fakeToolHost();
  const hosting = makeHosting({
    store,
    host,
    catalogue,
    probe: () => Promise.resolve({ ok: true }),
    guardImage: "ryph-tool-guard:test",
    now: () => new Date(T0),
    diag: { debug() {}, warn() {} },
    sleep: () => Promise.resolve(),
    limits,
  });
  await hosting.boot();
  const api = makeApi({ store, catalogue, hosting });
  const servers = () => host.launches.filter((l) => l.name !== GUARD_NAME);
  return { ...api, host, hosting, servers };
}

test("the catalogue lists what can be hosted, and says hosting is available", async () => {
  const { handler } = await hostedApi();
  const res = await call(handler, "GET", "/v1/mcp-catalogue");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.hostingAvailable, true);
  assertEquals("reason" in body, false);
  const grafana = body.entries.find((e: { id: string }) => e.id === "grafana");
  assertEquals(grafana.settings.map((s: { key: string }) => s.key), ["GRAFANA_URL", "readOnly"]);
  assertEquals(grafana.secrets, [{
    header: "X-Grafana-Service-Account-Token",
    label: "Service account token",
    placeholder: "glsa_…",
    description: "Sealed here; the Grafana container never holds it.",
    prefix: null,
  }]);
  assertEquals(grafana.kind, "hosted");
  assertEquals(grafana.host, null);
  assertEquals(grafana.settings[1].default, true);
  // The image is shown — it is what will run — but not the launch internals.
  assert(grafana.image.includes("@sha256:"));
  assertEquals("command" in grafana, false);
});

test("without a container backend the catalogue still lists, and says why not", async () => {
  const { handler } = makeApi({ catalogue });
  const body = await (await call(handler, "GET", "/v1/mcp-catalogue")).json();
  assertEquals(body.hostingAvailable, false);
  assertEquals(body.reason, "no container backend in this test");
  assert(body.entries.length >= 1);

  const refused = await call(handler, "POST", "/v1/mcp-servers", GRAFANA);
  assertEquals(refused.status, 503);
  const error = await refused.json();
  assertEquals(error.code, HOSTING_UNAVAILABLE);
  assertEquals(error.error, "no container backend in this test");
});

test("create from the catalogue: 201 starting, sealed headers, then healthy", async () => {
  const { handler, sealed, store, hosting, servers } = await hostedApi();
  const res = await call(handler, "POST", "/v1/mcp-servers", GRAFANA);
  assertEquals(res.status, 201);
  const created = await res.json();
  assertEquals(created.kind, "hosted");
  assertEquals(created.slug, "grafana");
  assertEquals(created.catalogueId, "grafana");
  assertEquals(created.settings, { GRAFANA_URL: "https://grafana.example.com", readOnly: true });
  assertEquals(created.host.status, "starting");
  assertEquals(created.auth, "headers");
  assertEquals(created.authLast4, "9876");
  assert(!JSON.stringify(created).includes(TOKEN), "the token never rides a response");
  // A marker nobody dials: the data plane dials the row's launch key on the guard.
  assertEquals(created.url, "hosted://grafana");
  // Sealed once: the whole outbound map, the URL header derived from the setting.
  assertEquals(sealed, [
    JSON.stringify({
      "X-Grafana-URL": "https://grafana.example.com",
      "X-Grafana-Service-Account-Token": TOKEN,
    }),
  ]);

  await hosting.idle();
  const row = (await store.getServer(created.id))!;
  assertEquals(row.host?.status, "healthy");
  assertEquals(servers().length, 1);
  assert(!JSON.stringify(servers()[0]).includes(TOKEN));
});

test("the slug derives from the entry and steps aside for a live one", async () => {
  const { handler } = await hostedApi();
  const first = await (await call(handler, "POST", "/v1/mcp-servers", GRAFANA)).json();
  const second = await (await call(handler, "POST", "/v1/mcp-servers", GRAFANA)).json();
  assertEquals([first.slug, second.slug], ["grafana", "grafana-2"]);
  const named = await call(handler, "POST", "/v1/mcp-servers", { ...GRAFANA, slug: "ops-grafana" });
  assertEquals((await named.json()).slug, "ops-grafana");
  const taken = await call(handler, "POST", "/v1/mcp-servers", { ...GRAFANA, slug: "grafana" });
  assertEquals(taken.status, 409);
  await taken.body?.cancel();
});

test("create refuses what the entry does not allow", async () => {
  const { handler, servers } = await hostedApi();
  for (
    const [body, fragment] of [
      [{ ...GRAFANA, catalogueId: "nope" }, 'no entry "nope"'],
      [{ ...GRAFANA, credential: {} }, "Service account token is required"],
      [{ ...GRAFANA, settings: {} }, "Grafana URL is required"],
      [{ ...GRAFANA, settings: { GRAFANA_URL: "grafana.local" } }, "absolute URL"],
      // The one operator-typed URL a hosted row carries meets the SSRF rule like any other.
      [
        { ...GRAFANA, settings: { GRAFANA_URL: "https://169.254.169.254/latest/meta-data/" } },
        "private or local address",
      ],
      [{ ...GRAFANA, settings: { GRAFANA_URL: "https://localhost:3000" } }, "loopback"],
      [{ ...GRAFANA, settings: { GRAFANA_URL: "http://grafana.example.com" } }, "plain http"],
      [{ ...GRAFANA, settings: { ...GRAFANA.settings, SHELL: "x" } }, "no such setting"],
      [{ ...GRAFANA, url: "https://evil.example/mcp" }, "url"],
      [{ ...GRAFANA, kind: "sidecar" }, "kind"],
    ] as const
  ) {
    const res = await call(handler, "POST", "/v1/mcp-servers", body);
    assertEquals(res.status, 400, JSON.stringify(body));
    assertStringIncludes((await res.json()).error, fragment);
  }
  assertEquals(servers().length, 0, "nothing launched for a refused body");
});

test("a custom container is admin-only, digest-pinned, HTTP only, and names a caller token", async () => {
  const { handler, hosting, store, servers } = await hostedApi();
  const custom = {
    kind: "hosted",
    slug: "internal",
    name: "Internal tools",
    custom: {
      image: `registry.example.com/tools@${DIGEST}`,
      command: ["serve"],
      port: 9000,
      callerAuth: { env: "TOOLS_SERVER_TOKEN" },
    },
    auth: "headers",
    headers: { "X-Api-Key": "internal-key-5678" },
  };
  const asUser = await call(handler, "POST", "/v1/mcp-servers", custom, PLAIN);
  assertEquals(asUser.status, 403);
  await asUser.body?.cancel();

  const res = await call(handler, "POST", "/v1/mcp-servers", custom, ADMIN);
  assertEquals(res.status, 201);
  const created = await res.json();
  assertEquals(created.custom, { ...custom.custom, path: "/mcp" });
  assertEquals(created.catalogueId, null);
  await hosting.idle();
  assertEquals((await store.getServer(created.id))?.host?.status, "healthy");
  assertEquals(servers()[0].image, custom.custom.image);
  assertEquals(servers()[0].command, ["serve"]);
  // Settings-free, but never caller-token-free: the image is handed a fresh bearer at each launch,
  // and the guard is the only caller that can present it.
  assertEquals(servers()[0].env, {});
  assertEquals(Object.keys(servers()[0].secretEnv ?? {}), ["TOOLS_SERVER_TOKEN"]);

  for (
    const [patch, fragment] of [
      [{ image: "registry.example.com/tools:latest" }, "digest-pinned"],
      [{ command: ["-t", "stdio"] }, "stdio"],
      [{ command: ["--transport=stdio"] }, "stdio"],
      [{ command: ["stdio"] }, "stdio"],
      [{ port: 0 }, "port"],
      [{ privileged: true }, "privileged"],
      // An image nobody has to authenticate to is one a neighbour that finds its IP can speak MCP to.
      [{ callerAuth: undefined }, "callerAuth"],
      [{ callerAuth: { env: "lower case" } }, "env var name"],
      // The proxy is the tool host's to set, and a caller token there would steer it.
      [{ callerAuth: { env: "HTTPS_PROXY" } }, "reserved"],
    ] as const
  ) {
    const bad = await call(
      handler,
      "POST",
      "/v1/mcp-servers",
      { ...custom, slug: "other", custom: { ...custom.custom, ...patch } },
      ADMIN,
    );
    assertEquals(bad.status, 400, JSON.stringify(patch));
    assertStringIncludes((await bad.json()).error, fragment);
  }
});

test("PATCH on a hosted row: never a URL; settings relaunch; rotation does not", async () => {
  const { handler, sealed, hosting, servers, store } = await hostedApi();
  const created = await (await call(handler, "POST", "/v1/mcp-servers", GRAFANA)).json();
  await hosting.idle();
  const path = `/v1/mcp-servers/${created.id}`;

  const repoint = await call(handler, "PATCH", path, { url: "https://elsewhere.example/mcp" });
  assertEquals(repoint.status, 400);
  assertStringIncludes((await repoint.json()).error, "minted by the gateway");
  const wrongKind = await call(handler, "PATCH", path, { auth: "bearer", secret: "tok-12345678" });
  assertEquals(wrongKind.status, 400);
  await wrongKind.body?.cancel();

  // A rotation is a row write: a new sealed map, a new trace, and no container touched.
  const rotated = await (await call(handler, "PATCH", path, {
    credential: { "X-Grafana-Service-Account-Token": "glsa_freshtoken0001" },
  })).json();
  assertEquals(rotated.authLast4, "0001");
  assertEquals(rotated.id, created.id);
  assertEquals(servers().length, 1);
  assertStringIncludes(sealed.at(-1)!, "glsa_freshtoken0001");

  // A setting that moves where the token goes takes the token again: the server never seals the
  // old one for a new Grafana.
  const bare = await call(handler, "PATCH", path, {
    settings: { GRAFANA_URL: "https://grafana2.example.com", readOnly: false },
  });
  assertEquals(bare.status, 400);
  assertEquals((await bare.json()).code, "credential_required");
  assertEquals(servers().length, 1, "a refused move launches nothing");

  // With it, the change reseals around the new URL and relaunches.
  const moved = await call(handler, "PATCH", path, {
    settings: { GRAFANA_URL: "https://grafana2.example.com", readOnly: false },
    credential: { "X-Grafana-Service-Account-Token": "glsa_freshtoken0001" },
  });
  assertEquals(moved.status, 200);
  assertEquals((await moved.json()).host.status, "starting");
  await hosting.idle();
  assertEquals(servers().length, 2);
  assertEquals(servers()[1].env.GRAFANA_URL, "https://grafana2.example.com");
  assertEquals(Object.keys(servers()[1].env), ["GRAFANA_URL"]);
  assertEquals(Object.keys(servers()[1].secretEnv ?? {}), ["MCP_GRAFANA_SERVER_TOKEN"]);
  assertEquals(servers()[1].command.includes("--disable-write"), false);
  assertEquals(JSON.parse(sealed.at(-1)!), {
    "X-Grafana-URL": "https://grafana2.example.com",
    "X-Grafana-Service-Account-Token": "glsa_freshtoken0001",
  });
  assertEquals((await store.getServer(created.id))?.authLast4, "0001");

  // …and a settings edit cannot repoint the sealed credential at an internal address: the same
  // rule, on the same path, is what the PATCH meets.
  for (const url of ["https://169.254.169.254/", "https://10.1.2.3/", "http://grafana.local/"]) {
    const refused = await call(handler, "PATCH", path, { settings: { GRAFANA_URL: url } });
    assertEquals(refused.status, 400, url);
    assertStringIncludes((await refused.json()).error, "settings.GRAFANA_URL");
  }
  await hosting.idle();
  assertEquals(servers().length, 2, "a refused settings edit launches nothing");
  assertEquals(
    (await store.getServer(created.id))?.settings?.GRAFANA_URL,
    "https://grafana2.example.com",
  );

  // Renaming touches nothing but the name.
  await (await call(handler, "PATCH", path, { name: "Grafana (ops)" })).body?.cancel();
  await hosting.idle();
  assertEquals(servers().length, 2);

  // A toggle steers nothing: it relaunches and reseals around the same token, unasked.
  const toggled = await call(handler, "PATCH", path, { settings: { readOnly: true } });
  assertEquals(toggled.status, 200);
  await hosting.idle();
  assertEquals(servers().length, 3);
  assertEquals(JSON.parse(sealed.at(-1)!), {
    "X-Grafana-URL": "https://grafana2.example.com",
    "X-Grafana-Service-Account-Token": "glsa_freshtoken0001",
  });
});

test("PATCH on a remote row refuses hosted fields", async () => {
  const { handler } = await hostedApi();
  const remote = await (await call(handler, "POST", "/v1/mcp-servers", {
    slug: "linear",
    name: "Linear",
    url: "https://mcp.linear.example/mcp",
    auth: "bearer",
    secret: "lin_api_verysecret",
  })).json();
  assertEquals(remote.kind, "remote");
  assertEquals(remote.host, null);
  const res = await call(handler, "PATCH", `/v1/mcp-servers/${remote.id}`, { settings: {} });
  assertEquals(res.status, 400);
  await res.body?.cancel();
  const restart = await call(handler, "POST", `/v1/mcp-servers/${remote.id}/restart`);
  assertEquals(restart.status, 400);
  await restart.body?.cancel();
});

test("restart relaunches; updateImage moves to the catalogue's digest", async () => {
  const { handler, hosting, store, servers } = await hostedApi();
  const created = await (await call(handler, "POST", "/v1/mcp-servers", GRAFANA)).json();
  await hosting.idle();
  // Pretend the row was launched from an older pin: the list reports an update.
  const row = (await store.getServer(created.id))!;
  const older = `sha256:${"0".repeat(64)}`;
  await store.saveServer({ ...row, host: { ...row.host!, imageDigest: older } });
  const listed = await (await call(handler, "GET", "/v1/mcp-servers")).json();
  assertEquals(listed.mcpServers[0].host.status, "update-available");

  const restarted = await call(handler, "POST", `/v1/mcp-servers/${created.id}/restart`);
  assertEquals(restarted.status, 200);
  assertEquals((await restarted.json()).host.status, "starting");
  await hosting.idle();
  assertEquals(servers().at(-1)?.image, `grafana/mcp-grafana@${older}`, "restart keeps the pin");

  const updated = await call(handler, "POST", `/v1/mcp-servers/${created.id}/restart`, {
    updateImage: true,
  });
  assertEquals(updated.status, 200);
  await updated.body?.cancel();
  await hosting.idle();
  const grafana = (await catalogue.get("grafana")) as HostedCatalogueEntry;
  assertEquals(servers().at(-1)?.image, `grafana/mcp-grafana@${digestOf(grafana.image)}`);
  const after = await (await call(handler, "GET", `/v1/mcp-servers/${created.id}`)).json();
  assertEquals(after.host.status, "healthy");
});

test("logs are admin-only, capped, and never echo the secret", async () => {
  const { handler, hosting, host, store } = await hostedApi();
  const created = await (await call(handler, "POST", "/v1/mcp-servers", GRAFANA)).json();
  await hosting.idle();
  const name = (await currentContainer((await store.getServer(created.id))!))!;
  const lines = Array.from({ length: 1500 }, (_, i) => `line ${i}`);
  lines.push(`debug: request headers X-Grafana-Service-Account-Token=${TOKEN}`);
  lines.push("connected to https://grafana.example.com");
  host.setLogs(name, lines.join("\n"));
  const path = `/v1/mcp-servers/${created.id}/logs`;

  const asUser = await call(handler, "GET", path, undefined, PLAIN);
  assertEquals(asUser.status, 403);
  await asUser.body?.cancel();

  const res = await call(handler, "GET", `${path}?tail=5000`, undefined, ADMIN);
  assertEquals(res.status, 200);
  const { logs } = await res.json();
  assertEquals(logs.split("\n").length, LOGS_MAX_TAIL);
  assert(!logs.includes(TOKEN), "a logged header is redacted");
  assertStringIncludes(logs, "····9876");
  assertStringIncludes(logs, "https://grafana.example.com", "settings are not secrets");

  const fewer = await (await call(handler, "GET", `${path}?tail=2`, undefined, ADMIN)).json();
  assertEquals(fewer.logs.split("\n").length, 2);
  const bad = await call(handler, "GET", `${path}?tail=-1`, undefined, ADMIN);
  assertEquals(bad.status, 400);
  await bad.body?.cancel();
});

test("a stored credential that cannot be opened is a coded answer, never a 500", async () => {
  const { handler, hosting, store } = await hostedApi();
  const created = await (await call(handler, "POST", "/v1/mcp-servers", GRAFANA)).json();
  await hosting.idle();
  // Unreadable (sealed for another row, say), then missing altogether (a failed migration).
  for (const encryptedAuth of ["sealed:not-json", null]) {
    await store.updateServer(created.id, { encryptedAuth, updatedAt: T0 });
    const logs = await call(handler, "GET", `/v1/mcp-servers/${created.id}/logs`);
    assertEquals(logs.status, 409);
    assertEquals((await logs.json()).code, "secret_required");
    // A toggle re-derives the header map from the stored credential: it asks for it instead.
    const path = `/v1/mcp-servers/${created.id}`;
    const toggled = await call(handler, "PATCH", path, { settings: { readOnly: false } });
    assertEquals(toggled.status, 409);
    assertEquals((await toggled.json()).code, "secret_required");
  }
  // Sent with the toggle, it is sealed again and the row reads whole.
  const fixed = await call(handler, "PATCH", `/v1/mcp-servers/${created.id}`, {
    settings: { readOnly: false },
    credential: { "X-Grafana-Service-Account-Token": "glsa_reentered00001" },
  });
  assertEquals(fixed.status, 200);
  await fixed.body?.cancel();
  await hosting.idle();
});

test("archive stops the container and keeps the row; hosting actions then refuse", async () => {
  const { handler, hosting, host, store } = await hostedApi();
  const created = await (await call(handler, "POST", "/v1/mcp-servers", GRAFANA)).json();
  await hosting.idle();
  const res = await call(handler, "POST", `/internal/v1/mcp-servers/${created.id}/archive`);
  assertEquals(res.status, 200);
  const archived = await res.json();
  assert(archived.archivedAt !== null);
  assertEquals(archived.host.status, "stopped");
  assertEquals(host.stops, [(await currentContainer((await store.getServer(created.id))!))!]);
  assert((await store.getServer(created.id)) !== null, "archived, never deleted");

  const restart = await call(handler, "POST", `/v1/mcp-servers/${created.id}/restart`);
  assertEquals(restart.status, 409);
  await restart.body?.cancel();
  // …and the slug is free again.
  const again = await (await call(handler, "POST", "/v1/mcp-servers", GRAFANA)).json();
  assertEquals(again.slug, "grafana");
});

test("archive stops the container even while hosting reads unavailable", async () => {
  // The window that used to orphan a container for good: hosting is still pulling the guard (or
  // its backend never came up) while a container from a previous process is still running. The
  // row goes archived, and after that nothing enumerates it — boot and the supervisor both walk
  // LIVE rows — so the archive is the last chance to name it.
  const store = memoryGatewayStore();
  const stopped: string[] = [];
  const hosting: HostingService = {
    ...unavailableHosting("the tool guard image is still being pulled"),
    stop: (s) => {
      stopped.push(s.id);
      return Promise.resolve(s);
    },
  };
  await store.createServer(server({
    id: "ms-h",
    slug: "grafana",
    kind: "hosted",
    catalogueId: "grafana",
    url: "http://127.0.0.1:9/grafana/mcp",
    settings: { GRAFANA_URL: "https://grafana.example.com", readOnly: true },
    host: {
      handle: "ryph-tool-grafana-ms-h",
      status: "healthy",
      imageDigest: null,
      startedAt: T0,
      lastError: null,
    },
  }));
  const { handler } = makeApi({ store, catalogue, hosting });

  const res = await call(handler, "POST", "/internal/v1/mcp-servers/ms-h/archive");
  assertEquals(res.status, 200);
  assert((await res.json()).archivedAt !== null);
  assertEquals(stopped, ["ms-h"]);

  // And a deployment that genuinely runs no containers still archives, rather than 500ing on the
  // refusal its hosting service throws.
  const bare = makeApi({
    store: await (async () => {
      const s2 = memoryGatewayStore();
      await s2.createServer(
        server({ id: "ms-i", slug: "g2", kind: "hosted", catalogueId: "grafana" }),
      );
      return s2;
    })(),
    catalogue,
  });
  const second = await call(bare.handler, "POST", "/internal/v1/mcp-servers/ms-i/archive");
  assertEquals(second.status, 200);
  assert((await second.json()).archivedAt !== null);
});

test("a deployment hosts only so many servers, and says so rather than filling the host", async () => {
  // Every hosted row is a memory-capped container on the machine the control plane runs on, and
  // a create is a user action — so the ceiling is a number, not trust.
  const { handler, hosting, servers } = await hostedApi({ maxServers: 2 });
  const first = await (await call(handler, "POST", "/v1/mcp-servers", GRAFANA)).json();
  await (await call(handler, "POST", "/v1/mcp-servers", GRAFANA)).body?.cancel();
  await hosting.idle();

  const full = await call(handler, "POST", "/v1/mcp-servers", GRAFANA);
  assertEquals(full.status, 409);
  assertStringIncludes((await full.json()).error, "at most 2 MCP servers");
  // The custom path is capped by the same count, not by a budget of its own.
  const custom = await call(handler, "POST", "/v1/mcp-servers", {
    kind: "hosted",
    slug: "internal",
    name: "Internal tools",
    custom: {
      image: `registry.example.com/tools@${DIGEST}`,
      port: 9000,
      callerAuth: { env: "TOOLS_SERVER_TOKEN" },
    },
    auth: "none",
  }, ADMIN);
  assertEquals(custom.status, 409);
  await custom.body?.cancel();
  await hosting.idle();
  assertEquals(servers().length, 2, "nothing launched past the cap");

  // A remote server is not a container, so it is not counted and not refused.
  const remote = await call(handler, "POST", "/v1/mcp-servers", {
    slug: "linear",
    name: "Linear",
    url: "https://mcp.linear.example/mcp",
    auth: "none",
  });
  assertEquals(remote.status, 201);
  await remote.body?.cancel();

  // Archiving frees a slot — the container is gone with it.
  await (await call(handler, "POST", `/internal/v1/mcp-servers/${first.id}/archive`, {})).body
    ?.cancel();
  const again = await call(handler, "POST", "/v1/mcp-servers", GRAFANA);
  assertEquals(again.status, 201);
  await again.body?.cancel();
});

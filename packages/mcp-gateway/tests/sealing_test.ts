// Sealed MCP server credentials, over the real crypto: bound to the row and where the credential
// goes, and re-entered on a move.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { eq } from "drizzle-orm";
import { importMasterKey } from "@ryph/sealed";
import { drizzleGatewayStore } from "../src/adapters/store/drizzle.ts";
import * as schema from "../src/adapters/store/db/schema.ts";
import { makeMcpSealer, mcpCredentialBinding } from "../src/core/sealing.ts";
import { makeProbe } from "../src/http/probe.ts";
import type { McpServer } from "../src/core/types.ts";
import { makeApi } from "./api.ts";
import { closedAfterEach } from "@ryph/db/testing";
import { makeTestDb as openTestDb } from "./db.ts";
import { call, openPolicy, server } from "./fixtures.ts";

// Its tests leave their handles open.
const makeTestDb = closedAfterEach(openTestDb);

const MASTER_HEX = "6d".repeat(32);
const sealerOf = async () => makeMcpSealer(await importMasterKey(MASTER_HEX));

const HOSTED: McpServer = server({
  id: "ms-h",
  slug: "grafana",
  kind: "hosted",
  url: "http://guard.tools:8080/grafana/mcp",
  catalogueId: "grafana",
  settings: { GRAFANA_URL: "https://grafana.example.com", readOnly: true },
});

test("a credential opens only for the row and destination it was sealed for", async () => {
  const sealer = await sealerOf();
  const remote = server();
  const sealed = await sealer.seal("headers", mcpCredentialBinding(remote));
  assertEquals(await sealer.open(sealed, mcpCredentialBinding(remote)), "headers");
  for (
    const moved of [
      { ...remote, url: "https://attacker.example/mcp" },
      { ...remote, id: "ms-2" },
      { ...remote, kind: "hosted" as const },
    ]
  ) {
    await assertRejects(() => sealer.open(sealed, mcpCredentialBinding(moved)));
  }

  const hosted = await sealer.seal("token", mcpCredentialBinding(HOSTED));
  // The minted url moves with the guard, and is not part of the binding.
  assertEquals(
    await sealer.open(hosted, mcpCredentialBinding({ ...HOSTED, url: "http://10.0.0.9:8080/x" })),
    "token",
  );
  // The jsonb column hands settings back in its own key order: that is not a change.
  assertEquals(
    await sealer.open(
      hosted,
      mcpCredentialBinding({
        ...HOSTED,
        settings: { readOnly: true, GRAFANA_URL: "https://grafana.example.com" },
      }),
    ),
    "token",
  );
  for (
    const moved of [
      { ...HOSTED, settings: { GRAFANA_URL: "https://attacker.example", readOnly: true } },
      { ...HOSTED, slug: "other" },
      { ...HOSTED, catalogueId: "other" },
      {
        ...HOSTED,
        catalogueId: null,
        custom: {
          image: "evil@sha256:00",
          command: [],
          port: 8000,
          path: "/mcp",
          callerAuth: null,
        },
      },
    ]
  ) {
    await assertRejects(() => sealer.open(hosted, mcpCredentialBinding(moved)));
  }
});

test("repointing a remote server needs the credential again; with it, it is sealed for the new url", async () => {
  const sealer = await sealerOf();
  const store = drizzleGatewayStore(await makeTestDb());
  const { handler } = makeApi({ store, sealer });
  const created = await (await call(handler, "POST", "/v1/mcp-servers", {
    slug: "linear",
    name: "Linear",
    url: "https://mcp.linear.example/mcp",
    auth: "bearer",
    secret: "lin_api_original",
  })).json();
  const row = (await store.getServer(created.id))!;
  assert(row.encryptedAuth!.startsWith("v2."));
  assertEquals(
    JSON.parse(await sealer.open(row.encryptedAuth!, mcpCredentialBinding(row))),
    { Authorization: "Bearer lin_api_original" },
  );

  const path = `/v1/mcp-servers/${created.id}`;
  const bare = await call(handler, "PATCH", path, { url: "https://mcp.other.example/mcp" });
  assertEquals(bare.status, 400);
  assertEquals((await bare.json()).code, "credential_required");
  assertEquals((await store.getServer(created.id))!.encryptedAuth, row.encryptedAuth);

  const moved = await call(handler, "PATCH", path, {
    url: "https://mcp.other.example/mcp",
    auth: "bearer",
    secret: "lin_api_reentered",
  });
  assertEquals(moved.status, 200);
  const after = (await store.getServer(created.id))!;
  assertEquals(after.url, "https://mcp.other.example/mcp");
  assertEquals(
    JSON.parse(await sealer.open(after.encryptedAuth!, mcpCredentialBinding(after))),
    { Authorization: "Bearer lin_api_reentered" },
  );

  // A rotation alone is sealed for the url the row has.
  await call(handler, "PATCH", path, { auth: "bearer", secret: "lin_api_rotated00" });
  const rotated = (await store.getServer(created.id))!;
  assertEquals(
    JSON.parse(await sealer.open(rotated.encryptedAuth!, mcpCredentialBinding(rotated))),
    { Authorization: "Bearer lin_api_rotated00" },
  );
});

test("a rotation racing a move lands nothing: the url never pairs with a credential sealed for another", async () => {
  const sealer = await sealerOf();
  const store = drizzleGatewayStore(await makeTestDb());
  const { handler } = makeApi({ store, sealer });
  const created = await (await call(handler, "POST", "/v1/mcp-servers", {
    slug: "linear",
    name: "Linear",
    url: "https://mcp.linear.example/mcp",
    auth: "bearer",
    secret: "lin_api_original",
  })).json();
  const path = `/v1/mcp-servers/${created.id}`;

  // The interleaving, made deterministic: the rotation has read the row and sealed for its url;
  // the move runs to completion before the rotation's write goes in. This pins the routes'
  // compare-and-set, not the row lock under it: PGlite runs every query on one session, so this
  // passes with the lock deleted. tests/locks_postgres_test.ts holds the lock on a real Postgres.
  const realUpdateIf = store.updateServerIf.bind(store);
  let moved: Response | null = null;
  let held = false;
  store.updateServerIf = async (id, edit, holds) => {
    if (!held) {
      held = true;
      moved = await call(handler, "PATCH", path, {
        url: "https://mcp.other.example/mcp",
        auth: "bearer",
        secret: "lin_api_moved0000",
      });
    }
    return await realUpdateIf(id, edit, holds);
  };
  const rotation = await call(handler, "PATCH", path, {
    auth: "bearer",
    secret: "lin_api_rotated00",
  });
  assertEquals(moved!.status, 200);
  assertEquals(rotation.status, 409);
  assertEquals((await rotation.json()).code, "server_changed");

  const after = (await store.getServer(created.id))!;
  assertEquals(after.url, "https://mcp.other.example/mcp");
  assertEquals(
    JSON.parse(await sealer.open(after.encryptedAuth!, mcpCredentialBinding(after))),
    { Authorization: "Bearer lin_api_moved0000" },
  );

  // Sent again against the row as it stands, it lands, sealed for the new url.
  store.updateServerIf = realUpdateIf;
  const again = await call(handler, "PATCH", path, { auth: "bearer", secret: "lin_api_rotated00" });
  assertEquals(again.status, 200);
  const rotated = (await store.getServer(created.id))!;
  assertEquals(
    JSON.parse(await sealer.open(rotated.encryptedAuth!, mcpCredentialBinding(rotated))),
    { Authorization: "Bearer lin_api_rotated00" },
  );
});

test("a stored credential naming a header that steers the request is refused at the API", async () => {
  const { handler } = makeApi({ sealer: await sealerOf() });
  for (
    const name of [
      "Host",
      "X-Forwarded-Host",
      "x-ryph-tool-token",
      " Host",
      "TE",
      "Proxy-Authorization",
    ]
  ) {
    const res = await call(handler, "POST", "/v1/mcp-servers", {
      slug: "custom",
      name: "Custom",
      url: "https://mcp.example.com/mcp",
      auth: "headers",
      headers: { [name]: "evil.example.com" },
    });
    assertEquals(res.status, 400, name);
  }
});

test("a url rewritten in the database underneath is never dialled with the credential", async () => {
  const sealer = await sealerOf();
  const handle = await makeTestDb();
  const store = drizzleGatewayStore(handle);
  const { handler } = makeApi({ store, sealer });
  const created = await (await call(handler, "POST", "/v1/mcp-servers", {
    slug: "linear",
    name: "Linear",
    url: "https://mcp.linear.example/mcp",
    auth: "bearer",
    secret: "lin_api_original",
  })).json();
  await handle.db.update(schema.mcpServers)
    .set({ url: "https://attacker.example/mcp" })
    .where(eq(schema.mcpServers.id, created.id));

  const dialled: string[] = [];
  const probe = makeProbe({
    decrypt: sealer.open,
    upstream: openPolicy,
    upstreamFetch: ((input: string | URL | Request) => {
      dialled.push(String(input));
      return Promise.reject(new Error("must not dial"));
    }) as typeof fetch,
  });
  const result = await probe((await store.getServer(created.id))!);
  assertEquals(result.ok, false);
  assertEquals(result.ok === false && result.reason, "secret_required");
  assertEquals(dialled, []);
});

test("no settings and empty settings bind alike, as an edit between them relaunches nothing", async () => {
  const sealer = await sealerOf();
  const custom = { ...HOSTED, catalogueId: null, settings: null };
  const sealed = await sealer.seal("token", mcpCredentialBinding(custom));
  assertEquals(
    await sealer.open(sealed, mcpCredentialBinding({ ...custom, settings: {} })),
    "token",
  );
});

test("a url-only move racing a credential being added lands nothing: no credential sealed for the old url rides the new one", async () => {
  const sealer = await sealerOf();
  const store = drizzleGatewayStore(await makeTestDb());
  const { handler } = makeApi({ store, sealer });
  const created = await (await call(handler, "POST", "/v1/mcp-servers", {
    slug: "linear",
    name: "Linear",
    url: "https://mcp.linear.example/mcp",
    auth: "none",
  })).json();
  const path = `/v1/mcp-servers/${created.id}`;

  // The move has read the row — no credential, so none is asked for — and the credential is added
  // (sealed for the old url) before the move's write goes in.
  const realUpdateIf = store.updateServerIf.bind(store);
  let added: Response | null = null;
  let held = false;
  store.updateServerIf = async (id, edit, holds) => {
    if (!held) {
      held = true;
      added = await call(handler, "PATCH", path, { auth: "bearer", secret: "lin_api_original" });
    }
    return await realUpdateIf(id, edit, holds);
  };
  const move = await call(handler, "PATCH", path, { url: "https://mcp.other.example/mcp" });
  assertEquals(added!.status, 200);
  assertEquals(move.status, 409);
  assertEquals((await move.json()).code, "server_changed");

  const after = (await store.getServer(created.id))!;
  assertEquals(after.url, "https://mcp.linear.example/mcp");
  assertEquals(
    JSON.parse(await sealer.open(after.encryptedAuth!, mcpCredentialBinding(after))),
    { Authorization: "Bearer lin_api_original" },
  );

  // Sent again, the move now meets the credential and asks for it.
  store.updateServerIf = realUpdateIf;
  const again = await call(handler, "PATCH", path, { url: "https://mcp.other.example/mcp" });
  assertEquals(again.status, 400);
  assertEquals((await again.json()).code, "credential_required");
});

test("a credential being added racing a url-only move lands nothing either way round", async () => {
  const sealer = await sealerOf();
  const store = drizzleGatewayStore(await makeTestDb());
  const { handler } = makeApi({ store, sealer });
  const created = await (await call(handler, "POST", "/v1/mcp-servers", {
    slug: "linear",
    name: "Linear",
    url: "https://mcp.linear.example/mcp",
    auth: "none",
  })).json();
  const path = `/v1/mcp-servers/${created.id}`;
  const realUpdateIf = store.updateServerIf.bind(store);
  let moved: Response | null = null;
  let held = false;
  store.updateServerIf = async (id, edit, holds) => {
    if (!held) {
      held = true;
      moved = await call(handler, "PATCH", path, { url: "https://mcp.other.example/mcp" });
    }
    return await realUpdateIf(id, edit, holds);
  };
  const adding = await call(handler, "PATCH", path, { auth: "bearer", secret: "lin_api_original" });
  assertEquals(moved!.status, 200);
  assertEquals(adding.status, 409);
  const after = (await store.getServer(created.id))!;
  assertEquals(after.url, "https://mcp.other.example/mcp");
  assertEquals(after.encryptedAuth, null);
});

// The management surface: write-only credentials, the URL guard at the door, slug uniqueness
// among live rows, rotation under a stable id, idempotent archiving, the probe, the usage
// trail, and the host's gate honored on every route.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  CREDENTIAL_REQUIRED,
  disabledMcpServerRoutes,
  MCP_DISABLED,
  SERVER_ARCHIVED,
} from "../src/http/routes.ts";
import { FORBIDDEN } from "@ryph/auth";
import { MAX_USAGE_PAGE } from "../src/ports/gateway_store.ts";
import { call, router, T0 } from "./fixtures.ts";
import { makeApi, PLAIN } from "./api.ts";

const CREATE = {
  slug: "linear",
  name: "Linear",
  url: "https://mcp.linear.example/mcp",
  auth: "bearer",
  secret: "lin_api_verysecret",
};

test("create seals the credential and answers only its trace; list and get never leak it", async () => {
  const { handler, store, sealed } = makeApi();
  const created = await call(handler, "POST", "/v1/mcp-servers", CREATE);
  assertEquals(created.status, 201);
  const srv = await created.json();
  assertEquals(srv.slug, "linear");
  assertEquals(srv.auth, "bearer");
  assertEquals(srv.authLast4, "cret");
  assertEquals(srv.transport, "http");
  assert(!("encryptedAuth" in srv), "the sealed credential never rides a response");
  assert(!JSON.stringify(srv).includes("verysecret"));
  // Sealed exactly once, as the header map upstream will receive.
  assertEquals(sealed, ['{"Authorization":"Bearer lin_api_verysecret"}']);

  const row = await store.getServer(srv.id);
  assertEquals(row?.encryptedAuth, 'sealed:{"Authorization":"Bearer lin_api_verysecret"}');

  const listed = await (await call(handler, "GET", "/v1/mcp-servers")).json();
  assertEquals(listed.mcpServers.length, 1);
  assert(!JSON.stringify(listed).includes("verysecret"));
  const got = await (await call(handler, "GET", `/v1/mcp-servers/${srv.id}`)).json();
  assertEquals(got.id, srv.id);
  assert(!("encryptedAuth" in got));
  assertEquals((await call(handler, "GET", "/v1/mcp-servers/ms-nope")).status, 404);
});

test("a headers credential seals the map and traces the first value; none seals nothing", async () => {
  const { handler, sealed } = makeApi();
  const headered = await (await call(handler, "POST", "/v1/mcp-servers", {
    slug: "sentry",
    name: "Sentry",
    url: "https://mcp.sentry.example/mcp",
    auth: "headers",
    headers: { "X-Api-Key": "key-abcd", "X-Org": "acme" },
  })).json();
  assertEquals(headered.auth, "headers");
  assertEquals(headered.authLast4, "abcd");
  assertEquals(sealed, ['{"X-Api-Key":"key-abcd","X-Org":"acme"}']);

  const open = await (await call(handler, "POST", "/v1/mcp-servers", {
    slug: "docs",
    name: "Public docs",
    url: "https://mcp.docs.example/mcp",
    auth: "none",
  })).json();
  assertEquals([open.auth, open.authLast4], ["none", null]);
  assertEquals(sealed.length, 1, "nothing sealed for a public server");
});

test("the URL is checked at the door: private, plain http, and unresolvable are 400s", async () => {
  const { handler } = makeApi();
  for (
    const url of [
      "https://10.0.0.1/mcp",
      "http://mcp.linear.example/mcp",
      "https://nowhere.invalid/mcp",
      "https://169.254.169.254/latest/meta-data",
    ]
  ) {
    const res = await call(handler, "POST", "/v1/mcp-servers", { ...CREATE, url });
    assertEquals(res.status, 400, url);
    assert((await res.json()).error.startsWith("url:"));
  }
});

test("a slug is unique among live servers; archiving frees it", async () => {
  const { handler } = makeApi();
  const first = await (await call(handler, "POST", "/v1/mcp-servers", CREATE)).json();
  const dup = await call(handler, "POST", "/v1/mcp-servers", { ...CREATE, name: "Again" });
  assertEquals(dup.status, 409);
  await dup.body?.cancel();

  await call(handler, "POST", `/internal/v1/mcp-servers/${first.id}/archive`);
  const reused = await call(handler, "POST", "/v1/mcp-servers", { ...CREATE, name: "Again" });
  assertEquals(reused.status, 201);
  assert((await reused.json()).id !== first.id);
});

test("update: rename, repoint, rotate under the same id, switch auth kinds; empty is a 400", async () => {
  const { handler, sealed } = makeApi();
  const srv = await (await call(handler, "POST", "/v1/mcp-servers", CREATE)).json();

  const rotated = await call(handler, "PATCH", `/v1/mcp-servers/${srv.id}`, {
    auth: "bearer",
    secret: "lin_api_freshkey9",
  });
  assertEquals(rotated.status, 200);
  const rotatedSrv = await rotated.json();
  assertEquals(rotatedSrv.id, srv.id, "rotation must not move the id anything references");
  assertEquals(rotatedSrv.authLast4, "key9");
  assertEquals(rotatedSrv.name, "Linear");
  assertEquals(sealed.at(-1), '{"Authorization":"Bearer lin_api_freshkey9"}');

  // Repointing is its own rule (it needs the credential again); renaming touches neither.
  const renamed = await (await call(handler, "PATCH", `/v1/mcp-servers/${srv.id}`, {
    name: "Linear (org)",
    description: "issues and projects",
  })).json();
  assertEquals(renamed.authLast4, "key9"); // untouched
  assertEquals(renamed.name, "Linear (org)");
  assertEquals(renamed.description, "issues and projects");
  assertEquals(renamed.url, CREATE.url); // untouched

  const opened = await (await call(handler, "PATCH", `/v1/mcp-servers/${srv.id}`, {
    auth: "none",
  })).json();
  assertEquals([opened.auth, opened.authLast4], ["none", null]);

  for (
    const body of [
      {},
      { auth: "bearer" }, // kind without a credential
      { secret: "lin_api_orphaned" }, // credential without a kind
      { auth: "none", secret: "lin_api_orphaned" }, // a secret the kind would silently drop
      { auth: "bearer", secret: "lin_api_freshkey9", headers: { "X-Api-Key": "k" } },
      { auth: "headers", headers: { "X-Api-Key": "k" }, secret: "lin_api_freshkey9" },
      { headers: { "X-Api-Key": "k" } },
      { url: "https://10.0.0.1/mcp" }, // the guard applies to updates too
    ]
  ) {
    const res = await call(handler, "PATCH", `/v1/mcp-servers/${srv.id}`, body);
    assertEquals(res.status, 400, JSON.stringify(body));
    await res.body?.cancel();
  }
  assertEquals(
    (await call(handler, "PATCH", "/v1/mcp-servers/ms-nope", { name: "x" })).status,
    404,
  );
});

test("archive is idempotent and keeps the row resolvable", async () => {
  const { handler, store } = makeApi();
  const srv = await (await call(handler, "POST", "/v1/mcp-servers", CREATE)).json();
  const archived = await call(handler, "POST", `/internal/v1/mcp-servers/${srv.id}/archive`);
  assertEquals(archived.status, 200);
  assert((await archived.json()).archivedAt !== null);
  const again = await call(handler, "POST", `/internal/v1/mcp-servers/${srv.id}/archive`);
  assertEquals(again.status, 200);
  await again.body?.cancel();
  assert((await store.getServer(srv.id)) !== null, "archived, never deleted");
});

test("archive wipes the sealed credential, and a credential sent after it is refused", async () => {
  const { handler, store } = makeApi();
  const srv = await (await call(handler, "POST", "/v1/mcp-servers", CREATE)).json();
  assert((await store.getServer(srv.id))?.encryptedAuth !== null);
  await (await call(handler, "POST", `/internal/v1/mcp-servers/${srv.id}/archive`)).body?.cancel();
  const row = await store.getServer(srv.id);
  assertEquals([row?.encryptedAuth, row?.authLast4], [null, null]);

  const res = await call(handler, "PATCH", `/v1/mcp-servers/${srv.id}`, {
    auth: "bearer",
    secret: "lin_api_freshkey9",
  });
  assertEquals(res.status, 409);
  assertEquals((await res.json()).code, "server_archived");
  assertEquals((await store.getServer(srv.id))?.encryptedAuth, null);
});

test("probe hands the row to the prober and returns its verdict on a 200 either way", async () => {
  const { handler, probed } = makeApi();
  const srv = await (await call(handler, "POST", "/v1/mcp-servers", CREATE)).json();
  const res = await call(handler, "POST", `/v1/mcp-servers/${srv.id}/probe`);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
  assertEquals(probed[0].id, srv.id);
  assertEquals(probed[0].encryptedAuth, 'sealed:{"Authorization":"Bearer lin_api_verysecret"}');

  const failing = makeApi({
    probe: () =>
      Promise.resolve({
        ok: false,
        reason: "credential_rejected",
        detail: "upstream answered 401",
      }),
  });
  const s2 = await (await call(failing.handler, "POST", "/v1/mcp-servers", CREATE)).json();
  const bad = await call(failing.handler, "POST", `/v1/mcp-servers/${s2.id}/probe`);
  assertEquals(bad.status, 200);
  assertEquals((await bad.json()).reason, "credential_rejected");
  assertEquals((await call(handler, "POST", "/v1/mcp-servers/ms-nope/probe")).status, 404);
});

test("the usage trail is readable per run", async () => {
  const { handler, store } = makeApi();
  await store.recordUsage({
    runId: "r-1",
    serverId: "ms-1",
    method: "tools/call",
    tool: "list_issues",
    status: "ok",
    httpStatus: 200,
    durationMs: 12,
    at: T0,
  });
  const res = await call(handler, "GET", "/v1/mcp-usage/r-1");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.usage.length, 1);
  assertEquals(body.hasMore, false);
  assertEquals(body.nextCursor, null);
  assertEquals((await (await call(handler, "GET", "/v1/mcp-usage/r-none")).json()).usage, []);
});

test("the usage trail is paged newest-first, and never answered whole", async () => {
  const { handler, store } = makeApi();
  // More rows than the cap, which is what an agent looping on a denied tool writes.
  for (let i = 0; i < MAX_USAGE_PAGE + 5; i++) {
    await store.recordUsage({
      runId: "r-1",
      serverId: "ms-1",
      method: "tools/call",
      tool: `t-${i}`,
      status: "denied",
      httpStatus: null,
      durationMs: 0,
      at: T0,
    });
  }

  // No limit is not "no bound": the newest page comes back, with the way to walk further.
  const whole = await (await call(handler, "GET", "/v1/mcp-usage/r-1")).json();
  assertEquals(whole.usage.length, MAX_USAGE_PAGE);
  assertEquals(whole.usage.at(-1).tool, `t-${MAX_USAGE_PAGE + 4}`); // the newest row
  assertEquals(whole.hasMore, true);

  // A limit above the cap is clamped to it, never honored.
  const greedy = await (await call(handler, "GET", "/v1/mcp-usage/r-1?limit=9999")).json();
  assertEquals(greedy.usage.length, MAX_USAGE_PAGE);

  const first = await (await call(handler, "GET", "/v1/mcp-usage/r-1?limit=2")).json();
  assertEquals(first.usage.map((u: { tool: string }) => u.tool), [
    `t-${MAX_USAGE_PAGE + 3}`,
    `t-${MAX_USAGE_PAGE + 4}`,
  ]);
  const next = await (await call(
    handler,
    "GET",
    `/v1/mcp-usage/r-1?limit=2&cursor=${first.nextCursor}`,
  )).json();
  assertEquals(next.usage.map((u: { tool: string }) => u.tool), [
    `t-${MAX_USAGE_PAGE + 1}`,
    `t-${MAX_USAGE_PAGE + 2}`,
  ]);

  // A cursor nobody issued is an error, not a silent read of the newest page.
  assertEquals((await call(handler, "GET", "/v1/mcp-usage/r-1?cursor=nope")).status, 400);
  assertEquals((await call(handler, "GET", "/v1/mcp-usage/r-1?limit=-3")).status, 400);
});

test("the ingest schema refuses bad slugs, bad tool shapes, and a secret no header can carry", async () => {
  const { handler } = makeApi();
  for (
    const body of [
      { ...CREATE, slug: "Linear" },
      { ...CREATE, slug: "-linear" },
      { ...CREATE, slug: "a".repeat(40) },
      { ...CREATE, secret: "has space in it" },
      // Nothing past visible ASCII: a header no request could carry, refused before it is sealed.
      { ...CREATE, secret: "lin_api_\u200bsecret" },
      { ...CREATE, secret: "lin_api_secrét00" },
      { ...CREATE, auth: "headers", secret: undefined, headers: { "X-Api-Key": "a\u3000b" } },
      { ...CREATE, auth: "headers", secret: undefined, headers: { "X-Api-Key": "a  b" } },
      { ...CREATE, auth: "headers", secret: undefined, headers: { "X-Api-Key": " lead" } },
      { ...CREATE, auth: "bearer", secret: undefined },
      { ...CREATE, auth: "oauth" },
      { ...CREATE, url: "mcp.linear.example/mcp" },
    ]
  ) {
    const res = await call(handler, "POST", "/v1/mcp-servers", body);
    assertEquals(res.status, 400, JSON.stringify(body));
    await res.body?.cancel();
  }
});

test("every route sits behind the host's gate", async () => {
  const { handler } = makeApi();
  const cases: Array<[string, string, unknown?]> = [
    ["POST", "/v1/mcp-servers", CREATE],
    ["GET", "/v1/mcp-servers"],
    ["GET", "/v1/mcp-servers/ms-x"],
    ["PATCH", "/v1/mcp-servers/ms-x", { name: "x" }],
    ["POST", "/v1/mcp-servers/ms-x/probe"],
    ["GET", "/v1/mcp-usage/r-1"],
    ["GET", "/v1/mcp-catalogue"],
    ["POST", "/v1/mcp-servers/ms-x/restart"],
    ["GET", "/v1/mcp-servers/ms-x/logs"],
  ];
  for (const [method, path, body] of cases) {
    const res = await call(handler, method, path, body, null);
    assertEquals(res.status, 401, `${method} ${path}`);
    await res.body?.cancel();
  }
});

test("managing a server is admins-only; listing and reading one are not", async () => {
  const { handler } = makeApi();
  const srv = await (await call(handler, "POST", "/v1/mcp-servers", CREATE)).json();

  const refused: Array<[string, string, unknown?]> = [
    ["POST", "/v1/mcp-servers", { ...CREATE, slug: "another" }],
    ["PATCH", `/v1/mcp-servers/${srv.id}`, { name: "x" }],
    ["POST", `/v1/mcp-servers/${srv.id}/probe`],
    ["POST", `/v1/mcp-servers/${srv.id}/restart`],
    ["GET", `/v1/mcp-servers/${srv.id}/logs`],
    ["GET", "/v1/mcp-usage/r-1"],
  ];
  for (const [method, path, body] of refused) {
    const res = await call(handler, method, path, body, PLAIN);
    assertEquals(res.status, 403, `${method} ${path}`);
    assertEquals((await res.json()).code, FORBIDDEN, `${method} ${path}`);
  }

  // The agent form is every user's, and it needs the names — so listing (and one row) stays open.
  const listed = await call(handler, "GET", "/v1/mcp-servers", undefined, PLAIN);
  assertEquals(listed.status, 200);
  assertEquals((await listed.json()).mcpServers.length, 1);
  const one = await call(handler, "GET", `/v1/mcp-servers/${srv.id}`, undefined, PLAIN);
  assertEquals(one.status, 200);
  await one.body?.cancel();
});

test("repointing a credentialed server demands the credential in the same request", async () => {
  const { handler, sealed } = makeApi();
  const srv = await (await call(handler, "POST", "/v1/mcp-servers", CREATE)).json();

  const bare = await call(handler, "PATCH", `/v1/mcp-servers/${srv.id}`, {
    url: "https://collector.attacker.example/mcp",
  });
  assertEquals(bare.status, 400);
  assertEquals((await bare.json()).code, CREDENTIAL_REQUIRED);
  assertEquals(sealed.length, 1, "nothing was sealed, and nothing was moved");

  const moved = await call(handler, "PATCH", `/v1/mcp-servers/${srv.id}`, {
    url: "https://mcp2.linear.example/mcp",
    auth: "bearer",
    secret: "lin_api_freshkey9",
  });
  assertEquals(moved.status, 200);
  const movedSrv = await moved.json();
  assertEquals(movedSrv.url, "https://mcp2.linear.example/mcp");
  assertEquals(movedSrv.authLast4, "key9");

  // Dropping the credential IS supplying one: the secret does not follow the URL anywhere.
  const opened = await call(handler, "PATCH", `/v1/mcp-servers/${srv.id}`, {
    url: "https://mcp3.linear.example/mcp",
    auth: "none",
  });
  assertEquals(opened.status, 200);
  assertEquals((await opened.json()).auth, "none");

  // With no credential to leak, a plain repoint is just an edit again.
  const plain = await call(handler, "PATCH", `/v1/mcp-servers/${srv.id}`, {
    url: "https://mcp4.linear.example/mcp",
  });
  assertEquals(plain.status, 200);
  await plain.body?.cancel();

  assertEquals(
    (await call(handler, "PATCH", "/v1/mcp-servers/ms-nope", { url: "https://x.example/mcp" }))
      .status,
    404,
  );
});

test("an archived server is never probed: the credential stops going out with the row", async () => {
  const { handler, probed } = makeApi();
  const srv = await (await call(handler, "POST", "/v1/mcp-servers", CREATE)).json();
  await (await call(handler, "POST", `/internal/v1/mcp-servers/${srv.id}/archive`)).body?.cancel();
  const res = await call(handler, "POST", `/v1/mcp-servers/${srv.id}/probe`);
  assertEquals(res.status, 409);
  assertEquals((await res.json()).code, SERVER_ARCHIVED);
  assertEquals(probed.length, 0, "the prober was never reached");
});

test("the disabled stand-ins answer every path with the marker, behind the same gate", async () => {
  const gate = (req: Request) =>
    Promise.resolve(
      req.headers.get("authorization") === "Bearer user-secret"
        ? null
        : new Response("no", { status: 401 }),
    );
  const handler = router(disabledMcpServerRoutes({ authenticate: gate }));
  const res = await call(handler, "GET", "/v1/mcp-servers");
  assertEquals(res.status, 503);
  assertEquals((await res.json()).code, MCP_DISABLED);
  assertEquals((await call(handler, "POST", "/v1/mcp-servers/ms-1/probe")).status, 503);
  // The hosting paths are covered too: "tools are off" beats "no such route" everywhere.
  for (
    const [method, path] of [
      ["GET", "/v1/mcp-catalogue"],
      ["POST", "/v1/mcp-servers/ms-1/restart"],
      ["GET", "/v1/mcp-servers/ms-1/logs"],
    ]
  ) {
    const r = await call(handler, method, path);
    assertEquals(r.status, 503, path);
    assertEquals((await r.json()).code, MCP_DISABLED, path);
  }
  assertEquals((await call(handler, "GET", "/v1/mcp-usage/r-1", undefined, null)).status, 401);
  // Archiving is the control plane's door, never this surface's — on or off.
  assertEquals((await call(handler, "POST", "/v1/mcp-servers/ms-1/archive")).status, 404);
});

test("the user surface does not archive: the control plane fronts it", async () => {
  const { handler, store } = makeApi();
  const srv = await (await call(handler, "POST", "/v1/mcp-servers", CREATE)).json();
  const res = await call(handler, "POST", `/v1/mcp-servers/${srv.id}/archive`);
  assertEquals(res.status, 404);
  await res.body?.cancel();
  assertEquals((await store.getServer(srv.id))?.archivedAt, null);
});

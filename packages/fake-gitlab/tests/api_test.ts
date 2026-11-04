// The account and project surface: who a token is, what it reaches, GitLab's refusal shapes,
// pagination headers, uploads and scripted failures.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { ACCESS } from "../src/mod.ts";
import { seeded, WIDGETS } from "./util.ts";

const enc = encodeURIComponent;

test("a personal token: /user, /version, /personal_access_tokens/self", async () => {
  await using fake = await seeded();
  const token = fake.token("ryph-bot", { expiresAt: "2099-01-01" });
  const get = (path: string, t = token) =>
    fetch(`${fake.apiUrl}${path}`, { headers: { "PRIVATE-TOKEN": t } });

  const me = await (await get("/user")).json();
  assertEquals([me.username, me.bot, typeof me.id], ["ryph-bot", true, "number"]);
  assertEquals((await (await get("/version")).json()).version, "17.5.0");

  const self = await (await get("/personal_access_tokens/self")).json();
  assertEquals(self.scopes, ["api", "read_repository", "write_repository"]);
  assertEquals([self.active, self.expires_at, self.user_id], [true, "2099-01-01", me.id]);

  // Bearer works as well as PRIVATE-TOKEN.
  const bearer = await fetch(`${fake.apiUrl}/user`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assertEquals((await bearer.json()).username, "ryph-bot");

  // Unknown, revoked and expired tokens are all a plain 401.
  assertEquals((await get("/user", "glpat-nope")).status, 401);
  const expired = fake.token("dev", { expiresAt: "2000-01-01" });
  assertEquals(await (await get("/user", expired)).json(), { message: "401 Unauthorized" });
  const revoked = fake.token("dev");
  fake.revokeToken(revoked);
  assertEquals((await get("/user", revoked)).status, 401);
});

test("scopes: read_api reads but cannot write; read_user reaches /user alone", async () => {
  await using fake = await seeded();
  const reader = fake.token("dev", { scopes: ["read_api"] });
  const userOnly = fake.token("dev", { scopes: ["read_user"] });
  const call = (t: string, method: string, path: string, body?: unknown) =>
    fetch(`${fake.apiUrl}${path}`, {
      method,
      headers: { "PRIVATE-TOKEN": t, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  assertEquals((await call(reader, "GET", `/projects/${enc(WIDGETS)}`)).status, 200);
  const refused = await call(reader, "POST", `/projects/${enc(WIDGETS)}/issues`, { title: "x" });
  assertEquals(refused.status, 403);
  assertEquals((await refused.json()).error, "insufficient_scope");
  assertEquals((await call(userOnly, "GET", "/user")).status, 200);
  assertEquals((await call(userOnly, "GET", `/projects/${enc(WIDGETS)}`)).status, 403);
});

test("projects: nested paths, any case, ids; membership listings; invisible is 404", async () => {
  await using fake = await seeded();
  await fake.addProject("acme/other", { files: { "a": "a\n" } });
  await fake.addProject("acme/public-thing", { visibility: "public", files: { "a": "a\n" } });
  const bot = fake.client("ryph-bot");

  const p = await (await bot("GET", `/projects/${enc("ACME/Platform/Widgets")}`)).json();
  assertEquals(p.path_with_namespace, WIDGETS);
  assertEquals(p.http_url_to_repo, `${fake.url}/${WIDGETS}.git`);
  assertEquals(p.web_url, `${fake.url}/${WIDGETS}`);
  assertEquals([p.default_branch, p.visibility, p.empty_repo], ["main", "private", false]);
  assertEquals(p.namespace.full_path, "acme/platform");
  assertEquals(p.permissions.project_access.access_level, ACCESS.developer);
  assertEquals((await (await bot("GET", `/projects/${p.id}`)).json()).id, p.id);

  // The bot's reach: projects it is a member of at Developer or above.
  const reach = await (await bot("GET", "/projects?membership=true&min_access_level=30")).json();
  assertEquals(reach.map((x: { path_with_namespace: string }) => x.path_with_namespace), [WIDGETS]);
  // maya reaches all three acme projects through the group, as Maintainer.
  const maya = fake.client("maya");
  const mine = await (await maya("GET", "/projects?min_access_level=40&order_by=id&sort=asc"))
    .json();
  assertEquals(mine.map((x: { path_with_namespace: string }) => x.path_with_namespace), [
    WIDGETS,
    "acme/other",
    "acme/public-thing",
  ]);

  // A private project the caller cannot see is 404, never 403; a public one is anyone's.
  const outsider = fake.client("outsider");
  const hidden = await outsider("GET", `/projects/${enc("acme/other")}`);
  assertEquals([hidden.status, await hidden.json()], [404, { message: "404 Project Not Found" }]);
  assertEquals((await outsider("GET", `/projects/${enc("acme/public-thing")}`)).status, 200);
  assertEquals((await fetch(`${fake.apiUrl}/projects/${enc("acme/public-thing")}`)).status, 200);
  assertEquals((await fetch(`${fake.apiUrl}/projects/${enc(WIDGETS)}`)).status, 404);
});

test("members/all: effective level, inherited from groups; 404 for a non-member", async () => {
  await using fake = await seeded();
  const bot = fake.client("ryph-bot");
  const id = (u: string) => fake.world.userByUsername(u)!.id;
  const level = async (u: string) => {
    const r = await bot("GET", `/projects/${enc(WIDGETS)}/members/all/${id(u)}`);
    return r.status === 200 ? (await r.json()).access_level : r.status;
  };
  assertEquals(await level("maya"), 40);
  assertEquals(await level("dev"), 30);
  assertEquals(await level("guest"), 10);
  assertEquals(await level("outsider"), 404);
  // The group gate's read.
  const g = await bot("GET", `/groups/acme/members/all/${id("maya")}`);
  assertEquals((await g.json()).access_level, 40);
  assertEquals((await bot("GET", `/groups/acme/members/all/${id("dev")}`)).status, 404);
  // A user lookup by username, as the permission check resolves one.
  const users = await (await bot("GET", "/users?username=Maya")).json();
  assertEquals(users.map((u: { id: number }) => u.id), [id("maya")]);
});

test("members/all names an awaiting membership and a blocked user; neither holds the level", async () => {
  await using fake = await seeded();
  fake.addUser({ username: "queued" });
  fake.addMember(WIDGETS, "queued", "maintainer", { awaiting: true });
  fake.addMember("acme", "queued", "developer", { awaiting: true });
  const bot = fake.client("ryph-bot");
  const queued = fake.world.userByUsername("queued")!;
  const m = await (await bot("GET", `/projects/${enc(WIDGETS)}/members/all/${queued.id}`)).json();
  assertEquals([m.access_level, m.membership_state, m.state], [40, "awaiting", "active"]);
  const g = await (await bot("GET", `/groups/acme/members/all/${queued.id}`)).json();
  assertEquals([g.access_level, g.membership_state], [30, "awaiting"]);
  // Awaiting holds nothing: the project stays invisible to it.
  const qc = fake.client("queued");
  assertEquals((await qc("GET", `/projects/${enc(WIDGETS)}`)).status, 404);

  const dev = fake.world.userByUsername("dev")!;
  const devToken = fake.token("dev");
  fake.blockUser("dev");
  const b = await (await bot("GET", `/projects/${enc(WIDGETS)}/members/all/${dev.id}`)).json();
  assertEquals([b.access_level, b.membership_state, b.state], [30, "active", "blocked"]);
  const asDev = await fetch(`${fake.apiUrl}/user`, { headers: { "private-token": devToken } });
  assertEquals(asDev.status, 401);
});

test("feature access levels: shown on the project, a members-only repository closed to others", async () => {
  await using fake = await seeded();
  await fake.addProject("acme/open", { visibility: "public", files: { "a": "a\n" } });
  const anon = (path: string) => fetch(`${fake.apiUrl}${path}`);
  const p = await (await anon(`/projects/${enc("acme/open")}`)).json();
  assertEquals(
    [p.repository_access_level, p.merge_requests_access_level, p.issues_access_level],
    ["enabled", "enabled", "enabled"],
  );
  assertEquals((await anon(`/projects/${enc("acme/open")}/repository/branches/main`)).status, 200);
  fake.setFeatureAccess("acme/open", "repository", "private");
  const q = await (await anon(`/projects/${enc("acme/open")}`)).json();
  assertEquals([q.visibility, q.repository_access_level], ["public", "private"]);
  assertEquals((await anon(`/projects/${enc("acme/open")}/repository/branches/main`)).status, 403);
});

test("a renamed project keeps its id, its old path redirects until a project takes it", async () => {
  await using fake = await seeded();
  const bot = fake.client("ryph-bot");
  const before = await (await bot("GET", `/projects/${enc(WIDGETS)}`)).json();
  fake.renameProject(WIDGETS, "acme/platform/gadgets");
  const moved = await (await bot("GET", `/projects/${enc(WIDGETS)}`)).json();
  assertEquals([moved.id, moved.path_with_namespace], [before.id, "acme/platform/gadgets"]);
  const taken = await fake.addProject(WIDGETS);
  fake.addMember(WIDGETS, "ryph-bot", "developer");
  const now = await (await bot("GET", `/projects/${enc(WIDGETS)}`)).json();
  assertEquals(now.id, taken.id);
  assert(now.id !== before.id);
  assertEquals(
    (await (await bot("GET", `/projects/${before.id}`)).json()).path_with_namespace,
    "acme/platform/gadgets",
  );
});

test("pagination: X-Total, X-Next-Page, Link; X-Total left out past the cap", async () => {
  await using fake = await seeded({ countCap: 4 });
  for (let i = 0; i < 5; i++) fake.openIssue(WIDGETS, { as: "dev", title: `issue ${i}` });
  const bot = fake.client("ryph-bot");
  const page1 = await bot("GET", `/projects/${enc(WIDGETS)}/issues?per_page=2`);
  assertEquals(page1.headers.get("x-next-page"), "2");
  assertEquals(page1.headers.get("x-total"), null);
  assertEquals((await page1.json()).length, 2);
  const page3 = await bot("GET", `/projects/${enc(WIDGETS)}/issues?per_page=2&page=3`);
  assertEquals(page3.headers.get("x-next-page"), "");
  assertEquals((await page3.json()).length, 1);
  const small = await bot("GET", `/projects/${enc(WIDGETS)}/issues?per_page=2&labels=none-such`);
  assertEquals([small.headers.get("x-total"), small.headers.get("x-total-pages")], ["0", "1"]);
  assert(page1.headers.get("link")!.includes('rel="next"'));
});

test("uploads: multipart in, credentialed read out; the read route needs 17.4", async () => {
  await using fake = await seeded();
  const token = fake.token("dev");
  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }),
  );
  const up = await fetch(`${fake.apiUrl}/projects/${enc(WIDGETS)}/uploads`, {
    method: "POST",
    headers: { "PRIVATE-TOKEN": token },
    body: form,
  });
  assertEquals(up.status, 201);
  const u = await up.json();
  const m = /^\/uploads\/([0-9a-f]{32})\/shot\.png$/.exec(u.url)!;
  assert(m, u.url);
  assertEquals(u.markdown, `![shot](${u.url})`);
  const read = await fetch(`${fake.apiUrl}/projects/${enc(WIDGETS)}/uploads/${m[1]}/shot.png`, {
    headers: { "PRIVATE-TOKEN": fake.token("ryph-bot") },
  });
  // Typed as GitLab 17.11 types it: a download, whatever the bytes are.
  assertEquals([read.status, read.headers.get("content-type")], [200, "application/octet-stream"]);
  assertEquals(new Uint8Array(await read.arrayBuffer()), new Uint8Array([137, 80, 78, 71]));
  // An outsider cannot read a private project's upload; nobody reads a wrong secret.
  const outsider = await fetch(`${fake.apiUrl}/projects/${enc(WIDGETS)}/uploads/${m[1]}/shot.png`, {
    headers: { "PRIVATE-TOKEN": fake.token("outsider") },
  });
  assertEquals(outsider.status, 404);
  const wrong = await fetch(
    `${fake.apiUrl}/projects/${enc(WIDGETS)}/uploads/${"0".repeat(32)}/shot.png`,
    {
      headers: { "PRIVATE-TOKEN": token },
    },
  );
  assertEquals(wrong.status, 404);

  await using old = await seeded({ version: "17.3.2" });
  const r = await fetch(`${old.apiUrl}/projects/${enc(WIDGETS)}/uploads/${m[1]}/shot.png`, {
    headers: { "PRIVATE-TOKEN": old.token("dev") },
  });
  assertEquals(r.status, 404);
});

test("intercept: a scripted 429 with Retry-After, then normal service; requests are logged", async () => {
  await using fake = await seeded();
  let left = 1;
  fake.intercept((_req, path) => {
    if (path === "/api/v4/user" && left-- > 0) {
      return new Response(JSON.stringify({ message: "Retry later" }), {
        status: 429,
        headers: { "retry-after": "7" },
      });
    }
    return null;
  });
  const bot = fake.client("ryph-bot");
  const first = await bot("GET", "/user");
  assertEquals([first.status, first.headers.get("retry-after")], [429, "7"]);
  assertEquals((await bot("GET", "/user")).status, 200);
  assertEquals(fake.requests.filter((r) => r.path === "/api/v4/user").length, 2);
});

test("a path prefix: the instance lives under /gitlab", async () => {
  await using fake = await seeded({ basePath: "/gitlab" });
  assert(fake.url.endsWith("/gitlab"));
  const p = await (await fake.client("dev")("GET", `/projects/${enc(WIDGETS)}`)).json();
  assertEquals(p.http_url_to_repo, `${fake.url}/${WIDGETS}.git`);
  const bare = fake.url.replace(/\/gitlab$/, "");
  assertEquals((await fetch(`${bare}/api/v4/user`)).status, 404);
});

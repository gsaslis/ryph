// GitLab USER mode — the forge acting as one person's token — against a fake GitLab: what the
// boot tolerates, where the token may be presented (the instance, and that project's own path),
// how a 401 re-reads it, what a person's forge refuses (webhooks, sign-in), and that a review
// never publishes the person's own pending drafts.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { serve } from "@ryph/service";
import { gitlabForgeApi } from "../src/adapters/forge_api/gitlab.ts";
import { ForgeApiError } from "../src/ports/forge_api.ts";
import {
  GITLAB_TOKEN_NAMES,
  staticUserToken,
  type UserTokenSource,
} from "../src/helpers/user_token.ts";
import { recordingDiagnostics, silentDiagnostics } from "./util.ts";
import { gitlabAccountId, gitlabProjectRef } from "../src/gitlab_account.ts";

const TOKEN = "glpat-personTokenNeverLogged";
const ME = 31;
const LOGIN = "ada.lovelace";
const P = "77"; // `ada.lovelace/notes`'s id
/** The person's project, by its id on the instance under test, which `userApi` sets. */
const mine = { repoRef: "ada.lovelace/notes", tenantId: null, forgeId: "" };

interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

/** A fake GitLab served under a path prefix (`/gitlab`), as a self-managed instance may be. */
async function fakeGitlab(opts: { tokens?: string[]; pat?: "ok" | "missing" | "unreadable" } = {}) {
  const calls: Call[] = [];
  const valid = new Set(opts.tokens ?? [TOKEN]);
  let respond: (call: Call) => Response | null = () => null;
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/gitlab\/api\/v4/, "") + url.search;
    const auth = req.headers.get("authorization");
    const text = req.body === null ? "" : await req.text();
    const call = {
      method: req.method,
      path,
      auth,
      body: text === "" ? undefined : JSON.parse(text),
    };
    if (auth === null || !valid.has(auth.replace(/^Bearer /, ""))) {
      calls.push(call);
      return Response.json({ message: "401 Unauthorized" }, { status: 401 });
    }
    if (path === "/user") return Response.json({ id: ME, username: LOGIN });
    if (path === "/version") return Response.json({ version: "17.6.0" });
    if (path === "/personal_access_tokens/self") {
      if (opts.pat === "unreadable") return Response.json({ message: "404" }, { status: 404 });
      return Response.json({
        scopes: opts.pat === "missing"
          ? ["read_api"]
          : ["api", "read_repository", "write_repository"],
        expires_at: null,
      });
    }
    calls.push(call);
    return respond(call) ?? Response.json({ message: "404 Not Found" }, { status: 404 });
  });
  const base = `http://127.0.0.1:${server.addr.port}`;
  return {
    base,
    url: `${base}/gitlab`,
    calls,
    valid,
    paths: () => calls.map((c) => `${c.method} ${c.path}`),
    set: (fn: (call: Call) => Response | null) => {
      respond = fn;
    },
    shutdown: () => server.shutdown(),
  };
}

function userApi(
  url: string,
  token: UserTokenSource = staticUserToken(TOKEN, GITLAB_TOKEN_NAMES),
  diag = silentDiagnostics(),
) {
  mine.forgeId = gitlabProjectRef(url, P);
  return gitlabForgeApi({
    mode: "user",
    url,
    token,
    webhookSecret: null,
    oauth: null,
    group: null,
    diag,
  });
}

/** A token source that starts on `first` and renews to `fresh`, counting renewals. */
function renewing(first: string, fresh: string | null) {
  let current = first;
  const refreshes: string[] = [];
  const source: UserTokenSource = {
    kind: "command",
    current: () => Promise.resolve(current),
    refresh: (stale) => {
      refreshes.push(stale);
      if (fresh === null || stale === fresh) return Promise.resolve(null);
      current = fresh;
      return Promise.resolve(fresh);
    },
  };
  return { source, refreshes };
}

test("user mode boots as the person, at the instance's path prefix", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await userApi(gl.url);
    assertEquals(api.mode, {
      mode: "user",
      login: LOGIN,
      accountId: gitlabAccountId(gl.url, String(ME)),
      url: gl.url,
      signIn: false,
    });
    assertEquals(api.self, { id: String(ME), login: LOGIN });
  } finally {
    await gl.shutdown();
  }
});

test("missing or unreadable scopes warn in user mode and never fail the boot", async () => {
  for (const pat of ["missing", "unreadable"] as const) {
    const gl = await fakeGitlab({ pat });
    try {
      const { diag, events } = recordingDiagnostics();
      await userApi(gl.url, undefined, diag);
      assert(
        events.some((e) =>
          e.event === (pat === "missing" ? "gitlab.missing_scopes" : "gitlab.scopes_unreadable")
        ),
      );
    } finally {
      await gl.shutdown();
    }
  }
});

test("the token goes to git for this project's own path on the instance, and nowhere else", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await userApi(gl.url);
    for (const ok of [`${gl.url}/ada.lovelace/notes.git`, `${gl.url}/Ada.Lovelace/Notes`]) {
      const auth = await api.fetchAuth(mine, ok);
      assertEquals(auth?.token, TOKEN, ok);
      assertEquals(auth?.basicUser, "oauth2");
      assertEquals(auth?.origin, gl.base);
      assertEquals((await api.pushAuth(mine, ok))?.token, TOKEN);
    }
    for (
      const bad of [
        `${gl.url}/someone/notes.git`, // another project — a fork, say
        `${gl.base}/ada.lovelace/notes.git`, // outside the instance's prefix
        `${gl.url}/ada.lovelace/notes/../../x/y.git`,
        `${gl.url}/ada.lovelace%2Fnotes.git`,
        `https://evil.example/gitlab/ada.lovelace/notes.git`,
        `${gl.url}/ada.lovelace/notes.git?x=1`,
      ]
    ) {
      assertEquals(await api.fetchAuth(mine, bad), null, bad);
      const err = await assertRejects(() => api.pushAuth(mine, bad), ForgeApiError);
      assert(err.terminal, bad);
      assert(!err.message.includes(TOKEN));
    }
    // A person's forge never reads the bot's over-privilege.
    assertEquals(gl.calls, []);
  } finally {
    await gl.shutdown();
  }
});

test("a 401 re-reads the token once and retries once — and never loops", async () => {
  const gl = await fakeGitlab({ tokens: ["tok-1"] });
  try {
    const { source, refreshes } = renewing("tok-1", "tok-2");
    const api = await userApi(gl.url, source);
    gl.set(({ path }) =>
      path === `/projects/${P}`
        ? Response.json({
          visibility: "public",
          repository_access_level: "enabled",
          merge_requests_access_level: "enabled",
          issues_access_level: "enabled",
          builds_access_level: "enabled",
        })
        : null
    );
    // Rotated under us: tok-1 now refused, tok-2 valid.
    gl.valid.clear();
    gl.valid.add("tok-2");
    assertEquals(
      [...await api.repoVisibility(null, [mine.forgeId])].map(([r, v]) => [r, v.source]),
      [[mine.forgeId, "public"]],
    );
    assertEquals(refreshes, ["tok-1"]);
    assertEquals(gl.calls.map((c) => c.auth), ["Bearer tok-1", "Bearer tok-2"]);

    // Refused again with nothing new to retry with: the 401 stands, after one renewal ask.
    gl.valid.clear();
    gl.calls.length = 0;
    const err = await assertRejects(
      () => api.repoVisibility(null, [mine.forgeId]),
      ForgeApiError,
    );
    assert(err.terminal);
    assertEquals(gl.calls.length, 1);
    assertEquals(refreshes, ["tok-1", "tok-2"]);
  } finally {
    await gl.shutdown();
  }
});

test("git's 401 renews the credential once through FetchAuth.refresh", async () => {
  const gl = await fakeGitlab({ tokens: ["tok-1"] });
  try {
    const { source } = renewing("tok-1", "tok-2");
    const api = await userApi(gl.url, source);
    const auth = await api.fetchAuth(mine, `${gl.url}/ada.lovelace/notes.git`);
    assertEquals(auth?.token, "tok-1");
    const renewed = await auth?.refresh?.();
    assertEquals(renewed?.token, "tok-2");
    assertEquals(renewed?.basicUser, "oauth2");
    assertEquals(renewed?.refresh, undefined);
  } finally {
    await gl.shutdown();
  }
});

test("a person's forge takes no webhooks and offers no sign-in or group gate", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await userApi(gl.url);
    assert((await assertRejects(() => api.hookToken("42", 1), ForgeApiError)).terminal);
    assert(
      (await assertRejects(() => api.exchangeOAuthCode("c", "https://r/cb", null), ForgeApiError))
        .terminal,
    );
    assertEquals(await api.checkGroupMembership(LOGIN), null);
    assertEquals(gl.calls, []);
  } finally {
    await gl.shutdown();
  }
});

test("listProjects in user mode is every membership, admin where the person is Maintainer", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await userApi(gl.url);
    const project = (id: number, path: string) => ({
      id,
      path_with_namespace: path,
      http_url_to_repo: `${gl.url}/${path}.git`,
      web_url: `${gl.url}/${path}`,
      default_branch: "main",
      visibility: "public",
    });
    gl.set(({ path }) => {
      if (path.startsWith("/projects?membership=true&order_by")) {
        return Response.json([project(1, "ada.lovelace/notes"), project(2, "team/app")]);
      }
      if (path.startsWith("/projects?membership=true&min_access_level=40")) {
        return Response.json([project(1, "ada.lovelace/notes")]);
      }
      return null;
    });
    const listed = await api.listProjects();
    assertEquals(listed.map((p) => [p.pathWithNamespace, p.admin]), [
      ["ada.lovelace/notes", true],
      ["team/app", false],
    ]);
  } finally {
    await gl.shutdown();
  }
});

test("a merge request the person opened is ours, by their account id", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await userApi(gl.url);
    gl.set(({ path }) =>
      path === `/projects/${P}/merge_requests/2`
        ? Response.json({ state: "opened", sha: "h", target_branch: "main", author: { id: ME } })
        : null
    );
    assertEquals((await api.readChangeRequestState(mine, "!2"))?.openedByUs, true);
  } finally {
    await gl.shutdown();
  }
});

test("a review in user mode publishes only its own drafts, one by one, and never clears the person's", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await userApi(gl.url);
    const base = `/projects/${P}/merge_requests/2/draft_notes`;
    let failPublishOf: string | null = null;
    let next = 700;
    gl.set(({ method, path }) => {
      if (path === `/projects/${P}/merge_requests/2`) {
        return Response.json({
          web_url: "w2",
          sha: "h",
          diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" },
        });
      }
      if (path.startsWith(`/projects/${P}/merge_requests/2/diffs`)) {
        return Response.json([{ old_path: "a", new_path: "a", diff: "@@ -1 +1 @@\n-x\n+y" }]);
      }
      if (method === "POST" && path === base) return Response.json({ id: ++next }, { status: 201 });
      const publish = new RegExp(`^${base}/(\\d+)/publish$`).exec(path)?.[1];
      if (method === "PUT" && publish !== undefined) {
        return publish === failPublishOf
          ? Response.json({ message: "boom" }, { status: 500 })
          : new Response(null, { status: 204 });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      return null;
    });
    await api.createReview(mine, "mr-2", {
      body: "summary",
      comments: [{ path: "a", line: 1, side: "RIGHT", body: "r" }],
      headSha: "h",
    });
    const writes = gl.paths().filter((p) => !p.startsWith("GET"));
    assertEquals(writes, [
      `POST ${base}`,
      `POST ${base}`,
      `PUT ${base}/701/publish`,
      `PUT ${base}/702/publish`,
    ]);
    assert(
      !gl.paths().some((p) => p.endsWith("/bulk_publish") || p === `GET ${base}?per_page=100`),
    );

    // A publish failing midway: what was published stands, the rest is deleted.
    gl.calls.length = 0;
    failPublishOf = "704";
    await assertRejects(
      () =>
        api.createReview(mine, "mr-2", {
          body: "summary",
          comments: [{ path: "a", line: 1, side: "RIGHT", body: "r" }],
          headSha: "h",
        }),
      ForgeApiError,
    );
    assertEquals(gl.paths().filter((p) => p.startsWith("DELETE")), [`DELETE ${base}/704`]);
  } finally {
    await gl.shutdown();
  }
});

test("commit statuses are posted in user mode too: a Developer person may post them", async () => {
  const gl = await fakeGitlab();
  try {
    const api = await userApi(gl.url);
    gl.set(({ method }) => method === "POST" ? Response.json({ id: 5 }, { status: 201 }) : null);
    const out = await api.reportChecks(mine, {
      headSha: "abc",
      suiteId: "cs-1",
      generation: 1,
      detailsUrl: null,
      suite: { state: "running", conclusion: null, summary: "" },
      checks: [{
        name: "lint",
        status: "in_progress",
        conclusion: null,
        title: "lint: running",
        summary: "",
        startedAt: null,
        completedAt: null,
        externalId: "cs-1:1:lint",
        forgeRef: null,
      }],
    });
    assertEquals(out, { kind: "reported", refs: { lint: "5" } });
    assertEquals(gl.paths(), [`POST /projects/${P}/statuses/abc`]);
  } finally {
    await gl.shutdown();
  }
});

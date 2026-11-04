// The GitHub adapter against a fake GitHub server — the error-mapping doctrine, verified:
// only a definitive 404 denies; 422 adopts; pagination never truncates.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { serve } from "@ryph/service";
import { githubForgeApi } from "../src/adapters/forge_api/github.ts";
import { ForgeApiError, wholeRepoVisibility } from "../src/ports/forge_api.ts";
import { silentDiagnostics } from "./util.ts";

/** A repo as the port is addressed with it: installation 42 is this suite's only tenant. */
const repo = (repoRef: string, tenantId: string | null = "42") => ({ repoRef, tenantId });

async function testKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

/** A programmable fake GitHub: each test sets `respond` for the paths it exercises. */
async function fakeGithub() {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const authorizations: Array<string | null> = [];
  // A handler may answer with a promise — the async serve handler awaits whatever it returns
  // — which is what lets a test hold several requests open at once and watch them overlap.
  let respond: (
    method: string,
    path: string,
    body: unknown,
  ) => Response | Promise<Response> | null = () => null;
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    const body = req.body === null ? undefined : await req.json().catch(() => undefined);
    calls.push({ method: req.method, path, body });
    authorizations.push(req.headers.get("authorization"));
    // Token minting is always available: door ③ cannot act without it.
    if (req.method === "POST" && /\/access_tokens$/.test(url.pathname)) {
      return new Response(
        JSON.stringify({
          token: "ghs_test",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 201 },
      );
    }
    return respond(req.method, path, body) ??
      new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  });
  return {
    base: `http://127.0.0.1:${server.addr.port}`,
    calls,
    authorizations,
    set: (fn: typeof respond) => {
      respond = fn;
    },
    shutdown: () => server.shutdown(),
  };
}

async function makeApi(base: string) {
  return await githubForgeApi({
    appId: "999",
    privateKeyPem: await testKeyPem(),
    oauth: { clientId: "Iv1.client", clientSecret: "shhh" },
    apiBase: base,
    oauthBase: base,
    diag: silentDiagnostics(),
  });
}

async function makeApiAt(apiBase: string, oauthBase: string) {
  return await githubForgeApi({
    appId: "999",
    privateKeyPem: await testKeyPem(),
    oauth: { clientId: "Iv1.client", clientSecret: "shhh" },
    apiBase,
    oauthBase,
    diag: silentDiagnostics(),
  });
}

test("installation settings builds from the live account on the configured web base", async () => {
  const gh = await fakeGithub();
  try {
    // A GHES-shaped deployment: the web base is not github.com.
    const web = "https://ghe.example/";
    const api = await makeApiAt(gh.base, web);
    // oxlint-disable-next-line no-explicit-any
    let account: any = { type: "Organization", login: "acme" };
    gh.set(() => new Response(JSON.stringify({ account })));
    assertEquals(
      await api.getInstallationSettingsUrl("42"),
      "https://ghe.example/organizations/acme/settings/installations/42",
    );
    account = { type: "Organization", login: "renamed/acme" };
    assertEquals(
      await api.getInstallationSettingsUrl("42"),
      "https://ghe.example/organizations/renamed%2Facme/settings/installations/42",
    );
    account = { type: "Enterprise", slug: "big-co", name: "Big Co" };
    assertEquals(
      await api.getInstallationSettingsUrl("42"),
      "https://ghe.example/enterprises/big-co/settings/installations/42",
    );
    account = { type: "User", login: "ada" };
    assertEquals(
      await api.getInstallationSettingsUrl("42/other"),
      "https://ghe.example/settings/installations/42%2Fother",
    );
    assertEquals(gh.calls.map(({ method, path }) => ({ method, path })), [
      { method: "GET", path: "/app/installations/42" },
      { method: "GET", path: "/app/installations/42" },
      { method: "GET", path: "/app/installations/42" },
      { method: "GET", path: "/app/installations/42%2Fother" },
    ]);
    for (const auth of gh.authorizations) {
      assert(auth !== null && auth.startsWith("Bearer "));
      const claims = JSON.parse(atob(auth.slice(7).split(".")[1]));
      assertEquals(claims.iss, "999");
    }
  } finally {
    await gh.shutdown();
  }
});

test("installation settings prefers GitHub's own html_url, only for this web base and installation", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApiAt(gh.base, "https://ghe.example/github");
    // oxlint-disable-next-line no-explicit-any
    let installation: any = {
      html_url: "https://ghe.example/github/enterprises/big-co/settings/installations/42",
      account: { type: "Enterprise", slug: "renamed-co" },
    };
    gh.set(() => new Response(JSON.stringify(installation)));
    assertEquals(
      await api.getInstallationSettingsUrl("42"),
      "https://ghe.example/github/enterprises/big-co/settings/installations/42",
    );
    // Anything that is not this host, this path shape and this installation is not believed:
    // the account type decides instead.
    for (
      const html_url of [
        "https://evil.test/github/organizations/acme/settings/installations/42",
        "https://ghe.example/github/organizations/acme/settings/installations/43",
        "https://ghe.example/github/acme/settings/installations/42/../../x",
        "https://ghe.example/other/settings/installations/42",
        "not a url",
      ]
    ) {
      installation = { html_url, account: { type: "Organization", login: "acme" } };
      assertEquals(
        await api.getInstallationSettingsUrl("42"),
        "https://ghe.example/github/organizations/acme/settings/installations/42",
      );
    }
  } finally {
    await gh.shutdown();
  }
});

test("installation settings refuses unknown accounts and upstream failures, keeping GitHub's message", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    for (
      const account of [
        null,
        {},
        { type: "Bot", login: "acme" },
        { type: "Enterprise", login: "acme" },
        { login: "acme" },
        { type: "Organization", login: "   " },
        { type: "Organization", login: 42 },
      ]
    ) {
      gh.set(() => new Response(JSON.stringify({ account })));
      await assertRejects(() => api.getInstallationSettingsUrl("42"));
    }
    for (const status of [403, 404, 500]) {
      gh.set(() => new Response(JSON.stringify({ message: `GitHub says ${status}` }), { status }));
      const err = await assertRejects(() => api.getInstallationSettingsUrl("42"));
      assertStringIncludes((err as Error).message, `GitHub says ${status}`);
    }
    gh.set(() => new Response("not JSON"));
    await assertRejects(() => api.getInstallationSettingsUrl("42"));
    assert(
      gh.calls.every((call) => call.method === "GET" && call.path === "/app/installations/42"),
    );
  } finally {
    await gh.shutdown();
  }
  const offline = await makeApi(gh.base);
  await assertRejects(() => offline.getInstallationSettingsUrl("42"));
});

test("describeInstallation carries the settings URL from the same read, null when unnamed", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    // oxlint-disable-next-line no-explicit-any
    let account: any = { type: "Organization", login: "acme" };
    gh.set((method, path) => {
      if (method === "GET" && path === "/app/installations/42") {
        return new Response(JSON.stringify({ account }));
      }
      if (method === "GET" && path.startsWith("/installation/repositories")) {
        return new Response(JSON.stringify({ total_count: 0, repositories: [] }));
      }
      return null;
    });
    assertEquals(await api.describeInstallation("42"), {
      accountLogin: "acme",
      settingsUrl: `${gh.base}/organizations/acme/settings/installations/42`,
      repos: [],
    });
    account = { type: "Bot", login: "acme" };
    assertEquals((await api.describeInstallation("42")).settingsUrl, null);
    assertEquals(
      gh.calls.filter((c) => c.method === "GET" && c.path === "/app/installations/42").length,
      2,
      "one installation read per listing",
    );
    gh.set(() => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    const err = await assertRejects(() => api.describeInstallation("42"));
    assertStringIncludes((err as Error).message, "Not Found");
  } finally {
    await gh.shutdown();
  }
});

test("describeInstallation paginates the full repo listing", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method === "GET" && path === "/app/installations/42") {
        return new Response(JSON.stringify({ account: { login: "acme" } }));
      }
      if (method === "GET" && path.startsWith("/installation/repositories")) {
        const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
        const count = page === 1 ? 100 : 30;
        return new Response(JSON.stringify({
          total_count: 130,
          repositories: Array.from({ length: count }, (_, i) => ({
            full_name: `acme/repo-${(page - 1) * 100 + i}`,
            clone_url: `https://github.example/acme/repo-${(page - 1) * 100 + i}.git`,
            default_branch: "main",
            private: true,
          })),
        }));
      }
      return null;
    });
    const described = await api.describeInstallation("42");
    assertEquals(described.accountLogin, "acme");
    assertEquals(described.repos.length, 130);
    assertEquals(described.repos[129].fullName, "acme/repo-129");
    assert(described.repos[0].private);
  } finally {
    await gh.shutdown();
  }
});

test("checkPermission: role thresholds, definitive 404 denies, 5xx is unknown", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    let level: string | number = "write";
    let asks = 0;
    gh.set((_m, path) => {
      if (!path.includes("/collaborators/")) return null;
      asks++;
      if (typeof level === "number") {
        return new Response(JSON.stringify({ message: "boom" }), { status: level });
      }
      return new Response(JSON.stringify({ permission: level }));
    });

    assertEquals(await api.checkPermission(repo("acme/app"), "ada", "write"), "allowed");
    assertEquals(await api.checkPermission(repo("acme/app"), "ada", "admin"), "denied");
    level = "admin";
    assertEquals(await api.checkPermission(repo("acme/app"), "ada", "admin"), "allowed");
    level = "read";
    assertEquals(await api.checkPermission(repo("acme/app"), "ada", "write"), "denied");
    level = 404; // not a collaborator: the one DEFINITIVE no
    assertEquals(await api.checkPermission(repo("acme/app"), "ada", "write"), "denied");
    level = 403; // suspended installation / rate limit: unanswerable, never a revocation
    assertEquals(await api.checkPermission(repo("acme/app"), "ada", "write"), "unknown");
    level = 500;
    assertEquals(await api.checkPermission(repo("acme/app"), "ada", "write"), "unknown");

    // A NULL subject is "there is no identity". GitHub has no permissionless rung — both
    // tiers are a grant somebody made to a named account — so it is a definitive "denied",
    // and it is answered WITHOUT asking GitHub: interpolated into the collaborators URL, a
    // null would ask about a user literally named "null" and take that answer.
    level = "admin";
    const before = asks;
    assertEquals(await api.checkPermission(repo("acme/app"), null, "write"), "denied");
    assertEquals(await api.checkPermission(repo("acme/app"), null, "admin"), "denied");
    assertEquals(asks, before, "a subjectless check asks GitHub nothing");
  } finally {
    await gh.shutdown();
  }
});

test("checkOrgMembership: 204 is a member, 404 is not, anything else is unknown", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    let accountType = "Organization";
    let status = 204;
    gh.set((_m, path) => {
      if (path === "/app/installations/42") {
        return new Response(JSON.stringify({ account: { login: "acme", type: accountType } }));
      }
      if (path.startsWith("/orgs/acme/members/")) {
        if (status === 302) {
          return new Response(null, {
            status,
            headers: { location: "/orgs/acme/public_members/ada" },
          });
        }
        return new Response(status === 204 ? null : JSON.stringify({ message: "no" }), { status });
      }
      if (path.startsWith("/orgs/acme/public_members/")) {
        return new Response(JSON.stringify({ message: "not public" }), { status: 404 });
      }
      return null;
    });

    assertEquals(await api.checkOrgMembership("42", "ada"), "member");
    status = 404; // definitively: not a member
    assertEquals(await api.checkOrgMembership("42", "ada"), "not-member");
    status = 403; // the App cannot see membership: unanswerable, never a refusal
    assertEquals(await api.checkOrgMembership("42", "ada"), "unknown");
    status = 302; // private membership the App may not see: the redirect is not followed
    assertEquals(await api.checkOrgMembership("42", "ada"), "unknown");
    status = 500;
    assertEquals(await api.checkOrgMembership("42", "ada"), "unknown");

    // A personal-account installation has no org to ask: the account is the one member.
    accountType = "User";
    const before = gh.calls.length;
    assertEquals(await api.checkOrgMembership("42", "ACME"), "member");
    assertEquals(await api.checkOrgMembership("42", "grace"), "not-member");
    assert(!gh.calls.slice(before).some((c) => c.path.startsWith("/orgs/")));

    // An installation that does not resolve is unanswerable too.
    assertEquals(await api.checkOrgMembership("99", "ada"), "unknown");
  } finally {
    await gh.shutdown();
  }
});

test("exchangeOAuthCode without the email permission still resolves the login", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method === "POST" && path === "/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "gho_user" }));
      }
      if (path === "/user") return new Response(JSON.stringify({ id: 7, login: "grace" }));
      if (path === "/user/emails") {
        return new Response(JSON.stringify({ message: "Resource not accessible" }), {
          status: 403,
        });
      }
      return null;
    });
    assertEquals(await api.exchangeOAuthCode("good"), {
      accountId: "7",
      login: "grace",
      name: null,
      verifiedEmails: [],
      accessToken: "gho_user",
    });
  } finally {
    await gh.shutdown();
  }
});

test("openPullRequest: creates, adopts on 422-already-exists, names terminality", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    const params = { title: "t", body: "b", head: "ryph/ada/r-1", base: "main", draft: false };

    let mode: "create" | "exists" | "elsewhere" | "hopeless" | "down" = "create";
    gh.set((method, path) => {
      if (method === "POST" && path === "/repos/acme/app/pulls") {
        if (mode === "create") {
          return new Response(
            JSON.stringify({ number: 7, html_url: "https://gh/acme/app/pull/7" }),
            { status: 201 },
          );
        }
        if (mode === "down") {
          return new Response(JSON.stringify({ message: "bad gateway" }), { status: 502 });
        }
        return new Response(
          JSON.stringify({ message: "Validation Failed: pull request already exists" }),
          { status: 422 },
        );
      }
      if (method === "GET" && path.startsWith("/repos/acme/app/pulls?")) {
        return new Response(JSON.stringify(
          mode === "exists"
            ? [
              { number: 4, html_url: "https://gh/acme/app/pull/4", base: { ref: "release" } },
              { number: 3, html_url: "https://gh/acme/app/pull/3", base: { ref: "main" } },
            ]
            : mode === "elsewhere"
            ? [{ number: 4, html_url: "https://gh/acme/app/pull/4", base: { ref: "release" } }]
            : [],
        ));
      }
      return null;
    });

    assertEquals(await api.openPullRequest(repo("acme/app"), params), {
      number: 7,
      url: "https://gh/acme/app/pull/7",
    });

    // The retry-after-lost-response case: 422 → find the open PR for this head → adopt — only
    // the one into the same base.
    mode = "exists";
    assertEquals((await api.openPullRequest(repo("acme/app"), params)).number, 3);
    // One with this head into another base is not this call's to adopt: terminal.
    mode = "elsewhere";
    const elsewhere = await assertRejects(
      () => api.openPullRequest(repo("acme/app"), params),
      ForgeApiError,
    );
    assert(elsewhere.terminal);

    // A genuine 422 with nothing to adopt (e.g. no commits between refs): terminal.
    mode = "hopeless";
    const hopeless = await assertRejects(
      () => api.openPullRequest(repo("acme/app"), params),
      ForgeApiError,
    );
    assert(hopeless.terminal);

    // GitHub down: retryable.
    mode = "down";
    const down = await assertRejects(
      () => api.openPullRequest(repo("acme/app"), params),
      ForgeApiError,
    );
    assert(!down.terminal);
  } finally {
    await gh.shutdown();
  }
});

test("fetchThread reads an issue and its comments, in order", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method === "GET" && path === "/repos/acme/app/issues/7") {
        return new Response(JSON.stringify({
          title: "The scheduler test is flaky",
          body: "One run in five.",
          state: "open",
          user: { login: "grace" },
          created_at: "2026-01-01T00:00:00Z",
        }));
      }
      if (method === "GET" && path.startsWith("/repos/acme/app/issues/7/comments")) {
        const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
        if (page > 1) return new Response(JSON.stringify([]));
        return new Response(JSON.stringify([
          { user: { login: "linus" }, body: "Only on CI.", created_at: "2026-01-02T00:00:00Z" },
        ]));
      }
      return null;
    });

    const thread = await api.fetchThread(repo("acme/app"), { kind: "issue", ref: "7" });
    assertEquals(thread.title, "The scheduler test is flaky");
    assertEquals(thread.body, "One run in five.");
    assertEquals(thread.authorLogin, "grace");
    assertEquals(thread.state, "open");
    assertEquals(thread.truncated, false);
    assertEquals(thread.entries, [{
      kind: "comment",
      authorLogin: "linus",
      body: "Only on CI.",
      createdAt: "2026-01-02T00:00:00Z",
      state: null,
      location: null,
    }]);
    // An issue is not asked the PR-only questions.
    assert(!gh.calls.some((c) => c.path.includes("/pulls/")));
  } finally {
    await gh.shutdown();
  }
});

/** GitHub's GET /pulls/:n, trimmed to what the adapter reads: an open, same-repo branch. */
const pullJson = (over: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({
    number: 9,
    html_url: "https://github.com/acme/app/pull/9",
    state: "open",
    merged: false,
    head: { ref: "feat/scheduler", sha: "b".repeat(40), repo: { full_name: "acme/app" } },
    base: { ref: "main", repo: { default_branch: "main" } },
    ...over,
  }));

test("fetchThread merges a PR's conversation, reviews and inline remarks chronologically", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method !== "GET") return null;
      if (path === "/repos/acme/app/issues/9") {
        return new Response(JSON.stringify({
          title: "Rework the scheduler",
          body: "Draft.",
          state: "open",
          user: { login: "ada" },
          created_at: "2026-01-01T00:00:00Z",
        }));
      }
      if (path.startsWith("/repos/acme/app/issues/9/comments")) {
        return new Response(JSON.stringify(
          path.includes("page=1")
            ? [{ user: { login: "ada" }, body: "Ready.", created_at: "2026-01-04T00:00:00Z" }]
            : [],
        ));
      }
      if (path === "/repos/acme/app/pulls/9") return pullJson();
      if (path.startsWith("/repos/acme/app/pulls/9/reviews")) {
        return new Response(JSON.stringify(
          path.includes("page=1")
            ? [
              {
                user: { login: "grace" },
                body: "Unbounded retry loop.",
                state: "CHANGES_REQUESTED",
                submitted_at: "2026-01-02T00:00:00Z",
              },
              // A draft nobody has submitted is not something anyone said yet.
              { user: { login: "linus" }, body: "wip", state: "PENDING", submitted_at: null },
            ]
            : [],
        ));
      }
      if (path.startsWith("/repos/acme/app/pulls/9/comments")) {
        return new Response(JSON.stringify(
          path.includes("page=1")
            ? [{
              user: { login: "grace" },
              body: "This never terminates.",
              path: "src/scheduler.ts",
              line: 88,
              created_at: "2026-01-03T00:00:00Z",
            }]
            : [],
        ));
      }
      return null;
    });

    const thread = await api.fetchThread(repo("acme/app"), {
      kind: "change_request",
      ref: "9",
    });
    // Three listings, one conversation — back in the order things were said.
    assertEquals(thread.entries.map((e) => [e.kind, e.createdAt]), [
      ["review", "2026-01-02T00:00:00Z"],
      ["review_comment", "2026-01-03T00:00:00Z"],
      ["comment", "2026-01-04T00:00:00Z"],
    ]);
    assertEquals(thread.entries.at(0)?.state, "changes_requested");
    assertEquals(thread.entries.at(1)?.location, "src/scheduler.ts:88");
    assert(!thread.entries.some((e) => e.body === "wip"), "an unsubmitted draft is not said yet");
    // And where its code lives — what a run working on this pull request checks out.
    assertEquals(thread.changeRequest?.headRef, "feat/scheduler");
    assertEquals(thread.changeRequest?.headRepoRef, "acme/app");
  } finally {
    await gh.shutdown();
  }
});

test("readChangeRequestState is one read of the pull request, and knows the App's own", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    let appReads = 0;
    gh.set((method, path) => {
      if (method !== "GET") return null;
      if (path === "/app") {
        appReads++;
        return new Response(JSON.stringify({ id: 999, slug: "acme-dev" }));
      }
      if (path === "/repos/acme/app/pulls/9") {
        return pullJson({ user: { login: "ada", type: "User" } });
      }
      // Opened by this App: its bot, which GitHub spells `<slug>[bot]`.
      if (path === "/repos/acme/app/pulls/10") {
        return pullJson({
          user: { login: "acme-dev[bot]", type: "Bot" },
          state: "closed",
          merged: true,
          base: { ref: "release" },
        });
      }
      // Another App's bot is not us.
      if (path === "/repos/acme/app/pulls/11") {
        return pullJson({ user: { login: "dependabot[bot]", type: "Bot" } });
      }
      if (path === "/repos/acme/app/pulls/12") return new Response("{}", { status: 502 });
      if (path === "/repos/acme/app/pulls/13") return pullJson({ head: {} });
      return null;
    });

    assertEquals(await api.readChangeRequestState(repo("acme/app"), "9"), {
      ref: "9",
      state: "open",
      merged: false,
      headSha: "b".repeat(40),
      authorHeadSha: "b".repeat(40),
      baseRef: "main",
      openedByUs: false,
      mergedHeads: [],
    });
    const ours = await api.readChangeRequestState(repo("acme/app"), "10");
    assertEquals(
      [ours?.state, ours?.merged, ours?.baseRef, ours?.openedByUs],
      ["closed", true, "release", true],
    );
    // What merged is the head GitHub froze at the merge.
    assertEquals(ours?.mergedHeads, [ours?.headSha]);
    assertEquals((await api.readChangeRequestState(repo("acme/app"), "11"))?.openedByUs, false);
    // The App's slug is read once, not per pull request.
    assertEquals(appReads, 1);
    const pullReads = gh.calls.filter((c) => c.path.startsWith("/repos/acme/app/pulls/"));
    assertEquals(pullReads.length, 3, "one GET per pull request");

    // Gone is an answer; a bad minute or a malformed answer is not.
    assertEquals(await api.readChangeRequestState(repo("acme/app"), "404"), null);
    for (const ref of ["12", "13"]) {
      const err = await assertRejects(
        () => api.readChangeRequestState(repo("acme/app"), ref),
        ForgeApiError,
      );
      assertEquals(err.terminal, false, ref);
    }
  } finally {
    await gh.shutdown();
  }
});

test("readChangeRequestState: a failed read of the App is not kept, the next one asks again", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    let appReads = 0;
    gh.set((method, path) => {
      if (method !== "GET") return null;
      if (path === "/app") {
        appReads++;
        return appReads === 1
          ? new Response("{}", { status: 502 })
          : new Response(JSON.stringify({ id: 999, slug: "acme-dev" }));
      }
      if (path === "/repos/acme/app/pulls/10") {
        return pullJson({ user: { login: "acme-dev[bot]", type: "Bot" } });
      }
      return null;
    });

    // A Bot author needs the App's login, and the read of it fails: a retry, not an answer.
    const err = await assertRejects(
      () => api.readChangeRequestState(repo("acme/app"), "10"),
      ForgeApiError,
    );
    assertEquals(err.terminal, false);
    assertEquals((await api.readChangeRequestState(repo("acme/app"), "10"))?.openedByUs, true);
    assertEquals(appReads, 2);
  } finally {
    await gh.shutdown();
  }
});

test("describeChangeRequest names where the head lives — here, a fork, a deleted fork, or gone — and never guesses", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method !== "GET") return null;
      if (path === "/repos/acme/app/pulls/9") return pullJson();
      if (path === "/repos/acme/app/pulls/10") {
        return pullJson({
          maintainer_can_modify: true,
          head: {
            ref: "patch-1",
            sha: "c".repeat(40),
            repo: {
              full_name: "stranger/app",
              clone_url: "https://github.com/stranger/app.git",
              default_branch: "trunk",
            },
          },
        });
      }
      if (path === "/repos/acme/app/pulls/11") {
        return pullJson({
          state: "closed",
          merged: true,
          head: { ref: "old", sha: "d".repeat(40), repo: null },
        });
      }
      if (path === "/repos/acme/app/pulls/12") return new Response("{}", { status: 502 });
      // A 200 with the authorizing fields missing: not open by default, not unmerged by
      // default, not in any repo by default.
      if (path === "/repos/acme/app/pulls/13") {
        return pullJson({ state: undefined, merged: "no", base: {} });
      }
      return null;
    });

    assertEquals(await api.describeChangeRequest(repo("acme/app"), "9"), {
      ref: "9",
      url: "https://github.com/acme/app/pull/9",
      state: "open",
      merged: false,
      // Read off the same pull request object, for the history window; null where GitHub's
      // answer does not count them.
      commitCount: null,
      headRef: "feat/scheduler",
      headSha: "b".repeat(40),
      // A pull request's own head is its head: only its head branch moves it.
      authorHeadSha: "b".repeat(40),
      headRepoRef: "acme/app",
      headRepoUrl: null,
      headRepoDefaultBranch: null,
      // Only a plain true is the author's consent.
      maintainerCanModify: false,
      baseRef: "main",
      defaultBranch: "main",
    });
    // A fork: where it is cloned from, its own default branch, and whether its author lets
    // maintainers push — what a push onto it is held to.
    const fork = await api.describeChangeRequest(repo("acme/app"), "10");
    assertEquals(
      [fork.headRepoRef, fork.headRepoUrl, fork.headRepoDefaultBranch, fork.maintainerCanModify],
      ["stranger/app", "https://github.com/stranger/app.git", "trunk", true],
    );
    // A deleted fork is null, never mistaken for "the same repo".
    const merged = await api.describeChangeRequest(repo("acme/app"), "11");
    assertEquals([merged.merged, merged.headRepoRef], [true, null]);

    const gone = await assertRejects(
      () => api.describeChangeRequest(repo("acme/app"), "404"),
      ForgeApiError,
    );
    assertEquals(gone.terminal, true);
    const blip = await assertRejects(
      () => api.describeChangeRequest(repo("acme/app"), "12"),
      ForgeApiError,
    );
    assertEquals(blip.terminal, false);
    // Malformed is retried, never read as "open, unmerged, here".
    const malformed = await assertRejects(
      () => api.describeChangeRequest(repo("acme/app"), "13"),
      ForgeApiError,
      "missing fields",
    );
    assertEquals(malformed.terminal, false);
  } finally {
    await gh.shutdown();
  }
});

test("fetchThread: a deleted thread is terminal, a bad minute is not", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);

    // Nothing is registered, so the fake answers 404: the thread is gone for good.
    const gone = await assertRejects(
      () => api.fetchThread(repo("acme/app"), { kind: "issue", ref: "7" }),
      ForgeApiError,
    );
    assertEquals(gone.terminal, true);

    gh.set((method, path) =>
      method === "GET" && path === "/repos/acme/app/issues/7"
        ? new Response(JSON.stringify({ message: "server error" }), { status: 500 })
        : null
    );
    const blip = await assertRejects(
      () => api.fetchThread(repo("acme/app"), { kind: "issue", ref: "7" }),
      ForgeApiError,
    );
    assertEquals(blip.terminal, false);
  } finally {
    await gh.shutdown();
  }
});

test("fetchThread reports the ceiling rather than pretending it read everything", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method !== "GET") return null;
      if (path === "/repos/acme/app/issues/7") {
        return new Response(JSON.stringify({
          title: "A very long argument",
          body: "",
          state: "open",
          user: { login: "grace" },
          created_at: "2026-01-01T00:00:00Z",
        }));
      }
      if (path.startsWith("/repos/acme/app/issues/7/comments")) {
        // Every page full: the listing never ends, so the ceiling has to.
        return new Response(JSON.stringify(
          Array.from({ length: 100 }, (_, i) => ({
            user: { login: "someone" },
            body: `#${i}`,
            created_at: "2026-01-02T00:00:00Z",
          })),
        ));
      }
      return null;
    });

    const thread = await api.fetchThread(repo("acme/app"), { kind: "issue", ref: "7" });
    assertEquals(thread.entries.length, 500); // five pages, the declared ceiling
    assertEquals(thread.truncated, true);
  } finally {
    await gh.shutdown();
  }
});

test("fetchThread: a thread deleted mid-listing is terminal too, not a forever-retry", async () => {
  // The head request succeeds and the comments request 404s — the thread went away between
  // the two. Calling that retryable would 503 forever over something no redelivery finds.
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) =>
      method === "GET" && path === "/repos/acme/app/issues/7"
        ? new Response(JSON.stringify({
          title: "Briefly alive",
          body: "",
          state: "open",
          user: { login: "grace" },
          created_at: "2026-01-01T00:00:00Z",
        }))
        : null // everything else, the comments listing included, is the fake's 404
    );

    const err = await assertRejects(
      () => api.fetchThread(repo("acme/app"), { kind: "issue", ref: "7" }),
      ForgeApiError,
    );
    assertEquals(err.terminal, true);
  } finally {
    await gh.shutdown();
  }
});

test("fetchThread: an outdated inline remark keeps its anchor via original_line", async () => {
  // GitHub nulls `line` once the diff moves under a remark but keeps `original_line`. An
  // outdated remark is exactly the kind an agent gets sent to go address.
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method !== "GET") return null;
      if (path === "/repos/acme/app/issues/5") {
        return new Response(JSON.stringify({
          title: "Rework",
          body: "",
          state: "open",
          user: { login: "ada" },
          created_at: "2026-01-01T00:00:00Z",
        }));
      }
      if (path === "/repos/acme/app/pulls/5") return pullJson({ number: 5 });
      if (path.startsWith("/repos/acme/app/pulls/5/comments")) {
        return new Response(JSON.stringify(
          path.includes("page=1")
            ? [{
              user: { login: "grace" },
              body: "Still wrong.",
              path: "src/a.ts",
              line: null,
              original_line: 42,
              created_at: "2026-01-02T00:00:00Z",
            }]
            : [],
        ));
      }
      return new Response(JSON.stringify([])); // the other two listings are empty
    });

    const thread = await api.fetchThread(repo("acme/app"), {
      kind: "change_request",
      ref: "5",
    });
    assertEquals(thread.entries.at(0)?.location, "src/a.ts:42");
  } finally {
    await gh.shutdown();
  }
});

test("fetchThread bounds the bytes it holds, not only the number of comments", async () => {
  // The page ceiling alone lets one listing of maximum-length comments run to tens of
  // megabytes — held here, serialized to the orchestrator, and parsed again there.
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method !== "GET") return null;
      if (path === "/repos/acme/app/issues/7") {
        return new Response(JSON.stringify({
          title: "A great deal of prose",
          body: "",
          state: "open",
          user: { login: "grace" },
          created_at: "2026-01-01T00:00:00Z",
        }));
      }
      return new Response(JSON.stringify(
        Array.from({ length: 100 }, () => ({
          user: { login: "someone" },
          body: "x".repeat(60_000),
          created_at: "2026-01-02T00:00:00Z",
        })),
      ));
    });

    const thread = await api.fetchThread(repo("acme/app"), { kind: "issue", ref: "7" });
    assertEquals(thread.truncated, true);
    // Weighed per entry, not per page: a page carries 100 of them, so a budget checked at
    // the page boundary is a budget that can be overshot by a page — about 1.6M characters.
    const held = thread.entries.reduce((n, e) => n + e.body.length, 0);
    assert(held <= 200_000, `held ${held} characters`);
    // It stopped on the byte budget, well before the five-page ceiling.
    assert(thread.entries.length < 500, `kept ${thread.entries.length} entries`);
  } finally {
    await gh.shutdown();
  }
});

test("fetchThread reads a PR's three listings concurrently, not one after another", async () => {
  // Sequentially a long PR is sixteen round trips deep behind one caller-side deadline, and
  // a deadline a real thread cannot meet fails every delivery AND every retry identically.
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    let inFlight = 0;
    let peak = 0;
    // Each listing is held open until all three are, so the overlap does not depend on how fast
    // a loaded machine gets the next request out. A sequential read never gets there and is let
    // go after a while, with a peak of one.
    const held: Array<() => void> = [];
    const slow = () =>
      new Promise<Response>((resolve) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        const release = () => {
          clearTimeout(timer);
          inFlight--;
          resolve(new Response(JSON.stringify([])));
        };
        const timer = setTimeout(() => {
          held.splice(held.indexOf(release), 1);
          release();
        }, 2_000);
        held.push(release);
        if (held.length === 3) held.splice(0).forEach((r) => r());
      });
    gh.set((method, path) => {
      if (method !== "GET") return null;
      if (path === "/repos/acme/app/issues/9") {
        return new Response(JSON.stringify({
          title: "Rework",
          body: "",
          state: "open",
          user: { login: "ada" },
          created_at: "2026-01-01T00:00:00Z",
        }));
      }
      if (path === "/repos/acme/app/pulls/9") return pullJson();
      if (path.includes("/issues/9/comments") || path.includes("/pulls/9/")) return slow();
      return null;
    });

    await api.fetchThread(repo("acme/app"), { kind: "change_request", ref: "9" });
    assertEquals(peak, 3, "the three listings were in flight together");
  } finally {
    await gh.shutdown();
  }
});

test("fetchThread: a truncated listing cuts the others to the same horizon", async () => {
  // Three listings hit their ceilings independently. Merging "every review" with "the first
  // N comments" shows a late review while dropping the comments around it — under a note
  // that promises the thread's BEGINNING. What survives has to be a real prefix.
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method !== "GET") return null;
      if (path === "/repos/acme/app/issues/9") {
        return new Response(JSON.stringify({
          title: "Long argument",
          body: "",
          state: "open",
          user: { login: "ada" },
          created_at: "2026-01-01T00:00:00Z",
        }));
      }
      // The conversation never ends: every page full, so it truncates at the ceiling. Its
      // last comment is dated in January.
      if (path.startsWith("/repos/acme/app/issues/9/comments")) {
        return new Response(JSON.stringify(
          Array.from({ length: 100 }, (_, i) => ({
            user: { login: "someone" },
            body: `#${i}`,
            created_at: "2026-01-02T00:00:00Z",
          })),
        ));
      }
      if (path === "/repos/acme/app/pulls/9") return pullJson();
      // The reviews listing is short and complete — including one from MUCH later.
      if (path.startsWith("/repos/acme/app/pulls/9/reviews")) {
        return new Response(JSON.stringify(
          path.includes("page=1")
            ? [{
              user: { login: "grace" },
              body: "A review from the far future.",
              state: "COMMENTED",
              submitted_at: "2026-06-01T00:00:00Z",
            }]
            : [],
        ));
      }
      return new Response(JSON.stringify([]));
    });

    const thread = await api.fetchThread(repo("acme/app"), {
      kind: "change_request",
      ref: "9",
    });
    assertEquals(thread.truncated, true);
    assert(
      !thread.entries.some((e) => e.body === "A review from the far future."),
      "a review past the horizon is not a prefix of the thread",
    );
    assert(thread.entries.every((e) => e.createdAt <= "2026-01-02T00:00:00Z"));
  } finally {
    await gh.shutdown();
  }
});

test("exchangeOAuthCode trades the code for a login, secret never in the query", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path, body) => {
      if (method === "POST" && path === "/login/oauth/access_token") {
        const b = body as Record<string, string>;
        if (b.code === "good" && b.client_secret === "shhh") {
          return new Response(JSON.stringify({ access_token: "gho_user" }));
        }
        return new Response(JSON.stringify({ error_description: "bad code" }));
      }
      if (method === "GET" && path === "/user") {
        return new Response(JSON.stringify({ id: 12345, login: "ada-lovelace", name: "Ada" }));
      }
      if (method === "GET" && path === "/user/emails") {
        return new Response(JSON.stringify([
          { email: "ada@example.com", verified: true, primary: true },
          { email: "old@example.com", verified: false, primary: false },
        ]));
      }
      return null;
    });
    assertEquals(await api.exchangeOAuthCode("good"), {
      accountId: "12345",
      login: "ada-lovelace",
      name: "Ada",
      verifiedEmails: ["ada@example.com"],
      accessToken: "gho_user",
    });
    await assertRejects(() => api.exchangeOAuthCode("bad"), Error, "bad code");
  } finally {
    await gh.shutdown();
  }
});

test("a tool call acts with a token narrowed to one repo and one permission", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) =>
      method === "POST" && path === "/repos/acme/app/issues"
        ? new Response(
          JSON.stringify({ number: 5, html_url: "https://github.test/acme/app/issues/5" }),
          { status: 201 },
        )
        : null
    );
    const made = await api.createIssue(repo("acme/app"), { title: "t", body: "b", labels: [] });
    assertEquals(made, { ref: "5", url: "https://github.test/acme/app/issues/5" });
    const mint = gh.calls.find((c) => c.path.endsWith("/access_tokens"));
    assertEquals(mint?.body, { repositories: ["app"], permissions: { issues: "write" } });
    assertEquals(gh.calls.find((c) => c.path === "/repos/acme/app/issues")?.body, {
      title: "t",
      body: "b",
    });
  } finally {
    await gh.shutdown();
  }
});

test("a write's 5xx and rate limit are not terminal; a 422 is", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    let status = 502;
    let text = "bad gateway";
    gh.set((method, path) =>
      method === "POST" && path.startsWith("/repos/acme/app/issues/3/comments")
        ? new Response(JSON.stringify({ message: text }), { status })
        : null
    );
    const attempt = () =>
      api.createComment(repo("acme/app"), { kind: "change_request", ref: "3" }, "hi");
    let err = await assertRejects(attempt, ForgeApiError);
    assertEquals(err.terminal, false);
    status = 403;
    text = "You have exceeded a secondary rate limit";
    err = await assertRejects(attempt, ForgeApiError);
    assertEquals(err.terminal, false);
    status = 422;
    text = "Validation Failed";
    err = await assertRejects(attempt, ForgeApiError);
    assertEquals(err.terminal, true);
    // A pull request's conversation is written with the pull request permission.
    const mint = gh.calls.find((c) => c.path.endsWith("/access_tokens"));
    assertEquals(mint?.body, { repositories: ["app"], permissions: { pull_requests: "write" } });
  } finally {
    await gh.shutdown();
  }
});

test("a rate limit says when it lifts, and says nothing when GitHub did not", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    let headers: Record<string, string> = { "retry-after": "120" };
    gh.set((method, path) =>
      method === "POST" && path.startsWith("/repos/acme/app/issues/3/comments")
        ? new Response(
          JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
          { status: 403, headers },
        )
        : null
    );
    const attempt = () => api.createComment(repo("acme/app"), { kind: "issue", ref: "3" }, "hi");

    // A secondary limit dates itself in seconds.
    let err = await assertRejects(attempt, ForgeApiError);
    assertEquals(err.terminal, false);
    assertEquals(err.retryAfterMs, 120_000);
    assert(err.message.includes("about 2 minutes"), err.message);

    // The primary one dates itself as an epoch second.
    headers = { "x-ratelimit-reset": String(Math.floor(Date.now() / 1_000) + 600) };
    err = await assertRejects(attempt, ForgeApiError);
    assert(err.retryAfterMs !== null && err.retryAfterMs > 8 * 60_000, `${err.retryAfterMs}`);

    // No header, no claim: a wait nobody stated is never invented.
    headers = {};
    err = await assertRejects(attempt, ForgeApiError);
    assertEquals(err.retryAfterMs, null);
    assertEquals(err.terminal, false);
  } finally {
    await gh.shutdown();
  }
});

test("findMarkedWrite finds the write carrying the marker, and only that one", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method !== "GET" || !path.startsWith("/repos/acme/app/issues/3/comments")) return null;
      return new Response(JSON.stringify([
        { body: "unrelated <!-- ryph-action:fa-0 -->", html_url: "https://github.test/c/1" },
        { body: "mine <!-- ryph-action:fa-9 -->", html_url: "https://github.test/c/2" },
      ]));
    });
    const since = "2026-01-05T00:00:00.000Z";
    assertEquals(
      await api.findMarkedWrite(
        repo("acme/app"),
        { kind: "comment", threadRef: "3" },
        "<!-- ryph-action:fa-9 -->",
        since,
      ),
      { url: "https://github.test/c/2", createdRef: null },
    );
    assertEquals(
      await api.findMarkedWrite(
        repo("acme/app"),
        { kind: "comment", threadRef: "3" },
        "<!-- ryph-action:fa-5 -->",
        since,
      ),
      null,
    );
    assert(gh.calls.some((c) => c.path.includes(`since=${encodeURIComponent(since)}`)));
  } finally {
    await gh.shutdown();
  }
});

test("createReview posts one comment-only review at the live head, remarks and all", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method === "GET" && path === "/repos/acme/app/pulls/9") return pullJson();
      if (method === "POST" && path === "/repos/acme/app/pulls/9/reviews") {
        return new Response(JSON.stringify({ html_url: "https://github.test/pull/9#review-1" }));
      }
      return null;
    });
    // The head the remarks were checked against rides the call, and is what they post against —
    // the pull request is NOT re-read, so a push landing since cannot move the anchor.
    const made = await api.createReview(repo("acme/app"), "9", {
      body: "Two notes.",
      comments: [{ path: "src/a.ts", line: 3, side: "RIGHT", body: "Off by one." }],
      headSha: "c".repeat(40),
    });
    assertEquals(made.url, "https://github.test/pull/9#review-1");
    const post = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/reviews"));
    assertEquals(post?.body, {
      commit_id: "c".repeat(40),
      body: "Two notes.",
      event: "COMMENT",
      comments: [{ path: "src/a.ts", line: 3, side: "RIGHT", body: "Off by one." }],
    });
    assertEquals(
      gh.calls.filter((c) => c.method === "GET" && c.path === "/repos/acme/app/pulls/9").length,
      0,
    );

    // A review that checked nothing has no head to carry, so the adapter reads the live one.
    await api.createReview(repo("acme/app"), "9", {
      body: "Looks right.",
      comments: [],
      headSha: null,
    });
    const second = gh.calls.filter((c) => c.method === "POST" && c.path.endsWith("/reviews")).at(
      -1,
    );
    assertEquals((second?.body as { commit_id: string }).commit_id, "b".repeat(40));
  } finally {
    await gh.shutdown();
  }
});

test("listChangeRequestPatches pages to the end and keeps a missing patch as null", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      // The diff is read at a head, so the listing reads the pull request first.
      if (method === "GET" && path === "/repos/acme/app/pulls/9") return pullJson();
      if (method !== "GET" || !path.startsWith("/repos/acme/app/pulls/9/files")) return null;
      const page = Number(new URL(`http://x${path}`).searchParams.get("page"));
      const files = page === 1
        ? Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts`, patch: "@@ -1 +1 @@" }))
        : [{ filename: "logo.png" }];
      return new Response(JSON.stringify(files));
    });
    const listed = await api.listChangeRequestPatches(repo("acme/app"), "9");
    assertEquals(listed.headSha, "b".repeat(40));
    assertEquals(listed.complete, true);
    assertEquals(listed.files.length, 101);
    assertEquals(listed.files.at(-1), { path: "logo.png", patch: null });
  } finally {
    await gh.shutdown();
  }
});

test("findMarkedWrite looks for a review through the pull request's reviews, to the end", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method !== "GET" || !path.startsWith("/repos/acme/app/pulls/9/reviews")) return null;
      const page = Number(new URL(`http://x${path}`).searchParams.get("page"));
      // Oldest first: the review just made is on the last page.
      if (page <= 4) {
        return new Response(JSON.stringify(
          Array.from({ length: 100 }, (_, i) => ({ body: `old ${i}`, html_url: "https://x/old" })),
        ));
      }
      return new Response(JSON.stringify([
        { body: "mine <!-- ryph-action:fa-9 -->", html_url: "https://github.test/review/9" },
      ]));
    });
    assertEquals(
      await api.findMarkedWrite(
        repo("acme/app"),
        { kind: "review", threadRef: "9" },
        "<!-- ryph-action:fa-9 -->",
        "2026-01-05T00:00:00.000Z",
      ),
      { url: "https://github.test/review/9", createdRef: null },
    );
  } finally {
    await gh.shutdown();
  }
});

test("repoVisibility reads an installation's repos under one token, and never defaults", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method !== "GET") return null;
      if (path === "/repos/acme/app") return new Response(JSON.stringify({ private: true }));
      if (path === "/repos/acme/api") return new Response(JSON.stringify({ private: false }));
      if (path === "/repos/acme/odd") return new Response(JSON.stringify({ name: "odd" }));
      return null;
    });
    const seen = await api.repoVisibility("42", ["acme/app", "acme/api"]);
    // One switch for the whole repo: as private to write on as to read.
    assertEquals([...seen], [
      ["acme/app", wholeRepoVisibility(true)],
      ["acme/api", wholeRepoVisibility(false)],
    ]);
    const mints = gh.calls.filter((c) => c.path.endsWith("/access_tokens")).map((c) => c.body);
    assertEquals(mints, [{ repositories: ["app", "api"], permissions: { metadata: "read" } }]);
    // A 200 without `private` is not a public repo: it is no answer at all.
    const err = await assertRejects(() => api.repoVisibility("42", ["acme/odd"]), ForgeApiError);
    assertEquals(err.terminal, false);
  } finally {
    await gh.shutdown();
  }
});

test("repoVisibility answers a whole grant from one listing, falling back per repo", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method !== "GET") return null;
      if (path.startsWith("/installation/repositories")) {
        return new Response(JSON.stringify({
          repositories: [
            { full_name: "acme/app", private: true },
            { full_name: "ACME/api", private: false },
          ],
        }));
      }
      if (path === "/repos/acme/infra") return new Response(JSON.stringify({ private: true }));
      return null;
    });
    const seen = await api.repoVisibility("42", ["acme/app", "acme/api", "acme/infra"]);
    assertEquals([...seen].map(([r, v]) => [r, v.source === "members"]), [
      ["acme/app", true],
      ["acme/api", false],
      ["acme/infra", true],
    ]);
    const reads = gh.calls.filter((c) => c.method === "GET" && !c.path.includes("access_tokens"));
    // One listing for the two it named, one read for the one it did not.
    assertEquals(reads.map((c) => c.path.split("?")[0]), [
      "/installation/repositories",
      "/repos/acme/infra",
    ]);
  } finally {
    await gh.shutdown();
  }
});

test("repoLabels walks ten pages and says when the listing was cut short", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    const full = Array.from({ length: 100 }, (_, i) => ({ name: `l${i}` }));
    gh.set((method, path) => {
      if (method !== "GET" || !path.startsWith("/repos/acme/app/labels")) return null;
      return new Response(JSON.stringify(full));
    });
    const cut = await api.repoLabels(repo("acme/app"));
    assertEquals(cut.complete, false);
    assertEquals(cut.labels.length, 1_000);
    assertEquals(gh.calls.filter((c) => c.path.startsWith("/repos/acme/app/labels")).length, 10);
    gh.set((method, path) => {
      if (method !== "GET" || !path.startsWith("/repos/acme/app/labels")) return null;
      return new Response(JSON.stringify([{ name: "bug" }]));
    });
    assertEquals(await api.repoLabels(repo("acme/app")), { labels: ["bug"], complete: true });
  } finally {
    await gh.shutdown();
  }
});

test("closeIssue closes with its reason; labels on a pull request ask for both permissions", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method === "PATCH" && path === "/repos/acme/app/issues/7") {
        return new Response(JSON.stringify({ html_url: "https://github.test/acme/app/issues/7" }));
      }
      if (method === "POST" && path === "/repos/acme/app/issues/9/labels") {
        return new Response(JSON.stringify([]));
      }
      return null;
    });
    assertEquals(await api.closeIssue(repo("acme/app"), "7", "not_planned"), {
      url: "https://github.test/acme/app/issues/7",
    });
    assertEquals(gh.calls.find((c) => c.method === "PATCH")?.body, {
      state: "closed",
      state_reason: "not_planned",
    });
    await api.addLabels(repo("acme/app"), { kind: "change_request", ref: "9" }, ["bug"]);
    const mints = gh.calls.filter((c) => c.path.endsWith("/access_tokens")).map((c) => c.body);
    assertEquals(mints, [
      { repositories: ["app"], permissions: { issues: "write" } },
      { repositories: ["app"], permissions: { issues: "write", pull_requests: "write" } },
    ]);
  } finally {
    await gh.shutdown();
  }
});

/** GitHub's GraphQL answer for a pull request's review threads — one page. */
const threadsJson = (
  nodes: Array<{ id: string; isResolved: boolean; root: number | string }>,
  pageInfo = { hasNextPage: false, endCursor: null as string | null },
) =>
  new Response(JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo,
            nodes: nodes.map((n) => ({
              id: n.id,
              isResolved: n.isResolved,
              comments: { nodes: [{ fullDatabaseId: n.root }] },
            })),
          },
        },
      },
    },
  }));

/** A pull request #9 with two review threads: 500 (answered by 502) open, 501 resolved. */
function reviewThreadPull(
  gh: Awaited<ReturnType<typeof fakeGithub>>,
  graphql: () => Response | null,
) {
  gh.set((method, path) => {
    if (method === "POST" && path === "/graphql") return graphql();
    if (method !== "GET") return null;
    if (path === "/repos/acme/app/issues/9") {
      return new Response(JSON.stringify({
        title: "Rework the scheduler",
        body: "",
        state: "open",
        user: { login: "ada" },
        created_at: "2026-01-01T00:00:00Z",
      }));
    }
    if (path === "/repos/acme/app/pulls/9") return pullJson();
    if (path.startsWith("/repos/acme/app/pulls/9/comments")) {
      return new Response(JSON.stringify(
        path.includes("page=1")
          ? [
            {
              id: 500,
              user: { login: "grace" },
              body: "This never terminates.",
              path: "src/scheduler.ts",
              line: 88,
              created_at: "2026-01-02T00:00:00Z",
            },
            {
              id: 501,
              user: { login: "grace" },
              body: "Typo.",
              path: "src/scheduler.ts",
              line: 12,
              created_at: "2026-01-03T00:00:00Z",
            },
            {
              id: 502,
              in_reply_to_id: 500,
              user: { login: "ada" },
              body: "On it.",
              path: "src/scheduler.ts",
              line: 88,
              created_at: "2026-01-04T00:00:00Z",
            },
          ]
          : [],
      ));
    }
    if (path.startsWith("/repos/acme/app/")) return new Response(JSON.stringify([]));
    return null;
  });
}

test("fetchThread names each inline remark's id, what it answers, and its thread's resolution", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    reviewThreadPull(gh, () =>
      threadsJson([
        { id: "PRRT_a", isResolved: false, root: "500" },
        { id: "PRRT_b", isResolved: true, root: "501" },
      ]));
    const thread = await api.fetchThread(repo("acme/app"), { kind: "change_request", ref: "9" });
    assertEquals(thread.entries.map((e) => e.remark), [
      { id: "500", replyTo: null, resolved: false },
      { id: "501", replyTo: null, resolved: true },
      // A reply carries its thread's resolution, found by the remark it answers.
      { id: "502", replyTo: "500", resolved: false },
    ]);
    const asked = gh.calls.find((c) => c.path === "/graphql")?.body as {
      variables: Record<string, unknown>;
    };
    assertEquals(asked.variables, { owner: "acme", name: "app", number: 9, after: null });
  } finally {
    await gh.shutdown();
  }
});

test("fetchThread: a GraphQL failure leaves resolution unknown, never the read failed", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    reviewThreadPull(gh, () => new Response(JSON.stringify({ message: "boom" }), { status: 502 }));
    const thread = await api.fetchThread(repo("acme/app"), { kind: "change_request", ref: "9" });
    assertEquals(thread.entries.map((e) => e.remark?.resolved), [null, null, null]);
    assertEquals(thread.entries.map((e) => e.remark?.id), ["500", "501", "502"]);
  } finally {
    await gh.shutdown();
  }
});

/** The review comments this fake knows, as GET /pulls/comments/:id answers them. */
function remarks(
  gh: Awaited<ReturnType<typeof fakeGithub>>,
  graphql: (body: unknown) => Response | null,
) {
  const byId: Record<string, Record<string, unknown>> = {
    "500": { id: 500, pull_request_url: "https://api.github.com/repos/acme/app/pulls/9" },
    "502": {
      id: 502,
      in_reply_to_id: 500,
      pull_request_url: "https://api.github.com/repos/acme/app/pulls/9",
    },
    "700": { id: 700, pull_request_url: "https://api.github.com/repos/acme/app/pulls/10" },
  };
  gh.set((method, path, body) => {
    const read = path.match(/^\/repos\/acme\/app\/pulls\/comments\/(\d+)$/);
    if (method === "GET" && read) {
      const found = byId[read[1]];
      return found === undefined ? null : new Response(JSON.stringify(found));
    }
    if (method === "POST" && /^\/repos\/acme\/app\/pulls\/9\/comments\/\d+\/replies$/.test(path)) {
      return new Response(
        JSON.stringify({ id: 900, html_url: "https://github.com/acme/app/pull/9#discussion_r900" }),
        { status: 201 },
      );
    }
    if (method === "POST" && path === "/graphql") return graphql(body);
    return null;
  });
}

test("replyToReviewComment follows a reply up to its thread's root, and posts there", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    remarks(gh, () => null);
    const made = await api.replyToReviewComment(repo("acme/app"), "9", "502", "Done.");
    assertEquals(made, { url: "https://github.com/acme/app/pull/9#discussion_r900" });
    const posted = gh.calls.filter((c) => c.method === "POST" && c.path.endsWith("/replies"));
    // GitHub refuses a reply to a reply; 502 answers 500, so 500 is where it goes.
    assertEquals(posted.map((c) => [c.path, c.body]), [
      ["/repos/acme/app/pulls/9/comments/500/replies", { body: "Done." }],
    ]);
  } finally {
    await gh.shutdown();
  }
});

test("replyToReviewComment refuses a remark on another pull request, or none, terminally", async () => {
  // The grant was checked against #9. A remark id is global to the repo, so one from #10 must
  // not turn a run scoped to #9 into a writer on #10.
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    remarks(gh, () => null);
    const elsewhere = await assertRejects(
      () => api.replyToReviewComment(repo("acme/app"), "9", "700", "Done."),
      ForgeApiError,
    );
    assert(elsewhere.terminal);
    assert(elsewhere.message.includes("it is on #10"), elsewhere.message);
    const missing = await assertRejects(
      () => api.replyToReviewComment(repo("acme/app"), "9", "404", "Done."),
      ForgeApiError,
    );
    assert(missing.terminal);
    assert(!gh.calls.some((c) => c.path.endsWith("/replies")), "nothing was posted");
  } finally {
    await gh.shutdown();
  }
});

test("resolveReviewThread resolves the thread its remark belongs to, once", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    let resolved = false;
    const mutations: unknown[] = [];
    remarks(gh, (body) => {
      const { query, variables } = body as { query: string; variables: unknown };
      if (query.includes("resolveReviewThread")) {
        mutations.push(variables);
        resolved = true;
        return new Response(JSON.stringify({
          data: { resolveReviewThread: { thread: { isResolved: true } } },
        }));
      }
      return threadsJson([
        { id: "PRRT_other", isResolved: false, root: 123 },
        { id: "PRRT_a", isResolved: resolved, root: 500 },
      ]);
    });
    // Named by a reply: its thread is the one 500 opens.
    await api.resolveReviewThread(repo("acme/app"), "9", "502");
    assertEquals(mutations, [{ thread: "PRRT_a" }]);
    // Already resolved: nothing more is written.
    await api.resolveReviewThread(repo("acme/app"), "9", "500");
    assertEquals(mutations.length, 1);
    // A remark from another pull request is refused before GraphQL is asked anything.
    const before = gh.calls.filter((c) => c.path === "/graphql").length;
    const elsewhere = await assertRejects(
      () => api.resolveReviewThread(repo("acme/app"), "9", "700"),
      ForgeApiError,
    );
    assert(elsewhere.terminal);
    assertEquals(gh.calls.filter((c) => c.path === "/graphql").length, before);
  } finally {
    await gh.shutdown();
  }
});

test("resolveReviewThread uses fullDatabaseId for comments beyond GraphQL Int range", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    const mutations: unknown[] = [];
    gh.set((method, path, body) => {
      if (method === "GET" && path === "/repos/acme/app/pulls/comments/4000000000") {
        return new Response(JSON.stringify({
          id: 4000000000,
          pull_request_url: `${gh.base}/repos/acme/app/pulls/9`,
        }));
      }
      if (method !== "POST" || path !== "/graphql") return null;
      const { query, variables } = body as { query: string; variables: unknown };
      if (query.includes("resolveReviewThread")) {
        mutations.push(variables);
        return new Response(JSON.stringify({
          data: { resolveReviewThread: { thread: { isResolved: true } } },
        }));
      }
      assert(query.includes("fullDatabaseId"));
      assert(!/\bdatabaseId\b/.test(query));
      return threadsJson([{ id: "PRRT_large", isResolved: false, root: "4000000000" }]);
    });
    await api.resolveReviewThread(repo("acme/app"), "9", "4000000000");
    assertEquals(mutations, [{ thread: "PRRT_large" }]);
  } finally {
    await gh.shutdown();
  }
});

test("resolveReviewThread: GraphQL's refusals map to terminal or not by their type", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    let answer: Response;
    remarks(gh, () => answer);
    answer = new Response(JSON.stringify({
      errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
    }));
    const forbidden = await assertRejects(
      () => api.resolveReviewThread(repo("acme/app"), "9", "500"),
      ForgeApiError,
    );
    assert(forbidden.terminal);
    assert(forbidden.message.includes("Resource not accessible by integration"));
    answer = new Response(JSON.stringify({ errors: [{ message: "Something went wrong" }] }));
    const blip = await assertRejects(
      () => api.resolveReviewThread(repo("acme/app"), "9", "500"),
      ForgeApiError,
    );
    assert(!blip.terminal);
    // No thread opened by 500 in a listing read to its end: there is none to resolve.
    answer = threadsJson([{ id: "PRRT_other", isResolved: false, root: 123 }]);
    const none = await assertRejects(
      () => api.resolveReviewThread(repo("acme/app"), "9", "500"),
      ForgeApiError,
    );
    assert(none.terminal);
  } finally {
    await gh.shutdown();
  }
});

test("a review comment's handle reacts through the pull request's comment endpoint", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method) => method === "POST" ? new Response("{}", { status: 201 }) : null);
    await api.addReaction(repo("acme/app"), "review:500", "eyes");
    await api.addReaction(repo("acme/app"), "31", "eyes");
    assertEquals(
      gh.calls.filter((c) => c.path.endsWith("/reactions")).map((c) => c.path),
      [
        "/repos/acme/app/pulls/comments/500/reactions",
        "/repos/acme/app/issues/comments/31/reactions",
      ],
    );
  } finally {
    await gh.shutdown();
  }
});

test("findMarkedWrite looks for a review reply among the pull request's review comments", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method !== "GET" || !path.startsWith("/repos/acme/app/pulls/9/comments?since=")) {
        return null;
      }
      return new Response(JSON.stringify([
        { body: "mine <!-- ryph-action:fa-9 -->", html_url: "https://github.test/r/1" },
      ]));
    });
    assertEquals(
      await api.findMarkedWrite(
        repo("acme/app"),
        { kind: "review_reply", threadRef: "9" },
        "<!-- ryph-action:fa-9 -->",
        "2026-01-05T00:00:00.000Z",
      ),
      { url: "https://github.test/r/1", createdRef: null },
    );
  } finally {
    await gh.shutdown();
  }
});

test("classifyBranch: a pull request head is the repo's own only when it lives in the repo", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method !== "GET") return null;
      if (path === "/repos/acme/app/pulls/9") return pullJson();
      if (path === "/repos/acme/app/pulls/10") {
        return pullJson({
          maintainer_can_modify: true,
          head: {
            ref: "patch-1",
            sha: "c".repeat(40),
            repo: {
              full_name: "stranger/app",
              clone_url: "https://github.com/stranger/app.git",
              default_branch: "trunk",
            },
          },
        });
      }
      if (path === "/repos/acme/app/pulls/11") {
        return pullJson({ head: { ref: "old", sha: "d".repeat(40), repo: null } });
      }
      // GitHub's case, not ours: the same repo spelled differently is still the same repo.
      if (path === "/repos/acme/app/pulls/12") {
        return pullJson({
          head: { ref: "x", sha: "e".repeat(40), repo: { full_name: "Acme/App" } },
        });
      }
      return null;
    });
    assertEquals(await api.classifyBranch(repo("acme/app"), "pull/9/head"), "branch");
    assertEquals(await api.classifyBranch(repo("acme/app"), "pull/10/head"), "foreign");
    assertEquals(await api.classifyBranch(repo("acme/app"), "pull/10/merge"), "foreign");
    assertEquals(await api.classifyBranch(repo("acme/app"), "pull/11/head"), "foreign");
    assertEquals(await api.classifyBranch(repo("acme/app"), "pull/12/head"), "branch");
    const gone = await assertRejects(
      () => api.classifyBranch(repo("acme/app"), "pull/404/head"),
      ForgeApiError,
    );
    assertEquals(gone.terminal, true);

    // Every other name is a branch of the connected repo: nothing to ask GitHub.
    const before = gh.calls.length;
    assertEquals(await api.classifyBranch(repo("acme/app"), "feat/scheduler"), "branch");
    assertEquals(gh.calls.length, before);
  } finally {
    await gh.shutdown();
  }
});

// ---- commits and CI: what a reviewer sees beside the diff --------------------------------

/** One entry of GitHub's pull-request commits listing. */
const commitJson = (sha: string, login: string, subject: string) => ({
  sha,
  author: { login },
  commit: {
    message: `${subject}\n\nA body nobody needs in a history.`,
    author: { name: `${login} the author`, date: "2026-02-01T10:00:00Z" },
  },
});

test("a change request's commits: the newest end, oldest first, with what came before", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method !== "GET" || !path.startsWith("/repos/acme/app/pulls/7/commits")) return null;
      return new Response(
        JSON.stringify([
          commitJson("a".repeat(40), "grace", "Cap the retry queue"),
          commitJson("b".repeat(40), "ada", "Drop the oldest, not the newest"),
          commitJson("c".repeat(40), "ada", "Add a regression test"),
        ]),
      );
    });
    // A limit above the history is the whole history, and nothing is claimed to be hidden.
    const whole = await api.listChangeRequestCommits(repo("acme/app"), "7", 50);
    assertEquals(whole.unit, "commit");
    assertEquals(whole.older, 0);
    assertEquals(whole.items.map((c) => c.authorLogin), ["grace", "ada", "ada"]);
    // Only the SUBJECT travels: the body is prose about a diff the agent can read.
    assertEquals(whole.items[0].summary, "Cap the retry queue");
    assertEquals(whole.items[0].date, "2026-02-01T10:00:00Z");

    // A limit below it keeps the newest end — the one a reviewer reads — and counts the rest.
    const tail = await api.listChangeRequestCommits(repo("acme/app"), "7", 2);
    assertEquals(tail.items.map((c) => c.sha), ["b".repeat(40), "c".repeat(40)]);
    assertEquals(tail.older, 1);
  } finally {
    await gh.shutdown();
  }
});

test("the newest `limit` really are `limit`, even when the last page holds twelve", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    const asked: number[] = [];
    // 212 commits: three pages of 100, the last holding 12. Reading only the last page answers
    // twelve commits to a request for fifty — the newest twelve, but not the newest fifty.
    gh.set((method, path) => {
      if (method === "GET" && path === "/repos/acme/app/pulls/8") {
        return new Response(JSON.stringify({ commits: 212 }));
      }
      if (method !== "GET" || !path.startsWith("/repos/acme/app/pulls/8/commits")) return null;
      const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
      asked.push(page);
      const count = page === 3 ? 12 : 100;
      return new Response(
        JSON.stringify(
          Array.from(
            { length: count },
            (_, i) => commitJson(`${page}`.repeat(40), "grace", `p${page}-c${i}`),
          ),
        ),
        {
          headers: {
            link: `<${gh.base}/repos/acme/app/pulls/8/commits?per_page=100&page=3>; rel="last"`,
          },
        },
      );
    });
    const history = await api.listChangeRequestCommits(repo("acme/app"), "8", 50);
    assertEquals(history.items.length, 50);
    // Pages 2 and 3 are ADJACENT, which is the only reason they may be concatenated: the
    // result is a real run of commits, never page 1 glued to page 3 across a hole.
    assertEquals(history.items[0].summary, "p2-c62");
    assertEquals(history.items[49].summary, "p3-c11");
    assertEquals(asked.sort(), [1, 2, 3]);
    assertEquals(history.older, 162, "212 the pull request declares, minus the 50 shown");
  } finally {
    await gh.shutdown();
  }
});

test("a history GitHub will not list to the end is a window, and is not called newest", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    const asked: number[] = [];
    // GitHub's pull-request commit listing stops at its first 250 commits from the OLDEST end.
    // On a 600-commit change request the end of the listing is commit 250 — the tip is simply
    // not in it — so page 3 is the last and holds 50.
    gh.set((method, path) => {
      if (method === "GET" && path === "/repos/acme/app/pulls/9") {
        return new Response(JSON.stringify({ commits: 600 }));
      }
      if (method !== "GET" || !path.startsWith("/repos/acme/app/pulls/9/commits")) return null;
      const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
      asked.push(page);
      const count = page === 3 ? 50 : 100;
      return new Response(
        JSON.stringify(
          Array.from(
            { length: count },
            (_, i) => commitJson("a".repeat(40), "grace", `p${page}-c${i}`),
          ),
        ),
        {
          headers: {
            link: `<${gh.base}/repos/acme/app/pulls/9/commits?per_page=100&page=3>; rel="last"`,
          },
        },
      );
    });
    const history = await api.listChangeRequestCommits(repo("acme/app"), "9", 50);
    assertEquals(history.items.length, 50);
    // The window is commits 201–250 of 600, and the head is NOT among them. Saying "the newest
    // 50, 550 earlier hidden" would hand an agent fifty commits out of the middle of a branch
    // under a label promising the opposite.
    assertEquals(history.atHead, false);
    assertEquals(history.older, 200);
    assertEquals(history.total, 600);
    assertEquals(asked, [1, 3], "the count came off the head the caller already read");
  } finally {
    await gh.shutdown();
  }
});

test("the commit count the caller already holds is not bought a second time", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    const asked: string[] = [];
    gh.set((method, path) => {
      if (method !== "GET" || !path.startsWith("/repos/acme/app/pulls/9")) return null;
      asked.push(path);
      if (path === "/repos/acme/app/pulls/9") {
        return new Response(JSON.stringify({ commits: 600 }));
      }
      const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
      return new Response(
        JSON.stringify(
          Array.from(
            { length: page === 3 ? 50 : 100 },
            () => commitJson("a".repeat(40), "grace", "c"),
          ),
        ),
        {
          headers: {
            link: `<${gh.base}/repos/acme/app/pulls/9/commits?per_page=100&page=3>; rel="last"`,
          },
        },
      );
    });
    // The head `fetchThread` just answered with carries the count: buying it again is a
    // request spent on a number already in hand.
    const history = await api.listChangeRequestCommits(repo("acme/app"), "9", 50, { total: 600 });
    assertEquals(history.total, 600);
    assertEquals(history.atHead, false);
    assertEquals(
      asked.some((p) => p === "/repos/acme/app/pulls/9"),
      false,
      "the pull was not refetched",
    );
  } finally {
    await gh.shutdown();
  }
});

test("a short last page reuses the page already in hand rather than fetching it twice", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    const asked: number[] = [];
    // 103 commits: two pages, the last holding 3. The page before it IS page 1, which this
    // read is already holding.
    gh.set((method, path) => {
      if (method === "GET" && path === "/repos/acme/app/pulls/6") {
        return new Response(JSON.stringify({ commits: 103 }));
      }
      if (method !== "GET" || !path.startsWith("/repos/acme/app/pulls/6/commits")) return null;
      const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
      asked.push(page);
      return new Response(
        JSON.stringify(
          Array.from(
            { length: page === 2 ? 3 : 100 },
            (_, i) => commitJson("a".repeat(40), "grace", `p${page}-c${i}`),
          ),
        ),
        {
          headers: {
            link: `<${gh.base}/repos/acme/app/pulls/6/commits?per_page=100&page=2>; rel="last"`,
          },
        },
      );
    });
    const history = await api.listChangeRequestCommits(repo("acme/app"), "6", 50, { total: 103 });
    assertEquals(history.items.length, 50);
    assertEquals(history.items[49].summary, "p2-c2");
    assertEquals(history.atHead, true);
    assertEquals(asked.filter((p) => p === 1).length, 1, "page 1 was read once");
  } finally {
    await gh.shutdown();
  }
});

/** Check runs and commit statuses on one head, as a test wants them answered. */
/** Check runs and commit statuses on one head, as a test wants them answered. */
/** Check runs and commit statuses on one head, as a test wants them answered. */
function fakeChecks(
  gh: Awaited<ReturnType<typeof fakeGithub>>,
  runs: { status: number; body: unknown },
  statuses: { status: number; body: unknown } = { status: 200, body: { statuses: [] } },
) {
  gh.set((method, path) => {
    if (method !== "GET" || !path.startsWith("/repos/acme/app/commits/")) return null;
    if (path.includes("/check-runs")) {
      return new Response(JSON.stringify(runs.body), { status: runs.status });
    }
    if (path.includes("/status")) {
      return new Response(JSON.stringify(statuses.body), { status: statuses.status });
    }
    return null;
  });
}

test("CI green: every check reported, from both of GitHub's two conventions", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    fakeChecks(
      gh,
      {
        status: 200,
        body: {
          total_count: 2,
          check_runs: [
            {
              name: "lint",
              status: "completed",
              conclusion: "success",
              details_url: "https://ci.test/1",
            },
            { name: "typecheck", status: "completed", conclusion: "success" },
          ],
        },
      },
      // A commit status is the OLDER convention, and still the only thing some repos report.
      { status: 200, body: { statuses: [{ context: "legacy/build", state: "success" }] } },
    );
    const report = await api.readChecks(repo("acme/app"), "c".repeat(40));
    assertEquals(report.kind, "reported");
    assert(report.kind === "reported");
    assertEquals(report.items.map((c) => c.name), ["lint", "typecheck", "legacy/build"]);
    assertEquals(report.items.map((c) => c.conclusion), ["success", "success", "success"]);
    assertEquals(report.items[0].detailsUrl, "https://ci.test/1");
    assertEquals([report.cut, report.unlisted], [0, 0]);
  } finally {
    await gh.shutdown();
  }
});

test("CI failing and pending are reported as themselves, never as a conclusion", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    fakeChecks(
      gh,
      {
        status: 200,
        // The forge says there are five; two were listed. What is not shown is counted.
        body: {
          total_count: 5,
          check_runs: [
            { name: "build", status: "completed", conclusion: "failure" },
            { name: "e2e", status: "in_progress", conclusion: null },
          ],
        },
      },
      { status: 200, body: { statuses: [{ context: "legacy/deploy", state: "pending" }] } },
    );
    const report = await api.readChecks(repo("acme/app"), "c".repeat(40));
    assert(report.kind === "reported");
    assertEquals(report.items[0].conclusion, "failure");
    // Still running has no verdict: null, not "success", which is the one wrong guess here.
    assertEquals(report.items[1].status, "in_progress");
    assertEquals(report.items[1].conclusion, null);
    assertEquals(report.items[2].conclusion, null);
    // Held back by the forge, in no order: they are NOT "three more passes".
    assertEquals([report.cut, report.unlisted], [0, 3]);
  } finally {
    await gh.shutdown();
  }
});

test("CI the installation may not read is an answer, and is not asked for again", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    const denied = { message: "Resource not accessible by integration" };
    gh.set((method, path) => {
      if (method !== "GET" || !path.includes("/commits/")) return null;
      return new Response(JSON.stringify(denied), { status: 403 });
    });
    const report = await api.readChecks(repo("acme/app"), "c".repeat(40));
    assertEquals(report.kind, "unavailable");
    assert(report.kind === "unavailable");
    assertStringIncludes(report.reason, "Checks: read");
    // Nothing the forge said is carried into what is remembered or rendered.
    assertEquals(report.reason.includes("Resource not accessible"), false);

    // Remembered: an App that was never granted the permission must not pay for asking again
    // on every change request its agents read.
    const before = gh.calls.length;
    assertEquals((await api.readChecks(repo("acme/app"), "c".repeat(40))).kind, "unavailable");
    assertEquals(gh.calls.length, before, "nothing was asked a second time");

    // ...for THAT repository. One repo of an installation says nothing about another it also
    // holds — a repo dropped from the selection would otherwise blind the agent to CI
    // everywhere that installation reaches.
    await api.readChecks(repo("acme/other"), "c".repeat(40));
    assert(gh.calls.length > before, "another repo of the same installation is asked");
  } finally {
    await gh.shutdown();
  }
});

test("a 403 that is NOT a missing permission is said plainly and never remembered", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    // A secondary rate limit, a suspended installation and a repo removed from the selection
    // are all 403s, and every one of them is temporary. Cached as a permission gap they would
    // keep an agent blind to CI long after the cause had gone.
    gh.set((method, path) => {
      if (method !== "GET" || !path.includes("/commits/")) return null;
      return new Response(
        JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
        { status: 403 },
      );
    });
    const report = await api.readChecks(repo("acme/app"), "c".repeat(40));
    assert(report.kind === "unavailable");
    assertStringIncludes(report.reason, "could not be read");
    assertEquals(report.reason.includes("Checks: read"), false, "not a permission claim");
    const before = gh.calls.length;
    await api.readChecks(repo("acme/app"), "c".repeat(40));
    assert(gh.calls.length > before, "asked again: the cause is temporary");
  } finally {
    await gh.shutdown();
  }
});

test("one CI channel failing is a report with a NAMED hole, never the other's answer", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    // The exact shape that read as "nothing has reported a check": check runs died, the
    // statuses endpoint answered, and it had nothing to say. The failing build lives in the
    // half that did not answer.
    fakeChecks(
      gh,
      { status: 500, body: { message: "server error" } },
      { status: 200, body: { statuses: [], total_count: 0 } },
    );
    const report = await api.readChecks(repo("acme/app"), "c".repeat(40));
    assert(report.kind === "reported");
    assertEquals(report.items, []);
    assert(report.partial !== null);
    assertStringIncludes(report.partial, "check runs could not be read");

    // And the other way round, with the surviving half's checks still reported.
    fakeChecks(
      gh,
      {
        status: 200,
        body: {
          total_count: 1,
          check_runs: [{ name: "lint", status: "completed", conclusion: "success" }],
        },
      },
      { status: 500, body: { message: "server error" } },
    );
    const other = await api.readChecks(repo("acme/app"), "d".repeat(40));
    assert(other.kind === "reported");
    assertEquals(other.items.map((c) => c.name), ["lint"]);
    assert(other.partial !== null);
    assertStringIncludes(other.partial, "commit statuses could not be read");
  } finally {
    await gh.shutdown();
  }
});

test("checks are ordered worst first BEFORE the cut, so a cut cannot hide a failure", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    // Fifty passing check runs and one failing commit status: listed in arrival order, the
    // failure falls off the end of the cap and the summary calls a red change request green.
    fakeChecks(
      gh,
      {
        status: 200,
        body: {
          total_count: 50,
          check_runs: Array.from({ length: 50 }, (_, i) => ({
            name: `check-${i}`,
            status: "completed",
            conclusion: "success",
          })),
        },
      },
      {
        status: 200,
        body: {
          total_count: 1,
          statuses: [{ context: "legacy/build", state: "failure" }],
        },
      },
    );
    const report = await api.readChecks(repo("acme/app"), "c".repeat(40));
    assert(report.kind === "reported");
    assertEquals(report.items[0].name, "legacy/build", "the failure survives the cut, first");
    assertEquals(report.items[0].conclusion, "failure");
    assertEquals(report.items.length, 50);
    // Dropped by THIS read from the mild end of a sorted list: known to be a pass, and counted
    // apart from anything the forge held back.
    assertEquals([report.cut, report.unlisted], [1, 0]);
    assertEquals(report.items[49].conclusion, "success");
  } finally {
    await gh.shutdown();
  }
});

test("checks the forge never listed are their OWN count, never a pass", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    fakeChecks(
      gh,
      { status: 200, body: { total_count: 0, check_runs: [] } },
      {
        status: 200,
        // The combined-status endpoint pages like any other, and says how many it has.
        body: { total_count: 9, statuses: [{ context: "legacy/build", state: "success" }] },
      },
    );
    const report = await api.readChecks(repo("acme/app"), "c".repeat(40));
    assert(report.kind === "reported");
    // Eight the forge holds and did not show, in no order whatsoever: one of them may be the
    // failing build, so they are kept apart from the cut this read made itself.
    assertEquals([report.cut, report.unlisted], [0, 8]);
  } finally {
    await gh.shutdown();
  }
});

test("both check listings are asked for GitHub's largest page, so unlisted stays rare", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    const asked: string[] = [];
    gh.set((method, path) => {
      if (method !== "GET" || !path.startsWith("/repos/acme/app/commits/")) return null;
      asked.push(path);
      return new Response(JSON.stringify({ total_count: 0, check_runs: [], statuses: [] }));
    });
    await api.readChecks(repo("acme/app"), "c".repeat(40));
    // An unlisted check is the one that poisons a verdict, so the read buys the biggest page
    // GitHub will serve rather than the number it reports.
    for (const path of asked) assertStringIncludes(path, "per_page=100");
    assertEquals(asked.length, 2);
  } finally {
    await gh.shutdown();
  }
});

test("every forge-authored string in these sections is clamped at the boundary", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    const huge = "x".repeat(200_000);
    gh.set((method, path) => {
      if (method !== "GET") return null;
      if (path.startsWith("/repos/acme/app/pulls/12/commits")) {
        return new Response(JSON.stringify([{
          sha: huge,
          // An unlinked commit's author name is whatever the committer's git config said.
          commit: { message: `${huge}\nbody`, author: { name: huge, date: huge } },
        }]));
      }
      if (path.includes("/check-runs")) {
        return new Response(JSON.stringify({
          total_count: 1,
          check_runs: [{
            name: huge,
            status: "completed",
            conclusion: "success",
            details_url: huge,
          }],
        }));
      }
      if (path.includes("/status")) return new Response(JSON.stringify({ statuses: [] }));
      return null;
    });
    // One 200 000-character name is all it takes for the timeline and the file list to fall
    // off the end of a read that spends a fixed budget on the whole change request.
    const history = await api.listChangeRequestCommits(repo("acme/app"), "12", 50);
    assert(history.items[0].authorLogin.length <= 81, history.items[0].authorLogin.length + "");
    assert(history.items[0].sha.length <= 65);
    assert(history.items[0].date.length <= 41);
    assert(history.items[0].summary.length <= 201, "the subject, with its ellipsis");
    const report = await api.readChecks(repo("acme/app"), "c".repeat(40));
    assert(report.kind === "reported");
    assert(report.items[0].name.length <= 121);
    assert((report.items[0].detailsUrl ?? "").length <= 501);
  } finally {
    await gh.shutdown();
  }
});

test("a mint GitHub refuses for a permission never granted reads as unavailable CI", async () => {
  // A SCOPED mint is where a missing permission surfaces: GitHub refuses to mint a token for
  // what the installation was never granted, rather than handing out one that 403s later. So
  // this fake refuses the mint and answers nothing else — which is the whole exchange.
  const server = await serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    (req) =>
      new Response(
        JSON.stringify(
          /\/access_tokens$/.test(new URL(req.url).pathname)
            ? { message: "The permissions requested are not granted to this installation." }
            : { message: "not found" },
        ),
        { status: /\/access_tokens$/.test(new URL(req.url).pathname) ? 422 : 404 },
      ),
  );
  try {
    const api = await makeApi(`http://127.0.0.1:${server.addr.port}`);
    const report = await api.readChecks(repo("acme/app"), "c".repeat(40));
    assertEquals(report.kind, "unavailable");
    assert(report.kind === "unavailable");
    assertStringIncludes(report.reason, "Checks: read");
  } finally {
    await server.shutdown();
  }
});

test("a forge that answers neither endpoint says CI could not be read, not that it is green", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    fakeChecks(
      gh,
      { status: 500, body: { message: "server error" } },
      { status: 500, body: { message: "server error" } },
    );
    const report = await api.readChecks(repo("acme/app"), "c".repeat(40));
    assert(report.kind === "unavailable");
    assertStringIncludes(report.reason, "could not be read");
    // A 5xx is not a permission answer, so it is NOT remembered: the next read asks again.
    const before = gh.calls.length;
    await api.readChecks(repo("acme/app"), "c".repeat(40));
    assert(gh.calls.length > before);
  } finally {
    await gh.shutdown();
  }
});

/** A GitHub that grants only SOME permissions: a scoped mint asking for anything outside
 * `granted` is refused the way the real one refuses it. */
async function pickyMints(granted: string[], onGet: (path: string) => Response | null) {
  return await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const url = new URL(req.url);
    if (/\/access_tokens$/.test(url.pathname)) {
      const body = await req.json().catch(() => ({}));
      const wanted = Object.keys(body?.permissions ?? {});
      if (wanted.some((p) => !granted.includes(p))) {
        return new Response(
          JSON.stringify({
            message: "The permissions requested are not granted to this installation.",
          }),
          { status: 422 },
        );
      }
      return new Response(
        JSON.stringify({ token: `ghs_${wanted.join("_")}`, expires_at: null }),
        { status: 201 },
      );
    }
    return onGet(url.pathname + url.search) ??
      new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  });
}

test("an installation granted ONE of the two CI permissions still reads that half", async () => {
  const asked: string[] = [];
  // Asking for both at once is a flat 422 when only one is held — so a change request whose
  // check runs are perfectly readable would read as "may not read CI" without the fallback.
  const server = await pickyMints(["checks"], (path) => {
    asked.push(path);
    return path.includes("/check-runs")
      ? new Response(JSON.stringify({
        total_count: 1,
        check_runs: [{ name: "build", status: "completed", conclusion: "failure" }],
      }))
      : null;
  });
  try {
    const api = await makeApi(`http://127.0.0.1:${server.addr.port}`);
    const report = await api.readChecks(repo("acme/app"), "c".repeat(40));
    assert(report.kind === "reported", JSON.stringify(report));
    assertEquals(report.items.map((c) => c.name), ["build"]);
    assert(report.partial !== null);
    assertStringIncludes(report.partial, "commit statuses could not be read");
    assertStringIncludes(report.partial, "granted only the other half");
    // The half nobody granted is never asked for: the mint already said so.
    assertEquals(asked.some((p) => p.includes("/status")), false);

    // And nothing is remembered as a refusal — there IS CI to read here.
    const again = await api.readChecks(repo("acme/app"), "c".repeat(40));
    assertEquals(again.kind, "reported");
  } finally {
    await server.shutdown();
  }
});

test("an installation granted NEITHER is the one refusal worth remembering", async () => {
  const server = await pickyMints([], () => null);
  try {
    const api = await makeApi(`http://127.0.0.1:${server.addr.port}`);
    const report = await api.readChecks(repo("acme/app"), "c".repeat(40));
    assert(report.kind === "unavailable");
    assertStringIncludes(report.reason, "Checks: read");
  } finally {
    await server.shutdown();
  }
});

test("a CI read the forge rate-limited carries WHEN it lifts, so nobody asks again", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    const reset = Math.floor(Date.now() / 1000) + 600;
    gh.set((method, path) => {
      if (method !== "GET" || !path.startsWith("/repos/acme/app/commits/")) return null;
      return new Response(
        JSON.stringify({ message: "API rate limit exceeded for installation" }),
        { status: 403, headers: { "x-ratelimit-reset": String(reset) } },
      );
    });
    const report = await api.readChecks(repo("acme/app"), "c".repeat(40));
    assert(report.kind === "unavailable");
    // An answer rather than a throw must not be how an exhausted installation keeps being
    // asked: this call costs a mint and two requests of the same allowance every time.
    assert((report.retryAfterMs ?? 0) > 9 * 60_000, `${report.retryAfterMs}`);
    // A rate limit is temporary, so it is NOT cached as a missing permission.
    assertEquals(report.reason.includes("Checks: read"), false);
  } finally {
    await gh.shutdown();
  }
});

test("describeSubscriptions reads the App and every installation, paginated", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) => {
      if (method === "GET" && path === "/app") {
        return new Response(JSON.stringify({
          slug: "ryph",
          events: ["push", "pull_request", 7],
          permissions: { contents: "write", metadata: "read", bogus: null },
        }));
      }
      if (method === "GET" && path.startsWith("/app/installations?")) {
        const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
        const count = page === 1 ? 100 : 1;
        return new Response(JSON.stringify(
          Array.from({ length: count }, (_, i) => ({
            id: (page - 1) * 100 + i,
            account: {
              login: `org-${(page - 1) * 100 + i}`,
              type: i === 0 ? "User" : "Organization",
            },
            events: ["push"],
            permissions: { contents: "read" },
          })),
        ));
      }
      return null;
    });
    const subs = await api.describeSubscriptions();
    // Only strings survive: GitHub's shape is not trusted further than that.
    assertEquals(subs.app, {
      events: ["push", "pull_request"],
      permissions: { contents: "write", metadata: "read" },
    });
    assertEquals(subs.installations.length, 101);
    assertEquals(subs.installations[0], {
      id: "0",
      account: "org-0",
      accountType: "User",
      events: ["push"],
      permissions: { contents: "read" },
    });
    assertEquals(subs.installations[100].account, "org-100");
    assertEquals(subs.installations[100].accountType, "User");
    assertEquals(subs.installations[1].accountType, "Organization");
  } finally {
    await gh.shutdown();
  }
});

test("describeSubscriptions reads past 5,000 installations, to the short page", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    let asked = 0;
    gh.set((method, path) => {
      if (method === "GET" && path === "/app") {
        return new Response(JSON.stringify({ events: [], permissions: {} }));
      }
      if (method === "GET" && path.startsWith("/app/installations?")) {
        asked++;
        const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
        // 51 full pages, then a short one: the old 50-page cap would have stopped at 5,000.
        const count = page <= 51 ? 100 : 7;
        return new Response(JSON.stringify(
          Array.from({ length: count }, (_, i) => ({
            id: (page - 1) * 100 + i,
            account: { login: `org-${(page - 1) * 100 + i}`, type: "Organization" },
          })),
        ));
      }
      return null;
    });
    const subs = await api.describeSubscriptions();
    assertEquals(subs.installations.length, 5_107);
    assertEquals(subs.installations.at(-1)?.account, "org-5106");
    assertEquals(asked, 52);
  } finally {
    await gh.shutdown();
  }
});

test("describeSubscriptions stops when GitHub repeats a full page", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    let asked = 0;
    gh.set((method, path) => {
      if (method === "GET" && path === "/app") {
        return new Response(JSON.stringify({ events: [], permissions: {} }));
      }
      if (method === "GET" && path.startsWith("/app/installations?")) {
        asked++;
        // Ignores `page`: every answer is the same full first page.
        return new Response(JSON.stringify(
          Array.from({ length: 100 }, (_, i) => ({
            id: i,
            account: { login: `org-${i}`, type: "Organization" },
          })),
        ));
      }
      return null;
    });
    const subs = await api.describeSubscriptions();
    assertEquals(subs.installations.length, 100);
    assertEquals(asked, 2);
  } finally {
    await gh.shutdown();
  }
});

test("describeSubscriptions throws when GitHub will not say", async () => {
  const gh = await fakeGithub();
  try {
    const api = await makeApi(gh.base);
    gh.set((method, path) =>
      method === "GET" && path === "/app"
        ? new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })
        : null
    );
    const err = await assertRejects(() => api.describeSubscriptions(), ForgeApiError);
    assertStringIncludes(err.message, "401");
  } finally {
    await gh.shutdown();
  }
});

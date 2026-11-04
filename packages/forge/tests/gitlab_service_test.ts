// Door ③'s GitLab questions, answered from a configured GitLab: the project picker, one project
// described, a project's webhook token, sign-in and the sign-up group — each in bot mode and in
// user mode, over a fake `GitlabConnectApi` that records what it was asked.

import { test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { ForgeApiError, providerRegistry } from "../src/ports/forge_api.ts";
import type { GitlabConnectApi, GitlabProjectListing } from "../src/ports/gitlab.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { silentDiagnostics } from "./util.ts";

const SERVICE_TOKEN = "service-secret";

const PROJECT: GitlabProjectListing = {
  id: "42",
  pathWithNamespace: "acme/platform/app",
  url: "https://gitlab.example/acme/platform/app.git",
  webUrl: "https://gitlab.example/acme/platform/app",
  defaultBranch: "main",
  visibility: "internal",
  admin: false,
};

const GRACE = "1001@https://gitlab.example";

/** A GitLab connect surface that records every call. `fail` makes the next call throw it. */
function fakeGitlab(mode: "bot" | "user", opts: { group?: boolean; webhooks?: boolean } = {}) {
  const calls: unknown[][] = [];
  let fail: Error | null = null;
  const throwing = () => {
    const err = fail;
    fail = null;
    if (err !== null) throw err;
  };
  const api: GitlabConnectApi = {
    mode: {
      mode,
      login: mode === "bot" ? "ryph-bot" : "grace.h",
      accountId: "7@https://gitlab.example",
      url: "https://gitlab.example",
      signIn: mode === "bot",
    },
    self: { id: "7", login: mode === "bot" ? "ryph-bot" : "grace.h" },
    listProjects: () => {
      calls.push(["listProjects"]);
      throwing();
      return Promise.resolve([PROJECT]);
    },
    describeProject: (project) => {
      calls.push(["describeProject", project]);
      throwing();
      return Promise.resolve(
        project === "42" || project === PROJECT.pathWithNamespace ? PROJECT : null,
      );
    },
    exchangeOAuthCode: (code, redirectUri, codeVerifier) => {
      calls.push(["exchangeOAuthCode", code, redirectUri, codeVerifier]);
      throwing();
      return Promise.resolve({
        accountId: "1001",
        login: "grace.h",
        name: "Grace",
        verifiedEmails: ["grace@example.com"],
        accessToken: null,
      });
    },
    checkGroupMembership: (accountId) => {
      calls.push(["checkGroupMembership", accountId]);
      throwing();
      if (!opts.group) return Promise.resolve(null);
      return Promise.resolve(accountId === GRACE ? "member" : "not-member");
    },
    describeUser: (accountId) => {
      calls.push(["describeUser", accountId]);
      throwing();
      return Promise.resolve(accountId === GRACE ? { login: "grace.h" } : null);
    },
    hookToken: (projectId, generation) => {
      calls.push(["hookToken", projectId, generation]);
      if (opts.webhooks === false || mode === "user") {
        return Promise.reject(new ForgeApiError("no GitLab webhook secret is configured", true));
      }
      return Promise.resolve(`derived-for-${projectId}-${generation}`);
    },
  };
  return {
    api,
    calls,
    failNext: (err: Error) => void (fail = err),
  };
}

async function handlerWith(root: string, gitlab: GitlabConnectApi | null) {
  const diag = silentDiagnostics();
  const stagingDir = `${root}/staging`;
  await mkdir(stagingDir, { recursive: true });
  const deps: AppDeps = {
    keys: { resolve: () => Promise.resolve(null) },
    cache: localFsRepoCache({ root: `${root}/cache`, diag }),
    patches: localFsPatchStore(`${root}/patches`, diag),
    diag,
    // The registry is the composition root's; these routes only need the connect surface.
    forges: providerRegistry({}, "forge API"),
    transports: providerRegistry({}, "change transport"),
    gitlab,
    serviceToken: SERVICE_TOKEN,
    config: { maxUploadPackBytes: 1024, maxBundleBytes: 1024 * 1024, stagingDir },
  };
  return makeHandler(deps);
}

const call = (
  handler: (req: Request) => Promise<Response>,
  path: string,
  body?: unknown,
  token = SERVICE_TOKEN,
) =>
  handler(
    new Request(`http://forge${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

async function withRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true });
  }
}

test("the providers answer carries GitLab's mode, its account and its instance", () =>
  withRoot(async (root) => {
    const { api } = fakeGitlab("bot");
    const res = await call(await handlerWith(root, api), "/v1/service/providers");
    assertEquals((await res.json()).gitlab, {
      mode: "bot",
      login: "ryph-bot",
      accountId: "7@https://gitlab.example",
      url: "https://gitlab.example",
      signIn: true,
    });
  }));

test("the project picker lists what the token's account reaches; a GitLab failure says whether a retry helps", () =>
  withRoot(async (root) => {
    const gl = fakeGitlab("bot");
    const handler = await handlerWith(root, gl.api);
    const res = await call(handler, "/v1/service/gitlab/projects");
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { projects: [PROJECT] });

    gl.failNext(new ForgeApiError("GitLab answered 401", true));
    const refused = await call(handler, "/v1/service/gitlab/projects");
    assertEquals(refused.status, 502);
    assertEquals(await refused.json(), { error: "GitLab answered 401", terminal: true });

    gl.failNext(new Error("socket hang up"));
    const flaky = await call(handler, "/v1/service/gitlab/projects");
    assertEquals(flaky.status, 502);
    assertEquals((await flaky.json()).terminal, false);

    // Service-authenticated like every other route here.
    assertEquals((await call(handler, "/v1/service/gitlab/projects", undefined, "x")).status, 401);
  }));

test("describe answers GitLab's own listing by id or path, and a terminal 404 for none", () =>
  withRoot(async (root) => {
    const gl = fakeGitlab("user");
    const handler = await handlerWith(root, gl.api);
    for (const project of ["42", "acme/platform/app"]) {
      const res = await call(handler, "/v1/service/gitlab/describe", { project });
      assertEquals(res.status, 200, project);
      assertEquals(await res.json(), PROJECT);
    }
    const none = await call(handler, "/v1/service/gitlab/describe", { project: "acme/ghost" });
    assertEquals(none.status, 404);
    const body = await none.json();
    assertEquals(body.terminal, true);
    assertStringIncludes(body.error, "@grace.h");
    // A path no GitLab could hold never reaches the adapter.
    const bad = await call(handler, "/v1/service/gitlab/describe", { project: "../etc" });
    assertEquals(bad.status, 400);
    assertEquals(gl.calls, [
      ["describeProject", "42"],
      ["describeProject", "acme/platform/app"],
      ["describeProject", "acme/ghost"],
    ]);
  }));

test("a webhook token is derived for a bot with a secret, and is a 501 in user mode or without one", () =>
  withRoot(async (root) => {
    const bot = await handlerWith(root, fakeGitlab("bot").api);
    const res = await call(bot, "/v1/service/gitlab/hook-token", {
      projectId: "42",
      generation: 3,
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { token: "derived-for-42-3" });
    for (
      const bad of [{ projectId: "4/2", generation: 1 }, { projectId: "42" }, {
        projectId: "42",
        generation: 0,
      }]
    ) {
      assertEquals((await call(bot, "/v1/service/gitlab/hook-token", bad)).status, 400);
    }

    const user = fakeGitlab("user");
    const asPerson = await call(
      await handlerWith(root, user.api),
      "/v1/service/gitlab/hook-token",
      { projectId: "42", generation: 1 },
    );
    assertEquals(asPerson.status, 501);
    assertStringIncludes((await asPerson.json()).error, "no webhooks");
    assertEquals(user.calls, [], "user mode is refused before the adapter is asked");

    const secretless = await call(
      await handlerWith(root, fakeGitlab("bot", { webhooks: false }).api),
      "/v1/service/gitlab/hook-token",
      { projectId: "42", generation: 1 },
    );
    assertEquals(secretless.status, 501);
    assertEquals((await secretless.json()).terminal, true);
  }));

test("a GitLab sign-in redeems its code with the redirect URI and PKCE verifier; GitHub's leg is untouched", () =>
  withRoot(async (root) => {
    const gl = fakeGitlab("bot");
    const handler = await handlerWith(root, gl.api);
    const verifier = "v".repeat(43);
    const res = await call(handler, "/v1/service/oauth/exchange", {
      provider: "gitlab",
      code: "the-code",
      redirectUri: "https://ryph.example/gitlab/callback",
      codeVerifier: verifier,
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      accountId: "1001",
      login: "grace.h",
      name: "Grace",
      verifiedEmails: ["grace@example.com"],
      accessToken: null,
    });
    // No verifier is a null one, not an empty string.
    await call(handler, "/v1/service/oauth/exchange", {
      provider: "gitlab",
      code: "c2",
      redirectUri: "https://ryph.example/gitlab/callback",
    }).then((r) => r.body?.cancel());
    assertEquals(gl.calls, [
      ["exchangeOAuthCode", "the-code", "https://ryph.example/gitlab/callback", verifier],
      ["exchangeOAuthCode", "c2", "https://ryph.example/gitlab/callback", null],
    ]);

    // A refused code is the caller's "try again", as on GitHub.
    gl.failNext(new ForgeApiError("invalid_grant", true));
    const bad = await call(handler, "/v1/service/oauth/exchange", {
      provider: "gitlab",
      code: "stale",
      redirectUri: "https://ryph.example/gitlab/callback",
    });
    assertEquals(bad.status, 502);

    // GitHub's leg still needs its App, which this forge does not have.
    const github = await call(handler, "/v1/service/oauth/exchange", {
      provider: "github",
      code: "c",
    });
    assertEquals(github.status, 501);
    assertStringIncludes((await github.json()).error, "GitHub App");

    // User mode has no sign-in at all.
    const user = fakeGitlab("user");
    const asPerson = await call(await handlerWith(root, user.api), "/v1/service/oauth/exchange", {
      provider: "gitlab",
      code: "c",
      redirectUri: "https://ryph.example/gitlab/callback",
    });
    assertEquals(asPerson.status, 501);
    assertEquals(user.calls, []);
  }));

test("the sign-up group: member, not-member, no-organization without a group, unknown when unread", () =>
  withRoot(async (root) => {
    const gated = fakeGitlab("bot", { group: true });
    const handler = await handlerWith(root, gated.api);
    const ask = async (h: typeof handler, accountId: string) => {
      const res = await call(h, "/v1/service/org-membership", { provider: "gitlab", accountId });
      assertEquals(res.status, 200);
      return (await res.json()).membership;
    };
    assertEquals(await ask(handler, GRACE), "member");
    assertEquals(await ask(handler, "8@https://gitlab.example"), "not-member");
    gated.failNext(new Error("GitLab answered 503"));
    assertEquals(await ask(handler, GRACE), "unknown");
    // By the account's id alone: a username is refused at the door, never asked about.
    const before = gated.calls.length;
    const byName = await call(handler, "/v1/service/org-membership", {
      provider: "gitlab",
      login: "grace.h",
    });
    assertEquals(byName.status, 400);
    await byName.body?.cancel();
    assertEquals(gated.calls.length, before);

    const open = await handlerWith(root, fakeGitlab("bot").api);
    assertEquals(await ask(open, "1@https://gitlab.example"), "no-organization");

    const user = await call(
      await handlerWith(root, fakeGitlab("user").api),
      "/v1/service/org-membership",
      { provider: "gitlab", accountId: GRACE },
    );
    assertEquals(user.status, 501);
    await user.body?.cancel();
  }));

test("a person's current username, by their account id, for display", () =>
  withRoot(async (root) => {
    const gl = fakeGitlab("bot");
    const handler = await handlerWith(root, gl.api);
    const ok = await call(handler, "/v1/service/gitlab/user", { accountId: GRACE });
    assertEquals([ok.status, await ok.json()], [200, { login: "grace.h" }]);
    const gone = await call(handler, "/v1/service/gitlab/user", {
      accountId: "9@https://gitlab.example",
    });
    assertEquals(gone.status, 404);
    await gone.body?.cancel();
    const byName = await call(handler, "/v1/service/gitlab/user", { accountId: "grace.h" });
    assertEquals(byName.status, 400);
    await byName.body?.cancel();
  }));

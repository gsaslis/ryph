// GitHub USER mode — the forge acting as one person's token — against a fake GitHub: who the
// token is, what it reaches, where it may be presented, and how a 401 re-reads it. The token is
// the person's whole account, so every refusal here is also checked for not carrying it.

import { test } from "bun:test";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { command } from "@ryph/process";
import { serve } from "@ryph/service";
import {
  githubForgeApi,
  type GithubUserForge,
  missingUserScopes,
} from "../src/adapters/forge_api/github.ts";
import { githubChangeTransport } from "../src/adapters/change_transport/github.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { ForgeApiError, providerRegistry } from "../src/ports/forge_api.ts";
import { type FetchAuth, UpstreamRefused } from "../src/ports/repo_cache.ts";
import { credentialFor } from "../src/http/fetch_auth.ts";
import { advertiseRefs, uploadPack } from "../src/helpers/http_backend.ts";
import {
  commandUserToken,
  staticUserToken,
  type UserTokenSource,
} from "../src/helpers/user_token.ts";
import { makeHandler } from "../src/http/app.ts";
import { git, renewingGit } from "../src/helpers/git_exec.ts";
import { commit, makeUpstream, recordingDiagnostics, silentDiagnostics } from "./util.ts";

const TOKEN = "ghp_userTokenNeverLogged0001";
const LOGIN = "Ada-Lovelace";

type Responder = (
  req: { method: string; path: string; auth: string | null; body: unknown },
) => Response | null;

/** A fake GitHub that knows who `TOKEN` is and records every request with the credential it
 * carried; each test adds the routes it exercises. */
async function fakeGithub(opts: { scopes?: string | null; tokens?: string[] } = {}) {
  const calls: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
  const valid = new Set(opts.tokens ?? [TOKEN]);
  let respond: Responder = () => null;
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    const auth = req.headers.get("authorization");
    const body = req.body === null ? undefined : await req.json().catch(() => undefined);
    const call = { method: req.method, path, auth, body };
    calls.push(call);
    if (req.method === "GET" && path === "/user") {
      if (auth === null || !valid.has(auth.replace(/^Bearer /, ""))) {
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      const scopes = opts.scopes === undefined ? "repo, workflow" : opts.scopes;
      return Response.json(
        { login: LOGIN, id: 1 },
        { headers: scopes === null ? {} : { "x-oauth-scopes": scopes } },
      );
    }
    return respond(call) ?? Response.json({ message: "Not Found" }, { status: 404 });
  });
  return {
    base: `http://127.0.0.1:${server.addr.port}`,
    calls,
    valid,
    set: (fn: Responder) => {
      respond = fn;
    },
    shutdown: () => server.shutdown(),
  };
}

function userApi(base: string, token: UserTokenSource = staticUserToken(TOKEN)) {
  return githubForgeApi({
    mode: "user",
    token,
    apiBase: base,
    oauthBase: base,
    diag: silentDiagnostics(),
  });
}

const mine = (repoRef: string) => ({ repoRef, tenantId: null });

/** A repo as GitHub's REST API answers it. */
const repoJson = (fullName: string, base: string, isPrivate = false) => ({
  full_name: fullName,
  clone_url: `${base}/${fullName}.git`,
  default_branch: "main",
  private: isPrivate,
});

// ---- the token's source ---------------------------------------------------------------------

/** A command that prints `tok-<n>`, n counting its own runs in `dir`/runs. */
async function countingCommand(dir: string, extra = ""): Promise<{
  command: string;
  runs: () => Promise<number>;
}> {
  const runs = `${dir}/runs`;
  await writeFile(runs, "");
  return {
    command: `${extra}echo x >> '${runs}'; printf 'tok-%s\\n' "$(wc -l < '${runs}' | tr -d ' ')"`,
    runs: async () => (await readFile(runs, "utf8")).split("\n").filter(Boolean).length,
  };
}

test("a static token: refused when it could not be a header, never refreshed", async () => {
  const token = staticUserToken(TOKEN);
  assertEquals(await token.current(), TOKEN);
  assertEquals(await token.refresh(TOKEN), null);
  for (const bad of ["", "two words", "line\nbreak"]) {
    const err = (() => {
      try {
        staticUserToken(bad);
      } catch (err) {
        return err as Error;
      }
    })();
    assert(err instanceof Error, JSON.stringify(bad));
    assert(bad === "" || !err.message.includes(bad));
  }
});

test("a token command: run once, shared by concurrent refreshes, never rerun for a stale ask", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { command, runs } = await countingCommand(dir);
    const token = commandUserToken({ command, diag: silentDiagnostics(), minRefreshIntervalMs: 0 });
    assertEquals(await token.current(), "tok-1");
    assertEquals(await token.current(), "tok-1"); // from memory
    // Five requests hit the same 401 at once: ONE run answers all of them.
    const fresh = await Promise.all(Array.from({ length: 5 }, () => token.refresh("tok-1")));
    assertEquals(fresh, Array(5).fill("tok-2"));
    assertEquals(await runs(), 2);
    // A request that read tok-1 before the refresh and 401s after it gets tok-2 without a run.
    assertEquals(await token.refresh("tok-1"), "tok-2");
    assertEquals(await runs(), 2);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a token command: a refresh inside the interval is skipped, an unchanged token is null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    let now = 1_000_000;
    const { command, runs } = await countingCommand(dir);
    const token = commandUserToken({
      command,
      diag: silentDiagnostics(),
      minRefreshIntervalMs: 30_000,
      now: () => now,
    });
    assertEquals(await token.current(), "tok-1");
    assertEquals(await token.refresh("tok-1"), null); // the command ran moments ago
    assertEquals(await runs(), 1);
    now += 30_000;
    assertEquals(await token.refresh("tok-1"), "tok-2");

    const same = commandUserToken({
      command: "echo same",
      diag: silentDiagnostics(),
      minRefreshIntervalMs: 0,
    });
    assertEquals(await same.current(), "same");
    assertEquals(await same.refresh("same"), null);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a token command that fails says why without what it printed, and a refresh survives it", async () => {
  const failing = commandUserToken({
    command: "echo secret-on-stdout; echo 'gh: not logged in' >&2; exit 4",
    diag: silentDiagnostics(),
  });
  const err = await assertRejects(() => failing.current(), Error);
  assertStringIncludes(err.message, "exited 4");
  assertStringIncludes(err.message, "gh: not logged in");
  assert(!err.message.includes("secret-on-stdout"));

  const garbage = commandUserToken({
    command: "echo 'not a token at all'",
    diag: silentDiagnostics(),
  });
  const shapeErr = await assertRejects(() => garbage.current(), Error);
  assert(!shapeErr.message.includes("not a token at all"));

  const slow = commandUserToken({ command: "sleep 5", diag: silentDiagnostics(), timeoutMs: 100 });
  await assertRejects(() => slow.current(), Error, "took longer than 0.1s");

  // After a good start, a refresh that fails is logged and answers null — the old token stays.
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const flag = `${dir}/broken`;
    const { diag, events } = recordingDiagnostics();
    const token = commandUserToken({
      command: `if [ -e '${flag}' ]; then echo broken >&2; exit 1; fi; echo good-token`,
      diag,
      minRefreshIntervalMs: 0,
    });
    assertEquals(await token.current(), "good-token");
    await writeFile(flag, "");
    assertEquals(await token.refresh("good-token"), null);
    assertEquals(await token.current(), "good-token");
    assert(events.some((e) => e.event === "github_user_token.refresh_failed"));
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a token command's timeout bounds a pipeline that outlives it, and kills all of it", async () => {
  // `sh` dies on its own deadline; the pipeline behind it holds stdout open for 7 seconds.
  const marker = `7.${crypto.getRandomValues(new Uint32Array(1))[0]}`;
  const slow = commandUserToken({
    command: `sleep ${marker} | cat`,
    diag: silentDiagnostics(),
    timeoutMs: 500,
  });
  const started = performance.now();
  await assertRejects(() => slow.current(), Error, "took longer than 0.5s");
  assert(performance.now() - started < 3_000, "the deadline waited for the pipeline");
  // The whole group was killed, not just the shell: no `sleep` is left behind.
  const left = await command("pgrep", { args: ["-f", `sleep ${marker}`] }).output();
  assertEquals(new TextDecoder().decode(left.stdout).trim(), "");
});

test("the deadline kills the whole group from a process of its own", async () => {
  // The token command run the way the binary runs it, in its own runtime process rather than
  // this test's, and the pipeline's grandchild must not outlive the deadline.
  const marker = `7.${crypto.getRandomValues(new Uint32Array(1))[0]}`;
  const module = new URL("../src/helpers/user_token.ts", import.meta.url).href;
  const script = `
    import { commandUserToken } from ${JSON.stringify(module)};
    const diag = { debug() {}, warn() {} };
    const slow = commandUserToken({ command: "sleep ${marker} | cat", diag, timeoutMs: 300 });
    try { await slow.current(); console.log("answered"); } catch (e) { console.log(e.message); }
  `;
  const out = await command(process.execPath, {
    args: ["--no-env-file", "-e", script],
    stdin: "null",
  }).output();
  assertStringIncludes(
    new TextDecoder().decode(out.stdout),
    "took longer than 0.3s",
    new TextDecoder().decode(out.stderr),
  );
  const left = await command("pgrep", { args: ["-f", `sleep ${marker}`] }).output();
  assertEquals(new TextDecoder().decode(left.stdout).trim(), "", "a grandchild was orphaned");
});

// ---- the adapter ----------------------------------------------------------------------------

test("user mode reads who the token is at construction, and what a classic token may do", async () => {
  const gh = await fakeGithub({ scopes: "gist, read:org" });
  try {
    const api = await userApi(gh.base);
    assertEquals(api.login, LOGIN);
    assertEquals(api.scopes, ["gist", "read:org"]);
    assertEquals(missingUserScopes(api.scopes), ["repo"]);
    assertEquals(gh.calls[0].auth, `Bearer ${TOKEN}`);
    // App-only methods are absent, not faked.
    assertEquals("describeInstallation" in api, false);
    assertEquals("getInstallationSettingsUrl" in api, false);
    assertEquals("exchangeOAuthCode" in api, false);
    assertEquals("checkOrgMembership" in api, false);
  } finally {
    await gh.shutdown();
  }
  // A fine-grained token sends no scopes header, and that lacks nothing.
  const fine = await fakeGithub({ scopes: null });
  try {
    const api = await userApi(fine.base);
    assertEquals(api.scopes, null);
    assertEquals(missingUserScopes(api.scopes), []);
  } finally {
    await fine.shutdown();
  }
  assertEquals(missingUserScopes(["repo", "workflow"]), []);
});

test("a token GitHub refuses fails the construction, without the token in the message", async () => {
  const gh = await fakeGithub({ tokens: [] });
  try {
    const err = await assertRejects(() => userApi(gh.base), ForgeApiError);
    assertStringIncludes(err.message, "401");
    assert(err.terminal);
    assert(!err.message.includes(TOKEN));
  } finally {
    await gh.shutdown();
  }
});

test("a GitHub that cannot be reached fails the construction naming where it was dialled", async () => {
  // A port nothing listens on: the bare "fetch failed" is not enough to act on.
  const gone = createServer().listen(0, "127.0.0.1");
  await once(gone, "listening");
  const base = `http://127.0.0.1:${(gone.address() as AddressInfo).port}`;
  await new Promise((resolve) => gone.close(resolve));
  const err = await assertRejects(() => userApi(base), ForgeApiError);
  assertStringIncludes(err.message, `could not reach GitHub at ${base}`);
  assert(!err.terminal);
  assert(!err.message.includes(TOKEN));
});

test("listUserRepos walks every page of /user/repos with the three affiliations", async () => {
  const gh = await fakeGithub();
  try {
    const api = await userApi(gh.base);
    gh.set(({ path }) => {
      if (!path.startsWith("/user/repos?")) return null;
      const query = new URLSearchParams(path.split("?")[1]);
      assertEquals(query.get("affiliation"), "owner,collaborator,organization_member");
      assertEquals(query.get("per_page"), "100");
      const page = Number(query.get("page"));
      const count = page === 1 ? 100 : 30;
      // Every third repo is one the person administers; one in five says nothing about it.
      const repos: unknown[] = Array.from({ length: count }, (_, i) => ({
        ...repoJson(`acme/repo-${(page - 1) * 100 + i}`, gh.base, i % 2 === 0),
        ...(i % 5 === 4 ? {} : { permissions: { admin: i % 3 === 0, push: true, pull: true } }),
      }));
      // A malformed entry is not offered, rather than offered with invented fields.
      if (page === 2) repos.push({ full_name: "acme/broken" });
      return Response.json(repos);
    });
    const repos = await api.listUserRepos();
    assertEquals(repos.length, 130);
    assertEquals(repos[129], {
      fullName: "acme/repo-129",
      url: `${gh.base}/acme/repo-129.git`,
      defaultBranch: "main",
      private: false,
      admin: false,
    });
    assertEquals(repos[127].admin, true);
    // Write without admin, and no `permissions` at all, both list as not administered.
    assertEquals(repos[1].admin, false);
    assertEquals(repos[129].admin, false);
    assertEquals(gh.calls.filter((c) => c.path.startsWith("/user/repos")).length, 2);
  } finally {
    await gh.shutdown();
  }
});

test("describeRepo: GitHub's own spelling, null on 404, a retryable throw on a 5xx", async () => {
  const gh = await fakeGithub();
  try {
    const api = await userApi(gh.base);
    gh.set(({ path }) => {
      if (path === "/repos/acme/app") return Response.json(repoJson("Acme/App", gh.base, true));
      if (path === "/repos/acme/down") return Response.json({ message: "oops" }, { status: 502 });
      return null;
    });
    assertEquals(await api.describeRepo("acme/app"), {
      fullName: "Acme/App",
      url: `${gh.base}/Acme/App.git`,
      defaultBranch: "main",
      private: true,
    });
    assertEquals(await api.describeRepo("acme/missing"), null);
    const err = await assertRejects(() => api.describeRepo("acme/down"), ForgeApiError);
    assertEquals(err.terminal, false);
  } finally {
    await gh.shutdown();
  }
});

test("a tenant that does not fit the mode is a terminal wiring fault, either way round", async () => {
  const gh = await fakeGithub();
  try {
    const api = await userApi(gh.base);
    const asApp = { repoRef: "acme/app", tenantId: "42" };
    for (
      const call of [
        () => api.postComment(asApp, { kind: "issue", ref: "1" }, "hi"),
        () => api.fetchThread(asApp, { kind: "issue", ref: "1" }),
        () => api.repoVisibility("42", ["acme/app"]),
        () => api.pushAuth(asApp, `${gh.base}/acme/app.git`),
        () => api.fetchAuth(asApp, `${gh.base}/acme/app.git`),
        () =>
          api.openPullRequest(asApp, {
            title: "t",
            body: "",
            head: "h",
            base: "main",
            draft: false,
          }),
      ]
    ) {
      const err = await assertRejects(call, ForgeApiError);
      assert(err.terminal);
      assertStringIncludes(err.message, "never both");
    }
    // Nothing reached GitHub past the boot read.
    assertEquals(gh.calls.length, 1);
  } finally {
    await gh.shutdown();
  }
});

test("the user token is offered to GitHub's own origin and nowhere else", async () => {
  const gh = await fakeGithub();
  try {
    const api = await userApi(gh.base);
    const url = `${gh.base}/acme/app.git`;
    const plain = (auth: FetchAuth | null) => auth && { origin: auth.origin, token: auth.token };
    // The repo's own path, with or without `.git`, in any case GitHub spells it.
    for (const ok of [url, `${gh.base}/acme/app`, `${gh.base}/Acme/App.git`]) {
      assertEquals(plain(await api.fetchAuth(mine("acme/app"), ok)), {
        origin: gh.base,
        token: TOKEN,
      });
      assertEquals(plain(await api.pushAuth(mine("acme/app"), ok)), {
        origin: gh.base,
        token: TOKEN,
      });
    }
    // Another host is fetched as nobody, and refused outright as a push target. So is another
    // repo on GitHub itself — the token reaches it, the row is not it — and anything trailing.
    for (
      const away of [
        "https://evil.example/acme/app.git",
        `${gh.base}/acme/other.git`,
        `${gh.base}/acme/app.git/extra`,
        `${gh.base}/acme/app/../other.git`,
        `${gh.base}/acme/app.git?x=1`,
        `${gh.base}/acme/app.gitx`,
        `${gh.base}/someone/acme/app.git`,
        // Paths that normalise to the repo's, but which git sends as written.
        `${gh.base}/other/x/%2e%2e/%2e%2e/acme/app`,
        `${gh.base}/other/../acme/app.git`,
        `${gh.base}/acme\\app`,
        `${gh.base}/acme/./app`,
        `${gh.base}/acme/%61pp.git`,
      ]
    ) {
      assertEquals(await api.fetchAuth(mine("acme/app"), away), null, away);
      const err = await assertRejects(() => api.pushAuth(mine("acme/app"), away), ForgeApiError);
      assert(err.terminal, away);
      assert(!err.message.includes(TOKEN));
    }
    // A path upstream (dev, tests) has nothing to scope a header to.
    assertEquals(await api.fetchAuth(mine("acme/app"), "/srv/app"), null);
    assertEquals(await api.pushAuth(mine("acme/app"), "/srv/app"), null);
  } finally {
    await gh.shutdown();
  }
});

test("a redirect off GitHub's origin is not followed with the token", async () => {
  const elsewhere: Array<string | null> = [];
  const other = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    elsewhere.push(req.headers.get("authorization"));
    return Response.json(repoJson("acme/app", "x"));
  });
  const gh = await fakeGithub();
  try {
    const api = await userApi(gh.base);
    gh.set(({ path }) => {
      if (path === "/repos/acme/away") {
        return new Response(null, {
          status: 307,
          headers: { location: `http://127.0.0.1:${other.addr.port}/repos/acme/app` },
        });
      }
      // A redirect that stays on GitHub is followed as usual (a renamed repo).
      if (path === "/repos/acme/renamed") {
        return new Response(null, { status: 301, headers: { location: "/repos/acme/app" } });
      }
      if (path === "/repos/acme/app") return Response.json(repoJson("acme/app", gh.base));
      return null;
    });
    await assertRejects(() => api.describeRepo("acme/away"), ForgeApiError);
    assertEquals(elsewhere, []);
    assertEquals((await api.describeRepo("acme/renamed"))?.fullName, "acme/app");
  } finally {
    await gh.shutdown();
    await other.shutdown();
  }
});

test("a 401 re-runs the token command once and retries once — and never loops", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  const gh = await fakeGithub({ tokens: ["tok-1", "tok-2", "tok-3", "tok-4"] });
  try {
    const { command, runs } = await countingCommand(dir);
    const token = commandUserToken({ command, diag: silentDiagnostics(), minRefreshIntervalMs: 0 });
    const api = await userApi(gh.base, token);
    assertEquals(await runs(), 1);
    // GitHub stops accepting tok-1 (the person ran `gh auth refresh`): one command run, one retry.
    let refuseAll = false;
    gh.set(({ method, path, auth }) => {
      if (method !== "POST" || path !== "/repos/acme/app/issues/1/comments") return null;
      if (refuseAll || auth === "Bearer tok-1") {
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      return Response.json({ id: 77 }, { status: 201 });
    });
    const thread = { kind: "issue" as const, ref: "1" };
    assertEquals(await api.postComment(mine("acme/app"), thread, "hi"), { commentId: "77" });
    assertEquals(await runs(), 2);
    const posts = () => gh.calls.filter((c) => c.path === "/repos/acme/app/issues/1/comments");
    assertEquals(posts().map((c) => c.auth), ["Bearer tok-1", "Bearer tok-2"]);

    // A GitHub that refuses every token: one run, one retry, and the 401 is the answer.
    refuseAll = true;
    const err = await assertRejects(
      () => api.postComment(mine("acme/app"), thread, "again"),
      Error,
      "401",
    );
    assert(!err.message.includes("tok-"));
    assertEquals(await runs(), 3);
    assertEquals(posts().length, 4);
  } finally {
    await gh.shutdown();
    await rm(dir, { recursive: true });
  }
});

/** A GitHub that serves `dir` over smart HTTP as `acme/app.git`, to the tokens in `gitValid`
 * only, and answers `GET /user` to the ones in `apiValid`. Records the token every git request
 * carried (null for none). */
async function githubWithGit(dir: string, apiValid: string[], gitValid: Set<string>) {
  const gitAuth: Array<string | null> = [];
  const silent = { debug() {}, warn() {} };
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    const url = new URL(req.url);
    const auth = req.headers.get("authorization");
    if (url.pathname === "/user") {
      return apiValid.includes(auth?.replace(/^Bearer /, "") ?? "")
        ? Response.json({ login: LOGIN })
        : Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    if (!url.pathname.startsWith("/acme/app.git/")) return new Response("nope", { status: 404 });
    const token = auth?.startsWith("Basic ")
      ? atob(auth.slice("Basic ".length)).replace(/^x-access-token:/, "")
      : null;
    gitAuth.push(token);
    if (token === null || !gitValid.has(token)) {
      return new Response("Invalid username or token", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="GitHub"' },
      });
    }
    if (url.pathname.endsWith("/info/refs")) {
      return advertiseRefs(dir, req.headers.get("git-protocol"), silent);
    }
    return uploadPack(dir, req, { maxRequestBytes: 10 * 1024 * 1024, diag: silent });
  });
  return {
    base: `http://127.0.0.1:${server.addr.port}`,
    gitAuth,
    shutdown: () => server.shutdown(),
  };
}

test("git's 401 renews a command token once and the fetch retries — and never loops", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const upstream = `${root}/upstream`;
  const baseSha = await makeUpstream(upstream);
  // The person rotated their token: GitHub's git side now takes tok-2 only.
  const gitValid = new Set(["tok-2"]);
  const gh = await githubWithGit(upstream, ["tok-1", "tok-2"], gitValid);
  try {
    const { command, runs } = await countingCommand(root);
    const token = commandUserToken({ command, diag: silentDiagnostics(), minRefreshIntervalMs: 0 });
    const api = await userApi(gh.base, token);
    assertEquals(await runs(), 1);
    const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });
    const url = `${gh.base}/acme/app.git`;
    const credential = () => credentialFor(api, mine("acme/app"), url, () => {});

    const cached = await cache.refreshBase({ url }, "main", credential());
    assertEquals(await git(cached.dir, "rev-parse", "refs/heads/main"), baseSha);
    assertEquals(await runs(), 2);
    assert(gh.gitAuth.includes("tok-1") && gh.gitAuth.includes("tok-2"));
    // The renewed token is what the next contact presents, with no command run for it.
    gh.gitAuth.length = 0;
    await cache.refreshBase({ url }, "main", credential());
    assertEquals([...new Set(gh.gitAuth)], ["tok-2"]);
    assertEquals(await runs(), 2);

    // GitHub now refuses every token: one more command run, one retry, and the refusal stands.
    gitValid.clear();
    gh.gitAuth.length = 0;
    const err = await assertRejects(
      () => cache.refreshBase({ url }, "main", credential()),
      UpstreamRefused,
    );
    assertEquals(err.reason, "repo");
    assertEquals(await runs(), 3);
    assertEquals([...new Set(gh.gitAuth)], ["tok-2", "tok-3"]);
  } finally {
    await gh.shutdown();
    await rm(root, { recursive: true });
  }
});

test("a renewing git retries a rejected credential once, and nothing else", async () => {
  type Auth = { token: string; refresh?: () => Promise<Auth | null> };
  const seen: string[] = [];
  let refreshes = 0;
  let accepted = "new";
  const auth: Auth = {
    token: "old",
    refresh: () => {
      refreshes++;
      return Promise.resolve({ token: "new" });
    },
  };
  const gitFor = (a: Auth) => (_cwd: string, ...args: string[]) => {
    seen.push(`${a.token}:${args[0]}`);
    if (args[0] === "broken") return Promise.reject(new Error("git broken failed: no such ref"));
    if (a.token !== accepted) {
      return Promise.reject(
        new Error("git push failed (exit 128): fatal: Authentication failed for 'https://x/'"),
      );
    }
    return Promise.resolve("ok");
  };
  const g = renewingGit(auth, gitFor);
  // Concurrent rejections share one renewal; later commands use the renewed credential.
  assertEquals(await Promise.all([g("/", "push"), g("/", "fetch")]), ["ok", "ok"]);
  assertEquals(await g("/", "push"), "ok");
  assertEquals(refreshes, 1);
  assertEquals(seen.filter((s) => s.startsWith("old:")).length, 2);
  // A failure that is not a rejected credential is never retried.
  seen.length = 0;
  await assertRejects(() => renewingGit(auth, gitFor)("/", "broken"), Error, "no such ref");
  assertEquals(seen, ["old:broken"]);
  // The renewed credential rejected too: that is the answer, with no second renewal.
  accepted = "neither";
  seen.length = 0;
  const h = renewingGit(auth, gitFor);
  await assertRejects(() => h("/", "push"), Error, "Authentication failed");
  await assertRejects(() => h("/", "push"), Error, "Authentication failed");
  assertEquals(seen, ["old:push", "new:push", "new:push"]);
  assertEquals(refreshes, 2);
  // No `refresh` (an App token, a static one) and a refresh that answers null both stand.
  seen.length = 0;
  await assertRejects(() => renewingGit({ token: "old" } as Auth, gitFor)("/", "push"));
  await assertRejects(() =>
    renewingGit({ token: "old", refresh: () => Promise.resolve(null) } as Auth, gitFor)("/", "push")
  );
  assertEquals(seen, ["old:push", "old:push"]);
});

test("a static token's 401 is final: no retry", async () => {
  const gh = await fakeGithub();
  try {
    const api = await userApi(gh.base);
    gh.set(({ path }) =>
      path === "/repos/acme/app/issues/1/comments"
        ? Response.json({ message: "Bad credentials" }, { status: 401 })
        : null
    );
    await assertRejects(() => api.postComment(mine("acme/app"), { kind: "issue", ref: "1" }, "x"));
    assertEquals(gh.calls.filter((c) => c.path === "/repos/acme/app/issues/1/comments").length, 1);
  } finally {
    await gh.shutdown();
  }
});

test("user mode posts no check runs: only an App can, so the answer is unsupported up front", async () => {
  const gh = await fakeGithub();
  try {
    const api = await userApi(gh.base);
    const before = gh.calls.length;
    const out = await api.reportChecks(mine("acme/app"), {
      headSha: "a".repeat(40),
      suiteId: "cs-1",
      generation: 1,
      detailsUrl: null,
      suite: { state: "queued", conclusion: null, summary: "queued" },
      checks: [{
        name: "test",
        status: "queued",
        conclusion: null,
        title: "test: queued",
        summary: "queued",
        startedAt: null,
        completedAt: null,
        externalId: "cs-1:1:test",
        forgeRef: null,
      }],
    });
    assertEquals(out.kind, "unsupported");
    assert(out.kind === "unsupported");
    assertStringIncludes(out.reason, "show in ryph but are not posted to GitHub");
    assert(!/Checks: write/.test(out.reason), "no permission a person could grant is named");
    assertEquals(gh.calls.length, before);
  } finally {
    await gh.shutdown();
  }
});

test("user mode: visibility reads each repo, permission asks the repo about the token's own login", async () => {
  const gh = await fakeGithub();
  try {
    const api = await userApi(gh.base);
    let held = { admin: false, push: true, pull: true };
    gh.set(({ path }) => {
      if (path === "/repos/acme/app") {
        return Response.json({ ...repoJson("acme/app", gh.base), permissions: held });
      }
      if (path === "/repos/acme/secret") {
        return Response.json(repoJson("acme/secret", gh.base, true));
      }
      if (path === "/repos/acme/app/collaborators/grace/permission") {
        return Response.json({ permission: "admin" });
      }
      return null;
    });
    const seen = await api.repoVisibility(null, ["acme/app", "acme/secret"]);
    assertEquals([...seen].map(([r, v]) => [r, v.source === "members"]), [
      ["acme/app", false],
      ["acme/secret", true],
    ]);
    assertEquals(gh.calls.some((c) => c.path.startsWith("/installation/")), false);

    assertEquals(await api.checkPermission(mine("acme/app"), "ada-lovelace", "write"), "allowed");
    assertEquals(await api.checkPermission(mine("acme/app"), LOGIN, "admin"), "denied");
    held = { admin: false, push: false, pull: true };
    assertEquals(await api.checkPermission(mine("acme/app"), LOGIN, "write"), "denied");
    assertEquals(await api.checkPermission(mine("acme/gone"), LOGIN, "write"), "denied");
    // Anyone else is asked about through the collaborator endpoint, as in App mode.
    assertEquals(await api.checkPermission(mine("acme/app"), "grace", "admin"), "allowed");
  } finally {
    await gh.shutdown();
  }
});

// ---- the change transport -------------------------------------------------------------------

test("submit in user mode: pushed, the pull request opened as the token, and recognised as ours", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const gh = await fakeGithub();
  try {
    // An upstream on disk (pushed to by path, as every transport test does) and a run's bundle.
    const upstream = `${root}/upstream`;
    const baseSha = await makeUpstream(upstream);
    const ws = `${root}/ws`;
    await git(root, "clone", "--quiet", upstream, ws);
    await git(ws, "checkout", "--quiet", "-b", "ryph/ada/r-1");
    await writeFile(`${ws}/fix.txt`, "fixed\n");
    await git(ws, "add", ".");
    await commit(ws, "fix the thing");
    const headSha = await git(ws, "rev-parse", "HEAD");
    const bundlePath = `${root}/staged.bundle`;
    await git(ws, "bundle", "create", bundlePath, `${baseSha}..refs/heads/ryph/ada/r-1`);

    const api = await userApi(gh.base);
    gh.set(({ method, path }) => {
      if (method === "POST" && path === "/repos/acme/app/pulls") {
        return Response.json({ number: 9, html_url: `${gh.base}/acme/app/pull/9` }, {
          status: 201,
        });
      }
      if (method === "GET" && path === "/repos/acme/app/pulls/9") {
        return Response.json({
          state: "open",
          merged: false,
          head: { sha: headSha, ref: "ryph/ada/r-1" },
          base: { ref: "main" },
          // GitHub's spelling of the person's login, which need not match the token read's case.
          user: { login: "ada-lovelace", type: "User" },
        });
      }
      if (method === "GET" && path === "/repos/acme/app/pulls/10") {
        return Response.json({
          state: "open",
          merged: false,
          head: { sha: headSha, ref: "x" },
          base: { ref: "main" },
          user: { login: "grace", type: "User" },
        });
      }
      return null;
    });
    const diag = silentDiagnostics();
    const transport = githubChangeTransport({
      api,
      cache: localFsRepoCache({ root: `${root}/cache`, diag }),
      diag,
    });
    const delivery = {
      repo: mine("acme/app"),
      repoUrl: upstream,
      bundlePath,
      branchName: "ryph/ada/r-1",
      baseBranch: "main",
      headSha,
      title: "Fix the thing",
      description: "It was broken.",
      embeds: [],
      draft: false,
      existingRef: null,
    };
    assertEquals(await transport.deliver(delivery), {
      kind: "delivered",
      ref: "9",
      url: `${gh.base}/acme/app/pull/9`,
    });
    assertEquals(await git(upstream, "rev-parse", "refs/heads/ryph/ada/r-1"), headSha);
    const opened = gh.calls.find((c) => c.method === "POST" && c.path === "/repos/acme/app/pulls");
    assertEquals(opened?.auth, `Bearer ${TOKEN}`);

    assertEquals((await api.readChangeRequestState(mine("acme/app"), "9"))?.openedByUs, true);
    assertEquals((await api.readChangeRequestState(mine("acme/app"), "10"))?.openedByUs, false);

    // An upstream that is not GitHub is refused before anything is pushed, terminally.
    const away = await transport.deliver({
      ...delivery,
      repoUrl: "https://evil.example/acme/app.git",
    });
    assertEquals(away.kind, "failed");
    assert(away.kind === "failed" && away.terminal);
    // And so is a repo that names an installation.
    const asApp = await transport.deliver({
      ...delivery,
      repo: { repoRef: "acme/app", tenantId: "42" },
    });
    assert(asApp.kind === "failed" && asApp.terminal);
    assertEquals(gh.calls.filter((c) => c.path === "/repos/acme/app/pulls").length, 1);
  } finally {
    await gh.shutdown();
    await rm(root, { recursive: true });
  }
});

// ---- the service surface --------------------------------------------------------------------

const SERVICE_TOKEN = "service-secret";

async function serviceFor(root: string, api: GithubUserForge | null, appMode = false) {
  const diag = silentDiagnostics();
  const stagingDir = `${root}/staging`;
  await mkdir(stagingDir, { recursive: true });
  const cache = localFsRepoCache({ root: `${root}/cache`, diag });
  return makeHandler({
    keys: { resolve: () => Promise.resolve(null) },
    cache,
    patches: localFsPatchStore(`${root}/patches`, diag),
    diag,
    forges: providerRegistry({ github: api }, "forge API"),
    transports: providerRegistry(
      { github: api === null ? null : githubChangeTransport({ api, cache, diag }) },
      "change transport",
    ),
    // App mode, for the routes that must refuse it: an App surface whose methods never run.
    githubApp: appMode
      ? {
        getInstallationSettingsUrl: () => Promise.reject(new Error("unused")),
        describeInstallation: () => Promise.reject(new Error("unused")),
        signIn: true,
        exchangeOAuthCode: () => Promise.reject(new Error("unused")),
        checkOrgMembership: () => Promise.resolve("unknown" as const),
        describeSubscriptions: () => Promise.reject(new Error("unused")),
      }
      : null,
    githubUser: appMode ? null : api,
    serviceToken: SERVICE_TOKEN,
    config: { maxUploadPackBytes: 1024, maxBundleBytes: 1024 * 1024, stagingDir },
  });
}

const call = (
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
) =>
  handler(
    new Request(`http://forge${path}`, {
      method,
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

test("the service surface in user mode: mode, repo listing, describe — and 501 for the App's routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const gh = await fakeGithub();
  try {
    const api = await userApi(gh.base);
    gh.set(({ path }) => {
      if (path.startsWith("/user/repos?")) {
        return Response.json([
          { ...repoJson("acme/app", gh.base), permissions: { admin: true, push: true } },
          { ...repoJson("acme/read", gh.base), permissions: { admin: false, pull: true } },
        ]);
      }
      if (path === "/repos/acme/app") return Response.json(repoJson("Acme/App", gh.base, true));
      if (path === "/repos/acme/down") return Response.json({ message: "oops" }, { status: 500 });
      return null;
    });
    const handler = await serviceFor(root, api);

    assertEquals(await (await call(handler, "GET", "/v1/service/providers")).json(), {
      providers: ["github"],
      github: { mode: "user", login: LOGIN },
      gitlab: null,
      radicle: null,
    });

    const listed = await call(handler, "GET", "/v1/service/github/repos");
    assertEquals(listed.status, 200);
    assertEquals(await listed.json(), {
      repos: [{
        fullName: "acme/app",
        url: `${gh.base}/acme/app.git`,
        defaultBranch: "main",
        private: false,
        admin: true,
      }, {
        fullName: "acme/read",
        url: `${gh.base}/acme/read.git`,
        defaultBranch: "main",
        private: false,
        admin: false,
      }],
    });

    const described = await call(handler, "POST", "/v1/service/github/describe", {
      repoRef: "acme/app",
    });
    assertEquals(described.status, 200);
    assertEquals((await described.json()).fullName, "Acme/App");

    const missing = await call(handler, "POST", "/v1/service/github/describe", {
      repoRef: "acme/missing",
    });
    assertEquals(missing.status, 404);
    assertEquals((await missing.json()).terminal, true);

    const down = await call(handler, "POST", "/v1/service/github/describe", {
      repoRef: "acme/down",
    });
    assertEquals(down.status, 502);
    assertEquals((await down.json()).terminal, false);

    for (const repoRef of ["acme", "../etc/passwd", "acme/app/x", "acme/.."]) {
      const bad = await call(handler, "POST", "/v1/service/github/describe", { repoRef });
      assertEquals(bad.status, 400, repoRef);
    }

    // The App's routes do not exist in user mode, as with no App at all.
    for (
      const [path, body] of [
        ["/v1/service/installation", { installationId: "42" }],
        ["/v1/service/installation-settings", { installationId: "42" }],
        ["/v1/service/org-membership", { provider: "github", installationId: "42", login: "ada" }],
        ["/v1/service/oauth/exchange", { provider: "github", code: "abc" }],
      ] as const
    ) {
      assertEquals((await call(handler, "POST", path, body)).status, 501, path);
    }

    // Nothing any route answered carries the token.
    for (const c of gh.calls) assertEquals(c.auth, `Bearer ${TOKEN}`);
  } finally {
    await gh.shutdown();
    await rm(root, { recursive: true });
  }
});

test("the merge poll's read in user mode: a pull request's fate and the base it merged into, the token renewed on a 401, only for the service", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  const gh = await fakeGithub({ tokens: ["tok-1", "tok-2"] });
  try {
    const { command, runs } = await countingCommand(dir);
    const token = commandUserToken({ command, diag: silentDiagnostics(), minRefreshIntervalMs: 0 });
    const api = await userApi(gh.base, token);
    const pull = (state: string, merged: boolean, base: string, login = LOGIN) => ({
      state,
      merged,
      head: { sha: "a".repeat(40) },
      base: { ref: base },
      user: { login, type: "User" },
    });
    gh.set(({ method, path, auth }) => {
      if (method !== "GET" || !path.startsWith("/repos/acme/app/pulls/")) return null;
      // The person renewed their token since the forge read it.
      if (auth === "Bearer tok-1") {
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      // Stacked on feature-a, merged into release/2: GitHub's base at the merge.
      if (path.endsWith("/5")) return Response.json(pull("closed", true, "release/2"));
      if (path.endsWith("/6")) return Response.json(pull("closed", false, "main", "grace"));
      if (path.endsWith("/7")) return Response.json(pull("open", false, "main"));
      if (path.endsWith("/9")) return Response.json({ message: "oops" }, { status: 502 });
      return null;
    });
    const handler = await serviceFor(root, api);
    const read = (ref: string) =>
      call(handler, "POST", "/v1/service/change-request-head", {
        repo: { provider: "github", repoRef: "acme/app", tenantId: null },
        ref,
      });

    const merged = await read("5");
    assertEquals(merged.status, 200);
    assertEquals(await merged.json(), {
      ref: "5",
      state: "closed",
      merged: true,
      headSha: "a".repeat(40),
      authorHeadSha: "a".repeat(40),
      baseRef: "release/2",
      openedByUs: true,
      // What merged: the head GitHub froze at the merge, which the poll's settle is judged on.
      mergedHeads: ["a".repeat(40)],
    });
    const pulls = () => gh.calls.filter((c) => c.path.startsWith("/repos/acme/app/pulls/"));
    assertEquals(pulls().map((c) => c.auth), ["Bearer tok-1", "Bearer tok-2"]);
    assertEquals(await runs(), 2);

    const closed = await (await read("6")).json();
    assertEquals([closed.state, closed.merged, closed.openedByUs], ["closed", false, false]);
    assertEquals(closed.mergedHeads, []);
    const open = await (await read("7")).json();
    assertEquals([open.state, open.merged], ["open", false]);
    // Gone is final; a GitHub that cannot answer is worth asking again.
    const gone = await read("8");
    assertEquals([gone.status, (await gone.json()).terminal], [404, true]);
    const down = await read("9");
    assertEquals([down.status, (await down.json()).terminal], [502, false]);
    assertEquals(await runs(), 2);

    // Nobody but the control plane asks: no bearer, or the wrong one, reads nothing of GitHub.
    const asked = gh.calls.length;
    for (const authorization of [null, "Bearer not-the-service"]) {
      const res = await handler(
        new Request("http://forge/v1/service/change-request-head", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authorization === null ? {} : { authorization }),
          },
          body: JSON.stringify({
            repo: { provider: "github", repoRef: "acme/app", tenantId: null },
            ref: "5",
          }),
        }),
      );
      assertEquals(res.status, 401, String(authorization));
    }
    assertEquals(gh.calls.length, asked);
  } finally {
    await gh.shutdown();
    await rm(root, { recursive: true });
    await rm(dir, { recursive: true });
  }
});

test("the user-mode routes answer 501 in App mode and with no GitHub", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const gh = await fakeGithub();
  try {
    const api = await userApi(gh.base);
    const app = await serviceFor(root, api, true);
    assertEquals((await (await call(app, "GET", "/v1/service/providers")).json()).github, {
      mode: "app",
      signIn: true,
    });
    assertEquals((await call(app, "GET", "/v1/service/github/repos")).status, 501);
    assertEquals(
      (await call(app, "POST", "/v1/service/github/describe", { repoRef: "acme/app" })).status,
      501,
    );
    const none = await serviceFor(root, null);
    assertEquals((await (await call(none, "GET", "/v1/service/providers")).json()).github, null);
    assertEquals((await call(none, "GET", "/v1/service/github/repos")).status, 501);
  } finally {
    await gh.shutdown();
    await rm(root, { recursive: true });
  }
});

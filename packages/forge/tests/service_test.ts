// Door ③'s service surface through the pure handler: real adapters on temp dirs, real git,
// a fake ForgeApi — the seam the orchestrator's httpForge dials, honored end to end.

import { test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { MAX_SERVICE_BODY_BYTES } from "../src/http/service.ts";
import { anonymous } from "../src/ports/repo_cache.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import type {
  Audience,
  ChangeRequestHead,
  ForgeApi,
  RepoVisibility,
} from "../src/ports/forge_api.ts";
import { ForgeApiError, providerRegistry } from "../src/ports/forge_api.ts";
import type { GithubAppApi, GithubDelivery } from "../src/ports/github_app.ts";
import { githubChangeTransport } from "../src/adapters/change_transport/github.ts";
import { git } from "../src/helpers/git_exec.ts";
import { fakeRunImages } from "../src/adapters/run_images/fake.ts";
import { commit, makeUpstream, silentDiagnostics } from "./util.ts";

const SERVICE_TOKEN = "service-secret";

function fakeForgeApi(): ForgeApi & GithubAppApi & GithubDelivery & {
  prs: Array<Record<string, string>>;
  reactions: Array<Record<string, string>>;
  updates: Array<Record<string, string>>;
  /** The change requests the forge would describe, by ref — a test sets and moves them. */
  pulls: Map<string, ChangeRequestHead>;
} {
  const prs: Array<Record<string, string>> = [];
  const reactions: Array<Record<string, string>> = [];
  const updates: Array<Record<string, string>> = [];
  const pulls = new Map<string, ChangeRequestHead>();
  return {
    upstreamUrl: (_repo: unknown, url: string) => url,
    prs,
    reactions,
    updates,
    pulls,
    pushAuth: (_repo, url) =>
      Promise.resolve(
        /^https?:\/\//.test(url) ? { origin: new URL(url).origin, token: "ghs_fake" } : null,
      ),
    fetchAuth: () => Promise.resolve(null),
    // GitHub's rule, over the same pulls a test sets: a pull request's head is the repo's own
    // exactly when its head repo is the connected one.
    classifyBranch: (repo, branch) => {
      const pull = /^pull\/(\d+)\/head$/.exec(branch);
      if (pull === null) return Promise.resolve("branch" as const);
      const head = pulls.get(pull[1]);
      if (head === undefined) {
        return Promise.reject(new ForgeApiError(`no pull request #${pull[1]}`, true));
      }
      return Promise.resolve(head.headRepoRef === repo.repoRef ? "branch" as const : "foreign");
    },
    // "404" is not there, "503" is the forge having a minute, and anything else reads back
    // from the pulls a test set — or, unset, an open pull request someone else opened.
    readChangeRequestState: (_repo, ref) => {
      if (ref === "404") return Promise.resolve(null);
      if (ref === "503") return Promise.reject(new ForgeApiError("GitHub is down", false));
      const pull = pulls.get(ref);
      return Promise.resolve({
        ref,
        state: pull?.state ?? "open",
        merged: pull?.merged ?? false,
        headSha: pull?.headSha ?? "b".repeat(40),
        authorHeadSha: pull?.authorHeadSha ?? "b".repeat(40),
        baseRef: pull?.baseRef ?? "main",
        openedByUs: false,
        mergedHeads: pull?.merged === true ? [pull.headSha ?? "b".repeat(40)] : [],
      });
    },
    describeChangeRequest: (_repo, ref) => {
      const pull = pulls.get(ref);
      return pull === undefined
        ? Promise.reject(new ForgeApiError(`no pull request #${ref}`, true))
        : Promise.resolve(structuredClone(pull));
    },
    openPullRequest(repo, params) {
      const repoFullName = repo.repoRef;
      prs.push({ repo: repoFullName, ...params, draft: String(params.draft) });
      return Promise.resolve({ number: 42, url: `https://gh/${repoFullName}/pull/42` });
    },
    postComment: () => Promise.resolve({ commentId: "1001" }),
    updateComment(repo, commentId, body) {
      updates.push({ repoRef: repo.repoRef, commentId, body });
      return Promise.resolve();
    },
    addReaction(repo, commentId, reaction) {
      reactions.push({ repoRef: repo.repoRef, commentId, reaction });
      return Promise.resolve();
    },
    checkPermission: () => Promise.resolve("allowed" as const),
    checkOrgMembership: (_installationId, login) =>
      Promise.resolve(login === "outsider" ? "not-member" as const : "member" as const),
    // Door ⑤'s methods — the service surface never calls them.
    repoVisibility(tenantId: string | null, repoRefs: string[]) {
      // "acme/app" is public, anything named "*-private" is private, "acme/down" does not answer,
      // and "acme/mute" answers without naming the repo asked about.
      if (tenantId === null) return Promise.reject(new ForgeApiError("no installation", true));
      if (repoRefs.includes("acme/down")) return Promise.reject(new Error("GitHub is down"));
      if (repoRefs.includes("acme/mute")) return Promise.resolve(new Map<string, RepoVisibility>());
      // "*-code-private" is a project whose code alone is members-only: private to read, its
      // issues and change requests written in public. "*-internal" is read by every account on
      // its instance, and so is what is written there.
      const audienceOf = (r: string): Audience =>
        r.endsWith("-private") ? "members" : r.endsWith("-internal") ? "instance" : "public";
      return Promise.resolve(
        new Map(repoRefs.map((r) => {
          const written = r.endsWith("-code-private") ? "public" : audienceOf(r);
          return [r, {
            source: audienceOf(r),
            target: { issue: written, change_request: written },
          }];
        })),
      );
    },
    repoLabels: () => Promise.reject(new Error("not used here")),
    closeIssue: () => Promise.reject(new Error("not used here")),
    threadKind: () => Promise.reject(new Error("not used here")),
    listIssues: () => Promise.reject(new Error("not used here")),
    listChangeRequests: () => Promise.reject(new Error("not used here")),
    listChangeRequestFiles: () => Promise.reject(new Error("not used here")),
    listChangeRequestCommits: () => Promise.reject(new Error("not used here")),
    readChecks: () => Promise.reject(new Error("not used here")),
    reportChecks: () =>
      Promise.resolve({ kind: "unsupported" as const, reason: "not in this test" }),
    createIssue: () => Promise.reject(new Error("not used here")),
    createComment: () => Promise.reject(new Error("not used here")),
    addLabels: () => Promise.reject(new Error("not used here")),
    listChangeRequestPatches: () => Promise.reject(new Error("not used here")),
    createReview: () => Promise.reject(new Error("not used here")),
    replyToReviewComment: () => Promise.reject(new Error("not used here")),
    resolveReviewThread: () => Promise.reject(new Error("not used here")),
    findMarkedWrite: () => Promise.reject(new Error("not used here")),
    fetchThread: (_repo, thread) =>
      thread.ref === "404"
        ? Promise.reject(new ForgeApiError("no such thread", true))
        : Promise.resolve({
          kind: thread.kind,
          ref: thread.ref,
          title: "Flaky scheduler test",
          body: "It fails about one run in five.",
          authorLogin: "ada",
          createdAt: "2026-01-01T00:00:00Z",
          state: "open",
          entries: [{
            kind: "comment" as const,
            authorLogin: "grace",
            body: "Only on CI.",
            createdAt: "2026-01-02T00:00:00Z",
            state: null,
            location: null,
          }],
          truncated: false,
          changeRequest: null,
        }),
    getInstallationSettingsUrl: (id) =>
      Promise.resolve(`https://github.com/organizations/acme/settings/installations/${id}`),
    describeInstallation: (id) =>
      Promise.resolve({
        accountLogin: "acme",
        settingsUrl: `https://github.com/organizations/acme/settings/installations/${id}`,
        repos: [{
          fullName: `acme/app-${id}`,
          url: "https://gh/acme/app.git",
          defaultBranch: "main",
          private: true,
        }],
      }),
    describeSubscriptions: () =>
      Promise.resolve({ app: { events: [], permissions: {} }, installations: [] }),
    signIn: true,
    exchangeOAuthCode: (code) =>
      code === "good"
        ? Promise.resolve({
          accountId: "1",
          login: "ada",
          name: "Ada",
          verifiedEmails: ["ada@example.com"],
          accessToken: "gho_x",
        })
        : Promise.reject(new ForgeApiError("bad code", true)),
  };
}

async function buildService(root: string) {
  const diag = silentDiagnostics();
  const stagingDir = `${root}/staging`;
  await mkdir(stagingDir, { recursive: true });
  const patches = localFsPatchStore(`${root}/patches`, diag);
  const forgeApi = fakeForgeApi();
  const cache = localFsRepoCache({ root: `${root}/cache`, diag });
  const deps: AppDeps = {
    keys: { resolve: () => Promise.resolve(null) }, // the git doors are irrelevant here
    cache,
    patches,
    diag,
    forges: providerRegistry({ github: forgeApi }, "forge API"),
    transports: providerRegistry(
      { github: githubChangeTransport({ api: forgeApi, cache, diag }) },
      "change transport",
    ),
    githubApp: forgeApi,
    serviceToken: SERVICE_TOKEN,
    // One run's one screenshot, for the bodies the orchestrator sends on with a `runId`.
    images: fakeRunImages({
      "r-1": [{
        ref: "img-3f9a1c0b2d4e",
        attachmentId: "att-1",
        mime: "image/png",
        url: "https://ryph.test/images/r-1/att-1",
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      }],
    }),
    config: { maxUploadPackBytes: 1024, maxBundleBytes: 1024 * 1024, stagingDir },
  };
  return { handler: makeHandler(deps), patches, forgeApi, deps };
}

const post = (
  handler: (req: Request) => Promise<Response>,
  path: string,
  body: unknown,
  token: string | null = SERVICE_TOKEN,
) =>
  handler(
    new Request(`http://forge${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    }),
  );

test("installation settings: authenticated, validated, App-only, and upstream failures are 502", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler, forgeApi, deps } = await buildService(root);
    const path = "/v1/service/installation-settings";
    const body = { installationId: "42" };
    for (const token of [null, "wrong"]) {
      assertEquals((await post(handler, path, body, token)).status, 401);
    }
    for (const invalid of [{}, { installationId: "" }, { installationId: 42 }]) {
      assertEquals((await post(handler, path, invalid)).status, 400);
    }
    const response = await post(handler, path, body);
    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      url: "https://github.com/organizations/acme/settings/installations/42",
    });
    forgeApi.getInstallationSettingsUrl = () => Promise.reject(new Error("GitHub unavailable"));
    const failed = await post(handler, path, body);
    assertEquals(failed.status, 502);
    assertEquals(await failed.json(), { error: "GitHub unavailable" });
    const noApp = makeHandler({ ...deps, githubApp: null });
    assertEquals((await post(noApp, path, body)).status, 501);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service JSON byte cap refuses before a forge write and keeps auth first", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler, forgeApi } = await buildService(root);
    const value = new TextEncoder().encode(JSON.stringify({
      repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
      commentId: "1001",
      body: "é",
    }));
    const request = (size: number, token = SERVICE_TOKEN) => {
      const bytes = new Uint8Array(size).fill(32);
      bytes.set(value);
      return new Request("http://forge/v1/service/comment/update", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
      });
    };
    const over = await handler(request(MAX_SERVICE_BODY_BYTES + 1));
    assertEquals(over.status, 413);
    const error = await over.json();
    assertEquals(error.terminal, true);
    assertStringIncludes(error.error, `${MAX_SERVICE_BODY_BYTES}-byte`);
    assertEquals(forgeApi.updates, []);
    assertEquals((await handler(request(MAX_SERVICE_BODY_BYTES + 1, "wrong"))).status, 401);
    assertEquals(forgeApi.updates, []);
    assertEquals((await handler(request(MAX_SERVICE_BODY_BYTES))).status, 204);
    assertEquals(forgeApi.updates.length, 1);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("submit: bundle from the store → branch on the upstream → PR opened with the report", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler, patches, forgeApi, deps } = await buildService(root);

    // The world phase 1 leaves behind: an upstream, a primed cache, a stored bundle.
    const upstream = `${root}/upstream`;
    const baseSha = await makeUpstream(upstream);
    await deps.cache.refreshBase({ url: upstream }, "main", anonymous);
    const ws = `${root}/ws`;
    await mkdir(ws);
    await git(ws, "clone", "--quiet", "--", upstream, ".");
    await git(ws, "checkout", "--quiet", "-b", "ryph/ada/r-1");
    await writeFile(`${ws}/work.txt`, "work\n");
    await git(ws, "add", ".");
    await commit(ws, "do the work");
    const headSha = await git(ws, "rev-parse", "HEAD");
    const staged = `${root}/staged.bundle`;
    await git(ws, "bundle", "create", staged, `${baseSha}..refs/heads/ryph/ada/r-1`);
    await patches.put(`r-1/${headSha}.bundle`, staged);

    const submission = {
      bundleKey: `r-1/${headSha}.bundle`,
      branchName: "ryph/ada/r-1",
      headSha,
      repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
      repoUrl: upstream,
      baseBranch: "main",
      title: "Fix the flaky test",
      body: "![the fixed page](img-3f9a1c0b2d4e)\n\n> **Provenance:** requested by **@ada**.",
      runId: "r-1",
    };
    const res = await post(handler, "/v1/service/submit", submission);
    assertEquals(res.status, 201);
    assertEquals(await res.json(), { ref: "42", url: "https://gh/acme/app/pull/42" });

    // The branch really landed, at exactly the recorded head.
    assertEquals(await git(upstream, "rev-parse", "refs/heads/ryph/ada/r-1"), headSha);
    // The PR carried the report (the provenance block included) and the right coordinates.
    assertEquals(forgeApi.prs.length, 1);
    assertEquals(forgeApi.prs[0].head, "ryph/ada/r-1");
    assertEquals(forgeApi.prs[0].base, "main");
    assertStringIncludes(forgeApi.prs[0].body, "Provenance");
    // The run's screenshot, as a link behind ryph's login — never an image GitHub would proxy.
    assertStringIncludes(
      forgeApi.prs[0].body,
      "[Image: the fixed page](https://ryph.test/images/r-1/att-1)",
    );

    // A retried submission converges: git re-push is a no-op, the PR adopts.
    const retry = await post(handler, "/v1/service/submit", submission);
    assertEquals(retry.status, 201);
  } finally {
    await rm(root, { recursive: true });
  }
});

/** A pull request's branch on the upstream, primed in the cache, and the stored bundle of a
 * run that built on its tip — the world a command on a pull request leaves behind. */
async function pullWorld(root: string, svc: Awaited<ReturnType<typeof buildService>>) {
  const upstream = `${root}/upstream`;
  await makeUpstream(upstream);
  const author = `${root}/author`;
  await mkdir(author);
  await git(author, "clone", "--quiet", "--", upstream, ".");
  await git(author, "checkout", "--quiet", "-b", "feat/x");
  await writeFile(`${author}/feature.txt`, "the feature\n");
  await git(author, "add", ".");
  await commit(author, "start the feature");
  await git(author, "push", "--quiet", "origin", "feat/x");
  const tipSha = await git(author, "rev-parse", "HEAD");
  await svc.deps.cache.refreshBase({ url: upstream }, "feat/x", anonymous);

  const ws = `${root}/ws`;
  await mkdir(ws);
  await git(ws, "clone", "--quiet", "--branch", "feat/x", "--", upstream, ".");
  await git(ws, "checkout", "--quiet", "-b", "ryph/ada/r-1");
  await writeFile(`${ws}/review.txt`, "addressed\n");
  await git(ws, "add", ".");
  await commit(ws, "address the review");
  const headSha = await git(ws, "rev-parse", "HEAD");
  const staged = `${root}/staged.bundle`;
  await git(ws, "bundle", "create", staged, `${tipSha}..refs/heads/ryph/ada/r-1`);
  await svc.patches.put(`r-1/${headSha}.bundle`, staged);

  const pull: ChangeRequestHead = {
    ref: "7",
    url: "https://gh/acme/app/pull/7",
    state: "open",
    merged: false,
    headRef: "feat/x",
    commitCount: null,
    headSha: tipSha,
    authorHeadSha: tipSha,
    headRepoRef: "acme/app",
    baseRef: "main",
    defaultBranch: "main",
  };
  svc.forgeApi.pulls.set("7", pull);
  const submission = {
    bundleKey: `r-1/${headSha}.bundle`,
    branchName: "ryph/ada/r-1",
    headSha,
    repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
    repoUrl: upstream,
    baseBranch: "feat/x",
    title: "Address the review (#7)",
    body: "> **Provenance:** requested by **@ada** via a /ryph command.",
    changeRequest: "7",
  };
  return { upstream, tipSha, headSha, pull, submission };
}

test("submit onto a pull request: the commits land on its branch, and nothing new is opened", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const svc = await buildService(root);
    const { upstream, headSha, pull, submission } = await pullWorld(root, svc);

    const res = await post(svc.handler, "/v1/service/submit", submission);
    assertEquals(res.status, 201);
    // The patch's forge identity is the pull request it went into.
    assertEquals(await res.json(), { ref: "7", url: "https://gh/acme/app/pull/7" });
    assertEquals(await git(upstream, "rev-parse", "refs/heads/feat/x"), headSha);
    assertEquals(svc.forgeApi.prs.length, 0, "no pull request is opened for a pull request");

    // GitHub now reports the run's head as the pull request's; a retry converges on it.
    svc.forgeApi.pulls.set("7", { ...pull, headSha });
    const retry = await post(svc.handler, "/v1/service/submit", submission);
    assertEquals(retry.status, 201);
    assertEquals(await git(upstream, "rev-parse", "refs/heads/feat/x"), headSha);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("submit onto a pull request asks again at push time — and refuses what changed, terminally, saying when it ended", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const svc = await buildService(root);
    const { upstream, tipSha, pull, submission } = await pullWorld(root, svc);

    const changed: Array<[string, ChangeRequestHead | null]> = [
      ["has been closed", { ...pull, state: "closed" }],
      ["has been merged", { ...pull, state: "closed", merged: true }],
      // A fork's branch, with nothing saying ryph may push there.
      ["lives in the fork stranger/app", { ...pull, headRepoRef: "stranger/app" }],
      ["lived in a fork that has since been deleted", { ...pull, headRepoRef: null }],
      ["is now feat/y", { ...pull, headRef: "feat/y" }],
      // The default branch moved onto this one since the command; the live answer wins.
      ["is now acme/app's default branch", { ...pull, defaultBranch: "feat/x" }],
      ["no pull request #7", null],
    ];
    for (const [why, now] of changed) {
      if (now === null) svc.forgeApi.pulls.delete("7");
      else svc.forgeApi.pulls.set("7", now);
      const res = await post(svc.handler, "/v1/service/submit", submission);
      assertEquals(res.status, 422, why);
      const body = await res.json();
      assertEquals(body.terminal, true, why);
      assertStringIncludes(body.error, why);
      // A change request that ended says how, so the control plane can go and hear it.
      assertEquals(
        body.ended,
        why === "has been merged" ? "merged" : why === "has been closed" ? "closed" : undefined,
        why,
      );
      // Nothing was pushed onto anybody's branch.
      assertEquals(await git(upstream, "rev-parse", "refs/heads/feat/x"), tipSha, why);
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

/** A fork's pull request #7: the contributor's branch feat/x lives in a fork of the upstream,
 * and the upstream keeps its head as `refs/pull/7/head`, as GitHub does. The run built on that
 * head through the base repo's cache; its bundle is stored. */
async function forkWorld(root: string, svc: Awaited<ReturnType<typeof buildService>>) {
  const upstream = `${root}/upstream`;
  await makeUpstream(upstream);
  const fork = `${root}/fork.git`;
  await git(root, "clone", "--quiet", "--bare", "--", upstream, fork);
  const author = `${root}/author`;
  await mkdir(author);
  await git(author, "clone", "--quiet", "--", fork, ".");
  await git(author, "checkout", "--quiet", "-b", "feat/x");
  await writeFile(`${author}/feature.txt`, "the contributor's feature\n");
  await git(author, "add", ".");
  await commit(author, "start the feature");
  await git(author, "push", "--quiet", "origin", "feat/x");
  const tipSha = await git(author, "rev-parse", "HEAD");
  await git(upstream, "fetch", "--quiet", "--", fork, "+refs/heads/feat/x:refs/pull/7/head");
  await svc.deps.cache.refreshBase({ url: upstream }, "refs/pull/7/head", anonymous);

  const ws = `${root}/ws`;
  await mkdir(ws);
  await git(ws, "clone", "--quiet", "--", upstream, ".");
  await git(ws, "fetch", "--quiet", "origin", "+refs/pull/7/head:refs/heads/pull/7/head");
  await git(ws, "checkout", "--quiet", "-b", "ryph/ada/r-1", "pull/7/head");
  await writeFile(`${ws}/review.txt`, "addressed\n");
  await git(ws, "add", ".");
  await commit(ws, "address the review");
  const headSha = await git(ws, "rev-parse", "HEAD");
  const staged = `${root}/staged.bundle`;
  await git(ws, "bundle", "create", staged, `${tipSha}..refs/heads/ryph/ada/r-1`);
  await svc.patches.put(`r-1/${headSha}.bundle`, staged);

  const pull: ChangeRequestHead = {
    ref: "7",
    url: "https://gh/acme/app/pull/7",
    state: "open",
    merged: false,
    headRef: "feat/x",
    commitCount: null,
    headSha: tipSha,
    authorHeadSha: tipSha,
    headRepoRef: "stranger/app",
    headRepoUrl: fork,
    headRepoDefaultBranch: "main",
    maintainerCanModify: true,
    baseRef: "main",
    defaultBranch: "main",
  };
  svc.forgeApi.pulls.set("7", pull);
  const submission = {
    bundleKey: `r-1/${headSha}.bundle`,
    branchName: "ryph/ada/r-1",
    headSha,
    repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
    repoUrl: upstream,
    baseBranch: "pull/7/head",
    title: "Address the review (#7)",
    body: "> **Provenance:** requested by **@ada** via a /ryph command.",
    changeRequest: "7",
    allowForkPush: true,
  };
  return { upstream, fork, tipSha, headSha, pull, submission };
}

test("submit onto a fork's pull request pushes to the fork's branch, and nowhere else", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const svc = await buildService(root);
    const { upstream, fork, headSha, submission } = await forkWorld(root, svc);

    const res = await post(svc.handler, "/v1/service/submit", submission);
    assertEquals(res.status, 201);
    assertEquals(await res.json(), { ref: "7", url: "https://gh/acme/app/pull/7" });
    assertEquals(await git(fork, "rev-parse", "refs/heads/feat/x"), headSha);
    // Nothing landed in the base repo, and no pull request was opened.
    assertEquals(
      (await git(upstream, "for-each-ref", "--format=%(refname)", "refs/heads/")).split("\n"),
      ["refs/heads/main"],
    );
    assertEquals(svc.forgeApi.prs.length, 0);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("submit onto a fork's pull request asks every question again at push time, and refuses terminally", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const svc = await buildService(root);
    const { fork, tipSha, pull, submission } = await forkWorld(root, svc);

    const cases: Array<[string, ChangeRequestHead | null, Record<string, unknown>]> = [
      // The repo's switch, as the control plane read it when it submitted.
      ["pushing to fork branches is not enabled for acme/app", pull, { allowForkPush: false }],
      ["pushing to fork branches is not enabled for acme/app", pull, { allowForkPush: undefined }],
      // The author withdrew maintainer edits while the run worked.
      ["does not allow edits from maintainers", { ...pull, maintainerCanModify: false }, {}],
      ["does not allow edits from maintainers", { ...pull, maintainerCanModify: undefined }, {}],
      ["lived in a fork that has since been deleted", { ...pull, headRepoRef: null }, {}],
      ["has been closed", { ...pull, state: "closed" }, {}],
      ["has been merged", { ...pull, state: "closed", merged: true }, {}],
      ["on that fork's default branch", { ...pull, headRepoDefaultBranch: "feat/x" }, {}],
      // Its name is the fork author's: refused without being repeated (asserted below).
      ["on a branch whose name ryph cannot push to", { ...pull, headRef: "pull/1/head" }, {}],
      // A run on a pull request's head delivers onto that pull request, or not at all.
      ["delivers only onto its own change request", pull, { changeRequest: undefined }],
      ["delivers only onto its own change request", pull, { changeRequest: "8" }],
      ["did not say which branch is that fork's default", {
        ...pull,
        headRepoDefaultBranch: null,
      }, {}],
      // A run that did not start from the pull request's head never pushes onto it.
      ["the run did not start from it", pull, { baseBranch: "main" }],
      ["the run did not start from it", pull, { baseBranch: "feat/x" }],
      // A fork URL off the connected repo's origin is not one the credential goes to.
      ["gave no URL for the fork", { ...pull, headRepoUrl: "https://elsewhere.test/x.git" }, {}],
      ["gave no URL for the fork", { ...pull, headRepoUrl: null }, {}],
    ];
    for (const [why, now, override] of cases) {
      if (now === null) svc.forgeApi.pulls.delete("7");
      else svc.forgeApi.pulls.set("7", now);
      const res = await post(svc.handler, "/v1/service/submit", { ...submission, ...override });
      assertEquals(res.status, 422, why);
      const body = await res.json();
      assertEquals(body.terminal, true, why);
      assertStringIncludes(body.error, why);
      assertEquals(body.error.includes("pull/1/head"), false, why);
      assertEquals(await git(fork, "rev-parse", "refs/heads/feat/x"), tipSha, why);
      assertEquals(svc.forgeApi.prs.length, 0, why);
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("submit onto a fork's pull request in user mode is refused terminally: the token is the base repo's", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const svc = await buildService(root);
    const { upstream, fork, tipSha, submission } = await forkWorld(root, svc);
    // What githubForgeApi's pushAuth does with a user token: the connected repo's own URL gets
    // the token, any other repo's — the fork's — is refused, terminally.
    const asked: string[] = [];
    const own = svc.forgeApi.pushAuth;
    svc.forgeApi.pushAuth = (repo, url) => {
      asked.push(url);
      if (url === upstream) return own(repo, url);
      return Promise.reject(
        new ForgeApiError(
          `${repo.repoRef}'s upstream ${url} is not that repo on GitHub — a user token is ` +
            "presented to GitHub, for the repo it was asked about, and nowhere else",
          true,
        ),
      );
    };
    const res = await post(svc.handler, "/v1/service/submit", submission);
    assertEquals(res.status, 422);
    const body = await res.json();
    assertEquals(body.terminal, true);
    assertStringIncludes(body.error, "no credential here may push to the fork stranger/app");
    // Asked for the fork's URL, and nothing pushed anywhere.
    assert(asked.includes(fork));
    assertEquals(await git(fork, "rev-parse", "refs/heads/feat/x"), tipSha);
    assertEquals(svc.forgeApi.prs.length, 0);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("submit onto a fork's pull request whose branch moved is refused, not overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const svc = await buildService(root);
    const { fork, pull, submission } = await forkWorld(root, svc);
    // The contributor pushed while the run worked: the forge now reports their new head.
    const author = `${root}/author`;
    await writeFile(`${author}/more.txt`, "more\n");
    await git(author, "add", ".");
    await commit(author, "more work");
    await git(author, "push", "--quiet", "origin", "feat/x");
    const moved = await git(author, "rev-parse", "HEAD");
    svc.forgeApi.pulls.set("7", { ...pull, headSha: moved, authorHeadSha: moved });
    const res = await post(svc.handler, "/v1/service/submit", submission);
    assertEquals(res.status, 422);
    assertStringIncludes((await res.json()).error, "moved while the run worked");
    assertEquals(await git(fork, "rev-parse", "refs/heads/feat/x"), moved);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("submit onto a fork's pull request whose branch was rewritten says it moved", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const svc = await buildService(root);
    const { upstream, fork, pull, submission } = await forkWorld(root, svc);
    // The contributor force-pushed a rewritten branch while the run worked, and the base repo's
    // copy of the head followed. With no cache entry left to borrow from, the base the bundle
    // needs is simply gone.
    const author = `${root}/author`;
    await git(author, "reset", "--quiet", "--hard", "main");
    await writeFile(`${author}/other.txt`, "a different feature\n");
    await git(author, "add", ".");
    await commit(author, "start over");
    await git(author, "push", "--quiet", "--force", "origin", "feat/x");
    const moved = await git(author, "rev-parse", "HEAD");
    await git(upstream, "fetch", "--quiet", "--", fork, "+refs/heads/feat/x:refs/pull/7/head");
    const cached = await svc.deps.cache.find({ url: upstream }, "refs/pull/7/head");
    if (cached !== null) await rm(cached.dir, { recursive: true });
    svc.forgeApi.pulls.set("7", { ...pull, headSha: moved, authorHeadSha: moved });
    const res = await post(svc.handler, "/v1/service/submit", submission);
    assertEquals(res.status, 422);
    const body = await res.json();
    assertEquals(body.terminal, true);
    assertStringIncludes(body.error, "moved while the run worked (rewritten or force-pushed)");
    assertEquals(await git(fork, "rev-parse", "refs/heads/feat/x"), moved);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("submit: a missing bundle is gone-and-terminal; bad auth never reaches the store", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler } = await buildService(root);
    const submission = {
      bundleKey: "r-9/deadbeef.bundle",
      branchName: "ryph/ada/r-9",
      headSha: "a".repeat(40),
      repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
      repoUrl: "https://gh/acme/app.git",
      baseBranch: "main",
      title: "t",
      body: "b",
    };
    const gone = await post(handler, "/v1/service/submit", submission);
    assertEquals(gone.status, 410);
    assertEquals((await gone.json()).terminal, true);

    assertEquals((await post(handler, "/v1/service/submit", submission, "wrong")).status, 401);
    assertEquals((await post(handler, "/v1/service/submit", submission, null)).status, 401);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("permission, installation, and oauth routes answer through the port", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler } = await buildService(root);

    const permission = await post(handler, "/v1/service/permission", {
      repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
      subject: "ada",
      atLeast: "write",
    });
    assertEquals(await permission.json(), { permission: "allowed" });

    const installation = await post(handler, "/v1/service/installation", {
      installationId: "42",
    });
    const described = await installation.json();
    assertEquals(described.accountLogin, "acme");
    assertEquals(
      described.settingsUrl,
      "https://github.com/organizations/acme/settings/installations/42",
    );
    assertEquals(described.repos[0].fullName, "acme/app-42");

    const good = await post(handler, "/v1/service/oauth/exchange", {
      provider: "github",
      code: "good",
    });
    assertEquals(await good.json(), {
      accountId: "1",
      login: "ada",
      name: "Ada",
      verifiedEmails: ["ada@example.com"],
      accessToken: "gho_x",
    });
    const bad = await post(handler, "/v1/service/oauth/exchange", {
      provider: "github",
      code: "bad",
    });
    assertEquals(bad.status, 502);
    await bad.body?.cancel();

    const member = await post(handler, "/v1/service/org-membership", {
      provider: "github",
      installationId: "42",
      login: "ada",
    });
    assertEquals(await member.json(), { membership: "member" });
    const outsider = await post(handler, "/v1/service/org-membership", {
      provider: "github",
      installationId: "42",
      login: "outsider",
    });
    assertEquals(await outsider.json(), { membership: "not-member" });
  } finally {
    await rm(root, { recursive: true });
  }
});

test("thread route: the conversation crosses whole, and terminality crosses with it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler } = await buildService(root);

    const read = await post(handler, "/v1/service/thread", {
      repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
      thread: { kind: "issue", ref: "7" },
    });
    assertEquals(read.status, 200);
    const thread = await read.json();
    assertEquals(thread.title, "Flaky scheduler test");
    assertEquals(thread.body, "It fails about one run in five.");
    assertEquals(thread.entries.length, 1);
    assertEquals(thread.entries[0].authorLogin, "grace");

    // A deleted thread is a 404 that SAYS it is terminal: the orchestrator must be able to
    // tell "no redelivery finds this" from "GitHub is having a minute".
    const gone = await post(handler, "/v1/service/thread", {
      repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
      thread: { kind: "issue", ref: "404" },
    });
    assertEquals(gone.status, 404);
    assertEquals((await gone.json()).terminal, true);

    // And a repo name that could walk an API path never reaches the adapter.
    const refused = await post(handler, "/v1/service/thread", {
      repo: { provider: "github", repoRef: "acme/../../evil", tenantId: "42" },
      thread: { kind: "issue", ref: "7" },
    });
    assertEquals(refused.status, 400);
    await refused.body?.cancel();
  } finally {
    await rm(root, { recursive: true });
  }
});

test("change-request-head: the lean read answers the head, or 404 when gone, or 502", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler } = await buildService(root);
    const repo = { provider: "github", repoRef: "acme/app", tenantId: "42" };

    const read = await post(handler, "/v1/service/change-request-head", { repo, ref: "7" });
    assertEquals(read.status, 200);
    assertEquals(await read.json(), {
      ref: "7",
      state: "open",
      merged: false,
      headSha: "b".repeat(40),
      authorHeadSha: "b".repeat(40),
      baseRef: "main",
      openedByUs: false,
      mergedHeads: [],
    });

    const gone = await post(handler, "/v1/service/change-request-head", { repo, ref: "404" });
    assertEquals(gone.status, 404);
    assertEquals((await gone.json()).terminal, true);

    const down = await post(handler, "/v1/service/change-request-head", { repo, ref: "503" });
    assertEquals(down.status, 502);
    assertEquals((await down.json()).terminal, false);

    // The same ingest rules as every other route: a thread a path could be walked with, and a
    // body this version cannot read, never reach the adapter.
    for (
      const body of [{ repo, ref: "../7" }, { repo, thread: { kind: "change_request", ref: "7" } }]
    ) {
      const refused = await post(handler, "/v1/service/change-request-head", body);
      assertEquals(refused.status, 400, JSON.stringify(body));
      await refused.body?.cancel();
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("comment routes: posting returns the id; update and reaction address it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler, forgeApi } = await buildService(root);

    const posted = await post(handler, "/v1/service/comment", {
      repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
      thread: { kind: "issue", ref: "7" },
      body: "working on it",
    });
    assertEquals(posted.status, 201);
    assertEquals(await posted.json(), { commentId: "1001" });

    const updated = await post(handler, "/v1/service/comment/update", {
      repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
      commentId: "1001",
      body: "still working on it",
    });
    assertEquals(updated.status, 204);
    assertEquals(forgeApi.updates, [
      { repoRef: "acme/app", commentId: "1001", body: "still working on it" },
    ]);

    const reacted = await post(handler, "/v1/service/reaction", {
      repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
      commentId: "555",
      reaction: "eyes",
    });
    assertEquals(reacted.status, 204);
    assertEquals(forgeApi.reactions, [
      { repoRef: "acme/app", commentId: "555", reaction: "eyes" },
    ]);

    // A non-numeric comment id never reaches the adapter.
    const refused = await post(handler, "/v1/service/reaction", {
      repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
      commentId: "../evil",
      reaction: "eyes",
    });
    assertEquals(refused.status, 400);
    await refused.body?.cancel();
    assertEquals(forgeApi.reactions.length, 1);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a body the orchestrator sends on renders its run's images, and refuses others", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler, forgeApi } = await buildService(root);
    const repo = { provider: "github", repoRef: "acme/app", tenantId: "42" };

    const updated = await post(handler, "/v1/service/comment/update", {
      repo,
      commentId: "1001",
      body: "Done. ![after](img-3f9a1c0b2d4e)",
      runId: "r-1",
    });
    assertEquals(updated.status, 204);
    assertEquals(forgeApi.updates, [{
      repoRef: "acme/app",
      commentId: "1001",
      body: "Done. [Image: after](https://ryph.test/images/r-1/att-1)",
    }]);

    // A ref the run does not hold is terminal: no retry makes it the run's.
    const unknown = await post(handler, "/v1/service/comment", {
      repo,
      thread: { kind: "issue", ref: "7" },
      body: "![x](img-000000000000)",
      runId: "r-1",
    });
    assertEquals(unknown.status, 422);
    const refusal = await unknown.json();
    assertEquals(refusal.terminal, true);
    assertStringIncludes(refusal.error, "img-000000000000");

    // A body with refs and no run to resolve them against is refused rather than guessed at.
    const orphan = await post(handler, "/v1/service/comment", {
      repo,
      thread: { kind: "issue", ref: "7" },
      body: "![x](img-3f9a1c0b2d4e)",
    });
    assertEquals(orphan.status, 422);
    await orphan.body?.cancel();

    // A submission is refused before its bundle is even looked for.
    const submitted = await post(handler, "/v1/service/submit", {
      bundleKey: "r-1/missing.bundle",
      branchName: "ryph/ada/r-1",
      headSha: "a".repeat(40),
      repo,
      repoUrl: "https://gh/acme/app.git",
      baseBranch: "main",
      title: "Fix",
      body: "![x](img-000000000000)",
      runId: "r-1",
    });
    assertEquals(submitted.status, 422);
    await submitted.body?.cancel();
    assertEquals(forgeApi.updates.length, 1);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("visibility answers public or private from the forge, and 502 when it cannot", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler } = await buildService(root);
    const ask = async (repoRef: string, tenantId: string | null = "42") => {
      const res = await post(handler, "/v1/service/visibility", {
        repo: { provider: "github", repoRef, tenantId },
      });
      return { status: res.status, body: await res.json() };
    };
    assertEquals(await ask("acme/app"), { status: 200, body: { visibility: "public" } });
    assertEquals(await ask("acme/app-private"), { status: 200, body: { visibility: "private" } });
    // The chat door asks about a run's SOURCE: code kept to members is private, however public
    // the project's issues are.
    assertEquals(await ask("acme/app-code-private"), {
      status: 200,
      body: { visibility: "private" },
    });
    // A public channel's audience is the public: a source every account on the instance reads
    // (GitLab's `internal`) is no public source.
    assertEquals(await ask("acme/app-internal"), { status: 200, body: { visibility: "private" } });
    // Never a guess: an outage, an answer that skipped the repo, and a refusal are all 502s.
    assertEquals((await ask("acme/down")).status, 502);
    assertEquals((await ask("acme/mute")).status, 502);
    const refused = await ask("acme/app", null);
    assertEquals(refused.status, 502);
    assertEquals(refused.body.terminal, true);
    // Service-authenticated like every other route here.
    const anonymous = await post(handler, "/v1/service/visibility", {
      repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
    }, "wrong");
    assertEquals(anonymous.status, 401);
    await anonymous.body?.cancel();
  } finally {
    await rm(root, { recursive: true });
  }
});

test("without a GitHub App, the service surface is not even mounted", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { deps } = await buildService(root);
    const dark = makeHandler({ ...deps, forges: null, transports: null, githubApp: null });
    const res = await post(dark, "/v1/service/permission", {
      repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
      subject: "ada",
      atLeast: "write",
    });
    assertEquals(res.status, 404);
    await res.body?.cancel();
  } finally {
    await rm(root, { recursive: true });
  }
});

// ── the provider-aware half of door ③ ────────────────────────────────────────────────────────
//
// What the control plane asks before it offers anybody a connect form, and the three Radicle
// questions a connect flow needs answered. Wired with a bridge, and without one.

const RID = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";

const get = (
  handler: (req: Request) => Promise<Response>,
  path: string,
  token: string | null = SERVICE_TOKEN,
) =>
  handler(
    new Request(`http://forge${path}`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    }),
  );

test("the providers this deployment runs are the registry's own answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler } = await buildService(root);
    assertEquals((await get(handler, "/v1/service/providers")).status, 200);
    // A GitHub that is not in user mode is an App's.
    assertEquals(await (await get(handler, "/v1/service/providers")).json(), {
      providers: ["github"],
      github: { mode: "app", signIn: true },
      gitlab: null,
      radicle: null,
    });
    // Service-authenticated like every other route here.
    assertEquals((await get(handler, "/v1/service/providers", "wrong")).status, 401);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an App without an OAuth client says it has no sign-in and redeems no code", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { deps, forgeApi } = await buildService(root);
    const handler = makeHandler({ ...deps, githubApp: { ...forgeApi, signIn: false } });
    assertEquals((await (await get(handler, "/v1/service/providers")).json()).github, {
      mode: "app",
      signIn: false,
    });
    const refused = await post(handler, "/v1/service/oauth/exchange", {
      provider: "github",
      code: "good",
    });
    assertEquals(refused.status, 501);
    assertStringIncludes((await refused.json()).error, "RYPH_GITHUB_CLIENT_ID");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the Radicle routes answer 501 with no bridge, and the bridge's own words with one", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { deps } = await buildService(root);
    const dark = makeHandler(deps);
    for (const path of ["/v1/service/radicle/repo", "/v1/service/radicle/seed"]) {
      assertEquals((await post(dark, path, { repoRef: RID })).status, 501);
    }
    assertEquals((await get(dark, "/v1/service/radicle/identity")).status, 501);

    const seeded: string[] = [];
    const doc = { rid: RID, name: "payments", defaultBranch: "main", delegates: [] };
    const lit = makeHandler({
      ...deps,
      radicle: {
        mode: "user",
        identity: () =>
          Promise.resolve({
            did: "did:key:z6Mk",
            nid: "z6Mk",
            alias: "ryph",
            node: null,
            mode: "user" as const,
          }),
        describeRepo: () => Promise.resolve(doc as never),
        seedRepo: (rid: string) => {
          seeded.push(rid);
          return Promise.resolve(
            rid === RID ? { kind: "seeded" as const, repo: doc as never } : {
              kind: "unavailable" as const,
              rid,
              did: "did:key:z6Mk",
              command: "rad id update --allow did:key:z6Mk",
              seeds: 0,
              triedSeeds: 0,
              reason: "no connected peer answered",
            },
          );
        },
        unseedRepo: () => Promise.resolve(),
      },
    });
    assertEquals(await (await post(lit, "/v1/service/radicle/seed", { repoRef: RID })).json(), doc);
    assertEquals(seeded, [RID]);
    // How the bridge acts is part of the providers answer: the control plane gates connecting on
    // a bridge that signs as one person.
    assertEquals((await (await get(lit, "/v1/service/providers")).json()).radicle, {
      mode: "user",
    });

    // A seed the network handed nothing back for is the bridge's 409, forwarded whole: the
    // connect flow answers it with a command rather than with "not found".
    const other = "rad:z2ug5mwNKZB8KGpBDRTrWHAMbvHCu";
    const unavailable = await post(lit, "/v1/service/radicle/seed", { repoRef: other });
    assertEquals(unavailable.status, 409);
    assertEquals(await unavailable.json(), {
      kind: "unavailable",
      rid: other,
      did: "did:key:z6Mk",
      command: "rad id update --allow did:key:z6Mk",
      seeds: 0,
      triedSeeds: 0,
      reason: "no connected peer answered",
    });
    assertEquals(
      (await (await get(lit, "/v1/service/radicle/identity")).json()).did,
      "did:key:z6Mk",
    );
    assertEquals(
      await (await post(lit, "/v1/service/radicle/unseed", { repoRef: RID })).json(),
      { unseeded: true },
    );
    // A repo address this forge could not have produced never reaches the bridge.
    assertEquals(
      (await post(lit, "/v1/service/radicle/repo", { repoRef: "acme/app" })).status,
      400,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("GitLab's doors answer 501 where no GitLab runs, after checking what they were sent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { handler } = await buildService(root);
    const projects = await get(handler, "/v1/service/gitlab/projects");
    assertEquals(projects.status, 501);
    assertEquals(await projects.json(), { error: "no GitLab is configured" });
    for (
      const [path, body] of [
        ["/v1/service/gitlab/describe", { project: "acme/platform/app" }],
        ["/v1/service/gitlab/describe", { project: "42" }],
        ["/v1/service/gitlab/hook-token", { projectId: "42", generation: 1 }],
        ["/v1/service/org-membership", {
          provider: "gitlab",
          accountId: "1001@https://gitlab.example",
        }],
        ["/v1/service/gitlab/user", { accountId: "1001@https://gitlab.example" }],
        ["/v1/service/oauth/exchange", {
          provider: "gitlab",
          code: "c",
          redirectUri: "https://ryph.example/gitlab/callback",
        }],
      ] as const
    ) {
      const res = await post(handler, path, body);
      assertEquals(res.status, 501, path);
      await res.body?.cancel();
    }
    // A body no GitLab could take is a 400 first.
    for (
      const [path, body] of [
        ["/v1/service/gitlab/describe", { project: "../etc" }],
        ["/v1/service/gitlab/hook-token", { projectId: "4/2", generation: 1 }],
      ] as const
    ) {
      const res = await post(handler, path, body);
      assertEquals(res.status, 400, path);
      await res.body?.cancel();
    }
    // Service-authenticated like every other route here.
    assertEquals((await get(handler, "/v1/service/gitlab/projects", "wrong")).status, 401);
  } finally {
    await rm(root, { recursive: true });
  }
});

// The GitLab change transport against real git on temp dirs and a fake adapter (the
// `GitlabDelivery` half plus `describeChangeRequest`): path upstreams for the delivery itself,
// and a smart-HTTP stub where what matters is what git presented — the `oauth2` Basic framing —
// and what GitLab answered. Each case mirrors one of the GitHub transport's (service_test.ts),
// plus GitLab's own: `mr-<iid>` refs, `merge-requests/<iid>/head`, and the merge-rights rule a
// fork push meets.

import { test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { serve } from "@ryph/service";
import { gitlabChangeTransport } from "../src/adapters/change_transport/gitlab.ts";
import type { ChangeDelivery, ChangeDeliveryOutcome } from "../src/ports/change_transport.ts";
import {
  type ChangeRequestHead,
  type ForgeApi,
  ForgeApiError,
  type ForgeRepo,
} from "../src/ports/forge_api.ts";
import type { GitlabDelivery } from "../src/ports/gitlab.ts";
import { anonymous, type FetchAuth } from "../src/ports/repo_cache.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { type Git, git } from "../src/helpers/git_exec.ts";
import { advertiseRefs, uploadPack } from "../src/helpers/http_backend.ts";
import { commit, makeUpstream, silentDiagnostics } from "./util.ts";

const PROJECT = "acme/platform/app";
const REPO: ForgeRepo = { repoRef: PROJECT, tenantId: null, forgeId: "42@https://gitlab.test" };
/** Where the fake GitLab places project 42 now: the upstream the delivery being built names. */
let placed = "";
const LINE = "ryph/ada/r-1/work";

type OpenParams = Parameters<GitlabDelivery["openMergeRequest"]>[1];

/** What the transport asks of the GitLab adapter, and nothing more. `openMergeRequest` is
 * idempotent per source branch, as the real one is through its adopt-on-409: the same head
 * answers the same merge request. */
function fakeGitlab() {
  const opened: OpenParams[] = [];
  const pushAuthAsked: string[] = [];
  const mrs = new Map<string, ChangeRequestHead>();
  const bySource = new Map<string, number>();
  let nextIid = 1;
  const api = {
    pushAuth(_repo: ForgeRepo, url: string): Promise<FetchAuth | null> {
      pushAuthAsked.push(url);
      return Promise.resolve(
        /^https?:\/\//.test(url)
          ? { origin: new URL(url).origin, token: "glpat-fake", basicUser: "oauth2" }
          : null,
      );
    },
    openMergeRequest(_repo: ForgeRepo, params: OpenParams) {
      opened.push(params);
      const key = `${params.head}→${params.base}`;
      const iid = bySource.get(key) ?? nextIid++;
      bySource.set(key, iid);
      return Promise.resolve({
        ref: `mr-${iid}`,
        url: `https://gitlab.test/${PROJECT}/-/merge_requests/${iid}`,
      });
    },
    locateUpstream(repo: ForgeRepo & { forgeId: string }) {
      return repo.forgeId === REPO.forgeId
        ? Promise.resolve({ url: placed, repoRef: PROJECT })
        : Promise.reject(new ForgeApiError(`no project ${repo.forgeId}`, true));
    },
    describeChangeRequest(_repo: ForgeRepo, ref: string) {
      const mr = mrs.get(ref);
      return mr === undefined
        ? Promise.reject(new ForgeApiError(`no merge request ${ref}`, true))
        : Promise.resolve(structuredClone(mr));
    },
  };
  return {
    api: api as unknown as ForgeApi & GitlabDelivery & typeof api,
    opened,
    pushAuthAsked,
    mrs,
  };
}

type Fake = ReturnType<typeof fakeGitlab>;

function transportFor(root: string, fake: Fake, gitExec?: Git) {
  const diag = silentDiagnostics();
  const cache = localFsRepoCache({ root: `${root}/cache`, diag });
  return {
    cache,
    transport: gitlabChangeTransport({
      api: fake.api,
      cache,
      diag,
      ...(gitExec === undefined ? {} : { git: gitExec }),
    }),
  };
}

/** A run's bundle of one line, built in a clone of `upstream` from `from` (a ref the clone can
 * check out) — the stored bundle a submission hands the transport. */
async function bundleOf(
  root: string,
  upstream: string,
  opts: { line?: string; from?: string; fetch?: string; file?: string } = {},
) {
  const line = opts.line ?? LINE;
  const ws = await mkdtemp(join(root, "ws-"));
  await git(ws, "clone", "--quiet", "--", upstream, ".");
  if (opts.fetch !== undefined) await git(ws, "fetch", "--quiet", "origin", opts.fetch);
  const from = opts.from ?? "main";
  const baseSha = await git(ws, "rev-parse", from);
  await git(ws, "checkout", "--quiet", "-b", line, from);
  await writeFile(`${ws}/${opts.file ?? "work.txt"}`, `${line}\n`);
  await git(ws, "add", ".");
  await commit(ws, `work on ${line}`);
  const headSha = await git(ws, "rev-parse", "HEAD");
  const bundlePath = `${ws}.bundle`;
  await git(ws, "bundle", "create", bundlePath, `${baseSha}..refs/heads/${line}`);
  return { headSha, bundlePath, baseSha };
}

function delivery(
  over: Partial<ChangeDelivery> & { repoUrl: string; headSha: string; bundlePath: string },
): ChangeDelivery {
  placed = over.repoUrl;
  return {
    repo: REPO,
    branchName: LINE,
    baseBranch: "main",
    title: "Fix the scheduler",
    description: "It was flaky.",
    embeds: [],
    draft: false,
    existingRef: null,
    ...over,
  };
}

function assertFailed(
  out: ChangeDeliveryOutcome,
  terminal: boolean,
  includes: string,
): asserts out is Extract<ChangeDeliveryOutcome, { kind: "failed" }> {
  assertEquals(out.kind, "failed", includes);
  assert(out.kind === "failed");
  assertEquals(out.terminal, terminal, `${includes}: ${out.message}`);
  assertStringIncludes(out.message, includes);
}

async function withRoot(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ryph-gl-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true });
  }
}

// ---- a new merge request --------------------------------------------------------------------

test("a new line: the branch lands on the project, the MR is opened, and a retry converges", async () => {
  await withRoot(async (root) => {
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    const fake = fakeGitlab();
    const { transport, cache } = transportFor(root, fake);
    await cache.refreshBase({ url: upstream }, "main", anonymous);
    const { headSha, bundlePath } = await bundleOf(root, upstream);

    const change = delivery({ repoUrl: upstream, headSha, bundlePath, draft: true });
    assertEquals(await transport.deliver(change), {
      kind: "delivered",
      ref: "mr-1",
      url: `https://gitlab.test/${PROJECT}/-/merge_requests/1`,
    });
    assertEquals(await git(upstream, "rev-parse", `refs/heads/${LINE}`), headSha);
    assertEquals(fake.opened, [{
      title: "Fix the scheduler",
      body: "It was flaky.",
      head: LINE,
      base: "main",
      draft: true,
    }]);
    // A path upstream asks for a credential and is given none.
    assertEquals(fake.pushAuthAsked, [upstream]);

    // The same bundle again: git's re-push is a no-op, the adapter adopts the open MR.
    assertEquals(await transport.deliver(change), {
      kind: "delivered",
      ref: "mr-1",
      url: `https://gitlab.test/${PROJECT}/-/merge_requests/1`,
    });
    assertEquals(await git(upstream, "rev-parse", `refs/heads/${LINE}`), headSha);
    assertEquals(fake.opened.length, 2, "asked again, and answered the same MR");
  });
});

test("several lines of one run open several merge requests, one per line, none on another's branch", async () => {
  await withRoot(async (root) => {
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    const fake = fakeGitlab();
    const { transport } = transportFor(root, fake);
    const work = await bundleOf(root, upstream, { line: "ryph/ada/r-1/work", file: "a.txt" });
    const docs = await bundleOf(root, upstream, { line: "ryph/ada/r-1/docs", file: "b.txt" });
    // A later generation of the first line: its own branch, its own MR.
    const work2 = await bundleOf(root, upstream, { line: "ryph/ada/r-1/work-2", file: "c.txt" });

    const outs = [];
    for (
      const [line, b] of [["ryph/ada/r-1/work", work], ["ryph/ada/r-1/docs", docs], [
        "ryph/ada/r-1/work-2",
        work2,
      ]] as const
    ) {
      outs.push(
        await transport.deliver(
          delivery({
            repoUrl: upstream,
            branchName: line,
            headSha: b.headSha,
            bundlePath: b.bundlePath,
          }),
        ),
      );
      assertEquals(await git(upstream, "rev-parse", `refs/heads/${line}`), b.headSha);
    }
    assertEquals(outs.map((o) => o.kind === "delivered" ? o.ref : o.kind), [
      "mr-1",
      "mr-2",
      "mr-3",
    ]);
    assertEquals(fake.opened.map((p) => p.head), [
      "ryph/ada/r-1/work",
      "ryph/ada/r-1/docs",
      "ryph/ada/r-1/work-2",
    ]);
    assertEquals(await git(upstream, "rev-parse", "refs/heads/main"), work.baseSha);
  });
});

test("a head that is not the one intake recorded never leaves, and is terminal", async () => {
  await withRoot(async (root) => {
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    const fake = fakeGitlab();
    const { transport } = transportFor(root, fake);
    const { bundlePath } = await bundleOf(root, upstream);
    const out = await transport.deliver(
      delivery({ repoUrl: upstream, headSha: "f".repeat(40), bundlePath }),
    );
    assertEquals(out.kind, "failed");
    assert(out.kind === "failed" && out.terminal);
    assertEquals(
      await git(upstream, "for-each-ref", "--format=%(refname)", "refs/heads/"),
      "refs/heads/main",
    );
    assertEquals(fake.opened.length, 0);
  });
});

test("the credential and the MR call keep their terminality", async () => {
  await withRoot(async (root) => {
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    const fake = fakeGitlab();
    const { transport } = transportFor(root, fake);
    const { headSha, bundlePath } = await bundleOf(root, upstream);
    const change = delivery({ repoUrl: upstream, headSha, bundlePath });
    const pushAuth = fake.api.pushAuth;

    // A URL off the instance: the adapter's terminal refusal, in its own words.
    fake.api.pushAuth = () =>
      Promise.reject(new ForgeApiError("https://evil.example is not this GitLab", true));
    assertFailed(await transport.deliver(change), true, "is not this GitLab");
    // A token command that failed for now.
    fake.api.pushAuth = () => Promise.reject(new Error("vault sealed"));
    assertFailed(await transport.deliver(change), false, "could not obtain a GitLab token");
    assertEquals(
      await git(upstream, "for-each-ref", "--format=%(refname)", "refs/heads/"),
      "refs/heads/main",
    );
    fake.api.pushAuth = pushAuth;

    // The branch is pushed, then opening the MR fails: retried, or not, as the adapter said.
    const open = fake.api.openMergeRequest;
    fake.api.openMergeRequest = () =>
      Promise.reject(new ForgeApiError("GitLab answered 502", false));
    assertFailed(await transport.deliver(change), false, "502");
    fake.api.openMergeRequest = () =>
      Promise.reject(new ForgeApiError("no open MR for this source branch to adopt", true));
    assertFailed(await transport.deliver(change), true, "to adopt");
    fake.api.openMergeRequest = open;
    const ok = await transport.deliver(change);
    assertEquals(ok.kind === "delivered" && ok.ref, "mr-1");
  });
});

// ---- the push credential, as git presents it --------------------------------------------------

/** A GitLab that serves `dir` over smart HTTP as `acme/platform/app.git` to the tokens in
 * `valid`, and refuses every push (receive-pack) the way GitLab refuses an account that may not
 * push there. Records each git request's Basic user and token. */
async function gitlabWithGit(dir: string, valid: Set<string>) {
  const seen: Array<{ user: string; token: string } | null> = [];
  const silent = { debug() {}, warn() {} };
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(`/${PROJECT}.git/`)) return new Response("nope", { status: 404 });
    const auth = req.headers.get("authorization");
    const pair = auth?.startsWith("Basic ") ? atob(auth.slice("Basic ".length)) : null;
    const colon = pair?.indexOf(":") ?? -1;
    const who = pair === null || pair === undefined || colon < 0
      ? null
      : { user: pair.slice(0, colon), token: pair.slice(colon + 1) };
    seen.push(who);
    if (who === null || !valid.has(who.token)) {
      return new Response("HTTP Basic: Access denied", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="GitLab"' },
      });
    }
    const receive = url.searchParams.get("service") === "git-receive-pack" ||
      url.pathname.endsWith("/git-receive-pack");
    if (receive) {
      return new Response("You are not allowed to push code to this project.", {
        status: 403,
        headers: { "content-type": "text/plain" },
      });
    }
    if (url.pathname.endsWith("/info/refs")) {
      return advertiseRefs(dir, req.headers.get("git-protocol"), silent);
    }
    return uploadPack(dir, req, { maxRequestBytes: 10 * 1024 * 1024, diag: silent });
  });
  return {
    url: `http://127.0.0.1:${server.addr.port}/${PROJECT}.git`,
    seen,
    shutdown: () => server.shutdown(),
  };
}

test("git presents the token as Basic oauth2, renews it once on a 401, and GitLab's 403 is final", async () => {
  await withRoot(async (root) => {
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    // The token was rotated: the instance takes glpat-2 only.
    const gl = await gitlabWithGit(upstream, new Set(["glpat-2"]));
    try {
      const fake = fakeGitlab();
      let refreshes = 0;
      fake.api.pushAuth = (_repo, url) => {
        fake.pushAuthAsked.push(url);
        return Promise.resolve({
          origin: new URL(url).origin,
          token: "glpat-1",
          basicUser: "oauth2",
          refresh: () => {
            refreshes++;
            return Promise.resolve({
              origin: new URL(url).origin,
              token: "glpat-2",
              basicUser: "oauth2",
            });
          },
        });
      };
      const { transport } = transportFor(root, fake);
      const { headSha, bundlePath } = await bundleOf(root, upstream);
      const out = await transport.deliver(delivery({ repoUrl: gl.url, headSha, bundlePath }));

      // The base was fetched with the renewed token; the push was refused for want of
      // permission, terminally, in words that say so — and no MR was opened.
      assertFailed(out, true, `GitLab refused the push of the branch ${LINE} to ${PROJECT}`);
      assertStringIncludes(out.message, "not a Developer");
      assertEquals(refreshes, 1);
      assertEquals(fake.opened.length, 0);
      const users = new Set(gl.seen.map((s) => s?.user));
      assertEquals([...users], ["oauth2"], "every git request is framed as oauth2");
      assertEquals([...new Set(gl.seen.map((s) => s?.token))], ["glpat-1", "glpat-2"]);
    } finally {
      await gl.shutdown();
    }
  });
});

// ---- onto an existing merge request -----------------------------------------------------------

/** An open MR `mr-7` whose source branch `feat/x` lives in the project itself, primed in the
 * cache, and the bundle of a run that built on its tip. */
async function mrWorld(root: string) {
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

  const fake = fakeGitlab();
  const { transport, cache } = transportFor(root, fake);
  await cache.refreshBase({ url: upstream }, "feat/x", anonymous);
  const { headSha, bundlePath } = await bundleOf(root, upstream, { from: "origin/feat/x" });
  const mr: ChangeRequestHead = {
    ref: "mr-7",
    url: `https://gitlab.test/${PROJECT}/-/merge_requests/7`,
    state: "open",
    merged: false,
    headRef: "feat/x",
    headSha: tipSha,
    authorHeadSha: tipSha,
    baseRef: "main",
    // GitLab's paths fold case: the project's own branch, however it is spelled back.
    headRepoRef: "Acme/Platform/App",
    headRepoUrl: upstream,
    headRepoDefaultBranch: "main",
    maintainerCanModify: false,
    commitCount: null,
    defaultBranch: "main",
  };
  fake.mrs.set("mr-7", mr);
  const change = delivery({
    repoUrl: upstream,
    headSha,
    bundlePath,
    baseBranch: "feat/x",
    title: "Address the review (!7)",
    existingRef: "mr-7",
  });
  return { upstream, tipSha, headSha, mr, fake, transport, change };
}

test("onto a merge request: the commits land on its branch, and nothing new is opened", async () => {
  await withRoot(async (root) => {
    const { upstream, headSha, mr, fake, transport, change } = await mrWorld(root);
    assertEquals(await transport.deliver(change), {
      kind: "delivered",
      ref: "mr-7",
      url: mr.url,
    });
    assertEquals(await git(upstream, "rev-parse", "refs/heads/feat/x"), headSha);
    assertEquals(fake.opened.length, 0, "no merge request is opened for a merge request");
    // The run's own line branch was never published: the commits went onto the MR's.
    assertEquals(
      (await git(upstream, "for-each-ref", "--format=%(refname)", "refs/heads/")).split("\n"),
      ["refs/heads/feat/x", "refs/heads/main"],
    );

    // GitLab now reports the run's head as the MR's; a retry converges on it.
    fake.mrs.set("mr-7", { ...mr, headSha, authorHeadSha: headSha });
    const retry = await transport.deliver(change);
    assertEquals(retry.kind, "delivered");
    assertEquals(await git(upstream, "rev-parse", "refs/heads/feat/x"), headSha);
    // Moved between the project's lookup and the merge request's: its own, by GitLab's ids.
    fake.mrs.set("mr-7", {
      ...mr,
      headSha,
      authorHeadSha: headSha,
      headRepoRef: "x/moved",
      sameRepo: true,
    });
    assertEquals((await transport.deliver(change)).kind, "delivered");
  });
});

test("onto a merge request asks again at push time — and refuses what changed, terminally, saying when it ended", async () => {
  await withRoot(async (root) => {
    const { upstream, tipSha, mr, fake, transport, change } = await mrWorld(root);
    const changed: Array<[string, ChangeRequestHead | null]> = [
      ["not pushing onto !7: it has been closed", { ...mr, state: "closed" }],
      ["it has been merged", { ...mr, state: "closed", merged: true }],
      // A fork's source branch, with nothing saying ryph may push there.
      ["lives in the fork stranger/app", { ...mr, headRepoRef: "stranger/app" }],
      ["lived in a fork that has since been deleted", { ...mr, headRepoRef: null }],
      // GitLab's ids say fork, whatever its path: one that took the project's own old path.
      ["lives in the fork acme/platform/app", { ...mr, headRepoRef: PROJECT, sameRepo: false }],
      ["is now feat/y", { ...mr, headRef: "feat/y" }],
      // The default branch moved onto this one since the command; the live answer wins.
      ["is now acme/platform/app's default branch", { ...mr, defaultBranch: "feat/x" }],
      ["no merge request mr-7", null],
    ];
    for (const [why, now] of changed) {
      if (now === null) fake.mrs.delete("mr-7");
      else fake.mrs.set("mr-7", now);
      const out = await transport.deliver(change);
      assertFailed(out, true, why);
      // A merge request that ended says how, so the control plane can go and hear it.
      assertEquals(
        out.ended,
        why === "it has been merged"
          ? "merged"
          : why.endsWith("it has been closed")
          ? "closed"
          : undefined,
        why,
      );
      assertEquals(await git(upstream, "rev-parse", "refs/heads/feat/x"), tipSha, why);
      assertEquals(fake.opened.length, 0, why);
    }

    // A read that failed for now is retried; one GitLab refused for good is not.
    fake.api.describeChangeRequest = () =>
      Promise.reject(new ForgeApiError("GitLab answered 503", false));
    assertFailed(await transport.deliver(change), false, "503");
  });
});

test("onto a merge request whose branch moved since the run started: refused, not overwritten", async () => {
  await withRoot(async (root) => {
    const { upstream, mr, fake, transport, change } = await mrWorld(root);
    const author = `${root}/author`;
    await writeFile(`${author}/more.txt`, "more\n");
    await git(author, "add", ".");
    await commit(author, "more work");
    await git(author, "push", "--quiet", "origin", "feat/x");
    const moved = await git(author, "rev-parse", "HEAD");
    fake.mrs.set("mr-7", { ...mr, headSha: moved, authorHeadSha: moved });
    assertFailed(await transport.deliver(change), true, "moved while the run worked");
    assertEquals(await git(upstream, "rev-parse", "refs/heads/feat/x"), moved);
  });
});

test("a protected source branch GitLab will not let the account push is a terminal refusal naming it", async () => {
  await withRoot(async (root) => {
    const { mr, fake, change } = await mrWorld(root);
    // GitLab's pre-receive answer, as git reports it: the push is what fails, nothing before it.
    const refusing: Git = (cwd, ...args) =>
      args[0] === "push"
        ? Promise.reject(
          new Error(
            "git push failed (exit 1): remote: GitLab: You are not allowed to push code to " +
              "protected branches on this project.",
          ),
        )
        : git(cwd, ...args);
    const { transport } = transportFor(root, fake, refusing);
    fake.mrs.set("mr-7", mr);
    const out = await transport.deliver(change);
    assertFailed(out, true, "GitLab refused the push of !7's branch feat/x to acme/platform/app");
    assertStringIncludes(out.message, "protected");
    // A push that failed for any other reason stays retryable.
    const flaky: Git = (cwd, ...args) =>
      args[0] === "push"
        ? Promise.reject(new Error("git push failed (exit 128): the remote end hung up"))
        : git(cwd, ...args);
    const retryable = transportFor(root, fake, flaky).transport;
    assertFailed(await retryable.deliver(change), false, "pushing the branch failed");
  });
});

// ---- onto a fork's merge request --------------------------------------------------------------

/** A fork's merge request !7: the contributor's branch feat/x lives in a fork of the project,
 * and the project keeps its head as `refs/merge-requests/7/head`, as GitLab does. The run built
 * on that head through the project's cache. */
async function forkWorld(root: string, gitExec?: Git) {
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
  await git(
    upstream,
    "fetch",
    "--quiet",
    "--",
    fork,
    "+refs/heads/feat/x:refs/merge-requests/7/head",
  );

  const fake = fakeGitlab();
  const { transport, cache } = transportFor(root, fake, gitExec);
  await cache.refreshBase({ url: upstream }, "refs/merge-requests/7/head", anonymous);
  const { headSha, bundlePath } = await bundleOf(root, upstream, {
    fetch: "+refs/merge-requests/7/head:refs/heads/merge-requests/7/head",
    from: "merge-requests/7/head",
  });
  const mr: ChangeRequestHead = {
    ref: "mr-7",
    url: `https://gitlab.test/${PROJECT}/-/merge_requests/7`,
    state: "open",
    merged: false,
    headRef: "feat/x",
    headSha: tipSha,
    authorHeadSha: tipSha,
    baseRef: "main",
    headRepoRef: "stranger/app",
    headRepoUrl: fork,
    headRepoDefaultBranch: "main",
    // GitLab's `allow_collaboration`.
    maintainerCanModify: true,
    commitCount: null,
    defaultBranch: "main",
  };
  fake.mrs.set("mr-7", mr);
  const change = delivery({
    repoUrl: upstream,
    headSha,
    bundlePath,
    baseBranch: "merge-requests/7/head",
    title: "Address the review (!7)",
    existingRef: "mr-7",
    allowForkPush: true,
  });
  return { upstream, fork, tipSha, headSha, mr, fake, transport, change, cache };
}

test("onto a fork's merge request: pushed to the fork's branch, and nowhere else", async () => {
  await withRoot(async (root) => {
    const { upstream, fork, headSha, mr, fake, transport, change } = await forkWorld(root);
    assertEquals(await transport.deliver(change), { kind: "delivered", ref: "mr-7", url: mr.url });
    assertEquals(await git(fork, "rev-parse", "refs/heads/feat/x"), headSha);
    // Nothing landed in the project, and no merge request was opened.
    assertEquals(
      (await git(upstream, "for-each-ref", "--format=%(refname)", "refs/heads/")).split("\n"),
      ["refs/heads/main"],
    );
    assertEquals(fake.opened.length, 0);
    // The credential was asked for the project's URL and then the fork's.
    assertEquals(fake.pushAuthAsked, [upstream, fork]);
  });
});

test("onto a fork's merge request every question is asked again at push time, terminally", async () => {
  await withRoot(async (root) => {
    const { fork, tipSha, mr, fake, transport, change } = await forkWorld(root);
    const cases: Array<[string, ChangeRequestHead, Partial<ChangeDelivery>]> = [
      ["pushing to fork branches is not enabled for acme/platform/app", mr, {
        allowForkPush: false,
      }],
      ["pushing to fork branches is not enabled", mr, { allowForkPush: undefined }],
      // The author unticked "Allow commits from members who can merge" while the run worked.
      ["does not allow commits from members who can merge", {
        ...mr,
        maintainerCanModify: false,
      }, {}],
      ["does not allow commits from members who can merge", {
        ...mr,
        maintainerCanModify: undefined,
      }, {}],
      ["lived in a fork that has since been deleted", { ...mr, headRepoRef: null }, {}],
      // A private fork the bot is no member of: GitLab shows ryph nothing to push to.
      ["which GitLab will not show ryph", {
        ...mr,
        headRepoRef: "project 78",
        headRepoHidden: true,
        headRepoUrl: null,
        headRepoDefaultBranch: null,
      }, {}],
      ["it has been closed", { ...mr, state: "closed" }, {}],
      ["it has been merged", { ...mr, state: "closed", merged: true }, {}],
      ["on that fork's default branch", { ...mr, headRepoDefaultBranch: "feat/x" }, {}],
      // Its name is the fork author's: refused without being repeated (asserted below).
      ["on a branch whose name ryph cannot push to", {
        ...mr,
        headRef: "merge-requests/1/head",
      }, {}],
      ["did not say which branch is that fork's default", {
        ...mr,
        headRepoDefaultBranch: null,
      }, {}],
      // A run that did not start from this MR's head never pushes onto it — GitHub's spelling
      // of the head included.
      ["the run did not start from it", mr, { baseBranch: "main" }],
      ["the run did not start from it", mr, { baseBranch: "feat/x" }],
      ["the run did not start from it", mr, { baseBranch: "pull/7/head" }],
      ["the run did not start from it", mr, { baseBranch: "merge-requests/8/head" }],
      // A fork URL off the project's origin is not one the credential goes to.
      ["gave no URL for the fork", { ...mr, headRepoUrl: "https://elsewhere.test/x.git" }, {}],
      ["gave no URL for the fork", { ...mr, headRepoUrl: null }, {}],
    ];
    for (const [why, now, override] of cases) {
      fake.mrs.set("mr-7", now);
      const out = await transport.deliver({ ...change, ...override });
      assertFailed(out, true, why);
      assertEquals(out.message.includes("merge-requests/1/head"), false, why);
      assertEquals(await git(fork, "rev-parse", "refs/heads/feat/x"), tipSha, why);
      assertEquals(fake.opened.length, 0, why);
    }
  });
});

test("onto a fork's merge request in user mode: refused terminally, the token is the project's", async () => {
  await withRoot(async (root) => {
    const { upstream, fork, tipSha, fake, transport, change } = await forkWorld(root);
    const own = fake.api.pushAuth;
    fake.api.pushAuth = (repo, url) => {
      fake.pushAuthAsked.push(url);
      if (url === upstream) return own(repo, url);
      return Promise.reject(
        new ForgeApiError(`${url} is not ${repo.repoRef} on this GitLab`, true),
      );
    };
    const out = await transport.deliver(change);
    assertFailed(out, true, "no credential here may push to the fork stranger/app");
    assertStringIncludes(out.message, "is not acme/platform/app on this GitLab");
    assert(fake.pushAuthAsked.includes(fork));
    assertEquals(await git(fork, "rev-parse", "refs/heads/feat/x"), tipSha);
    // A credential that could not be had right now is retried.
    fake.api.pushAuth = (repo, url) =>
      url === upstream ? own(repo, url) : Promise.reject(new Error("vault sealed"));
    assertFailed(await transport.deliver(change), false, "no credential here may push to the fork");
  });
});

test("a fork push GitLab refuses is final, and says GitLab's merge-rights rule", async () => {
  await withRoot(async (root) => {
    // GitLab's answer to an account that may not merge into the target branch, at the push.
    let pushedTo: string | null = null;
    const refusing: Git = (cwd, ...args) => {
      if (args[0] !== "push") return git(cwd, ...args);
      pushedTo = args[args.indexOf("--") + 1] ?? null;
      return Promise.reject(
        new Error(
          "git push failed (exit 128): remote: You are not allowed to push code to this " +
            "project.\nfatal: unable to access: The requested URL returned error: 403",
        ),
      );
    };
    const { fork, tipSha, fake, transport, change } = await forkWorld(root, refusing);
    const out = await transport.deliver(change);
    assertFailed(out, true, "GitLab refused the push onto !7's branch in the fork stranger/app");
    assertStringIncludes(out.message, "may merge into the target branch (main)");
    assertEquals(pushedTo, fork, "the push went to the fork, and was not tried anywhere else");
    assertEquals(await git(fork, "rev-parse", "refs/heads/feat/x"), tipSha);
    assertEquals(fake.opened.length, 0, "never a fallback merge request");
  });
});

test("onto a fork's merge request whose branch moved: refused, not overwritten", async () => {
  await withRoot(async (root) => {
    const { fork, mr, fake, transport, change } = await forkWorld(root);
    const author = `${root}/author`;
    await writeFile(`${author}/more.txt`, "more\n");
    await git(author, "add", ".");
    await commit(author, "more work");
    await git(author, "push", "--quiet", "origin", "feat/x");
    const moved = await git(author, "rev-parse", "HEAD");
    fake.mrs.set("mr-7", { ...mr, headSha: moved, authorHeadSha: moved });
    assertFailed(await transport.deliver(change), true, "moved while the run worked");
    assertEquals(await git(fork, "rev-parse", "refs/heads/feat/x"), moved);
  });
});

test("onto a fork's merge request whose branch was rewritten: said as moved", async () => {
  await withRoot(async (root) => {
    const { upstream, fork, mr, fake, transport, change, cache } = await forkWorld(root);
    const author = `${root}/author`;
    await git(author, "reset", "--quiet", "--hard", "main");
    await writeFile(`${author}/other.txt`, "a different feature\n");
    await git(author, "add", ".");
    await commit(author, "start over");
    await git(author, "push", "--quiet", "--force", "origin", "feat/x");
    const moved = await git(author, "rev-parse", "HEAD");
    await git(
      upstream,
      "fetch",
      "--quiet",
      "--",
      fork,
      "+refs/heads/feat/x:refs/merge-requests/7/head",
    );
    const cached = await cache.find({ url: upstream }, "merge-requests/7/head");
    if (cached !== null) await rm(cached.dir, { recursive: true });
    fake.mrs.set("mr-7", { ...mr, headSha: moved, authorHeadSha: moved });
    assertFailed(
      await transport.deliver(change),
      true,
      "!7's branch in the fork stranger/app moved while the run worked (rewritten or force-pushed)",
    );
    assertEquals(await git(fork, "rev-parse", "refs/heads/feat/x"), moved);
  });
});

test("a delivery without the project's id goes nowhere: never pushed or opened by its path, terminally", async () => {
  await withRoot(async (root) => {
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    const fake = fakeGitlab();
    const { transport } = transportFor(root, fake);
    const { headSha, bundlePath } = await bundleOf(root, upstream);
    const { forgeId: _, ...byPath } = REPO;
    const out = await transport.deliver({
      ...delivery({ repoUrl: upstream, headSha, bundlePath }),
      repo: byPath,
    });
    assertEquals(out.kind, "failed");
    assert(out.kind === "failed" && out.terminal, JSON.stringify(out));
    assertEquals([fake.pushAuthAsked, fake.opened], [[], []]);
    await assertRejects(() => git(upstream, "rev-parse", "--verify", `refs/heads/${LINE}`));
  });
});

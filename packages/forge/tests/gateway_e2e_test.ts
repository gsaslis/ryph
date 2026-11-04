// The whole gateway, end to end against real git: a "private" upstream (reachable only by
// the gateway — the client never sees its path), a real clone through door ①, a real bundle
// through door ②, and the adversarial refusals the design promises. One live server for the
// happy paths; the pure handler for the refusals that need no socket.

import { test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { serve } from "@ryph/service";
import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import type { KeyStore } from "../src/ports/key_store.ts";
import type { RunGrant } from "../src/core/types.ts";
import { git, makeGit } from "../src/helpers/git_exec.ts";
import {
  commit,
  makeUpstream,
  pathForges,
  recordingDiagnostics,
  silentDiagnostics,
} from "./util.ts";

const TOKEN_A = "virtual-key-run-a";
const TOKEN_B = "virtual-key-run-b";
/** The one connected repo both runs hold. */
const REPO = "cr-1";

/** The orchestrator's answer table, canned: two runs against the same upstream. */
function fakeKeys(upstreamUrl: string): KeyStore {
  const grants: Record<string, RunGrant> = {
    [TOKEN_A]: {
      runId: "r-a",
      repos: [{
        connectedRepoId: REPO,
        provider: "github" as const,
        repoRef: "acme/app",
        url: upstreamUrl,
        ref: "main",
        branchNamespace: "ryph/ada/r-a",
        // A path upstream: nothing to authenticate to, so these runs fetch as nobody.
        tenantId: null,
      }],
    },
    [TOKEN_B]: {
      runId: "r-b",
      repos: [{
        connectedRepoId: REPO,
        provider: "github" as const,
        repoRef: "acme/app",
        url: upstreamUrl,
        ref: "main",
        branchNamespace: "ryph/bob/r-b",
        tenantId: null,
      }],
    },
  };
  return {
    resolve: (token) => Promise.resolve(structuredClone(grants[token] ?? null)),
  };
}

async function buildGateway(root: string, opts: { maxBundleBytes?: number } = {}) {
  const upstream = `${root}/upstream`;
  const baseSha = await makeUpstream(upstream);
  const diag = silentDiagnostics();
  const patches = localFsPatchStore(`${root}/patches`, diag);
  const stagingDir = `${root}/staging`;
  await mkdir(stagingDir, { recursive: true });
  const deps: AppDeps = {
    keys: fakeKeys(upstream),
    cache: localFsRepoCache({ root: `${root}/cache`, diag }),
    patches,
    diag,
    forges: pathForges(),
    config: {
      maxUploadPackBytes: 10 * 1024 * 1024,
      maxBundleBytes: opts.maxBundleBytes ?? 100 * 1024 * 1024,
      stagingDir,
    },
  };
  return { handler: makeHandler(deps), upstream, baseSha, patches, cacheRoot: `${root}/cache` };
}

/** A git executor authenticated like the runner's gateway transport: origin-scoped extraheader. */
function clientGit(origin: string, token: string) {
  return makeGit({ debug() {} }, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x-access-token:${token}`)}`,
  });
}

test("a real git clone through the gateway, and a real bundle back through intake", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const { handler, upstream, baseSha, patches, cacheRoot } = await buildGateway(root);
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handler);
  const origin = `http://127.0.0.1:${server.addr.port}`;
  try {
    // ---- door ①: the clone. The client knows the gateway URL and a credential — never the
    // upstream path. This is the "private repos become cloneable" claim, exercised.
    const gitA = clientGit(origin, TOKEN_A);
    const ws = `${root}/workspace`;
    await mkdir(ws);
    await gitA(ws, "clone", "--quiet", "--", `${origin}/v1/git/r-a/${REPO}/repo.git`, ".");
    await gitA(ws, "checkout", "--quiet", "--end-of-options", "main");
    assertEquals(await git(ws, "rev-parse", "HEAD"), baseSha);

    // The credential rode the subprocess env, never the URL: nothing secret in .git/config.
    const config = await readFile(`${ws}/.git/config`, "utf8");
    assert(!config.includes(TOKEN_A), ".git/config must not carry the credential");
    assert(
      !config.toLowerCase().includes("authorization"),
      ".git/config must not carry the header",
    );

    // ---- the run's work: a commit on the run-namespaced branch, bundled base..branch.
    await git(ws, "checkout", "--quiet", "-b", "ryph/ada/r-a/work");
    await writeFile(`${ws}/work.txt`, "the agent's work\n");
    await git(ws, "add", ".");
    await commit(ws, "do the work");
    const headSha = await git(ws, "rev-parse", "HEAD");
    const bundlePath = `${root}/out.bundle`;
    await git(ws, "bundle", "create", bundlePath, `${baseSha}..refs/heads/ryph/ada/r-a/work`);

    // ---- door ②: intake validates and stores.
    const res = await fetch(`${origin}/v1/patches/${REPO}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN_A}` },
      body: await readFile(bundlePath),
    });
    assertEquals(res.status, 201);
    const submission = await res.json();
    assertEquals(submission.runId, "r-a");
    assertEquals(submission.headSha, headSha);
    assertEquals(submission.connectedRepoId, REPO);
    assertEquals(submission.bundleKey, `r-a/work/${REPO}/${headSha}.bundle`);

    // The stored bundle is the durable artifact: fetch it back and verify it against the
    // cache — the same move phase 2's submitter will make.
    const stored = await patches.get(submission.bundleKey);
    assert(stored !== null);
    const restored = `${root}/restored.bundle`;
    await writeFile(restored, new Uint8Array(await new Response(stored).arrayBuffer()));
    const cacheDirs = readdirSync(cacheRoot, { withFileTypes: true }).map((e) =>
      `${cacheRoot}/${e.name}`
    );
    assertEquals(cacheDirs.length, 1);
    await git(cacheDirs[0], "bundle", "verify", "--quiet", restored);

    // ---- another line at the very same head is a bundle of its own, declaring its own branch:
    // filed under the head alone, it would replace the first, whose publish then fetches a
    // branch the stored bundle no longer carries.
    await git(ws, "branch", "ryph/ada/r-a/docs-2", "HEAD");
    const twinPath = `${root}/twin.bundle`;
    await git(ws, "bundle", "create", twinPath, `${baseSha}..refs/heads/ryph/ada/r-a/docs-2`);
    const twin = await fetch(`${origin}/v1/patches/${REPO}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN_A}` },
      body: await readFile(twinPath),
    });
    assertEquals(twin.status, 201);
    const twinSubmission = await twin.json();
    assertEquals(twinSubmission.headSha, headSha);
    assertEquals(twinSubmission.bundleKey, `r-a/docs-2/${REPO}/${headSha}.bundle`);
    for (
      const [key, ref] of [
        [submission.bundleKey, "refs/heads/ryph/ada/r-a/work"],
        [twinSubmission.bundleKey, "refs/heads/ryph/ada/r-a/docs-2"],
      ]
    ) {
      const back = await patches.get(key);
      assert(back !== null);
      const file = `${root}/back.bundle`;
      await writeFile(file, new Uint8Array(await new Response(back).arrayBuffer()));
      assertStringIncludes(await git(root, "bundle", "list-heads", file), ref);
    }

    // ---- structural read-only: a push has no route. Real git refuses at the advertisement.
    let pushFailed = false;
    try {
      await gitA(ws, "push", "origin", "HEAD:refs/heads/ryph/ada/r-a/work");
    } catch (err) {
      pushFailed = true;
      assertStringIncludes(String(err), "403");
    }
    assert(pushFailed, "a push through the read-only gateway must fail");

    // ---- run B's credential cannot address run A's door: 401, never 404.
    const gitB = clientGit(origin, TOKEN_B);
    const wsB = `${root}/workspace-b`;
    await mkdir(wsB);
    let crossFailed = false;
    try {
      await gitB(wsB, "clone", "--quiet", "--", `${origin}/v1/git/r-a/${REPO}/repo.git`, ".");
    } catch (err) {
      crossFailed = true;
      // The gateway answered 401; the hardened env then fails the clone FAST (no credential
      // helper, no askpass, no terminal prompt) — git reports it as one of these, depending
      // on version. What matters: refused, and immediately.
      assert(
        /401|authentication failed|could not read username/i.test(String(err)),
        `unexpected refusal shape: ${err}`,
      );
    }
    assert(crossFailed, "run B's key against run A's path must be refused");

    // upstream is only used by the gateway itself, referenced here to keep the story honest
    assert((await stat(`${upstream}/.git`)).isDirectory());
  } finally {
    await server.shutdown();
    await rm(root, { recursive: true });
  }
});

test("a member's target is refreshed beside its base, on the clone and on every fetch", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const upstream = `${root}/upstream`;
  await makeUpstream(upstream);
  // A change request's branch, off main, with a commit of its own.
  await git(upstream, "checkout", "--quiet", "-b", "feat/x");
  await writeFile(`${upstream}/cr.txt`, "the change request\n");
  await git(upstream, "add", ".");
  await commit(upstream, "cr work");
  const crHead = await git(upstream, "rev-parse", "HEAD");
  await git(upstream, "checkout", "--quiet", "main");

  const grant = (targetRef: string): RunGrant => ({
    runId: "r-c",
    repos: [{
      connectedRepoId: REPO,
      provider: "github" as const,
      repoRef: "acme/app",
      url: upstream,
      ref: "feat/x",
      targetRef,
      branchNamespace: "ryph/ada/r-c",
      tenantId: null,
    }],
  });
  let target = "main";
  const { diag, events } = recordingDiagnostics();
  const handler = makeHandler({
    keys: { resolve: () => Promise.resolve(grant(target)) },
    cache: localFsRepoCache({ root: `${root}/cache`, diag }),
    patches: localFsPatchStore(`${root}/patches`, diag),
    diag,
    forges: pathForges(),
    config: {
      maxUploadPackBytes: 10 * 1024 * 1024,
      maxBundleBytes: 100 * 1024 * 1024,
      stagingDir: root,
    },
  });
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handler);
  const origin = `http://127.0.0.1:${server.addr.port}`;
  const url = `${origin}/v1/git/r-c/${REPO}/repo.git`;
  try {
    const client = clientGit(origin, TOKEN_A);
    const ws = `${root}/workspace`;
    await mkdir(ws);
    await client(ws, "clone", "--quiet", "--", url, ".");
    await client(ws, "checkout", "--quiet", "--end-of-options", "feat/x");
    assertEquals(await git(ws, "rev-parse", "HEAD"), crHead);
    const mainAtClone = await git(upstream, "rev-parse", "main");
    assertEquals(await git(ws, "rev-parse", "refs/remotes/origin/main"), mainAtClone);

    // Main moves upstream; the run's next fetch of it sees the move, because the advertisement
    // refreshed the target — not only the base the run was checked out at.
    await writeFile(`${upstream}/main.txt`, "main moved\n");
    await git(upstream, "add", ".");
    await commit(upstream, "main work");
    const mainNow = await git(upstream, "rev-parse", "main");
    await client(ws, "fetch", "--quiet", "origin", "--", "main");
    assertEquals(await git(ws, "rev-parse", "refs/remotes/origin/main"), mainNow);

    // A target the upstream does not have costs the run nothing but the target: the base is
    // still served, and the miss is logged.
    target = "gone";
    const again = `${root}/workspace-2`;
    await mkdir(again);
    await client(again, "clone", "--quiet", "--", url, ".");
    await client(again, "checkout", "--quiet", "--end-of-options", "feat/x");
    assertEquals(await git(again, "rev-parse", "HEAD"), crHead);
    assert(events.some((e) => e.event === "git.target_unavailable"));

    // Nor does one the cache refuses to even name: `serveBase` throws on a tag before it has
    // a promise to reject, and that must not take the clone down with it.
    target = "refs/tags/v1";
    const tagged = `${root}/workspace-3`;
    await mkdir(tagged);
    await client(tagged, "clone", "--quiet", "--", url, ".");
    await client(tagged, "checkout", "--quiet", "--end-of-options", "feat/x");
    assertEquals(await git(tagged, "rev-parse", "HEAD"), crHead);
  } finally {
    await server.shutdown();
    await rm(root, { recursive: true });
  }
});

test("a line's own base is refreshed beside the member's, so its advance fetches it as it stands", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const upstream = `${root}/upstream`;
  await makeUpstream(upstream);
  // A branch only one line of the run went to: its change request merged into it.
  await git(upstream, "branch", "release", "main");
  const grant: RunGrant = {
    runId: "r-l",
    repos: [{
      connectedRepoId: REPO,
      provider: "github" as const,
      repoRef: "acme/app",
      url: upstream,
      ref: "main",
      lineBases: ["release"],
      branchNamespace: "ryph/ada/r-l",
      tenantId: null,
    }],
  };
  const diag = silentDiagnostics();
  const handler = makeHandler({
    keys: { resolve: () => Promise.resolve(structuredClone(grant)) },
    cache: localFsRepoCache({ root: `${root}/cache`, diag }),
    patches: localFsPatchStore(`${root}/patches`, diag),
    diag,
    forges: pathForges(),
    config: {
      maxUploadPackBytes: 10 * 1024 * 1024,
      maxBundleBytes: 100 * 1024 * 1024,
      stagingDir: root,
    },
  });
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handler);
  const origin = `http://127.0.0.1:${server.addr.port}`;
  try {
    const client = clientGit(origin, TOKEN_A);
    const ws = `${root}/workspace`;
    await mkdir(ws);
    await client(ws, "clone", "--quiet", "--", `${origin}/v1/git/r-l/${REPO}/repo.git`, ".");
    // The line's merge lands on `release` upstream; the run's fetch of it sees the merge.
    await git(upstream, "checkout", "--quiet", "release");
    await writeFile(`${upstream}/line.txt`, "the line's merge\n");
    await git(upstream, "add", ".");
    await commit(upstream, "merge the line");
    const merged = await git(upstream, "rev-parse", "release");
    await git(upstream, "checkout", "--quiet", "main");
    await client(ws, "fetch", "--quiet", "origin", "--", "release");
    assertEquals(await git(ws, "rev-parse", "refs/remotes/origin/release"), merged);
  } finally {
    await server.shutdown();
    await rm(root, { recursive: true });
  }
});

test("a target the upstream deleted leaves the entry, so a fetch of it fails instead of landing on its old tip", async () => {
  // A stacked branch whose target was merged and auto-deleted upstream. The warm swallows the
  // refusal, so the branch has to leave the entry with it: kept, the advertisement would go on
  // listing its old tip, the run's fetch would land there, and `update_from_base` would merge a
  // dead branch and report itself caught up.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const upstream = `${root}/upstream`;
  await makeUpstream(upstream);
  await git(upstream, "checkout", "--quiet", "-b", "feat/base");
  await writeFile(`${upstream}/base.txt`, "the stack's base\n");
  await git(upstream, "add", ".");
  await commit(upstream, "base work");
  const targetTip = await git(upstream, "rev-parse", "HEAD");
  await git(upstream, "checkout", "--quiet", "-b", "feat/x");
  await writeFile(`${upstream}/x.txt`, "the run's branch\n");
  await git(upstream, "add", ".");
  await commit(upstream, "x work");
  await git(upstream, "checkout", "--quiet", "main");
  const grant: RunGrant = {
    runId: "r-c",
    repos: [{
      connectedRepoId: REPO,
      provider: "github" as const,
      repoRef: "acme/app",
      url: upstream,
      ref: "feat/x",
      targetRef: "feat/base",
      branchNamespace: "ryph/ada/r-c",
      tenantId: null,
    }],
  };
  const diag = silentDiagnostics();
  const handler = makeHandler({
    keys: { resolve: () => Promise.resolve(grant) },
    cache: localFsRepoCache({ root: `${root}/cache`, diag }),
    patches: localFsPatchStore(`${root}/patches`, diag),
    diag,
    forges: pathForges(),
    config: { maxUploadPackBytes: 10 * 1024 * 1024, maxBundleBytes: 1024, stagingDir: root },
  });
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handler);
  const origin = `http://127.0.0.1:${server.addr.port}`;
  const url = `${origin}/v1/git/r-c/${REPO}/repo.git`;
  /** The v0 advertisement, which lists every ref the entry serves. */
  const advertised = async (): Promise<string> => {
    const res = await fetch(`${url}/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Basic ${btoa(`x-access-token:${TOKEN_A}`)}` },
    });
    return await res.text();
  };
  try {
    const client = clientGit(origin, TOKEN_A);
    const ws = `${root}/workspace`;
    await mkdir(ws);
    await client(ws, "clone", "--quiet", "--", url, ".");
    assertEquals(await git(ws, "rev-parse", "refs/remotes/origin/feat/base"), targetTip);
    assertStringIncludes(await advertised(), `${targetTip} refs/heads/feat/base`);

    await git(upstream, "branch", "-D", "feat/base");
    await assertRejects(
      () => client(ws, "fetch", "--quiet", "origin", "--", "feat/base"),
      Error,
      "couldn't find remote ref feat/base",
    );
    assert(
      !(await advertised()).includes("refs/heads/feat/base"),
      "the advertisement no longer lists the deleted target",
    );
    // The run's own base is untouched by it.
    await client(ws, "fetch", "--quiet", "origin", "--", "feat/x");
  } finally {
    await server.shutdown();
    await rm(root, { recursive: true });
  }
});

test("a base deleted upstream refuses every fetch, its target's too, until the grant names the target", async () => {
  // A run on a change request is granted the head branch as its base and the branch
  // the change request merges into as its target. GitHub deletes the head on merge, and the
  // gateway serves the base before it answers any fetch — so the run cannot even fetch the
  // target it merged into until the control plane lands the merge and the grant
  // names the target as the base.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const upstream = `${root}/upstream`;
  await makeUpstream(upstream);
  await git(upstream, "checkout", "--quiet", "-b", "feat/x");
  await writeFile(`${upstream}/x.txt`, "the change request\n");
  await git(upstream, "add", ".");
  await commit(upstream, "x work");
  await git(upstream, "checkout", "--quiet", "main");
  const grant = (landed: boolean): RunGrant => ({
    runId: "r-c",
    repos: [{
      connectedRepoId: REPO,
      provider: "github" as const,
      repoRef: "acme/app",
      url: upstream,
      ...(landed ? { ref: "main" } : { ref: "feat/x", targetRef: "main" }),
      branchNamespace: "ryph/ada/r-c",
      tenantId: null,
    }],
  });
  let landed = false;
  const diag = silentDiagnostics();
  const handler = makeHandler({
    keys: { resolve: () => Promise.resolve(grant(landed)) },
    cache: localFsRepoCache({ root: `${root}/cache`, diag }),
    patches: localFsPatchStore(`${root}/patches`, diag),
    diag,
    forges: pathForges(),
    config: { maxUploadPackBytes: 10 * 1024 * 1024, maxBundleBytes: 1024, stagingDir: root },
  });
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handler);
  const origin = `http://127.0.0.1:${server.addr.port}`;
  const url = `${origin}/v1/git/r-c/${REPO}/repo.git`;
  const advertise = () =>
    fetch(`${url}/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Basic ${btoa(`x-access-token:${TOKEN_A}`)}` },
    });
  try {
    const client = clientGit(origin, TOKEN_A);
    const ws = `${root}/workspace`;
    await mkdir(ws);
    await client(ws, "clone", "--quiet", "--", url, ".");

    // The change request merges, and its branch goes with it.
    await git(upstream, "merge", "--quiet", "--squash", "feat/x");
    await commit(upstream, "Merge #7");
    const merged = await git(upstream, "rev-parse", "main");
    await git(upstream, "branch", "-D", "feat/x");

    const refused = await advertise();
    assertEquals(refused.status, 502);
    assertStringIncludes(await refused.text(), "feat/x of acme/app");
    await assertRejects(() => client(ws, "fetch", "--quiet", "origin", "--", "main"));

    // Landed: the grant's base is the target now, and the fetch the runner advances with lands.
    landed = true;
    const served = await advertise();
    assertEquals(served.status, 200);
    await served.body?.cancel();
    await client(ws, "fetch", "--quiet", "origin", "--", "main");
    assertEquals(await git(ws, "rev-parse", "FETCH_HEAD"), merged);
  } finally {
    await server.shutdown();
    await rm(root, { recursive: true });
  }
});

test("a real clone during an outage checks out the sha the cache holds", async () => {
  // GitHub away, cache warm from an earlier run: the advertisement serves the held branch and
  // the clone lands on exactly the commit that was cached. A cold entry still refuses.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const { handler, upstream, baseSha } = await buildGateway(root);
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handler);
  const origin = `http://127.0.0.1:${server.addr.port}`;
  try {
    const client = clientGit(origin, TOKEN_A);
    const first = `${root}/workspace-1`;
    await mkdir(first);
    await client(first, "clone", "--quiet", "--", `${origin}/v1/git/r-a/${REPO}/repo.git`, ".");

    await rm(upstream, { recursive: true });
    const during = `${root}/workspace-2`;
    await mkdir(during);
    await client(during, "clone", "--quiet", "--", `${origin}/v1/git/r-a/${REPO}/repo.git`, ".");
    await client(during, "checkout", "--quiet", "--end-of-options", "main");
    assertEquals(await git(during, "rev-parse", "HEAD"), baseSha);
  } finally {
    await server.shutdown();
    await rm(root, { recursive: true });
  }
});

test("a run asks the base route whether its clone came from a stale copy", async () => {
  // git's wire carries no freshness signal, so the answer lives beside it: null while the last
  // refresh succeeded, the instant refreshes started failing once they do, and the commit the
  // entry holds, so a run that just fetched can tell whether the entry moved under it.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const upstream = `${root}/upstream`;
  const baseSha = await makeUpstream(upstream);
  const diag = silentDiagnostics();
  const handler = makeHandler({
    keys: fakeKeys(upstream),
    cache: localFsRepoCache({
      root: `${root}/cache`,
      diag,
      now: () => new Date("2026-09-30T08:00:00Z"),
    }),
    patches: localFsPatchStore(`${root}/patches`, diag),
    diag,
    forges: pathForges(),
    config: { maxUploadPackBytes: 1024, maxBundleBytes: 1024, stagingDir: root },
  });
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handler);
  const origin = `http://127.0.0.1:${server.addr.port}`;
  const ask = async (query = "", token = TOKEN_A) => {
    const res = await fetch(`${origin}/v1/git/r-a/${REPO}/base${query}`, {
      headers: { authorization: `Basic ${btoa(`x-access-token:${token}`)}` },
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    const client = clientGit(origin, TOKEN_A);
    const ws = `${root}/workspace`;
    await mkdir(ws);
    await client(ws, "clone", "--quiet", "--", `${origin}/v1/git/r-a/${REPO}/repo.git`, ".");
    const fresh = { ref: "main", commit: baseSha, staleSince: null };
    assertEquals(await ask(), { status: 200, body: fresh });
    assertEquals((await ask("?ref=refs/heads/main")).body, fresh);

    await rm(upstream, { recursive: true });
    const again = `${root}/workspace-2`;
    await mkdir(again);
    await client(again, "clone", "--quiet", "--", `${origin}/v1/git/r-a/${REPO}/repo.git`, ".");
    assertEquals(await ask(), {
      status: 200,
      body: { ref: "main", commit: baseSha, staleSince: "2026-09-30T08:00:00.000Z" },
    });

    assertEquals((await ask("?ref=release")).status, 404, "a branch the entry never held");
    assertEquals((await ask("?ref=not..a..ref")).status, 400);
    assertEquals((await ask("", "not-a-key")).status, 401);
  } finally {
    await server.shutdown();
    await rm(root, { recursive: true });
  }
});

test("a clone the cache cannot serve tells git why", async () => {
  // Cold entry, upstream gone: the refusal body is text/plain, which is the one kind of error
  // body git shows the user, so the reason lands in the clone's own stderr.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const { handler, upstream } = await buildGateway(root);
  await rm(upstream, { recursive: true });
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handler);
  const origin = `http://127.0.0.1:${server.addr.port}`;
  try {
    const client = clientGit(origin, TOKEN_A);
    const ws = `${root}/workspace`;
    await mkdir(ws);
    const failure = await assertRejects(() =>
      client(ws, "clone", "--quiet", "--", `${origin}/v1/git/r-a/${REPO}/repo.git`, ".")
    );
    assertStringIncludes(
      String(failure),
      "main of acme/app could not be fetched from upstream, and ryph holds no copy of it",
    );
  } finally {
    await server.shutdown();
    await rm(root, { recursive: true });
  }
});

test("a repo outside the grant is refused at both doors, before anything is fetched or read", async () => {
  // Run A's credential is valid, but the path names a member its grant does not hold: the
  // gateway answers 401 like any bad credential — never 404, which would confirm the id exists
  // — and never fetches an upstream for it.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const { handler, cacheRoot } = await buildGateway(root);
  try {
    const advertised = await handler(
      new Request(
        `http://gw/v1/git/r-a/cr-somebody-elses/repo.git/info/refs?service=git-upload-pack`,
        { headers: { authorization: `Bearer ${TOKEN_A}` } },
      ),
    );
    assertEquals(advertised.status, 401);
    await advertised.body?.cancel();

    const uploaded = await handler(
      new Request(`http://gw/v1/patches/cr-somebody-elses`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN_A}` },
        body: new Uint8Array(64),
      }),
    );
    assertEquals(uploaded.status, 401);
    await uploaded.body?.cancel();
    // The cache never learned of a repo the grant does not name.
    let cached: string[] = [];
    try {
      cached = [];
      for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
        cached.push(entry.name);
      }
    } catch {
      // no cache dir at all: nothing was fetched
    }
    assert(!cached.some((name) => name.includes("somebody-elses")), `cached: ${cached}`);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("intake refuses: wrong branch, foreign prerequisites, oversized, unauthenticated", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const { handler, upstream, baseSha } = await buildGateway(root, { maxBundleBytes: 4096 });
  try {
    // Prime the cache the way a run would: the advertisement fetches the base.
    const adv = await handler(
      new Request(`http://gw/v1/git/r-a/${REPO}/repo.git/info/refs?service=git-upload-pack`, {
        headers: { authorization: `Bearer ${TOKEN_A}` },
      }),
    );
    assertEquals(adv.status, 200);
    await adv.body?.cancel();

    const post = (body: BodyInit, token?: string) =>
      handler(
        new Request(`http://gw/v1/patches/${REPO}`, {
          method: "POST",
          headers: token ? { authorization: `Bearer ${token}` } : {},
          body,
        }),
      );

    // No credential.
    assertEquals((await post(new Uint8Array(8))).status, 401);

    // The right branch name for run B, uploaded with run A's credential → wrong ref for A.
    const work = `${root}/work`;
    await mkdir(work);
    await git(work, "clone", "--quiet", "--", upstream, ".");
    await git(work, "checkout", "--quiet", "-b", "ryph/bob/r-b/work");
    await writeFile(`${work}/f.txt`, "x\n");
    await git(work, "add", ".");
    await commit(work, "work");
    const wrongBranch = `${root}/wrong-branch.bundle`;
    await git(work, "bundle", "create", wrongBranch, `${baseSha}..refs/heads/ryph/bob/r-b/work`);
    const wrongRes = await post(await readFile(wrongBranch), TOKEN_A);
    assertEquals(wrongRes.status, 400);
    assertStringIncludes((await wrongRes.json()).error, "this run's output ref");

    // A LINE of run A's namespace is accepted — `<namespace>/<line>`, or a later GENERATION of
    // one, `<line>-<n>` (n ≥ 2), which the runner starts on the merged tip once a patch of the
    // line landed — and filed under that name. The bare namespace, a `-1` (the first generation
    // has no suffix), a name that breaks the line rule, a nested path, and a namespace that only
    // starts like the run's are all somebody else's branch. The bare namespace goes first: git
    // cannot hold `a/b` beside `a/b/c`, so its branch is deleted before the lines are made.
    const ns = "ryph/ada/r-a";
    const shapes = [
      [ns, 400],
      [`${ns}/fix-a`, 201],
      [`${ns}/fix-a-2`, 201],
      [`${ns}/fix-a-13`, 201],
      [`${ns}/work`, 201],
      [`${ns}/fix-a-1`, 400],
      [`${ns}/Bad`, 400],
      [`${ns}/a/b`, 400],
      [`${ns}/fix--a`, 400],
      [`${ns}-2/work`, 400],
    ] as const;
    for (const [i, [branch, status]] of shapes.entries()) {
      await git(work, "checkout", "--quiet", "-b", branch);
      // one commit of its own per branch, so the accepted ones file under distinct heads
      await writeFile(`${work}/g${i}.txt`, `${branch}\n`);
      await git(work, "add", ".");
      await commit(work, `shape ${branch}`);
      const bundle = `${root}/shape-${i}.bundle`;
      await git(work, "bundle", "create", bundle, `${baseSha}..refs/heads/${branch}`);
      const res = await post(await readFile(bundle), TOKEN_A);
      assertEquals(res.status, status, branch);
      const body = await res.json();
      if (status === 201) assertEquals(body.branchName, branch);
      else assertStringIncludes(body.error, "later generation");
      if (branch === ns) {
        await git(work, "checkout", "--quiet", "--detach");
        await git(work, "branch", "--quiet", "-D", ns);
      }
    }
    // …and the accepted ones are in the store, filed under the run, the branch and the repo
    const filed = (await readdir(`${root}/patches/r-a`, { recursive: true }))
      .filter((name) => name.endsWith(".bundle"));
    assertEquals(filed.length, 4);
    for (const name of filed) assertStringIncludes(name, `/${REPO}/`);
    // …and out of the store again, so the refusals below leave it demonstrably empty.
    await rm(`${root}/patches/r-a`, { recursive: true });

    // A bundle whose prerequisites the cache has never seen: an unrelated repo's history.
    const foreign = `${root}/foreign`;
    const foreignBase = await makeUpstream(foreign, "foreign");
    await git(foreign, "checkout", "--quiet", "-b", "ryph/ada/r-a/work");
    await writeFile(`${foreign}/g.txt`, "y\n");
    await git(foreign, "add", ".");
    await commit(foreign, "foreign work");
    const foreignBundle = `${root}/foreign.bundle`;
    await git(
      foreign,
      "bundle",
      "create",
      foreignBundle,
      `${foreignBase}..refs/heads/ryph/ada/r-a/work`,
    );
    const foreignRes = await post(await readFile(foreignBundle), TOKEN_A);
    assertEquals(foreignRes.status, 400);
    assertStringIncludes((await foreignRes.json()).error, "prerequisites");

    // Oversized: a clean 413, both with a declared length and while streaming chunks.
    assertEquals((await post(new Uint8Array(8192), TOKEN_A)).status, 413);
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 16; i++) controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });
    assertEquals((await post(chunked, TOKEN_A)).status, 413);

    // Nothing invalid ever landed: the store holds no bundles.
    const stored = [];
    try {
      for (const e of await readdir(`${root}/patches`, { withFileTypes: true })) {
        stored.push(e.name);
      }
    } catch {
      // the directory may not even exist — equally empty
    }
    assertEquals(stored, []);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("upload-pack request bodies are capped: declared length gets a clean 413", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const { handler } = await buildGateway(root);
  try {
    // Prime the cache via the advertisement.
    const adv = await handler(
      new Request(`http://gw/v1/git/r-a/${REPO}/repo.git/info/refs?service=git-upload-pack`, {
        headers: { authorization: `Bearer ${TOKEN_A}` },
      }),
    );
    assertEquals(adv.status, 200);
    await adv.body?.cancel();

    const res = await handler(
      new Request(`http://gw/v1/git/r-a/${REPO}/repo.git/git-upload-pack`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          "content-length": String(64 * 1024 * 1024),
        },
        body: new Uint8Array(16),
      }),
    );
    assertEquals(res.status, 413);
    await res.body?.cancel();
  } finally {
    await rm(root, { recursive: true });
  }
});

test("receive-pack is unreachable: no advertisement, no route", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const { handler } = await buildGateway(root);
  try {
    const adv = await handler(
      new Request(`http://gw/v1/git/r-a/${REPO}/repo.git/info/refs?service=git-receive-pack`, {
        headers: { authorization: `Bearer ${TOKEN_A}` },
      }),
    );
    assertEquals(adv.status, 403);
    await adv.body?.cancel();

    const push = await handler(
      new Request(`http://gw/v1/git/r-a/${REPO}/repo.git/git-receive-pack`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN_A}` },
        body: new Uint8Array(4),
      }),
    );
    assertEquals(push.status, 404); // not forbidden — nonexistent
    await push.body?.cancel();
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a cache wiped mid-run is warmed at intake, not answered with a 503", async () => {
  // The failure this exists for, seen on a real deployment: the forge's cache is a pod's
  // scratch disk, the pod was replaced while a run was working, and the bundle came back to a
  // gateway with no base to verify against. The work was finished and durable; only the
  // verification had lost its footing.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const { handler, baseSha, patches, cacheRoot } = await buildGateway(root);
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handler);
  const origin = `http://127.0.0.1:${server.addr.port}`;
  try {
    const gitA = clientGit(origin, TOKEN_A);
    const ws = `${root}/workspace`;
    await mkdir(ws);
    await gitA(ws, "clone", "--quiet", "--", `${origin}/v1/git/r-a/${REPO}/repo.git`, ".");
    await gitA(ws, "checkout", "--quiet", "--end-of-options", "main");
    await git(ws, "checkout", "--quiet", "-b", "ryph/ada/r-a/work");
    await writeFile(`${ws}/work.txt`, "the agent's work\n");
    await git(ws, "add", ".");
    await commit(ws, "do the work");
    const headSha = await git(ws, "rev-parse", "HEAD");
    const bundlePath = `${root}/out.bundle`;
    await git(ws, "bundle", "create", bundlePath, `${baseSha}..refs/heads/ryph/ada/r-a/work`);

    // The pod goes away, taking its emptyDir with it.
    await rm(cacheRoot, { recursive: true });
    assertEquals(
      ((await assertRejects(() => stat(cacheRoot))) as NodeJS.ErrnoException).code,
      "ENOENT",
    );

    const res = await fetch(`${origin}/v1/patches/${REPO}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN_A}` },
      body: await readFile(bundlePath),
    });
    assertEquals(res.status, 201, "intake re-fetched the base instead of refusing");
    const submission = await res.json();
    assertEquals(submission.headSha, headSha);
    assert(await patches.get(submission.bundleKey) !== null, "and the patch is durable");

    // Warmed, not bypassed: the entry is back on disk and the bundle verifies against it, so
    // prerequisites were really checked rather than waved through.
    const dirs = readdirSync(cacheRoot, { withFileTypes: true }).map((e) =>
      `${cacheRoot}/${e.name}`
    );
    assertEquals(dirs.length, 1);
    await git(dirs[0], "bundle", "verify", "--quiet", bundlePath);
  } finally {
    await server.shutdown();
    await rm(root, { recursive: true });
  }
});

test("a cold cache the upstream cannot fill is still a retryable 503", async () => {
  // The distinction worth keeping: "we could not reach the base" is transient and the run may
  // submit again; it must not read as "this bundle is bad", which is terminal.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const { handler, upstream, baseSha, cacheRoot } = await buildGateway(root);
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handler);
  const origin = `http://127.0.0.1:${server.addr.port}`;
  try {
    const gitA = clientGit(origin, TOKEN_A);
    const ws = `${root}/workspace`;
    await mkdir(ws);
    await gitA(ws, "clone", "--quiet", "--", `${origin}/v1/git/r-a/${REPO}/repo.git`, ".");
    await gitA(ws, "checkout", "--quiet", "--end-of-options", "main");
    await git(ws, "checkout", "--quiet", "-b", "ryph/ada/r-a/work");
    await writeFile(`${ws}/work.txt`, "work\n");
    await git(ws, "add", ".");
    await commit(ws, "do the work");
    const bundlePath = `${root}/out.bundle`;
    await git(ws, "bundle", "create", bundlePath, `${baseSha}..refs/heads/ryph/ada/r-a/work`);

    // Cache gone AND the upstream unreachable — nothing left to warm from.
    await rm(cacheRoot, { recursive: true });
    await rm(upstream, { recursive: true });

    const res = await fetch(`${origin}/v1/patches/${REPO}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN_A}` },
      body: await readFile(bundlePath),
    });
    assertEquals(res.status, 503);
    assertEquals((await res.json()).error, "base cache unavailable, retry");
  } finally {
    await server.shutdown();
    await rm(root, { recursive: true });
  }
});

test("an entry that exists but holds nothing is re-fetched, not called a bad bundle", async () => {
  // The debris the adapter's own cleanup cannot reach: a process killed between `git init` and
  // its first fetch, or a failed fetch from an older build. Answering 400 for it would tell a
  // run its work is unusable on the strength of OUR empty cache — and 400 is terminal, so no
  // retry would ever recover it, even after the upstream came back. `find` refuses to call such
  // a directory a hit, which is what routes it to a fetch instead of to a verdict.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const { handler, baseSha, patches, cacheRoot } = await buildGateway(root);
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handler);
  const origin = `http://127.0.0.1:${server.addr.port}`;
  try {
    const gitA = clientGit(origin, TOKEN_A);
    const ws = `${root}/workspace`;
    await mkdir(ws);
    await gitA(ws, "clone", "--quiet", "--", `${origin}/v1/git/r-a/${REPO}/repo.git`, ".");
    await gitA(ws, "checkout", "--quiet", "--end-of-options", "main");
    await git(ws, "checkout", "--quiet", "-b", "ryph/ada/r-a/work");
    await writeFile(`${ws}/work.txt`, "the agent's work\n");
    await git(ws, "add", ".");
    await commit(ws, "do the work");
    const headSha = await git(ws, "rev-parse", "HEAD");
    const bundlePath = `${root}/out.bundle`;
    await git(ws, "bundle", "create", bundlePath, `${baseSha}..refs/heads/ryph/ada/r-a/work`);

    // Reduce the warm entry to what `git init --bare` alone would have left: HEAD, no objects.
    const [entry] = readdirSync(cacheRoot, { withFileTypes: true }).map((e) =>
      `${cacheRoot}/${e.name}`
    );
    await rm(entry, { recursive: true });
    await mkdir(entry, { recursive: true });
    await git(entry, "init", "--bare", "--quiet");
    await assertRejects(() => git(entry, "rev-parse", "--verify", "refs/heads/main"));

    const res = await fetch(`${origin}/v1/patches/${REPO}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN_A}` },
      body: await readFile(bundlePath),
    });
    assertEquals(res.status, 201, "the empty entry was re-fetched rather than blamed");
    assertEquals((await res.json()).headSha, headSha);
    assert(await patches.get(`r-a/work/${REPO}/${headSha}.bundle`) !== null);
  } finally {
    await server.shutdown();
    await rm(root, { recursive: true });
  }
});

test("a genuinely foreign bundle is still 400, after the base was fetched fresh", async () => {
  // The verdict must stay reachable: warming is a second chance for the BASE, not an escape
  // hatch for a bundle. Prerequisites from a repo this base never had are terminal, as before.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const { handler } = await buildGateway(root);
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handler);
  const origin = `http://127.0.0.1:${server.addr.port}`;
  try {
    // A bundle built on an entirely different repo's history.
    const foreign = `${root}/foreign`;
    const foreignSha = await makeUpstream(foreign, "foreign");
    await git(foreign, "checkout", "--quiet", "-b", "ryph/ada/r-a/work");
    await writeFile(`${foreign}/x.txt`, "elsewhere\n");
    await git(foreign, "add", ".");
    await commit(foreign, "work elsewhere");
    const bundlePath = `${root}/foreign.bundle`;
    await git(
      foreign,
      "bundle",
      "create",
      bundlePath,
      `${foreignSha}..refs/heads/ryph/ada/r-a/work`,
    );

    const res = await fetch(`${origin}/v1/patches/${REPO}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN_A}` },
      body: await readFile(bundlePath),
    });
    assertEquals(res.status, 400);
    assertStringIncludes((await res.json()).error, "prerequisites are not satisfied");
  } finally {
    await server.shutdown();
    await rm(root, { recursive: true });
  }
});

test("a base we already hold is judged without the upstream, and 400 means 400", async () => {
  // The other half of the bargain. Warming exists for a cache that cannot answer; a cache that
  // CAN must not reach upstream at all — not to mint a token, not to re-fetch a base already
  // sitting there. Pinned the only way that can be proved: the upstream is deleted after the
  // clone, so any attempt to consult it would surface as a 503 instead of the verdict.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const { handler, upstream } = await buildGateway(root);
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handler);
  const origin = `http://127.0.0.1:${server.addr.port}`;
  try {
    // Door ① warms the cache with this run's base, exactly as a real run would.
    const gitA = clientGit(origin, TOKEN_A);
    const ws = `${root}/workspace`;
    await mkdir(ws);
    await gitA(ws, "clone", "--quiet", "--", `${origin}/v1/git/r-a/${REPO}/repo.git`, ".");

    // A bundle from a repo this base never had, and an upstream that no longer exists.
    const foreign = `${root}/foreign`;
    const foreignSha = await makeUpstream(foreign, "foreign");
    await git(foreign, "checkout", "--quiet", "-b", "ryph/ada/r-a/work");
    await writeFile(`${foreign}/x.txt`, "elsewhere\n");
    await git(foreign, "add", ".");
    await commit(foreign, "work elsewhere");
    const bundlePath = `${root}/foreign.bundle`;
    await git(
      foreign,
      "bundle",
      "create",
      bundlePath,
      `${foreignSha}..refs/heads/ryph/ada/r-a/work`,
    );
    await rm(upstream, { recursive: true });

    const res = await fetch(`${origin}/v1/patches/${REPO}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN_A}` },
      body: await readFile(bundlePath),
    });
    assertEquals(res.status, 400, "the warm base decided it; nothing went looking upstream");
    assertStringIncludes((await res.json()).error, "prerequisites are not satisfied");
  } finally {
    await server.shutdown();
    await rm(root, { recursive: true });
  }
});

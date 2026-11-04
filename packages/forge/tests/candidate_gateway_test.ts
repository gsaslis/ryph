// A check pod's clone of an UNSUBMITTED commit, end to end against real git: a run's bundle goes
// in through intake, and a check grant naming its head clones exactly that head back out of a
// repo of its own — never out of the cache entry every run of the upstream shares. The
// refusals are the other half: a check grant cannot ship, cannot warm, and cannot be pointed at
// a bundle that is not its commit's.

import { test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { serve } from "@ryph/service";
import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { CANDIDATE_TTL_MS, candidatesDir, sweepCandidates } from "../src/http/candidate.ts";
import type { KeyStore } from "../src/ports/key_store.ts";
import type { RunGrant, RunGrantRepo } from "../src/core/types.ts";
import { git, makeGit } from "../src/helpers/git_exec.ts";
import {
  commit,
  makeUpstream,
  pathForges,
  pushedOverPullRequest,
  serveProtocolV0,
  silentDiagnostics,
} from "./util.ts";

const RUN_TOKEN = "virtual-key-run";
const OTHER_RUN_TOKEN = "virtual-key-other-run";
const CHECK_TOKEN = "check-key";
const REPO = "cr-1";
const SUITE = "cs-0123456789";
const NAMESPACE = "ryph/ada/r-a";
const BRANCH = `${NAMESPACE}/work`;

function member(upstream: string, over: Partial<RunGrantRepo> = {}): RunGrantRepo {
  return {
    connectedRepoId: REPO,
    provider: "github",
    repoRef: "acme/app",
    url: upstream,
    ref: "main",
    branchNamespace: NAMESPACE,
    tenantId: null,
    ...over,
  };
}

/** The orchestrator's answer table: the run, another run of the same upstream, and whatever
 * check grants a test adds. */
function keys(upstream: string, checks: Record<string, RunGrant>): KeyStore {
  const grants: Record<string, RunGrant> = {
    [RUN_TOKEN]: { runId: "r-a", repos: [member(upstream)] },
    [OTHER_RUN_TOKEN]: {
      runId: "r-b",
      repos: [member(upstream, { branchNamespace: "ryph/bob/r-b" })],
    },
  };
  return {
    resolve: (token) => Promise.resolve(structuredClone(grants[token] ?? checks[token] ?? null)),
  };
}

function clientGit(origin: string, token: string) {
  return makeGit({ debug() {} }, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x-access-token:${token}`)}`,
  });
}

const basic = (token: string) => `Basic ${btoa(`x-access-token:${token}`)}`;

/**
 * A gateway on a socket, and a run that has already shipped one commit through intake. The
 * returned `checks` table is live: a test adds check grants to it before asking.
 */
async function withShippedRun(
  fn: (ctx: {
    root: string;
    origin: string;
    handler: (req: Request) => Promise<Response>;
    upstream: string;
    baseSha: string;
    headSha: string;
    bundleKey: string;
    checks: Record<string, RunGrant>;
    deps: AppDeps;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const upstream = `${root}/upstream`;
  const baseSha = await makeUpstream(upstream);
  const diag = silentDiagnostics();
  const stagingDir = `${root}/staging`;
  await mkdir(stagingDir, { recursive: true });
  const checks: Record<string, RunGrant> = {};
  const deps: AppDeps = {
    keys: keys(upstream, checks),
    cache: localFsRepoCache({ root: `${root}/cache`, diag }),
    patches: localFsPatchStore(`${root}/patches`, diag),
    diag,
    forges: pathForges(),
    config: { maxUploadPackBytes: 10 * 1024 * 1024, maxBundleBytes: 1024 * 1024, stagingDir },
  };
  const handler = makeHandler(deps);
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handler);
  const origin = `http://127.0.0.1:${server.addr.port}`;
  try {
    const run = clientGit(origin, RUN_TOKEN);
    const ws = `${root}/workspace`;
    await mkdir(ws);
    await run(ws, "clone", "--quiet", "--", `${origin}/v1/git/r-a/${REPO}/repo.git`, ".");
    await git(ws, "checkout", "--quiet", "-b", BRANCH);
    await writeFile(`${ws}/work.txt`, "the agent's work\n");
    await git(ws, "add", ".");
    await commit(ws, "do the work");
    const headSha = await git(ws, "rev-parse", "HEAD");
    const bundlePath = `${root}/out.bundle`;
    await git(ws, "bundle", "create", bundlePath, `${baseSha}..refs/heads/${BRANCH}`);
    const res = await fetch(`${origin}/v1/patches/${REPO}`, {
      method: "POST",
      headers: { authorization: `Bearer ${RUN_TOKEN}` },
      body: await readFile(bundlePath),
    });
    assertEquals(res.status, 201);
    const { bundleKey } = await res.json();
    await fn({ root, origin, handler, upstream, baseSha, headSha, bundleKey, checks, deps });
  } finally {
    await server.shutdown();
    await rm(root, { recursive: true });
  }
}

const checkGrant = (upstream: string, candidate: RunGrantRepo["candidate"]): RunGrant => ({
  runId: SUITE,
  repos: [member(upstream, { candidate })],
});

test("a check grant clones the candidate head — exactly it — and the base beside it", async () => {
  await withShippedRun(async ({ root, origin, upstream, baseSha, headSha, bundleKey, checks }) => {
    checks[CHECK_TOKEN] = checkGrant(upstream, { headSha, branchName: BRANCH, bundleKey });
    const pod = clientGit(origin, CHECK_TOKEN);
    const url = `${origin}/v1/git/${SUITE}/${REPO}/repo.git`;

    // Twice: the first stages the candidate, the second reuses it.
    for (const name of ["pristine", "again"]) {
      const dir = `${root}/${name}`;
      await mkdir(dir);
      await pod(dir, "clone", "--quiet", "--", url, ".");
      assertEquals(await git(dir, "rev-parse", "HEAD"), headSha);
      // The base comes along, which is what the changed-paths list is computed against.
      assertEquals(await git(dir, "rev-parse", "origin/main"), baseSha);
    }
    const staged = readdirSync(candidatesDir(`${root}/staging`), { withFileTypes: true });
    assertEquals(staged.length, 1, "one candidate, staged once");
  });
});

test("the candidate never enters the shared cache: another run's clone cannot see it", async () => {
  await withShippedRun(async ({ root, origin, upstream, headSha, bundleKey, checks }) => {
    checks[CHECK_TOKEN] = checkGrant(upstream, { headSha, branchName: BRANCH, bundleKey });
    const pod = clientGit(origin, CHECK_TOKEN);
    await mkdir(`${root}/pod`);
    await pod(
      `${root}/pod`,
      "clone",
      "--quiet",
      "--",
      `${origin}/v1/git/${SUITE}/${REPO}/repo.git`,
      ".",
    );

    const other = clientGit(origin, OTHER_RUN_TOKEN);
    const listed = await other(root, "ls-remote", "--", `${origin}/v1/git/r-b/${REPO}/repo.git`);
    assert(!listed.includes(headSha), "an unsubmitted head must not be advertised to other runs");
    assert(!listed.includes(BRANCH));
  });
});

test("a check grant cannot ship a bundle, nor warm a change request", async () => {
  await withShippedRun(async ({ root, handler, upstream, headSha, bundleKey, checks }) => {
    checks[CHECK_TOKEN] = checkGrant(upstream, { headSha, branchName: BRANCH, bundleKey });
    const stored = await readFile(`${root}/out.bundle`);

    const intake = await handler(
      new Request(`http://forge/v1/patches/${REPO}`, {
        method: "POST",
        headers: { authorization: `Bearer ${CHECK_TOKEN}` },
        body: stored,
      }),
    );
    assertEquals(intake.status, 401);

    const warm = await handler(
      new Request(`http://forge/v1/git/${SUITE}/${REPO}/change-requests/7/base`, {
        method: "POST",
        headers: { authorization: basic(CHECK_TOKEN) },
      }),
    );
    assertEquals(warm.status, 401);

    // And a check grant's run id is still held to the path, like any other grant's.
    const wrongPath = await handler(
      new Request(`http://forge/v1/git/r-a/${REPO}/repo.git/info/refs?service=git-upload-pack`, {
        headers: { authorization: basic(CHECK_TOKEN) },
      }),
    );
    assertEquals(wrongPath.status, 401);
  });
});

test("a candidate whose bundle is gone fails loudly, with a sentence the clone prints", async () => {
  await withShippedRun(async ({ origin, handler, upstream, root, checks }) => {
    const missing = "e".repeat(40);
    checks[CHECK_TOKEN] = checkGrant(upstream, {
      headSha: missing,
      branchName: BRANCH,
      bundleKey: `r-a/${REPO}/${missing}.bundle`,
    });
    const res = await handler(
      new Request(
        `http://forge/v1/git/${SUITE}/${REPO}/repo.git/info/refs?service=git-upload-pack`,
        { headers: { authorization: basic(CHECK_TOKEN) } },
      ),
    );
    assertEquals(res.status, 404);
    assert((await res.json()).error.includes("bundle is gone"));

    const pod = clientGit(origin, CHECK_TOKEN);
    await mkdir(`${root}/pod`);
    await assertRejects(() =>
      pod(
        `${root}/pod`,
        "clone",
        "--quiet",
        "--",
        `${origin}/v1/git/${SUITE}/${REPO}/repo.git`,
        ".",
      )
    );
  });
});

test("a bundle key that is not this repo's candidate's is refused before the store is asked", async () => {
  await withShippedRun(async ({ handler, upstream, headSha, checks }) => {
    for (
      const bundleKey of [`r-a/cr-other/${headSha}.bundle`, `r-a/${REPO}/${"f".repeat(40)}.bundle`]
    ) {
      checks[CHECK_TOKEN] = checkGrant(upstream, { headSha, branchName: BRANCH, bundleKey });
      const res = await handler(
        new Request(
          `http://forge/v1/git/${SUITE}/${REPO}/repo.git/info/refs?service=git-upload-pack`,
          { headers: { authorization: basic(CHECK_TOKEN) } },
        ),
      );
      assertEquals(res.status, 403, bundleKey);
    }
  });
});

test("a stored bundle whose head is not the grant's is never served", async () => {
  await withShippedRun(async ({ root, handler, upstream, bundleKey, checks, deps }) => {
    // The bundle of the real head, filed under a key that claims another head: the key passes
    // the shape check, and only the staged head's re-verification can catch it.
    const claimed = "a".repeat(40);
    const forged = `r-a/${REPO}/${claimed}.bundle`;
    const copy = `${root}/forged.bundle`;
    const stored = await deps.patches.get(bundleKey);
    assert(stored !== null);
    await writeFile(copy, new Uint8Array(await new Response(stored).arrayBuffer()));
    await deps.patches.put(forged, copy);

    checks[CHECK_TOKEN] = checkGrant(upstream, {
      headSha: claimed,
      branchName: BRANCH,
      bundleKey: forged,
    });
    const res = await handler(
      new Request(
        `http://forge/v1/git/${SUITE}/${REPO}/repo.git/info/refs?service=git-upload-pack`,
        { headers: { authorization: basic(CHECK_TOKEN) } },
      ),
    );
    assertEquals(res.status, 409);
    assert((await res.json()).error.includes("does not verify"));
  });
});

test("a candidate nobody touched for the TTL is swept on the next request", async () => {
  await withShippedRun(async ({ root, origin, upstream, headSha, bundleKey, checks }) => {
    const parent = candidatesDir(`${root}/staging`);
    await mkdir(`${parent}/cr-1-stale`, { recursive: true });
    const old = new Date(Date.now() - CANDIDATE_TTL_MS - 60_000);
    await utimes(`${parent}/cr-1-stale`, old, old);

    checks[CHECK_TOKEN] = checkGrant(upstream, { headSha, branchName: BRANCH, bundleKey });
    const pod = clientGit(origin, CHECK_TOKEN);
    await mkdir(`${root}/pod`);
    await pod(
      `${root}/pod`,
      "clone",
      "--quiet",
      "--",
      `${origin}/v1/git/${SUITE}/${REPO}/repo.git`,
      ".",
    );

    const left = readdirSync(parent, { withFileTypes: true }).map((e) => e.name);
    assertEquals(left.length, 1);
    assert(!left.includes("cr-1-stale"));
  });
});

test("a candidate whose grant names a target carries that branch too, for the merge base", async () => {
  await withShippedRun(async ({ root, origin, upstream, headSha, bundleKey, checks }) => {
    // The branch the change goes into, which is not the run's base and which no clone warmed.
    await git(upstream, "checkout", "--quiet", "-b", "release");
    await writeFile(`${upstream}/release.txt`, "release\n");
    await git(upstream, "add", ".");
    await commit(upstream, "release work");
    const releaseSha = await git(upstream, "rev-parse", "HEAD");
    await git(upstream, "checkout", "--quiet", "main");

    checks[CHECK_TOKEN] = {
      runId: SUITE,
      repos: [
        member(upstream, {
          targetRef: "release",
          candidate: { headSha, branchName: BRANCH, bundleKey },
        }),
      ],
    };
    const pod = clientGit(origin, CHECK_TOKEN);
    await mkdir(`${root}/pod`);
    await pod(
      `${root}/pod`,
      "clone",
      "--quiet",
      "--",
      `${origin}/v1/git/${SUITE}/${REPO}/repo.git`,
      ".",
    );
    assertEquals(await git(`${root}/pod`, "rev-parse", "HEAD"), headSha);
    assertEquals(await git(`${root}/pod`, "rev-parse", "origin/release"), releaseSha);
  });
});

test("a candidate holds only the bundle's objects and borrows the base from the cache", async () => {
  await withShippedRun(async ({ root, origin, upstream, baseSha, headSha, bundleKey, checks }) => {
    checks[CHECK_TOKEN] = checkGrant(upstream, { headSha, branchName: BRANCH, bundleKey });
    const pod = clientGit(origin, CHECK_TOKEN);
    const url = `${origin}/v1/git/${SUITE}/${REPO}/repo.git`;
    await mkdir(`${root}/pod`);
    await pod(`${root}/pod`, "clone", "--quiet", "--", url, ".");

    const parent = candidatesDir(`${root}/staging`);
    const [name] = readdirSync(parent, { withFileTypes: true }).map((e) => e.name);
    const dir = `${parent}/${name}`;
    const alternates = (await readFile(`${dir}/objects/info/alternates`, "utf8")).trim();
    assert(alternates.startsWith(await realpath(`${root}/cache`)), alternates);
    // The base commit resolves, but only through the cache entry.
    await git(dir, "cat-file", "-e", `${baseSha}^{commit}`);
    await git(dir, "cat-file", "-e", `${headSha}^{commit}`);
    await rm(`${dir}/objects/info/alternates`);
    await assertRejects(() => git(dir, "cat-file", "-e", `${baseSha}^{commit}`));
    await git(dir, "cat-file", "-e", `${headSha}^{commit}`);
  });
});

test("a candidate whose cache entry is gone is staged again and still clones", async () => {
  await withShippedRun(async ({ root, origin, upstream, baseSha, headSha, bundleKey, checks }) => {
    checks[CHECK_TOKEN] = checkGrant(upstream, { headSha, branchName: BRANCH, bundleKey });
    const pod = clientGit(origin, CHECK_TOKEN);
    const url = `${origin}/v1/git/${SUITE}/${REPO}/repo.git`;
    await mkdir(`${root}/first`);
    await pod(`${root}/first`, "clone", "--quiet", "--", url, ".");

    await rm(`${root}/cache`, { recursive: true });
    await mkdir(`${root}/second`);
    await pod(`${root}/second`, "clone", "--quiet", "--", url, ".");
    assertEquals(await git(`${root}/second`, "rev-parse", "HEAD"), headSha);
    assertEquals(await git(`${root}/second`, "rev-parse", "origin/main"), baseSha);
  });
});

test("a reused candidate advertises the base as the cache has it now", async () => {
  await withShippedRun(async ({ root, origin, upstream, headSha, bundleKey, checks }) => {
    checks[CHECK_TOKEN] = checkGrant(upstream, { headSha, branchName: BRANCH, bundleKey });
    const pod = clientGit(origin, CHECK_TOKEN);
    const url = `${origin}/v1/git/${SUITE}/${REPO}/repo.git`;
    await mkdir(`${root}/pod`);
    await pod(`${root}/pod`, "clone", "--quiet", "--", url, ".");

    // The base moves on (say, a newer checks file), and a run's clone warms the cache with it.
    await writeFile(`${upstream}/checks.txt`, "newer checks\n");
    await git(upstream, "add", ".");
    await commit(upstream, "newer checks");
    const newer = await git(upstream, "rev-parse", "HEAD");
    const run = clientGit(origin, RUN_TOKEN);
    await run(root, "ls-remote", "--", `${origin}/v1/git/r-a/${REPO}/repo.git`);

    const listed = await pod(root, "ls-remote", "--", url, "refs/heads/main");
    assert(listed.startsWith(newer), listed);
    const staged = readdirSync(candidatesDir(`${root}/staging`), { withFileTypes: true });
    assertEquals(staged.length, 1, "reused, not staged again");
  });
});

test("a candidate past the TTL is swept and staged again for the pod that asks for it", async () => {
  await withShippedRun(async ({ root, origin, upstream, headSha, bundleKey, checks }) => {
    checks[CHECK_TOKEN] = checkGrant(upstream, { headSha, branchName: BRANCH, bundleKey });
    const pod = clientGit(origin, CHECK_TOKEN);
    const url = `${origin}/v1/git/${SUITE}/${REPO}/repo.git`;
    await mkdir(`${root}/first`);
    await pod(`${root}/first`, "clone", "--quiet", "--", url, ".");
    const parent = candidatesDir(`${root}/staging`);
    const [name] = readdirSync(parent, { withFileTypes: true }).map((e) => e.name);
    const old = new Date(Date.now() - CANDIDATE_TTL_MS - 60_000);
    await utimes(`${parent}/${name}`, old, old);

    await mkdir(`${root}/second`);
    await pod(`${root}/second`, "clone", "--quiet", "--", url, ".");
    assertEquals(await git(`${root}/second`, "rev-parse", "HEAD"), headSha);
    assertEquals(readdirSync(parent, { withFileTypes: true }).map((e) => e.name), [name]);
    assert((await stat(`${parent}/${name}`)).mtime!.getTime() > old.getTime());
  });
});

/**
 * A pull request the forge already has: a commit on a branch that is then deleted, so the only
 * name it keeps upstream is `refs/pull/42/head` — as a fork's head is, seen from the base repo.
 */
async function openPullRequest(upstream: string): Promise<string> {
  await git(upstream, "checkout", "--quiet", "-b", "contributor");
  await writeFile(`${upstream}/contribution.txt`, "a contributor's work\n");
  await git(upstream, "add", ".");
  await commit(upstream, "contribute");
  const head = await git(upstream, "rev-parse", "HEAD");
  await git(upstream, "update-ref", "refs/pull/42/head", head);
  await git(upstream, "checkout", "--quiet", "main");
  await git(upstream, "branch", "--quiet", "-D", "contributor");
  return head;
}

const PR_BRANCH = "pull/42/head";

const forgeGrant = (url: string, headSha: string, fetchRef: string | null): RunGrant => ({
  runId: SUITE,
  repos: [member(url, { candidate: { headSha, branchName: PR_BRANCH, fetchRef } })],
});

const infoRefs = (handler: (req: Request) => Promise<Response>) =>
  handler(
    new Request(
      `http://forge/v1/git/${SUITE}/${REPO}/repo.git/info/refs?service=git-upload-pack`,
      { headers: { authorization: basic(CHECK_TOKEN) } },
    ),
  );

test("a forge candidate clones a change request's head by id, with the base beside it", async () => {
  await withShippedRun(async ({ root, origin, upstream, baseSha, checks }) => {
    const prHead = await openPullRequest(upstream);
    checks[CHECK_TOKEN] = forgeGrant(upstream, prHead, "refs/pull/42/head");
    const pod = clientGit(origin, CHECK_TOKEN);
    const url = `${origin}/v1/git/${SUITE}/${REPO}/repo.git`;
    for (const name of ["pristine", "again"]) {
      const dir = `${root}/${name}`;
      await mkdir(dir);
      await pod(dir, "clone", "--quiet", "--", url, ".");
      assertEquals(await git(dir, "rev-parse", "HEAD"), prHead);
      assertEquals(await git(dir, "rev-parse", "origin/main"), baseSha);
    }
    const staged = readdirSync(candidatesDir(`${root}/staging`), { withFileTypes: true });
    assertEquals(staged.length, 1, "one candidate, staged once");

    // Fetched by id, so no ref names it in the entry every run of the upstream clones from.
    const [entry] = readdirSync(`${root}/cache`, { withFileTypes: true }).map((e) => e.name);
    const refs = await git(`${root}/cache/${entry}`, "for-each-ref", "--format=%(objectname)");
    assert(!refs.includes(prHead), refs);
    const other = clientGit(origin, OTHER_RUN_TOKEN);
    const listed = await other(root, "ls-remote", "--", `${origin}/v1/git/r-b/${REPO}/repo.git`);
    assert(!listed.includes(prHead), "a fetched head must not be advertised to runs");
  });
});

test("a forge candidate whose head the forge does not have is a terminal 409", async () => {
  await withShippedRun(async ({ handler, upstream, checks }) => {
    for (const fetchRef of [null, "refs/pull/42/head"]) {
      checks[CHECK_TOKEN] = forgeGrant(upstream, "e".repeat(40), fetchRef);
      const res = await infoRefs(handler);
      assertEquals(res.status, 409, String(fetchRef));
      assert((await res.json()).error.includes("is not on the forge"));
    }
  });
});

test("a forge that will not serve the head by id is asked for the change request's ref", async () => {
  await withShippedRun(async ({ root, origin, handler, upstream, checks, deps }) => {
    // A head pushed over since, which a v0 forge serves only through the ref that leads to it.
    const old = await pushedOverPullRequest(upstream);
    const v0 = await serveProtocolV0(upstream);
    try {
      // With nothing to fall back on, the forge answered: no such commit.
      checks[CHECK_TOKEN] = forgeGrant(v0.url, old, null);
      assertEquals((await infoRefs(handler)).status, 409);

      // The entry the candidate borrows from, as runs see it before the fallback.
      const entry = await deps.cache.find({ url: v0.url }, "main");
      assert(entry !== null);
      const refsBefore = await git(entry.dir, "for-each-ref");
      const headBefore = await git(entry.dir, "symbolic-ref", "HEAD");

      // With the ref, it clones.
      checks[CHECK_TOKEN] = forgeGrant(v0.url, old, "refs/pull/42/head");
      const pod = clientGit(origin, CHECK_TOKEN);
      await mkdir(`${root}/pod`);
      await pod(
        `${root}/pod`,
        "clone",
        "--quiet",
        "--",
        `${origin}/v1/git/${SUITE}/${REPO}/repo.git`,
        ".",
      );
      assertEquals(await git(`${root}/pod`, "rev-parse", "HEAD"), old);
      // And the shared entry advertises nothing new, nor points its HEAD anywhere else.
      assertEquals(await git(entry.dir, "for-each-ref"), refsBefore);
      assertEquals(await git(entry.dir, "symbolic-ref", "HEAD"), headBefore);
    } finally {
      await v0.shutdown();
    }
  });
});

test("a forge candidate the forge could not be asked for is a 502 the clone retries, not a 409", async () => {
  await withShippedRun(async ({ origin, handler, upstream, root, checks, deps }) => {
    const prHead = await openPullRequest(upstream);
    const real = deps.cache;
    const down = () => Promise.reject(new Error("Could not resolve host: github.com"));
    deps.cache = { ...real, ensureCommit: down };
    for (const fetchRef of [null, "refs/pull/42/head"]) {
      checks[CHECK_TOKEN] = forgeGrant(upstream, prHead, fetchRef);
      const res = await infoRefs(handler);
      assertEquals(res.status, 502, String(fetchRef));
      assert((await res.json()).error.includes("retry"));
    }
    // Once the forge is back, the same grant clones.
    deps.cache = real;
    checks[CHECK_TOKEN] = forgeGrant(upstream, prHead, null);
    const pod = clientGit(origin, CHECK_TOKEN);
    await mkdir(`${root}/pod`);
    await pod(
      `${root}/pod`,
      "clone",
      "--quiet",
      "--",
      `${origin}/v1/git/${SUITE}/${REPO}/repo.git`,
      ".",
    );
    assertEquals(await git(`${root}/pod`, "rev-parse", "HEAD"), prHead);
  });
});

test("a forge candidate grant cannot ship a bundle either", async () => {
  await withShippedRun(async ({ root, handler, upstream, headSha, checks }) => {
    checks[CHECK_TOKEN] = forgeGrant(upstream, headSha, null);
    const intake = await handler(
      new Request(`http://forge/v1/patches/${REPO}`, {
        method: "POST",
        headers: { authorization: `Bearer ${CHECK_TOKEN}` },
        body: await readFile(`${root}/out.bundle`),
      }),
    );
    assertEquals(intake.status, 401);
  });
});

test("a candidate touched between the sweep's look and its rename is put back", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const old = new Date(Date.now() - 2 * CANDIDATE_TTL_MS);
    for (const name of ["kept", "gone"]) {
      await mkdir(`${parent}/${name}`);
      await writeFile(`${parent}/${name}/HEAD`, "ref: refs/heads/main\n");
      await utimes(`${parent}/${name}`, old, old);
    }
    // A request touches `kept` after the sweep read its age and before the rename lands.
    const move: typeof rename = async (from, to) => {
      if (String(from).endsWith("/kept")) {
        await utimes(from, new Date(), new Date());
      }
      return await rename(from, to);
    };
    await sweepCandidates(parent, Date.now(), silentDiagnostics(), move);
    const left = (await readdir(parent, { withFileTypes: true })).map((e) => e.name).sort();
    assertEquals(left, ["kept"]);
    assertEquals(await readFile(`${parent}/kept/HEAD`, "utf8"), "ref: refs/heads/main\n");
  } finally {
    await rm(parent, { recursive: true });
  }
});

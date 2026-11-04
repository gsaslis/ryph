// A newborn patch's lineage through the service route, against real git bundles on temp dirs: the
// lines of a run whose own commits it shares, never counting work already on the branch it lands
// on, and whether it holds the tip its line's change request merged at.

import { test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals } from "@std/assert";
import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { type ForgeApi, providerRegistry } from "../src/ports/forge_api.ts";
import { git } from "../src/helpers/git_exec.ts";
import { commit, makeUpstream, silentDiagnostics } from "./util.ts";

const SERVICE_TOKEN = "service-secret";
const REPO = "cr-1";

interface Ctx {
  root: string;
  upstream: string;
  /** The run's clone. */
  work: string;
  /** Where the run's branches start: main's tip when it cloned. */
  base: string;
  deps: AppDeps;
  ask(body: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
}

async function withRun(fn: (ctx: Ctx) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream, "patch-lineage");
    const diag = silentDiagnostics();
    const stagingDir = `${root}/staging`;
    await mkdir(stagingDir, { recursive: true });
    const never = () => Promise.reject(new Error("not part of this surface"));
    const deps: AppDeps = {
      keys: { resolve: () => Promise.resolve(null) },
      cache: localFsRepoCache({ root: `${root}/cache`, diag }),
      patches: localFsPatchStore(`${root}/patches`, diag),
      diag,
      forges: providerRegistry({
        github: {
          upstreamUrl: (_repo: unknown, url: string) => url,
          fetchAuth: () => Promise.resolve(null),
        } as unknown as ForgeApi,
      }, "forge API"),
      transports: providerRegistry({ github: { deliver: never } }, "change transport"),
      serviceToken: SERVICE_TOKEN,
      config: { maxUploadPackBytes: 10 * 1024 * 1024, maxBundleBytes: 1024 * 1024, stagingDir },
    };
    const handler = makeHandler(deps);
    const work = `${root}/work`;
    await mkdir(work);
    await git(work, "clone", "--quiet", "--", upstream, ".");
    const base = await git(work, "rev-parse", "HEAD");
    const ask = async (body: Record<string, unknown>) => {
      const res = await handler(
        new Request("http://forge/v1/service/patch-lineage", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${SERVICE_TOKEN}` },
          body: JSON.stringify({
            repo: { provider: "github", repoRef: "acme/app", tenantId: "42" },
            url: upstream,
            connectedRepoId: REPO,
            targetRef: "main",
            others: [],
            ...body,
          }),
        }),
      );
      return { status: res.status, body: await res.json() };
    };
    await fn({ root, upstream, work, base, deps, ask });
  } finally {
    await rm(root, { recursive: true });
  }
}

/** A line's branch in the run's clone, `from` a commit, with one commit per file; answers its
 * head. */
async function line(ctx: Ctx, name: string, from: string, files: string[]): Promise<string> {
  await git(ctx.work, "checkout", "--quiet", "-B", `ryph/run-1/${name}`, from);
  for (const file of files) {
    await writeFile(`${ctx.work}/${file}`, `${file}\n`);
    await git(ctx.work, "add", ".");
    await commit(ctx.work, `add ${file}`);
  }
  return await git(ctx.work, "rev-parse", "HEAD");
}

/** The line's bundle, cut from the run's base as the runner cuts it and filed as intake files it;
 * answers how a lineage question names it. */
async function bundle(ctx: Ctx, name: string, head: string) {
  const branchName = `ryph/run-1/${name}`;
  const path = `${ctx.root}/${name}.bundle`;
  await git(ctx.work, "bundle", "create", path, `${ctx.base}..refs/heads/${branchName}`);
  const bundleKey = `run-1/${name}/${REPO}/${head}.bundle`;
  await ctx.deps.patches.put(bundleKey, path);
  return { bundleKey, branchName, headSha: head };
}

test("lines with nothing in common overlap nowhere; a line stacked on another holds its commits", async () => {
  await withRun(async (ctx) => {
    const a = await line(ctx, "a", ctx.base, ["a.md"]);
    const b = await line(ctx, "b", ctx.base, ["b.md"]);
    const stacked = await line(ctx, "c", a, ["c.md"]);
    const others = [
      { line: "a", ...await bundle(ctx, "a", a) },
      { line: "b", ...await bundle(ctx, "b", b) },
    ];
    const c = await bundle(ctx, "c", stacked);
    assertEquals(await ctx.ask({ patch: c, others }), { status: 200, body: { overlaps: ["a"] } });
    const { line: _, ...lineB } = others[1];
    assertEquals(
      await ctx.ask({ patch: lineB, others: [others[0]] }),
      { status: 200, body: { overlaps: [] } },
    );
  });
});

test("commits already on the branch the line lands on are nobody's own", async () => {
  await withRun(async (ctx) => {
    const a = await line(ctx, "a", ctx.base, ["a.md"]);
    const stacked = await line(ctx, "c", a, ["c.md"]);
    const others = [{ line: "a", ...await bundle(ctx, "a", a) }];
    const c = await bundle(ctx, "c", stacked);
    // Line a's commit reaches main: the stacked line carries it, but so does where it lands.
    await git(ctx.upstream, "pull", "--quiet", "--ff-only", "--", ctx.work, `ryph/run-1/a`);
    assertEquals(await ctx.ask({ patch: c, others }), { status: 200, body: { overlaps: [] } });
  });
});

test("the tip its line merged at: held, not held, or not in the repo at all", async () => {
  await withRun(async (ctx) => {
    // Main moves on past the run's base: that tip is what the line's change request merged at.
    await writeFile(`${ctx.upstream}/merged.md`, "merged\n");
    await git(ctx.upstream, "add", ".");
    await commit(ctx.upstream, "the merge");
    const tip = await git(ctx.upstream, "rev-parse", "HEAD");
    await git(ctx.work, "fetch", "--quiet", "origin");
    const rebased = await line(ctx, "next", tip, ["next.md"]);
    const stale = await line(ctx, "old", ctx.base, ["old.md"]);
    const held = await bundle(ctx, "next", rebased);
    const unheld = await bundle(ctx, "old", stale);
    assertEquals(await ctx.ask({ patch: held, mustHold: tip }), {
      status: 200,
      body: { overlaps: [], holdsTip: true },
    });
    assertEquals(await ctx.ask({ patch: unheld, mustHold: tip }), {
      status: 200,
      body: { overlaps: [], holdsTip: false },
    });
    // A tip nobody has: nothing holds it.
    assertEquals(await ctx.ask({ patch: held, mustHold: "e".repeat(40) }), {
      status: 200,
      body: { overlaps: [], holdsTip: false },
    });
  });
});

test("a bundle key that is not this repo's head is refused", async () => {
  await withRun(async (ctx) => {
    const a = await line(ctx, "a", ctx.base, ["a.md"]);
    const patch = await bundle(ctx, "a", a);
    const res = await ctx.ask({ patch: { ...patch, headSha: "d".repeat(40) } });
    assertEquals(res.status, 400);
  });
});

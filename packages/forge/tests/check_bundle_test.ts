// A person's check bundle through the service route, against real git on temp dirs: the
// refusals patch intake makes (one ref, the right one, a cap, prerequisites the base satisfies),
// the one place it is more patient than patch intake (a base the laptop has seen newer than our
// cache is refreshed once before the bundle is blamed), and the hand-off — a check grant naming
// the stored key clones exactly that commit through the gateway.

import { test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { serve } from "@ryph/service";
import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { CHECK_BUNDLE_HEADER, CHECK_BUNDLE_REFRESH_INTERVAL_MS } from "../src/http/service.ts";
import { checkBundleKey } from "../src/http/bundle_intake.ts";
import { anonymous } from "../src/ports/repo_cache.ts";
import { type ForgeApi, providerRegistry } from "../src/ports/forge_api.ts";
import type { RunGrant } from "../src/core/types.ts";
import { git, makeGit } from "../src/helpers/git_exec.ts";
import { commit, makeUpstream, recordingDiagnostics } from "./util.ts";

const SERVICE_TOKEN = "service-secret";
const REPO = "cr-1";
const USER = "u-0123456789";
const BRANCH = "feature/fast-path";
const CAP = 64 * 1024;

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
  baseSha: string;
  handler: (req: Request) => Promise<Response>;
  deps: AppDeps;
  grants: Record<string, RunGrant>;
  events: Array<{ level: "debug" | "warn"; event: string }>;
  /** The forge's clock, in epoch ms; a test moves it by hand. */
  clock: { t: number };
}

async function withForge(fn: (ctx: Ctx) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const upstream = `${root}/upstream`;
    const baseSha = await makeUpstream(upstream, "check-bundle");
    const { diag, events } = recordingDiagnostics();
    const stagingDir = `${root}/staging`;
    await mkdir(stagingDir, { recursive: true });
    const grants: Record<string, RunGrant> = {};
    const clock = { t: Date.parse("2026-10-02T12:00:00Z") };
    const never = () => Promise.reject(new Error("not part of this surface"));
    const deps: AppDeps = {
      keys: { resolve: (token) => Promise.resolve(structuredClone(grants[token] ?? null)) },
      cache: localFsRepoCache({ root: `${root}/cache`, diag }),
      patches: localFsPatchStore(`${root}/patches`, diag),
      diag,
      forges: providerRegistry({ github: tokenOnlyForgeApi() }, "forge API"),
      transports: providerRegistry({ github: { deliver: never } }, "change transport"),
      serviceToken: SERVICE_TOKEN,
      config: { maxUploadPackBytes: 10 * 1024 * 1024, maxBundleBytes: CAP, stagingDir },
      now: () => clock.t,
    };
    await fn({ root, upstream, baseSha, handler: makeHandler(deps), deps, grants, events, clock });
  } finally {
    await rm(root, { recursive: true });
  }
}

type Meta = Record<string, unknown>;

const metaFor = (upstream: string, over: Meta = {}): Meta => ({
  repo: { provider: "github", repoRef: "acme/app", tenantId: null },
  url: upstream,
  connectedRepoId: REPO,
  userId: USER,
  branchName: BRANCH,
  ...over,
});

function post(
  handler: Ctx["handler"],
  body: BodyInit,
  header: string | null,
  token: string | null = SERVICE_TOKEN,
) {
  return handler(
    new Request("http://forge/v1/service/check-bundle", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(header === null ? {} : { [CHECK_BUNDLE_HEADER]: header }),
      },
      body,
    }),
  );
}

/** A laptop's clone of `upstream` with one commit of its own on `branch`; returns the work dir,
 * the head, and the commit the branch was cut from. */
async function laptop(root: string, upstream: string, branch = BRANCH, name = "laptop") {
  const work = `${root}/${name}`;
  await mkdir(work);
  await git(work, "clone", "--quiet", "--", upstream, ".");
  const forkPoint = await git(work, "rev-parse", "HEAD");
  await git(work, "checkout", "--quiet", "-b", branch);
  await writeFile(`${work}/${name}.txt`, `${name}\n`);
  await git(work, "add", ".");
  await commit(work, `work on ${branch}`);
  return { work, head: await git(work, "rev-parse", "HEAD"), forkPoint };
}

async function bundle(
  work: string,
  out: string,
  ...revs: string[]
): Promise<Uint8Array<ArrayBuffer>> {
  await git(work, "bundle", "create", out, ...revs);
  return await readFile(out);
}

async function stored(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(`${dir}/${e.name}`, `${prefix}${e.name}/`);
      else found.push(`${prefix}${e.name}`);
    }
  };
  try {
    await walk(`${root}/patches`, "");
  } catch {
    // no store directory at all — equally empty
  }
  return found;
}

async function assertTerminal(res: Response, status: number, includes: string) {
  assertEquals(res.status, status);
  const body = await res.json();
  assertEquals(body.terminal, true);
  assertStringIncludes(body.error, includes);
}

test("delegation bundle reads require service auth and a safe bundle key", async () => {
  await withForge(async ({ root, handler, deps }) => {
    const ask = (key: string, token = SERVICE_TOKEN) =>
      handler(
        new Request(
          "http://forge/v1/service/check-bundle/read",
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ bundleKey: key }),
          },
        ),
      );
    assertEquals((await ask("run/repo/head.bundle", "wrong")).status, 401);
    for (const key of ["../secret.bundle", "/secret.bundle", "environments/log.txt"]) {
      assertEquals((await ask(key)).status, 400);
    }
    assertEquals((await ask("run/repo/head.bundle")).status, 404);
    const staging = `${root}/read-bundle`;
    await writeFile(staging, "bundle bytes");
    await deps.patches.put("run/repo/head.bundle", staging);
    const res = await ask("run/repo/head.bundle");
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("cache-control"), "no-store");
    assertEquals(await res.text(), "bundle bytes");
  });
});

test("a check bundle is verified, filed under the user, and answered with its head and key", async () => {
  await withForge(async ({ root, upstream, handler }) => {
    const { work, head, forkPoint } = await laptop(root, upstream);
    const bytes = await bundle(work, `${root}/b.bundle`, `${forkPoint}..refs/heads/${BRANCH}`);

    // No baseRef: the upstream's default branch, warmed into a cold cache.
    const res = await post(handler, bytes, JSON.stringify(metaFor(upstream)));
    assertEquals(res.status, 201);
    const body = await res.json();
    // The branch and the base enter the key as the first 16 hex of sha256("feature/fast-path")
    // and of sha256("main"), pinned here by hand because the orchestrator derives the same key
    // on its own.
    const key = `users/${USER}/39209061847d9847/0d6e4079e36703eb/${REPO}/${head}.bundle`;
    assertEquals(body, { headSha: head, bundleKey: key });
    assertEquals(
      await checkBundleKey({
        userId: USER,
        branchName: BRANCH,
        baseRef: "main",
        connectedRepoId: REPO,
        headSha: head,
      }),
      key,
    );
    assertEquals(await stored(root), [key]);

    // A named base works the same, and the same commit files under the same key.
    const again = await post(
      handler,
      bytes,
      JSON.stringify(metaFor(upstream, { baseRef: "main" })),
    );
    assertEquals(again.status, 201);
    assertEquals((await again.json()).bundleKey, body.bundleKey);
    assertEquals((await stored(root)).length, 1);
  });
});

test("the bundle's one ref must be exactly refs/heads/<branchName>", async () => {
  await withForge(async ({ root, upstream, handler }) => {
    const meta = JSON.stringify(metaFor(upstream));
    const { work, forkPoint } = await laptop(root, upstream);

    // Somebody else's branch.
    await git(work, "branch", "--quiet", "other");
    const wrong = await bundle(work, `${root}/wrong.bundle`, `${forkPoint}..refs/heads/other`);
    await assertTerminal(await post(handler, wrong, meta), 400, `expected "refs/heads/${BRANCH}"`);

    // Two refs.
    const two = await bundle(
      work,
      `${root}/two.bundle`,
      `${forkPoint}..refs/heads/${BRANCH}`,
      "refs/heads/other",
      `^${forkPoint}`,
    );
    await assertTerminal(await post(handler, two, meta), 400, "exactly one ref, got 2");

    // A run's generation suffix is a run's convention, nobody else's.
    await git(work, "branch", "--quiet", `${BRANCH}-2`);
    const gen = await bundle(work, `${root}/gen.bundle`, `${forkPoint}..refs/heads/${BRANCH}-2`);
    await assertTerminal(await post(handler, gen, meta), 400, `"refs/heads/${BRANCH}-2"`);

    // Not a bundle at all.
    await assertTerminal(await post(handler, new Uint8Array(16), meta), 400, "not a git bundle");

    assertEquals(await stored(root), []);
  });
});

test("a check bundle over the cap is a clean 413, declared or streamed", async () => {
  await withForge(async ({ root, upstream, handler }) => {
    const meta = JSON.stringify(metaFor(upstream));
    await assertTerminal(await post(handler, new Uint8Array(CAP + 1), meta), 413, "size limit");
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 80; i++) controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });
    await assertTerminal(await post(handler, chunked, meta), 413, "size limit");
    assertEquals(await stored(root), []);
    assertEquals(
      readdirSync(`${root}/staging`, { withFileTypes: true }),
      [],
      "nothing left staged",
    );
  });
});

test("a base the laptop saw newer than our cache is refreshed once, then the bundle is judged", async () => {
  await withForge(async ({ root, upstream, handler, deps, events }) => {
    // Our cache holds main as it was…
    await deps.cache.serveBase({ url: upstream }, "main", anonymous);
    // …then main moves on, and the laptop branches off the newer tip.
    await writeFile(`${upstream}/later.txt`, "later\n");
    await git(upstream, "add", ".");
    await commit(upstream, "later on main");
    const { work, head, forkPoint } = await laptop(root, upstream);
    const bytes = await bundle(work, `${root}/b.bundle`, `${forkPoint}..refs/heads/${BRANCH}`);

    const res = await post(handler, bytes, JSON.stringify(metaFor(upstream, { baseRef: "main" })));
    assertEquals(res.status, 201);
    assertEquals((await res.json()).headSha, head);
    assertEquals(
      events.filter((e) => e.event === "service.check_bundle_base_refreshed").length,
      1,
    );
  });
});

test("prerequisites a refreshed base still lacks are a terminal 400", async () => {
  await withForge(async ({ root, upstream, handler, deps, events }) => {
    await deps.cache.serveBase({ url: upstream }, "main", anonymous);
    // An unrelated repo's history: no refresh of ours will ever hold it.
    const foreign = `${root}/foreign`;
    const foreignBase = await makeUpstream(foreign, "foreign");
    await git(foreign, "checkout", "--quiet", "-b", BRANCH);
    await writeFile(`${foreign}/g.txt`, "y\n");
    await git(foreign, "add", ".");
    await commit(foreign, "foreign work");
    const bytes = await bundle(foreign, `${root}/f.bundle`, `${foreignBase}..refs/heads/${BRANCH}`);

    const res = await post(handler, bytes, JSON.stringify(metaFor(upstream)));
    await assertTerminal(res, 400, "prerequisites");
    assertEquals(
      events.filter((e) => e.event === "service.check_bundle_base_refreshed").length,
      1,
      "refreshed exactly once before refusing",
    );
    assertEquals(await stored(root), []);
  });
});

test("a cache that cannot be warmed is a retryable 503", async () => {
  await withForge(async ({ root, upstream, handler }) => {
    const { work, forkPoint } = await laptop(root, upstream);
    const bytes = await bundle(work, `${root}/b.bundle`, `${forkPoint}..refs/heads/${BRANCH}`);
    const gone = `${root}/nowhere`;
    for (const over of [{ baseRef: "main" }, {}]) {
      const res = await post(handler, bytes, JSON.stringify(metaFor(gone, over)));
      assertEquals(res.status, 503);
      assert((await res.json()).terminal !== true);
    }
  });
});

test("a malformed header is a terminal 400, before the body is read", async () => {
  await withForge(async ({ root, upstream, handler }) => {
    const body = new Uint8Array(8);
    await assertTerminal(await post(handler, body, null), 400, CHECK_BUNDLE_HEADER);
    await assertTerminal(await post(handler, body, "{nope"), 400, "not valid JSON");
    const bad: Meta[] = [
      { userId: "u-1/../../r-a" },
      { userId: ".." },
      { userId: "u.1" },
      { connectedRepoId: ".." },
      { connectedRepoId: "cr/1" },
      { branchName: "has space" },
      { branchName: "a..b" },
      { branchName: "-x" },
      { baseRef: "refs/tags/v1" },
      { extra: true },
    ];
    for (const over of bad) {
      const res = await post(handler, body, JSON.stringify(metaFor(upstream, over)));
      assertEquals(res.status, 400, JSON.stringify(over));
      assertEquals((await res.json()).terminal, true);
    }
    assertEquals(await stored(root), []);
  });
});

test("the check-bundle route wants the service token", async () => {
  await withForge(async ({ upstream, handler }) => {
    const meta = JSON.stringify(metaFor(upstream));
    assertEquals((await post(handler, new Uint8Array(8), meta, null)).status, 401);
    assertEquals((await post(handler, new Uint8Array(8), meta, "wrong")).status, 401);
  });
});

test("a check grant naming a user's bundle key clones exactly its head, whatever else was asked", async () => {
  await withForge(async ({ root, upstream, baseSha, deps, grants }) => {
    const handler = makeHandler(deps);
    const { work, head, forkPoint } = await laptop(root, upstream);
    const bytes = await bundle(work, `${root}/b.bundle`, `${forkPoint}..refs/heads/${BRANCH}`);
    const res = await post(handler, bytes, JSON.stringify(metaFor(upstream)));
    assertEquals(res.status, 201);
    const { bundleKey } = await res.json();

    // The same commit asked about on a second branch is a second bundle, and leaves the first
    // one — whose only ref is the first branch — where the first suite's clone will look.
    await git(work, "branch", "--quiet", "second");
    const second = await bundle(work, `${root}/s.bundle`, `${forkPoint}..refs/heads/second`);
    const res2 = await post(
      handler,
      second,
      JSON.stringify(metaFor(upstream, { branchName: "second" })),
    );
    assertEquals(res2.status, 201);
    assertEquals(
      (await res2.json()).bundleKey,
      `users/${USER}/16367aacb67a4a01/0d6e4079e36703eb/${REPO}/${head}.bundle`,
    );
    assertEquals((await stored(root)).length, 2);

    // And on the first branch against a second base, a third: its prerequisites were proven
    // against that base only, so it must not replace the bundle the first suite clones.
    await git(upstream, "branch", "release", "main");
    const res3 = await post(
      handler,
      bytes,
      JSON.stringify(metaFor(upstream, { baseRef: "release" })),
    );
    assertEquals(res3.status, 201);
    assertEquals(
      (await res3.json()).bundleKey,
      `users/${USER}/39209061847d9847/a4d451ec23463726/${REPO}/${head}.bundle`,
    );
    assertEquals((await stored(root)).length, 3);
    assert((await stored(root)).includes(bundleKey));

    grants["check-key"] = {
      runId: "cs-0123456789",
      repos: [{
        connectedRepoId: REPO,
        provider: "github",
        repoRef: "acme/app",
        url: upstream,
        ref: "main",
        branchNamespace: "ryph-check/cs-0123456789",
        tenantId: null,
        candidate: { headSha: head, branchName: BRANCH, bundleKey },
      }],
    };
    const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handler);
    try {
      const origin = `http://127.0.0.1:${server.addr.port}`;
      const pod = makeGit({ debug() {} }, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa("x-access-token:check-key")}`,
      });
      const dir = `${root}/pod`;
      await mkdir(dir);
      await pod(
        dir,
        "clone",
        "--quiet",
        "--",
        `${origin}/v1/git/cs-0123456789/${REPO}/repo.git`,
        ".",
      );
      assertEquals(await git(dir, "rev-parse", "HEAD"), head);
      assertEquals(await git(dir, "rev-parse", "origin/main"), baseSha);
    } finally {
      await server.shutdown();
    }
  });
});

test("a base branch the upstream does not have is a terminal 400, not a retry", async () => {
  await withForge(async ({ root, upstream, handler, deps }) => {
    const { work, forkPoint } = await laptop(root, upstream);
    const bytes = await bundle(work, `${root}/b.bundle`, `${forkPoint}..refs/heads/${BRANCH}`);
    // Cold, and then with main held: either way the ask names a branch nobody has.
    for (const prime of [false, true]) {
      if (prime) await deps.cache.serveBase({ url: upstream }, "main", anonymous);
      const res = await post(
        handler,
        bytes,
        JSON.stringify(metaFor(upstream, { baseRef: "origin/main" })),
      );
      await assertTerminal(res, 400, `"origin/main" is not on the repo`);
    }
    assertEquals(await stored(root), []);
  });
});

const askHead = (handler: Ctx["handler"], url: string, branch: string, token = SERVICE_TOKEN) =>
  handler(
    new Request("http://forge/v1/service/branch-head", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        repo: { provider: "github", repoRef: "acme/app", tenantId: null },
        url,
        branch,
      }),
    }),
  );

test("branch-head answers the live head of exactly that branch, and nothing lands in the cache", async () => {
  await withForge(async ({ root, upstream, baseSha, handler }) => {
    // A branch whose name ENDS like the one asked about must not answer for it.
    await git(upstream, "branch", "--quiet", "x/refs/heads/feature");
    await git(upstream, "checkout", "--quiet", "-b", "feature");
    await writeFile(`${upstream}/f.txt`, "f\n");
    await git(upstream, "add", ".");
    await commit(upstream, "feature work");
    const featureSha = await git(upstream, "rev-parse", "HEAD");
    await git(upstream, "checkout", "--quiet", "main");

    const res = await askHead(handler, upstream, "feature");
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { sha: featureSha });
    assertEquals(await (await askHead(handler, upstream, "main")).json(), { sha: baseSha });

    const missing = await askHead(handler, upstream, "nope");
    assertEquals(missing.status, 404);
    assertEquals((await missing.json()).terminal, true);

    const outage = await askHead(handler, `${root}/nowhere`, "main");
    assertEquals(outage.status, 502);
    assert((await outage.json()).terminal !== true);

    const ref = await askHead(handler, upstream, "refs/heads/feature");
    assertEquals(ref.status, 400);
    assertEquals((await askHead(handler, upstream, "main", "wrong")).status, 401);

    let cached = false;
    try {
      cached = readdirSync(`${root}/cache`, { withFileTypes: true }).some((e) => e.isDirectory());
    } catch {
      // no cache root at all
    }
    assertEquals(cached, false, "an ls-remote writes no entry");
  });
});

test("a failed verify refreshes one base at most once a minute; inside that, the 400 is at once", async () => {
  await withForge(async ({ root, upstream, handler, deps, events, clock }) => {
    const refreshes = () =>
      events.filter((e) => e.event === "service.check_bundle_base_refreshed").length;
    await deps.cache.serveBase({ url: upstream }, "main", anonymous);
    const meta = JSON.stringify(metaFor(upstream, { baseRef: "main" }));

    // A bundle no refresh can satisfy: the first refreshes, the second inside the window does
    // not, and both are the same terminal 400.
    const foreign = `${root}/foreign`;
    const foreignBase = await makeUpstream(foreign, "foreign");
    await git(foreign, "checkout", "--quiet", "-b", BRANCH);
    await writeFile(`${foreign}/g.txt`, "y\n");
    await git(foreign, "add", ".");
    await commit(foreign, "foreign work");
    const bad = await bundle(foreign, `${root}/f.bundle`, `${foreignBase}..refs/heads/${BRANCH}`);
    await assertTerminal(await post(handler, bad, meta), 400, "prerequisites");
    assertEquals(refreshes(), 1);
    clock.t += CHECK_BUNDLE_REFRESH_INTERVAL_MS - 1;
    // …and the refusal says the copy may lag, so a person whose base just moved knows to wait.
    await assertTerminal(
      await post(handler, bad, meta),
      400,
      "ryph's copy of main was refreshed under a minute ago and may lag the forge; " +
        "if main just moved, try again in a minute",
    );
    assertEquals(refreshes(), 1, "no second fetch inside the window");

    // The price, stated: main moving on inside the window is not seen until it closes.
    await writeFile(`${upstream}/later.txt`, "later\n");
    await git(upstream, "add", ".");
    await commit(upstream, "later on main");
    const { work, head, forkPoint } = await laptop(root, upstream);
    const good = await bundle(work, `${root}/b.bundle`, `${forkPoint}..refs/heads/${BRANCH}`);
    await assertTerminal(await post(handler, good, meta), 400, "prerequisites");
    clock.t += 1;
    const res = await post(handler, good, meta);
    assertEquals(res.status, 201);
    assertEquals((await res.json()).headSha, head);
    assertEquals(refreshes(), 2);
  });
});

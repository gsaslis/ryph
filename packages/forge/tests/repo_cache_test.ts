// The cache adapter's own behaviour, at the level the HTTP doors depend on: what a FAILED warm
// leaves behind, what `find` is therefore entitled to call a hit, and what a failed REFRESH
// serves.
//
// This matters more than it looks. `find` is the fast path for both doors, and a hit means they
// skip the fetch. `git init` writes HEAD before the first fetch runs, so a directory's mere
// SHAPE proves nothing — a door that trusted it would verify a bundle against an empty repo and
// answer TERMINALLY. Two things keep that from happening, and both are pinned here: a failed
// first warm removes what it made, and a hit has to resolve the base ref that was asked for.
//
// The other half is the seam: `serveBase` answers a failed refresh with the copy it holds,
// marked stale from the first failure until the next success, unless the upstream refused;
// `refreshBase` never does. Every branch of that is pinned here too.

import { test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { serve } from "@ryph/service";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { anonymous, UpstreamRefused } from "../src/ports/repo_cache.ts";
import { git } from "../src/helpers/git_exec.ts";
import type { Diagnostics } from "../src/ports/diagnostics.ts";
import {
  commit,
  makeUpstream,
  pushedOverPullRequest,
  recordingDiagnostics,
  serveProtocolV0,
  silentDiagnostics,
} from "./util.ts";

/** The `cache.*` warns in order: a refresh outcome is logged exactly once, under its own name. */
const cacheWarns = (events: Array<{ level: string; event: string }>) =>
  events.filter((e) => e.level === "warn" && e.event.startsWith("cache.")).map((e) => e.event);

test("a failed first fetch leaves no entry behind, so find() is not fooled", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });
    // An upstream that is not there: `git init` succeeds, the fetch does not.
    await assertRejects(() => cache.serveBase({ url: `${root}/absent` }, "main", anonymous));

    assertEquals(
      await cache.find({ url: `${root}/absent` }, "main"),
      null,
      "a half-made entry must not read as a cache hit",
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a failed REFRESH serves the base it already had, marked stale, and keeps the sha", async () => {
  // The seam. Cleanup is only ever for an entry the failing call created; a warm base a later
  // fetch could not refresh still serves, and says so.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const upstream = `${root}/upstream`;
    const baseSha = await makeUpstream(upstream);
    const { diag, events } = recordingDiagnostics();
    const cache = localFsRepoCache({
      root: `${root}/cache`,
      diag,
      now: () => new Date("2026-09-30T08:00:00Z"),
    });

    const first = await cache.serveBase({ url: upstream }, "main", anonymous);
    assertEquals(first.freshness, { kind: "fresh" });
    assertEquals(await git(first.dir, "rev-parse", "refs/heads/main"), baseSha);

    // The upstream goes away; the entry must not, and the branch is served as it was.
    await rm(upstream, { recursive: true });
    const served = await cache.serveBase({ url: upstream }, "main", anonymous);
    assertEquals(served.freshness, { kind: "stale", since: "2026-09-30T08:00:00.000Z" });
    assertEquals(await git(served.dir, "rev-parse", "refs/heads/main"), baseSha);
    assertEquals(await cache.find({ url: upstream }, "main"), {
      dir: served.dir,
      localBranch: "main",
      commit: baseSha,
      freshness: { kind: "stale", since: "2026-09-30T08:00:00.000Z" },
    });
    assertEquals(cacheWarns(events), ["cache.served_stale"], "a handled outage is one warn");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the stale mark keeps its first instant across failures, and clears on a success", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    let clock = new Date("2026-09-30T08:00:00Z");
    const cache = localFsRepoCache({
      root: `${root}/cache`,
      diag: silentDiagnostics(),
      now: () => clock,
    });
    await cache.serveBase({ url: upstream }, "main", anonymous);

    // Two failures, an hour apart: `since` is the first one.
    await rename(upstream, `${root}/parked`);
    await cache.serveBase({ url: upstream }, "main", anonymous);
    clock = new Date("2026-09-30T09:00:00Z");
    const second = await cache.serveBase({ url: upstream }, "main", anonymous);
    assertEquals(second.freshness, { kind: "stale", since: "2026-09-30T08:00:00.000Z" });

    // The upstream returns with a new commit: the serve is fresh again, the mark is gone, and
    // the branch is the upstream's.
    await rename(`${root}/parked`, upstream);
    await writeFile(`${upstream}/more.txt`, "moved on\n");
    await git(upstream, "add", ".");
    await commit(upstream, "move on");
    const moved = await git(upstream, "rev-parse", "HEAD");
    const back = await cache.serveBase({ url: upstream }, "main", anonymous);
    assertEquals(back.freshness, { kind: "fresh" });
    assertEquals(await git(back.dir, "rev-parse", "refs/heads/main"), moved);
    assertEquals((await cache.find({ url: upstream }, "main"))?.freshness, { kind: "fresh" });
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a cold entry has nothing to serve stale: the first fetch's failure is the answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });
    await assertRejects(() => cache.serveBase({ url: `${root}/absent` }, "main", anonymous));
    assertEquals(await cache.find({ url: `${root}/absent` }, "main"), null);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a branch the entry never held is not served stale either", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });
    await cache.serveBase({ url: upstream }, "main", anonymous);
    await rm(upstream, { recursive: true });
    await assertRejects(() => cache.serveBase({ url: upstream }, "release", anonymous));
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an upstream that REFUSED is never served around, and leaves no mark", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    const { diag, events } = recordingDiagnostics();
    const cache = localFsRepoCache({ root: `${root}/cache`, diag });
    await cache.serveBase({ url: upstream }, "main", anonymous);

    const refused = () => Promise.reject(new UpstreamRefused("repo", "installation suspended"));
    await assertRejects(
      () => cache.serveBase({ url: upstream }, "main", refused),
      UpstreamRefused,
      "suspended",
    );
    assertEquals((await cache.find({ url: upstream }, "main"))?.freshness, { kind: "fresh" });
    assertEquals(cacheWarns(events), ["cache.fetch_failed"], "a refusal is one warn");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a credential that could not be obtained is an outage: the held base serves stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const upstream = `${root}/upstream`;
    const baseSha = await makeUpstream(upstream);
    const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });
    await cache.serveBase({ url: upstream }, "main", anonymous);

    const unreachable = () => Promise.reject(new TypeError("error sending request"));
    const served = await cache.serveBase({ url: upstream }, "main", unreachable);
    assertEquals(served.freshness.kind, "stale");
    assertEquals(await git(served.dir, "rev-parse", "refs/heads/main"), baseSha);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("refreshBase is strict: it rejects on a failed refresh and keeps the entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const upstream = `${root}/upstream`;
    const baseSha = await makeUpstream(upstream);
    const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });
    const first = await cache.refreshBase({ url: upstream }, "main", anonymous);
    assertEquals(first, { dir: first.dir, localBranch: "main" });

    await rm(upstream, { recursive: true });
    await assertRejects(() => cache.refreshBase({ url: upstream }, "main", anonymous));
    const still = await cache.find({ url: upstream }, "main");
    assert(still !== null, "the existing base survived a failed strict refresh");
    assertEquals(await git(still.dir, "rev-parse", "refs/heads/main"), baseSha);
    assertEquals(still.freshness, { kind: "fresh" }, "a strict refresh marks nothing");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a retry after a failed warm succeeds once the upstream is back", async () => {
  // The recovery the cleanup exists to permit: the first attempt failed, and nothing it left
  // behind stops the second from doing the whole job.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const upstream = `${root}/upstream`;
    const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });
    await assertRejects(() => cache.serveBase({ url: upstream }, "main", anonymous));

    const baseSha = await makeUpstream(upstream);
    const warmed = await cache.serveBase({ url: upstream }, "main", anonymous);
    assertEquals(await git(warmed.dir, "rev-parse", "refs/heads/main"), baseSha);
    assertEquals(warmed.freshness, { kind: "fresh" });
  } finally {
    await rm(root, { recursive: true });
  }
});

test("find() reads the mark before the tip, so a refresh between the two cannot hide a stale fetch", async () => {
  // `refresh` moves the branch and then clears the mark, and `find` is not serialized against
  // it. Reading the mark first means a mark seen clear was cleared after the branch moved, so
  // the tip read next is at least the refreshed one, and a fetch that landed on the old tip
  // always disagrees with the answer. The other order can answer the old tip as fresh.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    const ops: string[] = [];
    const diag: Diagnostics = {
      debug: (event, data) => {
        if (event === "git.exec" && typeof data?.op === "string") ops.push(data.op);
      },
      warn() {},
    };
    const cache = localFsRepoCache({ root: `${root}/cache`, diag });
    await cache.serveBase({ url: upstream }, "main", anonymous);
    ops.length = 0;
    assert(await cache.find({ url: upstream }, "main") !== null);
    assertEquals(ops, ["config", "rev-parse"]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("find() is about the base, not the directory: no ref resolved, no hit", async () => {
  // The debris the cleanup above cannot reach — a process killed mid-creation, an entry left by
  // an older build — plus the ordinary case of an entry warmed for some OTHER base. Both look
  // exactly like a cache hit from the outside, and neither can answer for this run's base.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });
    const warm = await cache.serveBase({ url: upstream }, "main", anonymous);

    assert(await cache.find({ url: upstream }, "main") !== null, "the base it holds IS a hit");
    assertEquals(
      await cache.find({ url: upstream }, "some-other-branch"),
      null,
      "a base this entry never fetched is not a hit",
    );

    // Reduced to what `git init --bare` alone leaves: HEAD, and nothing to serve.
    await rm(warm.dir, { recursive: true });
    await mkdir(warm.dir, { recursive: true });
    await git(warm.dir, "init", "--bare", "--quiet");
    assertEquals(
      await cache.find({ url: upstream }, "main"),
      null,
      "a repo-shaped directory with no base in it is not a hit",
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a credential that cannot be obtained is a failed refresh, judged like any other", async () => {
  // The mint happens where the fetch does. An entry this call created is removed, `find` is not
  // fooled, and the failure is logged as the refresh failure it is: the upstream was never asked.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    const { diag, events } = recordingDiagnostics();
    const cache = localFsRepoCache({ root: `${root}/cache`, diag });
    const refused = () => Promise.reject(new Error("GitHub would not mint"));

    await assertRejects(() => cache.serveBase({ url: upstream }, "main", refused), Error, "mint");
    assertEquals(await cache.find({ url: upstream }, "main"), null);
    assertEquals(cacheWarns(events), ["cache.fetch_failed"]);
    assertEquals(events.filter((e) => e.event === "git.exec" && e.level === "debug").length, 2);
  } finally {
    await rm(root, { recursive: true });
  }
});

/** The upstream over dumb HTTP, off a static file server the test can take over. Stalled, it
 * accepts the connection and never answers, which is what a black-holed GitHub looks like.
 * Answering one status to everything is what a deleted, private, or ungranted repo looks like. */
async function switchableUpstream(root: string, upstream: string) {
  const bare = `${root}/bare.git`;
  await git(root, "clone", "--quiet", "--bare", upstream, bare);
  await git(bare, "update-server-info");
  let mode: "serve" | "stall" | number = "serve";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    if (mode === "stall") {
      await gate;
      return new Response("late", { status: 503 });
    }
    if (typeof mode === "number") return new Response("no", { status: mode });
    const path = decodeURIComponent(new URL(req.url).pathname.replace(/^\/repo\.git/, ""));
    try {
      return new Response(await readFile(`${bare}${path}`));
    } catch {
      return new Response("nope", { status: 404 });
    }
  });
  return {
    url: `http://127.0.0.1:${server.addr.port}/repo.git`,
    stall: () => void (mode = "stall"),
    answer: (status: number) => void (mode = status),
    shutdown: async () => {
      release();
      await server.shutdown();
    },
  };
}

test("a branch deleted upstream is a refusal that drops the branch from the entry", async () => {
  // git answered, and the answer is that the ref is gone. The copy the entry holds is of a
  // branch that no longer exists: kept, the advertisement would go on listing its old tip and
  // `find` would call it fresh, so a run whose target was merged and deleted upstream would
  // merge a dead branch and report itself caught up. The entry's other branches stay.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const upstream = `${root}/upstream`;
    await makeUpstream(upstream);
    await git(upstream, "branch", "release");
    await git(upstream, "branch", "hotfix");
    const cache = localFsRepoCache({
      root: `${root}/cache`,
      diag: silentDiagnostics(),
      now: () => new Date("2026-09-30T08:00:00Z"),
    });
    const main = await cache.serveBase({ url: upstream }, "main", anonymous);
    const { dir } = await cache.serveBase({ url: upstream }, "release", anonymous);
    await cache.serveBase({ url: upstream }, "hotfix", anonymous);

    // An outage first, so the branch carries a mark the refusal has to take with it.
    await rename(upstream, `${root}/away`);
    const outage = await cache.serveBase({ url: upstream }, "release", anonymous);
    assertEquals(outage.freshness, { kind: "stale", since: "2026-09-30T08:00:00.000Z" });
    await rename(`${root}/away`, upstream);

    await git(upstream, "branch", "-D", "release");
    const refusal = await assertRejects(
      () => cache.serveBase({ url: upstream }, "release", anonymous),
      UpstreamRefused,
      "couldn't find remote ref refs/heads/release",
    );
    assertEquals(refusal.reason, "missing-ref");
    assertEquals(await cache.find({ url: upstream }, "release"), null, "the branch is gone");
    await assertRejects(
      () => git(dir, "config", "--get", "ryph.release.staleSince"),
      Error,
      "",
      "the mark went with the branch",
    );
    assertEquals(await cache.find({ url: upstream }, "main"), main, "the other branches stay");

    // The strict call drops it the same way: the step is the refresh both calls share.
    await git(upstream, "branch", "-D", "hotfix");
    await assertRejects(
      () => cache.refreshBase({ url: upstream }, "hotfix", anonymous),
      UpstreamRefused,
      "couldn't find remote ref refs/heads/hotfix",
    );
    assertEquals(await cache.find({ url: upstream }, "hotfix"), null);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an http upstream that answers 404, 403, or 401 refused: the held copy is not served", async () => {
  // A repo deleted, gone private, or removed from the installation: the token still mints and
  // git gets a definitive status. Each is the owner's answer, and none leaves a mark.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const upstream = `${root}/upstream`;
  await makeUpstream(upstream);
  const remote = await switchableUpstream(root, upstream);
  try {
    const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });
    await cache.serveBase({ url: remote.url }, "main", anonymous);

    const gitSaid: Record<number, string> = {
      404: "not found",
      403: "The requested URL returned error: 403",
      401: "could not read Username",
    };
    for (const [status, phrase] of Object.entries(gitSaid)) {
      remote.answer(Number(status));
      const refusal = await assertRejects(
        () => cache.serveBase({ url: remote.url }, "main", anonymous),
        UpstreamRefused,
        phrase,
        `a ${status} is a refusal`,
      );
      // About the repo, not the branch: an installation can be restored, and the branch still
      // exists upstream, so the entry keeps it.
      assertEquals(refusal.reason, "repo");
      assertEquals((await cache.find({ url: remote.url }, "main"))?.freshness, { kind: "fresh" });
    }

    // A 401 with a credential presented is the same answer: git drops the rejected header and
    // then cannot prompt for another, which is the no it reports.
    remote.answer(401);
    const credential = () =>
      Promise.resolve({ origin: new URL(remote.url).origin, token: "ghs_live_token" });
    await assertRejects(
      () => cache.serveBase({ url: remote.url }, "main", credential),
      UpstreamRefused,
      "could not read Username",
    );
  } finally {
    await remote.shutdown();
    await rm(root, { recursive: true });
  }
});

test("ensureCommit and remoteDefaultBranch classify a definitive answer the same way", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const upstream = `${root}/upstream`;
  const baseSha = await makeUpstream(upstream);
  const remote = await switchableUpstream(root, upstream);
  try {
    const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });
    assertEquals(await cache.remoteDefaultBranch({ url: remote.url }, anonymous), "main");

    remote.answer(404);
    await assertRejects(
      () => cache.remoteDefaultBranch({ url: remote.url }, anonymous),
      UpstreamRefused,
      "not found",
    );
    await assertRejects(
      () => cache.ensureCommit({ url: remote.url }, baseSha, anonymous),
      UpstreamRefused,
      "not found",
    );
  } finally {
    await remote.shutdown();
    await rm(root, { recursive: true });
  }
});

test("ensureCommit tells a commit the upstream does not have from an upstream it cannot ask", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const upstream = `${root}/upstream`;
  const baseSha = await makeUpstream(upstream);
  const remote = await switchableUpstream(root, upstream);
  try {
    const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });
    // Asked, and answered: no such commit. A path runs the real upload-pack, which words it as
    // a smart-HTTP upstream does (the switchable one below is dumb HTTP, and cannot be asked).
    const err = await assertRejects(
      () => cache.ensureCommit({ url: upstream }, "e".repeat(40), anonymous),
      UpstreamRefused,
    );
    assertEquals(err.reason, "missing-commit");
    // An id the upstream holds that is not a commit is an answer too.
    const tree = await git(upstream, "rev-parse", `${baseSha}^{tree}`);
    const notCommit = await assertRejects(
      () => cache.ensureCommit({ url: upstream }, tree, anonymous),
      UpstreamRefused,
    );
    assertEquals(notCommit.reason, "missing-commit");

    // Not asked at all: a 5xx, and a host that is not there, are outages, never a refusal.
    remote.answer(500);
    const outage = await assertRejects(() =>
      cache.ensureCommit({ url: remote.url }, "e".repeat(40), anonymous)
    );
    assert(!(outage instanceof UpstreamRefused), String(outage));
    const nowhere = await assertRejects(() =>
      cache.ensureCommit({ url: "http://127.0.0.1:9/nope.git" }, "e".repeat(40), anonymous)
    );
    assert(!(nowhere instanceof UpstreamRefused), String(nowhere));
  } finally {
    await remote.shutdown();
    await rm(root, { recursive: true });
  }
});

test("a commit an upstream will not serve by id comes through its fallback ref, leaving no ref behind", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const upstream = `${root}/upstream`;
  await makeUpstream(upstream);
  const old = await pushedOverPullRequest(upstream);
  const v0 = await serveProtocolV0(upstream);
  // A translated git would word every answer differently; the cache asks for C regardless.
  const locale = [process.env.LC_ALL, process.env.LANG];
  process.env.LC_ALL = "de_DE.UTF-8";
  process.env.LANG = "de_DE.UTF-8";
  try {
    const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });
    const { dir } = await cache.serveBase({ url: v0.url }, "main", anonymous);
    const refsBefore = await git(dir, "for-each-ref");
    const headBefore = await git(dir, "symbolic-ref", "HEAD");

    // By id, it is no tip, so this upstream answers no — an answer, not an outage.
    const byId = await assertRejects(
      () => cache.ensureCommit({ url: v0.url }, old, anonymous),
      UpstreamRefused,
    );
    assertEquals(byId.reason, "missing-commit");
    // A fallback ref that is not there either: still an answer.
    const neither = await assertRejects(
      () =>
        cache.ensureCommit({ url: v0.url }, old, anonymous, { fallbackRef: "refs/pull/9/head" }),
      UpstreamRefused,
    );
    assertEquals(neither.reason, "missing-commit");

    // Through the pull request's ref, the objects land — and only the objects.
    assertEquals(
      (await cache.ensureCommit({ url: v0.url }, old, anonymous, {
        fallbackRef: "refs/pull/42/head",
      })).dir,
      dir,
    );
    await git(dir, "cat-file", "-e", `${old}^{commit}`);
    assertEquals(await git(dir, "for-each-ref"), refsBefore);
    assertEquals(await git(dir, "symbolic-ref", "HEAD"), headBefore);
  } finally {
    for (const [name, value] of [["LC_ALL", locale[0]], ["LANG", locale[1]]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await v0.shutdown();
    await rm(root, { recursive: true });
  }
});

test("an upstream that hangs fails into the seam: the held base serves stale in bounded time", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const upstream = `${root}/upstream`;
  const baseSha = await makeUpstream(upstream);
  const remote = await switchableUpstream(root, upstream);
  try {
    const cache = localFsRepoCache({
      root: `${root}/cache`,
      diag: silentDiagnostics(),
      stallSeconds: 1,
    });
    const first = await cache.serveBase({ url: remote.url }, "main", anonymous);
    assertEquals(first.freshness, { kind: "fresh" });
    assertEquals(await git(first.dir, "rev-parse", "refs/heads/main"), baseSha);

    remote.stall();
    const started = performance.now();
    const served = await cache.serveBase({ url: remote.url }, "main", anonymous);
    assert(performance.now() - started < 10_000, "the fetch gave up on its own");
    assertEquals(served.freshness.kind, "stale");
    assertEquals(await git(served.dir, "rev-parse", "refs/heads/main"), baseSha);
  } finally {
    await remote.shutdown();
    await rm(root, { recursive: true });
  }
});

// The gateway transport: clone records the base, push emits a real bundle to the intake —
// authenticated, correctly named, prerequisites anchored at the recorded base — and the
// credential never touches the checkout's .git/config. A change request is warmed at the
// gateway before it is fetched, and only a fetch that landed on the answered head is an answer.

import { test } from "bun:test";
import { serve } from "@ryph/service";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { gatewayGitTransport } from "../src/adapters/git/gateway.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";
import { recordingDiagnostics } from "./doubles/diagnostics.ts";
import { git, redact } from "../src/helpers/git_exec.ts";
import { makeThrowawayOrigin } from "./fixtures/origin.ts";
import { plantRemoteConfig } from "./fixtures/remote_config.ts";
import { smartHttpOrigin } from "./fixtures/smart_http.ts";
import { repoEntry } from "./util.ts";

const TOKEN = "ryph-git-virtual-key";
const CONNECTED_REPO = "cr-api";
const RUN_ID = "r-1";
const STALE_SINCE = "2026-09-29T10:00:00.000Z";
const FRESH = { kind: "fresh" } as const;

/** The entry the run holds for the one repo: a connected repo, on the run's branch. */
const entry = (url: string, ref: string) =>
  repoEntry({ connectedRepoId: CONNECTED_REPO, url, ref, branchNamespace: "ryph/ada/r-1" });

/** A stand-in intake: records the one POST /v1/patches/:connectedRepoId and answers what it's
 * told to. The member is in the path — that is what the transport is expected to say. */
async function fakeIntake(status = 201) {
  const received: Array<{ auth: string | null; repo: string; body: Uint8Array }> = [];
  const server = await serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    async (req) => {
      const url = new URL(req.url);
      const match = url.pathname.match(/^\/v1\/patches\/([^/]+)$/);
      if (req.method === "POST" && match !== null) {
        received.push({
          auth: req.headers.get("authorization"),
          repo: decodeURIComponent(match[1]),
          body: new Uint8Array(await req.arrayBuffer()),
        });
        return new Response(
          JSON.stringify({ runId: "r-1", headSha: "…", bundleKey: "r-1/x.bundle" }),
          { status },
        );
      }
      return new Response("not found", { status: 404 });
    },
  );
  return {
    origin: `http://127.0.0.1:${server.addr.port}`,
    received,
    shutdown: () => server.shutdown(),
  };
}

test("push bundles exactly the run's commits onto the named branch and POSTs them", async () => {
  const origin = await makeThrowawayOrigin();
  const intake = await fakeIntake();
  const ws = await mkdtemp(join(tmpdir(), "runner-ws-"));
  try {
    const transport = gatewayGitTransport(noopDiagnostics(), {
      origin: intake.origin,
      token: TOKEN,
      runId: RUN_ID,
    });
    // The clone target is ordinarily the gateway itself; a local origin stands in — the
    // transport doesn't care, and the extraheader config it injects is scoped to the
    // gateway origin so it is inert here.
    await transport.clone(entry(origin.url, origin.ref), ws);
    const baseSha = await git(ws, "rev-parse", "HEAD");

    // No credential anywhere in the checkout's config — the invariant the extraheader
    // mechanism exists for.
    const config = await readFile(`${ws}/.git/config`, "utf8");
    assert(!config.includes(TOKEN));
    assert(!config.toLowerCase().includes("authorization"));

    // The run's work: one commit on the run-namespaced branch.
    await git(ws, "checkout", "-b", "ryph/ada/r-1");
    await writeFile(`${ws}/work.txt`, "work\n");
    await git(ws, "add", ".");
    await git(
      ws,
      "-c",
      "user.name=Ada",
      "-c",
      "user.email=ada@test.local",
      "commit",
      "--quiet",
      "-m",
      "do the work",
    );
    const headSha = await git(ws, "rev-parse", "HEAD");
    assert(headSha !== baseSha);

    const { remoteRef } = await transport.push(
      { dir: ws, freshness: FRESH },
      entry(origin.url, origin.ref),
      {
        name: "ryph/ada/r-1",
        baseSha,
      },
    );
    assertEquals(remoteRef, "refs/heads/ryph/ada/r-1");

    assertEquals(intake.received.length, 1);
    assertEquals(intake.received[0].auth, `Bearer ${TOKEN}`);
    // The intake for THIS repo: the key names the run's set, the path names the member.
    assertEquals(intake.received[0].repo, CONNECTED_REPO);

    // The uploaded bytes are a real bundle: it declares the named branch at the run's head,
    // and applies cleanly against the base (list-heads + verify against the origin repo).
    const uploaded = `${ws}/uploaded.bundle`;
    await writeFile(uploaded, intake.received[0].body);
    const heads = await git(ws, "bundle", "list-heads", uploaded);
    assertEquals(heads, `${headSha} refs/heads/ryph/ada/r-1`);
    // …and its prerequisites are satisfied by the origin (i.e. anchored at the recorded
    // base), which is exactly what the gateway's intake will verify.
    const originCheckout = origin.url.replace(/\/origin\.git$/, "/seed");
    await git(originCheckout, "bundle", "verify", "--quiet", uploaded);
    assertStringIncludes(config, `url = ${origin.url}`); // origin untouched by the bundle move
  } finally {
    await intake.shutdown();
    await rm(ws, { recursive: true });
    await origin.cleanup();
  }
});

test("a refused bundle fails the push with the gateway's reason, redacted", async () => {
  const origin = await makeThrowawayOrigin();
  const intake = await fakeIntake(400);
  const ws = await mkdtemp(join(tmpdir(), "runner-ws-"));
  try {
    const transport = gatewayGitTransport(noopDiagnostics(), {
      origin: intake.origin,
      token: TOKEN,
      runId: RUN_ID,
    });
    await transport.clone(entry(origin.url, origin.ref), ws);
    await git(ws, "checkout", "-b", "ryph/ada/r-1");
    await writeFile(`${ws}/f`, "x\n");
    await git(ws, "add", ".");
    await git(
      ws,
      "-c",
      "user.name=Ada",
      "-c",
      "user.email=ada@test.local",
      "commit",
      "--quiet",
      "-m",
      "c",
    );
    const baseSha = await git(ws, "rev-parse", "HEAD~1");
    await assertRejects(
      () =>
        transport.push({ dir: ws, freshness: FRESH }, entry(origin.url, origin.ref), {
          name: "ryph/ada/r-1",
          baseSha,
        }),
      Error,
      "refused the bundle (400)",
    );
  } finally {
    await intake.shutdown();
    await rm(ws, { recursive: true });
    await origin.cleanup();
  }
});

/** A stand-in for one of the gateway's JSON routes (the change-request warm call, the base's
 * freshness): records every request and answers what it is told to. What the transport is
 * expected to say is entirely in the method, the path and the query. */
async function fakeRoute(respond: () => Response | Promise<Response>) {
  const received: Array<{ auth: string | null; path: string; query: string; method: string }> = [];
  const server = await serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    (req) => {
      const url = new URL(req.url);
      received.push({
        auth: req.headers.get("authorization"),
        path: url.pathname,
        query: url.search.replace(/^\?/, ""),
        method: req.method,
      });
      return respond();
    },
  );
  return {
    origin: `http://127.0.0.1:${server.addr.port}`,
    received,
    shutdown: () => server.shutdown(),
  };
}

/** One more commit on the origin's base branch — what a landed pull request leaves behind.
 * Answers the new tip. */
async function seedOntoBase(originUrl: string): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "runner-base-"));
  try {
    await git(work, "clone", "--quiet", "--", originUrl, ".");
    await writeFile(`${work}/landed.txt`, "landed\n");
    await git(work, "add", "-A");
    await git(
      work,
      "-c",
      "user.name=Mer",
      "-c",
      "user.email=mer@test.local",
      "commit",
      "--quiet",
      "-m",
      "a pull request landed",
    );
    await git(work, "push", "--quiet", "origin", "main");
    return await git(work, "rev-parse", "HEAD");
  } finally {
    await rm(work, { recursive: true });
  }
}

/** A change request on the origin: a branch with one commit on it, as the gateway's cache would
 * be serving after it warmed. */
async function seedChangeRequest(originUrl: string, ref: string): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "runner-cr-"));
  try {
    await git(work, "clone", "--quiet", "--", originUrl, ".");
    await git(work, "checkout", "--quiet", "-b", ref);
    await writeFile(`${work}/cr.txt`, "from the change request\n");
    await git(work, "add", "-A");
    await git(
      work,
      "-c",
      "user.name=Con",
      "-c",
      "user.email=con@test.local",
      "commit",
      "--quiet",
      "-m",
      "the change request's commit",
    );
    await git(work, "push", "--quiet", "origin", ref);
    return await git(work, "rev-parse", "HEAD");
  } finally {
    await rm(work, { recursive: true });
  }
}

test("fetchBase reads the base ref as it stands at the origin now", async () => {
  const origin = await makeThrowawayOrigin();
  const intake = await fakeIntake();
  const ws = await mkdtemp(join(tmpdir(), "runner-ws-"));
  try {
    const transport = gatewayGitTransport(noopDiagnostics(), {
      origin: intake.origin,
      token: TOKEN,
      runId: RUN_ID,
    });
    const repo = entry(origin.url, origin.ref);
    const checkout = await transport.clone(repo, ws);
    const cloned = await git(ws, "rev-parse", "HEAD");
    assertEquals(await transport.fetchBase(checkout, repo), { sha: cloned });

    // The base moves at the origin — a landed pull request — and the next read says so.
    const merged = await seedOntoBase(origin.url);
    assertEquals(await transport.fetchBase(checkout, repo), { sha: merged });
  } finally {
    await intake.shutdown();
    await rm(ws, { recursive: true });
    await origin.cleanup();
  }
});

test("clone and adopt learn from the gateway whether the base was served stale", async () => {
  const origin = await makeThrowawayOrigin();
  const ws = await mkdtemp(join(tmpdir(), "runner-ws-"));
  const commit = await git(origin.url, "rev-parse", "main");
  let staleSince: string | null = STALE_SINCE;
  const gateway = await fakeRoute(() => Response.json({ ref: "main", commit, staleSince }));
  try {
    const transport = gatewayGitTransport(noopDiagnostics(), {
      origin: gateway.origin,
      token: TOKEN,
      runId: RUN_ID,
    });
    const repo = entry(origin.url, origin.ref);
    const cloned = await transport.clone(repo, ws);
    assertEquals(cloned.freshness, { kind: "stale", since: STALE_SINCE });
    // Asked after the clone, with the run key: the member and its ref are in the request, since
    // one key covers the run's whole set of repos.
    assertEquals(gateway.received, [{
      auth: `Bearer ${TOKEN}`,
      path: `/v1/git/${RUN_ID}/${CONNECTED_REPO}/base`,
      query: "ref=main",
      method: "GET",
    }]);

    // The upstream is back: the next refresh through the gateway clears the mark.
    staleSince = null;
    const adopted = await transport.adopt(repo, ws);
    assertEquals(adopted.freshness, FRESH);
  } finally {
    await gateway.shutdown();
    await rm(ws, { recursive: true });
    await origin.cleanup();
  }
});

test("fetchBase refuses a base the gateway could only serve from a copy it could not refresh", async () => {
  const origin = await makeThrowawayOrigin();
  const ws = await mkdtemp(join(tmpdir(), "runner-ws-"));
  const commit = await git(origin.url, "rev-parse", "main");
  const gateway = await fakeRoute(() =>
    Response.json({ ref: "main", commit, staleSince: STALE_SINCE })
  );
  try {
    const transport = gatewayGitTransport(noopDiagnostics(), {
      origin: gateway.origin,
      token: TOKEN,
      runId: RUN_ID,
    });
    const repo = entry(origin.url, origin.ref);
    const checkout = await transport.clone(repo, ws);
    await assertRejects(
      () => transport.fetchBase(checkout, repo),
      Error,
      `\`main\` could not be refreshed from upstream: every attempt since ${STALE_SINCE} has ` +
        "failed, and ryph only holds an older copy",
    );
    assertEquals(gateway.received.map((r) => r.query), ["ref=main", "ref=main"]);
  } finally {
    await gateway.shutdown();
    await rm(ws, { recursive: true });
    await origin.cleanup();
  }
});

test("fetchBase reads again when the entry moved under its fetch, and answers the tip it then lands on", async () => {
  // Between the fetch and the question, another run's refresh moved the entry (the upstream
  // came back): the gateway says fresh and names a commit this fetch did not land on. Trusted,
  // a fetch that landed on the stale tip would read as fresh. One more fetch lands on it.
  const origin = await makeThrowawayOrigin();
  const ws = await mkdtemp(join(tmpdir(), "runner-ws-"));
  let held = await git(origin.url, "rev-parse", "main");
  let asks = 0;
  const gateway = await fakeRoute(async () => {
    asks += 1;
    // The clone asks once; the first question fetchBase asks finds the origin moved on.
    if (asks === 2) held = await seedOntoBase(origin.url);
    return Response.json({ ref: "main", commit: held, staleSince: null });
  });
  try {
    const transport = gatewayGitTransport(noopDiagnostics(), {
      origin: gateway.origin,
      token: TOKEN,
      runId: RUN_ID,
    });
    const repo = entry(origin.url, origin.ref);
    const checkout = await transport.clone(repo, ws);
    const cloned = await git(ws, "rev-parse", "HEAD");
    const { sha } = await transport.fetchBase(checkout, repo);
    assertEquals(sha, held);
    assert(sha !== cloned, "the second fetch landed on the moved tip");
    assertEquals(gateway.received.map((r) => r.query), ["ref=main", "ref=main", "ref=main"]);
  } finally {
    await gateway.shutdown();
    await rm(ws, { recursive: true });
    await origin.cleanup();
  }
});

test("fetchBase reads again when the moved tip is first answered stale, and lands fresh on it", async () => {
  // The gateway's reads straddled another run's refresh the other way round: the mark still
  // set, the branch already moved. The tip it names is not the one this fetch landed on, so
  // the fetch runs once more and the next answer is the refreshed one.
  const origin = await makeThrowawayOrigin();
  const ws = await mkdtemp(join(tmpdir(), "runner-ws-"));
  let held = await git(origin.url, "rev-parse", "main");
  let asks = 0;
  const gateway = await fakeRoute(async () => {
    asks += 1;
    if (asks === 2) {
      held = await seedOntoBase(origin.url);
      return Response.json({ ref: "main", commit: held, staleSince: "2026-09-30T15:46:45Z" });
    }
    return Response.json({ ref: "main", commit: held, staleSince: null });
  });
  try {
    const transport = gatewayGitTransport(noopDiagnostics(), {
      origin: gateway.origin,
      token: TOKEN,
      runId: RUN_ID,
    });
    const repo = entry(origin.url, origin.ref);
    const checkout = await transport.clone(repo, ws);
    const { sha } = await transport.fetchBase(checkout, repo);
    assertEquals(sha, held);
    assertEquals(gateway.received.map((r) => r.query), ["ref=main", "ref=main", "ref=main"]);
  } finally {
    await gateway.shutdown();
    await rm(ws, { recursive: true });
    await origin.cleanup();
  }
});

test("fetchBase refuses a base whose entry never agrees with what it fetched", async () => {
  const origin = await makeThrowawayOrigin();
  const ws = await mkdtemp(join(tmpdir(), "runner-ws-"));
  const gateway = await fakeRoute(() =>
    Response.json({ ref: "main", commit: "0".repeat(40), staleSince: null })
  );
  try {
    const transport = gatewayGitTransport(noopDiagnostics(), {
      origin: gateway.origin,
      token: TOKEN,
      runId: RUN_ID,
    });
    const repo = entry(origin.url, origin.ref);
    const checkout = await transport.clone(repo, ws);
    await assertRejects(
      () => transport.fetchBase(checkout, repo),
      Error,
      "`main` moved at the origin while it was being read; try again",
    );
    assertEquals(gateway.received.map((r) => r.query), ["ref=main", "ref=main", "ref=main"]);
  } finally {
    await gateway.shutdown();
    await rm(ws, { recursive: true });
    await origin.cleanup();
  }
});

test("a gateway that cannot say reads as fresh, said in a warn", async () => {
  const origin = await makeThrowawayOrigin();
  const ws = await mkdtemp(join(tmpdir(), "runner-ws-"));
  // A forge that predates the route: such a forge never serves stale.
  const gateway = await fakeRoute(() => new Response("not found", { status: 404 }));
  const { diag, warns } = recordingDiagnostics();
  try {
    const transport = gatewayGitTransport(diag, {
      origin: gateway.origin,
      token: TOKEN,
      runId: RUN_ID,
    });
    const cloned = await transport.clone(entry(origin.url, origin.ref), ws);
    assertEquals(cloned.freshness, FRESH);
    assertEquals(warns.map((w) => w.event), ["git.freshness_unknown"]);
    assertEquals(warns[0].fields?.repo, "repo");
  } finally {
    await gateway.shutdown();
    await rm(ws, { recursive: true });
    await origin.cleanup();
  }
});

test("a change request is warmed at the gateway, then fetched, and its head lands in the clone", async () => {
  const origin = await makeThrowawayOrigin();
  const ws = await mkdtemp(join(tmpdir(), "runner-ws-"));
  const headSha = await seedChangeRequest(origin.url, "feature/x");
  const warm = await fakeRoute(() =>
    Response.json({ ref: "feature/x", headSha, url: "https://forge/x/pull/42" })
  );
  try {
    const transport = gatewayGitTransport(noopDiagnostics(), {
      origin: warm.origin,
      token: TOKEN,
      runId: RUN_ID,
    });
    const repo = entry(origin.url, origin.ref);
    const checkout = await transport.clone(repo, ws);
    assertEquals(await transport.fetchChangeRequest(checkout, repo, "42"), {
      ref: "feature/x",
      headSha,
      url: "https://forge/x/pull/42",
    });
    // The run key, and the member and the thread in the path — one key covers the run's whole
    // set of repos, so only the URL says which repo and which change request this is about.
    // (The clone's own freshness question rides the same fake; the warm call is the POST.)
    const warmed = warm.received.filter((r) => r.method === "POST");
    assertEquals(warmed.length, 1);
    assertEquals(warmed[0].auth, `Bearer ${TOKEN}`);
    assertEquals(warmed[0].path, `/v1/git/${RUN_ID}/${CONNECTED_REPO}/change-requests/42/base`);
    // The objects really came in: the caller can move the run's branch onto that head.
    await git(ws, "cat-file", "-e", `${headSha}^{commit}`);
  } finally {
    await warm.shutdown();
    await rm(ws, { recursive: true });
    await origin.cleanup();
  }
});

test("a change request that moved between the warm call and the fetch is refused, not answered", async () => {
  const origin = await makeThrowawayOrigin();
  const ws = await mkdtemp(join(tmpdir(), "runner-ws-"));
  await seedChangeRequest(origin.url, "feature/x");
  // The gateway names a head this fetch cannot land on — what a push to the change request in
  // between looks like from here.
  const warm = await fakeRoute(() =>
    Response.json({
      ref: "feature/x",
      headSha: "0".repeat(40),
      url: "https://forge/x/pull/42",
    })
  );
  try {
    const transport = gatewayGitTransport(noopDiagnostics(), {
      origin: warm.origin,
      token: TOKEN,
      runId: RUN_ID,
    });
    const repo = entry(origin.url, origin.ref);
    const checkout = await transport.clone(repo, ws);
    await assertRejects(
      () => transport.fetchChangeRequest(checkout, repo, "42"),
      Error,
      "moved while it was being checked out",
    );
  } finally {
    await warm.shutdown();
    await rm(ws, { recursive: true });
    await origin.cleanup();
  }
});

test("the gateway's refusal of a change request is passed on as the reason", async () => {
  const origin = await makeThrowawayOrigin();
  const ws = await mkdtemp(join(tmpdir(), "runner-ws-"));
  const warm = await fakeRoute(() =>
    Response.json({ error: "#42 is closed; only an open change request can be worked on" }, {
      status: 400,
    })
  );
  try {
    const transport = gatewayGitTransport(noopDiagnostics(), {
      origin: warm.origin,
      token: TOKEN,
      runId: RUN_ID,
    });
    const repo = entry(origin.url, origin.ref);
    const checkout = await transport.clone(repo, ws);
    await assertRejects(
      () => transport.fetchChangeRequest(checkout, repo, "42"),
      Error,
      "only an open change request can be worked on",
    );
    assertEquals(warm.received.filter((r) => r.method === "POST").length, 1);
  } finally {
    await warm.shutdown();
    await rm(ws, { recursive: true });
    await origin.cleanup();
  }
});

test("the remote config the agent writes steers neither fetchBase nor a change request's fetch", async () => {
  const origin = await makeThrowawayOrigin();
  const ws = await mkdtemp(join(tmpdir(), "runner-ws-"));
  // The gateway over http, as in production: the wire routes, the base's commit as its entry
  // holds it, and the change request's warm call.
  const gateway = await smartHttpOrigin(origin.url, async (req, url) => {
    if (url.pathname.endsWith("/base") && req.method === "GET") {
      const ref = url.searchParams.get("ref")!;
      const commit = await git(origin.url, "rev-parse", `refs/heads/${ref}`);
      return Response.json({ commit, staleSince: null });
    }
    if (url.pathname.endsWith("/change-requests/42/base") && req.method === "POST") {
      const headSha = await git(origin.url, "rev-parse", "refs/heads/feature/x");
      return Response.json({ ref: "feature/x", headSha, url: "https://forge/x/pull/42" });
    }
    return null;
  });
  try {
    const transport = gatewayGitTransport(noopDiagnostics(), {
      origin: gateway.origin,
      token: TOKEN,
      runId: RUN_ID,
    });
    const repo = entry(gateway.url, origin.ref);
    const checkout = await transport.clone(repo, ws);
    const planted = await plantRemoteConfig(ws, gateway.url);
    try {
      const merged = await seedOntoBase(origin.url);
      assertEquals(await transport.fetchBase(checkout, repo), { sha: merged });
      assertEquals(await git(ws, "rev-parse", "refs/remotes/origin/main"), merged);

      const headSha = await seedChangeRequest(origin.url, "feature/x");
      assertEquals(await transport.fetchChangeRequest(checkout, repo, "42"), {
        ref: "feature/x",
        headSha,
        url: "https://forge/x/pull/42",
      });
      assertEquals(await git(ws, "rev-parse", "refs/remotes/origin/feature/x"), headSha);

      assertEquals(await planted.uploadPackRan(), false, "the planted upload-pack ran");
      assertEquals(planted.proxied, [], "a fetch went through the planted proxy");
      assertEquals(await planted.decoyRefs(), "", "the planted fetch refspec was used");
    } finally {
      await planted.cleanup();
    }
  } finally {
    await gateway.shutdown();
    await rm(ws, { recursive: true });
    await origin.cleanup();
  }
});

test("push refuses a checkout this transport did not clone", async () => {
  const intake = await fakeIntake();
  try {
    const transport = gatewayGitTransport(noopDiagnostics(), {
      origin: intake.origin,
      token: TOKEN,
      runId: RUN_ID,
    });
    await assertRejects(
      () =>
        transport.push({ dir: "/nowhere", freshness: FRESH }, entry("x", "main"), {
          name: "b",
          baseSha: "x",
        }),
      Error,
      "no base to bundle from",
    );
  } finally {
    await intake.shutdown();
  }
});

test("redact scrubs Authorization header values alongside credentialed URLs", () => {
  assertEquals(
    redact("fatal: Authorization: Basic c2VjcmV0 rejected"),
    "fatal: Authorization: ***",
  );
  assertEquals(
    redact("https://user:pass@example.com/x.git failed"),
    "https://***@example.com/x.git failed",
  );
});

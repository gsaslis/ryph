// Door ①'s change-request warm: a run that was started on a repo's default branch is asked to
// work on an existing pull request instead. The gateway reads that change request's head off
// the forge, holds it to the rules a run's branch must satisfy, and fetches it into the run's
// own cache entry — after which the SAME clone can fetch it and ship a patch built on it.
//
// Real git and a real cache throughout, with the forge itself faked: what the forge says is
// exactly the input these rules exist to police.

import { test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { serve } from "@ryph/service";
import { type AppDeps, makeHandler } from "../src/http/app.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "../src/adapters/patch_store/local_fs.ts";
import { changeRequestRefusal } from "../src/http/git.ts";
import type { ChangeRequestHead, ForgeApi } from "../src/ports/forge_api.ts";
import { ForgeApiError, providerRegistry } from "../src/ports/forge_api.ts";
import type { KeyStore } from "../src/ports/key_store.ts";
import type { RunGrant, RunGrantRepo } from "../src/core/types.ts";
import { git, makeGit } from "../src/helpers/git_exec.ts";
import { commit, makeUpstream, recordingDiagnostics } from "./util.ts";

const TOKEN = "virtual-key-run-a";
const OTHER_TOKEN = "virtual-key-run-b";
/** A run whose grant already names a target — as after an earlier checkout. */
const TARGETED_TOKEN = "virtual-key-run-c";
const REPO = "cr-1";
const REPO_REF = "acme/app";
/** The change request under test: its thread ref, and the branch its head lives on. */
const THREAD = "42";
const HEAD_REF = "feat/scheduler";
/** A second open change request of the same repo, and the branch ITS head lives on. */
const OTHER_THREAD = "43";
const OTHER_REF = "fix/clock";

function grants(upstreamUrl: string): Record<string, RunGrant> {
  const member = {
    connectedRepoId: REPO,
    provider: "github" as const,
    repoRef: REPO_REF,
    url: upstreamUrl,
    ref: "main",
    branchNamespace: "ryph/ada/r-a",
    // A path upstream: nothing to authenticate to, so these runs fetch as nobody.
    tenantId: null,
  };
  return {
    [TOKEN]: { runId: "r-a", repos: [member] },
    [OTHER_TOKEN]: { runId: "r-b", repos: [{ ...member, branchNamespace: "ryph/bob/r-b" }] },
    [TARGETED_TOKEN]: {
      runId: "r-a",
      repos: [{ ...member, targetRef: "release/2.x", branchNamespace: "ryph/cy/r-c" }],
    },
  };
}

/** An upstream with a base branch and two contributors' branches on top of it — the shape two
 * open change requests describe. */
async function makeUpstreamWithChanges(dir: string) {
  const baseSha = await makeUpstream(dir);
  const branch = async (name: string, file: string) => {
    await git(dir, "checkout", "--quiet", "-B", name, "main");
    await writeFile(`${dir}/${file}`, `the work on ${name}\n`);
    await git(dir, "add", ".");
    await commit(dir, `the change request on ${name}`);
    return await git(dir, "rev-parse", "HEAD");
  };
  const headSha = await branch(HEAD_REF, "change.txt");
  const otherSha = await branch(OTHER_REF, "other.txt");
  await git(dir, "checkout", "--quiet", "--end-of-options", "main");
  return { baseSha, headSha, otherSha };
}

/** The forge's answers, canned: which change requests exist, and what each one's head looks
 * like right now. An issue's ref is simply one this table does not hold — the door reads change
 * requests and nothing else. `asked` is how a test shows the forge was never reached, which is
 * the point of refusing before anything is read. */
function fakeForge(threads: Map<string, ChangeRequestHead>, opts: { down?: boolean } = {}) {
  const asked: string[] = [];
  const api = {
    upstreamUrl: (_repo: unknown, url: string) => url,
    fetchAuth: () => Promise.resolve(null),
    describeChangeRequest: (_repo: unknown, ref: string) => {
      asked.push(ref);
      if (opts.down) return Promise.reject(new ForgeApiError("the forge did not answer", false));
      const held = threads.get(ref);
      return held === undefined
        ? Promise.reject(new ForgeApiError(`${REPO_REF} has no change request ${ref}`, true))
        : Promise.resolve(structuredClone(held));
    },
  } as unknown as ForgeApi;
  return { api, asked };
}

/** A change request whose head is the fixture's branch, open and in this very repo. */
function openHead(headSha: string, over: Partial<ChangeRequestHead> = {}): ChangeRequestHead {
  const ref = over.ref ?? THREAD;
  return {
    ref,
    // The forge's own address for the thread, which the answer hands straight back.
    url: `https://gh.test/${REPO_REF}/pull/${ref}`,
    state: "open",
    merged: false,
    headRef: HEAD_REF,
    headSha,
    authorHeadSha: headSha,
    headRepoRef: REPO_REF,
    commitCount: 1,
    baseRef: "main",
    defaultBranch: "main",
    ...over,
  };
}

async function buildGateway(
  root: string,
  threads: Map<string, ChangeRequestHead>,
  opts: { down?: boolean; forges?: boolean } = {},
) {
  const upstream = `${root}/upstream`;
  const { baseSha, headSha, otherSha } = await makeUpstreamWithChanges(upstream);
  const { diag, events } = recordingDiagnostics();
  const stagingDir = `${root}/staging`;
  await mkdir(stagingDir, { recursive: true });
  const table = grants(upstream);
  const keys: KeyStore = {
    resolve: (token) => Promise.resolve(structuredClone(table[token] ?? null)),
  };
  const { api, asked } = fakeForge(threads, { down: opts.down });
  const deps: AppDeps = {
    keys,
    cache: localFsRepoCache({ root: `${root}/cache`, diag }),
    patches: localFsPatchStore(`${root}/patches`, diag),
    diag,
    forges: opts.forges === false ? null : providerRegistry({ github: api }, "forge API"),
    config: {
      maxUploadPackBytes: 10 * 1024 * 1024,
      maxBundleBytes: 100 * 1024 * 1024,
      stagingDir,
    },
  };
  return { handler: makeHandler(deps), upstream, baseSha, headSha, otherSha, asked, events };
}

/** The warm itself, as the runner's gateway transport sends it: the run key as a bearer. */
function warm(
  handler: (req: Request) => Promise<Response>,
  opts: { token?: string; runId?: string; repo?: string; thread?: string } = {},
) {
  const { token = TOKEN, runId = "r-a", repo = REPO, thread = THREAD } = opts;
  return handler(
    new Request(`http://gw.test/v1/git/${runId}/${repo}/change-requests/${thread}/base`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

function advertise(handler: (req: Request) => Promise<Response>) {
  return handler(
    new Request(`http://gw.test/v1/git/r-a/${REPO}/repo.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
}

/** A git executor authenticated like the runner's gateway transport: origin-scoped extraheader. */
function clientGit(origin: string, token: string) {
  return makeGit({ debug() {} }, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x-access-token:${token}`)}`,
  });
}

test("a warmed change request is fetchable through the run's own clone, and ships", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const threads = new Map<string, ChangeRequestHead>();
  const { handler, headSha, baseSha } = await buildGateway(root, threads);
  threads.set(THREAD, openHead(headSha));
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handler);
  const origin = `http://127.0.0.1:${server.addr.port}`;
  try {
    // The run clones the way every run does: at the base it was granted, knowing nothing of
    // the change request.
    const gitA = clientGit(origin, TOKEN);
    const ws = `${root}/workspace`;
    await mkdir(ws);
    await gitA(ws, "clone", "--quiet", "--", `${origin}/v1/git/r-a/${REPO}/repo.git`, ".");
    assertEquals(await git(ws, "rev-parse", "HEAD"), baseSha);

    // The swap: the gateway reads the head and warms it.
    const res = await fetch(`${origin}/v1/git/r-a/${REPO}/change-requests/${THREAD}/base`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      ref: HEAD_REF,
      headSha,
      url: `https://gh.test/${REPO_REF}/pull/${THREAD}`,
    });

    // …and the very next fetch on the existing clone finds it, at the sha the answer named.
    await gitA(ws, "fetch", "--quiet", "origin", HEAD_REF);
    assertEquals(await git(ws, "rev-parse", "FETCH_HEAD"), headSha);

    // The run's work now sits on the change request's head, and the bundle whose ONE
    // prerequisite is that head verifies at intake — the head is in the cache to check against.
    await git(ws, "checkout", "--quiet", "-B", "ryph/ada/r-a/work", headSha);
    await writeFile(`${ws}/more.txt`, "the agent's work\n");
    await git(ws, "add", ".");
    await commit(ws, "continue the change request");
    const bundle = `${root}/out.bundle`;
    await git(ws, "bundle", "create", bundle, `${headSha}..refs/heads/ryph/ada/r-a/work`);
    const intake = await fetch(`${origin}/v1/patches/${REPO}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: await readFile(bundle),
    });
    assertEquals(intake.status, 201);
    assertEquals((await intake.json()).headSha, await git(ws, "rev-parse", "HEAD"));
  } finally {
    await server.shutdown();
    await rm(root, { recursive: true });
  }
});

test("the advertisement serves the warmed head beside the base, and says so once", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const threads = new Map<string, ChangeRequestHead>();
  const { handler, headSha, events } = await buildGateway(root, threads);
  threads.set(THREAD, openHead(headSha));
  try {
    const before = await advertise(handler);
    assertEquals(before.status, 200);
    const without = await before.text();
    assert(!without.includes(`refs/heads/${HEAD_REF}`), "the base clone must not carry the head");

    const res = await warm(handler);
    assertEquals(res.status, 200);
    await res.body?.cancel();

    const after = await advertise(handler);
    assertEquals(after.status, 200);
    const listing = await after.text();
    assertStringIncludes(listing, `refs/heads/${HEAD_REF}`);
    // The base the run cloned is still there: a warm ADDS a branch to the entry, it does not
    // replace what the run is already working from.
    assertStringIncludes(listing, "refs/heads/main");
    assertEquals(events.filter((e) => e.event === "git.change_request_warmed").length, 1);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a warm also brings in what the change request merges into, and a base it cannot fetch costs nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const threads = new Map<string, ChangeRequestHead>();
  const { handler, upstream, headSha, events } = await buildGateway(root, threads);
  // A change request against a release branch, not the run's own base: the grant cannot name
  // it until the claim lands, so the warm is what makes it fetchable right after a checkout.
  await git(upstream, "branch", "release/2.x", "main");
  threads.set(THREAD, openHead(headSha, { baseRef: "release/2.x" }));
  try {
    const res = await warm(handler);
    assertEquals(res.status, 200);
    await res.body?.cancel();
    assertStringIncludes(await (await advertise(handler)).text(), "refs/heads/release/2.x");

    // A base the upstream does not have is logged, and the head is warmed all the same.
    threads.set(THREAD, openHead(headSha, { baseRef: "gone" }));
    const again = await warm(handler);
    assertEquals(again.status, 200);
    await again.body?.cancel();
    assert(events.some((e) => e.event === "git.target_unavailable"));
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a warm fetches the base only when no fetch of the run refreshes it already", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const threads = new Map<string, ChangeRequestHead>();
  const { handler, upstream, headSha, events } = await buildGateway(root, threads);
  await git(upstream, "branch", "release/2.x", "main");
  const fetches = () => events.filter((e) => e.event === "cache.base_ready").length;
  try {
    // The run's own base: every advertisement refreshes it, so only the head is fetched.
    threads.set(THREAD, openHead(headSha, { baseRef: "main" }));
    let before = fetches();
    await (await warm(handler)).body?.cancel();
    assertEquals(fetches() - before, 1);
    // The run's current target, likewise.
    threads.set(THREAD, openHead(headSha, { baseRef: "release/2.x" }));
    before = fetches();
    await (await warm(handler, { token: TARGETED_TOKEN })).body?.cancel();
    assertEquals(fetches() - before, 1);
    // Anything else is warmed beside the head.
    before = fetches();
    await (await warm(handler)).body?.cancel();
    assertEquals(fetches() - before, 2);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("warming a second change request accretes: the entry serves both, and the base", async () => {
  // The re-swap the runner allows before a repo has shipped anything. Each warm adds a branch
  // to the shared entry; none of them takes one away, so a run that changes its mind can still
  // fetch what it was working from.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const threads = new Map<string, ChangeRequestHead>();
  const { handler, headSha, otherSha } = await buildGateway(root, threads);
  threads.set(THREAD, openHead(headSha));
  threads.set(OTHER_THREAD, openHead(otherSha, { ref: OTHER_THREAD, headRef: OTHER_REF }));
  try {
    const first = await warm(handler);
    assertEquals(first.status, 200);
    assertEquals((await first.json()).ref, HEAD_REF);

    const second = await warm(handler, { thread: OTHER_THREAD });
    assertEquals(second.status, 200);
    assertEquals(await second.json(), {
      ref: OTHER_REF,
      headSha: otherSha,
      url: `https://gh.test/${REPO_REF}/pull/${OTHER_THREAD}`,
    });

    const listing = await (await advertise(handler)).text();
    for (const ref of [`refs/heads/${HEAD_REF}`, `refs/heads/${OTHER_REF}`, "refs/heads/main"]) {
      assertStringIncludes(listing, ref);
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a thread reference reaches the forge as it was spelled, not as it was encoded", async () => {
  // Radicle spells a patch id with a ':' in the refs the tool surface hands the agent, and the
  // runner percent-encodes the segment. The router does not decode, so the route must.
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const threads = new Map<string, ChangeRequestHead>();
  const { handler, headSha, asked } = await buildGateway(root, threads);
  const spelled = "patch:0a1b2c3d";
  threads.set(spelled, openHead(headSha, { ref: spelled }));
  try {
    const res = await warm(handler, { thread: encodeURIComponent(spelled) });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).ref, HEAD_REF);
    assertEquals(asked, [spelled]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("heads a run may not be moved onto are refused, and nothing is warmed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const threads = new Map<string, ChangeRequestHead>();
  const { handler, headSha, events } = await buildGateway(root, threads);
  const cases: Array<[string, ChangeRequestHead, string]> = [
    ["closed", openHead(headSha, { state: "closed" }), "is closed"],
    ["merged", openHead(headSha, { state: "closed", merged: true }), "is merged"],
    ["fork", openHead(headSha, { headRepoRef: "someone/app" }), "the fork someone/app"],
    ["deleted-fork", openHead(headSha, { headRepoRef: null }), "a fork that no longer exists"],
    ["default", openHead(headSha, { headRef: "main" }), "default branch"],
    ["unnamed", openHead(headSha, { headRef: "-oops" }), "not a branch name"],
    ["tag", openHead(headSha, { headRef: "refs/tags/v1" }), "cannot be served as a base"],
  ];
  try {
    for (const [name, held, why] of cases) {
      threads.set(name, { ...held, ref: name });
      const res = await warm(handler, { thread: name });
      assertEquals(res.status, 400, name);
      assertStringIncludes((await res.json()).error, why);
    }
    // An issue's ref and a ref that names nothing are the same terminal answer — a 404 no
    // retry finds again, saying both, because there is no branch either way. (A forge that did
    // not answer is a 502 instead, because it may answer next time.)
    const missing = await warm(handler, { thread: "999" });
    assertEquals(missing.status, 404);
    const said = (await missing.json()).error;
    assertStringIncludes(said, "#999 is not an open change request");
    assertStringIncludes(said, "it may be an issue");

    // Not one of them warmed anything: the advertisement is still just the base.
    const listing = await (await advertise(handler)).text();
    assert(!listing.includes(`refs/heads/${HEAD_REF}`), listing);
    assertEquals(events.filter((e) => e.event === "git.change_request_warmed").length, 0);
    assertEquals(
      events.filter((e) => e.event === "git.change_request_refused").length,
      cases.length + 1,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a forge that did not answer is a 502, not a refusal the agent should believe", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const threads = new Map<string, ChangeRequestHead>();
  const { handler, headSha } = await buildGateway(root, threads, { down: true });
  threads.set(THREAD, openHead(headSha));
  try {
    const res = await warm(handler);
    assertEquals(res.status, 502);
    // Said as transient: an agent that reads this as a verdict gives up on work it could have.
    assertStringIncludes((await res.json()).error, "did not answer — try again");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the warm is gated exactly like the git routes: the credential decides, never the URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const threads = new Map<string, ChangeRequestHead>();
  const { handler, headSha, asked } = await buildGateway(root, threads);
  threads.set(THREAD, openHead(headSha));
  try {
    // No credential; another run's key on this run's path; a member the grant does not hold —
    // all 401, never 404, so nothing about which runs or repos exist leaks.
    const bare = await handler(
      new Request(`http://gw.test/v1/git/r-a/${REPO}/change-requests/${THREAD}/base`, {
        method: "POST",
      }),
    );
    assertEquals(bare.status, 401);
    await bare.body?.cancel();

    const crossRun = await warm(handler, { token: OTHER_TOKEN });
    assertEquals(crossRun.status, 401);
    await crossRun.body?.cancel();

    // A key the orchestrator no longer resolves — the run reached a terminal state, or its key
    // was revoked — closes this door with everything else the credential opened.
    const revoked = await warm(handler, { token: "no-longer-a-key" });
    assertEquals(revoked.status, 401);
    await revoked.body?.cancel();

    const crossRepo = await warm(handler, { repo: "cr-somebody-elses" });
    assertEquals(crossRepo.status, 401);
    await crossRepo.body?.cancel();

    // A thread reference that could walk the path it is interpolated into never reaches the
    // adapter that would interpolate it — nor does one whose escapes do not decode at all.
    const walking = await warm(handler, { thread: "not%20a%20ref" });
    assertEquals(walking.status, 400);
    assertStringIncludes((await walking.json()).error, "is not a change request reference");
    const undecodable = await warm(handler, { thread: "%zz" });
    assertEquals(undecodable.status, 400);
    await undecodable.body?.cancel();

    assertEquals(asked, [], "the forge must not be asked about a request that was refused");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("with no API for the repo's forge the warm says so, rather than inventing a 404", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  const threads = new Map<string, ChangeRequestHead>();
  const { handler, headSha } = await buildGateway(root, threads, { forges: false });
  threads.set(THREAD, openHead(headSha));
  try {
    const res = await warm(handler);
    assertEquals(res.status, 501);
    assertStringIncludes((await res.json()).error, "cannot read github change requests");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("whether a head lives in THIS repo is each forge's own question", () => {
  const member = (over: Partial<RunGrantRepo>): RunGrantRepo => ({
    connectedRepoId: REPO,
    provider: "github",
    repoRef: REPO_REF,
    url: "https://gh.test/acme/app.git",
    ref: "main",
    branchNamespace: "ryph/ada/r-a",
    tenantId: null,
    ...over,
  });
  const head = (over: Partial<ChangeRequestHead>) => openHead("0".repeat(40), over);

  // GitHub folds case — "acme/App" and "acme/app" are one repository there.
  assertEquals(changeRequestRefusal(head({ headRepoRef: "ACME/App" }), member({})), null);
  // A RID is base58, where case is meaning: folding one would merge two repositories.
  const rid = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
  const radicle = member({ provider: "radicle", repoRef: rid });
  assertEquals(
    changeRequestRefusal(head({ headRepoRef: rid, headRef: "patches/abc" }), radicle),
    null,
  );
  const folded = changeRequestRefusal(
    head({ headRepoRef: rid.toUpperCase(), headRef: "patches/abc" }),
    radicle,
  );
  assertStringIncludes(folded ?? "", "the fork");
  // GitLab decides by the project's id, not its path: the run's grant carries the path the
  // project was connected under, which a rename or a transfer leaves behind.
  const gitlab = member({ provider: "gitlab", repoRef: "acme/old-name" });
  assertEquals(
    changeRequestRefusal(head({ headRepoRef: "acme/new-name", sameRepo: true }), gitlab),
    null,
  );
  assertStringIncludes(
    changeRequestRefusal(head({ headRepoRef: "acme/old-name", sameRepo: false }), gitlab) ?? "",
    "the fork acme/old-name",
  );
  // The control plane's rule, end for end: a branch named `refs/foo` is a branch, a bare
  // `pull/…` is where pull request heads are kept, and a tag is no branch.
  assertEquals(changeRequestRefusal(head({ headRef: "refs/foo" }), member({})), null);
  assertStringIncludes(
    changeRequestRefusal(head({ headRef: "pull/1/head" }), member({})) ?? "",
    "collides with change request heads",
  );
  assertStringIncludes(
    changeRequestRefusal(head({ headRef: "refs/tags/v1" }), member({})) ?? "",
    "cannot be served",
  );
});

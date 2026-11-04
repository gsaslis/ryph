import { test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// The mid-run re-target: the agent called `checkout_change_request`, the runner warmed and
// fetched the head, and this is the claim it makes here — POST /v1/runs/:id/target. What the
// suite is really about is the two invariants around it: a refusal writes NOTHING (the runner
// still has the old checkout on disk), and once the claim lands, the run's next patch goes onto
// that change request rather than opening a second one.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import { sweepPatches } from "../src/core/reaper.ts";
import {
  DEFAULT_PATCH_SUBMIT_CONFIG,
  markSubmitted,
  markSubmitting,
  openPatch,
} from "../src/core/patch_lifecycle.ts";
import { retarget } from "../src/core/retarget.ts";
import type { Run, Task } from "../src/core/types.ts";
import type { ForgeThreadContext, ForgeThreadOutcome } from "../src/ports/forge.ts";
import {
  fakeClock,
  fakeIdentityDirectory,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";

const GATEWAY = { url: "http://gateway.test:7412", keyTtlMs: 60 * 60 * 1000 };
// An admin: a forge policy is an admin-only field, and the run needs one to HAVE a forge scope
// whose origin the re-target can fill in.
const USER = {
  kind: "user",
  userId: "u-1",
  email: "ada@example.com",
  name: "Ada",
  caps: ["*"],
  emailVerified: true,
  sid: "s-1",
  via: "session",
} as const;
const REPO_LISTING = {
  fullName: "acme/app",
  url: "https://github.com/acme/app.git",
  defaultBranch: "main",
  private: true,
};
const WEB_LISTING = {
  fullName: "acme/web",
  url: "https://github.com/acme/web.git",
  defaultBranch: "main",
  private: true,
};

/** An open pull request whose branch lives in the connected repo — one a run can be moved onto. */
const OPEN_PR = {
  ref: "7",
  url: "https://github.com/acme/app/pull/7",
  state: "open" as const,
  merged: false,
  headRef: "feat/scheduler",
  headSha: "b".repeat(40),
  authorHeadSha: "b".repeat(40),
  headRepoRef: "acme/app",
  baseRef: "main",
  defaultBranch: "main",
};

/**
 * One forge, several change requests, each its own refusal — so the whole ladder is exercised
 * against one app, and a test naming "9" is naming the fork.
 */
function threadFor(ref: string): ForgeThreadOutcome {
  if (ref === "404") return { kind: "gone" };
  if (ref === "503") return { kind: "unavailable" };
  const over = ref === "8"
    ? { state: "closed" as const, merged: true }
    : ref === "9"
    ? { headRepoRef: "grace/app-fork" }
    : ref === "10"
    ? { headRef: "main" }
    : ref === "11"
    ? { headRef: "-oops" }
    : ref === "12"
    // The sibling repo's own change request, so a two-repo checkout has one in each.
    ? { headRepoRef: "acme/web", headRef: "feat/storefront" }
    : ref === "tag"
    ? { headRef: "refs/tags/v1.0" }
    // A forge that spells its head fully qualified — which nothing past the claim serves.
    : ref === "qualified"
    ? { headRef: "refs/heads/feature/x" }
    // Radicle resolves a unique PREFIX of a patch id: the caller typed the short form, the
    // forge answers with the whole one.
    : ref === "ab12cd3"
    ? { ref: "ab12cd34ef56789012345678901234567890abcd" }
    : {};
  const thread: ForgeThreadContext = {
    kind: "change_request",
    ref,
    title: `Pull request #${ref}`,
    body: "The scheduler, revisited.",
    authorLogin: "grace",
    createdAt: "2026-01-01T00:00:00.000Z",
    state: "open",
    entries: [],
    truncated: false,
    changeRequest: { ...OPEN_PR, ref, url: `https://github.com/acme/app/pull/${ref}`, ...over },
  };
  return { kind: "thread", thread };
}

function buildApp() {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner, launches } = fakeProvisioner();
  const identities = fakeIdentityDirectory();
  const forge = noopForge(silentDiagnostics(), {
    permission: "allowed",
    repos: [REPO_LISTING, WEB_LISTING],
    thread: threadFor,
  });
  const deps = {
    store,
    provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate: (() => Promise.resolve(USER)) as unknown as Authenticate,
    forgeToken: "forge-service-token",
    forge,
    githubConnect: forge,
    toolAccess: {
      getServer: (id: string) =>
        Promise.resolve({ id, slug: id, name: id, archivedAt: null as string | null }),
      issueRunCredentials: () => Promise.reject(new Error("not in these tests")),
      revokeRunCredentials: () => Promise.resolve(),
      archiveServer: () => Promise.reject(new Error("not in these tests")),
    },
    identityDirectory: identities.directory,
    now: clock.now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: GATEWAY,
      runHistoryUrl: null,
      appUrl: null,
      services: DEFAULT_SERVICE_POLICY,
      egress: {
        policy: { mode: "proxy" as const, bundles: [], hosts: [], proxyUrl: null },
        key: null,
        tokenTtlMs: 0,
      },
      platformMemoryServerId: null,
      platformChatServerId: null,
      platformTools: {
        webServerId: "ms-platform-web",
        web: false,
        forge: "ms-platform-forge",
        pending: false,
      },
    },
  };
  return { handler: makeHandler(deps), deps, store, clock, launches, forge, identities };
}

/** The claim answers before its progress comment has been posted — the comment is deliberately
 * off the response path — so a test that asserts on the forge waits one turn of the loop. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Handler = (req: Request) => Promise<Response>;
const post = (handler: Handler, path: string, body: unknown = {}, token = "t") =>
  handler(
    new Request(`http://orchestrator.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );

/** The agent's forge policy: a run-scoped one, so the run HAS a forge scope whose origin the
 * re-target can fill in. Without it there is no scope at all and the assertion would be vacuous. */
const FORGE_POLICY = {
  repos: "run",
  read: true,
  createIssues: null,
  comment: { where: "origin", max: 5 },
  review: null,
  closeIssues: null,
  labels: [],
};

/** Link, install, connect, mint the agent, launch a run on the repo. */
async function liveRun(app: ReturnType<typeof buildApp>, canOpenPatches = true) {
  app.identities.link(USER.userId, "noop-ada-lovelace");
  await post(app.handler, "/v1/installations", { installationId: "42" });
  const repo = await (await post(app.handler, "/v1/connected-repos", {
    installationId: "42",
    repoRef: "acme/app",
  })).json();
  const agentRes = await post(app.handler, "/v1/agents", {
    name: "Ada",
    email: "ada@example.com",
    harnessKind: "pi",
    forgePolicy: FORGE_POLICY,
  });
  assertEquals(agentRes.status, 201, await agentRes.clone().text());
  const agent = await agentRes.json();
  if (!canOpenPatches) await app.store.setAgentCanOpenPatches(agent.id, true, false);
  const created = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Review the scheduler patch", instructions: "Have a look at #7." },
    connectedRepoId: repo.id,
    lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
  });
  assertEquals(created.status, 201, await created.clone().text());
  const { taskId, runId } = await created.json();
  const runToken = (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN;
  await post(app.handler, `/v1/runs/${runId}/heartbeat`, { seq: 0, phase: "running" }, runToken);
  return { taskId, runId, runToken, repo, agent };
}

const BRANCH = (runId: string, connectedRepoId: string, sha = "a".repeat(40)) => ({
  connectedRepoId,
  path: "app",
  name: `ryph/ada/${runId}/work`,
  line: "work",
  headSha: sha,
  commits: [{ sha, subject: "address the review" }],
  generation: 1,
  carries: [],
});

// ---- the pure apply -------------------------------------------------------

/** The smallest task and run the pure function reads — everything else it copies through. */
function pair(over: { origin?: Run["forgeScope"] } = {}) {
  const task = {
    id: "t-1",
    repos: [
      { connectedRepoId: "cr-1", path: "app", ref: "main", name: "acme/app" },
      { connectedRepoId: "cr-2", path: "web", ref: "main", name: "acme/web" },
    ],
    targetChangeRequest: null,
    landings: {},
  } as unknown as Task;
  const run = {
    id: "r-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    workItem: { repos: structuredClone(task.repos) },
    forgeScope: over.origin === undefined
      ? {
        repos: [{
          connectedRepoId: "cr-1",
          provider: "github",
          repoRef: "acme/app",
          tenantId: null,
        }],
        sourceRepos: [],
        origin: null,
        capabilities: {
          read: true,
          createIssues: null,
          comment: null,
          review: null,
          closeIssues: null,
          labels: [],
        },
        provenance: {
          agentName: "Ada",
          runUrl: null,
          requestedBy: null,
          requestedVia: null,
        },
      }
      : over.origin,
  } as unknown as Run;
  return { task, run };
}

const APPLY = {
  path: "app",
  connectedRepoId: "cr-1",
  thread: "7",
  headRef: "feat/scheduler",
  headSha: "b".repeat(40),
  targetRef: "main",
  at: "2026-01-02T00:00:00.000Z",
};

test("the apply moves one repo's ref, the target and the scope's origin — and nothing else", () => {
  const { task, run } = pair();
  const out = retarget({ task, run, ...APPLY });

  assertEquals(out.task.repos.map((r) => [r.path, r.ref]), [["app", "feat/scheduler"], [
    "web",
    "main",
  ]]);
  assertEquals(out.task.targetChangeRequest, { connectedRepoId: "cr-1", thread: "7" });
  // The frozen spec agrees with the task: a runner re-fetching its spec must not be told to
  // clone the base the run has already left.
  assertEquals(out.run.workItem.repos.map((r) => r.ref), ["feat/scheduler", "main"]);
  // And both learn what the change request merges into, which the gateway refreshes beside it.
  assertEquals(out.task.repos.map((r) => r.targetRef), ["main", undefined]);
  assertEquals(out.run.workItem.repos.map((r) => r.targetRef), ["main", undefined]);
  assertEquals(out.run.forgeScope!.origin, {
    connectedRepoId: "cr-1",
    kind: "change_request",
    ref: "7",
  });
  assertEquals(out.event.kind, "retargeted");
  assertStringIncludes(out.event.detail!, "app");
  assertStringIncludes(out.event.detail!, "#7");
  assertStringIncludes(out.event.detail!, "feat/scheduler");
  // The inputs are untouched: everything here is a copy, so a caller that refuses to persist
  // still holds the run it read.
  assertEquals(task.repos[0].ref, "main");
  assertEquals(task.targetChangeRequest, null);
});

test("the apply replaces a repo's target with the change request's, or drops it", () => {
  const { task, run } = pair();
  task.repos[0] = { ...task.repos[0], targetRef: "refs/heads/old" };
  run.workItem.repos[0] = { ...run.workItem.repos[0], targetRef: "old" };
  const replaced = retarget({ task, run, ...APPLY, targetRef: "release/2.x" });
  assertEquals(replaced.task.repos[0].targetRef, "release/2.x");
  assertEquals(replaced.run.workItem.repos[0].targetRef, "release/2.x");
  // None the run could fetch: the old one goes rather than lingering as the wrong branch.
  const dropped = retarget({ task, run, ...APPLY, targetRef: undefined });
  assert(!("targetRef" in dropped.task.repos[0]));
  assert(!("targetRef" in dropped.run.workItem.repos[0]));
});

test("the apply drops the run's own release landing at the path, and keeps every other", () => {
  const { task, run } = pair();
  const landing = (generation: number, releasedRun?: string) => ({
    connectedRepoId: "cr-1",
    thread: "5",
    onto: "main",
    generation,
    moved: true,
    at: "2026-01-01T00:00:00.000Z",
    ...(releasedRun === undefined ? {} : { releasedRun }),
  });
  // This run's release ended the generation its runner now works on the change request: gone.
  // Only the default line's: a release only ever lands that one, and another line's landing at
  // the same path is that line's own.
  const web = { work: { ...landing(2), connectedRepoId: "cr-2" } };
  const fixA = landing(1);
  task.landings = { app: { work: landing(1, "r-1"), "fix-a": fixA }, web };
  assertEquals(retarget({ task, run, ...APPLY }).task.landings, { app: { "fix-a": fixA }, web });
  // Another attempt's release, or a merge's landing, stays.
  task.landings = { app: { work: landing(1, "r-0") } };
  assertEquals(retarget({ task, run, ...APPLY }).task.landings, {
    app: { work: landing(1, "r-0") },
  });
  task.landings = { app: { work: landing(3) } };
  assertEquals(retarget({ task, run, ...APPLY }).task.landings, { app: { work: landing(3) } });
});

test("the apply leaves an origin the run already has, and never invents one", () => {
  // A run commanded from issue #3 keeps #3: its follow-up comments belong to the conversation
  // it came from, whatever branch its commits now land on.
  const held = pair();
  held.run.forgeScope!.origin = { connectedRepoId: "cr-1", kind: "issue", ref: "3" };
  assertEquals(retarget({ ...held, ...APPLY }).run.forgeScope!.origin, {
    connectedRepoId: "cr-1",
    kind: "issue",
    ref: "3",
  });

  const first = retarget({ ...held, ...APPLY });
  const second = retarget({ ...first, ...APPLY, thread: "8" });
  const repeated = retarget({ ...second, ...APPLY, thread: "8" });
  assertEquals(repeated.run.forgeScope!.workedChangeRequests, [
    { connectedRepoId: "cr-1", ref: "7" },
    { connectedRepoId: "cr-1", ref: "8" },
  ]);
  assertEquals(held.run.forgeScope!.workedChangeRequests, undefined);
  assertEquals(repeated.run.forgeScope!.origin, held.run.forgeScope!.origin);

  // A scope that never listed the repo gains nothing: `origin` is a thread the run may WRITE to,
  // and one in an unlisted repo would be a widening rather than a re-target.
  const unlisted = pair();
  unlisted.run.forgeScope!.repos = [];
  assertEquals(retarget({ ...unlisted, ...APPLY }).run.forgeScope!.origin, null);
  assertEquals(retarget({ ...unlisted, ...APPLY }).run.forgeScope!.workedChangeRequests, undefined);

  // And a run with no forge scope at all stays that way.
  const bare = pair({ origin: null });
  assertEquals(retarget({ ...bare, ...APPLY }).run.forgeScope, null);
});

// ---- the route ------------------------------------------------------------

test("the claim re-targets task, spec and scope, and answers where the branch is", async () => {
  const app = buildApp();
  const { taskId, runId, runToken, repo } = await liveRun(app);

  const res = await post(app.handler, `/v1/runs/${runId}/target`, {
    path: "app",
    changeRequest: "7",
  }, runToken);
  assertEquals(res.status, 200, await res.clone().text());
  assertEquals(await res.json(), {
    connectedRepoId: repo.id,
    thread: "7",
    ref: "feat/scheduler",
    targetRef: "main",
    headSha: "b".repeat(40),
    url: "https://github.com/acme/app/pull/7",
  });

  const task = (await app.store.getTask(taskId))!;
  assertEquals(task.targetChangeRequest, { connectedRepoId: repo.id, thread: "7" });
  assertEquals(task.repos.map((r) => [r.ref, r.targetRef]), [["feat/scheduler", "main"]]);
  const run = (await app.store.getRun(runId))!;
  assertEquals(run.workItem.repos.map((r) => [r.ref, r.targetRef]), [["feat/scheduler", "main"]]);
  assertEquals(run.forgeScope!.origin, {
    connectedRepoId: repo.id,
    kind: "change_request",
    ref: "7",
  });
  // The run is still the chat-less task it was: where it was COMMANDED from does not move.
  assertEquals(run.originThreadRepoId, null);
  assertEquals(
    (await app.store.listEvents(runId)).map((e) => e.kind).includes("retargeted"),
    true,
  );

  // The same call again is the re-swap the design allows before any patch: idempotent here.
  const again = await post(app.handler, `/v1/runs/${runId}/target`, {
    path: "app",
    changeRequest: "7",
  }, runToken);
  assertEquals(again.status, 200);
});

test("a re-targeted run's patch lands ON the change request, based on its branch", async () => {
  const app = buildApp();
  const { runId, runToken, repo } = await liveRun(app);
  assertEquals(
    (await post(
      app.handler,
      `/v1/runs/${runId}/target`,
      { path: "app", changeRequest: "7" },
      runToken,
    ))
      .status,
    200,
  );

  const born = await post(app.handler, `/v1/runs/${runId}/patches`, {
    branch: BRANCH(runId, repo.id),
    baseSha: "b".repeat(40),
  }, runToken);
  assertEquals(born.status, 201);
  const { patchId } = await born.json();
  assertEquals((await post(app.handler, `/v1/patches/${patchId}/approve`)).status, 200);

  await sweepPatches({
    store: app.store,
    forge: app.forge,
    identityDirectory: app.identities.directory,
    diag: silentDiagnostics(),
    now: app.clock.now,
  }, DEFAULT_PATCH_SUBMIT_CONFIG);

  const submission = app.forge.submissions.at(-1)!;
  // Onto #7, not a new pull request — and anchored on #7's own branch.
  assertEquals(submission.changeRequest, "7");
  // With the run, whose image refs the forge renders in the body.
  assertEquals(submission.runId, runId);
  assertEquals(submission.baseBranch, "feat/scheduler");
});

test("once the repo has shipped, the swap is refused and nothing moves", async () => {
  const app = buildApp();
  const { taskId, runId, runToken, repo } = await liveRun(app);
  assertEquals(
    (await post(app.handler, `/v1/runs/${runId}/patches`, {
      branch: BRANCH(runId, repo.id),
      baseSha: "c".repeat(40),
    }, runToken)).status,
    201,
  );

  const res = await post(app.handler, `/v1/runs/${runId}/target`, {
    path: "app",
    changeRequest: "7",
  }, runToken);
  assertEquals(res.status, 409);
  assertStringIncludes((await res.json()).error, "already submitted a patch");
  assertEquals((await app.store.getTask(taskId))!.targetChangeRequest, null);
});

test("a change request another live run is working is refused, by run id", async () => {
  const app = buildApp();
  const { runId, runToken, repo, agent } = await liveRun(app);

  // The other door onto the same branch: a task started from the app ON #7.
  const other = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Address the review", instructions: "Do what the review says." },
    connectedRepoId: repo.id,
    targetChangeRequest: { connectedRepoId: repo.id, thread: "7" },
  });
  assertEquals(other.status, 201, await other.clone().text());
  const otherRunId = (await other.json()).runId;

  const res = await post(app.handler, `/v1/runs/${runId}/target`, {
    path: "app",
    changeRequest: "7",
  }, runToken);
  assertEquals(res.status, 409);
  assertStringIncludes((await res.json()).error, otherRunId);
});

test("a live run that TARGETS the change request keeps it against a second task", async () => {
  // The claim read from the other side: once run A holds #7 through a mid-run swap, the app's
  // own "work on #7" door has to see it, or two runs push onto one branch.
  const app = buildApp();
  const { runId, runToken, repo, agent } = await liveRun(app);
  assertEquals(
    (await post(
      app.handler,
      `/v1/runs/${runId}/target`,
      { path: "app", changeRequest: "7" },
      runToken,
    ))
      .status,
    200,
  );
  const held = await app.store.findLiveRunOnChangeRequest(repo.id, "7");
  assertEquals(held?.id, runId);

  // And a run that merely EXISTS on another change request is not it.
  assertEquals(await app.store.findLiveRunOnChangeRequest(repo.id, "12"), null);
  assertEquals(agent.handle, "ada");
});

test("the forge's own answer refuses the swap: closed, a fork, the default branch, a bad name", async () => {
  const app = buildApp();
  const { taskId, runId, runToken } = await liveRun(app);
  const refuse = async (changeRequest: string, expect: number, says: string) => {
    const res = await post(
      app.handler,
      `/v1/runs/${runId}/target`,
      { path: "app", changeRequest },
      runToken,
    );
    assertEquals(res.status, expect, `#${changeRequest}: ${await res.clone().text()}`);
    assertStringIncludes((await res.json()).error, says);
  };
  await refuse("8", 400, "merged");
  await refuse("9", 400, "fork");
  await refuse("10", 400, "default branch");
  await refuse("11", 400, "not a branch name");
  await refuse("404", 404, "no change request");
  await refuse("503", 503, "did not answer");

  // Every one of them wrote nothing: the runner still holds the checkout it had.
  const task = (await app.store.getTask(taskId))!;
  assertEquals(task.targetChangeRequest, null);
  assertEquals(task.repos.map((r) => r.ref), ["main"]);
  assertEquals(
    (await app.store.listEvents(runId)).filter((e) => e.kind === "retargeted"),
    [],
  );
});

test("a path the run does not hold is refused, and a terminal run claims nothing", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);

  // A path the run does not hold at all.
  const absent = await post(app.handler, `/v1/runs/${runId}/target`, {
    path: "nope",
    changeRequest: "7",
  }, runToken);
  assertEquals(absent.status, 400);
  assertStringIncludes((await absent.json()).error, "no repo at nope");

  // And once the run is over there is nothing left to move.
  assertEquals(
    (await post(app.handler, `/v1/runs/${runId}/result`, {
      status: "success",
      branches: [],
      summary: "Read it.",
    }, runToken)).status,
    200,
  );
  const late = await post(app.handler, `/v1/runs/${runId}/target`, {
    path: "app",
    changeRequest: "7",
  }, runToken);
  assertEquals(late.status, 409);
  assertStringIncludes((await late.json()).error, "terminal");

  // A stranger's token is a 401 whichever run it names, as everywhere on this surface.
  assertEquals(
    (await post(
      app.handler,
      `/v1/runs/${runId}/target`,
      { path: "app", changeRequest: "7" },
      "x",
    ))
      .status,
    401,
  );
});

test("a /ryph on a change request a live run TARGETS joins that run", async () => {
  // The symmetry the claim needs: the run's origin is still the app, but its commits land on #7,
  // so a command there must reach it rather than start a second agent on the same branch.
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  assertEquals(
    (await post(
      app.handler,
      `/v1/runs/${runId}/target`,
      { path: "app", changeRequest: "7" },
      runToken,
    ))
      .status,
    200,
  );

  const delivered = await post(app.handler, "/v1/forge/events", {
    deliveryId: "gh-delivery-1",
    kind: "issue_comment.created",
    repo: { provider: "github", repoRef: "acme/app", url: REPO_LISTING.url },
    actorLogin: "noop-ada-lovelace",
    thread: { kind: "change_request", ref: "7" },
    body: "/ryph ada also bump the timeout",
    sourceCommentId: "1234",
    receivedAt: "2026-01-01T00:00:00.000Z",
  }, "forge-service-token");
  const verdict = await delivered.json();
  assertEquals(verdict.outcome, "joined", JSON.stringify(verdict));
  assertEquals(app.launches.length, 1, "no second container on the same branch");

  const inbox = await app.store.listRunMessages(runId);
  assertEquals(inbox.length, 1);
  assertStringIncludes(inbox[0].text, "bump the timeout");
});

test("a second repo cannot be swapped while the task already works another repo's change request", async () => {
  // `targetChangeRequest` is ONE field. Letting `web` take it would leave `app` with no target
  // at all, and `app`'s next patch would quietly open a pull request of its own while #7 — the
  // change request the run was started on — is abandoned without a word.
  const app = buildApp();
  app.identities.link(USER.userId, "noop-ada-lovelace");
  await post(app.handler, "/v1/installations", { installationId: "42" });
  const appRepo = await (await post(app.handler, "/v1/connected-repos", {
    installationId: "42",
    repoRef: "acme/app",
  })).json();
  const webRepo = await (await post(app.handler, "/v1/connected-repos", {
    installationId: "42",
    repoRef: "acme/web",
  })).json();
  const workspace = (await (await post(app.handler, "/v1/workspaces", { name: "Shop" })).json())
    .workspace;
  for (const id of [appRepo.id, webRepo.id]) {
    assertEquals(
      (await post(app.handler, `/v1/workspaces/${workspace.id}/repos`, { connectedRepoId: id }))
        .status,
      201,
    );
  }
  const agent = await (await post(app.handler, "/v1/agents", {
    name: "Ada",
    email: "ada@example.com",
    harnessKind: "pi",
    forgePolicy: FORGE_POLICY,
  })).json();
  const created = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Review #7", instructions: "Have a look." },
    workspaceId: workspace.id,
    lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
  });
  assertEquals(created.status, 201, await created.clone().text());
  const { taskId, runId } = await created.json();
  const runToken = (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN;

  assertEquals(
    (await post(
      app.handler,
      `/v1/runs/${runId}/target`,
      { path: "app", changeRequest: "7" },
      runToken,
    ))
      .status,
    200,
  );
  const second = await post(app.handler, `/v1/runs/${runId}/target`, {
    path: "web",
    changeRequest: "12",
  }, runToken);
  assertEquals(second.status, 409);
  const error = (await second.json()).error;
  assertStringIncludes(error, "#7");
  assertStringIncludes(error, "acme/app");

  // Nothing moved: `app` still holds the target and `web` still sits on its own base.
  const task = (await app.store.getTask(taskId))!;
  assertEquals(task.targetChangeRequest, { connectedRepoId: appRepo.id, thread: "7" });
  assertEquals(
    task.repos.map((r) => [r.path, r.ref]),
    [["app", "feat/scheduler"], ["web", "main"]],
  );
});

test("the claim records the FORGE's address for the thread, not the agent's abbreviation", async () => {
  // Radicle resolves a unique prefix of a patch id. A claim recorded under the abbreviation is
  // one that a webhook carrying the full id would match nothing of — and a second run would
  // start on the same patch.
  const app = buildApp();
  const { taskId, runId, runToken, repo } = await liveRun(app);
  const canonical = "ab12cd34ef56789012345678901234567890abcd";

  const res = await post(app.handler, `/v1/runs/${runId}/target`, {
    path: "app",
    changeRequest: "ab12cd3",
  }, runToken);
  assertEquals(res.status, 200, await res.clone().text());
  assertEquals((await res.json()).thread, canonical);
  assertEquals(
    (await app.store.getTask(taskId))!.targetChangeRequest,
    { connectedRepoId: repo.id, thread: canonical },
  );
  // Which is what the later lookup — the webhook's, the app door's — asks with.
  assertEquals((await app.store.findLiveRunOnChangeRequest(repo.id, canonical))?.id, runId);
});

test("a re-targeted run gains a progress comment on the change request it moved onto", async () => {
  // The run was started from the app, so neither intake opened a comment on the forge. Without
  // one, a later `/ryph` on the change request joins the run, reacts 👀, and then says nothing
  // more: the progress sweep and the final report both write through that row.
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  assertEquals(app.forge.comments.length, 0);

  assertEquals(
    (await post(
      app.handler,
      `/v1/runs/${runId}/target`,
      { path: "app", changeRequest: "7" },
      runToken,
    ))
      .status,
    200,
  );
  await settle();
  assertEquals(app.forge.comments.length, 1);
  assertEquals(app.forge.comments[0].thread, "7");
  assertStringIncludes(app.forge.comments[0].body, runId);
  const open = await app.store.listOpenProgressComments();
  assertEquals(open.map((c) => [c.runId, c.threadRef]), [[runId, "7"]]);

  // The re-swap does not open a second: the run already holds one.
  assertEquals(
    (await post(
      app.handler,
      `/v1/runs/${runId}/target`,
      { path: "app", changeRequest: "7" },
      runToken,
    ))
      .status,
    200,
  );
  await settle();
  assertEquals(app.forge.comments.length, 1);
});

test("a run that may not open patches reads a change request without claiming it", async () => {
  const app = buildApp();
  // Freeze the locked policy at task creation, rather than rewriting the live run.
  const { taskId, runId, runToken, repo } = await liveRun(app, false);

  const res = await post(app.handler, `/v1/runs/${runId}/target`, {
    path: "app",
    changeRequest: "7",
  }, runToken);
  assertEquals(res.status, 200, await res.clone().text());
  // The runner still learns where the branch is, so it can move its checkout...
  assertEquals((await res.json()).ref, "feat/scheduler");
  await settle();
  // ...and nothing was written: no re-target, no progress comment, no hold on #7.
  assertEquals((await app.store.getTask(taskId))!.targetChangeRequest, null);
  assertEquals((await app.store.getRun(runId))!.forgeScope!.origin, null);
  assertEquals(app.forge.comments.length, 0);
  assertEquals(await app.store.findLiveRunOnChangeRequest(repo.id, "7"), null);
});

test("the app's own door will not start a second run on a change request a run holds", async () => {
  const app = buildApp();
  const { runId, runToken, repo, agent } = await liveRun(app);
  assertEquals(
    (await post(
      app.handler,
      `/v1/runs/${runId}/target`,
      { path: "app", changeRequest: "7" },
      runToken,
    ))
      .status,
    200,
  );

  const second = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Also look at #7", instructions: "Have a look too." },
    connectedRepoId: repo.id,
    targetChangeRequest: { connectedRepoId: repo.id, thread: "7" },
  });
  assertEquals(second.status, 409);
  assertStringIncludes((await second.json()).error, runId);
  assertEquals(app.launches.length, 1, "no second container on the same branch");
});

test("the change request a live run OPENED is held against another run's swap and the app", async () => {
  // a run that opened #7 with submit_patch is pushing onto #7's branch whether or not
  // its task targets it, so neither another run's checkout_change_request nor the app's door may
  // put a second run there.
  const app = buildApp();
  const { taskId, runId, repo, agent } = await liveRun(app);
  const opened = markSubmitted(
    (() => {
      const taken = markSubmitting(
        openPatch(
          {
            id: "p-1",
            connectedRepoId: repo.id,
            runId,
            taskId,
            setId: "set-1",
            path: "app",
            line: "work",
            branchName: `ryph/ada/${runId}/work`,
            headSha: "a".repeat(40),
            bundleKey: `${runId}/${repo.id}/${"a".repeat(40)}.bundle`,
            baseSha: null,
            generation: 1,
            title: null,
            description: null,
            commits: [],
            carries: [],
            heldReason: null,
          },
          "auto",
          true,
          "2026-01-01T00:00:00.000Z",
        ).patch,
        "2026-01-01T00:01:00.000Z",
      );
      assert(taken.kind === "applied");
      return taken.patch;
    })(),
    {
      ref: "7",
      url: "https://github.com/acme/app/pull/7",
      branch: `ryph/ada/${runId}/work`,
      diffRef: "main",
    },
    "2026-01-01T00:02:00.000Z",
  );
  assert(opened.kind === "applied");
  await app.store.createPatch(opened.patch);

  // A second run, started plain, asks to move onto #7.
  const other = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Look at #7", instructions: "Have a look." },
    connectedRepoId: repo.id,
  });
  assertEquals(other.status, 201, await other.clone().text());
  const otherRunId = (await other.json()).runId;
  const otherToken = (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN;
  await post(
    app.handler,
    `/v1/runs/${otherRunId}/heartbeat`,
    { seq: 0, phase: "running" },
    otherToken,
  );
  const swap = await post(app.handler, `/v1/runs/${otherRunId}/target`, {
    path: "app",
    changeRequest: "7",
  }, otherToken);
  assertEquals(swap.status, 409);
  assertStringIncludes((await swap.json()).error, runId);

  // And the app's door is refused the same way.
  const second = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Also look at #7", instructions: "Have a look too." },
    connectedRepoId: repo.id,
    targetChangeRequest: { connectedRepoId: repo.id, thread: "7" },
  });
  assertEquals(second.status, 409);
  assertStringIncludes((await second.json()).error, runId);
  assertEquals(app.launches.length, 2, "no third container on the same branch");
});

test("a fully qualified head is recorded as the branch NAME every later hop serves", async () => {
  // The gateway's cache serves a base as a local branch and the reaper anchors the pull request
  // on `normalizeBaseRef(entry.ref).localBranch`. A task re-targeted onto `refs/heads/feature/x`
  // would name a ref nothing serves, and the runner — which compares its served ref against this
  // answer AFTER the claim is recorded — would refuse the same mismatch on every retry.
  const app = buildApp();
  const { taskId, runId, runToken } = await liveRun(app);
  const res = await post(app.handler, `/v1/runs/${runId}/target`, {
    path: "app",
    changeRequest: "qualified",
  }, runToken);
  assertEquals(res.status, 200, await res.clone().text());
  assertEquals((await res.json()).ref, "feature/x");
  assertEquals((await app.store.getTask(taskId))!.repos.map((r) => r.ref), ["feature/x"]);
  assertEquals((await app.store.getRun(runId))!.workItem.repos.map((r) => r.ref), ["feature/x"]);
  await settle();
});

test("the two refusals decided before any write say so, so a retry is safe", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  const res = await post(app.handler, `/v1/runs/${runId}/target`, {
    path: "app",
    changeRequest: "503",
  }, runToken);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).recorded, false);
});

test("a head that cannot anchor a checkout is refused where somebody is listening", async () => {
  // `isGitRefName` takes `refs/tags/v1.0`; a checkout cannot be anchored on it, and the gateway
  // holds a base ref to the same rule. Refused here rather than at a clone nobody is watching.
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  const res = await post(app.handler, `/v1/runs/${runId}/target`, {
    path: "app",
    changeRequest: "tag",
  }, runToken);
  assertEquals(res.status, 400);
  assertStringIncludes((await res.json()).error, "cannot anchor a checkout");
});

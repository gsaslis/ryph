import { test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// Phase 2 end to end with no GitHub anywhere: link an identity, register an installation,
// connect a repo, launch a gated task, land a result, approve the patch, and watch the
// submitter deliver it through the (noop) forge — plus every refusal on the way.

import { capsClaimOf } from "@ryph/auth";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import { sweep, sweepPatches } from "../src/core/reaper.ts";
import {
  DEFAULT_PATCH_SUBMIT_CONFIG,
  overlapReason,
  UNCONFIRMED_REASON,
} from "../src/core/patch_lifecycle.ts";
import type { MemoryAccess } from "../src/ports/memory_access.ts";
import type {
  Forge,
  ForgePatchDiffs,
  ForgePermission,
  GithubConnect,
  PatchDiffAsk,
  PatchDiffOutcome,
} from "../src/ports/forge.ts";
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
const USER = {
  kind: "user",
  userId: "u-1",
  email: "ada@example.com",
  name: "Ada",
  caps: capsClaimOf("member"),
} as const;
const BREAK_GLASS = { kind: "break-glass" } as const;

const REPO_LISTING = {
  fullName: "acme/app",
  url: "https://github.com/acme/app.git",
  defaultBranch: "main",
  private: true,
};

/** GitHub's connect surface, beside the forge-agnostic port: a hand-rolled `Forge` fake below
 * stands in for the boundary, and the connect flow still has to answer. */
const GITHUB_CONNECT: GithubConnect = {
  getInstallationSettingsUrl: (id) =>
    Promise.resolve(`https://github.com/organizations/acme/settings/installations/${id}`),
  describeInstallation: () =>
    Promise.resolve({ accountLogin: "acme", settingsUrl: null, repos: [REPO_LISTING] }),
  checkOrgMembership: () => Promise.resolve("member"),
  exchangeOAuthCode: (code) =>
    Promise.resolve({
      accountId: `noop-${code}`,
      login: `noop-${code}`,
      name: null,
      verifiedEmails: [],
      accessToken: null,
    }),
};

function buildApp(
  opts: {
    forge?: Forge;
    permission?: ForgePermission;
    caller?: unknown;
    /** Who is asking, swappable mid-test; wins over `caller`. */
    who?: { caller: unknown };
    /** Default: the forge itself, when it reads diffs (the noop one does). */
    patchDiffs?: ForgePatchDiffs | null;
  } = {},
) {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner, launches } = fakeProvisioner();
  const forge = opts.forge ??
    noopForge(silentDiagnostics(), {
      permission: opts.permission ?? "allowed",
      repos: [REPO_LISTING],
    });
  const authenticate =
    (() => Promise.resolve(opts.who?.caller ?? opts.caller ?? USER)) as unknown as Authenticate;
  const patchDiffs = opts.patchDiffs !== undefined
    ? opts.patchDiffs
    : "readPatchDiff" in forge
    ? forge as unknown as ForgePatchDiffs
    : null;
  const identities = fakeIdentityDirectory();
  const handler = makeHandler({
    store,
    provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate,
    forgeToken: "forge-service-token",
    forge,
    patchDiffs,
    githubConnect: GITHUB_CONNECT,
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
        forge: null,
        pending: false,
      },
    },
  });
  return { handler, store, clock, launches, forge, identities };
}

type Handler = (req: Request) => Promise<Response>;
const post = (handler: Handler, path: string, body: unknown = {}, token = "t") =>
  handler(
    new Request(`http://orchestrator.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
const patchJson = (handler: Handler, path: string, body: unknown) =>
  handler(
    new Request(`http://orchestrator.test${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify(body),
    }),
  );
const get = (handler: Handler, path: string, token = "t") =>
  handler(
    new Request(`http://orchestrator.test${path}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
const handlerDelete = (handler: Handler, path: string) =>
  handler(
    new Request(`http://orchestrator.test${path}`, {
      method: "DELETE",
      headers: { authorization: "Bearer t" },
    }),
  );

/** Link identity → register installation → connect the repo. The setup every test shares. */
async function connectRepo(app: ReturnType<typeof buildApp>) {
  app.identities.link(USER.userId, "noop-ada-lovelace");

  const registered = await post(app.handler, "/v1/installations", { installationId: "42" });
  assertEquals(registered.status, 201);

  const connected = await post(app.handler, "/v1/connected-repos", {
    installationId: "42",
    repoRef: "acme/app",
  });
  assertEquals(connected.status, 201);
  return await connected.json();
}

/** Create agent + task against the connected repo; returns ids and the run's report token. */
async function launchTask(
  app: ReturnType<typeof buildApp>,
  repoId: string,
  agentExtra: Record<string, unknown> = {},
) {
  const agent = await (await post(app.handler, "/v1/agents", {
    name: "Ada",
    email: "ada@example.com",
    harnessKind: "echo",
    ...agentExtra,
  })).json();
  const created = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Fix the flaky test", instructions: "Fix it." },
    connectedRepoId: repoId,
  });
  assertEquals(created.status, 201);
  const { taskId, runId } = await created.json();
  const runToken = (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN;
  namespaces.set(runId, (await app.store.getRun(runId))!.branchNamespace);
  return { taskId, runId, runToken };
}

/** Each launch makes an agent of its own, and its handle (`ada`, `ada-2`, …) names the run's
 * branch namespace: the one `BRANCH` ships under. */
const namespaces = new Map<string, string>();

/** The one branch a run on the connected repo ships: named for its repo and its directory —
 * `app`, the default path for `acme/app`. */
const BRANCH = (runId: string, connectedRepoId: string, sha = "a".repeat(40)) => ({
  connectedRepoId,
  path: "app",
  name: `${namespaces.get(runId) ?? `ryph/ada/${runId}`}/work`,
  line: "work",
  headSha: sha,
  commits: [{ sha, subject: "fix the flaky test" }],
  generation: 1,
  carries: [],
});

test("a run's branches are named for the agent's handle, not its display name", async () => {
  const app = buildApp();
  const repo = await connectRepo(app);
  const { runId } = await launchTask(app, repo.id, { name: "Lines Tester", handle: "lines" });
  assertEquals((await app.store.getRun(runId))!.branchNamespace, `ryph/lines/${runId}`);
});

test("each line's patch lists its own line's commits, not another line's of the same repo", async () => {
  const app = buildApp();
  const repo = await connectRepo(app);
  const { runId, runToken } = await launchTask(app, repo.id);
  const work = BRANCH(runId, repo.id);
  const fixSha = "b".repeat(40);
  const fix = {
    ...BRANCH(runId, repo.id, fixSha),
    name: `ryph/ada/${runId}/fix`,
    line: "fix",
    commits: [{ sha: fixSha, subject: "fix the other thing" }],
  };
  const reported = await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [work, fix],
    summary: "Two unrelated fixes.",
  }, runToken);
  assertEquals(reported.status, 200);

  const queue = await (await get(app.handler, "/v1/patches?state=pending_approval")).json();
  const byLine = new Map(
    queue.patches.map((p: { line: string; commits: unknown }) => [p.line, p.commits]),
  );
  assertEquals(byLine.get("work"), work.commits);
  assertEquals(byLine.get("fix"), fix.commits);
});

test("the headline loop: connect → launch → result → approve → sweep → PR", async () => {
  const app = buildApp();
  const repo = await connectRepo(app);
  const { taskId, runId, runToken } = await launchTask(app, repo.id);

  // The task recorded who asked, and resolved the repo from the installation's listing.
  const task = await app.store.getTask(taskId);
  assertEquals(task!.requestedByUserId, "u-1");
  assertEquals(task!.origin, "user");
  assertEquals(task!.repos.map((r) => ({ url: r.url, ref: r.ref, path: r.path })), [
    { url: REPO_LISTING.url, ref: "main", path: "app" },
  ]);

  // The result lands with a BranchOutcome → a patch is born, gated by the default policy.
  const reported = await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [BRANCH(runId, repo.id)],
    summary: "Pinned the clock in the flaky test.",
  }, runToken);
  assertEquals(reported.status, 200);

  const queue = await (await get(app.handler, "/v1/patches?state=pending_approval")).json();
  assertEquals(queue.patches.length, 1);
  const patch = queue.patches[0];
  assertEquals(patch.taskTitle, "Fix the flaky test");
  assertEquals(patch.repoRef, "acme/app");
  assertEquals(patch.commits, BRANCH(runId, repo.id).commits);
  assertEquals(patch.bundleKey, `${runId}/work/${repo.id}/${"a".repeat(40)}.bundle`);
  assertEquals(patch.path, "app");
  assert(patch.setId.startsWith("ps-"), "every patch belongs to a set, a single one to its own");

  // Approval queues it; nothing reaches the forge until the sweep fires.
  const approved = await post(app.handler, `/v1/patches/${patch.id}/approve`);
  assertEquals(approved.status, 200);
  assertEquals((await approved.json()).patch.state, "queued");
  const forge = app.forge as ReturnType<typeof noopForge>;
  assertEquals(forge.submissions.length, 0);

  // The submitter delivers: PR "opened", provenance in the body, story in the trail.
  await sweepPatches(
    {
      store: app.store,
      forge,
      identityDirectory: app.identities.directory,
      diag: silentDiagnostics(),
      now: app.clock.now,
    },
    DEFAULT_PATCH_SUBMIT_CONFIG,
  );
  assertEquals(forge.submissions.length, 1);
  const submission = forge.submissions[0];
  assertEquals(submission.repo.repoRef, "acme/app");
  assertEquals(submission.baseBranch, "main");
  assertEquals(submission.title, "Fix the flaky test");
  assertStringIncludes(submission.body, "Pinned the clock");
  assertStringIncludes(submission.body, "**@noop-ada-lovelace**");

  const done = (await app.store.listPatches({ state: "submitted" })).patches[0];
  assert(done.forgeUrl!.includes("/pull/1"));
  assertEquals(done.approvedBy, { kind: "user", userId: "u-1" });
  const events = (await app.store.listEvents(runId)).map((e) => e.kind);
  assertEquals(
    events.filter((k) => k.startsWith("patch-")),
    ["patch-opened", "patch-approved", "patch-submitted"],
  );
});

test("a pull request body shows only the description's and the summary's images", async () => {
  const app = buildApp();
  const repo = await connectRepo(app);
  const { runId, runToken } = await launchTask(app, repo.id);
  const branch = BRANCH(runId, repo.id);
  // A commit subject is the agent's own `git commit -m`, and nothing checked the ref in it: the
  // forge would refuse the whole pull request over it, for good.
  await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [{
      ...branch,
      commits: [{ sha: branch.headSha, subject: "fix ![the old page](img-000000000000)" }],
    }],
    summary: "Pinned the clock.",
  }, runToken);
  const patch = (await (await get(app.handler, "/v1/patches?state=pending_approval")).json())
    .patches[0];
  await (await post(app.handler, `/v1/patches/${patch.id}/approve`)).body?.cancel();
  const forge = app.forge as ReturnType<typeof noopForge>;
  await sweepPatches(
    {
      store: app.store,
      forge,
      identityDirectory: app.identities.directory,
      diag: silentDiagnostics(),
      now: app.clock.now,
    },
    DEFAULT_PATCH_SUBMIT_CONFIG,
  );
  const body = forge.submissions[0].body;
  assertStringIncludes(body, "fix the old page");
  assert(!body.includes("img-000000000000"), body);
});

test("a no-changes success lands as succeeded and opens no patch", async () => {
  const app = buildApp();
  const repo = await connectRepo(app);
  const { runId, runToken } = await launchTask(app, repo.id);

  const reported = await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [],
    summary: "Triaged the issues; no code changes were needed.",
  }, runToken);
  assertEquals(reported.status, 200);

  const run = await app.store.getRun(runId);
  assertEquals(run!.state, "succeeded");
  assertEquals((await app.store.listPatches()).patches, []);
});

test("an agent that may not open patches opens none, mid-run or at the end", async () => {
  const app = buildApp();
  const repo = await connectRepo(app);
  const { runId, runToken } = await launchTask(app, repo.id, { canOpenPatches: false });

  // The run is told, frozen into its spec.
  const spec = await (await get(app.handler, `/v1/runs/${runId}/spec`, runToken)).json();
  assertEquals(spec.workItem.canOpenPatches, false);

  // A runner that submits anyway is refused, whatever it hid from the agent.
  const submitted = await post(app.handler, `/v1/runs/${runId}/patches`, {
    branch: BRANCH(runId, repo.id),
    baseSha: "b".repeat(40),
  }, runToken);
  assertEquals(submitted.status, 400);
  assertStringIncludes((await submitted.json()).error, "may not open patches");
  // Nor does it get checks, which only exist to gate patches.
  const checks = await post(app.handler, `/v1/runs/${runId}/checks`, {}, runToken);
  assertEquals(checks.status, 409);
  assertStringIncludes((await checks.json()).error, "may not open patches");

  // And a result that names a branch still concludes the run, with no patch born from it.
  const reported = await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [BRANCH(runId, repo.id)],
    summary: "Audited the release branch.",
  }, runToken);
  assertEquals(reported.status, 200);
  assertEquals((await app.store.getRun(runId))!.state, "succeeded");
  assertEquals((await app.store.listPatches()).patches, []);
});

test("switching patches off stops a run already going, whatever it was started with", async () => {
  const app = buildApp();
  const repo = await connectRepo(app);
  const { runId, runToken } = await launchTask(app, repo.id);
  const run = (await app.store.getRun(runId))!;
  assertEquals(run.workItem.canOpenPatches, true);
  // Started by a person: attended, so its agent may wait for review.
  assertEquals("unattended" in run.workItem, false);
  const agent = (await app.store.getAgent(run.agentId))!;
  await app.store.setAgentCanOpenPatches(agent.id, true, false);

  const submitted = await post(app.handler, `/v1/runs/${runId}/patches`, {
    branch: BRANCH(runId, repo.id),
    baseSha: "b".repeat(40),
  }, runToken);
  assertEquals(submitted.status, 400);
  assertStringIncludes((await submitted.json()).error, "may not open patches");
  // Nor does the result it reports at the end.
  const reported = await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [BRANCH(runId, repo.id)],
    summary: "Done.",
  }, runToken);
  assertEquals(reported.status, 200);
  assertEquals((await app.store.listPatches()).patches, []);
});

test("a patch opened before its agent's patches were switched off waits until they are back on", async () => {
  const app = buildApp();
  const repo = await connectRepo(app);
  const { runId, runToken } = await launchTask(app, repo.id);
  await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [BRANCH(runId, repo.id)],
    summary: "Done.",
  }, runToken);
  const [pending] = (await app.store.listPatches()).patches;
  const agent = (await app.store.getAgent((await app.store.getRun(runId))!.agentId))!;
  await app.store.setAgentCanOpenPatches(agent.id, true, false);

  // It cannot be approved; it can still be rejected to clear the queue.
  const approved = await post(app.handler, `/v1/patches/${pending.id}/approve`);
  assertEquals(approved.status, 409);
  assertStringIncludes((await approved.json()).error, "may no longer open patches");

  // One already queued (approved while the switch was on) is held by the sweep, untouched...
  await app.store.setAgentCanOpenPatches(agent.id, false, true);
  assertEquals((await post(app.handler, `/v1/patches/${pending.id}/approve`)).status, 200);
  await app.store.setAgentCanOpenPatches(agent.id, true, false);
  const forge = app.forge as ReturnType<typeof noopForge>;
  const sweep = () =>
    sweepPatches(
      {
        store: app.store,
        forge,
        identityDirectory: app.identities.directory,
        diag: silentDiagnostics(),
        now: app.clock.now,
      },
      DEFAULT_PATCH_SUBMIT_CONFIG,
    );
  await sweep();
  assertEquals(forge.submissions.length, 0);
  assertEquals((await app.store.getPatch(pending.id))!.state, "queued");

  // A failed patch cannot be retried while the agent is locked either.
  const queued = (await app.store.getPatch(pending.id))!;
  await app.store.savePatch({ ...queued, state: "failed", nextAttemptAt: null });
  const retried = await post(app.handler, `/v1/patches/${pending.id}/retry`);
  assertEquals(retried.status, 409);
  assertStringIncludes((await retried.json()).error, "may no longer open patches");
  await app.store.savePatch(queued);

  // ...and goes on its way once the switch is back on: switching off is reversible.
  await app.store.setAgentCanOpenPatches(agent.id, false, true);
  await sweep();
  assertEquals(forge.submissions.length, 1);
});

test("a switch flipped while the sweep holds the lease hands the patch back as it was", async () => {
  const app = buildApp();
  const repo = await connectRepo(app);
  const { runId, runToken } = await launchTask(app, repo.id);
  await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [BRANCH(runId, repo.id)],
    summary: "Done.",
  }, runToken);
  const [pending] = (await app.store.listPatches()).patches;
  assertEquals((await post(app.handler, `/v1/patches/${pending.id}/approve`)).status, 200);
  const before = (await app.store.getPatch(pending.id))!;
  const agentId = (await app.store.getRun(runId))!.agentId;

  // The first agent read is the sweep's own check; the lock lands before the late one.
  let reads = 0;
  const store = {
    ...app.store,
    async getAgent(id: string) {
      if (++reads === 2) await app.store.setAgentCanOpenPatches(agentId, true, false);
      return await app.store.getAgent(id);
    },
  };
  const forge = app.forge as ReturnType<typeof noopForge>;
  await sweepPatches(
    {
      store,
      forge,
      identityDirectory: app.identities.directory,
      diag: silentDiagnostics(),
      now: app.clock.now,
    },
    DEFAULT_PATCH_SUBMIT_CONFIG,
  );
  assertEquals(forge.submissions.length, 0);
  const after = (await app.store.getPatch(pending.id))!;
  assertEquals([after.state, after.attempts, after.leaseExpiresAt], [
    "queued",
    before.attempts,
    before.leaseExpiresAt,
  ]);
});

test("a hand-back never writes over a lease another sweep has taken since", async () => {
  const app = buildApp();
  const repo = await connectRepo(app);
  const { runId, runToken } = await launchTask(app, repo.id);
  await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [BRANCH(runId, repo.id)],
    summary: "Done.",
  }, runToken);
  const [pending] = (await app.store.listPatches()).patches;
  assertEquals((await post(app.handler, `/v1/patches/${pending.id}/approve`)).status, 200);
  const agentId = (await app.store.getRun(runId))!.agentId;

  // The first agent read is the sweep's own check; the lock lands before the late one.
  let reads = 0;
  const store = {
    ...app.store,
    async getAgent(id: string) {
      if (++reads === 2) {
        await app.store.setAgentCanOpenPatches(agentId, true, false);
        // This sweep stalled past its lease; another reclaimed the patch and holds a new one.
        const held = (await app.store.getPatch(pending.id))!;
        await app.store.savePatch({ ...held, leaseExpiresAt: "2999-01-01T00:00:00.000Z" });
      }
      return await app.store.getAgent(id);
    },
  };
  const forge = app.forge as ReturnType<typeof noopForge>;
  await sweepPatches(
    {
      store,
      forge,
      identityDirectory: app.identities.directory,
      diag: silentDiagnostics(),
      now: app.clock.now,
    },
    DEFAULT_PATCH_SUBMIT_CONFIG,
  );
  assertEquals(forge.submissions.length, 0);
  const after = (await app.store.getPatch(pending.id))!;
  assertEquals([after.state, after.leaseExpiresAt], ["submitting", "2999-01-01T00:00:00.000Z"]);
});

test("an explicit submission on an auto-policy repo skips the human and submits on the next sweep", async () => {
  const app = buildApp();
  const repo = await connectRepo(app);
  const updated = await app.handler(
    new Request(`http://orchestrator.test/v1/connected-repos/${repo.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify({ submissionPolicy: "auto" }),
    }),
  );
  assertEquals(updated.status, 200);

  const { runId, runToken } = await launchTask(app, repo.id);
  const submitted = await post(app.handler, `/v1/runs/${runId}/patches`, {
    branch: BRANCH(runId, repo.id),
    baseSha: "b".repeat(40),
  }, runToken);
  assertEquals(submitted.status, 201);
  assertEquals((await submitted.json()).state, "queued");

  await sweepPatches(
    {
      store: app.store,
      forge: app.forge,
      identityDirectory: app.identities.directory,
      diag: silentDiagnostics(),
      now: app.clock.now,
    },
    DEFAULT_PATCH_SUBMIT_CONFIG,
  );
  assertEquals((await app.store.listPatches({ state: "submitted" })).patches.length, 1);
});

test("patch report names only the existing CR of this line and generation", async () => {
  const app = buildApp();
  const repo = await connectRepo(app);
  await patchJson(app.handler, `/v1/connected-repos/${repo.id}`, { submissionPolicy: "auto" });
  const { runId, runToken } = await launchTask(app, repo.id);
  const report = async (branch = BRANCH(runId, repo.id)) => {
    const res = await post(app.handler, `/v1/runs/${runId}/patches`, {
      branch,
      baseSha: "b".repeat(40),
    }, runToken);
    assert(res.ok);
    return await res.json();
  };
  const first = await report();
  assertEquals([first.forgeRef, first.forgeUrl], [null, null]);
  await sweepPatches({
    store: app.store,
    forge: app.forge,
    identityDirectory: app.identities.directory,
    diag: silentDiagnostics(),
    now: app.clock.now,
  }, DEFAULT_PATCH_SUBMIT_CONFIG);
  const opened = (await app.store.getPatch(first.patchId))!;
  assert(opened.forgeUrl !== null);
  // A duplicate adopts the submitted patch and carries its own URL.
  const adopted = await report();
  assertEquals([adopted.forgeRef, adopted.forgeUrl], [opened.forgeRef, opened.forgeUrl]);
  const revision = await report(BRANCH(runId, repo.id, "c".repeat(40)));
  assertEquals([revision.state, revision.forgeRef, revision.forgeUrl], [
    "queued",
    opened.forgeRef,
    opened.forgeUrl,
  ]);
  // Some forges retain an identity without a web address: still an update.
  await app.store.savePatch({ ...opened, forgeUrl: null });
  const urlLess = await report(BRANCH(runId, repo.id, "f".repeat(40)));
  assertEquals([urlLess.forgeRef, urlLess.forgeUrl], [opened.forgeRef, null]);
  const other = BRANCH(runId, repo.id, "d".repeat(40));
  assertEquals(
    (await report({ ...other, line: "fix", name: other.name.replace(/work$/, "fix") })).forgeRef,
    null,
  );
  const next = BRANCH(runId, repo.id, "e".repeat(40));
  const nextAnswer = await report({ ...next, generation: 2, name: `${next.name}-2` });
  assertEquals([nextAnswer.forgeRef, nextAnswer.forgeUrl], [null, null]);
});

for (const available of [true, false]) {
  test(`patch report resolves a targeted CR without an earlier patch (available=${available})`, async () => {
    const app = buildApp({
      forge: noopForge(silentDiagnostics(), {
        repos: [REPO_LISTING],
        ...(available ? {} : { thread: { kind: "unavailable" as const } }),
      }),
    });
    const repo = await connectRepo(app);
    const { runId, runToken } = await launchTask(app, repo.id);
    const run = (await app.store.getRun(runId))!;
    const task = (await app.store.getTask(run.taskId))!;
    await app.store.createTask({
      ...task,
      targetChangeRequest: { connectedRepoId: repo.id, thread: "7" },
    }, run);
    const res = await post(app.handler, `/v1/runs/${runId}/patches`, {
      branch: BRANCH(runId, repo.id),
      baseSha: "b".repeat(40),
    }, runToken);
    assertEquals(res.status, 201);
    const answer = await res.json();
    assertEquals(answer.state, "pending_approval");
    assertEquals(answer.forgeRef, "7");
    assertEquals(answer.forgeUrl, available ? "https://forge.invalid/acme/app/pull/7" : null);
  });
}

for (const finishing of ["finish asked", "agent finished", "finalizing"] as const) {
  test(`a submit once the run is finishing (${finishing}) waits for a person without the runner's word`, async () => {
    const app = buildApp();
    const repo = await connectRepo(app);
    assertEquals(
      (await patchJson(app.handler, `/v1/connected-repos/${repo.id}`, {
        submissionPolicy: "auto",
      })).status,
      200,
    );
    const { runId, runToken } = await launchTask(app, repo.id);
    if (finishing === "finish asked") {
      const at = (await app.store.getRun(runId))!.createdAt;
      await app.store.appendEvent({ runId, at, kind: "finish-requested" });
    } else {
      const beat = finishing === "agent finished"
        ? { seq: 0, phase: "running", finished: true }
        : { seq: 0, phase: "finalizing" };
      assertEquals(
        (await post(app.handler, `/v1/runs/${runId}/heartbeat`, beat, runToken)).ok,
        true,
      );
    }
    const submitted = await post(app.handler, `/v1/runs/${runId}/patches`, {
      branch: BRANCH(runId, repo.id),
      baseSha: "b".repeat(40),
    }, runToken);
    assertEquals(submitted.status, 201);
    assertEquals((await submitted.json()).state, "pending_approval");
  });
}

for (const answer of ["overlap", "unavailable"] as const) {
  test(`a submit the forge reads as holding another line's commits, or cannot read, waits for a person (${answer})`, async () => {
    const forge = noopForge(silentDiagnostics(), {
      permission: "allowed",
      repos: [REPO_LISTING],
      patchLineage: (ask) =>
        answer === "overlap"
          ? { kind: "answered", overlaps: ask.others.map((o) => o.line) }
          : { kind: "unavailable", message: "forge away" },
    });
    const app = buildApp({ forge });
    const repo = await connectRepo(app);
    assertEquals(
      (await patchJson(app.handler, `/v1/connected-repos/${repo.id}`, {
        submissionPolicy: "auto",
      })).status,
      200,
    );
    const { runId, runToken } = await launchTask(app, repo.id);
    // The run's first line goes out on its own: no other line to ask about.
    const other = { ...BRANCH(runId, repo.id, "c".repeat(40)), line: "b" };
    other.name = other.name.replace(/\/work$/, "/b");
    const first = await post(app.handler, `/v1/runs/${runId}/patches`, {
      branch: other,
      baseSha: "b".repeat(40),
    }, runToken);
    assertEquals((await first.json()).state, "queued");
    assertEquals(forge.lineageAsks, []);
    const second = await post(app.handler, `/v1/runs/${runId}/patches`, {
      branch: BRANCH(runId, repo.id),
      baseSha: "b".repeat(40),
    }, runToken);
    assertEquals(second.status, 201);
    const patch = (await app.store.getPatch((await second.json()).patchId))!;
    assertEquals(forge.lineageAsks.map((a) => a.others.map((o) => [o.line, o.headSha])), [[[
      "b",
      "c".repeat(40),
    ]]]);
    assertEquals(
      [patch.state, patch.heldReason],
      [
        "pending_approval",
        answer === "overlap" ? overlapReason(["b"]) : UNCONFIRMED_REASON,
      ],
    );
  });
}

test("finalization durably reports a pending patch before result; success never promotes it", async () => {
  const app = buildApp();
  const repo = await connectRepo(app);
  assertEquals(
    (await patchJson(app.handler, `/v1/connected-repos/${repo.id}`, {
      submissionPolicy: "auto",
    })).status,
    200,
  );
  const { runId, runToken } = await launchTask(app, repo.id);
  const branch = { ...BRANCH(runId, repo.id), baseSha: "b".repeat(40) };

  const reported = await post(app.handler, `/v1/runs/${runId}/patches`, {
    branch,
    baseSha: branch.baseSha,
    requiresApproval: true,
  }, runToken);
  assertEquals(reported.status, 201);
  const ack = await reported.json();
  assertEquals(ack.state, "pending_approval");
  const pending = (await app.store.getPatch(ack.patchId))!;
  assertEquals(pending.headSha, branch.headSha);
  assertEquals(pending.baseSha, branch.baseSha);
  assertEquals(pending.commits, branch.commits);
  assertEquals(pending.bundleKey, `${runId}/work/${repo.id}/${branch.headSha}.bundle`);
  assertEquals((await app.store.getRun(runId))!.result, null);

  // The patch is durable even if shutdown never gets as far as /result.
  await sweepPatches({
    store: app.store,
    forge: app.forge,
    identityDirectory: app.identities.directory,
    diag: silentDiagnostics(),
    now: app.clock.now,
  }, DEFAULT_PATCH_SUBMIT_CONFIG);
  assertEquals((app.forge as ReturnType<typeof noopForge>).submissions.length, 0);

  const result = await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [branch],
    summary: "done",
  }, runToken);
  assertEquals(result.status, 200);
  const patches = (await app.store.listPatches()).patches;
  assertEquals(patches.length, 1);
  assertEquals(patches[0].id, pending.id);
  assertEquals(patches[0].state, "pending_approval");
});

for (const requiresApproval of [undefined, false] as const) {
  test(`explicit submit with requiresApproval=${requiresApproval} stays auto; a newer finalize head is gated`, async () => {
    const app = buildApp();
    const repo = await connectRepo(app);
    assertEquals(
      (await patchJson(app.handler, `/v1/connected-repos/${repo.id}`, {
        submissionPolicy: "auto",
      })).status,
      200,
    );
    const { runId, runToken } = await launchTask(app, repo.id);
    const branch = BRANCH(runId, repo.id);
    const submitted = await post(app.handler, `/v1/runs/${runId}/patches`, {
      branch,
      baseSha: "b".repeat(40),
      ...(requiresApproval === undefined ? {} : { requiresApproval }),
    }, runToken);
    assertEquals(submitted.status, 201);
    const explicit = await submitted.json();
    assertEquals(explicit.state, "queued");

    // Finalization is not permission to publish commits made after an explicit submit.
    const newer = BRANCH(runId, repo.id, "c".repeat(40));
    const finalized = await post(app.handler, `/v1/runs/${runId}/patches`, {
      branch: newer,
      baseSha: "b".repeat(40),
      requiresApproval: true,
    }, runToken);
    assertEquals(finalized.status, 201);
    const leftover = await finalized.json();
    assertEquals(leftover.state, "pending_approval");
    assert(leftover.patchId !== explicit.patchId);
    assertEquals((await app.store.getPatch(explicit.patchId))!.state, "superseded");
    assertEquals((await app.store.getPatch(leftover.patchId))!.headSha, newer.headSha);

    assertEquals(
      (await post(app.handler, `/v1/runs/${runId}/result`, {
        status: "success",
        branches: [newer],
        summary: "done",
      }, runToken)).status,
      200,
    );
    assertEquals((await app.store.listPatches()).patches.length, 2);
    assertEquals((await app.store.getPatch(leftover.patchId))!.state, "pending_approval");
    await sweepPatches({
      store: app.store,
      forge: app.forge,
      identityDirectory: app.identities.directory,
      diag: silentDiagnostics(),
      now: app.clock.now,
    }, DEFAULT_PATCH_SUBMIT_CONFIG);
    assertEquals((app.forge as ReturnType<typeof noopForge>).submissions.length, 0);
  });
}

test("a newer finalize head cannot update an existing PR until approved", async () => {
  const app = buildApp();
  const repo = await connectRepo(app);
  assertEquals(
    (await patchJson(app.handler, `/v1/connected-repos/${repo.id}`, {
      submissionPolicy: "auto",
    })).status,
    200,
  );
  const { runId, runToken } = await launchTask(app, repo.id);
  const submitted = await post(app.handler, `/v1/runs/${runId}/patches`, {
    branch: BRANCH(runId, repo.id),
    baseSha: "b".repeat(40),
  }, runToken);
  assertEquals(submitted.status, 201);
  const explicit = await submitted.json();
  assertEquals(explicit.state, "queued");
  const forge = app.forge as ReturnType<typeof noopForge>;
  const deps = {
    store: app.store,
    forge,
    identityDirectory: app.identities.directory,
    diag: silentDiagnostics(),
    now: app.clock.now,
  };
  await sweepPatches(deps, DEFAULT_PATCH_SUBMIT_CONFIG);
  const opened = (await app.store.getPatch(explicit.patchId))!;
  assertEquals(opened.state, "submitted");
  assert(opened.forgeRef !== null);
  assertEquals(forge.submissions.length, 1);
  assertEquals(forge.submissions[0].changeRequest, undefined);

  const newer = BRANCH(runId, repo.id, "c".repeat(40));
  const finalized = await post(app.handler, `/v1/runs/${runId}/patches`, {
    branch: newer,
    baseSha: "b".repeat(40),
    requiresApproval: true,
  }, runToken);
  assertEquals(finalized.status, 201);
  const leftover = await finalized.json();
  assertEquals(leftover.state, "pending_approval");
  assert(leftover.patchId !== opened.id);

  await sweepPatches(deps, DEFAULT_PATCH_SUBMIT_CONFIG);
  assertEquals(forge.submissions.length, 1, "finalization must not update the already-open PR");
  assertEquals((await app.store.getPatch(leftover.patchId))!.state, "pending_approval");
  assertEquals((await app.store.getPatch(opened.id))!.state, "submitted");

  assertEquals((await post(app.handler, `/v1/patches/${leftover.patchId}/approve`)).status, 200);
  await sweepPatches(deps, DEFAULT_PATCH_SUBMIT_CONFIG);
  assertEquals(forge.submissions.length, 2);
  assertEquals(forge.submissions[1].changeRequest, opened.forgeRef);
  assertEquals(forge.submissions[1].headSha, newer.headSha);
  const updated = (await app.store.getPatch(leftover.patchId))!;
  assertEquals(updated.state, "submitted");
  assertEquals(updated.forgeRef, opened.forgeRef);
  assertEquals(updated.forgeUrl, opened.forgeUrl);
});

test("a failed finalize report leaves /result to preserve the work behind approval", async () => {
  const app = buildApp();
  const repo = await connectRepo(app);
  assertEquals(
    (await patchJson(app.handler, `/v1/connected-repos/${repo.id}`, {
      submissionPolicy: "auto",
    })).status,
    200,
  );
  const { runId, runToken } = await launchTask(app, repo.id);
  const branch = { ...BRANCH(runId, repo.id), baseSha: "b".repeat(40) };
  const createPatch = app.store.createPatch.bind(app.store);
  app.store.createPatch = () => Promise.reject(new Error("patch store unavailable"));
  try {
    await assertRejects(
      () =>
        post(app.handler, `/v1/runs/${runId}/patches`, {
          branch,
          baseSha: branch.baseSha,
          requiresApproval: true,
        }, runToken),
      Error,
      "patch store unavailable",
    );
  } finally {
    app.store.createPatch = createPatch;
  }
  assertEquals((await app.store.listPatches()).patches.length, 0);
  assertEquals((await app.store.getRun(runId))!.result, null);

  assertEquals(
    (await post(app.handler, `/v1/runs/${runId}/result`, {
      status: "success",
      branches: [branch],
      summary: "done despite the report failure",
    }, runToken)).status,
    200,
  );
  const patches = (await app.store.listPatches()).patches;
  assertEquals(patches.length, 1);
  assertEquals(patches[0].state, "pending_approval");
  assertEquals(patches[0].headSha, branch.headSha);
  assertEquals(patches[0].baseSha, branch.baseSha);
  assertEquals(patches[0].bundleKey, `${runId}/work/${repo.id}/${branch.headSha}.bundle`);
});

for (const door of ["patches", "result"] as const) {
  test(`cancellation gates new auto-policy work through /${door}, even before the run stops`, async () => {
    const app = buildApp();
    const repo = await connectRepo(app);
    assertEquals(
      (await patchJson(app.handler, `/v1/connected-repos/${repo.id}`, {
        submissionPolicy: "auto",
      })).status,
      200,
    );
    const { taskId, runId, runToken } = await launchTask(app, repo.id);
    assertEquals((await post(app.handler, `/v1/tasks/${taskId}/cancel`)).status, 202);
    assertEquals((await app.store.getRun(runId))!.desiredState, "cancelled");

    const branch = BRANCH(runId, repo.id);
    const body = door === "patches"
      ? { branch, baseSha: "b".repeat(40) }
      : { status: "success", branches: [branch], summary: "finished while stopping" };
    const reported = await post(app.handler, `/v1/runs/${runId}/${door}`, body, runToken);
    assertEquals(reported.status, door === "patches" ? 201 : 200);
    if (door === "patches") assertEquals((await reported.json()).state, "pending_approval");

    const patches = (await app.store.listPatches()).patches;
    assertEquals(patches.length, 1, "cancellation must not discard the reported work");
    assertEquals(patches[0].state, "pending_approval");
    assertEquals(patches[0].headSha, branch.headSha);
    assertEquals(patches[0].commits, branch.commits);
    assertEquals(patches[0].bundleKey, `${runId}/work/${repo.id}/${branch.headSha}.bundle`);

    if (door === "patches") {
      // Shutdown reports the same branch again: adopt the explicit submit, never create
      // a second patch or promote the preserved work out of its approval gate.
      const result = await post(app.handler, `/v1/runs/${runId}/result`, {
        status: "cancelled",
        branches: [branch],
        summary: "stopped after saving work",
      }, runToken);
      assertEquals(result.status, 200);
      const afterResult = (await app.store.listPatches()).patches;
      assertEquals(afterResult.length, 1);
      assertEquals(afterResult[0].id, patches[0].id);
      assertEquals(afterResult[0].state, "pending_approval");
    }

    await sweepPatches(
      {
        store: app.store,
        forge: app.forge,
        identityDirectory: app.identities.directory,
        diag: silentDiagnostics(),
        now: app.clock.now,
      },
      DEFAULT_PATCH_SUBMIT_CONFIG,
    );
    assertEquals((app.forge as ReturnType<typeof noopForge>).submissions.length, 0);
    assertEquals((await app.store.getPatch(patches[0].id))!.state, "pending_approval");

    // A person can still choose to publish the saved work.
    assertEquals((await post(app.handler, `/v1/patches/${patches[0].id}/approve`)).status, 200);
  });
}

for (const door of ["patches", "result"] as const) {
  test(`/${door} observes cancellation persisted after its authentication read`, async () => {
    const app = buildApp();
    const repo = await connectRepo(app);
    assertEquals(
      (await patchJson(app.handler, `/v1/connected-repos/${repo.id}`, {
        submissionPolicy: "auto",
      })).status,
      200,
    );
    const { taskId, runId, runToken } = await launchTask(app, repo.id);
    const read = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const getRun = app.store.getRun.bind(app.store);
    app.store.getRun = async (id) => {
      const snapshot = await getRun(id);
      app.store.getRun = getRun;
      read.resolve();
      await resume.promise;
      return snapshot;
    };
    const branch = {
      ...BRANCH(runId, repo.id),
      name: `ryph/ada/${runId}/work-2`,
      baseSha: "b".repeat(40),
      generation: 2,
    };
    const reporting = post(
      app.handler,
      `/v1/runs/${runId}/${door}`,
      door === "patches"
        ? { branch, baseSha: branch.baseSha }
        : { status: "success", branches: [branch], summary: "done" },
      runToken,
    );
    await read.promise;
    try {
      assertEquals((await post(app.handler, `/v1/tasks/${taskId}/cancel`)).status, 202);
    } finally {
      resume.resolve();
    }
    assertEquals((await reporting).status, door === "patches" ? 201 : 200);
    const savedRun = await getRun(runId);
    assertEquals(savedRun!.desiredState, "cancelled");
    assert(savedRun!.cancelRequestedAt !== null);
    const patches = (await app.store.listPatches()).patches;
    assertEquals(patches.length, 1);
    assertEquals(patches[0].state, "pending_approval");
    assertEquals(patches[0].baseSha, branch.baseSha);
    assertEquals(patches[0].generation, 2);
    await sweepPatches({
      store: app.store,
      forge: app.forge,
      identityDirectory: app.identities.directory,
      diag: silentDiagnostics(),
      now: app.clock.now,
    }, DEFAULT_PATCH_SUBMIT_CONFIG);
    assertEquals((app.forge as ReturnType<typeof noopForge>).submissions.length, 0);
  });
}

for (const status of ["success", "failure", "error", "cancelled"] as const) {
  test(`an auto-policy repo gates a ${status} result without prior cancellation intent`, async () => {
    const app = buildApp();
    const repo = await connectRepo(app);
    const updated = await app.handler(
      new Request(`http://orchestrator.test/v1/connected-repos/${repo.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: "Bearer t" },
        body: JSON.stringify({ submissionPolicy: "auto" }),
      }),
    );
    assertEquals(updated.status, 200);

    const { runId, runToken } = await launchTask(app, repo.id);
    assert((await app.store.getRun(runId))!.desiredState !== "cancelled");
    const reported = await post(app.handler, `/v1/runs/${runId}/result`, {
      status,
      reason: "the engine stopped mid-transcript",
      during: "running",
      branches: [BRANCH(runId, repo.id)],
      summary: "half of it",
    }, runToken);
    assertEquals(reported.status, 200);

    const waiting = (await app.store.listPatches({ state: "pending_approval" })).patches;
    assertEquals(waiting.length, 1, "the commits are kept as a patch");

    await sweepPatches(
      {
        store: app.store,
        forge: app.forge,
        identityDirectory: app.identities.directory,
        diag: silentDiagnostics(),
        now: app.clock.now,
      },
      DEFAULT_PATCH_SUBMIT_CONFIG,
    );
    assertEquals(
      (app.forge as ReturnType<typeof noopForge>).submissions.length,
      0,
      "nothing reaches the forge unread",
    );
    assertEquals((await app.store.getPatch(waiting[0].id))!.state, "pending_approval");

    // The human gate still works from here — it is a normal pending patch.
    assertEquals((await post(app.handler, `/v1/patches/${waiting[0].id}/approve`)).status, 200);
  });
}

test("rejection is terminal; a failed submission retries on its clock", async () => {
  // A forge that refuses twice (retryable), then succeeds.
  let failures = 2;
  const flaky: Forge = {
    providers: () =>
      Promise.resolve({
        providers: ["github"],
        github: { mode: "app", signIn: true },
        gitlab: null,
        radicle: null,
      }),
    checkPatchHooks: () => Promise.resolve({ kind: "refused", message: "not local" }),
    submitPatch: () =>
      Promise.resolve(
        failures-- > 0
          ? { kind: "failed", message: "GitHub answered 502", terminal: false }
          : { kind: "submitted", ref: "9", url: "https://gh/acme/app/pull/9" },
      ),
    postComment: () => Promise.resolve({ commentId: "1001" }),
    updateComment: () => Promise.resolve(),
    addReaction: () => Promise.resolve(),
    checkPermission: () => Promise.resolve("allowed"),
    fetchThread: () => Promise.resolve({ kind: "unavailable" }), // no thread in this flow
    fetchChangeRequestHead: () => Promise.resolve({ kind: "unavailable" }),
    mergeContainment: () => Promise.resolve({ kind: "unavailable", message: "not this flow" }),
    patchLineage: () => Promise.resolve({ kind: "unavailable", message: "not this flow" }),
    repoVisibility: () => Promise.resolve("unknown"),
    readServicesFile: () => Promise.resolve({ kind: "absent" as const }),
    ...NO_ENVIRONMENT_READS,
  };
  const app = buildApp({ forge: flaky });
  const repo = await connectRepo(app);

  // Reject path first: a second task's patch, read and declined.
  {
    const { runId, runToken } = await launchTask(app, repo.id);
    await post(app.handler, `/v1/runs/${runId}/result`, {
      status: "success",
      branches: [BRANCH(runId, repo.id, "b".repeat(40))],
      summary: "meh",
    }, runToken);
    const patch = (await app.store.listPatches({ state: "pending_approval" })).patches[0];
    const rejected = await post(app.handler, `/v1/patches/${patch.id}/reject`);
    assertEquals((await rejected.json()).patch.state, "rejected");
    // Terminal: approve now refuses.
    assertEquals((await post(app.handler, `/v1/patches/${patch.id}/approve`)).status, 409);
  }

  // Retry path: approve, fail twice on the clock, succeed on the third sweep.
  const { runId, runToken } = await launchTask(app, repo.id);
  await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [BRANCH(runId, repo.id)],
    summary: "ok",
  }, runToken);
  const patch = (await app.store.listPatches({ state: "pending_approval" })).patches[0];
  await post(app.handler, `/v1/patches/${patch.id}/approve`);

  const deps = {
    store: app.store,
    forge: flaky,
    identityDirectory: app.identities.directory,
    diag: silentDiagnostics(),
    now: app.clock.now,
  };
  await sweepPatches(deps, DEFAULT_PATCH_SUBMIT_CONFIG); // attempt 1: fails, clock set
  let current = (await app.store.getPatch(patch.id))!;
  assertEquals(current.state, "failed");
  assertEquals(current.attempts, 1);
  assertStringIncludes(current.lastError!, "502");

  await sweepPatches(deps, DEFAULT_PATCH_SUBMIT_CONFIG); // clock not due: nothing happens
  assertEquals((await app.store.getPatch(patch.id))!.state, "failed");

  app.clock.advance(DEFAULT_PATCH_SUBMIT_CONFIG.baseBackoffMs + 1);
  await sweepPatches(deps, DEFAULT_PATCH_SUBMIT_CONFIG); // requeued
  await sweepPatches(deps, DEFAULT_PATCH_SUBMIT_CONFIG); // attempt 2: fails again
  current = (await app.store.getPatch(patch.id))!;
  assertEquals(current.attempts, 2);

  app.clock.advance(DEFAULT_PATCH_SUBMIT_CONFIG.baseBackoffMs * 2 + 1);
  await sweepPatches(deps, DEFAULT_PATCH_SUBMIT_CONFIG); // requeue
  await sweepPatches(deps, DEFAULT_PATCH_SUBMIT_CONFIG); // attempt 3: lands
  assertEquals((await app.store.getPatch(patch.id))!.state, "submitted");
});

test("a repo's command allowlist: admin-gated, idempotent, and keyed by the repo's forge", async () => {
  // Nothing reads it on the command path yet — the Radicle authorization path is what will —
  // so what this proves is that it is STORED, per repo and per forge, behind the same admin bar
  // as every other change to the connection itself.
  const app = buildApp();
  const repo = await connectRepo(app);
  const path = `/v1/connected-repos/${repo.id}/command-allowlist`;

  assertEquals((await (await get(app.handler, path)).json()).entries, []);
  const added = await post(app.handler, path, { subject: "did:key:zAlice" });
  assertEquals(added.status, 201);
  assertEquals((await added.json()).entries, [{
    connectedRepoId: repo.id,
    provider: "github",
    subject: "did:key:zAlice",
    addedBy: "u-1",
    createdAt: app.clock.now().toISOString(),
  }]);
  // Adding twice is adding once.
  await (await post(app.handler, path, { subject: "did:key:zAlice" })).body?.cancel();
  assertEquals((await (await get(app.handler, path)).json()).entries.length, 1);

  const removed = await handlerDelete(app.handler, `${path}/did%3Akey%3AzAlice`);
  assertEquals(removed.status, 200);
  assertEquals((await removed.json()).entries, []);

  // The admin bar: the forge says no, so the allowlist says nothing. The row goes in through
  // the store, because connecting it would need the admin this caller does not have.
  const denied = buildApp({ permission: "denied" });
  await denied.store.createConnectedRepo({ ...repo, id: "cr-theirs" });
  assertEquals(
    (await get(denied.handler, "/v1/connected-repos/cr-theirs/command-allowlist")).status,
    403,
  );
  assertEquals(
    (await post(denied.handler, "/v1/connected-repos/cr-theirs/command-allowlist", {
      subject: "mallory",
    })).status,
    403,
  );
});

test("the permission gate: denied denies, unknown denies, no identity instructs", async () => {
  // No linked identity yet: instructive 403.
  {
    const app = buildApp();
    await post(app.handler, "/v1/installations", { installationId: "42" });
    // Connect needs admin, and the identity comes first.
    const res = await post(app.handler, "/v1/connected-repos", {
      installationId: "42",
      repoRef: "acme/app",
    });
    assertEquals(res.status, 403);
    assertStringIncludes((await res.json()).error, "link your GitHub account");
  }
  // GitHub says no.
  {
    const app = buildApp({ permission: "denied" });
    app.identities.link(USER.userId, "noop-mallory");
    await post(app.handler, "/v1/installations", { installationId: "42" });
    const res = await post(app.handler, "/v1/connected-repos", {
      installationId: "42",
      repoRef: "acme/app",
    });
    assertEquals(res.status, 403);
    assertStringIncludes((await res.json()).error, "does not have admin access");
  }
  // GitHub didn't answer: unknown is DENIED — the phase-2 resilience deferral.
  {
    const app = buildApp({ permission: "unknown" });
    app.identities.link(USER.userId, "noop-ada");
    await post(app.handler, "/v1/installations", { installationId: "42" });
    const res = await post(app.handler, "/v1/connected-repos", {
      installationId: "42",
      repoRef: "acme/app",
    });
    assertEquals(res.status, 403);
    assertStringIncludes((await res.json()).error, "treated as denied");
  }
});

test("losing repo access closes every door that reaches it, patch queue included", async () => {
  // The verdict is read per call, so flipping it mid-test is exactly "access was revoked".
  const opts: { permission: ForgePermission; repos: typeof REPO_LISTING[] } = {
    permission: "allowed",
    repos: [REPO_LISTING],
  };
  const app = buildApp({ forge: noopForge(silentDiagnostics(), opts) });
  const repo = await connectRepo(app);
  const { runId, runToken } = await launchTask(app, repo.id);
  await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [BRANCH(runId, repo.id)],
    summary: "Pinned the clock.",
  }, runToken);
  const patch = (await (await get(app.handler, "/v1/patches?state=pending_approval")).json())
    .patches[0];

  opts.permission = "denied";

  // Approving is what pushes a branch and opens the PR — it answers to write on the repo.
  const approved = await post(app.handler, `/v1/patches/${patch.id}/approve`);
  assertEquals(approved.status, 403);
  assertStringIncludes((await approved.json()).error, "does not have write access");
  assertEquals((await app.store.getPatch(patch.id))!.state, "pending_approval");

  // And nothing reached the forge: the gate runs before the transition, not after.
  assertEquals((app.forge as ReturnType<typeof noopForge>).submissions.length, 0);

  // Relaxing the policy would retire the gate for every future patch — admin, like connect.
  const relaxed = await patchJson(app.handler, `/v1/connected-repos/${repo.id}`, {
    submissionPolicy: "auto",
  });
  assertEquals(relaxed.status, 403);
  assertStringIncludes((await relaxed.json()).error, "does not have admin access");
  assertEquals((await app.store.getConnectedRepo(repo.id))!.submissionPolicy, "require-approval");

  // Disconnecting undoes the connect, and answers to the same bar.
  const archived = await post(app.handler, `/v1/connected-repos/${repo.id}/archive`);
  assertEquals(archived.status, 403);
  assertEquals((await app.store.getConnectedRepo(repo.id))!.archivedAt, null);

  // Retry is the same reach as approve, from the other end of the lifecycle.
  await app.store.savePatch({ ...(await app.store.getPatch(patch.id))!, state: "failed" });
  assertEquals((await post(app.handler, `/v1/patches/${patch.id}/retry`)).status, 403);
  assertEquals((await app.store.getPatch(patch.id))!.state, "failed");

  // A regained permission reopens them — the check is live, never mirrored onto the row.
  opts.permission = "allowed";
  assertEquals((await post(app.handler, `/v1/patches/${patch.id}/retry`)).status, 200);
  assertEquals((await app.store.getPatch(patch.id))!.state, "queued");
});

test("break-glass: no permission check, but a positive audit trail everywhere", async () => {
  const app = buildApp({ caller: BREAK_GLASS, permission: "denied" }); // denied would stop a user
  const repo = await connectRepo0(app);
  const { taskId, runId, runToken } = await launchTask(app, repo.id);

  assertEquals((await app.store.getTask(taskId))!.origin, "break-glass");

  await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [BRANCH(runId, repo.id)],
    summary: "done",
  }, runToken);
  const patch = (await app.store.listPatches({ state: "pending_approval" })).patches[0];
  await post(app.handler, `/v1/patches/${patch.id}/approve`);
  assertEquals((await app.store.getPatch(patch.id))!.approvedBy, { kind: "break-glass" });

  const forge = app.forge as ReturnType<typeof noopForge>;
  await sweepPatches(
    {
      store: app.store,
      forge,
      identityDirectory: app.identities.directory,
      diag: silentDiagnostics(),
      now: app.clock.now,
    },
    DEFAULT_PATCH_SUBMIT_CONFIG,
  );
  assertStringIncludes(forge.submissions[0].body, "break-glass API access");
});

/** connectRepo without the identity-link step — break-glass has no user to link. */
async function connectRepo0(app: ReturnType<typeof buildApp>) {
  await post(app.handler, "/v1/installations", { installationId: "42" });
  const connected = await post(app.handler, "/v1/connected-repos", {
    installationId: "42",
    repoRef: "acme/app",
  });
  assertEquals(connected.status, 201);
  return await connected.json();
}

test("the same head adopts the existing patch; other tasks' patches are untouched", async () => {
  // (Same-task supersede — a retry run replacing a waiting patch — is covered purely in
  // patch_lifecycle_test; tasks are 1:1 with runs today, so it cannot be driven end to end
  // until retry runs exist.)
  const app = buildApp();
  const repo = await connectRepo(app);

  const first = await launchTask(app, repo.id);
  await post(app.handler, `/v1/runs/${first.runId}/result`, {
    status: "success",
    branches: [BRANCH(first.runId, repo.id, "c".repeat(40))],
    summary: "v1",
  }, first.runToken);
  const firstPatch = (await app.store.listPatches({ state: "pending_approval" })).patches[0];

  // A fresh run reproducing the SAME head on the same repo adopts rather than duplicates —
  // the (connectedRepoId, headSha) idempotency at birth.
  const second = await launchTask(app, repo.id);
  await post(app.handler, `/v1/runs/${second.runId}/result`, {
    status: "success",
    branches: [BRANCH(second.runId, repo.id, "c".repeat(40))],
    summary: "same bytes",
  }, second.runToken);
  assertEquals((await app.store.listPatches()).patches.length, 1, "same head adopts");

  // A different head from a different task opens its own patch and leaves the first alone.
  const third = await launchTask(app, repo.id);
  await post(app.handler, `/v1/runs/${third.runId}/result`, {
    status: "success",
    branches: [BRANCH(third.runId, repo.id, "d".repeat(40))],
    summary: "v2",
  }, third.runToken);
  assertEquals((await app.store.listPatches()).patches.length, 2);
  assertEquals((await app.store.getPatch(firstPatch.id))!.state, "pending_approval");
});

test("concurrent submit sweeps deliver each patch exactly once", async () => {
  // The race the lease was believed to cover but did not: `sweepPatches` iterates a snapshot
  // taken at the top, and `markSubmitting` checks THAT COPY's state. So a sweep still working
  // through its list can reach a patch a second sweep already took, find "queued" on its stale
  // copy, and deliver it again. At one replica the second sweep is the next reaper tick firing
  // while a slow forge call is still in flight (setInterval never awaits); at N>1 it is simply
  // two replicas sweeping at once, with no slowness needed at all.
  let releaseFirst!: () => void;
  const firstCallEntered = Promise.withResolvers<void>();
  const gate = new Promise<void>((resolve) => (releaseFirst = resolve));

  const inner = noopForge(silentDiagnostics(), { repos: [REPO_LISTING] });
  const submittedBranches: string[] = [];
  let calls = 0;
  const forge: Forge = {
    ...inner,
    async submitPatch(submission) {
      submittedBranches.push(submission.branchName);
      // Only the first delivery blocks — long enough for a second sweep to run to completion.
      if (++calls === 1) {
        firstCallEntered.resolve();
        await gate;
      }
      return await inner.submitPatch(submission);
    },
  };

  const app = buildApp({ forge });
  const repo = await connectRepo(app);

  // Two approved patches, so a sweep has a second entry to reach after the slow first one.
  const branches: string[] = [];
  for (const sha of ["a".repeat(40), "b".repeat(40)]) {
    const { runId, runToken } = await launchTask(app, repo.id);
    await post(app.handler, `/v1/runs/${runId}/result`, {
      status: "success",
      branches: [BRANCH(runId, repo.id, sha)],
      summary: "ok",
    }, runToken);
    const pending = (await app.store.listPatches({ state: "pending_approval" })).patches[0];
    await post(app.handler, `/v1/patches/${pending.id}/approve`);
    branches.push(BRANCH(runId, repo.id, sha).name);
  }
  assertEquals((await app.store.listPatches({ state: "queued" })).patches.length, 2);

  const deps = {
    store: app.store,
    forge,
    identityDirectory: app.identities.directory,
    diag: silentDiagnostics(),
    now: app.clock.now,
  };

  const slow = sweepPatches(deps, DEFAULT_PATCH_SUBMIT_CONFIG);
  await firstCallEntered.promise; // the first sweep is inside the forge call for patch #1
  await sweepPatches(deps, DEFAULT_PATCH_SUBMIT_CONFIG); // the overlapping sweep takes patch #2
  releaseFirst();
  await slow; // ...and now the first sweep walks on to patch #2 from its STALE snapshot

  // Each branch delivered once. Without the conditional claim the second branch goes twice.
  assertEquals(submittedBranches.length, 2);
  assertEquals([...submittedBranches].sort(), [...branches].sort());
  for (const patch of (await app.store.listPatches({ state: "submitted" })).patches) {
    assertEquals(patch.attempts, 1); // one attempt burned per patch, not two
  }
});

// ---------------------------------------------------------------------------
// What memory is told about a patch that never reaches the forge — and what happens when the
// telling is lost. Both live here because both need the whole flow behind them: only a real
// patch, born of a real result on a connected repo, has a run whose claims are waiting.
// ---------------------------------------------------------------------------

const SWEEP_CFG = {
  heartbeatTimeoutMs: 60_000,
  startupGraceMs: 300_000,
  cancelGraceMs: 120_000,
  idleGraceMs: 60_000,
};

/** A forge that refuses every submission, terminally or not. */
const refusingForge = (terminal: boolean): Forge => ({
  providers: () =>
    Promise.resolve({
      providers: ["github"],
      github: { mode: "app", signIn: true },
      gitlab: null,
      radicle: null,
    }),
  checkPatchHooks: () => Promise.resolve({ kind: "refused", message: "not local" }),
  submitPatch: () => Promise.resolve({ kind: "failed", message: "GitHub answered 403", terminal }),
  postComment: () => Promise.resolve({ commentId: "1001" }),
  updateComment: () => Promise.resolve(),
  addReaction: () => Promise.resolve(),
  checkPermission: () => Promise.resolve("allowed"),
  fetchThread: () => Promise.resolve({ kind: "unavailable" }),
  fetchChangeRequestHead: () => Promise.resolve({ kind: "unavailable" }),
  mergeContainment: () => Promise.resolve({ kind: "unavailable", message: "not this flow" }),
  patchLineage: () => Promise.resolve({ kind: "unavailable", message: "not this flow" }),
  readServicesFile: () => Promise.resolve({ kind: "absent" as const }),
  repoVisibility: () => Promise.resolve("unknown"),
  ...NO_ENVIRONMENT_READS,
});

/** The environment reads, which no patch flow reaches. */
const NO_ENVIRONMENT_READS: Pick<
  Forge,
  "ryphTree" | "ryphBase" | "defaultBranchHead" | "branchKind"
> = {
  ryphTree: () => Promise.reject(new Error("not part of this flow")),
  ryphBase: () => Promise.reject(new Error("not part of this flow")),
  defaultBranchHead: () => Promise.reject(new Error("not part of this flow")),
  branchKind: () => Promise.reject(new Error("not part of this flow")),
};

/** A memory that records what it is told, and may refuse the first n change reports. */
function recordingMemory(refusals = 0) {
  const changes: Array<{ runId: string; fate: string }> = [];
  const carried: Array<{ patchId: string; carries: string[] }> = [];
  let left = refusals;
  const memoryAccess = {
    reportOutcome: () => Promise.resolve(),
    reportPatch: () => Promise.resolve(),
    reportChange(runId: string, patchId: string, fate: string, carries: string[]) {
      if (left-- > 0) return Promise.reject(new Error("memory is down"));
      changes.push({ runId, fate });
      carried.push({ patchId, carries });
      return Promise.resolve();
    },
  } as unknown as MemoryAccess;
  return { memoryAccess, changes, carried };
}

/** Connect, run, report a branch, approve — a patch sitting in `queued`, ready to be swept. */
async function queuedPatch(app: ReturnType<typeof buildApp>) {
  const repo = await connectRepo(app);
  const { runId, runToken } = await launchTask(app, repo.id);
  await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [BRANCH(runId, repo.id)],
    summary: "ok",
  }, runToken);
  const patch = (await app.store.listPatches({ state: "pending_approval" })).patches[0];
  await post(app.handler, `/v1/patches/${patch.id}/approve`);
  return { patchId: patch.id, runId };
}

test("a submission that fails past retrying tells memory the change was dropped", async () => {
  const app = buildApp({ forge: refusingForge(true) });
  const { patchId, runId } = await queuedPatch(app);
  const { memoryAccess, changes } = recordingMemory();
  const deps = {
    store: app.store,
    forge: app.forge,
    identityDirectory: app.identities.directory,
    diag: silentDiagnostics(),
    memoryAccess,
    now: app.clock.now,
  };

  await sweepPatches(deps, DEFAULT_PATCH_SUBMIT_CONFIG);
  const failed = (await app.store.getPatch(patchId))!;
  assertEquals(failed.state, "failed");
  assertEquals(failed.nextAttemptAt, null, "terminal: no clock, so nothing moves it but a human");
  // The run's `introduced` claims were waiting on this patch. Nothing else would ever ask.
  assertEquals(changes, [{ runId, fate: "dropped" }]);
  assertEquals(failed.memoryFateReportedAt, app.clock.now().toISOString());

  // And the reconciliation has nothing left to do: the acknowledgement is what it reads.
  await sweep({ ...deps, provisioner: fakeProvisioner().provisioner }, SWEEP_CFG);
  assertEquals(changes.length, 1);
});

test("a retryable failure tells memory nothing — the next sweep is still coming", async () => {
  const app = buildApp({ forge: refusingForge(false) });
  const { patchId } = await queuedPatch(app);
  const { memoryAccess, changes } = recordingMemory();
  const deps = {
    store: app.store,
    forge: app.forge,
    identityDirectory: app.identities.directory,
    diag: silentDiagnostics(),
    memoryAccess,
    now: app.clock.now,
  };
  await sweepPatches(deps, DEFAULT_PATCH_SUBMIT_CONFIG);
  const failed = (await app.store.getPatch(patchId))!;
  assert(failed.nextAttemptAt !== null, "a retryable failure sets a clock");
  assertEquals(changes, [], "settling memory between two attempts would settle it wrongly");
  // Nor does the reconciliation jump the gun on a patch that is still in flight.
  await sweep({ ...deps, provisioner: fakeProvisioner().provisioner }, SWEEP_CFG);
  assertEquals(changes, []);
  assertEquals((await app.store.getPatch(patchId))!.memoryFateReportedAt, null);
});

test("a fate memory never heard is redelivered by the reaper, and only until it lands", async () => {
  const app = buildApp({ forge: refusingForge(true) });
  const { patchId, runId } = await queuedPatch(app);
  // The first report is lost — a restart, a 503, a dropped connection. Every relay is
  // best-effort, so nothing throws and nothing retries at the call site.
  const { memoryAccess, changes } = recordingMemory(1);
  const deps = {
    store: app.store,
    forge: app.forge,
    identityDirectory: app.identities.directory,
    diag: silentDiagnostics(),
    memoryAccess,
    now: app.clock.now,
  };
  await sweepPatches(deps, DEFAULT_PATCH_SUBMIT_CONFIG);
  assertEquals(changes, []);
  assertEquals(
    (await app.store.getPatch(patchId))!.memoryFateReportedAt,
    null,
    "unacknowledged: without this the proposals wait in the inbox forever",
  );

  // The reaper's pass finds exactly that gap and redelivers.
  const reaperDeps = { ...deps, provisioner: fakeProvisioner().provisioner };
  app.clock.advance(10_000);
  await sweep(reaperDeps, SWEEP_CFG);
  assertEquals(changes, [{ runId, fate: "dropped" }]);
  assertEquals(
    (await app.store.getPatch(patchId))!.memoryFateReportedAt,
    app.clock.now().toISOString(),
  );

  // And stops: a second pass is a no-op, so redelivery cannot become a loop.
  await sweep(reaperDeps, SWEEP_CFG);
  assertEquals(changes.length, 1);
});

/** A connected repo with one patch pending on it, born from a run's result. */
test("what a patch carries is mapped from the runner's heads onto the run's patches, and told with its fate", async () => {
  const app = buildApp({ forge: refusingForge(true) });
  const repo = await connectRepo(app);
  const { runId, runToken } = await launchTask(app, repo.id);
  const submit = async (sha: string, carries: string[]) => {
    const born = await post(app.handler, `/v1/runs/${runId}/patches`, {
      branch: { ...BRANCH(runId, repo.id, sha), carries },
      baseSha: "0".repeat(40),
    }, runToken);
    assertEquals(born.status, 201, await born.clone().text());
    return (await born.json()).patchId as string;
  };
  const first = await submit("a".repeat(40), []);
  // A head no patch of this run carries (an unreported submit) names nothing.
  const second = await submit("b".repeat(40), ["a".repeat(40), "f".repeat(40)]);
  const row = (await app.store.getPatch(second))!;
  assertEquals(row.carries, [first]);
  assertEquals((await app.store.getPatch(first))!.carries, []);

  // The fate report says it again: it is the relay the reaper makes sure lands.
  await post(app.handler, `/v1/patches/${second}/approve`);
  const { memoryAccess, carried } = recordingMemory();
  await sweepPatches({
    store: app.store,
    forge: app.forge,
    identityDirectory: app.identities.directory,
    diag: silentDiagnostics(),
    memoryAccess,
    now: app.clock.now,
  }, DEFAULT_PATCH_SUBMIT_CONFIG);
  assertEquals(carried, [{ patchId: second, carries: [first] }]);
});

async function pendingPatch(app: ReturnType<typeof buildApp>) {
  const repo = await connectRepo(app);
  const { runId, runToken } = await launchTask(app, repo.id);
  await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [BRANCH(runId, repo.id)],
    summary: "Pinned the clock.",
  }, runToken);
  const patch = (await (await get(app.handler, "/v1/patches?state=pending_approval")).json())
    .patches[0];
  return { repo, runId, patch };
}

test("a patch reads by id, and its diff comes from the forge against where it lands", async () => {
  const asks: PatchDiffAsk[] = [];
  const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";
  const forge = noopForge(silentDiagnostics(), {
    repos: [REPO_LISTING],
    patchDiff: (ask) => {
      asks.push(ask);
      return {
        kind: "diff",
        diff,
        baseSha: "b".repeat(40),
        headSha: ask.headSha,
        truncated: false,
        omitted: [],
        moreOmitted: false,
      };
    },
  });
  const app = buildApp({ forge });
  const { repo, runId, patch } = await pendingPatch(app);

  // The same shape as a row of the queue.
  const one = await get(app.handler, `/v1/patches/${patch.id}`);
  assertEquals(one.status, 200);
  assertEquals((await one.json()).patch, patch);

  const res = await get(app.handler, `/v1/patches/${patch.id}/diff`);
  assertEquals(res.status, 200);
  // Asked again each time, and never kept by anything shared.
  assertEquals(res.headers.get("cache-control"), "private, no-cache");
  assertEquals(await res.json(), {
    diff,
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
    truncated: false,
    omitted: [],
    moreOmitted: false,
    sincePatchId: null,
    mode: "live",
    targetRef: "main",
  });
  // Everything the forge is told comes off the rows: the bundle intake filed, and the branch the
  // submission would land it on (core/patch_lifecycle.ts `submissionTarget`).
  assertEquals(asks, [{
    connectedRepoId: repo.id,
    bundleKey: `${runId}/work/${repo.id}/${"a".repeat(40)}.bundle`,
    branchName: `ryph/ada/${runId}/work`,
    headSha: "a".repeat(40),
    baseSha: null,
    // Not yet published, and the task targets no change request: measured against main, where
    // a fresh one would be opened.
    targetRef: "main",
    mode: "live",
  }]);
});

test("a later patch pushed onto an earlier one's change request is measured against its branch", async () => {
  const asks: PatchDiffAsk[] = [];
  // Where the diff is measured from: a force-push of the branch it lands on moves it.
  let base = "b".repeat(40);
  const forge = noopForge(silentDiagnostics(), {
    repos: [REPO_LISTING],
    patchDiff: (ask) => {
      asks.push(ask);
      return {
        kind: "diff",
        diff: "",
        baseSha: base,
        headSha: ask.headSha,
        truncated: false,
        omitted: [],
        moreOmitted: false,
      };
    },
  });
  const app = buildApp({ forge });
  const { patch: first } = await pendingPatch(app);
  await post(app.handler, `/v1/patches/${first.id}/approve`);
  await sweepPatches(
    {
      store: app.store,
      forge,
      identityDirectory: app.identities.directory,
      diag: silentDiagnostics(),
      now: app.clock.now,
    },
    DEFAULT_PATCH_SUBMIT_CONFIG,
  );
  const opened = (await app.store.getPatch(first.id))!;
  assertEquals(opened.state, "submitted");
  // The run goes on and submits again on the same branch: the submission pushes this one onto
  // the first one's change request, so approving it publishes only what it adds.
  const later = {
    ...opened,
    id: "p-later00000",
    headSha: "c".repeat(40),
    bundleKey: opened.bundleKey.replace("a".repeat(40), "c".repeat(40)),
    state: "pending_approval" as const,
    forgeRef: null,
    forgeUrl: null,
    forgeBranch: null,
    diffRef: null,
    approvedBy: null,
    approvedAt: null,
    createdAt: new Date(Date.parse(opened.createdAt) + 1000).toISOString(),
  };
  await app.store.savePatch(later);
  // The detail says so too, so a page holding the patch reads the diff again if it moves.
  assertEquals(
    (await (await get(app.handler, `/v1/patches/${later.id}`)).json()).diffBasis,
    { mode: "live", targetRef: opened.branchName, sincePatchId: first.id },
  );
  const res = await get(app.handler, `/v1/patches/${later.id}/diff`);
  assertEquals(res.status, 200);
  // The diff names the basis it was measured with, as the detail does.
  const { mode, targetRef, sincePatchId } = await res.json();
  assertEquals({ mode, targetRef, sincePatchId }, {
    mode: "live",
    targetRef: opened.branchName,
    sincePatchId: first.id,
  });
  // Measured against the first one's branch, which the push lands on.
  assertEquals(asks.at(-1)!.targetRef, opened.branchName);
  assertEquals(asks.at(-1)!.mode, "live");
  // The first one itself is published already: a record, from its own base.
  const settled = await (await get(app.handler, `/v1/patches/${first.id}/diff`)).json();
  assertEquals(asks.at(-1)!.mode, "record");
  assertEquals([settled.mode, settled.sincePatchId], ["record", null]);

  // Approving with the diff as it was read: a basis that has moved since is refused, and
  // nothing changes; the one the page holds now approves.
  const shown = { mode: "live", targetRef: opened.branchName, sincePatchId: first.id };
  const moved = await post(app.handler, `/v1/patches/${later.id}/approve`, {
    diffBasis: { mode: "live", targetRef: "main", sincePatchId: null, baseSha: base },
  });
  assertEquals(moved.status, 409);
  assertEquals((await moved.json()).code, "diff_basis_moved");
  assertEquals((await app.store.getPatch(later.id))!.state, "pending_approval");
  // The same branch, force-pushed since the diff was read: measured again, it runs from another
  // commit, and the approval is refused as well.
  const read = base;
  base = "d".repeat(40);
  const pushed = await post(app.handler, `/v1/patches/${later.id}/approve`, {
    diffBasis: { ...shown, baseSha: read },
  });
  assertEquals(pushed.status, 409);
  assertEquals((await pushed.json()).code, "diff_basis_moved");
  // A basis that does not say where its diff ran from is not one an approval can be held to, and
  // a body cut short is malformed, never taken for no basis at all.
  const unsaid = await post(app.handler, `/v1/patches/${later.id}/approve`, { diffBasis: shown });
  assertEquals(unsaid.status, 400);
  const cut = await app.handler(
    new Request(`http://orchestrator.test/v1/patches/${later.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify({ diffBasis: { ...shown, baseSha: base } }).slice(0, 40),
    }),
  );
  assertEquals(cut.status, 400);
  assertEquals((await app.store.getPatch(later.id))!.state, "pending_approval");
  const approved = await post(app.handler, `/v1/patches/${later.id}/approve`, {
    diffBasis: { ...shown, baseSha: base },
  });
  assertEquals(approved.status, 200);
});

test("a patch outside the caller's scope is the same 404 as one that does not exist", async () => {
  const who: { caller: unknown } = { caller: USER };
  const app = buildApp({ who });
  const { patch } = await pendingPatch(app);

  // Somebody else, with no linked identity: they see their own tasks, and this is not one.
  who.caller = { ...USER, userId: "u-2", email: "bob@example.com", name: "Bob" };
  const missing = await get(app.handler, "/v1/patches/p-nope");
  assertEquals(missing.status, 404);
  const missingBody = await missing.json();
  for (const path of [`/v1/patches/${patch.id}`, `/v1/patches/${patch.id}/diff`]) {
    const res = await get(app.handler, path);
    assertEquals(res.status, 404);
    assertEquals(await res.json(), missingBody);
  }
});

test("a patch diff says what the forge said: gone, refused, or not answering", async () => {
  let answer: PatchDiffOutcome = { kind: "refused", status: 410, error: "no bundle at k" };
  const forge = noopForge(silentDiagnostics(), {
    repos: [REPO_LISTING],
    patchDiff: () => answer,
  });
  const app = buildApp({ forge });
  const { patch } = await pendingPatch(app);
  const diffOf = () => get(app.handler, `/v1/patches/${patch.id}/diff`);

  const gone = await diffOf();
  assertEquals(gone.status, 410);
  // A refusal is today's answer and the caller's own, never one for a shared cache to keep.
  assertEquals(gone.headers.get("cache-control"), "private, no-cache");
  assertStringIncludes((await gone.json()).error, "no bundle");

  answer = { kind: "refused", status: 409, error: "the stored bundle no longer verifies" };
  const refused = await diffOf();
  assertEquals(refused.status, 409);
  assertStringIncludes((await refused.json()).error, "no longer verifies");

  answer = { kind: "unavailable", error: "base cache unavailable, retry" };
  const down = await diffOf();
  assertEquals(down.status, 503);
  assertEquals(down.headers.get("cache-control"), "private, no-cache");
  assertStringIncludes((await down.json()).error, "base cache unavailable");

  // No forge to ask at all: the patch still reads, its diff is unavailable.
  const dark = buildApp({ forge, patchDiffs: null });
  const { patch: other } = await pendingPatch(dark);
  assertEquals((await get(dark.handler, `/v1/patches/${other.id}`)).status, 200);
  assertEquals((await get(dark.handler, `/v1/patches/${other.id}/diff`)).status, 503);
});

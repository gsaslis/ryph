import { afterAll, test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// Landing in GitHub's user mode: no webhooks, so the change requests ryph's patches reached are
// polled (core/merge_poll.ts), and a merge or close the poll reads goes the forge event's own way
// (core/merge_settle.ts `settleChangeRequestEnd`) — settled, landed on the branch it merged
// into, ruled and cued, exactly once however often it is read or delivered.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { drizzleTaskStore } from "../src/adapters/store/drizzle.ts";
import { makeTestDb } from "./db.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import { forgeUserModeDirectory } from "../src/adapters/identity_directory/forge_user_mode.ts";
import { sweepPatches } from "../src/core/reaper.ts";
import { DEFAULT_PATCH_SUBMIT_CONFIG } from "../src/core/patch_lifecycle.ts";
import {
  DEFAULT_MERGE_POLL_CONFIG,
  GONE_LIMIT,
  mergePollBackoffMs,
  type MergePollConfig,
  type MergePollDeps,
  pollChangeRequestEnds,
} from "../src/core/merge_poll.ts";
import type { Patch, PatchPayload } from "../src/core/types.ts";
import type { MergePollClock, TaskStore } from "../src/ports/task_store.ts";
import type { MemoryAccess } from "../src/ports/memory_access.ts";
import type {
  ChangeRequestHeadOutcome,
  ForgeRepoRef,
  GithubMode,
  GithubModeSource,
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
import {
  LANDING_COOLDOWN_MS,
  LANDING_GRACE_MS,
  MERGE_SETTLE_RETRY_MS,
} from "../src/core/merge_settle.ts";

const FORGE_TOKEN = "forge-service-token";
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
const REPO = {
  fullName: "acme/app",
  url: "https://github.com/acme/app.git",
  defaultBranch: "main",
  private: true,
};
const USER_MODE: GithubMode = { mode: "user", login: "octo-ada" };
const CLOCKS = { idleMs: 300_000, attendedIdleMs: 1_800_000 };

// The in-memory store by default; the drizzle store over a real Postgres with RYPH_TEST_DB
// (tests/db.ts: a database of its own for every app), sanitizers off as landing_test.ts explains.
const ON_POSTGRES = process.env.RYPH_TEST_DB !== undefined;
let openStore: { close(): Promise<void> } | null = null;
async function baseStore(): Promise<TaskStore> {
  if (!ON_POSTGRES) return memoryTaskStore();
  if (openStore !== null) await openStore.close();
  const store = drizzleTaskStore(await makeTestDb());
  openStore = store;
  return store;
}
// And the last one once the file is done, so its database does not outlive the file.
afterAll(async () => {
  await openStore?.close();
});

/** A pull request as GitHub's `pulls/{n}` would read it, the poll's whole answer. */
type PullState =
  | { state: "open" }
  | { state: "closed"; merged: boolean; base?: string }
  | { answer: ChangeRequestHeadOutcome };

const fixedMode = (mode: GithubMode | null | undefined): GithubModeSource => ({
  current: () => mode,
  get: () => mode === undefined ? Promise.reject(new Error("unanswered")) : Promise.resolve(mode),
});

async function buildApp(opts: { mode?: GithubMode | null | undefined } = {}) {
  const store = await baseStore();
  const clock = fakeClock();
  const { provisioner, launches } = fakeProvisioner();
  const identities = fakeIdentityDirectory();
  const mode = "mode" in opts ? opts.mode : USER_MODE;
  const githubMode = fixedMode(mode);
  /** Each pull request's state, by number; open unless the test says. */
  const pulls = new Map<string, PullState>();
  /** Every read the poll made, in order. */
  const asked: Array<{ repo: ForgeRepoRef; ref: string }> = [];
  /** Runs once, inside the next read: what lands between the poll's listing and its settle. */
  let duringRead: (() => Promise<void>) | null = null;
  const forge = noopForge(silentDiagnostics(), {
    permission: "allowed",
    repos: [{ ...REPO, admin: true }],
    ...(mode ? { github: mode } : {}),
  });
  forge.fetchChangeRequestHead = async (repo, ref) => {
    asked.push({ repo, ref });
    const hook = duringRead;
    duringRead = null;
    if (hook !== null) await hook();
    const pull = pulls.get(ref) ?? { state: "open" };
    if ("answer" in pull) return pull.answer;
    return {
      kind: "head",
      head: {
        ref,
        state: pull.state,
        merged: pull.state === "closed" && pull.merged,
        headSha: "0".repeat(40),
        authorHeadSha: "0".repeat(40),
        // GitHub's base at the merge, which a stacked pull request outlives.
        baseRef: pull.state === "closed" ? pull.base ?? "main" : "main",
        openedByUs: true,
        mergedHeads: pull.state === "closed" && pull.merged ? ["0".repeat(40)] : [],
      },
    };
  };
  const fates: Array<{ patchId: string; fate: string }> = [];
  const memoryAccess = {
    composeBrief: () => Promise.resolve(null),
    reportOutcome: () => Promise.resolve(),
    reportPatch: () => Promise.resolve(),
    reportChange: (_runId: string, patchId: string, fate: string) => (
      fates.push({ patchId, fate }), Promise.resolve()
    ),
    reportStale: () => Promise.resolve(),
  } as unknown as MemoryAccess;
  const identityDirectory = mode?.mode === "user"
    ? forgeUserModeDirectory(identities.directory, { github: githubMode, gitlab: null })
    : identities.directory;
  const deps = {
    store,
    provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate: (() => Promise.resolve(USER)) as unknown as Authenticate,
    forgeToken: FORGE_TOKEN,
    forge,
    githubMode,
    githubConnect: forge,
    githubUserConnect: forge,
    identityDirectory,
    memoryAccess,
    now: clock.now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: { url: "http://gateway.test:7412", keyTtlMs: 60 * 60 * 1000 },
      runHistoryUrl: null,
      localRepoRoot: null,
      appUrl: null,
      services: DEFAULT_SERVICE_POLICY,
      egress: {
        policy: { mode: "proxy" as const, bundles: [], hosts: [], proxyUrl: null },
        key: null,
        tokenTtlMs: 0,
      },
      platformMemoryServerId: null,
      platformChatServerId: null,
      platformTools: { webServerId: "ms-platform-web", web: false, forge: null, pending: false },
    },
  };
  return {
    handler: makeHandler(deps),
    store,
    clock,
    launches,
    forge,
    identities,
    identityDirectory,
    githubMode,
    memoryAccess,
    pulls,
    asked,
    fates,
    during: (hook: () => Promise<void>) => (duringRead = hook),
  };
}
type App = Awaited<ReturnType<typeof buildApp>>;

type Handler = (req: Request) => Promise<Response>;
const post = (handler: Handler, path: string, body: unknown = {}, token = "t") =>
  handler(
    new Request(`http://orchestrator.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );

/** Connects the repo — with no installation in user mode, through one in App mode — and mints
 * the agent. */
async function prepare(app: App, mode: "user" | "app" = "user") {
  let repo;
  if (mode === "user") {
    repo = await (await post(app.handler, "/v1/connected-repos", {
      provider: "github",
      repoRef: REPO.fullName,
    })).json();
  } else {
    app.identities.link(USER.userId, "noop-ada-lovelace");
    await post(app.handler, "/v1/installations", { installationId: "42" });
    repo = await (await post(app.handler, "/v1/connected-repos", {
      installationId: "42",
      repoRef: REPO.fullName,
    })).json();
  }
  assert(typeof repo.id === "string", JSON.stringify(repo));
  const agent = await (await post(app.handler, "/v1/agents", {
    name: "Ada",
    email: "ada@example.com",
    harnessKind: "pi",
  })).json();
  return { repo, agent };
}

/** A live run on its own pull request, on `ref` of the repo when given. */
async function ownRun(app: App, opts: { ref?: string; mode?: "user" | "app" } = {}) {
  const { repo, agent } = await prepare(app, opts.mode);
  const created = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Fix it", instructions: "Fix the bug." },
    connectedRepoId: repo.id,
    ...(opts.ref === undefined ? {} : { ref: opts.ref }),
    lifetime: CLOCKS,
  });
  assertEquals(created.status, 201, await created.clone().text());
  const { taskId, runId } = await created.json();
  const runToken = (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN;
  await post(app.handler, `/v1/runs/${runId}/heartbeat`, { seq: 0, phase: "running" }, runToken);
  return { taskId, runId, runToken, repo };
}
type OwnRun = Awaited<ReturnType<typeof ownRun>>;

/** A second task's live run, by the same agent on the same repo, as `ownRun` makes one. */
async function anotherRun(app: App, run: OwnRun, ref: string): Promise<OwnRun> {
  const created = await post(app.handler, "/v1/tasks", {
    agentId: (await app.store.getTask(run.taskId))!.agentId,
    spec: { title: "Fix it too", instructions: "Fix the other bug." },
    connectedRepoId: run.repo.id,
    ref,
    lifetime: CLOCKS,
  });
  assertEquals(created.status, 201, await created.clone().text());
  const { taskId, runId } = await created.json();
  const runToken = (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN;
  await post(app.handler, `/v1/runs/${runId}/heartbeat`, { seq: 0, phase: "running" }, runToken);
  return { ...run, taskId, runId, runToken };
}

/** Two tasks' patches on one pull request (the first task's): the second task's patch is moved
 * onto it, as a task working that pull request would have pushed it. */
async function twoTasksOnOnePull(app: App) {
  const run = await ownRun(app, { ref: "feature-a" });
  const first = await ship(app, run, "a".repeat(40));
  const other = await anotherRun(app, run, "feature-a");
  app.clock.advance(1000);
  const shipped = await ship(app, other, "b".repeat(40));
  await app.store.savePatch({ ...shipped, forgeRef: first.forgeRef });
  const second = (await app.store.getPatch(shipped.id))!;
  return { run, first, other, second };
}

/** A patch born through the runner's route, approved and swept onto the forge. */
async function ship(app: App, run: OwnRun, sha: string, generation = 1): Promise<Patch> {
  const born = await post(app.handler, `/v1/runs/${run.runId}/patches`, {
    branch: {
      connectedRepoId: run.repo.id,
      path: "app",
      name: generation === 1
        ? `ryph/ada/${run.runId}/work`
        : `ryph/ada/${run.runId}/work-${generation}`,
      line: "work",
      headSha: sha,
      commits: [{ sha, subject: `work ${sha.slice(0, 1)}` }],
      generation,
      carries: [],
    },
    baseSha: "0".repeat(40),
  }, run.runToken);
  assertEquals(born.status, 201, await born.clone().text());
  const { patchId } = await born.json();
  assertEquals((await post(app.handler, `/v1/patches/${patchId}/approve`)).status, 200);
  // Delivered by a sweep that polls nothing, so each test decides when the poll first asks.
  await sweep(app, DEFAULT_MERGE_POLL_CONFIG, false);
  const patch = (await app.store.getPatch(patchId))!;
  assertEquals(patch.state, "submitted");
  return patch;
}

/** One submit sweep, the merge poll riding it unless `poll` is false. */
const sweep = (app: App, mergePoll: MergePollConfig = DEFAULT_MERGE_POLL_CONFIG, poll = true) =>
  sweepPatches({
    store: app.store,
    forge: app.forge,
    identityDirectory: app.identityDirectory,
    diag: silentDiagnostics(),
    memoryAccess: app.memoryAccess,
    githubMode: poll ? app.githubMode : null,
    mergePoll,
    now: app.clock.now,
  }, DEFAULT_PATCH_SUBMIT_CONFIG);

/** The reads of the poll since `from`. */
const readsSince = (app: App, from: number) => app.asked.slice(from).map((a) => a.ref);

async function cues(app: App, runId: string, state: "merged" | "closed" = "merged") {
  return (await app.store.listRunMessages(runId))
    .map((m) => m.payload as PatchPayload | null)
    .filter((p) => p?.kind === "patch" && p.state === state);
}

async function settledEvents(app: App, runId: string) {
  return (await app.store.listEvents(runId)).filter((e) => e.kind === "patch-settled").length;
}

function deliver(app: App, kind: "merged" | "closed", thread: string, base = "main") {
  return post(app.handler, "/v1/forge/events", {
    deliveryId: crypto.randomUUID(),
    kind: `change_request.${kind}`,
    repo: { provider: "github", repoRef: REPO.fullName, url: REPO.url },
    actorLogin: "grace",
    thread: { kind: "change_request", ref: thread },
    body: null,
    sourceCommentId: null,
    ...(kind === "merged" ? { merged: { baseRef: base, heads: ["0".repeat(40)] } } : {}),
    receivedAt: "2026-01-01T00:00:00.000Z",
  }, FORGE_TOKEN);
}

// ---- the fate, as the webhook would have it ---------------------------------------------------

test(
  "user mode: a merged pull request the poll reads settles, lands on its base and cues the live run",
  async () => {
    const app = await buildApp();
    // Stacked on feature-a: what the task recorded is NOT where it merged — only the poll's read
    // of GitHub's base says main.
    const run = await ownRun(app, { ref: "feature-a" });
    const patch = await ship(app, run, "a".repeat(40));
    assertEquals(app.forge.submissions.at(-1)!.baseBranch, "feature-a");
    const before = app.asked.length;
    app.pulls.set(patch.forgeRef!, { state: "closed", merged: true, base: "main" });

    await sweep(app);

    assertEquals(readsSince(app, before), [patch.forgeRef!]);
    assertEquals(app.asked.at(-1)!.repo.tenantId, null);
    const settled = (await app.store.getPatch(patch.id))!;
    assertEquals(settled.landed?.kind, "merged");
    const task = (await app.store.getTask(run.taskId))!;
    assertEquals(task.repos[0].ref, "main");
    assertEquals(task.landings.app?.work?.onto, "main");
    assertEquals(
      (await app.store.listEvents(run.runId)).filter((e) => e.kind === "merge-landed").length,
      1,
    );
    assertEquals((await cues(app, run.runId)).map((c) => [c!.patchId, c!.onto]), [[
      patch.id,
      "main",
    ]]);
    assertEquals(app.fates, [{ patchId: patch.id, fate: "landed" }]);
    // The next patch opens against where it merged.
    await ship(app, run, "c".repeat(40), 2);
    assertEquals(app.forge.submissions.at(-1)!.baseBranch, "main");
  },
);

test(
  "user mode: a pull request closed unmerged settles as closed, as the webhook's close does",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const patch = await ship(app, run, "a".repeat(40));
    app.pulls.set(patch.forgeRef!, { state: "closed", merged: false });

    await sweep(app);

    assertEquals((await app.store.getPatch(patch.id))!.landed?.kind, "closed");
    assertEquals((await cues(app, run.runId, "closed")).map((c) => c!.patchId), [patch.id]);
    assertEquals(await cues(app, run.runId), []);
    assertEquals(app.fates, [{ patchId: patch.id, fate: "dropped" }]);
    assertEquals((await app.store.getTask(run.taskId))!.landings, {});
  },
);

test(
  "a branch submitted twice is told of its close once, by its newest patch and head",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    // Newest by birth: the fake clock stands still, and a tie is broken by the random id.
    app.clock.advance(1_000);
    const second = await ship(app, run, "b".repeat(40));
    assertEquals(second.forgeRef, first.forgeRef);
    app.pulls.set(second.forgeRef!, { state: "closed", merged: false });

    await sweep(app);

    for (const id of [first.id, second.id]) {
      assertEquals((await app.store.getPatch(id))!.landed?.kind, "closed");
    }
    assertEquals((await cues(app, run.runId, "closed")).map((c) => c!.patchId), [second.id]);
    const said = (await app.store.listRunMessages(run.runId))
      .filter((m) => (m.payload as PatchPayload | null)?.state === "closed")
      .map((m) => m.text);
    assertEquals(said.length, 1);
    assertStringIncludes(said[0], "(head `bbbbbbb`)");
  },
);

test(
  "user mode: an open pull request — reopened, say — is left alone, and asked again only after the interval",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const patch = await ship(app, run, "a".repeat(40));
    const ref = patch.forgeRef!;
    const before = app.asked.length;

    await sweep(app);
    await sweep(app);
    app.clock.advance(DEFAULT_MERGE_POLL_CONFIG.intervalMs - 1);
    await sweep(app);
    assertEquals(readsSince(app, before), [ref]);
    assertEquals((await app.store.getPatch(patch.id))!.landed, null);

    app.clock.advance(1);
    await sweep(app);
    assertEquals(readsSince(app, before), [ref, ref]);
    assertEquals((await app.store.getPatch(patch.id))!.landed, null);

    // Merged at last.
    app.pulls.set(ref, { state: "closed", merged: true });
    app.clock.advance(DEFAULT_MERGE_POLL_CONFIG.intervalMs);
    await sweep(app);
    assertEquals((await app.store.getPatch(patch.id))!.landed?.kind, "merged");
  },
);

// ---- never twice --------------------------------------------------------------------------------

test(
  "user mode: a poll after the webhook asks nothing, and a webhook racing the poll's read settles once",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    // The webhook's door first (a forge that could deliver one): the poll then has nothing to ask.
    assertEquals((await deliver(app, "merged", first.forgeRef!)).status, 200);
    const before = app.asked.length;
    await sweep(app);
    assertEquals(readsSince(app, before), []);
    assertEquals(await settledEvents(app, run.runId), 1);

    // Generation 2's pull request: the merge delivered while the poll is reading it.
    const second = await ship(app, run, "c".repeat(40), 2);
    app.pulls.set(second.forgeRef!, { state: "closed", merged: true });
    app.during(async () => {
      assertEquals((await deliver(app, "merged", second.forgeRef!)).status, 200);
    });
    await sweep(app);
    assertEquals((await app.store.getPatch(second.id))!.landed?.kind, "merged");
    assertEquals(await settledEvents(app, run.runId), 2);
    assertEquals((await cues(app, run.runId)).map((c) => c!.patchId), [first.id, second.id]);
    assertEquals(
      app.fates.filter((f) => f.patchId === second.id),
      [{ patchId: second.id, fate: "landed" }],
    );
    // And the poll never asks about it again.
    const after = app.asked.length;
    app.clock.advance(10 * DEFAULT_MERGE_POLL_CONFIG.intervalMs);
    await sweep(app);
    assertEquals(readsSince(app, after), []);
  },
);

test("user mode: a settle the poll read twice repeats nothing", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const patch = await ship(app, run, "a".repeat(40));
  app.pulls.set(patch.forgeRef!, { state: "closed", merged: true });
  // A second replica's poll read the same merge: both settle through the one path.
  const racing = { ...app, store: app.store };
  await Promise.all([sweep(app), sweep(racing)]);
  assertEquals(await settledEvents(app, run.runId), 1);
  assertEquals((await cues(app, run.runId)).length, 1);
  assertEquals(app.fates.length, 1);
});

// ---- only where there are no webhooks -----------------------------------------------------------

test(
  "App mode is never polled, nor a deployment whose mode the forge has not said",
  async () => {
    for (const mode of [{ mode: "app", signIn: true } as GithubMode, undefined, null]) {
      const app = await buildApp({ mode: { mode: "app", signIn: true } });
      const run = await ownRun(app, { mode: "app" });
      const patch = await ship(app, run, "a".repeat(40));
      app.pulls.set(patch.forgeRef!, { state: "closed", merged: true });
      const before = app.asked.length;
      for (let i = 0; i < 3; i++) {
        await sweepPatches({
          store: app.store,
          forge: app.forge,
          identityDirectory: app.identityDirectory,
          diag: silentDiagnostics(),
          githubMode: fixedMode(mode),
          now: app.clock.now,
        }, DEFAULT_PATCH_SUBMIT_CONFIG);
        app.clock.advance(DEFAULT_MERGE_POLL_CONFIG.intervalMs);
      }
      assertEquals(readsSince(app, before), [], JSON.stringify(mode));
      assertEquals((await app.store.getPatch(patch.id))!.landed, null);
    }
  },
);

test("user mode: a repo connected through an App installation is never polled", async () => {
  const app = await buildApp({ mode: { mode: "app", signIn: true } });
  const run = await ownRun(app, { mode: "app" });
  const patch = await ship(app, run, "a".repeat(40));
  // The deployment switched to user mode since: the App's leftover row is not this forge's.
  const before = app.asked.length;
  await sweepPatches({
    store: app.store,
    forge: app.forge,
    identityDirectory: app.identityDirectory,
    diag: silentDiagnostics(),
    githubMode: fixedMode(USER_MODE),
    now: app.clock.now,
  }, DEFAULT_PATCH_SUBMIT_CONFIG);
  assertEquals(readsSince(app, before), []);
  assertEquals((await app.store.getPatch(patch.id))!.landed, null);
});

test("user mode: a GitLab row connected on another instance is never polled, and one listed anyway is parked", async () => {
  // RYPH_GITLAB_URL moved: the row's project id is the old instance's, and names a project
  // nobody connected here. Asked about, the forge refuses it every tick. The store never lists
  // it; one that did (here, a listing that holds it regardless) gets a parked clock, so it can
  // never keep the head of the queue from the change requests behind it.
  const store = memoryTaskStore();
  const row = {
    id: "cr-old",
    provider: "gitlab" as const,
    installationId: null,
    repoRef: "acme/app",
    url: "https://gitlab.old.example/acme/app.git",
    defaultBranch: "main",
    submissionPolicy: "auto" as const,
    sizeClass: null,
    allowForkPushes: false,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await store.createConnectedRepo(row);
  await store.createGitlabProject(row.id, "7", "https://gitlab.old.example", row.createdAt);
  const asked: string[] = [];
  const stamped: Array<{ ref: string; clock: MergePollClock }> = [];
  const deps = {
    store: {
      ...store,
      stampMergePoll: (_repo: string, ref: string, clock: MergePollClock) => {
        stamped.push({ ref, clock });
        return Promise.resolve();
      },
      listChangeRequestsDueMergePoll: () =>
        Promise.resolve([{
          connectedRepoId: row.id,
          forgeRef: "mr-1",
          failures: 0,
          gone: 0,
          open: true,
          asked: false,
        }]),
    },
    forge: {
      providers: () =>
        Promise.resolve({
          providers: ["gitlab"],
          github: null,
          gitlab: {
            mode: "user",
            login: "ada",
            accountId: "1@https://gitlab.example",
            url: "https://gitlab.example",
            signIn: false,
          },
          radicle: null,
        }),
      fetchChangeRequestHead: (_repo: ForgeRepoRef, ref: string) => {
        asked.push(ref);
        return Promise.resolve({ kind: "gone" } as ChangeRequestHeadOutcome);
      },
    },
    diag: silentDiagnostics(),
    now: fakeClock().now,
  } as unknown as MergePollDeps;
  const t0 = (deps.now as () => Date)().getTime();
  await pollChangeRequestEnds(deps);
  assertEquals(asked, []);
  assertEquals(stamped, [{
    ref: "mr-1",
    clock: {
      dueAt: new Date(t0 + DEFAULT_MERGE_POLL_CONFIG.parkedIntervalMs).toISOString(),
      failures: 0,
      gone: 0,
    },
  }]);
});

// ---- the cost ----------------------------------------------------------------------------------

test(
  "user mode: a tick asks at most its cap, never-asked first, then the one asked longest ago",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const refs: string[] = [];
    for (const [i, sha] of ["a", "b", "c"].entries()) {
      refs.push((await ship(app, run, sha.repeat(40), i + 1)).forgeRef!);
    }
    assertEquals(new Set(refs).size, 3);
    const cfg = { ...DEFAULT_MERGE_POLL_CONFIG, perTick: 2 };
    const before = app.asked.length;

    await sweep(app, cfg);
    const firstTwo = readsSince(app, before);
    assertEquals(firstTwo.length, 2);
    app.clock.advance(1_000);
    await sweep(app, cfg);
    const third = refs.filter((r) => !firstTwo.includes(r));
    assertEquals(readsSince(app, before + 2), third);
    // Nothing is due again within the interval.
    await sweep(app, cfg);
    assertEquals(app.asked.length, before + 3);
    // Past it: the two asked longest ago, then the third.
    app.clock.advance(DEFAULT_MERGE_POLL_CONFIG.intervalMs);
    await sweep(app, cfg);
    assertEquals(readsSince(app, before + 3).toSorted(), firstTwo.toSorted());
    await sweep(app, cfg);
    assertEquals(readsSince(app, before + 5), third);
  },
);

test(
  "user mode: an unanswered read backs its change request off and ends the pass; a gone one does not",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const one = (await ship(app, run, "a".repeat(40), 1)).forgeRef!;
    const two = (await ship(app, run, "b".repeat(40), 2)).forgeRef!;
    const cfg = { ...DEFAULT_MERGE_POLL_CONFIG, perTick: 2 };
    const order = (await app.store.listChangeRequestsDueMergePoll(
      app.clock.now().toISOString(),
      "",
      2,
      ["github"],
    )).map((d) => d.forgeRef);
    const [first, second] = order;
    assertEquals(new Set(order), new Set([one, two]));

    // The forge cannot answer (a token that fails, GitHub's rate limit): the first read fails, and
    // the pass stops there rather than spending the second.
    app.pulls.set(first, { answer: { kind: "unavailable" } });
    const before = app.asked.length;
    await sweep(app, cfg);
    assertEquals(readsSince(app, before), [first]);
    // The second goes on the next tick; the first waits out its backoff.
    await sweep(app, cfg);
    assertEquals(readsSince(app, before), [first, second]);
    app.clock.advance(mergePollBackoffMs(1, cfg) - 1);
    app.pulls.set(second, { answer: { kind: "gone" } });
    await sweep(app, cfg);
    assertEquals(readsSince(app, before), [first, second, second]);
    app.clock.advance(1);
    await sweep(app, cfg);
    assertEquals(readsSince(app, before), [first, second, second, first]);
    // A gone read backs off too, but the pass goes on: the next due one is still asked.
    app.clock.advance(mergePollBackoffMs(2, cfg));
    app.pulls.set(first, { state: "closed", merged: true });
    await sweep(app, cfg);
    assertEquals(readsSince(app, before).slice(4).toSorted(), [first, second].toSorted());
    // Left alone throughout, until the forge answered.
    assertEquals(
      (await app.store.getPatch(
        (await app.store.patchesByRepoAndForgeRef(run.repo.id, second))[0].id,
      ))!.landed,
      null,
    );
    assertEquals(
      (await app.store.patchesByRepoAndForgeRef(run.repo.id, first))[0].landed?.kind,
      "merged",
    );
  },
);

test("the backoff doubles from the interval up to its ceiling", () => {
  const cfg = DEFAULT_MERGE_POLL_CONFIG;
  assertEquals(mergePollBackoffMs(1, cfg), 2 * cfg.intervalMs);
  assertEquals(mergePollBackoffMs(2, cfg), 4 * cfg.intervalMs);
  assertEquals(mergePollBackoffMs(60, cfg), cfg.maxBackoffMs);
});

// ---- the store ----------------------------------------------------------------------------------

test(
  "the poll's listing holds unsettled and recently closed submitted patches of live user-mode repos, one row per change request, and its clocks are pruned past them",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const now = () => app.clock.now().toISOString();
    const a = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    // A second push onto the same pull request: still one change request.
    const a2 = await ship(app, run, "b".repeat(40));
    assertEquals(a2.forgeRef, a.forgeRef);
    const b = await ship(app, run, "c".repeat(40), 2);
    const list = (at: string, closedSince = now()) =>
      app.store.listChangeRequestsDueMergePoll(at, closedSince, 10, ["github"]);
    const due = await list(now());
    assertEquals(
      due.map((d) => d.forgeRef).toSorted(),
      [a.forgeRef!, b.forgeRef!].toSorted(),
    );
    assert(
      due.every((d) =>
        d.connectedRepoId === run.repo.id && d.failures === 0 && d.gone === 0 && d.open
      ),
    );

    // A clock in the future takes it out until then, with its failures.
    const later = new Date(app.clock.now().getTime() + 60_000).toISOString();
    await app.store.stampMergePoll(run.repo.id, a.forgeRef!, {
      dueAt: later,
      failures: 3,
      gone: 2,
    });
    assertEquals((await list(now())).map((d) => d.forgeRef), [b.forgeRef!]);
    assertEquals(
      (await list(later)).map((d) => [d.forgeRef, d.failures, d.gone]),
      [[b.forgeRef!, 0, 0], [a.forgeRef!, 3, 2]],
    );
    assertEquals(await app.store.pruneMergePolls(now(), 10), 0);

    // Closed: still listed while the close is recent, as closed (`open` false), and its clock
    // kept; past the window, out of the listing and pruned.
    const closedAt = now();
    assertEquals((await deliver(app, "closed", a.forgeRef!)).status, 200);
    assertEquals(
      (await list(later, closedAt)).map((d) => [d.forgeRef, d.open]),
      [[b.forgeRef!, true], [a.forgeRef!, false]],
    );
    assertEquals(await app.store.pruneMergePolls(closedAt, 10), 0);
    const past = new Date(Date.parse(closedAt) + 1).toISOString();
    assertEquals((await list(later, past)).map((d) => d.forgeRef), [b.forgeRef!]);
    assertEquals(await app.store.pruneMergePolls(past, 10), 1);
    assertEquals(await app.store.pruneMergePolls(past, 10), 0);
    // Merged: out for good.
    assertEquals((await deliver(app, "merged", b.forgeRef!)).status, 200);
    assertEquals(await list(later, ""), [
      {
        connectedRepoId: run.repo.id,
        forgeRef: a.forgeRef!,
        failures: 0,
        gone: 0,
        open: false,
        asked: false,
      },
    ]);

    // An archived repo is never listed.
    const repo = (await app.store.getConnectedRepo(run.repo.id))!;
    await app.store.saveConnectedRepo({ ...repo, archivedAt: now() });
    assertEquals(await list(later, ""), []);
    // Nor one with an installation (App mode's tenant).
    await app.store.saveConnectedRepo({ ...repo, installationId: "42" });
    assertEquals(await list(later, ""), []);
  },
);

// ---- a reopen, a refused push, a change request gone ------------------------------------------

test(
  "user mode: a pull request polled closed, then reopened and merged with no push, lands and cues",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app, { ref: "feature-a" });
    const patch = await ship(app, run, "a".repeat(40));
    const ref = patch.forgeRef!;
    app.pulls.set(ref, { state: "closed", merged: false });
    await sweep(app);
    assertEquals((await app.store.getPatch(patch.id))!.landed?.kind, "closed");
    assertEquals(app.fates, [{ patchId: patch.id, fate: "dropped" }]);

    // Asked again slowly while closed.
    const before = app.asked.length;
    app.clock.advance(DEFAULT_MERGE_POLL_CONFIG.closedIntervalMs - 1);
    await sweep(app);
    assertEquals(readsSince(app, before), []);
    app.clock.advance(1);
    await sweep(app);
    assertEquals(readsSince(app, before), [ref]);
    assertEquals((await app.store.getPatch(patch.id))!.landed?.kind, "closed");

    // Reopened and merged by hand, into main.
    app.pulls.set(ref, { state: "closed", merged: true, base: "main" });
    app.clock.advance(DEFAULT_MERGE_POLL_CONFIG.closedIntervalMs);
    await sweep(app);
    assertEquals((await app.store.getPatch(patch.id))!.landed?.kind, "merged");
    const task = (await app.store.getTask(run.taskId))!;
    assertEquals([task.repos[0].ref, task.landings.app?.work?.onto], ["main", "main"]);
    assertEquals((await cues(app, run.runId)).map((c) => [c!.patchId, c!.onto]), [[
      patch.id,
      "main",
    ]]);
    assertEquals(app.fates, [
      { patchId: patch.id, fate: "dropped" },
      { patchId: patch.id, fate: "landed" },
    ]);
    // Settled for good: never asked again.
    const after = app.asked.length;
    app.clock.advance(DEFAULT_MERGE_POLL_CONFIG.closedWindowMs);
    await sweep(app);
    assertEquals(readsSince(app, after), []);
  },
);

test(
  "user mode: a change request closed longer ago than the window is not asked about",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const patch = await ship(app, run, "a".repeat(40));
    app.pulls.set(patch.forgeRef!, { state: "closed", merged: false });
    await sweep(app);
    assertEquals((await app.store.getPatch(patch.id))!.landed?.kind, "closed");
    app.pulls.set(patch.forgeRef!, { state: "closed", merged: true });
    const before = app.asked.length;
    app.clock.advance(DEFAULT_MERGE_POLL_CONFIG.closedWindowMs + 1);
    await sweep(app);
    assertEquals(readsSince(app, before), []);
    assertEquals((await app.store.getPatch(patch.id))!.landed?.kind, "closed");
    assertEquals(await app.store.pruneMergePolls("", 10), 0, "the sweep pruned its clock");
  },
);

/** Births a same-generation patch of the run's branch and approves it, without delivering it. */
async function approveNext(app: App, run: OwnRun, sha: string) {
  const born = await post(app.handler, `/v1/runs/${run.runId}/patches`, {
    branch: {
      connectedRepoId: run.repo.id,
      path: "app",
      name: `ryph/ada/${run.runId}/work`,
      line: "work",
      headSha: sha,
      commits: [{ sha, subject: `work ${sha.slice(0, 1)}` }],
      generation: 1,
      carries: [],
    },
    baseSha: "0".repeat(40),
  }, run.runToken);
  assertEquals(born.status, 201, await born.clone().text());
  const { patchId } = await born.json();
  assertEquals((await post(app.handler, `/v1/patches/${patchId}/approve`)).status, 200);
  return patchId as string;
}

/** The forge refuses every push onto `merged` as GitHub's transport does once it merged. */
function refuseOnto(app: App, merged: string) {
  const deliver = app.forge.submitPatch.bind(app.forge);
  const refused: string[] = [];
  app.forge.submitPatch = (submission) => {
    if (submission.changeRequest !== merged) return deliver(submission);
    refused.push(submission.headSha);
    return Promise.resolve({
      kind: "failed",
      message: `not pushing onto #${merged}: it has been merged`,
      terminal: true,
      ended: "merged",
    });
  };
  return refused;
}

test(
  "user mode: a push refused because its pull request merged has the merge heard at once, and the patch held, not failed",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    const ref = first.forgeRef!;
    // Asked once while open: its next ask is a minute out.
    await sweep(app);
    const before = app.asked.length;
    // Merged by hand; before the poll's next ask, the run pushes more onto it.
    app.pulls.set(ref, { state: "closed", merged: true });
    const refused = refuseOnto(app, ref);
    const nextId = await approveNext(app, run, "b".repeat(40));
    await sweep(app);
    // Refused once, and the merge read on the same tick rather than a minute later.
    assertEquals(refused, ["b".repeat(40)]);
    assertEquals(readsSince(app, before), [ref]);
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "merged");
    const next = (await app.store.getPatch(nextId))!;
    assertEquals([next.state, next.heldReason !== null], ["pending_approval", true]);
    assertEquals(
      app.fates.filter((f) => f.patchId === nextId),
      [],
      "memory hears nothing of a held patch",
    );
    // Nothing goes onto the merged pull request again, however long the sweep runs.
    for (let i = 0; i < 5; i++) {
      app.clock.advance(DEFAULT_PATCH_SUBMIT_CONFIG.maxBackoffMs);
      await sweep(app);
    }
    assertEquals(refused, ["b".repeat(40)]);
    assertEquals((await app.store.getPatch(nextId))!.state, "pending_approval");
  },
);

test(
  "App mode: a push refused because its pull request merged records the merge from the forge's read, whose webhook may never come, and the patch is held",
  async () => {
    const app = await buildApp({ mode: { mode: "app", signIn: true } });
    const run = await ownRun(app, { mode: "app" });
    const first = await ship(app, run, "a".repeat(40));
    const ref = first.forgeRef!;
    // Merged; its webhook is lost.
    app.pulls.set(ref, { state: "closed", merged: true });
    const refused = refuseOnto(app, ref);
    const nextId = await approveNext(app, run, "b".repeat(40));
    await sweep(app);
    assertEquals(refused, ["b".repeat(40)]);
    // Not polled: read once, for the refusal, and the merge recorded from that read.
    assertEquals(app.asked.map((a) => a.ref), [ref]);
    const merge = (await app.store.getChangeRequestMerge(run.repo.id, ref))!;
    assertEquals([merge.mergedInto, merge.heads], ["main", ["0".repeat(40)]]);
    // The same sweep settles it from the record: the earlier patch merged, and the landing rule
    // holds the refused one. Nothing is pushed onto the merged pull request again.
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "merged");
    const held = (await app.store.getPatch(nextId))!;
    assertEquals([held.state, held.heldReason !== null], ["pending_approval", true]);
    for (let i = 0; i < 3; i++) {
      app.clock.advance(DEFAULT_PATCH_SUBMIT_CONFIG.maxBackoffMs);
      await sweep(app);
    }
    assertEquals(refused, ["b".repeat(40)]);
    // A webhook that comes after all repeats nothing.
    assertEquals((await deliver(app, "merged", ref)).status, 200);
    await sweep(app);
    assertEquals((await cues(app, run.runId)).map((c) => c!.patchId), [first.id]);
  },
);

test(
  "user mode: a push refused onto the change request a finished run's task works, which no poll asks about, records the merge from the read and is held",
  async () => {
    const app = await buildApp();
    const { repo, agent } = await prepare(app);
    const created = await post(app.handler, "/v1/tasks", {
      agentId: agent.id,
      spec: { title: "Address the review", instructions: "Do what the review says." },
      connectedRepoId: repo.id,
      targetChangeRequest: { connectedRepoId: repo.id, thread: "7" },
      lifetime: CLOCKS,
    });
    assertEquals(created.status, 201, await created.clone().text());
    const { taskId, runId } = await created.json();
    const runToken = (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN;
    await post(app.handler, `/v1/runs/${runId}/heartbeat`, { seq: 0, phase: "running" }, runToken);
    const run = { taskId, runId, runToken, repo };
    // A patch waits for a person while the run ends.
    const born = await post(app.handler, `/v1/runs/${runId}/patches`, {
      branch: {
        connectedRepoId: repo.id,
        path: "app",
        name: `ryph/ada/${runId}/work`,
        line: "work",
        headSha: "a".repeat(40),
        commits: [{ sha: "a".repeat(40), subject: "work a" }],
        generation: 1,
        carries: [],
      },
      baseSha: "0".repeat(40),
    }, runToken);
    assertEquals(born.status, 201, await born.clone().text());
    const { patchId } = await born.json();
    const ended = await post(app.handler, `/v1/runs/${runId}/result`, {
      status: "success",
      summary: "done",
      branches: [],
    }, runToken);
    assertEquals(ended.status, 200, await ended.clone().text());
    // #7 merged meanwhile; nothing of the run is on it, so no poll asks about it.
    app.pulls.set("7", { state: "closed", merged: true });
    await sweep(app);
    assertEquals(app.asked, []);
    // A person approves the patch: its push onto #7 is refused, and the merge recorded from the
    // forge's read of #7.
    const refused = refuseOnto(app, "7");
    assertEquals((await post(app.handler, `/v1/patches/${patchId}/approve`)).status, 200);
    await sweep(app);
    assertEquals(refused, ["a".repeat(40)]);
    assert((await app.store.getChangeRequestMerge(repo.id, "7")) !== null, "recorded");
    // The record lets the task go, and the rule holds the patch: its generation was built on
    // #7's head. It is never pushed onto #7 again.
    for (let i = 0; i < 3; i++) {
      app.clock.advance(DEFAULT_PATCH_SUBMIT_CONFIG.maxBackoffMs);
      await sweep(app);
    }
    assertEquals((await app.store.getTask(run.taskId))!.targetChangeRequest, null);
    const held = (await app.store.getPatch(patchId))!;
    assertEquals([held.state, held.heldReason !== null], ["pending_approval", true]);
    assertEquals(refused, ["a".repeat(40)]);
  },
);

test(
  "user mode: a change request found gone five times in a row is parked, asked once a day, and lands once it is reachable again",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const patch = await ship(app, run, "a".repeat(40));
    const ref = patch.forgeRef!;
    app.pulls.set(ref, { answer: { kind: "gone" } });
    const before = app.asked.length;
    // Twelve hours of hourly ticks: five reads, then parked.
    for (let i = 0; i < 12; i++) {
      await sweep(app);
      app.clock.advance(DEFAULT_MERGE_POLL_CONFIG.maxBackoffMs);
    }
    assertEquals(readsSince(app, before).length, GONE_LIMIT);
    const left = (await app.store.getPatch(patch.id))!;
    assertEquals([left.state, left.landed], ["submitted", null]);

    // The token had lost access; it has it back, and the pull request merged meanwhile. The daily
    // ask hears it.
    app.pulls.set(ref, { state: "closed", merged: true });
    app.clock.advance(DEFAULT_MERGE_POLL_CONFIG.parkedIntervalMs);
    await sweep(app);
    assertEquals(readsSince(app, before).length, GONE_LIMIT + 1);
    assertEquals((await app.store.getPatch(patch.id))!.landed?.kind, "merged");
    assertEquals((await cues(app, run.runId)).map((c) => c!.patchId), [patch.id]);
  },
);

test(
  "user mode: only gone reads in a row park a change request — an unanswered read or an answer starts the count again",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const patch = await ship(app, run, "a".repeat(40));
    const ref = patch.forgeRef!;
    const gone = { answer: { kind: "gone" } } as const;
    const down = { answer: { kind: "unavailable" } } as const;
    const sequence: PullState[] = [
      ...Array(GONE_LIMIT - 1).fill(gone),
      down,
      ...Array(GONE_LIMIT - 1).fill(gone),
      { state: "open" },
      ...Array(GONE_LIMIT - 1).fill(gone),
    ];
    const before = app.asked.length;
    for (const answer of sequence) {
      app.pulls.set(ref, answer);
      await sweep(app);
      app.clock.advance(DEFAULT_MERGE_POLL_CONFIG.maxBackoffMs);
    }
    // Every read was asked on its hourly tick: never parked.
    assertEquals(readsSince(app, before).length, sequence.length);
    // One more gone makes five in a row: parked, so the next hourly tick asks nothing.
    app.pulls.set(ref, gone);
    await sweep(app);
    app.clock.advance(DEFAULT_MERGE_POLL_CONFIG.maxBackoffMs);
    await sweep(app);
    assertEquals(readsSince(app, before).length, sequence.length + 1);
  },
);

test(
  "user mode: a push onto the pull request the task works, refused because it merged first, waits on its clock and is held once the release ends its generation",
  async () => {
    const app = await buildApp();
    const { repo, agent } = await prepare(app);
    const created = await post(app.handler, "/v1/tasks", {
      agentId: agent.id,
      spec: { title: "Address the review", instructions: "Do what the review says." },
      connectedRepoId: repo.id,
      targetChangeRequest: { connectedRepoId: repo.id, thread: "7" },
      lifetime: CLOCKS,
    });
    assertEquals(created.status, 201, await created.clone().text());
    const { runId } = await created.json();
    const runToken = (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN;
    await post(app.handler, `/v1/runs/${runId}/heartbeat`, { seq: 0, phase: "running" }, runToken);
    // Someone merged #7 before this run's first push: no patch of the run is on it, so its merge
    // record's release lets the task go, and ends the run's generation there.
    app.pulls.set("7", { state: "closed", merged: true });
    const refused = refuseOnto(app, "7");
    const patchId = await approveNext(app, { runId, runToken, repo, taskId: "" }, "a".repeat(40));
    await sweep(app);
    assertEquals(refused, ["a".repeat(40)]);
    const failed = (await app.store.getPatch(patchId))!;
    assertEquals(failed.state, "failed");
    assert(failed.nextAttemptAt !== null, "retryable, on a clock");
    // The poll read the merge on the same tick; the release followed it.
    assertEquals((await app.store.getTask(failed.taskId))!.targetChangeRequest, null);
    await sweep(app);
    const held = (await app.store.getPatch(patchId))!;
    assertEquals([held.state, held.heldReason !== null], ["pending_approval", true]);
    assertEquals(app.fates, [], "memory hears nothing of a held patch");
    assertEquals(refused, ["a".repeat(40)]);
  },
);

/** The store's landing fails `times` times, then lands as ever; counts every ask. */
function failLanding(app: App, times = 1) {
  const real = app.store.landMerge.bind(app.store);
  const calls = { failed: 0, asked: 0 };
  app.store.landMerge = (args) => {
    calls.asked++;
    if (calls.failed < times) {
      calls.failed++;
      return Promise.reject(new Error("connection reset"));
    }
    return real(args);
  };
  return calls;
}

test(
  "user mode: a landing that fails after its settle is landed, ruled and cued by a later sweep",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app, { ref: "feature-a" });
    const first = await ship(app, run, "a".repeat(40));
    // A next patch of the same branch and generation, waiting for a person when the merge lands.
    const born = await post(app.handler, `/v1/runs/${run.runId}/patches`, {
      branch: {
        connectedRepoId: run.repo.id,
        path: "app",
        name: `ryph/ada/${run.runId}/work`,
        line: "work",
        headSha: "b".repeat(40),
        commits: [{ sha: "b".repeat(40), subject: "work b" }],
        generation: 1,
        carries: [],
      },
      baseSha: "0".repeat(40),
    }, run.runToken);
    const { patchId: nextId } = await born.json();
    app.pulls.set(first.forgeRef!, { state: "closed", merged: true, base: "main" });
    const calls = failLanding(app);
    await sweep(app);
    // Settled, but the landing threw: nothing recorded, nobody told, and the poll is done with it.
    const settled = (await app.store.getPatch(first.id))!;
    assertEquals(settled.landed, { kind: "merged", at: settled.landed!.at, mergedInto: "main" });
    assertEquals(settled.landingAskedAt, null);
    assertEquals((await app.store.getTask(run.taskId))!.landings, {});
    assertEquals(await cues(app, run.runId), []);
    // Left to the delivery that settled it for a minute; after that the sweep lands it.
    app.clock.advance(LANDING_GRACE_MS + 1);
    const reads = app.asked.length;
    await sweep(app);
    assertEquals(readsSince(app, reads), [], "the poll never asked again");
    const task = (await app.store.getTask(run.taskId))!;
    assertEquals([task.repos[0].ref, task.landings.app?.work?.onto], ["main", "main"]);
    assertEquals((await cues(app, run.runId)).map((c) => [c!.patchId, c!.onto]), [[
      first.id,
      "main",
    ]]);
    const next = (await app.store.getPatch(nextId))!;
    assertEquals([next.state, next.heldReason !== null], ["pending_approval", true]);
    assert((await app.store.getPatch(first.id))!.landingAskedAt !== null);
    // Asked once more, never again.
    const asked = calls.asked;
    for (let i = 0; i < 3; i++) {
      app.clock.advance(DEFAULT_MERGE_POLL_CONFIG.maxBackoffMs);
      await sweep(app);
    }
    assertEquals(calls.asked, asked);
    assertEquals((await cues(app, run.runId)).length, 1);
  },
);

test(
  "App mode: a merge webhook whose landing failed, never redelivered, is landed and cued by the sweep",
  async () => {
    const app = await buildApp({ mode: { mode: "app", signIn: true } });
    const run = await ownRun(app, { mode: "app", ref: "feature-a" });
    const first = await ship(app, run, "a".repeat(40));
    const calls = failLanding(app);
    // The delivery records the merge; the sweep's settle judges it, and its landing throws.
    assertEquals((await deliver(app, "merged", first.forgeRef!, "release")).status, 200);
    await sweep(app);
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "merged");
    assertEquals(calls.asked, 1);
    // Inside the grace a sweep leaves it alone.
    await sweep(app);
    assertEquals(calls.asked, 1);
    app.clock.advance(LANDING_GRACE_MS + 1);
    await sweep(app);
    const task = (await app.store.getTask(run.taskId))!;
    assertEquals([task.repos[0].ref, task.landings.app?.work?.onto], ["release", "release"]);
    assertEquals((await cues(app, run.runId)).map((c) => c!.onto), ["release"]);
    // A late redelivery repeats nothing.
    assertEquals((await deliver(app, "merged", first.forgeRef!, "release")).status, 200);
    assertEquals((await cues(app, run.runId)).length, 1);
    assertEquals((await app.store.getTask(run.taskId))!.landings.app?.work?.onto, "release");
  },
);

test(
  "user mode: a landing that throws mid-merge leaves its patch owed, the rest landed, and the sweep lands it on its base",
  async () => {
    const app = await buildApp();
    const { run, first, other, second } = await twoTasksOnOnePull(app);
    app.pulls.set(first.forgeRef!, { state: "closed", merged: true, base: "main" });
    const calls = failLanding(app);
    await sweep(app);
    // The first landing threw. Every patch was settled before it, each keeping where the pull
    // request merged: the settle reconcile has nothing left to settle bare. The first owes its
    // landing; the other task's was landed all the same.
    assertEquals(calls.failed, 1);
    for (const id of [first.id, second.id]) {
      const settled = (await app.store.getPatch(id))!;
      assertEquals([settled.landed?.kind, settled.landed?.mergedInto], ["merged", "main"]);
    }
    assertEquals((await app.store.getPatch(first.id))!.landingAskedAt, null);
    assert((await app.store.getPatch(second.id))!.landingAskedAt !== null);
    assertEquals(await cues(app, run.runId), []);
    assertEquals((await cues(app, other.runId)).map((c) => c!.onto), ["main"]);
    app.clock.advance(LANDING_GRACE_MS + 1);
    await sweep(app);
    for (const { taskId, runId } of [run, other]) {
      const task = (await app.store.getTask(taskId))!;
      assertEquals([task.repos[0].ref, task.landings.app?.work?.onto], ["main", "main"]);
      assertEquals((await cues(app, runId)).map((c) => c!.onto), ["main"]);
    }
    assert((await app.store.getPatch(second.id))!.landingAskedAt !== null);
    // Asked once each after the failure, and never again; a late webhook repeats nothing.
    const asked = calls.asked;
    app.clock.advance(LANDING_GRACE_MS + 1);
    await sweep(app);
    assertEquals((await deliver(app, "merged", first.forgeRef!, "main")).status, 200);
    assertEquals(calls.asked, asked, "a redelivery names nothing new, and lands nothing again");
    assertEquals((await cues(app, run.runId)).length, 1);
    assertEquals((await cues(app, other.runId)).length, 1);
    assertEquals(
      (await app.store.listEvents(other.runId)).filter((e) => e.kind === "merge-landed").length,
      1,
    );
  },
);

test(
  "user mode: a patch whose settle threw on a merge still owing its landing is settled as the merge settles",
  async () => {
    const app = await buildApp();
    const { run, first, other, second } = await twoTasksOnOnePull(app);
    app.pulls.set(first.forgeRef!, { state: "closed", merged: true, base: "main" });
    // The merge's settle of the second patch throws, once: the first is settled and owes its
    // landing, the second is left submitted on a merged pull request.
    const settleIf = app.store.settlePatchIf.bind(app.store);
    let throws = 1;
    app.store.settlePatchIf = (patch, ...rest) =>
      patch.id === second.id && throws-- > 0
        ? Promise.reject(new Error("connection reset"))
        : settleIf(patch, ...rest);
    await sweep(app);
    assertEquals((await app.store.getPatch(second.id))!.landed, null);
    // The settle threw halfway, so its record is due again once its retry comes round: that
    // sweep settles the second as the merge would have, keeping where it merged.
    app.clock.advance(MERGE_SETTLE_RETRY_MS);
    await sweep(app);
    const settled = (await app.store.getPatch(second.id))!;
    assertEquals([settled.landed?.kind, settled.landed?.mergedInto], ["merged", "main"]);
    app.clock.advance(LANDING_GRACE_MS + 1);
    await sweep(app);
    for (const { taskId, runId } of [run, other]) {
      const task = (await app.store.getTask(taskId))!;
      assertEquals([task.repos[0].ref, task.landings.app?.work?.onto], ["main", "main"]);
      assertEquals((await cues(app, runId)).map((c) => c!.onto), ["main"]);
    }
  },
);

test("a landing that keeps throwing is asked again only after its cooldown", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const first = await ship(app, run, "a".repeat(40));
  app.pulls.set(first.forgeRef!, { state: "closed", merged: true, base: "main" });
  const calls = failLanding(app, 3);
  await sweep(app);
  assertEquals(calls.asked, 1);
  app.clock.advance(LANDING_GRACE_MS + 1);
  await sweep(app);
  assertEquals(calls.asked, 2);
  // Left alone for the cooldown, however many ticks pass.
  for (let i = 0; i < 3; i++) {
    app.clock.advance(LANDING_COOLDOWN_MS / 4);
    await sweep(app);
  }
  assertEquals(calls.asked, 2);
  app.clock.advance(LANDING_COOLDOWN_MS / 4);
  await sweep(app);
  assertEquals(calls.asked, 3);
  app.clock.advance(LANDING_COOLDOWN_MS);
  await sweep(app);
  assertEquals(calls.asked, 4);
  assertEquals((await app.store.getTask(run.taskId))!.landings.app?.work?.onto, "main");
  assertEquals((await cues(app, run.runId)).map((c) => c!.onto), ["main"]);
});

test(
  "the sweep goes on past a patch that throws: the poll, the reconciles and the cues still run",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.pulls.set(first.forgeRef!, { state: "closed", merged: true });
    const nextId = await approveNext(app, run, "b".repeat(40));
    // The next patch's claim throws, every time.
    const save = app.store.savePatchIfState.bind(app.store);
    app.store.savePatchIfState = (patch, ...rest) =>
      patch.id === nextId && patch.state === "submitting"
        ? Promise.reject(new Error("deadlock"))
        : save(patch, ...rest);
    const reads = app.asked.length;
    await sweep(app);
    // The merge was still heard, landed and cued on the same tick.
    assertEquals(readsSince(app, reads), [first.forgeRef!]);
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "merged");
    assertEquals((await app.store.getTask(run.taskId))!.landings.app?.work?.onto, "main");
    assertEquals((await cues(app, run.runId)).map((c) => c!.patchId), [first.id]);
  },
);

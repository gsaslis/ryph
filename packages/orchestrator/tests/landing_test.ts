import { afterAll, test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// The control plane's half of landing: a run's patch merges, and the merge LANDS
// (core/landing.ts). The repo moves onto the branch the change request merged into — in the task
// and in the live run's spec, each in its own spelling — a change request the task worked is done
// with, and the merged cue tells the runner where to advance, once. Everything after follows from
// that: the next patch opens a fresh change request against the target, a patch of the landed
// generation is never published on its own (core/landing_rule.ts) and no work is thrown away,
// and nothing else on the same thread moves.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "@zod/zod";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { drizzleTaskStore } from "../src/adapters/store/drizzle.ts";
import { makeTestDb } from "./db.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import { sweepMemoryFates, sweepPatches } from "../src/core/reaper.ts";
import {
  DEFAULT_PATCH_SUBMIT_CONFIG,
  HELD_REASON,
  HELD_REASON_ENDED,
  isLandingHold,
  isPatchWaiting,
  landedSiblingOf,
  landedVerdict,
  submissionTarget,
  unrebasedReason,
} from "../src/core/patch_lifecycle.ts";
import {
  cueOnto,
  hasLanding,
  landMerge,
  lineBase,
  lineBasesOf,
  releaseGeneration,
} from "../src/core/landing.ts";
import { applyLandingRule, heldNote, releasedNote } from "../src/core/landing_rule.ts";
import {
  cueMerged,
  LANDING_GRACE_MS,
  MERGE_SETTLE_RETRY_MS,
  MERGED_CUE_LEASE_MS,
  reconcileMergeSettles,
  settleOnce,
} from "../src/core/merge_settle.ts";
import {
  reconcileMergeReleases,
  RELEASE_RETRY_MS,
  releasedCueNote,
} from "../src/core/merge_release.ts";
import { MERGE_ASK_DEADLINE_MS } from "../src/core/merge_record.ts";
import type { Patch, PatchPayload, Run, Task } from "../src/core/types.ts";
import type { TaskStore } from "../src/ports/task_store.ts";
import type { MemoryAccess } from "../src/ports/memory_access.ts";
import type {
  ChangeRequestHeadOutcome,
  ForgeRepoRef,
  ForgeThreadContext,
  ForgeThreadOutcome,
  MergeContainmentOutcome,
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

/** #7: an open pull request from `feat/scheduler` into main. #13: one whose base names no branch
 * a run could fetch (its own head). #14: stacked on
 * `feature-a`. */
function threadFor(ref: string): ForgeThreadOutcome {
  // #14 is stacked: opened against feature-a, which merges first; GitHub then retargets #14.
  const over = ref === "13"
    ? { baseRef: "feat/scheduler" }
    : ref === "14"
    ? { baseRef: "feature-a" }
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
    changeRequest: {
      ref,
      url: `https://github.com/acme/app/pull/${ref}`,
      state: "open" as const,
      merged: false,
      headRef: "feat/scheduler",
      headSha: "b".repeat(40),
      authorHeadSha: "b".repeat(40),
      headRepoRef: "acme/app",
      baseRef: "main",
      defaultBranch: "main",
      ...over,
    },
  };
  return { kind: "thread", thread };
}

// The suite runs on the in-memory store by default, and on the drizzle store over a real
// Postgres with RYPH_TEST_DB=postgres://… (tests/db.ts: a database of its own for every app).
// There the connection outlives the test that opened it until the next one closes it, so the
// sanitizers are off.
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

async function buildApp(wrap: (store: TaskStore) => TaskStore = (s) => s) {
  const store = wrap(await baseStore());
  const clock = fakeClock();
  const { provisioner, launches } = fakeProvisioner();
  const identities = fakeIdentityDirectory();
  // Which pushed heads a merge contained, as the forge's git answers: every one unless a test
  // says otherwise.
  const containment: {
    answer:
      | ((
        ask: { mergedHeads: string[]; heads: string[] },
      ) => MergeContainmentOutcome | Promise<MergeContainmentOutcome>)
      | null;
  } = { answer: null };
  // Whether a newborn holds the tip its line merged at, as the forge reads its bundle: held
  // unless a test says otherwise.
  const lineage: { holdsTip: boolean } = { holdsTip: true };
  // What the forge's read of a change request says, where a test asks it: the stand-in's own
  // answer otherwise.
  const changeRequestHead: { answer: ((ref: string) => ChangeRequestHeadOutcome) | null } = {
    answer: null,
  };
  const forge = noopForge(silentDiagnostics(), {
    permission: "allowed",
    repos: [REPO_LISTING],
    thread: threadFor,
    changeRequestHead: (ref: string) =>
      changeRequestHead.answer?.(ref) ?? {
        kind: "head",
        head: {
          ref,
          state: "open",
          merged: false,
          headSha: "0".repeat(40),
          authorHeadSha: "0".repeat(40),
          baseRef: "main",
          openedByUs: false,
          mergedHeads: [],
        },
      },
    mergeContainment: (ask: { repo: ForgeRepoRef; mergedHeads: string[]; heads: string[] }) =>
      containment.answer?.(ask) ??
        { kind: "answered", contained: [...ask.heads], missed: [] },
    patchLineage: (ask) => ({
      kind: "answered",
      overlaps: [],
      ...(ask.mustHold === undefined ? {} : { holdsTip: lineage.holdsTip }),
    }),
  });
  // Memory, recording each patch's fate as it is told — the claims of a run wait on them.
  const fates: Array<{ patchId: string; fate: string }> = [];
  // And each patch record it is sent, with what the patch carries.
  const reports: Array<{ patchId: string; carries: string[] }> = [];
  const memoryAccess = {
    composeBrief: () => Promise.resolve(null),
    reportOutcome: () => Promise.resolve(),
    reportPatch: (_runId: string, record: { patchId: string; carries: string[] }) => (
      reports.push({ patchId: record.patchId, carries: [...record.carries] }), Promise.resolve()
    ),
    reportChange: (_runId: string, patchId: string, fate: string) => (
      fates.push({ patchId, fate }), Promise.resolve()
    ),
    reportStale: () => Promise.resolve(),
  } as unknown as MemoryAccess;
  // The forge's diffs, as a person's approval measures them: every patch measured from "0…0".
  const patchDiffs = {
    readPatchDiff: (_repo: unknown, _url: string, ask: { headSha: string }) =>
      Promise.resolve({
        kind: "diff" as const,
        diff: "",
        baseSha: "0".repeat(40),
        headSha: ask.headSha,
        truncated: false,
        omitted: [],
        moreOmitted: false,
      }),
  };
  const deps = {
    store,
    provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate: (() => Promise.resolve(USER)) as unknown as Authenticate,
    forgeToken: "forge-service-token",
    forge,
    githubConnect: forge,
    identityDirectory: identities.directory,
    memoryAccess,
    patchDiffs,
    now: clock.now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: GATEWAY,
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
      platformTools: {
        webServerId: "ms-platform-web",
        web: false,
        forge: null,
        pending: false,
      },
    },
  };
  return {
    handler: makeHandler(deps),
    deps,
    store,
    clock,
    launches,
    forge,
    identities,
    fates,
    reports,
    containment,
    changeRequestHead,
    lineage,
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

const CLOCKS = { idleMs: 300_000, attendedIdleMs: 1_800_000 };

/** Link, install, connect, mint the agent: what every start needs. */
async function prepare(app: App) {
  app.identities.link(USER.userId, "noop-ada-lovelace");
  await post(app.handler, "/v1/installations", { installationId: "42" });
  const repo = await (await post(app.handler, "/v1/connected-repos", {
    installationId: "42",
    repoRef: "acme/app",
  })).json();
  const agent = await (await post(app.handler, "/v1/agents", {
    name: "Ada",
    email: "ada@example.com",
    harnessKind: "pi",
  })).json();
  return { repo, agent };
}

/**
 * A live run on a change request. Through the app's own door by default — the task spells the
 * branches qualified (`refs/heads/…`) — or `retargeted` mid-run, which spells them bare.
 */
async function runOnChangeRequest(
  app: App,
  opts: { thread?: string; retargeted?: boolean } = {},
) {
  const thread = opts.thread ?? "7";
  const { repo, agent } = await prepare(app);
  const created = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Address the review", instructions: "Do what the review says." },
    connectedRepoId: repo.id,
    ...(opts.retargeted ? {} : { targetChangeRequest: { connectedRepoId: repo.id, thread } }),
    lifetime: CLOCKS,
  });
  assertEquals(created.status, 201, await created.clone().text());
  const { taskId, runId } = await created.json();
  const runToken = (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN;
  await post(app.handler, `/v1/runs/${runId}/heartbeat`, { seq: 0, phase: "running" }, runToken);
  if (opts.retargeted) {
    const moved = await post(
      app.handler,
      `/v1/runs/${runId}/target`,
      { path: "app", changeRequest: thread },
      runToken,
    );
    assertEquals(moved.status, 200, await moved.clone().text());
  }
  return { taskId, runId, runToken, repo, agent };
}

const BRANCH = (
  runId: string,
  connectedRepoId: string,
  sha: string,
  generation = 1,
  line = "work",
) => ({
  connectedRepoId,
  path: "app",
  name: generation === 1 ? `ryph/ada/${runId}/${line}` : `ryph/ada/${runId}/${line}-${generation}`,
  line,
  headSha: sha,
  commits: [{ sha, subject: `work ${sha.slice(0, 1)}` }],
  generation,
  carries: [],
});

/** A patch born through the runner's route; approved and swept onto the forge unless told not. */
async function ship(
  app: App,
  run: { runId: string; runToken: string; repo: { id: string } },
  sha: string,
  opts: { generation?: number; approve?: boolean; line?: string } = {},
): Promise<Patch> {
  const born = await post(app.handler, `/v1/runs/${run.runId}/patches`, {
    branch: BRANCH(run.runId, run.repo.id, sha, opts.generation ?? 1, opts.line),
    baseSha: "0".repeat(40),
  }, run.runToken);
  assertEquals(born.status, 201, await born.clone().text());
  const { patchId } = await born.json();
  if (opts.approve !== false) {
    assertEquals((await post(app.handler, `/v1/patches/${patchId}/approve`)).status, 200);
    await sweep(app);
  }
  return (await app.store.getPatch(patchId))!;
}

const sweep = (app: App, store: TaskStore = app.store) =>
  sweepPatches({
    store,
    forge: app.forge,
    identityDirectory: app.identities.directory,
    diag: silentDiagnostics(),
    memoryAccess: app.deps.memoryAccess,
    now: app.clock.now,
  }, DEFAULT_PATCH_SUBMIT_CONFIG);

/** A person's decision made from the patch's page: with the basis its diff was read against. */
async function decide(app: App, patchId: string, action: "approve" | "retry") {
  const page = await (await app.handler(
    new Request(`http://orchestrator.test/v1/patches/${patchId}`, {
      headers: { authorization: "Bearer t" },
    }),
  )).json();
  return await post(app.handler, `/v1/patches/${patchId}/${action}`, {
    diffBasis: { ...page.diffBasis, baseSha: "0".repeat(40) },
  });
}

let delivery = 0;
/** The head a merge names unless a test names its own: one the default containment holds every
 * pushed head inside. */
const MERGED_HEAD = "f".repeat(40);
/** One delivery of a change request's fate, as the forge sends it — a merge naming the branch it
 * merged into unless told not to (`base: null`), and the heads that merged. Answers the
 * response, whatever it is. */
function deliver(
  app: App,
  kind: "merged" | "closed",
  thread: string,
  opts: { base?: string | null; heads?: string[]; deliveryId?: string } = {},
) {
  const base = opts.base === undefined ? "main" : opts.base;
  const merged = {
    ...(base === null ? {} : { baseRef: base }),
    heads: opts.heads ?? [MERGED_HEAD],
  };
  return post(app.handler, "/v1/forge/events", {
    deliveryId: opts.deliveryId ?? `d-${++delivery}`,
    kind: `change_request.${kind}`,
    repo: { provider: "github", repoRef: REPO_LISTING.fullName, url: REPO_LISTING.url },
    actorLogin: "grace",
    thread: { kind: "change_request", ref: thread },
    body: null,
    sourceCommentId: null,
    ...(kind === "merged" ? { merged } : {}),
    receivedAt: "2026-01-01T00:00:00.000Z",
  }, "forge-service-token");
}
async function forgeEvent(
  app: App,
  kind: "merged" | "closed",
  thread: string,
  opts: { base?: string | null; heads?: string[] } = {},
) {
  const res = await deliver(app, kind, thread, opts);
  assertEquals(res.status, 200, await res.clone().text());
  const body = await res.json();
  // The delivery only records a merge: the submit sweep's reconciles settle it.
  if (kind === "merged") await settle(app);
  return body;
}

/** What the submit sweep does with a recorded merge, alone: its releases, and its settle — the
 * app's own asks under way, and every answer the stand-in forge gives at once used at once. */
async function settle(app: App, store: TaskStore = app.store) {
  const deps = {
    store,
    forge: app.forge,
    diag: silentDiagnostics(),
    memoryAccess: app.deps.memoryAccess,
    now: app.clock.now,
  };
  await reconcileMergeReleases(deps);
  await reconcileMergeSettles(deps, { waitMs: 1_000 });
}

/** The merged cues the run heard, as the runner reads them. */
async function mergedCues(app: App, runId: string) {
  return (await app.store.listRunMessages(runId))
    .map((m) => m.payload as PatchPayload | null)
    .filter((p) => p?.kind === "patch" && p.state === "merged");
}

/** What the run was told in words alone (no payload), oldest first. */
async function textNotes(app: App, runId: string) {
  return (await app.store.listRunMessages(runId)).filter((m) => m.payload === null);
}

/** Waits, a bounded time, until `cond` holds: for work a sweep left running past its wait. */
async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!await cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A live run on its own pull request: an ordinary task on `ref` of the repo. */
async function ownRun(app: App, ref?: string) {
  const { repo, agent } = await prepare(app);
  const created = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Fix it", instructions: "Fix the bug." },
    connectedRepoId: repo.id,
    ...(ref === undefined ? {} : { ref }),
    lifetime: CLOCKS,
  });
  assertEquals(created.status, 201, await created.clone().text());
  const { taskId, runId } = await created.json();
  const runToken = (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN;
  await post(app.handler, `/v1/runs/${runId}/heartbeat`, { seq: 0, phase: "running" }, runToken);
  return { taskId, runId, runToken, repo, agent };
}

/** Ends a run with its result, as the runner reports one. */
const end = (app: App, run: { runId: string; runToken: string }, branches: unknown[] = []) =>
  post(app.handler, `/v1/runs/${run.runId}/result`, {
    status: "success",
    summary: "done",
    branches,
  }, run.runToken);

// ---- the pure apply -------------------------------------------------------

function pair(targetRef: string | undefined = "refs/heads/main"): { task: Task; run: Run } {
  const task = {
    id: "t-1",
    repos: [
      {
        connectedRepoId: "cr-1",
        path: "app",
        ref: "refs/heads/feat/scheduler",
        ...(targetRef === undefined ? {} : { targetRef }),
      },
      { connectedRepoId: "cr-2", path: "web", ref: "main" },
    ],
    targetChangeRequest: { connectedRepoId: "cr-1", thread: "7" },
    landings: {},
  } as unknown as Task;
  const run = {
    id: "r-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    workItem: {
      repos: [
        {
          connectedRepoId: "cr-1",
          path: "app",
          ref: "feat/scheduler",
          ...(targetRef === undefined ? {} : { targetRef: targetRef.replace("refs/heads/", "") }),
        },
        { connectedRepoId: "cr-2", path: "web", ref: "main" },
      ],
    },
  } as unknown as Run;
  return { task, run };
}
const PATCH = {
  connectedRepoId: "cr-1",
  path: "app",
  line: "work",
  forgeRef: "7",
  runId: "r-1",
  generation: 1,
};
const AT = "2026-01-02T00:00:00.000Z";
const land = (
  task: Task,
  run: Run | null,
  mergedInto: string | undefined,
  patch: typeof PATCH = PATCH,
) => landMerge({ task, run, patch, mergedInto, defaultBranch: "main", at: AT });

test(
  "the apply moves the repo onto where the forge says it merged, each list in its own spelling",
  () => {
    const { task, run } = pair();
    const out = land(task, run, "main");
    assert(out.kind === "landed");
    assertEquals(
      out.task.repos,
      [
        { connectedRepoId: "cr-1", path: "app", ref: "refs/heads/main" },
        { connectedRepoId: "cr-2", path: "web", ref: "main" },
      ] as unknown as Task["repos"],
    );
    assertEquals(out.task.targetChangeRequest, null);
    const landing = {
      connectedRepoId: "cr-1",
      thread: "7",
      onto: "main",
      generation: 1,
      moved: true,
      at: AT,
    };
    assertEquals(out.task.landings, { app: { work: landing } });
    assertEquals(
      out.run!.workItem.repos[0],
      { connectedRepoId: "cr-1", path: "app", ref: "main" } as never,
    );
    assertEquals(out.event?.detail, "#7 merged into main; app now on main");
    // Without the run (it ended), the task moves alone.
    const alone = land(task, null, "main");
    assert(alone.kind === "landed");
    assertEquals(alone.run, null);
    // The cue reads the landing for the patch's repo.
    assertEquals(cueOnto(out.task.landings, PATCH), "main");
    assertEquals(cueOnto(out.task.landings, { ...PATCH, path: "web" }), undefined);
  },
);

test(
  "the apply always finds a branch: the forge's, else the recorded base, else the default or the repo's own",
  () => {
    // A stacked change request the forge says merged elsewhere: the forge wins, both are named.
    const stacked = pair("refs/heads/feature-a");
    const out = land(stacked.task, stacked.run, "main");
    assert(out.kind === "landed");
    assertEquals(out.landing.onto, "main");
    assertEquals(
      out.event?.detail,
      "#7 merged into main; app now on main (the task had feature-a)",
    );
    // The forge said nothing, or a name no checkout can stand on: the recorded base.
    for (const said of [undefined, "-oops"]) {
      const fallback = land(stacked.task, stacked.run, said);
      assert(fallback.kind === "landed");
      assertEquals(fallback.landing.onto, "feature-a");
    }
    // A change request the task worked with no recorded base: the repo's default branch.
    const bare = pair(undefined);
    const worked = land(bare.task, bare.run, undefined);
    assert(worked.kind === "landed");
    assertEquals(worked.landing.onto, "main");
    // The run's own pull request, merged into its own base: nothing moves, and it is recorded.
    const own = {
      ...bare.task,
      repos: [{ connectedRepoId: "cr-1", path: "app", ref: "develop" }],
      targetChangeRequest: null,
    } as unknown as Task;
    const ownLanded = land(own, null, undefined, { ...PATCH, forgeRef: "12" });
    assert(ownLanded.kind === "landed");
    assertEquals([ownLanded.landing.onto, ownLanded.task.repos[0].ref, ownLanded.event], [
      "develop",
      "develop",
      null,
    ]);
  },
);

test(
  "the apply never moves a repo back for an older generation, and records a generation once",
  () => {
    const { task, run } = pair();
    const second = land(task, run, "release", { ...PATCH, generation: 2, forgeRef: "9" });
    assert(second.kind === "landed");
    const late = land(second.task, run, "main", PATCH);
    assertEquals(late, { kind: "kept", landing: second.landing });
    const again = land(second.task, run, "main", { ...PATCH, generation: 2, forgeRef: "10" });
    assertEquals(again.kind, "kept");
    // A patch that never reached the forge, or a repo not in the checkout: nothing.
    assertEquals(
      land(task, run, "main", { ...PATCH, forgeRef: null as unknown as string }).kind,
      "none",
    );
    assertEquals(land(task, run, "main", { ...PATCH, path: "nope" }).kind, "none");
  },
);

test("a landing records the tip the forge read only where it merged into the branch it lands on", () => {
  const { task, run } = pair();
  const tip = "f".repeat(40);
  const at = (mergedInto: string | undefined, patch = PATCH, on = task) =>
    landMerge({ task: on, run, patch, mergedInto, defaultBranch: "main", intoTip: tip, at: AT });
  const merged = at("refs/heads/main");
  assert(merged.kind === "landed");
  assertEquals([merged.landing.onto, merged.landing.tip], ["main", tip]);
  // The forge's word refused: the landing falls back to another branch, whose tip nobody read.
  const fallback = at("-oops");
  assert(fallback.kind === "landed");
  assertEquals([fallback.landing.onto, fallback.landing.tip], ["main", undefined]);
  // A later generation's landing replaces the record whole, its tip with it.
  const later = land(merged.task, run, "main", { ...PATCH, generation: 2, forgeRef: "9" });
  assert(later.kind === "landed");
  assertEquals(later.landing.tip, undefined);
  const again = at("main", { ...PATCH, generation: 3, forgeRef: "10" }, later.task);
  assert(again.kind === "landed");
  assertEquals(again.task.landings.app.work.tip, tip);
});

test(
  "a merge of a line other than the default moves that line alone, never the repo or the target",
  () => {
    // A task working #7 (head feat/scheduler, base main), whose run shipped a line of its own
    // that merged — retargeted to `release` before it did.
    const { task, run } = pair();
    const line = { ...PATCH, line: "fix-a", forgeRef: "8" };
    const out = land(task, run, "release", line);
    assert(out.kind === "landed");
    // The repo, its target base, the run's spec and the task's change request are all as they
    // were: the default line still pushes onto #7, whose head the forge would otherwise refuse.
    assertEquals(out.task.repos, task.repos);
    assertEquals(out.task.targetChangeRequest, task.targetChangeRequest);
    assertEquals(out.run, null);
    // The line's landing records where it went, and is that line's next base and cue.
    assertEquals(out.task.landings, { app: { "r-1/fix-a": out.landing } });
    assertEquals([out.landing.onto, out.landing.moved], ["release", true]);
    assertEquals(cueOnto(out.task.landings, line), "release");
    assertEquals(cueOnto(out.task.landings, PATCH), undefined);
    assertEquals(lineBase(out.task.repos[0], out.task.landings, "fix-a", "r-1"), "release");
    assertEquals(
      lineBase(out.task.repos[0], out.task.landings, "work", "r-1"),
      "refs/heads/feat/scheduler",
    );
    assertEquals(lineBase(out.task.repos[0], out.task.landings, "docs", "r-1"), "refs/heads/main");
    // A fork pull request's head: every line stands on the fork's head, which the forge refuses
    // as a base for anything but that pull request — a line that got past birth still could not
    // become a change request of its own.
    const fork = { ...out.task.repos[0], ref: "refs/pull/7/head", forkHead: true };
    for (const l of ["work", "fix-a", "docs"]) {
      assertEquals(lineBase(fork, out.task.landings, l, "r-1"), "refs/pull/7/head");
    }
    assertEquals(
      out.event?.detail,
      "#8 merged into release; the fix-a line of app now on release (it was on main)",
    );
    // The gateway refreshes where it went, beside the repo's own two branches.
    assertEquals(lineBasesOf(out.task.repos[0], out.task.landings, "r-1"), {
      lineBases: ["release"],
    });
    // Another run's line of the same name is other work: none of this is its base, or its cue.
    assertEquals(lineBase(out.task.repos[0], out.task.landings, "fix-a", "r-2"), "refs/heads/main");
    assertEquals(lineBasesOf(out.task.repos[0], out.task.landings, "r-2"), {});
    assertEquals(cueOnto(out.task.landings, { ...line, runId: "r-2" }), undefined);
    assertEquals(hasLanding(out.task.landings, { ...line, runId: "r-2" }), false);
    assertEquals(hasLanding(out.task.landings, line), true);
    // Merged into the base it was opened against: nothing moved, and it is still recorded.
    const home = land(task, run, undefined, line);
    assert(home.kind === "landed");
    assertEquals([home.landing.onto, home.landing.moved, home.event], ["main", false, null]);
    assertEquals(lineBasesOf(home.task.repos[0], home.task.landings, "r-1"), {});
    // Its next generation lands from where the last one went.
    const next = land(out.task, run, undefined, { ...line, forgeRef: "9", generation: 2 });
    assert(next.kind === "landed");
    assertEquals([next.landing.onto, next.landing.moved], ["release", false]);
    // And the default line's merge then moves the repo, leaving the other line's record alone.
    const work = land(out.task, run, "main");
    assert(work.kind === "landed");
    assertEquals(work.task.repos[0].ref, "refs/heads/main");
    assertEquals(work.task.targetChangeRequest, null);
    assertEquals(work.task.landings.app?.["r-1/fix-a"], out.landing);
  },
);

test(
  "another run's merge of a line of the same name records its own landing and leaves this run's",
  () => {
    // Two runs of one task, each with a line called `fix-a`: unrelated work sharing a word. R2's
    // landed first, into `hotfix`; R1's lands after, into `release`.
    const { task, run } = pair();
    const r1 = { ...PATCH, line: "fix-a", forgeRef: "8" };
    const r2 = { ...PATCH, line: "fix-a", forgeRef: "11", runId: "r-2" };
    const first = land(task, null, "hotfix", r2);
    assert(first.kind === "landed");
    const second = land(first.task, run, "release", r1);
    assert(second.kind === "landed");
    // Not `kept`: R2's landing at generation 1 is not R1's.
    assertEquals(second.landing.onto, "release");
    const landings = second.task.landings;
    assertEquals(landings.app?.["r-2/fix-a"], first.landing);
    assertEquals(landings.app?.["r-1/fix-a"], second.landing);
    // Each run reads its own: base, cue, landing and the gateway's refreshed bases.
    const entry = second.task.repos[0];
    assertEquals(lineBase(entry, landings, "fix-a", "r-2"), "hotfix");
    assertEquals(lineBase(entry, landings, "fix-a", "r-1"), "release");
    assertEquals(cueOnto(landings, r2), "hotfix");
    assertEquals(cueOnto(landings, r1), "release");
    assert(hasLanding(landings, r2) && hasLanding(landings, r1));
    assertEquals(lineBasesOf(entry, landings, "r-2"), { lineBases: ["hotfix"] });
    assertEquals(lineBasesOf(entry, landings, "r-1"), { lineBases: ["release"] });
  },
);

test("a merge never lands on a branch of the merged patch's own run, a later run's included", () => {
  // The task's entry names the first run's namespace; a later run's is refused all the same.
  const { task } = pair();
  const later = "ryph/ada/r-2";
  const r2 = { ...PATCH, line: "fix-a", forgeRef: "11", runId: "r-2" };
  const out = landMerge({
    task,
    run: null,
    patch: r2,
    mergedInto: `${later}/work`,
    defaultBranch: "main",
    at: AT,
    runNamespace: later,
  });
  assert(out.kind === "landed");
  assertEquals(out.landing.onto, "main");
});

test("a merge never lands on any run's namespace, another live run's included", () => {
  // r-1's merge into a branch of r-2 — a later run of the task, live and writing its own
  // namespace — is refused like r-1's own: neither namespace is the entry's or the patch's run's.
  const { task } = pair();
  for (const mergedInto of ["ryph/ada/r-2/work", "ryph/other/r-9z/fix-a-2", "ryph/ada/r-2"]) {
    const out = landMerge({
      task,
      run: null,
      patch: { ...PATCH, forgeRef: "11" },
      mergedInto,
      defaultBranch: "main",
      at: AT,
      runNamespace: "ryph/ada/r-1",
    });
    assert(out.kind === "landed");
    assertEquals(out.landing.onto, "main", mergedInto);
  }
});

// ---- through the forge event ----------------------------------------------

test(
  "a merge lands the task's change request for the task and its live run, and the cue says where",
  async () => {
    for (const retargeted of [false, true]) {
      const app = await buildApp();
      const run = await runOnChangeRequest(app, { retargeted });
      const first = await ship(app, run, "a".repeat(40));
      assertEquals([first.forgeRef, first.forgeBranch], ["7", "feat/scheduler"]);

      assertEquals((await forgeEvent(app, "merged", "7")).outcome, "patch-settled");

      const task = (await app.store.getTask(run.taskId))!;
      assertEquals(task.targetChangeRequest, null);
      assertEquals(task.landings.app?.work?.onto, "main");
      assertEquals(
        task.repos.map((r) => [r.ref, r.targetRef]),
        [[retargeted ? "main" : "refs/heads/main", undefined]],
      );
      const live = (await app.store.getRun(run.runId))!;
      assertEquals(live.workItem.repos.map((r) => [r.ref, r.targetRef]), [["main", undefined]]);
      assertEquals(
        (await app.store.listEvents(run.runId)).filter((e) => e.kind === "merge-landed")
          .map((e) => e.detail),
        ["#7 merged into main; app now on main"],
      );
      assertEquals((await mergedCues(app, run.runId)).map((c) => [c!.patchId, c!.onto]), [[
        first.id,
        "main",
      ]]);
      assertStringIncludes(
        (await app.store.listRunMessages(run.runId)).at(-1)!.text,
        "rebase what you did after it onto `origin/main`: ryph adds a note with the exact " +
          "command; if there is none, call ryph__update_from_base. Your next submit_patch " +
          "opens a new change request.",
      );
      assertEquals((await app.store.findLiveRunOnChangeRequest(run.repo.id, "7"))?.id, run.runId);
    }
  },
);

test(
  "a run's own pull request stacked on a branch that merged first follows it to where it merged",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app, "feature-a");
    const first = await ship(app, run, "a".repeat(40));
    assertEquals(app.forge.submissions.at(-1)!.baseBranch, "feature-a");
    // feature-a merged and was deleted; GitHub retargeted the pull request onto main.
    await forgeEvent(app, "merged", first.forgeRef!, { base: "main" });
    const task = (await app.store.getTask(run.taskId))!;
    assertEquals(task.repos[0].ref, "main");
    assertEquals((await mergedCues(app, run.runId)).map((c) => c!.onto), ["main"]);
    await ship(app, run, "c".repeat(40), { generation: 2 });
    assertEquals(app.forge.submissions.at(-1)!.baseBranch, "main");
  },
);

test(
  "in a task working a change request, another line opens against its base and lands on its own",
  async () => {
    const app = await buildApp();
    const run = await runOnChangeRequest(app);
    const work = await ship(app, run, "a".repeat(40));
    assertEquals([work.forgeRef, work.forgeBranch], ["7", "feat/scheduler"]);
    // A line of its own: a pull request against where #7 merges, never against #7's head.
    const fix = await ship(app, run, "b".repeat(40), { line: "fix-a" });
    const opened = app.forge.submissions.at(-1)!;
    assertEquals([opened.baseBranch, opened.changeRequest], ["main", undefined]);
    assert(fix.forgeRef !== null && fix.forgeRef !== "7");
    // It merges into `release` (retargeted on the forge first): only that line moved.
    await forgeEvent(app, "merged", fix.forgeRef, { base: "release", heads: [fix.headSha] });
    const task = (await app.store.getTask(run.taskId))!;
    assertEquals(task.targetChangeRequest, { connectedRepoId: run.repo.id, thread: "7" });
    assertEquals(
      task.repos.map((r) => [r.ref, r.targetRef]),
      [["refs/heads/feat/scheduler", "refs/heads/main"]],
    );
    const live = (await app.store.getRun(run.runId))!;
    assertEquals(
      live.workItem.repos.map((r) => [r.ref, r.targetRef]),
      [["feat/scheduler", "main"]],
    );
    assertEquals(
      (await mergedCues(app, run.runId)).map((c) => [c!.patchId, c!.line, c!.onto]),
      [[fix.id, "fix-a", "release"]],
    );
    // The line's next generation opens against where it went; the default line still pushes
    // onto #7, which the forge would refuse had the merge dropped the task's base.
    await ship(app, run, "c".repeat(40), { line: "fix-a", generation: 2 });
    const next = app.forge.submissions.at(-1)!;
    assertEquals([next.baseBranch, next.changeRequest], ["release", undefined]);
    const more = await ship(app, run, "d".repeat(40));
    assertEquals([more.forgeRef, more.forgeBranch], ["7", "feat/scheduler"]);
    // And a third line still starts from #7's base.
    await ship(app, run, "e".repeat(40), { line: "docs" });
    assertEquals(app.forge.submissions.at(-1)!.baseBranch, "main");
  },
);

test("a line's birth: its own bundle, its own head, the generation its name spells", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const birth = (branch: Record<string, unknown>) =>
    post(
      app.handler,
      `/v1/runs/${run.runId}/patches`,
      { branch, baseSha: "0".repeat(40) },
      run.runToken,
    );
  const work = await ship(app, run, "a".repeat(40), { approve: false });
  // Filed per branch: two lines at one head could never overwrite each other's bundle.
  assertEquals(work.bundleKey, `${run.runId}/work/${run.repo.id}/${"a".repeat(40)}.bundle`);
  const second = await ship(app, run, "b".repeat(40), {
    approve: false,
    line: "fix-a",
    generation: 2,
  });
  assertEquals(second.bundleKey, `${run.runId}/fix-a-2/${run.repo.id}/${"b".repeat(40)}.bundle`);
  // Another line at a head a line already shipped: refused, naming that line — no second row.
  const twin = await birth(BRANCH(run.runId, run.repo.id, "a".repeat(40), 1, "docs"));
  assertEquals(twin.status, 400);
  assertStringIncludes((await twin.json()).error, `the commit line "work" already shipped`);
  // A generation its branch's name does not spell: refused.
  const skewed = await birth({
    ...BRANCH(run.runId, run.repo.id, "c".repeat(40), 2),
    generation: 3,
  });
  assertEquals(skewed.status, 400);
  assertStringIncludes((await skewed.json()).error, "is not generation 3 of line");
  // A qualified spelling of the run's branch is the same branch, kept bare.
  const qualified = await birth({
    ...BRANCH(run.runId, run.repo.id, "d".repeat(40), 1, "docs"),
    name: `refs/heads/ryph/ada/${run.runId}/docs`,
  });
  assertEquals(qualified.status, 201, await qualified.clone().text());
  const { patchId } = await qualified.json();
  const docs = (await app.store.getPatch(patchId))!;
  assertEquals(docs.branchName, `ryph/ada/${run.runId}/docs`);
  assertEquals(docs.bundleKey, `${run.runId}/docs/${run.repo.id}/${"d".repeat(40)}.bundle`);
});

test("the line cap holds against births of new lines racing each other", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const lines = ["work", "l1", "l2", "l3", "l4", "l5", "l6"];
  for (const [i, line] of lines.entries()) {
    await ship(app, run, String(i + 1).repeat(40), { approve: false, line });
  }
  // Two new lines at once, with room for one: one is born, the other refused.
  const births = await Promise.all(
    ["x1", "x2"].map((line, i) =>
      post(app.handler, `/v1/runs/${run.runId}/patches`, {
        branch: BRANCH(run.runId, run.repo.id, ["a", "b"][i].repeat(40), 1, line),
        baseSha: "0".repeat(40),
      }, run.runToken)
    ),
  );
  assertEquals(births.map((r) => r.status).toSorted(), [201, 400]);
  const refused = births.find((r) => r.status === 400)!;
  assertStringIncludes((await refused.json()).error, "the most one run may ship in a repo");
  assertEquals(
    new Set((await app.store.patchesForTask(run.taskId)).map((p) => p.line)).size,
    8,
  );
});

test("a late merge of an older generation never moves the repo back", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const first = await ship(app, run, "a".repeat(40));
  await forgeEvent(app, "merged", first.forgeRef!, { base: "main" });
  const second = await ship(app, run, "c".repeat(40), { generation: 2 });
  await forgeEvent(app, "merged", second.forgeRef!, { base: "release" });
  assertEquals((await app.store.getTask(run.taskId))!.repos[0].ref, "release");
  // The first merge again (a redelivery, Radicle's reconcile): the repo stays where it is.
  await forgeEvent(app, "merged", first.forgeRef!, { base: "main" });
  const task = (await app.store.getTask(run.taskId))!;
  assertEquals([task.repos[0].ref, task.landings.app?.work?.generation], ["release", 2]);
});

test("the landing is written before the cue that sends the runner to fetch it", async () => {
  const order: string[] = [];
  const app = await buildApp((store) => ({
    ...store,
    async landMerge(args) {
      const out = await store.landMerge(args);
      order.push(`land:${out.outcome.kind}`);
      return out;
    },
    async appendRunMessage(message) {
      const payload = message.payload as PatchPayload | null;
      if (payload?.kind === "patch") order.push(`cue:${payload.state}:${payload.onto}`);
      return await store.appendRunMessage(message);
    },
  }));
  const run = await runOnChangeRequest(app);
  await ship(app, run, "a".repeat(40));
  order.length = 0;
  await forgeEvent(app, "merged", "7");
  assertEquals(order, ["land:landed", "cue:merged:main"]);
});

test(
  "a crash before the landing is healed by the landing reconcile, with the right branch",
  async () => {
    let failLand = true;
    const app = await buildApp((store) => ({
      ...store,
      landMerge(args) {
        if (failLand) return Promise.reject(new Error("the process died"));
        return store.landMerge(args);
      },
    }));
    const run = await runOnChangeRequest(app);
    const first = await ship(app, run, "a".repeat(40));
    // Recorded and settled; the landing throws after the verdict was written.
    await forgeEvent(app, "merged", "7");
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "merged");
    assertEquals(await mergedCues(app, run.runId), []);
    failLand = false;
    // A redelivery names nothing new, so it is the landing reconcile that lands it.
    await forgeEvent(app, "merged", "7");
    assertEquals(await mergedCues(app, run.runId), []);
    app.clock.advance(LANDING_GRACE_MS + 1);
    await sweep(app);
    assertEquals((await mergedCues(app, run.runId)).map((c) => c!.onto), ["main"]);
  },
);

test(
  "the landing reconcile lands a generation's merged patch before an older missed one",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const older = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const newer = await ship(app, run, "b".repeat(40));
    // Both settled with their landings owed, as a crash after the verdicts leaves them: the older
    // missed on #1 (which merged into `release`), the newer merged on #2 (into main).
    const at = app.clock.now().toISOString();
    await app.store.savePatch({
      ...(await app.store.getPatch(older.id))!,
      forgeRef: "1",
      landed: { kind: "missed", at, mergedInto: "release" },
      landingAskedAt: null,
    });
    await app.store.savePatch({
      ...(await app.store.getPatch(newer.id))!,
      forgeRef: "2",
      landed: { kind: "merged", at, mergedInto: "main" },
      landingAskedAt: null,
    });
    app.clock.advance(LANDING_GRACE_MS + 1);
    await sweep(app);
    const landing = (await app.store.getTask(run.taskId))!.landings.app!.work!;
    assertEquals([landing.thread, landing.onto], ["2", "main"]);
  },
);

test(
  "a close racing the merge loses: the merge revises it, and the waiting sibling is never published",
  async () => {
    let raced = false;
    const app = await buildApp((store) => ({
      ...store,
      async settlePatchIf(patch, from, events) {
        // A `closed` delivery writes its verdict in the instant this merge read the row.
        if (!raced && patch.landed?.kind === "merged") {
          raced = true;
          const closed = { ...patch, landed: { kind: "closed" as const, at: patch.updatedAt } };
          assert(await store.settlePatchIf(closed, from, []));
        }
        return await store.settlePatchIf(patch, from, events);
      },
    }));
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const waiting = await ship(app, run, "b".repeat(40), { approve: false });
    assertEquals((await post(app.handler, `/v1/patches/${waiting.id}/approve`)).status, 200);
    await forgeEvent(app, "merged", first.forgeRef!);
    assert(raced);
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "merged");
    // Held for its run's next patch, its approval gone.
    const sibling = (await app.store.getPatch(waiting.id))!;
    assertEquals([sibling.state, sibling.approvedAt], ["pending_approval", null]);
    assert(sibling.heldReason !== null);
    const submissions = app.forge.submissions.length;
    await sweep(app);
    assertEquals(app.forge.submissions.length, submissions);
  },
);

test(
  "another task on the same thread lands nothing of its own, but is let go of the merged change request",
  async () => {
    const app = await buildApp();
    const run = await runOnChangeRequest(app);
    await ship(app, run, "a".repeat(40));
    const task = (await app.store.getTask(run.taskId))!;
    const ours = (await app.store.getRun(run.runId))!;
    await app.store.createTask(
      { ...structuredClone(task), id: "t-other" },
      { ...structuredClone(ours), id: "r-other", taskId: "t-other", state: "succeeded" },
    );
    await forgeEvent(app, "merged", "7");
    // Nothing of its own merged: no patch landed. But a follow-up must not push onto the merged
    // change request: its repo moves where the forge said, as the record's release does, and
    // the release ends its run's generation there.
    const other = (await app.store.getTask("t-other"))!;
    assertEquals([other.targetChangeRequest, other.repos[0].ref], [null, "refs/heads/main"]);
    assertEquals(
      [
        other.landings.app?.work?.onto,
        other.landings.app?.work?.generation,
        other.landings.app?.work?.releasedRun,
      ],
      ["main", 1, "r-other"],
    );
  },
);

test("a close moves nothing; the merge that follows a reopen lands", async () => {
  const app = await buildApp();
  const run = await runOnChangeRequest(app);
  await ship(app, run, "a".repeat(40));
  await forgeEvent(app, "closed", "7");
  const closed = (await app.store.getTask(run.taskId))!;
  assertEquals([closed.targetChangeRequest?.thread, closed.landings], ["7", {}]);
  await forgeEvent(app, "merged", "7");
  const merged = (await app.store.getTask(run.taskId))!;
  assertEquals([merged.targetChangeRequest, merged.repos[0].ref], [null, "refs/heads/main"]);
});

test("a run that already ended gets a task-only landing", async () => {
  const app = await buildApp();
  const run = await runOnChangeRequest(app);
  await ship(app, run, "a".repeat(40));
  await end(app, run);
  const ended = (await app.store.getRun(run.runId))!;
  await forgeEvent(app, "merged", "7");
  const task = (await app.store.getTask(run.taskId))!;
  assertEquals([task.targetChangeRequest, task.repos[0].ref], [null, "refs/heads/main"]);
  assertEquals((await app.store.getRun(run.runId))!.workItem, ended.workItem);
});

test(
  "after the landing the next generation opens a fresh change request against the target",
  async () => {
    const app = await buildApp();
    const run = await runOnChangeRequest(app);
    const first = await ship(app, run, "a".repeat(40));
    await forgeEvent(app, "merged", "7");
    const next = await ship(app, run, "c".repeat(40), { generation: 2 });
    const sent = app.forge.submissions.at(-1)!;
    assertEquals([sent.changeRequest, sent.baseBranch], [undefined, "main"]);
    assertEquals(next.forgeBranch, `ryph/ada/${run.runId}/work-2`);
    const task = (await app.store.getTask(run.taskId))!;
    const target = submissionTarget(
      task,
      await app.store.patchesForTask(task.id),
      next,
      "main",
      "github",
    );
    assertEquals([target.branch, target.changeRequest], ["main", null]);
    // The settled patch that went onto #7 is still measured on #7's branch, not on main.
    const detail = await (await app.handler(
      new Request(`http://orchestrator.test/v1/patches/${first.id}`, {
        headers: { authorization: "Bearer t" },
      }),
    )).json();
    assertEquals(detail.diffBasis.targetRef, "feat/scheduler");
    const swap = await post(
      app.handler,
      `/v1/runs/${run.runId}/target`,
      { path: "app", changeRequest: "7" },
      run.runToken,
    );
    assertEquals(swap.status, 409);
  },
);

test(
  "a fast-forward merge's next generation is born on its own, not adopted into the landed one",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const waiting = await ship(app, run, "b".repeat(40), { approve: false });
    // The sweep holds it when the merge lands, so the merge's own pass leaves it be.
    await app.store.savePatch({
      ...(await app.store.getPatch(waiting.id))!,
      state: "submitting",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    await forgeEvent(app, "merged", first.forgeRef!);
    assertEquals((await app.store.getPatch(waiting.id))!.state, "submitting");
    // Fast-forwarded: generation 2 starts on the merged tip and names generation 1's last head.
    const res = await post(app.handler, `/v1/runs/${run.runId}/patches`, {
      branch: BRANCH(run.runId, run.repo.id, "b".repeat(40), 2),
      baseSha: "0".repeat(40),
    }, run.runToken);
    assertEquals(res.status, 201, "a new patch, not the landed generation's");
    const { patchId } = await res.json();
    assert(patchId !== waiting.id);
    assertEquals((await app.store.getPatch(patchId))!.generation, 2);
    // And the sweep, once its claim lapses and it looks again, finds it replaced.
    await app.store.savePatch({
      ...(await app.store.getPatch(waiting.id))!,
      leaseExpiresAt: "2000-01-01T00:00:00.000Z",
    });
    await sweep(app);
    await sweep(app);
    const replaced = (await app.store.getPatch(waiting.id))!;
    assertEquals([replaced.state, replaced.supersededByPatchId], ["superseded", patchId]);
  },
);

test(
  "a failed patch of the landed generation is superseded at the branch's next birth; a submitting one is left to its submitter",
  async () => {
    const app = await buildApp();
    const run = await runOnChangeRequest(app);
    await ship(app, run, "a".repeat(40));
    await forgeEvent(app, "merged", "7");
    app.clock.advance(1_000);
    const failed = await ship(app, run, "b".repeat(40), { approve: false });
    // The rule carried it at birth; force the row a merge's pass could not have reached.
    await app.store.savePatch({
      ...(await app.store.getPatch(failed.id))!,
      state: "failed",
      supersededByPatchId: null,
      nextAttemptAt: null,
      lastError: "x",
    });
    app.clock.advance(1_000);
    const inFlight = await ship(app, run, "d".repeat(40), { approve: false });
    await app.store.savePatch({
      ...(await app.store.getPatch(inFlight.id))!,
      state: "submitting",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    // The branch's next birth holds its commits: the failed one is replaced by it, same generation
    // or not.
    const superseded = (await app.store.getPatch(failed.id))!;
    assertEquals([superseded.state, superseded.supersededByPatchId], ["superseded", inFlight.id]);
    await ship(app, run, "c".repeat(40), { generation: 2, approve: false });
    assertEquals((await app.store.getPatch(inFlight.id))!.state, "submitting");
  },
);

test(
  "redeliveries, concurrent or not, post the merged cue once; a lost one is posted from the outbox",
  async () => {
    let failCue = true;
    const app = await buildApp((store) => ({
      ...store,
      appendRunMessage(message) {
        const payload = message.payload as PatchPayload | null;
        if (failCue && payload?.kind === "patch" && payload.state === "merged") {
          return Promise.reject(new Error("the inbox is down"));
        }
        return store.appendRunMessage(message);
      },
    }));
    const run = await runOnChangeRequest(app);
    const first = await ship(app, run, "a".repeat(40));
    // The run cannot be told: the settle goes on, and the cue waits in its outbox.
    assertEquals((await deliver(app, "merged", "7")).status, 200);
    await settle(app);
    assertEquals((await app.store.getTask(run.taskId))!.landings.app?.work?.onto, "main");
    assertEquals(await mergedCues(app, run.runId), []);
    failCue = false;
    // Six deliveries at once while the first poster's claim still holds: none of them posts.
    await Promise.all(Array.from({ length: 6 }, () => forgeEvent(app, "merged", "7")));
    assertEquals(await mergedCues(app, run.runId), []);
    // The claim lapses; the submit sweep's outbox posts it, once, with the landing's branch.
    app.clock.advance(61_000);
    await sweep(app);
    await sweep(app);
    await Promise.all(Array.from({ length: 6 }, () => forgeEvent(app, "merged", "7")));
    assertEquals((await mergedCues(app, run.runId)).map((c) => c!.onto), ["main"]);
    assert((await app.store.getPatch(first.id))!.mergedCuedAt !== null);
  },
);

test("six concurrent deliveries of one merge store exactly one cue per patch", async () => {
  const app = await buildApp();
  const run = await runOnChangeRequest(app);
  const first = await ship(app, run, "a".repeat(40));
  app.clock.advance(1_000);
  const second = await ship(app, run, "b".repeat(40));
  await Promise.all(Array.from({ length: 6 }, () => forgeEvent(app, "merged", "7")));
  // One cue, for the newest head; the older one is marked without a post.
  const cues = await mergedCues(app, run.runId);
  assertEquals(cues.map((c) => c!.patchId), [second.id]);
  assert(cues.every((c) => c!.onto === "main"));
  assert((await app.store.getPatch(first.id))!.mergedCuedAt !== null);
  assertEquals(
    (await app.store.listEvents(run.runId)).filter((e) => e.kind === "patch-settled").length,
    2,
  );
});

test(
  "a waiting sibling at the merge is held while the run goes on, and the run's next patch replaces it",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const waiting = await ship(app, run, "b".repeat(40), { approve: false });
    await forgeEvent(app, "merged", first.forgeRef!);
    const held = (await app.store.getPatch(waiting.id))!;
    assertEquals([held.state, held.supersededByPatchId], ["pending_approval", null]);
    assertEquals(held.heldReason, HELD_REASON);
    // Where approving it would send it is read when it is shown, never stored.
    const view = await (await app.handler(
      new Request(`http://orchestrator.test/v1/patches/${waiting.id}`, {
        headers: { authorization: "Bearer t" },
      }),
    )).json();
    assertStringIncludes(view.patch?.heldDestination ?? view.heldDestination, "against main");
    // Told in words alone: a runner a version behind reads no state it does not know.
    const note = (await textNotes(app, run.runId)).at(-1)!;
    assertEquals(note.payload, null);
    assertStringIncludes(note.text, "Your patch for `app` (head `bbbbbbb`) is on hold");
    assertStringIncludes(note.text, "then call submit_patch now");
    // While the run goes on nobody may send it, with or without its diff in view.
    for (
      const res of [
        await post(app.handler, `/v1/patches/${waiting.id}/approve`),
        await decide(app, waiting.id, "approve"),
      ]
    ) {
      assertEquals(res.status, 409);
      assertEquals((await res.json()).code, "held_run_live");
    }
    // Held: memory hears nothing of it.
    assertEquals(app.fates.filter((f) => f.patchId === waiting.id), []);
    const next = await ship(app, run, "c".repeat(40), { generation: 2, approve: false });
    assertEquals(next.state, "pending_approval");
    const replaced = (await app.store.getPatch(waiting.id))!;
    assertEquals([replaced.state, replaced.supersededByPatchId], ["superseded", next.id]);
    assertEquals(app.fates.filter((f) => f.patchId === waiting.id), [{
      patchId: waiting.id,
      fate: "dropped",
    }]);
  },
);

test(
  "two waiting patches of one landed generation: only the newest is held, the older replaced by it",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const older = await ship(app, run, "b".repeat(40), { approve: false });
    app.clock.advance(1_000);
    const newer = await ship(app, run, "d".repeat(40), { approve: false });
    // A race left both waiting (the newer birth's write over the older lost): the older one failed
    // at the forge meanwhile.
    await app.store.savePatch({
      ...(await app.store.getPatch(older.id))!,
      state: "failed",
      supersededByPatchId: null,
      nextAttemptAt: "2099-01-01T00:00:00.000Z",
      lastError: "x",
    });
    await forgeEvent(app, "merged", first.forgeRef!);
    const a = (await app.store.getPatch(older.id))!;
    const b = (await app.store.getPatch(newer.id))!;
    assertEquals([a.state, a.supersededByPatchId], ["superseded", newer.id]);
    assertEquals([b.state, b.heldReason !== null], ["pending_approval", true]);
  },
);

test(
  "a patch born into a generation that already landed is held at its birth, and told so",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    await forgeEvent(app, "merged", first.forgeRef!);
    // The run submitted once more before it heard of the merge: still generation 1.
    const late = await post(app.handler, `/v1/runs/${run.runId}/patches`, {
      branch: BRANCH(run.runId, run.repo.id, "b".repeat(40), 1),
      baseSha: "0".repeat(40),
    }, run.runToken);
    const { patchId, state } = await late.json();
    assertEquals(state, "pending_approval");
    assert((await app.store.getPatch(patchId))!.heldReason !== null);
    const note = (await textNotes(app, run.runId)).at(-1)!;
    assertStringIncludes(note.text, "The patch you just submitted for `app` is on hold");
  },
);

test(
  "a held patch is approvable once its run is over, only with its diff in view, and publishes against the new base",
  async () => {
    const app = await buildApp();
    const run = await runOnChangeRequest(app);
    await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const waiting = await ship(app, run, "b".repeat(40), { approve: false });
    // Approved while it would have gone onto #7, then the run ends before the sweep sends it.
    assertEquals((await post(app.handler, `/v1/patches/${waiting.id}/approve`)).status, 200);
    await end(app, run);
    await forgeEvent(app, "merged", "7");
    const held = (await app.store.getPatch(waiting.id))!;
    assertEquals([held.state, held.approvedAt, held.approvedBy], ["pending_approval", null, null]);
    assertEquals(held.heldReason, HELD_REASON);
    assert(
      (await app.store.listEvents(run.runId)).some((e) =>
        e.kind === "patch-held" && e.detail === held.heldReason
      ),
    );
    const submissions = app.forge.submissions.length;
    await sweep(app);
    assertEquals(app.forge.submissions.length, submissions, "nothing goes out on the old approval");
    // The queue's one-click approve cannot clear a hold.
    const blind = await post(app.handler, `/v1/patches/${waiting.id}/approve`);
    assertEquals(blind.status, 409);
    assertEquals((await blind.json()).code, "held_needs_diff");
    // From the patch's page, with the diff in view: a fresh change request against main.
    assertEquals((await decide(app, waiting.id, "approve")).status, 200);
    await sweep(app);
    const sent = app.forge.submissions.at(-1)!;
    assertEquals([sent.headSha, sent.baseBranch, sent.changeRequest], [
      "b".repeat(40),
      "main",
      undefined,
    ]);
  },
);

test("held, approved, merged: memory credits the claims it carried", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const first = await ship(app, run, "a".repeat(40));
  app.clock.advance(1_000);
  const waiting = await ship(app, run, "b".repeat(40), { approve: false });
  await end(app, run);
  await forgeEvent(app, "merged", first.forgeRef!);
  assertEquals(app.fates.filter((f) => f.patchId === waiting.id), []);
  assertEquals((await decide(app, waiting.id, "approve")).status, 200);
  await sweep(app);
  const published = (await app.store.getPatch(waiting.id))!;
  assertEquals(published.state, "submitted");
  await forgeEvent(app, "merged", published.forgeRef!);
  // Never told "dropped": its one fate is the landing.
  assertEquals(app.fates.filter((f) => f.patchId === waiting.id), [{
    patchId: waiting.id,
    fate: "landed",
  }]);
});

test("an approval racing a hold is refused, and the hold stands", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const first = await ship(app, run, "a".repeat(40));
  app.clock.advance(1_000);
  const waiting = await ship(app, run, "b".repeat(40), { approve: false });
  await end(app, run);
  const store = app.store;
  const inner = store.savePatchIfState.bind(store);
  let raced = false;
  // The merge lands between the approval's read and its write.
  (store as { savePatchIfState: TaskStore["savePatchIfState"] }).savePatchIfState = async (
    patch,
    expected,
    lease,
    readVersion,
  ) => {
    if (!raced && patch.id === waiting.id && patch.state === "queued") {
      raced = true;
      await forgeEvent(app, "merged", first.forgeRef!);
    }
    return await inner(patch, expected, lease, readVersion);
  };
  const res = await post(app.handler, `/v1/patches/${waiting.id}/approve`);
  assert(raced);
  assertEquals(res.status, 409);
  const after = (await app.store.getPatch(waiting.id))!;
  assertEquals([after.state, after.approvedAt, after.heldReason !== null], [
    "pending_approval",
    null,
    true,
  ]);
});

test(
  "a merge settled between the sweep's claim and its delivery still keeps the patch in",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const waiting = await ship(app, run, "b".repeat(40), { approve: false });
    assertEquals((await post(app.handler, `/v1/patches/${waiting.id}/approve`)).status, 200);
    let claimed = false;
    let merged = false;
    const store = app.store;
    const racing: TaskStore = {
      ...store,
      async savePatchIfState(patch, expected, lease, readVersion) {
        const won = await store.savePatchIfState(patch, expected, lease, readVersion);
        if (won && patch.id === waiting.id && patch.state === "submitting") claimed = true;
        return won;
      },
      // The agent switch is read after the first look and before the forge: the merge lands then.
      async getAgent(id) {
        if (claimed && !merged) {
          merged = true;
          await forgeEvent(app, "merged", first.forgeRef!);
        }
        return await store.getAgent(id);
      },
    };
    const submissions = app.forge.submissions.length;
    await sweep(app, racing);
    assert(merged);
    assertEquals(app.forge.submissions.length, submissions, "nothing went to the forge");
    const after = (await app.store.getPatch(waiting.id))!;
    assertEquals([after.state, after.heldReason !== null], ["pending_approval", true]);
  },
);

test("a push that lands on a change request as it merges is settled and cued too", async () => {
  const app = await buildApp();
  const run = await runOnChangeRequest(app);
  const first = await ship(app, run, "a".repeat(40));
  app.clock.advance(1_000);
  const second = await ship(app, run, "b".repeat(40), { approve: false });
  assertEquals((await post(app.handler, `/v1/patches/${second.id}/approve`)).status, 200);
  // The merge arrives while the second patch's push is in flight: it settles only the first.
  const forge = app.forge;
  const realSubmit = forge.submitPatch.bind(forge);
  (forge as { submitPatch: typeof forge.submitPatch }).submitPatch = async (submission) => {
    const out = await realSubmit(submission);
    await forgeEvent(app, "merged", "7");
    return out;
  };
  await sweep(app);
  const settled = (await app.store.getPatch(second.id))!;
  assertEquals([settled.state, settled.forgeRef, settled.landed?.kind], [
    "submitted",
    "7",
    "merged",
  ]);
  assertEquals(
    (await mergedCues(app, run.runId)).map((c) => c!.patchId).toSorted(),
    [first.id, second.id].toSorted(),
  );
  assert(app.fates.some((f) => f.patchId === second.id && f.fate === "landed"));
});

test(
  "a settled patch's diff stays measured where it was sent, whatever lands later",
  async () => {
    // A run's own pull request: measured against the base it was opened on.
    const app = await buildApp();
    const run = await ownRun(app);
    const own = await ship(app, run, "a".repeat(40));
    assertEquals(own.diffRef, "main");
    await forgeEvent(app, "merged", own.forgeRef!, { base: "main" });
    const detail = async (a: App, id: string) =>
      (await (await a.handler(
        new Request(`http://orchestrator.test/v1/patches/${id}`, {
          headers: { authorization: "Bearer t" },
        }),
      )).json()).diffBasis;
    assertEquals(await detail(app, own.id), {
      mode: "record",
      targetRef: "main",
      sincePatchId: null,
    });
    // A change request the task worked: still #7's branch after a later generation landed too.
    const cr = await buildApp();
    const crRun = await runOnChangeRequest(cr);
    const onto7 = await ship(cr, crRun, "a".repeat(40));
    await forgeEvent(cr, "merged", "7");
    const next = await ship(cr, crRun, "c".repeat(40), { generation: 2 });
    await forgeEvent(cr, "merged", next.forgeRef!, { base: "release" });
    assertEquals((await detail(cr, onto7.id)).targetRef, "feat/scheduler");
    assertEquals((await detail(cr, next.id)).targetRef, "main");
  },
);

test("the task page names a merge only where it moved the repo", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const own = await ship(app, run, "a".repeat(40));
  await forgeEvent(app, "merged", own.forgeRef!, { base: "main" });
  assertEquals((await app.store.getTask(run.taskId))!.landings.app?.work?.moved, false);
  const cr = await buildApp();
  const crRun = await runOnChangeRequest(cr);
  await ship(cr, crRun, "a".repeat(40));
  await forgeEvent(cr, "merged", "7");
  assertEquals((await cr.store.getTask(crRun.taskId))!.landings.app?.work?.moved, true);
});

// ---- mixed versions, settles, races ---------------------------------------

test(
  "the apply never lands on the run's own output branches or a change request's head",
  () => {
    const { task, run } = pair("refs/heads/feature-a");
    const named = {
      ...task,
      repos: task.repos.map((r) => ({ ...r, branchNamespace: "ryph/ada/r-1" })),
    } as unknown as Task;
    for (
      const said of [
        "ryph/ada/r-1",
        "ryph/ada/r-1/work",
        "ryph/ada/r-1/work-2",
        "refs/heads/ryph/ada/r-1/fix-a-3",
        // Anything under the namespace is the run's own, a line or not.
        "ryph/ada/r-1/Not-A-Line",
        "pull/7/head",
        "refs/pull/1/head",
        "refs/heads/pull/1/head",
        "refs/patches/x",
        "patches/abc",
        "Pull/7/head",
        "PATCHES/abc",
        "RYPH/Ada/r-1/work-2",
        "Refs/pull/1/head",
        "ma\x01in",
        "main\x7f",
        " main",
        "main ",
        "HEAD",
        "head",
      ]
    ) {
      const out = land(named, run, said);
      assert(out.kind === "landed");
      // The forge's word is refused, and the recorded base stands in.
      assertEquals(out.landing.onto, "feature-a", said);
    }
    // A name that only starts like the namespace is a branch like any other.
    const other = land(named, run, "ryph/ada/r-1-x");
    assert(other.kind === "landed");
    assertEquals(other.landing.onto, "ryph/ada/r-1-x");
  },
);

/**
 * The runner's patch payload as a runner a version behind parses it (packages/runner
 * src/schema.ts before this change), PINNED: an orchestrator rolled out first must never send
 * it something it refuses — a refused known-kind payload failed that runner's whole inbox read.
 */
const OLD_RUNNER_PATCH_PAYLOAD = z.object({
  kind: z.literal("patch"),
  patchId: z.string().min(1).max(200),
  path: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/),
  headSha: z.string().regex(/^[0-9a-f]{7,64}$/),
  generation: z.number().int().min(1).max(10_000),
  state: z.enum(["submitted", "approved", "rejected", "merged", "closed", "failed", "superseded"]),
  forgeUrl: z.string().max(2_000).nullable(),
  reason: z.string().max(100_000).nullable(),
});

/** A whole inbox message as a runner reads it: the one at this branch's base (no images), and
 * the one that added images (`attachments` required). PINNED like the payload above. */
const OLD_RUNNER_MESSAGE = z.object({
  seq: z.number().int().min(0),
  kind: z.enum(["user", "chat", "alert", "system"]),
  sender: z.object({ kind: z.enum(["user", "chat", "automation", "forge", "platform"]) }),
  text: z.string().max(100_000),
  payload: z.preprocess(
    (
      v,
    ) => (v !== null && typeof v === "object" && (v as { kind?: unknown }).kind === "patch"
      ? v
      : null),
    OLD_RUNNER_PATCH_PAYLOAD.nullable(),
  ),
  createdAt: z.string().max(64),
});
const IMAGES_RUNNER_MESSAGE = OLD_RUNNER_MESSAGE.extend({
  attachments: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9._-]{1,200}$/),
    mime: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  })).max(10),
});

test("a runner a version behind parses every message the landing sends", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const first = await ship(app, run, "a".repeat(40));
  app.clock.advance(1_000);
  const waiting = await ship(app, run, "b".repeat(40), { approve: false });
  await forgeEvent(app, "merged", first.forgeRef!);
  assert((await app.store.getPatch(waiting.id))!.heldReason !== null);
  // A late gen-1 birth, held at birth; then the next generation replaces both; a rejection.
  app.clock.advance(1_000);
  await post(app.handler, `/v1/runs/${run.runId}/patches`, {
    branch: BRANCH(run.runId, run.repo.id, "e".repeat(40), 1),
    baseSha: "0".repeat(40),
  }, run.runToken);
  app.clock.advance(1_000);
  const next = await ship(app, run, "c".repeat(40), { generation: 2 });
  await forgeEvent(app, "closed", next.forgeRef!);
  app.clock.advance(1_000);
  const last = await ship(app, run, "d".repeat(40), { generation: 2, approve: false });
  assertEquals((await post(app.handler, `/v1/patches/${last.id}/reject`)).status, 200);
  // Read as the runner reads them, through its own door.
  const res = await app.handler(
    new Request(`http://orchestrator.test/v1/runs/${run.runId}/messages?after=-1&ack=0`, {
      headers: { authorization: `Bearer ${run.runToken}` },
    }),
  );
  assertEquals(res.status, 200);
  const { messages } = await res.json() as { messages: Array<{ payload: unknown; text: string }> };
  const kinds = new Set<string>();
  for (const message of messages) {
    // Whole messages first: under the runner at this branch's base, and under the one that added images.
    for (const schema of [OLD_RUNNER_MESSAGE, IMAGES_RUNNER_MESSAGE]) {
      const whole = schema.safeParse(message);
      assert(whole.success, `${JSON.stringify(message)}: ${whole.error?.message}`);
    }
    const payload = message.payload as { kind?: string; state?: string } | null;
    if (payload?.kind !== "patch") continue;
    const parsed = OLD_RUNNER_PATCH_PAYLOAD.safeParse(payload);
    assert(parsed.success, `${JSON.stringify(payload)}: ${parsed.error?.message}`);
    kinds.add(payload.state!);
  }
  // Every patch state the landing speaks in, and the holds as text alone.
  for (const state of ["merged", "superseded", "closed", "rejected", "approved", "submitted"]) {
    assert(kinds.has(state), `${state} in ${[...kinds]}`);
  }
  assert(messages.some((m) => m.payload === null && m.text.includes("is on hold")));
});

test("an ack other than 0/1/false/true is refused; false acknowledges nothing", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const read = (ack: string) =>
    app.handler(
      new Request(`http://orchestrator.test/v1/runs/${run.runId}/messages?after=0&ack=${ack}`, {
        headers: { authorization: `Bearer ${run.runToken}` },
      }),
    );
  assertEquals((await read("no")).status, 400);
  assertEquals((await read("false")).status, 200);
  assertEquals((await read("0")).status, 200);
});

test(
  "a merge settles only what it contains: a revision pushed past the one that merged is missed",
  async () => {
    // Revisions r1 and r2 of one change request (each submit of the generation pushes onto it);
    // the merge takes r1, as a Radicle delegate merging an older revision does.
    const app = await buildApp();
    const run = await ownRun(app);
    const r1 = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const r2 = await ship(app, run, "b".repeat(40));
    assertEquals([r2.forgeRef, r2.state], [r1.forgeRef, "submitted"]);
    app.containment.answer = ({ heads }) => ({
      kind: "answered",
      contained: heads.filter((h) => h === r1.headSha),
      missed: heads.filter((h) => h !== r1.headSha),
    });
    await forgeEvent(app, "merged", r1.forgeRef!, { heads: [r1.headSha] });
    // One question, about every pushed head, against what merged.
    // Each head with the base its patch was built on, so the forge judges its own work, and the
    // branch the merge went into, which the merged head's own change is measured from.
    assertEquals(app.forge.containmentAsks.at(-1), {
      repoRef: "acme/app",
      mergedHeads: [r1.headSha],
      heads: [r1.headSha, r2.headSha],
      bases: { [r1.headSha]: "0".repeat(40), [r2.headSha]: "0".repeat(40) },
      into: "main",
    });
    assertEquals((await app.store.getPatch(r1.id))!.landed?.kind, "merged");
    const missed = (await app.store.getPatch(r2.id))!;
    assertEquals([missed.landed?.kind, missed.landed?.mergedInto], ["missed", "main"]);
    // The runner advances from r1's head, so r2's commits are past it and ship next generation.
    assertEquals(
      (await mergedCues(app, run.runId)).map((c) => [c!.patchId, c!.headSha, c!.landedHead]),
      [[r1.id, r1.headSha, r1.headSha]],
    );
    // And the run hears, in words and as a cue that moves nothing, that r2 is not in the merge.
    const notes = (await app.store.listRunMessages(run.runId))
      .map((m) => m.payload as PatchPayload | null)
      .filter((p) => p?.kind === "patch" && p.state === "missed");
    assertEquals(notes.map((p) => [p!.patchId, p!.onto]), [[r2.id, undefined]]);
    const text = (await app.store.listRunMessages(run.runId))
      .find((m) => (m.payload as PatchPayload | null)?.state === "missed")!.text;
    assertStringIncludes(text, "not in what merged");
    assertStringIncludes(text, "next submit_patch");
    // Memory: r1 landed, r2 dropped (a later patch that carries it is what may still land it).
    assertEquals(app.fates.filter((f) => f.patchId === r2.id).map((f) => f.fate), ["dropped"]);
    assertEquals(app.fates.filter((f) => f.patchId === r1.id).map((f) => f.fate), ["landed"]);
    // A patch of the generation that waits is held as before: the generation is over.
    app.clock.advance(1_000);
    const waiting = await ship(app, run, "c".repeat(40), { approve: false });
    assertEquals((await app.store.getPatch(waiting.id))!.heldReason, HELD_REASON);
  },
);

test(
  "a base that names no commit as its head does is dropped at birth, never refused, and never sent with a containment question",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const born: Patch[] = [];
    for (
      const [sha, baseSha] of [
        ["a", "HEAD"],
        ["b", "A".repeat(40)],
        ["c", "1".repeat(64)],
        ["d", "1".repeat(40)],
      ]
    ) {
      app.clock.advance(1_000);
      const res = await post(app.handler, `/v1/runs/${run.runId}/patches`, {
        branch: BRANCH(run.runId, run.repo.id, sha.repeat(40)),
        baseSha,
      }, run.runToken);
      assertEquals(res.status, 201, await res.clone().text());
      const { patchId } = await res.json();
      assertEquals((await post(app.handler, `/v1/patches/${patchId}/approve`)).status, 200);
      await sweep(app);
      born.push((await app.store.getPatch(patchId))!);
    }
    assertEquals(born.map((p) => p.baseSha), [null, null, null, "1".repeat(40)]);
    // Delivered and merged: only the base that names a commit rides with the question.
    const forgeRef = (await app.store.getPatch(born[0].id))!.forgeRef!;
    await forgeEvent(app, "merged", forgeRef);
    assertEquals(app.forge.containmentAsks.at(-1)!.bases, { ["d".repeat(40)]: "1".repeat(40) });
  },
);

test(
  "a patch whose earlier sibling's change request merged and was judged while the sweep read it is held, never failed for good",
  async () => {
    // The merge is heard, and settled, between the sweep reading where the patch goes (onto the
    // earlier patch's change request, still open then) and its look at that merge's record.
    const hook: { armed: string | null; run: (() => Promise<void>) | null } = {
      armed: null,
      run: null,
    };
    const app = await buildApp((store) => ({
      ...store,
      getChangeRequestMerge: async (connectedRepoId: string, forgeRef: string) => {
        if (hook.armed === forgeRef && hook.run !== null) {
          hook.armed = null;
          await hook.run();
        }
        return await store.getChangeRequestMerge(connectedRepoId, forgeRef);
      },
    }));
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const next = await ship(app, run, "b".repeat(40), { approve: false });
    assertEquals((await post(app.handler, `/v1/patches/${next.id}/approve`)).status, 200);
    hook.run = () => forgeEvent(app, "merged", first.forgeRef!, { heads: [first.headSha] });
    hook.armed = first.forgeRef!;
    const submissions = app.forge.submissions.length;
    await sweep(app);
    assertEquals(hook.armed, null, "the merge landed under the sweep");
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "merged");
    const held = (await app.store.getPatch(next.id))!;
    assertEquals([held.state, held.heldReason], ["pending_approval", HELD_REASON]);
    assertEquals(app.forge.submissions.length, submissions);
  },
);

test("the latest revision merging settles every one of them merged, as ever", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const r1 = await ship(app, run, "a".repeat(40));
  app.clock.advance(1_000);
  const r2 = await ship(app, run, "b".repeat(40));
  await forgeEvent(app, "merged", r1.forgeRef!, { heads: [r2.headSha] });
  for (const p of [r1, r2]) {
    assertEquals((await app.store.getPatch(p.id))!.landed?.kind, "merged");
  }
  assertEquals((await mergedCues(app, run.runId)).map((c) => c!.patchId), [r2.id]);
  assertEquals(app.fates.map((f) => f.fate), ["landed", "landed"]);
});

test(
  "a force-push that dropped an earlier patch leaves it missed while the later one merges",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const second = await ship(app, run, "b".repeat(40));
    // Somebody rewrote the branch: what merged holds the second head, not the first.
    app.containment.answer = ({ heads }) => ({
      kind: "answered",
      contained: heads.filter((h) => h === second.headSha),
      missed: heads.filter((h) => h !== second.headSha),
    });
    await forgeEvent(app, "merged", first.forgeRef!, { heads: [second.headSha] });
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "missed");
    assertEquals((await app.store.getPatch(second.id))!.landed?.kind, "merged");
    assertEquals((await mergedCues(app, run.runId)).map((c) => c!.patchId), [second.id]);
    assertEquals(app.fates.find((f) => f.patchId === first.id)?.fate, "dropped");
  },
);

test(
  "a push landing on a change request after its merge is judged by the sweep against the merge record",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    await forgeEvent(app, "merged", first.forgeRef!, { base: "release" });
    const landing = (await app.store.getTask(run.taskId))!.landings.app?.work;
    assertEquals(landing?.onto, "release");
    // A patch already on its way onto the change request (born and claimed before the merge).
    app.clock.advance(1_000);
    const born = await post(app.handler, `/v1/runs/${run.runId}/patches`, {
      branch: BRANCH(run.runId, run.repo.id, "b".repeat(40), 1),
      baseSha: "0".repeat(40),
    }, run.runToken);
    const { patchId } = await born.json();
    // The rule held it; force the row a push already in flight would have been.
    await app.store.savePatch({
      ...(await app.store.getPatch(patchId))!,
      state: "queued",
      heldReason: null,
    });
    // The push that reached the pull request after it merged is not in the merge (GitHub's
    // in-flight window).
    app.containment.answer = ({ heads }) => ({
      kind: "answered",
      contained: heads.filter((h) => h === first.headSha),
      missed: heads.filter((h) => h !== first.headSha),
    });
    await sweep(app, {
      ...app.store,
      // The in-flight push: the sweep's own checks had not seen the merge yet.
      listPatchesDueLandingRule: () => Promise.resolve([]),
      getChangeRequestMerge: () => Promise.resolve(null),
      getTask: async (taskId) => {
        const task = await app.store.getTask(taskId);
        return task === null ? null : { ...task, landings: {} };
      },
      patchesForTask: async (taskId) =>
        (await app.store.patchesForTask(taskId)).map((p) =>
          p.id === first.id ? { ...p, landed: null } : p
        ),
    });
    // Pushed, and then judged by the settle reconcile (its answer used on the next tick, since
    // this sweep's store could not read the record back): missed, never left reading as an open
    // pull request, and never settled merged.
    await settle(app);
    const pushed = (await app.store.getPatch(patchId))!;
    assertEquals([pushed.state, pushed.forgeRef, pushed.landed?.kind], [
      "submitted",
      first.forgeRef,
      "missed",
    ]);
    // The forge's landing (onto `release`) stands; the run hears the push is not in the merge,
    // and its commits are past the merged cue's head, which the runner advances from.
    assertEquals((await app.store.getTask(run.taskId))!.landings.app?.work, landing);
    assertEquals((await mergedCues(app, run.runId)).map((c) => c!.patchId), [first.id]);
    const note = (await app.store.listRunMessages(run.runId))
      .map((m) => m.payload as PatchPayload | null)
      .find((p) => p?.patchId === patchId && p?.state === "missed");
    assertEquals(note?.onto, undefined);
    assertEquals(app.fates.filter((f) => f.patchId === patchId).at(-1)?.fate, "dropped");
  },
);

test(
  "the settle reconcile judges a push its merge delivery did not see, against the same record",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const second = await ship(app, run, "b".repeat(40));
    // The forge's delivery read the change request before `second` was recorded on it.
    await app.store.savePatch({ ...(await app.store.getPatch(second.id))!, forgeRef: null });
    await forgeEvent(app, "merged", first.forgeRef!);
    await app.store.savePatch({
      ...(await app.store.getPatch(second.id))!,
      forgeRef: first.forgeRef,
    });
    const now = app.clock.now().toISOString();
    assertEquals(
      (await app.store.listChangeRequestMergesDue(now, 50)).map((m) => m.forgeRef),
      [first.forgeRef],
    );
    await sweep(app);
    assertEquals((await app.store.getPatch(second.id))!.landed?.kind, "merged");
    assertEquals(await app.store.listChangeRequestMergesDue(now, 50), []);
    assertEquals(app.fates.filter((f) => f.patchId === second.id).at(-1)?.fate, "landed");
    // Cued with the newest head, the late one.
    assertEquals((await mergedCues(app, run.runId)).map((c) => c!.patchId), [first.id, second.id]);
  },
);

test("a merged cue waits for its landing, and goes out with it", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const first = await ship(app, run, "a".repeat(40));
  // Settled, but the landing not written yet (the drain ran between the two writes).
  await app.store.savePatch({
    ...(await app.store.getPatch(first.id))!,
    landed: { kind: "merged", at: app.clock.now().toISOString() },
  });
  assertEquals(await app.store.listPatchesAwaitingMergedCue(50, "2000-01-01T00:00:00.000Z"), []);
  await sweep(app);
  assertEquals(await mergedCues(app, run.runId), []);
  const still = (await app.store.getPatch(first.id))!;
  assertEquals([still.mergedCuedAt, still.mergedCueClaimedAt], [null, null]);
  // The forge's delivery lands it; the cue then carries the landing.
  await forgeEvent(app, "merged", first.forgeRef!, { base: "release" });
  const cues = await mergedCues(app, run.runId);
  assertEquals(cues.map((c) => [c!.patchId, c!.onto]), [[first.id, "release"]]);
});

test(
  "a merge after its run ended marks the cue without a post, landing or not, and it is never listed",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const second = await ship(app, run, "b".repeat(40), { generation: 2 });
    assertEquals((await end(app, run)).status, 200);
    await forgeEvent(app, "merged", first.forgeRef!);
    assert((await app.store.getPatch(first.id))!.mergedCuedAt !== null);
    // Settled with no landing for its generation (the delivery crashed before landing it): nobody
    // is left to wait for one.
    await app.store.savePatch({
      ...(await app.store.getPatch(second.id))!,
      landed: { kind: "merged", at: app.clock.now().toISOString() },
    });
    const deps = { ...app.deps, now: app.clock.now };
    assertEquals(await cueMerged(deps, second.id, app.clock.now().toISOString()), false);
    assert((await app.store.getPatch(second.id))!.mergedCuedAt !== null);
    assertEquals(await mergedCues(app, run.runId), []);
    assertEquals(await app.store.markMergedCuesOfEndedRuns(50, AT), 0);
  },
);

test(
  "a run that ends after its merge has its waiting cue marked by the sweep, a live one never",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    // Merged, its landing not recorded: the live run's cue waits for one.
    await app.store.savePatch({
      ...(await app.store.getPatch(first.id))!,
      landed: { kind: "merged", at: app.clock.now().toISOString() },
    });
    await sweep(app);
    assertEquals((await app.store.getPatch(first.id))!.mergedCuedAt, null);
    assertEquals((await end(app, run)).status, 200);
    await sweep(app);
    assert((await app.store.getPatch(first.id))!.mergedCuedAt !== null);
    assertEquals(await mergedCues(app, run.runId), []);
    assertEquals(await app.store.markMergedCuesOfEndedRuns(50, AT), 0);
  },
);

test("a merge writes its landing before memory is told", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const first = await ship(app, run, "a".repeat(40));
  const seen: Array<unknown> = [];
  const report = app.deps.memoryAccess.reportChange;
  app.deps.memoryAccess.reportChange = async (runId, patchId, fate, carries) => {
    seen.push((await app.store.getTask(run.taskId))!.landings.app?.work?.onto);
    return await report(runId, patchId, fate, carries);
  };
  await forgeEvent(app, "merged", first.forgeRef!);
  assertEquals(seen, ["main"]);
});

test(
  "a sweep's claim over a stale copy loses to a hold and a later approval (ABA)",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const queued = await ship(app, run, "b".repeat(40), { approve: false });
    assertEquals((await post(app.handler, `/v1/patches/${queued.id}/approve`)).status, 200);
    // A sweep lists it, queued, and stalls.
    const listed = await app.store.listActivePatches();
    assert(listed.some((p) => p.id === queued.id && p.state === "queued"));
    // Meanwhile: the merge holds it, the run ends, and a person approves it, diff in view —
    // queued again, the same state with a different story.
    await forgeEvent(app, "merged", first.forgeRef!);
    assertEquals((await app.store.getPatch(queued.id))!.state, "pending_approval");
    assertEquals((await end(app, run)).status, 200);
    assertEquals((await decide(app, queued.id, "approve")).status, 200);
    const approved = (await app.store.getPatch(queued.id))!;
    assertEquals(approved.state, "queued");
    const submissions = app.forge.submissions.length;
    // The stalled sweep goes on with its copy: its claim is over a version that moved, and loses.
    await sweep(app, { ...app.store, listActivePatches: () => Promise.resolve(listed) });
    const after = (await app.store.getPatch(queued.id))!;
    assertEquals(app.forge.submissions.length, submissions);
    assertEquals(
      [after.state, after.approvedBy, after.heldReason, after.version],
      ["queued", approved.approvedBy, approved.heldReason, approved.version],
    );
    // A sweep over the row as it is delivers it.
    await sweep(app);
    assertEquals((await app.store.getPatch(queued.id))!.state, "submitted");
  },
);

test(
  "an older failed patch whose work merged inside a newer sibling is replaced by it",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const older = await ship(app, run, "a".repeat(40), { approve: false });
    app.clock.advance(1_000);
    const newer = await ship(app, run, "b".repeat(40));
    // A race left the older one standing beside it, failed.
    await app.store.savePatch({
      ...(await app.store.getPatch(older.id))!,
      state: "failed",
      supersededByPatchId: null,
      nextAttemptAt: "2099-01-01T00:00:00.000Z",
      lastError: "x",
    });
    await forgeEvent(app, "merged", newer.forgeRef!);
    const replaced = (await app.store.getPatch(older.id))!;
    assertEquals(
      [replaced.state, replaced.supersededByPatchId, replaced.heldReason],
      ["superseded", newer.id, null],
    );
    assertEquals(app.fates.filter((f) => f.patchId === older.id).at(-1)?.fate, "dropped");
  },
);

test(
  "approving a patch of a landed generation that nothing ruled yet holds it instead",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const raced = await ship(app, run, "b".repeat(40), { approve: false });
    await forgeEvent(app, "merged", first.forgeRef!);
    // A birth that raced the merge left it unruled: no hold, no note.
    await app.store.savePatch({ ...(await app.store.getPatch(raced.id))!, heldReason: null });
    const res = await post(app.handler, `/v1/patches/${raced.id}/approve`);
    assertEquals(res.status, 409);
    const refusal = await res.json();
    assertEquals(refusal.code, "held");
    const held = (await app.store.getPatch(raced.id))!;
    // Told why, in the hold's own words.
    assertEquals(refusal.error, `this patch is on hold. ${held.heldReason}`);
    assertEquals([held.state, held.heldReason !== null, held.approvedBy], [
      "pending_approval",
      true,
      null,
    ]);
    assert((await app.store.listEvents(run.runId)).some((e) => e.kind === "patch-held"));
  },
);

/**
 * Every store call yields first, for 0–3 turns of the event loop: interleavings, not just one
 * order. `round` seeds the choice, so every run makes the same choices. A turn is
 * `setImmediate`, not a 0 ms timer: a timer is clamped to a millisecond and fires late on a loaded
 * machine, so a round cost a millisecond or more per yield, idle (100 rounds over 30 s on CI),
 * where a turn costs only the work the other requests do in it.
 */
function jittered(store: TaskStore, on: { value: boolean }, round: number): TaskStore {
  // mulberry32, seeded by the round.
  let seed = round + 1;
  const turns = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % 4;
  };
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        if (on.value) {
          for (let i = turns(); i > 0; i--) await new Promise((r) => setImmediate(r));
        }
        return await value.apply(target, args);
      };
    },
  });
}

test(
  "births, a sweep and a merge racing: one reconcile tick leaves nothing of a landed generation unruled",
  async () => {
    const violations: string[] = [];
    for (let round = 0; round < 100; round++) {
      const on = { value: false };
      const app = await buildApp((s) => jittered(s, on, round));
      const run = await ownRun(app);
      const first = await ship(app, run, "a".repeat(40));
      app.clock.advance(1_000);
      const waiting = await ship(app, run, "b".repeat(40), { approve: false });
      app.clock.advance(1_000);
      on.value = true;
      const birth = (sha: string, generation: number) =>
        post(app.handler, `/v1/runs/${run.runId}/patches`, {
          branch: BRANCH(run.runId, run.repo.id, sha, generation),
          baseSha: "0".repeat(40),
        }, run.runToken);
      await Promise.all([
        deliver(app, "merged", first.forgeRef!),
        birth("c".repeat(40), 1),
        birth("d".repeat(40), 2),
        sweep(app),
        post(app.handler, `/v1/patches/${waiting.id}/approve`),
      ]);
      on.value = false;
      // One reconcile tick.
      await sweep(app);
      const all = await app.store.patchesForTask(run.taskId);
      for (const p of all) {
        if (!isPatchWaiting(p) || landedSiblingOf(all, p) === undefined) continue;
        if (p.heldReason === null) violations.push(`${round}: ${p.id} unheld (${p.state})`);
        const verdict = landedVerdict(p, all);
        if (verdict.kind !== "none") violations.push(`${round}: ${p.id} still ${verdict.kind}`);
        if (p.state === "pending_approval") {
          const res = await post(app.handler, `/v1/patches/${p.id}/approve`);
          if (res.status !== 409) violations.push(`${round}: ${p.id} approvable (${res.status})`);
        }
      }
      // Nothing of the landed generation reached the forge after the merge, unless it is the
      // window between the last look and the push (docs/patch-lifecycle.md "Landing") — which
      // never settles as merged without proof, so is carried forward rather than lost.
    }
    assertEquals(violations, []);
  },
  // A database per round on Postgres (tests/db.ts) is about half a second more each.
  ON_POSTGRES ? 180_000 : 30_000,
);

test(
  "a failure with no clock left is not held by the reconcile, however its generation landed",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const stuck = await ship(app, run, "b".repeat(40), { approve: false });
    await forgeEvent(app, "merged", first.forgeRef!);
    // A row from before the rule: the push onto the merged pull request failed for good.
    await app.store.savePatch({
      ...(await app.store.getPatch(stuck.id))!,
      state: "failed",
      heldReason: null,
      nextAttemptAt: null,
      lastError: "the pull request is merged",
    });
    assertEquals(await app.store.listPatchesDueLandingRule(50), []);
    await sweep(app);
    const after = (await app.store.getPatch(stuck.id))!;
    assertEquals([after.state, after.heldReason], ["failed", null]);
  },
);

test("a newer generation whose change request merged without it replaces no held patch", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const first = await ship(app, run, "a".repeat(40));
  app.clock.advance(1_000);
  const waiting = await ship(app, run, "b".repeat(40), { approve: false });
  await forgeEvent(app, "merged", first.forgeRef!);
  const held = (await app.store.getPatch(waiting.id))!;
  assert(held.heldReason !== null);
  app.clock.advance(1_000);
  const next = await ship(app, run, "c".repeat(40), { generation: 2 });
  // The next generation went out, and its change request merged without it.
  await app.store.savePatch({
    ...(await app.store.getPatch(next.id))!,
    state: "submitted",
    landed: { kind: "missed", at: app.clock.now().toISOString() },
  });
  // The birth's replacement of the held one lost a race: it is back, held, beside the next.
  await app.store.savePatch({
    ...(await app.store.getPatch(waiting.id))!,
    state: "pending_approval",
    supersededByPatchId: null,
    heldReason: held.heldReason,
  });
  const all = await app.store.patchesForTask(run.taskId);
  assertEquals(landedVerdict((await app.store.getPatch(waiting.id))!, all), { kind: "none" });
  assertEquals(
    (await app.store.listPatchesDueLandingRule(50)).map((p) => p.id).includes(waiting.id),
    false,
  );
  await sweep(app);
  const after = (await app.store.getPatch(waiting.id))!;
  assertEquals([after.state, after.supersededByPatchId], ["pending_approval", null]);
});

test(
  "deciding a held patch asks the rule again: replaced by a newer patch, never by a rejected one",
  async () => {
    for (const rejectNext of [false, true]) {
      const app = await buildApp();
      const run = await ownRun(app);
      const first = await ship(app, run, "a".repeat(40));
      app.clock.advance(1_000);
      const waiting = await ship(app, run, "b".repeat(40), { approve: false });
      await forgeEvent(app, "merged", first.forgeRef!);
      const held = (await app.store.getPatch(waiting.id))!;
      assert(held.heldReason !== null);
      app.clock.advance(1_000);
      const next = await ship(app, run, "c".repeat(40), { generation: 2, approve: false });
      if (rejectNext) {
        assertEquals((await post(app.handler, `/v1/patches/${next.id}/reject`)).status, 200);
      }
      // The birth's replacement of the held one lost a race: it is back, held, beside the next.
      await app.store.savePatch({
        ...(await app.store.getPatch(waiting.id))!,
        state: "pending_approval",
        supersededByPatchId: null,
        heldReason: held.heldReason,
      });
      assertEquals((await end(app, run)).status, 200);
      const res = await decide(app, waiting.id, "approve");
      if (rejectNext) {
        // A person declined the next generation: this one is still theirs to send.
        assertEquals(res.status, 200, await res.clone().text());
        assertEquals((await app.store.getPatch(waiting.id))!.state, "queued");
      } else {
        assertEquals(res.status, 409);
        assertEquals((await res.json()).code, "superseded");
        const replaced = (await app.store.getPatch(waiting.id))!;
        assertEquals([replaced.state, replaced.supersededByPatchId], ["superseded", next.id]);
      }
    }
  },
);

test(
  "with no usable branch the landing records where the repo stands, so the cue still fires",
  () => {
    const { task, run } = pair();
    const named = {
      ...task,
      repos: task.repos.map(({ targetRef: _none, ...r }) => ({ ...r, branchName: "ryph/ada/r-1" })),
    } as unknown as Task;
    // The forge's word and the default branch refused, and no base recorded.
    const out = landMerge({
      task: named,
      run,
      patch: PATCH,
      mergedInto: "pull/7/head",
      defaultBranch: "HEAD",
      at: AT,
    });
    assert(out.kind === "landed");
    assertEquals([out.landing.onto, out.landing.moved], ["feat/scheduler", false]);
    // The repo stays; the change request it worked is done with.
    assertEquals(out.task.repos, named.repos);
    assertEquals(out.task.targetChangeRequest, null);
    assertEquals(out.run, null);
    // The task stops targeting the change request it worked, and the trail says so.
    assertStringIncludes(out.event!.detail!, "no longer targets it");
    // Where the repo stands is held to the same rules: a branch that fails them records no
    // landing, but the change request the task worked is still let go, with the event.
    const onHead = {
      ...named,
      repos: named.repos.map((r) => r.path === "app" ? { ...r, ref: "refs/heads/pull/7/head" } : r),
    } as unknown as Task;
    const released = landMerge({
      task: onHead,
      run,
      patch: PATCH,
      mergedInto: "pull/7/head",
      defaultBranch: "HEAD",
      at: AT,
    });
    assert(released.kind === "released");
    assertEquals(released.task.targetChangeRequest, null);
    assertEquals(released.task.landings, onHead.landings);
    assertEquals(released.task.repos, onHead.repos);
    assertStringIncludes(released.event.detail!, "no longer targets it");
    // Not worked: nothing at all.
    assertEquals(
      landMerge({
        task: { ...onHead, targetChangeRequest: null },
        run,
        patch: PATCH,
        mergedInto: "pull/7/head",
        defaultBranch: "HEAD",
        at: AT,
      }).kind,
      "none",
    );
  },
);

test(
  "the landing rule never retires a patch the sweep is delivering, unless it holds the lease",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const waiting = await ship(app, run, "b".repeat(40), { approve: false });
    await forgeEvent(app, "merged", first.forgeRef!);
    const inFlight = {
      ...(await app.store.getPatch(waiting.id))!,
      state: "submitting" as const,
      heldReason: null,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    };
    await app.store.savePatch(inFlight);
    const read = (await app.store.getPatch(waiting.id))!;
    const patches = await app.store.patchesForTask(run.taskId);
    const deps = { ...app.deps, now: app.clock.now };
    assertEquals(await applyLandingRule(deps, read, patches, AT), false);
    assertEquals((await app.store.getPatch(waiting.id))!.state, "submitting");
    // The sweep holding the lease does rule it.
    assert(await applyLandingRule(deps, read, patches, AT, { lease: read.leaseExpiresAt! }));
    assertEquals((await app.store.getPatch(waiting.id))!.state, "pending_approval");
  },
);

test(
  "a hold while the merged sibling's landing is still owed tells the run to submit again, not that ryph could not tell where",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const waiting = await ship(app, run, "b".repeat(40), { approve: false });
    // Settled by the merge, its landing not written yet: the merge's next step, or the reconcile's.
    assert(await settleOnce(app.store, first, "merged", AT, { mergedInto: "release" }) !== null);
    const deps = { ...app.deps, now: app.clock.now };
    const read = (await app.store.getPatch(waiting.id))!;
    assert(await applyLandingRule(deps, read, await app.store.patchesForTask(run.taskId), AT));
    assertEquals((await app.store.getPatch(waiting.id))!.state, "pending_approval");
    const told = (await textNotes(app, run.runId)).map((m) => m.text);
    assertEquals(told.length, 1);
    assertStringIncludes(told[0], "then call submit_patch now");
    // The landing then comes, and the cue with where.
    await forgeEvent(app, "merged", first.forgeRef!, { base: "release" });
    assertEquals((await mergedCues(app, run.runId)).map((c) => c!.onto), ["release"]);
  },
);

test(
  "a late push of another task onto a merged change request is settled, landed from the merge record, and cued",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    await forgeEvent(app, "merged", first.forgeRef!, { base: "release" });
    // Another task's patch reached the same pull request after the forge's delivery read it.
    const created = await post(app.handler, "/v1/tasks", {
      agentId: run.agent.id,
      spec: { title: "Also fix it", instructions: "Fix it too." },
      connectedRepoId: run.repo.id,
      lifetime: CLOCKS,
    });
    assertEquals(created.status, 201, await created.clone().text());
    const { taskId, runId } = await created.json();
    const runToken = (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN;
    await post(app.handler, `/v1/runs/${runId}/heartbeat`, { seq: 0, phase: "running" }, runToken);
    const other = { taskId, runId, runToken, repo: run.repo, agent: run.agent };
    const late = await ship(app, other, "b".repeat(40));
    await app.store.savePatch({
      ...(await app.store.getPatch(late.id))!,
      forgeRef: first.forgeRef,
      landed: null,
    });
    await sweep(app);
    const settled = (await app.store.getPatch(late.id))!;
    assertEquals([settled.landed?.kind, settled.landed?.mergedInto], ["merged", "release"]);
    // Landed where the forge said the change request merged, for ITS task, and its run cued.
    assertEquals((await app.store.getTask(other.taskId))!.landings.app?.work?.onto, "release");
    assertEquals(
      (await mergedCues(app, other.runId)).map((c) => [c!.patchId, c!.onto]),
      [[late.id, "release"]],
    );
  },
);

test(
  "a close heard after a merge leaves a late push to the merge record, which judges it",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    await forgeEvent(app, "merged", first.forgeRef!);
    const repo = (await app.store.getConnectedRepo(run.repo.id))!;
    assert((await app.store.getChangeRequestMerge(repo.id, first.forgeRef!))!.settledAt !== null);
    // A push of the same run reached the merged pull request after its record settled.
    const late = await ship(app, run, "b".repeat(40), { generation: 2 });
    await app.store.savePatch({
      ...(await app.store.getPatch(late.id))!,
      forgeRef: first.forgeRef,
      landed: null,
    });
    // A close delivered now (a forge that also says closed, or a late redelivery) closes nothing.
    await forgeEvent(app, "closed", first.forgeRef!);
    assertEquals((await app.store.getPatch(late.id))!.landed, null);
    await sweep(app);
    assertEquals((await app.store.getPatch(late.id))!.landed?.kind, "merged");
  },
);

test(
  "a close that read no merge closes nothing a merge recorded before its write",
  async () => {
    let blind = false;
    const app = await buildApp((s) => ({
      ...s,
      async getChangeRequestMerge(connectedRepoId, forgeRef) {
        // The close read the change request before the merge was recorded.
        if (blind) return null;
        return await s.getChangeRequestMerge(connectedRepoId, forgeRef);
      },
    }));
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    await forgeEvent(app, "merged", first.forgeRef!);
    const late = await ship(app, run, "b".repeat(40), { generation: 2 });
    await app.store.savePatch({
      ...(await app.store.getPatch(late.id))!,
      forgeRef: first.forgeRef,
      landed: null,
    });
    blind = true;
    await forgeEvent(app, "closed", first.forgeRef!);
    blind = false;
    assertEquals((await app.store.getPatch(late.id))!.landed, null);
    await sweep(app);
    assertEquals((await app.store.getPatch(late.id))!.landed?.kind, "merged");
  },
);

test(
  "a settle with nothing owing lands and cues nothing when another sweep moved the record on",
  async () => {
    let refuse = true;
    const app = await buildApp((s) => ({
      ...s,
      async stampChangeRequestMerge(connectedRepoId, forgeRef, read, mark) {
        if (refuse) return false;
        return await s.stampChangeRequestMerge(connectedRepoId, forgeRef, read, mark);
      },
    }));
    const run = await runOnChangeRequest(app);
    const first = await ship(app, run, "a".repeat(40));
    const at = app.clock.now().toISOString();
    // Judged already (by an ask whose own stamp lost), so the record owes it nothing.
    assert(await settleOnce(app.store, first, "merged", at, { mergedInto: "main" }) !== null);
    await app.store.recordChangeRequestMerge({
      connectedRepoId: run.repo.id,
      forgeRef: "7",
      mergedInto: "main",
      heads: [first.headSha],
      at,
    });
    await settle(app);
    assertEquals(await mergedCues(app, run.runId), []);
    // The sweep that wins the stamp lands and cues it.
    refuse = false;
    await settle(app);
    assertEquals((await mergedCues(app, run.runId)).map((c) => c!.patchId), [first.id]);
  },
);

test(
  "with no landing recorded the run is told plainly that further patches wait for a person",
  () => {
    assertStringIncludes(releasedNote("app"), "ryph could not tell where");
    assertStringIncludes(releasedNote("app"), "wait for a person");
    const held = { path: "app", headSha: "a".repeat(40) } as Patch;
    assertStringIncludes(heldNote(held, false, false), "waits for a person");
    assert(!heldNote(held, false, false).includes("submit_patch"));
    assertStringIncludes(heldNote(held, false, true), "then call submit_patch now");
  },
);

test("a merge that could only be let go tells the task's live run, once", async () => {
  // The repo's default branch, from the merge on, is one no rule takes.
  let headless = false;
  const app = await buildApp((store) => ({
    ...store,
    async getConnectedRepo(id) {
      const repo = await store.getConnectedRepo(id);
      return repo === null || !headless ? repo : { ...repo, defaultBranch: "HEAD" };
    },
  }));
  const run = await ownRun(app);
  // The task works #7 from a head no rule takes, with no base recorded.
  const moved = await app.store.applyRetarget({
    taskId: run.taskId,
    runId: run.runId,
    path: "app",
    connectedRepoId: run.repo.id,
    thread: "7",
    headRef: "pull/7/head",
    headSha: "a".repeat(40),
    targetRef: undefined,
    at: AT,
  });
  assert(moved !== null && !("kind" in moved), JSON.stringify(moved));
  const born = await ship(app, run, "a".repeat(40), { approve: false });
  await app.store.savePatch({
    ...(await app.store.getPatch(born.id))!,
    state: "submitted",
    forgeRef: "7",
  });
  headless = true;
  for (let i = 0; i < 2; i++) {
    await app.store.recordChangeRequestMerge({
      connectedRepoId: run.repo.id,
      forgeRef: "7",
      mergedInto: "pull/7/head",
      heads: [MERGED_HEAD],
      at: AT,
    });
    await settle(app);
  }
  assertEquals((await app.store.getTask(run.taskId))!.targetChangeRequest, null);
  const told = (await textNotes(app, run.runId)).filter((m) =>
    m.text.includes("ryph could not tell where")
  );
  assertEquals(told.length, 1);
});

// ---- what a merge contained -------------------------------------------------------------------

/** The messages the run heard about a missed patch, as the runner reads them. */
async function missedCues(app: App, runId: string) {
  return (await app.store.listRunMessages(runId))
    .map((m) => ({ payload: m.payload as PatchPayload | null, text: m.text }))
    .filter((m) => m.payload?.kind === "patch" && m.payload.state === "missed");
}

test(
  "a containment the forge cannot answer settles nothing; the patch onto it waits, and the sweep settles it later",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const second = await ship(app, run, "b".repeat(40), { approve: false });
    assertEquals((await post(app.handler, `/v1/patches/${second.id}/approve`)).status, 200);
    app.containment.answer = () => ({ kind: "unavailable", message: "the cache is down" });
    await forgeEvent(app, "merged", first.forgeRef!);
    // Nothing guessed: unsettled, uncued, and memory told nothing.
    assertEquals((await app.store.getPatch(first.id))!.landed, null);
    assertEquals(await mergedCues(app, run.runId), []);
    assertEquals(app.fates, []);
    const merge = (await app.store.getChangeRequestMerge(run.repo.id, first.forgeRef!))!;
    assertEquals([merge.settledAt, merge.attempts], [null, 1]);
    // The queued patch would go onto the merged change request: it waits instead, as it was.
    const asks = app.forge.containmentAsks.length;
    await sweep(app);
    const held = (await app.store.getPatch(second.id))!;
    assertEquals([held.state, held.attempts, held.forgeRef], ["queued", 0, null]);
    // Not asked again before its clock.
    assertEquals(app.forge.containmentAsks.length, asks);
    // The forge answers on a later sweep: settled, landed, cued, and the waiting one ruled.
    app.containment.answer = null;
    app.clock.advance(60_000);
    await sweep(app);
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "merged");
    assertEquals((await mergedCues(app, run.runId)).map((c) => c!.patchId), [first.id]);
    assertEquals((await app.store.getPatch(second.id))!.state, "pending_approval");
    assertEquals((await app.store.getPatch(second.id))!.heldReason, HELD_REASON);
    assert((await app.store.getChangeRequestMerge(run.repo.id, first.forgeRef!))!.settledAt);
  },
);

test(
  "a merge naming no head is never settled merged: once its asks run out, every patch is missed and its work moves on",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    await forgeEvent(app, "merged", first.forgeRef!, { heads: [], base: "release" });
    assertEquals((await app.store.getPatch(first.id))!.landed, null);
    // A read that names no merged head either is a forge or bridge a deploy behind, never a
    // refusal: not given up on within minutes...
    for (let i = 0; i < 3; i++) {
      app.clock.advance(30_000);
      await sweep(app);
    }
    assertEquals((await app.store.getPatch(first.id))!.landed, null);
    // ...but on the long budget, as any ask that brought no answer.
    for (let i = 0; i < 40 && (await app.store.getPatch(first.id))!.landed === null; i++) {
      app.clock.advance(31 * 60_000);
      await sweep(app);
    }
    const missed = (await app.store.getPatch(first.id))!;
    assertEquals([missed.landed?.kind, missed.landed?.unproven], ["missed", true]);
    assertEquals(app.fates.map((f) => f.fate), ["dropped"]);
    // Nothing of the generation merged: the repo still lands where the forge said, and the missed
    // cue carries it, so the runner moves the whole generation's work there.
    assertEquals((await app.store.getTask(run.taskId))!.landings.app?.work?.onto, "release");
    assertEquals(await mergedCues(app, run.runId), []);
    const cues = await missedCues(app, run.runId);
    assertEquals(cues.map((c) => [c.payload!.patchId, c.payload!.onto]), [[first.id, "release"]]);
    assertStringIncludes(cues[0].text, "Rebase them onto `origin/release` (ryph adds a note");
    assert(!cues[0].text.includes("git rebase"), cues[0].text);
    assertStringIncludes(cues[0].text, "could not confirm");
    assertStringIncludes(cues[0].text, "`release`");
    // The forge was never asked a question with no merged head in it.
    assertEquals(app.forge.containmentAsks, []);
  },
);

test(
  "a reopened change request merging ends the generation, though a newer patch waits on a fresh one",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    await forgeEvent(app, "closed", first.forgeRef!);
    app.clock.advance(1_000);
    // The next patch of the generation opens a fresh change request, and waits there.
    const second = await ship(app, run, "b".repeat(40));
    assert(second.forgeRef !== first.forgeRef);
    // The person reopens the first and merges it with nothing of the run's in it.
    app.containment.answer = ({ heads }) => ({
      kind: "answered",
      contained: [],
      missed: heads,
    });
    await forgeEvent(app, "merged", first.forgeRef!);
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "missed");
    // The second's verdict is its own change request's to give, never this merge's: the cue that
    // the generation is over goes out at once.
    assertEquals((await app.store.getPatch(second.id))!.landed, null);
    const cues = await missedCues(app, run.runId);
    assertEquals(cues.map((c) => [c.payload!.patchId, c.payload!.onto]), [[first.id, "main"]]);
  },
);

test(
  "the missed cue that ends a generation is posted for its newest missed patch, naming the rebase past its base",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const second = await ship(app, run, "b".repeat(40));
    assertEquals(second.forgeRef, first.forgeRef);
    app.clock.advance(1_000);
    // A third waits for a person: published to nobody.
    const waiting = await ship(app, run, "c".repeat(40), { approve: false });
    app.containment.answer = ({ heads }) => ({ kind: "answered", contained: [], missed: heads });
    await forgeEvent(app, "merged", first.forgeRef!);
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "missed");
    assertEquals((await app.store.getPatch(second.id))!.landed?.kind, "missed");
    assertEquals((await app.store.getPatch(waiting.id))!.landed, null);
    // Only the newest missed patch's cue is posted: the agent rebases the generation's work.
    const cues = await missedCues(app, run.runId);
    assertEquals(cues.map((c) => [c.payload!.patchId, c.payload!.onto]), [[second.id, "main"]]);
    assertStringIncludes(cues[0].text, "Those commits are not in `main`");
    assertStringIncludes(cues[0].text, "ryph adds a note with the exact command");
  },
);

test("a refusal is asked again a few times too, then the patches are missed", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const first = await ship(app, run, "a".repeat(40));
  app.containment.answer = () => ({ kind: "refused", message: "no such merged head" });
  await forgeEvent(app, "merged", first.forgeRef!);
  app.clock.advance(30 * 60_000);
  await sweep(app);
  assertEquals((await app.store.getPatch(first.id))!.landed, null);
  app.clock.advance(30 * 60_000);
  await sweep(app);
  assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "missed");
  assertEquals(app.forge.containmentAsks.length, 3);
});

test("a miss nobody could prove loses the label once a later answer proves it", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const first = await ship(app, run, "a".repeat(40));
  app.containment.answer = () => ({ kind: "refused", message: "no such merged head" });
  await forgeEvent(app, "merged", first.forgeRef!);
  for (let i = 0; i < 2; i++) {
    app.clock.advance(30 * 60_000);
    await sweep(app);
  }
  const unproven = (await app.store.getPatch(first.id))!;
  assertEquals([unproven.landed?.kind, unproven.landed?.unproven], ["missed", true]);
  // The merge names another head: judged again, git now answers that it holds none of it.
  app.containment.answer = ({ heads }) => ({
    kind: "answered",
    contained: [],
    missed: heads,
  });
  await forgeEvent(app, "merged", first.forgeRef!, { heads: ["e".repeat(40)] });
  const proven = (await app.store.getPatch(first.id))!;
  assertEquals([proven.landed?.kind, proven.landed?.unproven], ["missed", undefined]);
  // A label, nothing more: the verdict's landing, cue and memory report stand.
  assertEquals(proven.landed?.at, unproven.landed?.at);
  assertEquals(proven.mergedCuedAt, unproven.mergedCuedAt);
  assertEquals(app.fates.map((f) => f.fate), ["dropped"]);
});

test("a merge naming more heads than one question holds asks about the newest", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const first = await ship(app, run, "a".repeat(40));
  const heads = Array.from({ length: 25 }, (_, i) => i.toString(16).padStart(40, "e"));
  // Two merges' deliveries, recorded before the sweep settles them, each naming its heads newest
  // first.
  assertEquals(
    (await deliver(app, "merged", first.forgeRef!, { heads: heads.slice(0, 20) })).status,
    200,
  );
  assertEquals(
    (await deliver(app, "merged", first.forgeRef!, { heads: heads.slice(20) })).status,
    200,
  );
  await settle(app);
  // The later delivery's heads, then the newest of the first's.
  assertEquals(app.forge.containmentAsks.map((a) => a.mergedHeads), [[
    ...heads.slice(20),
    ...heads.slice(0, 15),
  ]]);
  assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "merged");
});

test("a verdict is stamped when its answer came, not when the ask began", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const first = await ship(app, run, "a".repeat(40));
  const asked = app.clock.now().getTime();
  app.containment.answer = ({ heads }) => {
    // The forge takes most of the landing's grace to answer.
    app.clock.advance(50_000);
    return { kind: "answered", contained: heads, missed: [] };
  };
  await forgeEvent(app, "merged", first.forgeRef!);
  assertEquals(
    (await app.store.getPatch(first.id))!.landed?.at,
    new Date(asked + 50_000).toISOString(),
  );
});

test(
  "an answer about fewer heads than the record grew to meanwhile cues nothing",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    const LATER = "e".repeat(40);
    let grown = false;
    app.containment.answer = async ({ mergedHeads, heads }) => {
      // A second merge, naming the head that holds the patch, is recorded while the first ask
      // is out.
      if (!grown) {
        grown = true;
        await app.store.recordChangeRequestMerge({
          connectedRepoId: run.repo.id,
          forgeRef: first.forgeRef!,
          mergedInto: "main",
          heads: [LATER],
          at: app.clock.now().toISOString(),
        });
      }
      return mergedHeads.includes(LATER)
        ? { kind: "answered", contained: heads, missed: [] }
        : { kind: "answered", contained: [], missed: heads };
    };
    await forgeEvent(app, "merged", first.forgeRef!);
    // The answer's verdict stands, but nothing is landed or cued off it.
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "missed");
    assertEquals(await missedCues(app, run.runId), []);
    assertEquals((await app.store.getTask(run.taskId))!.landings, {});
    // The settle against every head does.
    await sweep(app);
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "merged");
    assertEquals((await mergedCues(app, run.runId)).map((c) => c!.patchId), [first.id]);
    assertEquals(await missedCues(app, run.runId), []);
  },
);

test("a refusal after asks that brought no answer counts them toward its few", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const first = await ship(app, run, "a".repeat(40));
  app.containment.answer = () => ({ kind: "unavailable", message: "timeout" });
  await forgeEvent(app, "merged", first.forgeRef!);
  app.clock.advance(31_000);
  await sweep(app);
  assertEquals((await app.store.getPatch(first.id))!.landed, null);
  // Two asks brought no answer; the first refusal makes three, and three refusals' worth is all
  // a refusal gets.
  app.containment.answer = () => ({ kind: "refused", message: "no such merged head" });
  app.clock.advance(61_000);
  await sweep(app);
  assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "missed");
  assertEquals(app.forge.containmentAsks.length, 3);
});

test(
  "the backstops leave a verdict alone while its merge record waits on a settle against every head",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    const LATER = "e".repeat(40);
    let grown = false;
    let down = false;
    app.containment.answer = async ({ mergedHeads, heads }) => {
      if (down) return { kind: "unavailable", message: "502" };
      // A second merge, naming the head that holds the patch, is recorded while the first ask
      // is out.
      if (!grown) {
        grown = true;
        await app.store.recordChangeRequestMerge({
          connectedRepoId: run.repo.id,
          forgeRef: first.forgeRef!,
          mergedInto: "main",
          heads: [LATER],
          at: app.clock.now().toISOString(),
        });
      }
      return mergedHeads.includes(LATER)
        ? { kind: "answered", contained: heads, missed: [] }
        : { kind: "answered", contained: [], missed: heads };
    };
    await forgeEvent(app, "merged", first.forgeRef!);
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "missed");
    // The forge is down for the ask against every head, well past the landing's grace: the
    // missed verdict against fewer heads is neither landed nor cued by the backstops.
    down = true;
    for (let i = 0; i < 12; i++) {
      app.clock.advance(10_000);
      await sweep(app);
    }
    const verdict = (await app.store.getPatch(first.id))!.landed!;
    assertEquals(verdict.kind, "missed");
    assert(app.clock.now().getTime() - Date.parse(verdict.at) > LANDING_GRACE_MS);
    assertEquals(
      (await app.store.getChangeRequestMerge(run.repo.id, first.forgeRef!))!.settledAt,
      null,
    );
    assertEquals((await app.store.getPatch(first.id))!.landingAskedAt ?? null, null);
    assertEquals((await app.store.getTask(run.taskId))!.landings, {});
    assertEquals(await missedCues(app, run.runId), []);
    // Nor is memory told of it by its own backstop.
    await sweepMemoryFates({ ...app.deps, now: app.clock.now });
    assertEquals(app.fates, []);
    // The forge answers again: the settle against every head lands and cues it, merged.
    down = false;
    for (let i = 0; i < 6; i++) {
      app.clock.advance(60_000);
      await sweep(app);
    }
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "merged");
    assertEquals((await mergedCues(app, run.runId)).map((c) => c!.patchId), [first.id]);
    assertEquals(await missedCues(app, run.runId), []);
  },
);

test(
  "the generation's missed cue waits while another patch on its change request awaits its verdict",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const second = await ship(app, run, "b".repeat(40));
    // The second is still being pushed when the merge is delivered, which holds only the first's
    // change request as it stood: not the first's head.
    const pushed = (await app.store.getPatch(second.id))!;
    await app.store.savePatch({
      ...pushed,
      state: "submitting",
      forgeRef: null,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    app.containment.answer = ({ heads }) => ({
      kind: "answered",
      contained: [],
      missed: heads,
    });
    await forgeEvent(app, "merged", first.forgeRef!);
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "missed");
    const deps = { ...app.deps, now: app.clock.now };
    assertEquals(await cueMerged(deps, first.id, app.clock.now().toISOString()), true);
    assertEquals(await missedCues(app, run.runId), []);
    // The push lands on the change request; the reconcile judges it.
    await app.store.savePatch({ ...pushed, leaseExpiresAt: null });
    // The second turns out merged: the generation landed through it, and the first's note says
    // only that it is not in the merge.
    app.containment.answer = null;
    await sweep(app);
    assertEquals((await mergedCues(app, run.runId)).map((c) => c!.patchId), [second.id]);
    // The first's note waited in the outbox for the merged cue, and goes out on the next tick.
    await sweep(app);
    assertEquals(
      (await missedCues(app, run.runId)).map((c) => [c.payload!.patchId, c.payload!.onto]),
      [[first.id, undefined]],
    );
  },
);

test("a merge delivered again settles, lands and cues nothing twice", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const first = await ship(app, run, "a".repeat(40));
  app.clock.advance(1_000);
  const second = await ship(app, run, "b".repeat(40));
  app.containment.answer = ({ heads }) => ({
    kind: "answered",
    contained: heads.filter((h) => h === first.headSha),
    missed: heads.filter((h) => h !== first.headSha),
  });
  for (let i = 0; i < 3; i++) {
    await forgeEvent(app, "merged", first.forgeRef!, { heads: [first.headSha] });
  }
  const settledEvents = (await app.store.listEvents(run.runId))
    .filter((e) => e.kind === "patch-settled").map((e) => e.detail);
  assertEquals(settledEvents.toSorted(), ["merged", "missed"]);
  assertEquals((await mergedCues(app, run.runId)).length, 1);
  assertEquals((await missedCues(app, run.runId)).length, 1);
  assertEquals(app.fates.length, 2);
  // Asked once: a settled record with nothing owing asks nothing.
  assertEquals(app.forge.containmentAsks.length, 1);
  assertEquals((await app.store.getPatch(second.id))!.landed?.kind, "missed");
});

test(
  "merged again at a newer head: the patch the first merge missed is merged after all",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const r1 = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const r2 = await ship(app, run, "b".repeat(40));
    // Git's answer: a head is inside a merge exactly when the merge names it or a newer one.
    const order = [r1.headSha, r2.headSha];
    app.containment.answer = ({ mergedHeads, heads }) => {
      const top = Math.max(...mergedHeads.map((h) => order.indexOf(h)));
      const contained = heads.filter((h) => order.indexOf(h) <= top);
      const missed = heads.filter((h) => !contained.includes(h));
      return { kind: "answered", contained, missed };
    };
    await forgeEvent(app, "merged", r1.forgeRef!, { heads: [r1.headSha] });
    assertEquals((await app.store.getPatch(r2.id))!.landed?.kind, "missed");
    // A delegate merges the newer revision too: the record grows, and r2 is judged again.
    app.clock.advance(1_000);
    await forgeEvent(app, "merged", r1.forgeRef!, { heads: [r2.headSha] });
    const merge = (await app.store.getChangeRequestMerge(run.repo.id, r1.forgeRef!))!;
    assertEquals(merge.heads, [r2.headSha, r1.headSha]);
    assertEquals((await app.store.getPatch(r2.id))!.landed?.kind, "merged");
    // Memory heard dropped, then landed; the run is cued for r2's head as well.
    assertEquals(app.fates.filter((f) => f.patchId === r2.id).map((f) => f.fate), [
      "dropped",
      "landed",
    ]);
    assertEquals((await mergedCues(app, run.runId)).map((c) => c!.patchId), [r1.id, r2.id]);
  },
);

test("a merge with no patch on it yet is recorded while a live run works it", async () => {
  const app = await buildApp();
  const run = await runOnChangeRequest(app);
  assertEquals((await forgeEvent(app, "merged", "7")).outcome, "no-such-patch");
  const merge = await app.store.getChangeRequestMerge(run.repo.id, "7");
  assertEquals(merge?.heads, [MERGED_HEAD]);
  // Nobody works #8: nothing is kept for it.
  await forgeEvent(app, "merged", "8");
  assertEquals(await app.store.getChangeRequestMerge(run.repo.id, "8"), null);
});

// ---- a task working the change request, a deferred verdict, the cue order ----------------------

/** The release cues the run heard, as the runner reads them, with their words. */
async function releaseCues(app: App, runId: string) {
  return (await app.store.listRunMessages(runId))
    .filter((m) => m.payload?.kind === "released")
    .map((m) => ({ payload: m.payload, text: m.text }));
}

test(
  "a change request a live run works merges before its first push: the task is let go, the run cued, and its next generation opens a fresh change request",
  async () => {
    const app = await buildApp();
    const run = await runOnChangeRequest(app);
    await forgeEvent(app, "merged", "7");
    const task = (await app.store.getTask(run.taskId))!;
    assertEquals([task.targetChangeRequest, task.repos[0].ref], [null, "refs/heads/main"]);
    // The release ends the run's generation there, as a landing would.
    assertEquals(task.landings.app?.work, {
      connectedRepoId: run.repo.id,
      thread: "7",
      onto: "main",
      generation: 1,
      moved: true,
      at: task.landings.app!.work!.at,
      releasedRun: run.runId,
    });
    assertEquals((await app.store.getRun(run.runId))!.workItem.repos[0].ref, "main");
    // The release cue: the payload the runner acts on, and words for the agent.
    const cues = await releaseCues(app, run.runId);
    assertEquals(cues.map((c) => c.payload), [
      {
        kind: "released",
        path: "app",
        line: "work",
        onto: "main",
        forgeRef: "7",
        generation: 1,
      },
    ]);
    assertStringIncludes(cues[0].text, "with nothing of this run on it");
    assertStringIncludes(
      cues[0].text,
      "Rebase your commits in `app` onto `origin/main` (ryph adds a note with the exact " +
        "command; if there is none, call ryph__update_from_base), and your",
    );
    assertStringIncludes(cues[0].text, "`main`");
    // A redelivery lets go of nothing twice, and cues nothing twice.
    await forgeEvent(app, "merged", "7");
    await sweep(app);
    assertEquals((await releaseCues(app, run.runId)).length, 1);
    // A patch of the released generation, from a runner that had not read the cue yet, is held:
    // it was built on the merged change request's head.
    const stale = await ship(app, run, "a".repeat(40), { approve: false });
    assertEquals([stale.state, stale.heldReason], ["pending_approval", HELD_REASON_ENDED]);
    assertEquals((await post(app.handler, `/v1/patches/${stale.id}/approve`)).status, 409);
    // The next generation — the runner moved the run's commits onto main — opens a fresh change
    // request against main, and replaces the held one.
    const next = await ship(app, run, "b".repeat(40), { generation: 2 });
    assertEquals([next.state, next.lastError], ["submitted", null]);
    const sent = app.forge.submissions.at(-1)!;
    assertEquals([sent.changeRequest, sent.baseBranch], [undefined, "main"]);
    assertEquals((await app.store.getPatch(stale.id))!.state, "superseded");
  },
);

test(
  "a run awaiting its prompt whose change request merged is owed the release cue, and hears it right after the prompt",
  async () => {
    const app = await buildApp();
    const { repo, agent } = await prepare(app);
    const created = await post(app.handler, "/v1/tasks", {
      agentId: agent.id,
      spec: {},
      connectedRepoId: repo.id,
      targetChangeRequest: { connectedRepoId: repo.id, thread: "7" },
      lifetime: CLOCKS,
    });
    assertEquals(created.status, 201, await created.clone().text());
    const { taskId, runId } = await created.json();
    const runToken = (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN;
    await post(app.handler, `/v1/runs/${runId}/heartbeat`, { seq: 0, phase: "running" }, runToken);
    await forgeEvent(app, "merged", "7");
    // Let go and moved, but nothing reaches the inbox before the prompt: the cue is owed.
    const released = (await app.store.getTask(taskId))!;
    assertEquals(released.targetChangeRequest, null);
    assertEquals(released.landings.app?.work?.releaseCueOwed, true);
    assertEquals(await app.store.listRunMessages(runId), []);
    // The prompt, then the cue, in that order; owed no more.
    assertEquals(
      (await post(app.handler, `/v1/runs/${runId}/messages`, { text: "Fix the bug." })).status,
      201,
    );
    const messages = await app.store.listRunMessages(runId);
    assertEquals(messages.map((m) => [m.kind, m.payload?.kind ?? null]), [
      ["user", null],
      ["system", "released"],
    ]);
    assertEquals(messages[1].payload, {
      kind: "released",
      path: "app",
      line: "work",
      onto: "main",
      forgeRef: "7",
      generation: 1,
    });
    const after = (await app.store.getTask(taskId))!.landings.app!.work!;
    assertEquals([after.releaseCueOwed, after.releasedRun, after.generation], [
      undefined,
      runId,
      1,
    ]);
    // The runner took the cue: its next submit is the next generation, which goes out as a fresh
    // change request against main.
    const run = { runId, runToken, repo };
    const next = await ship(app, run, "b".repeat(40), { generation: 2 });
    assertEquals([next.state, next.heldReason], ["submitted", null]);
    assertEquals(app.forge.submissions.at(-1)!.changeRequest, undefined);
    // A second message is an ordinary one: nothing is owed twice.
    await post(app.handler, `/v1/runs/${runId}/messages`, { text: "And the tests." });
    assertEquals((await releaseCues(app, runId)).length, 1);
  },
);

test(
  "a patch already waiting when the change request merged with nothing of the run on it is held, never sent to a fresh change request",
  async () => {
    const app = await buildApp();
    const run = await runOnChangeRequest(app);
    // Shipped and approved, but not delivered yet: it has no change request of its own.
    const waiting = await ship(app, run, "a".repeat(40), { approve: false });
    assertEquals((await post(app.handler, `/v1/patches/${waiting.id}/approve`)).status, 200);
    assertEquals((await app.store.getPatch(waiting.id))!.state, "queued");
    await forgeEvent(app, "merged", "7");
    const cues = await releaseCues(app, run.runId);
    assertEquals(cues.length, 1);
    // The cue names the generation the waiting patch was shipped in, the runner's own: it takes
    // the cue there, and its next submit replays that generation from its base as the next one.
    const ended = (cues[0].payload as { generation: number }).generation;
    assertEquals(ended, waiting.generation);
    const submissions = app.forge.submissions.length;
    await sweep(app);
    const held = (await app.store.getPatch(waiting.id))!;
    assertEquals([held.state, held.heldReason], ["pending_approval", HELD_REASON_ENDED]);
    assertEquals(app.forge.submissions.length, submissions);
    // The agent is told to submit again; the runner's next submit is the next generation.
    assertStringIncludes(
      (await textNotes(app, run.runId)).at(-1)!.text,
      "change request merged without any of its patches",
    );
    const next = await ship(app, run, "b".repeat(40), { generation: ended + 1 });
    assertEquals(next.state, "submitted");
    assertEquals(app.forge.submissions.at(-1)!.changeRequest, undefined);
    assertEquals((await app.store.getPatch(waiting.id))!.state, "superseded");
  },
);

test(
  "a patch the release reconcile did not get to is handed to the rule at the gate: the task let go, the patch held",
  async () => {
    // The reconcile's release fails once, as a database error would.
    let failOnce = true;
    const app = await buildApp((store) => ({
      ...store,
      releaseMergedTarget(args) {
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new Error("connection reset"));
        }
        return store.releaseMergedTarget(args);
      },
    }));
    const run = await runOnChangeRequest(app);
    const queued = await ship(app, run, "a".repeat(40), { approve: false });
    await forgeEvent(app, "merged", "7");
    assertEquals((await app.store.getTask(run.taskId))!.targetChangeRequest?.thread, "7");
    // Approved now: the gate finds the task still working the merged change request, lets it go,
    // and hands the patch to the landing rule, never to delivery nor to a failure.
    assertEquals((await post(app.handler, `/v1/patches/${queued.id}/approve`)).status, 200);
    const submissions = app.forge.submissions.length;
    await sweep(app);
    const held = (await app.store.getPatch(queued.id))!;
    assertEquals([held.state, held.attempts, held.lastError, held.heldReason], [
      "pending_approval",
      0,
      null,
      HELD_REASON_ENDED,
    ]);
    assertEquals((await app.store.getTask(run.taskId))!.targetChangeRequest, null);
    assertEquals((await releaseCues(app, run.runId)).length, 1);
    await sweep(app);
    assertEquals(app.forge.submissions.length, submissions);
  },
);

test(
  "a release made on another replica while the sweep delivers is seen by the rule before the task is read for the destination",
  async () => {
    // The release reconcile fails here at first, so the merge is settled but the task still
    // works #7 when the sweep claims the patch.
    let failRelease = true;
    let raced: (() => Promise<void>) | null = null;
    let reads = 0;
    const app = await buildApp((store) => ({
      ...store,
      releaseMergedTarget(args) {
        if (failRelease) return Promise.reject(new Error("connection reset"));
        return store.releaseMergedTarget(args);
      },
      // The sweep's third read of the task — its first is the patch's task, its second the rule's
      // after the claim, its third the one just before delivery: another replica's release
      // commits right after it.
      async getTask(taskId) {
        const read = await store.getTask(taskId);
        if (raced !== null && ++reads === 3) {
          const release = raced;
          raced = null;
          await release();
        }
        return read;
      },
    }));
    const run = await runOnChangeRequest(app);
    const waiting = await ship(app, run, "a".repeat(40), { approve: false });
    await forgeEvent(app, "merged", "7");
    assertEquals((await app.store.getTask(run.taskId))!.targetChangeRequest?.thread, "7");
    assertEquals((await post(app.handler, `/v1/patches/${waiting.id}/approve`)).status, 200);
    const submissions = app.forge.submissions.length;
    raced = async () => {
      failRelease = false;
      await reconcileMergeReleases({
        store: app.store,
        diag: silentDiagnostics(),
        now: app.clock.now,
      });
    };
    await sweep(app);
    const after = (await app.store.getPatch(waiting.id))!;
    assertEquals(app.forge.submissions.length, submissions);
    assertEquals([after.state, after.heldReason], ["pending_approval", HELD_REASON_ENDED]);
    assertEquals((await app.store.getTask(run.taskId))!.targetChangeRequest, null);
  },
);

test(
  "the destination is read off the patches the rule judged, so a sibling's verdict between two reads never sends a patch to a fresh change request",
  async () => {
    let armed = false;
    let taskReads = 0;
    let patchReads = 0;
    let verdict: (() => Promise<void>) | null = null;
    const app = await buildApp((store) => ({
      ...store,
      // The sweep's third read of the task is the one just before delivery: from then on, the
      // second read of the task's patches finds the earlier sibling merged.
      async getTask(taskId) {
        if (armed && ++taskReads === 3) patchReads = 0;
        return await store.getTask(taskId);
      },
      async patchesForTask(taskId) {
        if (armed && taskReads >= 3 && ++patchReads === 2 && verdict !== null) {
          const write = verdict;
          verdict = null;
          await write();
        }
        return await store.patchesForTask(taskId);
      },
    }));
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const second = await ship(app, run, "b".repeat(40), { approve: false });
    assertEquals((await post(app.handler, `/v1/patches/${second.id}/approve`)).status, 200);
    verdict = async () => {
      const read = (await app.store.getPatch(first.id))!;
      await settleOnce(app.store, read, "merged", app.clock.now().toISOString(), {
        mergedInto: "main",
      });
    };
    armed = true;
    await sweep(app);
    armed = false;
    // Judged with the first still open, it went onto the first's change request, as the rule
    // saw it: never to a fresh one.
    assertEquals(app.forge.submissions.at(-1)!.changeRequest, first.forgeRef);
  },
);

test(
  "a merge is recorded for a task that targets the change request though its run is over",
  async () => {
    const app = await buildApp();
    const run = await runOnChangeRequest(app);
    const waiting = await ship(app, run, "a".repeat(40), { approve: false });
    assertEquals((await end(app, run)).status, 200);
    await forgeEvent(app, "merged", "7");
    assert(await app.store.getChangeRequestMerge(run.repo.id, "7"));
    assertEquals((await app.store.getTask(run.taskId))!.targetChangeRequest, null);
    // Nobody left to cue.
    assertEquals(await releaseCues(app, run.runId), []);
    // Its waiting patch is held like any of a generation that ended, and a person who approves
    // it from its page sends it as a fresh change request.
    await sweep(app);
    assertEquals((await app.store.getPatch(waiting.id))!.heldReason, HELD_REASON_ENDED);
    assertEquals((await decide(app, waiting.id, "approve")).status, 200);
    await sweep(app);
    assertEquals((await app.store.getPatch(waiting.id))!.state, "submitted");
    assertEquals(app.forge.submissions.at(-1)!.changeRequest, undefined);
  },
);

test(
  "a containment that hangs holds its record until its deadline, and is then simply asked again",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.containment.answer = () =>
      new Promise<never>(() => {}) as unknown as MergeContainmentOutcome;
    const deps = { ...app.deps, forge: app.forge, now: app.clock.now };
    assertEquals((await deliver(app, "merged", first.forgeRef!)).status, 200);
    await reconcileMergeSettles(deps, { waitMs: 1 });
    // The hung ask stamped its deadline on the record before it asked.
    while (
      (await app.store.getChangeRequestMerge(run.repo.id, first.forgeRef!))!.nextAskAt === null
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // Before the deadline no sweep asks again: the record's clock says one is under way.
    app.clock.advance(MERGE_ASK_DEADLINE_MS - 1);
    await reconcileMergeSettles(deps, { waitMs: 1 });
    assertEquals(app.forge.containmentAsks.length, 1);
    // Past it, the ask is repeated, and its answer settles the patch.
    app.containment.answer = null;
    app.clock.advance(1);
    await reconcileMergeSettles(deps, { waitMs: 30_000 });
    assertEquals(app.forge.containmentAsks.length, 2);
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "merged");
  },
);

test(
  "a record listed due but claimed by another sweep before it is read is left to that sweep",
  async () => {
    // The listing as one read between another sweep's key pick and its row read: the record as
    // that sweep's claim left it, its clock ahead.
    const app = await buildApp((s) => ({
      ...s,
      async listChangeRequestMergesDue(now, limit) {
        const due = await s.listChangeRequestMergesDue(now, limit);
        const ahead = new Date(Date.parse(now) + MERGE_ASK_DEADLINE_MS).toISOString();
        for (const m of due) {
          await s.stampChangeRequestMerge(m.connectedRepoId, m.forgeRef, m, {
            settledAt: m.settledAt,
            attempts: m.attempts,
            nextAskAt: ahead,
            asking: true,
          });
        }
        return await Promise.all(
          due.map(async (m) => (await s.getChangeRequestMerge(m.connectedRepoId, m.forgeRef))!),
        );
      },
    }));
    const run = await runOnChangeRequest(app);
    const first = await ship(app, run, "a".repeat(40));
    assertEquals((await deliver(app, "merged", "7")).status, 200);
    await settle(app);
    assertEquals(app.forge.containmentAsks, []);
    assertEquals((await app.store.getPatch(first.id))!.landed, null);
  },
);

test(
  "an ask repeated past a lapsed one's deadline lands and cues the verdicts the lapsed one wrote",
  async () => {
    const app = await buildApp();
    const run = await runOnChangeRequest(app);
    const first = await ship(app, run, "a".repeat(40));
    // Each ask waits until the test answers it.
    const answers: Array<() => void> = [];
    app.containment.answer = ({ heads }) =>
      new Promise((resolve) =>
        answers.push(() => resolve({ kind: "answered", contained: [...heads], missed: [] }))
      );
    const deps = { ...app.deps, forge: app.forge, now: app.clock.now };
    assertEquals((await deliver(app, "merged", "7")).status, 200);
    const lapsed = reconcileMergeSettles(deps, { waitMs: 1 });
    await until(() => answers.length === 1);
    // Past its deadline a second ask starts, its read of the patches from before any verdict.
    app.clock.advance(MERGE_ASK_DEADLINE_MS);
    const repeated = reconcileMergeSettles(deps, { waitMs: 1 });
    await until(() => answers.length === 2);
    // The lapsed ask answers first: its verdict stands, its stamp is refused.
    answers[0]!();
    await lapsed;
    await until(async () => (await app.store.getPatch(first.id))!.landed !== null);
    // The repeated one settles nothing new, wins the stamp, and lands and cues what merged.
    answers[1]!();
    await repeated;
    await until(async () => (await mergedCues(app, run.runId)).length > 0);
    assertEquals((await mergedCues(app, run.runId)).map((c) => c!.patchId), [first.id]);
    assertEquals((await app.store.getTask(run.taskId))!.landings.app?.work?.onto, "main");
  },
);

test(
  "a retry's clock never reopens a merge record another settle closed meanwhile",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    const repo = (await app.store.getConnectedRepo(run.repo.id))!;
    const read = await app.store.recordChangeRequestMerge({
      connectedRepoId: repo.id,
      forgeRef: first.forgeRef!,
      mergedInto: "main",
      heads: [MERGED_HEAD],
      at: app.clock.now().toISOString(),
    });
    // One settle answers and closes the record; a retry's stamp over the record as it was read
    // before is refused.
    await settle(app);
    assert(
      !await app.store.stampChangeRequestMerge(repo.id, first.forgeRef!, read, {
        settledAt: null,
        attempts: 1,
        nextAskAt: app.clock.now().toISOString(),
      }),
    );
    const after = (await app.store.getChangeRequestMerge(repo.id, first.forgeRef!))!;
    assert(after.settledAt !== null);
    assertEquals([after.attempts, after.nextAskAt], [0, null]);
  },
);

test(
  "a generation's merged cue goes out before its missed note, even when the merged one has to wait",
  async () => {
    // The merged cue's claim is held by another poster at the merge: it goes out from the
    // outbox later, and the missed note waits for it.
    let refuseClaims = true;
    const app = await buildApp((store) => ({
      ...store,
      claimMergedCue(id, at, staleBefore) {
        return refuseClaims ? Promise.resolve(false) : store.claimMergedCue(id, at, staleBefore);
      },
    }));
    const run = await ownRun(app);
    const r1 = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const r2 = await ship(app, run, "b".repeat(40));
    app.containment.answer = ({ heads }) => ({
      kind: "answered",
      contained: heads.filter((h) => h === r1.headSha),
      missed: heads.filter((h) => h !== r1.headSha),
    });
    await forgeEvent(app, "merged", r1.forgeRef!, { heads: [r1.headSha] });
    assertEquals((await app.store.getPatch(r2.id))!.landed?.kind, "missed");
    // The missed note waits, though its own claim would be free.
    refuseClaims = false;
    const deps = { ...app.deps, now: app.clock.now };
    assertEquals(await cueMerged(deps, r2.id, app.clock.now().toISOString()), true);
    assertEquals(await missedCues(app, run.runId), []);
    // The outbox posts both, the merged one first.
    app.clock.advance(MERGED_CUE_LEASE_MS + 1);
    await sweep(app);
    const order = (await app.store.listRunMessages(run.runId))
      .map((m) => m.payload as PatchPayload | null)
      .filter((p) => p?.kind === "patch" && (p.state === "merged" || p.state === "missed"))
      .map((p) => [p!.state, p!.patchId]);
    assertEquals(order, [["merged", r1.id], ["missed", r2.id]]);
  },
);

test(
  "a missed note's late mark never swallows the merged cue a revision owes",
  async () => {
    const hook: { fire: null | (() => Promise<void>) } = { fire: null };
    const app = await buildApp((store) => ({
      ...store,
      async appendRunMessage(message) {
        const out = await store.appendRunMessage(message);
        const payload = message.payload as PatchPayload | null;
        if (payload?.kind === "patch" && payload.state === "missed" && hook.fire !== null) {
          const fire = hook.fire;
          hook.fire = null;
          await fire();
        }
        return out;
      },
    }));
    const run = await ownRun(app);
    const r1 = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const r2 = await ship(app, run, "b".repeat(40));
    app.containment.answer = ({ heads, mergedHeads }) => ({
      kind: "answered",
      contained: heads.filter((h) => mergedHeads.includes(h) || h === r1.headSha),
      missed: heads.filter((h) => !(mergedHeads.includes(h) || h === r1.headSha)),
    });
    // While r2's missed note is being posted, a later merge's settle revises r2 to merged.
    hook.fire = async () => {
      const now = (await app.store.getPatch(r2.id))!;
      const revised = await settleOnce(app.store, now, "merged", app.clock.now().toISOString(), {
        mergedInto: "main",
      });
      assert(revised !== null, "the revision was refused");
    };
    await forgeEvent(app, "merged", r1.forgeRef!, { heads: [r1.headSha] });
    assertEquals(hook.fire, null);
    // The later merge goes on: it names r2's head, and the run is owed r2's merged cue.
    await forgeEvent(app, "merged", r1.forgeRef!, { heads: [r2.headSha] });
    await sweep(app);
    assertEquals((await app.store.getPatch(r2.id))!.landed?.kind, "merged");
    assert((await mergedCues(app, run.runId)).some((c) => c!.patchId === r2.id));
  },
);

test(
  "a merge that named no head has the forge read what merged off the change request, and is judged against that",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    app.changeRequestHead.answer = (ref) => ({
      kind: "head",
      head: {
        ref,
        state: "closed",
        merged: true,
        headSha: first.headSha,
        authorHeadSha: first.headSha,
        baseRef: "main",
        openedByUs: true,
        mergedHeads: [first.headSha],
      },
    });
    await forgeEvent(app, "merged", first.forgeRef!, { heads: [] });
    // The read grew the record; the next tick asks containment against it.
    const merge = (await app.store.getChangeRequestMerge(run.repo.id, first.forgeRef!))!;
    assertEquals(merge.heads, [first.headSha]);
    await settle(app);
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "merged");
    assertEquals((await mergedCues(app, run.runId)).map((c) => c!.patchId), [first.id]);
    assertEquals(app.forge.containmentAsks.at(-1)!.mergedHeads, [first.headSha]);
  },
);

test(
  "a merged cue's landed head is the newest head that merged, whichever rule held it",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const r1 = await ship(app, run, "a".repeat(40));
    app.clock.advance(1_000);
    const r2 = await ship(app, run, "b".repeat(40));
    app.clock.advance(1_000);
    const r3 = await ship(app, run, "c".repeat(40));
    // r1 is in what merged; r2's change is exactly what merged, though r2 is not in its history
    // (a person rebased the change request before merging it); r3 merged only in part. The
    // forge's answer names no rule: a contained head is landed whichever held it.
    app.containment.answer = ({ heads }) => ({
      kind: "answered",
      contained: heads.filter((h) => h !== r3.headSha),
      missed: heads.filter((h) => h === r3.headSha),
    });
    await forgeEvent(app, "merged", r1.forgeRef!, { heads: [r1.headSha] });
    // The merge record's branch rode along with the question.
    assertEquals(app.forge.containmentAsks.at(-1)!.into, "main");
    assertEquals(
      (await mergedCues(app, run.runId)).map((c) => [c!.patchId, c!.onto, c!.landedHead]),
      [[r2.id, "main", r2.headSha]],
    );
    assertEquals((await app.store.getPatch(r3.id))!.landed?.kind, "missed");
  },
);

test(
  "two change requests of one generation merging with none of it, racing: the run hears the generation end, once per change request at most",
  async () => {
    const violations: string[] = [];
    for (let round = 0; round < 20; round++) {
      const on = { value: false };
      const app = await buildApp((s) => jittered(s, on, round));
      const run = await ownRun(app);
      const first = await ship(app, run, "a".repeat(40));
      app.clock.advance(1_000);
      const elsewhere = await ship(app, run, "b".repeat(40));
      await app.store.savePatch({
        ...(await app.store.getPatch(elsewhere.id))!,
        forgeRef: "9",
        forgeUrl: "https://github.com/acme/app/pull/9",
      });
      app.containment.answer = ({ heads }) => ({
        kind: "answered",
        contained: [],
        missed: heads,
      });
      // Another replica's sweep, with asks of its own.
      const replica = {
        store: app.store,
        forge: app.forge,
        diag: silentDiagnostics(),
        memoryAccess: app.deps.memoryAccess,
        now: app.clock.now,
      };
      on.value = true;
      await Promise.all([
        deliver(app, "merged", first.forgeRef!, { heads: ["e".repeat(40)] }),
        deliver(app, "merged", "9", { heads: ["9".repeat(40)] }),
        settle(app),
        reconcileMergeSettles(replica, { waitMs: 200 }),
        sweep(app),
      ]);
      on.value = false;
      for (let i = 0; i < 4; i++) {
        app.clock.advance(61_000);
        await sweep(app);
        await settle(app);
      }
      const ending = (await app.store.listRunMessages(run.runId))
        .map((m) => m.payload as PatchPayload | null)
        .filter((p) => p?.kind === "patch" && p.state === "missed" && p.onto !== undefined);
      // Each merge ends the generation on its own (neither waits on a patch the other judges);
      // one that comes second is a repeat the runner takes as no news.
      const told = ending.map((p) => p!.patchId);
      if (told.length === 0 || new Set(told).size !== told.length) {
        violations.push(`${round}: cues ${told.join(", ")} end it`);
      }
      for (const p of [first, elsewhere]) {
        const now = (await app.store.getPatch(p.id))!;
        if (now.landed?.kind !== "missed") violations.push(`${round}: ${p.id} ${now.landed?.kind}`);
        if (now.mergedCuedAt === null) violations.push(`${round}: ${p.id} uncued`);
      }
      const landing = (await app.store.getTask(run.taskId))!.landings.app?.work;
      if (landing?.generation !== 1) {
        violations.push(`${round}: landing ${JSON.stringify(landing)}`);
      }
    }
    assertEquals(violations, []);
  },
  ON_POSTGRES ? 180_000 : 30_000,
);

test("a birth maps the heads it carries onto the run's own patches, and memory hears them", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const report = (sha: string, carries: string[] = []) =>
    post(app.handler, `/v1/runs/${run.runId}/patches`, {
      branch: { ...BRANCH(run.runId, run.repo.id, sha), carries },
      baseSha: "0".repeat(40),
    }, run.runToken);
  const { patchId: a } = await (await report("a".repeat(40))).json();
  // A head no patch of the run has is no edge.
  const born = await report("b".repeat(40), ["a".repeat(40), "c".repeat(40)]);
  const { patchId: b } = await born.json();
  assertEquals(born.status, 201);
  assertEquals((await app.store.getPatch(b))!.carries, [a]);
  assertEquals(app.reports.at(-1), { patchId: b, carries: [a] });
  // The same head again is adopted as it stands.
  const again = await report("b".repeat(40), ["a".repeat(40)]);
  assertEquals([again.status, (await again.json()).patchId], [200, b]);
});

test(
  "a push the forge refuses because the change request the task works merged stays retryable, and is held once the merge ends its generation",
  async () => {
    const app = await buildApp();
    const run = await runOnChangeRequest(app);
    const waiting = await ship(app, run, "a".repeat(40), { approve: false });
    // The forge refuses the push: #7 merged, which nobody here has heard yet.
    const submit = app.forge.submitPatch.bind(app.forge);
    let refuse = true;
    app.forge.submitPatch = (submission) =>
      refuse
        ? Promise.resolve({
          kind: "failed" as const,
          message: "the change request merged",
          terminal: true,
          ended: "merged" as const,
        })
        : submit(submission);
    assertEquals((await post(app.handler, `/v1/patches/${waiting.id}/approve`)).status, 200);
    await sweep(app);
    const failed = (await app.store.getPatch(waiting.id))!;
    assertEquals(failed.state, "failed");
    assert(failed.nextAttemptAt !== null, "failed for good");
    // The merge is heard: the task is let go, and the patch — of the generation the release
    // ended, built on #7's head — is held for the run's next submit, never sent on its own.
    refuse = false;
    await forgeEvent(app, "merged", "7");
    app.clock.advance(60 * 60_000);
    await sweep(app);
    const held = (await app.store.getPatch(waiting.id))!;
    assertEquals([held.state, held.heldReason], ["pending_approval", HELD_REASON_ENDED]);
    assertEquals((await app.store.getTask(run.taskId))!.targetChangeRequest, null);
  },
);

test("two processes reading the same due record start one ask between them", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const first = await ship(app, run, "a".repeat(40));
  assertEquals((await deliver(app, "merged", first.forgeRef!)).status, 200);
  // Each its own asks under way, as two replicas have; both read the record before either wrote.
  const read = (await app.store.getChangeRequestMerge(run.repo.id, first.forgeRef!))!;
  const replica = () => ({
    ...app.deps,
    store: { ...app.store, listChangeRequestMergesDue: () => Promise.resolve([read]) },
    forge: app.forge,
    now: app.clock.now,
  });
  await Promise.all([
    reconcileMergeSettles(replica(), { waitMs: 50 }),
    reconcileMergeSettles(replica(), { waitMs: 50 }),
  ]);
  assertEquals(app.forge.containmentAsks.length, 1);
});

test(
  "a merge record whose settle throws is pushed back, so it never keeps the rest out of the batch",
  async () => {
    let broken: string | null = null;
    const app = await buildApp((store) => ({
      ...store,
      patchesByRepoAndForgeRef(connectedRepoId, forgeRef) {
        if (forgeRef === broken) return Promise.reject(new Error("bad row"));
        return store.patchesByRepoAndForgeRef(connectedRepoId, forgeRef);
      },
    }));
    const run = await ownRun(app);
    const first = await ship(app, run, "a".repeat(40));
    assertEquals((await deliver(app, "merged", first.forgeRef!)).status, 200);
    broken = first.forgeRef!;
    await settle(app);
    const record = (await app.store.getChangeRequestMerge(run.repo.id, first.forgeRef!))!;
    assertEquals(record.settledAt, null);
    assertEquals(
      record.nextAskAt,
      new Date(app.clock.now().getTime() + MERGE_SETTLE_RETRY_MS).toISOString(),
    );
    assertEquals(await app.store.listChangeRequestMergesDue(app.clock.now().toISOString(), 10), []);
    // Mended, it is taken up once its retry comes round.
    broken = null;
    app.clock.advance(MERGE_SETTLE_RETRY_MS);
    await settle(app);
    assertEquals((await app.store.getPatch(first.id))!.landed?.kind, "merged");
  },
);

test("a merge record whose release throws waits out a retry behind the rest", async () => {
  let failing = true;
  const app = await buildApp((store) => ({
    ...store,
    releaseMergedTarget(args) {
      if (failing) return Promise.reject(new Error("connection reset"));
      return store.releaseMergedTarget(args);
    },
  }));
  const run = await runOnChangeRequest(app);
  await forgeEvent(app, "merged", "7");
  const record = (await app.store.getChangeRequestMerge(run.repo.id, "7"))!;
  assertEquals(record.releasedAt, null);
  assertEquals(
    record.releaseRetryAt,
    new Date(app.clock.now().getTime() + RELEASE_RETRY_MS).toISOString(),
  );
  assertEquals(await app.store.listMergesOwingRelease(app.clock.now().toISOString(), 20), []);
  failing = false;
  app.clock.advance(RELEASE_RETRY_MS);
  await settle(app);
  assertEquals((await app.store.getTask(run.taskId))!.targetChangeRequest, null);
  assert((await app.store.getChangeRequestMerge(run.repo.id, "7"))!.releasedAt !== null);
});

test("a release names the run's current generation at the path, as its runner counts it", () => {
  const patches = [
    { path: "app", line: "work", generation: 1 },
    { path: "app", line: "work", generation: 2 },
    // Another line's generations are its own: a release ends only the default line's.
    { path: "app", line: "fix-a", generation: 3 },
    { path: "lib", line: "work", generation: 4 },
  ];
  // Its newest patch of the default line at the path, in any state; nothing there: the first.
  assertEquals(releaseGeneration("app", patches), 2);
  assertEquals(releaseGeneration("web", patches), 1);
  assertEquals(releaseGeneration("app", []), 1);
});

test(
  "a re-target after a release drops the release's landing: patches onto the change request now worked go out, and its merge releases the same generation again",
  async () => {
    const app = await buildApp();
    const run = await runOnChangeRequest(app);
    await forgeEvent(app, "merged", "7");
    assertEquals((await app.store.getTask(run.taskId))!.landings.app?.work?.releasedRun, run.runId);
    // The agent checks out #9 before it ever submitted: its runner drops its landing and stays in
    // generation 1, and so does the task.
    const moved = await post(
      app.handler,
      `/v1/runs/${run.runId}/target`,
      { path: "app", changeRequest: "9" },
      run.runToken,
    );
    assertEquals(moved.status, 200, await moved.clone().text());
    const task = (await app.store.getTask(run.taskId))!;
    assertEquals([task.targetChangeRequest?.thread, task.landings], ["9", {}]);
    // Its patch goes onto #9, never held by the release of #7.
    const onto = await ship(app, run, "a".repeat(40));
    assertEquals([onto.state, onto.heldReason, onto.forgeRef], ["submitted", null, "9"]);
    assertEquals(app.forge.submissions.at(-1)!.changeRequest, "9");

    // Again, on a fresh run: this time #9 merges with nothing of the run on it, and its release
    // names generation 1 again — the one the runner is in.
    const other = await buildApp();
    const second = await runOnChangeRequest(other);
    await forgeEvent(other, "merged", "7");
    const again = await post(
      other.handler,
      `/v1/runs/${second.runId}/target`,
      { path: "app", changeRequest: "9" },
      second.runToken,
    );
    assertEquals(again.status, 200, await again.clone().text());
    await forgeEvent(other, "merged", "9");
    assertEquals((await releaseCues(other, second.runId)).map((c) => c.payload), [
      {
        kind: "released",
        path: "app",
        line: "work",
        onto: "main",
        forgeRef: "7",
        generation: 1,
      },
      {
        kind: "released",
        path: "app",
        line: "work",
        onto: "main",
        forgeRef: "9",
        generation: 1,
      },
    ]);
    const landing = (await other.store.getTask(second.taskId))!.landings.app?.work;
    assertEquals([landing?.thread, landing?.generation, landing?.releasedRun], [
      "9",
      1,
      second.runId,
    ]);
  },
);

test("cue texts leave the exact rebase to the runner's note, and spell out no command", () => {
  const released = releasedCueNote("7", "app", "main");
  assertStringIncludes(
    released,
    "Rebase your commits in `app` onto `origin/main` (ryph adds a note with the exact " +
      "command; if there is none, call ryph__update_from_base), and your next submit_patch " +
      "opens a new change request.",
  );
  assert(!released.includes("git rebase"), released);
});

test(
  "a next generation that does not hold the tip its line merged at is held with its reason, whatever the runner says, and goes out once one approves it with the diff in view",
  async () => {
    const app = await buildApp();
    const run = await ownRun(app);
    const tip = "c".repeat(40);
    app.containment.answer = (ask) => ({
      kind: "answered",
      contained: [...ask.heads],
      missed: [],
      intoTip: tip,
    });
    const first = await ship(app, run, "a".repeat(40));
    await forgeEvent(app, "merged", first.forgeRef!);
    assertEquals(
      (await app.store.getTask(run.taskId))!.landings.app.work.tip,
      tip,
    );
    const policy = await app.handler(
      new Request(`http://orchestrator.test/v1/connected-repos/${run.repo.id}`, {
        method: "PATCH",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ submissionPolicy: "auto" }),
      }),
    );
    assertEquals(policy.status, 200, await policy.clone().text());
    // An explicit submit the runner says nothing about: the forge reads that it lacks the tip.
    app.lineage.holdsTip = false;
    const born = await post(app.handler, `/v1/runs/${run.runId}/patches`, {
      branch: BRANCH(run.runId, run.repo.id, "b".repeat(40), 2),
      baseSha: "0".repeat(40),
    }, run.runToken);
    assertEquals(born.status, 201, await born.clone().text());
    assertEquals(app.forge.lineageAsks.at(-1)?.mustHold, tip);
    const { patchId } = await born.json();
    const held = (await app.store.getPatch(patchId))!;
    assertEquals([held.state, held.heldReason], ["pending_approval", unrebasedReason("main")]);
    // Not a landing hold: a person may send it while the run goes on, never blind.
    assert(!isLandingHold(held));
    assert(
      (await app.store.listEvents(run.runId)).some((e) =>
        e.kind === "patch-held" && e.detail === held.heldReason
      ),
    );
    await sweep(app);
    assertEquals((await app.store.getPatch(patchId))!.state, "pending_approval");
    const blind = await post(app.handler, `/v1/patches/${patchId}/approve`);
    assertEquals((await blind.json()).code, "held_needs_diff");
    assertEquals((await decide(app, patchId, "approve")).status, 200);
    await sweep(app);
    assertEquals((await app.store.getPatch(patchId))!.state, "submitted");
    // One that holds it goes out on its own, as any explicit submit on an auto repo.
    app.lineage.holdsTip = true;
    const rebased = await post(app.handler, `/v1/runs/${run.runId}/patches`, {
      branch: BRANCH(run.runId, run.repo.id, "d".repeat(40), 2),
      baseSha: "0".repeat(40),
    }, run.runToken);
    assertEquals((await rebased.json()).state, "queued");
  },
);

test("a landing whose tip nobody read asks nothing: an explicit submit on an auto repo goes out", async () => {
  const app = await buildApp();
  const run = await ownRun(app);
  const first = await ship(app, run, "a".repeat(40));
  await forgeEvent(app, "merged", first.forgeRef!);
  assertEquals((await app.store.getTask(run.taskId))!.landings.app.work.tip, undefined);
  await app.handler(
    new Request(`http://orchestrator.test/v1/connected-repos/${run.repo.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ submissionPolicy: "auto" }),
    }),
  );
  const born = await post(app.handler, `/v1/runs/${run.runId}/patches`, {
    branch: BRANCH(run.runId, run.repo.id, "b".repeat(40), 2),
    baseSha: "0".repeat(40),
  }, run.runToken);
  const sent = (await app.store.getPatch((await born.json()).patchId))!;
  assertEquals([sent.state, sent.heldReason], ["queued", null]);
  assertEquals(app.forge.lineageAsks, []);
});

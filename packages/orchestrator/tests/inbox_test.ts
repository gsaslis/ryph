import { test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// The run inbox, end to end through the pure handler: a person or a chatroom posts, the runner
// pulls (and its next pull acknowledges), a terminal run refuses everybody, the first person
// flips the run to attended, and every patch verdict lands as a system message the runner can
// act on. Plus the mid-run patch route: a patch born while the run goes on, adopted by the
// result that lists it afterwards.

import { capsClaimOf } from "@ryph/auth";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import { makeInboxSignal } from "../src/core/inbox_signal.ts";
import { notifyPatch, postMessage } from "../src/core/inbox.ts";
import { planSweep, type SweepConfig } from "../src/core/lifecycle.ts";
import { sweep, sweepPatches } from "../src/core/reaper.ts";
import { openPatchForRun } from "../src/core/open_patch.ts";
import { DEFAULT_PATCH_SUBMIT_CONFIG } from "../src/core/patch_lifecycle.ts";
import type { MemoryAccess } from "../src/ports/memory_access.ts";
import { type NamedRunMessage, nameSenders } from "../src/http/user/message_senders.ts";
import type { PatchPayload, Run, RunMessage } from "../src/core/types.ts";
import { DEFAULT_ATTENDED_IDLE_MS, DEFAULT_IDLE_MS } from "../src/core/types.ts";
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
const CFG: SweepConfig = {
  heartbeatTimeoutMs: 60_000,
  startupGraceMs: 300_000,
  cancelGraceMs: 120_000,
  idleGraceMs: 60_000,
};

function recordingMemory() {
  const patches: Array<{ runId: string; patchId: string; forgeUrl: string | null }> = [];
  const changes: Array<{ runId: string; patchId: string; fate: string }> = [];
  const memoryAccess = {
    composeBrief: () => Promise.resolve(null),
    reportOutcome: () => Promise.resolve(),
    reportPatch(runId: string, patch: { patchId: string; forgeUrl: string | null }) {
      patches.push({ runId, patchId: patch.patchId, forgeUrl: patch.forgeUrl });
      return Promise.resolve();
    },
    reportChange(runId: string, patchId: string, fate: string) {
      changes.push({ runId, patchId, fate });
      return Promise.resolve();
    },
    reportStale: () => Promise.resolve(),
  } as MemoryAccess;
  return { memoryAccess, patches, changes };
}

function buildApp() {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner, launches } = fakeProvisioner();
  const identities = fakeIdentityDirectory();
  const { control, cancels } = fakeRunnerControl({ reachable: true });
  const forge = noopForge(silentDiagnostics(), { permission: "allowed", repos: [REPO_LISTING] });
  const memory = recordingMemory();
  const inbox = makeInboxSignal();
  const deps = {
    store,
    provisioner,
    runnerControl: control,
    diag: silentDiagnostics(),
    authenticate: (() => Promise.resolve(USER)) as unknown as Authenticate,
    forgeToken: "forge-service-token",
    forge,
    githubConnect: forge,
    identityDirectory: identities.directory,
    memoryAccess: memory.memoryAccess,
    inbox,
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
  };
  return {
    handler: makeHandler(deps),
    deps,
    store,
    clock,
    identities,
    launches,
    cancels,
    forge,
    memory,
    inbox,
  };
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
const get = (handler: Handler, path: string, token = "t", signal?: AbortSignal) =>
  handler(
    new Request(`http://orchestrator.test${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    }),
  );

/** Link, install, connect, mint an agent, launch a task: a live run to speak to. */
async function liveRun(
  app: ReturnType<typeof buildApp>,
  lifetime: unknown = { idleMs: 300_000, attendedIdleMs: 1_800_000 },
) {
  app.identities.link(USER.userId, "noop-ada-lovelace");
  await post(app.handler, "/v1/installations", { installationId: "42" });
  const repo = await (await post(app.handler, "/v1/connected-repos", {
    installationId: "42",
    repoRef: "acme/app",
  })).json();
  const agent = await (await post(app.handler, "/v1/agents", {
    name: "Ada",
    email: "ada@example.com",
    harnessKind: "echo",
  })).json();
  const created = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Investigate the alert", instructions: "Look at the cache first." },
    connectedRepoId: repo.id,
    // `"none"` sends no lifetime at all — the default the schema fills in.
    ...(lifetime === "none" ? {} : { lifetime }),
  });
  assertEquals(created.status, 201);
  const { taskId, runId } = await created.json();
  const runToken = (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN;
  // A heartbeat, so the run is `running` and not merely `starting`.
  await post(app.handler, `/v1/runs/${runId}/heartbeat`, { seq: 0, phase: "running" }, runToken);
  return { taskId, runId, runToken, repo, agent };
}

const BRANCH = (runId: string, connectedRepoId: string, sha: string, generation = 1) => ({
  connectedRepoId,
  path: "app",
  name: generation === 1 ? `ryph/ada/${runId}/work` : `ryph/ada/${runId}/work-${generation}`,
  line: "work",
  headSha: sha,
  commits: [{ sha, subject: "fix" }],
  generation,
  carries: [],
});

test("a message posts, the runner pulls it, and the next pull acknowledges it", async () => {
  const app = buildApp();
  const { taskId, runId, runToken } = await liveRun(app);

  // The lifetime froze onto the task and the work item.
  const task = (await app.store.getTask(taskId))!;
  assertEquals(task.lifetime, {
    idleMs: 300_000,
    attendedIdleMs: 1_800_000,
  });
  const spec = await (await get(app.handler, `/v1/runs/${runId}/spec`, runToken)).json();
  assertEquals(spec.workItem.lifetime, task.lifetime);

  // Nothing yet: an empty batch, at once when no wait is asked for.
  const empty = await get(app.handler, `/v1/runs/${runId}/messages?after=-1`, runToken);
  assertEquals(empty.status, 200);
  assertEquals(await empty.json(), { messages: [] });

  const posted = await post(app.handler, `/v1/runs/${runId}/messages`, {
    text: "@ryph look at the cache first",
  });
  assertEquals(posted.status, 201);
  const { message } = await posted.json() as { message: NamedRunMessage };
  assertEquals(message.seq, 0);
  assertEquals(message.kind, "user");
  // Named for the person who reads it back: the caller, off their own principal.
  assertEquals(message.sender, { kind: "user", userId: "u-1", name: "Ada" });
  assertEquals(message.deliveredAt, null);
  // Stored by id alone: a name frozen into the row would go stale on a rename.
  assertEquals((await app.store.listRunMessages(runId))[0].sender, { kind: "user", userId: "u-1" });

  const pulled = await (await get(app.handler, `/v1/runs/${runId}/messages?after=-1`, runToken))
    .json();
  assertEquals(pulled.messages.map((m: RunMessage) => [m.seq, m.text]), [[0, message.text]]);

  // The next pull, past seq 0, is the acknowledgement of everything up to it.
  await post(app.handler, `/v1/runs/${runId}/messages`, { text: "second" });
  const next = await (await get(app.handler, `/v1/runs/${runId}/messages?after=0`, runToken))
    .json();
  assertEquals(next.messages.map((m: RunMessage) => m.seq), [1]);
  const stored = await app.store.listRunMessages(runId);
  assertEquals(stored.map((m) => [m.seq, m.deliveredAt !== null]), [[0, true], [1, false]]);

  // The task page sees the whole inbox beside the run.
  const detail = await (await get(app.handler, `/v1/tasks/${taskId}`)).json();
  assertEquals(detail.runs[0].messages.map((m: RunMessage) => m.seq), [0, 1]);
  assertEquals(detail.response, null);

  // A bad cursor is a 400, not a guess; the wrong token learns nothing.
  assertEquals(
    (await get(app.handler, `/v1/runs/${runId}/messages?after=x`, runToken)).status,
    400,
  );
  assertEquals((await get(app.handler, `/v1/runs/${runId}/messages`, "nope")).status, 401);
});

test("the task page names who said what: the reader, a colleague, a former member", async () => {
  const app = buildApp();
  const { taskId, runId } = await liveRun(app);
  app.identities.name("u-2", "Max Member");
  let reads = 0;
  const nameFor = app.identities.directory.nameFor;
  app.identities.directory.nameFor = (id) => {
    reads += 1;
    return nameFor(id);
  };
  const run = (await app.store.getRun(runId))!;
  const say = (userId: string, text: string) =>
    postMessage(app.deps, run, { kind: "user", sender: { kind: "user", userId }, text });
  await post(app.handler, `/v1/runs/${runId}/messages`, { text: "look at the cache" });
  await say("u-2", "and the queue");
  await say("u-2", "please");
  await say("u-3", "said before they left");
  app.identities.deactivate("u-3");
  await say("break-glass", "from the console");

  const detail = await (await get(app.handler, `/v1/tasks/${taskId}`)).json();
  assertEquals(detail.runs[0].messages.map((m: { sender: unknown }) => m.sender), [
    { kind: "user", userId: "u-1", name: "Ada" },
    { kind: "user", userId: "u-2", name: "Max Member" },
    { kind: "user", userId: "u-2", name: "Max Member" },
    { kind: "user", userId: "u-3", name: null },
    { kind: "user", userId: "break-glass", name: null },
  ]);
  // One read per other person, however often they spoke; none for the reader or break-glass.
  assertEquals(reads, 2);
});

test("someone the directory cannot be asked about goes unnamed, not as a former member", async () => {
  // No directory in this deployment: a colleague is still a colleague, so the sender carries no
  // name at all and the app names them neutrally ("A person"), where null would read as having left.
  const message = (userId: string, seq: number): RunMessage => ({
    id: `m-${seq}`,
    runId: "r-1",
    seq,
    kind: "user",
    sender: { kind: "user", userId },
    text: "hello",
    payload: null,
    attachments: [],
    createdAt: new Date(0).toISOString(),
    deliveredAt: null,
  });
  const [named] = await nameSenders(null, USER, [
    [message("u-1", 0), message("u-2", 1)],
  ]);
  assertEquals(named.map((m) => m.sender), [
    { kind: "user", userId: "u-1", name: "Ada" },
    { kind: "user", userId: "u-2" },
  ]);
});

test("a failed name lookup leaves that person unnamed and the task page still loads", async () => {
  const app = buildApp();
  const { taskId, runId } = await liveRun(app);
  app.identities.name("u-2", "Max Member");
  const nameFor = app.identities.directory.nameFor;
  app.identities.directory.nameFor = (id) =>
    id === "u-3" ? Promise.reject(new Error("connection reset")) : nameFor(id);
  const run = (await app.store.getRun(runId))!;
  const say = (userId: string, text: string) =>
    postMessage(app.deps, run, { kind: "user", sender: { kind: "user", userId }, text });
  await say("u-2", "and the queue");
  await say("u-3", "and the cache");

  const res = await get(app.handler, `/v1/tasks/${taskId}`);
  assertEquals(res.status, 200);
  const detail = await res.json();
  assertEquals(detail.runs[0].messages.map((m: { sender: unknown }) => m.sender), [
    { kind: "user", userId: "u-2", name: "Max Member" },
    { kind: "user", userId: "u-3" },
  ]);
});

test("a read with ack=0 hands back what is past the cursor and acknowledges nothing", async () => {
  // The runner's last look for patch cues before it ships: a person's message the agent never
  // saw must not be stamped as delivered to it.
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  await post(app.handler, `/v1/runs/${runId}/messages`, { text: "first" });
  await post(app.handler, `/v1/runs/${runId}/messages`, { text: "are you there?" });
  const peeked = await (await get(
    app.handler,
    `/v1/runs/${runId}/messages?after=0&ack=0`,
    runToken,
  )).json();
  assertEquals(peeked.messages.map((m: RunMessage) => m.seq), [1]);
  const stored = await app.store.listRunMessages(runId);
  assertEquals(stored.map((m) => [m.seq, m.deliveredAt]), [[0, null], [1, null]]);
});

test("a held pull wakes the moment a message is posted", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  const started = performance.now();
  const waiting = get(app.handler, `/v1/runs/${runId}/messages?after=-1&wait=25`, runToken);
  // Let the poll settle into its wait before the post; a microtask is enough for the
  // in-memory store.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await post(app.handler, `/v1/runs/${runId}/messages`, { text: "wake up" });
  const answered = await (await waiting).json();
  assertEquals(answered.messages.map((m: RunMessage) => m.text), ["wake up"]);
  assert(performance.now() - started < 900, "the wait ended on the signal, not the clock");
});

test("the first person flips the run to attended, once; the platform's notes do not", async () => {
  const app = buildApp();
  const { runId } = await liveRun(app);
  assertEquals((await app.store.getRun(runId))!.attended, false);
  await post(app.handler, `/v1/runs/${runId}/messages`, { text: "hello" });
  await post(app.handler, `/v1/runs/${runId}/messages`, { text: "again" });
  assertEquals((await app.store.getRun(runId))!.attended, true);
  const events = (await app.store.listEvents(runId)).filter((e) => e.kind === "attended");
  assertEquals(events.length, 1);
});

test("a message racing the run's own result never rolls that result back", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  // The copy every postMessage caller holds: read before the runner reported, and stale the
  // moment it does. The HTTP door reads one, hands it over, and the result lands in between.
  const stale = (await app.store.getRun(runId))!;
  assertEquals(stale.result, null);

  await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [],
    summary: "capped the retries",
  }, runToken);
  assertEquals((await app.store.getRun(runId))!.state, "succeeded");

  // Posted with the stale copy in hand: the run is terminal in the store, so only the narrow
  // `attended` write may land. A full-row write of `stale` would put `state: running,
  // result: null` back over a concluded run — and applyResult, guarded on `result !== null`,
  // would then call every later report a duplicate, so no result could ever land again.
  const outcome = await postMessage(app.deps, stale, {
    kind: "user",
    sender: { kind: "user", userId: "u-1" },
    text: "are you there?",
  });
  assertEquals(outcome.kind, "posted");
  const after = (await app.store.getRun(runId))!;
  assertEquals(after.state, "succeeded");
  assert(after.result !== null, "the runner's result survived the racing message");
  assertEquals(after.attended, true);
});

test("a terminal run refuses messages, and an over-long one is refused at the door", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  const long = await post(app.handler, `/v1/runs/${runId}/messages`, { text: "x".repeat(16_385) });
  assertEquals(long.status, 400);
  await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "failure",
    reason: "gave up",
    summary: "",
    branches: [],
  }, runToken);
  const late = await post(app.handler, `/v1/runs/${runId}/messages`, { text: "anyone?" });
  assertEquals(late.status, 409);
  assertEquals((await get(app.handler, `/v1/runs/${runId}/messages`, runToken)).status, 409);
  assertEquals((await post(app.handler, "/v1/runs/nope/messages", { text: "x" })).status, 404);
});

for (const provider of ["radicle", "github"] as const) {
  for (const linked of [false, true]) {
    test(`a submitted ${provider} notice names its change request ${linked ? "with" : "without"} a link`, async () => {
      const app = buildApp();
      const { runId, runToken, repo } = await liveRun(app);
      const born = await post(app.handler, `/v1/runs/${runId}/patches`, {
        branch: BRANCH(runId, repo.id, "a".repeat(40)),
        baseSha: "b".repeat(40),
      }, runToken);
      assertEquals(born.status, 201);
      const { patchId } = await born.json();
      const forgeRef = provider === "radicle" ? "c".repeat(40) : "42";
      const forgeUrl = linked ? `https://forge.example/patches/${forgeRef}` : null;
      const patch = {
        ...(await app.store.getPatch(patchId))!,
        line: "t-a",
        forgeRef,
        forgeUrl,
      };
      await notifyPatch(app.deps, patch, "submitted", null, undefined, { provider });
      const note = (await app.store.listRunMessages(runId)).at(-1)!;
      assert(note.text.includes(`Your patch for \`${patch.path}\` (line \`t-a\`)`));
      assert(note.text.includes(`is now an open change request \`${forgeRef}\``));
      assertEquals(note.text.includes("share the link"), linked);
      if (forgeUrl !== null) assert(note.text.includes(forgeUrl));
      else assert(note.text.includes("share the change request id"));
    });
  }
}

for (const state of ["submitted", "held"] as const) {
  for (const provider of ["github", "local"] as const) {
    test(`a ${provider} patch ${state} after finish keeps its notice without waking or changing activity`, async () => {
      const app = buildApp();
      const { runId, runToken, repo } = await liveRun(app);
      const sha = "a".repeat(40);
      const branch = BRANCH(runId, repo.id, sha);
      const born = await post(app.handler, `/v1/runs/${runId}/patches`, {
        branch,
        baseSha: "b".repeat(40),
      }, runToken);
      assertEquals(born.status, 201);
      const { patchId } = await born.json();
      const finished = await post(app.handler, `/v1/runs/${runId}/result`, {
        status: "success",
        branches: [branch],
        summary: "done",
      }, runToken);
      assertEquals(finished.status, 200);
      const run = await app.store.getRun(runId);
      assertEquals(run?.state, "succeeded");
      const events = await app.store.listEvents(runId);
      const response = await app.store.findResponseByRun(runId);
      const before = await app.store.listRunMessages(runId);
      const patch = {
        ...(await app.store.getPatch(patchId))!,
        forgeUrl: provider === "github" ? "https://github.com/acme/app/pull/42" : null,
        forgeRef: provider === "github" ? "42" : "ryph/delivered",
        hookCheck: {
          touched: [".husky/pre-commit"],
          hooksPaths: [".husky"],
          more: false,
          at: app.clock.now().toISOString(),
        },
      };
      let sideEffects = 0;
      const deps = {
        store: {
          ...app.store,
          markRunAttended: (...args: Parameters<typeof app.store.markRunAttended>) => {
            sideEffects++;
            return app.store.markRunAttended(...args);
          },
          markResponseActivity: (...args: Parameters<typeof app.store.markResponseActivity>) => {
            sideEffects++;
            return app.store.markResponseActivity(...args);
          },
        },
        diag: silentDiagnostics(),
        now: app.clock.now,
        inbox: {
          ...app.inbox,
          notify: () => {
            sideEffects++;
          },
        },
      };
      assertEquals(await notifyPatch(deps, patch, state, null, undefined, { provider }), "nobody");
      const notes = await app.store.listRunMessages(runId);
      assertEquals(notes.length, before.length + 1);
      const note = notes.at(-1)!;
      assertEquals(note.kind, "system");
      assertEquals(note.sender, { kind: "platform" });
      assertEquals(note.deliveredAt, null);
      assertEquals(note.attachments, []);
      assertEquals(note.payload, {
        kind: "patch",
        patchId,
        path: patch.path,
        line: patch.line,
        headSha: patch.headSha,
        generation: patch.generation,
        state,
        forgeUrl: patch.forgeUrl,
        reason: null,
        ...(state === "held" ? { hookPaths: [".husky/pre-commit"] } : {}),
      });
      assert(note.text.includes(patch.path));
      if (state === "held") {
        assert(note.text.includes(".husky/pre-commit"));
        assert(note.text.includes("approve"));
      } else if (provider === "github") {
        assert(note.text.includes(patch.forgeUrl!));
      } else {
        assert(note.text.includes("ryph/delivered"));
        assert(note.text.includes("There is no link to share"));
      }
      assertEquals(sideEffects, 0);
      assertEquals(await app.store.getRun(runId), run);
      assertEquals(await app.store.listEvents(runId), events);
      assertEquals(await app.store.findResponseByRun(runId), response);

      // Other terminal verdicts still do not enter the inbox.
      assertEquals(await notifyPatch(deps, patch, "merged"), "nobody");
      assertEquals((await app.store.listRunMessages(runId)).length, notes.length);

      const failingDeps = {
        ...deps,
        store: {
          ...deps.store,
          appendRunMessage: () => Promise.reject(new Error("store unavailable")),
        },
      };
      assertEquals(
        await notifyPatch(failingDeps, patch, state),
        state === "submitted" ? "failed" : "nobody",
      );
      assertEquals(sideEffects, 0);
    });
  }
}

test("a mid-run patch is born through the runner's patch route and adopted by the result", async () => {
  const app = buildApp();
  const { runId, runToken, repo } = await liveRun(app);
  const sha = "a".repeat(40);
  const born = await post(app.handler, `/v1/runs/${runId}/patches`, {
    branch: BRANCH(runId, repo.id, sha),
    baseSha: "b".repeat(40),
    title: "Bound the retry loop",
    description: "The cache client retried forever.",
  }, runToken);
  assertEquals(born.status, 201);
  const { patchId, state, url } = await born.json();
  assertEquals(state, "pending_approval");
  // No RYPH_APP_URL here: the answer names no page.
  assertEquals(url, null);
  const patch = (await app.store.getPatch(patchId))!;
  assertEquals(patch.runId, runId);
  assertEquals(patch.baseSha, "b".repeat(40));
  assertEquals(patch.generation, 1);
  assertEquals(patch.title, "Bound the retry loop");
  assertEquals(patch.commits, [{ sha, subject: "fix" }]);
  // Memory heard of the birth: a change per patch.
  assertEquals(app.memory.patches, [{ runId, patchId, forgeUrl: null }]);

  // The same head again adopts, and says so.
  const again = await post(app.handler, `/v1/runs/${runId}/patches`, {
    branch: BRANCH(runId, repo.id, sha),
    baseSha: "b".repeat(40),
  }, runToken);
  assertEquals(again.status, 200);
  assertEquals((await again.json()).patchId, patchId);

  // Approval reaches the run's inbox as a system message with the structured payload.
  await post(app.handler, `/v1/patches/${patchId}/approve`);
  const inbox = await app.store.listRunMessages(runId);
  assertEquals(
    inbox.map((m) => [m.kind, m.payload?.kind, (m.payload as PatchPayload | null)?.state]),
    [
      ["system", "patch", "approved"],
    ],
  );
  assertEquals(inbox[0].sender, { kind: "platform" });

  // Submitted: the pull request reaches memory (the upsert) and the inbox.
  await sweepPatches(
    {
      store: app.store,
      forge: app.forge,
      diag: silentDiagnostics(),
      memoryAccess: app.memory.memoryAccess,
      inbox: app.inbox,
      identityDirectory: app.identities.directory,
      now: app.clock.now,
      appUrl: "https://ryph.example",
    },
    DEFAULT_PATCH_SUBMIT_CONFIG,
  );
  const submitted = (await app.store.getPatch(patchId))!;
  assertEquals(submitted.state, "submitted");
  assertEquals(app.forge.submissions[0].title, "Bound the retry loop");
  const body = app.forge.submissions[0].body;
  assert(body.startsWith("<sub>Proposed by **"));
  assertStringIncludes(
    body,
    `[Run](https://ryph.example/tasks/${submitted.taskId}) · requested by **@noop-ada-lovelace**` +
      "</sub>\n\nThe cache client retried forever.",
  );
  assert(!body.includes("unreviewed agent output"));
  assertEquals(app.memory.patches.at(-1), { runId, patchId, forgeUrl: submitted.forgeUrl });
  const notes = await app.store.listRunMessages(runId);
  assertEquals((notes.at(-1)?.payload as PatchPayload | null)?.state, "submitted");
  assertEquals((notes.at(-1)?.payload as PatchPayload | null)?.forgeUrl, submitted.forgeUrl);

  // The result lists the same branch: adopted, not doubled; and then the run is over — no more
  // messages, and the patch's later verdicts are not posted to anyone.
  const reported = await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [BRANCH(runId, repo.id, sha)],
    summary: "done",
  }, runToken);
  assertEquals(reported.status, 200);
  assertEquals((await app.store.patchesForTask(patch.taskId)).length, 1);
  const forgeRef = submitted.forgeRef!;
  const merged = await post(app.handler, "/v1/forge/events", {
    deliveryId: "d-1",
    kind: "change_request.merged",
    repo: {
      provider: "github" as const,
      repoRef: REPO_LISTING.fullName,
      url: REPO_LISTING.url,
    },
    actorLogin: "grace",
    thread: { kind: "change_request", ref: forgeRef },
    body: null,
    sourceCommentId: null,
    merged: { heads: ["c".repeat(40)] },
    receivedAt: "2026-01-01T00:00:00.000Z",
  }, "forge-service-token");
  assertEquals((await merged.json()).outcome, "patch-settled");
  // The delivery records the merge; the submit sweep settles it.
  await sweepPatches(
    {
      store: app.store,
      forge: app.forge,
      diag: silentDiagnostics(),
      memoryAccess: app.memory.memoryAccess,
      inbox: app.inbox,
      identityDirectory: app.identities.directory,
      now: app.clock.now,
    },
    DEFAULT_PATCH_SUBMIT_CONFIG,
  );
  assertEquals(app.memory.changes, [{ runId, patchId, fate: "landed" }]);
  assertEquals((await app.store.listRunMessages(runId)).length, notes.length);
});

test("a merge while the run goes on tells the run, and a later generation opens its own pull request", async () => {
  const app = buildApp();
  const { runId, runToken, repo } = await liveRun(app);
  const submitterDeps = {
    store: app.store,
    forge: app.forge,
    diag: silentDiagnostics(),
    memoryAccess: app.memory.memoryAccess,
    inbox: app.inbox,
    identityDirectory: app.identities.directory,
    now: app.clock.now,
  };
  const submit = async (sha: string, generation: number) => {
    const res = await post(app.handler, `/v1/runs/${runId}/patches`, {
      branch: BRANCH(runId, repo.id, sha, generation),
      baseSha: "0".repeat(40),
    }, runToken);
    assertEquals(res.status, 201);
    const { patchId } = await res.json();
    await post(app.handler, `/v1/patches/${patchId}/approve`);
    await sweepPatches(submitterDeps, DEFAULT_PATCH_SUBMIT_CONFIG);
    return (await app.store.getPatch(patchId))!;
  };

  const first = await submit("a".repeat(40), 1);
  // A second patch of the SAME generation pushes onto the first's open pull request.
  app.clock.advance(1_000);
  const second = await submit("b".repeat(40), 1);
  assertEquals(second.forgeRef, first.forgeRef);
  assertEquals(app.forge.submissions.at(-1)?.changeRequest, first.forgeRef);
  assertEquals(app.forge.submissions.at(-1)?.baseBranch, first.branchName);
  // …and does not supersede it: both stand, submitted.
  assertEquals((await app.store.getPatch(first.id))!.state, "submitted");

  // The pull request merges: BOTH patches settle, each relays its fate, and the run hears it
  // — the cue that advances its generation.
  const merged = await post(app.handler, "/v1/forge/events", {
    deliveryId: "d-merge",
    kind: "change_request.merged",
    repo: {
      provider: "github" as const,
      repoRef: REPO_LISTING.fullName,
      url: REPO_LISTING.url,
    },
    actorLogin: "grace",
    thread: { kind: "change_request", ref: first.forgeRef },
    body: null,
    sourceCommentId: null,
    merged: { heads: ["c".repeat(40)] },
    receivedAt: "2026-01-01T00:00:00.000Z",
  }, "forge-service-token");
  assertEquals((await merged.json()).outcome, "patch-settled");
  // The delivery records the merge; the submit sweep settles it.
  await sweepPatches(submitterDeps, DEFAULT_PATCH_SUBMIT_CONFIG);
  assertEquals(app.memory.changes.map((c) => [c.patchId, c.fate]), [
    [first.id, "landed"],
    [second.id, "landed"],
  ]);
  // Told once, of the newest: the older head is inside it, and a cue for it is no news.
  const heard = (await app.store.listRunMessages(runId))
    .filter((m) => (m.payload as PatchPayload | null)?.state === "merged")
    .map((m) => (m.payload as PatchPayload | null)?.patchId);
  assertEquals(heard, [second.id]);

  // The next generation is a fresh pull request from the suffixed branch.
  app.clock.advance(1_000);
  const third = await submit("c".repeat(40), 2);
  assertEquals(third.branchName, `ryph/ada/${runId}/work-2`);
  assert(third.forgeRef !== first.forgeRef);
  assertEquals(app.forge.submissions.at(-1)?.changeRequest, undefined);
  assertEquals(app.forge.submissions.at(-1)?.baseBranch, "main");
});

/** A branch of any line of the run's namespace in the repo. */
const LINE_BRANCH = (
  runId: string,
  connectedRepoId: string,
  sha: string,
  line: string,
  generation = 1,
) => ({
  ...BRANCH(runId, connectedRepoId, sha, generation),
  name: generation === 1 ? `ryph/ada/${runId}/${line}` : `ryph/ada/${runId}/${line}-${generation}`,
  line,
});

test("two lines in one repo are two change requests: neither stacks on nor replaces the other, and a merge of one advances only it", async () => {
  const app = buildApp();
  const { taskId, runId, runToken, repo } = await liveRun(app);
  const submitterDeps = {
    store: app.store,
    forge: app.forge,
    diag: silentDiagnostics(),
    memoryAccess: app.memory.memoryAccess,
    inbox: app.inbox,
    identityDirectory: app.identities.directory,
    now: app.clock.now,
  };
  const submit = async (sha: string, line: string, generation = 1) => {
    app.clock.advance(1_000);
    const res = await post(app.handler, `/v1/runs/${runId}/patches`, {
      branch: LINE_BRANCH(runId, repo.id, sha, line, generation),
      baseSha: "0".repeat(40),
    }, runToken);
    assertEquals(res.status, 201, await res.clone().text());
    const { patchId } = await res.json();
    await post(app.handler, `/v1/patches/${patchId}/approve`);
    await sweepPatches(submitterDeps, DEFAULT_PATCH_SUBMIT_CONFIG);
    return (await app.store.getPatch(patchId))!;
  };

  const work = await submit("a".repeat(40), "work");
  const fix = await submit("b".repeat(40), "fix-a");
  assertEquals([work.line, fix.line], ["work", "fix-a"]);
  // Its own change request, from its own branch, against the base: never pushed onto the other's.
  assert(fix.forgeRef !== null && fix.forgeRef !== work.forgeRef);
  assertEquals(app.forge.submissions.at(-1)?.changeRequest, undefined);
  assertEquals(app.forge.submissions.at(-1)?.baseBranch, "main");
  assertEquals(fix.branchName, `ryph/ada/${runId}/fix-a`);
  // …and the default line's patch stands beside it, not superseded.
  assertEquals((await app.store.getPatch(work.id))!.state, "submitted");

  // A second patch of the default line stacks on ITS line's change request only.
  const work2 = await submit("c".repeat(40), "work");
  assertEquals(work2.forgeRef, work.forgeRef);
  assertEquals(app.forge.submissions.at(-1)?.baseBranch, work.branchName);

  // The fix's change request merges: the landing is the fix line's alone.
  const merged = await post(app.handler, "/v1/forge/events", {
    deliveryId: "d-merge-fix",
    kind: "change_request.merged",
    repo: {
      provider: "github" as const,
      repoRef: REPO_LISTING.fullName,
      url: REPO_LISTING.url,
    },
    actorLogin: "grace",
    thread: { kind: "change_request", ref: fix.forgeRef },
    body: null,
    sourceCommentId: null,
    merged: { heads: ["b".repeat(40)] },
    receivedAt: "2026-01-01T00:00:00.000Z",
  }, "forge-service-token");
  assertEquals((await merged.json()).outcome, "patch-settled");
  await sweepPatches(submitterDeps, DEFAULT_PATCH_SUBMIT_CONFIG);
  const task = (await app.store.getTask(taskId))!;
  assertEquals(Object.keys(task.landings.app ?? {}), [`${runId}/fix-a`]);
  assertEquals(task.landings.app?.[`${runId}/fix-a`]?.generation, 1);
  // The cue names its line, so the runner moves only that line on.
  const cues = (await app.store.listRunMessages(runId))
    .map((m) => m.payload as PatchPayload | null)
    .filter((p) => p?.kind === "patch" && p.state === "merged");
  assertEquals(cues.map((p) => [p?.patchId, p?.line]), [[fix.id, "fix-a"]]);
  // The default line's patches are untouched by it: still open, nothing held or replaced.
  for (const id of [work.id, work2.id]) {
    const p = (await app.store.getPatch(id))!;
    assertEquals([p.state, p.landed, p.heldReason], ["submitted", null, null]);
  }

  // The fix line's next generation opens a fresh change request; the default line's next patch
  // still goes onto its own open one.
  const fix2 = await submit("d".repeat(40), "fix-a", 2);
  assertEquals(fix2.branchName, `ryph/ada/${runId}/fix-a-2`);
  assert(fix2.forgeRef !== fix.forgeRef && fix2.forgeRef !== work.forgeRef);
  const work3 = await submit("e".repeat(40), "work");
  assertEquals(work3.forgeRef, work.forgeRef);
});

test("a later run of the task never supersedes or adopts an earlier run's line of the same name", async () => {
  const app = buildApp();
  const { taskId, runId, runToken, repo } = await liveRun(app);
  const submit = async (sha: string, line: string) => {
    app.clock.advance(1_000);
    const res = await post(app.handler, `/v1/runs/${runId}/patches`, {
      branch: LINE_BRANCH(runId, repo.id, sha, line),
      baseSha: "0".repeat(40),
    }, runToken);
    assertEquals(res.status, 201, await res.clone().text());
    return (await app.store.getPatch((await res.json()).patchId))!;
  };
  // R1 ships `fix-a` and `work`, both waiting for a person.
  const fix1 = await submit("a".repeat(40), "fix-a");
  const work1 = await submit("b".repeat(40), "work");
  assertEquals([fix1.state, work1.state], ["pending_approval", "pending_approval"]);

  // A second run on the same task (as a resume would start), with a namespace of its own.
  const r1 = (await app.store.getRun(runId))!;
  const r2: Run = { ...r1, id: "r-second", branchNamespace: "ryph/ada/r-second" };
  await app.store.saveRun(r2);
  const task = (await app.store.getTask(taskId))!;
  const open = (sha: string, line: string) =>
    openPatchForRun(
      { store: app.store, diag: silentDiagnostics(), now: app.clock.now },
      r2,
      task,
      {
        branch: LINE_BRANCH(r2.id, repo.id, sha, line),
        baseSha: null,
        title: null,
        description: null,
      },
      "ps-second",
      false,
      app.clock.now().toISOString(),
    );
  // R2's own `fix-a`, generation 1: unrelated work that shares the word. R1's stays waiting.
  const fix2 = await open("c".repeat(40), "fix-a");
  assert(fix2.kind === "opened");
  assertEquals((await app.store.getPatch(fix1.id))!.state, "pending_approval");
  // R2's `fix-a` at the very head R1's `fix-a` shipped is still R2's own patch, not R1's row.
  const same = await open("a".repeat(40), "fix-a");
  assert(same.kind === "opened" && same.patch.runId === r2.id);
  assertEquals((await app.store.getPatch(fix1.id))!.state, "pending_approval");
  // The default line is the task's, as ever: R2's `work` replaces R1's waiting one.
  const work2 = await open("d".repeat(40), "work");
  assert(work2.kind === "opened");
  assertEquals((await app.store.getPatch(work1.id))!.state, "superseded");
});

test("patch intake holds the line to its branch's name, and a run to eight lines per repo", async () => {
  const app = buildApp();
  const { runId, runToken, repo } = await liveRun(app);
  const send = (branch: unknown) =>
    post(app.handler, `/v1/runs/${runId}/patches`, { branch, baseSha: "0".repeat(40) }, runToken);
  const refused = async (branch: unknown, says: string) => {
    const res = await send(branch);
    assertEquals(res.status, 400);
    const why = (await res.json()).error as string;
    assert(why.includes(says), why);
  };
  const sha = (n: number) => n.toString(16).padStart(40, "0");
  // A line its name does not spell, a name outside the run's namespace, a bad line name.
  await refused({ ...LINE_BRANCH(runId, repo.id, sha(1), "fix-a"), line: "work" }, "line");
  await refused(
    { ...LINE_BRANCH(runId, repo.id, sha(2), "work"), name: "ryph/ada/r-other/work" },
    "line",
  );
  await refused({ ...LINE_BRANCH(runId, repo.id, sha(3), "work"), line: "Bad" }, "line");
  // Eight lines go in; a ninth is refused, while a line the run already has never is.
  for (let i = 0; i < 8; i++) {
    const res = await send(LINE_BRANCH(runId, repo.id, sha(10 + i), `line-${"abcdefgh"[i]}`));
    assertEquals(res.status, 201, await res.clone().text());
  }
  await refused(LINE_BRANCH(runId, repo.id, sha(30), "line-z"), "lines");
  assertEquals((await send(LINE_BRANCH(runId, repo.id, sha(31), "line-a"))).status, 201);
});

test("a rejected patch tells the run why; a superseded one says so", async () => {
  const app = buildApp();
  const { runId, runToken, repo } = await liveRun(app);
  const first = await (await post(app.handler, `/v1/runs/${runId}/patches`, {
    branch: BRANCH(runId, repo.id, "a".repeat(40)),
    baseSha: "0".repeat(40),
  }, runToken)).json();
  // A newer patch of the same generation supersedes the waiting one.
  const second = await (await post(app.handler, `/v1/runs/${runId}/patches`, {
    branch: BRANCH(runId, repo.id, "b".repeat(40)),
    baseSha: "0".repeat(40),
  }, runToken)).json();
  assertEquals((await app.store.getPatch(first.patchId))!.state, "superseded");
  await post(app.handler, `/v1/patches/${second.patchId}/reject`);
  const notes = (await app.store.listRunMessages(runId)).map((m) => [
    (m.payload as PatchPayload | null)?.patchId,
    (m.payload as PatchPayload | null)?.state,
    (m.payload as PatchPayload | null)?.reason,
  ]);
  assertEquals(notes, [
    [first.patchId, "superseded", null],
    [second.patchId, "rejected", "rejected by u-1"],
  ]);
  assertEquals(app.memory.changes.map((c) => [c.patchId, c.fate]), [
    [first.patchId, "dropped"],
    [second.patchId, "dropped"],
  ]);
});

test("a merged cue leaves the rebase to the runner's note, and names no branch it does not know", async () => {
  const app = buildApp();
  const { runId, runToken, repo } = await liveRun(app);
  const born = await (await post(app.handler, `/v1/runs/${runId}/patches`, {
    branch: BRANCH(runId, repo.id, "a".repeat(40)),
    baseSha: "0".repeat(40),
  }, runToken)).json();
  const patch = (await app.store.getPatch(born.patchId))!;
  const deps = {
    store: app.store,
    diag: silentDiagnostics(),
    now: app.clock.now,
    inbox: app.inbox,
  };
  assertEquals(await notifyPatch(deps, patch, "merged"), "posted");
  const unnamed = (await app.store.listRunMessages(runId)).at(-1)!.text;
  assertStringIncludes(
    unnamed,
    "onto the branch it merged into: ryph adds a note naming that branch and the exact command; " +
      "if there is none, call ryph__update_from_base",
  );
  assert(!unnamed.includes("git rebase"), unnamed);
  assert(!unnamed.includes("origin/<"), unnamed);
  assertEquals(await notifyPatch(deps, patch, "merged", null, "main"), "posted");
  const named = (await app.store.listRunMessages(runId)).at(-1)!.text;
  assertStringIncludes(
    named,
    "onto `origin/main`: ryph adds a note with the exact command; if there is none, call " +
      "ryph__update_from_base",
  );
  assert(!named.includes("git rebase"), named);
});

test("the heartbeat carries the idle clock, and the reaper escalates a lapsed one to a cancel", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  const deadline = new Date(app.clock.now().getTime() + 60_000).toISOString();
  await post(app.handler, `/v1/runs/${runId}/heartbeat`, {
    seq: 1,
    phase: "running",
    idleDeadlineAt: deadline,
    // Dropped: where the run's cancel goes is its provisioner's to say, never the run's.
    cancelUrl: "http://169.254.169.254/computeMetadata/v1/",
  }, runToken);
  const run = (await app.store.getRun(runId))!;
  assertEquals(run.idleDeadlineAt, deadline);

  // Within the grace: nothing. Past it: a cancel, recorded as idle-expired. The run keeps
  // beating throughout — a silent one is the liveness arm's, not this one's.
  const beating = (atMs: number): Run => ({
    ...run,
    lastHeartbeatAt: new Date(atMs).toISOString(),
  });
  const within = Date.parse(deadline) + 30_000;
  assertEquals(planSweep(beating(within), within, CFG).kind, "none");
  const past = Date.parse(deadline) + 61_000;
  const action = planSweep(beating(past), past, CFG);
  assert(action.kind === "idle-expired");
  assertEquals(action.run.desiredState, "cancelled");
  assertEquals(action.events.map((e) => e.kind), ["idle-expired", "cancel-requested"]);
  // A run already cancelled is the cancel arm's business, not this one's.
  assertEquals(
    planSweep(
      { ...beating(past), desiredState: "cancelled", cancelRequestedAt: deadline },
      past,
      CFG,
    ).kind,
    "none",
  );

  // The sweep pushes the cancel to the run, and the next beat carries it.
  app.clock.advance(60_000 + 61_000);
  await post(app.handler, `/v1/runs/${runId}/heartbeat`, {
    seq: 2,
    phase: "running",
    idleDeadlineAt: deadline,
  }, runToken);
  await sweep({
    store: app.store,
    provisioner: fakeProvisioner().provisioner,
    runnerControl: app.deps.runnerControl,
    diag: silentDiagnostics(),
    now: app.clock.now,
  }, CFG);
  assertEquals(app.cancels.map((c) => c.id), [runId]);
  assertEquals(Object.keys(app.cancels[0]).sort(), ["controlToken", "handle", "id"]);
  const beat = await post(app.handler, `/v1/runs/${runId}/heartbeat`, {
    seq: 3,
    phase: "running",
    idleDeadlineAt: null,
  }, runToken);
  assertEquals(await beat.json(), { cancel: true });
  const events = (await app.store.listEvents(runId)).map((e) => e.kind);
  assert(events.includes("idle-expired") && events.includes("cancel-pushed"));
  // A beat that names no clock clears the gauge.
  assertEquals((await app.store.getRun(runId))!.idleDeadlineAt, null);
});

test("the idle deadline is an instant, and the run's own lifetime is its ceiling", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);

  // Not a datetime: refused at the door. Stored verbatim it made planSweep's `Date.parse` NaN,
  // so every idle comparison was false — the backstop was simply OFF, while the run kept its
  // live model key, MCP virtual token and git virtual key for as long as it liked.
  assertEquals(
    (await post(app.handler, `/v1/runs/${runId}/heartbeat`, {
      seq: 1,
      phase: "running",
      idleDeadlineAt: "soon",
    }, runToken)).status,
    400,
  );
  assertEquals((await app.store.getRun(runId))!.idleDeadlineAt, null);

  // Further out than the frozen lifetime allows: clamped to the ceiling, not taken. The runner
  // keeps the clock; it does not get to name how long its credentials live.
  const far = new Date(app.clock.now().getTime() + 48 * 60 * 60_000).toISOString();
  await post(app.handler, `/v1/runs/${runId}/heartbeat`, {
    seq: 1,
    phase: "running",
    idleDeadlineAt: far,
  }, runToken);
  // A run-page run: the attended clock is its ceiling, as its agent leaves the end to the person.
  const stored = (await app.store.getRun(runId))!;
  assertEquals(stored.workItem.interactive, true);
  const ceiling = new Date(app.clock.now().getTime() + stored.workItem.lifetime.attendedIdleMs)
    .toISOString();
  assertEquals(stored.idleDeadlineAt, ceiling);

  // Nearer than the ceiling: the runner's own clock stands — it may always bring it forward.
  const near = new Date(app.clock.now().getTime() + 60_000).toISOString();
  await post(app.handler, `/v1/runs/${runId}/heartbeat`, {
    seq: 2,
    phase: "running",
    idleDeadlineAt: near,
  }, runToken);
  assertEquals((await app.store.getRun(runId))!.idleDeadlineAt, near);
});

test("a task that names no clocks gets the default ones, frozen everywhere", async () => {
  const app = buildApp();
  const { taskId, runId, runToken } = await liveRun(app, "none");
  const defaults = { idleMs: DEFAULT_IDLE_MS, attendedIdleMs: DEFAULT_ATTENDED_IDLE_MS };
  assertEquals((await app.store.getTask(taskId))!.lifetime, defaults);
  const spec = await (await get(app.handler, `/v1/runs/${runId}/spec`, runToken)).json();
  assertEquals(spec.workItem.lifetime, defaults);
  const short = await post(app.handler, "/v1/tasks", {
    agentId: "a",
    spec: { title: "t", instructions: "i" },
    connectedRepoId: "cr-x",
    lifetime: { idleMs: 5, attendedIdleMs: 5 },
  });
  assertEquals(short.status, 400, "an idle clock under a minute is refused");
});

test("a person finishes a run once its agent said it was done: a finish cue in its inbox", async () => {
  const app = buildApp();
  const { taskId, runId, runToken } = await liveRun(app);
  const finish = () => post(app.handler, `/v1/tasks/${taskId}/finish`);
  const beat = (seq: number, declaredOutcome?: string) =>
    post(app.handler, `/v1/runs/${runId}/heartbeat`, {
      seq,
      phase: "running",
      ...(declaredOutcome === undefined ? {} : { declaredOutcome }),
    }, runToken);

  // The agent has said nothing yet, then that it failed: neither is a run to finish.
  const early = await finish();
  assertEquals(early.status, 409);
  assertEquals((await early.json()).error, "The agent hasn't said it's done yet");
  await beat(1, "failed");
  assertEquals((await finish()).status, 409);

  // Done, then a beat that says nothing more: the outcome stands, and the page reads it.
  await beat(2, "no-changes");
  await beat(3);
  const detail = await (await get(app.handler, `/v1/tasks/${taskId}`)).json();
  assertEquals(detail.runs[0].declaredOutcome, "no-changes");

  const finished = await finish();
  assertEquals(finished.status, 202);
  assertEquals(await finished.json(), { runId });
  // The runner pulls it as a system message from the person, carrying the cue.
  const pulled = await (await get(app.handler, `/v1/runs/${runId}/messages?after=-1`, runToken))
    .json();
  assertEquals(pulled.messages.map((m: RunMessage) => [m.kind, m.sender, m.payload]), [
    ["system", { kind: "user", userId: "u-1" }, { kind: "finish" }],
  ]);
  // On the trail, naming nobody: who asked is the message's sender, resolved when it is read.
  const events = await app.store.listEvents(runId);
  assertEquals(events.filter((e) => e.kind === "finish-requested").map((e) => e.detail), [
    undefined,
  ]);
  // A finish is no cancel, and no person speaking: the run is neither asked to stop nor attended.
  const run = (await app.store.getRun(runId))!;
  assertEquals(run.desiredState, null);
  assertEquals(run.attended, false);

  // Said once: a second finish answers the same and posts nothing, even once the run it ended
  // is finalizing.
  assertEquals((await finish()).status, 202);
  await post(app.handler, `/v1/runs/${runId}/heartbeat`, { seq: 4, phase: "finalizing" }, runToken);
  assertEquals((await finish()).status, 202);
  assertEquals((await app.store.listRunMessages(runId)).length, 1);
});

test("a finish is refused once a message reached the agent since it said it was done", async () => {
  const app = buildApp();
  const { taskId, runId, runToken } = await liveRun(app);
  const finish = () => post(app.handler, `/v1/tasks/${taskId}/finish`);
  const beat = (seq: number, declaredOutcome?: string | null) =>
    post(app.handler, `/v1/runs/${runId}/heartbeat`, {
      seq,
      phase: "running",
      ...(declaredOutcome === undefined ? {} : { declaredOutcome }),
    }, runToken);
  await beat(1, "success");
  // Someone asked for more: the runner clears the outcome, and the page reads that it did.
  assertEquals((await beat(2, null)).status, 200);
  const detail = await (await get(app.handler, `/v1/tasks/${taskId}`)).json();
  assertEquals(detail.runs[0].declaredOutcome, null);
  const refused = await finish();
  assertEquals(refused.status, 409);
  assertEquals((await refused.json()).error, "The agent hasn't said it's done yet");
  // The agent says so again: finish is back.
  await beat(3, "success");
  assertEquals((await finish()).status, 202);
});

test("a finish is refused while the agent says its work is still in progress", async () => {
  const app = buildApp();
  const { taskId, runId, runToken } = await liveRun(app);
  const finish = () => post(app.handler, `/v1/tasks/${taskId}/finish`);
  const beat = (seq: number, declaredOutcome: string) =>
    post(app.handler, `/v1/runs/${runId}/heartbeat`, {
      seq,
      phase: "running",
      declaredOutcome,
    }, runToken);
  // Waiting on a check, say: the beat is taken, and the page reads the outcome.
  assertEquals((await beat(1, "in-progress")).status, 200);
  assertEquals((await app.store.getRun(runId))?.declaredOutcome, "in-progress");
  const detail = await (await get(app.handler, `/v1/tasks/${taskId}`)).json();
  assertEquals(detail.runs[0].declaredOutcome, "in-progress");
  const refused = await finish();
  assertEquals(refused.status, 409);
  assertEquals((await refused.json()).error, "The agent hasn't said it's done yet");
  assertEquals(
    (await app.store.listRunMessages(runId)).filter((m) => m.payload?.kind === "finish"),
    [],
  );
  // A beat with an outcome the orchestrator does not know is refused whole.
  assertEquals((await beat(2, "partial")).status, 400);
  // Done now: finish is offered.
  await beat(3, "success");
  assertEquals((await finish()).status, 202);
});

test("a finish is refused once the agent finished by itself, or the run is finalizing", async () => {
  const app = buildApp();
  const { taskId, runId, runToken } = await liveRun(app);
  const finish = () => post(app.handler, `/v1/tasks/${taskId}/finish`);
  await post(app.handler, `/v1/runs/${runId}/heartbeat`, {
    seq: 1,
    phase: "running",
    declaredOutcome: "success",
    finished: true,
  }, runToken);
  // Its own finish may be held for a check verdict a long while; the page reads that it is.
  const detail = await (await get(app.handler, `/v1/tasks/${taskId}`)).json();
  assertEquals(detail.runs[0].agentFinished, true);
  const events = await app.store.listEvents(runId);
  assertEquals(events.filter((e) => e.kind === "finished").map((e) => e.detail), ["success"]);
  const finished = await finish();
  assertEquals(finished.status, 409);
  assertEquals((await finished.json()).error, "This run is already finishing");

  const otherApp = buildApp();
  const other = await liveRun(otherApp);
  await post(otherApp.handler, `/v1/runs/${other.runId}/heartbeat`, {
    seq: 1,
    phase: "finalizing",
    declaredOutcome: "success",
  }, other.runToken);
  const finalizing = await post(otherApp.handler, `/v1/tasks/${other.taskId}/finish`);
  assertEquals(finalizing.status, 409);
  assertEquals((await finalizing.json()).error, "This run is already finishing");
  assertEquals(
    (await app.store.listRunMessages(runId)).filter((m) => m.payload?.kind === "finish"),
    [],
  );
});

test("a finish is refused for a run being cancelled, and for one that has ended", async () => {
  const app = buildApp();
  const { taskId, runId, runToken } = await liveRun(app);
  await post(app.handler, `/v1/runs/${runId}/heartbeat`, {
    seq: 1,
    phase: "running",
    declaredOutcome: "success",
  }, runToken);
  await post(app.handler, `/v1/tasks/${taskId}/cancel`);
  const cancelling = await post(app.handler, `/v1/tasks/${taskId}/finish`);
  assertEquals(cancelling.status, 409);
  assertEquals((await cancelling.json()).error, "This run is being cancelled");

  await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "cancelled",
    branches: [],
    summary: "stopped",
  }, runToken);
  const ended = await post(app.handler, `/v1/tasks/${taskId}/finish`);
  assertEquals(ended.status, 409);
  assertEquals((await ended.json()).error, "This run has already ended");
  assertEquals(
    (await app.store.listRunMessages(runId)).filter((m) => m.payload?.kind === "finish"),
    [],
  );
});

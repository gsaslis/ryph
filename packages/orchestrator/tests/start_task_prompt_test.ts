import { test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// Starting a task without its instructions, end to end through the
// pure handler: the task is created awaiting its prompt and its run launched as usual; the first
// message — even one sent while the run is still starting — becomes the task's instructions, once,
// however many race for it; and a task nobody titled is titled with its first line at once and by
// the background model when it answers, never over a title somebody gave.

import { capsClaimOf } from "@ryph/auth";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import { makeInboxSignal } from "../src/core/inbox_signal.ts";
import { postMessage } from "../src/core/inbox.ts";
import { postUserMessage } from "../src/core/prompt.ts";
import { clampIdleDeadline, planSweep, type SweepConfig } from "../src/core/lifecycle.ts";
import {
  extractReferences,
  fallbackTitle,
  isMetaTitle,
  sanitizeTitle,
  titleTask,
} from "../src/core/titles.ts";
import { publishTaskChanges } from "../src/publish_task_changes.ts";
import type { PlatformCompletion, PlatformModel } from "../src/ports/platform_model.ts";
import type { TaskFeed } from "../src/ports/task_feed.ts";
import type { AttachmentStore } from "../src/ports/attachment_store.ts";
import type { RunMessage } from "../src/core/types.ts";
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
  MAX_RUNNER_BODIES_IN_FLIGHT,
  MAX_RUNNER_HEARTBEAT_BYTES,
  MAX_RUNNER_PATCH_BYTES,
  MAX_RUNNER_RESULT_BYTES,
} from "../src/http/runner_api.ts";

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

/** A background model that answers `answer` (or throws it), recording every ask. */
function fakeModel(answer: string | Error | "hang") {
  const asked: PlatformCompletion[] = [];
  const model: PlatformModel = {
    complete(req) {
      asked.push(req);
      if (answer === "hang") return new Promise(() => {});
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  return { model, asked };
}

/** An attachment store over a map. */
function memoryBlobs(): AttachmentStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    put(key, bytes) {
      blobs.set(key, bytes.slice());
      return Promise.resolve();
    },
    get(key) {
      const bytes = blobs.get(key);
      return Promise.resolve(bytes === undefined ? null : new Response(bytes as BodyInit).body);
    },
    delete(key) {
      blobs.delete(key);
      return Promise.resolve();
    },
  };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function buildApp(platformModel: PlatformModel | null = null) {
  const published: string[] = [];
  const feed: TaskFeed = {
    publish: (taskId) => published.push(taskId),
    subscribe: () => () => {},
  };
  // Wrapped as the composition roots wrap it, so the live tail's announcements are observable.
  const store = publishTaskChanges(memoryTaskStore(), feed);
  const clock = fakeClock();
  const { provisioner, launches } = fakeProvisioner();
  const identities = fakeIdentityDirectory();
  const forge = noopForge(silentDiagnostics(), { permission: "allowed", repos: [REPO_LISTING] });
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
    inbox: makeInboxSignal(),
    platformModel,
    attachmentStore: memoryBlobs(),
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
      platformTools: { webServerId: "ms-platform-web", web: false, forge: null, pending: false },
    },
  };
  return { handler: makeHandler(deps), deps, store, clock, identities, launches, published };
}

type App = ReturnType<typeof buildApp>;
type Handler = (req: Request) => Promise<Response>;
const post = (handler: Handler, path: string, body: unknown = {}, token = "t") =>
  handler(
    new Request(`http://orchestrator.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
const get = (handler: Handler, path: string, token = "t") =>
  handler(
    new Request(`http://orchestrator.test${path}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );

/** Link, install, connect, mint an agent: everything a task needs but the task. */
async function setUp(app: App) {
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
  return { repo, agent };
}

async function startTask(app: App, spec: Record<string, string> | undefined) {
  const { repo, agent } = await setUp(app);
  const created = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    ...(spec === undefined ? {} : { spec }),
    connectedRepoId: repo.id,
  });
  assertEquals(created.status, 201, await created.clone().text());
  const { taskId, runId } = await created.json();
  return {
    taskId,
    runId,
    runToken: (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN,
    agent,
    repo,
  };
}

/** The title once the background work has had its turn, or what it is after `ms`. */
async function titleSettles(app: App, taskId: string, from: string | null, ms = 1_000) {
  const until = Date.now() + ms;
  for (;;) {
    const title = (await app.store.getTask(taskId))!.spec.title;
    if (title !== from || Date.now() > until) return title;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("runner bodies: byte caps precede business writes, follow auth and name the run in diagnostics", async () => {
  const app = buildApp();
  const { runId, runToken } = await startTask(app, {});
  const before = await app.store.getRun(runId);
  const events = await app.store.listEvents(runId);
  const published = app.published.length;
  const warnings: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  app.deps.diag.warn = (event, fields) => void warnings.push({ event, fields });
  // Any write or business operation is a failure, even if a route later answers 413.
  const unexpected = () => {
    throw new Error("oversized body reached business logic");
  };
  const saveHeartbeat = app.store.saveHeartbeat;
  app.store.saveHeartbeat = unexpected;
  app.store.saveRun = unexpected;
  app.store.savePatch = unexpected;
  app.store.appendEvent = unexpected;
  app.deps.forge.submitPatch = unexpected;
  for (
    const [path, cap] of [
      ["heartbeat", MAX_RUNNER_HEARTBEAT_BYTES],
      ["result", MAX_RUNNER_RESULT_BYTES],
      ["patches", MAX_RUNNER_PATCH_BYTES],
    ] as const
  ) {
    for (const length of [undefined, "1"]) {
      const bytes = new TextEncoder().encode("{}" + " ".repeat(cap - 1));
      const response = await app.handler(
        new Request(`http://orchestrator.test/v1/runs/${runId}/${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${runToken}`,
            ...(length === undefined ? {} : { "content-length": length }),
          },
          body: new ReadableStream({
            start(c) {
              c.enqueue(bytes);
              c.close();
            },
          }),
        }),
      );
      assertEquals(response.status, 413);
      assertEquals(await response.json(), { error: `body exceeds ${cap} bytes` });
      assertEquals(warnings.at(-1), {
        event: "run.body_too_large",
        fields: { runId, path: `/v1/runs/${runId}/${path}`, maxBytes: cap },
      });
    }
  }
  assertEquals(await app.store.getRun(runId), before);
  assertEquals(await app.store.listEvents(runId), events);
  assertEquals(app.published.length, published);
  let read = false;
  const unauthorized = await app.handler(
    new Request(`http://orchestrator.test/v1/runs/${runId}/heartbeat`, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong",
        "content-length": String(MAX_RUNNER_HEARTBEAT_BYTES + 1),
      },
      body: new ReadableStream({
        pull(c) {
          read = true;
          c.error(new Error("must not read"));
        },
      }, { highWaterMark: 0 }),
    }),
  );
  assertEquals(unauthorized.status, 401);
  assertEquals(read, false);
  assertEquals(warnings.length, 6);
  // A valid heartbeat right at the cap still reaches the normal lifecycle path.
  app.store.saveHeartbeat = saveHeartbeat;
  app.store.appendEvent = () => Promise.resolve();
  const beat = JSON.stringify({ seq: 0, phase: "running", message: "\u0000".repeat(100_000) });
  const exact = await app.handler(
    new Request(`http://orchestrator.test/v1/runs/${runId}/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${runToken}`, "content-type": "application/json" },
      body: beat.padEnd(MAX_RUNNER_HEARTBEAT_BYTES),
    }),
  );
  assertEquals(exact.status, 200);
  assertEquals((await app.store.getRun(runId))!.heartbeatSeq, 0);
});

/** A runner body that streams `head` and then holds the request open until `finish` is called;
 * `pulled` says whether anything read past the head. */
function heldBody(head: string) {
  let finish: (rest?: string) => void = () => {};
  let pulled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      if (head !== "") c.enqueue(new TextEncoder().encode(head));
      finish = (rest = "") => {
        try {
          if (rest !== "") c.enqueue(new TextEncoder().encode(rest));
          c.close();
        } catch {
          // Already cancelled by the route.
        }
      };
    },
    pull() {
      pulled = true;
    },
  }, { highWaterMark: 0 });
  return { body, finish: (rest?: string) => finish(rest), pulled: () => pulled };
}

const runnerPost = (app: App, runId: string, token: string, path: string, body: BodyInit) =>
  app.handler(
    new Request(`http://orchestrator.test/v1/runs/${runId}/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit),
  );

test("a run's bodies in flight are bounded: by count and by the bytes their caps reserve", async () => {
  const app = buildApp();
  const { runId, runToken, agent, repo } = await startTask(app, {});
  const second = await (await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    connectedRepoId: repo.id,
  })).json();
  const other = {
    runId: second.runId as string,
    runToken: (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN,
  };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  // Heartbeats that never finish arriving fill the run's slots.
  const held = Array.from({ length: MAX_RUNNER_BODIES_IN_FLIGHT }, () => heldBody("{"));
  const pending = held.map((h) => runnerPost(app, runId, runToken, "heartbeat", h.body));
  await tick();
  const busy = heldBody('{"seq":0,"phase":"running"}');
  const refused = await runnerPost(app, runId, runToken, "heartbeat", busy.body);
  assertEquals(refused.status, 429);
  assertEquals(busy.pulled(), false, "a refused body is never read");
  // Another run is not held up by this one's.
  const elsewhere = await runnerPost(
    app,
    other.runId,
    other.runToken,
    "heartbeat",
    JSON.stringify({ seq: 0, phase: "running" }),
  );
  assertEquals(elsewhere.status, 200);
  // The slots come back as the bodies finish.
  for (const h of held) h.finish('"seq":0,"phase":"running"}');
  for (const res of await Promise.all(pending)) await res.body?.cancel();
  const after = await runnerPost(
    app,
    runId,
    runToken,
    "heartbeat",
    JSON.stringify({ seq: 1, phase: "running" }),
  );
  assertEquals(after.status, 200);

  // Three results' worth of cap is the run's whole byte budget: a fourth body of any size waits.
  const results = Array.from({ length: 3 }, () => heldBody("{"));
  const resultsPending = results.map((h) => runnerPost(app, runId, runToken, "result", h.body));
  await tick();
  assert(3 * MAX_RUNNER_RESULT_BYTES <= 24 * 1024 * 1024);
  const small = await runnerPost(
    app,
    runId,
    runToken,
    "heartbeat",
    JSON.stringify({ seq: 2, phase: "running" }),
  );
  assertEquals(small.status, 429);
  for (const h of results) h.finish("}");
  for (const res of await Promise.all(resultsPending)) await res.body?.cancel();
});

test("a runner body still arriving at its deadline is cut off with a 408", async () => {
  const app = buildApp();
  const handler = makeHandler({ ...app.deps, runnerBodyDeadlineMs: 50 });
  const { runId, runToken } = await startTask(app, {});
  const before = (await app.store.getRun(runId))!.heartbeatSeq;
  const drip = heldBody('{"seq":0,');
  const started = performance.now();
  const res = await handler(
    new Request(`http://orchestrator.test/v1/runs/${runId}/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${runToken}` },
      body: drip.body,
      duplex: "half",
    } as RequestInit),
  );
  assertEquals(res.status, 408);
  assert(performance.now() - started < 2_000);
  assertEquals((await app.store.getRun(runId))!.heartbeatSeq, before);
});

test("stale-memory and setup reports refuse a terminal or already-reported run before reading", async () => {
  const app = buildApp();
  const { runId, runToken } = await startTask(app, {});
  const path = (await app.store.getRun(runId))!.workItem.repos[0].path;
  const failures = { failures: [{ kind: "invalid", path, error: "bad yaml" }] };
  const first = await runnerPost(app, runId, runToken, "setup/failed", JSON.stringify(failures));
  assertEquals(first.status, 204);
  // A second setup report: refused on the event already recorded, its body never read.
  const again = heldBody("{");
  const twice = await runnerPost(app, runId, runToken, "setup/failed", again.body);
  assertEquals(twice.status, 409);
  assertEquals(again.pulled(), false);

  const ended = await runnerPost(
    app,
    runId,
    runToken,
    "result",
    JSON.stringify({ status: "error", reason: "boom", during: "running", branches: [] }),
  );
  assertEquals(ended.status, 200);
  for (const path of ["memory/stale", "setup/failed", "base/stale", "patches"]) {
    const late = heldBody("{");
    const res = await runnerPost(app, runId, runToken, path, late.body);
    assertEquals(res.status, 409, path);
    assertEquals(late.pulled(), false, `${path} read a terminal run's body`);
  }
});

test("a task without instructions is created awaiting its prompt, its run launched as usual", async () => {
  const app = buildApp();
  const { taskId, runId, runToken } = await startTask(app, undefined);

  const detail = await (await get(app.handler, `/v1/tasks/${taskId}`)).json();
  assertEquals(detail.task.awaitingPrompt, true);
  assertEquals(detail.task.spec, { title: null, instructions: null });
  assertEquals(detail.runs[0].state, "starting");
  assertEquals(app.launches.length, 1);

  // The list row and its live tail say the same, from the same describer.
  const listed = await (await get(app.handler, `/v1/tasks?ids=${taskId}`)).json();
  assertEquals(listed.tasks[0].awaitingPrompt, true);
  assertEquals(listed.tasks[0].title, null);

  // The runner is handed a work item with neither half of its spec.
  const spec = await (await get(app.handler, `/v1/runs/${runId}/spec`, runToken)).json();
  assertEquals(spec.workItem.spec, { title: null, instructions: null });
});

test("a title without instructions is refused; a re-run of an unprompted task waits again", async () => {
  const app = buildApp();
  const { repo, agent } = await setUp(app);
  const titled = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Just a title" },
    connectedRepoId: repo.id,
  });
  assertEquals(titled.status, 400);
  const first = await (await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    connectedRepoId: repo.id,
  })).json();
  const rerun = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: {},
    rerunOf: first.taskId,
    connectedRepoId: repo.id,
  });
  assertEquals(rerun.status, 201);
  const { taskId } = await rerun.json();
  assertEquals((await app.store.getTask(taskId))!.spec, { title: null, instructions: null });
});

test("the first message — sent while the run is still starting — becomes the task", async () => {
  const app = buildApp();
  const { taskId, runId, runToken } = await startTask(app, {});
  assertEquals((await app.store.getRun(runId))!.state, "starting");
  app.published.length = 0;

  const posted = await post(app.handler, `/v1/runs/${runId}/messages`, {
    text: "Fix the flaky login test\nIt times out on CI.",
  });
  assertEquals(posted.status, 201);
  const { message } = await posted.json() as { message: RunMessage };
  assertEquals(message.seq, 0);

  const task = (await app.store.getTask(taskId))!;
  assertEquals(task.spec, {
    title: "Fix the flaky login test",
    instructions: "Fix the flaky login test\nIt times out on CI.",
  });
  const detail = await (await get(app.handler, `/v1/tasks/${taskId}`)).json();
  assertEquals(detail.task.awaitingPrompt, false);
  // The prompt is the task, not a person joining it.
  assertEquals((await app.store.getRun(runId))!.attended, false);
  // The live tail heard the row move.
  assert(app.published.includes(taskId));
  // Held for the runner: it reads it the moment it asks, once booted.
  const pulled = await (await get(app.handler, `/v1/runs/${runId}/messages?after=-1`, runToken))
    .json();
  assertEquals(pulled.messages.map((m: RunMessage) => m.seq), [0]);
  // The work item says what the run was asked, for the spec read and for a re-run.
  const spec = await (await get(app.handler, `/v1/runs/${runId}/spec`, runToken)).json();
  assertEquals(spec.workItem.spec, task.spec);

  // Later messages are ordinary messages.
  const second = await post(app.handler, `/v1/runs/${runId}/messages`, { text: "and signup" });
  assertEquals(second.status, 201);
  assertEquals((await app.store.getTask(taskId))!.spec.instructions, task.spec.instructions);
  assertEquals((await app.store.getRun(runId))!.attended, true);
});

test("the prompt's images become the task's own, as a re-run reads them", async () => {
  const app = buildApp();
  const { taskId, runId, agent, repo } = await startTask(app, {});
  const uploaded = await app.handler(
    new Request(`http://orchestrator.test/v1/runs/${runId}/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png", authorization: "Bearer t" },
      body: PNG as BodyInit,
    }),
  );
  assertEquals(uploaded.status, 201, await uploaded.clone().text());
  const attachment = await uploaded.json();
  const posted = await post(app.handler, `/v1/runs/${runId}/messages`, {
    text: "what is wrong here",
    attachmentIds: [attachment.id],
  });
  assertEquals(posted.status, 201);
  const task = (await app.store.getTask(taskId))!;
  // The composer writes no marker; the instructions name the image all the same.
  assertEquals(task.spec.instructions, "what is wrong here\n\n(attached: [image 1])");
  assertEquals(task.spec.title, "what is wrong here");
  assertEquals((await app.store.getRun(runId))!.workItem.attachments, [
    { id: attachment.id, mime: "image/png" },
  ]);

  // A re-run carries the instructions and is handed the same picture.
  const rerun = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { instructions: task.spec.instructions },
    connectedRepoId: repo.id,
    rerunOf: taskId,
  });
  assertEquals(rerun.status, 201, await rerun.clone().text());
  const again = (await app.store.getRun((await rerun.json()).runId))!;
  assertEquals(again.workItem.attachments?.length, 1);
});

test("launch completion preserves a prompt and attendance written while provisioning awaits", async () => {
  const app = buildApp();
  const launch = app.deps.provisioner.launch;
  app.deps.provisioner.launch = async (spec) => {
    const message = await post(app.handler, `/v1/runs/${spec.runId}/messages`, {
      text: "Fix the launch race",
    });
    assertEquals(message.status, 201);
    await app.store.markRunAttended(spec.runId, app.clock.now().toISOString());
    return launch(spec);
  };
  const { taskId, runId } = await startTask(app, {});
  const run = (await app.store.getRun(runId))!;
  assertEquals(run.state, "starting");
  assert(run.handle !== null);
  assert(run.launchedAt !== null);
  assertEquals(run.attended, true);
  assertEquals(run.workItem.spec.instructions, "Fix the launch race");
  assertEquals((await app.store.getTask(taskId))!.spec.instructions, "Fix the launch race");
  assertEquals((await app.store.listRunMessages(runId)).map((m) => m.text), [
    "Fix the launch race",
  ]);
});

test("two first messages race: exactly one becomes the task, the other follows it", async () => {
  const app = buildApp();
  const { taskId, runId } = await startTask(app, {});
  const [a, b] = await Promise.all([
    post(app.handler, `/v1/runs/${runId}/messages`, { text: "first ask" }),
    post(app.handler, `/v1/runs/${runId}/messages`, { text: "second ask" }),
  ]);
  assertEquals([a.status, b.status], [201, 201]);
  const messages = await app.store.listRunMessages(runId);
  assertEquals(messages.map((m) => m.seq), [0, 1]);
  const task = (await app.store.getTask(taskId))!;
  // The task is the message with the first seq; the other is a message after it.
  assertEquals(task.spec.instructions, messages[0].text);
  assertNotEquals(task.spec.instructions, messages[1].text);
});

test("nothing but a person's message reaches a run awaiting its prompt", async () => {
  const app = buildApp();
  const { runId } = await startTask(app, {});
  const run = (await app.store.getRun(runId))!;
  const refused = await postMessage(app.deps, run, {
    kind: "system",
    sender: { kind: "platform" },
    text: "a note from the platform",
  });
  assertEquals(refused.kind, "refused");
  if (refused.kind === "refused") assertEquals(refused.status, 409);
  assertEquals(await app.store.listRunMessages(runId), []);
});

test("an awaiting run's wait is on the attended clock, and the reaper ends it there", async () => {
  const app = buildApp();
  const { runId, runToken } = await startTask(app, {});
  // The runner, booted and waiting, reports the deadline it waits until — further than the
  // attended clock allows, which the control plane clamps.
  const far = new Date(app.clock.now().getTime() + 24 * 60 * 60_000).toISOString();
  await post(app.handler, `/v1/runs/${runId}/heartbeat`, {
    seq: 0,
    phase: "running",
    idleDeadlineAt: far,
  }, runToken);
  const run = (await app.store.getRun(runId))!;
  assertEquals(run.attended, false);
  const deadline = Date.parse(run.idleDeadlineAt!);
  // The person who started it is there writing it: the attended clock, though not attended.
  assertEquals(deadline, app.clock.now().getTime() + run.workItem.lifetime.attendedIdleMs);
  assertNotEquals(run.workItem.lifetime.attendedIdleMs, run.workItem.lifetime.idleMs);
  const past = deadline + CFG.idleGraceMs + 1;
  const action = planSweep({ ...run, lastHeartbeatAt: new Date(past).toISOString() }, past, CFG);
  assertEquals(action.kind, "idle-expired");
});

test("once the prompt lands, a run-page run stays on the attended clock; others do not", async () => {
  const app = buildApp();
  const { runId } = await startTask(app, {});
  const posted = await post(app.handler, `/v1/runs/${runId}/messages`, { text: "Fix it" });
  assertEquals(posted.status, 201);
  const run = (await app.store.getRun(runId))!;
  // Started on the run page: its agent leaves the end to the person reading it.
  assertEquals(run.workItem.interactive, true);
  assertEquals(run.attended, false);
  const at = app.clock.now().toISOString();
  const far = new Date(app.clock.now().getTime() + 24 * 60 * 60_000).toISOString();
  assertEquals(
    Date.parse(clampIdleDeadline(run, far, at)!),
    Date.parse(at) + run.workItem.lifetime.attendedIdleMs,
  );
  const { interactive: _, ...elsewhere } = run.workItem;
  assertEquals(
    Date.parse(clampIdleDeadline({ ...run, workItem: elsewhere }, far, at)!),
    Date.parse(at) + run.workItem.lifetime.idleMs,
  );
});

test("a run that ended between the read and the claim refuses the prompt", async () => {
  const app = buildApp();
  const { taskId, runId } = await startTask(app, {});
  const read = (await app.store.getRun(runId))!;
  // It idles out after the route read it, before the claim.
  await app.store.saveRunTransition({
    ...read,
    state: "cancelled",
    updatedAt: app.clock.now().toISOString(),
  }, read);
  const outcome = await postUserMessage({ ...app.deps, platformModel: null }, read, {
    sender: { kind: "user", userId: USER.userId },
    text: "too late",
  });
  assertEquals(outcome.kind, "refused");
  if (outcome.kind === "refused") {
    assertEquals(outcome.status, 409);
    assertEquals(outcome.reason, "terminal");
  }
  assertEquals((await app.store.getTask(taskId))!.spec.instructions, null);
  assertEquals(await app.store.listRunMessages(runId), []);

  // Through the route, the reason travels with the refusal.
  const refused = await post(app.handler, `/v1/runs/${runId}/messages`, { text: "too late" });
  assertEquals(refused.status, 409);
  assertEquals((await refused.json()).reason, "terminal");
});

test("the prompt's title is its first line at once, then the background model's", async () => {
  const { model, asked } = fakeModel('"Fix the flaky login test."\n');
  const app = buildApp(model);
  const { taskId, runId } = await startTask(app, {});
  app.published.length = 0;
  const text = "the login test is flaky on CI, it times out about one run in five. please fix it";
  await post(app.handler, `/v1/runs/${runId}/messages`, { text });
  const fallback = fallbackTitle(text);
  assertEquals(fallback, "the login test is flaky on CI, it times out about one run…");
  assertEquals(await titleSettles(app, taskId, fallback), "Fix the flaky login test");
  // The model was told who and where, and given the words.
  assertEquals(asked.length, 1);
  assert(asked[0].prompt.includes("Agent: Ada"));
  assert(asked[0].prompt.includes("acme/app"));
  assert(asked[0].prompt.includes("one run in five"));
  // Both titles reached the live tail.
  assertEquals(app.published.filter((id) => id === taskId).length >= 2, true);
});

test("a task created with instructions and no title gets one; a given title is never touched", async () => {
  const { model, asked } = fakeModel("Investigate the cache");
  const app = buildApp(model);
  const untitled = await startTask(app, { instructions: "Look at the cache first." });
  assertEquals(
    await titleSettles(app, untitled.taskId, "Look at the cache first."),
    "Investigate the cache",
  );

  const { repo, agent } = untitled;
  const created = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "My own title", instructions: "Look at the cache again." },
    connectedRepoId: repo.id,
  });
  const { taskId } = await created.json();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals((await app.store.getTask(taskId))!.spec.title, "My own title");
  assertEquals(asked.length, 1, "the model is not even asked");
});

test("no background model, a failing one or a slow one: the fallback stands", async () => {
  // None configured.
  const none = buildApp(null);
  const a = await startTask(none, { instructions: "Bump the lockfile" });
  assertEquals(await titleSettles(none, a.taskId, "Bump the lockfile", 50), "Bump the lockfile");

  // The proxy refuses (no background model set under Instance → Platform, say).
  const failing = buildApp(fakeModel(new Error("no platform policy")).model);
  const b = await startTask(failing, { instructions: "Bump the lockfile" });
  assertEquals(await titleSettles(failing, b.taskId, "Bump the lockfile", 50), "Bump the lockfile");

  // Nonsense: nothing usable is left after sanitizing.
  const blank = buildApp(fakeModel('  ""  \n').model);
  const c = await startTask(blank, { instructions: "Bump the lockfile" });
  assertEquals(await titleSettles(blank, c.taskId, "Bump the lockfile", 50), "Bump the lockfile");

  // Slow: the bound ends the wait, whatever the model does after.
  const slow = buildApp(null);
  const d = await startTask(slow, { instructions: "Bump the lockfile" });
  const titled = await titleTask(
    {
      store: slow.store,
      platformModel: fakeModel("hang").model,
      diag: silentDiagnostics(),
      titleTimeoutMs: 20,
    },
    d.taskId,
    "Bump the lockfile",
  );
  assertEquals(titled, false);
  assertEquals((await slow.store.getTask(d.taskId))!.spec.title, "Bump the lockfile");
});

test("fallback titles and sanitized ones", () => {
  assertEquals(fallbackTitle("## Fix it\nmore"), "Fix it");
  assertEquals(fallbackTitle("\n\n  - [image 1] what is wrong here"), "what is wrong here");
  assertEquals(fallbackTitle("(attached: [image 1])"), "New task");
  const long = fallbackTitle(`${"word ".repeat(30)}`);
  assert(long.endsWith("…") && long.length <= 61, long);
  assertEquals(sanitizeTitle("Title: **Fix the login**."), "Fix the login");
  assertEquals(sanitizeTitle("'\"Quoted twice\"'"), "Quoted twice");
  assertEquals(sanitizeTitle("\n\nFirst line\nsecond line"), "First line");
  assertEquals(sanitizeTitle(" . "), null);
  assert(sanitizeTitle("x".repeat(200))!.length <= 80);
});

test("references a request points at are read off links and shorthand, never fetched", () => {
  assertEquals(
    extractReferences(
      "https://github.com/acme/widgets/issues/216\nand https://github.com/acme/app/pull/88/files " +
        "plus acme/web#12, #7 and https://gitlab.com/g/sub/proj/-/merge_requests/3",
    ),
    [
      { label: "issue #216", repo: "acme/widgets" },
      { label: "PR #88", repo: "acme/app" },
      { label: "MR #3", repo: "g/sub/proj" },
      { label: "#12", repo: "acme/web" },
      { label: "#7", repo: null },
    ],
  );
  assertEquals(
    extractReferences(
      "https://app.radicle.xyz/nodes/seed.radicle.xyz/rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5/patches/" +
        "3f2a1b9c0d4e5f60718293a4b5c6d7e8f9a0b1c2",
    ),
    [{ label: "patch 3f2a1b9", repo: "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5" }],
  );
  // Anchors, colours and links to anything else are not references.
  assertEquals(extractReferences("see https://example.com/page#12 and colour #fff, a&#38;b"), []);
});

test("instructions that point at a reference fall back to its name", () => {
  const issue = "https://github.com/acme/widgets/issues/216";
  assertEquals(
    fallbackTitle(
      `${issue}\n\ntackle this issue please. once you figured out some ui please hold for my feedback`,
    ),
    "Tackle issue #216",
  );
  assertEquals(fallbackTitle(`${issue} please look into this`), "Look into issue #216");
  assertEquals(fallbackTitle(`${issue}\n\nthoughts?`), "Issue #216");
  assertEquals(fallbackTitle(issue), "Issue #216");
  assertEquals(fallbackTitle("#88\nreview it"), "Review #88");
  assertEquals(
    fallbackTitle("https://github.com/acme/app/pull/88 is failing on CI"),
    "PR #88 is failing on CI",
  );
  assertEquals(
    fallbackTitle(`Fix the crash described in ${issue}`),
    "Fix the crash described in issue #216",
  );
  // No reference: the first line, as ever.
  assertEquals(fallbackTitle("## Fix it\nmore"), "Fix it");
});

test("an answer about itself is no title; a title that merely shares a word is", () => {
  for (
    const meta of [
      "Need issue title",
      "Needs more context",
      "Unknown task",
      "Unclear",
      "Untitled",
      "No title",
      "Missing context",
      "Insufficient information to title",
      "Issue title needed",
      "More info needed",
      "Please provide the issue",
      "I cannot see the issue",
      "Cannot determine task",
      "Unable to access the link",
    ]
  ) {
    assert(isMetaTitle(meta), meta);
    assertEquals(sanitizeTitle(meta), null, meta);
  }
  for (
    const legit of [
      "Missing index on runs",
      "Unknown column error in migrations",
      "Unclear error messages in setup",
      "Needs-review label sync",
      "Issue title truncation in the list",
      "Tackle issue #216",
      "Provider settings page",
      "No-title tasks in the feed",
    ]
  ) {
    assert(!isMetaTitle(legit), legit);
  }
});

test("the model is told what the request points at, and a meta answer keeps the fallback", async () => {
  const text = "https://github.com/acme/widgets/issues/216\n\ntackle this issue please";
  const { model, asked } = fakeModel("Need issue title");
  const app = buildApp(model);
  const { taskId } = await startTask(app, { instructions: text });
  const fallback = fallbackTitle(text);
  assertEquals(fallback, "Tackle issue #216");
  const titled = await titleTask(
    { store: app.store, platformModel: model, diag: silentDiagnostics() },
    taskId,
    fallback,
  );
  assertEquals(titled, false);
  assertEquals((await app.store.getTask(taskId))!.spec.title, fallback);
  assert(asked.length >= 1);
  const last = asked[asked.length - 1];
  assert(
    last.prompt.includes("Points at (not visible to you): issue #216 in acme/widgets"),
  );
  assert(last.system.includes("Tackle issue #216"));
});

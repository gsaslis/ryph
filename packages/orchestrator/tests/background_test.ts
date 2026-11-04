import { test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// Background commands, durably: the runner records each job it starts and how it ended, and
// uploads its log; the run page lists the jobs and reads a log back. The runner door is the run's
// own bearer for the run in the path, a job id is held to its shape before anything is keyed by
// it, a run keeps at most 64, nothing lands once the run concluded, a log is cleaned before it is
// stored, and reading takes exactly the gate a run's images take.

import { capsClaimOf } from "@ryph/auth";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import { makeInboxSignal } from "../src/core/inbox_signal.ts";
import {
  backgroundLogKey,
  backgroundTailOf,
  cleanOutput,
  LOG_CLAIM_TTL_MS,
  MAX_BACKGROUND_COMMANDS,
  MAX_BACKGROUND_LOG_BYTES,
} from "../src/core/background.ts";
import { MAX_BACKGROUND_LOGS_IN_FLIGHT, MAX_RECORD_BYTES } from "../src/http/background_api.ts";
import { memoryBackgroundStore, memoryLogStore } from "./background_doubles.ts";
import {
  fakeClock,
  fakeIdentityDirectory,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";

const MEMBER = {
  kind: "user",
  userId: "u-1",
  email: "ada@example.com",
  name: "Ada",
  caps: capsClaimOf("member"),
  emailVerified: true,
  sid: "s-1",
  via: "session",
} as const;
/** Someone else, who can read tasks but has no identity on the forge: only their own are theirs. */
const STRANGER = {
  ...MEMBER,
  userId: "u-2",
  email: "eve@example.com",
  caps: capsClaimOf("viewer"),
};
const OPERATOR = { ...STRANGER, caps: capsClaimOf("operator") };

function buildApp(opts: { wired?: boolean; deadlineMs?: number } = {}) {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner, launches } = fakeProvisioner();
  const identities = fakeIdentityDirectory();
  const { control } = fakeRunnerControl();
  const forge = noopForge(silentDiagnostics(), {
    permission: "allowed",
    repos: [{
      fullName: "acme/app",
      url: "https://github.com/acme/app.git",
      defaultBranch: "main",
      private: true,
    }],
  });
  const caller = {
    principal: MEMBER as typeof MEMBER | typeof STRANGER | typeof OPERATOR,
  };
  const background = memoryBackgroundStore(store);
  const logs = memoryLogStore();
  const wired = opts.wired ?? true;
  const deps = {
    store,
    provisioner,
    runnerControl: control,
    diag: silentDiagnostics(),
    authenticate: (() => Promise.resolve(caller.principal)) as unknown as Authenticate,
    forge,
    githubConnect: forge,
    identityDirectory: identities.directory,
    inbox: makeInboxSignal(),
    backgroundStore: wired ? background : null,
    backgroundLogs: wired ? logs : null,
    backgroundLogDeadlineMs: opts.deadlineMs,
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
    caller,
    launches,
    identities,
    background,
    logs,
    clock,
  };
}

type App = ReturnType<typeof buildApp>;
const BASE = "http://orchestrator.test";

const send = (
  app: App,
  method: string,
  path: string,
  body: BodyInit | null,
  token = "t",
  type = "application/json",
) =>
  app.handler(
    new Request(`${BASE}${path}`, {
      method,
      headers: { "content-type": type, authorization: `Bearer ${token}` },
      body,
    }),
  );
const json = (app: App, method: string, path: string, body: unknown = {}, token = "t") =>
  send(app, method, path, JSON.stringify(body), token);
const get = (app: App, path: string) =>
  app.handler(new Request(`${BASE}${path}`, { headers: { authorization: "Bearer t" } }));

const made = new WeakMap<App, { repo: { id: string }; agent: { id: string } }>();

/** A task on a connected repo: a live run, and its runner token. */
async function liveRun(app: App) {
  if (made.get(app) === undefined) {
    app.identities.link(MEMBER.userId, "noop-ada-lovelace");
    await json(app, "POST", "/v1/installations", { installationId: "42" });
    const repo = await (await json(app, "POST", "/v1/connected-repos", {
      installationId: "42",
      repoRef: "acme/app",
    })).json();
    const agent = await (await json(app, "POST", "/v1/agents", {
      name: "Ada",
      email: "ada@example.com",
      harnessKind: "echo",
    })).json();
    made.set(app, { repo, agent });
  }
  const { repo, agent } = made.get(app)!;
  const created = await json(app, "POST", "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Build it", instructions: "Run the tests in the background" },
    connectedRepoId: repo.id,
    lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
  });
  assertEquals(created.status, 201);
  const { runId, taskId } = await created.json();
  const runToken = (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN;
  await json(app, "POST", `/v1/runs/${runId}/heartbeat`, { seq: 0, phase: "running" }, runToken);
  return { runId, taskId, runToken };
}

const START = {
  id: "bg-1",
  label: "tests",
  command: "deno task test",
  cwd: "/work/repo",
  service: false,
  startedAt: "2026-01-01T00:00:00.000Z",
  timeoutAt: "2026-01-01T00:30:00.000Z",
};
const EXIT = {
  endedAt: "2026-01-01T00:04:12.000Z",
  reason: "exited",
  exitCode: 1,
  signal: null,
  logBytes: 2048,
  logTruncated: false,
  logTail: "ok 11\nFAILED 1",
};

const startJob = (app: App, runId: string, token: string, jobId = "bg-1", body: unknown = START) =>
  json(app, "PUT", `/v1/runs/${runId}/runner/background/${jobId}`, body, token);
const exitJob = (app: App, runId: string, token: string, jobId = "bg-1", body: unknown = EXIT) =>
  json(app, "POST", `/v1/runs/${runId}/runner/background/${jobId}/exit`, body, token);
/** A job started and ended: what a log is taken for. */
const endJob = async (app: App, runId: string, token: string, jobId = "bg-1") => {
  await startJob(app, runId, token, jobId, { ...START, id: undefined });
  await exitJob(app, runId, token, jobId);
};
/** A job's stored log, where its row says it is. */
const storedLog = async (app: App, runId: string, jobId: string) => {
  const key = (await app.background.get(runId, jobId))?.logKey;
  return key == null ? undefined : app.logs.logs.get(key);
};
const putLog = (app: App, runId: string, token: string, text: BodyInit, jobId = "bg-1") =>
  send(app, "PUT", `/v1/runs/${runId}/runner/background/${jobId}/log`, text, token, "text/plain");

test("a job is recorded as it starts and ends, idempotently, and listed for the run page", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);

  const first = await startJob(app, runId, runToken);
  assertEquals(first.status, 201);
  assertEquals(await first.json(), { id: "bg-1", created: true });
  // A retry is answered as done and changes nothing.
  const again = await startJob(app, runId, runToken, "bg-1", { ...START, label: "renamed" });
  assertEquals(again.status, 200);
  assertEquals(await again.json(), { id: "bg-1", created: false });

  const listed = await get(app, `/v1/runs/${runId}/background`);
  assertEquals(listed.status, 200);
  assertEquals(await listed.json(), {
    jobs: [{
      id: "bg-1",
      label: "tests",
      command: "deno task test",
      cwd: "/work/repo",
      service: false,
      startedAt: START.startedAt,
      timeoutAt: START.timeoutAt,
      endedAt: null,
      reason: null,
      exitCode: null,
      signal: null,
      logBytes: 0,
      logTruncated: false,
      logTail: null,
      hasLog: false,
    }],
  });

  const ended = await exitJob(app, runId, runToken);
  assertEquals([ended.status, await ended.json()], [200, { id: "bg-1", ended: true }]);
  const twice = await exitJob(app, runId, runToken, "bg-1", { ...EXIT, exitCode: 0 });
  assertEquals([twice.status, await twice.json()], [200, { id: "bg-1", ended: false }]);

  const [job] = (await (await get(app, `/v1/runs/${runId}/background`)).json()).jobs;
  assertEquals(
    [job.endedAt, job.reason, job.exitCode, job.logBytes, job.logTail],
    [EXIT.endedAt, "exited", 1, 2048, "ok 11\nFAILED 1"],
  );
});

test("jobs are listed in the order they were numbered", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  for (const n of [10, 2, 1]) {
    await startJob(app, runId, runToken, `bg-${n}`, { ...START, id: undefined });
  }
  const { jobs } = await (await get(app, `/v1/runs/${runId}/background`)).json();
  assertEquals(jobs.map((j: { id: string }) => j.id), ["bg-1", "bg-2", "bg-10"]);
});

test("the runner door takes only the run's own bearer, for the run in the path", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  const other = await liveRun(app);
  assertEquals((await startJob(app, runId, "not-the-token")).status, 401);
  // Another run's token, or this token on another run: both are just unauthorized.
  assertEquals((await startJob(app, runId, other.runToken)).status, 401);
  assertEquals((await startJob(app, other.runId, runToken)).status, 401);
  assertEquals((await startJob(app, "r-nope", runToken)).status, 401);
  assertEquals((await exitJob(app, runId, other.runToken)).status, 401);
  assertEquals((await putLog(app, runId, other.runToken, "x")).status, 401);
  // A user's bearer is no runner's.
  assertEquals((await startJob(app, runId, "t")).status, 401);
  assertEquals(app.background.rows.size, 0);
});

test("a job id is held to its shape before anything is keyed by it", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  for (const bad of ["bg-1000", "bg-", "BG-1", "bg-1a", "..%2F..%2Fx", "bg-%2E%2E", "x"]) {
    const res = await startJob(app, runId, runToken, bad, { ...START, id: undefined });
    assertEquals(res.status, 400, bad);
    assertEquals((await putLog(app, runId, runToken, "log", bad)).status, 400, bad);
    assertEquals((await get(app, `/v1/runs/${runId}/background/${bad}/log`)).status, 400, bad);
  }
  // The body's id, when there is one, must be the path's.
  assertEquals((await startJob(app, runId, runToken, "bg-2")).status, 400);
  assertEquals(app.background.rows.size, 0);
  assertEquals(app.logs.logs.size, 0);
  const claim = crypto.randomUUID();
  assertEquals(
    backgroundLogKey(runId, "bg-7", claim),
    `runs/${runId}/background/bg-7/${claim}.log`,
  );
});

test("records are bounded: unknown fields stripped, text clipped, the rest refused", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  const res = await startJob(app, runId, runToken, "bg-1", {
    ...START,
    label: "l".repeat(500),
    command: "c".repeat(10_000),
    cwd: "d".repeat(5_000),
    hasLog: true,
    runId: "r-other",
  });
  assertEquals(res.status, 201);
  const row = (await app.background.get(runId, "bg-1"))!;
  assertEquals([row.label.length, row.command.length, row.cwd.length], [80, 4096, 1024]);
  assertEquals([row.runId, row.hasLog], [runId, false]);

  // Control and bidi characters are taken out of what people are shown.
  await startJob(app, runId, runToken, "bg-5", {
    ...START,
    id: undefined,
    label: "safe\u202egnp.exe\u0007",
    command: "make\r\nmake test\u001b[2J\u0085\u2067",
    cwd: "/work\u0000/repo",
  });
  const clean = (await app.background.get(runId, "bg-5"))!;
  assertEquals([clean.label, clean.command, clean.cwd], [
    "safegnp.exe",
    "make make test[2J",
    "/work/repo",
  ]);
  assertEquals(
    (await startJob(app, runId, runToken, "bg-6", { ...START, id: undefined, label: "\u200f" }))
      .status,
    400,
  );

  // A clip never leaves half a surrogate pair behind.
  await startJob(app, runId, runToken, "bg-4", {
    ...START,
    id: undefined,
    label: "a".repeat(78) + "😀😀",
    command: "c".repeat(4094) + "😀😀",
  });
  const emoji = (await app.background.get(runId, "bg-4"))!;
  assertEquals(emoji.label, "a".repeat(78) + "…");
  assert(emoji.label.isWellFormed() && emoji.command.isWellFormed());

  const refused = [
    { ...START, label: "" },
    { ...START, service: "yes" },
    { ...START, startedAt: "yesterday" },
    { label: "x" },
  ];
  for (const body of refused) {
    assertEquals((await startJob(app, runId, runToken, "bg-2", body)).status, 400);
  }
  for (
    const body of [
      { ...EXIT, reason: "exploded" },
      { ...EXIT, exitCode: 1.5 },
      { ...EXIT, signal: "rm -rf /" },
      { ...EXIT, logBytes: -1 },
    ]
  ) {
    assertEquals((await exitJob(app, runId, runToken, "bg-1", body)).status, 400);
  }
  // A record over its byte cap is refused before it is parsed.
  const huge = { ...EXIT, logTail: "x".repeat(MAX_RECORD_BYTES) };
  assertEquals((await exitJob(app, runId, runToken, "bg-1", huge)).status, 413);
  assertEquals((await app.background.get(runId, "bg-1"))!.endedAt, null);
  assertEquals(
    (await send(app, "PUT", `/v1/runs/${runId}/runner/background/bg-3`, "{", runToken)).status,
    400,
  );
});

test("an exit's tail is cleaned and cut to its last lines", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  await startJob(app, runId, runToken);
  const lines = Array.from({ length: 100 }, (_, n) => `line ${n}`);
  const tail = `\u001b[31m${lines.join("\n")}\u001b[0m\npushing https://x-access:v1.${
    "a".repeat(20)
  }.${"b".repeat(20)}@gateway/repo`;
  await exitJob(app, runId, runToken, "bg-1", { ...EXIT, logTail: tail });
  const row = (await app.background.get(runId, "bg-1"))!;
  const kept = row.logTail!.split("\n");
  assertEquals(kept.length, 64);
  assertEquals(kept[0], "line 37");
  assert(!row.logTail!.includes("\u001b"));
  assert(!row.logTail!.includes("v1.aaaa"));
  assertStringIncludes(row.logTail!, "://[redacted]@gateway/repo");
  assertEquals(backgroundTailOf("x".repeat(40_000)).length, 16 * 1024);
});

test("an exit or a log for a job never started is a 404", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  assertEquals((await exitJob(app, runId, runToken, "bg-5")).status, 404);
  assertEquals((await putLog(app, runId, runToken, "out", "bg-5")).status, 404);
  assertEquals(app.logs.logs.size, 0, "a refused log stores nothing");
});

test("a log is cleaned and stored whole, and served back inert", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  await endJob(app, runId, runToken);
  assertEquals((await get(app, `/v1/runs/${runId}/background/bg-1/log`)).status, 404);

  const raw = "\u001b[1;32mPASS\u001b[0m <script>alert(1)</script>\r\n" +
    "Authorization: Bearer abcdef123456\rclone https://ada:hunter2@example.com/r.git\n";
  const stored = await putLog(app, runId, runToken, raw);
  assertEquals(stored.status, 200);
  const { bytes, stored: wrote } = await stored.json();
  assertEquals(wrote, true);
  const kept = (await storedLog(app, runId, "bg-1"))!;
  assertEquals(bytes, new TextEncoder().encode(kept).byteLength);
  assertEquals(
    kept,
    "PASS <script>alert(1)</script>\nAuthorization: Bearer [redacted]\n" +
      "clone https://[redacted]@example.com/r.git\n",
  );
  // A log is written once: a retry, or anything else sent after it, is answered and not written.
  const retry = await putLog(app, runId, runToken, "something else");
  assertEquals([retry.status, await retry.json()], [200, { id: "bg-1", stored: false }]);
  assertEquals(await storedLog(app, runId, "bg-1"), kept);

  const served = await get(app, `/v1/runs/${runId}/background/bg-1/log`);
  assertEquals(served.status, 200);
  assertEquals(served.headers.get("content-type"), "text/plain; charset=utf-8");
  assertEquals(served.headers.get("x-content-type-options"), "nosniff");
  assertEquals(served.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assertEquals(await served.text(), kept);
  const [job] = (await (await get(app, `/v1/runs/${runId}/background`)).json()).jobs;
  assertEquals(job.hasLog, true);

  // Bytes that are not UTF-8 are read lossily, not refused.
  await endJob(app, runId, runToken, "bg-2");
  const latin = await putLog(app, runId, runToken, new Uint8Array([0x66, 0xff, 0x6f]), "bg-2");
  assertEquals(latin.status, 200);
  assertEquals(await storedLog(app, runId, "bg-2"), "f\ufffdo");
});

test("a log over 4 MiB is refused and nothing is stored", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  await endJob(app, runId, runToken);
  const over = new Uint8Array(MAX_BACKGROUND_LOG_BYTES + 1).fill(0x61);
  assertEquals((await putLog(app, runId, runToken, over)).status, 413);
  // A chunked body that announces no length is held to the same cap as it streams.
  const streamed = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(1024 * 1024).fill(0x61));
      controller.close();
    },
  });
  assertEquals((await putLog(app, runId, runToken, streamed)).status, 413);
  assertEquals(app.logs.logs.size, 0);
  const atCap = new Uint8Array(MAX_BACKGROUND_LOG_BYTES).fill(0x61);
  assertEquals((await putLog(app, runId, runToken, atCap)).status, 200);
});

test("a run keeps at most 64 jobs", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  for (let n = 1; n <= MAX_BACKGROUND_COMMANDS; n++) {
    const res = await startJob(app, runId, runToken, `bg-${n}`, { ...START, id: undefined });
    assertEquals(res.status, 201);
  }
  const over = await startJob(app, runId, runToken, "bg-65", { ...START, id: undefined });
  assertEquals(over.status, 409);
  assertEquals((await get(app, `/v1/runs/${runId}/background`)).status, 200);
  assertEquals(app.background.rows.size, 64);
});

test("once the run concluded, the runner door is gone and the record stays readable", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  await endJob(app, runId, runToken);
  await putLog(app, runId, runToken, "partial");
  const run = (await app.store.getRun(runId))!;
  await app.store.saveRunResult({ ...run, state: "succeeded" });

  assertEquals(
    (await startJob(app, runId, runToken, "bg-2", { ...START, id: undefined })).status,
    410,
  );
  assertEquals((await exitJob(app, runId, runToken)).status, 410);
  assertEquals((await putLog(app, runId, runToken, "late")).status, 410);
  assertEquals(await storedLog(app, runId, "bg-1"), "partial");
  assertEquals((await get(app, `/v1/runs/${runId}/background`)).status, 200);
  assertEquals(await (await get(app, `/v1/runs/${runId}/background/bg-1/log`)).text(), "partial");
});

test("reading takes the run's read gate: a run the caller cannot see is a 404", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  await endJob(app, runId, runToken);
  await putLog(app, runId, runToken, "secret build output");

  app.caller.principal = STRANGER;
  assertEquals((await get(app, `/v1/runs/${runId}/background`)).status, 404);
  assertEquals((await get(app, `/v1/runs/${runId}/background/bg-1/log`)).status, 404);
  assertEquals((await get(app, `/v1/runs/r-nope/background`)).status, 404);

  // Reading every run is a capability, and it reads this one.
  app.caller.principal = OPERATOR;
  assertEquals((await get(app, `/v1/runs/${runId}/background`)).status, 200);
  assertEquals((await get(app, `/v1/runs/${runId}/background/bg-1/log`)).status, 200);

  // The caller's own run, with no `tasks:read`, is refused outright.
  app.caller.principal = { ...MEMBER, caps: [] } as unknown as typeof MEMBER;
  assertEquals((await get(app, `/v1/runs/${runId}/background`)).status, 403);
});

test("a deployment that records none answers the runner 503 and the page an empty list", async () => {
  const app = buildApp({ wired: false });
  const { runId, runToken } = await liveRun(app);
  assertEquals((await startJob(app, runId, runToken)).status, 503);
  assertEquals(await (await get(app, `/v1/runs/${runId}/background`)).json(), { jobs: [] });
  assertEquals((await get(app, `/v1/runs/${runId}/background/bg-1/log`)).status, 404);
});

test("a log that cleaning grew past 4 MiB keeps its last 4 MiB, on a character boundary", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  await endJob(app, runId, runToken);
  // Every invalid byte becomes U+FFFD, three bytes in UTF-8: 4 MiB in would be 12 MiB stored.
  const body = new Uint8Array(MAX_BACKGROUND_LOG_BYTES).fill(0xff);
  body.set(new TextEncoder().encode("END"), body.length - 3);
  const res = await putLog(app, runId, runToken, body);
  assertEquals(res.status, 200);
  const kept = (await storedLog(app, runId, "bg-1"))!;
  const bytes = new TextEncoder().encode(kept).byteLength;
  assert(bytes <= MAX_BACKGROUND_LOG_BYTES);
  assert(bytes > MAX_BACKGROUND_LOG_BYTES - 3);
  assertEquals((await res.json()).bytes, bytes);
  assert(kept.endsWith("�END"));
  assert(kept.startsWith("�"), "no partial character at the cut");
});

/** A body that records whether anything read it. */
function watchedBody(onRead: () => void | Promise<void> = () => {}) {
  const state = { read: false };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      state.read = true;
      await onRead();
      controller.enqueue(new TextEncoder().encode("output\n"));
      controller.close();
    },
  }, { highWaterMark: 0 }); // nothing is pulled until someone reads
  return { body, state };
}

test("a log is refused before its body is read: no job, a stored log, a concluded run", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  const none = watchedBody();
  assertEquals((await putLog(app, runId, runToken, none.body, "bg-9")).status, 404);
  assertEquals(none.state.read, false);

  await endJob(app, runId, runToken);
  await putLog(app, runId, runToken, "first");
  const again = watchedBody();
  assertEquals((await putLog(app, runId, runToken, again.body)).status, 200);
  assertEquals(again.state.read, false);

  const run = (await app.store.getRun(runId))!;
  await app.store.saveRunResult({ ...run, state: "succeeded" });
  const late = watchedBody();
  assertEquals((await putLog(app, runId, runToken, late.body)).status, 410);
  assertEquals(late.state.read, false);
});

test("a run concluding mid-upload still marks the log it stored: no orphan object", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  await endJob(app, runId, runToken);
  const upload = watchedBody(async () => {
    const run = (await app.store.getRun(runId))!;
    await app.store.saveRunResult({ ...run, state: "succeeded" });
  });
  assertEquals((await putLog(app, runId, runToken, upload.body)).status, 200);
  assertEquals(await storedLog(app, runId, "bg-1"), "output\n");
  assertEquals((await app.background.get(runId, "bg-1"))!.hasLog, true);
  assertEquals(await (await get(app, `/v1/runs/${runId}/background/bg-1/log`)).text(), "output\n");
});

test("a job the run ended without an exit record is listed as ended with the run", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  await startJob(app, runId, runToken);
  await startJob(app, runId, runToken, "bg-2", { ...START, id: undefined });
  await exitJob(app, runId, runToken, "bg-2");
  // While the run is live, a job with no exit is running.
  const live = (await (await get(app, `/v1/runs/${runId}/background`)).json()).jobs;
  assertEquals(live[0].endedAt, null);

  const run = (await app.store.getRun(runId))!;
  const at = "2026-01-01T01:00:00.000Z";
  await app.store.saveRunTransition({ ...run, state: "lost", updatedAt: at }, run);
  const [first, second] = (await (await get(app, `/v1/runs/${runId}/background`)).json()).jobs;
  assertEquals(
    [first.endedAt, first.reason, first.exitCode, first.signal],
    [at, "run_ended", null, null],
  );
  // A job that ended keeps its own record.
  assertEquals([second.endedAt, second.reason, second.exitCode], [EXIT.endedAt, "exited", 1]);
  // The stored row is untouched: this is how it is shown, not what was recorded.
  assertEquals((await app.background.get(runId, "bg-1"))!.endedAt, null);
});

test("uploads racing for one log: one reads its body and writes, the rest are refused unread", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  await endJob(app, runId, runToken);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const bodies = Array.from({ length: 30 }, () => watchedBody(() => held));
  let answered = 0;
  const answers = bodies.map(({ body }) =>
    putLog(app, runId, runToken, body).finally(() => answered++)
  );
  // Everyone but the one reading is answered while it is still reading. Waited for rather than
  // slept on: under a check's CPU quota some take longer than any fixed pause to reach their
  // claim, and one that arrives after the log is stored is a 200 of its own. Bounded, so an
  // upload left waiting on the reader fails the asserts below instead of hanging.
  for (const until = Date.now() + 10_000; answered < bodies.length - 1 && Date.now() < until;) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  release();
  const responses = await Promise.all(answers);
  const statuses = responses.map((r) => r.status);
  // Every one refused for the claim says so in a code the runner can read.
  for (const res of responses.filter((r) => r.status === 409)) {
    assertEquals((await res.json()).code, "busy");
  }
  assertEquals(statuses.filter((s) => s === 200).length, 1);
  assert(statuses.every((s) => s === 200 || s === 409 || s === 429), String(statuses));
  assertEquals(bodies.filter((b) => b.state.read).length, 1);
  assertEquals(app.logs.puts, 1);
  // The race over, the log is stored and a late one is answered without a write.
  const late = watchedBody();
  assertEquals(await (await putLog(app, runId, runToken, late.body)).json(), {
    id: "bg-1",
    stored: false,
  });
  assertEquals([late.state.read, app.logs.puts], [false, 1]);
});

test("a run has at most its cap of log uploads in flight", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const pending = [];
  for (let n = 1; n <= MAX_BACKGROUND_LOGS_IN_FLIGHT; n++) {
    await endJob(app, runId, runToken, `bg-${n}`);
    pending.push(putLog(app, runId, runToken, watchedBody(() => held).body, `bg-${n}`));
  }
  await endJob(app, runId, runToken, "bg-9");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const over = watchedBody();
  assertEquals((await putLog(app, runId, runToken, over.body, "bg-9")).status, 429);
  assertEquals(over.state.read, false);
  release();
  for (const res of await Promise.all(pending)) assertEquals(res.status, 200);
  // The slots are given back.
  assertEquals((await putLog(app, runId, runToken, "now", "bg-9")).status, 200);
});

test("an upload that stores nothing gives its claim back for the retry", async () => {
  const app = buildApp({ deadlineMs: 50 });
  const { runId, runToken } = await liveRun(app);
  await endJob(app, runId, runToken);
  // Too large: refused, the claim released.
  const over = new Uint8Array(MAX_BACKGROUND_LOG_BYTES + 1).fill(0x61);
  const streamedOver = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(over);
      controller.close();
    },
  });
  assertEquals((await putLog(app, runId, runToken, streamedOver)).status, 413);
  assertEquals((await app.background.get(runId, "bg-1"))!.logClaim, null);
  // A body that never finishes arriving: cut off at the deadline, the claim released.
  const stalled = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial "));
    },
  });
  const started = Date.now();
  const timedOut = await putLog(app, runId, runToken, stalled);
  assertEquals(timedOut.status, 408);
  assert(Date.now() - started < 2_000);
  assertEquals((await app.background.get(runId, "bg-1"))!.logClaim, null);
  assertEquals(app.logs.puts, 0);
  // The retry takes the claim and stores the log.
  const retry = await putLog(app, runId, runToken, "whole\n");
  assertEquals((await retry.json()).stored, true);
  assertEquals(await storedLog(app, runId, "bg-1"), "whole\n");
});

test("cleaning: a carriage return that opens a line makes no blank line", () => {
  assertEquals(
    cleanOutput("err 5\n\rprogress 10%\rprogress 20%\r\n"),
    "err 5\nprogress 10%\nprogress 20%\n",
  );
  assertEquals(cleanOutput("\r\rfirst\r\n\r\nafter a blank"), "first\n\nafter a blank");
});

test("the list shows the runner's logBytes and logTruncated as recorded", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  for (const n of [1, 2]) {
    await startJob(app, runId, runToken, `bg-${n}`, { ...START, id: undefined });
  }
  // Both describe the view the runner kept; nothing is inferred from the size.
  await exitJob(app, runId, runToken, "bg-1", {
    ...EXIT,
    logBytes: 6 * 1024 * 1024,
    logTruncated: false,
  });
  await exitJob(app, runId, runToken, "bg-2", { ...EXIT, logBytes: 1024, logTruncated: true });
  const { jobs } = await (await get(app, `/v1/runs/${runId}/background`)).json();
  assertEquals(
    jobs.map((j: { logBytes: number; logTruncated: boolean }) => [j.logBytes, j.logTruncated]),
    [[6 * 1024 * 1024, false], [1024, true]],
  );
});

test("a running job's log cannot be claimed: the runner's, after the exit, is the one kept", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  await startJob(app, runId, runToken);
  // The agent holds the run token too, and tries to get its own text in first.
  const early = watchedBody();
  const refused = await putLog(app, runId, runToken, early.body);
  assertEquals(refused.status, 409);
  assertEquals((await refused.json()).code, "running");
  assertEquals(early.state.read, false);
  assertEquals((await app.background.get(runId, "bg-1"))!.logClaim, null);

  await exitJob(app, runId, runToken);
  assertEquals(
    (await (await putLog(app, runId, runToken, "the real output\n")).json()).stored,
    true,
  );
  assertEquals(await storedLog(app, runId, "bg-1"), "the real output\n");
});

test("an upload whose claim was taken as stale never overwrites the winner's log", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  await endJob(app, runId, runToken);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const slow = watchedBody(() => held);
  const first = putLog(app, runId, runToken, slow.body);
  // Waited for rather than slept on: under a check's CPU quota the first upload can reach its
  // claim after the clock moves, and then holds a fresh one. Reading its body means it has the
  // claim. Bounded, so an upload that never reads fails the asserts below instead of hanging.
  for (const until = Date.now() + 10_000; !slow.state.read && Date.now() < until;) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // Its claim outlives the TTL (its process taken for dead), and another upload takes it.
  app.clock.advance(LOG_CLAIM_TTL_MS + 1);
  const second = await putLog(app, runId, runToken, "winner\n");
  assertEquals((await second.json()).stored, true);
  release();
  const loser = await first;
  assertEquals(loser.status, 409);
  assertEquals((await loser.json()).code, "lost");
  // The loser wrote beside the winner, under its own claim's key; the row names the winner's.
  assertEquals(app.logs.puts, 2);
  assertEquals(await storedLog(app, runId, "bg-1"), "winner\n");
  assertEquals(await (await get(app, `/v1/runs/${runId}/background/bg-1/log`)).text(), "winner\n");
});

test("cleaning takes out controls before redacting, so none can split a credential", () => {
  assertEquals(
    cleanOutput("Authorization: Bearer abc\u0007def123\n"),
    "Authorization: Bearer [redacted]\n",
  );
  assertEquals(
    cleanOutput("clone https://ada:hun\u200eter2@example.com/r.git"),
    "clone https://[redacted]@example.com/r.git",
  );
  assertEquals(
    cleanOutput(`key v1.${"a".repeat(10)}\u202e${"a".repeat(10)}.${"b".repeat(20)}`),
    "key [redacted]",
  );
  // A tab and the line ends stay; the rest of C0, DEL, C1 and the bidi controls go.
  assertEquals(cleanOutput("a\tb\u0000\u007f\u0085\u2066c\r\nd"), "a\tbc\nd");
});

test("an upload whose store or mark throws gives its claim back for the retry", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  await endJob(app, runId, runToken);

  // The object store fails.
  const put = app.logs.put;
  app.logs.put = () => Promise.reject(new Error("store down"));
  await assertRejects(() => putLog(app, runId, runToken, "out\n"));
  assertEquals((await app.background.get(runId, "bg-1"))!.logClaim, null);
  app.logs.put = put;

  // The row's mark fails, after the object was written.
  const mark = app.background.markLog;
  app.background.markLog = () => Promise.reject(new Error("db down"));
  await assertRejects(() => putLog(app, runId, runToken, "out\n"));
  assertEquals((await app.background.get(runId, "bg-1"))!.logClaim, null);
  app.background.markLog = mark;

  // The retry takes the claim and the log lands.
  assertEquals((await (await putLog(app, runId, runToken, "out\n")).json()).stored, true);
  assertEquals(await storedLog(app, runId, "bg-1"), "out\n");
});

test("once a log is stored, logBytes is the stored object's size, whoever uploaded it", async () => {
  const app = buildApp();
  const { runId, runToken } = await liveRun(app);
  await startJob(app, runId, runToken);
  // The runner reports its view as 2 MiB; the upload that wins the claim stores 6 bytes.
  await exitJob(app, runId, runToken, "bg-1", { ...EXIT, logBytes: 2 * 1024 * 1024 });
  const before = (await (await get(app, `/v1/runs/${runId}/background`)).json()).jobs[0];
  assertEquals(before.logBytes, 2 * 1024 * 1024);
  const stored = await (await putLog(app, runId, runToken, "mine\r\n")).json();
  assertEquals(stored.bytes, 5);
  const [job] = (await (await get(app, `/v1/runs/${runId}/background`)).json()).jobs;
  assertEquals([job.hasLog, job.logBytes], [true, 5]);
  assertEquals(new TextEncoder().encode(await storedLog(app, runId, "bg-1")).byteLength, 5);
  // logTruncated stays as the runner reported it.
  assertEquals(job.logTruncated, EXIT.logTruncated);
});

// The HTTP orchestrator gateway: the outbound reporting channel. These tests pin its contract
// against a fake orchestrator — beats carry a monotonic seq and the last-known phase, failures
// never escape into the caller, the ONE thing an answer may steer is a cancel, and the terminal
// report stops the beats and survives a transient blip. The boot-time helpers on the same surface are
// pinned here too: the spec fetch retries only what is transient, and the boot-failure report
// never throws.

import { test } from "bun:test";
import { serve } from "@ryph/service";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  boundSetupFailures,
  boundStaleMemories,
  fetchRunCredentials,
  fetchRunSpec,
  httpChecks,
  httpEnvironmentStatus,
  httpInbox,
  httpOrchestratorGateway,
  httpPatchReporter,
  httpSkillBundles,
  MAX_PROGRESS_MESSAGE,
  reportBootFailure,
  SETUP_FAILURE_LIMITS,
  STALE_MEMORY_LIMITS,
} from "../src/adapters/orchestrator/http.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";
import { recordingDiagnostics } from "./doubles/diagnostics.ts";
import { ChangeRequestRefused } from "../src/ports/patch_reporter.ts";
import { ChecksRefusedError, ChecksUnansweredError } from "../src/ports/checks.ts";
import type { Diagnostics } from "../src/ports/diagnostics.ts";
import type { InboundMessage, Phase, Progress, Result } from "../src/core/types.ts";
import { parseInboundMessages } from "../src/schema.ts";

const RUN_ID = "wi-hb-0001";
const TOKEN = "run-token-abc";

const progress = (phase: Phase, message?: string): Progress => ({
  workItemId: RUN_ID,
  phase,
  message,
});

const RESULT: Result = {
  status: "failure",
  reason: "no diff",
  summary: "did nothing",
  branches: [],
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `cond` holds; a test that never gets there fails here with its own message. */
async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

interface Recorded {
  path: string;
  /** The query string without its `?`; "" when there is none. */
  query: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

/** A fake orchestrator: records every request, answers with a swappable responder. */
async function fakeOrchestrator() {
  const requests: Recorded[] = [];
  let respond: () => Response | Promise<Response> = () => new Response(null, { status: 204 });
  const server = await serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      requests.push({
        path: url.pathname,
        query: url.search.replace(/^\?/, ""),
        auth: req.headers.get("authorization"),
        body: req.method === "GET" ? null : await req.json().catch(() => null),
      });
      return await respond();
    },
  );
  const addr = server.addr;
  return {
    url: `http://${addr.hostname}:${addr.port}`,
    requests,
    beats: () => requests.filter((r) => r.path.endsWith("/heartbeat")),
    results: () => requests.filter((r) => r.path.endsWith("/result")),
    setRespond: (fn: () => Response | Promise<Response>) => {
      respond = fn;
    },
    shutdown: () => server.shutdown(),
  };
}

function makeGateway(baseUrl: string, overrides: {
  heartbeatIntervalMs?: number;
  resultRetryPauseMs?: number;
  onCancelRequested?: () => void;
  diag?: Diagnostics;
} = {}) {
  return httpOrchestratorGateway({
    baseUrl,
    runToken: TOKEN,
    runId: RUN_ID,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 25,
    resultRetryPauseMs: overrides.resultRetryPauseMs ?? 20,
    onCancelRequested: overrides.onCancelRequested,
    diag: overrides.diag ?? noopDiagnostics(),
  });
}

test("orchestrator http: silent until the first progress supplies a phase", async () => {
  const server = await fakeOrchestrator();
  const gateway = makeGateway(server.url);
  try {
    await sleep(120); // ~4 intervals with no phase to report
    assertEquals(server.beats().length, 0, "no beat may fire before a phase is known");
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

test("orchestrator http: a phase transition beats immediately with the full payload", async () => {
  const server = await fakeOrchestrator();
  // A huge interval isolates the transition-triggered beats from the timer's.
  const gateway = makeGateway(server.url, { heartbeatIntervalMs: 60_000 });
  try {
    gateway.reportProgress(progress("cloning"));
    await until(() => server.beats().length >= 1, "the first transition beat");
    const first = server.beats()[0];
    assertEquals(first.auth, `Bearer ${TOKEN}`);
    assertEquals(first.body, { seq: 0, phase: "cloning" });

    await sleep(20); // lets the first beat's response settle so the next one isn't suppressed
    gateway.reportProgress(progress("setting-up", "step 1/2: install"));
    await until(() => server.beats().length >= 2, "the second transition beat");
    const second = server.beats()[1];
    assertEquals(second.body, {
      seq: 1,
      phase: "setting-up",
      message: "step 1/2: install",
    });
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

test("orchestrator http: the timer repeats the last-known phase with increasing seq", async () => {
  const server = await fakeOrchestrator();
  const gateway = makeGateway(server.url);
  try {
    gateway.reportProgress(progress("running"));
    await until(() => server.beats().length >= 4, "steady-state beats");
    const beats = server.beats();
    for (const [i, beat] of beats.entries()) {
      assertEquals(beat.body?.phase, "running", "every beat repeats the last-known phase");
      if (i > 0) {
        const prev = beats[i - 1].body?.seq as number;
        assert((beat.body?.seq as number) > prev, "seq must be strictly increasing");
      }
    }
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

test("orchestrator http: a failed beat never escapes, and the next one repairs it", async () => {
  const server = await fakeOrchestrator();
  const { diag, warns } = recordingDiagnostics();
  const gateway = makeGateway(server.url, { diag });
  try {
    server.setRespond(() => new Response("boom", { status: 500 }));
    gateway.reportProgress(progress("running")); // must return normally despite the 500s
    await until(
      () => warns.some((w) => w.event === "orchestrator.heartbeat.failed"),
      "the failure warn",
    );

    server.setRespond(() => new Response(null, { status: 204 }));
    const seen = server.beats().length;
    await until(() => server.beats().length > seen, "the repairing beat");
    const beats = server.beats();
    const last = beats[beats.length - 1].body?.seq as number;
    const first = beats[0].body?.seq as number;
    assert(last > first, "the repairing beat must carry a higher seq");
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

test("orchestrator http: an unreachable orchestrator degrades to a warn", async () => {
  const server = await fakeOrchestrator();
  await server.shutdown(); // the port is closed; every beat's fetch now rejects
  const { diag, warns } = recordingDiagnostics();
  const gateway = makeGateway(server.url, { diag });
  try {
    gateway.reportProgress(progress("running"));
    await until(
      () => warns.some((w) => w.event === "orchestrator.heartbeat.unreachable"),
      "the unreachable warn",
    );
  } finally {
    gateway.shutdown();
  }
});

test("orchestrator http: a slow orchestrator never sees overlapping beats", async () => {
  const server = await fakeOrchestrator();
  let active = 0;
  let maxActive = 0;
  server.setRespond(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(60); // several intervals long
    active--;
    return new Response(null, { status: 204 });
  });
  const gateway = makeGateway(server.url, { heartbeatIntervalMs: 15 });
  try {
    gateway.reportProgress(progress("running"));
    await until(() => server.beats().length >= 3, "beats behind a slow responder");
    assertEquals(maxActive, 1, "a beat in flight must suppress the next tick");
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

test("orchestrator http: a report made behind a slow beat is sent right after it", async () => {
  const server = await fakeOrchestrator();
  server.setRespond(async () => {
    await sleep(60);
    return new Response(null, { status: 204 });
  });
  // No tick within the test: only the reports beat.
  const gateway = makeGateway(server.url, { heartbeatIntervalMs: 60_000 });
  try {
    gateway.reportProgress(progress("running", "step 1"));
    await until(() => server.beats().length >= 1, "the first beat");
    gateway.reportProgress({ ...progress("running"), declaredOutcome: "success" });
    gateway.reportProgress({ ...progress("running"), declaredOutcome: "success", finished: true });
    await until(() => server.beats().length >= 2, "the owed beat");
    assertEquals(server.beats()[1].body?.declaredOutcome, "success");
    assertEquals(
      server.beats()[1].body?.finished,
      true,
      "the newest of the reports made meanwhile",
    );
    await sleep(150);
    assertEquals(server.beats().length, 2, "one follow-up, however many reports it carries");
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

test("orchestrator http: a terminal answer is logged, never acted on", async () => {
  const server = await fakeOrchestrator();
  const { diag, warns } = recordingDiagnostics();
  const gateway = makeGateway(server.url, { diag });
  try {
    server.setRespond(() => Response.json({ error: "run is terminal" }, { status: 409 }));
    gateway.reportProgress(progress("running"));
    await until(
      () => warns.some((w) => w.event === "orchestrator.heartbeat.terminal"),
      "the terminal warn",
    );

    // Log-only: the orchestrator's verdict does not steer this run. The beats keep flowing and
    // nothing throws — a run ends when its own work ends, or when SIGTERM arrives.
    const seen = server.beats().length;
    await until(() => server.beats().length > seen, "beats continuing after a terminal answer");
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

test("orchestrator http: reportResult delivers the Result verbatim and stops the beats", async () => {
  const server = await fakeOrchestrator();
  const gateway = makeGateway(server.url);
  try {
    gateway.reportProgress(progress("finalizing"));
    await until(() => server.beats().length >= 1, "a beat before the result");

    server.setRespond(() => Response.json({ ack: "Accepted" }));
    await gateway.reportResult(RESULT);
    assertEquals(server.results().length, 1);
    assertEquals(server.results()[0].auth, `Bearer ${TOKEN}`);
    assertEquals(server.results()[0].body, RESULT as unknown as Record<string, unknown>);

    await sleep(30); // lets any beat already in flight at stop time land before the snapshot
    const beatsAtResult = server.beats().length;
    await sleep(120); // ~4 intervals
    assertEquals(server.beats().length, beatsAtResult, "no beat may follow the terminal report");
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

test("orchestrator http: reportResult survives a transient blip via retry", async () => {
  const server = await fakeOrchestrator();
  const gateway = makeGateway(server.url, { heartbeatIntervalMs: 60_000 });
  try {
    let calls = 0;
    server.setRespond(() =>
      ++calls === 1 ? new Response("boom", { status: 500 }) : Response.json({ ack: "Accepted" })
    );
    await gateway.reportResult(RESULT); // resolves on the second attempt
    assertEquals(server.results().length, 2);
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

test("orchestrator http: reportResult rejects once every attempt is exhausted", async () => {
  const server = await fakeOrchestrator();
  const gateway = makeGateway(server.url, { heartbeatIntervalMs: 60_000 });
  try {
    server.setRespond(() => new Response("boom", { status: 500 }));
    await assertRejects(() => gateway.reportResult(RESULT));
    assertEquals(server.results().length, 3, "every attempt must have been made");
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

function fetchSpec(baseUrl: string, diag: Diagnostics = noopDiagnostics()) {
  return fetchRunSpec({ baseUrl, runToken: TOKEN, runId: RUN_ID, retryPauseMs: 10, diag });
}

test("orchestrator http: fetchRunSpec returns the body, sent with the run bearer", async () => {
  const server = await fakeOrchestrator();
  server.setRespond(() => Response.json({ workItem: { id: RUN_ID } }));
  try {
    const body = await fetchSpec(server.url);
    assertEquals(JSON.parse(body), { workItem: { id: RUN_ID } });
    assertEquals(server.requests.length, 1);
    assertEquals(server.requests[0].path, `/v1/runs/${RUN_ID}/spec`);
    assertEquals(server.requests[0].auth, `Bearer ${TOKEN}`);
  } finally {
    await server.shutdown();
  }
});

test("orchestrator http: fetchRunSpec retries a transient failure and succeeds", async () => {
  const server = await fakeOrchestrator();
  let calls = 0;
  server.setRespond(() =>
    ++calls === 1 ? new Response("boom", { status: 500 }) : Response.json({ ok: true })
  );
  try {
    const body = await fetchSpec(server.url);
    assertEquals(JSON.parse(body), { ok: true });
    assertEquals(server.requests.length, 2);
  } finally {
    await server.shutdown();
  }
});

test("orchestrator http: fetchRunSpec treats a 4xx as definitive — no retry", async () => {
  const server = await fakeOrchestrator();
  server.setRespond(() => Response.json({ error: "unauthorized" }, { status: 401 }));
  try {
    await assertRejects(() => fetchSpec(server.url), Error, "401");
    assertEquals(server.requests.length, 1, "a definitive answer must not be retried");
  } finally {
    await server.shutdown();
  }
});

test("orchestrator http: fetchRunSpec rejects once every attempt is exhausted", async () => {
  const server = await fakeOrchestrator();
  server.setRespond(() => new Response("boom", { status: 500 }));
  try {
    await assertRejects(() => fetchSpec(server.url));
    assertEquals(server.requests.length, 3, "every attempt must have been made");
  } finally {
    await server.shutdown();
  }
});

function fetchCredentials(baseUrl: string, diag: Diagnostics = noopDiagnostics()) {
  return fetchRunCredentials({ baseUrl, runToken: TOKEN, runId: RUN_ID, retryPauseMs: 10, diag });
}

test("orchestrator http: fetchRunCredentials returns the body, sent with the run bearer", async () => {
  const server = await fakeOrchestrator();
  server.setRespond(() => Response.json({ env: { ANTHROPIC_API_KEY: "ryph-vk-x" } }));
  try {
    const body = await fetchCredentials(server.url);
    assertEquals(JSON.parse(body!), { env: { ANTHROPIC_API_KEY: "ryph-vk-x" } });
    assertEquals(server.requests[0].path, `/v1/runs/${RUN_ID}/credentials`);
    assertEquals(server.requests[0].auth, `Bearer ${TOKEN}`);
  } finally {
    await server.shutdown();
  }
});

test("orchestrator http: fetchRunCredentials answers null on 404 — an orchestrator without the endpoint", async () => {
  const server = await fakeOrchestrator();
  server.setRespond(() => Response.json({ error: "not found" }, { status: 404 }));
  try {
    assertEquals(await fetchCredentials(server.url), null);
    assertEquals(server.requests.length, 1, "a missing endpoint must not be retried");
  } finally {
    await server.shutdown();
  }
});

test("orchestrator http: fetchRunCredentials treats other 4xx as definitive and 5xx as retryable", async () => {
  const denied = await fakeOrchestrator();
  denied.setRespond(() => Response.json({ error: "unauthorized" }, { status: 401 }));
  try {
    await assertRejects(() => fetchCredentials(denied.url), Error, "401");
    assertEquals(denied.requests.length, 1);
  } finally {
    await denied.shutdown();
  }

  const flaky = await fakeOrchestrator();
  let calls = 0;
  flaky.setRespond(() =>
    ++calls === 1 ? new Response("boom", { status: 503 }) : Response.json({ env: {} })
  );
  try {
    assertEquals(JSON.parse((await fetchCredentials(flaky.url))!), { env: {} });
    assertEquals(flaky.requests.length, 2);
  } finally {
    await flaky.shutdown();
  }
});

test("orchestrator http: reportBootFailure posts the error result and never throws", async () => {
  const server = await fakeOrchestrator();
  server.setRespond(() => Response.json({ ack: "Accepted" }));
  try {
    await reportBootFailure({
      baseUrl: server.url,
      runToken: TOKEN,
      runId: RUN_ID,
      reason: "the fetched run spec: workItem: expected object",
      diag: noopDiagnostics(),
    });
    assertEquals(server.results().length, 1);
    assertEquals(server.results()[0].body, {
      status: "error",
      reason: "the fetched run spec: workItem: expected object",
      during: "booting",
      branches: [],
    });

    // Best-effort: a rejected report and an unreachable orchestrator both degrade to a warn.
    const { diag, warns } = recordingDiagnostics();
    server.setRespond(() => new Response("boom", { status: 500 }));
    await reportBootFailure(
      { baseUrl: server.url, runToken: TOKEN, runId: RUN_ID, reason: "x", diag },
    );
    assert(warns.some((w) => w.event === "orchestrator.bootFailure.rejected"));
    await server.shutdown();
    await reportBootFailure(
      { baseUrl: server.url, runToken: TOKEN, runId: RUN_ID, reason: "x", diag },
    );
    assert(warns.some((w) => w.event === "orchestrator.bootFailure.unreachable"));
  } finally {
    await server.shutdown();
  }
});

test("orchestrator http: shutdown stops the beats and is idempotent", async () => {
  const server = await fakeOrchestrator();
  const gateway = makeGateway(server.url);
  try {
    gateway.reportProgress(progress("running"));
    await until(() => server.beats().length >= 1, "a beat before shutdown");
    gateway.shutdown();
    await sleep(30); // lets any beat already in flight at stop time land before the snapshot
    const seen = server.beats().length;
    await sleep(120); // ~4 intervals
    assertEquals(server.beats().length, seen, "no beat may fire after shutdown");
    gateway.shutdown(); // asking twice is asking once
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

test("orchestrator http: a beat answered with cancel asks the run to stop, once", async () => {
  // The channel that works when nothing can dial this container — which is every single-process
  // deployment, and any networked one whose control plane cannot route to the run network.
  const server = await fakeOrchestrator();
  let cancels = 0;
  const gateway = makeGateway(server.url, { onCancelRequested: () => cancels++ });
  try {
    server.setRespond(() => Response.json({ cancel: false }));
    gateway.reportProgress(progress("cloning"));
    await until(() => server.beats().length >= 1, "the first beat");
    assertEquals(cancels, 0);

    server.setRespond(() => Response.json({ cancel: true }));
    await until(() => cancels === 1, "the cancel to arrive on a beat");

    // The flag reads durable desired state, so it stays true on every later beat. Asking the
    // harness to stop once per interval would be a different bug.
    const seen = server.beats().length;
    await until(() => server.beats().length > seen + 1, "two more beats");
    assertEquals(cancels, 1);
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

test("orchestrator http: an answer with no body is not a cancel", async () => {
  // Both directions of a rolling deploy: an orchestrator that predates this answers 204, and
  // anything unparseable must read as "nothing asked for" rather than as a stop.
  const server = await fakeOrchestrator();
  let cancels = 0;
  const gateway = makeGateway(server.url, { onCancelRequested: () => cancels++ });
  try {
    server.setRespond(() => new Response(null, { status: 204 }));
    gateway.reportProgress(progress("cloning"));
    await until(() => server.beats().length >= 3, "several beats");
    assertEquals(cancels, 0);

    server.setRespond(() => new Response("not json at all", { status: 200 }));
    const seen = server.beats().length;
    await until(() => server.beats().length > seen + 1, "beats continuing past a junk answer");
    assertEquals(cancels, 0);
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

test("orchestrator http: reportStaleMemories posts the findings once and never throws", async () => {
  const orch = await fakeOrchestrator();
  const gateway = makeGateway(orch.url, { heartbeatIntervalMs: 10_000 });
  try {
    gateway.reportStaleMemories([{
      memoryId: "mem-1",
      changedPaths: ["a.ts"],
      headSha: "abc1234",
    }]);
    await until(() => orch.requests.some((r) => r.path.endsWith("/memory/stale")), "the report");
    const report = orch.requests.find((r) => r.path.endsWith("/memory/stale"))!;
    assertEquals(report.path, `/v1/runs/${RUN_ID}/memory/stale`);
    assertEquals(report.auth, `Bearer ${TOKEN}`);
    assertEquals(report.body, {
      stale: [{ memoryId: "mem-1", changedPaths: ["a.ts"], headSha: "abc1234" }],
    });

    // A refusal is a warn, not a throw.
    const { diag, warns } = recordingDiagnostics();
    const refusing = makeGateway(orch.url, { heartbeatIntervalMs: 10_000, diag });
    orch.setRespond(() => new Response("nope", { status: 500 }));
    refusing.reportStaleMemories([{ memoryId: "mem-2", changedPaths: [], headSha: null }]);
    await until(() => warns.some((w) => w.event === "orchestrator.stale.rejected"), "the warn");
    refusing.shutdown();
  } finally {
    gateway.shutdown();
    await orch.shutdown();
  }
});

test("orchestrator http: reportStaleBases posts the bases once, without their names or refs, and never throws", async () => {
  const orch = await fakeOrchestrator();
  const gateway = makeGateway(orch.url, { heartbeatIntervalMs: 10_000 });
  try {
    gateway.reportStaleBases([{
      path: "web",
      name: "acme/web",
      ref: "main",
      commit: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
      since: "2026-09-29T10:00:00.000Z",
    }]);
    await until(() => orch.requests.some((r) => r.path.endsWith("/base/stale")), "the report");
    const report = orch.requests.find((r) => r.path.endsWith("/base/stale"))!;
    assertEquals(report.path, `/v1/runs/${RUN_ID}/base/stale`);
    assertEquals(report.auth, `Bearer ${TOKEN}`);
    assertEquals(report.body, {
      bases: [{
        path: "web",
        commit: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
        since: "2026-09-29T10:00:00.000Z",
      }],
    });

    // A refusal is a warn, not a throw.
    const { diag, warns } = recordingDiagnostics();
    const refusing = makeGateway(orch.url, { heartbeatIntervalMs: 10_000, diag });
    orch.setRespond(() => new Response("nope", { status: 500 }));
    refusing.reportStaleBases([{
      path: "web",
      name: "acme/web",
      ref: "main",
      commit: "x",
      since: "y",
    }]);
    await until(
      () => warns.some((w) => w.event === "orchestrator.base_stale.rejected"),
      "the warn",
    );
    refusing.shutdown();
  } finally {
    gateway.shutdown();
    await orch.shutdown();
  }
});

test("orchestrator http: reportSetupFailures resolves once the report is answered, and never rejects", async () => {
  const orch = await fakeOrchestrator();
  const gateway = makeGateway(orch.url, { heartbeatIntervalMs: 10_000 });
  const failures = [
    {
      kind: "step" as const,
      path: "web",
      step: "install deps",
      index: 2,
      total: 3,
      code: 1,
      output: "npm ERR! nope",
      discarded: true,
    },
    { kind: "invalid" as const, path: "api", error: "setup.yml: not valid YAML: x" },
  ];
  try {
    // Awaited: by the time it resolves, the request has been answered.
    await gateway.reportSetupFailures(failures);
    const report = orch.requests.find((r) => r.path.endsWith("/setup/failed"))!;
    assertEquals(report.path, `/v1/runs/${RUN_ID}/setup/failed`);
    assertEquals(report.auth, `Bearer ${TOKEN}`);
    assertEquals(report.body, { failures });

    // A refusal is a warn, not a rejection.
    const { diag, warns } = recordingDiagnostics();
    const refusing = makeGateway(orch.url, { heartbeatIntervalMs: 10_000, diag });
    orch.setRespond(() => new Response("nope", { status: 500 }));
    await refusing.reportSetupFailures(failures);
    assert(warns.some((w) => w.event === "orchestrator.setup_failed.rejected"));
    refusing.shutdown();

    // Nobody answering is a warn too, within the request timeout.
    const { diag: deadDiag, warns: deadWarns } = recordingDiagnostics();
    const dead = makeGateway("http://127.0.0.1:9", { heartbeatIntervalMs: 10_000, diag: deadDiag });
    await dead.reportSetupFailures(failures);
    assert(deadWarns.some((w) => w.event === "orchestrator.setup_failed.unreachable"));
    dead.shutdown();
  } finally {
    gateway.shutdown();
    await orch.shutdown();
  }
});

test("orchestrator http: setup failures are held to the route's bounds before they are sent", async () => {
  const L = SETUP_FAILURE_LIMITS;
  const step = {
    kind: "step" as const,
    path: "web",
    step: "s".repeat(500),
    index: 5_000,
    total: 0,
    code: -1,
    output: "HEAD" + "o".repeat(10_000) + "TAIL",
    discarded: false,
  };
  const invalid = {
    kind: "invalid" as const,
    path: "api",
    error: "setup.yml: " + "e".repeat(10_000),
  };
  const bounded = boundSetupFailures([
    step,
    invalid,
    ...Array.from({ length: 100 }, () => invalid),
  ]);
  assertEquals(bounded.length, L.entries);
  const [s, i] = bounded;
  assert(s.kind === "step" && i.kind === "invalid");
  assertEquals(s.step.length, L.step);
  assertEquals([s.index, s.total, s.code], [L.position, 1, 0]);
  assertEquals(s.output.length, L.text);
  assert(s.output.endsWith("TAIL"), "a tail keeps its end");
  assertEquals(i.error.length, L.text);
  assert(i.error.startsWith("setup.yml: "), "an error keeps its start");
  // within bounds, untouched; an empty label still names the step
  assertEquals(boundSetupFailures([{ ...invalid, error: "x" }]), [{ ...invalid, error: "x" }]);
  const unnamed = boundSetupFailures([{ ...step, step: "", index: 2, total: 2, code: 1 }])[0];
  assert(unnamed.kind === "step");
  assertEquals(unnamed.step, "step 2");

  // and the progress message a beat carries is bounded too
  const server = await fakeOrchestrator();
  const gateway = makeGateway(server.url, { heartbeatIntervalMs: 60_000 });
  try {
    gateway.reportProgress(progress("setting-up", "m".repeat(MAX_PROGRESS_MESSAGE * 3)));
    await until(() => server.beats().length >= 1, "the beat");
    const message = server.beats()[0].body?.message as string;
    assertEquals(message.length, MAX_PROGRESS_MESSAGE + 1);
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

test("orchestrator http: the idle deadline rides every beat once reported, and never blanks the message", async () => {
  const server = await fakeOrchestrator();
  const gateway = makeGateway(server.url, { heartbeatIntervalMs: 60_000 });
  try {
    gateway.reportProgress(progress("running", "step 1"));
    await until(() => server.beats().length >= 1, "the first beat");
    assertEquals(
      "idleDeadlineAt" in server.beats()[0].body!,
      false,
      "a beat before the first report has none",
    );

    await sleep(20);
    gateway.reportProgress({
      ...progress("running"),
      idleDeadlineAt: "2026-09-15T00:05:00.000Z",
      idleState: "waiting-for-user",
    });
    await until(() => server.beats().length >= 2, "the deadline beat");
    assertEquals(server.beats()[1].body, {
      seq: 1,
      phase: "running",
      message: "step 1",
      idleDeadlineAt: "2026-09-15T00:05:00.000Z",
      idleState: "waiting-for-user",
    });

    await sleep(20);
    gateway.reportProgress({ ...progress("running"), idleDeadlineAt: null });
    await until(() => server.beats().length >= 3, "the cleared beat");
    assertEquals(server.beats()[2].body?.idleDeadlineAt, null);
    assertEquals(server.beats()[2].body?.idleState, null);
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

test("orchestrator http: the declared outcome rides every beat once reported, a clear too, and never blanks the message", async () => {
  const server = await fakeOrchestrator();
  const gateway = makeGateway(server.url, { heartbeatIntervalMs: 60_000 });
  try {
    gateway.reportProgress(progress("running", "step 1"));
    await until(() => server.beats().length >= 1, "the first beat");
    assertEquals("declaredOutcome" in server.beats()[0].body!, false);

    await sleep(20);
    gateway.reportProgress({ ...progress("running"), declaredOutcome: "success" });
    await until(() => server.beats().length >= 2, "the outcome beat");
    assertEquals(server.beats()[1].body?.declaredOutcome, "success");
    assertEquals(server.beats()[1].body?.message, "step 1");

    await sleep(20);
    gateway.reportProgress({ ...progress("running"), idleDeadlineAt: null });
    await until(() => server.beats().length >= 3, "a later beat");
    assertEquals(server.beats()[2].body?.declaredOutcome, "success", "sticky");
    assertEquals("finished" in server.beats()[2].body!, false, "a report is no finish");

    await sleep(20);
    gateway.reportProgress({ ...progress("running"), declaredOutcome: null });
    await until(() => server.beats().length >= 4, "the clearing beat");
    assertEquals(server.beats()[3].body?.declaredOutcome, null, "a clear is said outright");
    assertEquals(server.beats()[3].body?.message, "step 1");

    await sleep(20);
    gateway.reportProgress({ ...progress("running"), idleDeadlineAt: null });
    await until(() => server.beats().length >= 5, "a beat after the clear");
    assertEquals(server.beats()[4].body?.declaredOutcome, null, "the clear is sticky too");

    await sleep(20);
    gateway.reportProgress({ ...progress("running"), declaredOutcome: "success", finished: true });
    await until(() => server.beats().length >= 6, "the finish beat");
    assertEquals(server.beats()[5].body?.declaredOutcome, "success");
    assertEquals(server.beats()[5].body?.finished, true);

    await sleep(20);
    gateway.reportProgress({ ...progress("running"), declaredOutcome: null });
    await until(() => server.beats().length >= 7, "a clear after the finish");
    assertEquals(server.beats()[6].body?.finished, true, "a finish is sticky, whatever clears");
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

test("orchestrator http: a control plane that 400s in-progress hears null at once, and every final outcome after", async () => {
  const server = await fakeOrchestrator();
  const { diag, warns } = recordingDiagnostics();
  const gateway = makeGateway(server.url, { heartbeatIntervalMs: 60_000, diag });
  // One that predates the outcome: its schema refuses any beat that carries it.
  server.setRespond(() =>
    server.requests.at(-1)?.body?.declaredOutcome === "in-progress"
      ? new Response("invalid declaredOutcome", { status: 400 })
      : new Response(null, { status: 204 })
  );
  try {
    gateway.reportProgress(progress("running", "step 1"));
    await until(() => server.beats().length >= 1, "the first beat");

    await sleep(20);
    gateway.reportProgress({ ...progress("running"), declaredOutcome: "in-progress" });
    // The refused beat, then at once — not a minute later, on the timer — the one it can read.
    await until(() => server.beats().length >= 3, "the re-beat after the refusal");
    assertEquals(server.beats()[1].body?.declaredOutcome, "in-progress", "tried as it is first");
    assertEquals(server.beats()[2].body?.declaredOutcome, null, "then said as not done");
    assertEquals(server.beats()[2].body?.message, "step 1");
    assert((server.beats()[2].body?.seq as number) > (server.beats()[1].body?.seq as number));
    assert(warns.some((w) => w.event === "orchestrator.heartbeat.in_progress_refused"));

    // Later beats carry the null too: the outcome is sticky, the refusal with it.
    await sleep(20);
    gateway.reportProgress({ ...progress("running"), idleDeadlineAt: null });
    await until(() => server.beats().length >= 4, "a later beat");
    assertEquals(server.beats()[3].body?.declaredOutcome, null);

    // A final outcome goes through as it is.
    await sleep(20);
    gateway.reportProgress({ ...progress("running"), declaredOutcome: "success" });
    await until(() => server.beats().length >= 5, "the success beat");
    assertEquals(server.beats()[4].body?.declaredOutcome, "success");

    // ...and a later in-progress is said as null straight away, never refused again.
    await sleep(20);
    gateway.reportProgress({ ...progress("running"), declaredOutcome: "in-progress" });
    await until(() => server.beats().length >= 6, "the second in-progress beat");
    assertEquals(server.beats()[5].body?.declaredOutcome, null);
    await sleep(50);
    assertEquals(server.beats().length, 6, "no refusal, so no re-beat");
    assertEquals(
      server.beats().filter((b) => b.body?.declaredOutcome === "in-progress").length,
      1,
      "only the first beat carried it",
    );
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

test("orchestrator http: a control plane that 400s every beat is not taken to refuse in-progress", async () => {
  const server = await fakeOrchestrator();
  const { diag } = recordingDiagnostics();
  const gateway = makeGateway(server.url, { heartbeatIntervalMs: 60_000, diag });
  try {
    gateway.reportProgress(progress("running", "step 1"));
    await until(() => server.beats().length >= 1, "the first beat");

    // Every beat refused, whatever it says (a message too long, say): not about the outcome.
    server.setRespond(() => new Response("message too long", { status: 400 }));
    await sleep(20);
    gateway.reportProgress({ ...progress("running"), declaredOutcome: "in-progress" });
    // The refusal is suspected, and the next beat tries null at once...
    await until(() => server.beats().length >= 3, "the probe after the refusal");
    assertEquals(server.beats()[1].body?.declaredOutcome, "in-progress");
    assertEquals(server.beats()[2].body?.declaredOutcome, null, "the probe");
    // ...which is refused too: the 400 was about something else, so in-progress goes back on.
    await sleep(50);
    assertEquals(server.beats().length, 3, "a refused probe owes no further beat");
    await sleep(20);
    gateway.reportProgress({ ...progress("running"), idleDeadlineAt: null });
    await until(() => server.beats().length >= 4, "a later beat");
    assertEquals(server.beats()[3].body?.declaredOutcome, "in-progress", "back on");
    // Refused again, it is suspected again: one probe more, refused, and nothing after it.
    await until(() => server.beats().length >= 5, "its probe");
    await sleep(50);
    assertEquals(server.beats().length, 5);
    assertEquals(server.beats()[4].body?.declaredOutcome, null);

    // Once the control plane takes beats again, they carry in-progress as reported.
    server.setRespond(() => new Response(null, { status: 204 }));
    const seen = server.beats().length;
    await sleep(20);
    gateway.reportProgress({ ...progress("running"), idleDeadlineAt: null });
    await until(() => server.beats().length > seen, "a beat taken");
    await sleep(50);
    assertEquals(server.beats().at(-1)?.body?.declaredOutcome, "in-progress");
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

test("orchestrator http: a refusal for any other reason changes nothing a beat carries", async () => {
  const server = await fakeOrchestrator();
  const { diag, warns } = recordingDiagnostics();
  const gateway = makeGateway(server.url, { heartbeatIntervalMs: 60_000, diag });
  try {
    gateway.reportProgress(progress("running", "step 1"));
    await until(() => server.beats().length >= 1, "the first beat");

    // A 400 to a beat with a final outcome: no re-beat, and in-progress is still sent as it is.
    server.setRespond(() => new Response("bad", { status: 400 }));
    await sleep(20);
    gateway.reportProgress({ ...progress("running"), declaredOutcome: "success" });
    await until(() => server.beats().length >= 2, "the refused success beat");
    await sleep(50);
    assertEquals(server.beats().length, 2, "no re-beat for a 400 that is not about in-progress");

    // A 500 to an in-progress beat is the control plane failing, not refusing the outcome.
    server.setRespond(() => new Response("boom", { status: 500 }));
    await sleep(20);
    gateway.reportProgress({ ...progress("running"), declaredOutcome: "in-progress" });
    await until(() => server.beats().length >= 3, "the in-progress beat");
    assertEquals(server.beats()[2].body?.declaredOutcome, "in-progress");
    await sleep(50);
    assertEquals(server.beats().length, 3, "no re-beat for a 500");

    server.setRespond(() => new Response(null, { status: 204 }));
    await sleep(20);
    gateway.reportProgress({ ...progress("running"), idleDeadlineAt: null });
    await until(() => server.beats().length >= 4, "a later beat");
    assertEquals(server.beats()[3].body?.declaredOutcome, "in-progress", "still as reported");
    assert(!warns.some((w) => w.event === "orchestrator.heartbeat.in_progress_refused"));
  } finally {
    gateway.shutdown();
    await server.shutdown();
  }
});

test("orchestrator http: the inbox polls with the cursor and the wait, and answers the messages", async () => {
  const server = await fakeOrchestrator();
  const message: InboundMessage = {
    seq: 3,
    kind: "user",
    sender: { kind: "user", userId: "u-1" },
    text: "look at the cache",
    payload: null,
    attachments: [],
    createdAt: "2026-09-15T00:00:00.000Z",
  };
  server.setRespond(() => Response.json({ messages: [message] }));
  const inbox = httpInbox({
    baseUrl: server.url,
    runToken: TOKEN,
    runId: RUN_ID,
    diag: noopDiagnostics(),
  });
  try {
    const got = await inbox.poll(2, { waitMs: 25_000, signal: new AbortController().signal });
    assertEquals(got, [message]);
    const req = server.requests.find((r) => r.path.endsWith("/messages"))!;
    assertEquals(req.auth, `Bearer ${TOKEN}`);
    assertEquals(req.query, "after=2&wait=25");

    // a malformed answer, a refusal, and an unreachable orchestrator all throw — the core
    // pauses and asks again
    server.setRespond(() => Response.json({ messages: [{ seq: "x" }] }));
    await assertRejects(
      () => inbox.poll(2, { waitMs: 1_000, signal: new AbortController().signal }),
      Error,
      "malformed",
    );
    server.setRespond(() => Response.json({ error: "run is terminal" }, { status: 409 }));
    await assertRejects(
      () => inbox.poll(2, { waitMs: 1_000, signal: new AbortController().signal }),
      Error,
      "409",
    );

    // the caller's own abort answers nothing, never throws — the hold is the server's, and the
    // run walking away from it is the ordinary end of a poll
    server.setRespond(() =>
      new Promise((resolve) => setTimeout(() => resolve(new Response(null, { status: 204 })), 300))
    );
    const ctrl = new AbortController();
    const pending = inbox.poll(2, { waitMs: 5_000, signal: ctrl.signal });
    await sleep(20);
    ctrl.abort();
    assertEquals(await pending, []);
    await sleep(320); // let the held answer land before the server is shut down
  } finally {
    await server.shutdown();
  }
});

test("orchestrator http: a patch report posts the branch and answers the patch, or throws", async () => {
  const server = await fakeOrchestrator();
  server.setRespond(() => Response.json({ patchId: "p-1", state: "queued" }, { status: 201 }));
  const reporter = httpPatchReporter({
    baseUrl: server.url,
    runToken: TOKEN,
    runId: RUN_ID,
    diag: noopDiagnostics(),
  });
  const report = {
    branch: {
      connectedRepoId: "cr-1",
      path: "repo",
      line: "work",
      name: "ryph/ada/r-1/work",
      headSha: "abc1234",
      commits: [{ sha: "abc1234", subject: "fix" }],
      generation: 1,
      carries: [],
    },
    baseSha: "0000000",
    title: "Fix",
  };
  try {
    // A control plane a version behind names no page: the answer has no link.
    assertEquals(await reporter.reportPatch(report), {
      patchId: "p-1",
      state: "queued",
      url: null,
      forgeUrl: null,
      forgeRef: null,
    });
    const req = server.requests.find((r) => r.path.endsWith("/patches"))!;
    assertEquals(req.path, `/v1/runs/${RUN_ID}/patches`);
    assertEquals(req.auth, `Bearer ${TOKEN}`);
    assertEquals(req.body, report);

    const finalReport = { ...report, requiresApproval: true };
    await reporter.reportPatch(finalReport);
    assertEquals(server.requests.at(-1)!.body, finalReport);

    // The patch's page, where a person approves it, crosses as it was named.
    server.setRespond(() =>
      Response.json({
        patchId: "p-2",
        state: "pending_approval",
        url: "https://ryph.example/patches/p-2",
        forgeUrl: "https://github.com/acme/app/pull/7",
        forgeRef: "7",
      }, { status: 201 })
    );
    assertEquals(await reporter.reportPatch(report), {
      patchId: "p-2",
      state: "pending_approval",
      url: "https://ryph.example/patches/p-2",
      forgeUrl: "https://github.com/acme/app/pull/7",
      forgeRef: "7",
    });
    // Anything that is not a web address is no link at all.
    server.setRespond(() =>
      Response.json({ patchId: "p-3", state: "queued", url: "javascript:alert(1)" })
    );
    assertEquals((await reporter.reportPatch(report)).url, null);
    for (const forgeUrl of [null, 42, "javascript:alert(1)", ""]) {
      server.setRespond(() =>
        Response.json({ patchId: "p-3", state: "queued", forgeUrl, forgeRef: "7" })
      );
      const answer = await reporter.reportPatch(report);
      assertEquals([answer.forgeUrl, answer.forgeRef], [null, "7"]);
    }

    for (const forgeRef of [null, 42, ""]) {
      server.setRespond(() => Response.json({ patchId: "p-3", state: "queued", forgeRef }));
      assertEquals((await reporter.reportPatch(report)).forgeRef, null);
    }
    server.setRespond(() => Response.json({ error: "run is terminal" }, { status: 409 }));
    await assertRejects(() => reporter.reportPatch(report), Error, "run is terminal");
    server.setRespond(() => Response.json({ nope: true }));
    await assertRejects(() => reporter.reportPatch(report), Error, "malformed");
  } finally {
    await server.shutdown();
  }
});

test("orchestrator http: a claim posts the repo and the change request, and refusals come back as their reason", async () => {
  const server = await fakeOrchestrator();
  const claim = {
    connectedRepoId: "cr-1",
    thread: "42",
    ref: "feature/x",
    headSha: "abc1234",
    url: "https://gh/x/pull/42",
  };
  server.setRespond(() => Response.json(claim));
  const reporter = httpPatchReporter({
    baseUrl: server.url,
    runToken: TOKEN,
    runId: RUN_ID,
    diag: noopDiagnostics(),
  });
  try {
    assertEquals(
      await reporter.claimChangeRequest({ path: "repo", changeRequest: "42" }),
      claim,
    );
    const req = server.requests.at(-1)!;
    assertEquals(req.path, `/v1/runs/${RUN_ID}/target`);
    assertEquals(req.auth, `Bearer ${TOKEN}`);
    assertEquals(req.body, { path: "repo", changeRequest: "42" });

    // The control plane writes its refusals for the agent, so they are passed on as they came —
    // and a 4xx is a DECISION: it is the one answer that means nothing was recorded.
    server.setRespond(() =>
      Response.json({ error: "run wi-other is already working #42" }, { status: 409 })
    );
    const refusal = await assertRejects(
      () => reporter.claimChangeRequest({ path: "repo", changeRequest: "42" }),
      ChangeRequestRefused,
      "run wi-other is already working #42",
    );
    assertEquals(refusal.status, 409);

    // A 5xx that says it wrote nothing IS a decision: the control plane gave up before touching
    // the task, and its own words are what the agent should read.
    server.setRespond(() =>
      Response.json({
        error: "the forge could not be asked about #42 — try again",
        recorded: false,
      }, { status: 503 })
    );
    const decided = await assertRejects(
      () => reporter.claimChangeRequest({ path: "repo", changeRequest: "42" }),
      ChangeRequestRefused,
      "the forge could not be asked about #42 — try again",
    );
    assertEquals(decided.status, 503);

    // A 5xx or an unreadable 2xx is NOT a refusal: the task may have been re-targeted with only
    // the answer lost, so these stay ordinary failures and the caller says the claim is unsure.
    server.setRespond(() => new Response(null, { status: 503 }));
    const unsure = await assertRejects(
      () => reporter.claimChangeRequest({ path: "repo", changeRequest: "42" }),
      Error,
      "answered 503",
    );
    assert(!(unsure instanceof ChangeRequestRefused));
    server.setRespond(() => Response.json({ thread: "42" }));
    const malformed = await assertRejects(
      () => reporter.claimChangeRequest({ path: "repo", changeRequest: "42" }),
      Error,
      "malformed",
    );
    assert(!(malformed instanceof ChangeRequestRefused));
  } finally {
    await server.shutdown();
  }
});

test("orchestrator http: an environment payload rides the inbox; an unknown kind reads as none", async () => {
  const server = await fakeOrchestrator();
  const message: InboundMessage = {
    seq: 4,
    kind: "system",
    sender: { kind: "platform" },
    text: "The platform built the environment for your patch p-1: the build SUCCEEDED.",
    payload: {
      kind: "environment",
      patchId: "p-1",
      path: "repo",
      headSha: "abc1234",
      environmentId: "env-1",
      status: "ready",
    },
    attachments: [],
    createdAt: "2026-09-19T00:00:00.000Z",
  };
  server.setRespond(() => Response.json({ messages: [message] }));
  const inbox = httpInbox({
    baseUrl: server.url,
    runToken: TOKEN,
    runId: RUN_ID,
    diag: noopDiagnostics(),
  });
  try {
    assertEquals(await inbox.poll(3, { waitMs: 0, signal: new AbortController().signal }), [
      message,
    ]);
    // A control plane a version ahead posts a kind this runner does not know: the message still
    // arrives, by its text, instead of wedging the whole inbox as malformed.
    server.setRespond(() =>
      Response.json({
        messages: [{ ...message, payload: { ...message.payload, kind: "weather" } }],
      })
    );
    assertEquals(await inbox.poll(3, { waitMs: 0, signal: new AbortController().signal }), [
      { ...message, payload: null },
    ]);
    // A known kind that does not hold to its schema loses its payload, not the message: one bad
    // message never fails the batch it came in.
    server.setRespond(() =>
      Response.json({
        messages: [{ ...message, payload: { ...message.payload, path: "../x" } }],
      })
    );
    assertEquals(await inbox.poll(3, { waitMs: 0, signal: new AbortController().signal }), [
      { ...message, payload: null },
    ]);
  } finally {
    await server.shutdown();
  }
});

test("orchestrator http: environment status reads the control plane's text with the run bearer, or throws", async () => {
  const server = await fakeOrchestrator();
  server.setRespond(() => Response.json({ text: "Environment builds for this run's patches" }));
  const status = httpEnvironmentStatus({
    baseUrl: server.url,
    runToken: TOKEN,
    runId: RUN_ID,
    diag: noopDiagnostics(),
  });
  try {
    assertEquals(await status.read(), "Environment builds for this run's patches");
    const req = server.requests.find((r) => r.path.endsWith("/environment"))!;
    assertEquals(req.path, `/v1/runs/${RUN_ID}/environment`);
    assertEquals(req.auth, `Bearer ${TOKEN}`);

    server.setRespond(() => Response.json({ error: "run is terminal" }, { status: 409 }));
    await assertRejects(() => status.read(), Error, "run is terminal");
    server.setRespond(() => Response.json({ builds: [] }));
    await assertRejects(() => status.read(), Error, "malformed");
    // bounded, whatever the control plane sends
    server.setRespond(() => Response.json({ text: "x".repeat(100_000) }));
    assertEquals((await status.read()).length, 32 * 1024);
  } finally {
    await server.shutdown();
  }
});

test("orchestrator http: a skill bundle is fetched by digest with the run bearer, null on 404, a 5xx retried, or throws", async () => {
  const server = await fakeOrchestrator();
  const digest = `sha256:${"a".repeat(64)}`;
  const files = [{ path: "SKILL.md", executable: false, content: "YWJj" }];
  server.setRespond(() => Response.json({ files }));
  const bundles = httpSkillBundles({
    baseUrl: server.url,
    runToken: TOKEN,
    runId: RUN_ID,
    diag: noopDiagnostics(),
    retryPauseMs: 0,
  });
  const signal = new AbortController().signal;
  try {
    assertEquals(await bundles.fetch(digest, signal), { files });
    const req = server.requests.at(-1)!;
    assertEquals(req.path, `/v1/runs/${RUN_ID}/skills/${digest}`);
    assertEquals(req.auth, `Bearer ${TOKEN}`);

    server.setRespond(() => Response.json({ error: "no such skill" }, { status: 404 }));
    assertEquals(await bundles.fetch(digest, signal), null);
    // One stray 503 from the balancer costs nothing: the next attempt answers.
    let answers = 0;
    server.setRespond(() =>
      answers++ === 0 ? Response.json({ error: "down" }, { status: 503 }) : Response.json({ files })
    );
    assertEquals(await bundles.fetch(digest, signal), { files });
    assertEquals(answers, 2);
    // Only a 5xx on every attempt rejects; a 4xx is definitive at once.
    answers = 0;
    server.setRespond(() => {
      answers++;
      return Response.json({ error: "down" }, { status: 503 });
    });
    await assertRejects(() => bundles.fetch(digest, signal), Error, "503");
    assertEquals(answers, 3);
    answers = 0;
    server.setRespond(() => {
      answers++;
      return Response.json({ error: "no" }, { status: 403 });
    });
    await assertRejects(() => bundles.fetch(digest, signal), Error, "403");
    assertEquals(answers, 1);
    // A path that would leave the skill's directory never gets past the schema.
    server.setRespond(() =>
      Response.json({ files: [{ path: "../../etc/x", executable: false, content: "" }] })
    );
    await assertRejects(() => bundles.fetch(digest, signal), Error, "malformed");
  } finally {
    await server.shutdown();
  }
});

test("orchestrator http: reportSkills posts the report once and never throws", async () => {
  const orch = await fakeOrchestrator();
  const { diag, warns } = recordingDiagnostics();
  const gateway = makeGateway(orch.url, { heartbeatIntervalMs: 10_000, diag });
  try {
    const report = {
      root: "/tmp/ryph-skills-3f9a",
      loaded: [],
      dropped: [{
        source: "catalogue" as const,
        name: "ryph-checks",
        reason: "unavailable" as const,
        detail: "HTTP 503",
      }],
    };
    gateway.reportSkills(report);
    await until(() => orch.requests.some((r) => r.path.endsWith("/skills/report")), "the report");
    const sent = orch.requests.find((r) => r.path.endsWith("/skills/report"))!;
    assertEquals(sent.path, `/v1/runs/${RUN_ID}/skills/report`);
    assertEquals(sent.auth, `Bearer ${TOKEN}`);
    assertEquals(sent.body, report);

    orch.setRespond(() => new Response("nope", { status: 500 }));
    gateway.reportSkills(report);
    await until(() => warns.some((w) => w.event === "orchestrator.skills.rejected"), "the warn");
  } finally {
    gateway.shutdown();
    await orch.shutdown();
  }
});

test("orchestrator http: checks requests and status carry the run bearer, hand on the text, and throw the control plane's reason", async () => {
  const server = await fakeOrchestrator();
  const checks = httpChecks({
    baseUrl: server.url,
    runToken: TOKEN,
    runId: RUN_ID,
    diag: noopDiagnostics(),
  });
  const ask = {
    path: "repo",
    headSha: "a".repeat(40),
    branch: "runner/ada/wi-1",
    baseSha: "b".repeat(40),
  };
  try {
    server.setRespond(() =>
      Response.json(
        { suiteId: "cs-1", state: "queued", reused: false, text: "Suite cs-1 queued." },
        { status: 202 },
      )
    );
    assertEquals(await checks.request(ask), { requested: true, text: "Suite cs-1 queued." });
    const post = server.requests.find((r) => r.path.endsWith("/checks"))!;
    assertEquals(post.path, `/v1/runs/${RUN_ID}/checks`);
    assertEquals(post.auth, `Bearer ${TOKEN}`);
    assertEquals(post.body, ask);

    // nothing to run is a 200 with the reason in the text
    server.setRespond(() =>
      Response.json({ suiteId: null, state: null, reused: false, text: "No checks here." })
    );
    assertEquals(await checks.request(ask), { requested: false, text: "No checks here." });

    // refusals are the control plane's own words
    for (const status of [400, 409, 429]) {
      server.setRespond(() => Response.json({ error: `refused ${status}` }, { status }));
      await assertRejects(() => checks.request(ask), Error, `refused ${status}`);
    }
    server.setRespond(() => new Response("gateway down", { status: 502 }));
    await assertRejects(() => checks.request(ask), Error, "answered 502");
    server.setRespond(() => Response.json({ suiteId: "cs-1" }, { status: 202 }));
    await assertRejects(() => checks.request(ask), Error, "malformed");

    server.setRespond(() => Response.json({ text: "x".repeat(100_000) }));
    assertEquals((await checks.status()).length, 32 * 1024);
    const get = server.requests.findLast((r) => r.path.endsWith("/checks"))!;
    assertEquals(get.body, null);
    assertEquals(get.auth, `Bearer ${TOKEN}`);
    server.setRespond(() => Response.json({ error: "run is terminal" }, { status: 409 }));
    await assertRejects(() => checks.status(), Error, "run is terminal");

    // which verdicts are still owed, for the runner alone, asked for on its own
    const owed = [
      { id: "cs-1@2", requests: ["cq-1", "cq-2"] },
      { id: "cq-3", requests: ["cq-3"] },
    ];
    server.setRespond(() => Response.json({ owed }));
    assertEquals(await checks.awaiting(), owed);
    const count = server.requests.at(-1)!;
    assertEquals(count.path, `/v1/runs/${RUN_ID}/checks`);
    assertEquals(count.query, "awaiting=1");
    server.setRespond(() => Response.json({ owed: [] }));
    assertEquals(await checks.awaiting(), []);
    for (
      const bad of [
        undefined,
        2,
        [{ id: "cs-1@1" }],
        [{ id: "", requests: [] }],
        [{ id: "cs-1@1", requests: [3] }],
        ["cs-1@1"],
      ]
    ) {
      server.setRespond(() => Response.json({ text: "?", awaiting: 1, owed: bad }));
      await assertRejects(() => checks.awaiting(), Error, "malformed");
    }
    server.setRespond(() => Response.json({ error: "run is terminal" }, { status: 409 }));
    await assertRejects(() => checks.awaiting(), Error, "run is terminal");

    // what each repo declares, from its own route
    const declared = [{
      path: "repo",
      repoRef: "acme/repo",
      checksRef: "main",
      setup: [],
      checks: [{ name: "lint", run: "npm run lint", timeoutSeconds: 600, services: [] }],
    }];
    server.setRespond(() => Response.json({ declared, unread: ["web"] }));
    assertEquals(await checks.declared(), { declared, unread: ["web"] });
    const listed = server.requests.at(-1)!;
    assertEquals(listed.path, `/v1/runs/${RUN_ID}/checks/declared`);
    assertEquals(listed.auth, `Bearer ${TOKEN}`);
    // the whole read failed
    server.setRespond(() => Response.json({ declared: [], unread: ["*"] }));
    assertEquals(await checks.declared(), { declared: [], unread: ["*"] });
    server.setRespond(() => Response.json({ declared: [{ path: "repo" }], unread: [] }));
    await assertRejects(() => checks.declared(), Error, "malformed");
    // what could not be read is part of the answer: without it, a failed read would look like
    // no checks
    server.setRespond(() => Response.json({ declared }));
    await assertRejects(() => checks.declared(), Error, "malformed");
    server.setRespond(() => Response.json({ declared, unread: ["../etc"] }));
    await assertRejects(() => checks.declared(), Error, "malformed");
    server.setRespond(() => new Response("slow forge", { status: 504 }));
    await assertRejects(() => checks.declared(), Error, "answered 504");
  } finally {
    await server.shutdown();
  }
});

test("orchestrator http: a checks request with no answer in time is unanswered, not refused", async () => {
  const server = await fakeOrchestrator();
  const checks = httpChecks({
    baseUrl: server.url,
    runToken: TOKEN,
    runId: RUN_ID,
    diag: noopDiagnostics(),
    checksTimeoutMs: 50,
  });
  try {
    server.setRespond(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return Response.json({ text: "late" }, { status: 202 });
    });
    await assertRejects(
      () =>
        checks.request({
          path: "repo",
          headSha: "a".repeat(40),
          branch: "runner/ada/wi-1",
          baseSha: "b".repeat(40),
        }),
      ChecksUnansweredError,
    );
  } finally {
    await server.shutdown();
  }
});

test("orchestrator http: a checks answer whose body outlasts the deadline is unanswered, not malformed", async () => {
  const server = await fakeOrchestrator();
  const checks = httpChecks({
    baseUrl: server.url,
    runToken: TOKEN,
    runId: RUN_ID,
    diag: noopDiagnostics(),
    checksTimeoutMs: 100,
  });
  try {
    // The 202 and its headers arrive at once; the body only after the deadline.
    let timer: ReturnType<typeof setTimeout> | undefined;
    server.setRespond(() =>
      new Response(
        new ReadableStream({
          start(controller) {
            timer = setTimeout(() => {
              controller.enqueue(new TextEncoder().encode(JSON.stringify({ text: "late" })));
              controller.close();
            }, 400);
          },
          cancel() {
            clearTimeout(timer);
          },
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      )
    );
    await assertRejects(
      () =>
        checks.request({
          path: "repo",
          headSha: "a".repeat(40),
          branch: "runner/ada/wi-1",
          baseSha: "b".repeat(40),
        }),
      ChecksUnansweredError,
    );
    clearTimeout(timer);
  } finally {
    await server.shutdown();
  }
});

test("orchestrator http: one bad message never fails the batch; a bad onto falls back, a bad payload goes", () => {
  const cue = {
    seq: 1,
    kind: "system",
    sender: { kind: "platform" },
    text: "Your patch for `repo` merged.",
    payload: {
      kind: "patch",
      line: "work",
      patchId: "p-1",
      path: "repo",
      headSha: "abc1234",
      generation: 1,
      state: "merged",
      landedHead: "abc1234",
      forgeUrl: null,
      reason: null,
      onto: "main",
    },
    createdAt: "2026-09-19T00:00:00.000Z",
  };
  const parsed = parseInboundMessages({
    messages: [
      cue,
      // An onto no checkout can stand on: the cue still moves the shipper, by the inferred path.
      { ...cue, seq: 2, payload: { ...cue.payload, onto: "-oops" } },
      // A state this runner does not know (a control plane a version ahead): text only.
      { ...cue, seq: 3, payload: { ...cue.payload, state: "parked" } },
      // Not a message at all, but placed: the cursor moves past it.
      // Its one valid image goes with the text it cannot read, and that is said too.
      { seq: 4, kind: "nonsense", attachments: [{ id: "img-4", mime: "image/png" }] },
      // A sender a newer control plane speaks: its text kept, as from a sender not named.
      { ...cue, seq: 5, kind: "page", sender: { kind: "pager", id: "x" }, payload: null },
      // One bad image among good ones: the bad one goes, the message and the rest stay.
      {
        ...cue,
        seq: 6,
        attachments: [{ id: "img-1", mime: "image/png" }, { id: "../x", mime: "image/svg" }],
      },
    ],
  });
  assert(parsed.ok);
  assertEquals(parsed.messages.map((m) => m.seq), [1, 2, 3, 4, 5, 6]);
  assertEquals(parsed.messages[5].attachments, [{ id: "img-1", mime: "image/png" }]);
  assertEquals(parsed.messages[5].payload?.kind, "patch");
  assertEquals(parsed.messages[3].attachments, []);
  assertEquals([parsed.messages[4].kind, parsed.messages[4].sender], ["system", {
    kind: "unidentified",
  }]);
  assertEquals(parsed.messages[4].text, cue.text);
  assertEquals(parsed.messages[3].text, "A message arrived that this runner could not read.");
  // Never the platform's word, so a verdict hold never takes the placeholder as its turn.
  assertEquals(parsed.messages[3].sender, { kind: "unidentified" });
  assertEquals((parsed.messages[0].payload as { onto?: string }).onto, "main");
  assertEquals(parsed.messages[1].payload?.kind, "patch");
  assertEquals("onto" in (parsed.messages[1].payload ?? {}), false);
  assertEquals(parsed.messages[2].payload, null);
  assertEquals(parsed.messages[2].text, cue.text);
  assertEquals(parsed.degraded.map((d) => [d.seq, d.what]), [
    [2, "onto"],
    [3, "payload"],
    [4, "attachments"],
    [4, "message"],
    [5, "message"],
    [6, "attachments"],
  ]);
  // Without a seq nothing can be placed: that one is malformed.
  assertEquals(parseInboundMessages({ messages: [{ kind: "nonsense" }] }).ok, false);
});

test("orchestrator http: a status names the commits it asks about, and a log comes back as bytes or the platform's no", async () => {
  const server = await fakeOrchestrator();
  const checks = httpChecks({
    baseUrl: server.url,
    runToken: TOKEN,
    runId: RUN_ID,
    diag: noopDiagnostics(),
  });
  try {
    server.setRespond(() => Response.json({ text: "Checks on repo." }));
    await checks.status({
      commits: [{ path: "repo", commit: "a".repeat(40) }, { path: "a:b", commit: "b".repeat(40) }],
      named: false,
    });
    const status = server.requests.at(-1)!;
    assertEquals(
      new URLSearchParams(status.query).getAll("at"),
      [`${"a".repeat(40)}:repo`, `${"b".repeat(40)}:a:b`],
    );
    assertEquals(new URLSearchParams(status.query).get("named"), null);
    await checks.status({ commits: [{ path: "repo", commit: "a".repeat(40) }], named: true });
    assertEquals(new URLSearchParams(server.requests.at(-1)!.query).get("named"), "1");

    server.setRespond(() =>
      new Response("line 1\nline 2\n", { headers: { "x-ryph-check-generation": "3" } })
    );
    const log = await checks.log({ suiteId: "cs-0123456789", check: "test", generation: 3 });
    assertEquals(new TextDecoder().decode(log.bytes), "line 1\nline 2\n");
    assertEquals(log.generation, 3);
    const asked = server.requests.at(-1)!;
    assertEquals(asked.path, `/v1/runs/${RUN_ID}/checks/cs-0123456789/log`);
    assertEquals(asked.query, "check=test&generation=3");
    assertEquals(asked.auth, `Bearer ${TOKEN}`);

    server.setRespond(() => Response.json({ error: "no such suite" }, { status: 404 }));
    await assertRejects(
      () => checks.log({ suiteId: "cs-0123456789", check: "test" }),
      ChecksRefusedError,
      "no such suite",
    );
    server.setRespond(() => new Response("bad gateway", { status: 502 }));
    const down = await checks.log({ suiteId: "cs-0123456789", check: "test" }).catch((e) => e);
    assert(down instanceof Error && !(down instanceof ChecksRefusedError));
    server.setRespond(() => new Response("no generation"));
    await assertRejects(
      () => checks.log({ suiteId: "cs-0123456789", check: "test" }),
      Error,
      "malformed",
    );
  } finally {
    await server.shutdown();
  }
});

test("orchestrator http: a dirty report's file list is held to the route's bounds", () => {
  const L = SETUP_FAILURE_LIMITS;
  const [d] = boundSetupFailures([{
    kind: "dirty",
    path: "web",
    files: ["f".repeat(500), ...Array.from({ length: 100 }, (_, i) => `file-${i}`)],
  }]);
  assert(d.kind === "dirty");
  assertEquals(d.files.length, L.entries);
  assertEquals(d.files[0].length, L.step);
});

test("staleness findings are held to the route's bounds: 50 paths each, none past 1024", () => {
  const L = STALE_MEMORY_LIMITS;
  const many = Array.from({ length: 120 }, (_, i) => `src/file-${i}.ts`);
  const [one, ...rest] = boundStaleMemories([
    ...Array.from({ length: 250 }, (_, i) => ({
      memoryId: `m${i}`,
      changedPaths: ["x".repeat(L.path + 1), ...many],
      headSha: null,
    })),
  ]);
  assertEquals(rest.length + 1, L.entries);
  assertEquals(one.changedPaths, many.slice(0, L.paths));
  const fine = { memoryId: "m", changedPaths: ["a.ts"], headSha: "abc1234" };
  assertEquals(boundStaleMemories([fine]), [fine]);
});

// The history verify surface: service-authed, answers 200 { runId, tokenHash } for a run's live
// token and 404 for anything else, and keeps accepting a terminal run's FINAL flush only within
// the ingest grace window (so a standalone historian does not drop the runner's last batch).

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { historyVerifyRoutes } from "../src/http/history_api.ts";
import type { AppDeps } from "../src/http/app.ts";
import type { Run, RunState } from "../src/core/types.ts";
import type { TaskStore } from "../src/ports/task_store.ts";
import { sha256Hex } from "@ryph/sealed";
import { fakeProvisioner, fakeRunnerControl, imageConfig, silentDiagnostics } from "./doubles.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";

const HISTORY_TOKEN = "history-service-token";
const nowMs = Date.parse("2026-06-01T12:00:00.000Z");

/** Only the fields the verify route reads; the rest of Run is irrelevant to this surface. */
function makeRun(o: { state: RunState; updatedAt: string; tokenHash: string }): Run {
  return {
    id: "r-1",
    state: o.state,
    updatedAt: o.updatedAt,
    tokenHash: o.tokenHash,
  } as unknown as Run;
}

function depsFor(run: Run | null): AppDeps {
  const store = {
    getRun: (id: string) => Promise.resolve(run && id === run.id ? run : null),
  } as unknown as TaskStore;
  return {
    store,
    provisioner: fakeProvisioner().provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate: () => Promise.resolve({ kind: "break-glass" as const }),
    now: () => new Date(nowMs),
    config: {
      publicUrl: "",
      ...imageConfig(),
      gitGateway: null,
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
}

async function verify(serviceToken: string, runToken: string, deps: AppDeps): Promise<Response> {
  const [route] = historyVerifyRoutes(deps, HISTORY_TOKEN);
  const req = new Request("http://o/v1/history/runs/r-1/verify", {
    method: "POST",
    headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" },
    body: JSON.stringify({ token: runToken }),
  });
  return await route.handler(req, { id: "r-1" });
}

test("verifies a live run's token and returns its hash", async () => {
  const hash = await sha256Hex("rt-1");
  const res = await verify(
    HISTORY_TOKEN,
    "rt-1",
    depsFor(
      makeRun({ state: "running", updatedAt: new Date(nowMs).toISOString(), tokenHash: hash }),
    ),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { runId: "r-1", tokenHash: hash });
});

test("a wrong service token is 401; a wrong run token is 404", async () => {
  const hash = await sha256Hex("rt-1");
  const deps = depsFor(
    makeRun({ state: "running", updatedAt: new Date(nowMs).toISOString(), tokenHash: hash }),
  );
  assertEquals((await verify("not-the-service-token", "rt-1", deps)).status, 401);
  assertEquals((await verify(HISTORY_TOKEN, "wrong-run-token", deps)).status, 404);
});

test("an unknown run is 404", async () => {
  assertEquals((await verify(HISTORY_TOKEN, "rt-1", depsFor(null))).status, 404);
});

test("a terminal run still verifies within the ingest grace, and 404s past it", async () => {
  const hash = await sha256Hex("rt-1");
  const withinGrace = new Date(nowMs - 5_000).toISOString(); // concluded 5s ago
  assertEquals(
    (await verify(
      HISTORY_TOKEN,
      "rt-1",
      depsFor(makeRun({ state: "succeeded", updatedAt: withinGrace, tokenHash: hash })),
    )).status,
    200,
  );
  const pastGrace = new Date(nowMs - 60_000).toISOString(); // concluded 60s ago
  assertEquals(
    (await verify(
      HISTORY_TOKEN,
      "rt-1",
      depsFor(makeRun({ state: "succeeded", updatedAt: pastGrace, tokenHash: hash })),
    )).status,
    404,
  );
});

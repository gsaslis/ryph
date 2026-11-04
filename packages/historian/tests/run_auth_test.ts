// The run-token introspection client: the brief positive cache keyed by run, the tri-state
// (verified / definitive 404 / could-not-ask throws), (runId, token) isolation across concurrent
// verifies, and invalidate. A real loopback server stands in for the orchestrator's verify surface.

import { test } from "bun:test";
import { assertEquals, assertRejects } from "@std/assert";
import { httpRunAuth, type RunAuthDiag } from "../src/adapters/run_auth/http.ts";
import { sha256Hex } from "@ryph/sealed";
import { serve } from "@ryph/service";

const HISTORY_TOKEN = "history-service-token";
const silent: RunAuthDiag = { debug() {}, warn() {} };

function reqWith(token: string): Request {
  return new Request("http://historian.test/", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

/** A loopback orchestrator whose verify route the client actually calls. `respond` sees the run id
 * from the path and the token from the body, so a test can answer per (run, token). */
async function stubOrchestrator(
  respond: (runId: string, token: string) => Response,
) {
  const requests: { runId: string; auth: string | null }[] = [];
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const runId = new URL(req.url).pathname.split("/")[4]; // /v1/history/runs/:id/verify
    const body = await req.json().catch(() => ({})) as { token?: string };
    requests.push({ runId, auth: req.headers.get("authorization") });
    return respond(runId, body.token ?? "");
  });
  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    requests,
    shutdown: () => server.shutdown(),
  };
}

test("verifies a run token, presents the service token, and caches by run", async () => {
  const hashA = await sha256Hex("rt-A");
  let hits = 0;
  const stub = await stubOrchestrator((runId, token) => {
    hits++;
    return runId === "r-A" && token === "rt-A"
      ? new Response(JSON.stringify({ runId, tokenHash: hashA }), { status: 200 })
      : new Response(JSON.stringify({ error: "unknown run" }), { status: 404 });
  });
  try {
    const auth = httpRunAuth({
      orchestratorUrl: stub.url,
      historyToken: HISTORY_TOKEN,
      diag: silent,
      cacheTtlMs: 60_000,
    });
    assertEquals(await auth.authenticateRun(reqWith("rt-A"), "r-A"), true);
    assertEquals(await auth.authenticateRun(reqWith("rt-A"), "r-A"), true); // served from cache
    assertEquals(hits, 1);
    assertEquals(stub.requests[0].auth, `Bearer ${HISTORY_TOKEN}`);
  } finally {
    await stub.shutdown();
  }
});

test("no bearer is false without a round-trip; a wrong token is the definitive false", async () => {
  const stub = await stubOrchestrator(() =>
    new Response(JSON.stringify({ error: "unknown run" }), { status: 404 })
  );
  try {
    const auth = httpRunAuth({
      orchestratorUrl: stub.url,
      historyToken: HISTORY_TOKEN,
      diag: silent,
    });
    assertEquals(await auth.authenticateRun(new Request("http://x/"), "r-A"), false);
    assertEquals(stub.requests.length, 0); // no bearer never asks
    assertEquals(await auth.authenticateRun(reqWith("wrong"), "r-A"), false); // 404 → false
  } finally {
    await stub.shutdown();
  }
});

test("could-not-ask throws (retryable 5xx), never a batch-dropping false", async () => {
  // The runner's emitter DROPS 4xx as final and RETRIES 5xx, so a transient control-plane
  // condition must throw (→ 5xx), not answer false (→ 401).
  let status = 401;
  const stub = await stubOrchestrator(() => new Response("no", { status }));
  try {
    const auth = httpRunAuth({
      orchestratorUrl: stub.url,
      historyToken: HISTORY_TOKEN,
      diag: silent,
      cacheTtlMs: 0,
    });
    await assertRejects(() => auth.authenticateRun(reqWith("rt-A"), "r-A"), Error, "401");
    status = 503;
    await assertRejects(() => auth.authenticateRun(reqWith("rt-A"), "r-A"), Error, "503");
  } finally {
    await stub.shutdown();
  }
  // Unreachable orchestrator (connection refused) throws too — never a false.
  const auth = httpRunAuth({
    orchestratorUrl: "http://127.0.0.1:1",
    historyToken: HISTORY_TOKEN,
    diag: silent,
    requestTimeoutMs: 1_000,
  });
  await assertRejects(() => auth.authenticateRun(reqWith("rt-A"), "r-A"), Error, "unreachable");
});

test("a run's token cannot authenticate another run, even racing its in-flight verify", async () => {
  // rt-A is run A's token. The orchestrator answers 200 for (r-A, rt-A) and 404 for (r-B, rt-A).
  // Firing both concurrently exercises the in-flight share: keyed by (runId, token), B must get
  // its own 404 and NOT inherit A's positive answer (which token-only keying would leak).
  const hashA = await sha256Hex("rt-A");
  const stub = await stubOrchestrator((runId, token) =>
    runId === "r-A" && token === "rt-A"
      ? new Response(JSON.stringify({ runId, tokenHash: hashA }), { status: 200 })
      : new Response(JSON.stringify({ error: "unknown run" }), { status: 404 })
  );
  try {
    const auth = httpRunAuth({
      orchestratorUrl: stub.url,
      historyToken: HISTORY_TOKEN,
      diag: silent,
    });
    const [a, b] = await Promise.all([
      auth.authenticateRun(reqWith("rt-A"), "r-A"),
      auth.authenticateRun(reqWith("rt-A"), "r-B"),
    ]);
    assertEquals(a, true);
    assertEquals(b, false);
  } finally {
    await stub.shutdown();
  }
});

test("invalidate forces the next batch to re-verify", async () => {
  const hashA = await sha256Hex("rt-A");
  let hits = 0;
  const stub = await stubOrchestrator((runId) => {
    hits++;
    return new Response(JSON.stringify({ runId, tokenHash: hashA }), { status: 200 });
  });
  try {
    const auth = httpRunAuth({
      orchestratorUrl: stub.url,
      historyToken: HISTORY_TOKEN,
      diag: silent,
      cacheTtlMs: 60_000,
    });
    assertEquals(await auth.authenticateRun(reqWith("rt-A"), "r-A"), true);
    await auth.authenticateRun(reqWith("rt-A"), "r-A"); // cached
    assertEquals(hits, 1);
    auth.invalidate("r-A");
    await auth.authenticateRun(reqWith("rt-A"), "r-A"); // cache dropped → re-asks
    assertEquals(hits, 2);
  } finally {
    await stub.shutdown();
  }
});

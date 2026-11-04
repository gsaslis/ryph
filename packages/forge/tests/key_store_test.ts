// The HTTP key store: faithful tri-state (grant / definitive no / could-not-ask), the brief
// positive cache, and the service credential on the wire.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { serve } from "@ryph/service";
import { httpKeyStore } from "../src/adapters/key_store/http.ts";
import { silentDiagnostics } from "./util.ts";

const GRANT = {
  runId: "r-1",
  repos: [{
    connectedRepoId: "cr-1",
    provider: "github" as const,
    repoRef: "acme/app",
    url: "https://example.com/repo.git",
    ref: "main",
    branchNamespace: "ryph/ada/r-1",
    tenantId: "161110166",
  }],
};

async function stubOrchestrator(
  respond: (req: Request) => Promise<Response> | Response,
) {
  const requests: Request[] = [];
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    // Kept as bytes rather than a clone read later: under Bun a clone's body stalls once the
    // original is let go of unread.
    const body = await (req.clone() as Request).arrayBuffer();
    requests.push(new Request(req.url, { method: req.method, headers: req.headers, body }));
    return respond(req);
  });
  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    requests,
    shutdown: () => server.shutdown(),
  };
}

test("resolves a grant, presents the service token, and caches briefly", async () => {
  let hits = 0;
  const stub = await stubOrchestrator(() => {
    hits++;
    return new Response(JSON.stringify(GRANT), { status: 200 });
  });
  try {
    const keys = httpKeyStore({
      orchestratorUrl: stub.url,
      forgeToken: "service-secret",
      diag: silentDiagnostics(),
      cacheTtlMs: 60_000,
    });
    assertEquals(await keys.resolve("vk-1"), GRANT);
    assertEquals(await keys.resolve("vk-1"), GRANT); // served from cache
    assertEquals(hits, 1);
    assertEquals(stub.requests[0].headers.get("authorization"), "Bearer service-secret");
    assertEquals(await stub.requests[0].json(), { token: "vk-1" });
  } finally {
    await stub.shutdown();
  }
});

test("404 is the definitive null; 401/5xx and garbage answers throw", async () => {
  let mode: "notfound" | "denied" | "down" | "garbage" = "notfound";
  const stub = await stubOrchestrator(() => {
    switch (mode) {
      case "notfound":
        return new Response(JSON.stringify({ error: "unknown key" }), { status: 404 });
      case "denied":
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      case "down":
        return new Response("oops", { status: 503 });
      case "garbage":
        return new Response(JSON.stringify({ nonsense: true }), { status: 200 });
    }
  });
  try {
    const keys = httpKeyStore({
      orchestratorUrl: stub.url,
      forgeToken: "service-secret",
      diag: silentDiagnostics(),
      cacheTtlMs: 0, // no reuse between the modes below
    });
    assertEquals(await keys.resolve("vk-x"), null);
    mode = "denied";
    await assertRejects(() => keys.resolve("vk-x"), Error, "401");
    mode = "down";
    await assertRejects(() => keys.resolve("vk-x"), Error, "503");
    mode = "garbage";
    await assertRejects(() => keys.resolve("vk-x"), Error, "malformed");
  } finally {
    await stub.shutdown();
  }
});

test("an unreachable orchestrator throws — never a silent null", async () => {
  const keys = httpKeyStore({
    // A port nothing listens on: connection refused, immediately.
    orchestratorUrl: "http://127.0.0.1:1",
    forgeToken: "service-secret",
    diag: silentDiagnostics(),
  });
  await assertRejects(() => keys.resolve("vk-x"));
  assert(true);
});

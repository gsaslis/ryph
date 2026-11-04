// The management surface: the gates (any user browses, admins write), the list filters, the
// hand-written memory, the inbox, and the disabled stand-ins.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { disabledMemoryRoutes, MEMORY_DISABLED } from "../src/http/routes.ts";
import { makeRouter } from "@ryph/shared/http";
import { ADMIN, call, GATEWAY, makeApi, PLAIN, PLAIN_TOKEN, SERVICE } from "./api.ts";
import { memory, proposal } from "./fixtures.ts";

const NEW = {
  text: "Deploys go through deno task release:push",
  kind: "procedure",
  subject: { kind: "repo", url: "https://github.com/Acme/App.git" },
};

test("writing canon is admins-only; browsing is any verified user's", async () => {
  const { handle, store } = makeApi();
  await store.insertMemory(memory());

  assertEquals((await call(handle, "POST", "/v1/memories", NEW, PLAIN)).status, 403);
  assertEquals(
    (await call(handle, "PATCH", "/v1/memories/mem-1", { kind: "fact" }, PLAIN)).status,
    403,
  );
  assertEquals(
    (await call(handle, "POST", "/v1/memories/mem-1/pin", undefined, PLAIN)).status,
    403,
  );
  assertEquals(
    (await call(handle, "POST", "/v1/memories/mem-1/retire", undefined, PLAIN)).status,
    403,
  );
  assertEquals(
    (await call(handle, "POST", "/v1/memory/consolidate", undefined, PLAIN)).status,
    403,
  );
  assertEquals((await call(handle, "GET", "/v1/memories", undefined, PLAIN)).status, 200);
  assertEquals((await call(handle, "GET", "/v1/memories/mem-1", undefined, PLAIN)).status, 200);
  assertEquals((await call(handle, "GET", "/v1/memory/subjects", undefined, PLAIN)).status, 200);
  assertEquals((await call(handle, "GET", "/v1/memories", undefined, null)).status, 401);
  assertEquals((await call(handle, "GET", "/v1/memories", undefined, "wrong")).status, 401);
});

test("a hand-written memory is canon at once, scored, and canonically subjected", async () => {
  const { handle } = makeApi();
  const created = await call(handle, "POST", "/v1/memories", NEW);
  assertEquals(created.status, 201);
  const body = await created.json();
  assertEquals(body.trust, "human");
  assertEquals(body.status, "canon");
  assertEquals(body.subject, { kind: "repo", url: "github.com/acme/app" });
  assertEquals(body.provenance, { kind: "human", userId: "u-admin" });
  assertEquals(body.score.total, 1.5);
  assertEquals(body.age, "today");

  const pinned = await call(handle, "POST", "/v1/memories", { ...NEW, pinned: true });
  assertEquals((await pinned.json()).score.total, -1, "infinity on the wire");

  const refused = await call(handle, "POST", "/v1/memories", {
    ...NEW,
    text: "AKIAIOSFODNN7EXAMPLE",
  });
  assertEquals(refused.status, 400);
  assertStringIncludes((await refused.json()).error, "credential");
  assertEquals((await call(handle, "POST", "/v1/memories", { text: "x" })).status, 400);
});

test("list filters by subject, audience, kind, status, trust and free text", async () => {
  const { handle, store } = makeApi();
  await store.insertMemory(memory({ id: "mem-1", text: "vitest runs the tests" }));
  await store.insertMemory(
    memory({
      id: "mem-2",
      text: "Deploys use kustomize",
      subject: { kind: "org" },
      kind: "decision",
      trust: "human",
    }),
  );
  await store.insertMemory(
    memory({
      id: "mem-3",
      text: "A private note",
      audience: { kind: "agent", agentId: "a-1" },
      status: "retired",
    }),
  );
  const ids = async (query: string) => {
    const res = await call(handle, "GET", `/v1/memories${query}`);
    assertEquals(res.status, 200);
    return ((await res.json()).memories as Array<{ id: string }>).map((m) => m.id).sort();
  };
  assertEquals(await ids(""), ["mem-1", "mem-2", "mem-3"]);
  assertEquals(await ids("?subject=org"), ["mem-2"]);
  assertEquals(await ids("?subject=repo:github.com/acme/app"), ["mem-1", "mem-3"]);
  assertEquals(await ids("?audience=agent:a-1"), ["mem-3"]);
  assertEquals(await ids("?kind=decision,gotcha"), ["mem-2"]);
  assertEquals(await ids("?status=canon"), ["mem-1", "mem-2"]);
  assertEquals(await ids("?trust=human"), ["mem-2"]);
  assertEquals(await ids("?q=vitest"), ["mem-1"]);
  assertEquals((await call(handle, "GET", "/v1/memories?subject=planet")).status, 400);
  assertEquals((await call(handle, "GET", "/v1/memories?limit=0")).status, 400);
});

test("list pages by offset without skipping or repeating a row", async () => {
  const { handle, store } = makeApi();
  for (let i = 1; i <= 5; i++) {
    await store.insertMemory(memory({ id: `mem-${i}`, text: `vitest note ${i}` }));
  }
  const page = async (query: string) => {
    const res = await call(handle, "GET", `/v1/memories${query}`);
    assertEquals(res.status, 200);
    return ((await res.json()).memories as Array<{ id: string }>).map((m) => m.id);
  };
  for (const q of ["", "&q=vitest"]) {
    const all = await page(`?limit=5${q}`);
    assertEquals(all.length, 5);
    const walked = [
      ...await page(`?limit=2&offset=0${q}`),
      ...await page(`?limit=2&offset=2${q}`),
      ...await page(`?limit=2&offset=4${q}`),
    ];
    assertEquals(walked, all);
    assertEquals(await page(`?limit=2&offset=5${q}`), []);
  }
  assertEquals((await call(handle, "GET", "/v1/memories?offset=-1")).status, 400);
  assertEquals((await call(handle, "GET", "/v1/memories?offset=1.5")).status, 400);
  assertEquals((await call(handle, "GET", "/v1/memories?offset=x")).status, 400);
});

test("detail carries the log, the chain and the runs; edits, pins and retirement land", async () => {
  const { handle, store, service } = makeApi();
  await store.insertMemory(memory({ id: "mem-1" }));
  await service.composeBrief({
    runId: "r-1",
    taskId: "t-1",
    agentId: "a-1",
    repos: ["github.com/acme/app"],
    task: { title: "t", instructions: "i" },
  });
  const detail = await (await call(handle, "GET", "/v1/memories/mem-1")).json();
  assertEquals(detail.memory.id, "mem-1");
  assertEquals(detail.runs.map((r: { runId: string }) => r.runId), ["r-1"]);
  assertEquals(detail.feedback.map((f: { kind: string }) => f.kind), ["briefed"]);
  assertEquals(detail.supersedes, null);

  const edited = await call(handle, "PATCH", "/v1/memories/mem-1", {
    text: "App tests are vitest",
    kind: "fact",
  });
  assertEquals((await edited.json()).kind, "fact");
  assertEquals((await call(handle, "PATCH", "/v1/memories/mem-1", {})).status, 400);
  assertEquals(
    (await (await call(handle, "POST", "/v1/memories/mem-1/pin")).json()).trust,
    "pinned",
  );
  assertEquals(
    (await (await call(handle, "POST", "/v1/memories/mem-1/unpin")).json()).trust,
    "human",
  );
  assertEquals(
    (await (await call(handle, "POST", "/v1/memories/mem-1/retire")).json()).status,
    "retired",
  );
  assertEquals((await call(handle, "GET", "/v1/memories/nope")).status, 404);
  assertEquals((await call(handle, "PATCH", "/v1/memories/nope", { kind: "fact" })).status, 404);
});

test("a proposal made with an API token waits for a person; the pass never promotes it", async () => {
  const { handle, store } = makeApi();
  const proposed = await call(handle, "POST", "/v1/memory-proposals", {
    text: "Org uses conventional commits",
  }, PLAIN_TOKEN);
  assertEquals(proposed.status, 201);
  const body = await proposed.json();
  assertEquals(body.origin, { kind: "human", userId: "u-plain", via: "token" });

  const pass = await (await call(handle, "POST", "/v1/memory/consolidate")).json();
  assertEquals(pass.promoted, 0);
  assertEquals(pass.held, 1);
  assertEquals((await store.getProposal(body.id))?.status, "pending");

  const accepted = await call(handle, "POST", `/v1/memory-proposals/${body.id}/accept`);
  assertEquals(accepted.status, 200);
  assertEquals((await accepted.json()).status, "canon");
});

test("one person has at most 50 proposals made with an API token pending at once", async () => {
  const { handle, store } = makeApi();
  for (let i = 0; i < 50; i++) {
    await store.insertProposal(
      proposal({ id: `prop-t${i}`, origin: { kind: "human", userId: "u-plain", via: "token" } }),
    );
  }
  const refused = await call(handle, "POST", "/v1/memory-proposals", {
    text: "Org uses conventional commits",
  }, PLAIN_TOKEN);
  assertEquals(refused.status, 429);
  assertStringIncludes((await refused.json()).error, "50 proposals made with an API token");
  // The person's own proposals from the app are never capped by what their tokens made.
  const inApp = await call(handle, "POST", "/v1/memory-proposals", {
    text: "Org uses conventional commits",
  }, PLAIN);
  assertEquals(inApp.status, 201);
  // Someone else's inbox share is their own.
  const other = await call(handle, "POST", "/v1/memory-proposals", {
    text: "Org uses conventional commits",
  });
  assertEquals(other.status, 201);
  // Resolving one frees a slot.
  await call(handle, "POST", "/v1/memory-proposals/prop-t0/reject", { reason: "trivia" });
  const again = await call(handle, "POST", "/v1/memory-proposals", {
    text: "Org uses conventional commits",
  }, PLAIN_TOKEN);
  assertEquals(again.status, 201);
});

test("proposals made in the app do not count toward the token cap", async () => {
  const { handle, store } = makeApi();
  for (let i = 0; i < 60; i++) {
    await store.insertProposal(
      proposal({ id: `prop-s${i}`, origin: { kind: "human", userId: "u-plain" } }),
    );
  }
  for (let i = 0; i < 49; i++) {
    await store.insertProposal(
      proposal({ id: `prop-t${i}`, origin: { kind: "human", userId: "u-plain", via: "token" } }),
    );
  }
  const inApp = await call(handle, "POST", "/v1/memory-proposals", {
    text: "Org uses conventional commits",
  }, PLAIN);
  assertEquals(inApp.status, 201);
  // 49 token proposals waiting, beside 61 from the app: one more token proposal still fits.
  const fiftieth = await call(handle, "POST", "/v1/memory-proposals", {
    text: "Org uses conventional commits",
  }, PLAIN_TOKEN);
  assertEquals(fiftieth.status, 201);
  const past = await call(handle, "POST", "/v1/memory-proposals", {
    text: "Org uses conventional commits",
  }, PLAIN_TOKEN);
  assertEquals(past.status, 429);
});

test("the inbox: any user proposes, admins accept or reject, and a pass consolidates", async () => {
  const { handle, store } = makeApi();
  await store.insertProposal(proposal({ id: "prop-seeded", flags: ["instruction-shaped"] }));
  const listed = await (await call(handle, "GET", "/v1/memory-proposals", undefined, PLAIN)).json();
  assertEquals(listed.proposals.map((p: { id: string }) => p.id), ["prop-seeded"]);

  const proposed = await call(handle, "POST", "/v1/memory-proposals", {
    text: "Org uses conventional commits",
  }, PLAIN);
  assertEquals(proposed.status, 201);
  assertEquals((await proposed.json()).origin, { kind: "human", userId: "u-plain" });

  assertEquals(
    (await call(handle, "POST", "/v1/memory-proposals/prop-seeded/accept", undefined, PLAIN))
      .status,
    403,
  );
  const accepted = await call(handle, "POST", "/v1/memory-proposals/prop-seeded/accept", {
    kind: "preference",
  });
  assertEquals(accepted.status, 200);
  assertEquals((await accepted.json()).kind, "preference");
  assertEquals((await call(handle, "POST", "/v1/memory-proposals/prop-seeded/accept")).status, 404);

  const pass = await call(handle, "POST", "/v1/memory/consolidate");
  assertEquals(await pass.json(), {
    screened: 1,
    promoted: 1,
    merged: 0,
    rejected: 0,
    held: 0,
    judged: 0,
    modelFailures: 0,
    awaiting: 0,
    swept: 0,
  });

  await store.insertProposal(proposal({ id: "prop-noise" }));
  assertEquals(
    (await call(handle, "POST", "/v1/memory-proposals/prop-noise/reject", {})).status,
    400,
  );
  const rejected = await call(handle, "POST", "/v1/memory-proposals/prop-noise/reject", {
    reason: "trivia",
  });
  assertEquals((await rejected.json()).status, "rejected");
  const subjects = await (await call(handle, "GET", "/v1/memory/subjects")).json();
  assert(subjects.subjects.length >= 2);
});

test("the disabled stand-ins answer 503 with the marker, behind the gate", async () => {
  const handle = makeRouter(disabledMemoryRoutes({
    authenticate: (req) =>
      Promise.resolve(req.headers.get("authorization") ? null : new Response("", { status: 401 })),
  }));
  const res = await call(handle, "GET", "/v1/memories");
  assertEquals(res.status, 503);
  assertEquals((await res.json()).code, MEMORY_DISABLED);
  assertEquals((await call(handle, "POST", "/v1/memories", {}, null)).status, 401);
  assertEquals((await call(handle, "POST", "/v1/memory-proposals/x/accept")).status, 503);
});

test("bulk review resolves accepts and rejects in one request, skipping what is not pending", async () => {
  const { handle, store } = makeApi();
  await store.insertProposal(proposal({ id: "prop-a", text: "Claim A" }));
  await store.insertProposal(proposal({ id: "prop-b", text: "Claim B" }));
  await store.insertProposal(proposal({ id: "prop-c", text: "Claim C", status: "rejected" }));
  assertEquals(
    (await call(handle, "POST", "/v1/memory-proposals/resolve", { accept: ["prop-a"] }, PLAIN))
      .status,
    403,
  );
  assertEquals(
    (await call(handle, "POST", "/v1/memory-proposals/resolve", { accept: [], reject: [] })).status,
    400,
  );
  const res = await call(handle, "POST", "/v1/memory-proposals/resolve", {
    accept: ["prop-a", "prop-c"],
    reject: ["prop-b", "prop-nope"],
    reason: "not durable",
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.accepted.length, 1);
  assertEquals(body.rejected, ["prop-b"]);
  assertEquals(body.skipped, ["prop-c", "prop-nope"]);
  assertEquals((await store.getProposal("prop-a"))?.status, "promoted");
  assertEquals((await store.getProposal("prop-b"))?.resolution, { reason: "not durable" });
});

test("health and the brief preview are open reads; the preview records nothing", async () => {
  const { handle, store } = makeApi();
  await store.insertMemory(memory({ id: "mem-1" }));
  const health = await call(handle, "GET", "/v1/memory/health", undefined, PLAIN);
  assertEquals(health.status, 200);
  const h = await health.json();
  assertEquals(h.subjects[0].canon, 1);
  assertEquals(h.inbox.pending, 0);
  assertEquals(h.modelBacked, false);

  const preview = await call(handle, "POST", "/v1/memory/brief-preview", {
    agentId: "a-1",
    repos: ["https://github.com/acme/app"],
    task: { title: "vitest", instructions: "" },
    budgetTokens: 500,
  }, PLAIN);
  assertEquals(preview.status, 200);
  const p = await preview.json();
  assertEquals(p.brief.memoryIds, ["mem-1"]);
  assertEquals(p.candidates.map((c: { included: boolean }) => c.included), [true]);
  assert(typeof p.candidates[0].memory.score.total === "number");
  assertEquals((await store.getMemory("mem-1"))?.briefedCount, 0);
  assertEquals(store.runs.size, 0);
});

test("a body past the cap is a 413 before it is parsed, on every surface", async () => {
  const { handle, data } = makeApi();
  const big = "x".repeat(3 * 1024 * 1024 + 1);
  const res = await call(handle, "POST", "/v1/memory-proposals", { text: big }, ADMIN);
  assertEquals(res.status, 413);
  const internal = await call(
    handle,
    "POST",
    "/internal/v1/runs/r-1/stale",
    { stale: [], pad: "x".repeat(1024 * 1024 + 1) },
    SERVICE,
  );
  assertEquals(internal.status, 413);
  // The MCP route, with a chunked body that announces no length.
  const chunk = new TextEncoder().encode("z".repeat(64 * 1024));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 17; i++) controller.enqueue(chunk);
      controller.close();
    },
  });
  const mcp = await data(
    new Request("http://memory.test/v1/memory-mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${GATEWAY}`, "x-ryph-run-id": "r-1" },
      body,
    }),
  );
  assertEquals(mcp?.status, 413);
});

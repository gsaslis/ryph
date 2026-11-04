import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { makeMemoryService } from "../src/core/service.ts";
import { ComposeBriefSchema } from "../src/schema.ts";
import type { ModelClient } from "../src/ports/model.ts";
import { countingMinter, fakeClock, fakeHash, memory, source } from "./fixtures.ts";
import { memoryStore } from "./memory_store.ts";

function setup(model?: ModelClient) {
  const store = memoryStore();
  const service = makeMemoryService({
    store,
    now: fakeClock().now,
    diag: { debug() {}, warn() {} },
    mintId: countingMinter(),
    hash: fakeHash,
    model,
  });
  return { store, service };
}

const request = {
  runId: "r-private",
  taskId: "t-private",
  agentId: "a-1",
  repos: ["github.com/acme/app"],
  task: { title: "vitest", instructions: "" },
  agentOnly: true,
};

test("agent-only scopes exclude shared and other-agent memories on every read and feedback path", async () => {
  const { store, service } = setup();
  for (
    const m of [
      memory({ id: "mem-shared", trust: "pinned" }),
      memory({ id: "mem-org", subject: { kind: "org" }, trust: "pinned" }),
      memory({ id: "mem-other", audience: { kind: "agent", agentId: "a-2" } }),
      memory({
        id: "mem-own",
        audience: { kind: "agent", agentId: "a-1" },
        supersedes: "mem-shared",
      }),
    ]
  ) await store.insertMemory(m);
  const brief = await service.composeBrief(request);
  assertEquals(brief?.memoryIds, ["mem-own"]);
  assertEquals((await service.previewBrief(request)).brief?.memoryIds, ["mem-own"]);
  const scope = await service.scopeOf(request.runId);
  assert(scope?.agentOnly);
  assertEquals((await service.search(scope, { query: "vitest" })).map((r) => r.memory.id), [
    "mem-own",
  ]);
  assertEquals(await service.search(scope, { query: "vitest", subject: "org" }), []);
  for (const id of ["mem-shared", "mem-org", "mem-other"]) {
    assertEquals(await service.getInScope(scope, id), null);
    assertEquals(await service.confirm(scope, request.runId, id), null);
    assertEquals(await service.refute(scope, request.runId, id, "wrong", "replacement"), null);
  }
  assertEquals((await service.getInScope(scope, "mem-own"))?.supersedes, null);
  assert(await service.confirm(scope, request.runId, "mem-own"));
  const refuted = await service.refute(
    scope,
    request.runId,
    "mem-own",
    "wrong",
    "vitest uses a new config",
  );
  assertEquals(refuted?.replacement?.audience, { kind: "agent", agentId: "a-1" });

  await store.insertSource(source({ id: "src-shared" }));
  await store.insertMemory(memory({
    id: "mem-pointer",
    kind: "pointer",
    audience: { kind: "agent", agentId: "a-1" },
    provenance: { kind: "source", sourceId: "src-shared", section: null },
  }));
  assertEquals(await service.docInScope(scope, "src-shared"), null);
  assertEquals(await service.docInScope(scope, "mem-pointer"), null);
});

test("agent-only scope survives zero-budget and no-repo briefs and defaults proposals to private", async () => {
  const { store, service } = setup();
  const parsed = ComposeBriefSchema.parse({ ...request, repos: [], budgetTokens: 0 });
  assertEquals(parsed.agentOnly, true);
  await service.composeBrief({ ...parsed, runId: request.runId });
  const scope = await service.scopeOf(request.runId);
  assert(scope?.agentOnly);
  const proposed = await service.propose(scope, request.runId, {
    text: "The audit findings are tracked in a private ledger.",
    basis: "observed",
  });
  assert(proposed.ok);
  assertEquals(proposed.proposal.audience, { kind: "agent", agentId: "a-1" });
  assertEquals(
    (await service.propose(scope, request.runId, {
      text: "A shared claim",
      audience: "all",
      basis: "observed",
    })).ok,
    false,
  );
  await service.consolidate();
  const saved = await store.listMemories({ tenantId: "default" });
  assertEquals(saved.length, 1);
  assertEquals(saved[0].memory.audience, { kind: "agent", agentId: "a-1" });
});

test("the consolidator cannot rewrite private claims using another audience's memories", async () => {
  const prompts: string[] = [];
  const { store, service } = setup({
    complete(req) {
      prompts.push(req.prompt);
      return Promise.resolve(JSON.stringify({ kind: "noise", reason: "not durable", of: null }));
    },
  });
  await store.insertMemory(memory({ id: "mem-shared", text: "vitest shared confidential detail" }));
  await store.insertMemory(memory({
    id: "mem-other",
    text: "vitest other agent confidential detail",
    audience: { kind: "agent", agentId: "a-2" },
  }));
  await service.composeBrief(request);
  const scope = await service.scopeOf(request.runId);
  assert(scope);
  assert(
    (await service.propose(scope, request.runId, {
      text: "vitest runs our tests",
      basis: "observed",
    })).ok,
  );
  await service.consolidate();
  assertEquals(prompts.length, 1);
  assertEquals(prompts[0].includes("confidential detail"), false);
});

test("consolidation does not fold a private proposal into an identical shared memory", async () => {
  const { store, service } = setup();
  await store.insertMemory(memory({ id: "mem-shared" }));
  await service.composeBrief(request);
  const scope = await service.scopeOf(request.runId);
  assert(scope);
  assert(
    (await service.propose(scope, request.runId, {
      text: memory().text,
      basis: "observed",
    })).ok,
  );
  await service.consolidate();
  assertEquals((await store.getMemory("mem-shared"))?.confirmations, 0);
  const own = await service.search(scope, { query: "vitest" });
  assertEquals(own.length, 1);
  assertEquals(own[0].memory.audience, { kind: "agent", agentId: "a-1" });
});

// Hybrid search: with an embedder, a paraphrase that shares no term still ranks; without one,
// full-text alone; the backfill embeds what was written before; health counts it. On both
// stores, since the drizzle one ranks hybrid in-process too.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { makeMemoryService } from "../src/core/service.ts";
import { degradingEmbedder } from "../src/adapters/embed/degrading.ts";
import { drizzleMemoryStore } from "../src/adapters/store/drizzle.ts";
import type { MemoryStore } from "../src/ports/store.ts";
import { cosine, relevanceOf } from "../src/core/vector.ts";
import { makeTestDb } from "./db.ts";
import { countingMinter, fakeClock, fakeEmbedder, fakeHash, memory } from "./fixtures.ts";
import { memoryStore } from "./memory_store.ts";

const silent = { debug() {}, warn() {} };

test("cosine and its relevance", () => {
  assertEquals(cosine([1, 0], [1, 0]), 1);
  assertEquals(cosine([1, 0], [0, 1]), 0);
  assertEquals(cosine([1, 0], [1]), 0);
  assertEquals(relevanceOf(0.9), 1);
  assertEquals(relevanceOf(0.35), 0);
  assertEquals(relevanceOf(0.625).toFixed(2), "0.50");
});

function hybridSuite(name: string, open: () => Promise<MemoryStore>) {
  test(`${name}: a memory is embedded on the way in and found by meaning; the backfill covers the rest`, async () => {
    const store = await open();
    try {
      const embedder = fakeEmbedder();
      const service = makeMemoryService({
        store,
        now: fakeClock().now,
        diag: silent,
        mintId: countingMinter(),
        hash: fakeHash,
        embedder,
      });
      const scope = { agentId: "a-1", repos: ["github.com/acme/app"] };
      // Written through the service: embedded at once.
      const vitest = await service.create({
        text: "frontend suite runs under vitest",
        kind: "procedure",
        subject: { kind: "repo", url: "github.com/acme/app" },
        audience: { kind: "all" },
      }, "u");
      assertEquals((await store.getMemory(vitest.id))?.embeddingModel, "fake-embed");
      // Written behind the service's back (an older row): no vector until the backfill.
      await store.insertMemory(memory({ id: "mem-old", text: "docker compose starts postgres" }));
      assertEquals((await store.getMemory("mem-old"))?.embedding, null);

      // The fake embedder is a bag of words, so a paraphrase must SHARE a word with the claim
      // to be near it — but that word need not be one full-text matches on. "suite" is a
      // shared term; "runs" and "under" are not what ranks it. A query with no shared term
      // and no text match finds nothing.
      const near = await service.search(scope, { query: "which suite" });
      assertEquals(near.map((h) => h.memory.id), [vitest.id]);
      assertEquals(await service.search(scope, { query: "kubernetes" }), []);

      const first = await service.backfillEmbeddings(10);
      assertEquals(first, { embedded: 1, remaining: 0 });
      assertEquals((await store.getMemory("mem-old"))?.embeddingModel, "fake-embed");
      assertEquals(await service.backfillEmbeddings(10), { embedded: 0, remaining: 0 });
      const health = await service.health();
      assertEquals(health.embeddings, { model: "fake-embed", embedded: 2, pending: 0 });

      // A vector from another model never compares: it counts as pending and ranks by text.
      await store.saveEmbedding(
        "mem-old",
        "other-model",
        [1, 0, 0],
        "docker compose starts postgres",
      );
      assertEquals((await service.health()).embeddings?.pending, 1);
      const byText = await service.search(scope, { query: "postgres" });
      assertEquals(byText.map((h) => h.memory.id), ["mem-old"]);
      assert(byText[0].relevance > 0);
      assertEquals(embedder.calls.length > 0, true);
    } finally {
      await store.close();
    }
  });

  test(`${name}: a query the embedder cannot serve still ranks by text`, async () => {
    const store = await open();
    try {
      const service = makeMemoryService({
        store,
        now: fakeClock().now,
        diag: silent,
        mintId: countingMinter(),
        hash: fakeHash,
        embedder: {
          model: "broken",
          embed: () => Promise.reject(new Error("runtime down")),
        },
      });
      const created = await service.create({
        text: "deploys go through release:push",
        kind: "procedure",
        subject: { kind: "org" },
        audience: { kind: "all" },
      }, "u");
      assertEquals((await store.getMemory(created.id))?.embedding, null, "left for the backfill");
      const hits = await service.search({ agentId: "a-1", repos: [] }, { query: "deploys" });
      assertEquals(hits.map((h) => h.memory.id), [created.id]);
    } finally {
      await store.close();
    }
  });
}

hybridSuite("in-memory", () => Promise.resolve(memoryStore()));
hybridSuite("drizzle", async () => drizzleMemoryStore(await makeTestDb()));

test("a search past the embedder's queue depth goes on by text instead of waiting", async () => {
  const store = memoryStore();
  const base = fakeEmbedder();
  // An embedder that holds every call until released: the first search occupies it.
  let release = () => {};
  const held = new Promise<void>((r) => release = r);
  const embedder = {
    model: base.model,
    calls: base.calls,
    async embed(texts: string[]) {
      await held;
      return await base.embed(texts);
    },
  };
  const warnings: string[] = [];
  const service = makeMemoryService({
    store,
    now: fakeClock().now,
    diag: { debug() {}, warn: (event: string) => void warnings.push(event) },
    mintId: countingMinter(),
    hash: fakeHash,
    embedder,
    maxQueryEmbedsInFlight: 1,
  });
  await store.insertMemory(memory({ id: "mem-pg", text: "docker compose starts postgres" }));
  const scope = { agentId: "a-1", repos: ["github.com/acme/app"] };

  const first = service.search(scope, { query: "postgres" });
  // The embedder is busy with the first query, so this one is ranked by its words at once.
  const second = await service.search(scope, { query: "postgres" });
  assertEquals(second.map((h) => h.memory.id), ["mem-pg"]);
  assertEquals(warnings, ["memory.embed_query_shed"]);

  release();
  assertEquals((await first).map((h) => h.memory.id), ["mem-pg"]);
  assertEquals(base.calls.length, 1);
});

test("a search whose vector misses the deadline is ranked by text, and the slot waits for the work", async () => {
  const store = memoryStore();
  const base = fakeEmbedder();
  let release = () => {};
  const held = new Promise<void>((r) => release = r);
  const embedder = {
    model: base.model,
    calls: base.calls,
    async embed(texts: string[]) {
      await held;
      return await base.embed(texts);
    },
  };
  const warnings: string[] = [];
  const service = makeMemoryService({
    store,
    now: fakeClock().now,
    diag: { debug() {}, warn: (event: string) => void warnings.push(event) },
    mintId: countingMinter(),
    hash: fakeHash,
    embedder,
    maxQueryEmbedsInFlight: 1,
    queryEmbedDeadlineMs: 10,
  });
  await store.insertMemory(memory({ id: "mem-pg", text: "docker compose starts postgres" }));
  const scope = { agentId: "a-1", repos: ["github.com/acme/app"] };

  // The embedder never answers in time: the search goes on by its words.
  const late = await service.search(scope, { query: "postgres" });
  assertEquals(late.map((h) => h.memory.id), ["mem-pg"]);
  // The abandoned embedding still holds the one slot, so the next search does not start another.
  assertEquals((await service.search(scope, { query: "postgres" })).length, 1);
  // Both searches were shed; the second inside the report interval, so one line says so.
  assertEquals(warnings, ["memory.embed_query_shed"]);
  assertEquals(base.calls.length, 0);

  // Once it finishes, the slot is free again.
  release();
  await new Promise((r) => setTimeout(r, 0));
  await service.search(scope, { query: "postgres" });
  assertEquals(base.calls.length, 2);
});

function staleVectorSuite(name: string, open: () => Promise<MemoryStore>) {
  test(`${name}: a vector computed for words the claim no longer says is not saved`, async () => {
    const store = await open();
    try {
      await store.insertMemory(memory({ id: "mem-edit", text: "the new wording" }));
      // An embedding of the old text finishing after the edit: dropped.
      await store.saveEmbedding("mem-edit", "fake-embed", [1, 0], "the old wording");
      assertEquals((await store.getMemory("mem-edit"))?.embedding, null);
      await store.saveEmbedding("mem-edit", "fake-embed", [0, 1], "the new wording");
      assertEquals((await store.getMemory("mem-edit"))?.embedding, [0, 1]);
    } finally {
      await store.close();
    }
  });
}

staleVectorSuite("in-memory", () => Promise.resolve(memoryStore()));
staleVectorSuite("drizzle", async () => drizzleMemoryStore(await makeTestDb()));

test("an edit whose vector is still on its way leaves no stale one, and the backfill waits for it", async () => {
  const store = memoryStore();
  const base = fakeEmbedder();
  let release = () => {};
  const held = new Promise<void>((r) => release = r);
  let holding = false;
  const embedder = {
    model: base.model,
    calls: base.calls,
    async embed(texts: string[]) {
      if (holding) await held;
      return await base.embed(texts);
    },
  };
  const service = makeMemoryService({
    store,
    now: fakeClock().now,
    diag: silent,
    mintId: countingMinter(),
    hash: fakeHash,
    embedder,
    writeEmbedWaitMs: 10,
  });
  const created = await service.create({
    text: "the suite runs under jest",
    kind: "fact",
    subject: { kind: "repo", url: "github.com/acme/app" },
    audience: { kind: "all" },
  }, "u");
  assertEquals((await store.getMemory(created.id))?.embeddingModel, "fake-embed");

  // The edit's embedding cannot finish yet: the edit answers anyway, with the old vector gone.
  holding = true;
  await service.edit(created.id, { text: "the suite runs under vitest" }, "u");
  assertEquals((await store.getMemory(created.id))?.embedding, null);
  // The backfill leaves it to the embedding already on its way instead of queueing it again —
  // and still says it is not done.
  assertEquals(await service.backfillEmbeddings(10), { embedded: 0, remaining: 1 });
  // A second edit while the first is still embedding: when either finishes, the other still
  // marks the claim as on its way.
  await service.edit(created.id, { text: "the suite runs under vitest, in watch mode" }, "u");
  assertEquals(await service.backfillEmbeddings(10), { embedded: 0, remaining: 1 });
  assertEquals(base.calls.length, 1);

  // A shutdown's drain waits for it, and it lands for the new words.
  const drained = service.drain();
  release();
  await drained;
  const after = await store.getMemory(created.id);
  assertEquals(after?.embeddingModel, "fake-embed");
  assert(after?.embedding !== null);
});

test("drain gives running embeddings a bounded wait, not the whole backfill", async () => {
  const store = memoryStore();
  const base = fakeEmbedder();
  const never = new Promise<void>(() => {});
  let holding = false;
  const embedder = {
    model: base.model,
    calls: base.calls,
    async embed(texts: string[]) {
      if (holding) await never;
      return await base.embed(texts);
    },
  };
  const service = makeMemoryService({
    store,
    now: fakeClock().now,
    diag: silent,
    mintId: countingMinter(),
    hash: fakeHash,
    embedder,
    writeEmbedWaitMs: 10,
    embedDrainWaitMs: 20,
  });
  holding = true;
  await service.create({
    text: "an embedding that never finishes",
    kind: "fact",
    subject: { kind: "repo", url: "github.com/acme/app" },
    audience: { kind: "all" },
  }, "u");
  const started = performance.now();
  await service.drain();
  assert(performance.now() - started < 1_000, "drain waited on an embedding that never ends");
});

test("a search's own abort is counted as a shed, not warned as a failure", async () => {
  const store = memoryStore();
  const warnings: string[] = [];
  // An embedder that honours the signal the way the worker embedder does.
  const embedder = {
    model: "fake-embed",
    embed(_texts: string[], opts?: { signal?: AbortSignal }) {
      return new Promise<number[][]>((_, reject) =>
        opts?.signal?.addEventListener(
          "abort",
          () => reject(new Error("the caller stopped waiting")),
        )
      );
    },
  };
  const service = makeMemoryService({
    store,
    now: fakeClock().now,
    diag: { debug() {}, warn: (event: string) => void warnings.push(event) },
    mintId: countingMinter(),
    hash: fakeHash,
    embedder,
    queryEmbedDeadlineMs: 10,
  });
  await store.insertMemory(memory({ id: "mem-pg", text: "docker compose starts postgres" }));
  const hits = await service.search({ agentId: "a-1", repos: ["github.com/acme/app"] }, {
    query: "postgres",
  });
  assertEquals(hits.map((h) => h.memory.id), ["mem-pg"]);
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(warnings, ["memory.embed_query_shed"]);
});

test("degradingEmbedder: a model that cannot load is said once, then the service runs on text", async () => {
  const told: string[] = [];
  let loads = 0;
  let closed = 0;
  const fake = fakeEmbedder();
  const embedder = degradingEmbedder({
    model: "fake-embed",
    load: () => {
      loads++;
      return new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("no onnxruntime here")), 5)
      );
    },
    embed: fake.embed,
    close: () => {
      closed++;
      return Promise.resolve();
    },
  }, (reason) => told.push(reason));
  assertEquals(embedder.available?.(), true);
  // Two callers on the same failed load: both fail, it is said once.
  const both = await Promise.allSettled([embedder.embed(["a"]), embedder.embed(["b"])]);
  assertEquals(both.map((r) => r.status), ["rejected", "rejected"]);
  assertEquals(told, ["no onnxruntime here"]);
  assertEquals(embedder.available?.(), false);
  assertEquals(closed, 1);
  // Given up for good: no second load, no runtime call.
  await assertRejects(() => embedder.embed(["c"]), Error, "embeddings are unavailable");
  assertEquals(loads, 1);
  assertEquals(fake.calls, []);

  // The service treats it as no embedder: text ranks, nothing is warned per call, health says off.
  const store = memoryStore();
  const warnings: string[] = [];
  const service = makeMemoryService({
    store,
    now: fakeClock().now,
    diag: { debug() {}, warn: (event: string) => void warnings.push(event) },
    mintId: countingMinter(),
    hash: fakeHash,
    embedder,
  });
  const created = await service.create({
    text: "deploys go through release:push",
    kind: "procedure",
    subject: { kind: "org" },
    audience: { kind: "all" },
  }, "u");
  const hits = await service.search({ agentId: "a-1", repos: [] }, { query: "deploys" });
  assertEquals(hits.map((h) => h.memory.id), [created.id]);
  assertEquals(await service.backfillEmbeddings(10), { embedded: 0, remaining: 0 });
  assertEquals((await service.health()).embeddings, null);
  assertEquals(warnings, []);
});

test("degradingEmbedder: a load that worked is not given up on when a later call fails", async () => {
  const told: string[] = [];
  let fail = true;
  const embedder = degradingEmbedder({
    model: "fake-embed",
    load: () => Promise.resolve(),
    embed: () => fail ? Promise.reject(new Error("worker crashed")) : Promise.resolve([[1]]),
    close: () => Promise.resolve(),
  }, (reason) => told.push(reason));
  await assertRejects(() => embedder.embed(["a"]), Error, "worker crashed");
  fail = false;
  assertEquals(await embedder.embed(["a"]), [[1]]);
  assertEquals(embedder.available?.(), true);
  assertEquals(told, []);
});

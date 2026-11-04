import { test } from "bun:test";
import { assertEquals, assertRejects } from "@std/assert";
import { workerEmbedder } from "../src/adapters/embed/worker_embedder.ts";

const stub = new URL("./fixtures/stub_embed_worker.ts", import.meta.url);

test("workerEmbedder serves an urgent search ahead of queued background work", async () => {
  const embedder = workerEmbedder({ modelDir: "unused" }, stub);
  try {
    const order: string[] = [];
    // Three jobs of four slow texts each: a backfill's worth of work already queued.
    const backfill = embedder.embed(Array(12).fill("slow")).then((v) => {
      order.push("background");
      return v;
    });
    await new Promise((r) => setTimeout(r, 10));
    const search = embedder.embed(["query"], { urgent: true }).then((v) => {
      order.push("urgent");
      return v;
    });
    assertEquals(await search, [[5]]);
    assertEquals((await backfill).length, 12);
    assertEquals(order, ["urgent", "background"]);
  } finally {
    await embedder.close();
  }
});

test("workerEmbedder fails the jobs of a worker that died, and starts a new one", async () => {
  const embedder = workerEmbedder({ modelDir: "unused" }, stub);
  try {
    await assertRejects(() => embedder.embed(["crash"]), Error, "the embeddings worker failed");
    assertEquals(await embedder.embed(["again"]), [[5]]);
  } finally {
    await embedder.close();
  }
});

test("workerEmbedder drops the rest of a request once one of its parts failed", async () => {
  const embedder = workerEmbedder({ modelDir: "unused" }, stub);
  try {
    // Two jobs: the first crashes the worker, the second would run on its replacement.
    await assertRejects(() => embedder.embed(["crash", "a", "b", "c", "d", "e", "f", "g"]));
    // The replacement ran nothing before this: the failed request's second job was dropped.
    assertEquals(await embedder.embed(["count"]), [[1]]);
  } finally {
    await embedder.close();
  }
});

test("workerEmbedder drops a queued job whose caller stopped waiting", async () => {
  const embedder = workerEmbedder({ modelDir: "unused" }, stub);
  try {
    // One slow job holds the worker; the second waits in line behind it.
    const busy = embedder.embed(["slow"]);
    const caller = new AbortController();
    const abandoned = embedder.embed(["abandoned"], { urgent: true, signal: caller.signal });
    caller.abort();
    await assertRejects(() => abandoned, Error, "stopped waiting");
    await busy;
    // It never reached the worker: the next job is this worker's second, not its third.
    assertEquals(await embedder.embed(["count"]), [[2]]);
  } finally {
    await embedder.close();
  }
});

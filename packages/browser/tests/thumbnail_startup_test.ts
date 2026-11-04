import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { prepareThumbnailService, thumbnailFailureCategory } from "../src/thumbnail_startup.ts";

const request = (html: string) =>
  new Request("http://thumbnail/render", {
    method: "POST",
    headers: { "content-type": "text/html" },
    body: html,
  });

test("thumbnail readiness waits for trusted render and later failures never log HTML", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let ready = false;
  const logs: string[] = [];
  const preparing = prepareThumbnailService(async (html, signal, deadlineAt) => {
    calls++;
    if (calls === 1) {
      assert(html.includes("Thumbnail readiness check"));
      assert(!signal.aborted);
      assert(deadlineAt > Date.now());
      await gate;
      return new Uint8Array([1]);
    }
    throw new Error(`private-document: ${html}\nsecret-token=XYZ`);
  }, { log: (line) => logs.push(line) }).then((service) => {
    ready = true;
    return service;
  });
  await Bun.sleep(5);
  assert(!ready);
  release();
  const service = await preparing;
  try {
    assertEquals((await service.handler(new Request("http://thumbnail/health"))).status, 200);
    assertEquals((await service.handler(request("SENSITIVE HTML"))).status, 500);
    assertEquals(logs.length, 1);
    assert(logs[0]!.startsWith("thumbnail.render_failed browser_failed:"));
    assert(!logs.join().includes("SENSITIVE"));
    assert(!logs.join().includes("XYZ"));
  } finally {
    await service.close();
  }
});

test("thumbnail startup diagnoses sandbox, executable and library failures without raw errors", async () => {
  for (
    const [message, category] of [
      ["Failed to move to new namespace: Operation not permitted", "sandbox_unavailable"],
      ["Executable doesn't exist at /private/secret", "executable_missing"],
      ["error while loading shared libraries: private.so", "dependencies_missing"],
    ]
  ) {
    const logs: string[] = [];
    await assertRejects(() =>
      prepareThumbnailService(() => Promise.reject(new Error(`${message} SECRET=do-not-log`)), {
        log: (line) => logs.push(line),
      })
    );
    assertEquals(logs.length, 1);
    assert(logs[0]!.startsWith(`thumbnail.startup_failed ${category}`));
    assert(!logs[0]!.includes("SECRET"));
    assert(!logs[0]!.includes("/private"));
  }
  assertEquals(thumbnailFailureCategory(new Error("timeout 15000ms")), "deadline_exceeded");
});

test("thumbnail startup deadline aborts browser and waits for cleanup", async () => {
  let cleaned = false;
  const logs: string[] = [];
  await assertRejects(() =>
    prepareThumbnailService(async (_html, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      await Bun.sleep(5);
      cleaned = true;
      throw new Error("aborted");
    }, { deadlineMs: 10, log: (line) => logs.push(line) })
  );
  assert(cleaned);
  assertEquals(logs, ["thumbnail.startup_failed deadline_exceeded"]);
});

test("thumbnail startup external cancellation aborts and never becomes ready", async () => {
  const controller = new AbortController();
  const logs: string[] = [];
  await assertRejects(() =>
    prepareThumbnailService(async (_html, signal) => {
      const aborted = new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve())
      );
      controller.abort();
      await aborted;
      throw new Error("cancelled");
    }, { signal: controller.signal, log: (line) => logs.push(line) })
  );
  assertEquals(logs, ["thumbnail.startup_failed cancelled"]);
});

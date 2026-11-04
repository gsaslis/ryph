import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { BrowserServer } from "playwright-core";
import { createThumbnailService, MAX_HTML_BYTES, MAX_PNG_BYTES } from "../src/http/thumbnail.ts";
import { renderThumbnail, thumbnailSandbox } from "../src/adapters/thumbnail.ts";

const request = (
  body: BodyInit = "<h1>Hello</h1>",
  headers: HeadersInit = { "content-type": "text/html" },
) => new Request("http://thumbnail/render", { method: "POST", headers, body });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("thumbnail routes, media type, UTF-8 and output bounds", async () => {
  let calls = 0;
  const service = createThumbnailService(() => {
    calls++;
    return Promise.resolve(new Uint8Array([1]));
  });
  assertEquals((await service.handler(new Request("http://thumbnail/health"))).status, 200);
  assertEquals((await service.handler(new Request("http://thumbnail/render"))).status, 404);
  assertEquals(
    (await service.handler(request("x", { "content-type": "application/json" }))).status,
    415,
  );
  assertEquals((await service.handler(request(new Uint8Array([0xff])))).status, 400);
  assertEquals(
    (await service.handler(
      request("x", { "content-type": "text/html", "content-length": String(MAX_HTML_BYTES + 1) }),
    )).status,
    413,
  );
  assertEquals(calls, 0);
  const ok = await service.handler(request("é", { "content-type": "text/html; charset=UTF-8" }));
  assertEquals(ok.status, 200);
  assertEquals(ok.headers.get("content-type"), "image/png");
  const oversized = createThumbnailService(() =>
    Promise.resolve(new Uint8Array(MAX_PNG_BYTES + 1))
  );
  assertEquals((await oversized.handler(request())).status, 413);
});

test("thumbnail counts streamed bytes rather than trusting Content-Length", async () => {
  let cancelled = false;
  let count = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      count++;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const service = createThumbnailService(() => Promise.reject(new Error("must not render")));
  const response = await service.handler(
    request(body, { "content-type": "text/html", "content-length": "1" }),
  );
  assertEquals(response.status, 413);
  assert(cancelled);
  assert(count <= 26);
});

test("thumbnail deadline includes body reading and cancels slow upload", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const service = createThumbnailService(() => Promise.resolve(new Uint8Array()), {
    deadlineMs: 10,
  });
  const first = service.handler(request(body));
  assertEquals((await service.handler(request())).status, 503);
  assertEquals((await first).status, 504);
  await tick();
  assert(cancelled);
  await service.close();
});

test("thumbnail holds admission through timed-out cleanup, then admits a fresh job", async () => {
  let release!: () => void;
  let aborted = false;
  let calls = 0;
  const service = createThumbnailService(async (_html, signal) => {
    calls++;
    if (calls === 1) {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return new Uint8Array([1]);
  }, { deadlineMs: 10 });
  const first = service.handler(request());
  assertEquals((await service.handler(request())).status, 503);
  assertEquals((await first).status, 504);
  assert(aborted);
  assertEquals((await service.handler(request())).status, 503);
  release();
  await tick();
  assertEquals((await service.handler(request())).status, 200);
  await service.close();
  assertEquals((await service.handler(request())).status, 503);
});

test("thumbnail launch arriving after cancellation is killed and never connected", async () => {
  const controller = new AbortController();
  let killed = 0;
  let finish!: (server: BrowserServer) => void;
  const job = renderThumbnail("x", controller.signal, {}, async (options) => {
    assertEquals(options?.chromiumSandbox, true);
    assert((options?.timeout ?? 0) <= 15_000);
    return await new Promise<BrowserServer>((resolve) => {
      finish = resolve;
    });
  });
  controller.abort();
  finish({
    kill: () => {
      killed++;
      return Promise.resolve();
    },
  } as unknown as BrowserServer);
  await assertRejects(() => job);
  assertEquals(killed, 1);
});

test("thumbnail sandbox defaults to required and never retries failed launch", async () => {
  assertEquals(thumbnailSandbox(undefined), true);
  assertEquals(thumbnailSandbox("required"), true);
  assertEquals(thumbnailSandbox("off"), false);
  assertThrows(() => thumbnailSandbox("auto"));
  let calls = 0;
  await assertRejects(() =>
    renderThumbnail("x", new AbortController().signal, {}, () => {
      calls++;
      return Promise.reject(new Error("No usable sandbox"));
    })
  );
  assertEquals(calls, 1);
});

test("thumbnail kills an owned browser when connecting fails", async () => {
  let killed = 0;
  await assertRejects(() =>
    renderThumbnail("x", new AbortController().signal, {}, () =>
      Promise.resolve({
        wsEndpoint: () => "not a websocket URL",
        kill: () => {
          killed++;
          return Promise.resolve();
        },
      } as unknown as BrowserServer))
  );
  assertEquals(killed, 1);
});

test("thumbnail shutdown cancels the active job and waits for cleanup", async () => {
  let cleanupDone = false;
  const service = createThumbnailService(async (_html, signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true })
    );
    await tick();
    cleanupDone = true;
    return new Uint8Array();
  });
  const response = service.handler(request());
  await tick();
  await service.close();
  assert(cleanupDone);
  assertEquals((await response).status, 503);
  assertEquals((await service.handler(new Request("http://thumbnail/health"))).status, 503);
});

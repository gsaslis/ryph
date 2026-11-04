import { test } from "bun:test";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  artifactThumbnailFromEnv,
  httpArtifactThumbnail,
} from "../src/adapters/artifact_html/http_thumbnail.ts";
import {
  ArtifactThumbnails,
  isThumbnail,
  THUMBNAIL_MAX_BYTES,
  thumbnailKey,
} from "../src/core/artifact_thumbnails.ts";
import type { Artifact } from "../src/core/artifacts.ts";
import type { ArtifactStore } from "../src/ports/artifact_store.ts";

function png(): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, 1200);
  new DataView(bytes.buffer).setUint32(20, 750);
  return bytes;
}

test("thumbnail client: opt-in, URL validation, fixed raster and bounded responses", async () => {
  assertEquals(artifactThumbnailFromEnv(() => undefined), null);
  for (const url of ["file:///tmp/page", "https://user:pass@renderer", "http://renderer?q=x"]) {
    assertThrows(() => httpArtifactThumbnail(url));
  }
  let called = false;
  const renderer = httpArtifactThumbnail(
    "http://renderer:7491",
    ((url, init) => {
      called = true;
      assertEquals(String(url), "http://renderer:7491/render");
      assertEquals(init?.method, "POST");
      assertEquals(init?.redirect, "error");
      assertEquals(new TextDecoder().decode(init?.body as Uint8Array), "<h1>Test</h1>");
      return Promise.resolve(new Response(png(), { headers: { "content-type": "image/png" } }));
    }) as typeof fetch,
  );
  assertEquals(await renderer.render("<h1>Test</h1>"), png());
  assertEquals(called, true);
  for (
    const response of [
      new Response("busy", { status: 503 }),
      new Response(png(), { headers: { "content-type": "text/html" } }),
      new Response(new Uint8Array(THUMBNAIL_MAX_BYTES + 1), {
        headers: { "content-type": "image/png" },
      }),
      new Response("not an image", { headers: { "content-type": "image/png" } }),
    ]
  ) {
    const bad = httpArtifactThumbnail(
      "http://renderer",
      (() => Promise.resolve(response)) as unknown as typeof fetch,
    );
    await assertRejects(() => bad.render("test"));
  }
  const wrongSize = png();
  new DataView(wrongSize.buffer).setUint32(16, 99999);
  assertEquals(isThumbnail(wrongSize), false);
});

test("thumbnail cache: bounded admission and delete during upload removes late bytes", async () => {
  let live = true;
  let begin!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => begin = resolve);
  const gate = new Promise<void>((resolve) => release = resolve);
  const bytes = new Map<string, Uint8Array>();
  const artifacts = {
    get: () => Promise.resolve(live ? { currentVersion: 1 } as Artifact : null),
    versionContent: () => Promise.resolve({ servedHtml: "<p>Prepared</p>", images: [] }),
  } as unknown as ArtifactStore;
  const cache = new ArtifactThumbnails({
    artifacts,
    store: { listAttachmentsByIds: () => Promise.resolve([]) },
    renderer: { render: () => Promise.resolve(png()) },
    blobs: {
      get: () => Promise.resolve(null),
      put: async (key, value) => {
        begin();
        await gate;
        bytes.set(key, value);
      },
      delete: (key) => {
        bytes.delete(key);
        return Promise.resolve();
      },
    },
  }, 1);
  const first = cache.get("art-a", 1);
  await started;
  assertEquals((await cache.get("art-b", 1)).kind, "unavailable");
  const duplicate = cache.get("art-a", 1);
  live = false;
  await cache.drop("art-a", 1);
  release();
  assertEquals(await first, { kind: "missing" });
  assertEquals(await duplicate, { kind: "missing" });
  assertEquals(bytes.has(thumbnailKey("art-a", 1)), false);
});

test("thumbnail cache: storage cancellation releases admission and bounds cleanup", async () => {
  let cancelled = 0;
  const stalled = (signal?: AbortSignal): Promise<never> =>
    new Promise((_, reject) => {
      signal!.throwIfAborted();
      signal!.addEventListener("abort", () => {
        cancelled++;
        reject(signal!.reason);
      }, { once: true });
    });
  const cache = new ArtifactThumbnails({
    artifacts: { get: () => Promise.resolve({ currentVersion: 1 }) } as unknown as ArtifactStore,
    store: { listAttachmentsByIds: () => Promise.resolve([]) },
    blobs: {
      get: (_, signal) => stalled(signal),
      put: async () => {},
      delete: (_, signal) => stalled(signal),
    },
    renderer: null,
    budgetMs: 5,
    cleanupBudgetMs: 5,
  }, 1);
  assertEquals(await cache.get("art-a", 1), { kind: "unavailable" });
  assertEquals(cancelled, 1);
  // A different key gets admission after the aborted read, not a permanently busy response.
  assertEquals(await cache.get("art-b", 1), { kind: "unavailable" });
  assertEquals(cancelled, 2);
  await cache.drop("art-a", 100);
  assertEquals(cancelled, 6, "only four deletes were started before the cleanup budget elapsed");
});

// Opt-in: RYPH_TEST_THUMBNAIL_IMAGE=ryph-browser:dev bun test packages/host/tests/artifact_thumbnail_docker_test.ts
// Requires an already-built browser image and a Docker daemon. Never downloads an image.
import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { dockerArtifactThumbnail } from "../src/artifact_thumbnail.ts";

const image = process.env.RYPH_TEST_THUMBNAIL_IMAGE;
test.skipIf(!image)("real Docker: sandboxed offline thumbnail over stdio", async () => {
  const renderer = dockerArtifactThumbnail({
    image: image!,
    runtime: process.env.RYPH_DOCKER_RUNTIME,
    prefetch: false,
    warn: (message) => console.warn(message),
  });
  try {
    const png = await renderer.render(
      "<!doctype html><html><body><h1>Offline preview</h1></body></html>",
    );
    assert(png.byteLength >= 33 && png.byteLength <= 4 * 1024 * 1024);
    assertEquals(Array.from(png.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    assertEquals(view.getUint32(16), 1200);
    assertEquals(view.getUint32(20), 750);
  } finally {
    await renderer.shutdown();
  }
}, 40_000);

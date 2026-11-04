// The screenshot size rule without a browser (core/screenshot.ts).

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { captureNote, planCapture, pngSize } from "../src/core/screenshot.ts";

test("a region that fits is taken as it is", () => {
  const region = { x: 0, y: 0, width: 1280, height: 2000 };
  assertEquals(planCapture(region), { clip: region, scale: 1, cropped: false });
  assertEquals(captureNote("page", region, planCapture(region)), null);
});

test("a little too big is scaled, never past 2000 px a side", () => {
  for (const [width, height] of [[1280, 2500], [3840, 2160], [2001, 10], [1280, 3999]]) {
    const plan = planCapture({ x: 0, y: 0, width, height });
    assert(!plan.cropped);
    assert(plan.scale < 1 && plan.scale >= 0.5);
    assert(Math.ceil(width * plan.scale) <= 2000 && Math.ceil(height * plan.scale) <= 2000);
  }
  const plan = planCapture({ x: 0, y: 0, width: 3840, height: 2160 });
  assertEquals(
    captureNote("viewport", { x: 0, y: 0, width: 3840, height: 2160 }, plan),
    "The viewport is 3840x2160 px; it is shown at 52% (an image is at most 2000 px on a side).",
  );
});

test("far too big is cropped at half scale, from where the region starts", () => {
  const region = { x: 10, y: 300, width: 1280, height: 30_000 };
  const plan = planCapture(region);
  assertEquals(plan, {
    clip: { x: 10, y: 300, width: 1280, height: 4000 },
    scale: 0.5,
    cropped: true,
  });
  assertStringIncludes(captureNote("page", region, plan)!, "top-left 1280x4000 px at 50%");
  const wide = planCapture({ x: 0, y: 0, width: 9000, height: 9000 });
  assertEquals([wide.clip.width, wide.clip.height, wide.scale], [4000, 4000, 0.5]);
});

test("pngSize reads the IHDR and refuses anything else", () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(png.buffer).setUint32(16, 640);
  new DataView(png.buffer).setUint32(20, 2000);
  assertEquals(pngSize(png), { width: 640, height: 2000 });
  assertEquals(pngSize(new Uint8Array(24)), null);
});

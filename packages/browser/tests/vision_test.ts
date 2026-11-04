// The sidecar for a model that cannot see (`vision: false` on /configure), and screenshots held to
// what the images extension and pi accept (core/screenshot.ts), in a REAL Chromium.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { imageSize, SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_SIDE } from "../src/core/screenshot.ts";
import {
  type CallResult,
  type Harness,
  haveChromium,
  pages,
  refOf,
  startHarness,
  textOf,
} from "./_harness.ts";

const chromiumTest = test.skipIf(!haveChromium);

async function using(harness: Promise<Harness>, fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await harness;
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

/** The image of a screenshot result, decoded, with its pixel size; asserts the limits hold. */
function imageOf(r: CallResult): { bytes: Uint8Array; width: number; height: number } {
  assert(!r.isError, textOf(r));
  const image = r.content.find((c) => c.type === "image");
  assert(image?.data, "no image");
  // The images extension's own measure: 5 MiB of base64.
  assert(image.data.length < 5 * 1024 * 1024);
  const bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
  assert(bytes.byteLength <= SCREENSHOT_MAX_BYTES);
  const size = imageSize(bytes);
  assert(size, "not a PNG or JPEG");
  assert(
    size.width <= SCREENSHOT_MAX_SIDE && size.height <= SCREENSHOT_MAX_SIDE,
    JSON.stringify(size),
  );
  return { bytes, ...size };
}

const LINES = Array.from({ length: 1500 }, (_, i) => `<p>Line ${i} of a long page</p>`).join("");

chromiumTest(
  "vision off: no screenshot tool, a call to one is refused, snapshot does not mention it",
  async () => {
    const site = await pages({ "/": "<title>Plain</title><h1>Plain</h1>" });
    await using(startHarness({}, { vision: false }), async (h) => {
      const tools = await h.tools();
      assert(tools.length > 0);
      assert(!tools.some((t) => t.name === "screenshot"));
      for (const t of tools) {
        assert(!JSON.stringify(t).toLowerCase().includes("screenshot"), t.name);
      }
      const nav = await h.call("navigate", { url: site.url });
      assert(!textOf(nav).toLowerCase().includes("screenshot"));
      const shot = await h.call("screenshot", {});
      assert(shot.isError);
      assertStringIncludes(textOf(shot), "cannot see images");
      assert(!shot.content.some((c) => c.type === "image"));
      // The browser still works for everything else.
      assertStringIncludes(textOf(await h.call("snapshot")), "Plain");
    });
    await site.close();
  },
);

chromiumTest(
  "screenshots stay within 2000 px a side and the byte cap: a long page, a wide viewport, a tall element",
  async () => {
    const site = await pages({
      "/": `<title>Long</title><body style="margin:0;font:16px sans-serif">` +
        `<div id="tall" role="region" aria-label="Tall">${LINES}</div></body>`,
    });
    await using(startHarness(), async (h) => {
      assert((await h.tools()).some((t) => t.name === "screenshot"));
      const nav = textOf(await h.call("navigate", { url: site.url }));

      // The default viewport: as it always was, unscaled, and small.
      const viewport = await h.call("screenshot", {});
      const v = imageOf(viewport);
      assertEquals([v.width, v.height], [1280, 800]);
      assert(v.bytes.byteLength < 512 * 1024, `${v.bytes.byteLength}`);
      assertStringIncludes(textOf(viewport), "1280x800 px");

      // A page ~30000 px tall: half scale, cropped, and said so.
      const full = await h.call("screenshot", { fullPage: true });
      const f = imageOf(full);
      assertEquals([f.width, f.height], [640, 2000]);
      assertStringIncludes(textOf(full), "this shows its top-left 1280x4000 px at 50%");

      // An element as tall as the page: the same rule.
      const el = imageOf(await h.call("screenshot", { ref: refOf(nav, /region "Tall"/) }));
      assertEquals(el.height, 2000);
      assert(el.width <= 640);

      // The widest viewport resize allows: scaled to fit, not cropped.
      await h.call("resize", { width: 3840, height: 2160 });
      const wide = await h.call("screenshot", {});
      const w = imageOf(wide);
      assert(w.width <= SCREENSHOT_MAX_SIDE && w.width > 1900, `${w.width}`);
      assertStringIncludes(textOf(wide), "The viewport is 3840x2160 px; it is shown at 52%");
    });
    await site.close();
  },
);

chromiumTest(
  "a scaled screenshot disables animations as Playwright's own does, and plays them after",
  async () => {
    const site = await pages({
      "/": `<title>Moving</title><style>` +
        `@keyframes grow { from { width: 0 } to { width: 100px } }` +
        `#fin { animation: grow 1000s linear } #inf { animation: grow 1s linear infinite }` +
        `</style><body style="margin:0"><div id="fin">a</div><div id="inf">b</div>${LINES}</body>`,
    });
    await using(startHarness(), async (h) => {
      await h.call("navigate", { url: site.url });
      const states = async () =>
        textOf(
          await h.call("evaluate", {
            function: "() => document.getAnimations().map((a) => a.effect.target.id + ':' + " +
              "a.playState).sort().join(',')",
          }),
        );
      assertStringIncludes(await states(), '"fin:running,inf:running"');
      // A full page this long is past the cap: captured over CDP.
      const full = await h.call("screenshot", { fullPage: true });
      assertStringIncludes(textOf(full), "at 50%");
      // The 1000 s one was finished (a finished animation leaves the list); the infinite one
      // was cancelled for the capture and plays again.
      assertStringIncludes(await states(), '"inf:running"');
    });
    await site.close();
  },
);

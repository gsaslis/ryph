// The plain-text conversion: what it keeps, and that it stays linear on the shapes that made the
// regex version it replaced quadratic (an unclosed `<`, a `<script` with no end tag).

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { htmlToText } from "../src/core/text.ts";
import { workerConverter } from "../src/adapters/convert/worker_converter.ts";

const MIB2 = 2 * 1024 * 1024;

test("htmlToText keeps the words and the shape of the blocks", () => {
  assertEquals(
    htmlToText(
      "<!doctype html><html><HEAD><title>Guide &amp; more</title><meta x></head><body>" +
        "<h1>Deploy</h1><p>Run <b>it</b>.</p><script>if (a<b) x()</script>" +
        "<p>a &amp;lt; b, a < b</p><style>.x{}</style><ul><li>one</li><li>two</li></ul>" +
        "<!-- <p>hidden</p> -->line<br>break</body></html>",
    ),
    {
      title: "Guide & more",
      text: "# Deploy\nRun it.\na &lt; b, a < b\n- one\n- two\nline\nbreak",
    },
  );
  assertEquals(htmlToText("<p>a &amp; b</p><style>.x{}</style><ul><li>one</li></ul>"), {
    title: null,
    text: "a & b\n- one",
  });
  assertEquals(htmlToText("<p>a</p>\n\n\n\n<p>b</p>   \n"), { title: null, text: "a\n\nb" });
});

test("htmlToText is linear on the shapes that were quadratic", () => {
  for (
    const [name, html] of [
      ["unclosed <", "<".repeat(MIB2)],
      ["unclosed <script", "<script".repeat(MIB2 / 7)],
      ["unclosed <title", "<title".repeat(MIB2 / 6)],
      ["unclosed <head", "<head>".repeat(MIB2 / 6)],
      ["tags without an end", "<a ".repeat(MIB2 / 3)],
      ["unclosed comments", "<!--".repeat(MIB2 / 4)],
      ["entity soup", "&amp".repeat(MIB2 / 4)],
      ["blank runs", " ".repeat(MIB2)],
    ] as const
  ) {
    const started = performance.now();
    htmlToText(html);
    const took = performance.now() - started;
    // The regex version took ~5 s at 200 KB of the first two; linear is tens of milliseconds at
    // 2 MiB. The bound leaves room for a slow CI machine and none for a quadratic scan.
    assert(took < 200, `${name}: ${Math.round(took)} ms for 2 MiB`);
  }
});

test("the worker converts to text when asked to", async () => {
  const converter = workerConverter({ format: "text" });
  try {
    const page = await converter.convert(
      "<html><head><title>T</title></head><body><p>one</p><p>two</p></body></html>",
      "https://example.com/",
    );
    assertEquals(page, { title: "T", markdown: "one\ntwo", via: "text" });
  } finally {
    converter.close();
  }
});

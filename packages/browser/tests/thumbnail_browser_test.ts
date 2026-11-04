import { test } from "bun:test";
import { Writable } from "node:stream";
import { runThumbnailCli } from "../src/thumbnail_cli.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { type BrowserServer, chromium } from "playwright-core";
import { renderThumbnail } from "../src/adapters/thumbnail.ts";
import { createThumbnailService } from "../src/http/thumbnail.ts";
import { pngSize } from "../src/core/screenshot.ts";
import { executable, haveChromium } from "./_harness.ts";

test.skipIf(!haveChromium)(
  "offline thumbnail: fixed PNG, inline image, no script or outbound requests, fresh browser",
  async () => {
    let requests = 0;
    const sink = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return new Response("bad");
      },
    });
    // Like the existing browser harness, local tests explicitly allow an unsandboxed browser.
    // Production defaults to required, tested separately; never auto-fallback in the renderer.
    const service = createThumbnailService((html, signal, deadlineAt) =>
      renderThumbnail(html, signal, {
        chromiumSandbox: false,
        deadlineAt,
        ...(executable ? { executablePath: executable } : {}),
      })
    );
    const render = async (body: string) => {
      const response = await service.handler(
        new Request("http://thumbnail/render", {
          method: "POST",
          headers: { "content-type": "text/html" },
          body,
        }),
      );
      assertEquals(response.status, 200);
      assertEquals(response.headers.get("content-type"), "image/png");
      const png = new Uint8Array(await response.arrayBuffer());
      assertEquals(pngSize(png), { width: 1200, height: 750 });
      assert(png.byteLength <= 4 * 1024 * 1024);
      return png;
    };
    try {
      const base = "<style>html,body{margin:0;background:#fff}body{height:3000px}</style>";
      const blank = await render(base);
      const hostile = await render(`${base}
      <script>document.body.style.background='red';fetch('${sink.url}script')</script>
      <link rel="stylesheet" href="${sink.url}style">
      <style>@import url('${sink.url}import');body{background-image:url('${sink.url}background')}</style>
      <iframe style="display:none" src="${sink.url}frame"></iframe>
      <img style="display:none" src="${sink.url}image">
    `);
      assertEquals(hostile, blank, "scripts and network resources must not alter the image");
      const inline = await render(
        `${base}<img width="100" height="100" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect width='100' height='100' fill='red'/%3E%3C/svg%3E">`,
      );
      assert(inline.byteLength !== blank.byteLength, "data images must render");
      assertEquals(await render(base), blank, "a fresh job must not retain prior page state");
      assertEquals(requests, 0);
    } finally {
      await service.close();
      await sink.stop(true);
    }
  },
);

test.skipIf(!haveChromium)("one-shot thumbnail emits a real fixed-size PNG", async () => {
  const chunks: Uint8Array[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(new Uint8Array(chunk));
      done();
    },
  });
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("<h1>Offline thumbnail</h1>"));
      controller.close();
    },
  });
  await runThumbnailCli(input, output, (html, signal, deadlineAt) =>
    renderThumbnail(html, signal, {
      chromiumSandbox: false,
      deadlineAt,
      ...(executable ? { executablePath: executable } : {}),
    }));
  assertEquals(pngSize(Buffer.concat(chunks)), { width: 1200, height: 750 });
});

test.skipIf(!haveChromium)(
  "thumbnail reaps a real browser returned after cancellation",
  async () => {
    const controller = new AbortController();
    let server: BrowserServer | undefined;
    await assertRejects(() =>
      renderThumbnail("x", controller.signal, {
        chromiumSandbox: false,
        ...(executable ? { executablePath: executable } : {}),
      }, async (options) => {
        server = await chromium.launchServer(options);
        controller.abort();
        return server;
      })
    );
    assert(server);
    assert(
      server.process().exitCode !== null || server.process().signalCode !== null,
      "browser process must have exited before cleanup completes",
    );
  },
);

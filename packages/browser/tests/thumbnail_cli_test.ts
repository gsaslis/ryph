import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Writable } from "node:stream";
import { runThumbnailCli } from "../src/thumbnail_cli.ts";
import { MAX_HTML_BYTES, MAX_PNG_BYTES } from "../src/http/thumbnail.ts";

function input(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}
function sink() {
  const chunks: Uint8Array[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(new Uint8Array(chunk));
      done();
    },
  });
  return { output, chunks };
}

test("thumbnail CLI streams UTF-8 and emits only bounded raw bytes", async () => {
  const { output, chunks } = sink();
  const png = new Uint8Array(150_000).fill(123);
  await runThumbnailCli(
    input(new Uint8Array([0xc3]), new Uint8Array([0xa9])),
    output,
    (html, signal, deadlineAt) => {
      assertEquals(html, "é");
      assert(!signal.aborted);
      assert(deadlineAt > Date.now());
      return Promise.resolve(png);
    },
  );
  assertEquals(Buffer.concat(chunks), Buffer.from(png));
  assert(chunks.every((chunk) => chunk.length <= 64 * 1024));
});

test("thumbnail CLI refuses malformed, oversized and failed renders before stdout", async () => {
  for (
    const body of [
      new Uint8Array([0xff]),
      new Uint8Array([0xc3]),
      new Uint8Array(MAX_HTML_BYTES + 1),
    ]
  ) {
    const { output, chunks } = sink();
    await assertRejects(() =>
      runThumbnailCli(
        input(body),
        output,
        () => Promise.reject(new Error("renderer should not run")),
      )
    );
    assertEquals(chunks, []);
  }
  for (
    const render of [
      () => Promise.resolve(new Uint8Array(MAX_PNG_BYTES + 1)),
      () => Promise.reject(new Error("SECRET HTML")),
    ]
  ) {
    const { output, chunks } = sink();
    const error = await assertRejects(() => runThumbnailCli(input(), output, render));
    assert(error instanceof Error);
    assert(!error.message.includes("SECRET"));
    assertEquals(chunks, []);
  }
});

test("thumbnail CLI deadline cancels stdin and never starts rendering", async () => {
  let cancelled = false;
  let rendered = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  await assertRejects(() =>
    runThumbnailCli(body, sink().output, () => {
      rendered = true;
      return Promise.resolve(new Uint8Array());
    }, { deadlineMs: 10 })
  );
  assert(cancelled);
  assert(!rendered);
});

test("thumbnail CLI deadline covers stdout backpressure with one small pending write", async () => {
  let writes = 0;
  const output = new Writable({
    write(chunk, _encoding, _done) {
      writes++;
      assert(chunk.length <= 64 * 1024);
      // A caller which never reads must not keep this job alive.
    },
  });
  await assertRejects(() =>
    runThumbnailCli(input(), output, () => Promise.resolve(new Uint8Array(MAX_PNG_BYTES)), {
      deadlineMs: 20,
    })
  );
  assertEquals(writes, 1);
  assert(output.destroyed);
});

test("thumbnail CLI external cancellation waits for renderer cleanup", async () => {
  const controller = new AbortController();
  let cleaned = false;
  await assertRejects(() =>
    runThumbnailCli(input(), sink().output, async (_html, signal) => {
      const aborted = new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve())
      );
      controller.abort();
      await aborted;
      await new Promise((resolve) => setTimeout(resolve, 5));
      cleaned = true;
      throw new Error("cancelled");
    }, { signal: controller.signal })
  );
  assert(cleaned);
});

test("thumbnail CLI entrypoint fails with concise stderr and empty stdout", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "src/thumbnail_cli.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdin: new Uint8Array([0xff]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assertEquals(code, 1);
  assertEquals(stdout.byteLength, 0);
  assert(stderr.startsWith("thumbnail failed"));
  assertEquals(stderr.trim().split("\n").length, 1);
});

test("thumbnail CLI handles a broken output pipe", async () => {
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done(new Error("EPIPE"));
    },
  });
  await assertRejects(() =>
    runThumbnailCli(input(), output, () => Promise.resolve(new Uint8Array([1])))
  );
});

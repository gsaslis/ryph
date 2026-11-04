// One container, one document, no HTTP listener and no agent sidecar.
import { Readable, type Writable } from "node:stream";
import { renderThumbnail, thumbnailSandbox } from "./adapters/thumbnail.ts";
import {
  createThumbnailService,
  THUMBNAIL_DEADLINE_MS,
  type ThumbnailRenderer,
} from "./http/thumbnail.ts";

/** Await each small write, not just enqueue a potentially multi-MiB PNG on a blocked pipe. */
async function writePng(output: Writable, png: Uint8Array, signal: AbortSignal): Promise<void> {
  for (let offset = 0; offset < png.byteLength; offset += 64 * 1024) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        output.removeListener("error", fail);
      };
      const fail = () => {
        cleanup();
        reject(new Error("thumbnail output failed"));
      };
      const abort = () => {
        cleanup();
        reject(new Error("thumbnail cancelled or deadline exceeded"));
      };
      output.once("error", fail);
      signal.addEventListener("abort", abort, { once: true });
      output.write(png.subarray(offset, offset + 64 * 1024), (error) => {
        cleanup();
        if (error) reject(new Error("thumbnail output failed"));
        else resolve();
      });
    });
  }
}

/** Injection is only for stream/lifecycle tests; the entrypoint always uses renderThumbnail. */
export async function runThumbnailCli(
  input: ReadableStream<Uint8Array>,
  output: Writable,
  render: ThumbnailRenderer,
  options: { signal?: AbortSignal; deadlineMs?: number } = {},
): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const deadlineMs = options.deadlineMs ?? THUMBNAIL_DEADLINE_MS;
  const deadlineAt = Date.now() + deadlineMs;
  const timer = setTimeout(cancel, deadlineMs);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  // Error events can arrive after a write callback or cancellation; always observe them.
  const outputError = () => controller.abort();
  output.on("error", outputError);
  const service = createThumbnailService(
    (html, signal) => render(html, signal, deadlineAt),
    { deadlineMs },
  );
  let completed = false;
  try {
    const response = await service.handler(
      new Request("http://thumbnail/render", {
        method: "POST",
        headers: { "content-type": "text/html; charset=utf-8" },
        body: input,
        signal: controller.signal,
      }),
    );
    if (!response.ok) throw new Error("thumbnail input or render failed");
    controller.signal.throwIfAborted();
    const png = new Uint8Array(await response.arrayBuffer());
    await writePng(output, png, controller.signal);
    controller.signal.throwIfAborted();
    completed = true;
  } finally {
    // Do not lose ownership of a late browser launch. close waits for its tree to be reaped.
    controller.abort();
    await service.close();
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    // A cancelled write must not keep the one-shot process alive indefinitely.
    if (!completed) {
      output.once("close", () => output.removeListener("error", outputError));
      output.destroy();
    } else {
      output.removeListener("error", outputError);
    }
  }
}

export async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const chromiumSandbox = thumbnailSandbox(process.env.RYPH_THUMBNAIL_SANDBOX);
    await runThumbnailCli(
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
      process.stdout,
      (html, signal, deadlineAt) =>
        renderThumbnail(html, signal, {
          chromiumSandbox,
          deadlineAt,
          ...(process.env.RYPH_BROWSER_EXECUTABLE
            ? { executablePath: process.env.RYPH_BROWSER_EXECUTABLE }
            : {}),
        }),
      { signal: controller.signal },
    );
  } catch {
    // Never expose HTML, Playwright errors, environment values, or stack traces.
    process.stderr.write(
      "thumbnail failed (invalid input, unavailable sandbox, cancellation or deadline)\n",
    );
    process.exitCode = 1;
  } finally {
    process.stdin.destroy();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (import.meta.main) await main();

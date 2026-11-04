// Separate, credential-free service. Never compose the agent's browser sidecar here.
import { chmodSync } from "node:fs";
import { prepareThumbnailSocket } from "./thumbnail_socket.ts";
import { MAX_HTML_BYTES, type ThumbnailRenderer } from "./http/thumbnail.ts";
import { renderThumbnail, thumbnailSandbox } from "./adapters/thumbnail.ts";
import { prepareThumbnailService } from "./thumbnail_startup.ts";

// Renderer injection is for listener lifecycle tests, never selected through the environment.
export async function main(render?: ThumbnailRenderer): Promise<void> {
  const controller = new AbortController();
  let service: Awaited<ReturnType<typeof prepareThumbnailService>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    controller.abort();
    stopping ??= (async () => {
      await service?.close();
      await server?.stop(true);
    })();
    return stopping;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const chromiumSandbox = thumbnailSandbox(process.env.RYPH_THUMBNAIL_SANDBOX);
    const socket = process.env.RYPH_THUMBNAIL_SOCKET;
    if (socket) await prepareThumbnailSocket(socket);
    service = await prepareThumbnailService(
      render ?? ((html, signal, deadlineAt) =>
        renderThumbnail(html, signal, {
          chromiumSandbox,
          deadlineAt,
          ...(process.env.RYPH_BROWSER_EXECUTABLE
            ? { executablePath: process.env.RYPH_BROWSER_EXECUTABLE }
            : {}),
        })),
      { signal: controller.signal },
    );
    controller.signal.throwIfAborted();
    server = Bun.serve({
      ...(socket ? { unix: socket } : { hostname: "0.0.0.0", port: 7491 }),
      maxRequestBodySize: MAX_HTML_BYTES,
      fetch: service.handler,
    });
    if (socket) chmodSync(socket, 0o660);
  } catch (error) {
    await service?.close();
    await server?.stop(true);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    throw error;
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    process.stderr.write(
      "thumbnail startup failed; check startup diagnostics, sandbox policy and socket configuration\n",
    );
    process.exitCode = 1;
  }
}

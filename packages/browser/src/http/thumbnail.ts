export const MAX_HTML_BYTES = 24 * 1024 * 1024;
export const MAX_PNG_BYTES = 4 * 1024 * 1024;
export const THUMBNAIL_DEADLINE_MS = 15_000;
export type ThumbnailRenderer = (
  html: string,
  signal: AbortSignal,
  deadlineAt: number,
) => Promise<Uint8Array>;

class Refusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readHtml(request: Request, signal: AbortSignal): Promise<string> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > MAX_HTML_BYTES) {
    void request.body?.cancel().catch(() => {});
    throw new Refusal(413, "HTML exceeds 24 MiB");
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let bytes = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HTML_BYTES) throw new Refusal(413, "HTML exceeds 24 MiB");
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch (error) {
    cancel();
    if (error instanceof TypeError) throw new Refusal(400, "HTML must be UTF-8");
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** Admission is held until cleanup settles, even if the caller already received a timeout. */
export function createThumbnailService(
  render: ThumbnailRenderer,
  options: { deadlineMs?: number } = {},
) {
  let active: { controller: AbortController; done: Promise<Response> } | undefined;
  let closed = false;
  const handler = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") {
      return new Response(closed ? "stopping" : "ok", { status: closed ? 503 : 200 });
    }
    if (path !== "/render" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    if (active || closed) return new Response("busy", { status: 503 });
    const contentType = request.headers.get("content-type") ?? "";
    if (!/^text\/html(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType)) {
      return new Response("expected text/html; charset=utf-8", { status: 415 });
    }
    const deadlineAt = Date.now() + (options.deadlineMs ?? THUMBNAIL_DEADLINE_MS);
    const controller = new AbortController();
    const abort = () => controller.abort(new Refusal(499, "request cancelled"));
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<Response>((resolve) => {
      const onAbort = () => {
        const reason = controller.signal.reason;
        resolve(
          new Response(reason instanceof Refusal ? reason.message : "stopping", {
            status: reason instanceof Refusal ? reason.status : 503,
          }),
        );
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
      timer = setTimeout(() => {
        controller.abort(new Refusal(504, "thumbnail deadline exceeded"));
      }, options.deadlineMs ?? THUMBNAIL_DEADLINE_MS);
    });
    const done = (async () => {
      try {
        const html = await readHtml(request, controller.signal);
        controller.signal.throwIfAborted();
        const png = await render(html, controller.signal, deadlineAt);
        controller.signal.throwIfAborted();
        if (png.byteLength > MAX_PNG_BYTES) throw new Refusal(413, "PNG exceeds 4 MiB");
        return new Response(new Uint8Array(png), {
          headers: { "content-type": "image/png", "cache-control": "no-store" },
        });
      } catch (error) {
        return new Response(error instanceof Refusal ? error.message : "thumbnail render failed", {
          status: error instanceof Refusal ? error.status : 500,
        });
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        active = undefined;
      }
    })();
    active = { controller, done };
    return await Promise.race([done, interrupted]);
  };
  return {
    handler,
    async close() {
      closed = true;
      active?.controller.abort();
      await active?.done;
    },
  };
}

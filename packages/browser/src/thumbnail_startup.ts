import { createThumbnailService, type ThumbnailRenderer } from "./http/thumbnail.ts";

const STARTUP_HTML = "<!doctype html><html><body>Thumbnail readiness check</body></html>";

/** Emit only allowlisted diagnostics: even browser errors can contain document text or secrets. */
export function thumbnailFailureCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    /Chromium sandboxing failed|No usable sandbox|Failed to move to new namespace|Operation not permitted|zygote_host_impl|Running as root without --no-sandbox/i
      .test(message)
  ) {
    return "sandbox_unavailable: check non-root UID, user namespaces and the reviewed Chromium seccomp profile; sandbox remains required";
  }
  if (/Executable doesn't exist|executable.*(?:not found|does not exist)|ENOENT/i.test(message)) {
    return "executable_missing: install the image's pinned Playwright Chromium or check RYPH_BROWSER_EXECUTABLE";
  }
  if (
    /error while loading shared libraries|Host system is missing dependencies|cannot open shared object file/i
      .test(message)
  ) {
    return "dependencies_missing: use the browser image with Chromium system libraries installed";
  }
  if (/timeout|timed out|deadline/i.test(message)) return "deadline_exceeded";
  return "browser_failed: check Chromium installation, sandbox and container resource limits";
}

/** No listener may be opened until this trusted-document render and process cleanup succeed. */
export async function prepareThumbnailService(
  render: ThumbnailRenderer,
  options: { signal?: AbortSignal; deadlineMs?: number; log?: (message: string) => void } = {},
) {
  const log = options.log ?? ((message: string) => {
    process.stderr.write(`${message}\n`);
  });
  let starting = true;
  let startupFailure: string | undefined;
  const service = createThumbnailService(async (html, signal, deadlineAt) => {
    try {
      return await render(html, signal, deadlineAt);
    } catch (error) {
      const category = thumbnailFailureCategory(error);
      if (starting) startupFailure = category;
      else log(`thumbnail.render_failed ${category}`);
      throw error;
    }
  }, { ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}) });
  try {
    const response = await service.handler(
      new Request("http://thumbnail/render", {
        method: "POST",
        headers: { "content-type": "text/html" },
        body: STARTUP_HTML,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    );
    if (!response.ok) {
      // Wait for the launch owner to reap a late process before reporting startup failure.
      await service.close();
      const category = response.status === 504
        ? "deadline_exceeded"
        : response.status === 499
        ? "cancelled"
        : startupFailure ?? "self_test_failed";
      log(`thumbnail.startup_failed ${category}`);
      throw new Error("thumbnail startup self-test failed");
    }
    await response.body?.cancel();
    starting = false;
    return service;
  } catch (error) {
    await service.close();
    throw error;
  }
}

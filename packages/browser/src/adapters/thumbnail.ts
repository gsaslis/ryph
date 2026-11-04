import { type BrowserServer, chromium } from "playwright-core";
import { THUMBNAIL_DEADLINE_MS } from "../http/thumbnail.ts";

export const THUMBNAIL_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox";
const DOCUMENT_URL = "https://thumbnail.invalid/document";

/** Unlike the interactive sidecar there is never a sandbox fallback. */
export function thumbnailSandbox(value: string | undefined): boolean {
  if (value === undefined || value === "required") return true;
  if (value === "off") return false;
  throw new Error("RYPH_THUMBNAIL_SANDBOX must be required or off");
}

export interface ThumbnailBrowserOptions {
  chromiumSandbox?: boolean;
  executablePath?: string;
  deadlineAt?: number;
}

/** A fresh browser process per job, including after errors. kill() reaps its process tree. */
export async function renderThumbnail(
  html: string,
  signal: AbortSignal,
  options: ThumbnailBrowserOptions = {},
  // Injection only for lifecycle tests; production always uses Playwright's process owner.
  launch: typeof chromium.launchServer = chromium.launchServer.bind(chromium),
): Promise<Uint8Array> {
  const deadlineAt = options.deadlineAt ?? Date.now() + THUMBNAIL_DEADLINE_MS;
  const remaining = () => Math.max(1, deadlineAt - Date.now());
  let server: BrowserServer | undefined;
  let killing: Promise<void> | undefined;
  const kill = () => {
    if (server) killing ??= server.kill();
    // Observe immediately: an abort listener cannot return a rejected promise.
    void killing?.catch(() => {});
  };
  signal.addEventListener("abort", kill, { once: true });
  try {
    signal.throwIfAborted();
    // Playwright's launch timeout kills a process that fails to finish launching. If the
    // HTTP deadline fires during launch, retain admission until launch settles, then kill
    // even a late result. No Promise.race that loses ownership of a pending browser.
    server = await launch({
      headless: true,
      chromiumSandbox: options.chromiumSandbox ?? true,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      timeout: remaining(),
      host: "127.0.0.1",
    });
    signal.throwIfAborted();
    const browser = await chromium.connect(server.wsEndpoint(), { timeout: remaining() });
    signal.throwIfAborted();
    const context = await browser.newContext({
      viewport: { width: 1200, height: 750 },
      deviceScaleFactor: 1,
      javaScriptEnabled: false,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const page = await context.newPage();
    let served = false;
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (
        !served && request.url() === DOCUMENT_URL && request.isNavigationRequest() &&
        request.frame() === page.mainFrame() && request.method() === "GET"
      ) {
        served = true;
        await route.fulfill({
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": THUMBNAIL_CSP,
          },
          body: html,
        });
      } else {
        await route.abort("blockedbyclient");
      }
    });
    await page.goto(DOCUMENT_URL, { waitUntil: "load", timeout: remaining() });
    return await page.screenshot({
      type: "png",
      fullPage: false,
      animations: "disabled",
      timeout: remaining(),
    });
  } finally {
    signal.removeEventListener("abort", kill);
    kill();
    await killing;
  }
}

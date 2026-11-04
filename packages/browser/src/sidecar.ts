// The sidecar, composed: the live hub, the HTTP surface, and — once /configure has said which
// proxy to use — the browser and the tools on it. main.ts owns the socket and the process; the
// integration tests mount this same handler on a socket of their own.

import { ChromiumBrowser } from "./adapters/chromium.ts";
import type { SandboxMode } from "./core/config.ts";
import { LiveHub } from "./core/live.ts";
import { makeHandler } from "./http/server.ts";
import { ToolRunner } from "./mcp/tools.ts";

export interface SidecarDiag {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

export interface SidecarOptions {
  diag: SidecarDiag;
  /** A Chromium other than Playwright's installed headless shell. */
  executablePath?: string;
  /** RYPH_BROWSER_SANDBOX (core/config.ts); `auto` when not given. */
  sandbox?: SandboxMode;
  /** A tool call's overall deadline (mcp/tools.ts); tests shorten it. */
  callDeadlineMs?: number;
  /** When a tab's heap is collected (core/heap.ts HEAP_TIDY_MIN); tests lower it. */
  heapTidyBytes?: number;
}

export interface Sidecar {
  handler(req: Request): Promise<Response>;
  hub: LiveHub;
  /** Closes Chromium (if it ever launched) and ends the live stream. */
  close(): Promise<void>;
}

export function createSidecar(opts: SidecarOptions): Sidecar {
  const hub = new LiveHub();
  let browser: ChromiumBrowser | null = null;
  const handler = makeHandler({
    hub,
    diag: opts.diag,
    start: (config) => {
      browser = new ChromiumBrowser({
        proxy: config.proxy,
        hub,
        diag: opts.diag,
        ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
        ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
        ...(opts.heapTidyBytes ? { heapTidyBytes: opts.heapTidyBytes } : {}),
      });
      const runner = new ToolRunner(browser, opts.diag, opts.callDeadlineMs, {
        vision: config.vision,
      });
      return { list: () => runner.list, call: (name, args) => runner.call(name, args) };
    },
  });
  return {
    handler,
    hub,
    close: async () => {
      await (browser as ChromiumBrowser | null)?.close();
      hub.close();
    },
  };
}

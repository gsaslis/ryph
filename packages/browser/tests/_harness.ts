// What the real-Chromium tests share: whether a headless shell starts here, a sidecar on a socket
// of its own driven by the MCP SDK client, and its /live stream read alongside.

import { assert } from "@std/assert";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
// A devDependency, on purpose: the SDK is for tests only, and its dependency tree (~20 MB) stays
// out of the image's production install.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serve } from "@ryph/service";
import { createSidecar, type SidecarOptions } from "../src/sidecar.ts";
import type { LiveEvent } from "../src/core/live.ts";

export const executable = process.env.RYPH_BROWSER_EXECUTABLE;

/** Whether a headless Chromium starts here at all: asked of Playwright, not guessed from paths. */
async function chromiumAvailable(): Promise<string | null> {
  if (executable !== undefined && !existsSync(executable)) return `no browser at ${executable}`;
  try {
    const browser = await chromium.launch({
      headless: true,
      ...(executable ? { executablePath: executable } : {}),
    });
    await browser.close();
    return null;
  } catch (err) {
    // Missing binaries may skip locally; broken libraries/sandbox/runtime must fail tests.
    if (/Executable doesn't exist at/.test(String(err))) return String(err).split("\n")[0];
    throw err;
  }
}
const unavailable = await chromiumAvailable();
export const haveChromium = unavailable === null;
if (!haveChromium) {
  console.warn(`skipping the Chromium tests (bun run install-shell): ${unavailable}`);
}

export interface CallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export const textOf = (r: CallResult) =>
  r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

/** A ref from a report's snapshot, by the line it is on. */
export function refOf(report: string, pattern: RegExp): string {
  const line = report.split("\n").find((l) => pattern.test(l));
  assert(line, `no line matching ${pattern} in:\n${report}`);
  const ref = line.match(/\[ref=([a-z0-9]+)\]/)?.[1];
  assert(ref, `no ref on line: ${line}`);
  return ref;
}

/** A page server on loopback: path → HTML (or a handler for anything cleverer). */
export async function pages(
  routes: Record<string, string | ((req: Request) => Response | Promise<Response>)>,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = await serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
    const route = routes[new URL(req.url).pathname];
    if (route === undefined) return new Response("not found", { status: 404 });
    if (typeof route === "function") return route(req);
    return new Response(route, { headers: { "content-type": "text/html" } });
  });
  return { url: `http://127.0.0.1:${server.addr.port}`, close: () => server.shutdown() };
}

export interface Harness {
  call(name: string, args?: Record<string, unknown>): Promise<CallResult>;
  /** tools/list, as the MCP client gets it. */
  tools(): Promise<Array<{ name: string; description?: string }>>;
  /** Everything /live has carried so far. */
  lines: LiveEvent[];
  warnings: Array<{ event: string; fields?: Record<string, unknown> }>;
  close(): Promise<void>;
}

/**
 * A configured sidecar on a socket, an MCP client on it, and its live stream being read.
 * `configure` is added to the /configure body (`vision`).
 */
export async function startHarness(
  opts: Partial<SidecarOptions> = {},
  configure: { vision?: boolean } = {},
): Promise<Harness> {
  const warnings: Harness["warnings"] = [];
  const sidecar = createSidecar({
    diag: { info: () => {}, warn: (event, fields) => warnings.push({ event, fields }) },
    ...(executable ? { executablePath: executable } : {}),
    ...opts,
  });
  const server = await serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    sidecar.handler,
  );
  const base = `http://127.0.0.1:${server.addr.port}`;
  const token = "t".repeat(64);
  const configured = await fetch(`${base}/configure`, {
    method: "POST",
    body: JSON.stringify({ token, proxy: null, ...configure }),
  });
  await configured.body?.cancel();
  assert(configured.status === 204, `configure answered ${configured.status}`);
  const lines: LiveEvent[] = [];
  const live = await fetch(`${base}/live`, { headers: { authorization: `Bearer ${token}` } });
  const reading = (async () => {
    const reader = live.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        lines.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
      }
    }
  })().catch(() => {});
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return {
    call: async (name, args = {}) =>
      await client.callTool({ name, arguments: args }, undefined, {
        timeout: 120_000,
      }) as CallResult,
    tools: async () => (await client.listTools()).tools,
    lines,
    warnings,
    close: async () => {
      await client.close().catch(() => {});
      await sidecar.close().catch(() => {});
      await reading;
      await server.shutdown();
    },
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

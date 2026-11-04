// A stub ryph deployment for the `ryph mcp` tests: the app's token exchange, plus whatever the
// test routes answer by "METHOD /v1/path", each request recorded. As a fetch for the tool
// handlers, or served on a port for the stdio end-to-end test.

import { RyphClient } from "../src/api/client.ts";
import type { ToolContext } from "../src/mcp/tool.ts";

export interface Seen {
  method: string;
  /** Without the `/api` prefix: `/v1/tasks`. */
  path: string;
  query: URLSearchParams;
  authorization: string | null;
  body: unknown;
}

export type Handler = (req: Seen) => Response | unknown | Promise<Response | unknown>;

/** A JWT whose payload carries these claims; unsigned, as only the server checks signatures. */
export function accessToken(caps: string[], extra: Record<string, unknown> = {}): string {
  const enc = (v: unknown) =>
    btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${enc({ alg: "EdDSA" })}.${
    enc({ sub: "u-1", email: "ada@example.com", name: "Ada", caps, via: "token", ...extra })
  }.sig`;
}

export function fakeRyph(
  routes: Record<string, Handler>,
  opts: { caps?: string[] } = {},
) {
  const seen: Seen[] = [];
  const token = accessToken(opts.caps ?? ["*"]);
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const raw = init?.body == null ? null : await new Response(init.body).text();
    if (url.pathname === "/api/v1/auth/token") {
      return Response.json({ accessToken: token, expiresIn: 900 });
    }
    const path = url.pathname.replace(/^\/api/, "");
    const req: Seen = {
      method: init?.method ?? "GET",
      path,
      query: url.searchParams,
      authorization: new Headers(init?.headers).get("authorization"),
      body: raw === null || raw === "" ? null : JSON.parse(raw),
    };
    seen.push(req);
    const handler = routes[`${req.method} ${path}`];
    if (handler === undefined) return Response.json({ error: "not found" }, { status: 404 });
    // Like a real fetch, an aborted signal ends the request however long the handler takes.
    const signal = init?.signal;
    if (signal?.aborted) throw signal.reason;
    const answer = await new Promise<unknown>((resolve, reject) => {
      const onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(handler(req)).then(resolve, reject).finally(() =>
        signal?.removeEventListener("abort", onAbort)
      );
    });
    return answer instanceof Response ? answer : Response.json(answer);
  };
  const client = new RyphClient({
    url: "https://ryph.example",
    token: "ryph_pat_test",
    fetch: fetch as typeof globalThis.fetch,
  });
  const progress: string[] = [];
  const ctx: ToolContext = {
    api: () => Promise.resolve(client),
    cwd: process.cwd(),
    progress: (m) => void progress.push(m),
    intervalMs: 0,
    signal: new AbortController().signal,
  };
  return { fetch, seen, client, ctx, progress };
}

/** A history event, as the historian answers it. */
export function event(
  seq: number,
  kind: string,
  fields: {
    text?: string | null;
    payload?: unknown;
    voice?: "transcript" | "diag";
    lane?: string;
  } = {},
) {
  return {
    runId: "r-1",
    lane: fields.lane ?? "",
    seq,
    at: `2026-10-14T10:00:${String(seq % 60).padStart(2, "0")}Z`,
    voice: fields.voice ?? "transcript",
    kind,
    level: null,
    text: fields.text ?? null,
    payload: fields.payload ?? null,
  };
}

/** A task detail with one run, as `GET /v1/tasks/:id` answers it. */
export function taskDetail(run: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    task: {
      id: "t-1",
      agentId: "a-1",
      spec: { title: "Fix the login bug", instructions: "The login form 500s." },
      repos: [{ connectedRepoId: "cr-1", name: "acme/api", ref: "main", path: "api" }],
      workspaceId: null,
      origin: "token",
      createdAt: "2026-10-14T09:00:00Z",
    },
    agent: { id: "a-1", name: "Coder" },
    workspace: null,
    runs: [{
      id: "r-1",
      state: "running",
      phase: "running",
      result: null,
      createdAt: "2026-10-14T09:00:00Z",
      updatedAt: "2026-10-14T09:05:00Z",
      events: [{ at: "2026-10-14T09:00:01Z", kind: "launched" }],
      messages: [],
      forgeActions: [],
      grants: { history: "hg", models: "mg", tools: "tg" },
      ...run,
    }],
    patches: [],
    response: null,
    checkSuites: [],
    artifacts: [],
    ...extra,
  };
}

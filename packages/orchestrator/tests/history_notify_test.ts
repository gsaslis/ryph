// The conclude notifier: a service-authed POST to the historian's internal conclude route, fired
// without waiting — a terminal save must never wait on, or fail for, the historian — and retried
// with backoff when it fails for a reason that can pass. `fetch` is
// stubbed so the orchestrator's tests stay socket-free.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { httpConcludeNotifier } from "../src/adapters/history_notify/http.ts";
import { silentDiagnostics } from "./doubles.ts";

async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the ping");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("posts the conclude ping with the service token", async () => {
  const calls: { url: string; method?: string; auth: string | null }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      auth: new Headers(init?.headers).get("authorization"),
    });
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  try {
    const notify = httpConcludeNotifier({
      historyUrl: "http://historian.test",
      historyToken: "history-token",
      diag: silentDiagnostics(),
    });
    notify("r-1");
    await waitFor(() => calls.length === 1);
    assertEquals(calls[0].url, "http://historian.test/internal/v1/runs/r-1/conclude");
    assertEquals(calls[0].method, "POST");
    assertEquals(calls[0].auth, "Bearer history-token");
  } finally {
    globalThis.fetch = original;
  }
});

test("returns void and never throws when the historian fails or is unreachable", async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    calls++;
    // A 5xx, then hard rejections — all swallowed, the last one included.
    return calls === 1
      ? Promise.resolve(new Response(null, { status: 500 }))
      : Promise.reject(new Error("down"));
  }) as unknown as typeof fetch;
  try {
    const notify = httpConcludeNotifier({
      historyUrl: "http://historian.test",
      historyToken: "t",
      diag: silentDiagnostics(),
      retries: 2,
      backoff: { baseMs: 5, capMs: 5 },
    });
    assertEquals(notify("r-1"), undefined);
    // The first attempt and both retries, then it gives up.
    await waitFor(() => calls === 3);
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(calls, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test("a lost ping is retried with backoff until it lands", async () => {
  // The ping is the standalone historian's only news that a run ended: without the retry, one
  // 503 (or a historian restarting) left that run's live viewers without `done` for good.
  const at: number[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    at.push(Date.now());
    if (at.length === 1) return Promise.reject(new Error("connection refused"));
    if (at.length === 2) return Promise.resolve(new Response("busy", { status: 503 }));
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as unknown as typeof fetch;
  try {
    const notify = httpConcludeNotifier({
      historyUrl: "http://historian.test",
      historyToken: "t",
      diag: silentDiagnostics(),
      backoff: { baseMs: 20, capMs: 1_000 },
    });
    notify("r-1");
    await waitFor(() => at.length === 3);
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(at.length, 3, "a ping that landed is not sent again");
    // Doubling: ~20 ms, then ~40 ms.
    assert(at[1] - at[0] >= 15, `first wait ${at[1] - at[0]} ms`);
    assert(at[2] - at[1] >= 35, `second wait ${at[2] - at[1]} ms`);
  } finally {
    globalThis.fetch = original;
  }
});

test("a 4xx is definitive: logged once, never retried", async () => {
  let calls = 0;
  const warned: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(new Response(null, { status: 401 }));
  }) as unknown as typeof fetch;
  try {
    const diag = { ...silentDiagnostics(), warn: (event: string) => void warned.push(event) };
    const notify = httpConcludeNotifier({
      historyUrl: "http://historian.test",
      historyToken: "wrong",
      diag,
      backoff: { baseMs: 5, capMs: 5 },
    });
    notify("r-1");
    await waitFor(() => warned.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(calls, 1);
    assertEquals(warned, ["history.conclude_failed"]);
  } finally {
    globalThis.fetch = original;
  }
});

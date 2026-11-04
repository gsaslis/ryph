import { describe, expect, it } from "vitest";
import { apiCall, ApiError } from "./call";

// The one retry a read gets. A page that re-runs its whole load every three seconds makes
// thousands of these while a run is watched, and a gateway being rolled under it answers one of
// them 503 — which used to be the page. What is guarded here is that the retry happens for exactly
// the answers that say nothing about the request, and for nothing else.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A control plane that answers the given sequence, one answer per call, and counts the calls. */
function plane(...answers: (Response | Error | (() => Response | Error))[]) {
  const calls: { path: string; method: string }[] = [];
  const f = (input: string | URL | Request, init?: RequestInit) => {
    const at = calls.length;
    calls.push({
      path: new URL(String(input), "http://x").pathname,
      method: (init?.method ?? "GET").toUpperCase(),
    });
    const answer = answers[Math.min(at, answers.length - 1)];
    const value = typeof answer === "function" ? answer() : answer;
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  };
  return { fetch: f as unknown as typeof globalThis.fetch, calls };
}

describe("a read that met a gateway", () => {
  it("asks once more after a 503, and answers with what came back the second time", async () => {
    const control = plane(json({ error: "upstream unavailable" }, 503), json({ ok: true }));

    await expect(apiCall(control.fetch, "/v1/runs/run-1/events?before=9&limit=200"))
      .resolves.toEqual({ ok: true });
    expect(control.calls).toHaveLength(2);
    expect(control.calls.every((c) => c.method === "GET")).toBe(true);
    expect(control.calls[1].path).toBe("/api/v1/runs/run-1/events");
  });

  it("asks once more for a 502 and a 504 too", async () => {
    for (const status of [502, 504]) {
      const control = plane(json({ error: "gateway" }, status), json({ ok: status }));
      await expect(apiCall(control.fetch, "/v1/tasks/task-1")).resolves.toEqual({ ok: status });
      expect(control.calls).toHaveLength(2);
    }
  });

  it("asks once more when the request never landed at all", async () => {
    // No socket, no DNS, a connection cut mid-flight: `fetch` rejects, and from here that is the
    // same thing a 503 is.
    const control = plane(new TypeError("Failed to fetch"), json({ ok: true }));

    await expect(apiCall(control.fetch, "/v1/tasks/task-1")).resolves.toEqual({ ok: true });
    expect(control.calls).toHaveLength(2);
  });

  it("gives up after the second try, with the error the second one gave", async () => {
    // One retry, not a loop: this is for the pod that was being replaced, not for a control plane
    // that is down. A page that kept asking would hold the failure open instead of reporting it.
    const control = plane(json({ error: "upstream unavailable" }, 503));

    const failed = await apiCall(control.fetch, "/v1/tasks/task-1").catch((e) => e);
    expect(failed).toBeInstanceOf(ApiError);
    expect((failed as ApiError).status).toBe(503);
    expect(control.calls).toHaveLength(2);
  });

  it("re-raises a network error that happens twice", async () => {
    const control = plane(new TypeError("Failed to fetch"));

    await expect(apiCall(control.fetch, "/v1/tasks/task-1")).rejects.toThrow("Failed to fetch");
    expect(control.calls).toHaveLength(2);
  });
});

describe("what is never asked twice", () => {
  it("leaves every other status alone", async () => {
    // A 500 means something upstream read the request and broke on it, and a 404 means it read it
    // and there is nothing there. Repeating either is asking the same answered question again.
    for (const status of [400, 401, 403, 404, 409, 429, 500]) {
      const control = plane(json({ error: `refused ${status}` }, status));
      await expect(apiCall(control.fetch, "/v1/tasks/task-1", {}, false)).rejects
        .toBeInstanceOf(ApiError);
      expect(control.calls).toHaveLength(1);
    }
  });

  it("never repeats a write, whatever the gateway said", async () => {
    // A POST that timed out may well have happened. Sending it again is how one message to a run
    // becomes two of them.
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const control = plane(json({ error: "upstream unavailable" }, 503));
      await expect(
        apiCall(control.fetch, "/v1/runs/run-1/messages", { method, body: "{}" }, false),
      ).rejects.toBeInstanceOf(ApiError);
      expect(control.calls).toEqual([{ path: "/api/v1/runs/run-1/messages", method }]);
    }
  });

  it("does not retry a read that succeeded", async () => {
    const control = plane(json({ ok: true }));
    await expect(apiCall(control.fetch, "/v1/tasks/task-1")).resolves.toEqual({ ok: true });
    expect(control.calls).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import { ApiError } from "./call";
import {
  createMemory,
  getMemories,
  getMemory,
  getMemoryAccess,
  isMemoryDisabled,
  moveMemorySource,
  withdrawMemorySource,
} from "./memory";
import { memorySchema } from "./types";

const respond = (status: number, body: unknown) => () =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );

const memory = {
  id: "mem-1",
  text: "App tests are vitest",
  kind: "procedure",
  subject: { kind: "repo", url: "github.com/acme/app" },
  audience: { kind: "all" },
  status: "canon",
  trust: "human",
  provenance: { kind: "human", userId: "u-1" },
  evidence: null,
  supersedes: null,
  supersededBy: null,
  confirmations: 2,
  refutations: 0,
  briefedCount: 5,
  briefedSuccesses: 3,
  lastBriefedAt: "2026-09-10T12:00:00.000Z",
  lastConfirmedAt: null,
  lastRefutedAt: null,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-10T12:00:00.000Z",
  score: { trust: 1.5, votes: 3.75, decay: 0.9, relevance: 1, ageDays: 12, total: 5.06 },
  age: "12d ago",
};

describe("the memory client", () => {
  it("parses a listing and passes every filter as a query parameter", async () => {
    const asked: string[] = [];
    const fetch = ((url: string) => {
      asked.push(url);
      return respond(200, { memories: [memory] })();
    }) as unknown as typeof globalThis.fetch;
    const listed = await getMemories(fetch, {
      subject: "repo:github.com/acme/app",
      kind: "procedure",
      q: "vitest tests",
      limit: 50,
    });
    expect(listed).toEqual([memorySchema.parse(memory)]);
    expect(asked[0]).toBe(
      "/api/v1/memories?subject=repo%3Agithub.com%2Facme%2Fapp&kind=procedure&q=vitest+tests&limit=50",
    );
  });

  it("parses a detail whose signals include the consolidator's sweep", async () => {
    const detail = {
      memory: { ...memory, status: "retired" },
      feedback: [
        { kind: "briefed", memoryId: "mem-1", runId: "run-1", at: "2026-09-10T12:00:00.000Z" },
        { kind: "sweep", memoryId: "mem-1", reason: "decayed", at: "2026-09-14T12:00:00.000Z" },
        {
          kind: "sweep",
          memoryId: "mem-1",
          reason: "source-superseded",
          at: "2026-09-15T12:00:00.000Z",
        },
      ],
      supersedes: null,
      supersededBy: null,
      runs: [
        {
          runId: "run-1",
          taskId: "task-1",
          agentId: "agent-1",
          repos: ["github.com/acme/app"],
          briefed: ["mem-1"],
          outcome: "success",
          createdAt: "2026-09-10T12:00:00.000Z",
        },
      ],
    };
    const fetch = respond(200, detail) as unknown as typeof globalThis.fetch;
    const parsed = await getMemory(fetch, "mem-1");
    expect(parsed.feedback.map((f) => f.kind)).toEqual(["briefed", "sweep", "sweep"]);
    expect(parsed.feedback[1].reason).toBe("decayed");
    expect(parsed.feedback[2].reason).toBe("source-superseded");
    expect(parsed.runs[0].taskId).toBe("task-1");
  });

  it("moves a source to a subject and parses what that did", async () => {
    let sent: unknown = null;
    const fetch = ((_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return respond(200, {
        sourceId: "src-1",
        subject: { kind: "repo", url: "github.com/acme/app" },
        proposals: 3,
        memories: 1,
      })();
    }) as unknown as typeof globalThis.fetch;
    const moved = await moveMemorySource(fetch, "src-1", {
      kind: "repo",
      url: "https://github.com/Acme/App",
    });
    expect(sent).toEqual({ subject: { kind: "repo", url: "https://github.com/Acme/App" } });
    expect(moved.subject).toEqual({ kind: "repo", url: "github.com/acme/app" });
    expect(moved.proposals).toBe(3);
  });

  it("withdraws a source by id and parses what that did", async () => {
    const asked: [string, string | undefined][] = [];
    const fetch = ((url: string, init?: RequestInit) => {
      asked.push([url, init?.method]);
      return respond(200, { sourceId: "src-1", rejected: 2, retired: 1, kept: 0 })();
    }) as unknown as typeof globalThis.fetch;
    expect(await withdrawMemorySource(fetch, "src-1")).toEqual({
      sourceId: "src-1",
      rejected: 2,
      retired: 1,
      kept: 0,
    });
    expect(asked).toEqual([["/api/v1/memory/sources/src-1/withdraw", "POST"]]);
  });

  it("posts a hand-written memory and parses the row back", async () => {
    let sent: unknown = null;
    const fetch = ((_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return respond(201, memory)();
    }) as unknown as typeof globalThis.fetch;
    const created = await createMemory(fetch, {
      text: "App tests are vitest",
      kind: "procedure",
      subject: { kind: "repo", url: "https://github.com/acme/app" },
      pinned: true,
    });
    expect(created.id).toBe("mem-1");
    expect(sent).toMatchObject({ pinned: true, subject: { kind: "repo" } });
  });

  it("folds off, forbidden and unavailable into an empty page rather than a throw", async () => {
    const off = respond(503, { error: "memory is off", code: "memory_disabled" });
    expect(await getMemoryAccess(off as unknown as typeof globalThis.fetch)).toEqual({
      memoryAccessEnabled: false,
      memoryAccessState: "off",
      memories: [],
    });
    const forbidden = respond(403, { error: "admins only" });
    expect(
      (await getMemoryAccess(forbidden as unknown as typeof globalThis.fetch)).memoryAccessState,
    ).toBe("forbidden");
    const absent = respond(404, { error: "not found" });
    expect(
      (await getMemoryAccess(absent as unknown as typeof globalThis.fetch)).memoryAccessState,
    ).toBe("unavailable");
    // A 400 is the caller's problem and still throws.
    const bad = respond(400, { error: "subject: not org or repo:<url>" });
    await expect(getMemoryAccess(bad as unknown as typeof globalThis.fetch)).rejects.toThrow();
    expect(isMemoryDisabled(new ApiError(503, { code: "memory_disabled" }, "off"))).toBe(true);
    expect(isMemoryDisabled(new ApiError(503, { code: "other" }, "off"))).toBe(false);
  });
});

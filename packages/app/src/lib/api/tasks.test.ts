import { afterEach, describe, expect, it, vi } from "vitest";
import { createTask, getTask, getTasks, getTasksByIds, taskFiltersToParams } from "./tasks";
import type { TaskPage } from "./types";

const task = {
  id: "t-1",
  title: "Fix the thing",
  agentId: "a-1",
  agentName: "Agent",
  origin: "user",
  workspaceId: null,
  connectedRepoIds: [],
  requestedByUserId: "u-1",
  createdAt: "2026-09-05T00:00:00.000Z",
  lastActivityAt: "2026-09-05T00:00:00.000Z",
  state: "running",
  phase: null,
};

const answer = (body: unknown) =>
  vi.fn((_input: string | URL) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  );

afterEach(() => vi.unstubAllGlobals());

// Nothing on the frontend narrows a list yet — the filter surface is a follow-up. What is
// asserted here is the wire contract the API client already speaks, so the surface that arrives
// later attaches to something known to be right.
describe("filters on the wire", () => {
  it("uses the names the API takes", () => {
    const written = taskFiltersToParams({
      q: "migration",
      statuses: ["live", "failed"],
      origins: ["forge"],
      agentIds: ["a-1", "a-2"],
      workspaceId: "w-1",
      connectedRepoId: "r-1",
      mine: true,
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-08T00:00:00.000Z",
    });
    expect(Object.fromEntries(written)).toEqual({
      q: "migration",
      status: "live,failed",
      origin: "forge",
      agent: "a-1,a-2",
      workspace: "w-1",
      repo: "r-1",
      mine: "true",
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-08T00:00:00.000Z",
    });
  });

  it("says nothing at all when nothing is set", () => {
    expect(taskFiltersToParams({}).toString()).toBe("");
    expect(taskFiltersToParams({ statuses: [], mine: false }).toString()).toBe("");
  });
});

describe("reading a page", () => {
  it("asks with the filters and a bounded limit", async () => {
    const fetchMock = answer({ tasks: [task], nextCursor: "c-1", hasMore: true });
    vi.stubGlobal("fetch", fetchMock);

    const read: TaskPage = await getTasks(fetch, { q: "thing", statuses: ["live"] });

    const asked = new URL(fetchMock.mock.calls[0][0], "http://localhost");
    expect(asked.pathname).toBe("/api/v1/tasks");
    expect(asked.searchParams.get("q")).toBe("thing");
    expect(asked.searchParams.get("status")).toBe("live");
    expect(asked.searchParams.get("limit")).toBe("50");
    expect(read.tasks[0].id).toBe("t-1");
    expect(read.nextCursor).toBe("c-1");
  });

  it("names ids instead of paging when that is what the caller holds", async () => {
    const fetchMock = answer({ tasks: [task], nextCursor: null, hasMore: false });
    vi.stubGlobal("fetch", fetchMock);

    await getTasksByIds(fetch, ["t-1", "t-2"]);

    const asked = new URL(fetchMock.mock.calls[0][0], "http://localhost");
    expect(asked.searchParams.get("ids")).toBe("t-1,t-2");
  });

  it("asks for nothing when there are no ids to resolve", async () => {
    const fetchMock = answer({ tasks: [], nextCursor: null, hasMore: false });
    vi.stubGlobal("fetch", fetchMock);
    expect(await getTasksByIds(fetch, [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a task started without instructions", () => {
  it("reads as untitled and waiting for them", async () => {
    vi.stubGlobal(
      "fetch",
      answer({
        tasks: [{ ...task, title: null, awaitingPrompt: true }],
        nextCursor: null,
        hasMore: false,
      }),
    );
    const [row] = (await getTasks(fetch)).tasks;
    expect(row.title).toBeNull();
    expect(row.awaitingPrompt).toBe(true);
  });

  it("is created with an empty spec", async () => {
    const fetchMock = answer({ taskId: "t-2", runId: "r-2", state: "starting" });
    vi.stubGlobal("fetch", fetchMock);

    const created = await createTask(fetch, { agentId: "a-1", spec: {}, connectedRepoId: "c-1" });

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string).spec).toEqual({});
    expect(created.taskId).toBe("t-2");
  });

  it("has a detail with a null title and no instructions", async () => {
    vi.stubGlobal(
      "fetch",
      answer({
        task: {
          id: "t-2",
          agentId: "a-1",
          spec: { title: null, instructions: null },
          awaitingPrompt: true,
          repos: [],
          origin: "user",
          createdAt: "2026-10-07T00:00:00.000Z",
        },
        agent: null,
        runs: [],
      }),
    );
    const detail = await getTask(fetch, "t-2");
    expect(detail.task.spec).toEqual({ title: null, instructions: null });
    expect(detail.task.awaitingPrompt).toBe(true);
  });
});

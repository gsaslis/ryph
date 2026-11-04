import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskPage, TaskSummary } from "$lib/api/types";
import { LiveTaskList } from "./live-task-list.svelte";
import { subscribeTasks } from "$lib/api/tasks";

vi.mock("$lib/api/tasks", async (original) => ({
  ...await original<typeof import("$lib/api/tasks")>(),
  subscribeTasks: vi.fn(),
}));

const row = (id: string, createdAt: string, over: Partial<TaskSummary> = {}): TaskSummary => ({
  id,
  title: id,
  awaitingPrompt: false,
  agentId: "a-1",
  agentName: "Agent",
  origin: "user",
  workspaceId: null,
  connectedRepoIds: [],
  requestedByUserId: "u-1",
  createdAt,
  lastActivityAt: createdAt,
  state: "running",
  phase: null,
  ...over,
});

const page = (tasks: TaskSummary[], nextCursor: string | null = null): TaskPage => ({
  tasks,
  nextCursor,
  hasMore: nextCursor !== null,
});

const ids = (list: LiveTaskList) => list.rows.map((task) => task.id);

// Five tasks, newest first — t5 was asked for most recently.
const t5 = row("t5", "2026-09-05T00:00:00.000Z");
const t4 = row("t4", "2026-09-04T00:00:00.000Z");
const t3 = row("t3", "2026-09-03T00:00:00.000Z");
const t2 = row("t2", "2026-09-02T00:00:00.000Z");
const t1 = row("t1", "2026-09-01T00:00:00.000Z");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("connection health", () => {
  function transport() {
    const sub = { close: vi.fn(), retry: vi.fn() };
    vi.mocked(subscribeTasks).mockReturnValue(sub);
    return sub;
  }

  it("mirrors states without discarding rows and delegates retry to the existing transport", () => {
    const sub = transport();
    const list = new LiveTaskList(page([t5, t4]));
    const stop = list.connect();
    const callbacks = vi.mocked(subscribeTasks).mock.calls[0][1];
    for (
      const state of [
        "connecting",
        "live",
        "retrying",
        "failed",
        "auth-required",
        "suspended",
      ] as const
    ) {
      callbacks.onState?.(state);
      expect(list.streamState).toBe(state);
      expect(list.streaming).toBe(state === "live");
      expect(ids(list)).toEqual(["t5", "t4"]);
    }
    list.retry();
    expect(sub.retry).toHaveBeenCalledOnce();
    expect(subscribeTasks).toHaveBeenCalledOnce();
    stop();
    list.retry();
    expect(sub.retry).toHaveBeenCalledOnce();
    expect(sub.close).toHaveBeenCalledOnce();
    expect(list.streaming).toBe(false);
  });

  it("repairs the head on reconnect while retaining deeper pages", () => {
    transport();
    const list = new LiveTaskList(page([t5, t4, t3, t2, t1], "deep"));
    const stop = list.connect();
    const callbacks = vi.mocked(subscribeTasks).mock.calls[0][1];
    callbacks.onState?.("retrying");
    callbacks.onSync(page([t5, t3], "head"));
    callbacks.onState?.("live");
    expect(ids(list)).toEqual(["t5", "t3", "t2", "t1"]);
    expect(list.nextCursor).toBe("deep");
    expect(list.streaming).toBe(true);
    stop();
  });

  it("ignores late state and data from a closed or replaced connection", () => {
    const first = transport();
    const list = new LiveTaskList(page([t5]));
    const stopFirst = list.connect();
    const old = vi.mocked(subscribeTasks).mock.calls[0][1];
    const second = transport();
    const stopSecond = list.connect();
    const current = vi.mocked(subscribeTasks).mock.calls[1][1];
    current.onState?.("live");
    stopFirst();
    old.onState?.("failed");
    old.onSync(page([]));
    old.onTask(t1);
    old.onLeave("t5");
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).not.toHaveBeenCalled();
    expect(list.streamState).toBe("live");
    expect(ids(list)).toEqual(["t5"]);
    list.seed(page([t2]), { statuses: ["succeeded"] });
    current.onState?.("failed");
    current.onSync(page([]));
    expect(ids(list)).toEqual(["t2"]);
    expect(list.streamState).toBe("live");
    stopSecond();
    current.onState?.("live");
    expect(list.streaming).toBe(false);
  });
});

describe("seeding", () => {
  it("takes the load's page and its cursor", () => {
    const list = new LiveTaskList(page([t5, t4], "cursor-1"), {});
    expect(ids(list)).toEqual(["t5", "t4"]);
    expect(list.nextCursor).toBe("cursor-1");
    expect(list.hasMore).toBe(true);
  });

  it("replaces everything when the filters change — it is a different list", () => {
    const list = new LiveTaskList(page([t5, t4, t3], "cursor-1"), {});
    list.seed(page([t2]), { statuses: ["succeeded"] });
    expect(ids(list)).toEqual(["t2"]);
    expect(list.nextCursor).toBeNull();
    expect(list.filters).toEqual({ statuses: ["succeeded"] });
  });

  it("merges a fresh head under the same filters, keeping the pages below it", () => {
    const list = new LiveTaskList(page([t5, t4, t3, t2, t1]), {});
    // t4 sat inside the fresh page's range and did not come back: it left the filters while
    // nobody was listening. t2 and t1 are older than anything the page reached, so its silence
    // says nothing about them.
    list.seed(page([t5, t3]), {});
    expect(ids(list)).toEqual(["t5", "t3", "t2", "t1"]);
  });

  it("keeps a cursor that points past rows the fresh head never reached", () => {
    const list = new LiveTaskList(page([t5, t4, t3, t2, t1], "deep"), {});
    list.seed(page([t5, t4], "shallow"), {});
    expect(list.nextCursor).toBe("deep");
  });

  it("takes the fresh head's cursor when the head is all there is", () => {
    const list = new LiveTaskList(page([t5, t4], "old"), {});
    list.seed(page([t5, t4, t3], "new"), {});
    expect(list.nextCursor).toBe("new");
  });

  it("an empty head under the same filters means nothing matches them at all", () => {
    const list = new LiveTaskList(page([t5, t4]), {});
    list.seed(page([]), {});
    expect(ids(list)).toEqual([]);
  });
});

describe("rows the tail moves", () => {
  it("replaces a held row where it sits", () => {
    const list = new LiveTaskList(page([t5, t4, t3]), {});
    list.upsert({ ...t4, state: "succeeded" });
    expect(ids(list)).toEqual(["t5", "t4", "t3"]);
    expect(list.rows[1].state).toBe("succeeded");
  });

  it("takes the title a task gets once its first message arrives", () => {
    const list = new LiveTaskList(page([t5, { ...t4, title: null, awaitingPrompt: true }]), {});
    list.upsert({ ...t4, title: "Fix the flaky login test", awaitingPrompt: false });
    expect(list.rows[1].title).toBe("Fix the flaky login test");
    expect(list.rows[1].awaitingPrompt).toBe(false);
  });

  it("places a task nobody had at the head", () => {
    const list = new LiveTaskList(page([t3, t2]), {});
    list.upsert(row("t9", "2026-09-09T00:00:00.000Z"));
    expect(ids(list)).toEqual(["t9", "t3", "t2"]);
  });

  it("leaves a row below the last one on screen for the next page", () => {
    // Pages remain, so below t3 lies a stretch nobody has read. Drawing t1 there would put it
    // above a gap it actually sits below, and `loadMore` would then hand it over again.
    const list = new LiveTaskList(page([t5, t4, t3], "cursor-1"), {});
    list.upsert(t1);
    expect(ids(list)).toEqual(["t5", "t4", "t3"]);
  });

  it("but places it once the list is complete", () => {
    const list = new LiveTaskList(page([t5, t4, t3]), {});
    list.upsert(t1);
    expect(ids(list)).toEqual(["t5", "t4", "t3", "t1"]);
  });

  it("orders ties by id, newest first — the server's own tie-break", () => {
    const same = "2026-09-07T00:00:00.000Z";
    const list = new LiveTaskList(page([row("tb", same)]), {});
    list.upsert(row("tc", same));
    list.upsert(row("ta", same));
    expect(ids(list)).toEqual(["tc", "tb", "ta"]);
  });

  it("drops a row that left the filters", () => {
    const list = new LiveTaskList(page([t5, t4, t3]), {});
    list.remove("t4");
    expect(ids(list)).toEqual(["t5", "t3"]);
  });
});

describe("paging deeper", () => {
  const answer = (body: TaskPage) =>
    vi.fn((_input: string | URL) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    );

  it("appends the next page and takes its cursor", async () => {
    const fetchMock = answer(page([t3, t2], "cursor-2"));
    vi.stubGlobal("fetch", fetchMock);
    const list = new LiveTaskList(page([t5, t4], "cursor-1"), { statuses: ["live"] });

    await list.loadMore();

    expect(ids(list)).toEqual(["t5", "t4", "t3", "t2"]);
    expect(list.nextCursor).toBe("cursor-2");
    // The filters ride along, or the deeper page would answer a different question than the head.
    const asked = new URL(fetchMock.mock.calls[0][0], "http://localhost");
    expect(asked.searchParams.get("status")).toBe("live");
    expect(asked.searchParams.get("cursor")).toBe("cursor-1");
  });

  it("never draws a row twice, however the pages overlap", async () => {
    vi.stubGlobal("fetch", answer(page([t4, t3])));
    const list = new LiveTaskList(page([t5, t4], "cursor-1"), {});
    await list.loadMore();
    expect(ids(list)).toEqual(["t5", "t4", "t3"]);
  });

  it("asks for nothing at the end of the list", async () => {
    const fetchMock = answer(page([]));
    vi.stubGlobal("fetch", fetchMock);
    const list = new LiveTaskList(page([t5, t4]), {});
    await list.loadMore();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the frames that arrive out of order", () => {
  it("adopts a sync's cursor when it holds none, however deep the row it kept", () => {
    // A `task` frame that overtook the first `sync`. The server now orders the two, but the
    // client must not need it to: the row lands on an empty list with a null cursor, and the
    // `sync` that follows reads it as sitting BELOW its own range and keeps it — so `kept` is
    // non-empty and the old rule ("only a list that is nothing but this page takes the page's
    // cursor") would have left `nextCursor` null for the life of the connection, with the list
    // unable to page past that one stale row.
    const list = new LiveTaskList();
    list.upsert(t1);
    expect(ids(list)).toEqual(["t1"]);
    expect(list.nextCursor).toBeNull();

    list.seed(page([t5, t4, t3], "cursor-1"), {});
    expect(ids(list)).toEqual(["t5", "t4", "t3", "t1"]);
    expect(list.nextCursor).toBe("cursor-1");
    expect(list.hasMore).toBe(true);
  });

  it("still leaves a held cursor alone when it has one", () => {
    const list = new LiveTaskList(page([t5, t4, t3, t2, t1], "cursor-deep"), {});
    list.seed(page([t5, t4], "cursor-head"), {});
    expect(list.nextCursor).toBe("cursor-deep");
  });
});

describe("a filter change while a page is in flight", () => {
  it("leaves the new list able to page", async () => {
    // The stale request returns under a key nobody is asking about. It must neither append its
    // rows nor clear the flag the NEW list is holding — and the new list must not inherit a
    // `loadingMore` that only the abandoned request could ever have reset.
    let release: (value: Response) => void = () => {};
    const inFlight = new Promise<Response>((resolve) => (release = resolve));
    const fetchMock = vi.fn((_input: string | URL) => inFlight);
    vi.stubGlobal("fetch", fetchMock);

    const list = new LiveTaskList(page([t5, t4], "cursor-1"), {});
    const stale = list.loadMore();
    expect(list.loadingMore).toBe(true);

    // The reader picks a filter. A different key is a different list.
    list.seed(page([t3], "cursor-2"), { statuses: ["succeeded"] });
    expect(list.loadingMore).toBe(false);

    release(
      new Response(JSON.stringify(page([t2])), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await stale;

    // The abandoned rows never landed, and the cursor the new list was seeded with survived.
    expect(ids(list)).toEqual(["t3"]);
    expect(list.loadingMore).toBe(false);
    expect(list.nextCursor).toBe("cursor-2");

    // ...and the new list can actually page, which is the bug: `loadingMore` used to stay true.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(page([t1])), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
      ),
    );
    await list.loadMore();
    expect(ids(list)).toEqual(["t3", "t1"]);
  });
});

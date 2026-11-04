import { describe, expect, it } from "vitest";
import type { ToolCall, ToolView } from "$lib/api/tools";
import { memoryCallOf } from "./memory-calls";

function call(view: ToolView, over: Partial<ToolCall> = {}): ToolCall {
  return {
    seq: 7,
    runId: "run-1",
    at: "2026-10-06T10:00:00Z",
    name: "mcp",
    resultText: null,
    useText: null,
    isError: false,
    done: true,
    view,
    images: { kept: [], notKept: 0 },
    ...over,
  };
}

const mcp = (
  server: string,
  tool: string,
  args: unknown,
  output: string | null = "ok",
): ToolView => ({
  kind: "mcp",
  server,
  tool,
  args,
  output,
});

describe("memoryCallOf", () => {
  it("reads a proposal's claim", () => {
    expect(memoryCallOf(call(
      mcp("memory", "propose", { text: " Tests need docker. " }, "Recorded as proposal p-9."),
    ))).toEqual({
      seq: 7,
      at: "2026-10-06T10:00:00Z",
      state: "done",
      detail: null,
      tool: "propose",
      text: "Tests need docker.",
      proposalId: "p-9",
    });
  });

  it("reads a refutation's reason and replacement", () => {
    const read = memoryCallOf(
      call(mcp("memory", "refute", { id: "m-1", reason: "Moved", replacement: "Now in ci/" })),
    );
    expect(read).toMatchObject({
      tool: "refute",
      id: "m-1",
      reason: "Moved",
      replacement: "Now in ci/",
    });
  });

  it("says a refused call failed, and why", () => {
    const read = memoryCallOf(
      call(mcp("memory", "confirm", { id: "m-2" }, "No memory m-2 is visible to this run."), {
        isError: true,
      }),
    );
    expect(read).toMatchObject({
      tool: "confirm",
      id: "m-2",
      state: "failed",
      detail: "No memory m-2 is visible to this run.",
    });
  });

  it("holds a call in flight as pending", () => {
    expect(memoryCallOf(call(mcp("memory", "confirm", { id: "m-3" }, null), { done: false })))
      .toMatchObject({ state: "pending" });
  });

  it("leaves out reads, and another server's tools of the same name", () => {
    expect(memoryCallOf(call(mcp("memory", "search", { q: "x" })))).toBeNull();
    expect(memoryCallOf(call(mcp("notes", "propose", { text: "x" })))).toBeNull();
    expect(memoryCallOf(call({ kind: "bash", command: "ls", output: "" }))).toBeNull();
  });
});

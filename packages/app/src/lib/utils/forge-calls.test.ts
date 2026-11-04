import { describe, expect, it } from "vitest";
import type { ToolCall } from "$lib/api/tools";
import type { ForgeToolAction } from "$lib/api/types";
import { closingNotes, type ForgeCall, forgeCallOf, matchForgeWrites } from "./forge-calls";

function call(tool: string, args: unknown, at: string, server = "forge"): ToolCall {
  return {
    seq: 1,
    runId: "run-1",
    at,
    name: `${server}__${tool}`,
    resultText: null,
    useText: null,
    isError: false,
    done: true,
    view: { kind: "mcp", server, tool, args, output: "ok" },
    images: { kept: [], notKept: 0 },
  };
}

function action(id: string, tool: ForgeToolAction["tool"], at: string, threadRef = "12") {
  return {
    id,
    runId: "run-1",
    tool,
    connectedRepoId: "r",
    provider: "github",
    repoRef: "o/r",
    threadRef,
    state: "done",
    url: null,
    createdThreadRef: null,
    detail: null,
    createdAt: at,
    completedAt: at,
  } as ForgeToolAction;
}

const read = (c: ToolCall) => forgeCallOf(c) as ForgeCall;

describe("forgeCallOf", () => {
  it("reads a review's verdict and its remarks", () => {
    const c = read(call("submit_review", {
      thread: "12",
      body: "Looks good",
      comments: [{ path: "a.ts", line: 3, body: "nit" }, { path: "b.ts", body: "no line" }],
    }, "2026-10-06T10:00:00Z"));
    expect(c.write).toEqual({
      tool: "submit_review",
      body: "Looks good",
      remarks: [{ path: "a.ts", line: 3, body: "nit" }],
    });
  });

  it("leaves out reads and other calls", () => {
    expect(forgeCallOf(call("get_issue", { thread: "1" }, "2026-10-06T10:00:00Z"))).toBeNull();
  });

  it("reads only the platform's forge, and never a call it refused", () => {
    const at = "2026-10-06T10:00:00Z";
    expect(forgeCallOf(call("create_issue", { title: "x" }, at, "linear"))).toBeNull();
    expect(forgeCallOf({ ...call("add_comment", { thread: "1", body: "x" }, at), isError: true }))
      .toBeNull();
  });
});

describe("matchForgeWrites", () => {
  it("pairs each entry with the nearest call of its tool and thread", () => {
    const calls = [
      read(call("add_comment", { thread: "12", body: "first" }, "2026-10-06T10:00:00Z")),
      read(call("add_comment", { thread: "12", body: "second" }, "2026-10-06T10:00:09Z")),
      read(call("add_comment", { thread: "7", body: "elsewhere" }, "2026-10-06T10:00:10Z")),
    ];
    const words = matchForgeWrites([
      action("a", "add_comment", "2026-10-06T10:00:01Z"),
      action("b", "add_comment", "2026-10-06T10:00:10Z"),
      action("c", "add_comment", "2026-10-06T10:00:11Z", "7"),
    ], calls);
    expect(words.get("a")).toMatchObject({ body: "first" });
    expect(words.get("b")).toMatchObject({ body: "second" });
    expect(words.get("c")).toMatchObject({ body: "elsewhere" });
  });

  it("gives no words to an entry whose call is not loaded", () => {
    const calls = [
      read(call("add_labels", { thread: "12", labels: ["bug"] }, "2026-10-06T09:00:00Z")),
    ];
    expect(matchForgeWrites([action("a", "add_labels", "2026-10-06T10:00:00Z")], calls).size)
      .toBe(0);
  });
});

describe("closingNotes", () => {
  const close = action("c", "close_issue", "2026-10-06T10:00:00.000Z");
  const note = action("n", "add_comment", "2026-10-06T10:00:00.050Z");
  const before = action("b", "add_comment", "2026-10-06T09:59:59.900Z");
  const elsewhere = action("e", "add_comment", "2026-10-06T10:00:00.050Z", "9");

  it("hides the one comment a close recorded just after itself", () => {
    expect([...closingNotes([close, before, note, elsewhere], [])]).toEqual(["n"]);
  });

  it("hides nothing beside a close whose call carried no comment", () => {
    const bare = read(call("close_issue", { thread: "12" }, "2026-10-06T09:59:58Z"));
    expect(closingNotes([close, note], [bare]).size).toBe(0);
  });
});

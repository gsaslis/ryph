import { describe, expect, it } from "vitest";
import { imagesOf, mergeToolCalls } from "./tools";
import type { HistoryEvent } from "./types";

// The tool_use/tool_result join, pinned. Nothing in a payload is guaranteed — the echo harness sends
// none, a failed tool sends no `result`, and the runner's emitter reduces an oversize one to its
// scalars — so what matters here is that every degraded shape still lands somewhere honest.

let seq = 0;
const event = (kind: string, payload: unknown, text: string | null = null): HistoryEvent => ({
  runId: "run-1",
  lane: "",
  seq: seq++,
  at: "2026-07-16T12:00:00.000Z",
  voice: "transcript",
  kind,
  level: null,
  text,
  payload,
});

const use = (id: string, name: string, args: unknown) =>
  event("tool_use", { type: "tool_execution_start", toolCallId: id, toolName: name, args });

const merge = (events: HistoryEvent[]) => {
  seq = 0;
  return mergeToolCalls(events);
};

const textResult = (text: string) => ({ content: [{ type: "text", text }] });

describe("a call and its outcome fold into one row", () => {
  it("joins a result to its call by toolCallId", () => {
    const events = [
      use("t1", "bash", { command: "ls" }),
      event("tool_result", {
        type: "tool_execution_end",
        toolCallId: "t1",
        result: textResult("a.txt"),
      }),
    ];
    const { calls, absorbed } = merge(events);
    const call = calls.get(0)!;
    expect(call.done).toBe(true);
    expect(call.view).toEqual({ kind: "bash", command: "ls", output: "a.txt" });
    // Absorbed, so the result does not also render as a row of its own.
    expect(absorbed.has(1)).toBe(true);
  });

  it("leaves a call with no result yet in flight", () => {
    const { calls } = merge([use("t1", "bash", { command: "sleep 10" })]);
    const call = calls.get(0)!;
    expect(call.done).toBe(false);
    // null, not "": the command has genuinely not answered.
    expect(call.view).toEqual({ kind: "bash", command: "sleep 10", output: null });
  });

  // The bug: the runner's emitter reduces a payload over 32 KB to its identifying scalars, so a
  // large `read` arrives carrying `toolCallId` but no `result`. Before, the whole payload was
  // replaced and the key went with it — the join failed, the row spun forever on a concluded run,
  // and the result rendered again as a detached second row.
  it("joins a truncated result, having lost only its body", () => {
    const events = [
      use("t1", "read", { path: "/w/big.txt" }),
      event(
        "tool_result",
        { truncated: true, bytes: 40_000, type: "tool_execution_end", toolCallId: "t1" },
        "the flat text is always there",
      ),
    ];
    const { calls, absorbed } = merge(events);
    const call = calls.get(0)!;
    expect(call.done, "a truncated result still concludes the call").toBe(true);
    expect(absorbed.has(1), "it must not also render as an orphan row").toBe(true);
    // No body to draw, so it degrades to the flat text rather than inventing a view.
    expect(call.view).toEqual({ kind: "opaque" });
    expect(call.resultText).toBe("the flat text is always there");
  });
});

// `result === undefined` used to mean both "still in flight" and "answered, with no result field".
// A failed tool sends no `result` (the pi adapter says so outright), and so does a truncated one —
// so a finished call rendered "Running…", with no spinner, forever.
describe("an answer that arrived empty is not an answer still coming", () => {
  it("a failed bash with no result field is done, not running", () => {
    const events = [
      use("t1", "bash", { command: "false" }),
      event("tool_result", { type: "tool_execution_end", toolCallId: "t1", isError: true }),
    ];
    const call = merge(events).calls.get(0)!;
    expect(call.done).toBe(true);
    expect(call.isError).toBe(true);
    // "" — it ran and printed nothing. null would claim it is still going.
    expect(call.view).toEqual({ kind: "bash", command: "false", output: "" });
  });

  it("a truncated bash result is done, not running", () => {
    const events = [
      use("t1", "bash", { command: "cat big" }),
      event("tool_result", { truncated: true, bytes: 40_000, toolCallId: "t1" }),
    ];
    const call = merge(events).calls.get(0)!;
    expect(call.done).toBe(true);
    expect((call.view as { output: string | null }).output).toBe("");
  });
});

describe("degradation", () => {
  it("a tool_use with no parseable payload stays a plain block", () => {
    const { calls } = merge([event("tool_use", { truncated: true, bytes: 40_000 }, "some text")]);
    expect(calls.size).toBe(0);
  });

  it("a result whose call never parsed is not absorbed, so it still gets a line", () => {
    const events = [
      event("tool_use", null, "no payload at all"),
      event("tool_result", {
        type: "tool_execution_end",
        toolCallId: "t1",
        result: textResult("x"),
      }),
    ];
    const { calls, absorbed } = merge(events);
    expect(calls.size).toBe(0);
    expect(absorbed.size).toBe(0);
  });

  it("an edit with no patch falls back to flat text rather than inventing a diff", () => {
    const events = [
      use("t1", "edit", { path: "/w/a.ts" }),
      event(
        "tool_result",
        { type: "tool_execution_end", toolCallId: "t1", isError: true },
        "failed",
      ),
    ];
    const call = merge(events).calls.get(0)!;
    expect(call.done).toBe(true);
    expect(call.view).toEqual({ kind: "opaque" });
  });
});

// Tools the ryph pi-mcp extension registers are named `<server slug>__<tool>`, so a call's row
// can say which server it went to — the transcript records that nowhere else.
describe("a call through the MCP gateway", () => {
  it("splits the server slug off the tool name and keeps args and reply", () => {
    const events = [
      use("t1", "linear__create_issue", { title: "Fix the thing" }),
      event("tool_result", {
        type: "tool_execution_end",
        toolCallId: "t1",
        result: textResult('{"id":"LIN-1"}'),
      }),
    ];
    const call = merge(events).calls.get(0)!;
    expect(call.view).toEqual({
      kind: "mcp",
      server: "linear",
      tool: "create_issue",
      args: { title: "Fix the thing" },
      output: '{"id":"LIN-1"}',
    });
  });

  it("is in flight until the reply lands, and an error reply is still a reply", () => {
    const pending = merge([use("t1", "gh__search", { q: "x" })]).calls.get(0)!;
    expect(pending.view).toMatchObject({ kind: "mcp", output: null });

    const failed = merge([
      use("t1", "gh__search", { q: "x" }),
      event("tool_result", {
        type: "tool_execution_end",
        toolCallId: "t1",
        result: textResult("credential rejected"),
        isError: true,
      }),
    ]).calls.get(0)!;
    expect(failed.isError).toBe(true);
    expect(failed.view).toMatchObject({ kind: "mcp", output: "credential rejected" });
  });

  // pi's own tools never carry a double underscore, and a slug is lowercase: neither of these is
  // mistaken for a gateway call.
  it("leaves every other name alone", () => {
    expect(merge([use("t1", "bash", { command: "ls" })]).calls.get(0)!.view.kind).toBe("bash");
    expect(merge([use("t1", "Not__a_slug", {})]).calls.get(0)!.view.kind).toBe("opaque");
    expect(merge([use("t1", "__x", {})]).calls.get(0)!.view.kind).toBe("opaque");
  });
});

// The run's browser is mounted under the slug `browser`; its calls get a view of their own so the
// row can say what it did to the page and show a screenshot that made it into the history.
describe("browser calls", () => {
  const end = (id: string, result: unknown) =>
    event("tool_result", { type: "tool_execution_end", toolCallId: id, result });

  it("reads a browser call as a browser view, with its reply", () => {
    const { calls } = merge([
      use("t1", "browser__click", { ref: "e12", element: "Greet" }),
      end("t1", textResult("Clicked")),
    ]);
    expect(calls.get(0)!.view).toEqual({
      kind: "browser",
      tool: "click",
      args: { ref: "e12", element: "Greet" },
      output: "Clicked",
      truncated: false,
    });
  });

  it("reads a screenshot kept as a run attachment, never its data", () => {
    const { calls } = merge([
      use("t1", "browser__screenshot", {}),
      end("t1", {
        content: [{
          type: "image",
          mimeType: "image/png",
          data: "[1234 base64 chars omitted]",
          attachment: { id: "att-1", mime: "image/png" },
        }],
      }),
    ]);
    const call = calls.get(0)!;
    expect(call.runId).toBe("run-1");
    expect(call.images).toEqual({ kept: [{ id: "att-1", mime: "image/png" }], notKept: 0 });
    expect(call.view).toMatchObject({ kind: "browser", truncated: false });
  });

  it("carries any tool's images, not only the browser's", () => {
    const { calls } = merge([
      use("t1", "read", { path: "/w/shot.png" }),
      end("t1", {
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", mimeType: "image/png", data: "[9 base64 chars omitted]" },
        ],
      }),
    ]);
    expect(calls.get(0)!.images).toEqual({ kept: [], notKept: 1 });
  });
  it("says when the reply was cut down for the history", () => {
    const { calls } = merge([
      use("t1", "browser__screenshot", {}),
      event("tool_result", { truncated: true, bytes: 180_000, toolCallId: "t1" }),
    ]);
    const call = calls.get(0)!;
    expect(call.done).toBe(true);
    expect(call.images).toEqual({ kept: [], notKept: 0 });
    expect(call.view).toMatchObject({ kind: "browser", truncated: true });
  });

  it("leaves a call still running without a reply", () => {
    const { calls } = merge([use("t1", "browser__navigate", { url: "http://localhost:5173" })]);
    expect(calls.get(0)!.view).toMatchObject({ kind: "browser", output: null, truncated: false });
  });

  it("does not take another server's tool for the browser's", () => {
    const { calls } = merge([use("t1", "browsers__click", {})]);
    expect(calls.get(0)!.view).toMatchObject({ kind: "mcp", server: "browsers" });
  });
});

describe("imagesOf", () => {
  const image = (extra: Record<string, unknown>) => ({
    type: "image",
    mimeType: "image/png",
    data: "[5000 base64 chars omitted]",
    ...extra,
  });

  it("reads an image part with an attachment as that attachment", () => {
    expect(imagesOf({ content: [image({ attachment: { id: "a1", mime: "image/webp" } })] }))
      .toEqual({ kept: [{ id: "a1", mime: "image/webp" }], notKept: 0 });
  });

  it("counts an image part without an attachment as not kept", () => {
    expect(imagesOf({ content: [image({})] })).toEqual({ kept: [], notKept: 1 });
  });

  it("never treats the omitted-data note, or any data, as something to draw", () => {
    const got = imagesOf({ content: [image({}), image({ data: "aGk=" })] });
    expect(got).toEqual({ kept: [], notKept: 2 });
    expect(JSON.stringify(got)).not.toContain("omitted");
    expect(JSON.stringify(got)).not.toContain("aGk=");
  });

  it("only takes png, jpeg, gif and webp attachments", () => {
    const got = imagesOf({
      content: [
        image({ attachment: { id: "svg", mime: "image/svg+xml" } }),
        image({ attachment: { id: "jpg", mime: "image/jpeg" } }),
        image({ attachment: { id: "html", mime: "text/html" } }),
        image({ attachment: { id: "gif", mime: "image/gif" } }),
        image({ attachment: { mime: "image/png" } }),
        image({ attachment: "a1" }),
      ],
    });
    expect(got.kept.map((ref) => ref.id)).toEqual(["jpg", "gif"]);
    expect(got.notKept).toBe(4);
  });

  it("keeps the reply's order and ignores its other parts", () => {
    const got = imagesOf({
      content: [
        { type: "text", text: "Saved" },
        image({ attachment: { id: "b", mime: "image/png" } }),
        image({}),
        image({ attachment: { id: "a", mime: "image/png", extra: 1 } }),
      ],
    });
    expect(got).toEqual({
      kept: [{ id: "b", mime: "image/png" }, { id: "a", mime: "image/png" }],
      notKept: 1,
    });
  });

  it("reads the refs a truncated result's payload kept, by the same rule", () => {
    expect(
      imagesOf({
        truncated: true,
        bytes: 40_000,
        toolCallId: "t1",
        images: [
          { id: "a1", mime: "image/png" },
          { id: "svg", mime: "image/svg+xml" },
          { id: "a2", mime: "image/jpeg" },
        ],
      }),
    ).toEqual({
      kept: [{ id: "a1", mime: "image/png" }, { id: "a2", mime: "image/jpeg" }],
      notKept: 0,
    });
    expect(imagesOf({ truncated: true, bytes: 40_000, toolCallId: "t1" })).toEqual({
      kept: [],
      notKept: 0,
    });
  });

  it("draws a truncated result's kept image on its call's row", () => {
    const { calls } = merge([
      use("t1", "read", { path: "big.png" }),
      event("tool_result", {
        truncated: true,
        bytes: 40_000,
        type: "tool_execution_end",
        toolCallId: "t1",
        images: [{ id: "a1", mime: "image/png" }],
      }),
    ]);
    expect([...calls.values()][0].images).toEqual({
      kept: [{ id: "a1", mime: "image/png" }],
      notKept: 0,
    });
  });

  it("has nothing for a reply that is not content blocks", () => {
    for (const result of [undefined, null, "text", { content: "x" }, { details: {} }]) {
      expect(imagesOf(result)).toEqual({ kept: [], notKept: 0 });
    }
  });
});

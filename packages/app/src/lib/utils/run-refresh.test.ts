import { describe, expect, it } from "vitest";
import { DetailCues, isInboxDelivery } from "./run-refresh";

const use = (id: string, name: string) => ({
  kind: "tool_use",
  payload: { toolCallId: id, toolName: name },
});
const result = (id: string) => ({ kind: "tool_result", payload: { toolCallId: id } });

describe("DetailCues", () => {
  it("wants a reload for an inbox message reaching the agent, not a wake-up", () => {
    const cues = new DetailCues();
    expect(cues.wants({ kind: "inbound", payload: { seq: 3, kind: "user" } })).toBe(true);
    expect(cues.wants({ kind: "inbound", payload: { kind: "system", wake: {} } })).toBe(false);
    expect(cues.wants({ kind: "inbound", payload: null })).toBe(false);
  });

  it("wants one when a recording tool answers, never on its call", () => {
    const cues = new DetailCues();
    expect(cues.wants(use("c1", "ryph__submit_patch"))).toBe(false);
    expect(cues.wants(result("c1"))).toBe(true);
    // An answer is read once.
    expect(cues.wants(result("c1"))).toBe(false);
    expect(cues.wants(use("c2", "forge__add_comment"))).toBe(false);
    expect(cues.wants(result("c2"))).toBe(true);
  });

  it("wants one when an artifact is published, so an open artifact follows its new version", () => {
    const cues = new DetailCues();
    expect(cues.wants(use("a1", "ryph__publish_artifact"))).toBe(false);
    expect(cues.wants(result("a1"))).toBe(true);
  });

  it("ignores pi's own tools, the browser's, and everything else the agent says", () => {
    const cues = new DetailCues();
    cues.wants(use("b1", "bash"));
    cues.wants(use("b2", "browser__click"));
    expect(cues.wants(result("b1"))).toBe(false);
    expect(cues.wants(result("b2"))).toBe(false);
    expect(cues.wants({ kind: "assistant", payload: null })).toBe(false);
    expect(cues.wants(result("never-called"))).toBe(false);
  });
});

describe("isInboxDelivery", () => {
  it("is an inbound payload with a seq", () => {
    expect(isInboxDelivery({ seq: 0 })).toBe(true);
    expect(isInboxDelivery({ seq: "0" })).toBe(false);
    expect(isInboxDelivery(undefined)).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSentDraft, readDraft, saveDraft, taskDraftKey } from "./draft";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

const a = taskDraftKey("person", "a");
const b = taskDraftKey("person", "b");

describe("task message drafts", () => {
  it("restores exact text after visiting another task, scoped to the person", () => {
    saveDraft(a, "  halfway\nthrough a reply  ");
    expect(readDraft(b)).toBeNull();
    saveDraft(b, "another reply");
    expect(readDraft(a)).toBe("  halfway\nthrough a reply  ");
    expect(readDraft(b)).toBe("another reply");
    expect(readDraft(taskDraftKey("someone else", "a"))).toBeNull();
  });

  it("removes an erased draft", () => {
    saveDraft(a, "reply");
    saveDraft(a, "");
    expect(readDraft(a)).toBeNull();
  });

  it("clears successfully sent text without touching other tasks", () => {
    saveDraft(a, " reply ");
    saveDraft(b, "keep this");
    clearSentDraft(a, " reply ");
    expect(readDraft(a)).toBeNull();
    expect(readDraft(b)).toBe("keep this");
  });

  it("does not let a late send erase a newer draft", () => {
    saveDraft(a, "sent text");
    saveDraft(a, "a newer reply");
    clearSentDraft(a, "sent text");
    expect(readDraft(a)).toBe("a newer reply");
  });

  it("tolerates unavailable storage (including server rendering)", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readDraft(a)).toBeNull();
    expect(() => saveDraft(a, "reply")).not.toThrow();
    expect(() => clearSentDraft(a, "reply")).not.toThrow();
  });

  it("tolerates storage refusing reads and writes", () => {
    const refused = () => {
      throw new Error("Storage refused");
    };
    vi.stubGlobal("localStorage", {
      getItem: refused,
      setItem: refused,
      removeItem: refused,
    });
    expect(readDraft(a)).toBeNull();
    expect(() => saveDraft(a, "reply")).not.toThrow();
    expect(() => saveDraft(a, "")).not.toThrow();
  });
});

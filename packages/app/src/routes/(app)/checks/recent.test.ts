import { describe, expect, it } from "vitest";
import type { CheckSuiteListItem } from "$lib/api/types";
import { appendSuitePage, type DeeperSuites, mergeSuiteHead } from "./recent";

const AT = (n: number) => `2026-09-${String(n).padStart(2, "0")}T00:00:00.000Z`;

/** Only the fields the merge reads. */
const item = (id: string, day: number) =>
  ({ suite: { id, createdAt: AT(day) } }) as unknown as CheckSuiteListItem;

const ids = (rows: CheckSuiteListItem[]) => rows.map((row) => row.suite.id);

describe("the checks list's head merge", () => {
  it("keeps the pages read below the head when the poll re-reads it", () => {
    const held: DeeperSuites = {
      key: "k",
      rows: [item("cs-7", 7), item("cs-6", 6)],
      cursor: "c-6",
    };
    const merged = mergeSuiteHead(held, {
      suites: [item("cs-9", 9), item("cs-8", 8)],
      nextCursor: "c-8",
    });
    expect(ids(merged.suites)).toEqual(["cs-9", "cs-8", "cs-7", "cs-6"]);
    expect(merged.nextCursor).toBe("c-6");
  });

  it("drops a held row inside the head's range that the head no longer carries", () => {
    const held: DeeperSuites = { key: "k", rows: [item("cs-8", 8)], cursor: null };
    const merged = mergeSuiteHead(held, {
      suites: [item("cs-9", 9), item("cs-7", 7)],
      nextCursor: null,
    });
    expect(ids(merged.suites)).toEqual(["cs-9", "cs-7"]);
  });

  it("drops every held row once the head is the whole list", () => {
    const held: DeeperSuites = {
      key: "k",
      rows: [item("cs-7", 7), item("cs-6", 6)],
      cursor: "c-6",
    };
    const merged = mergeSuiteHead(held, { suites: [item("cs-9", 9)], nextCursor: null });
    expect(ids(merged.suites)).toEqual(["cs-9"]);
    expect(merged.nextCursor).toBeNull();
  });

  it("stays at the end once the reader has paged there", () => {
    const held: DeeperSuites = { key: "k", rows: [item("cs-6", 6)], cursor: null };
    const merged = mergeSuiteHead(held, {
      suites: [item("cs-9", 9), item("cs-8", 8)],
      nextCursor: "c-8",
    });
    expect(ids(merged.suites)).toEqual(["cs-9", "cs-8", "cs-6"]);
    expect(merged.nextCursor).toBeNull();
  });

  it("appends a page without drawing a row twice", () => {
    const deeper = appendSuitePage(null, "k", [item("cs-9", 9), item("cs-8", 8)], {
      suites: [item("cs-8", 8), item("cs-7", 7)],
      nextCursor: null,
    });
    expect(ids(deeper.rows)).toEqual(["cs-9", "cs-8", "cs-7"]);
    expect(deeper.cursor).toBeNull();
  });

  it("keeps the rows newer arrivals push out of the head", () => {
    const head = [item("cs-6", 6), item("cs-5", 5), item("cs-4", 4)];
    const deeper = appendSuitePage(null, "k", head, {
      suites: [item("cs-3", 3), item("cs-2", 2)],
      nextCursor: "c-2",
    });
    const merged = mergeSuiteHead(deeper, {
      suites: [item("cs-8", 8), item("cs-7", 7), item("cs-6", 6)],
      nextCursor: "c-6",
    });
    expect(ids(merged.suites)).toEqual(["cs-8", "cs-7", "cs-6", "cs-5", "cs-4", "cs-3", "cs-2"]);
    expect(merged.nextCursor).toBe("c-2");
  });

  it("still drops a row that left the filter after the head grew", () => {
    const head = [item("cs-6", 6), item("cs-5", 5), item("cs-4", 4)];
    const deeper = appendSuitePage(null, "k", head, {
      suites: [item("cs-3", 3)],
      nextCursor: null,
    });
    const merged = mergeSuiteHead(deeper, {
      suites: [item("cs-8", 8), item("cs-6", 6), item("cs-4", 4)],
      nextCursor: "c-4",
    });
    expect(ids(merged.suites)).toEqual(["cs-8", "cs-6", "cs-4", "cs-3"]);
    expect(merged.nextCursor).toBeNull();
  });
});

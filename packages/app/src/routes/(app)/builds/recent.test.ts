import { describe, expect, it } from "vitest";
import type { BuildListItem } from "$lib/api/types";
import { appendBuildPage, type DeeperBuilds, mergeBuildHead } from "./recent";

const AT = (n: number) => `2026-09-${String(n).padStart(2, "0")}T00:00:00.000Z`;

/** Only the fields the merge reads. */
const item = (id: string, day: number) =>
  ({ build: { id, createdAt: AT(day) }, subject: null }) as unknown as BuildListItem;

const ids = (rows: BuildListItem[]) => rows.map((row) => row.build.id);

describe("the builds list's head merge", () => {
  it("keeps the pages read below the head when the poll re-reads it", () => {
    const held: DeeperBuilds = {
      key: "k",
      rows: [item("env-7", 7), item("env-6", 6)],
      cursor: "c-6",
    };
    const merged = mergeBuildHead(held, {
      builds: [item("env-9", 9), item("env-8", 8)],
      nextCursor: "c-8",
    });
    expect(ids(merged.builds)).toEqual(["env-9", "env-8", "env-7", "env-6"]);
    expect(merged.nextCursor).toBe("c-6");
  });

  it("drops a held row inside the head's range that the head no longer carries", () => {
    const held: DeeperBuilds = { key: "k", rows: [item("env-8", 8)], cursor: null };
    const merged = mergeBuildHead(held, {
      builds: [item("env-9", 9), item("env-7", 7)],
      nextCursor: "c-7",
    });
    expect(ids(merged.builds)).toEqual(["env-9", "env-7"]);
  });

  it("drops every held row once the head is the whole list", () => {
    const held: DeeperBuilds = {
      key: "k",
      rows: [item("env-7", 7), item("env-6", 6)],
      cursor: "c-6",
    };
    const merged = mergeBuildHead(held, { builds: [item("env-9", 9)], nextCursor: null });
    expect(ids(merged.builds)).toEqual(["env-9"]);
    expect(merged.nextCursor).toBeNull();
  });

  it("folds a later page in, the later read winning a row both carry", () => {
    const head = [item("env-9", 9), item("env-8", 8)];
    const deeper = appendBuildPage(null, "k", head, {
      builds: [item("env-8", 8), item("env-7", 7)],
      nextCursor: null,
    });
    expect(ids(deeper.rows)).toEqual(["env-9", "env-8", "env-7"]);
    expect(deeper.cursor).toBeNull();
    // Held rows under other filters are another list's.
    expect(ids(appendBuildPage(deeper, "other", [], { builds: [], nextCursor: null }).rows))
      .toEqual([]);
  });
});

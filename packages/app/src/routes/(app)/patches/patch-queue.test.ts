import { describe, expect, it } from "vitest";
import type { PatchWithContext } from "$lib/api/types";
import { appendPatchPage, type DeeperPatches, mergePatchHead } from "./patch-queue";

const AT = (n: number) => `2026-09-${String(n).padStart(2, "0")}T00:00:00.000Z`;

/** Only the fields the merge reads; the rest of the row is never touched by it. */
const patch = (id: string, day: number) =>
  ({ id, createdAt: AT(day) }) as unknown as PatchWithContext;

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

describe("the approval queue's head merge", () => {
  it("is just the page when nothing has been paged beneath it", () => {
    const merged = mergePatchHead(null, {
      patches: [patch("p-9", 9), patch("p-8", 8)],
      nextCursor: "c-8",
    });
    expect(ids(merged.rows)).toEqual(["p-9", "p-8"]);
    expect(merged.cursor).toBe("c-8");
  });

  it("KEEPS the deeper pages when the poller re-reads the head", () => {
    // The five-second poller hands over a brand new array holding the same rows. The old
    // identity check read that as a different queue and dropped everything below it.
    const held: DeeperPatches = {
      key: "pending_approval",
      rows: [patch("p-7", 7), patch("p-6", 6)],
      cursor: "c-6",
    };
    const merged = mergePatchHead(held, {
      patches: [patch("p-9", 9), patch("p-8", 8)],
      nextCursor: "c-8",
    });
    expect(ids(merged.rows)).toEqual(["p-9", "p-8", "p-7", "p-6"]);
    // The held cursor points past p-6, which the head never reached, so it stands.
    expect(merged.cursor).toBe("c-6");
  });

  it("replaces a row the head re-sent, at its sort position, rather than drawing it twice", () => {
    const held: DeeperPatches = {
      key: "all",
      rows: [patch("p-8", 8), patch("p-6", 6)],
      cursor: "x",
    };
    const merged = mergePatchHead(held, {
      patches: [patch("p-9", 9), patch("p-8", 8), patch("p-7", 7)],
      nextCursor: "c-7",
    });
    expect(ids(merged.rows)).toEqual(["p-9", "p-8", "p-7", "p-6"]);
  });

  it("drops a held row INSIDE the head's range that the head no longer carries", () => {
    // It left the filter while nobody was looking. A row BELOW the head's oldest is a different
    // thing — the head says nothing about that part of the queue — and stays.
    const held: DeeperPatches = {
      key: "all",
      rows: [patch("p-8", 8), patch("p-5", 5)],
      cursor: "x",
    };
    const merged = mergePatchHead(held, {
      patches: [patch("p-9", 9), patch("p-7", 7)],
      nextCursor: "c-7",
    });
    expect(ids(merged.rows)).toEqual(["p-9", "p-7", "p-5"]);
  });

  it("takes the page's cursor when nothing deeper survived", () => {
    const nothingKept: DeeperPatches = { key: "all", rows: [patch("p-9", 9)], cursor: "stale" };
    expect(
      mergePatchHead(nothingKept, { patches: [patch("p-9", 9)], nextCursor: "c-9" }).cursor,
    ).toBe("c-9");
  });

  it("stays at the end once the reader has paged there", () => {
    const end: DeeperPatches = { key: "all", rows: [patch("p-5", 5)], cursor: null };
    const merged = mergePatchHead(end, { patches: [patch("p-9", 9)], nextCursor: "c-9" });
    expect(ids(merged.rows)).toEqual(["p-9", "p-5"]);
    expect(merged.cursor).toBeNull();
  });

  it("an empty head under this filter empties the queue", () => {
    const held: DeeperPatches = { key: "failed", rows: [patch("p-5", 5)], cursor: "x" };
    const merged = mergePatchHead(held, { patches: [], nextCursor: null });
    expect(merged.rows).toEqual([]);
    expect(merged.cursor).toBeNull();
  });

  it("breaks same-second ties by id descending, as the server's ORDER BY does", () => {
    const held: DeeperPatches = { key: "all", rows: [patch("p-a", 8)], cursor: "x" };
    const merged = mergePatchHead(held, {
      patches: [patch("p-c", 8), patch("p-b", 8)],
      nextCursor: null,
    });
    expect(ids(merged.rows)).toEqual(["p-c", "p-b", "p-a"]);
  });
});

describe("appending a Load-more page", () => {
  it("starts a fresh stack under a filter nothing was paged under", () => {
    const next = appendPatchPage(null, "all", [patch("p-9", 9)], {
      patches: [patch("p-8", 8)],
      nextCursor: "c-8",
    });
    expect(next).toEqual({ key: "all", rows: [patch("p-9", 9), patch("p-8", 8)], cursor: "c-8" });
  });

  it("holds each row once, whether the head, the stack or the page carried it", () => {
    const held: DeeperPatches = { key: "all", rows: [patch("p-8", 8)], cursor: "c-8" };
    const next = appendPatchPage(held, "all", [patch("p-9", 9)], {
      // p-9 drifted down into this page between the two reads; p-8 is already held.
      patches: [patch("p-9", 9), patch("p-8", 8), patch("p-7", 7)],
      nextCursor: "c-7",
    });
    expect(ids(next.rows)).toEqual(["p-9", "p-8", "p-7"]);
    expect(next.cursor).toBe("c-7");
  });

  it("abandons a stack belonging to another filter", () => {
    const held: DeeperPatches = { key: "failed", rows: [patch("p-8", 8)], cursor: "c-8" };
    const next = appendPatchPage(held, "all", [], { patches: [patch("p-7", 7)], nextCursor: null });
    expect(next).toEqual({ key: "all", rows: [patch("p-7", 7)], cursor: null });
  });

  it("keeps the rows newer arrivals push out of the head", () => {
    // Head [6,5,4], Load more [3,2], then two new patches: the next head is [8,7,6]. Without
    // the held head rows, 5 and 4 would sit in nobody's range and vanish.
    const head = [patch("p-6", 6), patch("p-5", 5), patch("p-4", 4)];
    const held = appendPatchPage(null, "all", head, {
      patches: [patch("p-3", 3), patch("p-2", 2)],
      nextCursor: "c-2",
    });
    const merged = mergePatchHead(held, {
      patches: [patch("p-8", 8), patch("p-7", 7), patch("p-6", 6)],
      nextCursor: "c-6",
    });
    expect(ids(merged.rows)).toEqual(["p-8", "p-7", "p-6", "p-5", "p-4", "p-3", "p-2"]);
    expect(merged.cursor).toBe("c-2");
  });
});

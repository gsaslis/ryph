import { describe, expect, it } from "vitest";
import { placementFor, spliceOf } from "./splice";

const keys = (...names: string[]) => names;

describe("spliceOf", () => {
  it("is null for the same list", () => {
    expect(spliceOf(keys("a", "b"), keys("a", "b"))).toBeNull();
    expect(spliceOf([], [])).toBeNull();
  });

  it("finds rows added at the end, at the start and in the middle", () => {
    expect(spliceOf(keys("a", "b"), keys("a", "b", "c"))).toEqual({ at: 2, removed: 0, added: 1 });
    expect(spliceOf(keys("b", "c"), keys("a", "b", "c"))).toEqual({ at: 0, removed: 0, added: 1 });
    expect(spliceOf(keys("a", "d"), keys("a", "b", "c", "d"))).toEqual({
      at: 1,
      removed: 0,
      added: 2,
    });
  });

  it("finds a gap row replaced by the page it stood for", () => {
    // The head of the run, the gap under it, the rest: the gap fills and its row goes.
    const before = keys("m4", "you", "m4b", "gap-50", "h400", "h401");
    const after = keys("m4", "you", "m4b", "h50", "h51", "h52", "h400", "h401");
    expect(spliceOf(before, after)).toEqual({ at: 3, removed: 1, added: 3 });
  });

  it("does not let a repeated key at the seam count twice", () => {
    expect(spliceOf(keys("a", "a"), keys("a", "a", "a"))).toEqual({ at: 2, removed: 0, added: 1 });
  });

  it("spans every change when there is more than one", () => {
    expect(spliceOf(keys("a", "b", "c", "d"), keys("x", "b", "c", "y", "d"))).toEqual({
      at: 0,
      removed: 3,
      added: 4,
    });
  });

  it("finds rows removed", () => {
    expect(spliceOf(keys("a", "b", "c"), keys("a", "c"))).toEqual({ at: 1, removed: 1, added: 0 });
  });
});

describe("placementFor", () => {
  it("leaves a change of the same length alone", () => {
    expect(placementFor(null, 10)).toEqual({ shift: false, remeasure: 0 });
    expect(placementFor({ at: 2, removed: 1, added: 1 }, 10)).toEqual({
      shift: false,
      remeasure: 0,
    });
  });

  it("holds still for rows landing at the very start, with nothing to measure again", () => {
    expect(placementFor({ at: 0, removed: 0, added: 200 }, 0)).toEqual({
      shift: true,
      remeasure: 0,
    });
  });

  it("holds still for a gap filled above the reader, and has the rows over it measured again", () => {
    // Head rows 0-2, the gap at 3, the reader at row 20 of the old list.
    expect(placementFor({ at: 3, removed: 1, added: 200 }, 20)).toEqual({
      shift: true,
      remeasure: 3,
    });
  });

  it("does not hold still for a change on screen or under it", () => {
    // The reader is looking at the head, and the gap under it fills: the head stays, the rest moves.
    expect(placementFor({ at: 3, removed: 1, added: 200 }, 1)).toEqual({
      shift: false,
      remeasure: 0,
    });
    // The gap row itself is the top row on screen.
    expect(placementFor({ at: 3, removed: 1, added: 200 }, 3)).toEqual({
      shift: false,
      remeasure: 0,
    });
    // Rows arriving at the end of the run.
    expect(placementFor({ at: 300, removed: 0, added: 1 }, 280)).toEqual({
      shift: false,
      remeasure: 0,
    });
  });

  it("holds still for rows taken away above the reader", () => {
    expect(placementFor({ at: 5, removed: 200, added: 1 }, 400)).toEqual({
      shift: true,
      remeasure: 5,
    });
  });
});

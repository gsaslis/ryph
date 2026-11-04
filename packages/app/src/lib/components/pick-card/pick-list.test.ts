import { describe, expect, it } from "vitest";
import { pickSearchable, pickWindow, preselect } from "./pick-list";

type Item = { id: string; name: string };
const list = (n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: `id${i}`, name: `item ${i}` }));
const opts = {
  key: (item: Item) => item.id,
  text: (item: Item) => item.name,
  query: "",
  expanded: false,
  selected: "",
};

describe("pickWindow", () => {
  it("shows a short list whole", () => {
    expect(pickWindow(list(8), opts)).toEqual({ shown: list(8), folded: 0 });
  });

  it("folds a long list to the cap", () => {
    const { shown, folded } = pickWindow(list(20), opts);
    expect(shown.map((i) => i.id)).toEqual(["id0", "id1", "id2", "id3", "id4", "id5"]);
    expect(folded).toBe(14);
  });

  it("shows everything once opened up", () => {
    expect(pickWindow(list(20), { ...opts, expanded: true })).toEqual({
      shown: list(20),
      folded: 0,
    });
  });

  it("keeps the picked item on screen when it lies past the cap", () => {
    const { shown, folded } = pickWindow(list(20), { ...opts, selected: "id12" });
    expect(shown.map((i) => i.id)).toEqual(["id0", "id1", "id2", "id3", "id4", "id12"]);
    expect(folded).toBe(14);
  });

  it("leaves the window alone when the picked item is already in it", () => {
    const { shown } = pickWindow(list(20), { ...opts, selected: "id2" });
    expect(shown.map((i) => i.id)).toEqual(["id0", "id1", "id2", "id3", "id4", "id5"]);
  });

  it("ignores a picked id that is not in the list", () => {
    const { shown } = pickWindow(list(20), { ...opts, selected: "gone" });
    expect(shown).toHaveLength(6);
  });

  it("shows every match of a search, matching each word anywhere, ignoring case", () => {
    const items = [
      { id: "a", name: "acme/app" },
      { id: "b", name: "acme/contracts" },
      { id: "c", name: "radicle/heartwood" },
    ];
    expect(pickWindow(items, { ...opts, query: "  APP acme " }).shown.map((i) => i.id)).toEqual([
      "a",
    ]);
    expect(pickWindow(items, { ...opts, query: "acme" })).toEqual({
      shown: items.slice(0, 2),
      folded: 0,
    });
    expect(pickWindow(items, { ...opts, query: "nothing" }).shown).toEqual([]);
  });
});

describe("pickSearchable", () => {
  it("offers a search only on a long list", () => {
    expect(pickSearchable(8)).toBe(false);
    expect(pickSearchable(9)).toBe(true);
  });
});

describe("preselect", () => {
  it("starts on the one picked last time while it is still there", () => {
    expect(preselect(["a", "b"], "b")).toBe("b");
  });

  it("starts on the only one there is", () => {
    expect(preselect(["a"], null)).toBe("a");
    expect(preselect(["a"], "gone")).toBe("a");
  });

  it("starts on none when there is a choice to make", () => {
    expect(preselect(["a", "b"], null)).toBe("");
    expect(preselect(["a", "b"], "gone")).toBe("");
    expect(preselect([], "a")).toBe("");
  });
});

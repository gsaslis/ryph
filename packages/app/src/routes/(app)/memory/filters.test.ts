import { describe, expect, it } from "vitest";
import type { Memory } from "$lib/api/types";
import {
  filtersToSearch,
  joinPages,
  PAGE_SIZE,
  parseFilters,
  splitPage,
  toApiFilters,
} from "./filters";

describe("the browse filters", () => {
  it("reads known values and ignores anything else", () => {
    const parsed = parseFilters(
      new URLSearchParams(
        "subject=repo:github.com/acme/app&kind=gotcha&status=nope&trust=human&q= vitest ",
      ),
    );
    expect(parsed).toEqual({
      subject: "repo:github.com/acme/app",
      audience: "",
      kind: "gotcha",
      status: "",
      trust: "human",
      q: "vitest",
    });
    expect(parseFilters(new URLSearchParams("subject=planet&audience=agent:")).subject).toBe("");
    expect(parseFilters(new URLSearchParams("audience=agent:a-1")).audience).toBe("agent:a-1");
  });

  it("round-trips through the query string and drops what is unset", () => {
    const filters = parseFilters(new URLSearchParams("kind=fact&q=deploy"));
    expect(filtersToSearch(filters)).toBe("?kind=fact&q=deploy");
    expect(parseFilters(new URLSearchParams(filtersToSearch(filters)))).toEqual(filters);
    expect(filtersToSearch(parseFilters(new URLSearchParams()))).toBe("");
  });

  it("hands the API only what is set, plus the page bound and its offset", () => {
    const filters = parseFilters(new URLSearchParams("subject=org&q=x"));
    expect(toApiFilters(filters)).toEqual({ subject: "org", q: "x", limit: PAGE_SIZE + 1 });
    expect(toApiFilters(filters, 0)).toEqual(toApiFilters(filters));
    expect(toApiFilters(filters, 100)).toEqual({
      subject: "org",
      q: "x",
      limit: PAGE_SIZE + 1,
      offset: 100,
    });
  });

  it("keeps the offset out of the URL", () => {
    expect(filtersToSearch(parseFilters(new URLSearchParams("kind=fact&offset=100")))).toBe(
      "?kind=fact",
    );
  });
});

describe("paging the list", () => {
  const rows = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ id: `mem-${from + i}` }) as Memory);

  it("tells a further page from the probe row, and never shows it", () => {
    expect(splitPage(rows(PAGE_SIZE + 1))).toEqual({ memories: rows(PAGE_SIZE), hasMore: true });
    expect(splitPage(rows(PAGE_SIZE))).toEqual({ memories: rows(PAGE_SIZE), hasMore: false });
    expect(splitPage([])).toEqual({ memories: [], hasMore: false });
  });

  it("joins pages in order and drops a row an offset walk repeated", () => {
    const joined = joinPages([rows(3), rows(3, 2)]);
    expect(joined.map((m) => m.id)).toEqual(["mem-0", "mem-1", "mem-2", "mem-3", "mem-4"]);
  });
});

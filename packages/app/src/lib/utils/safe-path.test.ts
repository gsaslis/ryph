import { describe, expect, it } from "vitest";
import { safeBackTo, withBackTo } from "./safe-path";

describe("safeBackTo", () => {
  it("keeps paths within the app and drops everything else", () => {
    expect(safeBackTo("/welcome?step=repo")).toBe("/welcome?step=repo");
    expect(safeBackTo("https://evil.test")).toBeNull();
    expect(safeBackTo("//evil.test")).toBeNull();
    expect(safeBackTo(null)).toBeNull();
  });

  it("reads the value as a browser would, so whitespace and backslashes cannot leave the app", () => {
    expect(safeBackTo("/\t/evil.test")).toBeNull();
    expect(safeBackTo("/\n/evil.test")).toBeNull();
    expect(safeBackTo("/\t\\evil.test")).toBeNull();
    expect(safeBackTo("/\\evil.test")).toBeNull();
    expect(safeBackTo("/agents#top")).toBe("/agents#top");
  });

  it("refuses a path that dot segments turn protocol-relative", () => {
    for (
      const value of [
        "/..//evil.test",
        "/.//evil.test",
        "/%2e%2e//evil.test",
        "/x/../\\evil.test",
        "/./\\evil.test",
      ]
    ) {
      expect(safeBackTo(value)).toBeNull();
    }
    expect(safeBackTo("/a/../agents")).toBe("/agents");
  });
});

describe("withBackTo", () => {
  it("leaves the link alone without a page to return to", () => {
    expect(withBackTo("/repos/connect", null)).toBe("/repos/connect");
    expect(withBackTo("/repos/connect", "https://evil.test")).toBe("/repos/connect");
  });

  it("carries the page along, after any query the link has", () => {
    expect(withBackTo("/repos/connect/local", "/welcome?step=repo")).toBe(
      "/repos/connect/local?backTo=%2Fwelcome%3Fstep%3Drepo",
    );
    expect(withBackTo("/repos/connect?provider=github", "/welcome")).toBe(
      "/repos/connect?provider=github&backTo=%2Fwelcome",
    );
  });
});

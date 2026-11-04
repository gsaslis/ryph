import { describe, expect, it } from "vitest";
import { describeLimit, parseTyped } from "./limits";

describe("describeLimit", () => {
  it("turns the event's detail into the sentence's object", () => {
    expect(describeLimit("spend: $0.02")).toBe("spend cap of $0.02");
    expect(describeLimit("wall-clock: 2m")).toBe("wall clock of 2m");
    expect(describeLimit("something else")).toBe("something else");
  });
});

describe("parseTyped", () => {
  it("reads a blank as null and anything else as a number", () => {
    expect(parseTyped("")).toBeNull();
    expect(parseTyped(" 2 ")).toBe(2);
    expect(parseTyped(3)).toBe(3);
    expect(parseTyped("abc")).toBeNaN();
  });
});

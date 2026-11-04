import { describe, expect, it } from "vitest";
import {
  evilWorkingVerbs,
  nextWorkingVerbIndex,
  workingVerbIntervalMs,
  workingVerbs,
} from "./working-verbs";

describe("working verbs", () => {
  it("can randomly start with any verb", () => {
    for (let index = 0; index < workingVerbs.length; index++) {
      expect(nextWorkingVerbIndex(-1, () => (index + 0.5) / workingVerbs.length)).toBe(index);
    }
  });

  it("can pick every other verb, but never repeats the current one", () => {
    for (let previous = 0; previous < workingVerbs.length; previous++) {
      const choices = Array.from(
        { length: workingVerbs.length - 1 },
        (_, slot) => nextWorkingVerbIndex(previous, () => (slot + 0.5) / (workingVerbs.length - 1)),
      );
      expect(choices).toEqual(workingVerbs.map((_, index) => index).filter((i) => i !== previous));
    }
  });

  it("offers at least thirty unique verbs", () => {
    expect(workingVerbs.length).toBeGreaterThanOrEqual(30);
    expect(new Set(workingVerbs).size).toBe(workingVerbs.length);
  });

  it("uses word labels with an -ing verb, allowing capitals, digits and hyphens", () => {
    for (const verb of workingVerbs) {
      expect(verb, `Invalid working label: ${verb}`).toMatch(
        /^[a-z][a-z0-9]*([ -][a-z][a-z0-9]*)*$/i,
      );
      expect(verb, `Missing -ing verb: ${verb}`).toMatch(/\b[a-z]+ing\b/i);
    }
  });

  it("only marks labels that exist as evil", () => {
    for (const verb of evilWorkingVerbs) expect(workingVerbs).toContain(verb);
  });

  it("starts with working and includes the requested playful verbs", () => {
    expect(workingVerbs[0]).toBe("working");
    expect(workingVerbs).toEqual(
      expect.arrayContaining(["combobulating", "hallucinating", "clanking", "throbbing"]),
    );
    expect(workingVerbIntervalMs).toBe(8_000);
  });
});

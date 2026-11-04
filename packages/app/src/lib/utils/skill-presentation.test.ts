import { describe, expect, it } from "vitest";
import type { SkillPresentation } from "$lib/api/types";
import {
  hasBrandColor,
  iconIsMask,
  presentationFacts,
  skillIconSrc,
  skillMonogram,
  skillSummary,
  skillTint,
  skillTitle,
  titleIsName,
} from "./skill-presentation";

const bare: SkillPresentation = {
  displayName: null,
  shortDescription: null,
  brandColor: null,
  defaultPrompt: null,
  implicitInvocation: true,
  author: null,
  version: null,
  iconSmall: null,
  iconLarge: null,
};

const skill = { name: "ryph-checks", description: "The format and rules of checks.yml." };

describe("a skill's words", () => {
  it("falls back to the name and the description without a presentation", () => {
    const plain = { ...skill, presentation: null };
    expect(skillTitle(plain)).toBe("ryph-checks");
    expect(titleIsName(plain)).toBe(true);
    expect(skillSummary(plain)).toBe(skill.description);
  });

  it("falls back field by field when the presentation leaves one out", () => {
    const named = { ...skill, presentation: { ...bare, displayName: "Checks" } };
    expect(skillTitle(named)).toBe("Checks");
    expect(titleIsName(named)).toBe(false);
    expect(skillSummary(named)).toBe(skill.description);
    const summed = { ...skill, presentation: { ...bare, shortDescription: "Run checks." } };
    expect(skillTitle(summed)).toBe("ryph-checks");
    expect(skillSummary(summed)).toBe("Run checks.");
  });

  it("lists the description as a fact only when a short description stands in for it", () => {
    expect(presentationFacts({ ...skill, presentation: null })).toEqual([]);
    expect(presentationFacts({ ...skill, presentation: { ...bare, displayName: "Checks" } }))
      .toEqual([]);
    expect(
      presentationFacts({ ...skill, presentation: { ...bare, shortDescription: "Run checks." } }),
    ).toEqual([{ term: "Description", value: skill.description }]);
  });

  it("lists the author's version as its own fact, never as the version", () => {
    expect(presentationFacts({ ...skill, presentation: { ...bare, version: "1.2.0" } }))
      .toEqual([{ term: "Author's version", value: "1.2.0" }]);
  });
});

describe("a skill's mark", () => {
  it("takes the first letter of the first two words", () => {
    expect(skillMonogram("release")).toBe("R");
    expect(skillMonogram("code-review")).toBe("CR");
    expect(skillMonogram("Cut a release")).toBe("CA");
    expect(skillMonogram("2fa_setup")).toBe("2S");
    expect(skillMonogram("élan vital")).toBe("ÉV");
    expect(skillMonogram("--")).toBe("?");
  });

  it("tints with a valid brand colour, else a theme hue that stays the same for a name", () => {
    expect(skillTint("release", "#3B82F6")).toBe("#3B82F6");
    expect(skillTint("release", "blue")).toMatch(/^var\(--brand-[a-e]\)$/);
    expect(skillTint("release", null)).toBe(skillTint("release", undefined));
    const tints = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((n) => skillTint(n, null)));
    expect(tints.size).toBeGreaterThan(1);
    expect(hasBrandColor({ ...bare, brandColor: "#3B82F6" })).toBe(true);
    expect(hasBrandColor({ ...bare, brandColor: "#3B82F" })).toBe(false);
    expect(hasBrandColor(null)).toBe(false);
  });

  it("builds an image source and masks only SVGs", () => {
    const svg = { mime: "image/svg+xml" as const, data: "PHN2Zy8+" };
    const png = { mime: "image/png" as const, data: "iVBORw0KGgo=" };
    expect(skillIconSrc(svg)).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    expect(iconIsMask(svg)).toBe(true);
    expect(iconIsMask(png)).toBe(false);
  });
});

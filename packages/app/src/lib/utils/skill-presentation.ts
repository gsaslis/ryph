// How a skill is shown on a card or its page: the words and the mark its presentation gives, and
// what stands in for each when it gives none. Every string here is plain text for the template to
// escape; none of it is ever rendered as markup.

import type { SkillIcon, SkillPresentation } from "$lib/api/types";

type Presented = { name: string; description: string; presentation: SkillPresentation | null };

/** The name a person reads: the display name when the skill sets one, else its name. */
export function skillTitle(skill: Presented): string {
  return skill.presentation?.displayName ?? skill.name;
}

/** Whether the title is the skill's own name, so the name need not be shown a second time. */
export function titleIsName(skill: Presented): boolean {
  return skillTitle(skill) === skill.name;
}

/** The line under the title: the short description when there is one, else the description. */
export function skillSummary(skill: Presented): string {
  return skill.presentation?.shortDescription ?? skill.description;
}

/**
 * Up to two letters for a skill without an icon: the first of each of its first two words, so
 * `release` is R and `code-review` is CR. Letters and digits of any script count.
 */
export function skillMonogram(text: string): string {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((w) => Array.from(w)[0].toLocaleUpperCase())
    .join("");
}

/** The theme's brand hues, each defined for light and dark. */
const TINTS = [
  "var(--brand-a)",
  "var(--brand-b)",
  "var(--brand-c)",
  "var(--brand-d)",
  "var(--brand-e)",
] as const;

const HEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * The colour a skill's mark is tinted with: its brand colour when it sets a valid one, else one
 * of the theme's brand hues picked by its name, so a skill keeps its tint from load to load.
 */
export function skillTint(name: string, brandColor: string | null | undefined): string {
  if (brandColor && HEX.test(brandColor)) return brandColor;
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return TINTS[hash % TINTS.length];
}

/** Whether the skill sets its own colour, as opposed to a tint picked for it. */
export function hasBrandColor(presentation: SkillPresentation | null): boolean {
  return presentation?.brandColor != null && HEX.test(presentation.brandColor);
}

/** An icon as an image source. */
export function skillIconSrc(icon: SkillIcon): string {
  return `data:${icon.mime};base64,${icon.data}`;
}

/**
 * Whether an icon is drawn through a mask in a theme colour rather than as itself. Every SVG is:
 * one drawn in `currentColor` would be black inside an image, and one in black alone would vanish
 * in dark mode. A raster icon keeps its own colours.
 */
export function iconIsMask(icon: SkillIcon): boolean {
  return icon.mime === "image/svg+xml";
}

/**
 * The facts a skill's page adds from its presentation. The description, when the header shows a
 * short description in its place: it is still what an agent reads to decide whether to open the
 * skill. The author's own version string, apart from the synced version the page names by digest.
 */
export function presentationFacts(skill: Presented): { term: string; value: string }[] {
  const facts = skillSummary(skill) === skill.description
    ? []
    : [{ term: "Description", value: skill.description }];
  const version = skill.presentation?.version;
  return version ? [...facts, { term: "Author's version", value: version }] : facts;
}

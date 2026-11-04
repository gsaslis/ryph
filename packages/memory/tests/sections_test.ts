// The section splitter and the doc renderer: headings make sections, fences are not headings,
// overlong sections are cut at paragraphs, and a big document serves its index and head.

import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  findSection,
  MAX_DOC_CHARS,
  MAX_SECTION_CHARS,
  renderDoc,
  splitSections,
} from "../src/core/sections.ts";

const DOC = `Intro paragraph.

# Deploy

How to deploy.

## Rollback

\`\`\`sh
# not a heading
deno task rollback
\`\`\`

# Testing

Vitest.
`;

test("headings make sections, titled by their path; fences are not headings", () => {
  const sections = splitSections(DOC);
  assertEquals(sections.map((s) => s.title), [
    "Introduction",
    "Deploy",
    "Deploy › Rollback",
    "Testing",
  ]);
  assertStringIncludes(sections[2].text, "# not a heading");
  assertEquals(findSection(sections, "rollback")?.title, "Deploy › Rollback");
  assertEquals(findSection(sections, "Deploy › Rollback")?.title, "Deploy › Rollback");
  assertEquals(findSection(sections, "nope"), null);
});

test("headingless text is one part; overlong sections are cut at paragraph breaks", () => {
  assertEquals(splitSections("just text"), [{ title: "Part 1", text: "just text" }]);
  const long = Array.from({ length: 5 }, (_, i) => `${"p".repeat(2_000)} ${i}`).join("\n\n");
  const parts = splitSections(`# Big\n\n${long}`);
  assertEquals(parts.length, 3);
  assertEquals(parts.map((p) => p.title), ["Big (1)", "Big (2)", "Big (3)"]);
  for (const p of parts) assertEquals(p.text.length <= MAX_SECTION_CHARS, true);
  assertEquals(findSection(parts, "Big")?.title, "Big (1)");
});

test("renderDoc serves a small document whole and a large one by index and head", () => {
  assertEquals(renderDoc("T", "body", []), "# T\n\nbody");
  const big = "x".repeat(MAX_DOC_CHARS + 10);
  const out = renderDoc("T", big, [{ title: "Part 1", text: big }]);
  assertStringIncludes(out, "Sections:\n- Part 1 (");
  assertEquals(out.endsWith("x".repeat(MAX_DOC_CHARS)), true);
});

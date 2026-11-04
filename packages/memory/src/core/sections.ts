// A document, cut into the pieces the extractor works on and `doc` serves: markdown headings
// make sections, headingless text falls back to paragraphs, and every section is bounded so a
// model call and a tool result stay bounded too. Pure.

import { fenceCloses, type FenceOpen, fenceOpen } from "@ryph/shared/markdown";
import type { SourceSection } from "./types.ts";

/** A section longer than this is split further at paragraph breaks. */
export const MAX_SECTION_CHARS = 6_000;
/** What `doc` serves of a source at most, when no section is asked for. */
export const MAX_DOC_CHARS = 12_000;

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * Splits markdown into sections by heading, each titled by its heading path
 * ("Deploy › Rollback"). Text before the first heading is the "Introduction" section when it
 * is not blank. Overlong sections are cut at paragraph breaks, numbered "… (2)".
 */
export function splitSections(text: string): SourceSection[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const raw: Array<{ path: string[]; lines: string[] }> = [];
  let current = { path: [] as string[], lines: [] as string[] };
  const stack: Array<{ level: number; title: string }> = [];
  let fence: FenceOpen | null = null;
  for (const line of lines) {
    // A heading inside a code block is code, not a section.
    if (fence !== null && fenceCloses(fence, line)) fence = null;
    else if (fence === null) fence = fenceOpen(line);
    const heading = fence === null ? line.match(HEADING) : null;
    if (heading === null) {
      current.lines.push(line);
      continue;
    }
    raw.push(current);
    const level = heading[1].length;
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title: heading[2].trim() });
    current = { path: stack.map((s) => s.title), lines: [] };
  }
  raw.push(current);

  // No headings at all: parts, not an "introduction" to nothing.
  if (raw.length === 1) {
    const content = text.trim();
    if (content === "") return [];
    return bound(content).map((part, i) => ({ title: `Part ${i + 1}`, text: part }));
  }

  const sections: SourceSection[] = [];
  for (const { path, lines: body } of raw) {
    const content = body.join("\n").trim();
    if (content === "") continue;
    const title = path.length === 0 ? "Introduction" : path.join(" › ");
    const parts = bound(content);
    parts.forEach((part, i) => {
      sections.push({ title: parts.length === 1 ? title : `${title} (${i + 1})`, text: part });
    });
  }
  return sections;
}

/** Cuts text at paragraph breaks into pieces of at most MAX_SECTION_CHARS. A single paragraph
 * over the bound is cut at the bound. */
function bound(text: string): string[] {
  if (text.length <= MAX_SECTION_CHARS) return [text];
  const out: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    const piece = paragraph.length > MAX_SECTION_CHARS
      ? paragraph.slice(0, MAX_SECTION_CHARS)
      : paragraph;
    if (current !== "" && current.length + 2 + piece.length > MAX_SECTION_CHARS) {
      out.push(current);
      current = piece;
    } else {
      current = current === "" ? piece : `${current}\n\n${piece}`;
    }
  }
  if (current !== "") out.push(current);
  return out;
}

/** The section named, or null. Titles are compared case-insensitively, and a bare heading
 * matches the deepest path ending in it ("Rollback" finds "Deploy › Rollback"). */
export function findSection(sections: SourceSection[], title: string): SourceSection | null {
  const wanted = title.trim().toLowerCase();
  return sections.find((s) => s.title.toLowerCase() === wanted) ??
    sections.find((s) => s.title.toLowerCase().endsWith(`› ${wanted}`)) ??
    sections.find((s) => s.title.toLowerCase().replace(/ \(\d+\)$/, "") === wanted) ??
    null;
}

/** A source's text as `doc` serves it: whole when it fits, else the section index and the
 * head, so the agent asks for the section it wants. */
export function renderDoc(
  title: string,
  text: string,
  sections: SourceSection[],
): string {
  if (text.length <= MAX_DOC_CHARS) return `# ${title}\n\n${text}`;
  const index = sections.map((s) => `- ${s.title} (${s.text.length} chars)`).join("\n");
  return [
    `# ${title}`,
    "",
    `This document is ${text.length} characters; here are its first ${MAX_DOC_CHARS}. Ask for ` +
    "one section by title to read the rest.",
    "",
    "Sections:",
    index,
    "",
    "---",
    text.slice(0, MAX_DOC_CHARS),
  ].join("\n");
}

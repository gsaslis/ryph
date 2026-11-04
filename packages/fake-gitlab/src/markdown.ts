// The block structure of GitLab markdown, as far as quick actions and suggestions need it: which
// source lines make up a TOP-LEVEL paragraph (the only place GitLab runs a quick action), and
// which fenced code blocks there are and what they hold (a `suggestion` fence is a suggestion).
//
// CommonMark's container algorithm, line by line: block quotes (`>`), list items (by their
// content indent), fenced code, indented code, HTML blocks (types 1–7), ATX headings, thematic
// breaks, and paragraphs with lazy continuation lines. GitLab's markdown (comrak with GitLab's
// extensions) has more, and this model never claims to know it: from the first line of a block
// it does not model — a description list's `: ` details, an alert (`> [!note]`), GitLab's `>>>`
// block quote, front matter, a footnote or link reference definition, a `$$` math block — every non-blank line is
// taken as a top-level paragraph of its own (a fence's lines included), so the fake may run a
// command GitLab would not, and never the reverse. A setext heading's text likewise stays a
// paragraph, and tables are paragraphs.
// Tabs are expanded to the next multiple of four for structure; a fence's content is taken from
// the source line itself, so a tab inside it is kept, and its info string is read as CommonMark
// reads it, backslash escapes and character references resolved.

import { fenceCloses, type FenceOpen, fenceOpen } from "@ryph/shared/markdown";

/** A fenced code block: its info string, its content lines (the opening fence's indent taken
 * off), and whether it sits at the top level (no container around it). */
export interface Fence {
  info: string;
  content: string[];
  topLevel: boolean;
}

export interface Blocks {
  /** Per source line: part of a paragraph that is a direct child of the document. */
  topParagraph: boolean[];
  /** Per source line: which top-level paragraph it is part of (an index), or -1. */
  paragraphOf: number[];
  fences: Fence[];
}

type Container =
  | { kind: "quote" }
  | { kind: "item"; c: number; empty: boolean };

type Leaf =
  | { kind: "paragraph"; top: number }
  | { kind: "fence"; open: FenceOpen; fence: Fence }
  | { kind: "icode" }
  | { kind: "html"; end: RegExp | null };

const LIST_ITEM = /^( {0,3})([-+*]|(\d{1,9})[.)])( *)(.*)$/;
const THEMATIC = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const BLOCK_TAGS = "address|article|aside|base|basefont|blockquote|body|caption|center|col|" +
  "colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|" +
  "frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|" +
  "noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|" +
  "title|tr|track|ul";
const ATTRIBUTE = String
  .raw`\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>\x60]+|'[^']*'|"[^"]*"))?`;
/** CommonMark's HTML block starts, each with what ends it (null: a blank line). */
const HTML_STARTS: Array<{ start: RegExp; end: RegExp | null; interrupts: boolean }> = [
  {
    start: /^ {0,3}<(?:script|pre|style|textarea)(?:[ \t>]|$)/i,
    end: /<\/(?:script|pre|style|textarea)>/i,
    interrupts: true,
  },
  { start: /^ {0,3}<!--/, end: /-->/, interrupts: true },
  { start: /^ {0,3}<\?/, end: /\?>/, interrupts: true },
  { start: /^ {0,3}<![A-Za-z]/, end: />/, interrupts: true },
  { start: /^ {0,3}<!\[CDATA\[/, end: /\]\]>/, interrupts: true },
  {
    start: new RegExp(String.raw`^ {0,3}<\/?(?:${BLOCK_TAGS})(?:[ \t]|\/?>|$)`, "i"),
    end: null,
    interrupts: true,
  },
  {
    start: new RegExp(
      String
        .raw`^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:${ATTRIBUTE})*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$`,
    ),
    end: null,
    interrupts: false,
  },
];

/** The first line of a block this model does not know, read through any container prefix. */
const UNMODELLED = [
  /^[ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)*:/, // a description list's details
  /^[ \t]*>[ \t>]*\[!/, // an alert
  /^[ \t>]*>>>/, // GitLab's multi-line block quote
  /^[ \t>]*\[[^\]]*\]:/, // a footnote or link reference definition
  /^[ \t>]*\$\$/, // a math block
];
/** Front matter, on the text's first line. */
const FRONT_MATTER = /^ *(?:---|\+\+\+|;;;)/;

/** CommonMark's backslash escapes and character references, as an info string resolves them. */
const ESCAPE_OR_REFERENCE =
  /\\([!-/:-@[-`{-~])|&#[xX]([0-9a-fA-F]{1,6});|&#([0-9]{1,7});|&(amp|lt|gt|quot);/g;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"' };
const codePoint = (n: number) => n === 0 || n > 0x10ffff ? "\uFFFD" : String.fromCodePoint(n);
const decode = (info: string) =>
  info.replace(
    ESCAPE_OR_REFERENCE,
    (_, esc, hex, dec, named) =>
      esc ?? (hex !== undefined
        ? codePoint(parseInt(hex, 16))
        : dec !== undefined
        ? codePoint(Number(dec))
        : NAMED[named]!),
  );

const blank = (s: string) => /^[ \t]*$/.test(s);
const indentOf = (s: string) => /^ */.exec(s)![0].length;

/** Tabs to spaces, to the next multiple of four. */
function expandTabs(line: string): string {
  let out = "";
  for (const ch of line) out += ch === "\t" ? " ".repeat(4 - (out.length % 4)) : ch;
  return out;
}

/** `raw` from column `col` on, as written: a tab the column falls inside gives up only the
 * columns before it, as spaces (CommonMark's partial tab). */
function fromColumn(raw: string, col: number): string {
  let at = 0;
  for (let i = 0; i < raw.length; i++) {
    if (at >= col) return raw.slice(i);
    const next = raw[i] === "\t" ? at + 4 - (at % 4) : at + 1;
    if (next > col) return " ".repeat(next - col) + raw.slice(i + 1);
    at = next;
  }
  return "";
}

/** GitLab's front matter (`Gitlab::FrontMatter::PATTERN_UNTRUSTED`, RE2): at the very start of
 * the text, an optional line saying `coding:`, any blanks, an opening `---`, `+++` or `;;;` with
 * an optional language, the content, and a closing delimiter of any of the three or `...`. */
const FRONT_MATTER_BLOCK =
  /^(?<encoding>[^\r\n]*coding:[^\r\n]*(?:\r\n|\n|\r))?(?<before>[\t\n\f\r ]*)^(?<delim>---|\+\+\+|;;;)[ \t]*(?<lang>[^\t\n\f\r ]*)(?:\r\n|\n|\r)(?<front>[\s\S]*?)^(?:---|\+\+\+|;;;|\.{3})[\t\f ]*(?:\r\n|\n|\r|$)/my;
const FRONT_MATTER_LANG: Record<string, string> = { "---": "yaml", "+++": "toml", ";;;": "json" };

/**
 * `text` as GitLab's markdown pre-processing leaves it before comrak reads it (`PreProcessPipeline`),
 * as far as this model goes: a leading byte-order mark dropped (`NormalizeSourceFilter`), and
 * front matter rewritten to a fence (`FrontMatterFilter`) — `---suggestion` … `---` becomes
 * ```` ```suggestion:frontmatter ````, which GitLab then takes for a suggestion.
 */
export function preProcessed(text: string): string {
  const out = text.replace(/^\uFEFF/, "");
  FRONT_MATTER_BLOCK.lastIndex = 0;
  const m = FRONT_MATTER_BLOCK.exec(out);
  if (m === null) return out;
  const g = m.groups!;
  const lang = g.lang || FRONT_MATTER_LANG[g.delim!]!;
  const before = g.encoding ? `\n${g.before}` : g.before!;
  return `${before}\`\`\`${lang}:frontmatter\n${g.front}\`\`\`\n${out.slice(m[0].length)}`;
}

/** The blocks of `text`, whose `\r` the caller has already deleted (as GitLab does). */
export function blocksOf(text: string): Blocks {
  const lines = text.split("\n");
  const topParagraph = lines.map(() => false);
  const paragraphOf = lines.map(() => -1);
  const fences: Fence[] = [];
  const stack: Container[] = [];
  let leaf: Leaf | null = null;
  let paragraphs = 0;
  /** The first line of a block this model does not know: every line from it on is taken as
   * paragraph text. */
  let unmodelledFrom = FRONT_MATTER.test(lines[0] ?? "") ? 0 : lines.length;

  lines.forEach((raw, i) => {
    const ln = expandTabs(raw);

    // 1. Which open containers the line continues.
    let rest = ln;
    let matched = 0;
    for (const c of stack) {
      if (c.kind === "quote") {
        const m = /^ {0,3}> ?/.exec(rest);
        if (m === null) break;
        rest = rest.slice(m[0].length);
      } else if (blank(rest)) {
        // An item that began with a blank line ends at a second one.
        if (c.empty && leaf === null) break;
        rest = "";
      } else if (indentOf(rest) >= c.c) {
        rest = rest.slice(c.c);
        c.empty = false;
      } else break;
      matched++;
    }
    const all = matched === stack.length;
    const closeUnmatched = () => {
      if (matched < stack.length) {
        stack.length = matched;
        leaf = null;
      }
    };

    // 2. An open fence, HTML block or indented code takes the line when every container does.
    if (leaf?.kind === "fence") {
      if (all) {
        if (fenceCloses(leaf.open, rest)) {
          leaf = null;
          return;
        }
        const strip = Math.min(indentOf(rest), leaf.open.indent);
        leaf.fence.content.push(fromColumn(raw, ln.length - rest.length + strip));
        return;
      }
      closeUnmatched();
    } else if (leaf?.kind === "html") {
      if (all) {
        if (leaf.end === null ? blank(rest) : leaf.end.test(rest)) leaf = null;
        return;
      }
      closeUnmatched();
    } else if (leaf?.kind === "icode") {
      if (all && (blank(rest) || indentOf(rest) >= 4)) return;
      leaf = null;
    }

    if (i < unmodelledFrom && UNMODELLED.some((r) => r.test(ln))) unmodelledFrom = i;

    // 3. New blocks, containers first.
    for (;;) {
      const paragraphOpen: boolean = (leaf as Leaf | null)?.kind === "paragraph";
      if (blank(rest)) {
        closeUnmatched();
        leaf = null;
        return;
      }
      if (indentOf(rest) >= 4) {
        if (paragraphOpen) break; // continuation text, lazy or not
        closeUnmatched();
        leaf = { kind: "icode" };
        return;
      }
      if (paragraphOpen && all && /^ {0,3}(?:=+|-+)[ \t]*$/.test(rest)) {
        // A setext underline: the paragraph was a heading (its lines stay marked — a fake that
        // may run a command GitLab would not).
        leaf = null;
        return;
      }
      const quote = /^ {0,3}> ?/.exec(rest);
      if (quote) {
        closeUnmatched();
        leaf = null;
        stack.push({ kind: "quote" });
        matched = stack.length;
        rest = rest.slice(quote[0].length);
        continue;
      }
      const item = THEMATIC.test(rest) ? null : LIST_ITEM.exec(rest);
      if (item && (item[4] !== "" || item[5] === "")) {
        const content = item[5]!;
        const startsOne = item[3] === undefined || Number(item[3]) === 1;
        // Only a paragraph the line would continue without laziness is interrupted with care.
        const interrupting = paragraphOpen && matched === stack.length;
        if (!interrupting || (content !== "" && startsOne)) {
          closeUnmatched();
          leaf = null;
          const width = item[1]!.length + item[2]!.length;
          const spaces = item[4]!.length;
          const c = content === "" || spaces >= 5 ? width + 1 : width + spaces;
          stack.push({ kind: "item", c, empty: content === "" });
          matched = stack.length;
          rest = content === "" ? "" : rest.slice(spaces >= 5 ? width + 1 : c);
          if (content === "") return;
          continue;
        }
      }
      const open = fenceOpen(rest);
      if (open) {
        closeUnmatched();
        const f: Fence = { info: decode(open.info), content: [], topLevel: stack.length === 0 };
        fences.push(f);
        leaf = { kind: "fence", open, fence: f };
        return;
      }
      const html = HTML_STARTS.find((h) => h.start.test(rest));
      // A lone tag (type 7) cannot interrupt a paragraph — but one the line would only continue
      // lazily is no paragraph it interrupts (cmark's and comrak's reading).
      if (html && (html.interrupts || !paragraphOpen || matched < stack.length)) {
        closeUnmatched();
        leaf = html.end?.test(rest) ? null : { kind: "html", end: html.end };
        return;
      }
      if (HEADING.test(rest) || THEMATIC.test(rest)) {
        closeUnmatched();
        leaf = null;
        return;
      }
      break;
    }

    // 4. Paragraph text: a continuation (lazy, when containers went unmatched) or a new one.
    if ((leaf as Leaf | null)?.kind !== "paragraph") {
      closeUnmatched();
      leaf = { kind: "paragraph", top: stack.length === 0 ? paragraphs++ : -1 };
    }
    const top = (leaf as { top: number }).top;
    if (top >= 0) {
      topParagraph[i] = true;
      paragraphOf[i] = top;
    }
  });
  for (let i = unmodelledFrom; i < lines.length; i++) {
    if (blank(lines[i]!)) continue;
    topParagraph[i] = true;
    paragraphOf[i] = paragraphs++;
  }
  return { topParagraph, paragraphOf, fences };
}

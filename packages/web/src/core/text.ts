// A web page as plain text, for a reader that wants the words and not the article: memory's URL
// ingest, which keeps the whole document and extracts from it itself. Crude but honest — scripts,
// styles and the head dropped, tags stripped, the common entities decoded, block ends turned into
// line breaks, whitespace collapsed.
//
// LINEAR, by construction, because the input is a page somebody else wrote. The regex version
// this replaces (`/<[^>]+>/g`, `/<(script|style)[\s\S]*?<\/\1>/gi`) re-scanned the rest of the
// document from every unclosed `<` and every `<script` with no end tag: 200 KB of either took
// 5 s and the 2 MiB cap ~9 minutes, on the event loop every other request shares. Here every
// search starts where the last one ended, and a search that finds nothing ends the scan, so no
// byte is looked at more than a constant number of times. Anything added below keeps that
// shape: no regex that can try a match from many starting points over the same run of text.

export interface PageText {
  /** The first <title>'s text, or null when there is none (or it is empty). */
  title: string | null;
  /** The body's text. Empty when the page has none. */
  text: string;
}

/** Elements whose content is not text at all; everything up to the matching end tag goes. */
const RAW = new Set(["script", "style", "noscript", "template", "textarea", "xmp"]);
/** Elements whose END becomes a line break, so paragraphs and list items stay apart. */
const BLOCK = new Set([
  "p",
  "div",
  "li",
  "tr",
  "section",
  "article",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);
const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
};

/** HTML → text in one pass over the input. */
export function htmlToText(html: string): PageText {
  // ASCII-only lowering keeps every index the same in both strings (String.toLowerCase does not:
  // "İ" becomes two code units), so a tag found in `lower` is cut from `html` at the same place.
  const lower = html.replace(/[A-Z]+/g, (s) => s.toLowerCase());
  const n = html.length;
  const out: string[] = [];
  let title: string | null = null;
  let inHead = false;
  // `text` is where the run of text not yet copied out begins; `i` is where the next `<` is
  // looked for. They differ only across a `<` that opens no tag ("a < b"), which stays text.
  let text = 0;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      if (!inHead) out.push(html.slice(text, lt));
      const end = html.indexOf("-->", lt + 4);
      i = text = end < 0 ? n : end + 3;
      continue;
    }
    const tag = tagAt(lower, lt);
    if (tag === null) {
      i = lt + 1;
      continue;
    }
    if (!inHead) out.push(html.slice(text, lt));
    // No `>` anywhere after this point: there is no tag left in the page either.
    const gt = html.indexOf(">", tag.nameEnd);
    if (gt < 0) {
      i = text = n;
      break;
    }
    i = text = gt + 1;
    const { name, closing } = tag;
    if (!closing && (name === "title" || RAW.has(name))) {
      const end = lower.indexOf(`</${name}`, i);
      const content = html.slice(i, end < 0 ? n : end);
      if (name === "title" && title === null) title = decode(content).trim() || null;
      const close = end < 0 ? -1 : html.indexOf(">", end);
      i = text = close < 0 ? n : close + 1;
      continue;
    }
    if (name === "head") {
      inHead = !closing;
      continue;
    }
    if (name === "body") {
      inHead = false;
      continue;
    }
    if (inHead) continue;
    if (name === "br") out.push("\n");
    else if (closing && BLOCK.has(name)) out.push("\n");
    else if (!closing && /^h[1-6]$/.test(name)) out.push(`\n${"#".repeat(Number(name[1]))} `);
    else if (!closing && name === "li") out.push("- ");
  }
  if (!inHead) out.push(html.slice(text));
  return { title, text: tidy(decode(out.join(""))) };
}

/** The tag that starts at `lt`, or null when the `<` opens none. Reads the name once. */
function tagAt(
  lower: string,
  lt: number,
): { name: string; closing: boolean; nameEnd: number } | null {
  let p = lt + 1;
  const closing = lower[p] === "/";
  if (closing) p += 1;
  const first = lower.charCodeAt(p);
  if (first === 33 /* ! */ || first === 63 /* ? */) {
    // A doctype or processing instruction: stripped like a tag, nameless.
    return { name: "", closing, nameEnd: p + 1 };
  }
  if (!(first >= 97 && first <= 122)) return null;
  let end = p + 1;
  while (end < lower.length && isNameChar(lower.charCodeAt(end))) end += 1;
  return { name: lower.slice(p, end), closing, nameEnd: end };
}

function isNameChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 /* - */;
}

/** The common entities, each decoded once (so `&amp;lt;` reads `&lt;`, as the page meant). */
function decode(text: string): string {
  return text.replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_m, name: string) => ENTITIES[name]);
}

/** Trailing blanks off every line, at most one empty line in a row, nothing around the whole. */
function tidy(text: string): string {
  const lines: string[] = [];
  let empty = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      empty += 1;
      if (empty > 1) continue;
    } else {
      empty = 0;
    }
    lines.push(line);
  }
  return lines.join("\n").trim();
}

// A run's Markdown as the HTML a Telegram message renders with `parse_mode: "HTML"`. A run
// writes Markdown everywhere, and a Telegram message with no parse mode shows every `**` and
// backtick as written. Telegram's own MarkdownV2 makes the WRITER escape a long list of
// characters, which the run's text does not, so it is the HTML mode that is used and the
// Markdown is converted here.
//
// Invariants:
// - every character of the source is escaped (`&`, `<`, `>`) and the only tags in the output
//   are the ones this file writes, properly nested: b, i, s, code, pre, a, blockquote. Nothing
//   the source says becomes markup of its own.
// - a link's address is http(s) only. `tg://user?id=…` would mention someone, so anything else
//   stays the text it was written as.
// - what Telegram cannot show (headings, list markers) becomes plain text that reads the same:
//   a heading is a bold line, a bullet is `•`.
// - the visible text is never longer than the source: Telegram counts a message's length after
//   the tags are parsed, so a part cut to the ceiling as Markdown still fits.
// - a bare URL is never formatted inside: `https://x.test/a_b_c` keeps its underscores.

import { fenceCloses, fenceOpen } from "@ryph/shared/markdown";

/** Escapes text for Telegram's HTML: the three characters its parser reads. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const escapeAttr = (text: string) => escapeHtml(text).replace(/"/g, "&quot;");

// A closing run of `#`s is dropped only after whitespace: "# Learning C#" keeps its `#`.
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/** Markdown to Telegram HTML, block by block: fences, headings, quotes, bullets, lines. */
export function markdownToTelegramHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = fenceOpen(line);
    if (fence !== null) {
      // To the fence that closes it, or to the end: a part a long post was cut into may open a
      // block it does not close.
      const body: string[] = [];
      i++;
      while (i < lines.length && !fenceCloses(fence, lines[i])) body.push(lines[i++]);
      i++;
      // The language is the info string's first word; whatever follows it (`title=x`) is dropped.
      const lang = fence.info.split(/\s/)[0] ?? "";
      const code = escapeHtml(body.join("\n"));
      out.push(
        lang === ""
          ? `<pre>${code}</pre>`
          : `<pre><code class="language-${escapeAttr(lang)}">${code}</code></pre>`,
      );
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(renderInline(QUOTE.exec(lines[i])![1]));
        i++;
      }
      out.push(`<blockquote>${quoted.join("\n")}</blockquote>`);
      continue;
    }
    i++;
    const heading = HEADING.exec(line);
    if (heading !== null) {
      out.push(heading[1] === "" ? "" : `<b>${renderInline(heading[1])}</b>`);
      continue;
    }
    if (RULE.test(line)) {
      out.push("──────");
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      out.push(`${bullet[1]}• ${renderInline(bullet[2])}`);
      continue;
    }
    out.push(renderInline(line));
  }
  return out.join("\n");
}

/** Emphasis delimiters, longest first, and the tag each one is. */
const EMPHASIS: Array<{ delim: string; tag: string }> = [
  { delim: "**", tag: "b" },
  { delim: "__", tag: "b" },
  { delim: "~~", tag: "s" },
  { delim: "*", tag: "i" },
  { delim: "_", tag: "i" },
];

const BARE_URL = /^https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]]/;
const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

/** One line's inline Markdown: code spans, links, bare URLs, emphasis; the rest escaped. */
export function renderInline(text: string): string {
  let out = "";
  let plain = "";
  const flush = () => {
    out += escapeHtml(plain);
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length && /[\\`*_~[\]()#>!-]/.test(text[i + 1])) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const ticks = /^`+/.exec(text.slice(i))![0];
      const close = text.indexOf(ticks, i + ticks.length);
      if (close > i + ticks.length) {
        flush();
        let code = text.slice(i + ticks.length, close);
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        out += `<code>${escapeHtml(code)}</code>`;
        i = close + ticks.length;
        continue;
      }
      plain += ticks;
      i += ticks.length;
      continue;
    }
    if (c === "[") {
      const link = /^\[((?:[^[\]]|\[[^[\]]*\])+)\]\(\s*<?(https?:\/\/[^\s<>()]+)>?\s*\)/.exec(
        text.slice(i),
      );
      if (link !== null) {
        flush();
        out += `<a href="${escapeAttr(link[2])}">${renderInline(link[1])}</a>`;
        i += link[0].length;
        continue;
      }
    }
    if ((c === "h" || c === "H") && !isWordChar(text[i - 1])) {
      const url = BARE_URL.exec(text.slice(i));
      if (url !== null) {
        plain += url[0];
        i += url[0].length;
        continue;
      }
    }
    const span = emphasisAt(text, i);
    if (span !== null) {
      flush();
      out += `<${span.tag}>${renderInline(span.inner)}</${span.tag}>`;
      i = span.end;
      continue;
    }
    plain += c;
    i++;
  }
  flush();
  return out;
}

/**
 * The emphasis span opening at `i`, if one does: the opener is not followed by a space and does
 * not sit inside a word, the closer is the next same delimiter not preceded by a space and not
 * followed by a word character. So `snake_case_name`, `2 * 3 * 4` and a lone `*` stay as written.
 */
function emphasisAt(
  text: string,
  i: number,
): { tag: string; inner: string; end: number } | null {
  for (const { delim, tag } of EMPHASIS) {
    if (!text.startsWith(delim, i)) continue;
    const after = text[i + delim.length];
    if (isSpace(after) || isWordChar(text[i - 1])) return null;
    // A single delimiter never opens on a double one: `**` that found no closer is not `*`.
    if (delim.length === 1 && after === delim) return null;
    let from = i + delim.length + 1;
    while (from <= text.length) {
      const close = text.indexOf(delim, from);
      if (close === -1) break;
      const inner = text.slice(i + delim.length, close);
      const doubled = delim.length === 1 && text[close + 1] === delim;
      if (!isSpace(text[close - 1]) && !isWordChar(text[close + delim.length]) && !doubled) {
        // A code span decides first: a delimiter inside backticks closes nothing.
        if ((inner.match(/`/g)?.length ?? 0) % 2 === 0) {
          return { tag, inner, end: close + delim.length };
        }
      }
      from = close + (doubled ? 2 : 1);
    }
    return null;
  }
  return null;
}

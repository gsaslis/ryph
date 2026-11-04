// Markdown's fenced code blocks, both ways: writing a fence nothing inside can close, and reading
// where one opens and where it ends. Every package that quotes text it did not write into a
// prompt, or reads where a forge renders code, used to carry its own copy of one half or the
// other; the readers had drifted apart (one closed on any line starting with the marker, one
// toggled on any ``` at all, one took any indent).
//
// Invariants:
// - `fence` always writes a bar longer than the longest backtick run in what it quotes, and runs
//   are capped at MAX_BACKTICK_RUN first, so a quote can neither close itself nor buy a bar the
//   size of a prompt budget
// - the reader is CommonMark's fence rule and nothing more: a run of three or more ``` or ~~~
//   behind at most three columns of indent (by default), where a backtick fence's info string
//   holds no backtick; it closes on the same character, at least as long, with nothing after it
//   but blanks. Containers (lists, block quotes) are the caller's, except for the one helper that
//   strips `>` markers, which a reader that does not model block quotes still needs
// - a trailing carriage return never decides anything: CRLF text reads as LF text does

/**
 * The longest backtick run `fence` keeps. Grown freely, the bar is longer than the longest run
 * inside it, so 6_000 backticks of nothing would add 6_000 characters of bar and push a composed
 * prompt past what its schema allows. Nothing legible needs a run this long.
 */
export const MAX_BACKTICK_RUN = 24;

const OVERLONG_RUN = new RegExp("`{" + (MAX_BACKTICK_RUN + 1) + ",}", "g");

/**
 * Wraps `text` so that nothing inside it can end the quote: runs over MAX_BACKTICK_RUN are cut
 * back to it, then the bar is one longer than the longest run left (three at least). `info`
 * follows the opening bar as written.
 */
export function fence(text: string, info = ""): string {
  const capped = text.replace(OVERLONG_RUN, "`".repeat(MAX_BACKTICK_RUN));
  const longest = (capped.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  const bar = "`".repeat(Math.max(3, longest + 1));
  return `${bar}${info}\n${capped}\n${bar}`;
}

/** An opening fence line, read. */
export interface FenceOpen {
  /** "`" or "~". */
  char: "`" | "~";
  /** How long the opening run is; a closer must be at least this long. */
  length: number;
  /** The columns before the run (a tab to the next multiple of four), after any `>` markers. */
  indent: number;
  /** The info string, trimmed and otherwise as written: escapes and references are not
   * resolved, and its first word is the language by convention only. */
  info: string;
}

export interface FenceOptions {
  /**
   * The most columns of indent a fence line may have: CommonMark's 3 by default. 0 reads only a
   * fence at the start of the line; Infinity any indent at all, for a reader that would rather
   * take too much for code than too little.
   */
  maxIndent?: number;
  /** Read the line through any leading block-quote markers (`> > ```js`): see stripQuoteMarkers. */
  quoted?: boolean;
}

const OPEN = /^([ \t]*)(`{3,}|~{3,})([^\n]*)$/;
const CLOSE = /^([ \t]*)(`{3,}|~{3,})[ \t\r]*$/;

/** The columns `blanks` (spaces and tabs) take up, a tab reaching the next multiple of four. */
function columns(blanks: string): number {
  let at = 0;
  for (const ch of blanks) at = ch === "\t" ? at + 4 - (at % 4) : at + 1;
  return at;
}

/**
 * `line` with every leading block-quote marker taken off (`> > text` → ` text`), the blanks
 * before and between them included. What follows the last marker is left as written, so the
 * indent a fence reads afterwards counts the blank after a `>` — under maxIndent 3 that is still
 * a fence, as it is in CommonMark.
 */
function stripQuoteMarkers(line: string): string {
  return line.replace(/^(?:[ \t]*>)*/, "");
}

/** The fence `line` opens, or null when it opens none. */
export function fenceOpen(line: string, opts: FenceOptions = {}): FenceOpen | null {
  const m = OPEN.exec(opts.quoted ? stripQuoteMarkers(line) : line);
  if (m === null) return null;
  const indent = columns(m[1]!);
  if (indent > (opts.maxIndent ?? 3)) return null;
  const char = m[2]![0] as "`" | "~";
  // "```a```" is inline code, not a fence: a backtick fence's info string holds no backtick.
  if (char === "`" && m[3]!.includes("`")) return null;
  return { char, length: m[2]!.length, indent, info: m[3]!.trim() };
}

/**
 * Whether `line` closes `open`: a run of the same character at least as long, nothing after it
 * but blanks, behind no more indent than `opts.maxIndent` allows. Read through `>` markers with
 * `opts.quoted`, as the opener was.
 */
export function fenceCloses(open: FenceOpen, line: string, opts: FenceOptions = {}): boolean {
  const m = CLOSE.exec(opts.quoted ? stripQuoteMarkers(line) : line);
  return m !== null &&
    columns(m[1]!) <= (opts.maxIndent ?? 3) &&
    m[2]![0] === open.char &&
    m[2]!.length >= open.length;
}

/**
 * The code of `markdown` as sorted, disjoint `[start, end)` ranges: fenced blocks (``` or ~~~,
 * at any indent, inside a blockquote too, open to the end when never closed) and backtick code
 * spans (a run of n backticks to the next run of exactly n in the same paragraph; a run with
 * none is text). What GitHub and GitLab both render as text, so something spelled there is an
 * example somebody quoted. Not the rest of CommonMark — indented code, HTML comments, a backtick
 * inside a raw tag's attribute — and generous with indent on purpose: it errs towards code.
 * Linear: every line is looked at once, and each run's closer is found by a pointer per run
 * length that only moves forward.
 */
export function codeRanges(markdown: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const opts: FenceOptions = { quoted: true, maxIndent: Infinity };
  let open: { fence: FenceOpen; start: number } | null = null;
  let paragraph = -1;
  const spans = (from: number, to: number) => {
    const runs: Array<{ at: number; length: number; escaped: boolean }> = [];
    for (let i = from; i < to; i++) {
      if (markdown[i] !== "`") continue;
      let j = i;
      while (j < to && markdown[j] === "`") j++;
      let slashes = 0;
      while (i - slashes - 1 >= from && markdown[i - slashes - 1] === "\\") slashes++;
      runs.push({ at: i, length: j - i, escaped: slashes % 2 === 1 });
      i = j - 1;
    }
    const byLength = new Map<number, number[]>();
    runs.forEach((run, k) => {
      const list = byLength.get(run.length);
      if (list) list.push(k);
      else byLength.set(run.length, [k]);
    });
    const pointer = new Map<number, number>();
    for (let k = 0; k < runs.length;) {
      // An escaped first backtick is text: the rest of the run is the opener.
      const length = runs[k]!.length - (runs[k]!.escaped ? 1 : 0);
      const list = length > 0 ? byLength.get(length) : undefined;
      let at = pointer.get(length) ?? 0;
      while (list !== undefined && at < list.length && list[at]! <= k) at++;
      pointer.set(length, at);
      if (list === undefined || at >= list.length) {
        k++;
        continue;
      }
      const closer = runs[list[at]!]!;
      ranges.push([runs[k]!.at, closer.at + closer.length]);
      k = list[at]! + 1;
    }
  };
  for (let start = 0; start <= markdown.length;) {
    const newline = markdown.indexOf("\n", start);
    const end = newline === -1 ? markdown.length : newline;
    const line = markdown.slice(start, end);
    if (open !== null) {
      if (fenceCloses(open.fence, line, opts)) {
        ranges.push([open.start, end]);
        open = null;
      }
    } else {
      const fence = fenceOpen(line, opts);
      if (fence !== null || line.trim() === "") {
        if (paragraph !== -1) spans(paragraph, start);
        paragraph = -1;
      } else if (paragraph === -1) paragraph = start;
      if (fence !== null) open = { fence, start };
    }
    start = end + 1;
  }
  if (open !== null) ranges.push([open.start, markdown.length]);
  if (paragraph !== -1) spans(paragraph, markdown.length);
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** Whether `p` falls in one of `ranges` (sorted by start, disjoint): a binary search for the
 * last range starting at or before it. */
export function withinRanges(ranges: ReadonlyArray<readonly [number, number]>, p: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid]![0] <= p) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi >= 0 && p < ranges[hi]![1];
}

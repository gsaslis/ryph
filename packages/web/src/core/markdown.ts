// A web page as markdown a model can read: the article, not the chrome.
//
// Three libraries, in the order a browser's reader mode uses them:
// 1. linkedom parses the HTML into a DOM. Chosen over jsdom because it is plain JavaScript with
//    no native addon — this package has to compile into the single `ryph` binary.
// 2. @mozilla/readability finds the main content and drops navigation, sidebars and footers. It
//    is the same extractor Firefox ships, so what it keeps is what a person reading the page
//    would keep.
// 3. turndown, with the GFM plugin, turns that subtree into markdown — pipe tables, fenced code.
//
// When readability finds nothing usable (a docs page that is one big <main>, a wiki, an app
// shell) the fallback is the body with the chrome elements removed by name. Refusing there would
// be worse than an imperfect page: the agent asked to read something, and "no article" is not an
// answer it can act on.
//
// Everything here is PURE: a string in, a string out. No fetching, no DOM globals, no state —
// which is what lets the whole conversion be tested against fixture HTML.

import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
// @ts-expect-error: turndown ships no declaration file.
import TurndownService from "turndown";
// @ts-expect-error: nor does its GFM plugin.
import { gfm } from "turndown-plugin-gfm";

/**
 * The document type readability declares, taken from its own constructor: linkedom's `parseHTML`
 * answers a window-like object whose `document` its types do not name, and neither side's types
 * can see the other's. One cast, at this one boundary, named rather than sprinkled.
 */
type ReadableDocument = ConstructorParameters<typeof Readability>[0];

/** Chrome dropped by name when readability declines. Order does not matter; all are removed. */
const CHROME = ["script", "style", "noscript", "iframe", "nav", "header", "footer", "aside"];

/** Under this many characters, readability "found" a menu, not an article. */
const MIN_ARTICLE_CHARS = 200;

export interface ConvertedPage {
  /** The page's title: readability's, else <title>, else null. */
  title: string | null;
  /** The markdown. Empty when the page really has no text. */
  markdown: string;
  /** Which path produced it, for the service's debug log — never shown to the agent. "text" is
   * the plain-text conversion (core/text.ts), whose `markdown` is that text. */
  via: "readability" | "body" | "text";
}

/** HTML → markdown. `baseUrl` resolves relative links so a cited link is one the agent can fetch. */
export function htmlToMarkdown(html: string, baseUrl: string): ConvertedPage {
  const { document } = parseHTML(html) as unknown as { document: ReadableDocument };
  // Readability rewrites every relative href against the DOCUMENT's base, not against anything
  // we pass it — and a document parsed from a string has no base, so it falls back to the
  // environment's `location`. Inside a web Worker that is the module's file: URL in the
  // deployment, and every link in the answer then pointed at a path on our own disk. So the
  // page's base is stated explicitly, before the extractor runs, whatever runs the conversion.
  setBase(document, baseUrl);
  const documentTitle = textOf(document, "title");
  // Readability MUTATES the document it is given, so the fallback below cannot reuse this one and
  // parses the HTML again. That second parse is paid ONLY when the extractor declines, which is
  // the uncommon path — the common one parses a page once.
  let article: { title?: string | null; content?: string | null } | null = null;
  try {
    // keepClasses, because a highlighter's `language-ts` on a <pre> is the difference between
    // a fenced block an agent can read as TypeScript and one it has to guess at.
    article = new Readability(document, {
      charThreshold: MIN_ARTICLE_CHARS,
      keepClasses: true,
    }).parse();
  } catch {
    // A malformed page readability throws on is a fallback, not a failure.
    article = null;
  }
  const extracted = article?.content ?? "";
  if (extracted.trim() !== "") {
    const markdown = toMarkdown(extracted, baseUrl);
    if (markdown.length >= MIN_ARTICLE_CHARS) {
      return { title: article?.title?.trim() || documentTitle, markdown, via: "readability" };
    }
  }
  return { title: documentTitle, markdown: toMarkdown(strippedBody(html), baseUrl), via: "body" };
}

/** The body with the chrome removed, as HTML — the fallback's input. */
function strippedBody(html: string): string {
  const { document } = parseHTML(html) as unknown as {
    document: {
      querySelectorAll(sel: string): Array<{ remove(): void }>;
      body: { innerHTML: string } | null;
      documentElement: { innerHTML: string } | null;
    };
  };
  for (const selector of CHROME) {
    for (const node of document.querySelectorAll(selector)) node.remove();
  }
  // A page that is a bare fragment (no <html>, no <body>) parses with its content OUTSIDE the
  // body linkedom synthesised, so an empty body is a reason to look one level up rather than an
  // answer.
  const body = document.body?.innerHTML ?? "";
  return body.trim() !== "" ? body : document.documentElement?.innerHTML ?? "";
}

/**
 * Puts the page's own base into the parsed document: its `<base href>` resolved against the page
 * URL when it declares one (a browser does exactly that), the page URL otherwise. Inserted as the
 * head's first child, which is where `baseURI` reads it from.
 */
function setBase(document: unknown, baseUrl: string): void {
  const doc = document as {
    querySelector(selector: string): { getAttribute(name: string): string | null } | null;
    createElement(tag: string): { setAttribute(name: string, value: string): void };
    head: { insertBefore(node: unknown, child: unknown): void; firstChild: unknown } | null;
  };
  try {
    const declared = doc.querySelector("base")?.getAttribute("href") ?? null;
    const effective = declared === null ? baseUrl : new URL(declared, baseUrl).href;
    const base = doc.createElement("base");
    base.setAttribute("href", effective);
    doc.head?.insertBefore(base, doc.head.firstChild);
  } catch {
    // A page with no head, or a base nobody can parse: the links stay relative and the rule in
    // toMarkdown resolves them instead. Never a reason to fail the page.
  }
}

function textOf(document: unknown, selector: string): string | null {
  const doc = document as { querySelector(sel: string): { textContent?: string | null } | null };
  const text = doc.querySelector(selector)?.textContent ?? null;
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** A fenced block's language, from the class a highlighter left on the `pre` or its `code`. */
function languageOf(node: { className?: string; firstChild?: { className?: string } }): string {
  const classes = `${node.className ?? ""} ${node.firstChild?.className ?? ""}`;
  const match = classes.match(/(?:language|lang|highlight-source)-(\S+)/);
  return match ? match[1].replace(/[^A-Za-z0-9+#._-]/g, "") : "";
}

function toMarkdown(html: string, baseUrl: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    hr: "---",
  });
  turndown.use(gfm);
  // Turndown's own fenced-code rule reads `language-x` off the `code` element only, and drops
  // every other convention. This one reads both elements and keeps the language, which is the
  // difference between an agent seeing a shell command and seeing a shell command it can tell is
  // one.
  turndown.addRule("fenced-code", {
    filter: (node: { nodeName: string; firstChild?: { nodeName: string } | null }) =>
      node.nodeName === "PRE",
    replacement: (_content: string, node: { textContent?: string | null }) => {
      const code = (node.textContent ?? "").replace(/\n+$/, "");
      const language = languageOf(node as { className?: string });
      const bar = "`".repeat(Math.max(3, longestBacktickRun(code) + 1));
      return `\n\n${bar}${language}\n${code}\n${bar}\n\n`;
    },
  });
  // Relative links and images become absolute, so every URL in the answer is one web__fetch can
  // be called with. A base the page itself makes unparseable is left alone rather than guessed at.
  turndown.addRule("absolute-links", {
    filter: (
      node: { nodeName: string; getAttribute(name: string): string | null },
    ) => (node.nodeName === "A" && node.getAttribute("href") !== null),
    replacement: (
      content: string,
      node: { getAttribute(name: string): string | null },
    ) => {
      const href = absolute(node.getAttribute("href") ?? "", baseUrl);
      const text = content.trim();
      if (text === "") return "";
      return href === null ? text : `[${text}](${href})`;
    },
  });
  return collapse(turndown.turndown(html));
}

function absolute(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

function longestBacktickRun(text: string): number {
  return (text.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
}

/** Three or more blank lines are one; trailing whitespace on a line is nothing. */
function collapse(markdown: string): string {
  return markdown.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

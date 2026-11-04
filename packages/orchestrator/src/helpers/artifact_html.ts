// An artifact's document as the content route will serve it, made ONCE, at publish, by the
// browser's own parsing algorithm (parse5 implements the WHATWG tree builder): parsed as a
// browser with scripting on parses it, the tags that steer or beacon taken out of the TREE,
// every image ref where an image URL goes swapped for a token the content route later fills
// with the image, the preamble put first in <head>, and the tree serialized by the spec's own
// serialization algorithm.
//
// Why a tree and not a scan: two review rounds found a hand-rolled start-tag scanner and its
// backstop reading documents differently from a browser (foreign content, misnested tables,
// script escapes), quadratic on crafted input, and refusing harmless text that merely looked like
// a tag. Here a `<meta` inside a script string is text because the parser says so, and the
// serializer escapes text, so nothing harmless is refused and nothing hidden survives.
//
// Invariants:
// - what is served is a FIXPOINT: re-parsing it with parse5 and sanitizing again changes
//   nothing. Serialization is not always round-trip safe (text in an SVG <style> or <script> is
//   written raw, and can end the element early: mutation XSS), so the sanitize-serialize step
//   repeats until the string stops changing, and a document that does not settle within
//   MAX_PASSES is refused rather than served. parse5 implements the same standard as a browser
//   but does not build the same tree in every case (it and Chrome differ in rare <template>
//   inside table cases), so the tree a browser builds is not promised to be this one: what is
//   relied on is the fixpoint, the serializer escaping text and attribute values, and above all
//   the CSP sandbox the content route serves under
// - the preamble (`ARTIFACT_HANDSHAKE` and `<base target="_blank">`) is the first two children of
//   <head>, checked on a re-parse of the final string: nothing of the author's runs before it
// - an image token is `ryph-img:<ref>`, and a data URI that replaces one holds only
//   [A-Za-z0-9+/=:;,], none of which any tokenizer state treats specially, so filling tokens at
//   serve cannot change how the document parses
// - pure and synchronous: it is run in a child process that is killed at its deadline and whose
//   heap is capped (adapters/artifact_html/), never in the control plane. The bounds below keep
//   real pages well inside those limits and answer crafted ones in an orderly way; the process
//   is what holds when one of them is missed

import {
  defaultTreeAdapter,
  type DefaultTreeAdapterMap,
  html as HTML,
  Parser,
  serialize,
  serializeOuter,
  type Token,
} from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];
type Element = DefaultTreeAdapterMap["element"];
type Template = DefaultTreeAdapterMap["template"];
type TextNode = DefaultTreeAdapterMap["textNode"];
type Doc = DefaultTreeAdapterMap["document"];

/**
 * The first thing the served document runs, before any markup of the author's can: it takes
 * the nonce the app put in the frame's `name`, clears `window.name` so nothing loaded after it
 * (the author's script, or a page the frame is sent to) can read it, and once the document has
 * really loaded posts `{ type: "ryph-artifact-loaded", nonce }` to the parent. The app accepts a
 * document only on that message: a frame that navigates away
 * loads a page that does not know the nonce. A synthetic `load` the author dispatches is not
 * trusted and is ignored; the listener is a capturing one registered first, so it runs before
 * any the author adds. On `pagehide` it posts `ryph-artifact-leaving` with the nonce: a hint
 * only, since a document that replaces itself with `document.open()` erases the listener first,
 * so the app never relies on it to see a navigation.
 */
export const ARTIFACT_HANDSHAKE = '<script>(()=>{const n=window.name;window.name="";' +
  'const p=parent;let s=0;addEventListener("load",e=>{if(s||!e.isTrusted)return;s=1;' +
  'try{p.postMessage({type:"ryph-artifact-loaded",nonce:n},"*")}catch{}},true);' +
  'addEventListener("pagehide",e=>{if(!e.isTrusted)return;' +
  'try{p.postMessage({type:"ryph-artifact-leaving",nonce:n},"*")}catch{}},true);})();</script>';

/** The marker the content route injects: links without a target open a new tab. */
export const INJECTED_BASE = '<base target="_blank">';

/** What goes first in <head>, in this order. */
export const ARTIFACT_PREAMBLE = ARTIFACT_HANDSHAKE + INJECTED_BASE;

/** The prefix a served document's image tokens carry: `ryph-img:img-0123456789ab`. */
export const IMAGE_TOKEN_PREFIX = "ryph-img:";

/** Every image token in a served document, for the content route to fill. */
export const IMAGE_TOKEN = /ryph-img:(img-[0-9a-f]{12})/g;

/** How many sanitize-serialize rounds a document gets to settle in. An ordinary document
 * settles in one (the second only confirms it); a crafted mutation-XSS one in two or three. */
export const MAX_PASSES = 4;

/** `<link rel>` values kept. Every other one is taken out: preconnect, dns-prefetch, prefetch,
 * prerender, preload and modulepreload reach a host whatever the policy says. */
export const KEPT_LINK_RELS: ReadonlySet<string> = new Set([
  "stylesheet",
  "icon",
  "shortcut",
  "apple-touch-icon",
  "alternate",
]);

/** A ref, bare or already a token (a served document re-read: the same site). */
const REF_VALUE = /^(?:ryph-img:)?(img-[0-9a-f]{12})$/;
/** A CSS `url(img-…)`, quoted or not, bare or already a token. */
const CSS_REF = /([uU][rR][lL]\(\s*(["']?))(?:ryph-img:)?(img-[0-9a-f]{12})(\2\s*\))/g;
/** A srcset candidate's URL that is a ref: at the start or after a comma. */
const SRCSET_REF = /(^|,)(\s*)(?:ryph-img:)?(img-[0-9a-f]{12})(?=\s|,|$)/g;
/** Whether a UTF-16 code unit is HTML's ASCII whitespace: tab, LF, FF, CR, space. */
const isAsciiSpace = (c: number) =>
  c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;

/** `value` without HTML's whitespace at either end, as a URL attribute's value is stripped. By
 * index, not a regex: `/^\s+|\s+$/g` retries its second branch from every interior space, so a
 * value of N spaces between two letters cost N² (240k of them, 30 s). */
function trimAsciiSpace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isAsciiSpace(value.charCodeAt(start))) start++;
  while (end > start && isAsciiSpace(value.charCodeAt(end - 1))) end--;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

export type PreparedHtml =
  | {
    kind: "ok";
    /** The document to serve, its image refs as tokens. */
    served: string;
    /** Every distinct ref named where an image URL goes, in document order. */
    refs: string[];
  }
  /** It would not settle into a document that re-parses to itself (see the invariants). */
  | { kind: "unsettled" }
  /** Its tree nests deeper than the serializer can walk. */
  | { kind: "too_deep" }
  /** The deadline passed first. */
  | { kind: "too_complex" }
  /** A tag or an element carries more than MAX_TAG_ATTRIBUTES attributes. */
  | { kind: "too_many_attributes" }
  /** One parse of it builds more than MAX_TREE_NODES nodes. */
  | { kind: "too_many_nodes" }
  /** Written back, it is longer than MAX_SERIALIZED_LENGTH. */
  | { kind: "too_large" };

/** The attribute's value, by name (no namespace), if present. */
function attr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name && a.prefix === undefined)?.value;
}

/** HTML's keyword reading of an attribute: whitespace-trimmed, ASCII-lowercased. */
const keyword = (value: string) => trimAsciiSpace(value).toLowerCase();

/**
 * Whether the served document leaves an element out, with everything in it: every `<base>`;
 * every `<meta>` with `http-equiv` (refresh, a CSP, cookies) or naming the referrer policy (it
 * would override the response's no-referrer); a `<link>` whose `rel` holds anything outside
 * KEPT_LINK_RELS; `<script type=speculationrules>`; and every `<noscript>`, whose markup comes
 * alive in a frame that runs no script, as the app's previews are. By tag name in ANY namespace:
 * in SVG or MathML these names do nothing, so taking them out costs nothing, and it keeps the
 * rule independent of how a re-parse assigns namespaces.
 */
export function removedElement(el: Element): boolean {
  switch (el.tagName.toLowerCase()) {
    case "base":
    case "noscript":
      return true;
    case "meta": {
      if (attr(el, "http-equiv") !== undefined) return true;
      const name = attr(el, "name");
      return name !== undefined && keyword(name) === "referrer";
    }
    case "link": {
      const rel = attr(el, "rel");
      if (rel === undefined) return false;
      return keyword(rel).split(/[\t\n\f\r ]+/).some((t) => t !== "" && !KEPT_LINK_RELS.has(t));
    }
    case "script": {
      const type = attr(el, "type");
      return type !== undefined && keyword(type) === "speculationrules";
    }
    default:
      return false;
  }
}

const isElement = (node: Node): node is Element => "tagName" in node;

/** CSS text with every `url(ref)` made a token, and the refs it named. */
function tokenizeCss(css: string, found: (ref: string) => void): string {
  if (!css.includes("img-")) return css;
  return css.replace(CSS_REF, (_m, open: string, _q: string, ref: string, close: string) => {
    found(ref);
    return `${open}${IMAGE_TOKEN_PREFIX}${ref}${close}`;
  });
}

/**
 * Takes the removed elements out of the tree and makes every image ref where an image URL goes
 * a token: `src`, `poster`, each `srcset` candidate, `href` on SVG's `<image>`, and CSS `url()`
 * in a `style` attribute or a `<style>` element's text. Iterative, so a deep tree cannot
 * overflow the stack. Answers the refs in document order and how many elements went.
 *
 * It reads the clock per element and per attribute, as the parse does per token: a tree of
 * MAX_TREE_NODES nodes is walked in well under the budget, but nothing here may run unwatched.
 * A formatting element the parser re-opens shares its attribute list with every copy, so a list
 * is rewritten once (`done`), however many elements hold it: one `<b srcset>` of a megabyte of
 * commas re-opened in 8,000 paragraphs otherwise rewrote that megabyte 8,000 times (23 s).
 */
function sanitizeTree(doc: ParentNode): { refs: string[]; removed: number } {
  const refs: string[] = [];
  const seen = new Set<string>();
  const done = new WeakSet<Element["attrs"]>();
  const found = (ref: string) => {
    if (!seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  };
  let removed = 0;
  const stack: ParentNode[] = [doc];
  while (stack.length > 0) {
    const node = stack.pop()!;
    tick();
    if (isElement(node)) {
      // `<plaintext>` swallows the rest of the document, its end tag included, so it cannot be
      // written back and read the same: it becomes the `<pre>` it renders as.
      if (node.tagName === "plaintext" && node.namespaceURI === HTML.NS.HTML) {
        node.tagName = node.nodeName = "pre";
      }
      const image = node.tagName === "image";
      const attrs = done.has(node.attrs) ? [] : node.attrs;
      done.add(node.attrs);
      for (const a of attrs) {
        tick();
        const name = a.prefix === "xlink" ? `xlink:${a.name}` : a.name;
        if (
          name === "src" || name === "poster" ||
          (image && (name === "href" || name === "xlink:href"))
        ) {
          const match = REF_VALUE.exec(trimAsciiSpace(a.value));
          if (match !== null) {
            found(match[1]);
            a.value = IMAGE_TOKEN_PREFIX + match[1];
          }
        } else if (name === "srcset" && a.value.includes("img-")) {
          a.value = a.value.replace(SRCSET_REF, (_m, lead: string, space: string, ref: string) => {
            found(ref);
            return `${lead}${space}${IMAGE_TOKEN_PREFIX}${ref}`;
          });
        } else if (name === "style") {
          a.value = tokenizeCss(a.value, found);
        }
      }
      if (node.tagName.toLowerCase() === "style") {
        for (const child of node.childNodes) {
          if (child.nodeName === "#text") {
            const text = child as TextNode;
            text.value = tokenizeCss(text.value, found);
          }
        }
      }
    }
    const kept = node.childNodes.filter((child) => {
      if (isElement(child) && removedElement(child)) {
        removed++;
        return false;
      }
      return true;
    });
    if (kept.length !== node.childNodes.length) node.childNodes = kept;
    // Reversed, so the first child is walked next: refs come out in document order.
    for (let i = kept.length - 1; i >= 0; i--) {
      const child = kept[i];
      if (isElement(child)) {
        // Only an HTML <template> has content; one in SVG or MathML is an ordinary element.
        const content = (child as Partial<Template>).content;
        if (content !== undefined) stack.push(content);
        stack.push(child);
      }
    }
  }
  return { refs, removed };
}

/** The most attributes one tag, or one element, may carry. parse5's tokenizer looks each new
 * attribute up among the tag's earlier ones (a duplicate is dropped), so one tag with N
 * attributes costs N² before the tree builder sees it: 400k distinct attributes ran for minutes.
 * And every stray `<html>` or `<body>` tag adds its attributes to the one element, each time
 * against all it has: 256 apiece on 2 MiB of them ran for 15 s. Real pages carry a handful. */
export const MAX_TAG_ATTRIBUTES = 256;

/** The most nodes one parse may build: elements, text nodes and comments, and every attribute an
 * element is made with, each counted once. The bound on the tree's memory, which the input cap
 * is not: the parser re-opens every formatting element still open (`<b>`, `<i>`, …) in each
 * block that follows, with its attributes, so a 14.6 KB document of 1,000 `<div>`s and 300
 * distinct `<b a=…>` builds 300,000 elements (over 600 MB of RSS measured, unbounded by the
 * time budget). With it, every document of the reviews' corpus fits a 128 MiB heap, and none
 * took the sanitizer process past 272 MB peak RSS (docs/artifacts.md). Real pages stay under it:
 * the skill's template builds 428 nodes, a 1.8 MiB page of Chart.js, D3 and an 18,000-row table
 * 164,028, and 2 MiB of nothing but table rows 225,782. */
export const MAX_TREE_NODES = 250_000;

/** The longest a serialization may get, in UTF-16 code units: the served cap
 * (MAX_ARTIFACT_SERVED_BYTES, UTF-8 bytes, which are never fewer), checked as it is written so a
 * tree under MAX_TREE_NODES whose formatting elements repeat a long attribute cannot write a
 * string of hundreds of megabytes first. */
export const MAX_SERIALIZED_LENGTH = 4 * 1024 * 1024;

/** Thrown out of the parse when the deadline passes. */
class OverBudget extends Error {}

/** Thrown out of the parse at a tag's or an element's MAX_TAG_ATTRIBUTES + 1st attribute. */
class TooManyAttributes extends Error {}

/** Thrown out of the parse at its MAX_TREE_NODES + 1st node. */
class TooManyNodes extends Error {}

/** Thrown out of a serialization once it is certain to pass MAX_SERIALIZED_LENGTH. */
class TooLarge extends Error {}

/** When the current parse must stop (performance.now() time); Infinity: never. */
let deadlineAt = Infinity;
let tokens = 0;
/** How many nodes the current parse has built. */
let nodes = 0;
function built(n: number): void {
  nodes += n;
  if (nodes > MAX_TREE_NODES) throw new TooManyNodes();
}
/** Every 64 tokens or attributes, the clock. A token's own work is at most linear in the
 * open-element stack and the list of active formatting elements, and an attribute's in the
 * attributes before it on its tag (at most MAX_TAG_ATTRIBUTES), so this bounds how far past the
 * deadline a parse runs to a few milliseconds even on crafted input. */
function tick(): void {
  if ((++tokens & 63) === 0 && performance.now() > deadlineAt) throw new OverBudget();
}

/** The tokenizer's own per-attribute step and its state, which parse5 does not expose. */
interface TokenizerSteps {
  _leaveAttrName(): void;
  currentToken: Record<string, unknown> & { attrs?: unknown[] } | null;
  currentAttr: { name: string; value: string };
  currentCharacterToken: { chars: string } | null;
}

/** Every how many steps the strings being built are flattened. */
const FLATTEN_EVERY = 0xffff;

/** Makes `s` one flat string in place: V8 flattens a string built by `+=` (a chain of one
 * object per piece, about 32 bytes each) when a character of it is read. parse5 builds text,
 * comments, names and values one character at a time, so 2 MiB of script or of a comment would
 * otherwise be held as a 64 MB chain. Done every FLATTEN_EVERY steps, so a string is copied at
 * most once per that many characters it gains. */
function flatten(s: unknown): void {
  // A string under 13 characters is always flat. The character read goes somewhere, so the
  // optimizing compiler cannot drop the read.
  if (typeof s === "string" && s.length > 12) flattened ^= s.charCodeAt(0);
}
let flattened = 0;
/** How many growing steps the tokenizer has taken. */
let grown = 0;

/** The tokenizer's steps that append a character to a string under construction: text, a tag's
 * or an attribute's name, an attribute's value, a comment, a doctype's parts. */
const GROWING_STEPS = [
  "_appendCharToCurrentCharacterToken",
  "_stateTagName",
  "_stateAttributeName",
  "_stateAttributeValueDoubleQuoted",
  "_stateAttributeValueSingleQuoted",
  "_stateAttributeValueUnquoted",
  "_flushCodePointConsumedAsCharacterReference",
  "_stateBogusComment",
  "_stateComment",
  "_stateCommentLessThanSign",
  "_stateCommentEnd",
  "_stateCommentEndBang",
  "_stateDoctypeName",
  "_stateDoctypePublicIdentifierDoubleQuoted",
  "_stateDoctypePublicIdentifierSingleQuoted",
  "_stateDoctypeSystemIdentifierDoubleQuoted",
  "_stateDoctypeSystemIdentifierSingleQuoted",
];

/** The strings the tokenizer is building, flattened. */
function flattenTokenizer(t: TokenizerSteps): void {
  const token = t.currentToken;
  if (token !== null) {
    flatten(token.data);
    flatten(token.tagName);
    flatten(token.name);
    flatten(token.publicId);
    flatten(token.systemId);
  }
  flatten(t.currentAttr.name);
  flatten(t.currentAttr.value);
  flatten(t.currentCharacterToken?.chars);
}

/**
 * parse5's parser with a clock in its token handlers and in its tokenizer's attribute step, so a
 * crafted document is answered `too_complex` at the budget, before the process that runs it is
 * killed (adapters/artifact_html/process_preparer.ts, which is the bound that holds whatever
 * path the clock misses). The budget is read from INSIDE the parse:
 * in the tree builder, where some steps are linear in the depth of the open-element stack, and
 * in the tokenizer, where a tag's attributes are checked against each other before the tree
 * builder hears of the tag at all. The attribute step also holds a tag to MAX_TAG_ATTRIBUTES,
 * as `budgetedTreeAdapter` holds an element that adopts attributes. And the strings the
 * tokenizer builds a character at a time are flattened as they grow and as they are handed on
 * (`flatten`), which bounds what a long text, comment or attribute costs to about its length.
 */
class BudgetedParser extends Parser<DefaultTreeAdapterMap> {
  constructor(...args: ConstructorParameters<typeof Parser<DefaultTreeAdapterMap>>) {
    super(...args);
    const tokenizer = this.tokenizer as unknown as TokenizerSteps;
    const leave = tokenizer._leaveAttrName;
    tokenizer._leaveAttrName = function (this: TokenizerSteps) {
      tick();
      leave.call(this);
      if ((this.currentToken?.attrs?.length ?? 0) > MAX_TAG_ATTRIBUTES) {
        throw new TooManyAttributes();
      }
    };
    // The steps that grow a string by a character, counted and flattened (see `flatten`).
    // Wrapping every code point's step (`_callState`) instead was measured to cost more memory
    // than it saved.
    // Two fixed arguments (none takes more), so a step allocates nothing per character.
    const steps = tokenizer as unknown as Record<string, (a: unknown, b: unknown) => void>;
    for (const name of GROWING_STEPS) {
      const grow = steps[name];
      // A parse5 that renamed one fails every parse here, in the tests, not silently.
      if (typeof grow !== "function") throw new Error(`parse5's tokenizer has no ${name}`);
      steps[name] = function (this: TokenizerSteps, a: unknown, b: unknown) {
        grow.call(this, a, b);
        if ((++grown & FLATTEN_EVERY) === 0) flattenTokenizer(this);
      };
    }
  }
  // Every string a token hands the tree is flattened as it arrives: one built a character at a
  // time is otherwise a chain the tree keeps (a 25-character attribute value is a dozen objects).
  override onStartTag(token: Token.TagToken): void {
    tick();
    flatten(token.tagName);
    for (const a of token.attrs) {
      flatten(a.name);
      flatten(a.value);
    }
    super.onStartTag(token);
  }
  override onEndTag(token: Token.TagToken): void {
    tick();
    super.onEndTag(token);
  }
  override onCharacter(token: Token.CharacterToken): void {
    tick();
    flatten(token.chars);
    super.onCharacter(token);
  }
  override onWhitespaceCharacter(token: Token.CharacterToken): void {
    tick();
    flatten(token.chars);
    super.onWhitespaceCharacter(token);
  }
  override onNullCharacter(token: Token.CharacterToken): void {
    tick();
    super.onNullCharacter(token);
  }
  override onComment(token: Token.CommentToken): void {
    tick();
    flatten(token.data);
    super.onComment(token);
  }
}

/** Whether inserting text at the end of `parent` makes a node rather than extending one. */
const newTextNode = (parent: ParentNode, before?: DefaultTreeAdapterMap["childNode"]) => {
  const at = before === undefined ? parent.childNodes.length : parent.childNodes.indexOf(before);
  const prev = parent.childNodes[at - 1];
  return prev === undefined || prev.nodeName !== "#text";
};

/** The default tree, but every node it builds is counted against MAX_TREE_NODES (an element's
 * attributes with it: a reconstructed formatting element shares its token's attribute list here,
 * but is written out, and re-parsed, with its own), and an element that adopts a stray
 * `<html>`'s or `<body>`'s attributes is held to MAX_TAG_ATTRIBUTES too, and each adoption looks
 * at the clock. */
const budgetedTreeAdapter: typeof defaultTreeAdapter = {
  ...defaultTreeAdapter,
  createElement(tagName, namespaceURI, attrs) {
    built(1 + attrs.length);
    return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
  },
  createCommentNode(data) {
    built(1);
    return defaultTreeAdapter.createCommentNode(data);
  },
  createDocumentFragment() {
    built(1);
    return defaultTreeAdapter.createDocumentFragment();
  },
  // Adjacent text tokens are joined with `+=` too.
  insertText(parent, text) {
    if (newTextNode(parent)) built(1);
    defaultTreeAdapter.insertText(parent, text);
    if ((++grown & FLATTEN_EVERY) === 0) flatten((parent.childNodes.at(-1) as TextNode).value);
  },
  insertTextBefore(parent, text, before) {
    if (newTextNode(parent, before)) built(1);
    defaultTreeAdapter.insertTextBefore(parent, text, before);
    if ((++grown & FLATTEN_EVERY) === 0) {
      flatten((parent.childNodes[parent.childNodes.indexOf(before) - 1] as TextNode).value);
    }
  },
  adoptAttributes(recipient, attrs) {
    tick();
    const had = recipient.attrs.length;
    defaultTreeAdapter.adoptAttributes(recipient, attrs);
    if (recipient.attrs.length > MAX_TAG_ATTRIBUTES) throw new TooManyAttributes();
    built(recipient.attrs.length - had);
  },
};

const parseDocument = (html: string): Doc => {
  if (performance.now() > deadlineAt) throw new OverBudget();
  nodes = 0;
  return BudgetedParser.parse<DefaultTreeAdapterMap>(html, {
    scriptingEnabled: true,
    treeAdapter: budgetedTreeAdapter,
  });
};

/** How long the current serialization is certain to be already. */
let written = 0;
function wrote(n: number): void {
  written += n;
  if (written > MAX_SERIALIZED_LENGTH) throw new TooLarge();
}

/** Elements whose text the serializer writes raw, unescaped (parse5's `hasUnescapedText`, with
 * scripting on), in the HTML namespace. */
const RAW_TEXT = new Set([
  "style",
  "script",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
  "noscript",
]);

/** How long `value` is once escaped: text escapes `&`, `<`, `>` and U+00A0, an attribute value
 * `&`, `"` and U+00A0. */
function escapedLength(value: string, attribute: boolean): number {
  let n = value.length;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x26) n += 4; // &amp;
    else if (c === 0xa0) n += 5; // &nbsp;
    else if (attribute ? c === 0x22 : c === 0x3c || c === 0x3e) n += attribute ? 5 : 3;
  }
  return n;
}

/** The default tree read by the serializer, counting a lower bound on what it writes: every
 * element's start tag (`<` name `>`), every attribute's ` name=""` and escaped value, every
 * text's content as it is written (escaped unless its parent's is raw text), every comment. So
 * the count passes the cap only if the string would. */
const measuredTreeAdapter: typeof defaultTreeAdapter = {
  ...defaultTreeAdapter,
  getChildNodes(node) {
    const children = defaultTreeAdapter.getChildNodes(node);
    for (const child of children) {
      if (isElement(child)) wrote(child.tagName.length + 2);
    }
    return children;
  },
  getAttrList(el) {
    const attrs = defaultTreeAdapter.getAttrList(el);
    for (const a of attrs) wrote(a.name.length + escapedLength(a.value, true) + 4);
    return attrs;
  },
  getTextNodeContent(node) {
    const text = defaultTreeAdapter.getTextNodeContent(node);
    const parent = node.parentNode;
    const raw = parent !== null && isElement(parent) && parent.namespaceURI === HTML.NS.HTML &&
      RAW_TEXT.has(parent.tagName);
    wrote(raw ? text.length : escapedLength(text, false));
    return text;
  },
  getCommentNodeContent(node) {
    const text = defaultTreeAdapter.getCommentNodeContent(node);
    wrote(text.length + 7);
    return text;
  },
};

/** The document written back, refused once it certainly passes MAX_SERIALIZED_LENGTH. */
const serializeDocument = (doc: ParentNode): string => {
  written = 0;
  return serialize(doc, { treeAdapter: measuredTreeAdapter });
};

/** The <head> of a parsed document: always there, as the tree builder makes one. */
function headOf(doc: Doc): Element | null {
  const root = doc.childNodes.find((n): n is Element => isElement(n) && n.tagName === "html");
  return root?.childNodes.find((n): n is Element => isElement(n) && n.tagName === "head") ??
    null;
}

/** Puts the handshake and the base first in <head>. */
function insertPreamble(head: Element): void {
  const script = defaultTreeAdapter.createElement("script", HTML.NS.HTML, []);
  defaultTreeAdapter.insertText(
    script,
    ARTIFACT_HANDSHAKE.slice("<script>".length, -"</script>".length),
  );
  const base = defaultTreeAdapter.createElement("base", HTML.NS.HTML, [
    { name: "target", value: "_blank" },
  ]);
  for (const el of [base, script]) {
    el.parentNode = head;
    head.childNodes.unshift(el);
  }
}

/**
 * The served form of an author's document, made before `deadline` (a `performance.now()` time)
 * or not at all. Throws only on a bug; a document it cannot make safe is answered, not thrown.
 */
export function prepareArtifactHtml(html: string, deadline = Infinity): PreparedHtml {
  deadlineAt = deadline;
  tokens = 0;
  try {
    // A byte order mark is the decoder's, never the document's: a browser drops it before the
    // tokenizer sees anything, so the doctype after it still counts.
    // One tree is alive at a time: each is let go before the next parse begins.
    let doc: Doc | null = parseDocument(html.startsWith("\ufeff") ? html.slice(1) : html);
    const { refs } = sanitizeTree(doc);
    let out = serializeDocument(doc);
    doc = null;
    for (let pass = 1; pass < MAX_PASSES && doc === null; pass++) {
      const next = parseDocument(out);
      sanitizeTree(next);
      const again = serializeDocument(next);
      if (again === out) doc = next;
      else out = again;
    }
    if (doc === null) return { kind: "unsettled" };
    // `doc` is parse(out), which sanitizes to itself.
    const head = headOf(doc);
    if (head === null) return { kind: "unsettled" };
    insertPreamble(head);
    const served = serializeDocument(doc);
    doc = null;
    // The check on what the browser will build: the preamble is the first two children of
    // <head>, and without it the document is the settled one.
    const reread = parseDocument(served);
    const rereadHead = headOf(reread);
    const [first, second] = rereadHead?.childNodes ?? [];
    if (
      rereadHead === null || first === undefined || second === undefined ||
      serializeOuter(first) + serializeOuter(second) !== ARTIFACT_PREAMBLE
    ) {
      return { kind: "unsettled" };
    }
    rereadHead.childNodes.splice(0, 2);
    if (serializeDocument(reread) !== out) return { kind: "unsettled" };
    return { kind: "ok", served, refs };
  } catch (err) {
    if (err instanceof OverBudget) return { kind: "too_complex" };
    if (err instanceof TooManyAttributes) return { kind: "too_many_attributes" };
    if (err instanceof TooManyNodes) return { kind: "too_many_nodes" };
    if (err instanceof TooLarge) return { kind: "too_large" };
    // The serializer recurses once per level of nesting; the parser does not, so a document
    // can parse into a tree too deep to write back.
    if (err instanceof RangeError) return { kind: "too_deep" };
    throw err;
  } finally {
    deadlineAt = Infinity;
  }
}

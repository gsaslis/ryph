// The served document of an artifact (helpers/artifact_html.ts), made by the browser's own
// parsing algorithm: the preamble first in <head>; the tags that steer or beacon gone however
// they are hidden — every bypass the earlier scanner's reviews found, held here by re-parsing
// what is served (the differential check) rather than by reading the string; harmless text that
// merely looks like those tags kept as text; image refs made tokens only where an image URL
// goes; a crafted document refused as too deep, too slow or carrying too many attributes; and
// the child process that runs it, killed at its deadline, whose slot is held until it has exited.

import { test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "@ryph/process";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { type DefaultTreeAdapterMap, parse, serialize } from "parse5";
import {
  ARTIFACT_HANDSHAKE,
  ARTIFACT_PREAMBLE,
  INJECTED_BASE,
  MAX_TAG_ATTRIBUTES,
  MAX_TREE_NODES,
  prepareArtifactHtml,
  removedElement,
} from "../src/helpers/artifact_html.ts";
import {
  MAX_ARTIFACT_HTML_BYTES,
  MAX_ARTIFACT_INLINED_BYTES,
  servedDocument,
  tokenUses,
} from "../src/core/artifacts.ts";
import {
  processArtifactHtml,
  sanitizerCommand,
  sanitizerRuntime,
} from "../src/adapters/artifact_html/process_preparer.ts";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const REF_A = "img-0123456789ab";
const REF_B = "img-ba9876543210";
const A = "https://evil.test/";

/** `fn`'s result and the CPU milliseconds this process spent on it. A bound on work is a bound
 * on CPU: a check runs under a CPU quota (its share of the suite's pod) and is descheduled for
 * whole periods, so the wall clock there runs several times what the work took. */
function cpuTimed<T>(fn: () => T): { value: T; ms: number } {
  const before = process.cpuUsage();
  const value = fn();
  const { user, system } = process.cpuUsage(before);
  return { value, ms: (user + system) / 1000 };
}

function served(html: string): string {
  const out = prepareArtifactHtml(html);
  assert(out.kind === "ok", `${html} → ${out.kind}`);
  return out.served;
}

/** Every element of a tree, template contents included, without recursion. */
function elementsOf(root: Node): Element[] {
  const found: Element[] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if ("tagName" in node) found.push(node);
    if ("content" in node && node.content) stack.push(node.content as Node);
    if ("childNodes" in node) stack.push(...node.childNodes);
  }
  return found;
}

/**
 * The differential check: what a browser builds from the served string (parse5 is the same
 * algorithm) holds the preamble as the first two children of <head>, and no element the
 * sanitizer takes out anywhere else.
 */
function assertSafe(html: string): string {
  const out = served(html);
  const doc = parse(out, { scriptingEnabled: true });
  const head = elementsOf(doc).find((e) => e.tagName === "head")!;
  const [first, second] = head.childNodes as Element[];
  assertEquals(first.tagName, "script", out);
  assertEquals(serialize(first), ARTIFACT_HANDSHAKE.slice(8, -9));
  assertEquals([second.tagName, second.attrs], ["base", [{ name: "target", value: "_blank" }]]);
  const live = elementsOf(doc).filter((e) => e !== second && removedElement(e));
  assertEquals(live.map((e) => e.tagName), [], `${html}\n→ ${out}`);
  // And it is a fixpoint: served again, it serves the same.
  assertEquals(
    served(out.replace(ARTIFACT_PREAMBLE, "")),
    out,
    "the served form re-serves as itself",
  );
  return out;
}

// ---------------------------------------------------------------------------
// The preamble
// ---------------------------------------------------------------------------

test("served: the preamble is the first thing in <head>, after the author's doctype", () => {
  const P = ARTIFACT_PREAMBLE;
  assertEquals(
    served("<!doctype html><html><head><title>x</title></head><body></body></html>"),
    `<!DOCTYPE html><html><head>${P}<title>x</title></head><body></body></html>`,
  );
  // No doctype stays no doctype: the page keeps the rendering mode it was written in.
  assertEquals(served("<p>hi</p>"), `<html><head>${P}</head><body><p>hi</p></body></html>`);
  // Comments before the doctype stay before it; a doctype in a comment is not one.
  assertEquals(
    served("\ufeff<!-- made by ada -->\n<!DOCTYPE html><p>hi</p>"),
    `<!-- made by ada --><!DOCTYPE html><html><head>${P}</head><body><p>hi</p></body></html>`,
  );
  assertEquals(
    served("<!-- <!doctype html> --><p>hi</p>"),
    `<!-- <!doctype html> --><html><head>${P}</head><body><p>hi</p></body></html>`,
  );
  // A script before the doctype, or in the author's head, still runs after the handshake.
  const out = assertSafe("<script>a()</script><!doctype html><head><script>b()</script>");
  assert(out.indexOf(ARTIFACT_HANDSHAKE) < out.indexOf("a()"), out);
  assertEquals(
    out.indexOf(INJECTED_BASE),
    out.indexOf(ARTIFACT_HANDSHAKE) + ARTIFACT_HANDSHAKE.length,
  );
});

test("served: the handshake clears the frame's name first and posts it only on a trusted load", () => {
  const body = ARTIFACT_HANDSHAKE.slice("<script>".length, -"</script>".length);
  assert(body.startsWith('(()=>{const n=window.name;window.name="";'), body);
  assertStringIncludes(body, 'p.postMessage({type:"ryph-artifact-loaded",nonce:n},"*")');
  assertStringIncludes(body, "if(s||!e.isTrusted)return;");
  const posted: unknown[] = [];
  const listeners = new Map<string, (e: { isTrusted: boolean }) => void>();
  const win = {
    name: "nonce-1",
    parent: { postMessage: (m: unknown) => posted.push(m) },
    addEventListener: (type: string, f: (e: { isTrusted: boolean }) => void) =>
      listeners.set(type, f),
  };
  new Function("window", "parent", "addEventListener", body)(
    win,
    win.parent,
    win.addEventListener,
  );
  assertEquals(win.name, "");
  listeners.get("load")!({ isTrusted: false });
  assertEquals(posted, []);
  listeners.get("load")!({ isTrusted: true });
  listeners.get("load")!({ isTrusted: true });
  assertEquals(posted, [{ type: "ryph-artifact-loaded", nonce: "nonce-1" }]);
});

// ---------------------------------------------------------------------------
// What is taken out, however it is hidden
// ---------------------------------------------------------------------------

test("served: the author's <base>, steering <meta>, hint <link>s, speculation rules and <noscript> go; the rest stays", () => {
  const out = assertSafe(
    '<html><head><base href="https://evil.test/" target="_top"><BASE target=_self>' +
      '<meta http-equiv="Refresh" content="0;url=https://evil.test/">' +
      "<meta http-equiv='Content-Security-Policy' content=\"default-src *\">" +
      '<meta http-equiv="X-UA-Compatible" content="IE=edge">' +
      '<meta name="referrer" content="unsafe-url">' +
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">' +
      '<link rel="icon" href="data:,">' +
      '<script type=speculationrules>{"prefetch":[{"urls":["https://evil.test/"]}]}</script>' +
      "<script>go()</script></head><body><noscript><p>no js</p></noscript>" +
      '<a href="#top" target="_self">top</a></body></html>',
  );
  assertEquals(
    out,
    `<html><head>${ARTIFACT_PREAMBLE}` +
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">' +
      '<link rel="icon" href="data:,"><script>go()</script></head><body>' +
      '<a href="#top" target="_self">top</a></body></html>',
  );
});

test("served: every bypass the scanner's reviews found re-parses with nothing live", () => {
  for (
    const html of [
      // Character references in the value: the parser decodes them before the rule reads them.
      `<meta http-equiv="re&#102;resh" content="0;url=${A}">`,
      `<meta http-equiv="&Rfr;efresh" content="0;url=${A}">`,
      `<meta http-equiv="Content-Security-Polic&#121;" content="script-src 'none'">`,
      `<meta name="re&#x66;errer" content="unsafe-url">`,
      `<meta/http-equiv=refresh content="0;url=${A}">`,
      `<link rel="pre&#102;etch" href="${A}"><link rel="&Pfr;refetch" href="${A}">`,
      `<link rel=preconnect href="${A}"><link rel="dns-prefetch" href="//x.test">`,
      `<link rel="prefetch" href="${A}"><link rel=PRERENDER href="${A}">`,
      `<link rel="preload" as=image href="${A}"><link rel=modulepreload href="${A}">`,
      `<link rel="stylesheet preload" href="${A}">`,
      `<script type=" SpeculationRules ">{}</script>`,
      // SVG and MathML: style, title, noscript and iframe there are markup, and meta breaks out.
      `<svg><style><meta http-equiv=refresh content="0;url=${A}"></style></svg>`,
      `<svg><title><meta http-equiv=refresh content="0;url=${A}"></title></svg>`,
      `<svg><noscript><meta http-equiv=refresh content="0;url=${A}"></noscript></svg>`,
      `<svg><iframe><meta http-equiv=refresh content="0;url=${A}"></iframe></svg>`,
      `<math><mi><mglyph><style><meta http-equiv=refresh content="0;url=${A}"></style></mglyph></mi></math>`,
      `<svg><![CDATA[ x > <!-- ]]><meta http-equiv=refresh content="0;url=${A}"> -->`,
      `<math><mi><textarea></mi></math><meta http-equiv=refresh content="0;url=${A}">`,
      // A script's escaped states: this one ends at the second end tag.
      `<script><!--<script></script> <!-- </script><meta http-equiv=refresh content="0;url=${A}"> -->`,
      // Read in a noscript, which a frame without scripts parses as markup.
      `<noscript><meta http-equiv=refresh content="0;url=${A}"></noscript>`,
      `<noscript><style></noscript><base href="${A}"></style></noscript>`,
      // The round-1 differential: `</foreignObject>` under an open div is ignored, so the style
      // is HTML and the base after it is live.
      `<svg><foreignObject><div></foreignObject><style><!--</style><base href="${A}">`,
      // The round-2 differential: the same with a <p>, and speculation rules after it.
      `<svg><foreignObject><p></foreignObject><script type=speculationrules>{"prefetch":[{"urls":["${A}"]}]}</script>`,
      // A doctype-in-an-attribute trick, and a bogus comment end.
      `<!-- --!><base href="--><!doctype x>"><p>hi`,
      // Mutation XSS: text that serializes raw inside SVG's <style> and <script>, or a table's
      // foster parenting, and would close the element early on the browser's re-read.
      `<svg><style>&lt;/style&gt;&lt;meta http-equiv=refresh content="0;url=${A}"&gt;</style></svg>`,
      `<svg><script>&lt;/script&gt;&lt;base href="${A}"&gt;</script></svg>`,
      `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;base href=${A}&gt;">`,
      `<table><caption><svg><style><base href="${A}"></style></svg></caption></table>`,
      `<form><math><mtext></form><form><mglyph><style></math><base href="${A}">`,
      `<select><template><style><!--</style><base href="${A}"></template></select>`,
      `<template><meta http-equiv=refresh content="0;url=${A}"></template>`,
      `<plaintext><base href="${A}">`,
      `<xmp><base href="${A}"></xmp><iframe><base href="${A}"></iframe><noembed><base href="${A}"></noembed>`,
      `<table><base href="${A}"><tr><td><meta http-equiv=refresh content="0;url=${A}"></table>`,
      `<frameset><base href="${A}"></frameset>`,
    ]
  ) {
    assertSafe(html);
  }
});

test("served: text that only looks like those tags is kept, as text", () => {
  for (
    const [html, kept] of [
      // A script string, a JSON island, a template literal, a comment.
      [
        `<script>const s = '<meta http-equiv="refresh" content="5">';</script>`,
        `'<meta http-equiv="refresh" content="5">'`,
      ],
      [
        `<script type="application/json" id="d">{"head":"<meta http-equiv=\\"refresh\\" content=\\"0;url=/login\\"><base href=\\"/\\">"}</script>`,
        `{"head":"<meta http-equiv=\\"refresh\\" content=\\"0;url=/login\\"><base href=\\"/\\">"}`,
      ],
      [
        '<script>el.innerHTML = `<link rel="preload" href="x">`;</script>',
        '`<link rel="preload" href="x">`',
      ],
      [
        `<!-- <link rel="preconnect" href="https://cdn.jsdelivr.net"> -->`,
        `<!-- <link rel="preconnect" href="https://cdn.jsdelivr.net"> -->`,
      ],
      // Escaped code samples, a textarea, data attributes.
      [
        `<pre><code>&lt;meta http-equiv="refresh" content="5"&gt;</code></pre>`,
        `&lt;meta http-equiv="refresh" content="5"&gt;`,
      ],
      [
        `<textarea readonly><base href="/"></textarea>`,
        `<textarea readonly="">&lt;base href="/"&gt;</textarea>`,
      ],
      [
        `<div data-html='<meta http-equiv="refresh">'></div>`,
        `data-html="<meta http-equiv=&quot;refresh&quot;>"`,
      ],
      // An SVG with a title and a style keeps both.
      [
        `<svg viewBox="0 0 10 10"><title>A chart</title><style>.a{fill:red}</style></svg>`,
        `<title>A chart</title><style>.a{fill:red}</style>`,
      ],
    ]
  ) {
    assertStringIncludes(assertSafe(html), kept, html);
  }
});

test("served: the round-2 pages that were refused publish whole", () => {
  // From the review's corpus (scratchpad r2-correct/pages, the small ones; the pages with whole
  // libraries inlined were run outside the suite): each publishes, and its scripts survive.
  const pages = [
    // 09: a CDN page with hints a browser would fetch: they go, the rest stays.
    '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">\n' +
    '<meta http-equiv="X-UA-Compatible" content="IE=edge">\n' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">\n' +
    '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>\n' +
    "<script type=\"module\">import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs';</script>\n" +
    '<title>CDN page</title></head><body>\n<pre class="mermaid">graph TD; A-->B; B-->C</pre>\n' +
    "<canvas id=\"c\"></canvas>\n<script>new Chart(document.getElementById('c'),{type:'bar'});</script>\n</body></html>",
    // 11, 18, 19: tags written by script, as strings.
    "<!doctype html><html><head><title>x</title></head><body><pre id=out></pre><script>\n" +
    'const examples = { refresh: \'<meta http-equiv="refresh" content="5">\', base: \'<base href="/app/">\' };\n' +
    "</script></body></html>",
    "<!doctype html><body><script>\n" +
    'document.head.insertAdjacentHTML(\'beforeend\',\'<link rel="preload" as="style" href="https://cdn.jsdelivr.net/npm/x@1/x.css">\');\n' +
    "</script></body></html>",
    // 16: highlight.js with an escaped HTML sample.
    '<!doctype html><html><head><title>x</title><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/styles/github.min.css">' +
    '</head><body><pre><code class="language-html">&lt;link rel="modulepreload" href="/main.js"&gt;</code></pre>' +
    "<script>hljs.highlightAll()</script></body></html>",
  ];
  for (const page of pages) {
    const out = assertSafe(page);
    const scripts = (page.match(/<script/g) ?? []).length;
    // The handshake, and every script of the page's.
    assertEquals((out.match(/<script/g) ?? []).length, scripts + 1, page);
  }
});

test("served: the skill's starter page publishes, unchanged but for the preamble", async () => {
  const template = await readFile(
    new URL("../skills/ryph-artifact-design/assets/template.html", import.meta.url),
    "utf8",
  );
  const out = assertSafe(template);
  // What the browser builds from it is what it builds from the author's page, plus the preamble.
  const expected = parse(template, { scriptingEnabled: true });
  assertEquals(out.replace(ARTIFACT_PREAMBLE, ""), serialize(expected));
});

// ---------------------------------------------------------------------------
// Image refs
// ---------------------------------------------------------------------------

test("served: image refs become tokens where an image URL goes, and only there", () => {
  const html = `<IMG SRC=" ${REF_A} " alt=a>` +
    `<picture><source srcset="${REF_B} 2x, ${REF_A} 1x"></picture>` +
    `<video poster='${REF_B}'></video>` +
    `<style>.hero { background: URL( "${REF_A}" ) }</style>` +
    `<div style="background-image:url(${REF_B})"></div>` +
    `<svg><image href="${REF_A}"/><image xlink:href="${REF_B}"/></svg>` +
    `<p>The ref img-ffffffffffff in prose is just text.</p>` +
    `<script>const ref = "img-eeeeeeeeeeee"; const u = "url(img-dddddddddddd)";</script>` +
    `<textarea>url(img-cccccccccccc)</textarea>`;
  const out = prepareArtifactHtml(html);
  assert(out.kind === "ok");
  assertEquals(out.refs, [REF_A, REF_B]);
  assertStringIncludes(out.served, `<img src="ryph-img:${REF_A}" alt="a">`);
  assertStringIncludes(out.served, `srcset="ryph-img:${REF_B} 2x, ryph-img:${REF_A} 1x"`);
  assertStringIncludes(out.served, `poster="ryph-img:${REF_B}"`);
  assertStringIncludes(out.served, `.hero { background: URL( "ryph-img:${REF_A}" ) }`);
  assertStringIncludes(out.served, `style="background-image:url(ryph-img:${REF_B})"`);
  assertStringIncludes(out.served, `<image href="ryph-img:${REF_A}">`);
  assertStringIncludes(out.served, `<image xlink:href="ryph-img:${REF_B}">`);
  for (
    const text of [
      "img-ffffffffffff in prose",
      '"img-eeeeeeeeeeee"',
      "url(img-dddddddddddd)",
      "url(img-cccccccccccc)",
    ]
  ) {
    assertStringIncludes(out.served, text);
  }
  // An <img> in SVG's <style> breaks out of it: a real image, and its ref counts.
  const breakout = prepareArtifactHtml(`<svg><style><img src="${REF_A}"></style></svg>`);
  assert(breakout.kind === "ok");
  assertEquals(breakout.refs, [REF_A]);
});

test("serve: tokens are filled with data URIs up to the inline budget; the rest show broken", () => {
  const out = prepareArtifactHtml(`<img src=${REF_A}><img src=${REF_B}><p>ryph-img:${REF_A}</p>`);
  assert(out.kind === "ok");
  const filled = servedDocument(out.served, new Map([[REF_A, "data:image/png;base64,AAAA"]]));
  assertStringIncludes(filled, `<img src="data:image/png;base64,AAAA">`);
  // No image for it: the token stays, and the image shows broken.
  assertStringIncludes(filled, `<img src="ryph-img:${REF_B}">`);
  // Filling is parse-neutral: the document parses the same, with URIs where the tokens were.
  assertEquals(
    elementsOf(parse(filled)).map((e) => e.tagName),
    elementsOf(parse(out.served)).map((e) => e.tagName),
  );
  assertEquals([...tokenUses(out.served)], [[REF_A, 2], [REF_B, 1]]);

  // A reused image stops at the budget.
  const many = prepareArtifactHtml(`<img src=${REF_A}>`.repeat(400));
  assert(many.kind === "ok");
  const uri = "data:image/png;base64," + "A".repeat(100 * 1024);
  const big = servedDocument(many.served, new Map([[REF_A, uri]]));
  assert(big.length <= many.served.length + MAX_ARTIFACT_INLINED_BYTES);
  assertStringIncludes(big, `ryph-img:${REF_A}`);
});

// ---------------------------------------------------------------------------
// Crafted documents, and the process that bounds them
// ---------------------------------------------------------------------------

test("served: a tree too deep to write back is refused, not overflowed", () => {
  assertEquals(prepareArtifactHtml("<span>".repeat(20_000)).kind, "too_deep");
  assertEquals(prepareArtifactHtml("<span>".repeat(400)).kind, "ok");
});

test("served: a parse that would build more than MAX_TREE_NODES nodes is refused as it builds", () => {
  // Formatting elements left open are re-opened, attributes and all, in every block that
  // follows: 14.6 KB of this built 300,000 elements and took over 600 MB.
  const reopened = (divs: number, bolds: number) => {
    let b = "";
    for (let i = 0; i < bolds; i++) b += `<b a=${i}>`;
    return "<div>".repeat(divs) + b + "</div>x".repeat(divs);
  };
  const nodes = cpuTimed(() =>
    prepareArtifactHtml(reopened(1_000, 300), performance.now() + 3_000)
  );
  assertEquals(nodes.value.kind, "too_many_nodes");
  assert(nodes.ms < 1_000, `stopped after ${nodes.ms} ms of CPU`);
  // Counted per parse, one node or attribute each: just under the cap is a page, just over not.
  const paragraphs = (n: number) => "<p>".repeat(n);
  // The tree adds <html>, <head> and <body>; the served one the preamble's <script>, its text,
  // and <base> with its target.
  assertEquals(prepareArtifactHtml(paragraphs(MAX_TREE_NODES - 7)).kind, "ok");
  assertEquals(prepareArtifactHtml(paragraphs(MAX_TREE_NODES)).kind, "too_many_nodes");
});

test("served: a serialization past the served cap is refused as it is written", () => {
  // Few nodes, each reopened with a long attribute: the string, not the tree, would be huge.
  let b = "";
  for (let i = 0; i < 40; i++) b += `<b a=${i}${"y".repeat(2_000)}>`;
  const html = "<div>".repeat(2_000) + b + "</div>x".repeat(2_000);
  assertEquals(prepareArtifactHtml(html, performance.now() + 3_000).kind, "too_large");
  // Escaping counts: 2 MiB of `&` is 10 MiB written back.
  assertEquals(prepareArtifactHtml("<p>" + "&".repeat(1_000_000)).kind, "too_large");
  assertEquals(prepareArtifactHtml("<p>" + "&".repeat(800_000)).kind, "ok");
});

test("served: the parse stops itself at its deadline", () => {
  // Nested SVG then stray end tags: each end tag walks the whole open-element stack.
  const crafted = "<svg>" + "<g>".repeat(60_000) + "</q>".repeat(60_000);
  const stopped = cpuTimed(() => prepareArtifactHtml(crafted, performance.now() + 100));
  assertEquals(stopped.value.kind, "too_complex");
  assert(stopped.ms < 1_000, `stopped after ${stopped.ms} ms of CPU`);
});

/** 2 MiB of `unit(i)`, for i counting up. */
function fill(unit: (i: number) => string, prefix = "", suffix = ""): string {
  const parts = [prefix];
  let length = prefix.length + suffix.length;
  for (let i = 0; length < MAX_ARTIFACT_HTML_BYTES - 64; i++) {
    const part = unit(i);
    parts.push(part);
    length += part.length;
  }
  parts.push(suffix);
  return parts.join("");
}

/** `n` distinct attributes, numbered from `from`. */
const attrs = (n: number, from = 0) =>
  Array.from({ length: n }, (_, k) => ` a${(from + k).toString(36)}`).join("");

test("served: a tag or an element with more attributes than the cap is refused at once", () => {
  const timed = (html: string) => {
    const { value, ms } = cpuTimed(() => prepareArtifactHtml(html, performance.now() + 3_000));
    return { kind: value.kind, ms };
  };
  // One tag of 2 MiB of distinct attributes: N² in the tokenizer, minutes before the cap.
  let next = 0;
  const one = timed(fill(() => ` a${(next++).toString(36)}`, "<p", ">x"));
  assertEquals(one.kind, "too_many_attributes");
  assert(one.ms < 500, `took ${one.ms} ms`);
  // 5,000 on each of many tags.
  const many = timed(fill((i) => `<p${attrs(5_000, i * 5_000)}>`));
  assertEquals(many.kind, "too_many_attributes");
  assert(many.ms < 500, `took ${many.ms} ms`);
  // Stray <html> tags each add theirs to the one element, which then holds too many.
  const adopted = timed(fill((i) => `<html${attrs(MAX_TAG_ATTRIBUTES, i * MAX_TAG_ATTRIBUTES)}>`));
  assertEquals(adopted.kind, "too_many_attributes");
  assert(adopted.ms < 500, `took ${adopted.ms} ms`);
  // Exactly the cap is a page; one more is not.
  assertEquals(prepareArtifactHtml(`<p${attrs(MAX_TAG_ATTRIBUTES)}>x`).kind, "ok");
  assertEquals(
    prepareArtifactHtml(`<p${attrs(MAX_TAG_ATTRIBUTES + 1)}>x`).kind,
    "too_many_attributes",
  );
  // A duplicate is dropped, never counted: a tag repeating one attribute is just slow to read.
  assertEquals(prepareArtifactHtml(`<p${" a".repeat(10_000)}>x`).kind, "ok");
});

test("served: the clock is read inside a tag, before the tree builder hears of it", () => {
  // One tag of 2 MiB of the same attribute: the tree builder sees nothing until it ends.
  const oneTag = fill(() => " a", "<p", ">x");
  assertEquals(prepareArtifactHtml(oneTag).kind, "ok");
  // A clock that moves one tick each time it is read, so where the parse stops is counted in
  // reads, not in CPU time (whose noise on a loaded runner is as large as the whole tag's).
  // Outside the tag the parse reads it a handful of times; the 101st read is the first past the
  // deadline, so stopping there means it was read, every 64 attributes, inside the tag.
  const now = performance.now;
  let reads = 0;
  performance.now = () => ++reads;
  let stopped;
  try {
    stopped = prepareArtifactHtml(oneTag, 100);
  } finally {
    performance.now = now;
  }
  assertEquals(stopped.kind, "too_complex");
  assertEquals(reads, 101, "stopped at the first read past the deadline");
});

test("served: an attribute's whitespace is trimmed in linear time", () => {
  // A regex trim retried its second branch from every interior space: 240k of them took 30 s.
  for (
    const html of [
      `<link rel="a${" ".repeat(240_000)}x">`,
      `<img src="a${" ".repeat(1_000_000)}x">`,
    ]
  ) {
    const trimmed = cpuTimed(() => prepareArtifactHtml(html, performance.now() + 3_000));
    assertEquals(trimmed.value.kind, "ok");
    assert(trimmed.ms < 1_000, `took ${trimmed.ms} ms of CPU`);
  }
  // Trimmed all the same: a ref with spaces around it is still a ref.
  assertStringIncludes(served(`<img src=" \n${REF_A}\t ">`), `src="ryph-img:${REF_A}"`);
});

test("served: an attribute list shared by re-opened elements is rewritten once", () => {
  // One `<b srcset>` of commas, re-opened in every paragraph: each copy holds the same list.
  const html = `<p><b srcset="${REF_A}${",".repeat(200_000)}">` + "<p>x".repeat(2_000);
  // Written back it is 2,000 copies of the attribute, so too large; what is timed is the walk.
  const walked = cpuTimed(() => prepareArtifactHtml(html, performance.now() + 3_000));
  assertEquals(walked.value.kind, "too_large");
  assert(walked.ms < 1_000, `took ${walked.ms} ms of CPU`);
  // A shared list still has its refs made tokens, once each.
  const out = prepareArtifactHtml(
    `<p><b src="${REF_A}" style="background:url(${REF_B})">x<p>y<p>z`,
  );
  assert(out.kind === "ok");
  assertEquals(out.refs, [REF_A, REF_B]);
  assertEquals(out.served.split(`ryph-img:${REF_A}`).length - 1, 3);
});

/** The process preparer with its sanitizer replaced by `program` (a module under tests/). */
function processRunning(program: string, options: Parameters<typeof processArtifactHtml>[0]) {
  const path = fromFileUrl(new URL(program, import.meta.url));
  return processArtifactHtml({
    ...options,
    command: () => ({ cmd: process.execPath, args: ["--no-env-file", path] }),
  });
}

test("process: makes the served document off the event loop, under its budget, at most maxInFlight at a time and one per run", async () => {
  // Starting the sanitizer process under a check's CPU quota and gVisor takes seconds, not the
  // 40 ms it takes here, and a cold parse JITs parse5 as it goes: the grace and budget leave room
  // for that. What says the crafted documents stopped themselves is that none was killed.
  const killed: string[] = [];
  const preparer = processArtifactHtml({
    budgetMs: 1_000,
    graceMs: 10_000,
    maxInFlight: 2,
    onKilled: (owner) => killed.push(owner),
  });
  const prepare = async (owner: string, html: string) => {
    const slot = preparer.reserve(owner);
    if (slot.kind !== "slot") return slot;
    try {
      return await slot.prepare(html);
    } finally {
      slot.release();
    }
  };
  try {
    const ok = await prepare("r-1", `<p>hi</p><img src="${REF_A}">`);
    assertEquals(ok.kind, "ok", `killed: ${killed}`);
    assert(ok.kind === "ok" && ok.refs.length === 1 && ok.served.includes(ARTIFACT_PREAMBLE));

    const crafted = "<svg>" + "<g>".repeat(100_000) + "</q>".repeat(100_000);
    const started = performance.now();
    // The event loop keeps turning while the process parses.
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const [slow, sameRun, other, third] = await Promise.all([
      prepare("r-1", crafted),
      prepare("r-1", "<p>again</p>"),
      prepare("r-2", crafted),
      prepare("r-3", "<p>third</p>"),
    ]);
    clearInterval(timer);
    assertEquals(
      [slow.kind, sameRun.kind, other.kind, third.kind],
      ["too_complex", "owner_busy", "too_complex", "busy"],
    );
    assertEquals(killed, []);
    const took = performance.now() - started;
    assert(ticks > took / 10 / 3, `the event loop ticked ${ticks} times in ${took} ms`);
    // Both slots are free again: the processes stopped themselves, answered and exited.
    assertEquals(preparer.inFlight(), []);
    assertEquals((await prepare("r-1", "<p>again</p>")).kind, "ok");
    // A slot reserved and never used is given back.
    const unused = preparer.reserve("r-4");
    assert(unused.kind === "slot");
    unused.release();
    assertEquals(preparer.inFlight(), []);
  } finally {
    preparer.close();
  }
});

test("process: by default one document at a time per process", () => {
  const preparer = processArtifactHtml();
  try {
    const first = preparer.reserve("r-1");
    assert(first.kind === "slot");
    assertEquals(preparer.reserve("r-2").kind, "busy");
    first.release();
    const second = preparer.reserve("r-2");
    assert(second.kind === "slot");
    second.release();
    assertEquals(preparer.inFlight(), []);
  } finally {
    preparer.close();
  }
});

test("process: a sanitizer that never stops is killed at its deadline, and its slot is free once it has exited", async () => {
  const killed: string[] = [];
  const preparer = processRunning("./spinning_sanitizer.ts", {
    budgetMs: 100,
    graceMs: 400,
    onKilled: (owner) => killed.push(owner),
  });
  try {
    const slot = preparer.reserve("r-1");
    assert(slot.kind === "slot");
    const started = performance.now();
    // It spins forever, deaf to its budget and to everything but SIGKILL.
    const pending = slot.prepare("<p>x");
    assertEquals(preparer.reserve("r-2").kind, "busy");
    assertEquals(await pending, { kind: "too_complex", budgetMs: 100 });
    const took = performance.now() - started;
    assert(took >= 500 && took < 1_500, `answered after ${took} ms`);
    assertEquals(killed, ["r-1"]);
    // Answered only once the process has exited, so the slot is already free.
    assertEquals(preparer.inFlight(), []);
    const next = preparer.reserve("r-1");
    assert(next.kind === "slot");
    next.release();
  } finally {
    preparer.close();
  }
});

/** A document whose parse needs far more than an 8MB heap. Unconfined under Bun the cap is the
 * process's RSS, sampled every 10ms (sanitizer.ts), so the margin must be wide: 100_000 cells grew
 * it by only 16-30MB, little enough that pages the process already held could absorb it and the
 * parse finish `ok`. 1_000_000 grow it by 60-80MB and still parse well inside the budget. */
const HEAP_HUNGRY = "<td>x".repeat(1_000_000);

test("process: a document that needs more heap than the cap is refused as too complex", async () => {
  const preparer = processArtifactHtml({ heapMb: 8 });
  try {
    const slot = preparer.reserve("r-1");
    assert(slot.kind === "slot");
    assertEquals(await slot.prepare(HEAP_HUNGRY), {
      kind: "too_complex",
      budgetMs: 3_000,
    });
    assertEquals(preparer.inFlight(), []);
  } finally {
    preparer.close();
  }
});

test("process: closing kills what is running; it answers busy, and so does every later reserve", async () => {
  const preparer = processRunning("./spinning_sanitizer.ts", { budgetMs: 10_000 });
  const slot = preparer.reserve("r-1");
  assert(slot.kind === "slot");
  const pending = slot.prepare("<p>x");
  // Let it start before it is closed.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const started = performance.now();
  preparer.close();
  assertEquals(await pending, { kind: "busy" });
  assert(performance.now() - started < 1_000, "killed, not waited out");
  assertEquals(preparer.inFlight(), []);
  assertEquals(preparer.reserve("r-2").kind, "busy");
});

test("process: a sanitizer that fails is the platform's fault, never the document's", async () => {
  const preparer = processRunning("./missing_sanitizer.ts", {});
  try {
    const slot = preparer.reserve("r-1");
    assert(slot.kind === "slot");
    await assertRejects(() => slot.prepare("<p>x"), Error, "the artifact sanitizer failed");
    assertEquals(preparer.inFlight(), []);
  } finally {
    preparer.close();
  }
});

/** How the sanitizer runs for this test process: confined when a Node 25 or later is on PATH or
 * named in RYPH_ARTIFACT_SANITIZER_NODE. */
const runtime = sanitizerRuntime();

// TODO(bun): needs a Node 25 or later (on PATH, or RYPH_ARTIFACT_SANITIZER_NODE) to run at all,
// as mise.toml's is; skipped where there is none.
test.skipIf(runtime.kind !== "confined")(
  "process: confined, the sanitizer cannot write a file, read another, open a socket, or start a program or a worker",
  async () => {
    assert(runtime.kind === "confined");
    const probe = fromFileUrl(new URL("./confined_sanitizer_probe.ts", import.meta.url));
    const { cmd, args } = sanitizerCommand(3_000, 192, {
      ...runtime,
      reads: [...runtime.reads, probe],
    });
    // The sanitizer's own flags, with the probe in its place.
    const at = args.findIndex((arg) => !arg.startsWith("--") && arg.endsWith("/sanitizer.ts"));
    const flags = args.slice(0, at);
    const dir = await mkdtemp(join(tmpdir(), "ryph-confined-"));
    const target = join(dir, "written");
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const { code, stdout, stderr } = await command(cmd, {
        args: [...flags, probe, target, String(port)],
        cwd: dir,
        clearEnv: true,
        env: {},
      }).output();
      assertEquals(code, 0, new TextDecoder().decode(stderr));
      assertEquals(JSON.parse(new TextDecoder().decode(stdout)), {
        write: "ERR_ACCESS_DENIED",
        read: "ERR_ACCESS_DENIED",
        net: "ERR_ACCESS_DENIED",
        fetch: "ERR_ACCESS_DENIED",
        spawn: "ERR_ACCESS_DENIED",
        worker: "ERR_ACCESS_DENIED",
      });
      assertEquals(existsSync(target), false);
      assertEquals(connections, 0);
      // The flags grant reading and nothing else.
      assert(flags.includes("--permission"));
      for (const flag of flags) {
        assert(
          flag === "--permission" || flag.startsWith("--allow-fs-read=") ||
            flag.startsWith("--max-old-space-size="),
          `granted ${flag}`,
        );
      }
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

// TODO(bun): needs a Node 25 or later, as above.
test.skipIf(runtime.kind !== "confined")(
  "process: a confined sanitizer that holds a permission it must not refuses to read the document: a platform fault",
  async () => {
    assert(runtime.kind === "confined");
    for (
      const extra of [
        "--allow-child-process",
        "--allow-net",
        "--allow-fs-write=/",
        "--allow-worker",
        // Reading beyond its own modules and parse5's, however the grant is spelled.
        "--allow-fs-read=/etc",
        `--allow-fs-read=${homedir()}`,
        `--allow-fs-read=${fromFileUrl(new URL("../src/main.ts", import.meta.url))}`,
        "--allow-fs-read=/tmp/node_modules/parse5/../../..",
      ]
    ) {
      const preparer = processArtifactHtml({
        command: (budgetMs, heapMb) => {
          const { cmd, args } = sanitizerCommand(budgetMs, heapMb, runtime);
          return { cmd, args: [args[0], extra, ...args.slice(1)] };
        },
      });
      try {
        const slot = preparer.reserve("r-1");
        assert(slot.kind === "slot");
        await assertRejects(() => slot.prepare("<p>x"), Error, "the sanitizer ", extra);
        assertEquals(preparer.inFlight(), []);
      } finally {
        preparer.close();
      }
    }
  },
);

test("process: without a node that confines it, the sanitizer runs unconfined, says so once, and still sanitizes", async () => {
  const told: string[] = [];
  const path = process.env.PATH;
  const named = process.env.RYPH_ARTIFACT_SANITIZER_NODE;
  process.env.PATH = "";
  delete process.env.RYPH_ARTIFACT_SANITIZER_NODE;
  let preparer: ReturnType<typeof processArtifactHtml>;
  try {
    preparer = processArtifactHtml({ onUnconfined: (why) => told.push(why) });
  } finally {
    process.env.PATH = path;
    if (named !== undefined) process.env.RYPH_ARTIFACT_SANITIZER_NODE = named;
  }
  try {
    assertEquals(told.length, 1);
    assertStringIncludes(told[0], "WITHOUT a permission layer");
    const prepare = async (html: string) => {
      const slot = preparer.reserve("r-1");
      assert(slot.kind === "slot");
      return await slot.prepare(html);
    };
    const ok = await prepare(`<p>hi</p><img src="${REF_A}">`);
    assert(ok.kind === "ok" && ok.refs[0] === REF_A && ok.served.includes(ARTIFACT_PREAMBLE));
    const crafted = "<svg>" + "<g>".repeat(100_000) + "</q>".repeat(100_000);
    assertEquals((await prepare(crafted)).kind, "too_complex");
  } finally {
    preparer.close();
  }
  // Its heap budget holds too.
  const small = processArtifactHtml({
    heapMb: 8,
    command: (budgetMs, heapMb) =>
      sanitizerCommand(budgetMs, heapMb, { kind: "unconfined", why: "" }),
  });
  try {
    const slot = small.reserve("r-1");
    assert(slot.kind === "slot");
    assertEquals(await slot.prepare(HEAP_HUNGRY), {
      kind: "too_complex",
      budgetMs: 3_000,
    });
  } finally {
    small.close();
  }
});

/** `processArtifactHtml()` built with `env` in place of these variables, and what it said. */
function preparedWith(env: Record<string, string | undefined>) {
  const told: string[] = [];
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const put = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  put(env);
  try {
    const preparer = processArtifactHtml({
      onUnavailable: (why) => told.push(`unavailable: ${why}`),
      onUnconfined: (why) => told.push(`unconfined: ${why}`),
    });
    return { preparer, told };
  } finally {
    put(saved);
  }
}

test("process: an empty RYPH_ARTIFACT_SANITIZER_NODE is not unset: every publish is refused as unavailable", async () => {
  for (const value of ["", "  "]) {
    const { preparer, told } = preparedWith({ RYPH_ARTIFACT_SANITIZER_NODE: value });
    try {
      assertEquals(told.length, 1);
      assertStringIncludes(told[0], "unavailable: ");
      assertStringIncludes(told[0], "RYPH_ARTIFACT_SANITIZER_NODE is set but empty");
      const slot = preparer.reserve("r-1");
      assert(slot.kind === "slot");
      assertEquals(await slot.prepare("<p>x"), { kind: "unavailable" });
    } finally {
      preparer.close();
    }
  }
});

test("process: with RYPH_ARTIFACT_SANITIZER_CONFINED=required, no node that confines it means unavailable, not unconfined", async () => {
  const { preparer, told } = preparedWith({
    PATH: "",
    RYPH_ARTIFACT_SANITIZER_NODE: undefined,
    RYPH_ARTIFACT_SANITIZER_CONFINED: "required",
  });
  try {
    assertEquals(told.length, 1);
    assertStringIncludes(told[0], "unavailable: ");
    assertStringIncludes(told[0], "RYPH_ARTIFACT_SANITIZER_CONFINED=required");
    const slot = preparer.reserve("r-1");
    assert(slot.kind === "slot");
    assertEquals(await slot.prepare("<p>x"), { kind: "unavailable" });
  } finally {
    preparer.close();
  }
});

test("process: a node named in RYPH_ARTIFACT_SANITIZER_NODE that cannot confine it refuses every publish as unavailable", async () => {
  const told: string[] = [];
  const named = process.env.RYPH_ARTIFACT_SANITIZER_NODE;
  process.env.RYPH_ARTIFACT_SANITIZER_NODE = "/nonexistent/node";
  let preparer: ReturnType<typeof processArtifactHtml>;
  try {
    preparer = processArtifactHtml({ onUnavailable: (why) => told.push(why) });
  } finally {
    if (named === undefined) delete process.env.RYPH_ARTIFACT_SANITIZER_NODE;
    else process.env.RYPH_ARTIFACT_SANITIZER_NODE = named;
  }
  try {
    assertEquals(told.length, 1);
    assertStringIncludes(told[0], "RYPH_ARTIFACT_SANITIZER_NODE=/nonexistent/node");
    const slot = preparer.reserve("r-1");
    assert(slot.kind === "slot");
    assertEquals(await slot.prepare("<p>x"), { kind: "unavailable" });
    assertEquals(preparer.inFlight(), []);
  } finally {
    preparer.close();
  }
});

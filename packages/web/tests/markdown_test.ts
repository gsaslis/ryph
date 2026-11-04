// HTML → markdown: what readability keeps, what the fallback strips, and the two conversions an
// agent actually depends on — tables it can read, and code blocks that carry their language.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { htmlToMarkdown } from "../src/core/markdown.ts";

const BASE = "https://example.com/docs/page";

const article = (body: string) =>
  `<html><head><title>The title</title></head><body>
    <nav><a href="/elsewhere">Menu</a></nav>
    <article>${body}</article>
    <footer>© someone</footer>
  </body></html>`;

const PROSE = "<p>A paragraph with enough words in it that the extractor treats this as an " +
  "article rather than as a navigation menu, repeated so the threshold is cleared.</p>";

test("readability keeps the article and drops the chrome", () => {
  const out = htmlToMarkdown(article(PROSE.repeat(4)), BASE);
  assertEquals(out.title, "The title");
  assertStringIncludes(out.markdown, "A paragraph with enough words");
  assert(!out.markdown.includes("Menu"), "navigation must not survive");
  assert(!out.markdown.includes("© someone"), "the footer must not survive");
});

test("a page readability declines falls back to the body, chrome removed", () => {
  const html = `<html><head><title>Tiny</title></head><body>
    <script>alert("no")</script><style>p{}</style>
    <nav>Menu</nav><header>Head</header><aside>Ads</aside>
    <main><p>Short.</p></main>
    <footer>Foot</footer></body></html>`;
  const out = htmlToMarkdown(html, BASE);
  assertEquals(out.via, "body");
  assertEquals(out.title, "Tiny");
  assertStringIncludes(out.markdown, "Short.");
  for (const chrome of ["alert", "Menu", "Head", "Ads", "Foot"]) {
    assert(!out.markdown.includes(chrome), `${chrome} must not survive`);
  }
});

test("tables become pipe tables", () => {
  const table = "<table><thead><tr><th>Flag</th><th>What</th></tr></thead>" +
    "<tbody><tr><td>--allow-net</td><td>network</td></tr></tbody></table>";
  const out = htmlToMarkdown(article(PROSE.repeat(4) + table), BASE);
  assertStringIncludes(out.markdown, "| Flag | What |");
  // turndown escapes a leading dash in a cell; the shape is what matters.
  assertStringIncludes(out.markdown, "allow-net | network |");
});

test("pre/code becomes a fenced block carrying the language class", () => {
  const code = '<pre><code class="language-ts">const x: number = 1;</code></pre>';
  const out = htmlToMarkdown(article(PROSE.repeat(4) + code), BASE);
  assertStringIncludes(out.markdown, "```ts\nconst x: number = 1;\n```");
});

test("a highlighter's other spellings are read too", () => {
  const code = '<pre class="highlight-source-shell"><code>deno task ci</code></pre>';
  const out = htmlToMarkdown(article(PROSE.repeat(4) + code), BASE);
  assertStringIncludes(out.markdown, "```shell\ndeno task ci\n```");
});

test("a code block full of backticks gets a longer fence", () => {
  const code = "<pre><code>a ``` b</code></pre>";
  const out = htmlToMarkdown(article(PROSE.repeat(4) + code), BASE);
  assertStringIncludes(out.markdown, "````\na ``` b\n````");
});

test("relative links become absolute, so every URL can be fetched again", () => {
  const links =
    '<p><a href="../other">there</a> and <a href="https://other.example/x">here</a></p>';
  const out = htmlToMarkdown(article(PROSE.repeat(4) + links), BASE);
  assertStringIncludes(out.markdown, "[there](https://example.com/other)");
  assertStringIncludes(out.markdown, "[here](https://other.example/x)");
});

test("a page with no text at all converts to nothing, rather than throwing", () => {
  const out = htmlToMarkdown("<html><body></body></html>", BASE);
  assertEquals(out.markdown, "");
});

test("malformed HTML is converted, not refused", () => {
  const out = htmlToMarkdown("<p>unclosed <b>bold", BASE);
  assertStringIncludes(out.markdown, "unclosed");
});

test("links resolve against the PAGE, not against whatever the converter's own location is", () => {
  // The regression this pins: readability rewrites relative hrefs against the document's base,
  // and a document parsed from a string has none — so inside the conversion worker every link
  // came back pointing at the worker's own file: URL.
  const out = htmlToMarkdown(
    article(`${PROSE.repeat(4)}<p><a href="../other">there</a></p>`),
    "https://example.com/docs/page",
  );
  assertStringIncludes(out.markdown, "[there](https://example.com/other)");
  assert(!out.markdown.includes("file://"), "no link may point at this deployment's disk");
});

test("a page's own <base href> wins, resolved against the page URL", () => {
  const html = `<html><head><title>T</title><base href="/root/"></head><body>
    <article>${PROSE.repeat(4)}<p><a href="deep/x">x</a></p></article></body></html>`;
  const out = htmlToMarkdown(html, "https://example.com/docs/page");
  assertStringIncludes(out.markdown, "[x](https://example.com/root/deep/x)");
});

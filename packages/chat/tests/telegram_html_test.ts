// A run's Markdown as Telegram's HTML: what renders, what stays as written, and that nothing
// the source says becomes markup of its own.
import { test } from "bun:test";

import { assertEquals } from "@std/assert";
import { markdownToTelegramHtml as html } from "../src/adapters/transport/telegram_html.ts";

test("telegram html: emphasis, code, strike and links render", () => {
  assertEquals(
    html("**bold**, *it*, _also it_, __bold too__, ~~gone~~ and `a < b`"),
    "<b>bold</b>, <i>it</i>, <i>also it</i>, <b>bold too</b>, <s>gone</s> and " +
      "<code>a &lt; b</code>",
  );
  assertEquals(
    html('see [the **run**](https://app.test/r?a=1&b="2")'),
    'see <a href="https://app.test/r?a=1&amp;b=&quot;2&quot;">the <b>run</b></a>',
  );
  assertEquals(html("**`code` inside**"), "<b><code>code</code> inside</b>");
});

test("telegram html: what only looks like Markdown stays as written", () => {
  assertEquals(html("snake_case_name and 2 * 3 * 4"), "snake_case_name and 2 * 3 * 4");
  assertEquals(
    html("https://x.test/a_b_c_d and *https://y.test/_z_*"),
    "https://x.test/a_b_c_d and <i>https://y.test/_z_</i>",
  );
  assertEquals(html("a lone ** and a ` tick"), "a lone ** and a ` tick");
  assertEquals(html("\\*not italic\\*"), "*not italic*");
  assertEquals(html("`**not bold**`"), "<code>**not bold**</code>");
});

test("telegram html: nothing the source says becomes a tag, and only http(s) links are links", () => {
  assertEquals(html("<b>x</b> & <a href=x>"), "&lt;b&gt;x&lt;/b&gt; &amp; &lt;a href=x&gt;");
  assertEquals(
    html("[ping](tg://user?id=42) [js](javascript:alert(1))"),
    "[ping](tg://user?id=42) [js](javascript:alert(1))",
  );
});

test("telegram html: blocks — fences, headings, quotes, bullets", () => {
  assertEquals(
    html(
      "## Plan\n- one **thing**\n  * nested\n> quoted *words*\n> more\n```ts\nconst a = 1 < 2;\n```\nend",
    ),
    "<b>Plan</b>\n• one <b>thing</b>\n  • nested\n<blockquote>quoted <i>words</i>\nmore" +
      '</blockquote>\n<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>\nend',
  );
  // An info string past the language is dropped, and the block is still code.
  assertEquals(
    html("```ts title=x\nlet a_b_c = *p;\n```"),
    '<pre><code class="language-ts">let a_b_c = *p;</code></pre>',
  );
  // A closing run of `#`s goes only after a space.
  assertEquals(html("# Learning C#"), "<b>Learning C#</b>");
  assertEquals(html("## Done ##"), "<b>Done</b>");
  // A part cut from a longer post may open a block it does not close.
  assertEquals(html("```\nopen *code*"), "<pre>open *code*</pre>");
});

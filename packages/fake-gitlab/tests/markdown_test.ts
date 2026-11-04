// The fake's block model against the vectors it shares with the GitLab adapter's quick-action
// rule: whatever the adapter sends for a vector as a diff note runs nothing here, under either of
// GitLab's detections, carries no zero-width space, and carries exactly the suggestions the agent
// wrote; the same text escaped, as anywhere else, runs nothing either. And the model fails open:
// a block it does not know makes the rest of the text paragraphs, never code.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { blocksOf, preProcessed } from "../src/markdown.ts";
import { extractQuickActions, renderedLine } from "../src/quick_actions.ts";
import { suggestionsIn } from "../src/suggestions.ts";
import { MARKDOWN_VECTORS, Z } from "./markdown_vectors.ts";

/** A line GitLab's raw detection could take as a command: `/`, then a command name (any word or
 * non-ASCII character, as Ruby folds case), then a blank or the line's end. */
const COMMAND_SHAPED = /^\/[A-Za-z0-9_\u0080-\u{10FFFF}]+(?:[\t\v\f\r ]|$)/u;

/** Nothing in `text` runs here, under either detection. */
function runsNothing(text: string, what: string) {
  for (const matchRendered of [false, true]) {
    assertEquals(extractQuickActions(text, undefined, { matchRendered }).actions, [], what);
  }
  const lines = text.split("\n");
  blocksOf(text).topParagraph.forEach((top, i) => {
    if (top) assert(!COMMAND_SHAPED.test(renderedLine(lines[i]!)), `${what}: ${lines[i]}`);
  });
}

for (const v of MARKDOWN_VECTORS) {
  test(`shared vector: ${v.name}`, () => {
    // Anywhere but a diff note: escaped, never refused.
    const escaped = v.text.replace(/^\uFEFF+/, "").replace(/\r\n?/g, "\n").split("\n")
      .map((l) => l.replace(/^([ \t]*)\//, `$1${Z}/`)).join("\n");
    runsNothing(escaped, "escaped");
    if (v.inert === "refused") return;
    runsNothing(v.inert, "diff note");
    assert(!v.inert.includes(Z) || v.text.includes(Z), "a diff note gains no zero-width space");
    assertEquals(
      suggestionsIn(v.inert).map((s) => s.text.replace(/\n$/, "")),
      v.suggestions ?? [],
    );
  });
}

test("GitLab's pre-processing: a leading byte-order mark dropped, front matter made a fence", () => {
  assertEquals(preProcessed("\uFEFF```suggestion\nx\n```"), "```suggestion\nx\n```");
  assertEquals(
    preProcessed("---suggestion\n/x\n---\nok"),
    "```suggestion:frontmatter\n/x\n```\nok",
  );
  // An encoding line is dropped for a blank one; blank lines before stay; any delimiter or
  // `...` closes; the language defaults by delimiter.
  assertEquals(
    preProcessed("# coding: utf-8\n\n;;;suggestion:-2+0\n  /x\n+++\n"),
    "\n\n```suggestion:-2+0:frontmatter\n  /x\n```\n",
  );
  assertEquals(preProcessed("+++\na = 1\n...\nb"), "```toml:frontmatter\na = 1\n```\nb");
  // Only at the very start.
  assertEquals(preProcessed("x\n---suggestion\na\n---"), "x\n---suggestion\na\n---");
  assertEquals(suggestionsIn("---suggestion\n/x\n---").map((s) => [s.above, s.text]), [[
    0,
    "/x\n",
  ]]);
  assertEquals(
    suggestionsIn(";;;suggestion:-2+1\nx\n;;;").map((s) => [s.above, s.below, s.text]),
    [[2, 1, "x\n"]],
  );
});

test("blocks: top-level paragraphs and fences, where CommonMark puts them", () => {
  const b = blocksOf("a\n- b\n/c\n\n- ```\n/d\n```\n/e\n```\n> x\n/f");
  // `/c` continues the item's paragraph lazily; `/d` is outside the item its fence was in.
  assertEquals(b.topParagraph, [
    true,
    false,
    false,
    false,
    false,
    true,
    false,
    false,
    false,
    false,
    false,
  ]);
  assertEquals(b.fences.map((f) => [f.info, f.content, f.topLevel]), [
    ["", [], false],
    ["", ["/e"], true],
  ]);
  // A tab inside a top-level fence is kept as written.
  assertEquals(blocksOf("```go\n\tx := 1\n```").fences[0]!.content, ["\tx := 1"]);
});

test("a fence opened inside a list item or a quote ends with it: the command after it runs", () => {
  assertEquals(extractQuickActions("- ```\n/label ~a").actions, [{ name: "label", arg: "~a" }]);
  assertEquals(extractQuickActions("> ```\n/label ~b").actions, [{ name: "label", arg: "~b" }]);
  // While the item's paragraph is lazily continued, nothing runs.
  assertEquals(extractQuickActions("- item\n/label ~c").actions, []);
});

test("a block the model does not know makes the rest paragraphs: it never runs less than GitLab", () => {
  // Each runs on GitLab (comrak with GitLab's options): a fence or HTML in a description list's
  // details, a line after an alert (no lazy continuation), `>>>` with text after it, an indented
  // `>>>` closer, a line after a link reference definition's setext-looking `---`.
  for (
    const body of [
      "Term\n: def\n  ```\n/label ~a",
      "Term\n: def\n  <div>\n/label ~a",
      "> [!note]\n/label ~a",
      ">>> x\n\n/label ~a",
      ">>>\nquoted\n  >>>\n/label ~a",
      "[ref]: /url\n---\n</a>\n/label ~a",
    ]
  ) {
    assertEquals(extractQuickActions(body).actions, [{ name: "label", arg: "~a" }], body);
  }
  // A lone tag starts an HTML block where the line would only continue a paragraph lazily.
  assertEquals(extractQuickActions("- a\n<del>\n```\n\n/label ~a").actions, [
    { name: "label", arg: "~a" },
  ]);
});

test("an info string is read as CommonMark reads it: escapes and references resolved", () => {
  const infos = blocksOf("```sugg&#101;stion:-0+0\nx\n```\n~~~suggestion\\:-1+0\ny\n~~~").fences
    .map((f) => f.info);
  assertEquals(infos, ["suggestion:-0+0", "suggestion:-1+0"]);
});

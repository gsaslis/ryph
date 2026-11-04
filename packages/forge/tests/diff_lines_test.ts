// Which diff lines a review remark can anchor to, as tables: the forge's own anchoring rule, and
// the sentence a model reads when a remark misses.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { anchorableLines, describeLines, unanchoredRemarks } from "../src/core/diff_lines.ts";

const PATCH = [
  "@@ -10,4 +10,5 @@ export function schedule() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " return a;",
  " }",
  "@@ -40,2 +41,2 @@",
  " x",
  "-y",
  "\\ No newline at end of file",
  "+y",
  "\\ No newline at end of file",
].join("\n");

test("RIGHT holds added and context lines by new numbering; LEFT deleted and context by old", () => {
  const lines = anchorableLines(PATCH);
  assertEquals([...lines.RIGHT], [10, 11, 12, 13, 14, 41, 42]);
  assertEquals([...lines.LEFT], [10, 11, 12, 13, 40, 41]);
});

test("an added file from GitLab's diff, ending in a newline, is its lines on RIGHT and nothing on LEFT", () => {
  const added = "@@ -0,0 +1,6 @@\n+a\n+b\n+c\n+d\n+e\n+f\n";
  const lines = anchorableLines(added);
  assertEquals([...lines.RIGHT], [1, 2, 3, 4, 5, 6]);
  assertEquals([...lines.LEFT], []);
});

test("a deleted file is its lines on LEFT and nothing on RIGHT, trailing newline or not", () => {
  for (const tail of ["", "\n"]) {
    const lines = anchorableLines(`@@ -1,3 +0,0 @@\n-a\n-b\n-c${tail}`);
    assertEquals([...lines.LEFT], [1, 2, 3]);
    assertEquals([...lines.RIGHT], []);
  }
});

test("a blank context line counts, spelled with its space or without; the text's end does not", () => {
  for (const blank of [" ", ""]) {
    const patch = ["@@ -1,3 +1,4 @@", " a", blank, "+new", " c", ""].join("\n");
    const lines = anchorableLines(patch);
    assertEquals([...lines.RIGHT], [1, 2, 3, 4]);
    assertEquals([...lines.LEFT], [1, 2, 3]);
  }
});

test("lines read as ranges", () => {
  assertEquals(describeLines(new Set([10, 11, 12, 14, 41, 42])), "lines 10–12, 14, 41–42");
  assertEquals(describeLines(new Set([7])), "line 7");
  assertEquals(describeLines(new Set()), "no lines");
});

test("every remark that cannot anchor is named by its position; the ones that can are not", () => {
  const files = [{ path: "src/a.ts", patch: PATCH }, { path: "logo.png", patch: null }];
  const problems = unanchoredRemarks(files, true, [
    { path: "src/a.ts", line: 13, side: "RIGHT" },
    { path: "src/a.ts", line: 13, side: "LEFT" },
    { path: "src/a.ts", line: 99, side: "RIGHT" },
    { path: "logo.png", line: 1, side: "RIGHT" },
    { path: "src/b.ts", line: 1, side: "RIGHT" },
  ]);
  assertEquals(problems, [
    "remark 3 (src/a.ts:99): not a line of the diff on side RIGHT; there it has lines 10–14, 41–42",
    "remark 4 (logo.png:1): the forge shows no diff for that file, so nothing can anchor there",
    "remark 5 (src/b.ts:1): the pull request does not change that file",
  ]);
});

test("an incomplete listing leaves an unlisted path to the forge", () => {
  assertEquals(
    unanchoredRemarks([{ path: "src/a.ts", patch: PATCH }], false, [
      { path: "src/b.ts", line: 1, side: "RIGHT" },
    ]),
    [],
  );
});

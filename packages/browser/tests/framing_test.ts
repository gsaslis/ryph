// Page-derived text cannot close its own fence, cannot write lines where one is expected, and is
// cut where the caps say — at a line break when there is one, never inside a surrogate pair.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { capText, kb, oneLine, PAGE_NOTICE, untrusted } from "../src/core/framing.ts";

test("untrusted content is one notice line, then the fence", () => {
  const out = untrusted("hello");
  assertEquals(out, `${PAGE_NOTICE}\n\`\`\`\nhello\n\`\`\``);
});

test("oneLine flattens control characters and the Unicode line separators", () => {
  assertEquals(oneLine("a\nb\r\nc d e\u0000f"), "a b c d e f");
  assertEquals(oneLine("x".repeat(10), 5), "xxxx…");
});

test("capText keeps short text whole", () => {
  assertEquals(capText("abc", 10), { text: "abc", total: 3, truncated: false });
});

test("capText cuts at the last line break in the final quarter", () => {
  const text = "a".repeat(80) + "\n" + "b".repeat(40);
  const out = capText(text, 100);
  assertEquals(out.text, "a".repeat(80));
  assertEquals(out.total, 121);
  assert(out.truncated);
});

test("capText cuts mid-line when no line break is near, and never splits a pair", () => {
  const text = "a".repeat(9) + "😀" + "z";
  const out = capText(text, 10);
  assertEquals(out.text, "a".repeat(9));
});

test("kb speaks in round numbers", () => {
  assertEquals(kb(40 * 1024), "40 KB");
  assertEquals(kb(1536), "1.5 KB");
  assertStringIncludes(kb(123_456), "KB");
});

// The notices, the slice and the truncating reader: what stands between a 300 KB page written by
// a stranger and a model's context window. The fence is @ryph/shared/markdown's, tested there.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { PAGE_NOTICE, RESULTS_NOTICE, SLICE_CHARS, sliceOf } from "../src/core/framing.ts";
import { readTruncated } from "../src/core/body.ts";

test("both notices say the content is data and not instructions", () => {
  for (const notice of [PAGE_NOTICE, RESULTS_NOTICE]) {
    assert(notice.toLowerCase().includes("never"));
    assert(notice.toLowerCase().includes("instructions"));
  }
});

test("slicing walks a page and ends exactly once", () => {
  const text = "x".repeat(SLICE_CHARS * 2 + 10);
  const first = sliceOf(text, 0);
  assertEquals(first.from, 0);
  assertEquals(first.to, SLICE_CHARS);
  assertEquals(first.next, SLICE_CHARS);
  const second = sliceOf(text, first.next!);
  assertEquals(second.next, SLICE_CHARS * 2);
  const last = sliceOf(text, second.next!);
  assertEquals(last.text.length, 10);
  assertEquals(last.next, null);
});

test("an offset past the end is clamped, never an error", () => {
  const slice = sliceOf("short", 900);
  assertEquals(slice.text, "");
  assertEquals(slice.from, 5);
  assertEquals(slice.next, null);
});

test("a negative or fractional offset is taken as the nearest sane one", () => {
  assertEquals(sliceOf("abcdef", -5).from, 0);
  assertEquals(sliceOf("abcdef", 2.7).from, 2);
});

// ---- the capped reader ---------------------------------------------------------

test("a body that ends exactly ON the cap is not reported as cut", async () => {
  const stream = streamOf(["x".repeat(64)]);
  const read = await readTruncated(stream, 64);
  assertEquals(read.bytes.byteLength, 64);
  assertEquals(read.truncated, false);
});

test("a body whose chunk lands exactly on the cap with more behind it IS cut", async () => {
  const stream = streamOf(["x".repeat(64), "more"]);
  const read = await readTruncated(stream, 64);
  assertEquals(read.bytes.byteLength, 64);
  assertEquals(read.truncated, true, "the byte after the cap is what proves it was cut");
});

test("a body under the cap is whole; one past it is cut", async () => {
  assertEquals((await readTruncated(streamOf(["abc"]), 64)).truncated, false);
  const over = await readTruncated(streamOf(["x".repeat(65)]), 64);
  assertEquals(over.truncated, true);
  assertEquals(over.bytes.byteLength, 64, "never more than the cap comes back");
});

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test("a slice never cuts a surrogate pair in half", () => {
  // Each emoji is two UTF-16 code units, so a slice of 3 would land inside the second one.
  const text = "🌐🌐🌐🌐";
  const first = sliceOf(text, 0, 3);
  assertEquals(first.text, "🌐🌐", "moved forward to the pair's end, never inside it");
  assertEquals(first.to % 2, 0);
  const second = sliceOf(text, first.next!, 3);
  assertEquals(second.text, "🌐🌐");
  assertEquals(second.next, null);
  // And the whole page comes back across the two calls, undamaged.
  assertEquals(first.text + second.text, text);
  // An offset that lands inside a pair is moved forward rather than splitting it.
  assertEquals(sliceOf(text, 1, 2).text, "🌐");
});

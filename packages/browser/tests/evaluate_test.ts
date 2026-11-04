// The in-page serialiser, run here outside any page: bounded on every axis, honest about what it
// could not represent. The DOM-node branch is covered by the integration test, in a real page.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cutSerialised, parseCut, serialiseForTest, wrapEvaluate } from "../src/core/evaluate.ts";

/** What the adapter does with the wrapper's answer: cut it as the page would, then parse. */
const pulled = (answer: unknown, cap = 20_000) => parseCut(cutSerialised(answer, cap), cap);

const ser = (v: unknown, cap = 20_000) => serialiseForTest(v, cap);
const parsed = (v: unknown) => JSON.parse(ser(v).text);

test("plain values come back as JSON", () => {
  assertEquals(parsed({ a: 1, b: ["x", true, null] }), { a: 1, b: ["x", true, null] });
  assertEquals(ser("hi").text, '"hi"');
});

test("what JSON cannot say is said in words", () => {
  assertEquals(ser(undefined).text, "undefined");
  assertEquals(parsed({ u: undefined, n: NaN, i: -Infinity, b: 10n, f: function named() {} }), {
    u: "[undefined]",
    n: "NaN",
    i: "-Infinity",
    b: "10n",
    f: "[function named]",
  });
  assertEquals(parsed(new Map([["k", 1]])), { k: 1 });
  assertEquals(parsed(new Set([1, 2])), [1, 2]);
  assertEquals(parsed(new Date(0)), "1970-01-01T00:00:00.000Z");
  assertEquals(parsed(new Error("boom")), "[Error: boom]");
});

test("cycles and depth are bounded", () => {
  const a: Record<string, unknown> = {};
  a.self = a;
  assertEquals(parsed(a), { self: "[circular]" });
  let deep: Record<string, unknown> = {};
  const root = deep;
  for (let i = 0; i < 20; i++) {
    deep.next = {};
    deep = deep.next as Record<string, unknown>;
  }
  assertStringIncludes(ser(root).text, "[…]");
});

test("big arrays and objects are cut, saying how much is missing", () => {
  const items = parsed(Array.from({ length: 1000 }, (_, i) => i)) as unknown[];
  assertEquals(items.length, 201);
  assertEquals(items.at(-1), "… 800 more items");
  const keys = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
  assertEquals((parsed(keys) as Record<string, unknown>)["…"], "300 more keys");
});

test("the JSON is cut one past the cap, and its full length reported", () => {
  const out = ser(Array.from({ length: 100 }, () => "y".repeat(500)), 1000);
  assertEquals(out.text.length, 1001);
  assert(out.total > 50_000);
});

test("a throwing getter does not sink the whole result", () => {
  const o = {
    get bad() {
      throw new Error("nope");
    },
    ok: 1,
  };
  assertEquals(parsed(o), { bad: "[getter threw: Error: nope]", ok: 1 });
});

test("the wrapper is a function source that calls, awaits and serialises", async () => {
  const src = wrapEvaluate("async (el) => ({ got: el, t: 1 })", 20_000);
  const fn = (0, eval)(`(${src})`) as (el: unknown) => Promise<unknown>;
  const out = pulled(await fn("element"));
  assert(out !== null);
  assertEquals(JSON.parse(out.text), { got: "element", t: 1 });
});

test("a source that is not a function fails, saying what is expected", async () => {
  const fn = (0, eval)(`(${wrapEvaluate("42")})`) as (el: unknown) => Promise<unknown>;
  let message = "";
  try {
    await fn(undefined);
  } catch (err) {
    message = String(err);
  }
  assertStringIncludes(message, "evaluate takes a function");
});

test("the cut refuses anything but the serialiser's shape", () => {
  assertEquals(cutSerialised(null, 10), null);
  assertEquals(cutSerialised({ text: 1, total: 1 }, 10), null);
  assertEquals(cutSerialised({ text: { toString: () => "x".repeat(100) } }, 10), null);
  assertEquals(parseCut(null, 10), null);
  assertEquals(parseCut("12", 10), null);
  assertEquals(parseCut("1:" + "x".repeat(12), 10), null);
  assertEquals(parseCut("3:abc", 10), { text: "abc", total: 3 });
});

test("a page that redefines JSON.stringify and String.prototype.slice cannot pass the cap", async () => {
  // The serialiser runs on the page's builtins; the cut must not. Both are run here with the
  // builtins redefined the way a hostile page would, for as long as the call takes.
  const fn = (0, eval)(`(${wrapEvaluate("() => ({ a: 1 })", 1000)})`) as (
    el: unknown,
  ) => Promise<unknown>;
  const stringify = JSON.stringify;
  const slice = String.prototype.slice;
  let cut: string | null;
  try {
    JSON.stringify = (() => "x".repeat(5_000_000)) as typeof JSON.stringify;
    String.prototype.slice = function (this: string) {
      return String(this);
    };
    cut = cutSerialised(await fn(undefined), 1000);
  } finally {
    JSON.stringify = stringify;
    String.prototype.slice = slice;
  }
  const out = parseCut(cut, 1000);
  assert(out !== null);
  assertEquals(out.text.length, 1001);
  assertEquals(out.total, 5_000_000);
});

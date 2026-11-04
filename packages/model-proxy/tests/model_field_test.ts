// The byte walk that reads a request's model, held to `JSON.parse`: on every body, crafted or
// random, valid or broken, it must name exactly the model a parse would — a difference in either
// direction is the allowlist judging one model while the provider runs another.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { modelNamedIn } from "../src/core/model_field.ts";

const enc = new TextEncoder();

/** What a full parse names — the proxy's old reading, decode and all, except that bytes that are
 * not UTF-8 are refused rather than read as U+FFFD (see the walk's invariants). */
function parsed(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (!/^\s*\{/.test(text)) return null;
  try {
    const model = (JSON.parse(text) as { model?: unknown } | null)?.model;
    return typeof model === "string" && model !== "" ? model : null;
  } catch {
    return null;
  }
}

function same(body: string | Uint8Array, expected?: string | null) {
  const bytes = typeof body === "string" ? enc.encode(body) : body;
  const want = parsed(bytes);
  assertEquals(modelNamedIn(bytes), want, JSON.stringify(typeof body === "string" ? body : ""));
  if (expected !== undefined) assertEquals(want, expected);
}

test("the model of an ordinary request, wherever it sits", () => {
  same(`{"model":"claude-x","messages":[]}`, "claude-x");
  same(`{"messages":[{"role":"user","content":"hi"}],"model":"gpt-y"}`, "gpt-y");
  same(` \n\t{ "model" : "m" } \r\n`, "m");
  same(`{}`, null);
  same(`{"messages":[]}`, null);
});

test("only a top-level model counts, never one nested in a value", () => {
  same(`{"metadata":{"model":"nested"},"messages":[]}`, null);
  same(`{"messages":[{"model":"in-array"}],"model":"top"}`, "top");
  same(`{"a":{"b":{"model":"deep"}},"model":"top"}`, "top");
  same(`{"a":"{\\"model\\":\\"in-a-string\\"}","b":1}`, null);
  same(`{"a":["\\"model\\": \\"x\\""],"model":"real"}`, "real");
});

test("escapes in strings and keys are read as a parse reads them", () => {
  same(`{"mod\\u0065l":"escaped-key"}`, "escaped-key");
  same(`{"model":"a\\"b\\\\c\\/d\\n"}`, 'a"b\\c/d\n');
  same(`{"model":"\\u00e9t\\u00e9"}`, "été");
  same(`{"model":"\\ud83d\\ude00"}`, "😀");
  same(`{"model":"\\ud800"}`);
  same(`{"note":"a \\"quoted\\" \\\\\\" tricky \\\\","model":"after-escapes"}`, "after-escapes");
  same(`{"model":"ünïcödé-模型"}`, "ünïcödé-模型");
});

test("the last top-level model wins, as it does in a parse", () => {
  same(`{"model":"first","model":"second"}`, "second");
  same(`{"model":"allowed","messages":[],"model":"forbidden"}`, "forbidden");
  same(`{"model":"allowed","model":1}`, null);
  same(`{"model":"allowed","model":null}`, null);
  same(`{"model":1,"model":"late"}`, "late");
});

test("a model that is not a non-empty string is no model", () => {
  for (const v of [`""`, `1`, `-0.5e+3`, `true`, `false`, `null`, `{}`, `[]`, `["m"]`]) {
    same(`{"model":${v}}`, null);
  }
});

test("a body a parse refuses names no model, however it starts", () => {
  for (
    const body of [
      `{"model":"m"`,
      `{"model":"m",}`,
      `{"model":"m"} x`,
      `{"model":"m"}{}`,
      `{"model" "m"}`,
      `{model:"m"}`,
      `{"model":'m'}`,
      `{"model":"m","x":01}`,
      `{"model":"m","x":1.}`,
      `{"model":"m","x":.5}`,
      `{"model":"m","x":1e}`,
      `{"model":"m","x":+1}`,
      `{"model":"m","x":NaN}`,
      `{"model":"m","x":tru}`,
      `{"model":"m","x":[1,]}`,
      `{"model":"m","x":[1 2]}`,
      `{"model":"m","x":{"a"}}`,
      `{"model":"m","x":{"a":1,}}`,
      `{"model":"m","x":[}`,
      `{"model":"m","x":{]}`,
      `{"model":"a\\x"}`,
      `{"model":"a\\u12g4"}`,
      `{"model":"tab\there"}`,
      `{"model":"m","x":"unterminated}`,
      `["model","m"]`,
      `"model"`,
      ``,
      ` {"model":"m"}`,
    ]
  ) {
    same(body, null);
  }
});

test("a byte order mark is skipped, as decoding drops it", () => {
  same(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode(`{"model":"bom"}`)]), "bom");
});

test("a body that is not UTF-8 names no model, wherever the bad bytes sit", () => {
  const body = (...parts: (string | number[])[]) =>
    new Uint8Array(parts.flatMap((p) => typeof p === "string" ? [...enc.encode(p)] : p));
  // An overlong `e` (c1 a5) in a second key: read lossily it is `mod\uFFFD\uFFFDl` and the model
  // is `allowed`; read carelessly it is `model`, and the last one wins.
  same(body(`{"model":"allowed","mod`, [0xc1, 0xa5], `l":"forbidden"}`), null);
  // Bad bytes anywhere in any string, a model's or a buried one's.
  same(body(`{"model":"a`, [0xff, 0xfe], `b"}`), null);
  same(body(`{"model":"ok","x":["`, [0xc3], `"]}`), null);
  // Encoded surrogates, past U+10FFFF, other overlongs, a sequence cut short by the quote.
  for (
    const bad of [
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xf5, 0x80, 0x80, 0x80],
      [0xe0, 0x80, 0xaf],
      [0xf0, 0x80, 0x80, 0xaf],
      [0xc0, 0xaf],
      [0x80],
      [0xe2, 0x82],
    ]
  ) {
    same(body(`{"model":"ok","x":"`, bad, `"}`), null);
  }
  // Every well-formed width, up to U+10FFFF, is read; and a lone surrogate ESCAPE is JSON.
  same(
    body(`{"x":"`, [0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf4, 0x8f, 0xbf, 0xbf], `","model":"ok"}`),
    "ok",
  );
  same(`{"model":"é😀","x":"\\ud800"}`, "é😀");
});

test("deep nesting is walked, not recursed", () => {
  const depth = 200_000;
  same(`{"x":${"[".repeat(depth)}${"]".repeat(depth)},"model":"deep-ok"}`, "deep-ok");
  same(`{"x":${"[".repeat(depth)}}`, null);
});

test("a body of nothing but brackets costs a bit a level, not a word", () => {
  const body = new Uint8Array(64 * 1024 * 1024).fill(0x5b);
  body.set(enc.encode(`{"x":`));
  const before = process.memoryUsage().rss;
  assertEquals(modelNamedIn(body), null);
  const grown = process.memoryUsage().rss - before;
  // An array of the 64 Mi open brackets was a gigabyte; the bits are 8 MiB.
  assertEquals(grown < 256 * 1024 * 1024, true, `rss grew ${grown} bytes`);
});

test("a 30 MB image turn is read without trouble", () => {
  const image = "A".repeat(30 * 1024 * 1024);
  const body = enc.encode(
    `{"model":"vision","messages":[{"role":"user","content":[{"type":"image","source":` +
      `{"type":"base64","media_type":"image/png","data":"${image}"}}]}]}`,
  );
  assertEquals(modelNamedIn(body), "vision");
});

// ── random documents, against the parse ──────────────────────────────────────────────────

/** A small deterministic generator, so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const PIECES = [
  "model",
  "mod\\u0065l",
  "m",
  "",
  'a\\"b',
  "\\\\",
  "é",
  "😀",
  "\\ud83d",
  "{",
  "}",
  "[",
  ",",
  ":",
  "model\\n",
];

function randomString(r: () => number): string {
  let out = "";
  const n = Math.floor(r() * 4);
  for (let k = 0; k < n; k++) out += PIECES[Math.floor(r() * PIECES.length)];
  return `"${out}"`;
}

function randomValue(r: () => number, depth: number): string {
  const pick = r();
  if (depth > 4 || pick < 0.35) {
    const scalars = ["1", "-0", "2.5e-3", "true", "false", "null", randomString(r)];
    return scalars[Math.floor(r() * scalars.length)];
  }
  if (pick < 0.65) {
    const n = Math.floor(r() * 4);
    return `[${Array.from({ length: n }, () => randomValue(r, depth + 1)).join(",")}]`;
  }
  const n = Math.floor(r() * 4);
  return `{${
    Array.from({ length: n }, () => `${randomKey(r)}:${randomValue(r, depth + 1)}`).join(",")
  }}`;
}

function randomKey(r: () => number): string {
  const keys = [`"model"`, `"mod\\u0065l"`, `"messages"`, `"x"`, randomString(r)];
  return keys[Math.floor(r() * keys.length)];
}

/** A random document, sometimes broken by one byte. */
function randomBody(r: () => number): string {
  const n = Math.floor(r() * 5);
  // Top-level members, a string-valued `model` among them more often than chance would put it.
  const member = () =>
    r() < 0.4
      ? `${r() < 0.5 ? `"model"` : `"mod\\u0065l"`}:${randomString(r)}`
      : `${randomKey(r)} : ${randomValue(r, 0)}`;
  let body = `{${Array.from({ length: n }, member).join(" , ")}}`;
  if (r() < 0.3) {
    const at = Math.floor(r() * body.length);
    const junk = [`"`, `\\`, `,`, `]`, `}`, `{`, ` `, `x`, ``][Math.floor(r() * 9)];
    body = body.slice(0, at) + junk + body.slice(at + (r() < 0.5 ? 1 : 0));
  }
  return body;
}

test("on thousands of random documents, valid and broken, the walk names what a parse names", () => {
  const r = rng(20261004);
  let named = 0;
  let broken = 0;
  for (let k = 0; k < 20_000; k++) {
    const body = randomBody(r);
    same(body);
    if (parsed(enc.encode(body)) !== null) named += 1;
    try {
      JSON.parse(body);
    } catch {
      broken += 1;
    }
  }
  // The sample exercises both answers, and broken bodies, in earnest.
  assertEquals(named > 1_000 && broken > 1_000, true, JSON.stringify({ named, broken }));
});

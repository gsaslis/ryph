// The judge's answer parsing: strict on what it may name and what it may call a kind, tolerant
// of prose and fences around the JSON.

import { test } from "bun:test";
import { assertEquals, assertThrows } from "@std/assert";
import {
  extractJson,
  type JudgeInput,
  parseVerdict,
  renderJudgePrompt,
} from "../src/core/judge.ts";
import { memory } from "./fixtures.ts";

const input: JudgeInput = {
  text: "tests are vitest",
  kindHint: null,
  subject: "repo",
  hasRepo: true,
  supersedes: null,
  candidates: [memory({ id: "mem-a", text: "Tests are mocha" })],
};

test("extractJson tolerates fences and prose", () => {
  assertEquals(extractJson('Sure!\n```json\n{"a": 1}\n```\n'), { a: 1 });
  assertThrows(() => extractJson("no json here"));
});

test("a verdict may only name a candidate, and a rewrite must fit the bound", () => {
  assertEquals(
    parseVerdict(JSON.stringify({ verdict: "duplicate", of: "mem-a" }), input),
    { kind: "duplicate", of: "mem-a", reason: "" },
  );
  assertThrows(() => parseVerdict(JSON.stringify({ verdict: "duplicate", of: "mem-z" }), input));
  assertThrows(() => parseVerdict(JSON.stringify({ verdict: "supersedes", of: "mem-a" }), input));
  assertThrows(() =>
    parseVerdict(JSON.stringify({ verdict: "new", text: "x".repeat(501), kind: "fact" }), input)
  );
  assertThrows(() =>
    parseVerdict(JSON.stringify({ verdict: "new", text: "ok", kind: "rumour" }), input)
  );
  // noise may name nothing, or a candidate; an unknown name is dropped rather than refused
  assertEquals(
    parseVerdict(JSON.stringify({ verdict: "noise", of: "mem-z", reason: "meh" }), input),
    { kind: "noise", of: null, reason: "meh" },
  );
});

test("a repo subject is impossible for a run without one; the kind hint is the fallback", () => {
  const v = parseVerdict(
    JSON.stringify({ verdict: "new", text: "A claim.", subject: "repo" }),
    { ...input, hasRepo: false, subject: "org", kindHint: "gotcha" },
  );
  assertEquals(v, {
    kind: "new",
    text: "A claim.",
    memoryKind: "gotcha",
    subject: "org",
    reason: "",
  });
});

test("the prompt names the candidates and the replaced memory", () => {
  const prompt = renderJudgePrompt({ ...input, supersedes: "mem-a" });
  assertEquals(prompt.includes("[mem-a] (procedure) Tests are mocha"), true);
  assertEquals(prompt.includes("REPLACEMENT for memory mem-a"), true);
  assertEquals(renderJudgePrompt({ ...input, candidates: [] }).includes("none."), true);
});

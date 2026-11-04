import { test } from "bun:test";
import { assertEquals, assertThrows } from "@std/assert";
import { FIXTURES } from "../src/fixtures.ts";
import { fingerprint, PRESETS, resolve } from "../src/resolve.ts";
import { historyStories, STORIES } from "../src/stories.ts";

const names = (preset: string, w: string[] = [], wo: string[] = []) =>
  resolve(FIXTURES, preset, w, wo).map((r) => r.param === null ? r.name : `${r.name}=${r.param}`);

test("every fixture comes after what it needs", () => {
  const seen = new Set<string>();
  for (const f of FIXTURES) {
    for (const need of f.needs) assertEquals(seen.has(need), true, `${f.name} needs ${need}`);
    seen.add(f.name);
  }
});

test("every preset resolves", () => {
  for (const preset of Object.keys(PRESETS)) resolve(FIXTURES, preset, [], []);
});

test("ui keeps a small curated history; full retains all stories", () => {
  assertEquals(names("ui").includes("history=3"), true);
  assertEquals(names("full").includes(`history=${STORIES.length}`), true);
  assertEquals(names("minimal").some((name) => name.startsWith("history")), false);
  const small = historyStories(3);
  assertEquals(small.map((story) => story.key), [
    "bounded-retries",
    "empty-state",
    "stripe-version",
  ]);
  assertEquals(small.map((story) => story.patch), ["approve", "pending", undefined]);
  assertEquals(historyStories(0), []);
  assertEquals(
    new Set(historyStories(STORIES.length).map((story) => story.key)).size,
    STORIES.length,
  );
  assertEquals(historyStories(STORIES.length + 1).at(-1), small[0]);
  assertEquals(names("ui", [], ["history"]).some((name) => name.startsWith("history")), false);
  assertEquals(
    fingerprint(resolve(FIXTURES, "ui", [], []), FIXTURES) ===
      fingerprint(resolve(FIXTURES, "full", [], []), FIXTURES),
    false,
  );
});

test("--with brings in what a fixture needs, in order", () => {
  assertEquals(names("empty", ["history=3"]), ["owner", "model", "repos", "agents", "history=3"]);
});

test("--with sets a number on a fixture the preset already has", () => {
  assertEquals(names("ui", ["history=40"]).includes("history=40"), true);
});

test("--without removes, and refuses to remove a need", () => {
  assertEquals(names("ui", [], ["live", "waiting"]).includes("live"), false);
  assertThrows(() => names("ui", [], ["agents"]), Error, "needs agents");
});

test("unknown names and numbers on plain fixtures are refused", () => {
  assertThrows(() => names("nope"), Error, "no preset");
  assertThrows(() => names("ui", ["nope"]), Error, "no fixture");
  assertThrows(() => names("ui", ["owner=2"]), Error, "takes no number");
});

test("the fingerprint ignores live fixtures", () => {
  const a = fingerprint(resolve(FIXTURES, "ui", [], []), FIXTURES);
  const b = fingerprint(resolve(FIXTURES, "ui", [], ["live", "waiting"]), FIXTURES);
  assertEquals(a, b);
});

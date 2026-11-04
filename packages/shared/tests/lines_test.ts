// The line rule, pure (src/lines.ts): which names are lines, the branch a line ships as in each
// generation, which branches parse back to a line, where a line's bundle is filed, and how a
// local branch the agent named maps to one.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  DEFAULT_LINE,
  isLineName,
  lineBranch,
  lineOfBranch,
  MAX_LINES_PER_REPO,
  parseLineBranch,
  runBundleKey,
} from "../src/lines.ts";

const NS = "ryph/ada/r-01";

test("lines: the default line and the cap", () => {
  assertEquals(DEFAULT_LINE, "work");
  assertEquals(isLineName(DEFAULT_LINE), true);
  assertEquals(MAX_LINES_PER_REPO, 8);
});

test("lines: a line name is short lowercase, no double dash, no generation-looking suffix", () => {
  for (const ok of ["work", "fix-login", "a", "v2", "0day", "a-b-c", "x".repeat(40)]) {
    assertEquals(isLineName(ok), true, ok);
  }
  for (
    const bad of [
      "",
      "-fix",
      "Fix",
      "fix_login",
      "fix--login",
      "fix-2",
      "fix-10",
      "a/b",
      "x".repeat(41),
      "fix.",
    ]
  ) {
    assertEquals(isLineName(bad), false, bad);
  }
});

test("lines: a line's branch, and its later generations", () => {
  assertEquals(lineBranch(NS, "work", 1), `${NS}/work`);
  assertEquals(lineBranch(NS, "fix", 2), `${NS}/fix-2`);
  assertEquals(lineBranch(NS, "fix", 12), `${NS}/fix-12`);
});

test("lines: a branch parses to one (line, generation) or to nothing", () => {
  assertEquals(parseLineBranch(`${NS}/work`, NS), { line: "work", generation: 1 });
  assertEquals(parseLineBranch(`refs/heads/${NS}/fix-3`, NS), { line: "fix", generation: 3 });
  // `-1` is never a generation, and a line cannot be spelled with one.
  assertEquals(parseLineBranch(`${NS}/fix-1`, NS), null);
  assertEquals(parseLineBranch(`${NS}/fix-01`, NS), null);
  assertEquals(parseLineBranch(NS, NS), null);
  assertEquals(parseLineBranch(`${NS}/a/b`, NS), null);
  assertEquals(parseLineBranch(`${NS}x/work`, NS), null);
  assertEquals(parseLineBranch("main", NS), null);
});

test("lines: the run's own branch maps to its line, any other to its slug", () => {
  assertEquals(lineOfBranch(NS, `${NS}/work`), { line: "work" });
  assertEquals(lineOfBranch(NS, `${NS}/fix-login`), { line: "fix-login" });
  assertEquals(lineOfBranch(NS, "fix-login"), { line: "fix-login" });
  assertEquals(lineOfBranch(NS, "Fix_Login"), { line: "fix-login" });
  assertEquals(lineOfBranch(NS, "feature/Fix  the--Login!"), { line: "feature-fix-the-login" });
  assertEquals(lineOfBranch(NS, "--x--"), { line: "x" });
  assertEquals(lineOfBranch(NS, "y".repeat(39) + "-tail"), { line: "y".repeat(39) });
});

test("lines: a mapping is refused rather than bent into another name", () => {
  for (
    const branch of [
      `${NS}/work-2`, // a generation: the platform's to start
      `${NS}/a/b`,
      `${NS}/Fix`,
      "release-2",
      "v1.2-3",
      "___",
    ]
  ) {
    const mapped = lineOfBranch(NS, branch);
    assertEquals("refused" in mapped, true, `${branch}: ${JSON.stringify(mapped)}`);
  }
});

test("isLineName: lowercase, digits and single hyphens, ≤ 40, never a generation suffix", () => {
  const cases: Array<[string, boolean]> = [
    ["work", true],
    ["fix-a", true],
    ["v2", true],
    ["123", true],
    ["a".repeat(40), true],
    ["a".repeat(41), false],
    ["", false],
    ["Bad", false],
    ["-a", false],
    ["fix--a", false],
    ["fix-a-1", false], // reads as a generation
    ["fix-a-2", false],
    ["a/b", false],
    ["fix_a", false],
    ["fix.a", false],
  ];
  for (const [name, expected] of cases) assertEquals(isLineName(name), expected, name);
});

test("parseLineBranch: (line, generation) under the namespace, or null — lineBranch's inverse", () => {
  const ns = "ryph/ada/r-1";
  assertEquals(parseLineBranch(`${ns}/work`, ns), { line: "work", generation: 1 });
  assertEquals(parseLineBranch(`refs/heads/${ns}/fix-a`, ns), { line: "fix-a", generation: 1 });
  assertEquals(parseLineBranch(`${ns}/fix-a-2`, ns), { line: "fix-a", generation: 2 });
  assertEquals(parseLineBranch(`${ns}/fix-a-13`, ns), { line: "fix-a", generation: 13 });
  assertEquals(parseLineBranch(`${ns}/v2-3`, ns), { line: "v2", generation: 3 });
  for (
    const branch of [
      ns,
      `${ns}/`,
      `${ns}/fix-a-1`,
      `${ns}/fix-a-0`,
      `${ns}/fix-a-02`,
      `${ns}/Bad`,
      `${ns}/a/b`,
      `${ns}/fix--a`,
      `${ns}/a-2-2`,
      `${ns}-2/work`,
      "ryph/ada/r-12/work",
      "main",
    ]
  ) assertEquals(parseLineBranch(branch, ns), null, branch);
  for (const [line, generation] of [["work", 1], ["fix-a", 2], ["v2", 7]] as const) {
    const branch = lineBranch(ns, line, generation);
    assertEquals(parseLineBranch(branch, ns), { line, generation }, branch);
  }
  assertEquals(lineBranch(ns, "work", 1), `${ns}/work`);
  assertEquals(lineBranch(ns, "work", 2), `${ns}/work-2`);
});

test("runBundleKey: the forge's key for a line's bundle, the same rule", () => {
  const head = "a".repeat(40);
  assertEquals(
    runBundleKey("r-1", "cr-1", { line: "work", generation: 1 }, head),
    `r-1/work/cr-1/${head}.bundle`,
  );
  assertEquals(
    runBundleKey("r-1", "cr-1", { line: "fix-a", generation: 2 }, head),
    `r-1/fix-a-2/cr-1/${head}.bundle`,
  );
});

// The checks declaration, as a pure function: YAML in, a declaration or a refusal a repo author
// can act on. This file IS the specification of `.ryph/checks.yml`, beside the two readings of a
// change's paths a settled suite makes, and the ref the declaration is read on.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  changedPathsFromLog,
  globMatcher,
  parseChecksYaml,
  parseDuration,
  unquoteC,
  watchedChanged,
  watchedChangedByCheck,
} from "../src/helpers/checks.ts";
import { parseLineBranch } from "@ryph/shared/lines";
import { checksRef } from "../src/core/checks.ts";
import {
  checkExternalId,
  keepOf,
  MAX_OWN_PODS,
  parseCheckExternalId,
} from "../src/core/check_types.ts";
import type { ConnectedRepo } from "../src/core/types.ts";

/** `fn`'s result and the CPU milliseconds this process spent on it. What a bound on work bounds
 * is CPU: a check runs under its share of a loaded pod's CPU and is descheduled for whole
 * periods, so the wall clock there runs several times what the work took. */
function cpuTimed<T>(fn: () => T): { value: T; ms: number } {
  const before = process.cpuUsage();
  const value = fn();
  const { user, system } = process.cpuUsage(before);
  return { value, ms: (user + system) / 1000 };
}

const EXAMPLE = `# .ryph/checks.yml
setup:
  - run: deno install --frozen
checks:
  - name: lint
    run: deno lint && deno fmt --check
  - name: test
    run: deno task test
    timeout: 20m
    watch: [deno.json, "**/*_test.ts", "tests/**"]
  - name: e2e
    run: deno task e2e
    services: [postgres]
`;

test("a full example parses whole", () => {
  assertEquals(parseChecksYaml(EXAMPLE), {
    setup: [{ run: "deno install --frozen" }],
    checks: [
      {
        name: "lint",
        run: "deno lint && deno fmt --check",
        timeoutSeconds: null,
        services: [],
        watch: [],
      },
      {
        name: "test",
        run: "deno task test",
        timeoutSeconds: 1200,
        services: [],
        watch: ["deno.json", "**/*_test.ts", "tests/**"],
      },
      {
        name: "e2e",
        run: "deno task e2e",
        timeoutSeconds: null,
        services: ["postgres"],
        watch: [],
      },
    ],
  });
});

test("an empty, comments-only or checks-less file is no checks, not an error", () => {
  for (const text of ["", "# nothing yet\n", "checks:\n", "checks: []\n", "setup: []\n"]) {
    assertEquals(parseChecksYaml(text), { setup: [], checks: [] }, JSON.stringify(text));
  }
});

test("what a checks file refuses, and says so for the repo's author", () => {
  const cases: Array<[string, string]> = [
    ["checks:\n  - name: a\n    run: x\n    env: {A: b}\n", "unknown key `env`"],
    ["jobs: []\n", "unknown key `jobs`"],
    ["checks:\n  - name: Lint\n    run: x\n", "lowercase letters"],
    ["checks:\n  - name: -lint\n    run: x\n", "lowercase letters"],
    [`checks:\n  - name: ${"a".repeat(41)}\n    run: x\n`, "at most 40"],
    ["checks:\n  - name: a\n", "checks.a.run: required"],
    ["checks:\n  - name: a\n    run: '  '\n", "required"],
    ["checks:\n  - name: a\n    run: x\n  - name: a\n    run: y\n", "declared twice"],
    ["checks:\n  - name: a\n    run: x\n    timeout: soon\n", "a duration like"],
    ["checks:\n  - name: a\n    run: x\n    timeout: 25h\n", "at most 24h"],
    ["checks:\n  - name: a\n    run: x\n    timeout: -5\n", "a duration like"],
    ["checks:\n  - name: a\n    run: x\n    services: postgres\n", "a list of names"],
    ["checks:\n  - name: a\n    run: x\n    services: [Postgres]\n", "a service name"],
    ["checks:\n  - name: a\n    run: x\n    watch: [/etc/passwd]\n", "relative to the repo root"],
    ["checks:\n  - name: a\n    run: x\n    watch: ['../up']\n", "relative to the repo root"],
    ["setup:\n  - run: x\n    name: y\n", "a step has only `run`"],
    ["setup: npm ci\n", "`setup` must be a list"],
    ["checks: {a: b}\n", "`checks` must be a list"],
    ["- a\n- b\n", "top level must be a mapping"],
    ["checks:\n  - &c\n    name: a\n    run: x\n  - *c\n", "anchors and aliases"],
    ["checks: [\n", "not valid YAML"],
    [`checks:\n  - name: a\n    run: ${"x".repeat(4_001)}\n`, "exceeds 4000"],
    [
      `checks:\n${Array.from({ length: 33 }, (_, i) => `  - name: c${i}\n    run: x\n`).join("")}`,
      "exceeds the limit of 32",
    ],
    [`setup:\n${"  - run: x\n".repeat(17)}`, "exceeds the limit of 16"],
    ["keep: node_modules\n", "`keep` must be a list"],
    ["keep: ['../up']\n", "a gitignore-style pattern"],
    ["keep: ['a/../b']\n", "a gitignore-style pattern"],
    ["keep: ['!dist']\n", "a gitignore-style pattern"],
    ["keep: ['']\n", "a gitignore-style pattern"],
    ["keep: [3]\n", "a gitignore-style pattern"],
    [`keep: ['${"x".repeat(201)}']\n`, "a gitignore-style pattern"],
    [`keep: [${Array.from({ length: 33 }, (_, i) => `k${i}`).join(", ")}]\n`, "exceeds 32"],
  ];
  for (const [text, fragment] of cases) {
    const err = assertThrows(() => parseChecksYaml(text), Error);
    assertStringIncludes(err.message, fragment, text);
  }
});

test("pod: own runs a check alone, with a size class only beside it", () => {
  const parsed = parseChecksYaml(`checks:
  - name: lint
    run: x
  - name: orchestrator
    run: y
    pod: own
  - name: e2e
    run: z
    pod: own
    size: large
`);
  assertEquals(
    parsed.checks.map((c) => [c.name, c.pod, c.size]),
    [["lint", undefined, undefined], ["orchestrator", "own", undefined], ["e2e", "own", "large"]],
  );
  // Absent keys are absent, not null: a declaration without them is what it always was.
  assert(!("pod" in parsed.checks[0]) && !("size" in parsed.checks[0]));
  assert(!("size" in parsed.checks[1]));
  // Whether the deployment defines the class is the launch's to say, not the parser's.
  assertEquals(
    parseChecksYaml("checks:\n  - name: a\n    run: x\n    pod: own\n    size: galactic\n")
      .checks[0].size,
    "galactic",
  );
  const cases: Array<[string, string]> = [
    ["checks:\n  - name: a\n    run: x\n    size: large\n", "checks.a.size: only with `pod: own`"],
    ["checks:\n  - name: a\n    run: x\n    pod: shared\n", "checks.a.pod: `own`"],
    ["checks:\n  - name: a\n    run: x\n    pod: true\n", "checks.a.pod: `own`"],
    ["checks:\n  - name: a\n    run: x\n    pod: [own]\n", "checks.a.pod: `own`"],
    [
      "checks:\n  - name: a\n    run: x\n    pod: own\n    size: Large\n",
      "checks.a.size: the name of one of the deployment's size classes",
    ],
    [
      "checks:\n  - name: a\n    run: x\n    pod: own\n    size: 16\n",
      "checks.a.size: the name of one of the deployment's size classes",
    ],
    [
      `checks:\n  - name: a\n    run: x\n    pod: own\n    size: ${"x".repeat(33)}\n`,
      "at most 32 characters",
    ],
  ];
  for (const [text, fragment] of cases) {
    const err = assertThrows(() => parseChecksYaml(text), Error);
    assertStringIncludes(err.message, fragment, text);
  }
});

test("at most three checks may run in pods of their own", () => {
  const owns = (n: number) =>
    `checks:\n  - name: lint\n    run: x\n${
      Array.from({ length: n }, (_, i) => `  - name: c${i}\n    run: x\n    pod: own\n`).join("")
    }`;
  assertEquals(
    parseChecksYaml(owns(MAX_OWN_PODS)).checks.filter((c) => c.pod === "own").length,
    MAX_OWN_PODS,
  );
  const err = assertThrows(() => parseChecksYaml(owns(MAX_OWN_PODS + 1)), Error);
  assertStringIncludes(err.message, "checks: 4 checks declare `pod: own`, and at most 3 may");
  assertStringIncludes(err.message, "take a slot of RYPH_CHECKS_CONCURRENCY");
});

test("keep: absent is the default list, declared replaces it, [] keeps nothing", () => {
  const checks = "checks:\n  - name: a\n    run: x\n";
  const absent = parseChecksYaml(checks);
  assertEquals(absent.keep, undefined);
  assertEquals(keepOf(absent), ["node_modules", "target", ".venv"]);
  const declared = parseChecksYaml(`keep: [/target, "dist cache", .cache/**]\n${checks}`);
  assertEquals(keepOf(declared), ["/target", "dist cache", ".cache/**"]);
  assertEquals(keepOf(parseChecksYaml(`keep: []\n${checks}`)), []);
});

test("a timeout is a duration or whole seconds; the policy caps it later, not the parser", () => {
  assertEquals(parseDuration("90s"), 90);
  assertEquals(parseDuration("20m"), 1200);
  assertEquals(parseDuration("1h"), 3600);
  assertEquals(parseDuration("1.5h"), null);
  assertEquals(parseDuration("0s"), null);
  assertEquals(parseDuration("20"), null);
  const parsed = parseChecksYaml("checks:\n  - name: a\n    run: x\n    timeout: 300\n");
  assertEquals(parsed.checks[0].timeoutSeconds, 300);
});

test("a run line is carried verbatim — the control plane never interprets it", () => {
  const run = `set -e; echo "$HOME" && ls * | grep '&x' # not a comment to YAML`;
  const parsed = parseChecksYaml(`checks:\n  - name: a\n    run: ${JSON.stringify(run)}\n`);
  assertEquals(parsed.checks[0].run, run);
});

test("globs match whole paths: * stays in a directory, ** crosses them", () => {
  const m = globMatcher(["deno.json", "**/*_test.ts", "tests/**", "src/?.ts", "a/**/b/*.md"]);
  const yes = [
    "deno.json",
    "a_test.ts",
    "src/deep/x_test.ts",
    "tests/a/b.txt",
    "src/a.ts",
    "a/b/c.md",
    "a/x/y/b/c.md",
  ];
  const no = ["pkg/deno.json", "src/deep/x.ts", "tests", "src/ab.ts", "deno.jsonc", "a/b/c/d.md"];
  for (const path of yes) assertEquals(m(path), true, path);
  for (const path of no) assertEquals(m(path), false, path);
  assertEquals(globMatcher([])("anything"), false);
  // Regex metacharacters in a glob are literal.
  assertEquals(globMatcher(["a+b.(c)"])("a+b.(c)"), true);
  assertEquals(globMatcher(["a+b.(c)"])("aab.(c)"), false);
  assertEquals(globMatcher(["**"])("x/y"), true);
});

test("a head's paths cannot make matching slow: a table, never a backtracking regex", () => {
  // Took over 300 s as a RegExp: the head names the paths, the base names the globs.
  const { ms } = cpuTimed(() => {
    const m = globMatcher(["**/*.*.*.*.ts", "**/*a*a*a*a*a*a*a*b"]);
    const dots = `src/${".".repeat(250)}/x${".".repeat(250)}`;
    const as = `${"a/".repeat(100)}${"a".repeat(400)}`;
    assertEquals(m(dots), false);
    assertEquals(m(as), false);
    for (let i = 0; i < 5000; i++) m(`${dots}${i}`);
  });
  assert(ms < 5_000, `took ${Math.round(ms)} ms of CPU`);
});

test("a watch glob: ** is a whole segment, and wildcards are bounded", () => {
  const watch = (globs: string[]) =>
    parseChecksYaml(
      `checks:\n  - name: a\n    run: x\n    watch: ${JSON.stringify(globs)}\n`,
    ).checks[0].watch;
  assertEquals(watch(["**/deno.json", "tests/**", "a/**/b"]), [
    "**/deno.json",
    "tests/**",
    "a/**/b",
  ]);
  assertThrows(() => watch(["**.ts"]), Error, "whole path segment");
  assertThrows(() => watch(["src/a**"]), Error, "whole path segment");
  assertThrows(() => watch(["*.?".repeat(9)]), Error, "wildcards");
});

test("watched paths: the check's globs and .ryph/** always; unknown stays unknown", () => {
  const all = (paths: string[]) => ({ paths, complete: true });
  assertEquals(watchedChanged(all(["src/a.ts"]), ["deno.json"]), false);
  assertEquals(watchedChanged(all(["src/a.ts", "deno.json"]), ["deno.json"]), true);
  assertEquals(watchedChanged(all([".ryph/checks.yml"]), []), true);
  assertEquals(watchedChanged(all([]), ["**"]), false);
  assertEquals(watchedChanged(null, ["deno.json"]), null);
  // A list cut short: a match is still a match, no match is not knowable.
  assertEquals(watchedChanged({ paths: ["deno.json"], complete: false }, ["deno.json"]), true);
  assertEquals(watchedChanged({ paths: ["src/a.ts"], complete: false }, ["deno.json"]), null);
  // A path too long to match makes a "no" unknown, never a "yes" a "no".
  const long = `x/${"y".repeat(2000)}`;
  assertEquals(watchedChanged(all([long]), ["deno.json"]), null);
  assertEquals(watchedChanged(all([long, "deno.json"]), ["deno.json"]), true);
});

test("every check's watch is answered from one pass over the paths", () => {
  const all = (paths: string[]) => ({ paths, complete: true });
  assertEquals(
    watchedChangedByCheck(all(["src/a.ts", "deno.json"]), [["deno.json"], ["*.lock"], []]),
    { checks: [true, false, false], ryph: false },
  );
  assertEquals(
    watchedChangedByCheck(all([".ryph/setup.yml"]), [["deno.json"], []]),
    { checks: [true, true], ryph: true },
    ".ryph/** is every check's",
  );
  assertEquals(watchedChangedByCheck(null, [["a"], ["b"]]), {
    checks: [null, null],
    ryph: null,
  });
  // A path too deep to match: a "no" becomes unknown, a "yes" found elsewhere stands.
  const deep = `${"d/".repeat(64)}x`;
  assertEquals(
    watchedChangedByCheck(all([deep, "deno.json"]), [["deno.json"], ["**/x"]]),
    { checks: [true, null], ryph: null },
  );
});

test("matching a head's paths is bounded: too deep is unknown, and so is past the budget", () => {
  // Each took seconds per glob: the head chooses how many paths, and how deep. The bound is the
  // matcher's cell budget, not a clock, so the times asserted here are loose and in CPU, not wall
  // clock: what they catch is an unbounded matcher (about 70s for the second case), not a loaded
  // runner that descheduled the test (tens of milliseconds of CPU each, seconds of wall clock).
  const deep = Array.from({ length: 4000 }, (_, i) => `${"a/".repeat(499)}b${i}`);
  const globs = ["**/x/**/y", "**/a/**/c", "a/**/a/**/z", "**/*.ts", "**/q/**"];
  const tooDeep = cpuTimed(() => watchedChangedByCheck({ paths: deep, complete: true }, [globs]));
  assertEquals(tooDeep.value, { checks: [null], ryph: null });
  assert(
    tooDeep.ms < 1_000,
    `4000 paths of 500 segments took ${Math.round(tooDeep.ms)} ms of CPU`,
  );

  // Within the caps, but 32 checks of 32 globs each over 5000 paths of 64 segments.
  const wide = Array.from({ length: 5000 }, (_, i) => `${"a/".repeat(63)}b${i}`);
  const watches = Array.from(
    { length: 32 },
    (_, c) => Array.from({ length: 32 }, (_, g) => `**/a/**/a*a*a/**/c${c}-${g}`),
  );
  const pastBudget = cpuTimed(() =>
    watchedChangedByCheck({ paths: wide, complete: true }, watches)
  );
  assertEquals(pastBudget.value.checks.every((a) => a === null), true, "past the budget: unknown");
  assert(
    pastBudget.ms < 5_000,
    `32×32 globs over 5000 deep paths took ${Math.round(pastBudget.ms)} ms of CPU`,
  );

  // A match found before the budget ran out still stands.
  const found = watchedChangedByCheck(
    { paths: ["deno.json", ...wide], complete: true },
    [["deno.json"], ...watches],
  );
  assertEquals(found.checks[0], true);
  assertEquals(found.checks[1], null);
});

test("a path git quoted is unquoted; one that does not unquote makes the list unknown", () => {
  assertEquals(unquoteC('"a"b"'), null, "an unescaped quote inside");
  assertEquals(unquoteC('"back\\\\slash"'), "back\\slash");
  assertEquals(unquoteC('"q\\"uote"'), 'q"uote');
  assertEquals(unquoteC('"new\\nline\\ttab"'), "new\nline\ttab");
  assertEquals(unquoteC('"caf\\303\\251.ts"'), "café.ts", "octal bytes are UTF-8");
  assertEquals(unquoteC('"na\\303ve"'), null, "not UTF-8");
  assertEquals(unquoteC('"bad\\q"'), null, "no such escape");
  assertEquals(unquoteC('"end\\"'), null);
  assertEquals(unquoteC('"x'), null);
  const log = '@@ryph-changed "deno\\".json"\n@@ryph-changed "a\\tb.ts"\n' +
    "@@ryph-changed plain.ts\n@@ryph-changed-end 3\n";
  assertEquals(changedPathsFromLog(log), {
    paths: ['deno".json', "a\tb.ts", "plain.ts"],
    complete: true,
  });
  assertEquals(watchedChanged(changedPathsFromLog(log), ['deno".json']), true);
  assertEquals(
    changedPathsFromLog('@@ryph-changed "broken\\x"\n@@ryph-changed-end 1\n'),
    null,
  );
});

test("the clone step's changed-paths list is read from its log; anything short of it is unknown", () => {
  const log = "Cloning…\n@@ryph-changed src/a.ts\n@@ryph-changed .ryph/Dockerfile\r\n" +
    "@@ryph-changed-end 2\ndone\n";
  assertEquals(changedPathsFromLog(log), {
    paths: ["src/a.ts", ".ryph/Dockerfile"],
    complete: true,
  });
  assertEquals(changedPathsFromLog("@@ryph-changed-end 0\n"), { paths: [], complete: true });
  assertEquals(
    changedPathsFromLog(
      "@@ryph-changed a\n@@ryph-changed-truncated 5000\n@@ryph-changed-end 5000\n",
    ),
    { paths: ["a"], complete: false },
  );
  assertEquals(changedPathsFromLog("cloned\n@@ryph-changed a\n"), null, "no end line");
  assertEquals(changedPathsFromLog(null), null);
  assertEquals(changedPathsFromLog("@@ryph-changed-unknown base not fetched\n"), null);
  assertEquals(changedPathsFromLog("@@ryph-changed-unknown\n"), null);
});

test("a changed-paths list whose front was cut does not read as complete", () => {
  // The log is read from its end: a head with enough long paths pushes `.ryph/…` — which sorts
  // first — out of what is read. The count says so.
  const cut = "@@ryph-changed src/b.ts\n@@ryph-changed src/c.ts\n@@ryph-changed-end 3\n";
  assertEquals(changedPathsFromLog(cut), null);
  assertEquals(
    changedPathsFromLog("ged .ryph/x\n@@ryph-changed src/b.ts\n@@ryph-changed-end 2\n"),
    null,
  );
  assertEquals(
    changedPathsFromLog("@@ryph-changed a\n@@ryph-changed-end 0\n"),
    null,
    "more than n",
  );
  assertEquals(changedPathsFromLog("@@ryph-changed-end x\n"), null, "not a count");
  assertEquals(
    changedPathsFromLog("@@ryph-changed-end 0\n@@ryph-changed a\n"),
    null,
    "a path after the end",
  );
  assertEquals(
    changedPathsFromLog("@@ryph-changed-end 0\n@@ryph-changed-end 0\n"),
    null,
    "two ends",
  );
  assertEquals(
    changedPathsFromLog("@@ryph-changed a\n@@ryph-changed-truncated 1\n@@ryph-changed-end 1\n"),
    null,
    "truncated, yet whole",
  );
});

test("a candidate's branch must be a line of the run's namespace, or a later generation", () => {
  const ns = "ryph/ada/r1";
  // What `ryph__run_checks` holds a candidate's branch to (core/checks.ts `requestForRun`).
  const isRunOutputBranch = (branch: string, namespace: string) =>
    parseLineBranch(branch, namespace) !== null;
  assertEquals(isRunOutputBranch("ryph/ada/r1/work", ns), true);
  assertEquals(isRunOutputBranch("refs/heads/ryph/ada/r1/fix-a-2", ns), true);
  assertEquals(isRunOutputBranch("ryph/ada/r1", ns), false); // the bare namespace is no line
  assertEquals(isRunOutputBranch("ryph/ada/r1/work-1", ns), false);
  assertEquals(isRunOutputBranch("ryph/ada/r1/Bad", ns), false);
  assertEquals(isRunOutputBranch("ryph/ada/r1/a/b", ns), false);
  assertEquals(isRunOutputBranch("ryph/ada/r1-2/work", ns), false);
  assertEquals(isRunOutputBranch("main", ns), false);
});

test("the declaration is read on the change request's target, else the run's own base", () => {
  const repo = {
    url: "https://github.com/acme/api.git",
    defaultBranch: "main",
  } as ConnectedRepo;
  const url = repo.url;
  const cases: Array<[{ url: string; ref: string; targetRef?: string }, string]> = [
    // A fresh run: its own base branch.
    [{ url, ref: "main" }, "main"],
    [{ url, ref: "release/2" }, "release/2"],
    [{ url, ref: "refs/heads/release/2" }, "release/2"],
    // A PR run: the PR's base, never its head.
    [{ url, ref: "feat/x", targetRef: "main" }, "main"],
    [{ url, ref: "feat/x", targetRef: "refs/heads/develop" }, "develop"],
    // A foreign ref (a fork's PR head) or another URL: the default branch.
    [{ url, ref: "refs/pull/42/head" }, "main"],
    [{ url: "https://github.com/fork/api.git", ref: "feat/x" }, "main"],
  ];
  for (const [entry, want] of cases) {
    assertEquals(checksRef(repo, entry), want, JSON.stringify(entry));
  }
});

test("a check run's external id reads back for a suite id of either minted shape", () => {
  for (const id of ["cs-0123456789", "cs-01jb7k3m9x4q8zt2vw6hn5c0fe"]) {
    const externalId = checkExternalId({ id, generation: 3 }, "lint");
    assertEquals(parseCheckExternalId(externalId), { suiteId: id, generation: 3, check: "lint" });
  }
  for (const bad of ["cs-012345678:1:lint", "cs-01jb7k3m9x4q8zt2vw6hn5c0fe0:1:lint", "build-42"]) {
    assertEquals(parseCheckExternalId(bad), null, bad);
  }
});

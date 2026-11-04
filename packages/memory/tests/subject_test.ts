// What makes two spellings of a repository ONE subject — and what makes two repositories two.
//
// This is a boundary, not a formatting nicety: the repo subject is what keeps one agent's
// private notes out of a repository it is not working on, and what decides whether a note
// written against `https://github.com/Acme/App.git` is ever found again.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { canonicalRepo, matchRepo, repoLabel, resolveSubjectHint } from "../src/core/subject.ts";
import { renderIndexLine } from "../src/core/brief.ts";
import { SubjectSchema } from "../src/schema.ts";
import { renderDetail } from "../src/mcp/tools.ts";
import { memory } from "./fixtures.ts";

test("every spelling of one GitHub repository folds to one subject", () => {
  const one = "github.com/acme/app";
  assertEquals(canonicalRepo("https://github.com/Acme/App.git"), one);
  assertEquals(canonicalRepo("git@github.com:acme/app.git"), one);
  assertEquals(canonicalRepo("https://git@github.com/acme/app/"), one);
});

test("a Radicle id is a subject exactly as written, because case is meaning there", () => {
  // Base58: `z3gq…` and `z3GQ…` are different ids, and only one of them resolves to anything.
  // Lower-casing one produced an address no node could answer for AND merged two repositories
  // into one subject — the boundary failing open in both directions at once.
  const rid = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
  assertEquals(canonicalRepo(rid), rid);
  assertEquals(canonicalRepo(`  ${rid}  `), rid);
  const other = "rad:z3gqCJUoA1n9HaHKufZs5FCSGazv5";
  assertEquals(canonicalRepo(other) === canonicalRepo(rid), false);
});

test("a local repository's path is a subject exactly as written: case and .git are names there", () => {
  // The forge stores a local repo's real path, already canonical. On a case-sensitive disk two
  // spellings that differ in case, or by a `.git` suffix, are two repositories — folding them
  // would put one repository's notes in the other's reach.
  const path = "/Users/ada/code/Payments";
  assertEquals(canonicalRepo(path), path);
  assertEquals(canonicalRepo("/Users/ada/code/payments") === canonicalRepo(path), false);
  assertEquals(canonicalRepo("/srv/app.git"), "/srv/app.git");
  assertEquals(canonicalRepo("/srv/app.git") === canonicalRepo("/srv/app"), false);
  assertEquals(canonicalRepo("/srv/app "), "/srv/app ");
});

test("a repo subject on the wire keeps a local path whole and still trims a URL", () => {
  const parse = (url: string) => SubjectSchema.parse({ kind: "repo", url });
  assertEquals(parse("/srv/App.git "), { kind: "repo", url: "/srv/App.git " });
  assertEquals(parse("  https://github.com/Acme/App.git "), {
    kind: "repo",
    url: "github.com/acme/app",
  });
  assertEquals(SubjectSchema.safeParse({ kind: "repo", url: "   " }).success, false);
  // A local path is as long as the forge allows one, past any URL's bound.
  const long = `/${"a".repeat(4_000)}`;
  assertEquals(parse(long), { kind: "repo", url: long });
});

test("a local repository is named to a run by its folder, and answers to it", () => {
  const scope = { agentId: "a-1", repos: ["/Users/ada/Code/MyApp", "github.com/acme/api"] };
  assertEquals(repoLabel("/Users/ada/Code/MyApp"), "MyApp");
  assertEquals(repoLabel("github.com/acme/api"), "github.com/acme/api");
  assertEquals(matchRepo(scope, "MyApp"), "/Users/ada/Code/MyApp");
  assertEquals(matchRepo(scope, "myapp"), null);
  assertEquals(
    renderIndexLine({ kind: "repo", url: "/Users/ada/Code/MyApp" }, []).startsWith("repo MyApp:"),
    true,
  );
  const refused = resolveSubjectHint(scope, "repo", "nope");
  assertEquals(refused.kind === "none" && refused.reason.includes("/Users/ada"), false);
});

test("the get tool names a local repository's memory by its folder, never its path", () => {
  const detail = (url: string) =>
    renderDetail({
      memory: memory({ subject: { kind: "repo", url } }),
      feedback: [],
      supersedes: null,
      supersededBy: null,
      runs: [],
    }, new Date("2026-09-02T00:00:00.000Z"));
  const local = detail("/Users/ada/Code/MyApp");
  assertEquals(local.includes("/Users/ada"), false);
  assertEquals(local.split("\n").includes("subject: repo MyApp"), true);
  assertEquals(
    detail("github.com/acme/api").split("\n").includes("subject: repo github.com/acme/api"),
    true,
  );
});

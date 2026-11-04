// The run-facing name of a repository: a local repository's host path never reaches a run.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { runFacingRepoName, runFacingText } from "../src/core/forge_repo.ts";

test("a local repository is named by its folder; every other repo by its address", () => {
  assertEquals(
    runFacingRepoName({ provider: "local", repoRef: "/Users/ada/code/payments" }),
    "payments",
  );
  assertEquals(runFacingRepoName({ provider: "local", repoRef: "/srv/app " }), "app ");
  assertEquals(runFacingRepoName({ provider: "github", repoRef: "acme/app" }), "acme/app");
  assertEquals(
    runFacingRepoName({ provider: "radicle", repoRef: "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5" }),
    "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5",
  );
});

test("text about a local repository loses every spelling of its host path", () => {
  const repo = { provider: "local" as const, repoRef: "/Users/ada/code/payments" };
  assertEquals(
    runFacingText(
      repo,
      "refusing to push into /Users/ada/code/payments: the branch is checked out in " +
        "/Users/ada/code/payments/.git",
    ),
    "refusing to push into payments: the branch is checked out in payments/.git",
  );
  assertEquals(
    runFacingText({ provider: "github", repoRef: "acme/app" }, "acme/app was disconnected"),
    "acme/app was disconnected",
  );
});

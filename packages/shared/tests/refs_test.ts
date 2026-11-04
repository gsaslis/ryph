// Base-ref normalization and the ref-name rule (src/refs.ts).

import { test } from "bun:test";
import { assertEquals, assertThrows } from "@std/assert";
import {
  changeRequestHeadRef,
  checkoutBranchOf,
  isBranchRef,
  isChangeRequestHeadName,
  isGitRefName,
  normalizeBaseRef,
} from "../src/refs.ts";

test("a bare name is a branch", () => {
  assertEquals(normalizeBaseRef("main"), {
    remoteRef: "refs/heads/main",
    localBranch: "main",
  });
});

test("refs/heads/* narrows to the branch name", () => {
  assertEquals(normalizeBaseRef("refs/heads/feature/x"), {
    remoteRef: "refs/heads/feature/x",
    localBranch: "feature/x",
  });
});

test("refs/pull/N/head is served as a branch named after it", () => {
  assertEquals(normalizeBaseRef("refs/pull/42/head"), {
    remoteRef: "refs/pull/42/head",
    localBranch: "pull/42/head",
  });
});

test("tag refs are refused, not normalized", () => {
  assertThrows(() => normalizeBaseRef("refs/tags/v1.0"), Error, "tag refs are not supported");
});

test("an empty refs/heads/ names no branch", () => {
  assertThrows(() => normalizeBaseRef("refs/heads/"), Error, "names no branch");
});

test("a branch named pull/… is refused: it would be the same cache branch as a pull request head", () => {
  assertThrows(() => normalizeBaseRef("refs/heads/pull/42/head"), Error, "collides");
});

test("the local spelling pull/N/head reads back as the pull request head, never a branch", () => {
  assertEquals(normalizeBaseRef("pull/42/head"), normalizeBaseRef("refs/pull/42/head"));
});

test("checkoutBranchOf: the one rule a fork branch's name is pushed by", () => {
  assertEquals(checkoutBranchOf("feat/x"), "feat/x");
  for (const name of ["pull/1/head", "refs/heads/x", "HEAD", "-x", "a..b", "x.lock"]) {
    assertEquals(checkoutBranchOf(name), null, name);
  }
  // HEAD in any case, as the landing refuses it.
  for (const name of ["head", "Head", "hEaD"]) assertEquals(checkoutBranchOf(name), null, name);
});

test("isGitRefName: what git and every hop after it refuse", () => {
  for (const name of ["main", "feat/x", "refs/pull/42/head", "v1.2"]) {
    assertEquals(isGitRefName(name), true, name);
  }
  for (const name of ["", "-x", "a b", "a..b", "a@{1}", "x.lock", "x/", "a\x00b", "a~1", "a:b"]) {
    assertEquals(isGitRefName(name), false, JSON.stringify(name));
  }
});

test("merge-requests/… is GitLab's pull/…: a head served by name, never a branch", () => {
  assertEquals(normalizeBaseRef("refs/merge-requests/7/head"), {
    remoteRef: "refs/merge-requests/7/head",
    localBranch: "merge-requests/7/head",
  });
  assertEquals(normalizeBaseRef("merge-requests/7/head"), {
    remoteRef: "refs/merge-requests/7/head",
    localBranch: "merge-requests/7/head",
  });
  assertThrows(
    () => normalizeBaseRef("refs/heads/merge-requests/7/head"),
    Error,
    "collides with merge request heads",
  );
  assertEquals(checkoutBranchOf("merge-requests/7/head"), null);
  assertEquals(isChangeRequestHeadName("merge-requests/7/head"), true);
  assertEquals(isChangeRequestHeadName("pull/7/head"), true);
  assertEquals(isChangeRequestHeadName("feat/merge-requests"), false);
});

test("changeRequestHeadRef: where each forge keeps a change request's head", () => {
  assertEquals(changeRequestHeadRef("github", "12"), "refs/pull/12/head");
  assertEquals(changeRequestHeadRef("gitlab", "mr-7"), "refs/merge-requests/7/head");
  // An issue, a malformed ref, or a forge with no such ref has none.
  assertEquals(changeRequestHeadRef("gitlab", "issue-7"), null);
  assertEquals(changeRequestHeadRef("gitlab", "7"), null);
  assertEquals(changeRequestHeadRef("github", "mr-7"), null);
  assertEquals(changeRequestHeadRef("github", "0"), null);
  assertEquals(changeRequestHeadRef("radicle", "abc"), null);
  assertEquals(changeRequestHeadRef("local", "feat/x"), null);
});

test("isBranchRef: a branch of the repository itself, not a head or a tag", () => {
  for (const ref of ["main", "refs/heads/feat/x"]) assertEquals(isBranchRef(ref), true, ref);
  for (
    const ref of [
      "pull/1/head",
      "refs/pull/1/head",
      "refs/tags/v1",
      "refs/heads/",
      "refs/heads/pull/1",
    ]
  ) {
    assertEquals(isBranchRef(ref), false, ref);
  }
});

test("isGitRefName: one length bound", () => {
  assertEquals(isGitRefName("a".repeat(10_000)), true);
  assertEquals(isGitRefName("a".repeat(10_001)), false);
});

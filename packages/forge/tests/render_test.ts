// What a run READS about a change request — specifically the one line that says whether its
// head lives somewhere ryph cannot push to.
//
// "Somewhere else" is decided by comparing two repository addresses, and the comparison is not
// the same on both forges: GitHub folds case, Radicle cannot.

import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderThread } from "../src/core/render.ts";
import type { ThreadContext } from "../src/ports/forge_api.ts";

const RID = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";

function changeRequest(headRepoRef: string): ThreadContext {
  return {
    kind: "change_request",
    ref: "aa".repeat(20),
    title: "Quieten the widget",
    body: "It squeaks.",
    authorLogin: "did:key:z6Mk",
    createdAt: "2026-01-01T00:00:00.000Z",
    state: "open",
    entries: [],
    truncated: false,
    changeRequest: {
      ref: "aa".repeat(20),
      url: "",
      state: "open",
      merged: false,
      headRef: "patches/aa",
      headSha: "b".repeat(40),
      authorHeadSha: "b".repeat(40),
      headRepoRef,
      commitCount: null,
      baseRef: "main",
      defaultBranch: "main",
    },
  };
}

/** The one line the fork check writes. */
const branchLine = (rendered: string): string =>
  rendered.split("\n").find((l) => l.startsWith("branch: ")) ?? "";

test("GitHub folds case when it names a fork, because there two spellings are one repo", () => {
  const same = branchLine(
    renderThread("acme/api", changeRequest("acme/API"), null, "github"),
  );
  assertEquals(same.includes(" from "), false, same);
  const fork = renderThread("acme/api", changeRequest("grace/api"), null, "github");
  assertStringIncludes(fork, "from grace/api");
});

test("a Radicle head is compared exactly: an id differing only in case is another repo", () => {
  const same = branchLine(renderThread(RID, changeRequest(RID), null, "radicle"));
  assertEquals(same.includes(" from "), false, same);
  // Base58, where case is meaning. Folding it would tell a run that a change request in a
  // DIFFERENT repository is one of its own — the same mistake, one rendering later, that the
  // grant check and the branch check each had to unlearn.
  const other = renderThread(RID, changeRequest(RID.toLowerCase()), null, "radicle");
  assertStringIncludes(other, `from ${RID.toLowerCase()}`);
});

test("GitLab says fork or not by the project's ids, not by the path the repo was connected under", () => {
  const cr = (headRepoRef: string, sameRepo: boolean): ThreadContext => {
    const t = changeRequest(headRepoRef);
    return { ...t, changeRequest: { ...t.changeRequest!, sameRepo } };
  };
  // Renamed since it was connected: still its own merge request.
  const own = branchLine(renderThread("acme/old", cr("acme/new", true), null, "gitlab"));
  assertEquals(own.includes(" from "), false, own);
  // A fork that took the old path is a fork.
  assertStringIncludes(
    renderThread("acme/old", cr("acme/old", false), null, "gitlab"),
    "from acme/old",
  );
});

test("an inline remark shows the id a reply names, what it answers, and its thread's state", () => {
  const remark = (
    id: string,
    replyTo: string | null,
    resolved: boolean | null,
  ): ThreadContext["entries"][number] => ({
    kind: "review_comment",
    authorLogin: "grace",
    body: "This never terminates.",
    createdAt: "2026-01-02T00:00:00Z",
    state: null,
    location: "src/scheduler.ts:88",
    remark: { id, replyTo, resolved },
  });
  const rendered = renderThread("acme/app", {
    ...changeRequest("acme/app"),
    entries: [remark("500", null, false), remark("502", "500", true), remark("503", null, null)],
  }, null);
  assertStringIncludes(rendered, "remarked on src/scheduler.ts:88 (comment 500, unresolved)");
  assertStringIncludes(
    rendered,
    "remarked on src/scheduler.ts:88 (comment 502, replying to 500, resolved)",
  );
  // Unknown is left unsaid rather than guessed either way.
  assertStringIncludes(rendered, "remarked on src/scheduler.ts:88 (comment 503) at");
});

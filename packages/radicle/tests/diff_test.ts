// Splitting `git diff` into one patch per file. Pure, so it runs without `rad` and without a
// repository — what it is actually about is the shape a REVIEW REMARK anchors against, and
// getting the boundaries wrong there means a review the forge refuses whole.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { splitUnifiedDiff } from "../src/helpers/diff.ts";

test("each file becomes one patch, starting at the first hunk", () => {
  const out = splitUnifiedDiff(
    [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " context",
      "-old",
      "+new",
      "diff --git a/src/b.ts b/src/b.ts",
      "index 3333333..4444444 100644",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -10,2 +10,3 @@ fn()",
      " keep",
      "+added",
      "",
    ].join("\n"),
  );
  assertEquals(out.length, 2);
  // The header lines are gone: `patch` starts at `@@`, as every forge API hands it over.
  assertEquals(out[0], {
    path: "src/a.ts",
    patch: "@@ -1,3 +1,3 @@\n context\n-old\n+new",
  });
  assertEquals(out[1].path, "src/b.ts");
  assertEquals(out[1].patch, "@@ -10,2 +10,3 @@ fn()\n keep\n+added");
});

test("a deleted file is named by its old path, an added one by its new", () => {
  const out = splitUnifiedDiff(
    [
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-was here",
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1 @@",
      "+is here",
    ].join("\n"),
  );
  assertEquals(out.map((f) => f.path), ["gone.ts", "new.ts"]);
});

test("a file with no hunks has no patch — null, never an empty diff", () => {
  const out = splitUnifiedDiff(
    [
      "diff --git a/logo.png b/logo.png",
      "index 5555555..6666666 100644",
      "Binary files a/logo.png and b/logo.png differ",
      "diff --git a/moved.ts b/renamed.ts",
      "similarity index 100%",
      "rename from moved.ts",
      "rename to renamed.ts",
    ].join("\n"),
  );
  // Neither names a `+++` line — git prints "Binary files … differ" for one and nothing at
  // all for the other — so both fall back to the section header's new path. They are LISTED
  // with no patch rather than dropped: a file missing from the answer would read as one the
  // change request does not touch.
  assertEquals(out, [
    { path: "logo.png", patch: null },
    { path: "renamed.ts", patch: null },
  ]);
});

test("a `diff --git` line INSIDE a hunk does not start a new file", () => {
  // Reviewing a patch file is the case that breaks a naive split: the line appears as hunk
  // content, always with a leading space, `+` or `-`.
  const out = splitUnifiedDiff(
    [
      "diff --git a/fixture.patch b/fixture.patch",
      "--- a/fixture.patch",
      "+++ b/fixture.patch",
      "@@ -1,2 +1,2 @@",
      "-diff --git a/x b/x",
      "+diff --git a/y b/y",
    ].join("\n"),
  );
  assertEquals(out.length, 1);
  assertEquals(out[0].path, "fixture.patch");
});

test("an empty diff is no files at all", () => {
  assertEquals(splitUnifiedDiff(""), []);
  assertEquals(splitUnifiedDiff("\n  \n"), []);
});

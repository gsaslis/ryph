import { describe, expect, it } from "vitest";
import { parsePatchFiles } from "@pierre/diffs";
import { fileStats, inTreeOrder, plainLines, totalStats, treeStatuses } from "./diff-files";

const DIFF = `diff --git a/src/b.ts b/src/b.ts
index 1111111..2222222 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,3 +1,4 @@
 one
-two
+deux
+zwei
 three
diff --git a/README.md b/README.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/README.md
@@ -0,0 +1,2 @@
+# hi
+there
diff --git a/src/lib/a.ts b/src/lib/a.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/lib/a.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
`;

const files = parsePatchFiles(DIFF).flatMap((p) => p.files);

describe("a patch's diff, split for the detail page", () => {
  it("gives a file's hunks back as plain unified lines", () => {
    expect(plainLines(files[0])).toEqual([
      "@@ -1,3 +1,4 @@",
      " one",
      "-two",
      "+deux",
      "+zwei",
      " three",
    ]);
    expect(plainLines(files[2])).toEqual(["deleted file mode 100644", "@@ -1 +0,0 @@", "-gone"]);
    // A change with no lines still says what it was.
    expect(plainLines(files[3])).toEqual(["rename from old.txt", "rename to new.txt"]);
    const [modeOnly, binary] = parsePatchFiles(
      "diff --git a/s.sh b/s.sh\nold mode 100644\nnew mode 100755\n" +
        "diff --git a/i.png b/i.png\nindex 1111111..2222222 100644\n" +
        "Binary files a/i.png and b/i.png differ\n",
    ).flatMap((p) => p.files);
    expect(plainLines(modeOnly)).toEqual(["old mode 100644", "new mode 100755"]);
    expect(plainLines(binary)).toEqual(["contents changed, no lines to show"]);
  });

  it("counts each file's lines from its hunks", () => {
    expect(files.map((f) => [f.name, fileStats(f)])).toEqual([
      ["src/b.ts", { additions: 2, deletions: 1 }],
      ["README.md", { additions: 2, deletions: 0 }],
      ["src/lib/a.ts", { additions: 0, deletions: 1 }],
      ["new.txt", { additions: 0, deletions: 0 }],
    ]);
    expect(totalStats(files)).toEqual({ additions: 4, deletions: 2 });
  });

  it("colours each file in the tree by how it changed, under its new path", () => {
    expect(treeStatuses(files)).toEqual([
      { path: "src/b.ts", status: "modified" },
      { path: "README.md", status: "added" },
      { path: "src/lib/a.ts", status: "deleted" },
      { path: "new.txt", status: "renamed" },
    ]);
  });

  it("orders files as the tree lists them: folders first at each level, names regardless of case", () => {
    expect(inTreeOrder(files).map((f) => f.name)).toEqual([
      "src/lib/a.ts",
      "src/b.ts",
      "new.txt",
      "README.md",
    ]);
  });

  it("orders numbered names as the tree does, numbers as numbers", () => {
    const named = (name: string) => ({ ...files[0], name });
    expect(
      inTreeOrder(["step10.ts", "step2.ts", ".env", "-x.ts", "src/a.ts"].map(named)).map((f) =>
        f.name
      ),
    ).toEqual(["src/a.ts", "-x.ts", ".env", "step2.ts", "step10.ts"]);
  });
});

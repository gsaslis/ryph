// The intake's one-ref rule, stated as a table: a line of the run's namespace, or a later
// generation of one.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { isRunOutputRef } from "../src/http/patches.ts";

test("isRunOutputRef: `<ns>/<line>` or `<ns>/<line>-<n>` for n ≥ 2, and nothing else", () => {
  const ns = "ryph/ada/r-1";
  const cases: Array<[string, boolean]> = [
    ["refs/heads/ryph/ada/r-1/work", true],
    ["refs/heads/ryph/ada/r-1/fix-a", true],
    ["refs/heads/ryph/ada/r-1/fix-a-2", true],
    ["refs/heads/ryph/ada/r-1/fix-a-10", true],
    ["refs/heads/ryph/ada/r-1", false], // the bare namespace is no line
    ["refs/heads/ryph/ada/r-1-2", false],
    ["refs/heads/ryph/ada/r-1/fix-a-1", false], // the first generation has no suffix
    ["refs/heads/ryph/ada/r-1/fix-a-0", false],
    ["refs/heads/ryph/ada/r-1/fix-a-02", false], // not a plain counter
    ["refs/heads/ryph/ada/r-1/Bad", false],
    ["refs/heads/ryph/ada/r-1/a/b", false],
    ["refs/heads/ryph/ada/r-12/work", false], // a different run
    ["refs/heads/ryph/bob/r-2/work", false],
    ["refs/tags/ryph/ada/r-1/work", false],
    ["ryph/ada/r-1/work", false],
    ["HEAD", false],
  ];
  for (const [ref, expected] of cases) assertEquals(isRunOutputRef(ref, ns), expected, ref);
});

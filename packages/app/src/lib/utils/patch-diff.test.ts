import { describe, expect, it } from "vitest";
import { diffBaseBranch } from "./patch-diff";

describe("diffBaseBranch", () => {
  it("names the branch a live diff lands on, as a person says it", () => {
    expect(diffBaseBranch({ mode: "live", targetRef: "refs/heads/main", sincePatchId: null }))
      .toBe("main");
    expect(diffBaseBranch({ mode: "live", targetRef: "feat/x", sincePatchId: null })).toBe(
      "feat/x",
    );
  });

  it("names none for a diff counted from an earlier patch", () => {
    expect(diffBaseBranch({ mode: "live", targetRef: "feat/x", sincePatchId: "p-1" })).toBeNull();
  });

  it("names none for a settled diff, whose base may be on no branch", () => {
    expect(diffBaseBranch({ mode: "record", targetRef: "main", sincePatchId: null })).toBeNull();
  });
});

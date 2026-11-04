import { describe, expect, it } from "vitest";
import { submittedInReply } from "./patches-context";

describe("what a submit_patch reply submitted", () => {
  it("reads the patch, its head and its generation", () => {
    expect(
      submittedInReply(
        "Submitted patch p-aca3df55be for app at b5c147f15a (generation 1); it is pending_approval. " +
          "No pull request exists yet.",
      ),
    ).toEqual({ patchId: "p-aca3df55be", headSha: "b5c147f15a", generation: 1 });
  });

  it("reads a path with spaces and a later generation", () => {
    expect(
      submittedInReply(
        "Submitted patch p-0123456789 for my repo at 0123456789 (generation 3); it is queued.",
      ),
    ).toEqual({ patchId: "p-0123456789", headSha: "0123456789", generation: 3 });
  });

  it("reads a patch id of the sortable shape", () => {
    expect(
      submittedInReply(
        "Submitted patch p-01jb7k3m9x4q8zt2vw6hn5c0fe for app at b5c147f15a (generation 2); it is queued.",
      ),
    ).toEqual({ patchId: "p-01jb7k3m9x4q8zt2vw6hn5c0fe", headSha: "b5c147f15a", generation: 2 });
  });

  it("is null for a reply that submitted nothing", () => {
    expect(submittedInReply("app has no commits since its base: nothing to submit.")).toBeNull();
    expect(
      submittedInReply("app still has a merge in progress with conflicts in: a.ts. Resolve them."),
    ).toBeNull();
  });
});

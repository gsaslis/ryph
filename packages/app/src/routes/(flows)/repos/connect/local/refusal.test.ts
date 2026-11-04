import { describe, expect, it } from "vitest";
import { ApiError } from "$lib/api/call";
import { localRepoFailure, pathProblem, withoutTrailingSlash } from "./refusal";

const refused = (body: Record<string, unknown>) => new ApiError(422, body, "x");

describe("localRepoFailure", () => {
  it("names each reason the server gives, and pins it to the path", () => {
    expect(localRepoFailure(refused({ error: "x", reason: "linked_worktree" }))).toEqual({
      message: "That folder is a linked worktree or submodule. Use the main checkout.",
      pinned: true,
    });
    expect(localRepoFailure(refused({ error: "x", reason: "not_a_repository" })).message).toBe(
      "That folder is not a git repository. Use the repository's top folder.",
    );
  });

  it("names the allowed folder when a path is outside it", () => {
    const e = refused({ error: "x", reason: "outside_root", root: "/home/ada" });
    expect(localRepoFailure(e)).toEqual({
      message: "Ryph can only add repositories inside /home/ada.",
      pinned: true,
    });
  });

  it("falls back to the plain outside_root text without a root", () => {
    expect(localRepoFailure(refused({ error: "x", reason: "outside_root" })).message).toBe(
      "Ryph is not allowed to read that folder.",
    );
  });

  it("falls back to the server's words for a reason it does not know", () => {
    const e = new ApiError(422, { error: "something new", reason: "brand_new" }, "something new");
    expect(localRepoFailure(e)).toEqual({ message: "something new", pinned: true });
  });

  it("uses the server's words on a conflict, pinned", () => {
    const e = new ApiError(409, { error: "already connected" }, "already connected");
    expect(localRepoFailure(e)).toEqual({ message: "already connected", pinned: true });
  });

  it("says who may add one on a 403", () => {
    const failure = localRepoFailure(new ApiError(403, null, "forbidden"));
    expect(failure.message).toMatch(/admin/);
    expect(failure.pinned).toBe(false);
  });

  it("leaves the form free to retry when the check fails or the feature is off", () => {
    expect(localRepoFailure(new ApiError(502, null, "bad gateway"))).toEqual({
      message: "Ryph could not check that path. Try again.",
      pinned: false,
    });
    expect(localRepoFailure(new ApiError(503, null, "unavailable"))).toEqual({
      message: "Adding repositories from this machine is turned off.",
      pinned: false,
    });
    expect(localRepoFailure(new TypeError("Failed to fetch"))).toEqual({
      message: "Ryph could not be reached. Try again.",
      pinned: false,
    });
  });
});

describe("pathProblem", () => {
  it("accepts an empty field and an absolute path", () => {
    expect(pathProblem("")).toBeNull();
    expect(pathProblem(" /home/ada/app ")).toBeNull();
  });

  it("refuses a relative or home-relative path", () => {
    expect(pathProblem("~/app")).not.toBeNull();
    expect(pathProblem("app")).not.toBeNull();
  });
});

describe("a pasted path", () => {
  it("loses only its trailing slashes", () => {
    expect(withoutTrailingSlash("/Users/ada/app/")).toBe("/Users/ada/app");
    expect(withoutTrailingSlash("/Users/ada/app//")).toBe("/Users/ada/app");
    expect(withoutTrailingSlash("/Users/ada/app")).toBe("/Users/ada/app");
    expect(withoutTrailingSlash("/Users/ada/../app/")).toBe("/Users/ada/../app");
    expect(withoutTrailingSlash("/")).toBe("/");
  });
});

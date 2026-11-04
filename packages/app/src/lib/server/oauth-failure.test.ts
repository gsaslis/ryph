import { describe, expect, it } from "vitest";
import { oauthFailure } from "./oauth-failure";

describe("oauthFailure", () => {
  it("tells a sign-in that has to be linked first to sign in another way and link", () => {
    const out = oauthFailure("github", 409, { error: "server words", code: "link_required" });
    expect(out.linkRequired).toBe(true);
    expect(out.error).toBe(
      "This GitHub account isn't linked to an account here yet. Sign in another way, then link " +
        "GitHub on your account page.",
    );
  });

  it("passes any other refusal through, or names the status", () => {
    expect(oauthFailure("github", 403, { error: "registration is closed" })).toEqual({
      error: "registration is closed",
      linkRequired: false,
    });
    expect(oauthFailure("github", 502, null)).toEqual({
      error: "the sign-in failed (502)",
      linkRequired: false,
    });
  });
});

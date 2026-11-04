import { describe, expect, it } from "vitest";
import { gitlabHookSteps, hookDelivery, hooksPageUrl } from "./steps";

const hook = {
  url: "https://ryph.example.com/v1/hooks/gitlab?project=42&generation=3",
  token: "a".repeat(64),
  generation: 3,
  pushBranchFilter: "trunk",
};

describe("hooksPageUrl", () => {
  it("opens the project's own webhooks page, under any path prefix", () => {
    expect(hooksPageUrl("https://gitlab.com/acme/web/app")).toBe(
      "https://gitlab.com/acme/web/app/-/hooks",
    );
    expect(hooksPageUrl("https://git.example.com/gitlab/acme/app/")).toBe(
      "https://git.example.com/gitlab/acme/app/-/hooks",
    );
  });

  it("links nothing a browser should not open", () => {
    expect(hooksPageUrl(null)).toBeNull();
    expect(hooksPageUrl("javascript:alert(1)")).toBeNull();
    expect(hooksPageUrl("not a url")).toBeNull();
  });
});

describe("gitlabHookSteps", () => {
  const steps = gitlabHookSteps(hook, "https://gitlab.com/acme/app");

  it("hands over the URL, generation and all, the project's token and its branch to copy", () => {
    const values = steps.flatMap((s) => s.values ?? []);
    expect(values).toEqual([
      { label: "URL", value: hook.url },
      { label: "Secret token", value: hook.token },
      { label: "Branch filter", value: "trunk" },
    ]);
    // The URL is pasted whole: the generation in it is what the server checks the token against.
    expect(values[0].value).toContain("&generation=3");
  });

  it("names the three triggers Ryph reads, then limits pushes to the default branch by name", () => {
    const at = steps.findIndex((s) => s.ticks);
    expect(steps[at].ticks).toEqual(["Push events", "Comments", "Merge request events"]);
    // A step of its own, right after, with the exact branch to enter.
    const filter = steps[at + 1];
    expect(filter.text).toContain("Wildcard pattern");
    expect(filter.text).toContain("trunk");
    expect(filter.values).toEqual([{ label: "Branch filter", value: "trunk" }]);
  });

  it("still asks for the branch filter on a project with no default branch yet", () => {
    const empty = gitlabHookSteps({ ...hook, pushBranchFilter: null }, null);
    const filter = empty.find((s) => s.values?.some((v) => v.label === "Branch filter"));
    expect(filter?.text).toContain("default branch");
    expect(filter?.values).toEqual([{ label: "Branch filter", value: null }]);
  });

  it("says why there is no URL where the deployment has no public address", () => {
    const unset = gitlabHookSteps({ ...hook, url: null }, null);
    expect(unset.flatMap((s) => s.values ?? [])[0]).toEqual({ label: "URL", value: null });
    expect(unset.find((s) => s.values)?.note).toContain("RYPH_APP_URL");
    expect(unset[0].link).toBeUndefined();
  });

  it("links the project's webhooks and keeps SSL verification on", () => {
    expect(steps[0].link?.href).toBe("https://gitlab.com/acme/app/-/hooks");
    expect(steps.at(-1)?.text).toContain("SSL verification on");
  });
});

describe("hookDelivery", () => {
  it("says no delivery was seen, and what that costs, before GitLab sends one", () => {
    const none = hookDelivery(null, null);
    expect(none.seen).toBe(false);
    expect(none.text).toBe("No delivery seen yet");
    expect(none.hint).toContain("until the webhook is added");
    expect(none.hint).toContain("merges are checked slowly");
  });

  it("names how long ago the last delivery was", () => {
    const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const seen = hookDelivery(at, at);
    expect(seen.seen).toBe(true);
    expect(seen.text).toMatch(/^Last delivery 3\s?h(r|ours?)? ago$/);
    expect(seen.hint).toBeNull();
  });

  it("says when deliveries arrive but no merge request event has, which merges ride on", () => {
    const seen = hookDelivery(new Date().toISOString(), null);
    expect(seen.seen).toBe(true);
    expect(seen.hint).toContain("Merge request events");
    expect(seen.hint).toContain("merges are only checked slowly");
  });

  it("says nothing of drops when none were, and counts comments apart from other events", () => {
    const at = new Date().toISOString();
    expect(hookDelivery(at, at).dropped).toBeNull();
    expect(hookDelivery(at, at, { comments: 0, other: 0, lastAt: null }).dropped).toBeNull();
    const one = hookDelivery(at, at, { comments: 1, other: 0, lastAt: at });
    expect(one.dropped).toMatch(/^1 comment dropped, the last /);
    expect(one.dropped).toContain("Post any /ryph comment among them again.");
    const churn = hookDelivery(null, null, { comments: 0, other: 37, lastAt: null });
    expect(churn.dropped).toMatch(/^37 other events dropped\. /);
    expect(churn.dropped).toContain("didn't reach Ryph");
    expect(churn.dropped).not.toContain("comment");
    const both = hookDelivery(at, at, { comments: 3, other: 1, lastAt: null });
    expect(both.dropped).toMatch(/^3 comments and 1 other event dropped\. /);
  });
});

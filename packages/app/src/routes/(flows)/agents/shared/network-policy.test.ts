import { describe, expect, it } from "vitest";
import type { EgressCeiling } from "$lib/api/types";
import { hostCovered, networkPolicyProblem } from "./network-policy";
import { hostGrammarProblem } from "$lib/utils/egress-hosts";

const ceiling: EgressCeiling = {
  mode: "proxy",
  wired: true,
  hosts: [],
  bundles: [
    {
      id: "github-releases",
      name: "GitHub releases",
      description: "Release assets and source tarballs.",
      hosts: ["github.com", "*.githubusercontent.com"],
    },
  ],
  // The admin form's fields; an agent's form narrows `bundles` and never reads these.
  catalogue: [],
  source: "environment",
  updatedAt: null,
  updatedBy: null,
};

describe("hostCovered", () => {
  it("reads the ceiling's own wildcards", () => {
    const entries = ["*.githubusercontent.com", "github.com"];
    expect(hostCovered("objects.githubusercontent.com", entries)).toBe(true);
    expect(hostCovered("release-assets.githubusercontent.com", entries)).toBe(true);
    expect(hostCovered("github.com", entries)).toBe(true);
  });

  it("never reads a wildcard as a grant of the bare domain", () => {
    expect(hostCovered("githubusercontent.com", ["*.githubusercontent.com"])).toBe(false);
  });

  it("refuses a widening", () => {
    expect(hostCovered("*.com", ["*.githubusercontent.com"])).toBe(false);
    expect(hostCovered("evil.example", ["*.githubusercontent.com"])).toBe(false);
  });
});

describe("networkPolicyProblem", () => {
  it("accepts a host the ceiling covers by wildcard", () => {
    // The form has to judge narrowing exactly as the API does. It used to compare literally and
    // refuse this one, with advice to WIDEN the deployment in order to narrow an agent.
    expect(
      networkPolicyProblem(
        { mode: "narrowed", bundles: [], hosts: "release-assets.githubusercontent.com" },
        ceiling,
      ),
    ).toBe(null);
  });

  it("still refuses a host no ceiling entry covers", () => {
    const problem = networkPolicyProblem(
      { mode: "narrowed", bundles: [], hosts: "evil.example" },
      ceiling,
    );
    expect(problem).toContain("evil.example");
  });

  it("refuses a host the server's schema would reject, naming it", () => {
    // `foo_bar.githubusercontent.com` is covered by the ceiling's wildcard, so coverage alone
    // passed it and the form submitted — and the API's zod schema then rejected the underscore,
    // which surfaces as a generic API error instead of the named refusal this bridge exists to
    // produce. Grammar is checked first, for that reason.
    const problem = networkPolicyProblem(
      { mode: "narrowed", bundles: [], hosts: "foo_bar.githubusercontent.com" },
      ceiling,
    );
    expect(problem).toContain("foo_bar.githubusercontent.com");
    expect(problem).toContain("not a hostname");
  });

  it("claims nothing when the ceiling is unreadable", () => {
    expect(
      networkPolicyProblem({ mode: "narrowed", bundles: [], hosts: "evil.example" }, null),
    ).toBe(null);
  });
});

describe("hostGrammarProblem", () => {
  it("takes hostnames and a leading wildcard, and nothing that looks like one", () => {
    expect(hostGrammarProblem("registry.npmjs.org")).toBe(null);
    expect(hostGrammarProblem("*.githubusercontent.com")).toBe(null);
    for (
      const bad of [
        "https://registry.npmjs.org",
        "registry.npmjs.org:443",
        "foo_bar.example.com",
        "localhost",
        "*",
        "10.0.0.1",
        "",
      ]
    ) {
      expect(hostGrammarProblem(bad), bad).not.toBe(null);
    }
  });
});

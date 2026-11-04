import { describe, expect, it } from "vitest";
import { ApiError } from "$lib/api/call";
import type { GithubRepo } from "$lib/api/types";
import { filterGithubRepos, githubConnectFailure, githubListFailure } from "./listing";

const repo = (fullName: string): GithubRepo => ({
  fullName,
  url: `https://github.com/${fullName}.git`,
  defaultBranch: "main",
  private: false,
  admin: true,
  connectedRepoId: null,
});

const repos = [repo("ada/app"), repo("ada/notes"), repo("acme/App-Server"), repo("acme/docs")];

describe("filterGithubRepos", () => {
  it("matches everything on an empty query", () => {
    expect(filterGithubRepos(repos, "  ").shown).toEqual(repos);
  });

  it("matches the owner and the name, ignoring case", () => {
    expect(filterGithubRepos(repos, "APP").shown.map((r) => r.fullName)).toEqual([
      "ada/app",
      "acme/App-Server",
    ]);
    expect(filterGithubRepos(repos, "acme/").shown).toHaveLength(2);
  });

  it("needs every word to match", () => {
    expect(filterGithubRepos(repos, "acme app").shown.map((r) => r.fullName)).toEqual([
      "acme/App-Server",
    ]);
  });

  it("draws up to the limit and counts the rest", () => {
    expect(filterGithubRepos(repos, "", 3)).toEqual({ shown: repos.slice(0, 3), hidden: 1 });
    expect(filterGithubRepos(repos, "docs", 3).hidden).toBe(0);
  });
});

describe("githubConnectFailure", () => {
  it("says the account cannot see a repo GitHub does not show it", () => {
    expect(githubConnectFailure(new ApiError(404, null, "not found"), "ada")).toBe(
      "@ada cannot see that repository on GitHub.",
    );
  });

  it("names a duplicate and a GitHub that did not answer", () => {
    expect(githubConnectFailure(new ApiError(409, null, "x"), "ada")).toBe(
      "That repository is already connected.",
    );
    expect(githubConnectFailure(new ApiError(502, null, "x"), "ada")).toBe(
      "GitHub did not answer. Try again.",
    );
  });

  it("keeps the server's words for a refused permission", () => {
    const e = new ApiError(403, null, "@ada does not have admin access to acme/docs");
    expect(githubConnectFailure(e, "ada")).toBe("@ada does not have admin access to acme/docs");
  });

  it("says when Ryph could not be reached", () => {
    expect(githubConnectFailure(new TypeError("Failed to fetch"), "ada")).toBe(
      "Ryph could not be reached. Try again.",
    );
  });
});

describe("githubListFailure", () => {
  it("tells a GitHub outage from anything else", () => {
    expect(githubListFailure(new ApiError(502, null, "x"))).toBe(
      "GitHub did not answer. Try again.",
    );
    expect(githubListFailure(new ApiError(500, null, "x"))).toBe(
      "Ryph could not load your repositories. Try again.",
    );
    expect(githubListFailure(new TypeError("Failed to fetch"))).toBe(
      "Ryph could not be reached. Try again.",
    );
  });
});

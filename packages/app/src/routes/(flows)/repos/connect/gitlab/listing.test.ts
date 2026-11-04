import { describe, expect, it } from "vitest";
import { ApiError } from "$lib/api/call";
import type { GitlabProject } from "$lib/api/repos";
import type { GitlabMode } from "$lib/api/types";
import {
  filterGitlabProjects,
  gitlabConnectFailure,
  gitlabListFailure,
  unpickable,
} from "./listing";

const project = (path: string, over: Partial<GitlabProject> = {}): GitlabProject => ({
  id: String(path.length),
  pathWithNamespace: path,
  url: `https://gitlab.com/${path}.git`,
  webUrl: `https://gitlab.com/${path}`,
  defaultBranch: "main",
  visibility: "private",
  admin: false,
  connectedRepoId: null,
  ...over,
});

const projects = [
  project("acme/web/app"),
  project("acme/web/docs"),
  project("ada/App-Server"),
  project("ada/notes"),
];
const bot: GitlabMode = { mode: "bot", login: "ryph-bot", url: "https://gitlab.com", signIn: true };
const user: GitlabMode = { mode: "user", login: "ada", url: "https://gitlab.com", signIn: false };

describe("filterGitlabProjects", () => {
  it("matches everything on an empty query", () => {
    expect(filterGitlabProjects(projects, "  ").shown).toEqual(projects);
  });

  it("matches any segment of a nested path, ignoring case", () => {
    expect(filterGitlabProjects(projects, "APP").shown.map((p) => p.pathWithNamespace)).toEqual([
      "acme/web/app",
      "ada/App-Server",
    ]);
    expect(filterGitlabProjects(projects, "acme/web/").shown).toHaveLength(2);
  });

  it("needs every word to match", () => {
    expect(filterGitlabProjects(projects, "web docs").shown.map((p) => p.pathWithNamespace))
      .toEqual(["acme/web/docs"]);
  });

  it("draws at most the limit and counts the rest", () => {
    const many = Array.from({ length: 7 }, (_, i) => project(`acme/p${i}`));
    expect(filterGitlabProjects(many, "", 5)).toMatchObject({ hidden: 2 });
    expect(filterGitlabProjects(many, "", 5).shown).toHaveLength(5);
  });
});

describe("unpickable", () => {
  it("refuses an empty project in either mode", () => {
    const empty = project("acme/empty", { defaultBranch: null, admin: true });
    expect(unpickable(empty, "bot")).toBe("Empty project");
    expect(unpickable(empty, "user")).toBe("Empty project");
  });

  it("needs the token's Maintainer access in user mode only", () => {
    // The bot is a Developer by design; the person's own access is checked when they connect.
    expect(unpickable(project("acme/app"), "bot")).toBeNull();
    expect(unpickable(project("acme/app"), "user")).toBe("Needs Maintainer access");
    expect(unpickable(project("acme/app", { admin: true }), "user")).toBeNull();
  });
});

describe("failures", () => {
  it("says GitLab did not answer on a 502", () => {
    expect(gitlabListFailure(new ApiError(502, {}, "bad gateway"))).toBe(
      "GitLab did not answer. Try again.",
    );
    expect(gitlabConnectFailure(new ApiError(502, {}, "bad gateway"), bot)).toBe(
      "GitLab did not answer. Try again.",
    );
  });

  it("says Ryph could not be reached when the fetch never arrived", () => {
    expect(gitlabListFailure(new TypeError("fetch failed"))).toBe(
      "Ryph could not be reached. Try again.",
    );
  });

  it("names the access a refusal is about, by mode", () => {
    const refused = new ApiError(403, {}, "forbidden");
    expect(gitlabConnectFailure(refused, bot)).toContain("Maintainer access");
    expect(gitlabConnectFailure(refused, bot)).toContain("linked");
    expect(gitlabConnectFailure(refused, user)).toBe("Only admins can connect repositories here.");
    expect(gitlabConnectFailure(refused, { ...bot, signIn: false })).toBe(
      "Connecting needs a linked GitLab account, and GitLab sign-in isn't set up here.",
    );
  });

  it("names the account that cannot see the project, and a project already connected", () => {
    expect(gitlabConnectFailure(new ApiError(404, {}, "nope"), bot)).toBe(
      "@ryph-bot cannot see that project on GitLab.",
    );
    expect(gitlabConnectFailure(new ApiError(409, {}, "dup"), user)).toBe(
      "That project is already connected.",
    );
  });
});

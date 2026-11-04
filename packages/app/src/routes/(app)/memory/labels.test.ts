import { describe, expect, it } from "vitest";
import { gitlabHostOf, subjectDisplay } from "./labels";

const repo = (url: string) => ({ kind: "repo" as const, url });

describe("subjectDisplay", () => {
  it("drops github.com and gitlab.com from the label and names the forge", () => {
    expect(subjectDisplay(repo("github.com/acme/app"))).toEqual({
      label: "acme/app",
      full: "github.com/acme/app",
      provider: "github",
    });
    expect(subjectDisplay(repo("gitlab.com/acme/web/app"))).toEqual({
      label: "acme/web/app",
      full: "gitlab.com/acme/web/app",
      provider: "gitlab",
    });
  });

  it("knows a self-managed GitLab only when told its host", () => {
    const url = "git.example.com/acme/app";
    expect(subjectDisplay(repo(url))).toMatchObject({ label: url, provider: null });
    expect(subjectDisplay(repo(url), "git.example.com")).toMatchObject({
      label: "acme/app",
      provider: "gitlab",
    });
  });

  it("never takes a host that merely contains a forge's name for it", () => {
    expect(subjectDisplay(repo("evilgithub.com/acme/app")).provider).toBeNull();
    expect(subjectDisplay(repo("evil.example/github.com/acme")).provider).toBeNull();
  });

  it("names Radicle and local subjects as before", () => {
    expect(subjectDisplay(repo("/home/ada/app")).provider).toBe("local");
    expect(subjectDisplay(null).provider).toBeNull();
  });
});

describe("gitlabHostOf", () => {
  it("reads a host, lowercased, and nothing from no URL", () => {
    expect(gitlabHostOf("https://Git.Example.com/gitlab")).toBe("git.example.com");
    expect(gitlabHostOf(null)).toBeNull();
    expect(gitlabHostOf("not a url")).toBeNull();
  });
});

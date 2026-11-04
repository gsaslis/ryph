import { describe, expect, it } from "vitest";
import { gitlabProjectPage } from "./gitlab";

describe("gitlabProjectPage", () => {
  it("drops the clone URL's .git, under nested groups and a path prefix", () => {
    expect(gitlabProjectPage("https://gitlab.com/acme/web/app.git")).toBe(
      "https://gitlab.com/acme/web/app",
    );
    expect(gitlabProjectPage("https://git.example.com/gitlab/acme/app.git/")).toBe(
      "https://git.example.com/gitlab/acme/app",
    );
    expect(gitlabProjectPage("https://gitlab.com/acme/app")).toBe("https://gitlab.com/acme/app");
  });
});

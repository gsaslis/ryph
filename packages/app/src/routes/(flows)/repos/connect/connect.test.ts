import { isRedirect } from "@sveltejs/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ForgeProvider, GithubMode, GitlabMode, RadicleMode } from "$lib/api/types";

const providers = vi.hoisted(() => ({
  current: [] as ForgeProvider[] | null,
  github: null as GithubMode | null,
  gitlab: null as GitlabMode | null,
  radicle: null as RadicleMode | null,
}));

vi.mock("$lib/api/forge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/api/forge")>()),
  getForges: () =>
    providers.current === null ? Promise.reject(new Error("forge unreachable")) : Promise.resolve({
      providers: providers.current,
      github: providers.github,
      gitlab: providers.gitlab,
      radicle: providers.radicle,
    }),
}));
const installationRepos = vi.hoisted(() => ({ status: 200 }));

vi.mock("$lib/api/repos", async () => {
  const { ApiError } = await import("$lib/api/call");
  return {
    getInstallations: () => Promise.resolve([]),
    getInstallationRepos: () =>
      installationRepos.status === 200
        ? Promise.resolve({ accountLogin: "acme", settingsUrl: null, repos: [] })
        : Promise.reject(new ApiError(installationRepos.status, {}, "refused")),
  };
});

const { load } = await import("./+page");

// oxlint-disable-next-line no-explicit-any
const run = (path: string): Promise<any> =>
  // oxlint-disable-next-line no-explicit-any
  (load as any)({
    parent: () => Promise.resolve({ user: { id: "u1" } }),
    url: new URL(`http://ryph.test${path}`),
    fetch,
  });

async function redirectOf(path: string): Promise<string | null> {
  try {
    await run(path);
    return null;
  } catch (e) {
    if (isRedirect(e)) return e.location;
    throw e;
  }
}

describe("connect flow entry", () => {
  beforeEach(() => {
    providers.current = [];
    providers.github = null;
    providers.gitlab = null;
    providers.radicle = null;
    installationRepos.status = 200;
  });

  it("sends an installation link to the user-mode repo list, which has no installations", async () => {
    installationRepos.status = 501;
    expect(await redirectOf("/repos/connect?installationId=123")).toBe("/repos/connect/github");
    installationRepos.status = 200;
    expect((await run("/repos/connect?installationId=123")).installationId).toBe("123");
  });

  it("sends a Radicle-only deployment straight to the Radicle flow", async () => {
    providers.current = ["radicle"];
    expect(await redirectOf("/repos/connect")).toBe("/repos/connect/radicle");
  });

  it("sends a GitLab-only deployment straight to the GitLab flow", async () => {
    providers.current = ["gitlab"];
    providers.gitlab = { mode: "bot", login: "ryph-bot", url: "https://gitlab.com", signIn: true };
    expect(await redirectOf("/repos/connect")).toBe("/repos/connect/gitlab");
  });

  it("asks where the repo lives when GitLab sits beside Radicle", async () => {
    providers.current = ["gitlab", "radicle"];
    providers.gitlab = { mode: "bot", login: "ryph-bot", url: "https://gitlab.com", signIn: true };
    const data = await run("/repos/connect");
    expect(data.choose).toBe(true);
    expect(data.providers).toEqual(["gitlab", "radicle"]);
    // The chooser names the account the GitLab way in acts as.
    expect(data.gitlab).toEqual(providers.gitlab);
  });

  it("sends a deployment with only local repos straight to the local flow", async () => {
    providers.current = ["local"];
    expect(await redirectOf("/repos/connect")).toBe("/repos/connect/local");
  });

  it("asks where the repo lives when there is no GitHub but two other ways in", async () => {
    providers.current = ["radicle", "local"];
    const data = await run("/repos/connect");
    expect(data.choose).toBe(true);
    expect(data.providers).toEqual(["radicle", "local"]);
  });

  it("asks where the repo lives when GitHub sits beside local repos", async () => {
    providers.current = ["github", "local"];
    expect((await run("/repos/connect")).choose).toBe(true);
    expect((await run("/repos/connect?provider=github")).choose).toBe(false);
  });

  it("asks which forge where there are two", async () => {
    providers.current = ["github", "radicle"];
    expect((await run("/repos/connect")).choose).toBe(true);
  });

  it("says whether Radicle is the person's own node", async () => {
    providers.current = ["github", "radicle", "local"];
    expect((await run("/repos/connect")).radicleMine).toBe(false);
    providers.radicle = { mode: "user" };
    providers.github = { mode: "user", login: "ada" };
    const data = await run("/repos/connect");
    expect(data.choose).toBe(true);
    expect(data.radicleMine).toBe(true);
  });

  it("shows the retry step, not the error page, when the providers cannot be read", async () => {
    providers.current = null;
    const data = await run("/repos/connect");
    expect(data.unavailable).toBe(true);
    expect(data.choose).toBe(false);
  });

  it("sends a user-mode GitHub-only deployment straight to its repo list", async () => {
    providers.current = ["github"];
    providers.github = { mode: "user", login: "ada" };
    expect(await redirectOf("/repos/connect")).toBe("/repos/connect/github");
    expect(await redirectOf("/repos/connect?provider=github")).toBe("/repos/connect/github");
  });

  it("offers GitHub as the user-mode login beside local repos", async () => {
    providers.current = ["github", "local"];
    providers.github = { mode: "user", login: "ada" };
    const data = await run("/repos/connect");
    expect(data.choose).toBe(true);
    expect(data.githubLogin).toBe("ada");
  });

  it("starts at the GitHub App screen where GitHub is the only forge", async () => {
    providers.current = ["github"];
    const data = await run("/repos/connect");
    expect(data.choose).toBe(false);
    expect(data.installations).toEqual([]);
  });
});

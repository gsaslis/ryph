import { isRedirect } from "@sveltejs/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubMode } from "$lib/api/types";

const forge = vi.hoisted(() => ({ github: null as GithubMode | null }));

vi.mock("$lib/api/forge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/api/forge")>()),
  getForges: () => Promise.resolve({ providers: ["github"], github: forge.github, radicle: null }),
}));
vi.mock("$lib/api/repos", () => ({
  getGithubRepos: () => {
    repos.asked++;
    return Promise.resolve([]);
  },
}));

const { load } = await import("./+page");

const repos = vi.hoisted(() => ({ asked: 0 }));

// oxlint-disable-next-line no-explicit-any
const run = (caps: string[] = ["*"]): Promise<any> =>
  // oxlint-disable-next-line no-explicit-any
  (load as any)({
    parent: () => Promise.resolve({ user: { id: "u1", caps } }),
    url: new URL("http://ryph.test/repos/connect/github"),
    fetch,
  });

describe("connect from your GitHub", () => {
  beforeEach(() => {
    forge.github = null;
    repos.asked = 0;
  });

  it("sends an App deployment back to the installation screen", async () => {
    forge.github = { mode: "app", signIn: true };
    const e = await run().then(() => null, (e: unknown) => e);
    expect(isRedirect(e) && e.location).toBe("/repos/connect");
  });

  it("names the login in user mode", async () => {
    forge.github = { mode: "user", login: "ada" };
    const data = await run();
    expect(data.login).toBe("ada");
    expect(data.multiForge).toBe(false);
    expect(data.allowed).toBe(true);
  });

  it("tells a member only admins connect here, without reading the list", async () => {
    forge.github = { mode: "user", login: "ada" };
    const data = await run(["repos:connect", "repos:manage"]);
    expect(data.allowed).toBe(false);
    expect(await data.repos).toBe(null);
    expect(repos.asked).toBe(0);
    expect((await run(["repos:connect", "repos:manage-all"])).allowed).toBe(true);
  });
});

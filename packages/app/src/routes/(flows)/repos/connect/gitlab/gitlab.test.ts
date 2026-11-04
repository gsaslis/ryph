import { isRedirect } from "@sveltejs/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ForgeProvider, GitlabMode } from "$lib/api/types";

const forge = vi.hoisted(() => ({
  providers: ["gitlab"] as ForgeProvider[],
  gitlab: null as GitlabMode | null,
  down: false,
}));

vi.mock("$lib/api/forge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/api/forge")>()),
  getForges: () =>
    forge.down
      ? Promise.reject(new Error("forge unreachable"))
      : Promise.resolve({ providers: forge.providers, github: null, gitlab: forge.gitlab }),
}));
const projects = vi.hoisted(() => ({ asked: 0 }));
vi.mock("$lib/api/repos", () => ({
  getGitlabProjects: () => {
    projects.asked++;
    return Promise.resolve([]);
  },
}));

const identities = vi.hoisted(() => ({ linked: [] as string[], down: false }));
vi.mock("$lib/api/identities", () => ({
  listIdentities: () =>
    identities.down ? Promise.reject(new Error("auth unreachable")) : Promise.resolve(
      identities.linked.map((provider) => ({ provider, login: "ada", linkedAt: "" })),
    ),
}));

const { load } = await import("./+page");

// oxlint-disable-next-line no-explicit-any
const run = (caps: string[] = ["*"]): Promise<any> =>
  // oxlint-disable-next-line no-explicit-any
  (load as any)({
    parent: () => Promise.resolve({ user: { id: "u1", caps } }),
    url: new URL("http://ryph.test/repos/connect/gitlab"),
    fetch,
  });

const bot: GitlabMode = { mode: "bot", login: "ryph-bot", url: "https://gitlab.com", signIn: true };
const user: GitlabMode = { mode: "user", login: "ada", url: "https://gitlab.com", signIn: false };

describe("connect from GitLab", () => {
  beforeEach(() => {
    forge.providers = ["gitlab"];
    forge.gitlab = null;
    forge.down = false;
    projects.asked = 0;
    identities.linked = ["gitlab"];
    identities.down = false;
  });

  it("sends a deployment without GitLab back to the chooser", async () => {
    forge.providers = ["radicle"];
    const e = await run().then(() => null, (e: unknown) => e);
    expect(isRedirect(e) && e.location).toBe("/repos/connect");
  });

  it("shows the retry step when the forge cannot be read", async () => {
    forge.down = true;
    expect((await run()).unavailable).toBe(true);
  });

  it("lets anyone pick in bot mode: the control plane checks their own Maintainer access", async () => {
    forge.gitlab = bot;
    const data = await run(["repos:connect"]);
    expect(data.gitlab).toEqual(bot);
    expect(data.allowed).toBe(true);
    expect(data.multiForge).toBe(false);
  });

  it("tells a member only admins connect in user mode, without reading the list", async () => {
    forge.gitlab = user;
    forge.providers = ["gitlab", "local"];
    const data = await run(["repos:connect", "repos:manage"]);
    expect(data.allowed).toBe(false);
    expect(data.multiForge).toBe(true);
    expect(await data.projects).toBe(null);
    expect(projects.asked).toBe(0);
    expect((await run(["repos:connect", "repos:manage-all"])).allowed).toBe(true);
  });

  it("asks a bot-mode person to link GitLab first, and only in bot mode", async () => {
    forge.gitlab = bot;
    expect((await run()).needsLink).toBe(false);
    identities.linked = ["github"];
    expect((await run()).needsLink).toBe(true);
    // An identity list that cannot be read says nothing; the connect itself still answers.
    identities.down = true;
    expect((await run()).needsLink).toBe(false);
    forge.gitlab = user;
    identities.down = false;
    expect((await run()).needsLink).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  connectGitlabRepo,
  getGitlabProjects,
  getRepoGitlabHook,
  rotateRepoGitlabHook,
} from "./repos";

const respond = (status: number, body: unknown, seen?: { url?: string; init?: RequestInit }) =>
  ((url: string, init?: RequestInit) => {
    if (seen) {
      seen.url = url;
      seen.init = init;
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;

const gitlabRepo = {
  id: "r1",
  provider: "gitlab",
  installationId: null,
  repoRef: "acme/web/app",
  url: "https://gitlab.com/acme/web/app.git",
  defaultBranch: "main",
  submissionPolicy: "require-approval",
  sizeClass: null,
  allowForkPushes: false,
  archivedAt: null,
  createdAt: "2026-10-14T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
};
const hook = {
  url: "https://ryph.example.com/v1/hooks/gitlab?project=42&generation=1",
  token: "f".repeat(64),
  generation: 1,
  pushBranchFilter: "main",
};

describe("GitLab repos", () => {
  it("lists the projects the token reaches, nested paths and all", async () => {
    const seen: { url?: string } = {};
    const projects = await getGitlabProjects(respond(200, {
      projects: [{
        id: "42",
        pathWithNamespace: "acme/web/app",
        url: "https://gitlab.com/acme/web/app.git",
        webUrl: "https://gitlab.com/acme/web/app",
        defaultBranch: null,
        visibility: "internal",
        admin: false,
        connectedRepoId: null,
      }],
    }, seen));
    expect(seen.url).toContain("/v1/gitlab/projects");
    expect(projects[0].pathWithNamespace).toBe("acme/web/app");
    expect(projects[0].visibility).toBe("internal");
  });

  it("connects by path with no installation, and reads back the webhook to paste", async () => {
    const seen: { init?: RequestInit } = {};
    const connected = await connectGitlabRepo(
      respond(201, { repo: gitlabRepo, webhook: hook }, seen),
      { repoRef: "acme/web/app", submissionPolicy: "auto" },
    );
    const body = JSON.parse(String(seen.init?.body));
    expect(body).toEqual({ provider: "gitlab", repoRef: "acme/web/app", submissionPolicy: "auto" });
    expect("installationId" in body).toBe(false);
    expect(connected.repo.provider).toBe("gitlab");
    expect(connected.webhook).toEqual(hook);
    // The rest of the setup (triggers, SSL verification) is fixed, and the steps name it.
    const extra = await connectGitlabRepo(
      respond(201, {
        repo: gitlabRepo,
        webhook: { ...hook, projectId: "42", triggers: ["push_events"], sslVerification: true },
      }),
      { repoRef: "acme/web/app", submissionPolicy: "auto" },
    );
    expect(extra.webhook).toEqual(hook);
  });

  it("has no webhook to paste in user mode", async () => {
    const connected = await connectGitlabRepo(respond(201, { repo: gitlabRepo, webhook: null }), {
      repoRef: "acme/web/app",
      submissionPolicy: "require-approval",
    });
    expect(connected.webhook).toBeNull();
  });

  it("reads a connected repo's webhook again, with when it last delivered", async () => {
    const seen: { url?: string } = {};
    const lastDeliveryAt = "2026-10-14T09:00:00.000Z";
    const status = {
      webhook: hook,
      lastDeliveryAt,
      lastMergeRequestDeliveryAt: null,
      droppedComments: 1,
      droppedOtherEvents: 4,
      lastDroppedAt: lastDeliveryAt,
    };
    expect(await getRepoGitlabHook(respond(200, status, seen), "r/1")).toEqual(status);
    expect(seen.url).toContain("/v1/connected-repos/r%2F1/gitlab-hook");
    const unseen = await getRepoGitlabHook(
      respond(200, {
        webhook: hook,
        lastDeliveryAt: null,
        lastMergeRequestDeliveryAt: null,
        droppedComments: 0,
        droppedOtherEvents: 0,
        lastDroppedAt: null,
      }),
      "r1",
    );
    expect(unseen.lastDeliveryAt).toBeNull();
  });

  it("rotates the token with a bare POST, and hands back the next generation's values", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const next = {
      ...hook,
      url: "https://ryph.example.com/v1/hooks/gitlab?project=42&generation=2",
      token: "e".repeat(64),
      generation: 2,
    };
    const rotated = await rotateRepoGitlabHook(
      respond(200, {
        webhook: next,
        lastDeliveryAt: null,
        lastMergeRequestDeliveryAt: null,
        droppedComments: 0,
        droppedOtherEvents: 0,
        lastDroppedAt: null,
      }, seen),
      "r/1",
    );
    expect(seen.url).toContain("/v1/connected-repos/r%2F1/gitlab-hook/rotate");
    expect(seen.init?.method).toBe("POST");
    expect(seen.init?.body).toBeUndefined();
    expect(rotated).toEqual({
      webhook: next,
      lastDeliveryAt: null,
      lastMergeRequestDeliveryAt: null,
      droppedComments: 0,
      droppedOtherEvents: 0,
      lastDroppedAt: null,
    });
  });

  it("refuses a rotation the server refused", async () => {
    await expect(
      rotateRepoGitlabHook(respond(403, { error: "forbidden" }), "r1"),
    ).rejects.toThrow();
  });
});

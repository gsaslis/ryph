import { render } from "svelte/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "svelte";
import type { ConnectedRepo, GitlabMode } from "$lib/api/types";

const forge = vi.hoisted(() => ({ gitlab: null as GitlabMode | null }));

vi.mock("$lib/api/environments", () => ({
  streamEnvironmentDefinition: () => null,
  getEnvironmentOrError: () => Promise.resolve({ environment: null, error: null }),
}));
vi.mock("$lib/api/checks", () => ({ streamRepoChecks: () => Promise.resolve(null) }));
vi.mock("$lib/api/services", () => ({ streamRepoServices: () => Promise.resolve(null) }));
vi.mock("$lib/api/run-sizes", () => ({ getRunSizesOrNull: () => Promise.resolve(null) }));
vi.mock("$lib/api/forge", async (original) => ({
  ...await original<typeof import("$lib/api/forge")>(),
  getForges: () =>
    Promise.resolve({
      providers: forge.gitlab ? ["gitlab"] : [],
      github: null,
      gitlab: forge.gitlab,
    }),
}));

const { load } = await import("./+page");
const { default: Page } = await import("./+page.svelte");
const { default: HookPanel } = await import(
  "$lib/components/gitlab-hook/gitlab-hook-panel.svelte"
);

const repo: ConnectedRepo = {
  id: "repo-1",
  provider: "gitlab",
  installationId: null,
  repoRef: "acme/web/app",
  url: "https://gitlab.example.com/acme/web/app.git",
  defaultBranch: "main",
  submissionPolicy: "require-approval",
  allowForkPushes: false,
  sizeClass: null,
  archivedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** The page as `caps` see it: a member's repos:manage unless said otherwise. */
async function page(caps: string[] = ["repos:read", "repos:manage"]) {
  const asked: string[] = [];
  const fetch = vi.fn((input: string | URL | Request) => {
    const path = String(input);
    asked.push(path);
    if (path === "/api/v1/connected-repos") return Promise.resolve(json({ repos: [repo] }));
    throw new Error(`Unexpected request: ${path}`);
  }) as unknown as typeof globalThis.fetch;
  const data = await load(
    { fetch, params: { id: repo.id }, depends: () => {} } as unknown as Parameters<
      typeof load
    >[0],
  );
  const body = render(Page, {
    props: {
      params: { id: repo.id },
      data: { ...data!, user: { caps } },
    } as unknown as ComponentProps<typeof Page>,
  }).body;
  return { data: data!, body, asked };
}

describe("a GitLab repository's page", () => {
  beforeEach(() => {
    forge.gitlab = {
      mode: "bot",
      login: "ryph-bot",
      url: "https://gitlab.example.com",
      signIn: true,
    };
  });

  it("opens the project page on GitLab, not the clone URL", async () => {
    const { body } = await page();
    expect(body).toContain("Open on GitLab");
    expect(body).toContain('href="https://gitlab.example.com/acme/web/app"');
    expect(body).not.toContain('href="https://gitlab.example.com/acme/web/app.git"');
  });

  it("names the project by its last segment and speaks of merge requests", async () => {
    const { body } = await page();
    expect(body).toMatch(/<h1[^>]*>app<\/h1>/);
    expect(body).toContain("merge request");
    expect(body).not.toContain("pull request");
  });

  it("offers the webhook in bot mode without reading its token on load", async () => {
    const { body, asked } = await page();
    expect(body).toContain("Show webhook settings");
    expect(asked.some((path) => path.includes("gitlab-hook"))).toBe(false);
    expect(body).toContain("through @ryph-bot");
  });

  it("offers the webhook only to who may manage repos: a viewer neither reads nor rotates it", async () => {
    const { body } = await page(["repos:read"]);
    expect(body).not.toContain("Show webhook settings");
  });

  it("offers fork pushes in bot mode, with GitLab's merge rule beside the switch", async () => {
    const { body } = await page();
    expect(body).toContain("Changes from forks");
    expect(body).toContain("can merge into the target branch");
  });

  it("has no webhook and no fork pushes in user mode, and names whose account it is", async () => {
    forge.gitlab = { mode: "user", login: "ada", url: "https://gitlab.com", signIn: false };
    const { body } = await page();
    expect(body).not.toContain("Show webhook settings");
    expect(body).not.toContain("Changes from forks");
    expect(body).toContain("Ryph acts as @ada there for everyone who uses it.");
  });
});

describe("a GitLab repository's webhook, once a Maintainer has read it", () => {
  const webhook = {
    url: "https://ryph.example.com/v1/hooks/gitlab?project=42&generation=2",
    token: "c".repeat(64),
    generation: 2,
    pushBranchFilter: "main",
  };
  const panel = (
    lastDeliveryAt: string | null,
    lastMergeRequestDeliveryAt: string | null = lastDeliveryAt,
    droppedComments = 0,
    droppedOtherEvents = 0,
  ) =>
    render(HookPanel, {
      props: {
        status: {
          webhook,
          lastDeliveryAt,
          lastMergeRequestDeliveryAt,
          droppedComments,
          droppedOtherEvents,
          lastDroppedAt: droppedComments + droppedOtherEvents === 0 ? null : lastDeliveryAt,
        },
        repoId: repo.id,
        webUrl: "https://gitlab.example.com/acme/web/app",
      },
    }).body;

  it("says no delivery was seen yet, and why that matters, until GitLab sends one", () => {
    const body = panel(null);
    expect(body).toContain("No delivery seen yet");
    expect(body).toContain("GitLab sends nothing until the webhook is added.");
    expect(body).toContain("merges are checked slowly");
    expect(body).not.toContain("Last delivery");
  });

  it("names when the last delivery came", () => {
    const body = panel(new Date(Date.now() - 2 * 86_400_000).toISOString());
    expect(body).toMatch(/Last delivery 2\s?d(ays?)? ago/);
    expect(body).not.toContain("No delivery seen yet");
  });

  it("says when deliveries come but no merge request event has: merges ride on those alone", () => {
    const body = panel(new Date().toISOString(), null);
    expect(body).toContain("Last delivery");
    expect(body).toContain("No merge request event seen yet.");
  });

  it("says which deliveries were dropped over the project's budgets, and nothing when none were", () => {
    const at = new Date().toISOString();
    expect(panel(at)).not.toContain("dropped");
    const churn = panel(at, at, 0, 12);
    expect(churn).toContain("12 other events dropped");
    expect(churn).toContain("didn't reach Ryph");
    expect(churn).not.toContain("comment");
    const both = panel(at, at, 2, 12);
    expect(both).toContain("2 comments and 12 other events dropped");
    expect(both).toContain("Post any /ryph comment among them again.");
  });

  it("shows the generation-bearing URL and the token beside a way to rotate it", () => {
    const body = panel(null);
    expect(body).toContain("Rotate token");
    expect(body).toContain("generation=2");
    expect(body).toContain(webhook.token);
    // Nothing is rotated until someone confirms it.
    expect(body).not.toContain("Token rotated");
  });
});

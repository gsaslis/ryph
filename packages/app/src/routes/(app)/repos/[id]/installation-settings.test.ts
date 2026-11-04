import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "svelte";
import type { ConnectedRepo } from "$lib/api/types";
import { load } from "./+page";
import Page from "./+page.svelte";

vi.mock("$lib/api/environments", () => ({
  streamEnvironmentDefinition: () => null,
  getEnvironmentOrError: () => Promise.resolve({ environment: null, error: null }),
}));
vi.mock("$lib/api/checks", () => ({ streamRepoChecks: () => Promise.resolve(null) }));
vi.mock("$lib/api/services", () => ({ streamRepoServices: () => Promise.resolve(null) }));
vi.mock("$lib/api/run-sizes", () => ({ getRunSizesOrNull: () => Promise.resolve(null) }));
vi.mock("$lib/api/forge", async (original) => ({
  ...await original<typeof import("$lib/api/forge")>(),
  getForges: () => Promise.resolve(null),
}));

const repo: ConnectedRepo = {
  id: "repo-1",
  provider: "github",
  installationId: "123",
  repoRef: "repository-owner/example",
  url: "https://github.com/repository-owner/example",
  defaultBranch: "main",
  submissionPolicy: "require-approval",
  allowForkPushes: false,
  sizeClass: null,
  archivedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// The repo page links "Manage installation" to the app's own redirect route: nothing about the
// installation is read while the page loads.

async function page(connected = repo) {
  const asked: string[] = [];
  const fetch = vi.fn((input: string | URL | Request) => {
    const path = String(input);
    asked.push(path);
    if (path === "/api/v1/connected-repos") return Promise.resolve(json({ repos: [connected] }));
    if (path.endsWith("/radicle")) return Promise.resolve(json({ error: "node unavailable" }, 404));
    if (path.endsWith("/command-allowlist")) return Promise.resolve(json({ entries: [] }));
    throw new Error(`Unexpected request: ${path}`);
  }) as unknown as typeof globalThis.fetch;
  const data = await load(
    { fetch, params: { id: connected.id }, depends: () => {} } as unknown as Parameters<
      typeof load
    >[0],
  );
  return { data: data!, asked };
}

function html(data: Awaited<ReturnType<typeof page>>["data"]) {
  return render(Page, {
    props: {
      params: { id: data.repo.id },
      data: { ...data, user: null },
    } as unknown as ComponentProps<typeof Page>,
  }).body;
}

function installationAnchor(body: string) {
  return body.match(/<a\b[^>]*>[^]*?<\/a>/g)?.find((anchor) =>
    anchor.includes("Manage installation")
  );
}

describe("repository installation settings", () => {
  it("links to the click-time redirect and asks nothing about the installation on load", async () => {
    const { data, asked } = await page();
    expect(asked.some((path) => path.includes("installation"))).toBe(false);
    const anchor = installationAnchor(html(data));
    expect(anchor).toContain('href="/repos/repo-1/installation-settings"');
    expect(anchor).toContain('target="_blank"');
    expect(anchor).toContain('rel="noreferrer"');
  });

  it("encodes the repository id in the link", async () => {
    const { data } = await page({ ...repo, id: "repo/with spaces" });
    expect(installationAnchor(html(data))).toContain(
      'href="/repos/repo%2Fwith%20spaces/installation-settings"',
    );
  });

  it.each(
    [
      ["github", null],
      ["local", null],
      ["radicle", null],
      ["local", "123"],
      ["radicle", "123"],
    ] as const,
  )("offers no link for a %s repo with installation %s", async (provider, id) => {
    const { data } = await page({ ...repo, provider, installationId: id });
    const body = html(data);
    expect(body).not.toContain("Manage installation");
    expect(body).toContain("Disconnect");
  });
});

import { render } from "svelte/server";
import type { ComponentProps } from "svelte";
import { describe, expect, it, vi } from "vitest";
import { load } from "./+page";
import Page from "./+page.svelte";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_GITHUB_APP_NAME: "ryph-test" } }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const repo = {
  fullName: "owner/example",
  url: "https://github.com/owner/example",
  defaultBranch: "main",
  private: false,
  connected: false,
};

// The connect picker's empty listing links to where the installation is managed, named by the
// same listing response; with no name it falls back to the App's own install page.

function plane(settingsUrl: string | null, repos = [repo]) {
  const asked: string[] = [];
  const fetch = ((input: string | URL | Request) => {
    const path = String(input);
    asked.push(path);
    if (path.endsWith("/repos")) {
      return Promise.resolve(json({ accountLogin: "cached-owner", settingsUrl, repos }));
    }
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}
async function run(fetch: typeof globalThis.fetch) {
  return await load(
    {
      fetch,
      parent: () => Promise.resolve({ user: { id: "u1" } }),
      url: new URL("http://ryph.test/repos/connect?installationId=123"),
    } as unknown as Parameters<typeof load>[0],
  );
}
function html(data: unknown) {
  return render(Page, { props: { data } as ComponentProps<typeof Page> }).body;
}

describe("connect picker installation settings", () => {
  it.each([
    "https://github.com/organizations/live-owner/settings/installations/123",
    "https://github.com/settings/installations/123",
  ])("links an empty listing to %s, from the listing alone", async (url) => {
    const p = plane(url, []);
    const data = await run(p.fetch);
    expect(p.asked).toEqual(["/api/v1/installations/123/repos"]);
    const body = html(data);
    expect(body).toContain("This installation grants no repositories");
    expect(body).toMatch(new RegExp(`<a[^>]*href="${url}"[^>]*>\\s*adjust its access on GitHub`));
  });

  it("falls back to the App's install page when GitHub named no settings page", async () => {
    const data = await run(plane(null, []).fetch);
    expect(html(data)).toMatch(
      /<a[^>]*href="https:\/\/github.com\/apps\/ryph-test\/installations\/new"[^>]*>\s*adjust its access on GitHub/,
    );
  });

  it("keeps a nonempty picker free of an access link", async () => {
    const data = await run(plane("https://github.com/settings/installations/123").fetch);
    const body = html(data);
    expect(body).toContain("owner/example");
    expect(body).not.toContain("adjust its access on GitHub");
  });
});

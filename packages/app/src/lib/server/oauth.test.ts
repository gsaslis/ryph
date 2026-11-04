import { beforeEach, describe, expect, it, vi } from "vitest";

const publicEnv = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock("$env/dynamic/public", () => publicEnv);
vi.mock("$env/dynamic/private", () => ({ env: {} }));

const { authorizeUrl, beginOAuth, endOAuth, OAUTH_STATE_COOKIE, pkcePair } = await import(
  "./oauth"
);

/** Enough of SvelteKit's cookie jar for a round trip. */
function jar() {
  const values = new Map<string, string>();
  return {
    get: (name: string) => values.get(name),
    set: (name: string, value: string) => void values.set(name, value),
    delete: (name: string) => void values.delete(name),
  } as unknown as import("@sveltejs/kit").Cookies;
}

async function sha256url(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

describe("authorizeUrl", () => {
  beforeEach(() => {
    publicEnv.env = {};
  });

  it("sends GitHub no redirect_uri and pins no leg", async () => {
    publicEnv.env = { PUBLIC_GITHUB_CLIENT_ID: "Iv1.abc" };
    const authorize = await authorizeUrl("github", "https://ryph.example.com");
    if (!authorize) throw new Error("expected an authorize URL");
    expect(authorize.url.origin + authorize.url.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorize?.url.searchParams.get("client_id")).toBe("Iv1.abc");
    expect(authorize?.url.searchParams.has("redirect_uri")).toBe(false);
    expect(authorize?.leg).toBeNull();
  });

  it("is null for an unconfigured or unknown provider", async () => {
    expect(await authorizeUrl("github", "https://ryph.example.com")).toBeNull();
    expect(await authorizeUrl("gitlab", "https://ryph.example.com")).toBeNull();
    expect(await authorizeUrl("bitbucket", "https://ryph.example.com")).toBeNull();
  });

  it("sends GitLab read_user, the callback as redirect_uri, and an S256 challenge", async () => {
    publicEnv.env = { PUBLIC_GITLAB_CLIENT_ID: "gl-app" };
    const authorize = await authorizeUrl("gitlab", "https://ryph.example.com");
    if (!authorize) throw new Error("expected an authorize URL");
    const { url, leg } = authorize;
    expect(`${url.origin}${url.pathname}`).toBe("https://gitlab.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("gl-app");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("read_user");
    expect(url.searchParams.get("redirect_uri")).toBe("https://ryph.example.com/gitlab/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(leg?.redirectUri).toBe("https://ryph.example.com/gitlab/callback");
    // The challenge is the verifier's hash; the verifier itself never rides in the URL.
    expect(url.searchParams.get("code_challenge")).toBe(await sha256url(leg!.codeVerifier));
    expect(url.toString()).not.toContain(leg!.codeVerifier);
  });

  it("keeps a self-managed instance's path prefix", async () => {
    publicEnv.env = {
      PUBLIC_GITLAB_CLIENT_ID: "gl-app",
      PUBLIC_GITLAB_URL: "https://git.example.com/gitlab/",
    };
    const authorize = await authorizeUrl("gitlab", "https://ryph.example.com");
    expect(authorize?.url.toString()).toMatch(
      /^https:\/\/git\.example\.com\/gitlab\/oauth\/authorize\?/,
    );
  });

  it("refuses an instance URL that is not http(s)", async () => {
    publicEnv.env = { PUBLIC_GITLAB_CLIENT_ID: "gl-app", PUBLIC_GITLAB_URL: "javascript:alert(1)" };
    expect(await authorizeUrl("gitlab", "https://ryph.example.com")).toBeNull();
  });
});

describe("pkcePair", () => {
  it("makes a fresh 43-character verifier each time", async () => {
    const a = await pkcePair();
    const b = await pkcePair();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).toBe(await sha256url(a.verifier));
  });
});

describe("the state cookie", () => {
  it("carries GitLab's leg to the callback and is gone after", () => {
    const cookies = jar();
    const leg = {
      redirectUri: "https://ryph.example.com/gitlab/callback",
      codeVerifier: "v".repeat(43),
    };
    const state = beginOAuth(cookies, {
      provider: "gitlab",
      intent: "login",
      backTo: null,
      invite: null,
      leg,
    });
    const pinned = endOAuth(cookies);
    expect(pinned).toMatchObject({ state, provider: "gitlab", leg });
    expect(cookies.get(OAUTH_STATE_COOKIE)).toBeUndefined();
    expect(endOAuth(cookies)).toBeNull();
  });
});

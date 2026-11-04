import { isRedirect } from "@sveltejs/kit";
import { afterEach, describe, expect, it, vi } from "vitest";

// The single-user login link: opening it spends nothing, and only the Continue button's POST trades
// the token for a session. A dead link is sent to sign-in with a reason rather than an error page.

vi.mock("$env/dynamic/private", () => ({ env: { RYPH_PROXY_SECRET: "hop" } }));
vi.mock("$app/environment", () => ({ dev: true }));

import * as route from "./+page.server";
import { linkProblemOf } from "$lib/utils/auth/link-problems";

type Sent = { url: string; headers: Headers; body: unknown };

function stubUpstream(response: () => Response): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    sent.push({
      url: String(url),
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)),
    });
    return Promise.resolve(response());
  });
  return sent;
}

const PAIR = {
  accessToken: "access",
  expiresIn: 600,
  refreshToken: "refresh",
  user: {
    id: "u-1",
    email: "ada@example.com",
    name: "Ada",
    role: "owner",
    status: "active",
    emailVerifiedAt: "2026-01-01T00:00:00.000Z",
    unprovenEmail: null,
    resetRequestedAt: null,
    hasPassword: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

async function post(token: string) {
  const set: Record<string, string> = {};
  const url = new URL(`http://localhost:3000/auth/login-link/${token}`);
  const event = {
    request: new Request(url, { method: "POST", headers: { "user-agent": "Firefox" } }),
    url,
    params: { token },
    cookies: { set: (name: string, value: string) => (set[name] = value) },
    getClientAddress: () => "127.0.0.1",
  };
  try {
    // oxlint-disable-next-line no-explicit-any
    await route.actions.default(event as any);
    throw new Error("expected a redirect");
  } catch (thrown) {
    if (!isRedirect(thrown)) throw thrown;
    return { location: thrown.location, cookies: set };
  }
}

describe("/auth/login-link/:token", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("has no load: opening the link asks nothing upstream and spends nothing", () => {
    expect("load" in route).toBe(false);
  });

  it("the POST spends the link and lands signed in", async () => {
    const sent = stubUpstream(() => Response.json(PAIR));
    const { location, cookies } = await post("a".repeat(64));
    expect(location).toBe("/agents");
    expect(cookies).toEqual({ ryph_access_token: "access", ryph_refresh_token: "refresh" });
    expect(sent[0].url).toBe("http://127.0.0.1:7411/v1/auth/login-link");
    expect(sent[0].body).toEqual({ token: "a".repeat(64) });
    // The client facts go up vouched for, so the session records them.
    expect(sent[0].headers.get("x-client-ip")).toBe("127.0.0.1");
    expect(sent[0].headers.get("x-ryph-proxy-secret")).toBe("hop");
  });

  it("a dead link goes to sign-in, saying so", async () => {
    stubUpstream(() => Response.json({ error: "this link is no longer valid" }, { status: 410 }));
    const { location, cookies } = await post("b".repeat(64));
    expect(location).toBe("/login?link=expired");
    expect(cookies).toEqual({});
  });

  it("a multi-user instance says links do not work there, not that this one expired", async () => {
    stubUpstream(() =>
      Response.json({
        error: "login links only work on a single-user instance",
        code: "multi_user",
      }, {
        status: 409,
      })
    );
    const { location, cookies } = await post("c".repeat(64));
    expect(location).toBe("/login?link=multi-user");
    expect(cookies).toEqual({});
  });

  it("the login page reads every problem the action names back", () => {
    for (const problem of ["expired", "failed", "multi-user"]) {
      expect(linkProblemOf(problem)).toBe(problem);
    }
    expect(linkProblemOf("toString")).toBe(null);
  });

  it("any other failure is reported as a failure, not an expiry", async () => {
    for (const status of [429, 500]) {
      stubUpstream(() => Response.json({ error: "boom" }, { status }));
      const { location } = await post("d".repeat(64));
      expect(location).toBe("/login?link=failed");
    }
  });
});

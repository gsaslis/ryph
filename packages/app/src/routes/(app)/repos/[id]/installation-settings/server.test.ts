import { isHttpError, isRedirect } from "@sveltejs/kit";
import { afterEach, describe, expect, it, vi } from "vitest";

// "Manage installation" against a stubbed control plane: who is sent to sign in, what is asked,
// and where the browser ends up.

vi.mock("$lib/server/auth", () => ({
  RYPH_API_URL: "http://api.test",
  sessionHeaders: () => ({ "x-client-ip": "203.0.113.7" }),
}));
vi.mock("$lib/utils/auth/jwt", () => ({
  getUserData: (token: string | undefined) => token === "good-jwt" ? { id: "u-1" } : null,
}));

import { GET } from "./+server";

type Sent = { url: string; headers: Headers; redirect: RequestRedirect | undefined };

function stubUpstream(response: () => Response): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", (url: URL, init: RequestInit) => {
    sent.push({ url: String(url), headers: new Headers(init.headers), redirect: init.redirect });
    return Promise.resolve(response());
  });
  return sent;
}

const to = (location: string) => () => new Response(null, { status: 302, headers: { location } });
const answer = (status: number) => () =>
  new Response(JSON.stringify({ error: "upstream" }), { status });

async function call(accessToken: string | undefined, id = "cr-1") {
  const url = new URL(`https://ryph.test/repos/${encodeURIComponent(id)}/installation-settings`);
  const event = {
    request: new Request(url),
    url,
    params: { id },
    locals: { accessToken },
    getClientAddress: () => "203.0.113.7",
  };
  try {
    // oxlint-disable-next-line no-explicit-any
    return await GET(event as any);
  } catch (thrown) {
    return thrown;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /repos/:id/installation-settings", () => {
  it.each([
    "https://github.com/organizations/acme/settings/installations/123",
    "https://github.com/settings/installations/123",
    "https://ghe.example/enterprises/big-co/settings/installations/123",
  ])("sends the browser on to %s, read at click time", async (location) => {
    const sent = stubUpstream(to(location));
    const out = await call("good-jwt");
    expect(isRedirect(out) && out.status === 302 && out.location).toBe(location);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("http://api.test/v1/connected-repos/cr-1/installation-settings");
    expect(sent[0].headers.get("authorization")).toBe("Bearer good-jwt");
    expect(sent[0].headers.get("x-client-ip")).toBe("203.0.113.7");
    // The control plane's redirect is read here, never followed server-side.
    expect(sent[0].redirect).toBe("manual");
  });

  it("encodes the repository id", async () => {
    const sent = stubUpstream(to("https://github.com/settings/installations/1"));
    await call("good-jwt", "cr/with spaces");
    expect(sent[0].url).toBe(
      "http://api.test/v1/connected-repos/cr%2Fwith%20spaces/installation-settings",
    );
  });

  it("sends a visitor without a session to sign in, and back here after", async () => {
    const sent = stubUpstream(to("https://github.com/settings/installations/1"));
    const out = await call(undefined);
    expect(isRedirect(out) && out.location).toBe(
      `/login?backTo=${encodeURIComponent("/repos/cr-1/installation-settings")}`,
    );
    expect(sent).toHaveLength(0);
  });

  it("sends a session that ended upstream to sign in", async () => {
    stubUpstream(answer(401));
    const out = await call("good-jwt");
    expect(isRedirect(out) && out.location).toContain("/login?backTo=");
  });

  it.each([403, 404])("reads %s as nothing to manage", async (status) => {
    stubUpstream(answer(status));
    const out = await call("good-jwt");
    expect(isHttpError(out) && out.status).toBe(404);
    expect(isHttpError(out) && out.body.message).toBe(
      "This repository has no GitHub installation to manage.",
    );
  });

  it.each([
    ["a forge that could not say", answer(502)],
    ["no GitHub App", answer(503)],
    ["user mode", answer(501)],
    ["a redirect off https", to("javascript:alert(1)")],
    ["a plain-http redirect", to("http://github.com/settings/installations/1")],
    ["a redirect with no location", () => new Response(null, { status: 302 })],
    ["a 200 instead of a redirect", () => new Response("{}", { status: 200 })],
  ])("answers %s with a plain error page, not a blank one", async (_, response) => {
    stubUpstream(response);
    const out = await call("good-jwt");
    expect(isHttpError(out) && out.status).toBe(502);
    expect(isHttpError(out) && out.body.message).toBe(
      "GitHub did not answer. Try again in a moment.",
    );
  });
});

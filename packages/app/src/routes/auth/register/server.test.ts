import { afterEach, describe, expect, it, vi } from "vitest";

// Registration carries the browser's facts upstream, vouched for, so each caller spends its own
// sign-up budget there instead of one that every caller shares.

vi.mock("$env/dynamic/private", () => ({ env: { RYPH_PROXY_SECRET: "hop" } }));
vi.mock("$app/environment", () => ({ dev: true }));

import { POST } from "./+server";
import { MAX_AUTH_BODY_BYTES } from "$lib/server/request-body";

type Sent = { url: string; headers: Headers };

function stubUpstream(): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    sent.push({ url: String(url), headers: new Headers(init.headers) });
    // Open registration: no user comes back, so no sign-in follows.
    return Promise.resolve(Response.json({ ok: true }, { status: 202 }));
  });
  return sent;
}

describe("/auth/register", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses an oversized body before contacting auth or setting cookies", async () => {
    const sent = stubUpstream();
    const set = vi.fn();
    const event = {
      request: new Request("http://localhost:3000/auth/register", {
        method: "POST",
        body: " ".repeat(MAX_AUTH_BODY_BYTES + 1),
      }),
      cookies: { set },
      getClientAddress: () => "203.0.113.7",
    };
    // oxlint-disable-next-line no-explicit-any
    await expect(POST(event as any)).rejects.toMatchObject({ status: 413 });
    expect(sent).toEqual([]);
    expect(set).not.toHaveBeenCalled();
  });

  it("sends the client facts and the proxy secret with the sign-up", async () => {
    const sent = stubUpstream();
    const event = {
      request: new Request("http://localhost:3000/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "Firefox" },
        body: JSON.stringify({ email: "ada@example.com" }),
      }),
      cookies: { set: () => {} },
      getClientAddress: () => "203.0.113.7",
    };
    // oxlint-disable-next-line no-explicit-any
    const res = await POST(event as any);
    expect(res.status).toBe(202);
    expect(sent.map((s) => s.url)).toEqual(["http://127.0.0.1:7411/v1/auth/users"]);
    expect(sent[0].headers.get("x-client-ip")).toBe("203.0.113.7");
    expect(sent[0].headers.get("x-client-user-agent")).toBe("Firefox");
    expect(sent[0].headers.get("x-ryph-proxy-secret")).toBe("hop");
  });
});

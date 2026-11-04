import { afterEach, describe, expect, it, vi } from "vitest";

// A write through the proxy as the browser sends it: the hook in front of every route, then the
// proxy. The session cookies are SameSite=Lax, so a sibling subdomain (or, on the local binary,
// any other localhost port) could send them on a `no-cors` POST with a body no preflight ever
// questioned. Only a request this app's own pages could have made goes upstream.

vi.mock("$env/dynamic/private", () => ({ env: { RYPH_PROXY_SECRET: "hop" } }));
vi.mock("$app/environment", () => ({ dev: true }));
vi.mock("$lib/server/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("$lib/server/auth")>(),
  RYPH_API_URL: "http://api.test",
  RYPH_AUTOMATIONS_URL: "http://api.test",
  RYPH_CHAT_URL: "http://api.test",
  RYPH_HISTORY_URL: "http://api.test",
  RYPH_MCP_GATEWAY_CONTROL_URL: "http://api.test",
  RYPH_MEMORY_URL: "http://api.test",
  RYPH_MODEL_PROXY_CONTROL_URL: "http://api.test",
}));

import { handle } from "../../../hooks.server";
import { GET, POST } from "./+server";

const APP = "https://app.test";

function jwt(claims: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 600;
  return `${enc({ alg: "EdDSA" })}.${enc({ sub: "u-1", caps: ["*"], exp, ...claims })}.sig`;
}
const SESSION = jwt({ via: "session" });

/** Upstream calls, by method and path. */
function stubUpstream(): string[] {
  const sent: string[] = [];
  vi.stubGlobal("fetch", (url: URL, init: RequestInit) => {
    sent.push(`${init.method} ${new URL(url).pathname}`);
    return Promise.resolve(Response.json({ ok: true }, { status: 201 }));
  });
  return sent;
}

/** One request through the hook and the proxy, with the session cookie unless `cookie` is null. */
async function send(
  path: string,
  init: RequestInit & { headers?: Record<string, string> },
  cookie: string | null = SESSION,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie !== null) headers.set("cookie", `__Host-ryph_access_token=${cookie}`);
  const request = new Request(`${APP}${path}`, { ...init, headers });
  const url = new URL(request.url);
  const jar: Record<string, string | undefined> = cookie === null
    ? {}
    : { "__Host-ryph_access_token": cookie };
  const event = {
    request,
    url,
    route: { id: "/api/[...path]" },
    params: { path: path.replace(/^\/api\//, "") },
    cookies: { get: (name: string) => jar[name], set: () => {}, delete: () => {} },
    locals: {},
    getClientAddress: () => "127.0.0.1",
  };
  return await handle({
    // oxlint-disable-next-line no-explicit-any
    event: event as any,
    // oxlint-disable-next-line no-explicit-any
    resolve: (e: any) => (e.request.method === "GET" ? GET : POST)(e),
  });
}

const JSON_BODY = JSON.stringify({ name: "ci", caps: ["*"] });

afterEach(() => vi.unstubAllGlobals());

describe("a write through the proxy", () => {
  it("goes upstream from the app's own origin, as JSON", async () => {
    const sent = stubUpstream();
    const res = await send("/api/v1/auth/tokens", {
      method: "POST",
      headers: { origin: APP, "content-type": "application/json; charset=utf-8" },
      body: JSON_BODY,
    });
    expect(res.status).toBe(201);
    expect(sent).toEqual(["POST /v1/auth/tokens"]);
  });

  it("is refused from another origin on the same site, whatever it carries", async () => {
    const sent = stubUpstream();
    for (
      const origin of ["https://evil.app.test", "http://app.test", "https://app.test:8443", "null"]
    ) {
      const res = await send("/api/v1/auth/tokens", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON_BODY,
      });
      expect(res.status, origin).toBe(403);
    }
    expect(sent).toEqual([]);
  });

  it("is refused from the app's origin with a body that does not say it is JSON", async () => {
    const sent = stubUpstream();
    // A Blob with no type (no content-type at all) and a string (text/plain): what a `no-cors`
    // fetch can send, and what the services would have parsed as JSON anyway.
    for (const body of [new Blob([JSON_BODY]), JSON_BODY]) {
      const res = await send("/api/v1/auth/tokens", {
        method: "POST",
        headers: { origin: APP, "content-length": String(JSON_BODY.length) },
        body,
      });
      expect(res.status).toBe(403);
    }
    const form = await send("/api/v1/auth/tokens", {
      method: "POST",
      headers: { origin: APP, "content-type": "application/x-www-form-urlencoded" },
      body: "name=ci",
    });
    expect(form.status).toBe(403);
    expect(sent).toEqual([]);
  });

  it("is refused when nothing shows where it came from, and passes on Sec-Fetch-Site alone", async () => {
    const sent = stubUpstream();
    const json = { "content-type": "application/json" };
    expect(
      (await send("/api/v1/auth/tokens", { method: "POST", headers: json, body: JSON_BODY }))
        .status,
    ).toBe(403);
    expect(
      (await send("/api/v1/auth/tokens", {
        method: "DELETE",
        headers: { "sec-fetch-site": "same-site" },
      })).status,
    ).toBe(403);
    expect(
      (await send("/api/v1/auth/tokens", {
        method: "POST",
        headers: { ...json, "sec-fetch-site": "same-origin" },
        body: JSON_BODY,
      })).status,
    ).toBe(201);
    expect(sent).toEqual(["POST /v1/auth/tokens"]);
  });

  it("takes a run's image upload under its own image type, and only that", async () => {
    const sent = stubUpstream();
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const upload = (type: string) =>
      send("/api/v1/runs/r-1/attachments", {
        method: "POST",
        headers: { origin: APP, "content-type": type, "content-length": "4" },
        body: image,
      });
    expect((await upload("image/png")).status).toBe(201);
    expect((await upload("text/plain")).status).toBe(403);
    expect(sent).toEqual(["POST /v1/runs/r-1/attachments"]);
  });

  it("takes the CLI's token exchange: JSON, with no Origin and no cookie", async () => {
    const sent = stubUpstream();
    const exchange = (headers: Record<string, string>) =>
      send("/api/v1/auth/token", { method: "POST", headers, body: '{"token":"ryph_x"}' }, null);
    expect((await exchange({ "content-type": "application/json" })).status).toBe(201);
    // Not as text, which is what a page could have sent.
    expect((await exchange({ "content-type": "text/plain" })).status).toBe(403);
    expect(sent).toEqual(["POST /v1/auth/token"]);
  });

  it("leaves reads alone, wherever they come from", async () => {
    const sent = stubUpstream();
    expect((await send("/api/v1/tasks", { method: "GET" })).status).toBe(201);
    expect(sent).toEqual(["GET /v1/tasks"]);
  });

  it("leaves a bearer client without a cookie alone: the CLI sends no Origin", async () => {
    const sent = stubUpstream();
    const res = await send(
      "/api/v1/check-suites/bundle",
      {
        method: "POST",
        headers: {
          authorization: "Bearer cli-jwt",
          "content-type": "application/gzip",
          "content-length": "3",
        },
        body: new Uint8Array([1, 2, 3]),
      },
      null,
    );
    expect(res.status).toBe(201);
    expect(sent).toEqual(["POST /v1/check-suites/bundle"]);
    // A bearer beside the session cookie is a browser, and held to the rules.
    const both = await send("/api/v1/check-suites", {
      method: "POST",
      headers: { authorization: "Bearer cli-jwt", "content-type": "text/plain" },
      body: "{}",
    });
    expect(both.status).toBe(403);
  });
});

describe("the session endpoints", () => {
  it("hold a sign-in to the same rules: no logging someone in from a sibling origin", async () => {
    const refused = await handle({
      event: {
        request: new Request(`${APP}/auth/login`, {
          method: "POST",
          headers: { origin: "https://evil.app.test", "content-type": "application/json" },
          body: "{}",
        }),
        url: new URL(`${APP}/auth/login`),
        route: { id: "/auth/login" },
        // oxlint-disable-next-line no-explicit-any
      } as any,
      resolve: () => Promise.resolve(new Response("signed in")),
    });
    expect(refused.status).toBe(403);
  });
});

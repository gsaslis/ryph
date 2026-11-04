import { afterEach, describe, expect, it, vi } from "vitest";

// The proxy itself, against a stubbed upstream: whose bearer goes upstream, and that a request
// body travels as a stream rather than being read into memory first.

vi.mock("$env/dynamic/private", () => ({ env: { RYPH_PROXY_SECRET: "hop" } }));
vi.mock("$app/environment", () => ({ dev: true }));
// The real header helpers, with the upstreams pointed at test origins.
vi.mock("$lib/server/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("$lib/server/auth")>(),
  RYPH_API_URL: "http://api.test",
  RYPH_AUTOMATIONS_URL: "http://api.test",
  RYPH_CHAT_URL: "http://api.test",
  RYPH_HISTORY_URL: "http://history.test",
  RYPH_MCP_GATEWAY_CONTROL_URL: "http://mcp.test",
  RYPH_MEMORY_URL: "http://api.test",
  RYPH_MODEL_PROXY_CONTROL_URL: "http://api.test",
}));

import { upstreamAuthorization } from "./path";
import { GET, POST } from "./+server";

/** An unsigned JWT with these claims: the proxy reads the payload, and the services the signature. */
function jwt(claims: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "EdDSA" })}.${enc({ sub: "u-1", caps: ["*"], ...claims })}.sig`;
}
const SESSION_JWT = jwt({ via: "session" });
/** What an API token exchanges for: the bearer doors' business, never the cookie's. */
const TOKEN_JWT = jwt({ via: "token" });

type Sent = { url: string; init: RequestInit & { duplex?: string } };

function stubUpstream(): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", (url: URL, init: RequestInit) => {
    sent.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return sent;
}

function call(request: Request, accessToken?: string) {
  const url = new URL(request.url);
  const handler = request.method === "GET" ? GET : POST;
  // oxlint-disable-next-line no-explicit-any
  return handler({ request, url, locals: { accessToken } } as any);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("upstreamAuthorization", () => {
  it("sends the cookie's token when there is one, whatever the caller sent", () => {
    expect(upstreamAuthorization(SESSION_JWT, "Bearer other-jwt", "POST", "v1/check-suites"))
      .toBe(`Bearer ${SESSION_JWT}`);
    expect(upstreamAuthorization(SESSION_JWT, null, "GET", "v1/tasks")).toBe(
      `Bearer ${SESSION_JWT}`,
    );
  });

  it("forwards the caller's own bearer on the checks doors when there is no cookie token", () => {
    for (
      const [method, path] of [
        ["POST", "v1/check-suites"],
        ["POST", "v1/check-suites/bundle"],
        ["POST", "v1/check-delegations"],
        ["POST", "v1/check-delegations/bundle"],
        ["DELETE", "v1/check-delegations/cq-1"],
        ["GET", "v1/check-delegations/cq-1"],
        ["GET", "v1/check-suites/cs-1"],
        ["GET", "v1/check-suites/cs-1/log"],
        ["GET", "v1/check-requests/cq-1"],
        ["GET", "v1/check-delegations/declaration"],
      ]
    ) {
      expect(upstreamAuthorization(undefined, "Bearer cli-jwt", method, path), path)
        .toBe("Bearer cli-jwt");
    }
    expect(upstreamAuthorization(undefined, null, "GET", "v1/check-suites/cs-1")).toBeNull();
  });

  it("forwards it on the doors `ryph mcp` calls, each family's reads and writes", () => {
    for (
      const [method, path] of [
        ["GET", "v1/auth/me"],
        ["GET", "v1/tasks"],
        ["POST", "v1/tasks"],
        ["GET", "v1/tasks/t-1"],
        ["POST", "v1/tasks/t-1/cancel"],
        ["POST", "v1/tasks/t-1/finish"],
        ["POST", "v1/runs/r-1/messages"],
        ["GET", "v1/runs/r-1/events"],
        ["GET", "v1/runs/r-1/lanes"],
        ["GET", "v1/runs/r-1/background"],
        ["GET", "v1/runs/r-1/background/bg-1/log"],
        ["GET", "v1/runs/r-1/live/commands/stream"],
        ["GET", "v1/runs/r-1/previews"],
        ["POST", "v1/runs/r-1/previews/pv-1/open"],
        ["GET", "v1/mcp-usage/r-1"],
        ["GET", "v1/model-usage/runs/r-1"],
        ["GET", "v1/patches/p-1/diff"],
        ["POST", "v1/patches/p-1/approve"],
        ["POST", "v1/responses/rsp-1/close"],
        ["GET", "v1/check-suites"],
        ["POST", "v1/check-suites/cs-1/rerun"],
        ["GET", "v1/checks/repos"],
        ["PATCH", "v1/agents/a-1"],
        ["POST", "v1/connected-repos"],
        ["DELETE", "v1/connected-repos/cr-1/command-allowlist/octocat"],
        ["DELETE", "v1/workspaces/w-1/repos/cr-1"],
        ["GET", "v1/environments/e-1/log"],
        ["PUT", "v1/skills/settings"],
        ["POST", "v1/memory-proposals/resolve"],
        ["POST", "v1/memory-proposals/mp-1/accept"],
        ["PUT", "v1/command-rooms/ch-1"],
        ["POST", "v1/mcp-servers/m-1/probe"],
        ["DELETE", "v1/artifacts/a-1"],
        ["POST", "v1/automations/au-1/rotate-secret"],
      ]
    ) {
      expect(upstreamAuthorization(undefined, "Bearer cli-jwt", method, path), `${method} ${path}`)
        .toBe("Bearer cli-jwt");
    }
  });

  it("drops a caller's bearer everywhere else, and on the doors with another method", () => {
    for (
      const [method, path] of [
        // A run's own doors, which take its run token: never from the internet.
        ["GET", "v1/runs/r-1/credentials"],
        ["GET", "v1/runs/r-1/messages"],
        ["POST", "v1/runs/r-1/events"],
        ["POST", "v1/runs/r-1/live/commands"],
        ["POST", "v1/runs/r-1/heartbeat"],
        ["POST", "v1/runs/r-1/patches"],
        ["GET", "v1/runs/r-1/environment"],
        ["GET", "v1/runs/r-1/runner/previews"],
        ["PUT", "v1/runs/r-1/runner/background/bg-1/log"],
        ["GET", "v1/runs/r-1/artifacts/a-1"],
        ["GET", "v1/runs/r-1/checks"],
        // The forge's and the services' doors.
        ["POST", "v1/forge/git-keys/resolve"],
        ["POST", "v1/history/runs/r-1/verify"],
        ["POST", "v1/automations/events"],
        ["POST", "v1/chat/mentions"],
        ["POST", "v1/egress/refusals"],
        // Governing the instance: people, tokens, settings, keys, the allowlist, capacity.
        ["GET", "v1/auth/users"],
        ["POST", "v1/auth/tokens"],
        ["GET", "v1/auth/tokens"],
        ["POST", "v1/auth/invites"],
        ["PATCH", "v1/auth/settings"],
        ["PATCH", "v1/auth/me"],
        ["GET", "v1/auth/sessions"],
        ["GET", "v1/provider-keys"],
        ["POST", "v1/providers"],
        ["GET", "v1/model-usage"],
        ["PUT", "v1/egress"],
        ["PUT", "v1/reserved-capacity"],
        ["POST", "v1/images/pull"],
        ["POST", "v1/memory/embeddings/backfill"],
        // Not routes a tool calls.
        ["POST", "v1/runs/r-1/attachments"],
        ["GET", "v1/runs/r-1/attachments/at-1"],
        ["GET", "v1/runs/r-1/live/stream"],
        ["GET", "v1/runs/r-1/events/stream"],
        // A door's `:id` matching a route of its own: the task list's event stream.
        ["GET", "v1/tasks/stream"],
        // A door's method elsewhere, a door's path stretched.
        ["DELETE", "v1/check-suites/cs-1"],
        ["GET", "v1/check-delegations"],
        ["POST", "v1/checks/repos"],
        ["GET", "v1/checks/repos/extra"],
        ["DELETE", "v1/check-delegations"],
        ["POST", "v1/check-delegations/cq-1"],
        ["DELETE", "v1/check-delegations/cq-1/extra"],
        ["GET", "v1/check-delegations/cq-1/extra"],
        ["DELETE", "v1/tasks/t-1"],
        ["GET", "v1/tasks/t-1/cancel"],
        ["GET", "v1/runs/r-1/background/bg-1/log/x"],
        ["GET", "v1/patches/p-1/diff/x"],
        ["GET", "v1/agents/"],
        ["GET", "v1/runs//events"],
      ]
    ) {
      expect(
        upstreamAuthorization(undefined, "Bearer runner-jwt", method, path),
        `${method} ${path}`,
      )
        .toBeNull();
    }
  });

  it("drops anything that is not a bearer", () => {
    const door = ["POST", "v1/check-suites"] as const;
    expect(upstreamAuthorization(undefined, "Basic dXNlcjpwYXNz", ...door)).toBeNull();
    expect(upstreamAuthorization(undefined, "Bearer ", ...door)).toBeNull();
    expect(upstreamAuthorization(undefined, "Bearer a b", ...door)).toBeNull();
  });
});

describe("the session cookie", () => {
  it("is forwarded only when it carries a session's token", () => {
    expect(upstreamAuthorization(SESSION_JWT, null, "GET", "v1/tasks")).toBe(
      `Bearer ${SESSION_JWT}`,
    );
    // A non-door route: an API token's access token in the cookie would otherwise skip the doors.
    expect(upstreamAuthorization(TOKEN_JWT, null, "PUT", "v1/egress")).toBeNull();
    expect(upstreamAuthorization(TOKEN_JWT, null, "GET", "v1/tasks")).toBeNull();
    // Handed one directly, this function refuses it even beside a bearer header. In the real
    // flow the hook has already cleared `locals.accessToken` for such a cookie, so this never
    // arrives here and the caller's own bearer is forwarded on the doors as usual.
    expect(upstreamAuthorization(TOKEN_JWT, `Bearer ${TOKEN_JWT}`, "GET", "v1/tasks/t-1"))
      .toBeNull();
    expect(upstreamAuthorization(jwt({}), null, "GET", "v1/tasks")).toBeNull();
  });

  it("refuses a malformed cookie", () => {
    for (const junk of ["cookie-jwt", "a.b.c", "x.%%%.y", `x.${btoa("[]")}.y`, "..."]) {
      expect(upstreamAuthorization(junk, null, "GET", "v1/tasks"), junk).toBeNull();
    }
  });

  it("sends a token-carrying cookie upstream as no one, on a route off the doors", async () => {
    const sent = stubUpstream();
    await call(new Request("http://app.test/api/v1/memories"), TOKEN_JWT);
    expect(new Headers(sent[0].init.headers).has("authorization")).toBe(false);
  });
});

describe("the proxy", () => {
  it("forwards a caller's bearer when no cookie token is present", async () => {
    const sent = stubUpstream();
    const res = await call(
      new Request("http://app.test/api/v1/check-suites", {
        method: "POST",
        headers: { authorization: "Bearer cli-jwt", "content-type": "application/json" },
        body: JSON.stringify({ repo: "acme/api" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(sent[0].url).toBe("http://api.test/v1/check-suites");
    expect(new Headers(sent[0].init.headers).get("authorization")).toBe("Bearer cli-jwt");
  });

  it("forwards a runner path carrying a bearer with no authorization at all", async () => {
    const sent = stubUpstream();
    await call(
      new Request("http://app.test/api/v1/runs/r-1/credentials", {
        method: "POST",
        headers: { authorization: "Bearer runner-token" },
        body: "{}",
      }),
    );
    expect(sent[0].url).toBe("http://api.test/v1/runs/r-1/credentials");
    expect(new Headers(sent[0].init.headers).has("authorization")).toBe(false);
  });

  it("lets the cookie's token win over a caller's bearer", async () => {
    const sent = stubUpstream();
    await call(
      new Request("http://app.test/api/v1/check-suites", {
        method: "POST",
        headers: { authorization: "Bearer cli-jwt" },
        body: "{}",
      }),
      SESSION_JWT,
    );
    expect(new Headers(sent[0].init.headers).get("authorization")).toBe(`Bearer ${SESSION_JWT}`);
  });

  it("sends an image upload's raw bytes upstream untouched, with the type the browser gave", async () => {
    const sent = stubUpstream();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255]);
    await call(
      new Request("http://app.test/api/v1/runs/r-1/attachments", {
        method: "POST",
        headers: { "content-type": "image/png", "content-length": String(png.length) },
        body: png,
      }),
      SESSION_JWT,
    );
    const init = sent[0].init;
    expect(sent[0].url).toBe("http://api.test/v1/runs/r-1/attachments");
    expect(new Headers(init.headers).get("content-type")).toBe("image/png");
    expect(init.body).toBeInstanceOf(ReadableStream);
    const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
    expect([...bytes]).toEqual([...png]);
  });

  it("streams the request body upstream instead of buffering it", async () => {
    const sent = stubUpstream();
    const request = new Request("http://app.test/api/v1/check-suites/bundle?repo=acme%2Fapi", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "content-length": "5" },
      body: new Uint8Array([1, 2, 3, 4, 5]),
    });
    await call(request);
    const init = sent[0].init;
    expect(sent[0].url).toBe("http://api.test/v1/check-suites/bundle?repo=acme%2Fapi");
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect(init.duplex).toBe("half");
    expect(new Headers(init.headers).get("content-length")).toBe("5");
    const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
    expect([...bytes]).toEqual([1, 2, 3, 4, 5]);
  });

  it("sends a run's history reads and live stream to the historian, and nothing else", async () => {
    const sent = stubUpstream();
    for (
      const path of ["v1/runs/r-1/events", "v1/runs/r-1/events/stream", "v1/runs/r-1/live/stream"]
    ) {
      await call(new Request(`http://app.test/api/${path}`), SESSION_JWT);
    }
    await call(new Request("http://app.test/api/v1/runs/r-1/live", { method: "POST", body: "" }));
    await call(new Request("http://app.test/api/v1/runs/r-1/live"), SESSION_JWT);
    expect(sent.map((s) => s.url)).toEqual([
      "http://history.test/v1/runs/r-1/events",
      "http://history.test/v1/runs/r-1/events/stream",
      "http://history.test/v1/runs/r-1/live/stream",
      "http://api.test/v1/runs/r-1/live",
      "http://api.test/v1/runs/r-1/live",
    ]);
  });

  it("sends the client facts everywhere, and the proxy secret to the control plane only", async () => {
    const sent = stubUpstream();
    const request = (path: string) =>
      new Request(`http://app.test/api/${path}`, { headers: { "user-agent": "Firefox" } });
    await call(request("v1/runs/r-1/events"), SESSION_JWT);
    await call(request("v1/tasks"), SESSION_JWT);
    const [historian, controlPlane] = sent.map((s) => new Headers(s.init.headers));
    expect(historian.get("x-client-user-agent")).toBe("Firefox");
    expect(historian.get("x-ryph-proxy-secret")).toBeNull();
    expect(controlPlane.get("x-client-user-agent")).toBe("Firefox");
    expect(controlPlane.get("x-ryph-proxy-secret")).toBe("hop");
  });

  it("sends an MCP server's archive to the control plane, and the rest of its management to the gateway", async () => {
    const sent = stubUpstream();
    const post = (path: string) =>
      new Request(`http://app.test/api/${path}`, { method: "POST", body: "" });
    await call(post("v1/mcp-servers/ms-1/archive"), SESSION_JWT);
    await call(post("v1/mcp-servers/ms-1/probe"), SESSION_JWT);
    await call(new Request("http://app.test/api/v1/mcp-servers"), SESSION_JWT);
    expect(sent.map((s) => s.url)).toEqual([
      "http://api.test/v1/mcp-servers/ms-1/archive",
      "http://mcp.test/v1/mcp-servers/ms-1/probe",
      "http://mcp.test/v1/mcp-servers",
    ]);
    // The archive is the control plane's own route, so it carries the proxy secret.
    expect(new Headers(sent[0].init.headers).get("x-ryph-proxy-secret")).toBe("hop");
  });

  it("keeps the proxy secret from a service whose URL is the control plane's", async () => {
    // RYPH_MEMORY_URL is stubbed to RYPH_API_URL's own string, as an unset one falls back to.
    const sent = stubUpstream();
    await call(new Request("http://app.test/api/v1/memories"), SESSION_JWT);
    expect(sent[0].url).toBe("http://api.test/v1/memories");
    expect(new Headers(sent[0].init.headers).get("x-ryph-proxy-secret")).toBeNull();
  });
});

describe("what the proxy refuses before forwarding", () => {
  const status = async (request: Request) => {
    try {
      return (await call(request, SESSION_JWT)).status;
    } catch (e) {
      return (e as { status: number }).status;
    }
  };

  it("never serves an artifact version's document, however it is spelled", async () => {
    const sent = stubUpstream();
    for (
      const path of [
        "v1/artifacts/art-1/versions/2/content",
        "v1/artifacts/art-1/versions/2/content/",
        "v1/artifacts/x/versions/abc/content",
      ]
    ) {
      expect(await status(new Request(`http://app.test/api/${path}`)), path).toBe(404);
    }
    expect(sent).toEqual([]);
    // The artifact itself and its list still go through.
    await call(new Request("http://app.test/api/v1/artifacts/art-1"), SESSION_JWT);
    expect(sent.map((s) => s.url)).toEqual(["http://api.test/v1/artifacts/art-1"]);
  });

  it("refuses a navigation from another site, and only that", async () => {
    const sent = stubUpstream();
    const at = (site: string, mode: string) =>
      new Request("http://app.test/api/v1/me", {
        headers: { "sec-fetch-site": site, "sec-fetch-mode": mode },
      });
    expect(await status(at("cross-site", "navigate"))).toBe(403);
    expect(sent).toEqual([]);
    expect(await status(at("same-origin", "navigate"))).toBe(201);
    expect(await status(at("cross-site", "cors"))).toBe(201);
    expect(await status(at("same-origin", "cors"))).toBe(201);
    expect(await status(new Request("http://app.test/api/v1/me"))).toBe(201);
  });
});

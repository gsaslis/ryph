import { describe, expect, it, vi } from "vitest";

// The session cookie as the hook reads it: only a session's token becomes `locals.accessToken`,
// which the proxy, SSR loads, previews, artifacts and images all forward. An API token's
// exchanged access token put into the cookie would otherwise skip the proxy's bearer doors.

vi.mock("$env/dynamic/private", () => ({ env: { RYPH_PROXY_SECRET: "hop" } }));
vi.mock("$app/environment", () => ({ dev: true }));
vi.mock("$lib/server/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("$lib/server/auth")>(),
  sessionAlive: () => Promise.resolve(true),
  refreshTokenPair: () => Promise.reject(new Error("no refresh in this test")),
}));

import { handle } from "./hooks.server";

function jwt(claims: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 600;
  return `${enc({ alg: "EdDSA" })}.${
    enc({ sub: "u-1", email: "a@x.test", name: "A", caps: ["*"], exp, ...claims })
  }.sig`;
}

/** The `locals.accessToken` a request with this cookie reaches its route with. Over HTTPS the
 * session cookies carry the `__Host-` prefix; on a plain-HTTP origin they cannot, and do not. */
async function localsFor(
  path: string,
  cookie: string | undefined,
  refresh?: string,
  origin = "https://app.test",
) {
  const prefix = origin.startsWith("https:") ? "__Host-" : "";
  const jar: Record<string, string | undefined> = {
    [`${prefix}ryph_access_token`]: cookie,
    [`${prefix}ryph_refresh_token`]: refresh,
  };
  const locals: { accessToken?: string } = {};
  await handle({
    event: {
      url: new URL(`${origin}${path}`),
      route: { id: null },
      cookies: { get: (name: string) => jar[name], set: () => {}, delete: () => {} },
      locals,
      request: new Request(`${origin}${path}`),
      getClientAddress: () => "127.0.0.1",
    },
    resolve: () => Promise.resolve(new Response("ok")),
    // oxlint-disable-next-line no-explicit-any
  } as any);
  return locals.accessToken;
}

describe("the session cookie", () => {
  const session = jwt({ via: "session" });
  const token = jwt({ via: "token" });

  it("carries a session's token through, on the API and on pages", async () => {
    expect(await localsFor("/api/v1/tasks", session)).toBe(session);
    expect(await localsFor("/tasks", session, "refresh")).toBe(session);
  });

  it("is read under the name this origin's protocol gives it", async () => {
    expect(await localsFor("/api/v1/tasks", session, undefined, "http://localhost:3000"))
      .toBe(session);
  });

  it("is not read under the other protocol's name", async () => {
    // A plain `ryph_access_token` on an HTTPS origin is one a sibling subdomain could have set
    // for the parent domain; it is no session here.
    const locals: { accessToken?: string } = {};
    await handle({
      event: {
        url: new URL("https://app.test/api/v1/tasks"),
        route: { id: null },
        cookies: {
          get: (name: string) => (name === "ryph_access_token" ? session : undefined),
          set: () => {},
          delete: () => {},
        },
        locals,
        request: new Request("https://app.test/api/v1/tasks"),
        getClientAddress: () => "127.0.0.1",
      },
      resolve: () => Promise.resolve(new Response("ok")),
      // oxlint-disable-next-line no-explicit-any
    } as any);
    expect(locals.accessToken).toBeUndefined();
  });

  it("drops an API token's access token, everywhere", async () => {
    expect(await localsFor("/api/v1/memories", token)).toBeUndefined();
    expect(await localsFor("/previews/r-1/pv-1", token)).toBeUndefined();
    expect(await localsFor("/tasks", token, "refresh")).toBeUndefined();
  });

  it("drops a malformed cookie", async () => {
    for (const junk of ["cookie-jwt", "a.b.c", jwt({})]) {
      expect(await localsFor("/api/v1/tasks", junk), junk).toBeUndefined();
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/private", () => ({ env: { RYPH_PROXY_SECRET: "hop" } }));
vi.mock("$app/environment", () => ({ dev: true }));

import { POST } from "./+server";

function event(
  refreshToken: string | undefined = "refresh-token",
  origin = "http://localhost:3000",
) {
  return {
    request: new Request(`${origin}/auth/refresh`, {
      method: "POST",
      headers: { "user-agent": "Firefox" },
    }),
    url: new URL(`${origin}/auth/refresh`),
    locals: { refreshToken } as { refreshToken?: string },
    cookies: { set: vi.fn(), delete: vi.fn() },
    getClientAddress: () => "203.0.113.7",
  };
}
const post = (input: ReturnType<typeof event>) =>
  POST(input as unknown as Parameters<typeof POST>[0]);

afterEach(() => vi.unstubAllGlobals());

describe("/auth/refresh with real upstream auth helper", () => {
  it("preserves cookies when the upstream network request fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    const input = event();
    await expect(post(input)).rejects.toMatchObject({ status: 503 });
    expect(input.cookies.delete).not.toHaveBeenCalled();
    expect(input.cookies.set).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:7411/v1/auth/refresh");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ refreshToken: "refresh-token" });
  });

  it.each([429, 500, 502, 503, 504])("preserves cookies on upstream HTTP %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status })));
    const input = event();
    await expect(post(input)).rejects.toMatchObject({ status: 503 });
    expect(input.cookies.delete).not.toHaveBeenCalled();
    expect(input.cookies.set).not.toHaveBeenCalled();
  });

  it.each([401, 403])(
    "clears cookies only for explicit upstream rejection (%s)",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(Response.json({ error: "rejected" }, { status })),
      );
      const input = event();
      await expect(post(input)).rejects.toMatchObject({ status: 401 });
      expect(input.cookies.delete.mock.calls.map(([name, options]) => [name, options.path]))
        .toEqual([
          ["ryph_access_token", "/"],
          ["ryph_refresh_token", "/"],
        ]);
      expect(input.cookies.set).not.toHaveBeenCalled();
    },
  );

  it.each(["not json", "{}"])(
    "preserves cookies for malformed upstream success %s",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
      const input = event();
      await expect(post(input)).rejects.toMatchObject({ status: 503 });
      expect(input.cookies.delete).not.toHaveBeenCalled();
      expect(input.cookies.set).not.toHaveBeenCalled();
    },
  );

  it("rotates both cookies for a valid upstream session", async () => {
    const user = {
      id: "u-1",
      email: "a@b.c",
      name: "A",
      role: "owner",
      status: "active",
      emailVerifiedAt: null,
      unprovenEmail: null,
      resetRequestedAt: null,
      hasPassword: true,
      createdAt: "2026-10-13T00:00:00Z",
      updatedAt: "2026-10-13T00:00:00Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(Response.json({
          accessToken: "access-token",
          refreshToken: "rotated-refresh",
          expiresIn: 900,
          user,
        }))
      ),
    );
    const input = event();
    const response = await post(input);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user });
    expect(input.cookies.set.mock.calls.map(([name, value]) => [name, value])).toEqual([
      ["ryph_access_token", "access-token"],
      ["ryph_refresh_token", "rotated-refresh"],
    ]);
    expect(input.cookies.delete).not.toHaveBeenCalled();

    // Over HTTPS the same pair goes under `__Host-` names, which a browser holds to Secure,
    // Path=/ and no Domain, so no sibling subdomain can plant or shadow them.
    const secure = event("refresh-token", "https://ryph.example");
    await post(secure);
    expect(secure.cookies.set.mock.calls.map(([name, value, options]) => [
      name,
      value,
      options.secure,
      options.path,
      options.domain,
    ])).toEqual([
      ["__Host-ryph_access_token", "access-token", true, "/", undefined],
      ["__Host-ryph_refresh_token", "rotated-refresh", true, "/", undefined],
    ]);
  });

  it("rejects a missing refresh token without contacting upstream", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const input = event();
    input.locals.refreshToken = undefined;
    await expect(post(input)).rejects.toMatchObject({ status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

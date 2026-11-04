import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth", () => ({
  RYPH_API_URL: "http://api.test",
  sessionHeaders: () => ({ "x-client-ip": "203.0.113.7" }),
}));
vi.mock("$lib/utils/auth/jwt", () => ({
  getUserData: (token: string | undefined) => token === "good-jwt" ? { id: "u-1" } : null,
}));

import { GET } from "./+server";

async function call(token: string | undefined = "good-jwt", n = "2", id = "art_1", headers = {}) {
  return await GET(
    {
      request: new Request("https://ryph.test/artifacts/art_1/v/2/thumbnail", { headers }),
      params: { id, n },
      locals: { accessToken: token },
    } as Parameters<typeof GET>[0],
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("artifact thumbnail proxy", () => {
  it("streams PNG as the signed-in person, replacing upstream headers", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const upstream = vi.fn().mockResolvedValue(
      new Response(png, {
        headers: {
          etag: '"thumb-2"',
          "cache-control": "public, immutable",
          "set-cookie": "bad=1",
          "content-type": "image/png",
          "access-control-allow-origin": "*",
        },
      }),
    );
    vi.stubGlobal("fetch", upstream);
    const out = await call();
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(png);
    expect(out.status).toBe(200);
    const [url, init] = upstream.mock.calls[0];
    expect(String(url)).toBe("http://api.test/v1/artifacts/art_1/versions/2/thumbnail");
    expect(init.headers.get("authorization")).toBe("Bearer good-jwt");
    expect(init.headers.get("x-client-ip")).toBe("203.0.113.7");
    expect(init.redirect).toBe("manual");
    expect(Object.fromEntries(out.headers)).toEqual({
      "content-type": "image/png",
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer",
      etag: '"thumb-2"',
    });
  });

  it("revalidates a private cached image", async () => {
    const upstream = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 304,
        headers: { etag: '"thumb-2"' },
      }),
    );
    vi.stubGlobal("fetch", upstream);
    const out = await call("good-jwt", "2", "art_1", { "if-none-match": '"thumb-2"' });
    expect(upstream.mock.calls[0][1].headers.get("if-none-match")).toBe('"thumb-2"');
    expect(out.status).toBe(304);
    expect(out.headers.get("etag")).toBe('"thumb-2"');
    expect(out.headers.get("cache-control")).toBe("private, no-cache");
    expect(out.headers.get("content-type")).toBeNull();
    expect(await out.text()).toBe("");
  });

  it("refuses missing/expired sessions and invalid versions locally without redirects", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    for (const token of ["", "expired"]) {
      const out = await call(token);
      expect(out.status).toBe(401);
      expect(out.headers.get("location")).toBeNull();
    }
    for (const n of ["0", "-1", "1.5", "abc", "01"]) {
      expect((await call("good-jwt", n)).status).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([[401, 401], [403, 404], [404, 404], [503, 503], [500, 502], [302, 502]])(
    "maps upstream %s to %s, without forwarding its body or redirect",
    async (status, expected) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response("private error", {
            status,
            headers: { location: "/login" },
          }),
        ),
      );
      const out = await call();
      expect(out.status).toBe(expected);
      expect(out.headers.get("location")).toBeNull();
      expect(out.headers.get("cache-control")).toBe("private, no-cache");
      expect(await out.text()).toBe("");
    },
  );

  it("refuses a successful upstream response that is not PNG", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>error</html>", {
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    expect((await call()).status).toBe(502);
  });

  it("answers 502 to network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect((await call()).status).toBe(502);
  });

  it("encodes the artifact id as one path segment", async () => {
    const upstream = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", upstream);
    await call("good-jwt", "2", "../../runs");
    expect(String(upstream.mock.calls[0][0])).toBe(
      "http://api.test/v1/artifacts/..%2F..%2Fruns/versions/2/thumbnail",
    );
  });
});

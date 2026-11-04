import { describe, expect, it, vi } from "vitest";
import { isImmutableAsset, isSafeAssetPath, serveAssetFromFallback } from "./asset-fallback";

const BASE = "https://storage.googleapis.com/acme-assets";
const CHUNK = "/_app/immutable/chunks/BndRyUmO.js";

const ok = () =>
  vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(
      new Response("export const a = 1;", {
        status: 200,
        headers: { "content-type": "text/javascript" },
      }),
    )
  );

describe("isImmutableAsset", () => {
  it("claims the built chunks and nothing else", () => {
    expect(isImmutableAsset(CHUNK)).toBe(true);
    expect(isImmutableAsset("/_app/version.json")).toBe(false);
    expect(isImmutableAsset("/agents")).toBe(false);
    expect(isImmutableAsset("/api/v1/runs")).toBe(false);
  });
});

describe("isSafeAssetPath", () => {
  it("refuses anything that could read outside the prefix", () => {
    expect(isSafeAssetPath(CHUNK)).toBe(true);
    // A pathname only reaches the hook after URL normalisation, but the cost of trusting that
    // is reading an arbitrary object, so the encoded forms are refused too.
    expect(isSafeAssetPath("/_app/immutable/../../secrets")).toBe(false);
    expect(isSafeAssetPath("/_app/immutable/%2e%2e/x.js")).toBe(false);
    expect(isSafeAssetPath("/_app/immutable/a%2Fb.js")).toBe(false);
    expect(isSafeAssetPath("/_app/immutable//double.js")).toBe(false);
    expect(isSafeAssetPath("/_app/immutable/a\\b.js")).toBe(false);
    expect(isSafeAssetPath("/etc/passwd")).toBe(false);
  });
});

describe("serveAssetFromFallback", () => {
  it("signs its request when given a credential", async () => {
    const fetchImpl = ok();
    await serveAssetFromFallback(CHUNK, {
      baseUrl: BASE,
      credentials: { accessKeyId: "GOOG1EID", secretAccessKey: "shh", region: "auto" },
      now: () => new Date("2026-09-18T20:15:30.000Z"),
      fetchImpl,
    });

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toContain(
      "AWS4-HMAC-SHA256 Credential=GOOG1EID/20260918/auto/s3",
    );
    expect(headers["x-amz-date"]).toBe("20260918T201530Z");
  });

  it("reads anonymously when given none", async () => {
    const fetchImpl = ok();
    await serveAssetFromFallback(CHUNK, { baseUrl: BASE, fetchImpl });

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({});
  });

  it("serves the chunk from the bucket and marks it immutable", async () => {
    const fetchImpl = ok();
    const res = await serveAssetFromFallback(CHUNK, { baseUrl: BASE, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(`${BASE}${CHUNK}`, expect.anything());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect(await res.text()).toBe("export const a = 1;");
  });

  it("tolerates a trailing slash on the base", async () => {
    const fetchImpl = ok();
    await serveAssetFromFallback(CHUNK, { baseUrl: `${BASE}/`, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(`${BASE}${CHUNK}`, expect.anything());
  });

  it("404s without reaching for the bucket when none is configured", async () => {
    const fetchImpl = ok();
    const res = await serveAssetFromFallback(CHUNK, { baseUrl: undefined, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
  });

  it("404s on an unsafe path without reaching for the bucket", async () => {
    const fetchImpl = ok();
    const res = await serveAssetFromFallback("/_app/immutable/%2e%2e/x", {
      baseUrl: BASE,
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
  });

  it("404s rather than throwing when the bucket is unreachable", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("network down")));
    const res = await serveAssetFromFallback(CHUNK, { baseUrl: BASE, fetchImpl });
    expect(res.status).toBe(404);
  });

  it("404s when the bucket does not have the chunk either", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("no", { status: 404 })));
    const res = await serveAssetFromFallback(CHUNK, { baseUrl: BASE, fetchImpl });
    expect(res.status).toBe(404);
  });

  it("prefers the brotli sibling and labels it for the browser", async () => {
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith(".br")
          ? new Response("compressed", {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          })
          : new Response("plain", { status: 200 }),
      )
    );

    const res = await serveAssetFromFallback(CHUNK, {
      baseUrl: BASE,
      acceptEncoding: "gzip, deflate, br, zstd",
      // oxlint-disable-next-line no-explicit-any
      fetchImpl: fetchImpl as any,
    });

    expect(fetchImpl).toHaveBeenCalledWith(`${BASE}${CHUNK}.br`, expect.anything());
    expect(res.headers.get("content-encoding")).toBe("br");
    // Not the sibling's own type, which describes the wrapper rather than the chunk.
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("vary")).toBe("accept-encoding");
  });

  it("takes gzip when brotli is not on offer", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("z", { status: 200 })));
    await serveAssetFromFallback(CHUNK, {
      baseUrl: BASE,
      acceptEncoding: "gzip, deflate",
      // oxlint-disable-next-line no-explicit-any
      fetchImpl: fetchImpl as any,
    });
    expect(fetchImpl).toHaveBeenCalledWith(`${BASE}${CHUNK}.gz`, expect.anything());
  });

  it("falls back to the plain object when the bucket has no compressed sibling", async () => {
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith(".br")
          ? new Response("gone", { status: 404 })
          : new Response("plain", { status: 200, headers: { "content-type": "text/javascript" } }),
      )
    );

    const res = await serveAssetFromFallback(CHUNK, {
      baseUrl: BASE,
      acceptEncoding: "br",
      // oxlint-disable-next-line no-explicit-any
      fetchImpl: fetchImpl as any,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe("plain");
  });

  it("asks only for the plain object when the client takes no encoding", async () => {
    const fetchImpl = ok();
    await serveAssetFromFallback(CHUNK, { baseUrl: BASE, acceptEncoding: null, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(`${BASE}${CHUNK}`, expect.anything());
  });

  it("never turns a missing chunk into a 5xx", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("boom", { status: 500 })));
    const res = await serveAssetFromFallback(CHUNK, { baseUrl: BASE, fetchImpl });
    expect(res.status).toBe(404);
  });
});

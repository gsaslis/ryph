import { describe, expect, it } from "vitest";
import { ApiError } from "./call";
import { getModelAccess, isSecretRequired } from "./provider-keys";

// A deployment may run without model access. That is a configuration choice, not a fault, and the
// pages that ask for provider keys must open anyway — this is the seam where "turned off" would
// otherwise reach a page `load` as an uncaught throw and render a 500.

const respond = (status: number, body: unknown) => () =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

describe("getModelAccess", () => {
  it("reads the keys when the surface is live", async () => {
    const key = {
      id: "pk-1",
      provider: "anthropic",
      label: "team",
      last4: "abcd",
      archivedAt: null,
      createdAt: "2026-07-16T12:00:00.000Z",
      updatedAt: "2026-07-16T12:00:00.000Z",
    };
    const fetch = respond(200, { providerKeys: [key] }) as unknown as typeof globalThis.fetch;

    expect(await getModelAccess(fetch)).toEqual({ modelAccessEnabled: true, providerKeys: [key] });
  });

  it("folds a disabled surface into an empty, disabled result", async () => {
    const fetch = respond(503, {
      error: "model access not configured",
      code: "model_access_disabled",
    }) as unknown as typeof globalThis.fetch;

    expect(await getModelAccess(fetch)).toEqual({ modelAccessEnabled: false, providerKeys: [] });
  });

  it("still throws on a broken control plane", async () => {
    const fetch = respond(503, {
      error: "upstream unavailable",
    }) as unknown as typeof globalThis.fetch;

    await expect(getModelAccess(fetch)).rejects.toThrow("upstream unavailable");
  });
});

describe("isSecretRequired", () => {
  it("knows the proxy's answer to a key saved while its endpoint moved", () => {
    expect(isSecretRequired(new ApiError(409, { code: "secret_required", error: "x" }, "x"))).toBe(
      true,
    );
  });

  it("does not mistake another conflict or a non-API error for it", () => {
    expect(isSecretRequired(new ApiError(409, { code: "other" }, "x"))).toBe(false);
    expect(isSecretRequired(new ApiError(400, { code: "secret_required" }, "x"))).toBe(false);
    expect(isSecretRequired(new Error("secret_required"))).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/private", () => ({ env: {} }));

import { checkProxySecret, PROXY_SECRET_HEADER } from "./auth";

describe("the proxy secret", () => {
  it("rides on the header @ryph/auth reads (its PROXY_SECRET_HEADER, held to the same literal)", () => {
    expect(PROXY_SECRET_HEADER).toBe("x-ryph-proxy-secret");
  });

  it("is required to start a built server", () => {
    expect(() => checkProxySecret(false, undefined)).toThrow(/RYPH_PROXY_SECRET is unset/);
    expect(() => checkProxySecret(false, "")).toThrow(/RYPH_PROXY_SECRET is unset/);
    expect(() => checkProxySecret(false, "hop")).not.toThrow();
  });

  it("only warns under vite dev", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => checkProxySecret(true, undefined)).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

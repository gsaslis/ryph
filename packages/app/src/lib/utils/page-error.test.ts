import { describe, expect, it, vi } from "vitest";
import { ApiError } from "$lib/api/call";
import { describeError, scopeFor } from "./page-error";

describe("describeError", () => {
  it("passes a control-plane refusal's own status and words through", () => {
    const e = new ApiError(404, { error: "no such task" }, "no such task");
    expect(describeError(e, 500, "Internal Error")).toEqual({
      message: "no such task",
      status: 404,
    });
  });

  it("keeps SvelteKit's placeholder for our own exceptions, and logs them", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(describeError(new TypeError("x is undefined"), 500, "Internal Error")).toEqual({
      message: "Internal Error",
      status: 500,
    });
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it("does not log a 4xx", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    describeError(new ApiError(403, null, "forbidden"), 500, "Internal Error");
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("scopeFor", () => {
  it("names the thing a detail route shows, and its list", () => {
    expect(scopeFor("/(app)/repos/[id]")).toEqual({
      noun: "repository",
      back: { href: "/repos", label: "All repos" },
    });
  });

  it("matches an edit flow under a detail route by prefix", () => {
    expect(scopeFor("/(flows)/agents/[id]/edit").noun).toBe("agent");
  });

  it("takes the longer of two overlapping routes", () => {
    expect(scopeFor("/(app)/memory/sources/[id]").noun).toBe("memory source");
    expect(scopeFor("/(app)/memory/[id]").noun).toBe("memory");
  });

  it("lets a failed welcome flow be skipped, since the app would send an admin back to it", () => {
    const back = scopeFor("/(flows)/welcome").back;
    expect(back?.href).toBe("/agents");
    expect(back?.label).toBe("Skip setup");
    expect(back?.onclick).toBeTypeOf("function");
  });

  it("falls back to the app when no route matched", () => {
    expect(scopeFor(null)).toEqual({ noun: "page", back: { href: "/", label: "Go home" } });
  });
});

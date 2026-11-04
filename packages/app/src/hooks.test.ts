import { describe, expect, it } from "vitest";
import { reroute } from "./hooks";

// oxlint-disable-next-line no-explicit-any
const at = (path: string) => (reroute as any)({ url: new URL(`https://ryph.test${path}`) });

describe("reroute", () => {
  it("moves a build chunk off /_app/, past the 404 SvelteKit answers there before any hook", () => {
    const to = at("/_app/immutable/chunks/BndRyUmO.js");
    expect(to).toBe("/__asset-fallback/chunks/BndRyUmO.js");
    // The whole point: SvelteKit's short-circuit is `resolved_path.startsWith("/_app")`.
    expect(to.startsWith("/_app")).toBe(false);
  });

  it("keeps the rest of the path, so the rewritten request still names one chunk", () => {
    expect(at("/_app/immutable/entry/start._IaisOYN.js")).toBe(
      "/__asset-fallback/entry/start._IaisOYN.js",
    );
    expect(at("/_app/immutable/assets/0.CPoc2Jb7.css")).toBe(
      "/__asset-fallback/assets/0.CPoc2Jb7.css",
    );
  });

  it("leaves everything else under /_app/ to SvelteKit", () => {
    // Not content-addressed, not published to the bucket: they must keep SvelteKit's own answers.
    expect(at("/_app/version.json")).toBeUndefined();
    expect(at("/_app/env.js")).toBeUndefined();
  });

  it("leaves pages and the API alone", () => {
    expect(at("/")).toBeUndefined();
    expect(at("/agents")).toBeUndefined();
    expect(at("/api/v1/runs")).toBeUndefined();
    expect(at("/_app")).toBeUndefined();
  });
});

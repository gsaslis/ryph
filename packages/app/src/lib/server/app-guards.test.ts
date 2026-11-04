import { describe, expect, it } from "vitest";
import {
  APP_CSP,
  ARTIFACT_CONTENT_PATH,
  ARTIFACT_THUMBNAIL_PATH,
  withAppGuards,
} from "./app-guards";

describe("withAppGuards", () => {
  it("keeps other sites out of the app's frames and the app out of theirs", () => {
    expect(APP_CSP).toBe("frame-ancestors 'self'; frame-src 'self'");
    for (const path of ["/", "/tasks/t-1", "/artifacts/art-1", "/api/v1/me", "/login"]) {
      const out = withAppGuards(path, new Response("x"));
      expect(out.headers.get("content-security-policy"), path).toBe(APP_CSP);
      expect(out.headers.get("cross-origin-opener-policy"), path).toBe("same-origin");
    }
  });

  it("adds its policy next to one a proxied response already has", () => {
    const res = new Response("x", { headers: { "content-security-policy": "sandbox" } });
    const out = withAppGuards("/api/v1/runs/r/images/i", res);
    expect(out.headers.get("content-security-policy")).toBe(`sandbox, ${APP_CSP}`);
  });

  it("leaves an artifact's content to its own policy", () => {
    const res = new Response("x", { headers: { "content-security-policy": "sandbox" } });
    const out = withAppGuards("/artifacts/art-1/v/2/content", res);
    expect(out.headers.get("content-security-policy")).toBe("sandbox");
    expect(out.headers.get("cross-origin-opener-policy")).toBeNull();
  });

  it("copies a response whose headers cannot change", () => {
    const upstream = Response.redirect("https://ryph.test/x", 302);
    const out = withAppGuards("/", upstream);
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe("https://ryph.test/x");
    expect(out.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  });

  it("recognizes thumbnail session passthrough without exempting it from app guards", () => {
    const path = "/artifacts/art-1/v/2/thumbnail";
    expect(ARTIFACT_THUMBNAIL_PATH.test(path)).toBe(true);
    expect(ARTIFACT_THUMBNAIL_PATH.test(`${path}/`)).toBe(true);
    expect(ARTIFACT_THUMBNAIL_PATH.test("/artifacts/a/b/v/2/thumbnail")).toBe(false);
    expect(ARTIFACT_THUMBNAIL_PATH.test("/artifacts/art-1/v/2/content")).toBe(false);
    expect(ARTIFACT_CONTENT_PATH.test(path)).toBe(false);
    expect(withAppGuards(path, new Response(null)).headers.get("content-security-policy")).toBe(
      APP_CSP,
    );
  });

  it("knows the content route by its shape", () => {
    expect(ARTIFACT_CONTENT_PATH.test("/artifacts/art-1/v/2/content")).toBe(true);
    expect(ARTIFACT_CONTENT_PATH.test("/artifacts/art-1")).toBe(false);
    expect(ARTIFACT_CONTENT_PATH.test("/artifacts/a/b/v/2/content")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { faviconSvg, faviconUri } from "./favicon";

describe("faviconSvg", () => {
  it("draws the mark in a blob, square and 32px", () => {
    const svg = faviconSvg();
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="[^"]+"/);
    expect(svg).toContain('width="32" height="32"');
    const [, , w, h] = svg.match(/viewBox="([^"]+)"/)![1].split(" ").map(Number);
    expect(w).toBe(h);
    // Two coats of the blob, and the R.
    expect(svg.match(/<path /g)).toHaveLength(3);
  });

  it("is a different blob each time", () => {
    expect(faviconSvg()).not.toBe(faviconSvg());
  });

  it("is the same drawing for the same blob", () => {
    const waves = [{ k: 2, size: 0.09, phase: 1 }, { k: 3, size: 0.04, phase: 2 }];
    expect(faviconSvg(waves)).toBe(faviconSvg(waves));
  });
});

describe("faviconUri", () => {
  it("is an SVG data URI", () => {
    const uri = faviconUri();
    expect(uri.startsWith("data:image/svg+xml;utf8,")).toBe(true);
    expect(decodeURIComponent(uri.slice(uri.indexOf(",") + 1))).toContain("<title>Ryph</title>");
  });
});

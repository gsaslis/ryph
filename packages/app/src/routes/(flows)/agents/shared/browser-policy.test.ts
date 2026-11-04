import { describe, expect, it } from "vitest";
import { browserLocked, browserUnavailableNote, createBrowserEnabled } from "./browser-policy";

describe("browserLocked", () => {
  it("holds a switch that is off for anyone who may not grant it", () => {
    expect(browserLocked(false, false)).toBe(true);
  });

  it("leaves a switch that is on movable, so it can be turned off", () => {
    expect(browserLocked(true, false)).toBe(false);
  });

  it("never holds it for an administrator", () => {
    expect(browserLocked(false, true)).toBe(false);
    expect(browserLocked(true, true)).toBe(false);
  });
});

describe("createBrowserEnabled", () => {
  it("sends the switch as left when the form offered it", () => {
    expect(createBrowserEnabled(true, { offered: true, canGrant: true })).toBe(true);
    expect(createBrowserEnabled(false, { offered: true, canGrant: true })).toBe(false);
  });

  it("sends false once a harness without a browser hid a switch that was on", () => {
    expect(createBrowserEnabled(true, { offered: false, canGrant: true })).toBe(false);
  });

  it("sends false for anyone who may not grant a browser", () => {
    expect(createBrowserEnabled(true, { offered: true, canGrant: false })).toBe(false);
  });
});

describe("browserUnavailableNote", () => {
  const harness = (
    browserUnavailable: "harness" | "provisioner" | "image" | null,
  ) => ({ browser: browserUnavailable === null, browserUnavailable });

  it("says nothing where the harness can have one", () => {
    expect(browserUnavailableNote(harness(null))).toBeNull();
  });

  it("says the runner cannot launch one", () => {
    expect(browserUnavailableNote(harness("provisioner"))).toBe(
      "Not available with this deployment's runner.",
    );
  });

  it("tells a missing browser apart from a harness that can't use one", () => {
    expect(browserUnavailableNote(harness("image"))).toBe("This deployment has no browser set up.");
    expect(browserUnavailableNote(harness("harness"))).toBe("This harness can't use a browser.");
  });

  it("falls back to one plain line when the control plane gives no reason", () => {
    expect(browserUnavailableNote({ browser: false, browserUnavailable: null }))
      .toBe("This deployment can't give this agent a browser.");
  });
});

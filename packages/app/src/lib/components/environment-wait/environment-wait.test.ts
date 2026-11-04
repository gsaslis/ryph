import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import EnvironmentWait from "./environment-wait.svelte";

describe("environment wait", () => {
  it("links to the build even before its progress has loaded", () => {
    const { body } = render(EnvironmentWait, {
      props: { environmentId: "env-waiting", build: null, now: 0, onstart: () => {} },
    });
    expect(body).toContain('href="/builds/env-waiting"');
    expect(body).toContain("View build");
    expect(body).not.toContain('target="_blank"');
    expect(body).not.toContain("Full log");
    expect(body).toContain("Start without waiting");
    expect(body).toContain("may be missing");
  });

  it("disables the bypass while starting without disabling build navigation", () => {
    const { body } = render(EnvironmentWait, {
      props: {
        environmentId: "env-waiting",
        build: null,
        now: 0,
        starting: true,
        onstart: () => {},
      },
    });
    expect(body).toMatch(/<button[^>]*disabled/);
    expect(body).toContain('href="/builds/env-waiting"');
  });
});

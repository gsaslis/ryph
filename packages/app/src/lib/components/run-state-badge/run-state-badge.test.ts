import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import RunStateBadge from "./run-state-badge.svelte";

describe("RunStateBadge", () => {
  it("does not repeat the running state as its phase", () => {
    const { body } = render(RunStateBadge, { props: { state: "running", phase: "running" } });
    expect(body).toContain("Running");
    expect(body).not.toContain("·");
  });

  it("keeps a distinct active phase", () => {
    const { body } = render(RunStateBadge, { props: { state: "running", phase: "finalizing" } });
    expect(body).toContain("· finalizing");
  });

  it("omits the phase once the run has settled", () => {
    const { body } = render(RunStateBadge, { props: { state: "succeeded", phase: "finalizing" } });
    expect(body).toContain("Success");
    expect(body).not.toContain("finalizing");
  });
});

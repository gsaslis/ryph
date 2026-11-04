import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import RunComposer from "./run-composer.svelte";

const props = {
  runId: "run-1",
  draftKey: "test-draft",
  agentName: "Ada",
  onSend: () => Promise.resolve(),
  contextUsage: {
    status: "ready" as const,
    tokens: 60_000,
    contextWindow: 200_000,
    percent: 30,
  },
};

describe("composer context gauge", () => {
  it("shows the docked gauge outside the composer form, to its right", () => {
    const { body } = render(RunComposer, { props });
    expect(body).toContain('data-align="inline-end"');
    expect(body).toContain("Context usage: 30%");
    expect(body).toContain("flex items-end gap-2");
    expect(body).toContain("h-[calc(1lh+1rem+2px)]");
    expect(body.indexOf("Context usage: 30%")).toBeGreaterThan(body.indexOf("</form>"));
  });

  it("uses the same ghost icon button styling for composer actions and the gauge", () => {
    const { body } = render(RunComposer, {
      props: { ...props, prefill: { text: "A draft", files: [] } },
    });
    const buttons = ["Add images", "Send", "Context usage: 30%"].map((label) => {
      const tag = body.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
      return tag?.match(/class="([^"]*)"/)?.[1];
    });
    expect(buttons[0]).toBeTruthy();
    expect(buttons[0]).toBe(buttons[2]);
    expect(buttons[1]).toBe(buttons[2]);
  });

  it("never shows the gauge on the initial task prompt, even with usage supplied", () => {
    const { body } = render(RunComposer, { props: { ...props, variant: "prompt" } });
    expect(body).toContain("What would you like Ada to do?");
    expect(body).not.toContain("Context usage");
  });

  it("distinguishes unavailable usage from a composer that has no model", () => {
    const unavailable = render(RunComposer, { props: { ...props, contextUsage: null } });
    expect(unavailable.body).toContain("Context usage unavailable");
    const hidden = render(RunComposer, { props: { ...props, contextUsage: undefined } });
    expect(hidden.body).not.toContain("Context usage");
  });
});

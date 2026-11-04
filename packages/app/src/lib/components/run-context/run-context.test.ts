import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import RunContext from "./run-context.svelte";

describe("RunContext", () => {
  it("labels the ring with current context usage and clamps overflow visually", () => {
    const { body } = render(RunContext, {
      props: {
        usage: { status: "ready", tokens: 210_000, contextWindow: 200_000, percent: 105 },
      },
    });
    expect(body).toContain("Context usage: 105%");
    expect(body).toContain('stroke-dasharray="100 100"');
    expect(body).not.toContain("animate-spin");
    expect(body).toContain('class="text-context-usage"');
    expect(body).not.toContain('class="text-primary"');
  });

  it("keeps the empty track distinct from the expanded trigger's muted background", () => {
    const { body } = render(RunContext, { props: { usage: null } });
    expect(body).toContain('class="text-muted-foreground/50"');
    expect(body).not.toContain('class="text-muted"');
  });

  it.each(
    [
      [null, "Context usage unavailable"],
      ["compacting", "Compacting context…"],
      ["recalculating", "Recalculating…"],
    ] as const,
  )("does not present %s as zero usage", (status, label) => {
    const { body } = render(RunContext, {
      props: {
        usage: status === null
          ? null
          : { status, tokens: null, percent: null, contextWindow: 200_000 },
      },
    });
    expect(body).toContain(label);
    expect(body).not.toContain("Context usage: 0%");
    expect(body).not.toContain("stroke-dasharray");
  });
});

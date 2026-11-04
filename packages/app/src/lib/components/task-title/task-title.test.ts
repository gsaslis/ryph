import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import { AWAITING_PROMPT_LABEL } from "$lib/utils/task-prompt";
import TaskTitle from "./task-title.svelte";

describe("task title", () => {
  it("keeps one accessible title and hides the measuring and animated copies", () => {
    const { body } = render(TaskTitle, { props: { title: "A clearer title" } });
    expect(body).toContain('<span class="sr-only">A clearer title</span>');
    expect(body.match(/aria-hidden="true"/g)).toHaveLength(2);
  });

  it("names a task waiting for instructions", () => {
    const { body } = render(TaskTitle, { props: { title: null, compact: true } });
    expect(body).toContain(`<span class="sr-only">${AWAITING_PROMPT_LABEL}</span>`);
    expect(body).toContain("italic font-normal");
  });

  it("clamps both visual copies in the list, but not the headline", () => {
    const props = { title: "A long title that should wrap naturally" };
    const compact = render(TaskTitle, { props: { ...props, compact: true } }).body;
    const headline = render(TaskTitle, { props }).body;
    expect(compact.match(/line-clamp-2/g)).toHaveLength(2);
    expect(headline).not.toContain("line-clamp-2");
  });

  it("starts with natural height and disables height animation for reduced motion", () => {
    const { body } = render(TaskTitle, { props: { title: "A title" } });
    expect(body).not.toMatch(/style="[^"]*height:/);
    expect(body).toContain("motion-reduce:transition-none");
  });
});

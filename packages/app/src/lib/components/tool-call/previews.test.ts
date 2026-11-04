import { render } from "svelte/server";
import { expect, it } from "vitest";
import type { ToolCall } from "$lib/api/tools";
import PreviewHarness from "./preview-test-harness.svelte";

const preview = {
  id: "a".repeat(32),
  port: 5173,
  label: "App server",
  url: `http://${"a".repeat(32)}.localhost:12345`,
};
const output = `Open preview: ${preview.url}\nAvailable on this machine.`;
const call = {
  seq: 1,
  runId: "r-1",
  at: "2026-10-08T12:00:00.000Z",
  name: "ryph__expose_port",
  resultText: output,
  useText: null,
  isError: false,
  done: true,
  view: {
    kind: "mcp",
    server: "ryph",
    tool: "expose_port",
    args: { port: preview.port, label: preview.label },
    output,
  },
  images: { kept: [], notKept: 0 },
} as ToolCall;

const opener = `/previews/r-0123456789/${preview.id}?grant=proof&amp;task=t-1`;

it("offers an inline action for a currently registered preview", () => {
  const { body } = render(PreviewHarness, { props: { call, previews: [preview] } });
  expect(body).toContain("Exposed a preview");
  expect(body).toContain("App server · :5173");
  expect(body).toContain(`href="${opener}"`);
  expect(body).not.toContain(`href="${preview.url}"`);
  expect(body).toContain('target="_blank"');
  expect(body).toContain('rel="noopener noreferrer"');
  expect(body).toContain("Open preview");
  expect(body).toContain("text-muted-foreground relative h-5");
});

it("keeps historical calls but does not link missing or replaced previews", () => {
  for (const previews of [[], [{ ...preview, url: preview.url.replace("12345", "23456") }]]) {
    const { body } = render(PreviewHarness, { props: { call, previews } });
    expect(body).not.toContain("/previews/");
    expect(body).toContain("Preview unavailable");
  }
  const { body } = render(PreviewHarness, { props: { call, previews: [], ended: true } });
  expect(body).toContain("Preview ended");
});

it("does not offer a stale link while discovery is unavailable", () => {
  const { body } = render(PreviewHarness, {
    props: { call, previews: [preview], available: false },
  });
  expect(body).not.toContain("/previews/");
  expect(body).toContain("Preview unavailable");
});

it("does not offer a link for failed exposure", () => {
  const { body } = render(PreviewHarness, {
    props: { call: { ...call, isError: true }, previews: [preview] },
  });
  expect(body).not.toContain("/previews/");
});

it("links a hosted preview the same way", () => {
  const hosted = { ...preview, url: `https://${preview.id}.preview.cell.example` };
  const reply = `Open preview: ${hosted.url}\nPeople who can see this run can open it.`;
  const hostedCall = {
    ...call,
    resultText: reply,
    view: { ...call.view, output: reply },
  } as ToolCall;
  const { body } = render(PreviewHarness, { props: { call: hostedCall, previews: [hosted] } });
  expect(body).toContain(`href="${opener}"`);
  const other = { ...hosted, url: `https://${"b".repeat(32)}.preview.cell.example` };
  expect(render(PreviewHarness, { props: { call: hostedCall, previews: [other] } }).body)
    .toContain("Preview unavailable");
});

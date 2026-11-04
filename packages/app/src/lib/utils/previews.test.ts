import { expect, it } from "vitest";
import type { ToolCall } from "$lib/api/tools";
import {
  isLocalPreviewUrl,
  openablePreviewUrl,
  previewCallOf,
  previewHref,
  RUN_ID,
  taskPath,
} from "./previews";

const url = `http://${"a".repeat(32)}.localhost:12345`;
function call(output = `Open preview: ${url}\nAvailable on this machine.`): ToolCall {
  return {
    seq: 4,
    runId: "run-1",
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
      args: { port: 5173, label: "App" },
      output,
    },
    images: { kept: [], notKept: 0 },
  } as ToolCall;
}

it("reads the platform's preview reply and arguments", () => {
  expect(previewCallOf(call())).toEqual({ label: "App", port: 5173, url });
});

it("reads a hosted preview's reply", () => {
  const hosted = `https://${"a".repeat(32)}.preview.cell.example`;
  const reply =
    `Open preview: ${hosted}\nPeople who can see this run can open it, until the run ends.`;
  expect(previewCallOf(call(reply))?.url).toBe(hosted);
});

it("reads a compose or local cluster preview's reply", () => {
  const compose = `http://${"a".repeat(32)}.preview.localhost:7490`;
  // Whoever can read the run opens it, not only this machine.
  expect(isLocalPreviewUrl(compose)).toBe(false);
  expect(isLocalPreviewUrl(url)).toBe(true);
  expect(previewCallOf(call(`Open preview: ${compose}`))?.url).toBe(compose);
  const id = "a".repeat(32);
  expect(openablePreviewUrl(`${compose}/__ryph/enter?ticket=abc`, id))
    .toBe(`${compose}/__ryph/enter?ticket=abc`);
});

it("does not treat failures, pending calls or foreign links as previews", () => {
  expect(previewCallOf({ ...call(), isError: true })?.url).toBeNull();
  expect(previewCallOf({ ...call(), done: false })?.url).toBeNull();
  const outputs = [
    "Open preview: https://example.com",
    `Open preview: ${url}.evil.test`,
    `Open preview: http://${"a".repeat(32)}.preview.cell.example`,
    `Open preview: https://${"a".repeat(32)}.preview.cell.example/x`,
    `Open preview: https://${"a".repeat(32)}.preview.cell.example extra`,
    "refused",
  ];
  for (const output of outputs) {
    expect(previewCallOf(call(output))?.url).toBeNull();
  }
});

it("ignores other servers and malformed arguments", () => {
  const original = call();
  if (original.view.kind !== "mcp") throw new Error("expected mcp");
  expect(previewCallOf({ ...original, view: { ...original.view, server: "other" } })).toBeNull();
  expect(previewCallOf({ ...original, view: { ...original.view, tool: "other" } })).toBeNull();
  for (const args of [null, {}, { port: 80, label: "App" }, { port: "5173", label: "App" }]) {
    expect(previewCallOf({ ...original, view: { ...original.view, args } })).toBeNull();
  }
});

it("builds the app route that opens a preview", () => {
  const id = "a".repeat(32);
  expect(previewHref("r-0123456789", id)).toBe(`/previews/r-0123456789/${id}`);
  expect(previewHref("r-0123456789", id, { grant: "g&x", taskId: "t-1" }))
    .toBe(`/previews/r-0123456789/${id}?grant=g%26x&task=t-1`);
  expect(taskPath("t-0123456789")).toBe("/tasks/t-0123456789");
  for (const bad of [null, "", "../x", "a/b", "//evil.test"]) expect(taskPath(bad)).toBeNull();
});

it("takes a run id of either minted shape and nothing else", () => {
  expect(RUN_ID.test("r-0123456789")).toBe(true);
  expect(RUN_ID.test("r-01jb7k3m9x4q8zt2vw6hn5c0fe")).toBe(true);
  const refused = ["r-012345678", "r-01jb7k3m9x4q8zt2vw6hn5c0fe0", "t-0123456789", "r-ABCDEF0123"];
  for (const bad of [...refused, "r-../x"]) expect(RUN_ID.test(bad)).toBe(false);
});

it("follows only the preview's own origin, at its root or its one-time entry", () => {
  const id = "a".repeat(32);
  const hosted = `https://${id}.preview.cell.example`;
  expect(openablePreviewUrl(`${hosted}/__ryph/enter?ticket=abc_DEF-1`, id))
    .toBe(`${hosted}/__ryph/enter?ticket=abc_DEF-1`);
  expect(openablePreviewUrl(url, id)).toBe(`${url}/`);
  expect(openablePreviewUrl(`${hosted}/`, id)).toBe(`${hosted}/`);
  // A hosted ticket carries its own MAC: `<exp>.<nonce>.<mac>`.
  const signed = `${hosted}/__ryph/enter?ticket=1700000060.${"c".repeat(32)}.${"d".repeat(64)}`;
  expect(openablePreviewUrl(signed, id)).toBe(signed);
  const refused = [
    `${hosted}/__ryph/enter?ticket=a%2Fb`,
    `${hosted}/__ryph/enter?ticket=a%20b`,
    null,
    42,
    "not a url",
    "javascript:alert(1)",
    `${hosted}/__ryph/enter?ticket=abc`.replace(id, "b".repeat(32)),
    `http://${id}.preview.cell.example/`,
    `https://${id}.preview.cell.example:8443/`,
    `https://user@${id}.preview.cell.example/`,
    `${hosted}/__ryph/enter?ticket=abc&next=https://evil.test`,
    `${hosted}/__ryph/enter?ticket=`,
    `${hosted}/__ryph/enter?ticket=abc#x`,
    `${hosted}/elsewhere`,
    `${hosted}/?x=1`,
    "https://example.com/",
  ];
  for (const value of refused) expect(openablePreviewUrl(value, id)).toBeNull();
});

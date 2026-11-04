import { render } from "svelte/server";
import { expect, it } from "vitest";
import RunPreviews from "./run-previews.svelte";

const href = (preview: { id: string }) => `/previews/r-0123456789/${preview.id}`;

it("does not reserve space when no previews are active", () => {
  const { body } = render(RunPreviews, { props: { previews: [], href } });
  expect(body).not.toContain("Open preview");
  expect(body).not.toContain("<section");
});

it("lists labels, ports and safe new-tab actions", () => {
  const url = `http://${"a".repeat(32)}.localhost:12345`;
  const { body } = render(RunPreviews, {
    props: { previews: [{ id: "one", port: 5173, label: "App server", url }], href },
  });
  expect(body).toContain("Previews");
  expect(body).toContain("App server");
  expect(body).toContain("Port 5173");
  expect(body).not.toContain('data-slot="badge"');
  expect(body).not.toContain("Available while the run is alive.");
  expect(body).toContain('href="/previews/r-0123456789/one"');
  expect(body).not.toContain(`href="${url}"`);
  expect(body).toContain("This machine only");
  expect(body).toContain('target="_blank"');
  expect(body).toContain('rel="noopener noreferrer"');
});

it("retains the list but disables links while discovery is unavailable", () => {
  const url = `http://${"a".repeat(32)}.localhost:12345`;
  const { body } = render(RunPreviews, {
    props: {
      previews: [{ id: "one", port: 5173, label: "App server", url }],
      available: false,
      href,
    },
  });
  expect(body).toContain("App server");
  expect(body).toContain("disabled");
  expect(body).not.toContain("/previews/");
});

it("says who can open a hosted preview", () => {
  const url = `https://${"a".repeat(32)}.preview.cell.example`;
  const { body } = render(RunPreviews, {
    props: { previews: [{ id: "a".repeat(32), port: 5173, label: "App", url }], href },
  });
  expect(body).toContain("People who can see this run");
  expect(body).not.toContain("This machine only");
});

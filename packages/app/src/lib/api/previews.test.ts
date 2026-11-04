import { describe, expect, it } from "vitest";
import { getRunPreviews } from "./previews";

const reply = (status: number, body: unknown): typeof fetch =>
  (() => Promise.resolve(Response.json(body, { status }))) as typeof fetch;

describe("run previews", () => {
  it("treats a deployment without previews as unsupported", async () => {
    expect(await getRunPreviews(reply(404, {}), "r-1", null)).toBeNull();
  });
  it("passes the run read grant and accepts only isolated preview origins", async () => {
    let requested = "";
    const preview = {
      id: "p",
      port: 5173,
      label: "App",
      url: `http://${"a".repeat(32)}.localhost:49152`,
    };
    const f: typeof fetch = ((url: string) => {
      requested = url;
      return Promise.resolve(Response.json({ previews: [preview] }));
    }) as typeof fetch;
    expect(await getRunPreviews(f, "r-1", "proof")).toEqual([preview]);
    expect(requested).toBe("/api/v1/runs/r-1/previews?grant=proof");
    const hosted = { ...preview, url: `https://${"b".repeat(32)}.preview.cell.example` };
    expect(await getRunPreviews(reply(200, { previews: [hosted] }), "r-1", null)).toEqual([hosted]);
    for (
      const url of [
        "javascript:alert(1)",
        "https://example.com",
        "http://localhost:7411",
        `http://${"b".repeat(32)}.preview.cell.example`,
        `https://${"b".repeat(32)}.preview.cell.example/path`,
        `https://${"b".repeat(32)}.preview.cell.example:8443`,
        `https://user@${"b".repeat(32)}.preview.cell.example`,
      ]
    ) {
      await expect(getRunPreviews(reply(200, { previews: [{ ...preview, url }] }), "r-1", null))
        .rejects.toThrow();
    }
  });
});

import { describe, expect, it } from "vitest";
import { getRepoServices, repoServicesSchema } from "./services";

describe("repository service declarations", () => {
  it("reads the repository route and keeps declaration metadata", async () => {
    const body = {
      state: "declared",
      stale: true,
      services: [{ name: "db", source: "postgres@18", port: 5432, checksOnly: true }],
      problem: "this deployment does not run service containers",
    };
    const fetcher = ((url: string) => {
      expect(url).toBe("/api/v1/connected-repos/repo%2Fone/services");
      return Promise.resolve(Response.json(body));
    }) as typeof fetch;
    expect(await getRepoServices(fetcher, "repo/one")).toEqual(body);
  });

  it("distinguishes no declarations, invalid config, and transport failure", async () => {
    expect(repoServicesSchema.parse({ state: "none" })).toEqual({ state: "none" });
    const invalid = { state: "invalid", error: "services.db.port: required" };
    expect(repoServicesSchema.parse(invalid)).toEqual(invalid);
    const fetcher =
      (() => Promise.resolve(Response.json({ error: "offline" }, { status: 503 }))) as typeof fetch;
    await expect(getRepoServices(fetcher, "repo")).rejects.toThrow("offline");
    expect(repoServicesSchema.safeParse({ state: "declared", services: [] }).success).toBe(false);
  });
});

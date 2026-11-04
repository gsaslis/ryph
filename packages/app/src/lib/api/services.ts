import { browser } from "$app/environment";
import { z } from "zod";
import { apiCall } from "./call";

export const repoServicesSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }),
  z.object({ state: z.literal("invalid"), error: z.string() }),
  z.object({
    state: z.literal("declared"),
    stale: z.boolean(),
    services: z.array(
      z.object({
        name: z.string(),
        source: z.string(),
        port: z.number().int(),
        // Started only for the checks that name it, never beside a run.
        checksOnly: z.boolean(),
      }),
    ),
    problem: z.string().nullable(),
  }),
]);
export type RepoServices = z.infer<typeof repoServicesSchema>;

export async function getRepoServices(f = fetch, id: string): Promise<RepoServices> {
  return repoServicesSchema.parse(
    await apiCall(f, `/v1/connected-repos/${encodeURIComponent(id)}/services`),
  );
}

export function streamRepoServices(f = fetch, id: string): Promise<RepoServices | null> {
  return browser ? getRepoServices(f, id) : Promise.resolve(null);
}

import { z } from "zod";
import { apiCall } from "./call";

export { type RunArtifact, runArtifactSchema } from "./types";

// Pages agents publish.

/** The agent's name is null when the agent row is gone. */
const agentRefSchema = z.object({ id: z.string(), name: z.string().nullable() });

/** A person; the name is null when they are not in the directory any more. */
const personSchema = z.object({ id: z.string(), name: z.string().nullable() });

/** One artifact as the list names it. */
export const artifactSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  currentVersion: z.number().int().positive(),
  agent: agentRefSchema,
  originRunId: z.string(),
  /** The task the origin run belongs to, which is how the app opens a run; null once it is gone. */
  originTaskId: z.string().nullable(),
  updatedAt: z.string(),
  createdAt: z.string(),
});
export type ArtifactSummary = z.infer<typeof artifactSummarySchema>;

export const artifactVersionSchema = z.object({
  version: z.number().int().positive(),
  title: z.string(),
  runId: z.string(),
  /** The run's task, for the same reason as `originTaskId`. */
  taskId: z.string().nullable(),
  bytes: z.number(),
  createdAt: z.string(),
  /** Who asked for this version, when a person did. */
  requestedBy: personSchema.nullable().default(null),
});
export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;

export const artifactDetailSchema = artifactSummarySchema.extend({
  versions: z.array(artifactVersionSchema),
  /** Who asked for the first version, when a person did. */
  requestedBy: personSchema.nullable().default(null),
  /** Whether the caller may delete it: an operator, or whoever asked for it. */
  canDelete: z.boolean().default(false),
});
export type ArtifactDetail = z.infer<typeof artifactDetailSchema>;

/** The list's answer: a page, and an opaque cursor to the next one, null at the end. */
const artifactPageSchema = z.object({
  artifacts: z.array(artifactSummarySchema),
  next: z.string().nullable().default(null),
});

export type ArtifactPage = { artifacts: ArtifactSummary[]; nextBefore: string | null };

/** How many artifacts a page of the list asks for. */
export const ARTIFACT_PAGE_SIZE = 24;

/** One page of every artifact on the instance, the most recently updated first. */
export async function getArtifacts(
  f = fetch,
  opts: { before?: string | null; limit?: number } = {},
): Promise<ArtifactPage> {
  const limit = opts.limit ?? ARTIFACT_PAGE_SIZE;
  const params = new URLSearchParams({ limit: String(limit) });
  if (opts.before) params.set("before", opts.before);
  const page = artifactPageSchema.parse(await apiCall(f, `/v1/artifacts?${params}`));
  return { artifacts: page.artifacts, nextBefore: page.next };
}

/** One artifact with its versions. */
export async function getArtifact(f = fetch, id: string): Promise<ArtifactDetail> {
  return artifactDetailSchema.parse(await apiCall(f, `/v1/artifacts/${encodeURIComponent(id)}`));
}

/** Takes an artifact down for everyone (`artifacts:manage`, or whoever asked for it). */
export async function deleteArtifact(f = fetch, id: string): Promise<void> {
  await apiCall(f, `/v1/artifacts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

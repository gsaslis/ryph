import { z } from "zod";
import { isPreviewUrl } from "$lib/utils/previews";

const preview = z.object({
  id: z.string(),
  port: z.number().int().min(1024).max(65535),
  label: z.string(),
  // A preview's own origin only: `.localhost` on the local binary, the cell's preview domain hosted.
  url: z.string().refine(isPreviewUrl),
});
export type RunPreview = z.infer<typeof preview>;

export async function getRunPreviews(
  f: typeof fetch,
  runId: string,
  grant: string | null,
  signal?: AbortSignal,
): Promise<RunPreview[] | null> {
  const query = grant ? `?${new URLSearchParams({ grant })}` : "";
  const response = await f(`/api/v1/runs/${encodeURIComponent(runId)}/previews${query}`, {
    signal,
  });
  // A deployment without a previews service, or an older local binary, does not offer this.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Cannot read previews");
  return z.object({ previews: z.array(preview) }).parse(await response.json()).previews;
}

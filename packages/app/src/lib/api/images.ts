import { z } from "zod";
import { apiCall, ApiError } from "./call";

// The images ryph's runs start from, and whether this machine has them yet. A deployment that
// pulls published images fetches them at boot; this only reports on that and asks it to try again.

export const imageNameSchema = z.enum([
  "agent",
  "run-gate",
  "harness",
  "universal",
  "browser",
  "tool-guard",
  "buildkit",
]);
export type ImageName = z.infer<typeof imageNameSchema>;

export const imageStateSchema = z.enum(["present", "pulling", "queued", "failed"]);
export type ImageState = z.infer<typeof imageStateSchema>;

export const imageStatusSchema = z.object({
  name: imageNameSchema,
  /** The full reference, tag included. */
  image: z.string(),
  state: imageStateSchema,
  error: z.string().nullable(),
});
export type ImageStatus = z.infer<typeof imageStatusSchema>;

/**
 * Where each image stands. Empty on a deployment that does not pull images ahead of time (one
 * that is not on docker, or builds its images locally), and so is a control plane without the
 * route at all.
 */
export async function getImages(f = fetch): Promise<ImageStatus[]> {
  try {
    const res = await apiCall(f, "/v1/images");
    return z.object({ images: z.array(imageStatusSchema) }).parse(res).images;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return [];
    throw e;
  }
}

/** Starts pulling anything not there yet again, and answers with where each image stands now.
 * An admin's call. */
export async function pullImages(f = fetch): Promise<ImageStatus[]> {
  const res = await apiCall(f, "/v1/images/pull", { method: "POST" });
  return z.object({ images: z.array(imageStatusSchema) }).parse(res).images;
}

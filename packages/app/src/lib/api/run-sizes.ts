import { z } from "zod";
import { apiCall } from "./call";
import { type RunSize, runSizeSchema } from "./types";

/**
 * The size classes this deployment offers (RYPH_RUN_SIZES) — what the repo and workspace
 * settings offer an admin to pick from. Readable by anyone; only an admin may set one.
 */
export async function getRunSizes(f = fetch): Promise<RunSize[]> {
  const res = await apiCall(f, "/v1/run-sizes");
  return z.object({ sizes: z.array(runSizeSchema) }).parse(res).sizes;
}

/**
 * The same list, or null when it could not be read. A settings page must still open when the
 * control plane does not answer this one route; the size control then says it is unavailable.
 */
export async function getRunSizesOrNull(f = fetch): Promise<RunSize[] | null> {
  try {
    return await getRunSizes(f);
  } catch {
    return null;
  }
}

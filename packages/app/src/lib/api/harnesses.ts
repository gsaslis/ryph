import { z } from "zod";
import { apiCall } from "./call";
import { type Harness, harnessSchema } from "./types";

/**
 * The harness kinds this deployment offers (RYPH_HARNESS_KINDS) and which model DIALECTS each
 * can drive — what agent forms are built from instead of hardcoding. A dialect rather than a
 * provider name is what makes a registered custom endpoint usable the moment it exists, without
 * anything here learning its name. Every kind launches on the same agent image; empty only
 * against an orchestrator that offers none, where the harness kind stays a free-text field.
 */
export async function getHarnesses(f = fetch): Promise<Harness[]> {
  const res = await apiCall(f, "/v1/harnesses");
  return z.object({ harnesses: z.array(harnessSchema) }).parse(res).harnesses;
}

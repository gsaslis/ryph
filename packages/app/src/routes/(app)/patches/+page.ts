import type { PageLoad } from "./$types";
import { getPatches } from "$lib/api/patches";
import { type PatchState, patchStateSchema } from "$lib/api/types";

/** Every patch, newest first; one state is a filter away. */
export const load: PageLoad = async ({ fetch, url, depends }) => {
  depends("app:patches");
  const parsed = patchStateSchema.safeParse(url.searchParams.get("state"));
  const state: PatchState | "all" = parsed.success ? parsed.data : "all";
  const page = await getPatches(fetch, state === "all" ? undefined : state);
  return {
    fullWidth: true,
    state,
    patches: page.patches,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
};

import type { PageLoad } from "./$types";
import { getMemorySources } from "$lib/api/memory";

export const load: PageLoad = async ({ fetch, depends }) => {
  depends("app:memory");
  return { sources: await getMemorySources(fetch) };
};

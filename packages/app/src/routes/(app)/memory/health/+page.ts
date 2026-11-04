import type { PageLoad } from "./$types";
import { getMemoryHealth } from "$lib/api/memory";

export const load: PageLoad = async ({ fetch, depends }) => {
  depends("app:memory");
  return { health: await getMemoryHealth(fetch) };
};

import type { PageLoad } from "./$types";
import { getMemorySource, getMemorySubjects } from "$lib/api/memory";

export const load: PageLoad = async ({ fetch, params, depends }) => {
  depends("app:memory");
  const [detail, subjects] = await Promise.all([
    getMemorySource(fetch, params.id),
    getMemorySubjects(fetch).catch(() => []),
  ]);
  return { detail, subjects, breadcrumb: detail.source.title };
};

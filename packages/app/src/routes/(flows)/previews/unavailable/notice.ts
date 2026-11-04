import { PREVIEW_ID, previewOpenHref } from "$lib/utils/previews";

/**
 * Where a preview link that could not be opened lands (`/previews/<previewId>` failed): the open
 * to try again, or null when the link named no preview. Why it failed is not said, nor known here:
 * a preview that ended, one the person may not see and a moment's outage all look alike.
 */
export function retryOf(url: URL): string | null {
  const id = url.searchParams.get("id");
  if (id === null || !PREVIEW_ID.test(id)) return null;
  return previewOpenHref(id, url.searchParams.get("path"));
}

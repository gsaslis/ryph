import type { RequestHandler } from "@sveltejs/kit";
import { go, openPreview } from "$lib/server/preview-open";
import { PREVIEW_ID, previewUnavailableHref } from "$lib/utils/previews";

/**
 * Opens a preview by its id alone: `/previews/<previewId>?path=`, where the previews service sends
 * a page load that came without the preview's cookie (a link an agent posted, a pasted URL, a tab
 * whose cookie expired). The link names no run, so neither does this: the control plane finds the
 * run and holds the person to its read gate, exactly as the run page's open does
 * (`/previews/<runId>/<previewId>`, one segment deeper, so the two never match the same path).
 * Whatever goes wrong — a preview gone or ended, a run they may not read, the control plane out
 * of reach — the tab goes to one notice that says the preview is not available, the same for each,
 * and can try this open again. What is not a preview id at all goes to the app's home.
 */
export const GET: RequestHandler = async (event) => {
  const previewId = event.params.previewId ?? "";
  if (!PREVIEW_ID.test(previewId)) return go("/");
  const back = previewUnavailableHref(previewId, event.url.searchParams.get("path"));
  return await openPreview(event, `/v1/previews/${previewId}/open`, previewId, back, ["path"]);
};

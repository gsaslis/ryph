import type { RequestHandler } from "@sveltejs/kit";
import { go, openPreview } from "$lib/server/preview-open";
import { PREVIEW_ID, RUN_ID, taskPath } from "$lib/utils/previews";

/**
 * Opens a run's preview: `/previews/<runId>/<previewId>`, from the run page's open actions.
 *
 * Asks the control plane, as the signed-in person, for a way into the preview (a one-time ticket
 * on the preview's own origin when hosted, the preview itself on the local binary), and sends the
 * tab there. `path` is where in the preview to land: the previews service sends a link to it here
 * with the path it pointed at, and decides itself which paths it lands on. A link from anywhere
 * opens it, the return from signing in included, but only ever a preview the signed-in person
 * may already read. On the local binary the link's run grant is bound to the person it was
 * minted for, so a link pasted to someone else opens only if they read every run
 * (`tasks:read-all`); anyone else is sent back to the task page. Whatever goes wrong, the tab
 * goes back to the task page; the upstream's answer is never shown.
 */
export const GET: RequestHandler = async (event) => {
  const { params, url } = event;
  const back = taskPath(url.searchParams.get("task")) ?? "/";
  const runId = params.runId ?? "";
  const previewId = params.previewId ?? "";
  if (!RUN_ID.test(runId) || !PREVIEW_ID.test(previewId)) return go(back);
  return await openPreview(
    event,
    `/v1/runs/${runId}/previews/${previewId}/open`,
    previewId,
    back,
    ["grant", "path"],
  );
};

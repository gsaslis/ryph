import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { browser } from "$app/environment";
import { ApiError } from "$lib/api/call";
import { getPatch, type PatchDetail } from "$lib/api/patches";

/**
 * The patch this browser last showed. As on the check suite page: a first look that cannot read
 * the patch is an error page, while a poll that misses a beat keeps the page as it was. Browser
 * only: module state on the server is shared by every request it handles.
 */
let shown: PatchDetail | null = null;

/**
 * One patch: what it is, where it stands, the actions on it, and what its diff is measured from.
 * The diff itself is not read here, as the page polls this load and the diff changes far less
 * often than that: the page reads it, and again only when what it is measured from moves.
 */
export const load: PageLoad = async ({ fetch, params, depends }) => {
  depends("app:patch");
  const rerun = browser && shown?.patch.id === params.id;
  let read: PatchDetail;
  try {
    read = await getPatch(fetch, params.id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) error(404, "no such patch");
    if (!rerun || shown === null) throw e;
    read = shown;
  }
  if (browser) shown = read;
  const { patch, diffBasis } = read;
  return {
    fullWidth: true,
    patch,
    diffBasis,
    breadcrumb: patch.title ?? patch.taskTitle ?? patch.branchName,
  };
};

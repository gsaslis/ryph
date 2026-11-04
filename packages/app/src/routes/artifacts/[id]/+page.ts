import { browser } from "$app/environment";
import { error, redirect } from "@sveltejs/kit";
import { getArtifact } from "$lib/api/artifacts";
import { ApiError } from "$lib/api/call";
import { refreshSession } from "$lib/utils/auth/auth";
import { can } from "$lib/utils/auth/capabilities";
import { pickVersion } from "$lib/utils/artifacts";
import type { PageLoad } from "./$types";

/**
 * One artifact, outside the app's shell: the page a link an agent posted opens. Signing in comes
 * back here; the frame below never asks for it (its content route answers 401 instead).
 */
export const load: PageLoad = async ({ fetch, params, url, parent, depends }) => {
  let { user } = await parent();
  if (!user && browser) user = await refreshSession();
  if (!user) redirect(302, `/login?backTo=${encodeURIComponent(url.pathname + url.search)}`);
  if (!can(user, "artifacts:read")) error(404, "This artifact is not available.");

  depends("app:artifact");
  let artifact;
  try {
    artifact = await getArtifact(fetch, params.id);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
      error(404, "This artifact is not available.");
    }
    throw e;
  }
  const version = pickVersion(
    url.searchParams.get("v"),
    artifact.versions,
    artifact.currentVersion,
  );
  return { user, artifact, version };
};

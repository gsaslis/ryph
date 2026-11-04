import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { browser } from "$app/environment";
import { ApiError } from "$lib/api/call";
import { getEnvironmentById } from "$lib/api/environments";
import { getConnectedRepo } from "$lib/api/repos";
import type { EnvironmentView, ForgeProvider } from "$lib/api/types";
import { getWorkspace } from "$lib/api/workspaces";

/** What a build was built for, as the page names and links it; null once it is gone. */
export type BuildSubject = { name: string; provider: ForgeProvider | null; href: string } | null;

/**
 * The build this browser last showed. As on a check suite's page: a first look that cannot read
 * the build is an error page, while a poll that misses a beat keeps the page as it was. Browser
 * only: module state on the server is shared by every request it handles.
 */
let shown: { id: string; build: EnvironmentView; subject: BuildSubject } | null = null;

/** One environment build. The page polls this load while the build is queued or building. */
export const load: PageLoad = async ({ fetch, params, depends }) => {
  depends("app:build");
  const rerun = browser && shown?.id === params.id;
  let build: EnvironmentView;
  let subject: BuildSubject;
  try {
    build = await getEnvironmentById(fetch, params.id);
    // The subject cannot change under a build: a poll reads it once.
    subject = rerun && shown !== null ? shown.subject : await subjectOf(fetch, build);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) error(404, "no such build");
    if (!rerun || shown === null) throw e;
    ({ build, subject } = shown);
  }
  if (browser) shown = { id: params.id, build, subject };
  return {
    build,
    subject,
    breadcrumb: subject?.name ?? build.id,
  };
};

async function subjectOf(f: typeof fetch, build: EnvironmentView): Promise<BuildSubject> {
  if (build.subjectKind === "repo") {
    const repo = await getConnectedRepo(f, build.subjectId);
    return repo === null
      ? null
      : { name: repo.repoRef, provider: repo.provider, href: `/repos/${repo.id}#environment` };
  }
  try {
    const { workspace } = await getWorkspace(f, build.subjectId);
    return {
      name: workspace.name,
      provider: null,
      href: `/workspaces/${workspace.id}#environment`,
    };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

import { error, redirect } from "@sveltejs/kit";
import { can } from "$lib/utils/auth/capabilities";
import type { PageLoad } from "./$types";
import { ApiError } from "$lib/api/call";
import { getOrgSkill, getSkillBundle, getSkills } from "$lib/api/skills";

/**
 * One skill of the org skills repo: the version agents get now, its files, and the versions
 * before it. `?version=<sync id>` shows an older version's files instead, so a link to one keeps
 * working; an id that is not one of this skill's versions is a 404, not someone else's files. A
 * version is named by the sync that first saw it rather than by its digest: a skill that went from
 * A to B and back to A has two versions with one digest, and each is its own row with its own dates.
 */
export const load: PageLoad = async ({ fetch, params, parent, url }) => {
  const { user } = await parent();
  if (!can(user, "skills:read")) redirect(302, "/agents");
  const asked = url.searchParams.get("version");
  try {
    const [detail, overview] = await Promise.all([
      getOrgSkill(fetch, params.name),
      getSkills(fetch),
    ]);
    const latest = detail.versions[0];
    const isCurrent = latest !== undefined && latest.digest === detail.skill.digest &&
      latest.firstSync.id === asked;
    const version = asked === null || isCurrent
      ? null
      : detail.versions.find((v) => v.firstSync.id === asked);
    if (version === undefined) error(404, "no such version of this skill");
    const bundle = version === null ? null : await getSkillBundle(fetch, version.digest);
    if (version !== null && bundle === null) error(404, "no such version of this skill");
    return {
      ...detail,
      org: overview.org,
      shownVersion: version,
      shownFiles: bundle?.files ?? detail.files,
      shownBytes: bundle?.bytes ?? detail.files.reduce((sum, f) => sum + f.bytes, 0),
      breadcrumb: detail.skill.name,
    };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      error(404, "no such skill in the org repository");
    }
    throw e;
  }
};

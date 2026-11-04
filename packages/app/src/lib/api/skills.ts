import { z } from "zod";
import { apiCall, ApiError } from "./call";
import {
  type CatalogueSkillDetail,
  catalogueSkillDetailSchema,
  type OrgSkillDetail,
  orgSkillDetailSchema,
  skillBundleSchema,
  type SkillBundleView,
  type SkillsOverview,
  skillsOverviewSchema,
  type SkillSync,
  type SkillSyncAnswer,
  skillSyncAnswerSchema,
  skillSyncSchema,
} from "./types";

// The skills surface on the control plane: ryph's catalogue with the admin's switches, the org
// skills repo and its versions, and the admin's writes. Reading is a member's; every write is an
// operator's (`skills:manage`), and each write answers the whole overview, so a page refreshes
// from the answer rather than reading again.

/** A digest as the control plane spells it. Checked before it goes into a path, because the
 * route matches the colon raw: an encoded one would never match. */
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export async function getSkills(f = fetch): Promise<SkillsOverview> {
  return skillsOverviewSchema.parse(await apiCall(f, "/v1/skills"));
}

/**
 * The overview for a form that can do without it — the agent editor. Every answer that is not
 * the editor's fault (an orchestrator without the route, one that is down, a user who may not
 * read skills) folds to null, and the editor then leaves the agent's skill policy as it stands.
 */
export async function getSkillsOrNull(f = fetch): Promise<SkillsOverview | null> {
  try {
    return await getSkills(f);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404 || e.status >= 500)) {
      return null;
    }
    // Never an HTTP answer at all: the control plane could not be reached.
    if (e instanceof TypeError) return null;
    throw e;
  }
}

export async function getCatalogueSkill(f = fetch, name: string): Promise<CatalogueSkillDetail> {
  return catalogueSkillDetailSchema.parse(
    await apiCall(f, `/v1/skills/catalogue/${encodeURIComponent(name)}`),
  );
}

export async function getOrgSkill(f = fetch, name: string): Promise<OrgSkillDetail> {
  return orgSkillDetailSchema.parse(
    await apiCall(f, `/v1/skills/org/${encodeURIComponent(name)}`),
  );
}

/** One version's files. Null for a string that is not a digest, which no route could answer. */
export async function getSkillBundle(f = fetch, digest: string): Promise<SkillBundleView | null> {
  if (!DIGEST.test(digest)) return null;
  return skillBundleSchema.parse(await apiCall(f, `/v1/skills/bundles/${digest}`));
}

const syncPageSchema = z.object({
  syncs: z.array(skillSyncSchema),
  nextCursor: z.string().nullable(),
});

/** The org repo's sync history, newest first. */
export async function getSkillSyncs(
  f = fetch,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ syncs: SkillSync[]; nextCursor: string | null }> {
  const query = new URLSearchParams();
  if (opts.cursor !== undefined) query.set("cursor", opts.cursor);
  if (opts.limit !== undefined) query.set("limit", String(opts.limit));
  const qs = query.toString();
  return syncPageSchema.parse(await apiCall(f, `/v1/skills/syncs${qs === "" ? "" : `?${qs}`}`));
}

export type SkillSettingsInput = {
  /** Catalogue skills turned off for every agent, by name. */
  disabledCatalogue: string[];
  workingRepoSkills: boolean;
};

export async function putSkillSettings(
  f = fetch,
  input: SkillSettingsInput,
): Promise<SkillsOverview> {
  return skillsOverviewSchema.parse(
    await apiCall(f, "/v1/skills/settings", { method: "PUT", body: JSON.stringify(input) }),
  );
}

const syncedOverviewSchema = skillsOverviewSchema.extend({ sync: skillSyncAnswerSchema });

/** The overview after a read of the org repo, and what that read did. */
export type SyncedOverview = SkillsOverview & { sync: SkillSyncAnswer };

/**
 * Makes a connected repo the org skills repo and reads it at once; the answer says what the read
 * found. `branch` null reads the repo's default branch.
 */
export async function connectOrgSkillsRepo(
  f = fetch,
  input: { connectedRepoId: string; branch: string | null },
): Promise<SyncedOverview> {
  return syncedOverviewSchema.parse(
    await apiCall(f, "/v1/skills/org-repo", { method: "PUT", body: JSON.stringify(input) }),
  );
}

/** Stops reading the org skills repo. Runs already started keep the skills they were given. */
export async function disconnectOrgSkillsRepo(f = fetch): Promise<SkillsOverview> {
  return skillsOverviewSchema.parse(
    await apiCall(f, "/v1/skills/org-repo", { method: "DELETE" }),
  );
}

export async function syncOrgSkillsRepo(f = fetch): Promise<SyncedOverview> {
  return syncedOverviewSchema.parse(
    await apiCall(f, "/v1/skills/org-repo/sync", { method: "POST" }),
  );
}

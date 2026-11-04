// The skills surface: what the skills page and the agent editor
// read — ryph's catalogue with the admin's switches, the org skills repo with its current version
// and the failure still standing, each skill's files and versions, the sync history — and the
// admin's writes: the switches, which repo is the org skills repo, and Sync now.
//
// Invariants:
// - reading takes `skills:read`, a member's: every member sees what the deployment's runs are
//   given, which is the disclosure connecting an org repo makes on purpose
// - every write takes `skills:manage`, an operator's, like managing MCP servers: the switches
//   and the org repo decide what every agent reads
// - a file's text is served only when it is UTF-8 with no NUL; anything else is its size, never
//   bytes a page might render
// - catalogue names an admin turns off are held to the shipped catalogue, and a name a later
//   release removed is left out of what the page reads, so it drops out on the next write
// - the overview carries each skill's small icon only, read in one query of the icons alone; a
//   skill's own page carries both
// - connecting the repo and Sync now wait for the read and answer with what it did; the read has
//   the forge's own deadline, so neither hangs past it, and a timeout is a recorded failure

import type {
  CatalogueSkill,
  OrgState,
  SkillBundle,
  SkillIcons,
  SkillSync,
  SkillWarning,
} from "../core/skills.ts";
import { MAX_LISTED_SKILLS, MAX_LISTING_BYTES } from "../core/skills.ts";
import { presentationView } from "../core/skill_presentation.ts";
import { type SkillsSyncDeps, type SkillSyncOutcome, syncOrgSkills } from "../core/skills_sync.ts";
import { DEFAULT_SKILL_SETTINGS, type SkillSettings } from "../core/types.ts";
import { normalizeBaseRef } from "@ryph/shared/refs";
import { decodeListCursor } from "../ports/task_store.ts";
import { OrgSkillsRepoSchema, SkillSettingsSchema } from "../schema.ts";
import type { Principal, WiredDeps } from "./app.ts";
import { refuseUnless } from "@ryph/auth/gates";
import { json, parseBody, type Route, route } from "@ryph/shared/http";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SYNC_PAGE = 50;
const SYNC_PAGE_MAX = 100;

/** One file of a skill as the page shows it: its text when it has some, its size always. */
interface FileView {
  path: string;
  executable: boolean;
  bytes: number;
  /** Null for a file that is not UTF-8 text. */
  text: string | null;
}

function filesOf(bundle: SkillBundle): FileView[] {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return bundle.files.map((file) => {
    const bytes = Uint8Array.fromBase64(file.content);
    let text: string | null;
    try {
      text = decoder.decode(bytes);
      if (text.includes("\0")) text = null;
    } catch {
      text = null;
    }
    return { path: file.path, executable: file.executable, bytes: bytes.length, text };
  });
}

/** A sync's failure as the page names it. */
function failureOf(sync: SkillSync) {
  return { kind: sync.failure, error: sync.error, repeats: sync.repeats, at: sync.finishedAt };
}

/** The warnings of one skill's directory, out of a whole version's. */
function warningsOf(warnings: readonly SkillWarning[], name: string): SkillWarning[] {
  return warnings.filter((w) => w.path === name || w.path.startsWith(`${name}/`));
}

/** What a sync did, as the connect and Sync now answers carry it. */
function syncView(outcome: SkillSyncOutcome) {
  return {
    outcome: outcome.kind,
    sync: outcome.kind === "up-to-date" || outcome.kind === "not-connected" ? null : outcome.sync,
  };
}

/** A catalogue skill as a route answers it: its icons folded into its presentation. */
function catalogueView(skill: CatalogueSkill, shape: "overview" | "detail") {
  const { icons, ...rest } = skill;
  return { ...rest, presentation: presentationView(skill.presentation, icons, shape) };
}

function orgView(state: OrgState, icons: ReadonlyMap<string, SkillIcons>) {
  const { repo, current, lastFailure } = state;
  return {
    repo: {
      id: repo.id,
      provider: repo.provider,
      repoRef: repo.repoRef,
      url: repo.url,
      defaultBranch: repo.defaultBranch,
    },
    branch: state.branch,
    effectiveBranch: state.branch ?? repo.defaultBranch,
    current: current === null ? null : {
      syncId: current.sync.id,
      commit: current.sync.commit,
      syncedAt: current.sync.finishedAt,
      // Warnings about directories that never became a skill too, which is most of them.
      warnings: current.sync.warnings,
      skills: current.skills.map((s) => ({
        ...s,
        presentation: presentationView(s.presentation, icons.get(s.digest) ?? null, "overview"),
      })),
    },
    checkedAt: state.checkedAt,
    checkedCommit: state.checkedCommit,
    // The repo answered with a failure after the version runs get: they are on the last good one.
    stale: current !== null && lastFailure !== null,
    lastFailure: lastFailure === null ? null : failureOf(lastFailure),
    // Runs get no org skills from an archived repo; reconnecting it mints a new id, so an admin
    // has to pick it again.
    archived: repo.archivedAt !== null,
  };
}

export function skillsRoutes(deps: WiredDeps): Route[] {
  const catalogue = () => deps.skillCatalogue?.list() ?? [];
  const settings = async (): Promise<SkillSettings> =>
    await deps.skills?.settings() ?? DEFAULT_SKILL_SETTINGS;
  const byOf = (caller: Principal) => caller.kind === "break-glass" ? null : caller.userId;
  const noStore = () => json(503, { error: "skill settings are not stored on this orchestrator" });
  const syncDeps = (skills: NonNullable<WiredDeps["skills"]>): SkillsSyncDeps => ({
    skills,
    forge: deps.forgeSkills ?? null,
    diag: deps.diag,
    now: deps.now,
  });

  /** Everything the skills page and the agent editor read, in one answer. */
  const overview = async () => {
    const [current, state] = await Promise.all([
      settings(),
      deps.skills?.orgState() ?? Promise.resolve(null),
    ]);
    const off = new Set(current.disabledCatalogue);
    const digests = state?.current?.skills.map((s) => s.digest) ?? [];
    const icons = digests.length === 0 || !deps.skills
      ? new Map<string, SkillIcons>()
      : await deps.skills.iconsOf(digests);
    return {
      catalogue: catalogue().map((s) => ({
        ...catalogueView(s, "overview"),
        enabled: !off.has(s.name),
      })),
      org: state === null ? null : orgView(state, icons),
      workingRepoSkills: current.workingRepoSkills,
      limits: { skills: MAX_LISTED_SKILLS, listingBytes: MAX_LISTING_BYTES },
      updatedAt: current.updatedAt,
      updatedBy: current.updatedBy,
    };
  };

  const getOverview = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "skills:read");
    if (denied) return denied;
    return json(200, await overview());
  };

  const getCatalogueSkill = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "skills:read");
    if (denied) return denied;
    const skill = catalogue().find((s) => s.name === params.name);
    const bundle = skill === undefined ? null : deps.skillCatalogue!.bundle(skill.digest);
    if (skill === undefined || bundle === null) return json(404, { error: "no such skill" });
    const off = (await settings()).disabledCatalogue.includes(skill.name);
    return json(200, {
      skill: { ...catalogueView(skill, "detail"), enabled: !off },
      files: filesOf(bundle),
    });
  };

  const getOrgSkill = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "skills:read");
    if (denied) return denied;
    const state = await deps.skills?.orgState() ?? null;
    const skill = state?.current?.skills.find((s) => s.name === params.name);
    if (state === null || state.current === null || skill === undefined) {
      return json(404, { error: "no such skill in the org skills repo" });
    }
    const [bundle, icons, versions] = await Promise.all([
      deps.skills!.bundle(skill.digest),
      deps.skills!.iconsOf([skill.digest]),
      // The lineage of the branch runs read now: the current version's own.
      deps.skills!.versionsOf(state.repo.id, state.current.sync.branch, skill.name),
    ]);
    // The entry's foreign key holds the bundle; a missing one is a database edited by hand.
    if (bundle === null) return json(404, { error: "the skill's files are missing" });
    return json(200, {
      skill: {
        ...skill,
        presentation: presentationView(
          skill.presentation,
          icons.get(skill.digest) ?? null,
          "detail",
        ),
        warnings: warningsOf(state.current.sync.warnings, skill.name),
      },
      files: filesOf(bundle),
      versions,
    });
  };

  const getBundle = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "skills:read");
    if (denied) return denied;
    if (!DIGEST.test(params.digest)) return json(400, { error: "not a skill digest" });
    // The catalogue in memory first, as the runner's bundle route does: a current catalogue
    // digest costs no query.
    const bundle = deps.skillCatalogue?.bundle(params.digest) ??
      await deps.skills?.bundle(params.digest) ?? null;
    if (bundle === null) return json(404, { error: "no such skill version" });
    return json(200, { digest: bundle.digest, bytes: bundle.bytes, files: filesOf(bundle) });
  };

  const listSyncs = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "skills:read");
    if (denied) return denied;
    const query = new URL(req.url).searchParams;
    const limit = query.get("limit");
    if (limit !== null && (!/^\d{1,4}$/.test(limit) || Number(limit) < 1)) {
      return json(400, { error: "limit must be a whole number of rows" });
    }
    const cursor = query.get("cursor");
    if (cursor !== null && decodeListCursor(cursor) === null) {
      return json(400, { error: "cursor is not a cursor this surface issued" });
    }
    if (!deps.skills) return json(200, { syncs: [], nextCursor: null });
    const [page, repos] = await Promise.all([
      deps.skills.syncs({
        cursor: cursor ?? undefined,
        limit: Math.min(SYNC_PAGE_MAX, limit === null ? SYNC_PAGE : Number(limit)),
      }),
      deps.store.listConnectedRepos(),
    ]);
    const refOf = new Map(repos.map((r) => [r.id, r.repoRef]));
    return json(200, {
      syncs: page.syncs.map((s) => ({ ...s, repoRef: refOf.get(s.connectedRepoId) ?? null })),
      nextCursor: page.nextCursor,
    });
  };

  const putSettings = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "skills:manage", "changing skill settings");
    if (denied) return denied;
    const body = await parseBody(req, SkillSettingsSchema);
    if (!body.ok) return body.res;
    const shipped = new Set(catalogue().map((s) => s.name));
    const unknown = body.data.disabledCatalogue.find((n) => !shipped.has(n));
    if (unknown !== undefined) return json(400, { error: `no catalogue skill "${unknown}"` });
    if (!deps.skills) return noStore();
    await deps.skills.putToggles(body.data, byOf(caller));
    return json(200, await overview());
  };

  const putOrgRepo = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "skills:manage", "choosing the org skills repo");
    if (denied) return denied;
    const body = await parseBody(req, OrgSkillsRepoSchema);
    if (!body.ok) return body.res;
    const repo = await deps.store.getConnectedRepo(body.data.connectedRepoId);
    if (repo === null) {
      return json(400, { error: `no such connected repo "${body.data.connectedRepoId}"` });
    }
    if (repo.archivedAt !== null) {
      return json(400, { error: `connected repo "${repo.repoRef}" is disconnected` });
    }
    if (!deps.skills) return noStore();
    // Held as the bare name a push event carries: `refs/heads/main` would never match a push to
    // main, and the same branch in two spellings would be two lineages of versions.
    const branch = body.data.branch === null
      ? null
      : normalizeBaseRef(body.data.branch).localBranch;
    await deps.skills.setOrgRepo(
      { connectedRepoId: body.data.connectedRepoId, branch },
      byOf(caller),
    );
    // Read at once, so the admin sees what the repo holds, or why it could not be read, in the
    // answer to connecting it.
    const outcome = await syncOrgSkills(syncDeps(deps.skills), "connect", byOf(caller));
    return json(200, { ...await overview(), sync: syncView(outcome) });
  };

  const syncNow = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "skills:manage", "syncing the org skills repo");
    if (denied) return denied;
    if (!deps.skills) return noStore();
    const state = await deps.skills.orgState();
    if (state === null) return json(409, { error: "no org skills repo is connected" });
    if (state.repo.archivedAt !== null) {
      return json(409, {
        error: `connected repo "${state.repo.repoRef}" is disconnected; pick the org skills ` +
          "repo again",
      });
    }
    const outcome = await syncOrgSkills(syncDeps(deps.skills), "manual", byOf(caller));
    return json(200, { ...await overview(), sync: syncView(outcome) });
  };

  const deleteOrgRepo = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "skills:manage", "disconnecting the org skills repo");
    if (denied) return denied;
    if (!deps.skills) return noStore();
    // History and bundles stay: runs already frozen keep their digests, and a skill's versions
    // are still there if the same repo is picked again.
    await deps.skills.setOrgRepo(null, byOf(caller));
    return json(200, await overview());
  };

  return [
    route("GET", "/v1/skills", getOverview),
    route("GET", "/v1/skills/syncs", listSyncs),
    route("GET", "/v1/skills/catalogue/:name", getCatalogueSkill),
    route("GET", "/v1/skills/org/:name", getOrgSkill),
    route("GET", "/v1/skills/bundles/:digest", getBundle),
    route("PUT", "/v1/skills/settings", putSettings),
    route("PUT", "/v1/skills/org-repo", putOrgRepo),
    route("DELETE", "/v1/skills/org-repo", deleteOrgRepo),
    route("POST", "/v1/skills/org-repo/sync", syncNow),
  ];
}

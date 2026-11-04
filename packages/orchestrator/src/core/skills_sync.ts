// Syncing the org skills repo: asking
// the forge for `.agents/skills/` at the tip of the branch the settings name, judging every skill
// in it by core/skills.ts's rules, and recording the result as a content-addressed version runs
// are frozen with — or as a failure, while runs keep the last good version.
//
// Four triggers reach the one function here: an admin connecting the repo (`connect`), a push to
// it (`push`), an admin's Sync now (`manual`) and the hourly backstop (`reconcile`). They differ
// only in who waits for the answer.
//
// Invariants:
// - the forge returns bytes and modes and judges nothing; what a skill IS is decided here, by the
//   same rules the catalogue is held to (minus the reserved prefix)
// - a sync SUCCEEDS whenever the tree could be read: an invalid skill is dropped with warnings
//   and the rest become the version, so one committer's typo cannot take every agent's skills
//   away. Only an unreadable or over-bound tree fails, and then the current version stays
// - the store's one write decides what the read MEANS (a new version, the same tree again, a
//   repeat of the standing failure, history because the settings moved or a later read landed
//   meanwhile, or an unchanged answer about a tree runs no longer get, which is read again
//   whole); this module only reads and judges, so two syncs racing record one version
// - a version judged by older rules is re-read whatever its tree id says, so what runs get and
//   the warnings the page shows are the running code's
// - never throws for anything the forge or the repo did: every way a read can go wrong is a
//   recorded failure. A throw out of here is the store failing, which the caller logs

import { mintId } from "@ryph/sealed";
import {
  judgeSkill,
  type RecordedSync,
  SKILL_RULES_VERSION,
  type SkillSyncFailure,
  type SkillSyncResult,
  type SkillSyncStart,
  type SkillSyncTrigger,
  type SkillTreeEntry,
  type SkillWarning,
  type ValidSkill,
} from "./skills.ts";
import { forgeRepoRef } from "./forge_repo.ts";
import type { ForgeSkills, SkillsTree } from "../ports/forge.ts";
import type { SkillStore } from "../ports/skill_store.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";

/** Skill directories one sync judges. A repo with more syncs the first ones by name and says so:
 * agents narrow the rest, and the per-run cap applies per run, not per repo. */
export const MAX_ORG_SKILL_DIRS = 100;

/** Warnings one sync keeps; the rest are counted in one more. */
export const MAX_SYNC_WARNINGS = 100;

export interface SkillsSyncDeps {
  skills: SkillStore;
  /** Null: no forge, so every read fails as `unavailable`. */
  forge: ForgeSkills | null;
  diag: Diagnostics;
  now: () => Date;
}

/** What a sync did: the store's answer, or nothing to sync. */
export type SkillSyncOutcome =
  /** `behind` never reaches a caller: the sync reads the whole tree again instead. */
  | Exclude<RecordedSync, { kind: "behind" }>
  /** No org skills repo, or the connected one is archived. */
  | { kind: "not-connected" };

/**
 * One read of the org skills repo, recorded. `requestedBy` is the user for `connect` and
 * `manual`, null otherwise.
 */
export async function syncOrgSkills(
  deps: SkillsSyncDeps,
  trigger: SkillSyncTrigger,
  requestedBy: string | null,
): Promise<SkillSyncOutcome> {
  return await syncOnce(deps, trigger, requestedBy, false);
}

/**
 * One read and its write. `whole` asks for the whole tree whatever runs get: the second read of a
 * sync whose unchanged answer was about a tree another read replaced meanwhile. A read that names
 * no tree is never answered `unchanged`, so there is never a third.
 */
async function syncOnce(
  deps: SkillsSyncDeps,
  trigger: SkillSyncTrigger,
  requestedBy: string | null,
  whole: boolean,
): Promise<SkillSyncOutcome> {
  const state = await deps.skills.orgState();
  if (state === null || state.repo.archivedAt !== null) return { kind: "not-connected" };
  const { repo } = state;
  const branch = state.branch ?? repo.defaultBranch;
  const current = state.current?.sync ?? null;
  // The tree runs already get, but only when it was judged by the running rules: otherwise the
  // forge must hand the whole tree back so it is judged again.
  const knownTree = !whole && current !== null && current.rulesVersion === SKILL_RULES_VERSION
    ? current.treeId
    : null;
  const start: SkillSyncStart = {
    id: mintId("ss"),
    connectedRepoId: repo.id,
    settingsBranch: state.branch,
    branch,
    trigger,
    requestedBy,
    startedAt: deps.now().toISOString(),
  };

  const result = await read(deps, start, knownTree, async () => {
    if (deps.forge === null) return { kind: "unavailable", detail: "no forge is configured" };
    return await deps.forge.readSkillsTree(forgeRepoRef(repo), repo.url, branch, knownTree);
  });
  const recorded = await deps.skills.recordSync(start, result);
  if (recorded.kind === "behind") {
    // Two pushes close together, the second restoring the first's parent tree (a revert): the
    // first push's read landed while this one was answered `unchanged` against the tree before
    // it. Runs must not stay on the reverted tree, so this read is done again, whole.
    deps.diag.debug("skills.sync_behind", { connectedRepoId: repo.id, branch, trigger });
    return await syncOnce(deps, trigger, requestedBy, true);
  }
  const fields = {
    connectedRepoId: repo.id,
    branch,
    trigger,
    outcome: recorded.kind,
    commit: result.commit,
  };
  if (recorded.kind === "failed") {
    deps.diag.warn("skills.sync_failed", {
      ...fields,
      failure: recorded.sync.failure,
      error: recorded.sync.error,
      repeats: recorded.sync.repeats,
    });
  } else {
    deps.diag.debug("skills.synced", {
      ...fields,
      skills: recorded.kind === "synced" ? recorded.sync.skillCount : undefined,
    });
  }
  return recorded;
}

/** The forge's answer as the store's write takes it: every way it can go wrong is a failure. */
async function read(
  deps: SkillsSyncDeps,
  start: SkillSyncStart,
  knownTree: string | null,
  ask: () => Promise<SkillsTree>,
): Promise<SkillSyncResult> {
  const finishedAt = () => deps.now().toISOString();
  const failed = (failure: SkillSyncFailure, error: string, commit: string | null = null) => ({
    kind: "failed" as const,
    failure,
    error,
    commit,
    rulesVersion: SKILL_RULES_VERSION,
    finishedAt: finishedAt(),
  });
  try {
    const answer = await ask();
    switch (answer.kind) {
      case "unchanged":
        // Only a read that named a tree can be told it is unchanged; anything else is a forge
        // that did not answer the question asked.
        if (knownTree === null) {
          return failed("error", "the forge answered unchanged to a read that named no tree");
        }
        return {
          kind: "unchanged",
          commit: answer.commit,
          treeId: knownTree,
          rulesVersion: SKILL_RULES_VERSION,
          finishedAt: finishedAt(),
        };
      case "absent":
        // A version with no skills: the repo is connected and holds none yet.
        return {
          kind: "tree",
          commit: answer.commit,
          treeId: null,
          rulesVersion: SKILL_RULES_VERSION,
          skills: [],
          warnings: [],
          finishedAt: finishedAt(),
        };
      case "tree": {
        const judged = await judgeSkillsTree(answer.files);
        return {
          kind: "tree",
          commit: answer.commit,
          treeId: answer.tree,
          rulesVersion: SKILL_RULES_VERSION,
          skills: judged.skills,
          warnings: judged.warnings,
          finishedAt: finishedAt(),
        };
      }
      case "invalid":
        return failed("invalid", answer.detail, answer.commit);
      case "missing-ref":
        return failed("missing-ref", `branch ${start.branch} no longer exists`);
      case "unavailable":
        return failed("unavailable", answer.detail);
    }
  } catch (err) {
    return failed("error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Every skill in an `.agents/skills/` tree, judged: the valid ones in name order, and the
 * warnings about the rest. A skill is a directory directly under the root; a file directly in
 * the root (a README) is not one and is passed over without a word.
 */
export async function judgeSkillsTree(
  files: ReadonlyArray<Extract<SkillsTree, { kind: "tree" }>["files"][number]>,
): Promise<{ skills: ValidSkill[]; warnings: SkillWarning[] }> {
  const warnings: SkillWarning[] = [];
  const dirs = new Map<string, SkillTreeEntry[]>();
  for (const file of files) {
    const slash = file.path.indexOf("/");
    const type = file.mode === "120000" ? "symlink" : file.mode === "160000" ? "submodule" : "file";
    if (slash < 0) {
      // A link or a submodule at the root looks like a skill directory to its author, so it is
      // named; a plain file there is just a file.
      if (type !== "file") {
        warnings.push({
          path: file.path,
          message: `a ${type} is never read, so it is not a skill`,
        });
      }
      continue;
    }
    const dir = file.path.slice(0, slash);
    const entries = dirs.get(dir) ?? [];
    entries.push({
      path: file.path.slice(slash + 1),
      type,
      executable: file.mode === "100755",
      bytes: file.content === null ? new Uint8Array() : Uint8Array.fromBase64(file.content),
    });
    dirs.set(dir, entries);
  }

  const names = [...dirs.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (names.length > MAX_ORG_SKILL_DIRS) {
    warnings.push({
      path: names[MAX_ORG_SKILL_DIRS],
      message: `${names.length} skill directories, over the limit of ${MAX_ORG_SKILL_DIRS}; ` +
        `only the first ${MAX_ORG_SKILL_DIRS} by name are read, and ` +
        `${names[MAX_ORG_SKILL_DIRS]} onwards are left out`,
    });
  }
  const skills: ValidSkill[] = [];
  for (const dir of names.slice(0, MAX_ORG_SKILL_DIRS)) {
    const judged = await judgeSkill({ dir, entries: dirs.get(dir)!, allowReserved: false });
    warnings.push(...judged.warnings);
    if (judged.kind === "valid") skills.push(judged.skill);
  }

  if (warnings.length <= MAX_SYNC_WARNINGS) return { skills, warnings };
  const kept = warnings.slice(0, MAX_SYNC_WARNINGS - 1);
  return {
    skills,
    warnings: [...kept, {
      path: ".agents/skills",
      message: `and ${warnings.length - kept.length} more warnings`,
    }],
  };
}

/**
 * The push trigger: a `branch.updated` for `connectedRepoId` syncs when that repo is the org
 * skills repo and the branch is the one the settings read (null: the default, which is the only
 * branch the forges send events for). Null when the push is not the skills repo's.
 */
export async function syncOnPush(
  deps: SkillsSyncDeps,
  connectedRepoId: string,
  branch: string,
): Promise<SkillSyncOutcome | null> {
  const { org } = await deps.skills.settings();
  if (org === null || org.connectedRepoId !== connectedRepoId) return null;
  if (org.branch !== null && org.branch !== branch) return null;
  return await syncOrgSkills(deps, "push", null);
}

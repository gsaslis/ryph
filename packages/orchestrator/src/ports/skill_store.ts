// Skills' own working set: a sibling of TaskStore
// rather than more methods on it, as checks (ports/check_store.ts) and environments
// (ports/environment_store.ts) are.
//
// Bundles are content-addressed and never deleted. A run frozen on a digest must be able to fetch
// it for its whole life, including after a deploy that shipped a new catalogue version — which is
// why every composition root upserts the catalogue it booted with. Syncs are never deleted
// either: they are each org skill's version history.

import type {
  OrgState,
  OrgVersion,
  RecordedSync,
  SkillBundle,
  SkillIcons,
  SkillSync,
  SkillSyncResult,
  SkillSyncStart,
  SkillVersion,
} from "../core/skills.ts";
import type { SkillSettings } from "../core/types.ts";

export interface SkillStore {
  /** `insert … on conflict do nothing`: the boot upsert of the catalogue. */
  upsertBundles(bundles: SkillBundle[]): Promise<void>;
  /** One bundle by digest, or null when no source ever stored it. */
  bundle(digest: string): Promise<SkillBundle | null>;
  /** The icons stored with these digests' bundles, keyed by digest; a digest with none is left
   * out. One query that reads the icons alone, for the pages that show them. */
  iconsOf(digests: readonly string[]): Promise<Map<string, SkillIcons>>;
  /** The settings as stored, or the defaults while nothing is. */
  settings(): Promise<SkillSettings>;
  /** The admin's switches, written alone: never the org repo or where its syncs have got to. */
  putToggles(
    toggles: Pick<SkillSettings, "disabledCatalogue" | "workingRepoSkills">,
    by: string | null,
  ): Promise<void>;
  /**
   * Names the org skills repo, or none. Another repo or branch than the stored one clears the
   * current version and the last answer, under the sync's lock, so a sync of the old one that
   * finishes afterwards records history and moves nothing.
   */
  setOrgRepo(
    org: { connectedRepoId: string; branch: string | null } | null,
    by: string | null,
  ): Promise<void>;
  /** The org skills repo as the settings page reads it, archived included; null when none. */
  orgState(): Promise<OrgState | null>;
  /** The version runs get. Null when no repo is connected, the connected repo is archived, or
   * nothing synced yet. */
  currentOrg(): Promise<OrgVersion | null>;
  /**
   * A sync's one write, in one transaction: the bundles and the row (or a repeat of the latest
   * failure), and the current version moved only when the settings still name the repo and
   * branch the sync started with, no read that started later has answered, and runs do not
   * already get this tree under these rules. A tree or a failure that moves nothing is recorded
   * as `superseded`; an unchanged answer about a tree runs no longer get is `behind`.
   */
  recordSync(start: SkillSyncStart, result: SkillSyncResult): Promise<RecordedSync>;
  /** Sync history across every repo, newest first, by `finishedAt`. `cursor` is the previous
   * page's `nextCursor` (`encodeListCursor` of its last row's finish time and id). */
  syncs(page: { cursor?: string; limit: number }): Promise<
    { syncs: SkillSync[]; nextCursor: string | null }
  >;
  /** One org skill's versions in one repo and branch, newest first: only syncs that became the
   * version runs get, never a superseded read. */
  versionsOf(connectedRepoId: string, branch: string, name: string): Promise<SkillVersion[]>;
}

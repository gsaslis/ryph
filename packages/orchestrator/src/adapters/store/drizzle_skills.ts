// The drizzle `SkillStore` — the same database and conventions as drizzle.ts: reads through
// `db.query.*`, and the `skill_bundles` and `skill_syncs` columns mirror the core `SkillBundle`
// and `SkillSync` field for field, with the time a digest was first stored beside a bundle.
//
// Invariants:
// - every write to where the org repo's syncs have got to (the settings' org columns, a sync row
//   and its entries) runs in one transaction under `SKILLS_SYNC_TX_LOCK`, so a sync, a racing
//   sync and an admin changing the repo are serialized against each other and nothing else
// - the toggles are written alone, by an upsert of their own columns: an admin flipping a switch
//   never writes back a version pointer a sync moved in between
// - the settings row is read as the defaults while it does not exist, so nothing seeds it

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  bundleOf,
  type OrgSkill,
  type OrgState,
  type SkillSync,
  type SkillVersion,
} from "../../core/skills.ts";
import { DEFAULT_SKILL_SETTINGS, type SkillSettings } from "../../core/types.ts";
import type { SkillStore } from "../../ports/skill_store.ts";
import { decodeListCursor, encodeListCursor } from "../../ports/task_store.ts";
import type { OrchestratorDbHandle } from "./db/db.ts";
import * as schema from "./db/schema.ts";

/** The settings row's constant id: one deployment, one row. */
const SETTINGS_ROW = "deployment";

/**
 * The advisory lock a sync's write and an org repo change take, in the orchestrator's number
 * space (listed in `main.ts`). It must stay apart from the reconcile's leader lock
 * (`LOCK_SKILLS_RECONCILE`): the reconcile holds that on its own session while its sync writes
 * here on a pooled connection, so one shared key would wait on itself forever.
 */
const SKILLS_SYNC_TX_LOCK = 8_100_008;

type SettingsRow = typeof schema.skillSettings.$inferSelect;
type Tx = Parameters<Parameters<OrchestratorDbHandle["db"]["transaction"]>[0]>[0];

function toSettings(row: SettingsRow | undefined): SkillSettings {
  if (row === undefined) return DEFAULT_SKILL_SETTINGS;
  return {
    disabledCatalogue: row.disabledCatalogue,
    workingRepoSkills: row.workingRepoSkills,
    org: row.orgRepoId === null ? null : {
      connectedRepoId: row.orgRepoId,
      branch: row.orgBranch,
      currentSyncId: row.orgCurrentSyncId,
      checkedAt: row.orgCheckedAt,
      checkedCommit: row.orgCheckedCommit,
    },
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/** A whole row to insert when none exists yet: the defaults, then whatever the write sets. */
function freshRow(at: string, set: Partial<SettingsRow>): SettingsRow {
  return {
    id: SETTINGS_ROW,
    disabledCatalogue: DEFAULT_SKILL_SETTINGS.disabledCatalogue,
    workingRepoSkills: DEFAULT_SKILL_SETTINGS.workingRepoSkills,
    orgRepoId: null,
    orgBranch: null,
    orgCurrentSyncId: null,
    orgCheckedAt: null,
    orgCheckedCommit: null,
    orgCheckedStartedAt: null,
    updatedAt: at,
    updatedBy: null,
    ...set,
  };
}

export function drizzleSkillStore(handle: OrchestratorDbHandle, now: () => Date): SkillStore {
  const { db } = handle;

  /** Upserts only the columns `set` names. */
  const writeSettings = async (q: Tx | typeof db, set: Partial<SettingsRow>) => {
    await q.insert(schema.skillSettings)
      .values(freshRow(now().toISOString(), set))
      .onConflictDoUpdate({ target: schema.skillSettings.id, set });
  };

  const readSettingsRow = async (q: Tx | typeof db) => {
    const [row] = await q.select().from(schema.skillSettings)
      .where(eq(schema.skillSettings.id, SETTINGS_ROW));
    return row as SettingsRow | undefined;
  };

  const entriesOf = async (syncId: string): Promise<OrgSkill[]> => {
    const rows = await db.query.skillSyncEntries.findMany({
      where: (e, { eq }) => eq(e.syncId, syncId),
      orderBy: (e, { asc }) => [asc(e.name)],
    });
    return rows.map((r) => ({
      name: r.name,
      description: r.description,
      digest: r.digest,
      frontmatter: r.frontmatter,
      presentation: r.presentation,
    }));
  };

  const orgState = async (): Promise<OrgState | null> => {
    const settings = toSettings(await readSettingsRow(db));
    if (settings.org === null) return null;
    const { org } = settings;
    const repo = await db.query.connectedRepos.findFirst({
      where: (r, { eq }) => eq(r.id, org.connectedRepoId),
    });
    // The foreign key holds the row; a missing one is a database edited by hand.
    if (repo === undefined) return null;
    // The foreign key holds this row too, so a pointer is always a sync.
    const sync = org.currentSyncId === null ? undefined : await db.query.skillSyncs.findFirst({
      where: (s, { eq }) => eq(s.id, org.currentSyncId!),
    });
    const current = sync === undefined ? null : { sync, skills: await entriesOf(sync.id) };
    // The failure still standing: the newest failed read of this repo and branch, newer than the
    // version runs get and than the last answer. A read that succeeded after it moved one of the
    // two; a failure of a branch the settings named before is not this one's.
    const branch = org.branch ?? repo.defaultBranch;
    const failed = await db.query.skillSyncs.findFirst({
      where: (s, { eq, and }) =>
        and(eq(s.connectedRepoId, repo.id), eq(s.branch, branch), eq(s.outcome, "failed")),
      orderBy: (s, { desc }) => [desc(s.finishedAt), desc(s.id)],
    });
    const standing = failed !== undefined &&
      (current === null || failed.finishedAt > current.sync.finishedAt) &&
      (org.checkedAt === null || failed.finishedAt > org.checkedAt);
    return {
      repo,
      branch: org.branch,
      current,
      checkedAt: org.checkedAt,
      checkedCommit: org.checkedCommit,
      lastFailure: standing ? failed : null,
    };
  };

  return {
    async upsertBundles(bundles) {
      if (bundles.length === 0) return;
      // A digest is its content, so a row that exists already holds these exact files: nothing
      // to update, and two replicas booting at once write one row.
      const createdAt = now().toISOString();
      await db.insert(schema.skillBundles)
        .values(
          bundles.map((b) => ({ digest: b.digest, files: b.files, bytes: b.bytes, createdAt })),
        )
        .onConflictDoNothing({ target: schema.skillBundles.digest });
    },
    async bundle(digest) {
      const row = await db.query.skillBundles.findFirst({
        columns: { digest: true, files: true, bytes: true },
        where: (b, { eq }) => eq(b.digest, digest),
      });
      return row === undefined ? null : { digest: row.digest, files: row.files, bytes: row.bytes };
    },
    async iconsOf(digests) {
      if (digests.length === 0) return new Map();
      const rows = await db.select({
        digest: schema.skillBundles.digest,
        icons: schema.skillBundles.icons,
      }).from(schema.skillBundles)
        .where(and(
          inArray(schema.skillBundles.digest, [...new Set(digests)]),
          isNotNull(schema.skillBundles.icons),
        ));
      return new Map(rows.flatMap((r) => r.icons === null ? [] : [[r.digest, r.icons]]));
    },
    async settings() {
      return toSettings(await readSettingsRow(db));
    },
    async putToggles(toggles, by) {
      await writeSettings(db, {
        disabledCatalogue: toggles.disabledCatalogue,
        workingRepoSkills: toggles.workingRepoSkills,
        updatedAt: now().toISOString(),
        updatedBy: by,
      });
    },
    async setOrgRepo(org, by) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${SKILLS_SYNC_TX_LOCK})`);
        const was = toSettings(await readSettingsRow(tx)).org;
        const same = org !== null && was !== null &&
          was.connectedRepoId === org.connectedRepoId && was.branch === org.branch;
        await writeSettings(tx, {
          orgRepoId: org?.connectedRepoId ?? null,
          orgBranch: org?.branch ?? null,
          // Another repo or branch starts from nothing: a version of the old one is never what
          // runs get, and the next sync sets all four.
          ...(same ? {} : {
            orgCurrentSyncId: null,
            orgCheckedAt: null,
            orgCheckedCommit: null,
            orgCheckedStartedAt: null,
          }),
          updatedAt: now().toISOString(),
          updatedBy: by,
        });
      });
    },
    orgState,
    async currentOrg() {
      const state = await orgState();
      if (state === null || state.repo.archivedAt !== null || state.current === null) return null;
      return {
        connectedRepoId: state.repo.id,
        repoRef: state.repo.repoRef,
        sync: state.current.sync,
        skills: state.current.skills,
        lastFailure: state.lastFailure,
      };
    },
    async recordSync(start, result) {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${SKILLS_SYNC_TX_LOCK})`);
        const row = await readSettingsRow(tx);
        const org = toSettings(row).org;
        const stillCurrent = org !== null && org.connectedRepoId === start.connectedRepoId &&
          org.branch === start.settingsBranch;
        const answered = (commit: string) =>
          writeSettings(tx, {
            orgCheckedAt: result.finishedAt,
            orgCheckedCommit: commit,
            orgCheckedStartedAt: start.startedAt,
          });
        const current = stillCurrent && org.currentSyncId !== null
          ? await tx.query.skillSyncs.findFirst({
            where: (s, { eq }) => eq(s.id, org.currentSyncId!),
          })
          : undefined;
        // A read that started after this one already answered: it landed a tree, found the one
        // runs get unchanged, or failed. Start order is the order the store can see, so this
        // one's answer is taken as the older and overwrites nothing. Two pushes in quick
        // succession, or a push racing a Sync now, would otherwise put runs back on the first
        // push's tree, the last answer back on its commit, a failure it hit in front of a newer
        // success, or a slow tree in front of a newer read that found the branch gone, until the
        // next read. Every answer that is not superseded moves `orgCheckedStartedAt`, a landed
        // tree and a standing failure included, and only forward, so it is the latest start of
        // them all.
        const checkedStartedAt = stillCurrent ? row?.orgCheckedStartedAt ?? null : null;
        const overtaken = checkedStartedAt !== null && checkedStartedAt > start.startedAt;

        if (result.kind === "unchanged") {
          if (!stillCurrent || overtaken) return { kind: "superseded", sync: null };
          // The forge compared the branch with the tree runs got when this read started. A read
          // that started earlier may have landed another tree since: then the branch holding the
          // old tree again (a revert) is news, and the sync reads it whole.
          if (
            current === undefined || current.treeId !== result.treeId ||
            current.rulesVersion !== result.rulesVersion
          ) {
            return { kind: "behind" };
          }
          await answered(result.commit);
          return { kind: "up-to-date" };
        }

        if (result.kind === "failed") {
          const failure = (outcome: SkillSync["outcome"]): SkillSync => ({
            id: start.id,
            connectedRepoId: start.connectedRepoId,
            branch: start.branch,
            trigger: start.trigger,
            outcome,
            failure: result.failure,
            rulesVersion: result.rulesVersion,
            commit: result.commit,
            treeId: null,
            skillCount: 0,
            warnings: [],
            error: result.error,
            repeats: 1,
            requestedBy: start.requestedBy,
            startedAt: start.startedAt,
            finishedAt: result.finishedAt,
          });
          // A standing failure is an answer too: a read that started before it and finishes after
          // it is overtaken, so a slow tree cannot land over the news that the branch is gone and
          // hide the failure behind its later `finishedAt`. The last answer's time and commit stay
          // the last success's.
          const failedAt = () => writeSettings(tx, { orgCheckedStartedAt: start.startedAt });
          // A failure a later read answered past, or of a repo or branch an admin has since
          // swapped out, never stands: runs are on what the newer answer found, and the page must
          // not say the latest read failed. It is kept as history, apart from the failures.
          if (!stillCurrent || overtaken) {
            const sync = failure("superseded");
            await tx.insert(schema.skillSyncs).values(sync);
            return { kind: "superseded", sync };
          }
          const [latest] = await tx.select().from(schema.skillSyncs)
            .where(and(
              eq(schema.skillSyncs.connectedRepoId, start.connectedRepoId),
              eq(schema.skillSyncs.branch, start.branch),
            ))
            .orderBy(desc(schema.skillSyncs.finishedAt), desc(schema.skillSyncs.id))
            .limit(1);
          if (
            latest !== undefined && latest.outcome === "failed" &&
            latest.failure === result.failure && latest.error === result.error
          ) {
            // The same failure again: an hourly reconcile against a deleted branch is one row
            // with a count, not a row an hour forever.
            const [bumped] = await tx.update(schema.skillSyncs)
              .set({ repeats: latest.repeats + 1, finishedAt: result.finishedAt })
              .where(eq(schema.skillSyncs.id, latest.id))
              .returning();
            await failedAt();
            return { kind: "failed", sync: bumped };
          }
          const sync = failure("failed");
          await tx.insert(schema.skillSyncs).values(sync);
          await failedAt();
          return { kind: "failed", sync };
        }

        // A tree. When runs already get this tree judged by these rules, a second row would be
        // the same version twice: two syncs racing (a push and a Sync now) record one.
        if (
          current !== undefined && current.treeId === result.treeId &&
          current.rulesVersion === result.rulesVersion
        ) {
          if (!overtaken) await answered(result.commit);
          return { kind: "up-to-date" };
        }
        // A slow read of a repo or branch an admin has since swapped out, or disconnected, or one
        // a later read already answered past, is history: it must not point runs back at what it
        // saw, and it is kept apart from the versions runs got.
        const lands = stillCurrent && !overtaken;
        // The icons go in with the bundle, once per digest. A digest already stored keeps its
        // files, which the digest fixes, but takes the icons this sync judged when they differ:
        // the icon rules can change under the same bytes (a cap, the path grammar), and a bundle
        // stored before icons were kept has none. Rows whose icons match are not rewritten.
        if (result.skills.length > 0) {
          await tx.insert(schema.skillBundles)
            .values(result.skills.map((s) => ({
              ...bundleOf(s),
              icons: s.icons,
              createdAt: result.finishedAt,
            })))
            .onConflictDoUpdate({
              target: schema.skillBundles.digest,
              set: { icons: sql`excluded.icons` },
              setWhere: sql`${schema.skillBundles.icons} is distinct from excluded.icons`,
            });
        }
        const sync: SkillSync = {
          id: start.id,
          connectedRepoId: start.connectedRepoId,
          branch: start.branch,
          trigger: start.trigger,
          outcome: lands ? "synced" : "superseded",
          failure: null,
          rulesVersion: result.rulesVersion,
          commit: result.commit,
          treeId: result.treeId,
          skillCount: result.skills.length,
          warnings: result.warnings,
          error: null,
          repeats: 1,
          requestedBy: start.requestedBy,
          startedAt: start.startedAt,
          finishedAt: result.finishedAt,
        };
        await tx.insert(schema.skillSyncs).values(sync);
        if (result.skills.length > 0) {
          await tx.insert(schema.skillSyncEntries).values(result.skills.map((s) => ({
            syncId: sync.id,
            name: s.name,
            description: s.description,
            digest: s.digest,
            frontmatter: s.frontmatter,
            presentation: s.presentation,
          })));
        }
        if (!lands) return { kind: "superseded", sync };
        await writeSettings(tx, {
          orgCurrentSyncId: sync.id,
          orgCheckedAt: result.finishedAt,
          orgCheckedCommit: result.commit,
          orgCheckedStartedAt: start.startedAt,
        });
        return { kind: "synced", sync };
      });
    },
    async syncs(page) {
      // The cursor carries the sort key it stopped at, so a page starts where the last one ended
      // even when a repeated failure has since moved that row's `finishedAt`.
      const after = decodeListCursor(page.cursor);
      const syncs = schema.skillSyncs;
      const rows = await db.select().from(syncs)
        .where(
          after === null
            ? undefined
            : sql`(${syncs.finishedAt}, ${syncs.id}) < (${after.createdAt}, ${after.id})`,
        )
        .orderBy(desc(syncs.finishedAt), desc(syncs.id))
        .limit(page.limit + 1);
      const items = rows.slice(0, page.limit);
      const last = items.at(-1);
      return {
        syncs: items,
        nextCursor: rows.length > page.limit && last !== undefined
          ? encodeListCursor({ createdAt: last.finishedAt, id: last.id })
          : null,
      };
    },
    async versionsOf(connectedRepoId, branch, name) {
      // Every version runs got from this repo and branch, newest first, and the entry each holds
      // for the name. The syncs are walked oldest first, so consecutive syncs of the same digest
      // merge into one version, and the answer is reversed at the end. A sync without the skill
      // ends a version, so a skill removed and re-added is two versions even when its files came
      // back unchanged. Another branch's syncs are another lineage, and a superseded read was
      // never a version at all.
      const ofLineage = and(
        eq(schema.skillSyncs.connectedRepoId, connectedRepoId),
        eq(schema.skillSyncs.branch, branch),
        eq(schema.skillSyncs.outcome, "synced"),
      );
      const synced = await db.select({
        id: schema.skillSyncs.id,
        commit: schema.skillSyncs.commit,
        at: schema.skillSyncs.finishedAt,
      }).from(schema.skillSyncs)
        .where(ofLineage)
        .orderBy(schema.skillSyncs.finishedAt, schema.skillSyncs.id);
      if (synced.length === 0) return [];
      const entries = await db.select({
        syncId: schema.skillSyncEntries.syncId,
        digest: schema.skillSyncEntries.digest,
        description: schema.skillSyncEntries.description,
      }).from(schema.skillSyncEntries)
        .innerJoin(schema.skillSyncs, eq(schema.skillSyncs.id, schema.skillSyncEntries.syncId))
        .where(and(eq(schema.skillSyncEntries.name, name), ofLineage));
      const bySync = new Map(entries.map((e) => [e.syncId, e]));
      const versions: SkillVersion[] = [];
      let open: SkillVersion | null = null;
      for (const sync of synced) {
        const entry = bySync.get(sync.id);
        if (entry === undefined) {
          open = null;
          continue;
        }
        if (open !== null && open.digest === entry.digest) {
          open.lastSync = sync;
          continue;
        }
        open = {
          digest: entry.digest,
          description: entry.description,
          firstSync: sync,
          lastSync: sync,
        };
        versions.push(open);
      }
      return versions.reverse();
    },
  };
}

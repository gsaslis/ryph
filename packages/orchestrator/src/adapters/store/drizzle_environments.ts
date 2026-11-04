// The drizzle `EnvironmentStore` — the same database and conventions as drizzle.ts: reads through
// `db.query.*`, and `environments` and `patch_builds` columns mirror the core `Environment` and
// `PatchBuild` types field for field, so rows need no mapping.

import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  notExists,
  or,
  type SQL,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { BUILD_PRIORITY, type Environment } from "../../core/types.ts";
import { appendRefusal, type EgressRefusal } from "../../core/egress.ts";
import { rowsOf } from "@ryph/db";
import type { EnvironmentStore } from "../../ports/environment_store.ts";
import { DIGEST_PATTERN, isDigest } from "../../helpers/digest.ts";
import { decodeListCursor, encodeListCursor } from "../../ports/task_store.ts";
import type { OrchestratorDbHandle } from "./db/db.ts";
import * as schema from "./db/schema.ts";

const DEFAULT_SUBJECT_PAGE = 200;

/** BUILD_PRIORITY as SQL: the claim order is decided in the database, where the claim is. */
const priority = sql`case ${schema.environments.trigger} ${
  sql.join(
    Object.entries(BUILD_PRIORITY).map(([trigger, rank]) =>
      sql`when ${trigger} then ${sql.raw(String(rank))}`
    ),
    sql` `,
  )
} else 1 end`;

/**
 * A whole-row write minus the columns only a narrow write writes.
 *
 * `egressRefusals` is written by `recordEnvironmentEgressRefusal` alone, exactly as a run's
 * acknowledgement is written only by its own mark (drizzle.ts, `saveRun`). Without this the
 * settle would put back the copy of the row its builder read when it was claimed, and every
 * host refused while the build ran would vanish at the moment the build finished — which is
 * the one moment anybody reads them. `imagesRemovedAt` likewise, by
 * `markEnvironmentImagesRemoved`.
 */
function revisable(
  environment: Environment,
): Omit<Environment, "egressRefusals" | "imagesRemovedAt"> {
  const { egressRefusals: _refusals, imagesRemovedAt: _removed, ...rest } = environment;
  return rest;
}

export function drizzleEnvironmentStore(handle: OrchestratorDbHandle): EnvironmentStore {
  const { db } = handle;
  return {
    async createEnvironment(environment) {
      await db.insert(schema.environments).values(environment);
    },
    async getEnvironment(id) {
      const row = await db.query.environments.findFirst({ where: (e, { eq }) => eq(e.id, id) });
      return row ?? null;
    },
    async saveEnvironment(environment) {
      await db.insert(schema.environments).values(environment)
        .onConflictDoUpdate({ target: schema.environments.id, set: revisable(environment) });
    },
    async saveEnvironmentIfStatus(environment, expected) {
      const updated = await db.update(schema.environments).set(revisable(environment))
        .where(and(
          eq(schema.environments.id, environment.id),
          inArray(schema.environments.status, [...expected]),
        ))
        .returning({ id: schema.environments.id });
      return updated.length > 0;
    },
    async recordEnvironmentEgressRefusal(environmentId, refusal) {
      // A read-modify-write under a row lock: two reports of one build can race, and the build
      // that settles beside them writes the whole row. The lock is what makes the append and
      // the settle order rather than overwrite.
      return await db.transaction(async (tx) => {
        const rows = rowsOf<{ status: string; egress_refusals: EgressRefusal[] | null }>(
          await tx.execute(
            sql`select "status", "egress_refusals" from "environments" where "id" = ${environmentId} for update`,
          ),
        );
        const row = rows[0];
        if (row === undefined) return "ended";
        // Only a build still in flight has anything to learn from a refusal. A settled row is
        // the record, and the proxy is told to stop reporting for that claim.
        if (row.status !== "queued" && row.status !== "building") return "ended";
        const next = appendRefusal(row.egress_refusals, refusal);
        if (next === null) return "duplicate";
        await tx.update(schema.environments).set({ egressRefusals: next })
          .where(eq(schema.environments.id, environmentId));
        return "recorded";
      });
    },
    async listEnvironmentsForSubject(subjectKind, subjectId, opts = {}) {
      return await db.query.environments.findMany({
        where: (e, { and, eq }) =>
          and(
            eq(e.subjectKind, subjectKind),
            eq(e.subjectId, subjectId),
            ...(opts.ref === undefined ? [] : [eq(e.ref, opts.ref)]),
          ),
        orderBy: (e, { desc }) => [desc(e.createdAt), desc(e.id)],
        limit: opts.limit ?? DEFAULT_SUBJECT_PAGE,
      });
    },
    async listEnvironments(query) {
      const e = schema.environments;
      const filters: SQL[] = [];
      const after = decodeListCursor(query.cursor);
      // A row comparison, as the task list's cursor is.
      if (after !== null) {
        filters.push(sql`(${e.createdAt}, ${e.id}) < (${after.createdAt}, ${after.id})`);
      }
      if (query.statuses !== undefined) {
        if (query.statuses.length === 0) return { environments: [], nextCursor: null };
        filters.push(inArray(e.status, [...query.statuses]));
      }
      if (query.subject !== undefined) {
        filters.push(eq(e.subjectKind, query.subject.kind), eq(e.subjectId, query.subject.id));
      }
      if (query.subjectKinds !== undefined) {
        if (query.subjectKinds.length === 0) return { environments: [], nextCursor: null };
        filters.push(inArray(e.subjectKind, [...query.subjectKinds]));
      }
      if (query.branchBuildsFor !== undefined) {
        // `scopeFilter`'s rule for a task over its frozen repos (drizzle.ts), over the build's
        // frozen checkouts: at least one, and none the caller may not write.
        const writable = query.branchBuildsFor;
        const outsider = writable.length === 0
          ? sql`SELECT 1`
          : sql`SELECT 1 FROM jsonb_array_elements(${e.plan} -> 'checkouts') AS c
              WHERE c ->> 'connectedRepoId' IS NULL OR c ->> 'connectedRepoId' NOT IN (${
            sql.join(writable.map((id) => sql`${id}`), sql`, `)
          })`;
        filters.push(
          or(
            eq(e.defaultBranch, true),
            sql`(jsonb_array_length(${e.plan} -> 'checkouts') > 0 AND NOT EXISTS (${outsider}))`,
          )!,
        );
      }
      const rows = await db.select().from(e)
        .where(filters.length === 0 ? undefined : and(...filters))
        .orderBy(desc(e.createdAt), desc(e.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        environments: page,
        nextCursor: rows.length > query.limit && last !== undefined ? encodeListCursor(last) : null,
      };
    },
    async listEnvironmentsByStatus(statuses) {
      if (statuses.length === 0) return [];
      return await db.query.environments.findMany({
        where: (e, { inArray }) => inArray(e.status, [...statuses]),
        orderBy: (e, { asc }) => [asc(e.createdAt), asc(e.id)],
      });
    },
    async listImagesToRemove(before, limit, after) {
      return await db.query.environments.findMany({
        where: (e, { and, eq, gt, isNull, lt, or }) =>
          and(
            // Literals, not parameters, so the planner can prove the partial index's predicate
            // (`environments_images_to_remove`) under a generic plan too.
            sql`${e.status} IN ('superseded', 'failed')`,
            isNull(e.imagesRemovedAt),
            lt(e.updatedAt, before),
            after === undefined ? undefined : or(
              gt(e.updatedAt, after.updatedAt),
              and(eq(e.updatedAt, after.updatedAt), gt(e.id, after.id)),
            ),
          ),
        orderBy: (e, { asc }) => [asc(e.updatedAt), asc(e.id)],
        limit,
      });
    },
    async listEnvironmentsNamingDigests(digests) {
      const wanted = [...new Set(digests.filter(isDigest))];
      if (wanted.length === 0) return [];
      // Each reference's digest compared exactly: what follows its last `@`. A table scan, run
      // by the hourly reconcile and before a removal, over rows that number in the thousands.
      const digestOf = (column: SQLWrapper) =>
        sql`substring(${column} from ${sql.raw(`'@(${DIGEST_PATTERN})$'`)})`;
      return await db.query.environments.findMany({
        where: (e, { inArray, or }) =>
          or(
            inArray(digestOf(e.image), wanted),
            inArray(digestOf(e.bakedImage), wanted),
            inArray(digestOf(e.machineImage), wanted),
          ),
      });
    },
    async listEnvironmentsByBakedImage(image) {
      return await db.query.environments.findMany({
        where: (e, { eq }) => eq(e.bakedImage, image),
      });
    },
    async markEnvironmentImagesRemoved(id, at) {
      await db.update(schema.environments).set({ imagesRemovedAt: at })
        .where(and(
          eq(schema.environments.id, id),
          inArray(schema.environments.status, ["superseded", "failed"]),
        ));
    },
    async claimNextBuild(at, maxInFlight) {
      // The cap is a COUNT, and no row lock can hold a count: two claimers that each read one
      // building row would both claim a second. A table lock that conflicts with itself (and
      // with nothing a reader takes) serializes the claimers, briefly, and only them.
      return await db.transaction(async (tx) => {
        await tx.execute(sql`lock table ${schema.environments} in share row exclusive mode`);
        const [{ building }] = await tx.select({ building: count() }).from(schema.environments)
          .where(eq(schema.environments.status, "building"));
        if (building >= maxInFlight) return null;
        const next = await tx.query.environments.findFirst({
          where: (e, { eq }) => eq(e.status, "queued"),
          orderBy: (e, { asc }) => [asc(priority), asc(e.createdAt), asc(e.id)],
        });
        if (next === undefined) return null;
        const claimed: Environment = { ...next, status: "building", startedAt: at, updatedAt: at };
        await tx.update(schema.environments)
          .set({ status: "building", startedAt: at, updatedAt: at })
          .where(eq(schema.environments.id, next.id));
        return claimed;
      });
    },
    async touchBuild(id, at) {
      await db.update(schema.environments).set({ updatedAt: at })
        .where(and(
          eq(schema.environments.id, id),
          eq(schema.environments.status, "building"),
        ));
    },
    async claimStrandedBuild(id, untouchedSince, at) {
      // No lock and no transaction: the WHERE *is* the claim. Two replicas that both read the
      // same cold row send the same conditional UPDATE, and the second one matches no row
      // because the first has already moved `updated_at` on.
      const claimed = await db.update(schema.environments).set({ updatedAt: at })
        .where(and(
          eq(schema.environments.id, id),
          eq(schema.environments.status, "building"),
          eq(schema.environments.updatedAt, untouchedSince),
        ))
        .returning();
      return claimed[0] ?? null;
    },
    async createBuildGitKey(key) {
      await db.insert(schema.buildGitKeys).values(key);
    },
    async getBuildGitKeyByTokenHash(tokenHash) {
      const row = await db.query.buildGitKeys.findFirst({
        where: (k, { eq }) => eq(k.tokenHash, tokenHash),
      });
      return row ?? null;
    },
    async revokeBuildGitKeys(environmentId, at) {
      await db.update(schema.buildGitKeys).set({ revokedAt: at })
        .where(and(
          eq(schema.buildGitKeys.environmentId, environmentId),
          isNull(schema.buildGitKeys.revokedAt),
        ));
    },
    async createPatchBuild(row) {
      const inserted = await db.insert(schema.patchBuilds).values(row).onConflictDoNothing()
        .returning({ patchId: schema.patchBuilds.patchId });
      return inserted.length > 0;
    },
    async updatePatchBuildIfClaimed(row, claimedUntil) {
      const updated = await db.update(schema.patchBuilds).set(row)
        .where(and(
          eq(schema.patchBuilds.patchId, row.patchId),
          isNull(schema.patchBuilds.environmentId),
          isNull(schema.patchBuilds.note),
          eq(schema.patchBuilds.claimedUntil, claimedUntil),
        ))
        .returning({ patchId: schema.patchBuilds.patchId });
      return updated.length > 0;
    },
    async getPatchBuild(patchId) {
      const row = await db.query.patchBuilds.findFirst({
        where: (b, { eq }) => eq(b.patchId, patchId),
      });
      return row ?? null;
    },
    async listPatchBuildsForRun(runId) {
      return await db.query.patchBuilds.findMany({
        where: (b, { eq }) => eq(b.runId, runId),
        orderBy: (b, { asc }) => [asc(b.checkedAt), asc(b.patchId)],
      });
    },
    async listPatchBuildsForEnvironment(environmentId) {
      return await db.query.patchBuilds.findMany({
        where: (b, { eq }) => eq(b.environmentId, environmentId),
        orderBy: (b, { asc }) => [asc(b.checkedAt), asc(b.patchId)],
      });
    },
    async listUnreportedPatchBuilds() {
      return await db.query.patchBuilds.findMany({
        where: (b, { isNull }) => isNull(b.reportedAt),
        orderBy: (b, { asc }) => [asc(b.checkedAt), asc(b.patchId)],
      });
    },
    async listUncheckedPatches(since, limit) {
      // An anti-join, so a plain select: the relational API cannot correlate a subquery.
      return await db.select().from(schema.patches)
        .where(and(
          eq(schema.patches.state, "submitted"),
          gte(schema.patches.updatedAt, since),
          notExists(
            db.select({ one: sql`1` }).from(schema.patchBuilds)
              .where(eq(schema.patchBuilds.patchId, schema.patches.id)),
          ),
        ))
        .orderBy(asc(schema.patches.updatedAt), asc(schema.patches.id))
        .limit(limit);
    },
    async markPatchBuildReported(patchId, at) {
      const updated = await db.update(schema.patchBuilds).set({ reportedAt: at })
        .where(and(eq(schema.patchBuilds.patchId, patchId), isNull(schema.patchBuilds.reportedAt)))
        .returning({ patchId: schema.patchBuilds.patchId });
      return updated.length > 0;
    },
  };
}

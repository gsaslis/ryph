// The drizzle `CheckStore` — the same database and conventions as drizzle_environments.ts: reads
// through `db.query.*`, and the check tables' columns mirror the core types in
// core/check_types.ts field for field, so rows need no mapping.

import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { SETTLED_RESULT_STATES, TERMINAL_SUITE_STATES } from "../../core/check_types.ts";
import type { CheckStore } from "../../ports/check_store.ts";
import { decodeListCursor, encodeListCursor } from "../../ports/task_store.ts";
import { scopeFilter } from "./drizzle.ts";
import type { OrchestratorDbHandle } from "./db/db.ts";
import * as schema from "./db/schema.ts";

const DEFAULT_STATE_PAGE = 200;

export function drizzleCheckStore(handle: OrchestratorDbHandle): CheckStore {
  const { db } = handle;
  const suites = schema.checkSuites;
  const results = schema.checkResults;
  const requests = schema.checkRequests;
  const reports = schema.checkForgeReports;
  const keys = schema.checkGitKeys;
  const uploads = schema.checkLocalUploads;
  const approvals = schema.checkApprovals;

  const findSuiteByIdentity: CheckStore["findSuiteByIdentity"] = async (identity) => {
    const row = await db.query.checkSuites.findFirst({
      where: (s, { and, eq }) =>
        and(
          eq(s.connectedRepoId, identity.connectedRepoId),
          eq(s.commit, identity.commit),
          eq(s.checksBlob, identity.checksBlob),
          eq(s.environmentKey, identity.environmentKey),
          eq(s.inputsKey, identity.inputsKey),
        ),
    });
    return row ?? null;
  };

  return {
    async claimSuite(suite) {
      // The unique identity index IS the claim: a second insert of the same identity lands on
      // nothing, and the row that stands is read back.
      const inserted = await db.insert(suites).values(suite).onConflictDoNothing()
        .returning({ id: suites.id });
      if (inserted.length > 0) return { suite, created: true };
      const standing = await findSuiteByIdentity(suite);
      if (standing === null) throw new Error(`suite ${suite.id} neither inserted nor found`);
      return { suite: standing, created: false };
    },
    async getSuite(id) {
      const row = await db.query.checkSuites.findFirst({ where: (s, { eq }) => eq(s.id, id) });
      return row ?? null;
    },
    findSuiteByIdentity,
    async setSuiteRyphChanged(id, ryphChanged) {
      await db.update(suites).set({ ryphChanged })
        .where(and(eq(suites.id, id), isNull(suites.ryphChanged)));
    },
    async saveSuiteIf(suite, expected) {
      const lease = expected.leaseUntil === undefined ? [] : [
        expected.leaseUntil === null ? isNull(suites.leaseUntil) : eq(
          suites.leaseUntil,
          expected.leaseUntil,
        ),
      ];
      const { version: _read, ...fields } = suite;
      const updated = await db.update(suites)
        .set({
          ...fields,
          // Stamped outside the version (`setSuiteRyphChanged`): a row read before it keeps it.
          ryphChanged: sql`coalesce(${suites.ryphChanged}, ${suite.ryphChanged})`,
          version: sql`${suites.version} + 1`,
        })
        .where(and(
          eq(suites.id, suite.id),
          inArray(suites.state, [...expected.states]),
          eq(suites.generation, expected.generation),
          ...lease,
          ...(expected.version === undefined ? [] : [eq(suites.version, expected.version)]),
        ))
        .returning({ id: suites.id });
      return updated.length > 0;
    },
    async listSuitesByState(states, limit = DEFAULT_STATE_PAGE, afterId) {
      if (states.length === 0) return [];
      if (afterId !== undefined) {
        return await db.query.checkSuites.findMany({
          where: and(inArray(suites.state, [...states]), gt(suites.id, afterId)),
          orderBy: [asc(suites.id)],
          limit,
        });
      }
      return await db.query.checkSuites.findMany({
        where: (s, { inArray }) => inArray(s.state, [...states]),
        orderBy: (s, { asc }) => [asc(s.updatedAt), asc(s.id)],
        limit,
      });
    },
    async countSuitesByState(states) {
      if (states.length === 0) return 0;
      const [{ n }] = await db.select({ n: count() }).from(suites)
        .where(inArray(suites.state, [...states]));
      return n;
    },
    async listSuitesForCommit(connectedRepoId, commit) {
      return await db.query.checkSuites.findMany({
        where: (s, { and, eq }) =>
          and(eq(s.connectedRepoId, connectedRepoId), eq(s.commit, commit)),
        orderBy: (s, { desc }) => [desc(s.createdAt), desc(s.id)],
      });
    },
    async listSuitesWaitingOn(environmentId) {
      return await db.query.checkSuites.findMany({
        where: (s, { and, eq }) => and(eq(s.environmentId, environmentId), eq(s.state, "waiting")),
        orderBy: (s, { asc }) => [asc(s.createdAt), asc(s.id)],
      });
    },
    async hasUnsettledSuiteOn(environmentId) {
      const row = await db.query.checkSuites.findFirst({
        columns: { id: true },
        where: (s, { and, eq, inArray }) =>
          and(
            eq(s.environmentId, environmentId),
            inArray(s.state, ["waiting", "queued", "running"]),
          ),
      });
      return row !== undefined;
    },
    async listSuitesByIds(ids) {
      if (ids.length === 0) return [];
      return await db.query.checkSuites.findMany({
        where: (s, { inArray }) => inArray(s.id, [...ids]),
        orderBy: (s, { asc }) => [asc(s.createdAt), asc(s.id)],
      });
    },
    async listSuites(query) {
      const filters: SQL[] = [];
      const after = decodeListCursor(query.cursor);
      if (after !== null) {
        // A row comparison, as the task list's cursor is.
        filters.push(sql`(${suites.createdAt}, ${suites.id}) < (${after.createdAt}, ${after.id})`);
      }
      if (query.connectedRepoId !== undefined) {
        filters.push(eq(suites.connectedRepoId, query.connectedRepoId));
      }
      if (query.checksRef !== undefined) filters.push(eq(suites.checksRef, query.checksRef));
      if (query.states !== undefined) {
        if (query.states.length === 0) return { suites: [], nextCursor: null };
        filters.push(inArray(suites.state, [...query.states]));
      }
      // The one read into the frozen declaration: a full suite carries no `partial` at all.
      if (query.full) filters.push(sql`(${suites.definition} ->> 'partial') is null`);
      // Who may read a suite, in SQL: `taskIdsOf`'s three ways from a request to a task, and
      // the two a runless asker opens (`ChecksService.readable`).
      const inScope = scopeFilter(query.scope);
      let visibleRequest: SQL | undefined;
      if (inScope !== null && query.scope?.kind === "principal") {
        const tasks = db.select({ id: schema.tasks.id }).from(schema.tasks).where(inScope);
        const runs = db.select({ id: schema.runs.id }).from(schema.runs)
          .where(inArray(schema.runs.taskId, tasks));
        const patches = db.select({ id: schema.patches.id }).from(schema.patches)
          .where(inArray(schema.patches.taskId, tasks));
        const writable = query.scope.writableRepoIds;
        visibleRequest = or(
          inArray(requests.runId, runs),
          // A re-run's request names no run, only the suite's source: a suite a re-run landed on
          // after its first askers were withdrawn has no other way back to their task.
          sql`(${requests.source} ->> 'runId') in ${runs}`,
          inArray(requests.patchId, patches),
          // The reader's own ask from their machine.
          and(
            eq(requests.kind, "local"),
            eq(requests.userId, query.scope.userId),
            inArray(requests.state, ["active", "superseded"]),
          ),
          // A runless ask on a repo the reader may push to.
          ...(writable.length === 0 ? [] : [
            and(
              inArray(requests.kind, ["push", "local"]),
              inArray(requests.connectedRepoId, [...writable]),
            ),
          ]),
        );
        filters.push(inArray(
          suites.id,
          db.select({ id: requests.suiteId }).from(requests).where(visibleRequest),
        ));
      }
      if (query.askedBy !== undefined) {
        if (query.askedBy.length === 0) return { suites: [], nextCursor: null };
        // Only an asker the reader may see counts: a hidden task's request matching would say
        // that it asked.
        filters.push(inArray(
          suites.id,
          db.select({ id: requests.suiteId }).from(requests).where(and(
            inArray(requests.kind, [...query.askedBy]),
            inArray(requests.state, ["active", "superseded"]),
            visibleRequest,
          )),
        ));
      }
      const limit = query.limit;
      const rows = await db.select().from(suites)
        .where(filters.length === 0 ? undefined : and(...filters))
        .orderBy(desc(suites.createdAt), desc(suites.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        suites: page,
        nextCursor: rows.length > limit && last !== undefined ? encodeListCursor(last) : null,
      };
    },
    async upsertResults(rows) {
      if (rows.length === 0) return;
      await db.insert(results).values([...rows])
        .onConflictDoUpdate({
          target: [results.suiteId, results.generation, results.name],
          set: {
            state: sql`excluded.state`,
            exitCode: sql`excluded.exit_code`,
            startedAt: sql`excluded.started_at`,
            finishedAt: sql`excluded.finished_at`,
            logKey: sql`excluded.log_key`,
            logTail: sql`excluded.log_tail`,
            watchedChanged: sql`excluded.watched_changed`,
            inheritedFrom: sql`excluded.inherited_from`,
            // A posted check run keeps its id: a results write never un-knows it.
            forgeRef: sql`coalesce(excluded.forge_ref, ${results.forgeRef})`,
          },
          // A settled row keeps its verdict: the first write of it wins a race.
          setWhere: notInArray(results.state, [...SETTLED_RESULT_STATES]),
        });
    },
    async listResults(suiteId, generation) {
      return await db.query.checkResults.findMany({
        where: (r, { and, eq }) =>
          and(
            eq(r.suiteId, suiteId),
            ...(generation === undefined ? [] : [eq(r.generation, generation)]),
          ),
        orderBy: (r, { asc }) => [asc(r.generation), asc(r.name)],
      });
    },
    async listResultsForGenerations(keys) {
      if (keys.length === 0) return [];
      return await db.query.checkResults.findMany({
        where: or(
          ...keys.map((k) =>
            and(eq(results.suiteId, k.suiteId), eq(results.generation, k.generation))
          ),
        ),
        orderBy: (r, { asc }) => [asc(r.suiteId), asc(r.name)],
      });
    },
    async setResultForgeRef(suiteId, generation, name, forgeRef) {
      await db.update(results).set({ forgeRef })
        .where(and(
          eq(results.suiteId, suiteId),
          eq(results.generation, generation),
          eq(results.name, name),
        ));
    },
    async createRequest(request) {
      await db.insert(requests).values(request);
    },
    async getRequest(id) {
      const row = await db.query.checkRequests.findFirst({ where: (r, { eq }) => eq(r.id, id) });
      return row ?? null;
    },
    async listPushRequests(connectedRepoId, changeRequest) {
      return await db.query.checkRequests.findMany({
        where: and(
          eq(requests.connectedRepoId, connectedRepoId),
          eq(requests.changeRequest, changeRequest),
          eq(requests.kind, "push"),
        ),
        orderBy: [asc(requests.createdAt), asc(requests.id)],
      });
    },
    async saveRequestIf(request, states, expected) {
      if (states.length === 0) return false;
      const note: SQL[] = [];
      if (expected?.note !== undefined) {
        note.push(
          expected.note === null ? isNull(requests.note) : eq(requests.note, expected.note),
        );
      }
      if (expected?.noteNot !== undefined) {
        note.push(sql`${requests.note} is distinct from ${expected.noteNot}`);
      }
      // Never the end: a renewal (`extendRequest`) that landed since the read stands.
      const { expiresAt: _end, ...rest } = request;
      const updated = await db.update(requests).set(rest)
        .where(and(eq(requests.id, request.id), inArray(requests.state, [...states]), ...note))
        .returning({ id: requests.id });
      return updated.length > 0;
    },
    async withdrawRequest(id) {
      const [row] = await db.update(requests)
        .set({ state: "superseded", nextAttemptAt: null })
        .where(and(eq(requests.id, id), inArray(requests.state, ["active", "pending"])))
        .returning();
      return row ?? null;
    },
    async listPendingRequests(now, limit) {
      return await db.query.checkRequests.findMany({
        where: (r, { and, eq, isNull, lte, or }) =>
          and(eq(r.state, "pending"), or(isNull(r.nextAttemptAt), lte(r.nextAttemptAt, now))),
        orderBy: (r, { asc }) => [asc(r.createdAt), asc(r.id)],
        limit,
      });
    },
    async listRequestsForSuite(suiteId) {
      return await db.query.checkRequests.findMany({
        where: (r, { eq }) => eq(r.suiteId, suiteId),
        orderBy: (r, { asc }) => [asc(r.createdAt), asc(r.id)],
      });
    },
    async listRequestsForSuites(suiteIds) {
      if (suiteIds.length === 0) return [];
      return await db.query.checkRequests.findMany({
        where: (r, { inArray }) => inArray(r.suiteId, [...suiteIds]),
        orderBy: (r, { asc }) => [asc(r.createdAt), asc(r.id)],
      });
    },
    async listRequestsForRun(runId) {
      return await db.query.checkRequests.findMany({
        where: (r, { eq }) => eq(r.runId, runId),
        orderBy: (r, { asc }) => [asc(r.createdAt), asc(r.id)],
      });
    },
    async listRequestsForPatches(patchIds) {
      if (patchIds.length === 0) return [];
      return await db.query.checkRequests.findMany({
        where: (r, { inArray }) => inArray(r.patchId, [...patchIds]),
        orderBy: (r, { asc }) => [asc(r.createdAt), asc(r.id)],
      });
    },
    async listLiveLocalRequests(userId) {
      return await db.query.checkRequests.findMany({
        where: and(
          eq(requests.userId, userId),
          inArray(requests.state, ["pending", "active"]),
          eq(requests.kind, "local"),
        ),
        orderBy: [asc(requests.createdAt), asc(requests.id)],
      });
    },
    async listExpiredLocalRequests(now, limit) {
      return await db.query.checkRequests.findMany({
        where: and(
          eq(requests.kind, "local"),
          inArray(requests.state, ["pending", "active"]),
          lte(requests.expiresAt, now),
        ),
        orderBy: [asc(requests.createdAt), asc(requests.id)],
        limit,
      });
    },
    async withdrawExpired(id, now) {
      const [row] = await db.update(requests)
        .set({ state: "superseded", nextAttemptAt: null })
        .where(and(
          eq(requests.id, id),
          inArray(requests.state, ["active", "pending"]),
          lte(requests.expiresAt, now),
        ))
        .returning();
      return row ?? null;
    },
    async extendRequest(id, expiresAt) {
      const [row] = await db.update(requests)
        .set({ expiresAt })
        .where(and(eq(requests.id, id), inArray(requests.state, ["active", "pending"])))
        .returning();
      return row ?? null;
    },
    async claimApproval(approval) {
      // The unique head index IS the claim, as `claimSuite`'s identity index is.
      const inserted = await db.insert(approvals).values(approval).onConflictDoNothing()
        .returning({ id: approvals.id });
      if (inserted.length > 0) return { approval, created: true };
      const standing = await db.query.checkApprovals.findFirst({
        where: (a, { and, eq }) =>
          and(
            eq(a.connectedRepoId, approval.connectedRepoId),
            eq(a.changeRequest, approval.changeRequest),
            eq(a.headSha, approval.headSha),
          ),
      });
      if (standing === undefined) {
        throw new Error(`approval ${approval.id} neither inserted nor found`);
      }
      return { approval: standing, created: false };
    },
    async getApproval(id) {
      const row = await db.query.checkApprovals.findFirst({ where: (a, { eq }) => eq(a.id, id) });
      return row ?? null;
    },
    async listApprovals(connectedRepoId, changeRequest) {
      return await db.query.checkApprovals.findMany({
        where: and(
          eq(approvals.connectedRepoId, connectedRepoId),
          eq(approvals.changeRequest, changeRequest),
        ),
        orderBy: [desc(approvals.createdAt), desc(approvals.id)],
      });
    },
    async saveApprovalIf(approval, states) {
      if (states.length === 0) return false;
      const updated = await db.update(approvals).set(approval)
        .where(and(eq(approvals.id, approval.id), inArray(approvals.state, [...states])))
        .returning({ id: approvals.id });
      return updated.length > 0;
    },
    async claimApprovalComment(id, { at, staleBefore, seen }) {
      const updated = await db.update(approvals).set({ commentClaimedAt: at, updatedAt: at })
        .where(and(
          eq(approvals.id, id),
          eq(approvals.state, "pending"),
          seen === null ? isNull(approvals.commentId) : eq(approvals.commentId, seen),
          or(isNull(approvals.commentClaimedAt), lt(approvals.commentClaimedAt, staleBefore)),
        ))
        .returning({ id: approvals.id });
      return updated.length > 0;
    },
    async releaseApprovalComment(id, at) {
      await db.update(approvals).set({ commentClaimedAt: null })
        .where(and(eq(approvals.id, id), eq(approvals.commentClaimedAt, at)));
    },
    async recordLocalUpload(upload) {
      await db.insert(uploads).values(upload);
    },
    async deleteLocalUpload(id) {
      await db.delete(uploads).where(eq(uploads.id, id));
    },
    async countLocalUploadsSince(userId, since) {
      const [{ n }] = await db.select({ n: count() }).from(uploads)
        .where(and(eq(uploads.userId, userId), gte(uploads.at, since)));
      return n;
    },
    async pruneLocalUploads(before) {
      await db.delete(uploads).where(lt(uploads.at, before));
    },
    async listRequestsForCommit(connectedRepoId, commit) {
      return await db.query.checkRequests.findMany({
        where: (r, { and, eq }) =>
          and(eq(r.connectedRepoId, connectedRepoId), eq(r.commit, commit)),
        orderBy: (r, { asc }) => [asc(r.createdAt), asc(r.id)],
      });
    },
    async countToolRequestsForRun(runId) {
      const [{ n }] = await db.select({ n: count() }).from(requests)
        .where(and(eq(requests.runId, runId), eq(requests.kind, "tool")));
      return n;
    },
    async listRequestsToTell(limit) {
      // A join, so a plain select: the relational API cannot compare across the two tables.
      const rows = await db.select().from(requests)
        .innerJoin(suites, eq(suites.id, requests.suiteId))
        .where(and(
          eq(requests.state, "active"),
          sql`${requests.runId} is not null`,
          inArray(suites.state, [...TERMINAL_SUITE_STATES]),
          or(
            isNull(requests.reportedGeneration),
            lt(requests.reportedGeneration, suites.generation),
          ),
        ))
        .orderBy(requests.createdAt, requests.id)
        .limit(limit);
      return rows.map((row) => row.check_requests);
    },
    async markRequestReported(id, generation) {
      const updated = await db.update(requests).set({ reportedGeneration: generation })
        .where(and(
          eq(requests.id, id),
          or(isNull(requests.reportedGeneration), lt(requests.reportedGeneration, generation)),
        ))
        .returning({ id: requests.id });
      return updated.length > 0;
    },
    async upsertForgeReport(row) {
      await db.insert(reports).values(row)
        .onConflictDoUpdate({
          // One row per asker: the patch's, or the push request's.
          target: row.patchId !== null ? reports.patchId : reports.requestId,
          set: {
            nextAttemptAt: row.nextAttemptAt,
            updatedAt: row.updatedAt,
            revision: sql`${reports.revision} + 1`,
          },
        });
    },
    async getForgeReport(id) {
      const row = await db.query.checkForgeReports.findFirst({
        where: (r, { eq }) => eq(r.id, id),
      });
      return row ?? null;
    },
    async findForgeReport(asker) {
      const row = await db.query.checkForgeReports.findFirst({
        where: "patchId" in asker
          ? eq(reports.patchId, asker.patchId)
          : eq(reports.requestId, asker.requestId),
      });
      return row ?? null;
    },
    async listForgeReportsForCommit(connectedRepoId, headSha) {
      return await db.select().from(reports)
        .where(and(eq(reports.connectedRepoId, connectedRepoId), eq(reports.headSha, headSha)))
        .orderBy(reports.createdAt, reports.id);
    },
    async listDueForgeReports(now, limit) {
      return await db.select().from(reports)
        .where(and(sql`${reports.nextAttemptAt} is not null`, lte(reports.nextAttemptAt, now)))
        .orderBy(reports.nextAttemptAt, reports.id)
        .limit(limit);
    },
    async touchForgeReports(suite, at) {
      await db.update(reports)
        .set({ nextAttemptAt: at, updatedAt: at, revision: sql`${reports.revision} + 1` })
        .where(or(
          eq(reports.suiteId, suite.id),
          and(
            isNull(reports.suiteId),
            eq(reports.connectedRepoId, suite.connectedRepoId),
            eq(reports.headSha, suite.commit),
          ),
        ));
    },
    async repointForgeReports(fromSuiteId, to, at) {
      await db.update(reports)
        .set({
          suiteId: to.id,
          nextAttemptAt: at,
          updatedAt: at,
          revision: sql`${reports.revision} + 1`,
        })
        .where(eq(reports.suiteId, fromSuiteId));
    },
    async settleForgeReport(id, fields, next) {
      const { suiteId, ...rest } = fields;
      await db.update(reports)
        .set({
          ...rest,
          // Only the clock this report read is this report's to move: a touch since then
          // bumped the revision and set a clock of its own, which stands.
          nextAttemptAt:
            sql`case when ${reports.revision} = ${next.readRevision} then ${next.nextAttemptAt}::text else ${reports.nextAttemptAt} end`,
          // Nor is a suite a repoint moved the row onto since.
          ...(suiteId === undefined ? {} : {
            suiteId:
              sql`case when ${reports.suiteId} is not distinct from ${next.readSuiteId}::text then ${suiteId}::text else ${reports.suiteId} end`,
          }),
        })
        .where(eq(reports.id, id));
    },
    async createCheckGitKey(key) {
      await db.insert(keys).values(key);
    },
    async getCheckGitKeyByTokenHash(tokenHash) {
      const row = await db.query.checkGitKeys.findFirst({
        where: (k, { eq }) => eq(k.tokenHash, tokenHash),
      });
      return row ?? null;
    },
    async revokeCheckGitKeys(suiteId, generation, at) {
      await db.update(keys).set({ revokedAt: at })
        .where(and(
          eq(keys.suiteId, suiteId),
          eq(keys.generation, generation),
          isNull(keys.revokedAt),
        ));
    },
    async revokeCheckGitKey(id, at) {
      await db.update(keys).set({ revokedAt: at })
        .where(and(eq(keys.id, id), isNull(keys.revokedAt)));
    },
  };
}

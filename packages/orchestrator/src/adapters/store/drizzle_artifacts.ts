// The drizzle `ArtifactStore` — the same database and conventions as drizzle_background.ts:
// reads through `db.query.*`, writes under the run's row lock, and the artifacts table's columns
// mirror core/artifacts.ts's `Artifact` field for field, so rows need no mapping.

import { and, asc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { rowsOf } from "@ryph/db";
import {
  type Artifact,
  ARTIFACT_PUBLISH_WINDOW_MS,
  MAX_ARTIFACT_ATTEMPTS_PER_HOUR,
  MAX_ARTIFACT_VERSIONS,
  mayVersion,
} from "../../core/artifacts.ts";
import { type RunState, TERMINAL_STATES } from "../../core/types.ts";
import type { ArtifactStore } from "../../ports/artifact_store.ts";
import type { OrchestratorDbHandle } from "./db/db.ts";
import * as schema from "./db/schema.ts";

type Tx = Parameters<Parameters<OrchestratorDbHandle["db"]["transaction"]>[0]>[0];

export function drizzleArtifactStore(handle: OrchestratorDbHandle): ArtifactStore {
  const { db } = handle;
  const a = schema.artifacts;
  const v = schema.artifactVersions;
  const img = schema.artifactVersionImages;
  const att = schema.artifactPublishAttempts;

  /** Takes the run's row lock and answers whether the run still takes writes. */
  const lockLive = async (tx: Tx, runId: string): Promise<boolean> => {
    const rows = rowsOf<{ state: RunState }>(
      await tx.execute(sql`select "state" from "runs" where "id" = ${runId} for update`),
    );
    return rows.length > 0 && !TERMINAL_STATES.has(rows[0].state);
  };

  const live = (id: string) => and(eq(a.id, id), isNull(a.deletedAt));

  /** The current version of a live artifact `runId` created, with this title and document. */
  const sameCreated = async (
    q: Pick<Tx, "select">,
    runId: string,
    title: string,
    html: string,
  ) => {
    const same = await q.select({ id: a.id, version: a.currentVersion }).from(a)
      .innerJoin(v, and(eq(v.artifactId, a.id), eq(v.version, a.currentVersion)))
      .where(and(
        eq(a.originRunId, runId),
        isNull(a.deletedAt),
        eq(v.title, title),
        eq(v.html, html),
      ))
      .orderBy(asc(a.createdAt), asc(a.id))
      .limit(1);
    return same[0] ?? null;
  };

  return {
    async recordAttempt(runId, at) {
      return await db.transaction(async (tx) => {
        if (!(await lockLive(tx, runId))) return { kind: "concluded" } as const;
        const since = new Date(Date.parse(at) - ARTIFACT_PUBLISH_WINDOW_MS).toISOString();
        // What the hour no longer counts goes, so a run keeps at most an hour's rows.
        await tx.delete(att).where(and(eq(att.runId, runId), lte(att.at, since)));
        const recent = await tx.select({ at: att.at }).from(att)
          .where(and(eq(att.runId, runId), gt(att.at, since)))
          .orderBy(asc(att.at));
        if (recent.length >= MAX_ARTIFACT_ATTEMPTS_PER_HOUR) {
          // Free again once enough of them are an hour old to leave room for one more.
          const freeing = recent[recent.length - MAX_ARTIFACT_ATTEMPTS_PER_HOUR].at;
          return {
            kind: "rate_limited",
            retryAt: new Date(Date.parse(freeing) + ARTIFACT_PUBLISH_WINDOW_MS).toISOString(),
          } as const;
        }
        await tx.insert(att).values({ runId, at });
        return { kind: "recorded" } as const;
      });
    },
    async createdByRunWith(runId, title, html) {
      return await sameCreated(db, runId, title, html);
    },
    async publish(input) {
      return await db.transaction(async (tx) => {
        if (!(await lockLive(tx, input.runId))) return { kind: "concluded" } as const;
        let id = input.newId;
        let version = 1;
        if (input.artifactId === null) {
          // The same page published again by the same run is the page it already made.
          const same = await sameCreated(tx, input.runId, input.title, input.html);
          if (same !== null) {
            return { kind: "unchanged", id: same.id, version: same.version } as const;
          }
          await tx.insert(a).values({
            id,
            title: input.title,
            agentId: input.agentId,
            originRunId: input.runId,
            requestedBy: input.requestedBy,
            requestOrigin: input.requestOrigin,
            originChatroomId: input.chatroomId,
            originConversation: input.conversation,
            currentVersion: 1,
            createdAt: input.at,
            updatedAt: input.at,
            deletedAt: null,
          });
        } else {
          // Under the artifact's own lock, so two publishes of one artifact number apart.
          const rows = rowsOf<{
            agent_id: string;
            requested_by: string | null;
            request_origin: Artifact["requestOrigin"];
            origin_chatroom_id: string | null;
            origin_conversation: string | null;
            current_version: number;
          }>(
            await tx.execute(
              sql`select "agent_id", "requested_by", "request_origin", "origin_chatroom_id",
                    "origin_conversation", "current_version" from "artifacts"
                  where "id" = ${input.artifactId} and "deleted_at" is null for update`,
            ),
          );
          if (rows.length === 0) return { kind: "not_found" } as const;
          const row = rows[0];
          const tasks = await tx.selectDistinct({ taskId: v.taskId }).from(v)
            .where(eq(v.artifactId, input.artifactId));
          const allowed = mayVersion(
            {
              agentId: row.agent_id,
              requestedBy: row.requested_by,
              requestOrigin: row.request_origin,
              originChatroomId: row.origin_chatroom_id,
              originConversation: row.origin_conversation,
              deletedAt: null,
            },
            tasks.map((t) => t.taskId),
            input,
          );
          if (!allowed) return { kind: "not_found" } as const;
          id = input.artifactId;
          const current = Number(row.current_version);
          const head = await tx.query.artifactVersions.findFirst({
            where: (r, { and, eq }) => and(eq(r.artifactId, id), eq(r.version, current)),
            columns: { title: true, html: true },
          });
          if (head !== undefined && head.title === input.title && head.html === input.html) {
            return { kind: "unchanged", id, version: current } as const;
          }
          if (current >= MAX_ARTIFACT_VERSIONS) return { kind: "too_many_versions" } as const;
          version = current + 1;
          await tx.update(a)
            .set({ title: input.title, currentVersion: version, updatedAt: input.at })
            .where(eq(a.id, id));
        }
        await tx.insert(v).values({
          artifactId: id,
          version,
          title: input.title,
          html: input.html,
          servedHtml: input.servedHtml,
          bytes: input.bytes,
          runId: input.runId,
          taskId: input.taskId,
          requestedBy: input.requestedBy,
          createdAt: input.at,
        });
        if (input.images.length > 0) {
          await tx.insert(img).values(
            input.images.map((image) => ({ artifactId: id, version, ...image })),
          );
        }
        return { kind: "published", id, version, created: input.artifactId === null } as const;
      });
    },
    async get(id) {
      const row = await db.query.artifacts.findFirst({
        where: (r, { and, eq, isNull }) => and(eq(r.id, id), isNull(r.deletedAt)),
      });
      return row ?? null;
    },
    async versions(id) {
      const found = await db.select({ id: a.id }).from(a).where(live(id));
      if (found.length === 0) return [];
      return await db.query.artifactVersions.findMany({
        where: (r, { eq }) => eq(r.artifactId, id),
        columns: {
          version: true,
          title: true,
          runId: true,
          taskId: true,
          requestedBy: true,
          bytes: true,
          createdAt: true,
        },
        orderBy: (r, { asc }) => [asc(r.version)],
      });
    },
    async versionContent(id, version) {
      const found = await db.select({ id: a.id }).from(a).where(live(id));
      if (found.length === 0) return null;
      const row = await db.query.artifactVersions.findFirst({
        where: (r, { and, eq }) => and(eq(r.artifactId, id), eq(r.version, version)),
        columns: { html: true, servedHtml: true },
      });
      if (row === undefined) return null;
      const images = await db.query.artifactVersionImages.findMany({
        where: (r, { and, eq }) => and(eq(r.artifactId, id), eq(r.version, version)),
        columns: { ref: true, attachmentId: true },
      });
      return { html: row.html, servedHtml: row.servedHtml, images };
    },
    async list({ limit, before }) {
      return await db.query.artifacts.findMany({
        where: (r, { and, isNull, lt, or, eq }) =>
          before === null ? isNull(r.deletedAt) : and(
            isNull(r.deletedAt),
            or(
              lt(r.updatedAt, before.updatedAt),
              and(eq(r.updatedAt, before.updatedAt), lt(r.id, before.id)),
            ),
          ),
        orderBy: (r, { desc }) => [desc(r.updatedAt), desc(r.id)],
        limit,
      });
    },
    async delete(id, at) {
      return await db.transaction(async (tx) => {
        // Under the artifact's lock, so a publish of it waits and then finds it gone.
        const marked = await tx.update(a).set({ deletedAt: at, title: "" }).where(live(id))
          .returning({ id: a.id });
        if (marked.length === 0) return false;
        await tx.delete(img).where(eq(img.artifactId, id));
        await tx.delete(v).where(eq(v.artifactId, id));
        return true;
      });
    },
    async forRuns(runIds) {
      if (runIds.length === 0) return [];
      const versions = await db.query.artifactVersions.findMany({
        where: (r, { inArray }) => inArray(r.runId, [...runIds]),
        columns: { artifactId: true, version: true, runId: true, createdAt: true },
        orderBy: (r, { asc }) => [asc(r.artifactId), asc(r.version)],
      });
      if (versions.length === 0) return [];
      const ids = [...new Set(versions.map((r) => r.artifactId))];
      const rows = await db.select().from(a).where(and(inArray(a.id, ids), isNull(a.deletedAt)));
      return rows
        .sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id))
        .map((artifact) => ({
          artifact,
          versions: versions
            .filter((r) => r.artifactId === artifact.id)
            .map(({ version, runId, createdAt }) => ({ version, runId, createdAt })),
        }));
    },
  };
}

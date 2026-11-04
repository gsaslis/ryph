// The drizzle `MemoryStore` on Postgres — reads via the relational `db.query.*` API where a
// plain filter will do, the builder with `sql` where full-text ranking needs it. Same
// conventions as the other packages' stores.
//
// The one thing decided here rather than in the service is the search score: the database ranks
// with `ts_rank` over an OR of the query's terms, and this normalises the best match to 1 so
// the service can fold it into the memory's own score without knowing what a tsvector is. An
// OR rather than the AND every `plainto_tsquery` builds because the brief's query is a whole
// task description — dozens of words, of which a memory shares three — and a query that demands
// all of them matches nothing.

import { and, asc, desc, eq, gt, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type {
  Audience,
  Feedback,
  Memory,
  MemoryRun,
  Proposal,
  Source,
  Subject,
} from "../../core/types.ts";
import { normalizeClaim } from "../../core/screen.ts";
import { cosine, relevanceOf, VECTOR_MATCH_FLOOR } from "../../core/vector.ts";
import {
  DEFAULT_LIMIT,
  MAX_HYBRID_CANDIDATES,
  MAX_LIMIT,
  type MemoryCounter,
  type MemoryStore,
  type ProposalQuery,
  type ScoredMemory,
  type SubjectCount,
} from "../../ports/store.ts";
import type { MemoryDbHandle } from "./db/db.ts";
import * as schema from "./db/schema.ts";

type MemoryRow = typeof schema.memories.$inferSelect;
type ProposalRow = typeof schema.memoryProposals.$inferSelect;
type FeedbackRow = typeof schema.memoryFeedback.$inferSelect;
type SourceRow = typeof schema.memorySources.$inferSelect;

function toSourceRow(source: Source): SourceRow {
  const { defaultSubject, ...rest } = source;
  return {
    ...rest,
    defaultSubjectKind: defaultSubject.kind,
    defaultSubjectUrl: defaultSubject.kind === "org" ? null : defaultSubject.url,
  };
}

function fromSourceRow(row: SourceRow): Source {
  const { defaultSubjectKind, defaultSubjectUrl, ...rest } = row;
  return {
    ...rest,
    extraction: row.extraction ?? null,
    defaultSubject: defaultSubjectKind === "org"
      ? { kind: "org" }
      : { kind: "repo", url: defaultSubjectUrl ?? "" },
  };
}

function subjectColumns(
  subject: Subject,
): { subjectKind: "org" | "repo"; subjectUrl: string | null } {
  return subject.kind === "org"
    ? { subjectKind: "org", subjectUrl: null }
    : { subjectKind: "repo", subjectUrl: subject.url };
}

function audienceColumns(
  audience: Audience,
): { audienceKind: "all" | "agent"; audienceAgentId: string | null } {
  return audience.kind === "all"
    ? { audienceKind: "all", audienceAgentId: null }
    : { audienceKind: "agent", audienceAgentId: audience.agentId };
}

function toMemoryRow(memory: Memory): MemoryRow {
  const { subject, audience, ...rest } = memory;
  return {
    ...rest,
    normalizedText: normalizeClaim(memory.text),
    ...subjectColumns(subject),
    ...audienceColumns(audience),
  };
}

function fromMemoryRow(row: MemoryRow): Memory {
  const {
    subjectKind,
    subjectUrl,
    audienceKind,
    audienceAgentId,
    normalizedText: _normalized,
    ...rest
  } = row;
  return {
    ...rest,
    subject: subjectKind === "org" ? { kind: "org" } : { kind: "repo", url: subjectUrl ?? "" },
    audience: audienceKind === "all"
      ? { kind: "all" }
      : { kind: "agent", agentId: audienceAgentId ?? "" },
  };
}

function toProposalRow(proposal: Proposal): ProposalRow {
  const { subject, audience, ...rest } = proposal;
  return {
    ...rest,
    subjectKind: subject === null ? null : subject.kind,
    subjectUrl: subject === null || subject.kind === "org" ? null : subject.url,
    audienceKind: audience === null ? null : audience.kind,
    audienceAgentId: audience === null || audience.kind === "all" ? null : audience.agentId,
  };
}

function fromProposalRow(row: ProposalRow): Proposal {
  const { subjectKind, subjectUrl, audienceKind, audienceAgentId, ...rest } = row;
  return {
    ...rest,
    subject: subjectKind === null
      ? null
      : subjectKind === "org"
      ? { kind: "org" }
      : { kind: "repo", url: subjectUrl ?? "" },
    audience: audienceKind === null
      ? null
      : audienceKind === "all"
      ? { kind: "all" }
      : { kind: "agent", agentId: audienceAgentId ?? "" },
  };
}

function toFeedbackRow(
  tenantId: string,
  feedback: Feedback,
): typeof schema.memoryFeedback.$inferInsert {
  const { kind, at, ...detail } = feedback;
  const memoryId = "memoryId" in feedback ? feedback.memoryId : null;
  const runId = "runId" in feedback ? feedback.runId : null;
  const userId = "userId" in feedback ? feedback.userId : null;
  return { tenantId, kind, memoryId, runId, userId, detail, at };
}

function fromFeedbackRow(row: FeedbackRow): Feedback {
  return { kind: row.kind, ...row.detail, at: row.at } as Feedback;
}

/**
 * The query's terms as one OR'd tsquery: lowercase word characters only, so nothing a caller
 * types can reach the tsquery parser. Null when there is nothing to search for.
 */
export function searchTerms(query: string): string | null {
  const words = [...new Set(query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])];
  return words.length === 0 ? null : words.slice(0, 64).join(" | ");
}

function subjectFilter(subjects: Subject[]): SQL | undefined {
  const arms = subjects.map((s) =>
    s.kind === "org"
      ? and(eq(schema.memories.subjectKind, "org"), isNull(schema.memories.subjectUrl))
      : and(eq(schema.memories.subjectKind, "repo"), eq(schema.memories.subjectUrl, s.url))
  );
  return arms.length === 0 ? sql`false` : or(...arms);
}

function audienceFilter(audiences: Audience[]): SQL | undefined {
  const arms = audiences.map((a) =>
    a.kind === "all" ? eq(schema.memories.audienceKind, "all") : and(
      eq(schema.memories.audienceKind, "agent"),
      eq(schema.memories.audienceAgentId, a.agentId),
    )
  );
  return arms.length === 0 ? sql`false` : or(...arms);
}

export function drizzleMemoryStore(handle: MemoryDbHandle): MemoryStore {
  const { db } = handle;
  const m = schema.memories;

  return {
    async insertMemory(memory) {
      await db.insert(m).values(toMemoryRow(memory));
    },
    async getMemory(id) {
      const row = await db.query.memories.findFirst({ where: eq(m.id, id) });
      return row === undefined ? null : fromMemoryRow(row);
    },
    async getMemories(ids) {
      if (ids.length === 0) return [];
      const rows = await db.query.memories.findMany({ where: inArray(m.id, ids) });
      return rows.map(fromMemoryRow);
    },
    async saveMemory(memory) {
      const row = toMemoryRow(memory);
      const { id: _id, ...rest } = row;
      await db.insert(m).values(row).onConflictDoUpdate({ target: m.id, set: rest });
    },
    async patchMemory(id, set, adjust = {}) {
      const { subject, audience, text, ...rest } = set;
      const values: Record<string, unknown> = { ...rest };
      if (text !== undefined) {
        values.text = text;
        values.normalizedText = normalizeClaim(text);
      }
      if (subject !== undefined) Object.assign(values, subjectColumns(subject));
      if (audience !== undefined) Object.assign(values, audienceColumns(audience));
      const counters: Record<MemoryCounter, PgColumn> = {
        confirmations: m.confirmations,
        refutations: m.refutations,
        briefedCount: m.briefedCount,
        briefedSuccesses: m.briefedSuccesses,
      };
      for (const [name, delta] of Object.entries(adjust)) {
        if (delta === undefined || delta === 0) continue;
        const column = counters[name as MemoryCounter];
        values[name] = sql`${column} + ${delta}`;
      }
      if (Object.keys(values).length === 0) return this.getMemory(id);
      const [row] = await db.update(m).set(values).where(eq(m.id, id)).returning();
      return row === undefined ? null : fromMemoryRow(row);
    },
    async listMemories(query) {
      const filters: (SQL | undefined)[] = [eq(m.tenantId, query.tenantId)];
      if (query.subjects !== undefined) filters.push(subjectFilter(query.subjects));
      if (query.audiences !== undefined) filters.push(audienceFilter(query.audiences));
      if (query.kinds !== undefined) filters.push(inArray(m.kind, query.kinds));
      if (query.statuses !== undefined) filters.push(inArray(m.status, query.statuses));
      if (query.trusts !== undefined) filters.push(inArray(m.trust, query.trusts));
      const terms = query.query === undefined ? null : searchTerms(query.query);
      const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT));
      const offset = Math.max(0, query.offset ?? 0);

      // Every ordering ends on the id: created_at is a timestamp two rows can share, and an
      // OFFSET walk over an unstable order skips and repeats rows.
      if (terms === null) {
        if (query.query !== undefined && query.matchOnly) return [];
        const rows = await db.query.memories.findMany({
          where: and(...filters),
          orderBy: [desc(m.createdAt), desc(m.id)],
          limit,
          offset,
        });
        return rows.map((row) => ({ memory: fromMemoryRow(row), relevance: 1 }));
      }

      const tsquery = sql`to_tsquery('english', ${terms})`;
      const vector = sql`to_tsvector('english', ${m.text})`;
      const rank = sql<number>`ts_rank(${vector}, ${tsquery})`;
      const qv = query.queryVector;
      // Text-only: the database ranks and pages.
      if (qv === undefined) {
        if (query.matchOnly) filters.push(sql`${vector} @@ ${tsquery}`);
        const rows = await db.select({ row: m, rank })
          .from(m)
          .where(and(...filters))
          .orderBy(desc(rank), desc(m.createdAt), desc(m.id))
          .limit(limit)
          .offset(offset);
        const best = rows.reduce((top, r) => Math.max(top, Number(r.rank)), 0);
        return rows.map((r) => ({
          memory: fromMemoryRow(r.row),
          relevance: best > 0 ? Number(r.rank) / best : 0,
        }));
      }
      // Hybrid: the vector side is computed here, over a candidate set the database bounds —
      // every text match first (the index serves those), then the newest of the rest, up to
      // MAX_HYBRID_CANDIDATES — reading only what ranking needs, never the row. The rows the
      // page wants are fetched by id after, in ranked order.
      const candidates = await db.select({
        id: m.id,
        createdAt: m.createdAt,
        embedding: m.embedding,
        embeddingModel: m.embeddingModel,
        rank,
      })
        .from(m)
        .where(and(...filters))
        .orderBy(desc(rank), desc(m.createdAt), desc(m.id))
        .limit(MAX_HYBRID_CANDIDATES);
      const best = candidates.reduce((top, r) => Math.max(top, Number(r.rank)), 0);
      const ranked = candidates
        .map((r) => {
          const text = best > 0 ? Number(r.rank) / best : 0;
          const sim = r.embedding !== null && r.embeddingModel === qv.model
            ? cosine(qv.vector, r.embedding)
            : null;
          return {
            id: r.id,
            createdAt: r.createdAt,
            textRank: Number(r.rank),
            sim,
            relevance: Math.max(text, sim === null ? 0 : relevanceOf(sim)),
          };
        })
        .filter((s) =>
          !query.matchOnly || s.textRank > 0 || (s.sim !== null && s.sim >= VECTOR_MATCH_FLOOR)
        )
        .sort((a, b) =>
          b.relevance - a.relevance || b.createdAt.localeCompare(a.createdAt) ||
          b.id.localeCompare(a.id)
        )
        .slice(offset, offset + limit);
      if (ranked.length === 0) return [];
      const rows = await db.query.memories.findMany({
        where: inArray(m.id, ranked.map((r) => r.id)),
      });
      const byId = new Map(rows.map((row) => [row.id, fromMemoryRow(row)]));
      return ranked.flatMap((r) => {
        const memory = byId.get(r.id);
        return memory === undefined ? [] : [{ memory, relevance: r.relevance }];
      });
    },
    async countMemories(tenantId) {
      const rows = await db.select({
        subjectKind: m.subjectKind,
        subjectUrl: m.subjectUrl,
        kind: m.kind,
        status: m.status,
        count: sql<number>`count(*)::int`,
      })
        .from(m)
        .where(eq(m.tenantId, tenantId))
        .groupBy(m.subjectKind, m.subjectUrl, m.kind, m.status);
      return rows.map((r): SubjectCount => ({
        subject: r.subjectKind === "org"
          ? { kind: "org" }
          : { kind: "repo", url: r.subjectUrl ?? "" },
        kind: r.kind,
        status: r.status,
        count: Number(r.count),
      }));
    },
    async saveEmbedding(id, model, vector, forText) {
      await db.update(m).set({ embedding: vector, embeddingModel: model })
        .where(and(eq(m.id, id), eq(m.text, forText)));
    },
    async listMemoriesWithoutEmbedding(tenantId, model, limit) {
      const rows = await db.query.memories.findMany({
        where: and(
          eq(m.tenantId, tenantId),
          inArray(m.status, ["canon", "needs-verification"]),
          or(isNull(m.embedding), sql`${m.embeddingModel} is distinct from ${model}`),
        ),
        orderBy: [asc(m.createdAt), asc(m.id)],
        limit: Math.min(MAX_LIMIT, Math.max(1, limit)),
      });
      return rows.map(fromMemoryRow);
    },
    async findByNormalizedText(tenantId, subject, normalized, audience = { kind: "all" }) {
      const row = await db.query.memories.findFirst({
        where: and(
          eq(m.tenantId, tenantId),
          subjectFilter([subject]),
          eq(m.normalizedText, normalized),
          audienceFilter([audience]),
          inArray(m.status, ["canon", "needs-verification"]),
        ),
        orderBy: [desc(m.createdAt), desc(m.id)],
      });
      return row === undefined ? null : fromMemoryRow(row);
    },

    async insertProposal(proposal) {
      await db.insert(schema.memoryProposals).values(toProposalRow(proposal));
    },
    async getProposal(id) {
      const row = await db.query.memoryProposals.findFirst({
        where: eq(schema.memoryProposals.id, id),
      });
      return row === undefined ? null : fromProposalRow(row);
    },
    async saveProposal(proposal) {
      const row = toProposalRow(proposal);
      const { id: _id, ...rest } = row;
      await db.insert(schema.memoryProposals).values(row)
        .onConflictDoUpdate({ target: schema.memoryProposals.id, set: rest });
    },
    async transitionProposal(id, from, next) {
      const p = schema.memoryProposals;
      const { id: _id, ...rest } = toProposalRow({ ...next, id });
      const rows = await db.update(p).set(rest)
        .where(and(eq(p.id, id), eq(p.status, from)))
        .returning({ id: p.id });
      return rows.length === 1;
    },
    async promote({ proposal, memory, supersedes }) {
      const p = schema.memoryProposals;
      return await db.transaction(async (tx) => {
        const { id: _id, ...rest } = toProposalRow(proposal);
        const claimed = await tx.update(p).set(rest)
          .where(and(eq(p.id, proposal.id), eq(p.status, "pending")))
          .returning({ id: p.id });
        if (claimed.length !== 1) return false;
        await tx.insert(m).values(toMemoryRow(memory));
        if (supersedes !== null) {
          await tx.update(m)
            .set({ supersededBy: memory.id, status: "retired", updatedAt: memory.createdAt })
            .where(and(eq(m.id, supersedes), isNull(m.supersededBy)));
        }
        return true;
      });
    },
    async listProposals(query: ProposalQuery) {
      const p = schema.memoryProposals;
      const rows = await db.query.memoryProposals.findMany({
        where: and(
          eq(p.tenantId, query.tenantId),
          query.statuses === undefined ? undefined : inArray(p.status, query.statuses),
          query.basis === undefined ? undefined : eq(p.basis, query.basis),
          query.sourceId === undefined
            ? undefined
            : sql`${p.origin} @> ${
              JSON.stringify({ kind: "source", sourceId: query.sourceId })
            }::jsonb`,
          query.runId === undefined
            ? undefined
            : sql`${p.origin} @> ${JSON.stringify({ kind: "run", runId: query.runId })}::jsonb`,
          query.proposedBy === undefined
            ? undefined
            : sql`${p.origin} @> ${
              JSON.stringify({ kind: "human", userId: query.proposedBy })
            }::jsonb`,
          query.proposedVia === undefined
            ? undefined
            : sql`${p.origin} @> ${
              JSON.stringify({ kind: "human", via: query.proposedVia })
            }::jsonb`,
        ),
        orderBy: [asc(p.createdAt), asc(p.id)],
        limit: Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT)),
        offset: Math.max(0, query.offset ?? 0),
      });
      return rows.map(fromProposalRow);
    },

    async appendFeedback(tenantId, feedback) {
      await db.insert(schema.memoryFeedback).values(toFeedbackRow(tenantId, feedback));
    },
    async listFeedbackForMemory(memoryId, limit = 100) {
      const f = schema.memoryFeedback;
      const rows = await db.query.memoryFeedback.findMany({
        where: eq(f.memoryId, memoryId),
        orderBy: desc(f.seq),
        limit: Math.min(MAX_LIMIT, Math.max(1, limit)),
      });
      return rows.map(fromFeedbackRow);
    },
    async listFeedbackForRun(runId) {
      const f = schema.memoryFeedback;
      const rows = await db.query.memoryFeedback.findMany({
        where: eq(f.runId, runId),
        orderBy: asc(f.seq),
        limit: MAX_LIMIT,
      });
      return rows.map(fromFeedbackRow);
    },

    async insertSource(source) {
      await db.insert(schema.memorySources).values(toSourceRow(source));
    },
    async saveSource(source) {
      const { id, ...rest } = toSourceRow(source);
      await db.update(schema.memorySources).set(rest).where(eq(schema.memorySources.id, id));
    },
    async getSource(id) {
      const row = await db.query.memorySources.findFirst({
        where: eq(schema.memorySources.id, id),
      });
      return row === undefined ? null : fromSourceRow(row);
    },
    async listSources(tenantId, limit = DEFAULT_LIMIT) {
      const rows = await db.query.memorySources.findMany({
        where: eq(schema.memorySources.tenantId, tenantId),
        orderBy: [desc(schema.memorySources.ingestedAt), desc(schema.memorySources.id)],
        limit: Math.min(MAX_LIMIT, Math.max(1, limit)),
      });
      return rows.map(fromSourceRow);
    },
    async findSourceByHash(tenantId, contentHash) {
      const row = await db.query.memorySources.findFirst({
        where: and(
          eq(schema.memorySources.tenantId, tenantId),
          eq(schema.memorySources.contentHash, contentHash),
        ),
      });
      return row === undefined ? null : fromSourceRow(row);
    },
    async findLatestSource(tenantId, key) {
      const s = schema.memorySources;
      const row = await db.query.memorySources.findFirst({
        where: and(
          eq(s.tenantId, tenantId),
          "locator" in key
            ? eq(s.locator, key.locator)
            : and(isNull(s.locator), eq(s.title, key.title)),
        ),
        orderBy: [desc(s.ingestedAt), desc(s.id)],
      });
      return row === undefined ? null : fromSourceRow(row);
    },
    async listMemoriesForSource(sourceId) {
      // Every one, a page at a time keyed on the id — a withdrawal past the page size must
      // still reach the last memory the source produced.
      const out: Memory[] = [];
      let after: string | null = null;
      for (;;) {
        const rows: MemoryRow[] = await db.select().from(m)
          .where(and(
            sql`${m.provenance} @> ${JSON.stringify({ kind: "source", sourceId })}::jsonb`,
            after === null ? undefined : gt(m.id, after),
          ))
          .orderBy(asc(m.id))
          .limit(MAX_LIMIT);
        out.push(...rows.map(fromMemoryRow));
        if (rows.length < MAX_LIMIT) return out;
        after = rows[rows.length - 1].id;
      }
    },
    async deleteSource(id) {
      const s = schema.memorySources;
      await db.transaction(async (tx) => {
        await tx.update(s).set({ supersedesSourceId: null }).where(eq(s.supersedesSourceId, id));
        await tx.delete(s).where(eq(s.id, id));
      });
    },

    async putRun(run) {
      const { runId: _runId, ...rest } = run;
      await db.insert(schema.memoryRuns).values(run)
        .onConflictDoUpdate({ target: schema.memoryRuns.runId, set: rest });
    },
    async getRun(runId) {
      const row = await db.query.memoryRuns.findFirst({
        where: eq(schema.memoryRuns.runId, runId),
      });
      return row === undefined ? null : (row as MemoryRun);
    },
    async getRuns(runIds) {
      if (runIds.length === 0) return [];
      const rows = await db.query.memoryRuns.findMany({
        where: inArray(schema.memoryRuns.runId, runIds),
      });
      return rows as MemoryRun[];
    },
    async claimRunOutcome(runId, outcome) {
      const r = schema.memoryRuns;
      const [row] = await db.update(r).set({ outcome })
        .where(and(eq(r.runId, runId), isNull(r.outcome)))
        .returning();
      return row === undefined ? null : (row as MemoryRun);
    },
    async listRunsForMemory(memoryId, limit = 50) {
      const r = schema.memoryRuns;
      const rows = await db.select().from(r)
        .where(sql`${r.briefed} @> ${JSON.stringify([memoryId])}::jsonb`)
        .orderBy(desc(r.createdAt), desc(r.runId))
        .limit(Math.min(MAX_LIMIT, Math.max(1, limit)));
      return rows as MemoryRun[];
    },

    async insertChange(change) {
      const c = schema.memoryChanges;
      // One statement. `getChange` → `insertChange` was a check-then-insert two callers could
      // both pass, and `seq` was computed in the service from a list read moments earlier — so
      // a concurrent duplicate violated the patch_id key (a 503 the route's documented
      // idempotency promised would not happen) and two patches could take one seq.
      //
      // The seq is taken from the rows already there, inside the insert; the unique
      // (run_id, seq) index makes that a guarantee rather than a hope. A repeat of the same
      // patch conflicts on its own id and changes nothing — its place in the run is fixed at
      // birth, and what arrives later moves through `saveChange`.
      await db.execute(sql`
        INSERT INTO ${c} ("patch_id","run_id","tenant_id","repo","generation","seq","head_sha",
          "forge_url","carries","fate","created_at","updated_at")
        SELECT ${change.patchId}, ${change.runId}, ${change.tenantId}, ${change.repo},
          ${change.generation},
          COALESCE((SELECT MAX(${c.seq}) + 1 FROM ${c} WHERE ${c.runId} = ${change.runId}), 0),
          ${change.headSha}, ${change.forgeUrl}, ${JSON.stringify(change.carries)}::jsonb,
          ${change.fate},
          ${change.createdAt}, ${change.updatedAt}
        ON CONFLICT ("patch_id") DO NOTHING`);
      const stored = await db.query.memoryChanges.findFirst({
        where: eq(c.patchId, change.patchId),
      });
      if (stored === undefined) throw new Error(`change ${change.patchId} vanished after insert`);
      return stored;
    },
    async getChange(patchId) {
      const row = await db.query.memoryChanges.findFirst({
        where: eq(schema.memoryChanges.patchId, patchId),
      });
      return row ?? null;
    },
    async saveChange(change) {
      // What it carries moves through `addCarries` alone, as a union.
      const { patchId, carries: _carries, ...rest } = change;
      await db.update(schema.memoryChanges).set(rest)
        .where(eq(schema.memoryChanges.patchId, patchId));
    },
    async addCarries(patchId, carries) {
      if (carries.length === 0) return;
      const c = schema.memoryChanges;
      await db.execute(sql`
        UPDATE ${c} SET "carries" = (
          SELECT COALESCE(jsonb_agg(DISTINCT id ORDER BY id), '[]'::jsonb)
          FROM jsonb_array_elements_text(${c.carries} || ${JSON.stringify(carries)}::jsonb) AS id
        )
        WHERE ${c.patchId} = ${patchId}`);
    },
    async listChangesForRun(runId) {
      const c = schema.memoryChanges;
      return await db.query.memoryChanges.findMany({
        where: eq(c.runId, runId),
        orderBy: [asc(c.seq), asc(c.patchId)],
      });
    },
    async settleChange(patchId, fate, at) {
      const c = schema.memoryChanges;
      // One conditional write: the row must still be pending (or dropped, for the one revision
      // to landed), so a second report — or a racing one — writes nothing and answers null.
      const [row] = await db.update(c).set({ fate, updatedAt: at })
        .where(and(
          eq(c.patchId, patchId),
          fate === "landed" ? inArray(c.fate, ["pending", "dropped"]) : eq(c.fate, "pending"),
        ))
        .returning();
      return row ?? null;
    },
    async bindProposals(runId, patchId, repo, defaultsToThisRepo) {
      const p = schema.memoryProposals;
      // One statement: a claim binds to the first patch after it, and two patches opened at
      // once cannot both take it — the WHERE is the claim. Narrowed to THIS patch's repo, so a
      // claim about another one waits for its own patch rather than inheriting this patch's
      // verdict and head. A claim about the org names no repo and binds to any of them.
      const aboutThisRepo = [
        eq(p.subjectKind, "org"),
        and(eq(p.subjectKind, "repo"), eq(p.subjectUrl, repo)),
        ...(defaultsToThisRepo ? [isNull(p.subjectKind)] : []),
      ];
      const rows = await db.update(p).set({ changeId: patchId })
        .where(and(
          isNull(p.changeId),
          eq(p.status, "pending"),
          eq(p.basis, "introduced"),
          sql`${p.origin} @> ${JSON.stringify({ kind: "run", runId })}::jsonb`,
          or(...aboutThisRepo),
        ))
        .returning();
      return rows.map(fromProposalRow)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    },
    close: handle.close,
  };
}

export type { ScoredMemory };

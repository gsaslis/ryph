// An in-process `MemoryStore` — a TEST FIXTURE, never a deployment option: the service tests want
// a store that answers instantly and can be inspected, and the drizzle tests cover the SQL.
//
// Search here is a term-overlap count normalised to the best hit: the same contract the drizzle
// store keeps (best match 1, no shared term 0), not the same numbers.

import { normalizeClaim } from "../src/core/screen.ts";
import { cosine, relevanceOf, VECTOR_MATCH_FLOOR } from "../src/core/vector.ts";
import { sameAudience, sameSubject } from "../src/core/subject.ts";
import type {
  Feedback,
  Memory,
  MemoryChange,
  MemoryRun,
  Proposal,
  Source,
} from "../src/core/types.ts";
import {
  DEFAULT_LIMIT,
  MAX_HYBRID_CANDIDATES,
  MAX_LIMIT,
  type MemoryStore,
  type ScoredMemory,
} from "../src/ports/store.ts";

export interface InMemoryStore extends MemoryStore {
  readonly memories: Map<string, Memory>;
  readonly proposals: Map<string, Proposal>;
  readonly feedback: Feedback[];
  readonly runs: Map<string, MemoryRun>;
  readonly changes: Map<string, MemoryChange>;
  readonly sources: Map<string, Source>;
}

const terms = (text: string): Set<string> =>
  new Set(text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);

export function memoryStore(): InMemoryStore {
  const memories = new Map<string, Memory>();
  const proposals = new Map<string, Proposal>();
  const feedback: Feedback[] = [];
  const runs = new Map<string, MemoryRun>();
  const changes = new Map<string, MemoryChange>();
  const sources = new Map<string, Source>();
  return {
    memories,
    proposals,
    feedback,
    runs,
    changes,
    sources,
    insertSource(s) {
      sources.set(s.id, structuredClone(s));
      return Promise.resolve();
    },
    saveSource(s) {
      if (sources.has(s.id)) sources.set(s.id, structuredClone(s));
      return Promise.resolve();
    },
    getSource(id) {
      const s = sources.get(id);
      return Promise.resolve(s === undefined ? null : structuredClone(s));
    },
    listSources(tenantId, limit = 100) {
      return Promise.resolve(
        [...sources.values()].filter((s) => s.tenantId === tenantId)
          .sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt) || b.id.localeCompare(a.id))
          .slice(0, limit).map((s) => structuredClone(s)),
      );
    },
    findSourceByHash(tenantId, contentHash) {
      const s = [...sources.values()].find((x) =>
        x.tenantId === tenantId && x.contentHash === contentHash
      );
      return Promise.resolve(s === undefined ? null : structuredClone(s));
    },
    findLatestSource(tenantId, key) {
      const s = [...sources.values()]
        .filter((x) =>
          x.tenantId === tenantId &&
          ("locator" in key
            ? x.locator === key.locator
            : x.locator === null && x.title === key.title)
        )
        .sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt) || b.id.localeCompare(a.id))[0];
      return Promise.resolve(s === undefined ? null : structuredClone(s));
    },
    listMemoriesForSource(sourceId) {
      return Promise.resolve(
        [...memories.values()]
          .filter((m) => m.provenance.kind === "source" && m.provenance.sourceId === sourceId)
          .map((m) => structuredClone(m)),
      );
    },
    deleteSource(id) {
      for (const s of sources.values()) {
        if (s.supersedesSourceId === id) s.supersedesSourceId = null;
      }
      sources.delete(id);
      return Promise.resolve();
    },
    insertMemory(m) {
      if (memories.has(m.id)) return Promise.reject(new Error("duplicate id"));
      memories.set(m.id, structuredClone(m));
      return Promise.resolve();
    },
    getMemory(id) {
      const m = memories.get(id);
      return Promise.resolve(m === undefined ? null : structuredClone(m));
    },
    getMemories(ids) {
      return Promise.resolve(ids.flatMap((id) => {
        const m = memories.get(id);
        return m === undefined ? [] : [structuredClone(m)];
      }));
    },
    saveMemory(m) {
      memories.set(m.id, structuredClone(m));
      return Promise.resolve();
    },
    patchMemory(id, set, adjust = {}) {
      const m = memories.get(id);
      if (m === undefined) return Promise.resolve(null);
      const next = { ...m, ...structuredClone(set) };
      for (const [name, delta] of Object.entries(adjust)) {
        const counter = name as keyof typeof adjust;
        next[counter] = m[counter] + (delta ?? 0);
      }
      memories.set(id, next);
      return Promise.resolve(structuredClone(next));
    },
    listMemories(query) {
      let rows = [...memories.values()].filter((m) => m.tenantId === query.tenantId);
      if (query.subjects) {
        rows = rows.filter((m) => query.subjects!.some((s) => sameSubject(s, m.subject)));
      }
      if (query.audiences) {
        rows = rows.filter((m) => query.audiences!.some((a) => sameAudience(a, m.audience)));
      }
      if (query.kinds) rows = rows.filter((m) => query.kinds!.includes(m.kind));
      if (query.statuses) rows = rows.filter((m) => query.statuses!.includes(m.status));
      if (query.trusts) rows = rows.filter((m) => query.trusts!.includes(m.trust));
      let scored: ScoredMemory[];
      const newest = (a: Memory, b: Memory) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
      if (query.query === undefined) {
        scored = rows.sort(newest).map((memory) => ({ memory, relevance: 1 }));
      } else {
        const wanted = terms(query.query);
        // The same bound as the drizzle store: with a vector, text matches first, then the
        // newest of the rest, up to MAX_HYBRID_CANDIDATES.
        if (query.queryVector !== undefined) {
          const overlapOf = (m: Memory) => {
            let n = 0;
            for (const t of terms(m.text)) if (wanted.has(t)) n += 1;
            return n;
          };
          rows = rows.sort((a, b) => overlapOf(b) - overlapOf(a) || newest(a, b))
            .slice(0, MAX_HYBRID_CANDIDATES);
        }
        const hits = rows.map((memory) => {
          let overlap = 0;
          for (const t of terms(memory.text)) if (wanted.has(t)) overlap += 1;
          const qv = query.queryVector;
          const sim = qv !== undefined && memory.embedding !== null &&
              memory.embeddingModel === qv.model
            ? cosine(qv.vector, memory.embedding)
            : null;
          return { memory, overlap, sim };
        });
        const best = hits.reduce((top, h) => Math.max(top, h.overlap), 0);
        // The same contract as the drizzle store: the better of text and vector relevance.
        const relevance = (h: { overlap: number; sim: number | null }) =>
          Math.max(best > 0 ? h.overlap / best : 0, h.sim === null ? 0 : relevanceOf(h.sim));
        scored = hits
          .filter((h) =>
            !query.matchOnly || h.overlap > 0 || (h.sim !== null && h.sim >= VECTOR_MATCH_FLOOR)
          )
          .sort((a, b) => relevance(b) - relevance(a) || newest(a.memory, b.memory))
          .map((h) => ({ memory: h.memory, relevance: relevance(h) }));
      }
      const offset = query.offset ?? 0;
      const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT));
      return Promise.resolve(
        scored.slice(offset, offset + limit).map((s) => ({
          memory: structuredClone(s.memory),
          relevance: s.relevance,
        })),
      );
    },
    countMemories(tenantId) {
      const counts = new Map<
        string,
        {
          subject: Memory["subject"];
          kind: Memory["kind"];
          status: Memory["status"];
          count: number;
        }
      >();
      for (const m of memories.values()) {
        if (m.tenantId !== tenantId) continue;
        const key = `${JSON.stringify(m.subject)}|${m.kind}|${m.status}`;
        const entry = counts.get(key) ??
          { subject: m.subject, kind: m.kind, status: m.status, count: 0 };
        entry.count += 1;
        counts.set(key, entry);
      }
      return Promise.resolve([...counts.values()]);
    },
    saveEmbedding(id, model, vector, forText) {
      const m = memories.get(id);
      if (m !== undefined && m.text === forText) {
        m.embedding = [...vector];
        m.embeddingModel = model;
      }
      return Promise.resolve();
    },
    listMemoriesWithoutEmbedding(tenantId, model, limit) {
      return Promise.resolve(
        [...memories.values()]
          .filter((m) =>
            m.tenantId === tenantId && m.status !== "retired" &&
            (m.embedding === null || m.embeddingModel !== model)
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .slice(0, limit)
          .map((m) => structuredClone(m)),
      );
    },
    findByNormalizedText(tenantId, subject, normalized, audience = { kind: "all" }) {
      // The newest, as the drizzle store answers it.
      const found =
        [...memories.values()].filter((m) =>
          m.tenantId === tenantId && sameSubject(m.subject, subject) &&
          sameAudience(m.audience, audience) &&
          m.status !== "retired" && normalizeClaim(m.text) === normalized
        ).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
      return Promise.resolve(found === undefined ? null : structuredClone(found));
    },
    insertProposal(p) {
      proposals.set(p.id, structuredClone(p));
      return Promise.resolve();
    },
    getProposal(id) {
      const p = proposals.get(id);
      return Promise.resolve(p === undefined ? null : structuredClone(p));
    },
    saveProposal(p) {
      proposals.set(p.id, structuredClone(p));
      return Promise.resolve();
    },
    transitionProposal(id, from, next) {
      const current = proposals.get(id);
      if (current === undefined || current.status !== from) return Promise.resolve(false);
      proposals.set(id, structuredClone({ ...next, id }));
      return Promise.resolve(true);
    },
    promote({ proposal, memory, supersedes }) {
      const current = proposals.get(proposal.id);
      if (current === undefined || current.status !== "pending") return Promise.resolve(false);
      proposals.set(proposal.id, structuredClone(proposal));
      memories.set(memory.id, structuredClone(memory));
      const old = supersedes === null ? undefined : memories.get(supersedes);
      if (old !== undefined && old.supersededBy === null) {
        old.supersededBy = memory.id;
        old.status = "retired";
        old.updatedAt = memory.createdAt;
      }
      return Promise.resolve(true);
    },
    listProposals(query) {
      const rows = [...proposals.values()]
        .filter((p) => p.tenantId === query.tenantId)
        .filter((p) => query.statuses === undefined || query.statuses.includes(p.status))
        .filter((p) => query.basis === undefined || p.basis === query.basis)
        .filter((p) =>
          query.sourceId === undefined ||
          (p.origin.kind === "source" && p.origin.sourceId === query.sourceId)
        )
        .filter((p) =>
          query.runId === undefined || (p.origin.kind === "run" && p.origin.runId === query.runId)
        )
        .filter((p) =>
          query.proposedBy === undefined ||
          (p.origin.kind === "human" && p.origin.userId === query.proposedBy)
        )
        .filter((p) =>
          query.proposedVia === undefined ||
          (p.origin.kind === "human" && p.origin.via === query.proposedVia)
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const offset = query.offset ?? 0;
      const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT));
      return Promise.resolve(
        rows.slice(offset, offset + limit).map((p) => structuredClone(p)),
      );
    },
    appendFeedback(_tenantId, f) {
      feedback.push(structuredClone(f));
      return Promise.resolve();
    },
    listFeedbackForMemory(memoryId, limit = 100) {
      return Promise.resolve(
        feedback.filter((f) => "memoryId" in f && f.memoryId === memoryId).reverse().slice(
          0,
          limit,
        ),
      );
    },
    listFeedbackForRun(runId) {
      return Promise.resolve(feedback.filter((f) => "runId" in f && f.runId === runId));
    },
    putRun(run) {
      runs.set(run.runId, structuredClone(run));
      return Promise.resolve();
    },
    getRun(runId) {
      const r = runs.get(runId);
      return Promise.resolve(r === undefined ? null : structuredClone(r));
    },
    getRuns(runIds) {
      return Promise.resolve(runIds.flatMap((id) => {
        const r = runs.get(id);
        return r === undefined ? [] : [structuredClone(r)];
      }));
    },
    claimRunOutcome(runId, outcome) {
      const r = runs.get(runId);
      if (r === undefined || r.outcome !== null) return Promise.resolve(null);
      r.outcome = outcome;
      return Promise.resolve(structuredClone(r));
    },
    listRunsForMemory(memoryId, limit = 50) {
      return Promise.resolve(
        [...runs.values()].filter((r) => r.briefed.includes(memoryId))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId))
          .slice(0, limit),
      );
    },
    insertChange(change) {
      // As the drizzle store: keyed by patch id, and the seq is taken here rather than handed
      // in, so two reports cannot share one.
      const existing = changes.get(change.patchId);
      if (existing !== undefined) return Promise.resolve(structuredClone(existing));
      const seq = [...changes.values()]
        .filter((c) => c.runId === change.runId)
        .reduce((n, c) => Math.max(n, c.seq + 1), 0);
      const stored = { ...structuredClone(change), seq };
      changes.set(change.patchId, stored);
      return Promise.resolve(structuredClone(stored));
    },
    getChange(patchId) {
      const c = changes.get(patchId);
      return Promise.resolve(c === undefined ? null : structuredClone(c));
    },
    saveChange(change) {
      const stored = changes.get(change.patchId);
      if (stored !== undefined) {
        changes.set(change.patchId, { ...structuredClone(change), carries: stored.carries });
      }
      return Promise.resolve();
    },
    addCarries(patchId, carries) {
      const c = changes.get(patchId);
      if (c !== undefined) c.carries = [...new Set([...c.carries, ...carries])].sort();
      return Promise.resolve();
    },
    listChangesForRun(runId) {
      return Promise.resolve(
        [...changes.values()].filter((c) => c.runId === runId)
          .sort((a, b) => a.seq - b.seq || a.patchId.localeCompare(b.patchId))
          .map((c) => structuredClone(c)),
      );
    },
    settleChange(patchId, fate, at) {
      const c = changes.get(patchId);
      if (
        c === undefined || !(c.fate === "pending" || (c.fate === "dropped" && fate === "landed"))
      ) {
        return Promise.resolve(null);
      }
      c.fate = fate;
      c.updatedAt = at;
      return Promise.resolve(structuredClone(c));
    },
    bindProposals(runId, patchId, repo, defaultsToThisRepo) {
      // As the drizzle store: a claim naming a repo binds only to a patch for that repo, one
      // about the org binds to any, and one naming nothing follows the run's default.
      const aboutThisRepo = (subject: Proposal["subject"]) =>
        subject === null ? defaultsToThisRepo : subject.kind === "org" || subject.url === repo;
      const bound = [...proposals.values()]
        .filter((p) =>
          p.changeId === null && p.status === "pending" && p.basis === "introduced" &&
          p.origin.kind === "run" && p.origin.runId === runId && aboutThisRepo(p.subject)
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      for (const p of bound) p.changeId = patchId;
      return Promise.resolve(bound.map((p) => structuredClone(p)));
    },
    close: () => Promise.resolve(),
  };
}

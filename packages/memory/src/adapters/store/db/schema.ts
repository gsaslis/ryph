// The drizzle schema for the memory service's tables. Same conventions as the historian's:
// drizzle-kit applies it (push locally/tests, migrations at deploy time), ISO-8601 text
// timestamps, columns mirror the core types field-for-field where a table maps to one.
//
// Two exceptions to "mirror the core type", both for the same reason — a UI filters on them:
// subject and audience are tagged values on the core type and two flat columns each here
// (`subject_kind` + `subject_url`, `audience_kind` + `audience_agent_id`); the store maps between
// the shapes. Provenance, evidence and a proposal's origin are carried, never queried into, so
// they stay jsonb.
//
// Where these rows live is deployment-dependent, exactly as the historian's are: the shared
// instance under the single process, a database of their own (`ryph_memory`) when the service
// runs standalone. So there is no FK to any other owner's table — `run_id` and `agent_id` are
// the control plane's ids, carried as text.
//
// Search is full-text over `text`, as an expression index rather than a stored tsvector column:
// the canon is small by construction, and an expression index needs no generated column for
// drizzle-kit to push. Beside it, a nullable embedding (jsonb, not a vector extension's type:
// the canon is small enough to compare in-process, and no deployment has to provide pgvector)
// with the name of the model that made it — vectors from different models never compare.

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  Basis,
  ChangeFate,
  Evidence,
  Feedback,
  MemoryKind,
  MemoryStatus,
  Proposal,
  ProposalEvidence,
  ProposalFlag,
  ProposalOrigin,
  ProposalStatus,
  Provenance,
  RunOutcome,
  Source,
  Trust,
} from "../../../core/types.ts";

export const memories = pgTable("memories", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  text: text("text").notNull(),
  // The dedupe key: the claim lowercased with punctuation folded (core/screen.ts).
  normalizedText: text("normalized_text").notNull(),
  kind: text("kind").$type<MemoryKind>().notNull(),
  subjectKind: text("subject_kind").$type<"org" | "repo">().notNull(),
  subjectUrl: text("subject_url"),
  audienceKind: text("audience_kind").$type<"all" | "agent">().notNull(),
  audienceAgentId: text("audience_agent_id"),
  status: text("status").$type<MemoryStatus>().notNull(),
  trust: text("trust").$type<Trust>().notNull(),
  provenance: jsonb("provenance").$type<Provenance>().notNull(),
  evidence: jsonb("evidence").$type<Evidence>(),
  supersedes: text("supersedes"),
  supersededBy: text("superseded_by"),
  confirmations: integer("confirmations").notNull().default(0),
  refutations: integer("refutations").notNull().default(0),
  briefedCount: integer("briefed_count").notNull().default(0),
  briefedSuccesses: integer("briefed_successes").notNull().default(0),
  lastBriefedAt: text("last_briefed_at"),
  lastConfirmedAt: text("last_confirmed_at"),
  lastRefutedAt: text("last_refuted_at"),
  embedding: jsonb("embedding").$type<number[]>(),
  embeddingModel: text("embedding_model"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  // The brief's read: everything live on a subject, for an audience.
  index("memories_by_subject").on(t.tenantId, t.subjectKind, t.subjectUrl, t.status),
  index("memories_by_audience").on(t.tenantId, t.audienceKind, t.audienceAgentId),
  index("memories_by_normalized").on(t.tenantId, t.subjectKind, t.subjectUrl, t.normalizedText),
  index("memories_fts").using("gin", sql`to_tsvector('english', ${t.text})`),
  // A source's memories: `provenance @> {"kind":"source","sourceId":…}`.
  index("memories_by_provenance").using("gin", sql`${t.provenance} jsonb_path_ops`),
]);

export const memoryProposals = pgTable("memory_proposals", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  text: text("text").notNull(),
  kind: text("kind").$type<MemoryKind>(),
  subjectKind: text("subject_kind").$type<"org" | "repo">(),
  subjectUrl: text("subject_url"),
  audienceKind: text("audience_kind").$type<"all" | "agent">(),
  audienceAgentId: text("audience_agent_id"),
  evidence: jsonb("evidence").$type<ProposalEvidence>(),
  origin: jsonb("origin").$type<ProposalOrigin>().notNull(),
  supersedes: text("supersedes"),
  basis: text("basis").$type<Basis>().notNull(),
  // The patch a run's `introduced` claim is bound to (a memory_changes row); null until the run
  // opens one after the claim, and for every claim that waits on nothing.
  changeId: text("change_id"),
  status: text("status").$type<ProposalStatus>().notNull(),
  resolution: jsonb("resolution").$type<Proposal["resolution"]>(),
  flags: jsonb("flags").$type<ProposalFlag[]>().notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("memory_proposals_by_status").on(t.tenantId, t.status, t.createdAt),
  // A source's batch and a run's claims: `origin @> {…}`.
  index("memory_proposals_by_origin").using("gin", sql`${t.origin} jsonb_path_ops`),
]);

export const memorySources = pgTable("memory_sources", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  kind: text("kind").$type<Source["kind"]>().notNull(),
  status: text("status").$type<Source["status"]>().notNull(),
  extraction: jsonb("extraction").$type<Source["extraction"]>(),
  failure: text("failure"),
  title: text("title").notNull(),
  locator: text("locator"),
  contentHash: text("content_hash").notNull(),
  text: text("text").notNull(),
  defaultSubjectKind: text("default_subject_kind").$type<"org" | "repo">().notNull(),
  defaultSubjectUrl: text("default_subject_url"),
  ingestedBy: text("ingested_by").notNull(),
  ingestedAt: text("ingested_at").notNull(),
  supersedesSourceId: text("supersedes_source_id"),
}, (t) => [
  uniqueIndex("memory_sources_by_hash").on(t.tenantId, t.contentHash),
]);

// The signal log: append-only, one row per signal. `seq` is the only order that matters —
// timestamps are the caller's clock and are display-only.
export const memoryFeedback = pgTable("memory_feedback", {
  seq: serial("seq").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  kind: text("kind").$type<Feedback["kind"]>().notNull(),
  memoryId: text("memory_id"),
  runId: text("run_id"),
  userId: text("user_id"),
  // The kind-specific fields — a refute's reason and replacement, an outcome's status, a
  // stale's paths, a human action — carried whole.
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull(),
  at: text("at").notNull(),
}, (t) => [
  index("memory_feedback_by_memory").on(t.memoryId, t.seq),
  index("memory_feedback_by_run").on(t.runId, t.seq),
]);

// `runId → {agentId, repos, briefed}`: how the data side turns the run id the gateway forwards
// into a scope without trusting the agent.
export const memoryRuns = pgTable("memory_runs", {
  runId: text("run_id").primaryKey(),
  taskId: text("task_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  agentId: text("agent_id").notNull(),
  agentOnly: boolean("agent_only").notNull().default(false),
  repos: jsonb("repos").$type<string[]>().notNull(),
  briefed: jsonb("briefed").$type<string[]>().notNull(),
  outcome: text("outcome").$type<RunOutcome>(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  // The runs a memory was briefed into: `briefed @> ["mem-…"]`.
  index("memory_runs_by_briefed").using("gin", sql`${t.briefed} jsonb_path_ops`),
]);

// One patch a run opened — the change its `introduced` claims bind to and wait on. Keyed by the
// orchestrator's patch id, because that is what the orchestrator reports a fate for; `run_id`
// reads a run's patches back, and `carries` (the run's earlier patch ids whose work this one
// holds in full) is the edge a claim follows from the patch it is bound to.
export const memoryChanges = pgTable("memory_changes", {
  patchId: text("patch_id").primaryKey(),
  runId: text("run_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  repo: text("repo").notNull(),
  generation: integer("generation").notNull(),
  seq: integer("seq").notNull(),
  headSha: text("head_sha"),
  forgeUrl: text("forge_url"),
  carries: jsonb("carries").$type<string[]>().notNull().default([]),
  fate: text("fate").$type<ChangeFate>().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  // UNIQUE: a run's patches are numbered, and two reports must not be able to take one number.
  // The seq is taken inside the insert (adapters/store/drizzle.ts), and this is what makes that
  // atomic rather than merely usually-right.
  uniqueIndex("memory_changes_by_run").on(t.runId, t.seq),
]);

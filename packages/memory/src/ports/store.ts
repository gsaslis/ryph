// Persistence, as the core sees it — a row-holder, same doctrine as the historian's HistoryStore:
// every decision (scoring, scope, promotion) happens in the service and lands here fully formed.
// The one thing the store decides is the search score, because full-text ranking is the
// database's to compute.

import type {
  Audience,
  Basis,
  ChangeFate,
  Feedback,
  Memory,
  MemoryChange,
  MemoryKind,
  MemoryRun,
  MemoryStatus,
  Proposal,
  ProposalStatus,
  RunOutcome,
  Source,
  Subject,
  Trust,
} from "../core/types.ts";

export interface MemoryQuery {
  tenantId: string;
  /** Any of these subjects. Absent: every subject. */
  subjects?: Subject[];
  /** Any of these audiences. Absent: every audience. */
  audiences?: Audience[];
  kinds?: MemoryKind[];
  statuses?: MemoryStatus[];
  trusts?: Trust[];
  /**
   * Free text. Set, each memory comes back with a relevance in [0, 1] — the best match is 1, a
   * memory sharing no term with the query is 0. Absent, every memory has relevance 1.
   */
  query?: string;
  /** With a query: return only memories that match it at all. Default false — the brief wants
   * every memory on its subjects, ranked; search wants only the ones that answer. */
  matchOnly?: boolean;
  /**
   * The query embedded, by the model named: with it, relevance is hybrid — the better of the
   * full-text rank and the cosine similarity against each memory's stored vector, each
   * normalised — and a memory with no vector (or one from another model) ranks by text alone.
   *
   * The vector side is compared in-process, so a hybrid query ranks a BOUNDED candidate set:
   * every memory the text side matches, then the newest others up to MAX_HYBRID_CANDIDATES.
   * A memory that shares no term with the query and is older than that cut ranks nowhere; a
   * caller that needs every row on a subject (the brief's pinned memories) asks without a query.
   */
  queryVector?: { model: string; vector: number[] };
  /** At most MAX_LIMIT; the default is DEFAULT_LIMIT. */
  limit?: number;
  offset?: number;
}

/** The default page of any list. */
export const DEFAULT_LIMIT = 100;
/** The most any one list answers. A caller that wants more pages. */
export const MAX_LIMIT = 500;
/** How many memories a hybrid query compares vectors for (see MemoryQuery.queryVector). */
export const MAX_HYBRID_CANDIDATES = 1000;

/** The counters a memory carries, adjusted in place rather than written from a copy. */
export type MemoryCounter = "confirmations" | "refutations" | "briefedCount" | "briefedSuccesses";

export interface ScoredMemory {
  memory: Memory;
  relevance: number;
}

export interface SubjectCount {
  subject: Subject;
  kind: MemoryKind;
  status: MemoryStatus;
  count: number;
}

export interface ProposalQuery {
  tenantId: string;
  statuses?: ProposalStatus[];
  /** Only proposals extracted from this source — a review batch. */
  sourceId?: string;
  /** Only proposals a run made. */
  runId?: string;
  /** Only proposals this person made by hand. */
  proposedBy?: string;
  /** Only proposals a person made by hand this way (`origin.via`): "token" for an API token. */
  proposedVia?: "token";
  basis?: Basis;
  limit?: number;
  offset?: number;
}

/** What promoting a proposal writes, as one atomic step: the proposal claimed off `pending`
 * into its resolution, the memory it became, and the memory it supersedes retired and linked
 * (only if nothing superseded that one first). */
export interface Promotion {
  proposal: Proposal;
  memory: Memory;
  supersedes: string | null;
}

export interface MemoryStore {
  insertMemory(memory: Memory): Promise<void>;
  getMemory(id: string): Promise<Memory | null>;
  getMemories(ids: string[]): Promise<Memory[]>;
  /** Full-row write keyed by id — a human's edit. Counters and status transitions go through
   * `patchMemory`, so two callers cannot overwrite each other's increments. */
  saveMemory(memory: Memory): Promise<void>;
  /**
   * Sets fields and adjusts counters in one statement, answering the row as it is after; null
   * for no such memory. This is the ONLY way a counter moves.
   */
  patchMemory(
    id: string,
    set: Partial<Omit<Memory, "id" | MemoryCounter>>,
    adjust?: Partial<Record<MemoryCounter, number>>,
  ): Promise<Memory | null>;
  /** Newest first when there is no query; best match first when there is. */
  listMemories(query: MemoryQuery): Promise<ScoredMemory[]>;
  /** The topic index: how many memories per subject, kind and status. */
  countMemories(tenantId: string): Promise<SubjectCount[]>;
  /** Stores a memory's vector and the model that made it — only while the memory's text is still
   * `forText`, the text the vector was computed from. An embedding that finishes after an edit
   * must not overwrite the edit's own vector with one for words the claim no longer says. */
  saveEmbedding(id: string, model: string, vector: number[], forText: string): Promise<void>;
  /** Live memories with no vector from this model, oldest first — the backfill's work list. */
  listMemoriesWithoutEmbedding(tenantId: string, model: string, limit: number): Promise<Memory[]>;
  /** A live (canon or needs-verification) memory on this subject whose normalised text matches. */
  findByNormalizedText(
    tenantId: string,
    subject: Subject,
    normalized: string,
    audience?: Audience,
  ): Promise<Memory | null>;

  insertProposal(proposal: Proposal): Promise<void>;
  getProposal(id: string): Promise<Proposal | null>;
  /** Full-row write keyed by id, for edits that leave the status alone (a move, a rewrite). A
   * status change goes through `transitionProposal` or `promote`. */
  saveProposal(proposal: Proposal): Promise<void>;
  /**
   * Writes `next` only if the row's status is still `from` — the compare-and-swap every
   * resolution goes through, so the consolidator and a person cannot both resolve one
   * proposal. False: someone else got there first, and nothing was written.
   */
  transitionProposal(id: string, from: ProposalStatus, next: Proposal): Promise<boolean>;
  /** The promotion, atomically (see Promotion). False: the proposal was no longer pending, and
   * nothing was written. */
  promote(promotion: Promotion): Promise<boolean>;
  /** Oldest first — the inbox is worked in arrival order. */
  listProposals(query: ProposalQuery): Promise<Proposal[]>;

  appendFeedback(tenantId: string, feedback: Feedback): Promise<void>;
  /** Newest first. */
  listFeedbackForMemory(memoryId: string, limit?: number): Promise<Feedback[]>;
  /** Everything a run said, oldest first. */
  listFeedbackForRun(runId: string): Promise<Feedback[]>;

  insertSource(source: Source): Promise<void>;
  /** Replaces the record: the extraction's outcome landing on it. */
  saveSource(source: Source): Promise<void>;
  getSource(id: string): Promise<Source | null>;
  /** Newest first. */
  listSources(tenantId: string, limit?: number): Promise<Source[]>;
  /** The source with this content hash, if the same document was ingested before. */
  findSourceByHash(tenantId: string, contentHash: string): Promise<Source | null>;
  /** The newest source with this locator (or, for pasted text, this title) — what a re-ingest
   * supersedes. */
  findLatestSource(
    tenantId: string,
    key: { locator: string } | { title: string },
  ): Promise<Source | null>;
  /** Every memory whose provenance is this source, retired ones included — all of them, not
   * a page: a withdrawal must reach the last one. */
  listMemoriesForSource(sourceId: string): Promise<Memory[]>;
  /** Removes the record and its text; a later source that superseded it no longer points at
   * it. Memories and proposals keep their provenance as history. */
  deleteSource(id: string): Promise<void>;

  putRun(run: MemoryRun): Promise<void>;
  getRun(runId: string): Promise<MemoryRun | null>;
  getRuns(runIds: string[]): Promise<MemoryRun[]>;
  /** Records how the run ended, once: the row as it is after, or null when it had an outcome
   * already (or there is no such run). */
  claimRunOutcome(runId: string, outcome: RunOutcome): Promise<MemoryRun | null>;
  /** Runs a memory was briefed into, newest first. */
  listRunsForMemory(memoryId: string, limit?: number): Promise<MemoryRun[]>;

  /**
   * A patch the run opened, IDEMPOTENTLY: the patch id is the key, and reporting one twice —
   * concurrently or on a redelivery — records it once and answers the row as stored. `seq` is
   * taken in the same statement that inserts, from the rows already there, so two reports
   * cannot compute the same number and share it; the unique (run_id, seq) index is the rule.
   */
  insertChange(change: Omit<MemoryChange, "seq">): Promise<MemoryChange>;
  getChange(patchId: string): Promise<MemoryChange | null>;
  /** Full-row write keyed by patchId — the pull request's URL landing on it. The fate goes
   * through `settleChange`, so two reports cannot both settle one patch, and what it carries
   * through `addCarries`, so two reports cannot lose an edge. */
  saveChange(change: MemoryChange): Promise<void>;
  /** Adds patch ids to what a patch carries, as a union in one statement: a report that brings
   * them again, or more, never loses one another report wrote. No such patch: nothing. */
  addCarries(patchId: string, carries: string[]): Promise<void>;
  /** Every patch a run opened, in birth order (`seq` ascending). */
  listChangesForRun(runId: string): Promise<MemoryChange[]>;
  /** Settles one patch's fate, once: the row as it is after, or null when it was settled
   * already or there is no such patch. One revision is allowed: `dropped → landed`, a patch
   * that stopped (closed, failed for good) and later merged after all — a merge is the last
   * word about work that really did land. `landed` is never revised. */
  settleChange(
    patchId: string,
    fate: Exclude<ChangeFate, "pending">,
    at: string,
  ): Promise<MemoryChange | null>;
  /**
   * Binds every pending `introduced` claim the run made that is not bound yet AND is about this
   * patch's repo, and answers them as they are after. One statement, so a claim cannot bind to
   * two patches that were opened at once.
   *
   * `repo` is the patch's canonical repo, and the binding is narrowed to it. Bound across
   * repos, a claim about repo A would inherit the verdict of a patch for repo B and carry B's
   * head on its evidence — so every later staleness diff would resolve A's paths against the
   * wrong tree. A claim about the ORG is about no repo in particular and binds to any of the
   * run's patches; `defaultsToThisRepo` says whether a claim that named no subject at all falls
   * back to this repo (the run has exactly one, and it is this one) rather than to the org.
   */
  bindProposals(
    runId: string,
    patchId: string,
    repo: string,
    defaultsToThisRepo: boolean,
  ): Promise<Proposal[]>;

  close(): Promise<void>;
}

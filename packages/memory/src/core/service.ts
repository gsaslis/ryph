// The memory service: every decision about the canon, the inbox and the signal log, in one
// place, over a store that only holds rows. Two faces on one object:
//
// - the CONTROL side, called by the orchestrator (`composeBrief`, `reportOutcome`) and by the
//   management surface (list, get, create, edit, pin, retire, the inbox, consolidate). It trusts
//   its caller — the composition root gated it.
// - the DATA side, called by the MCP tools a run holds (`search`, `getInScope`, `propose`,
//   `confirm`, `refute`). Every one of these takes a RunScope the service derived from the run
//   id the gateway forwarded, and arguments can only NARROW within it. Nothing an agent says
//   about its own agent id or repo is ever consulted.
//
// Invariants:
// - agents never write canon: `propose` lands in the inbox and nowhere else; `consolidate` and
//   a human's `acceptProposal` are the only paths to `status: "canon"`
// - a refutation with a replacement is a proposal that supersedes; promoting it retires the old
//   memory and links both ways, so "why did the agent believe this" keeps an answer
// - secret-shaped text is refused at the door, on every path that takes text
// - reportOutcome is idempotent per run; composeBrief records the run's scope even when it has
//   nothing to say, because the tools need the scope either way

import { type BriefCandidate, composeBrief as compose } from "./brief.ts";
import { extractClaims } from "./extract.ts";
import { judge, type Verdict } from "./judge.ts";
import { findSection, renderDoc, splitSections } from "./sections.ts";
import { isSweepable, type ScoreBreakdown, scoreMemory } from "./score.ts";
import { isSecretShaped, normalizeClaim, screen } from "./screen.ts";
import {
  audiencesOf,
  canonicalRepo,
  EVERYONE,
  inScope,
  ORG,
  repoSubjectsOf,
  resolveAudienceHint,
  resolveSubjectHint,
  type RunScope,
  sameAudience,
  sameSubject,
  subjectKey,
  subjectsOf,
} from "./subject.ts";
import type {
  Audience,
  Basis,
  Brief,
  ChangeFate,
  Evidence,
  Feedback,
  IngestStats,
  Memory,
  MemoryChange,
  MemoryKind,
  MemoryRun,
  MemoryStatus,
  Proposal,
  ProposalEvidence,
  ProposalOrigin,
  ProposalResolution,
  RunOutcome,
  Source,
  SourceKind,
  SourceSection,
  StaleReport,
  Subject,
  Trust,
} from "./types.ts";
import { DEFAULT_BRIEF_BUDGET_TOKENS, MAX_MEMORY_TEXT, TENANT_DEFAULT } from "./types.ts";
import type { Embedder } from "../ports/embedder.ts";
import { type Fetchers, FetchRefusedError } from "../ports/fetcher.ts";
import type { ModelClient } from "../ports/model.ts";
import {
  MAX_LIMIT,
  type MemoryCounter,
  type MemoryQuery,
  type MemoryStore,
  type ScoredMemory,
  type SubjectCount,
} from "../ports/store.ts";

export interface MemoryDiag {
  debug(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

export interface MemoryServiceDeps {
  store: MemoryStore;
  now(): Date;
  diag: MemoryDiag;
  /** Mints ids; the composition root supplies @ryph/sealed's. */
  mintId(prefix: string): string;
  /** One value today (TENANT_DEFAULT); see types.ts. */
  tenantId?: string;
  /**
   * The platform's model, for the consolidator's contradiction and tightening pass. Null: the
   * trivial consolidator — screen, exact dedupe, promote as proposed — and every pass says so.
   */
  model?: ModelClient | null;
  /** Where `url` and `repo-file` sources are fetched from. Absent: those kinds are refused. */
  fetchers?: Fetchers;
  /**
   * Embeddings for hybrid search: every new claim is embedded on the way in (best-effort) and
   * queries are embedded before ranking. Null, or one that gave up (`available()` false):
   * full-text alone.
   */
  embedder?: Embedder | null;
  /** Query embeddings allowed in flight before a search goes on without one, and how long a
   * search waits for its own; see MAX_QUERY_EMBEDS_IN_FLIGHT. */
  maxQueryEmbedsInFlight?: number;
  queryEmbedDeadlineMs?: number;
  /** How long a write waits for its claim's vector; defaults to WRITE_EMBED_WAIT_MS. */
  writeEmbedWaitMs?: number;
  /** How long drain() waits for embeddings still running; defaults to EMBED_DRAIN_WAIT_MS. */
  embedDrainWaitMs?: number;
  /** SHA-256 hex of a text, for a source's content hash. */
  hash(text: string): Promise<string>;
}

export interface ComposeBriefRequest {
  runId: string;
  /** The task the run belongs to: kept on the run, so a proposal can say where it came from. */
  taskId: string;
  agentId: string;
  /** The task's repos as the user named them, in checkout order; empty for no repo subject. */
  repos: string[];
  task: { title: string; instructions: string };
  budgetTokens?: number;
  /** Enforced for the brief and persisted as the tools' run scope. */
  agentOnly?: boolean;
}

export interface NewMemoryInput {
  text: string;
  kind: MemoryKind;
  subject: Subject;
  audience: Audience;
  evidence?: Evidence | null;
  pinned?: boolean;
}

export interface MemoryEdit {
  text?: string;
  kind?: MemoryKind;
  subject?: Subject;
  audience?: Audience;
}

export interface ProposeInput {
  text: string;
  kind?: MemoryKind;
  subject?: "org" | "repo";
  /** Which of the run's repos, when it holds several — see `resolveSubjectHint`. */
  repo?: string;
  audience?: "all" | "agent";
  evidence?: ProposalEvidence | null;
  basis: Basis;
}

/**
 * The change an `introduced` claim waits on, as the inbox shows it: the patch it is bound to
 * (null while the run has not opened one since the claim), its pull request when it has one,
 * and what it came to — `landed` once that patch or a patch carrying its work landed,
 * `dropped` once the run concluded and none of them did, `pending` in between.
 */
export interface ClaimChange {
  patchId: string | null;
  forgeUrl: string | null;
  fate: ChangeFate;
}

/** An inbox row with the change its claim waits on. Null for every claim that rests on nothing
 * a run changed. */
export type InboxProposal = Proposal & { change: ClaimChange | null };

/** A patch a run opened, as the orchestrator reports it — the repo spelled as the brief
 * request named it. */
export interface PatchReport {
  patchId: string;
  repo: string;
  generation: number;
  headSha: string | null;
  forgeUrl: string | null;
  /** The run's earlier patches whose work this one carries in full (`MemoryChange.carries`). */
  carries: string[];
}

export type ProposeOutcome =
  | { ok: true; proposal: Proposal }
  | { ok: false; reason: string; tooMany?: true };

/** How many pending proposals one person may have waiting in the inbox at once, made with an
 * API token. */
export const MAX_PENDING_PER_PROPOSER = 50;

export interface MemoryDetail {
  memory: Memory;
  feedback: Feedback[];
  supersedes: Memory | null;
  supersededBy: Memory | null;
  runs: MemoryRun[];
}

export interface ConsolidateStats {
  screened: number;
  promoted: number;
  merged: number;
  rejected: number;
  held: number;
  /** `introduced` claims left waiting for the run's change to land. */
  awaiting: number;
  /** Proposals the model judged (0 without a model). */
  judged: number;
  /** Judgements that failed and fell back to the trivial path. */
  modelFailures: number;
  /** Memories the decay sweep retired. */
  swept: number;
}

/** The brief a run WOULD get, with every candidate and whether it made the cut. */
export interface BriefPreview {
  brief: Brief | null;
  candidates: Array<
    { memory: Memory; relevance: number; score: ScoreBreakdown; included: boolean }
  >;
}

/** Enough to notice a subject that is rotting. */
export interface MemoryHealth {
  subjects: Array<{
    subject: Subject;
    canon: number;
    needsVerification: number;
    retired: number;
    /** Live memories no run has ever been briefed with. */
    neverBriefed: number;
    /** Live memories with at least one refutation on record. */
    contested: number;
  }>;
  inbox: {
    pending: number;
    flagged: number;
    contradicting: number;
    /** `introduced` claims waiting for the run's change to land. */
    awaiting: number;
    /** When the oldest pending proposal arrived; null for an empty inbox. */
    oldestAt: string | null;
  };
  /** Whether the consolidator has a model to judge with. */
  modelBacked: boolean;
  /** Hybrid search's state: the model, how many live memories carry its vector, how many are
   * waiting for the backfill. Null: full-text only. */
  embeddings: { model: string; embedded: number; pending: number } | null;
}

/** What POST /v1/memory/sources takes: a document by text, or by locator for the kinds a
 * fetcher serves. */
export interface IngestInput {
  kind: SourceKind;
  /** Required for paste and upload; a fetched document brings its own unless one is given. */
  title?: string;
  text?: string;
  locator?: string;
  subject: Subject;
}

/** A source and the review batch its ingest produced. */
/** What withdrawing a source did: the batch it still had waiting is rejected, what was
 * promoted from it is retired, and what a person pinned is kept and counted. */
export interface WithdrawOutcome {
  sourceId: string;
  rejected: number;
  retired: number;
  kept: number;
}

/** What an ingest answers at once: the source, admitted and `ingesting`, and a promise of the
 * extraction that is now running behind it — the route never waits on it, tests and in-process
 * callers may. It never rejects: a failure lands on the source as its status. */
export interface IngestStarted {
  source: Source;
  done: Promise<IngestOutcome>;
}

/** What moving a source to another subject did: its waiting batch and its live memories now
 * carry that subject, and so does the source for what it proposes next. */
export interface MoveOutcome {
  sourceId: string;
  subject: Subject;
  proposals: number;
  memories: number;
}

export interface IngestOutcome {
  /** The source as the extraction left it: `ready` with its stats, or `failed` with why. */
  source: Source;
  proposals: Proposal[];
  stats: IngestStats;
}

export interface SourceDetail {
  source: Source;
  sections: SourceSection[];
  /** The batch as the inbox lists it — each proposal says whether it waits on a change. */
  proposals: InboxProposal[];
  memories: Memory[];
}

export interface MemoryService {
  // ── control side ───────────────────────────────────────────────────────────────────────────
  composeBrief(req: ComposeBriefRequest): Promise<Brief | null>;
  /** The brief composeBrief would produce, recording nothing — the "why did the agent do
   * that" tool. */
  previewBrief(req: Omit<ComposeBriefRequest, "runId" | "taskId">): Promise<BriefPreview>;
  /** How the run ended. No more patches will open, so every `introduced` claim still unbound
   * binds to the run's last patch — or, when the run opened none, is rejected here and now. */
  reportOutcome(runId: string, status: RunOutcome): Promise<void>;
  /** A patch the run opened — an upsert on the patch id: the first report records it and
   * binds every `introduced` claim of the run not bound yet, a later one only brings its
   * pull request's URL (and head). A run this service never briefed is a no-op. */
  reportPatch(runId: string, patch: PatchReport): Promise<void>;
  /** What one of the run's patches came to, once the orchestrator knows: landed releases the
   * claims bound to it (and to the patches it carries) to the consolidator, dropped rejects them
   * once nothing that carries them can land. `carries` is the patch's own (as `reportPatch` said
   * it), again, joined to what is recorded: this report is the one the orchestrator retries until
   * it lands, so the edge a landing credits through is not lost with a birth report. Settles once
   * per patch; a patch already settled, or never reported, is a no-op. */
  reportChange(
    runId: string,
    patchId: string,
    fate: "landed" | "dropped",
    carries: string[],
  ): Promise<void>;
  /** The runner found briefed memories whose evidence paths changed since they were observed:
   * they move to a bounded, relevant-only verification section until reconfirmed. */
  reportStale(runId: string, stale: StaleReport[]): Promise<void>;
  health(): Promise<MemoryHealth>;
  list(query: Omit<MemoryQuery, "tenantId" | "queryVector">): Promise<ScoredMemory[]>;
  /** Embeds live memories that have no vector from the current model, a batch at a time.
   * `remaining` says whether another pass has work. No embedder: nothing to do. */
  backfillEmbeddings(limit?: number): Promise<{ embedded: number; remaining: number }>;
  get(id: string): Promise<MemoryDetail | null>;
  subjects(): Promise<SubjectCount[]>;
  /** A memory written by hand: canon at once, `trust: "human"` (or pinned). */
  create(input: NewMemoryInput, userId: string): Promise<Memory>;
  edit(id: string, patch: MemoryEdit, userId: string): Promise<Memory | null>;
  setPinned(id: string, pinned: boolean, userId: string): Promise<Memory | null>;
  retire(id: string, userId: string): Promise<Memory | null>;
  listProposals(
    statuses?: Proposal["status"][],
    limit?: number,
    sourceId?: string,
  ): Promise<InboxProposal[]>;
  /**
   * A human proposing: lands in the inbox like any other, flagged like any other. One made with
   * an API token (`via: "token"`) waits for a person to accept it; the pass never promotes it.
   * One made with a token is refused (`tooMany`) past MAX_PENDING_PER_PROPOSER pending
   * proposals the same person made with a token; one made in the app is never capped.
   */
  proposeAsHuman(
    input: NewMemoryInput,
    userId: string,
    opts?: { via?: "session" | "token" },
  ): Promise<ProposeOutcome>;
  /** A human promoting a proposal, flags and all — their call. */
  acceptProposal(id: string, userId: string, edit?: MemoryEdit): Promise<Memory | null>;
  rejectProposal(id: string, userId: string, reason: string): Promise<InboxProposal | null>;
  /**
   * Ingests a document: fetches it if it is a locator, refuses what memory must not hold,
   * stores it as a source, and answers — the extraction of claims into a review batch of
   * proposals (with a model; a pointer proposal alone without one) runs on from there, and a
   * re-ingest of the same locator or title supersedes the earlier source when it lands.
   * Throws MemoryRefusedError for a bad document.
   */
  ingest(input: IngestInput, userId: string): Promise<IngestStarted>;
  /** At boot: an extraction a restart cut short is marked failed, so nothing shows as
   * ingesting forever. Answers how many. */
  recoverIngests(): Promise<number>;
  listSources(limit?: number): Promise<Source[]>;
  getSource(id: string): Promise<SourceDetail | null>;
  /**
   * Withdraws a document ingested by mistake: its pending proposals are rejected, the memories
   * it produced are retired (pinned ones stay — a person vouched for those), and the record is
   * removed, so the same text can be ingested again. Null when there is no such source.
   */
  withdrawSource(id: string, userId: string): Promise<WithdrawOutcome | null>;
  /**
   * Moves a document's batch to another subject — ingested as about the org when it was about
   * one repository, say: every pending proposal from it, every live memory it produced (the
   * pinned included: a person is correcting them), and the source's own default. Null when
   * there is no such source.
   */
  moveSource(id: string, subject: Subject, userId: string): Promise<MoveOutcome | null>;
  /** One consolidation pass: screen, exact dedupe, then — with a model — contradiction and
   * tightening, then promote; and, once per sweep interval, the decay sweep. */
  consolidate(limit?: number): Promise<ConsolidateStats>;
  /** Waits for every extraction running behind an ingest — what a shutdown awaits before it
   * closes the store under them. */
  drain(): Promise<void>;

  // ── data side ──────────────────────────────────────────────────────────────────────────────
  /** The scope a run id resolves to, or null for a run this service never briefed. */
  scopeOf(runId: string): Promise<RunScope | null>;
  search(
    scope: RunScope,
    args: { query: string; subject?: "org" | "repo"; repo?: string; kind?: MemoryKind; k?: number },
  ): Promise<ScoredMemory[]>;
  /** The full record, if the run may see it. */
  getInScope(scope: RunScope, id: string): Promise<MemoryDetail | null>;
  /** The document behind a pointer memory (or a source id), bounded; a section of it by title.
   * Null when there is no such document, or the run may not see the pointer. */
  docInScope(scope: RunScope, id: string, section?: string): Promise<string | null>;
  propose(scope: RunScope, runId: string, input: ProposeInput): Promise<ProposeOutcome>;
  confirm(scope: RunScope, runId: string, id: string): Promise<Memory | null>;
  refute(
    scope: RunScope,
    runId: string,
    id: string,
    reason: string,
    replacement?: string,
    basis?: Basis,
  ): Promise<{ memory: Memory; replacement: Proposal | null } | null>;
}

/** The tool `search` answers at most this many lines, however large `k` was asked. */
export const MAX_SEARCH_K = 25;
export const DEFAULT_SEARCH_K = 8;

/** Why a claim was rejected when its change was dropped — and so the one rejection a landing
 * that revises the drop takes back (`reviveDropped`). */
const DROPPED_REASON = "the change was dropped";

/** How many pending proposals one consolidation pass resolves. */
const CONSOLIDATE_BATCH = 200;
/** How many pages of the inbox one pass reads past held and waiting rows before it gives up. */
const MAX_CONSOLIDATE_PAGES = 10;
/** How many sections of one document the extractor reads. A document is kept whole and `doc`
 * serves every section; this bounds the model calls one ingest can cost. */
export const MAX_EXTRACT_SECTIONS = 150;
/** How often the decay sweep runs, on the service clock. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/**
 * The query embedding's budget, in two halves. The embedder is CPU-bound — about 320 ms a query
 * on an idle 250m pod, and seconds once its threads contend for that quarter core — and every run
 * start asks for one through `composeBrief`, which the control plane gives three seconds. Under a
 * burst of run starts the briefs used to queue behind each other until EVERY one timed out (the
 * perf harness: 147 of 150 at five starts a second), so those runs began with no brief and no
 * memory tools. Now a search waits for its vector at most QUERY_EMBED_DEADLINE_MS, and starts no
 * new embedding while MAX_QUERY_EMBEDS_IN_FLIGHT are running: past either, it is ranked by its
 * words alone. Slightly worse, and on time.
 */
const MAX_QUERY_EMBEDS_IN_FLIGHT = 2;
const QUERY_EMBED_DEADLINE_MS = 1_000;
/** How long a person's write waits for its claim's vector before it answers anyway. The vector
 * still lands when the embedding finishes, and the backfill covers one that never does. */
const WRITE_EMBED_WAIT_MS = 3_000;
/** Shedding is the design working, not a fault: it is reported as a count at most this often. */
const SHED_REPORT_INTERVAL_MS = 60_000;
/** How long a shutdown waits for embeddings still running. Bounded well inside the pod's grace
 * period: a backfill can hold minutes of work, and what is cut off is the next pod's backfill. */
const EMBED_DRAIN_WAIT_MS = 5_000;
/** Claims per embed call in the backfill; see `backfillEmbeddings`. */
const BACKFILL_CHUNK = 16;

export function makeMemoryService(deps: MemoryServiceDeps): MemoryService {
  const { store, diag } = deps;
  const tenantId = deps.tenantId ?? TENANT_DEFAULT;
  const nowIso = () => deps.now().toISOString();

  const liveStatuses: MemoryStatus[] = ["canon", "needs-verification"];

  /** The trust a promoted proposal starts with, from where it came. */
  const trustFor = (origin: ProposalOrigin): Trust =>
    origin.kind === "run" ? "agent" : origin.kind === "source" ? "ingested" : "human";

  const provenanceFor = (proposal: Proposal): Memory["provenance"] => {
    switch (proposal.origin.kind) {
      case "run":
        return {
          kind: "run",
          runId: proposal.origin.runId,
          taskId: proposal.origin.taskId,
          proposalId: proposal.id,
        };
      case "source":
        return {
          kind: "source",
          sourceId: proposal.origin.sourceId,
          section: proposal.origin.section,
        };
      case "human":
        return { kind: "human", userId: proposal.origin.userId };
    }
  };

  /** The subject a claim is read under when it names none: the run's repo when it holds
   * exactly one — several would be a guess — else the org. */
  const claimSubject = (proposal: Proposal, run: MemoryRun): Subject =>
    proposal.subject ?? (run.repos.length === 1 ? { kind: "repo", url: run.repos[0] } : ORG);

  /**
   * What the change behind an `introduced` claim came to. A bound claim waits on its patch and
   * on every patch that CARRIES it, transitively: the runner names, on each patch, the run's
   * earlier patches whose work it holds in full, by content (the same commits, or each commit's
   * change already in it). Any of them
   * landing releases the claim — a superseded patch, or one a merge passed over, only moves the
   * question to the patch that carries its work on, within its generation or into the next.
   *
   * By content, never by position: a patch that came later but dropped the claim's commits, or
   * amended one, or rewrote its lines resolving a conflict, does not carry it, and its landing
   * credits nothing. A revert later in the range does not take a carry back. And
   * `landed` is the merge's own word that it contained the patch, not that it touched the change
   * request the patch was on.
   *
   * The claim is dropped only once the run has concluded and nothing it follows landed: while
   * the run goes on, another patch can still come. An unbound claim waits on a patch that has not
   * been opened yet (the outcome report binds or rejects it), and a run this service never
   * briefed is still pending — nothing can be said of a change nobody reported.
   */
  const changeOfClaim = (
    proposal: Proposal,
    run: MemoryRun | undefined,
    changes: MemoryChange[],
  ): ClaimChange => {
    const bound = proposal.changeId === null
      ? undefined
      : changes.find((c) => c.patchId === proposal.changeId);
    if (bound === undefined) return { patchId: proposal.changeId, forgeUrl: null, fate: "pending" };
    // Forward along the carries edges, from the bound patch: every patch that carries one already
    // in the closure. The bound patch first, so its own landing is the one named.
    const chain = [bound];
    for (let i = 0; i < chain.length; i++) {
      const at = chain[i].patchId;
      for (const c of changes) {
        if (c.carries.includes(at) && !chain.includes(c)) chain.push(c);
      }
    }
    const landed = chain.find((c) => c.fate === "landed");
    if (landed !== undefined) {
      return {
        patchId: bound.patchId,
        forgeUrl: landed.forgeUrl ?? bound.forgeUrl,
        fate: "landed",
      };
    }
    const open = run === undefined || run.outcome === null ||
      chain.some((c) => c.fate === "pending");
    return { patchId: bound.patchId, forgeUrl: bound.forgeUrl, fate: open ? "pending" : "dropped" };
  };

  /** Rejects every pending `introduced` claim of the run whose change is now known not to
   * land, and leaves the landed ones to the next consolidation pass, the still-open ones to a
   * later report. Idempotent: run it after every settlement. */
  const reconcileIntroduced = async (runId: string): Promise<number> => {
    const [run, changes] = await Promise.all([store.getRun(runId), store.listChangesForRun(runId)]);
    let rejected = 0;
    for (const proposal of await introducedBy(runId)) {
      if (changeOfClaim(proposal, run ?? undefined, changes).fate !== "dropped") continue;
      const done = await store.transitionProposal(proposal.id, "pending", {
        ...proposal,
        status: "rejected",
        resolution: { reason: DROPPED_REASON },
      });
      if (done) rejected += 1;
    }
    return rejected;
  };

  /**
   * Puts back to pending every `introduced` claim of the run that was rejected only because its
   * change was dropped, and whose change is no longer dropped — a patch that stopped and then
   * merged after all (`settleChange`'s one revision). The consolidator then judges it as it
   * would have. A claim a person rejected carries another reason and stays rejected.
   */
  const reviveDropped = async (runId: string): Promise<number> => {
    const [run, changes, rejectedClaims] = await Promise.all([
      store.getRun(runId),
      store.listChangesForRun(runId),
      store.listProposals({
        tenantId,
        statuses: ["rejected"],
        runId,
        basis: "introduced",
        limit: MAX_LIMIT,
      }),
    ]);
    let revived = 0;
    for (const proposal of rejectedClaims) {
      const resolution = proposal.resolution;
      if (resolution === null || !("reason" in resolution)) continue;
      if (resolution.reason !== DROPPED_REASON) continue;
      if (changeOfClaim(proposal, run ?? undefined, changes).fate === "dropped") continue;
      const done = await store.transitionProposal(proposal.id, "rejected", {
        ...proposal,
        status: "pending",
        resolution: null,
      });
      if (done) revived += 1;
    }
    return revived;
  };

  /**
   * Binds the run's unbound `introduced` claims to a patch, and stamps the patch's head onto a
   * claim whose evidence named paths but no commit yet: the claim was about a change that was
   * not a commit anywhere when it was made, and now it is.
   */
  const bindClaims = async (runId: string, change: MemoryChange): Promise<number> => {
    // Which claims a patch can answer for is a question about its REPO. A run holding several
    // repos makes claims about each, and binding them to whatever patch opened next would hand
    // a claim about repo A the verdict of a patch for repo B. A claim that named no subject
    // falls back the way `claimSubject` does: the run's repo when it has exactly one, else the
    // org — and an org claim is about no repo in particular, so any patch answers for it.
    const run = await store.getRun(runId);
    const defaultsToThisRepo = run !== null && run.repos.length === 1 &&
      run.repos[0] === change.repo;
    const bound = await store.bindProposals(
      runId,
      change.patchId,
      change.repo,
      defaultsToThisRepo,
    );
    for (const proposal of bound) {
      if (proposal.evidence === null || proposal.evidence.sha !== null) continue;
      if (change.headSha === null) continue;
      // The head is stamped only onto a claim really about THIS patch's repo. An org claim's
      // paths are not this repo's, and a sha from it would send every later staleness diff
      // looking for those paths in the wrong tree.
      const subject = proposal.subject ??
        (defaultsToThisRepo ? { kind: "repo" as const, url: change.repo } : ORG);
      if (subject.kind !== "repo" || subject.url !== change.repo) continue;
      await store.saveProposal({
        ...proposal,
        evidence: { sha: change.headSha, paths: proposal.evidence.paths },
      });
    }
    return bound.length;
  };

  /** The pending `introduced` claims a run made. */
  const introducedBy = (runId: string): Promise<Proposal[]> =>
    store.listProposals({
      tenantId,
      statuses: ["pending"],
      runId,
      basis: "introduced",
      limit: MAX_LIMIT,
    });

  /** Whether a proposal waits on a run's change at all. */
  const waitsOnRun = (p: Proposal): p is Proposal & { origin: { kind: "run"; runId: string } } =>
    p.basis === "introduced" && p.origin.kind === "run";

  /** The change behind each `introduced` claim, one read per run for the batch; null for every
   * claim that rests on nothing a run changed. */
  const withChanges = async (proposals: Proposal[]): Promise<InboxProposal[]> => {
    const runIds = [...new Set(proposals.filter(waitsOnRun).map((p) => p.origin.runId))];
    const runs = new Map((await store.getRuns(runIds)).map((r) => [r.runId, r]));
    const changes = new Map(
      await Promise.all(
        runIds.map(async (id) => [id, await store.listChangesForRun(id)] as const),
      ),
    );
    return proposals.map((p) => {
      if (!waitsOnRun(p)) return { ...p, change: null };
      return {
        ...p,
        change: changeOfClaim(p, runs.get(p.origin.runId), changes.get(p.origin.runId) ?? []),
      };
    });
  };

  /** The change behind an `introduced` claim; null for any other claim. */
  const changeOf = async (proposal: Proposal): Promise<ClaimChange | null> =>
    (await withChanges([proposal]))[0].change;

  /** The subject a proposal without one lands on: the run's repo, else the org. */
  const defaultSubjectFor = async (proposal: Proposal): Promise<Subject> => {
    if (proposal.origin.kind !== "run") return ORG;
    const run = await store.getRun(proposal.origin.runId);
    return run === null ? ORG : claimSubject(proposal, run);
  };

  /** Canonical URL → the spelling a request used for it, so a brief's evidence names each repo
   * in the caller's own terms; the first spelling wins when a request repeats one. */
  const spellingsOf = (repos: string[]): Map<string, string> => {
    const spelled = new Map<string, string>();
    for (const repo of repos) {
      const canonical = canonicalRepo(repo);
      if (!spelled.has(canonical)) spelled.set(canonical, repo);
    }
    return spelled;
  };

  const inRequestTerms = (brief: Brief | null, spelled: Map<string, string>): Brief | null =>
    brief === null ? null : {
      ...brief,
      evidence: brief.evidence.map((e) => ({ ...e, repo: spelled.get(e.repo) ?? e.repo })),
    };

  /** Promotes a proposal to canon — the row, the supersede link, the resolution — as one
   * atomic step the store takes only if the proposal is still pending. Null: someone resolved
   * it first (a person, or another pass), and nothing was written. */
  const promote = async (
    proposal: Proposal,
    fields: { subject: Subject; audience: Audience; kind: MemoryKind; trust: Trust },
    resolution?: ProposalResolution,
    /** A person accepting it, waiting on the answer — as opposed to the consolidator's pass. */
    byPerson = false,
  ): Promise<Memory | null> => {
    const at = nowIso();
    const memory: Memory = {
      id: deps.mintId("mem"),
      tenantId,
      text: proposal.text,
      kind: fields.kind,
      subject: fields.subject,
      audience: fields.audience,
      status: "canon",
      trust: fields.trust,
      provenance: provenanceFor(proposal),
      // Evidence without its commit is no evidence the staleness check can diff from: a claim
      // whose patch never stamped it carries none rather than a hole. Said out loud, because
      // the memory that results is exempt from staleness forever and nothing else would show it.
      evidence: proposal.evidence === null || proposal.evidence.sha === null
        ? null
        : { sha: proposal.evidence.sha, paths: proposal.evidence.paths },
      supersedes: proposal.supersedes,
      supersededBy: null,
      confirmations: 0,
      refutations: 0,
      briefedCount: 0,
      briefedSuccesses: 0,
      lastBriefedAt: null,
      lastConfirmedAt: null,
      lastRefutedAt: null,
      embedding: null,
      embeddingModel: null,
      createdAt: at,
      updatedAt: at,
    };
    if (proposal.evidence !== null && proposal.evidence.sha === null) {
      diag.warn("memory.evidence_dropped", {
        proposalId: proposal.id,
        paths: proposal.evidence.paths.length,
      });
    }
    const claimed = await store.promote({
      proposal: {
        ...proposal,
        status: "promoted",
        resolution: { ...resolution, memoryId: memory.id },
      },
      memory,
      supersedes: proposal.supersedes,
    });
    if (!claimed) return null;
    await embedInto(memory, byPerson);
    return memory;
  };

  /** Sets fields and moves counters on a memory in place — never from a copy, so two callers
   * bumping one memory both land. Answers the row as it is after. */
  const bump = async (
    memory: Memory,
    set: Partial<Omit<Memory, "id" | MemoryCounter>>,
    adjust?: Partial<Record<MemoryCounter, number>>,
  ): Promise<Memory> =>
    (await store.patchMemory(memory.id, { ...set, updatedAt: nowIso() }, adjust)) ??
      { ...memory, ...set };

  /** The runs that refuted a memory since it was last confirmed, from the signal log. */
  const refutedSinceConfirmed = async (memory: Memory): Promise<Set<string>> => {
    const runs = new Set<string>();
    if (memory.lastRefutedAt === null) return runs;
    // Newest first; a confirmation (a run's, or the consolidator's) ends the count.
    for (const f of await store.listFeedbackForMemory(memory.id, MAX_LIMIT)) {
      if (f.kind === "confirm") break;
      if (f.kind === "refute") runs.add(f.runId);
    }
    return runs;
  };

  /**
   * The commit THIS run diffed a claim to when it found it stale — what a confirmation from
   * the same run re-anchors the claim's evidence to. Newest first, and the previous
   * confirmation ends the scan: doubt older than it was already answered, and the commit it
   * was raised at is not what this run verified.
   *
   * Only this run's own finding counts. A confirmation from somewhere else (a search, another
   * run's clone) says the claim still holds, not which tree it was read in — moving the
   * evidence to a commit nobody verified here would be a guess written down as a fact.
   */
  const staleHeadFor = async (memory: Memory, runId: string): Promise<string | null> => {
    if (memory.evidence === null) return null;
    for (const f of await store.listFeedbackForMemory(memory.id, MAX_LIMIT)) {
      if (f.kind === "confirm") return null;
      if (f.kind === "stale" && f.runId === runId && f.headSha !== null) return f.headSha;
    }
    return null;
  };

  /** The evidence a confirmation moves a memory to, or null to leave it where it is. */
  const reanchor = (memory: Memory, sha: string | null): Evidence | null =>
    memory.evidence === null || sha === null || sha === memory.evidence.sha
      ? null
      : { sha, paths: memory.evidence.paths };

  const detailOf = async (memory: Memory): Promise<MemoryDetail> => {
    const [feedback, supersedes, supersededBy, runs] = await Promise.all([
      store.listFeedbackForMemory(memory.id, 100),
      memory.supersedes === null ? null : store.getMemory(memory.supersedes),
      memory.supersededBy === null ? null : store.getMemory(memory.supersededBy),
      store.listRunsForMemory(memory.id, 50),
    ]);
    return { memory, feedback, supersedes, supersededBy, runs };
  };

  const refuseText = (text: string): string | null => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return "the text is empty";
    if (trimmed.length > MAX_MEMORY_TEXT) {
      return `a memory is one claim of at most ${MAX_MEMORY_TEXT} characters — split or shorten it`;
    }
    if (isSecretShaped(trimmed)) {
      return "the text looks like it carries a credential, which memory never stores";
    }
    return null;
  };

  const insertProposal = async (
    text: string,
    origin: ProposalOrigin,
    fields: {
      kind: MemoryKind | null;
      subject: Subject | null;
      audience: Audience | null;
      evidence: ProposalEvidence | null;
      supersedes: string | null;
      basis: Basis;
    },
  ): Promise<ProposeOutcome> => {
    const refused = refuseText(text);
    if (refused !== null) return { ok: false, reason: refused };
    const trimmed = text.trim();
    const proposal: Proposal = {
      id: deps.mintId("prop"),
      tenantId,
      text: trimmed,
      ...fields,
      origin,
      changeId: null,
      status: "pending",
      resolution: null,
      flags: screen(trimmed).filter((f) => f !== "secret-shaped"),
      createdAt: nowIso(),
    };
    await store.insertProposal(proposal);
    diag.debug("memory.proposed", { proposalId: proposal.id, origin, flags: proposal.flags });
    return { ok: true, proposal };
  };

  /** What a run on this scope could be briefed with, ranked against the task text. Relevance
   * is a tie-breaker between memories on the same subjects, not a filter: a memory that shares
   * no term with the task still rides if the budget allows. */
  const briefCandidates = async (
    scope: RunScope,
    task: ComposeBriefRequest["task"],
  ): Promise<BriefCandidate[]> => {
    const query = `${task.title}\n${task.instructions}`;
    const within = {
      tenantId,
      subjects: subjectsOf(scope),
      audiences: audiencesOf(scope),
      statuses: ["canon" as const],
    };
    // Pinned memories ride whatever the task says, so they are fetched apart from the ranked
    // page: a page ranked by the task's words would leave out the pinned memory that shares
    // none of them.
    const vectorPromise = queryVectorFor(query);
    const pinnedPromise = store.listMemories({ ...within, trusts: ["pinned"], limit: MAX_LIMIT });
    const [pinned, [ranked, stale]] = await Promise.all([
      pinnedPromise,
      vectorPromise.then((queryVector) =>
        Promise.all([
          store.listMemories({
            ...within,
            query,
            queryVector,
            limit: MAX_LIMIT,
          }),
          store.listMemories({
            ...within,
            statuses: ["needs-verification"],
            query,
            queryVector,
            matchOnly: true,
            limit: MAX_LIMIT,
          }),
        ])
      ),
    ]);
    const seen = new Set<string>();
    const out: BriefCandidate[] = [];
    for (const { memory, relevance } of [...ranked, ...pinned, ...stale]) {
      if (seen.has(memory.id)) continue;
      seen.add(memory.id);
      out.push({
        memory,
        relevance: memory.status === "needs-verification" ? relevance : 0.5 + 0.5 * relevance,
      });
    }
    return out;
  };

  const scopeFor = (req: Omit<ComposeBriefRequest, "runId" | "taskId">): RunScope => ({
    agentId: req.agentId,
    ...(req.agentOnly ? { agentOnly: true } : {}),
    // Canonical and deduplicated, in checkout order: two spellings of one repo are one subject.
    repos: [...new Set(req.repos.map(canonicalRepo))],
  });

  /** One proposal's fate, decided. The model judges when there is one; the trivial path is
   * the fallback for no model and for a judgement that failed. */
  const decide = async (
    proposal: Proposal,
    subject: Subject,
    hasRepo: boolean,
    stats: ConsolidateStats,
  ): Promise<Verdict | null> => {
    if (!deps.model) return null;
    // The candidates: what the canon says on this subject that shares terms with the claim,
    // plus the memory a replacement refutes — the judge must see what it is replacing.
    const related = await store.listMemories({
      tenantId,
      subjects: [subject],
      audiences: [proposal.audience ?? EVERYONE],
      statuses: liveStatuses,
      query: proposal.text,
      matchOnly: true,
      limit: 8,
    });
    const candidates = related.map((r) => r.memory);
    if (proposal.supersedes !== null && !candidates.some((c) => c.id === proposal.supersedes)) {
      const old = await store.getMemory(proposal.supersedes);
      if (old !== null && sameAudience(old.audience, proposal.audience ?? EVERYONE)) {
        candidates.push(old);
      }
    }
    try {
      const verdict = await judge(deps.model, {
        text: proposal.text,
        kindHint: proposal.kind,
        subject: subject.kind,
        hasRepo,
        supersedes: proposal.supersedes,
        candidates,
      });
      stats.judged += 1;
      return verdict;
    } catch (err) {
      stats.modelFailures += 1;
      diag.warn("memory.judge_failed", { proposalId: proposal.id, err: String(err) });
      return null;
    }
  };

  /** The subject a verdict moves a claim to, within what the proposer's run could name. */
  const subjectFrom = (hint: "org" | "repo", current: Subject, repo: Subject | null): Subject =>
    hint === "org" ? ORG : repo ?? current;

  /** The embedder, or null when there is none or it gave up for good (Embedder.available). */
  const liveEmbedder = (): Embedder | null =>
    deps.embedder && deps.embedder.available?.() !== false ? deps.embedder : null;

  /** The backfill itself; `backfillEmbeddings` is it, tracked for a shutdown to wait on. */
  const backfill = async (limit: number): Promise<{ embedded: number; remaining: number }> => {
    const embedder = liveEmbedder();
    if (!embedder) return { embedded: 0, remaining: 0 };
    // Claims whose own embedding is still on its way are left to it.
    const listed = await store.listMemoriesWithoutEmbedding(tenantId, embedder.model, limit);
    if (listed.length === 0) return { embedded: 0, remaining: 0 };
    const batch = listed.filter((memory) => !embedding.has(memory.id));
    // A few at a time, each saved as it comes: a failure late in the batch keeps what came
    // before it. Each vector is saved only if the claim still reads as it was embedded — an
    // edit that landed meanwhile has its own, newer vector.
    for (let i = 0; i < batch.length; i += BACKFILL_CHUNK) {
      const part = batch.slice(i, i + BACKFILL_CHUNK);
      let vectors: number[][];
      try {
        vectors = await embedder.embed(part.map((m) => m.text));
      } catch (err) {
        // One that gave up on this very call said so itself, once; nothing is left to do.
        if (embedder.available?.() === false) return { embedded: 0, remaining: 0 };
        throw err;
      }
      for (const [j, memory] of part.entries()) {
        await store.saveEmbedding(memory.id, embedder.model, vectors[j], memory.text);
      }
    }
    // Still counted when every candidate was left to its own embedding: those are not done yet,
    // and a caller looping until nothing remains must not stop on them.
    const remaining =
      (await store.listMemoriesWithoutEmbedding(tenantId, embedder.model, 1)).length;
    if (batch.length > 0) {
      diag.debug("memory.embeddings_backfilled", { embedded: batch.length, more: remaining > 0 });
    }
    return { embedded: batch.length, remaining };
  };

  /** Memories with an embedding on its way — counted, since two edits in a row overlap — and
   * every embedding still running; see embedInto. */
  const embeddingCount = new Map<string, number>();
  const embedding = { has: (id: string) => (embeddingCount.get(id) ?? 0) > 0 };
  const embedWork = new Set<Promise<unknown>>();

  /** `work`, or undefined once `ms` pass first. The work itself runs on either way. */
  const waitAtMost = async <T>(work: Promise<T>, ms: number): Promise<T | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) =>
      timer = setTimeout(() => resolve(undefined), ms)
    );
    try {
      return await Promise.race([work, late]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** Embeds a memory's claim and stores the vector. Best-effort: a runtime that is down leaves
   * the memory for the backfill, and never fails the write that made it. A write a person is
   * waiting on (`urgent`) goes ahead of background work; either way the caller waits at most
   * WRITE_EMBED_WAIT_MS. The consolidator's promotions are not urgent: a pass of them would
   * otherwise crowd out every brief's search. */
  const embedInto = async (memory: Memory, urgent: boolean): Promise<void> => {
    const embedder = liveEmbedder();
    if (!embedder) return;
    const work = Promise.resolve()
      .then(() => embedder.embed([memory.text], { urgent }))
      .then(([vector]) => store.saveEmbedding(memory.id, embedder.model, vector, memory.text))
      .catch((err) => {
        // One that gave up said so itself, once (Embedder.available).
        if (embedder.available?.() === false) return;
        diag.warn("memory.embed_failed", { memoryId: memory.id, err: String(err) });
      })
      .finally(() => {
        const left = (embeddingCount.get(memory.id) ?? 1) - 1;
        if (left > 0) embeddingCount.set(memory.id, left);
        else embeddingCount.delete(memory.id);
        embedWork.delete(work);
      });
    // Known while it runs, so the backfill does not queue the same claim a second time and a
    // shutdown can wait for it before the store closes.
    embeddingCount.set(memory.id, (embeddingCount.get(memory.id) ?? 0) + 1);
    embedWork.add(work);
    await waitAtMost(work, deps.writeEmbedWaitMs ?? WRITE_EMBED_WAIT_MS);
  };

  /** The query's vector for a hybrid search, or undefined when there is no embedder, it failed,
   * or too many are already queued — full-text carries the search either way. */
  const maxQueryEmbeds = deps.maxQueryEmbedsInFlight ?? MAX_QUERY_EMBEDS_IN_FLIGHT;
  const queryEmbedDeadlineMs = deps.queryEmbedDeadlineMs ?? QUERY_EMBED_DEADLINE_MS;
  let queryEmbedsInFlight = 0;
  // Counted, and reported on the first shed after the interval, with the moment the count
  // started — so a report that comes late still says which stretch of time it covers.
  const shed = { busy: 0, late: 0, since: null as string | null, reportedAt: -Infinity };
  const noteShed = (reason: "busy" | "late") => {
    const now = deps.now();
    shed[reason]++;
    shed.since ??= now.toISOString();
    if (now.getTime() - shed.reportedAt < SHED_REPORT_INTERVAL_MS) return;
    diag.warn("memory.embed_query_shed", { busy: shed.busy, late: shed.late, since: shed.since });
    shed.busy = 0;
    shed.late = 0;
    shed.since = null;
    shed.reportedAt = now.getTime();
  };
  const queryVectorFor = async (
    text: string,
  ): Promise<{ model: string; vector: number[] } | undefined> => {
    const embedder = liveEmbedder();
    if (!embedder || text.trim() === "") return undefined;
    if (queryEmbedsInFlight >= maxQueryEmbeds) {
      noteShed("busy");
      return undefined;
    }
    // The slot is held until the embedding ENDS, not until this search stops waiting for it: a
    // search that gave up still left the work running, and counting it is what keeps a burst
    // from stacking more of it.
    queryEmbedsInFlight++;
    // Started inside a `then`, so an embedder that throws before it returns a promise still
    // reaches the `finally` below and gives the slot back.
    // Aborted when this search stops waiting: a job still queued is then dropped before it reaches
    // the model thread, which frees the thread and this slot for a search that is still waiting.
    const giveUp = new AbortController();
    const vector = Promise.resolve()
      .then(() => embedder.embed([text.slice(0, 2_000)], { urgent: true, signal: giveUp.signal }))
      .then(([vector]) => ({ model: embedder.model, vector }))
      .catch((err) => {
        // Dropped because this search gave up on it: that is the shed, already counted. One
        // whose embedder gave up said so itself, once.
        if (!giveUp.signal.aborted && embedder.available?.() !== false) {
          diag.warn("memory.embed_query_failed", { err: String(err) });
        }
        return null;
      })
      .finally(() => queryEmbedsInFlight--);
    // null: the embedding failed (and said so); undefined: it was late.
    const first = await waitAtMost(vector, queryEmbedDeadlineMs);
    if (first === undefined) {
      giveUp.abort();
      noteShed("late");
    }
    return first ?? undefined;
  };

  /** Every memory of the tenant, a page at a time — the canon is small by construction. */
  async function* everyMemory(): AsyncGenerator<Memory> {
    const page = 500;
    for (let offset = 0;; offset += page) {
      const rows = await store.listMemories({ tenantId, limit: page, offset });
      for (const row of rows) yield row.memory;
      if (rows.length < page) return;
    }
  }

  /** Retires what decayed past its horizon unused. Returns how many. */
  const sweep = async (): Promise<number> => {
    let swept = 0;
    const now = deps.now();
    const at = now.toISOString();
    for await (const memory of everyMemory()) {
      if (!isSweepable(memory, now)) continue;
      await bump(memory, { status: "retired" });
      await store.appendFeedback(tenantId, {
        kind: "sweep",
        memoryId: memory.id,
        reason: "decayed",
        at,
      });
      swept += 1;
    }
    return swept;
  };

  /** A source's text as `doc` serves it, or one section of it. */
  const renderSource = (source: Source, section: string | undefined): string | null => {
    const sections = splitSections(source.text);
    if (section === undefined) return renderDoc(source.title, source.text, sections);
    const found = findSection(sections, section);
    return found === null ? null : `# ${source.title} › ${found.title}\n\n${found.text}`;
  };

  /** The pointer claim for a whole document: what exists and how to fetch it. */
  const pointerText = (source: Source, sections: SourceSection[]): string => {
    const names = sections.slice(0, 6).map((s) =>
      s.title.replace(/ \(\d+\)$/, "").split(" › ").pop() ?? s.title
    );
    const index = [...new Set(names)].join(", ") + (sections.length > 6 ? ", …" : "");
    return `The document "${source.title}" is on record` +
      (source.locator ? ` (from ${source.locator})` : "") +
      `${index ? `; sections: ${index}` : ""}. Read it with the memory doc tool when its ` +
      "subject comes up.";
  };

  // The sweep runs on its own, slower cadence than the inbox: once per SWEEP_INTERVAL_MS of the
  // service clock, so a minute-cadence consolidator does not scan the canon sixty times an hour.
  let lastSweepAt: number | null = null;

  /** The extractions running behind admitted sources, so a shutdown can wait for them. */
  const inflight = new Set<Promise<IngestOutcome>>();

  /** Every pending proposal a source has, however many: the batch is worked whole. */
  const pendingFrom = async (sourceId: string): Promise<Proposal[]> => {
    const out: Proposal[] = [];
    for (let offset = 0;; offset += MAX_LIMIT) {
      const page = await store.listProposals({
        tenantId,
        sourceId,
        statuses: ["pending"],
        limit: MAX_LIMIT,
        offset,
      });
      out.push(...page);
      if (page.length < MAX_LIMIT) return out;
    }
  };

  /** The extraction behind an admitted source — one model call per section, the pointer, and
   * the supersession of the source it replaces. Never throws: what it did, or why it could not,
   * lands on the source as its status. */
  const extract = async (
    source: Source,
    subject: Subject,
    previous: Source | null,
  ): Promise<IngestOutcome> => {
    try {
      const { proposals, stats } = await extractInto(source, source.text, subject, previous);
      const ready: Source = { ...source, status: "ready", extraction: stats, failure: null };
      await store.saveSource(ready);
      return { source: ready, proposals, stats };
    } catch (err) {
      const failure = err instanceof Error ? err.message : String(err);
      diag.warn("memory.ingest_failed", { sourceId: source.id, err: failure });
      const failed: Source = { ...source, status: "failed", extraction: null, failure };
      // The store may be the thing that failed (a shutdown closed it): the promise the route
      // discarded must still settle, never reject.
      try {
        await store.saveSource(failed);
      } catch (saveErr) {
        diag.warn("memory.ingest_failure_unrecorded", {
          sourceId: source.id,
          err: String(saveErr),
        });
      }
      return {
        source: failed,
        proposals: [],
        stats: {
          sections: 0,
          extracted: 0,
          failed: 0,
          retired: 0,
          skipped: 0,
          modelBacked: Boolean(deps.model),
        },
      };
    }
  };

  /** Thrown inside the extraction when the source was withdrawn under it: the batch stops. */
  class IngestAbortedError extends Error {}

  const extractInto = async (
    source: Source,
    text: string,
    subject: Subject,
    previous: Source | null,
  ): Promise<{ proposals: Proposal[]; stats: IngestStats }> => {
    const sections = splitSections(text);
    const subjectHint = subject.kind;
    const repo = subject.kind === "repo" ? subject.url : null;
    const read = sections.slice(0, MAX_EXTRACT_SECTIONS);
    const stats: IngestStats = {
      sections: sections.length,
      extracted: 0,
      failed: 0,
      retired: 0,
      skipped: sections.length - read.length,
      modelBacked: Boolean(deps.model),
    };
    if (stats.skipped > 0) {
      diag.warn("memory.extract_bounded", {
        sourceId: source.id,
        sections: sections.length,
        read: read.length,
      });
    }
    const proposals: Proposal[] = [];
    const seen = new Set<string>();
    const propose = async (
      claimText: string,
      claimKind: MemoryKind,
      subject: Subject,
      section: string | null,
      supersedes: string | null,
    ) => {
      const key = normalizeClaim(claimText);
      if (seen.has(key)) return false;
      seen.add(key);
      // Withdrawn while ingesting: nothing more lands under a record that is gone.
      if ((await store.getSource(source.id)) === null) {
        throw new IngestAbortedError("withdrawn while ingesting");
      }
      const outcome = await insertProposal(claimText, {
        kind: "source",
        sourceId: source.id,
        section,
      }, {
        kind: claimKind,
        subject,
        audience: EVERYONE,
        evidence: null,
        supersedes,
        basis: "observed",
      });
      if (outcome.ok) proposals.push(outcome.proposal);
      return outcome.ok;
    };

    // The extraction, one model call per section; a section whose answer fails yields
    // nothing and is counted, never a reason to stop.
    if (deps.model) {
      for (const section of read) {
        try {
          const claims = await extractClaims(
            deps.model,
            { title: source.title, subject: subjectHint, repo },
            section,
          );
          for (const claim of claims) {
            const subject: Subject = claim.subject === "org" || repo === null
              ? ORG
              : { kind: "repo", url: repo };
            if (await propose(claim.text, claim.kind, subject, section.title, null)) {
              stats.extracted += 1;
            }
          }
        } catch (err) {
          if (err instanceof IngestAbortedError) throw err;
          stats.failed += 1;
          diag.warn("memory.extract_failed", {
            sourceId: source.id,
            section: section.title,
            err: String(err),
          });
        }
      }
    }
    // The pointer: the document exists and when to read it. Supersedes the old pointer of
    // the source this one replaces, so the chain says what changed.
    const oldPointer = previous === null
      ? null
      : (await store.listMemoriesForSource(previous.id)).find((m) => m.kind === "pointer") ??
        null;
    await propose(
      pointerText(source, sections),
      "pointer",
      subject,
      null,
      oldPointer?.id ?? null,
    );

    // A re-ingest: what the old extraction said and the new one no longer does is retired —
    // the document changed under it. What both say, the consolidator's dedupe confirms.
    if (previous !== null) {
      const proposed = new Set(proposals.map((p) => normalizeClaim(p.text)));
      for (const old of await store.listMemoriesForSource(previous.id)) {
        if (old.kind === "pointer" || old.trust === "pinned" || old.status === "retired") {
          continue;
        }
        if (proposed.has(normalizeClaim(old.text))) continue;
        await bump(old, { status: "retired" });
        await store.appendFeedback(tenantId, {
          kind: "sweep",
          memoryId: old.id,
          reason: "source-superseded",
          at: nowIso(),
        });
        stats.retired += 1;
      }
    }
    diag.debug("memory.ingested", { sourceId: source.id, ...stats, proposals: proposals.length });
    return { proposals, stats };
  };

  /** A proposal's origin for a run this service briefed: the run and the task it belongs to. */
  const runOrigin = async (runId: string): Promise<ProposalOrigin> => {
    const run = await store.getRun(runId);
    if (run === null) throw new Error(`run ${runId} has no memory scope`);
    return { kind: "run", runId, taskId: run.taskId };
  };

  const service: MemoryService = {
    async composeBrief(req) {
      const scope = scopeFor(req);
      const at = nowIso();
      const budget = req.budgetTokens ?? DEFAULT_BRIEF_BUDGET_TOKENS;
      const found = await briefCandidates(scope, req.task);
      const brief = inRequestTerms(compose(found, budget, deps.now()), spellingsOf(req.repos));
      const briefed = brief?.memoryIds ?? [];
      // The scope row first: the tools need it whether or not there was anything to say.
      await store.putRun({
        runId: req.runId,
        taskId: req.taskId,
        tenantId,
        agentId: scope.agentId,
        ...(scope.agentOnly ? { agentOnly: true } : {}),
        repos: scope.repos,
        briefed,
        outcome: null,
        createdAt: at,
      });
      for (const memory of found.map((f) => f.memory)) {
        if (!briefed.includes(memory.id)) continue;
        await bump(memory, { lastBriefedAt: at }, { briefedCount: 1 });
        await store.appendFeedback(tenantId, {
          kind: "briefed",
          canonAtExposure: memory.status === "canon",
          memoryId: memory.id,
          runId: req.runId,
          at,
        });
      }
      diag.debug("memory.briefed", {
        runId: req.runId,
        candidates: found.length,
        briefed: briefed.length,
        tokens: brief === null ? 0 : Math.ceil(brief.text.length / 4),
      });
      return brief;
    },

    async previewBrief(req) {
      const candidates = await briefCandidates(scopeFor(req), req.task);
      const brief = inRequestTerms(
        compose(candidates, req.budgetTokens ?? DEFAULT_BRIEF_BUDGET_TOKENS, deps.now()),
        spellingsOf(req.repos),
      );
      const included = new Set(brief?.memoryIds ?? []);
      return {
        brief,
        candidates: candidates
          .map((c) => ({
            memory: c.memory,
            relevance: c.relevance,
            score: scoreMemory(c.memory, deps.now(), c.relevance),
            included: included.has(c.memory.id),
          }))
          .sort((a, b) => Number(b.included) - Number(a.included) || b.score.total - a.score.total),
      };
    },

    async reportOutcome(runId, status) {
      // The store records an outcome once: a redelivery, or a racing report, changes nothing.
      const run = await store.claimRunOutcome(runId, status);
      if (run === null) return;
      const at = nowIso();
      await store.appendFeedback(tenantId, { kind: "outcome", runId, status, at });
      // No more patches will open. A claim made after the run's last patch — the finalize
      // added nothing new — binds to that patch: it is the change that must land.
      //
      // Only while that patch is still PENDING, though. A patch that already merged (or was
      // dropped) carries a verdict these claims had no part in: the run made them after the
      // work shipped, so binding them there would hand a leftover claim an already-`landed`
      // change and promote it to canon on the strength of work it never described. A run whose
      // last patch has settled is, for these claims, a run that changed nothing — same as a run
      // that opened no patch at all.
      const changes = await store.listChangesForRun(runId);
      const latest = changes.at(-1);
      let rejected = 0;
      if (latest !== undefined && latest.fate === "pending") {
        await bindClaims(runId, latest);
      }
      // Whatever is STILL unbound rests on nothing, and this is the last moment anything can be
      // said about it: the run is over, so no patch will ever open for it to wait on — and an
      // unbound claim reads as `pending` forever (changeOfClaim), so nothing else would ever
      // reject it either. Three ways to get here: the run opened no patch at all, its last
      // patch had already settled, or the claim is about a repo this run never shipped one for.
      // A claim already BOUND is untouched — what becomes of it is `reconcileIntroduced`'s to
      // say, and its reason (the change was dropped) is a different one.
      for (const proposal of await introducedBy(runId)) {
        if (proposal.changeId !== null) continue;
        const done = await store.transitionProposal(proposal.id, "pending", {
          ...proposal,
          status: "rejected",
          resolution: { reason: "the run made no change" },
        });
        if (done) rejected += 1;
      }
      rejected += await reconcileIntroduced(runId);
      diag.debug("memory.outcome", { runId, status, patches: changes.length, rejected });
      if (status !== "success") return;
      // Briefed into a run that succeeded and was not refuted by it: a small confirmation.
      const feedback = await store.listFeedbackForRun(runId);
      // Persisted exposure provenance prevents another run's confirmation from turning this
      // run's stale observation into an implicit endorsement. Legacy briefed events were canon
      // only. Missing events (including a truncated feedback page) conservatively earn no credit.
      const canonAtExposure = new Set(
        feedback.flatMap((f) =>
          f.kind === "briefed" && f.canonAtExposure !== false ? [f.memoryId] : []
        ),
      );
      const refuted = new Set(
        feedback
          .filter((f) => f.kind === "refute")
          .map((f) => (f as Extract<Feedback, { kind: "refute" }>).memoryId),
      );
      for (const memory of await store.getMemories(run.briefed)) {
        // Stale observations are exposed for verification, not implicitly endorsed by success.
        if (
          memory.status !== "canon" || !canonAtExposure.has(memory.id) || refuted.has(memory.id)
        ) continue;
        await bump(memory, {}, { briefedSuccesses: 1 });
      }
    },

    async reportPatch(runId, patch) {
      const at = nowIso();
      const existing = await store.getChange(patch.patchId);
      if (existing !== null) {
        // The patch again, as a pull request now: only what arrives later moves. Its fate is
        // `settleChange`'s alone, and its place in the run is fixed at birth.
        // What it carries can only grow, and is a union in the store: two reports never lose an
        // edge between them.
        if (patch.carries.some((id) => !existing.carries.includes(id))) {
          await store.addCarries(patch.patchId, patch.carries);
        }
        if (existing.forgeUrl === patch.forgeUrl && existing.headSha === patch.headSha) return;
        await store.saveChange({
          ...existing,
          headSha: patch.headSha ?? existing.headSha,
          forgeUrl: patch.forgeUrl ?? existing.forgeUrl,
          updatedAt: at,
        });
        return;
      }
      // A run this service never briefed has no claims to bind and no scope to bind them under.
      const run = await store.getRun(runId);
      if (run === null) return;
      // The seq is the store's to take, in the statement that inserts: computed here from a
      // list read a moment earlier, two concurrent reports both got the same number.
      const change = await store.insertChange({
        patchId: patch.patchId,
        runId,
        tenantId,
        repo: canonicalRepo(patch.repo),
        generation: patch.generation,
        headSha: patch.headSha,
        forgeUrl: patch.forgeUrl,
        carries: patch.carries,
        fate: "pending",
        createdAt: at,
        updatedAt: at,
      });
      // A concurrent report of the same patch inserted first: what this one carries still counts.
      if (patch.carries.some((id) => !change.carries.includes(id))) {
        await store.addCarries(patch.patchId, patch.carries);
      }
      const seq = change.seq;
      // Every claim made since the last patch is about this one: it binds here, and what it
      // waits on is now a patch with a head rather than "whatever the run ships next".
      const bound = await bindClaims(runId, change);
      diag.debug("memory.patch_opened", { runId, patchId: patch.patchId, seq, bound });
    },

    async reportChange(runId, patchId, fate, carries) {
      const before = await store.getChange(patchId);
      if (before === null || before.runId !== runId) return;
      // The edges first: a birth report that never arrived must not leave the claims this patch
      // carries waiting on a landing that already happened.
      const grew = carries.some((id) => !before.carries.includes(id));
      if (grew) await store.addCarries(patchId, carries);
      // Settled once — the store refuses a second report, or a racing one — then the run's
      // claims are reconciled against what is now known.
      const change = await store.settleChange(patchId, fate, nowIso());
      if (change === null && !grew) return;
      // A landing, or an edge to one, can revise a drop: the claims rejected only because of it
      // come back.
      const revived = await reviveDropped(runId);
      const rejected = await reconcileIntroduced(runId);
      diag.debug("memory.change_settled", { runId, patchId, fate, rejected, revived });
    },

    async reportStale(runId, stale) {
      const run = await store.getRun(runId);
      if (run === null) return;
      const briefed = new Set(run.briefed);
      const at = nowIso();
      for (const report of stale) {
        // Only what THIS run was briefed with: a runner cannot cast doubt on memories it never
        // saw, whatever ids it sends.
        if (!briefed.has(report.memoryId)) continue;
        const memory = await store.getMemory(report.memoryId);
        if (memory === null || memory.status === "retired") continue;
        // Pinning prioritizes a claim, but does not override changed evidence.
        if (memory.status === "canon") {
          await bump(memory, { status: "needs-verification" });
        }
        await store.appendFeedback(tenantId, {
          kind: "stale",
          memoryId: memory.id,
          runId,
          changedPaths: report.changedPaths.slice(0, 50),
          headSha: report.headSha,
          at,
        });
      }
      diag.debug("memory.stale_reported", { runId, stale: stale.length });
    },

    async health() {
      const bySubject = new Map<string, MemoryHealth["subjects"][number]>();
      const live = liveEmbedder();
      const embeddings = live ? { model: live.model, embedded: 0, pending: 0 } : null;
      for await (const memory of everyMemory()) {
        const key = subjectKey(memory.subject);
        const row = bySubject.get(key) ?? {
          subject: memory.subject,
          canon: 0,
          needsVerification: 0,
          retired: 0,
          neverBriefed: 0,
          contested: 0,
        };
        if (memory.status === "canon") row.canon += 1;
        else if (memory.status === "needs-verification") row.needsVerification += 1;
        else row.retired += 1;
        if (memory.status !== "retired") {
          if (memory.briefedCount === 0) row.neverBriefed += 1;
          if (memory.refutations > 0) row.contested += 1;
          if (embeddings !== null) {
            if (memory.embeddingModel === embeddings.model && memory.embedding !== null) {
              embeddings.embedded += 1;
            } else embeddings.pending += 1;
          }
        }
        bySubject.set(key, row);
      }
      const pending = await withChanges(
        await store.listProposals({ tenantId, statuses: ["pending"], limit: MAX_LIMIT }),
      );
      return {
        subjects: [...bySubject.values()].sort((a, b) =>
          subjectKey(a.subject).localeCompare(subjectKey(b.subject))
        ),
        embeddings,
        inbox: {
          pending: pending.length,
          flagged: pending.filter((p) => p.flags.length > 0).length,
          contradicting: pending.filter((p) => p.flags.includes("contradicts")).length,
          awaiting: pending.filter((p) => p.change?.fate === "pending").length,
          oldestAt: pending[0]?.createdAt ?? null,
        },
        modelBacked: Boolean(deps.model),
      };
    },

    async list(query) {
      return await store.listMemories({
        ...query,
        tenantId,
        queryVector: query.query === undefined ? undefined : await queryVectorFor(query.query),
      });
    },

    backfillEmbeddings(limit = 200) {
      const work = backfill(limit);
      embedWork.add(work);
      return work.finally(() => embedWork.delete(work));
    },

    async get(id) {
      const memory = await store.getMemory(id);
      return memory === null ? null : detailOf(memory);
    },

    subjects() {
      return store.countMemories(tenantId);
    },

    async create(input, userId) {
      const refused = refuseText(input.text);
      if (refused !== null) throw new MemoryRefusedError(refused);
      const at = nowIso();
      const memory: Memory = {
        id: deps.mintId("mem"),
        tenantId,
        text: input.text.trim(),
        kind: input.kind,
        subject: input.subject,
        audience: input.audience,
        status: "canon",
        trust: input.pinned ? "pinned" : "human",
        provenance: { kind: "human", userId },
        evidence: input.evidence ?? null,
        supersedes: null,
        supersededBy: null,
        confirmations: 0,
        refutations: 0,
        briefedCount: 0,
        briefedSuccesses: 0,
        lastBriefedAt: null,
        lastConfirmedAt: null,
        lastRefutedAt: null,
        embedding: null,
        embeddingModel: null,
        createdAt: at,
        updatedAt: at,
      };
      await store.insertMemory(memory);
      await embedInto(memory, true);
      await store.appendFeedback(tenantId, {
        kind: "human",
        memoryId: memory.id,
        userId,
        action: "create",
        at,
      });
      return memory;
    },

    async edit(id, patch, userId) {
      const memory = await store.getMemory(id);
      if (memory === null) return null;
      if (patch.text !== undefined) {
        const refused = refuseText(patch.text);
        if (refused !== null) throw new MemoryRefusedError(refused);
      }
      const text = patch.text === undefined ? memory.text : patch.text.trim();
      const next = await bump(memory, {
        text,
        kind: patch.kind ?? memory.kind,
        subject: patch.subject ?? memory.subject,
        audience: patch.audience ?? memory.audience,
        // New words, no vector yet: the old one ranks the claim by what it no longer says, and
        // an empty one is what the backfill looks for if the new one never lands.
        ...(text === memory.text ? {} : { embedding: null, embeddingModel: null }),
      });
      if (next.text !== memory.text) await embedInto(next, true);
      await store.appendFeedback(tenantId, {
        kind: "human",
        memoryId: id,
        userId,
        action: "edit",
        at: nowIso(),
      });
      return next;
    },

    async setPinned(id, pinned, userId) {
      const memory = await store.getMemory(id);
      if (memory === null) return null;
      if (pinned === (memory.trust === "pinned")) return memory;
      // Unpinning hands the memory back to a human's trust, whatever it was before: a person
      // vouched for it by pinning, and that does not un-happen.
      const next = await bump(memory, {
        trust: pinned ? "pinned" : "human",
        status: pinned ? "canon" : memory.status,
      });
      await store.appendFeedback(tenantId, {
        kind: "human",
        memoryId: id,
        userId,
        action: pinned ? "pin" : "unpin",
        at: nowIso(),
      });
      return next;
    },

    async retire(id, userId) {
      const memory = await store.getMemory(id);
      if (memory === null) return null;
      if (memory.status === "retired") return memory;
      const next = await bump(memory, { status: "retired" });
      await store.appendFeedback(tenantId, {
        kind: "human",
        memoryId: id,
        userId,
        action: "retire",
        at: nowIso(),
      });
      return next;
    },

    async listProposals(statuses, limit, sourceId) {
      return withChanges(await store.listProposals({ tenantId, statuses, limit, sourceId }));
    },

    async proposeAsHuman(input, userId, opts) {
      // Only what the person's API tokens propose is capped, and only those count toward it: an
      // agent on their token filling the quota never locks the person out of the app.
      // Approximate under concurrency: count, then insert, so parallel proposals can pass it.
      if (opts?.via === "token") {
        const waiting = await store.listProposals({
          tenantId,
          statuses: ["pending"],
          proposedBy: userId,
          proposedVia: "token",
          limit: MAX_PENDING_PER_PROPOSER,
        });
        if (waiting.length >= MAX_PENDING_PER_PROPOSER) {
          return {
            ok: false,
            tooMany: true,
            reason: `you already have ${MAX_PENDING_PER_PROPOSER} proposals made with an API ` +
              "token waiting in the inbox — wait for them to be accepted or rejected before " +
              "proposing more that way",
          };
        }
      }
      const origin: ProposalOrigin = opts?.via === "token"
        ? { kind: "human", userId, via: "token" }
        : { kind: "human", userId };
      return insertProposal(input.text, origin, {
        kind: input.kind,
        subject: input.subject,
        audience: input.audience,
        evidence: input.evidence ?? null,
        supersedes: null,
        basis: "observed",
      });
    },

    async acceptProposal(id, userId, edit) {
      const proposal = await store.getProposal(id);
      if (proposal === null || proposal.status !== "pending") return null;
      const edited = edit?.text === undefined ? proposal : { ...proposal, text: edit.text.trim() };
      if (edit?.text !== undefined) {
        const refused = refuseText(edit.text);
        if (refused !== null) throw new MemoryRefusedError(refused);
      }
      const memory = await promote(
        edited,
        {
          subject: edit?.subject ?? proposal.subject ?? await defaultSubjectFor(proposal),
          audience: edit?.audience ?? proposal.audience ?? EVERYONE,
          kind: edit?.kind ?? proposal.kind ?? "fact",
          // A person read it and said yes: that is a human's claim now, whoever proposed it.
          trust: "human",
        },
        undefined,
        true,
      );
      // Resolved under them — by the consolidator, or another person.
      if (memory === null) return null;
      await store.appendFeedback(tenantId, {
        kind: "human",
        memoryId: memory.id,
        userId,
        action: "accept",
        at: nowIso(),
      });
      return memory;
    },

    async rejectProposal(id, userId, reason) {
      const proposal = await store.getProposal(id);
      if (proposal === null || proposal.status !== "pending") return null;
      const rejected: Proposal = { ...proposal, status: "rejected", resolution: { reason } };
      if (!(await store.transitionProposal(id, "pending", rejected))) return null;
      diag.debug("memory.proposal_rejected", { proposalId: id, userId, reason });
      return { ...rejected, change: await changeOf(rejected) };
    },

    async consolidate(limit = CONSOLIDATE_BATCH) {
      const stats: ConsolidateStats = {
        screened: 0,
        promoted: 0,
        merged: 0,
        rejected: 0,
        held: 0,
        awaiting: 0,
        judged: 0,
        modelFailures: 0,
        swept: 0,
      };
      /** A resolution off `pending`, written only if nothing else resolved it first. */
      const resolve = async (next: Proposal): Promise<boolean> => {
        const done = await store.transitionProposal(next.id, "pending", next);
        if (!done) diag.debug("memory.proposal_resolved_elsewhere", { proposalId: next.id });
        return done;
      };
      /** A duplicate folded into the memory it duplicates: a confirmation of that memory. */
      const fold = async (proposal: Proposal, twin: Memory): Promise<void> => {
        if (
          !(await resolve({ ...proposal, status: "merged", resolution: { memoryId: twin.id } }))
        ) {
          return;
        }
        const at = nowIso();
        // The duplicate is the same claim seen again, at its own commit: a twin that carries
        // evidence takes the fresher observation whole — sha and paths from one reading of
        // the repository, never half of each.
        const anchored = twin.evidence === null || proposal.evidence === null ||
            proposal.evidence.sha === null || proposal.evidence.sha === twin.evidence.sha
          ? null
          : { sha: proposal.evidence.sha, paths: proposal.evidence.paths };
        await bump(twin, {
          lastConfirmedAt: at,
          status: "canon",
          ...(anchored === null ? {} : { evidence: anchored }),
        }, { confirmations: 1 });
        await store.appendFeedback(tenantId, {
          kind: "confirm",
          memoryId: twin.id,
          runId: proposal.origin.kind === "run" ? proposal.origin.runId : null,
          reanchoredTo: anchored?.sha ?? null,
          at,
        });
        stats.merged += 1;
      };

      // The inbox is read oldest first, and what this pass holds or leaves waiting stays
      // pending at its head — so the pass pages past those rather than re-reading the same
      // head every minute, up to a bounded number of pages.
      let skipped = 0;
      let acted = 0;
      let pages = 0;
      let exhausted = false;
      while (acted < limit && !exhausted) {
        if (pages >= MAX_CONSOLIDATE_PAGES) {
          diag.warn("memory.inbox_scan_bounded", { pages, skipped });
          break;
        }
        const page = await store.listProposals({
          tenantId,
          statuses: ["pending"],
          limit,
          offset: skipped,
        });
        pages += 1;
        exhausted = page.length < limit;
        for (const proposal of await withChanges(page)) {
          if (acted >= limit) break;
          stats.screened += 1;
          // 1. Screen. A secret is refused whatever else is true of it.
          if (isSecretShaped(proposal.text)) {
            acted += 1;
            if (
              await resolve({
                ...proposal,
                status: "rejected",
                resolution: { reason: "secret-shaped" },
                flags: [...new Set([...proposal.flags, "secret-shaped" as const])],
              })
            ) stats.rejected += 1;
            continue;
          }
          const kind = proposal.kind ?? "fact";
          // Instruction-shaped text, and any `preference` an agent proposed, wait for a person:
          // that is exactly what an injected README would try to persist. So does anything
          // proposed with an API token: a token in an agent's hands is not a person's say-so.
          if (
            proposal.flags.includes("instruction-shaped") ||
            (proposal.origin.kind === "human" && proposal.origin.via === "token") ||
            (kind === "preference" && proposal.origin.kind !== "human")
          ) {
            stats.held += 1;
            skipped += 1;
            continue;
          }
          // A claim the run's own change makes true waits for that change to land. Dropped, it
          // is rejected here too — the change report did it when it came, this is the pass
          // finding a straggler.
          if (proposal.change?.fate === "pending") {
            stats.awaiting += 1;
            skipped += 1;
            continue;
          }
          acted += 1;
          if (proposal.change?.fate === "dropped") {
            if (
              await resolve({
                ...proposal,
                status: "rejected",
                resolution: { reason: DROPPED_REASON },
              })
            ) stats.rejected += 1;
            continue;
          }
          const subject = proposal.subject ?? await defaultSubjectFor(proposal);
          const audience = proposal.audience ?? EVERYONE;
          // 2. Deduplicate. A near-duplicate of a live memory is a confirmation of it.
          const twin = await store.findByNormalizedText(
            tenantId,
            subject,
            normalizeClaim(proposal.text),
            audience,
          );
          if (twin !== null && twin.id !== proposal.supersedes) {
            await fold(proposal, twin);
            continue;
          }
          // 3–4. Contradict, tighten and classify — the model's call, applied under the same
          // rules as a human's accept. Without a model, or when the judgement fails, the claim
          // is promoted as proposed: the trivial consolidator this package shipped with.
          const runRepo = await defaultSubjectFor(proposal);
          const repoSubject = runRepo.kind === "repo"
            ? runRepo
            : subject.kind === "repo"
            ? subject
            : null;
          const verdict = await decide(proposal, subject, repoSubject !== null, stats);
          const trust = trustFor(proposal.origin);
          if (verdict === null) {
            if (await promote(proposal, { subject, audience, kind, trust })) stats.promoted += 1;
            continue;
          }
          if (verdict.kind === "noise") {
            if (
              await resolve({
                ...proposal,
                status: "rejected",
                resolution: { reason: `noise: ${verdict.reason || "not a durable claim"}` },
                flags: verdict.of === null
                  ? proposal.flags
                  : [...new Set([...proposal.flags, "contradicts" as const])],
              })
            ) stats.rejected += 1;
            continue;
          }
          if (verdict.kind === "duplicate") {
            const twin = await store.getMemory(verdict.of);
            if (twin !== null && twin.status !== "retired") {
              await fold(proposal, twin);
              continue;
            }
          }
          // supersedes, refines, new — and a duplicate of something since retired, which is new.
          const rewritten = verdict.kind === "duplicate"
            ? { text: proposal.text, memoryKind: kind, subject: subject.kind }
            : verdict;
          const refused = refuseText(rewritten.text);
          if (refused !== null) {
            // The model wrote something the door refuses — a credential it hallucinated back
            // in, most likely. The proposal's own text already passed: keep it.
            diag.warn("memory.rewrite_refused", { proposalId: proposal.id, reason: refused });
          }
          const text = refused === null ? rewritten.text.trim() : proposal.text;
          // The rewrite is screened like the proposal was: a model steered into writing an
          // instruction does not get it into canon on the strength of the claim it replaced.
          const rewriteFlags = screen(text).filter((f) => f !== "secret-shaped");
          if (rewriteFlags.includes("instruction-shaped")) {
            diag.warn("memory.rewrite_held", { proposalId: proposal.id });
            await resolve({
              ...proposal,
              text,
              flags: [...new Set([...proposal.flags, ...rewriteFlags])],
            });
            stats.held += 1;
            continue;
          }
          const finalKind = rewritten.memoryKind;
          // A claim the model reads as a preference is a human's to promote, like any other.
          if (finalKind === "preference" && proposal.origin.kind !== "human") {
            await resolve({ ...proposal, text, kind: "preference" });
            stats.held += 1;
            continue;
          }
          const finalSubject = subjectFrom(rewritten.subject, subject, repoSubject);
          const supersedes = verdict.kind === "supersedes" ? verdict.of : proposal.supersedes;
          const flags = verdict.kind === "supersedes"
            ? [...new Set([...proposal.flags, "contradicts" as const])]
            : proposal.flags;
          const memory = await promote(
            { ...proposal, text, supersedes, flags },
            { subject: finalSubject, audience, kind: finalKind, trust },
            verdict.kind === "refines" ? { memoryId: "", refines: verdict.of } : undefined,
          );
          if (memory !== null) stats.promoted += 1;
        }
      }
      // 6. Sweep the canon, on its own cadence.
      const nowMs = deps.now().getTime();
      if (lastSweepAt === null || nowMs - lastSweepAt >= SWEEP_INTERVAL_MS) {
        lastSweepAt = nowMs;
        stats.swept = await sweep();
      }
      if (stats.screened > 0 || stats.swept > 0) diag.debug("memory.consolidated", { ...stats });
      return stats;
    },

    async ingest(input, userId) {
      const kind = input.kind;
      let title = input.title?.trim() ?? "";
      let text = input.text ?? "";
      let locator: string | null = null;
      if (kind === "url" || kind === "repo-file") {
        const fetcher = deps.fetchers?.[kind];
        if (!fetcher) throw new MemoryRefusedError(`${kind} sources cannot be fetched here`);
        if (!input.locator?.trim()) throw new MemoryRefusedError("a locator is required");
        locator = input.locator.trim();
        try {
          const fetched = await fetcher.fetch(locator);
          text = fetched.text;
          if (title === "") title = fetched.title;
        } catch (err) {
          if (err instanceof FetchRefusedError) throw new MemoryRefusedError(err.message);
          throw err;
        }
      }
      text = text.replace(/\r\n?/g, "\n").trim();
      if (text === "") throw new MemoryRefusedError("the document is empty");
      if (title === "") throw new MemoryRefusedError("a title is required");
      if (isSecretShaped(text)) {
        throw new MemoryRefusedError(
          "the document looks like it carries a credential, which memory never stores",
        );
      }
      const contentHash = await deps.hash(text);
      const same = await store.findSourceByHash(tenantId, contentHash);
      if (same !== null && same.status === "failed") {
        // An extraction that failed (or a restart cut short) is not a record of the document:
        // it is withdrawn, batch and all, and the ingest starts over.
        diag.warn("memory.failed_source_replaced", { sourceId: same.id });
        await service.withdrawSource(same.id, userId);
      } else if (same !== null) {
        throw new MemoryRefusedError(`this exact document is already on record as ${same.id}`);
      }
      const previous = await store.findLatestSource(
        tenantId,
        locator === null ? { title } : { locator },
      );
      const at = nowIso();
      const source: Source = {
        id: deps.mintId("src"),
        tenantId,
        kind,
        status: "ingesting",
        extraction: null,
        failure: null,
        title,
        locator,
        contentHash,
        text,
        defaultSubject: input.subject,
        ingestedBy: userId,
        ingestedAt: at,
        supersedesSourceId: previous?.id ?? null,
      };
      await store.insertSource(source);
      diag.debug("memory.ingest_started", { sourceId: source.id, kind, title });
      const done = extract(source, input.subject, previous);
      inflight.add(done);
      done.finally(() => inflight.delete(done));
      return { source, done };
    },

    async drain() {
      await Promise.allSettled([...inflight]);
      // The embeddings get a short wait of their own, then are left to the caller closing the
      // embedder — what they would have saved, the next pod's backfill saves.
      await waitAtMost(
        Promise.allSettled([...embedWork]),
        deps.embedDrainWaitMs ?? EMBED_DRAIN_WAIT_MS,
      );
    },

    async recoverIngests() {
      let recovered = 0;
      for (const source of await store.listSources(tenantId, 500)) {
        if (source.status !== "ingesting") continue;
        await store.saveSource({
          ...source,
          status: "failed",
          failure: "the extraction was interrupted by a restart",
        });
        recovered += 1;
      }
      if (recovered > 0) diag.warn("memory.ingests_recovered", { recovered });
      return recovered;
    },

    listSources(limit) {
      return store.listSources(tenantId, limit);
    },

    async moveSource(id, subject, userId) {
      const source = await store.getSource(id);
      if (source === null || source.tenantId !== tenantId) return null;
      const outcome: MoveOutcome = { sourceId: id, subject, proposals: 0, memories: 0 };
      for (const proposal of await pendingFrom(id)) {
        await store.saveProposal({ ...proposal, subject });
        outcome.proposals += 1;
      }
      for (const memory of await store.listMemoriesForSource(id)) {
        if (memory.status === "retired") continue;
        await service.edit(memory.id, { subject }, userId);
        outcome.memories += 1;
      }
      await store.saveSource({ ...source, defaultSubject: subject });
      diag.debug("memory.source_moved", { ...outcome, userId });
      return outcome;
    },

    async withdrawSource(id, userId) {
      const source = await store.getSource(id);
      if (source === null || source.tenantId !== tenantId) return null;
      const outcome: WithdrawOutcome = { sourceId: id, rejected: 0, retired: 0, kept: 0 };
      for (const proposal of await pendingFrom(id)) {
        if (await service.rejectProposal(proposal.id, userId, "source withdrawn") !== null) {
          outcome.rejected += 1;
        }
      }
      for (const memory of await store.listMemoriesForSource(id)) {
        if (memory.status === "retired") continue;
        if (memory.trust === "pinned") {
          outcome.kept += 1;
          continue;
        }
        await service.retire(memory.id, userId);
        outcome.retired += 1;
      }
      await store.deleteSource(id);
      diag.debug("memory.source_withdrawn", { ...outcome, userId });
      return outcome;
    },

    async getSource(id) {
      const source = await store.getSource(id);
      if (source === null) return null;
      const [proposals, memories] = await Promise.all([
        store.listProposals({ tenantId, sourceId: id, limit: MAX_LIMIT }),
        store.listMemoriesForSource(id),
      ]);
      return {
        source,
        sections: splitSections(source.text),
        proposals: await withChanges(proposals),
        memories,
      };
    },

    async scopeOf(runId) {
      const run = await store.getRun(runId);
      return run === null ? null : {
        agentId: run.agentId,
        repos: run.repos,
        ...(run.agentOnly ? { agentOnly: true } : {}),
      };
    },

    async search(scope, args) {
      // The org, every repo, one named repo, or the org alone — never a subject outside the
      // scope. A repo hint that matches nothing narrows to nothing, which finds nothing.
      let subjects: Subject[];
      if (args.repo !== undefined && args.repo.trim() !== "") {
        const resolved = resolveSubjectHint(scope, "repo", args.repo);
        subjects = resolved.kind === "ok" ? [resolved.subject] : [];
      } else if (args.subject === "org") {
        subjects = [ORG];
      } else if (args.subject === "repo") {
        subjects = repoSubjectsOf(scope);
      } else {
        subjects = subjectsOf(scope);
      }
      const k = Math.min(MAX_SEARCH_K, Math.max(1, args.k ?? DEFAULT_SEARCH_K));
      return await store.listMemories({
        tenantId,
        subjects,
        audiences: audiencesOf(scope),
        kinds: args.kind === undefined ? undefined : [args.kind],
        statuses: liveStatuses,
        query: args.query,
        queryVector: await queryVectorFor(args.query),
        matchOnly: true,
        limit: k,
      });
    },

    async getInScope(scope, id) {
      const memory = await store.getMemory(id);
      if (memory === null || !inScope(scope, memory.subject, memory.audience)) return null;
      const detail = await detailOf(memory);
      // A human may move a linked memory to a different audience after supersession.
      // Checking the requested record alone must not expose its now-out-of-scope neighbours.
      for (const key of ["supersedes", "supersededBy"] as const) {
        const linked = detail[key];
        if (linked !== null && !inScope(scope, linked.subject, linked.audience)) detail[key] = null;
      }
      return detail;
    },

    async docInScope(scope, id, section) {
      // A source id names the document directly; a memory id names it through its pointer's
      // provenance — and the pointer must be in the run's scope, like any memory it reads.
      let sourceId: string | null = null;
      if (id.startsWith("src-")) {
        sourceId = id;
      } else {
        const memory = await store.getMemory(id);
        if (memory === null || !inScope(scope, memory.subject, memory.audience)) return null;
        if (memory.provenance.kind !== "source") return null;
        sourceId = memory.provenance.sourceId;
      }
      const source = await store.getSource(sourceId);
      if (source === null) return null;
      // A source is readable by a run that may read memories on its subject.
      if (!inScope(scope, source.defaultSubject, EVERYONE)) return null;
      return renderSource(source, section);
    },

    async propose(scope, runId, input) {
      if (scope.agentOnly && input.audience === "all") {
        return { ok: false, reason: "this run may propose memories only for its own agent" };
      }
      // An OBSERVED claim is about code as it already stands, so it can always name the commit
      // it was observed at — and it must. `promote` drops an evidence object whose sha is still
      // null, so a claim like this would be promoted to canon with `evidence: null`: no paths to
      // watch, permanently exempt from the staleness machinery, and nothing said anywhere. Only
      // an INTRODUCED claim may carry paths alone; its sha is stamped when it binds to a patch.
      if (
        input.basis === "observed" && input.evidence !== undefined &&
        input.evidence !== null && input.evidence.sha === null
      ) {
        return {
          ok: false,
          reason: "an observed claim's evidence must name the commit you observed it at",
        };
      }
      const resolved = resolveSubjectHint(scope, input.subject, input.repo);
      if (resolved.kind === "none") return { ok: false, reason: resolved.reason };
      return insertProposal(input.text, await runOrigin(runId), {
        kind: input.kind ?? null,
        subject: resolved.subject,
        audience: resolveAudienceHint(scope, input.audience),
        evidence: input.evidence ?? null,
        supersedes: null,
        basis: input.basis,
      });
    },

    async confirm(scope, runId, id) {
      const memory = await store.getMemory(id);
      if (memory === null || !inScope(scope, memory.subject, memory.audience)) return null;
      const at = nowIso();
      // A confirmation that answers this run's own staleness finding moves the claim's
      // evidence to the commit that run checked out. Without it the claim keeps its original
      // commit, every later run diffs from that same commit over the same changed paths, and
      // the doubt is raised again for good — a confirmation that clears the status and
      // nothing else. Re-anchored, the next run diffs from what was actually verified.
      const anchored = reanchor(memory, await staleHeadFor(memory, runId));
      const next = await bump(memory, {
        lastConfirmedAt: at,
        // A reconfirmed memory is canon again, whatever doubt had been cast on it.
        status: memory.status === "retired" ? "retired" : "canon",
        ...(anchored === null ? {} : { evidence: anchored }),
      }, { confirmations: 1 });
      await store.appendFeedback(tenantId, {
        kind: "confirm",
        memoryId: id,
        runId,
        reanchoredTo: anchored?.sha ?? null,
        at,
      });
      return next;
    },

    async refute(scope, runId, id, reason, replacement, basis = "observed") {
      const memory = await store.getMemory(id);
      if (memory === null || !inScope(scope, memory.subject, memory.audience)) return null;
      const at = nowIso();
      // The refutations since the memory was last confirmed, by which runs. One run's word
      // counts once: a second refute from the same run is noted and changes nothing, so a run
      // cannot retire a memory alone — that takes two runs, without a reconfirmation between.
      const doubters = await refutedSinceConfirmed(memory);
      if (doubters.has(runId)) {
        diag.debug("memory.refute_repeated", { memoryId: id, runId });
        return { memory, replacement: null };
      }
      let proposal: Proposal | null = null;
      if (replacement !== undefined && replacement.trim() !== "") {
        const outcome = await insertProposal(replacement, await runOrigin(runId), {
          kind: memory.kind,
          subject: memory.subject,
          audience: memory.audience,
          evidence: null,
          supersedes: memory.id,
          basis,
        });
        if (!outcome.ok) throw new MemoryRefusedError(`replacement: ${outcome.reason}`);
        proposal = outcome.proposal;
      }
      // Refuted by a second run without a reconfirmation in between: retired. Pinned memories
      // are a human's call and take the refutation as a signal, never as a verdict.
      const twice = doubters.size >= 1;
      const next = await bump(memory, {
        lastRefutedAt: at,
        status: memory.trust === "pinned" || memory.status === "retired"
          ? memory.status
          : twice
          ? "retired"
          : "needs-verification",
      }, { refutations: 1 });
      await store.appendFeedback(tenantId, {
        kind: "refute",
        memoryId: id,
        runId,
        reason,
        replacementProposalId: proposal?.id ?? null,
        at,
      });
      return { memory: next, replacement: proposal };
    },
  };
  return service;
}

/** A refusal the caller should show as the reason it is: bad text, never a store failure. */
export class MemoryRefusedError extends Error {
  override readonly name = "MemoryRefusedError";
}

/** The score, broken into its terms, for the UI. */
export function scoreOf(memory: Memory, now: Date) {
  return scoreMemory(memory, now);
}

export { sameSubject };

// The shared shapes of agent memory, as the core sees them.
//
// Invariants:
// - a memory is ONE atomic claim. The unit the agent reads is `text`, bounded, and everything
//   else on the row is what lets the platform rank it, retire it, and say where it came from.
// - subject and audience are separate axes: "generally useful about a repo" and "only for one
//   agent" are two audiences over the same subjects, never two scopes.
// - agents never write canon. They propose; the consolidator and humans promote. So every
//   status transition of a Memory is decided in the service, and a Proposal is append-only.
// - the feedback log is the firehose and the counters on a memory are derived from it; a
//   counter is a cache of the log, never the other way round.
// - every record carries a `tenantId` that holds ONE value today (TENANT_DEFAULT). It exists so
//   the multi-tenant pass the platform will need one day does not have to backfill the canon,
//   the inbox, the sources and the log. Nothing here is multi-tenant.

/** The one tenant every record belongs to until the platform learns what a tenant is. */
export const TENANT_DEFAULT = "default";

export type MemoryKind = "fact" | "procedure" | "gotcha" | "decision" | "preference" | "pointer";

export const MEMORY_KINDS: readonly MemoryKind[] = [
  "fact",
  "procedure",
  "gotcha",
  "decision",
  "preference",
  "pointer",
];

/** What a claim is about: the org as a whole, or one repository (canonical form, see subject.ts). */
export type Subject = { kind: "org" } | { kind: "repo"; url: string };

/**
 * Who a claim is for: every agent, or one. A tagged value rather than a nullable agent id so a
 * `team` arm can be added without a migration when agents are organised into teams.
 */
export type Audience = { kind: "all" } | { kind: "agent"; agentId: string };

export type MemoryStatus = "canon" | "needs-verification" | "retired";

export const MEMORY_STATUSES: readonly MemoryStatus[] = ["canon", "needs-verification", "retired"];

/**
 * How much a claim's origin is trusted before any signal arrives. `pinned` is a human saying
 * "always brief this"; `human` a human writing it; `ingested` a document a human handed over;
 * `agent` a run's own observation.
 */
export type Trust = "pinned" | "human" | "ingested" | "agent";

export const TRUSTS: readonly Trust[] = ["pinned", "human", "ingested", "agent"];

/** Where a memory came from: the run and proposal, the source document and section, or a person. */
export type Provenance =
  | { kind: "run"; runId: string; taskId: string; proposalId: string }
  | { kind: "source"; sourceId: string; section: string | null }
  | { kind: "human"; userId: string };

/** For repo claims: the commit and paths the claim is evidence for. Drives mechanical staleness. */
export interface Evidence {
  sha: string;
  paths: string[];
}

/**
 * A proposal's evidence, which may not have its commit yet: an `introduced` claim can name the
 * paths its change touches before that change is a patch anywhere, and the commit is stamped
 * on when the claim binds to one (see MemoryChange). A memory's evidence always has its sha —
 * a proposal promoted while still unstamped loses the evidence rather than carrying a hole.
 */
export interface ProposalEvidence {
  sha: string | null;
  paths: string[];
}

/** One row of the canon. One claim. */
export interface Memory {
  /** "mem-…", short enough to cite from a tool result. */
  id: string;
  tenantId: string;
  /** The claim, ≤ MAX_MEMORY_TEXT characters. */
  text: string;
  kind: MemoryKind;
  subject: Subject;
  audience: Audience;
  status: MemoryStatus;
  trust: Trust;
  provenance: Provenance;
  evidence: Evidence | null;
  /** The memory this one replaced. */
  supersedes: string | null;
  supersededBy: string | null;
  /** Explicit "I relied on this and it held" calls. */
  confirmations: number;
  /** Explicit "this was wrong" calls. */
  refutations: number;
  /** Runs this memory was briefed into. */
  briefedCount: number;
  /** Runs this memory was briefed into that succeeded without refuting it — the implicit signal. */
  briefedSuccesses: number;
  lastBriefedAt: string | null;
  lastConfirmedAt: string | null;
  lastRefutedAt: string | null;
  /** The claim's vector and the model that made it; null until embedded (or where no embedder
   * runs). Never in a tool result or a brief. */
  embedding: number[] | null;
  embeddingModel: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Where a proposal came from. */
export type ProposalOrigin =
  | { kind: "run"; runId: string; taskId: string }
  | { kind: "source"; sourceId: string; section: string | null }
  /** `via: "token"`: proposed with an API token, not a session — never auto-promoted. */
  | { kind: "human"; userId: string; via?: "token" };

export type ProposalStatus = "pending" | "merged" | "promoted" | "rejected";

/** How a proposal ended: the memory it became or was folded into (and, for a refinement, the
 * memory it refines), or why it was rejected. */
export type ProposalResolution =
  | { memoryId: string; refines?: string }
  | { reason: string };

/** What the screen noticed about a proposal. A flag never rejects by itself; it routes. */
export type ProposalFlag = "instruction-shaped" | "secret-shaped" | "contradicts";

/**
 * What a claim rests on. `observed`: the proposer found it already true of the repository or
 * the org. `introduced`: the proposer's own change is what makes it true — a run describing the
 * retry it just wrote, say — so it holds only once that change lands, and is dropped if the
 * change is. Asked of the agent as a fact about itself, never as a judgement about review: the
 * platform decides what "provisional" means. A person's and a document's claims are observed.
 */
export type Basis = "observed" | "introduced";

export const BASES: readonly Basis[] = ["observed", "introduced"];

/** One row of the inbox. Append-only apart from its resolution. */
export interface Proposal {
  id: string;
  tenantId: string;
  text: string;
  /** The proposer's hint; the consolidator decides. */
  kind: MemoryKind | null;
  /** Hint; defaults to the run's repo, else the org. */
  subject: Subject | null;
  /** Hint; defaults to every agent. */
  audience: Audience | null;
  evidence: ProposalEvidence | null;
  origin: ProposalOrigin;
  /** The memory this proposal was offered as a replacement for (a refutation's replacement). */
  supersedes: string | null;
  basis: Basis;
  /**
   * For a run's `introduced` claim: the patch it is bound to — the first patch the run opened
   * after the claim was made, or the run's last patch when the claim came after that one.
   * The claim holds once that patch, or one that carries its work (`MemoryChange.carries`),
   * lands. Null
   * while no patch has been opened since the claim, and for every claim that rests on
   * nothing a run changed.
   */
  changeId: string | null;
  status: ProposalStatus;
  resolution: ProposalResolution | null;
  flags: ProposalFlag[];
  createdAt: string;
}

export type SourceKind = "paste" | "upload" | "url" | "repo-file";

export const SOURCE_KINDS: readonly SourceKind[] = ["paste", "upload", "url", "repo-file"];

/**
 * A document a human ingested — an onboarding guide, a runbook, an architecture page. Kept
 * whole, chunked into sections for `doc`, and the origin of every claim the extractor drew from
 * it. Re-ingesting the same locator (or, for pasted text, the same title) supersedes the older
 * source: what the new extraction no longer says is retired, what it still says is confirmed.
 */
/** How the extraction of a source went: sections the model read, sections whose answer
 * failed, and memories of a superseded source retired because the new extraction no longer
 * says them. */
export interface IngestStats {
  sections: number;
  extracted: number;
  failed: number;
  retired: number;
  /** Sections past the extractor's bound, left unread: the pointer still says the document
   * is there, and `doc` serves every section. */
  skipped: number;
  modelBacked: boolean;
}

/** `ingesting` while the extractor works — the record and its text are already there, the
 * review batch is filling; `ready` once it has; `failed` with the reason when it could not. */
export type SourceStatus = "ingesting" | "ready" | "failed";

export interface Source {
  id: string;
  tenantId: string;
  kind: SourceKind;
  status: SourceStatus;
  /** The extraction's stats once it is done; null while ingesting. */
  extraction: IngestStats | null;
  /** Why it failed, when it did. */
  failure: string | null;
  title: string;
  /** The URL or `<repo>@<ref>:<path>` it was fetched from; null for pasted or uploaded text. */
  locator: string | null;
  /** SHA-256 of the text: the same document twice is one source. */
  contentHash: string;
  text: string;
  defaultSubject: Subject;
  ingestedBy: string;
  ingestedAt: string;
  supersedesSourceId: string | null;
}

/** A source's text in the bounded pieces `doc` serves and the extractor works on. */
export interface SourceSection {
  /** The heading path ("Deploy › Rollback"), or the section's ordinal for headingless text. */
  title: string;
  text: string;
}

export type RunOutcome = "success" | "failure" | "error" | "cancelled" | "lost";

/**
 * What became of one patch a run opened — the change every `introduced` claim bound to it
 * waits on. `pending` until the orchestrator says otherwise: `landed` when its pull request
 * merged, `dropped` when it was closed, rejected, superseded, or failed past retrying.
 * Settled once; a later report of the same patch is ignored.
 */
export type ChangeFate = "pending" | "landed" | "dropped";

export const CHANGE_FATES: readonly ChangeFate[] = ["pending", "landed", "dropped"];

/**
 * One patch a run opened, as memory tracks it: the change a claim binds to. A run may open
 * several — one per repo, and more than one per repo as it keeps working — so the row says
 * which repo, which generation of the run's branch, the patch's birth order within the run, and
 * which of the run's earlier patches it CARRIES: the runner found every commit of their own work
 * in this one, by content. A claim follows those edges, never a patch's place in the run.
 * `headSha` is what a bound claim's evidence is stamped with; `forgeUrl` arrives once the patch
 * is a pull request.
 */
export interface MemoryChange {
  /** The orchestrator's patch id — the row's key, and what a claim binds to. */
  patchId: string;
  runId: string;
  tenantId: string;
  /** The repo the patch is for, canonical. */
  repo: string;
  generation: number;
  /** Per run, 0-based, in birth order. */
  seq: number;
  headSha: string | null;
  forgeUrl: string | null;
  /** The patch ids of the run's earlier patches whose work this one carries in full. */
  carries: string[];
  fate: ChangeFate;
  createdAt: string;
  updatedAt: string;
}

/** One entry of the signal log. The canon's counters are derived from these. */
export type Feedback =
  /** `runId` null: the consolidator folding a duplicate of a non-run origin into this memory. */
  | {
    kind: "confirm";
    memoryId: string;
    runId: string | null;
    /** The commit this confirmation moved the memory's evidence to, when it answered a
     * staleness finding (or folded in a fresher observation); null when it moved nothing. */
    reanchoredTo: string | null;
    at: string;
  }
  | {
    kind: "refute";
    memoryId: string;
    runId: string;
    reason: string;
    replacementProposalId: string | null;
    at: string;
  }
  | {
    kind: "briefed";
    memoryId: string;
    runId: string;
    at: string;
    /** Absent on legacy events, when only canon could be briefed. */
    canonAtExposure?: boolean;
  }
  | { kind: "outcome"; runId: string; status: RunOutcome; at: string }
  | {
    kind: "stale";
    memoryId: string;
    runId: string;
    changedPaths: string[];
    /** The commit the runner diffed to — what a confirmation from this run re-anchors the
     * claim to. Null when the runner could not name it. */
    headSha: string | null;
    at: string;
  }
  /** The consolidator's sweep retiring a memory nothing has used: decayed past its kind's
   * horizon and not briefed within it. */
  | { kind: "sweep"; memoryId: string; reason: "decayed" | "source-superseded"; at: string }
  | {
    kind: "human";
    memoryId: string;
    userId: string;
    action: "pin" | "unpin" | "edit" | "retire" | "merge" | "create" | "accept" | "reject";
    at: string;
  };

/**
 * What a run was told, recorded at brief time — the mapping the data side uses to turn the run
 * id the gateway forwards into a scope, without trusting anything the agent says about itself.
 */
export interface MemoryRun {
  runId: string;
  /** The task the run belongs to — where a person finds the run. */
  taskId: string;
  tenantId: string;
  agentId: string;
  /** Frozen at brief time; absent on older runs means shared memory access. */
  agentOnly?: boolean;
  /** The run's repos, canonical, in checkout order; empty for a run with no repo subject. */
  repos: string[];
  /** The memory ids the brief carried, in brief order. */
  briefed: string[];
  /** How the run ended; null while it is going. The patches it opened are `MemoryChange` rows
   * of their own, and a claim waits on the one it is bound to. */
  outcome: RunOutcome | null;
  createdAt: string;
}

/** A briefed repo claim's evidence, carried so the runner can check it against the clone:
 * `git diff --name-only <sha>..HEAD -- <paths>` is the staleness test. */
export interface BriefEvidence {
  memoryId: string;
  /** The repo the claim is about, spelled as the brief request named it — the orchestrator
   * matches it against the task's own repo list to find the clone the check runs in. */
  repo: string;
  sha: string;
  paths: string[];
}

/** The brief as the orchestrator freezes it into a run's snapshot. */
export interface Brief {
  text: string;
  memoryIds: string[];
  /** One entry per briefed memory that carries evidence; the runner reports the stale ones. */
  evidence: BriefEvidence[];
}

/** What the runner found at clone time: a briefed memory whose evidence paths changed, and
 * the commit it was diffed to. */
export interface StaleReport {
  memoryId: string;
  changedPaths: string[];
  headSha: string | null;
}

/** The claim length bound: the unit an agent reads has to stay one claim. */
export const MAX_MEMORY_TEXT = 500;
/** The default brief budget, in (estimated) tokens. */
export const DEFAULT_BRIEF_BUDGET_TOKENS = 2_000;

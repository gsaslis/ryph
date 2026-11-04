// The ingest boundary — every JSON payload is parsed against a schema here before it may travel
// as a core type, same doctrine as the orchestrator's. The tool argument schemas double as the
// JSON Schema the MCP `tools/list` answers, derived rather than restated so the two cannot drift.

import { z } from "@zod/zod";
import { canonicalRepo } from "./core/subject.ts";
import type {
  Audience,
  Basis,
  Evidence,
  MemoryKind,
  ProposalEvidence,
  Subject,
} from "./core/types.ts";
import {
  BASES,
  MAX_MEMORY_TEXT,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  SOURCE_KINDS,
  type SourceKind,
  TRUSTS,
} from "./core/types.ts";

const MAX_LEN = 100_000;

export const MemoryKindSchema = z.enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]]);

export const BasisSchema = z.enum(BASES as [Basis, ...Basis[]]);

const BASIS_ASK = 'Whether this was already true when you found it ("observed") or your own ' +
  'change in this run is what makes it true ("introduced"). An introduced claim waits until ' +
  "that change lands, and is dropped if the change is; phrase it for a reader who sees it after " +
  "the change is in";
export const MemoryStatusSchema = z.enum(MEMORY_STATUSES as [string, ...string[]]);
export const TrustSchema = z.enum(TRUSTS as [string, ...string[]]);

/** One claim, bounded. Whitespace trimmed; the secret screen runs in the service. */
export const MemoryTextSchema = z.string().trim().min(1).max(MAX_MEMORY_TEXT);

/**
 * A repository as the orchestrator or a caller names it: a URL, a Radicle id, or a `local`
 * repository's absolute path (as long as the forge allows one, PATH_MAX). A URL or an id is
 * trimmed; a path is kept exactly as written, as `canonicalRepo` keeps it, because edge
 * whitespace is part of a directory's name — trimming it would fold `/srv/app ` into
 * `/srv/app`, two repositories into one subject.
 */
const repoLocator = z.string().max(4096)
  .transform((s) => s.startsWith("/") ? s : s.trim())
  .pipe(z.string().min(1));

export const SubjectSchema: z.ZodType<Subject, unknown> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("org") }),
  z.object({ kind: z.literal("repo"), url: repoLocator }),
]).transform((s) => s.kind === "org" ? s : { kind: "repo" as const, url: canonicalRepo(s.url) });

export const AudienceSchema: z.ZodType<Audience, unknown> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("agent"), agentId: z.string().trim().min(1).max(200) }),
]);

/** A path as git takes it after `--`: never one that reads as an option, never pathspec magic
 * (`:/` would match the whole repository). The runner's schema says the same; this is the door
 * the runner relies on. */
export const EvidencePathSchema = z.string().min(1).max(1024).refine(
  (p) => !p.startsWith("-") && !p.startsWith(":"),
  { error: "not a path" },
);

const commitSha = z.string().regex(/^[0-9a-f]{7,64}$/, { error: "not a commit sha" });

/**
 * A link that will be rendered as an anchor, so it may only ever navigate: http(s) and nothing
 * else. The memory page puts `change.forgeUrl` straight into an `href`, and a bare string would
 * let a `javascript:` value reach the DOM. Defence in depth — only the service-authed internal
 * surface writes this — but the door is the cheap place to hold it.
 */
const navigableUrl = z.string().trim().min(1).max(2048).refine(
  (u) => /^https?:\/\//i.test(u),
  { error: "must be an http(s) URL" },
);

export const EvidenceSchema = z.object({
  sha: commitSha,
  paths: z.array(EvidencePathSchema).min(1).max(50),
}) satisfies z.ZodType<Evidence, unknown>;

/** A proposal's evidence: the paths, and the commit when there is one yet. An `introduced`
 * claim's change is not a commit anywhere until the run submits it as a patch, and the sha is
 * stamped on when the claim binds to that patch. */
export const ProposalEvidenceSchema = z.object({
  sha: commitSha.nullable().default(null),
  paths: z.array(EvidencePathSchema).min(1).max(50),
}) satisfies z.ZodType<ProposalEvidence, unknown>;

// ── The management surface ─────────────────────────────────────────────────────────────────

/** What POST /v1/memories accepts: a memory written by hand, canon at once. */
export const CreateMemorySchema = z.object({
  text: MemoryTextSchema,
  kind: MemoryKindSchema,
  subject: SubjectSchema,
  audience: AudienceSchema.default({ kind: "all" }),
  evidence: EvidenceSchema.nullable().default(null),
  pinned: z.boolean().default(false),
});

/** What PATCH /v1/memories/:id accepts — any subset, at least one. */
export const UpdateMemorySchema = z.object({
  text: MemoryTextSchema.optional(),
  kind: MemoryKindSchema.optional(),
  subject: SubjectSchema.optional(),
  audience: AudienceSchema.optional(),
}).refine((p) => Object.values(p).some((v) => v !== undefined), {
  error: "nothing to update: provide text, kind, subject and/or audience",
});

/** What POST /v1/memory-proposals accepts: a human's proposal, into the inbox like any other. */
export const ProposeMemorySchema = z.object({
  text: MemoryTextSchema,
  kind: MemoryKindSchema.nullable().default(null),
  subject: SubjectSchema.nullable().default(null),
  audience: AudienceSchema.nullable().default(null),
  evidence: EvidenceSchema.nullable().default(null),
});

/** What POST /v1/memory-proposals/:id/accept accepts: optional edits applied on the way in. */
export const AcceptProposalSchema = z.object({
  text: MemoryTextSchema.optional(),
  kind: MemoryKindSchema.optional(),
  subject: SubjectSchema.optional(),
  audience: AudienceSchema.optional(),
});

export const RejectProposalSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
});

// ── The orchestrator's internal surface ────────────────────────────────────────────────────

/** What POST /internal/v1/runs/:id/brief accepts. The run id is the path parameter. */
export const ComposeBriefSchema = z.object({
  agentOnly: z.boolean().optional(),
  taskId: z.string().trim().min(1).max(200),
  agentId: z.string().trim().min(1).max(200),
  /** The run's repos as the user named them, in checkout order; empty for no repo subject. */
  repos: z.array(repoLocator).max(20),
  task: z.object({
    title: z.string().max(MAX_LEN),
    instructions: z.string().max(MAX_LEN),
  }),
  budgetTokens: z.number().int().min(0).max(1_000_000).optional(),
});

/** What POST /internal/v1/runs/:id/outcome accepts: how the run ended. Which changes it made
 * is a separate matter — every patch it opened was reported as one already. */
export const ReportOutcomeSchema = z.object({
  status: z.enum(["success", "failure", "error", "cancelled", "lost"]),
});

/** The orchestrator's id for a patch. */
const patchId = z.string().trim().min(1).max(200);
/** How many earlier patches one patch may name as carried: a run's patches of one repo, bounded
 * far above any run seen. */
const MAX_CARRIES = 500;

/** What POST /internal/v1/runs/:id/patches accepts: a patch the run opened, or that patch again
 * once it is a pull request — an upsert on the patch id. */
export const ReportPatchSchema = z.object({
  patchId,
  /** The repo the patch is for, as the brief request named it. */
  repo: repoLocator,
  generation: z.number().int().min(1).max(1_000_000),
  headSha: commitSha.nullable().default(null),
  forgeUrl: navigableUrl.nullable().default(null),
  /** The run's earlier patches whose work this one carries in full, by the runner's reading. */
  carries: z.array(patchId).max(MAX_CARRIES),
});

/** What POST /internal/v1/runs/:id/change accepts: what one of the run's patches came to. */
export const ReportChangeSchema = z.object({
  patchId,
  fate: z.enum(["landed", "dropped"]),
  /** The patch's carries again (see ReportPatchSchema): this report is the one retried. */
  carries: z.array(patchId).max(MAX_CARRIES),
});

/** What POST /internal/v1/runs/:id/stale accepts: the runner's staleness findings, relayed.
 * `headSha` is the commit the runner diffed to: what a confirmation from the same run
 * re-anchors the claim to. Nullable and defaulted — a report that cannot name it still
 * counts, and nothing is re-anchored. */
export const ReportStaleSchema = z.object({
  stale: z.array(z.object({
    memoryId: z.string().min(1).max(64),
    changedPaths: z.array(z.string().min(1).max(1024)).max(50),
    headSha: commitSha.nullable().default(null),
  })).max(200),
});

/** What POST /v1/memory/brief-preview accepts: a hypothetical run's scope and task. */
export const BriefPreviewSchema = z.object({
  agentOnly: z.boolean().optional(),
  agentId: z.string().trim().min(1).max(200),
  repos: z.array(repoLocator).max(20).default([]),
  task: z.object({
    title: z.string().max(MAX_LEN).default(""),
    instructions: z.string().max(MAX_LEN).default(""),
  }),
  budgetTokens: z.number().int().min(0).max(1_000_000).optional(),
});

/** What POST /v1/memory/sources accepts: a document by text (paste, upload) or by locator
 * (url, repo-file). Two megabytes of text is the ceiling either way. */
/** What POST /v1/memory/sources/:id/move takes: the subject the batch is really about. */
export const MoveSourceSchema = z.object({ subject: SubjectSchema });

export const IngestSourceSchema = z.object({
  kind: z.enum(SOURCE_KINDS as [SourceKind, ...SourceKind[]]),
  title: z.string().trim().max(300).optional(),
  text: z.string().max(2 * 1024 * 1024).optional(),
  locator: z.string().trim().min(1).max(2048).optional(),
  subject: SubjectSchema.default({ kind: "org" }),
}).refine(
  (i) =>
    (i.kind === "url" || i.kind === "repo-file") ? i.locator !== undefined : i.text !== undefined,
  {
    error: "paste and upload take text; url and repo-file take a locator",
  },
);

/** What POST /v1/memory-proposals/resolve accepts: a batch of accepts and rejects. */
export const ResolveProposalsSchema = z.object({
  accept: z.array(z.string().min(1).max(64)).max(200).default([]),
  reject: z.array(z.string().min(1).max(64)).max(200).default([]),
  reason: z.string().trim().min(1).max(2000).default("rejected in review"),
}).refine((b) => b.accept.length + b.reject.length > 0, { error: "nothing to resolve" });

// ── The tools, as the agent calls them ─────────────────────────────────────────────────────
//
// `subject` and `audience` are plain enums here: the agent can only NARROW within the scope
// the gateway's run id resolved to, never name a repo or another agent. `repo` picks one of
// the run's OWN repositories when it holds several — by the owner/name the checkout calls it —
// and is matched against the scope, never taken as a URL.

const repoHint = z.string().trim().min(1).max(2048).optional().describe(
  "Which of this run's repositories, when it holds several: its owner/name as your checkout " +
    "describes it (e.g. acme/api). Not needed with one repository",
);

export const SearchArgsSchema = z.object({
  query: z.string().min(1).max(2000).describe("What you are looking for, in plain words"),
  subject: z.enum(["org", "repo"]).optional().describe(
    "Only memories about the org, or only about this run's repositories. Default: both",
  ),
  repo: repoHint,
  kind: MemoryKindSchema.optional().describe("Only memories of this kind"),
  k: z.number().int().min(1).max(25).optional().describe("How many to return (default 8)"),
});

export const GetArgsSchema = z.object({
  id: z.string().min(1).max(64).describe("A memory id, as cited in a brief or a search result"),
});

export const ProposeArgsSchema = z.object({
  text: MemoryTextSchema.describe(
    `One durable claim, at most ${MAX_MEMORY_TEXT} characters: a fact about the repo, a ` +
      "procedure that worked, a gotcha that cost time, a decision and its reason",
  ),
  kind: MemoryKindSchema.optional().describe("Your best guess at the kind; it can be corrected"),
  subject: z.enum(["org", "repo"]).optional().describe(
    "Whether this is about the org or a repository. Default: this run's repository — with " +
      "several, name which with `repo`",
  ),
  repo: repoHint,
  audience: z.enum(["all", "agent"]).optional().describe(
    "Who this is for: every agent, or only you. Default: every agent",
  ),
  evidence: ProposalEvidenceSchema.optional().describe(
    "For repo claims: the paths the claim is evidence for, and the commit you observed it at, " +
      "so the memory can be flagged when those paths change. An introduced claim may name the " +
      "paths alone: the commit is filled in from the patch that carries your change",
  ),
  basis: BasisSchema.describe(BASIS_ASK),
});

export const DocArgsSchema = z.object({
  id: z.string().min(1).max(64).describe(
    "A pointer memory's id, or a document id (src-…) as cited in one",
  ),
  section: z.string().min(1).max(300).optional().describe(
    "One section by title, as the document lists them; default: the whole document, bounded",
  ),
});

export const ConfirmArgsSchema = z.object({
  id: z.string().min(1).max(64).describe("The memory you relied on"),
});

export const RefuteArgsSchema = z.object({
  id: z.string().min(1).max(64).describe("The memory that was wrong"),
  reason: z.string().trim().min(1).max(2000).describe("What you found instead, briefly"),
  replacement: MemoryTextSchema.optional().describe(
    "The claim that is true now, as one sentence. Strongly preferred: a refutation without a " +
      "replacement says only that something is suspect",
  ),
  basis: BasisSchema.optional().describe(`For the replacement: ${BASIS_ASK}. Required with one`),
}).refine((a) => a.replacement === undefined || a.basis !== undefined, {
  error: "a replacement needs a basis: observed or introduced",
  path: ["basis"],
});

/** The JSON Schema a tool's `inputSchema` advertises — derived from the zod above. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<
    string,
    unknown
  >;
  delete out.$schema;
  return out;
}

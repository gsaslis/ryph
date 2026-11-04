// The ingest boundary.
// Every payload that arrives as JSON — a user's task, a runner's heartbeat or result — is
// parsed against a schema here before it may travel as a core type.
//
// Invariants (shared with @ryph/runner's schema.ts, the other end of the wire):
// - nothing downstream ever sees an unchecked cast
// - each schema is pinned to its interface with `satisfies z.ZodType<...>`,
//   so a drift between the two is a compile error — core/types.ts stays the source of truth
// - zod never reaches src/core; the architecture guard keeps the core dependency-free
// - values that eventually ride an argv (refs, harness knobs) reject a leading '-' HERE,
//   even though the runner validates again — bad input dies at the first boundary it crosses
// - every string is length-bounded (MAX_LEN); an unbounded payload field is a memory-DoS vector

import { z } from "@zod/zod";
// A LEAF import, not the barrel: the barrel re-exports the gateway's data plane, its drizzle
// store and its db factory, and nothing tree-shakes it away — importing one zod union from it would
// embed the whole gateway in the control-plane image and the compiled binary.
import { AllowedToolsSchema } from "@ryph/mcp-gateway/tool-scope";
import type {
  AutomationTarget,
  ChatContext,
  ForgePolicy,
  Heartbeat,
  InboundAutomationEvent,
  InboundChatMention,
  InboundForgeEvent,
  MemoryPolicy,
  ModelPolicy,
  NetworkPolicy,
  RunLifetime,
  RunLimits,
  RunnerResult,
  SkillPolicy,
  ToolPolicy,
} from "./core/types.ts";
import { MAX_FORGE_CAP, MAX_MESSAGE_CHARS, THINKING_LEVELS } from "./core/types.ts";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "./core/attachments.ts";
import { IMAGE_REF, MAX_RESOLVE_REFS } from "./core/image_refs.ts";
import { hostRefusal, MAX_CEILING_HOSTS } from "./core/egress.ts";
import { RUN_LIMIT_BOUNDS } from "./core/run_limits.ts";
import { boundSignalText, SILENT_SIGNAL } from "./core/fire_signal.ts";
import { MAX_RESERVED_SLOTS } from "./core/reserved_capacity.ts";
import { SIZE_CLASS_NAME } from "./core/run_sizes.ts";
import { CHECK_NAME, MAX_CHECKS } from "./core/check_types.ts";
import {
  BACKGROUND_END_REASONS,
  clipText,
  JOB_ID,
  MAX_BACKGROUND_COMMAND_CHARS,
  MAX_BACKGROUND_CWD_CHARS,
  MAX_BACKGROUND_LABEL_CHARS,
  MAX_BACKGROUND_TAIL_CHARS,
  shownText,
} from "./core/background.ts";
import {
  MAX_LISTED_SKILLS,
  MAX_REPORTED_SKILL_DROPS,
  MAX_SKILL_DROP_DETAIL,
  MAX_SKILL_NAME,
  RESERVED_PREFIX,
  SKILL_NAME,
  type SkillDrop,
} from "./core/skills.ts";
import type {
  ChecksFile,
  ForgeChangeRequestState,
  ForgeThreadContext,
  ReportChecksOutcome,
  SkillsTree,
} from "./ports/forge.ts";
import {
  MAX_THREAD_ENTRY_ID,
  MAX_THREAD_IMAGE_MARKUP,
  MAX_THREAD_IMAGE_NAME,
  MAX_THREAD_IMAGE_OCCURRENCE,
} from "./ports/forge.ts";
import type { ChatContinuedThreadOutcome, ChatThreadOutcome } from "./ports/chat_access.ts";
import { isLineName, MAX_LINES_PER_REPO } from "@ryph/shared/lines";
import { isBranchRef, isGitRefName } from "@ryph/shared/refs";

const MAX_LEN = 100_000;

/** Body caps for routes carrying more than management JSON (MAX_JSON_BODY_BYTES): prompts and
 * reports. */
export const MAX_PROMPT_BODY_BYTES = 8 * 1024 * 1024;
/** 1000 hook paths of 4096 non-control characters, including three-byte UTF-8 names. */
export const MAX_PATCH_DECISION_BODY_BYTES = 16 * 1024 * 1024;

const nonEmpty = z.string().trim().min(1).max(MAX_LEN);

const singleLine = nonEmpty.refine((s) => !/[\r\n]/.test(s), {
  error: "must be a single line",
});

/** A full commit id, which is all a forge or a clone ever names: SHA-1 or SHA-256. */
const commitSha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, {
  error: "not a commit sha",
});

// The characters and patterns git always refuses — same pragmatic subset as the runner. The
// rule itself is `isGitRefName`, which the core also asks directly about names the forge hands over.
export const gitName = nonEmpty
  .refine((s) => !s.startsWith("-"), { error: "must not start with '-'" })
  .refine(isGitRefName, { error: "not a valid git ref name" });

/**
 * A base ref a checkout can actually be ANCHORED on: a bare branch name, or the
 * `refs/heads/<name>` spelling of one.
 *
 * `gitName` asks a different question — whether git would take the string as a ref NAME — and
 * `refs/tags/v1.0` passes it. Saved onto a workspace member that way, it is accepted here and
 * then makes every future task on that workspace unstartable: a run clones through the
 * gateway's cache, which serves a base as a local branch, and `normalizeBaseRef` refuses a tag
 * outright. The person who would meet that refusal is whoever launches a task days later, far
 * from the edit that caused it. It belongs on whoever typed the ref.
 */
const anchorableRef = gitName.refine(isBranchRef, {
  error: "must name a branch — a bare name or refs/heads/<name>, " +
    "not a tag or a pull request ref (pull/… is where pull request heads are kept)",
});

// A harness kind names a pre-baked agent-container image (and rides env-var suffixes and the
// WorkItem), so it stays a tight lowercase slug.
const harnessKind = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, {
    error: "must be a lowercase slug (letters, digits, '-')",
  });

/** Ids the orchestrator minted itself and hands back out (agent ids in task creation). */
const mintedId = singleLine.regex(/^[A-Za-z0-9._-]+$/, { error: "not a valid id" });

// A model id is provider-defined and opaque, but it eventually rides a harness argv
// (pi's --model), so a leading '-' is refused here like every other harness knob.
const modelName = z.string().trim().min(1).max(200)
  .refine((s) => !/[\r\n]/.test(s), { error: "must be a single line" })
  .refine((s) => !s.startsWith("-"), { error: "must not start with '-'" });

/** A thinking level, one of pi's own: it rides pi's argv as `--thinking`, and pi ignores a word
 * it does not know, so a typo would run at pi's default rather than fail. Whether the model
 * TAKES it is not asked: pi clamps a level a model does not take to the nearest it does. */
export const ThinkingLevelSchema = z.enum(THINKING_LEVELS);

const providerId = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, {
    error: "must be a lowercase slug (letters, digits, '-')",
  });

/**
 * An agent's model policy: which provider key it spends, on which models. The key id and
 * provider are cross-checked against the key registry in the handler (the schema cannot see
 * rows); the shape rules live here.
 */
export const ModelPolicySchema = z.object({
  providerKeyId: mintedId,
  provider: providerId,
  allowedModels: z.union([z.literal("*"), z.array(modelName).min(1).max(100)]),
  defaultModel: modelName.nullable().default(null),
  defaultThinking: ThinkingLevelSchema.nullable().default(null),
}).refine(
  (p) =>
    p.defaultModel === null || p.allowedModels === "*" ||
    p.allowedModels.includes(p.defaultModel),
  { error: "defaultModel must be one of allowedModels" },
) satisfies z.ZodType<ModelPolicy>;

export type ModelPolicyInput = z.infer<typeof ModelPolicySchema>;

/**
 * An agent's tool policy: which MCP servers, and which of each one's tools. The server ids are
 * cross-checked against the gateway's registry in the handler (exists, unarchived) and the
 * harness kind against the capability table; the shape rules live here. The allowlist grammar
 * is the gateway's own, imported rather than restated, so a policy this side accepts can never
 * be one the issuer refuses at boot.
 */
export const ToolPolicySchema = z.object({
  servers: z.array(z.object({
    serverId: mintedId,
    allowedTools: AllowedToolsSchema,
  })).min(1).max(32),
}).refine(
  (p) => new Set(p.servers.map((s) => s.serverId)).size === p.servers.length,
  { error: "a server may appear in the policy only once" },
) satisfies z.ZodType<ToolPolicy>;

/**
 * An agent's memory policy: how many tokens of brief each of its runs starts with. Zero is a
 * legitimate answer — the tools without the brief. The ceiling is generous on purpose; what a
 * budget costs is the agent's prompt, and that is the operator's call.
 */
export const MemoryPolicySchema = z.object({
  budgetTokens: z.number().int().min(0).max(100_000),
  agentOnly: z.boolean().optional(),
}) satisfies z.ZodType<MemoryPolicy>;

/**
 * One hostname an allowlist may name. The rule itself lives in core/egress.ts, where the proxy
 * token is minted from the same list — asked here rather than restated, so a host this boundary
 * accepts can never be one the expansion refuses.
 */
const egressHost = z.string().trim().min(1).max(253).superRefine((value, ctx) => {
  const refusal = hostRefusal(value);
  if (refusal !== null) ctx.addIssue({ code: "custom", message: refusal });
});

/**
 * An agent's network policy: which egress bundles and hosts its runs may reach. The bundle ids
 * are cross-checked against the DEPLOYMENT'S CEILING in the handler (the schema cannot see an
 * env var); the shape rules live here.
 *
 * Note what this cannot express, on purpose: widening. There is no "allow everything" spelling,
 * because the ceiling is the operator's and a blueprint any signed-in user can launch must not
 * be able to reach past it. Narrowing to nothing is two empty lists, which is a real answer.
 */
export const NetworkPolicySchema = z.object({
  bundles: z.array(
    z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,38}$/, { error: "not a bundle id" }),
  ).max(32).refine((ids) => new Set(ids).size === ids.length, {
    error: "a bundle may appear in the policy only once",
  }),
  hosts: z.array(egressHost).max(100).refine((hosts) => new Set(hosts).size === hosts.length, {
    error: "a host may appear in the policy only once",
  }),
}) satisfies z.ZodType<NetworkPolicy>;

/**
 * The deployment's own allowlist, as an admin sets it — the same two lists as an agent's policy
 * and a different meaning: this one is the ceiling rather than a narrowing of it, so it is
 * checked against the CATALOGUE and not against anything above it. Hosts are capped higher for
 * the same reason (core/egress.ts, MAX_CEILING_HOSTS).
 */
export const EgressAllowlistSchema = z.object({
  bundles: z.array(
    z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,38}$/, { error: "not a bundle id" }),
  ).max(32).refine((ids) => new Set(ids).size === ids.length, {
    error: "a bundle may appear in the allowlist only once",
  }),
  hosts: z.array(egressHost).max(MAX_CEILING_HOSTS).refine(
    (hosts) => new Set(hosts).size === hosts.length,
    { error: "a host may appear in the allowlist only once" },
  ),
});

/**
 * Slots per size class, as an admin saves them (http/capacity_api.ts). A full replace: a class
 * left out is 0. The names are checked against the configuration in the route, which is the only
 * place that knows them.
 */
export const ReservedCapacitySchema = z.object({
  slots: z.record(
    z.string().regex(SIZE_CLASS_NAME, { error: "not a size class name" }),
    z.number().int().min(0).max(MAX_RESERVED_SLOTS),
  ),
});

/**
 * One refusal, as the egress proxy reports it (http/egress_api.ts).
 *
 * The host is a CONNECT authority and is pinned to that charset here, at the first boundary it
 * crosses — letters, digits, dot, dash, underscore, and no wildcard, because this is a name
 * something actually asked for and not an allowlist entry. That is what lets the wording built
 * from it (core/egress.ts) go into a run's event, a build's card and an agent's inbox message
 * without a fence: there is no newline in it and no marker to forge.
 */
export const EgressRefusalReportSchema = z.object({
  host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9._-]+$/, {
    error: "not a hostname a CONNECT line could have carried",
  }),
  port: z.number().int().min(1).max(65535),
});

/** A per-run cap on a forge write: required, bounded, never "unlimited". */
const forgeCap = z.number().int().min(1).max(MAX_FORGE_CAP);
const forgeWhere = z.enum(["origin", "any"]);

/**
 * A forge label as the policy names it — GitHub's own ceiling is 50 characters, and a label
 * rides a JSON body only, but a newline in one is never a label anybody made.
 */
const forgeLabel = z.string().trim().min(1).max(50).refine((s) => !/[\r\n]/.test(s), {
  error: "must be a single line",
});

/**
 * An agent's forge policy. The connected repo ids are cross-checked against live rows in the
 * handler (exist, unarchived) and the harness against the capability table; the shape rules
 * live here. A policy granting nothing at all is refused: null is how an agent has no forge tools.
 */
export const ForgePolicySchema = z.object({
  repos: z.union([
    z.literal("run"),
    z.object({
      connectedRepoIds: z.array(mintedId).min(1).max(20).refine(
        (ids) => new Set(ids).size === ids.length,
        { error: "a repo may appear in the list only once" },
      ),
    }),
  ]),
  read: z.boolean(),
  createIssues: z.object({ max: forgeCap }).nullable(),
  comment: z.object({ where: forgeWhere, max: forgeCap }).nullable(),
  review: z.object({ where: forgeWhere, max: forgeCap }).nullable(),
  closeIssues: z.object({ where: forgeWhere, max: forgeCap }).nullable(),
  labels: z.array(forgeLabel).max(50).refine(
    (labels) => new Set(labels.map((l) => l.toLowerCase())).size === labels.length,
    { error: "a label may appear in the list only once" },
  ),
}).refine(
  (p) =>
    p.read || p.createIssues !== null || p.comment !== null || p.review !== null ||
    p.closeIssues !== null || p.labels.length > 0,
  { error: "a forge policy must grant at least one capability — clear it to grant none" },
) satisfies z.ZodType<ForgePolicy>;

/** What POST /v1/forge/tool-grants/resolve accepts: the run the gateway said is calling. */
export const ForgeToolGrantResolveSchema = z.object({
  runId: mintedId,
});

/** A thread's address as its forge spells it: "12" on GitHub, a collaborative-object id on
 * Radicle. Text, and bounded to what may ride an API path segment. */
const forgeThreadRef = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/, {
  error: "not a thread reference",
});

/** What POST /v1/forge/tool-actions accepts: one write the forge is about to make. */
export const ForgeToolActionReserveSchema = z.object({
  runId: mintedId,
  tool: z.enum(["create_issue", "add_comment", "add_labels", "submit_review", "close_issue"]),
  connectedRepoId: mintedId,
  threadRef: forgeThreadRef.nullable(),
});

/** What POST /v1/forge/tool-actions/:id accepts: how the write it reserved ended. */
export const ForgeToolActionCompleteSchema = z.discriminatedUnion("outcome", [
  z.object({
    runId: mintedId,
    outcome: z.literal("done"),
    // "" is a real answer, not a missing field: a Radicle deployment with no explorer
    // configured has no web address for what was written, and the ref IS the address there.
    // The row keeps null for it rather than an empty string that renders as a broken link.
    url: z.union([z.url().max(2_000), z.literal("")]),
    createdThreadRef: forgeThreadRef.nullable(),
  }),
  z.object({
    runId: mintedId,
    outcome: z.literal("failed"),
    detail: z.string().max(2_000),
  }),
]);

/** The command address: slug-shaped and short, because it is typed by hand into issue
 * comments (`/ryph ada …`) and mistyped handles should fail loudly, not creatively. */
const agentHandle = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,38}$/, {
  error: "a handle is 1-39 chars of a-z, 0-9 and '-', starting alphanumeric",
});

/**
 * A run's limits as a caller may state them. A wall clock under a minute ends a run before its
 * container boots; more than 64 calls in flight is more than any harness opens. Null is "the
 * tier above's value".
 */
export const RunLimitsSchema = z.object({
  wallClockMs: z.number().int().min(RUN_LIMIT_BOUNDS.wallClockMs.min).nullable(),
  spendUsd: z.number().positive().finite().nullable(),
  callsInFlight: z.number().int().min(RUN_LIMIT_BOUNDS.callsInFlight.min).max(
    RUN_LIMIT_BOUNDS.callsInFlight.max,
  ).nullable(),
}) satisfies z.ZodType<RunLimits>;

const skillName = z.string().max(MAX_SKILL_NAME).regex(SKILL_NAME, {
  error: "a skill name is lowercase letters, digits and single hyphens",
});

/** Up to `max` skill names, each once. */
const skillNames = (max: number) =>
  z.array(skillName).max(max).refine((names) => new Set(names).size === names.length, {
    error: "a skill may appear in the list only once",
  });

/** Catalogue skill names: what the catalogue holds is checked by the handler. */
const catalogueNames = skillNames(64).refine(
  (names) => names.every((n) => n.startsWith(RESERVED_PREFIX)),
  { error: `catalogue skills are named ${RESERVED_PREFIX}*` },
);

/**
 * An agent's skill policy: switches that turn off what the deployment allows, never on. Lists
 * name what is off, so a skill added later reaches the agent without an edit. Catalogue names
 * are checked against the catalogue by the handler; org names are not, since the repo moves on
 * its own schedule and turning off a skill before it lands, or after it is gone, is harmless.
 */
export const SkillPolicySchema = z.object({
  catalogue: z.object({ disabled: catalogueNames }),
  org: z.object({
    enabled: z.boolean(),
    disabled: skillNames(256).refine(
      (names) => names.every((n) => !n.startsWith(RESERVED_PREFIX)),
      { error: `${RESERVED_PREFIX}* names belong to the catalogue` },
    ),
  }),
  workingRepos: z.object({ enabled: z.boolean() }),
}) satisfies z.ZodType<SkillPolicy>;

/** What PUT /v1/skills/settings accepts: the admin's switches. */
export const SkillSettingsSchema = z.object({
  disabledCatalogue: catalogueNames,
  workingRepoSkills: z.boolean(),
});

/** What PUT /v1/skills/org-repo accepts: a connected repo, and the branch to read (null: the
 * repo's default). The branch is held to the rule a workspace member's base already is. */
export const OrgSkillsRepoSchema = z.object({
  connectedRepoId: mintedId,
  branch: anchorableRef.nullable(),
});

/** What POST /v1/agents accepts. The blueprint: identity, prompt, and which image runs it. */
export const CreateAgentSchema = z.object({
  name: singleLine,
  handle: agentHandle.optional(),
  email: z.email(),
  systemPrompt: z.string().max(MAX_LEN).optional(),
  harnessKind,
  modelPolicy: ModelPolicySchema.optional(),
  toolPolicy: ToolPolicySchema.optional(),
  /** Absent: the default policy — an agent remembers unless told not to. `null`: memory off. */
  memoryPolicy: MemoryPolicySchema.nullable().optional(),
  /** Absent or `null`: no forge tools. */
  forgePolicy: ForgePolicySchema.nullable().optional(),
  /** Absent or `null`: whatever the deployment allows. Narrowing is a policy with fewer
   * bundles; two empty lists is an agent with no internet at all. */
  networkPolicy: NetworkPolicySchema.nullable().optional(),
  /** Absent or `null`: the operator's ceiling. Set, each field lowers it for this agent's runs. */
  limitPolicy: RunLimitsSchema.nullable().optional(),
  /** Absent or `null`: every skill the deployment allows. */
  skillPolicy: SkillPolicySchema.nullable().optional(),
  /** Absent: true. False: the agent's runs never open patches. */
  canOpenPatches: z.boolean().optional(),
  /** Absent: false. True: the agent's runs may publish artifacts every member can open. Asking
   * for it (here, or moving it false → true on an edit) needs `agents:policy`. */
  canPublishArtifacts: z.boolean().optional(),
  /** Absent: false. True: the agent's runs get a browser where the deployment can give one.
   * Asking for it (here, or moving it false → true on an edit) needs `agents:policy`. */
  browserEnabled: z.boolean().optional(),
});

/** What PATCH /v1/agents/:id accepts — any subset; `systemPrompt: null`, `modelPolicy: null`,
 * `toolPolicy: null`, `memoryPolicy: null`, `forgePolicy: null` and `skillPolicy: null` clear
 * their fields.
 * `networkPolicy: null` clears it to the deployment's ceiling — the one field whose null
 * WIDENS, which is why both directions take an admin where the others gate only the set. */
export const UpdateAgentSchema = z.object({
  name: singleLine.optional(),
  handle: agentHandle.optional(),
  email: z.email().optional(),
  systemPrompt: z.string().max(MAX_LEN).nullable().optional(),
  harnessKind: harnessKind.optional(),
  modelPolicy: ModelPolicySchema.nullable().optional(),
  toolPolicy: ToolPolicySchema.nullable().optional(),
  memoryPolicy: MemoryPolicySchema.nullable().optional(),
  forgePolicy: ForgePolicySchema.nullable().optional(),
  networkPolicy: NetworkPolicySchema.nullable().optional(),
  limitPolicy: RunLimitsSchema.nullable().optional(),
  skillPolicy: SkillPolicySchema.nullable().optional(),
  canOpenPatches: z.boolean().optional(),
  canPublishArtifacts: z.boolean().optional(),
  browserEnabled: z.boolean().optional(),
});

export type UpdateAgentRequest = z.infer<typeof UpdateAgentSchema>;

/**
 * A directory name under the checkout root — the runner's own rule, repeated at the first
 * boundary a caller can put one through: an RFC 1035 label, like a service name.
 */
export const repoPath = z.string().trim().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, {
  error: "must be a DNS label (a-z, 0-9 and '-', at most 63 chars)",
});

/** A repo's one-line description for the agent: what it is. Bounded; a paragraph at most. */
const repoDescription = z.string().trim().max(2_000);

/** An idle clock: at least a minute (below that a run ends before a person can answer it),
 * at most a day (a forgotten run should not hold live credentials longer). */
const idleMs = z.number().int().min(60_000).max(24 * 60 * 60_000);

/** How long a run lives past the agent's settles (core/types.ts RunLifetime). */
export const RunLifetimeSchema = z.object({
  idleMs,
  attendedIdleMs: idleMs,
}) satisfies z.ZodType<RunLifetime>;

/** What POST /v1/runs/:id/messages accepts: text and images, and nothing that could be work.
 * The images are attachments already uploaded to this run (POST /v1/runs/:id/attachments), by
 * id, in the order the text refers to them; each may be sent once. Text may be empty only when
 * there are images — core/inbox.ts holds that rule, for every producer. */
export const PostMessageSchema = z.object({
  text: z.string().trim().max(MAX_MESSAGE_CHARS).default(""),
  attachmentIds: z.array(mintedId).max(MAX_ATTACHMENTS).default([]),
});

/** What POST /v1/tasks accepts: a spec, assigned to an agent, against exactly one of a
 * connected repo (with an optional ref, defaulting to the repo's default branch) or a workspace
 * (its saved list, at its saved refs). Ids, tokens, the branch
 * name, and the whole harness side are minted/resolved here, never taken.
 *
 * Both halves of the spec are optional: no title, and one is made
 * from the instructions; no instructions, and the task starts awaiting its prompt — the first
 * message to its run. A title without instructions is refused: the title is null exactly while
 * the task awaits. */
export const CreateTaskSchema = z.object({
  agentId: mintedId,
  spec: z.object({ title: singleLine.optional(), instructions: nonEmpty.optional() })
    .refine((spec) => spec.title === undefined || spec.instructions !== undefined, {
      error: "a title goes with instructions; a task awaiting its prompt has none",
    })
    .default({}),
  connectedRepoId: mintedId.optional(),
  workspaceId: mintedId.optional(),
  /** Only with connectedRepoId: the base ref; absent falls back to the default branch. A branch:
   * a pull request's head (`refs/pull/42/head`) is someone else's code, which only the door
   * that knows it is one — `targetChangeRequest`, a `/ryph` command — checks out. */
  ref: anchorableRef.optional(),
  /** Pick one of the agent's allowed models for this run; absent falls back to the policy default. */
  model: modelName.optional(),
  /** Pick how hard the model thinks for this run; absent falls back to the policy default. */
  thinking: ThinkingLevelSchema.optional(),
  /** The change request the task works on — its repo's entry checks out that change request's
   * head branch and the commits are pushed onto it. The repo must be the connected repo, or a
   * member of the workspace; the head branch is looked up live, never taken from the caller. */
  targetChangeRequest: z.object({
    connectedRepoId: mintedId,
    thread: forgeThreadRef,
  }).optional(),
  /** The run's idle clocks; absent is the defaults (core/types.ts DEFAULT_IDLE_MS). */
  lifetime: RunLifetimeSchema.optional(),
  /** This run's limits, each at most the agent's effective value; absent fields fall through. */
  limits: RunLimitsSchema.partial().optional(),
  /** The task this one re-runs: the images that task started with are copied onto the new run,
   * so the `[image N]` markers its instructions carry still name them. Read under the caller's
   * own read scope; a task the caller cannot read is no such task. */
  rerunOf: mintedId.optional(),
}).refine(
  (t) => [t.connectedRepoId, t.workspaceId].filter((source) => source !== undefined).length === 1,
  { error: "exactly one of connectedRepoId or workspaceId is required" },
).refine((t) => t.ref === undefined || t.connectedRepoId !== undefined, {
  error: "ref goes with connectedRepoId; a workspace carries its own",
}).refine(
  (t) =>
    t.targetChangeRequest === undefined || t.connectedRepoId === undefined ||
    t.targetChangeRequest.connectedRepoId === t.connectedRepoId,
  { error: "targetChangeRequest.connectedRepoId must be the task's connected repo" },
).refine((t) => t.targetChangeRequest === undefined || t.ref === undefined, {
  error: "a task on a change request checks out its head branch; ref cannot also be given",
});

export type CreateTaskRequest = z.infer<typeof CreateTaskSchema>;

/**
 * "Set up this repo's environment": only WHO does it. The task's title, instructions, checkout
 * and lifetime are the platform's (core/environment_setup.ts), never the caller's.
 */
export const EnvironmentSetupSchema = z.object({
  agentId: mintedId,
  /** One of the agent's allowed models for this run; absent falls back to the policy default. */
  model: modelName.optional(),
  /** How hard the model thinks for this run; absent falls back to the policy default. */
  thinking: ThinkingLevelSchema.optional(),
});

/** GitHub's numeric installation id, as text — it rides URLs and API calls, never math. */
const installationId = z.string().trim().regex(/^\d{1,20}$/, {
  error: "not a GitHub installation id",
});

/** Which forge a repo lives on. Any of them can be connected; what differs is what the connect
 * body has to carry, which the per-provider schemas below are the gate for. */
const forgeProvider = z.enum(["github", "gitlab", "radicle", "local"]);

/** The forges that send events. A `local` repository has no threads, comments or pushes for a
 * forge to report, so an event naming one is drift worth refusing rather than a repo to match. */
const eventProvider = z.enum(["github", "gitlab", "radicle"]);

/**
 * How each forge spells a repo's address — the one place every spelling lives, and the check
 * the two `owner/name` regexes were replaced by.
 *
 * GitHub: "owner/name", each half a real segment, so the value can never walk an API path it
 * is interpolated into. GitLab: `path_with_namespace`, nested — `group/sub/…/project`, 2 to 20
 * segments of the same characters, at most 255 (the forge's own rule, restated). Radicle: a `rad:` RID, which is `z` plus base58btc. Local: the
 * repository's absolute REAL path as the forge resolved it — no empty segment, no trailing
 * slash, no control character, no whitespace at either end, at most PATH_MAX, and (below) no
 * `.` or `..` segment — the canonical spelling, so one repository has exactly one address.
 *
 * The local rule is the forge's `isLocalRepoRef` (@ryph/forge core/local_repo.ts), restated
 * rather than imported because the control plane does not depend on the forge's code. They
 * must agree exactly: a ref the forge stores and this refuses is a repo nobody can connect, and
 * one this accepts and the forge refuses is a row every forge call then fails on. Control
 * characters go (a tab or an escape in a path is a terminal and log hazard wherever the path
 * is printed), and edge whitespace goes rather than being trimmed, because `/srv/app ` is a
 * real directory's name and trimming it would name a different one.
 */
const REPO_REF_PATTERNS: Record<z.infer<typeof forgeProvider>, RegExp> = {
  github: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  gitlab: /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,19}$/,
  radicle: /^rad:z[1-9A-HJ-NP-Za-km-z]+$/,
  // oxlint-disable-next-line no-control-regex
  local: /^(\/[^/\x00-\x1f\x7f]+)+(?<!\s)$/u,
};

/** The longest local repoRef — the forge's `LOCAL_REPO_REF_MAX`, PATH_MAX on Linux. */
const LOCAL_REPO_REF_MAX = 4_096;

/** Whether `ref` is an address the named forge could have produced. */
export function isRepoRef(provider: z.infer<typeof forgeProvider>, ref: string): boolean {
  if (provider === "local" && ref.length > LOCAL_REPO_REF_MAX) return false;
  if (provider !== "local" && ref.length > (provider === "gitlab" ? 255 : 200)) return false;
  if (!REPO_REF_PATTERNS[provider].test(ref)) return false;
  // "." and ".." are real path segments to an HTTP client and to a filesystem, and both
  // spellings admit them — a repo reference must never be able to walk the path it lands in.
  if (
    (provider === "github" || provider === "gitlab" || provider === "local") &&
    ref.split("/").some((seg) => seg === "." || seg === "..")
  ) {
    return false;
  }
  return true;
}

const repoRef = z.string().trim().min(1).max(255);

const submissionPolicy = z.enum(["require-approval", "auto"]);

/** What POST /v1/installations accepts: the id GitHub's install redirect carried. Everything
 * else about the installation is asked of the forge, never taken from the caller. */
export const RegisterInstallationSchema = z.object({
  installationId,
});

/**
 * A repository on the forge's disk, as the caller typed it. Deliberately loose beyond bounds:
 * the forge is what reads the path, so the forge is what decides whether it is absolute,
 * allowed, a repository — and answers with the canonical address that is stored. A second
 * copy of those rules here could only disagree with it. Control characters are refused
 * because nothing that carries one is a path anybody meant. NOT trimmed: `/srv/app ` is a real
 * directory's name, and trimming it would ask the forge about a different one — the forge
 * answers the path as typed, and refuses one whose real path the wire could not carry.
 */
// oxlint-disable-next-line no-control-regex
const localPath = z.string().min(1).max(4_096).regex(/^[^\x00-\x1f\x7f]+$/, {
  error: "not a path",
});

/**
 * What POST /v1/connected-repos accepts. The repo's URL and default branch are never the
 * caller's: on GitHub they come from the installation's own listing, on Radicle from the
 * repository's signed identity document, on a local forge from the forge's own reading of the
 * path. The caller picks which repo and under which policy.
 *
 * `installationId` is GitHub's and only GitHub's — Radicle has no tenants at all, so a Radicle
 * body carries none and one sent anyway is refused rather than quietly stored. Whether a GitHub
 * body carries one is the forge's mode: required iff it acts as an App, refused when it acts
 * through a user token — checked by the handler, which is where the mode is known. A local body
 * names a `path`, not a `repoRef`: the address is whatever the forge canonicalises it to, and a
 * `repoRef` or `url` sent beside it is stripped, never stored.
 */
const ConnectForgeRepoSchema = z.object({
  provider: z.enum(["github", "gitlab", "radicle"]),
  installationId: installationId.optional(),
  repoRef,
  submissionPolicy: submissionPolicy.default("require-approval"),
}).refine((r) => isRepoRef(r.provider, r.repoRef), {
  error: "not a repo address this forge could have produced",
  path: ["repoRef"],
}).refine((r) => r.provider === "github" || r.installationId === undefined, {
  error: "only a GitHub repo is connected through an installation",
  path: ["installationId"],
});

const ConnectLocalRepoSchema = z.object({
  provider: z.literal("local"),
  path: localPath,
  submissionPolicy: submissionPolicy.default("require-approval"),
});

export const ConnectRepoSchema = z.preprocess(
  // A body without a provider is a GitHub one, as it always was.
  (v) =>
    typeof v === "object" && v !== null && !Array.isArray(v) && !("provider" in v)
      ? { ...v, provider: "github" }
      : v,
  z.discriminatedUnion("provider", [ConnectForgeRepoSchema, ConnectLocalRepoSchema]),
);

/** A size class name, or null for the deployment default. Checked against the configured
 * classes by the handler; the shape here is only core/run_sizes.ts's slug. */
const sizeClass = z.string().regex(SIZE_CLASS_NAME, "a size class name").nullable();

/** What PATCH /v1/connected-repos/:id accepts: any of the three, at least one. */
export const UpdateConnectedRepoSchema = z.object({
  submissionPolicy: submissionPolicy.optional(),
  sizeClass: sizeClass.optional(),
  allowForkPushes: z.boolean().optional(),
}).refine(
  (body) =>
    body.submissionPolicy !== undefined || body.sizeClass !== undefined ||
    body.allowForkPushes !== undefined,
  "nothing to change: send submissionPolicy, sizeClass or allowForkPushes",
);

/** What POST /v1/workspaces accepts: a name and, optionally, what the grouping is for. */
export const CreateWorkspaceSchema = z.object({
  name: singleLine.max(200),
  description: repoDescription.optional(),
});

/** What PATCH /v1/workspaces/:id accepts; `description: null` clears it. */
export const UpdateWorkspaceSchema = z.object({
  name: singleLine.max(200).optional(),
  description: repoDescription.nullable().optional(),
  /** Admin only; `null` returns the workspace to the deployment default. */
  sizeClass: sizeClass.optional(),
  /** Admin only: the member whose `.ryph/Dockerfile` defines the workspace's machine. `null`
   * returns it to the default, the first member. */
  environmentRepoId: mintedId.nullable().optional(),
});

/** What POST /v1/workspaces/:id/repos accepts: a connected repo, and how it is checked out.
 * `path` defaults to the repo's name in slug form; `ref` to its default branch. */
export const AddWorkspaceRepoSchema = z.object({
  connectedRepoId: mintedId,
  ref: anchorableRef.nullable().optional(),
  path: repoPath.optional(),
  description: repoDescription.nullable().optional(),
});

/** What PATCH /v1/workspaces/:id/repos/:connectedRepoId accepts. */
export const UpdateWorkspaceRepoSchema = z.object({
  ref: anchorableRef.nullable().optional(),
  path: repoPath.optional(),
  description: repoDescription.nullable().optional(),
});

/** What POST /v1/connected-repos/:id/command-allowlist accepts: one identity, on the repo's own
 * forge, an admin is letting command agents there. */
export const RepoCommandAllowlistSchema = z.object({
  subject: singleLine.max(200),
});

const PhaseSchema = z.enum([
  "booting",
  "cloning",
  "preparing",
  "setting-up",
  "running",
  "finalizing",
]);

/** What POST /v1/runs/:id/heartbeat accepts. */
export const HeartbeatSchema = z.object({
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  phase: PhaseSchema,
  message: z.string().max(MAX_LEN).optional(),
  // A real instant, not a string: `planSweep` compares `Date.parse(...)`, and NaN makes every
  // comparison false — so a runner beating with "soon" used to disable the idle backstop
  // outright. The VALUE is bounded in applyHeartbeat, which knows the run's frozen lifetime.
  idleDeadlineAt: z.iso.datetime().nullable().optional(),
  idleState: z.enum(["idle", "waiting-for-user"]).nullable().optional(),
  // Null clears what an earlier beat said: a message reached the agent since.
  declaredOutcome: z.enum(["in-progress", "success", "no-changes", "failed"]).nullable().optional(),
  finished: z.literal(true).optional(),
}) satisfies z.ZodType<Heartbeat>;

/** What POST /v1/runs/:id/memory/stale accepts: the runner's staleness findings. `headSha` is
 * the commit the runner diffed to, which memory re-anchors the claim to if this run confirms
 * it; nullable and defaulted so a runner that predates the field still reports its findings. */
export const StaleMemoriesSchema = z.object({
  stale: z.array(z.object({
    memoryId: z.string().min(1).max(64),
    changedPaths: z.array(z.string().min(1).max(1024)).max(50),
    headSha: z.string().regex(/^[0-9a-f]{7,64}$/, { error: "not a commit sha" }).nullable()
      .default(null),
  })).max(200),
});

/** What POST /v1/runs/:id/base/stale accepts: the repos whose base the forge served from its
 * cache because every refresh from upstream since `since` has failed.
 * `commit` is what the clone checked out; `path` names the repo in the run's own checkout,
 * whose ref the run already knows. A path the run was never given is dropped at the route. */
export const StaleBasesSchema = z.object({
  bases: z.array(z.object({
    path: repoPath,
    commit: commitSha,
    since: z.iso.datetime(),
  })).min(1).max(64),
});

/** What POST /v1/runs/:id/setup/failed accepts: the repos whose setup did not finish, which the
 * run went on without — a step that failed (`step` is the runner's clipped label, `output` the
 * end of what it printed, `discarded` whether its tracked and untracked changes were discarded), or a
 * setup.yml that was invalid (`error`, no step ran), or changes in a repo whose own setup did not
 * fail, discarded because a step failed in the repos `after` names, or changes a repo's own
 * setup left when no step failed, discarded too (`files`, the changed files). Repo-authored text:
 * taken up to a generous bound — the runner clips its own far below it — then clipped, cleaned
 * and bounded again at the route (core/setup_warnings.ts). An entry past that bound, like one
 * that is not a warning at all, is dropped (null) rather than refusing the whole report, which
 * would lose every other repo's warning. A path the run was never given is dropped at the
 * route. */
const SETUP_TEXT_MAX = 16_384;
/** One file a `dirty` warning names: the runner clips each to 200 characters, so this bound
 * only keeps a report from carrying 64 × 64 long strings. */
const SETUP_FILE_MAX = 512;
export const SetupFailuresSchema = z.object({
  failures: z.array(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("step"),
        path: repoPath,
        step: z.string().min(1).max(SETUP_TEXT_MAX),
        index: z.number().int().min(1).max(1000),
        total: z.number().int().min(1).max(1000),
        code: z.number().int().min(0).max(1_000_000),
        output: z.string().max(SETUP_TEXT_MAX),
        discarded: z.boolean(),
      }),
      z.object({
        kind: z.literal("invalid"),
        path: repoPath,
        error: z.string().min(1).max(SETUP_TEXT_MAX),
      }),
      z.object({
        kind: z.literal("discarded"),
        path: repoPath,
        after: z.array(repoPath).min(1).max(64),
      }),
      z.object({
        kind: z.literal("dirty"),
        path: repoPath,
        files: z.array(z.string().max(SETUP_FILE_MAX)).max(64),
      }),
    ]).nullable().catch(null),
  ).min(1).max(64),
});

const skillSource = z.enum(["catalogue", "org", "repo"]);

/**
 * One skill the runner could not give the agent, read into core/skills.ts's `SkillDrop`: a repo
 * skill names its repo's path and nothing else does, and a collision names the source that holds
 * the name. Refused otherwise, so the trail never words a drop it cannot place.
 */
const SkillDropSchema = z.object({
  source: skillSource,
  path: repoPath.optional(),
  name: skillName,
  reason: z.enum(["collision", "cap", "reserved", "invalid", "unavailable"]),
  winner: skillSource.optional(),
  detail: singleLine.max(MAX_SKILL_DROP_DETAIL).optional(),
}).transform((d, ctx): SkillDrop => {
  const origin = d.source === "repo"
    ? d.path === undefined ? null : { source: d.source, path: d.path }
    : d.path === undefined
    ? { source: d.source }
    : null;
  const why = d.reason === "collision"
    ? d.winner === undefined ? null : { reason: d.reason, winner: d.winner }
    : d.winner === undefined
    ? { reason: d.reason }
    : null;
  if (origin === null || why === null) {
    ctx.issues.push({
      code: "custom",
      input: d,
      message: origin === null
        ? "a repo skill names its repo's path, and only a repo skill does"
        : "a collision names the source that holds the name, and only a collision does",
    });
    return z.NEVER;
  }
  return {
    name: d.name,
    ...(d.detail === undefined ? {} : { detail: d.detail }),
    ...origin,
    ...why,
  };
});

/**
 * What POST /v1/runs/:id/skills/report accepts: the working-repo skills the runner loaded, and
 * the skills it could not give the agent. Bounded, and held to what the run was given at the
 * route: a repo path the run never had, or a frozen skill it was never given, is dropped there.
 */
export const RunnerSkillsReportSchema = z.object({
  // Where the runner wrote the run's skills: an absolute path whose last segment is the
  // `ryph-skills-` directory it made.
  root: z.string().max(1024)
    // oxlint-disable-next-line no-control-regex
    .regex(/^(?:\/[^/\x00-\x1f]+)*\/ryph-skills-[^/\x00-\x1f]+$/, {
      error: "not a skills directory",
    })
    .refine((p) => !p.split("/").some((s) => s === "." || s === ".."), {
      error: "not a skills directory",
    })
    .nullable(),
  loaded: z.array(z.object({ path: repoPath, name: skillName })).max(MAX_LISTED_SKILLS),
  dropped: z.array(SkillDropSchema).max(MAX_REPORTED_SKILL_DROPS),
});

const BranchOutcomeSchema = z.object({
  connectedRepoId: mintedId,
  path: repoPath,
  name: gitName,
  headSha: singleLine,
  baseSha: singleLine.max(64).optional(),
  commits: z.array(z.object({ sha: singleLine, subject: singleLine.or(z.literal("")) }))
    .max(10_000),
  // The line of the run's work the branch ships (@ryph/shared/lines); patch birth holds it to the
  // line the branch's own name parses to.
  line: z.string().refine(isLineName, { error: "not a line name" }),
  generation: z.number().int().min(1).max(10_000),
  // The earlier heads of the line's branch whose work this one carries in full, every one each
  // time, newest first.
  carries: z.array(singleLine.max(64)).max(500),
});

/** What POST /v1/runs/:id/patches accepts: one branch the runner just shipped, the base it was
 * cut from, and the agent's own words for the pull request when it gave them. */
export const RunnerPatchSchema = z.object({
  // Finalization salvages work the agent did not explicitly submit.
  requiresApproval: z.boolean().optional(),
  branch: BranchOutcomeSchema,
  baseSha: singleLine.max(64),
  title: singleLine.max(500).optional(),
  description: z.string().max(MAX_LEN).optional(),
});

/**
 * What POST /v1/runs/:id/artifacts accepts: the document the agent wrote, its title, and the
 * artifact it is a new version of. The title's and the document's limits are the core's
 * (core/artifacts.ts), checked there so the agent reads them in its own words; these bounds only
 * keep what is parsed finite.
 */
export const RunnerArtifactSchema = z.object({
  title: z.string().max(10_000),
  html: z.string(),
  artifactId: z.string().min(1).max(64).optional(),
});

/**
 * What the image-ref resolves accept (`POST /v1/runs/:id/runner/images/resolve` and the forge's
 * and chat's `/v1/{forge,chat}/runs/:runId/images/resolve`): the refs a body names.
 */
export const ImageRefsResolveSchema = z.object({
  refs: z.array(z.string().regex(IMAGE_REF, { error: "not an image ref" }))
    .min(1).max(MAX_RESOLVE_REFS),
});

/**
 * What POST /v1/runs/:id/checks accepts: a commit the runner just uploaded through forge intake
 * as a check candidate — the checkout directory it came from, the branch the bundle carried and
 * the base it was cut from. The bundle's key is derived from these, never taken from here.
 */
export const RunnerChecksSchema = z.object({
  path: repoPath,
  headSha: commitSha,
  branch: gitName.max(255),
  baseSha: commitSha,
  /** Only these checks; absent or empty, all of them. */
  checks: z.array(z.string().regex(CHECK_NAME, { error: "not a check name" }))
    .max(MAX_CHECKS).optional(),
});

// A run's background commands, as its runner records them (core/background.ts). Every field is
// the agent's to influence, so each is bounded here; the free text is clipped rather than refused
// (an honest label that ran long still lands) and shaped for storage again in the core. A label, a
// command and a cwd are shown to people, so control and bidi characters are taken out first
// (`shownText`): the agent holds the run token and can write these itself. Times are ISO, as
// every runner route has them.
const clippedText = (max: number) =>
  z.string().max(MAX_LEN).transform((text) => clipText(shownText(text), max));

/** `PUT /v1/runs/:id/runner/background/:jobId`. `id`, when sent, must be the path's job. */
export const RunnerBackgroundStartSchema = z.object({
  id: z.string().regex(JOB_ID).optional(),
  label: clippedText(MAX_BACKGROUND_LABEL_CHARS)
    .refine((text) => text.trim() !== "", { error: "nothing to show" }),
  command: clippedText(MAX_BACKGROUND_COMMAND_CHARS),
  cwd: clippedText(MAX_BACKGROUND_CWD_CHARS),
  service: z.boolean(),
  startedAt: z.iso.datetime({ offset: true }),
  timeoutAt: z.iso.datetime({ offset: true }).nullable().default(null),
});

/** `POST /v1/runs/:id/runner/background/:jobId/exit`. */
export const RunnerBackgroundEndSchema = z.object({
  endedAt: z.iso.datetime({ offset: true }),
  reason: z.enum(BACKGROUND_END_REASONS),
  exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable().default(null),
  signal: z.string().regex(/^SIG[A-Z0-9]{1,12}$/).nullable().default(null),
  logBytes: z.number().int().min(0).max(2_147_483_647).default(0),
  logTruncated: z.boolean().default(false),
  /** Cleaned and cut to its last lines in the core; bounded here only against a huge body. */
  logTail: z.string().max(4 * MAX_BACKGROUND_TAIL_CHARS).nullable().default(null),
});

/**
 * A branch as a local ask names one (its own, or the base): bare, or `refs/heads/<name>`, which
 * is taken as the bare name. Any other `refs/` spelling, and `HEAD`, name no branch the forge
 * can read a head of, so they are refused here rather than as an outage there. Null: refused.
 */
export function localBranchName(raw: string): string | null {
  const name = raw.trim().replace(/^refs\/heads\//, "");
  if (name.length > 255 || !isGitRefName(name)) return null;
  if (name.startsWith("refs/") || name === "HEAD") return null;
  return name;
}

const localBranch = z.string().max(300).transform((raw, ctx) => {
  const name = localBranchName(raw);
  if (name === null) {
    ctx.addIssue({
      code: "custom",
      message: "a branch name, bare or refs/heads/<name>; not another ref, and not HEAD",
    });
    return z.NEVER;
  }
  return name;
});

/**
 * What POST /v1/check-suites accepts: a person's ask from their own machine for the checks on a
 * commit they pushed. `repo` is a connected repo's id or its address on its forge (`owner/name`,
 * a `rad:` RID); `base` is the branch whose checks judge, the repo's default when absent.
 */
export const LocalChecksSchema = z.object({
  repo: nonEmpty.max(512),
  commit: commitSha,
  /** Bare once parsed. */
  branch: localBranch,
  base: localBranch.optional(),
  /** Only these checks; absent or empty, all of them. */
  checks: z.array(z.string().regex(CHECK_NAME, { error: "not a check name" }))
    .max(MAX_CHECKS).optional(),
});

/** Sender-scoped identity, stable across retries and distinct for independent run requests. */
export const CheckDelegationIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);

/** Receiver-owned checks: only source coordinates and names, never config or images. */
export const CheckDelegationSchema = LocalChecksSchema.extend({
  delegationId: CheckDelegationIdSchema,
  /** The sender's own ask was a run's or a person's, so a failed suite it joins retries its
   * failures; absent, it only reads the answer, as a patch's or a push's ask does. */
  retryFailed: z.boolean().optional(),
}).strict();

/**
 * What POST /v1/runs/:id/target accepts: the checkout directory whose repo moves, and the change
 * request it moves onto — the forge's own address for the thread (a pull request number on
 * GitHub, a patch id on Radicle), never a URL.
 *
 * Shorter and stricter than `forgeThreadRef`: this one rides a git fetch and a push at the other
 * end, so a leading '-' (which the thread-ref rule allows) would be an option to some subprocess
 * between here and the forge.
 */
export const RunnerTargetSchema = z.object({
  path: repoPath,
  changeRequest: forgeThreadRef.max(128).refine((s) => !s.startsWith("-"), {
    error: "must not start with '-'",
  }),
});

/** One outcome per line of each repo, each line once — the runner's own rule, checked again
 * here. At most the line cap per repo, of at most 20 repos. */
const BranchOutcomesSchema = z.array(BranchOutcomeSchema).max(20 * MAX_LINES_PER_REPO).refine(
  (branches) => new Set(branches.map((b) => `${b.path}\0${b.line}`)).size === branches.length,
  { error: "a line of a repo ships at most one branch" },
);

const StatusCommentSchema = z.enum(["full", "minimal"]);

/** What POST /v1/runs/:id/result accepts — the runner's ReportedResult, verbatim. A success
 * shipped its branches — none when the agent declared the task needed no code changes; every
 * other status carries whatever had already shipped. */
export const RunnerResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    branches: BranchOutcomesSchema,
    summary: z.string().max(MAX_LEN),
    statusComment: StatusCommentSchema.optional(),
  }),
  z.object({
    status: z.literal("cancelled"),
    branches: BranchOutcomesSchema,
    summary: z.string().max(MAX_LEN),
    statusComment: StatusCommentSchema.optional(),
  }),
  z.object({
    status: z.literal("failure"),
    reason: z.string().max(MAX_LEN),
    summary: z.string().max(MAX_LEN),
    branches: BranchOutcomesSchema,
    statusComment: StatusCommentSchema.optional(),
  }),
  z.object({
    status: z.literal("error"),
    reason: z.string().max(MAX_LEN),
    during: PhaseSchema,
    branches: BranchOutcomesSchema,
  }),
]) satisfies z.ZodType<RunnerResult>;

/** What POST /v1/forge/gitlab/hooks/admit takes: the project and token generation the forge's
 * mailroom verified a GitLab webhook delivery for, as the URL spelled them, and — from the
 * consumer, never the door — which kind of delivery it is, to record its arrival. */
export const GitlabHookAdmitSchema = z.strictObject({
  projectId: z.string().regex(/^\d{1,20}$/),
  generation: z.string().regex(/^\d{1,10}$/),
  heard: z.enum(["merge_request", "other"]).optional(),
});

/** What POST /v1/forge/gitlab/hooks/dropped takes: how many deliveries the forge's door dropped
 * over one of a project's budgets (`lane`: comments, or every other event) at a generation since
 * it last said — a flood is reported in batches, never once per delivery. */
export const GitlabHookDroppedSchema = z.strictObject({
  projectId: z.string().regex(/^\d{1,20}$/),
  generation: z.string().regex(/^\d{1,10}$/),
  lane: z.enum(["comments", "other"]),
  count: z.number().int().min(1).max(1_000_000_000),
});

/** What POST /v1/forge/git-keys/resolve accepts: the credential a gateway client presented,
 * verbatim. Deliberately shapeless beyond bounds — the token is compared by hash, and telling
 * a probing caller *why* a credential is malformed would only help the probe. */
export const GitKeyResolveSchema = z.object({
  token: z.string().min(1).max(4_096),
});

/**
 * A normalized forge event, as the forge boundary POSTs it to /v1/forge/events. Strict:
 * unlike a raw GitHub payload (trimmed at the forge), this shape is OUR wire contract, and
 * an unknown key on it is a version drift worth refusing loudly.
 */
/**
 * Deliberately NOT strict, unlike every user-facing schema here. The sender is the forge, behind
 * a service token, and the two deploy separately — a forge one version ahead adds a field, and a
 * strict schema would answer 400, which the event sink reads as "this can never be accepted" and
 * drops the command for good. Unknown keys are stripped instead, so a version skew degrades to
 * ignoring what this orchestrator does not understand yet.
 */
export const ForgeEventSchema = z.object({
  deliveryId: z.string().trim().min(1).max(200),
  kind: z.string().trim().min(1).max(100),
  // `provider` and `repoRef` are what a connected repo is matched on; `url` rides along for
  // the log. A DID is longer than a GitHub login, so the actor's bound is the address bound.
  // `forgeId` is GitLab's numeric project id — the key a GitLab event is matched on.
  repo: z.object({
    provider: eventProvider,
    repoRef,
    url: z.string().trim().min(1).max(2_000),
    forgeId: z.string().regex(/^\d{1,20}$/).optional(),
  }),
  actorLogin: z.string().trim().min(1).max(200),
  // The forge's stable account id for the actor — the key a person is resolved by.
  actorId: z.string().regex(/^\d{1,20}$/).optional(),
  thread: z.object({
    kind: z.enum(["issue", "change_request"]),
    ref: forgeThreadRef,
  }).nullable(),
  // GitHub caps a comment at 65536 characters; anything longer is not a real comment.
  body: z.string().max(65_536).nullable(),
  // A GitHub comment id is a number; a Radicle one is the adapter's opaque handle, which
  // carries the thread because a comment there is only reachable through the object it hangs
  // on. Bounded to what may ride a URL path either way, and never `..`.
  sourceCommentId: forgeThreadRef.nullable(),
  inline: z.object({ commentId: forgeThreadRef }).optional(),
  // A branch name ends up in a connected repo's row and in a fetch, so it is held to the same
  // rule a user's own ref is; the commit to a full id, which is all a forge ever sends.
  branch: z.object({
    ref: gitName.max(255),
    commit: commitSha,
  }).optional(),
  // Set only on a `check_run.rerequested`. Bounded, never trusted: `externalId` must still name
  // a suite on this repo and commit before anything re-runs.
  checkRun: z.object({
    externalId: z.string().max(200),
    headSha: commitSha,
    name: z.string().max(200),
  }).optional(),
  // Set only on a `check_suite.rerequested`: the commit, and nothing that names a suite.
  checkSuite: z.object({ headSha: commitSha }).optional(),
  // Set only on a `change_request.merged`: the branch it merged into, and what merged. The
  // branch is bounded here and nothing more: a name the ref rules refuse must not cost the merge
  // itself (a 400 drops the event for good, and the patch would never settle). The control
  // plane holds it to the checkout rules where it is used (core/landing.ts), and a name that
  // fails them falls back to an inferred one. The heads are full commit ids, empty when the forge
  // named none: the forge's read of the change request is then asked what merged
  // (core/merge_settle.ts).
  merged: z.object({
    baseRef: nonEmpty.optional(),
    heads: z.array(commitSha).max(20),
  }).optional(),
  // Set only on a `change_request.pushed`. `ref` is held to the thread ref's rule, the branch
  // names to a ref name's, the URL to http(s) (it becomes a link in the app; a self-managed
  // GitLab may serve plain http, which RYPH_GITLAB_URL allows), the author to the actor's
  // bound; whether the author and the actor may make this deployment run the head is still
  // asked live.
  changeRequest: z.object({
    ref: forgeThreadRef,
    headSha: commitSha,
    baseRef: gitName.max(255),
    // As the forge grant holds it: a ref under `refs/`, never a tag.
    fetchRef: gitName.max(255).regex(/^refs\/(?!tags\/)/, { error: "a ref under refs/" })
      .nullable(),
    url: z.string().trim().max(2_000).regex(/^https?:\/\/[^\s]+$/, {
      error: "an http(s) URL",
    }).nullable(),
    author: z.string().trim().min(1).max(200),
    // The author's stable account id (GitLab's): what the gate asks about there.
    authorId: z.string().regex(/^\d{1,20}$/).optional(),
    before: commitSha.nullable(),
  }).optional(),
  receivedAt: singleLine.max(64),
}) satisfies z.ZodType<InboundForgeEvent>;

/**
 * The body an approve or retry may carry: the basis its diff was read against, compared with the
 * patch's as it stands (http/user_api.ts `unmovedBasis`). Null: the diff could not be measured.
 */
export const PatchDecisionSchema = z.strictObject({
  diffBasis: z.strictObject({
    mode: z.enum(["live", "record"]),
    targetRef: z.string().min(1).max(300),
    sincePatchId: z.string().min(1).max(64).nullable(),
    baseSha: commitSha,
  }).nullable().optional(),
  /**
   * The git hook files the approver was SHOWN for a `local` patch. An approval covers only the
   * hook files both shown and known to the server (http/user_api.ts approve) — the page may have
   * rendered before the check landed, or before it changed.
   */
  hookPaths: z.array(
    // oxlint-disable-next-line no-control-regex
    z.string().min(1).max(4_096).regex(/^[^\x00-\x1f\x7f]+$/, { error: "not a path" }),
  ).max(1_000).optional(),
});

export type PatchDecision = z.infer<typeof PatchDecisionSchema>;

/** A repo-relative path the forge names in a hook answer: shown to a person and to the agent,
 * so one line, bounded — anything else is not an answer this reads. The repository's root is
 * spelled `"."` (a `core.hooksPath` of the root itself); an empty string names nothing. */
// oxlint-disable-next-line no-control-regex
const hookPath = z.string().min(1).max(4_096).regex(/^[^\x00-\x1f\x7f]+$/);

/** What the forge's POST /v1/service/local/patch-hooks answers with a 200, and what a submission
 * it held for unapproved hook files carries beside `code: "needs_approval"` on its 409. Bounded
 * as the forge bounds it: `touched` at most 50, `more` past that. */
export const PatchHooksAnswerSchema = z.object({
  touched: z.array(hookPath).max(50),
  hooksPaths: z.array(hookPath).max(50),
  more: z.boolean(),
});

/** What the forge's POST /v1/service/patch-diff answers with a 200: bounded as the forge bounds
 * it (its MAX_PATCH_DIFF_BYTES, MAX_OMITTED); a UTF-16 length never exceeds the UTF-8 one. */
export const PatchDiffAnswerSchema = z.object({
  diff: z.string().max(4 * 1024 * 1024),
  baseSha: commitSha,
  headSha: commitSha,
  truncated: z.boolean(),
  omitted: z.array(z.string().max(4_096)).max(5_000),
  moreOmitted: z.boolean(),
});

/**
 * What the forge's POST /v1/service/checks-file answers with a 200: three of `ChecksFile`'s four
 * arms (`unavailable` is a 502, and so is anything this does not parse). Non-strict, as
 * `ForgeEventSchema` is, so a forge a version ahead degrades rather than reads as unavailable.
 */
export const ChecksFileAnswerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    text: z.string().max(65_536),
    path: z.enum([".ryph/checks.yml", ".ryph/checks.yaml"]),
    commit: commitSha,
    blob: commitSha,
    ryphTree: commitSha.nullable(),
    dockerfile: z.boolean(),
    services: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("file"), text: z.string().max(65_536) }),
      z.object({ kind: z.literal("absent") }),
      z.object({ kind: z.literal("invalid"), detail: z.string().max(2_000) }),
    ]),
  }),
  z.object({ kind: z.literal("absent"), commit: commitSha }),
  z.object({ kind: z.literal("invalid"), commit: commitSha, detail: z.string().max(2_000) }),
]) satisfies z.ZodType<Exclude<ChecksFile, { kind: "unavailable" }>>;

/**
 * The most blob bytes a skills tree the forge serves may sum to (the forge's
 * `MAX_SKILLS_TREE_BYTES`, restated: the packages share no source). A file holds at most all of
 * them, as base64.
 */
const MAX_SKILLS_TREE_BYTES = 8 * 1024 * 1024;
const MAX_SKILLS_FILE_BASE64 = 4 * Math.ceil(MAX_SKILLS_TREE_BYTES / 3);

/** The bytes a base64 string decodes to. Counted, not decoded: the forge encodes each file on its
 * own, so the tree is bounded by what the files hold, not by their encodings' padded total. */
function base64Bytes(text: string): number {
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return Math.floor((text.length * 3) / 4) - padding;
}

/**
 * What the forge's POST /v1/service/skills-tree answers with a 200: `SkillsTree`'s answered arms
 * (`missing-ref` is a terminal 404, `unavailable` a 502). Non-strict, as `ChecksFileAnswerSchema`
 * is. Bounded like the forge's read, with room for base64: each file, and the tree as a whole, so
 * an answer past what the forge may serve is never judged.
 */
export const SkillsTreeAnswerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tree"),
    commit: commitSha,
    tree: commitSha,
    files: z.array(z.object({
      path: z.string().min(1).max(4_096),
      mode: z.enum(["100644", "100755", "120000", "160000"]),
      content: z.string().max(MAX_SKILLS_FILE_BASE64).nullable(),
    })).max(2_000).refine(
      (files) =>
        files.reduce((sum, f) => sum + (f.content === null ? 0 : base64Bytes(f.content)), 0) <=
          MAX_SKILLS_TREE_BYTES,
      { error: "the tree is larger than the forge serves" },
    ),
  }),
  z.object({ kind: z.literal("unchanged"), commit: commitSha, tree: commitSha }),
  z.object({ kind: z.literal("absent"), commit: commitSha }),
  z.object({ kind: z.literal("invalid"), commit: commitSha, detail: z.string().max(2_000) }),
]) satisfies z.ZodType<Exclude<SkillsTree, { kind: "missing-ref" | "unavailable" }>>;

/** What the forge's POST /v1/service/checks/report answers with a 200. Failures are statuses
 * with `{error, terminal}`, as every other forge write's are. */
export const ReportChecksAnswerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("reported"),
    refs: z.record(z.string().max(200), z.string().max(200)),
  }),
  z.object({ kind: z.literal("unsupported"), reason: z.string().max(2_000) }),
]) satisfies z.ZodType<Exclude<ReportChecksOutcome, { kind: "failed" }>>;

/**
 * As `ForgeEventSchema`, and non-strict for the same reason: the sender is the automations
 * service, behind a service token, and the two deploy separately — unknown keys are stripped
 * so a version skew degrades to ignoring what this orchestrator does not understand yet.
 */
/** What an automation checks out: a repo (at a ref, or its default) or a workspace. */
export const AutomationTargetSchema = z.discriminatedUnion("kind", [
  // A branch, as a task's own ref is: an automation never fires onto a pull request's head.
  z.object({ kind: z.literal("repo"), connectedRepoId: mintedId, ref: anchorableRef.nullable() }),
  z.object({ kind: z.literal("workspace"), workspaceId: mintedId }),
]) satisfies z.ZodType<AutomationTarget>;

/** The keep-warm access check: whose access, to what. */
export const AutomationAccessProbeSchema = z.object({
  ownerUserId: mintedId,
  target: AutomationTargetSchema,
});

/** A chat platform's id for something — a message, a user, a channel, a group — as text. */
const chatId = z.string().trim().min(1).max(200);

/**
 * A signal's key or title: the sender's text, bounded rather than refused — a fire is never
 * dropped over its label. Collapsed to one line, trimmed and cut to 200 code points by
 * `boundSignalText`; empty is null. The wire bound is generous only so an over-long label is
 * cut, not rejected.
 */
const signalText = z.string().max(4_000).nullable().default(null).transform(boundSignalText);

/** What a fire says of itself. A status this orchestrator does not know yet is "unknown". */
const FireSignalSchema = z.object({
  status: z.enum(["firing", "resolved", "update", "unknown"]).catch("unknown"),
  key: signalText,
  title: signalText,
});

export const AutomationEventSchema = z.object({
  eventId: z.string().trim().min(1).max(200),
  automationId: z.string().trim().min(1).max(200),
  name: singleLine.max(200),
  ownerUserId: mintedId,
  agentId: mintedId,
  target: AutomationTargetSchema,
  instructions: nonEmpty,
  // The mailroom's ingestion cap is 2 MB; the payload rides the event verbatim.
  payload: z.string().max(2 * 1024 * 1024),
  // Absent from a sender that predates payload formats: a fire that says nothing of itself.
  signal: FireSignalSchema.default({ ...SILENT_SIGNAL }),
  // Absent from a sender that predates responses is the same as null: a run per fire.
  response: z.object({
    chatroomId: mintedId.nullable(),
    // The channel each response opens its own conversation in, on a platform that has channels.
    // Null (or absent, from a sender that predates it) is Telegram's one conversation per room.
    channelId: chatId.nullable().default(null),
    idleMs,
    attendedIdleMs: idleMs,
    // Absent from a sender that predates correlation: one open response per automation.
    correlation: z.enum(["fire", "automation", "key"]).default("automation"),
    // Absent from a sender that predates it: the opening line says nothing of the alert.
    postAlert: z.boolean().default(false),
    // Absent from a sender that predates it: a conversation per response.
    conversation: z.enum(["per-response", "shared"]).default("per-response"),
  }).nullable().default(null),
  firedAt: singleLine.max(64),
}) satisfies z.ZodType<InboundAutomationEvent>;

/** A display name someone chose; bounded, one line. */
const chatName = z.string().trim().min(1).max(200)
  .refine((s) => !/[\r\n]/.test(s), { error: "must be a single line" });
const chatVisibility = z.enum(["private", "public", "web-public"]);

/**
 * One image of a mention, as it travels: its bytes, base64-encoded, at most MAX_ATTACHMENT_BYTES
 * once decoded — bounded on the encoded text before anything is decoded. What the bytes ARE is
 * the door's to decide (`inspectImage`, at `storeAttachment` and `startTask`), not this schema's.
 */
const ChatMentionImageSchema = z.object({
  data: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4),
}).transform(({ data }, ctx) => {
  try {
    return { bytes: Uint8Array.fromBase64(data) };
  } catch {
    ctx.addIssue({ code: "custom", message: "not base64" });
    return z.NEVER;
  }
});

/**
 * What the chat service posts on POST /v1/chat/mentions: one mention of the bot, normalized.
 * Non-strict for `ForgeEventSchema`'s reason — the chat service deploys separately, so a field
 * this version has not heard of is stripped, not refused.
 */
export const ChatMentionSchema = z.object({
  chatroomId: mintedId,
  messageId: chatId,
  boundRunId: mintedId.nullable(),
  // "" is Telegram's one conversation per room — a real key, not an absent one.
  threadKey: z.string().trim().max(200),
  channel: z.object({ id: chatId, name: z.string().max(200), visibility: chatVisibility }),
  topic: z.string().max(200).nullable(),
  sender: z.object({ id: chatId, name: chatName }),
  text: z.string().trim().max(MAX_MESSAGE_CHARS),
  hasAttachment: z.boolean(),
  images: z.array(ChatMentionImageSchema).max(MAX_ATTACHMENTS),
  receivedAt: singleLine.max(64),
}) satisfies z.ZodType<InboundChatMention>;

/**
 * What PUT /v1/command-rooms/:chatroomId accepts: the whole policy, channel rows included.
 * The shape rules live here; that the agents exist and the targets resolve is checked in the
 * handler, which can see them. The owner is never taken — it is the admin saving it.
 */
export const CommandRoomSchema = z.strictObject({
  agentIds: z.array(mintedId).min(1).max(20).refine((ids) => new Set(ids).size === ids.length, {
    error: "an agent may be listed once",
  }),
  defaultAgentId: mintedId,
  defaultTarget: AutomationTargetSchema.nullable(),
  commanders: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("group"), groupId: chatId }),
    z.strictObject({ kind: z.literal("room") }),
  ]),
  startsPerHour: z.number().int().min(1).max(100),
  channels: z.array(z.strictObject({
    channelId: chatId,
    channelName: chatName,
    target: AutomationTargetSchema,
  })).max(200).refine((cs) => new Set(cs.map((c) => c.channelId)).size === cs.length, {
    error: "a channel may be listed once",
  }),
}).refine((room) => room.agentIds.includes(room.defaultAgentId), {
  error: "the default agent must be one of the room's agents",
  path: ["defaultAgentId"],
}).refine((room) => room.defaultTarget !== null || room.channels.length > 0, {
  error: "a command room serves at least one channel: give it a default target or a channel",
  path: ["defaultTarget"],
});

/**
 * The chat service's answer to a thread read — an ingest boundary like the forge's, and headed
 * for an agent's prompt the same way. Non-strict for the same version-skew reason.
 */
const ChatThreadSchema = z.object({
  channel: z.object({ id: chatId, name: z.string().max(200), visibility: chatVisibility }),
  topic: z.string().max(200).nullable(),
  messages: z.array(z.object({
    id: chatId,
    sender: z.object({ id: chatId, name: z.string().max(200) }),
    text: z.string().max(MAX_LEN),
    sentAt: z.string().max(64),
    hasAttachment: z.boolean(),
  })).max(2_000),
  truncated: z.boolean(),
  historyLimited: z.boolean(),
});

export const ChatThreadOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), thread: ChatThreadSchema }),
  z.object({ kind: z.literal("gone") }),
  z.object({ kind: z.literal("unavailable") }),
]) satisfies z.ZodType<ChatThreadOutcome>;

/** The conversation a shared response continues — checked as `ChatThreadOutcomeSchema`, and for
 * the same reason: it is headed for an agent's prompt. */
export const ChatContinuedThreadOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), thread: ChatThreadSchema, botId: chatId }),
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("unavailable") }),
]) satisfies z.ZodType<ChatContinuedThreadOutcome>;

/**
 * The chat service's description of a room, headed for a bound run's work item and from there
 * the agent's prompt. Non-strict for the same version-skew reason. The chat service's own room
 * name is at most 200 characters, and it is the fallback for a title.
 */
export const ChatContextSchema = z.object({
  kind: z.enum(["telegram", "zulip", "slack", "discord"]),
  roomTitle: z.string().min(1).max(200),
  botHandle: z.string().min(1).max(200),
  // Absent from an older chat service, and that is a room the closing line still reaches.
  quiet: z.boolean().optional(),
}) satisfies z.ZodType<ChatContext>;

/**
 * The forge's answer to a thread read — an ingest boundary like any other, even though the
 * sender holds a service token. Authentication proves who is calling, not that the payload is
 * the shape the caller promised, and this payload is headed for an agent's prompt.
 *
 * Non-strict for the same reason `ForgeEventSchema` is: the forge and the orchestrator deploy
 * separately, so a field this version has not heard of is stripped, not refused.
 */
/** What the forge's POST /v1/service/change-request-head answers with a 200. */
export const ForgeChangeRequestStateSchema = z.object({
  ref: forgeThreadRef,
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  headSha: commitSha,
  authorHeadSha: commitSha,
  baseRef: z.string().min(1).max(255),
  openedByUs: z.boolean(),
  mergedHeads: z.array(commitSha).max(20),
}) satisfies z.ZodType<ForgeChangeRequestState>;

/**
 * One thread image as the forge carries it: base64 of at most 5 MiB (`MAX_ATTACHMENT_BYTES`,
 * which `inspectImage` holds the decoded bytes to again), or why there is none.
 *
 * An image this schema cannot take is an image the thread cannot show, and NEVER a thread that
 * cannot be read: refusing the whole answer over one image was a 503, a redelivery that read
 * (and downloaded) the same thread again, and in the end a command lost to one comment's
 * `<img>` tag. So a malformed image is caught where it stands, as an omission — `unavailable`,
 * which the prompt shows as an image that could not be had — keeping its markup when that much
 * of it is sound, so the note still sits where the image did.
 */
const forgeThreadImageMarkup = z.string().max(MAX_THREAD_IMAGE_MARKUP);
const forgeThreadImageOccurrence = z.number().int().min(0).max(MAX_THREAD_IMAGE_OCCURRENCE)
  .optional();
const forgeThreadImage = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("image"),
    markup: forgeThreadImageMarkup,
    occurrence: forgeThreadImageOccurrence,
    name: z.string().max(MAX_THREAD_IMAGE_NAME).optional(),
    data: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4),
  }),
  z.object({
    kind: z.literal("omitted"),
    markup: forgeThreadImageMarkup,
    occurrence: forgeThreadImageOccurrence,
    name: z.string().max(MAX_THREAD_IMAGE_NAME).optional(),
    reason: z.enum(["limit", "too_large", "unsupported", "unavailable"]),
  }),
]).catch(({ input }) => {
  const raw = input as { markup?: unknown; occurrence?: unknown } | null;
  const markup = forgeThreadImageMarkup.safeParse(raw?.markup);
  const occurrence = forgeThreadImageOccurrence.safeParse(raw?.occurrence);
  // Where it sat only when both halves are sound: a markup without its occurrence would put the
  // note at the first spelling, which may be somewhere else entirely.
  const placed = markup.success && occurrence.success;
  return {
    kind: "omitted" as const,
    markup: placed ? markup.data : "",
    ...(placed && occurrence.data !== undefined ? { occurrence: occurrence.data } : {}),
    reason: "unavailable" as const,
  };
});

/** A body's images: a list that is not one, or longer than any forge sends, is ONE omission at
 * the end of the text — "an image could not be had" — rather than a refused thread (see
 * `forgeThreadImage`). */
const forgeThreadImages = z.array(forgeThreadImage).max(100).optional().catch(() => [
  { kind: "omitted" as const, markup: "", reason: "unavailable" as const },
]);

export const ForgeThreadContextSchema = z.object({
  kind: z.enum(["issue", "change_request"]),
  ref: forgeThreadRef,
  title: z.string().max(MAX_LEN),
  body: z.string().max(MAX_LEN),
  authorLogin: z.string().max(200),
  createdAt: z.string().max(64),
  state: z.string().max(64),
  bodyImages: forgeThreadImages,
  entries: z.array(z.object({
    kind: z.enum(["comment", "review", "review_comment"]),
    authorLogin: z.string().max(200),
    body: z.string().max(MAX_LEN),
    createdAt: z.string().max(64),
    state: z.string().max(64).nullable(),
    location: z.string().max(1_000).nullable(),
    remark: z.object({
      id: forgeThreadRef,
      replyTo: forgeThreadRef.nullable(),
      resolved: z.boolean().nullable(),
    }).optional(),
    // An id out of bounds is an entry no command can be found in, never a refused thread.
    id: z.string().min(1).max(MAX_THREAD_ENTRY_ID).optional().catch(undefined),
    images: forgeThreadImages,
  })).max(2_000),
  truncated: z.boolean(),
  changeRequest: z.object({
    ref: forgeThreadRef,
    url: z.string().max(2_000),
    state: z.enum(["open", "closed"]),
    merged: z.boolean(),
    // Not `gitName`: a branch this schema cannot serve is the intake's refusal to explain to
    // the commenter, not a malformed event to drop.
    headRef: z.string().min(1).max(255),
    headSha: z.string().max(64),
    authorHeadSha: z.string().max(64),
    // Not `gitName` either, for the same reason as `headRef`.
    baseRef: z.string().min(1).max(255),
    headRepoRef: z.string().max(200).nullable(),
    headRepoHidden: z.boolean().optional(),
    sameRepo: z.boolean().optional(),
    headRepoDefaultBranch: z.string().max(255).nullable().optional(),
    maintainerCanModify: z.boolean().optional(),
    defaultBranch: z.string().min(1).max(255),
  }).nullable(),
}) satisfies z.ZodType<ForgeThreadContext>;

/** What POST /v1/history/runs/:id/verify accepts: the run token a historian's ingest client
 * presented, verbatim. Same shapeless-beyond-bounds discipline as GitKeyResolveSchema — the
 * token is compared by hash, and explaining a rejection would only help a probe. */
export const HistoryTokenVerifySchema = z.object({
  token: z.string().min(1).max(4_096),
});

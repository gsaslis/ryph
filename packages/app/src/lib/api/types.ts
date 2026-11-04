import { z } from "zod";
import { ROLES } from "$lib/utils/auth/capabilities";
import { THINKING_LEVELS, type ThinkingLevel } from "./thinking-levels";

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
  status: z.enum(["active", "deactivated"]),
  emailVerifiedAt: z.string().nullable(),
  /** The address an untrusted provider (GitLab) gave, never proven; `email` is then a stand-in. */
  unprovenEmail: z.string().nullable(),
  resetRequestedAt: z.string().nullable(),
  hasPassword: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type User = z.infer<typeof userSchema>;

export const runStateSchema = z.enum([
  "starting",
  "running",
  "succeeded",
  "failed",
  "errored",
  "cancelled",
  "lost",
]);
export type RunState = z.infer<typeof runStateSchema>;

export const TERMINAL_RUN_STATES: readonly RunState[] = [
  "succeeded",
  "failed",
  "errored",
  "cancelled",
  "lost",
];

export const phaseSchema = z.enum([
  "booting",
  "cloning",
  "preparing",
  "setting-up",
  "running",
  "finalizing",
]);
export type Phase = z.infer<typeof phaseSchema>;

/** How hard a model is asked to think, in pi's words, least to most (thinking-levels.ts). */
export { THINKING_LEVELS, type ThinkingLevel };
export const thinkingLevelSchema = z.enum(THINKING_LEVELS);

export const modelPolicySchema = z.object({
  providerKeyId: z.string(),
  provider: z.string(),
  allowedModels: z.union([z.literal("*"), z.array(z.string())]),
  defaultModel: z.string().nullable(),
  /** Used when a task picks no level; null leaves it to the harness. Defaulted as the server
   * defaults it, so a policy saved before the field existed still reads. */
  defaultThinking: thinkingLevelSchema.nullable().default(null),
});
export type ModelPolicy = z.infer<typeof modelPolicySchema>;

/** `"*"` allows every tool the server reports; a list is an exact allowlist of tool names. */
export const allowedToolsSchema = z.union([z.literal("*"), z.array(z.string())]);
export type AllowedTools = z.infer<typeof allowedToolsSchema>;

/**
 * Which MCP servers an agent may reach and which of their tools it may call — the sibling of the
 * model policy, and the same rule: servers by id only, never a URL or a credential.
 */
export const toolPolicySchema = z.object({
  servers: z.array(z.object({ serverId: z.string(), allowedTools: allowedToolsSchema })),
});
export type ToolPolicy = z.infer<typeof toolPolicySchema>;

/**
 * Whether an agent remembers, and how much of it rides into each run: the token budget of the
 * brief composed at task start. Null: memory off for this agent — no brief, no memory tools.
 */
export const memoryPolicySchema = z.object({
  budgetTokens: z.number().int().min(0),
  agentOnly: z.boolean().optional(),
});
export type MemoryPolicy = z.infer<typeof memoryPolicySchema>;

/** What an agent gets when nobody said otherwise (the orchestrator's DEFAULT_MEMORY_POLICY). */
export const DEFAULT_MEMORY_BUDGET_TOKENS = 2000;

/** "origin": only the thread the run was started from, and issues the run opened itself. "any":
 * any thread of a repo in scope. */
export const forgeWhereSchema = z.enum(["origin", "any"]);
export type ForgeWhere = z.infer<typeof forgeWhereSchema>;

/** What a forge policy may grant, and what a run's frozen scope carries of it. */
export const forgeCapabilitiesSchema = z.object({
  /** get_* and list_* on issues and change requests. */
  read: z.boolean(),
  createIssues: z.object({ max: z.number() }).nullable(),
  /** add_comment. */
  comment: z.object({ where: forgeWhereSchema, max: z.number() }).nullable(),
  /** submit_review — change requests only; the cap counts reviews. */
  review: z.object({ where: forgeWhereSchema, max: z.number() }).nullable(),
  /** close_issue — issues only, never change requests. */
  closeIssues: z.object({ where: forgeWhereSchema, max: z.number() }).nullable(),
  /** Labels create_issue and add_labels may apply; they must already exist on the repo. */
  labels: z.array(z.string()),
});
export type ForgeCapabilities = z.infer<typeof forgeCapabilitiesSchema>;

/**
 * Which issue and change request actions an agent's runs may take, as the platform's own forge
 * identity, and on which repos — the sibling of the tool and memory policies. Null: no forge
 * tools. Every write carries a per-run cap; the orchestrator refuses a policy granting nothing.
 */
export const forgePolicySchema = forgeCapabilitiesSchema.extend({
  /** "run": the connected repos the run checks out. A list: those repos, checked out or not. */
  repos: z.union([z.literal("run"), z.object({ connectedRepoIds: z.array(z.string()) })]),
});
export type ForgePolicy = z.infer<typeof forgePolicySchema>;

/** What the form pre-fills a write capability's cap with when it is ticked. */
export const DEFAULT_FORGE_CAPS = {
  createIssues: 5,
  comment: 20,
  review: 5,
  closeIssues: 10,
} as const;

/** The ceiling on every per-run cap (the orchestrator's MAX_FORGE_CAP). */
export const MAX_FORGE_CAP = 50;

/**
 * Where an agent's runs may reach on the open internet — the fourth policy, and the one whose
 * null means the opposite of its siblings': null is "whatever this deployment allows", because
 * an agent with no internet cannot run `npm ci`. Narrowing to nothing is two empty lists.
 */
export const networkPolicySchema = z.object({
  bundles: z.array(z.string()),
  hosts: z.array(z.string()),
});
export type NetworkPolicy = z.infer<typeof networkPolicySchema>;

/** One entry of the deployment's egress catalogue, as `GET /v1/egress` reports it. */
export const egressBundleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  hosts: z.array(z.string()),
});
export type EgressBundle = z.infer<typeof egressBundleSchema>;

/**
 * The deployment's egress ceiling: what an agent's policy may narrow, and nothing it may widen.
 * `mode: "open"` is a deployment claiming no boundary at all — the form says so rather than
 * offering an allowlist that would not be enforced.
 */
export const egressCeilingSchema = z.object({
  mode: z.enum(["open", "proxy"]),
  /** The bundles this deployment vouches for, expanded for display. */
  bundles: z.array(egressBundleSchema),
  /** Raw hosts the operator added on top (RYPH_EGRESS_HOSTS). */
  hosts: z.array(z.string()),
  /** False when the boundary is claimed but unwired — no key, or no proxy address — which
   * means runs currently reach nothing at all. The form warns rather than staying silent. */
  wired: z.boolean(),
  /** Every bundle that EXISTS, not only the ones vouched for — what the admin form offers to
   * add. An agent's form reads `bundles` instead: it may narrow, never widen. */
  catalogue: z.array(egressBundleSchema).default([]),
  /** `environment` — the seed from `RYPH_EGRESS_BUNDLES`/`_HOSTS`, which a redeploy can still
   * move. `admin` — a saved allowlist, which outlives one. They read identically otherwise, so
   * the form says which. */
  source: z.enum(["environment", "admin"]).default("environment"),
  updatedAt: z.string().nullable().default(null),
  updatedBy: z.string().nullable().default(null),
});
export type EgressCeiling = z.infer<typeof egressCeilingSchema>;

/**
 * How long a run may run, how much it may spend, and how many model calls it may hold open.
 * Null is no cap at this tier: on an agent's policy it means "the deployment's ceiling", and
 * on a run it means the run is uncapped there.
 */
export const runLimitsSchema = z.object({
  wallClockMs: z.number().int().nullable(),
  spendUsd: z.number().nullable(),
  callsInFlight: z.number().int().nullable(),
});
export type RunLimits = z.infer<typeof runLimitsSchema>;

/**
 * The operator's run limits (GET /v1/limits): the ceiling an agent's policy and a task's override
 * stay under, and how many runs may be live at once. Read by anyone; set only in the environment.
 */
export const deploymentLimitsSchema = z.object({
  ceiling: runLimitsSchema,
  concurrency: z.number().int().nullable(),
});
export type DeploymentLimits = z.infer<typeof deploymentLimitsSchema>;

/**
 * Which skills an agent's runs may load, as switches over the deployment's (the orchestrator's
 * SkillPolicy). It only narrows: the lists name what is OFF, so a skill added later reaches the
 * agent without an edit. Null on the agent: everything the deployment allows.
 */
export const skillPolicySchema = z.object({
  catalogue: z.object({ disabled: z.array(z.string()) }),
  /** `enabled: false` turns the org repo off for this agent; `disabled` is kept so turning it
   * back on restores the picks. */
  org: z.object({ enabled: z.boolean(), disabled: z.array(z.string()) }),
  workingRepos: z.object({ enabled: z.boolean() }),
});
export type SkillPolicy = z.infer<typeof skillPolicySchema>;

/** What an agent gets when nobody said otherwise (the orchestrator's DEFAULT_SKILL_POLICY). */
export const DEFAULT_SKILL_POLICY: SkillPolicy = {
  catalogue: { disabled: [] },
  org: { enabled: true, disabled: [] },
  workingRepos: { enabled: true },
};

export const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  // Null on agents created before handles existed — not addressable by /ryph until edited.
  handle: z.string().nullable().default(null),
  email: z.string(),
  systemPrompt: z.string().nullable(),
  harnessKind: z.string(),
  modelPolicy: modelPolicySchema.nullable().default(null),
  toolPolicy: toolPolicySchema.nullable().default(null),
  memoryPolicy: memoryPolicySchema.nullable().default(null),
  forgePolicy: forgePolicySchema.nullable().default(null),
  networkPolicy: networkPolicySchema.nullable().default(null),
  /** This agent's default run limits under the ceiling; null means the ceiling's values. */
  limitPolicy: runLimitsSchema.nullable().default(null),
  /** Which skills this agent's runs may load; null means everything the deployment allows. */
  skillPolicy: skillPolicySchema.nullable().default(null),
  /** False: the agent's runs never open patches. */
  canOpenPatches: z.boolean().default(true),
  /** True: the agent's runs may publish artifacts, which everyone on the instance can open. */
  canPublishArtifacts: z.boolean().default(false),
  /** True: the agent's runs get a browser it drives and a person can watch. */
  browserEnabled: z.boolean().default(false),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Agent = z.infer<typeof agentSchema>;

/** The provider id of a ChatGPT plan key: a sign-in rather than a pasted secret. */
export const CHATGPT_PLAN_PROVIDER = "chatgpt-plan";

/**
 * Whether a ChatGPT plan key can be used right now. `needs_reauth` is a failed refresh: someone
 * has to sign in again. `limited` is the plan's own usage limit, hit at `limitedAt`.
 */
export const chatgptPlanStatusSchema = z.enum(["active", "needs_reauth", "limited"]);
export type ChatgptPlanStatus = z.infer<typeof chatgptPlanStatusSchema>;

/** The non-secret half of a ChatGPT plan key: the account it signed in as and what it serves. */
export const chatgptPlanSchema = z.object({
  email: z.string().nullable(),
  planType: z.string().nullable(),
  status: chatgptPlanStatusSchema,
  limitedAt: z.string().nullable(),
  /** The account's own models, each with this account's `reasoning` and levels. */
  models: z.array(z.lazy(() => declaredModelSchema)),
});
export type ChatgptPlan = z.infer<typeof chatgptPlanSchema>;

/** A provider key as the API exposes it: metadata plus a last4 trace, never the secret. A ChatGPT
 * plan key also carries `plan`; every other key leaves it out. */
export const providerKeySchema = z.object({
  id: z.string(),
  provider: z.string(),
  label: z.string(),
  last4: z.string(),
  plan: chatgptPlanSchema.optional(),
  /** True when its custom endpoint changed (address, auth header or extra headers): the secret
   * was dropped and must be entered again before a run can use the key. Read absent as false. */
  needsSecret: z.boolean().optional(),
  /** True when its provider no longer exists: it can only be archived. Read absent as false. */
  providerMissing: z.boolean().optional(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProviderKey = z.infer<typeof providerKeySchema>;

/**
 * One model a custom endpoint declares it serves. Required, not decorative: a harness cannot
 * enumerate the models of a provider it has no built-in catalogue for, and the price list cannot
 * know them either — so the admin who registers the endpoint declares both.
 *
 * `price` is USD per million tokens and is all-or-nothing: a model without one is reported as
 * UNPRICED on the usage page, never as free. `compat` is the harness's own compatibility
 * overrides, passed through verbatim; the app neither reads nor offers them.
 */
/**
 * The one place the wire names the third pricing state. Priced models carry `price`, unpriced
 * ones carry nothing, and a model a subscription pays for (a ChatGPT plan's) carries
 * `pricing: "included"`: its tokens are counted, its cost is $0 and is not spend. Usage rows
 * carry the same marker. If the model proxy names it differently, change it here only.
 */
export const includedPricingSchema = z.literal("included");
export const INCLUDED_PRICING = includedPricingSchema.value;

export const declaredModelSchema = z.object({
  id: z.string(),
  pricing: includedPricingSchema.optional(),
  label: z.string().optional(),
  contextWindow: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  reasoning: z.boolean().optional(),
  vision: z.boolean().optional(),
  /** The levels it takes, in pi's order: a built-in's from pi's catalogue, a plan model's from
   * its account's list, a custom endpoint's as its admin declared them — never filled in, so a
   * custom model reads exactly as stored. Absent, what pi does decides (`thinkingLevelsFor`). A
   * level the server knows and this build does not is dropped, not a failure. */
  thinkingLevels: z.array(z.string()).transform((levels) =>
    THINKING_LEVELS.filter((level) => levels.includes(level))
  ).optional(),
  compat: z.record(z.string(), z.unknown()).optional(),
  price: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  }).optional(),
});
export type DeclaredModel = z.infer<typeof declaredModelSchema>;

/**
 * An upstream the model proxy forwards to: the two built-ins, plus every OpenAI-compatible
 * endpoint an admin registered (Cloudflare Workers AI, Groq, a self-hosted vLLM…). A key is
 * registered against one of these, and a run's virtual credential is minted for it.
 *
 * `dialect` stays a free string rather than an enum for the same reason `harnessSchema.dialects`
 * does: it is the wire vocabulary the services agree on, and a deployment ahead of this build
 * must render, not fail to parse. The list deliberately withholds one field — `extraHeaders` —
 * because it is readable by every signed-in user; see `providerDetailSchema`.
 */
export const providerSchema = z.object({
  id: z.string(),
  label: z.string(),
  dialect: z.string(),
  /** True for `anthropic` and `openai`: compiled in, never editable, never archivable. */
  builtin: z.boolean(),
  /** Where the real API lives, path included. */
  baseUrl: z.string(),
  /** The header the provider key rides upstream in — `authorization`, or e.g. `api-key`. */
  authHeader: z.string(),
  /** The scheme in front of it; null means the header carries the endpoint's bare value. */
  authScheme: z.string().nullable(),
  /** A custom endpoint's declared models; for a built-in, the models on ryph's price list. */
  models: z.array(declaredModelSchema),
  archivedAt: z.string().nullable(),
});
export type Provider = z.infer<typeof providerSchema>;

/**
 * One endpoint as `GET /v1/providers/:id` answers it: everything above plus the static headers
 * the list holds back. Nothing here is a secret — the credential is the provider key, sealed in
 * the proxy with no read path at all — but `extraHeaders` is a free-text map an admin typed, so
 * that route is admin-only where the list is not. It exists so the edit dialog can show what is
 * stored instead of asking an operator to retype it blind.
 */
export const providerDetailSchema = providerSchema.extend({
  extraHeaders: z.record(z.string(), z.string()),
});
export type ProviderDetail = z.infer<typeof providerDetailSchema>;

/** The platform's own model policy: the key its background work (memory consolidation and
 * ingest) spends, the models it may name, and the one it uses by default. */
export const platformModelPolicySchema = z.object({
  providerKeyId: z.string(),
  provider: z.string(),
  allowedModels: z.union([z.literal("*"), z.array(z.string())]),
  model: z.string(),
  updatedAt: z.string(),
});
export type PlatformModelPolicy = z.infer<typeof platformModelPolicySchema>;

/** How a server's real credential rides an upstream request. `none` is a public server. */
export const mcpAuthKindSchema = z.enum(["none", "bearer", "headers"]);
export type McpAuthKind = z.infer<typeof mcpAuthKindSchema>;

/**
 * Who runs a server: `remote` is somebody else, at a URL the operator typed; `hosted` is the
 * gateway itself, as a container it launched from the catalogue or from an operator-named image;
 * `platform` is a service of the platform's own (memory), seeded at boot and managed nowhere.
 */
export const mcpServerKindSchema = z.enum(["remote", "hosted", "platform"]);
export type McpServerKind = z.infer<typeof mcpServerKindSchema>;

/**
 * A hosted server's container as the gateway last knew it. `update-available` is `healthy` seen
 * through a catalogue whose pinned image has moved past the one the row was launched from.
 */
export const hostStatusSchema = z.enum([
  "starting",
  "healthy",
  "unreachable",
  "stopped",
  "update-available",
]);
export type HostStatus = z.infer<typeof hostStatusSchema>;

export const hostStateSchema = z.object({
  handle: z.string().nullable(),
  status: hostStatusSchema,
  imageDigest: z.string().nullable(),
  startedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type HostState = z.infer<typeof hostStateSchema>;

/** The advanced path: an HTTP-speaking, digest-pinned image the operator named. */
export const customContainerSchema = z.object({
  image: z.string(),
  command: z.array(z.string()),
  port: z.number(),
  path: z.string(),
  /** The env var the image reads its per-launch caller token from. Null on a row that predates it. */
  callerAuth: z.object({ env: z.string() }).nullable().default(null),
});
export type CustomContainer = z.infer<typeof customContainerSchema>;

/** A hosted server's non-secret configuration, as its catalogue entry's settings name it. */
export const hostSettingsSchema = z.record(z.string(), z.union([z.string(), z.boolean()]));
export type HostSettings = z.infer<typeof hostSettingsSchema>;

/** An MCP server as the API exposes it: metadata plus a last4 trace, never the credential. */
export const mcpServerSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  transport: z.string(),
  // Defaulted so a row from a gateway that predates hosting still reads as what it was.
  kind: mcpServerKindSchema.default("remote"),
  url: z.string(),
  auth: mcpAuthKindSchema,
  authLast4: z.string().nullable(),
  catalogueId: z.string().nullable().default(null),
  custom: customContainerSchema.nullable().default(null),
  settings: hostSettingsSchema.nullable().default(null),
  host: hostStateSchema.nullable().default(null),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type McpServer = z.infer<typeof mcpServerSchema>;

/**
 * The platform forge server's row, as the gateway seeds it when the deployment serves issue and
 * change request tools. A wire contract duplicated from @ryph/mcp-gateway, which the app cannot
 * import: its tools are granted by an agent's forge policy, never its tool policy, so the Tools
 * picker hides the row and the orchestrator refuses a tool policy naming it.
 */
export const PLATFORM_FORGE_SERVER_ID = "ms-platform-forge";

/** One option of a `choice` setting: the value sent, and what the form shows. */
export const catalogueChoiceOptionSchema = z.object({ value: z.string(), label: z.string() });
export type CatalogueChoiceOption = z.infer<typeof catalogueChoiceOptionSchema>;

/**
 * One setting a catalogue entry's Add form asks for. Toggles carry a boolean default, choices one
 * of their option values. `pattern` is an anchored regex a remote entry's text setting must match.
 */
export const catalogueSettingSchema = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(["url", "text", "toggle", "choice"]),
  placeholder: z.string().nullable(),
  description: z.string().nullable(),
  optional: z.boolean(),
  default: z.union([z.string(), z.boolean()]).nullable(),
  options: z.array(catalogueChoiceOptionSchema).nullable(),
  pattern: z.string().nullable(),
});
export type CatalogueSetting = z.infer<typeof catalogueSettingSchema>;

/**
 * One secret a catalogue entry reads, by the header the gateway will send it in. `prefix` is what
 * the gateway puts in front of the value (`Bearer `), so the operator pastes the bare key.
 */
export const catalogueSecretSchema = z.object({
  header: z.string(),
  label: z.string(),
  placeholder: z.string().nullable(),
  description: z.string().nullable(),
  prefix: z.string().nullable(),
});
export type CatalogueSecret = z.infer<typeof catalogueSecretSchema>;

/**
 * One entry of the gateway's catalogue. `hosted`: an image the gateway runs, which needs a
 * container backend. `remote`: a preset for a vendor's own MCP endpoint at `host`, which needs
 * nothing but the operator's key and works on any deployment.
 */
export const catalogueEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(["hosted", "remote"]),
  name: z.string(),
  description: z.string(),
  docs: z.string(),
  /** The vendor's mark and colour for the card, where the entry carries them. */
  brand: z.object({ color: z.string(), logo: z.string() }).nullable(),
  /** Hosted only: the pinned image. */
  image: z.string().nullable(),
  /** Remote only: the vendor's hostname, e.g. `mcp.linear.app`. */
  host: z.string().nullable(),
  settings: z.array(catalogueSettingSchema),
  secrets: z.array(catalogueSecretSchema),
  /** Tool names an agent's policy leaves unticked when the server is first added: they write. */
  defaultOff: z.array(z.string()),
});
export type CatalogueEntry = z.infer<typeof catalogueEntrySchema>;

/**
 * GET /v1/mcp-catalogue: the hosted entries and remote presets, and whether this deployment can
 * host at all. `hostingAvailable` gates the hosted entries only.
 */
export const mcpCatalogueSchema = z.object({
  hostingAvailable: z.boolean(),
  /** Why not, in words the Add dialog shows verbatim — present exactly when unavailable. */
  reason: z.string().optional(),
  entries: z.array(catalogueEntrySchema),
});
export type McpCatalogue = z.infer<typeof mcpCatalogueSchema>;

/** One tool as a probe found it. The annotations are the server's own claims — hints, never controls. */
export const probedToolSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  annotations: z.record(z.string(), z.unknown()).nullable(),
});
export type ProbedTool = z.infer<typeof probedToolSchema>;

/**
 * What a probe found out about a server. A verdict about UPSTREAM rides a 200 either way — the
 * credential being rejected or the host being down are answers for the operator, not failures of
 * the control plane.
 */
export const probeResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    protocolVersion: z.string().nullable(),
    serverInfo: z.object({ name: z.string().nullable(), version: z.string().nullable() }),
    tools: z.array(probedToolSchema),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["policy", "unreachable", "credential_rejected", "secret_required", "protocol"]),
    detail: z.string(),
  }),
]);
export type ProbeResult = z.infer<typeof probeResultSchema>;

/**
 * How one forwarded call ended. `denied` is the gateway's allowlist refusing a tool; `rejected`
 * is the upstream refusing the server's credential; `error` is everything else that was not a 2xx.
 */
export const mcpUsageStatusSchema = z.enum(["ok", "error", "denied", "rejected"]);
export type McpUsageStatus = z.infer<typeof mcpUsageStatusSchema>;

/** One JSON-RPC request through the gateway's data plane — a run's tool-call audit trail. */
export const mcpUsageRecordSchema = z.object({
  runId: z.string(),
  serverId: z.string(),
  method: z.string(),
  tool: z.string().nullable(),
  status: mcpUsageStatusSchema,
  httpStatus: z.number().nullable(),
  durationMs: z.number(),
  at: z.string(),
});
export type McpUsageRecord = z.infer<typeof mcpUsageRecordSchema>;

export const harnessSchema = z.object({
  kind: z.string(),
  /** The one agent image every kind launches on; null when the deployment configures none. */
  image: z.string().nullable(),
  /** The wire dialects this harness can drive ("anthropic-messages", "openai-responses", …).
   * A provider key is offerable to an agent when its provider speaks one of them — which is
   * what makes a custom endpoint usable without anything here knowing its name. */
  dialects: z.array(z.string()),
  /** Whether the harness can drive MCP tools. Defaults closed, like the orchestrator's table. */
  tools: z.boolean().default(false),
  /** Whether the harness reads skills. Closed by default too: the agent editor hides its Skills
   * step for a harness that would ignore every switch on it. */
  skills: z.boolean().default(false),
  /** Whether a run on this harness can get a browser here: the deployment runs one, its
   * provisioner launches it, and the harness can call MCP tools. Closed by default; the agent
   * editor holds its Browser switch off where this is false. */
  browser: z.boolean().default(false),
  /** Why `browser` is false: the harness cannot call MCP tools, the provisioner cannot launch a
   * browser, or the deployment configures no browser image. Null when it is true, or from an
   * older control plane that does not say. */
  browserUnavailable: z.enum(["harness", "provisioner", "image"]).nullable().default(null),
  /** The deployment's provisioner (`docker`, `kubernetes`, …), or null when unknown. */
  provisioner: z.string().nullable().default(null),
});
export type Harness = z.infer<typeof harnessSchema>;

export const submissionPolicySchema = z.enum(["require-approval", "auto"]);
export type SubmissionPolicy = z.infer<typeof submissionPolicySchema>;

/** Which forge a repository, an identity or a thread lives on. `local` is a git repository on the
 * machine running ryph: no identities, no threads, and a patch lands as a branch in it. */
export const forgeProviderSchema = z.enum(["github", "gitlab", "radicle", "local"]);
export type ForgeProvider = z.infer<typeof forgeProviderSchema>;

/** The two kinds of thread a forge has: an issue, or a change request (a pull request on GitHub,
 * a merge request on GitLab, a patch on Radicle). */
export const threadKindSchema = z.enum(["issue", "change_request"]);
export type ThreadKind = z.infer<typeof threadKindSchema>;

export const connectedRepoSchema = z.object({
  id: z.string(),
  provider: forgeProviderSchema,
  /** GitHub's installation id; null on a forge that has no installations. */
  installationId: z.string().nullable(),
  /** How this repo's forge spells its address: `owner/name` on GitHub, a nested
   * `group/sub/project` path on GitLab, a `rad:` RID, or a local repo's absolute path. */
  repoRef: z.string(),
  /** Where a person can open it — empty on a Radicle deployment with no explorer configured, and
   * the same path as `repoRef` on a local repo (not a web address either way). */
  url: z.string(),
  defaultBranch: z.string(),
  submissionPolicy: submissionPolicySchema,
  /** The size class a run on this repo alone gets; null is the deployment's default. */
  sizeClass: z.string().nullable(),
  /** Whether runs may push onto the branches of pull requests from forks (GitHub only). */
  allowForkPushes: z.boolean(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConnectedRepo = z.infer<typeof connectedRepoSchema>;

/** One size class the deployment offers (RYPH_RUN_SIZES), as Kubernetes quantities. */
export const runSizeSchema = z.object({
  name: z.string(),
  cpu: z.string().nullable(),
  memory: z.string().nullable(),
  ephemeralStorage: z.string().nullable(),
  workVolume: z.string().nullable(),
  /** The class a repo or workspace that names none gets. */
  default: z.boolean(),
});
export type RunSize = z.infer<typeof runSizeSchema>;

/**
 * Room held on the cluster for each size class, so a run or check of that size lands on a node
 * that already exists. Only some provisioners can hold it (`supported`). `ready` is what the
 * cluster holds right now, null on every class when the cluster could not be read, and lags a save.
 */
export const reservedCapacitySchema = z.object({
  supported: z.boolean(),
  maxSlots: z.number().int(),
  classes: z.array(
    runSizeSchema.extend({
      /** False unless the class sets cpu, memory and ephemeral storage */
      reservable: z.boolean(),
      /** How many services one slot also holds room for, beyond the class. */
      services: z.number().int(),
      slots: z.number().int(),
      ready: z.number().int().nullable(),
    }),
  ),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export type ReservedCapacity = z.infer<typeof reservedCapacitySchema>;

/**
 * Where an environment build stands. `superseded` is a build a newer one replaced — a ready image
 * the next one took over from, or a queued build a newer commit overtook.
 */
export const environmentStatusSchema = z.enum([
  "queued",
  "building",
  "ready",
  "failed",
  "superseded",
]);
export type EnvironmentStatus = z.infer<typeof environmentStatusSchema>;

/**
 * One environment build of a repo or workspace: the machine its runs start on, with the checkout
 * already in it and setup.yml already run. `commits` is `{path: sha}` per checkout; `definition` is
 * every member's `.ryph/` as one key, null when no member has a `.ryph/` at all, which means the
 * universal image.
 */
export const environmentViewSchema = z.object({
  id: z.string(),
  subjectKind: z.enum(["repo", "workspace"]),
  subjectId: z.string(),
  ref: z.string(),
  commits: z.record(z.string(), z.string()),
  definition: z.string().nullable(),
  baseDigest: z.string().nullable(),
  harnessDigest: z.string().nullable(),
  /** The pinned image a run starts from; null until a build succeeded. */
  image: z.string().nullable(),
  status: environmentStatusSchema,
  /** Versions the build recorded (`{"rustc": "1.97.1", "node": "24.3.0"}`). */
  toolchains: z.record(z.string(), z.string()),
  sizeBytes: z.number().nullable(),
  /** What started the build: a push, the reconcile tick, a harness upgrade, a person. */
  trigger: z.string(),
  /** Why it was queued, in a sentence naming the refs, commits and trees compared. */
  reason: z.string().nullable().default(null),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
  /** The end of the build's log, for reading inline; the whole of it is its own route. */
  logTail: z.string().nullable(),
  /** Whether the repo described this build's machine itself. It decides what a failed build costs
   * a run: waiting and then a refusal where there is a machine, nothing at all where the default
   * image is still the right one. */
  machine: z.boolean(),
  /** What the egress proxy refused this build, worded upstream, however the build ended — a
   * build that succeeded while being refused a host is the one that ships a broken image. */
  egressNote: z.string().nullable().default(null),
  /** What setup.yml warned of when this build ran it — a step that failed, an invalid file, a
   * tree put back — the build still ready, so this is the warning. Each a summary line and the
   * step's output (or why the file was refused), partly the repo's own words: shown as plain
   * text. */
  setupWarnings: z.array(z.object({
    path: z.string(),
    /** `dirty` (setup finished, what it left in the tree was discarded) and `discarded` (put
     * back for another repo's failed step) are not a setup that didn't finish. */
    kind: z.string().default("step"),
    summary: z.string(),
    detail: z.string(),
  })).default([]),
  /** A full build, an incremental one on the last image, or a re-layer onto a new platform
   * layer — most of what decides how long it takes. */
  kind: z.enum(["full", "incremental", "relayer"]).default("full"),
  /** How long this repo's builds of this kind usually take, or null with none to go by. */
  estimateMs: z.number().nullable().default(null),
});
export type EnvironmentView = z.infer<typeof environmentViewSchema>;

/**
 * A row of the builds list: the build without its log tail and definition key (the list is
 * re-read every few seconds while anything builds), and what it was built for — a repo's address
 * with its forge, or a workspace's name with none. Null when that repo or workspace is gone.
 */
export const buildListItemSchema = z.object({
  build: environmentViewSchema.omit({ logTail: true, definition: true }),
  subject: z.object({ name: z.string(), provider: forgeProviderSchema.nullable() }).nullable(),
});
export type BuildListItem = z.infer<typeof buildListItemSchema>;

/**
 * A repo's or a workspace's environment as its settings page reads it. `current` is the build
 * runs start on now; `latest` the newest build of any status, which is `current` itself unless a
 * newer one is queued, building or failed. `enabled: false` is a deployment with environments
 * off, where every run starts on the default image; `refusedReason` is a builder that cannot
 * build on this backend at all (manual), in words the page shows as they are.
 */
export const subjectEnvironmentSchema = z.object({
  enabled: z.boolean(),
  builder: z.string().nullable(),
  refusedReason: z.string().nullable(),
  current: environmentViewSchema.nullable(),
  latest: environmentViewSchema.nullable(),
  sizeClass: z.string().nullable(),
  /** Workspaces only: whose `.ryph/Dockerfile` defines the machine; null is the first member. */
  environmentRepoId: z.string().nullable().optional(),
});
export type SubjectEnvironment = z.infer<typeof subjectEnvironmentSchema>;

/**
 * The forge half of the same card, on its own route and streamed in after the page: `definition`
 * is what the default branch describes — whether it has a `.ryph/` at all, and a Dockerfile in
 * it — and decides whether the card offers "Set up this repo's environment" or "Revise
 * environment"; `ignoredDockerfiles` names a workspace's other members that carry a Dockerfile,
 * which it does not use. `definition` is null where there was nothing to ask: environments off,
 * or a subject with no member. Asking makes the forge fetch the repository from upstream, which
 * is why the card renders without it.
 */
export const environmentDefinitionSchema = z.object({
  definition: z.object({ ryph: z.boolean(), dockerfile: z.boolean() }).nullable(),
  ignoredDockerfiles: z.array(z.string()).default([]),
});
export type EnvironmentDefinition = z.infer<typeof environmentDefinitionSchema>;

/** The environment a run started on, frozen with it. `id` is "default" for the default image. */
export const runEnvironmentSchema = z.object({
  id: z.string(),
  image: z.string(),
  ref: z.string().nullable(),
  commits: z.record(z.string(), z.string()),
  builtAt: z.string().nullable(),
});
export type RunEnvironment = z.infer<typeof runEnvironmentSchema>;

/** A run held in provisioning while the environment it must start on is built. */
export const environmentWaitSchema = z.object({
  environmentId: z.string(),
  status: environmentStatusSchema,
});
export type EnvironmentWait = z.infer<typeof environmentWaitSchema>;

/** One repository of a task's checkout, as the task froze it. */
export const repoEntrySchema = z.object({
  /** Null only on a task from before every task checked out a connected repo. */
  connectedRepoId: z.string().nullable(),
  name: z.string(),
  url: z.string(),
  ref: z.string(),
  path: z.string(),
  /** The run's branch namespace in the repo: each line of work ships on `<namespace>/<line>`. */
  branchNamespace: z.string(),
  description: z.string().nullable(),
  /** The repo's forge, which says how its threads are named; on a task's own repos only. */
  provider: forgeProviderSchema.nullable().optional(),
});
export type RepoEntry = z.infer<typeof repoEntrySchema>;

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** The size class a run on the workspace gets; null is the deployment's default. */
  sizeClass: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const workspaceRepoSchema = z.object({
  workspaceId: z.string(),
  connectedRepoId: z.string(),
  ref: z.string().nullable(),
  path: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkspaceRepo = z.infer<typeof workspaceRepoSchema>;

/** A workspace as the API answers it: the row and its members, in checkout order. */
export const workspaceWithReposSchema = z.object({
  workspace: workspaceSchema,
  repos: z.array(workspaceRepoSchema),
  /** Whether the signed-in user may change it: admin on every member repo, or the admin role.
   * The API refuses the rest with a 403, so the controls are shown to exactly these people. */
  canManage: z.boolean(),
});
export type WorkspaceWithRepos = z.infer<typeof workspaceWithReposSchema>;

export const installationSchema = z.object({
  id: z.string(),
  installationId: z.string(),
  accountLogin: z.string(),
  createdAt: z.string(),
});
export type Installation = z.infer<typeof installationSchema>;

/** A repo as an installation grants it, flagged when it is already connected. */
export const installationRepoSchema = z.object({
  fullName: z.string(),
  url: z.string(),
  defaultBranch: z.string(),
  private: z.boolean(),
  connected: z.boolean(),
});
export type InstallationRepo = z.infer<typeof installationRepoSchema>;

/**
 * How this deployment is on GitHub: as an App that people install and link their accounts to, or
 * as the one person whose token it holds. `signIn` says whether the App has an OAuth client,
 * which signing in and linking a GitHub account need. Null on the wire where there is no GitHub
 * at all.
 */
export const githubModeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("app"), signIn: z.boolean() }),
  z.object({ mode: z.literal("user"), login: z.string() }),
]);
export type GithubMode = z.infer<typeof githubModeSchema>;

/** Whether the Radicle bridge is ryph's own node or one person's, acting as them (the local
 * binary's). */
export const radicleModeSchema = z.object({ mode: z.enum(["deployment", "user"]) });
export type RadicleMode = z.infer<typeof radicleModeSchema>;
/**
 * How this deployment is on GitLab: a bot account the deployment holds a token for, or one
 * person's own token; either way the login it acts as and the instance it lives on. `signIn`
 * says whether the forge holds a GitLab OAuth application, which signing in and linking a GitLab
 * account need. Null on the wire where there is no GitLab at all.
 */
export const gitlabModeSchema = z.object({
  mode: z.enum(["bot", "user"]),
  login: z.string(),
  url: z.string(),
  signIn: z.boolean(),
});
export type GitlabMode = z.infer<typeof gitlabModeSchema>;

/** A repo the user-mode token can see, with the live connected row for it when there is one. */
export const githubRepoSchema = z.object({
  fullName: z.string(),
  url: z.string(),
  defaultBranch: z.string(),
  private: z.boolean(),
  /** Whether the token holds admin on it, which connecting needs. */
  admin: z.boolean(),
  connectedRepoId: z.string().nullable(),
});
export type GithubRepo = z.infer<typeof githubRepoSchema>;

export const patchStateSchema = z.enum([
  "pending_approval",
  "queued",
  "submitting",
  "submitted",
  "failed",
  "rejected",
  "superseded",
]);
export type PatchState = z.infer<typeof patchStateSchema>;

export const patchApproverSchema = z.union([
  z.object({ kind: z.literal("user"), userId: z.string() }),
  z.object({ kind: z.literal("break-glass") }),
]);
export type PatchApprover = z.infer<typeof patchApproverSchema>;

export const patchSchema = z.object({
  id: z.string(),
  state: patchStateSchema,
  connectedRepoId: z.string(),
  runId: z.string(),
  taskId: z.string(),
  /** Every patch born from one run shares a set id; a set is a grouping, never a transaction. */
  setId: z.string(),
  /** The repo's directory in the run's checkout. */
  path: z.string(),
  /** The line of the run's work in the repo: one branch, one change request. `work` unless the
   * agent named another; a repo of a run may ship several. */
  line: z.string(),
  branchName: z.string(),
  headSha: z.string(),
  bundleKey: z.string(),
  attempts: z.number(),
  nextAttemptAt: z.string().nullable(),
  lastError: z.string().nullable(),
  approvedBy: patchApproverSchema.nullable(),
  approvedAt: z.string().nullable(),
  forgeRef: z.string().nullable(),
  forgeUrl: z.string().nullable(),
  /** Set once the forge closed the change request: merged with this patch, merged without it
   * (`missed`: its commits go out with the run's next patch while its run is live; `unproven`
   * when nobody could confirm whether the merge held it), or closed without merging. */
  landed: z
    .object({
      kind: z.enum(["merged", "missed", "closed"]),
      at: z.string(),
      unproven: z.boolean().optional(),
    })
    .nullable(),
  supersededByPatchId: z.string().nullable(),
  /** Why a person has to decide on it: its generation already landed through a sibling (not
   * approvable while its run goes on, `heldUntilRunEnds`), or the run's finalize shipped it
   * without it being rebased onto where its branch's change request merged, so its diff may
   * repeat merged work. */
  heldReason: z.string().nullable().default(null),
  /** Which branch of the run's work this is: once a patch from a branch merges, the next patch
   * starts a new branch. The first is 1. */
  generation: z.number().default(1),
  /** The commit the bundle was cut from, as the run reported it; null for a patch born from a
   * run's final report. */
  baseSha: z.string().nullable().default(null),
  /** What the agent called the change when it submitted it mid-run; null when it did not. */
  title: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  /** The check suite the patch is judged by, the one its forge is told about. Only the task
   * detail carries it; null there when the patch has none. */
  checksSuiteId: z.string().nullable().default(null),
  /** Which forge the patch's repo lives on — null when the repo the patch was made against is
   * gone. Told, never guessed from the spelling. */
  provider: forgeProviderSchema.nullable().default(null),
  /** What a check of a repo-on-this-machine patch's files found among git hook files: the hook
   * files it touches (`more` when there were more than listed) and the hook directories it read.
   * Null until checked, and for every other repo. */
  hookCheck: z
    .object({
      touched: z.array(z.string()),
      hooksPaths: z.array(z.string()),
      more: z.boolean(),
    })
    .nullable()
    .default(null),
  /** A repo-on-this-machine patch's files are still being checked for git hook files. */
  hooksPending: z.boolean().default(false),
  /** Why a repo-on-this-machine patch's files could not be checked for git hook files, while it
   * waits. It can still be approved: it is checked again then, and fails if that check does. */
  hookCheckError: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Patch = z.infer<typeof patchSchema>;
export type HookCheck = NonNullable<Patch["hookCheck"]>;

/**
 * Whether a patch still moves on its own: the submitter holds it, or a failed attempt has the
 * next one on the clock. `pending_approval` and `rejected` wait on a human, and the remaining
 * states are at rest.
 */
export function isPatchAdvancing(patch: Pick<Patch, "state" | "nextAttemptAt">): boolean {
  if (patch.state === "queued" || patch.state === "submitting") return true;
  return patch.state === "failed" && patch.nextAttemptAt !== null;
}

export const commitInfoSchema = z.object({
  sha: z.string(),
  subject: z.string(),
});
export type CommitInfo = z.infer<typeof commitInfoSchema>;

/** Where a check suite stands (the orchestrator's `CheckSuiteState`). */
export const checkSuiteStateSchema = z.enum([
  "waiting",
  "queued",
  "running",
  "passed",
  "failed",
  "error",
  "cancelled",
]);
export type CheckSuiteState = z.infer<typeof checkSuiteStateSchema>;

/** Where one check of a suite stands (the orchestrator's `CheckResultState`). */
export const checkResultStateSchema = z.enum([
  "queued",
  "running",
  "passed",
  "failed",
  "timed_out",
  "setup_failed",
  "error",
  "cancelled",
]);
export type CheckResultState = z.infer<typeof checkResultStateSchema>;

/**
 * An outside contribution's head waiting for approval: a change request whose author may not start
 * checks on the repository (a fork's pull request, a non-delegate's Radicle patch). Approving runs
 * its checks once; `url` is the change request on its forge, where the approver is sent back to.
 */
export const checkApprovalSchema = z.object({
  id: z.string(),
  state: z.enum(["pending", "approved", "superseded", "closed"]),
  repo: z.object({ id: z.string(), repoRef: z.string(), provider: forgeProviderSchema }),
  changeRequest: z.string(),
  url: z.string().nullable(),
  headSha: z.string(),
  author: z.string(),
  approvedByLogin: z.string().nullable(),
  approvedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type CheckApproval = z.infer<typeof checkApprovalSchema>;

/**
 * One check suite: the commands a repo's `.ryph/checks.yml` declares at the base commit, run by
 * the platform against a head commit. The verdict is each container's exit code. `logTail` is the
 * check's own output — head-authored text, always rendered as text.
 */
export const checkSuiteViewSchema = z.object({
  id: z.string(),
  connectedRepoId: z.string(),
  repoRef: z.string().nullable(),
  provider: forgeProviderSchema.nullable(),
  commit: z.string(),
  checksRef: z.string(),
  checksCommit: z.string(),
  checksBlob: z.string(),
  checksPath: z.string(),
  environment: z.object({
    key: z.string(),
    image: z.string().nullable(),
    environmentId: z.string().nullable(),
  }),
  state: checkSuiteStateSchema,
  reason: z.string().nullable(),
  generation: z.number(),
  /** Whether the change touched `.ryph/`; null when that is not known. */
  ryphChanged: z.boolean().nullable(),
  createdAt: z.string(),
  launchedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  checks: z.array(
    z.object({
      name: z.string(),
      run: z.string(),
      timeoutSeconds: z.number(),
      services: z.array(z.string()),
      /** As declared: `own` runs in a pod of its own, with `size` when it names one. */
      pod: z.literal("own").optional(),
      size: z.string().optional(),
      state: checkResultStateSchema,
      exitCode: z.number().nullable(),
      startedAt: z.string().nullable(),
      finishedAt: z.string().nullable(),
      logTail: z.string().nullable(),
      hasLog: z.boolean(),
      watchedChanged: z.boolean().nullable(),
      /** A pass taken from an earlier run on the same commit rather than run here. */
      inherited: z.boolean(),
    }),
  ),
  requestedBy: z.array(
    z.object({
      kind: z.enum(["tool", "patch", "push", "rerun", "forge", "local"]),
      runId: z.string().nullable(),
      patchId: z.string().nullable(),
    }),
  ),
  /** Runs only some of the declared checks: the ones `checks` lists. */
  partial: z.boolean().default(false),
  detailsUrl: z.string().nullable(),
});
export type CheckSuiteView = z.infer<typeof checkSuiteViewSchema>;
export type CheckView = CheckSuiteView["checks"][number];

/**
 * Who asked for a suite, as the checks list links it: a task's run, a patch's change request, a
 * push to any change request, a forge re-run, a person's own commit (`local`, from `ryph checks`). `label` names it in words; `href` is where it
 * opens, null when nowhere.
 */
export const checkAskerSchema = z.object({
  kind: z.enum(["tool", "patch", "push", "rerun", "forge", "local"]),
  label: z.string(),
  href: z.string().nullable(),
});
export type CheckAsker = z.infer<typeof checkAskerSchema>;

/** One suite in the checks list: the suite, the branch its head is on, and who asked for it. */
export const checkSuiteListItemSchema = z.object({
  suite: checkSuiteViewSchema,
  branch: z.string().nullable(),
  askedBy: z.array(checkAskerSchema),
});
export type CheckSuiteListItem = z.infer<typeof checkSuiteListItemSchema>;

/** One check a repository's checks file declares. */
export const declaredCheckSchema = z.object({
  name: z.string(),
  run: z.string(),
  timeoutSeconds: z.number(),
  services: z.array(z.string()),
  watch: z.array(z.string()),
  /** As declared: `own` runs in a pod of its own, with `size` when it names one. */
  pod: z.literal("own").optional(),
  size: z.string().optional(),
});
export type DeclaredCheck = z.infer<typeof declaredCheckSchema>;

/** A connected repository's checks file on its default branch, and the newest full suite there. */
export const repoChecksSchema = z.object({
  connectedRepoId: z.string(),
  repoRef: z.string(),
  provider: forgeProviderSchema,
  defaultBranch: z.string(),
  file: z.discriminatedUnion("state", [
    z.object({
      state: z.literal("declared"),
      path: z.string(),
      commit: z.string(),
      setup: z.array(z.string()),
      checks: z.array(declaredCheckSchema),
      /** The pods a full suite of the file runs at once. */
      podsNeeded: z.number().optional(),
      /** Set when that is more than the deployment runs at once: such a suite fails. */
      warning: z.string().optional(),
    }),
    z.object({ state: z.literal("none") }),
    // The forge may refuse a file before it picks a path or pins a commit.
    z.object({
      state: z.literal("invalid"),
      path: z.string().nullable(),
      commit: z.string().nullable(),
      error: z.string(),
    }),
    z.object({ state: z.literal("unread"), error: z.string() }),
  ]),
  latest: checkSuiteViewSchema.nullable(),
});
export type RepoChecks = z.infer<typeof repoChecksSchema>;

/** What check pods may run at once on this instance, and how many are. */
export const checkCapacitySchema = z.object({ inUse: z.number(), total: z.number() });
export type CheckCapacity = z.infer<typeof checkCapacitySchema>;

/** The latest suite on a patch's head, counted, as the approval queue shows it. */
export const patchChecksSummarySchema = z.object({
  suiteId: z.string(),
  state: checkSuiteStateSchema,
  passed: z.number(),
  failed: z.number(),
  total: z.number(),
});
export type PatchChecksSummary = z.infer<typeof patchChecksSummarySchema>;

/** A patch plus the context the approval queue renders: what work, by whom, against what. */
export const patchWithContextSchema = patchSchema.extend({
  taskTitle: z.string().nullable(),
  agentName: z.string().nullable(),
  repoRef: z.string().nullable(),
  summary: z.string().nullable(),
  commits: z.array(commitInfoSchema),
  /** The latest check suite on the patch's head; null when there is none. */
  checks: patchChecksSummarySchema.nullable().default(null),
  /** Whether the run that made the patch still goes on. Only a landing hold
   * (`heldUntilRunEnds`) waits for it to end; any other held patch can be approved meanwhile. */
  runLive: z.boolean().default(false),
  /** Whether its hold waits for the run to end (its generation landed), not only for a
   * person. */
  heldUntilRunEnds: z.boolean().default(false),
  /** For a patch held for its landed generation, where approving it sends it now; null for every
   * other patch. */
  heldDestination: z.string().nullable().default(null),
});
export type PatchWithContext = z.infer<typeof patchWithContextSchema>;

export const inviteSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  role: z.enum(ROLES),
  maxUses: z.number().nullable(),
  uses: z.number(),
  expiresAt: z.string(),
  createdBy: z.string(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Invite = z.infer<typeof inviteSchema>;

export const invitePreviewSchema = z.object({
  email: z.string().nullable(),
  role: z.enum(ROLES),
  valid: z.boolean(),
});
export type InvitePreview = z.infer<typeof invitePreviewSchema>;

export const authSettingsSchema = z.object({
  allowOpenRegistration: z.boolean(),
  allowForgeOrgJoin: z.boolean(),
  /** Whether verification and reset links can be mailed; otherwise admins hand them over. */
  mailerConfigured: z.boolean(),
  /** False: one person uses this instance, and nothing adds, invites or re-roles anyone. */
  multiUser: z.boolean(),
  updatedAt: z.string(),
});
export type AuthSettings = z.infer<typeof authSettingsSchema>;

export const apiTokenSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  caps: z.array(z.string()),
  expiresAt: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ApiToken = z.infer<typeof apiTokenSchema>;

export const sessionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  expiresAt: z.string(),
  createdAt: z.string(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});
export type Session = z.infer<typeof sessionSchema>;

export const passkeySchema = z.object({
  id: z.string(),
  userId: z.string(),
  transports: z.array(z.string()),
  name: z.string(),
  backedUp: z.boolean(),
  deviceType: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type Passkey = z.infer<typeof passkeySchema>;

export const identitySchema = z.object({
  provider: z.string(),
  login: z.string(),
  linkedAt: z.string(),
});
export type Identity = z.infer<typeof identitySchema>;

/** The two ways a maintainer can follow ryph's node, as the platform spells them out. */
export const followCommandsSchema = z.object({
  /** Run from inside a working copy of the repo — no RID to type. */
  inWorkingCopy: z.string(),
  /** Run from anywhere, naming the repo. */
  anywhere: z.string(),
});
export type FollowCommands = z.infer<typeof followCommandsSchema>;

/** Whether ryph's node is actually up, and how many peers it is talking to. Null when the node
 * could not be asked — "not running" and "unknown" are different answers. */
export const radicleNodeStateSchema = z.object({
  running: z.boolean(),
  sessions: z.number(),
});
export type RadicleNodeState = z.infer<typeof radicleNodeStateSchema>;

/** ryph's own Radicle node: who it signs as, and how to follow it. */
export const radicleIdentitySchema = z.object({
  did: z.string(),
  nid: z.string(),
  /** A node need not have named itself. */
  alias: z.string().nullable().default(null),
  node: radicleNodeStateSchema.nullable().default(null),
  /** The one to paste inside a working copy — the same string as `followCommands.inWorkingCopy`,
   * which the platform picks so a screen with room for one line does not have to choose. */
  followCommand: z.string().optional(),
  followCommands: followCommandsSchema,
});
export type RadicleIdentity = z.infer<typeof radicleIdentitySchema>;

/** What ryph's node knows about a Radicle repo, read from its verified identity document. */
export const radicleRepoInfoSchema = z.object({
  /** The repository's whole address, as the node read it back. */
  rid: z.string(),
  /** ryph's node id and DID on this repo — what a delegate would allow or follow. */
  nid: z.string(),
  did: z.string(),
  alias: z.string().nullable().default(null),
  name: z.string(),
  defaultBranch: z.string(),
  delegates: z.array(z.string()),
  /** Whether ryph itself is a delegate: if it is, nobody needs to follow it. */
  isDelegate: z.boolean(),
  /** Whether ryph's DID is in a private repository's allow set — that is, whether its node may
   * fetch the repo at all. Always true on a public one, where there is no allow set. */
  isAllowed: z.boolean(),
  visibility: z.enum(["public", "private"]),
  followCommands: followCommandsSchema,
});
export type RadicleRepoInfo = z.infer<typeof radicleRepoInfoSchema>;

/** One identity an admin let run `/ryph` on a repo, beside its delegates. */
export const commandAllowlistEntrySchema = z.object({
  subject: z.string(),
  addedBy: z.string(),
  createdAt: z.string(),
});
export type CommandAllowlistEntry = z.infer<typeof commandAllowlistEntrySchema>;

/** A nonce to prove an identity with, and the exact command that signs it — the shape of every
 * provider whose accounts are keys rather than logins, Radicle today. */
export const identityChallengeSchema = z.object({
  nonce: z.string(),
  expiresAt: z.string(),
  command: z.string(),
});
export type IdentityChallenge = z.infer<typeof identityChallengeSchema>;

/** Who put the task there — the orchestrator's `Task["origin"]`, and one of the list's filters. */
export const taskOriginSchema = z.enum([
  "user",
  "break-glass",
  "forge",
  "automation",
  "chat",
  "token",
]);
export type TaskOrigin = z.infer<typeof taskOriginSchema>;

/**
 * The seven run states, bucketed the way people actually ask about a list: "what is running",
 * "what broke". The names are the API's — `?status=` takes these, not run states — and the order
 * is the order the filter menu offers them in.
 */
export const TASK_STATUS_BUCKETS = {
  live: ["starting", "running"],
  succeeded: ["succeeded"],
  failed: ["failed"],
  broken: ["errored", "lost"],
  cancelled: ["cancelled"],
} as const satisfies Record<string, readonly RunState[]>;

export type TaskStatusBucket = keyof typeof TASK_STATUS_BUCKETS;

export const taskSummarySchema = z.object({
  id: z.string(),
  /** Null exactly while the task waits for its first message (`awaitingPrompt`). */
  title: z.string().nullable(),
  /** Started without instructions: the first message sent to its run becomes them. */
  awaitingPrompt: z.boolean().default(false),
  agentId: z.string(),
  agentName: z.string().nullable(),
  origin: taskOriginSchema,
  workspaceId: z.string().nullable(),
  /** The connected repos of the task's frozen checkout. */
  connectedRepoIds: z.array(z.string()),
  requestedByUserId: z.string().nullable(),
  createdAt: z.string(),
  /** When the current run last moved — the column the row's "x ago" should eventually read. */
  lastActivityAt: z.string(),
  state: runStateSchema,
  phase: phaseSchema.nullable(),
  idleState: z.enum(["idle", "waiting-for-user"]).nullable().optional(),
  /** The current run's reported outcome; cleared when work resumes. */
  declaredOutcome: z.enum(["in-progress", "success", "no-changes", "failed"]).nullable().optional()
    .catch(null),
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;

/**
 * A page of the list. `nextCursor` is opaque — it goes back to the server verbatim and means
 * "the row after the last one you got", which is why a task created while someone is paging
 * lands at the head instead of shoving a row onto the next page.
 */
export const taskPageSchema = z.object({
  tasks: z.array(taskSummarySchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type TaskPage = z.infer<typeof taskPageSchema>;

export const createTaskResponseSchema = z.object({
  taskId: z.string(),
  runId: z.string(),
  state: runStateSchema,
});
export type CreateTaskResponse = z.infer<typeof createTaskResponseSchema>;

/** One repo's branch as the run shipped it — one per repo of the checkout that reached the remote. */
export const branchOutcomeSchema = z.object({
  /** Null only on a run from before every task checked out a connected repo. */
  connectedRepoId: z.string().nullable(),
  path: z.string(),
  /** The line the branch ships; absent in a result stored before lines. */
  line: z.string().optional(),
  name: z.string(),
  headSha: z.string(),
  commits: z.array(z.object({ sha: z.string(), subject: z.string() })),
});
export type BranchOutcome = z.infer<typeof branchOutcomeSchema>;

/** The image formats a run's attachment may be: the four the control plane sniffs for. */
export const attachmentMimeSchema = z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export type AttachmentMime = z.infer<typeof attachmentMimeSchema>;

/** An image the agent put in its result: `![alt](img-…)` in the summary, by the ref the model was
 * shown beside the tool's image, resolved to the run attachment that holds its bytes. */
export const resultImageSchema = z.object({
  ref: z.string(),
  attachmentId: z.string(),
  mime: attachmentMimeSchema,
  alt: z.string(),
});
export type ResultImage = z.infer<typeof resultImageSchema>;

export const runnerResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    branches: z.array(branchOutcomeSchema),
    summary: z.string(),
    images: z.array(resultImageSchema).default([]),
  }),
  z.object({
    status: z.literal("cancelled"),
    branches: z.array(branchOutcomeSchema),
    summary: z.string(),
    images: z.array(resultImageSchema).default([]),
  }),
  z.object({
    status: z.literal("failure"),
    reason: z.string(),
    summary: z.string(),
    branches: z.array(branchOutcomeSchema),
    images: z.array(resultImageSchema).default([]),
  }),
  z.object({
    status: z.literal("error"),
    reason: z.string(),
    during: phaseSchema.or(z.literal("booting")),
    branches: z.array(branchOutcomeSchema),
  }),
]);
export type RunnerResult = z.infer<typeof runnerResultSchema>;

/** Who wrote a message into a run's inbox. */
export const messageSenderSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    userId: z.string(),
    /**
     * Their display name, resolved when the run is read: null for someone no longer a member,
     * absent when the control plane could not say (no directory, a failed lookup, or an older
     * control plane that names no one).
     */
    name: z.string().nullable().optional(),
  }),
  z.object({ kind: z.literal("chat"), name: z.string(), id: z.string() }),
  z.object({ kind: z.literal("automation"), fireId: z.string() }),
  z.object({
    kind: z.literal("forge"),
    login: z.string(),
    repoRef: z.string(),
    /** The thread the comment was on, as its forge names it: "12", "mr-7", or a Radicle id. */
    thread: z.string(),
    /** Absent on messages from before it was carried. */
    provider: forgeProviderSchema.optional(),
  }),
  z.object({ kind: z.literal("platform") }),
]);
export type MessageSender = z.infer<typeof messageSenderSchema>;

export const messageKindSchema = z.enum(["user", "chat", "alert", "system"]);
export type MessageKind = z.infer<typeof messageKindSchema>;

/**
 * What a platform message carries beside its text: a patch of the run changed state, the
 * environment build one of its patches asked for settled (or none was due — `skipped`), a
 * change request the run worked merged without anything of the run on it (`released`), or a
 * person finished the run from its page (`finish`, sent by that person).
 */
export const systemPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("patch"),
      patchId: z.string(),
      path: z.string(),
      headSha: z.string(),
      generation: z.number(),
      /** The patch's state, or `held`: a repo-on-this-machine patch kept for a person to approve
       * because it edits git hook files, which `hookPaths` lists. */
      state: z.string(),
      forgeUrl: z.string().nullable(),
      reason: z.string().nullable(),
      hookPaths: z.array(z.string()).default([]),
    })
    .loose(),
  z
    .object({
      kind: z.literal("environment"),
      patchId: z.string(),
      path: z.string(),
      headSha: z.string(),
      environmentId: z.string().nullable(),
      status: z.enum(["ready", "failed", "superseded", "skipped"]),
    })
    .loose(),
  /** The change request the repo at `path` worked merged with nothing of the run on it, and the
   * repo moved onto `onto`. */
  z
    .object({
      kind: z.literal("released"),
      path: z.string(),
      onto: z.string(),
      forgeRef: z.string(),
    })
    .loose(),
  z.object({
    kind: z.literal("checks"),
    suiteId: z.string(),
    path: z.string(),
    commit: z.string(),
    state: z.enum(["passed", "failed", "error", "cancelled"]),
    partial: z.boolean(),
  }).loose(),
  z.object({ kind: z.literal("finish") }).loose(),
]);
export type SystemPayload = z.infer<typeof systemPayloadSchema>;

/** An image a message or a run's task carries, by id: the bytes are read from
 * `GET /v1/runs/:id/attachments/:attachmentId`, never sent along. */
export const attachmentRefSchema = z.object({ id: z.string(), mime: attachmentMimeSchema });
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

/** One message in a run's inbox — from the run page, a chatroom, a joined alert, or the
 * platform — in the order the run received them. */
export const runMessageSchema = z.object({
  id: z.string(),
  runId: z.string(),
  seq: z.number(),
  kind: messageKindSchema,
  sender: messageSenderSchema,
  text: z.string(),
  // Notice metadata is optional presentation, not the message itself. Older runs may carry
  // incomplete metadata for a known kind, and newer platforms may introduce kinds or states
  // this client cannot render. Preserve the original text instead of rejecting the whole run.
  payload: systemPayloadSchema.nullable().default(null).catch(null),
  createdAt: z.string(),
  /** When the run picked it up; null while it waits in the inbox. */
  deliveredAt: z.string().nullable().default(null),
  /** The images it carries, in the order its `[image N]` markers count them. */
  attachments: z.array(attachmentRefSchema).default([]),
});
export type RunMessage = z.infer<typeof runMessageSchema>;

/** The orchestrator's append-only lifecycle trail — transitions only, never heartbeats. */
export const runEventSchema = z.object({
  runId: z.string(),
  at: z.string(),
  kind: z.string(),
  detail: z.string().optional(),
});
export type RunEvent = z.infer<typeof runEventSchema>;

/** A forge write a run's agent asked for, as the orchestrator's ledger recorded it. Reserved before
 * the write is attempted and completed after: a row left `reserved` is one whose outcome nobody
 * learned. */
export const forgeToolActionSchema = z.object({
  id: z.string(),
  runId: z.string(),
  tool: z.enum(["create_issue", "add_comment", "add_labels", "submit_review", "close_issue"]),
  connectedRepoId: z.string(),
  /** Which forge the write went to, denormalized beside the address for the same reason it is:
   * a reader needs it to spell the thread back, and a disconnected repo answers nothing. */
  provider: forgeProviderSchema,
  repoRef: z.string(),
  /** The thread written to, as its forge names it; null for create_issue. */
  threadRef: z.string().nullable(),
  state: z.enum(["reserved", "done", "failed"]),
  /** What the write created, where the forge has a URL for it. */
  url: z.string().nullable(),
  /** The issue create_issue opened. */
  createdThreadRef: z.string().nullable(),
  /** Why a failed write failed. */
  detail: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type ForgeToolAction = z.infer<typeof forgeToolActionSchema>;

/** An agent's forge policy resolved against one run at its start, and frozen with it. */
export const scopedRepoSchema = z.object({
  connectedRepoId: z.string(),
  provider: forgeProviderSchema,
  repoRef: z.string(),
  /** The forge's own tenant for the repo — an installation id on GitHub, and nothing at all on
   * a forge whose writes are signed rather than tokened. */
  tenantId: z.string().nullable(),
});
export type ScopedRepo = z.infer<typeof scopedRepoSchema>;

export const runForgeScopeSchema = z.object({
  repos: z.array(scopedRepoSchema),
  /** What the run checked out — not writable; the forge's visibility rule reads it too. */
  sourceRepos: z.array(scopedRepoSchema).default([]),
  /** The thread a /ryph command came from, or the task's target change request. */
  origin: z
    .object({
      connectedRepoId: z.string(),
      kind: threadKindSchema,
      ref: z.string(),
    })
    .nullable(),
  capabilities: forgeCapabilitiesSchema,
  /** What the footer on every write says. */
  provenance: z.object({
    agentName: z.string(),
    runUrl: z.string().nullable(),
    requestedBy: z.string().nullable(),
  }),
});
export type RunForgeScope = z.infer<typeof runForgeScopeSchema>;

/** One skill a run was given from a frozen source, by the digest of its files. */
export const runSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(["catalogue", "org"]),
  digest: z.string(),
});
export type RunSkill = z.infer<typeof runSkillSchema>;

/**
 * The skills a run was given, frozen at its start: the catalogue's and the org repo's, the org
 * version they came from, and whether the runner could add the working repos' own. What the runner
 * then loaded from the repos, and what was left out, is on the run's trail (`skills.repo`,
 * `skills.dropped`).
 */
export const runSkillsSchema = z.object({
  skills: z.array(runSkillSchema),
  /** The org repo version the org skills came from; null when none did. `stale` says the latest
   * read of the repo had failed, so the run got the last good version. */
  org: z
    .object({
      connectedRepoId: z.string(),
      repoRef: z.string(),
      commit: z.string(),
      syncId: z.string(),
      syncedAt: z.string(),
      stale: z.boolean(),
    })
    .nullable(),
  workingRepos: z.boolean(),
});
export type RunSkills = z.infer<typeof runSkillsSchema>;

/** A run as GET /v1/tasks/:id exposes it (credentials redacted upstream), with its event trail. */
export const taskRunSchema = z
  .object({
    id: z.string(),
    state: runStateSchema,
    phase: phaseSchema.nullable(),
    branchNamespace: z.string(),
    image: z.string().nullable(),
    result: runnerResultSchema.nullable(),
    /**
     * Hosts the egress proxy refused this run, already worded by the control plane — which is
     * where the bundle catalogue lives, so the remedy stays one sentence with one source. Null
     * when the run was refused nothing, which is almost every run.
     */
    egressNote: z.string().nullable().default(null),
    /** The run's frozen tool access; null when the agent had none at provision time. */
    toolScope: toolPolicySchema.nullable().default(null),
    /** Whether the run was given a browser of its own, frozen at provision time. */
    browser: z.boolean().optional().default(false),
    /** What the run was told beyond its task, frozen at provision time: the agent's system
     * prompt and the memory brief — exactly the text the run received, never a recomposition. */
    injectedContext: z
      .object({
        systemPrompt: z.string().optional(),
        brief: z
          .object({
            text: z.string(),
            memoryIds: z.array(z.string()),
            evidence: z.array(
              z.object({ memoryId: z.string(), sha: z.string(), paths: z.array(z.string()) }),
            ),
          })
          .optional(),
      })
      .nullable()
      .default(null),
    /** The chat conversation this run was started from by a mention in a command room — its
     * room and thread — or null for every other run. */
    originChatroomId: z.string().nullable().default(null),
    originThreadKey: z.string().nullable().default(null),
    /** Whether a person has spoken to this run — from the run page or a chatroom. */
    attended: z.boolean().default(false),
    /**
     * Proof, per service holding the run's records, that this reader may read them: passed as
     * `grant` on the transcript, bill and tool-trail reads. Null where a service is not dialled.
     */
    grants: z
      .object({
        history: z.string().nullable(),
        models: z.string().nullable(),
        tools: z.string().nullable(),
      })
      .nullable()
      .default(null),
    /** When the run ends on its own unless something happens first. */
    idleDeadlineAt: z.string().nullable().default(null),
    idleState: z.enum(["idle", "waiting-for-user"]).nullable().optional(),
    /** How the agent last said the run went, through its finish or report tool; null until it
     * has, and again once a message reached it since, until it says so again. `in-progress` says
     * required work or verification remains. A person may finish the run once this is `success`
     * or `no-changes`. An outcome this page does not know reads as none, so a newer control plane
     * cannot break the page. */
    declaredOutcome: z.enum(["in-progress", "success", "no-changes", "failed"]).nullable().catch(
      null,
    ),
    /** Whether the agent called its finish tool itself: the run is finishing, and a person's
     * finish is no longer offered. */
    agentFinished: z.boolean().default(false),
    /** `cancelled` once someone asked the run to stop; it ends when the runner hears it. */
    desiredState: z.enum(["cancelled"]).nullable().default(null),
    /** When the provisioner handed back a container; null before launch. The wall clock counts
     * from here. */
    launchedAt: z.string().nullable().default(null),
    /** How long this run may run, how much it may spend, and how many model calls it may hold
     * open — resolved at creation and frozen. Null on runs that predate limits. */
    limits: runLimitsSchema.nullable().default(null),
    /** The skills the run was given; null for a harness that reads none. */
    skills: runSkillsSchema.nullable().default(null),
    /** When the runner said which skills it loaded from the repos and which it left out; null
     * until it has. Every runner given skills says so once, before the agent starts. */
    skillsReportedAt: z.string().nullable().default(null),
    createdAt: z.string(),
    updatedAt: z.string(),
    events: z.array(runEventSchema),
    /** The run's inbox, oldest first. */
    messages: z.array(runMessageSchema).default([]),
    /** What the run may do on issues and change requests; null when its agent had no forge
     * policy. */
    forgeScope: runForgeScopeSchema.nullable().default(null),
    /** The forge writes the run's agent asked for, oldest first. */
    forgeActions: z.array(forgeToolActionSchema).default([]),
    /** The environment the run started on; null before it was provisioned. */
    environment: runEnvironmentSchema.nullable().default(null),
    /** Set while the run waits in provisioning for its environment to build. */
    environmentWait: environmentWaitSchema.nullable().default(null),
    /** What the runner was handed, frozen at start. Only the images the task arrived with (a
     * forge thread's screenshots, a chat mention's photo) are read here; the rest stays loose. */
    workItem: z
      .object({
        attachments: z.array(attachmentRefSchema).default([]),
        runSize: runSizeSchema.omit({ default: true }).optional(),
      })
      .loose()
      .nullable()
      .default(null),
  })
  .loose();
export type TaskRun = z.infer<typeof taskRunSchema>;

export const responseStateSchema = z.enum(["open", "attended", "closed"]);
export type ResponseState = z.infer<typeof responseStateSchema>;

/**
 * A run that lives in a conversation: opened by an automation's fire, joined by the later fires
 * its correlation sends to it, attended once a person speaks to the run, closed when the run ends.
 */
export const responseSchema = z.object({
  id: z.string(),
  automationId: z.string(),
  taskId: z.string(),
  runId: z.string(),
  chatroomId: z.string().nullable(),
  state: responseStateSchema,
  /** What later fires are matched on; "" for the automation-wide slot. */
  key: z.string().default(""),
  /** What the opening fire said it was about, when its format could tell. */
  title: z.string().nullable().default(null),
  /** Every fire that joined, counted — including the ones past the embed cap. */
  alerts: z.number(),
  openedAt: z.string(),
  lastAlertAt: z.string(),
  lastActivityAt: z.string(),
  closedAt: z.string().nullable(),
  /** The run's terminal state, or "closed-by-user". */
  closedReason: z.string().nullable(),
});
export type Response = z.infer<typeof responseSchema>;

/** A response as the list shows it, with what the run is about and where it stands. */
export const responseListItemSchema = responseSchema.extend({
  taskTitle: z.string().nullable().default(null),
  agentName: z.string().nullable().default(null),
  runState: runStateSchema.nullable().default(null),
});
export type ResponseListItem = z.infer<typeof responseListItemSchema>;

/**
 * What one submitted patch asked of the environment builder: a build of its branch (whose result
 * the run was told in a message), or — `environment` null — why none was due, or — `note` null
 * too — a check not resolved yet. Listed for every build, and for a setup task's notes too.
 */
export const patchBuildSchema = z.object({
  patchId: z.string(),
  runId: z.string(),
  environmentId: z.string().nullable(),
  branch: z.string().nullable(),
  note: z.string().nullable(),
  checkedAt: z.string(),
  /** When the run was told (or the result recorded for a run that had ended); null till then. */
  reportedAt: z.string().nullable(),
  environment: environmentViewSchema.nullable(),
});
export type PatchBuild = z.infer<typeof patchBuildSchema>;

/** An artifact a task's runs published or put a new version on, as the task detail lists it.
 * `versions` holds only the versions those runs made. */
export const runArtifactSchema = z.object({
  id: z.string(),
  title: z.string(),
  currentVersion: z.number().int().positive(),
  updatedAt: z.string(),
  versions: z.array(
    z.object({ version: z.number().int().positive(), runId: z.string(), createdAt: z.string() }),
  ),
});
export type RunArtifact = z.infer<typeof runArtifactSchema>;

export const taskDetailSchema = z.object({
  task: z
    .object({
      id: z.string(),
      agentId: z.string(),
      /** Both null while the task waits for its first message, which becomes its instructions;
       * the title is generated once they arrive. */
      spec: z.object({ title: z.string().nullable(), instructions: z.string().nullable() }),
      /** Started without instructions and still waiting for them. When the server leaves it
       * out, null instructions say the same (see `awaitsPrompt`). */
      awaitingPrompt: z.boolean().optional(),
      /** What the task checks out, frozen at creation: one entry per repo. */
      repos: z.array(repoEntrySchema),
      /** The workspace the list came from; null for a single-repo task. */
      workspaceId: z.string().nullable().default(null),
      targetChangeRequest: z.object({ connectedRepoId: z.string(), thread: z.string() })
        .nullable().default(null),
      /** Where each line of each repo stands after the last merge of the run's work there, by
       * checkout path and then line: `work`, the default line, whose landing moves the repo, by
       * its name; any other as `<runId>/<line>`, that run's alone. The change request that merged
       * and the branch the line moved onto. */
      landings: z.record(
        z.string(),
        z.record(
          z.string(),
          z.object({
            connectedRepoId: z.string(),
            thread: z.string(),
            onto: z.string(),
            generation: z.number(),
            /** Whether it moved the repo: off a change request the task worked, or onto another
             * branch. A run's own pull request merged into its own base moves nothing. */
            moved: z.boolean().default(false),
            at: z.string(),
          }),
        ),
      ).default({}),
      /** Who started it: a person, break-glass, a /ryph command on the forge, an automation's
       * fire, or a mention of the bot in a command room. */
      origin: taskOriginSchema,
      /** Set on a task the platform authored: "environment-setup" is "Set up this repo's
       * environment". Null for every other task. */
      purpose: z.enum(["environment-setup"]).nullable().default(null),
      createdAt: z.string(),
    })
    .loose(),
  agent: agentSchema.nullable(),
  /** The task's workspace, resolved; null when it had none or it no longer resolves. */
  workspace: workspaceSchema.nullable().default(null),
  runs: z.array(taskRunSchema),
  patches: z.array(patchSchema).default([]),
  /** The response this task's latest run answers, when an automation opened it as one. */
  response: responseSchema.nullable().default(null),
  /** The environment builds the task's patches asked for, one per checked patch, oldest first. */
  environmentBuilds: z.array(patchBuildSchema).default([]),
  /** Every check suite the task's runs asked for or its patches' heads have, oldest first. */
  checkSuites: z.array(checkSuiteViewSchema).default([]),
  /** The artifacts the task's runs published or put a new version on, oldest first. */
  artifacts: z.array(runArtifactSchema).default([]),
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

/** A response with everything its page shows: the task, the agent, the run, the inbox. */
export const responseDetailSchema = z.object({
  response: responseSchema,
  task: taskDetailSchema.shape.task.nullable().default(null),
  agent: agentSchema.nullable().default(null),
  run: taskRunSchema.omit({ events: true, messages: true }).nullable().default(null),
  messages: z.array(runMessageSchema).default([]),
});
export type ResponseDetail = z.infer<typeof responseDetailSchema>;

/**
 * A chatroom: a bot on a chat platform, held by the chat service. A Telegram room is a bot in one
 * group; a Zulip room is a bot in one organization, a Slack room an app in one workspace and a
 * Discord room a bot in one server, whose channels and conversations within them (Zulip topics,
 * Slack and Discord threads) a run binds to. The platform secrets (a bot token, a Zulip API key,
 * Slack's token pair) never leave the service;
 * `linked` says whether the room can hear and speak yet.
 *
 * `linkCode` is Telegram's one-time code the linking mention must quote — the operator reads it
 * once, puts it in the group, and it is null forever after. The bot's @username is public, so the
 * code is what says which group is the team's. A Zulip, Slack or Discord room is linked from
 * birth: its credential already belongs to one organization, workspace or server.
 */
export const chatroomKindSchema = z.enum(["telegram", "zulip", "slack", "discord"]);
export type ChatroomKind = z.infer<typeof chatroomKindSchema>;

/** Each platform as its own users name it. */
export const CHATROOM_KIND_LABEL: Record<ChatroomKind, string> = {
  telegram: "Telegram",
  zulip: "Zulip",
  slack: "Slack",
  discord: "Discord",
};

/**
 * Whether a room IS one conversation: a Telegram room names no channel, has no groups, and
 * everyone in the group commands it. Every other platform has channels, so a response names one
 * and opens a conversation of its own there (a Zulip topic, a Slack or Discord thread), and a
 * command room can give a channel its own target and its commanders a platform group.
 */
export function isOneConversation(kind: ChatroomKind): boolean {
  return kind === "telegram";
}

/** What one conversation is called on each platform: a Zulip topic, a Slack or Discord thread.
 * A Discord thread is named after the response's topic, as a Zulip topic is. */
export const CONVERSATION_NOUN: Record<ChatroomKind, string> = {
  telegram: "group",
  zulip: "topic",
  slack: "thread",
  discord: "thread",
};

/** What the platform calls the groups a command room's commanders may be: Zulip and Slack user
 * groups, Discord roles. Telegram has none; its entry is never shown. */
export const GROUP_NOUN: Record<ChatroomKind, string> = {
  telegram: "group",
  zulip: "user group",
  slack: "user group",
  discord: "role",
};

export const chatroomSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: chatroomKindSchema,
  botUsername: z.string(),
  linked: z.boolean(),
  chatTitle: z.string().nullable(),
  linkCode: z.string().nullable(),
  /** Zulip only: the organization's root URL, and the bot's email there. Never the key. Null on
   * every other platform, whose room is named by `chatTitle` instead. */
  realmUrl: z.string().nullable(),
  botEmail: z.string().nullable(),
  /** The bot skips its own bookkeeping posts: no "is on it" in a conversation that already
   * exists, and no closing post for a run that succeeded. Failures are still posted. */
  quiet: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type Chatroom = z.infer<typeof chatroomSchema>;

/** Who may read a chat channel: invite-only, anyone in the workspace, or anyone at all. Slack has
 * no web-public tier. */
export const channelVisibilitySchema = z.enum(["private", "public", "web-public"]);
export type ChannelVisibility = z.infer<typeof channelVisibilitySchema>;

/** A channel a command room may give its own target — Zulip's streams, Slack's and Discord's
 * channels, Telegram's one group. `id` is the platform's stable id: a rename keeps it. */
export const chatChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  visibility: channelVisibilitySchema,
});
export type ChatChannel = z.infer<typeof chatChannelSchema>;

/** A platform user group — Zulip's user groups, Slack's usergroups, Discord's roles — what a
 * command room's commanders may be. */
export const chatGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});
export type ChatGroup = z.infer<typeof chatGroupSchema>;

/** One captured moment of a run, from the historian: a transcript block or a diag event. */
export const historyEventSchema = z.object({
  runId: z.string(),
  /** Which transcript of the run: `""` for the run's own, `sa-<n>` for one of its subagents'. */
  lane: z.string(),
  /** Ordered within its lane only: every lane counts its own. */
  seq: z.number().int(),
  at: z.string(),
  voice: z.enum(["transcript", "diag"]),
  kind: z.string(),
  level: z.enum(["debug", "warn"]).nullable(),
  text: z.string().nullable(),
  payload: z.unknown(),
});
export type HistoryEvent = z.infer<typeof historyEventSchema>;

/** Whether a webhook's secret was minted here and shown once, or pasted from the sender. */
export const secretSourceSchema = z.enum(["minted", "pasted"]).default("minted");
export type SecretSource = z.infer<typeof secretSourceSchema>;

/** The payload formats a webhook can be read as, other than a custom mapping. */
export const WEBHOOK_PRESET_FORMATS = [
  "raw",
  "alertmanager",
  "grafana",
  "grafana-irm",
  "pagerduty",
  "opsgenie",
  "sentry",
  "incident-io",
  "datadog",
] as const;
export type WebhookPresetFormat = (typeof WEBHOOK_PRESET_FORMATS)[number];
export type WebhookFormatKind = WebhookPresetFormat | "custom";

/** A custom format: paths into the body, tried in order, and the values that mean each status. */
export const signalMappingSchema = z.object({
  status: z.array(z.string()),
  firing: z.array(z.string()),
  resolved: z.array(z.string()),
  update: z.array(z.string()),
  key: z.array(z.string()),
  title: z.array(z.string()),
});
export type SignalMapping = z.infer<typeof signalMappingSchema>;

export const webhookFormatSchema = z.union([
  z.object({ kind: z.literal("custom"), mapping: signalMappingSchema }),
  z.object({ kind: z.enum(WEBHOOK_PRESET_FORMATS) }),
]);
export type WebhookFormat = z.infer<typeof webhookFormatSchema>;

export const automationTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("webhook"),
    verification: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("hmac-sha256"),
        header: z.string(),
        prefix: z.string(),
        secretSource: secretSourceSchema,
      }),
      z.object({
        kind: z.literal("secret-header"),
        header: z.string(),
        prefix: z.string().default(""),
        secretSource: secretSourceSchema,
      }),
      z.object({ kind: z.literal("standard-webhooks"), secretSource: secretSourceSchema }),
    ]),
    /** How a fire's body is read into a status, a key and a title. */
    format: webhookFormatSchema.default({ kind: "raw" }),
    rateLimit: z.object({ maxPerWindow: z.number(), windowMs: z.number() }),
    /** The ingestion path on the automations service; the origin is deployment config. */
    path: z.string(),
  }),
  z.object({
    kind: z.literal("schedule"),
    cron: z.string(),
    timezone: z.string(),
    nextDueAt: z.string().nullable(),
    lastFiredAt: z.string().nullable(),
  }),
]);
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;

/** What an automation's runs check out: a connected repo at a ref, or a workspace. */
export const automationTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("repo"),
    connectedRepoId: z.string(),
    ref: z.string().nullable(),
  }),
  z.object({ kind: z.literal("workspace"), workspaceId: z.string() }),
]);
export type AutomationTarget = z.infer<typeof automationTargetSchema>;

export const correlationSchema = z.enum(["fire", "automation", "key"]);
export type Correlation = z.infer<typeof correlationSchema>;

/** On a room with channels: each response opens a conversation of its own ("per-response"), or
 * every response continues the one the last was in ("shared" — one topic or thread for a daily
 * schedule). Shared needs a channel, and holds one response at a time, so its correlation is
 * always "automation". */
export const responseConversationSchema = z.enum(["per-response", "shared"]);
export type ResponseConversation = z.infer<typeof responseConversationSchema>;

/** Fires open or join a response instead of starting a run each: which chatroom the run is
 * bound to (null: the run page only), and how long the run waits with nothing said to it
 * before it ends — longer once a person has joined. */
export const responsePolicySchema = z.object({
  chatroomId: z.string().nullable(),
  /** Which open response a later fire joins: none ("fire"), the automation's one, or the one
   * for the same key the format reads out of the body. */
  correlation: correlationSchema.default("automation"),
  /** The channel each response opens its own topic or thread in, by the platform's id. Null
   * for a Telegram room (which has the one conversation) and when no room is bound. */
  channelId: z.string().nullable(),
  idleMs: z.number(),
  attendedIdleMs: z.number(),
  /** The opening message carries the alert that started the conversation. */
  postAlert: z.boolean().default(false),
  conversation: responseConversationSchema.default("per-response"),
});
export type ResponsePolicy = z.infer<typeof responsePolicySchema>;

export const automationSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  trigger: automationTriggerSchema,
  agentId: z.string(),
  target: automationTargetSchema,
  instructions: z.string(),
  response: responsePolicySchema.nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Automation = z.infer<typeof automationSchema>;

/**
 * Who may command a command room: one platform user group, asked live on every mention (Zulip),
 * or everyone in the room — which the door honours only in a private channel.
 */
export const commandRoomCommandersSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("group"), groupId: z.string() }),
  z.object({ kind: z.literal("room") }),
]);
export type CommandRoomCommanders = z.infer<typeof commandRoomCommandersSchema>;

/** One channel's own target, keyed by the platform's stable channel id; the name is display. */
export const commandRoomChannelSchema = z.object({
  channelId: z.string(),
  channelName: z.string(),
  target: automationTargetSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CommandRoomChannel = z.infer<typeof commandRoomChannelSchema>;

/**
 * A command room: the policy on a chatroom that lets a mention of the bot START a run, kept by
 * the control plane. Runs act for `ownerUserId` (the admin who saved it). A mention's target is
 * its channel's row, else `defaultTarget`, else the channel is not served.
 */
export const commandRoomSchema = z.object({
  chatroomId: z.string(),
  ownerUserId: z.string(),
  agentIds: z.array(z.string()),
  defaultAgentId: z.string(),
  defaultTarget: automationTargetSchema.nullable(),
  commanders: commandRoomCommandersSchema,
  startsPerHour: z.number(),
  channels: z.array(commandRoomChannelSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CommandRoom = z.infer<typeof commandRoomSchema>;

export const automationFireSchema = z.object({
  id: z.string(),
  automationId: z.string(),
  outcome: z.string(),
  taskId: z.string().nullable(),
  runId: z.string().nullable(),
  detail: z.string().nullable(),
  firedAt: z.string(),
});
export type AutomationFire = z.infer<typeof automationFireSchema>;

// ── memory ─────────────────────────────────────────────────────────────────────────────────────

export const memoryKindSchema = z.enum([
  "fact",
  "procedure",
  "gotcha",
  "decision",
  "preference",
  "pointer",
]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

export const memoryStatusSchema = z.enum(["canon", "needs-verification", "retired"]);
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;

export const memoryTrustSchema = z.enum(["pinned", "human", "ingested", "agent"]);
export type MemoryTrust = z.infer<typeof memoryTrustSchema>;

/** What a claim is about: the org, or one repository in its canonical spelling. */
export const memorySubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("org") }),
  z.object({ kind: z.literal("repo"), url: z.string() }),
]);
export type MemorySubject = z.infer<typeof memorySubjectSchema>;

/** Who a claim is for: every agent, or one. */
export const memoryAudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("agent"), agentId: z.string() }),
]);
export type MemoryAudience = z.infer<typeof memoryAudienceSchema>;

export const memoryProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run"),
    runId: z.string(),
    taskId: z.string(),
    proposalId: z.string(),
  }),
  z.object({ kind: z.literal("source"), sourceId: z.string(), section: z.string().nullable() }),
  z.object({ kind: z.literal("human"), userId: z.string() }),
]);
export type MemoryProvenance = z.infer<typeof memoryProvenanceSchema>;

export const memoryEvidenceSchema = z.object({ sha: z.string(), paths: z.array(z.string()) });

/** The score broken into its terms — every one a column the service keeps. `total` is -1 for a
 * pinned memory: infinite on the service, always briefed first. */
export const memoryScoreSchema = z.object({
  trust: z.number(),
  votes: z.number(),
  decay: z.number(),
  relevance: z.number(),
  ageDays: z.number(),
  total: z.number(),
});
export type MemoryScore = z.infer<typeof memoryScoreSchema>;

/** One memory as the API answers it: the claim, its axes, its counters, and its score. */
export const memorySchema = z.object({
  id: z.string(),
  text: z.string(),
  kind: memoryKindSchema,
  subject: memorySubjectSchema,
  audience: memoryAudienceSchema,
  status: memoryStatusSchema,
  trust: memoryTrustSchema,
  provenance: memoryProvenanceSchema,
  evidence: memoryEvidenceSchema.nullable(),
  supersedes: z.string().nullable(),
  supersededBy: z.string().nullable(),
  confirmations: z.number(),
  refutations: z.number(),
  briefedCount: z.number(),
  briefedSuccesses: z.number(),
  lastBriefedAt: z.string().nullable(),
  lastConfirmedAt: z.string().nullable(),
  lastRefutedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  score: memoryScoreSchema,
  /** "3d ago", as the service renders it in a brief. */
  age: z.string(),
});
export type Memory = z.infer<typeof memorySchema>;

/** One entry of the signal log, as it came in. The kind-specific fields ride loosely.
 * `sweep` is the consolidator retiring a memory nothing used, and carries its own reason. */
export const memoryFeedbackSchema = z
  .object({
    kind: z.enum(["confirm", "refute", "briefed", "outcome", "stale", "sweep", "human"]),
    at: z.string(),
    runId: z.string().nullable().optional(),
    userId: z.string().optional(),
    reason: z.string().optional(),
    action: z.string().optional(),
    status: z.string().optional(),
    replacementProposalId: z.string().nullable().optional(),
    /** On a `confirm`: the commit it moved the memory's evidence to, if it moved one. */
    reanchoredTo: z.string().nullable().optional(),
  })
  .loose();
export type MemoryFeedback = z.infer<typeof memoryFeedbackSchema>;

/** A run a memory was briefed into, as memory recorded it. */
export const memoryRunSchema = z.object({
  runId: z.string(),
  /** The task the run belongs to — where a person reads it. */
  taskId: z.string(),
  agentId: z.string(),
  /** The run's repos, canonical; empty for a run with no repo subject. */
  repos: z.array(z.string()),
  briefed: z.array(z.string()),
  outcome: z.string().nullable(),
  createdAt: z.string(),
});
export type MemoryRun = z.infer<typeof memoryRunSchema>;

export const memoryDetailSchema = z.object({
  memory: memorySchema,
  feedback: z.array(memoryFeedbackSchema),
  supersedes: memorySchema.nullable(),
  supersededBy: memorySchema.nullable(),
  runs: z.array(memoryRunSchema),
});
export type MemoryDetail = z.infer<typeof memoryDetailSchema>;

export const memoryProposalStatusSchema = z.enum(["pending", "merged", "promoted", "rejected"]);
export type MemoryProposalStatus = z.infer<typeof memoryProposalStatusSchema>;

export const memoryBasisSchema = z.enum(["observed", "introduced"]);
export type MemoryBasis = z.infer<typeof memoryBasisSchema>;

export const memoryChangeFateSchema = z.enum(["pending", "landed", "dropped"]);
export type MemoryChangeFate = z.infer<typeof memoryChangeFateSchema>;

/** The patch an `introduced` claim waits on: the claim holds once it (or a later patch of the
 * same branch) lands, and is dropped once every one of those settled without landing. */
export const memoryChangeSchema = z.object({
  patchId: z.string(),
  forgeUrl: z.string().nullable(),
  fate: memoryChangeFateSchema,
});
export type MemoryChange = z.infer<typeof memoryChangeSchema>;

/** One row of the inbox: what an agent (or a person) proposed, and what became of it. */
export const memoryProposalSchema = z.object({
  id: z.string(),
  text: z.string(),
  kind: memoryKindSchema.nullable(),
  subject: memorySubjectSchema.nullable(),
  audience: memoryAudienceSchema.nullable(),
  evidence: memoryEvidenceSchema.nullable(),
  origin: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("run"), runId: z.string(), taskId: z.string() }),
    z.object({ kind: z.literal("source"), sourceId: z.string(), section: z.string().nullable() }),
    z.object({ kind: z.literal("human"), userId: z.string() }),
  ]),
  supersedes: z.string().nullable(),
  /** What the claim rests on: found already true, or made true by the run's own change. */
  basis: memoryBasisSchema,
  status: memoryProposalStatusSchema,
  resolution: z
    .union([
      z.object({ memoryId: z.string(), refines: z.string().optional() }),
      z.object({ reason: z.string() }),
    ])
    .nullable(),
  flags: z.array(z.enum(["instruction-shaped", "secret-shaped", "contradicts"])),
  /** For an introduced claim: the patch it waits on and what became of it; null for a claim
   * that rests on nothing a run changed. */
  change: memoryChangeSchema.nullable(),
  createdAt: z.string(),
});
export type MemoryProposal = z.infer<typeof memoryProposalSchema>;

export const memorySourceKindSchema = z.enum(["paste", "upload", "url", "repo-file"]);
export type MemorySourceKind = z.infer<typeof memorySourceKindSchema>;

/** How a source's extraction went, once it has. */
export const memoryIngestStatsSchema = z.object({
  sections: z.number(),
  extracted: z.number(),
  failed: z.number(),
  retired: z.number(),
  modelBacked: z.boolean(),
});
export type MemoryIngestStats = z.infer<typeof memoryIngestStatsSchema>;

export const memorySourceStatusSchema = z.enum(["ingesting", "ready", "failed"]);

/** A document a person handed to memory, as the listing answers it: no text, its length.
 * `ingesting` while the extractor still works behind it, `ready` with the stats once the batch
 * is in, `failed` with why. */
export const memorySourceSchema = z.object({
  id: z.string(),
  kind: memorySourceKindSchema,
  status: memorySourceStatusSchema,
  extraction: memoryIngestStatsSchema.nullable(),
  failure: z.string().nullable(),
  title: z.string(),
  locator: z.string().nullable(),
  contentHash: z.string(),
  defaultSubject: memorySubjectSchema,
  ingestedBy: z.string(),
  ingestedAt: z.string(),
  supersedesSourceId: z.string().nullable(),
  chars: z.number(),
});
export type MemorySource = z.infer<typeof memorySourceSchema>;

export const memorySourceDetailSchema = z.object({
  source: memorySourceSchema.omit({ chars: true }).extend({ text: z.string() }),
  sections: z.array(z.object({ title: z.string(), text: z.string() })),
  proposals: z.array(z.lazy(() => memoryProposalSchema)),
  memories: z.array(memorySchema),
});
export type MemorySourceDetail = z.infer<typeof memorySourceDetailSchema>;

/** What moving a source to another subject did: its waiting batch and its live memories now
 * carry that subject. */
export const memorySourceMoveSchema = z.object({
  sourceId: z.string(),
  subject: memorySubjectSchema,
  proposals: z.number(),
  memories: z.number(),
});
export type MemorySourceMove = z.infer<typeof memorySourceMoveSchema>;

/** What withdrawing a source did: its waiting batch rejected, its memories retired, the pinned
 * ones kept. */
export const memorySourceWithdrawalSchema = z.object({
  sourceId: z.string(),
  rejected: z.number(),
  retired: z.number(),
  kept: z.number(),
});
export type MemorySourceWithdrawal = z.infer<typeof memorySourceWithdrawalSchema>;

/** What an ingest answers at once: the source, admitted and ingesting. The batch lands behind
 * it; the listing and the detail show the status. */
export const memoryIngestStartedSchema = z.object({
  source: memorySourceSchema.omit({ chars: true }).extend({ text: z.string() }),
});
export type MemoryIngestStarted = z.infer<typeof memoryIngestStartedSchema>;

/** Enough to notice a subject that is rotting: counts per subject, and the inbox's state. */
export const memoryHealthSchema = z.object({
  subjects: z.array(
    z.object({
      subject: memorySubjectSchema,
      canon: z.number(),
      needsVerification: z.number(),
      retired: z.number(),
      neverBriefed: z.number(),
      contested: z.number(),
    }),
  ),
  inbox: z.object({
    pending: z.number(),
    flagged: z.number(),
    contradicting: z.number(),
    awaiting: z.number(),
    oldestAt: z.string().nullable(),
  }),
  modelBacked: z.boolean(),
  embeddings: z
    .object({ model: z.string(), embedded: z.number(), pending: z.number() })
    .nullable()
    .default(null),
});
export type MemoryHealth = z.infer<typeof memoryHealthSchema>;

/** The topic index: how many memories per subject, kind and status. */
export const memorySubjectCountSchema = z.object({
  subject: memorySubjectSchema,
  kind: memoryKindSchema,
  status: memoryStatusSchema,
  count: z.number(),
});
export type MemorySubjectCount = z.infer<typeof memorySubjectCountSchema>;

/** A subject as a stable string key, the service's spelling: `org` or `repo:<url>`. */
export function memorySubjectKey(subject: MemorySubject): string {
  return subject.kind === "org" ? "org" : `repo:${subject.url}`;
}

// ── skills ────────────────────────────────────────────────────────────────────────────────────

/** The optional frontmatter fields a skill carries, as the orchestrator validated them. Shown,
 * never enforced: `allowedTools` in particular binds neither ryph nor the harness. */
export const skillFrontmatterSchema = z.object({
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  allowedTools: z.string().optional(),
});
export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

/** Something about one path of a skills tree that a person should fix, as a sync judged it. */
export const skillWarningSchema = z.object({
  /** Relative to `.agents/skills/` (`release/SKILL.md`). */
  path: z.string(),
  message: z.string(),
});
export type SkillWarning = z.infer<typeof skillWarningSchema>;

/** A skill's icon, inline: `data` is the file's bytes, base64, and `mime` was read from those
 * bytes. Shown only as an image, never as markup. `data` is held to the base64 alphabet, so it
 * can never close the CSS `url("…")` it is placed in. */
export const skillIconSchema = z.object({
  mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]),
  data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export type SkillIcon = z.infer<typeof skillIconSchema>;

/**
 * How the skills page shows a skill, from its `agents/openai.yaml` and frontmatter metadata. Null
 * fields are not set. Every string is plain text, never markup. `implicitInvocation` is not
 * enforced: every skill a run is given is listed to the model.
 */
export const skillPresentationSchema = z.object({
  displayName: z.string().nullable(),
  shortDescription: z.string().nullable(),
  /** `#RRGGBB`. */
  brandColor: z.string().nullable(),
  defaultPrompt: z.string().nullable(),
  implicitInvocation: z.boolean(),
  author: z.string().nullable(),
  version: z.string().nullable(),
  /** The overview carries only `iconSmall` (`iconLarge` is null there); a skill's own page carries
   * both, each already standing in for the other when only one is set. */
  iconSmall: skillIconSchema.nullable(),
  iconLarge: skillIconSchema.nullable(),
});
export type SkillPresentation = z.infer<typeof skillPresentationSchema>;

/** One of ryph's own skills, with whether an admin left it on for the deployment. */
export const catalogueSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** `sha256:<hex>` of the skill's files: its version. */
  digest: z.string(),
  bytes: z.number(),
  files: z.array(z.object({ path: z.string(), bytes: z.number() })),
  frontmatter: skillFrontmatterSchema,
  /** Null when the skill sets none. */
  presentation: skillPresentationSchema.nullable().default(null),
  enabled: z.boolean(),
});
export type CatalogueSkill = z.infer<typeof catalogueSkillSchema>;

/** One skill of the org repo's current version. */
export const orgSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  digest: z.string(),
  frontmatter: skillFrontmatterSchema,
  presentation: skillPresentationSchema.nullable().default(null),
});
export type OrgSkill = z.infer<typeof orgSkillSchema>;

export const skillSyncTriggerSchema = z.enum(["connect", "push", "manual", "reconcile"]);
export type SkillSyncTrigger = z.infer<typeof skillSyncTriggerSchema>;

/** Why a read of the org skills repo failed. `missing-ref` is the branch (or repo) gone. */
export const skillSyncFailureSchema = z.enum(["unavailable", "missing-ref", "invalid", "error"]);
export type SkillSyncFailure = z.infer<typeof skillSyncFailureSchema>;

/**
 * One read of the org skills repo that changed something: a new version, or a failure. A read
 * that found what runs already get is not a row. `superseded` is a read that lost a race to a
 * newer one or to an admin's change, and moved nothing. A repeated identical failure is one row
 * with a count.
 */
export const skillSyncSchema = z.object({
  id: z.string(),
  connectedRepoId: z.string(),
  /** The repo's address as it stands; null for a repo no longer in the connected list. */
  repoRef: z.string().nullable().default(null),
  branch: z.string(),
  trigger: skillSyncTriggerSchema,
  outcome: z.enum(["synced", "superseded", "failed"]),
  failure: skillSyncFailureSchema.nullable(),
  rulesVersion: z.number(),
  commit: z.string().nullable(),
  treeId: z.string().nullable(),
  skillCount: z.number(),
  warnings: z.array(skillWarningSchema),
  error: z.string().nullable(),
  repeats: z.number(),
  requestedBy: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string(),
});
export type SkillSync = z.infer<typeof skillSyncSchema>;

/** The org skills repo as the skills page reads it. */
export const orgSkillsRepoSchema = z.object({
  repo: z.object({
    id: z.string(),
    provider: forgeProviderSchema,
    repoRef: z.string(),
    url: z.string(),
    defaultBranch: z.string(),
  }),
  /** The branch an admin named; null reads the repo's default branch. */
  branch: z.string().nullable(),
  effectiveBranch: z.string(),
  /** The version runs get; null until a sync read the repo. */
  current: z.object({
    syncId: z.string(),
    commit: z.string().nullable(),
    syncedAt: z.string(),
    /** Every warning of the version, about skills and about directories that never became one. */
    warnings: z.array(skillWarningSchema),
    skills: z.array(orgSkillSchema),
  }).nullable(),
  /** When the repo was last asked, and the commit it answered with. */
  checkedAt: z.string().nullable(),
  checkedCommit: z.string().nullable(),
  /** The latest read failed after the current version: runs are on the last good one. */
  stale: z.boolean(),
  /** The failure still standing, when the latest read failed. */
  lastFailure: z.object({
    kind: skillSyncFailureSchema.nullable(),
    error: z.string().nullable(),
    repeats: z.number(),
    at: z.string(),
  }).nullable(),
  /** The connected repo was disconnected: runs get no org skills until an admin picks again. */
  archived: z.boolean(),
});
export type OrgSkillsRepo = z.infer<typeof orgSkillsRepoSchema>;

/** Everything the skills page and the agent editor read, as `GET /v1/skills` answers it. */
export const skillsOverviewSchema = z.object({
  catalogue: z.array(catalogueSkillSchema),
  org: orgSkillsRepoSchema.nullable(),
  /** Whether runs may load the skills of the repos they work on. */
  workingRepoSkills: z.boolean(),
  /** How many skills one run lists, and how many bytes of names and descriptions. */
  limits: z.object({ skills: z.number(), listingBytes: z.number() }),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export type SkillsOverview = z.infer<typeof skillsOverviewSchema>;

/** What a connect or a Sync now did. `sync` is the row it recorded, when it recorded one. */
export const skillSyncAnswerSchema = z.object({
  outcome: z.enum(["synced", "up-to-date", "failed", "superseded", "not-connected"]),
  sync: skillSyncSchema.nullable(),
});
export type SkillSyncAnswer = z.infer<typeof skillSyncAnswerSchema>;

/** One file of a skill: its text when it is UTF-8, its size always. */
export const skillFileSchema = z.object({
  path: z.string(),
  executable: z.boolean(),
  bytes: z.number(),
  /** Null for a file that is not text. */
  text: z.string().nullable(),
});
export type SkillFile = z.infer<typeof skillFileSchema>;

/** One version of an org skill: consecutive syncs that held the same files. Newest first. */
export const skillVersionSchema = z.object({
  digest: z.string(),
  description: z.string(),
  firstSync: z.object({ id: z.string(), commit: z.string().nullable(), at: z.string() }),
  lastSync: z.object({ id: z.string(), commit: z.string().nullable(), at: z.string() }),
});
export type SkillVersion = z.infer<typeof skillVersionSchema>;

export const catalogueSkillDetailSchema = z.object({
  skill: catalogueSkillSchema,
  files: z.array(skillFileSchema),
});
export type CatalogueSkillDetail = z.infer<typeof catalogueSkillDetailSchema>;

export const orgSkillDetailSchema = z.object({
  skill: orgSkillSchema.extend({ warnings: z.array(skillWarningSchema) }),
  files: z.array(skillFileSchema),
  versions: z.array(skillVersionSchema),
});
export type OrgSkillDetail = z.infer<typeof orgSkillDetailSchema>;

/** One version's files, by digest. */
export const skillBundleSchema = z.object({
  digest: z.string(),
  bytes: z.number(),
  files: z.array(skillFileSchema),
});
export type SkillBundleView = z.infer<typeof skillBundleSchema>;

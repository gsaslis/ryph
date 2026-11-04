// The drizzle schema — the source of truth for the database. Applying it is drizzle-kit's job:
// `bun run db:push` locally and in tests; generated migrations arrive when we first deploy.
//
// Everything a UI will sort or filter on is a real column; JSON columns are reserved for
// polymorphic wire payloads the orchestrator carries but never queries into (the frozen
// work item, the injected context, the runner's result). Timestamps are ISO-8601 text,
// matching the core types verbatim (and sorting correctly as text).
//
// Column names mirror core/types.ts field names exactly where a table maps to a core type,
// so agents and runs rows ARE core `Agent`/`Run` structurally and need no mapping.

import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import type {
  Attachment,
  AttachmentRef,
  AutomationEventOutcome,
  ChatMentionOutcome,
  CommandRoom,
  CommandRoomChannel,
  CommitInfo,
  ConnectedRepo,
  DeclaredOutcome,
  EgressRefusal,
  EnvironmentBuildPlan,
  EnvironmentStatus,
  EnvironmentSubjectKind,
  EnvironmentTrigger,
  ForgeEventOutcome,
  ForgePolicy,
  ForgeToolAction,
  InjectedContext,
  MemoryPolicy,
  ModelPolicy,
  NetworkPolicy,
  PatchApprover,
  PatchFate,
  PatchHookCheck,
  PatchState,
  Phase,
  ProgressComment,
  RepoEntry,
  Response,
  RunEnvironment,
  RunEnvironmentWait,
  RunEvent,
  RunForgeScope,
  RunLifetime,
  RunLimits,
  RunMessage,
  RunModelScope,
  RunnerResult,
  RunNetworkScope,
  RunServices,
  RunSkills,
  RunState,
  RunToolScope,
  ServiceSpec,
  SkillPolicy,
  SystemPayload,
  Task,
  TaskPurpose,
  ToolPolicy,
  WorkItem,
} from "../../../core/types.ts";
import type { BackgroundEndReason } from "../../../core/background.ts";
import type {
  CheckApprovalState,
  CheckPodState,
  CheckRequest,
  CheckResultState,
  ChecksDeclaration,
  CheckSource,
  CheckSuiteState,
} from "../../../core/check_types.ts";
import type {
  SkillFile,
  SkillFrontmatter,
  SkillIcons,
  SkillPresentation,
  SkillSync,
  SkillSyncFailure,
  SkillSyncTrigger,
  SkillWarning,
} from "../../../core/skills.ts";
import type { SetupWarning } from "../../../core/setup_warnings.ts";

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // The unique command address (`/ryph ada …`). Nullable for rows born before handles;
  // Postgres unique indexes admit any number of NULLs, so legacy rows coexist fine.
  handle: text("handle"),
  email: text("email").notNull(),
  systemPrompt: text("system_prompt"),
  // Which pre-baked agent-container image runs this agent, resolved via the image map.
  harnessKind: text("harness_kind").notNull(),
  // Which provider key this agent spends and on which models — ids and names only, never a
  // secret (those live sealed in the model-proxy's tables). JSON: carried, never queried into.
  modelPolicy: jsonb("model_policy").$type<ModelPolicy>(),
  // Which MCP servers this agent may reach and which tools it may call — server ids and tool
  // names only, never a secret (those live sealed in the mcp-gateway's tables). Same rule.
  toolPolicy: jsonb("tool_policy").$type<ToolPolicy>(),
  // Whether and how much this agent remembers: the brief's token budget. Null: memory off.
  memoryPolicy: jsonb("memory_policy").$type<MemoryPolicy>(),
  // Which forge actions this agent may take and where — connected repo ids, caps and label
  // names only. Null: no forge tools.
  forgePolicy: jsonb("forge_policy").$type<ForgePolicy>(),
  // Which skills this agent's runs may load, as switches over the deployment's — skill names
  // only. Null: the defaults, every skill the deployment allows.
  skillPolicy: jsonb("skill_policy").$type<SkillPolicy>(),
  // Where this agent's runs may reach on the internet — bundle names and hostnames, nothing
  // secret and nothing resolved. Null means the deployment's ceiling, NOT none: see core/types.ts
  // on why this one policy's null reads the opposite way to its siblings'.
  networkPolicy: jsonb("network_policy").$type<NetworkPolicy>(),
  // This agent's default run limits under the operator's ceiling — three numbers, nothing
  // secret. Null means the ceiling's values.
  limitPolicy: jsonb("limit_policy").$type<RunLimits>(),
  // Whether this agent's runs may open patches at all.
  canOpenPatches: boolean("can_open_patches").notNull().default(true),
  // Whether this agent's runs may publish artifacts (core/artifacts.ts).
  canPublishArtifacts: boolean("can_publish_artifacts").notNull().default(false),
  // Whether this agent's runs get a browser sidecar, where the deployment can give one.
  browserEnabled: boolean("browser_enabled").notNull().default(false),
  // Soft delete only: historical tasks/runs keep resolving their agent.
  archivedAt: text("archived_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("agents_by_harness_kind").on(t.harnessKind),
  uniqueIndex("agents_by_handle").on(t.handle),
]);

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  // Both null while the task awaits its prompt: it was started without instructions, and the
  // first message to its run sets them, together, once (`claimTaskPrompt`). The instructions'
  // null IS the awaiting flag — a second column could only disagree with it.
  specTitle: text("spec_title"),
  specInstructions: text("spec_instructions"),
  // The user-facing repo truth, one entry per repo of the checkout: the upstream URLs and
  // user-named refs, frozen at creation like the work item (the gateway-shaped clone URLs live
  // only on the run's frozen WorkItem). JSON because it is a snapshot the UI shows and never
  // filters on — which repo a task touched is the patches table's question, by design.
  repos: jsonb("repos").$type<RepoEntry[]>().notNull(),
  // The workspace the list came from, for display. Null for a single-repo task.
  workspaceId: text("workspace_id").references(() => workspaces.id),
  // "break-glass" is a POSITIVE audit fact, never a null.
  origin: text("origin").$type<Task["origin"]>().notNull().default("user"),
  requestedByUserId: text("requested_by_user_id"),
  // A chat task's commander ({ name }), shown in provenance; null for every other origin.
  requestedVia: jsonb("requested_via").$type<Task["requestedVia"]>(),
  // A chat task's conversation key (Task.chatConversation); null for every other.
  chatConversation: text("chat_conversation"),
  // Set: the task works ON this change request of one of its repos, whose patch updates that
  // change request instead of opening a new one. A tiny pair, queried into only to find who
  // works a change request that merged (`tasks_by_target_change_request`).
  targetChangeRequest: jsonb("target_change_request").$type<Task["targetChangeRequest"]>(),
  // Where each repo stands after its last merge (Task.landings), by checkout path: carried,
  // never queried into.
  landings: jsonb("landings").$type<Task["landings"]>(),
  // How long the run lives past the agent's settles: its idle clocks.
  lifetime: jsonb("lifetime").$type<RunLifetime>().notNull(),
  // Set only on a task the platform authored ("environment-setup"); null for every other.
  purpose: text("purpose").$type<TaskPurpose>(),
  // The task's current attempt, denormalized off the runs table — the same trick `runs.agent_id`
  // and `runs.origin_thread_*` play, and for the same reason. A list that shows every task's state
  // (which is every list we have) otherwise reads the newest run PER ROW, and a filter on that
  // state is a correlated subquery no index can serve. Here it is one indexed scan, and the N+1
  // the list handler used to do disappears with it.
  //
  // Written ONLY by the store: `createTask` sets these from the first run, `saveRun` and
  // `markRunAttended` follow it, both conditioned on `current_run_id` so a write about an older
  // attempt can never roll the row back to it. Nothing outside adapters/store may write them.
  currentRunId: text("current_run_id").notNull(),
  currentRunState: text("current_run_state").$type<RunState>().notNull(),
  currentRunPhase: text("current_run_phase").$type<Phase>(),
  currentRunIdleState: text("current_run_idle_state").$type<"idle" | "waiting-for-user">(),
  // The last time anything about the task moved — its run's `updatedAt`, which a heartbeat
  // advances. `created_at` is when it was asked for; this is when it was last alive.
  // Still `updatedAt` and not `runs.launched_at`: that one is stamped ONCE, when the container
  // came up, so a row would freeze there for the whole run.
  lastActivityAt: text("last_activity_at").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  // Every index here carries `(created_at, id)` as its tail, because that pair IS the list's
  // sort key and its keyset cursor: a filtered page is then one range scan that stops after
  // `limit` rows, at any depth, instead of a sort over everything the filter matched.
  index("tasks_by_agent").on(t.agentId, t.createdAt, t.id),
  index("tasks_by_created_at").on(t.createdAt, t.id),
  index("tasks_by_workspace").on(t.workspaceId, t.createdAt, t.id),
  index("tasks_by_state").on(t.currentRunState, t.createdAt, t.id),
  index("tasks_by_origin").on(t.origin, t.createdAt, t.id),
  index("tasks_by_requester").on(t.requestedByUserId, t.createdAt, t.id),
  // "Which tasks touched this repo", as a containment lookup into the frozen list —
  // `repos @> '[{"connectedRepoId": "..."}]'`. jsonb_path_ops because containment is the only
  // question asked of it, and that operator class is the smaller, faster index for exactly that.
  index("tasks_by_repo").using("gin", t.repos.op("jsonb_path_ops")),
  // The search box, as full text over the title — the same expression index the memory canon
  // uses, and for the same reason: it needs no extension, so no deployment has to provide one
  // (a trigram index would, and PGlite ships without contrib). Words, therefore, not substrings;
  // `listTasks` matches them as prefixes so a half-typed word still finds the row.
  index("tasks_fts").using("gin", sql`to_tsvector('english', ${t.specTitle})`),
  // Who works a change request (listTasksTargetingChangeRequest), asked on every merge the forge
  // delivers: partial, so it holds only the tasks that target one.
  index("tasks_by_target_change_request")
    .on(
      sql`(${t.targetChangeRequest} ->> 'connectedRepoId')`,
      sql`(${t.targetChangeRequest} ->> 'thread')`,
    )
    .where(sql`${t.targetChangeRequest} is not null`),
]);

// The forge's per-user answer to "may they write this repo", cached so that reading the task
// list does not ask the forge once per repo per request; every write still asks it live.
export const repoAccess = pgTable("repo_access", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  connectedRepoId: text("connected_repo_id").notNull(),
  writable: boolean("writable").notNull(),
  checkedAt: text("checked_at").notNull(),
}, (t) => [
  uniqueIndex("repo_access_by_user_repo").on(t.userId, t.connectedRepoId),
]);

// A saved grouping of connected repos that belong together. Archived like an agent.
export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  // A size class NAME, never its quantities: the classes are configuration (RYPH_RUN_SIZES), so
  // a renamed class degrades to the default at the next run instead of freezing stale numbers.
  sizeClass: text("size_class"),
  // The member whose Dockerfile defines the workspace's machine; null (or a repo that left) is
  // the first member. Not a foreign key: a member leaving must not be blocked by it.
  environmentRepoId: text("environment_repo_id"),
  archivedAt: text("archived_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// One repo's membership in a workspace. The UNIQUE index on the connected repo is the rule
// that a repo belongs to at most one workspace — what makes "the workspace holding this repo"
// a question with one answer for the forge's `/ryph` expansion. `path` is unique within the
// workspace: it is the directory the repo is checked out under, and how the agent addresses it.
export const workspaceRepos = pgTable("workspace_repos", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  connectedRepoId: text("connected_repo_id").notNull().references(() => connectedRepos.id),
  ref: text("ref"),
  path: text("path").notNull(),
  description: text("description"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("workspace_repos_by_connected_repo").on(t.connectedRepoId),
  uniqueIndex("workspace_repos_by_path").on(t.workspaceId, t.path),
  index("workspace_repos_by_workspace").on(t.workspaceId, t.createdAt),
]);

// A GitHub App installation — the tenant. Recorded when the install flow lands back on us.
export const githubInstallations = pgTable("github_installations", {
  id: text("id").primaryKey(),
  // GitHub's numeric id, as text: it rides URLs and API calls, and is never done math on.
  installationId: text("installation_id").notNull(),
  accountLogin: text("account_login").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("github_installations_by_installation_id").on(t.installationId),
]);

// A repo connected by an admin. Coordinates and policy ONLY — permissions are checked live
// against the forge, never mirrored (a stale permission row is a security bug, not a slow
// cache). `provider` picks the adapter; `repo_ref` is that forge's own address for the repo,
// opaque to everything outside it. `installation_id` is GitHub's tenant and is NULL for a
// forge that has none.
export const connectedRepos = pgTable("connected_repos", {
  id: text("id").primaryKey(),
  provider: text("provider").$type<ConnectedRepo["provider"]>().notNull(),
  installationId: text("installation_id"),
  repoRef: text("repo_ref").notNull(),
  url: text("url").notNull(),
  defaultBranch: text("default_branch").notNull(),
  submissionPolicy: text("submission_policy").$type<ConnectedRepo["submissionPolicy"]>()
    .notNull().default("require-approval"),
  // As on workspaces: a class name, null for the deployment's default.
  sizeClass: text("size_class"),
  // Off unless a repo admin turns it on: whether runs may push onto fork pull requests' branches.
  allowForkPushes: boolean("allow_fork_pushes").notNull().default(false),
  archivedAt: text("archived_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("connected_repos_by_installation").on(t.installationId),
  index("connected_repos_by_repo_ref").on(t.provider, t.repoRef),
]);

// A connected GitLab project's identity and webhook state (core/types.ts `GitlabProject`): one
// row per connected repo, keyed by it. Not on `connected_repos` itself because the hook columns
// are written on their own — a delivery's arrival, a rotation — and a full-row write of the repo
// (a policy edit) must never put an older generation back. Indexed by project id, which is how
// an event finds its repo.
export const gitlabProjects = pgTable("gitlab_projects", {
  connectedRepoId: text("connected_repo_id").primaryKey().references(() => connectedRepos.id),
  projectId: text("project_id").notNull(),
  // The GitLab instance the id is on: ids are per instance (core/types.ts `GitlabProject`).
  instance: text("instance").notNull(),
  hookGeneration: integer("hook_generation").notNull(),
  lastHookAt: text("last_hook_at"),
  lastMergeRequestHookAt: text("last_merge_request_hook_at"),
  // Drops over the door's budgets (core/types.ts `GitlabProject`): comments, and every other event.
  droppedCommentHookCount: integer("dropped_comment_hook_count").notNull().default(0),
  droppedOtherHookCount: integer("dropped_other_hook_count").notNull().default(0),
  lastDroppedHookAt: text("last_dropped_hook_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [index("gitlab_projects_by_project").on(t.projectId)]);

// Who — beside whoever the forge itself reports write access for — an admin has allowed to
// command agents in one connected repo. It exists because not every forge HAS a write tier to
// borrow: Radicle knows delegates and nothing between them and a stranger.
export const repoCommandAllowlist = pgTable("repo_command_allowlist", {
  connectedRepoId: text("connected_repo_id").notNull().references(() => connectedRepos.id),
  provider: text("provider").$type<ConnectedRepo["provider"]>().notNull(),
  subject: text("subject").notNull(),
  addedBy: text("added_by").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("repo_command_allowlist_entry").on(t.connectedRepoId, t.provider, t.subject),
  index("repo_command_allowlist_by_repo").on(t.connectedRepoId, t.createdAt),
]);

// One run's output on its way to the forge. The state machine is core/patch_lifecycle.ts;
// this row is the dumb holder it hands results to. `run_events` carries the story.
export const patches = pgTable("patches", {
  id: text("id").primaryKey(),
  connectedRepoId: text("connected_repo_id").notNull().references(() => connectedRepos.id),
  runId: text("run_id").notNull().references(() => runs.id),
  taskId: text("task_id").notNull().references(() => tasks.id),
  // Every patch born from one finalize shares a set id; a single-repo run's is a set of one.
  setId: text("set_id").notNull(),
  // The repo's directory in the run's checkout — how the run addressed it.
  path: text("path").notNull(),
  // The line of the run's work in this repo (Patch.line): with the path and the generation, what
  // names one stream of work. Defaulted only so the column could be added to existing rows.
  line: text("line").notNull().default("work"),
  branchName: text("branch_name").notNull(),
  headSha: text("head_sha").notNull(),
  // What the runner reported at submit: the commit the bundle was cut from (null for a patch
  // born from a result), the generation of the branch, and the agent's own title/description.
  baseSha: text("base_sha"),
  generation: integer("generation").notNull().default(1),
  title: text("title"),
  description: text("description"),
  // The branch's commits, carried for the pull request's report, never queried into.
  commits: jsonb("commits").$type<CommitInfo[]>().notNull().default([]),
  // The run's earlier patch ids whose work this one carries (Patch.carries), for memory.
  carries: jsonb("carries").$type<string[]>().notNull().default([]),
  bundleKey: text("bundle_key").notNull(),
  state: text("state").$type<PatchState>().notNull(),
  attempts: integer("attempts").notNull(),
  nextAttemptAt: text("next_attempt_at"),
  leaseExpiresAt: text("lease_expires_at"),
  lastError: text("last_error"),
  // A tiny union ({kind:"user",userId} | {kind:"break-glass"}), carried but never queried into.
  approvedBy: jsonb("approved_by").$type<PatchApprover>(),
  approvedAt: text("approved_at"),
  forgeRef: text("forge_ref"),
  forgeUrl: text("forge_url"),
  // The branch the forge holds the submitted commits on (Patch.forgeBranch); null until then.
  forgeBranch: text("forge_branch"),
  // The ref its diff was measured against when it was sent (Patch.diffRef).
  diffRef: text("diff_ref"),
  // {kind:"merged"|"missed"|"closed", at, mergedInto?, unproven?}: the forge's verdict.
  landed: jsonb("landed").$type<PatchFate>(),
  supersededByPatchId: text("superseded_by_patch_id"),
  // When memory acknowledged this patch's fate. Nullable, and null for every row that predates
  // the column: "not reported yet" is exactly what the reconciliation sweep looks for, and a
  // settled patch it redelivers is absorbed on the memory side (reportChange settles once).
  memoryFateReportedAt: text("memory_fate_reported_at"),
  // When the run was told this patch merged, or was over (Patch.mergedCuedAt): once per patch.
  mergedCuedAt: text("merged_cued_at"),
  // A poster's claim on that cue (Patch.mergedCueClaimedAt): one poster at a time.
  mergedCueClaimedAt: text("merged_cue_claimed_at"),
  // When a merged patch's landing was asked and answered (Patch.landingAskedAt): null while owed.
  landingAskedAt: text("landing_asked_at"),
  // Why a person has to decide on it (Patch.heldReason); null for every other patch.
  heldReason: text("held_reason"),
  // Bumped on every write that changes what the patch is (Patch.version): a write's condition.
  version: integer("version").notNull().default(0),
  // {touched, hooksPaths, more, at}: the forge's word on the git hook files a `local` patch
  // changes, carried, never queried into. Null until asked — and forever for every other forge,
  // which is why the sweep that asks narrows by provider first.
  hookCheck: jsonb("hook_check").$type<PatchHookCheck>(),
  // The hook files a person approved the patch with: sent with every submission.
  approvedHookPaths: jsonb("approved_hook_paths").$type<string[]>().notNull().default([]),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  // The idempotency lookup: a retried submission finds the existing patch for this head and
  // adopts it rather than opening a second PR.
  index("patches_by_repo_and_head").on(t.connectedRepoId, t.headSha),
  // The reconciliation's lookup: settled patches memory never acknowledged. Indexed because the
  // sweep asks on every tick and the answer is almost always empty.
  index("patches_by_memory_fate").on(t.memoryFateReportedAt),
  // `(created_at, id)` tails again: the approval queue pages by the same keyset the task list
  // does, filtered or not.
  index("patches_by_state").on(t.state, t.createdAt, t.id),
  index("patches_by_created_at").on(t.createdAt, t.id),
  index("patches_by_task").on(t.taskId, t.createdAt),
  index("patches_by_set").on(t.setId, t.createdAt),
  index("patches_by_run").on(t.runId),
  // The merge-cue outbox (Patch.mergedCuedAt): merged or missed patches whose run was never
  // told. Partial, so it holds only the few owed at any time, not every patch ever: a run that is
  // over has its cues marked, never kept.
  index("patches_awaiting_merged_cue").on(t.createdAt)
    .where(sql`${t.mergedCuedAt} is null and ${t.landed} ->> 'kind' in ('merged', 'missed')`),
  // The landing reconcile (listPatchesAwaitingLanding): merged or missed patches whose landing
  // is still owed. Partial, so it holds only the few a failure left behind, not every merge ever.
  index("patches_awaiting_landing").on(t.createdAt)
    .where(sql`${t.landingAskedAt} is null and ${t.landed} ->> 'kind' in ('merged', 'missed')`),
  // The landing rule's reconcile (listPatchesDueLandingRule): a sibling of a waiting patch's
  // line and generation whose change request merged. Partial, merged and missed rows only.
  index("patches_merged_by_branch").on(t.runId, t.connectedRepoId, t.path, t.line, t.generation)
    .where(sql`${t.landed} ->> 'kind' in ('merged', 'missed')`),
  // The settle reconcile (listChangeRequestMergesDue): submitted patches with no verdict yet.
  // Partial: the open change requests' patches, not every patch ever.
  index("patches_unsettled").on(t.createdAt)
    .where(sql`${t.state} = 'submitted' and ${t.landed} is null`),
  // The merge poll (listChangeRequestsDueMergePoll): change requests closed recently, which a
  // reopen and merge may still revise. Partial, closed rows only, ranged on when they closed.
  index("patches_closed_by_time").on(sql`(${t.landed} ->> 'at')`)
    .where(sql`${t.state} = 'submitted' and ${t.landed} ->> 'kind' = 'closed'`),
  // The webhook's lookup: which submitted patch opened pull request N of this repo.
  index("patches_by_repo_and_forge_ref").on(t.connectedRepoId, t.forgeRef),
]);

/**
 * The merge poll's clock (core/merge_poll.ts), per change request: where the forge delivers no
 * events (GitHub's user mode), when a change request ryph's patches reached is next asked about,
 * and how many asks in a row failed. A row exists only while the poll has asked and the change
 * request still has a patch without a verdict, or one that closed within the poll's window (a
 * reopen and merge revises it): the sweep prunes it after that.
 */
export const mergePolls = pgTable("merge_polls", {
  connectedRepoId: text("connected_repo_id").notNull().references(() => connectedRepos.id),
  forgeRef: text("forge_ref").notNull(),
  dueAt: text("due_at").notNull(),
  failures: integer("failures").notNull().default(0),
  // How many reads in a row found the change request gone; at the limit its clock is parked.
  gone: integer("gone").notNull().default(0),
  // A unique index rather than a composite primary key: drizzle-kit's introspection (the drift
  // check in tests/migrations_test.ts) fails on one.
}, (t) => [uniqueIndex("merge_polls_by_change_request").on(t.connectedRepoId, t.forgeRef)]);

/**
 * A change request's merge as the forge reported it (core ChangeRequestMerge), per change
 * request: what every patch that reached it is judged against (core/merge_settle.ts). One row a
 * merge that ryph's work reached, kept: a push that arrives later is judged against it, and a
 * later merge grows its heads. The settle reconcile reads the unsettled ones.
 */
export const changeRequestMerges = pgTable("change_request_merges", {
  connectedRepoId: text("connected_repo_id").notNull().references(() => connectedRepos.id),
  forgeRef: text("forge_ref").notNull(),
  mergedInto: text("merged_into"),
  heads: jsonb("heads").$type<string[]>().notNull().default([]),
  mergedAt: text("merged_at").notNull(),
  // One more each time `heads` grew and each time an ask starts (ChangeRequestMerge.version): the
  // settle's stamps compare it.
  version: integer("version").notNull().default(0),
  settledAt: text("settled_at"),
  attempts: integer("attempts").notNull().default(0),
  nextAskAt: text("next_ask_at"),
  // When its releases were made (ChangeRequestMerge.releasedAt); null while one may be owed.
  releasedAt: text("released_at"),
  // When a release that threw is asked again (ChangeRequestMerge.releaseRetryAt).
  releaseRetryAt: text("release_retry_at"),
  // A unique index rather than a composite primary key, as on merge_polls.
}, (t) => [
  uniqueIndex("change_request_merges_by_change_request").on(t.connectedRepoId, t.forgeRef),
  // The settle reconcile's clock arm: partial, so it holds only the merges still waiting on a
  // verdict, or with an ask under way or a retry due.
  index("change_request_merges_due").on(t.nextAskAt)
    .where(sql`${t.settledAt} is null or ${t.nextAskAt} is not null`),
  // The release reconcile (listMergesOwingRelease): partial, the merges whose releases are owed,
  // in the order it takes them — never retried first, then by merge.
  index("change_request_merges_owing_release").on(t.releaseRetryAt, t.mergedAt)
    .where(sql`${t.releasedAt} is null`),
]);

export const runBootstraps = pgTable("run_bootstraps", {
  runId: text("run_id").primaryKey().references(() => runs.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  sealed: text("sealed").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id),
  // Denormalized from the task so per-agent views are one indexed filter, no join.
  agentId: text("agent_id").notNull().references(() => agents.id),
  state: text("state").$type<RunState>().notNull(),
  phase: text("phase").$type<Phase>(),
  heartbeatSeq: integer("heartbeat_seq").notNull(),
  lastHeartbeatAt: text("last_heartbeat_at"),
  desiredState: text("desired_state").$type<"cancelled">(),
  cancelRequestedAt: text("cancel_requested_at"),
  // Whether a person has spoken to the run, and the runner's idle clock as it last advertised
  // it (a gauge, like the phase — the reaper reads it, nothing else does).
  attended: boolean("attended").notNull().default(false),
  idleDeadlineAt: text("idle_deadline_at"),
  idleState: text("idle_state").$type<"idle" | "waiting-for-user">(),
  // The outcome the agent last declared, as its beats carry it: what a person's finish waits on.
  declaredOutcome: text("declared_outcome").$type<DeclaredOutcome>(),
  // Whether the agent called its finish tool, as its beats carry it: a person's finish is
  // refused from then on.
  agentFinished: boolean("agent_finished").notNull().default(false),
  // The forge thread the run was commanded from. Denormalized off the run's forge scope (jsonb,
  // and policy-shaped) so the `/ryph` intake can ask "is an agent already working this thread"
  // as one indexed filter — the join that answers a follow-up, and the refusal that keeps two
  // agents off one branch.
  originThreadRepoId: text("origin_thread_repo_id").references(() => connectedRepos.id),
  originThreadKind: text("origin_thread_kind").$type<"issue" | "change_request">(),
  originThreadRef: text("origin_thread_ref"),
  // The chat thread the run was started from — a command room's mention — denormalized for the
  // same lookup on the chat side: the live run holding a topic, and a room's starts per hour.
  originChatroomId: text("origin_chatroom_id"),
  originThreadKey: text("origin_thread_key"),
  tokenHash: text("token_hash").notNull(),
  controlToken: text("control_token").notNull(),
  handle: text("handle"),
  // Written with `handle`, and read by the reaper as the zero of the startup grace — see
  // core/types.ts. Nullable: null until launch, and null for rows born before it existed.
  launchedAt: text("launched_at"),
  // The run's branch namespace (Run.branchNamespace). The column keeps its older name.
  branchNamespace: text("branch_name").notNull(),
  // Snapshots, frozen at provision time (see core/types.ts on why: agents are editable).
  image: text("image"),
  // The environment the run launched on or waits for. Not a foreign key: retention retires
  // environment rows, and a run's history must outlive them (`environment` is the snapshot).
  environmentId: text("environment_id"),
  environment: jsonb("environment").$type<RunEnvironment>(),
  // Set while the run waits for a build; the reaper leaves such a run alone.
  environmentWait: jsonb("environment_wait").$type<RunEnvironmentWait>(),
  workItem: jsonb("work_item").$type<WorkItem>().notNull(),
  injectedContext: jsonb("injected_context").$type<InjectedContext>(),
  modelScope: jsonb("model_scope").$type<RunModelScope>(),
  toolScope: jsonb("tool_scope").$type<RunToolScope>(),
  forgeScope: jsonb("forge_scope").$type<RunForgeScope>(),
  services: jsonb("services").$type<RunServices>(),
  // The skills the run was given, frozen at creation (core/types.ts RunSkills). Null for a
  // harness without skills support, and for runs created before the column.
  skills: jsonb("skills").$type<RunSkills>(),
  // Where the run may reach on the internet, resolved against the deployment's ceiling at
  // provision time. NOT NULL and WITHOUT a default: every run gets an answer at creation, so a
  // default here would only ever paper over a bug. The rows that predate the column are
  // backfilled by the migration, which adds it with a default and drops that default in the
  // same step (drizzle/0011_curvy_hellcat.sql) — carrying one here instead leaves `pushSchema`
  // reporting drift forever, which tests/migrations_test.ts is what catches.
  networkScope: jsonb("network_scope").$type<RunNetworkScope>().notNull(),
  // The run's limits, resolved at creation and frozen. NOT NULL without a default, for the
  // reason `network_scope` gives: the migration backfills the rows that predate the column
  // with no caps (which is what was true of them) and drops the default in the same step.
  limits: jsonb("limits").$type<RunLimits>().notNull(),
  // Hosts the egress proxy refused this run, appended one at a time by the narrow write in
  // adapters/store/drizzle.ts. Nullable and without a default: almost every run is refused
  // nothing, and "no row ever wrote here" is the honest reading of that.
  egressRefusals: jsonb("egress_refusals").$type<EgressRefusal[]>(),
  result: jsonb("result").$type<RunnerResult>(),
  // Memory's acknowledgement of the run's outcome; the reaper redelivers while it is null.
  memoryOutcomeReportedAt: text("memory_outcome_reported_at"),
  // The runner's skills report, claimed once per run by the store's narrow write.
  skillsReportedAt: text("skills_reported_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("runs_by_task").on(t.taskId, t.createdAt),
  index("runs_by_agent").on(t.agentId, t.createdAt),
  index("runs_by_state").on(t.state),
  index("runs_by_last_heartbeat").on(t.lastHeartbeatAt),
  index("runs_by_memory_outcome").on(t.memoryOutcomeReportedAt),
  // The `/ryph` intake's lookup: the live run holding this thread, if any.
  index("runs_by_origin_thread").on(t.originThreadRepoId, t.originThreadRef),
  // The chat door's lookups: the live run holding a thread, and a room's recent starts.
  index("runs_by_origin_chat").on(t.originChatroomId, t.originThreadKey),
  index("runs_by_origin_chatroom_created").on(t.originChatroomId, t.createdAt),
  // Which runs wait for, or run on, one environment — a build settling, and retention.
  index("runs_by_environment").on(t.environmentId),
]);

// One skill's files, content-addressed (core/skills.ts `skillDigest`): the catalogue's, shared by
// digest with every later source. Rows are never deleted — a run frozen on a digest must be able
// to fetch it for its whole life, a deploy that shipped a newer catalogue included.
export const skillBundles = pgTable("skill_bundles", {
  digest: text("digest").primaryKey(),
  // Read whole, never queried into. `content` is base64: assets/ may be binary.
  files: jsonb("files").$type<SkillFile[]>().notNull(),
  bytes: integer("bytes").notNull(),
  // The skill's icons (core/skill_presentation.ts), base64: written with the bundle, so once per
  // distinct content however many syncs hold it. Null when it has none, and for catalogue
  // bundles, whose icons the catalogue holds in memory. Never read by a run start.
  icons: jsonb("icons").$type<SkillIcons>(),
  createdAt: text("created_at").notNull(),
});

// The deployment's skill settings, as an admin left them (core/types.ts SkillSettings). One row
// with a constant id, like egress_allowlist; no row means the defaults (every catalogue skill on,
// repo skills on, no org repo), so a fresh deployment needs no seed.
export const skillSettings = pgTable("skill_settings", {
  id: text("id").primaryKey(),
  // Catalogue skill names an admin turned off, checked against the shipped catalogue on write.
  disabledCatalogue: jsonb("disabled_catalogue").$type<string[]>().notNull(),
  workingRepoSkills: boolean("working_repo_skills").notNull(),
  // The org skills repo, and the branch to read (null: its default branch).
  orgRepoId: text("org_repo_id").references(() => connectedRepos.id),
  orgBranch: text("org_branch"),
  // The version runs get: the last sync that read a tree. Moves only on a successful sync, and
  // is cleared with the three below whenever the repo or the branch changes.
  orgCurrentSyncId: text("org_current_sync_id").references(() => skillSyncs.id),
  // When the repo last answered, and at which commit — an unchanged answer included, which
  // records no sync row. A failure moves neither.
  orgCheckedAt: text("org_checked_at"),
  orgCheckedCommit: text("org_checked_commit"),
  // When the read behind the latest answer started, a standing failure included. Syncs run side
  // by side and are judged in start order, so a read that started before it answers nothing new.
  orgCheckedStartedAt: text("org_checked_started_at"),
  updatedAt: text("updated_at").notNull(),
  // The admin who last moved a setting; a sync moving the version leaves it alone.
  updatedBy: text("updated_by"),
});

// One read of the org skills repo that changed something: a new tree, or a failure
// (core/skills.ts SkillSync). History is versions and failures, not a log of every push: a read
// that found the tree runs already get is no row, and a failure identical to the latest row for
// the same repo and branch counts as a repeat of it. A tree that never became the version runs
// get, or a failure that never stood (the settings moved, or a later read answered first), is
// `superseded`, so a skill's versions are the `synced` rows of one repo and branch. Never
// deleted, like the bundles.
export const skillSyncs = pgTable("skill_syncs", {
  id: text("id").primaryKey(),
  connectedRepoId: text("connected_repo_id").notNull().references(() => connectedRepos.id),
  branch: text("branch").notNull(),
  trigger: text("trigger").$type<SkillSyncTrigger>().notNull(),
  outcome: text("outcome").$type<SkillSync["outcome"]>().notNull(),
  failure: text("failure").$type<SkillSyncFailure>(),
  rulesVersion: integer("rules_version").notNull(),
  commit: text("commit"),
  treeId: text("tree_id"),
  skillCount: integer("skill_count").notNull(),
  warnings: jsonb("warnings").$type<SkillWarning[]>().notNull(),
  error: text("error"),
  repeats: integer("repeats").notNull(),
  requestedBy: text("requested_by"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at").notNull(),
}, (t) => [index("skill_syncs_by_repo").on(t.connectedRepoId, t.finishedAt)]);

// The skills one synced version holds. A skill's version history is its rows across syncs,
// collapsed where the digest did not change.
export const skillSyncEntries = pgTable("skill_sync_entries", {
  syncId: text("sync_id").notNull().references(() => skillSyncs.id),
  name: text("name").notNull(),
  description: text("description").notNull(),
  digest: text("digest").notNull().references(() => skillBundles.digest),
  // license, compatibility, metadata and allowed-tools as validated: shown, never enforced.
  frontmatter: jsonb("frontmatter").$type<SkillFrontmatter>().notNull(),
  // Display name, line and colour (core/skill_presentation.ts), text only: shown, never
  // enforced. Null when the skill sets none. Its icons are its bundle's (`skill_bundles.icons`).
  presentation: jsonb("presentation").$type<SkillPresentation>(),
}, (t) => [
  // One entry per name in a version. A unique index and not a composite primary key: drizzle-kit
  // cannot introspect a composite key on PGlite, so the migration drift test could not run.
  uniqueIndex("skill_sync_entries_entry").on(t.syncId, t.name),
  index("skill_sync_entries_by_name").on(t.name, t.syncId),
]);

// One build of one subject's environment (core/types.ts `Environment`). The queue AND the
// record: a build is queued as a row, claimed by whichever replica has a free slot (the plan
// carries everything the spec needs), and becomes the image runs freeze once ready. Rows are
// never deleted — retention retires a ready image to `superseded`.
export const environments = pgTable("environments", {
  id: text("id").primaryKey(),
  subjectKind: text("subject_kind").$type<EnvironmentSubjectKind>().notNull(),
  subjectId: text("subject_id").notNull(),
  ref: text("ref").notNull(),
  defaultBranch: boolean("default_branch").notNull(),
  // {path: sha}, versions and the build plan: carried whole, never queried into.
  commits: jsonb("commits").$type<Record<string, string>>().notNull(),
  // Every member's `.ryph/` tree as one key (core/environments.ts `definitionKey`).
  definition: text("definition"),
  baseDigest: text("base_digest").notNull(),
  harnessDigest: text("harness_digest").notNull(),
  image: text("image"),
  bakedImage: text("baked_image"),
  // The machine image the build pushed, by digest, for retention to delete (core/types.ts).
  machineImage: text("machine_image"),
  status: text("status").$type<EnvironmentStatus>().notNull(),
  toolchains: jsonb("toolchains").$type<Record<string, string>>().notNull(),
  // Bytes, and an environment image passes 2 GiB easily: a bigint, read back as a number.
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  trigger: text("trigger").$type<EnvironmentTrigger>().notNull(),
  // Why it was queued, in a sentence (core/types.ts `Environment.reason`).
  reason: text("reason"),
  plan: jsonb("plan").$type<EnvironmentBuildPlan>().notNull(),
  logRef: text("log_ref"),
  logTail: text("log_tail"),
  failure: text("failure"),
  // The same column on the other subject a claim can name — a build. See `runs` above.
  egressRefusals: jsonb("egress_refusals").$type<EgressRefusal[]>(),
  // What setup.yml warned of at bake time (a step failed, the file invalid, a tree left dirty…);
  // null when nothing (core/types.ts).
  setupWarnings: jsonb("setup_warnings").$type<SetupWarning[]>(),
  // When the builder removed a retired or failed row's images (core/types.ts).
  imagesRemovedAt: text("images_removed_at"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  // The resolution's and the card's lookup: a subject's builds of one branch, newest first.
  index("environments_by_subject").on(t.subjectKind, t.subjectId, t.ref, t.createdAt),
  // The queue's: the oldest queued row, and how many are building.
  index("environments_by_status").on(t.status, t.createdAt),
  // The builds list: every build, newest first, a page at a time.
  index("environments_by_created").on(t.createdAt, t.id),
  // Image removal: every row sharing a baked image (a re-layer answers its source's).
  index("environments_by_baked_image").on(t.bakedImage),
  // Image removal's queue: the retired and failed rows not yet done with, oldest first. Partial,
  // so the scan stays the size of the backlog, not of every build there ever was.
  index("environments_images_to_remove").on(t.updatedAt, t.id)
    .where(sql`${t.imagesRemovedAt} IS NULL AND ${t.status} IN ('superseded', 'failed')`),
]);

// What one submitted patch asked of the environment builder, and whether its run heard the
// result (core/types.ts `PatchBuild`, core/environment_feedback.ts). Keyed on the patch: one
// check, one result, per head. Its own table rather than columns on `patches`, because patch rows
// are written whole by every lifecycle transition, and a transition holding an older copy would
// otherwise put an unreported result back over a delivered one.
export const patchBuilds = pgTable("patch_builds", {
  patchId: text("patch_id").primaryKey().references(() => patches.id),
  runId: text("run_id").notNull().references(() => runs.id),
  environmentId: text("environment_id").references(() => environments.id),
  branch: text("branch"),
  note: text("note"),
  checkedAt: text("checked_at").notNull(),
  claimedUntil: text("claimed_until"),
  reportedAt: text("reported_at"),
}, (t) => [
  index("patch_builds_by_run").on(t.runId, t.checkedAt),
  // A settling build's lookup: which patches it answers.
  index("patch_builds_by_environment").on(t.environmentId),
  // The tick's backstop: checks still unresolved, and results nobody has told their run yet.
  index("patch_builds_by_reported").on(t.reportedAt),
]);

// A BUILD's git credential toward the forge gateway — the run's `git_virtual_keys`, one
// credential class over, and hash-only for the same reason. Minted when a build is claimed, for
// the clone the builder makes OUTSIDE the build; it resolves only while its environment is
// building, to that environment's checkouts, and dies with the build.
export const buildGitKeys = pgTable("build_git_keys", {
  id: text("id").primaryKey(),
  environmentId: text("environment_id").notNull().references(() => environments.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("build_git_keys_by_token_hash").on(t.tokenHash),
  index("build_git_keys_by_environment").on(t.environmentId),
]);

// One check suite: one `.ryph/checks.yml` (at the base) against one commit, in one environment
// (core/check_types.ts `CheckSuite`). The queue AND the record, as `environments` is: a suite is
// claimed by inserting its identity, and a second request for the same identity joins the row —
// the dedupe that makes "nothing runs twice" true is the unique index below.
export const checkSuites = pgTable("check_suites", {
  id: text("id").primaryKey(),
  remote: jsonb("remote").$type<import("../../../ports/remote_checks.ts").RemoteCheckReference>(),
  connectedRepoId: text("connected_repo_id").notNull().references(() => connectedRepos.id),
  commit: text("commit").notNull(),
  checksRef: text("checks_ref").notNull(),
  checksCommit: text("checks_commit").notNull(),
  checksBlob: text("checks_blob").notNull(),
  checksPath: text("checks_path").notNull(),
  // The frozen declaration, services and source: carried whole, and queried into only for the
  // checks list's `definition.partial`.
  definition: jsonb("definition").$type<ChecksDeclaration>().notNull(),
  environmentKey: text("environment_key").notNull(),
  inputsKey: text("inputs_key").notNull(),
  networkScope: jsonb("network_scope").$type<RunNetworkScope>().notNull(),
  environmentId: text("environment_id").references(() => environments.id),
  image: text("image"),
  services: jsonb("services").$type<ServiceSpec[]>().notNull(),
  source: jsonb("source").$type<CheckSource>().notNull(),
  state: text("state").$type<CheckSuiteState>().notNull(),
  generation: integer("generation").notNull(),
  reason: text("reason"),
  attempts: integer("attempts").notNull(),
  ryphChanged: boolean("ryph_changed"),
  leaseUntil: text("lease_until"),
  // A suite of several pods: each pod's own life (attempts, launch, key), by record name.
  pods: jsonb("pods").$type<Record<string, CheckPodState>>(),
  // Bumped on every write of the row (CheckSuite.version): a write's condition.
  version: integer("version").notNull().default(0),
  waitingSince: text("waiting_since"),
  nextAttemptAt: text("next_attempt_at"),
  launchedAt: text("launched_at"),
  finishedAt: text("finished_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("check_suites_identity").on(
    t.connectedRepoId,
    t.commit,
    t.checksBlob,
    t.environmentKey,
    t.inputsKey,
  ),
  // The tick's: suites to launch, poll or settle, oldest first — and how many are running.
  index("check_suites_by_state").on(t.state, t.updatedAt),
  // A settling build's lookup: which suites wait on it.
  index("check_suites_by_environment").on(t.environmentId),
  // The patch views' and the forge report's: the suites on one head.
  index("check_suites_by_commit").on(t.connectedRepoId, t.commit),
  // The checks page's list: newest first, paged on (createdAt, id).
  index("check_suites_by_time").on(t.createdAt, t.id),
]);

// One check of one suite generation (core/check_types.ts `CheckResult`). A re-run writes a new
// generation beside the old one rather than over it.
//
// Keyed by a unique index rather than a composite primary key: drizzle-kit's introspection of a
// composite key fails on PGlite (it sends the constraint query with no parameters), which would
// break `db:push` and the migrations test. An upsert targets the index all the same.
export const checkResults = pgTable("check_results", {
  suiteId: text("suite_id").notNull().references(() => checkSuites.id),
  generation: integer("generation").notNull(),
  name: text("name").notNull(),
  state: text("state").$type<CheckResultState>().notNull(),
  exitCode: integer("exit_code"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  logKey: text("log_key"),
  logTail: text("log_tail"),
  watchedChanged: boolean("watched_changed"),
  forgeRef: text("forge_ref"),
  // Not a reference: the suite it names is only ever read for display, and never deleted.
  inheritedFrom: text("inherited_from"),
}, (t) => [
  uniqueIndex("check_results_key").on(t.suiteId, t.generation, t.name),
]);

// Who asked for a suite, and what their run was last told (core/check_types.ts `CheckRequest`).
// Suites are shared by dedupe, so the asker is a row of its own; a patch-birth request is written
// pending and resolved on the tick, off the path that opened the patch.
export const checkRequests = pgTable("check_requests", {
  id: text("id").primaryKey(),
  remote: jsonb("remote").$type<import("../../../ports/remote_checks.ts").RemoteCheckReference>(),
  suiteId: text("suite_id").references(() => checkSuites.id),
  rerunOf: text("rerun_of").references(() => checkSuites.id),
  connectedRepoId: text("connected_repo_id").notNull().references(() => connectedRepos.id),
  commit: text("commit").notNull(),
  runId: text("run_id").references(() => runs.id),
  patchId: text("patch_id").references(() => patches.id),
  changeRequest: text("change_request"),
  userId: text("user_id"),
  kind: text("kind").$type<CheckRequest["kind"]>().notNull(),
  state: text("state").$type<CheckRequest["state"]>().notNull(),
  note: text("note"),
  source: jsonb("source").$type<CheckSource>().notNull(),
  checksRef: text("checks_ref").notNull(),
  reportedGeneration: integer("reported_generation"),
  attempts: integer("attempts").notNull(),
  nextAttemptAt: text("next_attempt_at"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at"),
}, (t) => [
  index("check_requests_by_run").on(t.runId),
  index("check_requests_by_patch").on(t.patchId),
  // The tick's: pending requests that are due.
  index("check_requests_by_state").on(t.state, t.nextAttemptAt),
  index("check_requests_by_suite").on(t.suiteId),
  // A cancel's lookup: who else asked for this head, suite resolved or not.
  index("check_requests_by_commit").on(t.connectedRepoId, t.commit),
  // A push's lookup: the change request's earlier push requests, to supersede or withdraw.
  index("check_requests_by_change_request").on(t.connectedRepoId, t.changeRequest),
  // A local ask's lookups: the person's live asks, to supersede, to count against their quota.
  index("check_requests_by_user").on(t.userId, t.state),
  // The minute sweep's: local asks still standing past their end.
  index("check_requests_by_expiry").on(t.kind, t.state, t.expiresAt),
]);

// What the forge was last told about one asker's checks (core/check_types.ts
// `CheckForgeReport`): a submitted patch's, or a push request's — exactly one of the two is set,
// and each has at most one row. Its own table for `patch_builds`' reason: patch rows are written
// whole by every lifecycle transition.
export const checkForgeReports = pgTable("check_forge_reports", {
  id: text("id").primaryKey(),
  patchId: text("patch_id").references(() => patches.id),
  requestId: text("request_id").references(() => checkRequests.id),
  connectedRepoId: text("connected_repo_id").notNull().references(() => connectedRepos.id),
  headSha: text("head_sha").notNull(),
  checksRef: text("checks_ref").notNull(),
  suiteId: text("suite_id").references(() => checkSuites.id),
  reportedFingerprint: text("reported_fingerprint"),
  attempts: integer("attempts").notNull(),
  nextAttemptAt: text("next_attempt_at"),
  lastError: text("last_error"),
  disabledUntil: text("disabled_until"),
  revision: integer("revision").notNull(),
  openGenerations: jsonb("open_generations")
    .$type<Array<{ suiteId: string; generation: number }>>().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  // An upsert's targets: one row per patch, one per push request.
  uniqueIndex("check_forge_reports_by_patch").on(t.patchId),
  uniqueIndex("check_forge_reports_by_request").on(t.requestId),
  // The tick's: reports that are due.
  index("check_forge_reports_by_next_attempt").on(t.nextAttemptAt),
  // A row is one asker's: a patch's or a push request's, never both, never neither.
  check("check_forge_reports_one_asker", sql`(${t.patchId} is null) <> (${t.requestId} is null)`),
]);

// A head of an outside contributor's change request waiting for someone who may to approve its
// checks (core/check_types.ts `CheckApproval`, core/check_approvals.ts). One row per head.
export const checkApprovals = pgTable("check_approvals", {
  id: text("id").primaryKey(),
  connectedRepoId: text("connected_repo_id").notNull().references(() => connectedRepos.id),
  changeRequest: text("change_request").notNull(),
  headSha: text("head_sha").notNull(),
  fetchRef: text("fetch_ref"),
  url: text("url"),
  author: text("author").notNull(),
  state: text("state").$type<CheckApprovalState>().notNull(),
  commentId: text("comment_id"),
  commentClaimedAt: text("comment_claimed_at"),
  approvedByUserId: text("approved_by_user_id"),
  approvedByLogin: text("approved_by_login"),
  approvedAt: text("approved_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  // The claim: one approval per head of a change request, whichever delivery files it.
  uniqueIndex("check_approvals_by_head").on(t.connectedRepoId, t.changeRequest, t.headSha),
]);

// One upload a person streamed to the forge for a local check ask (core/check_types.ts
// `CheckLocalUpload`), written before the upload whatever the forge answers: the hourly upload
// cap counts attempts, so a bundle the forge refuses is still one. Pruned after a day.
export const checkLocalUploads = pgTable("check_local_uploads", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  connectedRepoId: text("connected_repo_id").notNull().references(() => connectedRepos.id),
  at: text("at").notNull(),
}, (t) => [
  // The cap's count, and the prune.
  index("check_local_uploads_by_user").on(t.userId, t.at),
]);

// A CHECK POD's git credential toward the forge gateway — the third class beside
// `git_virtual_keys` and `build_git_keys`, and hash-only for the same reason. Minted at launch
// for the clone step alone; it resolves only while its suite generation is running, to that one
// candidate commit, and is revoked once the clone is done and again at settle.
export const checkGitKeys = pgTable("check_git_keys", {
  id: text("id").primaryKey(),
  suiteId: text("suite_id").notNull().references(() => checkSuites.id),
  generation: integer("generation").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("check_git_keys_by_token_hash").on(t.tokenHash),
  index("check_git_keys_by_suite").on(t.suiteId),
]);

// A run's git credential toward the forge gateway — HASH ONLY, run-scoped, expiring,
// read-only by construction (the gateway has no write path). The gateway resolves presented
// tokens against these rows via POST /v1/forge/git-keys/resolve, so the hash lookup is a
// hot path: every git request the gateway serves starts here (briefly cached on its side).
export const gitVirtualKeys = pgTable("git_virtual_keys", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("git_virtual_keys_by_token_hash").on(t.tokenHash),
  index("git_virtual_keys_by_run").on(t.runId),
]);

// One row per forge write an agent asked for — the ledger a run's caps are counted in (by run and
// tool, under a lock on the run), the dedupe anchor a lost response is reconciled against, and the
// run page's trail. Reserved before the write, settled after.
export const forgeToolActions = pgTable("forge_tool_actions", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id),
  tool: text("tool").$type<ForgeToolAction["tool"]>().notNull(),
  connectedRepoId: text("connected_repo_id").notNull(),
  // Denormalized beside `repo_ref` so the ledger stands alone: a reader needs the provider to
  // know how to spell the address back — "12" is a number on one forge and a 40-hex object id
  // on the other — and a disconnected repo's row would no longer answer for it.
  provider: text("provider").$type<ConnectedRepo["provider"]>().notNull().default("github"),
  repoRef: text("repo_ref").notNull(),
  threadRef: text("thread_ref"),
  state: text("state").$type<ForgeToolAction["state"]>().notNull(),
  url: text("url"),
  createdThreadRef: text("created_thread_ref"),
  detail: text("detail"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
}, (t) => [
  index("forge_tool_actions_by_run").on(t.runId, t.tool, t.createdAt),
]);

// One row per inbound forge delivery — the dedupe (primary key = delivery id, an insert that
// loses the race means "seen it") and the audit trail (how each delivery's handling ended).
export const forgeEvents = pgTable("forge_events", {
  deliveryId: text("delivery_id").primaryKey(),
  kind: text("kind").notNull(),
  outcome: text("outcome").$type<ForgeEventOutcome>().notNull(),
  taskId: text("task_id"),
  receivedAt: text("received_at").notNull(),
  createdAt: text("created_at").notNull(),
  claimedAt: text("claimed_at"),
});

// One row per automation fire delivered to the events door — dedupe and audit trail, exactly
// as `forge_events` is for forge deliveries (primary key = the fire's hook id).
export const automationEvents = pgTable("automation_events", {
  eventId: text("event_id").primaryKey(),
  automationId: text("automation_id").notNull(),
  outcome: text("outcome").$type<AutomationEventOutcome>().notNull(),
  taskId: text("task_id"),
  receivedAt: text("received_at").notNull(),
  createdAt: text("created_at").notNull(),
  claimedAt: text("claimed_at"),
});

// A command room: the policy that lets a mention of the bot in a chatroom start work (core/types.ts
// `CommandRoom`). One row per chatroom — the chat service's id, not a foreign key: the rooms live
// in the chat service's own tables. Lists and unions are jsonb: read whole, never queried into.
export const commandRooms = pgTable("command_rooms", {
  chatroomId: text("chatroom_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  agentIds: jsonb("agent_ids").$type<CommandRoom["agentIds"]>().notNull(),
  defaultAgentId: text("default_agent_id").notNull().references(() => agents.id),
  defaultTarget: jsonb("default_target").$type<CommandRoom["defaultTarget"]>(),
  commanders: jsonb("commanders").$type<CommandRoom["commanders"]>().notNull(),
  startsPerHour: integer("starts_per_hour").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// One channel's own target in a command room, keyed by the platform's stable channel id.
// Replaced wholesale with the room's policy; deleted with it.
export const commandRoomChannels = pgTable("command_room_channels", {
  chatroomId: text("chatroom_id").notNull()
    .references(() => commandRooms.chatroomId, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull(),
  channelName: text("channel_name").notNull(),
  target: jsonb("target").$type<CommandRoomChannel["target"]>().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("command_room_channels_by_channel").on(t.chatroomId, t.channelId),
]);

// One row per mention that reached a side effect — the dedupe (the unique pair, an insert that
// loses means "seen it") and the audit trail, as `forge_events` is for forge deliveries.
export const chatMentions = pgTable("chat_mentions", {
  chatroomId: text("chatroom_id").notNull(),
  messageId: text("message_id").notNull(),
  outcome: text("outcome").$type<ChatMentionOutcome>().notNull(),
  taskId: text("task_id"),
  receivedAt: text("received_at").notNull(),
  createdAt: text("created_at").notNull(),
  claimedAt: text("claimed_at"),
}, (t) => [
  uniqueIndex("chat_mentions_by_message").on(t.chatroomId, t.messageId),
]);

// The one comment a forge-triggered run keeps editing. `concluded_at` closes the row; the
// progress sweep's working set is the rows where it is null.
export const progressComments = pgTable("progress_comments", {
  runId: text("run_id").primaryKey().references(() => runs.id),
  taskId: text("task_id").notNull().references(() => tasks.id),
  connectedRepoId: text("connected_repo_id").notNull().references(() => connectedRepos.id),
  threadKind: text("thread_kind").$type<"issue" | "change_request">().notNull(),
  threadRef: text("thread_ref").notNull(),
  commentId: text("comment_id").notNull(),
  // A tiny pair ({state, phase}), carried but never queried into.
  lastPosted: jsonb("last_posted").$type<ProgressComment["lastPosted"]>().notNull(),
  // Defaulted so the column can be added to a table that already holds rows: a NOT NULL
  // column without one is rejected outright by every row already there.
  attempts: integer("attempts").notNull().default(0),
  concludedAt: text("concluded_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("progress_comments_open").on(t.concludedAt),
]);

// A run's inbox: durable messages addressed to one run, pulled by its runner in `seq` order.
// One row per message — a person's line, a chatroom's mention, a joined fire, the platform's
// own note about a patch. `seq` is per run and the unique index is what makes it the runner's
// cursor: two appends can never both take one number. `delivered_at` is the acknowledgement.
export const runMessages = pgTable("run_messages", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id),
  seq: integer("seq").notNull(),
  kind: text("kind").$type<RunMessage["kind"]>().notNull(),
  // A small union ({kind:"user",userId} | {kind:"chat",name,id} | …), carried, never queried into.
  sender: jsonb("sender").$type<RunMessage["sender"]>().notNull(),
  text: text("text").notNull(),
  // A system message's structured half (a patch's progress), carried whole for the runner.
  payload: jsonb("payload").$type<SystemPayload>(),
  // The images the message carries, as refs ({id, mime}) in marker order — carried for the
  // runner and the run page, never queried into. Who used which image is `run_attachments`'
  // `claimed_by`, the column the reuse rule is enforced on.
  attachments: jsonb("attachments").$type<AttachmentRef[]>().notNull().default([]),
  createdAt: text("created_at").notNull(),
  deliveredAt: text("delivered_at"),
}, (t) => [
  uniqueIndex("run_messages_by_run_and_seq").on(t.runId, t.seq),
]);

// The images a run was handed (core/attachments.ts): the row is the record, the bytes live in
// the attachment store under `storage_key`. `claimed_by` is null while an upload waits to be
// sent, then "task" (the run started with it) or the id of the one run message that carried it
// — set under the same transaction as that message's append, which is what keeps an image to
// one message. Indexed by run for the run page and the per-run unclaimed cap, and partially
// over the unclaimed rows by age for the reaper's retention sweep, so the sweep's read stays
// the size of what is waiting rather than of every image ever sent.
export const runAttachments = pgTable("run_attachments", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id),
  mime: text("mime").$type<Attachment["mime"]>().notNull(),
  bytes: integer("bytes").notNull(),
  sha256: text("sha256").notNull(),
  ref: text("ref"),
  source: text("source").$type<Attachment["source"]>().notNull(),
  storageKey: text("storage_key").notNull(),
  claimedBy: text("claimed_by"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("run_attachments_by_run").on(t.runId),
  // One row per image ref per run: the same screenshot uploaded twice is one image, and the
  // resolve reads a run's refs by this.
  uniqueIndex("run_attachments_ref").on(t.runId, t.ref),
  index("run_attachments_unclaimed_by_age").on(t.createdAt).where(sql`${t.claimedBy} is null`),
]);

// A run's background commands (core/background.ts): what each job was and how it ended, written
// by the runner as it goes. The log lives in the build log store under `log_key`, composed from
// the two ids and the claim of the upload that wrote it; `has_log` says one was stored, and
// `log_claim` which upload alone may write it now. Keyed by (run, job) as `check_results` is, with a
// unique index rather than a composite primary key (drizzle-kit's introspection of one fails on
// PGlite, which the drift test runs on); the index also serves the per-run read and the count the
// 64-row cap takes under the run's row lock.
export const runBackgroundCommands = pgTable("run_background_commands", {
  runId: text("run_id").notNull().references(() => runs.id),
  jobId: text("job_id").notNull(),
  label: text("label").notNull(),
  command: text("command").notNull(),
  cwd: text("cwd").notNull(),
  service: boolean("service").notNull(),
  startedAt: text("started_at").notNull(),
  timeoutAt: text("timeout_at"),
  endedAt: text("ended_at"),
  reason: text("reason").$type<BackgroundEndReason>(),
  exitCode: integer("exit_code"),
  signal: text("signal"),
  logBytes: integer("log_bytes").notNull().default(0),
  logTruncated: boolean("log_truncated").notNull().default(false),
  logTail: text("log_tail"),
  hasLog: boolean("has_log").notNull().default(false),
  logClaim: text("log_claim"),
  logClaimedAt: text("log_claimed_at"),
  logKey: text("log_key"),
}, (t) => [
  uniqueIndex("run_background_commands_key").on(t.runId, t.jobId),
]);

// What an automation opens instead of a run per fire (core/types.ts `Response`). The row is
// the durable thing; the run it names is an attempt at it. Indexed by automation and state
// because the door asks "is there an open response for this automation and key" on every fire.
export const responses = pgTable("responses", {
  id: text("id").primaryKey(),
  automationId: text("automation_id").notNull(),
  taskId: text("task_id").notNull().references(() => tasks.id),
  runId: text("run_id").notNull().references(() => runs.id),
  chatroomId: text("chatroom_id"),
  state: text("state").$type<Response["state"]>().notNull(),
  // The correlation slot (core/fire_signal.ts `responseSlotKey`): "" is the automation-wide one,
  // which every response opened before keyed correlation holds.
  key: text("key").notNull().default(""),
  title: text("title"),
  // The policy's conversation setting when the response opened (core/types.ts
  // `Response.conversation`). Every response opened before it had a conversation of its own.
  conversation: text("conversation").$type<Response["conversation"]>().notNull()
    .default("per-response"),
  alerts: integer("alerts").notNull().default(0),
  openedAt: text("opened_at").notNull(),
  lastAlertAt: text("last_alert_at").notNull(),
  lastActivityAt: text("last_activity_at").notNull(),
  closedAt: text("closed_at"),
  closedReason: text("closed_reason"),
}, (t) => [
  index("responses_by_automation").on(t.automationId, t.state),
  index("responses_by_run").on(t.runId),
  // One OPEN response per (automation, key) — the coalescing rule, and the only place it can
  // hold. `findOpenResponse` … `startTask` … `createResponse` is a read-then-write with no lock,
  // and the per-event claim is keyed on eventId, so it does not serialize two DIFFERENT fires:
  // two arriving together for one slot opened two responses, two runs and two bindings to one
  // room.
  uniqueIndex("responses_one_open").on(t.automationId, t.key).where(sql`${t.state} <> 'closed'`),
]);

/**
 * The deployment's egress allowlist, as an admin owns it — one row, and the only row.
 *
 * Only the half that is a product decision lives here: WHAT a run may reach. Whether the
 * boundary is enforced at all and where the proxy answers stay in the environment, because an
 * admin turning the control off from inside the thing it controls is not a setting, it is a
 * bypass (core/egress.ts says this at more length).
 *
 * No row at all is the meaningful state and not an empty one: it means nobody has ever set an
 * allowlist here, so the environment's seed still stands. Which is why there is no boot-time
 * insert — a deployment that never opens the form reads exactly as it did before this table
 * existed.
 */
export const egressAllowlist = pgTable("egress_allowlist", {
  // One deployment, one allowlist. The constant id is what makes "the row" addressable, rather
  // than a `LIMIT 1` that would quietly pick one of two if a second ever appeared.
  id: text("id").primaryKey(),
  // Bundle ids and raw hostnames — names, never a secret and never a resolved address. JSON
  // because nothing queries into them: they are read whole, on the way to a run's claim.
  bundles: jsonb("bundles").$type<string[]>().notNull(),
  hosts: jsonb("hosts").$type<string[]>().notNull(),
  updatedAt: text("updated_at").notNull(),
  // The admin who last moved it. Null is allowed for a row no request wrote — nothing writes
  // one today, and a column that cannot say "unknown" invites a lie later.
  updatedBy: text("updated_by"),
});

/**
 * Warm room held for each size class, as an admin owns it — one row, and the only row
 * (core/reserved_capacity.ts).
 *
 * A number per class and nothing else: the shape a slot holds is the class's own, from
 * `RYPH_RUN_SIZES`, so it cannot drift from the runs it reserves for. No row means nothing
 * reserved, the same as every class at 0.
 */
export const reservedCapacity = pgTable("reserved_capacity", {
  // One deployment, one setting, by a constant id — the egress allowlist's reason.
  id: text("id").primaryKey(),
  // Class name → slots. Names, like a repo's size class, so a class the configuration no longer
  // defines is ignored until the next save drops it. A class missing from the map is 0.
  slots: jsonb("slots").$type<Record<string, number>>().notNull(),
  updatedAt: text("updated_at").notNull(),
  // The admin who last moved it; null for break-glass.
  updatedBy: text("updated_by"),
});

// Artifacts (core/artifacts.ts): an HTML page an agent published, versioned. The artifact row
// carries what the list shows — the latest title and version — and who first asked for it, and
// how (`mayVersion` decides by them; copied off the first run and its task, which never change);
// a delete keeps it as a tombstone and purges its versions and their images, which are
// otherwise written once and never change. Versions and images are keyed by unique indexes
// rather than composite primary keys, for the reason `run_background_commands` gives. The list
// reads live rows newest first, which `artifacts_by_updated` serves; a new artifact looks for
// one its run already created with the same document, which `artifacts_by_origin_run` serves.
export const artifacts = pgTable("artifacts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  originRunId: text("origin_run_id").notNull().references(() => runs.id),
  requestedBy: text("requested_by"),
  requestOrigin: text("request_origin").$type<Task["origin"]>().notNull(),
  originChatroomId: text("origin_chatroom_id"),
  originConversation: text("origin_conversation"),
  currentVersion: integer("current_version").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
}, (t) => [
  index("artifacts_by_updated").on(t.updatedAt, t.id).where(sql`${t.deletedAt} is null`),
  index("artifacts_by_origin_run").on(t.originRunId),
]);

export const artifactVersions = pgTable("artifact_versions", {
  artifactId: text("artifact_id").notNull().references(() => artifacts.id),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  // The document as the agent published it (what fetch_artifact answers), and as the content
  // route serves it: parsed, sanitized and serialized once, at publish (helpers/artifact_html.ts).
  html: text("html").notNull(),
  servedHtml: text("served_html").notNull(),
  bytes: integer("bytes").notNull(),
  runId: text("run_id").notNull().references(() => runs.id),
  // The run's task and the user it acted for: who may version the artifact next goes by them.
  taskId: text("task_id").notNull().references(() => tasks.id),
  requestedBy: text("requested_by"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("artifact_versions_key").on(t.artifactId, t.version),
  // The run page's question: which artifacts did this run publish.
  index("artifact_versions_by_run").on(t.runId),
]);

// A version's images: the run attachment each ref its document names resolved to at publish.
export const artifactVersionImages = pgTable("artifact_version_images", {
  artifactId: text("artifact_id").notNull(),
  version: integer("version").notNull(),
  ref: text("ref").notNull(),
  attachmentId: text("attachment_id").notNull().references(() => runAttachments.id),
}, (t) => [
  uniqueIndex("artifact_version_images_key").on(t.artifactId, t.version, t.ref),
]);

// Every document a run handed the artifact sanitizer (core/artifacts.ts), refused ones
// included: what the run's hourly rate counts. Kept apart from the versions so a delete, which
// purges those, does not give the run its hour back. Rows older than the hour are pruned when
// the run records its next one.
export const artifactPublishAttempts = pgTable("artifact_publish_attempts", {
  runId: text("run_id").notNull().references(() => runs.id),
  at: text("at").notNull(),
}, (t) => [
  index("artifact_publish_attempts_by_run").on(t.runId, t.at),
]);

export const runEvents = pgTable("run_events", {
  seq: serial("seq").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id),
  at: text("at").notNull(),
  kind: text("kind").$type<RunEvent["kind"]>().notNull(),
  detail: text("detail"),
}, (t) => [
  index("run_events_by_run").on(t.runId, t.seq),
]);

export const agentRelations = relations(agents, ({ many }) => ({
  tasks: many(tasks),
  runs: many(runs),
}));

export const taskRelations = relations(tasks, ({ one, many }) => ({
  agent: one(agents, { fields: [tasks.agentId], references: [agents.id] }),
  workspace: one(workspaces, { fields: [tasks.workspaceId], references: [workspaces.id] }),
  runs: many(runs),
}));

export const workspaceRelations = relations(workspaces, ({ many }) => ({
  repos: many(workspaceRepos),
  tasks: many(tasks),
}));

export const workspaceRepoRelations = relations(workspaceRepos, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceRepos.workspaceId],
    references: [workspaces.id],
  }),
  connectedRepo: one(connectedRepos, {
    fields: [workspaceRepos.connectedRepoId],
    references: [connectedRepos.id],
  }),
}));

export const runRelations = relations(runs, ({ one, many }) => ({
  task: one(tasks, { fields: [runs.taskId], references: [tasks.id] }),
  agent: one(agents, { fields: [runs.agentId], references: [agents.id] }),
  events: many(runEvents),
}));

export const runEventRelations = relations(runEvents, ({ one }) => ({
  run: one(runs, { fields: [runEvents.runId], references: [runs.id] }),
}));

export const gitVirtualKeyRelations = relations(gitVirtualKeys, ({ one }) => ({
  run: one(runs, { fields: [gitVirtualKeys.runId], references: [runs.id] }),
}));

export const connectedRepoRelations = relations(connectedRepos, ({ many }) => ({
  patches: many(patches),
  workspaces: many(workspaceRepos),
}));

export const patchRelations = relations(patches, ({ one }) => ({
  connectedRepo: one(connectedRepos, {
    fields: [patches.connectedRepoId],
    references: [connectedRepos.id],
  }),
  run: one(runs, { fields: [patches.runId], references: [runs.id] }),
  task: one(tasks, { fields: [patches.taskId], references: [tasks.id] }),
}));

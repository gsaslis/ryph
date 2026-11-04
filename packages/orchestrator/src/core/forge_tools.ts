// Forge tools, as the control plane decides them: an agent's forge policy resolved against one
// run into the scope the forge enforces, the tool allowlist the gateway filters by, and the cap a
// write is counted against. Pure — the repos arrive resolved, the ledger's counting is the
// store's single statement — so every rule here is testable without a database or a forge.
//
// The split this file keeps: WHAT a run may do is decided here, once, at startTask; the forge
// checks each call against it and moves bytes.

import type {
  ConnectedRepo,
  ForgeCapabilities,
  ForgePolicy,
  ForgeReadTool,
  ForgeScopeRepo,
  ForgeScopeThread,
  ForgeWriteTool,
  RunForgeScope,
} from "./types.ts";
import { MAX_FORGE_CAP } from "./types.ts";

export const FORGE_READ_TOOLS: readonly ForgeReadTool[] = [
  "get_issue",
  "list_issues",
  "get_change_request",
  "compare_change_request",
  "list_change_requests",
];

export const FORGE_WRITE_TOOLS: readonly ForgeWriteTool[] = [
  "create_issue",
  "add_comment",
  "add_labels",
  "submit_review",
  "close_issue",
];

/**
 * add_labels has no cap of its own in the policy — the label allowlist is the decision — but it
 * is still a write the model loop can repeat, so it counts against this fixed ceiling.
 */
export const LABEL_ACTIONS_MAX = MAX_FORGE_CAP;

/** The tools a run's capabilities grant, in a stable order — the gateway's allowlist for the
 * platform forge server, derived and never chosen, so `read: false` means the read tools are
 * absent from `tools/list` rather than refused on call. */
export function forgeAllowedTools(capabilities: ForgeCapabilities): string[] {
  const tools: string[] = [];
  if (capabilities.read) tools.push(...FORGE_READ_TOOLS);
  if (capabilities.createIssues !== null) tools.push("create_issue");
  if (capabilities.comment !== null) tools.push("add_comment");
  if (capabilities.labels.length > 0) tools.push("add_labels");
  if (capabilities.review !== null) tools.push("submit_review");
  if (capabilities.closeIssues !== null) tools.push("close_issue");
  return tools;
}

/** The cap a write is counted against, or null when the capability is absent. */
export function forgeCapFor(capabilities: ForgeCapabilities, tool: ForgeWriteTool): number | null {
  switch (tool) {
    case "create_issue":
      return capabilities.createIssues?.max ?? null;
    case "add_comment":
      return capabilities.comment?.max ?? null;
    case "submit_review":
      return capabilities.review?.max ?? null;
    case "close_issue":
      return capabilities.closeIssues?.max ?? null;
    case "add_labels":
      return capabilities.labels.length > 0 ? LABEL_ACTIONS_MAX : null;
  }
}

/** The connected repos a policy names, when it names a list — what startTask must look up. */
export function forgePolicyRepoIds(policy: ForgePolicy): string[] {
  return policy.repos === "run" ? [] : [...policy.repos.connectedRepoIds];
}

export interface ForgeScopeInput {
  policy: ForgePolicy;
  /** The connected repos the run checks out, resolved. */
  runRepos: ReadonlyArray<ConnectedRepo>;
  /** The repos a list policy names, resolved; archived and missing ones already dropped. */
  listedRepos: ReadonlyArray<ConnectedRepo>;
  origin: ForgeScopeThread | null;
  targetChangeRequest?: { connectedRepoId: string; thread: string } | null;
  /** The run works a fork pull request's head (`worksForkHead`): whatever the policy says, it
   * reads only the repo it checks out and writes only in the thread it was commanded from —
   * comments and reviews there, nothing else. */
  confined?: boolean;
  provenance: RunForgeScope["provenance"];
}

/** One connected repo, frozen as the forge will be addressed with it. */
function scopeRepo(repo: ConnectedRepo): ForgeScopeRepo {
  return {
    connectedRepoId: repo.id,
    provider: repo.provider,
    repoRef: repo.repoRef,
    tenantId: repo.installationId,
  };
}

/**
 * The policy resolved against a run, or null when it grants nothing to act on: no repo in
 * scope. A copy throughout — the agent row stays editable and this snapshot must not follow it.
 *
 * A `local` repository is never writable — it has no threads, issues or reviews — so it never
 * enters `repos`, whichever list the policy reads; a checkout of only local repositories is
 * therefore no scope at all. It stays in `sourceRepos`: what the agent read, which the forge
 * answers as private.
 *
 * The origin thread survives only when its repo is in scope: a run commanded from a repo the
 * policy's list leaves out has no thread there to call its own.
 */
export function composeForgeScope(input: ForgeScopeInput): RunForgeScope | null {
  const confined = input.confined === true;
  const source = confined || input.policy.repos === "run" ? input.runRepos : input.listedRepos;
  const seen = new Set<string>();
  const repos: RunForgeScope["repos"] = [];
  for (const repo of source) {
    if (repo.provider === "local" || seen.has(repo.id)) continue;
    seen.add(repo.id);
    repos.push(scopeRepo(repo));
  }
  if (repos.length === 0) return null;
  // The checkout rides along whatever the policy's repo list says, deduped: it is not a writable
  // set, it is what the agent has READ, and the forge refuses a write to a public repo from a run
  // holding private source. Reading that off `repos` alone would call a run whose policy lists
  // only public repos source-free while its workspace is private.
  const sourceSeen = new Set<string>();
  const sourceRepos: RunForgeScope["sourceRepos"] = [];
  for (const repo of input.runRepos) {
    if (sourceSeen.has(repo.id)) continue;
    sourceSeen.add(repo.id);
    sourceRepos.push(scopeRepo(repo));
  }
  const { read, createIssues, comment, review, closeIssues, labels } = confined
    ? confinedPolicy(input.policy)
    : input.policy;
  return {
    repos,
    sourceRepos,
    origin: input.origin !== null && seen.has(input.origin.connectedRepoId)
      ? { ...input.origin }
      : null,
    ...(input.targetChangeRequest && seen.has(input.targetChangeRequest.connectedRepoId)
      ? {
        workedChangeRequests: [{
          connectedRepoId: input.targetChangeRequest.connectedRepoId,
          ref: input.targetChangeRequest.thread,
        }],
      }
      : {}),
    capabilities: {
      read,
      createIssues: createIssues === null ? null : { ...createIssues },
      comment: comment === null ? null : { ...comment },
      review: review === null ? null : { ...review },
      closeIssues: closeIssues === null ? null : { ...closeIssues },
      labels: [...labels],
    },
    provenance: { ...input.provenance },
  };
}

/**
 * A policy as a run on a fork's head may hold it: the code that run executed is a contributor's,
 * and anything the agent can do, that code can make it do. Reads stay (on the checked-out repo
 * alone, `composeForgeScope`); comments and reviews are held to the origin thread, under the
 * policy's own caps; issues, closes and labels — writes anywhere else in the repo — are gone.
 */
function confinedPolicy(policy: ForgePolicy): ForgeCapabilities {
  return {
    read: policy.read,
    createIssues: null,
    comment: policy.comment === null ? null : { where: "origin", max: policy.comment.max },
    review: policy.review === null ? null : { where: "origin", max: policy.review.max },
    closeIssues: null,
    labels: [],
  };
}

// The bridge between the form's issue and change request fields and the API's ForgePolicy, shared by
// the create and edit flows so both compose, seed and validate identically — the tool-policy
// bridge, for the one platform server the Tools picker does not offer.

import {
  type ConnectedRepo,
  DEFAULT_FORGE_CAPS,
  type ForgePolicy,
  type ForgeProvider,
  type ForgeWhere,
  MAX_FORGE_CAP,
  type McpServer,
  PLATFORM_FORGE_SERVER_ID,
} from "$lib/api/types";
import type { ToolAccessState } from "$lib/api/mcp-servers";
import { forgeRepoLabel } from "$lib/utils/forge";

/** The orchestrator's ceilings on a policy's two lists. */
export const MAX_FORGE_REPOS = 20;
export const MAX_FORGE_LABELS = 50;
export const MAX_FORGE_LABEL_CHARS = 50;

/** The form's working shape: every capability's tick and its settings, caps as typed. */
export interface ForgeFields {
  /** "run": the connected repos the run checks out. "list": the ones ticked in `connectedRepoIds`. */
  repoMode: "run" | "list";
  connectedRepoIds: string[];
  read: boolean;
  createIssues: boolean;
  createIssuesMax: string;
  comment: boolean;
  commentWhere: ForgeWhere;
  commentMax: string;
  review: boolean;
  reviewWhere: ForgeWhere;
  reviewMax: string;
  closeIssues: boolean;
  closeIssuesWhere: ForgeWhere;
  closeIssuesMax: string;
  /** Comma-separated label names. */
  labels: string;
}

/**
 * Whether this deployment serves the forge's tools, as far as the form can tell: `on` when the
 * gateway answered with the platform forge row, `off` when it answered without one, `unknown`
 * when it did not answer at all — which, as for Tools, must never be read as "off".
 */
export type ForgeToolsState = "on" | "off" | "unknown";

export function forgeToolsState(
  toolAccessState: ToolAccessState,
  mcpServers: McpServer[],
): ForgeToolsState {
  if (toolAccessState !== "on") return "unknown";
  const row = mcpServers.find((s) => s.id === PLATFORM_FORGE_SERVER_ID);
  return row !== undefined && row.archivedAt === null ? "on" : "off";
}

/**
 * Whether issue and change request tools mean anything here: only where some way in has them. A
 * repository on this machine has neither, so a deployment with nothing else does not offer them.
 * Unknown providers (the list could not be read) say nothing, and the tools stay offered.
 */
export function forgeToolsOffered(forgeProviders: ForgeProvider[] | null): boolean {
  return forgeProviders === null || forgeProviders.some((p) => p !== "local");
}

/** The labels as typed: trimmed, blanks dropped, and each name once regardless of case (the
 * first spelling wins), as the orchestrator counts them. */
export function parseLabels(labels: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels.split(",")) {
    const label = raw.trim();
    if (label === "" || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push(label);
  }
  return out;
}

/**
 * A cap as typed, or the default when blank. Not clamped: forgePolicyProblem says what is wrong.
 * A number input's binding hands back a number (or nothing, cleared), whatever the field's type
 * says, so both are read as text first.
 */
function parseCap(typed: string | number | null | undefined, fallback: number): number {
  const text = String(typed ?? "").trim();
  return text === "" ? fallback : Number(text);
}

/** Whether the fields grant anything at all — labels alone do: they allow add_labels. */
function grantsAnything(fields: ForgeFields): boolean {
  return fields.read || fields.createIssues || fields.comment || fields.review ||
    fields.closeIssues || parseLabels(fields.labels).length > 0;
}

/** Builds the policy from the fields; granting nothing is no forge tools (null), which is also
 * the only spelling of it the orchestrator accepts. */
export function composeForgePolicy(fields: ForgeFields): ForgePolicy | null {
  if (!grantsAnything(fields)) return null;
  return {
    repos: fields.repoMode === "run"
      ? "run"
      : { connectedRepoIds: [...new Set(fields.connectedRepoIds)] },
    read: fields.read,
    createIssues: fields.createIssues
      ? { max: parseCap(fields.createIssuesMax, DEFAULT_FORGE_CAPS.createIssues) }
      : null,
    comment: fields.comment
      ? {
        where: fields.commentWhere,
        max: parseCap(fields.commentMax, DEFAULT_FORGE_CAPS.comment),
      }
      : null,
    review: fields.review
      ? {
        where: fields.reviewWhere,
        max: parseCap(fields.reviewMax, DEFAULT_FORGE_CAPS.review),
      }
      : null,
    closeIssues: fields.closeIssues
      ? {
        where: fields.closeIssuesWhere,
        max: parseCap(fields.closeIssuesMax, DEFAULT_FORGE_CAPS.closeIssues),
      }
      : null,
    labels: parseLabels(fields.labels),
  };
}

/**
 * Seeds the fields from an existing policy (the edit flow). A capability that is off still carries
 * its default cap and "origin", so ticking it shows what will be saved.
 */
export function forgePolicyToFields(policy: ForgePolicy | null): ForgeFields {
  return {
    repoMode: policy === null || policy.repos === "run" ? "run" : "list",
    connectedRepoIds: policy === null || policy.repos === "run"
      ? []
      : [...policy.repos.connectedRepoIds],
    read: policy?.read ?? false,
    createIssues: (policy?.createIssues ?? null) !== null,
    createIssuesMax: String(policy?.createIssues?.max ?? DEFAULT_FORGE_CAPS.createIssues),
    comment: (policy?.comment ?? null) !== null,
    commentWhere: policy?.comment?.where ?? "origin",
    commentMax: String(policy?.comment?.max ?? DEFAULT_FORGE_CAPS.comment),
    review: (policy?.review ?? null) !== null,
    reviewWhere: policy?.review?.where ?? "origin",
    reviewMax: String(policy?.review?.max ?? DEFAULT_FORGE_CAPS.review),
    closeIssues: (policy?.closeIssues ?? null) !== null,
    closeIssuesWhere: policy?.closeIssues?.where ?? "origin",
    closeIssuesMax: String(policy?.closeIssues?.max ?? DEFAULT_FORGE_CAPS.closeIssues),
    labels: (policy?.labels ?? []).join(", "),
  };
}

/**
 * Why the fields cannot be saved as they stand, in the operator's words — or null when they can.
 * Each of these is a refusal the orchestrator would make anyway; catching it here means the form
 * names the repo or the cap, instead of a 400 naming an id. Fields granting nothing always pass:
 * they save as no forge tools.
 */
export function forgePolicyProblem(
  fields: ForgeFields,
  connectedRepos: ConnectedRepo[],
): string | null {
  if (!grantsAnything(fields)) return null;

  if (fields.repoMode === "list") {
    const ids = [...new Set(fields.connectedRepoIds)];
    if (ids.length === 0) {
      return "Pick at least one repository for issues and change requests, or use the repos each run checks out.";
    }
    if (ids.length > MAX_FORGE_REPOS) {
      return `Issues and change requests can name at most ${MAX_FORGE_REPOS} repositories.`;
    }
    for (const id of ids) {
      const repo = connectedRepos.find((r) => r.id === id);
      if (!repo) {
        return `Repository ${id} is not connected — remove it from issues and change requests.`;
      }
      if (repo.provider === "local") {
        return `"${
          forgeRepoLabel(repo)
        }" is on this machine and has no issues or change requests. Remove it from the list.`;
      }
      if (repo.archivedAt) {
        return `"${
          forgeRepoLabel(repo)
        }" is disconnected — remove it from issues and change requests.`;
      }
    }
  }

  const caps: Array<[boolean, string, string]> = [
    [fields.createIssues, fields.createIssuesMax, "issues opened"],
    [fields.comment, fields.commentMax, "comments"],
    [fields.review, fields.reviewMax, "reviews"],
    [fields.closeIssues, fields.closeIssuesMax, "issues closed"],
  ];
  for (const [on, typed, what] of caps) {
    if (!on) continue;
    const cap = parseCap(typed, 1);
    if (!Number.isInteger(cap) || cap < 1 || cap > MAX_FORGE_CAP) {
      return `The cap on ${what} must be a whole number from 1 to ${MAX_FORGE_CAP}.`;
    }
  }

  const labels = parseLabels(fields.labels);
  if (labels.length > MAX_FORGE_LABELS) {
    return `An agent can apply at most ${MAX_FORGE_LABELS} labels.`;
  }
  const long = labels.find((l) => l.length > MAX_FORGE_LABEL_CHARS);
  if (long) {
    return `The label "${long}" is longer than ${MAX_FORGE_LABEL_CHARS} characters.`;
  }
  return null;
}

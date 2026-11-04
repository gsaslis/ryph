// The forge's tools, as an MCP server lists and calls them. Bare names — the pi extension
// prefixes them with the platform server's slug, so the agent sees `forge__create_issue`. The
// gateway filters the list down to the run's grant; the descriptions are rendered from that
// grant too, so the agent reads WHICH repos, WHICH thread and WHICH labels without an environment
// block having to say so. Arguments are parsed here (zod stays out of core); everything a grant
// has an opinion on is decided in core/tool_service.ts.

import { describeIssues } from "@ryph/shared/http";
import { type ToolResult, type ToolServer, toolText } from "@ryph/shared/mcp";
import type { ToolGrant, ToolName } from "../core/types.ts";
import type { ToolRequest, ToolService } from "../core/tool_service.ts";
import {
  AddCommentArgsSchema,
  AddLabelsArgsSchema,
  CloseIssueArgsSchema,
  CompareChangeRequestArgsSchema,
  CreateIssueArgsSchema,
  GetThreadArgsSchema,
  jsonSchemaOf,
  LABEL_ACTIONS_MAX,
  ListChangeRequestsArgsSchema,
  ListIssuesArgsSchema,
  MAX_REVIEW_REMARKS,
  SubmitReviewArgsSchema,
} from "../schema.ts";
import type { z } from "@zod/zod";

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface ToolCallContext {
  service: ToolService;
  runId: string;
}

const SCHEMAS: Record<ToolName, z.ZodType> = {
  get_issue: GetThreadArgsSchema,
  get_change_request: GetThreadArgsSchema,
  compare_change_request: CompareChangeRequestArgsSchema,
  list_issues: ListIssuesArgsSchema,
  list_change_requests: ListChangeRequestsArgsSchema,
  create_issue: CreateIssueArgsSchema,
  add_comment: AddCommentArgsSchema,
  add_labels: AddLabelsArgsSchema,
  submit_review: SubmitReviewArgsSchema,
  close_issue: CloseIssueArgsSchema,
};

const READ_ONLY = { readOnlyHint: true, openWorldHint: true };
const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

/** Said on every tool that writes a body: how an image a tool returned gets into it. */
const IMAGES = " To show an image a tool returned in this run, write ![what it shows](img-…) " +
  "with the ref from its `Image ref:` line, at most 10 in one text.";

/** Said on the tools that write a review's remarks and replies when a GitLab repo is granted:
 * what the adapter refuses of a note on a diff, and the one shape its suggestions take. */
const GITLAB_SUGGESTIONS = " On GitLab, a line of a review remark or of a reply to one may not " +
  "start with `/` and a word (a quick action such as `/merge`) outside a ```suggestion fence; " +
  "`//` and `/*` lines are fine. A suggestion goes in its own fence at the " +
  "start of a line (```suggestion or ```suggestion:-A+B … ```).";

/** The plain descriptions, and what each grant-aware one adds to it. */
const BASE: Record<ToolName, string> = {
  get_issue: "Read an issue whole: its description and every comment, oldest first.",
  get_change_request:
    "Read a change request whole: its description, branch, changed files with the lines a " +
    "remark can anchor to, a timeline of every comment, review and inline remark in order, " +
    "and the head's CI, read live. A GitHub pull request or GitLab merge request also brings its " +
    "commits (and says which review threads are resolved); a Radicle patch brings its " +
    "revisions instead. " +
    "Read it BEFORE reviewing one or changing one: it is how you see what was already asked " +
    "for, what is still open, and whether CI is red.",
  compare_change_request:
    "Compare two versions of a change request for re-review. Currently Radicle only: use the " +
    "full revision ids from get_change_request, not commit SHAs. diff shows old head → new head " +
    "(including any base changes); range-diff compares the recorded commit series, useful after " +
    "rebasing or rewriting. This comparison does not define valid inline-review anchors: use " +
    "get_change_request for the current patch's anchors. GitHub and GitLab comparisons are not " +
    "supported yet.",
  list_issues: "List a repo's issues (30 a page), optionally only those carrying labels.",
  list_change_requests:
    "List a repo's change requests — e.g. a GitHub pull request, a GitLab merge request or a " +
    "Radicle patch — 30 a " +
    "page, open ones by default. Titles, authors, branches and state only: read one with " +
    "get_change_request for its history, its review timeline and its CI.",
  create_issue: "Open an issue. Your text is signed with your name and this run." + IMAGES,
  add_comment:
    "Comment on an issue's or a change request's conversation — e.g. a GitHub pull request, a " +
    "GitLab merge request or a Radicle patch. Without replyTo it is a top-level comment, for anything said to the " +
    "thread as a whole. To answer one inline review comment, pass its id as replyTo: the reply " +
    "goes into that review thread, where its reviewer reads it, and resolve: true also marks " +
    "the thread resolved — only once what it asked for is actually done. Your text is signed with " +
    "your name and this run." + IMAGES,
  add_labels:
    "Add labels to an issue or change request — e.g. a GitHub pull request, a GitLab merge " +
    "request or a Radicle patch. " +
    "Never removes one.",
  submit_review:
    "Submit one review of a change request — e.g. a GitHub pull request, a GitLab merge " +
    "request or a Radicle patch: a " +
    "body plus remarks anchored to lines of its diff, posted together as a single comment-only " +
    "review (never an approval or a rejection). Say each finding once — on its line when it has " +
    "one; the body carries the verdict and only what belongs on no line, never a restatement of " +
    "the remarks. Keep each remark short: the problem and the fix. The body and every remark " +
    "are signed with your name and this run." + IMAGES + " Images go in the body, not in a remark.",
  close_issue:
    "Close an issue as completed or not planned, optionally with a note saying why — the note " +
    "is signed with your name and this run. Never closes a change request (e.g. a GitHub pull " +
    "request, a GitLab merge request or a Radicle patch), and nothing reopens." + IMAGES,
};

function threadName(grant: ToolGrant, connectedRepoId: string, thread: string): string | null {
  const repo = grant.repos.find((r) => r.connectedRepoId === connectedRepoId);
  return repo === undefined ? null : `${repo.repoRef}#${thread}`;
}

/** The one sentence a grant adds to a tool's description. */
function scopeNote(grant: ToolGrant, name: ToolName): string {
  const repos = `Repos: ${grant.repos.map((r) => r.repoRef).join(", ")}.`;
  const { capabilities: c } = grant;
  const origin = grant.origin === null
    ? null
    : threadName(grant, grant.origin.connectedRepoId, grant.origin.ref);
  switch (name) {
    case "create_issue":
      return `${repos} At most ${c.createIssues?.max ?? 0} per run.` +
        (c.labels.length > 0 ? ` Labels you may apply: ${c.labels.join(", ")}.` : "");
    case "add_comment": {
      const where = c.comment?.where === "origin"
        ? origin === null
          ? `Only on issues and change requests you opened in this run, and change requests you worked on (checked out at start or with checkout_change_request). At most ${c.comment.max} per run.`
          : `Only on ${origin}, issues and change requests you opened in this run, and change requests you worked on (checked out at start or with checkout_change_request). At most ${c.comment.max} per run.`
        : `${repos} At most ${c.comment?.max ?? 0} per run.`;
      return c.review === null ? where : `${where} To review a change request, use submit_review.`;
    }
    case "add_labels":
      // Repo-wide by design: the allowlist is the decision, so labelling is not thread-scoped
      // the way commenting can be. Its cap is fixed rather than set by the policy, so it is
      // named here or the agent meets it as a surprise refusal.
      return `${repos} Labels you may apply: ${
        c.labels.join(", ")
      }. At most ${LABEL_ACTIONS_MAX} per run.`;
    case "submit_review": {
      const remarks = `At most ${MAX_REVIEW_REMARKS} remarks a review, and ${
        c.review?.max ?? 0
      } reviews per run.`;
      return c.review?.where === "origin"
        ? `Only on ${
          grant.origin?.kind === "change_request" && origin !== null
            ? origin
            : "no change request (this run came from none)"
        }. ${remarks}`
        : `${repos} ${remarks}`;
    }
    case "close_issue": {
      const where = c.closeIssues?.where === "origin"
        ? origin === null
          ? `Only issues you opened in this run. At most ${c.closeIssues.max} per run.`
          : `Only ${origin} and issues you opened in this run. At most ${c.closeIssues.max} per run.`
        : `${repos} At most ${c.closeIssues?.max ?? 0} per run.`;
      // The note is a comment and is granted as one: said here, or the agent meets it as a
      // surprise refusal after writing the note it cannot post.
      return c.comment === null
        ? `${where} You may not comment, so close without a note.`
        : `${where} A note counts as one of your comments.`;
    }
    default:
      return repos;
  }
}

/** Every tool, described for the calling run's grant when it has one. The gateway filters. */
export async function toolsFor(ctx: ToolCallContext): Promise<ToolDefinition[]> {
  const looked = await ctx.service.grantFor(ctx.runId);
  // "Could not ask" is not "holds nothing". Listing all nine tools with their generic
  // descriptions because the control plane blinked tells the caller which tools exist and what
  // they are for, and invites calls that can now only fail closed — capability disclosure and
  // wasted attempts, with the gateway's own filter as the single remaining layer. An empty list
  // says the honest thing: this server cannot tell you what you may do right now.
  if (looked.kind === "unavailable") return [];
  const grant = looked.kind === "grant" ? looked.grant : null;
  return (Object.keys(SCHEMAS) as ToolName[]).filter((name) =>
    name !== "compare_change_request" || grant?.repos.some((r) => r.provider === "radicle")
  ).map((name) => ({
    name,
    description: grant === null
      ? BASE[name]
      : `${BASE[name]}${
        (name === "submit_review" || name === "add_comment") &&
          grant.repos.some((r) => r.provider === "gitlab")
          ? GITLAB_SUGGESTIONS
          : ""
      } ${scopeNote(grant, name)}`,
    inputSchema: jsonSchemaOf(SCHEMAS[name]),
    annotations:
      name.startsWith("get_") || name.startsWith("list_") || name === "compare_change_request"
        ? READ_ONLY
        : WRITES,
  }));
}

const isToolName = (name: string): name is ToolName => Object.hasOwn(SCHEMAS, name);

/** One call; null for a tool this server does not have. */
export async function callTool(
  ctx: ToolCallContext,
  name: string,
  args: unknown,
): Promise<ToolResult | null> {
  if (!isToolName(name)) return null;
  const parsed = SCHEMAS[name].safeParse(args ?? {});
  if (!parsed.success) return toolText(describeIssues(parsed.error), true);
  const request = { tool: name, ...(parsed.data as object) } as ToolRequest;
  const outcome = await ctx.service.call(ctx.runId, request);
  return toolText(outcome.text, !outcome.ok);
}

/** The forge's tools as one calling run's MCP server. */
export function forgeToolServer(
  ctx: ToolCallContext,
  diag: { warn(event: string, fields?: Record<string, unknown>): void },
): ToolServer {
  return {
    info: { name: "ryph-forge", version: "0.0.1" },
    instructions: "Issues and pull requests on the forge, as the platform's App. Everything " +
      "you write is signed with your name and the run it came from, and every write counts " +
      "against this run's limit — write what a maintainer would want to read.",
    tools: {
      list: () => toolsFor(ctx),
      call: (name, args) => callTool(ctx, name, args),
    },
    failed(name, err) {
      diag.warn("tools.call_failed", { runId: ctx.runId, tool: name, err: String(err) });
      return "the forge could not complete the call";
    },
  };
}

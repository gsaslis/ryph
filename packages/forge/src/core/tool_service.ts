// Door ⑤'s work: one tool call from one run, from "which grant does it hold" to "what did the
// forge say". The tool layer (mcp/tools.ts) has already parsed the arguments; this file resolves
// the grant, checks the call against it, reads the repo's visibility live, reserves the write in
// the orchestrator's ledger, makes it, and settles it — reconciling a lost response by the
// marker the write carries before saying anything.
//
// Invariants:
// - every refusal is an answer the model reads, never a throw: a throw is reserved for a failure
//   that is nobody's argument, and the tool layer turns it into a generic error
// - nothing is written that was not reserved first, and nothing reserved is left unsettled when
//   the forge answered at all — a lost response is looked for before it is called failed
// - a write whose outcome could not be learned says so: the model is told to look before it
//   tries again, because "retry" is exactly how a lost response becomes two issues
// - visibility and labels are read live, cached for a minute: a repo turned public mid-run must
//   not keep being written to as private for the rest of the run. Visibility is read for every
//   repo of the grant (the rule needs all of them) under one token per installation, and in one
//   request where the forge answers them together; labels only for the repo a write applies them
//   to, and a label listing the forge cut short is never read as "no such label"
// - a check that cannot be made honestly is not made: a refusal must never tell the agent
//   something untrue about the repo
// - reads are budgeted per run: they spend the installation's rate limit, which every run and
//   the platform's own delivery share. The count lives in this process — a ceiling on one
//   confused loop, not a ledger. A WRITE's live checks are charged to the same budget: they cost
//   the same limit, and a refused write never reaches a cap, so this is what bounds an agent
//   that only ever attempts writes it is not allowed to make
// - a body's images (`![alt](img-…)`) are resolved against the calling run BEFORE the write is
//   reserved, and rendered for the forge before it is signed (core/images.ts): an
//   image that is not this run's refuses the write and spends nothing

import {
  type ActionOutcome,
  ControlPlaneRefusal,
  type ReserveOutcome,
  type ToolGrants,
} from "../ports/tool_grants.ts";
import {
  type BodyEmbed,
  type ChecksReport,
  ForgeApiError,
  type ForgeRegistry,
  type RepoVisibility,
  type WrittenTarget,
} from "../ports/forge_api.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import type { RunImages } from "../ports/run_images.ts";
import {
  ImageRefError,
  imageRefsIn,
  imageStyleOf,
  type RenderedBody,
  renderImages,
} from "./images.ts";
import type { ReadToolName, ToolGrant, ToolGrantRepo, WriteToolName } from "./types.ts";
import {
  checkToolCall,
  grantRepo,
  isBareGitlabNumber,
  isOriginThread,
  isWriteTool,
  recordedThread,
  type ToolCall,
  visibilityRefusal,
} from "./tool_grant.ts";
import { actionMarker, withSignature } from "./provenance.ts";
import { COMMIT_HISTORY_MAX, renderChangeList, renderIssueList, renderThread } from "./render.ts";
import { unanchoredRemarks } from "./diff_lines.ts";

/** A parsed tool call, whole. */
export type ToolRequest =
  | { tool: "get_issue"; repo: string; thread: string }
  | { tool: "get_change_request"; repo: string; thread: string }
  | {
    tool: "compare_change_request";
    repo: string;
    thread: string;
    from: string;
    to?: string;
    mode: "diff" | "range-diff";
  }
  | {
    tool: "list_issues";
    repo: string;
    state: "open" | "closed" | "all";
    labels: string[];
    page: number;
  }
  | { tool: "list_change_requests"; repo: string; state: "open" | "closed" | "all"; page: number }
  | { tool: "create_issue"; repo: string; title: string; body: string; labels: string[] }
  | {
    tool: "add_comment";
    repo: string;
    thread: string;
    body: string;
    /** A review comment of the change request: the comment is a reply in its review thread. */
    replyTo?: string;
    /** With `replyTo`: resolve that review thread once the reply has landed. */
    resolve: boolean;
  }
  | { tool: "add_labels"; repo: string; thread: string; labels: string[] }
  | {
    tool: "submit_review";
    repo: string;
    thread: string;
    body: string;
    comments: Array<{ path: string; line: number; side: "LEFT" | "RIGHT"; body: string }>;
  }
  | {
    tool: "close_issue";
    repo: string;
    thread: string;
    reason: "completed" | "not_planned";
    comment?: string;
  };

/** What the model reads back. */
export type ToolAnswer = { ok: true; text: string } | { ok: false; text: string };

export interface ToolServiceDeps {
  grants: ToolGrants;
  /** One API per forge; the repo a call names says which. */
  forges: ForgeRegistry;
  diag: Diagnostics;
  now(): Date;
  /** Where a body's image refs are resolved — the control plane. Null or absent: a body that
   * shows an image is refused, since nothing could say whether it is the run's. */
  images?: RunImages | null;
  /** How long a repo's visibility and labels are reused. Default 60s. */
  repoFactsTtlMs?: number;
  /** How many reads one run may make. Default 200. */
  readsPerRun?: number;
}

/**
 * What asking for a run's grant learned. Three-valued for the same reason `KeyStore.resolve` is:
 * "this run holds no grant" and "the control plane could not be asked" are different facts, and
 * a describer that collapses them answers a question nobody asked — see `mcp/tools.ts`.
 */
export type GrantLookup =
  | { kind: "grant"; grant: ToolGrant }
  | { kind: "none" }
  | { kind: "unavailable" };

export interface ToolService {
  /** The grant a run holds, for describing its tools. */
  grantFor(runId: string): Promise<GrantLookup>;
  call(runId: string, request: ToolRequest): Promise<ToolAnswer>;
}

const answer = (text: string): ToolAnswer => ({ ok: true, text });
const refusal = (text: string): ToolAnswer => ({ ok: false, text });

/** The grant-check slice of a request. */
function asCall(request: ToolRequest): ToolCall {
  switch (request.tool) {
    case "get_issue":
    case "get_change_request":
    case "compare_change_request":
    case "list_issues":
    case "list_change_requests":
      return { tool: request.tool, repo: request.repo };
    case "create_issue":
      return { tool: "create_issue", repo: request.repo, labels: request.labels };
    case "add_comment":
    case "submit_review":
      return { tool: request.tool, repo: request.repo, thread: request.thread };
    case "close_issue":
      // The note travels with the call: dropping it here is what let it past the comment rule.
      return {
        tool: "close_issue",
        repo: request.repo,
        thread: request.thread,
        comment: request.comment !== undefined,
      };
    case "add_labels":
      return {
        tool: "add_labels",
        repo: request.repo,
        thread: request.thread,
        labels: request.labels,
      };
  }
}

/** The one body a write carries — what its images are found in; null for a write with none. */
function bodyOf(request: ToolRequest): string | null {
  switch (request.tool) {
    case "create_issue":
    case "add_comment":
    case "submit_review":
      return request.body;
    case "close_issue":
      return request.comment ?? null;
    default:
      return null;
  }
}

/** The embeds argument an adapter takes: absent rather than empty, so a write without images
 * reaches the forge exactly as it did before there were any. */
const embedsArg = (rendered: RenderedBody): BodyEmbed[] | undefined =>
  rendered.embeds.length > 0 ? rendered.embeds : undefined;

/** A forge failure, in a sentence the model can act on. */
function describeFailure(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const UNSUPPORTED_COMPARISON =
  "Revision comparisons are supported only for Radicle patches; this repo's forge has none. " +
  "Do not retry — read the change request with get_change_request instead.";

/** Terminal: the forge said no, and saying it again changes nothing. Anything else — a 5xx, a
 * rate limit, a dead connection — leaves the write's fate unknown. */
function isDefinitive(err: unknown): boolean {
  return err instanceof ForgeApiError && err.terminal;
}

/**
 * How a write's answer NAMES what it just wrote.
 *
 * A URL where there is one, and the thread's own address where there is not. A deployment with
 * no explorer configured has no web page for a Radicle thread at all — the id IS the address —
 * and interpolating the empty string produced "Commented: " with nothing after it, which reads
 * to an agent like a write that half happened.
 */
function wroteAt(url: string, where: string): string {
  return url === "" ? `on ${where}` : `: ${url}`;
}

/**
 * Said to an agent that has just posted on the thread its own run came from, where the platform
 * keeps a status comment that repeats the run's summary at the end. The ask is in the run's
 * system prompt too, but as a conditional at the end of a long appendix, to be recalled many
 * tool calls later — a live run read its review onto its origin thread and then ended with a
 * plain marker anyway, so the thread said the same thing twice. Here it arrives at the moment
 * it is true, decided mechanically from the grant rather than from anything the agent said.
 *
 * Every run reports through `ryph__finish` or `ryph__report_outcome`, whose `comment` argument
 * is the setting named here. It changes only what the status comment shows — never the summary,
 * the ledger or the caps.
 */
const ORIGIN_WRITE_NUDGE =
  "This is posted in the thread this run came from, whose status comment repeats your summary " +
  "when the run ends — when you report how the run went (ryph__finish or " +
  'ryph__report_outcome), set its comment to "minimal" so the thread does not say it twice.';

/** The nudge for a write that LANDED, or "" for anything else: only a comment or a review, and
 * only on the run's origin thread, is something the status comment would repeat. */
function originNudge(grant: ToolGrant, repo: ToolGrantRepo, request: ToolRequest): string {
  if (request.tool !== "add_comment" && request.tool !== "submit_review") return "";
  return isOriginThread(grant, repo, request.thread) ? `\n${ORIGIN_WRITE_NUDGE}` : "";
}

/** What a review's diff read costs the budget. `listChangeRequestPatches` walks up to thirty
 * pages of a change request's files, so charging it one would price the most expensive check on this path
 * like the cheapest — and submit_review is the call an agent can most easily loop on. */
const PATCH_READ_COST = 10;

export function makeToolService(deps: ToolServiceDeps): ToolService {
  const { grants, forges, diag } = deps;
  /** The API for the forge a repo lives on. Throws `UnknownProviderError` — terminal, so it
   * reads to the agent as a refusal and never as an outage to retry. */
  const apiFor = (repo: ToolGrantRepo) => forges.for(repo.provider);
  const factsTtlMs = deps.repoFactsTtlMs ?? 60_000;
  const readsPerRun = deps.readsPerRun ?? 200;
  const visibility = new Map<string, { seen: RepoVisibility; expiresAtMs: number }>();
  const labelSets = new Map<string, { labels: string[]; complete: boolean; expiresAtMs: number }>();
  const reads = new Map<string, number>();
  /** When the forge will answer for an installation again, where it has said it is rate-limited.
   * A limit is a fact about the whole installation rather than about one call, so it is worth
   * remembering for the next one: otherwise every tool call keeps spending requests against an
   * allowance that is already gone — the same allowance ryph's own progress comments, reactions
   * and permission checks draw on for every repo of that installation. */
  const limitedUntil = new Map<string, number>();
  /** One rate limit, one tenant of one forge — never two forges' accounts under one key. */
  const tenantKey = (repo: ToolGrantRepo) => `${repo.provider}/${repo.tenantId}`;
  /** What a repo is asked about by: a GitLab project's id where the grant carries it — its path
   * can have been freed by a rename and taken by another project, whose visibility or labels
   * would then be read for it — and its address otherwise. A path is never all digits. */
  const addressOf = (repo: ToolGrantRepo) => repo.forgeId ?? repo.repoRef;
  const factKey = (repo: ToolGrantRepo) => `${tenantKey(repo)}/${addressOf(repo).toLowerCase()}`;
  const remember = <T>(cache: Map<string, T>, key: string, value: T) => {
    if (cache.size > 500) cache.clear();
    cache.set(key, value);
  };

  /** Every repo the visibility rule turns on: where a write may go, AND what the run checked
   * out. Deduped — a checkout repo is usually in the writable set too, and a `repos` list policy
   * is exactly the case where it is not. */
  const visibilityRepos = (grant: ToolGrant): ToolGrantRepo[] => {
    const byId = new Map<string, ToolGrantRepo>();
    for (const repo of [...grant.repos, ...grant.sourceRepos]) {
      if (!byId.has(repo.connectedRepoId)) byId.set(repo.connectedRepoId, repo);
    }
    return [...byId.values()];
  };

  /** Who can see each repo this run touches, by connected repo id, read live — what the
   * visibility rule is decided on. Whatever the cache does not hold is read in one call per
   * installation. */
  const visibilities = async (
    runId: string,
    grant: ToolGrant,
  ): Promise<Map<string, RepoVisibility>> => {
    const nowMs = deps.now().getTime();
    const known = new Map<string, RepoVisibility>();
    // Grouped by (forge, tenant): one request answers all the repos ONE tenant of ONE forge
    // holds, and no request can ever mix two forges' repos.
    const stale = new Map<string, ToolGrantRepo[]>();
    for (const repo of visibilityRepos(grant)) {
      const hit = visibility.get(factKey(repo));
      if (hit && hit.expiresAtMs > nowMs) known.set(repo.connectedRepoId, hit.seen);
      else stale.set(tenantKey(repo), [...(stale.get(tenantKey(repo)) ?? []), repo]);
    }
    for (const repos of stale.values()) {
      // Charged before the call, not after: a request that failed spent the limit all the same.
      chargeReads(runId, 1);
      const answered = await apiFor(repos[0]).repoVisibility(
        repos[0].tenantId,
        repos.map(addressOf),
      );
      for (const repo of repos) {
        const seen = answered.get(addressOf(repo));
        // Never defaulted: an answer that skipped a repo says nothing about it.
        if (seen === undefined) {
          // A local repo's address is a host path, which a run must not read in an error.
          const named = repo.provider === "local" ? "a repository on this machine" : repo.repoRef;
          throw new Error(`the forge did not say whether ${named} is private`);
        }
        known.set(repo.connectedRepoId, seen);
        remember(visibility, factKey(repo), { seen, expiresAtMs: nowMs + factsTtlMs });
      }
    }
    return known;
  };

  /** A repo's labels, as it spells them, and whether that is all of them — read only when a
   * write applies labels there. */
  const labelsOf = async (
    runId: string,
    repo: ToolGrantRepo,
  ): Promise<{ labels: string[]; complete: boolean }> => {
    const nowMs = deps.now().getTime();
    const hit = labelSets.get(factKey(repo));
    if (hit && hit.expiresAtMs > nowMs) return { labels: hit.labels, complete: hit.complete };
    chargeReads(runId, 1);
    const listed = await apiFor(repo).repoLabels(repo);
    remember(labelSets, factKey(repo), { ...listed, expiresAtMs: nowMs + factsTtlMs });
    return listed;
  };

  /** Counts one read against the run's budget; false once the budget is spent. */
  const spendRead = (runId: string): boolean => {
    const spent = (reads.get(runId) ?? 0) + 1;
    if (spent > readsPerRun) {
      if (spent === readsPerRun + 1) diag.warn("tools.read_budget_spent", { runId, readsPerRun });
      reads.set(runId, spent);
      return false;
    }
    // Bounded like the caches: forgetting every run's count at once only ever grants reads.
    if (reads.size > 5_000 && !reads.has(runId)) reads.clear();
    reads.set(runId, spent);
    return true;
  };

  /** Counts reads the agent did not ask for by name — the live checks a write makes before it is
   * reserved. They spend the installation's rate limit exactly as an agent's own reads do, and a
   * write REFUSED after them spends no cap, so uncounted they are an unbounded loop against the
   * limit the platform's own progress comments and permission checks share. Charged rather than
   * refused mid-flight: a check half-made would leave the answer telling the agent something
   * untrue about the repo. They drain the budget the NEXT write meets. */
  const chargeReads = (runId: string, n: number) => {
    if (reads.size > 5_000 && !reads.has(runId)) reads.clear();
    reads.set(runId, (reads.get(runId) ?? 0) + n);
  };

  /** Records a rate limit the forge dated, for `quietRefusal` to hold the next call against. */
  const rememberLimitMs = (repo: ToolGrantRepo, retryAfterMs: number | null | undefined) => {
    if (retryAfterMs == null) return;
    if (limitedUntil.size > 500) limitedUntil.clear();
    limitedUntil.set(tenantKey(repo), deps.now().getTime() + retryAfterMs);
  };

  const rememberLimit = (repo: ToolGrantRepo, err: unknown) => {
    if (err instanceof ForgeApiError) rememberLimitMs(repo, err.retryAfterMs);
  };

  /** The sentence for a call made while that installation's limit is still exhausted, or null
   * while it may be asked. Told as a wait rather than "try again shortly": the agent needs to
   * know that trying sooner cannot work and costs the platform. */
  const quietRefusal = (repo: ToolGrantRepo): string | null => {
    const until = limitedUntil.get(tenantKey(repo)) ?? 0;
    const leftMs = until - deps.now().getTime();
    if (leftMs <= 0) return null;
    const minutes = Math.ceil(leftMs / 60_000);
    return `The forge is rate-limited for ${repo.repoRef}'s account for ${
      minutes <= 1 ? "about another minute" : `about another ${minutes} minutes`
    }, so this was not attempted. Nothing was written. Do not retry before then — every attempt ` +
      "spends the same allowance, which ryph's own comments on this repo also need.";
  };

  const read = async (
    runId: string,
    repo: ToolGrantRepo,
    request: Extract<ToolRequest, { tool: ReadToolName }>,
  ): Promise<string> => {
    const api = apiFor(repo);
    switch (request.tool) {
      case "get_issue": {
        const thread = await api.fetchThread(repo, { kind: "issue", ref: request.thread });
        return renderThread(repo.repoRef, thread, null, repo.provider);
      }
      case "get_change_request": {
        const kind = await api.threadKind(repo, request.thread);
        if (kind !== "change_request") {
          return `${repo.repoRef}#${request.thread} is an issue, not a change request — read it with get_issue.`;
        }
        // The conversation and the diff together — one round trip rather than two, because a
        // change request read is what a whole run waits on.
        const [thread, files] = await Promise.all([
          api.fetchThread(repo, { kind, ref: request.thread }),
          api.listChangeRequestFiles(repo, request.thread),
        ]);
        // The history and the CI come AFTER it, and that is not an oversight. Both describe a
        // head, and the head this read shows is the one `fetchThread` just answered with —
        // asking about them first would let a push that landed mid-read be summarised beside a
        // branch line describing the commit before it.
        const headSha = thread.changeRequest?.headSha ?? "";
        const [commits, checks] = await Promise.all([
          // The history is context, and the change request is the subject: a forge that will
          // not list commits degrades that ONE section (the rendering says so) rather than
          // costing the agent everything else it asked for. The failure still teaches this
          // service what it teaches every other read — a rate limit the forge DATED is
          // remembered, or the next call walks into the same wall.
          api.listChangeRequestCommits(repo, request.thread, COMMIT_HISTORY_MAX, {
            // What the head just told us, handed on rather than bought again: the count is
            // what places the history window, and the forge already answered it once.
            total: thread.changeRequest?.commitCount ?? null,
          }).catch((err) => {
            rememberLimit(repo, err);
            diag.warn("tools.commits_unread", { tool: request.tool, err: String(err) });
            return null;
          }),
          headSha === ""
            ? Promise.resolve<ChecksReport>({
              kind: "unavailable",
              reason: "the forge did not say what this change request's head is",
            })
            : api.readChecks(repo, headSha).catch((err): ChecksReport => {
              // The port says `readChecks` answers rather than throws; if an adapter ever
              // does, it must still not be what costs the agent the change request.
              rememberLimit(repo, err);
              diag.warn("tools.checks_unread", { tool: request.tool, err: String(err) });
              return {
                kind: "unavailable",
                reason: `CI could not be read (${describeFailure(err)})`,
              };
            }),
        ]);
        // A rate limit the CI read was DATED with is a fact about the whole installation, and
        // this path answers rather than throws — so it is recorded by hand, or an exhausted
        // installation keeps paying a mint and two requests on every change request read.
        if (checks.kind === "unavailable") rememberLimitMs(repo, checks.retryAfterMs);
        // A change request read is the most expensive read this surface makes: a thread, its
        // diff, its history and its CI are a dozen upstream requests. Charged as TWO of the
        // run's reads rather than one — the budget is a ceiling on what one confused loop can
        // spend of the installation's rate limit, and a ceiling that prices this like
        // `get_issue` is off by an order of magnitude.
        chargeReads(runId, 1);
        return renderThread(repo.repoRef, thread, { files, commits, checks }, repo.provider);
      }
      case "compare_change_request": {
        if (api.compareChangeRequest === undefined) {
          // Refused up front in `call`; terminal here too, so it can never read as retryable.
          throw new ForgeApiError(UNSUPPORTED_COMPARISON, true);
        }
        const comparison = await api.compareChangeRequest(repo, request.thread, request);
        const endpoint = (r: typeof comparison.from) => `${r.id} (base ${r.base}, head ${r.head})`;
        return [
          `Revision comparison (${comparison.mode}) for ${repo.repoRef}#${request.thread}`,
          `from: ${endpoint(comparison.from)}`,
          `to: ${endpoint(comparison.to)}`,
          comparison.mode === "diff"
            ? "Head-to-head diff: includes base changes as well as patch edits."
            : "Range-diff: compares the two recorded commit series, not just their final trees.",
          "Not inline-review anchors. Read get_change_request for the current patch's valid anchors.",
          comparison.text || "(no differences)",
          ...(comparison.truncated
            ? ["[comparison truncated; this is not the complete output]"]
            : []),
        ].join("\n\n");
      }
      case "list_issues": {
        const page = await api.listIssues(repo, request);
        return renderIssueList(repo.repoRef, request.state, request.page, page);
      }
      case "list_change_requests": {
        const page = await api.listChangeRequests(repo, request);
        return renderChangeList(repo.repoRef, request.state, request.page, page);
      }
    }
  };

  /** Makes the write, answering what it created; `actionId` rides the body as its marker.
   * `noteActionId` is close_issue's note — its own reserved action, because it is its own
   * comment; null when the close carries none. */
  const write = async (
    ctx: {
      runId: string;
      grant: ToolGrant;
      repo: ToolGrantRepo;
      request: Extract<ToolRequest, { tool: WriteToolName }>;
      kind: "issue" | "change_request" | null;
      labels: string[];
      actionId: string;
      /** close_issue's note — its own reserved action; null when the close carries none. */
      noteActionId: string | null;
      /** The head submit_review's remarks were checked against; null when it checked none. */
      reviewHeadSha: string | null;
      /** The write's body (close_issue's note) with its images rendered for this forge; null
       * for a write that carries none. */
      rendered: RenderedBody | null;
    },
  ): Promise<{ url: string; createdRef: string | null; said: string }> => {
    const {
      runId,
      grant,
      repo,
      request,
      kind,
      labels,
      actionId,
      noteActionId,
      reviewHeadSha,
      rendered,
    } = ctx;
    const api = apiFor(repo);
    const sign = (body: string) => withSignature(body, grant.provenance, actionId, repo.provider);
    // Taken before anything is written, with the same minute of slack `call` allows: whatever
    // this call posts was created after it, so a listing from here cannot miss it.
    const since = new Date(deps.now().getTime() - 60_000).toISOString();
    switch (request.tool) {
      case "create_issue": {
        const made = await api.createIssue(repo, {
          title: request.title,
          body: sign(rendered!.text),
          labels,
          ...(rendered!.embeds.length > 0 ? { embeds: rendered!.embeds } : {}),
        });
        return {
          url: made.url,
          createdRef: made.ref,
          said: `Opened ${repo.repoRef}#${made.ref}${
            wroteAt(made.url, `${repo.repoRef}#${made.ref}`)
          }`,
        };
      }
      case "add_comment": {
        if (request.replyTo !== undefined) {
          const made = await api.replyToReviewComment(
            repo,
            request.thread,
            request.replyTo,
            sign(rendered!.text),
            embedsArg(rendered!),
          );
          return {
            url: made.url,
            createdRef: null,
            said: `Replied in the review thread of comment ${request.replyTo}${
              wroteAt(made.url, `${repo.repoRef}#${request.thread}`)
            }`,
          };
        }
        const made = await api.createComment(
          repo,
          { kind: kind!, ref: request.thread },
          sign(rendered!.text),
          embedsArg(rendered!),
        );
        return {
          url: made.url,
          createdRef: null,
          said: made.url === ""
            ? `Commented on ${repo.repoRef}#${request.thread}.`
            : `Commented: ${made.url}`,
        };
      }
      case "add_labels": {
        const made = await api.addLabels(repo, { kind: kind!, ref: request.thread }, labels);
        return {
          url: made.url,
          createdRef: null,
          said: `Labelled ${repo.repoRef}#${request.thread} with ${labels.join(", ")}.`,
        };
      }
      case "submit_review": {
        // Every remark is signed too, under the review's own action id: a remark is read where
        // it sits on the diff, often far from the body, and must say who wrote it there. One
        // marker in several bodies is still one write — reconciliation looks for the review's
        // body (the adapters' `findMarkedWrite`), never for a remark.
        const made = await api.createReview(repo, request.thread, {
          body: sign(rendered!.text),
          ...(rendered!.embeds.length > 0 ? { embeds: rendered!.embeds } : {}),
          comments: request.comments.map((c) => ({ ...c, body: sign(c.body) })),
          headSha: reviewHeadSha,
        });
        const remarks = request.comments.length;
        return {
          url: made.url,
          createdRef: null,
          said: `Reviewed ${repo.repoRef}#${request.thread}${
            remarks === 0 ? "" : ` with ${remarks} ${remarks === 1 ? "remark" : "remarks"}`
          }${wroteAt(made.url, `${repo.repoRef}#${request.thread}`)}`,
        };
      }
      case "close_issue": {
        const closed = await api.closeIssue(repo, request.thread, request.reason);
        const what = `Closed ${repo.repoRef}#${request.thread} as ${
          request.reason === "not_planned" ? "not planned" : "completed"
        }`;
        if (request.comment === undefined) {
          return {
            url: closed.url,
            createdRef: null,
            said: `${what}${wroteAt(closed.url, `${repo.repoRef}#${request.thread}`)}`,
          };
        }
        // Closed first, noted second: the close is the act and retrying it is harmless, so a
        // note that fails leaves an answer that says exactly which half landed. The note is
        // signed with its OWN action id — it is its own row in the ledger, counted against the
        // comment cap like any other comment.
        try {
          const note = await api.createComment(
            repo,
            { kind: "issue", ref: request.thread },
            withSignature(rendered!.text, grant.provenance, noteActionId!, repo.provider),
            embedsArg(rendered!),
          );
          await settle(noteActionId!, runId, {
            outcome: "done",
            url: note.url,
            createdThreadRef: null,
          });
          return {
            url: note.url,
            createdRef: null,
            said: `${what}, with a note${wroteAt(note.url, `${repo.repoRef}#${request.thread}`)}`,
          };
        } catch (err) {
          // The note is a comment with a marker of its own, so a lost response is looked for
          // before it is called unwritten — exactly as one is for add_comment. Without this the
          // answer says "may not have been posted" about a note that DID post, and the obvious
          // next move (write it again) leaves the issue carrying two. Only a non-definitive
          // failure can have landed; a refusal cannot.
          const found = isDefinitive(err) ? null : await api.findMarkedWrite(
            repo,
            { kind: "comment", threadRef: request.thread },
            actionMarker(noteActionId!),
            since,
          ).catch((lookErr) => {
            diag.warn("tools.reconcile_failed", {
              runId,
              actionId: noteActionId,
              err: String(lookErr),
            });
            return null;
          });
          if (found !== null) {
            await settle(noteActionId!, runId, {
              outcome: "done",
              url: found.url,
              createdThreadRef: null,
            });
            return {
              url: found.url,
              createdRef: null,
              said: `${what}, with a note${
                wroteAt(found.url, `${repo.repoRef}#${request.thread}`)
              }`,
            };
          }
          await settle(noteActionId!, runId, {
            outcome: "failed",
            detail: describeFailure(err),
          });
          return {
            url: closed.url,
            createdRef: null,
            said: `${what}, but its note ${
              isDefinitive(err) ? "was refused" : "may not have been posted"
            } (${describeFailure(err)}). Read the issue before posting the note again.`,
          };
        }
      }
    }
  };

  /** Where a write that may have landed would be found; null for a write with no body to mark. */
  const targetOf = (
    request: Extract<ToolRequest, { tool: WriteToolName }>,
  ): WrittenTarget | null => {
    switch (request.tool) {
      case "create_issue":
        return { kind: "issue" };
      case "add_comment":
        return request.replyTo === undefined
          ? { kind: "comment", threadRef: request.thread }
          : { kind: "review_reply", threadRef: request.thread };
      case "submit_review":
        return { kind: "review", threadRef: request.thread };
      case "add_labels":
        // Adding a label twice is a no-op on the forge, so a blind retry is already safe.
        return null;
      case "close_issue":
        // Closing a closed issue is a no-op too, so the CLOSE needs no reconciling. Its note
        // does — it is a comment, and a second one is not a no-op — and it is looked for by its
        // own action's marker where it is written, because only that path knows it got that far.
        return null;
    }
  };

  /**
   * What resolving a review thread adds to the answer of a reply that LANDED — "" when the call
   * asked for none. After the reply, never before it: a thread resolved with no word of why is
   * worse than a reply left open. Resolving spends no cap of its own and needs no marker — it is
   * part of the reply's act, and resolving a resolved thread is a no-op — so a failure here is
   * told as exactly what it is: the reply stands, the thread is still open.
   */
  const resolveAfterReply = async (
    runId: string,
    repo: ToolGrantRepo,
    request: ToolRequest,
  ): Promise<string> => {
    if (request.tool !== "add_comment" || !request.resolve || request.replyTo === undefined) {
      return "";
    }
    // The remark read, and the thread listing GraphQL walks: the installation's limit, spent.
    chargeReads(runId, 2);
    try {
      await apiFor(repo).resolveReviewThread(repo, request.thread, request.replyTo);
      return " The review thread is resolved.";
    } catch (err) {
      rememberLimit(repo, err);
      diag.warn("tools.resolve_failed", { runId, err: String(err) });
      return ` The review thread was NOT resolved (${describeFailure(err)}) — the reply stands, ` +
        "so do not post it again; leave the thread for a human to resolve.";
    }
  };

  /** A write's live check that failed: refused where the forge said no, otherwise an outage. */
  const checkFailed = (
    runId: string,
    repo: ToolGrantRepo,
    tool: ToolRequest["tool"],
    err: unknown,
  ): ToolAnswer => {
    if (isDefinitive(err)) return refusal(`The forge refused: ${describeFailure(err)}`);
    // Nothing reserved, nothing written: a check that could not be made is a write not made.
    rememberLimit(repo, err);
    diag.warn("tools.check_failed", { runId, tool, err: String(err) });
    return refusal(
      `The forge did not answer (${
        describeFailure(err)
      }), so nothing was written. Try again shortly.`,
    );
  };

  const lookupsSpent = () =>
    `This run has spent all ${readsPerRun} of its forge lookups — the reads it made, and ` +
    "the checks every write needs before it is attempted. Work from what it has already " +
    "read.";

  /** A reservation the control plane answered and would not take: it was reached, so this is
   * no outage to retry blind — the same request would be refused the same way. */
  const notRecorded = (reason: string) =>
    `The control plane refused to record this write (${reason}), so it was not made. ` +
    "Sending it again unchanged will be refused the same way.";

  const settle = async (actionId: string, runId: string, outcome: ActionOutcome) => {
    try {
      await grants.complete(actionId, runId, outcome);
    } catch (err) {
      // The write's fate is known; only the ledger missed it. The trail shows the row reserved.
      diag.warn("tools.complete_failed", { runId, actionId, err: String(err) });
    }
  };

  return {
    async grantFor(runId) {
      try {
        const grant = await grants.resolve(runId);
        return grant === null ? { kind: "none" } : { kind: "grant", grant };
      } catch (err) {
        diag.warn("tools.grant_unavailable", { runId, err: String(err) });
        return { kind: "unavailable" };
      }
    },

    async call(runId, asked) {
      let grant: ToolGrant | null;
      try {
        grant = await grants.resolve(runId);
      } catch (err) {
        diag.warn("tools.grant_unavailable", { runId, err: String(err) });
        if (err instanceof ControlPlaneRefusal) {
          return refusal(
            `The control plane refused to look up this run's access (${err.reason}), so ` +
              "nothing was done.",
          );
        }
        return refusal(
          "The forge could not reach the control plane to check this run's access. Try again shortly.",
        );
      }
      if (grant === null) {
        return refusal(
          "This run can no longer act on the forge: it has concluded, or its repos were disconnected.",
        );
      }
      // The thread in the one spelling the control plane records (`recordedThread`), from here on
      // — the grant check, the visibility rule, the ledger row, the write and its answer all
      // name it alike. A shorthand reaching the ledger as typed was refused there whole.
      let request = asked;
      const named = grantRepo(grant, request.repo);
      if (named !== null && "thread" in request) {
        request = { ...request, thread: recordedThread(grant, named, request.thread) };
      }
      // A bare GitLab number on a write is resolved by asking, BEFORE the grant check: it is an
      // issue or a merge request, and which decides whether it is the run's own thread. The
      // lookup is the write's own (below) — budgeted once, and not asked twice.
      let resolvedKind: "issue" | "change_request" | null = null;
      if (
        named !== null && isWriteTool(request.tool) && "thread" in request &&
        isBareGitlabNumber(named, request.thread)
      ) {
        const quiet = quietRefusal(named);
        if (quiet !== null) return refusal(quiet);
        if (!spendRead(runId)) return refusal(lookupsSpent());
        try {
          chargeReads(runId, 1);
          resolvedKind = await apiFor(named).threadKind(named, request.thread);
        } catch (err) {
          return checkFailed(runId, named, request.tool, err);
        }
        request = {
          ...request,
          thread: `${resolvedKind === "issue" ? "issue" : "mr"}-${request.thread}`,
        };
      }
      const checked = checkToolCall(grant, asCall(request));
      if (!checked.ok) return refusal(`Not allowed: ${checked.reason}.`);
      const repo = checked.repo;

      // A provider that cannot compare revisions is a definitive no, not an outage: a grant
      // holding a GitHub and a Radicle repo lists this tool, and an agent calling it on the GitHub
      // one must be told so plainly — before a read is spent — rather than told to retry.
      if (
        request.tool === "compare_change_request" && forges.has(repo.provider) &&
        apiFor(repo).compareChangeRequest === undefined
      ) {
        return refusal(UNSUPPORTED_COMPARISON);
      }

      // Asked before anything is spent, reads and writes alike: this installation told us when
      // it would answer again, and going back early is how a rate limit becomes a tight loop.
      const quiet = quietRefusal(repo);
      if (quiet !== null) return refusal(quiet);

      if (
        request.tool === "get_issue" || request.tool === "get_change_request" ||
        request.tool === "compare_change_request" ||
        request.tool === "list_issues" || request.tool === "list_change_requests"
      ) {
        if (!spendRead(runId)) {
          return refusal(
            `This run has made all ${readsPerRun} of its reads of issues and change requests. ` +
              "Work from what it has already read.",
          );
        }
        try {
          return answer(await read(runId, repo, request));
        } catch (err) {
          if (isDefinitive(err)) return refusal(`The forge refused: ${describeFailure(err)}`);
          rememberLimit(repo, err);
          diag.warn("tools.read_failed", { runId, tool: request.tool, err: String(err) });
          return refusal(`The forge did not answer (${describeFailure(err)}). Try again shortly.`);
        }
      }

      // A write. Its live checks are reads of the forge, on the same budget the read tools spend:
      // a run that has exhausted it stops attempting writes too. That is the ceiling on refused
      // writes, which cost the installation's rate limit and never reach a cap to be counted by.
      if (resolvedKind === null && !spendRead(runId)) return refusal(lookupsSpent());

      // Everything that can refuse without spending the cap refuses first.
      const threadRef = request.tool === "create_issue" ? null : request.thread;
      let kind: "issue" | "change_request" | null = null;
      // The head a review's remarks were checked against, carried to the write so both are about
      // one commit. Null while nothing has been checked.
      let reviewHeadSha: string | null = null;
      let labels = checked.labels;
      // Said with the answer when the forge could not list a repo's labels whole: the write goes
      // ahead unchecked rather than on a refusal that may be untrue.
      let labelCaveat = "";
      try {
        // The target is judged for the kind of thread written on: a new issue at once, any
        // other write once the thread's kind is read (below).
        const seen = await visibilities(runId, grant);
        if (threadRef === null) {
          const hidden = visibilityRefusal(grant, seen, repo, "issue", null);
          if (hidden !== null) return refusal(`Not allowed: ${hidden}.`);
        } else {
          if (resolvedKind !== null) {
            kind = resolvedKind;
          } else {
            chargeReads(runId, 1);
            kind = await apiFor(repo).threadKind(repo, threadRef);
          }
          if (request.tool === "submit_review" && kind !== "change_request") {
            return refusal(
              `${repo.repoRef}#${threadRef} is an issue; reviews go on change requests.`,
            );
          }
          if (
            request.tool === "add_comment" && request.replyTo !== undefined &&
            kind !== "change_request"
          ) {
            return refusal(
              `${repo.repoRef}#${threadRef} is an issue, which has no review threads — comment ` +
                "without replyTo.",
            );
          }
          if (request.tool === "close_issue" && kind !== "issue") {
            return refusal(
              `${repo.repoRef}#${threadRef} is a change request; close_issue closes issues only.`,
            );
          }
          const hidden = visibilityRefusal(grant, seen, repo, kind, threadRef);
          if (hidden !== null) return refusal(`Not allowed: ${hidden}.`);
        }
        if (labels.length > 0) {
          const listed = await labelsOf(runId, repo);
          const existing = new Map(listed.labels.map((l) => [l.toLowerCase(), l]));
          const missing = labels.filter((l) => !existing.has(l.toLowerCase()));
          if (missing.length > 0) {
            const named = missing.map((l) => `"${l}"`).join(", ");
            // A cut-short listing is no evidence the label is absent: pass it to the forge, which
            // knows, and say the check could not be made rather than refuse on a guess.
            if (listed.complete) {
              return refusal(
                `${repo.repoRef} has no label ${named} — the run may apply only labels that ` +
                  "already exist there.",
              );
            }
            labelCaveat = ` (${repo.repoRef} has more labels than the forge would list, so ` +
              `${named} could not be checked here first)`;
          }
          labels = labels.map((l) => existing.get(l.toLowerCase()) ?? l);
        }
        // The forge refuses a whole review over one remark it cannot anchor; checked here, that
        // refusal names every bad remark and spends nothing.
        if (request.tool === "submit_review" && request.comments.length > 0) {
          chargeReads(runId, PATCH_READ_COST);
          const diff = await apiFor(repo).listChangeRequestPatches(repo, threadRef!);
          // Whatever these remarks are judged against is what they must be posted against: a
          // push landing between the two makes every validated remark unanchorable, GitHub 422s
          // the review whole, and the run's review cap is spent on nothing.
          reviewHeadSha = diff.headSha;
          const problems = unanchoredRemarks(diff.files, diff.complete, request.comments);
          if (problems.length > 0) {
            return refusal(
              `Nothing was posted — a review is posted whole or not at all, and ${
                problems.length === 1 ? "a remark" : `${problems.length} remarks`
              } cannot anchor to the diff:\n${problems.map((p) => `- ${p}`).join("\n")}\nFix ${
                problems.length === 1 ? "it" : "them"
              } and submit the review again.`,
            );
          }
        }
      } catch (err) {
        return checkFailed(runId, repo, request.tool, err);
      }

      // The body's images, the last check before anything is reserved: an image that is not
      // this run's refuses the write and spends nothing, like every check above. Rendered for
      // THIS forge — a link on one, a stored file on another — before it is signed.
      let rendered: RenderedBody | null = null;
      const text = bodyOf(request);
      if (text !== null) {
        if (
          request.tool === "submit_review" &&
          request.comments.some((c) => imageRefsIn(c.body).length > 0)
        ) {
          return refusal(
            "Images go in the review's body, not in its remarks. Nothing was posted — move the " +
              "image into the body and submit the review again.",
          );
        }
        try {
          rendered = await renderImages(
            deps.images ?? null,
            runId,
            text,
            imageStyleOf(repo.provider),
          );
        } catch (err) {
          if (err instanceof ImageRefError) return refusal(err.message);
          diag.warn("tools.images_unavailable", { runId, tool: request.tool, err: String(err) });
          if (err instanceof ControlPlaneRefusal) {
            return refusal(
              `The control plane refused to look up this text's images (${err.reason}), so ` +
                "nothing was written.",
            );
          }
          return refusal(
            "The forge could not reach the control plane to look up this text's images, so " +
              "nothing was written. Try again shortly.",
          );
        }
      }

      // What the forge would refuse of a remark's or a reply's own text (a GitLab diff note's
      // line that starts with `/`), refused here too, where it spends nothing; the write still
      // refuses it, should it get by.
      const textProblem = apiFor(repo).reviewTextProblem;
      if (textProblem !== undefined) {
        const problems = request.tool === "submit_review"
          ? request.comments.flatMap((c, i) => {
            const problem = textProblem(c.body);
            return problem === null ? [] : [`remark ${i + 1} (${c.path}:${c.line}): ${problem}`];
          })
          : request.tool === "add_comment" && request.replyTo !== undefined
          // Asked of the reply as it is posted, footer and all, under a stand-in action id.
          ? [textProblem(withSignature(rendered!.text, grant.provenance, "", repo.provider))]
            .filter((p) => p !== null)
          : [];
        if (problems.length > 0) {
          return refusal(`Nothing was posted:\n${problems.map((p) => `- ${p}`).join("\n")}`);
        }
      }

      let reserved: ReserveOutcome;
      try {
        reserved = await grants.reserve({
          runId,
          tool: request.tool,
          connectedRepoId: repo.connectedRepoId,
          threadRef,
        });
      } catch (err) {
        diag.warn("tools.reserve_unavailable", { runId, err: String(err) });
        return refusal(
          "The forge could not reach the control plane to record this write, so it was not made. Try again shortly.",
        );
      }
      if (reserved.kind === "refused") return refusal(`Not allowed: ${reserved.reason}.`);
      if (reserved.kind === "rejected") return refusal(notRecorded(reserved.reason));
      const { actionId } = reserved;
      // close_issue's note is a comment, so it is reserved AS one: it spends the comment cap the
      // operator set, and the trail shows it as the comment it is. Reserved before anything is
      // written, so a note over the cap closes nothing.
      let noteActionId: string | null = null;
      if (request.tool === "close_issue" && request.comment !== undefined) {
        let note;
        try {
          note = await grants.reserve({
            runId,
            tool: "add_comment",
            connectedRepoId: repo.connectedRepoId,
            threadRef: request.thread,
          });
        } catch (err) {
          diag.warn("tools.reserve_unavailable", { runId, err: String(err) });
          await settle(actionId, runId, {
            outcome: "failed",
            detail: "not attempted: the note could not be reserved",
          });
          return refusal(
            "The forge could not reach the control plane to record this write, so it was not made. Try again shortly.",
          );
        }
        if (note.kind === "rejected") {
          await settle(actionId, runId, {
            outcome: "failed",
            detail: `not attempted: the note was refused (${note.reason})`,
          });
          return refusal(notRecorded(note.reason));
        }
        if (note.kind === "refused") {
          await settle(actionId, runId, {
            outcome: "failed",
            detail: `not attempted: ${note.reason}`,
          });
          return refusal(
            `Not allowed: ${note.reason}. Nothing was written — close the issue without a note, ` +
              "or leave it open.",
          );
        }
        noteActionId = note.actionId;
      }
      const startedAt = deps.now();
      // A second of slack under the forge's own clock: `since` is compared to its timestamps.
      const since = new Date(startedAt.getTime() - 60_000).toISOString();

      try {
        const made = await write({
          runId,
          grant,
          repo,
          request,
          kind,
          labels,
          actionId,
          noteActionId,
          reviewHeadSha,
          rendered,
        });
        await settle(actionId, runId, {
          outcome: "done",
          url: made.url,
          createdThreadRef: made.createdRef,
        });
        if (made.createdRef !== null) grants.forget(runId);
        diag.debug("tools.written", { runId, tool: request.tool, actionId });
        const resolved = await resolveAfterReply(runId, repo, request);
        return answer(
          `${made.said}${labelCaveat}${resolved}${originNudge(grant, repo, request)}`,
        );
      } catch (err) {
        if (isDefinitive(err)) {
          await settle(actionId, runId, { outcome: "failed", detail: describeFailure(err) });
          return refusal(`The forge refused: ${describeFailure(err)}`);
        }
        // The response was lost, or the forge failed mid-write: the write may have landed.
        rememberLimit(repo, err);
        diag.warn("tools.write_ambiguous", {
          runId,
          tool: request.tool,
          actionId,
          err: String(err),
        });
        const target = targetOf(request);
        if (target !== null) {
          try {
            const found = await apiFor(repo).findMarkedWrite(
              repo,
              target,
              actionMarker(actionId),
              since,
            );
            if (found !== null) {
              await settle(actionId, runId, {
                outcome: "done",
                url: found.url,
                createdThreadRef: found.createdRef,
              });
              if (found.createdRef !== null) grants.forget(runId);
              const resolved = await resolveAfterReply(runId, repo, request);
              // A write reconciled back is a write that LANDED, so it earns the nudge too.
              return answer(
                (request.tool === "create_issue"
                  ? `Opened ${repo.repoRef}#${found.createdRef}${
                    wroteAt(found.url, `${repo.repoRef}#${found.createdRef}`)
                  }`
                  : `Written${wroteAt(found.url, repo.repoRef)}`) +
                  resolved + originNudge(grant, repo, request),
              );
            }
            await settle(actionId, runId, { outcome: "failed", detail: describeFailure(err) });
            return refusal(
              `The forge failed to write it (${
                describeFailure(err)
              }); nothing was written. You may try again.`,
            );
          } catch (lookErr) {
            diag.warn("tools.reconcile_failed", { runId, actionId, err: String(lookErr) });
          }
        }
        await settle(actionId, runId, {
          outcome: "failed",
          detail: `outcome unknown: ${describeFailure(err)}`,
        });
        return refusal(
          "The forge did not confirm this write and could not check whether it landed. Look " +
            "(with a read tool, if you have one) before trying again, or it may be made twice.",
        );
      }
    },
  };
}

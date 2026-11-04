// GitHub's webhook payloads, reduced to ForgeEvent — the only file that knows what an
// issue_comment, a pull_request_review_comment, a pull_request, a push, a check_run or a
// check_suite delivery looks like. The
// mailroom (@ryph/webhooks) verified the HMAC and persisted the raw body; this consumer opens
// the package, and the orchestrator decides.
//
// The schema deliberately breaks this package's strictObject rule, because it must: a GitHub
// payload is hundreds of keys deep and forever growing, so "refuse unknown keys" would refuse
// every delivery. The security posture here is EXTRACT AND BOUND instead — pick exactly the
// fields the event needs, length-bound every string, and let zod strip the rest. What this
// file did not extract never travels.

import { z } from "@zod/zod";
import type { Hook } from "@ryph/webhooks";
import type { ForgeEvent } from "../../core/types.ts";
import { describeIssues } from "@ryph/shared/http";
import type { DeliverOutcome, EventSink } from "../../ports/event_sink.ts";
import { REVIEW_HANDLE } from "./github.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";

// Extract-and-bound like everything else here. This is a GitHub `user`, which carries ~20
// keys and grows; strict would refuse every real delivery while every fixture passed.
// `type` is "User", "Organization" or "Bot" — read only to drop bot actors (see below).
const login = z.object({
  login: z.string().trim().min(1).max(100),
  type: z.string().max(40).optional(),
});

/** GitHub caps a comment body at 65536 characters; a bigger one is not a GitHub payload. */
const GithubIssueCommentSchema = z.object({
  action: z.string().trim().min(1).max(100),
  issue: z.object({
    number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    // Present (an object) exactly when the "issue" is really a pull request.
    pull_request: z.unknown().optional(),
  }),
  comment: z.object({
    id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    body: z.string().max(65_536),
    user: login,
  }),
  repository: z.object({
    clone_url: z.string().trim().min(1).max(2_000),
    full_name: z.string().trim().min(1).max(200),
  }),
});

/** An inline remark on a pull request's diff — a new one, or a reply in its review thread. */
const GithubReviewCommentSchema = z.object({
  action: z.string().trim().min(1).max(100),
  pull_request: z.object({
    number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }),
  comment: z.object({
    id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    body: z.string().max(65_536),
    user: login,
  }),
  repository: z.object({
    clone_url: z.string().trim().min(1).max(2_000),
    full_name: z.string().trim().min(1).max(200),
  }),
});

/** A pull request event: closing (with the `merged` flag the orchestrator settles a patch it
 * submitted by), or a head or base that may have moved — the head commit, the branch it
 * targets, its author, and its page. GitHub sends all of those on every
 * action; `changes` only on `edited`, and `changes.base` only when the edit retargeted it. */
const GithubPullRequestSchema = z.object({
  action: z.string().trim().min(1).max(100),
  pull_request: z.object({
    number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    merged: z.boolean().optional(),
    head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/) }),
    // GitHub's own cap on a ref name is far below this; a longer one is not a GitHub payload.
    base: z.object({ ref: z.string().trim().min(1).max(255) }),
    html_url: z.string().trim().max(2_000).nullable().optional(),
    user: login,
  }),
  changes: z.object({ base: z.unknown().optional() }).optional(),
  // Sent with `synchronize`: the head the push moved from.
  before: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/).optional(),
  sender: login,
  repository: z.object({
    clone_url: z.string().trim().min(1).max(2_000),
    full_name: z.string().trim().min(1).max(200),
  }),
});

/** A push: which ref moved, to what, and what the repo's default branch is right now. */
const GithubPushSchema = z.object({
  ref: z.string().trim().min(1).max(1_000),
  // All zeros when the ref was deleted, so the shape is checked here and the meaning below.
  after: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  deleted: z.boolean().optional(),
  sender: login,
  repository: z.object({
    clone_url: z.string().trim().min(1).max(2_000),
    full_name: z.string().trim().min(1).max(200),
    // GitHub's own cap on a ref name is far below this; a longer one is not a GitHub payload.
    default_branch: z.string().trim().min(1).max(255),
  }),
});

/**
 * The external id ryph posts every check run with: `<suite id>:<generation>:<check name>`. What a
 * re-request echoes back, held to that shape at the door — anything else is not a run ryph
 * posted, and nothing downstream should be asked about it.
 */
// The suite id's body is `ID_BODY` in @ryph/sealed, which forge does not depend on.
const RYPH_CHECK_EXTERNAL_ID = /^cs-[0-9a-z]{10,26}:\d{1,6}:[a-z0-9-]{1,40}$/;

/** A check run event. Only `rerequested` is ever acted on, and GitHub sends that to the App
 * that posted the run and to no other. */
const GithubCheckRunSchema = z.object({
  action: z.string().trim().min(1).max(100),
  check_run: z.object({
    external_id: z.string().max(200).nullable().optional(),
    head_sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
    name: z.string().max(200),
    app: z.object({ id: z.number().int() }).nullable().optional(),
  }),
  sender: login,
  repository: z.object({
    clone_url: z.string().trim().min(1).max(2_000),
    full_name: z.string().trim().min(1).max(200),
  }),
});

/** A check suite event: "Re-run all checks". Only `rerequested` is acted on, and GitHub sends
 * that only to the App whose suite it is. */
const GithubCheckSuiteSchema = z.object({
  action: z.string().trim().min(1).max(100),
  check_suite: z.object({
    head_sha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
    app: z.object({ id: z.number().int() }).nullable().optional(),
  }),
  sender: login,
  repository: z.object({
    clone_url: z.string().trim().min(1).max(2_000),
    full_name: z.string().trim().min(1).max(200),
  }),
});

/** Null: a payload this system has no use for — consumed, never an error. */
export function normalizeGithubIssueComment(
  payload: z.infer<typeof GithubIssueCommentSchema>,
  deliveryId: string,
  receivedAt: string,
): ForgeEvent | null {
  if (payload.action !== "created") return null; // edits and deletions carry no instruction
  // A bot's comment is never a command. This is what stops the loop the forge's own tools open:
  // an agent's comment can say `/ryph ada fix this`, and it is written as the App's bot. No bot
  // can hold a linked identity either, so the orchestrator would refuse it anyway — but that is
  // "probably refused downstream", and the drop belongs at the door. Only comments: a bot
  // closing or merging a pull request (a merge queue) is a verdict a patch must still hear.
  if (payload.comment.user.type === "Bot") return null;
  return {
    deliveryId,
    kind: "issue_comment.created",
    repo: {
      provider: "github",
      repoRef: payload.repository.full_name,
      url: payload.repository.clone_url,
    },
    actorLogin: payload.comment.user.login,
    thread: {
      // GitHub's integers stop here: a thread travels as text, because only this forge's are
      // numbers.
      kind: payload.issue.pull_request != null ? "change_request" : "issue",
      ref: String(payload.issue.number),
    },
    body: payload.comment.body,
    sourceCommentId: String(payload.comment.id),
    receivedAt,
  };
}

/**
 * An inline remark, as a command may arrive in one: a reviewer writing `/ryph ada fix this` on
 * the line they mean. The same event as a conversation comment, save that the thread is always
 * a change request and the event says which remark it came from — so the 👀 lands on it, and the
 * run can answer in its review thread rather than beside it.
 */
export function normalizeGithubReviewComment(
  payload: z.infer<typeof GithubReviewCommentSchema>,
  deliveryId: string,
  receivedAt: string,
): ForgeEvent | null {
  if (payload.action !== "created") return null;
  // The loop guard, as for a conversation comment: an agent's own reply in a review thread is
  // written as the App's bot, and may well quote a command.
  if (payload.comment.user.type === "Bot") return null;
  return {
    deliveryId,
    kind: "review_comment.created",
    repo: {
      provider: "github",
      repoRef: payload.repository.full_name,
      url: payload.repository.clone_url,
    },
    actorLogin: payload.comment.user.login,
    thread: { kind: "change_request", ref: String(payload.pull_request.number) },
    body: payload.comment.body,
    sourceCommentId: `${REVIEW_HANDLE}${payload.comment.id}`,
    inline: { commentId: String(payload.comment.id) },
    receivedAt,
  };
}

/** The `pull_request` actions after which the head or the base may stand somewhere new. */
const PUSH_ACTIONS = new Set(["opened", "reopened", "synchronize"]);

/**
 * A closed pull request is one of two events: merged, or closed without merging. A head or a
 * base that may have moved — `opened`, `reopened`, `synchronize`, and an `edited` that
 * retargeted the base — is a `change_request.pushed`, naming the head, the base branch, and
 * `refs/pull/<n>/head` to fetch it through. Every other action (labeled, assigned, an edit to
 * the title…) is null.
 *
 * A fork's pull request and a bot's push are forwarded like any other: whether the sender's
 * head may run on this deployment is the control plane's call (it asks the forge what the
 * sender may do), not a guess at the door.
 */
export function normalizeGithubPullRequest(
  payload: z.infer<typeof GithubPullRequestSchema>,
  deliveryId: string,
  receivedAt: string,
): ForgeEvent | null {
  const pr = payload.pull_request;
  const common = {
    deliveryId,
    repo: {
      provider: "github" as const,
      repoRef: payload.repository.full_name,
      url: payload.repository.clone_url,
    },
    actorLogin: payload.sender.login,
    thread: { kind: "change_request" as const, ref: String(pr.number) },
    body: null,
    sourceCommentId: null,
    receivedAt,
  };
  if (payload.action === "closed") {
    return pr.merged === true
      ? {
        ...common,
        kind: "change_request.merged",
        // The head as it stood at the merge — what was asked to merge, however it was merged.
        // A push the merge raced lands on the head branch after it, and is not this head's.
        merged: { baseRef: pr.base.ref, heads: [pr.head.sha] },
      }
      : { ...common, kind: "change_request.closed" };
  }
  const retargeted = payload.action === "edited" && payload.changes?.base != null;
  if (!PUSH_ACTIONS.has(payload.action) && !retargeted) return null;
  return {
    ...common,
    kind: "change_request.pushed",
    changeRequest: {
      ref: String(pr.number),
      headSha: pr.head.sha,
      before: payload.action === "synchronize" ? payload.before ?? null : null,
      baseRef: pr.base.ref,
      author: pr.user.login,
      fetchRef: `refs/pull/${pr.number}/head`,
      // A page for a human to open, so only ever a web link: anything else is no link at all.
      url: pr.html_url?.startsWith("https://") ? pr.html_url : null,
    },
  };
}

/**
 * A push to the repo's DEFAULT branch — the only branch whose movement the platform builds
 * from — as `branch.updated`. Everything else is null: a tag, another branch, a fork (whose
 * pushes this App never hears anyway), and a deletion, which moves nothing forward. The default
 * is read from this very payload, so a default renamed on GitHub arrives as a `branch.updated`
 * naming the new one, and the control plane learns it without asking.
 *
 * A bot's push is NOT dropped, unlike a bot's comment: a merge queue landing a pull request is
 * exactly the push an environment must hear, and a push carries no instruction to loop on.
 */
export function normalizeGithubPush(
  payload: z.infer<typeof GithubPushSchema>,
  deliveryId: string,
  receivedAt: string,
): ForgeEvent | null {
  if (payload.deleted === true || /^0+$/.test(payload.after)) return null;
  const defaultBranch = payload.repository.default_branch;
  if (payload.ref !== `refs/heads/${defaultBranch}`) return null;
  return {
    deliveryId,
    kind: "branch.updated",
    repo: {
      provider: "github",
      repoRef: payload.repository.full_name,
      url: payload.repository.clone_url,
    },
    actorLogin: payload.sender.login,
    thread: null,
    body: null,
    sourceCommentId: null,
    branch: { ref: defaultBranch, commit: payload.after },
    receivedAt,
  };
}

/**
 * A human pressing "Re-run" on one of ryph's check runs, as `check_run.rerequested`. The external
 * id is echoed back as GitHub holds it — ryph's own, but still untrusted text until the control
 * plane matches it to a suite on this repo and this commit, and checks the sender may write here.
 *
 * Every other action is null (`created` and `completed` are ryph's own writes coming back), and
 * so is a run another App posted, or one whose id is not the shape ryph posts. A bot sender is
 * NOT dropped: a re-request carries no instruction to loop on, and the control plane's write
 * check is what decides whether it counts.
 */
export function normalizeGithubCheckRun(
  payload: z.infer<typeof GithubCheckRunSchema>,
  deliveryId: string,
  receivedAt: string,
  appId: string | null = null,
): ForgeEvent | null {
  if (payload.action !== "rerequested") return null;
  const run = payload.check_run;
  if (appId !== null && run.app != null && String(run.app.id) !== appId) return null;
  if (typeof run.external_id !== "string" || !RYPH_CHECK_EXTERNAL_ID.test(run.external_id)) {
    return null;
  }
  return {
    deliveryId,
    kind: "check_run.rerequested",
    repo: {
      provider: "github",
      repoRef: payload.repository.full_name,
      url: payload.repository.clone_url,
    },
    actorLogin: payload.sender.login,
    thread: null,
    body: null,
    sourceCommentId: null,
    checkRun: { externalId: run.external_id, headSha: run.head_sha, name: run.name },
    receivedAt,
  };
}

/**
 * "Re-run all checks" on ryph's runs, as `check_suite.rerequested` — the only re-run button
 * GitHub offers on a run that passed. It names a commit and no run: the control plane re-runs
 * what it posted there, under the same write check as a single run's re-request. Every other
 * action is null (`requested` and `completed` are GitHub's bookkeeping on every push), and so is
 * another App's suite.
 */
export function normalizeGithubCheckSuite(
  payload: z.infer<typeof GithubCheckSuiteSchema>,
  deliveryId: string,
  receivedAt: string,
  appId: string | null = null,
): ForgeEvent | null {
  if (payload.action !== "rerequested") return null;
  const suite = payload.check_suite;
  if (appId !== null && suite.app != null && String(suite.app.id) !== appId) return null;
  return {
    deliveryId,
    kind: "check_suite.rerequested",
    repo: {
      provider: "github",
      repoRef: payload.repository.full_name,
      url: payload.repository.clone_url,
    },
    actorLogin: payload.sender.login,
    thread: null,
    body: null,
    sourceCommentId: null,
    checkSuite: { headSha: suite.head_sha },
    receivedAt,
  };
}

/** Whether a check run or check suite delivery is a re-request of this App's own, read
 * loosely: the only fields looked at before the schema. An App id that is absent is left to the
 * schema and the normalizer. */
function rerequestOfOurs(
  payload: unknown,
  key: "check_run" | "check_suite",
  appId: string | null,
): boolean {
  const p = payload as
    | { action?: unknown } & Record<string, { app?: { id?: unknown } | null } | null | undefined>
    | null;
  if (typeof p !== "object" || p === null || p.action !== "rerequested") return false;
  const id = p[key]?.app?.id;
  return appId === null || id == null || String(id) === appId;
}

/**
 * The mailroom consumer for the "github" registration: header-routed, schema-checked,
 * normalized, forwarded. Verdicts follow the queue's contract — an uninteresting event is
 * consumed ("ok"), a payload that can never parse is terminal, and only the sink decides
 * whether a delivery failure is worth retrying.
 */
export function githubWebhookConsumer(
  deps: {
    sink: EventSink;
    diag: Diagnostics;
    /** This deployment's App id: a check run event about another App's run is dropped here. */
    appId?: string | null;
  },
): (hook: Hook) => Promise<DeliverOutcome> {
  return async (hook) => {
    const eventName = hook.headers["x-github-event"];
    if (
      eventName !== "issue_comment" && eventName !== "pull_request_review_comment" &&
      eventName !== "pull_request" && eventName !== "push" && eventName !== "check_run" &&
      eventName !== "check_suite"
    ) {
      // Installation lifecycle, pings, stars — real deliveries, nothing to act on. Consumed.
      return { kind: "ok" };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(hook.body);
    } catch {
      return { kind: "failed", message: "the body is not JSON", terminal: true };
    }
    // GitHub stamps every delivery; a missing header falls back to our own hook id, which is
    // unique too — dedupe downstream just loses cross-redelivery matching for that hook.
    const deliveryId = hook.headers["x-github-delivery"] ?? hook.id;
    let event: ForgeEvent | null;
    if (eventName === "issue_comment") {
      const parsed = GithubIssueCommentSchema.safeParse(payload);
      if (!parsed.success) {
        return { kind: "failed", message: describeIssues(parsed.error), terminal: true };
      }
      event = normalizeGithubIssueComment(parsed.data, deliveryId, hook.receivedAt);
    } else if (eventName === "pull_request_review_comment") {
      const parsed = GithubReviewCommentSchema.safeParse(payload);
      if (!parsed.success) {
        return { kind: "failed", message: describeIssues(parsed.error), terminal: true };
      }
      event = normalizeGithubReviewComment(parsed.data, deliveryId, hook.receivedAt);
    } else if (eventName === "push") {
      const parsed = GithubPushSchema.safeParse(payload);
      if (!parsed.success) {
        return { kind: "failed", message: describeIssues(parsed.error), terminal: true };
      }
      event = normalizeGithubPush(parsed.data, deliveryId, hook.receivedAt);
    } else if (eventName === "check_run") {
      // Every App's runs on the repo arrive here, other CI's included, and their shape is theirs:
      // only a re-request of this App's run is held to the schema, so a foreign run with a long
      // name is consumed rather than failed.
      if (!rerequestOfOurs(payload, "check_run", deps.appId ?? null)) return { kind: "ok" };
      const parsed = GithubCheckRunSchema.safeParse(payload);
      if (!parsed.success) {
        return { kind: "failed", message: describeIssues(parsed.error), terminal: true };
      }
      event = normalizeGithubCheckRun(
        parsed.data,
        deliveryId,
        hook.receivedAt,
        deps.appId ?? null,
      );
    } else if (eventName === "check_suite") {
      // Every push makes a suite for every App with checks, and GitHub tells each of them:
      // only a re-request of this App's is held to the schema.
      if (!rerequestOfOurs(payload, "check_suite", deps.appId ?? null)) return { kind: "ok" };
      const parsed = GithubCheckSuiteSchema.safeParse(payload);
      if (!parsed.success) {
        return { kind: "failed", message: describeIssues(parsed.error), terminal: true };
      }
      event = normalizeGithubCheckSuite(
        parsed.data,
        deliveryId,
        hook.receivedAt,
        deps.appId ?? null,
      );
    } else {
      const parsed = GithubPullRequestSchema.safeParse(payload);
      if (!parsed.success) {
        return { kind: "failed", message: describeIssues(parsed.error), terminal: true };
      }
      event = normalizeGithubPullRequest(parsed.data, deliveryId, hook.receivedAt);
    }
    if (event === null) return { kind: "ok" };

    deps.diag.debug("github_webhooks.forwarding", {
      deliveryId: event.deliveryId,
      kind: event.kind,
    });
    return await deps.sink.deliver(event);
  };
}

// CI on GitLab: commit statuses, and nothing else — GitLab's own jobs report through the same
// channel, and so do ryph's checks (`ryph / <name>`), which join the commit's pipeline as an
// `external` stage. There is no re-run button for an external status: checks re-run from ryph.

import {
  type CheckReport,
  type CheckRun,
  type CheckRunReport,
  checkSeverity,
  type ChecksReport,
  ForgeApiError,
  type ForgeRepo,
  type ReportChecksOutcome,
} from "../../ports/forge_api.ts";
import { clip, type GitlabContext, messageOf, str, totalOf } from "./gitlab_client.ts";

/** What ryph's own statuses are named: `ryph / <check>` — the name a "pipelines must succeed"
 * rule sees, fixed here and nowhere else. */
export const STATUS_PREFIX = "ryph / ";

/** How many checks one read REPORTS; ordered worst first before the cut, so the cut can never
 * be what hides a red build. */
const CHECKS_MAX = 50;

/** How many statuses one read ASKS for — GitLab's largest page — so `unlisted` stays rare. */
const CHECKS_PAGE = 100;

const CHECK_NAME_MAX = 120;
const CHECK_URL_MAX = 500;

/** GitLab's cap on a status's `description`. */
const DESCRIPTION_MAX = 255;

/** A GitLab status as the port's check: its lifecycle and its verdict. */
function checkOf(raw: Record<string, unknown>): CheckRun {
  const status = str(raw.status, "pending");
  const lifecycle = ((): { status: string; conclusion: string | null } => {
    switch (status) {
      case "running":
        return { status: "in_progress", conclusion: null };
      case "success":
        return { status: "completed", conclusion: "success" };
      case "failed":
        // A job allowed to fail is GitLab's yellow: nothing is wrong enough to stop a merge.
        return {
          status: "completed",
          conclusion: raw.allow_failure === true ? "neutral" : "failure",
        };
      case "canceled":
        return { status: "completed", conclusion: "cancelled" };
      case "skipped":
        return { status: "completed", conclusion: "skipped" };
      case "manual":
        return { status: "completed", conclusion: "action_required" };
      // created, waiting_for_resource, preparing, pending, scheduled — and anything new: not
      // run yet, which is never a verdict.
      default:
        return { status: "queued", conclusion: null };
    }
  })();
  return {
    name: clip(str(raw.name, "(unnamed status)"), CHECK_NAME_MAX),
    ...lifecycle,
    detailsUrl: typeof raw.target_url === "string" ? clip(raw.target_url, CHECK_URL_MAX) : null,
  };
}

/** `GET /projects/:id/repository/commits/:sha/statuses` — the latest status per name. Answers,
 * never throws: an unread CI is `unavailable`, said in a sentence. */
export async function readChecks(
  ctx: GitlabContext,
  repo: ForgeRepo,
  headSha: string,
): Promise<ChecksReport> {
  const project = ctx.project(repo);
  let res;
  try {
    res = await ctx.client.call(
      "GET",
      `/projects/${project}/repository/commits/${encodeURIComponent(headSha)}/statuses` +
        `?per_page=${CHECKS_PAGE}&page=1`,
    );
  } catch (err) {
    return {
      kind: "unavailable",
      reason: `CI could not be read (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (res.status === 403) {
    return {
      kind: "unavailable",
      reason: "this ryph installation may not read CI on the forge (its GitLab account needs " +
        "at least the Reporter role on the project)",
    };
  }
  if (res.status !== 200 || !Array.isArray(res.body)) {
    const limited = res.status === 429 ? ctx.client.refusal("", res).retryAfterMs : null;
    return {
      kind: "unavailable",
      reason: `CI could not be read (${res.status}: ${messageOf(res.body)})`,
      ...(limited === null ? {} : { retryAfterMs: limited }),
    };
  }
  const listed = res.body as Array<Record<string, unknown>>;
  const items = listed.map(checkOf);
  // What GitLab holds and did not list arrived in NO order — it may be the failing build — so it
  // is its own count, never a pass. A total GitLab would not say is no count at all.
  const total = totalOf(res.headers);
  const unlisted = total === null ? 0 : Math.max(0, total - listed.length);
  items.sort((a, b) => checkSeverity(a) - checkSeverity(b));
  const shown = items.slice(0, CHECKS_MAX);
  return {
    kind: "reported",
    headSha,
    items: shown,
    cut: items.length - shown.length,
    unlisted,
    // One channel: nothing else could have failed to answer.
    partial: null,
  };
}

/** A ryph check as a GitLab status state. */
function stateOf(check: CheckRunReport): "pending" | "running" | "success" | "failed" | "canceled" {
  if (check.status === "queued") return "pending";
  if (check.status === "in_progress") return "running";
  switch (check.conclusion) {
    case "success":
    case "neutral":
      return "success";
    case "cancelled":
      return "canceled";
    // failure, timed_out, action_required — and a completed check that names no verdict, which
    // must not pass a merge gate by omission.
    default:
      return "failed";
  }
}

/**
 * One commit status per ryph check, `ryph / <name>`, on a commit GitLab already has.
 *
 * Idempotent without a stored ref: GitLab keys a status by (sha, name, ref), so a report whose
 * response was lost posts the same status again — and GitLab's 400 "Cannot transition status
 * via :x from :y" is that status already standing, which is success. A new generation posts
 * under the same names and replaces the older one, as GitHub's newest run does.
 *
 * The summary is not carried: a status has no body, and the suite page (`target_url`) holds it.
 * Both modes post: a status needs Developer, which a person's token holds as well as the bot's.
 */
export async function reportChecks(
  ctx: GitlabContext,
  repo: ForgeRepo,
  report: CheckReport,
): Promise<ReportChecksOutcome> {
  const project = ctx.project(repo);
  if (report.checks.length === 0) return { kind: "reported", refs: {} };
  const WRITE_MISSING = `the GitLab account @${ctx.self.login} cannot post commit statuses on ` +
    `${repo.repoRef} (it needs the Developer role there)`;
  const refs: Record<string, string> = {};
  // The ref a status rides when GitLab finds none for the commit itself; looked up once.
  let mergeRequestRef: string | null | undefined;
  for (const check of report.checks) {
    const name = `${STATUS_PREFIX}${check.name}`;
    const post = (ref: string | null) =>
      ctx.client.call(
        "POST",
        `/projects/${project}/statuses/${encodeURIComponent(report.headSha)}`,
        {
          state: stateOf(check),
          name,
          ...(ref === null ? {} : { ref }),
          ...(report.detailsUrl === null ? {} : { target_url: report.detailsUrl }),
          description: clip(check.title, DESCRIPTION_MAX - 1),
        },
      );
    let res = await post(null);
    // Without a `ref` GitLab takes the commit's pipeline's ref, else the first branch (by name)
    // holding it — verified on GitLab 17.11 — and two heads go wrong there: a fork merge
    // request's, on no branch of the target ("404 References for commit Not Found"), and one a
    // protected branch also holds, which a Developer may not start a pipeline on (403). Its
    // merge request's head ref names either, and takes a Developer's status.
    if (
      res.status === 403 ||
      (res.status === 404 && /references for commit/i.test(messageOf(res.body)))
    ) {
      if (mergeRequestRef === undefined) {
        mergeRequestRef = await mergeRequestRefOf(ctx, project, report.headSha);
      }
      if (mergeRequestRef !== null) res = await post(mergeRequestRef);
    }
    if ((res.status === 200 || res.status === 201) && res.body?.id !== undefined) {
      refs[check.name] = String(res.body.id);
      continue;
    }
    // The status already stands in this state (or a later one): GitLab's state machine refuses
    // the transition rather than repeating it — verified on GitLab 17.11 as "Cannot transition
    // status via :run from :running (Reason(s): …)". A finished status takes a new one instead.
    if (res.status === 400 && /cannot transition status/i.test(messageOf(res.body))) {
      if (check.forgeRef !== null) refs[check.name] = check.forgeRef;
      continue;
    }
    if (res.status === 403) {
      ctx.diag.warn("gitlab.statuses_write_missing", { repo: repo.repoRef });
      return { kind: "unsupported", reason: WRITE_MISSING };
    }
    // A commit GitLab does not have yet ("404 Commit Not Found", verified on GitLab 17.11), or
    // one no ref holds yet: a push makes it true a moment later, so it is worth asking again —
    // unlike a project that is gone.
    if (res.status === 404 && /commit/i.test(messageOf(res.body))) {
      throw new ForgeApiError(
        `posting the status ${name} failed (404): ${messageOf(res.body)}`,
        false,
      );
    }
    throw ctx.client.refusal(`posting the status ${name}`, res);
  }
  ctx.diag.debug("gitlab.checks_reported", {
    repo: repo.repoRef,
    suiteId: report.suiteId,
    generation: report.generation,
    checks: report.checks.length,
  });
  return { kind: "reported", refs };
}

/** `refs/merge-requests/<iid>/head` of the merge request whose head is `sha` (an open one
 * first), or null when none is. A lookup that fails is null too: the 404 it stood in for stands. */
async function mergeRequestRefOf(
  ctx: GitlabContext,
  project: string,
  sha: string,
): Promise<string | null> {
  try {
    const res = await ctx.client.call(
      "GET",
      `/projects/${project}/repository/commits/${encodeURIComponent(sha)}/merge_requests`,
    );
    if (res.status !== 200 || !Array.isArray(res.body)) return null;
    const heads = (res.body as Array<Record<string, unknown>>).filter((m) =>
      m.sha === sha && typeof m.iid === "number"
    );
    const mr = heads.find((m) => m.state === "opened") ?? heads[0];
    return mr === undefined ? null : `refs/merge-requests/${mr.iid}/head`;
  } catch {
    return null;
  }
}

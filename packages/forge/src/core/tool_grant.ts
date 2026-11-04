// Door ⑤'s grant check: is THIS call inside what the orchestrator granted the run? Pure — the
// grant and the call arrive resolved, the repo's live visibility arrives as a fact — so every
// rule is a table test. Nothing here decides what a run may do; it compares a call to a grant
// somebody else wrote, the way `http/auth.ts`'s memberOf compares a URL to a RunGrant.
//
// Invariants:
// - a refusal is a sentence the model reads (the tool answers `isError`), naming what it may do
//   instead — a model told only "no" retries blind
// - repos are matched by their forge's own rule — case-insensitively on GitHub, where "Acme/App"
//   and "acme/app" are one repository, and EXACTLY on Radicle, where a RID is base58 and case is
//   meaning (the same rule the orchestrator's `namesRepo` applies) — and answered with the
//   grant's spelling, so nothing downstream acts on the caller's casing
// - a thread is matched exactly, except that on Radicle a unique prefix of a COB id names its
//   object the way the bridge lets a human name it (see `namesThread`)
// - labels are matched case-insensitively against the allowlist and applied as the allowlist
//   spells them: the policy names labels, the agent does not get to invent a near-miss

import type { ToolGrant, ToolGrantRepo, ToolName } from "./types.ts";
import { foldsCase } from "./provider_rules.ts";
import {
  type Audience,
  narrowerAudience,
  narrowestAudience,
  type RepoVisibility,
  type ThreadRef,
} from "../ports/forge_api.ts";

/** One call, as the tool layer parsed it — only the fields a grant can have an opinion on. */
export type ToolCall =
  | {
    tool:
      | "get_issue"
      | "list_issues"
      | "get_change_request"
      | "compare_change_request"
      | "list_change_requests";
    repo: string;
  }
  | { tool: "create_issue"; repo: string; labels: string[] }
  | { tool: "add_comment"; repo: string; thread: string }
  | { tool: "add_labels"; repo: string; thread: string; labels: string[] }
  | { tool: "submit_review"; repo: string; thread: string }
  /** `comment`: whether the close carries a note — a full body posted on the thread, which is
   * a comment however it was asked for, and checked as one. */
  | { tool: "close_issue"; repo: string; thread: string; comment: boolean };

export type GrantCheck =
  | { ok: true; repo: ToolGrantRepo; labels: string[] }
  | { ok: false; reason: string };

const refuse = (reason: string): GrantCheck => ({ ok: false, reason });

/** The grant's repos, as a sentence: what the model may name instead. */
function repoList(grant: ToolGrant): string {
  return grant.repos.map((r) => r.repoRef).join(", ");
}

/** A COB id, or the unique prefix of one a human types — the shape the bridge itself resolves.
 * Seven hex characters is git's own floor and Radicle's. */
const OID_PREFIX = /^[0-9a-f]{7,40}$/;

/** The repo a call names, by the grant's spelling; null when it is not in the grant. */
export function grantRepo(grant: ToolGrant, repo: string): ToolGrantRepo | null {
  const wanted = repo.trim();
  const folded = wanted.toLowerCase();
  return grant.repos.find((r) =>
    // Folding is GitHub's and GitLab's rule (`foldsCase`): two RIDs that differ only in case are
    // two repositories, so folding one into the other would grant a run the wrong repo.
    foldsCase(r.provider) ? r.repoRef.toLowerCase() === folded : r.repoRef === wanted
  ) ?? null;
}

/**
 * Whether the agent's `thread` names the thread the grant recorded as `ref`.
 *
 * Exact everywhere but Radicle, where a thread's ref is a 40-character COB id and the bridge —
 * like git — resolves any unique prefix of at least seven hex characters to its object. An agent
 * that read `a1b2c3d` off a comment and writes back with it is naming the same thread, and a
 * grant check that refused it would refuse the run's own origin. A prefix that is NOT unique is
 * refused by the bridge when the call reaches it ("ambiguous — n objects share that prefix"), so
 * the collision is answered where the objects are, and this check stays pure and mechanical.
 */
function namesThread(repo: ToolGrantRepo, thread: string, ref: string): boolean {
  if (thread === ref) return true;
  if (repo.provider === "gitlab") return gitlabThreadRef(thread) === ref;
  if (repo.provider !== "radicle") return false;
  return OID_PREFIX.test(thread) && ref.startsWith(thread);
}

/**
 * A GitLab thread as the agent may name it, in the one spelling the grant records: `!7` is the
 * merge request `mr-7`, `#12` the issue `issue-12`, and either of those is itself. A bare `7` is
 * returned as it is — it could be issue 7 or merge request 7, two independent number spaces, so
 * it matches no recorded ref here; only the adapter can tell which exists (and refuses a number
 * naming both). Null for anything that is no GitLab thread at all.
 */
export function gitlabThreadRef(thread: string): string | null {
  const t = thread.trim();
  const mr = /^(?:!|mr-)([1-9][0-9]{0,19})$/.exec(t);
  if (mr !== null) return `mr-${mr[1]}`;
  const issue = /^(?:#|issue-)([1-9][0-9]{0,19})$/.exec(t);
  if (issue !== null) return `issue-${issue[1]}`;
  return /^[1-9][0-9]{0,19}$/.test(t) ? t : null;
}

/**
 * The thread a call names, in the spelling the control plane records and every ledger row,
 * grant ref and status comment is compared by: GitLab's `!7` / `#12` as `mr-7` / `issue-12`,
 * GitHub's `#12` as `12`, and a Radicle COB-id prefix as the full id of the one thread the grant
 * records under it. Pure: a GitLab bare number stays bare — only the adapter can say whether it
 * is an issue or a merge request — as does anything this cannot place, for the forge to refuse.
 */
export function recordedThread(grant: ToolGrant, repo: ToolGrantRepo, thread: string): string {
  const t = thread.trim();
  switch (repo.provider) {
    case "gitlab":
      return gitlabThreadRef(t) ?? t;
    case "github":
      return /^#[1-9][0-9]*$/.test(t) ? t.slice(1) : t;
    case "radicle": {
      if (!OID_PREFIX.test(t)) return t;
      const known = new Set(
        [grant.origin, ...grant.opened, ...(grant.workedChangeRequests ?? [])]
          .filter((r) => r !== null && r.connectedRepoId === repo.connectedRepoId)
          .map((r) => r!.ref)
          .filter((ref) => ref.startsWith(t)),
      );
      return known.size === 1 ? [...known][0]! : t;
    }
    default:
      return t;
  }
}

/** Whether `thread` is a bare GitLab number: an issue or a merge request, as the forge says. */
export function isBareGitlabNumber(repo: ToolGrantRepo, thread: string): boolean {
  return repo.provider === "gitlab" && /^[1-9][0-9]{0,18}$/.test(thread);
}

/** Whether `thread` of `repo` is a thread an "origin" rule lets the run write to. */
export function isOwnThread(grant: ToolGrant, repo: ToolGrantRepo, thread: string): boolean {
  if (
    grant.origin?.connectedRepoId === repo.connectedRepoId &&
    namesThread(repo, thread, grant.origin.ref)
  ) {
    return true;
  }
  return grant.opened.some((o) =>
    o.connectedRepoId === repo.connectedRepoId && namesThread(repo, thread, o.ref)
  );
}

/**
 * Whether `thread` of `repo` is the thread the run was STARTED from — narrower than
 * `isOwnThread`, which also admits threads the run opened itself. Only the origin carries the
 * status comment the platform keeps for the run, so only a write landing there is worth
 * telling the agent about (see `tool_service.ts`'s nudge). Radicle prefixes resolve here the
 * same way they do for the grant check: a run naming its own origin by `a1b2c3d` is naming it.
 */
export function isOriginThread(grant: ToolGrant, repo: ToolGrantRepo, thread: string): boolean {
  return grant.origin !== null &&
    grant.origin.connectedRepoId === repo.connectedRepoId &&
    namesThread(repo, thread, grant.origin.ref);
}

/** Comments additionally belong on change requests the run actually checked out. This does
 * not widen review/close permissions or the private-source visibility exception. */
function canCommentOn(grant: ToolGrant, repo: ToolGrantRepo, thread: string): boolean {
  return isOwnThread(grant, repo, thread) ||
    (grant.workedChangeRequests ?? []).some((r) =>
      r.connectedRepoId === repo.connectedRepoId && namesThread(repo, thread, r.ref)
    );
}

/** A description of where an "origin" rule lets the run write, for a refusal. */
function ownThreads(grant: ToolGrant, comments = false): string {
  const threads: string[] = [];
  if (grant.origin !== null) {
    const repo = grant.repos.find((r) => r.connectedRepoId === grant.origin!.connectedRepoId);
    if (repo !== undefined) threads.push(`${repo.repoRef}#${grant.origin.ref}`);
  }
  for (const o of [...grant.opened, ...(comments ? grant.workedChangeRequests ?? [] : [])]) {
    const repo = grant.repos.find((r) => r.connectedRepoId === o.connectedRepoId);
    if (repo !== undefined) threads.push(`${repo.repoRef}#${o.ref}`);
  }
  return threads.length === 0
    ? "this run has no thread of its own yet"
    : `this run may write only on ${threads.join(", ")}`;
}

/** The labels as the allowlist spells them, or the first one it does not hold. */
function allowlisted(
  grant: ToolGrant,
  labels: string[],
): { ok: true; labels: string[] } | { ok: false; label: string } {
  const byLower = new Map(grant.capabilities.labels.map((l) => [l.toLowerCase(), l]));
  const out: string[] = [];
  for (const label of labels) {
    const canonical = byLower.get(label.trim().toLowerCase());
    if (canonical === undefined) return { ok: false, label };
    if (!out.includes(canonical)) out.push(canonical);
  }
  return { ok: true, labels: out };
}

function labelRefusal(grant: ToolGrant, label: string): GrantCheck {
  return refuse(
    grant.capabilities.labels.length === 0
      ? "this run may not apply labels"
      : `the label "${label}" is not one this run may apply; it may apply: ${
        grant.capabilities.labels.join(", ")
      }`,
  );
}

/** The grant check. `ok` carries the repo by the grant's spelling and the labels to apply. */
export function checkToolCall(grant: ToolGrant, call: ToolCall): GrantCheck {
  const repo = grantRepo(grant, call.repo);
  if (repo === null) {
    return refuse(
      `${call.repo} is not a repo this run may act on; it may act on: ${repoList(grant)}`,
    );
  }
  const { capabilities } = grant;
  switch (call.tool) {
    case "get_issue":
    case "list_issues":
    case "get_change_request":
    case "compare_change_request":
    case "list_change_requests":
      if (!capabilities.read) return refuse("this run may not read issues or change requests");
      return { ok: true, repo, labels: [] };
    case "create_issue": {
      if (capabilities.createIssues === null) return refuse("this run may not open issues");
      const labels = allowlisted(grant, call.labels);
      if (!labels.ok) return labelRefusal(grant, labels.label);
      return { ok: true, repo, labels: labels.labels };
    }
    case "add_comment":
      if (capabilities.comment === null) return refuse("this run may not comment");
      if (capabilities.comment.where === "origin" && !canCommentOn(grant, repo, call.thread)) {
        return refuse(
          `${repo.repoRef}#${call.thread} is not this run's thread: ${ownThreads(grant, true)}`,
        );
      }
      return { ok: true, repo, labels: [] };
    case "add_labels": {
      if (capabilities.labels.length === 0) return refuse("this run may not apply labels");
      const labels = allowlisted(grant, call.labels);
      if (!labels.ok) return labelRefusal(grant, labels.label);
      return { ok: true, repo, labels: labels.labels };
    }
    case "submit_review":
      if (capabilities.review === null) {
        return refuse("this run may not review change requests");
      }
      if (
        capabilities.review.where === "origin" &&
        !(grant.origin?.kind === "change_request" &&
          grant.origin.connectedRepoId === repo.connectedRepoId &&
          namesThread(repo, call.thread, grant.origin.ref))
      ) {
        return refuse(
          grant.origin?.kind === "change_request"
            ? `${repo.repoRef}#${call.thread} is not this run's change request; it may review ` +
              `only ${
                grant.repos.find((r) => r.connectedRepoId === grant.origin!.connectedRepoId)
                  ?.repoRef ?? "its own"
              }#${grant.origin.ref}`
            : "this run came from no change request, so it has none to review",
        );
      }
      return { ok: true, repo, labels: [] };
    case "close_issue": {
      if (capabilities.closeIssues === null) return refuse("this run may not close issues");
      if (capabilities.closeIssues.where === "origin" && !isOwnThread(grant, repo, call.thread)) {
        return refuse(
          `${repo.repoRef}#${call.thread} is not this run's thread: ${ownThreads(grant)}`,
        );
      }
      // The note is a comment. Closing is not a licence to post one: without this, a run granted
      // closeIssues {where: "any"} and no comment capability at all could post a body of its own
      // choosing on every issue in the grant, which is the capability the operator withheld.
      if (call.comment) {
        if (capabilities.comment === null) {
          return refuse(
            "this run may not comment, so it may not close an issue with a note — close it " +
              "without one",
          );
        }
        if (capabilities.comment.where === "origin" && !canCommentOn(grant, repo, call.thread)) {
          return refuse(
            `${repo.repoRef}#${call.thread} is not a thread this run may comment on, so it may ` +
              `not leave a note there: ${ownThreads(grant, true)} — close it without a note`,
          );
        }
      }
      return { ok: true, repo, labels: [] };
    }
  }
}

/**
 * The visibility rule: a write never widens the audience of what the run read — except on its
 * origin thread, which already receives the run's report. A run that HOLDS a repo whose
 * audience is narrower than the thread written to may not write there: private code must not
 * reach a public thread, nor a members-only project's code an instance-wide (GitLab `internal`)
 * one. "Holds" is the union of what the run may write to (`repos`) and what it checked out
 * (`sourceRepos`): the danger is source reaching a wider thread, and a `repos:
 * {connectedRepoIds}` policy names writable repos that need have nothing to do with the
 * checkout the agent has been reading.
 *
 * Each repo is read in the role it plays (`RepoVisibility`): every repo the run holds as a
 * SOURCE, and the target as a TARGET, for the kind of thread written on — `kind` — since a
 * forge may keep a repo's code from the public and still publish its issues.
 *
 * `visibilities` is every connected repo id of either list, read live by the caller; one it
 * does not hold is public on both counts. `thread` is the thread written to, null for a new
 * issue. Null: the write may proceed.
 */
export function visibilityRefusal(
  grant: ToolGrant,
  visibilities: ReadonlyMap<string, RepoVisibility>,
  target: ToolGrantRepo,
  kind: ThreadRef["kind"],
  thread: string | null,
): string | null {
  const audience = visibilities.get(target.connectedRepoId)?.target[kind] ?? "public";
  const narrowest = [...visibilities.values()]
    .map((v) => v.source)
    .reduce<Audience>(narrowestAudience, "public");
  if (!narrowerAudience(narrowest, audience)) return null;
  const origin = grant.origin;
  if (
    thread !== null && origin !== null && origin.connectedRepoId === target.connectedRepoId &&
    namesThread(target, thread, origin.ref)
  ) {
    return null;
  }
  const where = kind === "issue" ? "issues" : "change requests";
  const readers = audience === "public" ? "the public" : "every account on its instance";
  const held = narrowest === "members"
    ? "a private repo"
    : "a repo only accounts on its instance may read";
  return `${target.repoRef}'s ${where} are read by ${readers} and this run holds ${held}, so ` +
    "it may not write there (only on the thread it was started from) — a run's writes must " +
    "never reach readers wider than what it read";
}

/** Whether a tool writes — the ones reserved against a cap and signed with a footer. */
export function isWriteTool(tool: ToolName): boolean {
  return tool === "create_issue" || tool === "add_comment" || tool === "add_labels" ||
    tool === "submit_review" || tool === "close_issue";
}

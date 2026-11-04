// The forge's API, as this package's own service layer sees it. This port hides WHICH API
// CLIENT (a hand-rolled fetch adapter today, an Octokit tomorrow, a Radicle bridge next);
// the orchestrator's ports/forge.ts hides WHICH FORGE. Two ports, two jobs.
//
// One implementation PER PROVIDER, reached through `ForgeRegistry`: a connected repo names its
// provider, every path resolves the API from it, and a provider this deployment does not run
// answers with a terminal `ForgeApiError` rather than a crash. Nothing below names a forge —
// `repoRef` and `thread.ref` are opaque strings, spelled by whichever adapter owns them.

import type { ForgeProvider, Permission } from "../core/types.ts";
import type { FetchAuth } from "./repo_cache.ts";

/** Which repo a call acts on, and as whom — the two things every method needs, and the only
 * two. `repoRef` is opaque: "owner/name" on GitHub, a `rad:z…` RID on Radicle, parsed nowhere
 * outside the adapter that spells it. `tenantId` names the credential the call acts with (a
 * GitHub App installation); null is a first-class answer, not a degraded one — a provider
 * whose writes are signed by the deployment's own key has no tenants at all. */
export interface ForgeRepo {
  repoRef: string;
  tenantId: string | null;
  /**
   * The repo's identity on its forge where a path is only where it lives today — a GitLab
   * project's id on the configured instance, `<id>@<RYPH_GITLAB_URL>` (`gitlabProjectRef`), which
   * no rename or transfer changes, while the old path can be taken by a new project. REQUIRED on
   * GitLab: the adapter addresses the project by it alone, and refuses — terminally — a call
   * without it or naming another instance; `repoRef` is then only a label. Absent on every other
   * forge.
   */
  forgeId?: string;
}

/** A GitLab repo as the adapter's own entry points take it: the id is not optional there. */
export type GitlabRepo = ForgeRepo & { forgeId: string };

/**
 * The `ForgeRepo` out of anything wider that names one — a grant member, a request's repo —
 * with its `forgeId` kept. Every path that narrows a repo for a forge call goes through here
 * rather than rebuilding `{repoRef, tenantId}` by hand: a rebuilt pair drops the id, and a
 * GitLab call without it would have nothing to address the project by but a path somebody else
 * may hold now.
 */
export function forgeRepoOf(repo: ForgeRepo): ForgeRepo {
  return {
    repoRef: repo.repoRef,
    tenantId: repo.tenantId,
    ...(repo.forgeId === undefined ? {} : { forgeId: repo.forgeId }),
  };
}

/** A repo's git upstream as its forge places it now (`ForgeApi.locateUpstream`). */
export interface LocatedUpstream {
  /** The URL git fetches and pushes. */
  url: string;
  /** The repo's address at that URL — what a credential scoped to one repo is checked against. */
  repoRef: string;
}

/** An API refusal that knows whether retrying could ever help — the submit sweep's clock
 * depends on the distinction, so it is typed rather than parsed out of messages. */
export class ForgeApiError extends Error {
  readonly terminal: boolean;
  /**
   * How long until the limit that refused this call lifts, when the forge SAID so — a rate limit
   * naming its reset. Null for every other failure, and null when the forge named nothing: a
   * caller must not be handed a guess, because the only use for this number is deciding not to
   * ask again, and an invented one either wastes the wait or spends the limit it was meant to
   * protect.
   */
  readonly retryAfterMs: number | null;
  constructor(message: string, terminal: boolean, retryAfterMs: number | null = null) {
    super(message);
    this.name = "ForgeApiError";
    this.terminal = terminal;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A repo naming a provider this deployment does not run. Terminal by construction: no retry
 * registers an adapter, and the caller's clock must not treat it as an outage. */
export class UnknownProviderError extends ForgeApiError {
  readonly provider: ForgeProvider;
  constructor(provider: ForgeProvider, what: string) {
    super(`this deployment has no ${what} for the ${provider} forge`, true);
    this.name = "UnknownProviderError";
    this.provider = provider;
  }
}

/** One implementation per provider, looked up by the provider a connected repo names. */
export interface ProviderRegistry<T> {
  /** The provider's implementation, or `UnknownProviderError` — never null, so no caller has
   * to invent what an unregistered provider means. */
  for(provider: ForgeProvider): T;
  has(provider: ForgeProvider): boolean;
  /** Every provider registered, for a boot log. */
  providers(): ForgeProvider[];
}

/** Builds a registry over whatever is wired. `what` names the thing in the refusal. */
export function providerRegistry<T>(
  entries: Partial<Record<ForgeProvider, T | null>>,
  what: string,
): ProviderRegistry<T> {
  const held = new Map<ForgeProvider, T>(
    Object.entries(entries).filter(([, v]) => v != null) as Array<[ForgeProvider, T]>,
  );
  return {
    for(provider) {
      const found = held.get(provider);
      if (found === undefined) throw new UnknownProviderError(provider, what);
      return found;
    },
    has: (provider) => held.has(provider),
    providers: () => [...held.keys()],
  };
}

export type ForgeRegistry = ProviderRegistry<ForgeApi>;

/** One thing somebody said in a thread, forge-agnostic. A change request is an issue with code
 * attached, so its conversation, its review verdicts and its inline remarks all reduce to this. */
export interface ThreadEntry {
  /** "comment" — the conversation; "review" — a change request review's summary and verdict;
   * "review_comment" — an inline remark anchored to a diff line. */
  kind: "comment" | "review" | "review_comment";
  authorLogin: string;
  body: string;
  createdAt: string;
  /** A review's verdict ("approved", "changes_requested", "commented"); null for the rest. */
  state: string | null;
  /** Where an inline remark sits, as "path:line"; null for the rest. */
  location: string | null;
  /** An inline remark's place in its review thread, where the forge can be answered in one —
   * what a reply names (`replyTo`) and whether the thread is still open. Absent for every other
   * entry, and for a forge that does not thread its remarks here yet. */
  remark?: ReviewRemark;
  /** The handle a command event names this entry by (`sourceCommentId`): a GitHub comment's
   * id, `review:<id>` for an inline remark, `<kind>:<thread>:<comment>` on Radicle. Absent where
   * no command can come from (a review's summary). What a read with images asks for by `focus`,
   * and what the control plane finds a follow-up command's own images by. */
  id?: string;
  /** The images this entry shows, in order of appearance — present only on a read that asked
   * for them (`ThreadReadOptions.images`). */
  images?: ThreadImage[];
}

/**
 * An image in a thread, as a read with images carries it: where it sat in the entry's text, and
 * either its bytes or why they are not here.
 *
 * SECURITY: as untrusted as the text around it. The bytes were checked here (an allowlisted
 * origin, a capped read, an allowed format by its magic numbers) and are checked again by the
 * control plane's own attachment door; `markup` and `name` were typed by whoever wrote the entry.
 */
export type ThreadImage =
  | {
    kind: "image";
    /** The exact text in the entry's body that showed this image — an `<img>` tag, a markdown
     * image, a Radicle embed link — so the reader can put a marker in its place. "" when the
     * text never named it (a Radicle embed the body does not link). */
    markup: string;
    /** Which exact match of `markup` in the body it is — how many (overlapping ones too) start
     * before it — when that is not the first: the same text can stand in a code block, inside
     * another tag's alt, or twice, and only one is where the image sat. Absent means 0. */
    occurrence?: number;
    /** The file's name where the forge keeps one (a Radicle embed); absent otherwise. */
    name?: string;
    /** The image's bytes, base64. At most `MAX_THREAD_IMAGE_BYTES` decoded. */
    data: string;
  }
  | {
    kind: "omitted";
    markup: string;
    occurrence?: number;
    name?: string;
    /** Why there are no bytes: past the per-read count (`limit`), past the size cap
     * (`too_large`), not one of the four formats (`unsupported`), or not readable at all
     * (`unavailable` — a download that failed, timed out, or pointed somewhere not allowed). */
    reason: ThreadImageOmission;
  };

export type ThreadImageOmission = "limit" | "too_large" | "unsupported" | "unavailable";

/** What a thread read may be asked for beyond the text. */
export interface ThreadReadOptions {
  /** Download the thread's images. `focus` names the entry (by `ThreadEntry.id`) the read is
   * for — the command's own comment — whose images are taken first when there are more than a
   * read carries. With `focusOnly`, ONLY that entry's: nothing else is downloaded, and no other
   * entry (nor the opening post) carries `images` at all. */
  images?: { focus: string | null; focusOnly?: boolean };
}

/** One inline remark, as a review thread holds it. */
export interface ReviewRemark {
  /** The forge's id for the remark — what `replyToReviewComment` takes. */
  id: string;
  /** The remark this one answers; null when it opens its thread. */
  replyTo: string | null;
  /** Whether its thread is resolved; null when the forge could not say. */
  resolved: boolean | null;
}

/** Which conversation a call is about. `ref` is the thread's address as its forge spells it:
 * "12" on GitHub, a collaborative-object id on Radicle. Text, never a number — the integer
 * lives inside the GitHub adapter and nowhere else. */
export interface ThreadRef {
  kind: "issue" | "change_request";
  ref: string;
}

/** A thread as the control plane needs to read it: the opening post plus everything said
 * since. What a human sees when they open the issue, minus the chrome. */
export interface ThreadContext {
  kind: "issue" | "change_request";
  ref: string;
  title: string;
  /** The opening post. "" is a real answer — plenty of issues are a title and nothing else. */
  body: string;
  authorLogin: string;
  createdAt: string;
  /** "open" or "closed", as the forge says it. */
  state: string;
  /** The opening post's images, in order of appearance — present only on a read that asked
   * for them. */
  bodyImages?: ThreadImage[];
  /** Chronological, oldest first — the order a human reads them in. */
  entries: ThreadEntry[];
  /** The thread had more to say than the fetch ceiling allowed: `entries` is a prefix, not
   * the whole conversation, and anything rendering it must say so. */
  truncated: boolean;
  /** Where a change request's code lives — present exactly when `kind` is "change_request". */
  changeRequest: ChangeRequestHead | null;
}

/** A change request's branch, as a run working ON the change request needs it: what to check
 * out, and whether it is somewhere a push from this deployment can reach at all. */
export interface ChangeRequestHead {
  ref: string;
  url: string;
  /** A merged change request is closed AND `merged`. */
  state: "open" | "closed";
  merged: boolean;
  /** The head branch's name, bare ("feat/scheduler"). */
  headRef: string;
  /** The newest head, whoever pushed it — what a run checks out and builds on. */
  headSha: string;
  /**
   * The head that is the change request's OWN: on Radicle, the latest revision by its author
   * (heartwood's `Patch::latest`), where anybody may add a revision on top and `headSha` is
   * whoever did last; on GitHub, `headSha` itself, since only the head branch moves a pull
   * request. What a push event's head is compared against to tell a live push from a stale one.
   */
  authorHeadSha: string;
  /** The branch the change request asks to merge into, bare ("main", "release/2.x") — what a
   * run working on it merges to bring it up to date. */
  baseRef: string;
  /** The repo the head branch lives in, by its provider's own address. Differs from the base
   * repo for a fork; null when the fork has since been deleted. For a fork ryph may not see
   * (`headRepoHidden`), the only name the forge gave it. */
  headRepoRef: string | null;
  /** The head lives in a fork that exists but that the forge will not show ryph — GitLab answers
   * a private fork the account is no member of as it does a missing project. Its head still
   * reaches a run through the base repo's change request ref; nothing is pushed to it. Absent
   * otherwise. */
  headRepoHidden?: boolean;
  /** Whether the head lives in the base repo itself, as the forge decided it by identity —
   * GitLab's `source_project_id === target_project_id`. A connected repo's address is the one it
   * was connected under, and a rename or a transfer leaves it behind, so where this is present it
   * is the answer and no address is compared (`headInRepo`). Absent where the address is the
   * identity (GitHub's full name as of the read, a RID, a local path). */
  sameRepo?: boolean;
  /** Where the head repo is cloned from, as the forge reports it — a fork's own URL, which a
   * push onto a fork's branch goes to. Absent where the forge has no forks (Radicle, `local`),
   * or the head repo is gone. */
  headRepoUrl?: string | null;
  /** The head repo's own default branch — for a fork, the branch no run's commits are pushed
   * onto, whatever the pull request says. Absent where the forge has no forks. */
  headRepoDefaultBranch?: string | null;
  /** Whether the pull request's author lets the base repo's maintainers push to its branch
   * (GitHub's "Allow edits from maintainers"). GitHub never sets it on a same-repo pull request
   * or an organization-owned fork. Absent where the forge has no such switch. */
  maintainerCanModify?: boolean;
  /** How many commits the change request carries, where the forge said — what places the
   * history window (`CommitHistory.total`) without a second read of the same object. Null
   * where the forge does not count them. */
  commitCount: number | null;
  /** The base repo's default branch as the forge reports it NOW — the one branch a run's
   * commits are never pushed onto. Read live rather than from the connected repo's record,
   * which was captured when the repo was connected and can have changed since. */
  defaultBranch: string;
}

/** A change request's head and fate, as `readChangeRequestState` reads them. */
export interface ChangeRequestState {
  ref: string;
  /** A merged change request is closed AND `merged`; an archived Radicle patch is closed. */
  state: "open" | "closed";
  merged: boolean;
  /** The newest head, whoever pushed it. */
  headSha: string;
  /** The change request's own head — see `ChangeRequestHead.authorHeadSha`. */
  authorHeadSha: string;
  /** The branch it asks to merge into, bare. */
  baseRef: string;
  /** Whether this deployment opened it: the App's bot on GitHub, our node on Radicle. */
  openedByUs: boolean;
  /** What merged, by commit — `ForgeEvent.merged.heads`, as the read finds it: the pull
   * request's head, which GitHub stops moving at the merge, or the commit of the Radicle
   * revision the delegates merged, which need not be the latest (`headSha`). Empty unless
   * merged, and on a merge whose head the forge does not name. */
  mergedHeads: string[];
}

/** One issue in a listing — enough to pick which to read whole. */
export interface IssueListing {
  ref: string;
  title: string;
  state: string;
  authorLogin: string;
  labels: string[];
  comments: number;
  updatedAt: string;
}

/** One change request in a listing. */
export interface ChangeListing {
  ref: string;
  title: string;
  state: string;
  authorLogin: string;
  draft: boolean;
  headRef: string;
  baseRef: string;
  updatedAt: string;
}

/** One file a change request changes: its path, how, by how many lines, and its unified-diff
 * hunks — what a review remark may anchor to, so an agent reading a change request learns the
 * anchorable lines instead of guessing them. `patch` is null where the forge shows no diff (a
 * binary file, one too large). */
export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

/** A bounded page of a listing, and whether there is another. */
export interface Page<T> {
  items: T[];
  hasMore: boolean;
}

/** One commit of a change request, as a reviewer scanning its history reads it: no diff, no
 * parents, no body — the diff is its own read, and this is the shape of the work. */
export interface ChangeCommit {
  /** The commit id, whole; the rendering shortens it. On a forge that answers with REVISIONS
   * rather than commits, the revision's head. */
  sha: string;
  /** Radicle's revision identity, distinct from its head commit. */
  revision?: { id: string; base: string };
  /** Who made it, as the provider names people: a login on GitHub (or the git author's name
   * where the commit is linked to no account), a DID on Radicle. */
  authorLogin: string;
  /** ISO 8601, as the forge dated it. "" when it dated nothing. */
  date: string;
  /** The FIRST LINE of the message, cut by the adapter. The rest of a commit message is prose
   * about a diff the agent can read, and a hundred commits of it is a context budget. */
  summary: string;
}

/** A change request's history, bounded: the NEWEST entries, and how many older ones exist. */
export interface CommitHistory {
  /** Oldest first, within the window — the order the work was done in. */
  items: ChangeCommit[];
  /**
   * How many entries precede `items`; 0 when the history is whole. Never a guess: a forge that
   * would not say how many there are in total reports 0 and the window is all there is.
   */
  older: number;
  /**
   * Whether `items` ends at the change request's HEAD — whether these really are its newest.
   *
   * False is a real and nasty answer. GitHub's pull-request commit listing stops at its first
   * 250 commits however it is paged, so on a 600-commit change request the end of the listing
   * is commit 250 and the tip is simply not in it. Calling that window "the newest 50" would
   * hand an agent fifty commits from the middle of the branch under a label that says
   * otherwise, which is worse than showing none — so the rendering says where the window sits
   * and that the head is beyond it.
   */
  atHead: boolean;
  /** The change request's whole commit count where the forge declared one, null where it did
   * not. With `older` it places the window: `older + 1` … `older + items.length` of `total`. */
  total: number | null;
  /**
   * What ONE entry is. Radicle keeps no per-patch commit list the bridge can answer without
   * walking git itself, but a patch's revisions ARE its history there — so an entry is a
   * revision (its head), and the rendering says "revisions" rather than calling one a commit.
   */
  unit: "commit" | "revision";
}

/** One CI check on a change request's head. */
export interface CheckRun {
  name: string;
  /** "queued", "in_progress" or "completed", as GitHub's check runs spell it. A legacy commit
   * status has no status of its own: it is "completed" once it has anything but `pending`. */
  status: string;
  /** "success", "failure", "neutral", "cancelled", "timed_out", "action_required", "skipped";
   * null while the check has not concluded. */
  conclusion: string | null;
  /** Where a human reads the run's output; null where the forge named none. A URL only — no
   * read tool fetches a job log, and this one does not either. */
  detailsUrl: string | null;
}

/**
 * What the forge says about CI on a change request's head.
 *
 * Two answers, because an agent about to claim "the build is fine" has to tell them apart:
 * checks were read (even if there are none), and "we were not allowed to look".
 */
export type ChecksReport =
  | {
    kind: "reported";
    headSha: string;
    /**
     * Ordered by `checkSeverity`, WORST FIRST — by the adapter, before it cuts anything. That
     * order is what makes a summary over a shortened list honest: whatever `more` hides is
     * never worse than the last entry here, so a red build cannot end up in the part nobody
     * renders.
     */
    items: CheckRun[];
    /**
     * How many checks this read DROPPED after ordering them — each no worse than the last of
     * `items`, because the cut was taken from the mild end of a sorted list. A summary may
     * count these as passes when the last entry shown is one.
     */
    cut: number;
    /**
     * How many checks the forge said it holds and did not list — pagination, nothing else.
     * These arrived in NO order, so nothing whatever is known about them: one of them may be
     * the failing build. A summary that counts them as passes is how "all 60 checks passed"
     * gets said about a red change request, so `unlisted > 0` forbids an exact verdict.
     */
    unlisted: number;
    /**
     * What this read did NOT get, in a sentence, or null when it got everything it asked for.
     *
     * A forge reports CI through more than one channel, and one channel failing must never
     * render as the other channel's answer: a half-read that says "nothing has reported a
     * check" is how an agent concludes a red change request is green.
     */
    partial: string | null;
  }
  /**
   * The credential may not read checks — a GitHub App without `checks: read` — or the forge
   * would not answer. NEVER the failure of the read that asked for it: a change request is
   * still worth reading without its CI, so this is an answer and not a throw.
   *
   * `retryAfterMs` carries a rate limit the forge DATED, exactly as `ForgeApiError` does: an
   * answer rather than a throw must not be how an exhausted installation keeps being asked,
   * because this call costs a token mint and two requests of the same allowance every time.
   */
  | { kind: "unavailable"; reason: string; retryAfterMs?: number | null };

/** Conclusions that mean the change request is NOT ready. `stale` and `startup_failure` are
 * GitHub's, and are failures like the rest. */
const FAILING_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
]);

/** Conclusions that mean nothing is wrong: a check deciding it had nothing to say is not a
 * problem to fix. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * How bad a check is: 0 failing, 1 still running, 2 neither passed nor failed, 3 passed.
 *
 * ONE definition, shared by the adapter that orders and cuts a listing and the rendering that
 * summarises what survived — because the whole honesty of "N failing" over a cut list rests on
 * the two agreeing about which end is which. It lives on the port for that reason, beside the
 * contract it makes `items` keep.
 */
export function checkSeverity(check: CheckRun): 0 | 1 | 2 | 3 {
  if (check.status !== "completed") return 1;
  if (FAILING_CONCLUSIONS.has(check.conclusion ?? "")) return 0;
  return PASSING_CONCLUSIONS.has(check.conclusion ?? "") ? 3 : 2;
}

/** A ryph check suite's state, as the orchestrator names it (its core/check_types.ts). Mirrored
 * rather than imported: this package cannot import the orchestrator. */
export type CheckSuiteState =
  | "waiting"
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "error"
  | "cancelled";

/** One ryph check, as the orchestrator asks a forge to show it. */
export interface CheckRunReport {
  /** Bare; the GitHub adapter names it `ryph / <name>`. */
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion:
    | "success"
    | "failure"
    | "timed_out"
    | "cancelled"
    | "action_required"
    | "neutral"
    | null;
  /** One line, ≤ 200 chars. */
  title: string;
  /** Markdown, ≤ 60 000 chars. Carries head-authored log text, already fenced by the caller. */
  summary: string;
  startedAt: string | null;
  completedAt: string | null;
  /** `${suiteId}:${generation}:${name}` — the idempotency key on GitHub. */
  externalId: string;
  /** A known check-run id → update it; null → find by `externalId`, else create. */
  forgeRef: string | null;
}

/**
 * A ryph check suite on one commit, as the orchestrator asks a forge to show it: per check where
 * the forge has checks (GitHub's check runs), one run for the whole suite where it does not
 * (Radicle's job COB). Mirrors the orchestrator's ports/forge.ts `CheckReport`.
 */
export interface CheckReport {
  headSha: string;
  suiteId: string;
  generation: number;
  detailsUrl: string | null;
  suite: {
    state: CheckSuiteState;
    /** Null while not settled. */
    conclusion: "success" | "failure" | null;
    /** One paragraph, for a one-run-per-suite forge. */
    summary: string;
    /** Older generations of this suite that were reported while going and never reported
     * settled. A forge with one run per generation (Radicle) finishes their runs as failed;
     * GitHub ignores it, since the newer runs of the same names shadow them. */
    previousGenerations?: number[];
  };
  checks: CheckRunReport[];
}

/** How a check report ended. A refusal the forge named is a thrown `ForgeApiError`, as for every
 * other write; these are the answers. */
export type ReportChecksOutcome =
  | { kind: "reported"; refs: Record<string, string> }
  /** The credential cannot post checks here — a GitHub App without `Checks: write`. */
  | { kind: "unsupported"; reason: string }
  | { kind: "failed"; message: string; terminal: boolean };

/** What a write that may have landed is looked for by: a new issue in the repo, or a comment or
 * a review on a thread. */
export type WrittenTarget =
  | { kind: "issue" }
  | { kind: "comment"; threadRef: string }
  | { kind: "review"; threadRef: string }
  /** A reply inside one of a change request's review threads. */
  | { kind: "review_reply"; threadRef: string };

/**
 * An image a body carries as a file of the thread itself — a Radicle embed. The body already
 * links it by `oid`, its git blob id (`core/images.ts`); the adapter stores the bytes and names
 * the file on the write. Only a forge whose images are embeds (`imageStyleOf`) is ever handed
 * one, and every other adapter ignores the parameter.
 */
export interface BodyEmbed {
  /** The file's name: `<ref>.<ext>`, unique within one body. */
  name: string;
  /** The git blob id of `bytes`. */
  oid: string;
  bytes: Uint8Array;
}

/**
 * Who reads something, narrowest first: a repo's own members, every account on its forge's
 * instance (GitLab's `internal`), or the public. The visibility rule's one invariant is that a
 * write never widens the audience of what the run read, so it compares these by `audienceRank`.
 *
 * `instance` is one audience only because a deployment speaks to one GitLab instance (a repo of
 * another is refused before any call); GitHub and Radicle never answer it.
 */
export type Audience = "members" | "instance" | "public";

const AUDIENCE_RANK: Record<Audience, number> = { members: 0, instance: 1, public: 2 };

/** Whether `a` reaches fewer people than `b` — writing what `a` may read where `b` reads would
 * widen its audience. */
export function narrowerAudience(a: Audience, b: Audience): boolean {
  return AUDIENCE_RANK[a] < AUDIENCE_RANK[b];
}

/** The narrower of two audiences. */
export function narrowestAudience(a: Audience, b: Audience): Audience {
  return narrowerAudience(b, a) ? b : a;
}

/**
 * Who can see a repo, as the visibility rule reads it — once per role, because the two differ
 * on a forge whose features keep their own visibility. A repo is a SOURCE for what an agent
 * reads out of it and a TARGET for what a tool writes into it: a public GitLab project whose
 * code is members-only is members-only to read, yet an issue written there is public.
 */
export interface RepoVisibility {
  /** As a source: the narrowest audience of anything an agent may read from the repo — its
   * code, issues, change requests, CI. When in doubt, `members`. */
  source: Audience;
  /** As a target, per kind of thread a tool writes on: who reads what is written there. When
   * in doubt, `public` — a write's audience is the public unless the forge said otherwise. */
  target: Record<ThreadRef["kind"], Audience>;
}

/** A repo whose visibility is one switch for everything in it — GitHub's, Radicle's: private
 * is its members, public the public. */
export function wholeRepoVisibility(isPrivate: boolean): RepoVisibility {
  const audience: Audience = isPrivate ? "members" : "public";
  return { source: audience, target: { issue: audience, change_request: audience } };
}

export interface ChangeComparison {
  from: { id: string; base: string; head: string };
  to: { id: string; base: string; head: string };
  mode: "diff" | "range-diff";
  text: string;
  truncated: boolean;
}

export interface ForgeApi {
  /** Optional capability: currently Radicle, whose COB records revision boundaries. */
  compareChangeRequest?(
    repo: ForgeRepo,
    ref: string,
    input: { from: string; to?: string; mode: "diff" | "range-diff" },
  ): Promise<ChangeComparison>;
  /** Posts a comment onto an issue or change request thread — the run's channel back to the
   * human. Returns the forge's id for the new comment, the handle `updateComment` edits by. */
  postComment(
    repo: ForgeRepo,
    thread: ThreadRef,
    body: string,
    embeds?: BodyEmbed[],
  ): Promise<{ commentId: string }>;
  /** Rewrites an existing comment's body — how a progress comment stays one comment. Its embeds
   * become `embeds`, as its text becomes `body`. */
  updateComment(
    repo: ForgeRepo,
    commentId: string,
    body: string,
    embeds?: BodyEmbed[],
  ): Promise<void>;
  /** Reacts to a comment — the cheap "I saw it" before any run exists. Idempotent: reacting
   * twice with the same emoji is a success, which is what makes blind retries safe. */
  addReaction(repo: ForgeRepo, commentId: string, reaction: "eyes"): Promise<void>;
  /**
   * Does `subject` hold at least `atLeast` on the repo? `subject` is the identity as this
   * provider names it — a login on GitHub, a DID on Radicle, and on GitLab the account's id on the
   * configured instance (`gitlabAccountId`), never a username: a username can be renamed away and
   * registered by somebody else, who would inherit whatever was asked about it. Never throws: a definitive no is
   * "denied"; anything unanswerable — suspended installation, 403, 5xx, network — is
   * "unknown", because a transient forge outage must never read as a revocation.
   *
   * A NULL subject means "there is no identity": the caller has nobody to name and is asking
   * whether anybody at all may do this. It is a real question on exactly one tier — Radicle's
   * `write`, where contribution to a public repo is permissionless and the subject is not
   * consulted at all — and the answer there is the repo's visibility. Every other provider and
   * tier treats null as an identity that is in no set and answers "denied": GitHub has real
   * permission tiers with no permissionless rung, and Radicle's `admin` is delegacy, which
   * nobody holds anonymously. No adapter may throw on null, and none may interpolate it into a
   * request — the point of spelling it null rather than `""` is that it cannot be mistaken for
   * a name somewhere downstream.
   */
  checkPermission(
    repo: ForgeRepo,
    subject: string | null,
    atLeast: "write" | "admin",
  ): Promise<Permission>;
  /**
   * The credential a git fetch of this repo's base is made with, or null when the provider
   * needs none (and the deployment's own fallback, if any, then applies). The git gateway's
   * one question of the API — and the reason no token-minting concept sits on this port.
   */
  fetchAuth(repo: ForgeRepo, url: string): Promise<FetchAuth | null>;
  /**
   * Where a git fetch of this repo's base actually goes. `url` is the connected repo's own
   * address as the control plane holds it, and for a forge that IS a git host that is already
   * the answer — GitHub's adapter hands it straight back.
   *
   * It exists for the forge that is not one. A Radicle repo's address is a RID, which no git
   * client can fetch; the fetchable upstream is a door on this deployment's own bridge, derived
   * from the RID. Deriving it HERE keeps that derivation inside the one adapter that knows the
   * bridge exists, and keeps the orchestrator from having to hold an address that is the
   * forge's deployment detail. Pure: no I/O, so every path that fetches can call it.
   */
  upstreamUrl(repo: ForgeRepo, url: string): string;
  /**
   * Where a repo named by its `forgeId` lives NOW: its git URL and its address, read from the
   * forge by that id. Only on a forge whose addresses move (GitLab): a project renamed or
   * transferred keeps its id, and the path the control plane holds can since have been taken by
   * another project, which a fetch or push by path would then reach. Every git path that holds
   * a `forgeId` asks this instead of trusting `url`. Rejects with a terminal `ForgeApiError`
   * when the forge says the project is gone.
   */
  locateUpstream?(repo: ForgeRepo & { forgeId: string }): Promise<LocatedUpstream>;
  /**
   * Reads a whole thread — the opening post and every comment, review and inline remark on
   * it. This is how a `/ryph ada fix this` becomes answerable: "this" lives in the thread,
   * not in the comment that names the agent.
   *
   * Throws (never a null answer) so the caller can tell "the thread says nothing" — a real
   * issue with an empty body — from "we could not read the thread". The two must not collapse:
   * running on a thread we failed to read is running blind.
   *
   * With `opts.images`, the thread's images come along (`ThreadImage`): downloaded here, where
   * the egress and the credentials are, never by a run. An image that cannot be had is an
   * `omitted` value and never fails the read.
   */
  fetchThread(repo: ForgeRepo, thread: ThreadRef, opts?: ThreadReadOptions): Promise<ThreadContext>;
  /**
   * Reads a change request's head as it stands NOW — the submit path's last look before it
   * pushes onto someone's branch. Throws `ForgeApiError`; a 404 is terminal.
   */
  describeChangeRequest(repo: ForgeRepo, ref: string): Promise<ChangeRequestHead>;
  /**
   * A change request's head and fate, in the fewest reads the forge allows — what the control
   * plane checks a push event against before it asks for checks (is this still the head, is the
   * change request still open, who opened it). One `GET` of the pull request on GitHub; the
   * patch and the repo's identity on Radicle. Null: the change request does not exist. Throws
   * `ForgeApiError` for anything else.
   */
  readChangeRequestState(repo: ForgeRepo, ref: string): Promise<ChangeRequestState | null>;
  /**
   * Whether a branch that is NOT the default one is the repo's own ("branch") or somebody
   * else's ("foreign") — the question an environment's cache rules turn on: only a ref the
   * repo's own writers control may build an image other runs of that ref will use. `branch` is
   * the cache's local name for it (`@ryph/shared/refs`), e.g. "feat/x", "pull/42/head",
   * "patches/<id>"; the caller has already ruled out the default branch.
   *
   * GitHub: a pull request's head counts as the repo's own when its head repo IS the connected
   * repo, and every other branch name is one of the repo's own. Radicle: a change request
   * counts when its author and every revision's author is a delegate or this deployment's own
   * node; a canonical branch always does. GitLab: only a merge request's `/head` whose source
   * project is the connected one; every other `merge-requests/…` ref (`/merge`, a merge train)
   * is foreign. Throws `ForgeApiError`, terminal for a change request
   * that does not exist.
   */
  classifyBranch(repo: ForgeRepo, branch: string): Promise<"branch" | "foreign">;

  // Door ⑤, the tool surface. Every method below acts with a credential narrowed to the ONE
  // repo it names and the one permission it spends — the adapter knows which — so a grant bug
  // upstream cannot become a write the call never needed. Every refusal is a `ForgeApiError`:
  // terminal for a definitive 4xx, not for a 5xx, a rate limit or a network death, which is
  // what tells the tool surface a write may have landed anyway.

  /** Who can see each repo right now, as a source and as a target (`RepoVisibility`), keyed by
   * the ref asked for. One tenant's repos in one request where the forge will answer them
   * together, and always one credential: the visibility rule reads every repo of a grant before
   * any write, and a credential per repo made the first write of a wide grant a mint per repo. */
  repoVisibility(
    tenantId: string | null,
    repoRefs: string[],
  ): Promise<Map<string, RepoVisibility>>;
  /** Every label the repo has, as it spells them. `complete` is false when the repo has more
   * than the listing walks: a label missing from a cut-short listing says nothing about the
   * repo, so the caller must not read it as "no such label". */
  repoLabels(repo: ForgeRepo): Promise<{ labels: string[]; complete: boolean }>;
  /** Whether a thread ref names an issue or a change request. A 404 is terminal: there is no
   * such thread. */
  threadKind(repo: ForgeRepo, ref: string): Promise<"issue" | "change_request">;
  /** A page of issues — change requests excluded, though a forge may list them together. */
  listIssues(
    repo: ForgeRepo,
    query: { state: "open" | "closed" | "all"; labels: string[]; page: number },
  ): Promise<Page<IssueListing>>;
  listChangeRequests(
    repo: ForgeRepo,
    query: { state: "open" | "closed" | "all"; page: number },
  ): Promise<Page<ChangeListing>>;
  /** The files a change request changes — names, line counts and diff hunks, never whole
   * contents. One page; `listChangeRequestPatches` walks them all for the review check. */
  listChangeRequestFiles(repo: ForgeRepo, ref: string): Promise<Page<ChangedFile>>;
  /**
   * The NEWEST `limit` entries of a change request's history, oldest first within that window.
   * Bounded by the caller because the cap is a rendering decision: a five-hundred-commit branch
   * is read the same way a human reads it — the recent end, with a count of what came before.
   *
   * Throws `ForgeApiError` like any other read; the tool surface degrades the section rather
   * than the whole change request, because a history is context and the diff is the subject.
   */
  listChangeRequestCommits(
    repo: ForgeRepo,
    ref: string,
    limit: number,
    /** What the caller already learned about this change request, so the adapter does not buy
     * it twice. `total` is the commit count off a head the caller has already read. */
    known?: { total: number | null },
  ): Promise<CommitHistory>;
  /**
   * CI on `headSha`, read LIVE — nothing in this system ingests check runs, so the only honest
   * answer is the one the forge gives right now.
   *
   * Does NOT throw for a refusal, a missing permission or an outage: it answers `unavailable`
   * with a sentence saying which. An agent that cannot see CI must be told that, not handed a
   * change request read that failed for a reason it cannot act on.
   */
  readChecks(repo: ForgeRepo, headSha: string): Promise<ChecksReport>;
  /**
   * Shows a ryph check suite on `report.headSha`, which must already exist on the forge: a check
   * run per check on GitHub, one job run per suite on Radicle. Idempotent on `externalId` (and
   * on the suite's run uuid), so a retry converges rather than duplicating.
   */
  reportChecks(repo: ForgeRepo, report: CheckReport): Promise<ReportChecksOutcome>;
  createIssue(
    repo: ForgeRepo,
    params: { title: string; body: string; labels: string[]; embeds?: BodyEmbed[] },
  ): Promise<{ ref: string; url: string }>;
  /** A comment on an issue's or a change request's conversation; the kind picks the
   * permission. */
  createComment(
    repo: ForgeRepo,
    thread: ThreadRef,
    body: string,
    embeds?: BodyEmbed[],
  ): Promise<{ url: string }>;
  /**
   * A reply inside the review thread `commentId` belongs to, on change request `ref`. Refuses
   * (terminal) a remark that is not on that change request: the grant was checked against the
   * THREAD, so a remark id from anywhere else must not become a write there. Answers the reply's
   * URL.
   */
  replyToReviewComment(
    repo: ForgeRepo,
    ref: string,
    commentId: string,
    body: string,
    embeds?: BodyEmbed[],
  ): Promise<{ url: string }>;
  /**
   * Why `text` cannot be posted as a review remark on a line of the diff, or as a reply in a
   * review thread — null when it can: what `createReview` or `replyToReviewComment` would refuse
   * of the text itself, asked before the write is reserved so that the refusal spends nothing.
   * Left out by a forge that refuses no such text.
   */
  reviewTextProblem?(text: string): string | null;
  /** Marks resolved the review thread remark `commentId` belongs to, on change request `ref` —
   * refusing a remark from anywhere else, as a reply does. Resolving a resolved thread changes
   * nothing, so a blind retry is safe. */
  resolveReviewThread(repo: ForgeRepo, ref: string, commentId: string): Promise<void>;
  /** Adds labels, never removes one. Answers the thread's URL. */
  addLabels(repo: ForgeRepo, thread: ThreadRef, labels: string[]): Promise<{ url: string }>;
  /** Closes an issue, saying why. Closing a closed issue changes nothing. Answers its URL. */
  closeIssue(
    repo: ForgeRepo,
    ref: string,
    reason: "completed" | "not_planned",
  ): Promise<{ url: string }>;
  /**
   * Every file a change request changes with its unified-diff hunks (`patch`), for checking
   * that a review's remarks anchor before it is made. `patch` is null where the forge shows no
   * diff (a binary file, one too large). `complete` is false when the forge stopped listing
   * first.
   */
  listChangeRequestPatches(
    repo: ForgeRepo,
    ref: string,
  ): Promise<
    {
      files: Array<{ path: string; patch: string | null }>;
      complete: boolean;
      /** The head the diff was read at — what a review checked against these lines must be
       * posted against, or the check and the write are about two different commits. */
      headSha: string;
    }
  >;
  /**
   * One comment-only review — a body and its remarks. `headSha` is the commit the remarks were
   * checked against: passed, the review is posted against THAT head, so a push landing between
   * the check and the write cannot turn validated remarks into a 422 that costs the run its
   * review cap for nothing. Null where nothing was checked (a review with no remarks), and the
   * adapter reads the head itself.
   */
  createReview(
    repo: ForgeRepo,
    ref: string,
    params: {
      body: string;
      /** The body's images; the remarks carry none. */
      embeds?: BodyEmbed[];
      comments: Array<{ path: string; line: number; side: "LEFT" | "RIGHT"; body: string }>;
      headSha: string | null;
    },
  ): Promise<{ url: string }>;
  /**
   * Looks for a write this deployment made since `since` whose body carries `marker` — how a
   * write whose response was lost is told apart from one that never happened. Lists (the forge's
   * search index lags); null when nothing matches.
   */
  findMarkedWrite(
    repo: ForgeRepo,
    target: WrittenTarget,
    marker: string,
    since: string,
  ): Promise<{ url: string; createdRef: string | null } | null>;
}

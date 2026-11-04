// The shared shapes of the forge boundary.
//
// `ForgeEvent`, `ForgeThread` and `Permission` are the wire contract toward the orchestrator's
// `ports/forge.ts` — the normalized, forge-agnostic shapes a webhook is reduced to before it may
// travel. Defining them as the boundary keeps an unvalidated payload from ever reaching the core.
//
// Invariants:
// - secrets NEVER appear in these types. A run's git credential arrives as a presented token and
//   is resolved through `ports/key_store.ts`; a forge App's credentials belong in adapters only.
//   Every payload here is archivable verbatim.
// - forge-agnostic by construction: the words "PullRequest", "installation_id" and "Octokit"
//   may appear only inside `adapters/forge_api/`, never here.

/** Which forge a repo lives on. The registry in `ports/forge_api.ts` is keyed by it, and every
 * path that acts on a repo carries it — the connected repo's row is where it comes from.
 * `local` is not a forge at all: a git repository on the forge's own disk, addressed by its
 * real path, with no tenants, threads or identities (`adapters/forge_api/local.ts`). `gitlab`
 * is one GitLab instance per deployment (`RYPH_GITLAB_URL`), gitlab.com or self-managed. */
export type ForgeProvider = "github" | "gitlab" | "radicle" | "local";

/** Where a repo lives, as the core addresses it: the upstream remote URL, nothing forge-shaped.
 * The URL is the cache key unless `key` says otherwise. */
export interface RepoCoords {
  url: string;
  /**
   * What the cache keeps the repo's entry under, where `url` is only where it lives today — a
   * GitLab project's id (`repoCacheCoords`), so a rename keeps its entry and a project that
   * later takes the old path never shares it. Absent: the URL is the key.
   */
  key?: string;
}

/**
 * What a presented run credential resolves to: the run it speaks for and the SET of connected
 * repos it holds — one member per repository of the run's checkout, each with the upstream it
 * is fetched from, the base it starts at, and the one output ref a bundle for it may declare.
 * Produced by the orchestrator (the only holder of run rows) and consumed by both doors — the
 * git wire protocol and bundle intake. The credential selects the set; the URL's
 * `:connectedRepoId` segment selects the member, and a member outside the set is a 401 like
 * any other bad credential.
 */
export interface RunGrant {
  runId: string;
  repos: RunGrantRepo[];
}

/** One member of a grant: a connected repo the run may read, and ship a branch for. */
export interface RunGrantRepo {
  /** The orchestrator's id for the connected repo — the segment a member URL names. */
  connectedRepoId: string;
  /** The upstream repo and base ref as the user named them (GitHub-side truth);
   * `@ryph/shared/refs` normalizes the ref to the local branch the cache serves. */
  url: string;
  ref: string;
  /** The branch the work on `ref` merges into, where that is not `ref` itself — a change
   * request's base. Refreshed beside `ref` on every advertisement, so the run's clone and each
   * later fetch see it as it stands upstream. Absent for a run that starts from its own base. */
  targetRef?: string;
  /** The branches a LINE of the run other than the default now stands on, where that is
   * neither `ref` nor `targetRef`: one whose change request merged into a branch of its own
   * (the control plane's landing `onto`). Refreshed beside `ref` on every advertisement, as
   * `targetRef` is, so the run's landing fetch of one sees it as it stands upstream. At most one per
   * line (`MAX_LINES_PER_REPO`); absent when there is none. */
  lineBases?: string[];
  /** The run's branch NAMESPACE in this repo, e.g. "ryph/ada/r-01jb7k3m9x4q8zt2vw6hn5c0fe": a
   * bundle from this run for this repo may declare only a line under it — `<namespace>/<line>`
   * or a later generation `<namespace>/<line>-<n>` (@ryph/shared/lines). For a build's or a check
   * pod's grant it is a namespace no run owns, so nothing filed under it becomes a patch. */
  branchNamespace: string;
  /** Which forge this repo lives on — what picks the `ForgeApi` every path resolves through. */
  provider: ForgeProvider;
  /** The repo's address as that forge spells it — opaque here, as everywhere outside the
   * adapter that owns the spelling. */
  repoRef: string;
  /**
   * The forge-side tenant this repo was connected under — the identity the boundary may act
   * AS when it fetches the base. Opaque here by design: `adapters/forge_api/` is the only
   * place that knows it is a GitHub App installation, and the only place that can turn it into
   * a credential. Null for a provider that has no tenants at all.
   *
   * This names a credential; it is not one. The invariant above still holds.
   */
  tenantId: string | null;
  /**
   * GitLab's numeric project id, which no rename or transfer changes: every git contact with the
   * member is made where GitLab places this id now (`ForgeApi.locateUpstream`), never at `url`,
   * whose path another project may since have taken. Absent on every other forge.
   */
  forgeId?: string;
  /**
   * Set only on a CHECK POD's grant: the one commit it may read, served from a scratch repo of
   * its own and re-verified against `headSha` before anything is served. Such a grant reads and
   * never ships: intake refuses a member carrying it. The grant's `runId` is then the suite's id.
   */
  candidate?: CheckCandidate;
}

/**
 * What a check grant's commit is served from — one of two, told apart by which key is present:
 * - `bundleKey`: the head of a run's bundle, which no upstream has yet, staged out of the
 *   patch store
 * - `fetchRef`: a change request's head the FORGE already has (a push to a pull request or a
 *   patch), fetched by id into the shared cache entry — and, when the forge will not serve it
 *   by id, through `fetchRef` (`refs/pull/42/head`; null where the forge has no such ref)
 *
 * Either way `branchName` is the branch the head is served as in the candidate repo (a bundle's
 * one ref names it, so it must match): one branch, not a run's namespace of them.
 */
export type CheckCandidate =
  | { headSha: string; branchName: string; bundleKey: string }
  | { headSha: string; branchName: string; fetchRef: string | null };

/**
 * The receive record: one accepted bundle. This is the provenance anchor — the gateway knows
 * first-party which run produced which head SHA, unforgeable by the agent — and `headSha` is
 * the unforgeable input a downstream idempotency key is built from.
 */
export interface PatchSubmission {
  runId: string;
  /** Which repo of the run's set the bundle is for — the member the intake URL named. */
  connectedRepoId: string;
  branchName: string;
  /** The tip of the bundled branch, read from the bundle's own header. */
  headSha: string;
  /** Where `ports/patch_store.ts` filed the bundle. */
  bundleKey: string;
  receivedAt: string;
}

/**
 * A permission check's answer. Three-valued on purpose: "GitHub said no" and "GitHub didn't
 * answer" are different facts, and collapsing them into value-or-throw would discard a distinction
 * callers may need. A caller that cannot act on it treats "unknown" as deny.
 */
export type Permission = "allowed" | "denied" | "unknown";

/** An org-membership check's answer, three-valued for `Permission`'s reason. */
export type OrgMembership = "member" | "not-member" | "unknown";

/**
 * A normalized forge event, as the orchestrator receives it: already HMAC-verified, already
 * validated through `schema.ts`, carrying no forge-specific shape. The forge package verifies
 * and normalizes; every decision (dedupe, event→intent, authorization) is the orchestrator's.
 */
export interface ForgeEvent {
  /** The forge's own delivery id — the idempotency key downstream. */
  deliveryId: string;
  /** Dotted forge-agnostic form, e.g. "issue_comment.created". */
  kind: string;
  repo: ForgeEventRepo;
  /** The forge login of whoever caused the event. */
  actorLogin: string;
  /** The forge's stable account id for that actor, where the forge has one and the event was
   * built from the forge's own answer (GitLab's numeric user id): a login can be renamed and
   * handed to someone else, the id cannot, so the control plane resolves people by it. */
  actorId?: string;
  /** The conversation the event belongs to, when it belongs to one. */
  thread: ForgeThread | null;
  /** The instruction-bearing text, when the event carries one. Untrusted by definition. */
  body: string | null;
  /** The forge's id for the addressable message the event came from (a comment id, forge-side)
   * — what a reaction or reply targets. Null when the event has no such message. */
  sourceCommentId: string | null;
  /** Set when the event came from an inline remark on a change request's diff rather than its
   * conversation: which remark — the id a reply in its review thread names. */
  inline?: { commentId: string };
  /** Set exactly on a `branch.updated`: the repo's DEFAULT branch moved, and to which commit.
   * `ref` is the bare branch name as the forge reported the default at the time, so it is also
   * how the control plane learns that the default itself changed. No other branch is ever
   * reported: a push to a feature branch or a fork is nothing the platform builds from. */
  branch?: BranchUpdate;
  /** Set exactly on a `check_run.rerequested`: which of ryph's check runs a human re-requested.
   * `externalId` is the one ryph posted the run with, echoed back — untrusted until the control
   * plane matches it to a suite on this repo and commit. */
  checkRun?: { externalId: string; headSha: string; name: string };
  /** Set exactly on a `check_suite.rerequested`: a human pressed "Re-run all checks" on ryph's
   * runs on `headSha`. It names no run, so which suites re-run is the control plane's read of
   * what it posted on that commit. */
  checkSuite?: { headSha: string };
  /** Set exactly on a `change_request.pushed`: a change request's head or base may have moved,
   * and to what. Who pushed is `actorLogin`; whether their head may run is the control plane's
   * call, not this package's. */
  changeRequest?: ChangeRequestPush;
  /** Set on every `change_request.merged`. `heads` is what merged, by commit: the change
   * request's head at the merge — GitHub's `pull_request.head.sha`, never its merge commit, so a
   * squash or a rebase merge names the commits that were asked to merge — or the head of the
   * Radicle revision the delegates merged, which may be an OLDER revision than the latest. A
   * commit merged when it is an ancestor of, or equal to, ANY of them. Empty only when the forge
   * named none, and then nothing can be judged contained.
   *
   * `baseRef`, GitHub's alone, is the bare branch the pull request merged into, as GitHub reports
   * the base at the merge — which is where the control plane moves a run that worked it, not the
   * base it was opened against (a stacked pull request is retargeted when its base merges).
   * Radicle's patches always merge into the default branch, and name none. */
  merged?: { baseRef?: string; heads: string[] };
  receivedAt: string;
}

/** A change request as one push left it. */
export interface ChangeRequestPush {
  /** The change request's address — the pull request number as text, or the patch id: the
   * same as the thread's `ref`, and what the control plane files a patch's `forge_ref` as. */
  ref: string;
  /** The head commit, 40 or 64 hex. */
  headSha: string;
  /** The head this push moved FROM, where the forge says: GitHub's `synchronize` carries it;
   * every other action, and every Radicle revision, is null. */
  before: string | null;
  /** The bare branch name the change request targets. */
  baseRef: string;
  /** Who opened the change request, as the forge names people (a login, a DID) — where
   * `actorLogin` is who produced this head. */
  author: string;
  /** The author's stable account id, where the forge read one (GitLab's numeric user id): a
   * login can be renamed and handed on, so the control plane's gate asks about this instead. */
  authorId?: string;
  /** Where the forge can fetch the head when it will not serve it by id
   * (`refs/pull/42/head`), or null when there is no such ref. */
  fetchRef: string | null;
  /** The change request's page for a human, or null when none is known. */
  url: string | null;
}

/** A default branch moving: its bare name ("main") and the commit it now points at. */
export interface BranchUpdate {
  ref: string;
  commit: string;
}

/**
 * What a ref is to its connected repo, for deciding whose environment a run on it may use:
 * - "default": the default branch itself
 * - "branch": another branch the repo's own writers control — on GitHub a branch of the
 *   connected repo (a pull request from it included); on Radicle a canonical branch, or a
 *   change request authored and revised only by a delegate or by this deployment's own node
 * - "foreign": anything else — a fork's pull request head, another peer's change request
 */
export type BranchKind = "default" | "branch" | "foreign";

/**
 * Which repo an event is about. `provider` and `repoRef` are what the control plane MATCHES
 * on — the pair is the repo's identity on its forge, and it is exact: a RID is base58, where
 * case is meaning, so normalizing one the way a URL is normalized would merge two repos.
 * `url` rides along for the log and for a human reading a delivery; it is not the key.
 */
export interface ForgeEventRepo extends RepoCoords {
  provider: ForgeProvider;
  repoRef: string;
  /**
   * The forge's immutable id for the repo, where the address alone is not one: GitLab's numeric
   * project id, the scope its webhook token was verified for. A GitLab project can be renamed
   * or moved, and its old path reused by another, so a GitLab event is matched on this and
   * `repoRef` is only the path the forge read for it just now.
   */
  forgeId?: string;
}

/** The kinds of conversation a forge event can belong to. `ref` is the thread's address as its
 * forge spells it — "12" on GitHub, a collaborative-object id on Radicle — so it is text here
 * and an integer only inside the GitHub adapter. */
export interface ForgeThread {
  kind: "issue" | "change_request";
  ref: string;
}

/**
 * What the orchestrator resolves a calling run to for door ⑤, the tool surface: which repos it
 * may act on, the thread it came from, the threads it has opened, what it may do, and what its
 * writes are signed with. Produced by the orchestrator (POST /v1/forge/tool-grants/resolve) from
 * the forge scope frozen onto the run; checked here, per call, by `core/tool_grant.ts`. The forge
 * enforces it and decides nothing — the same bargain `RunGrant` strikes for door ①.
 */
export interface ToolGrant {
  runId: string;
  repos: ToolGrantRepo[];
  /**
   * The repos whose SOURCE this run holds — its checkout — whether or not it may write to them.
   * Separate from `repos` because the two answer different questions: `repos` is where a write
   * may go, `sourceRepos` is what the agent has read. The visibility rule needs the second (a
   * run that checked out a private repo must not open a public issue with it in the body), and
   * a `repos: {connectedRepoIds}` policy REPLACES the checkout in `repos` rather than adding to
   * it — so reading the rule off `repos` alone would call such a run source-free. May overlap
   * `repos`.
   */
  sourceRepos: ToolGrantRepo[];
  /** The thread a /ryph command came from, or the change request the task works on. */
  origin: ToolGrantThread | null;
  /** Threads this run opened — its `create_issue` issues and the change requests its patches
   * opened — writable under an "origin" rule, as the origin thread is. */
  opened: Array<{ connectedRepoId: string; ref: string }>;
  /** Change requests the run checked out, at start or by retargeting. Comment access only. */
  workedChangeRequests?: Array<{ connectedRepoId: string; ref: string }>;
  capabilities: ToolCapabilities;
  provenance: ToolProvenance;
}

/** A repo a run's tools may act on. `tenantId` names the credential it acts with (see
 * `RunGrantRepo.tenantId`); null where the provider has no tenants of its own. */
export interface ToolGrantRepo {
  connectedRepoId: string;
  provider: ForgeProvider;
  /** The repo's address as its forge spells it — "owner/name" on GitHub, a RID on Radicle.
   * What the agent names it by, and what the API is addressed with. */
  repoRef: string;
  tenantId: string | null;
  /** GitLab's numeric project id: what every call about the repo addresses it by, where
   * `repoRef` is only the path it had when the grant was resolved. Absent on every other forge. */
  forgeId?: string;
}

export interface ToolGrantThread {
  connectedRepoId: string;
  kind: "issue" | "change_request";
  ref: string;
}

/** "origin": the origin thread (reviews), plus threads the run opened (comments/closure),
 * plus change requests it worked on (comments only). "any": any thread of a repo in the grant. */
export type ToolWhere = "origin" | "any";

export interface ToolCapabilities {
  read: boolean;
  createIssues: { max: number } | null;
  comment: { where: ToolWhere; max: number } | null;
  /** submit_review — change requests only; the cap counts reviews, not their remarks. */
  review: { where: ToolWhere; max: number } | null;
  /** close_issue — issues only, never a change request. */
  closeIssues: { where: ToolWhere; max: number } | null;
  /** Labels create_issue and add_labels may apply, as the policy spells them. */
  labels: string[];
}

/** What the footer on every write says. */
export interface ToolProvenance {
  agentName: string;
  runUrl: string | null;
  /** The forge login of whoever asked for the run; null when none resolves, and for a run a
   * chat mention started. */
  requestedBy: string | null;
  /** A chat-started run's commander, by display name (a chat identity, not a forge login);
   * null otherwise. */
  requestedVia: string | null;
}

export type ReadToolName =
  | "get_issue"
  | "list_issues"
  | "get_change_request"
  | "compare_change_request"
  | "list_change_requests";
export type WriteToolName =
  | "create_issue"
  | "add_comment"
  | "add_labels"
  | "submit_review"
  | "close_issue";
export type ToolName = ReadToolName | WriteToolName;

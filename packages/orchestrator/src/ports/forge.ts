// The forge, as the control plane sees it. This port hides WHICH forge (GitHub today, Radicle
// next); @ryph/forge's own ForgeApi port hides WHICH API CLIENT — two ports, two jobs.
// Every method here is a question or a delivery; every decision (may this user launch?,
// is this patch approved?) is made by the caller against the answers.
//
// Invariants:
// - `checkPermission` returns a VALUE, never value-or-throw: "the forge said no" and "the
//   forge didn't answer" are different facts ("denied" vs "unknown"), and collapsing them
//   would force re-plumbing every caller to add the distinction later. A caller treats "unknown"
//   as deny — a one-line policy at the call site, not a port shape.
// - `submitPatch` never throws either: the sweep must tell a retryable failure (502, rate
//   limit, forge down) from a terminal one (403, deleted base) to set the right clock, so
//   the distinction is in the outcome, not in exception shape.

import type { ForgeProvider } from "../core/types.ts";
import type { CheckSuiteState } from "../core/check_types.ts";

/** Three-valued on purpose — the resilience seam. */
export type ForgePermission = "allowed" | "denied" | "unknown";

/** Whether a login belongs to the account an installation sits on; three-valued like above. */
export type ForgeOrgMembership = "member" | "not-member" | "unknown";

/** The human behind an OAuth code, as the forge describes them. */
export interface ForgeIdentity {
  /** The forge's stable id for the account — logins rename, this does not. */
  accountId: string;
  login: string;
  name: string | null;
  /** Every address the forge itself has verified for the account. */
  verifiedEmails: string[];
  /** The raw user token, returned once. Null when the forge withheld it. */
  accessToken: string | null;
}

/**
 * Which repo a call is about, and as whom — everything the boundary needs to pick an adapter
 * and act. Read off the connected repo row and never composed by a caller: `repoRef` is opaque
 * ("owner/name" on GitHub, a RID on Radicle) and `tenantId` names a credential the boundary
 * holds, or is null for a forge that has no tenants at all — GitHub in user mode among them,
 * where the one token the forge holds is the credential.
 */
export interface ForgeRepoRef {
  provider: ForgeProvider;
  repoRef: string;
  tenantId: string | null;
  /** A GitLab project's id on its instance, `<id>@<url>` (`ConnectedRepo.forgeId`): REQUIRED for
   * a GitLab repo — the forge addresses the project by it alone, never by `repoRef`, and refuses
   * a GitLab call without it or naming another instance than its own. */
  forgeId?: string;
}

/** Who someone is on one forge: a login on GitHub, a DID on Radicle, and on GitLab the account
 * id `<id>@<url>` a link stored (`IdentityDirectory.subjectFor`) — never a GitLab username, which
 * its holder can give up and anybody can register next. The provider is carried so an identity
 * linked on one forge can never be read as access on another. */
export interface ForgeSubject {
  provider: ForgeProvider;
  /**
   * The identity as this provider names it, or NULL for "there is no identity" — the caller
   * has nobody to name on this forge and is asking anyway. Null is the one spelling of that;
   * the empty string is not a subject, it is a subject-shaped hole that a tightened validator
   * or a `.trim()` somewhere downstream would quietly turn into a 400.
   *
   * A caller may pass null only where the question's answer genuinely does not turn on who is
   * asking — today that is `checkPermission(repo, ..., "write")` on a PUBLIC Radicle repo,
   * where contribution is permissionless. Everywhere else a null subject is simply an identity
   * that is in no set, so the answer is "denied"; see each adapter for the per-provider rule.
   */
  subject: string | null;
}

/** Which conversation, by the address its forge spells it with. */
export interface ForgeThreadRef {
  kind: "issue" | "change_request";
  ref: string;
}

/**
 * What a repo's `.ryph/services.yml` came back as. Four arms, for `checkPermission`'s reason
 * one level up: "the repo declares no services", "the repo declares something we refuse to
 * read", and "we could not ask" are three different facts, and a caller that collapsed them
 * would launch a run with no database on two of the three — the hang this exists to prevent.
 *
 * Read out of the forge's own repo cache, never through a forge API, so it is exactly as
 * available as the clone that follows it. See @ryph/forge's http/service.ts.
 */
export type ServicesFile =
  | {
    kind: "file";
    /** The file's bytes as text, unparsed. The control plane parses; the boundary carries. */
    text: string;
    /**
     * True when the upstream refresh failed and the cache answered from what it already held:
     * `serveBase`'s `freshness` of kind `stale`, honoured. The declaration may be a fetch behind
     * the tree the run is about to clone, so the run says so rather than quietly running
     * yesterday's.
     */
    stale: boolean;
  }
  | { kind: "absent" }
  /** Present and unusable — over the byte ceiling. The repo's author is the one who can fix it,
   * so the detail is written to be shown to them. */
  | { kind: "invalid"; detail: string }
  | { kind: "unavailable"; detail: string };

/**
 * What a repo's `.ryph/checks.yml` came back as, at one pinned commit — with everything else a
 * suite needs from the same commit, so the judge is read in one round trip and cannot straddle
 * two commits. The four arms of `ServicesFile`, for its reason, with one difference: there is
 * NO stale answer. A stale base is a wrong judge, so a refresh that failed is `unavailable`.
 */
export type ChecksFile =
  | {
    kind: "file";
    /** The bytes as text, unparsed, ≤ 64 KiB (the size is checked before decoding). */
    text: string;
    path: ".ryph/checks.yml" | ".ryph/checks.yaml";
    /** The pinned commit every field below was read at. */
    commit: string;
    /** The checks file's blob id. */
    blob: string;
    /** The `.ryph` tree id at `commit`, as `RyphTree.tree` answers it. */
    ryphTree: string | null;
    /** Whether `.ryph/Dockerfile` is a file at `commit`. */
    dockerfile: boolean;
    /** `.ryph/services.{yml,yaml}` at the SAME commit. */
    services: { kind: "file"; text: string } | { kind: "absent" } | {
      kind: "invalid";
      detail: string;
    };
  }
  | { kind: "absent"; commit: string }
  /** Over the byte ceiling, or a ref the forge refuses outright; the detail is written for the
   * repo's author. `commit` is null when the forge refused before pinning one. */
  | { kind: "invalid"; commit: string | null; detail: string }
  /** NEVER collapses to absent: a rolling upgrade must not turn a gated repo into an ungated one. */
  | { kind: "unavailable"; detail: string };

/** One check, as the forge is told about it. */
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
  /** Markdown, ≤ 60 000 chars: the claim sentence with commit, blob and digest; the fenced
   * log tail. */
  summary: string;
  startedAt: string | null;
  completedAt: string | null;
  /** `${suiteId}:${generation}:${name}` — the idempotency key on GitHub. */
  externalId: string;
  /** A known check-run id → update it; null → find by `externalId`, else create. */
  forgeRef: string | null;
}

/** A suite on one commit, as the forge is told about it: per check where the forge has checks,
 * one run for the whole suite where it does not (Radicle's job COB). */
export interface CheckReport {
  headSha: string;
  suiteId: string;
  generation: number;
  detailsUrl: string | null;
  suite: {
    state: CheckSuiteState;
    /** Null while not settled, and for a cancelled suite, which neither passed nor failed. */
    conclusion: "success" | "failure" | null;
    /** One paragraph, for a one-run-per-suite forge. */
    summary: string;
    /**
     * Older generations of this suite that were reported while still going and never reported
     * settled: a forge with one run per generation (Radicle) finishes those runs as failed;
     * GitHub ignores it, since the newer runs of the same names shadow them. Absent when none.
     */
    previousGenerations?: number[];
  };
  checks: CheckRunReport[];
}

export type ReportChecksOutcome =
  | { kind: "reported"; refs: Record<string, string> }
  /** e.g. the App lacks `Checks: write`: degrade, remember, stop asking for a while. */
  | { kind: "unsupported"; reason: string }
  | { kind: "failed"; message: string; terminal: boolean };

/**
 * Checks' forge surface, kept OFF `Forge` so every `Forge` a test spells out inline stays
 * whole. Both methods never throw, for `submitPatch`'s reason: the caller sets a different
 * clock for "could not ask" than for "was refused".
 */
export interface ForgeChecks {
  /** Stream a previously verified intake bundle to a remote checks instance. Null means gone;
   * transport failures throw so the caller retries rather than treating them as absence. */
  readCheckBundle?(bundleKey: string): Promise<ReadableStream<Uint8Array> | null>;
  /** `commitOrRef`: a bare branch, `refs/heads/*`, or a full commit id. */
  readChecksFile(repo: ForgeRepoRef, url: string, commitOrRef: string): Promise<ChecksFile>;
  reportChecks(repo: ForgeRepoRef, report: CheckReport): Promise<ReportChecksOutcome>;
  /**
   * A person's bundle, off their own machine, streamed to the forge to verify and keep for a
   * local check ask (`POST /v1/service/check-bundle`): exactly one ref, `refs/heads/<branch>`,
   * whose prerequisites the base satisfies. Never throws: anything that is not the forge's own
   * verdict on the bundle is `unavailable`. The body is streamed, never held whole here, and a
   * streamed request carries no length, so the forge's cap is on the bytes it reads.
   */
  stageCheckBundle(
    repo: ForgeRepoRef,
    url: string,
    ask: CheckBundleAsk,
    body: ReadableStream<Uint8Array>,
  ): Promise<StageCheckBundleOutcome>;
  /**
   * The commit a branch of the repo points at on its forge now, read live (`POST
   * /v1/service/branch-head`): what proves a person's pushed commit is theirs to ask about.
   * Never throws: anything that is not the forge's own answer is `unavailable`.
   */
  readBranchHead(repo: ForgeRepoRef, url: string, branch: string): Promise<BranchHeadOutcome>;
}

/**
 * A patch's diff, read for the person reviewing it (`POST /v1/service/patch-diff`): its bundle
 * staged and verified as a submission verifies it, then diffed against where it lands. Kept off `Forge` for
 * `ForgeChecks`'s reason. Never throws: anything that is not the forge's own verdict is
 * `unavailable`.
 */
export interface ForgePatchDiffs {
  readPatchDiff(repo: ForgeRepoRef, url: string, ask: PatchDiffAsk): Promise<PatchDiffOutcome>;
}

/** Which patch, as its row names it. */
export interface PatchDiffAsk {
  connectedRepoId: string;
  bundleKey: string;
  branchName: string;
  headSha: string;
  /** Where the run reported the bundle was cut from; a settled patch's diff starts there. */
  baseSha: string | null;
  /** The head an unpublished patch's diff is measured against (core/patch_lifecycle.ts
   * `submissionTarget`'s `diffRef`): the branch a fresh change request is opened against, or the
   * head of the one the submission pushes onto — on Radicle that patch's `patches/<id>`. */
  targetRef: string;
  /** `live` for a patch not yet published, `record` for one settled. */
  mode: "live" | "record";
}

export type PatchDiffOutcome =
  /** `diff` is git's unified diff, cut at a file boundary when `truncated`, and `omitted` the
   * files it then leaves out — all of them unless `moreOmitted`. */
  | {
    kind: "diff";
    diff: string;
    baseSha: string;
    headSha: string;
    truncated: boolean;
    omitted: string[];
    moreOmitted: boolean;
  }
  /** The forge's own terminal answer: the bundle is gone (410), no longer verifies or its base
   * is gone (409), or the ask was malformed (400). Asking again changes nothing. */
  | { kind: "refused"; status: number; error: string }
  /** The forge could not be asked, or could not answer: worth trying again. */
  | { kind: "unavailable"; error: string };

/**
 * The org skills repo's `.agents/skills/` as the forge read it at one pinned commit: every file's
 * path (relative to `.agents/skills/`), git mode and bytes, unjudged. What a skill is stays the
 * control plane's rule (core/skills.ts).
 */
export type SkillsTree =
  | {
    kind: "tree";
    commit: string;
    /** The `.agents/skills` tree id at `commit`. */
    tree: string;
    files: Array<{
      path: string;
      mode: "100644" | "100755" | "120000" | "160000";
      /** Base64; null for a symlink or a submodule, which the forge never reads. */
      content: string | null;
    }>;
  }
  /** The tree id the caller passed as known: nothing more was read. */
  | { kind: "unchanged"; commit: string; tree: string }
  | { kind: "absent"; commit: string }
  /** Over the forge's read bounds, or a ref it refuses outright; written for the repo's author.
   * `commit` is null when it refused before pinning one. */
  | { kind: "invalid"; commit: string | null; detail: string }
  /** The upstream says the branch is gone: an answer, not an outage. A repo the forge cannot
   * reach is `unavailable`. */
  | { kind: "missing-ref" }
  | { kind: "unavailable"; detail: string };

/**
 * The org skills repo's forge surface, kept OFF `Forge` for `ForgeChecks`' reason. Never throws:
 * a sync records "could not ask" as a failed read and keeps the version it has.
 */
export interface ForgeSkills {
  /** `commitOrRef`: a bare branch, `refs/heads/*`, or a full commit id. `knownTree`: the tree id
   * of the version the caller holds, so an unchanged directory costs no content. */
  readSkillsTree(
    repo: ForgeRepoRef,
    url: string,
    commitOrRef: string,
    knownTree: string | null,
  ): Promise<SkillsTree>;
}

export type BranchHeadOutcome =
  | { kind: "head"; sha: string }
  /** The forge says there is no such branch. */
  | { kind: "absent" }
  /** This forge cannot answer for a branch (501): a pushed ask is not provable there. */
  | { kind: "unsupported" }
  | { kind: "unavailable"; error: string };

/** Who a check bundle is from, and what it must be: filed under the user and the repo, its one
 * ref the person's branch, verified against the base it was cut from. */
export interface CheckBundleAsk {
  connectedRepoId: string;
  userId: string;
  /** Bare: the bundle's one ref is `refs/heads/<branchName>`. */
  branchName: string;
  /** The base branch, bare, whose cache the bundle's prerequisites are verified against. */
  baseRef: string;
}

export type StageCheckBundleOutcome =
  /** Verified and kept: the bundle's head, and the key it was filed under. */
  | { kind: "staged"; headSha: string; bundleKey: string }
  /** The bundle's own fault, said by the forge: malformed, the wrong ref, prerequisites the
   * base does not satisfy (400), or past the size cap (413). */
  | { kind: "refused"; status: 400 | 413; error: string; detail: string | null }
  /** The forge could not be asked, or could not answer: worth trying again. */
  | { kind: "unavailable"; error: string };

/** The empty tree's id, in both of git's object formats: what `RyphTree.tree` answers for a
 * `.ryph/` that holds only files no build reads. */
export const EMPTY_TREES: ReadonlySet<string> = new Set([
  "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
]);

/** A repo's `.ryph/` directory at one commit, as an object id — what an environment is keyed
 * on. The id leaves out the files no build reads (checks.yml, services.yml, environment.md;
 * @ryph/forge's `RYPH_NOT_BUILT`), so a change to only those is no change of machine. `tree`
 * is null when the commit has no `.ryph/` directory; one of only those files is the empty tree's
 * id (`EMPTY_TREES`). An id and never content: the forge's
 * one-fixed-path rule (@ryph/forge's threat model) holds for this read too. */
export interface RyphTree {
  /** The commit that was read — the one `commitOrRef` named, or the branch's head at the time. */
  commit: string;
  tree: string | null;
  /** The whole `.ryph/` directory's tree id, the files left out of `tree` included: null exactly
   * when `tree` is. Only for telling a branch that changed just those files apart. */
  fullTree: string | null;
  /** Whether `.ryph/Dockerfile` is a file at that commit — a yes or a no, never its content.
   * False whenever `tree` is null. It decides whether the repo has a machine of its own: a run
   * with no environment built yet waits for the first build only when this is true. */
  dockerfile: boolean;
  /** `.ryph/Dockerfile`'s blob id: null exactly when `dockerfile` is false. An id, never content.
   * It says whether the machine changed when something else under `.ryph/` did. */
  dockerfileBlob: string | null;
}

/**
 * Where a branch head's `.ryph/` came from (`Forge.ryphBase`): the default branch's head as it
 * was read, the merge base of the two, the `.ryph/` tree id there, and the paths under `.ryph/`
 * the head changed since it. Ids and names under one fixed directory, never content.
 */
export interface RyphBase {
  /** The default branch's head that was read. */
  base: string;
  /** Null when the head and the default branch share no history; `tree` is null and `changed`
   * empty then. */
  mergeBase: string | null;
  tree: string | null;
  /** Paths under `.ryph/` that differ between the merge base and the head, bounded; the files
   * no build reads are never named. */
  changed: string[];
}

/** The default branch as the UPSTREAM names it now, and the commit it points at. */
export interface DefaultBranchHead {
  /** The bare branch name ("main"). */
  ref: string;
  commit: string;
}

/**
 * What a ref is to its connected repo, which decides whose environment a run on it may use:
 * - "default": the default branch itself
 * - "branch": another branch the repo's own writers control — on GitHub a branch of the repo
 *   (a pull request from it included); on Radicle a canonical branch, or a change request that
 *   a delegate or this deployment's own node authored and revised
 * - "foreign": anything else — a fork's pull request, another peer's change request
 */
export type ForgeBranchKind = "default" | "branch" | "foreign";

/** Everything a submission needs; all of it comes from rows, none of it from live state. */
export interface PatchSubmission {
  /** Where the gateway filed the bundle. */
  bundleKey: string;
  branchName: string;
  /** The bundle's tip — verified against what actually lands, the provenance anchor. */
  headSha: string;
  repo: ForgeRepoRef;
  /** The upstream clone URL, off the connected repo row. */
  repoUrl: string;
  /** The branch the bundle is staged on and the change asks to merge into. With `changeRequest`
   * on GitHub, that pull request's own head branch, which the commits are pushed onto; on
   * Radicle the task's base, which the new revision is cut against (core/patch_lifecycle.ts
   * `submissionTarget`). */
  baseBranch: string;
  title: string;
  /** The report — provenance block included, composed by core/report.ts. Its `![alt](img-…)`
   * image refs are the agent's as written; the forge renders them against `runId`'s images. */
  body: string;
  /** The run whose patch this is: what the body's image refs resolve against. */
  runId: string;
  /** Set: deliver by updating this existing change request instead of opening a new one. */
  changeRequest?: string;
  /** The connected repo lets runs push onto its fork pull requests' branches
   * (`ConnectedRepo.allowForkPushes`). Absent: a fork's branch is refused at the forge. */
  allowForkPush?: boolean;
  /** The git hook files a person approved this patch with (Patch.approvedHookPaths). A `local`
   * delivery touching any hook file not listed is `held`, and nothing is pushed. */
  approvedHookPaths: string[];
}

export type SubmitOutcome =
  /** `url` is null where the forge has no web address for the change — a Radicle deployment
   * with no explorer configured. The ref is the change's identity and is never null. */
  | { kind: "submitted"; ref: string; url: string | null }
  /** `ended`: the forge refused because the change request it was to go onto merged or closed,
   * which this control plane may not have heard yet (a webhook still on its way, or none at all
   * in GitHub's user mode). */
  | { kind: "failed"; message: string; terminal: boolean; ended?: "merged" | "closed" }
  /** Nothing was pushed: the patch changes git hook files nobody approved (`touched`, capped at
   * 50 — `more` when there are others). Not a failure — a person has to look first. */
  | { kind: "held"; touched: string[]; hooksPaths: string[]; more: boolean };

/**
 * What the forge says about the git hook files a patch would bring into a `local` repository
 * (`POST /v1/service/local/patch-hooks`). `checked`: `touched` is the repo-relative hook files
 * it changes — sorted, at most 50, `more` when there are others — and `hooksPaths` where the
 * repository keeps its hooks (`"."` for the repository's root). `refused`: the forge said it
 * never will answer for this patch (`terminal: true` — its bundle gone or unverifiable, the
 * branch it lands on deleted, too many paths, the repo not local), and `message` says why.
 * `malformed`: it answered in a shape this does not read — asked again, but only so often.
 * `unavailable`: no answer this time (unreachable, or a failure the forge called retryable);
 * ask again. Never throws.
 */
export type PatchHooksOutcome =
  | { kind: "checked"; touched: string[]; hooksPaths: string[]; more: boolean }
  | { kind: "refused"; message: string }
  | { kind: "malformed"; message: string }
  | { kind: "unavailable"; message: string };

/** Three-valued for the same reason `ForgePermission` is: "no" and "we could not ask" are
 * different facts, and only the caller's retry clock can tell them apart. */
/** A change request's live state, as the head read answers it. */
export interface ForgeChangeRequestState {
  ref: string;
  /** A merged change request is closed AND `merged`. */
  state: "open" | "closed";
  merged: boolean;
  /** The newest head, whoever pushed it. */
  headSha: string;
  /** The AUTHOR's own newest head: `headSha` on GitHub, the author's latest revision on Radicle
   * (heartwood's `Patch::latest`), where anyone may add a revision. What checks judge. */
  authorHeadSha: string;
  /** The branch it asks to merge into, bare. */
  baseRef: string;
  /** Whether ryph opened it: its author is then ryph's own identity (the App, the node). */
  openedByUs: boolean;
  /** What merged, by commit — `InboundForgeEvent.merged.heads` as the read finds it: the pull
   * request's head, which GitHub stops moving at the merge, or the commit of the Radicle
   * revision the delegates merged, which need not be the latest (never `headSha` for that
   * reason). Empty unless merged, and on a merge whose head the forge does not name. */
  mergedHeads: string[];
}

export type ChangeRequestHeadOutcome =
  | { kind: "head"; head: ForgeChangeRequestState }
  /** Deleted, or never there. */
  | { kind: "gone" }
  /** The forge did not answer. Worth asking again. */
  | { kind: "unavailable" };

/**
 * Which of the heads ryph pushed onto a change request its merge contained
 * (`Forge.mergeContainment`) — git's answer, out of the forge's repo cache.
 * - `answered`: `contained` and `missed` partition the asked heads (each once, in the order
 *   asked); a head is contained in a merged head M when it is an ancestor of, or equal to, M;
 *   or its change is exactly M's, both ways (forge helpers/containment.ts), or it is in the
 *   history of a head that is. Never by author, date, message or patch id. A contained head may
 *   be a run's landed head (core/merge_settle.ts `cueMerged`) whichever rule held it.
 * - `refused`: the forge will never answer this question — the upstream has none of the merged
 *   heads, one it names is not a commit, or the request is one it will not read. Only the
 *   forge's own terminal 404 or 400 says so. Asking again changes nothing.
 * - `unavailable`: no answer this time (unreachable, the upstream or git failing, a malformed
 *   answer). Worth asking again.
 * Nothing but `answered` says anything about any head: never guess containment from the others.
 */
export type MergeContainmentOutcome =
  /** `intoTip`: the tip of the branch the merge went into, as the forge read it for the answer,
   * when it was named and read. */
  | { kind: "answered"; contained: string[]; missed: string[]; intoTip?: string }
  | { kind: "refused"; message: string }
  | { kind: "unavailable"; message: string };

/** One patch's bundle, as its row names it, for a lineage question (`Forge.patchLineage`). */
export interface LineageBundle {
  bundleKey: string;
  branchName: string;
  headSha: string;
}

/** A newborn patch's lineage question (`Forge.patchLineage`). */
export interface PatchLineageAsk {
  connectedRepoId: string;
  /** The branch the patch's line lands on: commits already on it are nobody's own. */
  targetRef: string;
  patch: LineageBundle;
  /** The run's other lines of the repo, each by its newest waiting patch. */
  others: Array<LineageBundle & { line: string }>;
  /** The tip its line's change request merged at (`RepoLanding.tip`), when it must hold it. */
  mustHold?: string;
}

/**
 * The forge's answer to a lineage question, read out of the bundles intake stored:
 * - `answered`: the lines of `others` whose own commits the patch shares (`overlaps`), and,
 *   where `mustHold` was asked, whether the patch's head holds it (`holdsTip`; false where the
 *   repo has no such commit).
 * - `unavailable`: no answer, for whatever reason. The caller holds the patch rather than guess.
 */
export type PatchLineageOutcome =
  | { kind: "answered"; overlaps: string[]; holdsTip?: boolean }
  | { kind: "unavailable"; message: string };

export type ForgeThreadOutcome =
  | { kind: "thread"; thread: ForgeThreadContext }
  /** Deleted, hidden, or never there — no redelivery brings it back. */
  | { kind: "gone" }
  /** The forge did not answer. Worth asking again. */
  | { kind: "unavailable" };

/** One GitHub repo as the connect flow lists it — what an App installation grants, or (in user
 * mode) what the token's owner can reach. GitHub-only. */
export interface RepoListing {
  fullName: string;
  url: string;
  defaultBranch: string;
  private: boolean;
}

/** One repo of the user-mode connect picker: a listing, and whether the token's owner holds
 * admin on it (GitHub's `permissions.admin`) — connecting needs it, so the picker says so up
 * front rather than after a refused connect. */
export interface GithubRepoListing extends RepoListing {
  admin: boolean;
}

/** One thing somebody said in a thread. A PR is an issue with code attached, so its
 * conversation, its review verdicts and its inline remarks all reduce to this shape. */
export interface ForgeThreadEntry {
  /** "comment" — the conversation; "review" — a PR review's summary and verdict;
   * "review_comment" — an inline remark anchored to a diff line. */
  kind: "comment" | "review" | "review_comment";
  authorLogin: string;
  body: string;
  createdAt: string;
  /** A review's verdict ("approved", "changes_requested", "commented"); null for the rest. */
  state: string | null;
  /** Where an inline remark sits, as "path:line"; null for the rest. */
  location: string | null;
  /** An inline remark's place in its review thread, where the forge threads them: its id (what
   * a reply names), the remark it answers, and whether the thread is resolved (null: unknown). */
  remark?: { id: string; replyTo: string | null; resolved: boolean | null };
  /** The handle a command event names this entry by — its `sourceCommentId`. Absent where no
   * command comes from (a review's summary). How a follow-up finds its own comment's images. */
  id?: string;
  /** The images this entry shows, in order of appearance — only on a read that asked for them
   * (`ForgeThreadReadOptions.images`). */
  images?: ForgeThreadImage[];
}

/**
 * An image a thread shows, as the forge downloaded it: where it sat in the entry's text, and its
 * bytes or why there are none. The forge has the egress and the credentials; the run has
 * neither, so this is the only way a thread's images reach an agent.
 *
 * SECURITY: as untrusted as the text. The bytes go through `inspectImage` before anything keeps
 * them, and `markup`/`name` were typed by whoever wrote the entry.
 */
export type ForgeThreadImage =
  | {
    kind: "image";
    /** The text that showed it, verbatim — what a marker replaces. "" when the text never named
     * it (a Radicle embed the body does not link): the marker then follows the text. */
    markup: string;
    /** Which exact match of `markup` in the body it is: how many matches (overlapping ones too)
     * start before it. The same text can stand in a code block, inside another tag's alt, or
     * twice, and only this one is where the image sat. Absent means 0; one the body does not
     * have puts the marker after the text. */
    occurrence?: number;
    /** A file name, where the forge keeps one (a Radicle embed). */
    name?: string;
    /** The bytes, base64. */
    data: string;
  }
  | {
    kind: "omitted";
    markup: string;
    occurrence?: number;
    name?: string;
    reason: ForgeThreadImageOmission;
  };

/** Why the forge has no bytes for an image: past the read's count, past the size cap, not one
 * of the four formats, or not readable at all. */
export type ForgeThreadImageOmission = "limit" | "too_large" | "unsupported" | "unavailable";

/** What a thread read may ask for beyond the text. */
export interface ForgeThreadReadOptions {
  /** Download the thread's images; `focus` is the command's own comment (`sourceCommentId`),
   * whose images are taken first when the thread has more than a read carries — or, with
   * `focusOnly`, the only ones: no other entry, nor the opening post, carries `images` then. */
  images?: { focus: string | null; focusOnly?: boolean };
  /** This read's deadline, when the caller has less time left than a thread read's own. */
  timeoutMs?: number;
}

/** The longest `markup` a thread image may carry, as the forge bounds it (its
 * `MAX_IMAGE_MARKUP`; a parity test in packages/forge holds the two together). */
export const MAX_THREAD_IMAGE_MARKUP = 4_000;
/** The highest `occurrence` the thread schema takes: no body the schema takes holds more
 * matches of anything than it has characters. */
export const MAX_THREAD_IMAGE_OCCURRENCE = 100_000;
/** The longest image `name` the thread schema takes; the forge cuts to less. */
export const MAX_THREAD_IMAGE_NAME = 255;
/** The longest `ForgeThreadEntry.id`, as the forge bounds it (its `MAX_ENTRY_ID`). */
export const MAX_THREAD_ENTRY_ID = 300;

/**
 * A thread as the control plane reads it — the opening post plus everything said since.
 *
 * SECURITY: every string in here was typed by a person on the forge, and on a public repo
 * that is ANYONE, not only the write-access holder who issued the command. Nothing composed
 * from this may be presented to an agent as an instruction; see core/thread_context.ts,
 * which is the only thing allowed to render it.
 */
export interface ForgeThreadContext {
  kind: "issue" | "change_request";
  ref: string;
  title: string;
  /** The opening post. "" is a real answer — plenty of issues are a title and nothing else. */
  body: string;
  authorLogin: string;
  createdAt: string;
  /** "open" or "closed", as the forge says it. */
  state: string;
  /** The opening post's images, in order of appearance — only on a read that asked for them. */
  bodyImages?: ForgeThreadImage[];
  /** Chronological, oldest first — the order a human reads them in. */
  entries: ForgeThreadEntry[];
  /** The thread outran the forge's fetch ceiling: `entries` is a prefix of the conversation,
   * and whatever renders it must say so rather than imply a complete picture. */
  truncated: boolean;
  /** Where a change request's code lives; null for an issue. */
  changeRequest: ForgeChangeRequestHead | null;
}

/** A change request's branch: what a run working on it checks out, and whether a push from us
 * can reach it at all. */
export interface ForgeChangeRequestHead {
  ref: string;
  url: string;
  /** A merged change request is closed AND `merged`. */
  state: "open" | "closed";
  merged: boolean;
  /** The head branch's bare name ("feat/scheduler"). */
  headRef: string;
  /** The newest head, whoever pushed it: what a run working on the change request checks out. */
  headSha: string;
  /** The change request's AUTHOR's own newest head. GitHub has one head, so it is `headSha`;
   * on Radicle anyone may add a revision to a patch, and this is the author's latest
   * (heartwood's `Patch::latest`), which is what checks judge. */
  authorHeadSha: string;
  /** The branch it asks to merge into, bare — what a run working on it merges to catch up. */
  baseRef: string;
  /** Where the head branch lives, by its forge's own address: the base repo, a fork, or null
   * for a deleted fork. For a fork ryph may not see (`headRepoHidden`), the only name the forge
   * gave it. */
  headRepoRef: string | null;
  /** The head lives in a fork that exists but that the forge will not show ryph (GitLab answers
   * a private fork the account is no member of 404). Worked like any fork, from the base repo's
   * change request ref; never pushed to. Absent otherwise. */
  headRepoHidden?: boolean;
  /** Whether the head lives in the base repo itself, as the forge decided it by identity
   * (GitLab's project ids). Present, it is the answer: the connected repo's address is the one it
   * was connected under, which a rename or a transfer leaves behind. Absent where the address is
   * the identity, and the addresses are compared. */
  sameRepo?: boolean;
  /** The head repo's own default branch: for a fork, the one branch of it ryph never pushes
   * onto. Absent where the forge has no forks. */
  headRepoDefaultBranch?: string | null;
  /** The author lets the base repo's maintainers push to the branch (GitHub's "Allow edits from
   * maintainers"). Absent where the forge has no such switch. */
  maintainerCanModify?: boolean;
  /** The base repo's default branch as the forge reports it at read time — checked live,
   * because the connected repo's record of it is as old as the connection. */
  defaultBranch: string;
}

/**
 * A Radicle repository's identity document as the boundary read it, plus what it means for this
 * deployment — the connect flow's whole answer. Delegates are Radicle's version of write
 * access; `isAllowed` is whether our node may fetch a private repo at all; and the two commands
 * are what a human may have to paste to make the rest work.
 */
export interface RadicleRepoInfo {
  rid: string;
  name: string;
  description: string;
  defaultBranch: string;
  delegates: string[];
  threshold: number;
  visibility: "public" | "private";
  allow: string[];
  self: { did: string; nid: string; alias: string | null };
  isDelegate: boolean;
  isAllowed: boolean;
}

/**
 * What seeding a repository answers when the node came back with no identity document.
 *
 * One answer for two situations the Radicle wire cannot tell apart — a private repository whose
 * allow list ryph is not on refuses the fetch at the responding node and is kept out of every
 * inventory announcement, so it is indistinguishable from a repository nobody is offering. The
 * shape carries both readings: the command that fixes the first, and `seeds`, the only evidence
 * that somebody does hold it.
 */
export interface RadicleRepoUnavailable {
  kind: "unavailable";
  rid: string;
  /** ryph's own DID — the one a delegate would have to add to the allow list. */
  did: string;
  /** `rad id update --allow <did>`, ready to paste. */
  command: string;
  /** Peers the routing table claims hold it; null when the node could not be asked. */
  seeds: number | null;
  /** How many of those the node was CONNECTED to and actually asked — see the bridge's port.
   * The routing COUNT alone cannot tell "somebody who has it refused us" from "nobody who has
   * it was reachable", and only the first reading means "probably private". */
  triedSeeds: number;
  /** The node's own words for why the fetch produced nothing. */
  reason: string;
}

/**
 * A user-mode bridge refused to seed a repository its owner's node explicitly BLOCKS
 * (`rad block`): their decision about their own node, which ryph neither overrides nor touches.
 * `command` lifts it; `reason` says so in a sentence fit to show.
 */
export interface RadicleRepoBlocked {
  kind: "blocked";
  rid: string;
  command: string;
  reason: string;
}

export type RadicleSeedOutcome =
  | { kind: "seeded"; repo: RadicleRepoInfo }
  | RadicleRepoUnavailable
  | RadicleRepoBlocked;

/** This deployment's own Radicle identity — who ryph is on the network. */
export interface RadicleIdentity {
  did: string;
  nid: string;
  alias: string | null;
  node: { running: boolean; sessions: number } | null;
}

/**
 * How this deployment acts on GitHub: as an App installed on accounts (a networked deployment
 * serving a team), or as ONE person through their token (the binary). Never both. In user mode
 * every ryph user acts as `login` on GitHub. `signIn` says whether people can sign in through the
 * App: only where the forge holds its OAuth client (RYPH_GITHUB_CLIENT_ID and _SECRET).
 */
export type GithubMode = { mode: "app"; signIn: boolean } | { mode: "user"; login: string };

/**
 * How this deployment acts on GitHub, as the control plane learns it from the forge — cached,
 * re-read on a slow clock (adapters/forge/github_mode.ts).
 */
export interface GithubModeSource {
  /**
   * The last answer, without waiting — `undefined` while the forge has never answered. Starts a
   * re-read in the background when the answer is due one. For the synchronous questions (which
   * sign-in providers to offer); everything that can wait uses `get`.
   */
  current(): GithubMode | null | undefined;
  /** The mode, asked of the forge when not known or due a re-read. Throws only when the forge
   * has never answered at all. */
  get(): Promise<GithubMode | null>;
}

/** Which forges the boundary runs, and — when GitHub is one — as whom it acts there. */
/**
 * How the Radicle bridge acts: as the deployment's own node and key, or — `user` — as one
 * person's own identity, which every write on a repository connected through it is signed as.
 */
export type RadicleMode = { mode: "deployment" } | { mode: "user" };

/**
 * How this deployment acts on GitLab — one instance, at `url`: as a bot user (`bot`, a networked
 * deployment: webhooks, sign-in through the GitLab OAuth application) or as ONE person (`user`,
 * the binary: no webhooks, merges polled, nobody signs in). `login` is the account every write
 * appears as.
 */
export interface GitlabMode {
  mode: "bot" | "user";
  /** The token's username as the forge read it at boot — display only. */
  login: string;
  /** The token's account, `<id>@<url>`: what user mode asks permissions about. */
  accountId: string;
  /** `RYPH_GITLAB_URL` as the forge normalized it: no trailing slash, any path prefix kept. */
  url: string;
  /** Whether people can sign in through GitLab: a bot with an OAuth application configured. */
  signIn: boolean;
}

export interface ForgeProviders {
  providers: ForgeProvider[];
  /** Null exactly when "github" is not in `providers`. */
  github: GithubMode | null;
  /** Null exactly when "gitlab" is not in `providers`. */
  gitlab: GitlabMode | null;
  /** Null exactly when "radicle" is not in `providers`. */
  radicle: RadicleMode | null;
}

export interface Forge {
  /**
   * Which forges this deployment can act on, and in which mode it acts on GitHub. Asked rather
   * than configured, because the answer is the boundary's: it is the side that holds a GitHub
   * App, a user token or a Radicle bridge, and a connect flow offered for a forge with no
   * adapter is a form that cannot work.
   *
   * THROWS when the forge does not answer. There is no safe guess: any list would offer (or
   * hide) a provider on the strength of nothing, so the caller says the forge is unreachable.
   */
  providers(): Promise<ForgeProviders>;
  /**
   * Deliver the bundle as a change request on the repo's own forge — open it, or ADOPT the open
   * one that already exists for this head branch. Idempotent on (repo, headSha): the
   * implementation must find an existing change for the branch and return it rather than open a
   * second — the dangerous failure is "it was opened and the response was lost", and the naive
   * retry double-opens on every blip.
   *
   * With `submission.changeRequest`, update that change request instead — on GitHub a
   * fast-forward push onto its branch, re-checked at push time — and answer with it. A re-push
   * of the same head is a no-op, so the same retry safety holds.
   */
  submitPatch(submission: PatchSubmission): Promise<SubmitOutcome>;
  /**
   * Which git hook files a `local` patch would change, measured exactly as its live diff is
   * (`PatchDiffAsk` with `mode: "live"`): asked before a local patch may be delivered, because
   * a hook file the owner checks out runs on their computer. Never throws.
   */
  checkPatchHooks(repo: ForgeRepoRef, url: string, ask: PatchDiffAsk): Promise<PatchHooksOutcome>;
  /** Deliver a written account to a thread. Best-effort at call sites. Returns the forge's
   * id for the new comment — what `updateComment` edits by. With `runId`, the body may carry
   * that run's agent's image refs, which the forge renders (core/image_refs.ts). */
  postComment(
    repo: ForgeRepoRef,
    thread: ForgeThreadRef,
    body: string,
    runId?: string,
  ): Promise<{ commentId: string }>;
  /** Rewrite a delivered comment in place — one progress comment, edited, never a stream.
   * `runId` as `postComment`'s. */
  updateComment(repo: ForgeRepoRef, commentId: string, body: string, runId?: string): Promise<void>;
  /** React to a comment — the instant "seen" before any run exists. Idempotent: a duplicate
   * reaction is a success, which is what makes blind retries safe. */
  addReaction(repo: ForgeRepoRef, commentId: string, reaction: "eyes"): Promise<void>;
  /**
   * Read a whole thread — the opening post and every comment, review and inline remark on
   * it. This is what makes `/ryph ada fix this` answerable: "this" lives in the thread,
   * not in the comment that names the agent.
   *
   * Returns a VALUE, never value-or-throw, for the same reason `checkPermission` does: the
   * caller must be able to act on "we could not read it" without unwrapping an exception.
   * `"gone"` is the thread being deleted or hidden, `"unavailable"` the forge not answering
   * — the first is final, the second is worth a redelivery, and collapsing them would either
   * retry a deletion forever or drop a command on a blip.
   *
   * With `opts.images` the thread's images ride along; one that could not be had is an
   * `omitted` value, never a failed read.
   */
  fetchThread(
    repo: ForgeRepoRef,
    thread: ForgeThreadRef,
    opts?: ForgeThreadReadOptions,
  ): Promise<ForgeThreadOutcome>;
  /**
   * A change request's head as it stands now, and nothing else: the lean read a push's checks
   * are decided on (`change_request.pushed`). A value, never a throw, as `fetchThread`: `gone`
   * is final, `unavailable` worth a redelivery.
   */
  fetchChangeRequestHead(repo: ForgeRepoRef, ref: string): Promise<ChangeRequestHeadOutcome>;
  /**
   * Which of `heads` — the heads ryph pushed onto a change request — its merge contained: each
   * that one of `mergedHeads` (`InboundForgeEvent.merged.heads`, or
   * `ForgeChangeRequestState.mergedHeads` on a poll) holds by `MergeContainmentOutcome`'s rule,
   * its own work read as its change since the base it was built on (`bases[head]`, the patch
   * row's `baseSha`), and a merged head's as its change since it left `into` (the branch the
   * merge went into, as the forge named it: the merge record's `mergedInto`), where named. One
   * call per merge. `url` is the connected repo's, as `ryphBase` takes it. A value, never a
   * throw: see `MergeContainmentOutcome`.
   */
  mergeContainment(
    repo: ForgeRepoRef,
    url: string,
    mergedHeads: string[],
    heads: string[],
    bases: Record<string, string>,
    into: string | undefined,
  ): Promise<MergeContainmentOutcome>;
  /**
   * A newborn patch's lineage (`POST /v1/service/patch-lineage`): which of the run's other lines
   * it holds commits of, and whether it holds the tip its line merged at. Asked at birth
   * (core/open_patch.ts), so that neither rests on the runner's word. A value, never a throw:
   * see `PatchLineageOutcome`.
   */
  patchLineage(repo: ForgeRepoRef, url: string, ask: PatchLineageAsk): Promise<PatchLineageOutcome>;
  /**
   * Does this identity have at least this access to the repo? Live, briefly cacheable, never
   * mirrored. Two thresholds, from the design's rules: connect a repo → "admin" on it;
   * launch a task → "write" on it. An identity linked on another forge than the repo's is a
   * definitive "denied": access is per forge, and there is nothing to ask.
   *
   * `identity.subject` may be null — "there is no identity" — and the verdict is then the
   * provider's answer to "may anybody at all?". Only Radicle's `write` on a public repo says
   * yes to that; everything else denies. See `ForgeSubject.subject`.
   */
  checkPermission(
    repo: ForgeRepoRef,
    identity: ForgeSubject,
    atLeast: "write" | "admin",
  ): Promise<ForgePermission>;
  /**
   * The repo's service declaration at `ref`, or why there is none. Never throws, for
   * `checkPermission`'s reason: this is asked on the LAUNCH path, and "the forge did not answer"
   * has to arrive as a value the caller can refuse the task on.
   *
   * No path argument, and there will not be one: the file is fixed on the other side. See
   * ports/forge.ts's opening note — every method here is a question or a delivery, and "read me
   * any file out of any connected repo" is neither.
   */
  readServicesFile(repo: ForgeRepoRef, url: string, ref: string): Promise<ServicesFile>;
  /**
   * Whether the repo is public or private on its forge, read live. Asked by the chat door: a
   * public channel may only command work on public repos, because whatever the agent posts
   * there is published. Never throws — an unanswerable question is "unknown", which the caller
   * refuses on, and never a guess either way.
   */
  repoVisibility(repo: ForgeRepoRef): Promise<ForgeRepoVisibility>;

  // Environments. All three are answered out of the forge's repo cache (never a forge API, so
  // they are exactly as available as a clone), take the connected repo's `url` as
  // `readServicesFile` does, and THROW when the forge could not answer: none of them is on a
  // path where "we could not ask" has a safe default, so the caller decides what to do then.

  /**
   * The `.ryph/` tree id at a commit id or a branch name. A commit is fetched by id when the
   * cache does not hold it; a branch is fetched and resolved to its head, which `commit` then
   * names.
   */
  ryphTree(repo: ForgeRepoRef, url: string, commitOrRef: string): Promise<RyphTree>;
  /**
   * The `.ryph/` tree at the merge base of `head` (a commit id) and the `base` branch, and what
   * the head changed under `.ryph/` since: whether a branch whose `.ryph/` differs from the
   * default branch's changed it, or only fell behind a default branch that did.
   */
  ryphBase(repo: ForgeRepoRef, url: string, head: string, base: string): Promise<RyphBase>;
  /** The default branch's name and head, read off the upstream — never off the connected repo's
   * row, which is as old as the connection. */
  defaultBranchHead(repo: ForgeRepoRef, url: string): Promise<DefaultBranchHead>;
  /** Whether `ref` is the default branch, one of the repo's own branches, or somebody else's —
   * see `ForgeBranchKind`. */
  branchKind(repo: ForgeRepoRef, url: string, ref: string): Promise<ForgeBranchKind>;
}

/** Three-valued for `checkPermission`'s reason: "public", "private", and "we could not ask". */
export type ForgeRepoVisibility = "public" | "private" | "unknown";

/**
 * Radicle's own connect surface, kept OFF `Forge` for the reason `GithubConnect` is: seeding, an
 * identity document and a node's DID are Radicle's concepts and GitHub has no counterpart to
 * any of them. Wired only where a bridge is configured, and dialed only by the connect flow.
 */
export interface RadicleConnect {
  /** Who ryph is on the Radicle network. */
  radicleIdentity(): Promise<RadicleIdentity>;
  /** The repository's identity document, read live from our node's verified storage. Null when
   * this node holds no such repository; throws when it could not be asked. */
  describeRadicleRepo(repoRef: string): Promise<RadicleRepoInfo | null>;
  /**
   * Seed with scope `all` — the one scope under which a stranger's `/ryph` comment reaches us
   * — and fetch once. Answers the document the fetch produced, or `unavailable` when the node
   * came back with nothing even after asking the network. Throws when it could not be asked.
   */
  seedRadicleRepo(repoRef: string): Promise<RadicleSeedOutcome>;
  /** Stop seeding. Idempotent, and best-effort at call sites: a disconnect stands whether or
   * not the node let go. */
  unseedRadicleRepo(repoRef: string): Promise<void>;
}

/** Why the forge would not take a path as a local repository — its words, one per rule. */
export type LocalRepoRefusalReason =
  | "not_absolute"
  | "outside_root"
  | "not_found"
  | "not_directory"
  | "not_a_repository"
  | "linked_worktree"
  | "bare_repository"
  | "no_default_branch";

/**
 * What describing a path as a local repository answers. `described` carries the canonical
 * coordinates the row is built from — never the caller's spelling of the path. `refused` is
 * the forge's verdict on the path, its message safe to hand the caller; on an `outside_root`
 * it carries `root`, the allowed root's real path, so the person connecting is told where
 * repositories CAN be. `unsupported` is a forge with no local provider at all: a deployment
 * question, not a path one.
 */
export type LocalRepoDescription =
  | { kind: "described"; repoRef: string; url: string; defaultBranch: string }
  | { kind: "refused"; reason: LocalRepoRefusalReason; error: string; root?: string }
  | { kind: "unsupported" };

/**
 * The `local` forge's connect surface, kept OFF `Forge` for the reason the other two are: "is
 * this path on your disk a repository I may read" is a question only that provider has. Wired
 * beside the forge, and dialed only by the connect flow.
 */
export interface LocalConnect {
  /** Validate `path` as a local repository — the forge reads the disk, so the forge decides —
   * and answer its canonical address and default branch. Throws when the forge could not be
   * asked or answered something that is none of the three. */
  describeLocalRepo(path: string): Promise<LocalRepoDescription>;
}

/**
 * GitHub's connect surface in USER mode (`GithubMode` "user"): no installation, so the repos are
 * whatever the token's owner can reach. Kept off `Forge` for `GithubConnect`'s reason, and
 * wired beside it; a forge in App mode (or with no GitHub) answers 501 to both, which arrives
 * here as a throw — the connect routes ask the mode first and never dial these outside it.
 */
export interface GithubUserConnect {
  /** Every repo the token's owner owns, collaborates on or reaches through an org membership.
   * Throws when the forge could not answer. */
  listGithubRepos(): Promise<GithubRepoListing[]>;
  /** One repo as GitHub spells it (`fullName` in GitHub's own case), read live. Null when
   * GitHub says there is no such repo the token can see; throws when it could not be asked. */
  describeGithubRepo(repoRef: string): Promise<RepoListing | null>;
}

/**
 * GitHub's own connect surface, kept OFF `Forge` for the reason the forge package keeps it off
 * `ForgeApi`: installations and OAuth are not a forge's concepts, they are GitHub's. Wired only
 * where a GitHub App is configured, and dialed only by the connect flow.
 */
export interface GithubConnect {
  /** Where the installation is managed on GitHub, read live. Throws if the forge cannot say. */
  getInstallationSettingsUrl(installationId: string): Promise<string>;
  /** The installation's account, where it is managed (null when GitHub named no page) and the
   * repos it grants — registration and the connect-repo picker in one question. */
  describeInstallation(
    installationId: string,
  ): Promise<{ accountLogin: string; settingsUrl: string | null; repos: RepoListing[] }>;
  /** Exchange an OAuth authorization code for the identity behind it. Throws when the forge
   * refuses the code: this is a sign-in, and "try again" is the only answer either way. */
  exchangeOAuthCode(code: string): Promise<ForgeIdentity>;
  /**
   * Whether `login` is a member of the org (or is the user) an installation sits on. Never
   * throws, for `checkPermission`'s reason: a sign-up gate must tell "not a member" from
   * "could not ask".
   */
  checkOrgMembership(installationId: string, login: string): Promise<ForgeOrgMembership>;
}

/** One GitLab project as the connect flow sees it (the forge's `GitlabProjectListing`). */
export interface GitlabProjectListing {
  /** GitLab's numeric project id, as text — what the webhook URL and token are bound to. */
  id: string;
  /** `path_with_namespace`: the connected repo's `repoRef`. */
  pathWithNamespace: string;
  /** `http_url_to_repo`: the connected repo's `url`. */
  url: string;
  webUrl: string;
  /** Null for an empty project. */
  defaultBranch: string | null;
  visibility: "public" | "internal" | "private";
  /** Whether the forge's token holds Maintainer or above on it. */
  admin: boolean;
}

/**
 * GitLab's connect surface, kept OFF `Forge` for `GithubConnect`'s reason: projects reached by a
 * bot, and per-project webhook tokens, are GitLab's concepts. Wired beside the forge; every
 * method THROWS when the forge could not answer (including its 501 where no GitLab runs).
 */
export interface GitlabConnect {
  /** The projects the forge's token reaches — the bot's reach, or in user mode the person's. */
  listGitlabProjects(): Promise<GitlabProjectListing[]>;
  /** One project by numeric id — or, connecting it, the path a person just chose — read live.
   * Null when GitLab says there is no such project this token can see. */
  describeGitlabProject(project: string): Promise<GitlabProjectListing | null>;
  /** An account's username as GitLab spells it NOW, by its account id (`<id>@<url>`): for
   * naming a person in text, never for deciding anything. Null when GitLab has no such user. */
  gitlabLogin(accountId: string): Promise<string | null>;
  /** The `X-Gitlab-Token` the project's webhook must carry at its token generation
   * (`GitlabProject.hookGeneration`) — shown to a Maintainer only. */
  gitlabHookToken(projectId: string, generation: number): Promise<string>;
}

/** The forges a person signs in and links an identity through. */
export type SignInForge = "github" | "gitlab";

/** What GitLab's OAuth needs again on the token leg: the authorize leg's redirect URI (GitLab
 * requires it on both) and its PKCE verifier. GitHub's leg takes neither. */
export interface OAuthLeg {
  redirectUri: string;
  codeVerifier: string | null;
}

/**
 * Sign-in and the sign-up gate, keyed by forge — `GithubConnect.exchangeOAuthCode` and
 * `checkOrgMembership` generalized, so `adapters/identity_provider/forge.ts` can serve GitHub and
 * GitLab from one surface.
 */
export interface ForgeConnect {
  /** Exchange a sign-in's code on `provider`. Throws when the forge refuses it. `leg` is
   * required for GitLab and ignored for GitHub. */
  exchangeForgeOAuthCode(
    provider: SignInForge,
    code: string,
    leg: OAuthLeg | null,
  ): Promise<ForgeIdentity>;
  /**
   * Whether this person may sign up. GitHub: `who` is a login, a member of the org
   * `installationId` sits on. GitLab: `who` is the ACCOUNT ID sign-in answered (`<id>@<url>`),
   * never a username, a member of the forge's `RYPH_GITLAB_GROUP` (`installationId` ignored), or
   * "no-organization" where none is configured. Never throws: "could not ask" is "unknown".
   */
  checkForgeMembership(
    provider: SignInForge,
    who: string,
    installationId: string | null,
  ): Promise<ForgeOrgMembership | "no-organization">;
}

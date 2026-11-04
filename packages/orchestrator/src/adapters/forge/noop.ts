// A "noop" `Forge` for development and tests: nothing is dialed, everything is recorded —
// the same precedent as the manual provisioner. Submissions "succeed" with a fake change ref
// so the whole patch lifecycle exercises end to end with no forge anywhere; permission checks
// answer a configurable verdict (default "allowed") so the creation gate is drivable too.
//
// It also stands in for GitHub's connect surface, so a dev deployment can register an
// installation and link an identity without an App.

import type {
  BranchHeadOutcome,
  ChangeRequestHeadOutcome,
  CheckBundleAsk,
  CheckReport,
  ChecksFile,
  DefaultBranchHead,
  Forge,
  ForgeBranchKind,
  ForgeChecks,
  ForgeOrgMembership,
  ForgePatchDiffs,
  ForgePermission,
  ForgeRepoRef,
  ForgeRepoVisibility,
  ForgeSkills,
  ForgeThreadContext,
  ForgeThreadOutcome,
  GithubConnect,
  GithubMode,
  GithubUserConnect,
  GitlabMode,
  LocalConnect,
  LocalRepoDescription,
  MergeContainmentOutcome,
  PatchDiffAsk,
  PatchDiffOutcome,
  PatchHooksOutcome,
  PatchLineageAsk,
  PatchLineageOutcome,
  PatchSubmission,
  RadicleConnect,
  RadicleMode,
  RadicleRepoInfo,
  RadicleSeedOutcome,
  RepoListing,
  ReportChecksOutcome,
  RyphBase,
  RyphTree,
  ServicesFile,
  SkillsTree,
  StageCheckBundleOutcome,
  SubmitOutcome,
} from "../../ports/forge.ts";
import type { ForgeProvider } from "../../core/types.ts";
import { localBundleKey } from "../../core/check_types.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";

export interface NoopForge
  extends
    Forge,
    GithubConnect,
    GithubUserConnect,
    RadicleConnect,
    LocalConnect,
    ForgeChecks,
    ForgePatchDiffs,
    ForgeSkills {
  /** Every path asked about as a local repository, in order. */
  readonly localDescribed: string[];
  /** Every repo described in GitHub user mode, in order. */
  readonly githubDescribed: string[];
  /** Every RID seeded and unseeded, in order — the connect flow's window in a test. */
  readonly seeded: string[];
  readonly unseeded: string[];
  /** Every submission delivered, in order — the test's and the operator's window. */
  readonly submissions: PatchSubmission[];
  readonly comments: Array<
    { commentId: string; repoRef: string; thread: string; body: string }
  >;
  /** `runId` when the body carries a run's agent text, which the real forge renders. */
  readonly commentUpdates: Array<
    { commentId: string; repoRef: string; body: string; runId?: string }
  >;
  readonly reactions: Array<{ commentId: string; repoRef: string; reaction: string }>;
  /** Every check report delivered, in order. */
  readonly checkReports: Array<{ repoRef: string; report: CheckReport }>;
  /** Every check bundle staged, in order, with what it carried. */
  readonly checkBundles: Array<{ repoRef: string; ask: CheckBundleAsk; bytes: Uint8Array }>;
  /**
   * The git hook files every `local` patch is taken to touch — the pre-check answers them, and a
   * submission whose `approvedHookPaths` misses any is `held`, as the real forge's gate. Empty by
   * default; a test pushes onto it (or replaces its contents) to drive the hold.
   */
  readonly hookFiles: string[];
  /** Every hook pre-check asked, in order. */
  readonly hookChecks: Array<{ repoRef: string; ask: PatchDiffAsk }>;
  /** Every containment question asked, in order. */
  readonly containmentAsks: Array<
    {
      repoRef: string;
      mergedHeads: string[];
      heads: string[];
      bases: Record<string, string>;
      into?: string;
    }
  >;
  /** Every lineage question asked, in order. */
  readonly lineageAsks: PatchLineageAsk[];
}

/** An even installation id sits on a person's account, an odd one on an org, so a playground
 * exercises both of GitHub's settings pages. */
function noopSettingsUrl(installationId: string): string {
  const id = encodeURIComponent(installationId);
  const last = installationId.charCodeAt(installationId.length - 1);
  return Number.isNaN(last) || last % 2 === 0
    ? `https://github.com/settings/installations/${id}`
    : `https://github.com/organizations/${
      encodeURIComponent(`noop-account-${installationId}`)
    }/settings/installations/${id}`;
}

export function noopForge(
  diag: Diagnostics,
  opts: {
    permission?: ForgePermission;
    /** What every membership check answers. Default "member", so a dev sign-up flow passes. */
    membership?: ForgeOrgMembership;
    /** An entry's `admin` is what the user-mode listing says of it — true when absent. */
    repos?: Array<RepoListing & { admin?: boolean }>;
    /** What `fetchThread` answers. Default: a plausible one-comment thread, so a dev flow
     * exercises the quoting and framing rather than skipping it. */
    thread?: ForgeThreadOutcome | ((threadRef: string) => ForgeThreadOutcome);
    /** What `fetchChangeRequestHead` answers. Default: an open change request whose head is
     * all zeroes, as the canned thread's is. */
    changeRequestHead?: (ref: string) => ChangeRequestHeadOutcome;
    /** What `mergeContainment` answers. Default: every asked head contained — a stand-in has
     * no history to ask, and a test that judges containment drives it from here. */
    mergeContainment?: (
      ask: {
        repo: ForgeRepoRef;
        mergedHeads: string[];
        heads: string[];
        bases: Record<string, string>;
        into?: string;
      },
    ) => MergeContainmentOutcome | Promise<MergeContainmentOutcome>;
    /** What `patchLineage` answers. Default: no overlap, and the tip held — a stand-in has no
     * bundles to read, and a test that judges lineage drives it from here. */
    patchLineage?: (ask: PatchLineageAsk) => PatchLineageOutcome | Promise<PatchLineageOutcome>;
    /**
     * What every repo is taken to declare. "absent" by default and not "unavailable": with no
     * forge there is no cache to be down, and a dev deployment must not have every task refused
     * for a file nobody wrote. A test that wants the services path drives it from here.
     */
    servicesFile?: ServicesFile;
    /** What every patch diff answers. Default: unavailable — no bundle is held here to diff. */
    patchDiff?: (ask: PatchDiffAsk) => PatchDiffOutcome;
    /** The initial `hookFiles` (see NoopForge). */
    hookFiles?: string[];
    /** What the hook pre-check answers, overriding the `hookFiles` model — `unavailable`, say. */
    patchHooks?: (repo: ForgeRepoRef, ask: PatchDiffAsk) => PatchHooksOutcome;
    /** Which forges this stand-in claims to run. GitHub and Radicle, so a dev deployment can
     * drive the Radicle connect flow with no node anywhere — not `local`, which reads a disk
     * this stand-in never looks at. */
    providers?: ForgeProvider[];
    /** How this stand-in acts on GitHub, when `providers` names it. App mode by default — it
     * stands in for an App's connect surface (installations, OAuth) — and a test drives user
     * mode from here. Ignored when GitHub is not among the providers: the answer is then null. */
    github?: GithubMode;
    /** How this stand-in acts on GitLab, when `providers` names it — a bot by default. Ignored
     * when GitLab is not among the providers. */
    gitlab?: GitlabMode;
    /** How the Radicle stand-in acts, when `providers` names it. A deployment's bridge unless a
     * test says user mode. Ignored when Radicle is not among the providers. */
    radicle?: RadicleMode;
    /** Every seed answers that the owner's node blocks the repository (a user-mode bridge). */
    radicleBlocked?: boolean;
    /** What describing a GitHub repo in user mode answers. By default the repo from `repos`
     * whose name matches case-blind, else null — GitHub's 404. */
    githubRepo?: (repoRef: string) => RepoListing | null;
    /** What describing a path as a local repository answers. `unsupported` by default, for the
     * reason `providers` leaves `local` out. */
    localRepo?: (path: string) => LocalRepoDescription;
    /** The identity document every Radicle repo is taken to have. Null: the node came back
     * with nothing, which is the refusal a connect flow answers with a command. */
    radicleRepo?: RadicleRepoInfo | null;
    /**
     * `RYPH_RADICLE_EXPLORER_URL` as a Radicle deployment would set it. UNSET by default, and
     * that is the honest default: Radicle has no canonical explorer, so a submitted change has
     * no web address and `SubmitOutcome.url` is null.
     */
    radicleExplorerUrl?: string;
    /** What every visibility check answers, or a function of the repo's address. "private" by
     * default — the answer that refuses a public channel, so a dev deployment never publishes
     * by assumption. */
    visibility?: ForgeRepoVisibility | ((repoRef: string) => ForgeRepoVisibility);
    /**
     * The environment reads. By default every repo sits on `main` at an all-zero commit with no
     * `.ryph/` directory, and every branch but `main` is the repo's own — the no-config repo, so
     * a dev deployment builds nothing it was not asked to. A test drives them from here.
     */
    ryphTree?: (repo: ForgeRepoRef, commitOrRef: string) => RyphTree;
    /** Where a head's `.ryph/` came from. By default no shared history (a null merge base), so a
     * branch whose `.ryph/` differs is taken to have changed it. */
    ryphBase?: (repo: ForgeRepoRef, head: string, base: string) => RyphBase;
    defaultBranchHead?: (repo: ForgeRepoRef) => DefaultBranchHead;
    branchKind?: (repo: ForgeRepoRef, ref: string) => ForgeBranchKind;
    /** What every repo's `.ryph/checks.yml` reads as. By default absent at the commit `ryphTree`
     * answers — no checks, so a dev deployment runs none it was not asked to. */
    checksFile?: ChecksFile | ((repo: ForgeRepoRef, commitOrRef: string) => ChecksFile);
    /** What a check report answers. By default every check is reported under a made-up id. */
    reportChecks?: (repo: ForgeRepoRef, report: CheckReport) => ReportChecksOutcome;
    /**
     * What the org skills repo's `.agents/skills/` reads as. `unavailable` by default: with no
     * forge nothing was read, and an empty version would claim the repo holds no skills. A test
     * drives the sync from here.
     */
    skillsTree?: (
      repo: ForgeRepoRef,
      commitOrRef: string,
      knownTree: string | null,
    ) => SkillsTree | Promise<SkillsTree>;
    /** What a check bundle answers. By default it is kept under the key the forge would file
     * it at, its head the SHA-1 of its bytes: nothing here can read a bundle. */
    checkBundle?: (ask: CheckBundleAsk, bytes: Uint8Array) => StageCheckBundleOutcome;
    /** What a branch's live head reads as. By default absent: nothing here knows a branch. */
    branchHead?: (repo: ForgeRepoRef, branch: string) => BranchHeadOutcome;
  } = {},
): NoopForge {
  const submissions: PatchSubmission[] = [];
  const hookFiles: string[] = [...(opts.hookFiles ?? [])];
  const hookChecks: Array<{ repoRef: string; ask: PatchDiffAsk }> = [];
  const containmentAsks: NoopForge["containmentAsks"][number][] = [];
  const lineageAsks: PatchLineageAsk[] = [];
  /** The hook pre-check's answer for a local patch, as the forge's: sorted, at most 50. */
  const hookAnswer = () => {
    const all = [...hookFiles].sort();
    return { touched: all.slice(0, 50), hooksPaths: [".git/hooks"], more: all.length > 50 };
  };
  const comments: Array<
    { commentId: string; repoRef: string; thread: string; body: string }
  > = [];
  const commentUpdates: NoopForge["commentUpdates"][number][] = [];
  const reactions: Array<{ commentId: string; repoRef: string; reaction: string }> = [];
  const checkReports: Array<{ repoRef: string; report: CheckReport }> = [];
  const checkBundles: Array<{ repoRef: string; ask: CheckBundleAsk; bytes: Uint8Array }> = [];
  const seeded: string[] = [];
  const unseeded: string[] = [];
  const localDescribed: string[] = [];
  const githubDescribed: string[] = [];
  /** A repo as a plain listing — the four fields, never the user-mode `admin` bit. */
  const listingOf = (r: RepoListing): RepoListing => ({
    fullName: r.fullName,
    url: r.url,
    defaultBranch: r.defaultBranch,
    private: r.private,
  });
  const NOOP_DID = "did:key:z6MkireRatUThvd3qzfKht1S44wpm4FEWSSa4PRMTSQZ3voM";
  const NOOP_COMMIT = "0".repeat(40);
  const radicleRepo = (rid: string): RadicleRepoInfo => ({
    rid,
    name: "noop",
    description: "a repository the noop forge invented",
    defaultBranch: "main",
    delegates: [NOOP_DID],
    threshold: 1,
    visibility: "public",
    allow: [],
    self: { did: NOOP_DID, nid: "z6Mkire", alias: "ryph" },
    isDelegate: true,
    isAllowed: true,
  });
  /**
   * Where a change request would be READ, or null.
   *
   * Radicle has no canonical web host: a deployment with no explorer template configured has
   * no web address for a change request at all, and `SubmitOutcome.url` is null the whole way
   * down for it. A stand-in that always invented a link would leave the null path — the one a
   * Radicle deployment actually takes — untested everywhere the noop is used.
   */
  const changeUrl = (repo: ForgeRepoRef, ref: string): string | null => {
    if (repo.provider === "github") return `https://forge.invalid/${repo.repoRef}/pull/${ref}`;
    // A branch in a repository on disk has no web page — the real forge answers null too.
    if (repo.provider === "local") return null;
    const template = opts.radicleExplorerUrl ?? null;
    if (template === null) return null;
    return template.replaceAll("{rid}", repo.repoRef).replaceAll("{kind}", "patches")
      .replaceAll("{id}", ref);
  };

  let prCounter = 0;
  let commentCounter = 0;

  return {
    submissions,
    hookFiles,
    hookChecks,
    containmentAsks,
    lineageAsks,
    comments,
    commentUpdates,
    reactions,
    checkReports,
    checkBundles,
    seeded,
    unseeded,
    localDescribed,
    githubDescribed,
    describeLocalRepo(path) {
      localDescribed.push(path);
      return Promise.resolve(opts.localRepo?.(path) ?? { kind: "unsupported" });
    },
    providers() {
      const providers = opts.providers ?? ["github", "radicle"];
      return Promise.resolve({
        providers,
        github: providers.includes("github")
          ? (opts.github ?? { mode: "app", signIn: true })
          : null,
        gitlab: providers.includes("gitlab")
          ? (opts.gitlab ??
            {
              mode: "bot",
              login: "ryph-bot",
              accountId: "1@https://gitlab.invalid",
              url: "https://gitlab.invalid",
              signIn: true,
            })
          : null,
        radicle: providers.includes("radicle") ? (opts.radicle ?? { mode: "deployment" }) : null,
      });
    },
    listGithubRepos() {
      return Promise.resolve(
        (opts.repos ?? []).map((r) => ({ ...listingOf(r), admin: r.admin ?? true })),
      );
    },
    describeGithubRepo(repoRef) {
      githubDescribed.push(repoRef);
      const found = opts.githubRepo
        ? opts.githubRepo(repoRef)
        : (opts.repos ?? []).find((r) => r.fullName.toLowerCase() === repoRef.toLowerCase()) ??
          null;
      return Promise.resolve(found === null ? null : listingOf(found));
    },
    radicleIdentity() {
      return Promise.resolve({
        did: NOOP_DID,
        nid: "z6Mkire",
        alias: "ryph",
        node: { running: true, sessions: 0 },
      });
    },
    describeRadicleRepo(repoRef) {
      return Promise.resolve(
        opts.radicleRepo === undefined ? radicleRepo(repoRef) : opts.radicleRepo,
      );
    },
    seedRadicleRepo(repoRef): Promise<RadicleSeedOutcome> {
      seeded.push(repoRef);
      if (opts.radicleBlocked) {
        return Promise.resolve({
          kind: "blocked",
          rid: repoRef,
          command: `rad unblock ${repoRef}`,
          reason: `your Radicle node blocks ${repoRef}`,
        });
      }
      const doc = opts.radicleRepo === undefined ? radicleRepo(repoRef) : opts.radicleRepo;
      if (doc !== null) return Promise.resolve({ kind: "seeded", repo: doc });
      return Promise.resolve({
        kind: "unavailable",
        rid: repoRef,
        did: NOOP_DID,
        command: `rad id update --allow ${NOOP_DID}`,
        seeds: 0,
        triedSeeds: 0,
        reason: "the noop forge holds no repository and asked no network",
      });
    },
    unseedRadicleRepo(repoRef) {
      unseeded.push(repoRef);
      return Promise.resolve();
    },
    submitPatch(submission: PatchSubmission): Promise<SubmitOutcome> {
      // The forge's hook gate: a local patch touching a hook file nobody approved is held, and
      // nothing is pushed — so it is not a submission.
      if (submission.repo.provider === "local") {
        const approved = new Set(submission.approvedHookPaths);
        if (hookFiles.some((path) => !approved.has(path))) {
          return Promise.resolve({ kind: "held", ...hookAnswer() });
        }
      }
      submissions.push(structuredClone(submission));
      // Updating an existing change request: nothing is opened, and the answer is that one. A
      // local repository's "change request" is the branch itself, as the real forge answers.
      const ref = submission.changeRequest ??
        (submission.repo.provider === "local" ? submission.branchName : String(++prCounter));
      diag.debug("forge.noop.submitted", {
        repo: submission.repo.repoRef,
        branch: submission.branchName,
        ref,
      });
      return Promise.resolve({ kind: "submitted", ref, url: changeUrl(submission.repo, ref) });
    },
    postComment(repo, thread, body) {
      const commentId = `noop-comment-${++commentCounter}`;
      comments.push({ commentId, repoRef: repo.repoRef, thread: thread.ref, body });
      return Promise.resolve({ commentId });
    },
    updateComment(repo, commentId, body, runId) {
      commentUpdates.push({
        commentId,
        repoRef: repo.repoRef,
        body,
        ...(runId === undefined ? {} : { runId }),
      });
      return Promise.resolve();
    },
    addReaction(repo, commentId, reaction) {
      reactions.push({ commentId, repoRef: repo.repoRef, reaction });
      return Promise.resolve();
    },
    mergeContainment(repo, _url, mergedHeads, heads, bases, into) {
      const named = into === undefined ? {} : { into };
      containmentAsks.push({ repoRef: repo.repoRef, mergedHeads, heads, bases, ...named });
      if (opts.mergeContainment !== undefined) {
        return Promise.resolve(
          opts.mergeContainment({ repo, mergedHeads, heads, bases, ...named }),
        );
      }
      return Promise.resolve({ kind: "answered", contained: [...new Set(heads)], missed: [] });
    },
    patchLineage(_repo, _url, ask) {
      lineageAsks.push(ask);
      if (opts.patchLineage !== undefined) return Promise.resolve(opts.patchLineage(ask));
      return Promise.resolve({
        kind: "answered",
        overlaps: [],
        ...(ask.mustHold === undefined ? {} : { holdsTip: true }),
      });
    },
    fetchChangeRequestHead(_repo, ref) {
      if (opts.changeRequestHead !== undefined) {
        return Promise.resolve(opts.changeRequestHead(ref));
      }
      return Promise.resolve({
        kind: "head",
        head: {
          ref,
          state: "open",
          merged: false,
          headSha: "0".repeat(40),
          authorHeadSha: "0".repeat(40),
          baseRef: "main",
          openedByUs: false,
          mergedHeads: [],
        },
      });
    },
    fetchThread(repo, thread) {
      if (typeof opts.thread === "function") return Promise.resolve(opts.thread(thread.ref));
      if (opts.thread !== undefined) return Promise.resolve(opts.thread);
      const canned: ForgeThreadContext = {
        kind: thread.kind,
        ref: thread.ref,
        title: `A noop ${thread.kind === "issue" ? "issue" : "change request"}`,
        body: "This thread came from the noop forge — no GitHub was dialed.",
        authorLogin: "noop-author",
        createdAt: "2026-01-01T00:00:00.000Z",
        state: "open",
        entries: [{
          kind: "comment",
          authorLogin: "noop-commenter",
          body: "And this is what somebody said about it.",
          createdAt: "2026-01-01T01:00:00.000Z",
          state: null,
          location: null,
        }],
        truncated: false,
        // A same-repo branch that is open and not the default — the change request a command
        // can actually work on.
        changeRequest: thread.kind === "issue" ? null : {
          ref: thread.ref,
          url: `https://forge.invalid/${repo.repoRef}/pull/${thread.ref}`,
          state: "open",
          merged: false,
          headRef: `noop/pr-${thread.ref}`,
          headSha: "0".repeat(40),
          authorHeadSha: "0".repeat(40),
          baseRef: "main",
          headRepoRef: repo.repoRef,
          defaultBranch: "main",
        },
      };
      return Promise.resolve({ kind: "thread", thread: canned });
    },
    checkPermission(repo, identity, atLeast) {
      // The one rule this stand-in must not paper over: an identity is per forge, and one
      // linked on GitHub says NOTHING about a Radicle repository. The HTTP adapter refuses
      // that pairing before it asks anybody (`adapters/forge/http.ts`), and a dev deployment
      // whose noop said "allowed" to it would be a laxer boundary than production's.
      if (identity.provider !== repo.provider) return Promise.resolve("denied");
      // The other rule with real teeth: a NULL subject is "there is no identity". Only
      // Radicle's `write` is answerable without one (contribution to a public repo is
      // permissionless), and this stand-in has no identity document to read, so it answers
      // that tier as the public case. Everywhere else nobody is in no set — denied. Waving a
      // subjectless caller through here would let a dev deployment launch on a GitHub repo
      // that production refuses.
      if (identity.subject === null) {
        return Promise.resolve(
          repo.provider === "radicle" && atLeast === "write"
            ? (opts.permission ?? "allowed")
            : "denied",
        );
      }
      return Promise.resolve(opts.permission ?? "allowed");
    },
    getInstallationSettingsUrl(installationId) {
      return Promise.resolve(noopSettingsUrl(installationId));
    },
    describeInstallation(installationId) {
      return Promise.resolve({
        accountLogin: `noop-account-${installationId}`,
        settingsUrl: noopSettingsUrl(installationId),
        repos: (opts.repos ?? []).map(listingOf),
      });
    },
    readServicesFile() {
      return Promise.resolve(opts.servicesFile ?? { kind: "absent" });
    },
    checkPatchHooks(repo, _url, ask) {
      hookChecks.push({ repoRef: repo.repoRef, ask: structuredClone(ask) });
      if (opts.patchHooks) return Promise.resolve(opts.patchHooks(repo, ask));
      if (repo.provider !== "local") {
        return Promise.resolve({
          kind: "refused",
          message: "hook files are checked only for a repository on this machine",
        });
      }
      return Promise.resolve({ kind: "checked", ...hookAnswer() });
    },
    readPatchDiff(_repo, _url, ask) {
      if (opts.patchDiff) return Promise.resolve(opts.patchDiff(ask));
      // Not an empty diff: that would claim the patch changes nothing.
      return Promise.resolve({ kind: "unavailable", error: "the noop forge reads no diffs" });
    },
    readChecksFile(repo, _url, commitOrRef) {
      const c = opts.checksFile;
      if (typeof c === "function") return Promise.resolve(c(repo, commitOrRef));
      if (c !== undefined) return Promise.resolve(structuredClone(c));
      const commit = /^[0-9a-f]{40}$/.test(commitOrRef) ? commitOrRef : NOOP_COMMIT;
      return Promise.resolve({ kind: "absent", commit });
    },
    reportChecks(repo, report) {
      checkReports.push({ repoRef: repo.repoRef, report: structuredClone(report) });
      diag.debug("forge.noop.checks_reported", { repo: repo.repoRef, suite: report.suiteId });
      if (opts.reportChecks) return Promise.resolve(opts.reportChecks(repo, report));
      const refs = Object.fromEntries(
        report.checks.map((check) => [check.name, check.forgeRef ?? `noop-check-${check.name}`]),
      );
      return Promise.resolve({ kind: "reported", refs });
    },
    async readSkillsTree(repo, _url, commitOrRef, knownTree) {
      if (opts.skillsTree) {
        return structuredClone(await opts.skillsTree(repo, commitOrRef, knownTree));
      }
      return { kind: "unavailable", detail: "the noop forge reads no repo" };
    },
    readBranchHead(repo, _url, branch) {
      return Promise.resolve(opts.branchHead?.(repo, branch) ?? { kind: "absent" });
    },
    async stageCheckBundle(repo, _url, ask, body) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      checkBundles.push({ repoRef: repo.repoRef, ask: structuredClone(ask), bytes });
      if (opts.checkBundle) return opts.checkBundle(ask, bytes);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
      const headSha = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
      return {
        kind: "staged",
        headSha,
        bundleKey: await localBundleKey(
          ask.userId,
          ask.branchName,
          ask.baseRef,
          ask.connectedRepoId,
          headSha,
        ),
      };
    },
    repoVisibility(repo) {
      const v = opts.visibility;
      return Promise.resolve(typeof v === "function" ? v(repo.repoRef) : v ?? "private");
    },
    ryphTree(repo, _url, commitOrRef) {
      if (opts.ryphTree) return Promise.resolve(opts.ryphTree(repo, commitOrRef));
      const commit = /^[0-9a-f]{40}$/.test(commitOrRef) ? commitOrRef : NOOP_COMMIT;
      return Promise.resolve({
        commit,
        tree: null,
        fullTree: null,
        dockerfile: false,
        dockerfileBlob: null,
      });
    },
    ryphBase(repo, _url, head, base) {
      if (opts.ryphBase) return Promise.resolve(opts.ryphBase(repo, head, base));
      return Promise.resolve({ base: NOOP_COMMIT, mergeBase: null, tree: null, changed: [] });
    },
    defaultBranchHead(repo) {
      if (opts.defaultBranchHead) return Promise.resolve(opts.defaultBranchHead(repo));
      return Promise.resolve({ ref: "main", commit: NOOP_COMMIT });
    },
    branchKind(repo, _url, ref) {
      if (opts.branchKind) return Promise.resolve(opts.branchKind(repo, ref));
      return Promise.resolve(ref === "main" || ref === "refs/heads/main" ? "default" : "branch");
    },
    checkOrgMembership() {
      return Promise.resolve(opts.membership ?? "member");
    },
    exchangeOAuthCode(code) {
      // A recognizable fake: the "code" is taken to be the login, so dev flows round-trip.
      return Promise.resolve({
        accountId: `noop-${code}`,
        login: `noop-${code}`,
        name: null,
        verifiedEmails: [`noop-${code}@example.com`],
        accessToken: null,
      });
    },
  };
}

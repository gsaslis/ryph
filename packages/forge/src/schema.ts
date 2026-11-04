// The ingest boundary — and here, a SECURITY boundary. Every JSON payload that crosses into
// this package is parsed against a schema before it may travel as a core type: what this file
// did not check never travels.
//
// Invariants (shared with the orchestrator's and runner's schema.ts):
// - nothing downstream ever sees an unchecked cast
// - each schema is pinned to its interface with `satisfies z.ZodType<...>`,
//   so a drift between the two is a compile error — core/types.ts stays the source of truth
// - zod never reaches src/core; the architecture guard keeps the core dependency-free
// - every string is length-bounded; unknown keys are refused rather than passed through
//   (`z.strictObject`) — an ingest boundary that forwards what it did not check is not one

import { z } from "@zod/zod";
import type { ForgeProvider, RunGrant, RunGrantRepo, ToolGrant } from "./core/types.ts";
import type { CheckReport, CheckRunReport } from "./ports/forge_api.ts";
import { isLocalRepoRef, LOCAL_REPO_REF_MAX } from "./core/local_repo.ts";
import { MAX_LINES_PER_REPO } from "@ryph/shared/lines";
import { isGitRefName } from "@ryph/shared/refs";
import { isGitlabRef } from "./gitlab_account.ts";

const MAX_LEN = 10_000;

const nonEmpty = z.string().trim().min(1).max(MAX_LEN);

/** Ids minted by the orchestrator (run ids) — slug-safe, they ride URLs and paths. */
const mintedId = nonEmpty.regex(/^[A-Za-z0-9._-]+$/, { error: "not a valid id" });

// The ref-name rule is `isGitRefName`, which the push path asks too; applied here again because
// this is a separate trust boundary from the orchestrator's ingest.
const gitRefName = nonEmpty
  .refine((s) => !s.startsWith("-"), { error: "must not start with '-'" })
  .refine(isGitRefName, { error: "not a valid git ref name" });

/** A full commit id — SHA-1, or SHA-256 for a repository that uses it. */
const commitSha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, { error: "not a commit sha" });

/** A patch-store key, as intake minted it. */
const bundleKey = nonEmpty.regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, {
  error: "not a bundle key",
}).refine((k) => !k.includes(".."), { error: "not a bundle key" });

/** GitHub's numeric installation id, as text — the only shape a forge-side tenant id takes
 * today. Digits-only and bounded because every consumer interpolates it into a forge API path:
 * a value that could hold a slash could walk to another endpoint. `core/types.ts` keeps the
 * concept forge-agnostic (`tenantId`); the wire is where the current forge's shape is pinned. */
const installationId = z.string().trim().regex(/^\d{1,20}$/, {
  error: "not an installation id",
});

/** Which forge a repo lives on — what picks the adapter every path resolves through. */
const forgeProvider = z.enum(["github", "gitlab", "radicle", "local"]);

/** A tenant id, or null: a provider whose writes are signed by the deployment's own key has
 * no tenants at all, so null is an answer and not a missing field. */
const tenantId = installationId.nullable();

/**
 * How each forge spells a repo's address — the one place either spelling lives.
 *
 * GitHub: "owner/name", each half a real segment, so the value can never walk an API path it
 * is interpolated into. GitLab: `path_with_namespace`, nested — `group/sub/…/project`, 2 to 20
 * segments of the same characters — which the adapter URL-encodes whole into one path segment.
 * Radicle: a `rad:` RID, which is `z` plus base58btc. Local: an absolute real path, which no
 * pattern spells well — `core/local_repo.ts` holds that rule.
 */
const REPO_REF_PATTERNS: Record<Exclude<ForgeProvider, "local">, RegExp> = {
  github: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  gitlab: /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,19}$/,
  radicle: /^rad:z[1-9A-HJ-NP-Za-km-z]+$/,
};

/** The longest forge-side address carried, per forge; a local path may be longer
 * (`LOCAL_REPO_REF_MAX`). GitLab's nested paths run to 255. */
const REPO_REF_MAX: Record<Exclude<ForgeProvider, "local">, number> = {
  github: 200,
  gitlab: 255,
  radicle: 200,
};

/** Whether `ref` is an address the named forge could have produced. */
export function isRepoRef(provider: ForgeProvider, ref: string): boolean {
  if (provider === "local") return isLocalRepoRef(ref);
  if (ref.length > REPO_REF_MAX[provider] || !REPO_REF_PATTERNS[provider].test(ref)) return false;
  // "." and ".." are real path segments to an HTTP client, and GitHub's and GitLab's spellings
  // admit both characters — a repo reference must never be able to walk the path it lands in.
  if (
    (provider === "github" || provider === "gitlab") &&
    ref.split("/").some((seg) => seg === "." || seg === "..")
  ) {
    return false;
  }
  return true;
}

/**
 * The repoRef field before its provider is known: bounded, NOT trimmed. A forge-side address
 * is trimmed by `withRepoRef` once the provider says which kind it is; a `local` path never is,
 * because `/srv/app ` and `/srv/app` are two directories, and trimming would quietly turn a
 * request about one into a request about the other. `isLocalRepoRef` refuses the edge
 * whitespace instead.
 */
const repoRefField = z.string().min(1).max(LOCAL_REPO_REF_MAX);

/** A repo's opaque address, checked against the spelling its OWN provider uses — and, for a
 * `local` repo, no tenant: there is nobody on this machine's disk to act as. */
function withRepoRef<
  T extends z.ZodType<{ provider: ForgeProvider; repoRef: string; tenantId: string | null }>,
>(
  schema: T,
): z.ZodType<z.infer<T>> {
  return schema
    .transform((v) => v.provider === "local" ? v : { ...v, repoRef: v.repoRef.trim() })
    .refine((v) => isRepoRef(v.provider, v.repoRef), {
      error: "not a repo address this forge could have produced",
      path: ["repoRef"],
    })
    .refine((v) => v.provider !== "local" || v.tenantId === null, {
      error: "a local repository has no tenant",
      path: ["tenantId"],
    }) as unknown as z.ZodType<z.infer<T>>;
}

/** A GitLab project's id on its instance (`ForgeRepo.forgeId`, `<id>@<url>`), on a GitLab repo
 * alone — and on every GitLab repo: a GitLab project is never addressed by its path, so a GitLab
 * repo without one is refused here, at the door, before any adapter could fall back to it. */
const gitlabProjectId = z.string().max(2_100).refine(isGitlabRef, {
  error: "not a GitLab project id (<id>@<instance URL>)",
}).optional();
const onlyGitlabHasForgeId = (v: { provider: ForgeProvider; forgeId?: string }) =>
  (v.forgeId !== undefined) === (v.provider === "gitlab");
const forgeIdOffGitlab = {
  error: "a GitLab project is named by its id, and only a GitLab project has one",
  path: ["forgeId"],
};

/** One member of a grant: a connected repo of the run's checkout. */
export const RunGrantRepoSchema = withRepoRef(z.strictObject({
  connectedRepoId: mintedId,
  url: nonEmpty,
  ref: gitRefName,
  targetRef: gitRefName.optional(),
  lineBases: z.array(gitRefName).max(MAX_LINES_PER_REPO).optional(),
  branchNamespace: gitRefName,
  provider: forgeProvider,
  repoRef: repoRefField,
  tenantId,
  forgeId: gitlabProjectId,
  // Set only on a check pod's grant: the one commit it may clone, and where it comes from —
  // the bundle intake stored it in, or the forge itself (a change request's head, with the ref
  // to fall back on). Strict on both arms, so a member naming both keys is neither. Such a grant
  // reads; it never ships (see http/patches.ts).
  candidate: z.union([
    z.strictObject({ headSha: commitSha, branchName: gitRefName, bundleKey }),
    z.strictObject({
      headSha: commitSha,
      branchName: gitRefName,
      fetchRef: gitRefName.max(255).refine(
        (r) => r.startsWith("refs/") && !r.startsWith("refs/tags/"),
        { error: "not a fetchable change request ref" },
      ).nullable(),
    }),
  ]).optional(),
})).refine(onlyGitlabHasForgeId, forgeIdOffGitlab) satisfies z.ZodType<RunGrantRepo>;

/** How many repos one run may hold — the runner's own ceiling, repeated at this boundary. */
const MAX_GRANT_REPOS = 20;

/** What the orchestrator answers a key resolve with — the grant both doors act on: the run,
 * and every connected repo it may read and ship for. A member appears once. */
export const RunGrantSchema = z.strictObject({
  runId: mintedId,
  repos: z.array(RunGrantRepoSchema).min(1).max(MAX_GRANT_REPOS).refine(
    (repos) => new Set(repos.map((r) => r.connectedRepoId)).size === repos.length,
    { error: "a repo may appear in a grant only once" },
  ),
}) satisfies z.ZodType<RunGrant>;

// ---------------------------------------------------------------------------
// The service surface (door ③): what the orchestrator asks this package to do.
// Service-authenticated, but validated all the same: authentication proves who is calling,
// not that the payload is well-formed.
// ---------------------------------------------------------------------------

/** Which repo a service call acts on, and as whom — the `ForgeRepo` the boundary's port takes,
 * plus the provider that picks which adapter it is handed to. */
const repoTarget = withRepoRef(z.strictObject({
  provider: forgeProvider,
  repoRef: repoRefField,
  tenantId,
  /** GitLab's numeric project id (`ForgeRepo.forgeId`): the project the call means, wherever
   * its path has moved. */
  forgeId: gitlabProjectId,
})).refine(onlyGitlabHasForgeId, forgeIdOffGitlab);

/** The kinds of conversation this boundary knows, and how a thread is addressed in one: text,
 * because only GitHub's are numbers. The character set is what may ride an API path segment. */
const threadKind = z.enum(["issue", "change_request"]);
const threadRef = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/, {
  error: "not a thread reference",
});
const threadOf = z.strictObject({ kind: threadKind, ref: threadRef });

/** The same rule as a predicate, for a thread named by a URL SEGMENT rather than a body — door
 * ①'s change-request warm. The character set is the point: the value is interpolated into a
 * forge API path either way. */
export function isThreadRef(ref: string): boolean {
  return threadRef.safeParse(ref).success;
}

/** GitHub caps a PR body at 65536 characters; refuse here rather than mid-submission. */
const prBody = z.string().max(65_000);

/** The run whose agent wrote a body, where the body may show that run's images
 * (`![alt](img-…)`): the refs in it are resolved against this run. Absent, a body with refs is
 * refused (core/images.ts). */
const bodyRunId = mintedId.optional();

export const SubmitRequestSchema = z.strictObject({
  bundleKey,
  branchName: gitRefName,
  headSha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, { error: "not a commit sha" }),
  repo: repoTarget,
  /** The upstream clone URL, off the connected repo row — what a transport that pushes uses. */
  repoUrl: nonEmpty,
  baseBranch: gitRefName,
  title: nonEmpty.refine((s) => !/[\r\n]/.test(s), { error: "must be a single line" }),
  body: prBody,
  runId: bodyRunId,
  /** Set: update this existing change request — on GitHub, push onto its own branch, which is
   * then `baseBranch` — rather than opening a new one. On a `local` repo it is the BRANCH ryph
   * delivered before (the ref that delivery answered), so it is checked as a branch name there
   * and as a thread reference everywhere else. */
  changeRequest: z.string().trim().min(1).max(255).optional(),
  /** The connected repo lets a run push onto its fork pull requests' branches, as the control
   * plane read it at submit time (`ChangeDelivery.allowForkPush`). Absent is no. */
  allowForkPush: z.boolean().optional(),
  /** The hook files a person approved this patch with, repo-relative, as the `needs_approval`
   * refusal (or the patch-hooks route) named them. Only a `local` delivery reads it; none is
   * none approved. Not trimmed: matched exactly, and a path is what the repository spells. */
  approvedHookPaths: z.array(z.string().min(1).max(LOCAL_REPO_REF_MAX)).max(1000).default([]),
}).refine(
  (s) =>
    s.changeRequest === undefined ||
    (s.repo.provider === "local" ? isGitRefName(s.changeRequest) : isThreadRef(s.changeRequest)),
  { error: "not a change request this forge could have produced", path: ["changeRequest"] },
);

export const CommentRequestSchema = z.strictObject({
  repo: repoTarget,
  thread: threadOf,
  body: prBody,
  runId: bodyRunId,
});

export const ThreadRequestSchema = z.strictObject({
  repo: repoTarget,
  thread: threadOf,
  /** Download the thread's images too; `focus` is the command's own comment handle (a
   * `sourceCommentId`), whose images are taken first — or, with `focusOnly`, the only ones. */
  images: z.strictObject({
    focus: z.string().min(1).max(300).nullable(),
    focusOnly: z.boolean().optional(),
  }).optional(),
});

/** A change request's head and fate — the lean read a push event is checked against. */
export const ChangeRequestHeadRequestSchema = z.strictObject({
  repo: repoTarget,
  ref: threadRef,
});

/**
 * The handle a comment is edited and reacted to by — GitHub's numeric id, or the Radicle
 * adapter's `<kind>:<thread>:<oid>` (a comment there is only reachable through the object it
 * hangs on, so the thread rides inside the handle).
 *
 * Bounded to a character set that cannot walk a path, and `..` refused outright, for the
 * reason the digits-only version existed: every consumer interpolates this into a URL.
 */
const commentId = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, { error: "not a comment id" })
  .refine((v) => !v.includes(".."), { error: "not a comment id" });

export const CommentUpdateSchema = z.strictObject({
  repo: repoTarget,
  commentId,
  body: prBody,
  runId: bodyRunId,
});

export const ReactionRequestSchema = z.strictObject({
  repo: repoTarget,
  commentId,
  /** One emoji, not GitHub's full palette: 👀 is the only reaction this system speaks. */
  reaction: z.literal("eyes"),
});

/** Is this repo public or private — the orchestrator's chat door asks before a public channel
 * may command work on it. */
export const VisibilityRequestSchema = z.strictObject({
  repo: repoTarget,
});

export const PermissionRequestSchema = z.strictObject({
  repo: repoTarget,
  /**
   * The identity as this provider names it — a login on GitHub, a DID on Radicle, the account id
   * (`<id>@<url>`) on GitLab — or null for "there is no identity", which Radicle's
   * permissionless `write` tier is a real question on. Null is the ONE spelling of that:
   * `.min(1)` stays so `""` is still a 400, because two spellings of nobody is how one of them
   * ends up unhandled in an adapter.
   */
  subject: z.string().trim().min(1).max(2_100).nullable(),
  atLeast: z.enum(["write", "admin"]),
});

/** Whether a person may sign up: on GitHub, a login that is a member of the org an installation
 * sits on (the installation names it); on GitLab, an ACCOUNT ID (`<id>@<url>`) that is a member
 * of `RYPH_GITLAB_GROUP` (the forge names it) — never a username, which anybody can register once
 * its holder gives it up. */
export const OrgMembershipRequestSchema = z.strictObject({
  provider: z.enum(["github", "gitlab"]),
  installationId: installationId.optional(),
  login: z.string().trim().min(1).max(255).optional(),
  accountId: z.string().max(2_100).refine(isGitlabRef, {
    error: "not a GitLab account id (<id>@<instance URL>)",
  }).optional(),
}).refine((b) => b.provider !== "github" || b.installationId !== undefined, {
  error: "a GitHub membership is asked of an installation",
  path: ["installationId"],
}).refine((b) => b.provider === "github" ? b.login !== undefined : b.accountId !== undefined, {
  error: "a GitHub membership is asked about a login, a GitLab one about an account id",
  path: ["login"],
}).refine((b) => b.provider === "github" ? b.accountId === undefined : b.login === undefined, {
  error: "a membership is asked about one identity",
  path: ["accountId"],
});

export const InstallationRequestSchema = z.strictObject({
  installationId,
});

/**
 * Which repo, and at which ref, the orchestrator wants the services declaration read from.
 * Note what is NOT here: a path. The route reads one fixed file, so a caller cannot walk a
 * connected repo's tree through a surface that holds an installation token for every repo the
 * App can see.
 */
export const ServicesFileRequestSchema = z.strictObject({
  repo: repoTarget,
  url: nonEmpty,
  ref: gitRefName,
});

/**
 * Which repo, and at which commit or branch, the orchestrator wants the `.ryph/` tree id of.
 * The same bargain as `ServicesFileRequestSchema`: no path crosses the wire. The route reads
 * `.ryph` and nothing else, and answers an object id, never content.
 */
export const RyphTreeRequestSchema = z.strictObject({
  repo: repoTarget,
  url: nonEmpty,
  commitOrRef: z.union([commitSha, gitRefName]),
});

/**
 * Where a branch head's `.ryph/` came from: the head commit, and the branch (the default one) it
 * forked from. The route answers the merge base of the two, the `.ryph` tree id there, and which
 * paths under `.ryph/` the head changed since — names under that one fixed directory, never
 * content. The same bargain as `RyphTreeRequestSchema`: no path crosses the wire.
 */
export const RyphBaseRequestSchema = z.strictObject({
  repo: repoTarget,
  url: nonEmpty,
  head: commitSha,
  base: gitRefName,
});

/**
 * A merge's containment question: which of `heads` (the patch heads ryph pushed onto the change
 * request) any of `mergedHeads` (what the forge says merged) contains. `bases` names, per head,
 * the base it was built on, so its own work is what lies past that (helpers/containment.ts); a
 * head it does not name is measured as if it had none. `into` names the branch the change
 * request merged into, where the caller knows it: what a merged head's own change is measured
 * from. Bounded: a change request holds one patch per push of a generation, and a merge names
 * one head, or a few.
 *
 * The bases are the runner's word, relayed: read leniently (`basesOf`), so an entry that is not
 * a head asked about mapped to a commit id is dropped, as if it named none, and never costs the
 * whole question its answer. `into` is read leniently too (`intoOf`): it is a forge's branch
 * name, relayed, and one these ref rules refuse is as good as none named, never a refusal of
 * the question (which the caller would read as final, and every head unproven).
 */
export const MergeContainmentRequestSchema = z.strictObject({
  repo: repoTarget,
  url: nonEmpty,
  mergedHeads: z.array(commitSha).min(1).max(20),
  heads: z.array(commitSha).min(1).max(500),
  bases: z.unknown().optional(),
  into: z.unknown().optional(),
});

/** The usable part of a containment request's `into`: the name, where it is a string these ref
 * rules accept (so it never reaches git as an option or a pattern), else undefined. */
export function intoOf(raw: unknown): string | undefined {
  const parsed = gitRefName.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** The usable part of a containment request's `bases`: each asked head's base, where it names
 * one as a commit id, and how many entries were dropped. */
export function basesOf(
  raw: unknown,
  heads: readonly string[],
): { bases: Record<string, string>; ignored: number } {
  const bases: Record<string, string> = {};
  if (raw === undefined || raw === null) return { bases, ignored: 0 };
  if (typeof raw !== "object" || Array.isArray(raw)) return { bases, ignored: 1 };
  const asked = new Set(heads);
  let ignored = 0;
  for (const [head, base] of Object.entries(raw)) {
    if (asked.has(head) && commitSha.safeParse(base).success) bases[head] = base as string;
    else ignored++;
  }
  return { bases, ignored };
}

/**
 * Which repo, and at which commit or branch, the orchestrator wants `.ryph/checks.yml` read at.
 * The same bargain as `ServicesFileRequestSchema`: no path crosses the wire. The route reads the
 * checks file, the services file, the `.ryph` tree id and whether `.ryph/Dockerfile` exists —
 * fixed paths, all at one pinned commit.
 */
export const ChecksFileRequestSchema = z.strictObject({
  repo: repoTarget,
  url: nonEmpty,
  commitOrRef: z.union([commitSha, gitRefName]),
});

/**
 * Which repo, and at which commit or branch, the orchestrator wants `.agents/skills/` read at,
 * for the org skills repo's sync. Still no path on the wire: the prefix is fixed on this side
 * (helpers/skill_tree.ts). `knownTree` is the tree id of the version the control plane already
 * holds; when the directory still has it, nothing more is read.
 */
export const SkillsTreeRequestSchema = z.strictObject({
  repo: repoTarget,
  url: nonEmpty,
  commitOrRef: z.union([commitSha, gitRefName]),
  knownTree: commitSha.nullable(),
});

/**
 * One segment of a patch-store key: a minted id that can never be a path step of its own. The
 * store refuses `..` anywhere as well; this says so at the boundary, as a 400 and not a 500.
 */
const keySegment = mintedId.max(200).refine((s) => s !== "." && !s.includes(".."), {
  error: "not a valid id",
});

/**
 * A ryph user id as the auth service mints it (`u-<hex>`), held to the id charset WITHOUT dots:
 * it opens a patch-store key, so nothing in it may read as a path step.
 */
const userId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, {
  error: "not a valid user id",
});

/**
 * What rides the `x-ryph-check-bundle` header beside a person's check bundle: which repo (the
 * coordinates every cache-backed read takes, plus the connected repo id the key is filed
 * under), whose bundle it is, and the branch its one ref must be. `baseRef` is the branch the
 * bundle was cut against; absent, the upstream's default branch.
 */
/** Internal control-plane read of an intake bundle for delegation to another instance. */
export const ReadCheckBundleSchema = z.strictObject({
  bundleKey: bundleKey.max(1024).refine((key) => key.endsWith(".bundle"), {
    error: "not a bundle key",
  }),
});

export const CheckBundleRequestSchema = z.strictObject({
  repo: repoTarget,
  url: nonEmpty,
  connectedRepoId: keySegment,
  baseRef: gitRefName.max(255).optional(),
  userId,
  branchName: gitRefName.max(255),
});

/**
 * A patch's diff (helpers/patch_diff.ts): its bundle staged on the commits it requires, verified
 * as a submission verifies it, and diffed against where it lands. The key must be the one intake
 * filed THIS repo's head under, which the route checks.
 */
export const PatchDiffRequestSchema = z.strictObject({
  repo: repoTarget,
  url: nonEmpty,
  connectedRepoId: keySegment,
  bundleKey,
  branchName: gitRefName.max(255),
  headSha: commitSha,
  /** Where the run reported the bundle was cut from; a settled patch's diff starts there. */
  baseSha: commitSha.nullable(),
  /** The branch the patch lands on: a new change request's base, or the branch of the existing
   * change request it is pushed onto. An unpublished patch's diff is measured against its tip. */
  targetRef: gitRefName.max(255),
  /** `live` for a patch not yet published, `record` for one settled (helpers/patch_diff.ts). */
  mode: z.enum(["live", "record"]),
});

/** One patch's bundle, as its row names it, for a lineage question. */
const lineageBundle = z.strictObject({
  bundleKey,
  branchName: gitRefName.max(255),
  headSha: commitSha,
});

/**
 * A newborn patch's lineage (`POST /v1/service/patch-lineage`): which of the run's other lines of
 * the repo (`others`, each its newest waiting patch) share any of its own commits, and whether
 * its head holds `mustHold`, the tip its line's change request merged at. A bundle's own commits
 * are those past its prerequisites and the tip of `targetRef`, the branch the line lands on.
 * Every key must be one intake filed THIS repo's head under, which the route checks.
 */
export const PatchLineageRequestSchema = z.strictObject({
  repo: repoTarget,
  url: nonEmpty,
  connectedRepoId: keySegment,
  targetRef: gitRefName.max(255),
  patch: lineageBundle,
  others: z.array(lineageBundle.extend({ line: z.string().min(1).max(255) }))
    .max(MAX_LINES_PER_REPO),
  mustHold: commitSha.optional(),
});

/** The most checks one suite may carry — the orchestrator's `MAX_CHECKS`, repeated here. */
const MAX_REPORTED_CHECKS = 32;
const checkTimestamp = z.string().max(64).nullable();

const checkRunReport = z.strictObject({
  name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, { error: "not a check name" }),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z.enum([
    "success",
    "failure",
    "timed_out",
    "cancelled",
    "action_required",
    "neutral",
  ]).nullable(),
  title: z.string().max(200),
  summary: z.string().max(60_000),
  startedAt: checkTimestamp,
  completedAt: checkTimestamp,
  externalId: z.string().min(1).max(200),
  forgeRef: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/, { error: "not a forge ref" }).nullable(),
}) satisfies z.ZodType<CheckRunReport>;

/** A check suite the orchestrator wants shown on a commit the forge already has. */
export const ReportChecksRequestSchema = z.strictObject({
  repo: repoTarget,
  report: z.strictObject({
    headSha: commitSha,
    suiteId: mintedId.max(200),
    generation: z.number().int().min(1).max(10_000),
    detailsUrl: z.url().max(2_000).nullable(),
    suite: z.strictObject({
      state: z.enum(["waiting", "queued", "running", "passed", "failed", "error", "cancelled"]),
      conclusion: z.enum(["success", "failure"]).nullable(),
      summary: z.string().max(60_000),
      previousGenerations: z.array(z.number().int().min(1).max(10_000)).max(10_000).optional(),
    }),
    checks: z.array(checkRunReport).max(MAX_REPORTED_CHECKS).refine(
      (checks) => new Set(checks.map((c) => c.name)).size === checks.length,
      { error: "a check may appear in a report only once" },
    ),
  }) satisfies z.ZodType<CheckReport>,
});

/** Which repo's default branch head the orchestrator wants — its name and commit, both read
 * off the upstream rather than off the connected repo's row, which is as old as the connect. */
export const DefaultBranchHeadRequestSchema = z.strictObject({
  repo: repoTarget,
  url: nonEmpty,
});

/** Which branch's live head the orchestrator wants, as the upstream names it now. A branch
 * NAME — `refs/heads/` is implied, so no other namespace can be asked about. */
export const BranchHeadRequestSchema = z.strictObject({
  repo: repoTarget,
  url: nonEmpty,
  branch: gitRefName.max(255).refine((b) => !b.startsWith("refs/"), {
    error: "a branch name, not a ref",
  }),
});

/** Which ref of a repo the orchestrator wants classified — see `BranchKind`. */
export const BranchKindRequestSchema = z.strictObject({
  repo: repoTarget,
  url: nonEmpty,
  ref: gitRefName,
});

/** A path on this machine a person typed to connect it as a `local` repo. Not trimmed and not
 * pattern-checked here: whether it is absolute, real and inside the root is the describe route's
 * answer, in words, rather than a 400 that says nothing about the path. */
export const LocalDescribeRequestSchema = z.strictObject({
  path: z.string().max(LOCAL_REPO_REF_MAX),
});

/** An OAuth code to redeem, and on which forge. `redirectUri` is GitLab's: it requires the
 * authorize leg's redirect URI again on the token leg, where GitHub's flow omits it on both. */
export const OAuthExchangeSchema = z.strictObject({
  provider: z.enum(["github", "gitlab"]),
  code: z.string().trim().min(1).max(500),
  redirectUri: z.url({ protocol: /^https?$/ }).max(2_000).optional(),
  /** GitLab's PKCE verifier (S256), from the authorize leg's cookie. */
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/).optional(),
}).refine((b) => b.provider !== "gitlab" || b.redirectUri !== undefined, {
  error: "a GitLab code is redeemed with the redirect URI it was issued for",
  path: ["redirectUri"],
});

/** A GitLab project a connect flow asks about, by its numeric id or its `path_with_namespace` —
 * either rides one URL-encoded path segment. */
export const GitlabDescribeRequestSchema = z.strictObject({
  project: z.union([
    z.string().trim().regex(/^\d{1,20}$/, { error: "not a project id" }),
    z.string().trim().min(1).max(255).refine((ref) => isRepoRef("gitlab", ref), {
      error: "not a GitLab project path",
    }),
  ]),
});

/** An account whose CURRENT username is wanted, for display: by its id on the instance. */
export const GitlabUserRequestSchema = z.strictObject({
  accountId: z.string().max(2_100).refine(isGitlabRef, {
    error: "not a GitLab account id (<id>@<instance URL>)",
  }),
});

/** The project a webhook token is derived for: GitLab's numeric project id, digits only — what
 * the mailroom reads off the delivery URL's `project` parameter. */
export const GitlabHookTokenRequestSchema = z.strictObject({
  projectId: z.string().trim().regex(/^\d{1,20}$/, { error: "not a project id" }),
  // The project's token generation, as the control plane holds it: rotating bumps it.
  generation: z.number().int().min(1).max(9_999_999_999),
});

/** A GitHub repo a user-mode forge is asked to describe before it is connected. "owner/name"
 * and nothing else: it is interpolated into `/repos/{owner}/{name}` with the person's token. */
export const GithubDescribeRequestSchema = z.strictObject({
  repoRef: z.string().trim().min(1).max(200).refine((ref) => isRepoRef("github", ref), {
    error: "not a GitHub owner/name",
  }),
});

/** A Radicle repository, for the bridge-only routes the connect flow dials: seeding, and the
 * identity document. A RID and nothing else — every one of them puts it in a URL path. */
export const RadicleRepoRequestSchema = z.strictObject({
  repoRef: z.string().trim().min(1).max(200).refine((ref) => isRepoRef("radicle", ref), {
    error: "not a Radicle repository id",
  }),
});

// ---------------------------------------------------------------------------
// Door ⑤, the tool surface: the grant the orchestrator resolves a run to, its ledger's answers,
// and the arguments an agent's tool call carries — the last untrusted by definition.
// ---------------------------------------------------------------------------

/** The ceiling on every per-run cap a forge policy may set — the orchestrator's MAX_FORGE_CAP,
 * restated here because the two packages deploy apart and share no source. The forge only
 * validates against it; the control plane is what decides a run's actual caps. */
export const MAX_TOOL_CAP = 50;

/** add_labels carries no cap of its own in the policy (the label allowlist is the decision), so
 * the orchestrator counts it against a fixed ceiling — the orchestrator's LABEL_ACTIONS_MAX,
 * restated here so a tool description can name it. */
export const LABEL_ACTIONS_MAX = MAX_TOOL_CAP;

const toolCap = z.strictObject({ max: z.number().int().min(1).max(MAX_TOOL_CAP) });
const toolWhere = z.enum(["origin", "any"]);
/** A cap that also says where it may be spent — one ceiling, not a copy per capability. */
const placedCap = toolCap.extend({ where: toolWhere });

/** What the orchestrator answers a tool grant resolve with. */
const toolGrantRepo = withRepoRef(z.strictObject({
  connectedRepoId: mintedId,
  provider: forgeProvider,
  repoRef: repoRefField,
  tenantId,
  forgeId: gitlabProjectId,
})).refine(onlyGitlabHasForgeId, forgeIdOffGitlab);

export const ToolGrantSchema = z.strictObject({
  runId: mintedId,
  repos: z.array(toolGrantRepo).min(1).max(MAX_GRANT_REPOS),
  /** What the run checked out — the visibility rule's other half (see ToolGrant.sourceRepos). */
  sourceRepos: z.array(toolGrantRepo).max(MAX_GRANT_REPOS),
  origin: z.strictObject({ connectedRepoId: mintedId, kind: threadKind, ref: threadRef })
    .nullable(),
  opened: z.array(z.strictObject({ connectedRepoId: mintedId, ref: threadRef })).max(1_000),
  workedChangeRequests: z.array(z.strictObject({ connectedRepoId: mintedId, ref: threadRef }))
    .max(1_000).optional(),
  capabilities: z.strictObject({
    read: z.boolean(),
    createIssues: toolCap.nullable(),
    comment: placedCap.nullable(),
    review: placedCap.nullable(),
    closeIssues: placedCap.nullable(),
    labels: z.array(z.string().min(1).max(50)).max(50),
  }),
  provenance: z.strictObject({
    agentName: z.string().min(1).max(200),
    runUrl: z.string().max(2_000).nullable(),
    requestedBy: z.string().max(100).nullable(),
    requestedVia: z.string().max(100).nullable(),
  }),
}) satisfies z.ZodType<ToolGrant>;

/** A reserved write's id, as the orchestrator minted it. */
export const ReserveAnswerSchema = z.object({ actionId: mintedId });

/** A refusal's words, whichever route gave it. */
export const RefusalSchema = z.object({ error: z.string().max(2_000) });

const imageRef = z.string().regex(/^img-[0-9a-f]{12}$/);

/** What the orchestrator answers an image resolve with
 * (`POST /v1/forge/runs/:runId/images/resolve`). Not strict: an answer may grow a field this
 * side does not read yet. */
export const ImageResolutionSchema = z.object({
  images: z.array(z.object({
    ref: imageRef,
    attachmentId: mintedId,
    mime: z.string().min(1).max(100),
    url: z.string().max(2_000).refine((u) => /^https?:\/\//.test(u), {
      error: "must be an http(s) URL",
    }).nullable(),
  })).max(20),
  unknown: z.array(z.string().max(100)).max(20),
});

/** A repo, as the agent names it — the grant decides whether it is one it may, by matching
 * against its own spelling, so nothing here is interpolated into a path before that match. */
const toolRepo = z.string().trim().min(1).max(200)
  .describe(
    "The repository, as this forge names it (owner/name on GitHub, group/project on GitLab)",
  );

/** A thread, as the agent names it: "12" on GitHub, a patch or issue id on Radicle, `mr-7` or
 * `issue-12` on GitLab — where a leading `!` (merge request) or `#` (issue) is how a person writes
 * one, so it is taken too and normalized before the grant check (core/tool_grant.ts). The stored
 * and wire refs never carry it. */
const toolThread = z.string().trim().min(1).max(200).regex(/^[!#]?[A-Za-z0-9._:-]+$/, {
  error: "not a thread reference",
});

/** What an agent may write in one body. GitHub allows 65 536 characters; this leaves the footer
 * room and keeps one comment a comment. */
const toolBody = z.string().min(1).max(16_384);

/** What ONE review remark may carry — deliberately smaller than a comment's body. The tool
 * surface reads at most 256 KiB of request (MAX_BODY_BYTES), and a review is one request: thirty
 * remarks at a comment's 16 KiB plus a 16 KiB verdict is half a megabyte, so a review this schema
 * called legal came back as an opaque HTTP 413 the model cannot read — and retries verbatim.
 * 30 × 4 KiB + 16 KiB leaves the JSON-RPC envelope, and every path and line, room to spare. */
const reviewRemarkBody = z.string().min(1).max(4_096);

const listState = z.enum(["open", "closed", "all"]).default("open");
const listPage = z.number().int().min(1).max(10).default(1)
  .describe("Which page of 30, from 1");
const toolLabel = z.string().trim().min(1).max(50);

export const GetThreadArgsSchema = z.strictObject({
  repo: toolRepo,
  thread: toolThread,
});

export const CompareChangeRequestArgsSchema = z.strictObject({
  repo: toolRepo,
  thread: toolThread,
  from: z.string().regex(/^[0-9a-f]{40}$/).describe(
    "The full Radicle revision id previously reviewed, not its head SHA",
  ),
  to: z.string().regex(/^[0-9a-f]{40}$/).optional().describe(
    "The full target revision id; defaults to the latest revision",
  ),
  mode: z.enum(["diff", "range-diff"]).default("diff")
    .describe(
      "diff compares revision heads; range-diff compares their commit series after rebasing or rewriting",
    ),
});

export const ListIssuesArgsSchema = z.strictObject({
  repo: toolRepo,
  state: listState,
  labels: z.array(toolLabel).max(10).default([]).describe("Only issues carrying all of these"),
  page: listPage,
});

export const ListChangeRequestsArgsSchema = z.strictObject({
  repo: toolRepo,
  state: listState,
  page: listPage,
});

export const CreateIssueArgsSchema = z.strictObject({
  repo: toolRepo,
  title: z.string().trim().min(1).max(256).refine((s) => !/[\r\n]/.test(s), {
    error: "must be a single line",
  }),
  body: toolBody,
  labels: z.array(toolLabel).max(10).default([]),
});

export const AddCommentArgsSchema = z.strictObject({
  repo: toolRepo,
  thread: toolThread.describe(
    "The issue or change request — e.g. a GitHub pull request, a GitLab merge request (!7) or a Radicle patch",
  ),
  body: toolBody,
  // Null is "no reply", for models that fill every field. A placeholder id is refused by name
  // rather than looked up: the agent wanted the conversation, and a refusal that only says the
  // id is wrong sends it hunting for a real one — into some reviewer's thread.
  // GitHub's numeric id, or GitLab's `mr-<iid>:<discussion id>:<note id>` handle.
  replyTo: z.string().trim().regex(
    /^(?:[1-9][0-9]{0,19}|mr-[1-9][0-9]{0,19}:[0-9a-f]{40}:[1-9][0-9]{0,19})$/,
    {
      error: "not a review comment id — leave replyTo out to comment on the conversation",
    },
  )
    .nullish()
    .transform((id) => id ?? undefined)
    .describe(
      "Only to answer one inline review comment, by the id its thread listing shows: the reply " +
        "goes into that remark's review thread instead of the conversation. Leave it out for " +
        "a comment on the conversation",
    ),
  resolve: z.boolean().default(false).describe(
    "With replyTo: also mark that review thread resolved — only once what it asked for is done",
  ),
}).refine((args) => !args.resolve || args.replyTo !== undefined, {
  error: "resolve needs replyTo: only a review thread can be resolved",
});

export const AddLabelsArgsSchema = z.strictObject({
  repo: toolRepo,
  thread: toolThread.describe(
    "The issue or change request — e.g. a GitHub pull request, a GitLab merge request (!7) or a Radicle patch",
  ),
  labels: z.array(toolLabel).min(1).max(10),
});

export const CloseIssueArgsSchema = z.strictObject({
  repo: toolRepo,
  thread: toolThread.describe("The issue"),
  reason: z.enum(["completed", "not_planned"]).default("completed")
    .describe("completed: done or resolved; not_planned: stale, a duplicate, or won't be done"),
  comment: toolBody.optional().describe("A note posted on the issue as it closes, saying why"),
});

/** How many remarks one review may carry: a review is read as one piece, and a longer one is
 * a sign the findings want an issue rather than a diff. */
export const MAX_REVIEW_REMARKS = 30;

export const SubmitReviewArgsSchema = z.strictObject({
  repo: toolRepo,
  thread: toolThread.describe(
    "The change request — e.g. a GitHub pull request, a GitLab merge request (!7) or a Radicle patch",
  ),
  body: z.string().max(16_384).default("")
    .describe("The verdict, and only what belongs on no line of the diff"),
  comments: z.array(z.strictObject({
    path: z.string().trim().min(1).max(1_000).describe("The file, relative to the repo root"),
    line: z.number().int().min(1).max(1_000_000)
      .describe("A line of the diff: the file's new version, or its old one with side LEFT"),
    side: z.enum(["LEFT", "RIGHT"]).default("RIGHT"),
    body: reviewRemarkBody,
  })).max(MAX_REVIEW_REMARKS).default([]).describe("Remarks, each anchored to a line of the diff"),
}).refine((args) => args.body.trim() !== "" || args.comments.length > 0, {
  error: "a review needs a body or at least one remark",
});

/** A schema as an MCP tool's `inputSchema`: JSON Schema of what a caller may SEND. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<
    string,
    unknown
  >;
  delete out.$schema;
  return out;
}

// `Forge` over HTTP to @ryph/forge's service surface — the control plane asking the
// boundary to act. Authenticated with the shared RYPH_FORGE_TOKEN, the same credential the
// gateway presents when it dials back here: two directions, one service trust domain.
//
// The wire contract (implemented by forge's http/service.ts):
//   `repo` below is always {provider, repoRef, tenantId} — which forge, its address there, and
//   the tenant to act as; the boundary picks its adapter from the provider.
//   POST /v1/service/submit      {submission}                → 201 {ref, url}
//                                 with `changeRequest`: updates that change, answers it
//                                 failures: {error, terminal} with an honest status
//                                 409 {code:"needs_approval", touched, hooksPaths, more}: a local
//                                 patch touches a hook file not in `approvedHookPaths`; nothing
//                                 was pushed
//   POST /v1/service/local/patch-hooks  the patch-diff body (live mode)
//                                → 200 {touched, hooksPaths, more} (the repo root is ".");
//                                 failures: {error, terminal} — terminal: never answerable
//                                 for this patch; anything else: not checked yet
//   POST /v1/service/comment     {repo, thread, body}        → 201 {commentId}
//   POST /v1/service/comment/update {repo, commentId, body}  → 204
//   POST /v1/service/reaction    {repo, commentId, reaction} → 204
//   POST /v1/service/thread      {repo, thread, images?: {focus, focusOnly?}} → 200 {ThreadContext}
//                                 with `images`: entries and the opening post carry their images
//                                 (`focusOnly`: only the focus entry does)
//                                 404 {terminal: true} the thread is gone; 502 could not ask
//   POST /v1/service/permission  {repo, subject, atLeast}    → 200 {permission}
//   POST /v1/service/org-membership {installationId, login}   → 200 {membership}
//   POST /v1/service/installation {installationId}           → 200 {accountLogin, settingsUrl, repos}
//   POST /v1/service/installation-settings {installationId}  → 200 {url}; 502 GitHub did not say
//   POST /v1/service/local/describe {path}                   → 200 {repoRef, url, defaultBranch}
//                                 422 {error, reason} the path is refused; 501 no local provider
//   GET  /v1/service/providers                               → 200 {providers, github, gitlab,
//                                 radicle}
//                                 github: null | {mode:"app"} | {mode:"user", login}
//                                 gitlab: null | {mode:"bot"|"user", login, url}
//   GET  /v1/service/github/repos                            → 200 {repos: RepoListing[]}
//                                 user mode only; 501 otherwise
//   POST /v1/service/github/describe {repoRef}                → 200 RepoListing
//                                 404 {error, terminal: true} GitHub has no such repo; 501 not
//                                 user mode; 502 could not ask
//   POST /v1/service/oauth/exchange {provider, code, redirectUri?, codeVerifier?}
//                                → 200 {accountId, login, name, verifiedEmails, accessToken}
//                                 redirectUri required for gitlab
//   POST /v1/service/org-membership {provider:"gitlab", login}
//                                → 200 {membership: "member"|"not-member"|"no-organization"}
//   GET  /v1/service/gitlab/projects                         → 200 {projects: GitlabProjectListing[]}
//                                 501 no GitLab here
//   POST /v1/service/gitlab/describe {project: id | path}    → 200 GitlabProjectListing
//                                 404 {error, terminal: true} no such project the token sees
//   POST /v1/service/gitlab/hook-token {projectId, generation} → 200 {token}
//                                 501 no GitLab, or one that takes no webhooks (user mode)
//   POST /v1/service/services-file {repo, url, ref}
//                                → 200 {kind:"file"|"absent"|"invalid", …} | 502 {kind:"unavailable"}
//   POST /v1/service/visibility  {repo}                      → 200 {visibility:"public"|"private"}
//                                 502 could not ask
//   POST /v1/service/ryph-tree   {repo, url, commitOrRef}
//                                → 200 {commit, tree | null, dockerfile, dockerfileBlob | null}
//   POST /v1/service/ryph-base   {repo, url, head, base}
//                                → 200 {base, mergeBase | null, tree | null, changed}
//   POST /v1/service/default-branch-head {repo, url}         → 200 {ref, commit}
//   POST /v1/service/branch-kind {repo, url, ref}
//                                → 200 {kind:"default"|"branch"|"foreign"}
//                                 the three: 400/404 {error, terminal: true}; 502 could not ask
//   POST /v1/service/checks-file {repo, url, commitOrRef}
//                                → 200 {kind:"file"|"absent"|"invalid", commit, …}
//                                 502 {kind:"unavailable"}; 400 {error, terminal: true} = invalid
//   POST /v1/service/checks/report {repo, report}
//                                → 200 {kind:"reported", refs} | {kind:"unsupported"}
//                                 422/404 {error, terminal: true}; 502 {error, terminal: false}
//   POST /v1/service/check-bundle  body: the bundle, streamed
//                                 x-ryph-check-bundle: {repo, url, connectedRepoId, userId,
//                                                       branchName, baseRef}
//                                → 201 {headSha, bundleKey}
//                                 400/413 {error, detail?, terminal: true}; 503 {error}
//   POST /v1/service/patch-diff  {repo, url, connectedRepoId, bundleKey, branchName, headSha,
//                                 baseSha, targetRef, mode}
//                                → 200 {diff, baseSha, headSha, truncated, omitted}
//                                 400/409/410 {error, terminal: true}; 502/503 {error}
//   POST /v1/service/branch-head {repo, url, branch}
//                                → 200 {sha}; 404 {error, terminal: true} no such branch;
//                                 501 the provider cannot say; 502 could not ask
//
// Invariants (the port's, kept here):
// - submitPatch never throws: the forge names whether a failure is terminal (it knows GitHub
//   semantics); anything unnameable — network death, timeouts, garbage — is retryable,
//   because "we could not ask" must never burn a patch's attempts as if GitHub had refused
// - checkPermission never throws either: an unanswerable check is "unknown", not an error
// - fetchThread never throws for the same reason, and keeps the forge's OWN verdict on
//   whether the thread is gone: inventing "gone" from a network error would drop a command
//   that a redelivery would have landed
// - repoVisibility never throws either, and never guesses: anything but the forge's own
//   verdict is "unknown", which the chat door refuses a public channel on
// - the three environment reads DO throw, with the forge's words: nothing that asks them has a
//   safe default for "we could not ask", so the value-never-throw shape would only move the
//   same branch into every caller
// - readServicesFile never throws either, and for the sharper version of the same reason: it is
//   on the launch path, and anything it cannot turn into one of the port's four arms is
//   "unavailable" — which the caller refuses the task on
// - readChecksFile and reportChecks never throw, for the same two reasons: anything that is not
//   one of the answers is "unavailable" (never "absent") and a retryable "failed"
// - readSkillsTree never throws either: anything that is not one of its answers is
//   "unavailable", which a sync records as a failed read while runs keep the version they have
// - readPatchDiff never throws either: only the forge's own terminal verdict on the patch (a
//   bundle gone, one that no longer verifies, a base gone) is a refusal; anything else is
//   "unavailable", which the page offers to try again
// - readBranchHead never throws: only the forge's own terminal 404 is "absent" and its 501
//   "unsupported"; anything else that is not a sha is "unavailable"
// - stageCheckBundle never throws either: only the forge's own terminal verdict on the bundle is
//   a refusal, and anything else — a 503, a proxy's page, a timeout — is "unavailable"
// - providers, describeLocalRepo, the two GitHub user-mode reads and GitLab's three connect
//   reads DO throw when the forge did not answer: none has a value that could stand in for "we
//   could not ask" without offering, or refusing, something falsely (describeGithubRepo's and
//   describeGitlabProject's null is the forge's own terminal 404)

import { readCappedBytes } from "@ryph/shared/http";
import type {
  BranchHeadOutcome,
  ChangeRequestHeadOutcome,
  CheckBundleAsk,
  ChecksFile,
  DefaultBranchHead,
  Forge,
  ForgeBranchKind,
  ForgeChecks,
  ForgeConnect,
  ForgeIdentity,
  ForgeOrgMembership,
  ForgePatchDiffs,
  ForgePermission,
  ForgeProviders,
  ForgeRepoVisibility,
  ForgeSkills,
  ForgeThreadOutcome,
  GithubConnect,
  GithubMode,
  GithubRepoListing,
  GithubUserConnect,
  GitlabConnect,
  GitlabMode,
  GitlabProjectListing,
  LineageBundle,
  LocalConnect,
  LocalRepoDescription,
  LocalRepoRefusalReason,
  MergeContainmentOutcome,
  PatchDiffOutcome,
  PatchHooksOutcome,
  PatchLineageOutcome,
  PatchSubmission,
  RadicleConnect,
  RadicleIdentity,
  RadicleMode,
  RadicleRepoInfo,
  RadicleRepoUnavailable,
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
import { isGitRefName } from "@ryph/shared/refs";
import { isRepoRef } from "../../schema.ts";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "../../core/attachments.ts";
import { imageRefsIn } from "../../core/image_refs.ts";
import type { ForgeProvider } from "../../core/types.ts";
import { gitlabIdOn } from "@ryph/forge/gitlab-account";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import {
  ChecksFileAnswerSchema,
  ForgeChangeRequestStateSchema,
  ForgeThreadContextSchema,
  PatchDiffAnswerSchema,
  PatchHooksAnswerSchema,
  ReportChecksAnswerSchema,
  SkillsTreeAnswerSchema,
} from "../../schema.ts";

export interface HttpForgeOptions {
  /** The forge service's base URL, as THIS orchestrator dials it (not the container view). */
  baseUrl: string;
  forgeToken: string;
  diag: Diagnostics;
  /** Per-request deadline; the submit call gets its own longer one (it pushes real git). */
  requestTimeoutMs?: number;
  submitTimeoutMs?: number;
  /** The seed call's own deadline — see DEFAULT_SEED_TIMEOUT_MS. */
  seedTimeoutMs?: number;
  /** The thread read's own deadline — see DEFAULT_THREAD_TIMEOUT_MS. */
  threadTimeoutMs?: number;
  /** How long a permission verdict stays good — see DEFAULT_PERMISSION_TTL_MS. 0 disables it. */
  permissionTtlMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** The seed call's own deadline — see `seedRadicleRepo`, and the bridge README's chain. */
const DEFAULT_SEED_TIMEOUT_MS = 45_000;
const DEFAULT_SUBMIT_TIMEOUT_MS = 120_000;
/**
 * A comment carrying an agent's images: before it writes, the forge resolves every ref and, for
 * Radicle, fetches each image's bytes and stores them in the repo as the comment's embeds — up
 * to ten of them. The generic deadline counted a slow embed write as a failed edit, and the
 * status-comment sweep then wrote the same edit again on every tick.
 */
const COMMENT_IMAGES_TIMEOUT_MS = 120_000;
/**
 * The environment reads fetch the upstream into the forge's cache first — for a repo the cache
 * has never seen that is a whole clone, and on Radicle the git door runs its own bounded network
 * fetch before it answers — so they get the submit's generous deadline, not the generic one.
 */
const ENVIRONMENT_READ_TIMEOUT_MS = 120_000;
/** A checks report's deadline: a GitHub report is a call per check (up to 32), a Radicle one
 * waits on the bridge, which gives up at 110 s — this outlasts it. */
const REPORT_TIMEOUT_MS = 120_000;
/** A check bundle's deadline: the upload of up to the forge's bundle cap from a laptop's link,
 * a cold base fetched into the cache, and a refresh of it when the laptop's base is newer. */
const CHECK_BUNDLE_TIMEOUT_MS = 10 * 60_000;
/** The header the check bundle's metadata rides in (@ryph/forge's `CHECK_BUNDLE_HEADER`): the
 * body is the bundle itself. */
const CHECK_BUNDLE_HEADER = "x-ryph-check-bundle";
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Every provider the forge may name — anything else in its answer is drift, refused. */
const FORGE_PROVIDERS: readonly ForgeProvider[] = ["github", "gitlab", "radicle", "local"];
/** The refusal reasons the local describe route may give — anything else is not one. */
const LOCAL_REFUSALS: readonly LocalRepoRefusalReason[] = [
  "not_absolute",
  "outside_root",
  "not_found",
  "not_directory",
  "not_a_repository",
  "linked_worktree",
  "bare_repository",
  "no_default_branch",
];

/**
 * Reading a thread is several GitHub round trips deep on the forge's side — a head request
 * and then, for a long PR, up to five pages of each listing. The generic 10s deadline fits a
 * single question and not this one, and a caller-side timeout that a real thread cannot meet
 * is worse than no timeout at all: every delivery fails, every retry fails the same way, and
 * the command never lands no matter how many times the queue tries.
 *
 * The chain this has to sit inside: the forge's event sink gives the orchestrator's whole
 * handler EVENT_SINK_TIMEOUT (60s), and the handler spends a permission check before getting
 * here. 45s leaves room for both and still fails a genuinely stuck forge rather than hanging.
 */
const DEFAULT_THREAD_TIMEOUT_MS = 45_000;

/**
 * The most a thread answer may weigh, read with a cap that bites while it streams. The text is
 * bounded by the forge's own budgets (a GitHub thread keeps ~200 000 characters per listing, a
 * Radicle one at most 2 000 entries of 16 000), and 32 MiB is room for the worst of that with
 * JSON's escaping; a read with images adds at most MAX_ATTACHMENTS of them, base64. Past the
 * cap the answer is "unavailable" — never buffered whole to be measured afterwards, which is the
 * allocation the cap exists to prevent.
 */
const THREAD_TEXT_MAX_BYTES = 32 * 1024 * 1024;
const THREAD_IMAGES_MAX_BYTES = MAX_ATTACHMENTS * Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;

/**
 * A change request's head is one question on the forge's side (one GitHub request, one bridge
 * call), so it gets a deadline of its own above the generic 10 s but well short of the thread
 * read's: a push's handler asks it twice (before filing and after) beside a permission check or
 * two, all inside the event sink's 60 s, and an answer slower than this is better retried.
 */
const CHANGE_REQUEST_HEAD_TIMEOUT_MS = 15_000;

/**
 * A merge's containment fetches each merged head into the forge's cache by id — on a cache that
 * never saw the repo, a whole clone first — before git answers, so it gets the environment
 * reads' budget.
 */
const MERGE_CONTAINMENT_TIMEOUT_MS = 120_000;

/**
 * Reading `.ryph/services.yml` refreshes the base first and falls back to the cached copy when
 * the upstream fails — but on a hanging GitHub the forge only gives up after minting a token
 * (15 s) and a fetch that stalls (30 s). The generic 10 s deadline cut that short, so an outage
 * refused every start the cached copy could have served.
 */
const SERVICES_FILE_TIMEOUT_MS = 60_000;

/** A patch diff stages the bundle on a base the forge may have to warm first — a fetch of the
 * whole repo on a cold cache — before git diffs it, so it gets the environment reads' budget. */
const PATCH_DIFF_TIMEOUT_MS = 120_000;

/** A patch's lineage is asked while its birth waits (the runner's report of it, a finalize), so
 * it gets less than a diff: the bases it stages on are the cache's, and no answer holds the
 * patch, which loses nothing. */
const PATCH_LINEAGE_TIMEOUT_MS = 20_000;

/**
 * How long one permission verdict is reused. The port already calls this answer "live, briefly
 * cacheable, never mirrored" — this is the "briefly".
 *
 * It exists because a permission check is not only asked at a gate. `canManage` on
 * GET /v1/workspaces is cosmetic — it decides whether a button is drawn — and it is asked for
 * EVERY member of EVERY workspace on every page load. Uncached, one ordinary list view is
 * dozens of live GitHub round trips, which walks an installation into its 5k/hr REST quota;
 * and once GitHub starts refusing, every check answers "unknown", which every gate here reads
 * as DENIED. A cosmetic poll would take task creation, patch approval and `/ryph` down with it.
 *
 * Short enough that access taken away on GitHub is honoured within seconds, which is the whole
 * point of checking live; long enough that one page's fan-out costs one question per repo.
 */
const DEFAULT_PERMISSION_TTL_MS = 15_000;

/**
 * The most verdicts held at once. On reaching it, expired entries are swept first; if that
 * frees nothing — a burst of distinct questions inside one TTL window — the oldest are evicted
 * until there is room. Expiry alone is not a bound, and a map that grew without one would also
 * make every later insert re-walk it. The key space is (repo, identity, threshold), so ordinary
 * use sits far below this.
 */
const MAX_CACHED_VERDICTS = 2_000;

/** The `github` field of the providers answer: a mode, null for "no GitHub here", or undefined
 * for anything that is neither — which refuses the whole answer. */
function githubModeOf(value: unknown): GithubMode | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === undefined) return undefined;
  const v = value as Record<string, unknown>;
  // Sign-in is offered only where the forge says the App holds an OAuth client.
  if (v.mode === "app") return { mode: "app", signIn: v.signIn === true };
  if (v.mode === "user" && typeof v.login === "string" && v.login.trim() !== "") {
    return { mode: "user", login: v.login };
  }
  return undefined;
}

/** GitLab's mode as the forge answers it: the mode, the account, and the instance's http(s) URL —
 * all three, or the answer is drift. */
function gitlabModeOf(value: unknown): GitlabMode | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === undefined) return undefined;
  const v = value as Record<string, unknown>;
  if (v.mode !== "bot" && v.mode !== "user") return undefined;
  if (typeof v.login !== "string" || v.login.trim() === "") return undefined;
  if (typeof v.url !== "string" || !URL.canParse(v.url)) return undefined;
  const protocol = new URL(v.url).protocol;
  if (protocol !== "https:" && protocol !== "http:") return undefined;
  // The token's account, on the instance the forge says it is at, or the answer is no answer.
  if (typeof v.accountId !== "string" || gitlabIdOn(v.accountId, v.url) === null) {
    return undefined;
  }
  // Sign-in is offered only where the forge says it holds an OAuth application.
  return {
    mode: v.mode,
    login: v.login,
    accountId: v.accountId,
    url: v.url,
    signIn: v.signIn === true,
  };
}

function radicleModeOf(value: unknown): RadicleMode | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === undefined) return undefined;
  const mode = (value as Record<string, unknown>).mode;
  return mode === "deployment" || mode === "user" ? { mode } : undefined;
}

/** One GitHub repo listing as the forge spells it — the four fields, the branch a git name. */
function isRepoListing(value: unknown): value is RepoListing {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.fullName === "string" && typeof v.url === "string" &&
    typeof v.defaultBranch === "string" && isGitRefName(v.defaultBranch) &&
    typeof v.private === "boolean";
}

/** A listing of the user-mode picker: the four fields and GitHub's admin bit, required. */
function isGithubRepoListing(value: unknown): value is GithubRepoListing {
  return isRepoListing(value) &&
    typeof (value as unknown as Record<string, unknown>).admin === "boolean";
}

/** GitLab's numeric project id, as the forge spells it: digits, as text. */
const GITLAB_PROJECT_ID = /^[1-9]\d{0,19}$/;
const GITLAB_VISIBILITIES: ReadonlySet<string> = new Set(["public", "internal", "private"]);

/**
 * A GitLab project as the forge listed it, held to the shapes a row and a webhook are built from:
 * a numeric id (the hook URL and token are bound to it), a path this side would store, http(s)
 * URLs, and a default branch that is a git name or null (an empty project). Exactly the seven
 * fields, whatever else the forge sent; anything else is drift, and null.
 */
function gitlabProjectListingOf(value: unknown): GitlabProjectListing | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const httpUrl = (u: unknown): u is string =>
    typeof u === "string" && URL.canParse(u) && /^https?:$/.test(new URL(u).protocol);
  if (
    typeof v.id !== "string" || !GITLAB_PROJECT_ID.test(v.id) ||
    typeof v.pathWithNamespace !== "string" || !isRepoRef("gitlab", v.pathWithNamespace) ||
    !httpUrl(v.url) || !httpUrl(v.webUrl) ||
    !(v.defaultBranch === null ||
      (typeof v.defaultBranch === "string" && isGitRefName(v.defaultBranch))) ||
    typeof v.visibility !== "string" || !GITLAB_VISIBILITIES.has(v.visibility) ||
    typeof v.admin !== "boolean"
  ) return null;
  return {
    id: v.id,
    pathWithNamespace: v.pathWithNamespace,
    url: v.url,
    webUrl: v.webUrl,
    defaultBranch: v.defaultBranch as string | null,
    visibility: v.visibility as GitlabProjectListing["visibility"],
    admin: v.admin,
  };
}

/** Exactly the four fields, whatever else the forge sent beside them. */
const repoListing = (r: RepoListing): RepoListing => ({
  fullName: r.fullName,
  url: r.url,
  defaultBranch: r.defaultBranch,
  private: r.private,
});

/**
 * An installation's settings page as the forge named it, or null. The forge alone knows the
 * GitHub web host (github.com or an Enterprise Server), so the host is its call; what is checked
 * here is that it is a plain https page ending in THIS installation's settings path, since a
 * browser is sent straight to it.
 */
export function installationSettingsUrl(raw: unknown, installationId: string): string | null {
  if (typeof raw !== "string" || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  const plain = url.protocol === "https:" && url.username === "" && url.password === "" &&
    url.search === "" && url.hash === "";
  const tail = `/settings/installations/${encodeURIComponent(installationId)}`;
  return plain && url.pathname.endsWith(tail) ? url.href : null;
}

export function httpForge(
  opts: HttpForgeOptions,
):
  & Forge
  & GithubConnect
  & GithubUserConnect
  & GitlabConnect
  & ForgeConnect
  & RadicleConnect
  & LocalConnect
  & ForgeChecks
  & ForgePatchDiffs
  & ForgeSkills {
  const { diag } = opts;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const seedTimeoutMs = opts.seedTimeoutMs ?? DEFAULT_SEED_TIMEOUT_MS;
  const permissionTtlMs = opts.permissionTtlMs ?? DEFAULT_PERMISSION_TTL_MS;
  /** Real verdicts only, keyed by the whole question — see DEFAULT_PERMISSION_TTL_MS. */
  const verdicts = new Map<string, { at: number; verdict: "allowed" | "denied" }>();

  const post = (path: string, body: unknown, deadlineMs: number): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.forgeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deadlineMs),
    });

  /** A comment's deadline: the images one names are written with it. */
  const commentDeadline = (body: string, runId: string | undefined): number =>
    runId !== undefined && imageRefsIn(body).length > 0 ? COMMENT_IMAGES_TIMEOUT_MS : timeoutMs;

  /** One environment read: the body on a 200, the forge's own words thrown otherwise. */
  const environmentRead = async (
    route: string,
    payload: unknown,
    // oxlint-disable-next-line typescript/no-explicit-any
  ): Promise<any> => {
    const res = await post(`/v1/service/${route}`, payload, ENVIRONMENT_READ_TIMEOUT_MS);
    const body = (await res.json().catch(() => null)) ?? {};
    if (res.ok) return body;
    const detail = typeof body.error === "string" ? body.error : `forge answered ${res.status}`;
    diag.warn("forge.environment_read_failed", { route, status: res.status, detail });
    throw new Error(`${route}: ${detail}`);
  };

  const get = (path: string, deadlineMs: number): Promise<Response> =>
    fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${opts.forgeToken}` },
      signal: AbortSignal.timeout(deadlineMs),
    });

  /** The two Radicle reads that share a shape: a RID in, a document out, null for "the node
   * holds no such repository" — which a 404 with `terminal` is the forge's way of saying. */
  const radicleRepoCall = async (
    path: string,
    repoRef: string,
  ): Promise<RadicleRepoInfo | null> => {
    const res = await post(path, { repoRef }, timeoutMs);
    const body = (await res.json().catch(() => null)) ?? {};
    if (res.ok && typeof body.rid === "string") return body as RadicleRepoInfo;
    if (res.status === 404 && body.terminal === true) return null;
    throw new Error(
      typeof body.error === "string" ? body.error : `the forge answered ${res.status}`,
    );
  };

  return {
    async providers(): Promise<ForgeProviders> {
      const res = await get("/v1/service/providers", timeoutMs);
      const body = (await res.json().catch(() => null)) ?? {};
      const github = githubModeOf(body.github);
      const gitlab = gitlabModeOf(body.gitlab);
      const radicle = radicleModeOf(body.radicle);
      if (
        res.ok && Array.isArray(body.providers) &&
        body.providers.every((p: unknown) => FORGE_PROVIDERS.includes(p as ForgeProvider)) &&
        // The mode is part of the answer, and says GitHub exactly when the list does: a forge
        // that names one without the other has drifted, and either half could be the wrong one.
        github !== undefined && (github !== null) === body.providers.includes("github") &&
        // GitLab's likewise: its mode decides webhooks, sign-in and who may connect.
        gitlab !== undefined && (gitlab !== null) === body.providers.includes("gitlab") &&
        // Radicle's likewise — and its mode decides who may connect a repository through it.
        radicle !== undefined && (radicle !== null) === body.providers.includes("radicle")
      ) {
        return { providers: body.providers, github, gitlab, radicle };
      }
      // No fallback. A forge that will not say what it runs is not evidence that it runs
      // GitHub: offering that would put a connect form in front of an App that may not exist,
      // and hiding a provider it does run would be no truer. The caller says so instead.
      diag.warn("forge.providers_unanswerable", { status: res.status });
      throw new Error(`the forge's providers answer is unusable (status ${res.status})`);
    },

    async listGithubRepos(): Promise<GithubRepoListing[]> {
      const res = await get("/v1/service/github/repos", timeoutMs);
      const body = (await res.json().catch(() => null)) ?? {};
      if (res.ok && Array.isArray(body.repos) && body.repos.every(isGithubRepoListing)) {
        return body.repos.map((r: GithubRepoListing) => ({ ...repoListing(r), admin: r.admin }));
      }
      diag.warn("forge.github_repos_unanswerable", { status: res.status });
      throw new Error(
        typeof body.error === "string" ? body.error : `the forge answered ${res.status}`,
      );
    },

    async describeGithubRepo(repoRef): Promise<RepoListing | null> {
      const res = await post("/v1/service/github/describe", { repoRef }, timeoutMs);
      const body = (await res.json().catch(() => null)) ?? {};
      if (res.ok && isRepoListing(body)) return repoListing(body);
      // Only the forge's own word that GitHub has no such repo is "none"; anything else unnamed
      // is a question that went unanswered.
      if (res.status === 404 && body.terminal === true) return null;
      diag.warn("forge.github_describe_unanswerable", { status: res.status });
      throw new Error(
        typeof body.error === "string" ? body.error : `the forge answered ${res.status}`,
      );
    },

    async describeLocalRepo(path): Promise<LocalRepoDescription> {
      const res = await post("/v1/service/local/describe", { path }, timeoutMs);
      const body = (await res.json().catch(() => null)) ?? {};
      if (
        res.ok && typeof body.repoRef === "string" && typeof body.url === "string" &&
        typeof body.defaultBranch === "string" && isGitRefName(body.defaultBranch)
      ) {
        return {
          kind: "described",
          repoRef: body.repoRef,
          url: body.url,
          defaultBranch: body.defaultBranch,
        };
      }
      if (res.status === 422 && LOCAL_REFUSALS.includes(body.reason)) {
        return {
          kind: "refused",
          reason: body.reason,
          error: typeof body.error === "string" ? body.error : `refused: ${body.reason}`,
          // Only where it means something, and only as an absolute path: anything else is not
          // a root the caller could be pointed at, and is dropped rather than shown.
          ...(body.reason === "outside_root" && typeof body.root === "string" &&
              body.root.startsWith("/")
            ? { root: body.root }
            : {}),
        };
      }
      if (res.status === 501) return { kind: "unsupported" };
      diag.warn("forge.local_describe_unanswerable", { status: res.status });
      throw new Error(
        typeof body.error === "string" ? body.error : `the forge answered ${res.status}`,
      );
    },

    async radicleIdentity(): Promise<RadicleIdentity> {
      const res = await get("/v1/service/radicle/identity", timeoutMs);
      const body = (await res.json().catch(() => null)) ?? {};
      if (!res.ok || typeof body.did !== "string") {
        throw new Error(
          typeof body.error === "string" ? body.error : `the forge answered ${res.status}`,
        );
      }
      return {
        did: body.did,
        nid: body.nid,
        alias: body.alias ?? null,
        node: body.node ?? null,
      };
    },

    describeRadicleRepo: (repoRef) => radicleRepoCall("/v1/service/radicle/repo", repoRef),

    async seedRadicleRepo(repoRef): Promise<RadicleSeedOutcome> {
      // Its own deadline, and the widest link of the fetch timeout chain: seeding makes the
      // bridge fetch the repository off the network (20s budget, 25s of subprocess), behind a
      // forge client that waits 30s. The ordinary 10s would abandon the call while the answer
      // was still being computed — which is exactly how a public repository came back as
      // "ryph's Radicle node did not answer". See `@ryph/radicle`'s README.
      const res = await post("/v1/service/radicle/seed", { repoRef }, seedTimeoutMs);
      const body = (await res.json().catch(() => null)) ?? {};
      if (res.ok && typeof body.rid === "string") {
        return { kind: "seeded", repo: body as RadicleRepoInfo };
      }
      // The forge's own 409: the node was asked and the network handed back nothing. Not a
      // failure to retry, and not a 404 either — see `RadicleRepoUnavailable`.
      if (res.status === 409 && body.kind === "unavailable" && typeof body.did === "string") {
        return body as RadicleRepoUnavailable;
      }
      // A user-mode bridge's: the owner's node blocks the repository.
      if (
        res.status === 409 && body.kind === "blocked" && typeof body.command === "string" &&
        typeof body.reason === "string"
      ) {
        return { kind: "blocked", rid: repoRef, command: body.command, reason: body.reason };
      }
      throw new Error(
        typeof body.error === "string" ? body.error : `the forge answered ${res.status}`,
      );
    },

    async unseedRadicleRepo(repoRef) {
      const res = await post("/v1/service/radicle/unseed", { repoRef }, timeoutMs);
      await res.body?.cancel();
      // Best-effort by contract: a disconnect stands whether or not the node let go, and
      // re-seeding a repo nobody connected is a nuisance, not a breach.
      if (!res.ok && res.status !== 404) {
        diag.warn("forge.radicle_unseed_failed", { repo: repoRef, status: res.status });
      }
    },

    async submitPatch(submission: PatchSubmission): Promise<SubmitOutcome> {
      try {
        const res = await post(
          "/v1/service/submit",
          submission,
          opts.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS,
        );
        const body = (await res.json().catch(() => null)) ?? {};
        if (res.status === 409 && body.code === "needs_approval") {
          // A hold, not a failure: nothing was pushed, and a person must look at the hook files
          // first. One this does not read is still a hold — retrying would only be held again —
          // but with nothing to show, so it names nothing and claims more.
          const parsed = PatchHooksAnswerSchema.safeParse(body);
          if (parsed.success) return { kind: "held", ...parsed.data };
          // A hold this cannot read names no file a person could be shown, so it cannot be
          // approved either. A retryable failure instead: it spends an attempt, and the patch
          // fails for good once they are gone, with a reason, rather than waiting forever.
          diag.warn("forge.submit_hold_malformed", { repo: submission.repo.repoRef });
          return {
            kind: "failed",
            message: "the forge held this patch for its git hook files, but its answer could " +
              "not be read",
            terminal: false,
          };
        }
        if (
          res.status === 201 && typeof body.ref === "string" &&
          (typeof body.url === "string" || body.url === null)
        ) {
          // A null url is the forge saying it has no web address for this change — a `local`
          // delivery is a branch in a repository on disk, with no page to link. "" means the
          // same from an older answer shape; both land as null, never an empty string that
          // renders as a broken link. Refusing either would retry a delivery that landed.
          return { kind: "submitted", ref: body.ref, url: body.url || null };
        }
        return {
          kind: "failed",
          message: typeof body.error === "string" ? body.error : `forge answered ${res.status}`,
          // The forge names terminality when it can; an unnamed failure is retryable.
          terminal: body.terminal === true,
          ...(body.ended === "merged" || body.ended === "closed" ? { ended: body.ended } : {}),
        };
      } catch (err) {
        diag.warn("forge.submit_unreachable", { err: String(err) });
        return { kind: "failed", message: `forge unreachable: ${err}`, terminal: false };
      }
    },

    async postComment(repo, thread, body, runId) {
      const res = await post(
        "/v1/service/comment",
        runId === undefined ? { repo, thread, body } : { repo, thread, body, runId },
        commentDeadline(body, runId),
      );
      const answer = (await res.json().catch(() => null)) ?? {};
      if (!res.ok || typeof answer.commentId !== "string") {
        throw new Error(`forge comment answered ${res.status}`);
      }
      return { commentId: answer.commentId };
    },

    async updateComment(repo, commentId, body, runId) {
      const res = await post(
        "/v1/service/comment/update",
        runId === undefined ? { repo, commentId, body } : { repo, commentId, body, runId },
        commentDeadline(body, runId),
      );
      await res.body?.cancel();
      if (!res.ok) throw new Error(`forge comment update answered ${res.status}`);
    },

    async addReaction(repo, commentId, reaction) {
      const res = await post("/v1/service/reaction", { repo, commentId, reaction }, timeoutMs);
      await res.body?.cancel();
      if (!res.ok) throw new Error(`forge reaction answered ${res.status}`);
    },

    async fetchThread(repo, thread, readOpts): Promise<ForgeThreadOutcome> {
      try {
        const res = await post(
          "/v1/service/thread",
          readOpts?.images === undefined
            ? { repo, thread }
            : { repo, thread, images: readOpts.images },
          Math.min(
            readOpts?.timeoutMs ?? Infinity,
            opts.threadTimeoutMs ?? DEFAULT_THREAD_TIMEOUT_MS,
          ),
        );
        const max = THREAD_TEXT_MAX_BYTES +
          (readOpts?.images === undefined ? 0 : THREAD_IMAGES_MAX_BYTES);
        const read = await readCappedBytes(res, max);
        if (!read.ok) {
          diag.warn("forge.thread_too_large", { repo: repo.repoRef, thread: thread.ref, max });
          return { kind: "unavailable" };
        }
        // oxlint-disable-next-line typescript/no-explicit-any
        let body: any = {};
        try {
          body = JSON.parse(new TextDecoder().decode(read.bytes));
        } catch {
          // Not JSON: the shape check below refuses it, as it would any half-shaped answer.
        }
        if (res.ok) {
          // Checked, not duck-typed. A half-shaped answer accepted here reaches the prompt
          // composer AFTER the delivery is claimed, where a missing field throws and the
          // claim swallows the redelivery that would have fixed it. Unparseable is
          // "unavailable" — which is retried — and never a thread.
          const parsed = ForgeThreadContextSchema.safeParse(body);
          if (parsed.success) {
            // A well-shaped answer about the WRONG thread is the quiet failure: the task
            // would be composed from some other issue's title and words while the progress
            // comment goes back to the thread that was actually commented on, and nothing
            // about the result would look wrong. Identity is part of the contract.
            if (parsed.data.kind !== thread.kind || parsed.data.ref !== thread.ref) {
              diag.warn("forge.thread_mismatched", {
                repo: repo.repoRef,
                asked: `${thread.kind}#${thread.ref}`,
                answered: `${parsed.data.kind}#${parsed.data.ref}`,
              });
              return { kind: "unavailable" };
            }
            return { kind: "thread", thread: parsed.data };
          }
          diag.warn("forge.thread_malformed", {
            repo: repo.repoRef,
            thread: thread.ref,
            why: parsed.error.issues.map((i) => i.path.join(".")).join(", "),
          });
          return { kind: "unavailable" };
        }
        // Only the forge's own "terminal" makes a thread gone. Everything else — a 502, a
        // malformed answer, a proxy's error page — is a question we failed to ask.
        if (res.status === 404 && body.terminal === true) {
          diag.warn("forge.thread_gone", { repo: repo.repoRef, thread: thread.ref });
          return { kind: "gone" };
        }
        diag.warn("forge.thread_unanswerable", { repo: repo.repoRef, status: res.status });
        return { kind: "unavailable" };
      } catch (err) {
        diag.warn("forge.thread_unreachable", { repo: repo.repoRef, err: String(err) });
        return { kind: "unavailable" };
      }
    },

    async fetchChangeRequestHead(repo, ref): Promise<ChangeRequestHeadOutcome> {
      try {
        const res = await post(
          "/v1/service/change-request-head",
          { repo, ref },
          CHANGE_REQUEST_HEAD_TIMEOUT_MS,
        );
        const body = (await res.json().catch(() => null)) ?? {};
        if (res.ok) {
          // Checked, as a thread is: a push's checks are decided on this answer, and a
          // half-shaped one, or one about another change request, is a question not answered.
          const parsed = ForgeChangeRequestStateSchema.safeParse(body);
          if (parsed.success && parsed.data.ref === ref) return { kind: "head", head: parsed.data };
          diag.warn("forge.change_request_head_malformed", {
            repo: repo.repoRef,
            ref,
            why: parsed.success
              ? `answered ${parsed.data.ref}`
              : parsed.error.issues.map((i) => i.path.join(".")).join(", "),
          });
          return { kind: "unavailable" };
        }
        // Only the forge's own "terminal" 404 is gone: a forge without this route, or a proxy's
        // error page, would otherwise read as every change request closed.
        if (res.status === 404 && body.terminal === true) return { kind: "gone" };
        diag.warn("forge.change_request_head_unanswerable", {
          repo: repo.repoRef,
          status: res.status,
        });
        return { kind: "unavailable" };
      } catch (err) {
        diag.warn("forge.change_request_head_unreachable", {
          repo: repo.repoRef,
          err: String(err),
        });
        return { kind: "unavailable" };
      }
    },

    async mergeContainment(
      repo,
      url,
      mergedHeads,
      heads,
      bases,
      into,
    ): Promise<MergeContainmentOutcome> {
      try {
        const res = await post(
          "/v1/service/merge-containment",
          { repo, url, mergedHeads, heads, bases, ...(into === undefined ? {} : { into }) },
          MERGE_CONTAINMENT_TIMEOUT_MS,
        );
        const body = (await res.json().catch(() => null)) ?? {};
        if (res.ok) {
          // Held to the question asked: every head answered exactly once, and nothing else. An
          // answer that does not partition what was asked is no answer, never a partial one.
          const asked = new Set(heads);
          const ids = (v: unknown): v is string[] =>
            Array.isArray(v) && v.every((h) => typeof h === "string" && asked.has(h));
          const answered = ids(body.contained) && ids(body.missed)
            ? [...body.contained, ...body.missed]
            : null;
          if (
            answered !== null && answered.length === asked.size &&
            new Set(answered).size === asked.size
          ) {
            return {
              kind: "answered",
              contained: body.contained,
              missed: body.missed,
              ...(typeof body.intoTip === "string" && COMMIT.test(body.intoTip)
                ? { intoTip: body.intoTip }
                : {}),
            };
          }
          diag.warn("forge.merge_containment_malformed", { repo: repo.repoRef });
          return { kind: "unavailable", message: "the forge's answer is malformed" };
        }
        const message = typeof body.error === "string"
          ? body.error
          : `forge answered ${res.status}`;
        // Only the forge's own terminal answer refuses — a request it will never read (400), or
        // an upstream with none of the merged heads (404). A forge without this route, or a
        // proxy's error page, is a question not answered yet.
        if ((res.status === 400 || res.status === 404) && body.terminal === true) {
          diag.warn("forge.merge_containment_refused", { repo: repo.repoRef, message });
          return { kind: "refused", message };
        }
        diag.warn("forge.merge_containment_unanswered", {
          repo: repo.repoRef,
          status: res.status,
          message,
        });
        return { kind: "unavailable", message };
      } catch (err) {
        diag.warn("forge.merge_containment_unreachable", { repo: repo.repoRef, err: String(err) });
        return { kind: "unavailable", message: String(err) };
      }
    },

    async patchLineage(repo, url, ask): Promise<PatchLineageOutcome> {
      // Spelled out field by field: the route's schema is strict, and a caller's patch row carries
      // more than a bundle's three names (a 400 the caller could only read as no answer).
      const bundle = (b: LineageBundle) => ({
        bundleKey: b.bundleKey,
        branchName: b.branchName,
        headSha: b.headSha,
      });
      try {
        const res = await post(
          "/v1/service/patch-lineage",
          {
            repo,
            url,
            connectedRepoId: ask.connectedRepoId,
            targetRef: ask.targetRef,
            patch: bundle(ask.patch),
            others: ask.others.map((o) => ({ ...bundle(o), line: o.line })),
            ...(ask.mustHold === undefined ? {} : { mustHold: ask.mustHold }),
          },
          PATCH_LINEAGE_TIMEOUT_MS,
        );
        const body = (await res.json().catch(() => null)) ?? {};
        if (res.ok) {
          // Held to the question asked: only lines asked about overlap, and a tip asked about
          // is answered.
          const asked = new Set(ask.others.map((o) => o.line));
          if (
            Array.isArray(body.overlaps) &&
            body.overlaps.every((l: unknown) => typeof l === "string" && asked.has(l)) &&
            (ask.mustHold === undefined || typeof body.holdsTip === "boolean")
          ) {
            return {
              kind: "answered",
              overlaps: body.overlaps,
              ...(ask.mustHold === undefined ? {} : { holdsTip: body.holdsTip }),
            };
          }
          diag.warn("forge.patch_lineage_malformed", { repo: repo.repoRef });
          return { kind: "unavailable", message: "the forge's answer is malformed" };
        }
        const message = typeof body.error === "string"
          ? body.error
          : `forge answered ${res.status}`;
        diag.warn("forge.patch_lineage_unanswered", { repo: repo.repoRef, status: res.status });
        return { kind: "unavailable", message };
      } catch (err) {
        diag.warn("forge.patch_lineage_unreachable", { repo: repo.repoRef, err: String(err) });
        return { kind: "unavailable", message: String(err) };
      }
    },

    async checkPermission(repo, identity, atLeast): Promise<ForgePermission> {
      // Access is per forge: an identity linked on another one says nothing here, and there is
      // nothing to ask. Definitive, so callers treat it as the refusal it is.
      if (identity.provider !== repo.provider) return "denied";
      // The whole question is the key: a verdict about one identity says nothing about another,
      // and "write" says nothing about "admin". A null subject is part of the question too, and
      // JSON keeps it distinct from every real name.
      const key = JSON.stringify([
        repo.provider,
        repo.tenantId,
        repo.repoRef,
        repo.forgeId ?? null,
        identity.subject,
        atLeast,
      ]);
      const now = Date.now();
      const cached = verdicts.get(key);
      if (cached !== undefined && now - cached.at < permissionTtlMs) return cached.verdict;
      try {
        const res = await post(
          "/v1/service/permission",
          // `subject` goes over the wire as null when there is no identity — the service's
          // schema takes it that way and hands it to the provider's adapter. It is NOT coerced
          // to a string here: an empty subject is a validation failure on the far side, which
          // would arrive as a 400 and be mapped to "unknown" below, i.e. a silent deny.
          { repo, subject: identity.subject, atLeast },
          timeoutMs,
        );
        const body = (await res.json().catch(() => null)) ?? {};
        if (res.ok && (body.permission === "allowed" || body.permission === "denied")) {
          // Only a real verdict is kept. An "unknown" below is the forge failing to answer,
          // and holding that would turn one blip into a window of denials that no retry could
          // get past — the opposite of what caching is for here.
          if (permissionTtlMs > 0) {
            if (verdicts.size >= MAX_CACHED_VERDICTS) {
              for (const [k, v] of verdicts) {
                if (now - v.at >= permissionTtlMs) verdicts.delete(k);
              }
              // Expired entries are no bound by themselves: inside one TTL window a burst of
              // distinct questions frees nothing at all, and the insert below would happen
              // anyway. Evict oldest-first until there is room, so the cap holds whatever the
              // traffic looks like. Iteration is insertion order; a key refreshed after expiry
              // keeps its original position, so a fresh entry can be evicted early — that costs
              // a later cache miss, never a wrong answer.
              while (verdicts.size >= MAX_CACHED_VERDICTS) {
                const oldest = verdicts.keys().next();
                if (oldest.done) break;
                verdicts.delete(oldest.value);
              }
            }
            verdicts.set(key, { at: now, verdict: body.permission });
          }
          return body.permission;
        }
        diag.warn("forge.permission_unanswerable", { status: res.status });
        return "unknown";
      } catch (err) {
        diag.warn("forge.permission_unreachable", { err: String(err) });
        return "unknown";
      }
    },

    async getInstallationSettingsUrl(installationId): Promise<string> {
      const res = await post("/v1/service/installation-settings", { installationId }, timeoutMs);
      const body = (await res.json().catch(() => null)) ?? {};
      const url = res.ok ? installationSettingsUrl(body.url, installationId) : null;
      if (url === null) {
        throw new Error(
          typeof body.error === "string"
            ? body.error
            : `forge installation settings answered ${res.status} with no valid URL`,
        );
      }
      return url;
    },

    async describeInstallation(
      installationId,
    ): Promise<{ accountLogin: string; settingsUrl: string | null; repos: RepoListing[] }> {
      const res = await post("/v1/service/installation", { installationId }, timeoutMs);
      const body = (await res.json().catch(() => null)) ?? {};
      if (!res.ok || typeof body.accountLogin !== "string" || !Array.isArray(body.repos)) {
        throw new Error(
          typeof body.error === "string" ? body.error : `forge installation answered ${res.status}`,
        );
      }
      return {
        accountLogin: body.accountLogin,
        settingsUrl: installationSettingsUrl(body.settingsUrl, installationId),
        repos: body.repos,
      };
    },

    async readServicesFile(repo, url, ref): Promise<ServicesFile> {
      try {
        const res = await post(
          "/v1/service/services-file",
          { repo, url, ref },
          SERVICES_FILE_TIMEOUT_MS,
        );
        const body = (await res.json().catch(() => null)) ?? {};
        if (res.ok && body.kind === "file" && typeof body.text === "string") {
          return { kind: "file", text: body.text, stale: body.stale === true };
        }
        if (res.ok && body.kind === "absent") return { kind: "absent" };
        if (res.ok && body.kind === "invalid" && typeof body.detail === "string") {
          return { kind: "invalid", detail: body.detail };
        }
        // Anything else — a 502 the forge named, a 400 from a ref it refused, a shape from a
        // version that does not have this route — is "we could not ask". Deliberately NOT
        // "absent": a deployment mid-rolling-upgrade would otherwise start every run of every
        // repo with its services silently dropped.
        const detail = typeof body.detail === "string"
          ? body.detail
          : typeof body.error === "string"
          ? body.error
          : `forge answered ${res.status}`;
        diag.warn("forge.services_unanswerable", { status: res.status, detail });
        return { kind: "unavailable", detail };
      } catch (err) {
        diag.warn("forge.services_unreachable", { err: String(err) });
        return { kind: "unavailable", detail: `forge unreachable: ${err}` };
      }
    },

    async checkPatchHooks(repo, url, ask): Promise<PatchHooksOutcome> {
      try {
        const res = await post(
          "/v1/service/local/patch-hooks",
          { repo, url, ...ask },
          PATCH_DIFF_TIMEOUT_MS,
        );
        const body = (await res.json().catch(() => null)) ?? {};
        if (res.ok) {
          const parsed = PatchHooksAnswerSchema.safeParse(body);
          if (parsed.success) return { kind: "checked", ...parsed.data };
          diag.warn("forge.patch_hooks_malformed", { repo: repo.repoRef });
          return {
            kind: "malformed",
            message: "the forge's answer about this patch's git hook files could not be read",
          };
        }
        const message = typeof body.error === "string" && body.error.trim() !== ""
          ? body.error.slice(0, 500)
          : `the forge answered ${res.status}`;
        // Only the forge's own word makes a failure terminal; an unnamed one is asked again.
        if (body.terminal === true) return { kind: "refused", message };
        diag.warn("forge.patch_hooks_unanswerable", { status: res.status });
        return { kind: "unavailable", message };
      } catch (err) {
        diag.warn("forge.patch_hooks_unreachable", { err: String(err) });
        return { kind: "unavailable", message: `forge unreachable: ${err}` };
      }
    },

    async readPatchDiff(repo, url, ask): Promise<PatchDiffOutcome> {
      try {
        const res = await post(
          "/v1/service/patch-diff",
          { repo, url, ...ask },
          PATCH_DIFF_TIMEOUT_MS,
        );
        const body = (await res.json().catch(() => null)) ?? {};
        if (res.ok) {
          const parsed = PatchDiffAnswerSchema.safeParse(body);
          if (parsed.success) return { kind: "diff", ...parsed.data };
          diag.warn("forge.patch_diff_malformed", { repo: repo.repoRef });
          return { kind: "unavailable", error: "the forge's answer was not one this reads" };
        }
        const error = typeof body.error === "string" ? body.error : `forge answered ${res.status}`;
        if (body.terminal === true) return { kind: "refused", status: res.status, error };
        diag.warn("forge.patch_diff_unanswerable", { status: res.status, error });
        return { kind: "unavailable", error };
      } catch (err) {
        diag.warn("forge.patch_diff_unreachable", { err: String(err) });
        return { kind: "unavailable", error: `forge unreachable: ${err}` };
      }
    },

    async readChecksFile(repo, url, commitOrRef): Promise<ChecksFile> {
      try {
        // The environment reads' deadline, not the ordinary one: the forge refreshes the base
        // from upstream before it pins a commit, and a cold cache is a fetch of the whole repo.
        const res = await post(
          "/v1/service/checks-file",
          { repo, url, commitOrRef },
          ENVIRONMENT_READ_TIMEOUT_MS,
        );
        const body = (await res.json().catch(() => null)) ?? {};
        if (res.ok) {
          const parsed = ChecksFileAnswerSchema.safeParse(body);
          if (parsed.success) return parsed.data;
          diag.warn("forge.checks_file_malformed", {
            repo: repo.repoRef,
            why: parsed.error.issues.map((i) => i.path.join(".")).join(", "),
          });
          return { kind: "unavailable", detail: "the forge's answer was not one this reads" };
        }
        const detail = typeof body.detail === "string"
          ? body.detail
          : typeof body.error === "string"
          ? body.error
          : `forge answered ${res.status}`;
        // A refusal the forge calls terminal (a ref it will never serve) is the declaration's
        // problem to report, not a read to retry for a day.
        if (body.terminal === true) return { kind: "invalid", commit: null, detail };
        // Everything else — the forge's own 502, a forge a version behind that has no such
        // route — is "we could not ask". Never "absent": a gated repo must not read as an
        // ungated one because a request failed.
        diag.warn("forge.checks_file_unanswerable", { status: res.status, detail });
        return { kind: "unavailable", detail };
      } catch (err) {
        diag.warn("forge.checks_file_unreachable", { err: String(err) });
        return { kind: "unavailable", detail: `forge unreachable: ${err}` };
      }
    },

    async readSkillsTree(repo, url, commitOrRef, knownTree): Promise<SkillsTree> {
      try {
        // The environment reads' deadline, for the checks read's reason: a connect is the cold
        // case, a whole clone before the forge can pin a commit, and the answer can be megabytes.
        const res = await post(
          "/v1/service/skills-tree",
          { repo, url, commitOrRef, knownTree },
          ENVIRONMENT_READ_TIMEOUT_MS,
        );
        const body = (await res.json().catch(() => null)) ?? {};
        if (res.ok) {
          const parsed = SkillsTreeAnswerSchema.safeParse(body);
          if (parsed.success) return parsed.data;
          diag.warn("forge.skills_tree_malformed", {
            repo: repo.repoRef,
            why: parsed.error.issues.map((i) => i.path.join(".")).join(", "),
          });
          return { kind: "unavailable", detail: "the forge's answer was not one this reads" };
        }
        // The branch being gone is an answer the settings page names in its own words; any other
        // refusal the forge calls terminal (a ref it will never serve) is the setting's problem,
        // not an outage to ask again about every hour.
        if (body.kind === "missing-ref") return { kind: "missing-ref" };
        const detail = typeof body.detail === "string"
          ? body.detail
          : typeof body.error === "string"
          ? body.error
          : `forge answered ${res.status}`;
        if (body.terminal === true) return { kind: "invalid", commit: null, detail };
        diag.warn("forge.skills_tree_unanswerable", { status: res.status, detail });
        return { kind: "unavailable", detail };
      } catch (err) {
        diag.warn("forge.skills_tree_unreachable", { err: String(err) });
        return { kind: "unavailable", detail: `forge unreachable: ${err}` };
      }
    },

    async reportChecks(repo, report): Promise<ReportChecksOutcome> {
      try {
        // `suite.previousGenerations` goes only when it names one: the forge's request schema is
        // strict, so an empty list is left off rather than sent.
        const { previousGenerations, ...suite } = report.suite;
        const body = previousGenerations === undefined || previousGenerations.length === 0
          ? { repo, report: { ...report, suite } }
          : { repo, report: { ...report, suite: { ...suite, previousGenerations } } };
        // Its own budget: a GitHub report is a call per check, a Radicle one the bridge's job
        // lists — minutes at worst, where every read here is seconds.
        const res = await post("/v1/service/checks/report", body, REPORT_TIMEOUT_MS);
        const answer = (await res.json().catch(() => null)) ?? {};
        if (res.ok) {
          const parsed = ReportChecksAnswerSchema.safeParse(answer);
          if (parsed.success) return parsed.data;
          return {
            kind: "failed",
            message: "the forge's answer was not one this reads",
            terminal: false,
          };
        }
        return {
          kind: "failed",
          message: typeof answer.error === "string" ? answer.error : `forge answered ${res.status}`,
          // The forge names terminality when it can; an unnamed failure is retryable.
          terminal: answer.terminal === true,
        };
      } catch (err) {
        diag.warn("forge.checks_report_unreachable", { err: String(err) });
        return { kind: "failed", message: `forge unreachable: ${err}`, terminal: false };
      }
    },

    async readCheckBundle(bundleKey) {
      const res = await post("/v1/service/check-bundle/read", { bundleKey }, timeoutMs);
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok || res.body === null) {
        await res.body?.cancel();
        throw new Error("could not read the check bundle from the forge");
      }
      return res.body;
    },

    async stageCheckBundle(repo, url, ask: CheckBundleAsk, body): Promise<StageCheckBundleOutcome> {
      // A header value is Latin-1, and a branch name may not be: everything past ASCII rides as
      // a JSON escape, which the forge's parse reads back as the same string.
      const meta = JSON.stringify({ repo, url, ...ask }).replace(
        /[\u007f-\uffff]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
      try {
        const res = await fetch(`${base}/v1/service/check-bundle`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.forgeToken}`,
            "content-type": "application/octet-stream",
            [CHECK_BUNDLE_HEADER]: meta,
          },
          body,
          signal: AbortSignal.timeout(CHECK_BUNDLE_TIMEOUT_MS),
          // The forge answers only once the bundle is in and its base fetched, which can take
          // longer than Bun's fetch idle timeout (300 s, fired on a coarse tick: about six
          // minutes) allows a silent response, and bytes going up do not reset it. The deadline
          // above is the bound.
          timeout: false,
        } as RequestInit);
        const answer = (await res.json().catch(() => null)) ?? {};
        if (res.status === 201) {
          if (
            typeof answer.headSha === "string" && COMMIT.test(answer.headSha) &&
            typeof answer.bundleKey === "string"
          ) return { kind: "staged", headSha: answer.headSha, bundleKey: answer.bundleKey };
          diag.warn("forge.check_bundle_malformed", { repo: repo.repoRef });
          return { kind: "unavailable", error: "the forge's answer was not one this reads" };
        }
        const error = typeof answer.error === "string"
          ? answer.error
          : `forge answered ${res.status}`;
        // Only the forge's own word that the bundle is at fault is final: a proxy's 400 page is
        // not a verdict on anybody's bundle.
        if ((res.status === 400 || res.status === 413) && answer.terminal === true) {
          return {
            kind: "refused",
            status: res.status,
            error,
            detail: typeof answer.detail === "string" ? answer.detail : null,
          };
        }
        diag.warn("forge.check_bundle_unanswerable", { repo: repo.repoRef, status: res.status });
        return { kind: "unavailable", error };
      } catch (err) {
        diag.warn("forge.check_bundle_unreachable", { repo: repo.repoRef, err: String(err) });
        return { kind: "unavailable", error: `forge unreachable: ${err}` };
      }
    },

    async readBranchHead(repo, url, branch): Promise<BranchHeadOutcome> {
      try {
        // The environment reads' deadline: the forge may fetch the repo into its cache first.
        const res = await post(
          "/v1/service/branch-head",
          { repo, url, branch },
          ENVIRONMENT_READ_TIMEOUT_MS,
        );
        const body = (await res.json().catch(() => null)) ?? {};
        if (res.ok && typeof body.sha === "string" && COMMIT.test(body.sha)) {
          return { kind: "head", sha: body.sha };
        }
        if (res.status === 404 && body.terminal === true) return { kind: "absent" };
        if (res.status === 501) return { kind: "unsupported" };
        const error = typeof body.error === "string" ? body.error : `forge answered ${res.status}`;
        diag.warn("forge.branch_head_unanswerable", { repo: repo.repoRef, status: res.status });
        return { kind: "unavailable", error };
      } catch (err) {
        diag.warn("forge.branch_head_unreachable", { repo: repo.repoRef, err: String(err) });
        return { kind: "unavailable", error: `forge unreachable: ${err}` };
      }
    },

    async repoVisibility(repo): Promise<ForgeRepoVisibility> {
      try {
        const res = await post("/v1/service/visibility", { repo }, timeoutMs);
        const body = (await res.json().catch(() => null)) ?? {};
        if (res.ok && (body.visibility === "public" || body.visibility === "private")) {
          return body.visibility;
        }
        diag.warn("forge.visibility_unanswerable", { repo: repo.repoRef, status: res.status });
        return "unknown";
      } catch (err) {
        diag.warn("forge.visibility_unreachable", { repo: repo.repoRef, err: String(err) });
        return "unknown";
      }
    },

    async ryphTree(repo, url, commitOrRef): Promise<RyphTree> {
      const body = await environmentRead("ryph-tree", { repo, url, commitOrRef });
      if (
        typeof body.commit !== "string" || !COMMIT.test(body.commit) ||
        !(body.tree === null || (typeof body.tree === "string" && COMMIT.test(body.tree))) ||
        !(body.fullTree === null ||
          (typeof body.fullTree === "string" && COMMIT.test(body.fullTree))) ||
        (body.fullTree === null) !== (body.tree === null) ||
        typeof body.dockerfile !== "boolean" ||
        !(body.dockerfileBlob === null ||
          (typeof body.dockerfileBlob === "string" && COMMIT.test(body.dockerfileBlob))) ||
        body.dockerfile !== (body.dockerfileBlob !== null)
      ) {
        throw new Error("the forge's ryph-tree answer is malformed");
      }
      const dockerfile = body.tree !== null && body.dockerfile;
      return {
        commit: body.commit,
        tree: body.tree,
        fullTree: body.fullTree,
        dockerfile,
        dockerfileBlob: dockerfile ? body.dockerfileBlob : null,
      };
    },

    async ryphBase(repo, url, head, base): Promise<RyphBase> {
      const body = await environmentRead("ryph-base", { repo, url, head, base });
      const id = (v: unknown) => typeof v === "string" && COMMIT.test(v);
      if (
        !id(body.base) || !(body.mergeBase === null || id(body.mergeBase)) ||
        !(body.tree === null || id(body.tree)) || !Array.isArray(body.changed) ||
        !body.changed.every((p: unknown) => typeof p === "string" && p.startsWith(".ryph/"))
      ) {
        throw new Error("the forge's ryph-base answer is malformed");
      }
      return {
        base: body.base,
        mergeBase: body.mergeBase,
        tree: body.mergeBase === null ? null : body.tree,
        changed: body.mergeBase === null ? [] : body.changed.slice(0, 50),
      };
    },

    async defaultBranchHead(repo, url): Promise<DefaultBranchHead> {
      const body = await environmentRead("default-branch-head", { repo, url });
      if (
        typeof body.ref !== "string" || !isGitRefName(body.ref) ||
        typeof body.commit !== "string" || !COMMIT.test(body.commit)
      ) {
        throw new Error("the forge's default-branch-head answer is malformed");
      }
      return { ref: body.ref, commit: body.commit };
    },

    async branchKind(repo, url, ref): Promise<ForgeBranchKind> {
      const body = await environmentRead("branch-kind", { repo, url, ref });
      if (body.kind !== "default" && body.kind !== "branch" && body.kind !== "foreign") {
        throw new Error("the forge's branch-kind answer is malformed");
      }
      return body.kind;
    },

    async checkOrgMembership(installationId, login): Promise<ForgeOrgMembership> {
      try {
        const res = await post(
          "/v1/service/org-membership",
          { provider: "github", installationId, login },
          timeoutMs,
        );
        const body = (await res.json().catch(() => null)) ?? {};
        if (res.ok && (body.membership === "member" || body.membership === "not-member")) {
          return body.membership;
        }
        diag.warn("forge.membership_unanswerable", { status: res.status });
        return "unknown";
      } catch (err) {
        diag.warn("forge.membership_unreachable", { err: String(err) });
        return "unknown";
      }
    },

    async exchangeOAuthCode(code): Promise<ForgeIdentity> {
      return await this.exchangeForgeOAuthCode("github", code, null);
    },

    async exchangeForgeOAuthCode(provider, code, leg): Promise<ForgeIdentity> {
      if (provider === "gitlab" && leg === null) {
        throw new Error("a GitLab code is redeemed with the redirect URI it was issued for");
      }
      const res = await post(
        "/v1/service/oauth/exchange",
        provider === "gitlab" && leg !== null
          ? {
            provider,
            code,
            redirectUri: leg.redirectUri,
            ...(leg.codeVerifier === null ? {} : { codeVerifier: leg.codeVerifier }),
          }
          : { provider, code },
        timeoutMs,
      );
      const body = (await res.json().catch(() => null)) ?? {};
      if (!res.ok || typeof body.login !== "string" || typeof body.accountId !== "string") {
        throw new Error(
          typeof body.error === "string" ? body.error : `oauth exchange answered ${res.status}`,
        );
      }
      return {
        accountId: body.accountId,
        login: body.login,
        name: typeof body.name === "string" ? body.name : null,
        verifiedEmails: Array.isArray(body.verifiedEmails)
          ? body.verifiedEmails.filter((e: unknown): e is string => typeof e === "string")
          : [],
        accessToken: typeof body.accessToken === "string" ? body.accessToken : null,
      };
    },

    async checkForgeMembership(provider, who, installationId) {
      if (provider === "github") {
        return installationId === null
          ? "no-organization"
          : await this.checkOrgMembership(installationId, who);
      }
      try {
        // GitLab's gate is asked about the account id, never a username.
        const res = await post(
          "/v1/service/org-membership",
          { provider, accountId: who },
          timeoutMs,
        );
        const body = (await res.json().catch(() => null)) ?? {};
        if (
          res.ok &&
          (body.membership === "member" || body.membership === "not-member" ||
            body.membership === "no-organization")
        ) {
          return body.membership;
        }
        diag.warn("forge.membership_unanswerable", { provider, status: res.status });
        return "unknown";
      } catch (err) {
        diag.warn("forge.membership_unreachable", { provider, err: String(err) });
        return "unknown";
      }
    },

    // GitLab's connect surface: the projects the forge's token reaches, one of them read live,
    // and a project's webhook token. Each throws when the forge did not answer.
    async listGitlabProjects(): Promise<GitlabProjectListing[]> {
      const res = await get("/v1/service/gitlab/projects", timeoutMs);
      const body = (await res.json().catch(() => null)) ?? {};
      const projects = res.ok && Array.isArray(body.projects)
        ? body.projects.map(gitlabProjectListingOf)
        : null;
      // One malformed listing refuses the whole answer, as GitHub's does: a picker that quietly
      // dropped a project would read as "the bot cannot reach it".
      if (projects !== null && projects.every((p: GitlabProjectListing | null) => p !== null)) {
        return projects;
      }
      diag.warn("forge.gitlab_projects_unanswerable", { status: res.status });
      throw new Error(
        typeof body.error === "string" ? body.error : `the forge answered ${res.status}`,
      );
    },

    async describeGitlabProject(project): Promise<GitlabProjectListing | null> {
      const res = await post("/v1/service/gitlab/describe", { project }, timeoutMs);
      const body = (await res.json().catch(() => null)) ?? {};
      const listing = res.ok ? gitlabProjectListingOf(body) : null;
      if (listing !== null) return listing;
      // Only the forge's own word that GitLab shows no such project is "none".
      if (res.status === 404 && body.terminal === true) return null;
      diag.warn("forge.gitlab_describe_unanswerable", { status: res.status });
      throw new Error(
        typeof body.error === "string" ? body.error : `the forge answered ${res.status}`,
      );
    },

    async gitlabLogin(accountId): Promise<string | null> {
      const res = await post("/v1/service/gitlab/user", { accountId }, timeoutMs);
      const body = (await res.json().catch(() => null)) ?? {};
      if (res.ok && typeof body.login === "string" && body.login.trim() !== "") return body.login;
      if (res.status === 404 && body.terminal === true) return null;
      diag.warn("forge.gitlab_user_unanswerable", { status: res.status });
      throw new Error(
        typeof body.error === "string" ? body.error : `the forge answered ${res.status}`,
      );
    },

    async gitlabHookToken(projectId, generation): Promise<string> {
      const res = await post(
        "/v1/service/gitlab/hook-token",
        { projectId, generation },
        timeoutMs,
      );
      const body = (await res.json().catch(() => null)) ?? {};
      // hex(HMAC-SHA256(…)): 64 lowercase hex digits, and nothing else is a token GitLab could
      // be told to send back.
      if (res.ok && typeof body.token === "string" && /^[0-9a-f]{64}$/.test(body.token)) {
        return body.token;
      }
      diag.warn("forge.gitlab_hook_token_unanswerable", { status: res.status });
      throw new Error(
        typeof body.error === "string" ? body.error : `the forge answered ${res.status}`,
      );
    },
  };
}

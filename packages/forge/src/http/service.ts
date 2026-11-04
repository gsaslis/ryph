// Door ③'s inward face: the service surface the ORCHESTRATOR dials — submit a patch, post a
// comment, check a permission or a repo's visibility, describe an installation, exchange an OAuth
// code, read a repo's service declaration. The control plane decided; this surface acts, with the credentials only
// this package holds.
//
// Invariants:
// - authenticated with the shared RYPH_FORGE_TOKEN, constant-time — the same trust domain
//   as the gateway's resolve calls, in the other direction
// - every submit failure names whether it is TERMINAL: the orchestrator's retry clock
//   depends on the distinction, and only this side knows GitHub's semantics
// - the git half of a submission is idempotent by measurement (re-push = up-to-date, exit
//   0); the PR half is idempotent by find-and-adopt in the API adapter — a retried
//   submission converges on the same PR, never a second one
// - the reads of a repo's contents read ONE FIXED PATH each out of the local cache entry — the
//   services file's bytes, the checks file's bytes, and the `.ryph/` directory's tree id (an id,
//   never content) — and ONE FIXED PREFIX, `.agents/skills/`, for the org skills repo's sync,
//   whose every path is one the tree listing returned. This surface holds an installation token
//   for every connected repo; a general file-read API on it would be a general repo-read API on
//   all of them. The one read wider than a fixed path is a patch's diff, pinned to the bundle
//   intake filed for that repo's head: it shows the change the bundle makes, nothing the bundle
//   does not touch
// - a body the orchestrator sends on for a run (the change request's description, the status
//   comment) shows that run's images: its `![alt](img-…)` refs are resolved against `runId` and
//   rendered for the forge here (core/images.ts), and a ref the run does not hold fails the
//   write as terminal — the same refusal an agent's own write meets

import { rm, writeFile } from "node:fs/promises";
import { makeServiceGate } from "@ryph/sealed";
import { describeIssues, json, readCapped, type Route, route } from "@ryph/shared/http";

/** Fits 32 check summaries of 60,000 characters even with JSON escaping, plus metadata.
 * Bundles use the separate streaming intake, not this JSON budget. */
export const MAX_SERVICE_BODY_BYTES = 16 * 1024 * 1024;
import {
  ForgeApiError,
  type ForgeRegistry,
  type ForgeRepo,
  forgeRepoOf,
} from "../ports/forge_api.ts";
import type { ChangeTransportRegistry } from "../ports/change_transport.ts";
import type { GithubAppApi, GithubMode, GithubUserApi } from "../ports/github_app.ts";
import type { GitlabConnectApi } from "../ports/gitlab.ts";
import type { RadicleBridgeApi } from "../ports/radicle_bridge.ts";
import {
  isExitOne,
  makeCatFileBatch,
  makeGit,
  makeGitBounded,
  makeGitCapped,
  makeGitInput,
  makeGitRaw,
} from "../helpers/git_exec.ts";
import { readBundleHeader } from "../helpers/bundle.ts";
import {
  isAncestor,
  patchDiff,
  TipUnavailableError,
  UnanchoredDiffError,
} from "../helpers/patch_diff.ts";
import { containedIn, NotACommit } from "../helpers/containment.ts";
import { stageBundle, type StagedBundle, TerminalSubmitError } from "../helpers/submit.ts";
import { HookCheckTooLargeError, hookFilesOfPatch } from "../helpers/hook_files.ts";
import { reportHookFiles } from "../core/hook_files.ts";
import {
  hasBlob,
  readBlobId,
  readRepoFile,
  readTreeId,
  readTreeIdWithout,
  resolveBranch,
} from "../helpers/repo_file.ts";
import { readSkillsTree } from "../helpers/skill_tree.ts";
import { describeLocalRepo } from "../helpers/local_repo.ts";
import { changeRequestHeadRef, isChangeRequestHeadName, normalizeBaseRef } from "@ryph/shared/refs";
import { ImageRefError, imageStyleOf, type RenderedBody, renderImages } from "../core/images.ts";
import type { BranchKind, ForgeProvider, RepoCoords } from "../core/types.ts";
import { type Credential, UpstreamRefused } from "../ports/repo_cache.ts";
import {
  basesOf,
  BranchHeadRequestSchema,
  BranchKindRequestSchema,
  ChangeRequestHeadRequestSchema,
  CheckBundleRequestSchema,
  ChecksFileRequestSchema,
  CommentRequestSchema,
  CommentUpdateSchema,
  DefaultBranchHeadRequestSchema,
  GithubDescribeRequestSchema,
  GitlabDescribeRequestSchema,
  GitlabHookTokenRequestSchema,
  GitlabUserRequestSchema,
  InstallationRequestSchema,
  intoOf,
  LocalDescribeRequestSchema,
  MergeContainmentRequestSchema,
  OAuthExchangeSchema,
  OrgMembershipRequestSchema,
  PatchDiffRequestSchema,
  PatchLineageRequestSchema,
  PermissionRequestSchema,
  RadicleRepoRequestSchema,
  ReactionRequestSchema,
  ReadCheckBundleSchema,
  ReportChecksRequestSchema,
  RyphBaseRequestSchema,
  RyphTreeRequestSchema,
  ServicesFileRequestSchema,
  SkillsTreeRequestSchema,
  SubmitRequestSchema,
  ThreadRequestSchema,
  VisibilityRequestSchema,
} from "../schema.ts";
import { credentialFor, located } from "./fetch_auth.ts";
import {
  bundleVerifier,
  checkBundleKey,
  soleRef,
  stageStream,
  stageUpload,
} from "./bundle_intake.ts";
import type { AppDeps } from "./app.ts";
import type { z } from "@zod/zod";

/**
 * The only paths this surface will read out of a repo. Constants and not a parameter: see
 * ServicesFileRequestSchema on why no path ever crosses the wire.
 *
 * Both spellings, because @ryph/runner accepts both for `setup.yml` and a repo will
 * reasonably assume the same here. Reading only `.yml` made a `.yaml` file invisible to the
 * control plane and then blamed the operator's switch when the run refused — a trap with no
 * signpost. `.yml` still wins, matching readSetup.
 */
export const SERVICES_FILE_PATHS = [".ryph/services.yml", ".ryph/services.yaml"] as const;

/**
 * The ceiling on that file. Repo-authored YAML parsed inside the CONTROL PLANE's process is new
 * — everything repo-authored until now was parsed inside the run's sandbox — so the bytes are
 * bounded before anything decodes them. 64 KiB is ~500 services' worth: generous for any real
 * declaration, small enough that an adversarial one is not interesting.
 */
export const MAX_SERVICES_FILE_BYTES = 65_536;

/** The one directory whose tree id the environment read answers — a constant, for
 * `SERVICES_FILE_PATHS`'s reason. */
export const RYPH_DIR = ".ryph";
/** How many changed paths under `.ryph/` the merge-base read names, at most. */
const MAX_RYPH_CHANGED = 50;

/**
 * How long one merge containment read may take, the wait for the repo's cache entry included:
 * under the control plane's 120 s request timeout, so a read that runs out answers a retryable
 * 502 rather than leaving the caller to time out on its own. Git stops with it, except a fetch
 * the read already started: that one runs to its end with the entry held (`HeldEntry.hold`), so
 * a repo too big to fetch within the budget is held for the next ask, and no further fetch
 * starts after it.
 */
const MERGE_CONTAINMENT_BUDGET_MS = 90_000;

/**
 * The only paths the checks read will look for the repo's check definition at — constants, for
 * `SERVICES_FILE_PATHS`'s reason, in the same two spellings, and `.yml` wins the same way.
 */
export const CHECKS_FILE_PATHS = [".ryph/checks.yml", ".ryph/checks.yaml"] as const;

/**
 * The files under `.ryph/` no environment build reads: the check definition and the service
 * containers are the control plane's, and environment.md is read by each run from its own
 * checkout. The `.ryph` tree id every read here answers leaves them out, so a branch that
 * changed only these describes the same machine and nothing is built for it. Anything else
 * under `.ryph/` counts, since a setup step or the Dockerfile may read it.
 */
export const RYPH_NOT_BUILT: ReadonlySet<string> = new Set(
  [...CHECKS_FILE_PATHS, ...SERVICES_FILE_PATHS, `${RYPH_DIR}/environment.md`]
    .map((path) => path.slice(RYPH_DIR.length + 1)),
);

/**
 * The ceiling on that file, applied before anything decodes it, for `MAX_SERVICES_FILE_BYTES`'s
 * reason: it is repo-authored YAML the control plane parses in its own process. 64 KiB is far
 * past the 32 checks a suite may carry.
 */
export const MAX_CHECKS_FILE_BYTES = 65_536;

/** Where the check-bundle route's metadata rides: the body is the bundle itself. */
export const CHECK_BUNDLE_HEADER = "x-ryph-check-bundle";

/** How often a failed check-bundle verify may refresh one base from the upstream. */
export const CHECK_BUNDLE_REFRESH_INTERVAL_MS = 60_000;

/** The branch a merge went into as the upstream names it (`main`, `refs/heads/main`), or
 * undefined for a name the ref rules refuse or a ref that is no branch: such a target is as good
 * as none named. */
function intoBranch(raw: unknown): string | undefined {
  const into = intoOf(raw);
  if (into === undefined) return undefined;
  try {
    const { remoteRef, localBranch } = normalizeBaseRef(into);
    return remoteRef === `refs/heads/${localBranch}` ? localBranch : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The most diff the patch-diff route answers with. Far past any change a person reviews line by
 * line, and small enough to ride one JSON response to a browser; a bigger one is cut at a file.
 */
export const MAX_PATCH_DIFF_BYTES = 4 * 1024 * 1024;
/** Bumped whenever how a diff is made changes, so diffs filed the old way are made again. */
const PATCH_DIFF_VERSION = 6;

/** A full commit id, as opposed to a branch name — which of the two a tree read was given. */
const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The 501s GitLab's routes answer: no GitLab here at all, or one in user mode, which has no
 * webhooks, no sign-in and no sign-up group (one person's token, as GitHub user mode). */
const NO_GITLAB = "no GitLab is configured";
const GITLAB_USER_MODE = "GitLab is in user mode (one person's token)";

export function serviceRoutes(
  deps: AppDeps,
  serviceToken: string,
  forges: ForgeRegistry,
  transports: ChangeTransportRegistry,
  /** GitHub's own connect surfaces, at most one of them set. `app` null — no App, or a forge
   * in user mode — and the installation, membership and OAuth routes answer 501 rather than
   * existing as a lie; `user` null, and the repo listing and describe routes do. */
  github: { app: GithubAppApi | null; user: GithubUserApi | null },
  /** Radicle's own connect surface — seeding and identity documents. Null where no bridge is
   * configured (`RYPH_RADICLE_URL` unset), and its routes then answer 501 for the same
   * reason GitHub's do. */
  radicle: RadicleBridgeApi | null = null,
  /** The allowed root for `local` repos (RYPH_LOCAL_REPO_ROOT). Null where the local provider is
   * off, and its describe route then answers 501, as Radicle's do without a bridge. */
  localRoot: string | null = null,
  /** GitLab's connect surface. Null where no GitLab is configured, and its routes then answer
   * 501 as Radicle's do without a bridge. */
  gitlab: GitlabConnectApi | null = null,
): Route[] {
  const { diag, cache, patches, config } = deps;
  const githubApp = github.app;
  const githubUser = github.user;
  /** How this forge acts on GitHub, for the control plane — null where it does not at all. */
  const githubMode: GithubMode | null = githubUser !== null
    ? { mode: "user", login: githubUser.login }
    : forges.has("github")
    ? { mode: "app", signIn: githubApp?.signIn ?? false }
    : null;
  const gitExec = makeGit(diag);
  // For file CONTENT only, which must reach the control plane byte for byte (helpers/repo_file.ts).
  const gitRaw = makeGitRaw(diag);
  // For a diff, whose size is the change's and not ours: held up to a cap, never whole.
  const gitCapped = makeGitCapped(diag);
  const gitBounded = makeGitBounded(diag);
  // For blobs that may be binary (`assets/` under a skill), byte for byte.
  const catFile = makeCatFileBatch(diag);
  const verify = bundleVerifier(diag);

  const authenticated = makeServiceGate(serviceToken);

  /**
   * A body with its images rendered for its forge — or the response that refuses it: a 422,
   * terminal, for refs the run does not hold (no retry changes that), and a 502 for a control
   * plane that did not answer.
   */
  const render = async (
    provider: ForgeProvider,
    runId: string | undefined,
    text: string,
  ): Promise<{ ok: true; body: RenderedBody } | { ok: false; res: Response }> => {
    try {
      return {
        ok: true,
        body: await renderImages(deps.images ?? null, runId ?? null, text, imageStyleOf(provider)),
      };
    } catch (err) {
      if (err instanceof ImageRefError) {
        return { ok: false, res: json(422, { error: err.message, terminal: true }) };
      }
      diag.warn("service.images_unavailable", { runId, err: String(err) });
      return {
        ok: false,
        res: json(502, { error: `the images could not be looked up: ${err}`, terminal: false }),
      };
    }
  };

  const parse = async <T>(
    req: Request,
    schema: z.ZodType<T>,
  ): Promise<{ ok: true; data: T } | { ok: false; res: Response }> => {
    // A malformed body is terminal: no retry re-shapes the bytes the orchestrator already sent.
    // Saying so keeps a permanently invalid submission off the retry clock.
    let raw: unknown;
    try {
      const text = await readCapped(req, MAX_SERVICE_BODY_BYTES);
      if (text === null) {
        return {
          ok: false,
          res: json(413, {
            error: `body exceeds ${MAX_SERVICE_BODY_BYTES}-byte limit`,
            terminal: true,
          }),
        };
      }
      raw = JSON.parse(text);
    } catch {
      return { ok: false, res: json(400, { error: "body is not valid JSON", terminal: true }) };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        res: json(400, { error: describeIssues(parsed.error), terminal: true }),
      };
    }
    return { ok: true, data: parsed.data };
  };

  const submit = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, SubmitRequestSchema);
    if (!body.ok) return body.res;
    const s = body.data;
    // A run on a pull request's head (`pull/<n>/head`, a fork's code) delivers onto that pull
    // request or nowhere: never as a branch of its own in the repo with a change request beside
    // it. The control plane holds its patches to the same (core/reaper.ts); this is the backstop.
    // The same for a merge request's (`merge-requests/<iid>/head`).
    const ownHead = s.changeRequest === undefined
      ? null
      : changeRequestHeadRef(s.repo.provider, s.changeRequest)?.slice("refs/".length) ?? null;
    if (isChangeRequestHeadName(s.baseBranch) && s.baseBranch !== ownHead) {
      return json(422, {
        error: `a run on ${s.baseBranch} delivers only onto its own change request`,
        terminal: true,
      });
    }
    // Before the bundle is staged: a description whose images are refused is refused whole.
    const description = await render(s.repo.provider, s.runId, s.body);
    if (!description.ok) return description.res;

    // The durable artifact. Gone means gone — nothing a retry could bring back.
    const bundle = await patches.get(s.bundleKey);
    if (bundle === null) {
      return json(410, { error: `no bundle at ${s.bundleKey}`, terminal: true });
    }
    const staged = `${config.stagingDir}/${crypto.randomUUID()}.bundle`;
    try {
      await stageStream(bundle, staged);

      // Which transport delivers it is the connected repo's own answer, carried on the
      // request: this route holds the bundle and the retry contract, and knows nothing about
      // how any one forge takes it.
      let transport;
      try {
        transport = transports.for(s.repo.provider);
      } catch (err) {
        diag.warn("service.no_transport", { provider: s.repo.provider, err: String(err) });
        return json(422, {
          error: err instanceof Error ? err.message : String(err),
          terminal: true,
        });
      }
      const delivered = await transport.deliver({
        // The whole repo, its GitLab project id with it: a rebuilt pair would drop the id, and
        // the push and the merge request would go wherever the path leads now.
        repo: forgeRepoOf(s.repo),
        repoUrl: s.repoUrl,
        bundlePath: staged,
        branchName: s.branchName,
        baseBranch: s.baseBranch,
        headSha: s.headSha,
        title: s.title,
        description: description.body.text,
        embeds: description.body.embeds,
        // Never a draft today: the control plane submits a patch it has already approved, and
        // "ready for review" is the only state that means. The seam stays for a transport
        // whose forge opens work unready.
        draft: false,
        existingRef: s.changeRequest ?? null,
        ...(s.allowForkPush === undefined ? {} : { allowForkPush: s.allowForkPush }),
        approvedHookPaths: s.approvedHookPaths,
      });
      if (delivered.kind === "failed") {
        return json(delivered.terminal ? 422 : 502, {
          error: delivered.message,
          terminal: delivered.terminal,
          ...(delivered.ended === undefined ? {} : { ended: delivered.ended }),
        });
      }
      if (delivered.kind === "needs-approval") {
        // Not a failure and not terminal: nothing was written, and the same submission goes
        // through once a person approves it with these files. Its own status and code, so the
        // control plane holds the patch for that person rather than retrying or failing it.
        const { touched, hooksPaths, more } = delivered;
        return json(409, { code: "needs_approval", touched, hooksPaths, more });
      }
      return json(201, { ref: delivered.ref, url: delivered.url });
    } finally {
      await rm(staged).catch(() => {});
    }
  };

  const permission = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, PermissionRequestSchema);
    if (!body.ok) return body.res;
    const { repo, subject, atLeast } = body.data;
    // `subject` may be null — "there is no identity" — and that is handed to the adapter as-is
    // rather than being refused here: whether a subjectless question has an answer is the
    // PROVIDER's rule (Radicle's public `write` is permissionless; nothing else is), and this
    // route has no business knowing which. See `ForgeApi.checkPermission`.
    const verdict = await forges.for(repo.provider).checkPermission(repo, subject, atLeast);
    return json(200, { permission: verdict });
  };

  /**
   * Whether one repo is public or private, read live from its forge — the question the control
   * plane's chat door asks before a PUBLIC channel may command work on a repo, because whatever
   * the agent posts there is published. The same read the tool surface's visibility rule makes,
   * one repo at a time, and in the same role: the repo is the run's SOURCE — what the agent
   * reads out of it reaches the channel — so it is public only when ALL of it is read by the
   * public (`RepoVisibility.source`). A public channel's audience is the public, so a source
   * read by anyone less (a GitLab `internal` project, a members-only feature) answers private.
   * Never guessed: a forge that does not answer is a 502, which the caller
   * reads as "unknown" and refuses on.
   */
  const visibility = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, VisibilityRequestSchema);
    if (!body.ok) return body.res;
    const { repo } = body.data;
    // A GitLab project is read by its id where the caller knows it — its path can have been
    // freed by a rename and taken by somebody else's public project. A path never is all digits.
    const asked = repo.forgeId ?? repo.repoRef;
    try {
      const answered = await forges.for(repo.provider).repoVisibility(repo.tenantId, [asked]);
      const seen = answered.get(asked);
      if (seen === undefined) {
        return json(502, { error: `the forge did not say whether ${repo.repoRef} is private` });
      }
      return json(200, { visibility: seen.source === "public" ? "public" : "private" });
    } catch (err) {
      const terminal = err instanceof ForgeApiError && err.terminal;
      diag.warn("service.visibility_failed", { repo: repo.repoRef, terminal, err: String(err) });
      return json(502, { error: err instanceof Error ? err.message : String(err), terminal });
    }
  };

  const installationSettings = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, InstallationRequestSchema);
    if (!body.ok) return body.res;
    if (githubApp === null) return json(501, { error: "no GitHub App is configured" });
    try {
      const url = await githubApp.getInstallationSettingsUrl(body.data.installationId);
      return json(200, { url });
    } catch (err) {
      diag.warn("service.installation_settings_failed", { err: String(err) });
      return json(502, { error: err instanceof Error ? err.message : String(err) });
    }
  };

  const installation = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, InstallationRequestSchema);
    if (!body.ok) return body.res;
    if (githubApp === null) return json(501, { error: "no GitHub App is configured" });
    try {
      return json(200, await githubApp.describeInstallation(body.data.installationId));
    } catch (err) {
      diag.warn("service.installation_failed", { err: String(err) });
      return json(502, { error: err instanceof Error ? err.message : String(err) });
    }
  };

  const comment = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, CommentRequestSchema);
    if (!body.ok) return body.res;
    const rendered = await render(body.data.repo.provider, body.data.runId, body.data.body);
    if (!rendered.ok) return rendered.res;
    try {
      const posted = await forges.for(body.data.repo.provider).postComment(
        body.data.repo,
        body.data.thread,
        rendered.body.text,
        rendered.body.embeds.length > 0 ? rendered.body.embeds : undefined,
      );
      // The id travels back so the caller can EDIT this comment later — a progress report
      // that posts a fresh comment per update is noise, not progress.
      return json(201, posted);
    } catch (err) {
      diag.warn("service.comment_failed", { err: String(err) });
      return json(502, { error: err instanceof Error ? err.message : String(err) });
    }
  };

  const commentUpdate = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, CommentUpdateSchema);
    if (!body.ok) return body.res;
    const rendered = await render(body.data.repo.provider, body.data.runId, body.data.body);
    if (!rendered.ok) return rendered.res;
    try {
      await forges.for(body.data.repo.provider).updateComment(
        body.data.repo,
        body.data.commentId,
        rendered.body.text,
        rendered.body.embeds.length > 0 ? rendered.body.embeds : undefined,
      );
      return new Response(null, { status: 204 });
    } catch (err) {
      diag.warn("service.comment_update_failed", { err: String(err) });
      return json(502, { error: err instanceof Error ? err.message : String(err) });
    }
  };

  const reaction = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, ReactionRequestSchema);
    if (!body.ok) return body.res;
    try {
      await forges.for(body.data.repo.provider).addReaction(
        body.data.repo,
        body.data.commentId,
        body.data.reaction,
      );
      return new Response(null, { status: 204 });
    } catch (err) {
      diag.warn("service.reaction_failed", { err: String(err) });
      return json(502, { error: err instanceof Error ? err.message : String(err) });
    }
  };

  const thread = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, ThreadRequestSchema);
    if (!body.ok) return body.res;
    try {
      const context = await forges.for(body.data.repo.provider).fetchThread(
        body.data.repo,
        body.data.thread,
        body.data.images === undefined ? undefined : { images: body.data.images },
      );
      return json(200, context);
    } catch (err) {
      // Terminality travels for the same reason it does on submit: the caller must tell a
      // deleted thread (nothing to come back for) from GitHub having a bad minute.
      const terminal = err instanceof ForgeApiError && err.terminal;
      diag.warn("service.thread_failed", {
        repo: body.data.repo.repoRef,
        thread: body.data.thread.ref,
        terminal,
        err: String(err),
      });
      return json(terminal ? 404 : 502, {
        error: err instanceof Error ? err.message : String(err),
        terminal,
      });
    }
  };

  /**
   * A change request's head and fate, and whether we opened it — the lean read behind every
   * push event, so it is one forge call where the thread read is many (and on GitHub every call
   * waits on the same delivery queue). 404 is "the change request is not there"; any failure to
   * read it is a 502 carrying whether asking again could help, as the thread read's is.
   */
  const changeRequestHead = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, ChangeRequestHeadRequestSchema);
    if (!body.ok) return body.res;
    const { repo, ref } = body.data;
    try {
      const state = await forges.for(repo.provider).readChangeRequestState(repo, ref);
      if (state === null) {
        return json(404, { error: `${repo.repoRef} has no change request ${ref}`, terminal: true });
      }
      return json(200, state);
    } catch (err) {
      const terminal = err instanceof ForgeApiError && err.terminal;
      diag.warn("service.change_request_head_failed", {
        repo: repo.repoRef,
        ref,
        terminal,
        err: String(err),
      });
      return json(502, { error: err instanceof Error ? err.message : String(err), terminal });
    }
  };

  const orgMembership = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, OrgMembershipRequestSchema);
    if (!body.ok) return body.res;
    // GitLab's gate is a group the forge names (RYPH_GITLAB_GROUP), not an installation's org,
    // and asked by the bot. No group is "no-organization" — the gate's own answer for "anyone
    // who signs in may sign up", which is not a membership answer at all.
    if (body.data.provider === "gitlab") {
      if (gitlab === null) return json(501, { error: NO_GITLAB });
      if (gitlab.mode.mode === "user") {
        return json(501, { error: `${GITLAB_USER_MODE} — it has no sign-up group` });
      }
      // Three-valued like GitHub's: the adapter answers "unknown" for what it could not read,
      // and a throw is the same "unknown" — never a guess either way.
      try {
        // By the account's id, which the schema requires here: never a username.
        const membership = await gitlab.checkGroupMembership(body.data.accountId!);
        return json(200, { membership: membership ?? "no-organization" });
      } catch (err) {
        diag.warn("service.gitlab_membership_failed", { err: String(err) });
        return json(200, { membership: "unknown" });
      }
    }
    // An org is GitHub's concept, so the question is GitHub's App's, not the shared port's.
    if (githubApp === null) return json(501, { error: "no GitHub App is configured" });
    const membership = await githubApp.checkOrgMembership(
      // Both required for github by the schema's refines.
      body.data.installationId!,
      body.data.login!,
    );
    return json(200, { membership });
  };

  const oauthExchange = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, OAuthExchangeSchema);
    if (!body.ok) return body.res;
    if (body.data.provider === "gitlab") {
      if (gitlab === null) return json(501, { error: NO_GITLAB });
      if (gitlab.mode.mode === "user") {
        return json(501, { error: `${GITLAB_USER_MODE} — it has no sign-in` });
      }
    } else if (githubApp === null) {
      return json(501, { error: "no GitHub App is configured" });
    } else if (!githubApp.signIn) {
      return json(501, {
        error: "the GitHub App has no OAuth client (RYPH_GITHUB_CLIENT_ID and _SECRET) — it has " +
          "no sign-in",
      });
    }
    try {
      // GitLab redeems the code with the redirect URI it was issued for (required for gitlab by
      // the schema's refine) and the authorize leg's PKCE verifier.
      const exchanged = body.data.provider === "gitlab"
        ? await gitlab!.exchangeOAuthCode(
          body.data.code,
          body.data.redirectUri!,
          body.data.codeVerifier ?? null,
        )
        : await githubApp!.exchangeOAuthCode(body.data.code);
      return json(200, exchanged);
    } catch (err) {
      // The code was bad or GitHub balked — either way the caller shows "try again".
      diag.warn("service.oauth_exchange_failed", { err: String(err) });
      return json(502, { error: err instanceof Error ? err.message : String(err) });
    }
  };

  /**
   * The repo's service declaration, read out of the cache entry the clone is served from.
   *
   * Ordering is the whole design. `serveBase` FIRST, the same call the runner's clone is about
   * to make, against the same entry, so this read adds no availability dependency the clone
   * does not already have, and resolves against the freshest ref rather than whatever the cache
   * happened to hold. When that refresh fails the cache serves the copy it holds, and the
   * answer says `stale` and the run says so too: a declaration one fetch old is worth far more
   * than a run that starts with no database and hangs. A base the cache never held is
   * "unavailable", and the caller refuses the task on it.
   *
   * What it does NOT do is bind the declaration to the commit the run clones. The clone calls
   * `serveBase` again for its own advertisement (http/git.ts), so a push landing between the
   * two means the run checks out a tree whose `services.yml` was never the one resolved. The
   * window is seconds and the outcome is a suite failing against a service it did not expect,
   * loud and self-correcting on the next run. Closing it means resolving to a SHA here and
   * pinning the clone to it, which is a change to what a run's ref means and does not belong
   * in this function.
   */
  const servicesFile = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, ServicesFileRequestSchema);
    if (!body.ok) return body.res;
    const { repo, url, ref } = body.data;
    const upstream = await upstreamOf(repo, url);
    if (upstream instanceof Response) return upstream;

    let localBranch: string;
    try {
      localBranch = normalizeBaseRef(ref).localBranch;
    } catch (err) {
      // A tag base, say. Terminal: no retry re-shapes the ref the caller already chose.
      return json(400, { error: err instanceof Error ? err.message : String(err), terminal: true });
    }

    let dir: string;
    let stale: boolean;
    try {
      const served = await cache.serveBase(upstream.coords, ref, upstream.credential);
      dir = served.dir;
      stale = served.freshness.kind === "stale";
    } catch (err) {
      // Nothing cached and nothing upstream: we could not ask. NOT "the repo declares none",
      // because the caller refuses the task on this, and launching anyway is the silent
      // no-database outcome the whole feature exists to prevent.
      diag.warn("service.services_unavailable", { err: String(err) });
      return json(502, { kind: "unavailable", detail: "the base repo could not be read" });
    }
    if (stale) diag.warn("service.services_from_stale_cache", { ref });

    let read: Awaited<ReturnType<typeof readRepoFile>> = { kind: "absent" };
    let path: string = SERVICES_FILE_PATHS[0];
    try {
      // Once, for both spellings: `.yml` and `.yaml` are asked of the same commit.
      const commit = await resolveBranch(dir, localBranch, gitExec);
      for (const candidate of SERVICES_FILE_PATHS) {
        read = await readRepoFile({
          dir,
          commit,
          path: candidate,
          maxBytes: MAX_SERVICES_FILE_BYTES,
          git: gitRaw,
        });
        if (read.kind !== "absent") {
          path = candidate;
          break;
        }
      }
    } catch (err) {
      // The entry cannot answer for this ref: a successful serve guarantees the branch resolves,
      // so this is the entry breaking underneath the read.
      diag.warn("service.services_unreadable", { ref, err: String(err) });
      return json(502, { kind: "unavailable", detail: `${ref} is not in the cache` });
    }

    if (read.kind === "too-large") {
      return json(200, {
        kind: "invalid",
        detail: `${path} is ${read.bytes} bytes, over the ` +
          `${MAX_SERVICES_FILE_BYTES}-byte limit`,
      });
    }
    if (read.kind === "absent") return json(200, { kind: "absent" });
    diag.debug("service.services_read", { ref, path, bytes: read.text.length, stale });
    return json(200, { kind: "file", text: read.text, stale });
  };

  /**
   * Where a repo's base is fetched from, and with what — the preamble every cache-backed read
   * shares. A RID is not a git address, so the upstream is the adapter's to derive (see
   * `ForgeApi.upstreamUrl`); an address it refuses is the caller's terminal 400. The credential
   * is minted only when the cache fetches, so a mint that fails is that read's failed refresh.
   */
  async function upstreamOf(
    repo: ForgeRepo & { provider: ForgeProvider },
    url: string,
  ): Promise<{ upstream: string; coords: RepoCoords; credential: Credential } | Response> {
    const api = forges.for(repo.provider);
    const warn = (err: unknown) =>
      diag.warn("service.fetch_auth_failed", { repo: repo.repoRef, err: String(err) });
    // A GitLab project the caller named by id is read where GitLab places that id now, never at
    // the path it was connected under (see fetch_auth.ts `located`).
    if (repo.forgeId !== undefined) {
      const at = await located(api, { ...repo, forgeId: repo.forgeId }, url, warn);
      return { upstream: at.url, coords: at.coords, credential: at.credential };
    }
    let upstream: string;
    try {
      upstream = api.upstreamUrl(repo, url);
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err), terminal: true });
    }
    const credential = credentialFor(api, repo, upstream, warn);
    return { upstream, coords: { url: upstream }, credential };
  }

  /** The `.ryph` tree id as every read here answers it: without `RYPH_NOT_BUILT`. */
  const ryphTreeAt = (dir: string, commit: string) =>
    readTreeIdWithout({
      dir,
      commit,
      path: RYPH_DIR,
      omit: RYPH_NOT_BUILT,
      git: gitExec,
      capped: gitCapped,
    });

  /**
   * The `.ryph/` tree id at a commit or a branch — what an environment is keyed on. The second
   * read out of a repo's contents this surface makes, and narrower than the first: ONE FIXED
   * PATH (`RYPH_DIR`), and an object id comes back, never a byte of what is under it. The id is
   * enough to answer "did the repo's machine definition change?", and the Dockerfile's own blob
   * id "did the machine itself change?". It is the id of the tree without the files no build
   * reads (`RYPH_NOT_BUILT`), so a change to checks.yml alone moves no environment. A `.ryph/` of
   * only those files answers the empty tree's id, still a definition: its checkout is baked.
   *
   * A commit is fetched by id when the entry does not hold it; a branch is refreshed strictly
   * (`refreshBase`, never the serving call the clone makes) and resolved to the commit that was
   * read. Nothing on the launch path waits on this answer being served out of a dead upstream,
   * and a stale tree id would build yesterday's machine.
   */
  const ryphTree = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, RyphTreeRequestSchema);
    if (!body.ok) return body.res;
    const { repo, url, commitOrRef } = body.data;
    const upstream = await upstreamOf(repo, url);
    if (upstream instanceof Response) return upstream;

    let dir: string;
    let commit: string;
    try {
      if (COMMIT_ID.test(commitOrRef)) {
        dir = (await cache.ensureCommit(
          upstream.coords,
          commitOrRef,
          upstream.credential,
        )).dir;
        commit = commitOrRef;
      } else {
        try {
          normalizeBaseRef(commitOrRef);
        } catch (err) {
          return json(400, {
            error: err instanceof Error ? err.message : String(err),
            terminal: true,
          });
        }
        const cached = await cache.refreshBase(
          upstream.coords,
          commitOrRef,
          upstream.credential,
        );
        dir = cached.dir;
        commit = await resolveBranch(dir, cached.localBranch, gitExec);
      }
    } catch (err) {
      diag.warn("service.ryph_tree_unavailable", { commitOrRef, err: String(err) });
      return json(502, { error: `${commitOrRef} could not be read from the repo` });
    }
    try {
      const tree = await ryphTreeAt(dir, commit);
      // The whole directory's id as well, for one question only: whether a branch whose `tree`
      // is unchanged changed the files left out of it, which a setup agent is told apart.
      const fullTree = await readTreeId({ dir, commit, path: RYPH_DIR, git: gitExec });
      // The one other fact the control plane needs, and still not content: the Dockerfile's
      // blob id, or null with none. Whether there is one decides whether a run may start on the
      // universal image while the first build runs or has to wait for it; the id says whether
      // the machine changed when something else under `.ryph/` did, which decides whether a
      // rebuild may start warm.
      const dockerfileBlob = tree === null
        ? null
        : await readBlobId({ dir, commit, path: `${RYPH_DIR}/Dockerfile`, git: gitExec });
      const dockerfile = dockerfileBlob !== null;
      diag.debug("service.ryph_tree_read", { commit, tree, dockerfile });
      return json(200, { commit, tree, fullTree, dockerfile, dockerfileBlob });
    } catch (err) {
      diag.warn("service.ryph_tree_unreadable", { commit, err: String(err) });
      return json(502, { error: `${commit} could not be read from the cache` });
    }
  };

  /**
   * Where a branch head's `.ryph/` came from: the merge base of `head` and the `base` branch (the
   * default one, refreshed strictly as `ryphTree` refreshes it), the `.ryph` tree id there, and
   * the paths under `.ryph/` the head changed since, both without `RYPH_NOT_BUILT`. It answers
   * "did this branch change its machine definition, or only fall behind a default branch that
   * did?" — a head whose tree differs from the default branch's but equals its merge base's
   * changed nothing.
   *
   * `mergeBase` is null when the two share no history, and then `tree` is null and `changed`
   * empty. Names under one fixed directory and object ids, never content; `changed` is bounded.
   */
  const ryphBase = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, RyphBaseRequestSchema);
    if (!body.ok) return body.res;
    const { repo, url, head, base } = body.data;
    try {
      normalizeBaseRef(base);
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err), terminal: true });
    }
    const upstream = await upstreamOf(repo, url);
    if (upstream instanceof Response) return upstream;

    let dir: string;
    let baseCommit: string;
    try {
      const cached = await cache.refreshBase(upstream.coords, base, upstream.credential);
      const held = await cache.ensureCommit(upstream.coords, head, upstream.credential);
      if (held.dir !== cached.dir) {
        throw new Error("the head and the base are in different entries");
      }
      dir = cached.dir;
      baseCommit = await resolveBranch(dir, cached.localBranch, gitExec);
    } catch (err) {
      diag.warn("service.ryph_base_unavailable", { head, base, err: String(err) });
      return json(502, { error: `${head} or ${base} could not be read from the repo` });
    }
    try {
      let mergeBase: string | null;
      try {
        mergeBase = await gitExec(dir, "merge-base", "--end-of-options", head, baseCommit);
      } catch (err) {
        // `git merge-base` says "no common ancestor" by exiting 1.
        if (!isExitOne(err)) throw err;
        mergeBase = null;
      }
      if (mergeBase === null) {
        diag.debug("service.ryph_base_read", { head, base: baseCommit, mergeBase });
        return json(200, { base: baseCommit, mergeBase: null, tree: null, changed: [] });
      }
      const tree = await ryphTreeAt(dir, mergeBase);
      const names = await gitExec(
        dir,
        "diff",
        "--no-renames",
        "--name-only",
        "-z",
        "--no-ext-diff",
        "--end-of-options",
        mergeBase,
        head,
        "--",
        `${RYPH_DIR}/`,
      );
      // `-z`: names come NUL-separated and verbatim, never C-quoted (`".ryph/a b"`).
      const changed = names.split("\0")
        .filter((name) => name !== "" && !RYPH_NOT_BUILT.has(name.slice(RYPH_DIR.length + 1)))
        .slice(0, MAX_RYPH_CHANGED);
      diag.debug("service.ryph_base_read", { head, base: baseCommit, mergeBase, tree });
      return json(200, { base: baseCommit, mergeBase, tree, changed });
    } catch (err) {
      diag.warn("service.ryph_base_unreadable", { head, base: baseCommit, err: String(err) });
      return json(502, { error: `${head}'s merge base could not be read from the cache` });
    }
  };

  /**
   * Which of a change request's pushed heads a merge CONTAINED: each of `heads` that is an
   * ancestor of, or equal to, any of `mergedHeads` (what the forge says merged —
   * `ForgeEvent.merged.heads`), or whose change is exactly a merged head's own (the change
   * request's branch rewritten before the merge), the head measured past its base where `bases`
   * names one and the merged head past where it left `into`, the branch it merged into, where
   * that is named (helpers/containment.ts). One call per merge, every patch head of it at once.
   * The tip of `into` is read off the upstream first, within the same budget; the merged heads are then fetched by id
   * into the repo's cache entry in one fetch (on Radicle through the bridge's git door, which
   * serves an older revision's head by id), then every head, base and that tip not yet held in
   * one more. All of it runs with the entry held, so the answer is read against one entry that
   * nothing changes under it, and within `MERGE_CONTAINMENT_BUDGET_MS`.
   *
   * Never "contained" on a doubt of git's, nor "missed" on one. The bases are the runner's word
   * (the agent shares its container): a base set past some of a head's own work changes what
   * the head is compared by, which reaches only the run's own patches. 200 `{ contained, missed }`
   * partitions the asked heads, each once. A base the upstream does not have is as good as none
   * named, and so is an entry that names no asked head or no commit id: it is dropped, with a
   * warning, never the question. An `into` the upstream has no branch by, that names no branch,
   * or that the ref rules refuse (or no string at all) is as good as none named, never a 400: a
   * merged head is then measured from where it meets each head. A merged head the upstream does
   * not have leaves the answer standing only if every head is contained by the others: a head
   * they do not contain might be in the absent one, so that is a 502 with `terminal: false`.
   * When the upstream has none of the merged heads, it is a terminal 404
   * (`missing-merged-head`): asking again changes nothing, and nothing can be judged. An id,
   * merged or pushed, that names something other than a commit is a terminal 404
   * (`not-a-commit`), for the same reason. Anything else that keeps a merged head, a head to
   * compare or the target's tip out of reach, or git from answering, or the budget running out,
   * is a 502 with `terminal: false` — the settle that asked waits and asks again.
   */
  const mergeContainment = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, MergeContainmentRequestSchema);
    if (!body.ok) return body.res;
    const { repo, url, mergedHeads, heads, into } = body.data;
    const { bases, ignored } = basesOf(body.data.bases, heads);
    if (ignored > 0) {
      diag.warn("service.merge_containment_bases_ignored", { repo: repo.repoRef, ignored });
    }
    const upstream = await upstreamOf(repo, url);
    if (upstream instanceof Response) return upstream;
    const signal = AbortSignal.timeout(
      config.mergeContainmentBudgetMs ?? MERGE_CONTAINMENT_BUDGET_MS,
    );
    // The branch the merge went into, as the upstream has it now: a plain branch name only.
    const branch = intoBranch(into);
    if (into !== undefined && branch === undefined) {
      diag.warn("service.merge_containment_into_ignored", { repo: repo.repoRef });
    }
    let target: string | undefined;
    if (branch !== undefined) {
      try {
        target = await cache.remoteBranchHead(
          upstream.coords,
          branch,
          upstream.credential,
          { signal },
        ) ?? undefined;
      } catch (err) {
        diag.warn("service.merge_containment_unavailable", {
          repo: repo.repoRef,
          into: branch,
          timedOut: signal.aborted,
          err: String(err),
        });
        return json(502, { error: `${branch} could not be read from the repo`, terminal: false });
      }
    }
    const notACommit = (ids: readonly string[]) =>
      json(404, {
        kind: "not-a-commit",
        error: `not a commit: ${ids.join(", ")}`,
        terminal: true,
      });

    try {
      return await cache.withHeld(
        upstream.coords,
        upstream.credential,
        async (entry) => {
          const merged = [...new Set(mergedHeads)];
          const { absent, notCommits } = await entry.hold(merged);
          if (notCommits.size > 0) return notACommit([...notCommits]);
          const present = merged.filter((m) => !absent.has(m));
          if (absent.size > 0) {
            diag.warn("service.merge_containment_absent_head", {
              repo: repo.repoRef,
              absent: [...absent],
            });
          }
          if (present.length === 0) {
            return json(404, {
              kind: "missing-merged-head",
              error: "none of the merged heads is in the repo",
              terminal: true,
            });
          }
          const answer = await containedIn(
            { git: makeGit(diag, {}, signal), gitInput: makeGitInput(diag, signal) },
            entry.dir,
            present,
            heads,
            entry.hold,
            bases,
            target,
          );
          diag.debug("service.merge_containment", {
            repo: repo.repoRef,
            mergedHeads: present,
            target,
            contained: answer.contained.length,
            missed: answer.missed.length,
          });
          if (absent.size > 0 && answer.missed.length > 0) {
            // What the absent head holds is unknown, so a head the present ones lack is not
            // known to be missed.
            return json(502, {
              error: "a merged head is not in the repo yet, and the rest do not contain every head",
              terminal: false,
            });
          }
          // With the tip of `into` it was read against: the landing records it, and the line's
          // next generation is asked whether it holds it (patch-lineage).
          return json(200, target === undefined ? answer : { ...answer, intoTip: target });
        },
        { signal },
      );
    } catch (err) {
      if (err instanceof NotACommit) return notACommit(err.ids);
      diag.warn("service.merge_containment_unavailable", {
        repo: repo.repoRef,
        timedOut: signal.aborted,
        err: String(err),
      });
      return json(502, { error: "containment could not be read", terminal: false });
    }
  };

  /**
   * The strict pinned read the checks and skills routes share: a commit is fetched by id when the
   * entry does not hold it, and a branch is refreshed as a base, never served from a stale copy,
   * and resolved to the commit that was read. Answers the entry and that commit, or the response
   * that ends the request: a terminal 400 for a repo no adapter serves or a ref that is no
   * branch, a terminal 404 `missing-ref` when the upstream says the branch is gone, and a 502
   * `unavailable` for anything else, logged under `tag`.
   */
  const pinRead = async (
    repo: ForgeRepo & { provider: ForgeProvider },
    url: string,
    commitOrRef: string,
    tag: string,
  ): Promise<{ dir: string; commit: string } | Response> => {
    let upstream: { upstream: string; coords: RepoCoords; credential: Credential } | Response;
    try {
      upstream = await upstreamOf(repo, url);
    } catch (err) {
      // No adapter for this repo's forge: wiring, and no retry changes it.
      return json(400, { error: err instanceof Error ? err.message : String(err), terminal: true });
    }
    if (upstream instanceof Response) return upstream;
    try {
      if (COMMIT_ID.test(commitOrRef)) {
        const cached = await cache.ensureCommit(
          upstream.coords,
          commitOrRef,
          upstream.credential,
        );
        return { dir: cached.dir, commit: commitOrRef };
      }
      try {
        normalizeBaseRef(commitOrRef);
      } catch (err) {
        return json(400, {
          error: err instanceof Error ? err.message : String(err),
          terminal: true,
        });
      }
      const cached = await cache.refreshBase(
        upstream.coords,
        commitOrRef,
        upstream.credential,
      );
      return {
        dir: cached.dir,
        commit: await resolveBranch(cached.dir, cached.localBranch, gitExec),
      };
    } catch (err) {
      diag.warn(tag, { commitOrRef, err: String(err) });
      // The upstream saying the branch is gone is an answer, not an outage: a ref to report at
      // once, never a read to retry. A refused REPO stays retryable, since an installation can be
      // restored.
      if (err instanceof UpstreamRefused && err.reason === "missing-ref") {
        return json(404, {
          kind: "missing-ref",
          error: `${commitOrRef} is not a branch of the repo`,
          terminal: true,
        });
      }
      return json(502, {
        kind: "unavailable",
        detail: `${commitOrRef} could not be read from the repo`,
      });
    }
  };

  /**
   * The repo's check definition — `.ryph/checks.yml` — and everything a suite is keyed and run
   * on, all read at ONE pinned commit: the file's bytes and blob id, the `.ryph` tree id (which
   * environment judges it), whether `.ryph/Dockerfile` exists, and `.ryph/services.yml` (which
   * databases its checks may name). One round trip, one commit, so no two of those facts can
   * come from different sides of a push.
   *
   * This file is the JUDGE of a change, so it is stricter than the services read in the one way
   * that matters: there is NO stale fallback. A base read out of a cache the upstream could not
   * refresh is an old judge, and "unavailable" — which the control plane never turns into
   * "absent" — leaves a required check pending, which blocks the merge. That is the safe
   * failure; a verdict from yesterday's definition is not.
   *
   * A commit is fetched by id when the entry does not hold it; a branch is fetched as a base and
   * resolved to the commit that was read, exactly as the `.ryph/` tree read does.
   */
  const checksFile = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, ChecksFileRequestSchema);
    if (!body.ok) return body.res;
    const { repo, url, commitOrRef } = body.data;
    const unavailable = (detail: string) => json(502, { kind: "unavailable", detail });

    // Strictly refreshed, never served: a failed refresh is "unavailable", for the reason above.
    const pinned = await pinRead(repo, url, commitOrRef, "service.checks_unavailable");
    if (pinned instanceof Response) return pinned;
    const { dir, commit } = pinned;

    /** The first spelling present, read bounded, at the pinned commit. */
    const readFirst = async (paths: readonly string[], maxBytes: number) => {
      for (const path of paths) {
        const read = await readRepoFile({ dir, commit, path, maxBytes, git: gitRaw });
        if (read.kind !== "absent") return { path, read };
      }
      return { path: paths[0], read: { kind: "absent" } as const };
    };
    const overCap = (path: string, bytes: number, max: number) =>
      `${path} is ${bytes} bytes, over the ${max}-byte limit`;

    try {
      const checks = await readFirst(CHECKS_FILE_PATHS, MAX_CHECKS_FILE_BYTES);
      if (checks.read.kind === "absent") {
        diag.debug("service.checks_read", { commit, kind: "absent" });
        return json(200, { kind: "absent", commit });
      }
      if (checks.read.kind === "too-large") {
        return json(200, {
          kind: "invalid",
          commit,
          detail: overCap(checks.path, checks.read.bytes, MAX_CHECKS_FILE_BYTES),
        });
      }
      const blob = await readBlobId({ dir, commit, path: checks.path, git: gitExec });
      // Read a moment ago at this very commit, and a commit is immutable: a null here is a
      // broken entry, not a missing file.
      if (blob === null) throw new Error(`${checks.path} vanished from ${commit}`);
      const ryphTree = await ryphTreeAt(dir, commit);
      const dockerfile = ryphTree !== null &&
        await hasBlob({ dir, commit, path: `${RYPH_DIR}/Dockerfile`, git: gitExec });
      const declared = await readFirst(SERVICES_FILE_PATHS, MAX_SERVICES_FILE_BYTES);
      const services = declared.read.kind === "file"
        ? { kind: "file", text: declared.read.text }
        : declared.read.kind === "too-large"
        ? {
          kind: "invalid",
          detail: overCap(declared.path, declared.read.bytes, MAX_SERVICES_FILE_BYTES),
        }
        : { kind: "absent" };
      diag.debug("service.checks_read", {
        commit,
        path: checks.path,
        blob,
        bytes: checks.read.text.length,
        services: services.kind,
      });
      return json(200, {
        kind: "file",
        text: checks.read.text,
        path: checks.path,
        commit,
        blob,
        ryphTree,
        dockerfile,
        services,
      });
    } catch (err) {
      diag.warn("service.checks_unreadable", { commit, err: String(err) });
      return unavailable(`${commit} could not be read from the cache`);
    }
  };

  /**
   * The org skills repo's `.agents/skills/` at a commit or a branch: every file's path, mode and
   * bytes under that one prefix, at one pinned commit (helpers/skill_tree.ts). The bytes come
   * back unjudged; what a skill is, is the control plane's rule.
   *
   * Strict like the checks read, through the same `pinRead`: a branch is refreshed, never served
   * from a stale copy, so a failed refresh is `unavailable` and the control plane keeps the
   * version it has. The upstream saying the branch is gone is the terminal `missing-ref`, an
   * answer the settings page names, not an outage to retry. The sync always asks for a branch; a
   * commit id is taken too because the pin is the checks read's, and refusing that one spelling
   * here would be a rule of its own to keep in step.
   */
  const skillsTree = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, SkillsTreeRequestSchema);
    if (!body.ok) return body.res;
    const { repo, url, commitOrRef, knownTree } = body.data;
    const unavailable = (detail: string) => json(502, { kind: "unavailable", detail });

    const pinned = await pinRead(repo, url, commitOrRef, "service.skills_unavailable");
    if (pinned instanceof Response) return pinned;
    const { dir, commit } = pinned;

    try {
      const read = await readSkillsTree({
        dir,
        commit,
        knownTree,
        git: gitExec,
        gitBounded,
        catFile,
      });
      diag.debug("service.skills_read", {
        commit,
        kind: read.kind,
        files: read.kind === "tree" ? read.files.length : 0,
      });
      if (read.kind !== "tree") return json(200, read);
      return json(200, {
        ...read,
        files: read.files.map((f) => ({
          path: f.path,
          mode: f.mode,
          content: f.content === null ? null : f.content.toBase64(),
        })),
      });
    } catch (err) {
      diag.warn("service.skills_unreadable", { commit, err: String(err) });
      return unavailable(`${commit} could not be read from the cache`);
    }
  };

  /**
   * When each (upstream, base) was last fetched for a check bundle, so a failed verify refreshes
   * the base at most once a minute. Without it every bad upload is an upstream fetch on the
   * installation; within the window the base is as new as a refresh would make it, and a bundle
   * it does not satisfy is unsatisfiable. In memory, per process: losing it costs one fetch.
   */
  const lastBaseRefresh = new Map<string, number>();
  const now = deps.now ?? Date.now;
  const refreshedRecently = (key: string): boolean => {
    const at = lastBaseRefresh.get(key);
    return at !== undefined && now() - at < CHECK_BUNDLE_REFRESH_INTERVAL_MS;
  };
  const baseRefreshed = (key: string): void => {
    const at = now();
    // Swept on write, so the map holds only bases fetched within the window.
    for (const [k, t] of lastBaseRefresh) {
      if (at - t >= CHECK_BUNDLE_REFRESH_INTERVAL_MS) lastBaseRefresh.delete(k);
    }
    lastBaseRefresh.set(key, at);
  };

  /**
   * A person's check bundle — a commit off their own machine, for a check suite to run on before
   * any change request exists. The orchestrator streams the bundle through as the body and names
   * everything else in the `x-ryph-check-bundle` header. Verified as a run's patch is (exactly
   * one ref, prerequisites the base cache satisfies) and filed in the patch store under the
   * user, where the gateway's candidate arm serves it to the check pod like a run's bundle.
   *
   * Two differences from patch intake, both because the bundle comes from a laptop and not a
   * run the gateway cloned: the ref must be `refs/heads/<branchName>` exactly (a generation
   * suffix is a run's convention, nobody else's), and a verification failure against a base we
   * DO hold is not yet terminal. A laptop's tracking ref may be newer than our cache, which a
   * run's base never is, so the base is refreshed once and the bundle judged again; only then
   * is a failure the bundle's own. At most once a minute per base, though: within that window
   * the base is as fresh as a refresh would make it, and the failure is final at once.
   */
  const checkBundle = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const refuse = (error: string, detail?: string) =>
      json(400, { error, ...(detail === undefined ? {} : { detail }), terminal: true });

    // In a header, because the body is the bundle and is streamed, never parsed. Checked before
    // a byte of it is read: a malformed ask costs nothing.
    const raw = req.headers.get(CHECK_BUNDLE_HEADER);
    if (raw === null) return refuse(`missing the ${CHECK_BUNDLE_HEADER} header`);
    let meta: unknown;
    try {
      meta = JSON.parse(raw);
    } catch {
      return refuse(`the ${CHECK_BUNDLE_HEADER} header is not valid JSON`);
    }
    const parsed = CheckBundleRequestSchema.safeParse(meta);
    if (!parsed.success) return refuse(describeIssues(parsed.error));
    const { repo, url, connectedRepoId, userId, branchName } = parsed.data;
    if (parsed.data.baseRef !== undefined) {
      try {
        normalizeBaseRef(parsed.data.baseRef);
      } catch (err) {
        return refuse(err instanceof Error ? err.message : String(err));
      }
    }
    let upstream: { upstream: string; coords: RepoCoords; credential: Credential } | Response;
    try {
      upstream = await upstreamOf(repo, url);
    } catch (err) {
      // No adapter for this repo's forge: wiring, and no retry changes it.
      return refuse(err instanceof Error ? err.message : String(err));
    }
    if (upstream instanceof Response) return upstream;
    const { credential } = upstream;
    const coords = upstream.coords;
    const about = { repo: repo.repoRef, connectedRepoId, userId };
    const unavailable = (event: string, err: unknown, ref?: string) => {
      diag.warn(event, { ...about, err: String(err) });
      // A base branch the upstream answered it does not have is the ask's mistake (a typo, a
      // remote-tracking name like `origin/main`), and no retry grows it. Everything else, a
      // refused repo included, is retryable.
      if (err instanceof UpstreamRefused && err.reason === "missing-ref") {
        return refuse(`the base branch "${ref}" is not on the repo`);
      }
      return json(503, { error: "base cache unavailable, retry" });
    };

    const staged = await stageUpload(req, {
      maxBytes: config.maxBundleBytes,
      stagingDir: config.stagingDir,
    });
    if (staged.kind === "too-large") {
      diag.warn("service.check_bundle_capped", { ...about, limit: config.maxBundleBytes });
      return json(413, { error: "bundle exceeds the size limit", terminal: true });
    }
    const stagingPath = staged.path;
    try {
      const one = await soleRef(stagingPath);
      if (typeof one === "string") return refuse(one);
      const expected = `refs/heads/${branchName}`;
      if (one.ref !== expected) {
        return refuse(`bundle declares "${one.ref}"; expected "${expected}"`);
      }

      let baseRef = parsed.data.baseRef;
      if (baseRef === undefined) {
        try {
          baseRef = await cache.remoteDefaultBranch(coords, credential);
        } catch (err) {
          return unavailable("service.check_bundle_default_unavailable", err);
        }
      }

      // The cache as it stands first, as patch intake does: a hit costs no upstream contact. A
      // miss is warmed, and a base fetched this moment is as new as the upstream's, so what
      // fails against it fails for good.
      let failure: string | null;
      const refreshKey = `${coords.url}\n${baseRef}`;
      const held = await cache.find(coords, baseRef);
      if (held === null) {
        let warmed;
        try {
          warmed = await cache.serveBase(coords, baseRef, credential);
        } catch (err) {
          return unavailable("service.check_bundle_unwarmable", err, baseRef);
        }
        baseRefreshed(refreshKey);
        failure = await verify(warmed.dir, stagingPath);
      } else {
        failure = await verify(held.dir, stagingPath);
        if (failure !== null && refreshedRecently(refreshKey)) {
          diag.debug("service.check_bundle_refresh_skipped", { ...about, baseRef });
          // Final, but say why: the one case where the person may be right and we behind.
          return refuse(
            "bundle prerequisites are not satisfied by the base repo. ryph's copy of " +
              `${baseRef} was refreshed under a minute ago and may lag the forge; ` +
              `if ${baseRef} just moved, try again in a minute`,
            failure,
          );
        } else if (failure !== null) {
          // Strictly refreshed, never served: a stale copy is the one that just failed.
          let fresh;
          try {
            fresh = await cache.refreshBase(coords, baseRef, credential);
          } catch (err) {
            return unavailable("service.check_bundle_unrefreshable", err, baseRef);
          }
          baseRefreshed(refreshKey);
          diag.debug("service.check_bundle_base_refreshed", { ...about, baseRef });
          failure = await verify(fresh.dir, stagingPath);
        }
      }
      if (failure !== null) {
        return refuse("bundle prerequisites are not satisfied by the base repo", failure);
      }

      const headSha = one.sha;
      const bundleKey = await checkBundleKey({
        userId,
        branchName,
        baseRef,
        connectedRepoId,
        headSha,
      });
      await patches.put(bundleKey, stagingPath); // consumes the staging file
      diag.debug("service.check_bundle_received", { ...about, headSha, bundleKey });
      return json(201, { headSha, bundleKey });
    } finally {
      // Best-effort sweep for every early return above; a successful put already moved it.
      await rm(stagingPath).catch(() => {});
    }
  };

  /**
   * Shows a ryph check suite on a commit the forge already has — check runs on GitHub, a job run
   * on Radicle. The adapter owns idempotency (a retry converges on the runs it already posted);
   * this route carries terminality back, as every other write here does, so the control plane
   * can tell "this repo will never take it" from "the forge had a bad minute".
   */
  const reportChecks = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, ReportChecksRequestSchema);
    if (!body.ok) return body.res;
    const { repo, report } = body.data;
    try {
      const outcome = await forges.for(repo.provider).reportChecks(repo, report);
      if (outcome.kind === "failed") {
        diag.warn("service.report_checks_failed", {
          repo: repo.repoRef,
          suiteId: report.suiteId,
          terminal: outcome.terminal,
          err: outcome.message,
        });
        return json(outcome.terminal ? 422 : 502, {
          error: outcome.message,
          terminal: outcome.terminal,
        });
      }
      return json(200, outcome);
    } catch (err) {
      const terminal = err instanceof ForgeApiError && err.terminal;
      diag.warn("service.report_checks_failed", {
        repo: repo.repoRef,
        suiteId: report.suiteId,
        terminal,
        err: String(err),
      });
      return json(terminal ? 422 : 502, {
        error: err instanceof Error ? err.message : String(err),
        terminal,
      });
    }
  };

  /**
   * The default branch, and the commit it points at, as the UPSTREAM says them now: the branch
   * off the remote's HEAD, the commit off a fetch of it into the cache — which also leaves the
   * entry warm for the tree read that usually follows.
   */
  const defaultBranchHead = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, DefaultBranchHeadRequestSchema);
    if (!body.ok) return body.res;
    const { repo, url } = body.data;
    const upstream = await upstreamOf(repo, url);
    if (upstream instanceof Response) return upstream;
    try {
      const { credential } = upstream;
      const branch = await cache.remoteDefaultBranch(upstream.coords, credential);
      const cached = await cache.refreshBase(upstream.coords, branch, credential);
      const commit = await resolveBranch(cached.dir, cached.localBranch, gitExec);
      return json(200, { ref: branch, commit });
    } catch (err) {
      diag.warn("service.default_branch_unavailable", { repo: repo.repoRef, err: String(err) });
      return json(502, { error: "the repo's default branch could not be read" });
    }
  };

  /**
   * The commit a branch names upstream NOW — read off the git remote (`ls-remote`, through the
   * same credentialed path a fetch takes), never off the cache, which may be behind, and writing
   * nothing into it. What proves a person's pushed commit really is their branch's head before
   * a suite runs it: a commit id alone could name anything in the forge's fork network.
   *
   * On Radicle the remote is the bridge's git door, which serves only the CANONICAL branches
   * (the delegates' `refs/heads/*`): a contributor's branch in their own namespace answers 404.
   */
  const branchHead = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, BranchHeadRequestSchema);
    if (!body.ok) return body.res;
    const { repo, url, branch } = body.data;
    let upstream: { upstream: string; coords: RepoCoords; credential: Credential } | Response;
    try {
      upstream = await upstreamOf(repo, url);
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err), terminal: true });
    }
    if (upstream instanceof Response) return upstream;
    let sha: string | null;
    try {
      sha = await cache.remoteBranchHead(upstream.coords, branch, upstream.credential);
    } catch (err) {
      // A refused repo included: an installation can be restored, so it stays retryable.
      diag.warn("service.branch_head_unavailable", { repo: repo.repoRef, err: String(err) });
      return json(502, { error: `${branch} could not be read from the repo` });
    }
    if (sha === null) {
      return json(404, { error: `${branch} is not a branch of the repo`, terminal: true });
    }
    return json(200, { sha });
  };

  /**
   * Whether a ref is the default branch, one of the repo's own branches, or somebody else's —
   * see `BranchKind`. The default is read off the upstream (never the connected repo's row, as
   * old as the connection); anything else is the provider's question, because only it knows
   * who a fork or a peer is.
   */
  const branchKind = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, BranchKindRequestSchema);
    if (!body.ok) return body.res;
    const { repo, url, ref } = body.data;
    let localBranch: string;
    try {
      localBranch = normalizeBaseRef(ref).localBranch;
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err), terminal: true });
    }
    const upstream = await upstreamOf(repo, url);
    if (upstream instanceof Response) return upstream;
    let defaultBranch: string;
    try {
      defaultBranch = await cache.remoteDefaultBranch(
        upstream.coords,
        upstream.credential,
      );
    } catch (err) {
      diag.warn("service.default_branch_unavailable", { repo: repo.repoRef, err: String(err) });
      return json(502, { error: "the repo's default branch could not be read" });
    }
    if (localBranch === defaultBranch) return json(200, { kind: "default" satisfies BranchKind });
    try {
      const kind: BranchKind = await forges.for(repo.provider).classifyBranch(repo, localBranch);
      return json(200, { kind });
    } catch (err) {
      const terminal = err instanceof ForgeApiError && err.terminal;
      diag.warn("service.branch_kind_failed", { ref, terminal, err: String(err) });
      return json(terminal ? 404 : 502, {
        error: err instanceof Error ? err.message : String(err),
        terminal,
      });
    }
  };

  /**
   * Which forges this deployment can actually act on. The control plane needs it to offer a
   * provider choice truthfully: `radicle` is present exactly when a bridge is wired, and a
   * connect flow for a forge with no adapter is a form that cannot work.
   */
  const providers = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    // How the Radicle bridge acts, beside whether there is one: in user mode every write on a
    // connected repository is signed as one person, and the control plane gates connecting on it.
    return json(200, {
      providers: forges.providers(),
      github: githubMode,
      gitlab: gitlab === null ? null : gitlab.mode,
      radicle: radicle === null ? null : { mode: radicle.mode },
    });
  };

  /** GitLab's connect questions share one shape: authenticated, the body checked, 501 where no
   * GitLab runs, and the adapter's failure as a 502 that says whether a retry can help. */
  const gitlabRoute = <T>(
    schema: z.ZodType<T> | null,
    act: (api: GitlabConnectApi, body: T) => Promise<Response>,
    what: string,
  ) =>
  async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    let data = undefined as T;
    if (schema !== null) {
      const body = await parse(req, schema);
      if (!body.ok) return body.res;
      data = body.data;
    }
    if (gitlab === null) return json(501, { error: NO_GITLAB });
    try {
      return await act(gitlab, data);
    } catch (err) {
      const terminal = err instanceof ForgeApiError && err.terminal;
      diag.warn(`service.gitlab_${what}_failed`, { terminal, err: String(err) });
      return json(502, { error: err instanceof Error ? err.message : String(err), terminal });
    }
  };

  /** Every project the token's account reaches — the connect flow's picker. In bot mode that is
   * the bot's reach (where an admin added it); in user mode the person's, `admin` marking where
   * they hold Maintainer. */
  const gitlabProjects = gitlabRoute(
    null,
    async (api) => json(200, { projects: await api.listProjects() }),
    "projects",
  );

  /**
   * One project as GitLab describes it to the token's account — what a connect stores: GitLab's
   * own `path_with_namespace`, clone URL and default branch, never the caller's spelling. A 404
   * is GitLab saying there is no such project this token can see, which no retry changes.
   */
  const gitlabDescribe = gitlabRoute(GitlabDescribeRequestSchema, async (api, { project }) => {
    const described = await api.describeProject(project);
    if (described === null) {
      return json(404, {
        error: `GitLab has no project ${project} that @${api.mode.login} can see`,
        terminal: true,
      });
    }
    return json(200, described);
  }, "describe");

  /**
   * An account's username as GitLab spells it now, by its account id — for the control plane to
   * NAME a person it knows by id (who asked for a run), never to decide anything on. A 404 is
   * GitLab saying there is no such user; an account on another instance is a terminal 502.
   */
  const gitlabUser = gitlabRoute(GitlabUserRequestSchema, async (api, { accountId }) => {
    const user = await api.describeUser(accountId);
    if (user === null) return json(404, { error: "GitLab has no such user", terminal: true });
    return json(200, user);
  }, "user");

  /**
   * The `X-Gitlab-Token` a project's webhook must carry at one generation, for the Maintainer
   * pasting it — derived from the master secret exactly as the mailroom checks it. Which
   * generation is current is the control plane's (it rotates them). Who may see it is the control
   * plane's decision (a Maintainer of that project); this side only derives. User mode has no
   * webhooks, and a bot without a webhook secret none either (the adapter's terminal refusal):
   * both are 501, a door that is not there rather than a failure.
   */
  const gitlabHookToken = gitlabRoute(GitlabHookTokenRequestSchema, async (api, req) => {
    const { projectId, generation } = req;
    if (api.mode.mode === "user") {
      return json(501, { error: `${GITLAB_USER_MODE} — it has no webhooks` });
    }
    try {
      return json(200, { token: await api.hookToken(projectId, generation) });
    } catch (err) {
      // The adapter's one refusal is "no RYPH_GITLAB_WEBHOOK_SECRET": a door not there.
      if (err instanceof ForgeApiError && err.terminal) {
        return json(501, { error: err.message, terminal: true });
      }
      throw err;
    }
  }, "hook_token");

  /** GitHub user mode's two connect questions; 501 everywhere else, as the App's routes are
   * where there is no App. */
  const notUserMode = () => json(501, { error: "the forge is not in GitHub user mode" });

  /** Every repo the token's person can reach — the connect flow's picker. */
  const githubRepos = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    if (githubUser === null) return notUserMode();
    try {
      return json(200, { repos: await githubUser.listUserRepos() });
    } catch (err) {
      const terminal = err instanceof ForgeApiError && err.terminal;
      diag.warn("service.github_repos_failed", { terminal, err: String(err) });
      return json(502, { error: err instanceof Error ? err.message : String(err), terminal });
    }
  };

  /**
   * One repo as GitHub describes it to the token's person — what a user-mode connect stores:
   * GitHub's own spelling of the name, its clone URL and default branch, never the caller's.
   * A 404 is GitHub saying there is no such repo this token can see, which no retry changes.
   */
  const githubDescribe = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, GithubDescribeRequestSchema);
    if (!body.ok) return body.res;
    if (githubUser === null) return notUserMode();
    const { repoRef } = body.data;
    try {
      const described = await githubUser.describeRepo(repoRef);
      if (described === null) {
        return json(404, {
          error: `GitHub has no repository ${repoRef} that @${githubUser.login} can see`,
          terminal: true,
        });
      }
      return json(200, described);
    } catch (err) {
      const terminal = err instanceof ForgeApiError && err.terminal;
      diag.warn("service.github_describe_failed", { repo: repoRef, terminal, err: String(err) });
      return json(502, { error: err instanceof Error ? err.message : String(err), terminal });
    }
  };

  /** The three Radicle-only questions, in one shape: a RID in, the bridge's answer out. */
  const radicleRoute = (
    act: (api: RadicleBridgeApi, repoRef: string) => Promise<Response>,
    what: string,
  ) =>
  async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, RadicleRepoRequestSchema);
    if (!body.ok) return body.res;
    if (radicle === null) return json(501, { error: "no Radicle node is configured" });
    try {
      return await act(radicle, body.data.repoRef);
    } catch (err) {
      // Terminality travels: the connect flow tells "this node holds no such repository"
      // (which a retry cannot change) from "the node did not answer".
      const terminal = err instanceof ForgeApiError && err.terminal;
      diag.warn(`service.radicle_${what}_failed`, {
        repo: body.data.repoRef,
        terminal,
        err: String(err),
      });
      return json(terminal ? 404 : 502, {
        error: err instanceof Error ? err.message : String(err),
        terminal,
      });
    }
  };

  /**
   * What a path on this machine is, as the connect flow needs it: the real path a `local` repo
   * is recorded under (its `repoRef` and its `url`) and the branch its HEAD points at — or, in
   * words and a code, why it cannot be connected. Asked HERE because the forge is what will
   * read the repository and push into it: the root that fences those is this process's, and so
   * is the disk.
   */
  const localDescribe = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    if (localRoot === null) return json(501, { error: "local repositories are not enabled" });
    const body = await parse(req, LocalDescribeRequestSchema);
    if (!body.ok) return body.res;
    const described = await describeLocalRepo(body.data.path, localRoot, gitExec);
    if (!described.ok) {
      // The admin's own wording: this route answers the person who typed the path. `root`, on an
      // `outside_root`, is where repositories CAN be connected from — the allowed root's real
      // path (as configured, when it does not exist at all).
      return json(422, {
        error: described.message,
        reason: described.reason,
        ...(described.root === undefined ? {} : { root: described.root }),
      });
    }
    const { path, defaultBranch } = described.repo;
    return json(200, { repoRef: path, url: path, defaultBranch });
  };

  /** A route's answer before it is a Response: one computed diff is answered to every reader
   * that was waiting on it, and a Response body can be read only once. */
  type Answer = { status: number; body: unknown };
  const diffsInFlight = new Map<string, Promise<Answer>>();

  /** Files a computed diff beside its bundle. Best effort: an unfiled diff is computed again. */
  const fileDiff = async (key: string, diff: unknown): Promise<void> => {
    const path = `${config.stagingDir}/${crypto.randomUUID()}.diff.json`;
    try {
      await writeFile(path, JSON.stringify(diff), { flag: "wx" });
      await patches.put(key, path); // consumes the staging file
    } catch (err) {
      diag.warn("service.patch_diff_cache_unwritable", { key, err: String(err) });
      await rm(path).catch(() => {});
    }
  };

  /** A patch's stored bundle, staged — or the answer that refuses it. `release` removes the
   * scratch repo and the bundle's staging file. */
  type PatchStaging =
    | { ok: true; staged: StagedBundle; prerequisites: string[]; release: () => Promise<void> }
    | { ok: false; answer: Answer };

  /**
   * The first half of every read of a patch's change (its diff, its hook files): the bundle out of
   * the store, staged on the commits it requires — each fetched by id where the cache lacks it,
   * and, for a settled patch, the one it says it was cut from — and verified as a submission
   * verifies it, so its head must be the one intake recorded. Only a bundle that requires nothing
   * at all is staged on the target branch instead. The scratch repo borrows the cache entry's
   * objects, so the base's commits are readable in it by id.
   */
  const stagePatch = async (p: {
    /** The route's event prefix, so a failure is logged as whose. */
    event: string;
    about: Record<string, unknown>;
    bundleKey: string;
    branchName: string;
    headSha: string;
    reportedBase: string | null;
    targetRef: string;
    targetBranch: string;
    upstream: string;
    credential: Credential;
  }): Promise<PatchStaging> => {
    const refused = (status: number, body: unknown): PatchStaging => ({
      ok: false,
      answer: { status, body },
    });
    const unavailable = (what: string, err: unknown) => {
      diag.warn(`${p.event}_${what}`, { ...p.about, err: String(err) });
      return refused(503, { error: "base cache unavailable, retry", terminal: false });
    };
    const coords = { url: p.upstream };

    let bundle;
    try {
      bundle = await patches.get(p.bundleKey);
    } catch (err) {
      return unavailable("bundle_unreadable", err);
    }
    if (bundle === null) {
      return refused(410, { error: `no bundle at ${p.bundleKey}`, terminal: true });
    }
    const bundlePath = `${config.stagingDir}/${crypto.randomUUID()}.bundle`;
    const dropBundle = () => rm(bundlePath).catch(() => {});
    let handedOver = false;
    try {
      try {
        await stageStream(bundle, bundlePath);
      } catch (err) {
        return unavailable("bundle_unreadable", err);
      }

      let prerequisites: string[];
      try {
        ({ prerequisites } = await readBundleHeader(bundlePath));
      } catch (err) {
        diag.warn(`${p.event}_unverified`, { ...p.about, err: String(err) });
        return refused(409, { error: `the stored bundle is unreadable: ${err}`, terminal: true });
      }
      const reported = p.reportedBase === null ? [] : [p.reportedBase];
      const needed = [...new Set([...reported, ...prerequisites])];
      const byBranch = needed.length === 0;

      let cacheDir = "";
      try {
        if (byBranch) {
          cacheDir = (await cache.find(coords, p.targetRef))?.dir ??
            (await cache.serveBase(coords, p.targetRef, p.credential)).dir;
        }
        for (const commit of needed) {
          cacheDir = (await cache.ensureCommit(coords, commit, p.credential)).dir;
        }
      } catch (err) {
        if (err instanceof UpstreamRefused && err.reason !== "repo") {
          diag.warn(`${p.event}_base_refused`, { ...p.about, err: String(err) });
          return refused(409, {
            error: byBranch
              ? `the branch this patch lands on, ${p.targetBranch}, is gone from the repo`
              : "a commit this patch was cut from is gone from the repo",
            terminal: true,
          });
        }
        return unavailable("base_unavailable", err);
      }

      let staged: StagedBundle;
      try {
        staged = await stageBundle({
          upstreamUrl: p.upstream,
          cacheDir,
          // With the commits it requires in hand, no branch: their objects are borrowed.
          baseBranch: byBranch ? p.targetBranch : null,
          branchName: p.branchName,
          expectedHeadSha: p.headSha,
          bundlePath,
          scratchParent: config.stagingDir,
          // Borrowed, not copied: the scratch repo lives for one read.
          shareCacheObjects: true,
          git: gitExec,
          // Never reached: the cache seeds the base, so the upstream fallback is not taken.
          authedGit: gitExec,
        });
      } catch (err) {
        if (err instanceof TerminalSubmitError) {
          diag.warn(`${p.event}_unverified`, { ...p.about, err: String(err) });
          return refused(409, { error: err.message, terminal: true });
        }
        return unavailable("stage_failed", err);
      }
      handedOver = true;
      return {
        ok: true,
        staged,
        prerequisites,
        release: async () => {
          await staged.dispose();
          await dropBundle();
        },
      };
    } finally {
      if (!handedOver) await dropBundle();
    }
  };

  /**
   * A newborn patch's lineage, for the control plane deciding whether it waits for a person
   * (orchestrator core/open_patch.ts): which of the run's other lines it holds commits of, and
   * whether it holds the tip its line's change request merged at (`mustHold`). The runner checks
   * both itself, but shares its container with the agent; this reads the bundles intake stored.
   *
   * Each bundle is staged as a diff stages it (`stagePatch`, with no reported base: the runner's
   * word would let it name another line's work as its base) and its own commits listed: those
   * past its prerequisites and the tip of `targetRef`, so work already on the branch it lands on
   * is nobody's own. A line whose own commits share any with the newborn's is in `overlaps`.
   * `holdsTip` answers only where `mustHold` was asked: false where the repo has no such commit.
   * 200 `{ overlaps, holdsTip? }`; anything that keeps an answer out of reach is the staging's
   * refusal or a 503, and the caller holds the patch rather than guess.
   */
  const patchLineageRoute = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, PatchLineageRequestSchema);
    if (!body.ok) return body.res;
    const { repo, url, connectedRepoId, targetRef, patch, others, mustHold } = body.data;
    const about = { repo: repo.repoRef, connectedRepoId, headSha: patch.headSha };
    if (
      [patch, ...others].some((b) =>
        !b.bundleKey.endsWith(`/${connectedRepoId}/${b.headSha}.bundle`)
      )
    ) {
      return json(400, { error: "a bundle key is not this repo's head", terminal: true });
    }
    let targetBranch: string;
    try {
      targetBranch = normalizeBaseRef(targetRef).localBranch;
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err), terminal: true });
    }
    const resolved = await upstreamOf(repo, url);
    if (resolved instanceof Response) return resolved;
    const { upstream, credential, coords } = resolved;
    const unavailable = (err: unknown) => {
      diag.warn("service.patch_lineage_unavailable", { ...about, err: String(err) });
      return json(503, { error: "the patch's lineage could not be read now", terminal: false });
    };

    let baseTip: string;
    let tipHeld = false;
    try {
      // The entry's copy when it has one: a tip behind the upstream's only counts fewer commits
      // as the branch's, which answers more overlap, never less.
      baseTip = ((await cache.find(coords, targetRef)) ??
        (await cache.serveBase(coords, targetRef, credential))).commit;
      if (mustHold !== undefined) {
        tipHeld = await cache.ensureCommit(coords, mustHold, credential).then(
          () => true,
          (err) => {
            if (err instanceof UpstreamRefused && err.reason === "missing-commit") return false;
            throw err;
          },
        );
      }
    } catch (err) {
      return unavailable(err);
    }
    /** A bundle's own commits, and whether its head holds `mustHold` where that is asked. */
    const read = async (b: (typeof others)[number] | typeof patch) => {
      const staging = await stagePatch({
        event: "service.patch_lineage",
        about,
        bundleKey: b.bundleKey,
        branchName: b.branchName,
        headSha: b.headSha,
        reportedBase: null,
        targetRef,
        targetBranch,
        upstream,
        credential,
      });
      if (!staging.ok) return staging.answer;
      try {
        const { dir, headSha } = staging.staged;
        const listed = await gitExec(
          dir,
          "rev-list",
          headSha,
          "--not",
          ...staging.prerequisites,
          baseTip,
        );
        return {
          own: new Set(listed.split("\n").filter((l) => l !== "")),
          holds: mustHold !== undefined && tipHeld &&
            await isAncestor(gitExec, dir, mustHold, headSha),
        };
      } finally {
        await staging.release();
      }
    };
    try {
      const born = await read(patch);
      if (!("own" in born)) return json(born.status, born.body);
      const overlaps: string[] = [];
      for (const other of others) {
        const theirs = await read(other);
        if (!("own" in theirs)) return json(theirs.status, theirs.body);
        if ([...theirs.own].some((c) => born.own.has(c))) overlaps.push(other.line);
      }
      diag.debug("service.patch_lineage", { ...about, overlaps, holdsTip: born.holds });
      return json(200, { overlaps, ...(mustHold === undefined ? {} : { holdsTip: born.holds }) });
    } catch (err) {
      return unavailable(err);
    }
  };

  /**
   * A patch's diff, for the person deciding whether to approve it; helpers/patch_diff.ts says how
   * it is measured. The bundle is staged on the commits it requires and verified as a submission
   * verifies it, so its head must be the one intake recorded. A settled patch's diff is filed under its head for good; an unpublished
   * one's under its head and the tip it was measured against, so a tip that moved — a base gone
   * on, a change request pushed to, a force-push — makes it again, and an unchanged one is a
   * single store read. Concurrent first reads of one key share the one computation.
   *
   * Not the file-read API the file's invariants rule out: the key is pinned to this repo's
   * head (as the candidate route pins it), and what comes back is the change the bundle makes,
   * which is what the orchestrator already lets this caller approve.
   */
  const patchDiffRoute = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, PatchDiffRequestSchema);
    if (!body.ok) return body.res;
    const { repo, url, connectedRepoId, bundleKey, branchName, headSha, baseSha, targetRef, mode } =
      body.data;
    const about = { repo: repo.repoRef, connectedRepoId, headSha };
    if (!bundleKey.endsWith(`/${connectedRepoId}/${headSha}.bundle`)) {
      return json(400, { error: "the bundle key is not this repo's head", terminal: true });
    }
    let targetBranch: string;
    try {
      targetBranch = normalizeBaseRef(targetRef).localBranch;
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err), terminal: true });
    }
    const resolved = await upstreamOf(repo, url);
    if (resolved instanceof Response) return resolved;
    const { upstream, credential, coords } = resolved;

    // The tip of the branch the patch lands on, as the upstream has it now, read at most once:
    // the commit, or the branch gone (the upstream said so), or no answer (try again later). An
    // old copy served through an outage is no answer: a live diff measured from it would show
    // the reviewer a base the submission no longer lands on.
    type TipRead = { kind: "tip"; sha: string } | { kind: "gone" } | { kind: "unavailable" };
    let tipRead: Promise<TipRead> | undefined;
    const readTip = () =>
      tipRead ??= cache.serveBase(coords, targetRef, credential).then(
        (served): TipRead => {
          if (served.freshness.kind === "fresh") return { kind: "tip", sha: served.commit };
          diag.warn("service.patch_diff_tip_stale", { ...about, since: served.freshness.since });
          return { kind: "unavailable" };
        },
        (err): TipRead => {
          diag.warn("service.patch_diff_tip_unavailable", { ...about, err: String(err) });
          return err instanceof UpstreamRefused && err.reason === "missing-ref"
            ? { kind: "gone" }
            : { kind: "unavailable" };
        },
      );
    const tip = async () => {
      const read = await readTip();
      if (read.kind === "unavailable") {
        throw new TipUnavailableError("the branch this patch lands on could not be read now");
      }
      return read.kind === "tip" ? read.sha : null;
    };

    const prefix = `${bundleKey.slice(0, -".bundle".length)}.diff-v${PATCH_DIFF_VERSION}`;
    let diffKey: string;
    if (mode === "live") {
      // Nothing is measured against a tip that could not be read: the branch gone is final, as
      // nothing can be published to it; no answer is worth another try.
      const at = await readTip();
      if (at.kind === "gone") {
        return json(409, {
          error: `the branch this patch would land on, ${targetBranch}, is gone from the repo`,
          terminal: true,
        });
      }
      if (at.kind === "unavailable") return json(503, { error: "base cache unavailable, retry" });
      diffKey = `${prefix}.live.${at.sha}.json`;
    } else {
      diffKey = `${prefix}.record.${baseSha ?? "unreported"}.json`;
    }
    try {
      const stored = await patches.get(diffKey);
      if (stored !== null) {
        return new Response(stored, { headers: { "content-type": "application/json" } });
      }
    } catch (err) {
      // A cache that cannot be read is a cache miss: the diff is computed as if it were cold.
      diag.warn("service.patch_diff_cache_unreadable", { ...about, err: String(err) });
    }
    let pending = diffsInFlight.get(diffKey);
    if (pending === undefined) {
      pending = computeDiff().finally(() => diffsInFlight.delete(diffKey));
      diffsInFlight.set(diffKey, pending);
    }
    const { status, body: answerBody } = await pending;
    return json(status, answerBody);

    async function computeDiff(): Promise<Answer> {
      const staging = await stagePatch({
        event: "service.patch_diff",
        about,
        bundleKey,
        branchName,
        headSha,
        reportedBase: mode === "record" ? baseSha : null,
        targetRef,
        targetBranch,
        upstream,
        credential,
      });
      if (!staging.ok) return staging.answer;
      try {
        const diff = await patchDiff({
          dir: staging.staged.dir,
          headSha,
          mode,
          baseSha,
          prerequisites: staging.prerequisites,
          tip,
          maxBytes: MAX_PATCH_DIFF_BYTES,
          git: gitExec,
          capped: gitCapped,
        });
        diag.debug("service.patch_diff", {
          ...about,
          mode,
          bytes: diff.diff.length,
          truncated: diff.truncated,
        });
        await fileDiff(diffKey, diff);
        return { status: 200, body: diff };
      } catch (err) {
        if (err instanceof TipUnavailableError) {
          return { status: 503, body: { error: "base cache unavailable, retry" } };
        }
        if (err instanceof UnanchoredDiffError) {
          diag.warn("service.patch_diff_unanchored", { ...about, err: String(err) });
          return { status: 409, body: { error: err.message, terminal: true } };
        }
        diag.warn("service.patch_diff_failed", { ...about, err: String(err) });
        return { status: 502, body: { error: "could not diff the patch" } };
      } finally {
        await staging.release();
      }
    }
  };

  /**
   * Which hook files of the repository a `local` patch would land in it touches — asked BEFORE a
   * person approves the patch, so the approval can name them (core/hook_files.ts on why a hook
   * file needs a person). The patch-diff route's request, in live mode: the same bundle, staged
   * the same way, against the tip of the branch it lands on as the repository has it now, and
   * the repository's hook config as it is now. Never filed: both can change before delivery, and
   * the delivery asks again — this is the question's early copy, the delivery is the boundary.
   */
  const patchHooksRoute = async (req: Request): Promise<Response> => {
    // Every failure says whether a retry could change it (`terminal`), an unexpected throw
    // included: that is a 500 a retry may well clear.
    try {
      return await patchHooks(req);
    } catch (err) {
      diag.warn("service.patch_hooks_threw", { err: String(err) });
      return json(500, { error: "could not check the patch for hook files", terminal: false });
    }
  };

  const patchHooks = async (req: Request): Promise<Response> => {
    // Every failure says whether a retry could change it (`terminal`): the control plane fails
    // the patch on a terminal one and asks again later on any other.
    if (await authenticated(req)) return json(401, { error: "unauthorized", terminal: false });
    const body = await parse(req, PatchDiffRequestSchema);
    if (!body.ok) return body.res;
    const { repo, url, connectedRepoId, bundleKey, branchName, headSha, targetRef, mode } =
      body.data;
    const about = { repo: repo.repoRef, connectedRepoId, headSha };
    if (mode !== "live") {
      return json(400, {
        error: "hook files are checked for a patch not yet delivered: mode must be live",
        terminal: true,
      });
    }
    if (repo.provider !== "local") {
      return json(422, {
        error: "hook files are checked only for a repository on this machine",
        terminal: true,
      });
    }
    if (!bundleKey.endsWith(`/${connectedRepoId}/${headSha}.bundle`)) {
      return json(400, { error: "the bundle key is not this repo's head", terminal: true });
    }
    let targetBranch: string;
    try {
      targetBranch = normalizeBaseRef(targetRef).localBranch;
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err), terminal: true });
    }
    const resolved = await upstreamOf(repo, url);
    if (resolved instanceof Response) return resolved;
    const { upstream, credential } = resolved;

    // The tip the patch would land on, fresh: the touched paths are measured from where the
    // patch forks off it, as the delivery measures them.
    let tipSha: string;
    try {
      const served = await cache.serveBase(resolved.coords, targetRef, credential);
      if (served.freshness.kind !== "fresh") {
        diag.warn("service.patch_hooks_tip_stale", { ...about, since: served.freshness.since });
        return json(503, { error: "base cache unavailable, retry", terminal: false });
      }
      tipSha = served.commit;
    } catch (err) {
      diag.warn("service.patch_hooks_tip_unavailable", { ...about, err: String(err) });
      if (err instanceof UpstreamRefused && err.reason === "missing-ref") {
        return json(409, {
          error: `the branch this patch would land on, ${targetBranch}, is gone from the repo`,
          terminal: true,
        });
      }
      return json(503, { error: "base cache unavailable, retry", terminal: false });
    }

    const staging = await stagePatch({
      event: "service.patch_hooks",
      about,
      bundleKey,
      branchName,
      headSha,
      reportedBase: null,
      targetRef,
      targetBranch,
      upstream,
      credential,
    });
    if (!staging.ok) return json(staging.answer.status, staging.answer.body);
    try {
      const { hookFiles, roots } = await hookFilesOfPatch({
        target: upstream,
        scratch: staging.staged.dir,
        baseTip: tipSha,
        head: headSha,
        git: gitExec,
        bounded: gitBounded,
      });
      diag.debug("service.patch_hooks", { ...about, hookFiles: hookFiles.length });
      return json(200, reportHookFiles(hookFiles, roots));
    } catch (err) {
      if (err instanceof HookCheckTooLargeError) {
        return json(409, { error: err.message, terminal: true });
      }
      diag.warn("service.patch_hooks_failed", { ...about, err: String(err) });
      return json(502, { error: "could not check the patch for hook files", terminal: false });
    } finally {
      await staging.release();
    }
  };

  // Only the control plane can read intake artifacts. This is not a URL fetcher and never
  // accepts a filesystem path: the store validates the bounded bundle key too. Stream it so
  // delegating a large commit does not retain the bundle in the control plane's heap.
  const readCheckBundle = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parse(req, ReadCheckBundleSchema);
    if (!body.ok) return body.res;
    try {
      const stream = await patches.get(body.data.bundleKey);
      if (stream === null) return json(404, { error: "no such check bundle" });
      return new Response(stream, {
        headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
      });
    } catch {
      return json(503, { error: "could not read the check bundle" });
    }
  };

  const radicleIdentity = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    if (radicle === null) return json(501, { error: "no Radicle node is configured" });
    try {
      return json(200, await radicle.identity());
    } catch (err) {
      diag.warn("service.radicle_identity_failed", { err: String(err) });
      return json(502, { error: err instanceof Error ? err.message : String(err) });
    }
  };

  return [
    route("POST", "/v1/service/submit", submit),
    route("GET", "/v1/service/providers", providers),
    route("GET", "/v1/service/github/repos", githubRepos),
    route("POST", "/v1/service/github/describe", githubDescribe),
    route("GET", "/v1/service/gitlab/projects", gitlabProjects),
    route("POST", "/v1/service/gitlab/describe", gitlabDescribe),
    route("POST", "/v1/service/gitlab/hook-token", gitlabHookToken),
    route("POST", "/v1/service/gitlab/user", gitlabUser),
    route("POST", "/v1/service/local/describe", localDescribe),
    route("GET", "/v1/service/radicle/identity", radicleIdentity),
    route(
      "POST",
      "/v1/service/radicle/repo",
      radicleRoute(async (api, repoRef) => json(200, await api.describeRepo(repoRef)), "repo"),
    ),
    route(
      "POST",
      "/v1/service/radicle/seed",
      radicleRoute(async (api, repoRef) => {
        const outcome = await api.seedRepo(repoRef);
        // "The node was asked and the network handed back nothing" travels as its own status,
        // because the connect flow answers it with a command rather than with "not found".
        // So does a user-mode bridge's "the owner's node blocks it".
        return outcome.kind === "seeded" ? json(200, outcome.repo) : json(409, outcome);
      }, "seed"),
    ),
    route(
      "POST",
      "/v1/service/radicle/unseed",
      radicleRoute(async (api, repoRef) => {
        await api.unseedRepo(repoRef);
        return json(200, { unseeded: true });
      }, "unseed"),
    ),
    route("POST", "/v1/service/services-file", servicesFile),
    route("POST", "/v1/service/ryph-tree", ryphTree),
    route("POST", "/v1/service/ryph-base", ryphBase),
    route("POST", "/v1/service/checks-file", checksFile),
    route("POST", "/v1/service/skills-tree", skillsTree),
    route("POST", "/v1/service/check-bundle", checkBundle),
    route("POST", "/v1/service/check-bundle/read", readCheckBundle),
    route("POST", "/v1/service/patch-diff", patchDiffRoute),
    route("POST", "/v1/service/patch-lineage", patchLineageRoute),
    route("POST", "/v1/service/local/patch-hooks", patchHooksRoute),
    route("POST", "/v1/service/checks/report", reportChecks),
    route("POST", "/v1/service/default-branch-head", defaultBranchHead),
    route("POST", "/v1/service/branch-kind", branchKind),
    route("POST", "/v1/service/branch-head", branchHead),
    route("POST", "/v1/service/permission", permission),
    route("POST", "/v1/service/visibility", visibility),
    route("POST", "/v1/service/org-membership", orgMembership),
    route("POST", "/v1/service/installation", installation),
    route("POST", "/v1/service/installation-settings", installationSettings),
    route("POST", "/v1/service/comment", comment),
    route("POST", "/v1/service/comment/update", commentUpdate),
    route("POST", "/v1/service/reaction", reaction),
    route("POST", "/v1/service/thread", thread),
    route("POST", "/v1/service/change-request-head", changeRequestHead),
    route("POST", "/v1/service/merge-containment", mergeContainment),
    route("POST", "/v1/service/oauth/exchange", oauthExchange),
  ];
}

// `ChangeTransport` on GitLab: push the branch with the forge's token (`Basic oauth2:<token>`),
// then open the merge request — or adopt the open one for that source branch — or, for an
// existing `mr-<iid>`, push onto its own branch. GitHub's transport step for step
// (change_transport/github.ts); what differs is GitLab's spelling and one rule GitHub lacks.
//
// Invariants (the port's, kept here):
// - the head that leaves is checked against the head intake recorded, inside `pushBundle`
// - an existing merge request is looked at NOW, not as it was when the command arrived: hours
//   can pass, and pushing onto a branch is only right while that branch is still the open merge
//   request's source, in this project
// - terminality is named on every failure, because the orchestrator's retry clock reads it
// - a fork's branch is pushed to only when the connected repo allows it AND the merge request
//   does NOW: still open, its author still allowing commits from members who can merge
//   (`allow_collaboration`), the run built on its head (`merge-requests/<iid>/head`), and the
//   branch not the fork's default. GitLab adds a rule of its own: only an account that may MERGE
//   into the target branch may push to a fork's source branch, which a Developer bot facing a
//   protected default branch may not. That is GitLab's answer at the push, and its refusal is
//   final and said as that rule. Never a fallback: a fork push that is refused or rejected fails
//   the delivery, it never opens a merge request somewhere else
// - each line of a run (`ryph/<agent>/<run>/<line>`) is its own delivery with its own branch,
//   so several unrelated merge requests per project per run are several deliveries, each
//   converging on its own merge request; nothing here reads the namespace
// - the project is reached by its id alone (`ChangeDelivery.repo.forgeId`), located afresh:
//   a delivery without one is refused, never pushed or opened by path

import type {
  ChangeDelivery,
  ChangeDeliveryOutcome,
  ChangeTransport,
} from "../../ports/change_transport.ts";
import {
  type ChangeRequestHead,
  type ForgeApi,
  ForgeApiError,
  type GitlabRepo,
} from "../../ports/forge_api.ts";
import type { GitlabDelivery } from "../../ports/gitlab.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import { type FetchAuth, type RepoCache, repoCacheCoords } from "../../ports/repo_cache.ts";
import { BundleUnverifiableError, pushBundle, TerminalSubmitError } from "../../helpers/submit.ts";
import { changeRequestHeadRef, checkoutBranchOf } from "@ryph/shared/refs";
import { headInRepo } from "../../core/provider_rules.ts";
import { type Git, makeGit, renewingGit } from "../../helpers/git_exec.ts";
import { authorizationValue } from "../repo_cache/local_fs.ts";

export interface GitlabChangeTransportOptions {
  /** The GitLab adapter: it says which credential a push is made with, and opens the MR. */
  api: ForgeApi & GitlabDelivery;
  /** Seeds the base objects from local disk when it holds them — the fast path. */
  cache: RepoCache;
  diag: Diagnostics;
  /** A traced hermetic git; the credentialed one is derived from it per delivery. */
  git?: Git;
}

/** How a person reads a merge request's thread ref: `mr-7` is `!7`. Anything else (a ref this
 * transport was handed but GitLab never spelled) is shown as given. */
function mrLabel(ref: string): string {
  const iid = /^mr-(\d+)$/.exec(ref)?.[1];
  return iid === undefined ? ref : `!${iid}`;
}

/**
 * Why a push onto this merge request's branch would be wrong, or null when it would not. The
 * orchestrator asked the same questions when the command arrived; they are asked again here
 * because the answers can change while a run works, and this is where the push happens.
 */
function changeRefusal(
  mr: ChangeRequestHead,
  projectPath: string,
  expectedBranch: string,
  allowForkPush: boolean,
): string | null {
  if (mr.merged) return "it has been merged";
  // A `locked` merge request (a merge underway) never arrives here: the adapter answers it as a
  // retryable refusal to ask again, since it ends merged or open.
  if (mr.state !== "open") return "it has been closed";
  if (mr.headRepoRef === null) return `its branch lived in a fork that has since been deleted`;
  if (!headInRepo(mr, "gitlab", projectPath)) {
    return forkRefusal(mr, projectPath, expectedBranch, allowForkPush);
  }
  if (mr.headRef !== expectedBranch) {
    return `its branch is now ${mr.headRef}, not the ${expectedBranch} the run started from`;
  }
  if (mr.headRef === mr.defaultBranch) {
    // The default branch can be reassigned while a run works. Whatever it is NOW is the one
    // branch no agent commits land on, however the merge request looked at the command.
    return `its branch ${mr.headRef} is now ${projectPath}'s default branch`;
  }
  return null;
}

/**
 * Why a push onto this fork merge request's branch would be wrong, or null when it would not.
 *
 * Exactly one case is let through, every part of it asked again here: the connected repo allows
 * fork pushes, the merge request is open (asked by the caller), its author still allows commits
 * from members who can merge, the run started from the merge request's head as the target
 * project serves it (`merge-requests/<iid>/head`, the only way a fork's head reaches a run), the
 * branch is not the fork's default branch, and its name is one the push can spell. Whether the
 * account may merge into the target branch — GitLab's own condition on such a push — is GitLab's
 * answer, at the push: nothing here can read it without asking the same question twice.
 */
function forkRefusal(
  mr: ChangeRequestHead,
  projectPath: string,
  expectedBranch: string,
  allowForkPush: boolean,
): string | null {
  const where = `its branch lives in the fork ${mr.headRepoRef}`;
  // GitLab answers a private fork the account is no member of 404: nothing to push to.
  if (mr.headRepoHidden === true) {
    return `${where}, which GitLab will not show ryph (a private fork ryph is no member of)`;
  }
  if (!allowForkPush) {
    return `${where}, and pushing to fork branches is not enabled for ${projectPath}`;
  }
  if (mr.maintainerCanModify !== true) {
    return `${where}, and its author does not allow commits from members who can merge`;
  }
  if (expectedBranch !== changeRequestHeadRef("gitlab", mr.ref)?.slice("refs/".length)) {
    // A run on any other base did not build on the fork's head — its commits would land on a
    // branch they were never made against.
    return `${where}, and the run did not start from it`;
  }
  if (mr.headRepoDefaultBranch === undefined || mr.headRepoDefaultBranch === null) {
    return `${where}, and the forge did not say which branch is that fork's default`;
  }
  if (mr.headRef === mr.headRepoDefaultBranch) {
    return `${where}, on that fork's default branch, which ryph does not push onto`;
  }
  // The control plane's door asks this same rule (`checkoutBranchOf`), so what the
  // commenter was told up front is what is decided here. The name is the fork author's: never
  // repeated, since this text reaches the thread.
  if (checkoutBranchOf(mr.headRef) === null) {
    return `${where}, on a branch whose name ryph cannot push to`;
  }
  return null;
}

/**
 * Where a push onto a fork's branch goes: the fork's `http_url_to_repo` as the forge reported it,
 * held to the connected repo's own origin — the instance's, the only one the token is offered to.
 * A path upstream (dev, tests) takes a path fork. Null: nowhere this transport will push.
 */
function forkPushUrl(mr: ChangeRequestHead, repoUrl: string): string | null {
  const url = mr.headRepoUrl;
  if (url === undefined || url === null || url === "") return null;
  const isHttp = (u: string) => /^https?:\/\//.test(u);
  if (!isHttp(repoUrl)) return isHttp(url) ? null : url;
  if (!isHttp(url)) return null;
  return new URL(url).origin === new URL(repoUrl).origin ? url : null;
}

/**
 * GitLab's own words for a push it will not take for want of permission, verified over HTTP on
 * GitLab 17.11:
 * - no push right on the project at all (a fork's branch without merge rights on the target, a
 *   Reporter): an HTTP 403 before any ref, `remote: You are not allowed to push code to this
 *   project.` and git's `The requested URL returned error: 403`;
 * - per ref, from the pre-receive hook: `GitLab: You are not allowed to push code to protected
 *   branches on this project.`, `… to force push code to a protected branch on this project.`,
 *   and `… to push code to this project.` for a fork branch no merge request opens to us;
 * - a token without `write_repository`/`api`: 403 `You are not allowed to upload code.`
 * Terminal: no retry grants a role or unprotects a branch. A 401 (a token rejected) is not in it —
 * that is a credential to renew, not a permission. A private fork is out of reach altogether
 * (git's "repository … not found"), but GitLab never lets its merge request allow
 * collaboration, so `forkRefusal` stops that push before it is tried.
 */
const PERMISSION_REFUSED = /\b403\b|not allowed to (?:force )?push|protected branch/i;

export function gitlabChangeTransport(opts: GitlabChangeTransportOptions): ChangeTransport {
  const { api, cache, diag } = opts;
  const gitExec = opts.git ?? makeGit(diag);

  /** The credentialed git for one push target: the token rides an origin-scoped header on the
   * subprocess, never a URL, framed as the adapter says (`basicUser: "oauth2"`). A command
   * token rotated under us is renewed once on git's 401 and the command retried. */
  const credentialed = (auth: FetchAuth | null): Git =>
    auth === null ? gitExec : renewingGit(auth, (renewed) =>
      makeGit(diag, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${renewed.origin}/.extraheader`,
        GIT_CONFIG_VALUE_0: `Authorization: ${authorizationValue(renewed)}`,
      }));

  /**
   * The delivery pointed at where GitLab places its project NOW, by its id: the row's path can
   * have been freed by a rename and taken by another project, which a push or a merge request by
   * path would then reach. A delivery without an id is refused, terminally — never sent where
   * its URL or path says.
   */
  const locate = async (
    change: ChangeDelivery,
  ): Promise<(ChangeDelivery & { repo: GitlabRepo }) | ChangeDeliveryOutcome> => {
    const { forgeId } = change.repo;
    if (forgeId === undefined || api.locateUpstream === undefined) {
      diag.warn("transport.project_without_id", { repo: change.repo.repoRef });
      return {
        kind: "failed",
        message: `${change.repo.repoRef} came without its GitLab project id — a GitLab project ` +
          "is never pushed to or opened against by its path",
        terminal: true,
      };
    }
    try {
      const at = await api.locateUpstream({ ...change.repo, forgeId });
      return { ...change, repo: { ...change.repo, forgeId, repoRef: at.repoRef }, repoUrl: at.url };
    } catch (err) {
      const terminal = err instanceof ForgeApiError && err.terminal;
      diag.warn("transport.project_unlocated", { forgeId, terminal, err: String(err) });
      return {
        kind: "failed",
        message: err instanceof Error ? err.message : String(err),
        terminal,
      };
    }
  };

  return {
    async deliver(asked: ChangeDelivery): Promise<ChangeDeliveryOutcome> {
      const change = await locate(asked);
      if ("kind" in change) return change;
      const projectPath = change.repo.repoRef;
      const failed = (message: string, terminal: boolean): ChangeDeliveryOutcome => ({
        kind: "failed",
        message,
        terminal,
      });
      // The push credential: the bot's token, or the person's in user mode — only for the
      // instance's own origin. A path upstream (dev, tests) needs none and gets none. A URL off
      // the instance, or a tenant (GitLab has none), is refused terminally by the adapter;
      // anything else is a token that could not be had right now.
      let auth: FetchAuth | null;
      try {
        auth = await api.pushAuth(change.repo, change.repoUrl);
      } catch (err) {
        if (err instanceof ForgeApiError && err.terminal) {
          diag.warn("transport.token_refused", { repo: projectPath, err: err.message });
          return failed(err.message, true);
        }
        diag.warn("transport.token_unavailable", { err: String(err) });
        return failed("could not obtain a GitLab token to push with", false);
      }
      const authedGit = credentialed(auth);

      let target: ChangeRequestHead | null = null;
      if (change.existingRef !== null) {
        try {
          target = await api.describeChangeRequest(change.repo, change.existingRef);
        } catch (err) {
          const terminal = err instanceof ForgeApiError && err.terminal;
          diag.warn("transport.mr_unreadable", { repo: projectPath, terminal, err: String(err) });
          return failed(err instanceof Error ? err.message : String(err), terminal);
        }
        const refusal = changeRefusal(
          target,
          projectPath,
          change.baseBranch,
          change.allowForkPush === true,
        );
        if (refusal !== null) {
          // Terminal: none of these heal on their own, and a human can still retry the patch
          // once one does — reopening a merge request is a decision, not a blip.
          diag.warn("transport.mr_push_refused", { repo: projectPath, refusal });
          const ended = target.merged ? "merged" : target.state !== "open" ? "closed" : null;
          return {
            ...failed(`not pushing onto ${mrLabel(target.ref)}: ${refusal}`, true),
            ...(ended === null ? {} : { ended }),
          };
        }
      }

      // Onto a fork's branch: the push goes to the fork, with a credential asked for THAT URL.
      // In user mode the adapter presents the token to the connected project alone, so this is
      // refused there, terminally.
      const fork = target !== null && target.headRepoRef !== null &&
        !headInRepo(target, "gitlab", projectPath);
      let pushUrl: string | undefined;
      let pushGit = authedGit;
      if (fork) {
        const url = forkPushUrl(target!, change.repoUrl);
        if (url === null) {
          diag.warn("transport.fork_url_refused", { repo: projectPath, mr: target!.ref });
          return failed(
            `not pushing onto ${mrLabel(target!.ref)}: the forge gave no URL for the fork ` +
              `${target!.headRepoRef} that ryph will push to`,
            true,
          );
        }
        pushUrl = url;
        let forkAuth: FetchAuth | null;
        try {
          forkAuth = await api.pushAuth(change.repo, url);
        } catch (err) {
          const terminal = err instanceof ForgeApiError && err.terminal;
          diag.warn("transport.fork_token_refused", { repo: projectPath, terminal });
          return failed(
            `not pushing onto ${mrLabel(target!.ref)}: no credential here may push to the fork ` +
              `${target!.headRepoRef}${terminal ? ` (${(err as Error).message})` : ""}`,
            terminal,
          );
        }
        pushGit = credentialed(forkAuth);
      }

      try {
        await pushBundle({
          upstreamUrl: change.repoUrl,
          // The fork's head as the target project holds it, when the cache cannot seed it.
          ...(fork ? { baseRemoteRef: changeRequestHeadRef("gitlab", target!.ref)!, pushUrl } : {}),
          // Null unless the cache really holds the base branch: pushBundle fetches
          // refs/heads/<baseBranch> from this directory, and an entry without it would fail
          // the local fetch outright rather than fall through to the upstream.
          cacheDir: (await cache.find(
            repoCacheCoords(change.repoUrl, { provider: "gitlab", ...change.repo }),
            change.baseBranch,
          ))?.dir ?? null,
          baseBranch: change.baseBranch,
          branchName: change.branchName,
          expectedHeadSha: change.headSha,
          bundlePath: change.bundlePath,
          ...(target === null
            ? {}
            : { onto: { branch: target.headRef, expectedSha: target.headSha } }),
          git: gitExec,
          // The base is fetched from the connected project, the push goes to the fork: one
          // origin (`forkPushUrl`), so the fork's credential serves both.
          authedGit: pushGit,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // GitLab refusing for want of permission says so, and no retry changes a role or a
        // protected branch — on a fork or the project's own branch alike.
        const refused = !(err instanceof TerminalSubmitError) && PERMISSION_REFUSED.test(message);
        const terminal = err instanceof TerminalSubmitError || refused;
        diag.warn("transport.push_failed", { repo: projectPath, terminal, err: String(err) });
        if (fork && err instanceof BundleUnverifiableError) {
          // The bundle's base is gone from the fork's head: its author rewrote the branch while
          // the run worked. Said as that, not as a damaged bundle.
          return failed(
            `${mrLabel(target!.ref)}'s branch in the fork ${target!.headRepoRef} moved while the ` +
              "run worked (rewritten or force-pushed): the commits the run built on are no longer " +
              "on it, so its commits cannot be pushed there",
            true,
          );
        }
        if (refused && fork) {
          return failed(
            `GitLab refused the push onto ${mrLabel(target!.ref)}'s branch in the fork ` +
              `${target!.headRepoRef}: GitLab lets only an account that may merge into the ` +
              `target branch (${target!.baseRef}) push to a fork's merge request branch, and ` +
              "ryph's GitLab account may not (a Developer cannot merge into a protected branch), " +
              `or the author no longer allows commits from members who can merge — ${message}`,
            true,
          );
        }
        if (refused) {
          const onto = target === null
            ? `the branch ${change.branchName}`
            : `${mrLabel(target.ref)}'s branch ${target.headRef}`;
          return failed(
            `GitLab refused the push of ${onto} to ${projectPath}: ryph's GitLab account may ` +
              "not push there (the branch is protected, or the account is not a Developer on " +
              `the project) — ${message}`,
            true,
          );
        }
        return failed(`pushing the branch failed: ${message}`, terminal);
      }

      // The commits are IN the merge request now — there is nothing to open. The change's forge
      // identity is that merge request, which is also where the run's report already lives.
      if (target !== null) {
        diag.debug("transport.pushed_to_mr", { repo: projectPath, mr: target.ref });
        return { kind: "delivered", ref: target.ref, url: target.url };
      }

      try {
        const mr = await api.openMergeRequest(change.repo, {
          title: change.title,
          body: change.description,
          head: change.branchName,
          base: change.baseBranch,
          draft: change.draft,
        });
        diag.debug("transport.delivered", { repo: projectPath, mr: mr.ref });
        return { kind: "delivered", ref: mr.ref, url: mr.url };
      } catch (err) {
        const terminal = err instanceof ForgeApiError && err.terminal;
        diag.warn("transport.mr_failed", { repo: projectPath, terminal, err: String(err) });
        return failed(err instanceof Error ? err.message : String(err), terminal);
      }
    },
  };
}

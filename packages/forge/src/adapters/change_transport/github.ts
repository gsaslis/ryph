// `ChangeTransport` on GitHub: push the branch, then open — or adopt, or push onto — the pull
// request. Exactly the move the submit route used to make inline, moved behind the port so a
// second forge can deliver the same bundle its own way.
//
// Invariants (the port's, kept here):
// - the head that leaves is checked against the head intake recorded, inside `pushBundle`
// - an existing pull request is looked at NOW, not as it was when the command arrived: hours
//   can pass, and pushing onto a branch is only right while that branch is still the open pull
//   request's head, in this repo
// - terminality is named on every failure, because the orchestrator's retry clock reads it
// - a fork's branch is pushed to only when the connected repo allows it AND the pull request
//   does NOW: still open, its author still allowing maintainer edits, the run built on its head
//   (`pull/<n>/head`), and the branch not the fork's default. Never a fallback: a fork push that
//   is refused or rejected fails the delivery, it never opens a pull request somewhere else

import type {
  ChangeDelivery,
  ChangeDeliveryOutcome,
  ChangeTransport,
} from "../../ports/change_transport.ts";
import { type ChangeRequestHead, type ForgeApi, ForgeApiError } from "../../ports/forge_api.ts";
import type { GithubDelivery } from "../../ports/github_app.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import type { FetchAuth, RepoCache } from "../../ports/repo_cache.ts";
import { BundleUnverifiableError, pushBundle, TerminalSubmitError } from "../../helpers/submit.ts";
import { checkoutBranchOf } from "@ryph/shared/refs";
import { type Git, makeGit, renewingGit } from "../../helpers/git_exec.ts";
import { authorizationValue } from "../repo_cache/local_fs.ts";

export interface GithubChangeTransportOptions {
  /** The GitHub adapter, in either mode: it says which credential a push is made with. */
  api: ForgeApi & GithubDelivery;
  /** Seeds the base objects from local disk when it holds them — the fast path. */
  cache: RepoCache;
  diag: Diagnostics;
  /** A traced hermetic git; the credentialed one is derived from it per delivery. */
  git?: Git;
}

/**
 * Why a push onto this pull request's branch would be wrong, or null when it would not. The
 * orchestrator asked the same questions when the command arrived; they are asked again here
 * because the answers can change while a run works, and this is where the push happens.
 */
function changeRefusal(
  pr: ChangeRequestHead,
  repoFullName: string,
  expectedBranch: string,
  allowForkPush: boolean,
): string | null {
  if (pr.merged) return "it has been merged";
  if (pr.state !== "open") return "it has been closed";
  if (pr.headRepoRef === null) return `its branch lived in a fork that has since been deleted`;
  if (pr.headRepoRef.toLowerCase() !== repoFullName.toLowerCase()) {
    return forkRefusal(pr, repoFullName, expectedBranch, allowForkPush);
  }
  if (pr.headRef !== expectedBranch) {
    return `its branch is now ${pr.headRef}, not the ${expectedBranch} the run started from`;
  }
  if (pr.headRef === pr.defaultBranch) {
    // The default branch can be reassigned while a run works. Whatever it is NOW is the one
    // branch no agent commits land on, however the pull request looked at the command.
    return `its branch ${pr.headRef} is now ${repoFullName}'s default branch`;
  }
  return null;
}

/**
 * Why a push onto this fork pull request's branch would be wrong, or null when it would not.
 *
 * Exactly one case is let through, and every part of it is asked again here because hours can
 * pass between the command and the push: the connected repo allows fork pushes, the pull request
 * is open (asked by the caller), its author still allows edits from maintainers, the run started
 * from the pull request's head as the base repo serves it (`pull/<n>/head`, the only way a fork's
 * head reaches a run), the branch is not the fork's default branch, and its name is one the push
 * can spell. Whether GitHub then takes the App's push is GitHub's answer, at the push.
 */
function forkRefusal(
  pr: ChangeRequestHead,
  repoFullName: string,
  expectedBranch: string,
  allowForkPush: boolean,
): string | null {
  const where = `its branch lives in the fork ${pr.headRepoRef}`;
  if (!allowForkPush) {
    return `${where}, and pushing to fork branches is not enabled for ${repoFullName}`;
  }
  if (pr.maintainerCanModify !== true) {
    return `${where}, and its author does not allow edits from maintainers`;
  }
  if (expectedBranch !== `pull/${pr.ref}/head`) {
    // A run on any other base did not build on the fork's head — its commits would land on a
    // branch they were never made against.
    return `${where}, and the run did not start from it`;
  }
  if (pr.headRepoDefaultBranch === undefined || pr.headRepoDefaultBranch === null) {
    return `${where}, and the forge did not say which branch is that fork's default`;
  }
  if (pr.headRef === pr.headRepoDefaultBranch) {
    return `${where}, on that fork's default branch, which ryph does not push onto`;
  }
  // The control plane's door asks this same rule (`checkoutBranchOf`), so what the
  // commenter was told up front is what is decided here. The name is the fork author's: never
  // repeated, since this text reaches the thread.
  if (checkoutBranchOf(pr.headRef) === null) {
    return `${where}, on a branch whose name ryph cannot push to`;
  }
  return null;
}

/**
 * Where a push onto a fork's branch goes: the clone URL the forge reported for it, held to the
 * connected repo's own origin. The push credential is offered to that origin only, so a fork URL
 * anywhere else would be one no credential of ours belongs on. A path upstream (dev, tests) takes
 * a path fork. Null: nowhere this transport will push.
 */
function forkPushUrl(pr: ChangeRequestHead, repoUrl: string): string | null {
  const url = pr.headRepoUrl;
  if (url === undefined || url === null || url === "") return null;
  const isHttp = (u: string) => /^https?:\/\//.test(u);
  if (!isHttp(repoUrl)) return isHttp(url) ? null : url;
  if (!isHttp(url)) return null;
  return new URL(url).origin === new URL(repoUrl).origin ? url : null;
}

/** GitHub's own words for a push it would not take for want of permission — terminal, since no
 * retry grants it: maintainer edits withdrawn, a fork the App cannot reach, a workflow file
 * without the `workflows` permission. */
const PERMISSION_REFUSED =
  /\b403\b|permission to .* denied|refusing to allow|protected branch|not allowed to push/i;

export function githubChangeTransport(opts: GithubChangeTransportOptions): ChangeTransport {
  const { api, cache, diag } = opts;
  const gitExec = opts.git ?? makeGit(diag);

  return {
    async deliver(change: ChangeDelivery): Promise<ChangeDeliveryOutcome> {
      const repoFullName = change.repo.repoRef;
      const failed = (message: string, terminal: boolean): ChangeDeliveryOutcome => ({
        kind: "failed",
        message,
        terminal,
      });
      // The push credential: the installation's token as an App, the person's token in user
      // mode — whichever this repo's tenant names, and only for GitHub's own origin, injected
      // as an origin-scoped header on the git subprocess, never a URL. A path upstream (dev,
      // tests) needs no credential and gets none — the seam stays, inert. A tenant that does
      // not fit the mode, or a user token asked for somewhere that is not GitHub, is refused
      // terminally by the adapter; anything else is a token that could not be had right now.
      let auth: FetchAuth | null;
      try {
        auth = await api.pushAuth(change.repo, change.repoUrl);
      } catch (err) {
        if (err instanceof ForgeApiError && err.terminal) {
          diag.warn("transport.token_refused", { repo: repoFullName, err: err.message });
          return failed(err.message, true);
        }
        diag.warn("transport.token_unavailable", { err: String(err) });
        return failed("could not obtain a GitHub token to push with", false);
      }
      // A user token rotated under us is renewed once on git's 401 and the command retried —
      // the same single-flight refresh a REST call's 401 takes.
      const authedGit = auth === null ? gitExec : renewingGit(auth, (renewed) =>
        makeGit(diag, {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `http.${renewed.origin}/.extraheader`,
          GIT_CONFIG_VALUE_0: `Authorization: ${authorizationValue(renewed)}`,
        }));

      let target: ChangeRequestHead | null = null;
      if (change.existingRef !== null) {
        try {
          target = await api.describeChangeRequest(change.repo, change.existingRef);
        } catch (err) {
          const terminal = err instanceof ForgeApiError && err.terminal;
          diag.warn("transport.pr_unreadable", { repo: repoFullName, terminal, err: String(err) });
          return failed(err instanceof Error ? err.message : String(err), terminal);
        }
        const refusal = changeRefusal(
          target,
          repoFullName,
          change.baseBranch,
          change.allowForkPush === true,
        );
        if (refusal !== null) {
          // Terminal: none of these heal on their own, and a human can still retry the patch
          // once one does — reopening a pull request is a decision, not a blip.
          diag.warn("transport.pr_push_refused", { repo: repoFullName, refusal });
          const ended = target.merged ? "merged" : target.state !== "open" ? "closed" : null;
          return {
            ...failed(`not pushing onto #${target.ref}: ${refusal}`, true),
            ...(ended === null ? {} : { ended }),
          };
        }
      }

      // Onto a fork's branch: the push goes to the fork, with a credential asked for THAT URL —
      // the App's installation token, which GitHub lets push there only while the author allows
      // maintainer edits. A user token is never presented to a repo other than the one it was
      // asked about, so in user mode this is refused by the adapter, terminally.
      const fork = target !== null && target.headRepoRef !== null &&
        target.headRepoRef.toLowerCase() !== repoFullName.toLowerCase();
      let pushUrl: string | undefined;
      let pushGit = authedGit;
      if (fork) {
        const url = forkPushUrl(target!, change.repoUrl);
        if (url === null) {
          diag.warn("transport.fork_url_refused", { repo: repoFullName, pr: target!.ref });
          return failed(
            `not pushing onto #${target!.ref}: the forge gave no URL for the fork ` +
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
          diag.warn("transport.fork_token_refused", { repo: repoFullName, terminal });
          return failed(
            `not pushing onto #${target!.ref}: no credential here may push to the fork ` +
              `${target!.headRepoRef}${terminal ? ` (${(err as Error).message})` : ""}`,
            terminal,
          );
        }
        pushGit = forkAuth === null ? gitExec : renewingGit(forkAuth, (renewed) =>
          makeGit(diag, {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: `http.${renewed.origin}/.extraheader`,
            GIT_CONFIG_VALUE_0: `Authorization: ${authorizationValue(renewed)}`,
          }));
      }

      try {
        await pushBundle({
          upstreamUrl: change.repoUrl,
          // The fork's head as the base repo holds it, when the cache cannot seed it.
          ...(fork ? { baseRemoteRef: `refs/pull/${target!.ref}/head`, pushUrl } : {}),
          // Null unless the cache really holds the base branch: pushBundle fetches
          // refs/heads/<baseBranch> from this directory, and an entry without it would fail
          // the local fetch outright rather than fall through to the upstream.
          cacheDir: (await cache.find({ url: change.repoUrl }, change.baseBranch))?.dir ?? null,
          baseBranch: change.baseBranch,
          branchName: change.branchName,
          expectedHeadSha: change.headSha,
          bundlePath: change.bundlePath,
          ...(target === null
            ? {}
            : { onto: { branch: target.headRef, expectedSha: target.headSha } }),
          git: gitExec,
          // The base is fetched from the connected repo, the push goes to the fork: one origin
          // (`forkPushUrl`), so the fork's credential serves both.
          authedGit: pushGit,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A fork that would not take the push says why, and no retry changes a permission.
        const refused = fork && PERMISSION_REFUSED.test(message);
        const terminal = err instanceof TerminalSubmitError || refused;
        diag.warn("transport.push_failed", { repo: repoFullName, terminal, err: String(err) });
        if (fork && err instanceof BundleUnverifiableError) {
          // The bundle's base is gone from the fork's head: its author rewrote the branch while
          // the run worked. Said as that, not as a damaged bundle.
          return failed(
            `#${target!.ref}'s branch in the fork ${target!.headRepoRef} moved while the run ` +
              "worked (rewritten or force-pushed): the commits the run built on are no longer on " +
              "it, so its commits cannot be pushed there",
            true,
          );
        }
        if (refused) {
          return failed(
            `GitHub refused the push onto #${target!.ref}'s branch in the fork ` +
              `${target!.headRepoRef}: ryph's GitHub App may not push there (its author may have ` +
              "withdrawn maintainer edits, or the change touches a workflow file and the App " +
              `lacks the workflows permission) — ${message}`,
            true,
          );
        }
        return failed(`pushing the branch failed: ${message}`, terminal);
      }

      // The commits are IN the pull request now — there is nothing to open. The change's forge
      // identity is that pull request, which is also where the run's report already lives.
      if (target !== null) {
        diag.debug("transport.pushed_to_pr", { repo: repoFullName, pr: target.ref });
        return { kind: "delivered", ref: target.ref, url: target.url };
      }

      try {
        const pr = await api.openPullRequest(change.repo, {
          title: change.title,
          body: change.description,
          head: change.branchName,
          base: change.baseBranch,
          draft: change.draft,
        });
        diag.debug("transport.delivered", { repo: repoFullName, pr: pr.number });
        return { kind: "delivered", ref: String(pr.number), url: pr.url };
      } catch (err) {
        const terminal = err instanceof ForgeApiError && err.terminal;
        diag.warn("transport.pr_failed", { repo: repoFullName, terminal, err: String(err) });
        return failed(err instanceof Error ? err.message : String(err), terminal);
      }
    },
  };
}

// `ForgeApi` for the `local` provider: a git repository on the forge's own disk, under the
// allowed root (RYPH_LOCAL_REPO_ROOT). There is no forge here — no API, no identity, no
// threads — so most of this port has nothing to answer, and says so terminally.
//
// What it does answer:
// - where the base is fetched from: the repo's own path, RE-CHECKED on every call against the
//   root and against what it resolved to at connect time (core/local_repo.ts on why), so the
//   gateway never fetches from a path that has been swapped for somewhere else
// - permissions: "allowed". Nobody exists on this forge to ask about, and who may act on a local
//   repo is the control plane's decision (its admins connect it, its own users create tasks on
//   it); the forge answering anything else would only be a second, uninformed opinion
// - visibility: private, always — it is somebody's disk
//
// Everything that reads or writes a conversation, a label, a review or a check answers a
// TERMINAL `ForgeApiError`: the same "this cannot be done here" a provider the deployment does
// not run gets from the registry, so no caller's retry clock treats it as an outage. The two
// methods whose contract is an answer rather than a throw answer: `readChecks` is `unavailable`
// and `reportChecks` is `unsupported`, the outcome the control plane already settles a check
// report on without retrying (a GitHub App without `Checks: write` gets the same).

import type { Permission } from "../../core/types.ts";
import { type ForgeApi, ForgeApiError, wholeRepoVisibility } from "../../ports/forge_api.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import { recheckLocalRepo } from "../../helpers/local_repo.ts";

export interface LocalForgeApiOptions {
  /** RYPH_LOCAL_REPO_ROOT: the directory every local repo must resolve inside. */
  root: string;
  /** Where a refused re-check's full wording goes. Optional: tests build the adapter bare. */
  diag?: Diagnostics;
}

/** Why nothing past git exists for a local repo, in the sentence a caller passes on. */
const NO_FORGE = "a repository on this machine has no forge to hold it";

/** The terminal refusal, rejected rather than thrown so it reaches a caller's `.catch`. */
function refused<T>(what: string): Promise<T> {
  return Promise.reject(new ForgeApiError(`${what} is not supported here: ${NO_FORGE}`, true));
}

export function localForgeApi(opts: LocalForgeApiOptions): ForgeApi {
  const { root, diag } = opts;

  return {
    // ---- the git seam ----------------------------------------------------------------------

    fetchAuth: () => Promise.resolve(null),

    upstreamUrl(repo, _url) {
      // The repoRef, not the URL the caller carried: the two are the same path on a row the
      // control plane wrote, and the ref is the one the re-check is about. Terminal on a
      // refusal — the gateway answers 502 and logs why, and no retry makes a swapped path the
      // repository that was connected. The error carries the path-free summary: it travels on
      // to callers that store it where a run reads it; the admin's wording, path and all, is
      // logged here.
      const checked = recheckLocalRepo(repo.repoRef, root);
      if (!checked.ok) {
        diag?.warn("local.recheck_refused", {
          repo: repo.repoRef,
          reason: checked.reason,
          message: checked.message,
        });
        throw new ForgeApiError(checked.summary, true);
      }
      return checked.repo.path;
    },

    // ---- permission and visibility ---------------------------------------------------------

    checkPermission(_repo, _subject, _atLeast): Promise<Permission> {
      return Promise.resolve("allowed");
    },

    repoVisibility(_tenantId, repoRefs) {
      return Promise.resolve(new Map(repoRefs.map((ref) => [ref, wholeRepoVisibility(true)])));
    },

    classifyBranch() {
      // Every branch of a repo on this disk is its owner's: nobody else can push one here but
      // the owner and ryph's own deliveries, which the owner approved.
      return Promise.resolve("branch" as const);
    },

    // ---- checks: answers, not throws, as the port asks -------------------------------------

    readChecks: () =>
      Promise.resolve({ kind: "unavailable" as const, reason: `no CI is reported: ${NO_FORGE}` }),
    reportChecks: () =>
      Promise.resolve({
        kind: "unsupported" as const,
        reason: `checks are shown in ryph only: ${NO_FORGE}`,
      }),

    // ---- everything a forge holds and a disk does not --------------------------------------

    postComment: () => refused("commenting"),
    updateComment: () => refused("editing a comment"),
    addReaction: () => refused("reacting"),
    fetchThread: () => refused("reading a thread"),
    describeChangeRequest: () => refused("reading a change request"),
    readChangeRequestState: () => refused("reading a change request"),
    repoLabels: () => refused("listing labels"),
    threadKind: () => refused("reading a thread"),
    listIssues: () => refused("listing issues"),
    listChangeRequests: () => refused("listing change requests"),
    listChangeRequestFiles: () => refused("reading a change request"),
    listChangeRequestCommits: () => refused("reading a change request"),
    createIssue: () => refused("opening an issue"),
    createComment: () => refused("commenting"),
    replyToReviewComment: () => refused("replying to a review"),
    resolveReviewThread: () => refused("resolving a review thread"),
    addLabels: () => refused("labelling"),
    closeIssue: () => refused("closing an issue"),
    listChangeRequestPatches: () => refused("reading a change request"),
    createReview: () => refused("reviewing"),
    findMarkedWrite: () => refused("finding a write"),
  };
}

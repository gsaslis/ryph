// `ChangeTransport` for the `local` provider: verify the bundle exactly as the other transports
// do, then push its branch INTO the repository on this machine — "approve the patch" means "the
// branch appears in your repo", and checkout, review and merge are the owner's, in their tools.
//
// This is the one delivery that writes to a disk a person works in, outside any sandbox, so it
// is fenced more tightly than a push to a forge:
// - the path is re-checked where the bytes land (core/local_repo.ts): still inside the root,
//   still the real path it was connected as, still a repository with a `.git` directory
// - never the branch checked out there, in any worktree. git refuses the main worktree's
//   anyway (`receive.denyCurrentBranch`), but a refusal in words beats git's, and a repo's own
//   config can turn that refusal into `updateInstead`, which rewrites the working tree
// - a branch that exists is only ever fast-forwarded, and only when the delivery names it as
//   the one ryph delivered before (`existingRef`); a branch somebody else made is not ryph's to
//   move. Never a force, and the push carries a lease on what was read, so a branch that moved
//   (or appeared) between the look and the push refuses the push rather than being overwritten
// - the receiving git runs with NO HOOKS and with every receive-side setting that could turn a
//   push into code execution or a write somewhere else pinned on its command line
//   (`RECEIVE_PACK`, below). A repo's hooks are the owner's code — husky, a lint-staged
//   pre-receive, a reference-transaction logger — and running them here would run them on
//   agent-authored commits, on the host, with nobody watching
//
// - only ryph's own branches: `ryph/<agent>/<run>/<line>` and its generations. A name outside that
//   namespace is refused before anything is read, so no path through this transport — the
//   "already delivered" answer included — can adopt a branch the owner made
// - a delivered branch the owner deleted (merged, most likely) is not re-created under its old
//   name: the revision goes to the run's own branch as a new delivery, under every rule above
// - a patch touching the repository's HOOK FILES — its tracked hook folder, a hook manager's
//   config, a config file git includes, the hook keys of the root `package.json`
//   (core/hook_files.ts says which, and what the gate does NOT cover) — is not delivered until a person approves exactly those files
//   (`approvedHookPaths`): the owner's next checkout of the branch would run them. It answers
//   `needs-approval`, naming them, and writes nothing
// - nothing it answers names a path or carries git's words: the answer is stored and handed to
//   the run's agent, and the host's layout is not the agent's to see. The log has the rest. The
//   one exception is a hook file's repo-relative path, which is the point of that answer
//
// Terminality: every refusal above is terminal (no retry changes which branch is checked out or
// who made a branch). A failed push is terminal only when the repository refused the ref for a
// reason known to be final (`isPermanentPushFailure`) and retryable otherwise — a lock held by
// somebody else, the lease losing a race, a disk that filled are reasons to look again.

import type {
  ChangeDelivery,
  ChangeDeliveryOutcome,
  ChangeTransport,
} from "../../ports/change_transport.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import type { RepoCache } from "../../ports/repo_cache.ts";
import { type Git, type GitBounded, makeGit, makeGitBounded } from "../../helpers/git_exec.ts";
import { HookCheckTooLargeError, hookFilesOfPatch } from "../../helpers/hook_files.ts";
import {
  HOOK_FILES_SHOWN_MAX,
  reportHookFiles,
  unapprovedHookFiles,
  wireRoots,
} from "../../core/hook_files.ts";
import { stageBundle, TerminalSubmitError } from "../../helpers/submit.ts";
import { checkedOutBranches, recheckLocalRepo, refPathIsPlain } from "../../helpers/local_repo.ts";
import { parseLineBranch } from "@ryph/shared/lines";

export interface LocalChangeTransportOptions {
  /** RYPH_LOCAL_REPO_ROOT: the directory every local repo must resolve inside. */
  root: string;
  /** Seeds the base objects from local disk when it holds them — the fast path. */
  cache: RepoCache;
  diag: Diagnostics;
  /** A traced hermetic git. */
  git?: Git;
  /** The same, for listings whose size the patch decides. */
  gitBounded?: GitBounded;
}

/**
 * The receiving side of the push, as git runs it in the target repository. A local push spawns
 * `receive-pack` through the shell with this string in front of the repository's path, and the
 * `-c` settings here are COMMAND-LINE config: they outrank anything in the repository's own
 * `.git/config`. They cannot ride the environment instead — git strips `GIT_CONFIG_PARAMETERS`
 * and `GIT_CONFIG_COUNT` from a local transport's child, so env-injected config never reaches
 * the receiving side. (The global and system config are already `/dev/null` by the hermetic env,
 * which a local child does inherit.)
 *
 * What each one closes, verified against git's receive-pack (tests/local_transport_test.ts
 * proves the hooks):
 * - `core.hooksPath=/dev/null` — every hook (pre-receive, update, post-receive, post-update,
 *   reference-transaction, push-to-checkout, proc-receive) is looked up under a path that cannot
 *   hold one, so none runs. `git gc --auto`, which receive-pack may spawn, inherits it too
 * - `core.alternateRefsCommand=true` — with `objects/info/alternates` present, receive-pack runs
 *   this SHELL COMMAND to advertise the alternates' refs; the repository's own value would be
 *   arbitrary code. `true` prints nothing, which only costs the advertisement an optimisation.
 *   A repository with alternates is refused by the re-check before any push (they lend another
 *   repository's objects), so this is the second fence, for an alternates file that appears
 *   between the re-check and the push
 * - `receive.denyCurrentBranch=refuse` — a repo set to `updateInstead` would check the pushed
 *   commits out into the owner's working tree (and consult `core.fsmonitor`, another command)
 * - `receive.denyDeleteCurrent=refuse`, `receive.denyDeletes=true`,
 *   `receive.denyNonFastForwards=true` — the "never delete, never force" rules, held on the
 *   receiving side as well as checked before the push
 * - `receive.shallowUpdate=false` — no shallow-boundary rewrite of the owner's repository
 * - `receive.autogc=false` — no `git gc --auto` (and whatever `gc.*` the repo configures) run on
 *   the owner's repository because a delivery landed
 * - `receive.updateServerInfo=false` — no `info/refs` written as a side effect
 * - `core.fsmonitor=false` — nothing in this push reads the index, but if anything ever does, the
 *   repository's fsmonitor command is not run for it
 *
 * Settings checked and left alone, because they cannot execute anything or write outside the
 * repository: `receive.fsckObjects` and `transfer.fsckObjects` (stricter only),
 * `receive.unpackLimit`/`transfer.unpackLimit` (index-pack versus unpack-objects, into the
 * repo's own object store), `receive.hideRefs`/`transfer.hideRefs` (a hidden ref is refused, not
 * written), `receive.certNonceSeed` (signed pushes only; this push is not signed),
 * `receive.advertisePushOptions` (none are sent), `receive.procReceiveRefs` (it routes refs to
 * the proc-receive hook, which cannot run, so such a push fails rather than executes — and fails
 * terminally, see `isPermanentPushFailure`), and
 * `uploadpack.packObjectsHook` (upload-pack only, and git honours it only from protected config).
 */
export const RECEIVE_PACK = [
  "git",
  "-c core.hooksPath=/dev/null",
  "-c core.alternateRefsCommand=true",
  "-c core.fsmonitor=false",
  "-c receive.denyCurrentBranch=refuse",
  "-c receive.denyDeleteCurrent=refuse",
  "-c receive.denyDeletes=true",
  "-c receive.denyNonFastForwards=true",
  "-c receive.shallowUpdate=false",
  "-c receive.autogc=false",
  "-c receive.updateServerInfo=false",
  "receive-pack",
].join(" ");

/**
 * Whether `name` is a branch ryph mints for a run: a line of the run's namespace,
 * `ryph/<agent-slug>/<run-id>/<line>`, or a later generation of it with a numeric suffix (`-2`,
 * `-3`, …). The orchestrator's `branchNameFor` (the namespace) and `lineBranch` are the source of
 * the shape, restated here because the two packages share no source. Exactly four segments, the
 * agent's in slug form, the line's held to the line rule (@ryph/shared/lines); the run's segment is
 * held to the id alphabet rather than to today's `r-<hex>`, which is the orchestrator's to
 * change. The point is the prefix: nothing the owner named — `main`, `feature/x`, a
 * `release/1.0` — is in it.
 */
export function isRunBranch(name: string): boolean {
  const namespace = /^ryph\/[a-z0-9]+(?:-[a-z0-9]+)*\/[A-Za-z0-9][A-Za-z0-9._-]*(?=\/)/.exec(name);
  return namespace !== null && parseLineBranch(name, namespace[0]) !== null;
}

/**
 * The reasons git gives for refusing a ref that are the repository's ANSWER rather than its
 * state of the moment: asking again gets the same one. Everything not listed here is retryable.
 * - `deny updating a hidden ref` — `receive.hideRefs`/`transfer.hideRefs` covers the branch
 * - `fail to run proc-receive hook` — `receive.procReceiveRefs` routes the branch to a hook,
 *   and hooks never run for a delivery (RECEIVE_PACK)
 * - `non-fast-forward` — the receiving side's `denyNonFastForwards`, or the client's own check
 * - `refname conflict` — a branch `ryph/ada` exists, so `ryph/ada/r-1` cannot (or the reverse)
 * - `deletion prohibited` — `denyDeletes`; nothing here deletes, but if it ever did
 */
const PERMANENT_PUSH_REFUSALS = [
  "deny updating a hidden ref",
  "fail to run proc-receive hook",
  "non-fast-forward",
  "refname conflict",
  "deletion prohibited",
];

/**
 * Whether a failed push is one no retry heals: a ref git refused (`[remote rejected]` from the
 * receiving side, `[rejected]` from the client's own check) for one of the KNOWN permanent
 * reasons above. An allowlist, not a denylist, because git words its transient refusals in
 * ways that change between versions: since 2.52 a lock held by a concurrent writer answers
 * `(reference already exists)`, a full or read-only object store answers `(unpacker error)`,
 * and the lease losing a race answers `(stale info)` — each worth looking at again, and each
 * would have been read as final by a rule that treated every refusal as one. A failure with no
 * refused ref at all (a spawn that failed, a repository that vanished) is retryable too. The
 * namespace and checked-out refusals are decided before the push and never reach here.
 */
export function isPermanentPushFailure(err: string): boolean {
  for (const match of err.matchAll(/\[(?:remote )?rejected\][^\n]*?\(([^)\n]*)\)\s*$/gm)) {
    const reason = match[1].trim().toLowerCase();
    if (PERMANENT_PUSH_REFUSALS.some((known) => reason.startsWith(known))) return true;
  }
  return false;
}

export function localChangeTransport(opts: LocalChangeTransportOptions): ChangeTransport {
  const { root, cache, diag } = opts;
  const gitExec = opts.git ?? makeGit(diag);
  const gitBounded = opts.gitBounded ?? makeGitBounded(diag);

  /** Whether git takes `name` as a branch name, as the branch it was given. */
  const isBranchName = async (cwd: string, name: string): Promise<boolean> => {
    try {
      return await gitExec(cwd, "check-ref-format", "--branch", name) === name;
    } catch {
      return false;
    }
  };

  /** The tip of `refs/heads/<branch>` in the repository at `path`, or null when it has none —
   * asked over the protocol, so the repository's own config runs nothing to answer it. */
  const tipOf = async (cwd: string, path: string, branch: string): Promise<string | null> => {
    const ref = `refs/heads/${branch}`;
    const out = await gitExec(cwd, "ls-remote", "--refs", "--", path, ref);
    for (const line of out.split("\n")) {
      const [sha, name] = line.split("\t");
      if (name === ref) return sha;
    }
    return null;
  };

  return {
    async deliver(change: ChangeDelivery): Promise<ChangeDeliveryOutcome> {
      // Every `message` below reaches the control plane, which stores it on the patch and
      // hands it on to the run's agent: no host path, no git stderr, no command line. What
      // happened in full goes to the log beside it.
      const failed = (message: string, terminal: boolean): ChangeDeliveryOutcome => ({
        kind: "failed",
        message,
        terminal,
      });
      const refuse = (message: string, detail?: string): ChangeDeliveryOutcome => {
        diag.warn("transport.local_refused", {
          repo: change.repo.repoRef,
          message,
          ...(detail === undefined ? {} : { detail }),
        });
        return failed(message, true);
      };

      const checked = recheckLocalRepo(change.repo.repoRef, root);
      if (!checked.ok) return refuse(checked.summary, checked.message);
      const path = checked.repo.path;

      // Before anything is staged or read: a name outside ryph's own namespace is never written,
      // whatever else is true of it. Without this, a run whose branch were named `main` would
      // "converge" on the owner's main at the same head below, and its next revision would be
      // a fast-forward of the owner's main with `existingRef` pointing at it.
      for (const name of new Set([change.branchName, change.existingRef ?? change.branchName])) {
        if (!isRunBranch(name)) {
          return refuse(
            `${JSON.stringify(name)} is not a branch ryph delivers — ryph only writes branches ` +
              "it minted for a run (ryph/<agent>/<run>/<line>)",
          );
        }
      }

      let staged;
      try {
        staged = await stageBundle({
          upstreamUrl: path,
          cacheDir: (await cache.find({ url: path }, change.baseBranch))?.dir ?? null,
          baseBranch: change.baseBranch,
          branchName: change.branchName,
          expectedHeadSha: change.headSha,
          bundlePath: change.bundlePath,
          git: gitExec,
          // A path needs no credential: the same executor fetches the base when the cache
          // cannot seed it.
          authedGit: gitExec,
        });
      } catch (err) {
        const terminal = err instanceof TerminalSubmitError;
        diag.warn("transport.stage_failed", { repo: path, terminal, err: String(err) });
        return failed(
          terminal
            ? "the patch's bundle does not verify against the repository's base branch"
            : "the patch's bundle could not be staged against the repository; ryph will try again",
          terminal,
        );
      }

      try {
        // The names arrived validated; git's own rule is the last word on what it will write.
        for (const name of new Set([change.branchName, change.existingRef ?? change.branchName])) {
          if (!(await isBranchName(staged.dir, name))) {
            return refuse(`${JSON.stringify(name)} is not a branch name git accepts`);
          }
        }

        // A revision of a patch ryph delivered lands on the branch it delivered then; a first
        // delivery lands on the run's own branch.
        let dest = change.existingRef ?? change.branchName;
        let tip = await tipOf(staged.dir, path, dest);
        // The delivered branch is gone — the owner merged it and deleted it, most likely. The
        // revision is new work on top of that, so it is delivered the way a first delivery is:
        // onto the run's own branch, under every rule a first delivery answers to. The answer
        // names that branch, and the next revision follows it there.
        let ours = change.existingRef;
        if (tip === null && change.existingRef !== null) {
          diag.debug("transport.local_delivered_branch_gone", {
            repo: path,
            gone: change.existingRef,
            branch: change.branchName,
          });
          ours = null;
          dest = change.branchName;
          tip = dest === change.existingRef ? null : await tipOf(staged.dir, path, dest);
        }

        // Already there: a retried delivery whose push landed before its answer was lost. No
        // write, so none of the rules below — which guard a write — apply; the owner having
        // checked the branch out since is exactly what should happen after a delivery. Safe to
        // answer because `dest` is in ryph's namespace (above): a branch there at this exact
        // head is this delivery's own.
        if (tip === staged.headSha) {
          diag.debug("transport.local_already_delivered", { repo: path, branch: dest });
          return { kind: "delivered", ref: dest, url: null };
        }

        if ((await checkedOutBranches(path)).has(dest)) {
          return refuse(
            `${dest} is checked out in the repository — ryph never moves a branch you have ` +
              "checked out. Switch to another branch and approve again.",
          );
        }

        if (tip !== null) {
          if (ours !== dest) {
            return refuse(
              `the repository already has a branch ${dest} that ryph did not deliver — ` +
                "it is not ryph's to move.",
            );
          }
          try {
            await gitExec(staged.dir, "merge-base", "--is-ancestor", tip, staged.headSha);
          } catch {
            return refuse(
              `${dest} in the repository is at ${tip}, which the run's commits do not build on ` +
                "— it moved since ryph delivered it, and is not overwritten.",
            );
          }
        }

        // Hook files, last before the write: a patch that adds or edits a file the owner's next
        // checkout runs as a hook is held for a person, and passes only with every such file
        // that person was shown (core/hook_files.ts). Read off the staged objects, against the
        // repository's own hook config as it is now — never the run's say.
        let hooks;
        try {
          hooks = await hookFilesOfPatch({
            target: path,
            scratch: staged.dir,
            baseTip: `refs/heads/${change.baseBranch}`,
            head: staged.headSha,
            git: gitExec,
            bounded: gitBounded,
          });
        } catch (err) {
          if (err instanceof HookCheckTooLargeError) return refuse(err.message, String(err));
          throw err;
        }
        const unapproved = unapprovedHookFiles(hooks.hookFiles, change.approvedHookPaths ?? []);
        if (unapproved.length > 0) {
          diag.warn("transport.local_needs_approval", {
            repo: path,
            branch: dest,
            unapproved: unapproved.slice(0, HOOK_FILES_SHOWN_MAX),
            hooksPaths: wireRoots(hooks.roots),
          });
          return { kind: "needs-approval", ...reportHookFiles(hooks.hookFiles, hooks.roots) };
        }

        // The loose ref and its reflog are written under `.git/refs/heads/<dest>` and
        // `.git/logs/refs/heads/<dest>`; a directory on either way swapped for a symlink would
        // carry the write out of the repository.
        if (!refPathIsPlain(path, dest)) {
          return refuse(
            `the repository's ref store for ${dest} is not a plain directory, so ryph does not ` +
              "write it",
          );
        }

        try {
          await gitExec(
            staged.dir,
            "push",
            "--quiet",
            "--no-verify",
            `--receive-pack=${RECEIVE_PACK}`,
            // The lease is on what was just read: the tip, or absence (an empty expectation).
            `--force-with-lease=refs/heads/${dest}:${tip ?? ""}`,
            "--",
            path,
            `refs/heads/${change.branchName}:refs/heads/${dest}`,
          );
        } catch (err) {
          const terminal = isPermanentPushFailure(String(err));
          diag.warn("transport.push_failed", {
            repo: path,
            branch: dest,
            terminal,
            err: String(err),
          });
          return failed(
            terminal
              ? `the repository refused the branch ${dest}`
              : `pushing ${dest} into the repository failed; ryph will try again`,
            terminal,
          );
        }
        diag.debug("transport.delivered", { repo: path, branch: dest });
        // No web page exists for a branch on somebody's disk; the branch name is the address.
        return { kind: "delivered", ref: dest, url: null };
      } catch (err) {
        // A read of the target that failed outright (ls-remote against a repository that
        // vanished between the re-check and here): looked at again next time.
        diag.warn("transport.local_unreadable", { repo: path, err: String(err) });
        return failed("the repository could not be read; ryph will try again", false);
      } finally {
        await staged.dispose();
      }
    },
  };
}

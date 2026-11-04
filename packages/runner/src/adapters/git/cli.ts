// Git via the CLI, straight against `repo.url`: the transport of a hand-run work item (`--context`,
// no control plane) and of the tests. A run the control plane launches always clones through the
// forge gateway (adapters/git/gateway.ts); main.ts refuses one that arrives without it.
// Works against any remote git speaks — the runner doesn't know forges exist.
//
// Invariants:
// - Only the boundary-crossing operations live here: clone (or adopt) in, push out.
//   Every local git op — branching, staging, committing, inspecting — is an owned helper,
//   never this adapter's concern.
// - No credential, ever. A token in the run's environment is the agent's to read (/proc/1/environ),
//   so a repository that needs one is reached through the forge gateway, on a run-scoped key.
// - Nothing here is mounted, and nothing is owned by another uid: a `local` repo is connected,
//   and its runs clone it through the gateway like any other.

import { mkdir } from "node:fs/promises";
import type { RepoEntry } from "../../core/types.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import type { Checkout, GitTransport } from "../../ports/git_transport.ts";
import { makeGit } from "../../helpers/git_exec.ts";
import { adoptInPlace } from "../../helpers/adopt.ts";
import { fetchBranch } from "../../helpers/fetch.ts";

export function cliGitTransport(diag: Diagnostics): GitTransport {
  // gitExec is traced: each call emits its own "git.exec" diagnostics line,
  // so this adapter deliberately does no logging of its own.
  const gitExec = makeGit(diag);
  return {
    async clone(repo: RepoEntry, intoDir: string): Promise<Checkout> {
      await mkdir(intoDir, { recursive: true });
      // clone records repo.url as the remote "origin" — that's the target push() lands on later.
      await gitExec(intoDir, "clone", "--", repo.url, ".");
      // repo.ref is the START point: check it out to read the world as it is.
      // --end-of-options because the ref is caller input;
      // never let a "-"-shaped value parse as a flag.
      await gitExec(intoDir, "checkout", "--end-of-options", repo.ref);
      // A plain origin serves what it holds; nothing caches between it and this clone.
      return { dir: intoDir, freshness: { kind: "fresh" } };
    },

    async adopt(repo: RepoEntry, dir: string): Promise<Checkout> {
      await adoptInPlace(gitExec, dir, repo.url, repo.ref, repo.targetRef);
      return { dir, freshness: { kind: "fresh" } };
    },

    async push(
      from: Checkout,
      _repo: RepoEntry,
      branch: { name: string; baseSha: string },
    ): Promise<{ remoteRef: string }> {
      // The one step where local work leaves the box:
      // send this clone's commits up to "origin" (i.e. repo.url) as a fresh branch —
      // never the repo.ref we started from.
      // `from` is the local source, not the target;
      // everything before this (branch, commit) was local to it.
      const remoteRef = `refs/heads/${branch.name}`;
      await gitExec(from.dir, "push", "origin", `${remoteRef}:${remoteRef}`);
      return { remoteRef };
    },

    async fetchBase(from: Checkout, repo: RepoEntry, ref = repo.ref): Promise<{ sha: string }> {
      // By `repo.url` into `origin/<ref>`, never through `origin` (helpers/fetch.ts). The ref is
      // caller input and schema-checked against a leading dash; it rides inside the refspec,
      // after `--`, regardless.
      return { sha: await fetchBranch(gitExec, from.dir, repo.url, ref) };
    },

    fetchChangeRequest(): Promise<{ ref: string; headSha: string; url: string }> {
      // A change request is a FORGE object: which ref carries its head, whether it is open and
      // whether it is even this repo's are questions a plain remote cannot be asked. Nothing is
      // guessed here — the run is simply told this transport cannot do it.
      throw new Error(
        "this run's git transport has no forge gateway behind it; change requests cannot be " +
          "checked out",
      );
    },
  };
}

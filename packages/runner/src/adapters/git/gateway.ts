// Git via the forge gateway — the agent-container transport when a run's repos are served by
// @ryph/forge. Reads come in over the git wire protocol (an ordinary https clone of the
// per-run MEMBER URL the entry carries, with the run's virtual key as an origin-scoped extra
// header); work leaves as a `git bundle` POSTed to the gateway's intake FOR THAT REPO. The
// run's credential is READ-ONLY: the gateway has no receive path, so this adapter's `push`
// never touches a git remote at all. One key names the run's whole set of repos; the URL
// names the member, on the way in and on the way out.
//
// This is the "alternate backend slots in behind GitTransport" claim, made good: the port is
// unchanged, and `push`'s promise — a returned remoteRef means the work durably left the
// box — is kept by the gateway having accepted and stored the bundle.
//
// Invariants:
// - the credential rides the subprocess environment only (`http.<origin>.extraheader` via
//   GIT_CONFIG_*), scoped to the gateway origin. NEVER the URL: a credentialed URL lands in
//   `.git/config` as remote.origin.url, where the agent can read it back
// - the bundle names the branch, never HEAD: `<baseSha>..refs/heads/<branch>` — a HEAD bundle
//   declares "HEAD" and the gateway (rightly) refuses it as not being the run's output ref
// - every error thrown here is redacted before it can reach a reported `Result`
// - the base's freshness is the gateway's word, asked AFTER the git work: the advertisement is
//   what refreshes the cache, so the answer describes the copy this clone or fetch just read.
//   `fetchBase` also holds the commit the answer names to what it fetched, since the gateway's
//   entry is shared and can move between the two; `clone` and `adopt` read the mark alone

import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { RepoEntry } from "../../core/types.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import type { BaseFreshness, Checkout, GitTransport } from "../../ports/git_transport.ts";
import { makeGit, redact } from "../../helpers/git_exec.ts";
import { adoptInPlace } from "../../helpers/adopt.ts";
import { fetchBranch } from "../../helpers/fetch.ts";

export interface GatewayGitOptions {
  /** The gateway origin, e.g. "http://gateway:7412" — where clones come from and bundles go. */
  origin: string;
  /** The run-scoped virtual key (RYPH_GIT_TOKEN). Read-only by construction. */
  token: string;
  /** The run, which the gateway's non-wire routes are addressed by. The member URLs the entries
   * carry name it too, but a URL is the caller's to shape — this adapter is told the id. */
  runId: string;
  /** Deadline for the bundle upload. */
  submitTimeoutMs?: number;
  /** Deadline for the change-request warm call, which waits on the forge's own answer. */
  warmTimeoutMs?: number;
}

const DEFAULT_SUBMIT_TIMEOUT_MS = 120_000;
// The gateway asks the forge for the thread and then reads the head into its cache from the
// upstream, so this budget is a forge round trip plus a fetch — not an ordinary control call.
const DEFAULT_WARM_TIMEOUT_MS = 60_000;
// The freshness question reads the gateway's own record and never waits on the upstream.
const FRESHNESS_TIMEOUT_MS = 5_000;

/** What the gateway says about one served branch: how fresh it is, and the commit its entry
 * holds for it, or null when it could not say. */
interface BaseAnswer {
  freshness: BaseFreshness;
  commit: string | null;
}

/** The answer a gateway that cannot be asked gets: such a gateway never serves stale. */
const UNANSWERED: BaseAnswer = { freshness: { kind: "fresh" }, commit: null };

/** Whether the gateway's entry holds a commit other than the one a fetch landed on. */
const movedUnder = (answer: BaseAnswer, fetched: string): boolean =>
  answer.commit !== null && answer.commit !== fetched;

export function gatewayGitTransport(diag: Diagnostics, opts: GatewayGitOptions): GitTransport {
  const origin = opts.origin.replace(/\/+$/, "");
  // The credential seam: command-line-precedence config, scoped so git offers the header to
  // this origin only — it can never leak toward some other remote a subcommand touches.
  const gitExec = makeGit(diag, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x-access-token:${opts.token}`)}`,
  });

  // Every directory this transport cloned or adopted: `push` refuses one it did not, because a
  // bundle cut in a clone that came from elsewhere would not have the gateway's base as its
  // prerequisite.
  const cloned = new Set<string>();

  /** The gateway's JSON routes about one member of the run: one key covers the run's whole set
   * of repos, so the run and the member are both in the path. */
  const memberRoute = (connectedRepoId: string): string =>
    `${origin}/v1/git/${encodeURIComponent(opts.runId)}/${encodeURIComponent(connectedRepoId)}`;

  /**
   * The gateway's word on `ref`: whether it was served from a copy the gateway could not
   * refresh, and the commit the gateway's entry holds for it. The cache has no channel on the
   * git wire for either, so it is asked over its JSON route once the git work is done. An
   * answer it cannot give (a forge that predates the route, an unreachable gateway, a malformed
   * body) reads as fresh with no commit, said in a warn: such a forge never serves stale, and a
   * question that cannot be answered must not refuse a base the clone already holds.
   */
  async function askBase(repo: RepoEntry, ref: string): Promise<BaseAnswer> {
    try {
      const res = await fetch(
        `${memberRoute(repo.connectedRepoId)}/base?ref=${encodeURIComponent(ref)}`,
        {
          headers: { authorization: `Bearer ${opts.token}` },
          signal: AbortSignal.timeout(FRESHNESS_TIMEOUT_MS),
        },
      );
      const body = await res.json().catch(() => null) as
        | { commit?: unknown; staleSince?: unknown }
        | null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const since = body?.staleSince;
      if (typeof body?.commit !== "string" || !(since === null || typeof since === "string")) {
        throw new Error("the gateway's answer about the base is malformed");
      }
      return {
        commit: body.commit,
        freshness: since === null ? { kind: "fresh" } : { kind: "stale", since },
      };
    } catch (err) {
      diag.warn("git.freshness_unknown", { repo: repo.path, ref, err: redact(String(err)) });
      return UNANSWERED;
    }
  }

  return {
    async clone(repo: RepoEntry, intoDir: string): Promise<Checkout> {
      await mkdir(intoDir, { recursive: true });
      await gitExec(intoDir, "clone", "--", repo.url, ".");
      // repo.ref is the normalized base branch the gateway's cache serves; check it out to
      // read the world as it is. --end-of-options: the ref is caller input.
      await gitExec(intoDir, "checkout", "--end-of-options", repo.ref);
      cloned.add(intoDir);
      return { dir: intoDir, freshness: (await askBase(repo, repo.ref)).freshness };
    },

    async adopt(repo: RepoEntry, dir: string): Promise<Checkout> {
      // The per-run member URL becomes origin, the fetch rides the run's key, and the commit it
      // lands on is one the gateway served — so a bundle cut from it has a prerequisite the
      // gateway holds, exactly as after a clone.
      await adoptInPlace(gitExec, dir, repo.url, repo.ref, repo.targetRef);
      cloned.add(dir);
      return { dir, freshness: (await askBase(repo, repo.ref)).freshness };
    },

    async push(
      from: Checkout,
      repo: RepoEntry,
      branch: { name: string; baseSha: string },
    ): Promise<{ remoteRef: string }> {
      if (!cloned.has(from.dir)) {
        throw new Error("checkout was not cloned through this transport — no base to bundle from");
      }
      // The intake is per repo, named in the path: every repo of a run carries the same
      // branch name, so the bundle's own header cannot say which one it is for.
      const remoteRef = `refs/heads/${branch.name}`;
      const bundleDir = await mkdtemp(join(tmpdir(), "ryph-patch-"));
      const bundlePath = join(bundleDir, "patch.bundle");
      try {
        // The named branch, never HEAD — the bundle's header must declare the run's output
        // ref, because that self-description is what the gateway validates. From the base the
        // caller names: the clone's served tip for the first generation, the merged tip the
        // gateway just served for a later one — either way a prerequisite the gateway holds.
        await gitExec(from.dir, "bundle", "create", bundlePath, `${branch.baseSha}..${remoteRef}`);

        // A rejected fetch (the timeout, a refused connection) never consumes the body, so
        // nothing closes the stream for us — the explicit destroy is the only thing standing
        // between a retried submit and a descriptor leak.
        const file = createReadStream(bundlePath);
        let res: Response;
        try {
          res = await fetch(`${origin}/v1/patches/${encodeURIComponent(repo.connectedRepoId)}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${opts.token}`,
              "content-type": "application/x-git-bundle",
            },
            body: Readable.toWeb(file) as ReadableStream<Uint8Array>,
            duplex: "half",
            signal: AbortSignal.timeout(opts.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS),
          });
        } catch (err) {
          // A stream already read to its end and closed: destroying it again does nothing.
          file.destroy();
          throw new Error(redact(`the gateway did not accept the bundle: ${err}`));
        }
        if (res.status !== 201) {
          const detail = (await res.text().catch(() => "")).slice(0, 500);
          throw new Error(redact(`the gateway refused the bundle (${res.status}): ${detail}`));
        }
        const submission = (await res.json().catch(() => null)) ?? {};
        diag.debug("git.bundle_submitted", {
          repo: repo.path,
          branch: branch.name,
          headSha: submission.headSha,
          bundleKey: submission.bundleKey,
        });
        return { remoteRef };
      } finally {
        await rm(bundleDir, { recursive: true }).catch(() => {});
      }
    },

    async fetchBase(from: Checkout, repo: RepoEntry, ref = repo.ref): Promise<{ sha: string }> {
      // An ordinary fetch of the base branch over the wire protocol: the gateway refreshes its
      // cache from the upstream on the advertisement, so the answer is the branch as it stands
      // there now — with the landed pull request in it. By the member URL into `origin/<ref>`,
      // never through `origin` (helpers/fetch.ts), with the run's key riding the executor.
      // The ref reaches here from the control plane's normalization, which strips `refs/heads/`
      // AFTER its leading-dash check; inside the refspec, after `--`, no spelling reads as an
      // option.
      const fetched = (): Promise<string> => fetchBranch(gitExec, from.dir, repo.url, ref);
      let sha = await fetched();
      let answer = await askBase(repo, ref);
      // The gateway's entry is shared: another run's successful refresh between the fetch and
      // the question moves the branch and clears the mark, and the gateway's two reads can
      // straddle that, so the answer can name a commit this fetch did not land on, as fresh
      // or as stale. Either way the entry has moved on: fetch once more and ask again, and a
      // base that still disagrees is no answer.
      if (movedUnder(answer, sha)) {
        sha = await fetched();
        answer = await askBase(repo, ref);
      }
      // The fetch landed on whatever the gateway holds, which is an answer only when that is
      // the upstream's: an older copy is a tip that may be behind, and no base to build on.
      if (answer.freshness.kind === "stale") {
        throw new Error(
          `\`${ref}\` could not be refreshed from upstream: every attempt since ` +
            `${answer.freshness.since} has failed, and ryph only holds an older copy`,
        );
      }
      if (movedUnder(answer, sha)) {
        throw new Error(`\`${ref}\` moved at the origin while it was being read; try again`);
      }
      return { sha };
    },

    async fetchChangeRequest(
      from: Checkout,
      repo: RepoEntry,
      changeRequest: string,
    ): Promise<{ ref: string; headSha: string; url: string }> {
      // The warm call FIRST: the run's grant covers the base ref only, so until the gateway has
      // read the change request's head into the entry the advertisement below cannot serve it.
      const url = `${memberRoute(repo.connectedRepoId)}/change-requests/${
        encodeURIComponent(changeRequest)
      }/base`;
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${opts.token}` },
          signal: AbortSignal.timeout(opts.warmTimeoutMs ?? DEFAULT_WARM_TIMEOUT_MS),
        });
      } catch (err) {
        throw new Error(redact(`the gateway could not be asked for ${changeRequest}: ${err}`));
      }
      const body = await res.json().catch(() => null) as
        | { ref?: unknown; headSha?: unknown; url?: unknown; error?: unknown }
        | null;
      if (!res.ok) {
        // The gateway writes its refusals FOR the agent; anything else is the status alone.
        const reason = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
        throw new Error(redact(reason));
      }
      if (
        typeof body?.ref !== "string" || typeof body.headSha !== "string" ||
        typeof body.url !== "string"
      ) {
        throw new Error("the gateway's answer about the change request is malformed");
      }
      const { ref, headSha } = body;
      // As in `fetchBase`: by the member URL, into `origin/<ref>`. This ref is the gateway's
      // answer, not a name this adapter chose, and rides inside the refspec all the same.
      // What the fetch landed on is the only head this clone actually holds. A change request
      // pushed to between the warm call and the fetch would otherwise have the caller move the
      // run's branch onto a commit that is no longer its head.
      const fetched = await fetchBranch(gitExec, from.dir, repo.url, ref);
      if (fetched !== headSha) {
        throw new Error(`${changeRequest} moved while it was being checked out; try again`);
      }
      diag.debug("git.change_request_fetched", { repo: repo.path, changeRequest, ref, headSha });
      return { ref, headSha, url: body.url };
    },
  };
}

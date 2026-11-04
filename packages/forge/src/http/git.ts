// Door ①: the git wire protocol, READ-ONLY — `/v1/git/:runId/:connectedRepoId/repo.git/*`,
// upload-pack only. A run holds a SET of repos under one credential, and clones each member
// by naming it in the path.
// There is no receive path: `git-receive-pack` simply has no route, which is the entire
// security argument (isolation is structural, not policy). An injected agent cannot push
// because there is nothing to push to.
//
// Two routes here are not wire protocol. `change-requests/:thread/base` warms a SECOND base into
// the same cache entry — a change request's head — so that a run asked to work on an existing
// pull request or patch can fetch it. It reads the forge and writes nothing anywhere else; the
// advertisement above is what then serves the branch, under the same credential and the same
// gate as every other read a run makes. `base?ref=` answers how fresh a served branch is: git's
// wire carries no such signal, so a run that just cloned asks here whether its base came from a
// copy the cache could not refresh. It reads the entry alone and never contacts the upstream.
//
// A CHECK grant (a member carrying `candidate`) reads something else: not the upstream cache but
// the one unsubmitted commit it names, staged out of the run's stored bundle into a repo of its
// own (http/candidate.ts). It gets the same two wire routes and nothing more — no change-request
// warm, which would move a cache entry on a check pod's say-so.
//
// Invariants:
// - auth happens BEFORE any git subprocess is spawned
// - the credential selects the SET of repos; the run id in the path must agree — belt-and-braces
//   and readable logs — and the connected repo id must name a member. Disagreement of either
//   is a 401, never a 404: a 404 would confirm which run ids or repos exist
// - the upstream fetch happens on the advertisement (GET info/refs), once per clone — the
//   upload-pack POSTs that follow serve straight from the cache. A member with a `targetRef`
//   (a change request's base) has that branch refreshed there too, so `origin/<target>` is
//   as fresh as the base in every clone and fetch — and so has each of its `lineBases`, the
//   branches a line of the run moved onto when its own change request merged
// - a base whose refresh fails is still served, from the copy the cache holds, marked stale in
//   the entry; a base the cache never held, or one the upstream refused, is not, and the wire
//   routes say why as `text/plain`, the one body git shows the user. A change request's head is
//   never served stale: the runner checks it against the forge's own sha. Pinned by
//   tests/gateway_e2e_test.ts (a real clone during an outage) and tests/git_fetch_auth_test.ts
// - the fetch credential is minted PER GRANT, for the tenant that granted us the repo, and is
//   offered only to the origin of that repo's own URL. It is never derived from anything the
//   task's author chose: a connected repo's URL comes off the row an admin connected, so the
//   pair (tenant, origin) is one the deployment approved, not one a caller composed

import type { RepoCoords, RunGrantRepo } from "../core/types.ts";
import { isChangeRequestHeadName, isGitRefName, normalizeBaseRef } from "@ryph/shared/refs";
import { headInRepo } from "../core/provider_rules.ts";
import { advertiseRefs, uploadPack } from "../helpers/http_backend.ts";
import type { ChangeRequestHead } from "../ports/forge_api.ts";
import { ForgeApiError, forgeRepoOf } from "../ports/forge_api.ts";
import { type Credential, UpstreamRefused } from "../ports/repo_cache.ts";
import { isThreadRef } from "../schema.ts";
import { json, type Route, route } from "@ryph/shared/http";
import { memberOf, resolveGrant, unauthorized } from "./auth.ts";
import { upstreamFor } from "./fetch_auth.ts";
import { ensureCandidate } from "./candidate.ts";
import type { AppDeps } from "./app.ts";

/** Whether two spellings name one branch the cache serves ("main", "refs/heads/main"). A name
 * the cache cannot serve at all is no match — the warm then tries it, and logs the miss. */
function sameBranch(a: string, b: string): boolean {
  try {
    return normalizeBaseRef(a).localBranch === normalizeBaseRef(b).localBranch;
  } catch {
    return false;
  }
}

/**
 * Why this change request's head is not one a run may be moved onto — or null when it is.
 *
 * The same rules the control plane applies when a `/ryph` in a thread creates a task
 * (`@ryph/orchestrator`'s `core/thread_context.ts` `changeRequestTarget`), restated because
 * this is a SEPARATE trust boundary and the head is read fresh: the run's commits end up on
 * that branch, so it has to be one this deployment can push to (not a fork's — and a fork is
 * also one this repo's clone cannot fetch at all), one still being reviewed, not the default
 * branch, and named so that every hop between here and the submission can carry it.
 *
 * The two copies MUST agree: this door warms the branch the orchestrator's door is about to
 * re-target a task onto, and a head one accepts while the other refuses is a run whose
 * checkout and whose submission disagree about where the work goes. One difference is
 * deliberate — this side also holds the name to `normalizeBaseRef`, which refuses a tag ref
 * the control plane's check would let past. It cannot desync anything: the warm runs FIRST, so
 * a head only this side refuses never reaches the claim at all, and a base this cache cannot
 * serve is one no run could have cloned.
 */
/**
 * How an answer to a run names its repo. A forge address (`acme/app`, a RID) is the repo's
 * public name; a `local` repo's address is a path on the host, which is not the run's to see —
 * these answers are printed into the run's clone output and stored by the control plane.
 */
export function repoLabel(repo: Pick<RunGrantRepo, "provider" | "repoRef">): string {
  return repo.provider === "local" ? "the repository on this machine" : repo.repoRef;
}

export function changeRequestRefusal(head: ChangeRequestHead, repo: RunGrantRepo): string | null {
  const n = `#${head.ref}`;
  if (head.merged || head.state !== "open") {
    return `${n} is ${head.merged ? "merged" : "closed"}, so there is no branch left to work on`;
  }
  // The forge's answer by identity where it has one (GitLab's project ids: the grant's path is
  // the one the project was connected under), the addresses compared where it has not.
  if (!headInRepo(head, repo.provider, repo.repoRef)) {
    const where = head.headRepoRef === null
      ? "a fork that no longer exists"
      : `the fork ${head.headRepoRef}`;
    return `${n}'s branch lives in ${where}, which ${repoLabel(repo)}'s own clone cannot reach`;
  }
  // Against the default branch as the forge reports it NOW, not as the connected repo recorded
  // it: a default that has since moved onto this very branch would otherwise pass, and the run
  // would commit to it.
  if (head.headRef === head.defaultBranch) {
    return `${n}'s branch is ${repoLabel(repo)}'s default branch, and ryph does not work on that`;
  }
  // The branch name rides the run grant, this cache and the submission that follows, each of
  // which holds it to the same ref-name contract a user's own base ref is held to. A name that
  // contract refuses (git itself allows a leading '-', for one) would warm a branch the run
  // could never ship from.
  if (!isGitRefName(head.headRef)) {
    return `${n}'s branch is named \`${head.headRef}\`, which is not a branch name ryph can ` +
      "check out";
  }
  try {
    normalizeBaseRef(head.headRef);
  } catch (err) {
    return `${n}'s branch cannot be served as a base: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
  // A bare `pull/…` or `merge-requests/…` is how this cache names change request heads: served
  // as one, it would be somebody else's code under this branch's name. The control plane refuses
  // it too.
  if (isChangeRequestHeadName(head.headRef)) {
    return `${n}'s branch's name collides with change request heads`;
  }
  return null;
}

export function gitRoutes(deps: AppDeps): Route[] {
  const { cache, diag, config } = deps;

  /** The shared gate: resolve the credential, insist the path's run id agrees, and pick the
   * member the path names. What comes back is the one repo this request may read. */
  const authed = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<{ runId: string; repo: RunGrantRepo } | Response> => {
    const grant = await resolveGrant(deps.keys, req, diag);
    if (grant instanceof Response) return grant;
    if (grant.runId !== params.runId) {
      diag.warn("git.run_id_mismatch", { granted: grant.runId, requested: params.runId });
      return unauthorized();
    }
    const repo = memberOf(grant, params.connectedRepoId, diag);
    if (repo instanceof Response) return repo;
    return { runId: grant.runId, repo };
  };

  /**
   * Why the wire cannot serve this base, as git shows it: git prints a `text/plain` error body
   * to the user and drops every other kind, so on the two wire routes the reason travels this
   * way or not at all. A refusal is the upstream's answer (a credential it would not mint, a
   * branch or repo it no longer has for ryph), carried as the refuser worded it; anything else
   * is "nothing to serve", which a retry may fix once the upstream is back.
   */
  const unservable = (repo: RunGrantRepo, err: unknown): Response => {
    // A `local` repo's refusal is git's stderr about a path on the host: logged by the cache,
    // never printed into the run's clone.
    const why = err instanceof UpstreamRefused && repo.provider !== "local"
      ? `: ${err.message}`
      : "";
    const reason = err instanceof UpstreamRefused
      ? `the upstream refused ${repo.ref} of ${repoLabel(repo)}, and ryph will not serve a ` +
        `copy it holds${why}`
      : `${repo.ref} of ${repoLabel(repo)} could not be fetched from upstream, and ryph holds ` +
        "no copy of it; retry once the upstream is back";
    return new Response(`${reason}\n`, {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  };

  /**
   * Fetches a branch a run merges to catch up into the run's cache entry — best-effort, and
   * never a reason to fail the request it rides on: the base is what the run needs, and a
   * target it cannot see only means there is nothing to merge yet. A promise the whole way
   * down: `serveBase` normalizes the ref before it returns one, and a name that throws there
   * must land in the log like any other miss.
   */
  const warmTarget = async (
    upstream: { coords: RepoCoords; credential: Credential },
    ref: string,
    about: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await cache.serveBase(upstream.coords, ref, upstream.credential);
    } catch (err) {
      diag.warn("git.target_unavailable", { ...about, ref, err: String(err) });
    }
  };

  const infoRefs = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const authedRepo = await authed(req, params);
    if (authedRepo instanceof Response) return authedRepo;
    const { runId, repo } = authedRepo;
    // Read-only: only upload-pack is advertised. receive-pack has no route at all.
    const service = new URL(req.url).searchParams.get("service");
    if (service !== "git-upload-pack") {
      return new Response("service not enabled\n", { status: 403 });
    }
    if (repo.candidate !== undefined) {
      // A check pod's clone: its candidate, and nothing out of the shared cache entry.
      const staged = await ensureCandidate(deps, runId, repo, { refresh: true });
      if (staged instanceof Response) return staged;
      return await advertiseRefs(staged.dir, req.headers.get("git-protocol"), diag);
    }
    const upstream = await upstreamFor(runId, repo, deps, "git");
    if (upstream instanceof Response) return upstream;
    // The target first, so the base's own fetch is the last to point the entry's HEAD — what a
    // plain clone checks out before the runner checks out the base by name. Best-effort: the
    // target is what a run merges to catch up, and a run that cannot see it can still work.
    if (repo.targetRef !== undefined && repo.targetRef !== repo.ref) {
      await warmTarget(upstream, repo.targetRef, { runId, repo: repo.connectedRepoId });
    }
    // And each branch a line of the run stands on after its own merge: what that line's next
    // generation is rebased onto, and fetched as such. Best-effort, as the target.
    for (const base of repo.lineBases ?? []) {
      if (base === repo.ref || base === repo.targetRef) continue;
      await warmTarget(upstream, base, { runId, repo: repo.connectedRepoId });
    }
    let dir: string;
    try {
      // Served even when the refresh fails, as long as the cache holds the branch: the run
      // then clones the last good copy, marked stale in the entry.
      const served = await cache.serveBase(upstream.coords, repo.ref, upstream.credential);
      dir = served.dir;
    } catch (err) {
      // Nothing to serve: the cache never held this base, or the upstream refused it. 502: the
      // problem is upstream of us, and unless it refused, retrying is legitimate.
      diag.warn("git.base_unavailable", {
        runId,
        repo: repo.connectedRepoId,
        err: String(err),
      });
      return unservable(repo, err);
    }
    return await advertiseRefs(dir, req.headers.get("git-protocol"), diag);
  };

  const pack = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const authedRepo = await authed(req, params);
    if (authedRepo instanceof Response) return authedRepo;
    const { runId, repo } = authedRepo;
    if (repo.candidate !== undefined) {
      const staged = await ensureCandidate(deps, runId, repo);
      if (staged instanceof Response) return staged;
      return uploadPack(staged.dir, req, { maxRequestBytes: config.maxUploadPackBytes, diag });
    }
    // Serve from the cache as it stands; fall back to a full serveBase only when it cannot
    // serve this base (a POST with no prior advertisement, a cache wiped mid-conversation, or
    // an entry holding no usable base — `find` weighs all three the same way).
    // The upstream's ADDRESS is needed either way, since it is the cache's key; only the branch
    // that talks to the upstream spends the credential, and the credential is minted only when
    // spent.
    const upstream = await upstreamFor(runId, repo, deps, "git");
    if (upstream instanceof Response) return upstream;
    let dir: string;
    try {
      const found = await cache.find(upstream.coords, repo.ref);
      dir = found !== null
        ? found.dir
        : (await cache.serveBase(upstream.coords, repo.ref, upstream.credential)).dir;
    } catch (err) {
      diag.warn("git.base_unavailable", {
        runId,
        repo: repo.connectedRepoId,
        err: String(err),
      });
      return unservable(repo, err);
    }
    return uploadPack(dir, req, { maxRequestBytes: config.maxUploadPackBytes, diag });
  };

  /**
   * How fresh a branch of this member's entry is: the instant its refreshes started failing,
   * or null when the last one succeeded, and the commit the entry holds for it, so a run that
   * just fetched can tell whether the shared entry moved under its fetch. Read off the entry
   * alone, with no upstream contact and no credential spent, so it is exactly as available as
   * the clone it answers for. `ref` defaults to the member's base; a branch the entry does not
   * hold is a 404, since there is nothing to be fresh or stale about.
   */
  const baseFreshness = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const authedRepo = await authed(req, params);
    if (authedRepo instanceof Response) return authedRepo;
    const { runId, repo } = authedRepo;
    const ref = new URL(req.url).searchParams.get("ref") ?? repo.ref;
    if (!isGitRefName(ref)) {
      return json(400, { error: `"${ref}" is not a git ref name` });
    }
    const upstream = await upstreamFor(runId, repo, deps, "git");
    if (upstream instanceof Response) return upstream;
    const held = await cache.find(upstream.coords, ref);
    if (held === null) {
      return json(404, { error: `${ref} is not a branch ryph holds for ${repoLabel(repo)}` });
    }
    return json(200, {
      ref: held.localBranch,
      commit: held.commit,
      staleSince: held.freshness.kind === "stale" ? held.freshness.since : null,
    });
  };

  /**
   * Make a change request's head fetchable by this run: read it off the forge, hold it to the
   * rules a run's branch must satisfy, and fetch it into the run's own cache entry as a second
   * local branch. The answer is what the runner fetches by and checks its result against.
   *
   * Warming is all this does. It re-targets nothing — the task still points where it pointed,
   * and the run's own output branch is untouched — so a head the orchestrator then refuses to
   * hand the run costs a fetch and nothing else. That ordering is deliberate: a change request
   * this door cannot serve must never become a task's target.
   */
  const changeRequestBase = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const authedRepo = await authed(req, params);
    if (authedRepo instanceof Response) return authedRepo;
    const { runId, repo } = authedRepo;
    if (repo.candidate !== undefined) {
      // A check pod reads one commit; it has no change request to move onto, and a warm would
      // write into the cache entry every run of this upstream clones from.
      diag.warn("git.candidate_warm_refused", { runId, repo: repo.connectedRepoId });
      return unauthorized();
    }
    // Percent-decoded by the router: a Radicle thread ref is spelled with a ':' the caller
    // escaped.
    const thread = params.thread;
    /** Every refusal in one place: the agent reads `error` as the reason it was told no.
     * `detail` is for the log alone — the forge's own words, which are rarely the agent's. */
    const refuse = (status: number, why: string, detail?: string): Response => {
      diag.warn("git.change_request_refused", {
        runId,
        repo: repo.connectedRepoId,
        thread,
        status,
        why,
        ...(detail === undefined ? {} : { detail }),
      });
      return json(status, { error: why });
    };

    // The thread ref arrives as a URL segment and leaves as one: every adapter interpolates it
    // into a forge API path, so it is held to the same spelling a request body's would be.
    if (!isThreadRef(thread)) {
      return refuse(400, `"${thread}" is not a change request reference`);
    }
    if (!deps.forges?.has(repo.provider)) {
      // Wiring, not the caller: without an API for this forge there is no head to read. Said
      // plainly rather than as a 404, which would read as "no such change request".
      return refuse(501, `this deployment cannot read ${repo.provider} change requests`);
    }
    const api = deps.forges.for(repo.provider);
    // The whole repo, its GitLab project id with it: a rebuilt pair would drop the id.
    const target = forgeRepoOf(repo);
    let head: ChangeRequestHead;
    try {
      // ONE question of the forge, and the one this door exists to ask. An issue's ref is not
      // told apart from a ref that names nothing — both are a terminal refusal here — because
      // the distinction would cost a second round trip to change an answer the agent acts on
      // identically: there is no branch either way.
      head = await api.describeChangeRequest(target, thread);
    } catch (err) {
      // Terminality travels, as everywhere this package asks a forge: a definitive refusal is
      // a 404 no retry finds again, and everything else is "could not ask", which a retry may
      // fix — so the transient one says to try again, and the other does not.
      // Terminal is WIDER than "gone": an adapter marks every definitive 4xx terminal, and a
      // suspended or revoked installation is one. `ForgeApiError` carries no status to tell
      // them apart, so the words below name every way the answer can be definitive rather
      // than picking one and being wrong about it.
      // The forge's own words go to the log, never to the agent: "404 from /repos/…/pulls/42"
      // names nothing it can do differently.
      const terminal = err instanceof ForgeApiError && err.terminal;
      return terminal
        ? refuse(
          404,
          `#${thread} is not an open change request of ${repoLabel(repo)} — it may be an issue, ` +
            "it may not exist, or ryph may no longer have access to it",
          String(err),
        )
        : refuse(502, `${err instanceof Error ? err.message : String(err)} — try again`);
    }
    const why = changeRequestRefusal(head, repo);
    if (why !== null) return refuse(400, why);

    const upstream = await upstreamFor(runId, repo, deps, "git");
    if (upstream instanceof Response) return upstream;
    let localBranch: string;
    try {
      // A second base in the entry the run already clones from — the cache accretes the
      // branches runs actually used, and this is one of them. The advertisement lists whatever
      // the entry holds, so warming it here IS "the run can now fetch the change request".
      // The entry is SHARED across runs of this upstream, and a refresh points its HEAD at
      // whatever it last fetched — so a warm moves the default branch of a cache every other
      // run clones from onto one run's change request. Harmless, and for the reason the cache
      // already states: every run checks out the ref its own grant names, and nothing here
      // reads HEAD. Last-writer-wins on a symbolic ref nobody consults.
      // What it merges into, first: the grant only names it once the claim that follows has
      // landed and the gateway's grant cache has turned over, and an `update_from_base` right
      // after the checkout would otherwise find it missing, or as some earlier run left it.
      // Best-effort; the head's fetch below is the one that decides this answer.
      // Not when it is a branch every fetch refreshes anyway — the run's own base, the common
      // case, or its target — since a second upstream fetch here counts against the runner's
      // warm budget.
      const refreshed = [
        repo.ref,
        ...(repo.targetRef === undefined ? [] : [repo.targetRef]),
        ...(repo.lineBases ?? []),
      ];
      if (
        head.baseRef !== head.headRef &&
        !refreshed.some((ref) => sameBranch(head.baseRef, ref))
      ) {
        await warmTarget(upstream, head.baseRef, { runId, repo: repo.connectedRepoId, thread });
      }
      // Strict: the runner checks what it fetched against `headSha` below, and a copy the
      // upstream could not refresh would only fail that check with a confusing mismatch.
      const cached = await cache.refreshBase(
        upstream.coords,
        head.headRef,
        upstream.credential,
      );
      localBranch = cached.localBranch;
    } catch (err) {
      diag.warn("git.base_unavailable", {
        runId,
        repo: repo.connectedRepoId,
        thread,
        err: String(err),
      });
      return json(502, { error: "could not prepare the change request's branch — try again" });
    }
    diag.debug("git.change_request_warmed", {
      runId,
      repo: repo.connectedRepoId,
      thread,
      ref: localBranch,
      headSha: head.headSha,
    });
    // The branch the cache SERVES it as, not the forge's spelling of it: those differ only for
    // a fully qualified head, and the runner fetches by what this says.
    return json(200, { ref: localBranch, headSha: head.headSha, url: head.url });
  };

  return [
    route("GET", "/v1/git/:runId/:connectedRepoId/repo.git/info/refs", infoRefs),
    route("POST", "/v1/git/:runId/:connectedRepoId/repo.git/git-upload-pack", pack),
    route("GET", "/v1/git/:runId/:connectedRepoId/base", baseFreshness),
    route(
      "POST",
      "/v1/git/:runId/:connectedRepoId/change-requests/:thread/base",
      changeRequestBase,
    ),
  ];
}

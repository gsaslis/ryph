// Door ②: bundle intake — POST /v1/patches/:connectedRepoId, the patch's front door and the
// ONLY way work leaves a run. The path names WHICH repo of the run's set the bundle is for:
// every repo of a run carries the same branch namespace, so the bundle's own header cannot say,
// and the member must be one the credential's grant holds. The uploaded bundle's header is what
// makes an upload from an untrusted container validatable: reject unless it declares exactly
// one ref and that ref is a LINE of the run's branch namespace in that repo — `<namespace>/<line>`,
// or a later GENERATION of it, `<namespace>/<line>-<n>`, which the runner starts on the merged tip
// once a patch of that line landed (@ryph/shared/lines) — and unless its prerequisites are satisfied
// by the base cache. The moment `patch_store.put`
// returns, the patch is durable — nothing after intake depends on any upstream being reachable.
//
// Invariants:
// - a CHECK grant (a member carrying `candidate`) never ships: it is a check pod's read of one
//   commit, and its key is refused here as flatly as an unknown one. A check pod runs head code;
//   letting it file bundles would let the code under test mint new candidates of its own
// - the size cap rejects WHILE STREAMING (an agent that commits a 500 MB file POSTs 500 MB;
//   buffer-then-check is the DoS), with a clean 413 — headers have not been sent yet
// - validation precedes storage: nothing lands in the patch store that was not verified
// - prerequisites are checked against the cache AS IT STANDS whenever it holds this run's base
//   (`find` first): a patch's birth must not depend on the forge being reachable, and for a
//   cache that has the base it does not — nothing here reaches upstream. A cache WITHOUT it is
//   the one case with no such choice — verification needs the base objects and there is nowhere
//   else to get them — so intake warms it rather than refusing. That is not a weakening: the
//   alternative was never a safe answer, just a failed one (503), and on a deployment where the
//   cache is a pod's scratch disk a single restart mid-run made it certain
// - only a cache that cannot serve the base spends a token or an upstream round trip; a
//   verification failure against a base we DO hold is the bundle's problem, and terminal —
//   re-fetching a base that is already there would answer nothing and cost everyone
// - exact base-SHA equality against a serve-time record is NOT checked here
//   (the gateway does not record what each clone was served); prerequisite satisfaction is
//   the enforceable invariant, and a wrong-but-existing base yields at worst a bad patch for
//   a human to read — the contained outcome the threat model already prices in

import { rm } from "node:fs/promises";
import type { PatchSubmission } from "../core/types.ts";
import { json, type Route, route } from "@ryph/shared/http";
import { memberOf, resolveGrant, unauthorized } from "./auth.ts";
import { upstreamFor } from "./fetch_auth.ts";
import type { AppDeps } from "./app.ts";
import { bundleVerifier, soleRef, stageUpload } from "./bundle_intake.ts";
import { parseLineBranch, runBundleKey } from "@ryph/shared/lines";

/**
 * Whether a bundle's one ref is a line of the run's branch namespace in this repo:
 * `refs/heads/<namespace>/<line>`, or a later generation `…/<line>-<n>` (n ≥ 2), with a valid
 * line name. Nothing else under the namespace — the bare namespace included, which git could not
 * hold beside its lines anyway — and nothing outside it.
 */
export function isRunOutputRef(ref: string, branchNamespace: string): boolean {
  return ref.startsWith("refs/heads/") && parseLineBranch(ref, branchNamespace) !== null;
}

export function patchRoutes(deps: AppDeps): Route[] {
  const { cache, patches, diag, config } = deps;
  const verify = bundleVerifier(diag);

  const intake = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const grant = await resolveGrant(deps.keys, req, diag);
    if (grant instanceof Response) return grant;
    const repo = memberOf(grant, params.connectedRepoId, diag);
    if (repo instanceof Response) return repo;
    const runId = grant.runId;
    if (repo.candidate !== undefined) {
      diag.warn("patches.candidate_grant_refused", { runId, repo: repo.connectedRepoId });
      return unauthorized();
    }

    // The cap's 413 comes before any disk touch for Content-Length framing, and while
    // streaming for chunked.
    const staged = await stageUpload(req, {
      maxBytes: config.maxBundleBytes,
      stagingDir: config.stagingDir,
    });
    if (staged.kind === "too-large") {
      diag.warn("patches.body_capped", { runId, limit: config.maxBundleBytes });
      return json(413, { error: "bundle exceeds the size limit" });
    }
    const stagingPath = staged.path;
    try {
      // The bundle's self-description: exactly one ref, and it is a line of this run's namespace.
      const one = await soleRef(stagingPath);
      if (typeof one === "string") return json(400, { error: one });
      const line = isRunOutputRef(one.ref, repo.branchNamespace)
        ? parseLineBranch(one.ref, repo.branchNamespace)
        : null;
      if (line === null) {
        return json(400, {
          error: `bundle declares "${one.ref}"; this run's output refs are ` +
            `"refs/heads/${repo.branchNamespace}/<line>" (or a later generation of one, ` +
            "with a numeric suffix from -2 up)",
        });
      }
      // The branch the bundle carries, as the control plane must file the patch under: the
      // generation's own name, not the entry's.
      const branchName = one.ref.slice("refs/heads/".length);

      // Prerequisites, against the cache as it stands — the fast path, and no upstream contact.
      // The base is there for any run that cloned through the gateway and whose cache outlived
      // it; `find` answers null when it did not — wiped mid-run, or an entry that holds no
      // usable base — which on a disposable cache is not exotic. Warm it back up with the run's
      // own credential rather than refusing work that already exists.
      // The cache is keyed by the UPSTREAM, which for a forge that is not a git host is not
      // the repo's own address — see http/fetch_auth.ts.
      const upstream = await upstreamFor(runId, repo, deps, "patches");
      if (upstream instanceof Response) return upstream;
      const coords = upstream.coords;
      /** Fetches the base in. A Response is the answer to give up with. */
      const warm = async (): Promise<{ dir: string } | Response> => {
        try {
          const warmed = await cache.serveBase(coords, repo.ref, upstream.credential);
          diag.debug("patches.cache_warmed", { runId, repo: repo.connectedRepoId });
          return warmed;
        } catch (err) {
          // Still retryable, and for the same reason as before: the bundle is intact and the
          // base is reachable in principle. Only the fetch failed, and only just now.
          diag.warn("patches.cache_unwarmable", {
            runId,
            repo: repo.connectedRepoId,
            err: String(err),
          });
          return json(503, { error: "base cache unavailable, retry" });
        }
      };

      // `find` is ref-aware, so a hit is an entry that really resolves this run's base rather
      // than one that merely looks like a repo. That is what lets the verdict below be read
      // straight: a failure here is about the bundle, never about our own empty cache.
      let base: { dir: string } | null = await cache.find(coords, repo.ref);
      if (base === null) {
        diag.warn("patches.cache_missing", {
          runId,
          repo: repo.connectedRepoId,
          ref: repo.ref,
        });
        const result = await warm();
        if (result instanceof Response) return result;
        base = result;
      }

      const failure = await verify(base.dir, stagingPath);
      if (failure !== null) {
        // Prerequisites missing from a base that IS here, or a malformed pack — either way the
        // bundle cannot be applied to this repo, and no fetch we could make would change that.
        // Terminal, and the run is told so once rather than retrying into the same answer.
        return json(400, {
          error: "bundle prerequisites are not satisfied by the base repo",
          detail: failure,
        });
      }

      const headSha = one.sha;
      // Filed under the run, the branch AND the repo (@ryph/shared/lines `runBundleKey`): two repos
      // of one run never collide on a head, nor do two lines of one repo at the same head, and
      // the key says which repo and branch a bundle belongs to without opening it. The control
      // plane derives this same key.
      const bundleKey = runBundleKey(runId, repo.connectedRepoId, line, headSha);
      await patches.put(bundleKey, stagingPath); // consumes the staging file
      const submission: PatchSubmission = {
        runId,
        connectedRepoId: repo.connectedRepoId,
        branchName,
        headSha,
        bundleKey,
        receivedAt: new Date().toISOString(),
      };
      diag.debug("patches.received", {
        runId,
        repo: repo.connectedRepoId,
        headSha,
        bundleKey,
      });
      return json(201, submission);
    } finally {
      // Best-effort sweep for every early return above; a successful put already moved it.
      await rm(stagingPath).catch(() => {});
    }
  };

  return [route("POST", "/v1/patches/:connectedRepoId", intake)];
}

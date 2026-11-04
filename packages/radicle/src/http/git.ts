// The read-only git door: `GET /v1/repos/:rid/git/info/refs?service=git-upload-pack` and
// `POST /v1/repos/:rid/git/git-upload-pack`, so the forge's repo cache has an upstream to clone
// a Radicle repository from.
//
// Read-only is STRUCTURAL, twice over:
// - `git-receive-pack` has no route. Not disabled by config — absent.
// - what `upload-pack` is pointed at is a MIRROR (helpers/export_repo.ts) holding only the
//   canonical `refs/heads/*` and `refs/tags/*`, borrowing storage's objects through
//   `alternates`. Nothing ever writes to it, and the peers' namespaces are not in it to serve.
//
// The advertisement optionally triggers a bounded network fetch first (`rad sync --fetch`, see
// core/sync_fetch.ts), so a clone gets what the network has rather than what we last happened
// to receive. It is bounded and best-effort: a node that is down or a repo no peer holds still
// serves what storage already has. And it is SKIPPED when the repository was fetched within
// `gitFetchFreshMs` — by the pull, a seed, or the clone before this one — because the pull
// already asks every seeded repository every minute, and a workspace of N repositories clones
// N times in a row, one after another: N × the budget on every task start, for refs the pull
// had brought down under a minute earlier.
//
// The ADVERTISEMENT is the only half that rewrites the mirror's refs, so that both halves of
// one clone see one set of refs. BOTH halves hold the repository's lock, though — the pack for
// as long as it is being written — because the directory one clone is being served out of is
// the one another clone's advertisement rewrites in place.

import { stat } from "node:fs/promises";
import type { RepoIdentity } from "../core/types.ts";
import { advertiseRefs, uploadPack } from "../helpers/http_backend.ts";
import { setExportHead, syncExportRepo } from "../helpers/export_repo.ts";
import { normalizeRid } from "../helpers/ids.ts";
import { acquireRepoLock, withRepoLock } from "../helpers/repo_lock.ts";
import { json, type Route, route } from "@ryph/shared/http";
import type { BridgeHttpDeps } from "./routes.ts";

/** One mirror per RID under `exportDir`, owned entirely by this process. */
export function mirrorDirOf(exportDir: string, rid: string): string {
  return `${exportDir}/${rid.slice("rad:".length)}.git`;
}

export function gitRoutes(deps: BridgeHttpDeps): Route[] {
  const { service, diag, config } = deps;

  const mirrorDir = (rid: string): string => mirrorDirOf(config.exportDir, rid);

  /**
   * Rewrites the mirror's refs from storage and answers the directory to serve.
   *
   * ALWAYS CALLED UNDER THE REPOSITORY'S LOCK: this reads storage's refs and writes the
   * mirror's, and a push through `git-remote-rad` moves the very refs it is reading. Serializing
   * it against this process's own writers is what keeps one advertisement internally consistent.
   * (The paired node writes storage too, and no lock of ours reaches it — git's own ref locks
   * are what keep that from tearing a single ref.)
   */
  const syncMirror = async (rid: string): Promise<string | Response> => {
    let identity: RepoIdentity;
    try {
      identity = await service.repo(rid);
    } catch {
      return json(404, { error: `no repository ${rid} in this node's storage` });
    }
    const git = (cwd: string, args: string[], opts?: { timeoutMs?: number; stdin?: string }) =>
      deps.exec.git(cwd, args, opts);
    const dir = await syncExportRepo({
      storageDir: service.storageDir(rid),
      exportDir: mirrorDir(rid),
      // Whose change request head wins when two peers hold one — ours, so a run adding a
      // revision checks out what ryph last pushed.
      selfNid: identity.self.nid,
      git,
    });
    await setExportHead(dir, identity.defaultBranch, git);
    return dir;
  };

  const infoRefs = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const gate = await deps.authenticate(req);
    if (gate) return gate;
    let rid: string;
    try {
      rid = normalizeRid(params.rid);
    } catch {
      return json(400, { error: "not a repository id" });
    }
    // The routes' scope rule (`guarded` in routes.ts), on this door too: a user-mode bridge
    // serves the repositories connected to ryph and none of the rest of its owner's node.
    if (!(await service.inScope(rid))) {
      return json(404, { error: `${rid} is not a repository connected to ryph` });
    }
    // Only upload-pack is advertised. `git-receive-pack` is not a service this door knows.
    if (new URL(req.url).searchParams.get("service") !== "git-upload-pack") {
      return new Response("service not enabled\n", { status: 403 });
    }
    // The fetch and the mirror rewrite are ONE critical section: a fetch we asked for lands in
    // storage, and the rewrite immediately below is what turns it into an advertisement.
    const dir = await withRepoLock(rid, async () => {
      if (config.fetchBeforeAdvertise) {
        if (service.fetchedWithin(rid, config.gitFetchFreshMs)) {
          // Somebody asked the network for this repository within the window, so storage is as
          // fresh as asking again would make it. Only a fetch that LANDED counts (see
          // `fetchedWithin`): a refusal a moment ago is a reason to ask, not to skip.
          diag.debug("git.fetch_before_advertise_skipped", {
            rid,
            freshMs: config.gitFetchFreshMs,
          });
        } else {
          try {
            // No grace past the budget: the forge's services-file read waits 10 s for this whole
            // answer, and a `rad sync` the node keeps waiting ran 3 s + 5 s of grace, which with
            // the forge's own work missed it and refused the run.
            await service.fetchFromNetwork(rid, config.gitFetchTimeoutMs, { graceMs: 0 });
          } catch (err) {
            // Best-effort by design: storage already holds a usable answer.
            diag.debug("git.fetch_before_advertise_failed", { rid, err: String(err) });
          }
        }
      }
      return await syncMirror(rid);
    });
    if (dir instanceof Response) return dir;
    return await advertiseRefs(dir, req.headers.get("git-protocol"), diag);
  };

  const pack = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const gate = await deps.authenticate(req);
    if (gate) return gate;
    let rid: string;
    try {
      rid = normalizeRid(params.rid);
    } catch {
      return json(400, { error: "not a repository id" });
    }
    // The routes' scope rule (`guarded` in routes.ts), on this door too: a user-mode bridge
    // serves the repositories connected to ryph and none of the rest of its owner's node.
    if (!(await service.inScope(rid))) {
      return json(404, { error: `${rid} is not a repository connected to ryph` });
    }
    // Neither a fetch NOR a re-prepare here: the negotiation that follows an advertisement must
    // see the same refs the advertisement offered. Rewriting the mirror on this half of the
    // exchange would let a push or a node fetch that landed in between move a ref under the
    // client, which comes back as "not our ref" on a request the client was right to make. The
    // mirror is served exactly as it was advertised.
    //
    // UNDER THE REPOSITORY'S LOCK ALL THE SAME, for the other half of that same failure: this
    // pack is served out of one mirror directory that ANOTHER client's `info/refs` rewrites in
    // place. Two clones of one repository overlapping — a cache warm and a submission's base
    // fetch, which is exactly what a run does — would otherwise have the second one's
    // advertisement move refs and repack under the first one's `upload-pack`, and git says
    // "not our ref" about an object the client was right to ask for. Held for the duration of
    // one pack, which is a bounded local read, and serialized against writers rather than
    // against the network.
    //
    // The lock is taken HERE and released when the pack has been written, not when this handler
    // returns: `uploadPack` answers a streaming response whose bytes are produced by a
    // subprocess afterwards, so a lock held only across the call would be a lock held across
    // nothing. The cost is that a client which stops reading stalls the repository's writers
    // until its socket dies; that is a surface only the forge can reach, holding the shared
    // bearer, and the alternative is serving a pack out of a directory somebody else is
    // rewriting.
    const dir = mirrorDir(rid);
    const release = await acquireRepoLock(rid);
    let res: Response;
    try {
      const built = await stat(`${dir}/HEAD`).catch(() => null);
      if (built === null) {
        // Nothing has ever been advertised for this repository (a restart with a fresh data
        // volume, or a client that skipped `info/refs`). There is no advertisement to stay
        // consistent with, so build the mirror rather than answer a puzzling failure.
        const prepared = await syncMirror(rid);
        if (prepared instanceof Response) {
          release();
          return prepared;
        }
      }
      res = await uploadPack(dir, req, { maxRequestBytes: config.maxUploadPackBytes, diag });
    } catch (err) {
      release();
      throw err;
    }
    if (res.body === null) {
      release();
      return res;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      release();
    };
    // Both endings: the pack finished, or the client hung up mid-pack and the body was
    // cancelled. Missing either one leaves the repository locked for the life of the process.
    // `cancel` is the Streams standard's and the runtime calls it; bun-types' `Transformer`
    // just does not name it, so the object is built apart from the call.
    const releasing = { flush: finish, cancel: finish };
    return new Response(
      res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(releasing)),
      { status: res.status, headers: res.headers },
    );
  };

  return [
    route("GET", "/v1/repos/:rid/git/info/refs", infoRefs),
    route("POST", "/v1/repos/:rid/git/git-upload-pack", pack),
  ];
}

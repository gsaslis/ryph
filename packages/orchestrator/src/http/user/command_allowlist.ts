import { RepoCommandAllowlistSchema } from "../../schema.ts";
import type { WiredDeps } from "../app.ts";
import { refuseUnless } from "@ryph/auth/gates";
import { json, parseBody, type Route, route } from "@ryph/shared/http";
import { repoAccess } from "./repo_access.ts";

export function commandAllowlistRoutes(deps: WiredDeps): Route[] {
  const { store } = deps;
  const nowIso = () => deps.now().toISOString();
  const { refuseRepoPermissionHere } = repoAccess(deps);

  // ---- a repo's command allowlist ---------------------------------------------
  //
  // Who, beside whoever the forge itself reports write access for, may command agents in one
  // repo. Admin-gated on the repo, like every other change to the connection itself; the
  // `/ryph` path is what reads it, where the forge has no write tier to borrow.

  const listCommandAllowlist = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    const repo = await store.getConnectedRepo(params.id);
    if (!repo) return json(404, { error: "no such connected repo" });
    const refused = await refuseRepoPermissionHere(caller, repo, "admin");
    if (refused) return refused;
    return json(200, { entries: await store.listRepoCommandAllowlist(repo.id) });
  };

  const addCommandAllowlistEntry = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:manage");
    if (denied) return denied;
    const repo = await store.getConnectedRepo(params.id);
    if (!repo) return json(404, { error: "no such connected repo" });
    if (repo.archivedAt !== null) return json(409, { error: "connected repo is disconnected" });
    const body = await parseBody(req, RepoCommandAllowlistSchema);
    if (!body.ok) return body.res;
    const refused = await refuseRepoPermissionHere(caller, repo, "admin");
    if (refused) return refused;
    // The subject is on the REPO's forge, never the caller's choice of one: an entry naming
    // another forge's identity could never be matched against an event from this repo.
    await store.addRepoCommandAllowlistEntry({
      connectedRepoId: repo.id,
      provider: repo.provider,
      subject: body.data.subject,
      addedBy: caller.kind === "user" ? caller.userId : "break-glass",
      createdAt: nowIso(),
    });
    return json(201, { entries: await store.listRepoCommandAllowlist(repo.id) });
  };

  const removeCommandAllowlistEntry = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:manage");
    if (denied) return denied;
    const repo = await store.getConnectedRepo(params.id);
    if (!repo) return json(404, { error: "no such connected repo" });
    const refused = await refuseRepoPermissionHere(caller, repo, "admin");
    if (refused) return refused;
    // A subject is a login or a DID, whose colons the caller percent-encoded; the router
    // decodes them.
    const subject = params.subject;
    await store.removeRepoCommandAllowlistEntry(repo.id, repo.provider, subject);
    return json(200, { entries: await store.listRepoCommandAllowlist(repo.id) });
  };

  return [
    route(
      "GET",
      "/v1/connected-repos/:id/command-allowlist",
      listCommandAllowlist,
    ),
    route("POST", "/v1/connected-repos/:id/command-allowlist", addCommandAllowlistEntry),
    route(
      "DELETE",
      "/v1/connected-repos/:id/command-allowlist/:subject",
      removeCommandAllowlistEntry,
    ),
  ];
}

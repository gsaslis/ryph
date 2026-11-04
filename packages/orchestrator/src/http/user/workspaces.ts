import type { ConnectedRepo, Workspace, WorkspaceRepo } from "../../core/types.ts";
import { defaultPathFor, MAX_REPOS } from "../../core/workspaces.ts";
import { mintId } from "@ryph/sealed";
import {
  AddWorkspaceRepoSchema,
  CreateWorkspaceSchema,
  UpdateWorkspaceRepoSchema,
  UpdateWorkspaceSchema,
} from "../../schema.ts";
import { can } from "@ryph/auth";
import type { Principal, WiredDeps } from "../app.ts";
import { refuseUnless } from "@ryph/auth/gates";
import { json, parseBody, type Route, route } from "@ryph/shared/http";
import { repoAccess } from "./repo_access.ts";

/** The `workspace_repos_by_path` index refusing a duplicate — the photo finish on a path. */
function isPathTaken(err: unknown): boolean {
  for (let e: unknown = err, hops = 0; e !== null && e !== undefined && hops < 4; hops++) {
    const it = e as {
      code?: unknown;
      constraint_name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const names = `${String(it.constraint_name ?? "")} ${String(it.message ?? "")}`;
    if (it.code === "23505" && names.includes("workspace_repos_by_path")) return true;
    e = it.cause;
  }
  return false;
}

export function workspaceRoutes(deps: WiredDeps): Route[] {
  const { store } = deps;
  const nowIso = () => deps.now().toISOString();
  const { refuseRepoPermissionHere, refuseSizeClass } = repoAccess(deps);

  // ---- workspaces -------------------------------------------------------------

  // A workspace is a saved list of connected repos. Creating one is any user's: an empty list
  // grants nothing. CHANGING one — renaming it, rewriting its description, editing a member,
  // adding a repo, archiving — is managing every member at once, and needs the bar of every
  // member (`refuseWorkspaceManagement`); adding a repo needs admin on the one joining too.
  // Taking a repo out needs admin on that repo alone, so an owner can always leave.
  //
  // Every write names only the columns it changes and leaves the rest to the store, so a
  // request that read the workspace earlier can never put back what changed since.

  const createWorkspace = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "workspaces:manage");
    if (denied) return denied;
    const body = await parseBody(req, CreateWorkspaceSchema);
    if (!body.ok) return body.res;
    const at = nowIso();
    const workspace: Workspace = {
      id: mintId("ws"),
      name: body.data.name,
      description: body.data.description?.trim() ? body.data.description.trim() : null,
      sizeClass: null,
      environmentRepoId: null,
      archivedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    await store.createWorkspace(workspace);
    return json(201, { workspace, repos: [], canManage: true });
  };

  /**
   * Who may change a workspace: someone with admin on EVERY live member, or `repos:manage-all`.
   * A workspace is shared configuration — its description rides unquoted into the prompt of
   * every run on every member, and its list decides which repos every task, automation and
   * `/ryph` on any member checks out — so the bar is the union of its members' bars, the same
   * one adding each member cleared. A member whose repo is gone or disconnected gates nothing:
   * nobody can be admin on it, and removing it is the fix.
   * An empty workspace is anybody's to shape, like creating one is.
   *
   * Returns the refusal to send, or null to proceed.
   */
  const refuseWorkspaceManagement = async (
    caller: Principal,
    members: WorkspaceRepo[],
  ): Promise<Response | null> => {
    if (caller.kind === "break-glass" || can(caller, "repos:manage-all")) return null;
    const live: ConnectedRepo[] = [];
    for (const member of members) {
      const repo = await store.getConnectedRepo(member.connectedRepoId);
      if (repo === null || repo.archivedAt !== null) continue;
      live.push(repo);
    }
    // Asked together rather than one after another. The verdicts are independent, and this
    // runs once per workspace on a page that lists every workspace — serialized, a workspace
    // of MAX_REPOS members is twenty round trips deep before the next workspace even starts.
    // The fan-out is bounded twice: by MAX_REPOS in flight here, and by the forge adapter's
    // short-lived per-(repo, login, threshold) verdict cache, which is what keeps a cosmetic
    // list view off the installation's REST quota.
    const refusals = await Promise.all(
      live.map((repo) => refuseRepoPermissionHere(caller, repo, "admin")),
    );
    // Member order decides which refusal is shown, so the answer never depends on which check
    // happened to finish first.
    return refusals.find((refused) => refused !== null) ?? null;
  };

  /** A workspace as the outside sees it: the row, its members in checkout order, and whether
   * THIS caller may change it — so a UI shows the controls to the people the API would let
   * through, instead of a 403 after the click. */
  const describeWorkspace = async (workspace: Workspace, caller: Principal) => {
    const repos = await store.listWorkspaceRepos(workspace.id);
    return {
      workspace,
      repos,
      // An archived workspace is history: nobody changes it, so nobody is offered to.
      canManage: workspace.archivedAt === null &&
        refuseUnless(caller, "workspaces:manage") === null &&
        (await refuseWorkspaceManagement(caller, repos)) === null,
    };
  };

  const listWorkspaces = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "workspaces:read");
    if (denied) return denied;
    const workspaces = await store.listWorkspaces();
    return json(200, {
      workspaces: await Promise.all(workspaces.map((w) => describeWorkspace(w, caller))),
    });
  };

  const getWorkspace = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "workspaces:read");
    if (denied) return denied;
    const workspace = await store.getWorkspace(params.id);
    if (!workspace) return json(404, { error: "no such workspace" });
    return json(200, await describeWorkspace(workspace, caller));
  };

  const updateWorkspace = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "workspaces:manage");
    if (denied) return denied;
    const workspace = await store.getWorkspace(params.id);
    if (!workspace) return json(404, { error: "no such workspace" });
    // Archived is history, and with its members released it would otherwise be anybody's to
    // rename — the name historical tasks still show.
    if (workspace.archivedAt !== null) return json(409, { error: "workspace is archived" });
    const body = await parseBody(req, UpdateWorkspaceSchema);
    if (!body.ok) return body.res;
    const refused = await refuseWorkspaceManagement(
      caller,
      await store.listWorkspaceRepos(workspace.id),
    );
    if (refused) return refused;
    // On top of managing the workspace, as on a repo: the bill is the operator's.
    if (body.data.sizeClass !== undefined) {
      const refusedSize = refuseSizeClass(caller, body.data.sizeClass);
      if (refusedSize) return refusedSize;
    }
    // Which member's Dockerfile builds the workspace's machine: `resources:manage` too — a build
    // spends the operator's money, and the choice is what every workspace run starts on. Only a
    // member can be named: a repo outside the workspace is not in its checkout to build from.
    if (body.data.environmentRepoId !== undefined) {
      const refusedRepo = refuseUnless(
        caller,
        "resources:manage",
        "changing a workspace's environment repo",
      );
      if (refusedRepo) return refusedRepo;
      const chosen = body.data.environmentRepoId;
      if (
        chosen !== null &&
        !(await store.listWorkspaceRepos(workspace.id)).some((m) => m.connectedRepoId === chosen)
      ) {
        return json(400, {
          error: `${chosen} is not a member of workspace "${workspace.name}" — only a member's ` +
            ".ryph/Dockerfile can define its machine",
        });
      }
    }
    const fields = {
      name: body.data.name ?? workspace.name,
      // `null` clears the description; absent leaves it alone.
      description: body.data.description === undefined
        ? workspace.description
        : (body.data.description?.trim() ? body.data.description.trim() : null),
      sizeClass: body.data.sizeClass === undefined ? workspace.sizeClass : body.data.sizeClass,
      environmentRepoId: body.data.environmentRepoId === undefined
        ? workspace.environmentRepoId
        : body.data.environmentRepoId,
      updatedAt: nowIso(),
    };
    if (!await store.updateWorkspace(workspace.id, fields)) {
      return json(409, { error: "workspace is archived" });
    }
    return json(200, await describeWorkspace({ ...workspace, ...fields }, caller));
  };

  /**
   * Archiving is the end of the workspace as a unit: the row stays, so a task that named it
   * keeps resolving its name, but the MEMBERS are released. A repo belongs to at most one
   * workspace, and one that stayed bound to an archived one could neither run on its own
   * (`/ryph` would find the archived workspace and refuse) nor join another (the unique index
   * says it is taken) — the lock-up this releases. There is no unarchive: with its members
   * gone, an archived workspace is history, and a new one is a new one.
   *
   * The store archives and releases as one unit, and a repeat finishes the job rather than
   * answering "already archived": nothing may leave a member bound to an archived workspace.
   */
  const archiveWorkspace = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "workspaces:manage");
    if (denied) return denied;
    const workspace = await store.getWorkspace(params.id);
    if (!workspace) return json(404, { error: "no such workspace" });
    const members = await store.listWorkspaceRepos(workspace.id);
    const refused = await refuseWorkspaceManagement(caller, members);
    if (refused) return refused;
    const archived = await store.archiveWorkspace(workspace.id, nowIso());
    if (archived === null) return json(404, { error: "no such workspace" });
    return json(200, await describeWorkspace(archived, caller));
  };

  const addWorkspaceRepo = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "workspaces:manage");
    if (denied) return denied;
    const workspace = await store.getWorkspace(params.id);
    if (!workspace) return json(404, { error: "no such workspace" });
    if (workspace.archivedAt !== null) return json(409, { error: "workspace is archived" });
    const body = await parseBody(req, AddWorkspaceRepoSchema);
    if (!body.ok) return body.res;
    const repo = await store.getConnectedRepo(body.data.connectedRepoId);
    if (!repo) return json(404, { error: "no such connected repo" });
    if (repo.archivedAt !== null) return json(409, { error: "connected repo is disconnected" });
    // Two bars: admin on the repo joining (membership decides what runs on it), and the
    // workspace's own (joining changes what every member's tasks check out — and from then on
    // every task on the workspace needs write access on this repo too, which the other
    // members' owners never agreed to unless one of them is doing this).
    const members = await store.listWorkspaceRepos(workspace.id);
    const refused = (await refuseRepoPermissionHere(caller, repo, "admin")) ??
      (await refuseWorkspaceManagement(caller, members));
    if (refused) return refused;
    if (members.length >= MAX_REPOS) {
      return json(409, {
        error: `workspace "${workspace.name}" already holds ${MAX_REPOS} repos, the most a ` +
          "run can check out",
      });
    }

    // The read-then-write checks answer the common case with a clean 409 that names things;
    // the store answers the photo finish — it decides archived, full and taken again at the
    // write, and the path index throws on a raced duplicate path, caught below.
    const held = await store.findWorkspaceRepo(repo.id);
    if (held !== null) {
      const other = held.workspaceId === workspace.id
        ? "this workspace"
        : `workspace ${(await store.getWorkspace(held.workspaceId))?.name ?? held.workspaceId}`;
      return json(409, { error: `${repo.repoRef} already belongs to ${other}` });
    }
    const path = body.data.path ?? defaultPathFor(repo.repoRef);
    const clash = members.find((m) => m.path === path);
    if (clash !== undefined) {
      const taken = (await store.getConnectedRepo(clash.connectedRepoId))?.repoRef ??
        clash.connectedRepoId;
      return json(409, {
        error: `path "${path}" is already ${taken}'s in this workspace — pick another`,
      });
    }
    const at = nowIso();
    const member: WorkspaceRepo = {
      workspaceId: workspace.id,
      connectedRepoId: repo.id,
      ref: body.data.ref ?? null,
      path,
      description: body.data.description?.trim() ? body.data.description.trim() : null,
      createdAt: at,
      updatedAt: at,
    };
    let added;
    try {
      added = await store.addWorkspaceRepo(member, MAX_REPOS);
    } catch (err) {
      if (!isPathTaken(err)) throw err;
      return json(409, { error: `path "${path}" is already taken in this workspace` });
    }
    switch (added) {
      case "archived":
        return json(409, { error: "workspace is archived" });
      case "full":
        return json(409, {
          error: `workspace "${workspace.name}" already holds ${MAX_REPOS} repos, the most a ` +
            "run can check out",
        });
      case "taken":
        return json(409, { error: `${repo.repoRef} already belongs to a workspace` });
    }
    return json(201, await describeWorkspace(workspace, caller));
  };

  const updateWorkspaceRepo = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "workspaces:manage");
    if (denied) return denied;
    const workspace = await store.getWorkspace(params.id);
    if (!workspace) return json(404, { error: "no such workspace" });
    const members = await store.listWorkspaceRepos(workspace.id);
    const member = members.find((m) => m.connectedRepoId === params.connectedRepoId);
    if (member === undefined) return json(404, { error: "the repo is not in this workspace" });
    const body = await parseBody(req, UpdateWorkspaceRepoSchema);
    if (!body.ok) return body.res;
    // A member's path and description shape every run on the workspace, so editing one is
    // managing the workspace, not just that repo.
    const refused = await refuseWorkspaceManagement(caller, members);
    if (refused) return refused;
    const path = body.data.path ?? member.path;
    if (members.some((m) => m !== member && m.path === path)) {
      return json(409, { error: `path "${path}" is already taken in this workspace` });
    }
    const at = nowIso();
    const updated: WorkspaceRepo = {
      ...member,
      ref: body.data.ref === undefined ? member.ref : body.data.ref,
      path,
      description: body.data.description === undefined
        ? member.description
        : (body.data.description?.trim() ? body.data.description.trim() : null),
      updatedAt: at,
    };
    try {
      await store.saveWorkspaceRepo(updated);
    } catch (err) {
      if (!isPathTaken(err)) throw err;
      return json(409, { error: `path "${path}" is already taken in this workspace` });
    }
    await store.touchWorkspace(workspace.id, at);
    return json(200, await describeWorkspace(workspace, caller));
  };

  const removeWorkspaceRepo = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "workspaces:manage");
    if (denied) return denied;
    const workspace = await store.getWorkspace(params.id);
    if (!workspace) return json(404, { error: "no such workspace" });
    const members = await store.listWorkspaceRepos(workspace.id);
    const member = members.find((m) => m.connectedRepoId === params.connectedRepoId);
    if (member === undefined) return json(200, await describeWorkspace(workspace, caller)); // idempotent
    // Taking a repo out of a workspace needs admin on that repo — unless the repo is gone or
    // disconnected, where the removal is the fix and there is nothing left to gate on. The
    // `repos:manage-all` clears it as it clears managing the whole workspace (which could
    // archive it, releasing every member anyway), so `canManage` never offers a removal the
    // API then refuses.
    const repo = await store.getConnectedRepo(member.connectedRepoId);
    const privileged = caller.kind === "break-glass" || can(caller, "repos:manage-all");
    if (!privileged && repo !== null && repo.archivedAt === null) {
      const refused = await refuseRepoPermissionHere(caller, repo, "admin");
      if (refused) return refused;
    }
    await store.removeWorkspaceRepo(workspace.id, member.connectedRepoId);
    await store.touchWorkspace(workspace.id, nowIso());
    return json(200, await describeWorkspace(workspace, caller));
  };

  return [
    route("POST", "/v1/workspaces", createWorkspace),
    route("GET", "/v1/workspaces", listWorkspaces),
    route("GET", "/v1/workspaces/:id", getWorkspace),
    route("PATCH", "/v1/workspaces/:id", updateWorkspace),
    route("POST", "/v1/workspaces/:id/archive", archiveWorkspace),
    route("POST", "/v1/workspaces/:id/repos", addWorkspaceRepo),
    route("PATCH", "/v1/workspaces/:id/repos/:connectedRepoId", updateWorkspaceRepo),
    route("DELETE", "/v1/workspaces/:id/repos/:connectedRepoId", removeWorkspaceRepo),
  ];
}

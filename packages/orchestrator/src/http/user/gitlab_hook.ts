// A connected GitLab project's webhook, on its repo page: the URL and token a Maintainer pastes
// into GitLab, when a delivery was last admitted, and rotating the token.
//
// The token makes GitLab's deliveries for the project count, so it is shown only to a caller who
// manages repos here (`repos:manage`, as changing a repo's settings is) and is a Maintainer of
// that project, checked live — and only such a caller rotates it, which silences the hook until
// the new token is pasted. Rotating is how one who was shown it and has since been demoted loses
// it: the generation moves on, the URL and token the page then shows are new, and the forge
// refuses every delivery still carrying the old one.
// Bot mode only: a user-mode forge takes no webhooks.

import type { ConnectedRepo, GitlabProject } from "../../core/types.ts";
import type { GitlabMode, GitlabProjectListing } from "../../ports/forge.ts";
import { gitlabProjectRef } from "@ryph/forge/gitlab-account";
import type { Principal, WiredDeps } from "../app.ts";
import { refuseUnless } from "@ryph/auth/gates";
import { json, type Route, route } from "@ryph/shared/http";
import { repoConnections } from "./repo_connections.ts";
import { repoAccess } from "./repo_access.ts";

export function gitlabHookRoutes(deps: WiredDeps): Route[] {
  const { store, diag } = deps;
  const { gitlabModeHere, gitlabWebhookFor, placeGitlabRepo } = repoConnections(deps);
  const { refuseRepoPermissionHere } = repoAccess(deps);

  /** Every gate a webhook answer stands behind, or the refusal: a caller who manages repos, a
   * live GitLab repo with its project id recorded, a bot-mode forge, and the caller holding
   * Maintainer on it now. */
  const gated = async (
    req: Request,
    id: string,
  ): Promise<
    Response | { caller: Principal; repo: ConnectedRepo; held: GitlabProject; mode: GitlabMode }
  > => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:manage");
    if (denied) return denied;
    const repo = await store.getConnectedRepo(id);
    if (!repo) return json(404, { error: "no such connected repo" });
    if (repo.provider !== "gitlab") {
      return json(404, { error: `${repo.repoRef} is not a GitLab project` });
    }
    if (repo.archivedAt !== null) return json(409, { error: `${repo.repoRef} is disconnected` });
    if (!deps.gitlabConnect) return json(503, { error: "no GitLab is configured" });
    const mode = await gitlabModeHere();
    if (mode === undefined) {
      return json(502, { error: "the forge did not say how it acts on GitLab" });
    }
    if (mode === null) return json(503, { error: "no GitLab is configured" });
    if (mode.mode !== "bot") {
      return json(501, { error: "GitLab acts through a user token here; it takes no webhooks" });
    }
    const held = await store.getGitlabProject(repo.id);
    if (held === null) {
      return json(409, {
        error: `no GitLab project id is recorded for ${repo.repoRef} — connect it again`,
      });
    }
    // An id is GitLab's on one instance: a row connected on another names whatever project has
    // that id here, which nobody connected — no token, no read, no rename written back.
    if (held.instance !== mode.url) {
      return json(409, {
        error: `${repo.repoRef} was connected on the GitLab at ${held.instance}, not this one — ` +
          "connect it again",
      });
    }
    // Maintainer of the project by its id (`repo.forgeId`, the one `held` names), never of
    // whatever lives at the stored path now: a renamed project's old path can be anybody's.
    const refused = await refuseRepoPermissionHere(
      caller,
      { ...repo, forgeId: gitlabProjectRef(held.instance, held.projectId) },
      "admin",
    );
    if (refused) return refused;
    return { caller, repo, held, mode };
  };

  /** The webhook as it stands, read by the project's id — the path the repo was connected under
   * may have moved, and is brought up to date when it did. */
  const answer = async (
    repo: ConnectedRepo,
    held: GitlabProject,
    mode: GitlabMode,
  ): Promise<Response> => {
    let project: GitlabProjectListing | null;
    try {
      project = await deps.gitlabConnect!.describeGitlabProject(held.projectId);
    } catch (err) {
      diag.warn("gitlab.describe_failed", { repo: repo.repoRef, err: String(err) });
      return json(502, { error: "could not ask GitLab about that project" });
    }
    if (project === null) {
      return json(404, { error: `@${mode.login} cannot see ${repo.repoRef} on GitLab any more` });
    }
    await placeGitlabRepo(repo, project);
    try {
      return json(200, {
        webhook: await gitlabWebhookFor(project, held.hookGeneration),
        lastDeliveryAt: held.lastHookAt,
        lastMergeRequestDeliveryAt: held.lastMergeRequestHookAt,
        droppedComments: held.droppedCommentHookCount,
        droppedOtherEvents: held.droppedOtherHookCount,
        lastDroppedAt: held.lastDroppedHookAt,
      });
    } catch (err) {
      diag.warn("gitlab.hook_token_failed", { repo: repo.repoRef, err: String(err) });
      return json(502, { error: "the forge did not give the project's webhook token" });
    }
  };

  /** The webhook again — for a Maintainer who lost it, or is setting the hook up anew — and
   * when GitLab's last delivery — and last merge request event — at its current generation was
   * admitted (null: none yet). */
  const getGitlabHook = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const g = await gated(req, params.id);
    if (g instanceof Response) return g;
    return await answer(g.repo, g.held, g.mode);
  };

  /** Rotates the token: the next generation from now on, the old one refused by the forge's
   * next delivery. Answers the new webhook, to paste over the old one; no delivery is admitted
   * at it yet. */
  const rotateGitlabHook = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const g = await gated(req, params.id);
    if (g instanceof Response) return g;
    const rotated = await store.rotateGitlabHook(g.repo.id, deps.now().toISOString());
    if (rotated === null) return json(404, { error: "no such connected repo" });
    diag.warn("gitlab.hook_rotated", {
      connectedRepoId: g.repo.id,
      generation: rotated.hookGeneration,
      by: g.caller.kind === "user" ? g.caller.userId : g.caller.kind,
    });
    return await answer(g.repo, rotated, g.mode);
  };

  return [
    route("GET", "/v1/connected-repos/:id/gitlab-hook", getGitlabHook),
    route("POST", "/v1/connected-repos/:id/gitlab-hook/rotate", rotateGitlabHook),
  ];
}

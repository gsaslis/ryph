import type { ConnectedRepo, Task, ThinkingLevel, Workspace } from "../../core/types.ts";
import { supportsTools } from "../../core/harness_tools.ts";
import { openProgressComment } from "../../core/reaper.ts";
import { changeRequestCommandTarget, mergeTargetOf } from "../../core/thread_context.ts";
import { forgeRepoRef, runFacingRepoName } from "../../core/forge_repo.ts";
import { startTask, type StartTaskArgs, type StartTaskRepo } from "../../core/start_task.ts";
import { readTaskStartImages, type RunStartImage } from "../../core/attachments.ts";
import { startTaskDeps } from "../start_deps.ts";
import { raisesAbove, resolveRunLimits } from "../../core/run_limits.ts";
import { ENVIRONMENT_SETUP, SETUP_LIFETIME, setupTaskSpec } from "../../core/environment_setup.ts";
import { resolveWorkspace, singleRepoStart, workspaceStartRepos } from "../../core/workspaces.ts";
import { CreateTaskSchema, EnvironmentSetupSchema, MAX_PROMPT_BODY_BYTES } from "../../schema.ts";
import type { Principal, WiredDeps } from "../app.ts";
import { refuseUnless } from "@ryph/auth/gates";
import { json, parseBody, type Route, route } from "@ryph/shared/http";
import { scopeFor } from "../scope.ts";
import { POLICY, refuseOverCeiling } from "./agent_policies.ts";
import { repoAccess } from "./repo_access.ts";
import { repoConnections } from "./repo_connections.ts";

/** What a task records about how it was asked for: by a person, by a script or agent holding
 * one of their API tokens, or under break-glass. */
function originOf(caller: Principal): Task["origin"] {
  if (caller.kind !== "user") return "break-glass";
  return caller.via === "token" ? "token" : "user";
}

export function taskStartRoutes(deps: WiredDeps): Route[] {
  const { store, diag, config } = deps;
  const { refuseRepoPermissionHere } = repoAccess(deps);
  const { refreshGitlabPlace } = repoConnections(deps);

  // ---- tasks -------------------------------------------------------------

  const createTask = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "tasks:create");
    if (denied) return denied;
    const body = await parseBody(req, CreateTaskSchema, { maxBytes: MAX_PROMPT_BODY_BYTES });
    if (!body.ok) return body.res;

    const agent = await store.getAgent(body.data.agentId);
    if (!agent) return json(404, { error: "no such agent" });
    if (agent.archivedAt !== null) return json(409, { error: "agent is archived" });

    // The task's own limits: anyone may lower what the agent's policy allows, an admin may raise
    // up to the ceiling, and nobody past it. Judged here, at the one door a person types at.
    if (body.data.limits !== undefined) {
      const effective = resolveRunLimits(config.limits.ceiling, agent.limitPolicy);
      const over = refuseOverCeiling("limits", body.data.limits, config.limits.ceiling);
      if (over) return over;
      const raised = raisesAbove(body.data.limits, effective);
      if (raised !== null) {
        const refused = refuseUnless(
          caller,
          POLICY,
          `raising a task's ${raised} above the agent's limit`,
        );
        if (refused) return refused;
      }
    }

    // What the task checks out: a connected repo (a list of one) or a workspace (its saved
    // list). Either brings the live permission gate — "launch a task → write on EVERY repo it
    // checks out" — and the gateway the run clones through (refused in core when unset).
    let repos: StartTaskRepo[];
    let workspace: Workspace | undefined;
    if (body.data.connectedRepoId !== undefined) {
      const connectedRepo = await store.getConnectedRepo(body.data.connectedRepoId);
      if (!connectedRepo) return json(404, { error: "no such connected repo" });
      if (connectedRepo.archivedAt !== null) {
        return json(409, { error: "connected repo is disconnected" });
      }
      repos = singleRepoStart(connectedRepo, body.data.ref ?? connectedRepo.defaultBranch);
    } else {
      const checkout = await resolveWorkspace(store, body.data.workspaceId!);
      if (checkout.kind === "refused") return json(checkout.status, { error: checkout.error });
      workspace = checkout.workspace;
      repos = workspaceStartRepos(checkout.members);
    }
    for (const { connectedRepo } of repos) {
      const refused = await refuseRepoPermissionHere(caller, connectedRepo, "write");
      if (refused) return refused;
    }

    // A task on a change request — a re-run of a `/ryph` task, typically — checks out that
    // change request's head branch in its repo and pushes the commits back onto it. The branch
    // is asked of the forge now, under the same rules a thread command is held to (open, not
    // the default branch; a fork's as a fork's), never taken from the caller.
    const target = body.data.targetChangeRequest;
    let targetRepo: ConnectedRepo | null = null;
    /** The same target, under the forge's own address for the thread — filled in once it
     * resolves, and what everything past this block uses. */
    let targeted: { connectedRepoId: string; thread: string } | undefined;
    if (target !== undefined) {
      let entry = repos.find((r) => r.connectedRepo.id === target.connectedRepoId);
      if (entry === undefined) {
        return json(400, { error: "the change request's repo is not one the task checks out" });
      }
      targetRepo = entry.connectedRepo;
      if (!deps.forge) return json(503, { error: "the forge is not configured" });
      const fetched = await deps.forge.fetchThread(
        forgeRepoRef(entry.connectedRepo),
        { kind: "change_request", ref: target.thread },
      );
      if (fetched.kind === "gone") {
        return json(404, {
          error: `${entry.connectedRepo.repoRef} has no change request #${target.thread}`,
        });
      }
      if (fetched.kind === "unavailable") {
        return json(503, {
          error: "the forge did not answer about the change request — try again",
        });
      }
      // A fork's open pull request goes the way a `/ryph` in it does (`changeRequestCommandTarget`):
      // its head as the base repo serves it, marked `forkHead`, and its commits onto the fork's
      // branch where that is allowed or nowhere. Alone: a workspace's siblings stay out of it.
      // A GitLab repo's mode is not on its row (`forkPushRefusal`).
      const providers = entry.connectedRepo.provider === "gitlab"
        ? await deps.forge.providers().catch(() => undefined)
        : undefined;
      // The project's own merge request names where GitLab places it now, read by its id; a
      // row still naming another path learns the new one here — in user mode no webhook ever
      // says (bot mode hears it from the next delivery too). Fork or not is decided by the ids
      // either way (`ForgeChangeRequestHead.sameRepo`).
      const head = fetched.thread.changeRequest;
      if (
        entry.connectedRepo.provider === "gitlab" && head?.sameRepo === true &&
        head.headRepoRef !== entry.connectedRepo.repoRef
      ) {
        const placed = await refreshGitlabPlace(entry.connectedRepo, providers?.gitlab);
        if (placed !== entry.connectedRepo) {
          const was = entry;
          entry = { ...was, connectedRepo: placed };
          repos = repos.map((r) => r === was ? entry! : r);
          targetRepo = placed;
        }
      }
      const resolved = changeRequestCommandTarget(fetched.thread, entry.connectedRepo, providers);
      if (resolved.kind === "refused") return json(409, { error: resolved.why });
      const fork = resolved.fork;
      if (fork !== null && repos.length > 1) {
        return json(409, {
          error: `#${resolved.head.ref} is a pull request from a fork, whose head is checked ` +
            "out on its own: start the task on its repo rather than the workspace",
        });
      }
      // The FORGE's address for the thread from here on, not the caller's spelling of it:
      // Radicle resolves a unique PREFIX of a patch id, and a task recorded under the
      // abbreviation is one no later lookup by the full id would find.
      targeted = { connectedRepoId: target.connectedRepoId, thread: resolved.head.ref };
      // One run per change request, the same rule the forge intake and the runner's re-target
      // claim enforce — and for the same reason: two runs pushing onto one branch race at the
      // submit sweep, and the loser's push is rejected terminally while its thread still reads
      // as a success. A run that TARGETS the thread counts, however it came to (a `/ryph`, this
      // door, or a mid-run `checkout_change_request`).
      //
      // Check-then-write, and knowingly: two claims landing in the same instant can both pass.
      // Closing that needs a partial unique index over the live runs holding a thread, which is
      // a migration this change does not carry. The window is milliseconds wide and the loser's
      // patch is refused at the push rather than lost.
      const held = await store.findLiveRunOnChangeRequest(entry.connectedRepo.id, targeted.thread);
      if (held !== null) {
        return json(409, { error: `run ${held.id} is already working #${targeted.thread}` });
      }
      // Fully qualified, as the forge intake does it: a branch is whatever its author named it.
      repos = repos.map((r) =>
        r !== entry ? r : fork !== null
          ? {
            ...r,
            ref: fork.checkoutRef,
            targetRef: mergeTargetOf(resolved.head, true),
            forkHead: true,
          }
          : {
            ...r,
            ref: `refs/heads/${resolved.head.headRef}`,
            targetRef: mergeTargetOf(resolved.head),
          }
      );
    }

    // A re-run carries the images the task it re-runs started with: its instructions are that
    // task's, `[image N]` markers included, and a marker the agent cannot open is a task told
    // about a picture it never sees. Read under the caller's own read scope.
    let images: RunStartImage[] | undefined;
    if (body.data.rerunOf !== undefined) {
      const source = await store.getTask(
        body.data.rerunOf,
        await scopeFor(deps, caller, "tasks:read-all"),
      );
      if (source === null) return json(404, { error: "no such task to re-run" });
      const read = await readTaskStartImages(deps, source.id);
      if (read.kind === "refused") return json(read.status, { error: read.error });
      images = read.images;
    }

    // Everything from here — model resolution, minting, snapshots, persistence, launch — is
    // the shared path in core/start_task.ts, the same one the forge intake starts work through.
    const outcome = await startTask(startTaskDeps(deps), {
      agent,
      spec: {
        title: body.data.spec.title ?? null,
        instructions: body.data.spec.instructions ?? null,
      },
      ...(images === undefined || images.length === 0 ? {} : { images }),
      repos,
      ...(workspace === undefined ? {} : { workspace }),
      model: body.data.model,
      thinking: body.data.thinking,
      origin: originOf(caller),
      requestedByUserId: caller.kind === "user" ? caller.userId : null,
      ...(targeted === undefined ? {} : { targetChangeRequest: targeted }),
      ...(body.data.lifetime === undefined ? {} : { lifetime: body.data.lifetime }),
      ...(body.data.limits === undefined ? {} : { limits: body.data.limits }),
    });
    if (outcome.kind === "refused") {
      return json(outcome.status, { error: outcome.error, ...outcome.extra });
    }
    // Work on a change request lands ON it, where the forge adds no report of its own: the
    // progress comment is where the change request says a run is at work and who asked for it,
    // and where the final report lands — as it does for a `/ryph` command.
    if (targeted !== undefined && targetRepo !== null && deps.forge) {
      await openProgressComment(
        { store, forge: deps.forge, diag, now: deps.now, appUrl: config.appUrl },
        {
          repo: targetRepo,
          thread: { kind: "change_request", ref: targeted.thread },
          runId: outcome.runId,
          taskId: outcome.taskId,
          agentName: agent.name,
          state: outcome.state,
        },
      );
    }
    return json(201, { taskId: outcome.taskId, runId: outcome.runId, state: outcome.state });
  };

  /**
   * "Set up this repo's environment" (core/environment_setup.ts): a task the PLATFORM authors —
   * its instruction, its checkout (the repo, or the workspace, at its default refs) and its
   * long idle clock — for an agent the caller picks. Everything else is an ordinary
   * task's: whoever may start a task on these repos may start this one (write on every repo it
   * checks out, asked live), and its patches meet the repo's own submission policy. Refused where
   * environments are not built, because the loop it asks the agent to run — ship `.ryph/`, read
   * the build's result — would never close.
   */
  const setupEnvironment = async (
    caller: Principal,
    body: { agentId: string; model?: string; thinking?: ThinkingLevel },
    subject: { kind: "repo"; repo: ConnectedRepo } | { kind: "workspace"; id: string },
  ): Promise<Response> => {
    const service = deps.environments ?? null;
    if (service === null || !service.enabled) {
      return json(409, { error: "environments are off on this deployment (RYPH_ENVIRONMENTS)" });
    }
    if (service.refusedReason !== null) return json(409, { error: service.refusedReason });
    if (!deps.forge) return json(503, { error: "the forge is not configured" });
    if (config.gitGateway === null) {
      return json(503, {
        error: "connected repos need the git gateway (RYPH_GIT_GATEWAY_URL is unset)",
      });
    }
    const agent = await store.getAgent(body.agentId);
    if (!agent) return json(404, { error: "no such agent" });
    if (agent.archivedAt !== null) return json(409, { error: "agent is archived" });
    // The loop runs on the run's own tools — submit a patch, read the build's result — and a
    // harness that drives none cannot run it.
    if (!supportsTools(agent.harnessKind)) {
      return json(409, {
        error: `${agent.name}'s harness (${agent.harnessKind}) cannot use tools, and setting ` +
          "up an environment needs them: pick an agent on a harness that can",
      });
    }
    // And the loop ends in a patch of `.ryph/`, which an agent that may not open patches cannot
    // submit: it would hold a pod until its clock ran out.
    if (!agent.canOpenPatches) {
      return json(409, {
        error: `${agent.name} may not open patches, and setting up an environment ends in ` +
          "one: pick an agent that can",
      });
    }

    let repos: StartTaskRepo[];
    let workspace: Workspace | undefined;
    let workspaceInput: { name: string; memberPaths: string[] } | undefined;
    if (subject.kind === "repo") {
      if (subject.repo.archivedAt !== null) {
        return json(409, { error: "connected repo is disconnected" });
      }
      repos = singleRepoStart(subject.repo, subject.repo.defaultBranch);
    } else {
      const checkout = await resolveWorkspace(store, subject.id);
      if (checkout.kind === "refused") return json(checkout.status, { error: checkout.error });
      workspace = checkout.workspace;
      repos = workspaceStartRepos(checkout.members);
      workspaceInput = { name: workspace.name, memberPaths: repos.map((r) => r.path) };
    }
    for (const { connectedRepo } of repos) {
      const refused = await refuseRepoPermissionHere(caller, connectedRepo, "write");
      if (refused) return refused;
    }

    // The repo whose `.ryph/` the agent writes: the repo itself, or the workspace's environment
    // repo — the one whose Dockerfile the workspace's image is built from.
    const loaded = subject.kind === "repo"
      ? await service.loadSubject("repo", subject.repo.id)
      : await service.loadSubject("workspace", subject.id);
    if (loaded === null) return json(409, { error: "it has no connected repo to set up" });
    const envRepo = loaded.environmentRepo;
    let current: { ryph: boolean; dockerfile: boolean } | null = null;
    try {
      const read = await deps.forge.ryphTree(
        forgeRepoRef(envRepo.repo),
        envRepo.repo.url,
        envRepo.ref,
      );
      current = { ryph: read.tree !== null, dockerfile: read.dockerfile };
    } catch (err) {
      // The instruction reads the same either way, bar one sentence; the agent reads the repo.
      diag.debug("environments.setup_unreadable", {
        connectedRepoId: envRepo.repo.id,
        err: String(err),
      });
    }
    const args: StartTaskArgs = {
      agent,
      spec: setupTaskSpec({
        // The agent reads it: a local repository by its folder name, never its host path.
        repoRef: runFacingRepoName(envRepo.repo),
        path: envRepo.path,
        defaultBranch: envRepo.ref,
        current,
        services: { enabled: config.services.enabled, max: config.services.max },
        ...(workspaceInput === undefined ? {} : { workspace: workspaceInput }),
      }),
      repos,
      ...(workspace === undefined ? {} : { workspace }),
      model: body.model,
      thinking: body.thinking,
      origin: originOf(caller),
      requestedByUserId: caller.kind === "user" ? caller.userId : null,
      lifetime: SETUP_LIFETIME,
      purpose: ENVIRONMENT_SETUP,
    };
    const outcome = await startTask(startTaskDeps(deps), args);
    if (outcome.kind === "refused") {
      return json(outcome.status, { error: outcome.error, ...outcome.extra });
    }
    return json(201, { taskId: outcome.taskId, runId: outcome.runId, state: outcome.state });
  };

  const setupRepoEnvironment = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "tasks:create");
    if (denied) return denied;
    const body = await parseBody(req, EnvironmentSetupSchema);
    if (!body.ok) return body.res;
    const repo = await store.getConnectedRepo(params.id);
    if (!repo) return json(404, { error: "no such connected repo" });
    return await setupEnvironment(caller, body.data, { kind: "repo", repo });
  };

  const setupWorkspaceEnvironment = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "tasks:create");
    if (denied) return denied;
    const body = await parseBody(req, EnvironmentSetupSchema);
    if (!body.ok) return body.res;
    const workspace = await store.getWorkspace(params.id);
    if (!workspace) return json(404, { error: "no such workspace" });
    return await setupEnvironment(caller, body.data, { kind: "workspace", id: workspace.id });
  };

  return [
    route("POST", "/v1/tasks", createTask),
    route("POST", "/v1/connected-repos/:id/environment/setup", setupRepoEnvironment),
    route("POST", "/v1/workspaces/:id/environment/setup", setupWorkspaceEnvironment),
  ];
}

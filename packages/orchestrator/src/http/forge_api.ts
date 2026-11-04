// The forge surface: the HTTP surface spoken only by the forge gateway, authenticated by the
// shared RYPH_FORGE_TOKEN. It resolves a run's presented git credential to the grant the
// gateway acts on. Its own file, not a route inside runner_api, because it is a distinct trust
// surface — gateway-facing and token-authed — that also carries normalized webhook intake.
//
// This surface answers questions; it decides nothing the gateway could act on beyond the
// grant, and the gateway decides nothing at all — decisions live in this control plane,
// secrets and protocol live at the boundary.
//
// Invariants:
// - every failure to resolve is the same 404, whatever the reason (unknown token, expired,
//   revoked, run concluded): a distinct answer would tell a probing caller which credentials
//   have ever existed
// - the grant carries the task's ORIGINAL repo coordinates (the upstreams the gateway fetches
//   from), never the gateway-rewritten URLs frozen onto the WorkItem — two facts, two columns
// - the grant names the run's whole SET of connected repos; the gateway picks the member from
//   the URL, and a member outside the set is its 401 to give

import { isTerminal } from "../core/lifecycle.ts";
import { parseRyphCommand, RYPH_COMMAND_USAGE } from "../core/commands.ts";
import { openProgressComment } from "../core/reaper.ts";
import { startTask } from "../core/start_task.ts";
import { startTaskDeps } from "./start_deps.ts";
import {
  changeRequestCommandTarget,
  composeForgeFollowUp,
  composeForgeTask,
  forgeFollowUpImages,
  type ForkTarget,
  mergeTargetOf,
  withThreadImages,
} from "../core/thread_context.ts";
import { storeAttachments, takeBackAttachments } from "../core/attachments.ts";
import { requestApproval } from "../core/check_approvals.ts";
import { type MessageInput, postMessage, type PostOutcome } from "../core/inbox.ts";
import { onBranchUpdated } from "../core/branch_updated.ts";
import { syncOnPush } from "../core/skills_sync.ts";
import { resolveWorkspace, singleRepoStart, workspaceStartRepos } from "../core/workspaces.ts";
import type { StartTaskRepo } from "../core/start_task.ts";
import type {
  ConnectedRepo,
  ForgeEventOutcome,
  ForgeProvider,
  InboundForgeEvent,
  Workspace,
} from "../core/types.ts";
import { admitGitlabHook, recordGitlabHookDrops, reposNamedBy } from "../core/event_repos.ts";
import { settleChangeRequestEnd } from "../core/merge_settle.ts";
import { lineBasesOf } from "../core/landing.ts";
import type { ForgeChangeRequestHead, ForgeThreadContext } from "../ports/forge.ts";
import {
  commandTier,
  forgeIdOf,
  forgeName,
  forgeRepoRef,
  githubModeOf,
  tenantFitsMode,
} from "../core/forge_repo.ts";
import { makeServiceGate, mintId, sha256Hex } from "@ryph/sealed";
import { gitlabAccountId } from "@ryph/forge/gitlab-account";
import { forgeCapFor } from "../core/forge_tools.ts";
import type { ForgeScopeRepo, ForgeToolAction } from "../core/types.ts";
import { sameOrigin } from "../helpers/repo_url.ts";
import { normalizeBaseRef } from "@ryph/shared/refs";
import {
  ForgeEventSchema,
  ForgeToolActionCompleteSchema,
  ForgeToolActionReserveSchema,
  ForgeToolGrantResolveSchema,
  GitKeyResolveSchema,
  GitlabHookAdmitSchema,
  GitlabHookDroppedSchema,
} from "../schema.ts";
import type { WiredDeps } from "./app.ts";
import { json, parseBody, type Route, route } from "@ryph/shared/http";
import { serviceImageRoutes } from "./service_images.ts";
import { runOwnerMayAct } from "./run_owner.ts";

/** How long a forge-event claim may sit at "processing" before a redelivery adopts it — a
 * crashed handler's escape hatch. Well under the forge queue's total retry span. */
const PROCESSING_RECLAIM_MS = 5 * 60_000;
/**
 * How long after the forge received a push its change request's head may still read as the one
 * the push moved away from (`before`) and be taken for a forge read that lags: retried (503)
 * within it, stale past it. The mailroom retries from 10 s, doubling, so three minutes covers its
 * first four retries (10 + 20 + 40 + 80 s) — ample for a read that lags — and stays short of the
 * hold a head pushed back to `before` would otherwise put on the queue.
 */
const BEHIND_WINDOW_MS = 3 * 60_000;
/**
 * How far into a command's handling its image read may still run: the forge's event sink gives
 * the whole handler 60 s (EVENT_SINK_TIMEOUT_MS), and after the image read a start still stores
 * every image and launches the run. Below MIN_IMAGE_READ_MS of it left, the read is not worth
 * asking — the command runs without images rather than outliving its delivery.
 */
const IMAGE_READ_DEADLINE_MS = 40_000;
const MIN_IMAGE_READ_MS = 5_000;

/**
 * The subject a person an inbound event names is asked about on `provider`: their login — or, on
 * GitLab, their account id on the forge's instance (`gitlabAccountId`), never the login the event
 * carries, which its holder can give up and somebody else register. Null where GitLab's id is
 * not known (the forge read none, or its instance is unknown): a question about nobody, which
 * every caller answers "denied" without asking.
 */
function eventSubject(
  provider: ForgeProvider,
  person: { login: string; id?: string },
  gitlabUrl: string | null,
): string | null {
  if (provider !== "gitlab") return person.login;
  return person.id === undefined || gitlabUrl === null
    ? null
    : gitlabAccountId(gitlabUrl, person.id);
}

export function forgeRoutes(deps: WiredDeps, forgeToken: string): Route[] {
  const { store, diag, config } = deps;

  /** Where the forge's GitLab is now — a row connected on another instance is no event's. */
  const gitlabUrl = async (): Promise<string | null> => {
    const mode = deps.gitlabMode
      ? await deps.gitlabMode.get().catch(() => null)
      : await deps.forge?.providers().then((p) => p.gitlab).catch(() => null);
    return mode?.url ?? null;
  };
  const eventRepoDeps = { store, diag, now: deps.now, gitlabUrl };

  /**
   * The live connected repos an event names (core/event_repos.ts `reposNamedBy`): a GitLab one
   * by the project id its webhook was verified for, every other by `namesRepo`. A GitHub row
   * whose tenant does not fit the forge's mode is skipped (`tenantFitsMode`): after App → user
   * → App the newest live row by that name can be the user-mode leftover, which the forge
   * refuses.
   */
  const liveReposNamedBy = async (
    event: Pick<InboundForgeEvent, "repo">,
  ): Promise<ConnectedRepo[]> => {
    const mode = await githubModeOf(deps.githubMode);
    return (await reposNamedBy(eventRepoDeps, event))
      .filter((r) => r.archivedAt === null && tenantFitsMode(r, mode));
  };
  const liveRepoNamedBy = async (
    event: Pick<InboundForgeEvent, "repo">,
  ): Promise<ConnectedRepo | undefined> => (await liveReposNamedBy(event))[0];

  /** The service gate: the bearer must be the shared token. */
  const authenticated = makeServiceGate(forgeToken);

  const resolveGitKey = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parseBody(req, GitKeyResolveSchema);
    if (!body.ok) return body.res;

    const notFound = () => json(404, { error: "unknown key" });

    const tokenHash = await sha256Hex(body.data.token);
    const key = await store.getGitKeyByTokenHash(tokenHash);
    if (!key) return await resolveBuildKey(tokenHash);
    if (key.revokedAt !== null) return notFound();
    if (Date.parse(key.expiresAt) <= deps.now().getTime()) return notFound();

    // A credential that outlives its run resolves nothing: terminal runs (result landed,
    // cancelled, lost) answer exactly like an unknown key. This is what bounds a leaked
    // token even before revocation lands.
    const run = await store.getRun(key.runId);
    if (!run || isTerminal(run)) return notFound();
    const task = await store.getTask(run.taskId);
    if (!task) return notFound();

    // One member per repo of the task's checkout, each carrying the tenant whose credentials
    // may fetch its base: the installation that granted us that repo.
    //
    // Belt-and-braces on the origin, per member. Every task-creation path copies the URL off
    // the connected repo row rather than taking the caller's, so the two agree by construction;
    // if they ever stop agreeing, this is a live token pointed at a host the tenant never
    // vouched for, and it must not be sent. Degrade to anonymous and say so — never send it
    // anyway.
    const repos: Array<{
      connectedRepoId: string;
      url: string;
      ref: string;
      targetRef?: string;
      lineBases?: string[];
      branchNamespace: string;
      provider: string;
      repoRef: string;
      tenantId: string | null;
      forgeId?: string;
    }> = [];
    for (const entry of task.repos) {
      // A legacy entry (core/legacy.ts) never clones through the gateway.
      if (entry.connectedRepoId === null) continue;
      const connected = await store.getConnectedRepo(entry.connectedRepoId);
      // Disconnecting a repo takes it out of every live grant at the next resolve: the run
      // keeps its container, but the gateway stops fetching that upstream on the tenant's
      // behalf and stops taking patches for it. The key is resolved per request, so this is
      // immediate, without a revocation path of its own.
      if (!connected || connected.archivedAt !== null) continue;
      let tenantId: string | null = null;
      // The origin check is about a TENANT's credential: it refuses to mint a GitHub App
      // installation token for a URL the connected repo does not vouch for. A Radicle repo has
      // no tenant and no credential to mint — `installationId` is null by construction, and the
      // fetchable address is derived by the forge rather than stored on the row, so the two
      // never match and the check fired on every single resolve. A local repository has no
      // tenant either: the forge reads its own disk. Asked only where there is something to
      // answer it about.
      switch (connected.provider) {
        case "github":
          if (sameOrigin(connected.url, entry.url)) {
            tenantId = connected.installationId;
          } else {
            diag.warn("forge.git_key_origin_mismatch", {
              runId: run.id,
              connectedRepoId: entry.connectedRepoId,
            });
            // A repo connected in GitHub's user mode has no tenant to withhold: a null one is
            // how it is always addressed, and the forge acts on it with the one token it holds.
            // So "anonymous" cannot be spelled for it, and the member leaves the grant instead.
            if (connected.installationId === null) continue;
          }
          break;
        case "gitlab":
          // GitLab has no tenants: the forge acts with its one token, and presents it only to
          // the instance's own origin. A URL the row does not vouch for leaves the grant, as a
          // GitHub user-mode member's does.
          if (!sameOrigin(connected.url, entry.url)) {
            diag.warn("forge.git_key_origin_mismatch", {
              runId: run.id,
              connectedRepoId: entry.connectedRepoId,
            });
            continue;
          }
          tenantId = null;
          break;
        case "radicle":
        case "local":
          tenantId = null;
          break;
      }
      repos.push({
        connectedRepoId: entry.connectedRepoId,
        // The upstream truth from the task row — what the gateway fetches — not the
        // gateway-shaped URL frozen onto the WorkItem.
        url: entry.url,
        ref: entry.ref,
        // What the gateway refreshes beside the base, so the run can merge it to catch up.
        ...(entry.targetRef === undefined ? {} : { targetRef: entry.targetRef }),
        // And where each other line stands after its own merge (core/landing.ts `lineBase`),
        // which its runner fetches after that merge: refreshed beside them too.
        ...lineBasesOf(entry, task.landings, run.id),
        // The run's own: the task's entry names its first run's, never a later one's.
        branchNamespace: run.branchNamespace,
        // Which forge this repo lives on, and its address there: the gateway resolves the
        // adapter that mints its fetch credential from them.
        provider: connected.provider,
        repoRef: connected.repoRef,
        tenantId,
        // And a GitLab project's id, which the gateway fetches it by: its path may since have
        // been given up by a rename and taken by another project.
        ...forgeIdOf(connected),
      });
    }
    if (repos.length === 0) return notFound();

    diag.debug("forge.git_key_resolved", {
      runId: run.id,
      repos: repos.map((r) => `${r.connectedRepoId}${r.tenantId === null ? " (anonymous)" : ""}`),
    });
    return json(200, { runId: run.id, repos });
  };

  /**
   * A BUILD's key: the clone an environment build makes outside the build, through the same
   * gateway door a run's clone takes. The grant is the narrowest a clone needs — the build's
   * own checkouts, at the branches it builds, only while it is building — and it is shaped as a
   * run grant whose "run" is the environment: the gateway fetches for it exactly as for a run,
   * and nothing on the orchestrator side will ever take a patch from an id that is no run.
   */
  const resolveBuildKey = async (tokenHash: string): Promise<Response> => {
    const notFound = () => json(404, { error: "unknown key" });
    const environments = deps.environments;
    const key = environments ? await environments.store.getBuildGitKeyByTokenHash(tokenHash) : null;
    if (!environments || !key) return await resolveCheckKey(tokenHash);
    if (key.revokedAt !== null) return notFound();
    if (Date.parse(key.expiresAt) <= deps.now().getTime()) return notFound();
    const environment = await environments.store.getEnvironment(key.environmentId);
    if (!environment || environment.status !== "building") return notFound();
    const repos = [];
    for (const checkout of environment.plan.checkouts) {
      const connected = await store.getConnectedRepo(checkout.connectedRepoId);
      if (!connected || connected.archivedAt !== null) continue;
      repos.push({
        connectedRepoId: connected.id,
        url: connected.url,
        ref: checkout.ref,
        // A namespace no run owns: a bundle pushed under a build's key is filed against an id the
        // patch intake has no run for, and so becomes nothing.
        branchNamespace: `ryph-build/${environment.id}`,
        provider: connected.provider,
        repoRef: connected.repoRef,
        tenantId: connected.provider === "github" ? connected.installationId : null,
        ...forgeIdOf(connected),
      });
    }
    if (repos.length === 0) return notFound();
    diag.debug("forge.build_key_resolved", { environmentId: environment.id });
    return json(200, { runId: environment.id, repos });
  };

  /**
   * A CHECK POD's key: the clone step of one suite generation, the third class after a run's and
   * a build's. The grant names one repo and carries the CANDIDATE — the head commit and the
   * bundle intake filed it in — so the gateway serves that commit from a scratch repository
   * rather than the shared cache; and it resolves only while the generation it was minted for is
   * running (core/checks.ts `gitGrant`).
   */
  const resolveCheckKey = async (tokenHash: string): Promise<Response> => {
    const grant = await deps.checks?.gitGrant(tokenHash) ?? null;
    if (grant === null) return json(404, { error: "unknown key" });
    diag.debug("forge.check_key_resolved", { suiteId: grant.runId });
    return json(200, grant);
  };

  /**
   * The forge tool grant: which run the gateway said is calling, resolved to the forge scope
   * frozen onto it at startTask, narrowed by what is live — a concluded run, and a repo since
   * disconnected, grant nothing — plus the issues the run has opened, which an "origin" rule
   * lets it comment on. Every failure is the same 404, like the git key's: the forge's answer to
   * the agent is "the run is over", whichever reason it was.
   */
  const resolveToolGrant = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parseBody(req, ForgeToolGrantResolveSchema);
    if (!body.ok) return body.res;
    const notFound = () => json(404, { error: "no forge grant" });

    const run = await store.getRun(body.data.runId);
    if (!run || isTerminal(run) || run.forgeScope === null) return notFound();
    const scope = run.forgeScope;
    /** The live rows behind a frozen list: a repo renamed since the run started is still that
     * repo, and one disconnected since is gone from the grant. */
    const live = async (
      members: ReadonlyArray<{ connectedRepoId: string }>,
    ): Promise<ForgeScopeRepo[]> => {
      const out: ForgeScopeRepo[] = [];
      for (const member of members) {
        const connected = await store.getConnectedRepo(member.connectedRepoId);
        if (!connected || connected.archivedAt !== null) continue;
        out.push({
          connectedRepoId: connected.id,
          provider: connected.provider,
          repoRef: connected.repoRef,
          tenantId: connected.installationId,
          ...forgeIdOf(connected),
        });
      }
      return out;
    };
    const repos = await live(scope.repos);
    if (repos.length === 0) return notFound();
    // What the run checked out, resolved the same way. Not writable — it rides the grant so the
    // forge can read its visibility: a run holding private source may not write to a public repo,
    // and a policy naming its own repo list would otherwise hide the checkout from that rule.
    const sourceRepos = await live(scope.sourceRepos);
    const inScope = (id: string) => repos.some((r) => r.connectedRepoId === id);

    // The threads the run opened itself: the issues of its `create_issue` calls, and the change
    // requests its own patches opened through `submit_patch` (a patch that reached the forge
    // carries its change request as `forgeRef`). A run that stays around for feedback on its
    // pull request must be able to answer there. Under the forge's 10s grant cache, a pull
    // request opened a moment ago may take that long to become writable.
    const opened: Array<{ connectedRepoId: string; ref: string }> = [];
    const add = (connectedRepoId: string, ref: string) => {
      if (!inScope(connectedRepoId)) return;
      if (opened.some((o) => o.connectedRepoId === connectedRepoId && o.ref === ref)) return;
      opened.push({ connectedRepoId, ref });
    };
    for (const a of await store.listForgeToolActions(run.id)) {
      if (a.tool === "create_issue" && a.state === "done" && a.createdThreadRef !== null) {
        add(a.connectedRepoId, a.createdThreadRef);
      }
    }
    for (const p of await store.patchesForTask(run.taskId)) {
      if (p.runId === run.id && p.forgeRef !== null) add(p.connectedRepoId, p.forgeRef);
    }
    const workedChangeRequests = (scope.workedChangeRequests ?? []).filter((r) =>
      inScope(r.connectedRepoId)
    );
    return json(200, {
      runId: run.id,
      repos,
      sourceRepos,
      origin: scope.origin !== null && inScope(scope.origin.connectedRepoId) ? scope.origin : null,
      opened,
      ...(workedChangeRequests.length > 0 ? { workedChangeRequests } : {}),
      capabilities: scope.capabilities,
      provenance: scope.provenance,
    });
  };

  /**
   * Reserves one forge write against the run's cap — the ledger row the forge settles once it
   * knows how the write went. The capability and the repo are checked again here although the
   * forge checked them first: the cap is counted per tool, and a tool the scope never granted
   * has no cap to count against.
   */
  const reserveToolAction = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parseBody(req, ForgeToolActionReserveSchema);
    if (!body.ok) return body.res;
    const { runId, tool, connectedRepoId, threadRef } = body.data;

    const run = await store.getRun(runId);
    if (!run || isTerminal(run) || run.forgeScope === null) {
      return json(404, { error: "the run is over", code: "run_over" });
    }
    const connected = run.forgeScope.repos.some((r) => r.connectedRepoId === connectedRepoId)
      ? await store.getConnectedRepo(connectedRepoId)
      : null;
    if (!connected || connected.archivedAt !== null) {
      return json(403, { error: "that repo is not in the run's scope", code: "not_granted" });
    }
    const max = forgeCapFor(run.forgeScope.capabilities, tool);
    if (max === null) {
      return json(403, { error: `the run was not granted ${tool}`, code: "not_granted" });
    }
    const action: ForgeToolAction = {
      id: mintId("fa"),
      runId,
      tool,
      connectedRepoId,
      provider: connected.provider,
      repoRef: connected.repoRef,
      threadRef,
      state: "reserved",
      url: null,
      createdThreadRef: null,
      detail: null,
      createdAt: deps.now().toISOString(),
      completedAt: null,
    };
    if (!await store.reserveForgeToolAction(action, max)) {
      return json(409, {
        error: `this run has used all ${max} of its ${tool} actions`,
        code: "over_cap",
      });
    }
    diag.debug("forge.tool_action_reserved", { runId, tool, actionId: action.id });
    return json(201, { actionId: action.id });
  };

  /**
   * Settles a reserved write. Deliberately not refused for a concluded run: a write that
   * straddled the conclusion still happened or did not, and the trail should say which.
   */
  const completeToolAction = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parseBody(req, ForgeToolActionCompleteSchema);
    if (!body.ok) return body.res;
    const completedAt = deps.now().toISOString();
    const settled = await store.completeForgeToolAction(
      params.id,
      body.data.runId,
      body.data.outcome === "done"
        ? {
          state: "done",
          // "" means the forge has no web address for what was written — null, not an empty
          // string that would render as a broken link.
          url: body.data.url === "" ? null : body.data.url,
          createdThreadRef: body.data.createdThreadRef,
          detail: null,
          completedAt,
        }
        : {
          state: "failed",
          url: null,
          createdThreadRef: null,
          detail: body.data.detail,
          completedAt,
        },
    );
    if (!settled) return json(404, { error: "no such reserved action" });
    diag.debug("forge.tool_action_completed", {
      runId: body.data.runId,
      actionId: params.id,
      outcome: body.data.outcome,
    });
    return json(200, { ok: true });
  };

  /**
   * The command gate, one rule for every door that makes this deployment spend on someone's
   * word or someone's code: `commandTier` asked live (write on GitHub, delegacy on Radicle), and
   * on Radicle, where the tier is delegacy, the repo's command allowlist as the fallback a
   * delegate fills by hand. `unknown` is the forge's outage, never an answer.
   */
  const mayCommand = async (
    repo: ConnectedRepo,
    subject: string | null,
  ): Promise<"allowed" | "denied" | "unknown"> => {
    // Nobody to ask about (a GitLab person whose account id was not read): no command.
    if (subject === null) return "denied";
    const permission = await deps.forge!.checkPermission(
      forgeRepoRef(repo),
      { provider: repo.provider, subject },
      commandTier(repo.provider),
    );
    if (permission !== "denied") return permission;
    const allowlisted = repo.provider === "radicle" &&
      (await store.listRepoCommandAllowlist(repo.id))
        .some((e) => e.provider === repo.provider && e.subject === subject);
    if (!allowlisted) return "denied";
    diag.debug("forge_event.allowlisted", { repo: repo.repoRef, subject });
    return "allowed";
  };

  /**
   * The forge's question about a GitLab webhook delivery its mailroom verified, asked before it
   * stores a delivery and again before it reads GitLab: is the project connected, and is the
   * token's generation the current one (core/event_repos.ts `admitGitlabHook`)? The door can
   * verify a token but not know it was rotated; this is where a rotated one is refused.
   */
  const admitGitlabHookRoute = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parseBody(req, GitlabHookAdmitSchema);
    if (!body.ok) return body.res;
    const answer = await admitGitlabHook(
      eventRepoDeps,
      body.data.projectId,
      body.data.generation,
      body.data.heard,
    );
    if (answer.admission !== "current") {
      diag.debug("forge_event.gitlab_hook_refused", { ...body.data, admission: answer.admission });
    }
    return json(200, answer);
  };

  /**
   * The forge's report of GitLab deliveries its door dropped over a project's budget — answered
   * 202 so GitLab never counts them toward disabling the hook, and so never stored — counted on
   * the project's row for the repo page (core/event_repos.ts `recordGitlabHookDrops`). Batched
   * by the forge, so a flood costs a write a batch, not one per delivery.
   */
  const gitlabHookDroppedRoute = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parseBody(req, GitlabHookDroppedSchema);
    if (!body.ok) return body.res;
    const counted = await recordGitlabHookDrops(
      eventRepoDeps,
      body.data.projectId,
      body.data.generation,
      body.data.lane,
      body.data.count,
    );
    diag.warn("forge_event.gitlab_hook_dropped", { ...body.data, counted });
    return json(200, { counted });
  };

  /**
   * Normalized webhook intake — a /ryph command in a forge thread becomes a task. The
   * decision ladder answers 200 for every DECISION (started, refused, ignored — the forge's
   * queue must never retry a business verdict) and 5xx only when the question could not be
   * asked (GitHub outage mid-permission-check), where a retry genuinely helps.
   *
   * Idempotency: read-only rungs re-run harmlessly on a redelivery; every rung with a side
   * effect (a reply, a reaction, a run) sits behind `claimForgeEvent` — one conditional
   * insert on the delivery id, so a redelivery or a concurrent duplicate acts nothing twice.
   */
  const handleForgeEvent = async (req: Request): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parseBody(req, ForgeEventSchema);
    if (!body.ok) return body.res;
    const event = body.data;
    const nowIso = () => deps.now().toISOString();

    const eventRecord = (outcome: ForgeEventOutcome, taskId: string | null = null) => ({
      deliveryId: event.deliveryId,
      kind: event.kind,
      outcome,
      taskId,
      receivedAt: event.receivedAt,
      createdAt: nowIso(),
      claimedAt: null,
    });
    const concluded = async (outcome: ForgeEventOutcome, taskId: string | null = null) => {
      await store.recordForgeEvent(eventRecord(outcome, taskId));
      return json(200, { outcome });
    };

    /** Whether this delivery has a record the claim would refuse: a verdict, or a "processing"
     * claim still inside the reclaim window. */
    const alreadyDecided = async () => {
      const prior = await store.getForgeEvent(event.deliveryId);
      if (prior === null) return false;
      if (prior.outcome !== "processing") return true;
      const reclaimBefore = new Date(deps.now().getTime() - PROCESSING_RECLAIM_MS).toISOString();
      return prior.claimedAt === null || prior.claimedAt >= reclaimBefore;
    };

    // Answered, never recorded. Every comment on every connected repo reaches this rung, so a
    // row per delivery would put an unbounded write on the hottest path here. Nothing above it
    // has a side effect, so a redelivery re-decides for free — a dedupe row earns its keep only
    // once a rung can act. The log keeps "my comment did nothing" answerable.
    const noCommand = (why: string) => {
      diag.debug("forge_event.no_command", { deliveryId: event.deliveryId, kind: event.kind, why });
      return json(200, { outcome: "no-command" });
    };

    // A connected repo's default branch moved — GitHub's `push`, or the Radicle bridge watching
    // the canonical ref; either way only ever the DEFAULT branch. Two things follow, neither of
    // which needs a claim: the recorded default branch is corrected when the forge's differs
    // (it is set at connect time and nothing else refreshes it), and the environments hook is
    // told, which is idempotent by its own contract. Unrecorded, like `noCommand`, for GitHub
    // and Radicle: their pushes are rung by the forge itself, and a row per push buys no dedupe
    // the hook needs. GitLab's are recorded and answered from the record before anything reads
    // the forge: a GitLab delivery can be rung by any holder of the project's token, as often as
    // its budget allows, and its id names the commit GitLab says the branch is at, so a ring
    // again moves nothing (an `A → B → A` revert of the default branch is caught by the hourly
    // reconcile instead).
    if (event.kind === "branch.updated") {
      if (event.branch === undefined) return noCommand("a branch.updated without a branch");
      const branch = event.branch;
      const rungAtWill = event.repo.provider === "gitlab";
      if (rungAtWill && await alreadyDecided()) return json(200, { outcome: "deduped" });
      const repos = await liveReposNamedBy(event);
      if (repos.length === 0) {
        diag.debug("forge_event.branch_of_unconnected_repo", { deliveryId: event.deliveryId });
        return json(200, { outcome: "repo-not-connected" });
      }
      for (const listed of repos) {
        // Re-read right before the full-row write, so an edit that landed since the listing
        // (a policy change, an archive) is not written back over.
        let repo = await store.getConnectedRepo(listed.id) ?? listed;
        if (repo.archivedAt !== null) continue;
        if (repo.defaultBranch !== branch.ref) {
          diag.debug("forge_event.default_branch_changed", {
            connectedRepoId: repo.id,
            from: repo.defaultBranch,
            to: branch.ref,
          });
          repo = { ...repo, defaultBranch: branch.ref, updatedAt: nowIso() };
          await store.saveConnectedRepo(repo);
        }
        await onBranchUpdated(deps, { ...event, branch }, repo);
        // The org skills repo syncs on its pushes too. Started and never awaited: a slow read
        // must not hold the delivery, and a throw here would be a 5xx whose redelivery runs the
        // environments hook again. A sync that could not ask is a recorded failure, and the
        // hourly reconcile asks again.
        if (deps.skills) {
          const skills = deps.skills;
          syncOnPush(
            { skills, forge: deps.forgeSkills ?? null, diag, now: deps.now },
            repo.id,
            branch.ref,
          ).catch((err) =>
            diag.warn("forge_event.skills_sync_failed", {
              connectedRepoId: repo.id,
              err: String(err),
            })
          );
        }
      }
      if (rungAtWill) return await concluded("branch-updated");
      return json(200, { outcome: "branch-updated" });
    }

    // A re-run button on our check runs: a single run's ("Re-run") names the suite behind it and
    // the check, which runs with the suite's failures while its passes carry over; the whole
    // commit's ("Re-run all checks") names only the head, and every suite we posted there
    // re-runs in full. Either gains a generation. The re-run spends compute and can turn a blocked
    // merge green, so the one who pressed it must have write on the repo — the bar a person
    // re-running from the app clears — and the delivery is claimed first, so a redelivery
    // re-runs nothing twice.
    if (event.kind === "check_run.rerequested" || event.kind === "check_suite.rerequested") {
      const checkRun = event.kind === "check_run.rerequested" ? event.checkRun : undefined;
      const checkSuite = event.kind === "check_suite.rerequested" ? event.checkSuite : undefined;
      if (checkRun === undefined && checkSuite === undefined) {
        return noCommand(`a ${event.kind} without what it re-requests`);
      }
      const repo = await liveRepoNamedBy(event);
      if (repo === undefined) return await concluded("repo-not-connected");
      if (!deps.checks || !deps.forge) return await concluded("no-such-suite");
      // A redelivery asks the forge nothing (as for a command, below).
      if (await alreadyDecided()) return json(200, { outcome: "deduped" });
      const actor = eventSubject(
        repo.provider,
        { login: event.actorLogin, id: event.actorId },
        repo.provider === "gitlab" ? await gitlabUrl() : null,
      );
      const permission = actor === null ? "denied" : await deps.forge.checkPermission(
        forgeRepoRef(repo),
        { provider: repo.provider, subject: actor },
        "write",
      );
      if (permission === "unknown") {
        return json(503, { error: "could not verify the requester's access — retry later" });
      }
      if (permission === "denied") return await concluded("denied");
      const reclaimBefore = new Date(deps.now().getTime() - PROCESSING_RECLAIM_MS).toISOString();
      if (
        !await store.claimForgeEvent(
          { ...eventRecord("processing"), claimedAt: nowIso() },
          reclaimBefore,
        )
      ) {
        return json(200, { outcome: "deduped" });
      }
      let outcome: "checks-rerun" | "no-such-suite" = "no-such-suite";
      if (checkRun !== undefined) {
        outcome = await deps.checks.forgeRerequested({
          connectedRepoId: repo.id,
          headSha: checkRun.headSha,
          externalId: checkRun.externalId,
          deliveryId: event.deliveryId,
        });
      } else if (checkSuite !== undefined) {
        outcome = await deps.checks.forgeSuiteRerequested({
          connectedRepoId: repo.id,
          headSha: checkSuite.headSha,
          deliveryId: event.deliveryId,
        });
      }
      // Recorded either way, but a press that re-ran nothing is otherwise invisible.
      diag.debug("forge_event.rerequested", {
        deliveryId: event.deliveryId,
        kind: event.kind,
        outcome,
      });
      return await concluded(outcome);
    }

    // A change request's head or base moved — a GitHub pull request opened, reopened, pushed to
    // or retargeted; a Radicle patch's new revision. Its head is asked for checks exactly as a
    // patch's is, and the verdict posted there.
    //
    // The forge's LIVE state decides, never the event's: deliveries arrive late and out of order,
    // and neither forge's clock orders them (GitHub's is to the second, Radicle's is the
    // author's). So the change request's head is read first (`fetchChangeRequestHead`, the lean
    // read). Closed or gone: its push asks are withdrawn and nothing is filed — a late push to a
    // merged pull request runs nothing. The head compared is the AUTHOR's newest: anyone may add a
    // revision to a Radicle patch, and checks judge the code of the one whose change request it is
    // (on GitHub the two are one). Another head than this event's is stale — unless it is the one
    // this push moved away from (`before`), when the forge's read is behind this very event and a
    // retry is what fixes it. Otherwise the live base is the base. Once filed, the head is read
    // again before anything else is withdrawn: a slow delivery of an older head, handled after a
    // newer one, must not leave its stale head standing in place of the live one.
    //
    // A delivery already decided is answered from the record before the forge is asked
    // anything: GitLab names a merge request's delivery by the state GitLab answered (its head and
    // when it last changed), and any holder of the project's token can ring for that state again
    // as often as its budget allows — each ring would otherwise cost the reads and the gate below.
    //
    // Running it spends the operator's compute on code nobody here reviewed, so the command gate
    // (`mayCommand`) is asked of the change request's AUTHOR on every action — whose code it is —
    // and of the actor too when that is someone else: a maintainer reopening, retargeting or
    // updating a stranger's pull request must not make this deployment run the stranger's code.
    // On a change request ryph itself opened (`openedByUs`), the author is ryph's own identity
    // (the App, the node), which the gate would always refuse, so only the actor is asked there.
    // Live, with a forge outage a 503 for the mailroom to retry. A push that fails it runs
    // nothing by itself: its head waits for approval instead — a comment on the change request
    // links the app's approval page, where someone who may command agents here approves that
    // head once (core/check_approvals.ts); without an app address it is refused as before. A head one of our live patches carries on this change request is skipped: the
    // patch asked already, at birth. Unclaimed: every step is idempotent (the same head and base
    // again files nothing new and repairs its forge row), so a call that throws half way 500s
    // and the mailroom's retry finishes it.
    if (event.kind === "change_request.pushed") {
      const pushed = event.changeRequest;
      if (
        pushed === undefined || event.thread === null || event.thread.kind !== "change_request" ||
        event.thread.ref !== pushed.ref
      ) {
        return noCommand("a change_request.pushed without its change request");
      }
      if (await alreadyDecided()) return json(200, { outcome: "deduped" });
      const repo = await liveRepoNamedBy(event);
      if (repo === undefined) return await concluded("repo-not-connected");
      const checks = deps.checks;
      const forge = deps.forge;
      if (!checks?.changeRequests || !forge) return await concluded("checks-off");
      const behind = () =>
        json(503, { error: "the forge's read of the change request is behind — retry later" });
      const read = await forge.fetchChangeRequestHead(forgeRepoRef(repo), pushed.ref);
      if (read.kind === "unavailable") {
        return json(503, { error: "could not read the change request — retry later" });
      }
      const live = read.kind === "head" ? read.head : null;
      if (live === null || live.state !== "open") {
        await checks.changeRequestEnded({ connectedRepoId: repo.id, ref: pushed.ref });
        return await concluded("change-request-closed");
      }
      if (live.authorHeadSha !== pushed.headSha) {
        // Behind only for a while after the forge received the push: a change request pushed
        // back to an earlier head (A → B → A) makes the first event's `before` the live head for
        // good, and a 503 for ever would hold the forge's queue behind it.
        const received = Date.parse(event.receivedAt);
        const fresh = Number.isFinite(received) &&
          deps.now().getTime() - received < BEHIND_WINDOW_MS;
        if (fresh && pushed.before !== null && live.authorHeadSha === pushed.before) {
          return behind();
        }
        // Not the author's head, so no ask of it should stand either.
        await checks.changeRequestEnded({
          connectedRepoId: repo.id,
          ref: pushed.ref,
          onlyHead: pushed.headSha,
        });
        return await concluded("checks-stale");
      }
      const patch = await store.findPatchByRepoAndHead(repo.id, pushed.headSha);
      if (
        patch !== null && patch.state !== "superseded" && patch.state !== "rejected" &&
        (patch.forgeRef === null || patch.forgeRef === pushed.ref)
      ) {
        // A ryph run pushed onto this change request: its patch's own ask stands for the head,
        // and a push ask of an older head goes.
        await checks.changeRequestEnded({
          connectedRepoId: repo.id,
          ref: pushed.ref,
          exceptHead: pushed.headSha,
        });
        return await concluded("ryph-patch");
      }
      // By account id on GitLab, never the logins the event carries (`eventSubject`).
      const url = repo.provider === "gitlab" ? await gitlabUrl() : null;
      const subjects = new Set([
        ...(live.openedByUs
          ? []
          : [eventSubject(repo.provider, { login: pushed.author, id: pushed.authorId }, url)]),
        eventSubject(repo.provider, { login: event.actorLogin, id: event.actorId }, url),
      ]);
      let denied = false;
      for (const subject of subjects) {
        const permission = await mayCommand(repo, subject);
        if (permission === "unknown") {
          return json(503, { error: "could not verify the pusher's access — retry later" });
        }
        if (permission === "denied") {
          denied = true;
          break;
        }
      }
      if (denied) {
        // A repo that declares no checks has nothing to approve, and gets no comment.
        const declared = await checks.declaresChecks(repo.id, live.baseRef);
        if (declared === "unknown") {
          return json(503, { error: "could not read the repo's checks file — retry later" });
        }
        if (declared === "no") return await concluded("checks-none");
        // An outside contribution: someone who may command agents here approves its head on
        // the app's page the comment links (core/check_approvals.ts). A head approved before
        // runs as a trusted push's would.
        const approval = await requestApproval(
          { checks, forge, appUrl: config.appUrl, diag, now: deps.now },
          repo,
          {
            connectedRepoId: repo.id,
            ref: pushed.ref,
            headSha: pushed.headSha,
            baseRef: live.baseRef,
            fetchRef: pushed.fetchRef,
            url: pushed.url,
            author: pushed.author,
          },
        );
        if (approval === "off") return await concluded("denied");
        if (approval === "unavailable") {
          return json(503, { error: "could not post the approval comment — retry later" });
        }
        if (approval === "posting") {
          // Another delivery of this head is posting the comment; this retry finds it posted.
          return json(503, { error: "the approval comment is being posted — retry later" });
        }
        if (approval === "awaiting") return await concluded("checks-awaiting-approval");
      }
      const outcome = await checks.changeRequestPushed({
        connectedRepoId: repo.id,
        ref: pushed.ref,
        headSha: pushed.headSha,
        baseRef: live.baseRef,
        fetchRef: pushed.fetchRef,
        url: pushed.url,
      }, async () => {
        const again = await forge.fetchChangeRequestHead(forgeRepoRef(repo), pushed.ref);
        if (again.kind === "unavailable") return "unknown";
        // With the base it is open at now, which `changeRequestPushed` holds to this ask's.
        return again.kind === "head" && again.head.state === "open" &&
            again.head.authorHeadSha === pushed.headSha
          ? { live: again.head.baseRef }
          : "stale";
      });
      if (outcome === "unknown") {
        return json(503, { error: "could not read the change request again — retry later" });
      }
      return await concluded(
        outcome === "off"
          ? "checks-off"
          : outcome === "unchanged"
          ? "checks-unchanged"
          : outcome === "stale"
          ? "checks-stale"
          : "checks-requested",
      );
    }

    // A change request closing. If submitted patches of ours reached it — several can, when a
    // run pushed more onto an open one within one generation — EVERY one learns its fate. A close
    // settles each here, relays it to memory (a change per patch) and tells its run while the run
    // is alive to hear it. A merge is only RECORDED here (core/merge_settle.ts
    // `settleChangeRequestEnd`): the submit sweep judges each patch against the record — merged
    // when the merge holds its head, missed when it does not — lands, rules, cues and lets go of
    // the tasks that worked it, since containment may need the forge to fetch, and nothing here
    // waits on that. And the change request's push requests are withdrawn: a suite of its head
    // nobody else wants is cancelled, one that settled stays.
    //
    // Every step is a conditional write (core/merge_settle.ts `settleChangeRequestEnd`, which the
    // merge poll shares), so a redelivery, a concurrent delivery, a poll that read the same end,
    // or the Radicle bridge re-emitting a merge whenever the patch's object moves again repeats
    // nothing — and one that names a new head makes the record judge again what the older heads
    // missed. The answer is 200 once the merge is recorded.
    if (event.kind === "change_request.merged" || event.kind === "change_request.closed") {
      if (event.thread === null || event.thread.kind !== "change_request") {
        return noCommand("a change request event without a change request thread");
      }
      // Decided already (a redelivery, a GitLab ring for the same end again): nothing to settle.
      if (await alreadyDecided()) return json(200, { outcome: "deduped" });
      const [repo] = await reposNamedBy(eventRepoDeps, event);
      if (repo === undefined) return await concluded("repo-not-connected");
      return await concluded(
        await settleChangeRequestEnd(deps, repo, {
          kind: event.kind,
          ref: event.thread.ref,
          ...(event.merged === undefined ? {} : { merged: event.merged }),
        }),
      );
    }

    // Is this a command at all? Not-a-command is the common case (every comment on every
    // connected repo lands here) and it must stay cheap and silent. A command comes in a
    // thread's conversation, or inline on a line of a change request's diff — the same command
    // either way, save that the run is told which remark to answer in.
    if (
      (event.kind !== "issue_comment.created" && event.kind !== "review_comment.created") ||
      event.body === null || event.thread === null
    ) {
      return noCommand("not a comment carrying a body in a thread");
    }
    const inline = event.kind === "review_comment.created" ? event.inline ?? null : null;
    const thread = event.thread;
    const parsed = parseRyphCommand(event.body);
    if (parsed.kind === "none") return noCommand("no /ryph in the body");
    // When this command's handling began, for the one read whose deadline is what is left of
    // the event sink's (`readImages`).
    const commandStartedAt = performance.now();

    const repo = await liveRepoNamedBy(event);
    if (repo === undefined) return await concluded("repo-not-connected");

    if (!deps.forge) {
      // A forge event without a forge port is a wiring error, not a decision.
      return json(503, { error: "the forge is not configured on this orchestrator" });
    }
    const forge = deps.forge;

    // The threat model's first control: the commenter must be allowed to command agents here,
    // checked live. A "denied" answers with SILENCE — no reaction, no reply — so a drive-by
    // learns nothing. An "unknown" is a 503 WITHOUT recording the delivery: "unknown = denied"
    // is the stance for a forge's ANSWERS, never for its outages, and the queue redelivers
    // this once the forge speaks again — a blip must not silently swallow a legitimate
    // command.
    //
    // The tier asked for differs by forge, and `commandTier` is where the reason is written
    // down: GitHub's write access is a grant somebody deliberately made, Radicle's is not a
    // grant at all — a public repo is permissionless to contribute to, so asking for "write"
    // there would gate on nothing. Delegacy is the deliberate act on Radicle, and a delegate
    // who wants to let somebody else command agents adds them to the repo's command allowlist
    // by hand, which is the fallback below. The allowlist widens WHO MAY COMMAND and nothing
    // else: the contribution checks elsewhere — a workspace sibling's, say — still ask
    // `checkPermission("write")` and still get Radicle's permissionless answer.
    // Decided already: a redelivery, or a note rung again (GitLab's "Test → Comments", a token
    // holder's script) — answered from the record before the forge is asked anything, since the
    // two reads below are API calls on every ring and the claim further down would only dedupe
    // after them. Read-only, so it decides nothing the claim does not: a delivery absent here
    // still races for the claim, and a "processing" one past the reclaim window is let through
    // to adopt it.
    if (await alreadyDecided()) return json(200, { outcome: "deduped" });

    const permission = await mayCommand(
      repo,
      eventSubject(
        repo.provider,
        { login: event.actorLogin, id: event.actorId },
        repo.provider === "gitlab" ? await gitlabUrl() : null,
      ),
    );
    if (permission === "unknown") {
      return json(503, { error: "could not verify the commenter's access — retry later" });
    }
    if (permission === "denied") return await concluded("denied");

    // The thread itself, read BEFORE the claim and on purpose: this is the last read-only
    // rung, and a read-only rung re-runs for free on a redelivery. Below the claim it could
    // not — a handler that 503s after claiming leaves "processing" behind, and the
    // redelivery that would have fixed things is deduped away instead.
    //
    // `/ryph ada fix this` is the whole reason: "this" is the issue, and until this call
    // the agent had only the comment that named it. The instructions the agent finally
    // receives are the thread QUOTED as evidence plus the command as the ask — composed by
    // core/thread_context.ts, which is where that distinction is kept honest.
    //
    // Unconditional, including for a command too malformed to run. The alternative — fetch
    // only for a well-formed one — buys back one API call on a typo and costs an unreachable
    // "no thread" branch at the bottom of this handler, which is precisely the branch that
    // would silently reinstate context-free runs if anyone ever reordered the ladder.
    //
    // TEXT ONLY. The images are a second read (`readImages`), asked for once every gate below
    // has passed: an unlinked commenter, a typo'd handle, a busy thread and a redelivery of a
    // 5xx would otherwise each have the forge download up to MAX_ATTACHMENTS images — and ship
    // ~67 MiB of base64 back — for a command that runs nothing.
    const fetched = await forge.fetchThread(forgeRepoRef(repo), thread);
    if (fetched.kind === "unavailable") {
      // Same stance as an unanswerable permission check: an outage must not swallow a
      // legitimate command. Unrecorded, so the forge's queue redelivers.
      return json(503, { error: "could not read the thread — retry later" });
    }
    if (fetched.kind === "gone") {
      // Deleted or hidden between the comment and this call. Nothing left to read, and
      // nothing left to reply into either; no redelivery brings it back.
      diag.warn("forge_event.thread_gone", {
        deliveryId: event.deliveryId,
        repo: repo.repoRef,
        thread: thread.ref,
      });
      return await concluded("refused");
    }
    const threadContext = fetched.thread;

    // Every rung below has a side effect. One winner per delivery id, decided by the insert —
    // with the crash escape: a handler that died after claiming leaves "processing" behind,
    // and once that claim is older than the reclaim window, a redelivery (the forge's queue
    // retries a 5xx for well over five minutes) adopts it instead of being swallowed.
    const reclaimBefore = new Date(deps.now().getTime() - PROCESSING_RECLAIM_MS).toISOString();
    const claim = { ...eventRecord("processing"), claimedAt: nowIso() };
    if (!await store.claimForgeEvent(claim, reclaimBefore)) {
      return json(200, { outcome: "deduped" });
    }

    /**
     * The thread's images, read once nothing is left to refuse the command: the forge downloads
     * them (it has the egress and the credentials; a run has neither), the command's own
     * comment's first — or, `focusOnly`, that comment's and no others, for a follow-up to a
     * run that was handed the rest at its start.
     *
     * Below the claim, so it may not 503: a read that fails is a command with no images, said
     * in diag, never a redelivery. Its deadline is what is left of the event sink's 60 s after
     * the text read and the gates, and with too little left it is not asked at all. Null, too,
     * on a deployment with no attachment store, which would refuse a start carrying any.
     */
    const readImages = async (focusOnly: boolean): Promise<ForgeThreadContext | null> => {
      if (!deps.attachmentStore) return null;
      if (focusOnly && event.sourceCommentId === null) return null;
      const left = IMAGE_READ_DEADLINE_MS - (performance.now() - commandStartedAt);
      if (left < MIN_IMAGE_READ_MS) {
        diag.warn("forge_event.images_skipped", { deliveryId: event.deliveryId, leftMs: left });
        return null;
      }
      const read = await forge.fetchThread(forgeRepoRef(repo), thread, {
        images: { focus: event.sourceCommentId, ...(focusOnly ? { focusOnly: true } : {}) },
        timeoutMs: Math.round(left),
      });
      if (read.kind !== "thread") {
        diag.warn("forge_event.images_unread", { deliveryId: event.deliveryId, why: read.kind });
        return null;
      }
      return read.thread;
    };

    // Replies are best-effort: the verdict stands whether or not GitHub accepts the comment.
    const reply = async (text: string) => {
      try {
        await forge.postComment(forgeRepoRef(repo), thread, text);
      } catch (err) {
        diag.warn("forge_event.reply_failed", { deliveryId: event.deliveryId, err: String(err) });
      }
    };

    if (parsed.kind === "malformed") {
      await reply(`⚠️ ${parsed.problem} — usage: \`${RYPH_COMMAND_USAGE}\``);
      return await concluded("malformed-command");
    }

    // Resolved on the REPO's own forge, not the deployment's default one: an identity linked
    // on GitHub is not access on Radicle, and reading it as one would let a login on one forge
    // answer for a DID on the other. By the account's stable id where the forge read one
    // (GitLab): a login can be renamed and then taken by somebody else, who would otherwise
    // inherit the linked user of whoever held it first.
    const userIds = !deps.identityDirectory
      ? []
      : event.actorId !== undefined
      ? await deps.identityDirectory.userIdsForAccount(repo.provider, event.actorId)
      : await deps.identityDirectory.userIdsForLogin(repo.provider, event.actorLogin);
    if (userIds.length === 0) {
      // Safe to answer: the commenter already cleared the command gate above — write on
      // GitHub, delegacy or the repo's command allowlist on Radicle.
      await reply(
        `⚠️ ${event.actorLogin} has no linked ryph account — link your ` +
          `${forgeName(repo.provider)} identity in ryph first; commands run as the linked user.`,
      );
      return await concluded("no-linked-user");
    }
    if (userIds.length > 1) {
      // Attribution must not guess between users. Silent toward the thread; loud in diag.
      diag.warn("forge_event.ambiguous_identity", { login: event.actorLogin });
      return await concluded("ambiguous-identity");
    }
    // The command runs as that user, so the user must still be able to act: a deactivated
    // account keeps its linked identities, and a workspace's `local` siblings ask no forge
    // about anybody (below) — this is the one gate that stands for them. Worded as the missing
    // link is, because the thread may be public and whose account was switched off is not its
    // business.
    if (!(await deps.identityDirectory?.isActiveUser(userIds[0]) ?? false)) {
      diag.warn("forge_event.inactive_user", { login: event.actorLogin });
      await reply(
        `⚠️ ${event.actorLogin} has no active ryph account — commands run as the linked user.`,
      );
      return await concluded("no-linked-user");
    }
    // ...and the user's role must still let them start tasks, asked of their role as stored now:
    // a viewer has write on the repository often enough, and a `/ryph` is a task started, or a
    // run steered, in their name. Asked before the live run is looked up, so a follow-up into a
    // live run is refused the same as a start.
    if (!(await deps.identityDirectory?.mayStartTasks(userIds[0]) ?? false)) {
      diag.warn("forge_event.role_refused", { login: event.actorLogin });
      await reply(`⚠️ ${event.actorLogin}'s ryph role can't start tasks — ask an admin.`);
      return await concluded("denied");
    }

    const agent = await store.getAgentByHandle(parsed.handle);
    if (agent === null || agent.archivedAt !== null) {
      await reply(
        `⚠️ no agent answers to \`${parsed.handle}\` — usage: \`${RYPH_COMMAND_USAGE}\``,
      );
      return await concluded("no-such-agent");
    }

    // One thread, one run. A second `/ryph` while a run is still working here is either the
    // same agent being spoken to — a message, not a second container — or a different agent
    // being pointed at a branch somebody is already pushing onto.
    //
    // The second is refused OUT LOUD rather than queued or silently allowed: two runs on one
    // pull request race at the submit sweep, and the loser's push is rejected terminally
    // (`merge-base --is-ancestor` against a head that moved) while the thread still reads as a
    // success. A refusal the commenter can act on beats a run whose commits quietly never land.
    //
    // On a change request the question is asked the wider way: a run that checked this change
    // request out mid-flight is working it just as surely as one commanded from it, and its
    // commits go onto the same branch — so `/ryph` here reaches that run instead of starting a
    // second beside it. Its origin is still the conversation it was commanded from, which is why
    // the origin columns alone cannot answer. Issues keep the origin reading: nothing targets an
    // issue, and nothing pushes onto one.
    const held = thread.kind === "change_request"
      ? await store.findLiveRunOnChangeRequest(repo.id, thread.ref)
      : await store.findLiveRunByOrigin({
        kind: "forge",
        connectedRepoId: repo.id,
        threadKind: thread.kind,
        ref: thread.ref,
      });
    const noun = thread.kind === "change_request" ? "change request" : "issue";
    if (held !== null && held.agentId !== agent.id) {
      const holder = await store.getAgent(held.agentId);
      await reply(
        `⏳ ${holder?.name ?? "another agent"} is already working on this ${noun} — wait until ` +
          "that run finishes before asking someone else, so two runs cannot push onto the same " +
          "branch.",
      );
      return await concluded("thread-busy", held.taskId);
    }
    if (held !== null && !await runOwnerMayAct(deps, held)) {
      // The commenter is active (above), but the run acts for whoever started it, and that
      // user can no longer act in ryph: nothing more reaches the run on their behalf. Worded
      // without naming whose account it is, as the thread may be public.
      diag.warn("forge_event.run_owner_inactive", { runId: held.id });
      await reply("⚠️ the run working here can't take messages any more — ask an admin.");
      return await concluded("refused", held.taskId);
    }
    if (held !== null) {
      // The agent this command addresses, still live in this thread: the words reach the run
      // they were meant for, with everything it has already learned still in front of it.
      //
      // With the NEW comment's images and no others: the rest of the thread was handed over at
      // the start. Each is stored on the run first (one attachment per image, the inbox claims
      // them with the message), all or none (`storeAttachments` takes back what it stored when
      // one is refused). A run that went terminal meanwhile is skipped altogether: the fresh run
      // below reads the thread, images and all, again. A live run that would not keep them (its
      // unclaimed cap, no attachment store) gets the words without them — the comment rendered
      // with no images says in the text where each one was — and the thread is told.
      const own = event.sourceCommentId === null
        ? undefined
        : (await readImages(true))?.entries.find((e) => e.id === event.sourceCommentId);
      let followUp = forgeFollowUpImages(parsed.instructions, own);
      const stored = await storeAttachments(deps, held, followUp.images, "forge");
      let attachmentIds: string[] = [];
      let imagesDropped = false;
      if (stored.kind === "stored") {
        attachmentIds = stored.ids;
      } else {
        diag.warn("forge_event.image_unstored", {
          deliveryId: event.deliveryId,
          runId: held.id,
          status: stored.status,
          why: stored.error,
        });
        imagesDropped = stored.reason !== "terminal";
        followUp = forgeFollowUpImages(parsed.instructions, undefined);
      }
      const message: MessageInput = {
        kind: "user",
        sender: {
          kind: "forge",
          login: event.actorLogin,
          repoRef: repo.repoRef,
          thread: thread.ref,
          provider: repo.provider,
        },
        text: composeForgeFollowUp({
          instructions: followUp.instructions,
          actorLogin: event.actorLogin,
          repoRef: repo.repoRef,
          threadKind: thread.kind,
          threadRef: thread.ref,
          inline,
        }),
        attachmentIds,
      };
      const posted: PostOutcome = stored.kind === "refused" && stored.reason === "terminal"
        ? { kind: "refused", status: 409, error: stored.error, reason: "terminal" }
        : await postMessage(deps, held, message);
      if (posted.kind === "refused") await takeBackAttachments(deps, held.id, attachmentIds);
      if (posted.kind === "posted") {
        // 👀 on the new comment, the same acknowledgement a started run gives. No second
        // progress comment: the one the run already keeps is where its answer appears.
        if (event.sourceCommentId !== null) {
          try {
            await forge.addReaction(forgeRepoRef(repo), event.sourceCommentId, "eyes");
          } catch (err) {
            diag.warn("forge_event.reaction_failed", {
              deliveryId: event.deliveryId,
              err: String(err),
            });
          }
        }
        if (imagesDropped) {
          await reply(
            `⚠️ the run working this ${noun} got that comment's words but not its images: ` +
              "it already holds too many images waiting to be sent.",
          );
        }
        diag.debug("forge_event.joined", { deliveryId: event.deliveryId, runId: held.id });
        return await concluded("joined", held.taskId);
      }
      // Only ONE refusal may fall through, and it is worth being explicit about which:
      // `reason: "terminal"`, the run went terminal between the lookup and the post — never the
      // bare 409, which an image claimed elsewhere answers too. A 400 is the command being longer
      // than an inbox message may carry (MAX_MESSAGE_CHARS) — the run is alive and still working
      // this thread, so starting a second one is exactly the race the block above refuses out
      // loud: two runs pushing the same branch, the loser's push rejected terminally while the
      // thread still reads as a success. Say so instead, and let the commenter shorten it.
      if (posted.status === 400) {
        await reply(
          `⚠️ that command is too long to hand to the run already working this ${noun} — ` +
            "post it again, shorter (link a log rather than pasting it).",
        );
        return await concluded("refused", held.taskId);
      }
      // Any other refusal of a live run (an image another message claimed in the same instant)
      // is no reason for a second run either.
      if (posted.reason !== "terminal") {
        await reply(
          `⚠️ that command could not be handed to the run already working this ${noun} — ` +
            "post it again.",
        );
        return await concluded("refused", held.taskId);
      }
      // The run went terminal between the lookup and the post. Fall through and start a fresh
      // one: that is what the commenter asked for, and an ended run cannot answer it.
      diag.debug("forge_event.join_refused", {
        deliveryId: event.deliveryId,
        runId: held.id,
        why: posted.error,
      });
    }

    if (config.gitGateway === null) {
      await reply(
        "⚠️ this ryph deployment has no git gateway configured, so tasks cannot start " +
          "from a forge thread.",
      );
      return await concluded("refused");
    }

    // A change request is worked ON, not beside: the run checks out its head branch, and the
    // submit sweep pushes the run's commits back onto that branch (`targetChangeRequest`). An
    // issue keeps the old shape — the default branch, and a change request of its own.
    // A fork's pull request is worked on too: its head, as the base repo serves it, and pushed
    // back only where the fork allows it (`changeRequestCommandTarget`) — the target is set
    // either way, so the sweep never delivers the run's commits anywhere but that branch.
    let target: ForgeChangeRequestHead | null = null;
    let fork: ForkTarget | null = null;
    if (threadContext.kind === "change_request") {
      // A GitLab repo's mode is not on its row: the forge's answer says whether it may push to
      // a fork at all (`forkPushRefusal`). Unanswered, the forge refuses at push time.
      const providers = repo.provider === "gitlab"
        ? await forge.providers().catch(() => undefined)
        : undefined;
      const resolved = changeRequestCommandTarget(threadContext, repo, providers);
      if (resolved.kind === "refused") {
        // Said out loud: the commenter proved write access, and silence would read as a hang.
        await reply(`⚠️ ${resolved.why}`);
        return await concluded("refused");
      }
      target = resolved.head;
      fork = resolved.fork;
    }

    // The command's repo expands to the workspace holding it, when one does: the whole list is
    // checked out, with THIS repo at the thread's branch and the rest at the workspace's refs.
    // A repo in no workspace is a list of one, as it always was. The commenter's write access
    // is checked on every member — a partial checkout would be a surprise, and a refused task
    // names the repo. Deliberately "write" and NOT the command tier the gate above used: the
    // question here is "may this person's work land in that repo", which is what write means,
    // and on a public Radicle sibling the honest answer is yes for anyone. Having been let
    // through the command gate on the thread's repo is what earned the run; the siblings only
    // have to be repos the commenter could have contributed to themselves.
    //
    // Except for a fork's pull request: its run holds the contributor's code, and whatever that
    // code does runs with the run's git grant. It is checked out alone, so a private sibling is
    // neither cloned nor readable through the gateway, and no sibling's patch can come of it.
    const membership = fork !== null ? null : await store.findWorkspaceRepo(repo.id);
    let repos: StartTaskRepo[];
    let workspace: Workspace | undefined;
    if (membership === null) {
      repos = singleRepoStart(repo, target?.headRef ?? repo.defaultBranch);
    } else {
      const checkout = await resolveWorkspace(store, membership.workspaceId);
      if (checkout.kind === "refused") {
        await reply(`⚠️ ryph refused the task: ${checkout.publicError}`);
        return await concluded("refused");
      }
      workspace = checkout.workspace;
      repos = workspaceStartRepos(
        checkout.members,
        target === null ? null : { connectedRepoId: repo.id, ref: target.headRef },
      );
      // The reply lands in THIS repo's thread, which may be public, and a sibling may be
      // private: the answer names the workspace and never the sibling. Which repo it was is
      // on the workspace page, behind a login — where anyone who can fix their access can look.
      const siblings = `another repo of workspace "${checkout.workspace.name}"`;
      for (const member of checkout.members) {
        if (member.repo.id === repo.id) continue; // checked above, live
        // A local sibling has no forge to ask and nobody on it to ask about: `write` there is
        // subjectless (`refuseRepoPermission`), and the command runs as a linked ryph user.
        if (member.repo.provider === "local") continue;
        // The commenter as the sibling's OWN forge knows them: on the thread's forge, the actor
        // the event names; on another, whatever the linked ryph user (`userIds[0]`) linked
        // there — a GitHub login means nothing to GitLab, nor a GitLab account id to GitHub.
        // A Radicle sibling's `write` is subjectless, as `refuseRepoPermission`'s is.
        const actor = member.repo.provider === repo.provider
          ? eventSubject(
            repo.provider,
            { login: event.actorLogin, id: event.actorId },
            repo.provider === "gitlab" ? await gitlabUrl() : null,
          )
          : await deps.identityDirectory!.subjectFor(userIds[0], member.repo.provider);
        const subjectless = member.repo.provider === "radicle";
        if (actor === null && !subjectless && member.repo.provider !== repo.provider) {
          await reply(
            `⚠️ @${event.actorLogin} has no linked ${forgeName(member.repo.provider)} account, ` +
              `which ${siblings} is on — link your ${forgeName(member.repo.provider)} account ` +
              "in ryph first; permissions are checked live",
          );
          return await concluded("no-linked-user");
        }
        const access = actor === null && !subjectless ? "denied" : await forge.checkPermission(
          forgeRepoRef(member.repo),
          { provider: member.repo.provider, subject: actor },
          "write",
        );
        if (access === "unknown") {
          // Claimed already, so a 503 here would strand the delivery at "processing" until the
          // reclaim window. Concluding it as refused, out loud, is the honest answer: the
          // commenter can re-issue the command once the forge answers again.
          await reply(
            `⚠️ could not verify @${event.actorLogin}'s access to ${siblings} — try again shortly`,
          );
          return await concluded("refused");
        }
        if (access === "denied") {
          await reply(
            `⚠️ @${event.actorLogin} has no write access to ${siblings}, which it checks out ` +
              `alongside ${repo.repoRef} — see the workspace in ryph for its repos`,
          );
          return await concluded("denied");
        }
      }
    }
    // Fully qualified for a PR head: a branch is whatever its author named it, and
    // `refs/heads/` keeps a name that happens to start with `refs/` from reading as a ref.
    // A fork's head is the base repo's `refs/pull/<n>/head`, marked so that nothing about the
    // run is configured from it (`RepoEntry.forkHead`).
    if (target !== null) {
      repos = repos.map((r) =>
        r.connectedRepo.id !== repo.id ? r : fork !== null
          ? {
            ...r,
            ref: fork.checkoutRef,
            targetRef: mergeTargetOf(target, true),
            forkHead: true,
          }
          : { ...r, ref: `refs/heads/${target.headRef}`, targetRef: mergeTargetOf(target) }
      );
    }
    const commanded = repos.find((r) => r.connectedRepo.id === repo.id)!;

    // The thread quoted, the command as the ask, and the images the thread showed — marked where
    // they sat and checked already, so the start is never refused over one of them.
    const imaged = await readImages(false);
    const { images, ...spec } = composeForgeTask(
      imaged === null ? threadContext : withThreadImages(threadContext, imaged),
      {
        instructions: parsed.instructions,
        actorLogin: event.actorLogin,
        provider: repo.provider,
        repoRef: repo.repoRef,
        // The same branch and directory the run is launched with — passed rather than
        // assumed, because the prompt has to tell the agent where its commits will land.
        // A fork's head is the base repo's `pull/<n>/head`, never the fork's branch by name.
        checkoutRef: fork !== null
          ? normalizeBaseRef(fork.checkoutRef).localBranch
          : target?.headRef ?? commanded.ref,
        checkoutPath: commanded.path,
        alongside: repos.filter((r) => r !== commanded).map((r) => r.name),
        fork,
        inline,
        sourceCommentId: event.sourceCommentId,
      },
    );

    const outcome = await startTask(
      startTaskDeps(deps),
      {
        agent,
        spec,
        images: images.map((bytes) => ({ bytes, source: "forge" as const })),
        repos,
        ...(workspace === undefined ? {} : { workspace }),
        ...(target === null
          ? {}
          : { targetChangeRequest: { connectedRepoId: repo.id, thread: target.ref } }),
        origin: "forge",
        requestedByUserId: userIds[0],
        // The thread the command came from: where an "origin" forge policy lets the run write,
        // and what a later command in this thread finds to reach this run.
        originConversation: {
          kind: "forge",
          connectedRepoId: repo.id,
          threadKind: thread.kind,
          ref: thread.ref,
        },
      },
    );
    if (outcome.kind === "refused") {
      // A refusal can name the repo it is about — a sibling's unreadable services.yml, say —
      // and the thread may be public while the sibling is private.
      //
      // A refusal that SAYS which repo it is about, and says a sibling, is not relayed at all:
      // its text carries that repo's branch, its checkout path and its file, and substituting
      // spellings out of free text is a guess. The structured summary is repo-independent by
      // construction, so there is nothing left to leak. Everything else goes through the
      // substitution as before, which stays the backstop for text nobody scoped.
      const said = workspace === undefined ? outcome.error : (
        outcome.about !== undefined && outcome.about.connectedRepoId !== repo.id
          ? `another repo of workspace "${workspace.name}" ${outcome.about.summary}`
          : withoutSiblings(outcome.error, repos, repo.id, workspace.name)
      );
      await reply(`⚠️ ryph refused the task: ${said}`);
      return await concluded("refused");
    }

    // 👀 on the commanding comment, and the progress comment the sweeps will keep editing.
    // Best-effort both: the run exists, and un-creating it because GitHub balked at a
    // reaction would be absurd.
    if (event.sourceCommentId !== null) {
      try {
        await forge.addReaction(forgeRepoRef(repo), event.sourceCommentId, "eyes");
      } catch (err) {
        diag.warn("forge_event.reaction_failed", {
          deliveryId: event.deliveryId,
          err: String(err),
        });
      }
    }
    // Before the run has a word to say: a fork branch it cannot push to is the commenter's to
    // know now, not when a patch fails hours later.
    if (fork !== null && fork.cannotPush !== null) {
      // `cannotPush` never names the branch (`forkPushRefusal`): its name is the fork author's.
      await reply(
        `⚠️ ryph can't push to this pull request's branch in ${fork.headRepoRef}: ` +
          `${fork.cannotPush}. The run can review and test it, but its commits won't land anywhere.`,
      );
    }
    await openProgressComment(
      { store, forge, diag, now: deps.now, appUrl: config.appUrl },
      {
        repo,
        thread,
        runId: outcome.runId,
        taskId: outcome.taskId,
        agentName: agent.name,
        state: outcome.state,
      },
    );

    diag.debug("forge_event.started", {
      deliveryId: event.deliveryId,
      taskId: outcome.taskId,
      runId: outcome.runId,
    });
    await store.recordForgeEvent(eventRecord("started", outcome.taskId));
    return json(200, { outcome: "started", taskId: outcome.taskId, runId: outcome.runId });
  };

  return [
    route("POST", "/v1/forge/git-keys/resolve", resolveGitKey),
    route("POST", "/v1/forge/tool-grants/resolve", resolveToolGrant),
    route("POST", "/v1/forge/tool-actions", reserveToolAction),
    route("POST", "/v1/forge/tool-actions/:id", completeToolAction),
    route("POST", "/v1/forge/events", handleForgeEvent),
    route("POST", "/v1/forge/gitlab/hooks/admit", admitGitlabHookRoute),
    route("POST", "/v1/forge/gitlab/hooks/dropped", gitlabHookDroppedRoute),
    ...serviceImageRoutes(deps, "forge", authenticated),
  ];
}

/**
 * A refusal as a forge thread may read it: every sibling of the commanded repo — by full name
 * and by URL — becomes "another repo of workspace X". The reply lands in the commanded repo's
 * thread, which may be public, and a sibling may be private.
 */
export function withoutSiblings(
  text: string,
  repos: readonly StartTaskRepo[],
  commandedRepoId: string,
  workspaceName: string,
): string {
  const label = `another repo of workspace "${workspaceName}"`;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let said = text;
  for (const sibling of repos) {
    if (sibling.connectedRepo.id === commandedRepoId) continue;
    // The URL first: it contains the full name, and would otherwise be half-replaced.
    for (const spelling of [sibling.url, sibling.name]) {
      if (spelling === "") continue;
      said = said.replace(new RegExp(escape(spelling), "gi"), label);
    }
    // And the CHECKOUT PATH: a refusal can name a sibling by the directory it is cloned into
    // rather than by its full name, and that directory is the slugified repo name. Bounded by
    // word edges, because a path is a short label ("api", "web") that would otherwise match
    // inside ordinary words and turn the rest of the sentence to noise.
    if (sibling.path !== "") {
      said = said.replace(new RegExp(`\\b${escape(sibling.path)}\\b`, "gi"), label);
    }
  }
  return said;
}

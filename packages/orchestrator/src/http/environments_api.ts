// The environment surface: what the repo and workspace pages' Environment card reads, the full
// log of a build, and Rebuild. The card's
// other action, "Set up this repo's environment", starts a TASK and so lives with the task routes
// (http/user_api.ts), under their authorization.
//
// Invariants:
// - reading is any signed-in principal's, like reading a repo or a workspace; REBUILDING is an
//   admin's alone, like the egress allowlist and a size class — a build spends the operator's
//   money, and the forge has no opinion on who pays
// - the card's own route is a DATABASE READ and nothing else. What the forge has to be asked for
//   — what the default branch describes — is a second route the card streams in, because reading
//   a branch by name makes the forge fetch it from upstream: ~0.5s on a warm cache, seconds on a
//   cold one, and serialized behind whatever else is fetching that repo. A page must not wait on
//   that, and the card's five-second poll during a build must not pay it at all
// - the environment card speaks the user's vocabulary: an image, a commit, a Dockerfile. Its
//   definition read asks the forge for tree ids and yes/no. The services read beside it uses
//   the same parser and resolver as run startup, but returns only declaration summaries.
// - off is an answer, not an error: `enabled: false` with nothing built, so a page renders the
//   same shape on every deployment

import { can } from "@ryph/auth";
import type {
  ConnectedRepo,
  Environment,
  EnvironmentSubjectKind,
  Workspace,
} from "../core/types.ts";
import {
  type BuildKind,
  buildKindOf,
  byNewestBuilt,
  type EnvironmentSubject,
  typicalBuildMs,
} from "../core/environments.ts";
import { egressRefusalNote } from "../core/egress.ts";
import {
  type SetupWarning,
  setupWarningText,
  summarizeSetupWarning,
} from "../core/setup_warnings.ts";
import { forgeRepoRef } from "../core/forge_repo.ts";
import { parseServicesYaml } from "../helpers/services.ts";
import { forRuns, resolveServices } from "../core/services.ts";
import type { EnvironmentStatus } from "../core/types.ts";
import { decodeListCursor } from "../ports/task_store.ts";
import type { WiredDeps } from "./app.ts";
import { refuseUnless } from "@ryph/auth/gates";
import { scopeFor } from "./scope.ts";
import { json, type Route, route } from "@ryph/shared/http";

/** An environment as the card shows it: the record minus the build's internals (its plan, its
 * failure text rides the log tail). */
export interface EnvironmentView {
  id: string;
  subjectKind: EnvironmentSubjectKind;
  subjectId: string;
  ref: string;
  commits: Record<string, string>;
  /** The definition built: every member's `.ryph/` tree as one key. Null when none has one. */
  definition: string | null;
  baseDigest: string;
  harnessDigest: string;
  image: string | null;
  status: Environment["status"];
  toolchains: Record<string, string>;
  sizeBytes: number | null;
  trigger: Environment["trigger"];
  /** Why it was queued, in a sentence naming what was compared; null on older rows. */
  reason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  logTail: string | null;
  /**
   * Whether this build's machine came from the repo's own `.ryph/Dockerfile` rather than the
   * universal image. It decides what a failed build MEANS for a run, and the two answers are
   * opposite: a subject with a machine of its own has its runs wait for a build and refused when
   * that build failed (core/environment_resolve.ts), because the default image is the wrong
   * machine; one with only a `setup.yml` starts on the default image and never waits. The card
   * says which, and reads it from the record rather than asking the forge, so the fast route
   * stays a database read.
   */
  machine: boolean;
  /**
   * What the egress proxy refused this build, as a sentence naming the bundle an ADMIN could
   * allow each host with — null when it was refused nothing.
   *
   * On the view however the build ENDED, and that is the whole reason it is here. A build that
   * is refused a host usually still succeeds: a `RUN` step swallows the download's exit code,
   * the image settles `ready`, and the first person to learn that something is missing is
   * whoever's run fails on it days later, with nothing to connect the two. The card says it at
   * the moment it is knowable instead.
   */
  egressNote: string | null;
  /**
   * The repos whose setup.yml did not finish when this build baked it — a step failed, or the
   * file was invalid — or whose tree was put back (`discarded`, `dirty`), each with its kind, one
   * summary line and the end of the step's output (or the
   * parser's error). A build with these is still `ready` (setup is an optimization), which is
   * why the card must say them: the image lacks what the skipped steps would have done. Plain
   * text, repo-authored in part; empty when setup warned of nothing.
   */
  setupWarnings: Array<
    { path: string; kind: SetupWarning["kind"]; summary: string; detail: string }
  >;
  /** A full build, an incremental one on an earlier image, or a re-layer onto a new harness. */
  kind: BuildKind;
  /** How long this subject's builds of this kind usually take (`typicalBuildMs`), or null. */
  estimateMs: number | null;
}

/** A row as the card shows it; `history` is its subject's other builds, for the estimate. */
export function toEnvironmentView(
  environment: Environment,
  history: Environment[] = [],
): EnvironmentView {
  const kind = buildKindOf(environment);
  return {
    id: environment.id,
    subjectKind: environment.subjectKind,
    subjectId: environment.subjectId,
    ref: environment.ref,
    commits: environment.commits,
    definition: environment.definition,
    baseDigest: environment.baseDigest,
    harnessDigest: environment.harnessDigest,
    image: environment.image,
    status: environment.status,
    toolchains: environment.toolchains,
    sizeBytes: environment.sizeBytes,
    trigger: environment.trigger,
    reason: environment.reason ?? null,
    startedAt: environment.startedAt,
    finishedAt: environment.finishedAt,
    createdAt: environment.createdAt,
    machine: environment.plan.dockerfileFrom !== null,
    // A failure's reason leads its log, so the card can say why without a second fetch.
    logTail: environment.failure !== null && environment.status === "failed"
      ? `${environment.failure}\n${environment.logTail ?? ""}`.trimEnd()
      : environment.logTail,
    egressNote: egressRefusalNote(environment.egressRefusals ?? [], "build"),
    setupWarnings: (environment.setupWarnings ?? []).map((warning) => ({
      path: warning.path,
      kind: warning.kind,
      summary: summarizeSetupWarning(warning, "the build went on"),
      detail: setupWarningText(warning),
    })),
    kind,
    estimateMs: typicalBuildMs(history, kind),
  };
}

const newestFirst = (a: Environment, b: Environment) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

export function environmentRoutes(deps: WiredDeps): Route[] {
  const { store, diag } = deps;
  const service = deps.environments ?? null;
  const enabled = service !== null && service.enabled;

  /** What both cards share: the switch, the builder, why it cannot build, and the default
   * branch's newest ready image and newest build. */
  const card = async (kind: EnvironmentSubjectKind, id: string) => {
    let current: Environment | null = null;
    let latest: Environment | null = null;
    let history: Environment[] = [];
    if (service !== null) {
      history = await service.store.listEnvironmentsForSubject(kind, id);
      const defaults = history.filter((row) => row.defaultBranch).sort(newestFirst);
      current = defaults.filter((row) => row.status === "ready").sort(byNewestBuilt)[0] ?? null;
      latest = defaults.find((row) => row.status !== "superseded") ?? null;
    }
    return {
      enabled,
      builder: enabled ? service!.builderKind : null,
      refusedReason: enabled ? service!.refusedReason : null,
      current: current === null ? null : toEnvironmentView(current, history),
      latest: latest === null ? null : toEnvironmentView(latest, history),
    };
  };

  /**
   * The forge half of the card, on its own route because it is the slow one: what the subject's
   * default branch describes, as a yes/no pair — whether any member has a `.ryph/` at all, and
   * whether the environment repo's has a Dockerfile — and, for a workspace, the members whose
   * Dockerfile it passes over (two machines cannot be merged, so only the environment repo's
   * counts). It decides whether the card offers "Set up this repo's environment" prominently or
   * "Revise environment" quietly, and the card streams it in beside the facts it renders at once.
   *
   * One forge read per member, all at once (each is a different repo). Only the environment
   * repo's must answer: another member the forge cannot read is taken as describing nothing.
   *
   * `definition: null` is "there is nothing to ask": no forge on this deployment, environments
   * off, or a subject with no member to read. A forge that WAS asked about the environment repo
   * and could not answer is a 503, like Rebuild's — the card then says so quietly rather than
   * claiming the subject describes nothing, which would put the wrong offer in front of a person.
   */
  const definitionCard = async (
    kind: EnvironmentSubjectKind,
    id: string,
  ): Promise<Response> => {
    const forge = deps.forge;
    const subject = enabled ? await service!.loadSubject(kind, id) : null;
    if (!forge || subject === null) {
      return json(200, { definition: null, ignoredDockerfiles: [] });
    }
    const envRepoId = subject.environmentRepo.repo.id;
    const reads = await Promise.all(subject.members.map(async (member) => {
      try {
        const read = await forge.ryphTree(forgeRepoRef(member.repo), member.repo.url, member.ref);
        return { member, read };
      } catch (err) {
        diag.debug("environments.member_unreadable", {
          connectedRepoId: member.repo.id,
          err: String(err),
        });
        return { member, read: null };
      }
    }));
    const envRead = reads.find((r) => r.member.repo.id === envRepoId)!.read;
    if (envRead === null) {
      return json(503, {
        error: `the forge could not read ${subject.environmentRepo.repo.repoRef} — try again`,
      });
    }
    const definition = {
      ryph: reads.some((r) => r.read !== null && r.read.tree !== null),
      dockerfile: envRead.dockerfile,
    };
    const ignored = kind === "workspace"
      ? reads.flatMap(({ member, read }) =>
        member.repo.id !== envRepoId && read?.dockerfile === true ? [member.repo.repoRef] : []
      )
      : [];
    return json(200, { definition, ignoredDockerfiles: ignored });
  };

  const getRepoEnvironment = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    const repo = await store.getConnectedRepo(params.id);
    if (!repo) return json(404, { error: "no such connected repo" });
    return json(200, { ...(await card("repo", repo.id)), sizeClass: repo.sizeClass });
  };

  const getWorkspaceEnvironment = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "workspaces:read");
    if (denied) return denied;
    const workspace = await store.getWorkspace(params.id);
    if (!workspace) return json(404, { error: "no such workspace" });
    return json(200, {
      ...(await card("workspace", workspace.id)),
      sizeClass: workspace.sizeClass,
      environmentRepoId: workspace.environmentRepoId,
    });
  };

  const getRepoDefinition = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    const repo = await store.getConnectedRepo(params.id);
    if (!repo) return json(404, { error: "no such connected repo" });
    return await definitionCard("repo", repo.id);
  };

  // Declarations, not live containers. Summaries omit commands and environment values.
  const getRepoServices = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    const repo = await store.getConnectedRepo(params.id);
    if (!repo) return json(404, { error: "no such connected repo" });
    if (!deps.forge) return json(503, { error: "the forge is not available" });
    const file = await deps.forge.readServicesFile(
      forgeRepoRef(repo),
      repo.url,
      repo.defaultBranch,
    );
    if (file.kind === "unavailable") return json(503, { error: file.detail });
    if (file.kind === "invalid") return json(200, { state: "invalid", error: file.detail });
    if (file.kind === "absent") return json(200, { state: "none" });
    let declarations;
    try {
      declarations = parseServicesYaml(file.text);
    } catch (err) {
      return json(200, {
        state: "invalid",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const { config } = deps;
    // Judged as a run would be: a checks-only service never starts beside one, so it counts
    // toward no run's cap and shares no run's ports.
    const resolved = resolveServices(
      forRuns(declarations),
      (await deps.serviceCatalogue?.list()) ?? [],
      config.services,
      {
        RYPH_ORCHESTRATOR_URL: config.publicUrl,
        RYPH_GIT_ORIGIN: config.gitGateway?.url ?? null,
        RYPH_HISTORY_URL: config.runHistoryUrl,
      },
    );
    return json(200, {
      state: "declared",
      stale: file.stale,
      services: declarations.map(({ name, uses, image, port, checksOnly }) => ({
        name,
        source: uses ?? image!,
        port,
        checksOnly: checksOnly === true,
      })),
      // A valid declaration can still be refused by this deployment's policy.
      problem: resolved.kind === "refused" ? resolved.error : null,
    });
  };

  const getWorkspaceDefinition = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "workspaces:read");
    if (denied) return denied;
    const workspace = await store.getWorkspace(params.id);
    if (!workspace) return json(404, { error: "no such workspace" });
    return await definitionCard("workspace", workspace.id);
  };

  /** Rebuild: the default branch's head, now, even when an image of it exists. */
  const rebuild = async (
    subject: EnvironmentSubject | null,
    what: ConnectedRepo | Workspace,
  ): Promise<Response> => {
    if (!enabled) {
      return json(409, { error: "environments are off on this deployment (RYPH_ENVIRONMENTS)" });
    }
    if (service!.refusedReason !== null) return json(409, { error: service!.refusedReason });
    if (subject === null) {
      return json(409, {
        error: "archivedAt" in what && what.archivedAt !== null
          ? "it is archived"
          : "it has no connected member to build from",
      });
    }
    const envRepo = subject.environmentRepo.repo;
    let plan;
    try {
      plan = await service!.planFor(subject, envRepo.defaultBranch);
    } catch (err) {
      diag.warn("environments.rebuild_unreadable", { subjectId: subject.id, err: String(err) });
      return json(503, {
        error: `the forge could not read ${envRepo.repoRef} — try again`,
      });
    }
    if (plan.definition === null) {
      return json(409, {
        error: subject.members.length > 1
          ? "no member has a .ryph directory: its runs use the default image, and there is " +
            "nothing to build"
          : `${envRepo.repoRef} has no .ryph directory on ${envRepo.defaultBranch}: its runs ` +
            "use the default image, and there is nothing to build",
      });
    }
    const environment = await service!.enqueue({
      subject,
      ref: envRepo.defaultBranch,
      defaultBranch: true,
      checkouts: plan.checkouts,
      definition: plan.definition,
      dockerfile: plan.dockerfile,
      machine: plan.machine,
      trigger: "manual",
      force: true,
    });
    return json(202, { environment: toEnvironmentView(environment) });
  };

  const rebuildRepo = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const refused = refuseUnless(caller, "resources:manage", "rebuilding an environment");
    if (refused) return refused;
    const repo = await store.getConnectedRepo(params.id);
    if (!repo) return json(404, { error: "no such connected repo" });
    const subject = enabled ? await service!.loadSubject("repo", repo.id) : null;
    return await rebuild(subject, repo);
  };

  const rebuildWorkspace = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const refused = refuseUnless(caller, "resources:manage", "rebuilding an environment");
    if (refused) return refused;
    const workspace = await store.getWorkspace(params.id);
    if (!workspace) return json(404, { error: "no such workspace" });
    const subject = enabled ? await service!.loadSubject("workspace", workspace.id) : null;
    return await rebuild(subject, workspace);
  };

  /** One build as the card shows it — what a run waiting on it polls for its progress. */
  const getOne = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    const environment = service === null ? null : await service.store.getEnvironment(params.id);
    if (!environment) return json(404, { error: "no such environment" });
    const history = await service!.store.listEnvironmentsForSubject(
      environment.subjectKind,
      environment.subjectId,
    );
    return json(200, toEnvironmentView(environment, history));
  };

  /** The list's `state` filter, as build statuses. */
  const STATES: Record<string, readonly EnvironmentStatus[] | undefined> = {
    any: undefined,
    active: ["queued", "building"],
    ready: ["ready"],
    failed: ["failed"],
  };
  const LIST_PAGE = 50;
  const LIST_PAGE_MAX = 100;

  /**
   * Every build on this deployment the caller may see, newest first, each with what it was built
   * for in words: a repo's address or a workspace's name. `subject=repo:<id>` or
   * `workspace:<id>` narrows it to one.
   *
   * A default-branch build is anyone's, as on the subject's card. A BRANCH build was made for a
   * task, so it is read under the task rule (`scopeFor`): for whoever may write every repo it
   * checked out, and everything for `tasks:read-all`. A
   * workspace's builds take `workspaces:read` as well, as its card does.
   *
   * Rows are slimmer than the card's: no log tail and no definition key, as the list is re-read
   * every few seconds while anything builds. No estimate either: that reads each subject's
   * history, and the build's own page has it.
   */
  const listBuilds = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    const params = new URL(req.url).searchParams;
    const state = params.get("state") ?? "any";
    if (!Object.hasOwn(STATES, state)) {
      return json(400, { error: `unknown state "${state}"`, states: Object.keys(STATES) });
    }
    const limit = params.get("limit");
    if (limit !== null && (!/^\d{1,4}$/.test(limit) || Number(limit) < 1)) {
      return json(400, { error: "limit must be a whole number of rows" });
    }
    const cursor = params.get("cursor");
    if (cursor !== null && decodeListCursor(cursor) === null) {
      return json(400, { error: "cursor is not a cursor this surface issued" });
    }
    const subjectParam = params.get("subject");
    let subject: { kind: EnvironmentSubjectKind; id: string } | undefined;
    if (subjectParam !== null && subjectParam !== "") {
      const cut = subjectParam.indexOf(":");
      const kind = subjectParam.slice(0, cut);
      const id = subjectParam.slice(cut + 1);
      if (cut < 0 || (kind !== "repo" && kind !== "workspace") || id === "") {
        return json(400, { error: "subject is repo:<id> or workspace:<id>" });
      }
      subject = { kind, id };
    }
    if (service === null) return json(200, { builds: [], nextCursor: null });
    const seesWorkspaces = caller.kind === "break-glass" || can(caller, "workspaces:read");
    const [scope, repos, workspaces] = await Promise.all([
      scopeFor(deps, caller, "tasks:read-all"),
      store.listConnectedRepos(),
      store.listWorkspaces(),
    ]);
    const page = await service.store.listEnvironments({
      statuses: STATES[state],
      subject,
      subjectKinds: seesWorkspaces ? undefined : ["repo"],
      branchBuildsFor: scope.kind === "all" ? undefined : scope.writableRepoIds,
      cursor: cursor ?? undefined,
      limit: Math.min(LIST_PAGE_MAX, limit === null ? LIST_PAGE : Number(limit)),
    });
    const repoById = new Map(repos.map((r) => [r.id, r]));
    const workspaceById = new Map(workspaces.map((w) => [w.id, w]));
    return json(200, {
      builds: page.environments.map((environment) => {
        const repo = environment.subjectKind === "repo"
          ? repoById.get(environment.subjectId)
          : undefined;
        const workspace = environment.subjectKind === "workspace"
          ? workspaceById.get(environment.subjectId)
          : undefined;
        const { logTail: _tail, definition: _definition, ...build } = toEnvironmentView(
          environment,
        );
        return {
          build,
          subject: repo !== undefined
            ? { name: repo.repoRef, provider: repo.provider }
            : workspace !== undefined
            ? { name: workspace.name, provider: null }
            : null,
        };
      }),
      nextCursor: page.nextCursor,
    });
  };

  const getLog = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    const environment = service === null ? null : await service.store.getEnvironment(params.id);
    if (!environment) return json(404, { error: "no such environment" });
    const log = await service!.readLog(environment).catch((err) => {
      diag.warn("environments.log_unreadable", { environmentId: environment.id, err: String(err) });
      return null;
    });
    if (log === null) return json(404, { error: "this build has no log (yet)" });
    return new Response(log, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        // What a build printed is the repository's words, opened in a tab of its own: never let
        // a browser read it as anything else, as a check's log.
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  };

  return [
    route("GET", "/v1/connected-repos/:id/environment", getRepoEnvironment),
    route("GET", "/v1/connected-repos/:id/environment/definition", getRepoDefinition),
    route("GET", "/v1/connected-repos/:id/services", getRepoServices),
    route("POST", "/v1/connected-repos/:id/environment/rebuild", rebuildRepo),
    route("GET", "/v1/workspaces/:id/environment", getWorkspaceEnvironment),
    route("GET", "/v1/workspaces/:id/environment/definition", getWorkspaceDefinition),
    route("POST", "/v1/workspaces/:id/environment/rebuild", rebuildWorkspace),
    route("GET", "/v1/environments", listBuilds),
    route("GET", "/v1/environments/:id", getOne),
    route("GET", "/v1/environments/:id/log", getLog),
  ];
}

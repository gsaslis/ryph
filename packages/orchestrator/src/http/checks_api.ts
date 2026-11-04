// The checks surface: a suite as its page shows it (the forge's `details_url` and a Radicle job
// run's log link both point there), one check's full log, and Re-run;
// the checks page's three reads: the suites list, what runs now against the launch slots, and
// each repo's checks file on its default branch; and a person's ask from their own machine
// (`ryph checks`): a commit they pushed, or a bundle they upload, and the ask read back.
// The run page reads a task's suites through `getTask`, and the approval queue a patch's through
// `listPatches` (http/user_api.ts); the agent's two tools are runner routes (http/runner_api.ts).
//
// Invariants:
// - reading is a repo reader's AND someone `ChecksService.readable` lets in: a suite names a
//   run's unsubmitted commit and prints its code's output, so it is scoped like the run page
//   (`tasks:read-all`, or a task the caller can see) — a suite the caller cannot see is a 404,
//   exactly as an unknown one. A suite a runless ask wanted (a push to a change request, a
//   person's local ask) names no task: it is read by whoever may push to its repo, the bar for
//   putting that head there at all, and a local ask's by the person who asked. Never by
//   `repos:read` alone, which is every repo's at once, private ones included
// - a LOCAL ask spends the operator's compute on code nobody reviewed, from outside any run: it
//   takes `checks:request`, the live `write` permission on the repo a Re-run takes, and a person
//   (break-glass has nobody to quota or to show the suite to); then a per-person cap. The gates
//   run in that order, each before anything the next one reads, and the bundle route runs all of
//   them before a byte of the upload is read, with an hourly cap on uploads besides. A PUSHED
//   commit must be its branch's live head on the forge, read live: a commit named by id would
//   otherwise run whatever the forge's cache holds, a fork's included
// - RE-RUNNING spends the operator's compute on head code, and a re-run of a failed required
//   check can turn a blocked merge green — so it takes `patches:review` AND the live `write`
//   permission on the repo that approving a patch takes
// - a log is head-authored text: served as `text/plain` with sniffing off, never as HTML, and
//   bounded; the app renders it escaped
// - the lists are scoped the same way, in the store's query: a page holds only suites the caller
//   may read, so it is full whenever more match, and `askedBy` and `requestedBy` name only tasks
//   they can open — as the suite and the run page's `requestedBy` do
// - APPROVING an outside contribution's head (core/check_approvals.ts) runs code its author could
//   not: it takes `patches:review` AND the live tier commanding agents on the repo takes
//   — and READING one is a push suite's bar: whoever may push to its repo, or `tasks:read-all`.
//   Its link sits in a comment anyone can read on a public change request
// - off is an answer: without checks here every suite is a 404, exactly as an unknown one, and
//   every list is empty

import {
  CHECK_NAME,
  type CheckRequest,
  type CheckSuiteState,
  MAX_CHECKS,
} from "../core/check_types.ts";
import type { ChecksService, LocalChecksAnswer } from "../core/checks.ts";
import { approveChecks } from "../core/check_approvals.ts";
import type { CheckApproval } from "../core/check_types.ts";
import type { ConnectedRepo } from "../core/types.ts";
import { commandTier, fitsForge, githubModeOf, gitlabModeOf } from "../core/forge_repo.ts";
import {
  CheckDelegationIdSchema,
  CheckDelegationSchema,
  localBranchName,
  LocalChecksSchema,
} from "../schema.ts";
import { decodeListCursor } from "../ports/task_store.ts";
import type { Principal, WiredDeps } from "./app.ts";
import type { Scope } from "../core/scope.ts";
import { refuseUnless } from "@ryph/auth/gates";
import { json, parseBody, type Route, route } from "@ryph/shared/http";
import { refuseRepoPermission } from "./user_api.ts";
import { scopeFor } from "./scope.ts";

export function checksRoutes(deps: WiredDeps): Route[] {
  const noSuchSuite = () => json(404, { error: "no such check suite" });

  /** Whether the caller, under `scope`, may read the suite (`ChecksService.readable`). */
  const canSee = async (scope: Scope, suiteId: string): Promise<boolean> =>
    await deps.checks?.readable(suiteId, scope) ?? false;

  const getSuite = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    const scope = await scopeFor(deps, caller, "tasks:read-all");
    const view = await deps.checks?.view(params.id, scope) ?? null;
    if (view === null || !await canSee(scope, view.id)) return noSuchSuite();
    // Beside the suite, as the list has it: what the page names the suite by.
    const branch = await deps.checks?.branchOf(view.id) ?? null;
    return json(200, { suite: view, branch });
  };

  const getLog = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    const query = new URL(req.url).searchParams;
    const generation = Number(query.get("generation"));
    const check = query.get("check") ?? "";
    if (!Number.isInteger(generation) || generation < 1) {
      return json(400, { error: "generation: a suite generation, 1 or more" });
    }
    if (!CHECK_NAME.test(check)) return json(400, { error: "check: a check's name" });
    if (
      !deps.checks ||
      !await canSee(await scopeFor(deps, caller, "tasks:read-all"), params.id)
    ) return noSuchSuite();
    const log = await deps.checks.log(params.id, generation, check);
    if (log === null) return json(404, { error: "no log for that check" });
    return new Response(log, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        // What a check printed is the head's words: never let a browser read it as anything else.
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  };

  const rerun = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "patches:review", "re-running checks");
    if (denied) return denied;
    const checks = deps.checks;
    if (!checks) return noSuchSuite();
    const scope = await scopeFor(deps, caller, "tasks:read-all");
    const view = await checks.view(params.id, scope);
    if (view === null || !await canSee(scope, view.id)) return noSuchSuite();
    const repo = await deps.store.getConnectedRepo(view.connectedRepoId);
    if (repo === null || repo.archivedAt !== null) {
      return json(409, { error: "the suite's repo is no longer connected" });
    }
    const refused = await refuseRepoPermission(deps, caller, repo, "write");
    if (refused) return refused;
    const outcome = await checks.rerun(view.id, {
      kind: "user",
      userId: caller.kind === "user" ? caller.userId : "break-glass",
    });
    if (outcome.kind === "refused") return json(outcome.status, { error: outcome.why });
    // A suite whose services were refused re-runs as whatever the base resolves to now, which
    // may be a suite of its own.
    return json(200, { suite: await checks.view(outcome.suite.id, scope) });
  };

  /** The list's `state` filter, as suite states. */
  const STATES: Record<string, readonly CheckSuiteState[] | undefined> = {
    any: undefined,
    failing: ["failed", "error"],
    passed: ["passed"],
    active: ["waiting", "queued", "running"],
  };
  /** The list's `asked` filter, as request kinds: `push` a push to any change request, `forge`
   * any re-run, a person's or the forge's button, `local` a person's ask from their machine. */
  const ASKED: Record<string, readonly CheckRequest["kind"][] | undefined> = {
    anyone: undefined,
    tool: ["tool"],
    patch: ["patch"],
    push: ["push"],
    forge: ["rerun", "forge"],
    local: ["local"],
  };
  const LIST_PAGE = 50;
  const LIST_PAGE_MAX = 100;
  /** How many suites the running-now list shows at most: past the most pods that can run. */
  const ACTIVE_MAX = 50;

  const listSuites = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    const params = new URL(req.url).searchParams;
    const state = params.get("state") ?? "any";
    if (!Object.hasOwn(STATES, state)) {
      return json(400, { error: `unknown state "${state}"`, states: Object.keys(STATES) });
    }
    const asked = params.get("asked") ?? "anyone";
    if (!Object.hasOwn(ASKED, asked)) {
      return json(400, { error: `unknown asker "${asked}"`, asked: Object.keys(ASKED) });
    }
    const limit = params.get("limit");
    if (limit !== null && (!/^\d{1,4}$/.test(limit) || Number(limit) < 1)) {
      return json(400, { error: "limit must be a whole number of rows" });
    }
    const cursor = params.get("cursor");
    if (cursor !== null && decodeListCursor(cursor) === null) {
      return json(400, { error: "cursor is not a cursor this surface issued" });
    }
    if (!deps.checks) return json(200, { suites: [], nextCursor: null });
    const repo = params.get("repo");
    const page = await deps.checks.list({
      connectedRepoId: repo === null || repo === "" ? undefined : repo,
      states: STATES[state],
      askedBy: ASKED[asked],
      cursor: cursor ?? undefined,
      limit: Math.min(LIST_PAGE_MAX, limit === null ? LIST_PAGE : Number(limit)),
      scope: await scopeFor(deps, caller, "tasks:read-all"),
    });
    return json(200, { suites: page.items, nextCursor: page.nextCursor });
  };

  const listActive = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    const checks = deps.checks;
    if (!checks) return json(200, { active: [], capacity: { inUse: 0, total: 0 } });
    const scope = await scopeFor(deps, caller, "tasks:read-all");
    // Running first: a backlog of waiting suites, all newer, would otherwise push the ones on a
    // pod off the list.
    const [running, capacity] = await Promise.all([
      checks.list({ states: ["running"], limit: ACTIVE_MAX, scope }),
      // Every pod in use, the caller's or not: the slots are the deployment's.
      checks.capacity(),
    ]);
    const room = ACTIVE_MAX - running.items.length;
    const waiting = room === 0
      ? []
      : (await checks.list({ states: ["waiting", "queued"], limit: room, scope })).items;
    return json(200, { active: [...running.items, ...waiting], capacity });
  };

  const listRepos = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    const checks = deps.checks;
    if (!checks) return json(200, { repos: [] });
    // Every connected repo a repo reader sees, as the repos list shows them; `?repo=` narrows it
    // to one, by id, for its own page: each answer reads every file it lists off the forge.
    const only = new URL(req.url).searchParams.get("repo");
    const repos = (await deps.store.listConnectedRepos()).filter((r) =>
      r.archivedAt === null && (only === null || r.id === only)
    );
    const scope = await scopeFor(deps, caller, "tasks:read-all");
    const [files, latest] = await Promise.all([
      checks.declaredOnDefault(repos),
      // The newest run of every check judged by the file shown, that the caller may read.
      Promise.all(
        repos.map((repo) =>
          checks.latest({ connectedRepoId: repo.id, checksRef: repo.defaultBranch, scope })
        ),
      ),
    ]);
    return json(200, {
      repos: repos.map((repo, i) => ({
        connectedRepoId: repo.id,
        repoRef: repo.repoRef,
        provider: repo.provider,
        defaultBranch: repo.defaultBranch,
        file: files[i],
        latest: latest[i],
      })),
    });
  };

  // ---- local asks ----------------------------------------------------------

  const localOff = () => json(404, { error: "local check asks are off here" });

  /**
   * A connected repo by its id, or by its address on its forge — case-blind on GitHub and
   * GitLab, which are — preferring one still connected. By address, a row the forge cannot act
   * on as it runs now is skipped (`fitsForge`): a GitHub leftover of the other mode, or a GitLab
   * row connected on another instance, is refused by the forge, and may well be the newest. An id names one row, and is taken as it is.
   *
   * `owner/name` can be a GitHub repo and a GitLab project at once, so when it names repos on
   * two forges the host the caller's remote is on (`?host=`) breaks the tie: github.com (or
   * ssh.github.com) is GitHub, the deployment's GitLab host is GitLab, ports aside. The host only
   * ever breaks a tie: a remote reaches its forge by names ryph cannot know (an ssh alias, ssh on
   * another port, a clone host other than the instance URL's), so an address on one forge is
   * that forge's whatever the host. One a host cannot tell apart is `ambiguous`, never a guess:
   * the wrong one would run its checks.
   */
  const repoNamed = async (
    named: string,
    host: string | null,
  ): Promise<ConnectedRepo | null | { ambiguous: string[] }> => {
    const github = await githubModeOf(deps.githubMode);
    const gitlab = deps.gitlabMode
      ? await deps.gitlabMode.get().catch(() => undefined)
      : await gitlabModeOf(deps.forge, deps.now().getTime());
    let matches = (await deps.store.listConnectedRepos()).filter((r) =>
      r.id === named ||
      (fitsForge(r, github, gitlab) &&
        (r.provider === "github" || r.provider === "gitlab"
          ? r.repoRef.toLowerCase() === named.toLowerCase()
          : r.repoRef === named))
    );
    const byId = matches.find((r) => r.id === named);
    if (byId) return byId;
    const providersOf = () => [...new Set(matches.map((r) => r.provider))].sort();
    if (host !== null && providersOf().length > 1) {
      const provider = host === "github.com" || host === "ssh.github.com"
        ? "github"
        : host === await gitlabHost()
        ? "gitlab"
        : null;
      if (provider !== null) matches = matches.filter((r) => r.provider === provider);
    }
    const providers = providersOf();
    if (providers.length > 1) return { ambiguous: providers };
    return matches.find((r) => r.archivedAt === null) ?? matches[0] ?? null;
  };

  /** The deployment's GitLab hostname, lower-cased and without a port, as the forge says it;
   * null when it runs no GitLab or cannot say. */
  const gitlabHost = async (): Promise<string | null> => {
    const url = (await deps.forge?.providers().catch(() => undefined))?.gitlab?.url;
    return url === undefined ? null : new URL(url).hostname.toLowerCase();
  };

  /** `?host=`: the hostname the caller's remote is on, lower-cased and without a port (ssh and
   * https reach one forge on different ports); null when not said. */
  const hostOf = (req: Request): string | null => {
    const host = (new URL(req.url).searchParams.get("host") ?? "").trim().toLowerCase()
      .replace(/^\[([^\]]*)\](?::\d*)?$/, "$1").replace(/^([^:]*):\d*$/, "$1");
    return host === "" ? null : host;
  };

  /** The answer to an address on more than one forge. */
  const ambiguousRepo = (named: string, providers: string[]) =>
    json(409, {
      error: `${named} is connected on ${providers.join(" and ")}: ask from a clone whose ` +
        "remote is on one of them, or name the repo by its id",
    });

  /**
   * Every gate a local ask passes before anything is filed, in order: the capability, checks
   * and local asks on here, the repo connected, the caller's live write on it, a person, and
   * room under their cap on another branch. Answers the refusal, or what the ask is about.
   */
  const gateLocal = async <T extends { repo: string; branch: string; delegationId?: string }>(
    req: Request,
    named: () => Promise<T | Response>,
    opts: { upload?: boolean; delegated?: boolean } = {},
  ): Promise<
    | Response
    | {
      caller: Extract<Principal, { kind: "user" }>;
      checks: ChecksService;
      repo: ConnectedRepo;
      branch: string;
      ask: T;
    }
  > => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "checks:request", "asking for checks");
    if (denied) return denied;
    const checks = deps.checks;
    if (opts.delegated && checks?.remote) {
      return json(409, {
        error: "this instance delegates checks elsewhere; delegation chains are not supported",
      });
    }
    if (!checks || !checks.local) return localOff();
    const ask = await named();
    if (ask instanceof Response) return ask;
    const repo = await repoNamed(ask.repo, hostOf(req));
    if (repo === null) return json(404, { error: "no such repo" });
    if ("ambiguous" in repo) return ambiguousRepo(ask.repo, repo.ambiguous);
    if (repo.archivedAt !== null) {
      return json(409, { error: `${repo.repoRef} is no longer connected` });
    }
    const refused = await refuseRepoPermission(deps, caller, repo, "write");
    if (refused) return refused;
    if (caller.kind !== "user") {
      return json(403, { error: "a local check ask needs a person: sign in, or use their token" });
    }
    const branch = ask.branch.replace(/^refs\/heads\//, "");
    const quota = await checks.localQuota(caller.userId, repo.id, branch, ask.delegationId);
    if (quota.live >= quota.max) return quotaRefusal(quota);
    if (opts.upload) {
      // Recorded before it is counted, and counted before the body is read: a bundle the forge
      // refuses still counts, uploads side by side cannot all slip under the cap, and a refusal
      // here takes its own attempt back.
      const uploads = await checks.claimLocalUpload(caller.userId, repo.id);
      if (!uploads.ok) {
        return json(429, {
          error:
            `you have uploaded ${uploads.used} bundles in the last hour, the most one person ` +
            "may (RYPH_CHECKS_LOCAL_UPLOADS_PER_HOUR); push the branch to ask about it instead",
        });
      }
    }
    return { caller, checks, repo, branch, ask };
  };

  const quotaRefusal = (quota: { live: number; max: number }) =>
    json(429, {
      error: `you have ${quota.live} local check asks still going, the most one person may ` +
        "(RYPH_CHECKS_MAX_LOCAL_PER_USER); one frees up as its suite settles",
    });

  /** A request as the client reads it: its state, the suite it joined, and why it was refused
   * or is still being read, when it says. */
  const requestView = (request: CheckRequest) => ({
    id: request.id,
    state: request.state,
    suiteId: request.suiteId,
    ...(request.note === null ? {} : { reason: request.note }),
  });

  /** What an ask answers: the suite once it is named (201), the request while it is read at
   * the base (202), the refusal when the base says no (422). */
  const answerLocal = async (
    answer: LocalChecksAnswer,
    caller: Principal,
    checks: ChecksService,
  ): Promise<Response> => {
    if (answer.kind === "off") return localOff();
    if (answer.kind === "quota") return quotaRefusal(answer);
    if (answer.kind === "refused") {
      return json(answer.status, {
        error: answer.error,
        ...(answer.code === undefined ? {} : { code: answer.code }),
      });
    }
    const { request, suite } = answer;
    if (request.state === "refused") {
      return json(422, {
        error: request.note ?? "no checks ran",
        suite: null,
        request: requestView(request),
      });
    }
    if (suite === null) return json(202, { suite: null, request: requestView(request) });
    const scope = await scopeFor(deps, caller, "tasks:read-all");
    return json(201, { suite: await checks.view(suite.id, scope), request: requestView(request) });
  };

  /** `POST /v1/check-suites[?host=]`: a commit the person pushed to a branch on the forge. */
  const askPushed = async (req: Request, delegated = false): Promise<Response> => {
    const gated = await gateLocal(req, async () => {
      const parsed = await parseBody(req, delegated ? CheckDelegationSchema : LocalChecksSchema);
      return parsed.ok ? parsed.data : parsed.res;
    }, { delegated });
    if (gated instanceof Response) return gated;
    const { caller, checks, repo, branch, ask } = gated;
    const answer = await checks.requestLocal({
      user: { userId: caller.userId, name: caller.name },
      repo,
      commit: ask.commit,
      branch,
      base: ask.base,
      checks: ask.checks,
      delegationId: "delegationId" in ask ? ask.delegationId as string : undefined,
      retryFailed: "retryFailed" in ask && ask.retryFailed === true,
      bundled: false,
    });
    return await answerLocal(answer, caller, checks);
  };

  /** The bundle route's query, checked, or the 400 that says what is wrong with it. */
  const bundleQuery = (
    req: Request,
    delegated: boolean,
  ): {
    repo: string;
    branch: string;
    base: string | undefined;
    names: string[];
    delegationId?: string;
    retryFailed?: boolean;
  } | Response => {
    const query = new URL(req.url).searchParams;
    const repo = query.get("repo")?.trim() ?? "";
    const branch = localBranchName(query.get("branch") ?? "");
    const rawBase = query.get("base")?.trim() || undefined;
    const base = rawBase === undefined ? undefined : localBranchName(rawBase);
    const names = query.getAll("check");
    let delegationId: string | undefined;
    let retryFailed: boolean | undefined;
    if (delegated) {
      const identity = CheckDelegationIdSchema.safeParse(query.get("delegationId"));
      if (!identity.success || query.getAll("delegationId").length !== 1) {
        return json(400, {
          error:
            "delegationId: a stable sender request identity (1–256 letters, digits, '.', '_', ':', '-')",
        });
      }
      delegationId = identity.data;
      const retry = query.getAll("retryFailed");
      if (retry.length > 1 || (retry.length === 1 && retry[0] !== "true" && retry[0] !== "false")) {
        return json(400, { error: "retryFailed: true or false, once, or absent" });
      }
      retryFailed = retry[0] === "true";
    }
    if (repo === "" || repo.length > 512) {
      return json(400, { error: "repo: a connected repo's id or address" });
    }
    if (branch === null) {
      return json(400, {
        error: "branch: the branch the bundle carries, bare or refs/heads/<name>, not HEAD",
      });
    }
    if (base === null) {
      return json(400, { error: "base: a branch of the repo, bare or refs/heads/<name>" });
    }
    if (names.length > MAX_CHECKS || names.some((n) => !CHECK_NAME.test(n))) {
      return json(400, { error: `check: a check's name, at most ${MAX_CHECKS} of them` });
    }
    if (req.body === null) return json(400, { error: "the body is the bundle, and there is none" });
    return { repo, branch, base, names, delegationId, retryFailed };
  };

  /** `POST /v1/check-suites/bundle?repo=&branch=[&host=][&base=][&check=]...`: a commit off the
   * person's machine, the body its git bundle — streamed to the forge, never held here. */
  const askBundled = async (req: Request, delegated = false): Promise<Response> => {
    const gated = await gateLocal(req, () => Promise.resolve(bundleQuery(req, delegated)), {
      upload: true,
      delegated,
    });
    if (gated instanceof Response) return gated;
    const { caller, checks, repo, branch, ask: { base, names, delegationId, retryFailed } } = gated;
    const staged = await checks.stageLocalBundle(
      { user: { userId: caller.userId }, repo, branch, base },
      req.body!,
    );
    if (staged.kind === "refused") {
      return json(staged.status, {
        error: staged.error,
        ...(staged.detail === null ? {} : { detail: staged.detail }),
      });
    }
    if (staged.kind === "unavailable") {
      return json(503, { error: `the bundle could not be stored: ${staged.error}; try again` });
    }
    const answer = await checks.requestLocal({
      user: { userId: caller.userId, name: caller.name },
      repo,
      commit: staged.headSha,
      branch,
      base,
      checks: names,
      delegationId,
      retryFailed,
      bundled: true,
    });
    return await answerLocal(answer, caller, checks);
  };

  /** `GET /v1/check-requests/:id`: a local ask read back, by the person who made it or a reader
   * of everything; anyone else gets the 404 an unknown id gets. */
  const getRequest = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "checks:request", "reading a check ask");
    if (denied) return denied;
    const checks = deps.checks;
    const noSuchRequest = () => json(404, { error: "no such check request" });
    if (!checks) return noSuchRequest();
    const request = await checks.localRequest(params.id);
    if (request === null) return noSuchRequest();
    const scope = await scopeFor(deps, caller, "tasks:read-all");
    const own = caller.kind === "user" && request.userId === caller.userId;
    if (!own && scope.kind !== "all") return noSuchRequest();
    return json(200, {
      request: requestView(request),
      suite: request.suiteId === null ? null : await checks.view(request.suiteId, scope),
    });
  };

  /** Read declarations at B's judging branch without creating a request or consuming quota. */
  const getDelegationFile = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "checks:request", "reading delegated check declarations");
    if (denied) return denied;
    const checks = deps.checks;
    if (checks?.remote) {
      return json(409, {
        error: "this instance delegates checks elsewhere; delegation chains are not supported",
      });
    }
    if (!checks || !checks.local) return localOff();
    const query = new URL(req.url).searchParams;
    const named = query.get("repo")?.trim() ?? "";
    if (named === "" || named.length > 512) {
      return json(400, { error: "repo: a connected repo's id or address" });
    }
    const rawBase = query.get("base");
    const base = rawBase === null ? undefined : localBranchName(rawBase);
    if (base === null) {
      return json(400, { error: "base: a branch of the repo, bare or refs/heads/<name>" });
    }
    const repo = await repoNamed(named, hostOf(req));
    if (repo === null) return json(404, { error: "no such repo" });
    if ("ambiguous" in repo) return ambiguousRepo(named, repo.ambiguous);
    if (repo.archivedAt !== null) {
      return json(409, { error: `${repo.repoRef} is no longer connected` });
    }
    const refused = await refuseRepoPermission(deps, caller, repo, "write");
    if (refused) return refused;
    if (caller.kind !== "user") {
      return json(403, {
        error: "a delegated check ask needs a person: sign in, or use their token",
      });
    }
    return json(200, await checks.delegationFile(repo, base ?? repo.defaultBranch));
  };

  /** Machine-readable receiver state, only for the person whose PAT owns the delegation.
   * Unlike the human request read, tasks:read-all does not confer access to this transport. */
  const getDelegation = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "checks:request", "reading a delegated check ask");
    if (denied) return denied;
    if (caller.kind !== "user" || !deps.checks) {
      return json(404, { error: "no such check delegation" });
    }
    const snapshot = await deps.checks.delegationSnapshot(params.id, caller.userId);
    if (snapshot === null) return json(404, { error: "no such check delegation" });
    // A remote-backed suite is another delegation hop, not execution owned by this receiver.
    // Old locally executed suites remain readable if this instance later enables remote checks.
    if (snapshot.suite?.remote != null) {
      return json(409, {
        error: "this suite delegates checks elsewhere; delegation chains are not supported",
      });
    }
    // A single log line can be megabytes: line-count limits alone do not bound this polling
    // response. Full logs stay available through the log endpoint.
    return json(200, {
      ...snapshot,
      results: snapshot.results.map((result) => ({
        ...result,
        logTail: result.logTail === null ? null : result.logTail.slice(-16_384),
      })),
    });
  };

  /** Withdraw this caller's delegated request, never a suite shared with other askers. */
  const cancelDelegation = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "checks:request", "withdrawing a delegated check ask");
    if (denied) return denied;
    if (
      caller.kind !== "user" || !deps.checks ||
      !await deps.checks.cancelDelegation(params.id, caller.userId)
    ) {
      return json(404, { error: "no such check delegation" });
    }
    return new Response(null, { status: 204 });
  };

  const noSuchApproval = () => json(404, { error: "no such check approval" });

  /** An approval as its page shows it: the change request, the head, and who approved. */
  const approvalView = (approval: CheckApproval, repo: ConnectedRepo) => ({
    id: approval.id,
    state: approval.state,
    repo: { id: repo.id, repoRef: repo.repoRef, provider: repo.provider },
    changeRequest: approval.changeRequest,
    url: approval.url,
    headSha: approval.headSha,
    author: approval.author,
    approvedByLogin: approval.approvedByLogin,
    approvedAt: approval.approvedAt,
    createdAt: approval.createdAt,
  });

  /** `GET /v1/check-approvals/:id`: the page an outside contribution's comment links. Read as a
   * runless push suite is: by whoever may push to its repo (`tasks:read-all`, or the repo among
   * the caller's writable ones), never by `repos:read` alone with the link a public comment
   * carries. One they may not read is a 404, exactly as an unknown one. */
  const getApproval = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    const approval = await deps.checks?.approvals.getApproval(params.id) ?? null;
    if (approval === null) return noSuchApproval();
    const repo = await deps.store.getConnectedRepo(approval.connectedRepoId);
    if (repo === null) return noSuchApproval();
    const scope = await scopeFor(deps, caller, "tasks:read-all");
    if (scope.kind !== "all" && !scope.writableRepoIds.includes(repo.id)) {
      return noSuchApproval();
    }
    return json(200, { approval: approvalView(approval, repo) });
  };

  /**
   * `POST /v1/check-approvals/:id/approve`: run an outside contribution's checks on one head.
   * It spends the operator's compute on code its author could not have run, so it takes what a
   * Re-run takes (`patches:review`) AND what commanding agents on the repo takes, asked live
   * through the caller's linked identity (`commandTier`: write on GitHub, delegacy on Radicle,
   * with the repo's command allowlist as Radicle's fallback, as the forge door has it). Answers
   * the approval, and where to send the approver back to: the change request.
   */
  const approve = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "patches:review", "approving checks");
    if (denied) return denied;
    const checks = deps.checks;
    if (!checks) return noSuchApproval();
    const approval = await checks.approvals.getApproval(params.id);
    if (approval === null) return noSuchApproval();
    const repo = await deps.store.getConnectedRepo(approval.connectedRepoId);
    if (repo === null) return noSuchApproval();
    if (repo.archivedAt !== null) {
      return json(409, { error: "the change request's repo is no longer connected" });
    }
    if (!deps.forge) {
      return json(503, { error: "the forge is not configured; connected repos are unavailable" });
    }
    const subject = caller.kind === "user" && deps.identityDirectory
      ? await deps.identityDirectory.subjectFor(caller.userId, repo.provider)
      : null;
    const refused = await refuseRepoPermission(deps, caller, repo, commandTier(repo.provider));
    if (refused) {
      const allowlisted = repo.provider === "radicle" && subject !== null &&
        (await deps.store.listRepoCommandAllowlist(repo.id))
          .some((e) => e.provider === repo.provider && e.subject === subject);
      if (!allowlisted) return refused;
    }
    // Who approved, as the forge's comment names them. A GitLab subject is an account id, which
    // names nobody: the username GitLab gives that account now does (`requesterFor`).
    let login = subject;
    if (repo.provider === "gitlab") {
      const requester = caller.kind === "user" && deps.identityDirectory
        ? await deps.identityDirectory.requesterFor(caller.userId, repo.provider)
        : null;
      login = requester !== null && "login" in requester ? requester.login : null;
    }
    const outcome = await approveChecks(
      { checks, forge: deps.forge, appUrl: deps.config.appUrl, diag: deps.diag, now: deps.now },
      repo,
      approval,
      { userId: caller.kind === "user" ? caller.userId : "break-glass", login },
    );
    if (outcome.kind === "refused") return json(outcome.status, { error: outcome.why });
    return json(200, {
      approval: approvalView(outcome.approval, repo),
      returnTo: outcome.approval.url,
    });
  };

  return [
    route("GET", "/v1/check-approvals/:id", getApproval),
    route("POST", "/v1/check-approvals/:id/approve", approve),
    route("GET", "/v1/check-delegations/declaration", getDelegationFile),
    route("GET", "/v1/check-delegations/:id", getDelegation),
    route("DELETE", "/v1/check-delegations/:id", cancelDelegation),
    route("POST", "/v1/check-delegations", (req) => askPushed(req, true)),
    route("POST", "/v1/check-delegations/bundle", (req) => askBundled(req, true)),
    route("POST", "/v1/check-suites", (req) => askPushed(req)),
    route("POST", "/v1/check-suites/bundle", (req) => askBundled(req)),
    route("GET", "/v1/check-requests/:id", getRequest),
    route("GET", "/v1/check-suites", listSuites),
    route("GET", "/v1/checks/active", listActive),
    route("GET", "/v1/checks/repos", listRepos),
    route("GET", "/v1/check-suites/:id", getSuite),
    route("GET", "/v1/check-suites/:id/log", getLog),
    route("POST", "/v1/check-suites/:id/rerun", rerun),
  ];
}

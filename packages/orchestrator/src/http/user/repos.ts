import type { ConnectedRepo } from "../../core/types.ts";
import type {
  ForgeProviders,
  GithubRepoListing,
  GitlabProjectListing,
  RepoListing,
} from "../../ports/forge.ts";
import { actsAsPerson, gitlabInstanceFits, tenantFitsMode } from "../../core/forge_repo.ts";
import { mintId } from "@ryph/sealed";
import {
  ConnectRepoSchema,
  RegisterInstallationSchema,
  UpdateConnectedRepoSchema,
} from "../../schema.ts";
import { can } from "@ryph/auth";
import type { WiredDeps } from "../app.ts";
import { refuseUnless } from "@ryph/auth/gates";
import { json, parseBody, type Route, route } from "@ryph/shared/http";
import { repoConnections } from "./repo_connections.ts";
import { repoAccess } from "./repo_access.ts";

export function repoRoutes(deps: WiredDeps): Route[] {
  const { store, diag } = deps;
  const nowIso = () => deps.now().toISOString();
  const {
    refuseInUserMode,
    githubModeHere,
    gitlabModeHere,
    connectGitlabRepo,
    connectLocalRepo,
    connectRadicleRepo,
    connectGithubRepoAsUser,
    radicleRepoInfo,
    followCommands,
  } = repoConnections(deps);
  const { refuseRepoPermissionHere, refuseSizeClass } = repoAccess(deps);

  const registerInstallation = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:connect");
    if (denied) return denied;
    if (!deps.githubConnect) return json(503, { error: "no GitHub App is configured" });
    const userMode = await refuseInUserMode();
    if (userMode) return userMode;
    const body = await parseBody(req, RegisterInstallationSchema);
    if (!body.ok) return body.res;

    // Everything about the installation is asked of the forge — the caller supplied only the
    // id GitHub's install redirect carried, and an id the App is not actually installed under
    // fails right here.
    let described;
    try {
      described = await deps.githubConnect.describeInstallation(body.data.installationId);
    } catch (err) {
      diag.warn("installation.describe_failed", { err: String(err) });
      return json(502, { error: "could not verify the installation with the forge" });
    }
    const at = nowIso();
    const installation = {
      id: mintId("gi"),
      installationId: body.data.installationId,
      accountLogin: described.accountLogin,
      createdAt: at,
    };
    await store.saveInstallation(installation);
    return json(201, { installation, repos: described.repos });
  };

  const listInstallations = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:connect");
    if (denied) return denied;
    return json(200, { installations: await store.listInstallations() });
  };

  const listInstallationRepos = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:connect");
    if (denied) return denied;
    if (!deps.githubConnect) return json(503, { error: "no GitHub App is configured" });
    const userMode = await refuseInUserMode();
    if (userMode) return userMode;
    const installation = await store.getInstallationByInstallationId(params.installationId);
    if (!installation) return json(404, { error: "no such installation" });
    const described = await deps.githubConnect.describeInstallation(installation.installationId);
    const connected = await store.listConnectedRepos();
    // A row left over from user mode (no installation) is no connection here
    // (`tenantFitsMode`).
    const connectedRefs = new Set(
      connected.filter((r) =>
        r.archivedAt === null && r.provider === "github" && r.installationId !== null
      )
        .map((r) => r.repoRef),
    );
    return json(200, {
      accountLogin: described.accountLogin,
      settingsUrl: described.settingsUrl,
      repos: described.repos.map((r: RepoListing) => ({
        ...r,
        connected: connectedRefs.has(r.fullName),
      })),
    });
  };

  /**
   * The repos the token's owner can reach, for the user-mode connect picker — each with the
   * connected row it already is, if any (case-blind, as GitHub matches names), and whether the
   * token holds admin on it, which connecting needs. 501 when the
   * forge is not acting through a user token: an App's repos are listed per installation.
   */
  const listGithubRepos = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:connect");
    if (denied) return denied;
    if (!deps.forge || !deps.githubUserConnect) {
      return json(503, { error: "the forge is not configured; connected repos are unavailable" });
    }
    const mode = await githubModeHere();
    if (mode === undefined) {
      return json(502, { error: "the forge did not say how it acts on GitHub" });
    }
    if (mode?.mode !== "user") {
      return json(501, { error: "GitHub does not act through a user token here" });
    }
    let repos: GithubRepoListing[];
    try {
      repos = await deps.githubUserConnect.listGithubRepos();
    } catch (err) {
      diag.warn("github.repos_failed", { err: String(err) });
      return json(502, { error: "could not list your GitHub repositories" });
    }
    // A row left over from App mode is no connection here (`tenantFitsMode`).
    const connected = new Map(
      (await store.listConnectedRepos())
        .filter((r) =>
          r.provider === "github" && r.archivedAt === null && r.installationId === null
        )
        .map((r) => [r.repoRef.toLowerCase(), r.id]),
    );
    return json(200, {
      repos: repos.map((r) => ({
        ...r,
        connectedRepoId: connected.get(r.fullName.toLowerCase()) ?? null,
      })),
    });
  };

  /**
   * The GitLab projects the forge's token reaches, for the connect picker: in bot mode the bot's
   * memberships at Developer or above, in user mode the person's projects. Each carries the
   * connected row it already is, if any (case-blind, as GitLab matches paths), and `admin`:
   * whether the token holds Maintainer there — what a user-mode connect needs, and in bot mode a
   * bot holding more than it should.
   */
  const listGitlabProjects = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:connect");
    if (denied) return denied;
    if (!deps.forge || !deps.gitlabConnect) {
      return json(503, { error: "no GitLab is configured" });
    }
    const mode = await gitlabModeHere();
    if (mode === undefined) {
      return json(502, { error: "the forge did not say how it acts on GitLab" });
    }
    if (mode === null) return json(503, { error: "no GitLab is configured" });
    let projects: GitlabProjectListing[];
    try {
      projects = await deps.gitlabConnect.listGitlabProjects();
    } catch (err) {
      diag.warn("gitlab.projects_failed", { err: String(err) });
      return json(502, { error: "could not list the GitLab projects" });
    }
    // Matched by project id on this instance: a connected project renamed since is still the
    // one connected, and a row from another instance is not this instance's project of that id.
    const connected = new Map<string, string>();
    for (const r of await store.listConnectedRepos()) {
      if (r.provider !== "gitlab" || r.archivedAt !== null) continue;
      const held = await store.getGitlabProject(r.id);
      if (held !== null && held.instance === mode.url) connected.set(held.projectId, r.id);
    }
    return json(200, {
      projects: projects.map((p) => ({ ...p, connectedRepoId: connected.get(p.id) ?? null })),
    });
  };

  const connectRepo = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:connect");
    if (denied) return denied;
    const body = await parseBody(req, ConnectRepoSchema);
    if (!body.ok) return body.res;
    if (body.data.provider === "local") {
      return await connectLocalRepo(caller, {
        path: body.data.path,
        submissionPolicy: body.data.submissionPolicy,
      });
    }
    if (body.data.provider === "radicle") {
      return await connectRadicleRepo(caller, {
        repoRef: body.data.repoRef,
        submissionPolicy: body.data.submissionPolicy,
      });
    }
    if (body.data.provider === "gitlab") {
      return await connectGitlabRepo(caller, {
        repoRef: body.data.repoRef,
        submissionPolicy: body.data.submissionPolicy,
      });
    }
    // Narrowed to the GitHub body by the three returns above; held in a const so the closures
    // below keep the narrowing.
    const data = body.data;
    if (!deps.githubConnect) return json(503, { error: "no GitHub App is configured" });
    // Whether a GitHub repo has an installation is the forge's mode, not the caller's choice:
    // one iff the forge acts as an App. Asked before anything else is.
    const mode = await githubModeHere();
    if (mode === undefined) {
      return json(502, { error: "the forge did not say how it acts on GitHub" });
    }
    if (mode?.mode === "user") {
      return await connectGithubRepoAsUser(caller, mode.login, {
        repoRef: data.repoRef,
        installationId: data.installationId,
        submissionPolicy: data.submissionPolicy,
      });
    }
    const installationId = data.installationId;
    if (installationId === undefined) {
      return json(400, {
        error: "a GitHub repo is connected through an installation — installationId is required",
      });
    }

    const installation = await store.getInstallationByInstallationId(installationId);
    if (!installation) return json(404, { error: "no such installation — register it first" });

    // "Connect a repo → admin on it", checked live. Against the row this is about to become:
    // the permission check reads the provider, the address and the tenant, and nothing else.
    const refused = await refuseRepoPermissionHere(caller, {
      id: "",
      provider: data.provider,
      installationId,
      repoRef: data.repoRef,
      url: "",
      defaultBranch: "",
      submissionPolicy: data.submissionPolicy,
      sizeClass: null,
      allowForkPushes: false,
      archivedAt: null,
      createdAt: "",
      updatedAt: "",
    }, "admin");
    if (refused) return refused;

    // The repo's coordinates come from the installation's own listing, never the caller.
    const described = await deps.githubConnect.describeInstallation(installationId);
    const listing = described.repos.find((r: RepoListing) => r.fullName === data.repoRef);
    if (!listing) {
      return json(404, { error: `the installation does not grant ${data.repoRef}` });
    }
    // A row left over from user mode (no installation) is no connection here (`tenantFitsMode`).
    const existing = (await store.listConnectedRepos())
      .find((r) =>
        r.provider === data.provider && r.repoRef === data.repoRef &&
        r.archivedAt === null && r.installationId !== null
      );
    if (existing) return json(409, { error: `${data.repoRef} is already connected` });

    const at = nowIso();
    const repo: ConnectedRepo = {
      id: mintId("cr"),
      provider: data.provider,
      installationId,
      repoRef: listing.fullName,
      url: listing.url,
      defaultBranch: listing.defaultBranch,
      submissionPolicy: data.submissionPolicy,
      sizeClass: null,
      allowForkPushes: false,
      archivedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    await store.createConnectedRepo(repo);
    return json(201, repo);
  };

  const listConnectedRepos = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    return json(200, { repos: await store.listConnectedRepos() });
  };

  const updateConnectedRepo = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:manage");
    if (denied) return denied;
    const repo = await store.getConnectedRepo(params.id);
    if (!repo) return json(404, { error: "no such connected repo" });
    const body = await parseBody(req, UpdateConnectedRepoSchema);
    if (!body.ok) return body.res;
    // "auto" retires the approval gate for every patch this repo opens from here on — the same
    // reach as connecting it in the first place, and the same admin bar.
    // Letting runs push onto contributors' fork branches is the repo admin's call too: it is
    // ryph writing into repositories that are not even this one, under this repo's App grant.
    if (body.data.submissionPolicy !== undefined || body.data.allowForkPushes !== undefined) {
      const refused = await refuseRepoPermissionHere(caller, repo, "admin");
      if (refused) return refused;
    }
    // Only GitHub pull requests and GitLab merge requests come from forks: on Radicle a patch
    // lives in the repository it is against, and a `local` repo has none. A switch that could
    // never mean anything is refused.
    if (
      body.data.allowForkPushes === true && repo.provider !== "github" &&
      repo.provider !== "gitlab"
    ) {
      return json(400, { error: "only GitHub and GitLab repos have change requests from forks" });
    }
    // In a user mode the forge pushes as a person's token, and it never pushes to a fork
    // (`pushAuth` on both forges): the switch would promise what no push can do. GitLab rows
    // carry no tenant, so its mode is the forge's answer, asked live.
    if (body.data.allowForkPushes === true) {
      let providers: Pick<ForgeProviders, "gitlab"> | undefined;
      if (repo.provider === "gitlab") {
        const gitlab = await gitlabModeHere();
        if (gitlab === undefined) {
          return json(502, { error: "the forge did not say how it acts on GitLab" });
        }
        providers = { gitlab };
      }
      if (actsAsPerson(repo, providers)) {
        return json(400, {
          error: repo.provider === "github"
            ? "pushing to fork branches needs the repo connected through the GitHub App"
            : "pushing to fork branches needs GitLab acting as a bot, not a person's token",
        });
      }
    }
    // The size class is the PLATFORM admin's, not the repo admin's: the forge says who may
    // change the repo, and the operator's bill is not the repo's to decide.
    if (body.data.sizeClass !== undefined) {
      const refused = refuseSizeClass(caller, body.data.sizeClass);
      if (refused) return refused;
    }
    const updated: ConnectedRepo = {
      ...repo,
      submissionPolicy: body.data.submissionPolicy ?? repo.submissionPolicy,
      sizeClass: body.data.sizeClass === undefined ? repo.sizeClass : body.data.sizeClass,
      allowForkPushes: body.data.allowForkPushes ?? repo.allowForkPushes,
      updatedAt: nowIso(),
    };
    await store.saveConnectedRepo(updated);
    return json(200, updated);
  };

  const archiveConnectedRepo = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:manage");
    if (denied) return denied;
    const repo = await store.getConnectedRepo(params.id);
    if (!repo) return json(404, { error: "no such connected repo" });
    if (repo.archivedAt !== null) return json(200, repo); // idempotent
    // Disconnecting undoes the connect, and answers to the same bar — except for a row the forge
    // cannot act on as it runs now: a GitHub row whose tenant does not fit its mode
    // (`tenantFitsMode`), or a GitLab row connected on another instance or with no GitLab here
    // at all (`gitlabInstanceFits`). The forge refuses every question about such a row, so no
    // admin check could ever pass. A platform admin may clear it without asking; anyone else
    // still meets the check, and its refusal. A mode the forge did not say strands nothing.
    // (Break-glass needs no exception: it clears every check.)
    const stranded = caller.kind !== "break-glass" && can(caller, "repos:manage-all") &&
      (repo.provider === "github"
        ? !tenantFitsMode(repo, await githubModeHere())
        : repo.provider === "gitlab" && !gitlabInstanceFits(repo, await gitlabModeHere()));
    if (!stranded) {
      const refused = await refuseRepoPermissionHere(caller, repo, "admin");
      if (refused) return refused;
    }
    const archived: ConnectedRepo = { ...repo, archivedAt: nowIso(), updatedAt: nowIso() };
    await store.saveConnectedRepo(archived);
    // Disconnecting a Radicle repository stops our node seeding it: seeding is what makes it
    // fetch a stranger's namespace on every gossip round, and holding a repository nobody
    // connected is work and storage spent on nothing. Best-effort — the row is the truth, and
    // a node that did not let go costs bandwidth, not correctness.
    if (repo.provider === "radicle" && deps.radicleConnect) {
      await deps.radicleConnect.unseedRadicleRepo(repo.repoRef).catch((err) => {
        diag.warn("radicle.unseed_failed", { repo: repo.repoRef, err: String(err) });
      });
    }
    return json(200, archived);
  };

  /**
   * Where a connected repo's GitHub App installation is managed: a redirect to GitHub, resolved
   * when the person clicks rather than on every page load. Read live, so an account renamed
   * since the repo was connected still lands on the right page.
   */
  const redirectToInstallationSettings = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    const repo = await store.getConnectedRepo(params.id);
    if (!repo) return json(404, { error: "no such connected repo" });
    if (repo.provider !== "github" || repo.installationId === null) {
      return json(404, { error: "this repository has no GitHub App installation" });
    }
    if (!deps.githubConnect) return json(503, { error: "no GitHub App is configured" });
    const userMode = await refuseInUserMode();
    if (userMode) return userMode;
    try {
      const url = await deps.githubConnect.getInstallationSettingsUrl(repo.installationId);
      return new Response(null, {
        status: 302,
        headers: { location: url, "cache-control": "no-store" },
      });
    } catch (err) {
      diag.warn("installation.settings_failed", {
        installationId: repo.installationId,
        err: String(err),
      });
      return json(502, { error: "GitHub did not say where this installation is managed" });
    }
  };

  /**
   * A connected Radicle repository's identity document, read FRESH. Delegates change, a repo
   * goes private, ryph's access is revoked — none of which sends an event, so the only honest
   * way to show it is to ask at the moment somebody looks.
   */
  const getConnectedRepoRadicle = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    const repo = await store.getConnectedRepo(params.id);
    if (!repo) return json(404, { error: "no such connected repo" });
    if (repo.provider !== "radicle") {
      return json(404, { error: `${repo.repoRef} is not a Radicle repository` });
    }
    if (!deps.radicleConnect) return json(503, { error: "no Radicle node is configured" });
    let doc;
    try {
      doc = await deps.radicleConnect.describeRadicleRepo(repo.repoRef);
    } catch (err) {
      diag.warn("radicle.describe_failed", { repo: repo.repoRef, err: String(err) });
      return json(502, { error: "radicle_unreachable" });
    }
    if (doc === null) return json(404, { error: "repo_not_found" });
    return json(200, radicleRepoInfo(doc));
  };

  /**
   * Which forges a repo can be connected through HERE. Asked of the boundary rather than
   * guessed from configuration: it is the side that holds a GitHub App or a Radicle bridge,
   * and an offer this deployment cannot honour is a form that fails at the last step. `github`
   * says how GitHub is acted on — an App, or one person's token (as whom) — null without it;
   * `radicle` says whether the Radicle bridge is the deployment's own node or one person's.
   */
  const listForgeProviders = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    if (!deps.forge) return json(200, { providers: [], github: null, gitlab: null, radicle: null });
    // A forge that did not answer is said to be unreachable, never guessed at: an empty list
    // would read as "nothing can be connected here", and any other list as a promise.
    try {
      const { providers, github, gitlab, radicle } = await deps.forge.providers();
      return json(200, { providers, github, gitlab, radicle });
    } catch (err) {
      diag.warn("forge.providers_failed", { err: String(err) });
      return json(502, { error: "the forge did not say which providers it runs" });
    }
  };

  /** Who ryph is on the Radicle network, and how to make its work visible to you. */
  const getRadicleIdentity = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "repos:read");
    if (denied) return denied;
    if (!deps.radicleConnect) return json(404, { error: "no Radicle node is configured" });
    let identity;
    try {
      identity = await deps.radicleConnect.radicleIdentity();
    } catch (err) {
      diag.warn("radicle.identity_failed", { err: String(err) });
      return json(502, { error: "radicle_unreachable" });
    }
    const commands = followCommands(identity.did);
    return json(200, {
      did: identity.did,
      nid: identity.nid,
      alias: identity.alias,
      node: identity.node,
      // The one to paste inside a working copy, and the general one. Both, because which is
      // useful depends on where the reader is standing — see `followCommands`.
      followCommand: commands.inWorkingCopy,
      followCommands: commands,
    });
  };

  return [
    route("POST", "/v1/installations", registerInstallation),
    route("GET", "/v1/installations", listInstallations),
    route("GET", "/v1/installations/:installationId/repos", listInstallationRepos),
    route("POST", "/v1/connected-repos", connectRepo),
    route("GET", "/v1/connected-repos", listConnectedRepos),
    route("PATCH", "/v1/connected-repos/:id", updateConnectedRepo),
    route("POST", "/v1/connected-repos/:id/archive", archiveConnectedRepo),
    route("GET", "/v1/connected-repos/:id/radicle", getConnectedRepoRadicle),
    route("GET", "/v1/connected-repos/:id/installation-settings", redirectToInstallationSettings),
    route("GET", "/v1/forge-providers", listForgeProviders),
    route("GET", "/v1/github/repos", listGithubRepos),
    route("GET", "/v1/gitlab/projects", listGitlabProjects),
    route("GET", "/v1/radicle/identity", getRadicleIdentity),
  ];
}

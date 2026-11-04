import type { ConnectedRepo } from "../../core/types.ts";
import type {
  GithubMode,
  GitlabMode,
  GitlabProjectListing,
  RadicleRepoInfo,
  RadicleSeedOutcome,
  RepoListing,
} from "../../ports/forge.ts";
import { mintId } from "@ryph/sealed";
import { gitlabProjectRef } from "@ryph/forge/gitlab-account";
import { isRepoRef } from "../../schema.ts";
import { can } from "@ryph/auth";
import type { Principal, WiredDeps } from "../app.ts";
import { json } from "@ryph/shared/http";
import { repoAccess } from "./repo_access.ts";

/** The webhook triggers GitLab is told to send, as its settings page names them. */
export const GITLAB_HOOK_TRIGGERS = [
  "push_events",
  "note_events",
  "merge_requests_events",
] as const;

/** A GitLab project's webhook, as its Maintainer configures it (`gitlabWebhookFor`). */
export interface GitlabWebhookSetup {
  url: string | null;
  token: string;
  projectId: string;
  /** The token's generation: rotating the token moves it on, and the URL names it. */
  generation: number;
  triggers: typeof GITLAB_HOOK_TRIGGERS;
  pushBranchFilter: string | null;
  sslVerification: true;
}

export function repoConnections(deps: WiredDeps) {
  const { store, diag } = deps;
  const nowIso = () => deps.now().toISOString();
  const { refuseRepoPermissionHere } = repoAccess(deps);

  // ---- installations & connected repos --------------------------------------

  /**
   * How the forge acts on GitHub, asked live: `undefined` when there is no forge or it did not
   * answer. Connecting is rare and the answer decides what a row is, so it is never cached here.
   */
  const githubModeHere = async (): Promise<GithubMode | null | undefined> => {
    if (!deps.forge) return undefined;
    try {
      return (await deps.forge.providers()).github;
    } catch (err) {
      diag.warn("forge.providers_failed", { err: String(err) });
      return undefined;
    }
  };

  /** How the forge acts on GitLab, asked live, as `githubModeHere` asks GitHub's. */
  const gitlabModeHere = async (): Promise<GitlabMode | null | undefined> => {
    if (!deps.forge) return undefined;
    try {
      return (await deps.forge.providers()).gitlab;
    } catch (err) {
      diag.warn("forge.providers_failed", { err: String(err) });
      return undefined;
    }
  };

  /**
   * What a Maintainer pastes into the project's Settings → Webhooks for a bot deployment to hear
   * it: the URL on this deployment's front door, bound to the project's id and the token's
   * current generation, the token derived for both (shown to a Maintainer only), and the three
   * triggers the consumer reads. The URL is null where RYPH_APP_URL is unset — there is then no
   * browser-facing origin to name.
   */
  const gitlabWebhookFor = async (
    project: GitlabProjectListing,
    generation: number,
  ): Promise<GitlabWebhookSetup> => ({
    url: deps.config.appUrl === null
      ? null
      : `${deps.config.appUrl}/v1/hooks/gitlab?project=${project.id}&generation=${generation}`,
    token: await deps.gitlabConnect!.gitlabHookToken(project.id, generation),
    projectId: project.id,
    generation,
    triggers: GITLAB_HOOK_TRIGGERS,
    // Pushes matter on the default branch only (`branch.updated`); the filter saves deliveries.
    pushBranchFilter: project.defaultBranch,
    sslVerification: true,
  });

  /**
   * A GitLab row brought up to where GitLab places its project NOW: `project` is GitLab's answer
   * for the project by its id, and the path and URL the row was connected under are only where
   * it lived then — a rename or a transfer leaves them behind. Written only to a live row; the row
   * as it stands after.
   */
  const placeGitlabRepo = async (
    repo: ConnectedRepo,
    project: GitlabProjectListing,
  ): Promise<ConnectedRepo> => {
    if (project.pathWithNamespace === repo.repoRef && project.url === repo.url) return repo;
    const now = await store.getConnectedRepo(repo.id);
    if (now === null || now.archivedAt !== null) return repo;
    const placed = {
      ...now,
      repoRef: project.pathWithNamespace,
      url: project.url,
      updatedAt: nowIso(),
    };
    await store.saveConnectedRepo(placed);
    diag.debug("gitlab.repo_moved", { repo: repo.id, from: repo.repoRef, to: placed.repoRef });
    return placed;
  };

  /**
   * `placeGitlabRepo` with GitLab asked first, by the project's id — for a door that has reason
   * to think the row's path is stale (a user-mode deployment hears no webhook that would say).
   * Never by a row connected on another instance than `mode`'s, whose id names some other
   * project here. Best effort: anything unanswered leaves the row as it is.
   */
  const refreshGitlabPlace = async (
    repo: ConnectedRepo,
    mode: GitlabMode | null | undefined,
  ): Promise<ConnectedRepo> => {
    if (repo.provider !== "gitlab" || !deps.gitlabConnect || !mode) return repo;
    const held = await store.getGitlabProject(repo.id);
    if (held === null || held.instance !== mode.url) return repo;
    try {
      const project = await deps.gitlabConnect.describeGitlabProject(held.projectId);
      return project === null ? repo : await placeGitlabRepo(repo, project);
    } catch (err) {
      diag.warn("gitlab.describe_failed", { repo: repo.repoRef, err: String(err) });
      return repo;
    }
  };

  /** The App's installation routes have nothing to act on when GitHub is a user's token. Only
   * the forge's own "user" refuses — an unanswered question leaves the route as it always was,
   * which fails at the forge by itself. */
  const refuseInUserMode = async (): Promise<Response | null> =>
    (await githubModeHere())?.mode === "user"
      ? json(501, {
        error: "GitHub acts through a user token here; there are no App installations",
      })
      : null;

  /**
   * The two commands a human may have to paste for ryph's Radicle patches to be VISIBLE to
   * them. Radicle's visibility is opt-in on the reader's side: `rad seed` and `rad clone`
   * default to scope `followed`, so a maintainer who never followed ryph will not see its
   * patches on their laptop however correctly we pushed them. Nothing we can do about it from
   * here except say so, with the line to run.
   *
   * Verified against `rad 1.10` (`rad remote add --help`, `rad follow --help`): `remote add`
   * needs a working copy — it writes a git remote — and `follow` works anywhere. Both take a
   * DID or a NID; the DID is what the rest of ryph shows, so it is what these say.
   */
  const followCommands = (did: string) => ({
    inWorkingCopy: `rad remote add ${did} --sync`,
    anywhere: `rad follow ${did} --alias ryph`,
  });

  /** A Radicle repository as the connect flow shows it: the document, flattened, with ryph's
   * own identity at the top because that is what the reader has to act on. */
  const radicleRepoInfo = (info: RadicleRepoInfo) => ({
    rid: info.rid,
    nid: info.self.nid,
    did: info.self.did,
    alias: info.self.alias,
    name: info.name,
    defaultBranch: info.defaultBranch,
    delegates: info.delegates,
    isDelegate: info.isDelegate,
    isAllowed: info.isAllowed,
    visibility: info.visibility,
    followCommands: followCommands(info.self.did),
  });

  /**
   * Connecting a Radicle repository. No installation, no listing, no OAuth: the address is a
   * RID, the coordinates come from the repository's own signed identity document, and "may
   * this person connect it" is "are they a delegate", asked live.
   *
   * The order matters. Seeding is what makes the node HOLD the repository, and every question
   * below is asked of what it holds — so it happens first, and is undone again if the answers
   * refuse the connection. A repository already connected is refused before any of it.
   */
  const connectRadicleRepo = async (
    caller: Principal,
    data: { repoRef: string; submissionPolicy: ConnectedRepo["submissionPolicy"] },
  ): Promise<Response> => {
    if (!deps.radicleConnect || !deps.forge) {
      return json(503, { error: "no Radicle node is configured" });
    }
    const radicle = deps.radicleConnect;

    // A bridge in USER MODE signs everything on every repository connected through it as the
    // one person whose node and key it holds (the `ryph` binary's owner), and the seed below
    // already makes that node fetch and announce whatever RID was named. So it is held to the
    // bar a repository on this machine is (`connectLocalRepo`): `repos:manage-all`, asked
    // BEFORE anything reaches the node. Asked live, and a forge that did not answer is no
    // answer: refused rather than guessed to be a deployment's bridge.
    let radicleMode;
    try {
      radicleMode = (await deps.forge.providers()).radicle;
    } catch (err) {
      diag.warn("forge.providers_failed", { err: String(err) });
      return json(502, { error: "radicle_unreachable" });
    }
    if (
      radicleMode?.mode === "user" && caller.kind !== "break-glass" &&
      !can(caller, "repos:manage-all")
    ) {
      return json(403, {
        error: "connecting a Radicle repository here needs repos:manage-all — ryph acts as " +
          "this machine's own Radicle identity on every repository connected through it",
      });
    }

    // A linked identity first: without one there is no DID to ask about, and "link your
    // account" is a more useful answer than a permission check against nobody. Break-glass
    // and `repos:manage-all` are the exceptions, for the same reason: the bar they
    // clear below is not a claim about their Radicle identity at all (see the gate itself),
    // so there is no DID for it to need.
    const privileged = caller.kind === "break-glass" || can(caller, "repos:manage-all");
    const did = privileged || !deps.identityDirectory
      ? null
      : await deps.identityDirectory.subjectFor(caller.userId, "radicle");
    if (!privileged && did === null) {
      return json(403, {
        error: "not_delegate",
        detail: "link your Radicle identity first — connecting a repo needs a DID to check",
      });
    }

    const existing = (await store.listConnectedRepos())
      .find((r) => r.provider === "radicle" && r.repoRef === data.repoRef && r.archivedAt === null);
    if (existing) return json(409, { error: `${data.repoRef} is already connected` });

    let seeded: RadicleSeedOutcome;
    try {
      // Seed with scope `all` and fetch once. Scope matters: under the default (`followed`)
      // our node would never ask for a stranger's namespace, and a stranger's `/ryph` comment
      // would simply never arrive.
      seeded = await radicle.seedRadicleRepo(data.repoRef);
    } catch (err) {
      diag.warn("radicle.seed_failed", { repo: data.repoRef, err: String(err) });
      return json(502, { error: "radicle_unreachable" });
    }

    // The owner's node blocks it (user mode only). Nothing was written, so nothing is undone,
    // and the block is theirs to lift: the sentence says how, and is what the page shows.
    if (seeded.kind === "blocked") {
      return json(409, { error: seeded.reason, command: seeded.command });
    }

    /** Undoes the seed when the connection is refused — never on a 5xx, where the state is
     * unknown and a retry is the right move. Nor when another connect of the same repository
     * has landed in the meantime: the seed is ITS now, and undoing it would leave a connected
     * repository that the node no longer seeds. */
    const giveUp = async (res: Response) => {
      const taken = (await store.listConnectedRepos()).some((r) =>
        r.provider === "radicle" && r.repoRef === data.repoRef && r.archivedAt === null
      );
      if (!taken) await radicle.unseedRadicleRepo(data.repoRef).catch(() => {});
      return res;
    };

    /** The one refusal that carries a command: `did` is ryph's, and `command` is what a
     * delegate of a private repository runs to let it in. */
    const notAllowed = (did: string, command: string, detail: string) =>
      giveUp(json(409, { error: "not_allowed", did, command, detail }));

    // The node was asked and the network handed back nothing. That is ONE answer for two
    // situations Radicle cannot tell apart from here: a private repository refuses the fetch at
    // the responding node — the initiator sees a broken handshake and is never told why — and
    // keeps itself out of every inventory announcement, so it looks exactly like a repository
    // nobody is offering. Both readings are said, and the command that fixes the first is
    // given either way, because a person who owns the repository is the one who can act.
    if (seeded.kind === "unavailable") {
      // REFUSED BY A HOLDER, or not asked of one? The routing count alone cannot tell those
      // apart — it says who CLAIMS to have it, not who ryph's node was connected to — and
      // reading it as if it could once told a public repository's owner that it was private.
      // `triedSeeds` is how many claimants were actually asked, which is the fair test.
      const refusedByAHolder = seeded.triedSeeds > 0;
      const claimed = (seeded.seeds ?? 0) > 0;
      return await notAllowed(
        seeded.did,
        seeded.command,
        `ryph's node could not fetch ${data.repoRef}. ` +
          (refusedByAHolder
            ? "Every peer that claims to hold it refused the fetch, which is what a private " +
              "repository does to a node that is not on its allow list."
            : claimed
            ? "Peers on the network claim to hold it, but ryph's node is not connected to any " +
              "of them, so none could be asked. This is usually a node that has not finished " +
              "connecting — try again in a minute."
            : "No connected peer could serve it. Either it is private and ryph is not on its " +
              "allow list — a private repository is never gossiped and its fetch is refused " +
              "at the handshake, so it looks exactly like this — or no peer is offering that " +
              "id at all.") +
          " If the repository is yours, a delegate runs the command below and you connect again.",
      );
    }
    const doc = seeded.repo;

    // A private repository our DID is not allowed to fetch, whose document we nonetheless have
    // — we held it before the allow list changed. Only a delegate can fix it.
    if (!doc.isAllowed) {
      return await notAllowed(
        doc.self.did,
        `rad id update --allow ${doc.self.did}`,
        `${data.repoRef} is private and ryph's DID is not on its allow list.`,
      );
    }

    // Who may attach this repository to ryph: a delegate, OR `repos:manage-all`. What
    // the gate governs is ryph's own behaviour toward the repo from here on — the submission
    // policy, the command allowlist, workspace membership — and Radicle has no opinion about
    // any of it, so delegacy is a sufficient answer rather than the only one. Keeping it as
    // the only one would also forbid attaching a repository a different team delegates, when
    // seeding and reading a public one is permissionless and spends nothing but this
    // deployment's own resources. A delegate still connects without any ryph role, which is
    // how a team runs its own repos.
    if (!privileged) {
      const permission = await deps.forge.checkPermission(
        { provider: "radicle", repoRef: data.repoRef, tenantId: null },
        { provider: "radicle", subject: did! },
        "admin",
      );
      if (permission === "unknown") {
        return await giveUp(json(502, { error: "radicle_unreachable" }));
      }
      if (permission === "denied") {
        // The CODE stays `not_delegate` — the connect page switches on it to show the follow
        // commands — while the detail says the whole rule, both ways through it.
        return await giveUp(json(403, {
          error: "not_delegate",
          detail: `${did!} is not a delegate of ${data.repoRef}, and you are not a ryph admin`,
        }));
      }
    }

    const at = nowIso();
    const repo: ConnectedRepo = {
      id: mintId("cr"),
      provider: "radicle",
      // Radicle has no tenants at all: every write is signed by this deployment's own key.
      installationId: null,
      repoRef: data.repoRef,
      // THE RID, not "". `url` is the repository's canonical address on the wire, and half the
      // platform reads it as one: the services-file read passes it to the forge (whose schema
      // requires it non-empty), a workspace entry is matched to its repo by `entry.url ===
      // repo.url`, a change delivery carries it as `repoUrl`, and the run's git-key resolve and
      // the repo cache key are built from it. Storing "" here — done so the app would not
      // render `href="rad:z…"` — refused every run on a Radicle repo with `url: Too small`.
      // Whether a value is a hyperlink is the APP's question, and it already answers it in one
      // place (`isWebLink`); migration 0017 repairs the rows written in between.
      url: data.repoRef,
      defaultBranch: doc.defaultBranch,
      submissionPolicy: data.submissionPolicy,
      sizeClass: null,
      allowForkPushes: false,
      archivedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    await store.createConnectedRepo(repo);
    return json(201, { repo, radicle: radicleRepoInfo(doc) });
  };

  /**
   * Connecting a repository on the forge's own disk. The caller names a path, and that is ALL
   * the caller names: whether it is absolute, inside the allowed root, a repository at all, and
   * what it is canonically called are the forge's answers, because the forge is what will read
   * it. The row is built from those answers alone — a `repoRef` or `url` the caller sent beside
   * the path never got past the schema.
   *
   * Admin-only (`repos:manage-all`): there is no forge identity to ask, and what this
   * deployment may read off its own machine is its admins' call. Checked before the forge is
   * asked anything, so a refused caller cannot use the route to probe the disk.
   */
  const connectLocalRepo = async (
    caller: Principal,
    data: { path: string; submissionPolicy: ConnectedRepo["submissionPolicy"] },
  ): Promise<Response> => {
    if (!deps.localConnect || !deps.forge) {
      return json(503, { error: "the forge is not configured; connected repos are unavailable" });
    }
    if (caller.kind !== "break-glass" && !can(caller, "repos:manage-all")) {
      return json(403, {
        error: "connecting a repository on this machine needs repos:manage-all",
      });
    }
    let described;
    try {
      described = await deps.localConnect.describeLocalRepo(data.path);
    } catch (err) {
      diag.warn("local.describe_failed", { err: String(err) });
      return json(502, { error: "could not ask the forge about that path" });
    }
    if (described.kind === "unsupported") {
      // 503, as a deployment with no GitHub App answers its connect: the request is fine, this
      // deployment simply has nothing to serve it with.
      return json(503, { error: "local repositories are not enabled on this deployment" });
    }
    if (described.kind === "refused") {
      // `root` rides an `outside_root` only: where repositories CAN be connected from, for the
      // page to say. The caller already holds repos:manage-all, so the root is theirs to see.
      return json(422, {
        error: described.error,
        reason: described.reason,
        ...(described.reason === "outside_root" && described.root !== undefined
          ? { root: described.root }
          : {}),
      });
    }
    // The forge's answer is held to the spelling a local address has before it becomes a row:
    // the boundary is trusted to have resolved the path, not to have been sent a sane one.
    if (!isRepoRef("local", described.repoRef) || described.url !== described.repoRef) {
      diag.warn("local.describe_malformed", { repoRef: described.repoRef });
      return json(502, { error: "the forge described that path in a shape ryph cannot store" });
    }
    const existing = (await store.listConnectedRepos())
      .find((r) =>
        r.provider === "local" && r.repoRef === described.repoRef && r.archivedAt === null
      );
    if (existing) return json(409, { error: `${described.repoRef} is already connected` });

    const at = nowIso();
    const repo: ConnectedRepo = {
      id: mintId("cr"),
      provider: "local",
      // No tenants: the forge reads its own disk as itself.
      installationId: null,
      repoRef: described.repoRef,
      // The path again, not "": `url` is what the gateway fetches from and what a workspace
      // entry, a delivery and the repo cache key are matched on (see connectRadicleRepo).
      url: described.url,
      defaultBranch: described.defaultBranch,
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

  /**
   * Connecting a GitHub repo when the forge acts through one person's token: no installation, so
   * the repo is any the token's owner may administer. The caller names it; whether it exists,
   * what GitHub calls it, its clone URL and its default branch are GitHub's answers, read live
   * through the forge — never the caller's, as the App path takes them from the installation.
   *
   * Admin on the repo, checked live as on the App path. In user mode the login asked about is
   * the token's for every active user (adapters/identity_directory/github_user_mode.ts), so this
   * is "may the token administer it": everyone here acts as that one person on GitHub. That
   * cannot tell ryph users apart, so `refuseRepoPermission` also wants repos:manage-all here.
   */
  const connectGithubRepoAsUser = async (
    caller: Principal,
    login: string,
    data: {
      repoRef: string;
      installationId: string | undefined;
      submissionPolicy: ConnectedRepo["submissionPolicy"];
    },
  ): Promise<Response> => {
    if (data.installationId !== undefined) {
      return json(400, {
        error: "GitHub acts through a user token here — a repo is connected without an " +
          "installation",
      });
    }
    if (!deps.githubUserConnect) {
      return json(503, { error: "the forge is not configured; connected repos are unavailable" });
    }
    // Against the row this is about to become, as the App path checks it: no tenant.
    const refused = await refuseRepoPermissionHere(caller, {
      id: "",
      provider: "github",
      installationId: null,
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

    let described: RepoListing | null;
    try {
      described = await deps.githubUserConnect.describeGithubRepo(data.repoRef);
    } catch (err) {
      diag.warn("github.describe_failed", { repo: data.repoRef, err: String(err) });
      return json(502, { error: "could not ask GitHub about that repository" });
    }
    if (described === null) {
      return json(404, { error: `@${login} cannot see a GitHub repository ${data.repoRef}` });
    }
    // The forge's answer is held to the spelling a GitHub address has before it becomes a row.
    if (!isRepoRef("github", described.fullName) || !URL.canParse(described.url)) {
      diag.warn("github.describe_malformed", { repo: data.repoRef });
      return json(502, {
        error: "the forge described that repository in a shape ryph cannot store",
      });
    }
    // GitHub answers a renamed repo under its new name. The admin check above was asked about
    // the name the caller sent, so a different repo name is refused rather than stored on the
    // strength of a check about another spelling; case alone is the same repo on GitHub.
    if (described.fullName.toLowerCase() !== data.repoRef.toLowerCase()) {
      return json(422, {
        error: `GitHub knows ${data.repoRef} as ${described.fullName} now — connect it by that ` +
          "name",
      });
    }
    // Case-blind, as GitHub is: "Acme/App" and "acme/app" are one repository. Only a row of
    // THIS mode counts: one left over from App mode names a tenant the forge refuses now, so it
    // is no connection anybody can use (`tenantFitsMode`).
    const existing = (await store.listConnectedRepos())
      .find((r) =>
        r.provider === "github" && r.archivedAt === null && r.installationId === null &&
        r.repoRef.toLowerCase() === described.fullName.toLowerCase()
      );
    if (existing) return json(409, { error: `${described.fullName} is already connected` });

    const at = nowIso();
    const repo: ConnectedRepo = {
      id: mintId("cr"),
      provider: "github",
      // No tenant: the forge acts with the one token it holds.
      installationId: null,
      repoRef: described.fullName,
      url: described.url,
      defaultBranch: described.defaultBranch,
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

  /**
   * Connecting a GitLab project: the path is read once for the project's id, and everything after
   * is asked of that id. Bot mode: the project must be one the bot reaches (its own listing —
   * membership at Developer or above — never the caller's word, as the App path takes a repo from
   * its installation), and the caller's linked GitLab account must hold Maintainer on it, asked
   * live. User mode: any project the token's owner maintains, read live, and
   * `repos:manage-all`, as GitHub's user mode (`refuseRepoPermission`). The answer carries the
   * webhook to paste in bot mode, and null in user mode, which takes no webhooks.
   */
  const connectGitlabRepo = async (
    caller: Principal,
    data: { repoRef: string; submissionPolicy: ConnectedRepo["submissionPolicy"] },
  ): Promise<Response> => {
    if (!deps.gitlabConnect || !deps.forge) {
      return json(503, { error: "no GitLab is configured" });
    }
    const gitlab = deps.gitlabConnect;
    const mode = await gitlabModeHere();
    if (mode === undefined) {
      return json(502, { error: "the forge did not say how it acts on GitLab" });
    }
    if (mode === null) return json(503, { error: "no GitLab is configured" });

    const sameProject = (p: GitlabProjectListing) =>
      p.pathWithNamespace.toLowerCase() === data.repoRef.toLowerCase();
    const notReached = () =>
      json(404, {
        error: mode.mode === "bot"
          ? `@${mode.login} is not a member of ${data.repoRef} — add it to the project as a ` +
            "Developer first"
          : `@${mode.login} cannot see a GitLab project ${data.repoRef}`,
      });
    // First which project the path names now — its id, one read — so every question after this
    // one is about that project, and never about whatever the path names by then.
    let described: GitlabProjectListing | null;
    try {
      described = await gitlab.describeGitlabProject(data.repoRef);
    } catch (err) {
      diag.warn("gitlab.describe_failed", { repo: data.repoRef, err: String(err) });
      return json(502, { error: "could not ask GitLab about that project" });
    }
    if (described === null) return notReached();
    // GitLab answers a moved project under its new path: connected by that one, so the row
    // names where the project is; case alone is the same project.
    if (!sameProject(described)) {
      return json(422, {
        error: `GitLab knows ${data.repoRef} as ${described.pathWithNamespace} now — connect ` +
          "it by that path",
      });
    }
    // Against the row this is about to become — no tenant in either mode, and the project by
    // its id: a path can be another project's by the time it is asked about. Before the bot's
    // listing, which walks pages.
    const refused = await refuseRepoPermissionHere(caller, {
      id: "",
      provider: "gitlab",
      installationId: null,
      repoRef: described.pathWithNamespace,
      url: "",
      defaultBranch: "",
      submissionPolicy: data.submissionPolicy,
      sizeClass: null,
      allowForkPushes: false,
      archivedAt: null,
      createdAt: "",
      updatedAt: "",
      forgeId: gitlabProjectRef(mode.url, described.id),
    }, "admin");
    if (refused) return refused;
    // In bot mode the project must also be in the bot's own reach, found there by its id: a
    // project merely visible to the bot is not one it can work in.
    let project: GitlabProjectListing | null = described;
    if (mode.mode === "bot") {
      try {
        project = (await gitlab.listGitlabProjects()).find((p) => p.id === described.id) ?? null;
      } catch (err) {
        diag.warn("gitlab.describe_failed", { repo: data.repoRef, err: String(err) });
        return json(502, { error: "could not ask GitLab about that project" });
      }
      if (project === null) return notReached();
    }
    if (project.defaultBranch === null) {
      return json(422, {
        error: `${project.pathWithNamespace} is empty — push a first commit, then connect it`,
      });
    }
    // The same project is the same id on the same instance, whatever path it was connected
    // under. A row of that id on another instance is another project — never this one's
    // connection — though its generations still count below: the token names no instance.
    const earlier = await store.listGitlabProjectsById(project.id);
    for (const held of earlier.filter((g) => g.instance === mode.url)) {
      const repo = await store.getConnectedRepo(held.connectedRepoId);
      if (repo !== null && repo.archivedAt === null) {
        return json(409, { error: `${project.pathWithNamespace} is already connected` });
      }
    }

    // The token before the row: a connect that cannot show the webhook it needs writes nothing.
    // Its generation is the one the row is about to draw — past every earlier connection's, so
    // a token shown before an archive does not verify again.
    const generation = Math.max(0, ...earlier.map((g) => g.hookGeneration)) + 1;
    let webhook: GitlabWebhookSetup | null = null;
    if (mode.mode === "bot") {
      try {
        webhook = await gitlabWebhookFor(project, generation);
      } catch (err) {
        diag.warn("gitlab.hook_token_failed", {
          repo: project.pathWithNamespace,
          err: String(err),
        });
        return json(502, { error: "the forge did not give the project's webhook token" });
      }
    }

    const at = nowIso();
    const repo: ConnectedRepo = {
      id: mintId("cr"),
      provider: "gitlab",
      // GitLab has no tenants: the forge acts with the one token it holds, bot's or person's.
      installationId: null,
      repoRef: project.pathWithNamespace,
      url: project.url,
      defaultBranch: project.defaultBranch,
      submissionPolicy: data.submissionPolicy,
      sizeClass: null,
      allowForkPushes: false,
      archivedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    await store.createConnectedRepo(repo);
    const held = await store.createGitlabProject(repo.id, project.id, mode.url, at);
    if (webhook !== null && held.hookGeneration !== generation) {
      // Another connection of the project drew in between: the row's generation is the one.
      // Connected either way — the repo page shows the webhook again, to a Maintainer.
      webhook = await gitlabWebhookFor(project, held.hookGeneration).catch(() => null);
    }
    return json(201, { repo, webhook });
  };

  return {
    githubModeHere,
    gitlabModeHere,
    gitlabWebhookFor,
    placeGitlabRepo,
    refreshGitlabPlace,
    connectGitlabRepo,
    refuseInUserMode,
    followCommands,
    radicleRepoInfo,
    connectRadicleRepo,
    connectLocalRepo,
    connectGithubRepoAsUser,
  };
}

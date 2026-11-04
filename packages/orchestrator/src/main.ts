// The STANDALONE composition root — the orchestrator alone, for the networked deployment
// where each service is its own process. The default local deployment is @ryph/host,
// which mounts this package's handler next to auth and the model-proxy control side.
// This file knows which adapter stands behind each port, reads the environment,
// owns the listening socket, and runs the reaper on its interval.

import {
  AuthConfigError,
  drizzleAuthStore,
  multiUserFromEnv,
  scopeAuthDb,
  setup as setupAuth,
  setupTokenNotice,
  smtpMailer,
  type Verifier,
  verifierFromUrl,
} from "@ryph/auth";
import { openDbCluster } from "@ryph/db";
import {
  installDrain,
  makeHealth,
  refusePublicDevSecrets,
  serve,
  trackStreams,
} from "@ryph/service";
import { Logger, setupLoggerFromEnv } from "@ryph/logger";
import { makeHandler } from "./http/app.ts";
import { makeAuthenticate } from "@ryph/auth/gates";
import { sweep, sweepPatches, sweepProgressComments } from "./core/reaper.ts";
import { DEFAULT_PATCH_SUBMIT_CONFIG } from "./core/patch_lifecycle.ts";
import { DEFAULT_MERGE_POLL_CONFIG } from "./core/merge_poll.ts";
import type { TaskStore } from "./ports/task_store.ts";
import type { Provisioner } from "./ports/provisioner.ts";
import type {
  Forge,
  ForgeChecks,
  ForgeConnect,
  ForgePatchDiffs,
  ForgeSkills,
  GithubConnect,
  GithubUserConnect,
  GitlabConnect,
  LocalConnect,
  RadicleConnect,
} from "./ports/forge.ts";
import type { ModelAccess, ToolAccess } from "./http/app.ts";
import { loggerDiagnostics } from "./adapters/diagnostics/logger.ts";
import { authStoreIdentityDirectory } from "./adapters/identity_directory/auth_store.ts";
import { forgeUserModeDirectory } from "./adapters/identity_directory/forge_user_mode.ts";
import { forgeIdentityProvider } from "./adapters/identity_provider/forge.ts";
import { radicleChallengeProvider } from "./adapters/challenge_provider/radicle.ts";
import { noopForge } from "./adapters/forge/noop.ts";
import { httpForge } from "./adapters/forge/http.ts";
import { type GithubModeSource, githubModeSource } from "./adapters/forge/github_mode.ts";
import { type GitlabModeSource, gitlabModeSource } from "./adapters/forge/gitlab_mode.ts";
import { drizzleTaskStore } from "./adapters/store/drizzle.ts";
import { scopeDb } from "./adapters/store/db/db.ts";
import {
  kubernetesOptionsFromEnv,
  kubernetesProvisioner,
} from "./adapters/provisioner/kubernetes.ts";
import { manualProvisioner } from "./adapters/provisioner/manual.ts";
import { httpRunnerControl } from "./adapters/runner_control/http.ts";
import { concludeOnTerminal } from "./conclude_on_terminal.ts";
import { publishTaskChanges } from "./publish_task_changes.ts";
import { postgresTaskFeed } from "./adapters/task_feed/postgres.ts";
import { httpConcludeNotifier } from "./adapters/history_notify/http.ts";
import { httpModelAccess } from "./adapters/model_access/http.ts";
import { httpPlatformCredentials, proxyPlatformModel } from "./adapters/platform_model/proxy.ts";
import type { PlatformModel } from "./ports/platform_model.ts";
import { httpToolAccess } from "./adapters/tool_access/http.ts";
import { httpPreviews } from "./adapters/previews/http.ts";
import type { PreviewsService } from "./ports/previews.ts";
import { httpMemoryAccess } from "./adapters/memory_access/http.ts";
import type { MemoryAccess } from "./ports/memory_access.ts";
import { httpChatAccess } from "./adapters/chat_access/http.ts";
import type { ChatAccess } from "./ports/chat_access.ts";
import { makeInboxSignal } from "./core/inbox_signal.ts";
import {
  PLATFORM_CHAT_SERVER_ID,
  PLATFORM_FORGE_SERVER_ID,
  PLATFORM_MEMORY_SERVER_ID,
  PLATFORM_WEB_SERVER_ID,
} from "@ryph/mcp-gateway/platform";
import { servicePolicyFromEnv, serviceRoom } from "./core/services.ts";
import { browserConfigFromEnv, browserOffered, browserPosture } from "./core/browser.ts";
import { egressKeyFromEnv, egressPolicyFromEnv, unwiredEgressWarning } from "./core/egress.ts";
import { directoryServiceCatalogue } from "./adapters/service_catalogue/directory.ts";
import { directorySkillCatalogue } from "./adapters/skill_catalogue/directory.ts";
import { drizzleSkillStore } from "./adapters/store/drizzle_skills.ts";
import { syncOrgSkills } from "./core/skills_sync.ts";
import type { SkillCatalogue } from "./ports/skill_catalogue.ts";
import { runSizesFromEnv } from "./core/run_sizes.ts";
import { makeCapacityReconciler } from "./core/reserved_capacity.ts";
import { deploymentLimitsFromEnv } from "./core/run_limits.ts";
import { environmentsConfigFromEnv, harnessKindsFromEnv } from "./core/environment_config.ts";
import type { ServiceCatalogue } from "./ports/service_catalogue.ts";
import type { AppConfig } from "./http/app.ts";
import { drizzleEnvironmentStore } from "./adapters/store/drizzle_environments.ts";
import { createEnvironmentBuilder } from "./adapters/environment_builder/mod.ts";
import { buildLogStoreFromEnv } from "./adapters/build_log/patch_store.ts";
import { attachmentStoreFromEnv } from "./adapters/attachment_store/patch_store.ts";
import { type WiredEnvironments, wireEnvironments } from "./environments.ts";
import { checkPolicyFromEnv } from "./core/check_policy.ts";
import { remoteChecksConfigFromEnv } from "./core/remote_checks_config.ts";
import type { ChecksService } from "./core/checks.ts";
import { wireChecks, type WiredChecks } from "./checks.ts";
import { drizzleCheckStore } from "./adapters/store/drizzle_checks.ts";
import { drizzleBackgroundStore } from "./adapters/store/drizzle_background.ts";
import { drizzleArtifactStore } from "./adapters/store/drizzle_artifacts.ts";
import { processArtifactHtml } from "./adapters/artifact_html/process_preparer.ts";
import { artifactThumbnailFromEnv } from "./adapters/artifact_html/http_thumbnail.ts";
import { socketArtifactHtml } from "./adapters/artifact_html/socket_preparer.ts";
import type { CheckLauncher } from "./ports/check_launcher.ts";
import { kubernetesCheckLauncher } from "./adapters/check_launcher/kubernetes.ts";
import {
  awaitLauncherInfo,
  awaitLauncherToken,
  engineAbsentWarning,
  gateCoverage,
  launcherCallerRefusal,
  type LauncherClients,
  launcherClients,
  type LauncherInfo,
} from "./adapters/launcher/mod.ts";
import type { ImagePrefetch } from "./ports/image_prefetch.ts";
import { awaitPlatformServer, platformToolServers } from "./helpers/platform_server.ts";

const env = (name: string): string | undefined => process.env[name] || undefined;

// Advisory lock keys. They must be unique across every schema that can share ONE database,
// because Mode A puts all four in one — so they are numbered here, in the only file that takes
// them, rather than derived from anything. FIXED for the same reason a channel name is: change
// one during a rolling deploy and the old replica and the new one both believe they are alone.
const LOCK_LIVENESS_SWEEP = 8_100_001;
const LOCK_PATCH_SWEEP = 8_100_002;
const LOCK_PROGRESS_SWEEP = 8_100_003;
const LOCK_ENV_RECONCILE = 8_100_004;
// 8_100_005 is the store's: task creation counts live runs under it (`CREATE_TASK_LOCK`).
const LOCK_CHECK_SWEEP = 8_100_006;
// 8_100_007 was reserved capacity's; its Lease (adapters/provisioner/kubernetes.ts) replaced it.
// 8_100_008 is the skills store's: a sync's write runs under it (`SKILLS_SYNC_TX_LOCK`).
const LOCK_SKILLS_RECONCILE = 8_100_009;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

const intEnv = (name: string, fallback: number): number => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};

/** Like `intEnv`, but zero is a meaningful answer — "no pause", "no deadline". */
const msEnv = (name: string, fallback: number): number => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    fail(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};

export async function main(): Promise<void> {
  refusePublicDevSecrets("control-plane");
  const port = intEnv("RYPH_PORT", 7411);
  setupLoggerFromEnv();
  const log = new Logger("orchestrator");
  const diag = loggerDiagnostics("orchestrator");

  // RYPH_DB is a ryph database URL (see @ryph/db): `pglite:<path>`, `pglite:memory://`
  // or `postgres://…`. All three are real PostgreSQL, so there is no longer a store
  // implementation that exists only for local convenience.
  // The schema is applied with drizzle-kit, never here: `bun run db:push` locally, generated
  // migrations on deployments — on Kubernetes an init container in this pod, under an advisory
  // lock (deploy/helm/ryph, README "Migrations"), rather than an entrypoint step, since N
  // replicas migrating at boot would race.
  //
  // A CLUSTER, not a handle: this process owns two modules' tables (its own and auth's, which
  // live in the control plane's database in both deployments) and they must share ONE connection.
  // Two PGlite instances pointed at one data directory both open and then silently stop seeing
  // each other's writes — the reason `scope` exists at all.
  const dbUrl = env("RYPH_DB") ?? "pglite:./data/ryph";
  const cluster = await openDbCluster(dbUrl);
  const dbHandle = scopeDb(cluster);
  const baseStore: TaskStore = drizzleTaskStore(dbHandle);
  try {
    await baseStore.listTasks({ limit: 1 });
  } catch (err) {
    // The handle's description is password-redacted; the raw URL never reaches a log.
    fail(
      `database ${dbHandle.description} did not answer the startup probe ` +
        `(${err instanceof Error ? err.message : String(err)}) — if it has no schema, run ` +
        "`bun run db:push` in packages/orchestrator. On Kubernetes the pod's `migrate` init " +
        "container applies it before this starts: read its log (`kubectl logs <pod> -c migrate`). " +
        "If the database did not answer at all, check RYPH_DB and the NetworkPolicy to the database",
    );
  }

  // The historian, as THIS PROCESS dials it (RYPH_HISTORY_URL). Null: the historian is mounted
  // in-process by the host, so this standalone orchestrator announces conclusions to no one. Set:
  // a standalone historian, and every terminal run is announced to it so it can hang up that run's
  // tails and stop its ingest. RYPH_HISTORY_TOKEN guards both legs — this conclude ping and the
  // historian's inbound run-token verify — exactly as RYPH_FORGE_TOKEN guards the forge link.
  const historyUrl = env("RYPH_HISTORY_URL")?.replace(/\/+$/, "") ?? null;
  // The historian as a RUN dials it, to post its transcript: RYPH_RUN_HISTORY_URL, else the same
  // address. Apart only where runs reach the services by another way than this process does —
  // the docker launcher's run gate (deploy/compose-networked) — as a build's clone address
  // (RYPH_ENV_GIT_GATEWAY_URL) sits beside the run's (RYPH_GIT_GATEWAY_URL), so this process's own
  // conclude pings never ride the gate. Read only beside RYPH_HISTORY_URL: alone it names a historian nobody
  // announces conclusions to.
  const runHistoryUrl = historyUrl === null
    ? null
    : env("RYPH_RUN_HISTORY_URL")?.replace(/\/+$/, "") ?? historyUrl;
  if (historyUrl === null && env("RYPH_RUN_HISTORY_URL") !== undefined) {
    fail("RYPH_RUN_HISTORY_URL is the run-facing half of RYPH_HISTORY_URL, which is unset");
  }
  const historyToken = env("RYPH_HISTORY_TOKEN") ?? null;
  // The web app's origin as a BROWSER reaches it — run links in outward-facing text. Unset:
  // links are simply omitted; nothing else darkens. Read exactly as @ryph/host's appUrlFromEnv.
  const appUrl = env("RYPH_APP_URL")?.trim().replace(/\/+$/, "") || null;
  let store: TaskStore = baseStore;
  if (historyUrl !== null) {
    if (historyToken === null) {
      fail(
        "RYPH_HISTORY_URL is set but RYPH_HISTORY_TOKEN is not — verify and conclude are both dark",
      );
    }
    store = concludeOnTerminal(baseStore, httpConcludeNotifier({ historyUrl, historyToken, diag }));
  }

  // A second terminal hook, this process's own: a run going terminal kicks the progress sweep
  // (wired below, once the sweep exists) so a forge thread's final comment lands in
  // milliseconds instead of a reaper tick later. The edit itself stays IN the sweep —
  // idempotent, retried, serialized — this hook only hurries it.
  let kickProgressSweep: () => void = () => {};
  store = concludeOnTerminal(store, () => kickProgressSweep());

  // Hosted previews: the previews service's API listener (RYPH_PREVIEWS_URL), its tunnel listener
  // as a run reaches it (RYPH_RUN_PREVIEWS_URL, the base of the runner's tunnel URL: a port of its
  // own, since runs must not reach the API one) and the shared RYPH_PREVIEWS_TOKEN. Gated on the
  // URL: the token may sit in the Secret of a cell with no preview domain, and without the URL the
  // preview routes are not mounted and the runner's probe is a 404. A third terminal hook closes a
  // concluded run's previews at once, fire and forget (the DELETE is idempotent, so a terminal
  // run saved twice costs a second one) — the run pod's death closes its tunnel anyway, this
  // only stops the dead preview being listed meanwhile.
  const previewsUrl = env("RYPH_PREVIEWS_URL")?.replace(/\/+$/, "") ?? null;
  const runPreviewsUrl = env("RYPH_RUN_PREVIEWS_URL")?.replace(/\/+$/, "") ?? null;
  if (previewsUrl === null && runPreviewsUrl !== null) {
    fail("RYPH_RUN_PREVIEWS_URL is the run-facing half of RYPH_PREVIEWS_URL, which is unset");
  }
  const previewsToken = env("RYPH_PREVIEWS_TOKEN") ?? null;
  let previews: PreviewsService | null = null;
  if (previewsUrl !== null) {
    if (previewsToken === null) {
      fail("RYPH_PREVIEWS_URL without RYPH_PREVIEWS_TOKEN — the previews service would refuse us");
    }
    if (runPreviewsUrl === null) {
      fail(
        "RYPH_PREVIEWS_URL without RYPH_RUN_PREVIEWS_URL — runners dial the previews service's " +
          "tunnel listener, which is not its API one",
      );
    }
    if (!/^https?:\/\//.test(previewsUrl)) fail("RYPH_PREVIEWS_URL must be an http(s) URL");
    if (!/^https?:\/\//.test(runPreviewsUrl)) fail("RYPH_RUN_PREVIEWS_URL must be an http(s) URL");
    // With several previews replicas (RYPH_PREVIEWS_PEER_HOST, the chart sets it beside the
    // service's own), a runner dials its run's replica by that replica's own Service, on the
    // tunnel port, and only such an address is taken from the service.
    const service = httpPreviews({
      previewsUrl,
      tunnelUrl: runPreviewsUrl,
      replicaHost: env("RYPH_PREVIEWS_PEER_HOST"),
      previewsToken,
      diag,
    });
    previews = service;
    store = concludeOnTerminal(store, (runId) => service.closeRun(runId));
  }

  // The task list's live tails. On Postgres LISTEN/NOTIFY rather than an in-process set, because
  // THIS process is the one a deployment scales: a list open on one replica must move for a run
  // heartbeating on another. The decorator below is what makes every write announce itself.
  // Guarded like the startup probe above, and for the same reason: this opens a LISTEN
  // connection of its own, so a database that refuses it fails HERE, at boot, and must say so
  // the way every other boot failure does. Unguarded it would be a raw driver stack — which
  // carries the connection URL, password and all, into the log.
  const taskFeed = await postgresTaskFeed({
    notify: dbHandle.notify,
    listen: dbHandle.listen,
    diag,
  }).catch((err: unknown) =>
    // `fail` exits, so this narrows back to the feed's own type — no `let` and no non-null
    // assertion to keep in step with it.
    fail(
      `database ${dbHandle.description} would not open the task feed's LISTEN connection ` +
        `(${err instanceof Error ? err.message : String(err)}) — the task list's live tails ` +
        "cannot be served without it",
    )
  );
  store = publishTaskChanges(store, taskFeed);

  // The forge as THIS PROCESS dials it (permission checks, PR submission, OAuth exchange) —
  // distinct from RYPH_GIT_GATEWAY_URL, which is the same server as a container sees it.
  // "noop" wires the recording fake: the whole patch lifecycle runs end to end with no
  // GitHub anywhere (permission checks allow, submissions "succeed" with fake PR refs).
  const forgeUrl = env("RYPH_FORGE_URL") ?? null;
  const forgeToken = env("RYPH_FORGE_TOKEN") ?? null;
  let forge: Forge | null = null;
  // Checks' forge surface, off the `Forge` port (ports/forge.ts): the same adapter, when one.
  let forgeChecks: ForgeChecks | null = null;
  // A patch's diff for its reviewer, off the port for the same reason.
  let patchDiffs: ForgePatchDiffs | null = null;
  // The org skills repo's read, off the `Forge` port for the same reason.
  let forgeSkills: ForgeSkills | null = null;
  // GitHub's own connect surface, beside the forge-agnostic port: installations and OAuth are
  // GitHub's concepts, so the connect routes ask for them separately (ports/forge.ts).
  let githubConnect: GithubConnect | null = null;
  // …and its user-mode counterpart: the token owner's repos, where there is no installation.
  let githubUserConnect: GithubUserConnect | null = null;
  // GitLab's: the projects the forge's token reaches and their webhook tokens. The forge answers
  // 501 where it runs no GitLab, so this is wired whenever a real forge is.
  let gitlabConnect: GitlabConnect | null = null;
  // Sign-in by forge (GitHub's and GitLab's OAuth): GitLab's half needs a real forge.
  let forgeConnect: ForgeConnect | null = null;
  // Radicle's, likewise: seeding and identity documents. The forge answers 501 on these when
  // no bridge is wired, and the routes that need them say so — so wiring them unconditionally
  // beside the forge is honest, and `GET /v1/forge-providers` is what says whether they work.
  let radicleConnect: RadicleConnect | null = null;
  // The local provider's: whether a path on the forge's disk is a repository it may read. The
  // forge answers 501 when it has no local provider, so this too is wired whenever a forge is.
  let localConnect: LocalConnect | null = null;
  if (forgeUrl === "noop") {
    log.warn("RYPH_FORGE_URL=noop — forge calls are recorded, nothing reaches GitHub");
    const noop = noopForge(diag);
    forge = noop;
    forgeChecks = noop;
    patchDiffs = noop;
    forgeSkills = noop;
    githubConnect = noop;
    githubUserConnect = noop;
    radicleConnect = noop;
    localConnect = noop;
  } else if (forgeUrl !== null) {
    if (forgeToken === null) {
      fail("RYPH_FORGE_URL is set but RYPH_FORGE_TOKEN is not — the forge would refuse us");
    }
    const http = httpForge({ baseUrl: forgeUrl, forgeToken, diag });
    forge = http;
    forgeChecks = http;
    patchDiffs = http;
    forgeSkills = http;
    githubConnect = http;
    githubUserConnect = http;
    gitlabConnect = http;
    forgeConnect = http;
    radicleConnect = http;
    localConnect = http;
  }
  // App or user token: the forge's to say (adapters/forge/github_mode.ts). Asked now without
  // waiting, so the sign-in page knows before its first visit when the forge is up, and a forge
  // that is not up yet delays nothing here.
  const githubMode: GithubModeSource | null = forge === null
    ? null
    : githubModeSource({ forge, diag });
  githubMode?.get().catch((err) => diag.warn("forge.github_mode_unanswered", { err: String(err) }));
  // GitLab's likewise: a bot or one person's token, the forge's to say.
  const gitlabMode: GitlabModeSource | null = forge === null
    ? null
    : gitlabModeSource({ forge, diag });
  gitlabMode?.get().catch((err) => diag.warn("forge.gitlab_mode_unanswered", { err: String(err) }));

  // @ryph/auth is MOUNTED here: this process is the control plane, and the control plane is
  // orchestrator plus auth. Auth's tables already live in the control plane's database (see its
  // schema.ts), the app's login round trip and the user surface it gates are the same origin, and
  // a separate process would only add a second holder of the signing key.
  //
  // RYPH_AUTH_URL remains, and now means the opposite of what it did: point it at ANOTHER
  // issuer to verify against that one's JWKS instead of the mounted service. The sibling services
  // — historian, model-proxy — point theirs at THIS process.
  const authDisabled = env("RYPH_AUTH") === "off";
  if (authDisabled) log.warn("RYPH_AUTH=off — the user surface is OPEN");
  const authStore = drizzleAuthStore(scopeAuthDb(cluster));
  let multiUser = true;
  try {
    multiUser = multiUserFromEnv(env, true);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const smtpUrl = env("RYPH_SMTP_URL") ?? null;
  const mailFrom = env("RYPH_MAIL_FROM") ?? null;
  if ((smtpUrl === null) !== (mailFrom === null)) {
    fail("RYPH_SMTP_URL and RYPH_MAIL_FROM go together — set both or neither");
  }
  const auth = await setupAuth({
    store: authStore,
    now: () => new Date(),
    identityProvider: githubConnect === null || githubMode === null
      ? null
      : forgeIdentityProvider({ githubConnect, store, githubMode, forgeConnect, gitlabMode }),
    // Radicle proves an identity by a signed challenge rather than an OAuth redirect, so it is
    // a second, separate port — and never offered as a way IN: there is no account to sign in
    // to on the other side.
    challengeProvider: radicleConnect === null ? null : radicleChallengeProvider(),
    mailer: smtpUrl === null || mailFrom === null
      ? null
      : smtpMailer({ url: smtpUrl, from: mailFrom }),
    appUrl,
    onMailError: (err) => diag.warn("auth.mail_failed", { err: String(err) }),
    // A networked deployment is many people's by default; RYPH_MULTIUSER=off narrows it to one.
    multiUser,
    // Set on this and on the app alike, the client address a session records is the app's word
    // only. Multi-user, setup refuses to start without it: x-client-ip would be taken from any
    // caller that reaches this listener, and a run could pick the address its sign-in rate
    // limits are keyed on. Compose, the k8s overlays and the GKE render all set it. With
    // RYPH_AUTH=off nobody signs in, so nothing needs it.
    proxySecret: env("RYPH_PROXY_SECRET") ?? null,
    requireProxySecret: !authDisabled,
  })
    .catch((err) => {
      if (err instanceof AuthConfigError) fail(err.message);
      fail(
        `auth could not start — is the schema applied? (${
          err instanceof Error ? err.message : err
        })`,
      );
    });
  // Every replica prints one while nobody has registered; any of them admits any of them. With
  // RYPH_AUTH=off there is nothing to claim.
  if (!authDisabled && auth.setupToken !== null) {
    log.warn(setupTokenNotice(auth.setupToken, appUrl));
  }
  // Single-user is the local binary's mode, where the owner is made at boot and signs in by a
  // link `ryph login` mints. Neither exists here, so off only narrows an instance already claimed,
  // and only one whose owner has a way in besides a link (ownerCanSignIn, which is also true of
  // an empty instance, hence the count first). With RYPH_AUTH=off nobody signs in at all, so
  // neither is asked (as the host's ownerLockout).
  if (!authDisabled && !multiUser && (await authStore.countUsers()) === 0) {
    fail("RYPH_MULTIUSER=off on an instance with no owner leaves nobody able to sign in");
  }
  if (!authDisabled && !multiUser && !(await auth.ownerCanSignIn())) {
    fail(
      "RYPH_MULTIUSER=off, but no owner of this instance has a password or a passkey, and this " +
        "deployment has no login links: single-user here needs an owner with one. Set a password " +
        "on the account page first, or keep RYPH_MULTIUSER on.",
    );
  }
  const authUrl = env("RYPH_AUTH_URL");
  if (authUrl && !URL.canParse("/.well-known/jwks.json", authUrl)) {
    fail(`RYPH_AUTH_URL must be a valid absolute URL, got ${JSON.stringify(authUrl)}`);
  }
  // The mounted issuer verifies its own tokens with no network hop at all; an explicit
  // RYPH_AUTH_URL overrides that, for a deployment federating on someone else's issuer.
  const verifier: Verifier = authUrl
    ? verifierFromUrl(new URL("/.well-known/jwks.json", authUrl).href)
    : auth.verifier;
  if (authUrl) {
    log.warn(`RYPH_AUTH_URL set — verifying against ${authUrl}, not the mounted issuer`);
  }
  const authenticate = makeAuthenticate({
    verifier,
    disabled: authDisabled,
  });

  // Linked identities are auth's rows, in this same database; the control plane reads them
  // through the directory port rather than joining across packages.
  // In GitHub's or GitLab's user mode, every active user's login there is the token's — folded
  // in here, once, rather than at each call site that asks.
  const linkedIdentities = authStoreIdentityDirectory(authStore, {
    gitlab: gitlabMode,
    gitlabUsers: gitlabConnect,
  });
  const identityDirectory = githubMode === null && gitlabMode === null
    ? linkedIdentities
    : forgeUserModeDirectory(linkedIdentities, { github: githubMode, gitlab: gitlabMode });

  // Model access, as a networked link: the model-proxy's CONTROL listener, service-authed with
  // the shared RYPH_MODEL_PROXY_TOKEN. Gated on the URL — a token alone describes no peer to
  // dial — and dark without it, which is the deployment where agents with a model policy are
  // refused at creation. RYPH_MODEL_PROXY_URL (what an agent container dials) is NOT read
  // here: the proxy builds the container's env itself, because it is the one that knows.
  const modelProxyUrl = env("RYPH_MODEL_PROXY_CONTROL_URL")?.replace(/\/+$/, "") ?? null;
  const modelProxyToken = env("RYPH_MODEL_PROXY_TOKEN") ?? null;
  let modelAccess: ModelAccess | null = null;
  if (modelProxyUrl !== null) {
    if (modelProxyToken === null) {
      fail(
        "RYPH_MODEL_PROXY_CONTROL_URL without RYPH_MODEL_PROXY_TOKEN — the proxy's internal " +
          "surface would refuse us",
      );
    }
    modelAccess = httpModelAccess({ modelProxyUrl, modelProxyToken, diag });
  } else {
    log.warn(
      "RYPH_MODEL_PROXY_CONTROL_URL unset — model access is off, and agents with a model " +
        "policy are refused at creation",
    );
  }

  // The platform's background model, for the titles of tasks nobody named (core/titles.ts): a
  // credential minted on the proxy's platform route with RYPH_PLATFORM_TOKEN — memory's pattern,
  // and a credential that can mint platform credentials and nothing else — spent on the proxy's
  // data plane as THIS process dials it (RYPH_MODEL_PROXY_DATA_URL; not RYPH_MODEL_PROXY_URL,
  // which is the address an agent container dials). Without all three, every task keeps the
  // first line of its instructions as its title.
  const platformToken = env("RYPH_PLATFORM_TOKEN") ?? null;
  const modelProxyDataUrl = env("RYPH_MODEL_PROXY_DATA_URL") ?? null;
  const platformModel: PlatformModel | null =
    modelProxyUrl !== null && platformToken !== null && modelProxyDataUrl !== null
      ? proxyPlatformModel({
        proxyUrl: modelProxyDataUrl,
        credentials: httpPlatformCredentials({
          controlUrl: modelProxyUrl,
          token: platformToken,
          consumer: "titles",
        }),
        diag,
      })
      : null;
  if (platformModel === null) {
    log.warn(
      "RYPH_MODEL_PROXY_CONTROL_URL, RYPH_MODEL_PROXY_DATA_URL and RYPH_PLATFORM_TOKEN are not " +
        "all set — tasks nobody titled keep the first line of their instructions",
    );
  }

  // Tool access, the same link one credential class over: the mcp-gateway's CONTROL listener,
  // service-authed with the shared RYPH_MCP_GATEWAY_TOKEN. Gated on the URL for the same
  // reason, and dark without it — agents with a tool policy are then refused at creation.
  // RYPH_MCP_GATEWAY_URL (what an agent container dials) is the gateway's to read, not ours:
  // it builds the per-server URLs itself, because it is the one that knows.
  const mcpGatewayUrl = env("RYPH_MCP_GATEWAY_CONTROL_URL")?.replace(/\/+$/, "") ?? null;
  const mcpGatewayToken = env("RYPH_MCP_GATEWAY_TOKEN") ?? null;
  let toolAccess: ToolAccess | null = null;
  if (mcpGatewayUrl !== null) {
    if (mcpGatewayToken === null) {
      fail(
        "RYPH_MCP_GATEWAY_CONTROL_URL without RYPH_MCP_GATEWAY_TOKEN — the gateway's " +
          "internal surface would refuse us",
      );
    }
    toolAccess = httpToolAccess({
      gatewayControlUrl: mcpGatewayUrl,
      gatewayToken: mcpGatewayToken,
      diag,
    });
  } else {
    log.warn(
      "RYPH_MCP_GATEWAY_CONTROL_URL unset — tool access is off, and agents with a tool " +
        "policy are refused at creation",
    );
  }

  // Memory, as a networked link: the memory service's listener, service-authed with the shared
  // RYPH_MEMORY_TOKEN. Gated on the URL like its siblings, and dark without it — runs then
  // start without a brief and the platform's memory server is never scoped. The platform entry
  // rides every remembering agent's runs only when tool access is on as well: the gateway is
  // what mints its credential and forwards its calls.
  const memoryUrl = env("RYPH_MEMORY_URL")?.replace(/\/+$/, "") ?? null;
  const memoryToken = env("RYPH_MEMORY_TOKEN") ?? null;
  let memoryAccess: MemoryAccess | null = null;
  if (memoryUrl !== null) {
    if (memoryToken === null) {
      fail("RYPH_MEMORY_URL without RYPH_MEMORY_TOKEN — the memory service would refuse us");
    }
    memoryAccess = httpMemoryAccess({ memoryUrl, memoryToken, diag });
  } else {
    log.warn("RYPH_MEMORY_URL unset — memory is off; runs start without a brief");
  }
  const platformMemoryServerId = memoryAccess !== null && toolAccess !== null
    ? PLATFORM_MEMORY_SERVER_ID
    : null;

  // Chat, as a networked link: the chat service's listener, service-authed with the shared
  // RYPH_CHAT_TOKEN — one token for one link, both directions: this process binds rooms and
  // reports conclusions with it, and the chat service posts a room's mentions into a run's
  // inbox with it. Gated on the URL like its siblings, and dark without it — responses then
  // open without a room, and the chat surface is not mounted. The platform's chat server joins
  // a bound run's tool scope only when tool access is on as well: the gateway is what forwards
  // the agent's posts.
  const chatUrl = env("RYPH_CHAT_URL")?.replace(/\/+$/, "") ?? null;
  const chatToken = env("RYPH_CHAT_TOKEN") ?? null;
  let chatAccess: ChatAccess | null = null;
  if (chatUrl !== null) {
    if (chatToken === null) {
      fail("RYPH_CHAT_URL without RYPH_CHAT_TOKEN — the chat service would refuse us");
    }
    chatAccess = httpChatAccess({ chatUrl, chatToken, diag });
  } else {
    log.warn("RYPH_CHAT_URL unset — chat is off; responses open without a chatroom");
  }
  const platformChatServerId = chatAccess !== null && toolAccess !== null
    ? PLATFORM_CHAT_SERVER_ID
    : null;
  // One wake-up signal for the whole process: the routes that post messages and the runner's
  // poll must share it, and so must the sweeps that post a patch's progress.
  const inbox = makeInboxSignal();

  // The forge git gateway pair. RYPH_GIT_GATEWAY_URL is the gateway address AS AN AGENT
  // CONTAINER dials it (with the docker provisioner on Docker Desktop this usually needs to
  // be http://host.docker.internal:7412); when set, every new run clones through the gateway
  // with a run-scoped virtual key and its work leaves as a bundle. RYPH_FORGE_TOKEN is the
  // shared service credential the gateway presents to resolve those keys — a gateway without
  // it can serve nobody, so setting one without the other is bad config, not a degraded mode.
  const gitGatewayUrl = env("RYPH_GIT_GATEWAY_URL")?.replace(/\/+$/, "") ?? null;
  const automationsToken = env("RYPH_AUTOMATIONS_TOKEN") ?? null;
  if (gitGatewayUrl !== null && forgeToken === null) {
    fail(
      "RYPH_GIT_GATEWAY_URL is set but RYPH_FORGE_TOKEN is not — the gateway could not resolve any run's credential",
    );
  }

  // A forge with no gateway would connect repos that no run can clone: the gateway is the only
  // way a run reaches a repository, so the pair is configured together or the boot says so.
  if (forgeUrl !== null && forgeUrl !== "noop" && gitGatewayUrl === null) {
    fail(
      "RYPH_FORGE_URL is set but RYPH_GIT_GATEWAY_URL is not — runs reach repositories only " +
        "through the forge's git gateway, so no task could start",
    );
  }

  // Direct-git mode is gone: a deployment-wide token in a run's environment is the agent's to
  // read. Refused rather than ignored, so a deployment still configured for it learns why.
  if (env("RYPH_GIT_CREDENTIAL_ORIGIN") || env("RYPH_GIT_CREDENTIAL_TOKEN")) {
    fail(
      "RYPH_GIT_CREDENTIAL_ORIGIN / RYPH_GIT_CREDENTIAL_TOKEN are no longer supported: connect " +
        "the repository through the forge (GitHub, Radicle, or a local repository) and runs " +
        "reach it through the git gateway (RYPH_GIT_GATEWAY_URL). Unset them.",
    );
  }

  // Forge tools and web tools: both are wired into the GATEWAY (RYPH_FORGE_TOOLS_URL,
  // RYPH_WEB_URL there), so this process cannot see for itself whether they are served and is
  // told — RYPH_FORGE_TOOLS=on, RYPH_WEB_TOOLS=on. A flag is an assertion about another process,
  // so it is checked rather than believed: a row scoped into runs that the gateway does not hold
  // fails those runs at their boot credential mint, and a forge-policied run would lose its
  // memory and chat tools with it.
  //
  // WHAT IS CHECKED HERE, AND WHAT IS NOT. The env part — the flag needs tool access, and forge
  // tools need a forge — is configuration, known now, and fatal now. The gateway part is a
  // network call that may have to WAIT for the gateway's seed, and it happens after the listener
  // is up (see resolvePlatformTools below): two 60-second waits in front of serve() is a
  // process that answers no probe for two minutes, which the liveness probe ends at one. A slug
  // conflict on the gateway must not become a CrashLoopBackOff here.
  const forgeToolsClaimed = env("RYPH_FORGE_TOOLS") === "on";
  const webToolsClaimed = env("RYPH_WEB_TOOLS") === "on";
  if (forgeToolsClaimed) {
    if (toolAccess === null) fail("RYPH_FORGE_TOOLS=on needs tool access (RYPH_MCP_GATEWAY_*)");
    if (forge === null || forgeToken === null) {
      fail("RYPH_FORGE_TOOLS=on needs a forge (RYPH_FORGE_URL and RYPH_FORGE_TOKEN)");
    }
  }
  if (webToolsClaimed && toolAccess === null) {
    fail("RYPH_WEB_TOOLS=on needs tool access (RYPH_MCP_GATEWAY_*)");
  }
  // Nothing served until the gateway says so. `webServerId` is known whatever the answer: an
  // agent's tool policy may name the web row even where the tools are off, and dropping that
  // entry needs the id (see composeToolScope).
  const platformTools = platformToolServers(PLATFORM_WEB_SERVER_ID);
  platformTools.pending = forgeToolsClaimed || webToolsClaimed;

  /**
   * Asks the gateway which platform rows it holds, and fills the holder in. Started AFTER the
   * listener, never awaited by it: while it runs the process is healthy, serves every route, and
   * starts runs — those runs simply get no forge or web tools, which start_task says in a line.
   * Each lookup waits out the gateway's seed on a bounded backoff (helpers/platform_server.ts).
   */
  const resolvePlatformTools = async (): Promise<void> => {
    const access = toolAccess;
    if (access === null) {
      platformTools.pending = false;
      return;
    }
    const [forgeVerdict, webVerdict] = await Promise.all([
      forgeToolsClaimed
        ? awaitPlatformServer({ lookup: access, id: PLATFORM_FORGE_SERVER_ID })
        : null,
      webToolsClaimed ? awaitPlatformServer({ lookup: access, id: PLATFORM_WEB_SERVER_ID }) : null,
    ]);
    if (forgeVerdict !== null) {
      if (forgeVerdict.served) platformTools.forge = PLATFORM_FORGE_SERVER_ID;
      else {
        // ONE line, at the end of the wait, and OFF rather than fatal: an agent with a forge
        // policy then starts without forge tools (and the agent form refuses new ones, naming
        // the variables), which beats a control plane that will not serve — the remedy for a
        // slug conflict is served by the gateway's own management API.
        log.error(
          `RYPH_FORGE_TOOLS=on but the gateway served no platform forge server after ` +
            `${Math.round(forgeVerdict.waitedMs / 1000)}s (${forgeVerdict.attempts} attempts, ` +
            `last: ${forgeVerdict.reason}): forge tools are OFF. Set RYPH_FORGE_TOOLS_URL and ` +
            "RYPH_FORGE_GATEWAY_TOKEN on the gateway, check no other MCP server holds the slug " +
            '"forge", and restart.',
        );
      }
    }
    if (webVerdict !== null) {
      if (webVerdict.served) platformTools.web = true;
      else {
        log.error(
          `RYPH_WEB_TOOLS=on but the gateway served no platform web server after ` +
            `${Math.round(webVerdict.waitedMs / 1000)}s (${webVerdict.attempts} attempts, ` +
            `last: ${webVerdict.reason}): web tools are OFF. Set RYPH_WEB_URL and ` +
            "RYPH_WEB_GATEWAY_TOKEN on the gateway, check no other MCP server holds the slug " +
            '"web", and restart.',
        );
      }
    }
    platformTools.pending = false;
    if (forgeVerdict !== null || webVerdict !== null) {
      log.info("platform tools resolved", {
        forge: platformTools.forge === null ? "off" : "on",
        web: platformTools.web ? "on" : "off",
        waitedMs: Math.max(forgeVerdict?.waitedMs ?? 0, webVerdict?.waitedMs ?? 0),
      });
    }
  };

  // The one default agent image — universal environment plus harness layer — and the harness
  // kinds an agent may pick. The kind no longer chooses an image: every image carries every
  // harness.
  const agentImage = env("RYPH_AGENT_IMAGE") ?? null;
  const harnessKinds = harnessKindsFromEnv(env, fail);
  // Size classes, read whatever the provisioner: each backend applies what it can express.
  const runSizes = runSizesFromEnv(env, fail);

  // "manual" (the default) launches nothing and prints the env a hand-started runner needs —
  // the loop works end to end before docker enters the picture.
  // Service containers: the policy is read whatever the provisioner, so the two composition
  // roots cannot disagree about what a variable means. The catalogue is loaded only when the
  // feature is on — an entry is validated at load and a bad one is fatal, and a deployment that
  // does not run services should not fail to boot over a list it will never consult.
  const servicePolicy = servicePolicyFromEnv(env, fail);
  // The browser sidecar: off unless RYPH_BROWSER_IMAGE names one. Said once below, beside the
  // provisioner that has to be able to launch it.
  const browser = browserConfigFromEnv(env, fail);
  // Read here, ahead of the adapter below, because the environments and browser configuration
  // default from it.
  const provisionerKind = env("RYPH_PROVISIONER") ?? "manual";
  // Environment builds, off by default. Read here, beside the provisioner it defaults its
  // builder from; the service itself is built once the provisioner is.
  const environments = environmentsConfigFromEnv(env, fail, provisionerKind);
  if (environments.enabled) {
    log.info(`RYPH_ENVIRONMENTS=on — environment builds use the ${environments.builder} builder`);
  }
  // Checks, off by default: on means head code from any connected repo runs in check pods here.
  const checkPolicy = checkPolicyFromEnv(env, fail, runSizes);
  const remoteChecks = remoteChecksConfigFromEnv(env, fail, [
    env("RYPH_PUBLIC_URL") ?? `http://localhost:${port}`,
    `http://localhost:${port}`,
    ...(appUrl ? [appUrl] : []),
  ]);
  // Egress, read the same way and for the same reason — one reader, so the two composition
  // roots cannot disagree about what RYPH_EGRESS means. What is said about it waits for the
  // provisioner, below.
  const egressPolicy = egressPolicyFromEnv(env, fail);
  const egressKey = egressKeyFromEnv(env, fail);
  let serviceCatalogue: ServiceCatalogue | null = null;
  if (servicePolicy.enabled) {
    try {
      serviceCatalogue = await directoryServiceCatalogue();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  // The skills catalogue is not behind a switch: every run of a harness that reads skills gets
  // it. An invalid skill is fatal here, as an invalid service entry is — it is platform-authored.
  // Every bundle goes into the store before the first request, so a run frozen on an older
  // catalogue (one that waited out a build across a deploy) still finds its digest afterwards.
  let skillCatalogue: SkillCatalogue;
  try {
    skillCatalogue = await directorySkillCatalogue();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const skillStore = drizzleSkillStore(dbHandle, () => new Date());
  await skillStore.upsertBundles(
    skillCatalogue.list().map((skill) => skillCatalogue.bundle(skill.digest)!),
  );

  let provisioner: Provisioner;
  // Set only for docker; see ReaperDeps.reconcile on why the rest need none.
  let reconcile: ((listActiveRunIds: () => Promise<string[]>) => Promise<void>) | undefined;
  // The check pods' backend: a sibling of the provisioner that only kubernetes and docker have
  // (ports/check_launcher.ts). Built only when checks are on.
  let checkLauncher: CheckLauncher | null = null;
  /**
   * Under docker, the launcher (@ryph/launcher): the one
   * process that holds the docker socket. Every docker port goes through its clients, and this
   * process runs no docker CLI at all — its image carries none, and the socket must never sit
   * beside the OAuth master key. Null under every other provisioner.
   */
  let dockerLauncher: { clients: LauncherClients; info: LauncherInfo; url: string } | null = null;
  // The images runs and builds launch on, fetched ahead by the launcher; the first-run flow reads
  // how far it got (GET /v1/images). Null: nothing fetched ahead here.
  let imagePrefetch: ImagePrefetch | null = null;
  if (provisionerKind === "docker") {
    if (agentImage === null) fail("RYPH_PROVISIONER=docker needs RYPH_AGENT_IMAGE");
    // A hard requirement, not a fallback: there is no docker in this image to fall back to.
    const launcherUrl = env("RYPH_LAUNCHER_URL")?.trim().replace(/\/+$/, "") ??
      fail(
        "RYPH_PROVISIONER=docker reaches docker through the docker launcher: set " +
          "RYPH_LAUNCHER_URL (and RYPH_LAUNCHER_TOKEN) to the launcher service. This process " +
          "runs no docker itself, and must never hold the docker socket.",
      );
    if (!URL.canParse(launcherUrl) || !/^https?:$/.test(new URL(launcherUrl).protocol)) {
      fail(`RYPH_LAUNCHER_URL must be an http(s) URL, got ${launcherUrl}`);
    }
    let launcherToken: string | undefined;
    try {
      launcherToken = await awaitLauncherToken(env, "RYPH_LAUNCHER_TOKEN", 30_000);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    if (launcherToken === undefined) {
      fail("RYPH_LAUNCHER_URL names a docker launcher, which needs RYPH_LAUNCHER_TOKEN");
    }
    // The launcher's networks, runtime, gate, builder and prefetch are its own configuration:
    // set here they would read as configured and do nothing. Refused, naming where they belong.
    const owned = launcherCallerRefusal(env, launcherUrl, null, {
      checks: false,
      builds: false,
      builder: environments.builder,
    });
    if (owned !== null) fail(owned);
    const clients = launcherClients({ url: launcherUrl, token: launcherToken }, diag);
    let info: LauncherInfo;
    try {
      // A compose stack starts the launcher beside this process; give it a moment to listen.
      info = await awaitLauncherInfo(clients, launcherUrl, 60_000);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    dockerLauncher = { clients, info, url: launcherUrl };
    if (info.engine === null) log.warn(engineAbsentWarning(launcherUrl));
    provisioner = clients.provisioner;
    // What this process turns on, the launcher has to serve: refused here rather than failing
    // every suite or build with a 404 from a launcher that runs none.
    const unserved = launcherCallerRefusal(env, launcherUrl, info, {
      checks: checkPolicy.enabled && remoteChecks === null,
      builds: environments.enabled && environments.builder === "docker",
      builder: environments.builder,
    });
    if (unserved !== null) fail(unserved);
    if (checkPolicy.enabled && remoteChecks === null) checkLauncher = clients.checkLauncher;
    if (info.prefetch) imagePrefetch = clients.imagePrefetch;
    // Docker's address pools hold ~31 networks and nothing else gives them back, so a leak
    // here is not untidiness — it is a deployment that stops launching runs on its
    // thirty-second one, with an error naming a subnet pool. Off the Provisioner port on
    // purpose: only this backend has the problem.
    //
    // Rides the reaper's tick, because `kill` is NOT the whole story: it runs for a run that
    // is lost or cancelled, and a run that simply finishes never reaches it. Also once here,
    // before the first request is served, so a deployment restarting into an exhausted pool
    // recovers before it tries to launch anything. Two phases over the wire, in the order the
    // reconcile needs: the launcher lists, this reads the active runs, the launcher removes.
    reconcile = clients.reconcile;
    await reconcile(async () => (await baseStore.listActiveRuns()).map((run) => run.id));
  } else if (provisionerKind === "kubernetes") {
    if (agentImage === null) fail("RYPH_PROVISIONER=kubernetes needs RYPH_AGENT_IMAGE");
    const kubernetesOptions = kubernetesOptionsFromEnv(env, fail);
    provisioner = kubernetesProvisioner(kubernetesOptions, diag);
    if (checkPolicy.enabled && remoteChecks === null) {
      checkLauncher = kubernetesCheckLauncher(kubernetesOptions, diag);
    }
  } else if (provisionerKind === "manual") {
    provisioner = manualProvisioner(diag);
  } else {
    fail(`unknown RYPH_PROVISIONER ${JSON.stringify(provisionerKind)}`);
  }

  // What runners are told to dial. With confined docker runs, the launcher's run gate.
  const publicUrl = env("RYPH_PUBLIC_URL") ?? `http://localhost:${port}`;
  // A confined docker run reaches nothing but the launcher's run gate, which relays the ports its
  // own configuration lists (RYPH_DOCKER_GATE_ROUTES there). Every address this process hands a
  // run has to name the gate on one of those ports, or the run boots and fails to call home: said
  // once here, naming each. The model proxy's and the gateway's run-facing addresses are those
  // services' own configuration (RYPH_MODEL_PROXY_URL, RYPH_MCP_GATEWAY_URL there), so this
  // process cannot see them.
  if (dockerLauncher !== null && dockerLauncher.info.gate !== null) {
    const gate = dockerLauncher.info.gate;
    const { elsewhere, unrouted } = gateCoverage(dockerLauncher.info, [
      { setting: "RYPH_PUBLIC_URL", url: publicUrl },
      { setting: "RYPH_GIT_GATEWAY_URL", url: gitGatewayUrl },
      { setting: "RYPH_RUN_HISTORY_URL", url: runHistoryUrl },
      { setting: "RYPH_EGRESS_PROXY_URL", url: egressKey === null ? null : egressPolicy.proxyUrl },
      // The runner's preview tunnel is this address with its scheme swapped.
      { setting: "RYPH_RUN_PREVIEWS_URL", url: runPreviewsUrl },
    ]);
    if (elsewhere.length > 0) {
      log.warn(
        `the docker launcher confines runs to ${dockerLauncher.info.runNetwork}, where the only ` +
          `way out is the run gate \`${gate}\` — but ${elsewhere.join(", ")} names somewhere ` +
          `else, which a confined run cannot reach. Point it at http://${gate}:<port>, with a ` +
          `route for that port on the launcher.`,
      );
    }
    if (unrouted.length > 0) {
      log.warn(
        `the run gate \`${gate}\` relays no port for ${unrouted.join(", ")}, so a confined run ` +
          `that dials it is refused. Add a route for it to RYPH_DOCKER_GATE_ROUTES on the docker ` +
          `launcher.`,
      );
    }
    // A registration with several previews replicas names its owner's own tunnel address, which a
    // confined run cannot reach: the gate relays one address per port.
    if (previews !== null && env("RYPH_PREVIEWS_PEER_HOST") !== undefined) {
      log.warn(
        `RYPH_PREVIEWS_PEER_HOST is set (several previews replicas), but runs are confined behind ` +
          `the run gate \`${gate}\`, which relays one address: runners would be sent to their ` +
          `replica's own address and fail to dial it. Several previews replicas behind a run ` +
          `gate are unsupported.`,
      );
    }
  }

  // The boundary, said out loud at boot, and said differently per backend, because the honest
  // sentence inverts. Under kubernetes, or docker through a launcher that confines runs, an
  // unwired proxy leaves runs with no route out and every install fails; under manual or an
  // unconfined docker the container keeps its default route and reaches everything, so the
  // setting enforces nothing. Said after the provisioner, because only the launcher knows whether
  // it confines.
  //
  // A deployment that claims the boundary and has not finished wiring it gets a warning rather
  // than a refusal to boot, and its runs get NO way out: that is default-closed doing its job,
  // and it is the one state where saying nothing would be worst — the operator would read a
  // clean boot as a working allowlist.
  if (egressPolicy.mode === "proxy" && (egressKey === null || egressPolicy.proxyUrl === null)) {
    log.warn(
      unwiredEgressWarning(
        provisionerKind,
        egressKey === null,
        egressPolicy.proxyUrl === null,
        provisionerKind === "kubernetes" || dockerLauncher?.info.runNetwork != null,
      ),
    );
  }
  if (egressPolicy.mode === "open") {
    log.warn("RYPH_EGRESS=open — runs reach the whole internet, and no boundary is claimed");
  }

  const browserLine = browserPosture(browser, provisioner, provisionerKind);
  log[browserLine.level](browserLine.message);

  // Reserved capacity, where the provisioner can hold it (kubernetes): placeholders per size
  // class, reconciled from the saved setting on the reaper's tick (core/reserved_capacity.ts),
  // which is why it is told that tick's cadence.
  const reaperIntervalMs = intEnv("RYPH_REAPER_INTERVAL_MS", 10_000);
  const capacity = provisioner.capacity !== undefined && agentImage !== null
    ? makeCapacityReconciler({
      store: baseStore,
      reserver: provisioner.capacity,
      runSizes,
      image: agentImage,
      // The browser's room only where runs can actually get one.
      services: serviceRoom(
        servicePolicy,
        (await serviceCatalogue?.list()) ?? [],
        browserOffered(browser, provisioner) ? browser : null,
      ),
      diag,
      now: () => new Date(),
      intervalMs: intEnv("RYPH_CAPACITY_RECONCILE_INTERVAL_MS", 60_000),
      tickMs: reaperIntervalMs,
    })
    : null;

  // Readiness is one cheap read of the table this process cannot serve without. Liveness asks
  // nothing: a database outage must route traffic away, never restart the fleet into a crash loop.
  const health = makeHealth({
    ready: () => baseStore.listTasks({ limit: 1 }),
    log: { warn: (event, fields) => diag.warn(event, fields) },
  });

  const sweepCfg = {
    heartbeatTimeoutMs: intEnv("RYPH_HEARTBEAT_TIMEOUT_MS", 60_000),
    // Generous: scale-from-zero backends boot for minutes before the first beat; a local
    // container beats in seconds and never reaches it. Only cost: a launch that never comes up
    // is given up on minutes late, not seconds.
    startupGraceMs: intEnv("RYPH_STARTUP_GRACE_MS", 600_000),
    cancelGraceMs: intEnv("RYPH_CANCEL_GRACE_MS", 120_000),
    // How far past its own idle deadline a run may go before the reaper asks
    // it to stop — the runner ends it itself when the clock lapses; this catches one that
    // stopped keeping the clock.
    idleGraceMs: intEnv("RYPH_IDLE_GRACE_MS", 60_000),
  };
  // The operator's run limits: the ceiling every agent and task stays under, and the
  // deployment-wide caps. Parsed after the sweep's graces, which the provisioner backstop adds.
  const limits = deploymentLimitsFromEnv(env, fail, sweepCfg);

  const appConfig: AppConfig = {
    publicUrl,
    browser,
    provisionerKind,
    agentImage,
    harnessKinds,
    runSizes,
    limits,
    environments,
    gitGateway: gitGatewayUrl === null ? null : {
      url: gitGatewayUrl,
      keyTtlMs: intEnv("RYPH_GIT_KEY_TTL_MS", 24 * 60 * 60 * 1000),
    },
    runHistoryUrl,
    appUrl,
    services: servicePolicy,
    egress: {
      policy: egressPolicy,
      key: egressKey,
      // The claim outlives the run it was minted for by design: the proxy has nowhere to read
      // a revocation from, so the expiry IS the revocation — and it must now cover the whole
      // run rather than the setup window, because the agent phase holds the same claim. A day
      // is the git key's number for the same reason: it is what a long run costs.
      tokenTtlMs: intEnv("RYPH_EGRESS_TOKEN_TTL_MS", 24 * 60 * 60 * 1000),
    },
    platformMemoryServerId,
    platformChatServerId,
    platformTools,
  };

  // Environment builds, when on: the queue in the database, the builder the configuration names
  // (derived from the provisioner unless RYPH_ENV_BUILDER says otherwise), and build logs beside
  // the patches in the forge's object store. The service launches a waiting run itself when its
  // build lands, so it gets everything startTask gets.
  let wiredEnvironments: WiredEnvironments | null = null;
  // A run's images, read by the user and runner doors, swept by the reaper, and read by a
  // waiting run's start.
  const attachmentStore = attachmentStoreFromEnv(env, fail, diag);
  // Build logs, check logs and background command logs share one store: the forge's object
  // store, under their own prefixes. Always there, since every run may start a
  // background command.
  const buildLogs = buildLogStoreFromEnv(env, fail, diag);
  if (environments.enabled) {
    wiredEnvironments = wireEnvironments({
      environmentStore: drizzleEnvironmentStore(dbHandle),
      // A docker build runs in the launcher, confined as its runs are (it clones from where the
      // LAUNCHER runs, so RYPH_FORGE_URL is how the launcher dials the forge too); every other
      // builder is this process's own (a Job, a Cloud Build) and needs no docker.
      builder: environments.builder === "docker"
        ? (dockerLauncher?.clients.environmentBuilder ??
          fail(
            "docker environment builds run in the docker launcher, which only " +
              "RYPH_PROVISIONER=docker reaches — set it, or name another RYPH_ENV_BUILDER",
          ))
        : createEnvironmentBuilder(environments, { diag, fail }),
      logs: buildLogs,
      start: {
        store,
        provisioner,
        diag,
        forge,
        serviceCatalogue,
        skillCatalogue,
        skills: skillStore,
        memoryAccess,
        identityDirectory,
        modelAccess,
        attachmentStore,
        chatAccess,
        platformModel,
        now: () => new Date(),
        config: appConfig,
      },
      config: appConfig,
      inbox,
      githubMode,
    });
    if (wiredEnvironments.service.refusedReason !== null) {
      log.warn(`RYPH_ENVIRONMENTS=on, but ${wiredEnvironments.service.refusedReason}`);
    }
  }
  const environmentService = wiredEnvironments?.service ?? null;

  // Checks, when on: suites in the database, pods through the launcher, the declaration read
  // through the forge, the base's environment through the build queue.
  let checks: ChecksService | null = null;
  let checksAwaiting: WiredChecks["awaiting"] | null = null;
  if (checkPolicy.enabled) {
    const checkStore = drizzleCheckStore(dbHandle);
    const wired = wireChecks({
      store: checkStore,
      tasks: store,
      launcher: checkLauncher,
      remoteChecks,
      forge: forgeChecks,
      environments: environmentService,
      logs: buildLogs,
      serviceCatalogue,
      inbox,
      diag,
      now: () => new Date(),
      config: {
        policy: checkPolicy,
        agentImage,
        runSizes,
        gitGateway: appConfig.gitGateway,
        services: servicePolicy,
        egress: appConfig.egress,
        appUrl,
      },
    });
    checks = wired.service;
    checksAwaiting = wired.awaiting;
    if (checks.refusedReason !== null) log.warn(`RYPH_CHECKS=on, but ${checks.refusedReason}`);
    else log.info(`RYPH_CHECKS=on — backend: ${remoteChecks ? "remote" : checkLauncher?.kind}`);
    // What a previous life left behind (a docker deployment's containers, volumes and
    // networks too) is the tick's orphan sweep's, within its first minute.
  }

  // A publish's served document is made in a child process, confined under `node --permission`
  // where it can be, killed at its deadline; any still running are killed at shutdown. In the
  // control-plane image the sanitizer supervisor beside this process starts it
  // (RYPH_ARTIFACT_SANITIZER_SOCKET, images/control-plane/sanitizer.sh); anywhere else this
  // process starts it itself, and says once if it has to run it unconfined.
  const sanitizerSocket = env("RYPH_ARTIFACT_SANITIZER_SOCKET");
  const onKilled = (runId: string) => diag.warn("artifact.sanitizer_killed", { runId });
  const artifactHtml = sanitizerSocket !== undefined
    ? socketArtifactHtml({
      path: sanitizerSocket,
      onKilled,
      onUnavailable: (why) => log.error(why),
    })
    : processArtifactHtml({
      onKilled,
      onUnavailable: (why) => log.error(why),
      onUnconfined: (why) => log.warn(why),
    });
  const handler = makeHandler({
    store,
    provisioner,
    runnerControl: httpRunnerControl(provisioner, diag),
    diag,
    authenticate,
    modelAccess,
    toolAccess,
    forgeToken,
    automationsToken,
    // Gated on the URL, not the token alone: the verify surface exists only to serve a REMOTE
    // historian, so it is not exposed unless this deployment actually talks to one.
    historyToken: historyUrl !== null ? historyToken : null,
    // Run grants are signed with the credential each service already shares with this process;
    // a service this deployment does not dial gets no grant.
    runGrantKeys: {
      history: historyUrl !== null ? historyToken : null,
      models: modelAccess === null ? null : modelProxyToken,
      tools: toolAccess === null ? null : mcpGatewayToken,
    },
    forge,
    githubMode,
    gitlabMode,
    patchDiffs,
    githubConnect,
    githubUserConnect,
    gitlabConnect,
    radicleConnect,
    localConnect,
    serviceCatalogue,
    skillCatalogue,
    skills: skillStore,
    forgeSkills,
    identityDirectory,
    memoryAccess,
    chatAccess,
    platformModel,
    chatToken: chatUrl !== null ? chatToken : null,
    inbox,
    environments: environmentService,
    environmentFeedback: wiredEnvironments?.feedback ?? null,
    startWithoutEnvironment: wiredEnvironments?.startWithoutEnvironment ?? null,
    checks,
    checksAwaiting,
    capacity,
    imagePrefetch,
    taskFeed,
    // A run's images, beside the patches in the forge's object store under `attachments/` —
    // always on: the run page's composer takes images on every deployment.
    attachmentStore,
    // A run's background commands: rows beside the run, logs beside the build logs.
    backgroundStore: drizzleBackgroundStore(dbHandle),
    artifacts: drizzleArtifactStore(dbHandle),
    artifactHtml,
    artifactThumbnail: artifactThumbnailFromEnv(env),
    backgroundLogs: buildLogs,
    previews,
    now: () => new Date(),
    config: appConfig,
  }, [...auth.routes, ...health.routes]);

  // The access ports ride along so a "lost" verdict can kill the run's virtual keys — the one
  // conclusion that arrives without a runner report, and the one that needs them dead most.
  const reaperDeps = {
    store,
    provisioner,
    diag,
    modelAccess,
    toolAccess,
    memoryAccess,
    chatAccess,
    appUrl,
    runnerControl: httpRunnerControl(provisioner, diag),
    now: () => new Date(),
    reconcile,
    settleWaitingRun: wiredEnvironments?.settleWaitingRun ?? null,
    // For the retention sweep of uploads no message ever carried.
    attachmentStore,
  };
  // The submitter rides the same tick: with a forge wired, approved patches get delivered;
  // without one, patches simply wait (connected repos cannot exist then, so none will).
  // memoryAccess rides it because a patch that fails past retrying is a change memory has been
  // waiting on, and this is the last place anything notices.
  const submitterDeps = forge === null ? null : {
    store,
    forge,
    identityDirectory,
    diag,
    memoryAccess,
    inbox,
    environmentFeedback: wiredEnvironments?.feedback ?? null,
    checks,
    appUrl,
    // In GitHub's and GitLab's user modes, which have no webhooks, merges are polled
    // (core/merge_poll.ts); GitLab's mode is read off `forge`.
    githubMode,
    mergePoll: {
      ...DEFAULT_MERGE_POLL_CONFIG,
      intervalMs: intEnv("RYPH_MERGE_POLL_INTERVAL_MS", DEFAULT_MERGE_POLL_CONFIG.intervalMs),
      // Zero switches the poll off.
      perTick: msEnv("RYPH_MERGE_POLL_PER_TICK", DEFAULT_MERGE_POLL_CONFIG.perTick),
    },
    now: () => new Date(),
  };
  // The progress sweep rides it too, under the same condition: editing a forge thread's
  // comment IS a forge call, so without a forge there is nothing to edit with.
  const progressDeps = forge === null ? null : {
    store,
    forge,
    identityDirectory,
    diag,
    now: () => new Date(),
    appUrl,
  };
  // Each sweep skips its tick while its previous run is still in flight — setInterval does not
  // await, and a patch delivery is a GitHub call that can easily outlast the interval. The two
  // are guarded SEPARATELY on purpose: a slow submission must never delay the liveness reaper.
  // (Correctness does not rest on this — the submitter's claim is conditional — but stacking
  // ticks pile up concurrent sweeps for no benefit.)
  // ONE replica sweeps per tick, decided by a Postgres advisory lock rather than by hoping.
  //
  // Every replica running the reaper is not merely wasteful: `sweep` reaps runs whose heartbeat
  // has lapsed and kills their containers, and N replicas deciding that simultaneously means N
  // kill calls for one container and N sets of lifecycle events written for one run. The patch
  // submitter's own double-submit was fixed differently — its claim is a conditional
  // `UPDATE … RETURNING`, so the WHERE *is* the claim — and it keeps that; the lock here only
  // stops N replicas from all doing the query work to find nothing.
  //
  // A separate key per sweep, for the same reason they have separate in-flight flags: a slow
  // patch submission must never keep the liveness reaper from running, on this replica or any
  // other.
  const lock = await cluster.lockSession();
  const runLocked = async (
    key: number,
    what: string,
    work: () => Promise<void>,
  ): Promise<void> => {
    // Taken per tick, never held between them: a leader that dies mid-tick releases the lock
    // when its connection drops, and the next tick on any replica simply picks the work up.
    let held = false;
    try {
      held = await lock.tryLock(key);
      // Not an error and not worth a log line — on N replicas this is the expected answer on
      // N-1 of them, every single tick.
      if (!held) return;
      await work();
    } catch (err) {
      diag.warn(`reaper.${what}_failed`, { err: String(err) });
    } finally {
      if (held) await lock.unlock(key).catch(() => {});
    }
  };

  let sweepInFlight = false;
  let patchSweepInFlight = false;
  let progressSweepInFlight = false;
  const runProgressSweep = () => {
    if (progressDeps === null || progressSweepInFlight) return;
    progressSweepInFlight = true;
    runLocked(LOCK_PROGRESS_SWEEP, "progress_sweep", () => sweepProgressComments(progressDeps))
      .finally(() => (progressSweepInFlight = false));
  };
  // Now the sweep exists, the store's terminal hook (wired far above, where the store is
  // built) can actually hurry it.
  kickProgressSweep = runProgressSweep;
  let buildTickInFlight = false;
  let checkTickInFlight = false;
  let capacityTickInFlight = false;
  let authSweepInFlight = false;
  const authSweeper = setInterval(() => {
    if (authSweepInFlight) return;
    authSweepInFlight = true;
    auth.sweep()
      .catch((err) => log.warn("auth sweep failed", { err: String(err) }))
      .finally(() => (authSweepInFlight = false));
  }, intEnv("RYPH_AUTH_SWEEP_INTERVAL_MS", 60 * 60 * 1000));
  const reaper = setInterval(() => {
    if (!sweepInFlight) {
      sweepInFlight = true;
      runLocked(LOCK_LIVENESS_SWEEP, "sweep", () => sweep(reaperDeps, sweepCfg))
        .finally(() => (sweepInFlight = false));
    }
    if (submitterDeps !== null && !patchSweepInFlight) {
      patchSweepInFlight = true;
      runLocked(
        LOCK_PATCH_SWEEP,
        "patch_sweep",
        () => sweepPatches(submitterDeps, DEFAULT_PATCH_SUBMIT_CONFIG),
      ).finally(() => (patchSweepInFlight = false));
    }
    runProgressSweep();
    // The build queue rides the same tick: claim what a free slot allows, stamp the rows of the
    // builds running here, abort a local build whose row moved on, and take over a build whose
    // replica went away — which means asking the builder what became of it, not waiting out a
    // clock. No lock — the claim is serialized in the database, taking a stranded row over is a
    // compare-and-set, and every settle is conditional.
    if (environmentService !== null && !buildTickInFlight) {
      buildTickInFlight = true;
      environmentService.tick()
        .catch((err) => diag.warn("environments.tick_failed", { err: String(err) }))
        .finally(() => (buildTickInFlight = false));
    }
    // The check queue rides it under a lock of its own: every transition is a compare-and-set
    // already, so the lock only keeps N replicas from all polling the same pods.
    if (checks !== null && !checkTickInFlight) {
      checkTickInFlight = true;
      const service = checks;
      runLocked(LOCK_CHECK_SWEEP, "check_sweep", () => service.tick())
        .finally(() => (checkTickInFlight = false));
    }
    // Reserved capacity rides it with no lock: who applies is the Lease's holder, which the
    // cluster decides, and an advisory lock here would only be a second answer that could
    // disagree with it. The tick logs its own failures and never throws.
    if (capacity !== null && !capacityTickInFlight) {
      capacityTickInFlight = true;
      capacity.tick().finally(() => (capacityTickInFlight = false));
    }
  }, reaperIntervalMs);

  // The reconcile backstop, at boot and then hourly, on ONE replica (the reaper's tick-plus-lock
  // pattern): first what a deploy changes — images on an old harness re-layered, images on an
  // old base rebuilt — then every subject's default-branch head and `.ryph/` tree asked of the
  // forge, whatever an event should have queued queued, every repo's recorded default branch
  // refreshed, retention swept. Both halves are idempotent, so a replica that loses the boot
  // race to an older one catches up on the next tick.
  let envReconcileInFlight = false;
  const runEnvReconcile = () => {
    if (environmentService === null || envReconcileInFlight) return;
    envReconcileInFlight = true;
    runLocked(LOCK_ENV_RECONCILE, "environments_reconcile", async () => {
      await environmentService.onBoot();
      await environmentService.reconcile();
    }).finally(() => (envReconcileInFlight = false));
  };
  runEnvReconcile();
  const envReconciler = setInterval(
    runEnvReconcile,
    intEnv("RYPH_ENV_RECONCILE_INTERVAL_MS", 60 * 60 * 1000),
  );

  // The org skills repo's backstop, at boot and then hourly, on ONE replica: a push event can be
  // lost, and a branch other than the default sends none, so this is what keeps the version runs
  // get no older than an hour. One forge call that answers "unchanged" when nothing moved. Its
  // own key, never the store's (`SKILLS_SYNC_TX_LOCK`): this session holds the leader lock while
  // the sync's write takes the other on a pooled connection, and one shared key would wait on
  // itself forever.
  let skillsReconcileInFlight = false;
  const runSkillsReconcile = () => {
    if (skillsReconcileInFlight) return;
    skillsReconcileInFlight = true;
    runLocked(LOCK_SKILLS_RECONCILE, "skills_reconcile", async () => {
      await syncOrgSkills(
        { skills: skillStore, forge: forgeSkills, diag, now: () => new Date() },
        "reconcile",
        null,
      );
    }).finally(() => (skillsReconcileInFlight = false));
  };
  runSkillsReconcile();
  const skillsReconciler = setInterval(
    runSkillsReconcile,
    intEnv("RYPH_SKILLS_RECONCILE_INTERVAL_MS", 60 * 60 * 1000),
  );

  // Tracked so the drain can end them: a task-list SSE tail never finishes on its own.
  const streams = trackStreams();
  const server = await serve({ port }, streams.wrap(handler));
  // Behind the listener, deliberately: this is the one piece of boot that waits on another
  // process, and nothing it answers is needed to serve a request or to keep the pod alive.
  resolvePlatformTools().catch((err) =>
    log.error(`resolving the platform tool servers failed: ${err}`)
  );
  // `description`, never `dbUrl`: a postgres:// URL carries its password, and this line ends up
  // in whatever ships the logs.
  log.info(`listening on http://localhost:${port}`, {
    provisioner: provisionerKind,
    ...(dockerLauncher === null ? {} : {
      launcher: dockerLauncher.url,
      runs: dockerLauncher.info.runNetwork === null
        ? "unconfined"
        : `confined to ${dockerLauncher.info.runNetwork} behind ${dockerLauncher.info.gate}`,
    }),
    db: dbHandle.description,
    auth: authUrl ?? (authDisabled ? "off" : "mounted"),
    modelAccess: modelProxyUrl ?? "off",
    toolAccess: mcpGatewayUrl ?? "off",
    previews: previewsUrl ?? "off",
  });

  // A signal drains: unready first, then the socket, then the reaper and the connection.
  // In-flight requests finish inside the deadline; runs in containers keep going and report to
  // whichever replica answers next.
  installDrain({
    servers: [{ name: "control plane", server, streams }],
    beginDrain: health.beginDrain,
    close: async () => {
      clearInterval(reaper);
      clearInterval(authSweeper);
      clearInterval(envReconciler);
      clearInterval(skillsReconciler);
      artifactHtml.close();
      // The Lease given up, so the next replica takes over at its next pass rather than when the
      // Lease expires. Bounded and never throws.
      await capacity?.stop();
      // Before the cluster: this is a connection of its own, and returning it drops whichever
      // sweep lock this replica still holds instead of making its peers wait out a timeout.
      await lock.close();
      // Before the cluster too, for the same reason: the feed holds a LISTEN connection, and
      // dropping it here means peers stop notifying a replica that is on its way out.
      await taskFeed.close();
      store.close();
      await cluster.close();
    },
    preStopMs: msEnv("RYPH_PRE_STOP_MS", 0),
    deadlineMs: msEnv("RYPH_DRAIN_DEADLINE_MS", 25_000),
    log,
  });
}

if (import.meta.main) {
  await main();
}

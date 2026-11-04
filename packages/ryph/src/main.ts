// `ryph` — the single-process deployment as one shipped binary.
//
// Everything the local loop needs is inside: real PostgreSQL (PGlite, embedded), the schema
// migrations, and the built web UI. No Bun to install, no node_modules, no database server. The
// two things it cannot absorb are `git` and `docker`: the forge shells out to one and the
// provisioner to the other, so those stay real dependencies of the machine.
//
// This file is only a front end. `up` reads no configuration of its own — it hands
// @ryph/host's root the two things a binary can do that a source checkout cannot (apply its
// embedded migrations, serve its embedded UI) and lets that root own the environment, the
// sockets and the process lifetime. There is exactly one boot sequence, and it is not here.

import { join, resolve } from "@std/path";
import { drizzleAuthStore, scopeAuthDb } from "@ryph/auth";
import { openDbCluster, parseDbUrl } from "@ryph/db";
import {
  type HostSummary,
  imageDefaultsNote,
  main as hostMain,
  type PreviewListener,
  ryphVersion,
} from "@ryph/host";
import { banner, print, status, type StatusRow } from "./banner.ts";
import { backup, countSealedKeys, dataDirExists, restore } from "./backup.ts";
import {
  applyFileDirDefaults,
  buildsDefault,
  checksConcurrencyDefault,
  configExists,
  configPath,
  defaultFileDirs,
  defaultLocalRepoRoot,
  loadConfigIntoEnv,
  MANUAL_OPT_IN,
  provisionerRefusal,
  readConfig,
  ryphHome,
} from "./config_file.ts";
import {
  APP_BUILD_DIR,
  BUNDLED_EMBEDDINGS,
  embeddedDirExists,
  isCompiled,
  MIGRATION_SETS,
} from "./embedded.ts";
import { hostileEnvironment } from "@ryph/shared/env";
import {
  answeringPrompter,
  interactiveTerminal,
  NeedsAnswer,
  NO_INPUT,
  terminalPrompter,
} from "./prompt.ts";
import { applySchema } from "./schema_guard.ts";
import { onStop } from "./stop.ts";
import {
  deriveEgressKey,
  loadOrCreateSecretsKey,
  mintHexKey,
  readSecretsKey,
  secretsKeyPath,
} from "./secrets_key.ts";
import { mintLoginSecret, openInBrowser, requestLoginLink, writeLoginSecret } from "./login.ts";
import { describeSettings, printSettings } from "./settings.ts";
import { parseSetupArgs, runSetup, SETUP_HELP, shouldRunSetup } from "./setup.ts";

/** `0.1.0` for a release, `sha-<12>` for an edge build, `dev` from source (@ryph/host's images.ts). */
const VERSION = ryphVersion();
const DEFAULT_APP_PORT = 3000;

/**
 * Where the database lives when RYPH_DB says nothing: `~/.ryph/data`.
 *
 * It used to be `./data/ryph`, relative to wherever you happened to be standing. That is right
 * for a project tool and wrong for this: `ryph up` is a SERVER with one identity per machine —
 * your account, your agents, your run history — so running it from a different directory silently
 * opened a different, empty database. The banner could not even tell you, because it printed the
 * relative path, which read the same both times. "My data is gone" was the only symptom.
 *
 * A per-project database is still one env var away, and the doc string below says so.
 *
 * No home directory (a container with no HOME, a stripped environment) falls back to the old
 * behaviour rather than failing: somewhere to write beats nowhere.
 */
function defaultDbUrl(): string {
  const home = ryphHome();
  return home ? `pglite:${join(home, "data")}` : "pglite:./data/ryph";
}

/**
 * The database this launch will open, as an ABSOLUTE path.
 *
 * Absolute on purpose, and not only for the default: a relative `RYPH_DB` names a different
 * directory from every working directory, so printing it back verbatim tells you nothing about
 * which one you got. Resolving it here means every line this binary prints about its database —
 * the banner, the first-launch note, the downgrade refusal — names one directory on disk.
 */
function resolveDbUrl(raw: string = process.env.RYPH_DB || defaultDbUrl()): string {
  const target = parseDbUrl(raw);
  if (target.kind !== "pglite" || target.dataDir === null) return raw;
  return `pglite:${resolve(target.dataDir)}`;
}

/**
 * ONE RULE: every variable the launch banner tells you to set has to appear here.
 *
 * It did not, and the gap was the worst kind — a running binary printing "set RYPH_SECRETS_KEY"
 * next to a `--help` that had never heard of it, which reads as the tool contradicting itself.
 * The knobs below are the ones you need to get from "it started" to "it does something"; the
 * long tail genuinely does live in the host's README, and the line at the end says so.
 */
export const HELP = `ryph ${VERSION} — agents as editable blueprints

USAGE
  ryph up                          start everything: control plane, model proxy, MCP gateway, UI,
                                   and open the UI signed in (--no-open to only print the link)
  ryph login                       a fresh sign-in link for the running \`ryph up\`, opened in the
                                   browser (--no-open to only print it)
  ryph setup                       answer the questions a fresh install cannot; flags answer
                                   them without a terminal (\`ryph setup --help\`)
  ryph config                      show what a launch resolves to, and what decided each value
  ryph migrate                     apply the schema and exit (up does this for you)
  ryph auth grant-owner <email>    make an existing user an owner, straight in the database
  ryph backup <file>               write a compressed snapshot of the database (run images
                                   stay in ~/.ryph/files; copy that folder alongside)
  ryph restore <file>              REPLACE the database from a snapshot
  ryph checks run                  run a repo's checks on your commit, before a PR;
                                   \`ryph checks help\` for the rest
  ryph mcp [--read-only]           a ryph deployment as MCP tools for an agent on this
                                   machine, over stdio (\`ryph mcp --help\`)
  ryph version                     print the version

  --no-input                       on any command: never ask, even at a terminal (also
                                   RYPH_NO_INPUT=1). \`up\` then skips setup, opens no browser
                                   and asks nothing on Ctrl-C.

SCRIPTS AND AGENTS
  Nothing needs a terminal. Without one, nothing is asked and nothing is opened:
    ryph setup --yes --github cli --repo-root ~/Code
    ryph up --no-input              (status to stderr; Ctrl-C or SIGTERM stops it)
    ryph login --no-open            prints a sign-in link on stdout
    ryph config                     what a launch resolves to, on stdout
    ryph restore <file> --force     replaces the database without asking
    ryph checks run --json          results as JSON
  A coding agent setting this up for someone reads
    https://raw.githubusercontent.com/ryph-hq/ryph/main/docs/guides/setup-with-an-agent.md

SETTINGS
  Everything below can live in ~/.ryph/config.env — the same variables, one per line, written
  by \`ryph setup\` and safe to edit by hand. The environment always beats that file, so a
  scripted launch behaves exactly as it did before the file existed.

  \`ryph up\` runs setup by itself on a first launch, and only when there is a terminal to
  answer it: pass --no-setup to skip it, and a container or a CI job never sees it.

ENVIRONMENT
  RYPH_HOME          where this deployment keeps its database, run images, master key and
                     settings; default ~/.ryph. Read from the environment only — it says where the
                     settings file is, so it cannot come from inside it.
  RYPH_DB            database URL; default pglite:~/.ryph/data
                     also pglite:./data/ryph (here, not ~), pglite:memory://
                     (throwaway) or postgres://…
  RYPH_APP_PORT      port for the web UI; default ${DEFAULT_APP_PORT}
  RYPH_PORT          port for the control plane; default 7411
  RYPH_LOG_LEVEL     debug | info | warn | error; default warn
  RYPH_MULTIUSER     on lets more than one person use this deployment: they register, are
                     invited and get roles, and the first registration needs the setup token
                     the launch prints. Default off: you are the only user, signed in by the
                     link \`ryph up\` and \`ryph login\` open.
  RYPH_BIND          extra addresses the control plane, the model proxy and the forge listen
                     on, comma-separated. They always bind loopback and the address runs
                     reach this machine at (detected at every launch); list others here.
  RYPH_APP_BIND      more addresses the web UI listens on besides loopback (127.0.0.1 and ::1)
  RYPH_ALLOWED_HOSTS more host names the UI and the control plane answer to, comma-separated,
                     beyond localhost and the addresses above; * answers any
  RYPH_LOCAL_PREVIEWS
                     off stops agents exposing dev servers as previews; default on. Each
                     preview listens on a free port of this process's loopback, at
                     http://<id>.localhost:<port>.
  RYPH_LOCAL_PREVIEWS_PORT
                     one port every preview shares instead, told apart by host name: for a ryph
                     in a container, which publishes it. With RYPH_LOCAL_PREVIEWS_BIND (default
                     127.0.0.1) and RYPH_LOCAL_PREVIEWS_PUBLIC_PORT, the port a browser reaches
                     it at when that differs (default the same).
  RYPH_SECRETS_KEY 64 hex characters (32 bytes) sealing every provider key and MCP server
                     credential this deployment stores. Minted on first launch into
                     ~/.ryph/secrets.key if unset, so model and tool access work out of the
                     box. Set this to supply your own, or for a
                     postgres:// database, which gets no generated key — a per-machine file is
                     the wrong shape for a database several machines share.
  RYPH_SECRETS_KEY_FILE
                     an absolute path the master key is read from, or minted into on first
                     launch, whatever the database: the one-machine postgres:// case.
                     \`ryph backup\` does NOT include it: that is what keeps a snapshot safe
                     to copy. Restoring elsewhere needs the key carried across separately.
  RYPH_MEMORY_EMBEDDINGS
                     local | off; default local: memory search ranks by meaning as well as by
                     words, with a small model this binary carries (bge-small-en-v1.5), loaded
                     on the first search or write (about 200 MB of memory once loaded). off is
                     full-text only.

AGENTS
  RYPH_PROVISIONER docker; required, and \`ryph setup\` writes it. \`up\` refuses to start
                     without one. (manual launches nothing and prints the env a runner needs,
                     for developing ryph only: it starts only with ${MANUAL_OPT_IN}=1.)
  RYPH_AGENT_IMAGE the container image every run launches on, whatever its harness kind:
                     it carries them all. Under docker, default the one published for this
                     binary (quay.io/ryph/ryph-agent:<version>).
  RYPH_BROWSER_IMAGE the browser an agent with one gets beside its run; under docker, default
                     quay.io/ryph/ryph-browser at this binary's version, off for none.
  RYPH_ARTIFACT_THUMBNAIL_IMAGE
                     under docker, artifact previews use the published browser image automatically;
                     set an image to override, or off for placeholders. Rendering uses disposable,
                     networkless containers, not a run's browser.
  RYPH_ARTIFACT_THUMBNAIL_URL / RYPH_ARTIFACT_THUMBNAIL_SOCKET
                     use a separately managed isolated renderer instead of automatic Docker jobs.
  RYPH_IMAGE_PREFETCH
                     under docker, up downloads every missing image in the background so the
                     first run does not wait for it; default on. off pulls each on first use.
  RYPH_ENVIRONMENTS  on builds each repo an image with its setup done, so runs start ready;
                     default on under docker. Several GB of disk per repo.
  RYPH_CHECKS        on runs a repo's .ryph/checks.yml; default on under docker.
  RYPH_CHECKS_CONCURRENCY
                     check pods running at once; default 2 under docker, else 4. A suite's
                     shared pod and each pod: own check take one; a file needing more fails
                     there, and the repos view flags it.
  RYPH_CHECKS_CPUS / RYPH_CHECKS_MEMORY
                     the most one check (or its setup) may use under docker, e.g. 4 and 6Gi; default auto,
                     half of what docker has. off removes the cap.
  RYPH_HARNESS_KINDS the harness kinds an agent may be created with; default pi,echo
                     (echo is the runner's built-in no-model harness).
  RYPH_RUN_SIZES   the size classes a run can get, as name:cpu=…,memory=…;name2:…; default
                     standard:cpu=4,memory=8Gi,ephemeral-storage=10Gi. An admin picks one per
                     repo or workspace. RYPH_RUN_SIZE_DEFAULT names the default; unset, the
                     first class listed.

REPOSITORIES
  RYPH_LOCAL_REPO_ROOT
                     the directory repositories on this machine may be added from, in the UI
                     under Repos → Connect repository → On this machine; default your home
                     directory, and \`off\` turns them off. Runs clone them through the forge
                     and an approved patch lands as a branch in the repository. Only with the
                     in-process forge (RYPH_FORGE_URL=embedded).
  RYPH_GITHUB_TOKEN_COMMAND
                     a command that prints a GitHub token, run at start and again when GitHub
                     turns the token away; \`gh auth token\` uses your GitHub CLI login. Ryph
                     then acts as that account on GitHub, for everyone who uses it.
  RYPH_GITHUB_TOKEN  the same, as the token itself. A fine-grained token needs contents, pull
                     requests, issues and checks read/write, and metadata read. One or the
                     other, and never beside a GitHub App (RYPH_GITHUB_APP_ID and the rest).
  RYPH_GITLAB_URL    the GitLab instance ryph works on, gitlab.com or your own (a path prefix
                     is fine: https://git.example.com/gitlab); default https://gitlab.com.
  RYPH_GITLAB_MODE   \`user\` acts as YOU, through your token: merge requests and comments
                     under your name, merges polled, no webhooks — what \`ryph setup\` writes.
                     \`bot\` (the default) acts as a GitLab account of ryph's own, added to
                     projects at the Developer role. Setup does not offer it; by hand it takes
                     the bot's token (below), a GitLab OAuth application for sign-in
                     (RYPH_GITLAB_CLIENT_ID and RYPH_GITLAB_CLIENT_SECRET, its callback
                     RYPH_APP_URL/gitlab/callback, scope read_user): connecting a project and
                     every write need the person's GitLab account linked; and
                     RYPH_GITLAB_WEBHOOK_SECRET, for /ryph comments and prompt merges, delivered
                     to RYPH_APP_URL/v1/hooks/gitlab, which GitLab must reach.
  RYPH_GITLAB_TOKEN_COMMAND
                     a command that prints the GitLab token, run at start and again when
                     GitLab turns the token away. \`ryph setup\` writes one that asks glab's
                     credential helper, which renews your glab login's token as it expires.
  RYPH_GITLAB_TOKEN  the same, as the token itself: a personal access token with the api,
                     read_repository and write_repository scopes. One or the other. A pushed
                     branch runs the project's .gitlab-ci.yml with its unprotected variables.
  RYPH_RADICLE_URL=embedded
                     acts as YOUR Radicle identity, through the radicle-node you already run:
                     connect a repository by its RID, and agents open patches, comment and
                     review as you. Reads RAD_HOME (default ~/.radicle); \`rad\` must be on PATH
                     (this binary may run only the one PATH finds). Only an owner or operator
                     may connect, and only repositories connected are touched; your node's
                     seeding policies are left as they are, and one you blocked is refused. An
                     encrypted key signs through your ssh-agent, so start ryph where
                     SSH_AUTH_SOCK is set. Your own comments are never commands to ryph, and
                     no checks run.

  \`ryph up\` accepts every other RYPH_* knob the host does; see its README.

NOTES
  git and docker must be on PATH — agent containers and repository work need them.
`;

async function main(argv: string[]): Promise<void> {
  // Global, so it can sit anywhere on the line. Set in the environment because that is where
  // `interactiveTerminal` (and anything this process starts) looks.
  if (argv.includes("--no-input")) {
    process.env[NO_INPUT] = "1";
    argv = argv.filter((arg) => arg !== "--no-input");
  }
  const [command, ...rest] = argv;

  // `ryph up --help` must print help, not start a deployment against ~/.ryph. `checks` and `mcp`
  // have their own help, and `setup` its own page.
  if (
    command !== undefined && command !== "checks" && command !== "mcp" &&
    (rest.includes("--help") || rest.includes("-h"))
  ) {
    console.log(command === "setup" ? SETUP_HELP : HELP);
    return;
  }

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;

    case "version":
    case "--version":
    case "-V":
      console.log(VERSION);
      return;

    case "up":
      return await up(rest);

    case "login":
      return await login(rest);

    case "setup":
      return await setup(rest);

    case "config":
      return await showConfig();

    case "migrate":
      return await migrateOnly();

    case "auth":
      return await auth(rest);

    case "backup":
      return await runBackup(rest);

    case "restore":
      return await runRestore(rest);

    // A client of a deployment somewhere else, not this one: it reads no database and starts
    // nothing, and its exit code is the verdict, so it leaves through process.exit.
    case "checks": {
      const { checks } = await import("./checks/cli.ts");
      return process.exit(await checks(rest));
    }

    // The same kind of client, serving an agent over stdio until the agent hangs up.
    case "mcp": {
      const { mcp } = await import("./mcp/cli.ts");
      return process.exit(await mcp(rest, VERSION));
    }

    default:
      fail(`unknown command ${JSON.stringify(command)}\n\n${HELP}`);
  }
}

/**
 * The whole deployment. Migrations and the UI are passed to the host root as hooks rather than
 * done here, so the ordering that matters — one cluster, opened once; schema before any module
 * reads it; every listener in one shutdown — stays in the single place that owns it.
 */
async function up(args: string[] = []): Promise<void> {
  // Before anything reads the environment: the settings file, applied without overriding what is
  // already set. One layer, one direction — see config_file.ts for why the file loses.
  await loadConfigIntoEnv();

  // The wizard, on a first launch with somebody there to answer it. It writes the file this
  // launch then reads, so the boot below sees the answers rather than a special case.
  let bannerPrinted = false;
  if (
    shouldRunSetup({
      interactive: interactiveTerminal(),
      configExists: await configExists(),
      disabled: args.includes("--no-setup"),
      dbUrl: resolveDbUrl(),
    })
  ) {
    print(banner(VERSION));
    bannerPrinted = true;
    const code = await runSetup(
      terminalPrompter({ paged: true }),
      resolveDbUrl(),
      (await readConfig()).values,
    );
    // Walking away from the questions cancels the launch too. Starting anyway would be the one
    // thing worse than asking: a deployment configured by a wizard nobody finished.
    if (code !== 0) process.exit(code);
    await loadConfigIntoEnv();
  }

  // No provisioner, or `manual` without the dev opt-in, is a deployment where every run sits
  // until it is marked lost. Refused here, before anything starts, rather than booted into a
  // status block warning nobody reads until a task never starts.
  const refusal = provisionerRefusal(process.env);
  if (refusal !== null) fail(refusal);

  // The host root owns the environment and reads RYPH_DB itself — reading it in two places is
  // how the two drift apart. But the DEFAULT differs: the host's is `./data/ryph`, which is
  // right for a checkout and wrong for a downloaded binary (see defaultDbUrl). So it is resolved
  // and written back here, before the host reads it, exactly as the log level is below. Still
  // one reader; this only decides what that reader finds.
  const dbUrl = resolveDbUrl();
  process.env.RYPH_DB = dbUrl;

  // The same bug, for the files the control plane keeps beside the database: a run's images and
  // environment build logs default to `./data` in a checkout, which from a binary is a different
  // directory per working directory — the images of last week's runs gone the moment `ryph up`
  // is started from somewhere else. Under RYPH_HOME instead, beside (never inside) the database
  // directory. Written back only when unset, exactly as RYPH_DB is. A build's cache and temp dirs
  // only while the launcher is this process: a launcher elsewhere owns them.
  applyFileDirDefaults(process.env);

  // Environment builds and checks, on wherever runs launch on docker: the host defaults the two
  // images a build reads, and the cache and temp dirs are among the files just defaulted above.
  for (const name of ["RYPH_ENVIRONMENTS", "RYPH_CHECKS"]) {
    if (!process.env[name]) process.env[name] = buildsDefault(process.env.RYPH_PROVISIONER);
  }
  // Fewer check pods at once than a cluster runs: they share this machine with every run.
  const concurrency = checksConcurrencyDefault(process.env.RYPH_PROVISIONER);
  if (!process.env.RYPH_CHECKS_CONCURRENCY && concurrency !== undefined) {
    process.env.RYPH_CHECKS_CONCURRENCY = concurrency;
  }

  // The forge runs in this process unless told to dial one elsewhere; its repo cache and patch
  // bundles are among the files just defaulted above.
  if (!process.env.RYPH_FORGE_URL) process.env.RYPH_FORGE_URL = "embedded";

  // And an in-process forge can read this machine's disk, so repositories may be added from the
  // home directory unless told a narrower root, or `off`.
  const localRoot = defaultedLocalRepoRoot(
    process.env.RYPH_FORGE_URL,
    process.env.RYPH_LOCAL_REPO_ROOT,
    defaultLocalRepoRoot(),
  );
  if (localRoot !== null) process.env.RYPH_LOCAL_REPO_ROOT = localRoot;

  // The master key, minted on first launch if there is nowhere it already lives. Same seam as
  // the database above: resolved here, read once by the host. A postgres:// deployment gets
  // null — model access stays off until the operator supplies one — unless RYPH_SECRETS_KEY_FILE
  // says where to keep it.
  const secretsKey = await loadOrCreateSecretsKey(dbUrl);
  if (secretsKey) process.env.RYPH_SECRETS_KEY = secretsKey.hex;
  // The egress proxy's claim key, where a proxy address is wired and no key is: derived from the
  // master key, so a deployment that only names the address (deploy/compose) needs nothing else.
  // `ryph setup` writes a key of its own, which wins.
  if (
    !process.env.RYPH_EGRESS_KEY?.trim() && process.env.RYPH_EGRESS_PROXY_URL?.trim() &&
    process.env.RYPH_SECRETS_KEY?.trim()
  ) {
    process.env.RYPH_EGRESS_KEY = deriveEgressKey(process.env.RYPH_SECRETS_KEY.trim());
  }

  // The app's server vouches for the client address it forwards with this, so a caller that
  // dials the control plane directly cannot pick its own (see @ryph/auth's proxySecret). Both
  // ends are this process: minted per launch, never written down.
  if (!process.env.RYPH_PROXY_SECRET) process.env.RYPH_PROXY_SECRET = mintHexKey();
  // What `ryph login` presents for a fresh link, in a file only this user reads — written once
  // this launch is up (onReady below), so a second `up` that fails to bind leaves the running
  // instance's file alone.
  const localLoginSecret = mintLoginSecret();

  const appPort = intEnv("RYPH_APP_PORT", DEFAULT_APP_PORT);
  // This process serves the UI, so it knows the app's origin; a deployment behind a domain
  // sets RYPH_APP_URL itself.
  if (!process.env.RYPH_APP_URL?.trim()) {
    process.env.RYPH_APP_URL = `http://localhost:${appPort}`;
  }
  // The origin the UI answers on, and the one its form POSTs are checked against: RYPH_APP_URL's,
  // so a deployment behind its own domain is not refused by name or as cross-site.
  const appUrlOrigin = appOrigin(process.env.RYPH_APP_URL, appPort);
  // And one it is reached at: the login link `up` prints and opens is built on it, so an address
  // the UI does not listen on would boot fine and hand out a link nothing answers (appReach).
  // A name is only warned of, under the banner.
  const { appBinds, appReach } = await import("./app_server.ts");
  const appReached = appReach(
    process.env.RYPH_APP_URL!,
    appBinds(process.env.RYPH_APP_BIND || undefined),
    appPort,
  );
  if (appReached !== null && "refuse" in appReached) fail(appReached.refuse);
  const apiPort = intEnv("RYPH_PORT", 7411);

  for (const set of MIGRATION_SETS) {
    if (!(await embeddedDirExists(set.dir))) {
      fail(
        `this build carries no ${set.name} migrations (looked in ${set.dir}). ` +
          "That is a build fault, not a configuration one — a release binary always embeds them.",
      );
    }
  }

  // The machinery's own log defaults to DEBUG, which for a downloaded binary is a wall of text
  // around the two lines that matter. WARN unless asked for more: the status block below already
  // says what the INFO lines say, the UI is where a run is watched, and anything that actually
  // went wrong still prints. `RYPH_LOG_LEVEL=info` (or debug) brings it all back.
  if (!process.env.RYPH_LOG_LEVEL) process.env.RYPH_LOG_LEVEL = "warn";

  // The host marks a run lost after 60 s without a heartbeat, which suits a cluster. On a laptop
  // the container runtime's VM stalls for minutes under a heavy image build or a sleep, and every
  // run inside it goes quiet together — alive, but lost and killed the moment the VM wakes. Ten
  // minutes outlasts a stall; a container that really died is noticed late, which costs nothing
  // here.
  if (!process.env.RYPH_HEARTBEAT_TIMEOUT_MS) {
    process.env.RYPH_HEARTBEAT_TIMEOUT_MS = "600000";
  }

  if (!bannerPrinted) print(banner(VERSION));
  if (appReached !== null && "warn" in appReached) print(`  ! ${appReached.warn}`);

  // Filled in by `prepare`, read by `onReady`: what the database needed doing to it, which is
  // the difference between a first launch and every launch after.
  const setup: string[] = [];
  // Settles once the UI listens (true), or fails to (false): the login link is opened only
  // after, so the browser does not land on a port nobody answers yet.
  let appReady: Promise<boolean> = Promise.resolve(true);

  // Previews are served by this process at http://<id>.localhost:<port>, which a browser on this
  // machine reaches: on a free loopback port each, or on one shared port a container publishes.
  const localPreviews = flagSetting("RYPH_LOCAL_PREVIEWS", process.env.RYPH_LOCAL_PREVIEWS, true);
  let previewListener: PreviewListener | undefined;
  try {
    previewListener = previewListenerFromEnv(process.env);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  await hostMain({
    localLoginSecret,
    // Memory's embeddings, on by default in the binary and loaded on first use.
    ...(isCompiled() ? { embeddings: BUNDLED_EMBEDDINGS } : {}),
    localPreviews,
    ...(previewListener === undefined ? {} : { previewListener }),
    prepare: async ({ cluster, historyCluster }) => {
      const { applied, embedded } = await applySchema(MIGRATION_SETS, cluster, historyCluster);
      const fresh = applied === 0;
      if (applied < embedded) {
        setup.push(
          fresh
            ? `created the database at ${cluster.description}`
            : `upgraded ${cluster.description}`,
        );
        setup.push(
          `applied ${embedded - applied} migration${embedded - applied === 1 ? "" : "s"}`,
        );
      }
      // Said once, on the launch that made it, and never again — but said clearly, because it is
      // the one piece of this deployment that a backup deliberately does not carry.
      if (secretsKey?.created && secretsKey.path !== null) {
        setup.push(`minted the master key at ${secretsKey.path} — back it up separately`);
      }
    },
    serveExtra: ({ stop }) => {
      // Started synchronously from the host root's perspective but resolved here: the promise is
      // deliberately not awaited, so a slow first import of the SvelteKit bundle cannot delay
      // the control plane from accepting requests.
      let server: Awaited<ReturnType<typeof import("./app_server.ts")["serveEmbeddedApp"]>> = null;
      const origin = appUrlOrigin;
      // A UI that cannot listen (its port taken, say) ends `up` with bindFailure's message,
      // whenever it happens, through the host's own stop: everything it started is drained
      // and the database closed before the exit. Caught inside, so the promise never rejects,
      // nothing that waits on it mistakes the failure for its own, and no rejection goes
      // unhandled.
      const ready = appReady = (async () => {
        try {
          const { forgeHooksUrl, serveEmbeddedApp } = await import("./app_server.ts");
          server = await serveEmbeddedApp({
            port: appPort,
            // 127.0.0.1, not localhost, which may resolve to ::1 first, where the control plane
            // does not listen and something else could.
            apiUrl: `http://127.0.0.1:${apiPort}`,
            origin,
            hostname: process.env.RYPH_APP_BIND || undefined,
            allowedHosts: process.env.RYPH_ALLOWED_HOSTS,
            // GitHub's and GitLab's webhook URLs are on RYPH_APP_URL; their deliveries go on to
            // the forge from here.
            forgeUrl: forgeHooksUrl(process.env.RYPH_FORGE_URL, process.env.RYPH_FORGE_PORT),
          });
        } catch (err) {
          console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
          stop(2);
          return false;
        }
        if (server === null) {
          print(`  ! no UI in this build (looked in ${APP_BUILD_DIR})`);
        }
        return true;
      })();
      return {
        describe: origin,
        shutdown: async () => {
          await ready;
          await server?.shutdown();
        },
      };
    },
    onReady: (summary) => {
      const block = describeDeployment(summary, setup);
      print(status(block));
      // The control plane is bound and the database is this launch's; the secret is written
      // once the UI has bound too, the last listener that can still fail, and not at all when it
      // did not (this launch is stopping). `appReady` never rejects, so the catch is the write's
      // alone.
      appReady.then((up) => up ? writeLoginSecret(localLoginSecret) : undefined).catch((err) => {
        print(`  ! \`ryph login\` will not work: could not write the login secret (${err})`);
      });
      if (block.open && summary.loginLink && interactiveTerminal() && !args.includes("--no-open")) {
        const link = block.open;
        appReady.then((up) => up ? openInBrowser(link) : undefined);
      }
    },
    // Runs still going are asked about; hosted tool servers are stopped either way. See stop.ts.
    beforeStop: (ctx) =>
      onStop(ctx, {
        prompter: interactiveTerminal() ? terminalPrompter() : null,
        say: print,
        now: () => new Date(),
      }),
  });
}

/**
 * The RYPH_LOCAL_REPO_ROOT `up` should set, or null to leave it as it is. Home is the default only
 * for the in-process forge (one reached over the network reads its own, and the host warns when
 * this one would go unused), and only when nothing was said: a root, or `off`, is kept as given,
 * and the host reads `off` as no root at all.
 */
export function defaultedLocalRepoRoot(
  forgeUrl: string | undefined,
  setting: string | undefined,
  home: string | null,
): string | null {
  if (forgeUrl !== "embedded" || setting) return null;
  return home;
}

/**
 * The embedded UI's origin: RYPH_APP_URL's, else loopback on the app's port when it is unset. The
 * app answers to its host (loopback's names always) and SvelteKit's CSRF check compares form
 * POSTs to it, so a deployment behind its own domain is reached on that domain — loopback still
 * serves pages, but a sign-in there is refused as cross-site. A RYPH_APP_URL that is not an
 * absolute http(s) URL throws, as auth refuses it: falling back would leave the app's origin and
 * every link auth builds disagreeing.
 */
export function appOrigin(raw: string | undefined, appPort: number): string {
  // Trimmed like the host's appUrlFromEnv, so a blank value is unset for both.
  const appUrl = raw?.trim();
  if (!appUrl) return `http://localhost:${appPort}`;
  const parsed = URL.parse(appUrl);
  if (parsed?.protocol !== "http:" && parsed?.protocol !== "https:") {
    throw new Error(`RYPH_APP_URL must be an absolute http(s) URL, got ${JSON.stringify(appUrl)}`);
  }
  return parsed.origin;
}

/** `as @login`, and `at <host>` for an instance other than gitlab.com. */
export function gitlabName(gitlab: NonNullable<HostSummary["forgeGitlab"]>): string {
  let host: string | null = null;
  try {
    host = new URL(gitlab.url).host;
  } catch {
    host = null;
  }
  return host === null || host === "gitlab.com"
    ? `as @${gitlab.login}`
    : `as @${gitlab.login} at ${host}`;
}

/** `did:key:z6MkehUNS8bx…Qxibb (alias)` — the identity Radicle user mode acts as, short enough for
 * one status row and still enough of the key to tell two apart. */
export function radicleName(radicle: NonNullable<HostSummary["radicle"]>): string {
  const did = radicle.did === null
    ? "an unreadable identity"
    : radicle.did.length > 32
    ? `${radicle.did.slice(0, 20)}…${radicle.did.slice(-5)}`
    : radicle.did;
  return radicle.alias === null ? did : `${did} (${radicle.alias})`;
}

/** Environment builds and checks, in one row: what a run starts from. */
function environmentsRow(summary: HostSummary): StatusRow {
  const env = summary.environments;
  if (env === null) return { label: "environments", value: "off" };
  if (env.refused !== null) {
    return { label: "environments", value: `off — ${env.refused}`, tone: "warn" };
  }
  const checks = summary.checks === null
    ? "checks off"
    : summary.checks.refused === null
    ? "checks on"
    : `checks off — ${summary.checks.refused}`;
  return {
    label: "environments",
    value: `${env.builder} builds · ${checks}`,
    tone: summary.checks?.refused ? "warn" : "good",
  };
}

/**
 * The status block. Only two kinds of line: what is running and where, and what is switched OFF
 * that someone would reasonably expect to be on. The second kind is the useful half: something
 * off that nothing names is invisible until a task sits there. (A runner that launches nothing
 * only gets this far under the dev opt-in, MANUAL_OPT_IN: `up` refuses it otherwise.)
 */
export function describeDeployment(summary: HostSummary, setup: string[]): {
  setup?: string[];
  rows: StatusRow[];
  notes?: string[];
  open?: string;
} {
  const rows: StatusRow[] = [
    {
      label: "web UI",
      value: summary.extra ?? "not in this build",
      tone: summary.extra ? "good" : "warn",
    },
    { label: "control plane", value: summary.controlPlaneUrl, tone: "good" },
    { label: "database", value: summary.db },
  ];

  if (summary.historyRemote) {
    rows.push({ label: "run history", value: `remote ${summary.historyRemote}` });
  } else if (summary.historyDb) {
    rows.push({ label: "run history", value: summary.historyDb });
  }

  // Every provisioner that actually launches a container, not just docker: a kubernetes
  // deployment with images reported as "runs will not start" is a status block lying about a
  // working install, which is worse than not having one.
  const launches = summary.provisioner === "docker" || summary.provisioner === "kubernetes";
  rows.push({
    label: "agent runner",
    value: launches
      ? `${summary.provisioner} · ${summary.agentImage ?? "no image"}`
      : `${summary.provisioner} — runs will not start`,
    tone: launches && summary.agentImage !== null ? "good" : "warn",
  });
  rows.push({
    label: "model access",
    value: summary.modelProxyUrl ?? "off — no RYPH_SECRETS_KEY",
    tone: summary.modelProxyUrl ? "good" : "warn",
  });
  // Tool access rides the same key by default, so in this binary the two are on or off
  // together — the note below names the one variable that fixes both.
  rows.push({
    label: "tool access",
    value: summary.mcpGatewayUrl ?? "off — no RYPH_MCP_KEY",
    tone: summary.mcpGatewayUrl ? "good" : "warn",
  });
  // How a repository can actually reach an agent, in the order of least setup. A local root is
  // the answer for the single-machine case and worth naming before a forge, which needs a git
  // host and something to sign in to it with.
  const repoWays: string[] = [];
  if (summary.forgeLocalRoot) repoWays.push(`add from ${summary.forgeLocalRoot} in the UI`);
  // An in-process forge with nothing behind it serves clones of nothing: not a way in yet. A
  // `local` provider alone is already named above, so the forge's own row is for the rest.
  const hosted = summary.forgeProviders?.filter((p) => p !== "local") ?? null;
  if (summary.forge && hosted?.length !== 0) {
    // The host spells an in-process forge "in-process on :<port> · <providers>"; `local` is the
    // root named first, so the row lists only the rest rather than naming it twice. GitHub in
    // user mode is named with the login it acts as, as the host's own line does; GitLab always
    // is, bot or person, with its host where it is not gitlab.com.
    const github = summary.forgeGithub;
    const gitlab = summary.forgeGitlab;
    const radicle = summary.radicle;
    const named = hosted?.map((p) =>
      p === "github" && github?.mode === "user"
        ? `github (as @${github.login})`
        : p === "gitlab" && gitlab !== null
        ? `gitlab (${gitlabName(gitlab)})`
        : p === "radicle" && radicle !== null
        ? `radicle (as ${radicleName(radicle)})`
        : p
    );
    const forge = named === undefined
      ? summary.forge
      : summary.forge.replace(/ · [^·]*$/, ` · ${named.join(", ")}`);
    repoWays.push(`forge ${forge}`);
  }
  rows.push({
    label: "repositories",
    value: repoWays.length > 0 ? repoWays.join(" · ") : "none configured",
    tone: repoWays.length > 0 ? "good" : "warn",
  });
  // Builds are a launching provisioner's: elsewhere there is nothing to build for.
  if (launches) rows.push(environmentsRow(summary));
  if (summary.authDisabled) {
    rows.push({ label: "sign-in", value: "DISABLED — the API is open", tone: "warn" });
  }

  const notes: string[] = [];
  if (!launches) {
    notes.push(
      "agents cannot run yet: run `ryph setup`, or set RYPH_PROVISIONER=docker and " +
        "RYPH_AGENT_IMAGE to launch them.",
    );
  } else if (summary.agentImage === null) {
    notes.push("no agent image configured — set RYPH_AGENT_IMAGE to an image ref.");
  } else if (summary.provisioner === "docker") {
    const unpinned = imageDefaultsNote();
    if (unpinned !== null) notes.push(unpinned);
  }
  if (!summary.modelProxyUrl) {
    notes.push(
      "agents with a model or tool policy are refused until RYPH_SECRETS_KEY is set. " +
        "`ryph setup` mints one, or bring your own: openssl rand -hex 32",
    );
  }
  if (repoWays.length === 0) {
    notes.push(
      "no way to reach a repository: `ryph setup`, or set RYPH_LOCAL_REPO_ROOT for repos on " +
        'this machine, RYPH_GITHUB_TOKEN_COMMAND="gh auth token" for GitHub, ' +
        "RYPH_GITLAB_TOKEN for GitLab, or a forge.",
    );
  }
  if (summary.radicle !== null && summary.radicle.did === null) {
    notes.push(
      `ryph could not read your Radicle identity in ${summary.radicle.home} — \`rad self\` ` +
        "failed after boot; Radicle work fails until it reads again.",
    );
  }
  if (summary.radicle !== null && !summary.radicle.nodeRunning) {
    notes.push(
      `your radicle-node is not running (RAD_HOME ${summary.radicle.home}): ryph can read your ` +
        "repositories, but nothing reaches the network and no comment arrives until " +
        "`rad node start`.",
    );
  }
  // No "without a forge" note: `up` mounts one in-process unless told to dial another, so a
  // status block with none is not a state this binary reaches.

  if (summary.loginLink) {
    notes.push("the link below signs you in once. `ryph login` opens a new one.");
  } else if (summary.setupToken && summary.extra) {
    notes.push(
      "this deployment has no owner yet: the link below claims it, and stops working once " +
        "someone has.",
    );
  }

  // Where to go: signed in, single-user; the claim, multi-user and unclaimed; else the app.
  const open = summary.loginLink ??
    (summary.setupToken && summary.extra
      ? `${summary.extra}/register?setup=${summary.setupToken}`
      : summary.extra);
  return {
    ...(setup.length > 0 ? { setup } : {}),
    rows,
    ...(notes.length > 0 ? { notes } : {}),
    ...(open ? { open } : {}),
  };
}

/**
 * A fresh login link for the `ryph up` running on this machine — after a session expired, or
 * from another browser. Single-user only: with several users, each signs in as themself.
 */
async function login(args: string[]): Promise<void> {
  await loadConfigIntoEnv();
  const apiPort = intEnv("RYPH_PORT", 7411);
  const result = await requestLoginLink(`http://127.0.0.1:${apiPort}`);
  if (!result.ok) fail(result.reason);
  console.log(result.link);
  if (!args.includes("--no-open") && interactiveTerminal()) void openInBrowser(result.link);
}

/**
 * The wizard, on demand — the answer to "how do I change what I said the first time".
 *
 * Deliberately does NOT apply the settings file to the environment first. The first question it
 * asks is whether a master key already exists, and a file-supplied one reported as "the
 * environment has this" would be a wizard lying about its own output.
 */
async function setup(argv: string[]): Promise<void> {
  let args;
  try {
    args = parseSetupArgs(argv);
  } catch (err) {
    if (err instanceof NeedsAnswer) fail(err.message);
    throw err;
  }
  // With nobody to ask, every unanswered question takes its default, and that is only done when
  // asked for: a setup that writes defaults because stdin happened to be a pipe is a surprise.
  const terminal = interactiveTerminal();
  if (!terminal && !args.yes) {
    fail(
      (process.env[NO_INPUT]
        ? "--no-input means nothing is asked."
        : "there is no terminal to ask in.") +
        " Pass --yes to take the default for every question no " +
        "flag answers; `ryph setup --help` lists the flags.",
    );
  }
  const io = answeringPrompter(
    args.answers,
    terminal && !args.yes ? terminalPrompter({ paged: true }) : null,
  );
  const file = (await readConfig()).values;
  const dbUrl = resolveDbUrl(process.env.RYPH_DB || file.get("RYPH_DB") || defaultDbUrl());
  const code = await runSetup(io, dbUrl, file);
  // A flag for a question this machine never asked (no Radicle identity, a key from the
  // environment) did nothing, and saying so beats a script believing it did.
  if (code === 0) {
    for (const id of io.unused().filter((id) => !args.implied.has(id))) {
      print(`! --${id} did nothing: that question was not asked here.`);
    }
  }
  if (code !== 0) process.exit(code);
}

/** What a launch from here resolves to, and which layer decided each value. */
async function showConfig(): Promise<void> {
  const { values, ignored } = await readConfig();
  const dbUrl = resolveDbUrl(
    process.env.RYPH_DB || values.get("RYPH_DB") || defaultDbUrl(),
  );
  const env = new Map(
    Object.entries({ ...process.env } as Record<string, string>).filter(([key]) =>
      key.startsWith("RYPH_")
    ),
  );
  const stored = process.env.RYPH_SECRETS_KEY || values.get("RYPH_SECRETS_KEY")
    ? null
    : (await readSecretsKey(dbUrl).catch(() => null))?.path ?? null;
  const rows = describeSettings({
    env,
    file: values,
    defaults: {
      dbUrl: resolveDbUrl(defaultDbUrl()),
      appPort: DEFAULT_APP_PORT,
      apiPort: 7411,
      // `up` defaults the root only for the in-process forge, so this reports one only then.
      localRepoRoot: (process.env.RYPH_FORGE_URL || values.get("RYPH_FORGE_URL") ||
          "embedded") === "embedded"
        ? defaultLocalRepoRoot()
        : null,
    },
    storedKeyPath: stored,
    home: ryphHome(),
  });
  // Data, so stdout — unlike the banner and the questions, this is a thing you pipe into grep.
  printSettings((text = "") => console.log(text), rows, configPath());
  if (ignored.length > 0) {
    console.log(`  Ignored in that file (settings are RYPH_* only): ${ignored.join(", ")}`);
    console.log();
  }
}

/** Applies the schema and exits. For provisioning a database ahead of starting anything. */
async function migrateOnly(): Promise<void> {
  const dbUrl = resolveDbUrl();
  const cluster = await openDbCluster(dbUrl);
  try {
    // Every set into RYPH_DB, the historian's included: a transcript database of its own is
    // provisioned by `up`, which is where RYPH_HISTORY_DB is read.
    const { applied, embedded } = await applySchema(MIGRATION_SETS, cluster, null);
    console.log(
      applied === embedded
        ? `${cluster.description} already has all ${embedded} migrations`
        : `applied ${embedded - applied} migration(s) to ${cluster.description}`,
    );
  } finally {
    await cluster.close();
  }
}

/**
 * Lockout recovery: `ryph auth grant-owner <email>` writes the role into the database this
 * command is pointed at, and ends the user's sessions so their next token says so. Never a
 * listener: whoever can run this on the host already holds the database.
 */
async function auth(args: string[]): Promise<void> {
  const [verb, email] = args;
  if (verb !== "grant-owner" || !email) fail("usage: ryph auth grant-owner <email>");
  const cluster = await openDbCluster(resolveDbUrl());
  try {
    const store = drizzleAuthStore(scopeAuthDb(cluster));
    const user = await store.getUserByEmail(email.toLowerCase());
    if (user === null) fail(`no user with the address ${JSON.stringify(email)}`);
    if (user.role === "owner") {
      console.log(`${user.email} is already an owner`);
      return;
    }
    await store.saveUser({ ...user, role: "owner", updatedAt: new Date().toISOString() });
    await store.deleteSessionsByUser(user.id);
    console.log(`${user.email} is now an owner; sign in again to pick it up`);
  } finally {
    await cluster.close();
  }
}

async function runBackup(args: string[]): Promise<void> {
  const [outPath] = args;
  if (!outPath) fail("usage: ryph backup <file>");
  const dbUrl = resolveDbUrl();
  // Stated rather than assumed: PGlite is single-connection, so this dump would serialise behind
  // — and stall — a running server's queries, heartbeats included.
  const { bytes } = await backup(dbUrl, outPath);
  console.log(`wrote ${outPath} (${formatBytes(bytes)}) — stop \`ryph up\` before backing up`);

  // The images runs were handed are not in this file either: they are files, not rows, so
  // PGlite's dump never sees them. Restoring without them loses those pictures and nothing else
  // (every door reads through a row and answers a missing blob as no image), so it is said here
  // rather than packed into a second archive format.
  const files = process.env.RYPH_ATTACHMENT_DIR || defaultFileDirs().RYPH_ATTACHMENT_DIR;
  if (files !== undefined) {
    console.log(`  run images are not in the snapshot: copy ${files} alongside it to keep them`);
  }

  // The master key is NOT in this file, deliberately — that is what makes a backup safe to copy
  // about. Which also means a restore elsewhere needs the key carried separately, and the moment
  // to say so is now, not when someone finds their provider keys unopenable.
  const sealed = await countSealedKeys(dbUrl);
  const keyPath = secretsKeyPath(dbUrl);
  if (sealed > 0 && keyPath !== null) {
    console.log(
      `  ! ${sealed} provider key${sealed === 1 ? " is" : "s are"} sealed in this snapshot. ` +
        `The key that opens ${sealed === 1 ? "it" : "them"} is ${keyPath} and is NOT in the ` +
        "file — copy it separately, or they cannot be restored.",
    );
  }
}

async function runRestore(args: string[]): Promise<void> {
  const [inPath, ...flags] = args;
  if (!inPath) fail("usage: ryph restore <file> [--force]");
  const dbUrl = resolveDbUrl();
  if (await dataDirExists(dbUrl) && !flags.includes("--force")) {
    fail(
      `${parseDbUrl(dbUrl).kind === "pglite" ? "there is already a database at" : "target"} ` +
        `${dbUrl}. Restoring REPLACES it and there is no undo — ` +
        "pass --force once you have a backup of what is there now.",
    );
  }
  await restore(dbUrl, inPath);
  console.log(`restored ${inPath} into ${dbUrl}`);

  // A snapshot's sealed keys are openable only by the key that sealed them. Said here, loudly,
  // because the alternative is a working-looking restore whose provider keys fail at the first
  // run that needs one — by which point the cause is a machine and a week away.
  const sealed = await countSealedKeys(dbUrl);
  if (sealed > 0) {
    const key = await loadOrCreateSecretsKey(dbUrl).catch(() => null);
    const keyPath = secretsKeyPath(dbUrl);
    if (key === null || key.created) {
      console.error(
        `\n  ! this snapshot holds ${sealed} sealed provider key${sealed === 1 ? "" : "s"}, and ` +
          `${
            key?.created
              ? `${keyPath} was only just created — it is not the key that sealed them`
              : "no master key is configured here"
          }.\n` +
          (keyPath === null
            ? "    Set RYPH_SECRETS_KEY to the value the source machine used"
            : `    Copy that machine's secrets.key over ${keyPath}`) +
          ", or delete and re-add the provider keys.",
      );
    }
  }
}

/**
 * An on/off setting, spelled `on`/`off` (also `true`/`false`, `1`/`0`, `yes`/`no`). Anything else
 * throws rather than being read as either: a capability somebody thought they had turned off must
 * not stay on because of a typo. Unset (or blank) is `fallback`.
 */
export function flagSetting(name: string, raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim();
  if (!value) return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`${name} must be on or off, got ${JSON.stringify(raw)}`);
}

/**
 * The one port every preview shares (RYPH_LOCAL_PREVIEWS_PORT), or undefined for a loopback port
 * each. Throws on a port that is not one, or on the other two settings without it, which would
 * otherwise be silently ignored.
 */
export function previewListenerFromEnv(
  env: Record<string, string | undefined>,
): PreviewListener | undefined {
  const portOf = (name: string): number | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0 || value > 65535) {
      throw new Error(`${name} must be a port number, got ${JSON.stringify(env[name])}`);
    }
    return value;
  };
  const port = portOf("RYPH_LOCAL_PREVIEWS_PORT");
  const publicPort = portOf("RYPH_LOCAL_PREVIEWS_PUBLIC_PORT");
  const hostname = env.RYPH_LOCAL_PREVIEWS_BIND?.trim() || undefined;
  if (port === undefined) {
    if (publicPort !== undefined || hostname !== undefined) {
      throw new Error(
        "RYPH_LOCAL_PREVIEWS_BIND and RYPH_LOCAL_PREVIEWS_PUBLIC_PORT need " +
          "RYPH_LOCAL_PREVIEWS_PORT: without it each preview takes a free loopback port",
      );
    }
    return undefined;
  }
  return {
    port,
    hostname: hostname ?? "127.0.0.1",
    ...(publicPort === undefined ? {} : { publicPort }),
  };
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

/** Runs the CLI on `args`. The binary's entry (entry.ts) calls it; so does `bun main.ts`. */
async function cli(args: string[]): Promise<void> {
  await main(args).catch((err: unknown) => {
    // Config-shaped failures (a bad URL, a downgrade, a missing file) read as one line, not a
    // stack: the person hitting them is running a downloaded binary, not debugging ours.
    fail(err instanceof Error ? err.message : String(err));
  });
}

if (import.meta.main) {
  const hostile = hostileEnvironment(process.env);
  if (hostile !== null) {
    console.error(`ryph: refusing to start: ${hostile.message}`);
    process.exit(2);
  }
  await cli(process.argv.slice(2));
}

export { cli, isCompiled, main, VERSION };

// The composition root —
// the only file that knows which adapter stands behind each port, reads the environment,
// and owns the listening socket. Wiring changes here; the core does not move.
//
// "The forge boundary" is this whole service (@ryph/forge); "the git gateway" is doors ① and ②,
// its read-only git server — see docs/architecture.md and docs/git-gateway.md. This file wires the
// boundary: doors ① (git clone) and ② (bundle intake) always, ③ (GitHub — as an App, or as one
// person's token; GitLab — as a bot user, or as one person's token; Radicle) when configured.
//
// The boundary keeps all of its state under one data root, split into three directories by how much
// each one matters if it is lost:
//   <data>/cache/    one bare clone per connected repo. Disposable: deleting it just forces a re-fetch.
//   <data>/patches/  the saved patch bundles. Durable: this is the real output, so guard it like a database.
//   <data>/staging/  scratch space for work in progress. Wiped on every boot.

import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { Logger, setupLoggerFromEnv } from "@ryph/logger";
import {
  type HttpServer,
  installDrain,
  makeHealth,
  refusePublicDevSecrets,
  serve,
  type ServeHandler,
} from "@ryph/service";
import { makeHandler } from "./http/app.ts";
import { forgeDataRoot } from "./helpers/data_root.ts";
import { type ForgeApi, type ForgeRegistry, providerRegistry } from "./ports/forge_api.ts";
import type { ChangeTransport, ChangeTransportRegistry } from "./ports/change_transport.ts";
import type { GithubAppApi, GithubMode } from "./ports/github_app.ts";
import { githubChangeTransport } from "./adapters/change_transport/github.ts";
import { loggerDiagnostics } from "./adapters/diagnostics/logger.ts";
import { localFsRepoCache } from "./adapters/repo_cache/local_fs.ts";
import { localFsPatchStore } from "./adapters/patch_store/local_fs.ts";
import { s3PatchStore } from "./adapters/patch_store/s3.ts";
import type { PatchStore } from "./ports/patch_store.ts";
import { httpKeyStore } from "./adapters/key_store/http.ts";
import { httpToolGrants } from "./adapters/tool_grants/http.ts";
import { httpRunImages } from "./adapters/run_images/http.ts";
import { makeToolService } from "./core/tool_service.ts";
import { describeGap, subscriptionReports } from "./core/app_subscriptions.ts";
import {
  type GithubAppForge,
  githubForgeApi,
  type GithubUserForge,
  holdsWorkflowScope,
  missingUserScopes,
} from "./adapters/forge_api/github.ts";
import {
  commandUserToken,
  GITLAB_TOKEN_NAMES,
  staticUserToken,
  type UserTokenSource,
} from "./helpers/user_token.ts";
import { githubWebhookConsumer } from "./adapters/forge_api/github_webhooks.ts";
import { radicleForgeApi } from "./adapters/forge_api/radicle.ts";
import { radicleEventConsumer } from "./adapters/forge_api/radicle_events.ts";
import { radicleChangeTransport } from "./adapters/change_transport/radicle.ts";
import type { RadicleBridgeApi, RadicleBridgeMode } from "./ports/radicle_bridge.ts";
import { gitlabForgeApi, type GitlabForgeOptions } from "./adapters/forge_api/gitlab.ts";
import {
  gitlabDoorGate,
  gitlabDropReporter,
  gitlabHookAdmission,
  gitlabHookDedupeKey,
  gitlabHookLane,
  gitlabWebhookConsumer,
} from "./adapters/forge_api/gitlab_webhooks.ts";
import {
  GITLAB_HOOK_READS_PER_MINUTE,
  gitlabHookReads,
  hookBudget,
} from "./adapters/forge_api/gitlab_hook_reads.ts";
import { gitlabClient } from "./adapters/forge_api/gitlab_client.ts";
import { gitlabChangeTransport } from "./adapters/change_transport/gitlab.ts";
import {
  GITLAB_HOOK_GENERATION_PARAM,
  GITLAB_HOOK_LABEL,
  GITLAB_HOOK_SCOPE_PARAM,
  type GitlabForge,
  type GitlabMode,
} from "./ports/gitlab.ts";
import type { EventSink, GitlabHookGate } from "./ports/event_sink.ts";
import type { Diagnostics } from "./ports/diagnostics.ts";
import type { RepoCache } from "./ports/repo_cache.ts";
import { localForgeApi } from "./adapters/forge_api/local.ts";
import { localChangeTransport } from "./adapters/change_transport/local.ts";
import { httpEventSink, httpGitlabHookGate } from "./adapters/event_sink/http.ts";
import {
  coalescingTick,
  drizzleHookStore,
  livenessRoutes,
  makeWebhooksDb,
  setup as setupWebhooks,
  type WebhookRegistrationInput,
  type WebhooksDbHandle,
  type WebhooksSetup,
} from "@ryph/webhooks";

// The webhook drain's advisory-lock key — held from scan to scan by the one replica that delivers.
// Same style as the orchestrator's sweep keys, but a different database (`ryph_forge`), so the
// number space is this service's own.
const LOCK_WEBHOOK_SWEEP = 8_200_001;

const env = (name: string): string | undefined => process.env[name] || undefined;

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

export type { GithubMode, GitlabMode };

/**
 * How this deployment acts on GitHub, read from the environment: as an App (all four of its
 * credentials), as one person (`RYPH_GITHUB_TOKEN` or `RYPH_GITHUB_TOKEN_COMMAND`), or not at
 * all. Never both: with an App and a person each configured, every GitHub call would have to
 * ask "as whom?", and neither answer is right for both kinds of deployment — so any mix is a
 * boot error rather than a precedence rule somebody has to remember.
 *
 * Throws with the operator-facing reason; the caller turns that into a failed boot. No value it
 * was given ever appears in a message — only the names of the variables.
 */
export async function readGithubSettings(
  get: (name: string) => string | undefined,
): Promise<GithubSettings> {
  const token = get("RYPH_GITHUB_TOKEN");
  const tokenCommand = get("RYPH_GITHUB_TOKEN_COMMAND");
  const appNames = [
    "RYPH_GITHUB_APP_ID",
    "RYPH_GITHUB_PRIVATE_KEY",
    "RYPH_GITHUB_PRIVATE_KEY_PATH",
    "RYPH_GITHUB_CLIENT_ID",
    "RYPH_GITHUB_CLIENT_SECRET",
  ];
  if (token !== undefined || tokenCommand !== undefined) {
    // The networked forge's image sets RYPH_FORGE_NO_TOKEN_COMMAND=1: the token command is the
    // binary's, and a forge holding the shared bearer runs no shell for one. Deno's
    // --allow-run=git said this before; under Bun the image has to say it.
    if (tokenCommand !== undefined && get("RYPH_FORGE_NO_TOKEN_COMMAND") === "1") {
      throw new Error(
        "RYPH_GITHUB_TOKEN_COMMAND is set, but this forge may not run a token command " +
          "(RYPH_FORGE_NO_TOKEN_COMMAND=1) — the token command is for the ryph binary; a " +
          "networked forge takes RYPH_GITHUB_TOKEN",
      );
    }
    if (token !== undefined && tokenCommand !== undefined) {
      throw new Error(
        "RYPH_GITHUB_TOKEN and RYPH_GITHUB_TOKEN_COMMAND are both set — name the token one way",
      );
    }
    const appSet = appNames.filter((name) => get(name) !== undefined);
    if (appSet.length > 0) {
      throw new Error(
        `${
          token !== undefined ? "RYPH_GITHUB_TOKEN" : "RYPH_GITHUB_TOKEN_COMMAND"
        } is set, and so is ${appSet.join(", ")} — GitHub runs in App mode or user mode, ` +
          "never both",
      );
    }
    // User mode has no webhooks: GitHub signs deliveries for an App, and a person's token is
    // not one. A secret here would be a door that never opens, said at boot instead.
    if (get("RYPH_GITHUB_WEBHOOK_SECRET") !== undefined) {
      throw new Error(
        "RYPH_GITHUB_WEBHOOK_SECRET is set, but GitHub is in user mode (a token, not an App) — " +
          "user mode has no webhooks; unset it",
      );
    }
    return {
      mode: "user",
      token: tokenCommand === undefined
        ? { kind: "static", token: token ?? "" }
        : { kind: "command", command: tokenCommand },
    };
  }

  // The App: its id and key, or neither — a partial set fails fast. With neither, there is no
  // GitHub at all, and doors ① and ② serve as normal. Its OAuth client pair is optional, both or
  // neither: without it the App acts on its installations and nobody signs in through it.
  const appId = get("RYPH_GITHUB_APP_ID");
  const privateKeyPath = get("RYPH_GITHUB_PRIVATE_KEY_PATH");
  let privateKeyPem = get("RYPH_GITHUB_PRIVATE_KEY");
  if (privateKeyPath !== undefined) {
    try {
      privateKeyPem = await readFile(privateKeyPath, "utf8");
    } catch {
      throw new Error(`RYPH_GITHUB_PRIVATE_KEY_PATH: cannot read ${privateKeyPath}`);
    }
  }
  const clientId = get("RYPH_GITHUB_CLIENT_ID");
  const clientSecret = get("RYPH_GITHUB_CLIENT_SECRET");
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      "a GitHub App's OAuth client needs both RYPH_GITHUB_CLIENT_ID and " +
        "RYPH_GITHUB_CLIENT_SECRET — one is set, the other is not",
    );
  }
  // Testing both narrows each to `string`; a partial set is the error below.
  if (appId && privateKeyPem) {
    return {
      mode: "app",
      appId,
      privateKeyPem,
      // Where the key came from, for a boot error that has to name it.
      privateKeySource: privateKeyPath
        ? `RYPH_GITHUB_PRIVATE_KEY_PATH (${privateKeyPath})`
        : "RYPH_GITHUB_PRIVATE_KEY",
      oauth: clientId && clientSecret ? { clientId, clientSecret } : null,
    };
  }
  if ([appId, privateKeyPem, clientId, clientSecret].some(Boolean)) {
    throw new Error(
      "a GitHub App needs both RYPH_GITHUB_APP_ID and RYPH_GITHUB_PRIVATE_KEY[_PATH] (and " +
        "RYPH_GITHUB_CLIENT_ID and _SECRET for sign-in) — some are set, some are not",
    );
  }
  return null;
}

/** Every variable GitLab's configuration is read from — a partial set names these. */
const GITLAB_NAMES = [
  "RYPH_GITLAB_URL",
  "RYPH_GITLAB_MODE",
  "RYPH_GITLAB_TOKEN",
  "RYPH_GITLAB_TOKEN_COMMAND",
  "RYPH_GITLAB_WEBHOOK_SECRET",
  "RYPH_GITLAB_CLIENT_ID",
  "RYPH_GITLAB_CLIENT_SECRET",
  "RYPH_GITLAB_GROUP",
] as const;

/** gitlab.com, the instance a deployment that names none acts on. */
export const DEFAULT_GITLAB_URL = "https://gitlab.com";

/**
 * How this deployment acts on GitLab, read from the environment — or null where no variable of
 * it is set at all. ONE instance (`RYPH_GITLAB_URL`, gitlab.com by default, a path prefix
 * allowed) in ONE mode (`RYPH_GITLAB_MODE`, `bot` by default): a bot user's token, with webhooks
 * (`RYPH_GITLAB_WEBHOOK_SECRET`), sign-in (`RYPH_GITLAB_CLIENT_ID`/`_SECRET`) and a sign-up group
 * (`RYPH_GITLAB_GROUP`), or `user` — one person's token, none of those (as GitHub user mode).
 * The token is `RYPH_GITLAB_TOKEN` or `RYPH_GITLAB_TOKEN_COMMAND`, exactly one.
 *
 * A partial or contradictory set throws with the operator-facing reason, which names variables
 * and never a value. Whether the webhook secret has its database is `startForge`'s check.
 */
export function readGitlabSettings(
  get: (name: string) => string | undefined,
): GitlabSettings {
  const set = GITLAB_NAMES.filter((name) => get(name) !== undefined);
  if (set.length === 0) return null;
  const token = get("RYPH_GITLAB_TOKEN");
  const tokenCommand = get("RYPH_GITLAB_TOKEN_COMMAND");
  if (token === undefined && tokenCommand === undefined) {
    throw new Error(
      `${set.join(", ")} ${set.length === 1 ? "is" : "are"} set, but neither ` +
        "RYPH_GITLAB_TOKEN nor RYPH_GITLAB_TOKEN_COMMAND is — GitLab needs the token ryph acts with",
    );
  }
  if (token !== undefined && tokenCommand !== undefined) {
    throw new Error(
      "RYPH_GITLAB_TOKEN and RYPH_GITLAB_TOKEN_COMMAND are both set — name the token one way",
    );
  }
  // The networked forge runs no shell for a token, as for GitHub's (`readGithubSettings`).
  if (tokenCommand !== undefined && get("RYPH_FORGE_NO_TOKEN_COMMAND") === "1") {
    throw new Error(
      "RYPH_GITLAB_TOKEN_COMMAND is set, but this forge may not run a token command " +
        "(RYPH_FORGE_NO_TOKEN_COMMAND=1) — the token command is for the ryph binary; a " +
        "networked forge takes RYPH_GITLAB_TOKEN",
    );
  }
  const mode = get("RYPH_GITLAB_MODE") ?? "bot";
  if (mode !== "bot" && mode !== "user") {
    throw new Error(`RYPH_GITLAB_MODE must be "bot" or "user", got ${JSON.stringify(mode)}`);
  }
  const rawUrl = get("RYPH_GITLAB_URL") ?? DEFAULT_GITLAB_URL;
  const url = gitlabUrlOf(rawUrl);
  if (url === null) {
    throw new Error(
      `RYPH_GITLAB_URL must be an http(s) URL with no credentials, query or fragment, got ${
        JSON.stringify(rawUrl)
      }`,
    );
  }
  const webhookSecret = get("RYPH_GITLAB_WEBHOOK_SECRET") ?? null;
  const clientId = get("RYPH_GITLAB_CLIENT_ID");
  const clientSecret = get("RYPH_GITLAB_CLIENT_SECRET");
  const group = get("RYPH_GITLAB_GROUP") ?? null;
  if (mode === "user") {
    // User mode is one person: no webhooks (merges are polled), no sign-in (the token's person
    // is everyone's GitLab identity), no group. Each would be a door that never opens.
    const botOnly = [
      "RYPH_GITLAB_WEBHOOK_SECRET",
      "RYPH_GITLAB_CLIENT_ID",
      "RYPH_GITLAB_CLIENT_SECRET",
      "RYPH_GITLAB_GROUP",
    ].filter((name) => get(name) !== undefined);
    if (botOnly.length > 0) {
      throw new Error(
        `${botOnly.join(", ")} ${botOnly.length === 1 ? "is" : "are"} set, but GitLab is in ` +
          "user mode (RYPH_GITLAB_MODE=user) — user mode has no webhooks, sign-in or group; " +
          "unset them",
      );
    }
  }
  if ((clientId === undefined) !== (clientSecret === undefined)) {
    throw new Error(
      "a GitLab OAuth application needs both RYPH_GITLAB_CLIENT_ID and " +
        "RYPH_GITLAB_CLIENT_SECRET — one is set, the other is not",
    );
  }
  if (
    group !== null &&
    (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){0,19}$/.test(group) ||
      group.split("/").some((seg) => seg === "." || seg === ".."))
  ) {
    throw new Error(
      `RYPH_GITLAB_GROUP must be a group path (group or group/subgroup), got ${
        JSON.stringify(group)
      }`,
    );
  }
  return {
    mode,
    url,
    token: tokenCommand === undefined
      ? { kind: "static", token: token ?? "" }
      : { kind: "command", command: tokenCommand },
    webhookSecret,
    oauth: clientId !== undefined && clientSecret !== undefined ? { clientId, clientSecret } : null,
    group,
  };
}

/** `RYPH_GITLAB_URL` as the adapter takes it — an http(s) origin plus any path prefix, with no
 * trailing slash — or null for anything else. Credentials, a query or a fragment are refused
 * rather than dropped: each would change where, or as whom, the token is presented. */
export function gitlabUrlOf(raw: string): string | null {
  if (!URL.canParse(raw)) return null;
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** What `readGitlabSettings` makes of the environment; null is no GitLab at all. */
export type GitlabSettings = {
  mode: "bot" | "user";
  url: string;
  token: { kind: "static"; token: string } | { kind: "command"; command: string };
  /** Bot mode only; null when webhooks are not set up (merges are then polled). */
  webhookSecret: string | null;
  /** Bot mode only; null when there is no sign-in through GitLab. */
  oauth: { clientId: string; clientSecret: string } | null;
  /** Bot mode only; the sign-up gate's group path, null when unset. */
  group: string | null;
} | null;

/** Each GitLab project's budgets at the door: a minute's deliveries, a busy project's worth, for
 * its comments and as much again for every other event (`gitlabHookLane`), so merge request
 * churn never drops a `/ryph` note. Each one stored costs the bot up to three GitLab reads, so
 * this is also what one project's token holder can make the bot spend of the rate limit every
 * project shares — which `hookBudget` caps over every project anyway. */
export const GITLAB_HOOK_RATE_LIMIT = {
  maxPerWindow: 60,
  windowMs: 60_000,
  per: "scope",
  lane: gitlabHookLane,
  // Answered 202 and dropped past it, never 429: GitLab retries nothing and counts every 4xx
  // toward disabling the hook, which would lose the project's later deliveries too.
  over: "drop",
} as const;

/** How long a taken GitLab delivery is kept: a week, for the log. */
export const GITLAB_HOOK_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** What a configured GitLab adds to the forge: the adapter (door ③ and ⑤), its change transport,
 * and — in bot mode with a webhook secret — door ④'s mailbox. */
export interface GitlabWiring {
  forge: GitlabForge;
  transport: ChangeTransport;
  /** The "gitlab" mailbox, or null where there are no webhooks (user mode, or no secret: merges
   * are then polled by the control plane). */
  mailbox: WebhookRegistrationInput | null;
}

/**
 * Builds GitLab's half of the forge from its settings: the token source (static, or the command
 * — `GITLAB_TOKEN_NAMES`, so a failure speaks of RYPH_GITLAB_TOKEN), the adapter, which reads at
 * boot what it acts as (the instance's version, the token's scopes, its own account), the
 * transport over it, and the mailbox its webhooks land in.
 *
 * Throws with an operator-facing reason that never names the token; the caller fails the boot.
 * `build` is the adapter, for a test.
 */
export async function wireGitlab(
  settings: NonNullable<GitlabSettings>,
  deps: {
    cache: RepoCache;
    diag: Diagnostics;
    sink: EventSink;
    gate: GitlabHookGate;
    build?: (opts: GitlabForgeOptions) => Promise<GitlabForge>;
  },
): Promise<GitlabWiring> {
  const { cache, diag } = deps;
  const token: UserTokenSource = settings.token.kind === "static"
    ? staticUserToken(settings.token.token, GITLAB_TOKEN_NAMES)
    : commandUserToken({ command: settings.token.command, diag, names: GITLAB_TOKEN_NAMES });
  const forge = await (deps.build ?? gitlabForgeApi)({
    mode: settings.mode,
    url: settings.url,
    token,
    webhookSecret: settings.webhookSecret,
    oauth: settings.oauth,
    group: settings.group,
    diag,
  });
  // DOOR ④, the GitLab half. Each project's hook carries its own `X-Gitlab-Token`, derived from
  // the master secret, the project id and the token generation the delivery URL names, so a
  // token leaked from one project vouches for that project only, and a rotated one for nothing
  // once the control plane moved the generation on. The mailroom checks it before the body is
  // parsed, hands the consumer the project and generation it verified, and keeps each project's
  // deliveries in a queue of their own. The door asks the control plane whether the project is
  // connected at that generation before it stores anything (`gitlabDoorGate`), and spends a
  // budget per project, so a rotated, demoted or archived token costs no row and a live one can
  // flood only its own project's queue — every row it stores costs the bot GitLab reads. The
  // consumer asks again, then reads from GitLab — with the bot's token, under the verified
  // project — everything the event says: the delivery's body is a doorbell, never a source.
  // A note rung again once one ring of it was taken is dropped by the mailroom unread
  // (`gitlabHookDedupeKey`), and a merge request or push rung again names the state GitLab
  // answered, which the control plane answers from its record. The consumer's reads of every
  // project and the control plane's calls for every event it forwards spend one budget
  // (`hookBudget`), so no number of projects can spend the bot's API rate limit: each delivery
  // reserves the most it can spend before it is claimed (`gitlabHookAdmission`), least-spent
  // project first, and one the budget cannot cover yet waits without spending an attempt.
  // Taken deliveries are kept a week, for the log, and then dropped.
  const budget = hookBudget({ perMinute: GITLAB_HOOK_READS_PER_MINUTE, now: Date.now });
  const mailbox: WebhookRegistrationInput | null = settings.webhookSecret === null ? null : {
    id: "gitlab",
    verification: {
      kind: "derived-secret-header",
      header: "x-gitlab-token",
      master: settings.webhookSecret,
      label: GITLAB_HOOK_LABEL,
      scopeParam: GITLAB_HOOK_SCOPE_PARAM,
      generationParam: GITLAB_HOOK_GENERATION_PARAM,
    },
    admitScope: gitlabDoorGate(deps.gate, { now: Date.now, diag }),
    rateLimit: GITLAB_HOOK_RATE_LIMIT,
    onOverLimit: gitlabDropReporter(deps.gate, { diag }),
    retainTerminalMs: GITLAB_HOOK_RETENTION_MS,
    dedupeKey: gitlabHookDedupeKey,
    admitDelivery: gitlabHookAdmission(budget),
    consumer: gitlabWebhookConsumer({
      sink: deps.sink,
      diag,
      // Notes carry no bot flag: the bot's own are told apart by its user id.
      botUserId: forge.self.id,
      gate: deps.gate,
      reads: gitlabHookReads(gitlabClient({ url: settings.url, token, diag, now: Date.now })),
      budget,
    }),
  };
  return {
    forge,
    transport: gitlabChangeTransport({ api: forge, cache, diag }),
    mailbox,
  };
}

/**
 * What a user-mode token's scopes are worth a line about at boot, said once. A classic or `gh`
 * token says what it may do; a fine-grained one says nothing here and is bounded by its own
 * permissions, which GitHub enforces call by call. A warning, never a failed boot: both are
 * the person's call about their own token.
 */
export function warnAboutUserScopes(
  user: { login: string; scopes: string[] | null },
  log: { warn(event: string, fields?: Record<string, unknown>): void },
): void {
  const missing = missingUserScopes(user.scopes);
  if (missing.length > 0) {
    log.warn("github_user.missing_scopes", {
      login: user.login,
      missing,
      fix: "grant the token these scopes (for gh: gh auth refresh -s repo)",
    });
  }
  if (holdsWorkflowScope(user.scopes)) {
    log.warn("github_user.workflow_scope", {
      login: user.login,
      note: "this token holds the `workflow` scope: agents could add or change workflow files, " +
        "which GitHub runs with the repo's secrets once pushed",
      fix: "use a token without it — a `gh auth login` using SSH, or a fine-grained token " +
        "without the Workflows permission",
    });
  }
}

/** What `readGithubSettings` makes of the environment; null is no GitHub at all. */
export type GithubSettings =
  | {
    mode: "app";
    appId: string;
    privateKeyPem: string;
    privateKeySource: string;
    /** The OAuth client pair people sign in through; null where none is configured. */
    oauth: { clientId: string; clientSecret: string } | null;
  }
  | {
    mode: "user";
    token: { kind: "static"; token: string } | { kind: "command"; command: string };
  }
  | null;

/**
 * Says once, at boot, what the GitHub App is missing against the README's tables: a required
 * event or permission as a warning, an optional one and any extra event as info. A missing
 * subscription is otherwise silent — the code path is right and nothing ever arrives.
 */
async function reportAppSubscriptions(app: GithubAppApi, log: Logger): Promise<void> {
  try {
    const reports = subscriptionReports(await app.describeSubscriptions());
    for (const { scope, gaps, extraEvents } of reports) {
      const required = gaps.filter((g) => g.required).map(describeGap);
      const optional = gaps.filter((g) => !g.required).map(describeGap);
      if (required.length > 0) {
        log.warn("github_app.missing", {
          scope,
          missing: required,
          fix: scope === "app"
            ? "tick these in the App's Permissions & events (packages/forge/README.md)"
            : "the App has them; this account has not accepted them yet",
        });
      }
      if (optional.length > 0) {
        log.info("github_app.missing_optional", { scope, missing: optional });
      }
      if (extraEvents.length > 0) {
        log.info("github_app.extra_events", {
          scope,
          events: extraEvents,
          note: "consumed unparsed; they only add mailroom rows",
        });
      }
    }
    if (reports.length === 0) log.info("github_app.subscriptions_ok");
  } catch (err) {
    log.warn("github_app.subscriptions_unread", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * What a host that mounts the forge in its own process decides for it, rather than leaving it to
 * the environment: the single-process deployment mints the shared tokens itself, knows its own
 * control plane's address, and already owns the database the mailroom's table lives in. Anything
 * left out is read from the environment exactly as the standalone service reads it.
 */
export interface ForgeStartOptions {
  port?: number;
  orchestratorUrl?: string;
  forgeToken?: string;
  toolsGatewayToken?: string;
  dataDir?: string;
  /** The mailroom's tables on a connection the HOST owns — never closed here. */
  webhooksDb?: WebhooksDbHandle;
  /** The allowed root for `local` repos. Absent: RYPH_LOCAL_REPO_ROOT. Null: off, whatever the
   * environment says. */
  localRoot?: string | null;
  /**
   * The Radicle bridge — its address and the bearer it takes — when the host runs one itself
   * (the binary, in user mode) and minted that bearer, and how it acts. Absent:
   * RYPH_RADICLE_URL, RYPH_RADICLE_TOKEN and RYPH_RADICLE_MODE. Null: no Radicle, whatever the
   * environment says.
   */
  radicle?: { url: string; token: string; mode: RadicleBridgeMode } | null;
  /**
   * How the forge listens, when the host mounting it decides that. The single-process host binds
   * it where it binds its control plane (loopback, the run address it detects, and RYPH_BIND), since a run dials the
   * git gateway from the same networks. Absent: every interface on `port`, which is right for
   * the standalone service, alone in its container behind the deployment's own network policy.
   */
  serve?: (handler: ServeHandler) => Promise<HttpServer>;
  /**
   * The names the forge answers to, as a wrapper that refuses any other Host (the host's
   * DNS-rebinding guard). Applied to every request but a webhook delivery (`isHookDelivery`).
   * Absent: no check.
   */
  guard?: (handler: ServeHandler) => ServeHandler;
}

/**
 * Whether a request is a delivery to the mailroom's ingestion door (`POST /v1/hooks/:id`). Those
 * are exempt from the Host check: GitHub and friends deliver through tunnels and proxies under
 * names that are nothing else here, each delivery is verified by its own signature or secret
 * header, and no browser credential rides on it — a rebinding page gains nothing by reaching it.
 */
export function isHookDelivery(req: Request): boolean {
  return req.method === "POST" && new URL(req.url).pathname.startsWith("/v1/hooks/");
}

/** `handler` behind `guard`, except for webhook deliveries; `handler` itself with no guard. */
export function guardExceptDeliveries(
  handler: ServeHandler,
  guard: ForgeStartOptions["guard"],
): ServeHandler {
  if (guard === undefined) return handler;
  const guarded = guard(handler);
  return (req, info) => isHookDelivery(req) ? handler(req, info) : guarded(req, info);
}

/** A forge that is serving, and what the owner of the process needs to shut it down. */
export interface RunningForge {
  server: HttpServer;
  /** Fails readiness, so a balancer stops routing here before the listener closes. */
  beginDrain: () => void;
  /** Stops the mailroom tick and releases what this forge opened itself. */
  close: () => Promise<void>;
  /** Whether door ⑤ is lit: a forge to act through, and a token to be reached with. */
  tools: boolean;
  /** The providers this forge acts on — "github", "radicle", "local" — for a status line. */
  forges: string[];
  /** How it acts on GitHub — as an App, or as `@login` — and null where it does not at all. */
  github: GithubMode | null;
  /** How it acts on GitLab — as a bot or one person, `@login` at which instance — and null where
   * it does not at all. */
  gitlab: GitlabMode | null;
  dataDir: string;
}

export async function main(): Promise<void> {
  refusePublicDevSecrets("forge");
  setupLoggerFromEnv();
  const forge = await startForge();
  // Git transfers are the long in-flight work here — a large clone through the gateway can run
  // for a while — so the deadline matters, and cutting one is a clone the runner retries.
  installDrain({
    servers: [forge.server],
    beginDrain: forge.beginDrain,
    preStopMs: msEnv("RYPH_PRE_STOP_MS", 0),
    deadlineMs: msEnv("RYPH_DRAIN_DEADLINE_MS", 25_000),
    log: new Logger("forge"),
    close: forge.close,
  });
}

/** Wires every door and starts listening. The caller owns the drain. */
export async function startForge(opts: ForgeStartOptions = {}): Promise<RunningForge> {
  const port = opts.port ?? intEnv("RYPH_FORGE_PORT", 7412);
  const log = new Logger("forge");
  const diag = loggerDiagnostics("forge");

  // Resolving per-run credentials means calling the orchestrator, authenticated by this service's
  // own token. Both are required: without them no key can be resolved, and without keys no run is served.
  // The one token guards both legs of the forge↔orchestrator link: forge presents it outbound (key
  // resolution here), and verifies it inbound on door ③'s service surface — same secret, both directions.
  const orchestratorUrl = opts.orchestratorUrl ?? env("RYPH_ORCHESTRATOR_URL") ??
    fail("RYPH_ORCHESTRATOR_URL is required — run credentials are resolved there");
  const forgeToken = opts.forgeToken ?? env("RYPH_FORGE_TOKEN") ??
    fail("RYPH_FORGE_TOKEN is required — the service credential for key resolution");

  // The deployment-wide fallback fetch token is gone: every repo is a connected one, fetched with
  // the credential its own provider mints. Refused rather than ignored, so a deployment still
  // configured for it learns why.
  if (env("RYPH_FORGE_UPSTREAM_TOKEN") || env("RYPH_FORGE_UPSTREAM_ORIGIN")) {
    fail(
      "RYPH_FORGE_UPSTREAM_TOKEN / RYPH_FORGE_UPSTREAM_ORIGIN are no longer supported: every " +
        "repo is a connected one, fetched with its provider's own credential. Unset them.",
    );
  }

  const { dataDir, cacheDir, patchesDir, stagingDir } = forgeDataRoot(
    opts.dataDir ?? env("RYPH_FORGE_DATA"),
  );
  // Staging is scratch space for requests being processed; nothing in it needs to outlive a
  // restart. Wipe it on boot — anything still there is debris from a request that crashed.
  await rm(stagingDir, { recursive: true }).catch(() => {});
  for (const dir of [cacheDir, patchesDir, stagingDir]) {
    await mkdir(dir, { recursive: true });
  }

  // The one bare clone per connected repo, shared by the clone door and the submit path: the
  // transport seeds a delivery's base objects from it rather than re-fetching them.
  const repoCache = localFsRepoCache({ root: cacheDir, diag });

  // Door ③'s backing: GitHub, as an App or as one person (`readGithubSettings`). Neither set:
  // door ③ stays dark for GitHub and doors ① and ② serve as normal.
  let github: GithubSettings;
  try {
    github = await readGithubSettings(env);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  let githubApp: GithubAppForge | null = null;
  let githubUser: GithubUserForge | null = null;
  if (github?.mode === "app") {
    try {
      githubApp = await githubForgeApi({
        appId: github.appId,
        privateKeyPem: github.privateKeyPem,
        oauth: github.oauth,
        apiBase: env("RYPH_GITHUB_API"),
        oauthBase: env("RYPH_GITHUB_OAUTH"),
        diag,
      });
    } catch (err) {
      // Construction only parses the key, so a throw here is always the key. Leaks that internal
      // fact, but fine for boot-time fail-fast: worst case is one confusing startup message.
      fail(`${github.privateKeySource}: ${err instanceof Error ? err.message : err}`);
    }
  } else if (github?.mode === "user") {
    // USER MODE: the forge acts as the person whose token this is, on every repo they reach.
    // The token is read now — the command run, `GET /user` asked — so a bad one fails the boot
    // (`ryph up`) instead of the first run. Neither error names the token.
    try {
      const token: UserTokenSource = github.token.kind === "static"
        ? staticUserToken(github.token.token)
        : commandUserToken({ command: github.token.command, diag });
      githubUser = await githubForgeApi({
        mode: "user",
        token,
        apiBase: env("RYPH_GITHUB_API"),
        oauthBase: env("RYPH_GITHUB_OAUTH"),
        diag,
      });
    } catch (err) {
      fail(`GitHub user mode: ${err instanceof Error ? err.message : err}`);
    }
    warnAboutUserScopes(githubUser, log);
  }
  const githubForge: GithubAppForge | GithubUserForge | null = githubApp ?? githubUser;

  // GitLab, read and checked like GitHub's (`readGitlabSettings`): ONE instance, as a bot user
  // or as one person. The adapter reads at boot what it acts as — the instance's version, the
  // token's scopes, its own account — so a bad token or an old instance fails the boot (`ryph
  // up`) instead of the first run. Unset: no GitLab, and a connected repo naming it gets the
  // registry's terminal refusal.
  let gitlab: GitlabSettings;
  try {
    gitlab = readGitlabSettings(env);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  // Said before GitLab is dialed: a webhook secret with nowhere to queue deliveries is a door
  // that refuses every one, and a hook GitLab auto-disables after enough of them.
  if (gitlab?.webhookSecret && opts.webhooksDb === undefined && !env("RYPH_FORGE_DB")) {
    fail(
      "RYPH_GITLAB_WEBHOOK_SECRET is set but RYPH_FORGE_DB is not — webhook ingestion needs " +
        "its database",
    );
  }
  let gitlabWiring: GitlabWiring | null = null;
  if (gitlab !== null) {
    try {
      gitlabWiring = await wireGitlab(gitlab, {
        cache: repoCache,
        diag,
        sink: httpEventSink({ orchestratorUrl, forgeToken, diag }),
        gate: httpGitlabHookGate({ orchestratorUrl, forgeToken, diag }),
      });
    } catch (err) {
      fail(
        `GitLab (${gitlab.mode} mode at ${gitlab.url}): ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }
  const gitlabForge: GitlabForge | null = gitlabWiring?.forge ?? null;

  // DOOR ⑤ — the agents' tool surface: issues, comments, labels and review remarks, as
  // whatever identity the repo's own forge gives us (a GitHub App installation, the
  // deployment's Radicle key), under the grant the orchestrator resolves each calling run to.
  // It needs a forge — any forge — and the check is below, once the registries exist.
  // Reached only through the
  // mcp-gateway, which presents RYPH_FORGE_GATEWAY_TOKEN — its own credential, never the forge
  // token, so the gateway's trust domain does not reach the service surface. Unset: dark.
  const toolsGatewayToken = opts.toolsGatewayToken ?? env("RYPH_FORGE_GATEWAY_TOKEN");
  // THE SECOND FORGE — Radicle, through the bridge that runs beside our node
  // (@ryph/radicle). Optional in every sense: no RYPH_RADICLE_URL, no provider, and a
  // connected repo naming `radicle` gets the registry's terminal refusal rather than a crash.
  //
  // There is no App and no tenant here. Every write is signed by the deployment's own Radicle
  // key, which lives in the bridge's pod and nowhere else; what this process holds is the one
  // bearer that reaches it. Both or neither: a URL with no token is a service that 401s on
  // every call, which is worse than being off.
  // A host that runs the bridge hands its address and bearer over directly: the bearer is
  // minted per boot and never sits in the environment, where a child process would inherit it.
  const radicleUrl = opts.radicle === undefined ? env("RYPH_RADICLE_URL") : opts.radicle?.url;
  const radicleToken = opts.radicle === undefined ? env("RYPH_RADICLE_TOKEN") : opts.radicle?.token;
  // The bridge's own setting, restated here: a bridge in user mode signs as one person, which
  // the control plane must know before it lets anyone connect a repository through it.
  const radicleModeRaw = opts.radicle === undefined
    ? env("RYPH_RADICLE_MODE") ?? "deployment"
    : opts.radicle?.mode ?? "deployment";
  if (radicleModeRaw !== "deployment" && radicleModeRaw !== "user") {
    fail(`RYPH_RADICLE_MODE must be "deployment" or "user", got ${JSON.stringify(radicleModeRaw)}`);
  }
  const radicleMode: RadicleBridgeMode = radicleModeRaw;
  if (radicleUrl && !radicleToken) {
    fail("RYPH_RADICLE_URL is set but RYPH_RADICLE_TOKEN is not — the bridge would refuse us");
  }
  if (radicleUrl && !URL.canParse(radicleUrl)) {
    fail(`RYPH_RADICLE_URL must be an absolute URL, got ${JSON.stringify(radicleUrl)}`);
  }
  let radicle: (ForgeApi & RadicleBridgeApi) | null = null;
  if (radicleUrl && radicleToken) {
    radicle = radicleForgeApi({
      baseUrl: radicleUrl,
      token: radicleToken,
      // The same template the bridge renders its own URLs from, and optional for the same
      // reason: a private Radicle network has no explorer, and then a thread's address is its
      // id. Unset, this side answers "" rather than inventing a link.
      explorerUrl: env("RYPH_RADICLE_EXPLORER_URL") ?? null,
      mode: radicleMode,
      diag,
    });
    // Said at boot rather than discovered at the first connect: a bridge acting as one person
    // behind a forge not told so refuses every seed (see the bridge's BRIDGE_MODE_HEADER).
    const configured = radicleMode;
    void radicle.identity().then((self) => {
      if (self.mode !== configured) {
        log.warn(
          `the Radicle bridge runs in ${self.mode} mode but this forge was told ${configured} — ` +
            `set RYPH_RADICLE_MODE=${self.mode} here` +
            (self.mode === "user"
              ? "; until then the bridge refuses every connect"
              : "; until then connecting is held to repos:manage-all for nothing"),
        );
      }
    }).catch(() => {});
  }

  // THE THIRD PROVIDER — `local`: git repositories on this machine's own disk, fetched from and
  // delivered into by path. Off unless a root is named, because the root is the whole boundary
  // between "repositories this deployment may read and write" and the rest of the disk
  // (core/local_repo.ts). The single binary passes it (defaulting to the home directory); a
  // networked forge has no business reading its own pod's disk and leaves it unset.
  const localRootSetting = opts.localRoot === undefined
    ? env("RYPH_LOCAL_REPO_ROOT") ?? null
    : opts.localRoot;
  let localRoot: string | null = null;
  // `off` (any case) is no root, said out loud — the spelling the binary's host takes too, so one
  // config file means the same thing to a forge in the binary and to one standing alone.
  const localRootOff = localRootSetting?.trim().toLowerCase() === "off";
  if (localRootSetting !== null && !localRootOff) {
    if (!localRootSetting.startsWith("/")) {
      fail(
        `RYPH_LOCAL_REPO_ROOT must be an absolute path, got ${JSON.stringify(localRootSetting)}`,
      );
    }
    const real = await realpath(localRootSetting).catch(() =>
      fail(`RYPH_LOCAL_REPO_ROOT (${localRootSetting}) does not exist`)
    );
    if (real === "/") {
      fail(
        "RYPH_LOCAL_REPO_ROOT is / — that would let ryph read and write every repository " +
          "on the disk; name the directory your repositories live under",
      );
    }
    if (!(await stat(real)).isDirectory()) {
      fail(`RYPH_LOCAL_REPO_ROOT (${localRootSetting}) is not a directory`);
    }
    // Kept as given, not as resolved: every check resolves it again, so a root that is itself
    // a symlink follows wherever it points then — and says so in the words the operator used.
    localRoot = localRootSetting;
  }

  // THE PROVIDER REGISTRIES. One entry per forge this deployment can act on, and the connected
  // repo names which — a repo naming one that is not wired gets a terminal refusal rather than
  // a crash (see `providerRegistry`). Neither is required: a deployment may run one, the other,
  // or both, and the doors that need none of them serve as normal.
  const forges: ForgeRegistry = providerRegistry<ForgeApi>(
    {
      github: githubForge,
      gitlab: gitlabForge,
      radicle,
      local: localRoot === null ? null : localForgeApi({ root: localRoot, diag }),
    },
    "forge API",
  );
  const transports: ChangeTransportRegistry = providerRegistry<ChangeTransport>(
    {
      github: githubForge === null ? undefined : githubChangeTransport({
        api: githubForge,
        cache: repoCache,
        diag,
      }),
      gitlab: gitlabWiring?.transport,
      radicle: radicleUrl && radicleToken
        ? radicleChangeTransport({
          baseUrl: radicleUrl,
          token: radicleToken,
          cache: repoCache,
          diag,
        })
        : undefined,
      local: localRoot === null
        ? undefined
        : localChangeTransport({ root: localRoot, cache: repoCache, diag }),
    },
    "change transport",
  );

  // Only a token the environment set is a misconfiguration: a host that mounts this forge mints
  // one whatever is wired, and reads `tools` back to learn whether it means anything.
  // The tool surface acts on threads, and `local` has none: a forge whose only provider is the
  // local disk has no tools to serve, and must not tell its host it does.
  const toolForges = forges.providers().filter((p) => p !== "local");
  if (env("RYPH_FORGE_GATEWAY_TOKEN") && toolForges.length === 0) {
    fail(
      "RYPH_FORGE_GATEWAY_TOKEN is set but no forge is configured — the tool surface acts " +
        "through a forge adapter (a GitHub App, a GitHub token, a GitLab token, or " +
        "RYPH_RADICLE_URL)",
    );
  }
  // A run's images, looked up where they live: every body the forge writes for an agent — its
  // own tool calls, and what the orchestrator sends on for a run — may show them.
  const images = httpRunImages({ orchestratorUrl, forgeToken, diag });
  const tools = toolForges.length > 0 && toolsGatewayToken
    ? {
      service: makeToolService({
        grants: httpToolGrants({ orchestratorUrl, forgeToken, diag }),
        images,
        forges,
        diag,
        now: () => new Date(),
      }),
      gatewayToken: toolsGatewayToken,
    }
    : null;

  // WHERE THE PATCHES LIVE, which is the one setting that decides whether this service can have
  // more than one replica.
  //
  // Local disk is the default and stays it: for the single-process deployment "durable" and "on
  // this machine" are the same thing, and asking someone running a binary on a laptop to stand up
  // object storage first would be absurd. But patches/ is the forge's real output, and on a
  // volume attached to one container it pins this service at one replica — scale it and a patch
  // submitted through replica A simply 404s when replica B is asked to deliver it, per patch,
  // silently. So a networked deployment sets RYPH_PATCH_STORE=s3.
  //
  // Only the store moves. cache/ is disposable (a miss re-fetches) and staging/ is per-request
  // scratch wiped on boot, so both stay local in either mode — they are not state, they are a
  // working set.
  const patchStoreKind = env("RYPH_PATCH_STORE") ?? "local";
  let patches: PatchStore;
  if (patchStoreKind === "local") {
    patches = localFsPatchStore(patchesDir, diag);
  } else if (patchStoreKind === "s3") {
    // All of them or none: a half-configured object store that silently fell back to local disk
    // would look like it worked until the second replica went in.
    const endpoint = env("RYPH_S3_ENDPOINT") ??
      fail("RYPH_PATCH_STORE=s3 needs RYPH_S3_ENDPOINT");
    const bucket = env("RYPH_S3_BUCKET") ?? fail("RYPH_PATCH_STORE=s3 needs RYPH_S3_BUCKET");
    const accessKeyId = env("RYPH_S3_ACCESS_KEY_ID") ??
      fail("RYPH_PATCH_STORE=s3 needs RYPH_S3_ACCESS_KEY_ID");
    const secretAccessKey = env("RYPH_S3_SECRET_ACCESS_KEY") ??
      fail("RYPH_PATCH_STORE=s3 needs RYPH_S3_SECRET_ACCESS_KEY");
    if (!URL.canParse(endpoint)) {
      fail(`RYPH_S3_ENDPOINT must be an absolute URL, got ${JSON.stringify(endpoint)}`);
    }
    patches = s3PatchStore({
      config: {
        endpoint,
        region: env("RYPH_S3_REGION") ?? "us-east-1",
        bucket,
        prefix: env("RYPH_S3_PREFIX"),
        accessKeyId,
        secretAccessKey,
        sessionToken: env("RYPH_S3_SESSION_TOKEN"),
        // Path style by default: it is what MinIO and most self-hosted stores want, and AWS
        // accepts it too. Virtual-hosted is the opt-in.
        forcePathStyle: env("RYPH_S3_FORCE_PATH_STYLE") !== "false",
      },
      diag,
    });
  } else {
    fail(`unknown RYPH_PATCH_STORE ${JSON.stringify(patchStoreKind)} — use "local" or "s3"`);
  }

  // Readiness is "the working set is still writable" — an unmounted or full volume is this
  // service's version of a database outage. Still staging/ and not the patch store, even on s3:
  // every request needs somewhere local to stream into, and probing the object store would make a
  // blip there take this replica out of rotation for clone traffic that does not touch it.
  // Deliberately NOT a reachability check on the orchestrator either: a control-plane blip must
  // route traffic away from the control plane, not from the forge that is fine.
  const health = makeHealth({ ready: () => stat(stagingDir), log: diag });

  // THE WEBHOOK MAILROOM (@ryph/webhooks), mounted into this process because its first
  // tenant is door ④ and the GitHub webhook secret must not leave the forge's trust domain.
  // The module only ingests, verifies and queues; registrations (which mailboxes exist, and
  // what consumes them) arrive with door ④. RYPH_FORGE_DB unset → the whole thing is
  // dark: no routes, no database, no tick.
  //
  // Its own database on purpose — the forge otherwise has none, and these rows (hostile
  // internet input, full bodies) do not belong beside anyone else's tables.
  let webhooks: WebhooksSetup | null = null;
  let webhooksDb: WebhooksDbHandle | null = null;
  let webhookSweepLock: Awaited<ReturnType<WebhooksDbHandle["lockSession"]>> | null = null;
  // Rebound once the sweep tick exists below; ingestion may fire it from the first request.
  let kickWebhookSweep: () => void = () => {};
  const webhooksDbUrl = env("RYPH_FORGE_DB");
  if (opts.webhooksDb !== undefined || webhooksDbUrl) {
    webhooksDb = opts.webhooksDb ?? await makeWebhooksDb(webhooksDbUrl!);
    const hookStore = drizzleHookStore(webhooksDb.db);
    // Probe the schema before the first hostile request does — an unprovisioned database must
    // surface as this clear error, not as a driver stack under live traffic.
    try {
      await hookStore.getHeadHook("boot-probe");
    } catch (err) {
      // The missing schema is the likely cause, never the only one — unreachable host, wrong
      // credentials and a closed port all land here too, and each needs a different fix.
      fail(
        `database ${JSON.stringify(webhooksDb.description)} did not answer: ${err}\n` +
          "  if the schema is missing, run `bun run --filter '@ryph/webhooks' db:push` " +
          "(or the compose migrate-webhooks job) first",
      );
    }
    // ONE replica delivers: the one holding the drain lock, which it keeps from scan to scan
    // (`leader`) and loses only with its database session. Every replica ingests; only the leader
    // scans and drains, so whatever a consumer holds per process — GitLab's budget of API calls
    // (`hookBudget`) above all — is the deployment's, however many replicas serve. A replica that
    // loses the lock starts no delivery on an answer older than LEADER_FRESH_MS (250 ms);
    // deliveries it has in flight finish, so for that moment two processes' reservations overlap,
    // at most MAX_CONCURRENT_DRAINS per mailbox each. The session is a self-healing one, kept for
    // this key alone (`LockSessionOptions.selfHealing`): a connection that died answers "not held"
    // within its deadline and reconnects, ending the backend a partition left holding the lock,
    // so the lock passes on rather than wedging here.
    const lock = await webhooksDb.lockSession({ selfHealing: true });
    webhookSweepLock = lock;
    webhooks = setupWebhooks({
      store: hookStore,
      diag,
      now: () => new Date(),
      onIngested: () => kickWebhookSweep(),
      leader: async () =>
        await lock.held(LOCK_WEBHOOK_SWEEP) || await lock.tryLock(LOCK_WEBHOOK_SWEEP),
    });
  }

  // DOOR ④ — inbound GitHub webhooks. Rents the "github" mailbox: GitHub signs each delivery
  // with the App's webhook secret, the mailroom verifies and queues it, and the consumer here
  // trims the payload to a ForgeEvent and forwards it to the orchestrator, which makes every
  // decision (dedupe, command parsing, authorization). This process never acts on a webhook.
  //
  // Lights only with the full set — the App (door ③), the webhook secret, and the mailroom's
  // database — because a webhook that cannot be verified, or an event the orchestrator cannot
  // act back on (reactions and comments ride door ③), is not half a feature but a trap.
  const webhookSecret = env("RYPH_GITHUB_WEBHOOK_SECRET");
  if (webhookSecret) {
    if (webhooks === null) {
      fail(
        "RYPH_GITHUB_WEBHOOK_SECRET is set but RYPH_FORGE_DB is not — " +
          "webhook ingestion needs its database",
      );
    }
    if (githubApp === null) {
      fail(
        "RYPH_GITHUB_WEBHOOK_SECRET is set but the GitHub App is not configured — " +
          "inbound triggers need door ③ (RYPH_GITHUB_APP_ID and friends) to act back",
      );
    }
    webhooks.register({
      id: "github",
      verification: {
        kind: "hmac-sha256",
        header: "x-hub-signature-256",
        prefix: "sha256=",
        secret: webhookSecret,
      },
      consumer: githubWebhookConsumer({
        sink: httpEventSink({ orchestratorUrl, forgeToken, diag }),
        diag,
        appId: github?.mode === "app" ? github.appId : null,
      }),
    });
  }

  // DOOR ④, the GitLab half (`wireGitlab`): lit in bot mode with RYPH_GITLAB_WEBHOOK_SECRET,
  // whose database was checked before GitLab was dialed. User mode has no webhooks: the control
  // plane polls merges instead, as for GitHub user mode.
  if (gitlabWiring?.mailbox) webhooks!.register(gitlabWiring.mailbox);

  // DOOR ④, the Radicle half. Radicle has no webhooks: the bridge holds a subscription on its
  // node's control socket, reconciles against storage for what the socket dropped, and POSTs
  // each minted event here. So this mailbox's sender is OURS, one hop away, and what it
  // presents is the same shared bearer the forge presents to it — a secret header rather than
  // a signature, because there is no second secret to sign with and the network policy, not
  // the payload, is the boundary.
  //
  // Lights with the bridge and the mailroom's database. Without the database the bridge's
  // POSTs would be refused and every comment lost, so a URL with no queue is a trap, not half
  // a feature.
  if (radicle !== null && radicleToken) {
    if (webhooks === null) {
      fail(
        "RYPH_RADICLE_URL is set but RYPH_FORGE_DB is not — the bridge's events need the " +
          "mailroom's database",
      );
    }
    webhooks.register({
      id: "radicle",
      verification: {
        kind: "secret-header",
        header: "authorization",
        secret: `Bearer ${radicleToken}`,
      },
      consumer: radicleEventConsumer({
        sink: httpEventSink({ orchestratorUrl, forgeToken, diag }),
        diag,
      }),
    });
  }

  const handler = makeHandler({
    keys: httpKeyStore({ orchestratorUrl, forgeToken, diag }),
    cache: repoCache,
    patches,
    diag,
    forges,
    transports,
    githubApp,
    githubUser,
    radicle,
    gitlab: gitlabForge,
    localRoot,
    serviceToken: forgeToken,
    images,
    tools,
    config: {
      maxUploadPackBytes: intEnv("RYPH_FORGE_MAX_UPLOAD_PACK_BYTES", 10 * 1024 * 1024),
      maxBundleBytes: intEnv("RYPH_FORGE_MAX_BUNDLE_BYTES", 100 * 1024 * 1024),
      stagingDir,
    },
  }, [
    // Ahead of the health routes: a mailroom whose ticks keep wedging past abandoning them fails
    // liveness, so the pod is restarted rather than left accepting hooks it will never deliver
    // (`livenessRoutes`). A database outage never does: every tick ends at its deadlines, and git
    // traffic, which needs no database, stays up through it.
    ...(webhooks === null ? [] : livenessRoutes(webhooks, diag)),
    ...health.routes,
    ...(webhooks?.routes ?? []),
  ]);

  // The mailroom's tick: a scan every couple of seconds, which hands each mailbox's due queues to
  // its drain — each mailbox drains on its own, so a GitLab that hangs never holds a GitHub push
  // or a Radicle event. The tick never waits on a delivery, and never runs twice at once
  // (`coalescingTick`); only the leader's scans (`leader` above) find anything. A hook ingested
  // while its mailbox drains joins that drain directly; one ingested into an idle mailbox kicks
  // the tick (`kickWebhookSweep`), so it is delivered in milliseconds instead of a tick later. The
  // timer is left to catch what no arrival announces here: a retry clock running out, a lease a
  // dead deliverer left, and a hook another replica ingested.
  let webhookSweepTimer: ReturnType<typeof setInterval> | null = null;
  if (webhooks !== null) {
    const tick = webhooks.tick;
    const runSweep = coalescingTick(
      tick,
      (err) => diag.warn("webhooks.sweep_tick_failed", { err: String(err) }),
    );
    kickWebhookSweep = runSweep;
    webhookSweepTimer = setInterval(runSweep, intEnv("RYPH_WEBHOOKS_SWEEP_INTERVAL_MS", 2_000));
    runSweep(); // whatever survived the last shutdown drains now, not a tick from now
  }

  const served = guardExceptDeliveries(handler, opts.guard);
  const server = opts.serve
    ? await opts.serve(served)
    : await serve({ port, onListen: () => {} }, served);
  log.info(`listening on ${opts.serve ? `${server.addr.hostname}:` : ":"}${server.addr.port}`, {
    data: dataDir,
    patches: patchStoreKind,
    orchestrator: orchestratorUrl,
    // What a private GitHub base repo gets cloned with.
    upstreamAuth: githubForge !== null ? `github ${githubApp ? "app" : "user token"}` : "none",
    forges: forges.providers().join(", ") || "none",
    githubApp: github?.mode === "app" ? github.appId : "none",
    githubUser: githubUser === null ? "none" : `@${githubUser.login}`,
    gitlab: gitlabForge === null
      ? "off"
      : `${gitlabForge.mode.mode} @${gitlabForge.mode.login} at ${gitlabForge.mode.url}` +
        (gitlabWiring?.mailbox ? " (webhooks on)" : ""),
    radicle: radicleUrl ?? "off",
    local: localRoot ?? "off",
    tools: tools === null ? "off" : "on",
    webhooks: webhooksDb === null ? "none" : webhooksDb.description,
  });

  // Off the boot path: a GitHub that is slow to answer never holds up serving.
  if (githubApp !== null) void reportAppSubscriptions(githubApp, log);

  return {
    server,
    beginDrain: health.beginDrain,
    close: async () => {
      // A sweep cut mid-delivery is fine: the lease expires and the next boot reclaims it.
      if (webhookSweepTimer !== null) clearInterval(webhookSweepTimer);
      await webhookSweepLock?.close();
      // A borrowed handle's close is the host's no-op; an opened one is ours to close.
      await webhooksDb?.close();
    },
    tools: tools !== null,
    forges: forges.providers(),
    github: githubUser !== null
      ? { mode: "user", login: githubUser.login }
      : githubApp !== null
      ? { mode: "app", signIn: githubApp.signIn }
      : null,
    gitlab: gitlabForge?.mode ?? null,
    dataDir,
  };
}

if (import.meta.main) {
  await main();
}

// The host composition root — the single-process local deployment: one `bun run up`
// serves the control plane (user + runner surfaces with auth, key CRUD and MCP server CRUD
// mounted) on one port, the model-proxy data plane on a second, and the mcp-gateway data plane
// on a third. This file reads the environment once, builds the whole app, owns every socket,
// and runs the reaper on its interval.
// Each service package keeps its own main.ts as the standalone composition root — the
// networked deployment is a wiring change here, not a refactor there.

import { existsSync, realpathSync, statSync } from "node:fs";
import { multiUserFromEnv, setupTokenNotice } from "@ryph/auth";
import { type DbCluster, describeDbTarget, openDbCluster, parseDbUrl } from "@ryph/db";
import { Logger, setupLoggerFromEnv } from "@ryph/logger";
import { isLoopbackHost } from "@ryph/shared/net";
import {
  type HttpServer,
  installDrain,
  listenNode,
  quietDrainErrors,
  serve,
  trackStreams,
} from "@ryph/service";
import { command } from "@ryph/process";
import { isAbsolute, resolve } from "@std/path";
import { z } from "@zod/zod";
import { isHookDelivery, type RunningForge, startForge } from "@ryph/forge";
import { type RunningRadicle, scopeRadicleDb, startRadicle } from "@ryph/radicle";
import { coalescingTick, scopeWebhooksDb } from "@ryph/webhooks";
import { type PlatformApiUrls, platformApiUrlsFromEnv } from "@ryph/chat";
import { degradingEmbedder, workerEmbedder } from "@ryph/memory";
import { importMasterKey, type MasterKey, mintToken } from "@ryph/sealed";
import { privateModelEndpointsAllowed, type SpendLimits } from "@ryph/model-proxy";
import {
  attachmentStoreFromEnv,
  awaitLauncherToken,
  browserConfigFromEnv,
  buildLogStoreFromEnv,
  checkCapsFromEnv,
  checkPolicyFromEnv,
  DEFAULT_MERGE_POLL_CONFIG,
  DEFAULT_PATCH_SUBMIT_CONFIG,
  deploymentLimitsFromEnv,
  type DockerEngine,
  type DockerOptions,
  egressKeyFromEnv,
  egressPolicyFromEnv,
  engineAbsentWarning,
  environmentsConfigFromEnv,
  GATE_TARGET,
  gateCoverage,
  gateName,
  gateRoutesFor,
  type GithubMode,
  type GitlabMode,
  harnessKindsFromEnv,
  kubernetesOptionsFromEnv,
  launcherCallerRefusal,
  localBridgeGateway,
  loggerDiagnostics,
  remoteChecksConfigFromEnv,
  type Run,
  runSizesFromEnv,
  servicePolicyFromEnv,
  sweep,
  sweepPatches,
  sweepProgressComments,
  TERMINAL_STATES,
  unwiredEgressWarning,
} from "@ryph/orchestrator";
import { buildApp, type HostApp, type HostConfig } from "./app.ts";
import { gateOwner } from "./gate_owner.ts";
import { localArtifactThumbnail } from "./artifact_thumbnail.ts";
import {
  connectLauncher,
  EMBEDDED_LAUNCHER,
  embeddedHostingRefusal,
  type HostLauncher,
} from "./launcher.ts";
import {
  mintToolEgressKey,
  toolEgressKeyFromEnv,
  TOOLS_NETWORK,
} from "@ryph/mcp-gateway/tool-host";
import { prefetchImages, prefetchOn } from "@ryph/launcher";
import { defaultImage, environmentImage } from "./images.ts";
import { acceptingUpgrades, type PreviewListener } from "./previews.ts";
import { bindFailure, lateRunAddress, serveOn } from "./listen.ts";
import {
  allowedHosts,
  bindAddresses,
  forgeAllowedHosts,
  guardHost,
  isWildcard,
  remoteRunReach,
  runAddress,
  urlHost,
  wildcardBindNotice,
} from "./local_surface.ts";
export {
  allowedHosts,
  bindAddresses,
  guardHost,
  hostAllowed,
  isIPv4,
  isWildcard,
  LOOPBACK,
  misdirected,
  remoteRunReach,
  runAddress,
  urlHost,
} from "./local_surface.ts";
export {
  bindErrorKind,
  bindFailure,
  bindOrder,
  classifyBind,
  coveredByWildcard,
} from "./listen.ts";
// The ryph binary's own node:http listeners bind through this too (its UI server).
export { listenNode } from "@ryph/service";
export type { PreviewListener } from "./previews.ts";
export {
  bakedImageTag,
  defaultImage,
  EDGE_TAG,
  environmentImage,
  IMAGE_REGISTRY,
  imageDefaultsNote,
  type LaunchedImage,
  publishedTag,
  ryphVersion,
  SEMVER,
} from "./images.ts";
// The egress proxy itself, served by this process rather than by a container beside it. It stays
// a standalone target with no workspace deps — the arrow points only this way,
// so images/egress-proxy/Dockerfile builds exactly what it always did.
import {
  makeProxy,
  makeRefusalReporter,
  parseDenyCidrs,
} from "../../../images/egress-proxy/main.ts";

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

/** Like `intEnv`, but zero is a meaningful answer — "no grace". */
const msEnv = (name: string, fallback: number): number => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    fail(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};

/** A positive decimal amount of money, or null when the variable is unset — no ceiling. */
const usdEnv = (name: string): number | null => {
  const raw = env(name);
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    fail(`${name} must be a positive amount in USD, got ${JSON.stringify(raw)}`);
  }
  return value;
};

/**
 * The address a container dials for a listener of THIS process on `targetPort`: the control
 * plane's container-view URL (RYPH_PUBLIC_URL, which `ryph setup` writes for the backend it
 * picked) with its port swapped. Unset, the same loopback guess the control plane makes.
 */
function containerViewOn(publicUrl: string | undefined, port: number, targetPort: number): string {
  const url = new URL(publicUrl ?? `http://127.0.0.1:${port}`);
  url.port = String(targetPort);
  return url.origin;
}

/** The RYPH_LOCAL_REPO_ROOT value that turns local repositories off outright. */
export const LOCAL_ROOT_OFF = "off";

/**
 * RYPH_LOCAL_REPO_ROOT as the forge should compare against it: absolute, symlinks resolved, and a
 * directory that exists. A relative root is refused rather than resolved, because it would draw
 * a different line around the disk for every directory the process is started from. Throws with
 * the message the boot fails on. `off` (any case) is no root at all, so nothing may be added from
 * this machine; it is how the binary, which otherwise defaults to home, is told not to.
 */
export function resolveLocalRoot(setting: string): string | null {
  if (setting.trim().toLowerCase() === LOCAL_ROOT_OFF) return null;
  if (!isAbsolute(setting)) {
    throw new Error(
      `RYPH_LOCAL_REPO_ROOT must be an absolute path, got ${JSON.stringify(setting)}`,
    );
  }
  let real: string;
  try {
    real = realpathSync(setting);
  } catch {
    throw new Error(`RYPH_LOCAL_REPO_ROOT ${setting} does not exist`);
  }
  if (!statSync(real).isDirectory()) {
    throw new Error(`RYPH_LOCAL_REPO_ROOT ${setting} is not a directory`);
  }
  return real;
}

/** `1`, `true`, `yes` (any case) switch a flag on; anything else, including unset, leaves it off. */
const flagEnv = (name: string): boolean => /^(1|true|yes)$/i.test(env(name) ?? "");

/**
 * A flag whose default is ON, which needs its own reader: `flagEnv` treats everything it does not
 * recognise as off, and doing that here would make `RYPH_WEB_TOOLS=false` read as ON — a
 * capability somebody thought they had removed, still on. So the words are spelled out both ways
 * and anything else is fatal, which is the only answer that cannot be misread.
 */
const boolEnv = (name: string, fallback: boolean): boolean => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  fail(`${name} must be on or off, got ${JSON.stringify(raw)}`);
};

/**
 * Hooks the shipped binary needs and the standalone process does not. Both go through this one
 * root rather than a second copy of the boot sequence, because the sequence has an order that
 * matters: the cluster is opened once (opening it twice diverges silently), the schema must be
 * present before any module reads it, and shutdown has to reach every listener.
 */
export interface HostMainOptions {
  /** Enable loopback previews in the localhost binary, never the hosted control plane. */
  localPreviews?: boolean;
  /** One port every preview shares, instead of a loopback listener each (a ryph in a container). */
  previewListener?: PreviewListener;
  /**
   * Called with the freshly opened cluster(s) BEFORE any module touches them. `ryph up`
   * applies its embedded migrations here — which is why it can provision its own database on
   * first launch without drizzle-kit, and without opening a second instance.
   */
  prepare?: (
    clusters: { cluster: DbCluster; historyCluster: DbCluster | null },
  ) => Promise<void>;
  /**
   * Starts extra listeners beside the control plane — the binary serves the embedded UI here.
   * Whatever is returned is shut down with everything else. `stop` is for a listener that fails
   * after this returns: it drains like a stop signal, without `beforeStop`'s asking, and exits
   * with `code` — the database closed and hosted containers stopped, as on any other stop.
   */
  serveExtra?: (
    ctx: { stop: (code: number) => void },
  ) => { describe: string; shutdown: () => Promise<void> } | null;
  /**
   * Called once everything is listening, with what this root resolved the environment to.
   * The binary renders it as a status block; nothing here re-reads the environment, which is
   * the point — two readers of RYPH_* is how a status display starts lying.
   */
  onReady?: (summary: HostSummary) => void;
  /**
   * Called on the first stop signal, before the drain begins and with every listener still
   * serving — a run cancelled here reports its end over the control plane. The binary asks here
   * whether to cancel the runs still going. Return `"keep-running"` to cancel the shutdown.
   * Without it, a stop drains at once and runs keep going, which is right wherever nobody is
   * there to ask (compose, a platform's SIGTERM).
   */
  beforeStop?: (ctx: StopContext) => Promise<void | "keep-running">;
  /**
   * What `ryph login` presents to the control plane for a fresh login link. The binary mints
   * one per launch and keeps it in a file only its user can read; without it there is no such
   * route, and a single-user instance is signed into by the link printed at boot.
   */
  localLoginSecret?: string;
  /**
   * The binary's own embeddings runtime (a file URL of the bundled module) and weights
   * directory. With them RYPH_MEMORY_EMBEDDINGS defaults to `local`, loaded from these on first
   * use; without them (a source run) it defaults to `off`.
   */
  embeddings?: { runtime: string; modelDir: string };
}

/** A run still going when a stop signal lands, as the exit prompt names it. */
export interface ActiveRun {
  id: string;
  title: string;
  agent: string;
  createdAt: string;
}

/** What is still running when this process is asked to stop, and what can be done about it. */
export interface StopContext {
  /** Undefined when the stop was asked for without a signal. */
  signal: NodeJS.Signals | undefined;
  /** Runs not yet terminal, oldest first. */
  runs: ActiveRun[];
  /** Hosted MCP servers whose containers the drain stops — always; see HostingService.shutdown. */
  hostedServers: string[];
  /** Silence past this marks a run lost: how long a run left behind survives this process. */
  heartbeatTimeoutMs: number;
  /**
   * Cancels every run in `runs` as the UI's Cancel does and waits for each to report its end,
   * calling `onProgress` with how many are left whenever that changes. Resolves with how many
   * were still going when it stopped — 0, unless `interrupted` aborted first.
   */
  cancelRuns(onProgress?: (left: number) => void): Promise<number>;
  /** Aborts on a second signal: stop asking, stop waiting. The drain goes ahead either way. */
  interrupted: AbortSignal;
}

/**
 * How long to stay up after the last cancelled run reports. A runner posts its result first and
 * flushes its last transcript batch on the way out, within a 3 s deadline of its own (the
 * runner's history emitter): leave sooner and the transcript loses its tail.
 */
const RUNNER_FLUSH_MS = 3_000;

/** Hosted containers are stopped in parallel, each a CLI call; past this, exit anyway. */
const HOSTING_SHUTDOWN_MS = 20_000;

const sleepUnless = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });

/**
 * The exit prompt's yes: each run cancelled as the UI does, then a wait for each to report. A
 * runner hears it on its cancel endpoint if it advertised one, and in the answer to its next
 * heartbeat either way (10 s apart); the reaper keeps ticking meanwhile, so a run that ignores
 * both is still escalated on schedule.
 */
async function cancelAndWait(
  app: HostApp,
  runs: Run[],
  interrupted: AbortSignal,
  onProgress: ((left: number) => void) | undefined,
  log: Logger,
): Promise<number> {
  for (const listed of runs) {
    try {
      await app.cancelRun((await app.store.getRun(listed.id)) ?? listed);
    } catch (err) {
      log.warn("stop.cancel_failed", { runId: listed.id, err: String(err) });
    }
  }
  const left = new Set(runs.map((r) => r.id));
  let reported = -1;
  for (;;) {
    for (const id of [...left]) {
      const run = await app.store.getRun(id);
      if (run === null || TERMINAL_STATES.has(run.state)) left.delete(id);
    }
    if (left.size !== reported) onProgress?.(reported = left.size);
    if (left.size === 0 || interrupted.aborted) break;
    await sleepUnless(500, interrupted);
  }
  if (left.size < runs.length) await sleepUnless(RUNNER_FLUSH_MS, interrupted);
  return left.size;
}

/** An in-process Radicle bridge, as the status block names it. */
export interface RadicleSummary {
  /** `did:key:…`, or null when `rad self` could not be read at boot. */
  did: string | null;
  alias: string | null;
  /** RAD_HOME — the person's own profile. */
  home: string;
  /** Whether their radicle-node answered at boot. */
  nodeRunning: boolean;
}

/** Every variable GitLab's configuration is read from, by the forge (packages/forge's
 * `readGitlabSettings`); named here only to warn when nothing in this process reads them. */
const GITLAB_SETTINGS = [
  "RYPH_GITLAB_URL",
  "RYPH_GITLAB_MODE",
  "RYPH_GITLAB_TOKEN",
  "RYPH_GITLAB_TOKEN_COMMAND",
  "RYPH_GITLAB_WEBHOOK_SECRET",
  "RYPH_GITLAB_CLIENT_ID",
  "RYPH_GITLAB_CLIENT_SECRET",
  "RYPH_GITLAB_GROUP",
] as const;

/**
 * The GitLab settings set here that nothing in this process reads, for the boot warning. An
 * in-process forge reads them all. In-process memory reads RYPH_GITLAB_URL as well (its
 * repo-file fetcher's instance), so beside it that one is read even with the forge elsewhere.
 * The binary's app reads RYPH_GITLAB_URL and RYPH_GITLAB_CLIENT_ID for its GitLab sign-in where
 * PUBLIC_GITLAB_* are unset (ryph's `appEnv`), so beside it those two are read too. Pure and
 * exported for the test.
 */
export function unreadGitlabSettings(
  env: (name: string) => string | undefined,
  here: { forgeEmbedded: boolean; memoryInProcess: boolean; appInProcess: boolean },
): string[] {
  if (here.forgeEmbedded) return [];
  return GITLAB_SETTINGS.filter((name) =>
    env(name) && !(here.memoryInProcess && name === "RYPH_GITLAB_URL") &&
    !(here.appInProcess && (name === "RYPH_GITLAB_URL" || name === "RYPH_GITLAB_CLIENT_ID"))
  );
}

/**
 * One provider as the boot summary names it. GitHub through one person's token says whose
 * (`github (as @ada)`); GitLab always says whose and where, since the instance is a setting
 * (`gitlab (as @ada at git.example.com)`, a path prefix kept). Everything else is its name.
 */
export function forgeLabel(
  provider: string,
  github: GithubMode | null,
  gitlab: GitlabMode | null,
): string {
  if (provider === "github" && github?.mode === "user") return `github (as @${github.login})`;
  if (provider === "gitlab" && gitlab !== null) {
    if (!URL.canParse(gitlab.url)) return `gitlab (as @${gitlab.login} at ${gitlab.url})`;
    const { host, pathname } = new URL(gitlab.url);
    return `gitlab (as @${gitlab.login} at ${host}${pathname.replace(/\/+$/, "")})`;
  }
  return provider;
}

/** What the composition resolved to, in a shape something other than a log line can render. */
export interface HostSummary {
  controlPlaneUrl: string;
  /** Null when model access is off — no RYPH_SECRETS_KEY, so the data plane never started. */
  modelProxyUrl: string | null;
  /** The gateway data plane's BIND address — loopback unless RYPH_MCP_GATEWAY_HOST widened it,
   * so the status block says which. Null when tool access is off: no RYPH_MCP_KEY and no
   * RYPH_SECRETS_KEY to default to, so the listener never started. */
  mcpGatewayUrl: string | null;
  /** Password-redacted. */
  db: string;
  /** The transcript's own database, when it was given one. */
  historyDb: string | null;
  /** Set when the historian is a separate service rather than mounted here. */
  historyRemote: string | null;
  authDisabled: boolean;
  provisioner: string;
  /** RYPH_AGENT_IMAGE, the image every run launches on. Null means no run can be provisioned. */
  agentImage: string | null;
  /** The forge, as this process dials it; null when there is none. */
  forge: string | null;
  /** What an in-process forge acts on ("github", "radicle"); null when the forge is not
   * in-process, so this root cannot know. Empty: it serves clones and takes patches, and has no
   * forge to deliver them to. */
  forgeProviders: string[] | null;
  /** How an in-process forge acts on GitHub — an App, or a user token and as whom — null when
   * the forge is not in-process, has no GitHub, or did not say. */
  forgeGithub: GithubMode | null;
  /** How an in-process forge acts on GitLab — a bot or one person's token, as whom, and at which
   * instance — null when the forge is not in-process or has no GitLab. */
  forgeGitlab: GitlabMode | null;
  /** Where an in-process forge lets local repositories be added from (RYPH_LOCAL_REPO_ROOT,
   * resolved). Null when the forge is not in-process, since a remote one reads its own, or when
   * no root is set. */
  forgeLocalRoot: string | null;
  /** The person an in-process Radicle bridge acts as (user mode); null when there is none. */
  radicle: RadicleSummary | null;
  gitGateway: string | null;
  /** Whatever `serveExtra` reported, so the status block can name the UI. */
  extra: string | null;
  /** Single-user: a one-time link that signs the owner in, minted at boot. Null multi-user, or
   * when no owner can sign in. */
  loginLink: string | null;
  /** Multi-user and unclaimed: the token the first registration needs. */
  setupToken: string | null;
  /** Environment builds when on: the builder, and why it builds nothing when it does not. Null
   * when off. */
  environments: { builder: string; refused: string | null } | null;
  /** Checks when on, and why none run when they do not. Null when off. */
  checks: { refused: string | null } | null;
}

/**
 * `http://<bind>:<port>` for each address, an IPv6 address bracketed. Loopback stays 127.0.0.1,
 * not `localhost`: these listeners do not bind ::1, which macOS tries first. Pure and exported
 * for the test.
 */
export function describeBinds(binds: string[], port: number): string {
  return binds.map((b) => `http://${urlHost(b)}:${port}`).join(", ");
}

/**
 * The placeholder address of an owner git names none for. Under `.localhost`, a name reserved
 * never to resolve anywhere, and with a dot in the domain: @ryph/auth's forms check addresses
 * with zod's `z.email()`, which refuses `owner@localhost`, and an owner whose stored address
 * fails that check could never save the account page that is meant to change it.
 */
export const PLACEHOLDER_OWNER_EMAIL = "owner@ryph.localhost";

/**
 * The single-user owner from git's `user.email` and `user.name`, either possibly unset: git's
 * address when @ryph/auth would accept it too (the same `z.email()` check), else the placeholder.
 * Pure and exported for the test.
 */
export function ownerFromGit(
  email: string | null,
  name: string | null,
): { email: string; name: string } {
  return {
    email: email !== null && z.email().safeParse(email).success ? email : PLACEHOLDER_OWNER_EMAIL,
    name: name ?? "Owner",
  };
}

/**
 * The single-user owner's name and address on a first boot: git's, which is who this machine's
 * commits already say its person is, else a placeholder the account page changes.
 */
async function ownerDefaults(): Promise<{ email: string; name: string }> {
  const read = async (key: string): Promise<string | null> => {
    try {
      const { success, stdout } = await command("git", {
        args: ["config", "--global", "--get", key],
        stdout: "piped",
        stderr: "null",
      }).output();
      const value = new TextDecoder().decode(stdout).trim();
      return success && value !== "" ? value : null;
    } catch {
      return null;
    }
  };
  return ownerFromGit(await read("user.email"), await read("user.name"));
}

/** Where ./dev serves the web app: its vite dev server. */
export const DEV_APP_URL = "http://localhost:5173";

/**
 * RYPH_APP_URL without a trailing slash, or null when unset. The orchestrator's main.ts reads it
 * the same way, inline. Pure and exported for the test.
 */
export function appUrlFromEnv(raw: string | undefined): string | null {
  return raw?.trim().replace(/\/+$/, "") || null;
}

/**
 * Single-user: a login link for the owner, made first if the instance has nobody. A link is
 * tried before the owner is ensured, so the usual boot, with the owner long made, never runs
 * git for defaults it would not use; only "no owner" goes on to make one. Without RYPH_APP_URL
 * the link is built on ./dev's app (DEV_APP_URL) — the boot link only: run links, the passkey
 * origin and the Host check still see no app URL. Exported for the test.
 */
export async function ownerLoginLink(
  auth: Pick<HostApp["auth"], "ensureOwner" | "mintLoginLink">,
  defaults: () => Promise<{ email: string; name: string }>,
): Promise<Awaited<ReturnType<HostApp["auth"]["mintLoginLink"]>>> {
  const first = await auth.mintLoginLink(DEV_APP_URL);
  if (first.ok || first.error !== "not-found") return first;
  const owner = await auth.ensureOwner(await defaults());
  return owner === null ? first : await auth.mintLoginLink(DEV_APP_URL);
}

/**
 * Why a multi-user boot is refused when no owner could sign in, or null when one can. A
 * single-user owner has no password until they set one, and multi-user refuses login links, so
 * switching first would leave the instance with nobody able to administer it. Nor when every
 * owner who can sign in still has the placeholder address (`PLACEHOLDER_OWNER_EMAIL`):
 * multi-user offers no way to change it, and mail to it reaches nobody. Exported for the test.
 */
export async function ownerLockout(
  auth: Pick<HostApp["auth"], "ownerSignInEmails">,
  multiUser: boolean,
): Promise<string | null> {
  if (!multiUser) return null;
  // One scan for both: null is an instance with nobody yet, claimed by the setup token.
  const emails = await auth.ownerSignInEmails();
  if (emails === null) return null;
  if (emails.length === 0) {
    return "RYPH_MULTIUSER=on, but no owner of this instance can sign in without a login link, " +
      "which multi-user refuses — every owner would be locked out. Start without RYPH_MULTIUSER, " +
      "set a password on the account page, then switch.";
  }
  if (!emails.every((e) => e === PLACEHOLDER_OWNER_EMAIL)) return null;
  return `RYPH_MULTIUSER=on, but the owner's address is still the placeholder ` +
    `${PLACEHOLDER_OWNER_EMAIL}, which multi-user offers no way to change. Start without ` +
    "RYPH_MULTIUSER, set your email and a password on the account page, then switch.";
}

/** Why no login link was made, as something the operator can act on. */
function loginLinkFailure(error: "multi-user" | "not-found" | "no-app-url"): string {
  switch (error) {
    case "not-found":
      return "no owner can sign in (every owner is deactivated or unverified)";
    case "no-app-url":
      return "RYPH_APP_URL is unset, so there is no address to build it on. Set it to where " +
        "the web app is reached, e.g. RYPH_APP_URL=http://localhost:5173";
    case "multi-user":
      return "this instance is multi-user, where everyone signs in as themself";
  }
}

export async function main(opts: HostMainOptions = {}): Promise<void> {
  setupLoggerFromEnv();
  const log = new Logger("host");
  const port = intEnv("RYPH_PORT", 7411);
  const proxyPort = intEnv("RYPH_MODEL_PROXY_PORT", 7420);
  const mcpPort = intEnv("RYPH_MCP_GATEWAY_PORT", 7430);
  const egressPort = intEnv("RYPH_EGRESS_PORT", 7460);
  // The interface the gateway data plane binds, loopback by default like every listener here
  // (RYPH_BIND below has the control plane's and the model proxy's reasons). This one has a
  // sharper reason still: it opens on UPGRADE — RYPH_MCP_KEY falls back to RYPH_SECRETS_KEY, which the
  // binary mints into ~/.ryph/secrets.key on first launch, so a deployment that changed nothing
  // would start answering JSON-RPC on every interface it has. Authentication still holds, but a
  // new pre-auth parser on a café LAN is not a thing to hand anyone silently.
  //
  // A containerised runner cannot dial the host's loopback, so that deployment sets this to
  // 0.0.0.0 — the same act as setting RYPH_MCP_GATEWAY_URL to a container view, and `ryph
  // doctor` checks the pair together.
  const mcpHostname = env("RYPH_MCP_GATEWAY_HOST") ?? "127.0.0.1";
  // The interface the egress proxy binds, on the precedent just above and for a sharper reason.
  // This listener answers a run's `Proxy-Authorization`, so wherever it can be reached, a stolen
  // claim is worth whatever that run's allowlist grants — and on a Linux laptop, where the
  // docker backend confines nothing anyway, 0.0.0.0 would publish it to the café LAN.
  //
  // It is only genuinely needed off loopback on a native Linux docker engine, where
  // `host.docker.internal` is the docker bridge's address; `ryph setup` writes that address here.
  const egressHostname = env("RYPH_EGRESS_BIND") ?? "127.0.0.1";
  // Whether more than one person may use this instance. Off by default here: this root is the
  // local binary and `bun run up`, one person's machine. Networked deployments run the
  // orchestrator's root, which defaults it on.
  let multiUser = false;
  try {
    multiUser = multiUserFromEnv(env, false);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  // The web app's origin as a BROWSER reaches it: run links in progress comments, mailed links,
  // the passkey origin, and single-user's login link. The binary sets it to the UI it serves.
  // Unset (`bun run up` beside ./dev), the surfaces that need it say so; only the boot login
  // link falls back to ./dev's vite server (ownerLoginLink), since without it the owner, who has
  // no password, has no way in at all.
  const appUrl = appUrlFromEnv(env("RYPH_APP_URL"));

  // RYPH_DB is one ryph database URL for every module mounted here (see @ryph/db):
  // `pglite:<path>`, `pglite:memory://` or `postgres://…`. They share ONE connection, because
  // opening the same PGlite data directory twice succeeds and then silently diverges.
  // The schema is never applied here: `bun run db:push` locally (this package's drizzle.config
  // covers every mounted module's tables, the historian's included), and each owner's generated
  // migrations in the binary, through `prepare`.
  const dbUrl = env("RYPH_DB") ?? "pglite:./data/ryph";

  // RYPH_HISTORY_DB gives the transcript a database of ITS OWN. Unset is the Mode A default:
  // it shares the control plane's instance, which is a deliberate local relaxation — a second
  // PGlite instance costs a few hundred megabytes of RSS, and under one Postgres the firehose
  // and run-state are separate MVCC connections anyway, so SQLite's single-writer-lock argument
  // for splitting them does not carry. Set it in a deployment that wants the split.
  const historyDbUrl = env("RYPH_HISTORY_DB") ?? null;
  // Parsed here rather than only inside buildApp so a typo'd URL fails as a named config error,
  // and so the log lines below can name the database WITHOUT its password: a postgres:// URL
  // carries one, and these lines go wherever logs go.
  let dbDescription: string;
  let historyDbDescription: string | null = null;
  try {
    dbDescription = describeDbTarget(parseDbUrl(dbUrl));
    if (historyDbUrl !== null) {
      historyDbDescription = describeDbTarget(parseDbUrl(historyDbUrl));
    }
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  // Set: a standalone historian this host talks to over HTTP (and mounts none in-process).
  const historyUrl = env("RYPH_HISTORY_URL")?.replace(/\/+$/, "") ?? null;
  // The same historian as a RUN dials it, to post its transcript: RYPH_RUN_HISTORY_URL, else the
  // same address — the standalone control plane's reader, for its reason (a run reaching it by
  // another way than this process does).
  const runHistoryUrl = historyUrl === null
    ? null
    : env("RYPH_RUN_HISTORY_URL")?.replace(/\/+$/, "") ?? historyUrl;
  if (historyUrl === null && env("RYPH_RUN_HISTORY_URL") !== undefined) {
    log.error("RYPH_RUN_HISTORY_URL is the run-facing half of RYPH_HISTORY_URL, which is unset");
    process.exit(2);
  }
  // Set: a standalone memory service — briefs are composed over HTTP with RYPH_MEMORY_TOKEN,
  // and the gateway dials its MCP route with RYPH_MEMORY_GATEWAY_TOKEN. Unset: memory is
  // mounted in-process over RYPH_DB, and neither token is needed (buildApp mints its own).
  const memoryUrl = env("RYPH_MEMORY_URL")?.replace(/\/+$/, "") ?? null;
  // Embeddings for the in-process memory's hybrid search: `local` runs bge-small-en-v1.5 on a
  // worker thread of this process, `off` is full-text alone. The binary carries the runtime and
  // the weights (opts.embeddings), so it defaults to `local`; a source run defaults to `off`, and
  // `local` there needs the runtime installed beside @ryph/memory and RYPH_MEMORY_MODEL_DIR (its
  // src/adapters/embed/local.ts says how). Either way the model loads on first use, never at
  // boot, and a model that cannot load is said once and leaves search on full-text: memory is
  // never the reason this process fails to start.
  const memoryEmbeddings = env("RYPH_MEMORY_EMBEDDINGS") ??
    (opts.embeddings === undefined ? "off" : "local");
  if (memoryEmbeddings !== "off" && memoryEmbeddings !== "local") {
    fail(
      `RYPH_MEMORY_EMBEDDINGS must be "off" or "local", got ${JSON.stringify(memoryEmbeddings)}`,
    );
  }
  const memoryEmbedder = memoryEmbeddings === "off" || memoryUrl !== null
    ? null
    : degradingEmbedder(
      workerEmbedder({
        modelDir: env("RYPH_MEMORY_MODEL_DIR") ?? opts.embeddings?.modelDir ?? "./models",
        offline: env("RYPH_MEMORY_MODEL_OFFLINE") !== "false",
        ...(opts.embeddings === undefined ? {} : { runtime: opts.embeddings.runtime }),
      }),
      (reason) =>
        log.warn(
          `memory embeddings are off: the model could not load (${reason}). Memory search ` +
            "falls back to full-text. Set RYPH_MEMORY_EMBEDDINGS=off to say so on purpose.",
        ),
    );
  // Set: a standalone chat service — rooms are bound over HTTP with RYPH_CHAT_TOKEN, and the
  // gateway dials its MCP route with RYPH_CHAT_GATEWAY_TOKEN. Unset: chat is mounted
  // in-process over RYPH_DB under RYPH_CHAT_KEY (defaulting to the master key below), and this
  // process polls the rooms' bots itself.
  const chatUrl = env("RYPH_CHAT_URL")?.replace(/\/+$/, "") ?? null;
  // Set: a standalone web service the gateway dials with RYPH_WEB_GATEWAY_TOKEN. Unset: mounted
  // in-process — it has no state to keep, so there is nothing to point anywhere.
  const webUrl = env("RYPH_WEB_URL")?.replace(/\/+$/, "") ?? null;

  const authDisabled = env("RYPH_AUTH") === "off";
  if (authDisabled) log.warn("RYPH_AUTH=off — the user surface is OPEN");
  // RYPH_PROXY_SECRET: multi-user, auth's setup refuses to start without it. Single-user it is a
  // warning only: the binary mints one for itself and its UI, but a separate app (./dev's) has
  // to be handed the same value, so one minted here would only lock that app's addresses out.
  if (!multiUser && !authDisabled && !env("RYPH_PROXY_SECRET")) {
    log.warn(
      "RYPH_PROXY_SECRET is unset, so any caller that reaches the control plane (a run " +
        "included) can name its own client address and spend the owner's sign-in budget. " +
        "`./dev init` writes one; otherwise set the same value on the host and the app.",
    );
  }

  // Two master keys, because the networked deployment has two processes holding them:
  // RYPH_SECRETS_KEY is the model-proxy's (it seals provider secrets), RYPH_MCP_KEY is the
  // mcp-gateway's (it seals MCP server credentials). This process is both, one trust domain by
  // construction, so the second defaults to the first — set it separately only when you
  // intend to move that service out later without re-keying what it already sealed. Sharing a
  // master does not share a key: each class seals under its own key derived from it (@ryph/sealed).
  //
  // Model access is dark without RYPH_SECRETS_KEY — agents with a model policy are then
  // refused at creation, and the data-plane listener never starts. Tool access follows the same
  // rule under RYPH_MCP_KEY, which without an explicit value means: dark too.
  const secretsKeyHex = env("RYPH_SECRETS_KEY");
  let masterKey: MasterKey | null = null;
  if (secretsKeyHex) {
    try {
      masterKey = await importMasterKey(secretsKeyHex);
    } catch (err) {
      fail(`RYPH_SECRETS_KEY: ${err instanceof Error ? err.message : err}`);
    }
  }
  // Outbound mail: verification and reset links go out through it. Without one every such link
  // lands on an admin's screen instead, so an instance works with no mailer at all.
  const smtpUrl = env("RYPH_SMTP_URL") ?? null;
  const mailFrom = env("RYPH_MAIL_FROM") ?? null;
  if ((smtpUrl === null) !== (mailFrom === null)) {
    fail("RYPH_SMTP_URL and RYPH_MAIL_FROM go together — set both or neither");
  }
  const smtp = smtpUrl === null || mailFrom === null ? null : { url: smtpUrl, from: mailFrom };

  const mcpKeyHex = env("RYPH_MCP_KEY");
  let mcpKey: MasterKey | null = masterKey;
  if (mcpKeyHex) {
    try {
      mcpKey = await importMasterKey(mcpKeyHex);
    } catch (err) {
      fail(`RYPH_MCP_KEY: ${err instanceof Error ? err.message : err}`);
    }
  }
  // The fourth: the chat service seals chatroom bot tokens under it. Same default, same reason.
  const chatKeyHex = env("RYPH_CHAT_KEY");
  let chatKey: MasterKey | null = masterKey;
  if (chatKeyHex) {
    try {
      chatKey = await importMasterKey(chatKeyHex);
    } catch (err) {
      fail(`RYPH_CHAT_KEY: ${err instanceof Error ? err.message : err}`);
    }
  }
  // Telegram's, Slack's and Discord's API addresses, for a stand-in of any (the playground's
  // mocks).
  let chatApiUrls: PlatformApiUrls;
  try {
    chatApiUrls = platformApiUrlsFromEnv(env);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  // The proxy address as seen FROM AN AGENT CONTAINER. Defaulted to this process's own listener,
  // the same way the orchestrator defaults RYPH_PUBLIC_URL — the two are the same kind of
  // guess about the same network, and having one default while the other warned meant the status
  // line could report model access as working while every run that used it failed at boot.
  //
  // Correct for a runner started by hand and for a container on the host's network; Docker
  // Desktop puts the container somewhere localhost does not reach, and needs
  // RYPH_MODEL_PROXY_URL=http://host.docker.internal:<port> — exactly as RYPH_PUBLIC_URL does.
  const modelProxyUrl = env("RYPH_MODEL_PROXY_URL") ?? `http://127.0.0.1:${proxyPort}`;
  // The MCP gateway's data plane, the same guess about the same network, and the same fix under
  // Docker Desktop: RYPH_MCP_GATEWAY_URL=http://host.docker.internal:<port>.
  const mcpGatewayUrl = env("RYPH_MCP_GATEWAY_URL") ?? `http://127.0.0.1:${mcpPort}`;
  // Read here rather than inline below, because it decides two things: what the control plane
  // signs a run's allowlist claim with, and whether this process serves the proxy that verifies
  // it. One key, both halves — which is the whole reason the proxy needs no credential store.
  const egressKey = egressKeyFromEnv(env, fail);
  // Hosted MCP servers' egress claims (@ryph/mcp-gateway's core/tool_egress.ts), on a key of
  // their own: this process mints them (its gateway) and verifies them (its egress proxy's tool
  // listener, RYPH_EGRESS_TOOL_PORT), so unset it is minted for this boot and kept nowhere —
  // hosting relaunches every hosted server at boot for a claim under the new one. Never a run's:
  // a run's claim must not open the tool listener, nor a hosted server's the run's.
  const toolEgressKey = toolEgressKeyFromEnv(env, fail) ?? mintToolEgressKey();
  if (
    egressKey !== null && egressKey.every((b, i) => b === toolEgressKey[i]) &&
    egressKey.length === toolEgressKey.length
  ) {
    fail("RYPH_EGRESS_TOOL_KEY must differ from RYPH_EGRESS_KEY: they sign different claims");
  }
  const egressToolPort = intEnv("RYPH_EGRESS_TOOL_PORT", 7461);

  // Where the gateway may dial. The default is public https hosts only — it forwards operator
  // credentials to operator URLs, which makes it an SSRF target by construction. Both flags
  // widen that, so both are logged when set: each is a route this deployment chooses to grant.
  // An MCP server on this machine (a local dev server, say) needs both.
  const mcpUpstream = {
    allowInsecure: flagEnv("RYPH_MCP_ALLOW_INSECURE"),
    allowPrivate: flagEnv("RYPH_MCP_ALLOW_PRIVATE_UPSTREAMS"),
  };
  if (mcpUpstream.allowInsecure) {
    log.warn("RYPH_MCP_ALLOW_INSECURE — plain http MCP upstreams permitted");
  }
  if (mcpUpstream.allowPrivate) {
    log.warn("RYPH_MCP_ALLOW_PRIVATE_UPSTREAMS — private-range MCP upstreams permitted");
  }
  // And the third place this deployment can be told to dial inward: a custom model endpoint's
  // base URL. The standalone proxy logs this at boot (packages/model-proxy/src/main.ts) and the
  // single-process binary — the one a laptop runs, and the one most likely to want a LAN vLLM —
  // has to say it too, or the knob turns on in silence. Read here only to log it: the schema
  // reads the environment per registration, so a deployment's answer is never a build's.
  if (privateModelEndpointsAllowed()) {
    log.warn(
      "RYPH_ALLOW_PRIVATE_MODEL_ENDPOINTS — a custom model endpoint may name a private or " +
        "loopback address, and may be plain http there",
    );
  }

  // The same bargain the gateway strikes above, one boundary over: the egress proxy refuses to
  // dial an address inside the network whatever an allowlisted name resolves to, and this is the
  // operator saying their allowlist names an internal mirror on purpose. Logged for the same
  // reason as its two neighbours — each is a route this deployment chose to open.
  const egressPolicy = egressPolicyFromEnv(env, fail);
  const egressAllowPrivate = flagEnv("RYPH_EGRESS_ALLOW_PRIVATE");
  if (egressAllowPrivate) {
    log.warn(
      "RYPH_EGRESS_ALLOW_PRIVATE — an allowlisted name may resolve to a private, loopback or " +
        "link-local address",
    );
  }
  // Addresses neither egress listener ever dials, ALLOW_PRIVATE or not. What a cloud VM sets to
  // its own public addresses: those are often on no interface this process can read (a 1:1 NAT),
  // and a hosted server's claim opens every public address on every port — this host's own
  // included, and with it whatever listens on 0.0.0.0 behind the cloud firewall.
  let egressDeny: ReturnType<typeof parseDenyCidrs>;
  try {
    egressDeny = parseDenyCidrs(env("RYPH_EGRESS_DENY_CIDRS") ?? "");
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  // Hosted MCP servers run on the provisioner's backend, fronted by the tool guard — our own
  // image: the published one in the binary, pulled on first launch, or the `:dev` build
  // `bun run agent-image` makes from source (images.ts). The caps apply to every tool container
  // unless its catalogue entry names its own memory.
  const toolGuardImage = env("RYPH_TOOL_GUARD_IMAGE") ?? defaultImage("tool-guard")!;
  const toolMemory = env("RYPH_TOOL_MEMORY");
  if (toolMemory !== undefined && !/^[1-9][0-9]{0,4}[mg]$/.test(toolMemory)) {
    fail(`RYPH_TOOL_MEMORY must be a size like 512m or 1g, got ${JSON.stringify(toolMemory)}`);
  }
  const toolCpus = env("RYPH_TOOL_CPUS");
  if (toolCpus !== undefined && !(Number(toolCpus) > 0)) {
    fail(`RYPH_TOOL_CPUS must be a positive number, got ${JSON.stringify(toolCpus)}`);
  }
  // A ceiling on how many of those containers may exist at once. Creating one is a user action
  // and each one is a memory cap on THIS machine, so the default is a number rather than trust.
  const toolMaxServers = env("RYPH_TOOL_MAX_SERVERS");
  if (
    toolMaxServers !== undefined && !(Number.isInteger(Number(toolMaxServers)) &&
      Number(toolMaxServers) > 0)
  ) {
    fail(
      `RYPH_TOOL_MAX_SERVERS must be a positive integer, got ${JSON.stringify(toolMaxServers)}`,
    );
  }

  // The forge git gateway pair. RYPH_GIT_GATEWAY_URL is the gateway address AS AN AGENT
  // CONTAINER dials it (with the docker provisioner on Docker Desktop this usually needs to
  // be http://host.docker.internal:7412); when set, every new run clones through the gateway
  // with a run-scoped virtual key and its work leaves as a bundle. RYPH_FORGE_TOKEN is the
  // shared service credential the gateway presents to resolve those keys — a gateway without
  // it can serve nobody, so setting one without the other is bad config, not a degraded mode.
  //
  // RYPH_FORGE_URL=embedded mounts the forge in this process instead, on its own listener
  // (RYPH_FORGE_PORT) because agent containers dial it just as they dial the model proxy. Then
  // nothing here needs configuring: the shared tokens are minted per boot, since both ends of
  // every link they guard live in this process, and the gateway address defaults to the
  // control plane's as a container sees it, on the forge's port.
  const forgeEmbedded = env("RYPH_FORGE_URL") === "embedded";
  const forgePort = intEnv("RYPH_FORGE_PORT", 7412);
  const forgeToken = env("RYPH_FORGE_TOKEN") ?? (forgeEmbedded ? mintToken() : null);
  const gitGatewayUrl = env("RYPH_GIT_GATEWAY_URL")?.replace(/\/+$/, "") ??
    (forgeEmbedded ? containerViewOn(env("RYPH_PUBLIC_URL"), port, forgePort) : null);
  const forgeGatewayToken = env("RYPH_FORGE_GATEWAY_TOKEN") ??
    (forgeEmbedded ? mintToken() : null);
  if (gitGatewayUrl !== null && forgeToken === null) {
    fail(
      "RYPH_GIT_GATEWAY_URL is set but RYPH_FORGE_TOKEN is not — the gateway could not resolve any run's credential",
    );
  }

  // RYPH_LOCAL_REPO_ROOT is the directory repositories on this machine may be added from — the
  // forge's `local` provider, which reads them at connect time and clones them like any other
  // repo. A setting of the FORGE, so it only means something here when the forge is in this
  // process; a standalone forge reads its own, and a value set beside one would otherwise sit
  // here looking like it did something. No default at this layer: the binary picks home.
  //
  // Resolved through symlinks here, once, so the forge's containment check compares real paths
  // against a real root, and a typo fails the boot rather than every add.
  //
  // `off` is no root, said out loud: the binary defaults to home only when this is unset.
  const localRootSetting = env("RYPH_LOCAL_REPO_ROOT") ?? null;
  let localRoot: string | null = null;
  const localRootOff = localRootSetting?.trim().toLowerCase() === LOCAL_ROOT_OFF;
  if (localRootSetting !== null && !localRootOff && !forgeEmbedded) {
    log.warn(
      "RYPH_LOCAL_REPO_ROOT is set but the forge is not in this process — it only takes " +
        "effect when set on the forge's own process",
    );
  } else if (localRootSetting !== null) {
    try {
      localRoot = resolveLocalRoot(localRootSetting);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  // GitHub's user mode — RYPH_GITHUB_TOKEN, or RYPH_GITHUB_TOKEN_COMMAND — is the forge's to
  // read, and an in-process forge reads it from this process's environment like the rest of its
  // settings: nothing to pass. Beside a remote forge it would sit here doing nothing, so say so.
  if (!forgeEmbedded && (env("RYPH_GITHUB_TOKEN") || env("RYPH_GITHUB_TOKEN_COMMAND"))) {
    log.warn(
      "RYPH_GITHUB_TOKEN / RYPH_GITHUB_TOKEN_COMMAND is set but the forge is not in this " +
        "process — it only takes effect when set on the forge's own process",
    );
  }
  // GitLab's settings, in either mode, are the forge's in the same way, but for the instance
  // URL, which in-process memory reads too, and the URL and client id, which the binary's app
  // (served through `serveExtra`) reads for its sign-in.
  const gitlabUnread = unreadGitlabSettings(env, {
    forgeEmbedded,
    memoryInProcess: memoryUrl === null,
    appInProcess: opts.serveExtra !== undefined,
  });
  if (gitlabUnread.length > 0) {
    log.warn(
      `${gitlabUnread.join(", ")} ${gitlabUnread.length === 1 ? "is" : "are"} set but the ` +
        "forge is not in this process — GitLab's settings only take effect on the forge's own " +
        "process",
    );
  }

  // Direct-git mode is gone: a deployment-wide token in a run's environment is the agent's to
  // read. Refused rather than ignored, so a config file still carrying it learns why.
  if (env("RYPH_GIT_CREDENTIAL_ORIGIN") || env("RYPH_GIT_CREDENTIAL_TOKEN")) {
    fail(
      "RYPH_GIT_CREDENTIAL_ORIGIN / RYPH_GIT_CREDENTIAL_TOKEN are no longer supported: add the " +
        "repository under Repos instead, from this machine (RYPH_LOCAL_REPO_ROOT) or from a " +
        "forge (GitHub, Radicle), and runs reach it through the git gateway. Unset them.",
    );
  }

  // RADICLE USER MODE — RYPH_RADICLE_URL=embedded runs the Radicle bridge (@ryph/radicle) in
  // this process, over the person's own Radicle identity and the radicle-node they already run
  // (RAD_HOME, default ~/.radicle): ryph then acts AS them on Radicle, as GitHub's user mode
  // acts as the person whose token it holds. Only beside the in-process forge, which is the one
  // thing that dials the bridge.
  //
  // The bridge holds that person's signing key, so its surface is as narrow as it gets here: a
  // listener on loopback only (an ephemeral port unless RYPH_RADICLE_PORT says otherwise), and a
  // bearer minted per boot and handed to the forge in memory — never written to the environment
  // or a file, so nothing this process spawns inherits it. Loopback alone is not the boundary:
  // an agent container under Docker Desktop or OrbStack can reach this machine's 127.0.0.1. The
  // token is, and no run is ever given it. Any other value of RYPH_RADICLE_URL is a bridge
  // somewhere else, which the forge reads for itself.
  const radicleEmbedded = env("RYPH_RADICLE_URL") === "embedded";
  if (radicleEmbedded && !forgeEmbedded) {
    fail(
      "RYPH_RADICLE_URL=embedded needs the in-process forge (RYPH_FORGE_URL=embedded) — the " +
        "forge is what dials the bridge",
    );
  }
  const radicleToken = radicleEmbedded ? mintToken() : null;
  const radiclePort = env("RYPH_RADICLE_PORT") === undefined ? 0 : intEnv("RYPH_RADICLE_PORT", 0);
  // Its scratch repositories and the git door's mirrors: never inside RAD_HOME, which is the
  // person's own. `./data/radicle` beside the database from a checkout; the binary says
  // ~/.ryph/radicle.
  const radicleData = resolve(env("RYPH_RADICLE_DATA") ?? "./data/radicle");

  // The forge as THIS PROCESS dials it (permission checks, PR submission, OAuth exchange) —
  // distinct from RYPH_GIT_GATEWAY_URL, which is the same server as a container sees it.
  // "noop" wires the recording fake: the whole patch lifecycle runs end to end with no
  // GitHub anywhere (permission checks allow, submissions "succeed" with fake PR refs).
  // Every dial between this process's own listeners says 127.0.0.1, never `localhost`: they bind
  // 127.0.0.1, and macOS resolves `localhost` to ::1 first, where anything could be listening
  // for the bearer token.
  const forgeUrl = env("RYPH_FORGE_URL") ?? null;
  let forge: HostConfig["forge"] = null;
  if (forgeUrl === "noop") {
    log.warn("RYPH_FORGE_URL=noop — forge calls are recorded, nothing reaches GitHub");
    forge = { kind: "noop" };
  } else if (forgeEmbedded) {
    forge = { kind: "http", url: `http://127.0.0.1:${forgePort}` };
  } else if (forgeUrl !== null) {
    if (forgeToken === null) {
      fail("RYPH_FORGE_URL is set but RYPH_FORGE_TOKEN is not — the forge would refuse us");
    }
    forge = { kind: "http", url: forgeUrl };
  }
  // A forge with no gateway would connect repos that no run can clone: the gateway is the only
  // way a run reaches a repository, so the pair is configured together or the boot says so.
  if (forge?.kind === "http" && gitGatewayUrl === null) {
    fail(
      "RYPH_FORGE_URL is set but RYPH_GIT_GATEWAY_URL is not — runs reach repositories only " +
        "through the forge's git gateway, so no task could start",
    );
  }

  // "manual" (the default) launches nothing and prints the env a hand-started runner needs.
  const provisionerKind = env("RYPH_PROVISIONER") ?? "manual";
  // The one default agent image (universal environment plus harness layer) and the harness
  // kinds an agent may pick: every image carries every harness, so the kind picks no image.
  // Under docker an unset one is the default (images.ts); kubernetes names its own.
  const agentImage = env("RYPH_AGENT_IMAGE") ??
    (provisionerKind === "docker" ? defaultImage("agent") : null);
  const harnessKinds = harnessKindsFromEnv(env, fail);
  // Size classes, read by the same function the standalone orchestrator uses.
  const runSizes = runSizesFromEnv(env, fail);
  // Environment builds: off unless RYPH_ENVIRONMENTS=on, their builder following the provisioner.
  // A docker build needs no registry, so its two images default as the agent image does: the
  // agent image's siblings, else the published ones (images.ts). Its clone runs in the docker
  // launcher. Embedded, that is this process, which dials the forge where this process does: the
  // run's gateway address (host.docker.internal) does not resolve here. A launcher elsewhere
  // cannot dial this process's loopback, so there it is left to RYPH_ENV_GIT_GATEWAY_URL, or the
  // run's address (a run gate's name, which resolves on the launcher's network too).
  const dockerBuilds = provisionerKind === "docker" &&
    (env("RYPH_ENV_BUILDER")?.trim() ?? "docker") === "docker";
  const launcherEmbedded = (env("RYPH_LAUNCHER_URL")?.trim() || EMBEDDED_LAUNCHER) ===
    EMBEDDED_LAUNCHER;
  const environments = environmentsConfigFromEnv(
    (name) => {
      const value = env(name);
      if (value !== undefined || !dockerBuilds) return value;
      if (name === "RYPH_HARNESS_IMAGE") return environmentImage("harness", agentImage);
      if (name === "RYPH_ENV_BASE_IMAGE") return environmentImage("universal", agentImage);
      if (name === "RYPH_ENV_GIT_GATEWAY_URL" && forge?.kind === "http" && launcherEmbedded) {
        return forge.url;
      }
      return undefined;
    },
    fail,
    provisionerKind,
  );
  // The browser sidecar, read by the orchestrator's own `browserConfigFromEnv`. Under docker the
  // binary defaults it to the published browser (images.ts), unset or empty alike; `off` passes
  // through to it as no browser, which unset cannot say once there is a default.
  const browser = browserConfigFromEnv(
    (name) => {
      if (name !== "RYPH_BROWSER_IMAGE") return env(name);
      return env(name)?.trim() ||
        (provisionerKind === "docker" ? defaultImage("browser") ?? undefined : undefined);
    },
    fail,
  );
  // Checks: off unless RYPH_CHECKS=on, their pods on the provisioner's own backend.
  const checkPolicy = checkPolicyFromEnv(env, fail, runSizes);
  const remoteChecks = remoteChecksConfigFromEnv(env, fail, [
    env("RYPH_PUBLIC_URL") ?? `http://127.0.0.1:${port}`,
    `http://127.0.0.1:${port}`,
    ...(appUrl ? [appUrl] : []),
  ]);
  let provisioner: HostConfig["provisioner"];
  /**
   * The docker launcher (launcher.ts): the one place docker runs, started in this process unless
   * RYPH_LAUNCHER_URL names one elsewhere. Null under every other provisioner.
   */
  let dockerLauncher: HostLauncher | null = null;
  /** The docker engine as the launcher read it at boot; null when it did not answer. */
  let engine: DockerEngine | null = null;
  /** Where `host.docker.internal` lands when that is an address of this machine (a native Linux
   * engine's bridge), read at boot under an embedded launcher; null otherwise. */
  let bridgeGateway: string | null = null;
  /** The run gate's name, which confined docker runs dial in place of this process; null else. */
  let runGate: string | null = null;
  /** Where the gate relays this process's routes when that is not the host: RYPH_DOCKER_GATE_TARGET,
   * or a container name a launcher elsewhere relays them to (its routes); null else. */
  let gateTarget: string | null = null;
  // What runners are told to dial. With the docker provisioner on Docker Desktop this usually
  // needs to be http://host.docker.internal:<port> — or the run gate's name, when confined.
  const publicUrl = env("RYPH_PUBLIC_URL") ?? `http://127.0.0.1:${port}`;
  // RYPH_IMAGE_PREFETCH=off leaves each image to its first launch, for a metered link or a
  // machine that never runs most of them. Read as the standalone launcher reads it.
  const prefetchSwitch = prefetchOn(env, fail);
  if (provisionerKind === "docker") {
    if (agentImage === null) fail("RYPH_PROVISIONER=docker needs RYPH_AGENT_IMAGE");
    const launcherSetting = env("RYPH_LAUNCHER_URL")?.trim() || EMBEDDED_LAUNCHER;
    const embedded = launcherSetting === EMBEDDED_LAUNCHER;
    // A launcher elsewhere has its own networks, runtime, gate, builder and prefetch: set here
    // they would read as configured and do nothing. Refused, naming where they belong — the same
    // list and words as the standalone control plane's (launcherCallerRefusal).
    if (!embedded) {
      const owned = launcherCallerRefusal(env, launcherSetting, null, {
        checks: false,
        builds: false,
        builder: environments.builder,
      });
      if (owned !== null) fail(owned);
    }
    const network = env("RYPH_DOCKER_NETWORK");
    const runNetwork = env("RYPH_DOCKER_RUN_NETWORK");
    gateTarget = env("RYPH_DOCKER_GATE_TARGET")?.trim() || null;
    if (gateTarget !== null && runNetwork === undefined) {
      fail("RYPH_DOCKER_GATE_TARGET is the run gate's, which only RYPH_DOCKER_RUN_NETWORK makes");
    }
    if (gateTarget !== null && network === undefined) {
      fail(
        "RYPH_DOCKER_GATE_TARGET names a container the gate reaches on RYPH_DOCKER_NETWORK, " +
          "which is unset",
      );
    }
    if (embedded) {
      const refused = embeddedHostingRefusal({
        hosting: mcpKey !== null,
        joined: gateTarget !== null,
        // Docker's and Podman's marker files, or the operator saying so (deploy/compose sets it).
        inContainer: env("RYPH_BIND_SCOPE") === "container" || existsSync("/.dockerenv") ||
          existsSync("/run/.containerenv"),
      });
      if (refused !== null) fail(refused);
    }
    // The run-facing addresses: what a confined run's gate must relay, and what it is warned of.
    // Every one goes to the same port on one target, since every one is this process: the host
    // by default, or this process's own name on the deployment network when it is itself a
    // container there (deploy/compose). One target and each address's own port, so no two can
    // disagree about a gate port.
    const runUrls = ([
      ["RYPH_PUBLIC_URL", publicUrl],
      ["RYPH_MODEL_PROXY_URL", masterKey === null ? null : modelProxyUrl],
      ["RYPH_MCP_GATEWAY_URL", mcpKey === null ? null : mcpGatewayUrl],
      ["RYPH_EGRESS_PROXY_URL", egressKey === null ? null : egressPolicy.proxyUrl],
      ["RYPH_GIT_GATEWAY_URL", gitGatewayUrl],
      ["RYPH_RUN_HISTORY_URL", runHistoryUrl],
    ] as const).map(([setting, url]) => ({ setting, url, target: gateTarget ?? GATE_TARGET }));
    // The embedded launcher's configuration, which is this process's own. CONFINED (a run
    // network): runs join an internal network and reach this process only through the run gate,
    // which relays exactly the ports of the addresses they are handed (see the docker
    // provisioner's header) — derived from those addresses so the two cannot drift apart.
    const embeddedConfig = async () => {
      const docker: DockerOptions = {
        network,
        runtime: env("RYPH_DOCKER_RUNTIME"),
        checkCaps: checkCapsFromEnv(env, fail),
      };
      if (runNetwork !== undefined) {
        docker.runNetwork = runNetwork;
        docker.gate = {
          image: env("RYPH_DOCKER_GATE_IMAGE") ?? defaultImage("run-gate")!,
          routes: gateRoutesFor(gateName({ network }), runUrls).routes,
          owner: await gateOwner(dbUrl),
        };
      }
      return docker;
    };
    const docker = embedded ? await embeddedConfig() : null;
    try {
      dockerLauncher = await connectLauncher({
        setting: launcherSetting,
        // Either variable itself or the file `<name>_FILE` names (deploy/compose: minted by the
        // launcher into a volume this container mounts read-only).
        // Waited for: compose starts this container once the launcher has started, and the
        // launcher mints the files as it boots.
        token: embedded ? undefined : await awaitLauncherToken(env, "RYPH_LAUNCHER_TOKEN", 30_000),
        toolsToken: embedded
          ? undefined
          : await awaitLauncherToken(env, "RYPH_LAUNCHER_TOOLS_TOKEN", 30_000),
        hosting: mcpKey !== null,
        embedded: () => ({
          docker: docker!,
          checks: checkPolicy.enabled && remoteChecks === null,
          environments: environments.enabled && dockerBuilds ? environments : null,
          // Every image a run, a hosted tool server or a build launches, fetched one at a time
          // so the first task does not wait on gigabytes nobody mentioned.
          prefetch: !prefetchSwitch ? null : prefetchImages({
            agent: agentImage,
            // The run gate's image, which the egress relay runs too.
            gate: docker!.gate?.image ??
              (mcpKey === null ? null : env("RYPH_DOCKER_GATE_IMAGE") ?? defaultImage("run-gate")),
            browser: browser?.image,
            // The guard fronts hosted MCP servers, which only run with the gateway on.
            toolGuard: mcpKey === null ? null : toolGuardImage,
            builds: environments.enabled && dockerBuilds
              ? {
                harness: environments.harnessImage,
                universal: environments.baseImage,
                confined: docker!.runNetwork !== undefined,
              }
              : null,
            env,
          }),
          // Hosted MCP servers: on their own internal network (RYPH_TOOL_NETWORK, `ryph-tools`),
          // fronted by the guard on an ordinary one — RYPH_DOCKER_NETWORK, or one the launcher
          // makes beside the tools network. A host process dials the guard on a loopback port, its
          // only way into Docker Desktop's VM; a process that is itself a container on the
          // deployment network (RYPH_DOCKER_GATE_TARGET names it there) dials it by name and
          // publishes nothing. Their one way out is the egress relay to this process's tool
          // listener, where the run gate reaches it: the host, or this container by name.
          tools: {
            network: env("RYPH_TOOL_NETWORK") ?? TOOLS_NETWORK,
            joined: gateTarget !== null,
            ...(network === undefined ? {} : { edge: network }),
            guardImage: toolGuardImage,
            egress: {
              image: env("RYPH_DOCKER_GATE_IMAGE") ?? defaultImage("run-gate")!,
              target: gateTarget ?? GATE_TARGET,
              port: egressToolPort,
            },
          },
        }),
      });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    // What this process turns on, a launcher elsewhere has to serve (an embedded one is handed
    // this process's own switches): refused here rather than failing every suite or build with a
    // 404 from a launcher that runs none.
    if (!embedded) {
      const unserved = launcherCallerRefusal(env, launcherSetting, dockerLauncher.info, {
        checks: checkPolicy.enabled && remoteChecks === null,
        builds: environments.enabled && dockerBuilds,
        builder: environments.builder,
      });
      if (unserved !== null) {
        await dockerLauncher.embedded?.close();
        fail(unserved);
      }
    }
    engine = dockerLauncher.info.engine;
    if (engine === null && dockerLauncher.embedded === null) {
      log.warn(engineAbsentWarning(dockerLauncher.url));
    }
    runGate = dockerLauncher.info.gate;
    provisioner = { kind: "docker", launcher: dockerLauncher.clients };
    if (runGate !== null) {
      const { elsewhere, unrouted } = gateCoverage(dockerLauncher.info, runUrls);
      if (elsewhere.length > 0) {
        log.warn(
          `the docker launcher confines runs to ${dockerLauncher.info.runNetwork}, where the only ` +
            `route to ryph is the run gate \`${runGate}\` — but ${elsewhere.join(", ")} names ` +
            `somewhere else, which a confined run cannot reach. Point it at ` +
            `http://${runGate}:<port>; \`ryph setup\` writes these for you.`,
        );
      }
      // Only a launcher elsewhere can say this: an embedded one's routes are derived from the
      // same addresses. Its routes are its own configuration (RYPH_DOCKER_GATE_ROUTES there).
      if (unrouted.length > 0) {
        log.warn(
          `the run gate \`${runGate}\` relays no port for ${unrouted.join(", ")}, so a confined ` +
            `run that dials it is refused. Add a route for it to RYPH_DOCKER_GATE_ROUTES on the ` +
            `docker launcher.`,
        );
      }
      // A launcher elsewhere whose gate relays this process's own addresses to a container name
      // (deploy/compose: \`ryph\`) dials this process over the deployment network, as
      // RYPH_DOCKER_GATE_TARGET does for an embedded one: the bind check below holds it to the
      // same rule. Read off the routes for the ports of what this process serves itself.
      if (!embedded) {
        const ownPorts = new Set(
          [
            publicUrl,
            masterKey === null ? null : modelProxyUrl,
            mcpKey === null ? null : mcpGatewayUrl,
            egressKey === null ? null : egressPolicy.proxyUrl,
            forgeEmbedded ? gitGatewayUrl : null,
          ].flatMap((value) => {
            const url = value === null ? null : URL.parse(value);
            return url === null || url.hostname !== runGate
              ? []
              : [Number(url.port || (url.protocol === "https:" ? 443 : 80))];
          }),
        );
        gateTarget = (dockerLauncher.info.routes ?? []).find((route) =>
          ownPorts.has(route.listen) && route.target !== GATE_TARGET
        )?.target ?? null;
      }
    }
  } else if (provisionerKind === "kubernetes") {
    if (agentImage === null) fail("RYPH_PROVISIONER=kubernetes needs RYPH_AGENT_IMAGE");
    provisioner = { kind: "kubernetes", ...kubernetesOptionsFromEnv(env, fail) };
  } else if (provisionerKind === "manual") {
    provisioner = { kind: "manual" };
  } else {
    fail(`unknown RYPH_PROVISIONER ${JSON.stringify(provisionerKind)}`);
  }
  // The interfaces the control plane, the model proxy and an embedded forge bind: loopback
  // always, the address this machine's runs dial it at, detected here at every boot
  // (`runAddress`: a native Linux engine's docker bridge, where a run's `host.docker.internal`
  // lands), and whatever RYPH_BIND lists, comma-separated. All three answer runs, and on the same
  // networks, so one set covers them. One RYPH_BIND lists that is missing is fatal, since a typo
  // there would otherwise only ever warn. See local_surface.ts.
  // The bridge is a question about this machine, asked only of a docker this process shares —
  // which a launcher elsewhere is not.
  if (dockerLauncher?.embedded) {
    bridgeGateway = await localBridgeGateway().catch(() => null);
  }
  const detectedRunAddress = runAddress({
    provisioner: provisioner.kind,
    dockerBridge: bridgeGateway,
  });
  const binds = bindAddresses(env("RYPH_BIND"), detectedRunAddress);
  // Docker on Linux with no daemon to ask at boot: its bridge, and so the address runs dial, comes
  // up with dockerd. Looked for until docker answers, and bound beside the rest once it is there
  // (serveOn's `later`); runs fail to call home until then. Docker Desktop and OrbStack forward to
  // loopback, and a wildcard bind already answers the bridge, so neither waits for anything.
  const lateBind = new AbortController();
  let laterRunAddress: Promise<string | null> | undefined;
  if (
    detectedRunAddress === null && dockerLauncher?.embedded && engine === null &&
    process.platform === "linux" && !binds.some(isWildcard)
  ) {
    // Whether docker answers yet is the launcher's to say; the bridge is this machine's.
    const launcherInfo = dockerLauncher.clients.info;
    laterRunAddress = lateRunAddress({
      detect: async () =>
        (await launcherInfo().catch(() => null))?.engine == null
          ? null
          : { address: await localBridgeGateway().catch(() => null) },
      signal: lateBind.signal,
    });
    laterRunAddress.then((address) => {
      if (address !== null) log.info(`docker is up: binding its bridge at ${address} too`);
    });
    log.warn(
      `docker runs cannot reach this process yet: docker is not answering, so the control ` +
        `plane, the model proxy${forgeEmbedded ? " and the forge" : ""} listen only on ${
          binds.join(", ")
        } until it does, then on its bridge too. Runs started ` +
        `before that fail to call home.`,
    );
  }
  // Every address a run is handed for a listener bound here has to be one it answers at. A run
  // on another machine, or behind another network, reaches a loopback-only listener only through
  // something that delivers to loopback: a tunnel, or an engine's host name (a confined docker
  // run's gate relays to that name). An address that can never answer is refused, since a run
  // would boot and fail at its first call home; a name is warned of (remoteRunReach). The model
  // proxy counts only where it is served, the git gateway only when the forge is this process's.
  for (
    const reach of remoteRunReach({
      binds,
      urls: [
        ["RYPH_PUBLIC_URL", publicUrl],
        ["RYPH_MODEL_PROXY_URL", masterKey === null ? null : modelProxyUrl],
        ["RYPH_GIT_GATEWAY_URL", forgeEmbedded ? gitGatewayUrl : null],
      ],
      aliases: runGate === null ? [] : [runGate],
    })
  ) {
    if ("refuse" in reach) fail(`RYPH_PROVISIONER=${provisionerKind}: ${reach.refuse}`);
    else log.warn(`RYPH_PROVISIONER=${provisionerKind}: ${reach.warn}`);
  }

  // The boundary, said out loud at boot — and said DIFFERENTLY per backend, because the honest
  // sentence inverts. Under `kubernetes`, or `docker` on an internal run network, an unwired
  // proxy leaves runs with no route out and every install fails. Under `manual` or an
  // unconfined `docker` the container keeps its default route
  // and reaches everything, so the setting enforces nothing at all — and an operator told the
  // first thing about the second deployment is holding exactly the inverted belief this design
  // exists to make impossible.
  if (egressPolicy.mode === "proxy" && (egressKey === null || egressPolicy.proxyUrl === null)) {
    log.warn(unwiredEgressWarning(
      provisionerKind,
      egressKey === null,
      egressPolicy.proxyUrl === null,
      // The launcher's word, not this process's environment: a remote launcher's run network is
      // its own setting, which this process refuses to hold.
      provisionerKind === "kubernetes" || dockerLauncher?.info.runNetwork != null,
    ));
  }
  if (egressPolicy.mode === "open") {
    log.warn("RYPH_EGRESS=open — runs reach the whole internet, and no boundary is claimed");
  }
  // Opened HERE, not in buildApp: this is the root that reads env and owns process lifetime,
  // and a cluster is an expensive, exclusive resource (see @ryph/db). One for everything the
  // control plane mounts; a second only when the transcript is given its own database.
  const cluster = await openDbCluster(dbUrl);
  const historyCluster: DbCluster | null = historyDbUrl === null
    ? null
    : await openDbCluster(historyDbUrl);

  // The binary's schema step. Before buildApp, because buildApp probes for tables and would
  // otherwise fail on a first launch that is about to provision itself.
  if (opts.prepare) {
    try {
      await opts.prepare({ cluster, historyCluster });
    } catch (err) {
      await cluster.close();
      await historyCluster?.close();
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  // The embedded forge, up before buildApp so nothing composed below ever dials a forge that is
  // not there yet. It resolves run keys against the control plane per request, not at boot, so
  // the control plane need not be listening yet either. The mailroom's table is the one the
  // automations already keep in this cluster; each mailroom sweeps only the mailboxes it rents.
  //
  // The bridge first, because the forge is handed its address; its event consumer only once the
  // forge — whose mailroom the events go to — is listening and the boot is past the owner
  // check below, so a refused boot has no consumer writing into the cluster. Its tables
  // (cursors, the tracked repositories) live in this cluster like every other module's.
  let embeddedRadicle: RunningRadicle | null = null;
  if (radicleEmbedded) {
    embeddedRadicle = await startRadicle({
      mode: "user",
      hostname: "127.0.0.1",
      port: radiclePort,
      token: radicleToken!,
      dataDir: radicleData,
      db: scopeRadicleDb(cluster),
      eventsUrl: `http://127.0.0.1:${forgePort}/v1/hooks/radicle`,
    });
  }
  let embeddedForge: RunningForge | null = null;
  if (forgeEmbedded) {
    // Bound like the control plane — loopback, the detected run address and whatever RYPH_BIND
    // lists — because a run dials the git gateway (RYPH_GIT_GATEWAY_URL, the control plane's
    // container view on this port) from the same networks it dials the control plane from. It
    // answers only the names it is reached by: loopback's (this process dials it at 127.0.0.1),
    // the gateway's and the control plane's container views, a build's clone address, the tool
    // surface's, and RYPH_ALLOWED_HOSTS, so a page rebound to 127.0.0.1 cannot reach the forge
    // API or local repos as same-origin. Webhook deliveries skip the check; the forge says why
    // (isHookDelivery).
    const forgeHosts = forgeAllowedHosts({
      binds,
      publicUrl,
      gitGatewayUrl,
      buildGatewayUrl: environments.buildGatewayUrl,
      toolsUrl: env("RYPH_FORGE_TOOLS_URL"),
      extra: env("RYPH_ALLOWED_HOSTS"),
    });
    // A bridge bound late is answered by name too, as one bound at boot is.
    laterRunAddress?.then((a) => a !== null && forgeHosts?.add(urlHost(a)));
    embeddedForge = await startForge({
      port: forgePort,
      orchestratorUrl: `http://127.0.0.1:${port}`,
      forgeToken: forgeToken!,
      toolsGatewayToken: forgeGatewayToken!,
      webhooksDb: scopeWebhooksDb(cluster),
      localRoot,
      serve: async (handler) => {
        try {
          return await serveOn({
            binds,
            later: laterRunAddress,
            port: forgePort,
            variable: "RYPH_BIND",
            what: "the forge",
            options: {},
            handler,
            onWaiting: (message) => log.warn(message),
            onBound: (hostname) =>
              log.info(`the forge now listening on http://${hostname}:${forgePort}`),
          });
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
      },
      guard: (handler) => guardHost(handler, forgeHosts),
      ...(embeddedRadicle === null
        ? {}
        : { radicle: { url: embeddedRadicle.url, token: radicleToken!, mode: "user" } }),
    });
  }

  const sweepCfg = {
    heartbeatTimeoutMs: intEnv("RYPH_HEARTBEAT_TIMEOUT_MS", 60_000),
    // Generous: scale-from-zero backends boot for minutes before the first beat; a local
    // container beats in seconds and never reaches it. Only cost: a launch that never comes up
    // is given up on minutes late, not seconds.
    startupGraceMs: intEnv("RYPH_STARTUP_GRACE_MS", 600_000),
    cancelGraceMs: intEnv("RYPH_CANCEL_GRACE_MS", 120_000),
    // How long past its own idle deadline a run may sit before the sweep
    // cancels it — the runner ends itself first; this is the backstop for one that did not.
    idleGraceMs: intEnv("RYPH_IDLE_GRACE_MS", 60_000),
  };
  // The operator's run limits: the ceiling every agent and task stays under, and the
  // deployment-wide caps. Parsed after the sweep's graces, which the provisioner backstop adds.
  const limits = deploymentLimitsFromEnv(env, fail, sweepCfg);

  // The deployment's LAST LINE on model spend: a rolling ceiling in the environment, so nobody
  // raises it from an admin session. Unset is no ceiling; the per-run caps still apply.
  const spendCeilingUsd = usdEnv("RYPH_MODEL_SPEND_CEILING_USD");
  const modelSpend: SpendLimits = {
    backstopMs: msEnv("RYPH_MODEL_SPEND_BACKSTOP_MS", 30_000),
    ceiling: spendCeilingUsd === null
      ? null
      : { usd: spendCeilingUsd, windowDays: intEnv("RYPH_MODEL_SPEND_WINDOW_DAYS", 30) },
  };
  if (modelSpend.ceiling !== null) {
    log.info(
      `model spend ceiling: $${modelSpend.ceiling.usd} per ${modelSpend.ceiling.windowDays} days`,
    );
  }

  // The sweep's cadence, below; reserved capacity rides it, so its hold is sized from it too.
  const reaperIntervalMs = intEnv("RYPH_REAPER_INTERVAL_MS", 10_000);
  // GitHub's user mode has no webhooks, so the patch sweep polls its merges (core/merge_poll.ts).
  const mergePoll = {
    ...DEFAULT_MERGE_POLL_CONFIG,
    intervalMs: intEnv("RYPH_MERGE_POLL_INTERVAL_MS", DEFAULT_MERGE_POLL_CONFIG.intervalMs),
    // Zero switches the poll off.
    perTick: msEnv("RYPH_MERGE_POLL_PER_TICK", DEFAULT_MERGE_POLL_CONFIG.perTick),
  };

  // Under docker, every image a run, a hosted tool server or a build launches is fetched at boot
  // by the launcher (the list is in the docker block above); the first-run flow reports how far
  // it got (GET /v1/images). A remote launcher decides its own list.
  // Embedded, this process's own switch; a launcher elsewhere fetches by its own (refused here
  // above), so whether there is anything to report is what it says of itself.
  const imagePrefetch = dockerLauncher !== null &&
      (dockerLauncher.embedded === null ? dockerLauncher.info.prefetch : prefetchSwitch)
    ? dockerLauncher.clients.imagePrefetch
    : null;

  // Boot-time failures out of the wiring (an unprovisioned database, above all) are
  // config-shaped: print the message and exit instead of dumping a stack.
  // Thumbnail jobs call the docker CLI from this process, which only an embedded launcher allows:
  // beside a launcher elsewhere this process holds no docker (launcher.ts), so it needs
  // RYPH_ARTIFACT_THUMBNAIL_URL or _SOCKET instead.
  const artifactThumbnail = localArtifactThumbnail(
    env,
    launcherEmbedded ? provisionerKind : "remote-launcher",
    defaultImage("browser"),
    (message) => log.warn(message),
  );
  const app = await buildApp({
    localPreviews: opts.localPreviews === true,
    ...(opts.previewListener === undefined ? {} : { previewListener: opts.previewListener }),
    cluster,
    historyCluster,
    authDisabled,
    multiUser,
    // The app's server proves with this that the client address it forwards is its own word.
    // The binary mints one per launch and hands the embedded app the same; unset (`bun run
    // up` beside a dev server), the address is taken as sent, which holds while this listener
    // answers loopback only. Multi-user, runs reach this control plane too, so auth's setup
    // refuses to start without it.
    proxySecret: env("RYPH_PROXY_SECRET") ?? null,
    localLoginSecret: opts.localLoginSecret ?? null,
    masterKey,
    modelProxyUrl,
    virtualKeyTtlMs: intEnv("RYPH_VIRTUAL_KEY_TTL_MS", 12 * 60 * 60 * 1000),
    modelSpend,
    mcpKey,
    mcpGatewayUrl,
    mcpVirtualKeyTtlMs: intEnv("RYPH_MCP_VIRTUAL_KEY_TTL_MS", 12 * 60 * 60 * 1000),
    mcpUpstream,
    toolGuardImage,
    toolEgressKey,
    ...(dockerLauncher === null ? {} : { toolHost: dockerLauncher.toolHost }),
    hostingLimits: {
      ...(toolMemory === undefined ? {} : { memory: toolMemory }),
      ...(toolCpus === undefined ? {} : { cpus: toolCpus }),
      ...(toolMaxServers === undefined ? {} : { maxServers: Number(toolMaxServers) }),
    },
    provisioner,
    // One shared reader, so this composition root and the orchestrator's cannot disagree about
    // what RYPH_SERVICES means — the precedent kubernetesOptionsFromEnv sets.
    services: servicePolicyFromEnv(env, fail),
    // And the browser sidecar, by the same token.
    // Under docker the binary defaults it to the published browser (images.ts).
    // `off` is no browser, which unset cannot say once there is a default.
    browser,
    // And the same for egress. On the binary this is the policy whose ENFORCEMENT is not this
    // process's to give: it can withhold the proxy credential, and it does, but only a run
    // network with no default route makes that a boundary rather than a preference. The wizard
    // says so where it sets the backend up (packages/ryph/src/setup.ts).
    egress: {
      policy: egressPolicy,
      key: egressKey,
      // A day, not the setup window: the harness holds the same claim the setup steps did, so
      // the expiry has to cover a run rather than its first phase (helpers/environment.ts in
      // the runner says why the phase split is gone).
      tokenTtlMs: intEnv("RYPH_EGRESS_TOKEN_TTL_MS", 24 * 60 * 60 * 1000),
    },
    gitGateway: gitGatewayUrl === null ? null : {
      url: gitGatewayUrl,
      keyTtlMs: intEnv("RYPH_GIT_KEY_TTL_MS", 24 * 60 * 60 * 1000),
    },
    forgeToken,
    forge,
    // The historian as this process dials it (the conclude ping). Null: mounted in-process over
    // its own database. Set: a standalone historian — this host talks to it over HTTP and mounts
    // none. buildApp fails fast if the URL is set without RYPH_HISTORY_TOKEN.
    historyUrl,
    // And as an agent container dials it.
    runHistoryUrl,
    historyToken: env("RYPH_HISTORY_TOKEN") ?? null,
    memoryUrl,
    memoryToken: env("RYPH_MEMORY_TOKEN") ?? null,
    memoryGatewayToken: env("RYPH_MEMORY_GATEWAY_TOKEN") ?? null,
    memoryEmbedder,
    memoryGitlabUrl: env("RYPH_GITLAB_URL") ?? null,
    chatUrl,
    chatToken: env("RYPH_CHAT_TOKEN") ?? null,
    chatGatewayToken: env("RYPH_CHAT_GATEWAY_TOKEN") ?? null,
    // On unless the deployment says otherwise. "off" is the switch that takes the web tools away
    // entirely: nothing mounted, no row seeded, no run scoped to it.
    webTools: boolEnv("RYPH_WEB_TOOLS", true),
    webUrl,
    webGatewayToken: env("RYPH_WEB_GATEWAY_TOKEN") ?? null,
    // The web search provider and its key. No key: runs get `web__fetch` and no `web__search`,
    // and the boot log says so. The key is never logged and never leaves the web service.
    webSearch: {
      provider: env("RYPH_WEB_SEARCH_PROVIDER") ?? null,
      key: env("RYPH_WEB_SEARCH_KEY") ?? null,
    },
    webAllowInsecure: env("RYPH_WEB_ALLOW_INSECURE") === "1",
    webFetchTimeoutMs: intEnv("RYPH_WEB_FETCH_TIMEOUT_MS", 20_000),
    // The forge's tool surface as the in-process gateway dials it — the forge's own URL unless
    // told otherwise — and the credential presented there. No token: no forge tools.
    forgeToolsUrl: env("RYPH_FORGE_TOOLS_URL")?.replace(/\/+$/, "") ?? null,
    // In-process, only when the forge lit its tool surface: a token for a door that is not
    // there would seed a platform server every run then fails to reach.
    forgeGatewayToken: embeddedForge === null || embeddedForge.tools ? forgeGatewayToken : null,
    chatKey,
    chatApiUrls,
    publicUrl,
    appUrl,
    smtp,
    agentImage,
    harnessKinds,
    runSizes,
    limits,
    environments,
    checks: checkPolicy,
    remoteChecks,
    capacityReconcileIntervalMs: intEnv("RYPH_CAPACITY_RECONCILE_INTERVAL_MS", 60_000),
    reaperIntervalMs,
    // Beside the patches, in the same object store: build and check logs when those are on, and
    // background commands' logs always.
    environmentLogs: buildLogStoreFromEnv(env, fail, loggerDiagnostics("environments")),
    // A run's images: local files under RYPH_ATTACHMENT_DIR (./data) unless the patch store is
    // S3, then beside the patches under `attachments/`.
    attachmentStore: attachmentStoreFromEnv(env, fail, loggerDiagnostics("attachments")),
    artifactThumbnail: artifactThumbnail.renderer,
    imagePrefetch,
  }).catch(async (err: unknown) => {
    // Give the databases back before exiting: an on-disk PGlite that is never closed leaves its
    // data directory needing crash recovery on the next boot, and the common way to land here
    // is an unprovisioned database — i.e. every first run before `db:push`.
    await artifactThumbnail.shutdown();
    await cluster.close();
    await historyCluster?.close();
    return fail(err instanceof Error ? err.message : String(err));
  });
  // A multi-user boot over a single-user database whose owner never set a password would serve
  // an instance nobody can administer. As early as it can be asked: auth lives in buildApp,
  // which the forge and the Radicle bridge have to precede, so those two are listening already
  // and are taken down again; the control plane, the proxy and the bridge's consumer are not
  // started yet.
  const lockout = authDisabled ? null : await ownerLockout(app.auth, multiUser);
  if (lockout !== null) {
    await artifactThumbnail.shutdown();
    lateBind.abort();
    app.close();
    await embeddedForge?.server.shutdown();
    await embeddedForge?.close();
    await embeddedRadicle?.server.shutdown();
    await embeddedRadicle?.close();
    await cluster.close();
    await historyCluster?.close();
    fail(lockout);
  }
  embeddedRadicle?.start();

  // The bridge's tracked set against the control plane's connected repositories: a repository
  // tracked with no live row behind it is one whose disconnect never reached the bridge (a
  // crash between the two, a node that was down), and is disconnected now through the same
  // path — out of scope, cursors and mirror gone, a policy ryph wrote removed or left pending.
  //
  // The rows are read HERE, before the control plane listens, so no connect can be half done
  // when they are; and `before` is taken first, so a connect that lands afterwards — its
  // tracked row refreshed after it — is never mistaken for drift. The untracking itself may
  // wait on the node, so it runs off the boot path.
  if (embeddedRadicle !== null) {
    const bridge = embeddedRadicle;
    const before = new Date().toISOString();
    const connected = new Set(
      (await app.store.listConnectedRepos())
        .filter((r) => r.provider === "radicle" && r.archivedAt === null)
        .map((r) => r.repoRef),
    );
    void bridge.untrackExcept(connected, before).then((dropped) => {
      if (dropped.length > 0) {
        log.warn(`radicle: stopped watching ${dropped.length} repositories nothing has connected`, {
          rids: dropped,
        });
      }
    }).catch((err) => log.warn(`radicle: tracked-set check failed: ${err}`));
  }

  // The submitter rides the same tick: with a forge wired, approved patches get delivered;
  // without one, patches simply wait (connected repos cannot exist then, so none will).
  // Skip a tick while the previous run of that sweep is still in flight — same reasoning as the
  // standalone root: setInterval does not await, and a patch delivery is a GitHub call that can
  // outlast the interval. Guarded separately so a slow submission never delays the reaper.
  let sweepInFlight = false;
  let buildTickInFlight = false;
  let checkTickInFlight = false;
  let capacityTickInFlight = false;
  let patchSweepInFlight = false;
  let progressSweepInFlight = false;
  const runProgressSweep = () => {
    if (app.progressSweepDeps === null || progressSweepInFlight) return;
    progressSweepInFlight = true;
    sweepProgressComments(app.progressSweepDeps)
      .catch((err) => app.sweepDeps.diag.warn("reaper.progress_sweep_failed", { err: String(err) }))
      .finally(() => (progressSweepInFlight = false));
  };
  // A run going terminal hurries the progress sweep, so the final comment edit lands in
  // milliseconds instead of a tick later — the edit itself stays in the sweep (idempotent,
  // retried); the hook only changes when it runs.
  app.onTerminal(runProgressSweep);
  // The memory consolidator works the in-process inbox on its own, slower cadence: a pass is a
  // walk over pending proposals, and a proposal waiting a minute costs nothing. Skipped while
  // the previous pass is still in flight, like every other sweep here.
  // Auth's housekeeping is slow by nature (a purge grace measured in days), so it rides its own
  // hourly tick rather than the reaper's.
  let authSweepInFlight = false;
  const authSweeper = setInterval(() => {
    if (authSweepInFlight) return;
    authSweepInFlight = true;
    app.sweepAuth()
      .catch((err) => log.warn("auth sweep failed", { err: String(err) }))
      .finally(() => (authSweepInFlight = false));
  }, intEnv("RYPH_AUTH_SWEEP_INTERVAL_MS", 60 * 60 * 1000));
  let consolidateInFlight = false;
  const consolidator = app.consolidateMemory === null ? null : setInterval(() => {
    if (consolidateInFlight) return;
    consolidateInFlight = true;
    app.consolidateMemory!()
      .catch((err) => app.sweepDeps.diag.warn("memory.consolidate_failed", { err: String(err) }))
      .finally(() => (consolidateInFlight = false));
  }, intEnv("RYPH_MEMORY_CONSOLIDATE_INTERVAL_MS", 60_000));
  // The embeddings backfill: memories written before embeddings were on (every memory of a
  // binary that predates them), or whose own embedding failed, get their vectors a batch at a
  // time; once none is missing a tick is one query and the model is not loaded for it.
  let backfillInFlight = false;
  const memoryBackfill = app.backfillMemoryEmbeddings === null ? null : setInterval(() => {
    if (backfillInFlight) return;
    backfillInFlight = true;
    app.backfillMemoryEmbeddings!()
      .catch((err) => app.sweepDeps.diag.warn("memory.backfill_failed", { err: String(err) }))
      .finally(() => (backfillInFlight = false));
  }, intEnv("RYPH_MEMORY_BACKFILL_INTERVAL_MS", 30_000));
  const reaper = setInterval(() => {
    if (!sweepInFlight) {
      sweepInFlight = true;
      sweep(app.sweepDeps, sweepCfg)
        .catch((err) => app.sweepDeps.diag.warn("reaper.sweep_failed", { err: String(err) }))
        .finally(() => (sweepInFlight = false));
    }
    if (app.patchSweepDeps !== null && !patchSweepInFlight) {
      patchSweepInFlight = true;
      sweepPatches({ ...app.patchSweepDeps, mergePoll }, DEFAULT_PATCH_SUBMIT_CONFIG)
        .catch((err) => app.sweepDeps.diag.warn("reaper.patch_sweep_failed", { err: String(err) }))
        .finally(() => (patchSweepInFlight = false));
    }
    runProgressSweep();
    // The build queue rides the reaper's tick: claim what a free slot allows, abort a build
    // whose row moved on, fail one whose run went away.
    if (app.environments !== null && !buildTickInFlight) {
      buildTickInFlight = true;
      app.environments.tick()
        .catch((err) => app.sweepDeps.diag.warn("environments.tick_failed", { err: String(err) }))
        .finally(() => (buildTickInFlight = false));
    }
    // The check queue rides it too: launch within the cap, poll the pods, settle, tell, report.
    if (app.checks !== null && !checkTickInFlight) {
      checkTickInFlight = true;
      app.checks.tick()
        .catch((err) => app.sweepDeps.diag.warn("checks.tick_failed", { err: String(err) }))
        .finally(() => (checkTickInFlight = false));
    }
    // Reserved capacity, where the provisioner holds it: a pass when a save moved the row or the
    // interval is up. The tick logs its own failures and never throws. One process, so the
    // Lease is always this one's; taking it costs a request an interval.
    const capacity = app.capacity;
    if (capacity !== null && !capacityTickInFlight) {
      capacityTickInFlight = true;
      capacity.tick().finally(() => (capacityTickInFlight = false));
    }
  }, reaperIntervalMs);

  // The environments reconcile, at boot and then hourly: what a deploy changed (images on an
  // old harness re-layered, images on an old base rebuilt), then every subject refreshed from
  // the forge and retention swept. One process, so no lock.
  let envReconcileInFlight = false;
  const runEnvReconcile = () => {
    const environments = app.environments;
    if (environments === null || envReconcileInFlight) return;
    envReconcileInFlight = true;
    (async () => {
      await environments.onBoot();
      await environments.reconcile();
    })()
      .catch((err) =>
        app.sweepDeps.diag.warn("environments.reconcile_failed", { err: String(err) })
      )
      .finally(() => (envReconcileInFlight = false));
  };
  runEnvReconcile();
  const envReconciler = setInterval(
    runEnvReconcile,
    intEnv("RYPH_ENV_RECONCILE_INTERVAL_MS", 60 * 60 * 1000),
  );

  // The org skills repo's backstop, at boot and then hourly: a lost push event, or a branch other
  // than the default (which sends none), is picked up here. One process, so no lock.
  let skillsReconcileInFlight = false;
  const runSkillsReconcile = () => {
    if (skillsReconcileInFlight) return;
    skillsReconcileInFlight = true;
    app.reconcileSkills()
      .catch((err) => app.sweepDeps.diag.warn("skills.reconcile_failed", { err: String(err) }))
      .finally(() => (skillsReconcileInFlight = false));
  };
  runSkillsReconcile();
  const skillsReconciler = setInterval(
    runSkillsReconcile,
    intEnv("RYPH_SKILLS_RECONCILE_INTERVAL_MS", 60 * 60 * 1000),
  );

  // The automations ticks: the mailroom's scan (also kicked the moment a fire lands in a mailbox
  // with no drain running, so it is delivered in milliseconds) and the schedule tick. The scan
  // never waits on a delivery — each automation's mailbox drains on its own after it — never runs
  // twice at once, and a kick during one is coalesced into one more rather than dropped. No
  // advisory lock, because this composition is one process.
  const runAutomationsSweep = coalescingTick(
    () => app.automations.tick(),
    (err) => app.sweepDeps.diag.warn("automations.sweep_failed", { err: String(err) }),
  );
  app.onFireIngested(runAutomationsSweep);
  let schedulerInFlight = false;
  const automationsTicker = setInterval(() => {
    runAutomationsSweep();
    if (!schedulerInFlight) {
      schedulerInFlight = true;
      app.automations.schedulerTick()
        .catch((err) =>
          app.sweepDeps.diag.warn("automations.scheduler_failed", { err: String(err) })
        )
        .finally(() => (schedulerInFlight = false));
    }
  }, intEnv("RYPH_AUTOMATIONS_TICK_MS", 5_000));
  // The keep-warm access check, hourly: see the orchestrator's OUTAGE_ACCESS_GRACE_MS.
  let accessRefreshInFlight = false;
  const runAccessRefresh = () => {
    if (accessRefreshInFlight) return;
    accessRefreshInFlight = true;
    app.automations.accessTick()
      .catch((err) =>
        app.sweepDeps.diag.warn("automations.access_refresh_failed", { err: String(err) })
      )
      .finally(() => (accessRefreshInFlight = false));
  };
  runAccessRefresh();
  const accessRefresher = setInterval(
    runAccessRefresh,
    intEnv("RYPH_AUTOMATIONS_ACCESS_REFRESH_MS", 60 * 60_000),
  );
  // The chatrooms' poll: one pass over every live room's bot per tick, each a long poll the
  // platform holds for up to 25 s — so a pass can outlast the tick, and `pollAll` skips a room
  // whose hold is still open. The signal cuts every hold short on drain.
  const polling = new AbortController();
  let chatPollInFlight = false;
  const chatPoller = app.chat === null ? null : setInterval(() => {
    if (chatPollInFlight) return;
    chatPollInFlight = true;
    app.chat!.pollAll(polling.signal)
      .catch((err) => app.sweepDeps.diag.warn("chat.poll_failed", { err: String(err) }))
      .finally(() => (chatPollInFlight = false));
  }, intEnv("RYPH_CHAT_POLL_INTERVAL_MS", 2_000));
  imagePrefetch?.start().catch((err: unknown) =>
    log.warn(`image prefetch did not start: ${err instanceof Error ? err.message : String(err)}`)
  );
  // Hosted MCP servers: boot in the background — the tools network, the guard, the reconcile —
  // so a slow image pull never holds up the control plane; until it lands, the catalogue says
  // hosting is starting. The supervisor then rides its own interval beside the reaper: slower,
  // because each tick is a probe per healthy server, and a server three probes from
  // "unreachable" should not get there in thirty seconds.
  const hosting = app.hosting;
  let supervisor: ReturnType<typeof setInterval> | null = null;
  /** Set as the drain stops hosting — a boot finishing after that has nothing to report. */
  let hostingStopped = false;
  if (hosting !== null) {
    hosting.boot().then(() => {
      if (hostingStopped) return;
      const availability = hosting.availability();
      if (availability.available) {
        log.info("hosted MCP servers on", {
          backend: provisionerKind,
          guard: hosting.guard()?.origin ?? "?",
        });
      } else {
        log.warn(`hosted MCP servers unavailable — ${availability.reason}`);
      }
    });
    let superviseInFlight = false;
    supervisor = setInterval(() => {
      if (superviseInFlight) return;
      superviseInFlight = true;
      hosting.supervise()
        .catch((err) => app.sweepDeps.diag.warn("hosting.supervise_failed", { err: String(err) }))
        .finally(() => (superviseInFlight = false));
    }, intEnv("RYPH_MCP_SUPERVISOR_INTERVAL_MS", 30_000));
  }

  // onListen silences serve()'s own "Listening on http://0.0.0.0:…" banner: the log line
  // below says the same thing, and 0.0.0.0 is not an address to hand anybody.
  //
  // Each listener's long-lived streams are tracked — a browser tab's SSE tail and a runner's live
  // uplink here, a streamed completion on the model proxy, a streamed tool call on the gateway —
  // because none finishes on its own, and the drain ends them or `shutdown()` waits out its
  // whole deadline on any one of them. A cut completion or tool call is errored, not closed, so
  // the harness sees a failed call rather than a short reply.
  //
  // The control plane answers only the names this deployment is reached by — loopback's, the
  // container-view URLs it hands runs, RYPH_ALLOWED_HOSTS — so a page whose DNS name was pointed
  // at 127.0.0.1 cannot talk to it as same-origin. The model proxy is bearer-only and answers
  // runs by whatever name their network gives it, so it binds narrowly and checks no name.
  // Webhook ingestion (`POST /v1/hooks/:id`) answers every name: its senders deliver to whatever
  // URL they were handed, often a tunnel's this process was never told of, and it needs no
  // browser credential — each registration verifies its own signature or secret header and
  // reads no cookie. The same door, and the same test, as the forge's (isHookDelivery).
  const hosts = allowedHosts({
    binds,
    urls: [
      publicUrl,
      appUrl,
      modelProxyUrl,
      mcpGatewayUrl,
      gitGatewayUrl,
      runHistoryUrl,
      egressPolicy.proxyUrl,
    ],
    extra: env("RYPH_ALLOWED_HOSTS"),
  });
  laterRunAddress?.then((a) => a !== null && hosts?.add(urlHost(a)));
  // A bind that fails exits naming the setting (listen.ts); a bridge found after boot is bound
  // late, and said so then.
  const bindOrFail = async (
    o: Omit<Parameters<typeof serveOn>[0], "onWaiting" | "onBound">,
    label: string,
    fields?: Record<string, unknown>,
  ) => {
    let server: HttpServer;
    try {
      server = await serveOn({
        ...o,
        onWaiting: (message) => log.warn(message),
        onBound: (hostname) =>
          log.info(`${label} now listening on ${describeBinds([hostname], o.port)}`),
      });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    log.info(`${label} listening on ${describeBinds(o.binds, o.port)}`, fields);
    return server;
  };
  const streams = trackStreams();
  const server = await bindOrFail(
    {
      binds,
      later: laterRunAddress,
      port,
      variable: "RYPH_BIND",
      what: "the control plane",
      options: {},
      handler: acceptingUpgrades(streams.wrap(guardHost(app.handler, hosts, isHookDelivery))),
    },
    "control plane",
    { provisioner: provisionerKind, db: dbDescription },
  );
  let proxyServer: HttpServer | null = null;
  const proxyStreams = trackStreams({ work: () => true });
  if (app.proxyHandler) {
    proxyServer = await bindOrFail({
      binds,
      later: laterRunAddress,
      port: proxyPort,
      variable: "RYPH_BIND",
      what: "the model proxy",
      options: { onError: quietDrainErrors },
      handler: proxyStreams.wrap(app.proxyHandler),
    }, "model-proxy data plane");
  }
  const bindNotice = wildcardBindNotice(binds, env("RYPH_BIND_SCOPE"), forgeEmbedded);
  if (bindNotice) log[bindNotice.level](bindNotice.message);
  let mcpServer: HttpServer | null = null;
  const mcpStreams = trackStreams({ work: (req) => req.method === "POST" });
  if (app.mcpGatewayHandler) {
    try {
      mcpServer = await serve(
        { port: mcpPort, hostname: mcpHostname, onListen: () => {}, onError: quietDrainErrors },
        mcpStreams.wrap(app.mcpGatewayHandler),
      );
    } catch (err) {
      fail(bindFailure("the MCP gateway", "RYPH_MCP_GATEWAY_HOST", mcpHostname, mcpPort, err));
    }
    // The BIND address, not a dialable one, like its two siblings' lines: whether this port
    // answers the network is the thing worth reading at a glance.
    log.info(`mcp-gateway data plane listening on http://${urlHost(mcpHostname)}:${mcpPort}`);
  }
  // The egress proxy, in-process. It holds no credential and reads no database: a run presents a
  // signed claim carrying its own allowlist, and this verifies the signature with the key that
  // minted it, which is what lets the enforcement point be this cheap to run.
  //
  // Started on the KEY, not on the policy, and it deliberately does not default
  // RYPH_EGRESS_PROXY_URL. What a run should dial is `host.docker.internal` (or the run
  // gate) under docker and localhost only for a hand-started runner; defaulting it here would
  // write an address that is right on one backend into the env of runs on every other.
  /** The tool host sends hosted servers out through this process's tool listener. */
  const toolEgressOn = dockerLauncher !== null && !("unavailable" in dockerLauncher.toolHost) &&
    dockerLauncher.toolHost.egressProxy != null;
  let egressServer: ReturnType<typeof makeProxy> | null = null;
  if (egressKey !== null) {
    egressServer = makeProxy({
      key: egressKey,
      allowPrivate: egressAllowPrivate,
      deny: egressDeny,
      // Refused hosts go back to the control plane this process is also serving, over its own
      // loopback socket. An in-process call would be shorter and would also be the one code
      // path the standalone proxy does not have: the same POST, the same route and the same
      // claim-as-credential on both deployments is worth one loopback hop.
      report: makeRefusalReporter(`http://127.0.0.1:${port}`),
    });
    await listenNode(egressServer, egressPort, egressHostname).catch((err) =>
      fail(bindFailure("the egress proxy", "RYPH_EGRESS_BIND", egressHostname, egressPort, err))
    );
    // The BIND address, like the gateway's line above: whether this port answers the network is
    // the thing worth reading at a glance.
    log.info(`egress proxy listening on http://${urlHost(egressHostname)}:${egressPort}`);
  }
  // Its second listener: hosted MCP servers', whose only way out it is under docker (the
  // launcher's egress relay dials it). Their claims only, on their own key, never a private
  // address whatever RYPH_EGRESS_ALLOW_PRIVATE says (images/egress-proxy/main.ts). On whenever the
  // tool host relays to it, RYPH_EGRESS_KEY or not: hosting does not wait on runs' egress.
  let egressToolServer: ReturnType<typeof makeProxy> | null = null;
  if (toolEgressOn) {
    egressToolServer = makeProxy({ key: toolEgressKey, claims: "tool", deny: egressDeny });
    await listenNode(egressToolServer, egressToolPort, egressHostname).catch((err) =>
      fail(
        bindFailure(
          "the egress proxy's tool listener",
          "RYPH_EGRESS_BIND",
          egressHostname,
          egressToolPort,
          err,
        ),
      )
    );
    log.info(
      `egress proxy listening for hosted MCP servers on ` +
        `http://${urlHost(egressHostname)}:${egressToolPort}`,
    );
    if (egressAllowPrivate) {
      log.info("RYPH_EGRESS_ALLOW_PRIVATE does not apply to hosted MCP servers' listener");
    }
  }

  // The gate dials `host.docker.internal` unless told otherwise. Docker Desktop (and OrbStack)
  // deliver that to this machine's loopback, so loopback listeners are right there — but a native
  // Linux daemon maps it to the docker bridge's address, where a loopback-bound listener does not
  // answer. Asked of the
  // machine, not the engine: only when the bridge's gateway is one of this machine's addresses
  // (`localBridgeGateway`) — or, with no daemon to ask, on Linux at all. Said once, rather than
  // widened here: on Linux that bind is the operator's to choose.
  if (
    dockerLauncher?.embedded && runGate !== null && gateTarget === null &&
    (bridgeGateway !== null || (engine === null && process.platform === "linux"))
  ) {
    const shut = [
      ...(app.mcpGatewayHandler && isLoopbackHost(mcpHostname) ? ["RYPH_MCP_GATEWAY_HOST"] : []),
      ...((egressKey !== null || toolEgressOn) && isLoopbackHost(egressHostname)
        ? ["RYPH_EGRESS_BIND"]
        : []),
    ];
    if (shut.length > 0) {
      log.warn(
        `confined docker runs reach this process through the run gate at host.docker.internal, ` +
          `which a Linux daemon maps to the docker bridge — not loopback, where ${
            shut.join(" and ")
          } still bind${shut.length === 1 ? "s" : ""}. Bind them to the bridge's address${
            bridgeGateway === null ? "" : ` (${bridgeGateway})`
          }.`,
      );
    }
  }
  // The egress relay dials the tool listener at `host.docker.internal` too, confined runs or not,
  // so an unconfined deployment on a Linux daemon hears the same warning for it.
  if (
    dockerLauncher?.embedded && toolEgressOn && runGate === null && gateTarget === null &&
    (bridgeGateway !== null || (engine === null && process.platform === "linux")) &&
    isLoopbackHost(egressHostname)
  ) {
    log.warn(
      `hosted MCP servers reach the egress proxy's tool listener at host.docker.internal, which ` +
        `a Linux daemon maps to the docker bridge — not loopback, where RYPH_EGRESS_BIND still ` +
        `binds. Bind it to the bridge's address${
          bridgeGateway === null ? "" : ` (${bridgeGateway})`
        }, or no hosted server reaches its vendor's API.`,
    );
  }
  // A gate relaying to this process as a container (RYPH_DOCKER_GATE_TARGET, or a launcher
  // elsewhere whose routes name this process's ports on a container) dials it on the deployment
  // network, where a loopback listener answers nobody: refused, since every confined run would
  // boot and then fail to call home.
  if (dockerLauncher !== null && gateTarget !== null) {
    const shut = [
      ...(binds.every(isLoopbackHost) ? ["RYPH_BIND"] : []),
      ...(app.mcpGatewayHandler && isLoopbackHost(mcpHostname) ? ["RYPH_MCP_GATEWAY_HOST"] : []),
      ...((egressKey !== null || toolEgressOn) && isLoopbackHost(egressHostname)
        ? ["RYPH_EGRESS_BIND"]
        : []),
    ];
    if (shut.length > 0) {
      fail(
        `${
          dockerLauncher.embedded === null
            ? `the docker launcher's run gate relays to ${gateTarget}`
            : `RYPH_DOCKER_GATE_TARGET=${gateTarget}`
        }: the run gate dials this process on ` +
          `${dockerLauncher.info.network}, but ${shut.join(", ")} leave${
            shut.length === 1 ? "s" : ""
          } its listener on loopback. Set ${shut.length === 1 ? "it" : "them"} to 0.0.0.0.`,
      );
    }
  }

  // The run gate is the launcher's to make, and it makes it at its own boot, saying how that went
  // in its own log lines (launcher), so nothing here runs docker for it.

  // What `serveExtra`'s stop asked to exit with, and the drain it starts once there is one.
  let stopCode: number | null = null;
  let stopping = false;
  let drain: (() => Promise<void>) | null = null;
  const extra = opts.serveExtra?.({
    stop: (code) => {
      if (stopCode !== null) return;
      stopCode = code;
      // A drain already under way exits with this code; it is not begun twice.
      if (!stopping) void drain?.();
    },
  }) ?? null;

  // How this instance is claimed. Single-user, the owner exists from the first boot, named from
  // git where it can be — the account page edits both later — and signs in by a login link.
  // Multi-user and unclaimed, the first registration needs the token printed here.
  let loginLink: string | null = null;
  if (!multiUser && !authDisabled) {
    const minted = await ownerLoginLink(app.auth, ownerDefaults);
    if (minted.ok) loginLink = minted.link;
    else log.warn(`no login link: ${loginLinkFailure(minted.error)}`);
    // The binary's status block shows the link, and `ryph login` mints another. A root with
    // neither (`bun run up`, ./dev) has only this line: the owner has no password and nobody
    // may register, so on a fresh database it is the one way in. Warn, like the setup token
    // below, so a quieter log level still prints it.
    if (loginLink !== null && opts.onReady === undefined) {
      const assumed = appUrl === null
        ? `; RYPH_APP_URL is unset, so it assumes ./dev's UI at ${DEV_APP_URL}`
        : "";
      log.warn(
        `sign in as the owner: ${loginLink} (single use, good for 10 minutes; restart for ` +
          `another${assumed})`,
      );
    }
  }
  // With the user surface open nobody signs in, so there is no first account to claim.
  const setupToken = authDisabled ? null : app.auth.setupToken;
  if (setupToken !== null) log.warn(setupTokenNotice(setupToken, appUrl));

  // How an in-process forge acts on GitHub and GitLab, for both summaries: "github (as @login)"
  // when it is one person's token, "gitlab (as @login at host)" always. A remote forge says so in
  // its own boot line.
  const forgeGithub = embeddedForge?.github ?? null;
  const forgeGitlab = embeddedForge?.gitlab ?? null;
  const forgesNamed = embeddedForge?.forges.map((p) => forgeLabel(p, forgeGithub, forgeGitlab)) ??
    [];

  // Who an in-process bridge signs as, for both summaries: `did:key:…(alias)`.
  const radicleSummary: RadicleSummary | null = embeddedRadicle === null ? null : {
    did: embeddedRadicle.identity?.did ?? null,
    alias: embeddedRadicle.identity?.alias ?? null,
    home: embeddedRadicle.home,
    // Asked of the node itself, not read off the identity: an identity `rad self` could not
    // read says nothing about whether the node is up.
    nodeRunning: embeddedRadicle.nodeRunning,
  };

  // A one-line boot summary of the composed deployment: every mounted module and the state it
  // resolved to. The listening lines above are the open sockets; this is the wiring behind them,
  // so one glance at startup answers what is on and configured against what.
  log.info("composition", {
    "@ryph/orchestrator": `http://127.0.0.1:${port} · store=${dbDescription} · provisioner=${
      dockerLauncher !== null
        ? `docker · image=${agentImage}${
          dockerLauncher.info.runNetwork === null
            ? " · unconfined"
            : ` · confined to ${dockerLauncher.info.runNetwork} via ${dockerLauncher.info.gate}`
        } · launcher=${dockerLauncher.embedded === null ? dockerLauncher.url : "in-process"}`
        : provisionerKind
    }`,
    "@ryph/auth": authDisabled
      ? "OPEN — RYPH_AUTH=off"
      : `on · mail=${
        smtp === null ? "off — links shown to admins" : smtp.url.replace(/\/\/.*@/, "//…@")
      }`,
    "@ryph/model-proxy": app.proxyHandler
      ? `http://127.0.0.1:${proxyPort}`
      : "off — no RYPH_SECRETS_KEY",
    "egress-proxy": `${
      egressServer === null ? "off — no RYPH_EGRESS_KEY" : `http://127.0.0.1:${egressPort}`
    }${egressToolServer === null ? "" : ` · hosted servers :${egressToolPort}`}`,
    "@ryph/mcp-gateway": app.mcpGatewayHandler
      ? `http://${urlHost(mcpHostname)}:${mcpPort}`
      : "off — no RYPH_MCP_KEY, and no RYPH_SECRETS_KEY to default to",
    "@ryph/historian": historyUrl
      ? `remote ${historyUrl}`
      : `in-process · store=${historyDbDescription ?? dbDescription}`,
    "@ryph/memory": memoryUrl
      ? `remote ${memoryUrl}`
      : `in-process · store=${dbDescription} · tools=${
        app.mcpGatewayHandler ? "through the gateway" : "off — no gateway"
      }`,
    "@ryph/chat": chatUrl
      ? `remote ${chatUrl}`
      : app.chat === null
      ? "off — no RYPH_CHAT_KEY, and no RYPH_SECRETS_KEY to default to"
      : `in-process · store=${dbDescription} · tool=${
        app.mcpGatewayHandler ? "through the gateway" : "off — no gateway"
      }`,
    "@ryph/forge": forge === null
      ? "off — no RYPH_FORGE_URL"
      : `${forge.kind === "noop" ? "noop — recording fake" : forge.url}${
        embeddedForge === null
          ? ""
          : ` · in-process · data=${embeddedForge.dataDir} · forges=${
            forgesNamed.join(", ") || "none"
          } · local=${localRoot ?? "off"}`
      } · gateway=${gitGatewayUrl ?? "off"}`,
    "@ryph/radicle": radicleSummary === null
      ? "not in this process — RYPH_RADICLE_URL is not `embedded`"
      : `in-process · user mode as ${radicleSummary.did ?? "an unreadable identity"}${
        radicleSummary.alias === null ? "" : ` (${radicleSummary.alias})`
      } · home=${radicleSummary.home} · node=${
        radicleSummary.nodeRunning ? "running" : "NOT running"
      } · ${embeddedRadicle!.url}`,
    ...(extra === null ? {} : { "@ryph/app": extra.describe }),
  });

  opts.onReady?.({
    controlPlaneUrl: `http://127.0.0.1:${port}`,
    modelProxyUrl: app.proxyHandler ? `http://127.0.0.1:${proxyPort}` : null,
    mcpGatewayUrl: app.mcpGatewayHandler ? `http://${urlHost(mcpHostname)}:${mcpPort}` : null,
    db: dbDescription,
    historyDb: historyDbDescription,
    historyRemote: historyUrl,
    authDisabled,
    provisioner: provisionerKind,
    agentImage,
    forge: forge === null
      ? null
      : forge.kind === "noop"
      ? "noop — recording fake"
      : embeddedForge !== null
      ? `in-process on :${forgePort} · ${forgesNamed.join(", ") || "no forge wired"}`
      : forge.url,
    forgeProviders: embeddedForge?.forges ?? null,
    forgeGithub,
    forgeGitlab,
    forgeLocalRoot: localRoot,
    radicle: radicleSummary,
    gitGateway: gitGatewayUrl,
    extra: extra?.describe ?? null,
    loginLink,
    setupToken,
    environments: app.environments === null
      ? null
      : { builder: environments.builder, refused: app.environments.refusedReason },
    checks: app.checks === null ? null : { refused: app.checks.refusedReason },
  });

  // What `beforeStop` is shown, gathered on the first signal while everything still serves.
  const beforeStop = opts.beforeStop;
  const beforeDrain = beforeStop === undefined
    ? undefined
    : async (signal: NodeJS.Signals | undefined, interrupted: AbortSignal) => {
      stopping = true;
      // A listener that failed has nothing to ask: the drain goes ahead, runs keep going.
      if (stopCode !== null) return;
      const active = (await app.store.listActiveRuns())
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const hosted = hosting === null ? [] : await hosting.live();
      const decision = await beforeStop({
        signal,
        runs: active.map((run) => ({
          id: run.id,
          // Null only while the task waits for its first message.
          title: run.workItem.spec.title ?? "(waiting for instructions)",
          agent: run.workItem.agent.name,
          createdAt: run.createdAt,
        })),
        hostedServers: hosted.map((s) => s.name),
        heartbeatTimeoutMs: sweepCfg.heartbeatTimeoutMs,
        cancelRuns: (onProgress) => cancelAndWait(app, active, interrupted, onProgress, log),
        interrupted,
      });
      // A listener that failed while this asked still ends the process.
      if (stopCode !== null) return;
      if (decision === "keep-running" && !interrupted.aborted) stopping = false;
      return decision;
    };

  // One signal drains: unready first, then every socket, then the reaper, the hosted containers,
  // and the databases. In-flight requests finish inside the deadline; runs in containers keep
  // going and report to the next boot, unless `beforeStop` cancelled them.
  drain = installDrain({
    servers: [
      { name: "control plane", server, streams },
      { name: "model proxy", server: proxyServer, streams: proxyStreams },
      { name: "mcp gateway", server: mcpServer, streams: mcpStreams },
      { name: "forge", server: embeddedForge?.server },
      { name: "radicle", server: embeddedRadicle?.server },
      { name: "app", server: extra },
    ],
    // SIGHUP too: closing the terminal a local deployment runs in is the most common way it
    // stops, and unhandled it kills the process mid-write — no database close, no container stop.
    signals: ["SIGINT", "SIGTERM", "SIGHUP"],
    beforeDrain,
    beginDrain: () => {
      stopping = true;
      lateBind.abort();
      app.health.beginDrain();
      void artifactThumbnail.shutdown();
      app.closePreviews();
      embeddedForge?.beginDrain();
      embeddedRadicle?.beginDrain();
    },
    close: async () => {
      clearInterval(reaper);
      clearInterval(envReconciler);
      clearInterval(skillsReconciler);
      // Not in `servers` above: that list drains serve() handles and this is a node:http
      // server, which closes differently. Nothing in flight here is a request this process owes
      // an answer to — it is a byte pipe — so closing the listener is the whole job.
      egressServer?.close();
      egressToolServer?.close();
      clearInterval(automationsTicker);
      clearInterval(accessRefresher);
      if (chatPoller !== null) clearInterval(chatPoller);
      polling.abort();
      if (supervisor !== null) clearInterval(supervisor);
      if (consolidator !== null) clearInterval(consolidator);
      if (memoryBackfill !== null) clearInterval(memoryBackfill);
      clearInterval(authSweeper);
      // Hosted servers do NOT outlive the process: nothing they hold survives it (the guard's
      // token, the caller tokens), so the next boot relaunches them regardless. Before the
      // databases close — the stop reads which rows are live.
      if (hosting !== null) {
        hostingStopped = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          hosting.shutdown().then(() => "stopped", (err) => `failed: ${err}`),
          new Promise<string>((
            r,
          ) => (timer = setTimeout(() => r("timed out"), HOSTING_SHUTDOWN_MS))),
        ]);
        clearTimeout(timer);
        if (outcome !== "stopped") {
          // Never a reason to skip closing the database: the next boot replaces them by name.
          log.warn(`hosted MCP containers not all stopped (${outcome})`);
        }
      }
      await artifactThumbnail.shutdown();
      await app.closePlanListener?.();
      await app.drainMemory?.();
      // The model's thread ended and gone before the exit: see worker_embedder.ts's terminated.
      await memoryEmbedder?.close();
      // The Lease given up, bounded and never throwing; a crash leaves it to expire instead.
      await app.capacity?.stop();
      app.close();
      await embeddedForge?.close();
      // Its consumer writes cursors into the cluster, so it stops before the cluster closes.
      await embeddedRadicle?.close();
      // Last of the listeners, and not in `servers`: the hosted containers above are stopped
      // THROUGH it, and the reaper's last kill may be too. Closing it stops any build it runs.
      await dockerLauncher?.embedded?.close();
      await cluster.close();
      await historyCluster?.close();
    },
    // PGlite holds its data directory open, and a half-written one is the thing a local user
    // cannot re-create. So the deadline here is about closing the database cleanly, not about
    // a load balancer — there is none.
    deadlineMs: intEnv("RYPH_DRAIN_DEADLINE_MS", 25_000),
    log,
    exit: (code) => process.exit(stopCode ?? code),
  });
  // A listener that failed before the drain existed.
  if (stopCode !== null) void drain();
}

if (import.meta.main) {
  await main();
}

// `ryph setup` — the questions a fresh install cannot answer for you, asked once.
//
// WHY THIS EXISTS. A first launch used to start, print a status block with three warnings, and
// leave you to work out that the fixes were environment variables you had to discover, get right,
// and then re-export in every shell afterwards. Two of those warnings — no agent runner, no way to
// reach a repository — mean nothing you create will actually do anything, and both are invisible
// until you create a task and watch it sit there. Everything else about this binary provisions
// itself; these were the only three questions left, so this asks them.
//
// WHAT IT IS NOT. It is not a config UI and it does not grow: three questions, each one a thing
// the machine genuinely cannot decide. Anything with a sane default keeps its default and stays
// out of here, and the long tail stays where it is — `ryph --help`, and the settings file the
// wizard writes, which is a plain list of the same variables and is meant to be edited by hand.
//
// THE ANSWERS GO TO TWO PLACES, and the split is deliberate. The master key goes where a master
// key already goes — `~/.ryph/secrets.key`, owner-only, never in a backup — so there stays
// exactly one place to look for it and one story about why backups are safe to copy. Everything
// else goes to `~/.ryph/config.env` as the same RYPH_* variables everything else uses.

import { stat } from "node:fs/promises";
import { type Child, command as runCommand } from "@ryph/process";
import { isAbsolute, resolve } from "@std/path";
import { multiUserFromEnv } from "@ryph/auth";
import { parseDbUrl } from "@ryph/db";
import {
  defaultRunNetwork,
  ensureRunNetwork as ensureDockerRunNetwork,
  gateName,
  localBridgeGateway,
} from "@ryph/orchestrator";
import {
  bakedImageTag,
  defaultImage,
  EDGE_TAG,
  IMAGE_REGISTRY,
  publishedTag,
  SEMVER,
} from "@ryph/host";
import { configPath, defaultLocalRepoRoot, updateConfig } from "./config_file.ts";
import {
  isSecretsKey,
  mintHexKey,
  mintSecretsKey,
  readSecretsKey,
  secretsKeyPath,
  storeSecretsKey,
} from "./secrets_key.ts";
import { Cancelled, type Choice, maskUrl, NeedsAnswer, type Prompter } from "./prompt.ts";
import { askGitlab, glabTokenCommand } from "./setup_gitlab.ts";

/**
 * The one image every run launches on. It carries every harness ryph ships — pi, and `echo`, the
 * runner's built-in no-model harness — so there is one question here, not one per harness kind.
 */
const AGENT_IMAGE = "RYPH_AGENT_IMAGE";

/** The browser sidecar an agent with one gets beside its run (images/browser). */
const BROWSER_IMAGE = "RYPH_BROWSER_IMAGE";

/** The images this wizard offers, by their short names. */
export type OfferedImage = "agent" | "browser" | "run-gate";

/** An image to offer, and where it came from, said beside the question. */
export interface ImageSuggestion {
  image: string;
  from: "configured" | "local build" | "published";
}

/**
 * Which image `name` is offered as. In a binary pinned to its commit's images
 * (`ctx.imagesPinned`): what the settings name, unless that is one of ryph's published images (an
 * older binary's pin), else the published one; local builds are never offered, since they are not
 * this binary's. Otherwise: what the settings already name; else a local `ryph-<name>:dev`
 * (a developer's `bun run agent-image`); else the published one this binary was built beside; else
 * any other local `ryph-<name>` tag. Null when there is none of those.
 *
 * `configuredMustExist` is the run gate's rule: a configured gate image is kept only while it is
 * still local or is the published one, because confinement is offered only where a gate exists.
 */
export function suggestImage(
  name: OfferedImage,
  ctx: Pick<SetupContext, "current" | "publishedImages" | "imagesPinned">,
  local: string[],
  setting: string,
  configuredMustExist = false,
): ImageSuggestion | null {
  const published = ctx.publishedImages?.[name];
  const current = ctx.current.get(setting);
  if (ctx.imagesPinned && published !== undefined) {
    const own = current !== undefined && !staleImage(name, current) &&
      (!configuredMustExist || local.includes(current));
    return own ? { image: current, from: "configured" } : { image: published, from: "published" };
  }
  if (
    current !== undefined &&
    (!configuredMustExist || local.includes(current) || current === published)
  ) {
    return { image: current, from: "configured" };
  }
  const dev = `ryph-${name}:dev`;
  if (local.includes(dev)) return { image: dev, from: "local build" };
  if (published !== undefined) return { image: published, from: "published" };
  const other = local.find((image) => image.startsWith(`ryph-${name}:`)) ?? local[0];
  return other === undefined ? null : { image: other, from: "local build" };
}

/**
 * Whether a configured image is one an earlier setup wrote rather than a choice of yours: a
 * published release's or commit's image (`0.1.0`, `sha-<12>`: an older binary's pin) or a local
 * `ryph-<name>` build (which earlier setups preferred). A pinned binary uses its own images over
 * either.
 */
function staleImage(name: OfferedImage, image: string): boolean {
  const published = `${IMAGE_REGISTRY}/ryph-${name}:`;
  if (image.startsWith(published)) {
    const tag = image.slice(published.length);
    return SEMVER.test(tag) || EDGE_TAG.test(tag);
  }
  return image.startsWith(`ryph-${name}:`);
}

/** RYPH_BROWSER_IMAGE's value for no browser: unset means the binary's published one. */
const NO_BROWSER = "off";

/** Says when the environment overrides `setting`, which the host reads before config.env. */
function sayOverride(io: Prompter, ctx: SetupContext, setting: string): void {
  const value = ctx.environment?.[setting];
  if (value) io.say(`${setting} in your environment overrides this: ${value}.`);
}

/**
 * The setting to write for `image`: none for this binary's own published image, so the default
 * (which follows the binary) applies.
 */
function imageSetting(ctx: SetupContext, name: OfferedImage, image: string): string | null {
  return ctx.imagesPinned && image === ctx.publishedImages?.[name] ? null : image;
}

/** Says which image is offered and why, so taking the default is an informed `⏎`. */
function sayPicked(io: Prompter, picked: ImageSuggestion | null): void {
  if (picked === null) return;
  const why = {
    configured: "what your settings name",
    "local build": "built on this machine",
    published: "published for this version of ryph; docker pulls it on first use",
  }[picked.from];
  io.say(`Offering ${picked.image} — ${why}.`);
}

/** Whether a local container backend is usable here, and what to say when it is not. */
export type BackendStatus =
  | { available: true; version: string }
  | {
    available: false;
    reason: string;
    /** The command that fixes it. "Not installed" and "installed but not running" need
     * different ones, and offering the wrong fix is worse than offering none. */
    fix?: string;
  };

/**
 * Raised when setup cannot produce a deployment that runs anything: no docker to run agents in,
 * or no agent image to run them on. Nothing is written — a config that boots but never starts a
 * run is worse than none, because nothing says why a task sits there. The message says what to
 * fix.
 */
export class SetupStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupStopped";
  }
}

/** Everything the wizard needs to know about this machine, gathered before a question is asked. */
export interface SetupContext {
  dbUrl: string;
  /** A key the environment supplies; the wizard has nothing to decide and says so. */
  keyFromEnv: boolean;
  /** Where a key is already stored, or null when there is none yet. */
  storedKeyPath: string | null;
  /** Where a key COULD be stored — null for postgres://, which has no local directory to pair. */
  storableKeyPath: string | null;
  docker: BackendStatus;
  /** `ryph-agent` images already built in docker's store. */
  agentImages: string[];
  /** `ryph-browser` images in docker's store — the only backend that launches one locally. */
  browserImages: string[];
  /**
   * `ryph-run-gate` images in docker's store. A confined docker run reaches ryph only through
   * the gate (images/run-gate), so docker offers `confined` only where one is built.
   */
  gateImages: string[];
  /**
   * The published images this binary was built beside (@ryph/host's images.ts), offered when no
   * local `:dev` build is there; absent from source, which has none of its own.
   */
  publishedImages?: Partial<Record<OfferedImage, string>>;
  /**
   * Whether `publishedImages` are this binary's own release's (`0.1.0` or `sha-<12>`), not `edge`. Then they
   * are the images, not an offer: no question, and nothing written, so a binary upgraded later
   * moves to its own.
   */
  imagesPinned?: boolean;
  /** The image settings the environment sets, which the host reads before config.env. */
  environment?: Partial<Record<string, string>>;
  /** RYPH_DOCKER_NETWORK as this launch resolves it — the deployment the gate is named for. */
  dockerNetwork?: string;
  /**
   * The default docker bridge's gateway address when it is one of THIS machine's own addresses —
   * a native Linux engine — and null otherwise: Docker Desktop and OrbStack, and equally Colima,
   * Rancher Desktop or rootless docker, whose bridge lives in a VM or namespace this machine has
   * no address on (or docker not answering). It is where `host.docker.internal` lands on a native
   * engine, so the listeners a container dials there must bind it rather than loopback.
   */
  dockerBridgeGateway?: string | null;
  /** The ports a container must dial this process on, so the wizard can write those addresses. */
  apiPort: number;
  proxyPort: number;
  egressPort: number;
  mcpPort: number;
  /**
   * Whether a key for signing run allowlists already exists. One is minted when it does not,
   * rather than asked for: unlike the master key it seals nothing and grants only hostnames, so
   * losing it costs the in-flight run tokens and nothing else.
   */
  egressKeyPresent: boolean;
  /**
   * Makes the internal network confined docker runs join, if it is missing, and answers whether it can confine runs — internal, and on a Linux engine with no
   * gateway left on the host — or why not. No address comes back, because under docker a confined
   * run reaches ryph at the run gate's name, not a gateway. Undefined where docker is not answering.
   */
  confineDockerRuns?: (
    network: string,
  ) => Promise<{ confined: true } | { confined: false; why: string }>;
  /** Whether `gh auth token` prints a token here, so the GitHub CLI's login can be offered. */
  githubCli: boolean;
  /**
   * The glab command that prints a token for a GitLab instance (its URL) here, or null when glab
   * has no login for its host. A function, because the instance is only known once the wizard
   * has asked for it. Absent: no glab to ask, and the GitLab question offers only a pasted token.
   */
  gitlabCli?: (instance: string) => Promise<string | null>;
  /**
   * The Radicle identity `rad self` reads here (RAD_HOME, default ~/.radicle), so acting as it
   * can be offered. Absent or null: no `rad` on PATH, or no identity — and no question.
   */
  radicle?: { did: string; alias: string | null } | null;
  /** What the settings file says today, so a re-run offers the current answers back. */
  current: Map<string, string>;
  /**
   * RYPH_MULTIUSER as this launch resolves it. Mail is asked about only then: alone, the owner
   * signs in by a login link and nobody registers, is invited or resets a password.
   */
  multiUser?: boolean;
}

export type KeyDecision =
  | { action: "keep" }
  | { action: "skip" }
  | { action: "store"; hex: string; minted: boolean };

/** What the answers came to. Nothing is written until `applySetup` gets one of these. */
export interface SetupPlan {
  key: KeyDecision;
  /** Settings to write; a null value removes the key from the file. */
  config: Map<string, string | null>;
  /** What to tell the person afterwards — the things that will bite, in the order they will. */
  notes: string[];
}

/**
 * The questions. Takes its terminal and its machine as arguments so the decisions can be tested
 * without either — the same seam `describeDeployment` uses for the status block.
 */
export async function runWizard(io: Prompter, ctx: SetupContext): Promise<SetupPlan> {
  const config = new Map<string, string | null>();
  const notes: string[] = [];

  const steps = [
    "🔑 Master key",
    "🏃 Agent runner",
    "📦 Repositories",
    ...(ctx.multiUser ? ["✉️ Mail"] : []),
  ];
  const step = (n: number) => `${n}/${steps.length}  ${steps[n - 1]}`;

  // Docker is the only provisioner a local install runs agents on (`kubernetes` is a deployment
  // concern, and `manual` launches nothing). Without it there is no answer to question 2 that
  // works, so stop before asking anything rather than after the master key.
  if (!ctx.docker.available) {
    throw new SetupStopped(
      `Ryph runs agents in docker, and docker is not usable here: ${unavailable(ctx.docker)}. ` +
        "Fix that, then run `ryph setup` again.",
    );
  }

  io.say();
  io.say(
    `Welcome to Ryph! ${steps.length === 4 ? "Four" : "Three"} quick questions before you get ` +
      "started.",
  );
  io.say("💡 Re-launch the setup wizard anytime with `ryph setup`.");

  // ── 1. The master key ────────────────────────────────────────────────────────────────────────
  io.heading(step(1));
  const key = await askKey(io, ctx);

  // ── 2. The agent runner ──────────────────────────────────────────────────────────────────────
  io.heading(step(2));
  await askRunner(io, ctx, config, notes);

  // ── 3. Repositories ──────────────────────────────────────────────────────────────────────────
  io.heading(step(3));
  await askRepositories(io, ctx, config, notes);

  // ── 4. Mail ──────────────────────────────────────────────────────────────────────────────────
  if (ctx.multiUser) {
    io.heading(step(4));
    await askMail(io, ctx, config);
  }

  return { key, config, notes };
}

async function askKey(io: Prompter, ctx: SetupContext): Promise<KeyDecision> {
  if (ctx.keyFromEnv) {
    io.say("RYPH_SECRETS_KEY is set in this environment — nothing to decide.");
    return { action: "keep" };
  }

  io.say(
    "The master key seals AI provider keys and MCP server credentials, and isn't included in backups.",
  );

  const where = ctx.storableKeyPath ?? configPath();
  const stored = ctx.storedKeyPath !== null;
  type KeyChoice = "keep" | "mint" | "paste" | "skip";
  const orphans = "every key sealed with the old one becomes unreadable";
  const choices: Choice<KeyChoice>[] = stored
    ? [
      { label: "keep it", hint: "the provider keys it sealed stay readable", value: "keep" },
      { label: "mint a new one", hint: orphans, value: "mint" },
      { label: "paste your own", hint: `64 hex characters; ${orphans}`, value: "paste" },
    ]
    : [
      {
        label: "mint one now",
        hint: where ? `stored at ${where}` : "kept for this launch only",
        value: "mint",
      },
      { label: "paste your own", hint: "64 hex characters", value: "paste" },
      { label: "skip", hint: "model access stays off until one exists", value: "skip" },
    ];
  if (stored) io.say(`There is already one at ${ctx.storedKeyPath}.`);
  const choice = await io.select(
    stored
      ? "Keep it?"
      : "Should we generate a key for you now, or would you like to supply your own?",
    choices,
    0,
    { id: "key" },
  );

  if (choice === "keep") return { action: "keep" };
  if (choice === "skip") return { action: "skip" };
  // Said before the key is asked for, not after it is written: this is the one answer in the
  // wizard that destroys something, and it destroys it silently — the provider keys keep
  // working right up until a run needs one.
  if (stored) io.say("Anything sealed with the old key will have to be deleted and re-added.");
  if (choice === "mint") return { action: "store", hex: mintSecretsKey(), minted: true };

  const hex = await io.secret("key (not echoed)", { id: "key-value" });
  // Stopped rather than minted instead: with a key already stored, a fresh one in its place
  // makes everything the old one sealed unreadable, over a typo.
  if (!isSecretsKey(hex)) {
    throw new SetupStopped("That key is not 64 hex characters, so nothing was changed.");
  }
  return { action: "store", hex: hex.trim().toLowerCase(), minted: false };
}

/** An unusable backend, said with the command that fixes it. */
function unavailable(status: Extract<BackendStatus, { available: false }>): string {
  return status.fix ? `${status.reason} — ${status.fix}` : status.reason;
}

async function askRunner(
  io: Prompter,
  ctx: SetupContext,
  config: Map<string, string | null>,
  notes: string[],
): Promise<void> {
  // runWizard has already stopped where docker does not answer.
  if (ctx.docker.available) io.say(`Agents run in docker (detected: ${ctx.docker.version}).`);

  const built = ctx.agentImages;
  const picked = suggestImage("agent", ctx, built, AGENT_IMAGE);

  io.say();
  if (ctx.imagesPinned && picked?.from === "published") {
    // This binary's own images: nothing to choose.
    io.say(`Agents run in ${picked.image}; docker pulls it on first use.`);
    sayOverride(io, ctx, AGENT_IMAGE);
    config.set("RYPH_PROVISIONER", "docker");
    config.set(AGENT_IMAGE, null);
    return await afterAgentImage(io, ctx, config, notes);
  }
  io.say("The agent image — one for every harness.");
  if (built.length > 0) io.say(`Found on this machine: ${built.join(", ")}`);
  // From the workspace root, not the Dockerfile's directory: the harness layer copies the
  // lockfile and the shared import map, and neither is under images/.
  if (ctx.publishedImages?.agent === undefined) {
    io.say("Build one from a checkout of ryph with: bun run agent-image");
  }
  sayPicked(io, picked);
  io.say();

  const image = await io.ask("agent image — pi, and the built-in no-model `echo` harness", {
    id: "agent-image",
    ...(picked ? { default: picked.image } : {}),
    optional: true,
  });

  // The host REFUSES TO START on docker with no image at all, and with no provisioner too, so
  // there is nothing to write that would boot into a deployment able to run anything. Setup stops
  // here instead, having written nothing, and says how to get an image.
  if (!image) {
    throw new SetupStopped(
      "No agent image, so no agent could run. Build one from a checkout of ryph with " +
        "`bun run agent-image` (or pull one), then run `ryph setup` again and name it " +
        "(`--agent-image <image>` without a terminal).",
    );
  }

  config.set("RYPH_PROVISIONER", "docker");
  config.set(AGENT_IMAGE, imageSetting(ctx, "agent", image));
  await afterAgentImage(io, ctx, config, notes);
}

/** The rest of the runner's questions, once docker has an agent image. */
async function afterAgentImage(
  io: Prompter,
  ctx: SetupContext,
  config: Map<string, string | null>,
  notes: string[],
): Promise<void> {
  // On by default under docker (buildsDefault). Said, not a note: it is no caveat, but the disk
  // it takes is worth knowing before the first build.
  if (ctx.current.get("RYPH_ENVIRONMENTS") !== "off") {
    io.say();
    io.say(
      "Environment builds are on: each repo gets an image with its setup done, so runs start " +
        "ready. Several GB of disk per repo; RYPH_ENVIRONMENTS=off turns them off.",
    );
  }
  await askBrowser(io, ctx, config, notes);
  const egress = await askEgress(io, ctx, config, notes);
  writeContainerAddresses(ctx, config, notes, egress);
}

/**
 * The browser image.
 *
 * Offered the way the agent image is (`suggestImage`): a local build, or the published one this
 * binary was built beside, never a name guessed at. Empty is no browser, said in a note,
 * because an agent switched to a browser would otherwise start every run without one and only its
 * run history would say why.
 */
async function askBrowser(
  io: Prompter,
  ctx: SetupContext,
  config: Map<string, string | null>,
  notes: string[],
): Promise<void> {
  io.say();
  if (ctx.imagesPinned && ctx.current.get(BROWSER_IMAGE) === NO_BROWSER) {
    io.say(`No browser for agents (${BROWSER_IMAGE}=${NO_BROWSER} in ${configPath()}).`);
    return;
  }
  const picked = suggestImage("browser", ctx, ctx.browserImages, BROWSER_IMAGE);
  if (ctx.imagesPinned && picked?.from === "published") {
    io.say(`Agents you give a browser get ${picked.image}.`);
    io.say(`${BROWSER_IMAGE}=${NO_BROWSER} in ${configPath()} turns browsers off.`);
    sayOverride(io, ctx, BROWSER_IMAGE);
    config.set(BROWSER_IMAGE, null);
    return;
  }
  io.say("The browser image — a browser for agents you give one.");
  sayPicked(io, picked);
  // With a default, an empty answer takes it: `off` is how to say none.
  const image = await io.ask(
    picked
      ? `browser image — ${NO_BROWSER} for no browser`
      : "browser image — leave empty for no browser",
    {
      id: "browser-image",
      ...(picked ? { default: picked.image } : {}),
      optional: true,
    },
  );
  if (!image || image === NO_BROWSER) {
    // Unset would mean the published browser in a binary, so none is said outright there.
    config.set(BROWSER_IMAGE, ctx.publishedImages?.browser ? NO_BROWSER : null);
    notes.push(
      ctx.publishedImages?.browser
        ? "no browser, so no agent gets one. Re-run `ryph setup` to turn browsers back on."
        : "no browser image, so no agent gets a browser. Build it with `bun run agent-image`, " +
          "then re-run `ryph setup`.",
    );
    return;
  }
  config.set(BROWSER_IMAGE, imageSetting(ctx, "browser", image));
}

/** The run gate image docker would launch (`suggestImage`'s order). Null when there is none, and
 * confined is not offered on docker then. */
function gateImage(ctx: SetupContext): string | null {
  return suggestImage("run-gate", ctx, ctx.gateImages, "RYPH_DOCKER_GATE_IMAGE", true)?.image ??
    null;
}

type EgressChoice = "confined" | "allowlisted" | "direct";

/**
 * How much of the internet a run gets.
 *
 * Still question 2 — it is the runner's network, asked where the runner is chosen, next to the
 * image questions rather than as a fourth step. What makes it worth asking at all is that the
 * wrong answer is silent: a run that can reach everything looks exactly like a run that cannot
 * until the day it matters.
 *
 * THE ANSWER DECIDES AN ADDRESS, which is why it cannot be left to a default. The proxy runs
 * inside this process, and a container cannot reach this process on loopback — so a proxy URL
 * written without moving the bind is an address nothing can dial, and every setup step fails on
 * a boundary that was supposed to be cooperative. The two are written together or neither is.
 */
async function askEgress(
  io: Prompter,
  ctx: SetupContext,
  config: Map<string, string | null>,
  notes: string[],
): Promise<EgressChoice> {
  // Docker confines through the run gate, so only where a gate image is built.
  const gate = gateImage(ctx);
  // Named for the deployment, like its gate.
  const runNetwork = defaultRunNetwork({ network: ctx.dockerNetwork });
  const canConfine = ctx.confineDockerRuns !== undefined && gate !== null;

  io.say();
  io.say(
    "Agent internet access. A run installs dependencies, so it needs some — the question is " +
      "whether it can reach anything else.",
  );

  const options: { label: string; hint: string; value: EgressChoice }[] = [];
  if (canConfine) {
    options.push({
      label: "confined",
      hint: `runs join the internal \`${runNetwork}\` network and reach ryph only through the ` +
        `run gate: the allowlist is the only way out`,
      value: "confined",
    });
  }
  options.push({
    label: "allowlisted",
    hint: canConfine
      ? "setup steps go through the proxy, but a run's own code can ignore it"
      : "setup steps go through the proxy, but a run's own code can ignore it — build the run " +
        "gate with `bun run agent-image` to confine runs",
    value: "allowlisted",
  });
  options.push({
    label: "direct",
    hint: "runs reach the whole internet, and no allowlist is claimed",
    value: "direct",
  });

  const choice = await io.select("Internet access", options, 0, { id: "egress" });

  // CLEARED BEFORE ANYTHING IS WRITTEN, because `updateConfig` only touches the keys this map
  // carries: a second run of the wizard that moves confined → allowlisted → direct would
  // otherwise leave the PREVIOUS answer's settings in place beside the new one. The worst of
  // those is RYPH_DOCKER_RUN_NETWORK surviving a downgrade to `open` — runs keep launching onto
  // an internal network with no default route while the deployment reads as unconfined, so they
  // are handed no proxy either and every install hangs with nothing to blame. Null is delete (the
  // idiom the image questions above use); the branches below write back whichever of these their
  // own answer actually means.
  for (
    const key of [
      "RYPH_DOCKER_RUN_NETWORK",
      "RYPH_DOCKER_GATE_IMAGE",
      "RYPH_EGRESS_PROXY_URL",
      "RYPH_EGRESS_BIND",
    ]
  ) {
    config.set(key, null);
  }

  if (choice === "direct") {
    // Written rather than left to the default, which is `proxy`. A deployment that claims a
    // boundary and enforces none is the one state this setting must never end up in by accident,
    // and "I picked direct" is exactly how it would.
    config.set("RYPH_EGRESS", "open");
    return choice;
  }

  config.set("RYPH_EGRESS", "proxy");
  if (!ctx.egressKeyPresent) config.set("RYPH_EGRESS_KEY", mintHexKey());

  // The bind stays on loopback here. Runs reach this process at `host.docker.internal` (or the
  // run gate, which dials that name) without the listener leaving localhost — and opening it
  // anyway would publish a port that answers `Proxy-Authorization` to the whole LAN. A run's
  // claim is not hard to come by (the `manual` provisioner prints the env, `docker inspect`
  // shows it, and every setup step reads HTTPS_PROXY by design), so that port would be a
  // forwarding proxy through this machine for the claim's lifetime.
  //
  // A native Linux engine is the exception, confined or not: there `host.docker.internal` is
  // the docker bridge's address, which a loopback listener does not answer — so the proxy binds
  // that address instead. That is narrower than 0.0.0.0 but not private: every container on any
  // bridge can reach it, and so can a LAN host that routes the bridge's subnet to this machine.
  // Acceptable, because the proxy answers only a signed claim, and the control plane, model
  // proxy and forge (7411, 7420, 7412) bind that same address (the host detects it at boot).
  if (ctx.dockerBridgeGateway) {
    config.set("RYPH_EGRESS_BIND", ctx.dockerBridgeGateway);
    notes.push(
      `the egress proxy listens on ${ctx.dockerBridgeGateway}:${ctx.egressPort}, the docker ` +
        `bridge's address: on a Linux docker engine that is where containers reach this machine, ` +
        `and a loopback listener would not answer them.`,
    );
  }
  if (choice !== "confined") return choice;

  const confined = await ctx.confineDockerRuns!(runNetwork);
  if (!confined.confined) {
    notes.push(
      `runs are NOT confined — the allowlist still shapes setup steps, but a run can go ` +
        `around it: ${confined.why} Then re-run \`ryph setup\`.`,
    );
    return "allowlisted";
  }
  // The bind does NOT move here on Docker Desktop: the gate reaches this process at
  // host.docker.internal, which Desktop forwards to this machine's loopback. So the proxy and the
  // MCP gateway stay on 127.0.0.1, and nothing new answers the LAN (on Linux they moved to the
  // bridge above, for the same name's sake).
  config.set("RYPH_DOCKER_RUN_NETWORK", runNetwork);
  config.set("RYPH_DOCKER_GATE_IMAGE", imageSetting(ctx, "run-gate", gate!));
  return choice;
}

/**
 * Where a run dials this process, written down because the choice above decided it.
 *
 * Docker puts the agent somewhere `localhost` cannot reach — inside a container, localhost IS the
 * container — so the default that is correct for a hand-started runner is exactly wrong here, and
 * wrong silently: the run boots, cannot fetch its work item, and fails a long way from this
 * question.
 */
function writeContainerAddresses(
  ctx: SetupContext,
  config: Map<string, string | null>,
  notes: string[],
  egress: EgressChoice,
): void {
  // A confined run has no route to the host at all, and reaches every one of these through the
  // run gate, by its name; the gate relays exactly the ports written here (the host reads them
  // back).
  const host = egress === "confined"
    ? gateName({ network: ctx.dockerNetwork })
    : "host.docker.internal";
  config.set("RYPH_PUBLIC_URL", `http://${host}:${ctx.apiPort}`);
  config.set("RYPH_MODEL_PROXY_URL", `http://${host}:${ctx.proxyPort}`);
  // The control plane, the model proxy and the forge need nothing written here: the host
  // detects the one address a run dials when that is not loopback (a Linux engine's bridge) at
  // every boot and binds it beside loopback. RYPH_BIND is left to whatever the user listed by
  // hand.
  // Only where there is a boundary to reach. Handing a run a proxy address on a deployment that
  // chose `direct` would route every install through a listener it was told not to rely on.
  if (egress !== "direct") {
    config.set("RYPH_EGRESS_PROXY_URL", `http://${host}:${ctx.egressPort}`);
  }
  // The MCP gateway serves every tool a run has, memory included, so a run that cannot dial it
  // dies at the harness's first handshake. Docker Desktop and OrbStack forward
  // `host.docker.internal` to this machine's loopback, so the listener stays there.
  config.set("RYPH_MCP_GATEWAY_URL", `http://${host}:${ctx.mcpPort}`);
  // Cleared first, for `askEgress`'s reason: a re-run on another engine must not leave the
  // gateway listening on an address this one no longer needs.
  config.set("RYPH_MCP_GATEWAY_HOST", null);
  if (ctx.dockerBridgeGateway) {
    // A Linux engine delivers `host.docker.internal` to the docker bridge, not to loopback.
    config.set("RYPH_MCP_GATEWAY_HOST", ctx.dockerBridgeGateway);
    notes.push(
      `the MCP gateway listens on ${ctx.dockerBridgeGateway}:${ctx.mcpPort}, the docker bridge's ` +
        `address: on a Linux docker engine that is where containers reach this machine.`,
    );
  }
}

async function askRepositories(
  io: Prompter,
  ctx: SetupContext,
  config: Map<string, string | null>,
  notes: string[],
): Promise<void> {
  io.say(
    "How an agent gets at your code: repositories on this machine, on GitHub, on GitLab or on " +
      "Radicle.",
  );
  const local = await askLocalRoot(io, ctx, config);
  io.say();
  const github = await askGithub(io, ctx, config, notes);
  const gitlab = await askGitlab(io, ctx, config, notes);
  const radicle = await askRadicle(io, ctx, config);
  if (!local && !github && !gitlab && !radicle) {
    notes.push("no way to reach a repository yet — `ryph setup` again, or see `ryph --help`.");
  }
}

/** The directory local repositories may be added from. True when one is configured. */
async function askLocalRoot(
  io: Prompter,
  ctx: SetupContext,
  config: Map<string, string | null>,
): Promise<boolean> {
  const choice = await io.select(
    "Repositories on this machine",
    [
      {
        label: "a directory on this machine",
        hint: "add repositories from it in the web UI, no git host needed",
        value: "local",
      },
      { label: "skip", hint: "set it up later", value: "skip" },
    ],
    0,
    { id: "repos" },
  );
  if (choice === "skip") return false;

  // Home unless something narrower was chosen before: the same default `up` falls back to, so
  // taking it here changes nothing but the settings file saying so.
  // A root turned `off` before is not a directory to offer; choosing this way in turns it on.
  const previous = ctx.current.get("RYPH_LOCAL_REPO_ROOT");
  const current = (previous && previous.toLowerCase() !== "off" ? previous : null) ??
    defaultLocalRepoRoot();
  io.say(
    "This only sets where repositories can be added from. Agents can't see any of it until " +
      "you add a repository in the Ryph UI.",
  );
  io.say();
  const root = await io.ask("directory to add repositories from", {
    id: "repo-root",
    ...(current ? { default: current } : {}),
    validate: async (value) => {
      const path = absolute(value);
      if (path === null) return "an absolute path, or one starting with ~";
      try {
        if (!(await stat(path)).isDirectory()) return `${path} is not a directory`;
      } catch {
        return `${path} does not exist`;
      }
      return null;
    },
  });
  const path = absolute(root)!;
  config.set("RYPH_LOCAL_REPO_ROOT", path);
  // Stated at the moment of choosing, because it is the line around what this deployment may
  // read: nothing under it is reachable until someone adds it, and nothing outside it ever is.
  // No provisioner caveat: runs clone through the forge, so every backend can work on one.
  io.say(
    `Add repositories under ${path} in the web UI, under Repos → Connect repository → ` +
      "On this machine.",
  );
  return true;
}

/**
 * Radicle user mode, offered only where `rad self` answered: ryph acts as that identity through
 * the person's own node. True when it is on afterwards. Nothing is asked about the node or the
 * key here — `ryph up` checks both, and says what to do, every time it starts.
 */
async function askRadicle(
  io: Prompter,
  ctx: SetupContext,
  config: Map<string, string | null>,
): Promise<boolean> {
  const on = ctx.current.get("RYPH_RADICLE_URL") === "embedded";
  // No identity here: nothing to offer — but one turned on before can still be turned off, or
  // the only way out would be editing the file by hand.
  if (!ctx.radicle && !on) return false;
  io.say();
  const who = !ctx.radicle
    ? "`rad self` does not answer here any more"
    : ctx.radicle.alias === null
    ? ctx.radicle.did
    : `${ctx.radicle.alias} (${ctx.radicle.did})`;
  const choice = await io.select(
    "Radicle",
    on
      ? [
        { label: "keep acting as your Radicle identity", hint: who, value: "keep" },
        { label: "turn Radicle off", hint: "repositories stay on your node", value: "off" },
      ]
      : [
        {
          label: "act as your Radicle identity",
          hint: `${who}, through your own radicle-node`,
          value: "on",
        },
        { label: "skip", hint: "set it up later", value: "skip" },
      ],
    on ? 0 : 1,
    { id: "radicle" },
  );
  if (choice === "keep") return true;
  if (choice === "off") {
    config.set("RYPH_RADICLE_URL", null);
    return false;
  }
  if (choice === "skip") return false;
  config.set("RYPH_RADICLE_URL", "embedded");
  io.say(
    "Connect a repository by its RID in the web UI. Ryph opens patches and comments as you, " +
      "touches only what you connect, and leaves your node's seeding as it is.",
  );
  return true;
}

/** The command that prints the GitHub CLI's token: what "use your GitHub CLI login" writes. */
export const GH_TOKEN_COMMAND = "gh auth token";

/** What a fine-grained token needs, said before it is pasted. No Checks: a fine-grained token has
 * no such permission — only a GitHub App posts check runs — so check results stay in ryph. */
const TOKEN_PERMISSIONS = [
  "Contents: read and write",
  "Pull requests: read and write",
  "Issues: read and write",
  "Metadata: read",
];

/**
 * How ryph acts on GitHub: as you, through a token. The GitHub CLI's login when it has one (the
 * token is read at boot and again when GitHub turns it away, so nothing is stored here), or a
 * pasted token. True when GitHub is configured afterwards.
 *
 * The two GitHub answers are exclusive — the forge refuses to start with both — so picking one
 * clears the other. A GitHub App counts as configured: keeping it is the default, and only an
 * explicit switch to a token (or turning GitHub off) clears its settings (webhook secret
 * included, which the forge refuses beside a token just the same), after a confirmation that
 * names every setting it removes.
 */
async function askGithub(
  io: Prompter,
  ctx: SetupContext,
  config: Map<string, string | null>,
  notes: string[],
): Promise<boolean> {
  const currentCommand = ctx.current.get("RYPH_GITHUB_TOKEN_COMMAND") ?? null;
  const currentToken = ctx.current.get("RYPH_GITHUB_TOKEN") ?? null;
  const userConfigured = currentCommand !== null || currentToken !== null;
  const appSet = APP_KEYS.filter((key) => ctx.current.has(key));
  const appConfigured = appSet.length > 0;
  const configured = userConfigured || appConfigured;
  const appId = ctx.current.get("RYPH_GITHUB_APP_ID") ?? null;

  io.say("Ryph works on GitHub as you: it opens pull requests and comments under your name.");
  if (!ctx.githubCli) {
    io.say(
      "To use your GitHub CLI login, sign in with `gh auth login` and run `ryph setup` again.",
    );
  }
  type GithubChoice = "keep" | "cli" | "token" | "skip" | "off";
  const choices: { label: string; hint: string; value: GithubChoice }[] = [
    ...(userConfigured
      ? [{
        label: "keep the current GitHub login",
        hint: currentCommand !== null ? currentCommand : "a pasted token",
        value: "keep" as const,
      }]
      : appConfigured
      ? [{
        label: "keep the current GitHub App",
        hint: appId !== null ? `App ID ${appId}` : "set in the settings file",
        value: "keep" as const,
      }]
      : []),
    ...(ctx.githubCli
      ? [{
        label: "use your GitHub CLI login",
        hint: "nothing is stored; ryph asks `gh` for the token",
        value: "cli" as const,
      }]
      : []),
    {
      label: "paste a token",
      hint: "a fine-grained token limits ryph to the repositories you pick",
      value: "token",
    },
    configured
      ? {
        label: "turn GitHub off",
        hint: userConfigured ? "remove the GitHub login" : "remove the GitHub App",
        value: "off",
      }
      : { label: "skip", hint: "set it up later", value: "skip" },
  ];
  // What is configured stays by default; else the CLI login where there is one; otherwise
  // nothing is chosen for you.
  const cliIndex = choices.findIndex((c) => c.value === "cli");
  const choice = await io.select(
    "GitHub",
    choices,
    configured ? 0 : cliIndex >= 0 ? cliIndex : choices.length - 1,
    { id: "github" },
  );

  if (choice === "keep") return true;
  if (choice === "skip") return false;

  // Every answer left switches away from a GitHub App, if there is one: its keys go, and that is
  // asked first, by name, defaulting to no — the private key and the secrets are not written
  // down anywhere else, and Enter must never be what deletes them.
  if (appConfigured) {
    const remove = await io.confirm(
      `This removes the GitHub App settings (${appSet.join(", ")}): ryph acts on GitHub as an ` +
        "App or as you, never both. Remove them?",
      false,
      { id: "remove-github-app" },
    );
    if (!remove) {
      notes.push("kept the GitHub App: its settings were not changed.");
      return true;
    }
  }
  // Written only once the switch has what it needs: a token paste left empty changes nothing.
  const dropApp = () => {
    if (!appConfigured) return;
    for (const key of appSet) config.set(key, null);
    notes.push(
      `removed the GitHub App settings (${appSet.join(", ")}): ryph acts on GitHub as an App ` +
        "or as you, never both.",
    );
  };
  if (choice === "off") {
    dropApp();
    config.set("RYPH_GITHUB_TOKEN_COMMAND", null);
    config.set("RYPH_GITHUB_TOKEN", null);
    return false;
  }

  if (choice === "cli") {
    config.set("RYPH_GITHUB_TOKEN_COMMAND", GH_TOKEN_COMMAND);
    config.set("RYPH_GITHUB_TOKEN", null);
  } else {
    io.say("Create one at https://github.com/settings/personal-access-tokens/new and give it:");
    for (const permission of TOKEN_PERMISSIONS) io.say(`  ${permission}`);
    io.say(
      "Leave Workflows off: with it, agents could add or change workflow files, which GitHub " +
        "runs with the repo's secrets.",
    );
    io.say("Check results show in ryph; only a GitHub App can post them to GitHub.");
    const token = (await io.secret("token (not echoed)", { id: "github-token" })).trim();
    if (!token) {
      if (appConfigured) {
        notes.push("no token entered — the GitHub App's settings were not changed.");
        return true;
      }
      notes.push("no token entered — GitHub stays unreachable.");
      return false;
    }
    config.set("RYPH_GITHUB_TOKEN", token);
    config.set("RYPH_GITHUB_TOKEN_COMMAND", null);
  }
  dropApp();
  io.say("Connect repositories in the web UI, under Repos → Connect repository.");
  return true;
}

/** A GitHub App's settings, which a deployment in user mode must not also carry — the webhook
 * secret included: the forge refuses to start with it beside a token. */
const APP_KEYS = [
  "RYPH_GITHUB_APP_ID",
  "RYPH_GITHUB_PRIVATE_KEY",
  "RYPH_GITHUB_PRIVATE_KEY_PATH",
  "RYPH_GITHUB_CLIENT_ID",
  "RYPH_GITHUB_CLIENT_SECRET",
  "RYPH_GITHUB_WEBHOOK_SECRET",
];

/**
 * Outbound mail carries verification and password-reset links. Without it those links are
 * shown to an admin in the UI instead, so an instance works with no mailer at all — the
 * question exists so the operator knows that is the trade being made.
 */
async function askMail(
  io: Prompter,
  ctx: SetupContext,
  config: Map<string, string | null>,
): Promise<void> {
  const current = ctx.current.get("RYPH_SMTP_URL") ?? null;
  io.say("How verification and password-reset links reach people.");

  const choice = await io.select(
    "Mail",
    [
      {
        label: current === null ? "skip" : "keep the current SMTP server",
        hint: current === null ? "links are shown to an admin in the UI" : maskUrl(current),
        value: "skip",
        ...(current === null ? {} : { key: "keep" }),
      },
      { label: "an SMTP server", hint: "any provider's SMTP endpoint", value: "smtp" },
      ...(current === null ? [] : [{
        label: "turn mail off",
        hint: "links go back to being shown to an admin",
        value: "off",
      }]),
    ],
    0,
    { id: "mail" },
  );

  if (choice === "skip") return;
  if (choice === "off") {
    config.set("RYPH_SMTP_URL", null);
    config.set("RYPH_MAIL_FROM", null);
    return;
  }

  const url = await io.ask("SMTP URL (smtp://user:password@host:587 or smtps://…)", {
    id: "smtp-url",
    default: current ?? undefined,
    validate: (value) =>
      /^smtps?:\/\/.+/.test(value.trim()) ? null : "a URL starting with smtp:// or smtps://",
  });
  const from = await io.ask("From address", {
    id: "mail-from",
    default: ctx.current.get("RYPH_MAIL_FROM") ?? "ryph <ryph@localhost>",
  });
  config.set("RYPH_SMTP_URL", url.trim());
  config.set("RYPH_MAIL_FROM", from.trim());
}

/** `~`-relative and absolute both accepted; anything else is refused rather than resolved against cwd. */
function absolute(input: string): string | null {
  const value = input.trim();
  if (value.startsWith("~")) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    return home ? resolve(home + value.slice(1)) : null;
  }
  return isAbsolute(value) ? resolve(value) : null;
}

/** A setting as this launch would resolve it: the environment first, then the file, then the default. */
function setting(current: Map<string, string>, key: string, fallback: string): string {
  const raw = (process.env[key] ?? current.get(key) ?? "").trim();
  return raw === "" ? fallback : raw;
}

/** A port as this launch would resolve it: the environment first, then the file, then the default. */
function port(current: Map<string, string>, key: string, fallback: number): number {
  const raw = process.env[key] ?? current.get(key);
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback;
}

export interface AppliedSetup {
  configPath: string | null;
  keyPath: string | null;
  keyMinted: boolean;
  /** Exactly what landed in the settings file, in the order it was decided. */
  written: Map<string, string>;
}

/** Writes what the wizard decided: the key where keys go, everything else to the settings file. */
export async function applySetup(plan: SetupPlan, ctx: SetupContext): Promise<AppliedSetup> {
  const config = new Map(plan.config);
  let keyPath: string | null = null;
  let keyMinted = false;

  if (plan.key.action === "store") {
    keyPath = await storeSecretsKey(ctx.dbUrl, plan.key.hex);
    keyMinted = plan.key.minted;
    // Nowhere to pair a key with this database (postgres://), so the settings file is the only
    // place left. Which is why that file is written 0600.
    if (keyPath === null) config.set("RYPH_SECRETS_KEY", plan.key.hex);
  }

  const written = new Map(
    [...config].filter((entry): entry is [string, string] => entry[1] !== null),
  );
  const path = config.size > 0 ? await updateConfig(config) : configPath();
  return { configPath: path, keyPath, keyMinted, written };
}

/** Whether the daemon is actually there — `Server.Version` is answered by the daemon, not the CLI. */
export async function detectDocker(): Promise<BackendStatus> {
  try {
    const { success, stdout } = await runCommand("docker", {
      args: ["version", "--format", "{{.Server.Version}}"],
      stdout: "piped",
      stderr: "null",
    }).output();
    const version = new TextDecoder().decode(stdout).trim();
    if (!success || version === "") {
      return {
        available: false,
        reason: "installed, but the daemon is not responding",
        fix: "start Docker Desktop",
      };
    }
    return { available: true, version: `Docker ${version}` };
  } catch {
    return { available: false, reason: "not on PATH", fix: "install Docker first" };
  }
}

/**
 * Images already built here, so the wizard can offer one instead of asking you to recall it:
 * `ryph-agent` by default, or the repository named (`ryph-browser`).
 */
export async function localAgentImages(repository = "ryph-agent"): Promise<string[]> {
  try {
    const { success, stdout } = await runCommand("docker", {
      args: ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!success) return [];
    return new TextDecoder().decode(stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(repository) && !line.endsWith(":<none>"));
  } catch {
    return [];
  }
}

/** The published images the binary defaults to, and whether they are its own commit's; none
 * from source (`defaultImage` names local `:dev` builds there, which the local lists already
 * offer when they exist). */
function publishedImages(): Pick<SetupContext, "publishedImages" | "imagesPinned"> {
  const baked = bakedImageTag();
  if (baked === undefined) return {};
  return {
    publishedImages: {
      agent: defaultImage("agent")!,
      browser: defaultImage("browser")!,
      "run-gate": defaultImage("run-gate")!,
    },
    imagesPinned: publishedTag(baked).pinned,
  };
}

export async function gatherContext(
  dbUrl: string,
  current: Map<string, string>,
): Promise<SetupContext> {
  const stored = await readSecretsKey(dbUrl).catch(() => null);
  const docker = await detectDocker();
  return {
    dbUrl,
    keyFromEnv: Boolean(process.env.RYPH_SECRETS_KEY),
    storedKeyPath: stored?.path ?? null,
    storableKeyPath: secretsKeyPath(dbUrl),
    docker,
    agentImages: docker.available ? await localAgentImages() : [],
    browserImages: docker.available ? await localAgentImages("ryph-browser") : [],
    gateImages: docker.available ? await localAgentImages("ryph-run-gate") : [],
    ...publishedImages(),
    environment: Object.fromEntries(
      [AGENT_IMAGE, BROWSER_IMAGE].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]]] : []
      ),
    ),
    dockerNetwork: setting(current, "RYPH_DOCKER_NETWORK", "") || undefined,
    dockerBridgeGateway: docker.available ? await localBridgeGateway() : null,
    apiPort: port(current, "RYPH_PORT", 7411),
    proxyPort: port(current, "RYPH_MODEL_PROXY_PORT", 7420),
    egressPort: port(current, "RYPH_EGRESS_PORT", 7460),
    mcpPort: port(current, "RYPH_MCP_GATEWAY_PORT", 7430),
    egressKeyPresent: setting(current, "RYPH_EGRESS_KEY", "") !== "",
    confineDockerRuns: docker.available ? confineDockerRuns : undefined,
    githubCli: await githubCliSignedIn(),
    gitlabCli: (instance) => glabTokenCommand(instance, (command) => githubCliSignedIn(command)),
    // A typo here is the boot's error to report, with its own message; setup just asks about mail.
    multiUser: (() => {
      try {
        return multiUserFromEnv((name) => setting(current, name, "") || undefined, false);
      } catch {
        return true;
      }
    })(),
    radicle: await radicleSelf(),
    current,
  };
}

/**
 * Who `rad self` says this machine is on Radicle, or null when it cannot say: no `rad` on PATH,
 * no identity in RAD_HOME. Read-only, and bounded like the GitHub CLI's check. By name, because
 * `ryph up` may run only the `rad` PATH finds — offering one it could not run would be a lie.
 */
export async function radicleSelf(
  timeoutMs = 5_000,
): Promise<{ did: string; alias: string | null } | null> {
  const run = async (flag: string): Promise<string | null> => {
    try {
      const out = await runCommand("rad", {
        args: ["self", flag],
        stdin: "null",
        stdout: "piped",
        stderr: "null",
        signal: AbortSignal.timeout(timeoutMs),
      }).output();
      return out.success ? new TextDecoder().decode(out.stdout).trim() || null : null;
    } catch {
      return null;
    }
  };
  const did = await run("--did");
  if (did === null || !did.startsWith("did:key:")) return null;
  return { did, alias: await run("--alias") };
}

/**
 * Whether the GitHub CLI has a login to lend: the exact command the forge will run, through the
 * same shell, answering something. The token itself is read and dropped, never printed.
 *
 * Bounded: a `gh` that hangs (a keyring prompt nobody sees) must not hang the wizard. The shell
 * runs in a process group of its own and the deadline kills the whole group, because killing
 * `sh` alone would leave `gh` holding the pipe and the read waiting on it; the pipe is let go.
 *
 * The command is written as the bare `gh auth token`, not gh's absolute path: `ryph up` is run
 * from the same shell as `ryph setup` (there is no service manager starting it with another
 * PATH), so the `gh` found here is the one the forge finds, and the bare name survives gh moving
 * (a Homebrew prefix, a version manager) where a pinned path would not.
 */
export async function githubCliSignedIn(
  command = GH_TOKEN_COMMAND,
  timeoutMs = 10_000,
): Promise<boolean> {
  let child: Child;
  try {
    child = await runCommand("sh", {
      args: ["-c", command],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      detached: true,
    }).spawn();
  } catch {
    return false; // no shell to run it with, or no permission to
  }
  const reader = child.stdout.getReader();
  const read = (async () => {
    let out = "";
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return out;
      // A token is one short line; anything past this is not one.
      if (out.length < 4096) out += decoder.decode(value, { stream: true });
    }
  })();
  read.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const done = await Promise.race([Promise.all([child.status, read]), deadline]);
    if (done !== null) return done[0].success && done[1].trim() !== "";
  } finally {
    clearTimeout(timer);
  }
  killGroup(child);
  await reader.cancel().catch(() => {});
  await child.status;
  return false;
}

/**
 * SIGKILL a detached child's whole process group: the shell, the pipeline, and whatever they
 * started — a negative pid names the group. If the group cannot be signalled, the shell itself
 * is, at least. (The forge's user_token.ts carries the same helper; the CLI does not import the
 * forge.)
 */
function killGroup(child: Child): void {
  try {
    process.kill(-child.pid, "SIGKILL");
    return;
  } catch { /* the group is gone, or not ours to signal: fall through */ }
  try {
    child.kill("SIGKILL");
  } catch { /* already gone */ }
}

/**
 * Docker's internal run network, made if it is not there — the provisioner's own `ensureRunNetwork`,
 * so the wizard and the launch agree on what confines: internal, and on a Linux engine with no
 * gateway left on the host (gateway mode `isolated`, engine 28+).
 *
 * `--internal` under docker takes the host with it (measured on Docker Desktop: no internet, no
 * outside DNS, no `host.docker.internal`), which is why confined docker runs reach ryph through
 * the run gate rather than a gateway address. One by this name that cannot confine is remade when
 * ryph made it and nothing but the run gate is attached; otherwise it is left alone and reported,
 * naming the fix: removing it could cut off whatever else is attached to it.
 */
async function confineDockerRuns(
  network: string,
): Promise<{ confined: true } | { confined: false; why: string }> {
  try {
    // `replaceIdle`: a network an older ryph made before isolation was required is remade here,
    // when nothing but the run gate is attached — the boot check would refuse it otherwise.
    await ensureDockerRunNetwork(network, undefined, { replaceIdle: true });
    return { confined: true };
  } catch (err) {
    return { confined: false, why: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The whole command: gather, ask, write, report. Returns an exit code — 0 for a completed run,
 * 130 for one the person walked away from, which is what Ctrl-C means everywhere else.
 */
export async function runSetup(
  io: Prompter,
  dbUrl: string,
  current: Map<string, string>,
): Promise<number> {
  const ctx = await gatherContext(dbUrl, current);
  let applied: AppliedSetup;
  let plan: SetupPlan;
  try {
    try {
      plan = await runWizard(io, ctx);
    } finally {
      // Back to the normal screen before anything below is said: the summary, a stop or a
      // cancel all belong in the scrollback, after whatever was there before setup began.
      io.close?.();
    }
    applied = await applySetup(plan, ctx);
  } catch (err) {
    if (err instanceof Cancelled) {
      io.say();
      io.say("Setup cancelled — nothing was written.");
      return 130;
    }
    if (err instanceof SetupStopped || err instanceof NeedsAnswer) {
      io.say();
      io.say(`! ${err.message}`);
      io.say("Setup stopped — nothing was written.");
      return 1;
    }
    throw err;
  }

  io.heading("✅ Setup complete");
  if (applied.keyPath !== null) {
    io.say(
      applied.keyMinted
        ? `Master key minted at ${applied.keyPath} — back it up separately, it is not in a snapshot.`
        : `Master key stored at ${applied.keyPath}.`,
    );
  }
  if (applied.written.size > 0 && applied.configPath !== null) {
    io.say(`Settings written to ${applied.configPath}:`);
    const width = Math.max(...[...applied.written.keys()].map((key) => key.length));
    for (const [key, value] of applied.written) {
      io.say(`  ${key.padEnd(width)}  ${redact(key, value)}`);
    }
  }
  for (const note of plan.notes) io.say(`! ${note}`);
  io.say();
  io.say(
    "Edit that file directly, or run `ryph setup` again. `ryph config` shows what a launch " +
      "resolves to, environment included.",
  );
  io.say();
  return 0;
}

/**
 * The flags that answer the wizard's questions, by question id, with what each takes. Every
 * question carries its id (`{ id: "egress" }`), and `answeringPrompter` matches the two up, so a
 * script or an agent runs the same wizard a person does.
 */
export const SETUP_FLAGS: { id: string; takes: string; help: string }[] = [
  { id: "key", takes: "keep|mint|paste|skip", help: "the master key" },
  { id: "key-value", takes: "<hex>|-", help: "the key to store (implies --key paste)" },
  { id: "agent-image", takes: "<image>", help: "the image every run launches on" },
  { id: "browser-image", takes: "<image>|off", help: "the browser agents get" },
  { id: "egress", takes: "confined|allowlisted|direct", help: "agent internet access" },
  { id: "repos", takes: "local|skip", help: "repositories on this machine" },
  {
    id: "repo-root",
    takes: "<dir>",
    help: "the directory to add them from (implies --repos local)",
  },
  { id: "github", takes: "keep|cli|token|skip|off", help: "how ryph acts on GitHub" },
  { id: "github-token", takes: "<token>|-", help: "a token for it (implies --github token)" },
  { id: "remove-github-app", takes: "yes|no", help: "allow replacing a GitHub App; default no" },
  { id: "gitlab", takes: "keep|user|skip|off", help: "how ryph acts on GitLab" },
  { id: "gitlab-url", takes: "<url>", help: "the GitLab instance (implies --gitlab user)" },
  {
    id: "gitlab-login",
    takes: "cli|paste",
    help: "your glab login, where it has one, or a token (implies --gitlab user)",
  },
  {
    id: "gitlab-token",
    takes: "<token>|-",
    help: "a token for it (implies --gitlab-login paste)",
  },
  {
    id: "remove-gitlab-bot",
    takes: "yes|no",
    help: "allow removing GitLab bot settings; default no",
  },
  { id: "radicle", takes: "on|keep|off|skip", help: "act as your Radicle identity" },
  { id: "mail", takes: "skip|keep|smtp|off", help: "outbound mail (RYPH_MULTIUSER=on only)" },
  { id: "smtp-url", takes: "<url>", help: "smtp:// or smtps:// (implies --mail smtp)" },
  { id: "mail-from", takes: "<address>", help: "the From address" },
];

/** A flag that answers another question by being given at all: `--repo-root` means `--repos local`. */
const IMPLIES: Record<string, [string, string]> = {
  "key-value": ["key", "paste"],
  "repo-root": ["repos", "local"],
  "github-token": ["github", "token"],
  // Before `gitlab-login`, whose own implication then carries the token's on to `--gitlab user`.
  "gitlab-token": ["gitlab-login", "paste"],
  "gitlab-login": ["gitlab", "user"],
  "gitlab-url": ["gitlab", "user"],
  "smtp-url": ["mail", "smtp"],
};

export const SETUP_HELP = `ryph setup — answer the questions a fresh install cannot

USAGE
  ryph setup                       ask them, at a terminal
  ryph setup --yes [flags]         ask nothing: flags answer their questions and every other one
                                   takes its default. Needed when there is no terminal.
  ryph setup [flags]               at a terminal: flags answer their questions, the rest are asked

FLAGS
${
  SETUP_FLAGS.map(({ id, takes, help }) => {
    const flag = `  --${id} ${takes}`;
    return flag.length < 34 ? `${flag.padEnd(35)}${help}` : `${flag}\n${" ".repeat(35)}${help}`;
  }).join("\n")
}
  -y, --yes                        take the default for every question no flag answers

  A choice offered only on some machines (--github cli without a gh login, --egress confined
  without a run gate image) is refused there, with the choices that are on offer. A token or key
  given as - is read from stdin, which keeps it out of the process list.

EXAMPLE
  ryph setup --yes --egress allowlisted --github cli --repo-root ~/Code
`;

export interface SetupArgs {
  answers: Map<string, string>;
  /** Answers no flag gave directly, only implied by another (`--repo-root` → `--repos`). */
  implied: Set<string>;
  yes: boolean;
  help: boolean;
}

/** `ryph setup`'s flags. Throws on one it does not know, so a typo cannot fall back to a default. */
export function parseSetupArgs(argv: string[]): SetupArgs {
  const known = new Set(SETUP_FLAGS.map((f) => f.id));
  const answers = new Map<string, string>();
  const implied = new Set<string>();
  let yes = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-y" || arg === "--yes") {
      yes = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(arg);
    if (!match || !known.has(match[1])) {
      throw new NeedsAnswer(
        `unexpected ${JSON.stringify(arg)} — \`ryph setup --help\` lists the flags`,
      );
    }
    let value = match[2];
    if (value === undefined) {
      // `-` is a value (stdin), not the start of another flag.
      if (i + 1 >= argv.length || (argv[i + 1].startsWith("-") && argv[i + 1] !== "-")) {
        throw new NeedsAnswer(
          `--${match[1]} needs a value: ${SETUP_FLAGS.find((f) => f.id === match[1])!.takes}`,
        );
      }
      value = argv[++i];
    }
    if (answers.has(match[1])) throw new NeedsAnswer(`--${match[1]} given twice`);
    answers.set(match[1], value);
  }
  for (const [flag, [question, answer]] of Object.entries(IMPLIES)) {
    if (!answers.has(flag)) continue;
    const given = answers.get(question);
    if (given !== undefined && given !== answer) {
      throw new NeedsAnswer(`--${flag} needs --${question} ${answer}, not ${given}`);
    }
    if (given === undefined) implied.add(question);
    answers.set(question, answer);
  }
  return { answers, implied, yes, help };
}

/** Never print a token back at the terminal it was hidden from. */
export function redact(key: string, value: string): string {
  return /_(TOKEN|KEY|SECRET|PASSWORD)$/.test(key)
    ? `${value.slice(0, 4)}… (${value.length} characters)`
    : maskUrl(value);
}

/**
 * Whether `ryph up` should ask before it starts.
 *
 * Every condition is a way of saying "somebody is here, and nobody has answered these yet". A
 * container, a systemd unit and a CI job all fail the terminal check, so the binary behaves
 * exactly as it did before this file existed — which is the property that matters most: an
 * interactive convenience must never become an unattended hang.
 */
export function shouldRunSetup(opts: {
  interactive: boolean;
  configExists: boolean;
  disabled: boolean;
  dbUrl: string;
}): boolean {
  if (opts.disabled || !opts.interactive || opts.configExists) return false;
  // An environment that already names a provisioner is a configured deployment being run by
  // hand; it has answered the questions in the way that beats the file anyway.
  if (process.env.RYPH_PROVISIONER) return false;
  // A throwaway database is not a machine anyone is setting up.
  const target = parseDbUrl(opts.dbUrl);
  return !(target.kind === "pglite" && target.dataDir === null);
}

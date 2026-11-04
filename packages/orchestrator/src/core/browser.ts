// The browser a run can be given: a Chromium sidecar the agent drives through MCP tools and a
// person can watch live from the run page.
//
// Three switches have to line up, and this file is where they meet:
//
// - the AGENT asks for it (`Agent.browserEnabled`), because a browser consumes resources on top
//   of the run's size class, and most agents never open a page;
// - the DEPLOYMENT can give it: `RYPH_BROWSER_IMAGE` names the sidecar image, and the provisioner
//   is one that launches it (`Provisioner.supportsBrowser`: kubernetes and docker). The image
//   unset is the feature off, said once at boot rather than per run;
// - the HARNESS can use it: the browser is an MCP server, so a harness with no MCP client (echo)
//   would hold a Chromium it can never call.
//
// What the run gets is decided ONCE, at start, and frozen onto the work item (`WorkItem.browser`)
// like every other snapshot: an agent edited mid-run changes nothing about a run already going.
// An agent that asks and cannot be given one is never refused — the run starts without a browser,
// with a `browser.unavailable` event saying why, because an agent that cannot browse is still an
// agent that can do most of what it was asked.
//
// The sidecar is the platform's, never a repo's: it is not a `services` entry (core/services.ts
// reserves the name), it needs no Secret and no env, and the runner hands it the only two things
// it holds — its MCP bearer and the run's egress proxy credentials — over loopback once it is up.

import type { Agent, WorkItem } from "./types.ts";
import { quantityBytes, quantityCores } from "./run_sizes.ts";
import { supportsTools } from "./harness_tools.ts";

/**
 * The port the sidecar listens on inside the run's network namespace. Fixed, not configured: the
 * sidecar gets no env (k8s) and the runner is told it on the work item, so one constant is the
 * whole agreement — and a repo service cannot take it (core/services.ts refuses the port).
 */
export const BROWSER_PORT = 7490;

/** The deployment's browser: the sidecar image and what each one is given on top of the run. */
export interface BrowserConfig {
  /** RYPH_BROWSER_IMAGE: the sidecar image (images/browser). */
  image: string;
  /** RYPH_BROWSER_CPUS, a Kubernetes cpu quantity (`1`, `500m`). Null: no cap on Docker. */
  cpus: string | null;
  /** RYPH_BROWSER_MEMORY, a Kubernetes memory quantity (`1536Mi`, `2Gi`). Null: no cap on Docker. */
  memory: string | null;
}

/** Non-Docker defaults; Docker leaves unset resources uncapped. Measured: three
 * real sites open in one context sit at 660–830 MiB, and a renderer spikes well past that. */
export const DEFAULT_BROWSER_RESOURCES = { cpus: "1", memory: "1536Mi" } as const;

/**
 * RYPH_BROWSER_IMAGE as an image, or null when it is unset, empty or `off` (in any case: an image
 * reference is lowercase, so `OFF` could never name one). `off` is the one a
 * deployment with a default image can say. Every reader of the variable goes through this, so
 * they cannot disagree on what turns the browser off.
 */
export function browserImage(value: string | undefined): string | null {
  const image = value?.trim() || null;
  return image?.toLowerCase() === "off" ? null : image;
}

/**
 * The deployment's browser, from the orchestrator's environment, or null when browserImage reads
 * none — the feature off. Shared by both composition roots, so they cannot read the same
 * variables differently. A malformed quantity is fatal at boot, naming the variable: a bad one
 * would otherwise surface as an API server refusing the first browser run's Job.
 */
export function browserConfigFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
): BrowserConfig | null {
  const image = browserImage(env("RYPH_BROWSER_IMAGE"));
  const local = env("RYPH_PROVISIONER") === "docker";
  const cpus = env("RYPH_BROWSER_CPUS")?.trim() || (local ? null : DEFAULT_BROWSER_RESOURCES.cpus);
  const memory = env("RYPH_BROWSER_MEMORY")?.trim() ||
    (local ? null : DEFAULT_BROWSER_RESOURCES.memory);
  // Checked even with the image unset, so a typo is found when it is made rather than on the day
  // somebody turns the feature on.
  try {
    if (cpus !== null && !(quantityCores(cpus) > 0)) throw new Error("zero");
  } catch {
    fail(`RYPH_BROWSER_CPUS wants a cpu quantity above zero, e.g. 1 or 500m, got "${cpus}"`);
  }
  try {
    if (memory !== null && !(quantityBytes(memory) > 0)) throw new Error("zero");
  } catch {
    fail(`RYPH_BROWSER_MEMORY wants a memory quantity, e.g. 1536Mi or 2Gi, got "${memory}"`);
  }
  return image === null ? null : { image, cpus, memory };
}

/**
 * Whether this deployment can give any run a browser at all: an image, and a provisioner that
 * launches it. What the agent form is told (`GET /v1/harnesses`), and the first half of
 * `browserGrant`.
 */
export function browserOffered(
  config: BrowserConfig | null,
  provisioner: { supportsBrowser?: boolean },
): boolean {
  return config !== null && provisioner.supportsBrowser === true;
}

/**
 * Why an agent on this harness cannot be given a browser here, or null when it can: what the
 * agent form says beside the switch it holds off (`GET /v1/harnesses`). The harness first, since
 * picking another one is the fix closest to hand; then the provisioner before the image, because
 * an image would not help a backend that cannot launch it. Pure.
 */
export type BrowserUnavailable = "harness" | "provisioner" | "image";

export function browserUnavailable(
  config: BrowserConfig | null,
  provisioner: { supportsBrowser?: boolean },
  harnessKind: string,
): BrowserUnavailable | null {
  if (!supportsTools(harnessKind)) return "harness";
  if (provisioner.supportsBrowser !== true) return "provisioner";
  if (config === null) return "image";
  return null;
}

/**
 * What one run gets: the browser on its loopback port, nothing (the agent did not ask), or
 * nothing with the reason the agent's ask could not be met — which the run records as a
 * `browser.unavailable` event. Pure.
 */
export function browserGrant(
  agent: Pick<Agent, "browserEnabled" | "harnessKind">,
  config: BrowserConfig | null,
  provisioner: { supportsBrowser?: boolean },
):
  | { kind: "granted"; browser: NonNullable<WorkItem["browser"]> }
  | { kind: "none" }
  | { kind: "unavailable"; why: string } {
  if (!agent.browserEnabled) return { kind: "none" };
  if (config === null) {
    return {
      kind: "unavailable",
      why: "the agent has a browser, but this deployment runs none (RYPH_BROWSER_IMAGE is " +
        "unset or off), so this run started without one",
    };
  }
  if (provisioner.supportsBrowser !== true) {
    return {
      kind: "unavailable",
      why: "the agent has a browser, but this deployment's provisioner cannot launch one " +
        "(docker, and kubernetes with native sidecars, can), so this run started without one",
    };
  }
  if (!supportsTools(agent.harnessKind)) {
    return {
      kind: "unavailable",
      why: `the agent has a browser, but its harness "${agent.harnessKind}" cannot call MCP ` +
        "tools, so this run started without one",
    };
  }
  return { kind: "granted", browser: { port: BROWSER_PORT } };
}

/**
 * A grant the provisioner turned down for this run's pod (`Provisioner.browserRefusal`), as the
 * same `browser.unavailable` a deployment without a browser records. Pure.
 */
export function browserWithheld(why: string): { kind: "unavailable"; why: string } {
  return {
    kind: "unavailable",
    why: `the agent has a browser, but ${why}, so this run started without one`,
  };
}

/**
 * The one boot line about the browser, for both composition roots: off, on, or configured on a
 * provisioner that cannot launch it — the last a warning, because an operator who set the image
 * would otherwise read a quiet boot as a working browser. Pure.
 */
export function browserPosture(
  config: BrowserConfig | null,
  provisioner: { supportsBrowser?: boolean },
  provisionerKind: string,
): { level: "info" | "warn"; message: string } {
  if (config === null) {
    return {
      level: "info",
      message:
        "RYPH_BROWSER_IMAGE is unset or off — no run gets a browser, whatever its agent asks",
    };
  }
  if (provisioner.supportsBrowser !== true) {
    return {
      level: "warn",
      message: `RYPH_BROWSER_IMAGE is set, but RYPH_PROVISIONER=${provisionerKind} cannot ` +
        "launch a browser (docker, and kubernetes with native sidecars, can) — no run gets one",
    };
  }
  return {
    level: "info",
    message: `browser on — ${config.image} (cpu=${config.cpus ?? "uncapped"}, memory=${
      config.memory ?? "uncapped"
    } per run)`,
  };
}

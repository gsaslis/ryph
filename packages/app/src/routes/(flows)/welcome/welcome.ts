// The welcome flow's rules, apart from its page so they are tested on their own: which step it
// opens on, what the quick agent is sent, and how the image downloads read.

import type { CreateAgentInput } from "$lib/api/agents";
import type { ImageName, ImageStatus } from "$lib/api/images";
import {
  DEFAULT_MEMORY_BUDGET_TOKENS,
  type Harness,
  type Provider,
  type ProviderKey,
} from "$lib/api/types";
import { can } from "$lib/utils/auth/capabilities";
import { effectiveEmail } from "../agents/shared/agent-steps";
import { createBrowserEnabled } from "../agents/shared/browser-policy";
import { composeForgePolicy, forgePolicyToFields } from "../agents/shared/forge-policy";
import { composeLimitPolicy, limitPolicyToFields } from "../agents/shared/limit-policy";
import { composeMemoryPolicy } from "../agents/shared/memory-policy";
import { composeModelPolicy } from "../agents/shared/model-policy";
import { composeNetworkPolicy, networkPolicyToFields } from "../agents/shared/network-policy";
import { composeSkillPolicy, skillPolicyToFields } from "../agents/shared/skill-policy";
import { composeToolPolicy } from "../agents/shared/tool-policy";

export type WelcomeStepId = "model" | "agent" | "background" | "repo" | "ready";

export const WELCOME_STEPS: readonly {
  id: WelcomeStepId;
  label: string;
  heading: string;
  description: string;
}[] = [
  {
    id: "model",
    label: "Model",
    heading: "Connect a model",
    description: "Your agents need a model to work with. Use your ChatGPT plan or add an API key.",
  },
  {
    id: "agent",
    label: "Agent",
    heading: "Create your first agent",
    description: "Name it and pick its model. You can change everything later.",
  },
  {
    id: "background",
    label: "Background model",
    heading: "Give Memory a background model",
    description: "Help Ryph turn what your agents learn into useful Memory for future tasks.",
  },
  {
    id: "repo",
    label: "Repository",
    heading: "Add a repository",
    description: "Pick the code your agent works on.",
  },
  {
    id: "ready",
    label: "Ready",
    heading: "You're all set",
    description: "Give your agent its first task.",
  },
];

/** The name a quick agent starts with. */
export const DEFAULT_AGENT_NAME = "Ada";

/** The step to open on: the first one not done yet, else the last. */
export function firstOpenStep(
  done: Record<Exclude<WelcomeStepId, "ready">, boolean>,
): WelcomeStepId {
  if (!done.model) return "model";
  if (!done.agent) return "agent";
  if (!done.background) return "background";
  if (!done.repo) return "repo";
  return "ready";
}

/** Match Memory's HTTP adapter; ChatGPT plans use the proxy's Responses translation. */
export function backgroundProviderKeys(keys: ProviderKey[], providers: Provider[]): ProviderKey[] {
  return keys.filter((key) =>
    key.archivedAt === null &&
    (key.provider !== "chatgpt-plan" ||
      (key.plan?.status !== "needs_reauth" && (key.plan?.models.length ?? 0) > 0)) &&
    providers.some((provider) =>
      provider.id === key.provider && provider.archivedAt === null &&
      ["anthropic-messages", "openai-responses", "openai-completions"].includes(provider.dialect)
    )
  );
}

/** The id of the newest live item, for the one to preselect; "" when there is none. */
export function newestId(
  items: readonly { id: string; createdAt: string; archivedAt: string | null }[],
): string {
  let newest: (typeof items)[number] | undefined;
  for (const item of items) {
    if (item.archivedAt !== null) continue;
    if (newest === undefined || item.createdAt > newest.createdAt) newest = item;
  }
  return newest?.id ?? "";
}

/**
 * The harness the quick agent gets: pi, which the full create flow always sends, else the first
 * one offered where this deployment has no pi. With no list to go by, pi.
 */
export function defaultHarnessKind(harnesses: readonly Pick<Harness, "kind">[]): string {
  if (harnesses.length === 0 || harnesses.some((h) => h.kind === "pi")) return "pi";
  return harnesses[0].kind;
}

/**
 * What the quick agent is sent: what the full create flow sends for a name, a key and a model with
 * every other step left as it opens. Each policy is composed from that flow's own starting fields,
 * so the two stay the same agent if a default moves; each comes out as nothing today, which the
 * server reads as its default.
 */
export function composeQuickAgent(input: {
  name: string;
  providerKeyId: string;
  defaultModel: string;
  harnessKind: string;
  harness: Harness | undefined;
  providerKeys: ProviderKey[];
  user: { caps: readonly string[] } | null | undefined;
  /** The host the app is served at, for the agent's default email. */
  host: string;
}): CreateAgentInput {
  const canGrant = can(input.user, "agents:policy");
  const modelPolicy = composeModelPolicy(
    input.providerKeyId,
    "*",
    input.defaultModel,
    input.providerKeys,
  );
  const toolPolicy = composeToolPolicy([]);
  const forgePolicy = composeForgePolicy(forgePolicyToFields(null));
  const networkPolicy = composeNetworkPolicy(networkPolicyToFields(null));
  const limitPolicy = composeLimitPolicy(limitPolicyToFields(null));
  const skillPolicy = composeSkillPolicy(skillPolicyToFields(null));
  return {
    name: input.name.trim(),
    email: effectiveEmail(input.name, "", "", input.host),
    harnessKind: input.harnessKind,
    ...(modelPolicy ? { modelPolicy } : {}),
    ...(toolPolicy ? { toolPolicy } : {}),
    ...(forgePolicy ? { forgePolicy } : {}),
    ...(networkPolicy ? { networkPolicy } : {}),
    ...(limitPolicy ? { limitPolicy } : {}),
    ...(skillPolicy ? { skillPolicy } : {}),
    memoryPolicy: composeMemoryPolicy(true, String(DEFAULT_MEMORY_BUDGET_TOKENS), false),
    canOpenPatches: true,
    canPublishArtifacts: canGrant,
    browserEnabled: createBrowserEnabled(canGrant, {
      offered: input.harness?.browser === true,
      canGrant,
    }),
  };
}

/** Where the last step sends someone: a new task with the agent and repo already picked. */
export function newTaskHref(agentId: string, repoId: string): string {
  const params = new URLSearchParams();
  if (agentId) params.set("agent", agentId);
  if (repoId) params.set("repo", repoId);
  const query = params.toString();
  return query ? `/tasks/create?${query}` : "/tasks/create";
}

// ── image downloads ─────────────────────────────────────────────────────────────────────────

/** Each image as a person would call what it is for. */
export const IMAGE_LABELS: Record<ImageName, string> = {
  agent: "Agent",
  harness: "Agent tools",
  universal: "Default environment",
  "run-gate": "Run network",
  "tool-guard": "Tool servers",
  browser: "Browser",
  buildkit: "Environment builder",
};

/** How often the downloads are asked about while one is still running. */
export const IMAGE_POLL_MS = 2000;

export type ImageSummary = {
  total: number;
  present: number;
  failed: number;
  /** Some are still downloading or waiting their turn, so it is worth asking again. */
  busy: boolean;
};

export function summarizeImages(images: readonly Pick<ImageStatus, "state">[]): ImageSummary {
  return {
    total: images.length,
    present: images.filter((i) => i.state === "present").length,
    failed: images.filter((i) => i.state === "failed").length,
    busy: images.some((i) => i.state === "pulling" || i.state === "queued"),
  };
}

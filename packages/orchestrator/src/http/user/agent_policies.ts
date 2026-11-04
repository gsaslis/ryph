import { supportedDialects } from "@ryph/model-proxy";
import type {
  ForgePolicy,
  ModelPolicy,
  NetworkPolicy,
  RunLimits,
  SkillPolicy,
  ToolPolicy,
} from "../../core/types.ts";
import {
  PLATFORM_FORGE_SERVER_ID,
  supportsSkills,
  supportsTools,
} from "../../core/harness_tools.ts";
import type { SkillCatalogue } from "../../ports/skill_catalogue.ts";
import { liveCeiling, resolveNetworkScope } from "../../core/egress.ts";
import { forgePolicyRepoIds } from "../../core/forge_tools.ts";
import { overCeiling } from "../../core/run_limits.ts";
import type { AppConfig, ModelAccess, ToolAccess, WiredDeps } from "../app.ts";
import type { TaskStore } from "../../ports/task_store.ts";
import { json } from "@ryph/shared/http";

/**
 * Whether an allowlist holds the same models. Membership is all an allowlist means, so neither
 * the order nor a repeat carries any.
 */
function sameAllowedModels(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((model) => right.has(model));
}

/** Whether two policies say the same thing, so a re-decision would reach the same verdict. */
export function sameModelPolicy(a: ModelPolicy | null, b: ModelPolicy | null): boolean {
  if (a === null || b === null) return a === b;
  const sameModels = a.allowedModels === "*" || b.allowedModels === "*"
    ? a.allowedModels === b.allowedModels
    : sameAllowedModels(a.allowedModels, b.allowedModels);
  return a.providerKeyId === b.providerKeyId && a.provider === b.provider &&
    a.defaultModel === b.defaultModel &&
    // A policy stored before the thinking default existed lacks the key; absent and null both
    // mean "the harness's own default", so they must not read as a move.
    (a.defaultThinking ?? null) === (b.defaultThinking ?? null) && sameModels;
}

/** Whether two tool allowlists hold the same names — a set, like the model allowlist. */
function sameAllowedTools(a: ToolPolicy["servers"][number]["allowedTools"], b: typeof a): boolean {
  if (a === "*" || b === "*") return a === b;
  return sameAllowedModels(a, b);
}

/** Whether two tool policies say the same thing: the same servers, each with the same tools.
 * The server list is a set too (the schema refuses a repeat), so order carries nothing. */
export function sameToolPolicy(a: ToolPolicy | null, b: ToolPolicy | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.servers.length !== b.servers.length) return false;
  const byId = new Map(b.servers.map((s) => [s.serverId, s.allowedTools]));
  return a.servers.every((s) => {
    const other = byId.get(s.serverId);
    return other !== undefined && sameAllowedTools(s.allowedTools, other);
  });
}

// Who may point an agent at a credential the operator holds. Setting or changing a policy binds
// a sealed secret — the provider key the agent spends, or the MCP credential the gateway
// substitutes on every tool call — to a blueprint any writer could then launch, so it takes
// `agents:policy` and not `agents:write`. CLEARING a policy (`null`) and every other edit stay
// with `agents:write`: taking access away needs no privilege, and an agent stranded by a policy
// must never need more than that to become usable again. Break-glass passes without a check,
// like it does at the repo gate — that token is already a total auth bypass. The run limits
// policy is gated the same way: it binds the ceiling an agent's runs get to spend under, which
// is no less a credential than a provider key.
export const POLICY = "agents:policy";

/** Whether two limit policies say the same thing, field for field. */
export function sameLimitPolicy(a: RunLimits | null, b: RunLimits | null): boolean {
  if (a === null || b === null) return a === b;
  return a.wallClockMs === b.wallClockMs && a.spendUsd === b.spendUsd &&
    a.callsInFlight === b.callsInFlight;
}

/**
 * Limits above the operator's ceiling are refused with the field that breaks them, under the
 * name the caller sent them as (`limitPolicy` on an agent, `limits` on a task): the ceiling is
 * the environment's to raise, never a form's.
 */
export function refuseOverCeiling(
  label: "limitPolicy" | "limits",
  limits: Partial<RunLimits>,
  ceiling: RunLimits,
): Response | null {
  const field = overCeiling(limits, ceiling);
  if (field === null) return null;
  return json(400, {
    error: `${label}.${field} is above the deployment's ceiling (${ceiling[field]})`,
    code: "over_ceiling",
    field,
  });
}

/** Whether two network policies say the same thing. Both lists are sets (the schema refuses a
 * repeat), so order carries nothing. */
export function sameNetworkPolicy(a: NetworkPolicy | null, b: NetworkPolicy | null): boolean {
  if (a === null || b === null) return a === b;
  const same = (x: string[], y: string[]) =>
    x.length === y.length && new Set(x).size === new Set([...x, ...y]).size;
  return same(a.bundles, b.bundles) && same(a.hosts, b.hosts);
}

/**
 * Checks a network policy against the one thing the schema cannot see: the DEPLOYMENT'S
 * CEILING. Returns the refusal to send, or null to proceed.
 *
 * The same shape as its three siblings, with one difference worth stating — this is the only
 * policy whose refusal is about widening rather than about a row that does not exist. An agent
 * narrows what the operator allowed and can never reach past it, so naming a bundle this
 * deployment does not offer dies here, at the form, rather than at the first run's `npm ci`.
 *
 * Note it is checked again at every launch (core/start_task.ts): a ceiling tightened after this
 * agent was saved must bind it, and only the launch can know that.
 */
export async function refuseNetworkPolicy(
  policy: NetworkPolicy,
  store: TaskStore,
  egress: AppConfig["egress"],
): Promise<Response | null> {
  const ceiling = await liveCeiling(store, egress.policy);
  // CHECKED EVEN WHEN THE MODE IS `open`, which is the one place this differs from its
  // siblings. `RYPH_EGRESS_BUNDLES` and `RYPH_EGRESS_HOSTS` are configured either way, so the
  // ceiling is readable and the narrowing question has an answer; `open` only means it is not
  // being enforced TODAY. Waving the check through there stores a policy that resolves to a
  // refusal, and the day the operator flips the mode on, `startTask` 400s for that agent and
  // the only place it surfaces is a failed task. The check is cheap and the mode is a flag an
  // operator flips — so it is made here, where there is a form to name the bundle in.
  const resolved = resolveNetworkScope(policy, { ...ceiling, mode: "proxy" });
  if (resolved.kind === "refused") return json(400, { error: resolved.error });
  return null;
}

/**
 * Checks a model policy against everything the schema cannot see: the live key rows and the
 * static harness capability registry. Returns the refusal to send, or null to proceed.
 *
 * The KEY IS FETCHED FIRST, which is the one thing to hold on to here. The harness check used
 * to be answerable from the policy alone, because a provider id was one of two compile-time
 * names; it is now whatever slug an admin gave a registered endpoint, and what a harness can
 * drive is a wire dialect, which only the key's provider knows. So the order runs: does the key
 * exist, is it live, is it the provider the policy claims, is that ENDPOINT still live — and
 * only then, knowing the dialect, can this harness drive it. Each refusal stays as specific as
 * it was: the caller is told which of those five things went wrong, never a single flattened
 * "invalid model policy".
 */
export async function refuseModelPolicy(
  policy: ModelPolicy,
  harnessKind: string,
  modelAccess: ModelAccess | null | undefined,
): Promise<Response | null> {
  if (!modelAccess) {
    return json(400, {
      error: "model access is not configured on this orchestrator",
    });
  }
  const key = await modelAccess.getKey(policy.providerKeyId);
  if (!key) return json(400, { error: `no such provider key "${policy.providerKeyId}"` });
  if (key.archivedAt !== null) {
    return json(400, { error: `provider key "${policy.providerKeyId}" is archived` });
  }
  if (key.provider !== policy.provider) {
    return json(400, {
      error: `provider key "${policy.providerKeyId}" is for "${key.provider}", ` +
        `not "${policy.provider}"`,
    });
  }
  // The endpoint's own kill switch, checked only once the key is known to name it. Archiving a
  // registered endpoint is as final as archiving a key — the credential issuer refuses both with
  // a definitive 400 — so an agent created against a withdrawn endpoint is an agent whose every
  // run boot-fails. Caught here for the same reason POST /v1/provider-keys catches it: a
  // mistake belongs at the keyboard, not at a run's boot.
  if (key.providerArchivedAt !== null) {
    return json(400, { error: `model endpoint "${policy.provider}" is archived` });
  }
  const dialects = supportedDialects(harnessKind);
  if (!dialects.includes(key.dialect)) {
    return json(400, {
      error: `harness kind "${harnessKind}" cannot drive provider "${policy.provider}" ` +
        `(${key.dialect})`,
      supportedDialects: dialects,
    });
  }
  return null;
}

/**
 * Checks a tool policy against everything the schema cannot see: the harness capability table
 * and the gateway's live server rows. Returns the refusal to send, or null to proceed. The same
 * shape as refuseModelPolicy, and for the same reason — an unknown or archived server should
 * die at the form, not at the run's first boot.
 */
export async function refuseToolPolicy(
  policy: ToolPolicy,
  harnessKind: string,
  toolAccess: ToolAccess | null | undefined,
): Promise<Response | null> {
  if (!toolAccess) {
    return json(400, { error: "tool access is not configured on this orchestrator" });
  }
  if (!supportsTools(harnessKind)) {
    return json(400, { error: `harness kind "${harnessKind}" cannot use tools` });
  }
  // The forge's tools are decided by the forge policy and nowhere else: a tool policy naming
  // the platform forge server would be a second, capless home for the same decision.
  if (policy.servers.some((s) => s.serverId === PLATFORM_FORGE_SERVER_ID)) {
    return json(400, {
      error: "the forge's tools are granted through the agent's forge policy, not its tool policy",
    });
  }
  // One budget for the whole fan-out, and the lookups run together inside it. The model policy
  // asks the proxy exactly once; a tool policy may name 32 servers, and asking them one after
  // another with a per-request deadline each pinned a handler for up to 32 × 10s per
  // authenticated request — a cheap way to hold the pool open and a 32× amplifier at the
  // gateway. The results still come back in policy order, so which bad server is named is
  // deterministic.
  const lookups = Promise.all(
    policy.servers.map(async ({ serverId }) => ({
      serverId,
      server: await toolAccess.getServer(serverId),
    })),
  );
  const found = await withinBudget(lookups, TOOL_POLICY_LOOKUP_BUDGET_MS);
  if (found === EXPIRED) {
    return json(504, { error: "the MCP gateway did not answer in time — try again" });
  }
  for (const { serverId, server } of found) {
    if (!server) return json(400, { error: `no such MCP server "${serverId}"` });
    if (server.archivedAt !== null) {
      return json(400, { error: `MCP server "${server.slug}" is archived` });
    }
  }
  return null;
}

/** A forge policy in one canonical spelling: the repo list and the labels are sets. */
function canonicalForgePolicy(p: ForgePolicy): string {
  return JSON.stringify({
    repos: p.repos === "run" ? "run" : [...p.repos.connectedRepoIds].sort(),
    read: p.read,
    createIssues: p.createIssues?.max ?? null,
    comment: p.comment === null ? null : [p.comment.where, p.comment.max],
    review: p.review === null ? null : [p.review.where, p.review.max],
    closeIssues: p.closeIssues === null ? null : [p.closeIssues.where, p.closeIssues.max],
    labels: p.labels.map((l) => l.toLowerCase()).sort(),
  });
}

/** Whether two forge policies say the same thing, so a re-decision would reach the same verdict. */
export function sameForgePolicy(a: ForgePolicy | null, b: ForgePolicy | null): boolean {
  if (a === null || b === null) return a === b;
  return canonicalForgePolicy(a) === canonicalForgePolicy(b);
}

/**
 * Checks a forge policy against everything the schema cannot see: whether this deployment serves
 * forge tools at all, the harness capability table, and the live connected repo rows a list
 * names. The refuseToolPolicy shape — a policy that could never work dies at the form, not
 * silently at every run's boot.
 */
export async function refuseForgePolicy(
  policy: ForgePolicy,
  harnessKind: string,
  deps: WiredDeps,
): Promise<Response | null> {
  if (deps.config.platformTools.forge === null) {
    // Also the answer while the gateway has not yet said whether it holds the row — saving a
    // forge policy in that window would save one no run could use, so "not configured yet" and
    // "not configured" are the same refusal, and it clears on its own within the minute.
    return json(400, { error: "forge tools are not configured on this orchestrator" });
  }
  if (!supportsTools(harnessKind)) {
    return json(400, { error: `harness kind "${harnessKind}" cannot use tools` });
  }
  for (const id of forgePolicyRepoIds(policy)) {
    const repo = await deps.store.getConnectedRepo(id);
    if (repo === null) return json(400, { error: `no such connected repo "${id}"` });
    if (repo.archivedAt !== null) {
      return json(400, { error: `connected repo "${repo.repoRef}" is disconnected` });
    }
  }
  return null;
}

/**
 * A skill policy as it is stored, or the refusal. It points at no secret and can only narrow what
 * the deployment allows, so `agents:write` is its whole gate. Catalogue names are held to the
 * shipped catalogue so a typo is a 400 rather than a switch that never matches, except a name
 * the agent's stored policy already held: a later release may have removed that skill, and an
 * edit must not fail over it, so it is dropped instead. A policy equal to the defaults is stored
 * as null, so "uses the defaults" stays true; any other policy needs a harness that reads skills,
 * since it would be inert otherwise.
 */
export function settleSkillPolicy(
  policy: SkillPolicy | null,
  previous: SkillPolicy | null,
  harnessKind: string,
  catalogue: SkillCatalogue | null | undefined,
): SkillPolicy | null | Response {
  if (policy === null) return null;
  const shipped = new Set(catalogue?.list().map((s) => s.name) ?? []);
  const held = new Set(previous?.catalogue.disabled ?? []);
  const unknown = policy.catalogue.disabled.find((n) => !shipped.has(n) && !held.has(n));
  if (unknown !== undefined) return json(400, { error: `no catalogue skill "${unknown}"` });
  const settled: SkillPolicy = {
    ...policy,
    catalogue: { disabled: policy.catalogue.disabled.filter((n) => shipped.has(n)) },
  };
  if (
    settled.catalogue.disabled.length === 0 && settled.org.enabled &&
    settled.org.disabled.length === 0 && settled.workingRepos.enabled
  ) return null;
  if (!supportsSkills(harnessKind)) {
    return json(400, { error: `harness kind "${harnessKind}" cannot use skills` });
  }
  return settled;
}

/**
 * The whole validation's deadline, not one lookup's. Wider than the adapter's own 10s
 * per-request timeout on purpose — concurrent lookups all land inside that, so this only has to
 * catch the case where the adapter's deadline is not what bounds us (an in-process issuer, a
 * slow store) and turn it into an answer instead of a held connection.
 */
const TOOL_POLICY_LOOKUP_BUDGET_MS = 15_000;

const EXPIRED = Symbol("budget expired");

/**
 * Resolves `work`, or `EXPIRED` once the budget lapses. A throw still propagates — "the gateway
 * could not answer" must stay distinguishable from "the gateway said no", which is the whole
 * doctrine of the ToolAccess adapter. The abandoned work is left to settle on its own; the
 * point is to bound the REQUEST, and its per-call deadlines bound the rest.
 */
function withinBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | typeof EXPIRED> {
  const signal = AbortSignal.timeout(budgetMs);
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    signal.addEventListener("abort", () => resolve(EXPIRED), { once: true });
  });
  return Promise.race([work, expired]);
}

// The bridge between the form's tool grants and the API's ToolPolicy shape, shared by the create
// and edit flows so both compose, seed and validate identically — the model-policy bridge, one
// credential class over.

import type { AllowedTools, McpServer, ToolPolicy } from "$lib/api/types";

/** The form's working shape for one server: the server, and which of its tools the agent may call. */
export interface ToolGrant {
  serverId: string;
  allowedTools: AllowedTools;
  /**
   * Set on a server just switched on whose catalogue entry leaves some tools off by default. Its
   * `"*"` is a placeholder until the probe narrows it or the operator picks, and it never saves:
   * a probe that fails must not let the writes through. Form state only, never sent.
   */
  pendingDefaultOff?: true;
}

/** The grant as the operator's own choice: no longer waiting to be narrowed. */
function decided({ pendingDefaultOff: _, ...grant }: ToolGrant): ToolGrant {
  return grant;
}

/** Builds the policy from the grants; no grants means no tool access (null). */
export function composeToolPolicy(grants: ToolGrant[]): ToolPolicy | null {
  if (grants.length === 0) return null;
  return { servers: grants.map((g) => ({ serverId: g.serverId, allowedTools: g.allowedTools })) };
}

/** Seeds the grants from an existing policy (the edit flow). */
export function policyToGrants(policy: ToolPolicy | null): ToolGrant[] {
  if (!policy) return [];
  return policy.servers.map((s) => ({ serverId: s.serverId, allowedTools: s.allowedTools }));
}

/**
 * Why the grants cannot be saved as they stand, in the operator's words — or null when they can.
 * Each of these is a refusal the orchestrator would make anyway; catching it here means the form
 * says which server and why, instead of a 400 naming an id.
 *
 * An empty explicit allowlist is refused rather than sent — for an OPERATOR'S server. A server
 * with no callable tool is not a grant, and letting it through would save a policy that looks
 * like access and gives none, when removing the row says the same thing plainly.
 *
 * A PLATFORM server is the exception, and the reason is that removing the row does NOT say the
 * same thing there. The platform's rows are granted by default — memory to a remembering agent,
 * the web tools to every tool-capable one — so "no entry" means "whatever the deployment gives
 * everyone", and an empty entry is the only way to write down "this agent gets none of it". It
 * is a real state with a real effect: the row stays in the run's frozen scope, and the gateway
 * then denies every tool on it and hides all of them from `tools/list`.
 */
export function toolPolicyProblem(grants: ToolGrant[], mcpServers: McpServer[]): string | null {
  for (const grant of grants) {
    const server = mcpServers.find((s) => s.id === grant.serverId);
    const label = server ? `"${server.name}"` : `server ${grant.serverId}`;
    if (server?.archivedAt) return `${label} is archived — remove it from this agent's tools.`;
    if (grant.pendingDefaultOff) return `Check the tools on ${label} before saving.`;
    if (
      grant.allowedTools !== "*" && grant.allowedTools.length === 0 &&
      server?.kind !== "platform"
    ) {
      return `Tick at least one tool on ${label}, or remove the server.`;
    }
  }
  return null;
}

/**
 * What an empty allowlist MEANS for this server, for the form to show beside it. Null when the
 * state is not reachable (an operator's server, where it is refused above).
 */
export function noToolsLabel(server: McpServer): string | null {
  return server.kind === "platform" ? "No tools from this server" : null;
}

/** The grant with `tool` allowed or not. Leaves a `"*"` grant alone: every tool is already in. */
export function withTool(grant: ToolGrant, tool: string, allowed: boolean): ToolGrant {
  if (grant.allowedTools === "*") return decided(grant);
  const rest = grant.allowedTools.filter((t) => t !== tool);
  return { ...decided(grant), allowedTools: allowed ? [...rest, tool] : rest };
}

/**
 * The grant switched between "every tool" and an explicit list. Coming off `"*"`, the list starts
 * as whatever the operator can see (`known`, the probe's names) so the change is visible in place
 * rather than an empty list that saves as nothing.
 */
export function withEveryTool(grant: ToolGrant, every: boolean, known: string[]): ToolGrant {
  if (every) return { ...decided(grant), allowedTools: "*" };
  return {
    ...decided(grant),
    allowedTools: grant.allowedTools === "*" ? [...known] : grant.allowedTools,
  };
}

/** What the gateway's allowlist grammar accepts as a tool name; a probed name outside it cannot be ticked. */
export function isAllowlistable(tool: string): boolean {
  return /^[A-Za-z0-9_.-]{1,128}$/.test(tool);
}

/** A hint the picker shows beside a tool, derived from the server's own annotations. */
export interface AnnotationHint {
  label: string;
  /** `warn` for a claim the operator should weigh before ticking; `note` for the reassuring ones. */
  tone: "warn" | "note";
}

/**
 * The MCP tool annotations as short labels. Only EXPLICIT claims are shown — the spec's defaults
 * (destructive, open-world) are what a server says by saying nothing, and a badge for silence
 * would read as a verdict. These are the server's claims about itself, never verified: the UI
 * labels them as such.
 */
export function annotationHints(annotations: Record<string, unknown> | null): AnnotationHint[] {
  if (annotations === null) return [];
  const hints: AnnotationHint[] = [];
  if (annotations.readOnlyHint === true) hints.push({ label: "read-only", tone: "note" });
  if (annotations.destructiveHint === true) hints.push({ label: "destructive", tone: "warn" });
  if (annotations.destructiveHint === false) hints.push({ label: "non-destructive", tone: "note" });
  if (annotations.idempotentHint === true) hints.push({ label: "idempotent", tone: "note" });
  if (annotations.openWorldHint === true) hints.push({ label: "open world", tone: "warn" });
  return hints;
}

/**
 * A grant the operator just switched on, once the probe has listed the server's tools: every
 * reported tool EXCEPT the catalogue entry's `defaultOff` ones, which write or change things and
 * are left for the operator to tick. Only a `"*"` grant is narrowed — anything else is already a
 * choice someone made — and only when the entry names tools to leave off. The list is explicit
 * even when none of those tools is reported today, so one the server adds later is not let in.
 * Either way the grant is no longer pending.
 */
export function withDefaultOff(
  grant: ToolGrant,
  reported: string[],
  defaultOff: string[],
): ToolGrant {
  if (grant.allowedTools !== "*" || defaultOff.length === 0) return decided(grant);
  const off = new Set(defaultOff);
  const allowed = [...new Set(reported)].filter((t) => !off.has(t) && isAllowlistable(t));
  return { ...decided(grant), allowedTools: allowed };
}

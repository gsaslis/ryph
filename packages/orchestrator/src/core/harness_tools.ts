// Which harness kinds can drive MCP tools — the capability half of "which tools can this agent
// use", the sibling of @ryph/model-proxy's HARNESS_DIALECTS. It lives here rather than in the
// gateway because a harness kind is the orchestrator's concept (it names an agent-container
// image) and the gateway never learns which harness is dialing it.
//
// pi loads the ryph MCP extension the image ships; echo fakes an agent and calls nothing. An
// unknown kind supports no tools: the table fails closed, exactly like the dialect one.

export const HARNESS_TOOLS: Record<string, boolean> = {
  pi: true,
  echo: false,
};

/**
 * The gateway's platform chat server, by the FIXED id the gateway seeds it under — a run's
 * frozen scope and the seed must agree forever. The value is @ryph/mcp-gateway's
 * (`PLATFORM_CHAT_SERVER_ID` in its platform entry point); it is spelled here rather than
 * imported so this core stays free of the gateway package, and the two must be kept in step.
 */
export const PLATFORM_CHAT_SERVER_ID = "ms-platform-chat";

/**
 * The gateway's platform forge server — the forge's issue and pull request tools. Same fixed-id
 * rule as chat's; `PLATFORM_FORGE_SERVER_ID` in @ryph/mcp-gateway's platform entry point. It is
 * never named in a tool policy: the agent's forge policy is the one place it is decided.
 */
export const PLATFORM_FORGE_SERVER_ID = "ms-platform-forge";

/**
 * Whether a harness kind can use a tool policy at all. Unknown kinds cannot (fail closed).
 *
 * `Object.hasOwn` and not `?? false`: a harness kind is validated as a lowercase slug, and
 * "constructor" is a lowercase slug. A plain `HARNESS_TOOLS[kind]` reads straight through
 * `Object.prototype` for that one name and hands back the `Object` constructor — truthy, through
 * a `boolean` signature, so the one table meant to refuse every unknown kind admitted it. Own
 * key AND literally `true`, so neither the prototype chain nor a future non-boolean value can
 * become a yes.
 */
export function supportsTools(harnessKind: string): boolean {
  return Object.hasOwn(HARNESS_TOOLS, harnessKind) && HARNESS_TOOLS[harnessKind] === true;
}

/**
 * Which harness kinds can load skills (core/skills.ts) — the same fail-closed table as
 * `HARNESS_TOOLS`, for the same reason. pi reads a skill from each `--skill` path the runner
 * hands it; echo fakes an agent and reads nothing, so nothing is frozen for it.
 */
export const HARNESS_SKILLS: Record<string, boolean> = {
  pi: true,
  echo: false,
};

/** Whether a harness kind can load skills at all. Unknown kinds cannot (fail closed), read the
 * way `supportsTools` reads its table. */
export function supportsSkills(harnessKind: string): boolean {
  return Object.hasOwn(HARNESS_SKILLS, harnessKind) && HARNESS_SKILLS[harnessKind] === true;
}

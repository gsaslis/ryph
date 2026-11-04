import { z } from "zod";
import { apiCall } from "./call";
import {
  type Agent,
  agentSchema,
  type ForgePolicy,
  type MemoryPolicy,
  type ModelPolicy,
  type NetworkPolicy,
  type RunLimits,
  type SkillPolicy,
  type ToolPolicy,
} from "./types";

export type CreateAgentInput = {
  name: string;
  /** Absent = the server derives one from the name. */
  handle?: string;
  email: string;
  systemPrompt?: string;
  harnessKind: string;
  modelPolicy?: ModelPolicy;
  toolPolicy?: ToolPolicy;
  /** Absent = the default policy (the agent remembers); `null` = memory off. */
  memoryPolicy?: MemoryPolicy | null;
  /** Absent or `null` = no issue and change request tools. */
  forgePolicy?: ForgePolicy | null;
  /** Absent or `null` = whatever this deployment allows. A policy narrows that; two empty
   * lists is an agent with no internet at all. */
  networkPolicy?: NetworkPolicy | null;
  /** Absent or `null` = the deployment's ceiling. Set, each field lowers it for this agent. */
  limitPolicy?: RunLimits | null;
  /** Absent or `null` = every skill the deployment allows. Set, it turns some of them off. */
  skillPolicy?: SkillPolicy | null;
  /** Absent = true. False: the agent's runs never open patches. */
  canOpenPatches?: boolean;
  /** Absent = false. True: the agent's runs may publish artifacts. */
  canPublishArtifacts?: boolean;
  /** Absent = false. True: the agent's runs get a browser. */
  browserEnabled?: boolean;
};

export type UpdateAgentInput = {
  name?: string;
  handle?: string;
  email?: string;
  systemPrompt?: string | null;
  harnessKind?: string;
  /** `null` clears the policy; absent leaves it alone. */
  modelPolicy?: ModelPolicy | null;
  /** Same rule: `null` revokes future runs' tool access, absent leaves the policy alone. */
  toolPolicy?: ToolPolicy | null;
  /** Same rule: `null` turns memory off for future runs, absent leaves it alone. */
  memoryPolicy?: MemoryPolicy | null;
  /** Same rule: `null` takes the issue and change request tools away, absent leaves them alone. */
  forgePolicy?: ForgePolicy | null;
  /** The one field whose `null` WIDENS: it hands the agent the deployment's full allowlist back,
   * which is why setting it either way is an admin's call. Absent leaves it alone. */
  networkPolicy?: NetworkPolicy | null;
  /** Same rule as the forge policy: `null` hands the runs back to the ceiling, absent leaves
   * the policy alone. Setting one is an admin's call; clearing one is anyone's. */
  limitPolicy?: RunLimits | null;
  /** `null` hands the agent back every skill the deployment allows, and no more; absent leaves
   * the policy alone. Anyone who can edit the agent can set it, since it only narrows. */
  skillPolicy?: SkillPolicy | null;
  /** Switching patches off is anyone's call; switching them back on is an admin's. */
  canOpenPatches?: boolean;
  /** Absent leaves it alone. */
  canPublishArtifacts?: boolean;
  /** Absent leaves it alone. */
  browserEnabled?: boolean;
};

export async function getAgents(f = fetch): Promise<Agent[]> {
  const res = await apiCall(f, "/v1/agents");
  return z.object({ agents: z.array(agentSchema) }).parse(res).agents;
}

export async function getAgent(f = fetch, id: string): Promise<Agent> {
  return agentSchema.parse(await apiCall(f, `/v1/agents/${encodeURIComponent(id)}`));
}

export async function createAgent(f = fetch, input: CreateAgentInput): Promise<Agent> {
  return agentSchema.parse(
    await apiCall(f, "/v1/agents", { method: "POST", body: JSON.stringify(input) }),
  );
}

export async function updateAgent(f = fetch, id: string, input: UpdateAgentInput): Promise<Agent> {
  return agentSchema.parse(
    await apiCall(f, `/v1/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function archiveAgent(f = fetch, id: string): Promise<Agent> {
  return agentSchema.parse(
    await apiCall(f, `/v1/agents/${encodeURIComponent(id)}/archive`, { method: "POST" }),
  );
}

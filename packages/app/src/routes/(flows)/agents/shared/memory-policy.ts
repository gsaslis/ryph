// The bridge between the form's two memory fields and the API's MemoryPolicy, shared by the create
// and edit flows so both parse and seed identically.

import { DEFAULT_MEMORY_BUDGET_TOKENS, type MemoryPolicy } from "$lib/api/types";

/** The policy from the form: off is null, on is the budget as typed (or the default when blank). */
export function composeMemoryPolicy(
  remembers: boolean,
  budget: string,
  agentOnly = false,
): MemoryPolicy | null {
  if (!remembers) return null;
  const parsed = Number(budget.trim());
  const budgetTokens = budget.trim() === "" || !Number.isFinite(parsed) || parsed < 0
    ? DEFAULT_MEMORY_BUDGET_TOKENS
    : Math.floor(parsed);
  return { budgetTokens, ...(agentOnly ? { agentOnly: true } : {}) };
}

/** Seeds the form from an existing policy (the edit flow); a new agent remembers by default. */
export function memoryPolicyToFields(
  policy: MemoryPolicy | null,
): { remembers: boolean; memoryBudget: string; memoryAgentOnly: boolean } {
  if (policy === null) {
    return {
      remembers: false,
      memoryBudget: String(DEFAULT_MEMORY_BUDGET_TOKENS),
      memoryAgentOnly: false,
    };
  }
  return {
    remembers: true,
    memoryBudget: String(policy.budgetTokens),
    memoryAgentOnly: policy.agentOnly ?? false,
  };
}

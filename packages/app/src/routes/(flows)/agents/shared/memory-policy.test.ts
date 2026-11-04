import { describe, expect, it } from "vitest";
import { composeMemoryPolicy, memoryPolicyToFields } from "./memory-policy";

describe("the memory policy fields", () => {
  it("round-trips agent-only memory and clears it when memory is disabled", () => {
    const policy = composeMemoryPolicy(true, "0", true);
    expect(policy).toEqual({ budgetTokens: 0, agentOnly: true });
    expect(memoryPolicyToFields(policy)).toEqual({
      remembers: true,
      memoryBudget: "0",
      memoryAgentOnly: true,
    });
    expect(composeMemoryPolicy(false, "2000", true)).toBeNull();
  });
  it("composes off as null and on as the typed budget, defaulting a blank one", () => {
    expect(composeMemoryPolicy(false, "500")).toBeNull();
    expect(composeMemoryPolicy(true, "500")).toEqual({ budgetTokens: 500 });
    expect(composeMemoryPolicy(true, "")).toEqual({ budgetTokens: 2000 });
    expect(composeMemoryPolicy(true, "abc")).toEqual({ budgetTokens: 2000 });
    expect(composeMemoryPolicy(true, "0")).toEqual({ budgetTokens: 0 });
    expect(composeMemoryPolicy(true, "12.9")).toEqual({ budgetTokens: 12 });
  });

  it("seeds the form from a policy, and on by default without one", () => {
    expect(memoryPolicyToFields({ budgetTokens: 900 })).toEqual({
      remembers: true,
      memoryBudget: "900",
      memoryAgentOnly: false,
    });
    expect(memoryPolicyToFields(null)).toEqual({
      remembers: false,
      memoryBudget: "2000",
      memoryAgentOnly: false,
    });
  });
});

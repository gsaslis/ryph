import { describe, expect, it } from "vitest";
import { declaredModelSchema, modelPolicySchema, THINKING_LEVELS } from "./types";

// Thinking levels on the wire: an agent's default on its model policy, and which levels each
// model on the provider list takes.

describe("thinking levels", () => {
  it("are pi's, least to most", () => {
    expect([...THINKING_LEVELS]).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("ride a model on the provider list, a level this build does not know dropped", () => {
    expect(
      declaredModelSchema.parse({ id: "m", thinkingLevels: ["low", "turbo", "max"] })
        .thinkingLevels,
    ).toEqual(["low", "max"]);
    // Absent is not known: every level is offered.
    expect(declaredModelSchema.parse({ id: "m" }).thinkingLevels).toBeUndefined();
  });

  it("an agent's default is one of them, or null", () => {
    const policy = {
      providerKeyId: "pk-1",
      provider: "anthropic",
      allowedModels: "*",
      defaultModel: null,
    };
    expect(modelPolicySchema.parse({ ...policy, defaultThinking: "high" }).defaultThinking).toBe(
      "high",
    );
    expect(modelPolicySchema.parse({ ...policy, defaultThinking: null }).defaultThinking)
      .toBeNull();
    expect(modelPolicySchema.safeParse({ ...policy, defaultThinking: "none" }).success).toBe(false);
  });
});

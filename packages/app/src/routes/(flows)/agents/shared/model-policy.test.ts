import { describe, expect, it } from "vitest";
import type { Provider, ProviderKey } from "$lib/api/types";
import {
  composeModelPolicy,
  defaultModelThinkingLevels,
  editedDefaultThinking,
  modelPolicyProblem,
  policyToFields,
  usableProviderKeys,
} from "./model-policy";

const KEY: ProviderKey = {
  id: "key-1",
  provider: "anthropic",
  label: "Team",
  last4: "abcd",
  archivedAt: null,
  createdAt: "2026-10-02T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
};

describe("composeModelPolicy", () => {
  it("is null without a key, and carries the key's provider with one", () => {
    expect(composeModelPolicy("", "*", "", [KEY])).toBeNull();
    expect(composeModelPolicy("key-1", ["claude-sonnet-5", " "], " claude-sonnet-5 ", [KEY]))
      .toEqual({
        providerKeyId: "key-1",
        provider: "anthropic",
        allowedModels: ["claude-sonnet-5"],
        defaultModel: "claude-sonnet-5",
        defaultThinking: null,
      });
    expect(composeModelPolicy("key-1", "*", "", [KEY], "high")?.defaultThinking).toBe("high");
  });

  it("sends each id once", () => {
    expect(composeModelPolicy("key-1", ["a", "a ", "b"], "", [KEY])?.allowedModels).toEqual([
      "a",
      "b",
    ]);
  });

  it("round-trips through policyToFields", () => {
    const policy = composeModelPolicy("key-1", ["a", "b"], "", [KEY]);
    const fields = policyToFields(policy);
    expect(fields).toEqual({
      providerKeyId: "key-1",
      allowedModels: ["a", "b"],
      defaultModel: "",
      defaultThinking: null,
    });
  });

  it("carries the thinking default both ways, so an edit does not clear it", () => {
    const policy = composeModelPolicy("key-1", "*", "a", [KEY], "xhigh");
    const fields = policyToFields(policy);
    expect(fields.defaultThinking).toBe("xhigh");
    expect(
      composeModelPolicy(
        fields.providerKeyId,
        fields.allowedModels,
        fields.defaultModel,
        [KEY],
        fields.defaultThinking,
      ),
    ).toEqual(policy);
    expect(policyToFields(null).defaultThinking).toBeNull();
  });
});

describe("modelPolicyProblem", () => {
  it("wants a non-empty list, with the default inside it", () => {
    expect(modelPolicyProblem("", [], "")).toBeNull();
    expect(modelPolicyProblem("key-1", "*", "anything")).toBeNull();
    expect(modelPolicyProblem("key-1", [], "")).toMatch(/at least one/);
    expect(modelPolicyProblem("key-1", ["a"], "b")).toMatch(/default/);
    expect(modelPolicyProblem("key-1", ["a"], "a")).toBeNull();
    expect(modelPolicyProblem("key-1", ["a"], "")).toBeNull();
    expect(modelPolicyProblem("key-1", [" "], "")).toMatch(/at least one/);
    expect(modelPolicyProblem("key-1", [" a "], "a")).toBeNull();
  });
});

describe("usableProviderKeys", () => {
  const key = (id: string, provider: string, extra: Partial<ProviderKey> = {}): ProviderKey => ({
    id,
    provider,
    label: id,
    last4: "abcd",
    archivedAt: null,
    createdAt: "2026-10-12T00:00:00Z",
    updatedAt: "2026-10-12T00:00:00Z",
    ...extra,
  });
  const provider = (id: string, dialect: string, archivedAt: string | null = null): Provider => ({
    id,
    label: id,
    dialect,
    builtin: false,
    baseUrl: "https://example.test/v1",
    authHeader: "authorization",
    authScheme: "Bearer",
    models: [],
    archivedAt,
  });
  const plan = {
    email: null,
    planType: null,
    status: "active" as const,
    limitedAt: null,
    models: [],
  };
  const providers = [
    provider("anthropic", "anthropic-messages"),
    provider("groq", "openai-completions"),
    provider("old", "openai-completions", "2026-01-01T00:00:00Z"),
  ];
  const keys = [
    key("a", "anthropic"),
    key("g", "groq"),
    key("o", "old"),
    key("x", "anthropic", { archivedAt: "2026-01-01T00:00:00Z" }),
    key("u", "unlisted"),
    key("p", "chatgpt-plan", { plan }),
  ];

  it("keeps live keys the harness can drive, and ones whose provider did not answer", () => {
    const usable = usableProviderKeys(keys, providers, { dialects: ["anthropic-messages"] });
    expect(usable.map((k) => k.id)).toEqual(["a", "u"]);
  });

  it("offers every live key on a live provider without a harness", () => {
    expect(usableProviderKeys(keys, providers, undefined).map((k) => k.id)).toEqual([
      "a",
      "g",
      "u",
    ]);
  });
});

describe("defaultModelThinkingLevels", () => {
  const providers = [{
    id: "anthropic",
    builtin: true,
    models: [{ id: "big", thinkingLevels: ["off", "low", "high"] }, { id: "plain" }],
  }, {
    id: "groq",
    builtin: false,
    models: [{ id: "thinks", reasoning: true }, { id: "plain" }],
  }] as unknown as Provider[];
  const CUSTOM_KEY: ProviderKey = { ...KEY, id: "key-2", provider: "groq" };

  it("reads the default model's levels off the key's provider", () => {
    expect(defaultModelThinkingLevels(providers, [KEY], "key-1", "big")).toEqual([
      "off",
      "low",
      "high",
    ]);
  });

  it("offers every level for no default, an undeclared model or no key", () => {
    expect(defaultModelThinkingLevels(providers, [KEY], "key-1", "")).toHaveLength(7);
    expect(defaultModelThinkingLevels(providers, [KEY], "key-1", "plain")).toHaveLength(7);
    expect(defaultModelThinkingLevels(providers, [KEY], "", "big")).toHaveLength(7);
  });

  it("offers what pi gives a custom endpoint's model with no levels named", () => {
    const keys = [KEY, CUSTOM_KEY];
    expect(defaultModelThinkingLevels(providers, keys, "key-2", "thinks")).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(defaultModelThinkingLevels(providers, keys, "key-2", "plain")).toEqual(["off"]);
    expect(defaultModelThinkingLevels(providers, keys, "key-2", "typed")).toEqual(["off"]);
  });

  it("reads the stored policy's provider for a key the list cannot resolve", () => {
    const stored = {
      providerKeyId: "key-2",
      provider: "groq",
      allowedModels: "*" as const,
      defaultModel: "plain",
      defaultThinking: null,
    };
    expect(defaultModelThinkingLevels(providers, [], "key-2", "plain", stored)).toEqual(["off"]);
    // Only for the key the policy names: another one is not known, and stays open.
    expect(defaultModelThinkingLevels(providers, [], "key-3", "plain", stored)).toHaveLength(7);
  });
});

describe("editedDefaultThinking", () => {
  const seeded = { providerKeyId: "key-1", defaultModel: "plain" };

  it("keeps the stored level while the key and default model are as loaded", () => {
    // The model now takes only off, so the pick is hidden: saving must not clear it.
    expect(editedDefaultThinking(seeded, "key-1", "plain", "high", ["off"])).toBe("high");
    expect(editedDefaultThinking(seeded, "key-1", " plain ", "high", ["off"])).toBe("high");
    expect(editedDefaultThinking(seeded, "key-1", "plain", "low", ["off", "low"])).toBe("low");
  });

  it("drops it once the person moves to a model that takes no level", () => {
    expect(editedDefaultThinking(seeded, "key-1", "other", "high", ["off"])).toBeNull();
    expect(editedDefaultThinking(seeded, "key-2", "plain", "high", ["off"])).toBeNull();
    expect(editedDefaultThinking(seeded, "key-1", "other", "high", ["off", "high"])).toBe("high");
  });
});

import { describe, expect, it } from "vitest";
import type { DeclaredModel, Provider, ProviderKey } from "$lib/api/types";
import {
  choicesFor,
  INCLUDED_LABEL,
  modelsForKey,
  modelsOf,
  priceHint,
  priceLabel,
  thinkingLevelsForKey,
} from "./models";

const SONNET: DeclaredModel = {
  id: "claude-sonnet-5",
  price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};
const HAIKU: DeclaredModel = { id: "claude-haiku-4-5" };

const ANTHROPIC: Provider = {
  id: "anthropic",
  label: "Anthropic",
  dialect: "anthropic-messages",
  builtin: true,
  baseUrl: "https://api.anthropic.com",
  authHeader: "x-api-key",
  authScheme: null,
  models: [SONNET, HAIKU],
  archivedAt: null,
};

describe("modelsOf", () => {
  it("is the provider's list, and empty for one it cannot find", () => {
    expect(modelsOf([ANTHROPIC], "anthropic")).toEqual([SONNET, HAIKU]);
    expect(modelsOf([ANTHROPIC], "groq")).toEqual([]);
    expect(modelsOf([ANTHROPIC], undefined)).toEqual([]);
  });
});

describe("choicesFor", () => {
  it("offers every model for any, else the list once each, unknown ids kept bare", () => {
    expect(choicesFor([SONNET, HAIKU], "*")).toEqual([SONNET, HAIKU]);
    expect(choicesFor([SONNET, HAIKU], ["claude-haiku-4-5", "mine", "mine"])).toEqual([
      HAIKU,
      { id: "mine" },
    ]);
  });
});

describe("priceLabel", () => {
  it("reads input and output in dollars, and is null when unpriced", () => {
    expect(priceLabel(SONNET)).toBe("$2 / $10");
    expect(
      priceLabel({ id: "x", price: { input: 0.075, output: 1.25, cacheRead: 0, cacheWrite: 0 } }),
    )
      .toBe("$0.075 / $1.25");
    expect(priceLabel(HAIKU)).toBeNull();
  });
});

const PLAN_PROVIDER: Provider = {
  id: "chatgpt-plan",
  label: "ChatGPT plan",
  dialect: "openai-responses",
  builtin: true,
  baseUrl: "https://api.openai.com/v1",
  authHeader: "authorization",
  authScheme: "Bearer",
  models: [
    { id: "gpt-5.5", label: "GPT-5.5", pricing: "included" },
    { id: "gpt-5.5-mini", pricing: "included" },
  ],
  archivedAt: null,
};

const key = (provider: string, plan?: ProviderKey["plan"]): ProviderKey => ({
  id: "pk-1",
  provider,
  label: "k",
  last4: "abcd",
  plan,
  archivedAt: null,
  createdAt: "2026-10-07T12:00:00.000Z",
  updatedAt: "2026-10-07T12:00:00.000Z",
});

describe("modelsForKey", () => {
  it("is the provider's list for an API key", () => {
    expect(modelsForKey([ANTHROPIC], key("anthropic"))).toEqual([SONNET, HAIKU]);
    expect(modelsForKey([ANTHROPIC], undefined)).toEqual([]);
  });

  it("falls back to the policy's provider entry with no key in hand", () => {
    expect(modelsForKey([ANTHROPIC], undefined, "anthropic")).toEqual([SONNET, HAIKU]);
    expect(modelsForKey([ANTHROPIC], undefined, "groq")).toEqual([]);
    // A key in hand wins over the stand-in.
    expect(modelsForKey([ANTHROPIC], key("groq"), "anthropic")).toEqual([]);
  });

  it("is the plan key's own list, each as the key lists it and included", () => {
    const plan = {
      email: null,
      planType: null,
      status: "active" as const,
      limitedAt: null,
      models: [{ id: "gpt-5.5", label: "GPT-5.5", reasoning: true }, { id: "o-new" }],
    };
    expect(modelsForKey([PLAN_PROVIDER], key("chatgpt-plan", plan))).toEqual([
      { id: "gpt-5.5", label: "GPT-5.5", reasoning: true, pricing: "included" },
      { id: "o-new", pricing: "included" },
    ]);
  });
});

describe("thinkingLevelsForKey", () => {
  // The provider entry is every plan key's models at once, the first key's entry winning an id;
  // each key carries its own account's.
  const union: Provider = {
    ...PLAN_PROVIDER,
    models: [
      { id: "gpt-5.5", pricing: "included", thinkingLevels: ["low", "high", "xhigh"] },
      { id: "o-other", pricing: "included", thinkingLevels: ["low", "max"] },
    ],
  };
  const plan = (models: DeclaredModel[]) => ({
    email: null,
    planType: null,
    status: "active" as const,
    limitedAt: null,
    models,
  });
  const mine = key(
    "chatgpt-plan",
    plan([{ id: "gpt-5.5", thinkingLevels: ["low", "high", "xhigh"] }]),
  );
  const theirs = key(
    "chatgpt-plan",
    plan([{ id: "gpt-5.5", thinkingLevels: ["medium"] }, {
      id: "o-other",
      thinkingLevels: ["low", "max"],
    }]),
  );

  it("reads a model's levels off the key's own account, not every plan key's", () => {
    expect(thinkingLevelsForKey([union], mine, "gpt-5.5")).toEqual(["low", "high", "xhigh"]);
    expect(thinkingLevelsForKey([union], theirs, "o-other")).toEqual(["low", "max"]);
    // Another account's model reaches pi as its id alone on this key: off only.
    expect(thinkingLevelsForKey([union], mine, "o-other")).toEqual(["off"]);
  });

  it("tells two accounts listing one model with different levels apart", () => {
    expect(thinkingLevelsForKey([union], mine, "gpt-5.5")).toEqual(["low", "high", "xhigh"]);
    expect(thinkingLevelsForKey([union], theirs, "gpt-5.5")).toEqual(["medium"]);
  });

  it("gives a reasoning plan model with no levels pi's defaults, any other off only", () => {
    const k = key("chatgpt-plan", plan([{ id: "r", reasoning: true }, { id: "n" }]));
    expect(thinkingLevelsForKey([union], k, "r")).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(thinkingLevelsForKey([union], k, "n")).toEqual(["off"]);
  });

  it("offers every level with no key or no model", () => {
    expect(thinkingLevelsForKey([union], undefined, "gpt-5.5")).toHaveLength(7);
    expect(thinkingLevelsForKey([union], mine, "")).toHaveLength(7);
  });

  it("reads the provider entry when the key is not in hand, as declared to pi", () => {
    // The keys did not load, or the agent's key is not among them: the plan entry's levels,
    // and pi's defaults for what it does not name, rather than every level.
    expect(thinkingLevelsForKey([union], undefined, "o-other", "chatgpt-plan")).toEqual([
      "low",
      "max",
    ]);
    expect(thinkingLevelsForKey([union], undefined, "typed", "chatgpt-plan")).toEqual(["off"]);
    // A built-in's entry still opens every level for a model it does not know.
    expect(thinkingLevelsForKey([ANTHROPIC], undefined, "typed", "anthropic")).toHaveLength(7);
  });
});

describe("an included model", () => {
  it("reads as included in the plan, with no per-token hint", () => {
    const model: DeclaredModel = { id: "gpt-5.5", pricing: "included" };
    expect(priceLabel(model)).toBe(INCLUDED_LABEL);
    expect(INCLUDED_LABEL).toBe("Included in your ChatGPT plan");
    expect(priceHint(model)).toBeUndefined();
    expect(priceHint(SONNET)).toBeDefined();
  });
});

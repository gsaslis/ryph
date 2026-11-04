import { describe, expect, it } from "vitest";
import { type DeclaredModel, type Provider, THINKING_LEVELS } from "$lib/api/types";
import { declaredToPi } from "./models";
import {
  offersThinking,
  THINKING_LABELS,
  thinkingInvalid,
  thinkingLevelsFor,
  thinkingToSend,
} from "./thinking";

const MODELS: DeclaredModel[] = [
  { id: "big", thinkingLevels: ["off", "low", "medium", "high"] },
  { id: "plain", thinkingLevels: ["off"] },
  { id: "unknown" },
  { id: "no-reasoning", reasoning: false },
  { id: "reasons", reasoning: true },
];

const OFF_TO_HIGH = ["off", "minimal", "low", "medium", "high"];

describe("thinkingLevelsFor", () => {
  it("is the model's declared list, whoever's model it is", () => {
    for (const declared of [false, true]) {
      expect(thinkingLevelsFor(MODELS, "big", declared)).toEqual(["off", "low", "medium", "high"]);
      expect(thinkingLevelsFor(MODELS, " big ", declared)).toEqual([
        "off",
        "low",
        "medium",
        "high",
      ]);
      expect(thinkingLevelsFor(MODELS, "plain", declared)).toEqual(["off"]);
    }
  });

  it("is every level when no model is picked, whoever's model it is", () => {
    expect(thinkingLevelsFor(MODELS, "", false)).toEqual(THINKING_LEVELS);
    expect(thinkingLevelsFor(MODELS, "", true)).toEqual(THINKING_LEVELS);
  });

  describe("for a built-in, which pi knows from its own catalogue", () => {
    it("is every level for a model the catalogue lacks or the list does not name", () => {
      expect(thinkingLevelsFor(MODELS, "unknown", false)).toEqual(THINKING_LEVELS);
      expect(thinkingLevelsFor(MODELS, "typed-by-hand", false)).toEqual(THINKING_LEVELS);
      expect(thinkingLevelsFor([], "big", false)).toEqual(THINKING_LEVELS);
      expect(thinkingLevelsFor(MODELS, "reasons", false)).toEqual(THINKING_LEVELS);
    });

    it("is off alone for a model said not to reason, so the control hides", () => {
      expect(thinkingLevelsFor(MODELS, "no-reasoning", false)).toEqual(["off"]);
      expect(offersThinking(thinkingLevelsFor(MODELS, "no-reasoning", false))).toBe(false);
    });
  });

  describe("for a model declared to pi (a custom endpoint, a ChatGPT plan)", () => {
    it("is off through high for one that reasons with no levels named", () => {
      expect(thinkingLevelsFor(MODELS, "reasons", true)).toEqual(OFF_TO_HIGH);
    });

    it("is off alone for one that does not reason or does not say", () => {
      expect(thinkingLevelsFor(MODELS, "no-reasoning", true)).toEqual(["off"]);
      expect(thinkingLevelsFor(MODELS, "unknown", true)).toEqual(["off"]);
      expect(offersThinking(thinkingLevelsFor(MODELS, "unknown", true))).toBe(false);
    });

    it("is off alone for an id the list does not name: pi is told its id and nothing more", () => {
      // A typed-in id, or a plan key whose model list never came back while the agent's
      // allowlist names the model.
      expect(thinkingLevelsFor(MODELS, "typed-by-hand", true)).toEqual(["off"]);
      expect(thinkingLevelsFor([], "gpt-6.1-sol", true)).toEqual(["off"]);
    });
  });
});

describe("declaredToPi", () => {
  const provider = (id: string, builtin: boolean): Provider => ({
    id,
    label: id,
    dialect: "openai-completions",
    builtin,
    baseUrl: "https://example.test/v1",
    authHeader: "authorization",
    authScheme: "Bearer",
    models: [],
    archivedAt: null,
  });
  const providers = [
    provider("anthropic", true),
    provider("chatgpt-plan", true),
    provider("groq", false),
  ];

  it("is true for a custom endpoint and a ChatGPT plan, false for a built-in", () => {
    expect(declaredToPi(providers, "groq")).toBe(true);
    expect(declaredToPi(providers, "chatgpt-plan")).toBe(true);
    expect(declaredToPi(providers, "anthropic")).toBe(false);
  });

  it("is false for a provider the list does not name, which leaves every level open", () => {
    expect(declaredToPi(providers, "gone")).toBe(false);
    expect(declaredToPi(providers, undefined)).toBe(false);
  });
});

describe("offersThinking", () => {
  it("is false for a model that only takes off", () => {
    expect(offersThinking(["off"])).toBe(false);
    expect(offersThinking(["off", "low"])).toBe(true);
    expect(offersThinking(THINKING_LEVELS)).toBe(true);
  });
});

describe("thinkingInvalid", () => {
  it("flags a pick the model does not list, never the default", () => {
    expect(thinkingInvalid("max", ["off", "low", "high"])).toBe(true);
    expect(thinkingInvalid("low", ["off", "low", "high"])).toBe(false);
    expect(thinkingInvalid(null, ["off"])).toBe(false);
  });
});

describe("thinkingToSend", () => {
  it("sends the pick, even a flagged one, and nothing for a model that takes no level", () => {
    expect(thinkingToSend("high", THINKING_LEVELS)).toBe("high");
    expect(thinkingToSend("max", ["off", "low"])).toBe("max");
    expect(thinkingToSend(null, THINKING_LEVELS)).toBeNull();
    expect(thinkingToSend("high", ["off"])).toBeNull();
  });
});

describe("THINKING_LABELS", () => {
  it("names every level", () => {
    expect(THINKING_LEVELS.map((level) => THINKING_LABELS[level])).toEqual([
      "Off",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Extra high",
      "Max",
    ]);
  });
});

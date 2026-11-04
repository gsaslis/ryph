// Thinking levels: pi's vocabulary, which levels each model takes (the built-ins' table, a plan
// model's efforts, an endpoint's declaration), and pi's rule the table follows.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  isThinkingLevel,
  orderedLevels,
  planThinkingLevels,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../src/core/thinking.ts";
import { THINKING_CATALOGUE } from "../src/core/thinking_catalogue.ts";
import { PRICE_CATALOGUE } from "../src/core/pricing_catalogue.ts";
import { catalogueModels } from "../src/core/pricing.ts";
import { DeclaredModelSchema } from "../src/schema.ts";
import { planModelsOf } from "../src/core/chatgpt_plan.ts";
import {
  customProviderSpec,
  planModelForRun,
  toAdminProviderSpec,
  toPublicProviderSpec,
} from "../src/core/registry.ts";
import { supportedLevels } from "./pi_levels.ts";

test("thinking: pi's levels, least to most", () => {
  assertEquals([...THINKING_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert(isThinkingLevel("max"));
  assert(!isThinkingLevel("none"), "the Responses API's word, not pi's");
  assertEquals(orderedLevels(["high", "off", "high", "nope"]), ["off", "high"]);
});

test("thinking: a plan model's efforts are its levels, none as off, unknown ones dropped", () => {
  assertEquals(planThinkingLevels(["none", "low", "medium", "high", "xhigh"]), [
    "off",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  // No `none`: a model that cannot switch reasoning off takes no `off`.
  assertEquals(planThinkingLevels(["high", "low"]), ["low", "high"]);
  assertEquals(planThinkingLevels(["turbo"]), []);
});

test("thinking: pi-ai's getSupportedThinkingLevels, as the tests restate it", () => {
  // Not reasoning: off alone, whatever the map says.
  assertEquals(supportedLevels({ reasoning: false, thinkingLevelMap: { max: "max" } }), ["off"]);
  // Reasoning with no map: every level but the two that must be named to exist.
  assertEquals(supportedLevels({ reasoning: true }), ["off", "minimal", "low", "medium", "high"]);
  // A null drops a level; xhigh and max exist only where named.
  assertEquals(
    supportedLevels({
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, max: "max" },
    }),
    ["low", "medium", "high", "max"],
  );
  assertEquals(
    supportedLevels({ reasoning: true, thinkingLevelMap: { off: "none", xhigh: "xhigh" } }),
    ["off", "minimal", "low", "medium", "high", "xhigh"],
  );
});

test("thinking: every priced built-in model has its levels, each a set of pi's in pi's order", () => {
  for (const [provider, models] of Object.entries(PRICE_CATALOGUE)) {
    for (const id of Object.keys(models)) {
      const levels = THINKING_CATALOGUE[provider]?.[id];
      assert(levels !== undefined, `${provider}/${id} has no thinking levels`);
      assert(levels.length > 0);
      assertEquals([...levels], orderedLevels(levels), `${provider}/${id}`);
    }
  }
  // The provider list carries them.
  const opus = catalogueModels("anthropic").find((m) => m.id === "claude-opus-5-5");
  assertEquals(opus?.thinkingLevels, ["low", "medium", "high", "xhigh", "max"]);
  const gpt4 = catalogueModels("openai").find((m) => m.id === "gpt-4");
  assertEquals(gpt4?.thinkingLevels, ["off"]);
});

test("thinking: a declared model's levels are pi's, once each, kept in pi's order", () => {
  const parsed = DeclaredModelSchema.parse({ id: "m", thinkingLevels: ["high", "off", "max"] });
  assertEquals(parsed.thinkingLevels, ["off", "high", "max"]);
  assertEquals(DeclaredModelSchema.parse({ id: "m" }).thinkingLevels, undefined);
  for (
    const bad of [
      { id: "m", thinkingLevels: [] },
      { id: "m", thinkingLevels: ["none"] },
      { id: "m", thinkingLevels: ["low", "low"] },
      // A model said not to reason takes no level but off.
      { id: "m", reasoning: false, thinkingLevels: ["off", "low"] },
    ]
  ) {
    assert(!DeclaredModelSchema.safeParse(bad).success, JSON.stringify(bad));
  }
  assert(
    DeclaredModelSchema.safeParse({ id: "m", reasoning: false, thinkingLevels: ["off"] })
      .success,
  );
});

test("thinking: a plan model has the levels its list names, a custom one those it declared", () => {
  // Only what is known leaves the proxy: no level pi would default an unsaid model to.
  const [none, some, unsaid, withNone, unknown] = planModelsOf({
    models: [
      { slug: "gpt-a", supported_reasoning_levels: [] },
      { slug: "gpt-b", supported_reasoning_levels: ["low", "high"] },
      { slug: "gpt-c" },
      { slug: "gpt-d", supported_reasoning_levels: ["none", "xhigh"] },
      { slug: "gpt-e", supported_reasoning_levels: ["turbo"] },
    ],
  });
  assertEquals(planModelForRun(none), { id: "gpt-a", reasoning: false });
  assertEquals(planModelForRun(some).thinkingLevels, ["low", "high"]);
  assertEquals(planModelForRun(unsaid), { id: "gpt-c" });
  assertEquals(planModelForRun(withNone).thinkingLevels, ["off", "xhigh"]);
  assertEquals(planModelForRun(unknown), { id: "gpt-e", reasoning: true });

  const models = [
    { id: "a", reasoning: false },
    { id: "b", reasoning: true },
    { id: "c" },
    { id: "d", thinkingLevels: ["low", "max"] as ThinkingLevel[] },
    { id: "e", reasoning: true, thinkingLevels: ["off"] as ThinkingLevel[] },
  ];
  const spec = customProviderSpec({
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: {},
    models,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(toPublicProviderSpec(spec).models, models);
  assertEquals(toAdminProviderSpec(spec).models, models);
});

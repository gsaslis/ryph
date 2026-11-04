import { describe, expect, it } from "vitest";
import type { Provider } from "$lib/api/types";
import { keyProviderOptions, planSignInOffered, providerOptionLabel } from "./provider-options";

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

describe("keyProviderOptions", () => {
  const providers = [
    provider("anthropic", "anthropic-messages"),
    provider("openai", "openai-responses"),
    provider("groq", "openai-completions"),
    provider("old", "openai-completions", "2026-01-01T00:00:00Z"),
    provider("chatgpt-plan", "openai-responses"),
  ];

  it("offers the live providers a harness can drive, never the plan", () => {
    const options = keyProviderOptions(providers, [{ dialects: ["anthropic-messages"] }]);
    expect(options.map((p) => p.id)).toEqual(["anthropic"]);
  });

  it("stays open when no harness reports a dialect", () => {
    const options = keyProviderOptions(providers, []);
    expect(options.map((p) => p.id)).toEqual(["anthropic", "openai", "groq"]);
  });
});

describe("planSignInOffered", () => {
  it("is the proxy listing the plan provider", () => {
    expect(planSignInOffered([{ id: "anthropic" }])).toBe(false);
    expect(planSignInOffered([{ id: "chatgpt-plan" }])).toBe(true);
  });
});

describe("providerOptionLabel", () => {
  it("names the slug beside a label that differs from it", () => {
    expect(providerOptionLabel({ id: "groq", label: "Groq" })).toBe("Groq (groq)");
    expect(providerOptionLabel({ id: "groq", label: "groq" })).toBe("groq");
  });
});

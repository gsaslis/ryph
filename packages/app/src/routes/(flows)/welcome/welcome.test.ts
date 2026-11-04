import { describe, expect, it } from "vitest";
import type { Harness, Provider, ProviderKey } from "$lib/api/types";
import {
  backgroundProviderKeys,
  composeQuickAgent,
  defaultHarnessKind,
  firstOpenStep,
  newestId,
  newTaskHref,
  summarizeImages,
} from "./welcome";

const key: ProviderKey = {
  id: "pk_1",
  provider: "anthropic",
  label: "Anthropic key",
  last4: "abcd",
  archivedAt: null,
  createdAt: "2026-10-12T00:00:00Z",
  updatedAt: "2026-10-12T00:00:00Z",
};

const harness = (browser: boolean): Harness => ({
  kind: "pi",
  image: null,
  dialects: ["anthropic-messages"],
  tools: true,
  skills: true,
  browser,
  browserUnavailable: browser ? null : "image",
  provisioner: "docker",
});

describe("firstOpenStep", () => {
  it("opens on the first step not done yet", () => {
    expect(firstOpenStep({ model: false, agent: false, background: false, repo: false })).toBe(
      "model",
    );
    expect(firstOpenStep({ model: true, agent: false, background: false, repo: true })).toBe(
      "agent",
    );
    expect(firstOpenStep({ model: true, agent: true, background: false, repo: true })).toBe(
      "background",
    );
    expect(firstOpenStep({ model: true, agent: true, background: true, repo: false })).toBe("repo");
    expect(firstOpenStep({ model: true, agent: true, background: true, repo: true })).toBe("ready");
  });
});

describe("backgroundProviderKeys", () => {
  const provider = (id: string, dialect: string, archivedAt: string | null = null): Provider => ({
    id,
    dialect,
    archivedAt,
    label: id,
    builtin: true,
    models: [],
    baseUrl: "https://example.com",
    authHeader: "authorization",
    authScheme: "Bearer",
  });

  it("reuses live API keys for Memory's supported dialects, including custom endpoints", () => {
    const keys = [key, { ...key, id: "openai-key", provider: "openai" }, {
      ...key,
      id: "custom-key",
      provider: "custom",
    }];
    expect(backgroundProviderKeys(keys, [
      provider("anthropic", "anthropic-messages"),
      provider("openai", "openai-responses"),
      provider("custom", "openai-completions"),
    ])).toEqual(keys);
  });

  it("reuses a signed-in ChatGPT plan with its account-specific models", () => {
    const planKey: ProviderKey = {
      ...key,
      provider: "chatgpt-plan",
      plan: {
        email: null,
        planType: "plus",
        status: "active",
        limitedAt: null,
        models: [{ id: "gpt-5" }],
      },
    };
    const providers = [provider("chatgpt-plan", "openai-responses")];
    expect(backgroundProviderKeys([planKey], providers)).toEqual([planKey]);
    expect(backgroundProviderKeys([
      { ...planKey, plan: { ...planKey.plan!, status: "needs_reauth" } },
      { ...planKey, plan: { ...planKey.plan!, models: [] } },
    ], providers)).toEqual([]);
  });

  it("excludes archived, unknown, unsupported and unavailable plan keys", () => {
    expect(backgroundProviderKeys([
      { ...key, archivedAt: "2026-10-13" },
      { ...key, provider: "archived" },
      { ...key, provider: "unknown" },
      { ...key, provider: "unsupported" },
      { ...key, provider: "chatgpt-plan" },
    ], [
      provider("anthropic", "anthropic-messages"),
      provider("archived", "openai-completions", "2026-10-13"),
      provider("unsupported", "future-dialect"),
      provider("chatgpt-plan", "openai-responses"),
    ])).toEqual([]);
  });
});

describe("newestId", () => {
  it("picks the newest live item", () => {
    expect(newestId([
      { id: "a", createdAt: "2026-10-01T00:00:00Z", archivedAt: null },
      { id: "b", createdAt: "2026-10-03T00:00:00Z", archivedAt: null },
      { id: "c", createdAt: "2026-10-05T00:00:00Z", archivedAt: "2026-10-06T00:00:00Z" },
    ])).toBe("b");
    expect(newestId([])).toBe("");
  });
});

describe("defaultHarnessKind", () => {
  it("is pi, as the full flow sends, and the first offered only where pi is not", () => {
    expect(defaultHarnessKind([])).toBe("pi");
    expect(defaultHarnessKind([{ kind: "echo" }, { kind: "pi" }])).toBe("pi");
    expect(defaultHarnessKind([{ kind: "echo" }])).toBe("echo");
  });
});

describe("composeQuickAgent", () => {
  const base = {
    name: " Ada ",
    providerKeyId: "pk_1",
    defaultModel: "",
    harnessKind: "pi",
    providerKeys: [key],
    host: "ryph.example.com",
  };

  it("sends what the full flow sends with every step left as it opens", () => {
    expect(composeQuickAgent({ ...base, harness: harness(true), user: { caps: ["*"] } })).toEqual({
      name: "Ada",
      email: "ada@ryph.example.com",
      harnessKind: "pi",
      modelPolicy: {
        providerKeyId: "pk_1",
        provider: "anthropic",
        allowedModels: "*",
        defaultModel: null,
        defaultThinking: null,
      },
      memoryPolicy: { budgetTokens: 2000 },
      canOpenPatches: true,
      canPublishArtifacts: true,
      browserEnabled: true,
    });
  });

  it("keeps the picked model and holds back what the creator cannot grant", () => {
    const agent = composeQuickAgent({
      ...base,
      defaultModel: "claude-sonnet-4-5",
      harness: harness(false),
      user: { caps: ["agents:write", "models:manage"] },
    });
    expect(agent.modelPolicy?.defaultModel).toBe("claude-sonnet-4-5");
    expect(agent.canPublishArtifacts).toBe(false);
    expect(agent.browserEnabled).toBe(false);
  });

  it("gives a local host the reserved email domain", () => {
    const agent = composeQuickAgent({ ...base, host: "localhost", harness: undefined, user: null });
    expect(agent.email).toBe("ada@ryph.localhost");
  });
});

describe("newTaskHref", () => {
  it("names the picks it has", () => {
    expect(newTaskHref("ag_1", "cr_1")).toBe("/tasks/create?agent=ag_1&repo=cr_1");
    expect(newTaskHref("ag_1", "")).toBe("/tasks/create?agent=ag_1");
    expect(newTaskHref("", "")).toBe("/tasks/create");
  });
});

describe("summarizeImages", () => {
  it("counts what is there and whether to keep asking", () => {
    expect(summarizeImages([
      { state: "present" },
      { state: "pulling" },
      { state: "failed" },
    ])).toEqual({ total: 3, present: 1, failed: 1, busy: true });
    expect(summarizeImages([{ state: "present" }, { state: "queued" }])).toEqual({
      total: 2,
      present: 1,
      failed: 0,
      busy: true,
    });
    expect(summarizeImages([{ state: "present" }, { state: "failed" }])).toEqual({
      total: 2,
      present: 1,
      failed: 1,
      busy: false,
    });
  });
});

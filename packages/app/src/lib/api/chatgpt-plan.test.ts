import { describe, expect, it } from "vitest";
import { getSignInStatus, isOpenAiSignInUrl, refreshPlanModels, startSignIn } from "./chatgpt-plan";
import { archiveProviderKey, getProviderKeys } from "./provider-keys";

type Seen = { url: string; init: RequestInit | undefined };

/** A fetch that answers once with `body` and records what it was asked. */
function answering(status: number, body: unknown) {
  const seen: Seen[] = [];
  const f = ((url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe("the sign-in address", () => {
  it("is opened only when it is on OpenAI's sign-in host", async () => {
    expect(isOpenAiSignInUrl("https://auth.openai.com/api/accounts/authorize?x=1")).toBe(true);
    expect(isOpenAiSignInUrl("http://auth.openai.com/api/accounts/authorize")).toBe(false);
    expect(isOpenAiSignInUrl("https://auth.openai.com.evil.test/")).toBe(false);
    expect(isOpenAiSignInUrl("https://evil.test/?https://auth.openai.com/")).toBe(false);
    expect(isOpenAiSignInUrl("javascript:alert(1)")).toBe(false);
    const { f } = answering(201, {
      id: "si-1",
      authorizeUrl: "https://evil.test/authorize",
      expiresAt: "2026-10-07T12:10:00.000Z",
    });
    await expect(startSignIn(f)).rejects.toThrow();
  });
});

describe("signing a plan key out", () => {
  const key = {
    id: "pk-1",
    provider: "chatgpt-plan",
    label: "ChatGPT plan",
    last4: "",
    archivedAt: "2026-10-07T12:00:00.000Z",
    createdAt: "2026-10-07T10:00:00.000Z",
    updatedAt: "2026-10-07T12:00:00.000Z",
  };
  it("says whether OpenAI confirmed it, and nothing for other keys", async () => {
    expect((await archiveProviderKey(answering(200, { ...key, revoked: false }).f, "pk-1")).revoked)
      .toBe(false);
    const other = await archiveProviderKey(answering(200, key).f, "pk-1");
    expect(other).toEqual({ key, revoked: null });
  });
});

describe("the sign-in calls", () => {
  it("starts a sign-in, new or for an existing key", async () => {
    const body = {
      id: "si-1",
      authorizeUrl: "https://auth.openai.com/api/accounts/authorize?x=1",
      expiresAt: "2026-10-07T12:10:00.000Z",
    };
    const { f, seen } = answering(201, body);
    expect(await startSignIn(f, { keyId: "pk-1" })).toEqual(body);
    expect(seen[0].url).toBe("/api/v1/chatgpt-plan/sign-ins");
    expect(seen[0].init?.method).toBe("POST");
    expect(JSON.parse(String(seen[0].init?.body))).toEqual({ keyId: "pk-1" });
  });

  it("reads a status with or without its optional fields", async () => {
    const pending = answering(200, { status: "pending" });
    expect(await getSignInStatus(pending.f, "si 1")).toEqual({ status: "pending" });
    expect(pending.seen[0].url).toBe("/api/v1/chatgpt-plan/sign-ins/si%201");

    const done = answering(200, { status: "done", keyId: "pk-2" });
    expect(await getSignInStatus(done.f, "si-1")).toEqual({ status: "done", keyId: "pk-2" });

    const odd = answering(200, { status: "weird" });
    await expect(getSignInStatus(odd.f, "si-1")).rejects.toThrow();
  });

  it("refreshes a key's models", async () => {
    const { f, seen } = answering(200, { models: ["gpt-5.5", "gpt-5.5-mini"] });
    expect(await refreshPlanModels(f, "pk-1")).toEqual(["gpt-5.5", "gpt-5.5-mini"]);
    expect(seen[0].url).toBe("/api/v1/provider-keys/pk-1/chatgpt-plan/models");
  });
});

describe("a plan key in the key list", () => {
  it("carries its plan, and every other key leaves it out", async () => {
    const base = {
      label: "k",
      last4: "abcd",
      archivedAt: null,
      createdAt: "2026-10-07T12:00:00.000Z",
      updatedAt: "2026-10-07T12:00:00.000Z",
    };
    const plan = {
      email: "ana@example.com",
      planType: "plus",
      status: "limited",
      limitedAt: "2026-10-07T12:05:00.000Z",
      models: [{ id: "gpt-5.5", reasoning: true, thinkingLevels: ["low", "high"] }],
    };
    const { f } = answering(200, {
      providerKeys: [
        { id: "pk-1", provider: "anthropic", ...base },
        { id: "pk-2", provider: "chatgpt-plan", ...base, plan },
      ],
    });
    const [api, chatgpt] = await getProviderKeys(f);
    expect(api.plan).toBeUndefined();
    expect(chatgpt.plan).toEqual(plan);
  });
});

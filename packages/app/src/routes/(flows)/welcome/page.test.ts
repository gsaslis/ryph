import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModelAccess, getPlatformModelPolicyOrNull } from "$lib/api/provider-keys";
import { load } from "./+page";

vi.mock("$lib/api/agents", () => ({ getAgents: vi.fn().mockResolvedValue([]) }));
vi.mock("$lib/api/forge", () => ({ getForges: vi.fn().mockResolvedValue(null) }));
vi.mock("$lib/api/harnesses", () => ({ getHarnesses: vi.fn().mockResolvedValue([]) }));
vi.mock("$lib/api/providers", () => ({ getProvidersOrEmpty: vi.fn().mockResolvedValue([]) }));
vi.mock("$lib/api/repos", () => ({ getConnectedRepos: vi.fn().mockResolvedValue([]) }));
vi.mock("$lib/api/provider-keys", () => ({
  getModelAccess: vi.fn(),
  getPlatformModelPolicyOrNull: vi.fn(),
}));

const policy = {
  providerKeyId: "pk_1",
  provider: "openai",
  model: "gpt-5-mini",
  allowedModels: "*" as const,
  updatedAt: "2026-10-14T00:00:00Z",
};

async function loadWelcome() {
  return await load(
    {
      parent: () => Promise.resolve({ user: { caps: ["*"] } }),
      url: new URL("https://ryph.example/welcome"),
      fetch,
      depends: vi.fn(),
    } as unknown as Parameters<typeof load>[0],
  );
}

beforeEach(() => {
  vi.mocked(getModelAccess).mockResolvedValue({ modelAccessEnabled: true, providerKeys: [] });
  vi.mocked(getPlatformModelPolicyOrNull).mockResolvedValue(null);
});

describe("welcome background model load", () => {
  it("loads an existing policy without overwriting it", async () => {
    vi.mocked(getPlatformModelPolicyOrNull).mockResolvedValue(policy);
    const data = await loadWelcome();
    expect(data?.platformPolicy).toEqual(policy);
    expect(data?.unread.background).toBe(false);
  });

  it("distinguishes an unset policy from a failed read", async () => {
    expect((await loadWelcome())?.unread.background).toBe(false);
    vi.mocked(getPlatformModelPolicyOrNull).mockRejectedValue(new Error("offline"));
    const data = await loadWelcome();
    expect(data?.platformPolicy).toBeNull();
    expect(data?.unread.background).toBe(true);
    expect(data?.unread.keys).toBe(false);
    expect(data?.agents).toEqual([]);
  });

  it("keeps setup available when model access is disabled", async () => {
    vi.mocked(getModelAccess).mockResolvedValue({ modelAccessEnabled: false, providerKeys: [] });
    const data = await loadWelcome();
    expect(data?.modelAccessEnabled).toBe(false);
    expect(data?.platformPolicy).toBeNull();
    expect(data?.unread.background).toBe(false);
  });
});

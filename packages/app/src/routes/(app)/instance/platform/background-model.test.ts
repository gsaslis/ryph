import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import BackgroundModel from "./background-model.svelte";

vi.mock("$app/navigation", () => ({ invalidate: vi.fn() }));

describe("Background model", () => {
  it("shows only the key and model fields even for a legacy restricted policy", () => {
    const { body } = render(BackgroundModel, {
      props: {
        providers: [],
        providerKeys: [{
          id: "key-1",
          provider: "custom",
          label: "Background key",
          last4: "1234",
          archivedAt: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        }],
        platformPolicy: {
          providerKeyId: "key-1",
          provider: "custom",
          allowedModels: ["custom-model"],
          model: "custom-model",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
    });

    expect(body).toContain("Provider key");
    expect(body).toContain("custom-model");
    expect(body).toContain("platform-model");
    expect(body).not.toContain("Allowed models");
    expect(body).not.toContain("platform-models");
    expect(body).toContain("Turn off");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goto, invalidate } from "$app/navigation";
import { startAuthentication } from "@simplewebauthn/browser";
import { toast } from "svelte-sonner";
import { signInWithPasskey, signInWithPassword } from "./login";

vi.mock("$app/navigation", () => ({ goto: vi.fn(), invalidate: vi.fn() }));
vi.mock("@simplewebauthn/browser", () => ({ startAuthentication: vi.fn() }));
vi.mock("svelte-sonner", () => ({ toast: { error: vi.fn() } }));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation((url) =>
    Promise.resolve(Response.json(
      url === "/auth/passkey/login/options" ? { challengeId: "challenge", options: {} } : {},
    ))
  );
});

afterEach(() => vi.unstubAllGlobals());

const methods = [
  {
    name: "password",
    signIn: (backTo: string | null) => signInWithPassword("me@example.com", "secret", backTo),
  },
  { name: "passkey", signIn: signInWithPasskey },
];

for (const { name, signIn } of methods) {
  describe(`${name} login navigation`, () => {
    it.each(["/settings/profile?tab=security#passkeys", null])(
      "navigates once to %s while refreshing user data",
      async (backTo) => {
        // Standalone invalidation reruns the authenticated login loader, redirecting
        // before the handler resumes. It must never happen on the login page.
        vi.mocked(invalidate).mockImplementation(async () => {
          await goto(backTo ?? "/agents");
        });

        await signIn(backTo);

        expect(invalidate).not.toHaveBeenCalled();
        expect(goto).toHaveBeenCalledExactlyOnceWith(backTo ?? "/agents", { invalidateAll: true });
        expect(toast.error).not.toHaveBeenCalled();
      },
    );

    it("captures the destination before authentication changes page data", async () => {
      const data = { backTo: "/settings/profile" as string | null };
      fetchMock.mockImplementation((url) => {
        data.backTo = null;
        return Promise.resolve(Response.json(
          url === "/auth/passkey/login/options" ? { challengeId: "challenge", options: {} } : {},
        ));
      });

      await signIn(data.backTo);

      expect(goto).toHaveBeenCalledExactlyOnceWith("/settings/profile", { invalidateAll: true });
    });

    it("does not navigate when authentication is rejected", async () => {
      fetchMock.mockResolvedValue(Response.json({ message: "Rejected" }, { status: 401 }));
      await signIn("/settings/profile");
      expect(goto).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith("Rejected");
    });
  });
}

it("does not navigate when passkey verification fails", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ challengeId: "challenge", options: {} }));
  fetchMock.mockResolvedValueOnce(Response.json({ message: "Invalid passkey" }, { status: 401 }));

  await signInWithPasskey("/settings/profile");

  expect(goto).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith("Invalid passkey");
});

it("silently leaves the login page in place when the passkey dialog is dismissed", async () => {
  vi.mocked(startAuthentication).mockRejectedValue(
    new DOMException("Cancelled", "NotAllowedError"),
  );

  await signInWithPasskey("/settings/profile");

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(goto).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
});

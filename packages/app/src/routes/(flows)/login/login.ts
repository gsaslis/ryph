import { goto } from "$app/navigation";
import { startAuthentication } from "@simplewebauthn/browser";
import { toast } from "svelte-sonner";

// Refresh the user as part of the destination navigation. Invalidating on the login
// page first reruns its loader, which redirects and races the handler's navigation.
async function finishLogin(backTo: string | null) {
  await goto(backTo ?? "/agents", { invalidateAll: true });
}

export async function signInWithPasskey(backTo: string | null) {
  try {
    const opts = await fetch("/auth/passkey/login/options", { method: "POST" });
    if (!opts.ok) {
      const body = await opts.json().catch(() => null);
      toast.error(body?.message ?? "Passkeys are not available on this instance");
      return;
    }
    const { challengeId, options } = await opts.json();
    const response = await startAuthentication({ optionsJSON: options });
    const res = await fetch("/auth/passkey/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId, response }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.message ?? "The passkey could not be verified");
      return;
    }
    await finishLogin(backTo);
  } catch (e) {
    // The browser dialog was dismissed, or no authenticator answered.
    if (!(e instanceof Error && e.name === "NotAllowedError")) {
      toast.error(e instanceof Error ? e.message : "Sign-in with a passkey failed");
    }
  }
}

export async function signInWithPassword(email: string, password: string, backTo: string | null) {
  try {
    const res = await fetch("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.message ?? "Failed to log in");
      return;
    }

    await finishLogin(backTo);
  } catch {
    toast.error("Failed to reach the server");
  }
}

import { z } from "zod";
import { apiCall } from "./call";
import { type Passkey, passkeySchema } from "./types";

// The signed-in side of passkeys: everything goes through the proxy with the bearer. Sign-in
// itself is anonymous and lives under the /auth BFF routes, which set the session cookies.

export async function listPasskeys(f = fetch): Promise<Passkey[]> {
  return z.object({ passkeys: z.array(passkeySchema) }).parse(await apiCall(f, "/v1/auth/passkeys"))
    .passkeys;
}

/** Pins a challenge and returns what `startRegistration` needs. */
export async function passkeyRegistrationOptions(f = fetch) {
  return z.object({ challengeId: z.string(), options: z.record(z.string(), z.unknown()) }).parse(
    await apiCall(f, "/v1/auth/passkeys/register/options", { method: "POST" }),
  );
}

export async function registerPasskey(
  f = fetch,
  input: { challengeId: string; response: unknown; name: string },
): Promise<Passkey> {
  return passkeySchema.parse(
    await apiCall(f, "/v1/auth/passkeys/register/verify", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export async function renamePasskey(f = fetch, id: string, name: string): Promise<Passkey> {
  return passkeySchema.parse(
    await apiCall(f, `/v1/auth/passkeys/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  );
}

/** Refused (409) when it is the only way into the account. */
export async function deletePasskey(f = fetch, id: string): Promise<void> {
  await apiCall(f, `/v1/auth/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
}

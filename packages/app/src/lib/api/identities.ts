import { z } from "zod";
import { apiCall } from "./call";
import {
  type Identity,
  type IdentityChallenge,
  identityChallengeSchema,
  identitySchema,
} from "./types";

/** The providers this instance signs people in through. Unauthenticated: the sign-in page asks. */
export async function listProviders(f = fetch): Promise<string[]> {
  return z.object({ providers: z.array(z.string()) }).parse(
    await apiCall(f, "/v1/auth/providers", {}, false),
  ).providers;
}

/** The caller's linked provider accounts, oldest first. */
export async function listIdentities(f = fetch): Promise<Identity[]> {
  return z.object({ identities: z.array(identitySchema) }).parse(
    await apiCall(f, "/v1/auth/identities"),
  ).identities;
}

/** Detaches a provider account. Refused (409) when it is the only way into the account. */
export async function unlinkIdentity(f = fetch, provider: string): Promise<void> {
  await apiCall(f, `/v1/auth/identities/${encodeURIComponent(provider)}`, { method: "DELETE" });
}

/**
 * Mints a one-time nonce to prove an identity with, and the line that signs it. For a provider
 * with no authorization server to redirect to — Radicle, where an account IS a key. Answers
 * 201: the challenge is a row it created, and `apiCall` takes any 2xx.
 */
export async function mintIdentityChallenge(
  f = fetch,
  provider: string,
): Promise<IdentityChallenge> {
  return identityChallengeSchema.parse(
    await apiCall(f, `/v1/auth/identities/${encodeURIComponent(provider)}/challenge`, {
      method: "POST",
    }),
  );
}

/**
 * Links an account by proof instead of an OAuth code. The signature is verified against the key
 * the subject names, so a subject typed by someone who does not hold that key is a 400.
 *
 * The nonce is NOT sent: a caller naming which challenge it signed proves nothing about what it
 * actually signed, so the instance tries every outstanding one of this user and spends the one
 * that verifies.
 */
export async function linkIdentityByProof(
  f = fetch,
  provider: string,
  proof: { subject: string; signature: string },
): Promise<Identity> {
  return identitySchema.parse(
    await apiCall(f, `/v1/auth/identities/${encodeURIComponent(provider)}/link`, {
      method: "POST",
      body: JSON.stringify(proof),
    }),
  );
}

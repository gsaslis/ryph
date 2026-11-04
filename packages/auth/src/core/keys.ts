// The Ed25519 signing keypair: generated once on first boot, persisted through the store,
// published as JWKS. One active key for now; rotation later is "insert a new key, serve both
// in the JWKS until the old one's tokens expire" — the shapes already allow a list.

import { exportJWK, generateKeyPair } from "jose";
import type { SigningKey } from "./types.ts";
import type { AuthStore } from "../ports/auth_store.ts";
import { mintId } from "@ryph/sealed";

export async function ensureSigningKey(store: AuthStore, nowIso: string): Promise<SigningKey> {
  const existing = await store.getSigningKey();
  if (existing) return existing;

  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const kid = mintId("k");
  const key: SigningKey = {
    kid,
    privateJwk: { ...(await exportJWK(privateKey)), kid, alg: "EdDSA" },
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: "EdDSA", use: "sig" },
    createdAt: nowIso,
  };
  await store.saveSigningKey(key);
  // Re-read rather than trusting what we just generated. Another replica booting into the same
  // empty database mints its own key at the same moment, and `getSigningKey` imposes a total
  // order, so whoever can see both rows agrees on which one signs.
  //
  // Convergence here is a tidiness, not the safety property: the interleaving where each replica
  // commits and re-reads before seeing the other still leaves two signers. What makes that
  // harmless is that the JWKS publishes EVERY stored key (see `AuthStore.listSigningKeys`), so a
  // token minted under either kid verifies everywhere. This just keeps the usual case to one key.
  return await store.getSigningKey() ?? key;
}

/** The JWKS document served at /.well-known/jwks.json — public halves only, ever. */
export function toJwks(keys: SigningKey[]): { keys: Record<string, unknown>[] } {
  return { keys: keys.map((k) => k.publicJwk) };
}

// The setup token: what a networked deployment's first registration has to present.
//
// An unclaimed instance on a network strangers can reach would otherwise go to whoever registers
// first, so the claim needs a secret only the operator sees — printed in the control plane's log
// at boot while there are no users.
//
// It is DERIVED, not minted: HKDF-SHA256 over a signing key's private scalar, under a label of its
// own, so the signing key is never used as a MAC key and the token gives nothing of it away. Every
// replica reads the same key table, so a token printed by one is accepted by all of them without
// a row of its own, and nothing about it outlives the bootstrap — once an owner exists, no
// registration asks for it again.

import { sha256Hex, timingSafeEqual } from "@ryph/sealed";
import type { SigningKey } from "./types.ts";

const LABEL = "ryph setup token v1";

/** The setup token under one signing key: 64 hex characters. */
export async function setupTokenFor(key: SigningKey): Promise<string> {
  const secret = key.privateJwk.d;
  if (typeof secret !== "string") throw new Error(`signing key ${key.kid} has no private half`);
  const ikm = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret, "base64url"),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const token = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(LABEL),
    },
    ikm,
    256,
  );
  return Buffer.from(token).toString("hex");
}

/**
 * Whether `presented` is the setup token under any of `keys`. Compared as digests in constant
 * time, and every key is tried whatever the outcome, so the answer's timing says nothing.
 */
export async function isSetupToken(
  presented: string | undefined,
  keys: SigningKey[],
): Promise<boolean> {
  if (presented === undefined || presented === "") return false;
  const digest = await sha256Hex(presented);
  let match = false;
  for (const key of keys) {
    if (timingSafeEqual(digest, await sha256Hex(await setupTokenFor(key)))) match = true;
  }
  return match;
}

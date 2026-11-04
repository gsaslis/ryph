// What this package's sealed values are bound to.
//
// Two classes, each with its own key derived from RYPH_SECRETS_KEY:
// - `provider-keys`: a provider key's secret (a pasted API key, or a ChatGPT plan's token set),
//   bound to the key's id, its provider, and — for a custom endpoint — that endpoint's request
//   shape: its base URL, the header and scheme the key rides in, and its static extra headers.
//   Pointing the key at another provider, or changing any of those in the database, makes the
//   secret unopenable rather than sending it somewhere else
// - `chatgpt-sign-in-verifiers`: a sign-in's PKCE verifier, bound to the sign-in's id, its
//   issued client and its redirect URI
//
// Invariants:
// - a binding is computed from the row (and the endpoint row) AS READ at the moment of use; the
//   proxy binds to the very spec it is about to dial
// - a built-in provider binds no URL: its address is code, not a row anyone can write

import {
  decryptSecret,
  deriveSealingKey,
  encryptSecret,
  type MasterKey,
  type SealBinding,
  type SealingKey,
} from "@ryph/sealed";
import { endpointShape, type ProviderSpec } from "./registry.ts";
import type { PlanSignIn, ProviderKey } from "./types.ts";

export const PROVIDER_KEYS_CLASS = "provider-keys";
export const SIGN_IN_VERIFIERS_CLASS = "chatgpt-sign-in-verifiers";

/**
 * A provider key's binding: its id, its provider, and — when the provider is a custom endpoint —
 * that endpoint's request shape (`endpointShape`: base URL, auth header and scheme, extra
 * headers). Null for a built-in, whose shape is code, and for an endpoint that does not resolve —
 * which then opens nothing a re-created endpoint would bind.
 */
export function providerKeyBinding(
  key: Pick<ProviderKey, "id" | "provider">,
  spec: ProviderSpec | null,
): SealBinding {
  return {
    id: key.id,
    provider: key.provider,
    endpoint: spec === null || spec.builtin ? null : endpointShape(spec),
  };
}

/** A sign-in's binding: the verifier goes, with its code, to the token exchange of exactly this
 * attempt. */
export function signInBinding(
  signIn: Pick<PlanSignIn, "id" | "clientId" | "redirectUri">,
): SealBinding {
  return { id: signIn.id, clientId: signIn.clientId, redirectUri: signIn.redirectUri };
}

/** Seals and opens this package's two classes. */
export interface ProxySealer {
  sealKey(plaintext: string, binding: SealBinding): Promise<string>;
  openKey(sealed: string, binding: SealBinding): Promise<string>;
  sealVerifier(plaintext: string, binding: SealBinding): Promise<string>;
  openVerifier(sealed: string, binding: SealBinding): Promise<string>;
}

/** The sealer over a master: each class's key derived once, on first use. */
export function makeProxySealer(master: MasterKey): ProxySealer {
  let keys: Promise<{ providerKeys: SealingKey; verifiers: SealingKey }> | null = null;
  const derived = () =>
    keys ??= Promise.all([
      deriveSealingKey(master, PROVIDER_KEYS_CLASS),
      deriveSealingKey(master, SIGN_IN_VERIFIERS_CLASS),
    ]).then(([providerKeys, verifiers]) => ({ providerKeys, verifiers }));
  return {
    sealKey: async (plaintext, binding) =>
      encryptSecret((await derived()).providerKeys, plaintext, binding),
    openKey: async (sealed, binding) =>
      decryptSecret((await derived()).providerKeys, sealed, binding),
    sealVerifier: async (plaintext, binding) =>
      encryptSecret((await derived()).verifiers, plaintext, binding),
    openVerifier: async (sealed, binding) =>
      decryptSecret((await derived()).verifiers, sealed, binding),
  };
}

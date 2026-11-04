// The chat service's sealed secrets: one class, `chat-credentials`, its key derived from
// RYPH_CHAT_KEY (in the binary, RYPH_SECRETS_KEY when that is unset — the same master as the
// provider keys, but a different derived key). Each room secret is bound by `tokenBinding`.
//
// Here and not in core/: the crypto kit is the composition's business, and core/ sees only the
// TokenSealer port.

import {
  decryptSecret,
  deriveSealingKey,
  encryptSecret,
  type MasterKey,
  type SealingKey,
} from "@ryph/sealed";
import type { TokenSealer } from "./core/service.ts";

export const CHAT_CREDENTIALS_CLASS = "chat-credentials";

/** The sealer over a master: the class key derived once, on first use. */
export function makeChatSealer(master: MasterKey): TokenSealer {
  let key: Promise<SealingKey> | null = null;
  const derived = () => key ??= deriveSealingKey(master, CHAT_CREDENTIALS_CLASS);
  return {
    seal: async (plaintext, binding) => encryptSecret(await derived(), plaintext, binding),
    unseal: async (sealed, binding) => decryptSecret(await derived(), sealed, binding),
  };
}

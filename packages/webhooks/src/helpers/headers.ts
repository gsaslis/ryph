// What of a request's headers is safe to keep.
//
// A hook is persisted RAW so a consumer can read exactly what the sender said — but a request's
// headers are also where its credential rides, and these rows outlive the delivery with no
// retention sweep behind them. For a `secret-header` registration the verification header IS the
// credential, verbatim (the Radicle bridge presents `authorization: Bearer <token>` on every
// event it mints); a signature is a credential of its own once the body it signs sits in the
// same row. Nothing reads either after `verifyRequest`, which runs before the insert, so
// dropping them costs nothing and keeps the mailroom from becoming a place secrets accumulate.
//
// Dropped, not blanked: a `[redacted]` placeholder would be a value a consumer could mistake for
// one the sender sent, and the fact that a verified request carried its credential is implied by
// its being here at all.

import {
  STANDARD_WEBHOOKS_HEADERS,
  type VerificationConfig,
  VERIFIED_GENERATION_HEADER,
  VERIFIED_SCOPE_HEADER,
} from "../core/types.ts";

/** Never persisted, whatever a registration verifies with — the usual carriers of a credential.
 * Compared against the lowercased name `Headers` iteration already hands us. */
const NEVER_PERSIST: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  // The Standard Webhooks signature, whatever the registration verifies with — the scheme fixes
  // the name, so a sender built on it spells it this way everywhere. Its siblings `webhook-id`
  // and `webhook-timestamp` are kept: no credential rides on them, and the delivery id is what a
  // consumer deduplicating retries reads.
  STANDARD_WEBHOOKS_HEADERS.signature,
  // Not credentials, but the door's own word: a `derived-secret-header` row carries the scope and
  // generation it verified under these names, so ones the SENDER sent are never written down
  // beside them — a consumer trusting them must be reading what the door wrote.
  VERIFIED_SCOPE_HEADER,
  VERIFIED_GENERATION_HEADER,
]);

/** Same, by prefix: `x-hub-signature` covers GitHub's `x-hub-signature-256` and its predecessor,
 * and any other signature header a sender spells with a suffix. */
const NEVER_PERSIST_PREFIXES: readonly string[] = ["x-hub-signature"];

/** Whether this header is one the mailroom refuses to write down. */
export function isSecretHeader(name: string, verification: VerificationConfig): boolean {
  const lower = name.toLowerCase();
  // A `standard-webhooks` registration has no configurable header; its fixed one is above.
  if (verification.kind !== "standard-webhooks" && lower === verification.header.toLowerCase()) {
    return true;
  }
  if (NEVER_PERSIST.has(lower)) return true;
  return NEVER_PERSIST_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** The request's headers as the row will hold them: every one the sender sent, minus the ones
 * carrying a credential. */
export function storableHeaders(
  headers: Headers,
  verification: VerificationConfig,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (isSecretHeader(name, verification)) continue;
    out[name] = value;
  }
  return out;
}

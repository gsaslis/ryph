// @ryph/sealed — the credential kit every ryph service shares: sealing a secret at rest,
// minting an id or a bearer token, hashing a token for storage, comparing hashes without
// leaking through timing, the gate for one shared service bearer, and the HMAC a signature or a
// derived secret is made of.
//
// Small and shared on purpose. These few functions used to live as a copy per package — the
// orchestrator's, auth's, the model-proxy's, the historian's — each with a note that a kit could
// absorb them once a third copy appeared. Cryptographic code is the worst thing to have five of:
// a fix to one (a reused IV, a length-leaking compare) has to be found and repeated in the rest.
// One implementation, tested once. The same reasoning that makes @ryph/logger a package.
//
// What does NOT belong here: anything that knows what a secret IS. Which master key seals which
// class of secret, what a token grants, where a hash is stored — all of that stays with the
// service that owns the secret. This package only knows how to keep one.

export {
  decryptSecret,
  deriveSealingKey,
  encryptSecret,
  importMasterKey,
  type MasterKey,
  type SealBinding,
  SEALED_FORMAT,
  type SealingKey,
} from "./seal.ts";
export { hmacSha256Hex, ID_BODY, mintId, mintToken, sha256Hex, timingSafeEqual } from "./tokens.ts";
export {
  makeRunReadGate,
  mintRunGrant,
  RUN_GRANT_CAPABILITY,
  RUN_GRANT_PARAM,
  RUN_GRANT_TTL_MS,
  type RunGrantBearer,
  runGrantOf,
  verifyRunGrant,
} from "./run_grant.ts";
export {
  bearerToken,
  makeServiceGate,
  type ServiceGate,
  tokenMatches,
  unauthorized,
} from "./service_gate.ts";
export { endAtBearerExpiry, tokenBearerExpiresAt } from "./stream_expiry.ts";

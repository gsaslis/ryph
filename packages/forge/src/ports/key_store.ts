// Looks up the run a presented credential belongs to. The orchestrator is the source of truth:
// it mints and stores the credentials (hash-only) when it provisions a run. This port is the
// forge boundary's read against that store — given a credential, which run does it grant access to.

import type { RunGrant } from "../core/types.ts";

export interface KeyStore {
  /**
   * Looks up which run a presented credential grants access to. Three outcomes:
   * - a `RunGrant` — the credential is valid; here is the run it unlocks.
   * - `null` — a definitive no: unknown, expired, revoked, or the run already terminal. The
   *   caller answers 401. The specific reason is deliberately not distinguished.
   * - throws — the store could not be asked (the orchestrator is unreachable). The caller
   *   answers 503, not 401, because the credential itself may be perfectly valid.
   */
  resolve(token: string): Promise<RunGrant | null>;
}

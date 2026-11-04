// The proxy's per-request decision, as a pure function — the policy half of the data plane,
// separated from the forwarding machinery so every rule is unit-testable with plain objects.
//
// Invariants:
// - an unknown, revoked, and expired credential answer IDENTICALLY (401): distinguishing them
//   would confirm to a probing caller which tokens exist(ed)
// - the model allowlist and the caps were frozen onto the virtual key at issue time; this
//   function never consults live policy — except the provider key's liveness, which is
//   deliberately live: archiving a real key must cut off every in-flight run immediately
// - an allowlist fails CLOSED: a request that spends tokens without naming a model is refused,
//   because "no model named" and "a model that is not on the list" are indistinguishable here
// - a spend cap fails CLOSED the same way: under a cap, a purchase whose price this proxy cannot
//   work out — no model named, or a model the catalogue has no rate for — is refused, because a
//   cap that cannot count is no cap
// - a cap refusal is a 403 with a CODE, never a 429: the SDKs retry a 429 with backoff, and the
//   run's cap is not going to move. The in-flight cap is the one 429, taken by the handler at the
//   moment it holds the slot, because that decision and the slot must be one step
// - the deployment's ceiling has no grace: by the time it bites the per-run caps have failed, and
//   the bill is what matters
// - a purchase a plan's INCLUDED usage pays for is never refused by a cap, neither the run's nor
//   the deployment's: it adds nothing to either, so refusing it protects no bill

import type { LimitVerdict } from "./spend_meter.ts";
import type { ProviderKey, VirtualKey } from "./types.ts";

/** The `code` a cap refusal carries, so a client can tell it from every other 403 or 429. The
 * VALUE is the contract: the app carries its own copy. */
export const LIMIT_REACHED = "limit_reached";
/** The `code` for a purchase refused because the catalogue cannot price it under a cap. */
export const UNPRICED = "unpriced";

/** Which cap a `LIMIT_REACHED` refusal names. */
export type LimitName = "spend" | "deployment-spend" | "calls-in-flight";

export type ProxyDecision =
  | { allow: true; virtualKey: VirtualKey; providerKey: ProviderKey }
  | {
    allow: false;
    status: 401 | 403 | 429;
    error: string;
    code?: typeof LIMIT_REACHED | typeof UNPRICED;
    limit?: LimitName;
  };

/** What the proxy could read off a request before deciding whether to forward it. */
export interface ProxiedRequest {
  /** The model the payload names, or null when it names none (e.g. a models list). */
  model: string | null;
  /**
   * True when this request is about to BUY tokens: a body on a completion endpoint. Such a
   * request must name its model — see below.
   */
  spends: boolean;
  /** Whether the catalogue can price the named model; null when nobody asked (no model, or a
   * request that buys nothing). */
  priced: boolean | null;
  /** True when the provider's usage is included in a plan (pricing.ts `included`): the caps
   * have nothing to count, so they are not asked. Absent is false. */
  included?: boolean;
}

/** What the meter says about the run's spend, and whether any spend cap applies to it at all. */
export interface SpendState {
  /** True when the run carries a spend cap or the deployment has a ceiling. */
  capped: boolean;
  verdict: LimitVerdict;
}

/**
 * Whether the token names a live credential at all: known, not revoked, not expired. The first
 * of `decide`'s questions, asked on its own too — before the proxy reads a request body, so a
 * caller with no credential cannot make it buffer one.
 */
export function authenticates(virtualKey: VirtualKey | null, nowIso: string): boolean {
  return virtualKey !== null && virtualKey.revokedAt === null && virtualKey.expiresAt > nowIso;
}

export function decide(
  virtualKey: VirtualKey | null,
  providerKey: ProviderKey | null,
  request: ProxiedRequest,
  nowIso: string,
  spend: SpendState = { capped: false, verdict: { kind: "ok" } },
): ProxyDecision {
  if (virtualKey === null || !authenticates(virtualKey, nowIso)) {
    return { allow: false, status: 401, error: "unauthorized" };
  }

  // The real key vanished or was archived: the run's credential is technically alive but its
  // backing is gone. 403, not 401 — the caller IS who it claims to be, it just may not spend.
  if (providerKey === null || providerKey.archivedAt !== null) {
    return { allow: false, status: 403, error: "the provider key backing this run was revoked" };
  }

  if (virtualKey.allowedModels !== "*") {
    if (request.model === null) {
      // A purchase whose model this proxy cannot read is REFUSED, never waved through: an
      // allowlist a caller switches off by relabelling its body is not an allowlist. Requests
      // that buy nothing — a models list, fetching a stored response — still name no model and
      // still pass.
      if (request.spends) {
        return {
          allow: false,
          status: 403,
          error: "this run may only use certain models, and this request names none",
        };
      }
    } else if (!virtualKey.allowedModels.includes(request.model)) {
      return {
        allow: false,
        status: 403,
        error: `model "${request.model}" is not allowed for this run`,
      };
    }
  }

  if (request.spends && request.included !== true) {
    if (spend.capped && (request.model === null || request.priced === false)) {
      return {
        allow: false,
        status: 403,
        code: UNPRICED,
        error: "this run is under a spend cap and this request's model has no price",
      };
    }
    if (spend.verdict.kind === "over") {
      return {
        allow: false,
        status: 403,
        code: LIMIT_REACHED,
        limit: spend.verdict.limit,
        error: spend.verdict.limit === "spend"
          ? "this run has reached its spend cap"
          : "this deployment has reached its model spend ceiling",
      };
    }
  }

  return { allow: true, virtualKey, providerKey };
}

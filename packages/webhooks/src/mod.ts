// The public surface — what a mounting host imports. Everything else is wiring detail.

export { setup, type WebhooksSetup, type WebhooksSetupDeps } from "./setup.ts";
export {
  type ConsumeOutcome,
  DEFAULT_DELIVERY_POLICY,
  type DeliveryAdmission,
  type DeliveryPolicy,
  type DeliveryTicket,
  type DerivedSecretHeaderVerification,
  deriveScopedSecret,
  type HmacSha256Verification,
  type Hook,
  type HookState,
  type IngestRateLimit,
  type SecretHeaderVerification,
  STANDARD_WEBHOOKS_HEADERS,
  STANDARD_WEBHOOKS_TOLERANCE_MS,
  type StandardWebhooksVerification,
  type VerificationConfig,
  VERIFIED_GENERATION_HEADER,
  VERIFIED_SCOPE_HEADER,
  type WebhookRegistration,
  type WebhookRegistrationInput,
} from "./core/types.ts";
export { retryHook } from "./core/hook_lifecycle.ts";
export { coalescingTick } from "./helpers/tick.ts";
export type { HookStore } from "./ports/hook_store.ts";
export type { Diagnostics } from "./ports/diagnostics.ts";
export { makeWebhooksDb, scopeWebhooksDb, type WebhooksDbHandle } from "./adapters/store/db/db.ts";
export { drizzleHookStore } from "./adapters/store/drizzle.ts";
export type { Route } from "@ryph/shared/http";
export { livenessRoutes } from "./http/liveness.ts";

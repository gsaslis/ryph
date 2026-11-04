// @ryph/model-proxy — model access for agent runs: real provider keys sealed in one place,
// run-scoped virtual keys everywhere else.
//
// Two halves, and where each one lands depends on the deployment:
// - the CONTROL side (setup, plus the providerKeyRoutes/makeCredentialIssuer pieces it composes,
//   and the stores): key CRUD on the user surface, virtual keys minted at the runner's boot-time
//   credentials fetch. In the single process @ryph/host calls setup() and spreads the routes
//   into its own router; standalone, src/main.ts serves them on their own control listener,
//   alongside internalCredentialRoutes — the service-authed surface a remote control plane dials
//   instead of holding an in-process issuer.
// - the DATA side (makeProxyHandler): the listener agent containers dial as their "provider" —
//   authenticates virtual keys, enforces the frozen model allowlist, forwards with the real key,
//   meters usage. Its own socket in both deployments.
//
// The master key is the CONTROL side's, and only the two halves of this package ever hold it.

export type {
  AllowedModels,
  CustomProvider,
  CustomProviderPatch,
  PlanRegistration,
  PlanStatus,
  PlatformModelPolicy,
  ProviderKey,
  PublicPlan,
  PublicProviderKey,
  UsageRecord,
  VirtualKey,
} from "./core/types.ts";
export { PLATFORM_PRINCIPAL_PREFIX, platformPrincipal, toPublicProviderKey } from "./core/types.ts";
export {
  BUILTIN_PROVIDERS,
  CUSTOM_BASE_URL_ENV,
  CUSTOM_KEY_ENV,
  customProviderSpec,
  type DeclaredModel,
  type Dialect,
  HARNESS_DIALECTS,
  MODEL_PROVIDER_CONFIG_ENV,
  type ProviderSpec,
  type PublicModel,
  type PublicProviderSpec,
  supportedDialects,
  toPublicProviderSpec,
} from "./core/registry.ts";
export {
  type CredentialIssuer,
  type CredentialIssuerDeps,
  CredentialRefusedError,
  type CredentialScope,
  listProviderSpecs,
  makeCredentialIssuer,
  makePlatformCredentialIssuer,
  type PlatformCredential,
  type PlatformCredentialIssuer,
  type PlatformCredentialIssuerDeps,
  resolveProvider,
} from "./core/service.ts";
export {
  decide,
  LIMIT_REACHED,
  type LimitName,
  type ProxyDecision,
  UNPRICED,
} from "./core/enforce.ts";
export { type RunSpend, spendInWindow, spendOfRun } from "./core/spend.ts";
export { makeProxyHandler, type ProxyDiag, type ProxyHandlerDeps } from "./http/proxy.ts";
export {
  disabledProviderKeyRoutes,
  MODEL_ACCESS_DISABLED,
  PROVIDER_MISSING,
  providerKeyRoutes,
  type ProviderKeyRoutesDeps,
  SECRET_REQUIRED,
} from "./http/routes.ts";
export type { Route } from "@ryph/shared/http";
export {
  internalCredentialRoutes,
  type InternalRoutesDeps,
  platformCredentialRoutes,
  type PlatformRoutesDeps,
} from "./http/internal.ts";
export {
  type ChatgptPlanOptions,
  type ModelProxySetup,
  type ModelProxySetupDeps,
  setup,
  type SpendCeiling,
  type SpendLimits,
} from "./setup.ts";
/** Exported for the composition roots' boot warning: whoever mounts these routes says at boot
 * that this knob is on, and there must be exactly ONE reader of the variable. */
export { privateModelEndpointsAllowed } from "./schema.ts";
export { CHATGPT_PLAN, isLocalAppUrl } from "./core/chatgpt_plan.ts";
export { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "./core/thinking.ts";
export { type CallbackListener, PLAN_PATHS } from "./http/chatgpt_plan.ts";
export type { KeyStore } from "./ports/key_store.ts";
export { drizzleKeyStore } from "./adapters/store/drizzle.ts";
export { makeModelProxyDb } from "./adapters/store/db/db.ts";
export { scopeModelProxyDb } from "./adapters/store/db/db.ts";

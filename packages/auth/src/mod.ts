// @ryph/auth — the token contract for every ryph service.
//
// Two halves:
// - the ISSUER side (setup, plus the makeAuthService/authRoutes pieces it composes, and the
//   stores): only an auth composition root uses these — @ryph/host calls setup() on
//   startup by default, standalone via main.ts
// - the VERIFIER side (verifierFromJwks / verifierFromJwksSource / verifierFromUrl, Claims):
//   what every service imports to gate its public API, statelessly; the gates themselves
//   (makeAuthenticate, makeCapabilityGate, …) are the `@ryph/auth/gates` subpath

export {
  can,
  CAPABILITIES,
  type Capability,
  type CapabilityClaim,
  capsClaimOf,
  EVERY_CAPABILITY,
  FORBIDDEN,
  forbidden,
  isCapabilityClaim,
  mayGrant,
  type Role,
  ROLE_CAPABILITIES,
  ROLES,
  SESSION_ONLY_CAPABILITIES,
} from "./core/capabilities.ts";
export type {
  ApiToken,
  ApiTokenSummary,
  AuthSettings,
  Claims,
  ExternalIdentity,
  IdentityChallenge,
  IdentitySummary,
  Invite,
  InvitePreview,
  InviteSummary,
  Passkey,
  PasskeySummary,
  PublicUser,
  Session,
  SessionMeta,
  SessionSummary,
  SigningKey,
  TokenPair,
  User,
  UserStatus,
} from "./core/types.ts";
export { toPublicUser } from "./core/types.ts";
export {
  type AuthConfig,
  type AuthService,
  type AuthServiceDeps,
  type LoginLinkOutcome,
  makeAuthService,
} from "./core/service.ts";
export {
  type JwksSourceOptions,
  type Verifier,
  verifierFromJwks,
  verifierFromJwksSource,
  verifierFromUrl,
} from "./core/verify.ts";
export { authRoutes, type AuthRoutesDeps, PROXY_SECRET_HEADER } from "./http/routes.ts";
export type { Route } from "@ryph/shared/http";
export {
  AuthConfigError,
  type AuthSetup,
  type AuthSetupDeps,
  multiUserFromEnv,
  setup,
  setupTokenNotice,
} from "./setup.ts";
export type { AuthStore } from "./ports/auth_store.ts";
export type {
  ChallengeProvider,
  IdentityProof,
  IdentityProvider,
  OAuthCodeLeg,
  ProviderIdentity,
  ProviderMembership,
} from "./ports/identity_provider.ts";
export { NO_CODE_LEG } from "./ports/identity_provider.ts";
export type { Mail, Mailer } from "./ports/mailer.ts";
export { smtpMailer, type SmtpMailerOptions } from "./adapters/mailer/smtp.ts";
export { drizzleAuthStore } from "./adapters/store/drizzle.ts";
export { makeAuthDb } from "./adapters/store/db/db.ts";
export { scopeAuthDb } from "./adapters/store/db/db.ts";

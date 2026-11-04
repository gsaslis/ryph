// The ingest boundary: every JSON payload is validated here before it touches the core.
// Same invariants as the other packages' schema.ts files: no unchecked casts downstream,
// every string length-bounded.

import { z } from "@zod/zod";
import { CAPABILITIES, ROLES } from "./core/capabilities.ts";
import { isReservedAddress, MAX_LEN } from "./core/types.ts";

export { MAX_LEN } from "./core/types.ts";

const singleLine = z.string().trim().min(1).max(MAX_LEN).refine((s) => !/[\r\n]/.test(s), {
  error: "must be a single line",
});

/** An address an account may be given: never one under a reserved TLD, where the stand-ins of
 * accounts without a proven address live (`addresslessEmail`). */
const address = z.email().refine((e) => !isReservedAddress(e), {
  error: "must be an address that can receive mail",
});

// Length only — no composition rules. The floor follows current NIST guidance; a maximum
// exists because unbounded input into a KDF is a CPU-DoS vector.
const password = z.string().min(8).max(256);

export const LoginSchema = z.object({
  email: z.email(),
  password,
});

export const ForgotPasswordSchema = z.object({
  email: z.email(),
});

export const ResetPasswordSchema = z.object({
  password,
});

/** The raw secret a mailed link carries: what `mintToken` produces, and nothing looser. */
export const linkToken = z.string().regex(/^[0-9a-f]{64}$/);

export const RefreshSchema = z.object({
  refreshToken: z.string().min(1).max(1_000),
});

export const CreateUserSchema = z.object({
  email: address,
  name: singleLine.optional(),
  password: password.optional(),
  /** The first registration's proof that it is the operator's: what the boot log printed. */
  setupToken: z.string().trim().max(256).optional(),
});

export const LoginLinkSchema = z.object({
  token: linkToken,
});

export const UpdateProfileSchema = z.object({
  name: singleLine.optional(),
  email: address.optional(),
}).refine((p) => p.name !== undefined || p.email !== undefined, {
  error: "nothing to update",
});

export const VerifyEmailSchema = z.object({
  name: singleLine,
  password,
});

export const UpdateUserSchema = z.object({
  role: z.enum(ROLES).optional(),
  status: z.enum(["active", "deactivated"]).optional(),
}).refine((u) => u.role !== undefined || u.status !== undefined, {
  error: "nothing to update",
});

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().max(256).optional(),
  newPassword: password,
});

export const UpdateSettingsSchema = z.object({
  allowOpenRegistration: z.boolean().optional(),
  allowForgeOrgJoin: z.boolean().optional(),
});

export const OAuthCallbackSchema = z.object({
  code: singleLine.max(500),
  invite: z.string().min(1).max(1_000).optional(),
  /** The redirect URI the authorize leg named, repeated on the token leg (GitLab requires it). An
   * http(s) URL; which one is right is the provider's call, against its registered list. */
  redirectUri: z.url({ protocol: /^https?$/ }).max(2_000).optional(),
  /** The PKCE verifier behind the authorize leg's S256 challenge (RFC 7636 §4.1). */
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/, "not a PKCE code verifier")
    .optional(),
});

const DAY_MS = 24 * 60 * 60 * 1000;

export const CreateInviteSchema = z.object({
  email: address.nullable().default(null),
  role: z.enum(ROLES).default("member"),
  /** Days until the link stops working. */
  expiresInDays: z.number().int().min(1).max(365).default(7),
  /** Null: unlimited. Ignored for a bound invite, which is single-use. */
  maxUses: z.number().int().min(1).max(10_000).nullable().default(null),
}).transform((i) => ({ ...i, expiresInMs: i.expiresInDays * DAY_MS }));

export const AcceptInviteSchema = z.object({
  name: singleLine.optional(),
  email: address.nullable().default(null),
  password: password.optional(),
});

const challengeId = z.string().min(1).max(100);
/** The browser's WebAuthn answer, taken as a whole: the verifier is the one that reads it. */
const webauthnResponse = z.looseObject({ id: z.string().min(1).max(2_000) });

export const PasskeyRegisterSchema = z.object({
  challengeId,
  response: webauthnResponse,
  name: singleLine.max(100),
});

export const PasskeyLoginSchema = z.object({
  challengeId,
  response: webauthnResponse,
});

export const RenamePasskeySchema = z.object({
  name: singleLine.max(100),
});

export const CreateApiTokenSchema = z.object({
  name: singleLine.max(100),
  /** The capabilities the token gets, each one the caller must hold. */
  caps: z.array(z.enum(CAPABILITIES)).min(1).max(CAPABILITIES.length),
  /** Days until the token stops exchanging. */
  expiresInDays: z.number().int().min(1).max(365).default(90),
}).transform((t) => ({ ...t, caps: [...new Set(t.caps)], expiresInMs: t.expiresInDays * DAY_MS }));

/** What the exchange takes: the secret exactly as it was shown once, prefix included. */
export const ExchangeApiTokenSchema = z.object({
  token: z.string().regex(/^ryph_pat_[0-9a-f]{64}$/),
});

/** The raw token an invite link carries: what `mintToken` produces, and nothing looser. */
export const inviteToken = z.string().regex(/^[0-9a-f]{64}$/);

/** A provider name as it appears in a path: a short, URL-safe token. */
export const providerParam = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

/**
 * What POST /v1/auth/identities/:provider/link accepts: the account being claimed, and an
 * armored signature over the challenge nonce. Both bounded generously and parsed by the
 * provider, never trusted — the subject becomes a database key, the signature is one ed25519
 * signature plus PEM framing.
 */
export const LinkIdentityProofSchema = z.object({
  subject: singleLine.max(500),
  signature: z.string().min(1).max(4_096),
});

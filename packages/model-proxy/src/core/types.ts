// The shared shapes of model access.
//
// Invariants:
// - a provider key's SECRET exists in exactly two forms: sealed at rest (`encryptedSecret`,
//   AES-GCM under the deployment's master key) and in the proxy process's memory at forward
//   time. It never appears in an API response — `toPublicProviderKey` is the one redaction
//   point — and never in a log.
// - a VIRTUAL key's raw token is never stored; only its SHA-256 lands in a row, exactly like
//   the orchestrator's per-run bearer. A leaked database leaks no usable credential.
// - rows keep resolving forever: provider keys and custom endpoints are archived, never deleted,
//   so a historical run's `providerKeyId` always answers "whose key did this run spend?" and its
//   `provider` always answers "what did it dial?"
// - a CUSTOM ENDPOINT holds no secret of its own: the credential for it is an ordinary
//   ProviderKey whose `provider` is the endpoint's slug, sealed like any other. What the row
//   below carries is how to dial and how the credential travels — non-secret configuration an
//   admin typed, and nothing that would hurt in a log.

import { SEALED_FORMAT } from "@ryph/sealed";
import { type DeclaredModel, planModelForRun } from "./registry.ts";
import type { PlanModel } from "./chatgpt_plan.ts";

/** A registered upstream credential: one real API key for one provider, sealed at rest. */
export interface ProviderKey {
  id: string;
  /** Which provider this secret opens: a built-in id, or a custom endpoint's slug. Checked
   * against built-ins ∪ live rows at registration, and never again — an endpoint archived
   * afterwards leaves its keys resolvable, which is what historical usage rows need. */
  provider: string;
  /** The user's name for it: "team key", "personal", "spend-capped CI key". */
  label: string;
  /** The last four characters of the secret — the only recoverable trace the API exposes. */
  last4: string;
  /** The secret, sealed (`provider-keys`, bound to this id, `provider` and a custom endpoint's
   * request shape). Only the proxy ever unseals it. `NO_SECRET` when there is none: an archived
   * plan key, or a key whose secret must be entered again (`needsSecret`) — its endpoint's
   * address, auth header or extra headers changed. */
  encryptedSecret: string;
  /** Soft delete only: archiving revokes every credential minted from this key, immediately. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * A `chatgpt-plan` key's registration: who signed in, under which issued OAuth client, and
   * what the account serves. Non-secret — the tokens are the sealed secret. Null (or absent, on
   * a row built before plans existed) for every other provider.
   */
  plan?: PlanRegistration | null;
  /** A `chatgpt-plan` key's state, kept apart from `plan` because the data plane writes it on
   * its own, and a whole-object write racing a token refresh would undo one or the other. */
  planStatus?: PlanStatus | null;
  /** When the plan last answered with its usage limit; null once a call succeeds again. */
  planLimitedAt?: string | null;
}

/**
 * Where a ChatGPT plan key stands:
 * - `active` — usable;
 * - `needs_reauth` — its refresh token was refused (expired, revoked, disconnected in ChatGPT's
 *   settings); nothing is forwarded until someone signs in again;
 * - `limited` — the plan answered with its usage limit. Calls still go through, because OpenAI
 *   says nothing about when the limit lifts, and the next one that succeeds clears it.
 */
export type PlanStatus = "active" | "needs_reauth" | "limited";

/** The non-secret half of a ChatGPT plan key, beside the sealed token set. */
export interface PlanRegistration {
  /** The `oaiapp_…` client OpenAI issued at registration. Every refresh, revocation and later
   * sign-in names it; `dynamic_agent_client` is only the entry point and is never stored. */
  clientId: string;
  /** The verified ID token's `sub`: a later sign-in into this key must be the same account. */
  subject: string;
  email: string | null;
  /** What the ID token says the account is on (`plus`, `pro`, …), when it says. */
  planType: string | null;
  /** The scopes the token response granted. */
  scopes: string[];
  /** The account's own model list (`GET /v1/models`), cached at sign-in and on request. */
  models: PlanModel[];
  modelsFetchedAt: string | null;
}

/** The sealed secret of a key that holds none. */
export const NO_SECRET = "";

/** Whether a stored sealed value is in the format this release opens (`v2`). Anything else —
 * none (`NO_SECRET`), or something that is not a sealed value at all — opens nothing here. */
export function holdsCurrentSealed(sealed: string): boolean {
  return sealed.startsWith(`${SEALED_FORMAT}.`);
}

/**
 * Whether a live key's secret must be entered again before it can be spent: it holds none (its
 * custom endpoint's request shape changed — base URL, auth header or scheme, extra headers —
 * which drops every secret sealed for the old one; a secret is bound to where it is sent, and is
 * never re-sealed for a new destination on the server's own say-so), or what it holds is not a
 * `v2` value, which nothing opens. A plan key never does: it is signed in again instead, and says so in its status.
 */
export function needsSecret(key: ProviderKey): boolean {
  return key.archivedAt === null && !key.plan && !holdsCurrentSealed(key.encryptedSecret);
}

/**
 * Whether a live key holds no secret at all — its endpoint moved and dropped it. What credential
 * issuance refuses on; a stored value that is there but will not open is the proxy's to refuse
 * at forward time (`409 secret_required`), with the reason it did not open in its log.
 */
export function secretCleared(key: ProviderKey): boolean {
  return key.archivedAt === null && !key.plan && key.encryptedSecret === NO_SECRET;
}

/** The `plan` a provider key carries on the wire. No client id, no subject, never a token. */
export interface PublicPlan {
  /** Null for a reader who is not an admin, as well as when the ID token carried none. */
  email: string | null;
  planType: string | null;
  status: PlanStatus;
  limitedAt: string | null;
  /** This account's own models, each with its own `reasoning` and its efforts as pi's levels
   * (`planModelForRun`): two accounts can list one id with different levels. Never the raw
   * efforts. */
  models: DeclaredModel[];
}

/** A ProviderKey as the outside may see it: everything except the sealed secret, and a plan
 * key's registration narrowed to what a person reads. */
export type PublicProviderKey =
  & Omit<ProviderKey, "encryptedSecret" | "plan" | "planStatus" | "planLimitedAt">
  & {
    plan?: PublicPlan;
    needsSecret: boolean;
    /** Its provider no longer resolves (a custom endpoint's row is gone): nothing can be sent
     * with it, and it cannot be entered again — only archived. */
    providerMissing: boolean;
  };

/**
 * The one redaction point — every API response passes through here. A plan key's account email
 * is left out (null) unless `account` says the reader is an admin: the list is every signed-in
 * user's, and which person's ChatGPT account pays for the deployment's runs is not.
 */
export function toPublicProviderKey(
  key: ProviderKey,
  { account = false, providerMissing = false }: { account?: boolean; providerMissing?: boolean } =
    {},
): PublicProviderKey {
  const {
    encryptedSecret: _sealed,
    plan,
    planStatus,
    planLimitedAt,
    ...rest
  } = key;
  if (plan === undefined || plan === null) {
    return { ...rest, needsSecret: needsSecret(key), providerMissing };
  }
  return {
    ...rest,
    needsSecret: false,
    providerMissing,
    plan: {
      email: account ? plan.email : null,
      planType: plan.planType,
      // A live plan key whose token set is not a `v2` value opens nothing: it is signed in
      // again, whatever the stored status last said.
      status: key.archivedAt === null && !holdsCurrentSealed(key.encryptedSecret)
        ? "needs_reauth"
        : planStatus ?? "active",
      limitedAt: planLimitedAt ?? null,
      models: plan.models.map(planModelForRun),
    },
  };
}

/**
 * One ChatGPT sign-in in flight: the PKCE verifier, state and nonce of one authorization attempt,
 * held in a row rather than in memory, so the app's status poll reads it on whichever process
 * answers, and a restart in between loses nothing.
 */
export interface PlanSignIn {
  id: string;
  /** Bound to this attempt; the callback must carry it back. Unique. */
  state: string;
  /** The OIDC nonce the ID token must echo. */
  nonce: string;
  /** The PKCE verifier, sealed: with it and the code, anyone could finish the exchange. */
  encryptedVerifier: string;
  /** The issued client this attempt signs in again under; null for a first registration, whose
   * client id arrives on the callback. */
  clientId: string | null;
  /** The plan key a re-sign-in replaces the tokens of; null for a new key. */
  keyId: string | null;
  /** The new key's label, when the person gave one. */
  label: string | null;
  /** Sent in the authorization request and again, exactly, in the code exchange. */
  redirectUri: string;
  /** `exchanging` is the claim one completion takes so a repeated browser return cannot
   * spend the code twice; to a reader it is still pending. */
  status: "pending" | "exchanging" | "done" | "failed";
  error: string | null;
  resultKeyId: string | null;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
}

/** What a partial provider-key write may change. */
export type ProviderKeyPatch =
  & Partial<
    Pick<
      ProviderKey,
      "label" | "encryptedSecret" | "archivedAt" | "plan" | "planStatus" | "planLimitedAt"
    >
  >
  & { updatedAt: string };

/**
 * An OpenAI-compatible upstream an admin registered: Cloudflare Workers AI, Groq, Together,
 * Fireworks, OpenRouter, DeepSeek, Azure OpenAI, a self-hosted vLLM. Projected into a
 * ProviderSpec by `customProviderSpec`, after which nothing downstream can tell it from a
 * built-in.
 */
export interface CustomProvider {
  /** The slug, and the value a provider key's and a run policy's `provider` carries. It rides
   * pi's argv as `--provider <id>`, which is why it is a lowercase slug and not free text. */
  id: string;
  label: string;
  /** The upstream, PATH INCLUDED. Validated at registration (https, no private address, no
   * query, no credentials) — see `refuseModelEndpointUrl`. */
  baseUrl: string;
  /** The header the real key rides to the upstream in: `authorization`, or e.g. Azure's
   * `api-key`. Only the proxy→upstream leg; pi→proxy is always a bearer. */
  authHeader: string;
  /** `Bearer`, or null for a header that carries the bare value. */
  authScheme: string | null;
  /** Static, non-secret headers added to every forwarded request. */
  extraHeaders: Record<string, string>;
  /** What this endpoint serves. Required: nothing else in the system knows. */
  models: DeclaredModel[];
  /** Soft delete only, the same doctrine as a provider key's: archiving is the kill switch —
   * the proxy stops forwarding for it and the issuer stops minting — while every historical
   * usage row it priced keeps resolving. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a PATCH may change: everything but the id, which agents and provider keys reference.
 * `updatedAt` is required rather than optional because the clock belongs to the caller, not to
 * the store — the same stance every other write in this package takes.
 */
export type CustomProviderPatch =
  & Partial<
    Pick<
      CustomProvider,
      "label" | "baseUrl" | "authHeader" | "authScheme" | "extraHeaders" | "models" | "archivedAt"
    >
  >
  & { updatedAt: string };

/** `"*"` allows every model the provider serves; a list is an exact allowlist. */
export type AllowedModels = string[] | "*";

/**
 * The PLATFORM's own model policy: which provider key the platform's background work spends —
 * the memory consolidator and ingest extractor first, any off-run AI work later — and on which
 * models. One row, set by an admin, never derived from an agent's policy. Virtual keys minted
 * from it are metered and allowlisted exactly like a run's; only the principal differs.
 */
export interface PlatformModelPolicy {
  providerKeyId: string;
  provider: string;
  allowedModels: AllowedModels;
  /** The model a platform consumer calls unless it names one within the allowlist. */
  model: string;
  updatedAt: string;
}

/**
 * What every platform principal starts with — the one thing that tells a platform credential
 * apart from a run's in the shared `runId` column, and so what "revoke every platform key"
 * matches on when the policy they were minted under changes.
 */
export const PLATFORM_PRINCIPAL_PREFIX = "platform:";

/**
 * The principal a platform credential speaks for, in the `runId` column: `platform:<consumer>`.
 * Run ids are minted (`r-…`) and can never collide with it, so one column serves both — the
 * usage trail and revocation are keyed on it exactly as they are on a run.
 */
export function platformPrincipal(consumer: string): string {
  return `${PLATFORM_PRINCIPAL_PREFIX}${consumer}`;
}

/**
 * A run-scoped stand-in credential: what an agent container actually holds. Minted at the
 * runner's boot-time credentials fetch, bound to one run and one provider key, dead once the
 * run concludes (revoked) or the TTL lapses — so exfiltrating one from a workspace buys an
 * attacker almost nothing.
 */
export interface VirtualKey {
  id: string;
  /** The run this credential speaks for — and dies with — or a platform principal
   * (`platform:<consumer>`, see platformPrincipal) for the platform's own background work. */
  runId: string;
  /** The run's agent and task, frozen here so every usage row this credential spends is
   * attributed without reaching into the control plane's database. Null on a platform
   * credential. */
  agentId: string | null;
  taskId: string | null;
  providerKeyId: string;
  /** SHA-256 hex of the raw token; the raw token exists only inside the container. */
  tokenHash: string;
  /** Frozen from the agent's (or the platform's) model policy at issue time — editing the
   * policy afterwards changes nothing for a credential already out. */
  allowedModels: AllowedModels;
  /** The run's spend cap in USD at list price, frozen at issue time like the allowlist. Null
   * means the run is uncapped; a platform credential always is. */
  spendUsd: number | null;
  /** How many spending calls the proxy holds open for this run at once; null means no cap. */
  callsInFlight: number | null;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

/**
 * One forwarded request — the metering trail. Tokens are what the response itself reported; money
 * is never stored, it is priced at read time (see pricing.ts), so a catalogue edit re-prices it.
 */
export interface UsageRecord {
  runId: string;
  /** The spend's attribution, copied off the credential that made the call. Null for a platform
   * principal, which belongs to no agent and no task. */
  agentId: string | null;
  taskId: string | null;
  providerKeyId: string;
  provider: string;
  /** The model the request named, when the payload carried one. */
  model: string | null;
  /** The upstream's HTTP status. */
  status: number;
  /**
   * The response's own usage report, normalized (see TokenCounts: input excludes cache reads and
   * writes). All null when the response carried none — an error, a models list, a stream cut
   * before its first usage event.
   */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite1hTokens: number | null;
  reasoningTokens: number | null;
  /**
   * Whether the token counts are the proxy's ESTIMATE rather than the response's own report: a
   * spending call whose usage never arrived (core/usage_fallback.ts) is charged that, never
   * nothing. Priced like any other row; reported apart so a bill can say which figures are
   * guesses.
   */
  estimated: boolean;
  /** From the request arriving to the response body ending, a stream's whole length included.
   * Null only on rows older than duration metering. */
  durationMs: number | null;
  /** When the request arrived. */
  at: string;
}

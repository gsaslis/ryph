import { z } from "zod";
import { apiCall, ApiError } from "./call";
import {
  type PlatformModelPolicy,
  platformModelPolicySchema,
  type ProviderKey,
  providerKeySchema,
} from "./types";

// The management surface is write-only on secrets: a secret goes up in create/rotate and
// never comes back — every response carries metadata plus a last4 trace only.

export type CreateProviderKeyInput = {
  provider: string;
  label: string;
  secret: string;
};

export type UpdateProviderKeyInput = {
  label?: string;
  /** Rotation in place: same id, new secret — nothing referencing the key moves. */
  secret?: string;
};

export async function getProviderKeys(f = fetch): Promise<ProviderKey[]> {
  const res = await apiCall(f, "/v1/provider-keys");
  return z.object({ providerKeys: z.array(providerKeySchema) }).parse(res).providerKeys;
}

/** The state of the deployment's model-access surface, shaped to spread into a page's data. */
export type ModelAccess = {
  /** false when the deployment runs without a master key: no key can be registered or used. */
  modelAccessEnabled: boolean;
  providerKeys: ProviderKey[];
};

/**
 * Reads the provider keys for a page `load`, folding a deployment that runs without model
 * access into an empty, disabled result. Every other failure still throws: a page must not
 * present a broken control plane as a configuration choice.
 */
export async function getModelAccess(f = fetch): Promise<ModelAccess> {
  try {
    return { modelAccessEnabled: true, providerKeys: await getProviderKeys(f) };
  } catch (e) {
    if (e instanceof ApiError && isModelAccessDisabled(e)) {
      return { modelAccessEnabled: false, providerKeys: [] };
    }
    throw e;
  }
}

/**
 * A wire contract, not a local name: the host sends this code on the disabled key surface, as
 * `MODEL_ACCESS_DISABLED` in @ryph/model-proxy. The app does not import the server packages (it
 * builds on Node, through Vite), so the value is duplicated and pinned by the host's boot test — change it in
 * all three or the key pages go back to rendering a 500.
 */
const MODEL_ACCESS_DISABLED = "model_access_disabled";

/** True when the refusal is the model-proxy's "turned off" answer rather than a fault. */
export function isModelAccessDisabled(e: ApiError): boolean {
  return e.status === 503 && typeof e.body === "object" && e.body !== null &&
    (e.body as { code?: unknown }).code === MODEL_ACCESS_DISABLED;
}

/**
 * The 409 that says a secret has to be entered again — a key write whose endpoint changed while
 * saving (the secret is bound to the endpoint), and the model-proxy's and the tool gateway's
 * answer to a run whose key or credential is missing or unreadable. Same wire-contract caveat as
 * above.
 */
export const SECRET_REQUIRED = "secret_required";

/** The 409 a key write answers when the key's provider no longer exists: archive it instead. */
export const PROVIDER_MISSING = "provider_missing";

/** True when a key write was refused because the key's provider is gone. */
export function isProviderMissing(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 409 && typeof e.body === "object" &&
    e.body !== null && (e.body as { code?: unknown }).code === PROVIDER_MISSING;
}

/** True when a key write was refused because the secret has to be entered again. */
export function isSecretRequired(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 409 && typeof e.body === "object" &&
    e.body !== null && (e.body as { code?: unknown }).code === SECRET_REQUIRED;
}

export async function createProviderKey(
  f = fetch,
  input: CreateProviderKeyInput,
): Promise<ProviderKey> {
  return providerKeySchema.parse(
    await apiCall(f, "/v1/provider-keys", { method: "POST", body: JSON.stringify(input) }),
  );
}

export async function updateProviderKey(
  f = fetch,
  id: string,
  input: UpdateProviderKeyInput,
): Promise<ProviderKey> {
  return providerKeySchema.parse(
    await apiCall(f, `/v1/provider-keys/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

/**
 * Archives a key. A ChatGPT plan key is signed out as well, and `revoked` says whether OpenAI
 * confirmed it: false means the person should disconnect the app in ChatGPT's settings to be
 * sure. Null for every other key, and for one already archived.
 */
export async function archiveProviderKey(
  f = fetch,
  id: string,
): Promise<{ key: ProviderKey; revoked: boolean | null }> {
  const body = await apiCall(f, `/v1/provider-keys/${encodeURIComponent(id)}/archive`, {
    method: "POST",
  });
  const { revoked } = z.object({ revoked: z.boolean().optional() }).parse(body);
  return { key: providerKeySchema.parse(body), revoked: revoked ?? null };
}

// ── the platform's own model policy ──────────────────────────────────────────────────────────
//
// Which key the platform's background model calls spend: the memory consolidator's judgement
// and the ingest extractor today, any off-run AI work later. Set by naming a live key; the
// provider is the key's. Cleared, those jobs run without a model and say so.

export type SetPlatformModelPolicyInput = {
  providerKeyId: string;
  allowedModels?: string[] | "*";
  model: string;
};

const policyEnvelope = z.object({ policy: platformModelPolicySchema.nullable() });

export async function getPlatformModelPolicy(f = fetch): Promise<PlatformModelPolicy | null> {
  return policyEnvelope.parse(await apiCall(f, "/v1/platform-model-policy")).policy;
}

export async function setPlatformModelPolicy(
  f = fetch,
  input: SetPlatformModelPolicyInput,
): Promise<PlatformModelPolicy> {
  const { policy } = policyEnvelope.parse(
    await apiCall(f, "/v1/platform-model-policy", { method: "PUT", body: JSON.stringify(input) }),
  );
  if (policy === null) throw new Error("the platform policy was not set");
  return policy;
}

export async function clearPlatformModelPolicy(f = fetch): Promise<void> {
  await apiCall(f, "/v1/platform-model-policy", { method: "DELETE" });
}

/** The policy for a page `load`: null when unset, and null too when model access is off —
 * the page already knows to say so from `modelAccessEnabled`. */
export async function getPlatformModelPolicyOrNull(f = fetch): Promise<PlatformModelPolicy | null> {
  try {
    return await getPlatformModelPolicy(f);
  } catch (e) {
    if (e instanceof ApiError && isModelAccessDisabled(e)) return null;
    throw e;
  }
}

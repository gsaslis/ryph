import { z } from "zod";
import { apiCall, ApiError } from "./call";
import { isModelAccessDisabled } from "./provider-keys";
import {
  type DeclaredModel,
  type Provider,
  type ProviderDetail,
  providerDetailSchema,
  providerSchema,
} from "./types";

// The provider registry, beside the provider keys on the model-proxy's control listener: the two
// built-ins plus every OpenAI-compatible endpoint an admin registered. A registered endpoint then
// behaves exactly like a built-in — its key is sealed in the proxy, runs get a virtual key, the
// model allowlist is enforced there and tokens are metered and priced.
//
// Reading is everyone's; registering, editing and archiving are an admin's, and the routes answer
// 403 to anyone else. That is not caught here: the pages gate those controls on the role instead
// of offering a button that comes back refused — the same division the provider-key surface uses,
// where a 403 reaching this layer means a bug and should surface as the error it is.
//
// The LIST withholds one field, `extraHeaders`, because it is read by every signed-in user and
// is the one thing an admin might have typed something regrettable into. `getProvider` is the
// admin-only read that returns it, and is how the edit dialog prefills a form it will PATCH back
// whole — a field left out of a PATCH is left as it was, but a form that cannot show what is
// stored has no honest way to decide which those are.

/** A new custom endpoint. `authHeader` defaults to `authorization` and `authScheme` to `Bearer`
 * server-side; `authScheme: null` sends the credential as the header's bare value, which is how
 * Azure's `api-key` and its imitators want it. */
export type CreateProviderInput = {
  /** The slug, which rides the harness's argv: lowercase letters, digits and dashes. */
  id: string;
  label: string;
  /** The upstream, PATH INCLUDED — `https://api.cloudflare.com/client/v4/accounts/X/ai/v1`. */
  baseUrl: string;
  authHeader?: string;
  authScheme?: string | null;
  /** Static, NON-SECRET headers added to every forwarded request. The credential is the provider
   * key and never travels here. */
  extraHeaders?: Record<string, string>;
  models: DeclaredModel[];
};

/** Any subset of a create, except the slug: the id is what agents and keys reference, so it never
 * moves. An absent field is left as it was; `extraHeaders: {}` clears the map. */
export type UpdateProviderInput = Partial<Omit<CreateProviderInput, "id">>;

export async function getProviders(f = fetch): Promise<Provider[]> {
  const res = await apiCall(f, "/v1/providers");
  return z.object({ providers: z.array(providerSchema) }).parse(res).providers;
}

/**
 * The providers for a page `load`: empty on a deployment that runs without model access, where
 * there is no registry to read and the page already knows to say so from `modelAccessEnabled`.
 * Every other failure still throws — a broken control plane must not read as "no endpoints".
 */
export async function getProvidersOrEmpty(f = fetch): Promise<Provider[]> {
  try {
    return await getProviders(f);
  } catch (e) {
    if (e instanceof ApiError && isModelAccessDisabled(e)) return [];
    throw e;
  }
}

/**
 * One endpoint in full, static headers included — admin-only, and the prefill for editing it.
 * A non-admin never reaches the control that calls this; a 403 here is a bug, and the caller
 * must say so rather than treat blank fields as the stored configuration.
 */
export async function getProvider(f = fetch, id: string): Promise<ProviderDetail> {
  return providerDetailSchema.parse(
    await apiCall(f, `/v1/providers/${encodeURIComponent(id)}`),
  );
}

export async function createProvider(f = fetch, input: CreateProviderInput): Promise<Provider> {
  return providerSchema.parse(
    await apiCall(f, "/v1/providers", { method: "POST", body: JSON.stringify(input) }),
  );
}

/** The saved endpoint, and how many of its live keys the save left without their secret: a
 * change to where or how the key is sent (address, credential header, scheme, static headers)
 * clears every secret sealed for the old shape. Read absent as none. */
export async function updateProvider(
  f = fetch,
  id: string,
  input: UpdateProviderInput,
): Promise<{ provider: Provider; keysCleared: number }> {
  const res = await apiCall(f, `/v1/providers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  const { keysCleared } = z.object({ keysCleared: z.number().int().min(0).optional() }).parse(res);
  return { provider: providerSchema.parse(res), keysCleared: keysCleared ?? 0 };
}

/** Archives an endpoint — the kill switch: keys registered against it stop minting credentials
 * and runs already carrying one lose access. The answer is not read because the action is
 * idempotent and every caller reloads the list afterwards. */
export async function archiveProvider(f = fetch, id: string): Promise<void> {
  await apiCall(f, `/v1/providers/${encodeURIComponent(id)}/archive`, { method: "POST" });
}

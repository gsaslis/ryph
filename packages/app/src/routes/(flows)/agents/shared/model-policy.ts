// The bridge between the form's model-access fields and the API's ModelPolicy shape, shared by
// the create and edit flows so both compose and seed identically.

import type { Harness, ModelPolicy, Provider, ProviderKey, ThinkingLevel } from "$lib/api/types";
import { thinkingLevelsForKey } from "$lib/components/model-picker/models";
import { thinkingToSend } from "$lib/components/model-picker/thinking";

/** Builds the policy from the form fields; "" as the key id means no model access (null). */
export function composeModelPolicy(
  providerKeyId: string,
  allowedModels: ModelPolicy["allowedModels"],
  defaultModel: string,
  providerKeys: ProviderKey[],
  defaultThinking: ModelPolicy["defaultThinking"] = null,
): ModelPolicy | null {
  if (!providerKeyId) return null;
  const key = providerKeys.find((k) => k.id === providerKeyId);
  if (!key) return null;

  return {
    providerKeyId,
    provider: key.provider,
    allowedModels: allowedModels === "*" ? "*" : cleanList(allowedModels),
    defaultModel: defaultModel.trim() || null,
    defaultThinking,
  };
}

/** Seeds the form fields from an existing policy (the edit flow). */
export function policyToFields(policy: ModelPolicy | null): {
  providerKeyId: string;
  allowedModels: ModelPolicy["allowedModels"];
  defaultModel: string;
  defaultThinking: ModelPolicy["defaultThinking"];
} {
  if (!policy) {
    return { providerKeyId: "", allowedModels: "*", defaultModel: "", defaultThinking: null };
  }
  return {
    providerKeyId: policy.providerKeyId,
    allowedModels: policy.allowedModels === "*" ? "*" : cleanList(policy.allowedModels),
    defaultModel: policy.defaultModel ?? "",
    defaultThinking: policy.defaultThinking,
  };
}

/**
 * The thinking levels the default model takes, for the key's own model list. A key the list
 * cannot resolve that the stored policy names reads the policy's provider entry instead.
 */
export function defaultModelThinkingLevels(
  providers: Provider[],
  providerKeys: readonly ProviderKey[],
  providerKeyId: string,
  defaultModel: string,
  storedPolicy: ModelPolicy | null = null,
): readonly ThinkingLevel[] {
  const key = providerKeys.find((k) => k.id === providerKeyId);
  return thinkingLevelsForKey(
    providers,
    key,
    defaultModel,
    storedProvider(storedPolicy, providerKeyId),
  );
}

/** The provider the stored policy names, when it is the policy for this key; else nothing. */
export function storedProvider(
  storedPolicy: ModelPolicy | null,
  providerKeyId: string,
): string | undefined {
  return providerKeyId !== "" && storedPolicy?.providerKeyId === providerKeyId
    ? storedPolicy.provider
    : undefined;
}

/**
 * The default level the edit flow saves. While the key and the default model are the ones the
 * agent was loaded with, the level is sent as it stands, even where the model now offers no
 * level and the pick is hidden: hiding it must not clear what is stored. Once the person moves
 * either, a model that takes no level gets none.
 */
export function editedDefaultThinking(
  seeded: { providerKeyId: string; defaultModel: string },
  providerKeyId: string,
  defaultModel: string,
  defaultThinking: ThinkingLevel | null,
  levels: readonly ThinkingLevel[],
): ThinkingLevel | null {
  const unmoved = providerKeyId === seeded.providerKeyId &&
    defaultModel.trim() === seeded.defaultModel.trim();
  return unmoved ? defaultThinking : thinkingToSend(defaultThinking, levels);
}

/** Why the model fields cannot be saved as they stand, or null — the server's two rules. */
export function modelPolicyProblem(
  providerKeyId: string,
  allowedModels: ModelPolicy["allowedModels"],
  defaultModel: string,
): string | null {
  if (!providerKeyId || allowedModels === "*") return null;
  const list = cleanList(allowedModels);
  if (list.length === 0) return "Pick at least one allowed model.";
  const model = defaultModel.trim();
  if (model !== "" && !list.includes(model)) {
    return "The default model must be one of the allowed models.";
  }
  return null;
}

/** Trimmed, blank-free and each id once — what the server is sent and what a picker can key on. */
function cleanList(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter((model) => model.length > 0))];
}

/**
 * The live keys an agent on this harness can be given, matched on the DIALECT their provider
 * speaks rather than on its name, which is what lets a custom endpoint registered five minutes ago
 * be offered without the form knowing anything about it.
 *
 * The two ways a provider can fail to answer here are deliberately NOT the same case:
 *
 * - ARCHIVED: the list says the endpoint exists and is switched off. That is a kill switch, so a
 *   policy naming it means every run on the agent dies at boot. Offering the key would be offering
 *   a broken agent, so it goes.
 * - MISSING from the list: model access is off, or the provider read did not come back. The form
 *   cannot tell whether the key is fine, so it stays offered and the orchestrator has the last
 *   word on save. Hiding it would read as "the key vanished", which is a worse lie than offering
 *   one the server may refuse.
 *
 * A harness that is not in the list at all (manual dev, no image map) is the same open case.
 *
 * A ChatGPT plan key is the exception: the proxy leaves the provider out on a deployment that is
 * not local, where every run on it would be refused. Missing means off, so it goes.
 */
export function usableProviderKeys(
  providerKeys: readonly ProviderKey[],
  providers: readonly Provider[],
  harness: Pick<Harness, "dialects"> | undefined,
): ProviderKey[] {
  const providerById = new Map(providers.map((p) => [p.id, p]));
  return providerKeys.filter((key) => {
    if (key.archivedAt !== null) return false;
    const provider = providerById.get(key.provider);
    if (key.plan !== undefined && provider === undefined) return false;
    if (provider !== undefined && provider.archivedAt !== null) return false;
    if (harness === undefined) return true;
    return provider === undefined || harness.dialects.includes(provider.dialect);
  });
}

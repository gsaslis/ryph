import {
  CHATGPT_PLAN_PROVIDER,
  type DeclaredModel,
  INCLUDED_PRICING,
  type Provider,
  type ProviderKey,
  type ThinkingLevel,
} from "$lib/api/types";
import { thinkingLevelsFor } from "./thinking";

/** The models a provider offers as choices: a custom endpoint's declared list, or the price
 * list's for a built-in. Empty when the provider is unknown, which leaves only free text. */
export function modelsOf(providers: Provider[], providerId: string | undefined): DeclaredModel[] {
  if (providerId === undefined) return [];
  return providers.find((p) => p.id === providerId)?.models ?? [];
}

/**
 * Whether a run's harness is handed the provider's models rather than knowing them: the runner
 * writes a custom endpoint's or a ChatGPT plan's into pi's models.json, where pi's own defaults
 * decide the levels a model with none named takes; a built-in's come from pi's catalogue. A
 * provider missing from the list is taken for the latter, which keeps every level open — nothing
 * is known of it. What `thinkingLevelsFor` reads as `declaredToPi`.
 */
export function declaredToPi(
  providers: readonly Provider[],
  providerId: string | undefined,
): boolean {
  const provider = providers.find((p) => p.id === providerId);
  return provider !== undefined && (!provider.builtin || provider.id === CHATGPT_PLAN_PROVIDER);
}

/**
 * The models one key offers. A ChatGPT plan key offers its own account's list, each model as
 * that account lists it (its own levels: two accounts can list one id differently), each
 * included in the plan. Any other key offers its provider's list.
 *
 * With no key in hand (the key list did not load, or does not have it), `providerId` — the
 * provider a policy was saved against — stands in: its entry's list, which for a plan is every
 * plan key's models at once, rather than nothing.
 */
export function modelsForKey(
  providers: Provider[],
  key: ProviderKey | undefined,
  providerId?: string,
): DeclaredModel[] {
  if (key === undefined) return modelsOf(providers, providerId);
  if (key.provider !== CHATGPT_PLAN_PROVIDER || key.plan === undefined) {
    return modelsOf(providers, key.provider);
  }
  return key.plan.models.map((model) => ({ ...model, pricing: INCLUDED_PRICING }));
}

/**
 * The levels a model takes on one key: read off the key's own list (`modelsForKey`), not the
 * provider's, which for a ChatGPT plan is every plan key's models at once. With no key in hand,
 * off `providerId`'s entry instead, the same stand-in `modelsForKey` takes.
 */
export function thinkingLevelsForKey(
  providers: Provider[],
  key: ProviderKey | undefined,
  modelId: string,
  providerId?: string,
): readonly ThinkingLevel[] {
  return thinkingLevelsFor(
    modelsForKey(providers, key, providerId),
    modelId,
    declaredToPi(providers, key?.provider ?? providerId),
  );
}

/**
 * What a single pick may choose from under an allowlist: every known model for "*", else the
 * listed ids in order, once each, with an id the provider does not list kept as a bare entry so
 * a stored value still shows.
 */
export function choicesFor(models: DeclaredModel[], allowed: "*" | string[]): DeclaredModel[] {
  if (allowed === "*") return models;
  return [...new Set(allowed)].map((id) => models.find((m) => m.id === id) ?? { id });
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
});

export const INCLUDED_LABEL = "Included in your ChatGPT plan";

/** "$2 / $10": input and output, USD per million tokens. Null for an unpriced model. */
export function priceLabel(model: DeclaredModel): string | null {
  if (model.pricing === INCLUDED_PRICING) return INCLUDED_LABEL;
  if (model.price === undefined) return null;
  return `${usd.format(model.price.input)} / ${usd.format(model.price.output)}`;
}

export const PRICE_HINT = "USD per million tokens, input / output";

/** The tooltip on a model's price: what the figure means, or nothing for an included model. */
export function priceHint(model: DeclaredModel): string | undefined {
  return model.pricing === INCLUDED_PRICING ? undefined : PRICE_HINT;
}

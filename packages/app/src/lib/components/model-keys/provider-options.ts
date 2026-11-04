// Which providers a key can be registered against, shared by the Model keys page and the welcome
// flow so both offer the same list.

import { CHATGPT_PLAN_PROVIDER, type Harness, type Provider } from "$lib/api/types";

/**
 * Every live provider (the two built-ins and the custom endpoints) whose wire dialect one of this
 * deployment's harnesses can actually drive. A deployment whose harnesses report no dialects at
 * all (it offers none, or only `echo`) says nothing useful about what is drivable, so the list
 * stays open and the orchestrator has the last word, as it does on every other policy. A ChatGPT
 * plan comes in through its own sign-in, never a pasted secret, so it is not offered.
 */
export function keyProviderOptions(
  providers: readonly Provider[],
  harnesses: readonly Pick<Harness, "dialects">[],
): Provider[] {
  const live = providers.filter((p) => p.archivedAt === null && p.id !== CHATGPT_PLAN_PROVIDER);
  const drivable = new Set(harnesses.flatMap((h) => h.dialects));
  return drivable.size === 0 ? live : live.filter((p) => drivable.has(p.dialect));
}

/**
 * The proxy lists the ChatGPT plan only on a deployment local to the person's machine; anywhere
 * else nothing signs one in, and a plan key made before can only be signed out.
 */
export function planSignInOffered(providers: readonly Pick<Provider, "id">[]): boolean {
  return providers.some((p) => p.id === CHATGPT_PLAN_PROVIDER);
}

/** "Groq (groq)": an operator picks the name, but keys and agents record the slug. */
export function providerOptionLabel(p: Pick<Provider, "id" | "label">): string {
  return p.label === p.id ? p.id : `${p.label} (${p.id})`;
}

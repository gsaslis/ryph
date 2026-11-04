// Issuing and revoking run credentials — the control-plane half of the proxy package,
// called by the orchestrator (never by the proxy process).
//
// Invariants:
// - `issue` returns the raw virtual token exactly once, inside the env map; only its hash
//   is stored. The env map's variable NAMES come from the provider registry, so a harness's
//   SDK picks the credential up without ever knowing ryph exists. A CUSTOM endpoint has no
//   SDK convention to borrow, so it gets ryph's own two names plus a config blob (see issue).
// - a provider is resolved through the STORE, not out of a constant: built-ins ∪ custom rows,
//   joined in `resolveProvider` and nowhere else
// - the scope (which provider key, which models) arrives frozen from the run's snapshot;
//   this service never reads live agent policy
// - issuing against an archived or unknown provider key throws: better a boot failure the
//   runner reports upstream than a run that starts and can never call a model

import type { AllowedModels, PlatformModelPolicy } from "./types.ts";
import { platformPrincipal, secretCleared } from "./types.ts";
import type { DeclaredModel, Dialect, ProviderSpec } from "./registry.ts";
import { CHATGPT_PLAN, PLAN_LOCAL_ONLY, type PlanModel } from "./chatgpt_plan.ts";
import {
  BUILTIN_PROVIDERS,
  customProviderSpec,
  MODEL_PROVIDER_CONFIG_ENV,
  planModelForRun,
} from "./registry.ts";
import type { KeyStore } from "../ports/key_store.ts";
import { mintId, mintToken, sha256Hex } from "@ryph/sealed";

/**
 * A DEFINITIVE refusal to mint: the scope names a provider, or a key, that can never satisfy it.
 * Distinguished from every other failure (a store that is down, a database that went away)
 * because the two deserve different answers on the wire — the internal surface turns this into a
 * 400 the caller must not retry, and everything else into a retryable 5xx. Same could-not-ask vs
 * definitive-no split the historian draws on its run-token verify.
 */
export class CredentialRefusedError extends Error {
  override readonly name = "CredentialRefusedError";
}

/**
 * A provider id to the spec that describes it: a built-in, or a `custom_providers` row projected
 * into the same shape. THE one join of the two sources — every other reader takes a ProviderSpec
 * and cannot tell them apart.
 *
 * An ARCHIVED custom endpoint still resolves, exactly as an archived provider key still reads:
 * rows resolve forever, and the refusal is the CALLER's to make, with the status its own surface
 * owns (the proxy's 403, the issuer's definitive 400). Answering null here instead would report
 * an archived endpoint as config drift — a 502 — which is a different and wrong story.
 */
export async function resolveProvider(store: KeyStore, id: string): Promise<ProviderSpec | null> {
  // hasOwn, not `in`: a provider id is user input, and `constructor` is not a provider.
  if (Object.hasOwn(BUILTIN_PROVIDERS, id)) return BUILTIN_PROVIDERS[id];
  const row = await store.getCustomProvider(id);
  return row === null ? null : customProviderSpec(row);
}

/**
 * Every provider this deployment knows, built-ins first — the order the pickers show. The
 * `chatgpt-plan` entry carries the union of its live keys' model lists, in their order: a plan's
 * models are whatever the signed-in accounts serve, and nothing else in the system knows them.
 * Where plan keys are off (a deployment that is not local) the entry is left out altogether.
 */
export async function listProviderSpecs(
  store: KeyStore,
  opts: { planOn: boolean },
): Promise<ProviderSpec[]> {
  const custom = await store.listCustomProviders();
  const planModels = new Map<string, DeclaredModel>();
  for (const key of await store.listProviderKeys()) {
    if (key.provider !== CHATGPT_PLAN || key.archivedAt !== null || !key.plan) continue;
    for (const model of key.plan.models) {
      if (!planModels.has(model.id)) planModels.set(model.id, model);
    }
  }
  return [
    ...Object.values(BUILTIN_PROVIDERS)
      .filter((spec) => opts.planOn || spec.id !== CHATGPT_PLAN)
      .map((spec) =>
        spec.id === CHATGPT_PLAN ? { ...spec, models: [...planModels.values()] } : spec
      ),
    ...custom.map(customProviderSpec),
  ];
}

/**
 * The models a plan key's run is told about: the account's own list, or — when it was never
 * fetched — the run's own allowlist, which is at least what the run may name. Empty only for a
 * key with no list and a run allowed everything, which the issuer refuses: pi cannot select a
 * model from an empty provider.
 */
function planModelsForRun(
  models: readonly PlanModel[],
  allowed: AllowedModels,
): DeclaredModel[] {
  // The efforts stay here: the proxy fits a request's effort to them, and the run's wire
  // contract is `DeclaredModel` — which carries them on as the thinking levels they are, so pi
  // clamps a level to what the model takes before the proxy has anything to fit. A model known
  // only by its name is said to be nothing more, and pi runs it as one that does not reason.
  if (models.length > 0) return models.map(planModelForRun);
  return allowed === "*" ? [] : allowed.map((id) => ({ id }));
}

/** What a run may spend: decided at provision time, handed here verbatim at boot. */
export interface CredentialScope {
  runId: string;
  /** The run's agent and task — attribution for every usage row the credential spends. */
  agentId: string;
  taskId: string;
  providerKeyId: string;
  provider: string;
  allowedModels: AllowedModels;
  /** The run's spend cap in USD; absent or null means uncapped. */
  spendUsd?: number | null;
  /** Spending calls the proxy may hold open at once; absent or null means uncapped. */
  callsInFlight?: number | null;
}

export interface CredentialIssuer {
  /**
   * Mints a run-scoped virtual key and returns the env the container's harness needs:
   * the provider's key variable carrying the virtual token, and its base-URL variable
   * pointing at the proxy.
   */
  issue(scope: CredentialScope): Promise<Record<string, string>>;
  /** Kills every live credential of a concluded run. Idempotent. */
  revokeForRun(runId: string): Promise<void>;
}

export interface CredentialIssuerDeps {
  store: KeyStore;
  now(): Date;
  /** The proxy address as seen FROM AN AGENT CONTAINER — a container-network address, usually. */
  proxyUrl: string;
  /** Backstop lifetime; revocation on run conclusion is the primary cutoff. */
  ttlMs?: number;
  /** Whether ChatGPT plan keys may be issued: only on a local deployment (see setup.ts). */
  planOn?: boolean;
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

/** The refusal for a key holding no secret: it must be entered again (`secretCleared`). */
const NEEDS_SECRET = (keyId: string) =>
  `provider key "${keyId}" must have its secret entered again under Model keys: its endpoint ` +
  "changed";

export function makeCredentialIssuer(deps: CredentialIssuerDeps): CredentialIssuer {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;

  return {
    async issue(scope) {
      const provider = await resolveProvider(deps.store, scope.provider);
      if (!provider) throw new CredentialRefusedError(`unknown provider "${scope.provider}"`);
      if (provider.archivedAt !== null) {
        // The same kill switch archiving a provider key throws, one level up: the endpoint is
        // withdrawn, so a run that would dial it must boot-fail now rather than start and 403
        // on its first model call.
        throw new CredentialRefusedError(`model endpoint "${scope.provider}" is archived`);
      }

      const key = await deps.store.getProviderKey(scope.providerKeyId);
      if (!key) {
        throw new CredentialRefusedError(`provider key "${scope.providerKeyId}" does not exist`);
      }
      if (key.archivedAt !== null) {
        throw new CredentialRefusedError(`provider key "${scope.providerKeyId}" is archived`);
      }
      if (key.provider !== scope.provider) {
        throw new CredentialRefusedError(
          `provider key "${scope.providerKeyId}" is for "${key.provider}", not "${scope.provider}"`,
        );
      }
      if (secretCleared(key)) {
        throw new CredentialRefusedError(NEEDS_SECRET(scope.providerKeyId));
      }

      if (provider.id === CHATGPT_PLAN && !deps.planOn) {
        throw new CredentialRefusedError(PLAN_LOCAL_ONLY);
      }
      if (
        provider.id === CHATGPT_PLAN &&
        planModelsForRun(key.plan?.models ?? [], scope.allowedModels).length === 0
      ) {
        throw new CredentialRefusedError(
          `ChatGPT plan key "${scope.providerKeyId}" has no model list — refresh it under ` +
            "Model keys, or name the run's models in the agent's policy",
        );
      }
      if (provider.id === CHATGPT_PLAN && key.planStatus === "needs_reauth") {
        throw new CredentialRefusedError(
          `ChatGPT plan key "${scope.providerKeyId}" needs signing in again`,
        );
      }

      const at = deps.now();
      // prefixed, so one read as it flashes past in a debug session is recognizably a ryph run
      // credential and not a real provider key
      const token = `ryph-vk-${mintToken()}`;
      await deps.store.createVirtualKey({
        id: mintId("vk"),
        runId: scope.runId,
        agentId: scope.agentId,
        taskId: scope.taskId,
        providerKeyId: scope.providerKeyId,
        tokenHash: await sha256Hex(token),
        allowedModels: scope.allowedModels,
        spendUsd: scope.spendUsd ?? null,
        callsInFlight: scope.callsInFlight ?? null,
        expiresAt: new Date(at.getTime() + ttlMs).toISOString(),
        revokedAt: null,
        createdAt: at.toISOString(),
      });

      const env: Record<string, string> = {
        [provider.keyEnv]: token,
        [provider.baseUrlEnv]: deps.proxyUrl.replace(/\/+$/, "") + provider.clientBasePath,
      };
      // A custom endpoint needs a third entry, because the harness has no built-in catalogue to
      // override: which slug this is, which dialect it speaks, and every model it serves. It
      // rides the env map rather than a new response field precisely so the orchestrator→runner
      // wire shape does not change — the map flows through both untouched. No secret is in it:
      // the token is the key var above, and `extraHeaders` never leaves the proxy at all.
      //
      // A ChatGPT plan rides the same way, with the KEY's model list: pi knows no `chatgpt-plan`
      // provider, and what the plan serves is per account.
      if (provider.id === CHATGPT_PLAN) {
        const models = planModelsForRun(key.plan?.models ?? [], scope.allowedModels);
        env[MODEL_PROVIDER_CONFIG_ENV] = JSON.stringify({
          id: provider.id,
          dialect: provider.dialect,
          models,
        });
      } else if (!provider.builtin) {
        env[MODEL_PROVIDER_CONFIG_ENV] = JSON.stringify({
          id: provider.id,
          dialect: provider.dialect,
          models: provider.models,
        });
      }
      return env;
    },

    async revokeForRun(runId) {
      await deps.store.revokeVirtualKeysForRun(runId, deps.now().toISOString());
    },
  };
}

// ── The platform's own credentials ─────────────────────────────────────────────────────────
//
// The same minting one principal over: a virtual key for the platform's OWN background work —
// the memory consolidator first — minted from the admin-set platform policy rather than from a
// run's frozen scope, and metered under `platform:<consumer>` where a run's is metered under its
// run id. Nothing but the proxy holds a real provider key, so this is how any off-run model
// call is made: mint a platform credential, dial the proxy's data plane, spend under policy.

/** What a platform consumer holds: a proxy credential and the policy's model. */
export interface PlatformCredential {
  /** The raw virtual token — returned exactly once, never stored. */
  token: string;
  provider: string;
  /** The wire dialect that provider speaks: what the consumer builds its request body in. A
   * custom endpoint's slug says nothing about its shape, so the shape travels beside it. */
  dialect: Dialect;
  /** The policy's default model; the consumer may name another within `allowedModels`. */
  model: string;
  allowedModels: AllowedModels;
  expiresAt: string;
  /** The provider's SDK base path on the proxy (`/v1` for OpenAI, bare for Anthropic). */
  basePath: string;
}

export interface PlatformCredentialIssuer {
  /** Mints a platform-scoped virtual key for one consumer ("memory"), revoking whatever that
   * consumer already held — one live credential per consumer, never a pile. Refuses definitively
   * when no platform policy is set or its key is archived. */
  issue(consumer: string): Promise<PlatformCredential>;
  /** Kills every live platform credential of one consumer. Idempotent. */
  revoke(consumer: string): Promise<void>;
}

export interface PlatformCredentialIssuerDeps {
  store: KeyStore;
  now(): Date;
  /** Backstop lifetime; consumers re-mint when a credential lapses. */
  ttlMs?: number;
}

const DEFAULT_PLATFORM_TTL_MS = 24 * 60 * 60 * 1000;

/** The platform policy's key, checked live: an archived key is a refusal, never a credential. */
export async function resolvePlatformPolicy(
  store: KeyStore,
): Promise<{ policy: PlatformModelPolicy; provider: ProviderSpec }> {
  const policy = await store.getPlatformPolicy();
  if (policy === null) {
    throw new CredentialRefusedError(
      "no platform model policy is set — an admin picks the key" +
        " the platform's own model calls spend, under Model keys",
    );
  }
  const provider = await resolveProvider(store, policy.provider);
  if (!provider) throw new CredentialRefusedError(`unknown provider "${policy.provider}"`);
  if (provider.archivedAt !== null) {
    throw new CredentialRefusedError(`model endpoint "${policy.provider}" is archived`);
  }
  const key = await store.getProviderKey(policy.providerKeyId);
  if (!key) {
    throw new CredentialRefusedError(`provider key "${policy.providerKeyId}" does not exist`);
  }
  if (key.archivedAt !== null) {
    throw new CredentialRefusedError(`provider key "${policy.providerKeyId}" is archived`);
  }
  if (key.provider !== policy.provider) {
    throw new CredentialRefusedError(
      `provider key "${policy.providerKeyId}" is for "${key.provider}", not "${policy.provider}"`,
    );
  }
  if (secretCleared(key)) throw new CredentialRefusedError(NEEDS_SECRET(policy.providerKeyId));
  return { policy, provider };
}

export function makePlatformCredentialIssuer(
  deps: PlatformCredentialIssuerDeps,
): PlatformCredentialIssuer {
  const ttlMs = deps.ttlMs ?? DEFAULT_PLATFORM_TTL_MS;
  return {
    async issue(consumer) {
      const { policy, provider } = await resolvePlatformPolicy(deps.store);
      const at = deps.now();
      // EXACTLY ONE live credential per consumer. A consumer re-mints on every restart, every
      // expiry and every 401, and without this each of those left the previous key alive until
      // its own TTL ran out — an unbounded pile of working credentials for one caller.
      await deps.store.revokeVirtualKeysForRun(platformPrincipal(consumer), at.toISOString());
      const token = `ryph-vk-${mintToken()}`;
      const expiresAt = new Date(at.getTime() + ttlMs).toISOString();
      await deps.store.createVirtualKey({
        id: mintId("vk"),
        runId: platformPrincipal(consumer),
        agentId: null,
        taskId: null,
        providerKeyId: policy.providerKeyId,
        tokenHash: await sha256Hex(token),
        allowedModels: policy.allowedModels,
        spendUsd: null,
        callsInFlight: null,
        expiresAt,
        revokedAt: null,
        createdAt: at.toISOString(),
      });
      return {
        token,
        provider: provider.id,
        dialect: provider.dialect,
        model: policy.model,
        allowedModels: policy.allowedModels,
        expiresAt,
        basePath: provider.clientBasePath,
      };
    },
    async revoke(consumer) {
      await deps.store.revokeVirtualKeysForRun(
        platformPrincipal(consumer),
        deps.now().toISOString(),
      );
    },
  };
}

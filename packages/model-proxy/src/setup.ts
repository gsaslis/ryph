// The package's startup contract for the mounted deployment: one call builds both halves —
// the control side (key CRUD routes, the credential issuer) and the data side (the proxy
// handler) — over the ONE key store the composition root provides. The standalone data-plane
// process composes makeProxyHandler directly instead; it serves no management surface.

import {
  type CredentialIssuer,
  makeCredentialIssuer,
  makePlatformCredentialIssuer,
  type PlatformCredentialIssuer,
} from "./core/service.ts";
import type { MasterKey } from "@ryph/sealed";
import { makeProxySealer } from "./core/sealing.ts";
import { makeProxyHandler, type ProxyDiag } from "./http/proxy.ts";
import type { Route } from "@ryph/shared/http";
import { providerKeyRoutes } from "./http/routes.ts";
import {
  type CallbackListener,
  makeCallbackListener,
  planOffRoutes,
  planRoutes,
} from "./http/chatgpt_plan.ts";
import { makePlanKeys } from "./core/plan_keys.ts";
import type { OpenAiAccounts } from "./ports/openai_accounts.ts";
import { openAiAccounts } from "./adapters/openai/accounts.ts";
import { usageRoutes } from "./http/usage.ts";
import type { KeyStore } from "./ports/key_store.ts";
import type { ResolveHost } from "./schema.ts";
import { refreshGauge, type RunSpend, spendOfRun } from "./core/spend.ts";
import { type DeploymentGauge, makeDeploymentGauge, makeSpendMeter } from "./core/spend_meter.ts";

/** The deployment's spend ceiling over a rolling window, or null for none. */
export interface SpendCeiling {
  usd: number;
  windowDays: number;
}

export interface SpendLimits {
  /** How long a run may sit past its spend cap before the proxy refuses its calls itself. */
  backstopMs: number;
  ceiling: SpendCeiling | null;
}

export interface ModelProxySetupDeps {
  store: KeyStore;
  /** RYPH_SECRETS_KEY: provider keys and sign-in verifiers are sealed under keys derived from
   * it, one per class. */
  masterKey: MasterKey;
  /** The user-surface gate for READING keys and the platform policy, provided by the mounting
   * host. */
  authenticate(req: Request): Promise<Response | null>;
  /** The same gate narrowed to `models:manage`, for everything that touches a credential:
   * registering,
   * rotating and archiving a provider key, and setting or clearing the platform model policy. */
  authenticateManage(req: Request): Promise<Response | null>;
  /** The gate on a window's usage report, everyone's spend rolled up: `usage:read-all`. */
  authenticateUsage(req: Request): Promise<Response | null>;
  /** The gate on one run's bill: its grant from the control plane, or `usage:read-all`. */
  authenticateRunRead(req: Request, runId: string): Promise<Response | null>;
  /**
   * The proxy address as seen FROM AN AGENT CONTAINER.
   * null: credentials cannot be issued (the issuer comes back null).
   */
  proxyUrl: string | null;
  /** Backstop lifetime of a run's virtual key. */
  virtualKeyTtlMs: number;
  limits: SpendLimits;
  now(): Date;
  proxyDiag: ProxyDiag;
  /**
   * ChatGPT plan keys, ON only where this is given: a deployment local to the person's machine
   * (the binary, `bun run up`). OpenAI offers plan usage to locally run apps; a remotely
   * hosted one needs its approval first, and its sign-in's return to 127.0.0.1 never reaches a
   * remote process anyway. Off, nothing signs in, no run is issued a plan key, the data plane
   * refuses one, and `/v1/providers` does not list the provider; signing an existing key out
   * still works, so a key made before the cut can be revoked.
   */
  chatgptPlan?: ChatgptPlanOptions;
  /** OpenAI's accounts service, or a fake of it: plan keys reach it to sign in and, on or off,
   * to sign out. */
  openAiAccounts?: OpenAiAccounts;
  /** Resolves a custom endpoint's host, at registration and before a forward; the platform's
   * DNS unless a test fakes it. */
  resolveHost?: ResolveHost;
}

export interface ChatgptPlanOptions {
  /** The sign-in listener's port; the documented 1455 unless a test binds another. */
  callbackPort?: number;
}

export interface ModelProxySetup {
  /** Key CRUD for the control plane's route table. */
  routes: Route[];
  /** Mints and revokes run credentials; null when no proxy URL is configured. */
  issuer: CredentialIssuer | null;
  /** Mints credentials for the platform's own model calls, from the admin-set platform policy.
   * Needs no proxy URL: a platform consumer knows how it reaches the proxy. */
  platformIssuer: PlatformCredentialIssuer;
  /** The data plane — served on its own listener in every deployment. */
  proxyHandler: (req: Request) => Promise<Response>;
  /** One run's priced total: what the orchestrator's sweep compares to the run's cap. */
  spendOf(runId: string): Promise<RunSpend>;
  /** Whether the deployment's ceiling is reached; false when none is set. */
  ceilingReached(): Promise<boolean>;
  /** The ChatGPT sign-in listener, for the composition root to close on shutdown; null where
   * plan keys are off. */
  planListener: CallbackListener | null;
}

/** Builds the package's contributions to the deployment over the provided key store. */
export function setup(deps: ModelProxySetupDeps): ModelProxySetup {
  const { store, now } = deps;
  const sealer = makeProxySealer(deps.masterKey);
  const planOn = deps.chatgptPlan !== undefined;
  const issuer = deps.proxyUrl === null ? null : makeCredentialIssuer({
    store,
    now,
    proxyUrl: deps.proxyUrl,
    ttlMs: deps.virtualKeyTtlMs,
    planOn,
  });
  const meter = makeSpendMeter({ backstopMs: deps.limits.backstopMs });
  const ceiling = deps.limits.ceiling;
  const gauge: DeploymentGauge | null = ceiling === null ? null : makeDeploymentGauge({
    ceilingUsd: ceiling.usd,
    windowDays: ceiling.windowDays,
  });
  const ceilingReached = async (): Promise<boolean> => {
    if (gauge === null) return false;
    await refreshGauge(gauge, store, now().getTime());
    return gauge.reached();
  };
  const plan = makePlanKeys({
    store,
    accounts: deps.openAiAccounts ?? openAiAccounts(),
    seal: sealer.sealKey,
    unseal: sealer.openKey,
    sealVerifier: sealer.sealVerifier,
    unsealVerifier: sealer.openVerifier,
    now,
    diag: deps.proxyDiag,
  });
  const planListener = !planOn ? null : makeCallbackListener({
    ...(deps.chatgptPlan?.callbackPort === undefined
      ? {}
      : { port: deps.chatgptPlan.callbackPort }),
    complete: async (query) => (await plan.completeSignIn(query)).ok,
    pending: async (id) => (await plan.signInStatus(id))?.status === "pending",
    now,
    diag: deps.proxyDiag,
  });
  return {
    routes: [
      ...providerKeyRoutes({
        store,
        encrypt: sealer.sealKey,
        authenticate: deps.authenticate,
        authenticateManage: deps.authenticateManage,
        now,
        archivePlanKey: plan.archive,
        planOn,
        ...(deps.resolveHost === undefined ? {} : { resolveHost: deps.resolveHost }),
      }),
      ...(planListener === null ? planOffRoutes({ authenticate: deps.authenticate }) : planRoutes({
        plan,
        listener: planListener,
        authenticateManage: deps.authenticateManage,
      })),
      ...usageRoutes({
        store,
        authenticateWindow: deps.authenticateUsage,
        authenticateRunRead: deps.authenticateRunRead,
        now,
        ceiling,
        gauge,
      }),
    ],
    issuer,
    platformIssuer: makePlatformCredentialIssuer({ store, now }),
    proxyHandler: makeProxyHandler({
      store,
      decrypt: sealer.openKey,
      now,
      diag: deps.proxyDiag,
      limits: { meter, gauge },
      ...(planOn ? { plan } : {}),
      ...(deps.resolveHost === undefined ? {} : { resolveHost: deps.resolveHost }),
    }),
    spendOf: (runId) => spendOfRun(store, runId),
    ceilingReached,
    planListener,
  };
}

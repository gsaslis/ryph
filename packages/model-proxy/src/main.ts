// The STANDALONE composition root — the model proxy as its own process, for the networked
// deployment where each service is its own socket. The default single-process deployment is
// @ryph/host, which instead calls setup() and spreads this package's routes into its own
// router; this file knows which adapter stands behind each gate, reads the environment, and owns
// the sockets.
//
// TWO LISTENERS, deliberately, because the two halves this package has always had (see mod.ts)
// have nothing in common but a key store:
// - the DATA plane (RYPH_MODEL_PROXY_PORT): what agent containers dial as their "provider".
//   Streams every token of every completion, authenticates virtual keys, and must be reachable
//   from the run network — which is exactly the network least entitled to a management surface.
// - the CONTROL plane (RYPH_MODEL_PROXY_CONTROL_PORT): key CRUD for users, gated by the same
//   @ryph/auth JWKS the orchestrator and historian verify against, plus the internal surface
//   the control plane dials to mint and kill run credentials. Nothing an agent container should
//   be able to reach at all.
//
// The master key lives HERE and only here: once key CRUD moved onto this listener, nothing in
// the control plane needs to unseal a provider secret, and a compromised control plane should not
// be able to.

import { Logger, setupLoggerFromEnv } from "@ryph/logger";
import { verifierFromUrl } from "@ryph/auth";
import {
  installDrain,
  makeHealth,
  quietDrainErrors,
  refusePublicDevSecrets,
  serve,
  trackStreams,
} from "@ryph/service";
import { importMasterKey, makeRunReadGate, makeServiceGate, type MasterKey } from "@ryph/sealed";
import { makeRouter } from "@ryph/shared/http";
import { makeCapabilityGate, makeGrantBearer } from "@ryph/auth/gates";
import { internalCredentialRoutes, platformCredentialRoutes } from "./http/internal.ts";
import { setup } from "./setup.ts";
import { privateModelEndpointsAllowed } from "./schema.ts";
import { drizzleKeyStore } from "./adapters/store/drizzle.ts";
import { makeModelProxyDb } from "./adapters/store/db/db.ts";

const env = (name: string): string | undefined => process.env[name] || undefined;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

const intEnv = (name: string, fallback: number): number => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};

/** How long before the drain deadline a still-streaming completion is ended. */
const STREAM_CUT_BEFORE_DEADLINE_MS = 3_000;

/** Like `intEnv`, but zero is a meaningful answer — "no pause", "no deadline". */
const msEnv = (name: string, fallback: number): number => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    fail(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};

/** A positive decimal amount of money, or null when the variable is unset — no ceiling. */
const usdEnv = (name: string): number | null => {
  const raw = env(name);
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    fail(`${name} must be a positive amount in USD, got ${JSON.stringify(raw)}`);
  }
  return value;
};

export async function main(): Promise<void> {
  refusePublicDevSecrets("model-proxy");
  const port = intEnv("RYPH_MODEL_PROXY_PORT", 7420);
  const controlPort = intEnv("RYPH_MODEL_PROXY_CONTROL_PORT", 7421);
  setupLoggerFromEnv();
  const log = new Logger("model-proxy");
  const diag = {
    debug: (event: string, fields?: Record<string, unknown>) => log.debug(event, fields),
    warn: (event: string, fields?: Record<string, unknown>) => log.warn(event, fields),
  };

  const masterKeyHex = env("RYPH_SECRETS_KEY") ??
    fail("RYPH_SECRETS_KEY is required — the proxy cannot unseal keys without it");
  let masterKey: MasterKey;
  try {
    masterKey = await importMasterKey(masterKeyHex);
  } catch (err) {
    fail(`RYPH_SECRETS_KEY: ${err instanceof Error ? err.message : String(err)}`);
  }

  // A ryph database URL (see @ryph/db). A standalone proxy owns its own database —
  // `ryph_keys` in Mode B — and is the only reader and writer of these tables; the control
  // plane reaches them over the internal surface below, never by connecting here.
  const dbUrl = env("RYPH_DB") ?? "pglite:./data/ryph";
  const dbHandle = await makeModelProxyDb(dbUrl);
  const store = drizzleKeyStore(dbHandle);
  try {
    await store.listProviderKeys();
  } catch (err) {
    // The handle's description is password-redacted; the raw URL never reaches a log.
    fail(
      `database ${dbHandle.description} did not answer the startup probe ` +
        `(${err instanceof Error ? err.message : String(err)}) — if it has no schema, run ` +
        "`bun run db:push` in packages/model-proxy. On Kubernetes the pod's `migrate` init " +
        "container applies it before this starts: read its log (`kubectl logs <pod> -c migrate`). " +
        "If the database did not answer at all, check RYPH_DB and the NetworkPolicy to the database",
    );
  }

  // What an AGENT CONTAINER dials — a container-network address, not this process's bind address.
  // Unset, keys can still be registered and rotated; only minting is refused, and it says so.
  const proxyUrl = env("RYPH_MODEL_PROXY_URL") ?? null;
  if (proxyUrl === null) {
    log.warn("RYPH_MODEL_PROXY_URL unset — runs with a model policy will fail at boot");
  }

  // Key CRUD: the same @ryph/auth verification the orchestrator does, against the SAME JWKS,
  // which is what lets the app forward one user bearer to whichever service owns the path.
  const authDisabled = env("RYPH_AUTH") === "off";
  if (authDisabled) log.warn("RYPH_AUTH=off — the key management surface is OPEN");
  const authUrl = env("RYPH_AUTH_URL");
  if (authUrl && !URL.canParse("/.well-known/jwks.json", authUrl)) {
    fail(`RYPH_AUTH_URL must be a valid absolute URL, got ${JSON.stringify(authUrl)}`);
  }
  const verifier = authUrl
    ? verifierFromUrl(new URL("/.well-known/jwks.json", authUrl).href)
    : { verify: () => Promise.resolve(null) };
  if (!authUrl && !authDisabled) {
    log.warn("RYPH_AUTH_URL unset — no user token verifies, so nobody can manage keys");
  }
  const gateOpts = {
    verifier,
    disabled: authDisabled,
  };
  // Two gates over one verification: LISTING keys and reading the platform policy takes
  // `models:read` (the app shows both), while registering, rotating or archiving a key — and
  // deciding which one the platform's own model calls spend — takes `models:manage`.
  const authenticate = makeCapabilityGate(gateOpts, "models:read");
  const authenticateManage = makeCapabilityGate(gateOpts, "models:manage");

  // A security-relevant knob, so it says so at boot rather than only in a refusal that did not
  // happen: with this on, an admin may point a model endpoint at an address inside the network.
  if (privateModelEndpointsAllowed()) {
    log.warn(
      "RYPH_ALLOW_PRIVATE_MODEL_ENDPOINTS=1 — a custom model endpoint may be plain http and " +
        "may name a private or loopback address",
    );
  }

  // The control plane presents this on the internal surface, and signs run grants with it: a
  // run's bill is read with the grant minted for that run, everyone's with `usage:read-all`.
  const modelProxyToken = env("RYPH_MODEL_PROXY_TOKEN") ?? null;
  const authenticateUsage = makeCapabilityGate(gateOpts, "usage:read-all");
  // The deployment's LAST LINE on model spend: a rolling ceiling in the environment, so nobody
  // raises it from an admin session. Unset is no ceiling; the per-run caps still apply.
  const ceilingUsd = usdEnv("RYPH_MODEL_SPEND_CEILING_USD");
  const limits = {
    backstopMs: msEnv("RYPH_MODEL_SPEND_BACKSTOP_MS", 30_000),
    ceiling: ceilingUsd === null
      ? null
      : { usd: ceilingUsd, windowDays: intEnv("RYPH_MODEL_SPEND_WINDOW_DAYS", 30) },
  };
  const proxy = setup({
    store,
    masterKey,
    authenticate,
    authenticateManage,
    authenticateUsage,
    authenticateRunRead: makeRunReadGate({
      grantKey: modelProxyToken,
      // The grant is scope proof, never identity proof: it passes only alongside a verified
      // bearer too (any one — no particular capability, since the grant already named the run).
      bearer: makeGrantBearer(gateOpts),
      fallback: authenticateUsage,
    }),
    proxyUrl,
    virtualKeyTtlMs: intEnv("RYPH_VIRTUAL_KEY_TTL_MS", 12 * 60 * 60 * 1000),
    limits,
    now: () => new Date(),
    proxyDiag: diag,
    // No `chatgptPlan`: a standalone proxy is a networked deployment, never one local to the
    // person's machine, so ChatGPT plan keys are off (see setup.ts).
  });

  // The internal surface exists only for a REMOTE control plane, so it is gated on having a
  // credential to check rather than mounted unauthenticated. Same stance as the orchestrator's
  // run-token verify surface, which is dark unless a standalone historian is configured.
  if (modelProxyToken === null) {
    log.warn(
      "RYPH_MODEL_PROXY_TOKEN unset — the internal surface is dark, so no control plane can " +
        "issue run credentials from this proxy",
    );
  }
  const internalRoutes = modelProxyToken === null ? [] : internalCredentialRoutes({
    store,
    issuer: proxy.issuer,
    spend: { ofRun: proxy.spendOf, ceilingReached: proxy.ceilingReached, ceiling: limits.ceiling },
    authenticate: makeServiceGate(modelProxyToken),
    now: () => new Date(),
    diag,
  });

  // The platform route: what a platform CONSUMER (the memory service) dials for a credential of
  // its own. Its own token, so a consumer can mint platform credentials and nothing else — the
  // control plane's token would also let it issue run credentials and read key metadata.
  const platformToken = env("RYPH_PLATFORM_TOKEN") ?? null;
  if (platformToken === null) {
    log.warn(
      "RYPH_PLATFORM_TOKEN unset — no platform consumer can mint a credential here, so the " +
        "memory consolidator runs without a model",
    );
  }
  const platformRoutes = platformToken === null ? [] : platformCredentialRoutes({
    issuer: proxy.platformIssuer,
    authenticate: makeServiceGate(platformToken),
    diag,
  });

  // Readiness is one cheap read of the table both halves depend on. Liveness asks nothing: a
  // database outage must route traffic away, never restart the fleet into a crash loop.
  const health = makeHealth({ ready: () => store.listProviderKeys(), log: diag });

  // Both listeners answer the probes. They fail independently — a bound port is not a served
  // request — and a platform health-checks each target group it routes to, not the process.
  const dataStreams = trackStreams({ work: () => true });
  const controlStreams = trackStreams();
  const dataServer = await serve(
    { port, onError: quietDrainErrors },
    dataStreams.wrap(async (req) => {
      for (const route of health.routes) {
        if (req.method === route.method && route.pattern.exec(req.url)) {
          return await route.handler(req, {});
        }
      }
      return await proxy.proxyHandler(req);
    }),
  );
  const controlServer = await serve(
    { port: controlPort },
    controlStreams.wrap(
      makeRouter([...health.routes, ...proxy.routes, ...internalRoutes, ...platformRoutes]),
    ),
  );
  log.info(`data plane on :${port}, control plane on :${controlPort}`, {
    db: dbHandle.description,
    proxyUrl: proxyUrl ?? "unset",
    auth: authUrl ?? (authDisabled ? "off" : "none"),
    internal: modelProxyToken === null ? "dark" : "on",
    platform: platformToken === null ? "dark" : "on",
    spendCeiling: limits.ceiling === null
      ? "none"
      : `$${limits.ceiling.usd} per ${limits.ceiling.windowDays} days`,
  });

  // The data plane streams completions, so an in-flight request here can legitimately run for
  // minutes — the deadline is what keeps a drain bounded anyway, at the cost of cutting the
  // longest of them. A cut forward is a failed model call the harness sees and can retry; a
  // SIGKILL past the platform's grace would cut them all, plus everything else. Streams are
  // work here, not tails, so they get most of the deadline before the drain ends them itself —
  // which lands the cut inside the deadline rather than at it.
  const deadlineMs = msEnv("RYPH_DRAIN_DEADLINE_MS", 25_000);
  installDrain({
    servers: [
      {
        name: "data plane",
        server: dataServer,
        streams: dataStreams,
        streamsGraceMs: Math.max(0, deadlineMs - STREAM_CUT_BEFORE_DEADLINE_MS),
      },
      { name: "control plane", server: controlServer, streams: controlStreams },
    ],
    beginDrain: health.beginDrain,
    close: async () => {
      await proxy.planListener?.close();
      await store.close();
    },
    preStopMs: msEnv("RYPH_PRE_STOP_MS", 0),
    deadlineMs,
    log,
  });
}

if (import.meta.main) {
  await main();
}

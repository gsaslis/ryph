// The STANDALONE composition root — the memory service as its own process, for the networked
// deployment where each service is its own socket. The default local deployment is @ryph/host,
// which instead spreads this package's routes into its own handler and holds the access object
// in-process. This file knows which adapter stands behind each gate, reads the environment, owns
// the listening socket, and ticks the consolidator.
//
// Three credentials, three surfaces:
// - the management routes verify the same @ryph/auth tokens the orchestrator does, against
//   the same RYPH_AUTH_URL JWKS — the app forwards one user bearer to whichever service owns
//   the path.
// - the internal surface (`/internal/v1/runs/…`) takes RYPH_MEMORY_TOKEN, the shared service
//   credential the orchestrator presents to compose a run's brief and report its outcome.
// - the MCP data route takes RYPH_MEMORY_GATEWAY_TOKEN, which only the gateway holds, plus
//   the run id in a header only the gateway sets.

import { Logger, setupLoggerFromEnv } from "@ryph/logger";
import { verifierFromUrl } from "@ryph/auth";
import { installDrain, makeHealth, refusePublicDevSecrets, serve } from "@ryph/service";
import { makeRouter } from "@ryph/shared/http";
import { workerEmbedder } from "./adapters/embed/worker_embedder.ts";
import { httpPlatformCredentials } from "./adapters/model/platform_http.ts";
import { proxyModelClient } from "./adapters/model/proxy.ts";
import { makeMemoryDb } from "./adapters/store/db/db.ts";
import { drizzleMemoryStore } from "./adapters/store/drizzle.ts";
import { makeAuthenticate } from "@ryph/auth/gates";
import { setup } from "./setup.ts";
import type { MemoryStore } from "./ports/store.ts";

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

export async function main(): Promise<void> {
  refusePublicDevSecrets("memory");
  const port = intEnv("RYPH_MEMORY_PORT", 7440);
  setupLoggerFromEnv();
  const log = new Logger("memory");
  // A promise nobody awaits that rejects would end the process; every background promise here
  // is meant to settle onto a row or a log line, so one that escapes is logged, not fatal.
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { err: String(reason) });
  });
  const diag = {
    debug: (event: string, fields?: Record<string, unknown>) => log.debug(event, fields),
    warn: (event: string, fields?: Record<string, unknown>) => log.warn(event, fields),
  };

  // RYPH_MEMORY_DB is a ryph database URL (see @ryph/db). A standalone memory service owns
  // its own database — `ryph_memory` in the networked deployment — never the control plane's.
  // Schema is applied with drizzle-kit, never here: the probe below fails fast if it was not.
  const dbUrl = env("RYPH_MEMORY_DB") ?? "pglite:./data/ryph-memory";
  const dbHandle = await makeMemoryDb(dbUrl);
  const store: MemoryStore = drizzleMemoryStore(dbHandle);
  try {
    await store.listMemories({ tenantId: "startup-probe", limit: 1 });
  } catch (err) {
    // The handle's description is password-redacted; the raw URL never reaches a log.
    fail(
      `memory database ${dbHandle.description} did not answer the startup probe ` +
        `(${err instanceof Error ? err.message : String(err)}) — if it has no schema, run ` +
        "`bun run db:push` in packages/memory. On Kubernetes the pod's `migrate` init " +
        "container applies it before this starts: read its log (`kubectl logs <pod> -c migrate`). " +
        "If the database did not answer at all, check RYPH_MEMORY_DB and the NetworkPolicy to the database",
    );
  }

  const authDisabled = env("RYPH_AUTH") === "off";
  if (authDisabled) log.warn("RYPH_AUTH=off — the memory management surface is OPEN");
  const authUrl = env("RYPH_AUTH_URL");
  if (authUrl && !URL.canParse("/.well-known/jwks.json", authUrl)) {
    fail(`RYPH_AUTH_URL must be a valid absolute URL, got ${JSON.stringify(authUrl)}`);
  }
  const verifier = authUrl
    ? verifierFromUrl(new URL("/.well-known/jwks.json", authUrl).href)
    : { verify: () => Promise.resolve(null) };
  if (!authUrl && !authDisabled) {
    log.warn("RYPH_AUTH_URL unset — no user token verifies, so nobody can manage memory");
  }
  const authenticate = makeAuthenticate({
    verifier,
    disabled: authDisabled,
  });

  const serviceToken = env("RYPH_MEMORY_TOKEN") ?? null;
  if (serviceToken === null) {
    log.warn(
      "RYPH_MEMORY_TOKEN unset — the internal surface is dark, so no orchestrator can " +
        "compose a brief from this service",
    );
  }
  const gatewayToken = env("RYPH_MEMORY_GATEWAY_TOKEN") ?? null;
  if (gatewayToken === null) {
    log.warn("RYPH_MEMORY_GATEWAY_TOKEN unset — the MCP data route refuses every call");
  }

  // The platform's model: a credential minted from the proxy's platform policy over its internal
  // platform route (RYPH_PLATFORM_TOKEN), spent on its data plane (RYPH_MODEL_PROXY_URL).
  // Without the three, the consolidator judges nothing and ingest extracts nothing — and both
  // say so in their stats rather than failing.
  const proxyUrl = env("RYPH_MODEL_PROXY_URL") ?? null;
  const proxyControlUrl = env("RYPH_MODEL_PROXY_CONTROL_URL") ?? null;
  const platformToken = env("RYPH_PLATFORM_TOKEN") ?? null;
  const model = proxyUrl !== null && proxyControlUrl !== null && platformToken !== null
    ? proxyModelClient({
      proxyUrl,
      credentials: httpPlatformCredentials({
        controlUrl: proxyControlUrl,
        token: platformToken,
        consumer: "memory",
      }),
      diag,
    })
    : null;
  if (model === null) {
    log.warn(
      "RYPH_MODEL_PROXY_URL, RYPH_MODEL_PROXY_CONTROL_URL and RYPH_PLATFORM_TOKEN are not " +
        "all set — the consolidator runs without a model (screen and exact dedupe only) and " +
        "ingest extracts no claims",
    );
  }

  // Embeddings: from baked-in weights (RYPH_MEMORY_EMBEDDINGS=local, the image's shape) or none
  // (full-text only). On a Worker, because the model blocks whatever thread runs it for seconds
  // at a time (adapters/embed/worker_embedder.ts). Loaded up front so missing weights fail the
  // boot loudly, not the first search.
  const embeddings = env("RYPH_MEMORY_EMBEDDINGS") ?? "off";
  if (embeddings !== "off" && embeddings !== "local") {
    fail(`RYPH_MEMORY_EMBEDDINGS must be "off" or "local", got ${JSON.stringify(embeddings)}`);
  }
  let embedder: ReturnType<typeof workerEmbedder> | null = null;
  if (embeddings === "local") {
    embedder = workerEmbedder({
      modelDir: env("RYPH_MEMORY_MODEL_DIR") ?? "./models",
      offline: env("RYPH_MEMORY_MODEL_OFFLINE") !== "false",
    });
    try {
      await embedder.load();
    } catch (err) {
      fail(
        `RYPH_MEMORY_EMBEDDINGS=local but the model could not load: ${
          err instanceof Error ? err.message : String(err)
        } — the memory image bakes it in; elsewhere install the runtime (src/adapters/embed/` +
          "local.ts says how), run `bun scripts/fetch_model.ts <dir>` and set RYPH_MEMORY_MODEL_DIR",
      );
    }
  }

  const memory = setup({
    store,
    authenticate,
    gatewayToken,
    serviceToken,
    model,
    embedder,
    gitlabUrl: env("RYPH_GITLAB_URL") ?? null,
    now: () => new Date(),
    diag,
  });

  // Readiness is one bounded read of the table this service exists to serve. Liveness asks
  // nothing: a database outage must route traffic away, never restart the fleet into a crash loop.
  const health = makeHealth({
    ready: () => store.listMemories({ tenantId: "readiness-probe", limit: 1 }),
    log: diag,
  });

  const router = makeRouter([...health.routes, ...memory.routes, ...memory.internalRoutes]);
  const server = await serve({ port }, async (req) => {
    const data = await memory.dataHandler(req);
    return data ?? await router(req);
  });
  log.info(`listening on :${port}`, {
    db: dbHandle.description,
    auth: authUrl ?? (authDisabled ? "off" : "break-glass-only"),
    internal: serviceToken === null ? "dark" : "on",
    data: gatewayToken === null ? "dark" : "on",
    model: model === null ? "off" : proxyUrl,
    embeddings: embedder === null ? "off" : embedder.model,
  });

  // An extraction the last process died under would show as ingesting forever.
  await memory.recoverIngests();

  // The consolidator: the inbox is worked on a schedule, and a pass still in flight is not
  // doubled — setInterval does not await.
  let consolidating = false;
  const consolidator = setInterval(() => {
    if (consolidating) return;
    consolidating = true;
    memory.consolidate()
      .catch((err) => diag.warn("memory.consolidate_failed", { err: String(err) }))
      .finally(() => (consolidating = false));
  }, intEnv("RYPH_MEMORY_CONSOLIDATE_INTERVAL_MS", 60_000));

  // The embeddings backfill: memories written before embeddings were on (or by another model)
  // get their vectors a batch at a time, then the timer only checks. Same no-overlap rule.
  let backfilling = false;
  const backfill = embedder === null ? null : setInterval(() => {
    if (backfilling) return;
    backfilling = true;
    memory.backfillEmbeddings()
      .catch((err) => diag.warn("memory.backfill_failed", { err: String(err) }))
      .finally(() => (backfilling = false));
  }, intEnv("RYPH_MEMORY_BACKFILL_INTERVAL_MS", 30_000));

  installDrain({
    servers: [server],
    beginDrain: health.beginDrain,
    close: async () => {
      clearInterval(consolidator);
      if (backfill !== null) clearInterval(backfill);
      // The extractions behind admitted ingests finish (or fail onto their source) before the
      // store goes away under them.
      await memory.drain();
      // The embedder before the store: a vector still queued is dropped here (the next pod's
      // backfill covers it) rather than written to a closed pool.
      await embedder?.close();
      await store.close();
    },
    preStopMs: msEnv("RYPH_PRE_STOP_MS", 0),
    deadlineMs: msEnv("RYPH_DRAIN_DEADLINE_MS", 25_000),
    log,
  });
}

if (import.meta.main) {
  await main();
}

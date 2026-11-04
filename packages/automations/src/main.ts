// The composition root — the only file that knows which adapter stands behind each port,
// reads the environment, and owns the listening socket. One process, one database
// (RYPH_AUTOMATIONS_DB), three timers: the mailroom's delivery sweep, the schedule tick and the
// hourly keep-warm access check, each behind an in-flight guard and a Postgres advisory lock so
// several replicas share the work without repeating it.

import { Logger, setupLoggerFromEnv } from "@ryph/logger";
import { installDrain, makeHealth, refusePublicDevSecrets, serve } from "@ryph/service";
import { verifierFromUrl } from "@ryph/auth";
import {
  coalescingTick,
  drizzleHookStore,
  livenessRoutes,
  scopeWebhooksDb,
  setup as setupWebhooks,
} from "@ryph/webhooks";
import { openDbCluster } from "@ryph/db";
import { loggerDiagnostics } from "./adapters/diagnostics/logger.ts";
import { drizzleAutomationStore } from "./adapters/store/drizzle.ts";
import { scopeAutomationsDb } from "./adapters/store/db/db.ts";
import { httpEventSink } from "./adapters/event_sink/http.ts";
import { httpChatroomDirectory } from "./adapters/chatroom_directory/http.ts";
import { setupAutomations } from "./setup.ts";
import { automationRoutes } from "./http/routes.ts";
import { makeRouter } from "@ryph/shared/http";
import { makeUserAuth } from "./http/auth.ts";

// Advisory-lock keys for the three ticks. This service's own number space — the locks live in
// `ryph_automations`, nobody else's.
const LOCK_DELIVERY_SWEEP = 8_300_001;
const LOCK_SCHEDULER = 8_300_002;
const LOCK_ACCESS_REFRESH = 8_300_003;

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
  refusePublicDevSecrets("automations");
  const port = intEnv("RYPH_AUTOMATIONS_PORT", 7414);
  setupLoggerFromEnv();
  const log = new Logger("automations");
  const diag = loggerDiagnostics("automations");
  const now = () => new Date();

  // The same dev default the drizzle config uses, so `bun run dev` after `db:push` just works.
  const dbUrl = env("RYPH_AUTOMATIONS_DB") ?? "pglite:./data/automations";
  const orchestratorUrl = env("RYPH_ORCHESTRATOR_URL") ??
    fail("RYPH_ORCHESTRATOR_URL is required — fires become runs there");
  const automationsToken = env("RYPH_AUTOMATIONS_TOKEN") ??
    fail("RYPH_AUTOMATIONS_TOKEN is required — the events door refuses anonymous fires");
  // Where a response's chatroom is looked up (its platform decides whether a response may bind
  // it). Unset: this deployment has no chat, and a response names no chatroom.
  const chatUrl = env("RYPH_CHAT_URL");

  // One cluster, two scopes: this package's tables and the mailroom's table share the
  // database, so the connection is opened once and never twice.
  const cluster = await openDbCluster(dbUrl);
  const automationsDb = scopeAutomationsDb(cluster);
  const webhooksDb = scopeWebhooksDb(cluster);
  const store = drizzleAutomationStore(automationsDb.db);
  const hookStore = drizzleHookStore(webhooksDb.db);
  try {
    await store.listEnabledAutomations();
    await hookStore.getHeadHook("boot-probe");
  } catch (err) {
    fail(
      `the automations schema is missing or stale (${String(err)}) — ` +
        "run `bun run --filter '@ryph/automations' db:push`",
    );
  }

  // RYPH_AUTH=off is the local-development escape hatch; anything else verifies user JWTs
  // statelessly against the auth JWKS, the same trust every sibling service extends.
  const authDisabled = env("RYPH_AUTH") === "off";
  const authUrl = env("RYPH_AUTH_URL");
  if (!authDisabled && authUrl === undefined) {
    fail("RYPH_AUTH_URL is required (or RYPH_AUTH=off) — automation CRUD is per-user");
  }
  const authenticate = makeUserAuth({
    verifier: authDisabled || authUrl === undefined
      ? { verify: () => Promise.resolve(null) }
      : verifierFromUrl(new URL("/.well-known/jwks.json", authUrl).href),
    disabled: authDisabled,
  });

  // The delivery lock is HELD from scan to scan by the replica that delivers (`leader`), never
  // released between ticks: each mailbox's drain runs on after the tick that started it, and a
  // lock released at the tick's end let another replica start the same drains beside it. On a
  // self-healing session of its own (`LockSessionOptions.selfHealing`): a connection that died
  // answers "not held" within its deadline and reconnects, ending the backend a partition left
  // holding the lock — and giving a connection up drops every key on it, so no other key shares
  // it. The scheduler and access ticks take theirs per tick on a plain session (`lock`).
  const leaderLock = await cluster.lockSession({ selfHealing: true });
  const lock = await cluster.lockSession();
  const webhooks = setupWebhooks({
    store: hookStore,
    diag,
    now,
    onIngested: () => kickSweep(),
    onRateLimited: (id) => automations.recordRateLimited(id),
    leader: async () =>
      await leaderLock.held(LOCK_DELIVERY_SWEEP) || await leaderLock.tryLock(LOCK_DELIVERY_SWEEP),
  });
  const automations = setupAutomations({
    store,
    webhooks,
    sink: httpEventSink({ orchestratorUrl, automationsToken, diag }),
    diag,
    now,
  });
  await automations.syncRegistry();

  const health = makeHealth({ ready: () => store.listEnabledAutomations(), log: diag });
  const handler = makeRouter([
    // Ahead of the health routes: a mailroom whose ticks keep wedging past abandoning them fails
    // liveness (`livenessRoutes`), so the pod is restarted rather than left taking in fires it
    // will never deliver. A database outage never does: every tick ends at its deadlines.
    ...livenessRoutes(webhooks, diag),
    ...health.routes,
    ...webhooks.routes,
    ...automationRoutes({
      store,
      setup: automations,
      authenticate,
      chatrooms: chatUrl === undefined ? null : httpChatroomDirectory({ chatUrl }),
      diag,
      now,
    }),
  ]);

  /** One guarded tick: never overlapping itself — a kick while it runs makes one more run right
   * after it, never a lost one — and only on the replica holding the lock. The lock saves wasted
   * work, not correctness — every claim underneath is conditional. */
  const guardedTick = (key: number, name: string, run: () => Promise<unknown>) =>
    coalescingTick(async () => {
      if (!await lock.tryLock(key)) return;
      try {
        await run();
      } finally {
        await lock.unlock(key).catch(() => {});
      }
    }, (err) => diag.warn(`automations.${name}_tick_failed`, { err: String(err) }));
  // The delivery tick: a scan, which never waits on a delivery — every automation's mailbox
  // drains on its own after it. Its leader check is `leader` above, not a per-tick lock.
  const kickSweep = coalescingTick(
    () => webhooks.tick(),
    (err) => diag.warn("automations.sweep_tick_failed", { err: String(err) }),
  );
  const runScheduler = guardedTick(LOCK_SCHEDULER, "scheduler", () => automations.schedulerTick());
  const runAccessRefresh = guardedTick(
    LOCK_ACCESS_REFRESH,
    "access_refresh",
    () => automations.accessTick(),
  );
  const sweepTimer = setInterval(
    kickSweep,
    intEnv("RYPH_AUTOMATIONS_SWEEP_INTERVAL_MS", 2_000),
  );
  const schedulerTimer = setInterval(
    runScheduler,
    intEnv("RYPH_AUTOMATIONS_SCHEDULER_INTERVAL_MS", 15_000),
  );
  // The keep-warm access check: hourly, so the answer an outage falls back on is at most that
  // old (see the orchestrator's OUTAGE_ACCESS_GRACE_MS).
  const accessTimer = setInterval(
    runAccessRefresh,
    intEnv("RYPH_AUTOMATIONS_ACCESS_REFRESH_MS", 60 * 60_000),
  );
  kickSweep();
  runScheduler();
  runAccessRefresh();

  const server = await serve({ port }, handler);
  log.info(`listening on :${port}`, {
    db: automationsDb.description,
    orchestrator: orchestratorUrl,
    chat: chatUrl ?? "off",
    auth: authDisabled ? "off" : authUrl,
  });

  installDrain({
    servers: [server],
    beginDrain: health.beginDrain,
    preStopMs: msEnv("RYPH_PRE_STOP_MS", 0),
    deadlineMs: msEnv("RYPH_DRAIN_DEADLINE_MS", 25_000),
    log,
    close: async () => {
      // A sweep cut mid-delivery is fine: the lease expires and the next boot reclaims it.
      clearInterval(sweepTimer);
      clearInterval(schedulerTimer);
      clearInterval(accessTimer);
      await leaderLock.close();
      await lock.close();
      await cluster.close();
    },
  });
}

if (import.meta.main) {
  await main();
}

// The STANDALONE composition root — the historian as its own process, for the networked
// deployment where each service is its own socket. The default local deployment is @ryph/host,
// which instead spreads this package's routes into its own handler and supplies the gates
// in-process. This file knows which adapter stands behind each gate, reads the environment, owns
// the listening socket, and adds the internal conclude route the orchestrator pings.
//
// The three gates, in their network form:
// - reads ("can this user read?") verify the same @ryph/auth tokens the orchestrator does,
//   against the same RYPH_AUTH_URL JWKS.
// - ingest ("is this the right runner?") resolves the run token against the orchestrator and
//   caches it (adapters/run_auth/http.ts) — the runs table is the control plane's, not ours.
// - "is this run finished?" is a LOCAL lookup of runs the orchestrator has told us concluded,
//   via the internal conclude route below; that same signal drops the run's cached token and
//   hangs up its open SSE tails.
//
// Both of the things this process holds about a live run — who is tailing it, and whether it is
// over — used to live only in THIS process's memory, which made a second replica quietly wrong:
// a tail on replica A never saw events ingested on B, and a conclude ping reached exactly one
// replica while every other one's tails idled forever. Both now travel on Postgres LISTEN/NOTIFY
// (see adapters/bus/postgres.ts), and terminal state is a row rather than a Set, so it also
// survives a restart. The notification is only ever a nudge to go and read; the tables are the
// record.

import { Logger, setupLoggerFromEnv } from "@ryph/logger";
import { verifierFromUrl } from "@ryph/auth";
import {
  installDrain,
  makeHealth,
  refusePublicDevSecrets,
  serve,
  trackStreams,
} from "@ryph/service";
import { historianRoutes } from "./http/routes.ts";
import { makeHistorianService } from "./core/service.ts";
import { makeHistorianDb } from "./adapters/store/db/db.ts";
import { drizzleHistoryStore } from "./adapters/store/drizzle.ts";
import { HISTORY_CONCLUDE_CHANNEL, postgresHistoryBus } from "./adapters/bus/postgres.ts";
import type { HistoryStore } from "./ports/store.ts";
import { makeCapabilityGate, makeGrantBearer } from "@ryph/auth/gates";
import { makeRunReadGate, makeServiceGate } from "@ryph/sealed";
import { makeRouter, route } from "@ryph/shared/http";
import { httpRunAuth } from "./adapters/run_auth/http.ts";

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
  refusePublicDevSecrets("historian");
  const port = intEnv("RYPH_HISTORY_PORT", 7413);
  setupLoggerFromEnv();
  const log = new Logger("historian");
  const diag = {
    debug: (event: string, fields?: Record<string, unknown>) => log.debug(event, fields),
    warn: (event: string, fields?: Record<string, unknown>) => log.warn(event, fields),
  };

  // RYPH_HISTORY_DB is a ryph database URL (see @ryph/db). A standalone historian owns
  // its own database — `ryph_history` in Mode B — never the control plane's. Schema is applied
  // with drizzle-kit, never here: the probe below fails fast if it was not.
  const dbUrl = env("RYPH_HISTORY_DB") ?? "pglite:./data/ryph-history";
  const dbHandle = await makeHistorianDb(dbUrl);
  const store: HistoryStore = drizzleHistoryStore(dbHandle);
  try {
    await store.listEvents("startup-probe", "", { limit: 1 });
    // Probed separately: this table arrived after the first, so a database migrated to the older
    // schema passes the check above and then fails on the first tail. Better to say so at boot.
    await store.isConcluded("startup-probe");
  } catch (err) {
    // The handle's description is password-redacted; the raw URL never reaches a log.
    fail(
      `history database ${dbHandle.description} did not answer the startup probe ` +
        `(${err instanceof Error ? err.message : String(err)}) — if it has no schema, run ` +
        "`bun run db:push` in packages/historian. On Kubernetes the pod's `migrate` init " +
        "container applies it before this starts: read its log (`kubectl logs <pod> -c migrate`). " +
        "If the database did not answer at all, check RYPH_HISTORY_DB and the NetworkPolicy to the database",
    );
  }

  // The bus is the Postgres one here and the in-process one in @ryph/host, which is the whole
  // difference between the deployments: one process needs no round trip to talk to itself.
  const bus = await postgresHistoryBus({
    notify: dbHandle.notify,
    listen: dbHandle.listen,
    store,
    diag,
  });
  const service = makeHistorianService({ store, bus });

  // Reads: the same @ryph/auth verification the orchestrator uses. Point this at the SAME
  // RYPH_AUTH_URL as the orchestrator,
  // since the app forwards the same user bearer here as it does there.
  const authDisabled = env("RYPH_AUTH") === "off";
  if (authDisabled) log.warn("RYPH_AUTH=off — history reads are OPEN");
  const authUrl = env("RYPH_AUTH_URL");
  if (authUrl && !URL.canParse("/.well-known/jwks.json", authUrl)) {
    fail(`RYPH_AUTH_URL must be a valid absolute URL, got ${JSON.stringify(authUrl)}`);
  }
  const verifier = authUrl
    ? verifierFromUrl(new URL("/.well-known/jwks.json", authUrl).href)
    : { verify: () => Promise.resolve(null) };
  if (!authUrl && !authDisabled) {
    log.warn("RYPH_AUTH_URL unset — no user token verifies, so nobody can read history");
  }

  // Ingest + conclude share the RYPH_HISTORY_TOKEN service credential, both legs, exactly like
  // the forge token guards forge↔orchestrator. The orchestrator is where run tokens are verified.
  const orchestratorUrl = env("RYPH_ORCHESTRATOR_URL") ??
    fail("RYPH_ORCHESTRATOR_URL is required — run tokens are verified there");
  const historyToken = env("RYPH_HISTORY_TOKEN") ??
    fail(
      "RYPH_HISTORY_TOKEN is required — the service credential for run-token verify and conclude",
    );
  const runAuth = httpRunAuth({ orchestratorUrl, historyToken, diag });
  // A run's transcript is read with the grant the control plane minted for it, PLUS a verified
  // bearer (the grant is scope proof, never identity proof — see @ryph/sealed's doc); a
  // bearer that may read every run needs no grant at all.
  const authenticateRunRead = makeRunReadGate({
    grantKey: historyToken,
    bearer: makeGrantBearer({ verifier, disabled: authDisabled }),
    fallback: makeCapabilityGate({
      verifier,
      disabled: authDisabled,
    }, "tasks:read-all"),
  });

  // "Is this run finished?" is a lookup in this service's OWN database, of runs the orchestrator
  // has announced. It was a bounded `Set` in memory, with the honest admission that a tail on a
  // run whose ping this process missed would idle instead of emitting `done`. With replicas that
  // stopped being an edge case and became the normal case — only one of them receives the ping —
  // so the answer is a row, which every replica reads and a restart does not forget.
  const { routes, concludeRun } = historianRoutes({
    service,
    authenticateRunRead,
    authenticateRun: (req, runId) => runAuth.authenticateRun(req, runId),
    isRunTerminal: (runId) => store.isConcluded(runId),
  });

  /** What a conclusion means to THIS process: stop trusting the run's token, hang up its tails. */
  const applyConclusion = (runId: string): void => {
    runAuth.invalidate(runId);
    concludeRun(runId);
  };
  // Peers announce their conclusions here. Idempotent, and it also fires for our own NOTIFY —
  // harmless, and it keeps the cross-replica path exercised on every single conclude rather than
  // only when two replicas happen to be up.
  const unlistenConclude = await dbHandle.listen(HISTORY_CONCLUDE_CHANNEL, applyConclusion);

  // The orchestrator's conclude ping, service-authed. Records the run terminal (so a later tail's
  // isRunTerminal is local), drops its cached token (so ingest stops at once), and hangs up open
  // tails. Idempotent and cheap — safe to receive for a run nobody is watching.
  const authenticateService = makeServiceGate(historyToken);
  const concludeRoute = route(
    "POST",
    "/internal/v1/runs/:id/conclude",
    async (req, params) => {
      const refused = await authenticateService(req);
      if (refused) return refused;
      // Durable first: a tail opened after this point must get `done` even if the notification
      // below is dropped, and even if every replica alive right now is later replaced.
      await store.markConcluded(params.id, new Date().toISOString());
      applyConclusion(params.id);
      // Then the nudge, so the replicas holding this run's other tails hang up now rather than
      // when their viewers give up. Fire-and-forget: the row above is what makes it safe to lose.
      dbHandle.notify(HISTORY_CONCLUDE_CHANNEL, params.id).catch((err) => {
        diag.debug("conclude.notify_failed", { runId: params.id, err: String(err) });
      });
      return new Response(null, { status: 204 });
    },
  );

  // Readiness is one bounded read of the table this service exists to serve. Liveness asks
  // nothing: a database outage must route traffic away, never restart the fleet into a crash loop.
  const health = makeHealth({
    ready: () => store.listEvents("readiness-probe", "", { limit: 1 }),
    log: diag,
  });

  const router = makeRouter([...health.routes, ...routes, concludeRoute]);
  const streams = trackStreams();
  const server = await serve({ port }, streams.wrap(router));
  // `description`, never `dbUrl`: a postgres:// URL carries its password, and this line ends up
  // in whatever ships the logs.
  log.info(`listening on :${port}`, {
    db: dbHandle.description,
    orchestrator: orchestratorUrl,
    auth: authUrl ?? (authDisabled ? "off" : "none"),
  });

  // This is the service the drain deadline was written for: an open SSE tail never finishes, so
  // `shutdown()` alone would wait for a viewer to close their browser, and a runner's live uplink
  // stays open for the whole run. The drain ends both as it begins — the paginated GET is the
  // complete record either way, a reconnecting EventSource lands on whichever replica is still
  // up, and an uplink's relay reconnects and replays its room.
  installDrain({
    servers: [{ name: "historian", server, streams }],
    beginDrain: health.beginDrain,
    close: async () => {
      await unlistenConclude();
      await bus.close();
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

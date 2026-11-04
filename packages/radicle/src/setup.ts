// The package's startup contract: one call builds the service, the route table and the event
// consumer over the ports the caller provides. No env reads, no sockets, no timers of its own —
// src/main.ts owns those, and a test owns them differently.

import { rm } from "node:fs/promises";
import { makeRadicleService, type RadicleService } from "./core/service.ts";
import { consumerLockKey, type EventConsumer, makeEventConsumer } from "./core/events.ts";
import type { RadExec } from "./ports/rad.ts";
import type { JobCli } from "./ports/jobs.ts";
import { radJobCli } from "./adapters/jobs/rad_job.ts";
import type { NodeControl } from "./ports/node.ts";
import type { CursorStore } from "./ports/cursor_store.ts";
import type { TrackedRepoStore } from "./ports/tracked_repos.ts";
import type { EventSink } from "./ports/event_sink.ts";
import type { Diagnostics } from "./ports/diagnostics.ts";
import { makeServiceGate, type ServiceGate } from "@ryph/sealed";
import type { Route } from "@ryph/shared/http";
import { CLOSED_GATE } from "./helpers/auth.ts";
import { type BridgeConfig, bridgeRoutes } from "./http/routes.ts";
import { gitRoutes, mirrorDirOf } from "./http/git.ts";
import { withRepoLock } from "./helpers/repo_lock.ts";

/**
 * Whose node this is. `deployment` (the default): the bridge's own, beside it in one pod, signing
 * with the deployment's key — everything in storage is ryph's. `user`: somebody's own node and
 * identity, which ryph acts AS — only the repositories connected through the seed route are
 * touched, the node's seeding policies are left as they were found, and writes made on the node
 * by the person themselves are reconciled as they are announced. See the README's "User mode".
 */
export type BridgeMode = "deployment" | "user";

export interface RadicleSetupDeps {
  mode?: BridgeMode;
  /** The tracked set. Required in user mode — it is the whole of what that bridge may touch. */
  tracked?: TrackedRepoStore;
  exec: RadExec;
  node: NodeControl;
  cursors: CursorStore;
  sink: EventSink;
  diag: Diagnostics;
  /** RYPH_RADICLE_TOKEN. Null: every route answers 503 — a dark bridge, not an open one. */
  token: string | null;
  config: BridgeConfig;
  explorerUrl?: string | null;
  fetchTimeoutMs?: number;
  reconcileIntervalMs?: number;
  /** How often every seeded repository is pulled from the network. See `core/events.ts`. */
  pullIntervalMs?: number;
  /** The budget for one repository's pull. */
  pullTimeoutMs?: number;
  reconnectDelayMs?: number;
  /** The clock the service's freshness reads. A test moves it; main.ts leaves it alone. */
  now?: () => number;
  /** The job COB's writer. Defaults to `rad-job` over `exec`; a test hands in a fake. */
  jobs?: JobCli;
}

export interface RadicleSetup {
  service: RadicleService;
  consumer: EventConsumer;
  /** The whole surface, mountable into any host's route table. */
  routes: Route[];
  authenticate: ServiceGate;
}

export function setup(deps: RadicleSetupDeps): RadicleSetup {
  const user = deps.mode === "user";
  if (user && deps.tracked === undefined) {
    throw new Error("a user-mode bridge needs a tracked-repository store");
  }
  const authenticate = deps.token === null ? CLOSED_GATE : makeServiceGate(deps.token);
  const service = makeRadicleService({
    exec: deps.exec,
    node: deps.node,
    diag: deps.diag,
    scratchDir: deps.config.scratchDir,
    explorerUrl: deps.explorerUrl ?? null,
    fetchTimeoutMs: deps.fetchTimeoutMs,
    now: deps.now,
    // No job COBs in user mode: they record ryph's check runs, signed by the node's key, and a
    // person's own key is not a CI's. Nor is `rad-job` something a person usually has installed.
    jobs: user ? null : deps.jobs ?? radJobCli(deps.exec),
    tracked: user ? deps.tracked : null,
    // What a repository leaving scope takes with it: its cursors, so connecting it again is a
    // first sight rather than a replay, and the git door's mirror of it.
    forget: async (rid) => {
      // Under the consumer's own lock for the repository: a pass already inside it finishes
      // first, and every pass after it finds the repository out of scope.
      await withRepoLock(consumerLockKey(rid), () => deps.cursors.clearRepo(rid));
      await rm(mirrorDirOf(deps.config.exportDir, rid), { recursive: true })
        .catch((err) => {
          if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
        });
    },
  });
  const httpDeps = {
    service,
    node: deps.node,
    exec: deps.exec,
    authenticate,
    diag: deps.diag,
    config: deps.config,
    mode: user ? "user" as const : "deployment" as const,
  };
  const consumer = makeEventConsumer({
    service,
    exec: deps.exec,
    node: deps.node,
    cursors: deps.cursors,
    sink: deps.sink,
    diag: deps.diag,
    reconcileIntervalMs: deps.reconcileIntervalMs,
    pullIntervalMs: deps.pullIntervalMs,
    pullTimeoutMs: deps.pullTimeoutMs,
    reconnectDelayMs: deps.reconnectDelayMs,
    explorerUrl: deps.explorerUrl ?? null,
    reconcileLocalWrites: user,
    // No checks in user mode, so nothing asks for them: the person's own revisions are "ours"
    // already, and a stranger's revision or a reopen mints nothing either.
    mintPushes: !user,
    serializeByRepo: user,
  });
  return {
    service,
    consumer,
    authenticate,
    routes: [...bridgeRoutes(httpDeps), ...gitRoutes(httpDeps)],
  };
}

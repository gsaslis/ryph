// A composition helper: the checks service, wired to the one thing it cannot know about — the
// environment builds its suites wait on. Offered by the package so both composition roots (the
// standalone orchestrator and the single-process host) connect a settling build to its waiting
// suites the same way; each root still chooses the launcher, the log store and the tick.

import {
  type ChecksConfig,
  type ChecksDeps,
  type ChecksService,
  makeChecksService,
} from "./core/checks.ts";
import type { EnvironmentService } from "./core/environments.ts";
import type { RemoteChecksConfig } from "./core/remote_checks_config.ts";
import { remoteChecksClient } from "./adapters/remote_checks/http.ts";
import { checksAwaiting, type OwedVerdict } from "./core/check_awaiting.ts";

export interface WiredChecks {
  service: ChecksService;
  /** Which verdicts a run is still owed (core/check_awaiting.ts): what the runner holds an
   * agent's finish on. */
  awaiting(runId: string): Promise<OwedVerdict[]>;
}

/**
 * Builds the service and registers what a settled build means for it: every suite waiting on
 * that build is queued on its image, or fails with it — and that a build a suite waits on has a
 * waiter the build queue cannot see. The tick re-reads waiting suites too, so a
 * hook that never fired (a build settled on another replica) costs one tick, not a stuck suite.
 */
export function wireChecks(opts: {
  store: ChecksDeps["store"];
  tasks: ChecksDeps["tasks"];
  launcher: ChecksDeps["launcher"];
  remoteChecks?: RemoteChecksConfig | null;
  /** Inject a transport in an in-process composition or test. */
  remote?: ChecksDeps["remote"];
  forge: ChecksDeps["forge"];
  environments: EnvironmentService | null;
  logs: ChecksDeps["logs"];
  serviceCatalogue?: ChecksDeps["serviceCatalogue"];
  inbox?: ChecksDeps["inbox"];
  diag: ChecksDeps["diag"];
  now(): Date;
  config: ChecksConfig;
  /** The fence token; tests pin it. */
  nonce?: () => string;
  /** How long the tool waits for its request to resolve; tests shorten it. */
  answerWithinMs?: number;
}): WiredChecks {
  const readBundle = opts.forge?.readCheckBundle;
  if (opts.remoteChecks != null && readBundle === undefined) {
    throw new Error("remote checks require a forge that supports reading check bundles");
  }
  const remote = opts.remote ??
    (opts.remoteChecks == null ? null : remoteChecksClient(opts.remoteChecks, {
      readBundle: (key) => readBundle!.call(opts.forge, key),
    }));
  const service = makeChecksService({
    store: opts.store,
    tasks: opts.tasks,
    launcher: opts.launcher,
    remote,
    forge: opts.forge,
    environments: opts.environments,
    logs: opts.logs,
    serviceCatalogue: opts.serviceCatalogue ?? null,
    inbox: opts.inbox ?? null,
    diag: opts.diag,
    now: opts.now,
    config: opts.config,
    nonce: opts.nonce,
    answerWithinMs: opts.answerWithinMs,
  });
  opts.environments?.onSettled((environment) => service.environmentSettled(environment));
  // A build a suite waits on is waited on: a newer build of the branch must not supersede it.
  opts.environments?.addWaiters(async (environmentId) =>
    (await opts.store.listSuitesWaitingOn(environmentId)).length > 0
  );
  // And a suite that may still launch in a build's image keeps that image on the machine.
  opts.environments?.addImageHolders((environmentId) =>
    opts.store.hasUnsettledSuiteOn(environmentId)
  );
  return { service, awaiting: (runId) => checksAwaiting(opts.store, runId) };
}

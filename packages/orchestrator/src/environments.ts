// A composition helper: the environment service, wired to the two things it cannot know about —
// the runs waiting on its builds, and the runs whose patches asked for one (the result goes into
// their inbox). Offered by the package so both composition roots (the standalone orchestrator
// and the single-process host) connect a settling build to its waiters and its askers the same
// way; each root still chooses the builder, the log store and the ticks.

import { type Run, TERMINAL_STATES } from "./core/types.ts";
import {
  type EnvironmentService,
  type EnvironmentsServiceConfig,
  makeEnvironmentService,
} from "./core/environments.ts";
import {
  settleWaitingRun,
  type StartTaskDeps,
  startWithoutEnvironment,
} from "./core/start_task.ts";
import type { EnvironmentBuilder } from "./ports/environment_builder.ts";
import type { EnvironmentStore } from "./ports/environment_store.ts";
import type { BuildLogStore } from "./ports/build_log_store.ts";
import { type EnvironmentFeedback, makeEnvironmentFeedback } from "./core/environment_feedback.ts";
import type { InboxSignal } from "./core/inbox_signal.ts";
import type { GithubModeSource } from "./ports/forge.ts";

export interface WiredEnvironments {
  service: EnvironmentService;
  /** The reaper's backstop for one waiting run (ReaperDeps.settleWaitingRun). */
  settleWaitingRun(run: Run): Promise<void>;
  /** A person's "start it anyway": the waiting run launches now, on what is ready. False when it
   * was not waiting (any more). */
  startWithoutEnvironment(runId: string, by: string): Promise<boolean>;
  /** Build results into run inboxes: the submitter's hook, the delivery backstop, the run's
   * `environment_status` tool. Null without a forge — no connected repo, no patch to build. */
  feedback: EnvironmentFeedback | null;
}

/**
 * Builds the service and registers what a settled build means for its waiters: each waiting
 * run follows the build — launched on it, refused with its log, or told it started building.
 * `start` is what launching needs; the service is added to it here, so a run launched by a
 * settle can itself be resolved against the same service.
 */
export function wireEnvironments(opts: {
  environmentStore: EnvironmentStore;
  builder: EnvironmentBuilder;
  logs: BuildLogStore;
  start: Omit<StartTaskDeps, "environments">;
  config: EnvironmentsServiceConfig;
  abandonGraceMs?: number;
  /** Wakes a runner's long poll when a build result is posted on this replica. */
  inbox?: InboxSignal | null;
  /** How the forge acts on GitHub: rows of the other mode are no subjects. */
  githubMode?: GithubModeSource | null;
}): WiredEnvironments {
  const { start } = opts;
  const service = makeEnvironmentService({
    store: opts.environmentStore,
    tasks: start.store,
    builder: opts.builder,
    logs: opts.logs,
    forge: start.forge,
    githubMode: opts.githubMode ?? null,
    diag: start.diag,
    now: start.now,
    config: opts.config,
    abandonGraceMs: opts.abandonGraceMs,
  });
  const startDeps: StartTaskDeps = { ...start, environments: service };
  service.onSettled(async (environment) => {
    const waiting = (await start.store.listActiveRuns()).filter((run) =>
      !TERMINAL_STATES.has(run.state) && run.environmentWait?.environmentId === environment.id
    );
    for (const run of waiting) {
      await settleWaitingRun(startDeps, run.id, environment).catch((err) =>
        start.diag.warn("environments.waiter_failed", { runId: run.id, err: String(err) })
      );
    }
  });
  const feedback = start.forge
    ? makeEnvironmentFeedback({
      environments: service,
      forge: start.forge,
      store: start.store,
      diag: start.diag,
      inbox: opts.inbox ?? null,
      now: start.now,
    })
    : null;
  if (feedback !== null) {
    service.onSettled((environment) => feedback.settled(environment));
    service.onTick(() => feedback.sweep());
  }
  return {
    service,
    feedback,
    startWithoutEnvironment: (runId, by) => startWithoutEnvironment(startDeps, runId, by),
    async settleWaitingRun(run) {
      if (run.environmentWait === null) return;
      const environment = await opts.environmentStore.getEnvironment(
        run.environmentWait.environmentId,
      );
      if (environment === null) return;
      await settleWaitingRun(startDeps, run.id, environment);
    },
  };
}
